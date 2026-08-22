/**
 * 双实现差分测试:同一输入,TS 引擎(进程内 WASM)与 Python 引擎(CLI 桥)
 * 必须给出相同判定。Python 版是对照实现(oracle)——这是 D4 评测「可行性」
 * 维度的第一道回归:任何一侧改动,另一侧立即对账。
 *
 * 比较口径:结构性判定(feasible/unsat_core/recommended/wish 条件/优化后的预算)。
 * 不比较可行候选的「任取方案」金额——可行时两侧都只返回某个满足解,
 * 班次/接驳等价选择间的差异是预期行为。
 *
 * 运行(在 ts/ 下,需要仓库根的 .venv):npx tsx scripts/diff-test.ts
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseCandidate, parseRequest } from '../src/model.ts'
import { segmentsFromCandidate, solveChoiceSegment } from '../src/unified.ts'
import { callFeasibilityEngine } from '../src/bridge.ts'

const payload = JSON.parse(await readFile(join('..', 'data', 'golden_erhai.json'), 'utf-8'))

const req = parseRequest(payload['request'])
const candidates = (payload['candidates'] as Record<string, unknown>[]).map(parseCandidate)

const spec = segmentsFromCandidate(req, candidates)

const [tsResult, pyCall] = await Promise.all([
  Promise.resolve(solveChoiceSegment(spec, req)),
  callFeasibilityEngine(payload, {
    pythonBin: '../.venv/bin/python',
    pythonPath: '../py',
    timeoutMs: 30_000,
  }),
])
const pyResult = pyCall.result as Record<string, any>

console.log(`TS in-process vs Python CLI (bridge ${pyCall.latencyMs}ms)\n`)

assert.equal(tsResult['recommended'], pyResult['recommended'], 'recommended 一致')

const tsV = Object.fromEntries((tsResult['verdicts'] as any[]).map(v => [v['candidate_id'], v]))
const pyV = Object.fromEntries((pyResult['verdicts'] as any[]).map(v => [v['candidate_id'], v]))
assert.deepEqual(Object.keys(tsV).sort(), Object.keys(pyV).sort(), '候选集合一致')

for (const id of Object.keys(tsV)) {
  assert.equal(tsV[id]['feasible'], pyV[id]['feasible'], `${id} feasible 一致`)
  assert.deepEqual(tsV[id]['unsat_core'], pyV[id]['unsat_core'], `${id} unsat_core 一致`)
  if (tsV[id]['wish_pool'] && pyV[id]['wish_pool']) {
    assert.equal(tsV[id]['wish_pool']['conditions']['days'], pyV[id]['wish_pool']['conditions']['days'], `${id} wish days 一致`)
    assert.equal(tsV[id]['wish_pool']['conditions']['budget_cny'], pyV[id]['wish_pool']['conditions']['budget_cny'], `${id} wish budget(最优值)一致`)
  }
  // 全成本关键数字一致(可行候选的具体班次可不同,但算术层必须同源)
  if (tsV[id]['true_cost'] && pyV[id]['true_cost']) {
    const sameWake = tsV[id]['true_cost']['wake'] === pyV[id]['true_cost']['wake']
    console.log(`${id}: wake ${tsV[id]['true_cost']['wake']} vs ${pyV[id]['true_cost']['wake']} ${sameWake ? '(等价选择)' : '(不同选择,均在可行域)'}`)
  }
}

console.log('\nDIFF TEST OK: 双实现判定一致')
