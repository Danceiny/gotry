/**
 * 效应解译器 effect_interpreter.v1(issue #16 采纳,ADR-18)。
 *
 * 「效应描述 + 解译器」:业务/编排层对基础设施的依赖收敛为一个**纯数据的效应值**
 * (effect 名 + params),不存在对渠道模块的直接 import——agent 不调用 Ctrip.Query(),
 * 它描述 `SEARCH_FLIGHT`;把意图换算成真实副作用的是可替换的解译器:
 *
 *   - 生产解译器 makeProductionInterpreter:查注册表 → 韧性横切(指数退避重试/
 *     断路器,per-效应策略表)→ 渠道 handler(现能力层函数,零改写);
 *   - mock  解译器 makeMockInterpreter:夹具回放(CI/本地无网确定性);
 *   - 浏览器解译 = SESSION_* 效应(用户本人登录态的扩展桥车道,2026-08-29 起默认传输:
 *     MV3 GoTry Session Bridge + 本地桥长轮询,零系统弹窗;ReadGuard+授权闸不变,
 *     非 CUA 视觉点击——本仓已按零 Python 依赖与 a11y/DOM 优先判死后者,
 *     docs/effect-interpreter.md §4)。
 *
 * 解译产物:`{ result, trace }`——result 是渠道自有 observation **原样透传**
 * (ADR-13 平铺 envelope 在工具层不受扰);trace 是解译层横切证据
 * {attempts, backoffMs, breaker, declined, evidence},拼进工具层 summary/evidence。
 * unknown-effect / 断路拒绝时 result=null + declinedObservation() 给出平铺失败面。
 *
 * 多渠道比价口径:解译器**不做**渠道间自动路由/降级排序——OTA 工具面平铺是
 * founder 判定(persona 19),比价发生在 agent 层(多工具并调+证据链逐源标注);
 * 本层只让「每条通道」更可替换、可熔断、可 mock。
 */

import {
  CircuitBreaker,
  withRetry,
  type BreakerState,
  type RetryPolicy,
  type RetryablePredicate,
} from './resilience.ts'
import { flyaiSearch, type FlyaiQuery } from './flyai.ts'
import { checkAvail, hotelRates, searchHotels } from './hbcli.ts'
import { sessionFlightSearch, sessionHotelSearch, sessionTrainSearch, type SessionFlightQuery, type SessionHotelQuery, type SessionTrainQuery } from './session-search.ts'
import { geocodePlace, getClimate, getForecast, type WeatherPoint } from './weather.ts'
import { verifyFlight, type FlightLiveQuery } from './opensky.ts'
import { anythingSearch, type AnythingQuery } from './anything.ts'
import { continentListUrl, countryPageUrl, extractVisaSection, fetchVisaPolicyPage, listCountryPaths, policyFactsFromMfa, type MfaPolicyFact, type VisaPolicyEffectParams } from './visa-policy.ts'
import { readUrl, reach, reachStatus } from './agent-reach.ts'
import { githubSearch, videoSubtitle } from './agent-reach-deep.ts'
import { sessionLogin } from './session-login.ts'

// ---------------------------------------------------------------------------
// 渠道 handler 注册表:effect 名(变体大写下划线,纯数据词表)→ 渠道实现
// ---------------------------------------------------------------------------

/** hbcli 酒店检索参数(工具面 params 子集;fallbackPath 是静态包降级面,bin/timeout 直通 config) */
export interface HbHotelEffectParams {
  destination: string
  checkIn?: string
  checkOut?: string
  adults?: number
  /** 静态数据包降级路径(data/hotels_2026.json) */
  fallbackPath?: string
  /** hbcli 二进制(插件 config 直通) */
  hbcliBin?: string
  timeoutMs?: number
}

