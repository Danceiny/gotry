/**
 * 时间窗衰减单测(memory-design P3):分级窗口/单调/地板 0.1/上界 1/动机零衰减。
 * 运行:cd ts && npx tsx scripts/memory-decay-tests.ts
 */

import assert from 'node:assert/strict'
import { decayedConfidence, eventDecayScore, windowFactor } from '../src/memory-decay.ts'

const NOW = new Date(2026, 7, 28, 12)
let n = 0
function pass(name: string, body: () => void) {
  body()
  console.log(`  ${++n}. ${name} OK`)
}

pass('分级窗口:边界值与地板', () => {
  assert.equal(windowFactor(0), 1.0)
  assert.equal(windowFactor(30), 1.0)
  assert.equal(windowFactor(31), 0.75)
  assert.equal(windowFactor(90), 0.75)
  assert.equal(windowFactor(91), 0.5)
  assert.equal(windowFactor(180), 0.5)
  assert.equal(windowFactor(181), 0.25)
  assert.equal(windowFactor(365), 0.25)
  assert.equal(windowFactor(366), 0.1)
  assert.equal(windowFactor(3000), 0.1, '地板 0.1:旧而不灭')
})

pass('种类权重:verified > applied > recalled(自称被召回 ≠ 有用)', () => {
  const ts = '2026-08-27T00:00:00Z'
  assert.ok(eventDecayScore({ ts, kind: 'verified_outcome' }, NOW) > eventDecayScore({ ts, kind: 'applied' }, NOW))
  assert.ok(eventDecayScore({ ts, kind: 'applied' }, NOW) > eventDecayScore({ ts, kind: 'recalled' }, NOW))
})

pass('单调:同种类,新事件分 ≥ 旧事件分', () => {
  const fresh = eventDecayScore({ ts: '2026-08-27T00:00:00Z', kind: 'recalled' }, NOW)
  const old = eventDecayScore({ ts: '2025-01-01T00:00:00Z', kind: 'recalled' }, NOW)
  assert.ok(fresh >= old)
  assert.equal(old, 0.025, '地板乘子=0.25×0.1(一年外)')
})

pass('置信度上界 1 且多事件累加有界', () => {
  const many = Array.from({ length: 50 }, () => ({ ts: '2026-08-27T00:00:00Z', kind: 'verified_outcome' as const }))
  assert.equal(decayedConfidence(many, NOW), 1)
  const one = decayedConfidence([{ ts: '2026-08-27T00:00:00Z', kind: 'verified_outcome' }], NOW)
  assert.ok(one > 0 && one <= 1)
})

pass('动机层零衰减(构造性):本模块无作用于 motivation-profile 的 API,权重原样透传', () => {
  const weights = { escape_rest: 0.4, curiosity: 0.09 }
  const snapshot = JSON.stringify(weights)
  // 衰减只吃事件列表;画像对象不在任何签名里——断言其不可被本模块触碰
  void decayedConfidence([{ ts: '2020-01-01T00:00:00Z', kind: 'recalled' }], NOW)
  assert.equal(JSON.stringify(weights), snapshot)
})

console.log(`\nMEMORY DECAY TESTS: ${n}/5 OK(memory-design P3 分级窗口/单调/地板/上界/动机零衰减)`)
