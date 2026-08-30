/**
 * 可下单事实模型 gotry_bookable_fact.v1(issue #46,ADR-19)。
 *
 * 问题(2026-08-29 实测会话):exact-date 工具全部 miss 后,LLM 用航线页当日班期
 * (2026 快照)填充 2027 行程,航班号/时刻/机场/价格以「✓/推荐」确定性语气手写进
 * 产物——「错误但看起来已验证」比 unknown 更危险。
 *
 * 本层职责(纯函数,零 I/O——持久化见 capabilities/fact-log.ts):
 *   1. 结构化事实 schema:route/exact local date/时刻/航班号/营销与实际承运(分开)/
 *      机场/直飞或中转/价格/币种/source/query_id/fetched_at/as_of/confidence/bookability;
 *   2. 证据分层永不合并:live_inventory(exact-date 命中)/ route_exists(只验证航线)/
 *      historical_schedule(旧航季)/ benchmark_price(历史促销价)——miss 落「负事实」,
 *      exact-date 无库存 ≠ 可用历史填充;
 *   3. 判定原语:航班 claim 可述性(fail closed)/ 同日衔接硬约束 / 行程统计不变量
 *      (酒店夜+机上夜/O&D 段数/flight legs/预算自洽)/ 回头路检测;
 *   4. 确定性渲染:航班行/政策行只从结构化对象生成,政策恒带 as_of + 复核日期,
 *      分票永不称「联程」(protected_connection=true 才允许)。
 *
 * 渲染闸(从 markdown 反向核验)在 artifact-gate.ts。
 */

import { createHash } from 'node:crypto'

export const BOOKABLE_FACT_SCHEMA = 'gotry_bookable_fact.v1' as const

/** 证据分层:四层永不合并(issue #46 根因②——skeleton/historical/live 被混写) */
export type EvidenceTier =
  | 'live_inventory'      // exact-date 实时库存命中(唯一可下单层)
  | 'route_exists'        // 只验证了「航线存在」(骨架/航线页),不得升级为「该日期有该航班」
  | 'historical_schedule' // 历史/旧航季班期,只作参考叙述
  | 'benchmark_price'     // 历史促销价,只作 benchmark,不进预算下限

/** 可下单状态:fail-closed 四态 */
export type Bookability =
  | 'bookable_exact_date'      // exact-date 源返回,可下单
  | 'unavailable_exact_date'   // exact-date 源正常返回 0 条(负事实)
  | 'unverified'               // 未经 exact-date 核验
  | 'conflict'                 // 两源冲突,不得给 ✓

export interface FlightFact {
  schema: typeof BOOKABLE_FACT_SCHEMA
  /** 语义派生 id:sha(route|date|flight_no|query_id)——同查询重放幂等 */
  fact_id: string
  kind: 'flight' | 'train'
  route: { origin: string; destination: string; origin_airport?: string; dest_airport?: string }
  /** 出发地当地日期 YYYY-MM-DD(exact local date) */
  date: string
  /** 营销航班号(如 CZ8582);负事实为空串 */
  flight_no: string
  /** 营销承运与实际承运分开保存(codeshare 必须两者同输出) */
  marketing_carrier?: string
  operating_carrier?: string
  dep_local?: string // HH:MM
  arr_local?: string // HH:MM
  nonstop?: boolean
  price?: number
  currency?: string
  baggage_included?: boolean
  /** 仅当同票联程(同一票号/行李直挂/误机保护)为 true;两段接得上 ≠ 联程 */
  protected_connection?: boolean
  tier: EvidenceTier
  bookability: Bookability
  /** 数据源标识(flyai / session:ctrip-flight / …) */
  source: string
  /** 可重放查询 id(如 flyai:flight:HKG-HKT:2027-07-17) */
  query_id: string
  /** 取数时刻 ISO */
  fetched_at: string
  /** 数据快照日(证据 as_of) */
  as_of: string
  /** 下次复核截止(远期班期/政策必带) */
  review_by?: string
}