/** hbcli 房型报价参数(M0 预订链;价格面无静态降级 fail-closed,产物 RatePkgId 供 check-avail/book) */
export interface HbRatesEffectParams {
  hotelId: string
  checkIn?: string
  checkOut?: string
  adults?: number
  countryCode?: string
  nationalityCode?: string
  residencyCode?: string
  hbcliBin?: string
  timeoutMs?: number
}

/** hbcli 实时验价参数(M0 预订链;入参 RatePkgId 来自 HBCLI_HOTEL_RATES 产物) */
export interface HbCheckAvailEffectParams {
  ratePkgId: string
  hbcliBin?: string
  timeoutMs?: number
}

/** agent-reach 反射桥参数(status=上游 doctor;reach=渠道×方法透传) */
export interface AgentReachEffectParams {
  action?: string
  channel?: string
  method?: string
  args?: string
  timeoutMs?: number
}

/** 账号会话登录引导参数(等待秒数;0 值凭证不过手) */
export interface SessionLoginEffectParams {
  waitSeconds?: number
}

interface MfaPage { ok: boolean; html?: string; error?: string }

/** C 档中国领事服务网抓取编排:country 直抓 / continent 列表遍历(≤limit,默认 10;抓取纪律=礼貌间隔,不并发) */
async function fetchVisaPolicyEntries(p: VisaPolicyEffectParams): Promise<{ ok: boolean; via: string; evidence: string; latencyMs: number; facts: MfaPolicyFact[]; countries: string[]; error?: string }> {
  const started = Date.now()
  const fetchedAt = new Date().toISOString()
  const countries: string[] = []
  const facts: MfaPolicyFact[] = []
  const targets: Array<{ continent: string; country: string }> = []
  if (p.country) {
    targets.push({ continent: p.continent ?? 'yz_645708', country: p.country })
  } else if (p.continent) {
    const listUrl = continentListUrl(p.continent)
    if (!listUrl) return { ok: false, via: 'visa-policy-error', evidence: `[visa-policy@${fetchedAt}] 非法洲路径`, latencyMs: 0, facts: [], countries: [], error: 'invalid_continent' }
    const page = await fetchVisaPolicyPage(listUrl, p.timeoutMs)
    if (!page.ok || !page.html) return { ok: false, via: 'visa-policy-error', evidence: `[visa-policy@${fetchedAt}] 洲列表抓取失败: ${page.error ?? '?'}`, latencyMs: 0, facts: [], countries: [], error: page.error }
    for (const c of listCountryPaths(page.html, p.continent).slice(0, Math.max(1, Math.min(10, p.limit ?? 10)))) targets.push({ continent: p.continent, country: c })
  }
  for (const t of targets) {
    const url = countryPageUrl(t.continent, t.country)
    if (!url) continue
    const page: MfaPage = await fetchVisaPolicyPage(url, p.timeoutMs)
    countries.push(t.country)
    if (!page.ok || !page.html) continue
    const section = extractVisaSection(page.html)
    if (!section) continue
    facts.push(...policyFactsFromMfa({ countryLabel: t.country, countryPath: t.country, section, fetchedAt }))
  }
  const evidence = facts.length > 0
    ? `[visa-policy:cs-mfa@${fetchedAt}] ${facts.length} 条政策事实(抓取 ${countries.length} 国)`
    : `[visa-policy@${fetchedAt}] 0 条(页面缺「签证入境」章节或抓取失败;不落负事实)`
  return { ok: true, via: 'cs-mfa', evidence, latencyMs: Date.now() - started, facts, countries }
}

