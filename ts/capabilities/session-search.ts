/**
 * 会话检索编排层(RFC §3.2):transport → adapter entry → networkHint 嗅探 → 解析 → ReadGuard → 证据链。
 *
 * 传输车道(2026-08-29 定案,RFC §2.2):**扩展桥为默认**——一次性安装的 MV3 扩展
 * (GoTry Session Bridge)在自己标签页被动嗅探 batchSearch,零 Chrome 系统弹窗;
 *  cdp(attach 日常 Chrome,Chrome 144+ 每连接弹权限框)降为显式后备
 * (`GOTRY_SESSION_TRANSPORT=cdp` opt-in,诊断/测试用);persistent 仅测试。
 *
 * 证据链(L4 增补):[会话:ctrip-flight@ts] / [会话:ctrip-hotel@ts] = 用户本人会话内实时检索,非官方 API;
 * 风控命中(verdict='challenged')= degraded,绝不重试、绝不绕过(合规支柱②)。
 * 节律(§3.4):同站点 ≥30s 间隔 + 单调冷却;超间隔返回 verdict='cooldown'。
 * 永不抛错;扩展车道 fail-closed(桥/扩展不可用即 verdict,零花费);测试/巡检用隔离 profile 与 stateRoot。
 */

import { openSession } from './session/transport.ts'
import { extensionCookieNames, extensionSearchJob, classifyBridgeFailure } from './session/extension-channel.ts'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { buildEntryUrl, NETWORK_HINTS, parseBatchSearch, LOGIN_COOKIE_NAMES, SITE_DOMAIN, type SessionFlightOption } from './session/adapters/ctrip-flight.ts'
import { buildHotelEntryUrl, parseCtripHotelList, HOTEL_SITE_HOST, type SessionHotelOption } from './session/adapters/ctrip-hotel.ts'
import { buildTrainEntryUrl, parseLeftTicketQuery, TRAIN_SITE_HOST, type SessionTrainOption } from './session/adapters/rail-12306.ts'
import { EXTENSION_STORE_URL } from './session/extension-bridge.ts'

export type SessionVerdict = 'hit' | 'miss' | 'error' | 'challenged' | 'cooldown' | 'needs-login' | 'needs-attach' | 'needs-extension'