/** 动态政策事实:签证/免签/入境申报只允许「截至 as_of 的现行政策」表述 */
export interface PolicyFact {
  schema: typeof BOOKABLE_FACT_SCHEMA
  fact_id: string
  kind: 'policy'
  /** 政策对象(如 泰国免签 / 迪拜入境) */
  subject: string
  /** 政策内容陈述(不带时间无条件断言) */
  statement: string
  source: string
  query_id: string
  fetched_at: string
  as_of: string
  /** 复核 gate(通常 D-30/D-7) */
  review_by?: string
}

export type BookableFact = FlightFact | PolicyFact

// ---------------------------------------------------------------------------
// id 与查询词(可重放:query_id 即重放凭证)
// ---------------------------------------------------------------------------

function sha16(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

export function makeQueryId(source: string, kind: string, origin: string, destination: string, date: string): string {
  return `${source}:${kind}:${origin}-${destination}:${date}`
}

export function makeFactId(parts: Array<string | undefined>): string {
  return sha16(parts.map(p => p ?? '').join('|'))
}

/** 城市→IATA 词表(data/airline-airports.json city_alias);转换时把 route 归一到 IATA 空间 */
export type CityAlias = Record<string, string>

function iataOf(alias: CityAlias | undefined, city: string): string {
  return alias?.[city] ?? city
}

// ---------------------------------------------------------------------------
// 工具结果 → 事实(转换器):hit 落正事实,miss 落负事实,error 不落(无结论)
// ---------------------------------------------------------------------------

/** flyai 机/火结果形状(capabilities/flyai.ts FlyaiOption 的输入侧最小面) */
export interface FlyaiLikeOption {
  no?: string
  name?: string
  depDateTime?: string
  arrDateTime?: string
  depStation?: string
  arrStation?: string
  price?: number
  priceRaw?: string
  /** 直达/中转;缺省视为直达(单段条目),中转条目必须显式 false */
  nonstop?: boolean
}

export interface FlyaiLikeResult {
  verdict: 'hit' | 'miss' | 'error'
  options?: FlyaiLikeOption[]
  evidence?: string
}

/** 会话检索(携程)结果形状(session-search.ts 最小面) */
export interface SessionLikeOption {
  flightNo?: string
  airline?: string
  depDateTime?: string
  arrDateTime?: string
  depAirport?: string
  arrAirport?: string
  price?: number
}

export interface SessionLikeResult {
  verdict: string
  options?: SessionLikeOption[]
}

const YMD = /^\d{4}-\d{2}-\d{2}$/

function hmOf(dateTime: string | undefined): string | undefined {
  const m = dateTime?.match(/T?(\d{2}:\d{2})/)
  return m?.[1]
}

function dateOf(dateTime: string | undefined, fallback: string): string {
  const m = dateTime?.match(/^(\d{4}-\d{2}-\d{2})/)
  return m?.[1] ?? fallback
}

/** exact-date miss → 负事实(route+date 级「当前不可售/无结果」记录,fail-closed 的另一半) */
export function negativeFact(queryId: string, kind: 'flight' | 'train', origin: string, destination: string, date: string, source: string, fetchedAt: string, alias?: CityAlias): FlightFact {
  return {
    schema: BOOKABLE_FACT_SCHEMA,
    fact_id: makeFactId(['neg', kind, iataOf(alias, origin), iataOf(alias, destination), date, queryId]),
    kind,
    route: { origin: iataOf(alias, origin), destination: iataOf(alias, destination) },
    date,
    flight_no: '',
    tier: 'live_inventory',
    bookability: 'unavailable_exact_date',
    source,
    query_id: queryId,
    fetched_at: fetchedAt,
    as_of: fetchedAt.slice(0, 10),
  }
}

/** flyai hit/miss → 事实列(error 不落事实——无结论不是证据) */
export function factsFromFlyai(q: { kind: 'flight' | 'train'; origin: string; destination: string; date: string }, r: FlyaiLikeResult, fetchedAt: string, alias?: CityAlias): FlightFact[] {
  const source = 'flyai'
  const queryId = makeQueryId(source, q.kind, q.origin, q.destination, q.date)
  const origin = iataOf(alias, q.origin)
  const destination = iataOf(alias, q.destination)
  if (r.verdict === 'error') return []
  if (r.verdict === 'miss') return [negativeFact(queryId, q.kind, q.origin, q.destination, q.date, source, fetchedAt, alias)]
  const facts: FlightFact[] = []
  for (const o of r.options ?? []) {
    if (!o.no || !o.depDateTime) continue
    const numeric = typeof o.price === 'number' && Number.isFinite(o.price) && o.price > 0 ? o.price : undefined
    facts.push({
      schema: BOOKABLE_FACT_SCHEMA,
      fact_id: makeFactId([q.kind, origin, destination, q.date, o.no, queryId]),
      kind: q.kind,
      route: { origin, destination, origin_airport: o.depStation, dest_airport: o.arrStation },
      date: dateOf(o.depDateTime, q.date),
      flight_no: o.no,
      marketing_carrier: o.name || undefined,
      operating_carrier: undefined, // flyai 上游只给营销承运;实际承运未知 ≠ 相同,留空不猜
      dep_local: hmOf(o.depDateTime),
      arr_local: hmOf(o.arrDateTime),
      nonstop: o.nonstop !== false,
      price: numeric,
      currency: numeric !== undefined ? 'CNY' : undefined,
      tier: 'live_inventory',
      bookability: 'bookable_exact_date',
      source,
      query_id: queryId,
      fetched_at: fetchedAt,
      as_of: fetchedAt.slice(0, 10),
    })
  }
  // hit 但解析后零有效条目 = 与 miss 同语义(无可用事实,落负事实)
  return facts.length > 0 ? facts : [negativeFact(queryId, q.kind, q.origin, q.destination, q.date, source, fetchedAt, alias)]
}

/** 会话检索 hit → 事实列(用户本人登录态来源,与 flyai 并列独立 source) */
export function factsFromSession(q: { origin: string; destination: string; date: string }, r: SessionLikeResult, fetchedAt: string, alias?: CityAlias): FlightFact[] {
  const source = 'session:ctrip-flight'
  const queryId = makeQueryId(source, 'flight', q.origin, q.destination, q.date)
  const origin = iataOf(alias, q.origin)
  const destination = iataOf(alias, q.destination)
  if (r.verdict !== 'hit') {
    // miss/cooldown/challenged/needs-login:仅「正常返回 0 条」是负事实;通道不可用不落事实
    return r.verdict === 'miss' ? [negativeFact(queryId, 'flight', q.origin, q.destination, q.date, source, fetchedAt, alias)] : []
  }
  const facts: FlightFact[] = []
  for (const o of r.options ?? []) {
    if (!o.flightNo || !o.depDateTime) continue
    const numeric = typeof o.price === 'number' && Number.isFinite(o.price) && o.price > 0 ? o.price : undefined
    facts.push({
      schema: BOOKABLE_FACT_SCHEMA,
      fact_id: makeFactId(['flight', origin, destination, q.date, o.flightNo, queryId]),
      kind: 'flight',
      route: { origin, destination, origin_airport: o.depAirport, dest_airport: o.arrAirport },
      date: dateOf(o.depDateTime, q.date),
      flight_no: o.flightNo,
      marketing_carrier: o.airline || undefined,
      operating_carrier: undefined,
      dep_local: hmOf(o.depDateTime),
      arr_local: hmOf(o.arrDateTime),
      nonstop: true,
      price: numeric,
      currency: numeric !== undefined ? 'CNY' : undefined,
      tier: 'live_inventory',
      bookability: 'bookable_exact_date',
      source,
      query_id: queryId,
      fetched_at: fetchedAt,
      as_of: fetchedAt.slice(0, 10),
    })
  }
  return facts
}

// ---------------------------------------------------------------------------
// 注册表(纯函数视图;持久化在 capabilities/fact-log.ts)
// ---------------------------------------------------------------------------

/** 同 fact_id 去重,保留 fetched_at 最新(重查覆盖旧快照,历史不丢——append-only 由持久层保证) */
export function dedupeFacts<T extends BookableFact>(facts: T[]): T[] {
  const byId = new Map<string, T>()
  for (const f of facts) {
    const prev = byId.get(f.fact_id)
    if (!prev || prev.fetched_at <= f.fetched_at) byId.set(f.fact_id, f)
  }
  return [...byId.values()].sort((a, b) => a.fetched_at.localeCompare(b.fetched_at) || a.fact_id.localeCompare(b.fact_id))
}

/** route+date 的最新查询结论(同日多次查询:最新一次为准,避免「昨天 miss 今天 hit」陈旧否定) */
export function latestFactsForRouteDate(facts: BookableFact[], origin: string, destination: string, date: string): FlightFact[] {
  const hits = facts.filter((f): f is FlightFact =>
    f.kind !== 'policy'
    && f.route.origin === origin && f.route.destination === destination && f.date === date)
  const latestQueryTs = new Map<string, string>()
  for (const f of hits) {
    const prev = latestQueryTs.get(f.query_id)
    if (!prev || prev < f.fetched_at) latestQueryTs.set(f.query_id, f.fetched_at)
  }
  const latestTs = [...latestQueryTs.values()].sort().pop()
  if (!latestTs) return []
  return hits.filter(f => f.fetched_at === latestTs)
}

// ---------------------------------------------------------------------------
// 判定原语①:航班 claim 可述性(fail closed)
// ---------------------------------------------------------------------------

export type FlightClaimVerdict =
  | 'traceable'          // 注册表内有 bookable_exact_date 的该航班事实
  | 'not_in_source'      // 该 route+date 查过 exact-date,结果里没有它——最强违例(填充历史/相邻日期)
  | 'route_unqueried'    // 该 route+date 从未查过 exact-date——无证据断言
  | 'contradicted'       // 注册表内有同号航班但事实字段冲突(时刻/机场)

export interface FlightClaim {
  flight_no: string
  origin?: string
  destination?: string
  date?: string
}

export function flightClaimVerdict(facts: BookableFact[], claim: FlightClaim): { verdict: FlightClaimVerdict; fact?: FlightFact; reason: string } {
  const no = claim.flight_no.toUpperCase().replace(/\s+/g, '')
  const sameNo = facts.filter((f): f is FlightFact =>
    f.kind !== 'policy' && f.flight_no.toUpperCase() === no && f.bookability === 'bookable_exact_date')
  const routeMatched = sameNo.filter(f =>
    (!claim.origin || f.route.origin === claim.origin || f.route.origin_airport === claim.origin)
    && (!claim.destination || f.route.destination === claim.destination || f.route.dest_airport === claim.destination)
    && (!claim.date || f.date === claim.date))
  if (routeMatched.length > 0) return { verdict: 'traceable', fact: routeMatched[0], reason: `回溯 ${routeMatched[0]!.query_id}` }
  // 无同号可下单事实:该 route+date 是否查过?
  if (claim.origin && claim.destination && claim.date) {
    const scoped = latestFactsForRouteDate(facts, claim.origin, claim.destination, claim.date)
    if (scoped.length > 0) {
      return {
        verdict: 'not_in_source',
        reason: scoped.some(f => f.bookability === 'unavailable_exact_date')
          ? `${claim.origin}→${claim.destination} ${claim.date} exact-date 源返回 0 条(${scoped[0]!.query_id})——不得用历史班期/相邻日期填充`
          : `${claim.origin}→${claim.destination} ${claim.date} exact-date 源在架 ${scoped.filter(f => f.bookability === 'bookable_exact_date').map(f => f.flight_no).join('/')}——无 ${no}`,
      }
    }
    return { verdict: 'route_unqueried', reason: `${claim.origin}→${claim.destination} ${claim.date} 从未经 exact-date 源核验` }
  }
  return { verdict: 'route_unqueried', reason: `航班 ${no} 无可回溯的 exact-date 事实(缺 route/date 上下文)` }
}

// ---------------------------------------------------------------------------
// 判定原语②:同日衔接硬约束(办事结束 → 门到机场 → 值机截止 → 起飞)
// ---------------------------------------------------------------------------

export interface SameDayDepartureConstraint {
  /** 当日地面事务最早结束(当地 HH:MM,如银行办事) */
  errand_end_local: string
  /** 事务地点→机场门到门分钟(含步行/等车) */
  airport_transit_min: number
  /** 起飞前值机/安检截止分钟(国际建议 120) */
  checkin_deadline_min: number
}

export interface SameDayDepartureVerdict {
  feasible: boolean
  /** 事务约束下的最早可接起飞时刻(当地 HH:MM) */
  earliest_departure_local: string
  /** exact-date 在架且满足硬约束的直飞 */
  feasible_flights: FlightFact[]
  /** 被约束排除的在架直飞(带排除原因) */
  excluded: Array<{ flight_no: string; reason: string }>
  /** 不可行时的结构化最小改动建议 */
  suggestions: string[]
}

function hmToMin(hm: string): number {
  const [h, m] = hm.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

function minToHm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
}

/**
 * 「上午办事 + 当天下午直飞」类核心衔接判定:
 * 最早起飞 = errand_end + 门到机场 + 值机截止;exact-date 在架直飞逐班过闸。
 * 在架为空的失败语义与「有班但接不上」分开陈述(前者是库存问题,后者是约束问题)。
 */
export function checkSameDayDeparture(
  facts: BookableFact[],
  q: { origin: string; destination: string; date: string },
  c: SameDayDepartureConstraint,
): SameDayDepartureVerdict {
  const earliest = hmToMin(c.errand_end_local) + c.airport_transit_min + c.checkin_deadline_min
  const scoped = latestFactsForRouteDate(facts, q.origin, q.destination, q.date)
  const nonstopBookable = scoped.filter(f => f.bookability === 'bookable_exact_date' && f.nonstop !== false)
  const feasible: FlightFact[] = []
  const excluded: Array<{ flight_no: string; reason: string }> = []
  for (const f of nonstopBookable) {
    const dep = f.dep_local ? hmToMin(f.dep_local) : null
    if (dep === null) {
      excluded.push({ flight_no: f.flight_no, reason: '缺起飞时刻,不参与衔接判定' })
    } else if (dep >= earliest) {
      feasible.push(f)
    } else {
      excluded.push({ flight_no: f.flight_no, reason: `${f.dep_local} 起飞早于最早可接时刻 ${minToHm(earliest)}(${c.errand_end_local} 结束事务 + ${c.airport_transit_min}m 到机场 + ${c.checkin_deadline_min}m 值机)` })
    }
  }
  const ok = feasible.length > 0
  const suggestions: string[] = []
  if (!ok) {
    const inStock = nonstopBookable.map(f => `${f.flight_no} ${f.dep_local ?? '?'}`).join('、')
    suggestions.push(`增加 1 个${q.origin}住宿夜:改乘次日早班${inStock ? `(当日在架:${inStock})` : ''}`)
    suggestions.push('或提前一天完成地面事务/提前一天出发,把同日衔接改为隔夜衔接')
  }
  return { feasible: ok, earliest_departure_local: minToHm(earliest), feasible_flights: feasible, excluded, suggestions }
}

// ---------------------------------------------------------------------------
// 判定原语③:行程统计不变量(机器断言,不许自然语言总结反算)
// ---------------------------------------------------------------------------

export interface ItineraryFacts {
  trip_start: string // YYYY-MM-DD
  trip_end: string   // YYYY-MM-DD(回到家的当地日期)
  stays: Array<{ place: string; check_in: string; check_out: string }>
  /** 机上夜(红眼跨夜)数 */
  onboard_nights: number
  /** O&D 段(用户视角段);flight 段含 legs 数(中转一段多 leg) */
  od_segments: Array<{ from: string; to: string; date: string; mode: 'flight' | 'rail' | 'car'; legs: number }>
  budget_items: Array<{ label: string; min_cny: number; max_cny: number }>
  /** 产物里的预算下限话术(「可压到 ¥N」) */
  claimed_floor_cny?: number
}

export interface InvariantViolation {
  kind: 'nights_inconsistent' | 'legs_inconsistent' | 'budget_floor_inconsistent' | 'date_order'
  detail: string
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)
}

