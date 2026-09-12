/**
 * 行程 HTML 渲染器(issue #442,父 #438)。
 *
 * 纯有界渲染器:拒绝畸形输入,产出单文件自包含 HTML。本模块不执行 IO、
 * 不启动服务、不解析 Markdown、不做夜数/预算/时间运算——只把显式行程结构
 * 与已注册事实投影成可导航、可展开的安全文档。
 *
 * 两条永不合流的证据面:
 *   1. 计划面(planner:trip_start/trip_end/stays/od_segments)——用户排期意图;
 *   2. 证据面(facts:调用方从注册表选出的 BookableFact)——exact-date 查询结论,
 *      逐条保留 tier/bookability/source/query_id/fetched_at/as_of。
 * 目的地级酒店库存绝不宣称「某家酒店有房/可订」;无任何整体 verified 徽章。
 *
 * 渲染闸锚点纪律:本模块不嵌入 `<!-- fact:<id> -->` 锚点(那属 Markdown 产物闸),
 * 事实 id 只作为可见文本展示,避免整篇 HTML 被当作锚点行解析。
 */

import {
  renderFlightFact,
  renderHotelFact,
  renderPolicyFact,
  type Bookability,
  type BookableFact,
  type EvidenceTier,
  type FlightFact,
  type HotelFact,
  type PolicyFact,
} from './bookable-facts.ts'

export interface ItineraryHtmlInput {
  title: string
  itinerary: {
    trip_start: string
    trip_end: string
    stays: Array<{ place: string; check_in: string; check_out: string }>
    od_segments: Array<{ from: string; to: string; date: string; mode: 'flight' | 'rail' | 'car'; legs: number }>
  }
  /** 调用方已从注册表选出的事实(渲染器不查询上游) */
  facts: BookableFact[]
}

export type ItineraryHtmlResult = { ok: true; html: string } | { ok: false; errors: string[] }

// ---------------------------------------------------------------------------
// 容量与取值上限(超出即 ok:false,绝不静默截断核心行程)
// ---------------------------------------------------------------------------

export const ITINERARY_HTML_LIMITS = {
  docBytes: 2 * 1024 * 1024,
  titleChars: 300,
  stays: 200,
  odSegments: 200,
  facts: 200,
  placeChars: 200,
  fromToChars: 200,
  flightNoChars: 64,
  subjectChars: 64,
  codeChars: 64,
  sourceChars: 200,
  queryIdChars: 200,
  asOfChars: 64,
  factIdChars: 96,
  carrierChars: 96,
  currencyChars: 8,
  statementChars: 2000,
  policyRuntimeFields: 24,
  errors: 32,
  legsMax: 20,
  priceMax: 1e9,
  optionsMax: 1_000_000,
  yearMin: 2000,
  yearMax: 2100,
} as const

const MODES = ['flight', 'rail', 'car'] as const
const BOOKABILITIES: readonly Bookability[] = ['bookable_exact_date', 'unavailable_exact_date', 'unverified', 'conflict']
const TIERS: readonly EvidenceTier[] = ['live_inventory', 'route_exists', 'historical_schedule', 'benchmark_price']

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const ISO_INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})$/
/** 输出大小上界:1 字符最多 4 字节 UTF-8,先用长度×4 做廉价门槛,再精确计数 */
const BYTES_PER_CHAR_MAX = 4

// ---------------------------------------------------------------------------
// 校验原语
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 真实日历日期:格式 + 月长 + 闰年(year 2000..2100,故无需处理 0..99 映射歧义) */
function isRealDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(5, 7))
  const day = Number(value.slice(8, 10))
  if (year < ITINERARY_HTML_LIMITS.yearMin || year > ITINERARY_HTML_LIMITS.yearMax) return false
  if (month < 1 || month > 12 || day < 1) return false
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function isIsoInstant(value: string): boolean {
  const m = ISO_INSTANT_RE.exec(value)
  if (!m) return false
  return isRealDate(`${m[1]}-${m[2]}-${m[3]}`) && Number(m[4]) <= 23 && Number(m[5]) <= 59 && Number(m[6]) <= 60
}

interface Ctx {
  errors: string[]
  truncated: boolean
}

function pushError(ctx: Ctx, message: string): void {
  if (ctx.errors.length >= ITINERARY_HTML_LIMITS.errors) {
    ctx.truncated = true
    return
  }
  ctx.errors.push(message)
}

/** 必填字符串:非空、不超上限(错误里不回显输入内容,避免把恶意串回灌到日志/终端) */
function takeString(ctx: Ctx, value: unknown, path: string, maxChars: number): string | undefined {
  if (typeof value !== 'string') {
    pushError(ctx, `${path} 必须是字符串`)
    return undefined
  }
  if (value.length === 0) {
    pushError(ctx, `${path} 不能为空`)
    return undefined
  }
  if (value.length > maxChars) {
    pushError(ctx, `${path} 超出长度上限(${maxChars} 字符,实测 ${value.length})`)
    return undefined
  }
  return value
}

/** 可选字符串:缺省即 undefined(上游未提供不是错误),一旦给出必须合法 */
function takeOptionalString(ctx: Ctx, value: unknown, path: string, maxChars: number): string | undefined {
  if (value === undefined || value === null) return undefined
  return takeString(ctx, value, path, maxChars)
}