/** 默认渠道实现(生产解译器的 dispatch 目标;全部满足「永不抛错」能力层契约) */
const DEFAULT_HANDLERS = {
  /** 飞猪官方只读通道(机/火/酒店;spawn CLI) */
  FLYAI_SEARCH: (p: FlyaiQuery) => flyaiSearch(p),
  /** hotelbyte 桥(实时 hbcli → 静态包降级;spawn CLI) */
  HBCLI_HOTEL_SEARCH: (p: HbHotelEffectParams) =>
    searchHotels(
      { destination: p.destination, checkIn: p.checkIn, checkOut: p.checkOut, adults: p.adults },
      { hbcliBin: p.hbcliBin, timeoutMs: p.timeoutMs, fallbackPath: p.fallbackPath },
    ),
  /** hotelbyte 桥·房型报价(M0 预订链;spawn CLI;价格面无静态降级 fail-closed) */
  HBCLI_HOTEL_RATES: (p: HbRatesEffectParams) =>
    hotelRates(
      {
        hotelId: p.hotelId, checkIn: p.checkIn, checkOut: p.checkOut, adults: p.adults,
        countryCode: p.countryCode, nationalityCode: p.nationalityCode, residencyCode: p.residencyCode,
      },
      { hbcliBin: p.hbcliBin, timeoutMs: p.timeoutMs },
    ),
  /** hotelbyte 桥·下单前实时验价(M0 预订链;spawn CLI;同价格面红线,不可用即诚实失败) */
  HBCLI_CHECK_AVAIL: (p: HbCheckAvailEffectParams) =>
    checkAvail({ ratePkgId: p.ratePkgId }, { hbcliBin: p.hbcliBin, timeoutMs: p.timeoutMs }),
  /** 用户本人登录态会话检索(浏览器解译通道:扩展桥默认 + cdp 显式后备;ReadGuard+节律闸) */
  SESSION_FLIGHT_SEARCH: (p: SessionFlightQuery) => sessionFlightSearch(p),
  /** 用户本人登录态会话酒店检索(2026-09-03 实装;同浏览器解译通道,风控红线同款) */
  SESSION_HOTEL_SEARCH: (p: SessionHotelQuery) => sessionHotelSearch(p),
  /** 12306 余票会话检索(2026-09-03 实装;公开查询面,无登录闸;同浏览器解译通道) */
  SESSION_TRAIN_SEARCH: (p: SessionTrainQuery) => sessionTrainSearch(p),
  /** 地名 → 坐标(open-meteo → nominatim 双源,免费) */
  WEATHER_GEOCODE: (p: { name: string; count?: number; timeoutMs?: number }) => geocodePlace(p.name, { count: p.count, timeoutMs: p.timeoutMs }),
  /** 预报(≤16 天,免费无 key) */
  WEATHER_FORECAST: (p: WeatherPoint & { days?: number; timeoutMs?: number }) => getForecast({ latitude: p.latitude, longitude: p.longitude }, { days: p.days, timeoutMs: p.timeoutMs }),
  /** 历史气候(季节性基线,免费无 key) */
  WEATHER_CLIMATE: (p: WeatherPoint & { month: number; timeoutMs?: number }) => getClimate({ latitude: p.latitude, longitude: p.longitude }, p.month, { timeoutMs: p.timeoutMs }),
  /** OpenSky ADS-B 实时印证(免费匿名,~400 credits/天) */
  OPENSKY_FLIGHT_VERIFY: (p: FlightLiveQuery) => verifyFlight(p),
  /** hotel-be Anything 目的地/酒店候选(hbcli CLI;gotry_anything_search 同源,D-23 收编) */
  ANYTHING_SEARCH: (p: AnythingQuery) => anythingSearch(p),
  /** 网页读取兜底(r.jina.ai 免费公共源;gotry_web_search 同源,D-23 收编) */
  WEB_READ: (p: { url: string; timeoutMs?: number }) => readUrl({ url: p.url, timeoutMs: p.timeoutMs }),
  /** GitHub 仓库搜索(gh CLI;agent-reach-deep 执行面,gotry_github_search 同源,D-23 收编) */
  GITHUB_SEARCH: (p: { query: string; limit?: number; timeoutMs?: number }) => githubSearch(p),
  /** 视频字幕拉取(yt-dlp;agent-reach-deep 执行面,gotry_video_subtitle 同源,D-23 收编) */
  VIDEO_SUBTITLE: (p: { url: string; lang?: string; timeoutMs?: number }) => videoSubtitle(p),
  /** agent-reach 反射桥(status=上游 doctor;reach=渠道×方法透传,gotry_agent_reach 同源,D-23 收编) */
  AGENT_REACH: (p: AgentReachEffectParams) =>
    (p.action === 'status' || (!p.action && !p.channel))
      ? reachStatus(p.timeoutMs)
      : reach({ channel: p.channel ?? '', method: p.method ?? '', args: p.args, timeoutMs: p.timeoutMs }),
  /** 账号会话登录引导(浏览器通道;票据名只读 0 值过手,gotry_session_login 同源,D-23 收编) */
  SESSION_LOGIN: (p: SessionLoginEffectParams) => sessionLogin({ waitMs: typeof p.waitSeconds === 'number' ? p.waitSeconds * 1000 : undefined }),
  /** 政策事实生产端 v1(issue #141,D-26):C 档中国领事服务网国家指南树(礼貌抓取:永不重试+断路器护站) */
  VISA_POLICY_FETCH: (p: VisaPolicyEffectParams) => fetchVisaPolicyEntries(p),
} as const