export interface SessionSearchResult {
  ok: boolean
  via: 'session-ctrip-flight' | 'session-ctrip-flight-error'
  evidence: string
  latencyMs: number
  verdict: SessionVerdict
  options?: SessionFlightOption[]
  error?: string
  /** needs-extension 时给出 Chrome Web Store URL —— dsh UI 应直接渲成可点链接(浏览器自己当安装器,gotry 不插手) */
  installUrl?: string
  installAction?: 'add-to-chrome'
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

/** Live browser transport is an explicit opt-in for smoke/full-suite callers. */
export function sessionLiveEnabled(env: Partial<Pick<NodeJS.ProcessEnv, 'GOTRY_SESSION_LIVE'>> = process.env): boolean {
  return env.GOTRY_SESSION_LIVE === '1'
}

/** Deterministic offline observation used when the live session gate is closed. */
export function offlineSessionFlightResult(): SessionSearchResult {
  return {
    ok: false,
    via: 'session-ctrip-flight-error',
    evidence: '[会话:ctrip-flight@offline] GOTRY_SESSION_LIVE!=1; live transport not invoked',
    latencyMs: 0,
    verdict: 'error',
    error: 'GOTRY_SESSION_LIVE=1 required for live session transport',
  }
}

/** Gate a caller before it can invoke the browser/session transport. */
export async function gatedSessionFlightSearch(
  q: SessionFlightQuery,
  search: (query: SessionFlightQuery) => Promise<SessionSearchResult> = sessionFlightSearch,
  env: Partial<Pick<NodeJS.ProcessEnv, 'GOTRY_SESSION_LIVE'>> = process.env,
): Promise<SessionSearchResult> {
  if (!sessionLiveEnabled(env)) return offlineSessionFlightResult()
  return search(q)
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

// ---------------------------------------------------------------------------
// 酒店会话检索(2026-09-03 实装;与机票同构:节律闸/登录闸/needs-extension 映射/
// 挑战红线/证据链。酒店页与机票页同属 ctrip.com 风控域,但通道键独立——
// 各自 30s 预算已足够礼貌,跨通道合并预算留首个真会话风控观测后校准)
// ---------------------------------------------------------------------------

export interface SessionHotelQuery {
  /** 目的地(中文);城市码表未收录时须带 cityId */
  to: string
  /** 显式城市 id(携程/trip.com 酒店 list 页 URL 的 city= 数字;覆盖码表) */
  cityId?: number | string
  /** YYYY-MM-DD */
  checkIn?: string
  /** YYYY-MM-DD(与 checkIn 成对) */
  checkOut?: string
  adults?: number
  /** 隔离 profile 目录(测试必传;默认 /tmp 专用目录) */
  profileDir?: string
  headless?: boolean
  /** ReadGuard 审计路径(测试传隔离 stateRoot 下) */
  auditPath?: string
  /** 等嗅探回包的上限,默认 30_000(酒店列表接口比机票慢) */
  timeoutMs?: number
  /** 允许匿名实例(默认 false);true 仅适配器链路自检,证据链标 anonymous */
  allowAnonymous?: boolean
}

export interface SessionHotelResult {
  ok: boolean
  via: 'session-ctrip-hotel' | 'session-ctrip-hotel-error'
  evidence: string
  latencyMs: number
  verdict: SessionVerdict
  hotels?: SessionHotelOption[]
  error?: string
  /** needs-extension 时给出 Chrome Web Store URL(dsh UI 渲成可点链接) */
  installUrl?: string
  installAction?: 'add-to-chrome'
}

/** 酒店城市码表未收录时的人话指引(纯函数,测试锚点) */
export function hotelCityUnresolvedHint(cities: string[]): string {
  return `城市 ${cities.join('/')} 不在携程酒店城市码表——先 web 搜「hotels.ctrip.com ${cities[0] ?? ''} 酒店」拿到 list 页 URL 里的 city= 数字,带 cityId 重试`
}

export async function sessionHotelSearch(q: SessionHotelQuery): Promise<SessionHotelResult> {
  const started = Date.now()
  const ts = new Date().toISOString()
  const site = 'ctrip-hotel'
  const err = (verdict: SessionVerdict, error: string): SessionHotelResult => ({
    ok: false, via: 'session-ctrip-hotel-error', evidence: `[会话:${site}@error@${ts}] ${error}`, latencyMs: Date.now() - started, verdict, error,
  })

  // 日期对闸(与 flyai hotel 同口径):成对且 YYYY-MM-DD;过去日期不发上游
  if ((q.checkIn ? 1 : 0) !== (q.checkOut ? 1 : 0) || (q.checkIn && !/^\d{4}-\d{2}-\d{2}$/.test(q.checkIn))) {
    return err('error', 'checkIn/checkOut 须成对且为 YYYY-MM-DD(未定档期可不带日期)')
  }
  if (q.checkIn) {
    const now = new Date()
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    if (q.checkIn < today || (q.checkOut ?? '') < q.checkIn) {
      return err('error', `入住 ${q.checkIn}/退房 ${q.checkOut ?? ''} 不是未来合法区间(今天 ${today})——向用户确认日期后再查`)
    }
  }

  // 节律闸:超间隔即拒,不发起导航
  const last = lastCallAt.get(site) ?? 0
  if (Date.now() - last < MIN_INTERVAL_MS) {
    return err('cooldown', `rate limit: last call ${Date.now() - last}ms ago, min ${MIN_INTERVAL_MS}ms`)
  }
  lastCallAt.set(site, Date.now())

  const entry = buildHotelEntryUrl({ to: q.to, cityId: q.cityId, checkIn: q.checkIn, checkOut: q.checkOut, adults: q.adults })
  if (!entry.ok || !entry.url) {
    return err('error', hotelCityUnresolvedHint(entry.unresolved ?? [q.to]))
  }

  const mode = resolveTransportMode(q.profileDir)

  if (mode === 'extension') {
    // ① 登录态快查(与机票同账号体系,票据 cookie 名一致)
    const login = await extensionCookieNames({ site, domain: SITE_DOMAIN.replace(/^\./, ''), ticketNames: LOGIN_COOKIE_NAMES })
    if (!login.ok) {
      const verdict = classifyBridgeFailure(login.kind)
      if (verdict === 'needs-extension') {
        return { ok: false, via: 'session-ctrip-hotel-error', evidence: '[会话:ctrip-hotel-needs-extension@ts]', latencyMs: Date.now() - started, verdict, error: login.summary, installUrl: EXTENSION_STORE_URL, installAction: 'add-to-chrome' as const }
      }
      return err(verdict, login.summary)
    }
    if (login.tickets.length === 0 && !q.allowAnonymous) {
      return err('needs-login', '未检出你本人登录态——调用 gotry_session_login 为用户打开携程登录入口(登录在携程官网完成;gotry 永不经手密码/验证码/cookie 值)')
    }
    // ② 检索 job:后台标签 + 被动嗅探(URL hint + 形状兜底;扩展零写行为)
    const r = await extensionSearchJob({ site, url: entry.url, timeoutMs: q.timeoutMs })
    appendExtensionAudit(q.auditPath, {
      kind: 'extension-session-job', site, url: entry.url, jobId: 'search',
      result: r.ok ? (r.timedOut ? 'timeout' : `body ${r.body.length}B title="${r.title.slice(0, 60)}"`) : `${r.kind}:${r.summary.slice(0, 120)}`,
    })
    if (!r.ok) {
      const verdict = classifyBridgeFailure(r.kind)
      if (verdict === 'needs-extension') {
        return { ok: false, via: 'session-ctrip-hotel-error', evidence: '[会话:ctrip-hotel-needs-extension@ts]', latencyMs: Date.now() - started, verdict, error: r.summary, installUrl: EXTENSION_STORE_URL, installAction: 'add-to-chrome' as const }
      }
      return err(verdict, r.summary)
    }
    const title = r.title
    const head = r.body.slice(0, 5000)
    if (CHALLENGE_RE.test(title + head)) {
      return err('challenged', `风控/验证码命中(title=${title.slice(0, 60)});按红线不重试不绕过,交还用户`)
    }
    const hotels = parseCtripHotelList(r.body)
    const verdict: SessionVerdict = hotels.length > 0 ? 'hit' : 'miss'
    return {
      ok: true,
      via: 'session-ctrip-hotel',
      evidence: `[会话:${site}@${ts}] ${hotels.length} hotels;transport=extension(被动嗅探,零系统弹窗;扩展零写行为=物理只读)${q.allowAnonymous ? ';anonymous=自检态' : ''}`,
      latencyMs: Date.now() - started,
      verdict,
      hotels,
    }
  }

  // cdp/persistent 车道:与机票同构——挂监听等 NETWORK hint 回包(酒店用 HOTEL hints + 形状兜底)
  const t = await openSession({ profileDir: q.profileDir, headless: q.headless, auditPath: q.auditPath, mode: mode === 'persistent' ? 'persistent' : 'cdp', newPage: true })
  if (!t.ok) {
    return err(classifyTransportFailure(t.summary, q.profileDir === undefined), t.summary)
  }
  try {
    const loggedIn = async (): Promise<boolean> => {
      const cookies = await t.browser.cookies().catch(() => [])
      return cookies.some((c) => c.domain.includes(SITE_DOMAIN.replace(/^\./, '')) && LOGIN_COOKIE_NAMES.includes(c.name))
    }
    if (!(await loggedIn()) && !q.allowAnonymous) {
      return err('needs-login', '未检出你本人登录态——调用 gotry_session_login 为用户打开携程登录入口(登录在携程官网完成;gotry 永不经手密码/验证码/cookie 值)')
    }
    let settled = false
    let body = ''
    const heard = new Promise<void>((resolve) => {
      t.page.on('response', async (res) => {
        if (settled) return
        const u = res.url()
        const hostHit = u.includes(HOTEL_SITE_HOST)
        if (!hostHit) return
        try {
          const text = await res.text()
          if (text && (hostHit && /hotels\.ctrip\.com\/(hotels\/api|domestic\/pc\/api)|GetHotelListBySOA|GetHotelListByCity|HotelSearch|hotelsearch/i.test(u) || text.length <= 2_000_000 && /"hotelList"|"hotelMatchInfos"|"hotelName"/.test(text))) {
            body = text
            settled = true
            resolve()
          }
        } catch { /* 流式/竞态不可读则继续等下一个 */ }
      })
      setTimeout(() => resolve(), q.timeoutMs ?? 30_000)
    })
    await t.page.goto(entry.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await heard
    const title = await t.page.title().catch(() => '')
    const headHtml = (await t.page.content().catch(() => '')).slice(0, 5000)
    if (CHALLENGE_RE.test(title + headHtml)) {
      return err('challenged', `风控/验证码命中(title=${title.slice(0, 60)});按红线不重试不绕过,交还用户`)
    }
    const hotels = parseCtripHotelList(body)
    const verdict: SessionVerdict = hotels.length > 0 ? 'hit' : 'miss'
    return {
      ok: true,
      via: 'session-ctrip-hotel',
      evidence: `[会话:${site}@${ts}] ${hotels.length} hotels;guard blocked=${t.guard.blockedCount()}/${t.guard.requestCount()}${q.allowAnonymous ? ';anonymous=自检态' : ''}`,
      latencyMs: Date.now() - started,
      verdict,
      hotels,
    }
  } catch (e) {
    return err('error', e instanceof Error ? e.message.slice(0, 200) : String(e))
  } finally {
    await t.close()
  }
}


// ---------------------------------------------------------------------------
// 火车会话检索(2026-09-03 实装;12306 余票查询是公开面——登录只关系下单,
// 无账号数据过手,故无登录闸;扩展照样只读被动嗅探,证据链标注「公开查询面」)
// ---------------------------------------------------------------------------

export interface SessionTrainQuery {
  from: string
  to: string
  /** YYYY-MM-DD */
  date: string
  /** 显式城市电报码(覆盖码表;kyfw 查询页 URL fs=城市,XXX 的三位码) */
  fromStationTelecode?: string
  toStationTelecode?: string
  /** 隔离 profile 目录(测试必传;默认 /tmp 专用目录) */
  profileDir?: string
  headless?: boolean
  /** ReadGuard 审计路径(测试传隔离 stateRoot 下) */
  auditPath?: string
  /** 等嗅探回包的上限,默认 25_000 */
  timeoutMs?: number
}

export interface SessionTrainResult {
  ok: boolean
  via: 'session-train-12306' | 'session-train-12306-error'
  evidence: string
  latencyMs: number
  verdict: SessionVerdict
  trains?: SessionTrainOption[]
  error?: string
  /** needs-extension 时给出 Chrome Web Store URL(dsh UI 渲成可点链接) */
  installUrl?: string
  installAction?: 'add-to-chrome'
}

/** 车站电报码表未收录时的人话指引(纯函数,测试锚点) */
export function trainStationUnresolvedHint(cities: string[]): string {
  return `城市 ${cities.join('/')} 不在 12306 城市电报码表——web 搜「12306 ${cities[0] ?? ''} 余票」拿到 kyfw 查询页 URL 里的 fs=城市,XXX 三位码,带 fromStationTelecode/toStationTelecode 重试`
}

export async function sessionTrainSearch(q: SessionTrainQuery): Promise<SessionTrainResult> {
  const started = Date.now()
  const ts = new Date().toISOString()
  const site = 'train-12306'
  const err = (verdict: SessionVerdict, error: string): SessionTrainResult => ({
    ok: false, via: 'session-train-12306-error', evidence: `[会话:${site}@error@${ts}] ${error}`, latencyMs: Date.now() - started, verdict, error,
  })

  // 节律闸:超间隔即拒,不发起导航
  const last = lastCallAt.get(site) ?? 0
  if (Date.now() - last < MIN_INTERVAL_MS) {
    return err('cooldown', `rate limit: last call ${Date.now() - last}ms ago, min ${MIN_INTERVAL_MS}ms`)
  }
  lastCallAt.set(site, Date.now())

  const entry = buildTrainEntryUrl({ from: q.from, to: q.to, date: q.date, fromStationTelecode: q.fromStationTelecode, toStationTelecode: q.toStationTelecode })
  if (!entry.ok || !entry.url) {
    return err('error', trainStationUnresolvedHint(entry.unresolved ?? [q.from, q.to]))
  }

  const mode = resolveTransportMode(q.profileDir)

  if (mode === 'extension') {
    // 无登录闸(公开查询面):直接发起检索 job
    const r = await extensionSearchJob({ site, url: entry.url, timeoutMs: q.timeoutMs })
    appendExtensionAudit(q.auditPath, {
      kind: 'extension-session-job', site, url: entry.url, jobId: 'search',
      result: r.ok ? (r.timedOut ? 'timeout' : `body ${r.body.length}B title="${r.title.slice(0, 60)}"`) : `${r.kind}:${r.summary.slice(0, 120)}`,
    })
    if (!r.ok) {
      const verdict = classifyBridgeFailure(r.kind)
      if (verdict === 'needs-extension') {
        return { ok: false, via: 'session-train-12306-error', evidence: '[会话:train-12306-needs-extension@ts]', latencyMs: Date.now() - started, verdict, error: r.summary, installUrl: EXTENSION_STORE_URL, installAction: 'add-to-chrome' as const }
      }
      return err(verdict, r.summary)
    }
    const title = r.title
    const head = r.body.slice(0, 5000)
    if (CHALLENGE_RE.test(title + head)) {
      return err('challenged', `风控/验证码命中(title=${title.slice(0, 60)});按红线不重试不绕过,交还用户`)
    }
    const trains = parseLeftTicketQuery(r.body, entry.url)
    const verdict: SessionVerdict = trains.length > 0 ? 'hit' : 'miss'
    return {
      ok: true,
      via: 'session-train-12306',
      evidence: `[会话:${site}@${ts}] ${trains.length} trains;transport=extension(公开查询面,被动嗅探,零系统弹窗;扩展零写行为=物理只读)`,
      latencyMs: Date.now() - started,
      verdict,
      trains,
    }
  }

  // cdp/persistent 车道:与机/酒同构
  const t = await openSession({ profileDir: q.profileDir, headless: q.headless, auditPath: q.auditPath, mode: mode === 'persistent' ? 'persistent' : 'cdp', newPage: true })
  if (!t.ok) {
    return err(classifyTransportFailure(t.summary, q.profileDir === undefined), t.summary)
  }
  try {
    let settled = false
    let body = ''
    const heard = new Promise<void>((resolve) => {
      t.page.on('response', async (res) => {
        if (settled) return
        const u = res.url()
        if (!/leftTicket\/query/i.test(u)) return
        try {
          const text = await res.text()
          if (text) {
            body = text
            settled = true
            resolve()
          }
        } catch { /* 流式/竞态不可读则继续等下一个 */ }
      })
      setTimeout(() => resolve(), q.timeoutMs ?? 25_000)
    })
    await t.page.goto(entry.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await heard
    const title = await t.page.title().catch(() => '')
    const headHtml = (await t.page.content().catch(() => '')).slice(0, 5000)
    if (CHALLENGE_RE.test(title + headHtml)) {
      return err('challenged', `风控/验证码命中(title=${title.slice(0, 60)});按红线不重试不绕过,交还用户`)
    }
    const trains = parseLeftTicketQuery(body, entry.url)
    const verdict: SessionVerdict = trains.length > 0 ? 'hit' : 'miss'
    return {
      ok: true,
      via: 'session-train-12306',
      evidence: `[会话:${site}@${ts}] ${trains.length} trains(公开查询面);guard blocked=${t.guard.blockedCount()}/${t.guard.requestCount()}`,
      latencyMs: Date.now() - started,
      verdict,
      trains,
    }
  } catch (e) {
    return err('error', e instanceof Error ? e.message.slice(0, 200) : String(e))
  } finally {
    await t.close()
  }
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
      if (verdict === 'needs-extension') {
        return { ok: false, via: 'session-ctrip-flight-error', evidence: '[会话:ctrip-flight-needs-extension@ts]', latencyMs: Date.now() - started, verdict, error: login.summary, installUrl: EXTENSION_STORE_URL, installAction: 'add-to-chrome' as const }
      }
      return err(verdict, login.summary)
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
      if (verdict === 'needs-extension') {
        return { ok: false, via: 'session-ctrip-flight-error', evidence: '[会话:ctrip-flight-needs-extension@ts]', latencyMs: Date.now() - started, verdict, error: r.summary, installUrl: EXTENSION_STORE_URL, installAction: 'add-to-chrome' as const }
      }
      return err(verdict, r.summary)
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