function takeOptionalBoolean(ctx: Ctx, value: unknown, path: string): boolean | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') {
    pushError(ctx, `${path} 必须是布尔值`)
    return undefined
  }
  return value
}

function takeBoundedNumber(ctx: Ctx, value: unknown, path: string, min: number, max: number, integer: boolean): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    pushError(ctx, `${path} 必须是有限数值`)
    return undefined
  }
  if (value < min || value > max) {
    pushError(ctx, `${path} 超出允许范围 [${min}, ${max}](实测 ${value})`)
    return undefined
  }
  if (integer && !Number.isInteger(value)) {
    pushError(ctx, `${path} 必须是整数`)
    return undefined
  }
  return value
}

function takeOptionalNumber(ctx: Ctx, value: unknown, path: string, min: number, max: number, integer = false): number | undefined {
  if (value === undefined || value === null) return undefined
  return takeBoundedNumber(ctx, value, path, min, max, integer)
}

function takeRequiredNumber(ctx: Ctx, value: unknown, path: string, min: number, max: number, integer = false): number | undefined {
  if (value === undefined || value === null) {
    pushError(ctx, `${path} 缺失`)
    return undefined
  }
  return takeBoundedNumber(ctx, value, path, min, max, integer)
}

function takeArray(ctx: Ctx, value: unknown, path: string, max: number): unknown[] | undefined {
  if (!Array.isArray(value)) {
    pushError(ctx, `${path} 必须是数组`)
    return undefined
  }
  if (value.length > max) {
    pushError(ctx, `${path} 超出容量上限(${max} 条,实测 ${value.length} 条)`)
    return undefined
  }
  return value
}

function takeEnum<T extends string>(ctx: Ctx, value: unknown, path: string, allowed: readonly T[]): T | undefined {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    pushError(ctx, `${path} 不是受支持取值(允许:${allowed.join(' / ')})`)
    return undefined
  }
  return value as T
}

function takeDate(ctx: Ctx, value: unknown, path: string): string | undefined {
  if (typeof value !== 'string') {
    pushError(ctx, `${path} 必须是 YYYY-MM-DD 字符串`)
    return undefined
  }
  if (!isRealDate(value)) {
    pushError(ctx, `${path} 不是真实日历日期(要求 YYYY-MM-DD,范围 2000-01-01..2100-12-31)`)
    return undefined
  }
  return value
}

function takeInstant(ctx: Ctx, value: unknown, path: string): string | undefined {
  if (typeof value !== 'string' || !isIsoInstant(value)) {
    pushError(ctx, `${path} 必须是可解析的 ISO 时间戳(含日期与时分秒)`)
    return undefined
  }
  return value
}

function takeAsOf(ctx: Ctx, value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined
  const asOf = takeString(ctx, value, path, ITINERARY_HTML_LIMITS.asOfChars)
  if (asOf !== undefined && !isRealDate(asOf)) {
    pushError(ctx, `${path} 必须是真实日历日期 YYYY-MM-DD`)
    return undefined
  }
  return asOf
}

// ---------------------------------------------------------------------------
// 事实校验(BookableFact 输入侧运行时收窄;未知 schema/kind 显式失败)
// ---------------------------------------------------------------------------

/** 上游给不出可判定的 plan:`runtime.is_plan` 只作可选展示,渲染器不据它升级任何结论 */
interface PolicyRuntime {
  is_plan?: boolean
}

function takePolicyRuntime(ctx: Ctx, value: unknown, path: string): PolicyRuntime {
  if (value === undefined || value === null) return {}
  if (!isRecord(value)) {
    pushError(ctx, `${path} 必须是对象`)
    return {}
  }
  if (Object.keys(value).length > ITINERARY_HTML_LIMITS.policyRuntimeFields) {
    pushError(ctx, `${path} 字段数超出上限(${ITINERARY_HTML_LIMITS.policyRuntimeFields})`)
    return {}
  }
  const out: PolicyRuntime = {}
  const isPlan = takeOptionalBoolean(ctx, value.is_plan, `${path}.is_plan`)
  if (isPlan !== undefined) out.is_plan = isPlan
  return out
}

interface NormalizedFlight { kind: 'flight' | 'train'; fact: FlightFact }
interface NormalizedHotel { kind: 'hotel'; fact: HotelFact }
interface NormalizedPolicy { kind: 'policy'; fact: PolicyFact; runtime: PolicyRuntime }
type NormalizedFact = NormalizedFlight | NormalizedHotel | NormalizedPolicy

/** 占位值只用于「校验失败时仍把已知字段填进对象」,任何返回 ok:true 的路径下 errors 必为空 */
const UNKNOWN_TIER: EvidenceTier = 'route_exists'

