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
import { sessionDidaSearch } from '../../../capabilities/session-search.ts'
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

async function readBody(req: IncomingMessage, cap = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > cap) { reject(new Error(`body 超 ${cap} 字节上限`)); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
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
    let parsed: { supplier?: string; query?: { entryUrl?: string; timeoutMs?: number } }
    try {
      parsed = JSON.parse(await readBody(req))
    } catch {
      sendJson(res, 400, { ok: false, error: 'body 不是 JSON' }); return
    }
    const supplier = (parsed.supplier ?? '').trim()
    if (supplier !== 'dida-portal') {
      sendJson(res, 400, { ok: false, error: `未知供应商通道 ${supplier || '(空)'}(M0 仅 dida-portal)` }); return
    }
    try {
      const result = await withLock(supplier, () => search({
        entryUrl: parsed.query?.entryUrl,
        timeoutMs: parsed.query?.timeoutMs,
        auditPath: options.auditPath,
        bridge: queue,
      }))
      if (result.verdict === 'cooldown') {
        res.setHeader('retry-after', '30')
        sendJson(res, 429, { ok: false, verdict: result.verdict, error: result.error, evidence: result.evidence })
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
      })
    } catch (e) {
      sendJson(res, 500, { ok: false, error: `会话检索异常: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}` })
    }
  }

  async function handleLoginOpen(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let parsed: { supplier?: string; url?: string }
    try {
      parsed = JSON.parse(await readBody(req))
    } catch {
      sendJson(res, 400, { ok: false, error: 'body 不是 JSON' }); return
    }
    const supplier = (parsed.supplier ?? '').trim()
    if (supplier !== 'dida-portal') { sendJson(res, 400, { ok: false, error: `未知供应商通道 ${supplier || '(空)'}` }); return }
    const url = (parsed.url ?? '').trim() || 'https://portal.dida.com/login'
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