export type EffectName = keyof typeof DEFAULT_HANDLERS
export type EffectParams<K extends EffectName> = Parameters<typeof DEFAULT_HANDLERS[K]>[0]
/** 渠道自有 observation 类型(从注册表单一来源推导,避免与能力层声明漂移) */
export type EffectResult<K extends EffectName> = Awaited<ReturnType<typeof DEFAULT_HANDLERS[K]>>

export type EffectChannel = 'api' | 'cli' | 'browser'

interface ChannelSpec {
  channel: EffectChannel
  /** null = 永不重试(重试是策略不是默认;每渠道显式拍板) */
  retry: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number } | null
  /** null = 不进断路器(状态型 verdict 渠道) */
  breaker: { failureThreshold: number; openMs: number } | null
  /** 瞬时失败判定(缺省 = 结果 {ok:false} 或抛错) */
  isRetryable?: RetryablePredicate
  /** 参与「失败」判定的形态(断路器计数与 declined 面共用) */
  isFailure: (result: unknown) => boolean
}

const defaultIsFailure = (r: unknown): boolean => (r as { ok?: unknown } | null)?.ok === false

/** FlyAI 错误原话里瞬时类(超时/网络断)才值得重试;Sentinel 限流与 ENOENT 永不 */
const flyaiTransient = (msg: string): boolean =>
  msg.length > 0
  && !/Sentinel/i.test(msg)
  && /timeout|timed out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket|HTTP 5/i.test(msg)

const API_RETRY = { maxAttempts: 2, baseDelayMs: 400, maxDelayMs: 1_600 }
const API_BREAKER = { failureThreshold: 3, openMs: 30_000 }

/**
 * HBCLI timeout 专用瞬时判定(2026-09-02 迪拜 session 实况:hotel-list 首调
 * 30s 超时,LLM 立即手动重试即成功——上游冷启动建后端 session 可超 30s,而
 * 「候选路径是切换不是重试」的契约只针对 ENOENT 类 spawn 失败,不覆盖超时)。
 * 只有 timeout 类失败值得重试一次;ENOENT/退码类上游明确说「不」的失败永不。
 */
const hbcliTimeout = (r: unknown): boolean => {
  const msg = String(((r ?? {}) as { error?: string }).error ?? '')
  return msg.length > 0 && /timeout/i.test(msg)
}
const HBCLI_RETRY: RetryPolicy = { maxAttempts: 2, baseDelayMs: 300, maxDelayMs: 1_000 }

