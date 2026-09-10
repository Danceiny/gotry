/**
 * flyai 能力层测试(离线,临时假 CLI 脚本经 cliBin 注入,零网络):
 *  1. Sentinel 限流形状 {"message":"SentinelBlockException..."}——合法 JSON 但无 data.itemList,
 *     曾被 `data?.itemList ?? []` 吞成 0/0 静默 miss(issue #24)→ 应判 error 且保留 sentinel 字样
 *  2. 业务空形状 {"data":{"itemList":[]}} → verdict=miss(0/0,evidence 标注)
 *  3. 非空 transport itemList 只要有 malformed sibling → registered effect error,不落负事实
 *     (flight/train 各一条有效+畸形 fixture;无 partial-completeness hit)
 *  4. 非空 hotel itemList 有 malformed sibling → registered effect error,不落酒店事实
 *  5. transport/hotel 字段类型与空白校验不接受 truthy 数字/对象
 *  6. 完整合法 flight/train/hotel → verdict=hit;有效空列表仍 miss
 *  7. exit≠0 → verdict=error
 *  8. 试用额度达限(exit 1 + MCP HTTP 429 "Trial limit reached",2026-09-02 迪拜
 *     session 实况)→ verdict=needs-setup + setup 指引(不再当通用 error 盲重试)
 *
 * 运行: cd ts && npx tsx scripts/flyai-tests.ts
 */

import assert from 'node:assert/strict'
import { writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { flyaiSearch } from '../capabilities/flyai.ts'
import { makeProductionInterpreter } from '../capabilities/effect.ts'
import { factsFromFlyai, factsFromHotel } from '../src/bookable-facts.ts'

const tmp = await mkdtemp(join(tmpdir(), 'flyai-test-'))
async function fakeCli(name: string, code: number, payload: string): Promise<string> {
  const p = join(tmp, name)
  await writeFile(p, `#!/bin/sh\necho '${payload}'\nexit ${code}\n`, { mode: 0o755 })
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

// 1. Sentinel 限流:合法 JSON 的非业务形状 → error(不是静默 miss)
const sentinelBin = await fakeCli('flyai-sentinel', 0, '{"message":"SentinelBlockException: flow control"}')
const s = await flyaiSearch({ ...base, cliBin: sentinelBin, timeoutMs: 5000 })
assert.equal(s.ok, false, 'Sentinel 形状应 ok=false')
assert.equal(s.verdict, 'error', `Sentinel 形状应判 error,实际 ${s.verdict}`)
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
assert.match(malformed.error ?? '', /malformed|valid typed transport/i, 'error 应保留 transport shape 原因')
assert.match(malformed.evidence, /flyai@error@.*transport itemList/i, 'evidence 应保留结构化 transport 错误')
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
assert.match(flightMixed.evidence, /transport itemList malformed.*1\/2/i, 'flight error 应暴露 malformed/总条目比例')
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
assert.match(trainMixed.evidence, /transport itemList malformed.*1\/2/i, 'train error 应暴露 malformed/总条目比例')
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

// 8. 完整合法 flight → hit,字段解析
const hitBin = await fakeCli('flyai-hit', 0, hitPayload)
const h = await flyaiSearch({ ...base, cliBin: hitBin, timeoutMs: 5000 })
assert.equal(h.ok, true, '完整合法 flight ok=true')
assert.equal(h.verdict, 'hit', `完整合法 flight 应判 hit,实际 ${h.verdict}`)
assert.equal(h.options?.length, 1, '1 个选项')
assert.equal(h.options![0]!.no, '9C6617')
assert.equal(h.options![0]!.price, 580, '价格数值解析')
assert.equal(h.options![0]!.depStation, '浦东T2')
assert.match(h.evidence, /1\/1 flight options/, 'hit 证据链 1/1')
console.log('8. 完整合法 flight → hit(9C6617 ¥580)OK')

// 9. 完整合法 train → hit,共享 transport typed 合同
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
console.log('9. 完整合法 train → hit(G201)OK')

// 10. 完整合法 hotel → hit,保持酒店语义
const hotelHitBin = await fakeCli('flyai-hotel-hit', 0, JSON.stringify({ data: { itemList: [{ name: '大理A 酒店', star: '高档型', price: '¥7xx', rate: null, address: 'addr', interestsPoi: '近洱海', shId: 'hotel-a', detailUrl: 'https://example.test/hotel-a' }] } }))
const hotelHit = await flyaiSearch({ ...hotelBase, cliBin: hotelHitBin, timeoutMs: 5000 })
assert.equal(hotelHit.ok, true, '完整合法 hotel ok=true')
assert.equal(hotelHit.verdict, 'hit', '完整合法 hotel 应判 hit')
assert.equal(hotelHit.hotels?.length, 1, '1 个酒店选项')
assert.equal(hotelHit.hotels?.[0]?.name, '大理A 酒店')
assert.equal(hotelHit.hotels?.[0]?.priceRaw, '¥7xx', '酒店打码价原值保留')
console.log('10. 完整合法 hotel → hit(打码价保真)OK')

// 11. exit≠0 → error
const failBin = await fakeCli('flyai-fail', 1, '')
const f = await flyaiSearch({ ...base, cliBin: failBin, timeoutMs: 5000 })
assert.equal(f.ok, false)
assert.equal(f.verdict, 'error', '非零退出应判 error')
console.log('11. 非零退出 → error OK')

// 12. 试用额度达限(2026-09-02 迪拜 session 实况:exit 1 + MCP HTTP 429 Trial limit
//    reached)→ needs-setup 而非通用 error——阻断 LLM 拿同一把 429 跨轮盲重试
const trialBin = join(tmp, 'flyai-trial')
await writeFile(trialBin, `#!/bin/sh\necho 'search-hotel: MCP HTTP 429: Body: {"jsonrpc":"2.0","id":"1","error":{"code":-32603,"message":"Trial limit reached. Please visit the console at flyai.open.fliggy.com to get a formal API Key"}}' >&2\nexit 1\n`, { mode: 0o755 })
const t = await flyaiSearch({ ...base, cliBin: trialBin, timeoutMs: 5000 })
assert.equal(t.ok, false)
assert.equal(t.verdict, 'needs-setup', `429 达限应判 needs-setup,实际 ${t.verdict}`)
assert.match(t.setup ?? '', /FLYAI_API_KEY/, 'setup 指引带 FLYAI_API_KEY 配置路径')
assert.match(t.setup ?? '', /flyai\.open\.fliggy\.com/, 'setup 指引带控制台入口')
assert.match(t.setup ?? '', /请勿重试|勿重试|不要重试/, 'setup 明示本会话勿重试')
assert.match(t.error ?? '', /429|Trial limit/i, 'error 保留上游 429 原话')
assert.match(t.evidence, /\[实时API:flyai@error@/, '证据链标注')

await rm(tmp, { recursive: true, force: true })
console.log('FLYAI TESTS: transport/hotel completeness contract OK(离线假 CLI:Sentinel→error / 空 itemList→miss / flight+train+hotel mixed→整体 error 且不落事实 / typed 字段校验 / 完整 flight+train+hotel→hit / exit≠0→error / 429→needs-setup)')