function normalizeFlight(ctx: Ctx, rec: Record<string, unknown>, kind: 'flight' | 'train', path: string): NormalizedFlight {
  const L = ITINERARY_HTML_LIMITS
  const route = isRecord(rec.route) ? rec.route : undefined
  if (!route) pushError(ctx, `${path}.route 必须是对象 {origin, destination}`)
  const factId = takeString(ctx, rec.fact_id, `${path}.fact_id`, L.factIdChars)
  const origin = takeString(ctx, route?.origin, `${path}.route.origin`, L.fromToChars)
  const destination = takeString(ctx, route?.destination, `${path}.route.destination`, L.fromToChars)
  const date = takeDate(ctx, rec.date, `${path}.date`)
  const bookability = takeEnum(ctx, rec.bookability, `${path}.bookability`, BOOKABILITIES)
  const tier = takeEnum(ctx, rec.tier, `${path}.tier`, TIERS)
  const source = takeString(ctx, rec.source, `${path}.source`, L.sourceChars)
  const queryId = takeString(ctx, rec.query_id, `${path}.query_id`, L.queryIdChars)
  const fetchedAt = takeInstant(ctx, rec.fetched_at, `${path}.fetched_at`)
  const asOf = takeAsOf(ctx, rec.as_of, `${path}.as_of`)
  // 负事实(该档期 0 条)允许空班次号;其余可下单性必须给出班次号
  const flightNo = typeof rec.flight_no === 'string' && rec.flight_no.length === 0
    ? ''
    : takeString(ctx, rec.flight_no, `${path}.flight_no`, L.flightNoChars)
  if (bookability !== undefined && bookability !== 'unavailable_exact_date' && flightNo === '') {
    pushError(ctx, `${path}.flight_no 缺失:非「该档期无结果」的事实必须给出班次号`)
  }
  const depLocal = takeOptionalString(ctx, rec.dep_local, `${path}.dep_local`, L.codeChars)
  const arrLocal = takeOptionalString(ctx, rec.arr_local, `${path}.arr_local`, L.codeChars)
  if (depLocal !== undefined && !HM_RE.test(depLocal)) pushError(ctx, `${path}.dep_local 必须是 HH:MM(24 小时制)`)
  if (arrLocal !== undefined && !HM_RE.test(arrLocal)) pushError(ctx, `${path}.arr_local 必须是 HH:MM(24 小时制)`)
  const reviewBy = takeAsOf(ctx, rec.review_by, `${path}.review_by`)
  const fact: FlightFact = {
    schema: 'gotry_bookable_fact.v1',
    fact_id: factId ?? '',
    kind,
    route: { origin: origin ?? '', destination: destination ?? '', origin_airport: takeOptionalString(ctx, route?.origin_airport, `${path}.route.origin_airport`, L.codeChars), dest_airport: takeOptionalString(ctx, route?.dest_airport, `${path}.route.dest_airport`, L.codeChars) },
    date: date ?? '',
    flight_no: flightNo ?? '',
    marketing_carrier: takeOptionalString(ctx, rec.marketing_carrier, `${path}.marketing_carrier`, L.carrierChars),
    operating_carrier: takeOptionalString(ctx, rec.operating_carrier, `${path}.operating_carrier`, L.carrierChars),
    dep_local: depLocal,
    arr_local: arrLocal,
    nonstop: takeOptionalBoolean(ctx, rec.nonstop, `${path}.nonstop`),
    price: takeOptionalNumber(ctx, rec.price, `${path}.price`, 0, L.priceMax),
    currency: takeOptionalString(ctx, rec.currency, `${path}.currency`, L.currencyChars),
    baggage_included: takeOptionalBoolean(ctx, rec.baggage_included, `${path}.baggage_included`),
    protected_connection: takeOptionalBoolean(ctx, rec.protected_connection, `${path}.protected_connection`),
    tier: tier ?? UNKNOWN_TIER,
    bookability: bookability ?? 'unverified',
    source: source ?? '',
    query_id: queryId ?? '',
    fetched_at: fetchedAt ?? '',
    as_of: asOf ?? '',
    review_by: reviewBy,
  }
  return { kind, fact }
}

function normalizeHotel(ctx: Ctx, rec: Record<string, unknown>, path: string): NormalizedHotel {
  const L = ITINERARY_HTML_LIMITS
  const fact: HotelFact = {
    schema: 'gotry_bookable_fact.v1',
    fact_id: takeString(ctx, rec.fact_id, `${path}.fact_id`, L.factIdChars) ?? '',
    kind: 'hotel',
    destination: takeString(ctx, rec.destination, `${path}.destination`, L.placeChars) ?? '',
    check_in: rec.check_in === undefined || rec.check_in === null ? undefined : takeDate(ctx, rec.check_in, `${path}.check_in`),
    check_out: rec.check_out === undefined || rec.check_out === null ? undefined : takeDate(ctx, rec.check_out, `${path}.check_out`),
    verdict: takeEnum(ctx, rec.verdict, `${path}.verdict`, ['hit', 'miss'] as const) ?? 'miss',
    bookability: takeEnum(ctx, rec.bookability, `${path}.bookability`, BOOKABILITIES) ?? 'unverified',
    options_masked: takeRequiredNumber(ctx, rec.options_masked, `${path}.options_masked`, 0, L.optionsMax, true) ?? 0,
    source: takeString(ctx, rec.source, `${path}.source`, L.sourceChars) ?? '',
    query_id: takeString(ctx, rec.query_id, `${path}.query_id`, L.queryIdChars) ?? '',
    fetched_at: takeInstant(ctx, rec.fetched_at, `${path}.fetched_at`) ?? '',
    as_of: takeAsOf(ctx, rec.as_of, `${path}.as_of`) ?? '',
    tier: takeEnum(ctx, rec.tier, `${path}.tier`, TIERS) ?? UNKNOWN_TIER,
  }
  return { kind: 'hotel', fact }
}

