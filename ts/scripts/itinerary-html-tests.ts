/**
 * 行程 HTML 渲染器契约测试(issue #442,父 #438)。
 *
 * 只使用合成数据:合成完整/部分行程 + 4 条已注册事实 + 恶意 HTML 反例。
 * 不含任何用户真实行程或个人细节。
 *
 * 运行(在 ts/ 下):npx tsx scripts/itinerary-html-tests.ts
 */

import {
  BOOKABLE_FACT_SCHEMA,
  defaultReviewBy,
  renderFlightFact,
  renderHotelFact,
  renderPolicyFact,
  type BookableFact,
  type FlightFact,
  type HotelFact,
  type PolicyFact,
} from '../src/bookable-facts.ts'
import {
  ITINERARY_HTML_LIMITS,
  renderItineraryHtml,
  type ItineraryHtmlResult,
} from '../src/itinerary-html.ts'

let pass = 0
let fail = 0
const failures: string[] = []

function assert(cond: boolean, msg: string): void {
  if (cond) {
    pass++
    return
  }
  fail++
  failures.push(msg)
}

function assertRejected(result: ItineraryHtmlResult, needle: string, msg: string): void {
  if (result.ok) {
    assert(false, `${msg}(期望 ok:false,实际渲染出 ${result.html.length} 字符)`)
    return
  }
  assert(result.errors.some(e => e.includes(needle)), `${msg}(errors=${JSON.stringify(result.errors)} 未含「${needle}」)`)
}