export function itineraryInvariants(it: ItineraryFacts): InvariantViolation[] {
  const violations: InvariantViolation[] = []
  const totalNights = daysBetween(it.trip_start, it.trip_end)
  let hotelNights = 0
  for (const s of it.stays) {
    const n = daysBetween(s.check_in, s.check_out)
    if (n <= 0) violations.push({ kind: 'date_order', detail: `${s.place} 住宿 ${s.check_in}→${s.check_out} 晚数 ≤0` })
    else hotelNights += n
  }
  if (hotelNights + it.onboard_nights !== totalNights) {
    violations.push({
      kind: 'nights_inconsistent',
      detail: `酒店夜 ${hotelNights} + 机上夜 ${it.onboard_nights} = ${hotelNights + it.onboard_nights} ≠ 行程总夜数 ${totalNights}(${it.trip_start}→${it.trip_end})——夜数口径必须由结构化住宿反算,不许自然语言估算`,
    })
  }
  for (const seg of it.od_segments) {
    if (seg.mode === 'flight' && seg.legs < 1) {
      violations.push({ kind: 'legs_inconsistent', detail: `${seg.from}→${seg.to}(${seg.date})flight O&D 段 legs=${seg.legs}——每段至少 1 leg` })
    }
    if (seg.date < it.trip_start || seg.date > it.trip_end) {
      violations.push({ kind: 'date_order', detail: `${seg.from}→${seg.to} 日期 ${seg.date} 落在行程窗 ${it.trip_start}→${it.trip_end} 之外` })
    }
  }
  const minSum = it.budget_items.reduce((acc, b) => acc + b.min_cny, 0)
  if (it.claimed_floor_cny !== undefined && it.claimed_floor_cny < minSum) {
    violations.push({
      kind: 'budget_floor_inconsistent',
      detail: `预算分项最低合计 ¥${minSum.toLocaleString()} > 产物声称可压到 ¥${it.claimed_floor_cny.toLocaleString()}——下限话术不得低于分项最低合计`,
    })
  }
  return violations
}

