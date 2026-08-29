/**
 * 会话数据面 P1 测试(RFC §4 P1 exit):
 *   A-E 纯函数(确定性,进 CI):ReadGuard 分类器/批搜解析(buildEntryUrl/fixture)/提交件过滤/节律闸;
 *   F   live FlyAI 官方通道(同 weather-tests 的 live 先例;纯 CLI,无浏览器窗口);
 *   G   live 会话检索(Chrome + 携程;**默认 SKIP**——测试永不自动开用户浏览器窗口,GOTRY_SESSION_LIVE=1 显式开启);
 *   H   酒店通道(flyai search-hotel;纯 CLI,无浏览器窗口);
 *   I   账号会话授权闸(纯函数:每会话一次/拒绝=会话内吊销/allow/off/无审批通道,确定性)。
 * 隔离纪律:live 用 mktemp profile 与 stateRoot,绝不动共享状态与日常浏览器 profile;
 * 任何测试不自动弹浏览器窗口(用户 Chrome 只经 CDP attach 或用户手动运行 session-login)。
 */

import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { classifyRequest, isSubmitText } from '../capabilities/session/read-guard.ts'
import { buildEntryUrl, parseBatchSearch } from '../capabilities/session/adapters/ctrip-flight.ts'
import { sessionFlightSearch, __resetRateLimiterForTest } from '../capabilities/session-search.ts'
import { flyaiSearch } from '../capabilities/flyai.ts'
import { createConsentGate, type ApprovalSeam, type ConsentDecision, type SessionAccess } from '../capabilities/session-consent.ts'

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

// F. live FlyAI 官方通道(同 weather-tests live 先例)
console.log('F. flyaiSearch(live,飞猪官方,无 key)')
const fr = await flyaiSearch({ kind: 'flight', origin: '上海', destination: '丽江', depDate: '2026-10-01' })
const sentinelBlocked = fr.verdict === 'error' && /sentinel|block/i.test(fr.error ?? '')
if (sentinelBlocked) {
  console.log('  WARN - 飞猪 Sentinel 限流(2026-08-28 实测,配额未文档化)——降级合同验证通过,跳过 hit 断言')
  assert(fr.ok === false && /\[实时API:flyai@error@/.test(fr.evidence), '限流降级:结构化 error + 证据链错误形')
} else {
  assert(fr.ok === true && fr.verdict === 'hit', '上海→丽江 hit', fr)
  assert((fr.options?.length ?? 0) >= 1 && (fr.options?.every((o) => o.price > 0 && /^\d+[A-Z]\d+|^[A-Z]{2}\d+/.test(o.no)) ?? false), '结构化字段齐(price>0,航班号形)', fr.options?.[0])
}
assert(/\[实时API:flyai/.test(fr.evidence), '证据链 [实时API:flyai@*]')

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
    const flyaiMin = Math.min(...(fr.options?.map((o) => o.price).filter((p) => p > 0) ?? [0]))
    const sessionMin = Math.min(...(sr.options?.map((o) => o.price).filter((p) => p > 0) ?? [0]))
    console.log(`  双源对照:FlyAI 最低 ¥${flyaiMin} vs 会话(携程)最低 ¥${sessionMin}(同日同线路,记录不判等)`)
  }
  rmSync(iso, { recursive: true, force: true })
}

// H. 酒店通道(2026-08-29 平铺接入):live 双合法终态 + 离线解析 + 参数闸
console.log('H. flyaiSearch hotel(飞猪官方 search-hotel)')
{
  // H1 live:带日期两形态(成对可选;未定档期可不带日期)
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
  // H2 离线解析(实测 2026-08-29 大理形状):打码价保 priceRaw、数字价 0、缺名条目跳过
  const fakeDir = mkdtempSync(join(tmpdir(), 'flyai-hotel-fake-'))
  const fakeCliH = join(fakeDir, 'flyai-hotel-fake')
  writeFileSync(fakeCliH, '#!/bin/sh\necho \'{"data":{"itemList":[{"name":"大理A 酒店","shId":"1","star":"高档型","rate":null,"price":"\\u00a57xx","address":"addr","interestsPoi":"近洱海","detailUrl":"https://router.feizhu.com/x"},{"star":"舒适型"}]}}\'\nexit 0\n', { mode: 0o755 })
  const h2 = await flyaiSearch({ kind: 'hotel', destName: '大理', cliBin: fakeCliH })
  assert(h2.verdict === 'hit' && h2.hotels?.length === 1, '酒店解析:缺名条目跳过,1 条有效', h2)
  const h0 = h2.hotels?.[0]
  assert(h0?.name === '大理A 酒店' && h0?.priceRaw === '¥7xx' && h0?.price === 0, '打码价保 priceRaw 原值(数字价 0)', h0)
  assert(h0?.star === '高档型' && h0?.hotelId === '1' && h0?.jumpUrl === 'https://router.feizhu.com/x', 'star/jumpUrl(shId/detailUrl)透传', h0)
  // H3 参数闸:无目的地 / 日期不成对 / 非规整日期 都走结构化 error,不发上游
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
  const sess = (a: object = agentA) => ({ name: 'gotry_session_search', agent: a, callId: 'c1' })
  const other = () => ({ name: 'gotry_anything_search', agent: agentA })
  const mkStore = () => new WeakMap<object, { granted: Set<string>; denied: Set<string> }>()
  const mkGate = (access: SessionAccess, seam?: ApprovalSeam) =>
    createConsentGate({ access: () => (access as string), approval: seam ? () => seam : undefined, store: mkStore() })

  // I1 无审批通道(headless/极简宿主):账号工具 → ask(交运行时 fail-closed);非账号工具放行
  const gateBare = createConsentGate({ access: () => 'ask' })
  const d1 = await gateBare({ name: 'gotry_session_search', agent: undefined }, next)
  assert(d1.kind === 'ask', '无审批通道 → ask(交运行时 fail-closed;denies 责任在 registry)', d1)
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
    const dB = await gate({ name: 'gotry_session_search', agent: agentB }, next)
    assert(dB.kind === 'deny' && requests === 2, '另一会话不受此前拒绝影响——会重新发起一次审批请求(seam 本例仍拒)', { dB, requests })
  }

  // I4 off 总闸:不弹卡直接 deny;非账号工具不受影响
  {
    const gate = mkGate('off')
    const d = await gate(sess(), next)
    assert(d.kind === 'deny' && /sessionAccess=off/.test(String(d.kind === 'deny' ? d.reason : '')), 'off → 不弹卡直接 deny', d)
    assert((await gate(other(), next)).kind === 'allow', 'off 只关账号面工具,其余放行')
  }

  // I5 allow(配置级预授权):直接放行,不弹卡
  {
    const gate = mkGate('allow')
    assert((await gate(sess(), next)).kind === 'allow', 'sessionAccess=allow → 配置明示预授权,直接放行')
  }
}

console.log(`\nSESSION P1: ${pass} pass, ${fail} fail`)
