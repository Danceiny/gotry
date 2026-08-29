/**
 * 产物事实闸 gotry_artifact_gate.v1(issue #46,ADR-19)。
 *
 * 最终 artifact 里的每个可下单事实必须能回溯到注册表内的 exact-date 工具结果
 * (query_id 可重放);无法回溯 → 阻止以「已验证方案」输出。
 *
 * 工作方式:从 markdown 反向抽取 claim(航班号/承运直飞/通用直飞断言/机场映射/
 * 政策/✓ 语气/联程措辞),逐条对照事实注册表与航司机场映射表;行程级口径
 * (夜数/legs/预算下限)由结构化 itinerary 的不变量校验并入同一报告。
 * 抽取是保守的:抽不出上下文的 claim 按 route_unqueried 处理(更重,不更轻)——
 * fail closed,不放行「写得含糊所以查不到」的事实。
 *
 * 纯函数,零 I/O。映射表数据见 data/airline-airports.json(as_of 快照)。
 */

import {
  flightClaimVerdict,
  itineraryInvariants,
  latestFactsForRouteDate,
  type BookableFact,
  type FlightClaim,
  type FlightClaimVerdict,
  type ItineraryFacts,
} from './bookable-facts.ts'

export const ARTIFACT_GATE_SCHEMA = 'gotry_artifact_gate.v1' as const

// ---------------------------------------------------------------------------
// 映射表(data/airline-airports.json 的内存形状)
// ---------------------------------------------------------------------------

export interface AirlineAirportMap {
  meta: { as_of: string; review_by?: string; source?: string; note?: string }
  /** 中文城市名 → 主机场 IATA(航线上下文解析用,稳定词汇) */
  city_alias: Record<string, string>
  /** 双机场城市的航司→机场映射(冲突检测用,dated 快照):如 曼谷 { FD: DMK, VZ: BKK } */
  carrier_airport: Record<string, Record<string, string>>
}

// ---------------------------------------------------------------------------
// claim 抽取
// ---------------------------------------------------------------------------

export interface ExtractedFlightClaim extends FlightClaim {
  line: number
  text: string
  /** 承运级直飞断言(无航班号,如「8L 直飞」/「东航直飞」) */
  carrier_only?: string
}

export interface ExtractedPolicyClaim {
  line: number
  text: string
  has_as_of: boolean
}

export interface ExtractedAirportClaim {
  line: number
  text: string
  carriers: string[]
  airport: string
  city: string
}

export interface ExtractedClaims {
  flights: ExtractedFlightClaim[]
  policies: ExtractedPolicyClaim[]
  airports: ExtractedAirportClaim[]
  /** 含「直飞」断言且可解析航线的行(通用直飞规则:该日无任何在架直飞即违例) */
  direct_lines: Array<{ line: number; text: string; origin?: string; destination?: string; date?: string }>
}

/** 航班号:2 位承运码 + 3-4 位数字(UO784/EK328/MF1538/CZ8582/9C8781/FD597) */
const FLIGHT_NO = /(?<![A-Za-z0-9])([A-Z0-9]{2}\d{3,4})(?![\d])/g
/** 承运级直飞断言:「8L 直飞」「FZ 直飞香港」——无航班号的航线存在性断言 */
const CARRIER_DIRECT = /(?<![A-Za-z0-9])([A-Z0-9]{2})(?!\d)(?:\s|[一-龥]){0,6}直飞/g
/** 中文承运名 → 二字码(承运级断言覆盖;只列闸需要的常见出境承运) */
const CARRIER_ZH: Record<string, string> = {
  东航: 'MU', 南航: 'CZ', 国航: 'CA', 厦航: 'MF', 春秋: '9C', 祥鹏: '8L',
  亚航: 'FD', 越捷: 'VZ', 国泰: 'CX', 港航: 'HX', 香港快运: 'UO', 阿联酋: 'EK', 泰航: 'TG',
}
const POLICY_WORD = /免签|落地签|签证|入境申报|过境免/
/** as_of 必须是「截至 + 具体日期」——「现行 60 天」不算时间边界(issue #46 政策行) */
const AS_OF_WORD = /截至\s*\d{4}[-/年]\d{1,2}|as[_ ]?of\s*\d{4}/i
const CHECK_MARK = /[✓✅]/

/** 「直飞」断言(排除否定前置:无/不/没有/未见直飞;函数实现避开变宽 lookbehind 引擎差异) */
function hasDirectAssertion(line: string): boolean {
  const idx = line.indexOf('直飞')
  if (idx < 0) return false
  const before = line.slice(Math.max(0, idx - 3), idx)
  return !(before.endsWith('无') || before.endsWith('不') || before.endsWith('没有') || before.endsWith('未见'))
}

interface SectionCtx { origin?: string; destination?: string; date?: string }

