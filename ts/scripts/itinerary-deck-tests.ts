/**
 * 行程 deck 渲染器契约测试(issue #564)。
 *
 * 只使用合成数据:与 itinerary-html-tests.ts 同源的合成行程 + 4 条已注册事实
 * + 恶意 HTML 反例。不含任何用户真实行程或个人细节。
 *
 * 核心断言组:①deck 形态契约(幻灯派生/scroll-snap 零脚本翻页/导航锚点);
 * ②证据面语义与单页文档逐字一致(同一共享层);③**反漂移锁**——同一输入下
 * renderItineraryHtml 与 renderItineraryDeck 的拒绝结果(errors 数组)逐字一致;
 * ④纯度源检查;⑤字节上限与逐字节确定性。
 *
 * 运行(在 ts/ 下):npx tsx scripts/itinerary-deck-tests.ts
 */

import {
  BOOKABLE_FACT_SCHEMA,
  renderFlightFact,
  renderHotelFact,
  renderPolicyFact,
  type BookableFact,
  type FlightFact,
  type HotelFact,
  type PolicyFact,
} from '../src/bookable-facts.ts'
import { renderItineraryDeck, type ItineraryDeckResult } from '../src/itinerary-deck.ts'
import { renderItineraryHtml } from '../src/itinerary-html.ts'
import { ITINERARY_DOC_LIMITS } from '../src/itinerary-doc-shared.ts'

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

function assertRejected(result: ItineraryDeckResult, needle: string, msg: string): void {
  if (result.ok) {
    assert(false, `${msg}(期望 ok:false,实际渲染出 ${result.html.length} 字符)`)
    return
  }
  assert(result.errors.some(e => e.includes(needle)), `${msg}(errors=${JSON.stringify(result.errors)} 未含「${needle}」)`)
}

