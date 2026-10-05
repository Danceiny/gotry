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
 *   POST /v1/session/bridge/events  → 扩展 workspace 事件批量上行(批次 B,2026-10-01;
 *                                     body ≤256KB,逐条落 bridge_events,响应 {accepted,rejected})
 *
 * 红线继承:登录在供应商官网由人完成;challenged 即停;节律闸在 sessionDidaSearch
 * 内;本模块再加单飞锁(同供应商串行,防并发打站点)。桥端点在 bearer 之上再强制
 * Origin ∈ 扩展白名单(网页跨域请求必带邪恶 Origin,双保险)。
 *
 * verdict 结构化日志(#272 观测缺口,2026-10-02 UAT 只读实查证实:verdict 此前
 * 无任何日志载体——BFF 代理日志与 gotry 应用日志均不落):search/status 每次
 * 结算在 stderr 落一行 `[session-search] verdict {json}`(ts/supplier/verdict/
 * latencyMs/error 摘要,脱敏)。与桥账本(bridge_jobs,PR #601)互补——日志管
 * 「看」,账本管「恢复」,verdict 不写 bridge_jobs。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { BackendModule } from '../kernel.ts'
import { sessionDidaSearch, type SessionDidaResult } from '../../../capabilities/session-search.ts'
import { DIDA_LOGIN_COOKIE_NAMES, DIDA_SITE_DOMAIN } from '../../../capabilities/session/adapters/dida-portal.ts'
import { CLIENT_ID_RE, createBridgeJobQueue, EXTENSION_ORIGINS, type BridgeJobQueue } from '../../../capabilities/session/extension-bridge.ts'
import { openBridgeLedgerStore, type BridgeEventInput, type BridgeLedgerStore } from '../../../capabilities/session/bridge-ledger.ts'
import { extensionCookieNames, extensionOpenLogin, classifyBridgeFailure } from '../../../capabilities/session/extension-channel.ts'

/** 事件上行端点路径(批次 B;导出供 extension-tests §38 与扩展侧 background.js 防漂移对账) */
export const BRIDGE_EVENTS_PATH = '/v1/session/bridge/events'
/** 事件上行 body 上限(事件是活动上下文非权威事实,256KB 足够一个批次;超限 400 整批拒绝) */
export const BRIDGE_EVENTS_BODY_LIMIT = 256 * 1024

export interface SessionSearchModuleOptions {
  apiKey: () => string
  /** 测试注入;缺省直连 sessionDidaSearch */
  search?: typeof sessionDidaSearch
  auditPath?: string
  /** 测试注入;缺省模块内建桥作业队列(给 stateRoot 时为 ledger-backed) */
  jobQueue?: BridgeJobQueue
  /**
   * 桥作业账本根(批次 A「桥作业账本化」,2026-10-01):提供且未注入 jobQueue 时,
   * 队列/在飞/节律/客户端注册落 `<stateRoot>/gotry-state/bridge.db`(独立于
   * gotry-state.db),启动即 recoverOnBoot(queued 重排/超时 claimed 结算),检索前
   * 先读账本节律。缺省纯内存——测试与桌面形态零变化。
   */
  stateRoot?: string
  /**
   * verdict 结构化日志通道(测试注入;缺省 process.stderr 一行一条,#272)。
   * 只收模块结算的脱敏 verdict 行,不影响 HTTP 响应面。
   */
  verdictLog?: (line: string) => void
}

/** verdict 行 error 摘要上限(#272:结构化行的脱敏摘要,不是传输面文案) */
const VERDICT_ERROR_SUMMARY_LIMIT = 200

/**
 * error 摘要里必须脱敏的形状(#272):凭据词出现在键名里(含复合键,如
 * SESSION_TICKET=…)时其赋值整体替换为 [REDACTED];独立 Bearer 头单列。
 * 只换值、保留键名——键名本身是脱敏证据,值才是泄漏面。
 */
const VERDICT_ERROR_REDACTION_ASSIGNMENT = /\b([\w-]*(?:cookie|ticket|token|sessionid|authorization|credential)[\w-]*)(\s*[:=]\s*)[^\s;,"'&]+/gi
const VERDICT_ERROR_REDACTION_BEARER = /\b(bearer)(\s+)[^\s;,"'&]+/gi

/**
 * verdict 行的 error 摘要(#272):单行化(防日志注入)+ 凭据形状脱敏 + 截断到
 * 200 字符。绝不携带 rates/evidence/回包内容——那些字段根本不进本行;能力层的
 * error 按合同是主机固定文案,这里再做一道防御性脱敏(离线哨兵在
 * observability-tests 里锁)。
 */
function redactVerdictErrorSummary(error: string | undefined): string | undefined {
  if (!error) return undefined
  const flattened = error.replaceAll(/[\r\n\t]+/g, ' ').trim()
  const redacted = flattened
    .replace(VERDICT_ERROR_REDACTION_BEARER, (_match, scheme: string, sep: string) => `${scheme}${sep}[REDACTED]`)
    .replace(VERDICT_ERROR_REDACTION_ASSIGNMENT, (_match, name: string, sep: string) => `${name}${sep}[REDACTED]`)
  if (!redacted) return undefined
  return redacted.length > VERDICT_ERROR_SUMMARY_LIMIT
    ? `${redacted.slice(0, VERDICT_ERROR_SUMMARY_LIMIT - 1)}…`
    : redacted
}

/** verdict 行的结算面:search=会话检索,status=登录态探测 */
type SessionVerdictSurface = 'search' | 'status'

function formatSessionVerdictLine(entry: {
  surface: SessionVerdictSurface
  supplier: string
  verdict: string
  latencyMs: number
  error?: string
}): string {
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    surface: entry.surface,
    supplier: entry.supplier,
    verdict: entry.verdict,
    latencyMs: Math.max(0, Math.round(entry.latencyMs)),
  }
  const error = redactVerdictErrorSummary(entry.error)
  if (error !== undefined) record.error = error
  return `[session-search] verdict ${JSON.stringify(record)}`
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
 * 单条上行事件的形状守卫(批次 B):{kind, site?, subject, payload_json, clientTs?, idem_key?}。
 * 返回 null = 该条拒绝(计入 rejected,不中断批次);返回对象 = 可落账输入。
 *  - payload_json 只约束 string,内容原样落账不二次解析(事件是活动上下文,消费方自鉴);
 *  - clientTs 仅约束有限数值(扩展侧时钟,不入列——账本唯一时间轴是服务端 ts);
 *  - site/idem_key 空字符串按缺省处理(NULL 不参与幂等去重)。
 */
function validateBridgeEvent(clientId: string, ev: unknown): BridgeEventInput | null {
  if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) return null
  const rec = ev as Record<string, unknown>
  if (typeof rec.kind !== 'string' || !rec.kind) return null
  if (rec.site !== undefined && typeof rec.site !== 'string') return null
  if (typeof rec.subject !== 'string' || !rec.subject) return null
  if (typeof rec.payload_json !== 'string') return null
  if (rec.clientTs !== undefined && (typeof rec.clientTs !== 'number' || !Number.isFinite(rec.clientTs))) return null
  if (rec.idem_key !== undefined && (typeof rec.idem_key !== 'string' || !rec.idem_key)) return null
  return {
    client_id: clientId,
    kind: rec.kind,
    site: typeof rec.site === 'string' && rec.site ? rec.site : null,
    subject: rec.subject,
    payload_json: rec.payload_json,
    idem_key: typeof rec.idem_key === 'string' && rec.idem_key ? rec.idem_key : null,
  }
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
  // verdict 结构化日志通道(#272):缺省 stderr(服务运行时既见面),测试注入收集器
  const verdictEmit = options.verdictLog ?? ((line: string) => { process.stderr.write(`${line}\n`) })
  const verdictLog = (entry: Parameters<typeof formatSessionVerdictLine>[0]): void => {
    try {
      verdictEmit(formatSessionVerdictLine(entry))
    } catch { /* 结算日志绝不反噬 HTTP 结算路径 */ }
  }
  // 桥队列形态(批次 A):注入 jobQueue(测试)→ 原样;给 stateRoot(挂载路径)→
  // ledger-backed(store 注入 createBridgeJobQueue);两者皆缺 → 纯内存(现状)。
  let ledger: BridgeLedgerStore | undefined
  let queue: BridgeJobQueue
  if (options.jobQueue) {
    queue = options.jobQueue
  } else if (options.stateRoot !== undefined) {
    try {
      ledger = openBridgeLedgerStore(options.stateRoot)
    } catch (e) {
      // 账本开不了不打断服务:退回纯内存(重启丢在飞的旧缺陷面),stderr 留痕
      process.stderr.write(`[session-search] 桥账本打开失败,退回纯内存队列: ${e instanceof Error ? e.message : String(e)}\n`)
    }
    queue = createBridgeJobQueue(ledger ? { store: ledger } : {})
  } else {
    queue = createBridgeJobQueue()
  }
  // 开机恢复(gotry-backend 会话模块启动路径):queued→重排;claimed 已超时→
  // unresolved+节律记账;claimed 未超时→复活 inFlight(重启不再丢在飞作业)。
  const recovery = queue.recoverOnBoot?.()
  if (recovery && recovery.requeued + recovery.rehydratedInFlight + recovery.settledUnresolved + recovery.voidedStale > 0) {
    process.stderr.write(`[session-search] 桥账本开机恢复:重排 ${recovery.requeued},复活在飞 ${recovery.rehydratedInFlight},超时结算 ${recovery.settledUnresolved},过期作废 ${recovery.voidedStale}\n`)
  }
  const authorized = (req: IncomingMessage, res: ServerResponse): boolean => {
    const key = options.apiKey()
    const auth = String(req.headers.authorization ?? '')
    if (!key) { sendJson(res, 503, { ok: false, error: 'GOTRY_BACKEND_SESSION_API_KEY 未配置(fail-closed)' }); return false }
    if (auth !== `Bearer ${key}`) { sendJson(res, 403, { ok: false, error: 'forbidden' }); return false }
    return true
  }

  /**
   * 扩展 workspace 事件批量上行(批次 B,2026-10-01):bearer(路由前置 authorized)之上
   * 再强制 Origin ∈ 扩展白名单——与 /jobs 同链(同一 EXTENSION_ORIGINS 常量,网页跨域
   * 请求必带邪恶 Origin,双保险)。body ≤256KB 超限 400 整批拒绝;逐条形状校验后落
   * bridge_events:合法落账 accepted++,形状非法/idem_key 重复 rejected++(重试幂等:
   * 同 idem_key 重发不重复落行)。事件是活动上下文非权威事实,批次内单条账本写失败
   * 降级为该条 rejected + stderr 留痕,不打断批次也不抛出(route 句柄 void 启动,
   * 逃逸 reject 会变 unhandledRejection 终止进程)。无账本形态(未给 stateRoot)
   * fail-closed 503:事件无处落账,不假成功。
   */
  const extensionOrigins = new Set(EXTENSION_ORIGINS)
  async function handleBridgeEvents(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = req.headers.origin
    if (typeof origin !== 'string' || !extensionOrigins.has(origin)) {
      sendJson(res, 403, { ok: false, error: 'origin 不在桥白名单' })
      return
    }
    if (!ledger) {
      sendJson(res, 503, { ok: false, error: '事件账本未配置(缺 stateRoot 的纯内存形态不收事件,fail-closed)' })
      return
    }
    let raw: string
    try {
      raw = await readBody(req, BRIDGE_EVENTS_BODY_LIMIT)
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e instanceof Error ? e.message : 'body 读取失败' })
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      sendJson(res, 400, { ok: false, error: 'body 不是 JSON' })
      return
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      sendJson(res, 400, { ok: false, error: 'body 必须是 JSON 对象' })
      return
    }
    const rec = parsed as Record<string, unknown>
    if (typeof rec.clientId !== 'string' || !CLIENT_ID_RE.test(rec.clientId)) {
      sendJson(res, 400, { ok: false, error: 'clientId 必须是扩展客户端标识(UUID)' })
      return
    }
    if (!Array.isArray(rec.events)) {
      sendJson(res, 400, { ok: false, error: 'events 必须是数组' })
      return
    }
    let accepted = 0
    let rejected = 0
    for (const ev of rec.events) {
      const input = validateBridgeEvent(rec.clientId, ev)
      if (!input) { rejected += 1; continue }
      try {
        if (ledger.insertEvent(input)) accepted += 1
        else rejected += 1
      } catch (e) {
        rejected += 1
        process.stderr.write(`[session-search] 桥事件落账失败(计入 rejected): ${e instanceof Error ? e.message : String(e)}\n`)
      }
    }
    sendJson(res, 200, { ok: true, accepted, rejected })
  }

  async function handleStatus(res: ServerResponse): Promise<void> {
    const startedAt = Date.now()
    const checkedAt = new Date().toISOString()
    if (!queue.extensionConnected()) {
      sendJson(res, 200, {
        ok: true,
        suppliers: [{ supplier: 'dida-portal', loggedIn: false, reason: 'extension-not-connected', detail: '会话执行环境=管理员浏览器扩展(Stai Travel Bridge);扩展未连接桥——在管理员浏览器安装扩展并配置本服务桥地址' }],
        bridge: queue.stats(),
        checkedAt,
      })
      verdictLog({ surface: 'status', supplier: 'dida-portal', verdict: 'needs-extension', latencyMs: Date.now() - startedAt })
      return
    }
    const login = await extensionCookieNames({ site: 'dida-portal', domain: DIDA_SITE_DOMAIN, ticketNames: DIDA_LOGIN_COOKIE_NAMES, timeoutMs: 20_000 }, queue)
    if (!login.ok) {
      const verdict = classifyBridgeFailure(login.kind)
      sendJson(res, 200, { ok: true, suppliers: [{ supplier: 'dida-portal', loggedIn: false, reason: verdict, detail: login.summary }], bridge: queue.stats(), checkedAt })
      verdictLog({ surface: 'status', supplier: 'dida-portal', verdict, latencyMs: Date.now() - startedAt, error: login.summary })
      return
    }
    sendJson(res, 200, {
      ok: true,
      suppliers: [{ supplier: 'dida-portal', loggedIn: login.tickets.length > 0, tickets: login.tickets, ...(login.tickets.length === 0 ? { reason: 'needs-login' } : {}) }],
      bridge: queue.stats(),
      checkedAt,
    })
    // tickets 只有 cookie 名级(值零过手),verdict 行也只落登录态结论本身
    verdictLog({ surface: 'status', supplier: 'dida-portal', verdict: login.tickets.length > 0 ? 'logged-in' : 'needs-login', latencyMs: Date.now() - startedAt })
  }

  async function handleSearch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startedAt = Date.now()
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
    // 挂载路径节律读判定(批次 A):账本口径跨重启(超时结算/上一次提交都在库里),
    // 与 sessionDidaSearch 的进程内节律闸双闸取严——内存闸挡本进程,账本闸挡重启前打过的站点。
    const pacing = ledger?.pacingOf(supplier)
    if (pacing && Date.now() < pacing.cooldownUntil) {
      const retryAfterSec = Math.max(1, Math.ceil((pacing.cooldownUntil - Date.now()) / 1_000))
      res.setHeader('retry-after', String(retryAfterSec))
      sendJson(res, 429, {
        ok: false,
        verdict: 'cooldown',
        error: `bridge ledger cooldown: site ${supplier} cooling down until ${new Date(pacing.cooldownUntil).toISOString()}(last ledger hit ${Date.now() - pacing.lastHitAt}ms ago)`,
      })
      verdictLog({ surface: 'search', supplier, verdict: 'cooldown', latencyMs: Date.now() - startedAt, error: `bridge ledger cooldown retry-after ${retryAfterSec}s` })
      return
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
        verdictLog({ surface: 'search', supplier, verdict: result.verdict, latencyMs: result.latencyMs, error: result.error })
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
      // 结算行只落 verdict/延迟/脱敏 error;rates 与 evidence(回包形状)永不进日志
      verdictLog({ surface: 'search', supplier, verdict: result.verdict, latencyMs: result.latencyMs, error: result.error })
    } catch (e) {
      sendJson(res, 500, { ok: false, error: `会话检索异常: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}` })
      verdictLog({ surface: 'search', supplier, verdict: 'error', latencyMs: Date.now() - startedAt, error: e instanceof Error ? e.message : String(e) })
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
      // 事件上行(批次 B):bearer + Origin 白名单双校验与 /jobs 同链,处理器内落 bridge_events
      { method: 'POST', path: BRIDGE_EVENTS_PATH, handle: (req, res) => { if (authorized(req, res)) void handleBridgeEvents(req, res) } },
    ],
    close: () => queue.close().then(() => { ledger?.close() }),
  }
}
