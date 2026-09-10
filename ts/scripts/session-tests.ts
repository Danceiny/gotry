/**
 * 会话数据面 P1 测试(RFC §4 P1 exit):
 *   A-E 纯函数(确定性,进 CI):ReadGuard 分类器/批搜解析(buildEntryUrl/fixture)/提交件过滤/节律闸;
 *   F   live FlyAI 官方通道(天气回归为 deterministic fixture；live 天气观测不进 merge gate);
 *   G   live 会话检索(Chrome + 携程;**默认 SKIP**——测试永不自动开用户浏览器窗口,GOTRY_SESSION_LIVE=1 显式开启);
 *   H   酒店通道(flyai search-hotel;纯 CLI,无浏览器窗口);
 *   I   账号会话授权闸(纯函数:每会话一次/拒绝=会话内吊销/allow/off/无审批通道,确定性);
 *   J   登录引导(无凭证语义/表格完备/票据名级检查;live opt-in 同 G)。
 *   K   酒店会话面(2026-09-03 实装:entry URL/走形解析/形状嗅探/城市码指引/闸面;纯函数,transport 前短路)。
 *   L   火车会话面(2026-09-03 实装:12306 管道行解析/行级签名防索引漂移/电报码指引/闸面;公开查询面)。
 * #21 字段 scorer/双源 gate 的无网络验收独立放在 scripts/session-benchmark.ts。
 * 隔离纪律:live 用 mktemp profile 与 stateRoot,绝不动共享状态与日常浏览器 profile;
 * 任何测试不自动弹浏览器窗口(用户 Chrome 只经 CDP attach 或用户手动运行 session-login)。
 */

import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { classifyRequest, isSubmitText } from '../capabilities/session/read-guard.ts'
import { buildEntryUrl, parseBatchSearch, parseBatchSearchResult } from '../capabilities/session/adapters/ctrip-flight.ts'
import { buildHotelEntryUrl, parseCtripHotelList, looksLikeHotelListBody } from '../capabilities/session/adapters/ctrip-hotel.ts'
import { buildTrainEntryUrl, hasRecognizedAvailableSeat, parseLeftTicketQuery, parseLeftTicketQueryResult, resolveTrainQueryTelecodes, STATION_TELECODES, validateTrainQueryResponseUrl } from '../capabilities/session/adapters/rail-12306.ts'
import { buildDidaEntryUrl, parseDidaRates, looksLikeDidaRatesBody } from '../capabilities/session/adapters/dida-portal.ts'
import { sessionFlightSearch, sessionHotelSearch, sessionTrainSearch, sessionDidaSearch, trainStationUnresolvedHint, hotelCityUnresolvedHint, didaLoginHint, __resetRateLimiterForTest, __setTrainSessionTransportForTest, classifyTransportFailure } from '../capabilities/session-search.ts'
import { flyaiSearch } from '../capabilities/flyai.ts'
import { createConsentGate, type ApprovalSeam, type ConsentDecision, type SessionAccess } from '../capabilities/session-consent.ts'
import { sessionLogin, pollTicketNames, LOGIN_TARGETS } from '../capabilities/session-login.ts'
import { factsFromHotel, factsFromSessionTrain, TRAIN_FACT_FRESHNESS_RULE, TRAIN_FACT_MAX_AGE_MS } from '../src/bookable-facts.ts'

let pass = 0
let fail = 0
function assert(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    pass += 1
    console.log(`  ok - ${label}`)
  } else {
    fail += 1
    console.log(`  FAIL - ${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail)?.slice(0, 300) : ''}`)
  }
}

// A. ReadGuard 网络层分类器:方法 × URL 双因子(搜索 POST 不误伤,写请求必拦)
console.log('A. classifyRequest(方法×URL 双因子)')
assert(classifyRequest('POST', 'https://flights.ctrip.com/international/search/api/search/batchSearch?v=1') === 'allow', '搜索 POST(batchSearch)放行')
assert(classifyRequest('POST', 'https://m.ctrip.com/restapi/soa2/12345/SubmitOrder') === 'block', 'POST /SubmitOrder 拦截(驼峰复合)')
assert(classifyRequest('POST', 'https://m.ctrip.com/restapi/soa2/12345/createOrder') === 'block', 'POST /createOrder 拦截(驼峰复合)')
assert(classifyRequest('GET', 'https://pay.ctrip.com/pay/payment?x=1') === 'block', 'GET 硬支付模式拦截(任意方法)')
assert(classifyRequest('GET', 'https://m.ctrip.com/restapi/soa2/15095/SearchBoxRecommend') === 'allow', 'GET 搜索建议放行')
assert(classifyRequest('PUT', 'https://api.example.com/trade/create') === 'block', 'PUT /trade/create 拦截')
assert(classifyRequest('OPTIONS', 'https://flights.ctrip.com/api/preflight') === 'allow', 'OPTIONS 放行')

// B. batchSearch 解析(实测 schema fixture,2026-08-28)
console.log('B. parseBatchSearch(fixture)')
const fixture = JSON.stringify({
  status: 0,
  data: {
    flightItineraryList: [
      {
        flightSegments: [{ airlineName: '吉祥航空', duration: 200, flightList: [{ flightNo: 'HO5577', departureAirportName: '虹桥国际机场', arrivalAirportName: '三义机场', departureDateTime: '2026-10-01 07:35:00', arrivalDateTime: '2026-10-01 10:55:00', aircraftName: '波音737(中)' }] }],
        priceList: [{ adultPrice: 3240 }, { adultPrice: 2980 }],
      },
      { flightSegments: [{}] }, // malformed 项:跳过不抛
    ],
  },
})
const parsed = parseBatchSearch(fixture)
assert(parsed.length === 1, 'malformed 项跳过,1 个有效行程')
assert(parsed[0]?.flightNo === 'HO5577' && parsed[0]?.price === 2980, 'flightNo + priceList 最小 adultPrice')
assert(parsed[0]?.depDateTime === '2026-10-01 07:35:00' && parsed[0]?.durationMin === 200, '时刻与时长字段')
assert(parseBatchSearch('not-json').length === 0, '非 JSON 返空不抛错')

// B2. issue #279 结构化解析(malformed 不抛 + 形状异常归 error,合法空归 miss,非空归 hit)
console.log('B2. parseBatchSearchResult(issue #279 形状异常归 error,合法空归 miss,命中归 hit)')
{
  const fixtureHit = JSON.stringify({ data: { flightItineraryList: [{
    flightSegments: [{ airlineName: '吉祥航空', duration: 200, flightList: [{ flightNo: 'HO5577', departureAirportName: '虹桥', arrivalAirportName: '三义', departureDateTime: '2026-10-01 07:35:00', arrivalDateTime: '2026-10-01 10:55:00' }] }],
    priceList: [{ adultPrice: 3240 }, { adultPrice: 2980 }],
  }] } })
  const rHit = parseBatchSearchResult(fixtureHit)
  assert(rHit.verdict === 'hit' && rHit.options.length === 1 && rHit.options[0]?.flightNo === 'HO5577' && rHit.options[0]?.price === 2980, '命中 fixture → hit + 1 option + 最低价', rHit)
  const rMiss = parseBatchSearchResult(JSON.stringify({ data: { flightItineraryList: [] } }))
  assert(rMiss.verdict === 'miss' && rMiss.options.length === 0, '已识别合法空(数组存在且空) → miss(不为 hit 也不为 error)', rMiss)
  // 不抛错 + 形状未识别 → error(关键:不可静默收敛为 miss,把未知响应误判为「这条线路没航班」)
  const malformed: Array<[string, string]> = [
    ['JSON null body', 'null'],
    ['非对象根(数字)', '123'],
    ['非对象根(数组)', '[1,2,3]'],
    ['空对象', '{}'],
    ['缺 data 字段', JSON.stringify({ foo: 1 })],
    ['data 非对象(null)', JSON.stringify({ data: null })],
    ['data 是数组', JSON.stringify({ data: [] })],
    ['flightItineraryList 非数组(对象)', JSON.stringify({ data: { flightItineraryList: { foo: 1 } } })],
    ['flightItineraryList 非数组(字符串)', JSON.stringify({ data: { flightItineraryList: 'abc' } })],
    ['flightItineraryList 非数组(数字)', JSON.stringify({ data: { flightItineraryList: 42 } })],
    ['非 JSON 文本', 'not-json{'],
    ['空字符串', ''],
  ]
  for (const [label, body] of malformed) {
    let verdict: 'hit' | 'miss' | 'error' = 'error'
    let optionsLen = -1
    let threw = false
    try {
      const r = parseBatchSearchResult(body)
      verdict = r.verdict
      optionsLen = r.options.length
    } catch {
      threw = true
    }
    assert(!threw && verdict === 'error' && optionsLen === 0, `${label} → verdict=error(不抛,不为 miss)`, { verdict, optionsLen, threw })
  }
  // priceList 非数组:item 行字段虽合法,但整行结构不可信 → error,不暴露 options
  const priceMalformed = JSON.stringify({ data: { flightItineraryList: [{
    flightSegments: [{ flightList: [{ flightNo: 'HO1', departureDateTime: '2026-10-01 07:35:00' }] }],
    priceList: 'not-an-array',
  }] } })
  const rPm = parseBatchSearchResult(priceMalformed)
  assert(rPm.verdict === 'error' && rPm.options.length === 0, 'priceList 显式非数组 → error 且不暴露 options', rPm)
  // 已识别列表非空 + 行全部畸形 → error(没有可呈现的航段,不伪装成 miss)
  const allBadRows = JSON.stringify({ data: { flightItineraryList: [
    { flightSegments: [{}] },
    'not-an-object-row',
    null,
  ] } })
  const rAb = parseBatchSearchResult(allBadRows)
  assert(rAb.verdict === 'error' && rAb.options.length === 0, '非空列表行全畸形 → error(不伪装成 miss)', rAb)
  // 混合列表保留有效项,忽略畸形兄弟行
  const mixed = JSON.stringify({ data: { flightItineraryList: [
    { flightSegments: [{}], priceList: [{ adultPrice: 'bad' }] },
    { flightSegments: [{ flightList: [{ flightNo: 'HO2', departureDateTime: '2026-10-01 08:00:00' }] }], priceList: [] },
  ] } })
  const rMixed = parseBatchSearchResult(mixed)
  assert(rMixed.verdict === 'hit' && rMixed.options.length === 1 && rMixed.options[0]?.flightNo === 'HO2' && rMixed.options[0]?.price === 0, '混合列表 → 保留有效项并忽略畸形兄弟行', rMixed)
  // 兼容性:旧 API parseBatchSearch 与新 API options 字段逐项一致
  const compatParsed = parseBatchSearch(fixtureHit)
  assert(compatParsed.length === rHit.options.length && compatParsed[0]?.flightNo === rHit.options[0]?.flightNo && compatParsed[0]?.price === rHit.options[0]?.price, '旧 API parseBatchSearch 返回的 options 字段与新 API 一致(兼容性)', { compat: compatParsed[0], new: rHit.options[0] })
}

