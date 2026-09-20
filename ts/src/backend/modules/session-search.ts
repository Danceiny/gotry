/**
 * session-search 模块(gotry-backend 的能力单元之一;账号会话检索,hotel-be portal
 * 聚合工作台 M0)。travel agent 能力全部落 gotry——本模块是「一个 gotry 服务」里的
 * 会话检索面,hotel-be 只做网关包装与上下文拼接。
 *
 * 执行环境(2026-09-11 founder 定案):**浏览器客户端**,服务端零 Chrome
 * (headless 易风控 + 资源开销大,双双出局)。本模块内嵌桥作业队列
 * (createBridgeJobQueue)并挂载桥协议端点;管理员浏览器里的 GoTry Session
 * Bridge 扩展经 bearer 鉴权远程连入,长轮询取活,在自己浏览器的登录态里
 * 被动嗅探 dida 回包。登录也在管理员自己浏览器完成(login/open 让扩展把
 * dida 登录页置前台打开,人过验证码)——零 Xvfb、零 noVNC、零 SSH 隧道。
 *
 * 路由(鉴权:Bearer GOTRY_BACKEND_SESSION_API_KEY;缺 key = fail-closed 503):
 *   GET  /v1/session/status         → 扩展在线态 + 各供应商登录态(票据 cookie 名级;值零过手)
 *   POST /v1/session/search         → 会话面检索(dida:multiCollect 嗅探推荐流双接口)
 *   POST /v1/session/login/open     → 让扩展在管理员浏览器置前台打开 dida 登录入口页
 *   GET  /v1/session/bridge/health  → 桥健康(扩展启动探测)
 *   GET  /v1/session/bridge/status  → 桥诊断(队列/在线态快照)
 *   POST /v1/session/bridge/jobs    → 扩展长轮询取活(hold ≤20s)
 *   POST /v1/session/bridge/results → 扩展回包(?jobId=;内核只支持精确路由)
 *
 * 红线继承:登录在供应商官网由人完成;challenged 即停;节律闸在 sessionDidaSearch
 * 内;本模块再加单飞锁(同供应商串行,防并发打站点)。桥端点在 bearer 之上再强制
 * Origin ∈ 扩展白名单(网页跨域请求必带邪恶 Origin,双保险)。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { BackendModule } from '../kernel.ts'
import { sessionDidaSearch, type SessionDidaResult } from '../../../capabilities/session-search.ts'
import { DIDA_LOGIN_COOKIE_NAMES, DIDA_SITE_DOMAIN } from '../../../capabilities/session/adapters/dida-portal.ts'
import { createBridgeJobQueue, type BridgeJobQueue } from '../../../capabilities/session/extension-bridge.ts'
import { extensionCookieNames, extensionOpenLogin, classifyBridgeFailure } from '../../../capabilities/session/extension-channel.ts'

export interface SessionSearchModuleOptions {
  apiKey: () => string
  /** 测试注入;缺省直连 sessionDidaSearch */
  search?: typeof sessionDidaSearch
  auditPath?: string
  /** 测试注入;缺省模块内建进程内桥作业队列 */
  jobQueue?: BridgeJobQueue
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

/**
 * POST search/login 体的最小输入守卫:
 *  - 读取 body 失败(连接断 / 超 64KB 上限) → 'body-read'
 *  - body 不是合法 JSON                            → 'parse'
 *  - 顶层不是 plain object(null / 数组 / 原始类型)  → 'shape'
 *  - supplier 存在但非 string                      → 'supplier-type'
 *  - url 存在但非 string(login 专属)               → 'url-type'
 *
 * 守卫结果以 code 形式回给调用方,由调用方统一 sendJson 400;不抛错——
 * route 句柄用 `void handle*(...)` 启动异步函数,任何逃逸的 reject 都会变
 * unhandledRejection 直接终止进程。读取/解析/类型错误必须就地转成 HTTP 响应。
 */
type ValidationCode = 'body-read' | 'parse' | 'shape' | 'supplier-type' | 'url-type'

