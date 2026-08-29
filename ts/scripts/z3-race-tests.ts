/**
 * Z3 WASM race 回归(README Known limitations 根治项):
 * 三形态(engine 候选 / journey 航班链 / unified)在单进程内并发求解 × 12 轮。
 * 修复前形态:engine.solve 的 Promise.all 多候选并发 + 三模块各自 init() 的
 * WASM 实例并存 → z3 async 会话交错偶发 `memory access out of bounds`
 * (run-all §1 重试止血与 release-notes rc.2-rc.4 的实录根因)。
 * 修复(z3-shared.ts):单一 WASM 实例 + 单一 Context + 会话级互斥门。
 *
 * 断言:① 并发轮次无 unified WASM 降级(wasm_runtime_error);② 判定与顺序基线一致。
 * 运行(在 ts/ 下):npx tsx scripts/z3-race-tests.ts
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { solve } from '../src/engine.ts'
import { solveJourney, parseFlightPackLegs } from '../src/journey.ts'
import { parseFlightPackToSpec, solveUnified } from '../src/unified.ts'
import { parseCandidate, parseRequest } from '../src/model.ts'

const erhai = JSON.parse(await readFile(join('..', 'data', 'golden_erhai.json'), 'utf-8'))
const pack = JSON.parse(await readFile(join('..', 'data', 'flights_2026.json'), 'utf-8'))

const req = parseRequest(erhai['request'])
const candidates = (erhai['candidates'] as Record<string, unknown>[]).map(parseCandidate)
const legs = parseFlightPackLegs(pack)

// 顺序基线(同时预热 WASM 实例)
const baseEngine = await solve(req, candidates) as Record<string, unknown>
const baseJourney = await solveJourney({ legs })

const ROUNDS = 12
for (let round = 0; round < ROUNDS; round++) {
  const [eng, jny, uni] = await Promise.all([
    solve(req, candidates),
    solveJourney({ legs }),
    solveUnified(parseFlightPackToSpec(pack)),
  ]) as [Record<string, unknown>, Awaited<ReturnType<typeof solveJourney>>, Awaited<ReturnType<typeof solveUnified>>]

  void jny
  assert.equal(eng['recommended'], baseEngine['recommended'], `r${round}: engine recommended 漂移`)
  assert.equal(jny['feasible'], baseJourney['feasible'], `r${round}: journey feasible 漂移`)
  assert.equal((uni['unsat_core'] ?? []).includes('wasm_runtime_error'), false, `r${round}: unified 会话触发 WASM 降级——race 复发`)
  assert.equal(uni['feasible'], true, `r${round}: unified 判定漂移(基线应为可行)`)
}

console.log(`Z3 RACE TESTS OK(进程内三形态并发 ×${ROUNDS}:判定与顺序基线一致,零 WASM 降级)`)