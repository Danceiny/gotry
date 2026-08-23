/**
 * opensky 能力层测试(免费匿名 API):
 *  1. 真实航班号(可能不是当前在飞)→ 命中时 observed,查空时 not_observed(三值语义)
 *  2. 完全不在飞的小众号 → not_observed
 *  3. 网络超时 → unavailable(降级不抛错)
 *  4. 证据链:各 verdict 正确标注
 *
 * 注:OpenSky 当前 ADS-B 全球观测并非同一时间覆盖所有航班——EK329 一天
 * 飞数十次但中间有「不在飞」的窗口。所以验 not_observed 也是有效路径。
 *
 * 运行: cd ts && npx tsx scripts/opensky-tests.ts
 */

import assert from 'node:assert/strict'
import { verifyFlight } from '../capabilities/opensky.ts'

// 1. 真实航班号 + 明确目的地机场(机场能筛掉部分不命中)
// EK329 是 LHR-DXB 路径。观察时段不命中时 verdict='not_observed',不是错误。
const live = await verifyFlight({ callsign: 'EK329', airport: 'OMDB' })
assert.ok(live.sampleSize >= 0, 'sampleSize ≥ 0(空数组也合法)')
assert.ok(['observed', 'not_observed', 'unavailable'].includes(live.verdict), `verdict 三值之一:${live.verdict}`)
if (live.verdict === 'observed') {
  assert.ok((live.hits?.length ?? 0) > 0, 'observed 必须配 hits')
  const h = live.hits![0]!
  assert.ok(typeof h.icao24 === 'string' && h.icao24.length > 0, 'icao24 存在')
  assert.match(live.evidence, /\[实时API:opensky@/, '证据链标注')
  console.log(`1. EK329 OMDB → ${live.verdict} (sample=${live.sampleSize}, hits=${live.hits?.length}) OK`)
} else if (live.verdict === 'not_observed') {
  assert.match(live.evidence, /○|not_observed|未见/, 'not_observed 标注 ○')
  console.log(`1. EK329 OMDB → not_observed 当前观测窗没飞 (o) OK`)
} else {
  // unavailable = API 限流/不可达,失败也合法
  assert.match(live.evidence, /error/, 'unavailable 标注 error')
  console.log(`1. EK329 OMDB → unavailable (API 异常,降级合法) OK`)
}

// 2. 完全不存在的航班号 → not_observed 或 unavailable(API 限流 429 时走 unavailable)
const fake = await verifyFlight({ callsign: 'XXDODO1234', airport: 'OMDB' })
assert.ok(['not_observed', 'unavailable'].includes(fake.verdict), `期望 not_observed/unavailable,实际 ${fake.verdict}`)
if (fake.verdict === 'not_observed') {
  assert.match(fake.evidence, /○/, 'not_observed 标 ○')
  console.log('2. XXDODO1234 OMDB → not_observed (○) OK')
} else {
  console.log('2. XXDODO1234 OMDB → unavailable (API 限流 OK) OK')
}

// 3. 网络超时 → unavailable
import { verifyFlight as vf } from '../capabilities/opensky.ts'
const to = await vf({ callsign: 'EK329', airport: 'OMDB', timeoutMs: 1 })
assert.equal(to.verdict, 'unavailable', `timeout 应 unavailable,实际 ${to.verdict}`)
assert.match(to.evidence, /error/, 'unavailable 证据带 error')
console.log('3. timeout → unavailable OK')

console.log('\nOPEN-SKY TESTS: 3/3 OK(免费匿名 OpenSky API)')