/** 从文本(小节标题或行)解析航线上下文:箭头紧邻城市对(方向最可靠)优先,否则按出现位置取前两个;日期 M.D 或 MM-DD */
function routeCtxOf(text: string, map: AirlineAirportMap, defaultYear?: number): SectionCtx {
  const occ: Array<{ city: string; iata: string; pos: number }> = []
  for (const [city, iata] of Object.entries(map.city_alias)) {
    let pos = text.indexOf(city)
    while (pos >= 0) {
      occ.push({ city, iata, pos })
      pos = text.indexOf(city, pos + city.length)
    }
  }
  occ.sort((a, b) => a.pos - b.pos)
  const ctx: SectionCtx = {}
  // 「迪拜10:05→深圳」「迪拜 → 深圳」——两城市间有箭头即取方向(表格单元格顺序不可靠)
  outer: for (let i = 0; i < occ.length; i++) {
    for (let j = i + 1; j < occ.length; j++) {
      if (occ[j]!.iata === occ[i]!.iata) continue
      const between = text.slice(occ[i]!.pos + occ[i]!.city.length, occ[j]!.pos)
      if (/→|⇀|->/.test(between)) {
        ctx.origin = occ[i]!.iata
        ctx.destination = occ[j]!.iata
        break outer
      }
    }
  }
  if (!ctx.origin && occ.length >= 2) {
    ctx.origin = occ[0]!.iata
    ctx.destination = occ[1]!.iata
  }
  if (defaultYear) {
    const dm = text.match(/(?<!\d)(\d{1,2})\.(\d{1,2})(?!\d)/) ?? text.match(/(?<!\d)(\d{2})-(\d{2})(?!\d)/)
    if (dm) {
      const mm = Number(dm[1]), dd = Number(dm[2])
      if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
        ctx.date = `${defaultYear}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
      }
    }
  }
  return ctx
}

/**
 * 从 markdown 抽取全部可下单 claim。
 * 小节标题(### 段2｜香港→普吉(7.17 周六))为下方行提供 route/date 上下文;
 * 行内自带上下文优先。默认年份由 trip window 提供(远期行程的年份不含糊)。
 */
export function extractClaims(markdown: string, map: AirlineAirportMap, opts?: { trip_year?: number }): ExtractedClaims {
  const claims: ExtractedClaims = { flights: [], policies: [], airports: [], direct_lines: [] }
  const lines = markdown.split('\n')
  let section: SectionCtx = {}
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const lineNo = i + 1
    if (/^#{1,4}\s/.test(line)) {
      const ctx = routeCtxOf(line, map, opts?.trip_year)
      section = { origin: ctx.origin, destination: ctx.destination, date: ctx.date ?? section.date }
      continue
    }
    const own = routeCtxOf(line, map, opts?.trip_year)
    const origin = own.origin ?? section.origin
    const destination = own.destination ?? section.destination
    const date = own.date ?? section.date

    for (const m of line.matchAll(FLIGHT_NO)) {
      claims.flights.push({ line: lineNo, text: line.trim().slice(0, 120), flight_no: m[1]!.toUpperCase(), origin, destination, date })
    }
    for (const m of line.matchAll(CARRIER_DIRECT)) {
      const carrier = m[1]!.toUpperCase()
      // 纯数字(时刻尾数,如「21:35 直飞」的 35)不是承运码;已是航班号前缀的不重复记
      if (!/[A-Z]/.test(carrier)) continue
      if (new RegExp(`${carrier}\\d`).test(line)) continue
      claims.flights.push({ line: lineNo, text: line.trim().slice(0, 120), flight_no: '', carrier_only: carrier, origin, destination, date })
    }
    if (hasDirectAssertion(line) && (origin || destination)) {
      claims.direct_lines.push({ line: lineNo, text: line.trim().slice(0, 120), origin, destination, date })
      // 中文承运名直飞断言(「东航 南京→普吉(白天班)」无二字码,FLIGHT_NO/CARRIER_DIRECT 都漏);
      // 词首不得紧贴汉字——「国泰航空」里的「泰航」不是泰航
      for (const [zh, code] of Object.entries(CARRIER_ZH)) {
        if (new RegExp(`(?<![一-龥])${zh}`).test(line) && !new RegExp(`${code}\\d`).test(line) && !claims.flights.some(c => c.line === lineNo && c.carrier_only === code)) {
          claims.flights.push({ line: lineNo, text: line.trim().slice(0, 120), flight_no: '', carrier_only: code, origin, destination, date })
        }
      }
    }
    if (POLICY_WORD.test(line)) {
      claims.policies.push({ line: lineNo, text: line.trim().slice(0, 160), has_as_of: AS_OF_WORD.test(line) })
    }
    // 航司→机场映射 claim:同一行出现承运码 + 机场码,且该城是双机场映射面
    for (const [city, carriers] of Object.entries(map.carrier_airport)) {
      const airports = [...new Set(Object.values(carriers))]
      if (!airports.some(a => line.includes(a))) continue
      const mentioned = Object.keys(carriers).filter(c => new RegExp(`(?<![A-Za-z0-9])${c}(?![A-Za-z0-9])`).test(line))
      if (mentioned.length === 0) continue
      const airport = airports.find(a => line.includes(a))
      if (airport) claims.airports.push({ line: lineNo, text: line.trim().slice(0, 120), carriers: mentioned, airport, city })
    }
  }
  return claims
}

// ---------------------------------------------------------------------------
// 闸:逐条对照注册表与映射表;行程级口径由结构化 itinerary 不变量并入
// ---------------------------------------------------------------------------

export type GateViolationKind =
  | FlightClaimVerdict                // not_in_source / route_unqueried / contradicted(traceable 不产生违例)
  | 'carrier_direct_unverified'       // 承运级直飞断言无 exact-date 证据(「可考虑 8L 直飞」)
  | 'airport_mapping_conflict'        // 航司→机场与 dated 映射冲突(FD/VZ 均落 DMK)
  | 'policy_without_as_of'            // 政策断言无「截至 YYYY-MM-DD」时间边界
  | 'unconditional_check'             // 对未核验/不可售 claim 使用无条件 ✓/✅
  | 'self_transfer_called_through'    // 分票/自助转机被称为「联程」
  | 'nights_inconsistent'             // 酒店夜+机上夜 ≠ 行程总夜数
  | 'legs_inconsistent'               // flight O&D 段与 legs 口径不一致
  | 'budget_floor_inconsistent'       // 预算下限话术低于分项最低合计
  | 'date_order'                      // 住宿/段日期越窗或倒挂

export interface GateViolation {
  kind: GateViolationKind
  line: number
  detail: string
}

export interface GateReport {
  schema: typeof ARTIFACT_GATE_SCHEMA
  verdict: 'pass' | 'blocked'
  claims_checked: number
  traceable: number
  violations: GateViolation[]
  /** blocked 时的措辞纪律:不得宣称「已验证方案」 */
  presentation: 'verified_itinerary_allowed' | 'verified_label_forbidden'
}

/** 行内 HH:MM 与已溯源事实的时刻对照:写了时刻却一个都对不上 = 混入旧航季(contradicted) */
function lineTimesContradict(text: string, dep?: string, arr?: string): boolean {
  if (!dep && !arr) return false
  const times = [...text.matchAll(/(?<!\d)(\d{1,2}:\d{2})(?!\d)/g)].map(m => m[1]!)
  if (times.length === 0) return false
  return !times.some(t => t === dep || t === arr)
}

export function gateArtifact(
  markdown: string,
  facts: BookableFact[],
  map: AirlineAirportMap,
  opts?: { trip_year?: number; itinerary?: ItineraryFacts },
): GateReport {
  const claims = extractClaims(markdown, map, opts)
  const violations: GateViolation[] = []
  let traceable = 0

  for (const c of claims.flights) {
    if (c.carrier_only) {
      // 承运级直飞断言:注册表该 route+date 须存在该承运的 bookable 直飞
      const hasCarrier = facts.some(f =>
        f.kind === 'flight' && f.bookability === 'bookable_exact_date' && f.nonstop !== false
        && f.flight_no.startsWith(c.carrier_only!)
        && (!c.origin || f.route.origin === c.origin || f.route.origin_airport === c.origin)
        && (!c.destination || f.route.destination === c.destination || f.route.dest_airport === c.destination)
        && (!c.date || f.date === c.date))
      if (!hasCarrier) {
        const scoped = c.origin && c.destination && c.date
          ? latestFactsForRouteDate(facts, c.origin, c.destination, c.date)
          : []
        violations.push({
          kind: scoped.length > 0 ? 'not_in_source' : 'carrier_direct_unverified',
          line: c.line,
          detail: `承运级直飞断言「${c.carrier_only} 直飞」无 exact-date 证据(${c.origin ?? '?'}→${c.destination ?? '?'} ${c.date ?? '?'})`
            + (scoped.length > 0 && scoped.every(f => f.bookability === 'bookable_exact_date' && f.nonstop === false)
              ? '——该日可售仅有中转' : '——「可考虑/也许有」不得写入决策树'),
        })
      }
      continue
    }
    const r = flightClaimVerdict(facts, c)
    if (r.verdict === 'traceable') {
      // 时刻一致性:溯源命中但行内时刻与事实全不符 = 旧航季混入(issue #46 EK328 行)
      if (lineTimesContradict(c.text, r.fact?.dep_local, r.fact?.arr_local)) {
        violations.push({
          kind: 'contradicted',
          line: c.line,
          detail: `${c.flight_no} 时刻与 exact-date 快照不符(快照 ${r.fact?.dep_local}→${r.fact?.arr_local} ${r.fact?.date})——渲染层不得改写工具返回的时刻`,
        })
        continue
      }
      traceable++
      continue
    }
    violations.push({ kind: r.verdict, line: c.line, detail: `${c.flight_no}: ${r.reason}` })
    // 对不可述 claim 的无条件 ✓/✅ 追加语气违例(验收⑦:远期班期/价格不用无条件 ✓)
    if (CHECK_MARK.test(c.text)) {
      violations.push({ kind: 'unconditional_check', line: c.line, detail: `对未核验航班 ${c.flight_no} 使用无条件 ✓/✅——只有 bookable_exact_date 才允许确定性标记` })
    }
  }

  // 通用直飞规则:该行未点名承运时,要求该 route+date 存在任一在架直飞;
  // 「该日可售仅有中转/0 条」却写直飞 = 无证据分支(issue #46「DMK→KMG 可考虑 8L 直飞」行同款)
  for (const d of claims.direct_lines) {
    if (claims.flights.some(c => c.line === d.line)) continue // 航班号/承运级断言已逐条判过
    if (!d.origin || !d.destination || !d.date) {
      violations.push({ kind: 'route_unqueried', line: d.line, detail: `直飞断言缺 route/date 上下文,无法回溯——fail closed 按未核验处理` })
      continue
    }
    const scoped = latestFactsForRouteDate(facts, d.origin, d.destination, d.date)
    if (scoped.length === 0) {
      violations.push({ kind: 'route_unqueried', line: d.line, detail: `${d.origin}→${d.destination} ${d.date} 的直飞断言从未经 exact-date 源核验` })
      continue
    }
    const nonstopCount = scoped.filter(f => f.bookability === 'bookable_exact_date' && f.nonstop !== false).length
    if (nonstopCount === 0) {
      violations.push({ kind: 'not_in_source', line: d.line, detail: `${d.origin}→${d.destination} ${d.date} exact-date 无任何在架直飞(仅中转或 0 条)——不得写直飞` })
    }
  }

  for (const a of claims.airports) {
    const table = map.carrier_airport[a.city] ?? {}
    for (const carrier of a.carriers) {
      const expected = table[carrier]
      if (expected && expected !== a.airport) {
        violations.push({
          kind: 'airport_mapping_conflict',
          line: a.line,
          detail: `${carrier} 在${a.city}落 ${expected}(映射快照 as_of ${map.meta.as_of}),产物写 ${a.airport}——双机场不互换,航司不合并映射`,
        })
      }
    }
  }

  for (const p of claims.policies) {
    if (!p.has_as_of) {
      violations.push({ kind: 'policy_without_as_of', line: p.line, detail: `政策断言缺时间边界:动态政策只能表述为「截至 YYYY-MM-DD 的现行政策」并附复核日期` })
    }
    if (CHECK_MARK.test(p.text) && !p.has_as_of) {
      violations.push({ kind: 'unconditional_check', line: p.line, detail: `政策行使用无条件 ✓/✅` })
    }
  }

  // 联程措辞:含「联程」的行,逐航班号查 protected_connection——
  // 只有全部航腿同票保护才允许称联程;分票/自助转机必须显式标红
  markdown.split('\n').forEach((line, i) => {
    if (!line.includes('联程')) return
    const nos = [...line.matchAll(FLIGHT_NO)].map(m => m[1]!.toUpperCase())
    const matched = facts.filter((f): f is Extract<BookableFact, { kind: 'flight' | 'train' }> =>
      f.kind !== 'policy' && nos.includes(f.flight_no.toUpperCase()))
    const allProtected = nos.length > 0
      && matched.length === nos.length
      && matched.every(f => f.protected_connection === true)
    if (!allProtected) {
      violations.push({
        kind: 'self_transfer_called_through',
        line: i + 1,
        detail: '「联程」措辞无 protected_connection=true 证据——两段接得上不等于同票联程;分票必须标红自助转机(无行李直挂/误机无保护)',
      })
    }
  })

  // 行程级口径不变量(夜数/legs/预算下限):结构化 itinerary 机器断言并入同一报告
  if (opts?.itinerary) {
    for (const v of itineraryInvariants(opts.itinerary)) {
      violations.push({ kind: v.kind, line: 0, detail: v.detail })
    }
  }

  return {
    schema: ARTIFACT_GATE_SCHEMA,
    verdict: violations.length > 0 ? 'blocked' : 'pass',
    claims_checked: claims.flights.length + claims.policies.length + claims.airports.length,
    traceable,
    violations,
    presentation: violations.length > 0 ? 'verified_label_forbidden' : 'verified_itinerary_allowed',
  }
}