function assertRendered(result: ItineraryDeckResult, msg: string): string {
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
// 合成 fixture(与 itinerary-html-tests.ts 同源)
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
// §1 完整行程:deck 形态契约 + 证据面语义与单页文档一致
// ---------------------------------------------------------------------------

{
  const html = assertRendered(renderItineraryDeck(completeInput()), '§1 完整合成行程渲染成功')

  assert(html.startsWith('<!DOCTYPE html>\n<html lang="zh-CN">'), '§1a 输出为完整独立文档(DOCTYPE + lang)')
  assert(!/<script/i.test(html) && !/<iframe/i.test(html), '§1b 产物不含 script/iframe(零脚本翻页)')
  assert(!/\son[a-z]+\s*=/i.test(html), '§1c 产物不含内联事件处理器')
  assert(!/https?:\/\//i.test(html) && !/<link/i.test(html) && !/@import/i.test(html) && !/url\(/i.test(html),
    '§1d 产物无远端依赖(无 http/link/@import/url())')
  assert(html.includes('html{scroll-snap-type:y proximity}') && html.includes('scroll-snap-align:start'),
    '§1e 纯 CSS scroll-snap 翻页(proximity:超长页不卡死滚动)')
  assert(html.includes('counter-reset:slide') && html.includes('counter-increment:slide')
    && html.includes('content:"第 " counter(slide) " 页"'), '§1f 页码用 CSS counter 渲染(零脚本计数)')
  assert(html.includes('@media print') && html.includes('page-break-after:always'), '§1g 打印时一页一张幻灯')
  assert(html.includes('<style>') && html.includes('@media (max-width:480px)'), '§1h 样式自包含且含窄屏断点')
  assert(html.includes('<a class="skip" href="#slide-cover">'), '§1i 提供跳转封面链接(键盘可达)')

  // 页结构确定性派生:封面/按日期/3 段/2 住宿/住宿证据/政策/证据附录/航班事实 = 11 页
  assert(countOf(html, '<section class="slide') === 11, `§1j 幻灯页数确定性派生(实测 ${countOf(html, '<section class="slide')} 页,期望 11)`)
  for (const id of ['slide-cover', 'slide-overview', 'slide-seg-1', 'slide-seg-2', 'slide-seg-3',
    'slide-stay-1', 'slide-stay-2', 'slide-hotel-evidence', 'slide-policy', 'slide-leftovers', 'slide-flights']) {
    assert(html.includes(`id="${id}"`), `§1k 幻灯锚点齐全(${id})`)
  }
  // 导航是组级锚点,且每个 href 目标真实存在
  const nav = html.slice(html.indexOf('<nav class="deck-nav"'), html.indexOf('</nav>'))
  for (const label of ['封面', '按日期', '交通段', '住宿', '住宿证据', '政策', '证据附录', '航班/车次事实']) {
    assert(nav.includes(`>${label}</a>`), `§1l deck 导航含「${label}」组锚点`)
  }
  for (const href of [...nav.matchAll(/href="#(slide-[a-z-]+)"/g)].map(m => m[1])) {
    assert(html.includes(`id="${href}"`), `§1m 导航目标 ${href} 真实存在`)
  }

  // 封面:双面声明 + 证据边界 + 事实计数,与单页文档同一句话
  assert(html.includes('计划面(明示日期与段落)与证据面(已注册事实)分开陈述') && html.includes('本文档不给出整体「已验证」结论'),
    '§1n 封面带双面声明(共享层同一文案)')
  assert(html.includes('本文档只投影调用方给出的显式行程与已注册事实') && html.includes('不做夜数/预算/时间运算'),
    '§1o 封面带证据边界声明(共享层同一文案)')
  assert(html.includes('共 6 条事实(航班/车次 3,酒店 2,政策 1)'), '§1p 封面事实计数如实分解')

  // 每段/每住宿一页,计划卡内证据语义与单页文档一致
  assert(html.includes('铁路 广州南 → 深圳北 2027-07-16') && html.includes('该段可回溯的事实(独立于计划段)'),
    '§1q 交通段页带计划卡与可回溯事实')
  assert(html.includes('计划住宿:普吉岛 2027-07-17→2027-07-21') && html.includes('该目的地 + 该档期另有 1 条'),
    '§1r 住宿页带计划卡与独立证据指针')
  assert(html.includes('独立记录:目的地级酒店事实'), '§1s 住宿证据页保留独立记录区')
  assert(html.includes('政政策事实'.slice(1)) || html.includes('政策事实'), '§1t 政策页单独成页')

  // 证据字段逐条保留:canonical 原文必须随产物输出(按 HTML 文本转义后逐字可回读)
  for (const f of FACTS) {
    const canonical = f.kind === 'hotel' ? renderHotelFact(f) : f.kind === 'policy' ? renderPolicyFact(f) : renderFlightFact(f)
    assert(html.includes(canonical.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')),
      `§1u 事实 ${f.fact_id} 的 canonical 原文随产物输出(可回溯)`)
  }
  assert(html.includes('bookable_exact_date') && html.includes('unavailable_exact_date') && html.includes('unverified'),
    '§1v 三条不同 bookability 原样保留(不合并、不提升)')
  assert(html.includes('[session:ctrip-flight]') && html.includes('[flyai-hotel]'), '§1w 来源标识保留')
  assert(html.includes('该档期无结果') && html.includes('未核验'), '§1x 负事实/未核验显式渲染')
  assert(html.includes('标注为「计划」意图'), '§1y runtime.is_plan 不升级为现行政策')

  // 无整体 verified 徽章 / 无预算夜数
  assert(!html.includes('全部已核验') && !html.includes('整体已核验') && !html.includes('整体可订')
    && !html.includes('badge ok">整体'), '§1z 产物不含整体核验/可订徽章')
  assert(!/\d+\s*天\s*\d+\s*晚/.test(html) && !/共\s*\d+\s*天/.test(html) && !/总预算|预算合计/.test(html),
    '§1aa 产物无天数/预算合计')
}

// ---------------------------------------------------------------------------
// §2 部分行程:空段/空住宿/无政策时页结构如实收缩,不伪造内容
// ---------------------------------------------------------------------------

{
  const partial = {
    title: '部分行程:只有日期窗',
    itinerary: { trip_start: '2027-07-16', trip_end: '2027-07-16', stays: [], od_segments: [] },
    facts: [],
  }
  const html = assertRendered(renderItineraryDeck(partial), '§2 部分行程(单日窗、零段零住宿零事实)渲染成功')
  assert(countOf(html, '<section class="slide') === 5, `§2a 无段无住宿无政策:封面/按日期/住宿证据/证据附录/航班事实(实测 ${countOf(html, '<section class="slide')} 页,期望 5)`)
  assert(!html.includes('id="slide-seg-1"') && !html.includes('id="slide-stay-1"') && !html.includes('id="slide-policy"'),
    '§2b 无内容则不生成对应页(导航也随之收缩)')
  assert(html.includes('没有显式日期条目'), '§2c 空日期页显式说明,不合成日历日')
  assert(html.includes('本次输入没有酒店事实') && html.includes('本次输入没有航班/车次事实'), '§2d 空证据页各自成状态')
  assert(html.includes('共 0 条事实(航班/车次 0,酒店 0,政策 0)'), '§2e 零事实计数如实呈现')
  assert(!html.includes('>交通段</a>') && !html.includes('>住宿</a>') && !html.includes('>政策</a>'),
    '§2f 导航不指向不存在的页')

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
  const segHtml = assertRendered(renderItineraryDeck(segOnly), '§2g 只有交通段的行程渲染成功')
  assert(segHtml.includes('id="slide-seg-1"') && segHtml.includes('交通段 1/1'), '§2h 段页计数如实(1/1)')
  assert(segHtml.includes('该段没有匹配的已注册事实'), '§2i 计划段无证据时显式标注未核验')
}

// ---------------------------------------------------------------------------
// §3 未知不被升级(语义与单页文档同源)
// ---------------------------------------------------------------------------

{
  const unknownTier = { ...FLIGHT_HIT, fact_id: 'aaaa0000bbbb1111', tier: 'route_exists', bookability: 'unverified' }
  const html = assertRendered(
    renderItineraryDeck({ ...completeInput(), facts: [unknownTier] }),
    '§3 仅含未核验事实的输入渲染成功',
  )
  assert(html.includes('route_exists(仅航线存在)') && html.includes('unverified(未核验)'), '§3a 弱证据层原样展示')
  assert(!html.includes('该档期可下单'), '§3b 未核验事实不得到可下单措辞')

  const staleBenchmark = { ...FLIGHT_HIT, fact_id: 'cccc0000dddd2222', tier: 'benchmark_price', bookability: 'conflict', price: undefined, currency: undefined }
  const staleHtml = assertRendered(renderItineraryDeck({ ...completeInput(), facts: [staleBenchmark] }), '§3c 冲突事实渲染成功')
  assert(staleHtml.includes('conflict(两源冲突)'), '§3d 冲突状态原样展示')
  assert(!staleHtml.includes('¥undefined') && !staleHtml.includes('¥NaN'), '§3e 不产生 NaN/undefined 价格')

  const destinationOnly = assertRendered(
    renderItineraryDeck({ ...completeInput(), facts: [HOTEL_HIT] }),
    '§3f 只有目的地级酒店事实的输入渲染成功',
  )
  assert(destinationOnly.includes('不是本条目这家酒店的房型/报价'), '§3g 明确否定「目的地级 = 某家酒店」的等价')
  const staySlide = destinationOnly.slice(destinationOnly.indexOf('id="slide-stay-1"'), destinationOnly.indexOf('id="slide-hotel-evidence"'))
  assert(!staySlide.includes('住宿已核验') && !staySlide.includes('<pre'), '§3h 目的地级命中不得写成计划住宿的核验结论')
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
  const html = assertRendered(renderItineraryDeck(hostileInput), '§4 恶意 HTML 输入仍渲染(转义而非执行)')
  assert(!html.includes('<script'), '§4a 无未转义 <script')
  assert(!html.includes('<iframe'), '§4b 无未转义 <iframe')
  assert(!/<svg/i.test(html) && !html.includes('<b>') && html.includes('&lt;b&gt;加粗&lt;/b&gt;'), '§4c 事实文本中的标签被转义')
  assert(!/<[a-zA-Z][^>]*\son[a-z]+\s*=/i.test(html), '§4d 标签内无未转义事件处理器')
  assert(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), '§4e 标题中的脚本按实体转义')
  assert(html.includes('&quot;&gt;&lt;iframe'), '§4f 属性位置的双引号被转义(不能逃出属性)')
  assert(html.includes('&lt;em&gt;SZX&lt;/em&gt;'), '§4g 段起点的标签被转义')
  assert(countOf(html, '<section class="slide') === countOf(html, '</section>'), '§4h 恶意输入未破坏幻灯配对')
  assert(!/(?:href|src)\s*=\s*"?javascript:/i.test(html), '§4i javascript: 载荷不构成可执行链接')
}

// ---------------------------------------------------------------------------
// §5 拒绝集与反漂移锁:同一输入下 HTML 与 deck 的拒绝结果逐字一致
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
    // 日期边界与格式
    ['§5n1 2 月 30 日', completeInput({ itinerary: { trip_start: '2027-02-30', trip_end: '2027-07-24', stays: [], od_segments: [] } }), 'itinerary.trip_start 不是真实日历日期'],
    ['§5n2 非闰年 2 月 29', completeInput({ itinerary: { trip_start: '2027-02-29', trip_end: '2027-07-24', stays: [], od_segments: [] } }), 'itinerary.trip_start 不是真实日历日期'],
    ['§5n3 13 月', completeInput({ itinerary: { trip_start: '2027-13-01', trip_end: '2027-07-24', stays: [], od_segments: [] } }), 'itinerary.trip_start 不是真实日历日期'],
    ['§5n4 越界年', completeInput({ itinerary: { trip_start: '1999-12-31', trip_end: '2027-07-24', stays: [], od_segments: [] } }), 'itinerary.trip_start 不是真实日历日期'],
    ['§5n5 非法日期格式', completeInput({ itinerary: { trip_start: '2027/07/16', trip_end: '2027-07-24', stays: [], od_segments: [] } }), 'itinerary.trip_start 不是真实日历日期'],
    ['§5n6 时间串当日期', completeInput({ itinerary: { trip_start: '2027-07-16T00:00:00Z', trip_end: '2027-07-24', stays: [], od_segments: [] } }), 'itinerary.trip_start 不是真实日历日期'],
    // 时间戳与时刻
    ['§5o1 fetched_at 非法日历', completeInput({ facts: [{ ...FLIGHT_HIT, fetched_at: '2027-06-31T00:00:00Z' }] }), 'facts[0].fetched_at 必须是可解析的 ISO 时间戳'],
    ['§5o2 fetched_at 缺时分秒', completeInput({ facts: [{ ...FLIGHT_HIT, fetched_at: '2026-09-12' }] }), 'facts[0].fetched_at 必须是可解析的 ISO 时间戳'],
    ['§5o3 as_of 非法', completeInput({ facts: [{ ...FLIGHT_HIT, as_of: '2026-13-01' }] }), 'facts[0].as_of 必须是真实日历日期'],
    ['§5o4 dep_local 非法 HH:MM', completeInput({ facts: [{ ...FLIGHT_HIT, dep_local: '25:00' }] }), 'facts[0].dep_local 必须是 HH:MM'],
    ['§5o5 review_by 非法', completeInput({ facts: [{ ...FLIGHT_HIT, review_by: '2027-02-30' }] }), 'facts[0].review_by 必须是真实日历日期'],
    // 数值边界
    ['§5p1 无限价格', completeInput({ facts: [{ ...FLIGHT_HIT, price: Number.POSITIVE_INFINITY }] }), 'facts[0].price 必须是有限数值'],
    ['§5p2 负价格', completeInput({ facts: [{ ...FLIGHT_HIT, price: -1 }] }), 'facts[0].price 超出允许范围'],
    ['§5p3 非整数在架家数', completeInput({ facts: [{ ...HOTEL_HIT, options_masked: 1.5 }] }), 'facts[0].options_masked 必须是整数'],
    ['§5p4 负在架', completeInput({ facts: [{ ...HOTEL_HIT, options_masked: -3 }] }), 'facts[0].options_masked 超出允许范围'],
    ['§5p5 legs=0', completeInput({ itinerary: { trip_start: '2027-07-16', trip_end: '2027-07-24', stays: [], od_segments: [{ from: 'A', to: 'B', date: '2027-07-17', mode: 'car', legs: 0 }] } }), 'itinerary.od_segments[0].legs 超出允许范围'],
    ['§5p6 非整数 legs', completeInput({ itinerary: { trip_start: '2027-07-16', trip_end: '2027-07-24', stays: [], od_segments: [{ from: 'A', to: 'B', date: '2027-07-17', mode: 'car', legs: 1.5 }] } }), 'itinerary.od_segments[0].legs 必须是整数'],
    // 容量与长度上限
    ['§5q1 超量住宿', completeInput({ itinerary: { trip_start: '2027-07-16', trip_end: '2027-07-24', stays: Array.from({ length: ITINERARY_DOC_LIMITS.stays + 1 }, () => ({ place: 'P', check_in: '2027-07-17', check_out: '2027-07-18' })), od_segments: [] } }), `itinerary.stays 超出容量上限(${ITINERARY_DOC_LIMITS.stays} 条`],
    ['§5q2 超量事实', completeInput({ facts: Array.from({ length: ITINERARY_DOC_LIMITS.facts + 1 }, (_v, i) => ({ ...FLIGHT_HIT, fact_id: `f${String(i).padStart(15, '0')}` })) }), `facts 超出容量上限(${ITINERARY_DOC_LIMITS.facts} 条`],
    ['§5q3 超长 title', completeInput({ title: 'x'.repeat(ITINERARY_DOC_LIMITS.titleChars + 1) }), 'title 超出长度上限'],
    ['§5q4 超长城市名', completeInput({ itinerary: { trip_start: '2027-07-16', trip_end: '2027-07-24', stays: [], od_segments: [{ from: 'x'.repeat(ITINERARY_DOC_LIMITS.fromToChars + 1), to: 'B', date: '2027-07-17', mode: 'car', legs: 1 }] } }), 'itinerary.od_segments[0].from 超出长度上限'],
    ['§5q5 超长政策陈述', completeInput({ facts: [{ ...POLICY_PLAN, statement: 'x'.repeat(ITINERARY_DOC_LIMITS.statementChars + 1) }] }), 'facts[0].statement 超出长度上限'],
    // 逻辑矛盾
    ['§5r1 行程窗倒置', completeInput({ itinerary: { trip_start: '2027-07-24', trip_end: '2027-07-16', stays: [], od_segments: [] } }), 'itinerary.trip_end 早于 trip_start'],
    ['§5r2 零夜住宿', completeInput({ itinerary: { trip_start: '2027-07-16', trip_end: '2027-07-24', stays: [{ place: 'P', check_in: '2027-07-20', check_out: '2027-07-20' }], od_segments: [] } }), '退房日期不晚于入住日期'],
    ['§5r3 可下单事实缺班次号', completeInput({ facts: [{ ...FLIGHT_HIT, bookability: 'bookable_exact_date', flight_no: '' }] }), 'facts[0].flight_no 缺失'],
    ['§5r4 空出发地', completeInput({ facts: [{ ...FLIGHT_HIT, route: { origin: '', destination: 'HKT' } }] }), 'facts[0].route.origin 不能为空'],
  ]
  for (const [label, input, needle] of cases) {
    const deck = renderItineraryDeck(input)
    assertRejected(deck, needle, label)
    // 反漂移锁:同一输入,两个投影的 errors 逐字一致
    const doc = renderItineraryHtml(input)
    assert(doc.ok === deck.ok, `${label}(html.ok=${doc.ok} 与 deck.ok=${deck.ok} 必须一致)`)
    if (!doc.ok && !deck.ok) {
      assert(JSON.stringify(doc.errors) === JSON.stringify(deck.errors), `${label}(errors 数组必须逐字一致)`)
    }
  }

  // 噪音输入:错误条数有界 + 不回显原始输入
  const noisy = completeInput({
    itinerary: { trip_start: 'bad', trip_end: 'bad', stays: 'x', od_segments: 'y' },
    facts: Array.from({ length: ITINERARY_DOC_LIMITS.facts }, () => ({ kind: 'ferry', schema: 'nope' })),
  })
  const noisyResult = renderItineraryDeck(noisy)
  assert(!noisyResult.ok && noisyResult.errors.length <= ITINERARY_DOC_LIMITS.errors + 1, '§5u errors 条数有界')
  if (!noisyResult.ok) {
    assert(noisyResult.errors.every(e => !e.includes('nope')), '§5v 错误信息不回显原始输入内容')
    const noisyDoc = renderItineraryHtml(noisy)
    assert(!noisyDoc.ok && JSON.stringify(noisyDoc.errors) === JSON.stringify(noisyResult.errors), '§5w 噪音输入的 errors 两投影逐字一致')
  }
}

