/**
 * flyai 能力层测试(离线,临时假 CLI 脚本经 cliBin 注入,零网络):
 *  1. Sentinel 限流形状 {"message":"SentinelBlockException..."}——合法 JSON 但无 data.itemList,
 *     曾被 `data?.itemList ?? []` 吞成 0/0 静默 miss(issue #24)→ 应判 error 且保留 sentinel 字样
 *  2. 业务空形状 {"data":{"itemList":[]}} → verdict=miss(0/0,evidence 标注)
 *  3. 业务命中形状 → verdict=hit,选项字段(航班号/时刻/价格)解析
 *  4. exit≠0 → verdict=error
 *
 * 运行: cd ts && npx tsx scripts/flyai-tests.ts
 */

import assert from 'node:assert/strict'
import { writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { flyaiSearch } from '../capabilities/flyai.ts'

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

// 3. 业务命中 → hit,字段解析
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
console.log('3. 业务命中 → hit(9C6617 ¥580)OK')

// 4. exit≠0 → error
const failBin = await fakeCli('flyai-fail', 1, '')
const f = await flyaiSearch({ ...base, cliBin: failBin, timeoutMs: 5000 })
assert.equal(f.ok, false)
assert.equal(f.verdict, 'error', '非零退出应判 error')
console.log('4. 非零退出 → error OK')

await rm(tmp, { recursive: true, force: true })
console.log('FLYAI TESTS: 4/4 OK(离线假 CLI:Sentinel→error / 空 itemList→miss / 命中→hit / exit≠0→error)')
