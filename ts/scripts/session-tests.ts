/**
 * 会话数据面 P1 测试(RFC §4 P1 exit):
 *   A-E 纯函数(确定性,进 CI):ReadGuard 分类器/批搜解析(buildEntryUrl/fixture)/提交件过滤/节律闸;
 *   F   live FlyAI 官方通道(同 weather-tests 的 live 先例;纯 CLI,无浏览器窗口);
 *   G   live 会话检索(Chrome + 携程;**默认 SKIP**——测试永不自动开用户浏览器窗口,GOTRY_SESSION_LIVE=1 显式开启);
 *   H   酒店通道(flyai search-hotel;纯 CLI,无浏览器窗口);
 *   I   账号会话授权闸(纯函数:每会话一次/拒绝=会话内吊销/allow/off/无审批通道,确定性);
 *   J   登录引导(无凭证语义/表格完备/票据名级检查;live opt-in 同 G)。
 * #21 字段 scorer/双源 gate 的无网络验收独立放在 scripts/session-benchmark.ts。
 * 隔离纪律:live 用 mktemp profile 与 stateRoot,绝不动共享状态与日常浏览器 profile;
 * 任何测试不自动弹浏览器窗口(用户 Chrome 只经 CDP attach 或用户手动运行 session-login)。
 */

import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { classifyRequest, isSubmitText } from '../capabilities/session/read-guard.ts'
import { buildEntryUrl, parseBatchSearch } from '../capabilities/session/adapters/ctrip-flight.ts'
import { sessionFlightSearch, __resetRateLimiterForTest, classifyTransportFailure } from '../capabilities/session-search.ts'
import { flyaiSearch } from '../capabilities/flyai.ts'
import { createConsentGate, type ApprovalSeam, type ConsentDecision, type SessionAccess } from '../capabilities/session-consent.ts'
import { sessionLogin, pollTicketNames, LOGIN_TARGETS } from '../capabilities/session-login.ts'

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

if (process.env.GOTRY_SESSION_TEST_FORCE_FAILURE === '1') {
  assert(false, 'forced session failure propagation proof')
}
console.log(`\nSESSION P1: ${pass} pass, ${fail} fail`)
if (fail > 0) process.exitCode = 1