/**
 * 渠道韧性策略表(权威面;docs/effect-interpreter.md §3 同表逐行有依据):
 *   - FLYAI:瞬时代码级错误重试 1 次;连续 3 次 error(含 Sentinel)熔断 60s 保护配额;
 *     试用额度达限(429)归 needs-setup,永不重试;
 *   - HBCLI:仅 timeout 类失败重试 1 次(冷启动建后端 session 可超时,重试即恢复);
 *     ENOENT/退码类永不重试(上游契约「候选路径是切换不是重试」),熔断同上;
 *     RATES/CHECK_AVAIL 同族,且价格面无静态降级(fail-closed,不估算房价——
 *     与 bookable-facts 证据分级同口径,live_inventory 才可进确认卡);
 *   - SESSION:永不重试、不熔断——风控/挑战是「上游说不」,重试即红线;
 *     节律闸(≥30s)在渠道内(session-search §3.4),不在本层重复。
 *   - WEATHER/OPENSKY:免费源,瞬时网络抖动可重试,熔断防免费配额空转。
 *   - ANYTHING:同 HBCLI 族(timeout 类瞬时重试 1 次;ENOENT/退码类永不);
 *   - WEB_READ:r.jina.ai 免费公共源,瞬时抖动可重试,熔断防公共配额空转;
 *   - GITHUB/VIDEO(gh/yt-dlp):verdict=timeout 瞬时重试 1 次;not-installed=配置态不重试;
 *   - AGENT_REACH:反射桥透传(wrapper 不是 router)——永不重试不熔断,上游超时自管;
 *   - SESSION_LOGIN:同 SESSION 浏览器族(风控红线)。
 *   (D-23 收尾,issue #115:六渠道入表,没有策略表行就没有效应。)
 */