async function readAndParseObjectBody(req: IncomingMessage): Promise<{ obj: Record<string, unknown> } | { code: ValidationCode }> {
  let raw: string
  try {
    raw = await readBody(req)
  } catch {
    return { code: 'body-read' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { code: 'parse' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { code: 'shape' }
  }
  return { obj: parsed as Record<string, unknown> }
}

function validationMessage(code: ValidationCode): string {
  switch (code) {
    case 'body-read': return 'body 读取失败'
    case 'parse': return 'body 不是 JSON'
    case 'shape': return 'body 必须是 JSON 对象'
    case 'supplier-type': return 'supplier 必须是字符串'
    case 'url-type': return 'url 必须是字符串'
  }
}

function ensureStringField(obj: Record<string, unknown>, key: 'supplier' | 'url'): ValidationCode | null {
  const v = obj[key]
  if (v !== undefined && typeof v !== 'string') return key === 'supplier' ? 'supplier-type' : 'url-type'
  return null
}

/**
 * search 的可选 query 字段(entryUrl / timeoutMs)做最小白名单:
 * query 必须为对象;若提供则必须是 string / number,否则按 400 拒绝。
 * 这是为了避免 untrusted body 被当作已校验类型传入底层 search(),
 * 同时对历史合法请求保持兼容。
 */
type SearchQueryFields = {
  entryUrl?: string
  timeoutMs?: number
  /** 按城市的查询(2026-09-21):驱动门户目的地搜索取该查询下的价 */
  city?: string
  checkIn?: string
  checkOut?: string
  adults?: number
  children?: number
}

function readSearchQuery(obj: Record<string, unknown>): { query?: SearchQueryFields } | { code: ValidationCode } {
  const q = obj.query
  if (q === undefined) return { query: undefined }
  if (q === null || typeof q !== 'object' || Array.isArray(q)) return { code: 'shape' }
  const rec = q as Record<string, unknown>
  const entryUrl = rec.entryUrl
  const timeoutMs = rec.timeoutMs
  if (entryUrl !== undefined && typeof entryUrl !== 'string') return { code: 'shape' }
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs))) return { code: 'shape' }
  type Field<T> = { ok: true; value?: T } | { ok: false; code: ValidationCode }
  const strField = (k: string): Field<string> => {
    const v = rec[k]
    if (v === undefined) return { ok: true }
    if (typeof v !== 'string') return { ok: false, code: 'shape' }
    return { ok: true, value: v.trim() || undefined }
  }
  const numField = (k: string): Field<number> => {
    const v = rec[k]
    if (v === undefined) return { ok: true }
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return { ok: false, code: 'shape' }
    return { ok: true, value: Math.floor(v) }
  }
  const city = strField('city')
  if (!city.ok) return { code: city.code }
  const checkIn = strField('checkIn')
  if (!checkIn.ok) return { code: checkIn.code }
  const checkOut = strField('checkOut')
  if (!checkOut.ok) return { code: checkOut.code }
  const adults = numField('adults')
  if (!adults.ok) return { code: adults.code }
  const children = numField('children')
  if (!children.ok) return { code: children.code }
  return {
    query: {
      entryUrl,
      timeoutMs,
      ...(city.value ? { city: city.value } : {}),
      ...(checkIn.value ? { checkIn: checkIn.value } : {}),
      ...(checkOut.value ? { checkOut: checkOut.value } : {}),
      ...(adults.value !== undefined ? { adults: adults.value } : {}),
      ...(children.value !== undefined ? { children: children.value } : {}),
    },
  }
}

/**
 * needs-extension 的安装入口必须随 HTTP 响应一起下发。
 *
 * 能力层在 verdict=needs-extension 时已经算好了 Chrome 商店链接与安装动作
 * (dida 路径返回 EXTENSION_STORE_URL + 'add-to-chrome'),而这一层是**逐字段
 * 组装**响应的——漏掉这两个键,该 verdict 唯一的行动项就消失在传输层,消费方
 * 只能退化成"放弃实时价、切回目录价"(hotel-fe#3611)。
 */
function extensionInstallFields(result: SessionDidaResult): { installUrl?: string; installAction?: 'add-to-chrome' } {
  return {
    ...(result.installUrl ? { installUrl: result.installUrl } : {}),
    ...(result.installAction ? { installAction: result.installAction } : {}),
  }
}

