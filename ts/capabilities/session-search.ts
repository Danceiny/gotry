/**
 * 会话检索编排层(RFC §3.2):transport → adapter entry → networkHint 嗅探 → 解析 → ReadGuard → 证据链。
 *
 * 证据链(L4 增补):[会话:ctrip-flight@ts] = 用户本人会话内实时检索,非官方 API;
 * 风控命中(verdict='challenged')= degraded,绝不重试、绝不绕过(合规支柱②)。
 * 节律(§3.4):同站点 ≥30s 间隔 + 单调冷却;超间隔返回 verdict='cooldown'。
 * 永不抛错;transport 必带 ReadGuard(fail-closed);测试/巡检用隔离 profile 与 stateRoot。
 */

import { openSession } from './session/transport.ts'
import { buildEntryUrl, NETWORK_HINTS, parseBatchSearch, LOGIN_COOKIE_NAMES, SITE_DOMAIN, type SessionFlightOption } from './session/adapters/ctrip-flight.ts'

export type SessionVerdict = 'hit' | 'miss' | 'error' | 'challenged' | 'cooldown' | 'needs-login' | 'needs-attach'

export interface SessionSearchResult {
  ok: boolean
  via: 'session-ctrip-flight' | 'session-ctrip-flight-error'
  evidence: string
  latencyMs: number
  verdict: SessionVerdict
  options?: SessionFlightOption[]
  error?: string
}

export interface SessionFlightQuery {
  from: string
  to: string
  /** YYYY-MM-DD */
  date: string
  /** 隔离 profile 目录(测试必传;默认 /tmp 专用目录) */
  profileDir?: string
  headless?: boolean
  /** ReadGuard 审计路径(测试传隔离 stateRoot 下) */
  auditPath?: string
  /** 等 networkHint 回包的上限,默认 25_000 */
  timeoutMs?: number
  /** 允许匿名实例(默认 false——用户自己的账号是本面的存在前提);true 仅用于适配器链路自检,证据链会标 anonymous */
  allowAnonymous?: boolean
}

/** 节律闸(§3.4):同站点最小间隔;导出仅测试用 */
const MIN_INTERVAL_MS = 30_000
const lastCallAt = new Map<string, number>()
export function __resetRateLimiterForTest(): void {
  lastCallAt.clear()
}

const CHALLENGE_RE = /验证|滑块|captcha|verify/i

export async function sessionFlightSearch(q: SessionFlightQuery): Promise<SessionSearchResult> {
  const started = Date.now()
  const ts = new Date().toISOString()
  const site = 'ctrip-flight'
  const err = (verdict: SessionVerdict, error: string): SessionSearchResult => ({
    ok: false, via: 'session-ctrip-flight-error', evidence: `[会话:${site}@error@${ts}] ${error}`, latencyMs: Date.now() - started, verdict, error,
  })

  // 节律闸:超间隔即拒,不发起导航
  const last = lastCallAt.get(site) ?? 0
  if (Date.now() - last < MIN_INTERVAL_MS) {
    return err('cooldown', `rate limit: last call ${Date.now() - last}ms ago, min ${MIN_INTERVAL_MS}ms`)
  }
  lastCallAt.set(site, Date.now())

  const entry = buildEntryUrl(q.from, q.to, q.date)
  if (!entry.ok || !entry.url) {
    return err('error', `unresolved entry: ${(entry.unresolved ?? []).join('/')} 不在城市码表`)
  }

  const t = await openSession({ profileDir: q.profileDir, headless: q.headless, auditPath: q.auditPath, mode: q.profileDir ? 'persistent' : 'cdp' })
  if (!t.ok) {
    // cdp 未开端口 → needs-attach(一次性用户动作);persistent 启动失败仍走 error
    if (q.profileDir === undefined && /cdp attach 失败/.test(t.summary)) return err('needs-attach', t.summary)
    return err('error', t.summary)
  }

  try {
    // 登录态闸:用户自己的账号,不是匿名实例——匿名态按 onAnonymous 处置(默认 fail)
    const loggedIn = async (): Promise<boolean> => {
      const cookies = await t.context.cookies([`https://flights${SITE_DOMAIN.replace(/^\./, '')}/`]).catch(() => [])
      return cookies.some((c) => LOGIN_COOKIE_NAMES.includes(c.name))
    }
    if (!(await loggedIn()) && !q.allowAnonymous) {
      return err('needs-login', '匿名实例——先跑 scripts/session-login.ts 用用户自己的账号建立登录态(allowAnonymous 仅限链路自检)')
    }
    // 先挂监听再导航(Playwright network 模式):命中 networkHint 的第一个响应即搜索回包
    let settled = false
    let body = ''
    const heard = new Promise<void>((resolve) => {
      t.page.on('response', async (res) => {
        if (settled) return
        const u = res.url()
        if (!NETWORK_HINTS.some((re) => re.test(u))) return
        try {
          body = await res.text()
        } catch { /* 流式/竞态不可读则继续等下一个 */ }
        if (body) {
          settled = true
          resolve()
        }
      })
      // 超时也结算:miss/error 由后续判定
      setTimeout(() => resolve(), q.timeoutMs ?? 25_000)
    })

    await t.page.goto(entry.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await heard

    const title = await t.page.title().catch(() => '')
    const headHtml = (await t.page.content().catch(() => '')).slice(0, 5000)
    if (CHALLENGE_RE.test(title + headHtml)) {
      return err('challenged', `风控/验证码命中(title=${title.slice(0, 60)});按红线不重试不绕过,交还用户`)
    }
    const options = parseBatchSearch(body)
    const verdict: SessionVerdict = options.length > 0 ? 'hit' : 'miss'
    return {
      ok: true,
      via: 'session-ctrip-flight',
      evidence: `[会话:${site}@${ts}] ${options.length} options;guard blocked=${t.guard.blockedCount()}/${t.guard.requestCount()}${q.allowAnonymous ? ';anonymous=自检态' : ''}`,
      latencyMs: Date.now() - started,
      verdict,
      options,
    }
  } catch (e) {
    return err('error', e instanceof Error ? e.message.slice(0, 200) : String(e))
  } finally {
    await t.close()
  }
}