const SPECS: Record<EffectName, ChannelSpec> = {
  FLYAI_SEARCH: {
    channel: 'cli',
    retry: { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 2_000 },
    breaker: { failureThreshold: 3, openMs: 60_000 },
    isRetryable: (_r, e) => {
      const msg = e != null ? String((e as Error).message ?? e) : String(((_r ?? {}) as { error?: string }).error ?? '')
      return flyaiTransient(msg)
    },
    isFailure: defaultIsFailure,
  },
  HBCLI_HOTEL_SEARCH: {
    channel: 'cli',
    retry: HBCLI_RETRY,
    // spec 级 isRetryable 是解译器组装 policy 的权威源(FLYAI 同款):仅 timeout 类
    // 瞬时(冷启动建后端 session);ENOENT/退码类永不(「切换不是重试」契约不变)
    isRetryable: (r) => hbcliTimeout(r),
    breaker: { failureThreshold: 3, openMs: 60_000 },
    isFailure: r => (r as { via?: string }).via === 'hbcli-error',
  },
  HBCLI_HOTEL_RATES: {
    channel: 'cli',
    retry: HBCLI_RETRY,
    isRetryable: (r) => hbcliTimeout(r),
    breaker: { failureThreshold: 3, openMs: 60_000 },
    isFailure: r => (r as { via?: string }).via === 'hbcli-error',
  },
  HBCLI_CHECK_AVAIL: {
    channel: 'cli',
    retry: HBCLI_RETRY,
    isRetryable: (r) => hbcliTimeout(r),
    breaker: { failureThreshold: 3, openMs: 60_000 },
    isFailure: r => (r as { via?: string }).via === 'hbcli-error',
  },
  SESSION_FLIGHT_SEARCH: {
    channel: 'browser',
    retry: null,
    breaker: null,
    isFailure: defaultIsFailure,
  },
  SESSION_HOTEL_SEARCH: {
    channel: 'browser',
    retry: null,
    breaker: null,
    isFailure: defaultIsFailure,
  },
  SESSION_TRAIN_SEARCH: {
    channel: 'browser',
    retry: null,
    breaker: null,
    isFailure: defaultIsFailure,
  },
  WEATHER_GEOCODE: { channel: 'api', retry: API_RETRY, breaker: API_BREAKER, isFailure: defaultIsFailure },
  WEATHER_FORECAST: { channel: 'api', retry: API_RETRY, breaker: API_BREAKER, isFailure: defaultIsFailure },
  WEATHER_CLIMATE: { channel: 'api', retry: API_RETRY, breaker: API_BREAKER, isFailure: defaultIsFailure },
  OPENSKY_FLIGHT_VERIFY: {
    channel: 'api',
    retry: API_RETRY,
    breaker: API_BREAKER,
    isRetryable: (_r, e) => e != null || ((_r ?? {}) as { verdict?: string }).verdict === 'unavailable',
    isFailure: r => (r as { via?: string }).via === 'opensky-error',
  },
  // --- D-23 收尾(issue #115):六渠道入注册表——没有策略表行就没有效应 ---
  // ANYTHING:同 HBCLI 族(hbcli CLI):仅 timeout 类瞬时(冷启动建后端 session)重试 1 次;
  // ENOENT/退码类永不(「切换不是重试」契约);熔断防上游空转
  ANYTHING_SEARCH: {
    channel: 'cli',
    retry: HBCLI_RETRY,
    isRetryable: (r) => hbcliTimeout(r),
    breaker: { failureThreshold: 3, openMs: 60_000 },
    isFailure: r => (r as { via?: string }).via === 'hbcli-anything-error',
  },
  // WEB_READ:r.jina.ai 免费公共源(同 WEATHER/OPENSKY 族):瞬时网络抖动可重试,
  // 熔断防公共配额空转;非法 URL 是用户输入错(isFailure 不含,不重试不熔断)
  WEB_READ: {
    channel: 'api',
    retry: API_RETRY,
    breaker: API_BREAKER,
    isFailure: r => (r as { via?: string }).via === 'r.jina.ai-error',
  },
  // GITHUB/VIDEO(gh/yt-dlp CLI):verdict=timeout 瞬时重试 1 次(进程冷启动超时同 HBCLI
  // 2026-09-02 实况);not-installed 是配置态(needs-setup 族,重试无意义),error 是上游说不;
  // 两者都计入熔断(防坏环境空转)
  GITHUB_SEARCH: {
    channel: 'cli',
    retry: HBCLI_RETRY,
    isRetryable: (r) => (r as { verdict?: string }).verdict === 'timeout',
    breaker: { failureThreshold: 3, openMs: 60_000 },
    isFailure: r => { const v = (r as { verdict?: string }).verdict; return v === 'error' || v === 'timeout' },
  },
  VIDEO_SUBTITLE: {
    channel: 'cli',
    retry: HBCLI_RETRY,
    isRetryable: (r) => (r as { verdict?: string }).verdict === 'timeout',
    breaker: { failureThreshold: 3, openMs: 60_000 },
    isFailure: r => { const v = (r as { verdict?: string }).verdict; return v === 'error' || v === 'timeout' },
  },
  // AGENT_REACH:反射桥透传(wrapper 不是 router,D-4a')——上游超时自管,重试会放大
  // 上游配额消耗,永不重试不熔断;needs-setup/not-installed 是「上游说不」同 SESSION 族
  AGENT_REACH: {
    channel: 'cli',
    retry: null,
    breaker: null,
    isFailure: r => (r as { verdict?: string }).verdict === 'error',
  },
  // SESSION_LOGIN:同 SESSION_* 浏览器族——风控/挑战红线,永不重试不熔断;
  // pending 是「等用户」不是失败
  SESSION_LOGIN: {
    channel: 'browser',
    retry: null,
    breaker: null,
    isFailure: defaultIsFailure,
  },
  // VISA_POLICY(issue #141,D-26 v1):C 档中国领事服务网——政府权威源礼貌抓取:
  // 永不重试(抓取纪律)+ 断路器防 hammering 政府站点;页面缺章节=无结论不落负事实
  VISA_POLICY_FETCH: {
    channel: 'api',
    retry: null,
    breaker: { failureThreshold: 2, openMs: 300_000 },
    isFailure: defaultIsFailure,
  },
}

