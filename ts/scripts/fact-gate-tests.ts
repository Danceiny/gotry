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
  flightClaimVerdict,
  itineraryInvariants,
  latestFactsForRouteDate,
  negativeFact,
  renderConnection,
  renderFlightFact,
  renderNightsLine,
  renderPolicyFact,
  type FlightFact,
  type ItineraryFacts,
  type PolicyFact,
  type CityAlias,
} from '../src/bookable-facts.ts'
import {
  ARTIFACT_GATE_SCHEMA,
  gateArtifact,
  type AirlineAirportMap,
  type GateViolationKind,
} from '../src/artifact-gate.ts'

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

// 全部 fixture 查询经生产同款转换器进注册表(miss 落负事实);fixture 只产航班事实
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
  schema: BOOKABLE_FACT_SCHEMA, fact_id: 'policy-th-00000000', kind: 'policy',
  subject: '泰国入境(中国护照)', statement: '免签停留(口径以泰方公告为准);UAE 居民返程应优先校验 residence visa / Emirates ID 而非游客免签口径',
  source: 'web:official', query_id: 'web:policy:泰国免签', fetched_at: FETCHED, as_of: '2026-08-29',
}
const policyLine = renderPolicyFact(policy, fixture.meta.trip_window[0])
assert(policyLine.includes('截至 2026-08-29 的现行政策') && policyLine.includes('2027-06-16') && !/[✓✅]/.test(policyLine),
  '政策行恒带「截至 as_of」+ D-30 复核日期(2027-06-16),永不用无条件 ✓')
const policyBad = gateArtifact('| 泰国 | 中国护照免签(现行60天/次),停留2周无问题 |', registry, map, { trip_year: tripYear })
assert(policyBad.violations.some(v => v.kind === 'policy_without_as_of'), '「现行60天」无具体 as_of 日期 = policy_without_as_of(现行 ≠ 时间边界)')
const policyGood = gateArtifact(policyLine, registry, map, { trip_year: tripYear })
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
  renderPolicyFact({ ...policy, fact_id: 'policy-uae-0000000', subject: '迪拜入境(UAE 居民返程)', statement: '优先校验 residence visa / Emirates ID;游客免签口径不适用居民返程' }, fixture.meta.trip_window[0]),
].join('\n')
const goodReport = gateArtifact(goodArtifact, registry, map, { trip_year: tripYear, itinerary: fixture.good_itinerary })
assert(goodReport.verdict === 'pass' && goodReport.presentation === 'verified_itinerary_allowed'
  && goodReport.traceable === 6 && goodReport.violations.length === 0,
  `good artifact:6/6 航班 claim 全回溯,闸 pass(违例 ${goodReport.violations.length})`)
assert(goodFlights.every(f => f.bookability === 'bookable_exact_date' && f.query_id.includes('flyai:flight:')),
  'good artifact 的每个可下单事实均可回溯到 tool result/query id(验收⑧)')

console.log(`\nFACT GATE TESTS: ${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