// C. adapter entry URL
console.log('C. buildEntryUrl(城市码表)')
const e1 = buildEntryUrl('上海', '丽江', '2026-10-01')
assert(e1.ok === true && e1.url === 'https://flights.ctrip.com/online/list/oneway-sha-ljg?depdate=2026-10-01', '上海→丽江 URL 精确')
const e2 = buildEntryUrl('乌兰巴托', '丽江', '2026-10-01')
assert(e2.ok === false && e2.unresolved?.[0] === '乌兰巴托', '词表外城市 unresolved 逐字保留(不猜)')
assert(buildEntryUrl('上海', '丽江', '十月一号').ok === false, '非法日期拒绝')

// D. DOM 提交件过滤
console.log('D. isSubmitText(DOM 提交件黑名单)')
assert(isSubmitText('立即下单') && isSubmitText('去支付') && isSubmitText('提交订单'), '下单/支付/提交 命中')
assert(!isSubmitText('搜索') && !isSubmitText('筛选'), '搜索/筛选 不误伤')

// E. 节律闸(无需 Chrome:闸在 entry 构建前触发)
console.log('E. 节律闸(≥30s 间隔)')
__resetRateLimiterForTest()
const r1 = await sessionFlightSearch({ from: '乌兰巴托', to: '丽江', date: '2026-10-01' })
const r2 = await sessionFlightSearch({ from: '上海', to: '丽江', date: '2026-10-01' })
assert(r1.verdict === 'error' && /unresolved/.test(r1.error ?? ''), '首次调用:词表外 → error(unresolved)')
assert(r2.verdict === 'cooldown', '30s 内二次调用 → cooldown,不发起导航')
__resetRateLimiterForTest()