// ---------------------------------------------------------------------------
// 判定原语④:回头路检测(A→B→A;存在 B→下一站直飞时给最小改动建议)
// ---------------------------------------------------------------------------

export interface BacktrackFinding {
  kind: 'backtrack'
  /** 回头路径,如 ['HKT','KBV','HKT'] */
  path: string[]
  /** 最小改动建议(存在 B→C 直飞边时) */
  suggestion?: string
}

export function detectBacktrack(stops: string[], nonstopEdges: ReadonlySet<string>): BacktrackFinding[] {
  const findings: BacktrackFinding[] = []
  for (let i = 0; i + 2 < stops.length; i++) {
    const a = stops[i]!, b = stops[i + 1]!, c = stops[i + 2]!
    if (a !== c) continue
    // A→B→A 回头;若 B→D(下一站)有直飞边,建议「去程后直接 B→D」
    const d = stops[i + 3]
    const suggestion = d && nonstopEdges.has(`${b}-${d}`)
      ? `${b}→${d} 有直飞:改为 ${a}→${b} 后直接 ${b}→${d},消除 ${a}→${b}→${a} 回头路`
      : undefined
    findings.push({ kind: 'backtrack', path: [a, b, c], suggestion })
  }
  return findings
}

// ---------------------------------------------------------------------------
// 确定性渲染:航班/政策行只从结构化对象生成(issue #46 期望①:禁止凭记忆抄写)
// ---------------------------------------------------------------------------

