/**
 * flyai 能力层测试(离线,临时假 CLI 脚本经 cliBin 注入,零网络):
 *  1. Sentinel 限流形状 {"message":"SentinelBlockException..."}——合法 JSON 但无 data.itemList,
 *     曾被 `data?.itemList ?? []` 吞成 0/0 静默 miss(issue #24)→ 应判 error 且保留 sentinel 字样
 *  2. 业务空形状 {"data":{"itemList":[]}} → verdict=miss(0/0,evidence 标注)
 *  3. 非空 flight/train itemList 只要有 malformed sibling → registered effect error,不落负事实
 *     (flight/train 各一条有效+畸形 fixture;无 partial-completeness hit)
 *  4. 非空 hotel itemList 有 malformed sibling → registered effect error,不落酒店事实
 *  5. transport/hotel 字段类型与空白校验不接受 truthy 数字/对象,并覆盖 official Alibaba shape
 *  6. 完整合法 flight/train/hotel → verdict=hit;有效空列表仍 miss
 *  7. exit≠0 → verdict=error
 *  8. 试用额度达限(exit 1 + MCP HTTP 429 "Trial limit reached",2026-09-02 迪拜
 *     session 实况)→ verdict=needs-setup + setup 指引(不再当通用 error 盲重试)
 *
 * 运行: cd ts && npx tsx scripts/flyai-tests.ts
 */

import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { flyaiSearch, type FlyaiQuery } from '../capabilities/flyai.ts'
import { makeProductionInterpreter } from '../capabilities/effect.ts'
import { loadFactRegistry } from '../capabilities/fact-log.ts'
import { apply, type Config } from '../src/index.ts'
import { factsFromFlyai, factsFromHotel, type FlightFact } from '../src/bookable-facts.ts'

const tmp = await mkdtemp(join(tmpdir(), 'flyai-test-'))
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

async function fakeCli(name: string, code: number, payload: string): Promise<string> {
  const p = join(tmp, name)
  await writeFile(p, `#!/bin/sh\nprintf '%s\\n' ${shellQuote(payload)}\nexit ${code}\n`, { mode: 0o755 })
  return p
}

async function fakeCliStreams(name: string, code: number, stdout: string, stderr: string): Promise<string> {
  const p = join(tmp, name)
  await writeFile(p, `#!/bin/sh\nprintf '%s\\n' ${shellQuote(stdout)}\nprintf '%s\\n' ${shellQuote(stderr)} >&2\nexit ${code}\n`, { mode: 0o755 })
  return p
}

const base = { kind: 'flight' as const, origin: '上海', destination: '丽江', depDate: '2026-10-01' }
const trainBase = { kind: 'train' as const, origin: '上海', destination: '大理', depDate: '2026-10-01' }
const hotelBase = { kind: 'hotel' as const, destName: '大理', checkInDate: '2026-10-01', checkOutDate: '2026-10-03' }

async function registeredSearch(q: Parameters<typeof flyaiSearch>[0]): Promise<Awaited<ReturnType<typeof flyaiSearch>>> {
  const registeredFlyai = makeProductionInterpreter({ breakers: new Map(), sleep: async () => {} })
  const observation = await registeredFlyai({ effect: 'FLYAI_SEARCH', params: q })
  assert.ok(observation.result, 'registered FlyAI effect 应返回结构化 observation')
  return observation.result as Awaited<ReturnType<typeof flyaiSearch>>
}

interface RegisteredFlyaiTool {
  name: string
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>
}

const registeredStateRoot = await mkdtemp(join(tmpdir(), 'flyai-registered-e2e-'))
let registeredCliBin = ''
const registeredTools: RegisteredFlyaiTool[] = []
const registeredBreakers = new Map()
const registeredContext = {
  tools: { register: (tool: unknown) => registeredTools.push(tool as RegisteredFlyaiTool) },
  systemPrompt: { variable: () => {} },
  on: () => () => {},
  get: () => undefined,
} as unknown as Context
const isolatedConfig: Config = {
  stateRoot: registeredStateRoot,
  timeoutMs: 5000,
  hbcliBin: 'hbcli-not-on-path',
  sessionAccess: 'off',
}
const registeredProductionEffect = makeProductionInterpreter({
  breakers: registeredBreakers,
  sleep: async () => {},
  handlers: {
    FLYAI_SEARCH: async (params: unknown) => flyaiSearch({ ...(params as FlyaiQuery), cliBin: registeredCliBin, timeoutMs: 5000 }),
  },
})
apply(registeredContext, isolatedConfig, { effect: registeredProductionEffect as never })
const registeredFlyaiTool = registeredTools.find(tool => tool.name === 'gotry_flyai_search')
assert.ok(registeredFlyaiTool, 'apply 应注册 gotry_flyai_search')

async function registeredToolSearch(name: string, args: Record<string, unknown>, itemList: unknown[]): Promise<Record<string, unknown>> {
  registeredCliBin = await fakeCli(`registered-${name}`, 0, JSON.stringify({ data: { itemList } }))
  return await registeredFlyaiTool!.execute(args, null) as Record<string, unknown>
}

