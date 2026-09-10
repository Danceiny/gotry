/**
 * flyai 能力层测试(离线,临时假 CLI 脚本经 cliBin 注入,零网络):
 *  1. Sentinel 限流形状 {"message":"SentinelBlockException..."}——合法 JSON 但无 data.itemList,
 *     曾被 `data?.itemList ?? []` 吞成 0/0 静默 miss(issue #24)→ 应判 error 且保留 sentinel 字样
 *  2. 业务空形状 {"data":{"itemList":[]}} → verdict=miss(0/0,evidence 标注)
 *  3. 业务命中形状 → verdict=hit,选项字段(航班号/时刻/价格)解析
 *  4. exit≠0 → verdict=error
 *  5. 试用额度达限(exit 1 + MCP HTTP 429 "Trial limit reached",2026-09-02 迪拜
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
import { factsFromFlyai } from '../src/bookable-facts.ts'

const tmp = await mkdtemp(join(tmpdir(), 'flyai-test-'))
async function fakeCli(name: string, code: number, payload: string): Promise<string> {
  const p = join(tmp, name)
  await writeFile(p, `#!/bin/sh\necho '${payload}'\nexit ${code}\n`, { mode: 0o755 })
  return p
}

const base = { kind: 'flight' as const, origin: '上海', destination: '丽江', depDate: '2026-10-01' }

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
const registeredFlyai = makeProductionInterpreter({ breakers: new Map(), sleep: async () => {} })
const malformedObservation = await registeredFlyai({
  effect: 'FLYAI_SEARCH',
  params: { ...base, cliBin: malformedBin, timeoutMs: 5000 },
})
const malformed = malformedObservation.result as Awaited<ReturnType<typeof flyaiSearch>>
assert.ok(malformedObservation.result, 'registered FlyAI effect 应返回结构化 observation')
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

// 4. 业务命中 → hit,字段解析
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
const hitBin = await fakeCli('flyai-hit', 0, hitPayload)
const h = await flyaiSearch({ ...base, cliBin: hitBin, timeoutMs: 5000 })
assert.equal(h.verdict, 'hit', `业务条目应判 hit,实际 ${h.verdict}`)
assert.equal(h.options?.length, 1, '1 个选项')
assert.equal(h.options![0]!.no, '9C6617')
assert.equal(h.options![0]!.price, 580, '价格数值解析')
assert.equal(h.options![0]!.depStation, '浦东T2')
assert.match(h.evidence, /1\/1 flight options/, 'hit 证据链 1/1')
console.log('4. 业务命中 → hit(9C6617 ¥580)OK')

// 5. 有效 typed sibling + malformed sibling → 保留 hit,证据暴露 1/2
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
const mixed = await flyaiSearch({ ...base, cliBin: mixedBin, timeoutMs: 5000 })
assert.equal(mixed.ok, true, '存在有效 typed sibling 时应保持成功')
assert.equal(mixed.verdict, 'hit', '存在有效 typed sibling 时应保持 hit')
assert.equal(mixed.options?.length, 1, '混合响应只产出 1 个有效选项')
assert.match(mixed.evidence, /1\/2 flight options/, '混合响应证据应暴露有效/原始条目比例')
console.log('5. 混合响应 → 保留 hit 且证据 1/2 OK')

// 6. exit≠0 → error
const failBin = await fakeCli('flyai-fail', 1, '')
const f = await flyaiSearch({ ...base, cliBin: failBin, timeoutMs: 5000 })
assert.equal(f.ok, false)
assert.equal(f.verdict, 'error', '非零退出应判 error')
console.log('6. 非零退出 → error OK')

// 7. 试用额度达限(2026-09-02 迪拜 session 实况:exit 1 + MCP HTTP 429 Trial limit
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
console.log('FLYAI TESTS: 7/7 OK(离线假 CLI:Sentinel→error / 空 itemList→miss / 全 malformed→registered error 且不落负事实 / 命中→hit / 混合→hit 且证据 1/2 / exit≠0→error / 429 达限→needs-setup)')