/** 远期复核默认 gate:出发前 30 天 */
export function defaultReviewBy(tripDate: string): string {
  const d = new Date(Date.parse(`${tripDate}T00:00:00Z`) - 30 * 86_400_000)
  return d.toISOString().slice(0, 10)
}

/**
 * 航班事实行。bookable_exact_date 才允许完整班次行;其余一律 fail-closed 措辞。
 * 永不输出无条件 ✓;证据链(source/query_id/fetched_at)随行必达。
 */
export function renderFlightFact(f: FlightFact): string {
  const route = `${f.route.origin}→${f.route.destination}`
  const evidence = `[${f.source}@${f.fetched_at} #${f.query_id}]`
  if (f.bookability === 'unavailable_exact_date') {
    const review = f.review_by ?? defaultReviewBy(f.date)
    return `- ${route} ${f.date}:**未确认/当前不可售**——exact-date 源 ${f.source} 于 ${f.fetched_at.slice(0, 10)} 返回 0 条;到 ${review} 复核,不得用历史班期/相邻日期填充 ${evidence}`
  }
  if (f.bookability !== 'bookable_exact_date') {
    return `- ${route} ${f.date} ${f.flight_no || ''}:**未核验**(${f.bookability})——仅作参考,不得作为可下单方案呈现 ${evidence}`
  }
  const carrier = f.operating_carrier && f.operating_carrier !== f.marketing_carrier
    ? `营销 ${f.marketing_carrier ?? '?'} / 实际承运 ${f.operating_carrier}`
    : (f.marketing_carrier ?? '')
  const times = f.dep_local && f.arr_local ? ` ${f.dep_local}→${f.arr_local}` : ''
  const nonstop = f.nonstop === false ? '(中转)' : ' 直飞'
  // 双机场城市防混淆:落点机场码与城市码不同时显式标注(FD 落 DMK / VZ 落 BKK 不互换)
  const airportNote = f.route.dest_airport && f.route.dest_airport !== f.route.destination
    ? `(落 ${f.route.dest_airport})`
    : ''
  const price = f.price !== undefined ? ` ¥${f.price}` : ' 价待询'
  const baggage = f.baggage_included === false ? ',不含托运行李' : ''
  return `- ${route} ${f.date} ${f.flight_no}${carrier ? `(${carrier})` : ''}${times}${nonstop}${airportNote}${price}${baggage} ${evidence}`
}