async function assertRegisteredFactLogEmpty(label: string): Promise<void> {
  const facts = await loadFactRegistry(registeredStateRoot)
  assert.equal(facts.length, 0, `${label} 不得落 positive/negative fact`)
  registeredBreakers.clear()
}

// 1. 真正 registered tool E2E:apply → gotry_flyai_search → production effect/parser → fact sidecar
const registeredMalformedCases: Array<{ name: string; args: Record<string, unknown>; itemList: unknown[] }> = [
  { name: 'all-malformed-flight', args: { kind: 'flight', from: '北京', to: '上海', date: '2027-04-01' }, itemList: [{}] },
  { name: 'all-malformed-train', args: { kind: 'train', from: '北京', to: '上海', date: '2027-04-02' }, itemList: [null] },
  { name: 'all-malformed-hotel', args: { kind: 'hotel', to: '大理', checkIn: '2027-04-03', checkOut: '2027-04-05' }, itemList: [{ name: 42 }] },
]
for (const testCase of registeredMalformedCases) {
  const result = await registeredToolSearch(testCase.name, testCase.args, testCase.itemList)
  assert.equal(result.ok, false, `${testCase.name} 应返回 structured error(ok=false)`)
  assert.equal(result.verdict, 'error', `${testCase.name} 应经 registered tool 返回 error`)
  assert.match(String(result.evidence ?? ''), /flyai@error|malformed/i, `${testCase.name} 应保留结构化 error evidence`)
  await assertRegisteredFactLogEmpty(testCase.name)
}
const registeredMixedCases: Array<{ name: string; args: Record<string, unknown>; itemList: unknown[] }> = [
  {
    name: 'mixed-flight',
    args: { kind: 'flight', from: '北京', to: '上海', date: '2027-04-06' },
    itemList: [{ adultPrice: '¥400.0', journeys: [{ segments: [{ marketingTransportNo: 'CA1883', marketingTransportName: '国航', depDateTime: '2027-04-06 21:00:00', arrDateTime: '2027-04-06 23:20:00', depStationName: '首都国际机场', arrStationName: '浦东国际机场', duration: '140分钟' }] }] }, {}],
  },
  {
    name: 'mixed-train',
    args: { kind: 'train', from: '北京', to: '上海', date: '2027-04-07' },
    itemList: [{ adultPrice: '¥553.0', journeys: [{ segments: [{ marketingTransportNo: 'G11', depDateTime: '2027-04-07 08:00:00', arrDateTime: '2027-04-07 12:28:00', depStationName: '北京南', arrStationName: '上海虹桥', duration: '268分钟' }] }] }, null],
  },
  {
    name: 'mixed-hotel',
    args: { kind: 'hotel', to: '大理', checkIn: '2027-04-08', checkOut: '2027-04-10' },
    itemList: [{ name: '大理A 酒店', star: '高档型', price: '¥7xx', shId: 'hotel-a', detailUrl: 'https://example.test/hotel-a' }, { name: null }],
  },
]
for (const testCase of registeredMixedCases) {
  const result = await registeredToolSearch(testCase.name, testCase.args, testCase.itemList)
  assert.equal(result.ok, false, `${testCase.name} 应返回 structured error(ok=false)`)
  assert.equal(result.verdict, 'error', `${testCase.name} 应经 registered tool 返回整体 error`)
  assert.match(String(result.evidence ?? ''), /flyai@error|malformed/i, `${testCase.name} 应保留结构化 error evidence`)
  await assertRegisteredFactLogEmpty(testCase.name)
}
const registeredMiss = await registeredToolSearch(
  'exact-empty-flight',
  { kind: 'flight', from: '深圳', to: '普吉', date: '2027-04-11' },
  [],
)
assert.equal(registeredMiss.verdict, 'miss', `registered exact empty list 应返回 miss: ${JSON.stringify(registeredMiss)}`)
const factsAfterMiss = await loadFactRegistry(registeredStateRoot)
assert.equal(factsAfterMiss.length, 1, 'registered miss 只应产生一条 exact-date negative fact')
assert.equal(factsAfterMiss[0]?.kind, 'flight')
assert.equal(factsAfterMiss[0]?.bookability, 'unavailable_exact_date')
const registeredHit = await registeredToolSearch(
  'official-train-hit',
  { kind: 'train', from: '北京', to: '上海', date: '2027-04-12' },
  [{ adultPrice: '¥553.0', journeys: [{ journeyType: '直达', segments: [{ depStationName: '北京南', depDateTime: '2027-04-12 08:00:00', arrStationName: '上海虹桥', arrDateTime: '2027-04-12 12:28:00', duration: '268分钟', marketingTransportNo: 'G11', seatClassName: '二等座' }] }], jumpUrl: 'https://example.test/train' }],
)
assert.equal(registeredHit.verdict, 'hit', 'registered official train batch 应返回 hit')
const factsAfterHit = await loadFactRegistry(registeredStateRoot)
const typedPositive = factsAfterHit.find((f): f is FlightFact => f.kind === 'train' && f.query_id.endsWith(':2027-04-12'))
assert.ok(typedPositive, 'registered hit 应产生 typed positive fact')
assert.equal(typedPositive?.bookability, 'bookable_exact_date')
assert.equal(typedPositive?.flight_no, 'G11')
await rm(registeredStateRoot, { recursive: true, force: true })
console.log('1. registered E2E → mixed/all-malformed zero facts / empty miss negative / official train hit positiveOK')