// ---------------------------------------------------------------------------
// 解译器词汇:效应值 / 产物 / trace
// ---------------------------------------------------------------------------

/** 效应描述(纯数据,可 JSON 序列化——「handler 是数据不是 callable」的入参形态) */
export interface GotryEffect {
  effect: string
  params: unknown
}

export interface EffectTrace {
  effect: string
  channel: EffectChannel | 'mock'
  /** 实际执行次数(mock 夹具回放=1;断路拒绝=0) */
  attempts: number
  /** 累计回退等待(ms) */
  backoffMs: number
  breaker: BreakerState | 'off'
  /** 非 null 时 result 恒 null(结构化拒绝面,不抛错) */
  declined?: 'circuit-open' | 'unknown-effect'
  /** 解译层横切证据行([效应:<NAME>@ts] …) */
  evidence: string[]
}

export interface EffectOutcome<R = unknown> {
  /** 渠道自有 observation 原样透传(不重包);declined 时为 null */
  result: R | null
  trace: EffectTrace
}

export type EffectInterpreter = (fx: GotryEffect) => Promise<EffectOutcome>

/** 断路/未注册时的平铺失败观察(ADR-13 ToolFailure 兼容形态,工具层可直接返回) */
export function declinedObservation(effect: string, trace: EffectTrace): { ok: false; verdict: 'error'; summary: string; evidence: string } {
  return {
    ok: false,
    verdict: 'error',
    summary: trace.declined === 'circuit-open'
      ? `${effect} 通道被断路器开启保护(连续失败达到阈值,冷却中)——不要立即重试,换其他工具或稍后再试;原因见 trace 证据链`
      : `${effect} 未登记效应(effect_interpreter.v1 注册表外,生产解译器拒绝)`,
    evidence: trace.evidence.join(';'),
  }
}

// ---------------------------------------------------------------------------
// 生产解译器
// ---------------------------------------------------------------------------

export interface ProductionInterpreterOptions {
  /** 测试注入:按效应名替换渠道实现(默认 = DEFAULT_HANDLERS 原装渠道) */
  handlers?: Partial<Record<string, (params: unknown) => Promise<unknown>>>
  /** 断路器状态注入(测试隔离);缺省共享产品单例 Map(进程内瞬态) */
  breakers?: Map<string, CircuitBreaker>
  /** 时钟注入(断路冷却测试确定性) */
  now?: () => number
  /** 等待注入(回退测试即时放行) */
  sleep?: (ms: number) => Promise<void>
}

const defaultBreakers = new Map<string, CircuitBreaker>()
const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 测试隔离:清空产品单例断路器(断路状态是进程内瞬态,同 rate limiter 先例) */
export function __resetEffectBreakersForTest(): void {
  defaultBreakers.clear()
}