function normalizePolicy(ctx: Ctx, rec: Record<string, unknown>, path: string): NormalizedPolicy {
  const L = ITINERARY_HTML_LIMITS
  const fact: PolicyFact = {
    schema: 'gotry_bookable_fact.v1',
    fact_id: takeString(ctx, rec.fact_id, `${path}.fact_id`, L.factIdChars) ?? '',
    kind: 'policy',
    subject: takeString(ctx, rec.subject, `${path}.subject`, L.subjectChars) ?? '',
    statement: takeString(ctx, rec.statement, `${path}.statement`, L.statementChars) ?? '',
    source: takeString(ctx, rec.source, `${path}.source`, L.sourceChars) ?? '',
    query_id: takeString(ctx, rec.query_id, `${path}.query_id`, L.queryIdChars) ?? '',
    fetched_at: takeInstant(ctx, rec.fetched_at, `${path}.fetched_at`) ?? '',
    as_of: takeAsOf(ctx, rec.as_of, `${path}.as_of`) ?? '',
    review_by: takeAsOf(ctx, rec.review_by, `${path}.review_by`),
  }
  return { kind: 'policy', fact, runtime: takePolicyRuntime(ctx, rec.runtime, `${path}.runtime`) }
}

function normalizeFact(ctx: Ctx, value: unknown, index: number): NormalizedFact | undefined {
  const path = `facts[${index}]`
  if (!isRecord(value)) {
    pushError(ctx, `${path} 必须是对象`)
    return undefined
  }
  if (value.schema !== 'gotry_bookable_fact.v1') {
    pushError(ctx, `${path}.schema 不是受支持的事实 schema(gotry_bookable_fact.v1)`)
    return undefined
  }
  if (value.kind === 'flight' || value.kind === 'train') return normalizeFlight(ctx, value, value.kind, path)
  if (value.kind === 'hotel') return normalizeHotel(ctx, value, path)
  if (value.kind === 'policy') return normalizePolicy(ctx, value, path)
  pushError(ctx, `${path}.kind 不是受支持的事实类型(允许:flight / train / hotel / policy)`)
  return undefined
}

// ---------------------------------------------------------------------------
// 行程结构校验
// ---------------------------------------------------------------------------

interface NormalizedStay { place: string; check_in: string; check_out: string }
interface NormalizedSegment { from: string; to: string; date: string; mode: 'flight' | 'rail' | 'car'; legs: number }
interface NormalizedItinerary {
  trip_start: string
  trip_end: string
  stays: NormalizedStay[]
  od_segments: NormalizedSegment[]
}

function normalizeStay(ctx: Ctx, value: unknown, index: number): NormalizedStay | undefined {
  const path = `itinerary.stays[${index}]`
  if (!isRecord(value)) {
    pushError(ctx, `${path} 必须是对象`)
    return undefined
  }
  const L = ITINERARY_HTML_LIMITS
  const place = takeString(ctx, value.place, `${path}.place`, L.placeChars)
  const checkIn = takeDate(ctx, value.check_in, `${path}.check_in`)
  const checkOut = takeDate(ctx, value.check_out, `${path}.check_out`)
  if (place === undefined || checkIn === undefined || checkOut === undefined) return undefined
  if (checkOut <= checkIn) {
    pushError(ctx, `${path} 退房日期不晚于入住日期(${checkIn}→${checkOut}):不做夜数推算,显式失败`)
    return undefined
  }
  return { place, check_in: checkIn, check_out: checkOut }
}

function normalizeSegment(ctx: Ctx, value: unknown, index: number): NormalizedSegment | undefined {
  const path = `itinerary.od_segments[${index}]`
  if (!isRecord(value)) {
    pushError(ctx, `${path} 必须是对象`)
    return undefined
  }
  const L = ITINERARY_HTML_LIMITS
  const from = takeString(ctx, value.from, `${path}.from`, L.fromToChars)
  const to = takeString(ctx, value.to, `${path}.to`, L.fromToChars)
  const date = takeDate(ctx, value.date, `${path}.date`)
  const mode = takeEnum(ctx, value.mode, `${path}.mode`, MODES)
  const legs = takeRequiredNumber(ctx, value.legs, `${path}.legs`, 1, L.legsMax, true)
  if (from === undefined || to === undefined || date === undefined || mode === undefined || legs === undefined) return undefined
  return { from, to, date, mode, legs }
}

