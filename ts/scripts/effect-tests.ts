/**
 * 效应解译器测试(effect_interpreter.v1,issue #16 采纳,ADR-18;纯离线零网络):
 *  1. 注册表封闭性:未登记效应 → 结构化拒绝面(不抛错,declined=unknown-effect)
 *  2. 指数退避 withRetry:500→1000→2000 封顶链;累计记账;非瞬时失败不重试
 *  3. 断路器三态:closed→(连续失败达阈)→open→(冷却)→half-open 单探测→成功回 closed/失败再开
 *  4. 生产解译器×瞬时失败:重试后成功(trace.attempts/backoff 记账,evidence 行)
 *  5. FlyAI×Sentinel:上游说不永不重试(attempts=1);连续失败计入熔断,熔断后零执行成本
 *  6. 断路拒绝面:不执行、不抛错、平铺失败观察;冷却后 half-open 单探测成功 → closed
 *  7. mock 解译器:夹具回放确定性;未登记夹具=结构化拒绝
 *  8. SESSION 通道策略:永不重试、不熔断(风控红线),verdict 原样透传
 *  9. 真实 handler 离线冒烟:hbcli 不可达 → 静态包降级(永不抛错,证据链非空)
 * 11. HBCLI×timeout(2026-09-02 迪拜 session:冷启动建后端 session 超 30s):
 *     timeout 类失败重试 1 次即恢复;ENOENT/退码类仍永不重试(切换不是重试)
 *
 * 运行: cd ts && npx tsx scripts/effect-tests.ts
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backoffDelayMs, CircuitBreaker, withRetry } from '../capabilities/resilience.ts'
import {
  declinedObservation,
  makeMockInterpreter,
  makeProductionInterpreter,
  __resetEffectBreakersForTest,
  type GotryEffect,
} from '../capabilities/effect.ts'

const sleep0 = async () => {} // 回退即时放行(确定性,不真睡)
let clock = 1_000_000
const now = () => clock

// ---------------------------------------------------------------------------
// 1. 注册表封闭性:未登记效应 → 结构化拒绝(不抛错)
// ---------------------------------------------------------------------------
const interp = makeProductionInterpreter({ sleep: sleep0, now })
const badItp = await interp({ effect: 'CTRIP_DIRECT_QUERY', params: {} } satisfies GotryEffect)
assert.equal(badItp.result, null, '未登记效应 result=null')
assert.equal(badItp.trace.declined, 'unknown-effect')
assert.equal(badItp.trace.attempts, 0, '未登记效应零执行')
const badObs = declinedObservation('CTRIP_DIRECT_QUERY', badItp.trace)
assert.equal(badObs.ok, false)
assert.match(badObs.summary, /未登记效应/, '拒绝面人话 summary')
assert.match(badObs.evidence, /\[效应:CTRIP_DIRECT_QUERY@/, '拒绝面带证据链')
console.log('1. 注册表封闭性:未登记效应 → 结构化拒绝面(不抛错)OK')

// ---------------------------------------------------------------------------
// 2. 指数退避:500→1000→2000 封顶;累计记账;非瞬时失败不重试
// ---------------------------------------------------------------------------
assert.equal(backoffDelayMs({ baseDelayMs: 500, maxDelayMs: 8000 }, 1), 500)
assert.equal(backoffDelayMs({ baseDelayMs: 500, maxDelayMs: 8000 }, 2), 1000)
assert.equal(backoffDelayMs({ baseDelayMs: 500, maxDelayMs: 8000 }, 4), 4000)
assert.equal(backoffDelayMs({ baseDelayMs: 500, maxDelayMs: 2000 }, 6), 2000, '封顶')

const retried: number[] = []
const rt = await withRetry(
  async () => ({ ok: false }),
  { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 2000, isRetryable: () => true, sleep: sleep0 },
  (_failN, delayMs) => retried.push(delayMs),
)
assert.deepEqual(retried, [500, 1000, 2000], '退避序列 500/1000/2000')
assert.equal(rt.attempts, 4, '重试到上限')
assert.equal(rt.backoffMs, 3500, '累计回退记账')

const noRetry = await withRetry(
  async () => ({ ok: false, verdict: 'error', error: '{"message":"SentinelBlockException"}' }),
  { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 2000, isRetryable: () => false, sleep: sleep0 },
)
assert.equal(noRetry.attempts, 1, '瞬时判定说不重试就 1 次')
console.log('2. 指数退避(封顶链/累计记账/非瞬时止步)OK')

// ---------------------------------------------------------------------------
// 3. 断路器三态(时钟注入确定性)
// ---------------------------------------------------------------------------
const br = new CircuitBreaker({ failureThreshold: 2, openMs: 60_000, now })
assert.equal(br.canAttempt().state, 'closed')
br.onFailure(); br.onFailure()
assert.equal(br.state(), 'open', '连续 2 失败 → open')
assert.equal(br.canAttempt().allowed, false, 'open 中拒绝')
clock += 61_000
assert.equal(br.state(), 'half-open', '冷却满 → half-open')
const gate = br.canAttempt()
assert.equal(gate.allowed, true, 'half-open 放行单探测')
assert.equal(br.canAttempt().allowed, false, '探测在途拒并发')
br.onSuccess()
assert.equal(br.state(), 'closed', '探测成功 → closed')
br.onFailure(); br.onFailure()
clock += 61_000
assert.equal(br.state(), 'half-open')
assert.equal(br.canAttempt().allowed, true)
br.onFailure()
assert.equal(br.state(), 'open', '探测失败 → 重新 open(冷却重启)')
console.log('3. 断路器三态(closed→open→half-open 单探测→双向收敛)OK')

// ---------------------------------------------------------------------------
// 4. 生产解译器×瞬时失败:重试后成功,trace 记账(WEATHER 免费源策略 2 次上限)
// ---------------------------------------------------------------------------
let flaky = 0
const ip = makeProductionInterpreter({
  sleep: sleep0,
  breakers: new Map(),
  handlers: {
    WEATHER_FORECAST: async () => {
      flaky += 1
      return flaky < 2
        ? { ok: false, via: 'open-meteo-error', evidence: '[实时API:open-meteo@error]', latencyMs: 1, error: 'socket hang up' }
        : { ok: true, via: 'open-meteo', evidence: '[实时API:open-meteo@ts]', latencyMs: 2, daily: [] }
    },
  },
})
const itp4 = await ip({ effect: 'WEATHER_FORECAST', params: { latitude: 25.6, longitude: 100.2 } })
assert.equal(itp4.trace.attempts, 2, '瞬时失败重试第 2 次成功(免费源上限 2)')
assert.equal(itp4.trace.backoffMs, 400, '回退按 API 策略记账')
assert.ok((itp4.result as { ok?: boolean }).ok, '成功 observation 原样透传')
assert.match(itp4.trace.evidence[0] ?? '', /attempts=2 backoff=400ms breaker=closed/, 'trace 证据行')
console.log('4. 生产解译器×瞬时失败:重试后成功 + trace 记账 OK')

// ---------------------------------------------------------------------------
// 5. FlyAI×Sentinel:不重试,但连续失败计入熔断
// ---------------------------------------------------------------------------
const sentinelResult = {
  ok: false, via: 'flyai-error', verdict: 'error', kind: 'flight', latencyMs: 5,
  evidence: '[实时API:flyai@error@ts] parse failed(SentinelBlockException)',
  error: 'failed to parse flyai output as JSON (incomplete FlyAI JSON object): {"message":"SentinelBlockException"}',
}
let sentinelCalls = 0
const flyaiBreakers = new Map()
const ipS = makeProductionInterpreter({
  sleep: sleep0,
  breakers: flyaiBreakers,
  now,
  handlers: { FLYAI_SEARCH: async () => { sentinelCalls += 1; return structuredClone(sentinelResult) } },
})
const q = { kind: 'flight' as const, origin: '上海', destination: '丽江', depDate: '2026-10-01' }
await ipS({ effect: 'FLYAI_SEARCH', params: q })
await ipS({ effect: 'FLYAI_SEARCH', params: q })
assert.equal(sentinelCalls, 2, '每次调用只打一次上游(Sentinel 不重试)')
const itp3 = await ipS({ effect: 'FLYAI_SEARCH', params: q })
assert.equal(itp3.trace.attempts, 1)
assert.equal(itp3.trace.breaker, 'open', '连续 3 次失败(FlyAI 阈值 3)→ 断路器开启')
assert.equal(sentinelCalls, 3)
const itp4th = await ipS({ effect: 'FLYAI_SEARCH', params: q })
assert.equal(itp4th.trace.declined, 'circuit-open', '第 4 次:熔断中零执行成本拒绝')
assert.equal(itp4th.result, null)
assert.equal(sentinelCalls, 3, '熔断后不再打上游')
console.log('5. FlyAI×Sentinel:永不重试 + 连环失败触发熔断保护配额 OK')

// ---------------------------------------------------------------------------
// 6. 断路拒绝面 + 冷却后 half-open 单探测成功恢复 closed
// ---------------------------------------------------------------------------
const declined = declinedObservation('FLYAI_SEARCH', itp4th.trace)
assert.equal(declined.ok, false)
assert.match(declined.summary, /断路器开启/, '拒绝面指引「不要立即重试」,不伪装成 miss')
clock += 120_000 // 冷却满(FlyAI 60s)→ half-open
const ipOk = makeProductionInterpreter({
  sleep: sleep0, breakers: flyaiBreakers, now, // 复用同一断路器 Map——状态在 Map 里存活
  handlers: { FLYAI_SEARCH: async () => ({ ok: true, via: 'flyai', verdict: 'hit', kind: 'flight', latencyMs: 1, evidence: 'e', options: [] }) },
})
const itp6 = await ipOk({ effect: 'FLYAI_SEARCH', params: { kind: 'flight' } })
assert.equal(itp6.trace.breaker, 'closed', 'half-open 单探测成功 → closed 恢复')
assert.ok(itp6.result != null && !itp6.trace.declined)
console.log('6. 断路拒绝面(结构化/零执行)+ 冷却后单探测恢复 closed OK')

// ---------------------------------------------------------------------------
// 7. mock 解译器:夹具回放确定性(CI 无网)
// ---------------------------------------------------------------------------
const mock = makeMockInterpreter({
  FLYAI_SEARCH: { ok: true, via: 'flyai', verdict: 'hit', kind: 'flight', latencyMs: 0, evidence: '[实时API:flyai@2026-08-29T00:00:00Z] 2/2 flight options', options: [{ no: '9C6617', name: '吉祥航空', depDateTime: '2026-10-01 07:55', arrDateTime: '2026-10-01 11:20', depStation: '浦东T2', arrStation: '丽江三义', durationMin: 205, price: 580 }] },
})
const mockFx = { effect: 'FLYAI_SEARCH', params: { kind: 'flight', origin: '上海', destination: '丽江', depDate: '2026-10-01' } } satisfies GotryEffect
const mockA = await mock(mockFx)
const mockB = await mock(mockFx)
assert.deepEqual(mockA.result, mockB.result, '同一夹具两次回放同值')
assert.equal((mockA.result as { verdict?: string }).verdict, 'hit')
assert.match(mockA.trace.evidence[0] ?? '', /\[效应:mock@.*夹具回放/, 'mock trace 标注')
const mockMiss = await mock({ effect: 'WEATHER_FORECAST', params: {} })
assert.equal(mockMiss.trace.declined, 'unknown-effect', 'mock 未登记夹具 = 拒绝面')
console.log('7. mock 解译器(夹具回放/未登记拒绝/确定性)OK')

// ---------------------------------------------------------------------------
// 8. SESSION 通道策略:永不重试、不熔断(风控红线),一次调用一次透传
// ---------------------------------------------------------------------------
let sessionCalls = 0
const ipSess = makeProductionInterpreter({
  sleep: sleep0,
  breakers: new Map(),
  handlers: {
    SESSION_FLIGHT_SEARCH: async () => {
      sessionCalls += 1
      return { ok: false, via: 'session-ctrip-flight-error', verdict: 'challenged', evidence: '[会话:ctrip-flight@error@ts] 风控命中', latencyMs: 9, error: 'challenge' }
    },
  },
})
const sessQ = { from: '上海', to: '丽江', date: '2026-10-01' }
const itp8 = await ipSess({ effect: 'SESSION_FLIGHT_SEARCH', params: sessQ })
assert.equal((itp8.result as { verdict?: string }).verdict, 'challenged', '渠道 verdict 原样透传')
assert.equal(itp8.trace.attempts, 1, 'SESSION 永不重试(挑战=红线)')
assert.equal(itp8.trace.breaker, 'off', 'SESSION 不参与断路器')
for (let i = 0; i < 5; i++) await ipSess({ effect: 'SESSION_FLIGHT_SEARCH', params: sessQ })
const itp8z = await ipSess({ effect: 'SESSION_FLIGHT_SEARCH', params: sessQ })
assert.ok(itp8z.trace.breaker === 'off' && !itp8z.trace.declined, 'SESSION 无断路拒绝(治理在节律闸与授权闸)')
assert.equal(sessionCalls, 7)
console.log('8. SESSION 通道策略(永不重试/不熔断/verdict 透传)OK')

// ---------------------------------------------------------------------------
// 9. 真实 handler 离线冒烟:hbcli 显式不可达 → 静态包降级(永不抛错,零网络)
// ---------------------------------------------------------------------------
__resetEffectBreakersForTest()
const tmp = await mkdtemp(join(tmpdir(), 'effect-test-'))
const itp9 = await interp({
  effect: 'HBCLI_HOTEL_SEARCH',
  // 显式不存在的自定义 bin:hbcliBinCandidates 对自定义名不回退已知安装位 → ENOENT → 静态包降级
  params: { destination: '大理', hbcliBin: join(tmp, 'no-such-hbcli'), fallbackPath: join(import.meta.dirname, '..', '..', 'data', 'hotels_2026.json') },
})
const hb9 = itp9.result as { summary?: string } | null
assert.ok(hb9 != null, '真实 handler 降级仍返回 observation')
assert.ok(typeof hb9!.summary === 'string' && hb9!.summary!.length > 0, '降级带人话 summary')
assert.ok(itp9.trace.evidence[0]?.startsWith('[效应:HBCLI_HOTEL_SEARCH@'), '解译层证据行')
await rm(tmp, { recursive: true, force: true })
console.log(`9. 真实 handler 离线冒烟(HBCLI 静态包降级,summary=${(hb9!.summary ?? '').slice(0, 40)}…)OK`)

// ---------------------------------------------------------------------------
// 10. M0 预订链读效应:HBCLI_HOTEL_RATES / HBCLI_CHECK_AVAIL
//     (注入 handler 验策略面;真实 handler 离线冒烟验价格面 fail-closed;mock 夹具)
// ---------------------------------------------------------------------------
// 10a. 注册进生产解译器:注入 handler 派发 / 永不重试 / 失败计熔断 / 三连错开闸
let ratesDispatches = 0
const ipM0 = makeProductionInterpreter({
  sleep: sleep0,
  breakers: new Map(),
  handlers: {
    HBCLI_HOTEL_RATES: async () => {
      ratesDispatches += 1
      return { via: 'hbcli-realtime', exitCode: 0, result: { rooms: [] }, evidence: '[实时API:hbcli@ts]', latencyMs: 1, rates: { rooms: [] }, summary: 'ok' }
    },
    HBCLI_CHECK_AVAIL: async () =>
      ({ via: 'hbcli-error', exitCode: 1, result: null, evidence: '[实时API:hbcli@error@ts]', latencyMs: 1, error: 'boom', avail: null, summary: 'err' }),
  },
})
const itp10 = await ipM0({ effect: 'HBCLI_HOTEL_RATES', params: { hotelId: '900000001', checkIn: '2026-09-05', checkOut: '2026-09-07', adults: 2 } } satisfies GotryEffect)
assert.equal(itp10.trace.attempts, 1, 'RATES 永不重试(候选路径切换不是重试)')
assert.ok(itp10.result != null && !itp10.trace.declined, 'RATES 命中注入 handler,observation 透传')
assert.ok(itp10.trace.evidence[0]?.startsWith('[效应:HBCLI_HOTEL_RATES@'), '解译层证据行')
const itp10b = await ipM0({ effect: 'HBCLI_CHECK_AVAIL', params: { ratePkgId: 'rp-1' } } satisfies GotryEffect)
assert.equal((itp10b.result as { via?: string } | null)?.via, 'hbcli-error', '渠道失败观察原样透传(平铺失败面,isFailure 计熔断)')
await ipM0({ effect: 'HBCLI_CHECK_AVAIL', params: { ratePkgId: 'rp-2' } } satisfies GotryEffect)
await ipM0({ effect: 'HBCLI_CHECK_AVAIL', params: { ratePkgId: 'rp-3' } } satisfies GotryEffect)
const itp10c = await ipM0({ effect: 'HBCLI_CHECK_AVAIL', params: { ratePkgId: 'rp-4' } } satisfies GotryEffect)
assert.equal(itp10c.trace.declined, 'circuit-open', '3 连错熔断保护(同 HBCLI 族策略)')
assert.equal(ratesDispatches, 1, '成功通道不受失败通道熔断影响(per-effect 隔离)')
console.log('10a. 预订链读效应注册(派发/永不重试/熔断族/per-effect 隔离)OK')

// 10b. 真实 handler 离线冒烟:不可达 bin → 诚实失败,价格面无静态降级(fail-closed)
__resetEffectBreakersForTest()
const tmp10 = await mkdtemp(join(tmpdir(), 'effect-m0-'))
const itp10d = await interp({
  effect: 'HBCLI_HOTEL_RATES',
  // 自定义不存在的 bin:候选路径不回退已知安装位 → ENOENT → 诚实失败(hotel-list 才有静态包降级)
  params: { hotelId: '900000001', hbcliBin: join(tmp10, 'no-such-hbcli') },
} satisfies GotryEffect)
const hr10 = itp10d.result as { via?: string; summary?: string } | null
assert.ok(hr10 != null, '不可达仍返回 observation(永不抛错)')
assert.equal(hr10!.via, 'hbcli-error', '未伪装成功')
assert.match(hr10!.summary ?? '', /不可用/, 'summary 明示不可用')
assert.ok(!/静态包/.test(hr10!.summary ?? '') || /无静态降级/.test(hr10!.summary ?? ''), '价格面不降级到静态包')
const itp10e = await interp({ effect: 'HBCLI_CHECK_AVAIL', params: { ratePkgId: 'rp-x', hbcliBin: join(tmp10, 'no-such-hbcli') } } satisfies GotryEffect)
assert.equal((itp10e.result as { via?: string } | null)?.via, 'hbcli-error', 'check-avail 同口径诚实失败')
await rm(tmp10, { recursive: true, force: true })
console.log('10b. 真实 handler 离线冒烟(价格面 fail-closed,无静态降级)OK')

// 10c. mock 解译器夹具回放(预订链 CI 形态;录制形态 = 渠道 observation 原样)
const mock10 = makeMockInterpreter({
  HBCLI_HOTEL_RATES: { via: 'hbcli-realtime', exitCode: 0, result: { rooms: [{ ratePkgId: 'rp-fx-1', roomTypeName: 'Deluxe King' }] }, evidence: '[实时API:hbcli@2026-08-30T00:00:00Z]', latencyMs: 1800, rates: { rooms: [{ ratePkgId: 'rp-fx-1', roomTypeName: 'Deluxe King' }] }, summary: 'hotel 900000001:hbcli 实时报价(2026-09-05 → 2026-09-07)' },
  HBCLI_CHECK_AVAIL: { via: 'hbcli-realtime', exitCode: 0, result: { ratePkgId: 'rp-fx-1', avail: true }, evidence: '[实时API:hbcli@2026-08-30T00:00:01Z]', latencyMs: 900, avail: { ratePkgId: 'rp-fx-1', avail: true }, summary: 'ratePkg rp-fx-1:hbcli 实时验价(库存与价格以后端为准)' },
})
const m10a = await mock10({ effect: 'HBCLI_HOTEL_RATES', params: { hotelId: '900000001' } } satisfies GotryEffect)
const m10b = await mock10({ effect: 'HBCLI_CHECK_AVAIL', params: { ratePkgId: 'rp-fx-1' } } satisfies GotryEffect)
assert.equal((m10a.result as { rates?: { rooms?: unknown[] } }).rates?.rooms?.length, 1, 'RATES 夹具回放')
assert.equal((m10b.result as { avail?: { avail?: boolean } }).avail?.avail, true, 'CHECK_AVAIL 夹具回放')
assert.match(m10a.trace.evidence[0] ?? '', /\[效应:mock@.*夹具回放/, 'mock trace 标注')
console.log('10c. mock 解译器夹具回放(预订链 CI 形态)OK')

// ---------------------------------------------------------------------------
// 11. HBCLI×timeout 冷启动重试(2026-09-02 迪拜 session 复盘:hotel-list 首调
//     30s 超时,LLM 手动立即重试即成功——上游建后端 session 可超时;策略改为
//     「仅 timeout 类重试 1 次」,ENOENT/退码类维持「切换不是重试」)
// ---------------------------------------------------------------------------
__resetEffectBreakersForTest()
let flakyCalls = 0
const ipTimeout = makeProductionInterpreter({
  sleep: sleep0,
  breakers: new Map(),
  handlers: {
    HBCLI_HOTEL_SEARCH: async () => {
      flakyCalls += 1
      if (flakyCalls === 1) return { via: 'hbcli-error', exitCode: -1, result: null, evidence: '[实时API:hbcli@timeout@ts]', latencyMs: 1, error: 'timeout after 30000ms' }
      return { via: 'hbcli-realtime', exitCode: 0, result: { hotels: [] }, evidence: '[实时API:hbcli@ts]', latencyMs: 1 }
    },
  },
})
const itp11 = await ipTimeout({ effect: 'HBCLI_HOTEL_SEARCH', params: { destination: '迪拜' } } satisfies GotryEffect)
assert.equal(itp11.trace.attempts, 2, `timeout 重试一次(attempts=2),实际 ${itp11.trace.attempts}`)
assert.equal((itp11.result as { via?: string } | null)?.via, 'hbcli-realtime', '重试后恢复实时')
assert.equal(itp11.trace.breaker, 'closed', '恢复即成功,断路不计数')
let hardCalls = 0
const ipEnoent = makeProductionInterpreter({
  sleep: sleep0,
  breakers: new Map(),
  handlers: {
    HBCLI_HOTEL_SEARCH: async () => {
      hardCalls += 1
      return { via: 'hbcli-error', exitCode: -1, result: null, evidence: '[实时API:hbcli@spawn_error@ts]', latencyMs: 1, error: 'spawn hbcli ENOENT' }
    },
  },
})
const itp11b = await ipEnoent({ effect: 'HBCLI_HOTEL_SEARCH', params: { destination: '迪拜' } } satisfies GotryEffect)
assert.equal(itp11b.trace.attempts, 1, 'ENOENT 类永不重试(切换不是重试契约不变)')
console.log('11. HBCLI×timeout 冷启动重试(timeout→attempts=2 恢复实时;ENOENT→attempts=1)OK')

// ---------------------------------------------------------------------------
// 12. D-23 收尾(issue #115):六渠道入注册表——策略表行存在 + 横切语义正确
//     (anything/web/github/video/agent_reach/session_login;没有策略表行就没有效应)
// ---------------------------------------------------------------------------
__resetEffectBreakersForTest()
// 12a. 六效应注册在案:handler 注入 → 原样透传,trace.channel 与策略表一致
const sixChannels: Array<[string, string, unknown]> = [
  ['ANYTHING_SEARCH', 'cli', { ok: true, via: 'hbcli-anything', verdict: 'hit', evidence: 'e', latencyMs: 1 }],
  ['WEB_READ', 'api', { ok: true, via: 'r.jina.ai', evidence: 'e', latencyMs: 1 }],
  ['GITHUB_SEARCH', 'cli', { ok: true, verdict: 'found', evidence: 'e', latencyMs: 1 }],
  ['VIDEO_SUBTITLE', 'cli', { ok: true, verdict: 'found', evidence: 'e', latencyMs: 1 }],
  ['AGENT_REACH', 'cli', { ok: true, verdict: 'found', channel: 'v2ex', method: 'read', evidence: 'e', latencyMs: 1 }],
  ['SESSION_LOGIN', 'browser', { ok: true, via: 'session-login', verdict: 'pending', evidence: 'e', latencyMs: 1 }],
]
for (const [fx, channel, obs] of sixChannels) {
  const ip = makeProductionInterpreter({ sleep: sleep0, breakers: new Map(), handlers: { [fx]: async () => obs } })
  const out = await ip({ effect: fx, params: {} } satisfies GotryEffect)
  assert.equal(out.result, obs, `${fx} 透传原样`)
  assert.equal(out.trace.channel, channel, `${fx} trace.channel=${channel}(策略表行在案)`)
  assert.equal(out.trace.attempts, 1, `${fx} 成功单次执行`)
}
console.log('12a. 六渠道入表(透传 + trace.channel 与策略表一致)OK')

// 12b. 永不重试族:AGENT_REACH / SESSION_LOGIN handler 恒抛错 → attempts=1(透传面不放大上游消耗)
for (const fx of ['AGENT_REACH', 'SESSION_LOGIN']) {
  const ip = makeProductionInterpreter({ sleep: sleep0, breakers: new Map(), handlers: { [fx]: async () => { throw new Error('upstream says no') } } })
  const out = await ip({ effect: fx, params: {} } satisfies GotryEffect)
  assert.equal(out.result, null, `${fx} 抛错 → result=null`)
  assert.equal(out.trace.attempts, 1, `${fx} 永不重试(attempts=1)`)
}
console.log('12b. AGENT_REACH/SESSION_LOGIN 永不重试(反射桥透传/浏览器风控红线)OK')

// 12c. WEB_READ 瞬时抖动重试 1 次(throw → 成功,attempts=2);GITHUB timeout 重试 / not-installed 不重试
__resetEffectBreakersForTest()
let webCalls = 0
const ipWeb = makeProductionInterpreter({
  sleep: sleep0, breakers: new Map(),
  handlers: { WEB_READ: async () => { webCalls += 1; if (webCalls === 1) throw new Error('socket hang up'); return { ok: true, via: 'r.jina.ai', evidence: 'e', latencyMs: 1 } } },
})
const outWeb = await ipWeb({ effect: 'WEB_READ', params: { url: 'https://example.com' } } satisfies GotryEffect)
assert.equal(outWeb.trace.attempts, 2, `WEB_READ 瞬时抖动重试 1 次,实际 ${outWeb.trace.attempts}`)
let ghTimeoutCalls = 0
const ipGhTimeout = makeProductionInterpreter({
  sleep: sleep0, breakers: new Map(),
  handlers: { GITHUB_SEARCH: async () => { ghTimeoutCalls += 1; if (ghTimeoutCalls === 1) return { ok: false, verdict: 'timeout', evidence: 'e', latencyMs: 1, stdout: '', stderr: '' }; return { ok: true, verdict: 'found', evidence: 'e', latencyMs: 1 } } },
})
const outGhT = await ipGhTimeout({ effect: 'GITHUB_SEARCH', params: { query: 'x' } } satisfies GotryEffect)
assert.equal(outGhT.trace.attempts, 2, 'GITHUB timeout 类重试 1 次(冷启动同 HBCLI 实况)')
let ghNiCalls = 0
const ipGhNi = makeProductionInterpreter({
  sleep: sleep0, breakers: new Map(),
  handlers: { GITHUB_SEARCH: async () => { ghNiCalls += 1; return { ok: false, verdict: 'not-installed', evidence: 'e', latencyMs: 0 } } },
})
const outGhNi = await ipGhNi({ effect: 'GITHUB_SEARCH', params: { query: 'x' } } satisfies GotryEffect)
assert.equal(outGhNi.trace.attempts, 1, 'not-installed 是配置态(needs-setup 族)不重试')
console.log('12c. WEB_READ/GITHUB/VIDEO 策略行(timeout 重试/配置态不重试)OK')

// 12d. mock 面:新效应夹具回放 + 未登记夹具结构化拒绝(与既有效应同语义)
__resetEffectBreakersForTest()
const mockIp = makeMockInterpreter({ ANYTHING_SEARCH: { ok: true, via: 'hbcli-anything', verdict: 'hit', evidence: '[实时API:hbcli-anything@ts]', latencyMs: 1 } })
const outMock = await mockIp({ effect: 'ANYTHING_SEARCH', params: { keyword: '大理' } } satisfies GotryEffect)
assert.equal((outMock.result as { verdict?: string }).verdict, 'hit', 'mock 夹具回放原样')
assert.equal(outMock.trace.channel, 'mock', 'mock 通道标注')
const outMockBad = await mockIp({ effect: 'SESSION_LOGIN', params: {} } satisfies GotryEffect)
assert.equal(outMockBad.result, null, '未登记夹具 → result=null')
assert.equal(outMockBad.trace.declined, 'unknown-effect', '未登记夹具 → 结构化拒绝')
console.log('12d. mock 夹具回放/未登记拒绝(新效应同语义)OK')

console.log('EFFECT INTERPRETER TESTS: 12/12 OK(effect_interpreter.v1:注册表封闭/退避链/断路三态/Sentinel 不重试/mock 夹具/SESSION 红线/真实降级/M0 预订链读效应/HBCLI timeout 重试/D-23 六渠道入表,纯离线)')