/**
 * 联程/分票连接行:只有同票保护(protected_connection=true)才允许称「联程」;
 * 分票必须显式标红自助转机风险(无行李直挂/误机无保护)。
 */
export function renderConnection(legA: FlightFact, legB: FlightFact): string {
  const through = legA.protected_connection === true && legB.protected_connection === true
  const head = `${legA.route.origin}→${legA.route.destination} ${legA.flight_no} + ${legB.route.origin}→${legB.route.destination} ${legB.flight_no}`
  return through
    ? `- ${head}:联程(同一票号/行李直挂/误机保护)`
    : `- ${head}:⚠️ **分票/自助转机**——两段接得上 ≠ 联程;无同一票号、行李需自取重挂、误机无保护,缓冲与风险自担`
}

/**
 * 政策事实行:恒为「截至 as_of 的现行政策」表述 + 复核 gate,永不用无条件 ✓。
 * 远期(出发日晚于 as_of)必须附 review_by(默认 D-30)。
 */
export function renderPolicyFact(p: PolicyFact, tripStart?: string): string {
  const review = p.review_by ?? (tripStart ? defaultReviewBy(tripStart) : undefined)
  const reviewNote = review ? `;远期政策须复核——到 ${review} 再核验一次` : ''
  return `- ${p.subject}:截至 ${p.as_of} 的现行政策——${p.statement}${reviewNote} [${p.source}@${p.fetched_at} #${p.query_id}]`
}

/** 从结构化行程渲染夜数口径行(机器反算,唯一口径) */
export function renderNightsLine(it: ItineraryFacts): string {
  const totalNights = daysBetween(it.trip_start, it.trip_end)
  const hotelNights = it.stays.reduce((acc, s) => acc + Math.max(0, daysBetween(s.check_in, s.check_out)), 0)
  const flightOd = it.od_segments.filter(s => s.mode === 'flight').length
  const flightLegs = it.od_segments.filter(s => s.mode === 'flight').reduce((acc, s) => acc + s.legs, 0)
  return `共 ${daysBetween(it.trip_start, it.trip_end) + 1} 天 ${totalNights} 晚 = ${hotelNights} 个酒店夜 + ${it.onboard_nights} 个机上夜;航班按 O&D ${flightOd} 段(共 ${flightLegs} 个 flight legs)`
}