function normalizeItinerary(ctx: Ctx, value: unknown): NormalizedItinerary | undefined {
  if (!isRecord(value)) {
    pushError(ctx, 'itinerary 必须是对象 {trip_start, trip_end, stays, od_segments}')
    return undefined
  }
  const L = ITINERARY_HTML_LIMITS
  const tripStart = takeDate(ctx, value.trip_start, 'itinerary.trip_start')
  const tripEnd = takeDate(ctx, value.trip_end, 'itinerary.trip_end')
  const staysRaw = takeArray(ctx, value.stays, 'itinerary.stays', L.stays)
  const segsRaw = takeArray(ctx, value.od_segments, 'itinerary.od_segments', L.odSegments)
  const stays: NormalizedStay[] = []
  for (const [i, raw] of (staysRaw ?? []).entries()) {
    const stay = normalizeStay(ctx, raw, i)
    if (stay) stays.push(stay)
  }
  const odSegments: NormalizedSegment[] = []
  for (const [i, raw] of (segsRaw ?? []).entries()) {
    const segment = normalizeSegment(ctx, raw, i)
    if (segment) odSegments.push(segment)
  }
  if (tripStart === undefined || tripEnd === undefined) return undefined
  if (tripEnd < tripStart) {
    pushError(ctx, `itinerary.trip_end 早于 trip_start(${tripStart}→${tripEnd}):不做日期改写,显式失败`)
    return undefined
  }
  return { trip_start: tripStart, trip_end: tripEnd, stays, od_segments: odSegments }
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  let out = ''
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0
    // 控制字符(含 NUL/ESC)一律丢弃:既不进正文也不进属性
    if (code < 0x20 || code === 0x7f) continue
    switch (ch) {
      case '&': out += '&amp;'; break
      case '<': out += '&lt;'; break
      case '>': out += '&gt;'; break
      case '"': out += '&quot;'; break
      case "'": out += '&#39;'; break
      default: out += ch
    }
  }
  return out
}

const MODE_LABEL: Record<NormalizedSegment['mode'], string> = { flight: '航班', rail: '铁路', car: '地面' }

const TIER_LABEL: Record<EvidenceTier, string> = {
  live_inventory: 'exact-date 实时在架',
  route_exists: '仅航线存在',
  historical_schedule: '历史/旧航季班期',
  benchmark_price: '历史促销价 benchmark',
}

const BOOKABILITY_LABEL: Record<Bookability, string> = {
  bookable_exact_date: '该档期可下单',
  unavailable_exact_date: '该档期无结果',
  unverified: '未核验',
  conflict: '两源冲突',
}

const CSS = `:root{color-scheme:light dark;--bg:#fff;--fg:#16181d;--muted:#5b6470;--line:#d8dee6;--card:#f7f9fc;--accent:#11487d;--warn:#8a4b00;--bad:#8a1f1f;--ok:#14532d}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans CJK SC","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;word-break:break-word}
a{color:var(--accent)}
.skip{position:absolute;left:-9999px;top:0;background:var(--bg);padding:.5rem 1rem;border:1px solid var(--line)}
.skip:focus{left:.5rem;z-index:9}
.wrap{max-width:64rem;margin:0 auto;padding:1rem}
header.doc{border-bottom:1px solid var(--line);padding-bottom:.75rem}
h1{font-size:1.5rem;margin:.25rem 0}
h2{font-size:1.15rem;margin:0 0 .5rem}
h3{font-size:1rem;margin:.9rem 0 .4rem}
h4{font-size:.95rem;margin:.6rem 0 .3rem}
.muted{color:var(--muted);font-size:.9rem}
.notice{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--warn);padding:.6rem .8rem;margin:.75rem 0;border-radius:4px}
nav.toc{border:1px solid var(--line);border-radius:6px;padding:.6rem .8rem;margin:1rem 0;background:var(--card)}
nav.toc h2{font-size:1rem}
nav.toc ul{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:.35rem .9rem}
nav.toc ul ul{margin-left:.9rem;font-size:.92rem;display:block}
section{margin:1.75rem 0}
details{border:1px solid var(--line);border-radius:6px;background:var(--card);margin:.5rem 0}
details[open]{background:var(--bg)}
summary{cursor:pointer;padding:.55rem .75rem;font-weight:600}
summary:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.body{padding:0 .75rem .75rem;border-top:1px dashed var(--line)}
dl.fields{margin:.5rem 0 0;display:grid;grid-template-columns:auto 1fr;gap:.15rem .6rem}
dl.fields dt{color:var(--muted);font-size:.85rem}
dl.fields dd{margin:0;font-variant-numeric:tabular-nums}
.row{display:flex;flex-wrap:wrap;gap:.3rem .4rem;align-items:center;margin:.35rem 0}
.badge{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:.05rem .5rem;font-size:.78rem;background:var(--bg)}
.badge.ok{border-color:var(--ok);color:var(--ok)}
.badge.warn{border-color:var(--warn);color:var(--warn)}
.badge.bad{border-color:var(--bad);color:var(--bad)}
pre.canonical{white-space:pre-wrap;word-break:break-word;background:var(--card);border:1px solid var(--line);border-radius:4px;padding:.5rem .6rem;margin:.5rem 0;overflow-x:auto}
.fact{border:1px solid var(--line);border-radius:6px;padding:.6rem .7rem;margin:.5rem 0}
.planned{border-left:4px solid var(--accent)}
.missing{color:var(--warn)}
@media (max-width:480px){
body{font-size:15px}
.wrap{padding:.6rem}
dl.fields{grid-template-columns:1fr;gap:0}
dl.fields dt{margin-top:.35rem}
summary{padding:.6rem}
pre.canonical{font-size:.82rem}
}`

function fieldRow(label: string, value: string | undefined, missingNote = '未提供'): string {
  return value === undefined
    ? `<dt>${escapeHtml(label)}</dt><dd class="missing">${escapeHtml(missingNote)}</dd>`
    : `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`
}

function timeEl(date: string): string {
  return `<time datetime="${escapeHtml(date)}">${escapeHtml(date)}</time>`
}

