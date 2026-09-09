/**
 * session-search 模块(gotry-backend 的能力单元之一;账号会话检索,hotel-be portal
 * 聚合工作台 M0)。travel agent 能力全部落 gotry——本模块是「一个 gotry 服务」里的
 * 会话检索面,hotel-be 只做网关包装与上下文拼接。
 *
 * 路由(鉴权:Bearer GOTRY_BACKEND_SESSION_API_KEY;缺 key = fail-closed 503):
 *   GET  /v1/session/status      → 各供应商登录态(票据 cookie 名级;值零过手)
 *   POST /v1/session/search     → 会话面检索(dida:被动嗅探 SearchRealTime 信封)
 *   POST /v1/session/login/open → 打开供应商登录入口页(登录在官网由人完成;
 *                                 noVNC 镜像形态下管理员亲手操作)
 *
 * 红线继承:登录在供应商官网由人完成;challenged 即停;节律闸在 sessionDidaSearch
 * 内;本模块再加单飞锁(同供应商串行,防并发打站点)。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { BackendModule } from '../kernel.ts'
import { sessionDidaSearch } from '../../../capabilities/session-search.ts'
import { DIDA_LOGIN_COOKIE_NAMES, DIDA_SITE_DOMAIN } from '../../../capabilities/session/adapters/dida-portal.ts'
import { openSession } from '../../../capabilities/session/transport.ts'

export interface SessionSearchModuleOptions {
  apiKey: () => string
  /** 测试注入;缺省直连 sessionDidaSearch */
  search?: typeof sessionDidaSearch
  auditPath?: string
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
  const authorized = (req: IncomingMessage, res: ServerResponse): boolean => {
    const key = options.apiKey()
    const auth = String(req.headers.authorization ?? '')
    if (!key) { sendJson(res, 503, { ok: false, error: 'GOTRY_BACKEND_SESSION_API_KEY 未配置(fail-closed)' }); return false }
    if (auth !== `Bearer ${key}`) { sendJson(res, 403, { ok: false, error: 'forbidden' }); return false }
    return true
  }

  async function handleStatus(res: ServerResponse): Promise<void> {
    const t = await openSession({ mode: 'cdp', guard: false, newPage: false })
    if (!t.ok) {
      sendJson(res, 200, { ok: true, suppliers: [{ supplier: 'dida-portal', loggedIn: false, reason: 'transport-unavailable', detail: t.summary }], checkedAt: new Date().toISOString() })
      return
    }
    try {
      const cookies = await t.browser.cookies().catch(() => [])
      const tickets = cookies
        .filter((c) => c.domain.includes(DIDA_SITE_DOMAIN.replace(/^\./, '')) && DIDA_LOGIN_COOKIE_NAMES.includes(c.name))
        .map((c) => c.name)
      sendJson(res, 200, { ok: true, suppliers: [{ supplier: 'dida-portal', loggedIn: tickets.length > 0, tickets, checkedAt: new Date().toISOString() }] })
    } finally {
      await t.close()
    }
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
    const t = await openSession({ mode: 'cdp', guard: false, newPage: true, closeOwnPage: false })
    if (!t.ok) { sendJson(res, 503, { ok: false, error: `会话主机 Chrome 不可达: ${t.summary}` }); return }
    try {
      await t.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await t.page.bringToFront().catch(() => { /* 镜像形态下无前台语义 */ })
      sendJson(res, 200, { ok: true, opened: true, url, note: '登录页已留给你完成(验证码人过);会话落在主机 profile,代理不碰表单' })
    } catch (e) {
      sendJson(res, 502, { ok: false, error: `打开登录页失败: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}` })
    }
  }

  return {
    name: 'session-search',
    routes: [
      { method: 'GET', path: '/v1/session/status', handle: (req, res) => { if (authorized(req, res)) void handleStatus(res) } },
      { method: 'POST', path: '/v1/session/search', handle: (req, res) => { if (authorized(req, res)) void handleSearch(req, res) } },
      { method: 'POST', path: '/v1/session/login/open', handle: (req, res) => { if (authorized(req, res)) void handleLoginOpen(req, res) } },
    ],
  }
}
