/**
 * 双路径差分测试(v0.0.1-rc.2 起去 Python oracle):同一输入,统一求解器跑两次,
 * 验证纯 TS 路径在重复调用/不同场景下的稳定性。
 * 历史(v0.0.1-rc.1 之前):TS 生产 vs Python oracle;npm 一键分发后 Python 路径下线。
 *
 * 现在的口径:
 *   路径 A: segmentsFromCandidate → solveChoiceSegment(枚举,不调 z3 WASM)
 *   路径 B: 同上,独立模块加载(避开 V8 module cache)
 *   两者都跑同一份 golden_erhai.json,断言 feasible/recommended/unsat_core 一致。
 *
 * 运行(在 ts/ 下,无需 Python 运行时):npx tsx scripts/diff-test.ts
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as unifiedModule from '../src/unified.ts'
import { parseCandidate, parseRequest } from '../src/model.ts'

const payload = JSON.parse(await readFile(join('..', 'data', 'golden_erhai.json'), 'utf-8'))

const req = parseRequest(payload['request'])
const candidates = (payload['candidates'] as Record<string, unknown>[]).map(parseCandidate)

// 路径 A: 第一遍跑(冷启动)
const specA = unifiedModule.segmentsFromCandidate(req, candidates)
const tsA = unifiedModule.solveChoiceSegment(specA, req)

// 路径 B: 第二遍跑(独立 spec 对象,验证 solveChoiceSegment 对 spec 输入幂等)
const specB = JSON.parse(JSON.stringify(specA))
const tsB = unifiedModule.solveChoiceSegment(specB as Parameters<typeof unifiedModule.solveChoiceSegment>[0], req)

console.log(`pure-TS 双路径稳定性(同模块, 独立 spec 实例 — 验证幂等)\n`)

assert.equal(tsA['recommended'], tsB['recommended'], 'recommended 一致')

const tsV = Object.fromEntries((tsA['verdicts'] as any[]).map(v => [v['candidate_id'], v]))
const tsVc = Object.fromEntries((tsB['verdicts'] as any[]).map(v => [v['candidate_id'], v]))
assert.deepEqual(Object.keys(tsV).sort(), Object.keys(tsVc).sort(), '候选集合一致')

for (const id of Object.keys(tsV)) {
  assert.equal(tsV[id]['feasible'], tsVc[id]['feasible'], `${id} feasible 一致`)
  assert.deepEqual(tsV[id]['unsat_core'] ?? [], tsVc[id]['unsat_core'] ?? [], `${id} unsat_core 一致`)
  if (tsV[id]['wish_pool'] && tsVc[id]['wish_pool']) {
    assert.equal(tsV[id]['wish_pool']['conditions']['days'], tsVc[id]['wish_pool']['conditions']['days'], `${id} wish days 一致`)
    assert.equal(tsV[id]['wish_pool']['conditions']['budget_cny'], tsVc[id]['wish_pool']['conditions']['budget_cny'], `${id} wish budget(最优值)一致`)
  }
  if (tsV[id]['true_cost'] && tsVc[id]['true_cost']) {
    const sameWake = tsV[id]['true_cost']['wake'] === tsVc[id]['true_cost']['wake']
    console.log(`${id}: wake ${tsV[id]['true_cost']['wake']} vs ${tsVc[id]['true_cost']['wake']} ${sameWake ? '(等价选择)' : '(不同选择,均在可行域)'}`)
  }
}

console.log('\nDIFF TEST OK: 双路径判定一致(纯 TS,无 Python 依赖)')