function factIdSlug(id: string): string {
  return id.replace(/[^0-9a-zA-Z_-]/g, '').slice(0, 64) || 'x'
}

function factBadges(f: NormalizedFact): string {
  if (f.kind === 'policy') return `<span class="badge warn">政策事实(非可下单)</span>`
  const bookability = f.fact.bookability
  const cls = bookability === 'bookable_exact_date' ? 'ok' : bookability === 'unverified' ? 'bad' : 'warn'
  return `<span class="badge ${cls}">${escapeHtml(BOOKABILITY_LABEL[bookability] ?? bookability)}</span>`
    + `<span class="badge">证据层:${escapeHtml(TIER_LABEL[f.fact.tier] ?? f.fact.tier)}</span>`
}

function evidenceFields(f: NormalizedFact): string {
  const fact = f.fact
  const rows: string[] = [
    fieldRow('事实 id', fact.fact_id),
    fieldRow('来源 source', `[${fact.source}]`),
    fieldRow('查询 id', fact.query_id),
    fieldRow('取数时刻 fetched_at', fact.fetched_at),
    fieldRow('数据快照日 as_of', fact.as_of),
  ]
  if (f.kind !== 'policy') {
    rows.push(fieldRow('证据层 tier', `${f.fact.tier}(${TIER_LABEL[f.fact.tier] ?? '未知层'})`))
    rows.push(fieldRow('可下单性 bookability', `${f.fact.bookability}(${BOOKABILITY_LABEL[f.fact.bookability] ?? '未知态'})`))
  }
  const reviewBy = isRecord(fact) && typeof fact.review_by === 'string' ? fact.review_by : undefined
  if (reviewBy !== undefined) rows.push(fieldRow('复核截止 review_by', reviewBy))
  return `<dl class="fields">${rows.join('')}</dl>`
}

function canonicalLine(f: NormalizedFact): string {
  if (f.kind === 'hotel') return renderHotelFact(f.fact)
  if (f.kind === 'policy') return renderPolicyFact(f.fact)
  return renderFlightFact(f.fact)
}

function factTitle(f: NormalizedFact): string {
  if (f.kind === 'hotel') return `酒店库存事实:${f.fact.destination} ${f.fact.check_in ?? '未提供'}→${f.fact.check_out ?? '未提供'}`
  if (f.kind === 'policy') return `政策事实:${f.fact.subject}`
  const route = `${f.fact.route.origin}→${f.fact.route.destination}`
  const no = f.fact.flight_no ? ` ${f.fact.flight_no}` : ''
  return `${f.kind === 'train' ? '车次' : '航班'}事实:${route}${no} ${f.fact.date}`
}

function renderFact(f: NormalizedFact, id: string): string {
  let canonical = canonicalLine(f)
  if (f.kind === 'policy' && f.runtime.is_plan === true) {
    canonical += '\n注:该政策条目被标注为「计划」意图,不是查询结论,不得当作现行政策执行。'
  }
  // 目的地级档期库存 ≠ 某家酒店的可售房型/报价:命中事实必须显式降级陈述
  const destinationScopeNote = f.kind === 'hotel'
    ? `<p class="muted">本条是<strong>目的地 + 档期级</strong>库存结论(「${escapeHtml(f.fact.destination)}」该档期有多少家在架),不指明也不代表任何具体酒店有房或可订;价格上游打码时保持原样。</p>`
    : ''
  return `<details class="fact" id="${escapeHtml(id)}"><summary>${escapeHtml(factTitle(f))}</summary>`
    + `<div class="body"><div class="row">${factBadges(f)}</div>`
    + evidenceFields(f)
    + `<pre class="canonical">${escapeHtml(canonical)}</pre>`
    + destinationScopeNote
    + `</div></details>`
}

/**
 * 计划住宿卡:只陈述排期意图与指向独立证据的指针。
 * 酒店事实一律不在此卡内展开——避免「目的地级库存」被读成「这家住宿可订」。
 */
function renderPlannedStay(stay: NormalizedStay, id: string, related: NormalizedHotel[]): string {
  const pointer = related.length === 0
    ? `<p class="muted missing">该计划住宿没有对应的酒店档期事实:未核验,不得视为可订。</p>`
    : `<p class="muted">该目的地 + 该档期另有 ${related.length} 条<strong>独立记录</strong>的酒店库存事实(见下方「独立记录:目的地级酒店事实」)。那是对「目的地 + 档期」的检索结论,不是本条目这家酒店的房型/报价,也不代表它可订。</p>`
      + `<p class="muted">对应事实 id:${related.map(f => `<code>${escapeHtml(f.fact.fact_id)}</code>`).join('、')}</p>`
  return `<details id="${escapeHtml(id)}" class="planned"><summary>计划住宿:${escapeHtml(stay.place)} ${escapeHtml(stay.check_in)}→${escapeHtml(stay.check_out)}</summary><div class="body">`
    + `<div class="row"><span class="badge">计划(用户排期意图)</span><span class="badge warn">非预订、非可订声明</span></div>`
    + `<dl class="fields">${fieldRow('住宿地 place', stay.place)}${fieldRow('入住 check_in', stay.check_in)}${fieldRow('退房 check_out', stay.check_out)}</dl>`
    + pointer
    + `</div></details>`
}

