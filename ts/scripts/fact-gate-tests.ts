/**
 * 可下单事实模型 + 产物事实闸回归(issue #46,run-all §37;locked golden E2E):
 *
 * 金标准 = #24 同一场景、日期固定 2027-07-16～2027-08-09,数据源 = 2026-08-29
 * 独立审计快照(ts/data/golden-trip-2027-facts.json,逐字段溯源见 fixture meta)。
 *
 *  §1 转换与注册表:hit→正事实全字段/miss→负事实/error→不落;幂等去重;最新查询优先
 *  §2 验收②:exact-date 未返回 UO784 → 产物不得出现;「上午办事+当天下午直飞普吉」
 *     判定不可行,建议加 1 个香港夜/提前一天
 *  §3 验收③:HKT→曼谷 区分 FD→DMK 与 VZ→BKK;合并映射被抓
 *  §4 验收④:SZX→DXB 用 exact-date 班次(EK329);营销/实际承运分开保存与渲染
 *  §5 验收⑤:protected_connection=true 才允许称「联程」;分票显式标红自助转机
 *  §6 验收⑥:酒店夜+机上夜/O&D/legs/预算分项机器断言(35,500 vs 30,000 必抓)
 *  §7 验收⑦:政策带 as_of+复核日期;无条件 ✓ 被抓
 *  §8 回头路检测:Phuket→Krabi→Phuket 被抓 + KBV→BKK 最小改动建议
 *  §9 验收①⑧:全产物闸 golden E2E——复刻会话产物 blocked(违例类别全覆盖),
 *     由结构化事实渲染的产物 pass;无法回溯即禁止「已验证方案」措辞
 *
 * 运行(在 ts/ 下):npx tsx scripts/fact-gate-tests.ts
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BOOKABLE_FACT_SCHEMA,
  checkSameDayDeparture,
  dedupeFacts,
  detectBacktrack,
  factsFromFlyai,
  factsFromHotel,
  flightClaimVerdict,
  itineraryInvariants,
  latestFactsForRouteDate,
  makeFactId,
  negativeFact,
  policyCanonicalBody,
  railClaimVerdict,
  renderConnection,
  renderFlightFact,
  renderHotelFact,
  renderNightsLine,
  renderPolicyFact,
  type FlightFact,
  type ItineraryFacts,
  type PolicyFact,
  type CityAlias,
} from '../src/bookable-facts.ts'
import {
  ARTIFACT_GATE_SCHEMA,
  extractClaims,
  gateArtifact,
  type AirlineAirportMap,
  type GateViolationKind,
} from '../src/artifact-gate.ts'
import { parseLeftTicketQuery } from '../capabilities/session/adapters/rail-12306.ts'

let pass = 0
let fail = 0
function assert(cond: boolean, msg: string): void {
  if (cond) {
    pass++
    console.log(`  ok - ${msg}`)
  } else {
    fail++
    console.error(`  FAIL - ${msg}`)
  }
}

// ---- 夹具装载(locked golden:2027-07-16～2027-08-09,审计快照 as_of 2026-08-29) ----

const map = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'data', 'airline-airports.json'), 'utf-8')) as AirlineAirportMap
const alias: CityAlias = map.city_alias
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'data', 'golden-trip-2027-facts.json'), 'utf-8')) as {
  meta: { schema: string; trip_window: [string, string] }
  queries: Array<{
    kind: 'flight'; origin: string; destination: string; date: string
    verdict: 'hit' | 'miss' | 'error'
    options?: Array<Parameters<typeof factsFromFlyai>[1]['options'] extends Array<infer T> | undefined ? T : never>
  }>
  good_itinerary: ItineraryFacts
  bad_itinerary: ItineraryFacts
}
const FETCHED = '2026-08-29T09:51:00.000Z'

// golden fixture 查询经生产同款转换器进注册表(miss 落负事实);#299 train fixtures 在 §9b 单独构造
const registry: FlightFact[] = dedupeFacts(fixture.queries.flatMap(q =>
  factsFromFlyai({ kind: q.kind, origin: q.origin, destination: q.destination, date: q.date },
    { verdict: q.verdict, options: q.options }, FETCHED, alias)))

const tripYear = Number(fixture.meta.trip_window[0].slice(0, 4))

// ---- §1 转换与注册表 ---------------------------------------------------------

console.log('§1 转换与注册表')
const hkHkt717 = latestFactsForRouteDate(registry, 'HKG', 'HKT', '2027-07-17')
assert(registry.every(f => f.schema === BOOKABLE_FACT_SCHEMA && f.fact_id.length === 16), 'schema 词唯一且 fact_id 为 16 位语义散列')
assert(hkHkt717.length === 2 && hkHkt717.every(f => f.bookability === 'bookable_exact_date' && f.tier === 'live_inventory'), 'HKG→HKT 2027-07-17 在架两班,均为 exact-date 可下单层')
const uo724 = hkHkt717.find(f => f.flight_no === 'UO724')!
assert(uo724.dep_local === '07:55' && uo724.arr_local === '10:30' && uo724.nonstop === true
  && uo724.price === 793 && uo724.currency === 'CNY'
  && uo724.query_id === 'flyai:flight:香港-普吉:2027-07-17' && uo724.fetched_at === FETCHED && uo724.as_of === '2026-08-29',
  '事实字段齐全:时刻/直飞/价格/币种/query_id/fetched_at/as_of(issue 期望①的字段面)')
assert(uo724.marketing_carrier === '香港快运航空' && uo724.operating_carrier === undefined, '营销承运在案;实际承运上游未给 = 留空不猜(未知 ≠ 相同)')
const misses = registry.filter(f => f.bookability === 'unavailable_exact_date')
assert(misses.length === 1 && misses[0]!.route.origin === 'SZX' && misses[0]!.route.destination === 'HKT' && misses[0]!.date === '2027-07-17',
  'miss → 负事实(route+date 级「当前不可售」记录,非空缺)')
assert(factsFromFlyai({ kind: 'flight', origin: '香港', destination: '普吉', date: '2027-07-17' }, { verdict: 'error' }, FETCHED, alias).length === 0,
  'error 不落事实——通道无结论不是证据')
const dup = dedupeFacts([...registry, { ...uo724, fetched_at: '2026-08-30T00:00:00.000Z', price: 900 }])
const reFetched = dup.filter(f => f.fact_id === uo724.fact_id)
assert(reFetched.length === 1 && reFetched[0]!.price === 900, '同 fact_id 重查去重,保留最新 fetched_at(旧快照 append-only 在持久层)')
// 同 route+date 两次查询:最新一批为准(昨天的 miss 不否定今天的 hit)
const stale = negativeFact('flyai:flight:香港-普吉:2027-07-17', 'flight', '香港', '普吉', '2027-07-17', 'flyai', '2026-08-28T00:00:00.000Z', alias)
const mixed = dedupeFacts([stale, ...hkHkt717])
assert(latestFactsForRouteDate(mixed, 'HKG', 'HKT', '2027-07-17').every(f => f.bookability === 'bookable_exact_date'),
  '同 route+date 陈旧 miss 不遮蔽更新查询的 hit(最新批次优先)')

// ---- §2 验收②:UO784 不在 exact-date 源 → 不得出现;核心衔接判不可行 -------------

console.log('§2 UO784 与同日衔接硬约束')
const claim = flightClaimVerdict(registry, { flight_no: 'UO784', origin: 'HKG', destination: 'HKT', date: '2027-07-17' })
assert(claim.verdict === 'not_in_source' && /UO724|CX771/.test(claim.reason),
  'UO784 在 HKG→HKT 2027-07-17 被判 not_in_source(源内在架 UO724/CX771)')
const conn = checkSameDayDeparture(registry, { origin: 'HKG', destination: 'HKT', date: '2027-07-17' },
  { errand_end_local: '13:00', airport_transit_min: 45, checkin_deadline_min: 120 })
assert(!conn.feasible && conn.feasible_flights.length === 0, '「上午办事(13:00 结束)+ 当天下午直飞普吉」判定不可行')
assert(conn.earliest_departure_local === '15:45' && conn.excluded.length === 2
  && conn.excluded.every(e => /最早可接时刻 15:45/.test(e.reason)),
  '最早可接 15:45(13:00+45m 门到机场+120m 值机);在架两班早班均被硬约束排除并带原因')
assert(conn.suggestions.some(s => s.includes('增加 1 个HKG住宿夜')) && conn.suggestions.some(s => s.includes('提前一天')),
  '不可行建议:增加 1 个香港住宿夜 / 提前一天完成事务或出发(issue 验收②原话面)')

// ---- §3 验收③:机场映射 FD→DMK / VZ→BKK 不互换 ---------------------------------

console.log('§3 航司→机场映射')
assert(map.carrier_airport['BKK']?.['FD'] === 'DMK' && map.carrier_airport['BKK']?.['VZ'] === 'BKK',
  '映射快照:FD→DMK、VZ→BKK(as_of 2026-08-29)')
const mapGate = gateArtifact('### 段｜普吉→曼谷(7.30)\n| FD/VZ(亚航/越捷) | 廊曼DMK |', registry, map, { trip_year: tripYear })
assert(mapGate.violations.some(v => v.kind === 'airport_mapping_conflict' && /VZ 在BKK落 BKK/.test(v.detail))
  && !mapGate.violations.some(v => v.kind === 'airport_mapping_conflict' && /FD 在/.test(v.detail)),
  '「FD/VZ 均落 DMK」合并映射:VZ 被抓、FD 不误伤')
const mapOk = gateArtifact('### 段｜普吉→曼谷(7.30)\n| FD(亚航) | 廊曼DMK |', registry, map, { trip_year: tripYear })
assert(!mapOk.violations.some(v => v.kind === 'airport_mapping_conflict'), 'FD→DMK 与映射一致不误报')

// ---- §4 验收④:SZX→DXB 用 exact-date 班次;营销/实际承运分开 ---------------------

console.log('§4 SZX→DXB 与承运分离')
const szxDxb = latestFactsForRouteDate(registry, 'SZX', 'DXB', '2027-08-09')
assert(szxDxb.length === 1 && szxDxb[0]!.flight_no === 'EK329', 'SZX→DXB 2027-08-09 exact-date 班次 = EK329(快照原值,不是旧班 EK327)')
const ekLine = renderFlightFact(szxDxb[0]!)
assert(ekLine.includes('EK329') && ekLine.includes('00:30→04:55') && ekLine.includes('[flyai@') && ekLine.includes('#flyai:flight:深圳-迪拜:2027-08-09'),
  '渲染行:班次/时刻/证据链(source@fetched_at #query_id)全部来自结构化事实')
const codeshare: FlightFact = { ...szxDxb[0]!, fact_id: 'cs-demo000000000', flight_no: 'EK8582', marketing_carrier: '阿联酋航空', operating_carrier: '中国南方航空' }
const csLine = renderFlightFact(codeshare)
assert(csLine.includes('营销 阿联酋航空') && csLine.includes('实际承运 中国南方航空'), 'codeshare 渲染同时输出营销与实际承运(不混用)')

// ---- §4b 价格事实闸(issue #300;flight/train 共用原语,不处理酒店打码价) ---------

console.log('§4b 行内硬价格与 exact-date 事实对账')
const uo724Rendered = renderFlightFact(uo724)
const priceOk = gateArtifact(uo724Rendered, [uo724], map, { trip_year: tripYear })
assert(priceOk.verdict === 'pass' && priceOk.traceable === 1
  && !priceOk.violations.some(v => v.kind === 'price_contradicted'),
  'renderFlightFact(UO724 793 CNY) → gateArtifact 无冲突 pass')

const farePlusBudget = gateArtifact(`${uo724Rendered}；总预算¥1000`, [uo724], map, { trip_year: tripYear })
assert(farePlusBudget.verdict === 'pass' && farePlusBudget.traceable === 1 && farePlusBudget.violations.length === 0,
  'UO724 自身票价后追加总预算¥1000不串价,仍 pass')

const anchor = uo724Rendered.indexOf('<!-- fact:')
const budgetBeforeAnchor = gateArtifact(`${uo724Rendered.slice(0, anchor)}；总预算¥1000${uo724Rendered.slice(anchor)}`, [uo724], map, { trip_year: tripYear })
assert(budgetBeforeAnchor.verdict === 'pass' && budgetBeforeAnchor.violations.length === 0,
  '证据链后的总预算即使位于锚点前也不串为UO724票价')
const baggageBeforeSourceAndAnchor = gateArtifact(uo724Rendered.replace(' [flyai@', '；行李费¥50 [flyai@'), [uo724], map, { trip_year: tripYear })
assert(baggageBeforeSourceAndAnchor.verdict === 'pass' && baggageBeforeSourceAndAnchor.traceable === 1
  && baggageBeforeSourceAndAnchor.violations.length === 0,
  'canonical票价后的行李费即使位于source与锚点之前也不串为UO724票价')
const labelledMoneyField = gateArtifact(uo724Rendered.replace(' [flyai@', '；总计¥1000 [flyai@'), [uo724], map, { trip_year: tripYear })
assert(labelledMoneyField.verdict === 'pass' && labelledMoneyField.traceable === 1
  && labelledMoneyField.violations.length === 0,
  'canonical票价后的通用标签金额不被当作第二票价')
const explicitFareLabel = gateArtifact(uo724Rendered.replace('¥793', '票价¥793'), [uo724], map, { trip_year: tripYear })
assert(explicitFareLabel.verdict === 'pass' && explicitFareLabel.traceable === 1 && explicitFareLabel.violations.length === 0,
  '显式票价标签仍属于可靠 fare role')
const explicitFareField = gateArtifact(uo724Rendered.replace('¥793', '；总预算¥1000；票价¥793'), [uo724], map, { trip_year: tripYear })
assert(explicitFareField.verdict === 'pass' && explicitFareField.traceable === 1 && explicitFareField.violations.length === 0,
  '分隔后的预算字段不遮蔽后续显式票价字段')
for (const [label, renderedAmount] of [
  ['分隔后裸金额', '；¥999'],
  ['分隔后畸形金额', '；¥1,79'],
] as const) {
  const ambiguous = gateArtifact(uo724Rendered.replace('¥793', renderedAmount), [uo724], map, { trip_year: tripYear })
  assert(ambiguous.verdict === 'blocked' && ambiguous.traceable === 0
    && ambiguous.violations.some(v => v.kind === 'unverified_price_claim'),
    `${label}无可靠 fare role 必须blocked/unverified`)
}
const additionalUnlabelledAmount = gateArtifact(uo724Rendered.replace(' [flyai@', '；¥999 [flyai@'), [uo724], map, { trip_year: tripYear })
assert(additionalUnlabelledAmount.verdict === 'blocked' && additionalUnlabelledAmount.traceable === 0
  && additionalUnlabelledAmount.violations.some(v => v.kind === 'unverified_price_claim'),
  'canonical票价之外追加裸金额不得因候选列表为空而放行')

for (const [label, renderedPrice] of [['¥999', '¥999'], ['CNY 999', 'CNY 999']] as const) {
  const contradicted = gateArtifact(uo724Rendered.replace('¥793', renderedPrice), [uo724], map, { trip_year: tripYear })
  const priceViolation = contradicted.violations.find(v => v.kind === 'price_contradicted')
  assert(contradicted.verdict === 'blocked' && priceViolation !== undefined
    && /UO724/.test(priceViolation.detail) && /CNY 999/.test(priceViolation.detail) && /CNY 793/.test(priceViolation.detail),
    `UO724 行内 ${label} ≠ 事实 CNY 793 → blocked/price_contradicted(含可读对账详情)`)
}

const trainPriceFact: FlightFact = { ...uo724, kind: 'train', fact_id: makeFactId(['train-price', 'G1234']), flight_no: 'G1234' }
const trainContradicted = gateArtifact(renderFlightFact(trainPriceFact).replace(' [flyai@', ' ¥794 [flyai@'), [trainPriceFact], map, { trip_year: tripYear })
assert(trainContradicted.verdict === 'blocked'
  && trainContradicted.violations.some(v => v.kind === 'fact_anchor_unknown' && /canonical renderer/.test(v.detail)),
  'train canonical row 不自带价格,手工追加硬价破坏规范锚点后 fail-closed')

const commaFareFact: FlightFact = { ...uo724, fact_id: makeFactId(['flight-price-comma', 'UO724']), price: 1793 }
const commaFare = gateArtifact(renderFlightFact(commaFareFact).replace('¥1793', '¥1,793'), [commaFareFact], map, { trip_year: tripYear })
assert(commaFare.verdict === 'pass' && commaFare.traceable === 1 && commaFare.violations.length === 0,
  '完整解析千分位¥1,793,与事实1793一致 pass')
const malformedComma = gateArtifact(uo724Rendered.replace('¥793', '¥1,79'), [uo724], map, { trip_year: tripYear })
assert(malformedComma.verdict === 'blocked' && malformedComma.traceable === 0
  && malformedComma.violations.some(v => v.kind === 'unverified_price_claim' && /畸形|未核验|完整/.test(v.detail)),
  'canonical fare 畸形千分位¥1,79必须blocked/unverified,不得消失或截断为CNY1')

const missingSourcePrice = gateArtifact(uo724Rendered.replace('¥793', '¥999'), [{ ...uo724, price: undefined }], map, { trip_year: tripYear })
assert(missingSourcePrice.verdict === 'blocked'
  && missingSourcePrice.violations.some(v => v.kind === 'unverified_price_claim' && /权威 exact-date 事实价格/.test(v.detail)),
  '源事实缺价时渲染¥999不得冒充已核验价格 → blocked/unverified_price_claim')

const lateUnanchoredPrice = gateArtifact(
  `### 香港→普吉(7.17)\n${uo724Rendered.replace(/<!--.*?-->/g, '').replace('¥793', `${'说明'.repeat(90)} CNY 999`)}`,
  [uo724], map, { trip_year: tripYear },
)
assert(lateUnanchoredPrice.verdict === 'blocked'
  && lateUnanchoredPrice.violations.some(v => v.kind === 'unverified_price_claim' && /未锚定|抽取窗口/.test(v.detail)),
  '无锚点且价格落在120字抽取窗口外不得作为已核验 exact-date 价格 → blocked')

for (const [label, nonComparablePrice] of [
  ['缺失', '价待询'],
  ['非数字', '¥7xx'],
  ['模糊起价', '约¥999 起'],
] as const) {
  const nonComparable = gateArtifact(uo724Rendered.replace('¥793', nonComparablePrice), [uo724], map, { trip_year: tripYear })
  assert(nonComparable.verdict === 'pass' && !nonComparable.violations.some(v => v.kind === 'price_contradicted'),
    `${label}价格不作可靠硬价比较,保留既有 claim/anchor 语义不误判 price_contradicted`)
}

const unsupportedCurrency = gateArtifact(uo724Rendered.replace('¥793', 'USD999'), [uo724], map, { trip_year: tripYear })
assert(unsupportedCurrency.verdict === 'blocked'
  && unsupportedCurrency.violations.some(v => v.kind === 'unverified_price_claim' && /不支持直接比较|USD/.test(v.detail))
  && !unsupportedCurrency.violations.some(v => v.kind === 'price_contradicted'),
  'USD999 不做汇率换算,标为未核验而不得 pass')

const hotelPriceRaw = factsFromHotel({ source: 'flyai-hotel', destination: '大理', checkIn: '2026-10-01', checkOut: '2026-10-03', verdict: 'hit', options: 9, evidence: 'priceRaw=¥799', fetchedAt: '2026-09-04T00:00:00.000Z' })
const hotelMaskedPrice = gateArtifact('## 住宿\n- 大理 2026-10-01→2026-10-03 酒店有房可订 priceRaw=¥799', hotelPriceRaw, map, { trip_year: 2026 })
assert(hotelMaskedPrice.verdict === 'pass' && !hotelMaskedPrice.violations.some(v => v.kind === 'price_contradicted'),
  '酒店 priceRaw 打码/原值行不进入航班/火车硬价格对账')

// ---- §5 验收⑤:联程措辞闸 --------------------------------------------------------

console.log('§5 protected_connection 与联程措辞')
const fd597: FlightFact = {
  schema: BOOKABLE_FACT_SCHEMA, fact_id: 'fd597-demo0000000', kind: 'flight',
  route: { origin: 'SZX', destination: 'BKK' }, date: '2027-08-08', flight_no: 'FD597',
  marketing_carrier: '泰国亚洲航空', dep_local: '18:30', arr_local: '20:15', nonstop: true,
  price: 700, currency: 'CNY', tier: 'live_inventory', bookability: 'bookable_exact_date',
  source: 'flyai', query_id: 'flyai:flight:深圳-曼谷:2027-08-08', fetched_at: FETCHED, as_of: '2026-08-29',
}
const selfTransfer = renderConnection(fd597, szxDxb[0]!)
assert(selfTransfer.includes('分票/自助转机') && selfTransfer.includes('误机无保护') && !/联程\(/.test(selfTransfer),
  '两段接得上 ≠ 联程:缺 protected_connection 渲染为分票/自助转机并标红风险')
const throughA: FlightFact = { ...fd597, fact_id: 'fd597-protected00', protected_connection: true }
const throughB: FlightFact = { ...szxDxb[0]!, fact_id: 'ek329-protected00', protected_connection: true }
assert(/联程\(同一票号/.test(renderConnection(throughA, throughB)), '双腿 protected_connection=true 才允许渲染「联程(同一票号/行李直挂/误机保护)」')
const throughGate = gateArtifact(`- 深圳→曼谷 FD597 + 曼谷→迪拜 EK329:联程(同一票号)`, [throughA, throughB], map, { trip_year: tripYear })
assert(!throughGate.violations.some(v => v.kind === 'self_transfer_called_through'), 'protected_connection=true 的联程行过闸')
const stGate = gateArtifact(`- FD597 深圳→曼谷 + EK 曼谷→迪拜,建议买联程更稳`, [fd597, szxDxb[0]!], map, { trip_year: tripYear })
assert(stGate.violations.some(v => v.kind === 'self_transfer_called_through'), '「建议买联程」无 protected_connection 证据 → 违例')

// ---- §6 验收⑥:统计不变量机器断言 ----------------------------------------------

console.log('§6 行程统计不变量')
assert(itineraryInvariants(fixture.good_itinerary).length === 0, 'good itinerary 全绿:23 酒店夜 + 1 机上夜 = 24 夜;O&D/legs/预算自洽')
const goodNights = renderNightsLine(fixture.good_itinerary)
assert(goodNights.includes('24 晚 = 23 个酒店夜 + 1 个机上夜') && goodNights.includes('O&D 6 段(共 6 个 flight legs)'),
  '夜数口径机器反算:「24 晚 = 23 酒店夜 + 1 机上夜」;航班 O&D 6 段(issue:不是 7 段)')
const badViol = itineraryInvariants(fixture.bad_itinerary)
assert(badViol.some(v => v.kind === 'nights_inconsistent' && /酒店夜 23 \+ 机上夜 0 = 23 ≠ 行程总夜数 24/.test(v.detail)),
  'bad itinerary:23 酒店夜 + 0 机上夜 ≠ 24 总夜被抓(机上夜被吞,「24 天 23 晚」口径混用)')
assert(badViol.some(v => v.kind === 'budget_floor_inconsistent' && /35,500/.test(v.detail) && /30,000/.test(v.detail)),
  'bad itinerary:分项最低合计 ¥35,500 > 声称可压到 ¥30,000 被抓(issue 预算行原值)')

// ---- §7 验收⑦:政策时间边界 ------------------------------------------------------

console.log('§7 政策 as_of 与复核 gate')
const policy: PolicyFact = {
  schema: BOOKABLE_FACT_SCHEMA, fact_id: makeFactId(['policy', '泰国入境', 'web:policy:泰国免签']), kind: 'policy',
  subject: '泰国入境(中国护照)', statement: '免签停留(口径以泰方公告为准);UAE 居民返程应优先校验 residence visa / Emirates ID 而非游客免签口径',
  source: 'web:official', query_id: 'web:policy:泰国免签', fetched_at: FETCHED, as_of: '2026-08-29',
}
const policyLine = renderPolicyFact(policy, fixture.meta.trip_window[0])
assert(policyLine.includes('截至 2026-08-29 的现行政策') && policyLine.includes('2027-06-16') && !/[✓✅]/.test(policyLine),
  '政策行恒带「截至 as_of」+ D-30 复核日期(2027-06-16),永不用无条件 ✓')
const policyBad = gateArtifact('| 泰国 | 中国护照免签(现行60天/次),停留2周无问题 |', registry, map, { trip_year: tripYear })
assert(policyBad.violations.some(v => v.kind === 'policy_without_as_of'), '「现行60天」无具体 as_of 日期 = policy_without_as_of(现行 ≠ 时间边界)')
const policyGood = gateArtifact(policyLine, registry, map, { trip_year: tripYear, tripStart: fixture.meta.trip_window[0] })
assert(!policyGood.violations.some(v => v.kind === 'policy_without_as_of'), '带「截至 YYYY-MM-DD」的政策行过闸')

// ---- §8 回头路检测 --------------------------------------------------------------

console.log('§8 回头路检测')
const bt = detectBacktrack(['HKT', 'KBV', 'HKT', 'BKK'], new Set(['KBV-BKK']))
assert(bt.length === 1 && bt[0]!.path.join('→') === 'HKT→KBV→HKT' && (bt[0]!.suggestion ?? '').includes('KBV→BKK'),
  'Phuket→Krabi→Phuket 回头路被抓;KBV→BKK 直飞存在 → 最小改动建议')
assert(detectBacktrack(['HKT', 'KBV', 'BKK'], new Set(['KBV-BKK'])).length === 0, 'good route(普吉→甲米→曼谷)无回头路不误报')

// ---- §9 验收①⑧:全产物闸 golden E2E ----------------------------------------------

console.log('§9 全产物闸 golden E2E(bad blocked / good pass)')

// 复刻 2026-08-29 会话产物的违例行(issue #46 证据表逐行对应)
const badArtifact = `# 2027年7-8月 迪拜→深圳/香港→普吉/甲米→曼谷→云南→迪拜 24天行程规划(v2)

## 一、行程总览
| 日期 | 星期 | 行程 | 交通 | 住宿 |
|---|---|---|---|---|
| 07-16 | 周五 | 迪拜 → 深圳或香港(晚间到) | EK328/FZ/QR(见段1) | 香港尖沙咀 |
| 07-17 | 周六 | 上午香港办银行开户+保险签约 → 下午飞普吉 | UO784 香港15:35→普吉18:10 ✓ | 普吉·查龙 |
| 08-08 | 周日 | 丽江→深圳 → 深夜红眼回迪拜 | MF1538/8L + EK327 | 机上/钟点房 |

**共 24 天 23 晚** ✓

## 二、机票
### 段1|迪拜→香港/深圳(7.16 周五)
| 方案 | 航班 | 时长 | 说明 |
|---|---|---|---|
| 快+顺(推荐) | EK328 直飞深圳 | 迪拜10:05→深圳约22:50 | 原方案 |
| 省钱版(落香港) | flydubai FZ 直飞香港 | 约7h15m | 廉航直飞 |

### 段2|香港→普吉(7.17 周六)
| 方案 | 航班 | 时刻 |
|---|---|---|
| 首选 | UO784 香港快运直飞 | 香港15:35→普吉18:10 |
| 舒适 | CX787 国泰直飞 | 香港约08:40→普吉约12:20 |

### 段3|普吉→曼谷(7.30 周五晚)
| 航班 | 落点 |
|---|---|
| FD/VZ(亚航/越捷) | 廊曼DMK |

### 段4|曼谷→昆明(8.1 周日晚)
| 航班 | 说明 |
|---|---|
| MU 东航直飞(每日4-5班) | 提前出票 |
| 8L 祥鹏直飞(若有当日班) | 备选比价 |

### 段6|丽江→深圳(8.8 周日)
| 方案 | 说明 |
|---|---|
| MF1538 厦航直飞 11:13→13:19 | 首选 |

### 段7|深圳→迪拜(8.8 深夜 / 8.9 凌晨)
| 方案 | 时刻 |
|---|---|
| EK327 直飞(推荐) | 深圳约00:30→迪拜约04:30 |
| 省钱:FD597 深圳→曼谷 + EK 曼谷→迪拜,建议买 EK 联程 | 到迪拜约04:30 |

### 段8|女友去程:南京→普吉(7.17)
直飞:东航 南京→普吉(白天班,约17:00到)

## 五、证件与政策
| 目的地 | 政策 |
|---|---|
| 泰国 | 中国护照免签(现行60天/次),停留2周无问题 |
| 迪拜 | 中国护照免签30天 |

预算可压到 ¥30,000
`

const badReport = gateArtifact(badArtifact, registry, map, { trip_year: tripYear, itinerary: fixture.bad_itinerary })
const badKinds = new Set(badReport.violations.map(v => v.kind))
const expectedKinds: GateViolationKind[] = [
  'not_in_source',            // UO784 / CX787 / MF1538 / EK327 / 8L / 东航南京直飞…
  'contradicted',             // EK328 旧航季时刻(10:05→22:50 vs 快照 11:00→22:40)
  'airport_mapping_conflict', // FD/VZ 均落 DMK
  'self_transfer_called_through', // 「建议买 EK 联程」
  'policy_without_as_of',     // 免签政策无截至日期
  'unconditional_check',      // UO784 行的 ✓
  'nights_inconsistent',      // 22+0 ≠ 24
  'budget_floor_inconsistent',// 35,500 vs 30,000
]
assert(badReport.schema === ARTIFACT_GATE_SCHEMA && badReport.verdict === 'blocked'
  && badReport.presentation === 'verified_label_forbidden',
  'bad artifact:闸 blocked 且禁止「已验证方案」措辞')
for (const k of expectedKinds) {
  assert(badKinds.has(k), `bad artifact 违例类别覆盖:${k}`)
}
assert(badReport.violations.filter(v => v.kind === 'not_in_source').some(v => v.detail.startsWith('UO784')),
  'UO784 被逐条点名(验收②:任何产物中不得出现该班次)')
assert(!badReport.violations.some(v => v.detail.startsWith('MU9626') || /MU 东航直飞/.test(v.detail) && v.kind === 'not_in_source'),
  '已核验的 MU 东航直飞(BKK→KMG 在架)不误伤')

// good artifact:全部班次行由结构化事实渲染(渲染层零记忆)
const goodFlights = [
  latestFactsForRouteDate(registry, 'DXB', 'HKG', '2027-07-16')[0]!,
  latestFactsForRouteDate(registry, 'HKG', 'HKT', '2027-07-18')[0]!,
  latestFactsForRouteDate(registry, 'KBV', 'BKK', '2027-07-30')[0]!,
  latestFactsForRouteDate(registry, 'BKK', 'KMG', '2027-08-01')[0]!,
  latestFactsForRouteDate(registry, 'LJG', 'SZX', '2027-08-08')[0]!,
  szxDxb[0]!,
]
const goodArtifact = [
  `# 2027-07-16 → 2027-08-09 行程(事实闸渲染面)`,
  '',
  renderNightsLine(fixture.good_itinerary),
  '',
  '## 航班(逐条可回溯)',
  ...goodFlights.map(renderFlightFact),
  '',
  '## 政策',
  renderPolicyFact(policy, fixture.meta.trip_window[0]),
  renderPolicyFact({ ...policy, fact_id: makeFactId(['policy', '迪拜入境', 'web:policy:uae-resident']), subject: '迪拜入境(UAE 居民返程)', statement: '优先校验 residence visa / Emirates ID;游客免签口径不适用居民返程' }, fixture.meta.trip_window[0]),
].join('\n')
const goodReport = gateArtifact(goodArtifact, [...registry, policy, { ...policy, fact_id: makeFactId(['policy', '迪拜入境', 'web:policy:uae-resident']), subject: '迪拜入境(UAE 居民返程)', statement: '优先校验 residence visa / Emirates ID;游客免签口径不适用居民返程' }], map, { trip_year: tripYear, itinerary: fixture.good_itinerary, tripStart: fixture.meta.trip_window[0] })
assert(goodReport.verdict === 'pass' && goodReport.presentation === 'verified_itinerary_allowed'
  && goodReport.traceable === 8 && goodReport.violations.length === 0,
  `good artifact:6 航班 + 2 政策 claim 全回溯,闸 pass(违例 ${goodReport.violations.length},traceable=${goodReport.traceable})`)
assert(goodFlights.every(f => f.bookability === 'bookable_exact_date' && f.query_id.includes('flyai:flight:')),
  'good artifact 的每个可下单事实均可回溯到 tool result/query id(验收⑧)')

// ---------------------------------------------------------------------------
// §9b 混合机票/车次 claim(issue #299):分类独立 + rail fail-closed
// ---------------------------------------------------------------------------
{
  const czFlight = factsFromFlyai(
    { kind: 'flight', origin: '香港', destination: '普吉', date: '2027-07-17' },
    { verdict: 'hit', options: [{ no: 'CZ8582', depDateTime: '2027-07-17T08:00:00', arrDateTime: '2027-07-17T12:00:00' }] },
    FETCHED,
    alias,
  )[0]!
  const gTrain = factsFromFlyai(
    { kind: 'train', origin: '香港', destination: '普吉', date: '2027-07-17' },
    { verdict: 'hit', options: [{ no: 'G1234', depDateTime: '2027-07-17T09:00:00', arrDateTime: '2027-07-17T13:00:00' }] },
    FETCHED,
    alias,
  )[0]!
  const nineCFlight = factsFromFlyai(
    { kind: 'flight', origin: '香港', destination: '普吉', date: '2027-07-17' },
    { verdict: 'hit', options: [{ no: '9C8781', depDateTime: '2027-07-17T10:00:00', arrDateTime: '2027-07-17T14:00:00' }] },
    FETCHED,
    alias,
  )[0]!
  const otherTrainFacts = ['D3112', 'C2001', 'Z9999'].flatMap(no => factsFromFlyai(
    { kind: 'train', origin: '香港', destination: '普吉', date: '2027-07-17' },
    { verdict: 'hit', options: [{ no, depDateTime: '2027-07-17T09:00:00', arrDateTime: '2027-07-17T13:00:00' }] },
    FETCHED,
    alias,
  ))
  const mixedText = '### 段｜香港→普吉(7.17)\n- CZ8582 08:00→12:00；9C8781 10:00→14:00；G1234 09:00→13:00；D3112 09:10→13:10；C2001 09:20→13:20；Z9999 09:30→13:30'
  const mixedClaims = extractClaims(mixedText, map, { trip_year: tripYear })
  assert(['CZ8582', '9C8781'].every(no => mixedClaims.flights.some(c => c.flight_no === no))
    && !mixedClaims.flights.some(c => ['G1234', 'D3112', 'C2001', 'Z9999'].includes(c.flight_no)),
    '混合产物:合法双字母航司 CZ8582/9C8781 保留,单字母车次不进入 flights')
  assert(mixedClaims.trains.length === 4
    && ['G1234', 'D3112', 'C2001', 'Z9999'].every(no => mixedClaims.trains.some(c => c.flight_no === no)),
    '混合产物:G/D/C/Z 完整车次进入独立 trains claim 集合')
  const codeBoundaryClaims = extractClaims('CA1234 MU1234 CZ8582 G1234 D3112 C2001 Z9999', map, { trip_year: tripYear })
  assert(['CA1234', 'MU1234', 'CZ8582'].every(no => codeBoundaryClaims.flights.some(c => c.flight_no === no))
    && !codeBoundaryClaims.flights.some(c => ['G1234', 'D3112', 'C2001', 'Z9999'].includes(c.flight_no))
    && ['G1234', 'D3112', 'C2001', 'Z9999'].every(no => codeBoundaryClaims.trains.some(c => c.flight_no === no)),
  '边界分类:CA/MU/CZ 双字母航司保留,G/D/C/Z 完整车次仅进入 trains')

  const flightOnly = gateArtifact(mixedText, [czFlight, nineCFlight], map, { trip_year: tripYear })
  assert(flightOnly.verdict === 'blocked'
    && flightOnly.violations.some(v => v.kind === 'rail_claim_unverified' && v.detail.startsWith('G1234'))
    && !flightOnly.violations.some(v => v.kind === 'not_in_source' && v.detail.startsWith('G1234'))
    && flightOnly.traceable === 2,
  '缺 train source 时仅 rail_claim_unverified;航班 authority 独立且 CZ8582/9C8781 仍 traceable')
  assert(flightClaimVerdict([gTrain], { flight_no: 'CZ8582', origin: 'HKG', destination: 'HKT', date: '2027-07-17' }).verdict === 'route_unqueried',
    'flightClaimVerdict 只看 kind=flight,同 route/date train 事实不制造 flight not_in_source')
  assert(railClaimVerdict([czFlight, gTrain], { flight_no: 'G1234', origin: 'HKG', destination: 'HKT', date: '2027-07-17' }).verdict === 'traceable',
    'railClaimVerdict 只看 kind=train + exact date + route/code + bookable + structured source')
  assert(railClaimVerdict([gTrain], { flight_no: 'G1234' }).verdict === 'rail_claim_unverified'
    && gateArtifact('- G1234 09:00→13:00', [gTrain], map, { trip_year: tripYear }).violations.some(v => v.kind === 'rail_claim_unverified'),
  '无 route/date 的 unanchored rail claim 即使同号事实存在也 fail-closed')
  const newerTrainMiss = negativeFact(
    'flyai:train:香港-普吉:2027-07-17', 'train', '香港', '普吉', '2027-07-17', 'flyai', '2026-08-30T00:00:00.000Z', alias,
  )
  assert(railClaimVerdict([gTrain, newerTrainMiss], { flight_no: 'G1234', origin: 'HKG', destination: 'HKT', date: '2027-07-17' }).verdict === 'not_in_source',
  '旧 train hit + 新 train miss/unavailable 批次不得继续 traceable')
  assert(railClaimVerdict([
    { ...gTrain, fetched_at: '2026-08-28T00:00:00.000Z' },
    { ...czFlight, fetched_at: '2026-08-30T00:00:00.000Z' },
  ], { flight_no: 'D3112', origin: 'HKG', destination: 'HKT', date: '2027-07-17' }).verdict === 'not_in_source'
    && flightClaimVerdict([
      { ...czFlight, fetched_at: '2026-08-28T00:00:00.000Z' },
      { ...gTrain, fetched_at: '2026-08-30T00:00:00.000Z' },
    ], { flight_no: 'MU9999', origin: 'HKG', destination: 'HKT', date: '2027-07-17' }).verdict === 'not_in_source',
  '最新批次按 kind 隔离:更新的 flight 不遮蔽 train,更新的 train 不遮蔽 flight')
  assert(railClaimVerdict([{ ...gTrain, source: 'static-schedule', query_id: 'static:train:HKG-HKT:2027-07-17' }], { flight_no: 'G1234', origin: 'HKG', destination: 'HKT', date: '2027-07-17' }).verdict === 'route_unqueried',
    'static-schedule train 不是 rail structured source,不得伪造 traceable')

  const railGood = gateArtifact(mixedText, [czFlight, nineCFlight, gTrain, ...otherTrainFacts], map, { trip_year: tripYear })
  assert(railGood.verdict === 'pass' && railGood.traceable === 6 && railGood.violations.length === 0,
    '显式 kind=train exact-date fixture 仅经 rail verdict 回溯,混合产物 pass')
  const trainRendered = renderFlightFact(gTrain)
  const trainRenderedGate = gateArtifact(trainRendered, [gTrain], map, { trip_year: tripYear })
  assert(trainRendered.includes(`<!-- fact:${gTrain.fact_id} -->`)
    && trainRendered.includes('车次')
    && !trainRendered.includes('直飞')
    && !trainRendered.includes('¥')
    && !trainRendered.includes('价待询')
    && trainRenderedGate.verdict === 'pass' && trainRenderedGate.traceable === 1,
  'train canonical renderer 保留 typed anchor,只写车次语义且不伪造直飞/价格,可经 gate 回溯')
  const trainAnchorTamperCases = [
    ['车次', trainRendered.replace('G1234', 'G9999')],
    ['出发时间', trainRendered.replace('09:00', '06:00')],
    ['日期', trainRendered.replace('2027-07-17', '2027-11-12')],
    ['route', trainRendered.replace(`${gTrain.route.origin}→${gTrain.route.destination}`, `${gTrain.route.origin}→DIFF`)],
  ] as const
  assert(trainAnchorTamperCases.every(([, tampered]) => {
    const report = gateArtifact(tampered, [gTrain], map, { trip_year: tripYear })
    return report.verdict === 'blocked' && report.violations.some(v => v.kind === 'fact_anchor_unknown')
  }), 'train canonical anchor 篡改车次/出发时间/日期/route 均被 fact_anchor_unknown 拒绝')

  assert(factsFromFlyai(
    { kind: 'train', origin: '上海', destination: '昆明', date: '2027-12-01' },
    { verdict: 'error' }, FETCHED, alias,
  ).length === 0,
  'train source error 不落负事实;通道无结论不是 rail evidence')
  assert(parseLeftTicketQuery('not json', 'https://kyfw.12306.cn/otn/leftTicket/init').length === 0
    && parseLeftTicketQuery('{"data":{"result":[]}}', 'https://kyfw.12306.cn/otn/leftTicket/init').length === 0,
  '12306 malformed/empty body 只返回空解析结果,不转成 train negative fact')
}

// ---------------------------------------------------------------------------
// §10 酒店事实闸(D-26,issue #118):酒店 claim 入闸 + 渲染原语单向生成
// ---------------------------------------------------------------------------
{
  const fetchedAt = '2026-09-04T00:00:00.000Z'
  // 10a. 摸底(未定档期)不落账;needs-setup/error 传输失败不落负事实
  assert(factsFromHotel({ source: 'flyai-hotel', destination: '大理', verdict: 'hit', options: 9, evidence: 'e', fetchedAt }).length === 0,
    '摸底(无档期)酒店检索不落账(无 exact-date 语义)')
  assert(factsFromHotel({ source: 'flyai-hotel', destination: '大理', checkIn: '2026-10-01', checkOut: '2026-10-03', verdict: 'needs-setup', options: 0, evidence: 'e', fetchedAt }).length === 0
    && factsFromHotel({ source: 'flyai-hotel', destination: '大理', checkIn: '2026-10-01', checkOut: '2026-10-03', verdict: 'error', options: 0, evidence: 'e', fetchedAt }).length === 0,
    'needs-setup/error 传输失败永不落负事实(ADR-19 不变量)')
  // 10b. hit/miss 落账 + 打码纪律(不落数字价)
  const hitFacts = factsFromHotel({ source: 'flyai-hotel', destination: '大理', checkIn: '2026-10-01', checkOut: '2026-10-03', verdict: 'hit', options: 9, evidence: 'e', fetchedAt })
  const missFacts = factsFromHotel({ source: 'session:ctrip-hotel', destination: '大理', checkIn: '2026-10-01', checkOut: '2026-10-03', verdict: 'miss', options: 0, evidence: 'e', fetchedAt })
  assert(hitFacts.length === 1 && hitFacts[0]!.bookability === 'bookable_exact_date' && hitFacts[0]!.options_masked === 9,
    'exact-date hit → 正事实(在架家数,无数字价字段)')
  assert(!('price' in (hitFacts[0] as unknown as Record<string, unknown>)), '酒店事实无 price 字段(打码价保真,不落数字价)')
  assert(missFacts.length === 1 && missFacts[0]!.bookability === 'unavailable_exact_date', 'exact-date miss → 负事实')
  // 10c. 渲染原语单向生成:renderHotelFact 行带锚点,闸锚点回溯 pass
  const hotelLine = renderHotelFact(hitFacts[0]!)
  assert(hotelLine.includes(`fact:${hitFacts[0]!.fact_id}`), 'renderHotelFact 行内嵌 fact 锚点')
  const anchoredArtifact = ['## 住宿', hotelLine].join('\n')
  const anchoredReport = gateArtifact(anchoredArtifact, [...hitFacts], map, { trip_year: 2026 })
  assert(anchoredReport.verdict === 'pass' && anchoredReport.traceable === 1,
    `锚点酒店行 → 锚点确定性回溯 pass(实际 ${anchoredReport.verdict}/traceable=${anchoredReport.traceable})`)
  // 10d. 手改锚点 → fact_anchor_unknown(伪造即抓)
  const forged = anchoredArtifact.replace(hitFacts[0]!.fact_id, '0123456789abcdef')
  const forgedReport = gateArtifact(forged, [...hitFacts], map, { trip_year: 2026 })
  assert(forgedReport.violations.some(v => v.kind === 'fact_anchor_unknown'), '手改/伪造锚点 → fact_anchor_unknown')
  // 10e. 无锚点启发式:hit 在册 → traceable;exact-date miss 在册却写有房 → not_in_source + 无条件✓
  const claimHit = gateArtifact('## 住宿\n- 大理 2026-10-01→2026-10-03 洱海民宿有房可订', [...hitFacts], map, { trip_year: 2026 })
  assert(claimHit.verdict === 'pass' && claimHit.traceable === 1, '启发式酒店 claim 命中在册 hit → traceable')
  const claimMiss = gateArtifact('## 住宿\n- 大理 2026-10-01→2026-10-03 洱海民宿有房可订 ✓', [...missFacts], map, { trip_year: 2026 })
  assert(claimMiss.violations.some(v => v.kind === 'not_in_source'), 'exact-date miss 在册却写有房 → not_in_source')
  assert(claimMiss.violations.some(v => v.kind === 'unconditional_check'), '对未核验酒店用 ✓ → unconditional_check')
  // 10f. 无目的地上下文的可住断言 → fail-closed
  const noCtx = gateArtifact('## 住宿\n- 住宿:湖景房有房可订 ✓', [], map, { trip_year: 2026 })
  assert(noCtx.violations.some(v => v.kind === 'unverifiable_hotel_claim'), '缺目的地上下文 → unverifiable_hotel_claim(fail closed)')
  console.log(`  ok - §10 酒店事实闸(D-26)八断言完成`)
}

// ---------------------------------------------------------------------------
// §11 政策渲染锚点 + 海关申报关键词覆盖(issue #273,D-26 残余收口)
// ---------------------------------------------------------------------------
{
  const policyUaE = { ...policy, fact_id: makeFactId(['policy', '迪拜入境', 'web:policy:uae-resident']), subject: '迪拜入境(UAE 居民返程)', statement: '优先校验 residence visa / Emirates ID;游客免签口径不适用居民返程' }
  const policyLine11 = renderPolicyFact(policy, fixture.meta.trip_window[0])
  // 11a. 渲染器输出自带 fact 锚点(确定性回溯,与航班/酒店同源)
  assert(policyLine11.includes(`<!-- fact:${policy.fact_id} -->`), 'renderPolicyFact 行内嵌 fact 锚点(issue #273 typed-anchor 闭合)')
  // 11b. 锚点 policy 走确定性回溯 = traceable(锚点行启发式让位)
  //      历史 #273 形态:renderer 给 tripStart,闸侧仅 { trip_year } —— 兼容性保留。
  const anchoredPolicyArtifact = ['## 政策', policyLine11].join('\n')
  const anchoredPolicyReport = gateArtifact(anchoredPolicyArtifact, [policy], map, { trip_year: tripYear })
  assert(anchoredPolicyReport.verdict === 'pass' && anchoredPolicyReport.traceable === 1,
    `政策锚点行 → 锚点确定性回溯 pass(实际 ${anchoredPolicyReport.verdict}/traceable=${anchoredPolicyReport.traceable})`)
  // 11c. 手改锚点 → fact_anchor_unknown(伪造即抓,与酒店锚点一致)
  const forgedPolicyArtifact = anchoredPolicyArtifact.replace(policy.fact_id, '0123456789abcdef')
  const forgedPolicyReport = gateArtifact(forgedPolicyArtifact, [policy], map, { trip_year: tripYear })
  assert(forgedPolicyReport.violations.some(v => v.kind === 'fact_anchor_unknown'), '手改政策锚点 → fact_anchor_unknown(与酒店锚点同源 fail-closed)')
  // 11d. 海关申报 缺 as_of → policy_without_as_of(red→green:原 regex 漏掉,新增关键词后 fail-closed)
  const customsNoAsOf = gateArtifact('| 美国 | 海关申报需在线填写(现行 30 日内单次) |', registry, map, { trip_year: tripYear })
  assert(customsNoAsOf.violations.some(v => v.kind === 'policy_without_as_of'),
    '「海关申报」缺 as_of → policy_without_as_of(D-26 残余:边界关键词覆盖)')
  // 11e. 海关申报 带「截至 YYYY-MM-DD」过闸(确保新增关键词不影响已守纪产物)
  const customsAsOf = gateArtifact('| 美国 | 海关申报需在线填写(截至 2026-08-29 现行 30 日内单次) |', registry, map, { trip_year: tripYear })
  assert(!customsAsOf.violations.some(v => v.kind === 'policy_without_as_of'),
    '「海关申报」带截至日期过闸(关键词扩展不误伤)')

  // 11f. 完整 16-hex 形态但不在注册表 → fact_anchor_unknown(独立伪造,非替换)
  //     11c 是替换已有锚点;11f 是凭空追加一个不属于任何事实的锚点。
  const phantomAnchor = `## 政策\n- 幻影政策:截至 2026-08-29 的现行政策——幻影 [web:phantom@2026-08-29 #web:policy:phantom] <!-- fact:deadbeefdeadbeef -->`
  const phantomReport = gateArtifact(phantomAnchor, [policy], map, { trip_year: tripYear })
  assert(phantomReport.violations.some(v => v.kind === 'fact_anchor_unknown' && /deadbeefdeadbeef/.test(v.detail)),
    '凭空追加非注册表 fact_id(完整 16-hex)→ fact_anchor_unknown')

  // 11g. 锚点 + 手改 as_of(改了"截至 YYYY-MM-DD"日期)
  const asOfMutation = policyLine11.replace(/截至\s*\d{4}-\d{2}-\d{2}/, '截至 2027-01-01')
  const asOfReport = gateArtifact(['## 政策', asOfMutation].join('\n'), [policy], map, { trip_year: tripYear })
  assert(asOfReport.violations.some(v => v.kind === 'fact_anchor_unknown' && /2027-01-01/.test(v.detail)),
    `锚点 + 改写 as_of 2027-01-01 → fact_anchor_unknown(内容指纹形态;实际 ${asOfReport.violations.length} 条违例)`)
  // 11h. 锚点 + 删除截至日期 → 同样 fail-closed,不因缺少可比较值而放行。
  const asOfRemoved = policyLine11.replace(/截至\s*\d{4}-\d{2}-\d{2}\s*的现行政策——/, '现行政策——')
  const asOfRemovedReport = gateArtifact(['## 政策', asOfRemoved].join('\n'), [policy], map, { trip_year: tripYear })
  assert(asOfRemovedReport.violations.some(v => v.kind === 'fact_anchor_unknown' && /缺少截至日期|内容指纹不符/.test(v.detail)),
    `锚点 + 删除截至日期 → fact_anchor_unknown(缺失内容指纹;实际 ${asOfRemovedReport.violations.length} 条违例)`)
  console.log(`  ok - §11 政策渲染锚点 + 海关申报关键词 fail-closed 八断言完成`)
}

// ---------------------------------------------------------------------------
// §12 酒店非关键词 category + lodging heading depth(issues #301,#273)
// ---------------------------------------------------------------------------
{
  const fetchedAt = '2026-09-04T00:00:00.000Z'
  // 12a. 5 类非关键词住宿 category,缺档期事实 → unverifiable_hotel_claim + unconditional_check
  //     精品酒店 沿用现有 酒店 token,本切片不重复声明
  for (const cat of ['度假村', '青旅', '青年旅舍', '别墅', '公寓']) {
    const claim = gateArtifact(`## 住宿\n- 大理 2026-10-01→2026-10-03 ${cat}有房可订 ✓`, [], map, { trip_year: 2026 })
    assert(claim.violations.some(v => v.kind === 'unverifiable_hotel_claim'),
      `${cat} 缺档期事实 → unverifiable_hotel_claim`)
    assert(claim.violations.some(v => v.kind === 'unconditional_check'),
      `${cat} 缺事实 + ✓ → unconditional_check`)
  }
  // 12b. 命中在册 hit 时 traceable pass(非关键词 category 也走通)
  const daliHit = factsFromHotel({ source: 'flyai-hotel', destination: '大理', checkIn: '2026-10-01', checkOut: '2026-10-03', verdict: 'hit', options: 9, evidence: 'e', fetchedAt })
  const daliTrace = gateArtifact('## 住宿\n- 大理 2026-10-01→2026-10-03 度假村有房可订', [...daliHit], map, { trip_year: 2026 })
  assert(daliTrace.verdict === 'pass' && daliTrace.traceable === 1,
    `度假村 命中在册 hit → traceable pass(实际 ${daliTrace.verdict}/traceable=${daliTrace.traceable})`)
  // 12c. legacy 兜底保留:行内含 住宿 token 的 住宿:湖景房有房可订 ✓ 仍入闸
  const lake = gateArtifact('## 住宿\n- 住宿:湖景房有房可订 ✓', [], map, { trip_year: 2026 })
  assert(lake.violations.some(v => v.kind === 'unverifiable_hotel_claim'),
    'legacy 行内 住宿:湖景房有房可订 ✓ 兜底保留(行内 token)')

  // 12d. ATX 1–6 lodging heading 激活
  for (const [level, hashes] of [[1, '#'], [2, '##'], [3, '###'], [4, '####'], [5, '#####'], [6, '######']] as const) {
    const r = gateArtifact(`${hashes} 住宿\n- 湖景房有房可订 ✓`, [], map, { trip_year: 2026 })
    assert(r.violations.some(v => v.kind === 'unverifiable_hotel_claim'),
      `ATX ${level} lodging heading 激活(contextual 行入闸)`)
  }
  // 12e. 住宿 heading 下更深 non-lodging 子标题保留外层 lodging context
  const deeperNonLodging = gateArtifact('## 住宿\n### 湖景房\n- 有房可订', [], map, { trip_year: 2026 })
  assert(deeperNonLodging.violations.some(v => v.kind === 'unverifiable_hotel_claim'),
    '更深 non-lodging 子标题继承 lodging context(## 住宿 → ### 湖景房)')
  // 12f. 住宿 heading 下更深 lodging 子标题保留外层 context(栈不丢外层)
  const deeperLodging = gateArtifact('## 住宿\n#### 酒店\n### 湖景房\n- 有房可订', [], map, { trip_year: 2026 })
  const fViolations = deeperLodging.violations.filter(v => v.kind === 'unverifiable_hotel_claim')
  assert(fViolations.length === 1 && fViolations[0]!.line === 4,
    `更深 lodging 子标题栈保留外层(实际 ${fViolations.length} 条,line=${fViolations.map(v => v.line).join(',')})`)
  // 12g. 同级 non-lodging heading 退出(精确 line 归属)
  const sameLevelExit = gateArtifact('## 住宿\n- 湖景房有房可订 ✓\n## 航班\n- 湖景房有房可订', [], map, { trip_year: 2026 })
  const gViolations = sameLevelExit.violations.filter(v => v.kind === 'unverifiable_hotel_claim')
  assert(gViolations.length === 1 && gViolations[0]!.line === 2,
    `同级 non-lodging heading 退出(实际 ${gViolations.length} 条,line=${gViolations.map(v => v.line).join(',')})`)
  // 12h. 更高 non-lodging heading 退出
  const higherExit = gateArtifact('## 住宿\n- 湖景房有房可订 ✓\n# 航班\n- 湖景房有房可订', [], map, { trip_year: 2026 })
  const hViolations = higherExit.violations.filter(v => v.kind === 'unverifiable_hotel_claim')
  assert(hViolations.length === 1 && hViolations[0]!.line === 2,
    `更高 non-lodging heading 退出(实际 ${hViolations.length} 条,line=${hViolations.map(v => v.line).join(',')})`)
  // 12i. 同级 lodging heading 替换该层(栈仍能激活后续)
  const sameLevelLodging = gateArtifact('## 住宿\n- 湖景房有房可订 ✓\n## 酒店\n- 湖景房有房可订', [], map, { trip_year: 2026 })
  assert(sameLevelLodging.violations.filter(v => v.kind === 'unverifiable_hotel_claim').length === 2,
    `同级 lodging heading 替换该层,后续行仍入闸(实际 ${sameLevelLodging.violations.length} 条)`)
  // 12j. 无任何 heading 时,裸「湖景房有房可订」不进 hotel claim
  const noHeader = gateArtifact('- 湖景房有房可订 ✓', [], map, { trip_year: 2026 })
  assert(!noHeader.violations.some(v => v.kind === 'unverifiable_hotel_claim'),
    '无 heading 上下文时裸「湖景房有房可订 ✓」不升为 hotel claim')
  // 12k. lodging heading 下裸 ✓/✅ 不构成 bookability(根实测 #347 反馈补)
  const bareCheck = gateArtifact('## 住宿\n- 靠近地铁 ✓', [], map, { trip_year: 2026 })
  assert(!bareCheck.violations.some(v => v.kind === 'unverifiable_hotel_claim'),
    'lodging heading 下裸 ✓/✅ 不构成 bookability(靠近地铁 ✓ 不入闸)')
  // 12l. contextual 可订短语不带 ✓ 也入闸;带 ✓ 才加 unconditional_check
  const ctxNoCheck = gateArtifact('## 住宿\n- 湖景房有房可订', [], map, { trip_year: 2026 })
  assert(ctxNoCheck.violations.some(v => v.kind === 'unverifiable_hotel_claim') && !ctxNoCheck.violations.some(v => v.kind === 'unconditional_check'),
    'contextual 可订短语不带 ✓ → unverifiable_hotel_claim only')
  const ctxCheck = gateArtifact('## 住宿\n- 湖景房有房可订 ✓', [], map, { trip_year: 2026 })
  assert(ctxCheck.violations.some(v => v.kind === 'unverifiable_hotel_claim') && ctxCheck.violations.some(v => v.kind === 'unconditional_check'),
    'contextual 可订短语带 ✓ → 两违例(无 unconditional_check → 漏报)')
  console.log(`  ok - §12 完成(booking heading depth + contextual bookability phrase 分流)`)
}

// ---------------------------------------------------------------------------
// §13 政策关键词扩词(issue #302,父 #273,D-26 残余收口切片)
//     扩词仅限父 issue 显式列举的有限并集,不做 NLP/同义词扩展。
//     测试 fixture = 语法占位,不对现实政策内容做任何断言。仅验证
//     POLICY_WORD regex + AS_OF_WORD 时间边界,不引入 country/rule/value。
// ---------------------------------------------------------------------------
{
  const policyTerms: ReadonlyArray<string> = [
    'EVUS', 'ETA', 'eVisa', '疫苗', '疫苗接种', '健康申报', '隔离', '工作签', '居留', '返程签', '护照有效期', '黄皮书', '保险',
  ]
  const fixtureAsOf = '2026-08-29'
  // 13a. 13 个 policy term 缺 as_of → policy_without_as_of(占位字符串)
  for (const term of policyTerms) {
    const missingLine = `| fixture | ${term} 政策断言测试占位 |`
    const blocked = gateArtifact(missingLine, registry, map, { trip_year: tripYear })
    assert(blocked.violations.some(v => v.kind === 'policy_without_as_of'),
      `政策词 ${term} 缺 as_of → policy_without_as_of`)
  }
  // 13b. 13 个 term 带「截至 2026-08-29」过闸(占位字符串)
  for (const term of policyTerms) {
    const okLine = `| fixture | ${term} 政策断言测试占位(截至 ${fixtureAsOf}) |`
    const passed = gateArtifact(okLine, registry, map, { trip_year: tripYear })
    assert(!passed.violations.some(v => v.kind === 'policy_without_as_of'),
      `政策词 ${term} 带截至日期过闸(关键词扩展不误伤)`)
  }
  // 13c. 拉丁 token 大小写不敏感(EVUS/Evus/evus 同命中)
  const mixedCase = gateArtifact(`| fixture | evus 政策断言测试占位 |`, registry, map, { trip_year: tripYear })
  assert(mixedCase.violations.some(v => v.kind === 'policy_without_as_of'),
    '拉丁 token 大小写不敏感(evus → policy_without_as_of)')
  // 13d. 拉丁 token 不嵌入更长拉丁词(REVUS 不会被 EVUS 误抓)
  const embeddedNo = gateArtifact(`| fixture | REVUSIN 政策断言测试占位 |`, registry, map, { trip_year: tripYear })
  assert(!embeddedNo.violations.some(v => v.kind === 'policy_without_as_of'),
    '拉丁 token 边界(REVUS 不被 EVUS 嵌入匹配)→ 不误伤')
  // 13e. 不扩词到宽 NLP/同义词/自由政策词表(如「过境」单独不被命中,只命中过境免)
  const narrow = gateArtifact(`| fixture | 过境 政策断言测试占位 |`, registry, map, { trip_year: tripYear })
  assert(!narrow.violations.some(v => v.kind === 'policy_without_as_of'),
    '窄词表边界:「过境」单独不被命中(只命中「过境免」)')
  console.log(`  ok - §13 政策关键词扩词完成(13 个 fixture-only policy term,占位字符串,无真实政策内容)`)
}

// ---------------------------------------------------------------------------
// §14 政策渲染锚点全字段内容指纹(issue #359,D-26 残余收口):
//     父 #273 要求 anchored policy 行「fact_id + as_of」与事实一致;
//     改 subject / statement / source / fetched_at / query_id 而保留
//     fact_id + as_of 在原 main 会被静默 pass——issue #359 收口。
//     收口形态 = 闸侧用单一 canonical body 全文比对(不靠宽松 substring
//     匹配),subject/statement/source/fetched_at/query_id 任一不一致
//     → fact_anchor_unknown,与未知锚点同源 fail-closed。
//     legitimate review_by(事实自带)与 tripStart 派生的复核提醒两种合法
//     形态保留,不得通过删除提醒或删除正例得到 green。
// ---------------------------------------------------------------------------
{
  const factIdBase = makeFactId(['policy-359', '泰国免签'])
  const basePolicy: PolicyFact = {
    schema: BOOKABLE_FACT_SCHEMA, fact_id: factIdBase, kind: 'policy',
    subject: '泰国入境(中国护照)', statement: '免签停留(口径以泰方公告为准);UAE 居民返程应优先校验 residence visa / Emirates ID 而非游客免签口径',
    source: 'web:official', query_id: 'web:policy:泰国免签',
    fetched_at: FETCHED, as_of: '2026-08-29',
  }
  const canonicalLine = renderPolicyFact(basePolicy)
  const baseArtifact = ['## 政策', canonicalLine].join('\n')

  // 14a. canonical positive:渲染行 = canonical body + 锚点 → pass,traceable=1
  const positive = gateArtifact(baseArtifact, [basePolicy], map, { trip_year: tripYear })
  assert(positive.verdict === 'pass' && positive.traceable === 1 && positive.violations.length === 0,
    `canonical 锚点行 → pass(实际 ${positive.verdict}/traceable=${positive.traceable}/violations=${positive.violations.length})`)
  // 14a-renderer-only:policyCanonicalBody 与 renderPolicyFact 在 canonical body 段一致
  assert(policyCanonicalBody(basePolicy) === canonicalLine.replace(/\s*<!--\s*fact:[\da-f]+\s*-->$/, ''),
    'policyCanonicalBody 与 renderPolicyFact 在非锚点段严格一致(单一权威面)')

  // 14b. failing-before #359:改 subject 而保留 fact_id+as_of → blocked
  const changedSubject = canonicalLine.replace('泰国入境(中国护照)', '另一对象的政策')
  const subjReport = gateArtifact(['## 政策', changedSubject].join('\n'), [basePolicy], map, { trip_year: tripYear })
  assert(subjReport.verdict === 'blocked' && subjReport.violations.some(v => v.kind === 'fact_anchor_unknown' && /另一对象的政策/.test(v.detail)),
    `改 subject 保留 fact_id+as_of → blocked/fact_anchor_unknown(实际 ${subjReport.verdict}/${subjReport.violations.length} 违例)`)

  // 14c. failing-before #359:改 statement 而保留 fact_id+as_of → blocked
  const changedStatement = canonicalLine.replace('免签停留', '不免签停留')
  const stmtReport = gateArtifact(['## 政策', changedStatement].join('\n'), [basePolicy], map, { trip_year: tripYear })
  assert(stmtReport.verdict === 'blocked' && stmtReport.violations.some(v => v.kind === 'fact_anchor_unknown' && /不免签停留/.test(v.detail)),
    `改 statement 保留 fact_id+as_of → blocked/fact_anchor_unknown(实际 ${stmtReport.verdict}/${stmtReport.violations.length} 违例)`)

  // 14d. failing-before #359:相反方向 statement(从「免签」改成「不免签」)→ blocked
  const oppositeStatement = canonicalLine.replace('免签停留', '不免签,需提前办签证')
  const oppReport = gateArtifact(['## 政策', oppositeStatement].join('\n'), [basePolicy], map, { trip_year: tripYear })
  assert(oppReport.verdict === 'blocked' && oppReport.violations.some(v => v.kind === 'fact_anchor_unknown' && /不免签/.test(v.detail)),
    `相反 statement 保留 fact_id+as_of → blocked/fact_anchor_unknown(实际 ${oppReport.verdict}/${oppReport.violations.length} 违例)`)

  // 14e. failing-before #359:改 source / fetched_at / query_id(任一 provenance 字段)→ blocked
  const changedSource = canonicalLine.replace('[web:official@', '[synthetic:official@')
  const srcReport = gateArtifact(['## 政策', changedSource].join('\n'), [basePolicy], map, { trip_year: tripYear })
  assert(srcReport.verdict === 'blocked' && srcReport.violations.some(v => v.kind === 'fact_anchor_unknown' && /synthetic:official/.test(v.detail)),
    `改 source 保留 fact_id+as_of → blocked/fact_anchor_unknown(实际 ${srcReport.verdict}/${srcReport.violations.length} 违例)`)

  const changedFetched = canonicalLine.replace(FETCHED, '2026-09-01T00:00:00.000Z')
  const fetchReport = gateArtifact(['## 政策', changedFetched].join('\n'), [basePolicy], map, { trip_year: tripYear })
  assert(fetchReport.verdict === 'blocked' && fetchReport.violations.some(v => v.kind === 'fact_anchor_unknown' && /2026-09-01/.test(v.detail)),
    `改 fetched_at 保留 fact_id+as_of → blocked/fact_anchor_unknown(实际 ${fetchReport.verdict}/${fetchReport.violations.length} 违例)`)

  const changedQueryId = canonicalLine.replace('#web:policy:泰国免签', '#synthetic:policy:泰国免签')
  const qidReport = gateArtifact(['## 政策', changedQueryId].join('\n'), [basePolicy], map, { trip_year: tripYear })
  assert(qidReport.verdict === 'blocked' && qidReport.violations.some(v => v.kind === 'fact_anchor_unknown' && /synthetic:policy/.test(v.detail)),
    `改 query_id 保留 fact_id+as_of → blocked/fact_anchor_unknown(实际 ${qidReport.verdict}/${qidReport.violations.length} 违例)`)

  // 14f. legitimate review_by(事实自带):policy.review_by 设置 → 行带复核提醒,闸侧需 tripStart 或 review_by
  //     与 canonical 同步才能 pass。tripStart=undefined 时,canonical 也会用 p.review_by,
  //     与 renderer 输出严格一致 → pass。
  const reviewByPolicy: PolicyFact = { ...basePolicy, review_by: '2027-06-16' }
  const reviewByLine = renderPolicyFact(reviewByPolicy)
  const reviewByReport = gateArtifact(['## 政策', reviewByLine].join('\n'), [reviewByPolicy], map, { trip_year: tripYear })
  assert(reviewByReport.verdict === 'pass' && reviewByReport.traceable === 1,
    `legitimate review_by 事实 → 闸 pass(实际 ${reviewByReport.verdict}/traceable=${reviewByReport.traceable})`)
  // 反向:review_by 改动(保留 fact_id+as_of,改 review_by)→ blocked
  const reviewByTampered = reviewByLine.replace('2027-06-16', '2027-12-31')
  const reviewByTamperedReport = gateArtifact(['## 政策', reviewByTampered].join('\n'), [reviewByPolicy], map, { trip_year: tripYear })
  assert(reviewByTamperedReport.violations.some(v => v.kind === 'fact_anchor_unknown' && /2027-12-31/.test(v.detail)),
    `改 review_by 保留 fact_id+as_of → fact_anchor_unknown(实际 ${reviewByTamperedReport.violations.length} 违例)`)

  // 14g. legitimate tripStart-derived reminder:renderer 给的 tripStart 与闸侧 opts.tripStart
  //     一致时,cannonical body 完全匹配 → pass。
  //     兼容性回退:renderer 用的是 renderer 自身的 defaultReviewBy(tripStart) 时,
  //     即使闸侧未传 opts.tripStart 也应 pass —— 这是历史 #273 形态。
  const tripStart = '2027-07-16'
  const tripStartLine = renderPolicyFact(basePolicy, tripStart)
  const tripStartReport = gateArtifact(['## 政策', tripStartLine].join('\n'), [basePolicy], map, { trip_year: tripYear, tripStart })
  assert(tripStartReport.verdict === 'pass' && tripStartReport.traceable === 1,
    `legitimate tripStart-derived reminder(显式 opts) → 闸 pass(实际 ${tripStartReport.verdict}/traceable=${tripStartReport.traceable})`)
  const tripStartCompat = gateArtifact(['## 政策', tripStartLine].join('\n'), [basePolicy], map, { trip_year: tripYear })
  assert(tripStartCompat.verdict === 'pass' && tripStartCompat.traceable === 1,
    `legitimate tripStart-derived reminder(无 opts 兼容性回退) → 闸 pass(实际 ${tripStartCompat.verdict}/traceable=${tripStartCompat.traceable})`)
  // 反向:闸侧 opts.tripStart 与 renderer 不一致(不是 renderer 默认 reminder 日期)→ blocked
  const tripStartWrongOpts = gateArtifact(['## 政策', tripStartLine].join('\n'), [basePolicy], map, { trip_year: tripYear, tripStart: '2028-01-01' })
  assert(tripStartWrongOpts.violations.some(v => v.kind === 'fact_anchor_unknown'),
    `tripStart 与闸侧 opts.tripStart 不一致 → fact_anchor_unknown(实际 ${tripStartWrongOpts.violations.length} 违例)`)

  // 14g-compat. 兼容性回退接受的具体形态:context-free canonical(no-reminder)、
  //   context-free reminder(renderer 默认 defaultReviewBy)、
  //   context-free reminder(f.review_by 已知)。
  //   以及不接受的具体形态:任意 body 文本、错 reminder 日期、前缀垃圾、缺锚点。
  const noReminderLine = renderPolicyFact(basePolicy)
  const compat1 = gateArtifact(['## 政策', noReminderLine].join('\n'), [basePolicy], map, { trip_year: tripYear })
  assert(compat1.verdict === 'pass' && compat1.traceable === 1,
    `context-free canonical no-reminder → pass(实际 ${compat1.verdict})`)
  const knownReviewByLine = renderPolicyFact({ ...basePolicy, review_by: '2027-09-01' })
  const compat2 = gateArtifact(['## 政策', knownReviewByLine].join('\n'), [basePolicy], map, { trip_year: tripYear })
  assert(compat2.verdict === 'pass' && compat2.traceable === 1,
    `context-free canonical reminder(review_by 已知)→ pass(实际 ${compat2.verdict})`)
  // context-free 不接受的形态:body 里塞相反政策
  const compatBadBody = noReminderLine.replace('免签停留', '不免签停留')
  const compatBadBodyReport = gateArtifact(['## 政策', compatBadBody].join('\n'), [basePolicy], map, { trip_year: tripYear })
  assert(compatBadBodyReport.violations.some(v => v.kind === 'fact_anchor_unknown'),
    `context-free 不接受 body 篡改 → fact_anchor_unknown(实际 ${compatBadBodyReport.violations.length} 违例)`)
  // context-free 不接受的形态:reminder 日期改成 renderer 不会用的日期(仍假装合法 reminder)
  const compatBadDate = noReminderLine + ';远期政策须复核——到 1999-01-01 再核验一次'
  const compatBadDateReport = gateArtifact(['## 政策', compatBadDate].join('\n'), [basePolicy], map, { trip_year: tripYear })
  assert(compatBadDateReport.violations.some(v => v.kind === 'fact_anchor_unknown'),
    `context-free 不接受 renderer 不会用的 reminder 日期 → fact_anchor_unknown(实际 ${compatBadDateReport.violations.length} 违例)`)
  // context-free 不接受的形态:review_by 改动(renderer 接受 review_by 但闸侧事实
  //   未带 review_by 时,兼容性回退允许任意合法 ISO 日期 —— 见根 contract 第 4 条。
  //   若闸侧事实**自身**带 review_by,则 reminder 日期必须 == f.review_by,改了就 fail。)
  // 这里 fact 是 basePolicy(无 review_by),渲染时假装加 review_by 后再改日期:
  //   闸侧只看事实,无 review_by → 回退接受任意合法 ISO 日期。
  const compatReviewByTampered = renderPolicyFact({ ...basePolicy, review_by: '2027-09-01' }).replace('2027-09-01', '2027-12-31')
  const compatReviewByTamperedReport = gateArtifact(['## 政策', compatReviewByTampered].join('\n'), [basePolicy], map, { trip_year: tripYear })
  assert(compatReviewByTamperedReport.verdict === 'pass' && compatReviewByTamperedReport.traceable === 1,
    `事实无 review_by 时 context-free 接受任意合法 ISO 日期 → pass(实际 ${compatReviewByTamperedReport.verdict})`)
  // 反向:事实带 review_by 时,改 reminder 日期 → 必须 fail-closed(根 contract 第 2 条)。
  const fReviewBy: PolicyFact = { ...basePolicy, review_by: '2027-06-16' }
  const lReviewByTampered = renderPolicyFact(fReviewBy).replace('2027-06-16', '2027-12-31')
  const reviewByTamperedFactReport = gateArtifact(['## 政策', lReviewByTampered].join('\n'), [fReviewBy], map, { trip_year: tripYear })
  assert(reviewByTamperedFactReport.violations.some(v => v.kind === 'fact_anchor_unknown'),
    `事实带 review_by 时改 reminder 日期 → fact_anchor_unknown(实际 ${reviewByTamperedFactReport.violations.length} 违例)`)
  // context-free 不接受的形态:trailing-after-anchor
  const compatTrailing = `${noReminderLine} 反而是落地签`
  const compatTrailingReport = gateArtifact(['## 政策', compatTrailing].join('\n'), [basePolicy], map, { trip_year: tripYear })
  assert(compatTrailingReport.violations.some(v => v.kind === 'fact_anchor_unknown'),
    `context-free 不接受 trailing-after-anchor → fact_anchor_unknown(实际 ${compatTrailingReport.violations.length} 违例)`)

  // 14g-itin. itinerary.trip_start 提供后,context-free 不再回退 —— reminder 必须匹配
  //   itinerary 实际提供的日期;no-reminder canonical 在 itinerary 存在时仍合法
  //   (renderer 没给 tripStart 时不出现 reminder 段)。
  const itReportMismatch = gateArtifact(
    ['## 政策', tripStartLine].join('\n'),
    [basePolicy],
    map,
    { trip_year: tripYear, itinerary: { ...fixture.good_itinerary, trip_start: '2027-08-01', trip_end: '2027-08-01' } },
  )
  assert(itReportMismatch.violations.some(v => v.kind === 'fact_anchor_unknown'),
    `itinerary.trip_start 与 renderer reminder 不一致 → fact_anchor_unknown(实际 ${itReportMismatch.violations.length} 违例)`)
  const itReportNoReminder = gateArtifact(
    ['## 政策', noReminderLine].join('\n'),
    [basePolicy],
    map,
    { trip_year: tripYear, itinerary: {
      trip_start: '2027-08-01',
      trip_end: '2027-08-01',
      stays: [],
      onboard_nights: 0,
      od_segments: [],
      budget_items: [],
    } },
  )
  assert(itReportNoReminder.verdict === 'pass' && itReportNoReminder.traceable === 1,
    `itinerary 存在时 canonical no-reminder 仍合法 → pass(实际 ${itReportNoReminder.verdict})`)

  // 14h. 父 #273 已有形态保留:as_of 改动(11g/11h)仍走 fact_anchor_unknown(同一收敛口径)
  const asOfShifted = canonicalLine.replace(/截至\s*\d{4}-\d{2}-\d{2}/, '截至 2027-01-01')
  const asOfReport = gateArtifact(['## 政策', asOfShifted].join('\n'), [basePolicy], map, { trip_year: tripYear })
  assert(asOfReport.violations.some(v => v.kind === 'fact_anchor_unknown' && /2027-01-01/.test(v.detail)),
    `父 #273 as_of 改动形态保留(实际 ${asOfReport.violations.length} 违例)`)

  // 14i. 同一 fact 出现在多行:仅改 subject 行 fail-closed,其他行不动
  const multi = ['## 政策', canonicalLine, canonicalLine.replace('泰国入境(中国护照)', '另一对象的政策')].join('\n')
  const multiReport = gateArtifact(multi, [basePolicy], map, { trip_year: tripYear })
  assert(multiReport.verdict === 'blocked' && multiReport.violations.filter(v => v.kind === 'fact_anchor_unknown').length === 1,
    `多行同 fact:仅篡改行 fail-closed(实际违例 ${multiReport.violations.length},fact_anchor_unknown=${multiReport.violations.filter(v => v.kind === 'fact_anchor_unknown').length})`)

  // 14j. trailing-after-anchor 攻击:借用合法 fact_id + 锚点,在锚点后追加相反政策正文 →
  //     闸侧应识别「锚点后仍有非空文本」并 fail-closed,而不是只比对锚点前 canonical body。
  const trailing = `${canonicalLine} 反而是落地签,需提前办签证`
  const trailingReport = gateArtifact(['## 政策', trailing].join('\n'), [basePolicy], map, { trip_year: tripYear })
  assert(trailingReport.verdict === 'blocked' && trailingReport.violations.some(v => v.kind === 'fact_anchor_unknown'),
    `trailing-after-anchor 攻击 → fact_anchor_unknown(实际 ${trailingReport.verdict}/${trailingReport.violations.length} 违例)`)

  // 14k. duplicate anchor:同一行内两个 `<!-- fact:` → fail-closed
  const dupAnchor = canonicalLine.replace(`<!-- fact:${basePolicy.fact_id} -->`, `<!-- fact:${basePolicy.fact_id} --> <!-- fact:${basePolicy.fact_id} -->`)
  const dupReport = gateArtifact(['## 政策', dupAnchor].join('\n'), [basePolicy], map, { trip_year: tripYear })
  assert(dupReport.verdict === 'blocked' && dupReport.violations.some(v => v.kind === 'fact_anchor_unknown'),
    `duplicate anchor → fact_anchor_unknown(实际 ${dupReport.verdict}/${dupReport.violations.length} 违例)`)

  // 14l. malformed anchor(没有空格的格式):canonical 是 ` <!-- fact:<id> -->`,缺空格不算同形
  const malformedAnchor = canonicalLine.replace(`<!-- fact:${basePolicy.fact_id} -->`, `<!--fact:${basePolicy.fact_id}-->`)
  const malformedReport = gateArtifact(['## 政策', malformedAnchor].join('\n'), [basePolicy], map, { trip_year: tripYear })
  assert(malformedReport.verdict === 'blocked' && malformedReport.violations.some(v => v.kind === 'fact_anchor_unknown'),
    `malformed anchor(无空格) → fact_anchor_unknown(实际 ${malformedReport.verdict}/${malformedReport.violations.length} 违例)`)

  // 14m. 前置非空文本:同一行在锚点前塞了原文之外的字符 → fail-closed
  const prefixAdded = `前缀: ${canonicalLine}`
  const prefixReport = gateArtifact(['## 政策', prefixAdded].join('\n'), [basePolicy], map, { trip_year: tripYear })
  assert(prefixReport.verdict === 'blocked' && prefixReport.violations.some(v => v.kind === 'fact_anchor_unknown'),
    `prefix non-empty → fact_anchor_unknown(实际 ${prefixReport.verdict}/${prefixReport.violations.length} 违例)`)

  console.log(`  ok - §14 政策锚点全字段内容指纹(#359 / D-26)完成(canonical + 5 failing-before + 2 legitimate + 多行归属 + trailing/dup/malformed/prefix 锚点结构攻击)`)
}

console.log(`\nFACT GATE TESTS: ${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
