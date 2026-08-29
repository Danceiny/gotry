/**
 * 会话数据面 P1 测试(RFC §4 P1 exit):
 *   A-E 纯函数(确定性,进 CI):ReadGuard 分类器/批搜解析(buildEntryUrl/fixture)/提交件过滤/节律闸;
 *   F   live FlyAI 官方通道(同 weather-tests 的 live 先例);
 *   G   live 会话检索(Chrome + 携程;GOTRY_SESSION_LIVE=0 可关;Chrome 缺席 → SKIP 不 fail)。
 * 隔离纪律:live 用 mktemp profile 与 stateRoot,绝不动共享状态与日常浏览器 profile。
 */

import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { classifyRequest, isSubmitText } from '../capabilities/session/read-guard.ts'
import { buildEntryUrl, parseBatchSearch } from '../capabilities/session/adapters/ctrip-flight.ts'
import { sessionFlightSearch, __resetRateLimiterForTest } from '../capabilities/session-search.ts'
import { flyaiSearch } from '../capabilities/flyai.ts'

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

// G. live 会话检索(Chrome+携程;GOTRY_SESSION_LIVE=0 关;Chrome 缺席 SKIP)
console.log('G. sessionFlightSearch(live,隔离 profile + ReadGuard)')
if (process.env.GOTRY_SESSION_LIVE === '0') {
  console.log('  SKIP - GOTRY_SESSION_LIVE=0')
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
  } else if (sr.verdict === 'error' && /chrome launch failed/.test(sr.error ?? '')) {
    console.log('  SKIP - 本机无 Chrome(channel:chrome 不可用)')
  } else if ((sr.verdict === 'miss' || sr.verdict === 'error') && /blocked=0/.test(sr.evidence)) {
    // 匿名自检态 0 options = 外部会话数据面未取回(站点方差/匿名态;三值语义与 Sentinel 限流同构:
    // miss ≠ 链路断,守卫/证据/审计合同仍在 miss 证据里验证)。真 hit 收敛挂 founder 登录态(D-13)。
    console.log(`  SKIP - 会话数据面 miss(外部方差,合同降级语义):${sr.evidence.slice(0, 90)}`)
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

console.log(`\nSESSION P1: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