/** 独立证据区:目的地级酒店事实与任何计划住宿分卡、分标题陈述 */
function renderHotelEvidenceSection(hotelFacts: NormalizedHotel[]): string {
  if (hotelFacts.length === 0) return '<p class="muted missing">本次输入没有酒店事实。</p>'
  return `<h3 id="hotel-evidence">独立记录:目的地级酒店事实</h3>`
    + `<p class="muted">以下事实由上游按「目的地 + 档期」检索落账,与上方任何一条计划住宿都不是同一件事;它们不指明具体酒店,也不构成「某家酒店有房/可订/报价」的声明。</p>`
    + hotelFacts.map(f => renderFact(f, `hotelfact-${factIdSlug(f.fact.fact_id)}`)).join('')
}

function renderSegment(seg: NormalizedSegment, id: string, related: NormalizedFact[]): string {
  const evidence = related.length === 0
    ? `<p class="muted missing">该段没有匹配的已注册事实:未核验,不得视为可下单方案。</p>`
    : `<h4>该段可回溯的事实(独立于计划段)</h4>${related.map(f => renderFact(f, `${id}-fact-${factIdSlug(f.fact.fact_id)}`)).join('')}`
  return `<details id="${escapeHtml(id)}"><summary>${escapeHtml(MODE_LABEL[seg.mode])} ${escapeHtml(seg.from)} → ${escapeHtml(seg.to)} ${escapeHtml(seg.date)}</summary><div class="body">`
    + `<div class="row"><span class="badge">计划(用户排期意图)</span><span class="badge warn">非可订声明</span></div>`
    + `<dl class="fields">${fieldRow('出发 from', seg.from)}${fieldRow('到达 to', seg.to)}${fieldRow('出发日期 date', seg.date)}`
    + `${fieldRow('运输方式 mode', `${seg.mode}(${MODE_LABEL[seg.mode]})`)}${fieldRow('航段/乘次 legs', String(seg.legs))}</dl>`
    + evidence
    + `</div></details>`
}

/** route+date 完全匹配的事实(负事实必须保留,否则用户看不到「该档期 0 条」) */
function routeFactsFor(facts: NormalizedFact[], seg: NormalizedSegment): NormalizedFact[] {
  return facts.filter(f => {
    if (f.kind === 'policy' || f.kind === 'hotel') return false
    return f.fact.date === seg.date && f.fact.route.origin === seg.from && f.fact.route.destination === seg.to
  })
}

interface RenderInput {
  title: string
  itinerary: NormalizedItinerary
  facts: NormalizedFact[]
}

