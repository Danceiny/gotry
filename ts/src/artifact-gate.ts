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
  hotelClaimVerdict,
  itineraryInvariants,
  latestFactsForRouteDate,
  railClaimVerdict,
  renderFlightFact,
  type BookableFact,
  type FlightClaim,
  type FlightClaimVerdict,
  type ItineraryFacts,
  type RailClaim,
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

/** 车次 claim(issue #299):中文高铁/动车/城际/直达代码(G/D/C/Z + 3–4 位)。
 * 闸侧不与航班 claim 合并;`railClaimVerdict` 只在 train 事实里查同号回溯,
 * 缺事实/缺上下文 fail-closed(`rail_claim_unverified`),不得用历史班期或
 * static-schedule 凑合格回溯。`gotry_flyai_search kind:'train'` 经
 * `factsFromFlyai` 与 12306 `sessionTrainSearch` 均沿现有 typed fact log 接线;
 * session 事实须通过 typed parser outcome + seat availability/freshness contract,
 * 列表不含票价;
 * 不新增 RailFact 渲染器,真实供应商可售性仍需独立证据。 */
export interface ExtractedRailClaim extends RailClaim {
  line: number
  text: string
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

/** 酒店 claim(D-26):断言「有房/可订/已核验」的行——目的地与档期缺失时 fail-closed */
export interface ExtractedHotelClaim {
  line: number
  text: string
  destination?: string
  check_in?: string
  check_out?: string
}

export interface ExtractedClaims {
  flights: ExtractedFlightClaim[]
  trains: ExtractedRailClaim[]
  policies: ExtractedPolicyClaim[]
  airports: ExtractedAirportClaim[]
  /** 含「直飞」断言且可解析航线的行(通用直飞规则:该日无任何在架直飞即违例) */
  direct_lines: Array<{ line: number; text: string; origin?: string; destination?: string; date?: string }>
  hotels: ExtractedHotelClaim[]
  /** 渲染原语锚点(fact:<id>):命中行只走确定性回溯,启发式让位 */
  anchors: Map<number, string>
}

/** 航班号:2 位承运码 + 3-4 位数字(UO784/EK328/MF1538/CZ8582/9C8781/FD597)。
 * 中文高铁/动车/城际/直达代码(G/D/C/Z + 3–4 位)由 `TRAIN_NO` 单独收集,
 * 不进入航班 claim,issue #299。 */
const FLIGHT_NO = /(?<![A-Za-z0-9])([A-Z0-9]{2}\d{3,4})(?![\d])/g
/** 车次号:中文 G/D/C/Z + 3-4 位数字(G1234/D3112/C2001/Z1/Z9999)。issue #299:
 * 闸侧 train claim 集合与航班 claim 完全分离,`flightClaimVerdict` 不再吞 train
 * 事实,`railClaimVerdict` 只在 train 事实里查同号回溯。 */
const TRAIN_NO = /(?<![A-Za-z0-9])([GDCZ]\d{3,4})(?![A-Za-z0-9])/g
/** 承运级直飞断言:「8L 直飞」「FZ 直飞香港」——无航班号的航线存在性断言 */
const CARRIER_DIRECT = /(?<![A-Za-z0-9])([A-Z0-9]{2})(?!\d)(?:\s|[一-龥]){0,6}直飞/g
/** 中文承运名 → 二字码(承运级断言覆盖;只列闸需要的常见出境承运) */
const CARRIER_ZH: Record<string, string> = {
  东航: 'MU', 南航: 'CZ', 国航: 'CA', 厦航: 'MF', 春秋: '9C', 祥鹏: '8L',
  亚航: 'FD', 越捷: 'VZ', 国泰: 'CX', 港航: 'HX', 香港快运: 'UO', 阿联酋: 'EK', 泰航: 'TG',
}
/** Finite hotel-category vocabulary shared by heading activation and row recognition (issue #301). */
const LODGING_VOCAB_RE = /酒店|住宿|客栈|民宿|度假村|青旅|青年旅舍|别墅|公寓/
/** Markdown ATX heading level 1–6 (根实测 #347:5/6 级 lodging heading 必须激活) */
const HEADING_ATX = /^(#{1,6})\s+(.+)$/
/** 「政策」关键词(issue #273 父 + 子 #302):覆盖签证/免签/落地签/海关/过境五大类 + 子 #302 显式列举的政策词有限并集;
 * 海关申报 与 入境申报 同性质但被原 regex 漏掉,补一个 demonstrative miss。
 * 子 #302 扩词边界:仅 EVUS/ETA/eVisa/疫苗/疫苗接种/健康申报/隔离/工作签/居留/返程签/护照有效期/黄皮书/保险;拉丁 token
 * 大小写不敏感但不嵌入更长 Latin 词(REVUS ≠ EVUS);不做 NLP/同义词/任意政策词表扩展。 */
const POLICY_WORD = /免签|落地签|签证|入境申报|海关申报|过境免|疫苗|疫苗接种|健康申报|隔离|工作签|居留|返程签|护照有效期|黄皮书|保险|(?<![A-Za-z])(?:EVUS|ETA|eVisa)(?![A-Za-z])/i
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

interface SectionCtx { origin?: string; destination?: string; date?: string; /** 当前行是否在 lodging heading 上下文中(issue #301 无 token 行入闸) */ lodging?: boolean; /** 活动 lodging heading 的 ATX 层级栈(浅→深);同/更高级 non-lodging heading 弹出栈顶 */ lodgingDepths?: number[] }

/** 行内第一个命中词表的城市中文名(酒店 claim 的目的地键;无命中=undefined) */
function occ1(line: string, map: AirlineAirportMap): string | undefined {
  for (const city of Object.keys(map.city_alias)) {
    if (line.includes(city)) return city
  }
  return undefined
}

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
  const claims: ExtractedClaims = { flights: [], trains: [], policies: [], airports: [], direct_lines: [], hotels: [], anchors: new Map() }
  const lines = markdown.split('\n')
  let section: SectionCtx = {}
  // 渲染原语锚点(单向生成):带 fact:<id> 的行只走锚点确定性回溯,启发式抽取让位
  const ANCHOR = /fact:([0-9a-f]{16})/
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const lineNo = i + 1
    const anchorMatch = line.match(ANCHOR)
    if (anchorMatch) {
      claims.anchors.set(lineNo, anchorMatch[1]!.toLowerCase())
      continue
    }
    if (HEADING_ATX.test(line)) {
      const ctx = routeCtxOf(line, map, opts?.trip_year)
      // lodging heading 上下文栈(issue #301 真实反例:无 token 行入闸):
      //  - lodging heading:在该层级压栈(更深栈顶替代外层语义,栈整体保留)
      //  - 同级/更高级 non-lodging heading:弹栈直到空
      //  - 更深的 non-lodging heading:继承栈
      const headingMatch = line.match(HEADING_ATX)!
      const headingLevel = headingMatch[1]!.length
      const headingText = headingMatch[2]!
      const isLodgingHeading = LODGING_VOCAB_RE.test(headingText)
      const depths = (section.lodgingDepths ?? []).slice()
      if (isLodgingHeading) {
        // 同级 lodging heading 替换该层栈,更深的栈项保留
        while (depths.length > 0 && depths[depths.length - 1]! >= headingLevel) depths.pop()
        depths.push(headingLevel)
      } else {
        // 同级/更高级 non-lodging heading 弹出栈顶直至更浅或空
        while (depths.length > 0 && depths[depths.length - 1]! >= headingLevel) depths.pop()
      }
      const lodging = depths.length > 0
      section = { origin: ctx.origin, destination: ctx.destination, date: ctx.date ?? section.date, lodging, lodgingDepths: depths }
      continue
    }
    const own = routeCtxOf(line, map, opts?.trip_year)
    const origin = own.origin ?? section.origin
    const destination = own.destination ?? section.destination
    const date = own.date ?? section.date

    const trainNos = new Set([...line.matchAll(TRAIN_NO)].map(m => m[1]!.toUpperCase()))
    for (const trainNo of trainNos) {
      claims.trains.push({ line: lineNo, text: line.trim().slice(0, 120), flight_no: trainNo, origin, destination, date })
    }
    for (const m of line.matchAll(FLIGHT_NO)) {
      const code = m[1]!.toUpperCase()
      // 闸侧 train/flight 分离:中文高铁/动车/城际/直达前缀不得进入航班 claim。
      // FLIGHT_NO 也会把 G1234 这类单字母车次整体匹配出来;只跳过同一行
      // TRAIN_NO 实际命中的完整 token。不能按首字母跳过,否则合法双字母航司
      // CZ8582 会被误删。
      if (trainNos.has(code)) continue
      claims.flights.push({ line: lineNo, text: line.trim().slice(0, 120), flight_no: code, origin, destination, date })
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
    // 酒店 claim(D-26 + 子 #301 扩词):断言可住性(有房/可订/已核验/✓)的行——目的地与档期缺失时 fail-closed
    // 父 #273 已有 酒店|住宿|客栈|民宿;子 #301 扩词覆盖 度假村/青旅/青年旅舍/别墅/公寓 五类非关键词住宿
    // category(精品酒店 由 酒店 承接,不重复声明);lodging heading(§住宿/§酒店/§青旅 等,ATX 1–6)下完全无住宿类
    // token 的可住断言也由 section.lodging 升为 hotel claim。行内匹配分两路:
    //   (a) 行内含 LODGING_VOCAB_RE 词表 token → 需 HOTEL_BOOKABLE 短语/标记
    //   (b) 行内无 token 但 lodging context 激活 → 需 HOTEL_BOOKABILITY 短语(有房/可订/.../可住),
    //       单独的 ✓/✅ 不构成 bookability(例:`靠近地铁 ✓` 在 §住宿 下不是可订断言)。
    //       检测到可订短语且带 ✓,未核验时再加 unconditional_check。
    // 同级/更高级 non-lodging heading 退出上下文,更深 heading 继承;lodging depth 栈保留外层活动层级。
    // 行内/heading 词汇同源 = LODGING_VOCAB_RE,不可漂移。无住宿类关键词仍走兜底 →
    // unverifiable_hotel_claim(§10f 既有证据)。route/date section context 对航班逻辑不动;
    // anchored 行由 `if (claims.anchors.has(c.line)) continue` 提前让位。
    const HOTEL_BOOKABILITY = /有房|可订|在架|已核验|已验证|可住/
    const HOTEL_BOOKABLE = /有房|可订|在架|已核验|已验证|可住|✓|✅/
    const hasCategoryToken = LODGING_VOCAB_RE.test(line)
    const inLodgingSection = !!section.lodging
    const isBookabilityClaim = hasCategoryToken
      ? HOTEL_BOOKABLE.test(line)
      : inLodgingSection && HOTEL_BOOKABILITY.test(line)
    if (isBookabilityClaim) {
      const stays = [...line.matchAll(/(?<!\d)(\d{4}-\d{2}-\d{2})(?!\d)/g)].map(m => m[1]!)
      claims.hotels.push({
        line: lineNo,
        text: line.trim().slice(0, 160),
        destination: occ1(line, map),
        check_in: stays[0],
        check_out: stays[1],
      })
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
  | 'unverifiable_hotel_claim'        // 酒店可住断言无 exact-date 事实回溯(D-26)
  | 'rail_claim_unverified'           // 车次 claim 无 train exact-date 事实回溯(issue #299)
  | 'fact_anchor_unknown'             // 渲染锚点 fact:<id> 在注册表不存在(锚点被手改/伪造)
  | 'unverified_price_claim'          // 硬价缺少可比较的权威来源或可靠绑定(issue #300)
  | 'price_contradicted'              // 行内可靠硬价格与 exact-date 事实价格冲突(issue #300)

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

interface HardPrice {
  amount: number
  currency: string
  token: string
  start: number
}

/**
 * 只抽取行内可可靠绑定的硬价。起价/约价/模糊值不进入比较，不支持的币种
 * 只进入未核验分支；不做汇率换算，也不把酒店 priceRaw 带入这里(issue #300)。
 */
function hardPricesInLine(text: string): HardPrice[] {
  const prices: HardPrice[] = []
  const amount = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?`
  const pattern = new RegExp(String.raw`(?:¥\s*(${amount})(?![\dA-Za-z,])|\b([A-Z]{3})\s*(${amount})(?![\dA-Za-z,]))`, 'gi')
  for (const match of text.matchAll(pattern)) {
    const amountText = match[1] ?? match[3]
    if (!amountText || match.index === undefined) continue
    const before = text.slice(Math.max(0, match.index - 8), match.index)
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 8)
    if (/(?:约|大约|约为|起价|起步|from)\s*$/i.test(before)
      || /^\s*(?:起|起价|起步|左右|上下|以上|\+)/i.test(after)) continue
    prices.push({
      amount: Number(amountText.replaceAll(',', '')),
      currency: match[1] ? 'CNY' : match[2]!.toUpperCase(),
      token: amountText,
      start: match.index,
    })
  }
  return prices
}

interface MalformedHardPrice {
  currency: string
  token: string
  start: number
}

/**
 * 先识别完整 token 之外的畸形逗号数字;¥7xx 等既有非数字/模糊值不在此列。
 */
function malformedHardPricesInLine(text: string): MalformedHardPrice[] {
  const amount = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?`
  const token = String.raw`\d[\d,]*(?:\.\d+)?`
  const pattern = new RegExp(String.raw`(?:¥\s*|\b([A-Z]{3})\s*)(${token})(?![\dA-Za-z])`, 'gi')
  const malformed: MalformedHardPrice[] = []
  for (const match of text.matchAll(pattern)) {
    const raw = match[2]
    if (!raw || !raw.includes(',') || new RegExp(`^(?:${amount})$`).test(raw)) continue
    malformed.push({ currency: match[1] ? match[1].toUpperCase() : 'CNY', token: raw, start: match.index ?? 0 })
  }
  return malformed
}

interface MoneyField {
  text: string
  offset: number
  index: number
}

interface AmbiguousHardPrice {
  currency: string
  token: string
  start: number
}

interface FareRoleAnalysis {
  prices: HardPrice[]
  malformed: MalformedHardPrice[]
  ambiguous: AmbiguousHardPrice[]
}

function moneyFields(text: string): MoneyField[] {
  const fields = text.split(/[；;|，]/)
  const scopes: MoneyField[] = []
  let offset = 0
  for (const [index, field] of fields.entries()) {
    scopes.push({ text: field, offset, index })
    offset += field.length + 1
  }
  return scopes
}

const EXPLICIT_FARE_LABEL = /(?:票价|机票价|fare|price)\s*[:：]?\s*$/i
const PREVIOUS_MONEY_TOKEN = /(?:¥\s*|\b[A-Z]{3}\s*)\d[\d,]*(?:\.\d+)?\s*$/i

/**
 * 分类 money role,而不是把「同一行」当成 fare:
 * canonical 是第一个 money token 所在的首字段;后续 token 只有显式
 * fare label 才可比。其它有文字标签的字段忽略;裸 token 或前面只是
 * 另一个金额的 token 无可靠归属,必须 fail closed。
 */
function analyzeFareRoles(text: string): FareRoleAnalysis {
  const analysis: FareRoleAnalysis = { prices: [], malformed: [], ambiguous: [] }
  for (const field of moneyFields(text)) {
    const prices = hardPricesInLine(field.text)
    const malformed = malformedHardPricesInLine(field.text)
    const tokens = [
      ...prices.map(price => ({ kind: 'complete' as const, start: price.start, price, malformed: undefined })),
      ...malformed.map(item => ({ kind: 'malformed' as const, start: item.start, price: undefined, malformed: item })),
    ].sort((a, b) => a.start - b.start)
    for (const [tokenIndex, token] of tokens.entries()) {
      const prefix = field.text.slice(0, token.start).trim()
      const canonical = field.index === 0 && tokenIndex === 0
      const explicitFare = EXPLICIT_FARE_LABEL.test(prefix)
      const reliableFare = canonical || explicitFare
      if (reliableFare) {
        if (token.price) analysis.prices.push({ ...token.price, start: token.price.start + field.offset })
        if (token.malformed) analysis.malformed.push({ ...token.malformed, start: token.malformed.start + field.offset })
        continue
      }
      // A bare token, or a token immediately following another money token,
      // is ambiguous; any other textual prefix accounts for a non-fare field.
      if (prefix.length === 0 || PREVIOUS_MONEY_TOKEN.test(prefix)) {
        const currency = token.price?.currency ?? token.malformed?.currency ?? 'CNY'
        const raw = token.price?.token ?? token.malformed?.token ?? ''
        analysis.ambiguous.push({ currency, token: raw, start: token.start + field.offset })
      }
    }
  }
  return analysis
}

function flightTrainPriceScope(text: string, fact: Extract<BookableFact, { kind: 'flight' | 'train' }>): string {
  const no = fact.flight_no.toUpperCase()
  const noStart = text.toUpperCase().indexOf(no)
  if (noStart < 0) return ''
  const afterNo = text.slice(noStart + no.length)
  const nextFlight = afterNo.match(FLIGHT_NO)
  const anchor = text.indexOf('<!-- fact:', noStart + no.length)
  const evidence = afterNo.search(/\[[^\]\n]*#[^\]\n]*\]/)
  let end = text.length
  if (nextFlight?.index !== undefined) end = Math.min(end, noStart + no.length + nextFlight.index)
  // The rendered fare is before its evidence chain; amounts after it are
  // unrelated fees/budget text even when an anchor follows later on the line.
  if (evidence >= 0) end = Math.min(end, noStart + no.length + evidence)
  if (anchor >= 0) end = Math.min(end, anchor)
  return text.slice(noStart, end)
}

function addPriceVerification(
  violations: GateViolation[],
  line: number,
  fullText: string,
  visibleText: string,
  fact: Extract<BookableFact, { kind: 'flight' | 'train' }>,
): boolean {
  const fullScope = flightTrainPriceScope(fullText, fact)
  const visibleScope = flightTrainPriceScope(visibleText, fact)
  const fullAnalysis = analyzeFareRoles(fullScope)
  const visibleAnalysis = analyzeFareRoles(visibleScope)
  const allPrices = fullAnalysis.prices
  const visiblePrices = visibleAnalysis.prices
  const hasAnchor = fullText.includes('<!-- fact:')

  if (fullAnalysis.malformed.length > 0 || fullAnalysis.ambiguous.length > 0) {
    const malformed = fullAnalysis.malformed[0]
    const ambiguous = fullAnalysis.ambiguous[0]
    violations.push({
      kind: 'unverified_price_claim',
      line,
      detail: malformed
        ? `${fact.flight_no} fare role 含畸形硬价格 ${malformed.currency} ${malformed.token}——数字分组不完整,按未核验处理,不得截断或当作完整票价比较`
        : `${fact.flight_no} 行内硬价格 ${ambiguous?.currency ?? 'CNY'} ${ambiguous?.token ?? ''} 无可靠 fare role 归属——按未核验处理,不得把裸金额当作 exact-date 票价`,
    })
    return true
  }

  // Heuristic claims retain the existing 120-character extraction window. If a
  // hard price only appears outside it, it cannot be safely bound to this claim.
  if (!hasAnchor && allPrices.some(p => p.start >= visibleScope.length)) {
    violations.push({
      kind: 'unverified_price_claim',
      line,
      detail: `${fact.flight_no} 行内硬价格未锚定且超出 120 字抽取窗口——无法作为 exact-date 事实核验,按未核验处理`,
    })
    return true
  }

  if (allPrices.length === 0) return false
  const factCurrency = fact.currency?.toUpperCase()
  for (const rendered of visiblePrices) {
    if (fact.price === undefined || !Number.isFinite(fact.price) || factCurrency !== 'CNY') {
      violations.push({
        kind: 'unverified_price_claim',
        line,
        detail: `${fact.flight_no} 行内硬价格 ${rendered.currency} ${rendered.amount} 缺少可比较的权威 exact-date 事实价格——按未核验处理,不作汇率或币种猜测`,
      })
      return true
    }
    // ¥/CNY only compare against a CNY fact. No FX or ambiguous-currency guess.
    if (rendered.currency !== factCurrency) {
      violations.push({
        kind: 'unverified_price_claim',
        line,
        detail: `${fact.flight_no} 行内硬价格 ${rendered.currency} ${rendered.amount} 不支持直接比较事实 ${factCurrency} ${fact.price}——按未核验处理,不作汇率换算`,
      })
      return true
    }
    if (rendered.amount === fact.price) continue
    violations.push({
      kind: 'price_contradicted',
      line,
      detail: `${fact.flight_no} 行内硬价格 ${rendered.currency} ${rendered.amount} ≠ exact-date 事实 ${factCurrency} ${fact.price}——价格事实矛盾,不得改写工具返回价格`,
    })
    return true
  }
  return false
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

  // 渲染锚点优先(issue #118 单向生成):带 fact:<id> 的行确定性回溯注册表——
  // 锚点在=按事实 bookability 判;锚点不存在=手改/伪造,直接违例。启发式对锚点行让位。
  const lines = markdown.split('\n')
  const AS_OF_PATTERN = /截至\s*(\d{4}-\d{2}-\d{2})/
  for (const [lineNo, factId] of claims.anchors) {
    const f = facts.find(x => x.fact_id === factId)
    if (!f) {
      violations.push({ kind: 'fact_anchor_unknown', line: lineNo, detail: `渲染锚点 fact:${factId} 不在事实注册表——锚点被手改或伪造,产物不可信` })
      continue
    }
    if (f.kind === 'train') {
      const rendered = lines[lineNo - 1] ?? ''
      const canonical = renderFlightFact(f)
      if (rendered.trim() !== canonical.trim()) {
        violations.push({
          kind: 'fact_anchor_unknown',
          line: lineNo,
          detail: `train 锚点行与 canonical renderer 不一致——车次/时刻/日期/route 可能被手改;期望 ${canonical}`,
        })
        continue
      }
      const rail = railClaimVerdict(facts, {
        flight_no: f.flight_no,
        origin: f.route.origin,
        destination: f.route.destination,
        date: f.date,
      })
      if (rail.verdict !== 'traceable') {
        violations.push({ kind: 'rail_claim_unverified', line: lineNo, detail: `${f.flight_no}: 锚点未通过 train exact-date 回溯(${rail.verdict})——${rail.reason}` })
        continue
      }
    }
    if (f.kind !== 'policy' && f.bookability === 'unavailable_exact_date') {
      violations.push({ kind: 'not_in_source', line: lineNo, detail: `锚点事实为 exact-date 负事实(${(f as { fetched_at?: string }).fetched_at ?? ''})——负事实对应的可住/可订断言不得出现` })
      continue
    }
    // 内容指纹(issue #273):锚点行渲染的 as_of 必须与事实 as_of 一致——
    // 改锚点行日期而保留 fact_id = 手改锚点;与未知锚点同源 fail-closed。
    if (f.kind === 'policy') {
      const rendered = lines[lineNo - 1] ?? ''
      const m = rendered.match(AS_OF_PATTERN)
      const renderedAsOf = m?.[1]
      if (!renderedAsOf || renderedAsOf !== f.as_of) {
        violations.push({
          kind: 'fact_anchor_unknown',
          line: lineNo,
          detail: renderedAsOf
            ? `锚点行 as_of ${renderedAsOf} ≠ 事实 ${f.as_of}——内容指纹不符,锚点被手改`
            : `锚点行缺少截至日期——事实 ${f.as_of} 的内容指纹不符,锚点被手改`,
        })
        continue
      }
    }
    if ((f.kind === 'flight' || f.kind === 'train') && addPriceVerification(violations, lineNo, lines[lineNo - 1] ?? '', lines[lineNo - 1] ?? '', f)) continue
    traceable++
  }

  // 酒店 claim(D-26):目的地+档期回溯酒店事实;无事实 fail-closed
  for (const c of claims.hotels) {
    if (claims.anchors.has(c.line)) continue
    if (!c.destination) {
      violations.push({ kind: 'unverifiable_hotel_claim', line: c.line, detail: `酒店可住断言缺目的地上下文,无法回溯 exact-date 事实——fail closed 按未核验处理` })
      // 无目的地时也检查无条件 ✓:对未核验住宿仍不应打确定性标记
      if (CHECK_MARK.test(c.text)) {
        violations.push({ kind: 'unconditional_check', line: c.line, detail: '对未核验酒店使用无条件 ✓/✅——只有 bookable_exact_date 才允许确定性标记' })
      }
      continue
    }
    const r = hotelClaimVerdict(facts, { destination: c.destination, check_in: c.check_in, check_out: c.check_out })
    if (r.verdict === 'traceable') {
      traceable++
      continue
    }
    if (r.verdict === 'unverified') {
      violations.push({ kind: 'unverifiable_hotel_claim', line: c.line, detail: r.reason })
    } else {
      violations.push({ kind: 'not_in_source', line: c.line, detail: r.reason })
    }
    if (CHECK_MARK.test(c.text)) {
      violations.push({ kind: 'unconditional_check', line: c.line, detail: '对未核验酒店使用无条件 ✓/✅——只有 bookable_exact_date 才允许确定性标记' })
    }
  }

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
          ? latestFactsForRouteDate(facts, c.origin, c.destination, c.date, 'flight')
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
      if (r.fact && addPriceVerification(violations, c.line, lines[c.line - 1] ?? '', c.text, r.fact)) continue
      traceable++
      continue
    }
    violations.push({ kind: r.verdict, line: c.line, detail: `${c.flight_no}: ${r.reason}` })
    // 对不可述 claim 的无条件 ✓/✅ 追加语气违例(验收⑦:远期班期/价格不用无条件 ✓)
    if (CHECK_MARK.test(c.text)) {
      violations.push({ kind: 'unconditional_check', line: c.line, detail: `对未核验航班 ${c.flight_no} 使用无条件 ✓/✅——只有 bookable_exact_date 才允许确定性标记` })
    }
  }

  // 车次 claim 独立于航班 claim:同 route/date 的航班事实不能证明车次存在,
  // 也不能把缺失车次写成通用 not_in_source。只有 train kind 的结构化
  // exact-date 事实才可回溯;不存在 renderRailFact 或 static schedule 降级。
  for (const c of claims.trains) {
    if (claims.anchors.has(c.line)) continue
    const r = railClaimVerdict(facts, c)
    if (r.verdict === 'traceable') {
      if (lineTimesContradict(c.text, r.fact?.dep_local, r.fact?.arr_local)) {
        violations.push({
          kind: 'rail_claim_unverified',
          line: c.line,
          detail: `${c.flight_no} 时刻与 train exact-date 快照不符(快照 ${r.fact?.dep_local}→${r.fact?.arr_local} ${r.fact?.date})——不得改写结构化车次事实`,
        })
        continue
      }
      if (r.fact && addPriceVerification(violations, c.line, lines[c.line - 1] ?? '', c.text, r.fact)) continue
      traceable++
      continue
    }
    violations.push({ kind: 'rail_claim_unverified', line: c.line, detail: `${c.flight_no}: ${r.verdict}——${r.reason}` })
    if (CHECK_MARK.test(c.text)) {
      violations.push({ kind: 'unconditional_check', line: c.line, detail: `对未核验车次 ${c.flight_no} 使用无条件 ✓/✅——只有 train bookable_exact_date 才允许确定性标记` })
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
    const scoped = latestFactsForRouteDate(facts, d.origin, d.destination, d.date, 'flight')
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
    const trainNos = new Set([...line.matchAll(TRAIN_NO)].map(m => m[1]!.toUpperCase()))
    const nos = [...line.matchAll(FLIGHT_NO)]
      .map(m => m[1]!.toUpperCase())
      .filter(no => !trainNos.has(no))
    const matched = facts.filter((f): f is Extract<BookableFact, { kind: 'flight' | 'train' }> =>
      (f.kind === 'flight' || f.kind === 'train') && nos.includes(f.flight_no.toUpperCase()))
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
    claims_checked: claims.flights.length + claims.trains.length + claims.policies.length + claims.airports.length,
    traceable,
    violations,
    presentation: violations.length > 0 ? 'verified_label_forbidden' : 'verified_itinerary_allowed',
  }
}