export function makeProductionInterpreter(opts: ProductionInterpreterOptions = {}): EffectInterpreter {
  const breakers = opts.breakers ?? defaultBreakers
  const sleep = opts.sleep ?? defaultSleep
  return async (fx: GotryEffect): Promise<EffectOutcome> => {
    const ts = new Date().toISOString()
    const name = fx.effect as EffectName
    const spec: ChannelSpec | undefined = SPECS[name]
    const handler = opts.handlers?.[fx.effect] ?? DEFAULT_HANDLERS[name]
    if (!spec || !handler) {
      return {
        result: null,
        trace: { effect: fx.effect, channel: 'api', attempts: 0, backoffMs: 0, breaker: 'off', declined: 'unknown-effect', evidence: [`[效应:${fx.effect}@${ts}] unknown effect`] },
      }
    }
    const br = (() => {
      if (!spec.breaker) return null
      const existing = breakers.get(fx.effect)
      if (existing) return existing
      const created = new CircuitBreaker({ ...spec.breaker, ...(opts.now ? { now: opts.now } : {}) })
      breakers.set(fx.effect, created)
      return created
    })()
    const gate = br?.canAttempt() ?? { allowed: true, state: 'closed' as const }
    if (!gate.allowed) {
      const trace: EffectTrace = { effect: fx.effect, channel: spec.channel, attempts: 0, backoffMs: 0, breaker: gate.state, declined: 'circuit-open', evidence: [`[效应:${fx.effect}@${ts}] breaker=${gate.state} 拒绝(冷却中,不重试)`] }
      return { result: null, trace }
    }
    const policy: RetryPolicy | null = spec.retry
      ? { maxAttempts: spec.retry.maxAttempts, baseDelayMs: spec.retry.baseDelayMs, maxDelayMs: spec.retry.maxDelayMs, isRetryable: spec.isRetryable, sleep }
      : { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, sleep }
    const dispatch = handler as (params: unknown) => Promise<unknown>
    const outcome = await withRetry(() => dispatch(fx.params), policy)
    const failed = outcome.error != null || spec.isFailure(outcome.result)
    if (br) failed ? br.onFailure() : br.onSuccess()
    const breakerState: BreakerState | 'off' = br?.state() ?? 'off'
    const evidence = [`[效应:${fx.effect}@${ts}] attempts=${outcome.attempts} backoff=${outcome.backoffMs}ms breaker=${breakerState}`]
    return {
      result: outcome.error != null ? null : outcome.result,
      trace: { effect: fx.effect, channel: spec.channel, attempts: outcome.attempts, backoffMs: outcome.backoffMs, breaker: breakerState, evidence },
    }
  }
}

/** 产品面解译器单例(断路器状态随进程存活;同 session-search 节律闸先例) */
export const productionInterpreter = makeProductionInterpreter()

/** 类型化入口:tool 层 `interpretEffect({ effect: 'FLYAI_SEARCH', params })` */
export async function interpretEffect<K extends EffectName>(fx: { effect: K; params: EffectParams<K> }): Promise<EffectOutcome<EffectResult<K>>> {
  return productionInterpreter(fx) as Promise<EffectOutcome<EffectResult<K>>>
}

// ---------------------------------------------------------------------------
// mock 解译器:CI/本地无网确定性(夹具 = 渠道 observation 的录制形态)
// ---------------------------------------------------------------------------

/**
 * mock 解译器(禁止网络,0 延迟,确定性):给同一效应返回夹具原样——
 * 渠道 observation 的录制就长什么样回放什么样,证据链由夹具自带
 * (录制期已带 [实时API:…]),trace 落 [效应:mock@ts] 夹具回放标注。
 * CI / 离线单测 / 巡检「不联网跑全链」即此通道(与 mock-llm 同思想的第三个成员)。
 */
export function makeMockInterpreter(fixtures: Record<string, unknown>): EffectInterpreter {
  return async (fx: GotryEffect): Promise<EffectOutcome> => {
    const ts = new Date().toISOString()
    const registered = Object.prototype.hasOwnProperty.call(fixtures, fx.effect)
    if (!registered) {
      return {
        result: null,
        trace: { effect: fx.effect, channel: 'mock', attempts: 0, backoffMs: 0, breaker: 'off', declined: 'unknown-effect', evidence: [`[效应:mock@${ts}] ${fx.effect} 未登记夹具`] },
      }
    }
    return {
      result: fixtures[fx.effect] as never,
      trace: { effect: fx.effect, channel: 'mock', attempts: 1, backoffMs: 0, breaker: 'off', evidence: [`[效应:mock@${ts}] ${fx.effect} 夹具回放(确定性,无网络)`] },
    }
  }
}

/** 按环境选择解译器('production' 默认;'mock' 供 CI/离线) */
export function selectInterpreter(env: 'production' | 'mock', opts: ProductionInterpreterOptions & { fixtures?: Record<string, unknown> } = {}): EffectInterpreter {
  return env === 'mock' ? makeMockInterpreter(opts.fixtures ?? {}) : makeProductionInterpreter(opts)
}