// F. transport 失败分类 + live FlyAI 官方通道
console.log('F. transport verdict + flyaiSearch(live,飞猪官方,无 key;GOTRY_SESSION_LIVE=0 跳过)')
assert(classifyTransportFailure('日常 Chrome 未开调试端口', true) === 'needs-attach', '调试端口未开稳定投影 needs-attach')
assert(classifyTransportFailure('cdp attach 失败:socket closed', true) === 'needs-attach', 'CDP 握手失败稳定投影 needs-attach')
assert(classifyTransportFailure('chrome launch failed', false) === 'error', '隔离 profile 启动失败不误投影用户门禁')
let fr: Awaited<ReturnType<typeof flyaiSearch>> | null = null
if (process.env.GOTRY_SESSION_LIVE === '0') {
  console.log('  SKIP - GOTRY_SESSION_LIVE=0(离线门禁不调用 FlyAI 外部实时端点)')
} else {
  fr = await flyaiSearch({ kind: 'flight', origin: '上海', destination: '丽江', depDate: '2026-10-01' })
  const sentinelBlocked = fr.verdict === 'error' && /sentinel|block|trial limit/i.test(fr.error ?? '')
  if (sentinelBlocked) {
    console.log('  WARN - 飞猪上游限流(Sentinel 2026-08-28 / trial-limit 429 2026-08-31 实测,配额未文档化)——降级合同验证通过,跳过 hit 断言')
    assert(fr.ok === false && /\[实时API:flyai@error@/.test(fr.evidence), '限流降级:结构化 error + 证据链错误形')
  } else {
    assert(fr.ok === true && fr.verdict === 'hit', '上海→丽江 hit', fr)
    assert((fr.options?.length ?? 0) >= 1 && (fr.options?.every((o) => o.price > 0 && /^\d+[A-Z]\d+|^[A-Z]{2}\d+/.test(o.no)) ?? false), '结构化字段齐(price>0,航班号形)', fr.options?.[0])
  }
  assert(/\[实时API:flyai/.test(fr.evidence), '证据链 [实时API:flyai@*]')
}

// F2. 离线回归(issue #24):上游语义失败——CLI exit=0 且 {"data":null,"message":"出发日期非法"}
// 必须带上游原话走结构化 error,不得吞成 miss(miss 会误导模型「这条线路没有航班」)
{
  const fakeDir = mkdtempSync(join(tmpdir(), 'flyai-fake-'))
  const fakeCli = join(fakeDir, 'flyai-cli-fake')
  writeFileSync(fakeCli, '#!/bin/sh\necho \'{"data":null,"message":"出发日期非法","status":1,"systemMessage":null}\'\nexit 0\n', { mode: 0o755 })
  const fr2 = await flyaiSearch({ kind: 'flight', origin: '深圳', destination: '普吉', depDate: '2026-07-18', cliBin: fakeCli })
  assert(fr2.ok === false && fr2.verdict === 'error', 'data:null 语义失败 → error 终态(非 miss)', fr2)
  assert(/出发日期非法/.test(fr2.error ?? '') && /flyai@error@/.test(fr2.evidence), '上游原话透传 + 证据链错误形', fr2)
  rmSync(fakeDir, { recursive: true, force: true })
}

// F3. stdout 截断回归(issue #84):CLI 分片异步写 >64KB 后立即 exit——
// 管道消费丢未 flush 尾部(实测截 ~7.6KB,静默 exit=0);文件重定向同步写不丢。
{
  const bigDir = mkdtempSync(join(tmpdir(), 'flyai-trunc-'))
  const payloadJs = join(bigDir, 'payload.js')
  const itemCount = 100
  writeFileSync(payloadJs, `
const items = []
for (let i = 0; i < ${itemCount}; i++) {
  items.push({
    journeys: [{ segments: [{
      marketingTransportName: '吉祥航空', marketingTransportNo: 'HO' + (1000 + i),
      depDateTime: '2026-09-15 08:30', arrDateTime: '2026-09-15 12:10',
      depStationName: '浦东国际机场', arrStationName: '长水机场', duration: '220', seatClassName: '经济舱',
    }] }],
    ticketPrice: String(800 + i),
    jumpUrl: 'https://fliggy.com/item/' + 'x'.repeat(800) + i,
  })
}
const payload = JSON.stringify({ data: { itemList: items } })
const step = Math.ceil(payload.length / 100)
for (let i = 0; i < 100; i++) process.stdout.write(payload.slice(i * step, (i + 1) * step))
process.exit(0)
`)
  const bigBin = join(bigDir, 'flyai-cli-big')
  writeFileSync(bigBin, `#!/bin/sh\nexec node "${payloadJs}"\n`, { mode: 0o755 })
  const tr = await flyaiSearch({ kind: 'flight', origin: '上海', destination: '昆明', depDate: '2026-09-15', cliBin: bigBin })
  assert(tr.ok === true && tr.verdict === 'hit' && tr.options?.length === itemCount,
    `大载荷 ${itemCount} 条(>64KB)完整解析无截断(#84)`, { verdict: tr.verdict, options: tr.options?.length, error: tr.error })
  rmSync(bigDir, { recursive: true, force: true })
}

// G. live 会话检索(默认 SKIP:例行动回归**永不**自启浏览器窗口—— founder 2026-08-29 反馈
// 「匿名窗口反复打开携程/浏览器闪退」= 测试骚扰,live 须显式 GOTRY_SESSION_LIVE=1 请求)
console.log('G. sessionFlightSearch(live,Chrome+携程;默认跳过,GOTRY_SESSION_LIVE=1 显式开启)')
if (process.env.GOTRY_SESSION_LIVE !== '1') {
  console.log('  SKIP - 会话 live 探针默认关(测试不再自动开浏览器窗口;GOTRY_SESSION_LIVE=1 显式开启)')
} else {
  __resetRateLimiterForTest()
  const iso = mkdtempSync(join(tmpdir(), 'gotry-session-test-'))
  // G1 登录闸合同:匿名实例默认拒绝(headless 本地启 Chrome,不触网)
  const nl = await sessionFlightSearch({ from: '上海', to: '丽江', date: '2026-10-01', profileDir: join(iso, 'anon-profile'), headless: true })
  assert(nl.verdict === 'needs-login' && nl.ok === false, '匿名实例 → needs-login(不导航不发请求)', nl)
  __resetRateLimiterForTest()
  // G2 链路自检:allowAnonymous 显式开闸后,嗅探/解析/守卫全链验证(真实登录态走 scripts/session-login.ts 后的默认 profile)
  const sr = await sessionFlightSearch({ from: '上海', to: '丽江', date: '2026-10-01', profileDir: join(iso, 'profile'), headless: false, allowAnonymous: true, auditPath: join(iso, 'audit', 'session-incidents.jsonl') })
  if (sr.verdict === 'challenged') {
    console.log(`  WARN - 风控命中(平台方差,合同路径验证通过):${sr.error}`)
    assert(sr.ok === false && sr.verdict === 'challenged', 'challenged = degraded 语义正确(不重试不绕过)')
  } else if (sr.verdict === 'error' && /chrome launch failed/.test(sr.error ?? '')) {
    console.log('  SKIP - 本机无 Chrome(channel:chrome 不可用)')
  } else if (sr.verdict === 'error' && /chrome launch failed/i.test(sr.error ?? '')) {
    console.log('  SKIP - 本机无 Chrome(channel:chrome 不可用)')
  } else if ((sr.verdict === 'miss' || sr.verdict === 'error') && /blocked=0/.test(sr.evidence)) {
    // 匿名自检态 0 options = 外部会话数据面未取回(站点方差/匿名态;三值语义与 Sentinel 限流同构:
    // miss ≠ 链路断,守卫/证据/审计合同仍在 miss 证据里验证)。真 hit 收敛挂 founder 登录态(D-13)。
    console.log(`  SKIP - 会话数据面 miss(外部方差,合同降级语义):${sr.evidence.slice(0, 90)}`)
  } else if (sr.verdict === 'error' && /timeout/i.test(sr.error ?? '')) {
    // 页面 30s 未完成加载(外部网络方差;与 flyai 端点不可达降级同构:可达性不进合并闸)
    console.log(`  SKIP - 携程页面加载超时(外部方差,合同降级语义):${String(sr.error).slice(0, 80)}`)
    assert(sr.ok === false && /\[会话:ctrip-flight@error@/.test(sr.evidence), '超时降级仍带证据链错误形')
  } else {
    assert(sr.ok === true && sr.verdict === 'hit' && (sr.options?.length ?? 0) >= 1, '上海→丽江 会话嗅探 hit', sr)
    assert(sr.options?.every((o) => o.price > 0 && o.depDateTime.includes('2026-10-01')) ?? false, '班期=查询日,价格>0', sr.options?.[0])
    assert(/\[会话:ctrip-flight@/.test(sr.evidence) && /blocked=0/.test(sr.evidence), '证据链 [会话:*] + ReadGuard 零拦截(纯只读)')
    assert(!existsSync(join(iso, 'audit', 'session-incidents.jsonl')), '审计文件不出现(零写请求)')
    // 双源对照(记录式):FlyAI vs 携程会话 同查询最低价
    const flyaiMin = Math.min(...(fr?.options?.map((o) => o.price).filter((p) => p > 0) ?? [0]))
    const sessionMin = Math.min(...(sr.options?.map((o) => o.price).filter((p) => p > 0) ?? [0]))
    console.log(`  双源对照:FlyAI 最低 ¥${flyaiMin} vs 会话(携程)最低 ¥${sessionMin}(同日同线路,记录不判等)`)
  }
  rmSync(iso, { recursive: true, force: true })
}

// H. 酒店通道(2026-08-29 平铺接入):live 双合法终态 + 离线解析 + 参数闸
console.log('H. flyaiSearch hotel(飞猪官方 search-hotel)')
{
  // H1 live:带日期两形态(成对可选;未定档期可不带日期)
  if (process.env.GOTRY_SESSION_LIVE === '0') {
    console.log('  SKIP - GOTRY_SESSION_LIVE=0(离线门禁不调用 FlyAI 酒店实时端点)')
  } else {
    const hr = await flyaiSearch({ kind: 'hotel', destName: '大理', checkInDate: '2026-10-01', checkOutDate: '2026-10-03' })
    const hSentinel = hr.verdict === 'error' && /sentinel|block/i.test(hr.error ?? '')
    if (hSentinel) {
      console.log('  WARN - 飞猪 Sentinel 限流——降级合同验证通过,跳过 hit 断言')
      assert(hr.ok === false && /\[实时API:flyai@error@/.test(hr.evidence), '酒店限流降级:结构化 error + 证据链错误形')
    } else if (hr.ok === false) {
      console.log(`  WARN - flyai hotel 端点降级(${String(hr.error).slice(0, 60)})——证据链合同通过,hit 断言跳过`)
      assert(/\[实时API:flyai@error@/.test(hr.evidence), '端点降级仍带证据链错误形')
    } else {
      assert(hr.verdict === 'hit' && (hr.hotels?.length ?? 0) >= 1, '大理酒店 hit', hr.hotels?.[0])
      assert(hr.hotels?.every(h => !!h.name && !!h.jumpUrl) ?? false, '条目结构化(name + jumpUrl 透传)', hr.hotels?.[0])
    }
    assert(/\[实时API:flyai/.test(hr.evidence), '证据链 [实时API:flyai@*]')
  }
  // H2 离线 malformed-batch 合同:有效酒店 + malformed sibling → 整体 error,zero facts
  const fakeDir = mkdtempSync(join(tmpdir(), 'flyai-hotel-fake-'))
  const fakeCliH = join(fakeDir, 'flyai-hotel-fake')
  writeFileSync(fakeCliH, '#!/bin/sh\necho \'{"data":{"itemList":[{"name":"大理A 酒店","shId":"1","star":"高档型","rate":null,"price":"\\u00a57xx","address":"addr","interestsPoi":"近洱海","detailUrl":"https://router.feizhu.com/x"},{"star":"舒适型"}]}}\'\nexit 0\n', { mode: 0o755 })
  const h2 = await flyaiSearch({ kind: 'hotel', destName: '大理', cliBin: fakeCliH })
  assert(h2.verdict === 'error' && h2.hotels === undefined, '酒店有效+malformed sibling → 整体 structured error', h2)
  assert(/hotel itemList malformed.*1\/2/i.test(h2.evidence), '酒店 mixed error 暴露 malformed/总条目比例', h2)
  const h2Facts = factsFromHotel({ source: 'flyai-hotel', destination: '大理', checkIn: '2026-10-01', checkOut: '2026-10-03', verdict: h2.verdict, options: 0, evidence: h2.evidence, fetchedAt: new Date().toISOString() })
  assert(h2Facts.length === 0, '酒店 mixed error 不落酒店事实', h2Facts)

  // H3 单一完整合法酒店 → hit/1,字段保真(priceRaw/star/jumpUrl)
  writeFileSync(fakeCliH, '#!/bin/sh\necho \'{"data":{"itemList":[{"name":"大理A 酒店","shId":"1","star":"高档型","rate":null,"price":"\\u00a57xx","address":"addr","interestsPoi":"近洱海","detailUrl":"https://router.feizhu.com/x"}]}}\'\nexit 0\n', { mode: 0o755 })
  const h3 = await flyaiSearch({ kind: 'hotel', destName: '大理', cliBin: fakeCliH })
  assert(h3.verdict === 'hit' && h3.hotels?.length === 1, '单一完整酒店 → hit/1', h3)
  const h0 = h3.hotels?.[0]
  assert(h0?.name === '大理A 酒店' && h0?.priceRaw === '¥7xx' && h0?.price === 0, '打码价保 priceRaw 原值(数字价 0)', h0)
  assert(h0?.star === '高档型' && h0?.hotelId === '1' && h0?.jumpUrl === 'https://router.feizhu.com/x', 'star/jumpUrl(shId/detailUrl)透传', h0)
  // H4 参数闸:无目的地 / 日期不成对 / 非规整日期 都走结构化 error,不发上游
  const hb1 = await flyaiSearch({ kind: 'hotel' })
  assert(hb1.verdict === 'error' && /destName|目的地/.test(hb1.error ?? ''), '缺目的地 → bad args error', hb1)
  const hb2 = await flyaiSearch({ kind: 'hotel', destName: '大理', checkInDate: '2026-10-01' })
  assert(hb2.verdict === 'error' && /成对/.test(hb2.error ?? ''), '入住/退房不成对 → error(不静默)', hb2)
  assert((await flyaiSearch({ kind: 'hotel', destName: '大理', checkInDate: '10月1号', checkOutDate: '2026-10-03' })).verdict === 'error', '非法日期格式 → error')
  rmSync(fakeDir, { recursive: true, force: true })
}

// I. 账号会话授权闸(纯函数;v2 语义:每会话每站点一次,拒绝=会话内吊销,不再逐次弹卡)
console.log('I. createConsentGate(账号会话授权:每会话一次/拒绝吊销/allow/off/无通道)')
{
  const next = async (): Promise<ConsentDecision> => ({ kind: 'allow' })
  const agentA = { id: 'agent-A' } as unknown as object
  const agentB = { id: 'agent-B' } as unknown as object
  const sess = (a: object = agentA) => ({ name: 'gotry_session_search', agent: a, callId: 'c1', arguments: { kind: 'flight' } })
  const other = () => ({ name: 'gotry_anything_search', agent: agentA })
  const mkStore = () => new WeakMap<object, { granted: Set<string>; denied: Set<string> }>()
  const mkGate = (access: SessionAccess, seam?: ApprovalSeam) =>
    createConsentGate({ access: () => (access as string), approval: seam ? () => seam : undefined, store: mkStore() })

  // I1 无审批通道(headless/极简宿主):账号工具 → ask(交运行时 fail-closed);非账号工具放行
  const gateBare = createConsentGate({ access: () => 'ask' })
  const d1 = await gateBare({ name: 'gotry_session_search', agent: undefined, arguments: { from: '上海' } }, next)
  assert(d1.kind === 'ask' && /携程机票/.test(String(d1.reason ?? '')), '缺省 kind → flight 默认并交运行时 fail-closed ask', d1)
  assert((await gateBare({ name: 'gotry_anything_search', agent: undefined }, next)).kind === 'allow', '非账号工具不过闸,原样放行')

  // I2 批准一次 → 会话内记住:第二次免弹卡直接放行(审批请求计数恒 1)
  {
    let requests = 0
    const seam: { request: ApprovalSeam['request'] } = { request: async () => { requests += 1; return 'allowed-once' } }
    const gate = createConsentGate({ access: () => 'ask', approval: () => seam })
    const r1 = await gate(sess(), next)
    assert(r1.kind === 'allow' && requests === 1, '首次调用:弹卡一次,批准后放行', { r1, requests })
    const r2 = await gate(sess(), next)
    assert(r2.kind === 'allow' && requests === 1, '会话内第二次调用免弹卡直接放行(不重复骚扰)', { r2: r1, requests })
  }

  // I3 拒绝 = 本会话吊销:deny 且不再弹卡;另一会话不受影响
  {
    let requests = 0
    const seam: ApprovalSeam = { request: async () => { requests += 1; return 'rejected' } }
    const store = mkStore()
    const gate = createConsentGate({ access: () => 'ask', approval: () => seam, store })
    const d1 = await gate(sess(), next)
    assert(d1.kind === 'deny' && /拒绝/.test(String(d1.kind === 'deny' ? d1.reason : '')), '拒绝 → deny + 明示「本会话内生效」', d1)
    const d2 = await gate(sess(), next)
    assert(d2.kind === 'deny' && requests === 1, '拒绝后再次调用 → 直接 deny,不再弹卡(拒绝=吊销)', { d2 })
    const dB = await gate({ name: 'gotry_session_search', agent: agentB, arguments: { kind: 'flight' } }, next)
    assert(dB.kind === 'deny' && requests === 2, '另一会话不受此前拒绝影响——会重新发起一次审批请求(seam 本例仍拒)', { dB, requests })
  }

  // I4 off 总闸:不弹卡直接 deny;非账号工具不受影响
  {
    const gate = mkGate('off')
    const d = await gate(sess(), next)
    assert(d.kind === 'deny' && /sessionAccess=off/.test(String(d.kind === 'deny' ? d.reason : '')), 'off → 不弹卡直接 deny', d)
    const train = await gate({ name: 'gotry_session_search', agent: agentA, arguments: { kind: 'train' } }, next)
    assert(train.kind === 'deny' && /sessionAccess=off/.test(String(train.kind === 'deny' ? train.reason : '')), 'off → train 公开查询面同样 deny(不绕过总闸)', train)
    assert((await gate(other(), next)).kind === 'allow', 'off 只关账号面工具,其余放行')
  }

  // I5 allow(配置级预授权):直接放行,不弹卡
  {
    const gate = mkGate('allow')
    assert((await gate(sess(), next)).kind === 'allow', 'sessionAccess=allow → 配置明示预授权,直接放行')
    assert((await gate({ name: 'gotry_session_search', agent: agentA, arguments: { kind: 'train' } }, next)).kind === 'allow', 'sessionAccess=allow → train 也按总闸预授权放行')
  }

  // I5b train 的 ask/拒绝隔离:公开查询面仍必须走同一站点授权桶。
  {
    let requests = 0
    const seam: ApprovalSeam = { request: async () => { requests += 1; return requests === 1 ? 'rejected' : 'allowed-once' } }
    const trainAgent = { id: 'agent-train' } as unknown as object
    const gate = createConsentGate({ access: () => 'ask', approval: () => seam })
    const rejected = await gate({ name: 'gotry_session_search', agent: trainAgent, arguments: { kind: 'flight' } }, next)
    assert(rejected.kind === 'deny' && requests === 1, 'ask 首次 flight 拒绝 → deny + 请求数恰为 1', rejected)
    const allowed = await gate({ name: 'gotry_session_search', agent: trainAgent, arguments: { kind: 'train' } }, next)
    assert(allowed.kind === 'allow' && requests === 2, '拒绝 flight 不污染 train:另一站点恰再请求一次并允许', allowed)
    const cached = await gate({ name: 'gotry_session_search', agent: trainAgent, arguments: { kind: 'train' } }, next)
    assert(cached.kind === 'allow' && requests === 2, 'train 同站批准缓存:后续调用不再请求', cached)
  }

  // I6 site-bound(#308):授权与拒绝均按 site(kind)分桶,跨站不得互授;同站复用放行;
  //    unknown/malformed kind 失败关闭(不扩权);query-first 冲突形态与 flat args 一致。
  {
    let requests = 0
    const seam: ApprovalSeam = { request: async () => { requests += 1; return 'allowed-once' } }
    const store = mkStore()
    const gate = createConsentGate({ access: () => 'ask', approval: () => seam, store })

    // 6a flat args:首次 dida 弹卡 + 放行;同会话再调 ctrip-flight 必须再弹卡(跨站不互授)
    const r1 = await gate({ name: 'gotry_session_search', agent: agentA, callId: 'c-dida', arguments: { kind: 'dida' } }, next)
    assert(r1.kind === 'allow' && requests === 1, 'flat args:首次 dida 弹卡 + 放行', { r1, requests })
    const r2 = await gate({ name: 'gotry_session_search', agent: agentA, callId: 'c-ctrip', arguments: { kind: 'flight' } }, next)
    assert(r2.kind === 'allow' && requests === 2, 'flat args:ctrip-flight 跨站必须再弹卡', { r2, requests })

    // 6b 同站(flight)二次调用:免弹卡直接放行
    const r3 = await gate({ name: 'gotry_session_search', agent: agentA, callId: 'c-ctrip-2', arguments: { kind: 'flight' } }, next)
    assert(r3.kind === 'allow' && requests === 2, 'flat args:ctrip-flight 同站复用,免弹卡', { r3, requests })

    // 6c wrapped args:{ query: { kind: 'hotel' } } 形态必须同样识别为 ctrip-hotel
    const r4 = await gate({ name: 'gotry_session_search', agent: agentA, callId: 'c-hotel', arguments: { query: { kind: 'hotel' }, kind: 'flight' } }, next)
    assert(r4.kind === 'allow' && requests === 3, 'kind=hotel → ctrip-hotel 站点弹卡(独立分桶)', { r4, requests })

    // 6d 拒绝隔离:拒绝 ctrip-flight 后,同会话调 dida 仍须弹卡(deny 不跨站污染)
    let rejReq = 0
    const seamRej: ApprovalSeam = { request: async () => { rejReq += 1; return 'rejected' } }
    const gateRej = createConsentGate({ access: () => 'ask', approval: () => seamRej, store })
    const agentRej = { id: 'agent-rej' } as unknown as object
    const d1 = await gateRej({ name: 'gotry_session_search', agent: agentRej, callId: 'r1', arguments: { kind: 'flight' } }, next)
    assert(d1.kind === 'deny' && rejReq === 1, '拒绝 ctrip-flight → deny(弹卡一次)', { d1, rejReq })
    const d2 = await gateRej({ name: 'gotry_session_search', agent: agentRej, callId: 'r2', arguments: { kind: 'dida' } }, next)
    assert(d2.kind === 'deny' && rejReq === 2, '拒绝不跨站污染:同会话 dida 仍须弹卡(被拒后)', { d2, rejReq })

    // 6e unknown kind 失败关闭(不弹卡,不让过;无审批通道语义但带 agent 时更稳)
    const rU = await gate({ name: 'gotry_session_search', agent: agentA, callId: 'c-xx', arguments: { kind: 'not-a-kind' } }, next)
    assert(rU.kind === 'deny', 'unknown kind → fail-closed deny(不扩权)', rU)
    const rMalformed = await gate({ name: 'gotry_session_search', agent: agentA, callId: 'c-malformed', arguments: { kind: 42 } }, next)
    assert(rMalformed.kind === 'deny', 'malformed kind → fail-closed deny(不把异常降成 flight)', rMalformed)
  }
}

// J. 登录引导(产品工具 gotry_session_login 的能力层;纯函数/确定性部分)
//    语义红线(founder):登录永远发生在外部网站——gotry 永不经手密码/验证码/cookie 值,
//    只读「票据 cookie 名」这个存在性事实(名称级,0 个值过手)。
console.log('J. sessionLogin(登录引导:无凭证语义/表格完备/pending 语义)')
{
  // J1 表格完备:每个站点必须有 domain/names/label/entryUrl,票据名表非空
  for (const [site, t] of Object.entries(LOGIN_TARGETS)) {
    assert(!!t.domain && t.names.length > 0 && !!t.label && t.entryUrl.startsWith('https://'), `${site} 登录目标表完备`, t)
  }
  // J2 未知站点 → 结构化 error,不抛错
  const unknownSite = await sessionLogin({ site: 'not-a-site', waitMs: 0 })
  assert(unknownSite.ok === false && unknownSite.verdict === 'error' && /未知站点/.test(unknownSite.error ?? ''), '未知站点 → 结构化 error(降级不抛)', unknownSite)
  // J3 pollTicketNames 名称级:只回名字,绝不携带任何 cookie 值(值即便在 fixture 里也到不了 results)
  {
    const fakeBrowser = { cookies: async () => [
      { domain: '.ctrip.com', name: 'cticket', value: 'SECRET-TICKET' },
      { domain: 'ctrip.com', name: 'uid', value: 'SECRET-UID' },
      { domain: 'ctrip.com', name: 'irrelevant', value: 'x' },
    ] } as { cookies(): Promise<Array<{ domain?: string; name?: string; value?: string }>> }
    const names = await pollTicketNames(fakeBrowser, LOGIN_TARGETS['ctrip-flight']!)
    assert(JSON.stringify(names) === '["cticket","uid"]', '票据名级检查:只回名字;值(SOCRET)永不进入结果', names)
    const joined = JSON.stringify(names)
    assert(!joined.includes('SECRET'), '存在性检查零值过手(fixture 值不泄露)', joined)
  }
  // J4 live(opt-in,同 G 节纪律):不交互的短等待 → needs-attach(Chrome 未开调试)或 pending(入口已开)
  if (process.env.GOTRY_SESSION_LIVE === '1') {
    const lr = await sessionLogin({ waitMs: 2500, pollMs: 500 })
    if (lr.verdict === 'needs-attach') {
      assert(lr.ok === false && /chrome:\/\/inspect/.test(lr.error ?? ''), 'live:Chrome 未开调试 → needs-attach + 一次性指引', lr)
    } else if (lr.verdict === 'logged-in') {
      // 自动检测快路径:票据已在 → 零弹窗直接确认(不打开任何页面)
      assert(lr.ok === true && (lr.tickets?.length ?? 0) > 0, 'live:已登录自动检测 → logged-in(零弹窗,票据名级)', lr)
    } else {
      assert(lr.ok === true && lr.verdict === 'pending', 'live:attach 成功不交互 → pending(入口已开,等人登录)', lr)
      const evidenceTagRe = /\[会话:ctrip-flight-login@/
      if (!evidenceTagRe.test(lr.evidence ?? '')) throw new Error(`FAIL: 登录证据链缺失,实际 ${lr.evidence}`)
      pass += 1
      console.log('  ok - 登录证据链 [会话:ctrip-flight-login@*] 形态')
    }
  } else {
    console.log('  SKIP - 登录 live 探针默认关(GOTRY_SESSION_LIVE=1 opt-in;工具面/桌面入口才真调)')
  }
}


// K. 酒店会话面(2026-09-03 实装,迪拜 session 复盘:会话面此前只有机票)
console.log('K. 酒店适配器(buildHotelEntryUrl/走形解析/形状嗅探/城市码指引/节律与日期闸)')
{
  // K1 entry URL:cityId 覆盖 / 码表 / 未收录
  const h1 = buildHotelEntryUrl({ to: '迪拜', cityId: 220, checkIn: '2026-12-01', checkOut: '2026-12-03', adults: 2 })
  assert(h1.ok && h1.url === 'https://hotels.ctrip.com/hotels/list?city=220&checkin=2026-12-01&checkout=2026-12-03&adult=2', 'cityId 显式覆盖 + 参数序', h1)
  const h2 = buildHotelEntryUrl({ to: '上海' })
  assert(h2.ok && h2.url === 'https://hotels.ctrip.com/hotels/list?city=2', '码表内城市(上海=2,实测校准)', h2)
  const h3 = buildHotelEntryUrl({ to: '不在码表的城市' })
  assert(!h3.ok && h3.unresolved?.includes('不在码表的城市') === true, '未收录城市 unresolved(不猜 id,不造数)', h3)
  assert(/city=/.test(hotelCityUnresolvedHint(['迪拜'])), '未收录指引带 cityId 发现路径(web 搜 list 页 URL)')

  // K1b 实测校准抽查:迪拜=220/丽江=37/大理=36(2026-09-03 页面 title 验证)
  const hDubai = buildHotelEntryUrl({ to: '迪拜' })
  assert(hDubai.ok && hDubai.url!.includes('city=220'), '迪拜=220(实测,轨迹里 agent 构造的 id 正确)', hDubai)
  const hLijiang = buildHotelEntryUrl({ to: '丽江' })
  assert(hLijiang.ok && hLijiang.url!.includes('city=37'), '丽江=37(实测)', hLijiang)

  // K2 走形解析:domestic 形态(priceInfo 对象)/扁平形态/打码价/malformed
  // K2b 携程现行真实形态(一方校准 2026-09-03:hotelInfo 包裹 + roomInfo[].priceInfo.price 官方价格路径)
  const realShape = JSON.stringify({
    initListData: { hotelList: [{
      hotelInfo: {
        summary: { hotelId: '3732301', nameInfo: { name: 'Ibis Styles Dubai Jumeira', names: ['Ibis Styles Dubai Jumeira'] }, hotelStar: { star: 3 }, positionInfo: { address: 'Al Mina Road - Jumeirah 1' } },
        commentInfo: { commentScore: '4.4' },
        roomInfo: [
          { priceInfo: { price: 520 } },
          { priceInfo: { price: 468, displayPrice: '¥468起' } },
        ],
      },
    }] },
  })
  const realHotels = parseCtripHotelList(realShape)
  assert(realHotels.length === 1, '真实形态(hotelInfo 包裹)解析命中', realHotels)
  assert(realHotels[0]!.name === 'Ibis Styles Dubai Jumeira' && realHotels[0]!.hotelId === '3732301' && realHotels[0]!.star === 3 && realHotels[0]!.score === '4.4', '结构化字段(名/id/星/评分)', realHotels[0])
  assert(realHotels[0]!.price === 468, '多房型取最低价(roomInfo[].priceInfo.price 官方路径)', realHotels[0])
  assert(realHotels[0]!.jumpUrl === 'https://hotels.ctrip.com/hotel/3732301', '真实形态 jumpUrl 构造', realHotels[0])

  // K2c 加密价形态(priceToken 在而无 price):不伪造任何价,条目保留(名/星/评分仍可用)
  const encryptedShape = JSON.stringify({
    hotelList: [{
      hotelInfo: {
        summary: { hotelId: '999', nameInfo: { names: ['Atlantis The Palm'] }, hotelStar: { star: 5 } },
        commentInfo: { commentScore: '4.8' },
        roomInfo: [{ priceInfo: { priceToken: 'ENCRYPTED_TOKEN', isHiddenPrice: false } }],
      },
    }],
  })
  const encHotels = parseCtripHotelList(encryptedShape)
  assert(encHotels.length === 1, '加密价条目不丢弃(名/星/评分仍可呈现)', encHotels)
  assert(encHotels[0]!.price === 0 && !encHotels[0]!.priceRaw, '加密价不伪造价格(价以 jumpUrl 落地页为准)', encHotels[0])

  // K2d displayPrice 字符串兜底(无数值 price 时)
  const displayShape = JSON.stringify({ hotelList: [{ hotelInfo: { summary: { hotelId: '888', nameInfo: { names: ['Rove Downtown'] } }, roomInfo: [{ priceInfo: { displayPrice: '¥7xx' } }] } }] })
  const dispHotels = parseCtripHotelList(displayShape)
  assert(dispHotels.length === 1 && dispHotels[0]!.priceRaw === '¥7xx' && dispHotels[0]!.price === 0, 'displayPrice 字符串价原样保留(打码口径)', dispHotels[0])



  const fixture = JSON.stringify({
    data: { hotelList: [
      { hotelId: 442516, hotelName: 'Dubai Marriott', star: 5, commentScore: 4.7, position: { address: 'Sheikh Zayed Rd' }, priceInfo: { avgPrice: 680, total: 1360 } },
      { hotelId: '999', hotelName: 'Rove Downtown', priceInfo: { priceDisplay: '¥7xx' } },
    ] },
  })
  const hotels1 = parseCtripHotelList(fixture)
  assert(hotels1.length === 2, '走形解析命中 hotelList 数组', hotels1)
  assert(hotels1[0]!.name === 'Dubai Marriott' && hotels1[0]!.price === 680 && hotels1[0]!.star === 5 && hotels1[0]!.score === '4.7', '归一化字段(名/价/星/评分)', hotels1[0])
  assert(hotels1[0]!.jumpUrl === 'https://hotels.ctrip.com/hotel/442516', 'jumpUrl 由 hotelId 构造(预订由人完成)', hotels1[0])
  assert(hotels1[1]!.price === 0 && hotels1[1]!.priceRaw === '¥7xx', '打码价原样保留不数值化(不伪装真价)', hotels1[1])
  const hotels2 = parseCtripHotelList(JSON.stringify({ hotelMatchInfos: [{ name: 'Atlantis', price: 2100, score: '4.8', hotelId: '123' }] }))
  assert(hotels2.length === 1 && hotels2[0]!.price === 2100, '扁平形态(顶层 price 数字)同样命中', hotels2)
  assert(parseCtripHotelList('not json{').length === 0 && parseCtripHotelList('{"a":1}').length === 0, 'malformed/无签名 一律返空(不抛错)')

  // K3 形状嗅探签名
  assert(looksLikeHotelListBody('{"data":{"hotelList":[]}}') === true, '签名命中 hotelList')
  assert(looksLikeHotelListBody('{"data":{"userList":[]}}') === false, '无签名不转发(防无关响应误投)')
  assert(looksLikeHotelListBody('x'.repeat(2_000_001)) === false, '超大响应体不嗅探(上限把关)')

  // K4 闸面:日期对闸(不发上游)/城市未收录 error/节律闸 cooldown(全在 transport 之前,零桥零浏览器)
  const dPast = await sessionHotelSearch({ to: '上海', checkIn: '2026-01-01', checkOut: '2026-01-03' })
  assert(dPast.ok === false && dPast.verdict === 'error' && /不是未来合法区间/.test(dPast.error ?? ''), '过去入住日代码层拒绝,不发上游', dPast)
  const dPair = await sessionHotelSearch({ to: '上海', checkIn: '2026-12-01' })
  assert(dPair.ok === false && /成对/.test(dPair.error ?? ''), 'checkIn/checkOut 须成对', dPair)
  __resetRateLimiterForTest()
  const e1 = await sessionHotelSearch({ to: '不在码表的城市' })
  assert(e1.ok === false && e1.verdict === 'error' && /city=/.test(e1.error ?? ''), '未收录城市 → error + cityId 指引', e1)
  const e2 = await sessionHotelSearch({ to: '上海' })
  assert(e2.ok === false && e2.verdict === 'cooldown', '节律闸:同站点 30s 内第二调 → cooldown(不发起导航)', e2)
}


// L. 火车会话面(2026-09-03 实装,12306 公开查询面)纯函数:entry URL/管道行解析/电报码指引/闸面
console.log('L. 火车适配器(buildTrainEntryUrl/parseLeftTicketQuery/电报码指引/节律闸)')
{
  // L1 entry URL:码表 / 显式电报码 / 未收录
  const t1 = buildTrainEntryUrl({ from: '上海', to: '昆明', date: '2026-12-01' })
  assert(t1.ok && t1.url!.includes('fs=%E4%B8%8A%E6%B5%B7%2CSHH') && t1.url!.includes('ts=%E6%98%86%E6%98%8E%2CKMM') && t1.url!.includes('date=2026-12-01'), '城市电报码(fs=城市名,SHH 形态)', t1)
  const t2 = buildTrainEntryUrl({ from: '丽江', to: '大理', date: '2026-12-01', fromStationTelecode: 'EHM', toStationTelecode: 'KDM' })
  assert(t2.ok && t2.url!.includes('%2CEHM') && t2.url!.includes('%2CKDM'), '显式电报码覆盖(码表外城市)', t2)
  const t3 = buildTrainEntryUrl({ from: '敦煌', to: '西双版纳', date: '2026-12-01' })
  assert(!t3.ok && t3.unresolved?.includes('敦煌') === true, '码表外城市 unresolved(官方站表亦无城市组,不猜码)', t3)
  assert(/fromStationTelecode/.test(trainStationUnresolvedHint(['敦煌'])), '未收录指引带电报码发现路径(web 搜 kyfw 查询页 URL)')
  // 电报码表防漂移:逐条锁定官方站表快照(data/stations-12306-verify.json,
  // 2026-09-03 自 kyfw station_name.js 校准;曾纠出南宁 NIZ→NNZ)
  {
    const snap = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'data', 'stations-12306-verify.json'), 'utf-8')) as { cities: Record<string, { telecode: string }> }
    const names = Object.keys(snap.cities)
    assert(names.length >= 129, `快照覆盖 ${names.length} 城`)
    let drift = 0
    for (const [city, v] of Object.entries(snap.cities)) {
      if (STATION_TELECODES[city] !== v.telecode) {
        drift += 1
        console.log(`  FAIL-detail - 电报码漂移: ${city} 表=${STATION_TELECODES[city]} 快照=${v.telecode}`)
      }
    }
    assert(drift === 0, `电报码表 129 城与官方快照零漂移(漂移 ${drift} 处)`)
    assert(Object.keys(STATION_TELECODES).length === names.length, '表与快照城市集合一致(无表外多城)')
  }
  const t4 = buildTrainEntryUrl({ from: '南宁', to: '丽江', date: '2026-12-01' })
  assert(t4.ok && t4.url!.includes('%2CNNZ'), '南宁=NNZ(官方站表校准,曾错 NIZ)且丽江已入表=LHM', t4)
  const exactResponseUrl = 'https://kyfw.12306.cn/otn/leftTicket/queryG?leftTicketDTO.train_date=2026-12-01&leftTicketDTO.from_station=SHH&leftTicketDTO.to_station=KMM'
  const resolvedQuery = resolveTrainQueryTelecodes({ from: '丽江', to: '大理', date: '2026-12-01', fromStationTelecode: 'EHM', toStationTelecode: 'KDM' })
  assert(resolvedQuery.ok && resolvedQuery.telecodes.fromStationTelecode === 'EHM' && resolvedQuery.telecodes.toStationTelecode === 'KDM', '请求电报码解析保留显式覆盖')
  const exactBinding = validateTrainQueryResponseUrl(exactResponseUrl, { fromStationTelecode: 'SHH', toStationTelecode: 'KMM', date: '2026-12-01' })
  assert(exactBinding.ok && exactBinding.binding.url === exactResponseUrl, 'response URL exact host/path/telecodes/date → bound')
  for (const [label, url] of [
    ['wrong host', exactResponseUrl.replace('kyfw.12306.cn', 'evil.example')],
    ['wrong path', exactResponseUrl.replace('/otn/leftTicket/queryG', '/otn/leftTicket/init')],
    ['missing date', exactResponseUrl.replace('leftTicketDTO.train_date=2026-12-01&', '')],
    ['wrong route', exactResponseUrl.replace('from_station=SHH', 'from_station=BJP')],
  ] as const) {
    assert(!validateTrainQueryResponseUrl(url, { fromStationTelecode: 'SHH', toStationTelecode: 'KMM', date: '2026-12-01' }).ok, `${label} response URL → fail closed`)
  }

  // L2 管道行解析(官方 cN 口径:站名走 data.map,座位桶 20-33 第一方校准;
  // 行按官方索引程序化构造,杜绝手数偏移)
  const makeRow = (seats: Record<number, string>, canWebBuy = 'Y', startTrainDate = '20261201'): string => {
    const c: string[] = new Array(56).fill('')
    c[2] = '24000000G1375'; c[3] = 'G1375'; c[4] = 'SHH'; c[5] = 'KMM'; c[6] = 'SHH'; c[7] = 'KMM'
    c[8] = '07:35'; c[9] = '15:27'; c[10] = '07:52'; c[11] = canWebBuy
    c[12] = 'yp'; c[13] = startTrainDate; c[14] = 'x'; c[15] = 'loc'; c[16] = '01'; c[17] = '02'; c[18] = 'Y'; c[19] = '0'
    for (const [k, v] of Object.entries(seats)) c[Number(k)] = v
    return c.join('|')
  }
  const entry = buildTrainEntryUrl({ from: '上海', to: '昆明', date: '2026-12-01' })
  assert(entry.ok, 'entry 构造成功')
  // 官方 cN 索引探针:第 i 位座位桶写入其下标字串,解析结果必须 label→下标逐一相等
  const probeSeats: Record<number, string> = {}
  for (let i = 20; i <= 33; i++) probeSeats[i] = String(i)
  const probeRow = makeRow(probeSeats)
  const probe = parseLeftTicketQuery(JSON.stringify({ data: { result: [probeRow], map: { SHH: '上海南', KMM: '昆明' } } }), entry.url ?? '')
  assert(probe.length === 1, '探针行解析', probe)
  const expectSeats: Array<[string, string]> = [['其他(通勤)', '20'], ['高级软卧', '21'], ['其他', '22'], ['软卧(一等卧)', '23'], ['软座', '24'], ['特等座', '25'], ['无座', '26'], ['yp_b(上游席别)', '27'], ['硬卧(二等卧)', '28'], ['硬座', '29'], ['二等座', '30'], ['一等座', '31'], ['商务座', '32'], ['动卧', '33']]
  for (const [label, idxVal] of expectSeats) {
    assert(probe[0]!.seats[label] === idxVal, `座位桶 ${label} 下标=${idxVal}(官方 cN)`, probe[0]!.seats)
  }
  assert(probe[0]!.fromStation === '上海南' && probe[0]!.toStation === '昆明', '站名= data.map[电报码](官方 cN 口径,非行内索引)', probe[0])
  assert(parseLeftTicketQueryResult(JSON.stringify({ data: { result: [probeRow], map: { SHH: '上海南', KMM: '昆明' } } }), entry.url ?? '').kind === 'recognized-nonempty', 'typed parser:有效非空批次 → recognized-nonempty')

  const trains1 = parseLeftTicketQuery(JSON.stringify({ data: { result: [makeRow({ 25: '有', 26: '有', 28: '有', 29: '有', 30: '有', 31: '有', 32: '有' })], map: { SHH: '上海南', KMM: '昆明' } } }), entry.url ?? '')
  assert(trains1.length === 1, '管道行解析命中', trains1)
  assert(trains1[0]!.trainCode === 'G1375' && trains1[0]!.depTime === '07:35' && trains1[0]!.arrTime === '15:27' && trains1[0]!.durationMin === 472, '车次/时刻/历时归一化', trains1[0])
  assert(trains1[0]!.seats['商务座'] === '有' && trains1[0]!.seats['二等座'] === '有' && trains1[0]!.seats['特等座'] === '有' && trains1[0]!.seats['硬卧(二等卧)'] === '有', '余票分桶(官方索引)', trains1[0]!.seats)
  assert(!('price' in trains1[0]!), '列表接口无票价——不伪装价格(诚实面)')
  const shifted = makeRow({ 25: '有' }).split('|').slice(1).join('|')
  assert(parseLeftTicketQuery(JSON.stringify({ data: { result: [shifted], map: {} } }), entry.url ?? '').length === 0, '索引漂移行(签名失配)整行跳过,fail-visible')
  assert(parseLeftTicketQuery('not json', entry.url ?? '').length === 0 && parseLeftTicketQuery('{"data":{"result":[]}}', entry.url ?? '').length === 0, '兼容数组投影:malformed/空 一律返空(不抛错)')
  const malformedLimitedFields: Array<[string, string, Record<string, unknown>]> = [
    ['invalid departure minute', makeRow({ 30: '有' }).replace('07:35', '07:99'), { SHH: '上海', KMM: '昆明' }],
    ['invalid arrival minute', makeRow({ 30: '有' }).replace('15:27', '15:99'), { SHH: '上海', KMM: '昆明' }],
    ['invalid calendar start train date', makeRow({ 30: '有' }, 'Y', '20261399'), { SHH: '上海', KMM: '昆明' }],
    ['non-string station map value', makeRow({ 30: '有' }), { SHH: 123, KMM: '昆明' }],
  ]
  for (const [label, row, map] of malformedLimitedFields) {
    const outcome = parseLeftTicketQueryResult(JSON.stringify({ data: { result: [row], map } }), entry.url ?? '')
    assert(outcome.kind === 'malformed', `${label} → malformed typed outcome`, outcome)
  }

  // L2b. #355 typed outcome + train fact counterexamples.  The converter
  // consumes invocation binding only; no caller timestamp/query metadata.
  const requested = { from: '上海', to: '昆明', date: '2026-12-01' }
  const now = new Date('2026-09-10T12:00:00.000Z')
  const binding = {
    requested,
    request: { fromStationTelecode: 'SHH', toStationTelecode: 'KMM', date: requested.date },
    response: {
      url: 'https://kyfw.12306.cn/otn/leftTicket/queryG?leftTicketDTO.train_date=2026-12-01&leftTicketDTO.from_station=SHH&leftTicketDTO.to_station=KMM',
      fromStationTelecode: 'SHH', toStationTelecode: 'KMM', date: requested.date,
    },
    batchId: 'fixture-hit-batch', queryId: 'session:12306-train:fixture-hit-batch', fetchedAt: '2026-09-10T11:59:00.000Z',
  }
  for (const [label, row, map] of malformedLimitedFields) {
    const outcome = parseLeftTicketQueryResult(JSON.stringify({ data: { result: [row], map } }), entry.url ?? '')
    assert(outcome.kind === 'malformed' && factsFromSessionTrain(requested, { outcome, collection: binding }, now).length === 0, `${label} → malformed + zero facts`, outcome)
  }
  const available = parseLeftTicketQueryResult(JSON.stringify({ data: { result: [makeRow({ 30: '有' })], map: { SHH: '上海', KMM: '昆明' } } }), entry.url ?? '')
  assert(available.kind === 'recognized-nonempty' && available.trains.length === 1 && hasRecognizedAvailableSeat(available.trains[0]!), 'counterexample:valid available row → recognized row + closed-set seat')
  const hitFacts = factsFromSessionTrain(requested, { outcome: available, collection: binding }, now)
  assert(hitFacts.length === 1 && hitFacts[0]!.kind === 'train' && hitFacts[0]!.bookability === 'bookable_exact_date' && !('price' in hitFacts[0]!), 'valid available row → one bookable train fact, price absent')
  assert(factsFromSessionTrain(requested, { outcome: available, collection: { ...binding, response: undefined } as never }, now).length === 0, 'hit-shaped outcome without captured response URL → zero facts')
  assert(factsFromSessionTrain(requested, { outcome: available, collection: { ...binding, response: { ...binding.response, url: binding.response.url.replace('SHH', 'SHA') } } }, now).length === 0, 'hit-shaped outcome with mismatched response URL → zero facts')
  const empty = parseLeftTicketQueryResult('{"data":{"result":[]}}', entry.url ?? '')
  assert(empty.kind === 'recognized-empty', 'counterexample:explicit data.result=[] → recognized-empty')
  assert(factsFromSessionTrain(requested, { outcome: empty, collection: { ...binding, batchId: 'fixture-empty-batch', queryId: 'session:12306-train:fixture-empty-batch' } }, now).length === 1, 'genuine empty alone → one negative fact')
  assert(factsFromSessionTrain(requested, { outcome: empty, collection: { ...binding, response: { ...binding.response, url: binding.response.url.replace('2026-12-01', '2026-12-02') } } }, now).length === 0, 'recognized-empty with mismatched response date → zero facts')
  const malformedBodies: Array<[string, string]> = [
    ['malformed JSON', 'not json'],
    ['malformed root', '123'],
    ['malformed result', '{"data":{"result":{}}}'],
  ]
  for (const [label, body] of malformedBodies) {
    const outcome = parseLeftTicketQueryResult(body, entry.url ?? '')
    assert(outcome.kind === 'malformed' && factsFromSessionTrain(requested, { outcome, collection: binding }, now).length === 0, `${label} → typed malformed + zero facts`, outcome)
  }
  const badRow = makeRow({ 30: '有' }).split('|').slice(1).join('|')
  const shortRow = makeRow({ 30: '有' }).split('|').slice(0, 20).join('|')
  const mixedOutcome = parseLeftTicketQueryResult(JSON.stringify({ data: { result: [makeRow({ 30: '有' }), badRow], map: { SHH: '上海', KMM: '昆明' } } }), entry.url ?? '')
  assert(mixedOutcome.kind === 'malformed' && factsFromSessionTrain(requested, { outcome: mixedOutcome, collection: binding }, now).length === 0, 'mixed valid/malformed batch → fail closed, zero candidates')
  for (const [label, row] of [['nonobject row', null], ['short row', shortRow]] as const) {
    const body = JSON.stringify({ data: { result: [row], map: { SHH: '上海', KMM: '昆明' } } })
    const outcome = parseLeftTicketQueryResult(body, entry.url ?? '')
    assert(outcome.kind === 'malformed' && factsFromSessionTrain(requested, { outcome, collection: binding }, now).length === 0, `${label} → malformed + zero facts`)
  }
  const transport = { outcome: { kind: 'transport-runtime-error' as const, reason: 'fixture transport error' }, collection: undefined }
  assert(factsFromSessionTrain(requested, transport, now).length === 0, 'transport/runtime error → zero facts')
  const yNoSeat = parseLeftTicketQueryResult(JSON.stringify({ data: { result: [makeRow({ 30: '0', 31: '无', 32: '--' })], map: { SHH: '上海', KMM: '昆明' } } }), entry.url ?? '')
  assert(yNoSeat.kind === 'recognized-nonempty' && factsFromSessionTrain(requested, { outcome: yNoSeat, collection: binding }, now).length === 0, 'canWebBuy=Y but no available seat → zero positive/negative facts')
  const incoherentBuy = parseLeftTicketQueryResult(JSON.stringify({ data: { result: [makeRow({ 30: '有' }, 'N')], map: { SHH: '上海', KMM: '昆明' } } }), entry.url ?? '')
  assert(incoherentBuy.kind === 'recognized-nonempty' && factsFromSessionTrain(requested, { outcome: incoherentBuy, collection: binding }, now).length === 0, 'seat available but incoherent buy flag → zero facts')
  assert(factsFromSessionTrain(requested, { outcome: available, collection: { ...binding, requested: { ...requested, from: '南京' } } }, now).length === 0, 'route mismatch binding → zero facts')
  assert(factsFromSessionTrain(requested, { outcome: available, collection: { ...binding, requested: { ...requested, date: '2026-12-02' } } }, now).length === 0, 'date mismatch binding → zero facts')
  assert(factsFromSessionTrain(requested, { outcome: available, collection: { ...binding, queryId: 'session:12306-train:other-batch' } }, now).length === 0, 'mismatched caller query identity → zero facts')
  const priorOriginDate = parseLeftTicketQueryResult(JSON.stringify({ data: { result: [makeRow({ 30: '有' }, 'Y', '20261130')], map: { SHH: '上海', KMM: '昆明' } } }), entry.url ?? '')
  assert(priorOriginDate.kind === 'recognized-nonempty' && priorOriginDate.trains[0]!.startTrainDate === '2026-11-30'
    && factsFromSessionTrain(requested, { outcome: priorOriginDate, collection: binding }, now).length === 1, 'startTrainDate 前一日且 passenger query date 命中 → 保留并产出事实')
  const staleBinding = { ...binding, fetchedAt: new Date(now.getTime() - TRAIN_FACT_MAX_AGE_MS - 1).toISOString() }
  const futureBinding = { ...binding, fetchedAt: new Date(now.getTime() + 1).toISOString() }
  assert(factsFromSessionTrain(requested, { outcome: available, collection: staleBinding }, now).length === 0 && factsFromSessionTrain(requested, { outcome: available, collection: futureBinding }, now).length === 0, `stale/future fetchedAt → zero facts (${TRAIN_FACT_FRESHNESS_RULE})`)

  // L2c. Actual CDP collector seam:body and the URL come from the same response.
  const savedTrainTransport = process.env.GOTRY_SESSION_TRANSPORT
  const cdpResponse = (body: string, url: string) => async () => {
    let onResponse: ((response: { url: () => string; text: () => Promise<string> }) => Promise<void> | void) | undefined
    const page = {
      on: (event: string, handler: typeof onResponse) => { if (event === 'response') onResponse = handler },
      goto: async () => { await onResponse?.({ url: () => url, text: async () => body }) },
      title: async () => '',
      content: async () => '',
    }
    return {
      ok: true as const,
      browser: {} as never,
      page: page as never,
      guard: { blockedCount: () => 0, requestCount: () => 1 },
      close: async () => {},
    }
  }
  try {
    process.env.GOTRY_SESSION_TRANSPORT = 'cdp'
    __resetRateLimiterForTest()
    __setTrainSessionTransportForTest(cdpResponse(
      JSON.stringify({ data: { result: [makeRow({ 30: '有' }, 'Y', '20261130')], map: { SHH: '上海', KMM: '昆明' } } }),
      'https://kyfw.12306.cn/otn/leftTicket/queryG?leftTicketDTO.train_date=2026-12-01&leftTicketDTO.from_station=SHH&leftTicketDTO.to_station=KMM',
    ))
    const cdpControl = await sessionTrainSearch({ from: '上海', to: '昆明', date: '2026-12-01', timeoutMs: 10 })
    const cdpNow = new Date()
    assert(cdpControl.collection?.response.url.includes('from_station=SHH') === true
      && factsFromSessionTrain(requested, cdpControl, cdpNow).length === 1, 'CDP collector exact response URL + previous origin date → one fact')

    __resetRateLimiterForTest()
    __setTrainSessionTransportForTest(cdpResponse(
      JSON.stringify({ data: { result: [makeRow({ 30: '有' })], map: { SHH: '上海', KMM: '昆明' } } }),
      'https://kyfw.12306.cn/otn/leftTicket/queryG?leftTicketDTO.train_date=2026-12-03&leftTicketDTO.from_station=SHH&leftTicketDTO.to_station=KMM',
    ))
    const cdpWrongRoute = await sessionTrainSearch({ from: '北京', to: '上海', date: '2026-12-03', timeoutMs: 10 })
    assert(cdpWrongRoute.collection === undefined && factsFromSessionTrain({ from: '北京', to: '上海', date: '2026-12-03' }, cdpWrongRoute, now).length === 0, 'CDP wrong-route response URL → no collection/facts')

    __resetRateLimiterForTest()
    __setTrainSessionTransportForTest(cdpResponse(
      '{"data":{"result":[]}}',
      'https://kyfw.12306.cn/otn/leftTicket/queryG?leftTicketDTO.train_date=2026-12-01&leftTicketDTO.from_station=SHH&leftTicketDTO.to_station=KMM',
    ))
    const cdpWrongDateEmpty = await sessionTrainSearch({ from: '上海', to: '昆明', date: '2026-12-02', timeoutMs: 10 })
    assert(cdpWrongDateEmpty.outcome.kind === 'recognized-empty' && cdpWrongDateEmpty.collection === undefined
      && factsFromSessionTrain({ from: '上海', to: '昆明', date: '2026-12-02' }, cdpWrongDateEmpty, now).length === 0, 'CDP wrong-date recognized-empty → no negative fact')
  } finally {
    __setTrainSessionTransportForTest(null)
    if (savedTrainTransport === undefined) delete process.env.GOTRY_SESSION_TRANSPORT
    else process.env.GOTRY_SESSION_TRANSPORT = savedTrainTransport
  }

  // L3 闸面:过去日期在工具层拦截(cooldown 链路前)
  __resetRateLimiterForTest()
  const e1 = await sessionTrainSearch({ from: '不在码表', to: '也不在', date: '2026-12-01' })
  assert(e1.ok === false && e1.verdict === 'error' && /fromStationTelecode/.test(e1.error ?? ''), '未收录电报码 → error + 发现路径指引', e1)
  const e2 = await sessionTrainSearch({ from: '上海', to: '昆明', date: '2026-12-01' })
  assert(e2.ok === false && e2.verdict === 'cooldown', '节律闸:同站点 30s 内第二调 → cooldown(不发起导航)', e2)
}


// ---------------------------------------------------------------------------
// M. Dida 供应商门户会话面(2026-09-09 实装;entry 守域/信封走形/形状签名/闸面;
//    纯函数 + transport 前短路,离线确定性——扩展桥不在测试里拉起)
// ---------------------------------------------------------------------------
console.log('M. Dida 门户(entry 守域 + 信封走形 + 闸面)')
{
  // M1 entry:默认 find 页;覆盖 URL 必须落在 portal.dida.com 域内
  const d1 = buildDidaEntryUrl()
  assert(d1.ok && d1.url === 'https://portal.dida.com/hotel/find', 'entry 默认=find 页', d1)
  const d2 = buildDidaEntryUrl({ entryUrl: 'https://portal.dida.com/hotel/find?city=Bangkok' })
  assert(d2.ok && d2.url === 'https://portal.dida.com/hotel/find?city=Bangkok', 'entry 覆盖(域内)放行', d2)
  const d3 = buildDidaEntryUrl({ entryUrl: 'https://evil.example.com/hotel/find' })
  assert(!d3.ok, 'entry 覆盖(域外)拒绝——fail-closed', d3)
  const d4 = buildDidaEntryUrl({ entryUrl: 'http://portal.dida.com/hotel/find' })
  assert(!d4.ok, 'entry 覆盖(http 明文)拒绝', d4)

  // M2 走形:SearchRealTime 信封(hotel-be models.go 口径)→ 展平报价
  const envelope = JSON.stringify({
    Message: 'ok', Success: true, MessageCode: 20000,
    Data: {
      ReferenceNo: 'REF-ROOT',
      HotelPriceList: [
        {
          Hotel: { HotelID: 24110, Name: 'Atlantis The Palm' },
          RoomTypeList: [
            { DidaRoomTypeID: 701, DidaRoomTypeName_CN: '海景大床房', DidaRoomTypeName_EN: 'Sea View King', RatePlanList: [
              { RatePlanID: 'RP-1', Price: 1580.5, TotalPrice: 4741.5, Currency: 'CNY', MealType: 'Breakfast', BreakfastType: 'ABF', BedType: 'King', PaymentType: 'Prepay', Inventory: 3, RoomCount: 5, ReferenceNo: 'REF-A' },
              { RatePlanID: 'RP-2', Price: 1710, TotalPrice: 5130, Currency: 'CNY', PaymentType: 'PayAtHotel', Inventory: 0, ReferenceNo: 'REF-B' },
            ] },
          ],
          RoomList: [
            { DidaRoomTypeID: 702, DidaRoomTypeName_EN: 'Suite', RatePlanList: [
              { RatePlanID: 'RP-3', Price: 3200, TotalPrice: 9600, Currency: 'USD', ReferenceNo: 'REF-C' },
            ] },
          ],
        },
        { Hotel: { HotelID: 24111, Name: 'Burj Al Arab' }, RoomTypeList: [] },
      ],
    },
  })
  const rates = parseDidaRates(envelope)
  assert(rates.length === 3, '信封走形:RoomTypeList+RoomList 逐计划展平', rates)
  assert(rates[0]!.hotelId === '24110' && rates[0]!.hotelName === 'Atlantis The Palm' && rates[0]!.roomName === '海景大床房', '酒店/房型字段映射(中文名优先)', rates[0])
  assert(rates[0]!.price === 1580.5 && rates[0]!.totalPrice === 4741.5 && rates[0]!.currency === 'CNY', '价/总价/币种', rates[0])
  assert(rates[0]!.inventory === 3 && rates[0]!.referenceNo === 'REF-A' && rates[0]!.paymentType === 'Prepay', '库存/引用号/支付类型', rates[0])
  assert(rates[1]!.ratePlanId === 'RP-2' && rates[1]!.inventory === 0, 'inventory=0 如实保留(不伪装可订)', rates[1])
  assert(rates[2]!.roomName === 'Suite' && rates[2]!.currency === 'USD', 'RoomList 同构展平', rates[2])
  assert(parseDidaRates('not json').length === 0 && parseDidaRates('{"a":1}').length === 0 && parseDidaRates('[]').length === 0, 'malformed/无信封/裸空数组 一律返空(不抛错)')
  assert(parseDidaRates(envelope, { maxItems: 2 }).length === 2, 'maxItems 截断')

  // M3 形状签名(与 content-main DIDA_BODY_SIG_RE 逐字对账)
  assert(looksLikeDidaRatesBody('"HotelPriceList":[]'), '签名命中 HotelPriceList')
  assert(looksLikeDidaRatesBody('"RatePlanList":[]'), '签名命中 RatePlanList')
  assert(!looksLikeDidaRatesBody(''), '空体不命中')
  assert(!looksLikeDidaRatesBody('x'.repeat(2_000_001)), '超上限不命中')

  // M4 闸面(transport 前短路):entry 域外 → error;同站点二调 → cooldown
  __resetRateLimiterForTest()
  const q1 = await sessionDidaSearch({ entryUrl: 'https://evil.example.com/x' })
  assert(q1.ok === false && q1.verdict === 'error', 'entry 域外 → error(不发起导航)', q1)
  const q2 = await sessionDidaSearch({})
  assert(q2.ok === false && q2.verdict === 'cooldown', '节律闸:30s 内二调 → cooldown', q2)
  assert(typeof didaLoginHint() === 'string' && /自动登录/.test(didaLoginHint()), '登录指引指向 hotel-be portal 跳板(账密永不经 gotry)')
}

if (process.env.GOTRY_SESSION_TEST_FORCE_FAILURE === '1') {
  assert(false, 'forced session failure propagation proof')
}
console.log(`\nSESSION P1: ${pass} pass, ${fail} fail`)
if (fail > 0) process.exitCode = 1