// ---------------------------------------------------------------------------
// §6 无隐式借道:渲染器与共享契约层都不引入 IO/时间/子进程;deck 切片自含纯度证据
// ---------------------------------------------------------------------------

{
  const readSource = (name: string) => import('node:fs/promises').then(fs => fs.readFile(new URL(name, import.meta.url), 'utf8'))
  const source = await readSource('../src/itinerary-deck.ts')
  const shared = await readSource('../src/itinerary-doc-shared.ts')
  // issue #564 共享契约层是本切片的事实源:deck 套件独立证明它的纯度(不只依赖 html §6c)
  for (const [label, src] of [['itinerary-deck', source], ['itinerary-doc-shared', shared]] as Array<[string, string]>) {
    assert(!/from\s+'node:(fs|child_process|net|http|https|dns|worker_threads)'/.test(src), `§6a ${label} 不 import IO/子进程/网络模块`)
    assert(!/\bDate\.now\b/.test(src) && !/new Date\(\s*\)/.test(src), `§6b ${label} 无当前时间依赖(纯函数)`)
    assert(!/from\s+'\.\/(engine|journey)\.ts'/.test(src), `§6c ${label} 不 import 已弃用引擎层`)
    assert(!/dangerouslySetInnerHTML|innerHTML|document\.write|eval\(/.test(src), `§6d ${label} 无 DOM 注入/求值原语`)
    assert(!/fetch\(|XMLHttpRequest|WebSocket/.test(src), `§6e ${label} 无网络调用`)
  }
  assert(/from '\.\/itinerary-doc-shared\.ts'/.test(source), '§6f deck 仅依赖共享契约层的事实源(无第二实现)')
  assert(/from '\.\/bookable-facts\.ts'/.test(shared), '§6g 共享契约层复用既有事实类型与 canonical 渲染原语')
}

// ---------------------------------------------------------------------------
// §7 逐字节确定性 + 文档大小硬上限
// ---------------------------------------------------------------------------

{
  const first = renderItineraryDeck(completeInput())
  const second = renderItineraryDeck(completeInput())
  assert(first.ok && second.ok && first.html === second.html, '§7a 同输入两次渲染逐字节一致')
  const docResult = renderItineraryHtml(completeInput())
  assert(first.ok && docResult.ok && first.html !== docResult.html,
    '§7b deck 与单页文档是两种投影(deck ≠ 单页输出)')
  assert(first.ok && first.html.length > 0, '§7c 产物非空')

  // 文档大小:合法但庞大的输入必须整体失败,而不是截断(与单页文档同一上限)
  const hugeFacts = Array.from({ length: ITINERARY_DOC_LIMITS.facts }, (_v, i) => ({
    ...POLICY_PLAN,
    fact_id: `g${String(i).padStart(15, '0')}`,
    statement: 'y'.repeat(2000),
  }))
  const hugeDeck = renderItineraryDeck(completeInput({ facts: hugeFacts }))
  assertRejected(hugeDeck, '渲染文档超出大小上限', '§7d 超文档大小整体失败')
  const hugeDoc = renderItineraryHtml(completeInput({ facts: hugeFacts }))
  if (!hugeDeck.ok && !hugeDoc.ok) {
    assert(hugeDeck.errors.length === 1, '§7e 超大小只有一条明确错误')
    assert(JSON.stringify(hugeDoc.errors) === JSON.stringify(hugeDeck.errors), '§7f 超大小错误两投影逐字一致')
  } else {
    assert(false, '§7d/e/f 超大输入必须两个投影同时失败(实测 deck.ok 与 doc.ok 均应为 false)')
  }
}

// ---------------------------------------------------------------------------
// §8 根审反例回归:同目的地异档期事实不得挂到计划住宿(语义与单页文档同源)
// ---------------------------------------------------------------------------

{
  const otherWindow: HotelFact = { ...HOTEL_HIT, fact_id: 'aaaa1111bbbb2222', check_in: '2028-01-01', check_out: '2028-01-02' }
  const noWindow: HotelFact = { ...HOTEL_HIT, fact_id: 'cccc3333dddd4444', check_in: undefined, check_out: undefined }
  const html = assertRendered(
    renderItineraryDeck({ ...completeInput(), facts: [otherWindow, noWindow] }),
    '§8 同目的地异档期 / 缺档期酒店事实仍渲染成功',
  )
  const staySlide = html.slice(html.indexOf('id="slide-stay-1"'), html.indexOf('id="slide-stay-2"'))
  assert(staySlide.includes('该计划住宿没有对应的酒店档期事实'),
    '§8a 异档期事实不得宣称是该计划住宿的同档期证据')
  assert(!staySlide.includes('aaaa1111bbbb2222') && !staySlide.includes('cccc3333dddd4444'),
    '§8b 异档期/缺档期事实 id 不得出现在计划住宿卡内')
  const evidence = html.slice(html.indexOf('id="slide-hotel-evidence"'))
  assert(evidence.includes('aaaa1111bbbb2222') && evidence.includes('cccc3333dddd4444'),
    '§8c 异档期/缺档期事实仍留在独立证据区(不被丢弃也不被改写)')
}

console.log(`\nITINERARY DECK TESTS: ${pass} pass, ${fail} fail`)
if (fail > 0) {
  console.log('\nFAILURES:')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}