// #517: registered tool + actual CLI. Persistent exit23/HTTP500 is retried
// once, then remains an error and writes no inventory fact.
const registeredTransientState = await mkdtemp(join(tmpdir(), 'flyai-517-registered-state-'))
const registeredTransientTools: RegisteredFlyaiTool[] = []
const registeredTransientContext = {
  tools: { register: (tool: unknown) => registeredTransientTools.push(tool as RegisteredFlyaiTool) },
  systemPrompt: { variable: () => {} }, on: () => () => {}, get: () => undefined,
} as unknown as Context
let registeredTransientCli = ''
const registeredTransientEffect = makeProductionInterpreter({
  breakers: new Map(), sleep: async () => {},
  handlers: { FLYAI_SEARCH: async (params: unknown) => flyaiSearch({ ...(params as FlyaiQuery), cliBin: registeredTransientCli, timeoutMs: 5_000 }) },
})
apply(registeredTransientContext, { ...isolatedConfig, stateRoot: registeredTransientState }, { effect: registeredTransientEffect as never })
const registeredTransientTool = registeredTransientTools.find(tool => tool.name === 'gotry_flyai_search')
assert.ok(registeredTransientTool, '#517 应沿 registered tool 执行')
const registeredTransientCount = join(tmp, 'flyai-517-http500.count')
registeredTransientCli = join(tmp, 'flyai-517-http500-exit23')
await writeFile(registeredTransientCli, [
  '#!/bin/sh',
  'n=0',
  `[ -f '${registeredTransientCount}' ] && n=$(cat '${registeredTransientCount}')`,
  `printf '%s' "$((n + 1))" > '${registeredTransientCount}'`,
  "printf '%s\\n' 'MCP HTTP 500 upstream temporary failure' >&2",
  'exit 23',
  '',
].join('\n'), { mode: 0o755 })
const registeredTransientResult = await registeredTransientTool!.execute(
  { kind: 'flight', from: '上海', to: '丽江', date: '2027-04-20' }, null,
) as Record<string, unknown>
assert.equal(registeredTransientResult.verdict, 'error', 'exit23 + HTTP500 耗尽后应为最终 error')
assert.equal(await readFile(registeredTransientCount, 'utf8'), '2', 'registered HTTP500 应实际尝试两次')
assert.equal((await loadFactRegistry(registeredTransientState)).length, 0, '最终 error 不得写入库存 facts')
await rm(registeredTransientState, { recursive: true, force: true })
console.log('1b. registered CLI exit23+HTTP500 → attempts=2 / final error / zero facts OK')

// Remaining #517 boundaries use the same production effect and actual child
// process adapter, while checking exact attempt counts in the effect trace.
async function processEffectCase(cliBin: string, extra: Partial<FlyaiQuery> = {}): Promise<{ result: unknown; trace: { attempts: number; declined?: string } }> {
  const interpreter = makeProductionInterpreter({ breakers: new Map(), sleep: async () => {} })
  return await interpreter({ effect: 'FLYAI_SEARCH', params: { ...base, cliBin, timeoutMs: 5_000, ...extra } }) as { result: unknown; trace: { attempts: number; declined?: string } }
}
const noTransientCli = await fakeCliStreams('flyai-517-exit23-no-transient', 23, '', 'provider failed')
const noTransientOutcome = await processEffectCase(noTransientCli)
assert.equal(noTransientOutcome.trace.attempts, 1, '无瞬时文本的 exit23 不得重试')
assert.equal((noTransientOutcome.result as { retryable?: boolean } | null)?.retryable, false)

const deadlineCli = join(tmp, 'flyai-517-local-deadline')
await writeFile(deadlineCli, '#!/bin/sh\nsleep 1\n', { mode: 0o755 })
const deadlineOutcome = await processEffectCase(deadlineCli, { timeoutMs: 50 })
assert.equal(deadlineOutcome.trace.attempts, 1, '本地 deadline 只能执行一次')
assert.equal((deadlineOutcome.result as { verdict?: string } | null)?.verdict, 'timeout')
assert.equal((deadlineOutcome.result as { localTermination?: string } | null)?.localTermination, 'deadline')
assert.equal((deadlineOutcome.result as { retryable?: boolean } | null)?.retryable, false, '本地 deadline 不得当上游 timeout 重试')

const spawnOutcome = await processEffectCase(join(tmp, 'flyai-517-does-not-exist'))
assert.equal(spawnOutcome.trace.attempts, 1, 'spawn 失败只能执行一次')
assert.equal((spawnOutcome.result as { localTermination?: string } | null)?.localTermination, 'spawn')
assert.equal((spawnOutcome.result as { retryable?: boolean } | null)?.retryable, false)

const emptyExitCli = join(tmp, 'flyai-517-empty-exit')
await writeFile(emptyExitCli, '#!/bin/sh\nkill -TERM $$\n', { mode: 0o755 })
const emptyExitOutcome = await processEffectCase(emptyExitCli)
assert.equal(emptyExitOutcome.trace.attempts, 1, '空退出只能执行一次')
assert.equal((emptyExitOutcome.result as { localTermination?: string } | null)?.localTermination, 'empty-exit')
assert.equal((emptyExitOutcome.result as { retryable?: boolean } | null)?.retryable, false)