async function readBody(req: IncomingMessage, cap = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let rejected = false
    req.on('data', (c: Buffer) => {
      if (rejected) return
      size += c.length
      if (size > cap) { rejected = true; reject(new Error(`body 超 ${cap} 字节上限`)); return }
      chunks.push(c)
    })
    req.on('end', () => { if (!rejected) resolve(Buffer.concat(chunks).toString('utf8')) })
    req.on('error', (e) => { if (!rejected) reject(e) })
  })
}

const locks = new Map<string, Promise<unknown>>()
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve()
  const next = prev.catch(() => undefined).then(fn)
  locks.set(key, next)
  try {
    return await next
  } finally {
    if (locks.get(key) === next) locks.delete(key)
  }
}

export function startSessionSearchModule(options: SessionSearchModuleOptions): BackendModule {
  const search = options.search ?? sessionDidaSearch
  const queue = options.jobQueue ?? createBridgeJobQueue()
  const authorized = (req: IncomingMessage, res: ServerResponse): boolean => {
    const key = options.apiKey()
    const auth = String(req.headers.authorization ?? '')
    if (!key) { sendJson(res, 503, { ok: false, error: 'GOTRY_BACKEND_SESSION_API_KEY 未配置(fail-closed)' }); return false }
    if (auth !== `Bearer ${key}`) { sendJson(res, 403, { ok: false, error: 'forbidden' }); return false }
    return true
  }

  async function handleStatus(res: ServerResponse): Promise<void> {
    const checkedAt = new Date().toISOString()
    if (!queue.extensionConnected()) {
      sendJson(res, 200, {
        ok: true,
        suppliers: [{ supplier: 'dida-portal', loggedIn: false, reason: 'extension-not-connected', detail: '会话执行环境=管理员浏览器扩展(GoTry Session Bridge);扩展未连接桥——在管理员浏览器安装扩展并配置本服务桥地址' }],
        bridge: queue.stats(),
        checkedAt,
      })
      return
    }
    const login = await extensionCookieNames({ site: 'dida-portal', domain: DIDA_SITE_DOMAIN, ticketNames: DIDA_LOGIN_COOKIE_NAMES, timeoutMs: 20_000 }, queue)
    if (!login.ok) {
      const verdict = classifyBridgeFailure(login.kind)
      sendJson(res, 200, { ok: true, suppliers: [{ supplier: 'dida-portal', loggedIn: false, reason: verdict, detail: login.summary }], bridge: queue.stats(), checkedAt })
      return
    }
    sendJson(res, 200, {
      ok: true,
      suppliers: [{ supplier: 'dida-portal', loggedIn: login.tickets.length > 0, tickets: login.tickets, ...(login.tickets.length === 0 ? { reason: 'needs-login' } : {}) }],
      bridge: queue.stats(),
      checkedAt,
    })
  }

  async function handleSearch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsed = await readAndParseObjectBody(req)
    if ('code' in parsed) { sendJson(res, 400, { ok: false, error: validationMessage(parsed.code) }); return }
    const supplierType = ensureStringField(parsed.obj, 'supplier')
    if (supplierType) { sendJson(res, 400, { ok: false, error: validationMessage(supplierType) }); return }
    const queryCheck = readSearchQuery(parsed.obj)
    if ('code' in queryCheck) { sendJson(res, 400, { ok: false, error: validationMessage(queryCheck.code) }); return }
    const supplier = ((parsed.obj.supplier as string | undefined) ?? '').trim()
    if (supplier !== 'dida-portal') {
      sendJson(res, 400, { ok: false, error: `未知供应商通道 ${supplier || '(空)'}(M0 仅 dida-portal)` }); return
    }
    try {
      const q = queryCheck.query
      const result = await withLock(supplier, () => search({
        entryUrl: q?.entryUrl,
        timeoutMs: q?.timeoutMs,
        // 查询态(城市+日期)交给能力层 → 扩展驱动门户目的地搜索
        ...(q?.city
          ? { query: { city: q.city, checkIn: q.checkIn, checkOut: q.checkOut, adults: q.adults, children: q.children } }
          : {}),
        auditPath: options.auditPath,
        bridge: queue,
      }))
      if (result.verdict === 'cooldown') {
        res.setHeader('retry-after', '30')
        sendJson(res, 429, {
          ok: false,
          verdict: result.verdict,
          error: result.error,
          evidence: result.evidence,
          ...extensionInstallFields(result),
        })
        return
      }
      sendJson(res, 200, {
        ok: result.ok,
        verdict: result.verdict,
        supplier,
        rates: result.rates ?? [],
        evidence: result.evidence,
        latencyMs: result.latencyMs,
        fetchedAt: new Date().toISOString(),
        ...(result.error ? { error: result.error } : {}),
        // needs-extension 的安装入口必须跟着 verdict 一起下发。能力层已经算好了
        // (dida 路径返回 EXTENSION_STORE_URL),这里是它在 HTTP 面唯一的出口——
        // 逐字段组装时漏掉这两个键,消费方就只剩"放弃实时价、切回目录价"一条路
        // (hotel-fe#3611)。
        ...extensionInstallFields(result),
      })
    } catch (e) {
      sendJson(res, 500, { ok: false, error: `会话检索异常: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}` })
    }
  }

  async function handleLoginOpen(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsed = await readAndParseObjectBody(req)
    if ('code' in parsed) { sendJson(res, 400, { ok: false, error: validationMessage(parsed.code) }); return }
    const supplierType = ensureStringField(parsed.obj, 'supplier')
    if (supplierType) { sendJson(res, 400, { ok: false, error: validationMessage(supplierType) }); return }
    const urlType = ensureStringField(parsed.obj, 'url')
    if (urlType) { sendJson(res, 400, { ok: false, error: validationMessage(urlType) }); return }
    const supplier = ((parsed.obj.supplier as string | undefined) ?? '').trim()
    if (supplier !== 'dida-portal') { sendJson(res, 400, { ok: false, error: `未知供应商通道 ${supplier || '(空)'}` }); return }
    const url = ((parsed.obj.url as string | undefined) ?? '').trim() || 'https://portal.dida.com/login'
    if (!/^https:\/\/portal\.dida\.com\//.test(url)) {
      sendJson(res, 400, { ok: false, error: '登录入口必须落在 https://portal.dida.com/ 域内(fail-closed)' }); return
    }
    const outcome = await extensionOpenLogin({ site: supplier, url, timeoutMs: 20_000 }, queue)
    if (!outcome.ok) {
      const verdict = classifyBridgeFailure(outcome.kind)
      sendJson(res, verdict === 'needs-extension' ? 503 : 502, { ok: false, verdict, error: outcome.summary })
      return
    }
    sendJson(res, 200, { ok: true, opened: true, url, note: '登录页已在会话所属浏览器置前台打开(验证码人过);gotry 永不经手密码/cookie 值' })
  }

  return {
    name: 'session-search',
    routes: [
      { method: 'GET', path: '/v1/session/status', handle: (req, res) => { if (authorized(req, res)) void handleStatus(res) } },
      { method: 'POST', path: '/v1/session/search', handle: (req, res) => { if (authorized(req, res)) void handleSearch(req, res) } },
      { method: 'POST', path: '/v1/session/login/open', handle: (req, res) => { if (authorized(req, res)) void handleLoginOpen(req, res) } },
      // 桥协议端点:远程扩展经 bearer 鉴权连入;Origin 白名单在队列处理器内再校验一道
      { method: 'GET', path: '/v1/session/bridge/health', handle: (req, res) => { if (authorized(req, res)) queue.handleMountedRequest(req, res) } },
      { method: 'GET', path: '/v1/session/bridge/status', handle: (req, res) => { if (authorized(req, res)) queue.handleMountedRequest(req, res) } },
      { method: 'POST', path: '/v1/session/bridge/jobs', handle: (req, res) => { if (authorized(req, res)) queue.handleMountedRequest(req, res) } },
      { method: 'POST', path: '/v1/session/bridge/results', handle: (req, res) => { if (authorized(req, res)) queue.handleMountedRequest(req, res) } },
    ],
    close: () => queue.close(),
  }
}
