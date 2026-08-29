/**
 * 会话检索编排层(RFC §3.2):transport → adapter entry → networkHint 嗅探 → 解析 → ReadGuard → 证据链。
 *
 * 传输车道(2026-08-29 定案,RFC §2.2):**扩展桥为默认**——一次性安装的 MV3 扩展
 * (GoTry Session Bridge)在自己标签页被动嗅探 batchSearch,零 Chrome 系统弹窗;
 *  cdp(attach 日常 Chrome,Chrome 144+ 每连接弹权限框)降为显式后备
 * (`GOTRY_SESSION_TRANSPORT=cdp` opt-in,诊断/测试用);persistent 仅测试。
 *
 * 证据链(L4 增补):[会话:ctrip-flight@ts] = 用户本人会话内实时检索,非官方 API;
 * 风控命中(verdict='challenged')= degraded,绝不重试、绝不绕过(合规支柱②)。
 * 节律(§3.4):同站点 ≥30s 间隔 + 单调冷却;超间隔返回 verdict='cooldown'。
 * 永不抛错;扩展车道 fail-closed(桥/扩展不可用即 verdict,零花费);测试/巡检用隔离 profile 与 stateRoot。
 */

import { openSession } from './session/transport.ts'
import { extensionCookieNames, extensionSearchJob, classifyBridgeFailure, NEEDS_EXTENSION_HINT } from './session/extension-channel.ts'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { buildEntryUrl, NETWORK_HINTS, parseBatchSearch, LOGIN_COOKIE_NAMES, SITE_DOMAIN, type SessionFlightOption } from './session/adapters/ctrip-flight.ts'

export type SessionVerdict = 'hit' | 'miss' | 'error' | 'challenged' | 'cooldown' | 'needs-login' | 'needs-attach' | 'needs-extension'

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

/** 把 transport 文案漂移收敛为稳定的产品 verdict；纯函数供回归覆盖。 */
export function classifyTransportFailure(summary: string, cdpMode: boolean): Extract<SessionVerdict, 'needs-attach' | 'error'> {
  return cdpMode && /日常 Chrome 未开调试端口|cdp attach 失败/.test(summary)
    ? 'needs-attach'
    : 'error'
}

/** 传输车道解析(纯函数,测试锚点):persistent=隔离 profile(测试自检);cdp=显式 opt-in;扩展=默认 */
export function resolveTransportMode(profileDir?: string): 'cdp' | 'persistent' | 'extension' {
  if (profileDir !== undefined) return 'persistent'
  return (process.env.GOTRY_SESSION_TRANSPORT ?? '').trim().toLowerCase() === 'cdp' ? 'cdp' : 'extension'
}

/** 扩展车道 job 审计(ReadGuard 审计同款 JSONL,kind 区分;auditPath 缺省不落盘) */
export function appendExtensionAudit(auditPath: string | undefined, entry: { kind: 'extension-session-job'; site: string; url: string; jobId: string; result: string }): void {
  if (!auditPath) return
  try {
    const record = { ts: new Date().toISOString(), ...entry, url: entry.url.slice(0, 400) }
    mkdirSync(dirname(auditPath), { recursive: true })
    appendFileSync(auditPath, JSON.stringify(record) + '\n')
  } catch { /* 审计失败不阻塞检索 */ }
}

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

  const mode = resolveTransportMode(q.profileDir)

  if (mode === 'extension') {
    // ① 登录态快查:票据 cookie 名存在性(免标签页,秒回;needs-login 不再先付一次导航成本)
    const login = await extensionCookieNames({ site, domain: SITE_DOMAIN.replace(/^\./, ''), ticketNames: LOGIN_COOKIE_NAMES })
    if (!login.ok) {
      const verdict = classifyBridgeFailure(login.kind)
      return err(verdict, verdict === 'needs-extension' ? `${login.summary};${NEEDS_EXTENSION_HINT}` : login.summary)
    }
    // 登录态闸:用户自己的账号;匿名默认拒(allowAnonymous 仅链路自检且证据标自检态)
    if (login.tickets.length === 0 && !q.allowAnonymous) {
      return err('needs-login', '未检出你本人登录态——调用 gotry_session_login 为用户打开携程登录入口(登录在携程官网完成;gotry 永不经手密码/验证码/cookie 值)')
    }
    // ② 检索 job:后台标签 + MAIN-world 被动嗅探(检索请求由站点自己发出,扩展零写行为)
    const r = await extensionSearchJob({ site, url: entry.url, timeoutMs: q.timeoutMs })
    appendExtensionAudit(q.auditPath, {
      kind: 'extension-session-job', site, url: entry.url, jobId: 'search',
      result: r.ok ? (r.timedOut ? 'timeout' : `body ${r.body.length}B title="${r.title.slice(0, 60)}"`) : `${r.kind}:${r.summary.slice(0, 120)}`,
    })
    if (!r.ok) {
      const verdict = classifyBridgeFailure(r.kind)
      return err(verdict, verdict === 'needs-extension' ? `${r.summary};${NEEDS_EXTENSION_HINT}` : r.summary)
    }
    const title = r.title
    const head = r.body.slice(0, 5000)
    if (CHALLENGE_RE.test(title + head)) {
      return err('challenged', `风控/验证码命中(title=${title.slice(0, 60)});按红线不重试不绕过,交还用户`)
    }
    const options = parseBatchSearch(r.body)
    const verdict: SessionVerdict = options.length > 0 ? 'hit' : 'miss'
    return {
      ok: true,
      via: 'session-ctrip-flight',
      evidence: `[会话:${site}@${ts}] ${options.length} options;transport=extension(被动嗅探,零系统弹窗;扩展零写行为=物理只读)${q.allowAnonymous ? ';anonymous=自检态' : ''}`,
      latencyMs: Date.now() - started,
      verdict,
      options,
    }
  }

  // 人机共治纪律:检索一律开自己的新标签页(绝不劫持用户已有页面),用完关自己的页
  // cdp 车道(显式 GOTRY_SESSION_TRANSPORT=cdp opt-in)与 persistent(测试隔离 profile)
  const t = await openSession({ profileDir: q.profileDir, headless: q.headless, auditPath: q.auditPath, mode: mode === 'persistent' ? 'persistent' : 'cdp', newPage: true })
  if (!t.ok) {
    // cdp 未开端口或握手失败 → needs-attach(一次性用户动作);persistent 启动失败仍走 error。
    // transport 的“端口未开”在连接前返回,文案不含 `cdp attach 失败`,两种形态都要归入同一用户门禁。
    return err(classifyTransportFailure(t.summary, q.profileDir === undefined), t.summary)
  }

  try {
    // 登录态闸:用户自己的账号,不是匿名实例——匿名态按 onAnonymous 处置(默认 fail)
    const loggedIn = async (): Promise<boolean> => {
      const cookies = await t.browser.cookies().catch(() => [])
      return cookies.some((c) => c.domain.includes(SITE_DOMAIN.replace(/^\./, '')) && LOGIN_COOKIE_NAMES.includes(c.name))
    }
    if (!(await loggedIn()) && !q.allowAnonymous) {
      return err('needs-login', '未检出你本人登录态——调用 gotry_session_login 为用户打开携程登录入口(登录在携程官网完成;gotry 永不经手密码/验证码/cookie 值)')
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