function render(input: RenderInput): string {
  const { title, itinerary, facts } = input
  const stays = itinerary.stays
  const segs = itinerary.od_segments
  const hotelFacts = facts.filter((f): f is NormalizedHotel => f.kind === 'hotel')
  const policyFacts = facts.filter((f): f is NormalizedPolicy => f.kind === 'policy')
  const flightFacts = facts.filter((f): f is NormalizedFlight => f.kind === 'flight' || f.kind === 'train')
  const usedFactIds = new Set<string>()

  const stayBlocks = stays.map((stay, i) => {
    const related = hotelFacts.filter(f => f.fact.destination === stay.place)
    for (const f of related) usedFactIds.add(f.fact.fact_id)
    return renderPlannedStay(stay, `stay-${i + 1}`, related)
  })
  const segBlocks = segs.map((seg, i) => {
    const related = routeFactsFor(facts, seg)
    for (const f of related) usedFactIds.add(f.fact.fact_id)
    return renderSegment(seg, `seg-${i + 1}`, related)
  })

  const stayDateItems = stays.filter((s, i) => stays.findIndex(x => x.check_in === s.check_in) === i)
    .map(s => `<li>${timeEl(s.check_in)} — <a href="#stay-${stays.indexOf(s) + 1}">计划住宿 ${escapeHtml(s.place)}</a></li>`)
    .join('')
  const segDateItems = [...new Set(segs.map(s => s.date))].sort()
    .map(d => `<li>${timeEl(d)} — <a href="#segments">交通段</a></li>`)
    .join('')

  const dateItems = [
    ...stays.map((s, i) => ({ date: s.check_in, label: `入住 ${s.place}`, anchor: `#stay-${i + 1}` })),
    ...segs.map((s, i) => ({ date: s.date, label: `${MODE_LABEL[s.mode]} ${s.from}→${s.to}`, anchor: `#seg-${i + 1}` })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label))
  const dateList = dateItems.length === 0
    ? `<p class="muted missing">没有显式日期条目:行程为空,不合成日历日。</p>`
    : `<ul>${dateItems.map(item => `<li>${timeEl(item.date)} — <a href="${escapeHtml(item.anchor)}">${escapeHtml(item.label)}</a></li>`).join('')}</ul>`

  const leftovers = facts.filter(f => !usedFactIds.has(f.fact.fact_id))
  const leftoverBlock = leftovers.length === 0
    ? `<p class="muted">没有未被计划条目匹配的额外事实。</p>`
    : `<h3>未被计划条目匹配的事实</h3><p class="muted">这些事实来自注册表,但计划里没有对应的显式段/住宿地。列出不代表计划采用,也不升级为可下单。</p>`
      + leftovers.map(f => renderFact(f, `unmatched-${factIdSlug(f.fact.fact_id)}`)).join('')

  const hotelNote = hotelFacts.length > 0
    ? `<p class="muted">酒店的授权结论只落在下方「独立记录」区;来源只记录在架家数,价格上游打码。计划住宿卡片不承载任何酒店可订结论。</p>`
    : ''
  const policyNote = policyFacts.length > 0
    ? `<p class="muted">政策事实恒为「截至 as_of 的现行政策」表述,永不带无条件确认;远期出行须按 review_by 复核。${policyFacts.some(f => f.runtime.is_plan === true) ? '其中标注「计划」的条目只是意图,不是查询结论。' : ''}</p>`
    : ''

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
<a class="skip" href="#main">跳到主要内容</a>
<div class="wrap">
<header class="doc">
<h1>${escapeHtml(title)}</h1>
<p>行程 ${timeEl(itinerary.trip_start)} → ${timeEl(itinerary.trip_end)}</p>
<p class="muted">计划面(明示日期与段落)与证据面(已注册事实)分开陈述。除逐条事实自带的可下单性标注外,本文档不给出整体「已验证」结论。</p>
</header>
<main id="main">
<div class="notice"><strong>证据边界:</strong>本页只投影调用方给出的显式行程与已注册事实;不做夜数/预算/时间运算,不查询上游,不生成预订断言。缺失数据一律标注为缺失,不补默认值。</div>
<nav class="toc" aria-label="行程导航">
<h2>导航</h2>
<ul>
<li><a href="#dates">按日期</a><ul>${dateList.startsWith('<p') ? '<li class="muted">无</li>' : ''}</ul></li>
<li><a href="#segments">航班/交通段</a><ul>${segDateItems || '<li class="muted">无</li>'}</ul></li>
<li><a href="#stays">住宿</a><ul>${stayDateItems || '<li class="muted">无</li>'}</ul></li>
<li><a href="#facts">事实与证据</a></li>
</ul>
</nav>
<section id="dates"><h2>按日期行程</h2>
${dateList}
</section>
<section id="segments"><h2>航班/交通段</h2>
<p class="muted">下列条目是计划段(用户排期意图);每段内另列可回溯到该 route + date 的已注册事实。计划段不因存在事实而变成可下单。</p>
${segBlocks.join('') || '<p class="muted missing">没有显式交通段。</p>'}
</section>
<section id="stays"><h2>住宿</h2>
${hotelNote}
${stayBlocks.join('') || '<p class="muted missing">没有显式住宿段。</p>'}
${renderHotelEvidenceSection(hotelFacts)}
</section>
<section id="facts"><h2>事实与证据</h2>
<p class="muted">共 ${facts.length} 条事实(航班/车次 ${flightFacts.length},酒店 ${hotelFacts.length},政策 ${policyFacts.length})。逐条保留来源、查询 id、取数时点与数据快照日;缺失项标注缺失。</p>
${policyFacts.map(f => renderFact(f, `policy-${factIdSlug(f.fact.fact_id)}`)).join('')}
${policyNote}
${leftoverBlock}
<h3>全部航班/车次事实(含负事实与冲突)</h3>
${flightFacts.map(f => renderFact(f, `flight-${factIdSlug(f.fact.fact_id)}`)).join('') || '<p class="muted missing">本次输入没有航班/车次事实。</p>'}
</section>
</main>
</div>
</body>
</html>
`
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 纯渲染入口。`input` 是任意运行时数据:结构、枚举、真实日历日期、有限数值、
 * 容量与文档大小全部现场校验;任何一项不合法即返回 `ok:false` + 结构化 errors,
 * 绝不静默丢弃核心行程后仍返回「成功」。
 */
export function renderItineraryHtml(input: unknown): ItineraryHtmlResult {
  const ctx: Ctx = { errors: [], truncated: false }
  if (!isRecord(input)) return { ok: false, errors: ['input 必须是对象 {title, itinerary, facts}'] }
  const title = takeString(ctx, input.title, 'title', ITINERARY_HTML_LIMITS.titleChars)
  const itinerary = normalizeItinerary(ctx, input.itinerary)
  const factsRaw = takeArray(ctx, input.facts, 'facts', ITINERARY_HTML_LIMITS.facts)
  const facts: NormalizedFact[] = []
  for (const [i, raw] of (factsRaw ?? []).entries()) {
    const fact = normalizeFact(ctx, raw, i)
    if (fact) facts.push(fact)
  }
  if (title === undefined || itinerary === undefined || factsRaw === undefined || ctx.errors.length > 0) {
    const errors = ctx.errors.length > 0 ? [...ctx.errors] : ['输入无法渲染']
    if (ctx.truncated) errors.push(`错误条目已达上限 ${ITINERARY_HTML_LIMITS.errors} 条,其余未展示`)
    return { ok: false, errors }
  }
  const html = render({ title, itinerary, facts })
  // 输出大小硬上限:字符数×4 先粗筛,再精确计数;任一超限即整体失败
  if (html.length * BYTES_PER_CHAR_MAX > ITINERARY_HTML_LIMITS.docBytes || Buffer.byteLength(html, 'utf8') > ITINERARY_HTML_LIMITS.docBytes) {
    return { ok: false, errors: [`渲染文档超出大小上限 ${ITINERARY_HTML_LIMITS.docBytes} 字节:拒绝对核心行程做静默截断`] }
  }
  return { ok: true, html }
}