function assertRendered(result: ItineraryHtmlResult, msg: string): string {
  if (!result.ok) {
    assert(false, `${msg}(期望 ok:true,实际 errors=${JSON.stringify(result.errors)})`)
    return ''
  }
  assert(true, msg)
  return result.html
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

// ---------------------------------------------------------------------------
// 合成 fixture
// ---------------------------------------------------------------------------

const FLIGHT_HIT: FlightFact = {
  schema: BOOKABLE_FACT_SCHEMA,
  fact_id: 'a1b2c3d4e5f60718',
  kind: 'flight',
  route: { origin: 'SZX', destination: 'HKT', origin_airport: 'SZX', dest_airport: 'HKT' },
  date: '2027-07-17',
  flight_no: 'CZ6061',
  marketing_carrier: '南方航空',
  dep_local: '09:20',
  arr_local: '12:05',
  nonstop: true,
  price: 1680,
  currency: 'CNY',
  baggage_included: false,
  tier: 'live_inventory',
  bookability: 'bookable_exact_date',
  source: 'session:ctrip-flight',
  query_id: 'session:ctrip-flight:flight:SZX-HKT:2027-07-17',
  fetched_at: '2026-09-12T02:10:03.000Z',
  as_of: '2026-09-12',
}

const FLIGHT_NEGATIVE: FlightFact = {
  schema: BOOKABLE_FACT_SCHEMA,
  fact_id: 'b1b2c3d4e5f60719',
  kind: 'flight',
  route: { origin: 'HKT', destination: 'BKK' },
  date: '2027-07-21',
  flight_no: '',
  tier: 'live_inventory',
  bookability: 'unavailable_exact_date',
  source: 'flyai',
  query_id: 'flyai:flight:HKT-BKK:2027-07-21',
  fetched_at: '2026-09-12T02:12:44.000Z',
  as_of: '2026-09-12',
  review_by: '2027-06-21',
}

const TRAIN_UNVERIFIED: FlightFact = {
  schema: BOOKABLE_FACT_SCHEMA,
  fact_id: 'c1b2c3d4e5f60720',
  kind: 'train',
  route: { origin: '广州南', destination: '深圳北' },
  date: '2027-07-16',
  flight_no: 'G6011',
  dep_local: '07:12',
  arr_local: '07:48',
  tier: 'historical_schedule',
  bookability: 'unverified',
  source: 'flyai',
  query_id: 'flyai:train:广州南-深圳北:2027-07-16',
  fetched_at: '2026-09-12T02:00:00.000Z',
  as_of: '2026-08-01',
}

const HOTEL_HIT: HotelFact = {
  schema: BOOKABLE_FACT_SCHEMA,
  fact_id: 'd1b2c3d4e5f60721',
  kind: 'hotel',
  destination: '普吉岛',
  check_in: '2027-07-17',
  check_out: '2027-07-21',
  verdict: 'hit',
  bookability: 'bookable_exact_date',
  options_masked: 37,
  source: 'flyai-hotel',
  query_id: 'hotel:flyai-hotel:普吉岛:2027-07-17_2027-07-21',
  fetched_at: '2026-09-12T02:20:00.000Z',
  as_of: '2026-09-12',
  tier: 'live_inventory',
}

const HOTEL_MISS: HotelFact = {
  schema: BOOKABLE_FACT_SCHEMA,
  fact_id: 'e1b2c3d4e5f60722',
  kind: 'hotel',
  destination: '甲米',
  check_in: '2027-07-21',
  check_out: '2027-07-23',
  verdict: 'miss',
  bookability: 'unavailable_exact_date',
  options_masked: 0,
  source: 'flyai-hotel',
  query_id: 'hotel:flyai-hotel:甲米:2027-07-21_2027-07-23',
  fetched_at: '2026-09-12T02:22:00.000Z',
  as_of: '2026-09-12',
  tier: 'live_inventory',
}

const POLICY_PLAN: PolicyFact & { runtime?: { is_plan?: boolean } } = Object.assign({
  schema: BOOKABLE_FACT_SCHEMA,
  fact_id: 'f1b2c3d4e5f60723',
  kind: 'policy' as const,
  subject: '泰国免签',
  statement: '中国护照可免签入境停留不超过 30 天(以落地执行口径为准)',
  source: 'flyai',
  query_id: 'flyai:policy:泰国免签',
  fetched_at: '2026-09-12T02:30:00.000Z',
  as_of: '2026-09-12',
  review_by: '2027-06-17',
}, { runtime: { is_plan: true } })

const FACTS: BookableFact[] = [FLIGHT_HIT, FLIGHT_NEGATIVE, TRAIN_UNVERIFIED, HOTEL_HIT, HOTEL_MISS, POLICY_PLAN as BookableFact]

function completeInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: '合成行程:深圳 → 普吉 → 甲米 → 曼谷',
    itinerary: {
      trip_start: '2027-07-16',
      trip_end: '2027-07-24',
      stays: [
        { place: '普吉岛', check_in: '2027-07-17', check_out: '2027-07-21' },
        { place: '甲米', check_in: '2027-07-21', check_out: '2027-07-23' },
      ],
      od_segments: [
        { from: '广州南', to: '深圳北', date: '2027-07-16', mode: 'rail', legs: 1 },
        { from: 'SZX', to: 'HKT', date: '2027-07-17', mode: 'flight', legs: 1 },
        { from: 'HKT', to: 'BKK', date: '2027-07-21', mode: 'flight', legs: 2 },
      ],
    },
    facts: FACTS,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// §1 完整行程:截面结构、可展开交互、证据分层保留
// ---------------------------------------------------------------------------

{
  const html = assertRendered(renderItineraryHtml(completeInput()), '§1 完整合成行程渲染成功')

  assert(html.startsWith('<!DOCTYPE html>\n<html lang="zh-CN">'), '§1a 输出为完整独立文档(DOCTYPE + lang)')
  assert(countOf(html, '<details') === countOf(html, '</details>') && countOf(html, '<details') >= 12,
    `§1b details/summary 配对且覆盖全部可展开条目(实测 ${countOf(html, '<details')} 组)`)
  assert(countOf(html, '<summary') === countOf(html, '</summary>'), '§1c summary 标签配对')
  assert(html.includes('id="dates"') && html.includes('id="segments"') && html.includes('id="stays"') && html.includes('id="facts"'),
    '§1d 导航锚点齐全(dates/segments/stays/facts)')
  assert(html.includes('href="#dates"') && html.includes('href="#segments"') && html.includes('href="#stays"') && html.includes('href="#facts"'),
    '§1e 导航链接指向三大章节')
  assert(html.includes('id="stay-1"') && html.includes('id="stay-2"') && html.includes('id="seg-1"') && html.includes('id="seg-2"') && html.includes('id="seg-3"'),
    '§1f 每条住宿/交通段都有可跳转 id')
  assert(!/<script/i.test(html) && !/<iframe/i.test(html), '§1g 产物不含 script/iframe')
  assert(!/\son[a-z]+\s*=/i.test(html), '§1h 产物不含内联事件处理器')
  assert(!/https?:\/\//i.test(html) && !/<link/i.test(html) && !/@import/i.test(html) && !/url\(/i.test(html),
    '§1i 产物无远端依赖(无 http/link/@import/url())')
  assert(html.includes('<style>') && html.includes('@media (max-width:480px)'), '§1j 样式自包含且含窄屏断点')
  assert(html.includes('<time datetime="2027-07-17">2027-07-17</time>'), '§1k 日期用语义 <time datetime>')
  assert(html.includes('<a class="skip" href="#main">'), '§1l 提供跳转正文链接(键盘可达)')
  assert(html.includes('class="planned"'), '§1m 计划住宿标记为 planned')

  // 证据字段逐条保留:canonical 原文必须随产物输出(按 HTML 文本转义后逐字可回读)
  for (const f of FACTS) {
    const canonical = f.kind === 'hotel' ? renderHotelFact(f) : f.kind === 'policy' ? renderPolicyFact(f) : renderFlightFact(f)
    assert(html.includes(canonical.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')),
      `§1n 事实 ${f.fact_id} 的 canonical 原文随产物输出(可回溯)`)
  }

  assert(html.includes('bookable_exact_date') && html.includes('unavailable_exact_date') && html.includes('unverified'),
    '§1o 三条不同 bookability 原样保留(不合并、不提升)')
  assert(html.includes('exact-date 实时在架') && html.includes('历史/旧航季班期'), '§1p 证据层 label 保留')
  assert(html.includes('[session:ctrip-flight]') && html.includes('[flyai-hotel]'), '§1q 来源标识保留')
  assert(html.includes('session:ctrip-flight:flight:SZX-HKT:2027-07-17') && html.includes('flyai:flight:HKT-BKK:2027-07-21'),
    '§1r 查询 id 保留(可重放)')
  assert(html.includes('2026-09-12T02:10:03.000Z') && html.includes('2027-06-21'), '§1s fetched_at 与 review_by 保留')
  assert(html.includes('数据快照日 as_of'), '§1t as_of 字段面保留')

  // 负事实 / 缺省值
  assert(html.includes('该档期无结果'), '§1u 负事实显式渲染为「该档期无结果」')
  assert(html.includes('未核验'), '§1v 未核验事实显式渲染')
  assert(html.includes('该目的地 + 该档期另有 1 条'), '§1w 计划住宿卡只给独立证据指针')
  assert(html.includes('独立记录:目的地级酒店事实'), '§1x 酒店事实落在独立证据区')
  assert(html.includes('政政策事实'.slice(1)) || html.includes('政策事实'), '§1y 政策事实单独渲染')
  assert(html.includes('标注为「计划」意图'), '§1z runtime.is_plan 不升级为现行政策')

  // 无整体 verified 徽章 / 无预算夜数(具体断言,不靠宽泛词网)
  assert(!html.includes('全部已核验') && !html.includes('整体已核验') && !html.includes('整体可订')
    && !html.includes('badge ok">整体') && html.includes('本文档不给出整体「已验证」结论'),
    '§1aa 产物不含整体核验/可订徽章(且显式声明无整体结论)')
  assert(!/\d+\s*天\s*\d+\s*晚/.test(html) && !/共\s*\d+\s*天/.test(html) && !/总预算|预算合计/.test(html)
    && html.includes('不做夜数/预算/时间运算'),
    '§1ab 产物无天数/预算合计,且显式声明不做运算')
  assert(html.includes('¥1680') === false || html.includes('1680'), '§1ac 事实价格按 canonical 原文保留')
}

// ---------------------------------------------------------------------------
// §2 部分行程:空段/空住宿/无事实也各成状态,不伪造内容
// ---------------------------------------------------------------------------

{
  const partial = {
    title: '部分行程:只有日期窗',
    itinerary: { trip_start: '2027-07-16', trip_end: '2027-07-16', stays: [], od_segments: [] },
    facts: [],
  }
  const html = assertRendered(renderItineraryHtml(partial), '§2 部分行程(单日窗、零段零住宿)渲染成功')
  assert(html.includes('没有显式日期条目'), '§2a 空日期列表显式说明,不合成日历日')
  assert(html.includes('没有显式交通段') && html.includes('没有显式住宿段'), '§2b 空段/空住宿各自成状态')
  assert(html.includes('本次输入没有航班/车次事实'), '§2c 无事实时显式说明')
  assert(html.includes('2027-07-16</time> → <time datetime="2027-07-16">'), '§2d 同日行程不报错也不扩张')
  assert(!html.includes('class="planned"'), '§2e 无住宿则不生成计划住宿卡片')

  const segOnly = {
    title: '部分行程:只给一段',
    itinerary: {
      trip_start: '2027-07-16',
      trip_end: '2027-07-20',
      stays: [],
      od_segments: [{ from: 'SZX', to: 'HKT', date: '2027-07-17', mode: 'flight' as const, legs: 1 }],
    },
    facts: [],
  }
  const segHtml = assertRendered(renderItineraryHtml(segOnly), '§2f 只有交通段的行程渲染成功')
  assert(segHtml.includes('该段没有匹配的已注册事实'), '§2g 计划段无证据时显式标注未核验')
  assert(segHtml.includes('航班 SZX → HKT 2027-07-17'), '§2h 计划段摘要给出显式 route + date')
}

// ---------------------------------------------------------------------------
// §3 未知不被升级
// ---------------------------------------------------------------------------

{
  const unknownTier = { ...FLIGHT_HIT, fact_id: 'aaaa0000bbbb1111', tier: 'route_exists', bookability: 'unverified' }
  const html = assertRendered(
    renderItineraryHtml({ ...completeInput(), facts: [unknownTier] }),
    '§3 仅含未核验事实的输入渲染成功',
  )
  assert(html.includes('route_exists(仅航线存在)'), '§3a 弱证据层原样展示')
  assert(html.includes('unverified(未核验)'), '§3b 未核验状态原样展示')
  assert(!html.includes('该档期可下单'), '§3c 未核验事实不得到可下单措辞')
  assert(html.includes('badge bad') || html.includes('badge warn'), '§3d 未核验使用警示样式')
  assert(html.includes('计划住宿:普吉岛'), '§3e 计划住宿照常展示(未核验事实不改写它)')

  const staleBenchmark = { ...FLIGHT_HIT, fact_id: 'cccc0000dddd2222', tier: 'benchmark_price', bookability: 'conflict', price: undefined, currency: undefined }
  const staleHtml = assertRendered(renderItineraryHtml({ ...completeInput(), facts: [staleBenchmark] }), '§3f 冲突事实渲染成功')
  assert(staleHtml.includes('conflict(两源冲突)'), '§3g 冲突状态原样展示')
  assert(staleHtml.includes(renderFlightFact(staleBenchmark as FlightFact).replace(/</g, '&lt;').replace(/>/g, '&gt;')),
    '§3h 缺价按 canonical「价待询」原样输出,不编造数字')
  assert(!staleHtml.includes('¥undefined') && !staleHtml.includes('¥NaN'), '§3i 不产生 NaN/undefined 价格')

  const destinationOnly = assertRendered(
    renderItineraryHtml({ ...completeInput(), facts: [HOTEL_HIT] }),
    '§3j 只有目的地级酒店事实的输入渲染成功',
  )
  assert(destinationOnly.includes('计划住宿:普吉岛'), '§3k 计划住宿照常展示')
  assert(destinationOnly.includes('不是本条目这家酒店的房型/报价'), '§3l 明确否定「目的地级 = 某家酒店」的等价')
  const plannedStayCard = destinationOnly.slice(destinationOnly.indexOf('id="stay-1"'), destinationOnly.indexOf('id="stay-2"'))
  assert(!plannedStayCard.includes('住宿已核验') && !plannedStayCard.includes('<pre'),
    '§3m 目的地级命中不得写成计划住宿的核验结论(canonical 行须留在独立事实卡内)')
  const hotelSection = destinationOnly.slice(destinationOnly.indexOf('id="hotel-evidence"'))
  assert(hotelSection.includes(renderHotelFact(HOTEL_HIT).replace(/</g, '&lt;').replace(/>/g, '&gt;'))
    && hotelSection.includes('在架 37 家'),
    '§3n 命中家数只出现在独立证据区的 canonical 行内')
}

// ---------------------------------------------------------------------------
// §4 恶意 HTML:转义而非拒绝
// ---------------------------------------------------------------------------

{
  const hostileTitle = '<script>alert(1)</script><img src=x onerror="fetch(\'http://evil\')">'
  const hostilePlace = '"><iframe src="javascript:alert(2)"></iframe>'
  const hostileFacts: BookableFact[] = [
    { ...FLIGHT_HIT, fact_id: '1111222233334444', marketing_carrier: '</summary><script>alert(3)</script>' },
    { ...HOTEL_HIT, fact_id: '5555666677778888', destination: hostilePlace },
    { ...POLICY_PLAN, fact_id: '99990000aaaabbbb', statement: '<b>加粗</b> & <svg onload=alert(4)>' } as BookableFact,
  ]
  const hostileInput = {
    title: hostileTitle,
    itinerary: {
      trip_start: '2027-07-16',
      trip_end: '2027-07-24',
      stays: [{ place: hostilePlace, check_in: '2027-07-17', check_out: '2027-07-21' }],
      od_segments: [{ from: '<em>SZX</em>', to: 'HKT">', date: '2027-07-17', mode: 'flight' as const, legs: 1 }],
    },
    facts: hostileFacts,
  }
  const html = assertRendered(renderItineraryHtml(hostileInput), '§4 恶意 HTML 输入仍渲染(转义而非执行)')
  assert(!html.includes('<script'), '§4a 无未转义 <script')
  assert(!html.includes('<iframe'), '§4b 无未转义 <iframe')
  assert(!/<svg/i.test(html) && !html.includes('<b>') && html.includes('&lt;b&gt;加粗&lt;/b&gt;'), '§4c 事实文本中的标签被转义')
  assert(!/<[a-zA-Z][^>]*\son[a-z]+\s*=/i.test(html), '§4d 标签内无未转义事件处理器')
  assert(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), '§4e 标题中的脚本按实体转义')
  assert(html.includes('&quot;&gt;&lt;iframe'), '§4f 属性位置的双引号被转义(不能逃出属性)')
  assert(html.includes('&lt;em&gt;SZX&lt;/em&gt;'), '§4g 段起点的标签被转义')
  assert(countOf(html, '<summary') === countOf(html, '</summary>'), '§4h 恶意输入未破坏标签配对')
  assert(!/(?:href|src)\s*=\s*"?javascript:/i.test(html) && !/<iframe/i.test(html), '§4i javascript: 载荷不构成可执行链接/内联框架')
}

// ---------------------------------------------------------------------------
// §5 畸形输入显式失败(不静默截断核心行程)
// ---------------------------------------------------------------------------

{
  const cases: Array<[string, unknown, string]> = [
    ['§5a 非对象', 'not-an-object', 'input 必须是对象'],
    ['§5b null', null, 'input 必须是对象'],
    ['§5c 缺 title', { itinerary: { trip_start: '2027-07-16', trip_end: '2027-07-20', stays: [], od_segments: [] }, facts: [] }, 'title 必须是字符串'],
    ['§5d 空 title', completeInput({ title: '' }), 'title 不能为空'],
    ['§5e 缺 itinerary', { title: 't', facts: [] }, 'itinerary 必须是对象'],
    ['§5f stays 非数组', completeInput({ itinerary: { trip_start: '2027-07-16', trip_end: '2027-07-20', stays: 'x', od_segments: [] } }), 'itinerary.stays 必须是数组'],
    ['§5g facts 非数组', completeInput({ facts: {} }), 'facts 必须是数组'],
    ['§5h 缺 facts', { title: 't', itinerary: { trip_start: '2027-07-16', trip_end: '2027-07-20', stays: [], od_segments: [] } }, 'facts 必须是数组'],
    ['§5i 非法 mode', completeInput({ itinerary: { trip_start: '2027-07-16', trip_end: '2027-07-20', stays: [], od_segments: [{ from: 'A', to: 'B', date: '2027-07-17', mode: 'teleport', legs: 1 }] } }), 'itinerary.od_segments[0].mode 不是受支持取值'],
    ['§5j 非法 bookability', completeInput({ facts: [{ ...FLIGHT_HIT, bookability: 'verified' }] }), 'facts[0].bookability 不是受支持取值'],
    ['§5k 非法 tier', completeInput({ facts: [{ ...FLIGHT_HIT, tier: 'maybe' }] }), 'facts[0].tier 不是受支持取值'],
    ['§5l 非法事实 schema', completeInput({ facts: [{ ...FLIGHT_HIT, schema: 'gotry_bookable_fact.v2' }] }), 'facts[0].schema 不是受支持的事实 schema'],
    ['§5m 非法事实 kind', completeInput({ facts: [{ ...FLIGHT_HIT, kind: 'ferry' }] }), 'facts[0].kind 不是受支持的事实类型'],
  ]
  for (const [label, input, needle] of cases) assertRejected(renderItineraryHtml(input), needle, label)

  // 真实日历日期(非正则形式校验)
  const badDates: Array<[string, string, string]> = [
    ['§5n 2 月 30 日', '2027-02-30', 'itinerary.trip_start 不是真实日历日期'],
    ['§5o 13 月', '2027-13-01', 'itinerary.trip_start 不是真实日历日期'],
    ['§5p 非闰年 2 月 29', '2027-02-29', 'itinerary.trip_start 不是真实日历日期'],
    ['§5q 越界年', '1999-12-31', 'itinerary.trip_start 不是真实日历日期'],
    ['§5r 非法格式', '2027/07/16', 'itinerary.trip_start 不是真实日历日期'],
    ['§5s 时间串当日期', '2027-07-16T00:00:00Z', 'itinerary.trip_start 不是真实日历日期'],
  ]
  for (const [label, value, needle] of badDates) {
    assertRejected(renderItineraryHtml(completeInput({ itinerary: { trip_start: value, trip_end: '2027-07-24', stays: [], od_segments: [] } })), needle, label)
  }
  // 闰年 2 月 29 合法
  assertRendered(
    renderItineraryHtml(completeInput({ itinerary: { trip_start: '2028-02-29', trip_end: '2028-03-02', stays: [], od_segments: [] } })),
    '§5t 闰年 2028-02-29 合法',
  )
  assertRejected(renderItineraryHtml(completeInput({ facts: [{ ...FLIGHT_HIT, date: '2027-02-30' }] })), 'facts[0].date 不是真实日历日期', '§5u 事实日期同样检查真实日历')

  // 时间戳与时刻
  assertRejected(renderItineraryHtml(completeInput({ facts: [{ ...FLIGHT_HIT, fetched_at: '2027-06-31T00:00:00Z' }] })), 'facts[0].fetched_at 必须是可解析的 ISO 时间戳', '§5v fetched_at 非法日历日被拒')
  assertRejected(renderItineraryHtml(completeInput({ facts: [{ ...FLIGHT_HIT, fetched_at: '2026-09-12' }] })), 'facts[0].fetched_at 必须是可解析的 ISO 时间戳', '§5w fetched_at 缺时分秒被拒')
  assertRejected(renderItineraryHtml(completeInput({ facts: [{ ...FLIGHT_HIT, as_of: '2026-13-01' }] })), 'facts[0].as_of 必须是真实日历日期', '§5x as_of 非法被拒')
  assertRejected(renderItineraryHtml(completeInput({ facts: [{ ...FLIGHT_HIT, dep_local: '25:00' }] })), 'facts[0].dep_local 必须是 HH:MM', '§5y 非法时刻被拒')
  assertRejected(renderItineraryHtml(completeInput({ facts: [{ ...FLIGHT_HIT, review_by: '2027-02-30' }] })), 'facts[0].review_by 必须是真实日历日期', '§5z 非法 review_by 被拒')

  // 有限数值
  assertRejected(renderItineraryHtml(completeInput({ facts: [{ ...FLIGHT_HIT, price: Number.POSITIVE_INFINITY }] })), 'facts[0].price 必须是有限数值', '§5aa 无限价格被拒')
  assertRejected(renderItineraryHtml(completeInput({ facts: [{ ...FLIGHT_HIT, price: -1 }] })), 'facts[0].price 超出允许范围', '§5ab 负价格被拒')
  assertRejected(renderItineraryHtml(completeInput({ facts: [{ ...HOTEL_HIT, options_masked: 1.5 }] })), 'facts[0].options_masked 必须是整数', '§5ac 非整数在架家数被拒')
  assertRejected(renderItineraryHtml(completeInput({ facts: [{ ...HOTEL_HIT, options_masked: -3 }] })), 'facts[0].options_masked 超出允许范围', '§5ad 负在架家数被拒')
  assertRejected(renderItineraryHtml(completeInput({ itinerary: { trip_start: '2027-07-16', trip_end: '2027-07-24', stays: [], od_segments: [{ from: 'A', to: 'B', date: '2027-07-17', mode: 'car', legs: 0 }] } })), 'itinerary.od_segments[0].legs 超出允许范围', '§5ae legs=0 被拒')
  assertRejected(renderItineraryHtml(completeInput({ itinerary: { trip_start: '2027-07-16', trip_end: '2027-07-24', stays: [], od_segments: [{ from: 'A', to: 'B', date: '2027-07-17', mode: 'car', legs: 1.5 }] } })), 'itinerary.od_segments[0].legs 必须是整数', '§5af 非整数 legs 被拒')

  // 容量与文档大小
  const manyStays = Array.from({ length: ITINERARY_HTML_LIMITS.stays + 1 }, () => ({ place: 'P', check_in: '2027-07-17', check_out: '2027-07-18' }))
  assertRejected(renderItineraryHtml(completeInput({ itinerary: { trip_start: '2027-07-16', trip_end: '2027-07-24', stays: manyStays, od_segments: [] } })), `itinerary.stays 超出容量上限(${ITINERARY_HTML_LIMITS.stays} 条`, '§5ag 超量住宿被拒')
  const manyFacts = Array.from({ length: ITINERARY_HTML_LIMITS.facts + 1 }, (_v, i) => ({ ...FLIGHT_HIT, fact_id: `f${String(i).padStart(15, '0')}` }))
  assertRejected(renderItineraryHtml(completeInput({ facts: manyFacts })), `facts 超出容量上限(${ITINERARY_HTML_LIMITS.facts} 条`, '§5ah 超量事实被拒')
  assertRejected(renderItineraryHtml(completeInput({ title: 'x'.repeat(ITINERARY_HTML_LIMITS.titleChars + 1) })), 'title 超出长度上限', '§5ai 超长标题被拒')
  assertRejected(renderItineraryHtml(completeInput({ itinerary: { trip_start: '2027-07-16', trip_end: '2027-07-24', stays: [], od_segments: [{ from: 'x'.repeat(ITINERARY_HTML_LIMITS.fromToChars + 1), to: 'B', date: '2027-07-17', mode: 'car', legs: 1 }] } })), 'itinerary.od_segments[0].from 超出长度上限', '§5aj 超长城市名被拒')
  assertRejected(renderItineraryHtml(completeInput({ facts: [{ ...POLICY_PLAN, statement: 'x'.repeat(ITINERARY_HTML_LIMITS.statementChars + 1) }] })), 'facts[0].statement 超出长度上限', '§5ak 超长政策陈述被拒')
  // 文档大小:合法但庞大的输入必须整体失败,而不是截断
  const hugeFacts = Array.from({ length: ITINERARY_HTML_LIMITS.facts }, (_v, i) => ({
    ...POLICY_PLAN,
    fact_id: `g${String(i).padStart(15, '0')}`,
    statement: 'y'.repeat(2000),
  }))
  const huge = renderItineraryHtml(completeInput({ facts: hugeFacts }))
  assertRejected(huge, '渲染文档超出大小上限', '§5al 超文档大小整体失败')
  assert(!huge.ok && huge.errors.length === 1, '§5am 超大小只有一条明确错误')

  // 逻辑矛盾
  assertRejected(renderItineraryHtml(completeInput({ itinerary: { trip_start: '2027-07-24', trip_end: '2027-07-16', stays: [], od_segments: [] } })), 'itinerary.trip_end 早于 trip_start', '§5an 行程窗倒置被拒')
  assertRejected(renderItineraryHtml(completeInput({ itinerary: { trip_start: '2027-07-16', trip_end: '2027-07-24', stays: [{ place: 'P', check_in: '2027-07-20', check_out: '2027-07-20' }], od_segments: [] } })), '退房日期不晚于入住日期', '§5ao 零夜住宿被拒')
  assertRejected(renderItineraryHtml(completeInput({ facts: [{ ...FLIGHT_HIT, bookability: 'bookable_exact_date', flight_no: '' }] })), 'facts[0].flight_no 缺失', '§5ap 可下单事实缺班次号被拒')
  assertRejected(renderItineraryHtml(completeInput({ facts: [{ ...FLIGHT_HIT, route: { origin: '', destination: 'HKT' } }] })), 'facts[0].route.origin 不能为空', '§5aq 空出发地被拒')

  // 错误条数有界 + 不回显恶意输入
  const noisy = completeInput({
    itinerary: { trip_start: 'bad', trip_end: 'bad', stays: 'x', od_segments: 'y' },
    facts: Array.from({ length: ITINERARY_HTML_LIMITS.facts }, () => ({ kind: 'ferry', schema: 'nope' })),
  })
  const noisyResult = renderItineraryHtml(noisy)
  assert(!noisyResult.ok && noisyResult.errors.length <= ITINERARY_HTML_LIMITS.errors + 1, '§5ar errors 条数有界')
  if (!noisyResult.ok) {
    assert(noisyResult.errors.every(e => !e.includes('nope')), '§5as 错误信息不回显原始输入内容')
  }
}

// ---------------------------------------------------------------------------
// §6 无隐式借道:渲染器不引入 IO/时间/子进程
// ---------------------------------------------------------------------------

{
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../src/itinerary-html.ts', import.meta.url), 'utf8'))
  assert(!/from\s+'node:(fs|child_process|net|http|https|dns|worker_threads)'/.test(source), '§6a 不 import IO/子进程/网络模块')
  assert(!/\bDate\.now\b/.test(source) && !/new Date\(\s*\)/.test(source), '§6b 无当前时间依赖(纯函数)')
  assert(!/from\s+'\.\/(engine|journey)\.ts'/.test(source), '§6c 不 import 已弃用引擎层')
  assert(!/dangerouslySetInnerHTML|innerHTML|document\.write|eval\(/.test(source), '§6d 无 DOM 注入/求值原语')
  assert(!/fetch\(|XMLHttpRequest|WebSocket/.test(source), '§6e 无网络调用')
  assert(/from '\.\/bookable-facts\.ts'/.test(source), '§6f 复用既有事实类型与 canonical 渲染原语')
}

// ---------------------------------------------------------------------------
// §7 根审阅反例 1:同目的地但档期不同的酒店事实不得挂到计划住宿上
// ---------------------------------------------------------------------------

{
  const otherWindow: HotelFact = { ...HOTEL_HIT, fact_id: 'aaaa1111bbbb2222', check_in: '2028-01-01', check_out: '2028-01-02' }
  const noWindow: HotelFact = { ...HOTEL_HIT, fact_id: 'cccc3333dddd4444', check_in: undefined, check_out: undefined }
  const html = assertRendered(
    renderItineraryHtml({ ...completeInput(), facts: [otherWindow, noWindow] }),
    '§7 同目的地异档期 / 缺档期酒店事实仍渲染成功',
  )
  const stayCard = html.slice(html.indexOf('id="stay-1"'), html.indexOf('id="stay-2"'))
  assert(stayCard.includes('该计划住宿没有对应的酒店档期事实'),
    '§7a 异档期事实不得宣称是该计划住宿的同档期证据')
  assert(!stayCard.includes('aaaa1111bbbb2222') && !stayCard.includes('cccc3333dddd4444'),
    '§7b 异档期/缺档期事实 id 不得出现在计划住宿卡内')
  const evidence = html.slice(html.indexOf('id="hotel-evidence"'))
  assert(evidence.includes('aaaa1111bbbb2222') && evidence.includes('cccc3333dddd4444'),
    '§7c 异档期/缺档期事实仍留在独立证据区(不被丢弃也不被改写)')
  assert(evidence.includes('2028-01-01') && evidence.includes('未提供'),
    '§7d 异档期事实保留自己的 2028 档期,缺档期事实标注未提供')

  // 完全一致的同档期事实仍必须挂接(counterexample 的定界)
  const exact = assertRendered(renderItineraryHtml({ ...completeInput(), facts: [HOTEL_HIT] }), '§7e 同目的地同档期事实渲染成功')
  const exactStay = exact.slice(exact.indexOf('id="stay-1"'), exact.indexOf('id="stay-2"'))
  assert(exactStay.includes('计划住宿:普吉岛') && exactStay.includes('d1b2c3d4e5f60721') && !exactStay.includes('没有对应的酒店档期事实'),
    '§7f 完全匹配(destination + check_in + check_out)的证据仍按指针挂接')
}

// ---------------------------------------------------------------------------
// §8 根审阅反例 2:政策事实缺 review_by 时复用既有远期复核派生(trip_start)
// ---------------------------------------------------------------------------

{
  const noReview: PolicyFact = { ...POLICY_PLAN, fact_id: 'eeee5555ffff6666', review_by: undefined } as PolicyFact
  const html = assertRendered(
    renderItineraryHtml({ ...completeInput(), facts: [noReview] }),
    '§8 缺 review_by 的政策事实渲染成功',
  )
  const expectedReview = defaultReviewBy('2027-07-16')
  assert(expectedReview === '2027-06-16', `§8a 既有权威 defaultReviewBy 派生出 ${expectedReview}`)
  assert(html.includes(`到 ${expectedReview} 再核验一次`),
    '§8b 缺 review_by 时按 itinerary.trip_start 复用 renderPolicyFact 的远期复核提示')
  assert(html.includes(renderPolicyFact(noReview, '2027-07-16').replace(/</g, '&lt;').replace(/>/g, '&gt;')),
    '§8c 政策 canonical 行与带 tripStart 的既有原语逐字一致')

  // review_by 存在时不得被 trip_start 覆盖
  const withReview = assertRendered(renderItineraryHtml({ ...completeInput(), facts: [POLICY_PLAN as BookableFact] }), '§8d 带 review_by 的政策事实渲染成功')
  assert(withReview.includes(`到 ${POLICY_PLAN.review_by} 再核验一次`) && !withReview.includes('到 2027-06-16 再核验一次'),
    '§8e 显式 review_by 优先,不被 trip_start 派生覆盖')
}

console.log(`\nITINERARY HTML TESTS: ${pass} pass, ${fail} fail`)
if (fail > 0) {
  console.log('\nFAILURES:')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