const signalController = new AbortController()
const signalCli = join(tmp, 'flyai-517-signal')
await writeFile(signalCli, '#!/bin/sh\nsleep 1\n', { mode: 0o755 })
const signalPromise = processEffectCase(signalCli, { signal: signalController.signal })
setTimeout(() => signalController.abort(), 30)
const signalOutcome = await signalPromise
assert.equal(signalOutcome.trace.attempts, 1, 'signal 终止只能执行一次')
assert.equal(signalOutcome.trace.declined, 'aborted', 'signal 终止应沿 effect 取消面返回')
console.log('1c. exit23/no-text、deadline、signal、spawn、empty-exit 均 fail-closed 单次 OK')

// 1. Sentinel 限流:合法 JSON 的非业务形状 → error(不是静默 miss)
const sentinelBin = await fakeCli('flyai-sentinel', 0, '{"message":"SentinelBlockException: flow control"}')
const s = await flyaiSearch({ ...base, cliBin: sentinelBin, timeoutMs: 5000 })
assert.equal(s.ok, false, 'Sentinel 形状应 ok=false')
assert.equal(s.verdict, 'error', `Sentinel 形状应判 error,实际 ${s.verdict}`)
assert.equal(s.retryable, false, 'Sentinel 不得标记 retryable')
assert.match(s.error ?? '', /sentinel/i, `error 应保留 sentinel 字样(供上层限流识别),实际 ${s.error}`)
assert.match(s.evidence, /\[实时API:flyai@error@/, 'error 证据链标注')
console.log('1. Sentinel 非业务形状 → error(非静默 miss)OK')

// 2. 业务空形状 → miss(上游正常,确无航班)
const missBin = await fakeCli('flyai-miss', 0, '{"data":{"itemList":[]}}')
const m = await flyaiSearch({ ...base, cliBin: missBin, timeoutMs: 5000 })
assert.equal(m.ok, true, '业务空形状 ok=true')
assert.equal(m.verdict, 'miss', `空 itemList 应判 miss,实际 ${m.verdict}`)
assert.match(m.evidence, /0\/0 flight options/, 'miss 证据链 0/0')
console.log('2. 业务空形状 → miss(0/0)OK')

// 3. 非空但全 malformed transport item → registered effect error,不落负事实
const malformedBin = await fakeCli('flyai-malformed', 0, '{"data":{"itemList":[{}]}}')
const malformed = await registeredSearch({ ...base, cliBin: malformedBin, timeoutMs: 5000 })
assert.equal(malformed.ok, false, '全 malformed transport item 不应报告成功')
assert.equal(malformed.verdict, 'error', '非空全 malformed transport item 应判 error')
assert.equal(malformed.retryable, false, 'malformed 不得标记 retryable')
assert.match(malformed.error ?? '', /malformed|valid typed transport/i, 'error 应保留 transport shape 原因')
assert.match(malformed.evidence, /flyai@error@.*flight itemList/i, 'evidence 应保留结构化 flight itemList 错误')
assert.deepEqual(
  factsFromFlyai({ kind: base.kind, origin: base.origin, destination: base.destination, date: base.depDate }, malformed, new Date().toISOString()),
  [],
  'registered path 的 malformed error 不得生成负库存事实',
)
console.log('3. 非空全 malformed transport item → registered error,不落负事实OK')

// 4. flight 有效+malformed sibling → 整体 error,不落负事实
const hitPayload = JSON.stringify({
  data: {
    itemList: [{
      journeys: [{
        segments: [{
          marketingTransportNo: '9C6617', marketingTransportName: '吉祥航空',
          depDateTime: '2026-10-01 07:55', arrDateTime: '2026-10-01 11:20',
          depStationName: '浦东T2', arrStationName: '丽江三义', duration: 205,
        }],
      }],
      ticketPrice: '580',
      jumpUrl: 'https://www.fliggy.com/demo',
    }],
  },
})
const mixedBin = await fakeCli('flyai-mixed', 0, JSON.stringify({
  data: {
    itemList: [{}, {
      journeys: [{ segments: [{
        marketingTransportNo: 'G201', marketingTransportName: '高铁',
        depDateTime: '2026-10-01 09:00', arrDateTime: '2026-10-01 12:00',
        depStationName: '上海虹桥', arrStationName: '丽江站', duration: 180,
      }] }],
      ticketPrice: '480',
    }],
  },
}))
const flightMixed = await registeredSearch({ ...base, cliBin: mixedBin, timeoutMs: 5000 })
assert.equal(flightMixed.ok, false, 'flight 混合响应不应报告成功')
assert.equal(flightMixed.verdict, 'error', 'flight 有效+malformed sibling 应整体 error')
assert.equal(flightMixed.options, undefined, 'flight malformed error 不应暴露 options')
assert.match(flightMixed.evidence, /flight itemList malformed.*1\/2/i, 'flight error 应暴露 malformed/总条目比例')
assert.deepEqual(factsFromFlyai({ kind: base.kind, origin: base.origin, destination: base.destination, date: base.depDate }, flightMixed, new Date().toISOString()), [], 'flight mixed error 不得生成负库存事实')
console.log('4. flight 有效+malformed sibling → 整体 error,不落负事实OK')

// 5. train 有效+malformed sibling → 整体 error,不落负事实
const trainMixedBin = await fakeCli('flyai-train-mixed', 0, JSON.stringify({
  data: {
    itemList: [{
      journeys: [{ segments: [{
        marketingTransportNo: 'G201', marketingTransportName: '高铁',
        depDateTime: '2026-10-01 09:00', arrDateTime: '2026-10-01 12:00',
        depStationName: '上海虹桥', arrStationName: '大理站', duration: '180',
      }] }],
      ticketPrice: '480',
    }, null],
  },
}))
const trainMixed = await registeredSearch({ ...trainBase, cliBin: trainMixedBin, timeoutMs: 5000 })
assert.equal(trainMixed.ok, false, 'train 混合响应不应报告成功')
assert.equal(trainMixed.verdict, 'error', 'train 有效+malformed sibling 应整体 error')
assert.equal(trainMixed.options, undefined, 'train malformed error 不应暴露 options')
assert.match(trainMixed.evidence, /train itemList malformed.*1\/2/i, 'train error 应暴露 malformed/总条目比例')
assert.deepEqual(factsFromFlyai({ kind: trainBase.kind, origin: trainBase.origin, destination: trainBase.destination, date: trainBase.depDate }, trainMixed, new Date().toISOString()), [], 'train mixed error 不得生成负库存事实')
console.log('5. train 有效+malformed sibling → 整体 error,不落负事实OK')

// 6. hotel 有效+malformed sibling → 整体 error,不落酒店事实
const hotelMixedBin = await fakeCli('flyai-hotel-mixed', 0, JSON.stringify({
  data: {
    itemList: [{ name: '大理A 酒店', star: '高档型', price: '¥7xx', shId: 'hotel-a' }, { name: null }],
  },
}))
const hotelMixed = await registeredSearch({ ...hotelBase, cliBin: hotelMixedBin, timeoutMs: 5000 })
assert.equal(hotelMixed.ok, false, 'hotel 混合响应不应报告成功')
assert.equal(hotelMixed.verdict, 'error', 'hotel 有效+malformed sibling 应整体 error')
assert.equal(hotelMixed.hotels, undefined, 'hotel malformed error 不应暴露 hotels')
assert.match(hotelMixed.evidence, /hotel itemList malformed.*1\/2/i, 'hotel error 应暴露 malformed/总条目比例')
assert.deepEqual(factsFromHotel({ source: 'flyai-hotel', destination: hotelBase.destName, checkIn: hotelBase.checkInDate, checkOut: hotelBase.checkOutDate, verdict: hotelMixed.verdict, options: 0, evidence: hotelMixed.evidence, fetchedAt: new Date().toISOString() }), [], 'hotel mixed error 不得生成酒店事实')
console.log('6. hotel 有效+malformed sibling → 整体 error,不落酒店事实OK')

// 7. typed transport/hotel 字段拒绝 truthy 数字与空白
const typedTransportMalformedBin = await fakeCli('flyai-typed-transport-malformed', 0, JSON.stringify({
  data: { itemList: [{
    journeys: [{ segments: [{
      marketingTransportNo: 12345, marketingTransportName: '吉祥航空',
      depDateTime: '   ', arrDateTime: '2026-10-01 11:20',
      depStationName: '浦东T2', arrStationName: '丽江三义', duration: 205,
    }] }],
    ticketPrice: '580',
  }] },
}))
const typedTransportMalformed = await registeredSearch({ ...base, cliBin: typedTransportMalformedBin, timeoutMs: 5000 })
assert.equal(typedTransportMalformed.verdict, 'error', '数字 transportNo/空白 depDateTime 应判 error')
assert.equal(typedTransportMalformed.options, undefined, '字段类型 malformed 不应暴露 options')
const typedHotelMalformedBin = await fakeCli('flyai-typed-hotel-malformed', 0, JSON.stringify({ data: { itemList: [{ name: { value: '酒店' }, price: '¥7xx' }] } }))
const typedHotelMalformed = await registeredSearch({ ...hotelBase, cliBin: typedHotelMalformedBin, timeoutMs: 5000 })
assert.equal(typedHotelMalformed.verdict, 'error', '对象 hotel name 应判 error')
assert.equal(typedHotelMalformed.hotels, undefined, '字段类型 malformed 不应暴露 hotels')
console.log('7. typed transport/hotel 字段拒绝 truthy 数字、对象与空白OK')

// 8. official Alibaba shape → adultPrice、带“分钟”时长与 train 缺名称兼容
const officialFlightBin = await fakeCli('flyai-official-flight', 0, JSON.stringify({
  data: { itemList: [{
    adultPrice: '¥400.0',
    journeys: [{ journeyType: '直达', segments: [{
      depStationName: '首都国际机场', depDateTime: '2026-03-28 21:00:00',
      arrStationName: '浦东国际机场', arrDateTime: '2026-03-28 23:20:00',
      duration: '140分钟', marketingTransportName: '国航', marketingTransportNo: 'CA1883', seatClassName: '经济舱',
    }] }],
    jumpUrl: 'https://example.test/flight',
  }] },
}))
const officialFlight = await registeredSearch({ ...base, cliBin: officialFlightBin, timeoutMs: 5000 })
assert.equal(officialFlight.verdict, 'hit', 'official flight shape 应保持 hit')
assert.equal(officialFlight.options?.[0]?.price, 400, 'official adultPrice 应解析为 400')
assert.equal(officialFlight.options?.[0]?.durationMin, 140, 'official 中文分钟时长应解析为 140')
const officialTrainBin = await fakeCli('flyai-official-train', 0, JSON.stringify({
  data: { itemList: [{
    adultPrice: '¥553.0',
    journeys: [{ journeyType: '直达', segments: [{
      depStationName: '北京南', depDateTime: '2026-03-15 08:00:00',
      arrStationName: '上海虹桥', arrDateTime: '2026-03-15 12:28:00',
      duration: '268分钟', marketingTransportNo: 'G11', seatClassName: '二等座',
    }] }],
    jumpUrl: 'https://example.test/train',
  }] },
}))
const officialTrain = await registeredSearch({ ...trainBase, cliBin: officialTrainBin, timeoutMs: 5000 })
assert.equal(officialTrain.verdict, 'hit', 'official train shape 应保持 hit')
assert.equal(officialTrain.options?.[0]?.price, 553, 'official train adultPrice 应解析为 553')
assert.equal(officialTrain.options?.[0]?.durationMin, 268, 'official train 中文分钟时长应解析为 268')
assert.equal(officialTrain.options?.[0]?.name, '', '缺 marketingTransportName 不猜名称且保留空字符串')
console.log('8. official flight/train shape → adultPrice/分钟时长/缺名称兼容OK')

// 9. official typed fields:invalid price/duration/name type → structured error
const invalidPriceBin = await fakeCli('flyai-invalid-price', 0, JSON.stringify({
  data: { itemList: [{
    adultPrice: 'not-a-price',
    journeys: [{ segments: [{
      marketingTransportNo: 'CA1883', marketingTransportName: '国航',
      depDateTime: '2026-03-28 21:00:00', arrDateTime: '2026-03-28 23:20:00',
      depStationName: '首都国际机场', arrStationName: '浦东国际机场', duration: '140分钟',
    }] }],
  }] },
}))
const invalidPrice = await registeredSearch({ ...base, cliBin: invalidPriceBin, timeoutMs: 5000 })
assert.equal(invalidPrice.verdict, 'error', '非法文本价格应判 error')
const invalidDurationBin = await fakeCli('flyai-invalid-duration', 0, JSON.stringify({
  data: { itemList: [{
    adultPrice: '¥400.0',
    journeys: [{ segments: [{
      marketingTransportNo: 'CA1883', marketingTransportName: '国航',
      depDateTime: '2026-03-28 21:00:00', arrDateTime: '2026-03-28 23:20:00',
      depStationName: '首都国际机场', arrStationName: '浦东国际机场', duration: { value: 140 },
    }] }],
  }] },
}))
const invalidDuration = await registeredSearch({ ...base, cliBin: invalidDurationBin, timeoutMs: 5000 })
assert.equal(invalidDuration.verdict, 'error', '对象时长应判 error')
const invalidNameBin = await fakeCli('flyai-invalid-name', 0, JSON.stringify({
  data: { itemList: [{
    adultPrice: '¥553.0',
    journeys: [{ segments: [{
      depStationName: '北京南', depDateTime: '2026-03-15 08:00:00',
      arrStationName: '上海虹桥', arrDateTime: '2026-03-15 12:28:00',
      duration: '268分钟', marketingTransportNo: 'G11', marketingTransportName: 123,
    }] }],
  }] },
}))
const invalidName = await registeredSearch({ ...trainBase, cliBin: invalidNameBin, timeoutMs: 5000 })
assert.equal(invalidName.verdict, 'error', '数字 marketingTransportName 应判 error')
console.log('9. official typed 字段非法 price/duration/name → errorOK')

// 10. 完整合法 flight → hit,字段解析
const hitBin = await fakeCli('flyai-hit', 0, hitPayload)
const h = await flyaiSearch({ ...base, cliBin: hitBin, timeoutMs: 5000 })
assert.equal(h.ok, true, '完整合法 flight ok=true')
assert.equal(h.verdict, 'hit', `完整合法 flight 应判 hit,实际 ${h.verdict}`)
assert.equal(h.options?.length, 1, '1 个选项')
assert.equal(h.options![0]!.no, '9C6617')
assert.equal(h.options![0]!.price, 580, '价格数值解析')
assert.equal(h.options![0]!.depStation, '浦东T2')
assert.match(h.evidence, /1\/1 flight options/, 'hit 证据链 1/1')
console.log('10. 完整合法 flight → hit(9C6617 ¥580)OK')

// 11. 完整合法 train → hit,共享 transport typed 合同
const trainHitBin = await fakeCli('flyai-train-hit', 0, JSON.stringify({
  data: {
    itemList: [{
      journeys: [{ segments: [{
        marketingTransportNo: 'G201', marketingTransportName: '高铁',
        depDateTime: '2026-10-01 09:00', arrDateTime: '2026-10-01 12:00',
        depStationName: '上海虹桥', arrStationName: '大理站', duration: '180', seatClassName: '二等座',
      }] }],
      ticketPrice: '480',
    }],
  },
}))
const trainHit = await flyaiSearch({ ...trainBase, cliBin: trainHitBin, timeoutMs: 5000 })
assert.equal(trainHit.ok, true, '完整合法 train ok=true')
assert.equal(trainHit.verdict, 'hit', '完整合法 train 应判 hit')
assert.equal(trainHit.options?.length, 1, '完整合法 train 产出 1 个选项')
assert.equal(trainHit.options?.[0]?.no, 'G201')
console.log('11. 完整合法 train → hit(G201)OK')

// 12. 完整合法 hotel → hit,保持酒店语义
const hotelHitBin = await fakeCli('flyai-hotel-hit', 0, JSON.stringify({ data: { itemList: [{ name: '大理A 酒店', star: '高档型', price: '¥7xx', rate: null, address: 'addr', interestsPoi: '近洱海', shId: 'hotel-a', detailUrl: 'https://example.test/hotel-a' }] } }))
const hotelHit = await flyaiSearch({ ...hotelBase, cliBin: hotelHitBin, timeoutMs: 5000 })
assert.equal(hotelHit.ok, true, '完整合法 hotel ok=true')
assert.equal(hotelHit.verdict, 'hit', '完整合法 hotel 应判 hit')
assert.equal(hotelHit.hotels?.length, 1, '1 个酒店选项')
assert.equal(hotelHit.hotels?.[0]?.name, '大理A 酒店')
assert.equal(hotelHit.hotels?.[0]?.priceRaw, '¥7xx', '酒店打码价原值保留')
console.log('12. 完整合法 hotel → hit(打码价保真)OK')

// 13. exit≠0 → error
const failBin = await fakeCli('flyai-fail', 1, '')
const f = await flyaiSearch({ ...base, cliBin: failBin, timeoutMs: 5000 })
assert.equal(f.ok, false)
assert.equal(f.verdict, 'error', '非零退出应判 error')
console.log('13. 非零退出 → error OK')

// 14. 试用额度达限(2026-09-02 迪拜 session 实况:exit 1 + MCP HTTP 429 Trial limit
//    reached)→ needs-setup 而非通用 error——阻断 LLM 拿同一把 429 跨轮盲重试
const trialBin = join(tmp, 'flyai-trial')
await writeFile(trialBin, `#!/bin/sh\necho 'search-hotel: MCP HTTP 429: Body: {"jsonrpc":"2.0","id":"1","error":{"code":-32603,"message":"Trial limit reached. Please visit the console at flyai.open.fliggy.com to get a formal API Key"}}' >&2\nexit 1\n`, { mode: 0o755 })
const t = await flyaiSearch({ ...base, cliBin: trialBin, timeoutMs: 5000 })
assert.equal(t.ok, false)
assert.equal(t.verdict, 'needs-setup', `429 达限应判 needs-setup,实际 ${t.verdict}`)
assert.match(t.setup ?? '', /gotry setup flyai|FLYAI_API_KEY/, 'setup 指引带本机配置路径')
assert.match(t.setup ?? '', /flyai\.open\.fliggy\.com/, 'setup 指引带控制台入口')
assert.match(t.setup ?? '', /请勿.*重试|勿.*重试|不要重试/, 'setup 明示本会话勿重试')
assert.match(t.error ?? '', /429|Trial limit/i, 'error 保留上游 429 原话')
assert.match(t.evidence, /\[实时API:flyai@error@/, '证据链标注')
assert.equal(t.retryable, false, 'trial 429 不得标记 retryable')

const ordinaryRateBin = await fakeCliStreams('flyai-ordinary-rate', 1, '', 'MCP HTTP 429: rate limited; retry later')
const ordinaryRate = await flyaiSearch({ ...base, cliBin: ordinaryRateBin, timeoutMs: 5000 })
assert.equal(ordinaryRate.verdict, 'rate-limited', '普通 429 应保持 rate-limited')
assert.equal(ordinaryRate.retryable, true, '普通 429 应标记 retryable')
const networkBin = await fakeCliStreams('flyai-network-transient', 1, '', 'fetch failed: ECONNRESET')
const networkTransient = await flyaiSearch({ ...base, cliBin: networkBin, timeoutMs: 5000 })
assert.equal(networkTransient.verdict, 'error', '网络错误保持结构化 error')
assert.equal(networkTransient.retryable, true, '普通网络错误应标记 retryable')

// 15. 真实 CLI 进程边界:config/env key 与 DEBUG endpoint 敏感段不能进入 error/raw/AI 输出。
//     这里仍用本地 fixture CLI，但走 adapter 的真实 HOME/env 解析路径，不触碰用户配置。
const previousFlyaiEnv = {
  HOME: process.env.HOME,
  FLYAI_API_KEY: process.env.FLYAI_API_KEY,
  DEBUG_FLYAI_API_KEY: process.env.DEBUG_FLYAI_API_KEY,
  DEBUG_FLYAI_MCP_URL: process.env.DEBUG_FLYAI_MCP_URL,
}
const sensitiveHome = await mkdtemp(join(tmpdir(), 'flyai-sensitive-home-'))
const configKey = 'config-secret-key-521'
const envKey = 'env-secret-key-521'
const debugEndpoint = 'https://alice:password@example.test/mcp?token=debug-query&x=1'
const restoreFlyaiEnv = (): void => {
  for (const [name, value] of Object.entries(previousFlyaiEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}
try {
  await mkdir(join(sensitiveHome, '.flyai'), { recursive: true })
  await writeFile(join(sensitiveHome, '.flyai', 'config.json'), JSON.stringify({ FLYAI_API_KEY: configKey }))
  process.env.HOME = sensitiveHome
  delete process.env.FLYAI_API_KEY
  delete process.env.DEBUG_FLYAI_API_KEY
  process.env.DEBUG_FLYAI_MCP_URL = debugEndpoint

  const configLeakBin = await fakeCliStreams(
    'flyai-config-leak',
    1,
    `stdout key=${configKey} endpoint=${debugEndpoint}`,
    `stderr key=${configKey} endpoint=${debugEndpoint} HTTP 500`,
  )
  const configLeak = await flyaiSearch({ ...base, cliBin: configLeakBin, timeoutMs: 5000 })
  const configLeakText = JSON.stringify(configLeak)
  assert.equal(configLeak.keySource, 'config', 'config key 应成为实际来源标记')
  assert.equal(configLeak.verdict, 'error')
  assert.equal(configLeak.retryable, true, 'HTTP 500 应标记 retryable，供 effect 层消费')
  assert.ok(!configLeakText.includes(configKey), 'config key 不得进入 error/raw 输出')
  assert.ok(!configLeakText.includes('alice:password'), 'DEBUG endpoint userinfo 不得进入 error/raw 输出')
  assert.ok(!configLeakText.includes('token=debug-query'), 'DEBUG endpoint query 不得进入 error/raw 输出')
  assert.match(configLeak.error ?? '', /已隐藏 endpoint 敏感参数/, '错误应保留 endpoint 已脱敏提示')

  process.env.FLYAI_API_KEY = envKey
  const envLeakBin = await fakeCliStreams(
    'flyai-env-leak',
    1,
    `stdout key=${envKey} endpoint=${debugEndpoint}`,
    `stderr key=${envKey} endpoint=${debugEndpoint} HTTP 401 Invalid API key`,
  )
  const envLeak = await flyaiSearch({ ...base, cliBin: envLeakBin, timeoutMs: 5000 })
  const envLeakText = JSON.stringify(envLeak)
  assert.equal(envLeak.keySource, 'env', 'env key 应覆盖 config 来源')
  assert.equal(envLeak.verdict, 'auth-error', 'HTTP 401 应保持 auth-error')
  assert.equal(envLeak.retryable, false, 'HTTP 401 不得标记 retryable')
  assert.ok(!envLeakText.includes(envKey), 'env key 不得进入 error/raw 输出')
  assert.ok(!envLeakText.includes('alice:password'), 'env error 不得包含 endpoint userinfo')
  assert.ok(!envLeakText.includes('token=debug-query'), 'env error 不得包含 endpoint query')

  const forbiddenBin = await fakeCliStreams(
    'flyai-forbidden',
    1,
    '',
    `endpoint=${debugEndpoint} HTTP 403 Forbidden`,
  )
  const forbidden = await flyaiSearch({ ...base, cliBin: forbiddenBin, timeoutMs: 5000 })
  assert.equal(forbidden.verdict, 'forbidden', 'HTTP 403 应保持 forbidden')
  assert.equal(forbidden.retryable, false, 'HTTP 403 不得标记 retryable')

  const aiLeakBin = await fakeCli(
    'flyai-ai-leak',
    0,
    JSON.stringify({
      data: { answer: envKey, endpoint: debugEndpoint },
      systemMessage: `模型提示 key=${envKey} endpoint=${debugEndpoint}`,
    }),
  )
  const aiLeak = await flyaiSearch({ kind: 'ai', query: '敏感输出回归', cliBin: aiLeakBin, timeoutMs: 5000 })
  const aiLeakText = JSON.stringify(aiLeak)
  assert.equal(aiLeak.verdict, 'hit')
  assert.ok(!aiLeakText.includes(envKey), 'AI data/systemMessage 不得包含 env key')
  assert.ok(!aiLeakText.includes('alice:password'), 'AI data/systemMessage 不得包含 endpoint userinfo')
  assert.ok(!aiLeakText.includes('token=debug-query'), 'AI data/systemMessage 不得包含 endpoint query')
} finally {
  restoreFlyaiEnv()
  await rm(sensitiveHome, { recursive: true, force: true })
}
console.log('15. config/env key + DEBUG endpoint userinfo/query 脱敏(error/raw/AI 输出)与 HTTP 5xx retryable 标记OK')

await rm(tmp, { recursive: true, force: true })
console.log('FLYAI TESTS: transport/hotel completeness + error contract OK(离线假 CLI:Sentinel→error / 空 itemList→miss / flight+train+hotel mixed→整体 error 且不落事实 / typed 字段校验 / 完整 flight+train+hotel→hit / exit≠0→error / 429→needs-setup / transient retryable / 敏感信息脱敏)')
