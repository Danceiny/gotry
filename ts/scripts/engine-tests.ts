/**
 * TS 引擎金标准断言(与 py/tests/test_engine.py 同一套洱海用例)。
 * 运行(在 ts/ 下):npx tsx scripts/engine-tests.ts
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseCandidate, parseRequest, requiredUsableHours } from '../src/model.ts'
import { solve, solveCandidate } from '../src/engine.ts'

const payload = JSON.parse(await readFile(join('..', 'data', 'golden_erhai.json'), 'utf-8'))
const req = parseRequest(payload['request'])
const candidates = (payload['candidates'] as Record<string, unknown>[]).map(parseCandidate)
const result = await solve(req, candidates) as {
  recommended: string | null
  answer_md: string
  verdicts: Array<Record<string, any>>
}
const verdicts = Object.fromEntries(result.verdicts.map(v => [v['candidate_id'], v]))

// 1. 洱海在周末窗口不可行,unsat core 必须点名 duration
assert.equal(verdicts['dali']['feasible'], false)
assert.ok(verdicts['dali']['unsat_core'].includes('duration'))

// 2. 憧憬不被拒绝:进 wish pool,带成行条件
const wp = verdicts['dali']['wish_pool']
assert.ok(wp, 'dali wish pool exists')
assert.ok(wp['conditions']['days'] >= 5)
assert.ok('budget_cny' in wp['conditions'])
assert.ok(wp['conditions']['best_months'].length > 0)

// 3. 最小修改建议必须写明代价
assert.ok(verdicts['dali']['suggestions'].length > 0)
assert.ok(verdicts['dali']['suggestions'].some((s: any) => s['text'].includes('天')))

// 4. 千岛湖可行且被推荐
assert.equal(verdicts['qiandao']['feasible'], true)
assert.equal(result.recommended, 'qiandao')

// 5. 全成本六要素齐全
const t = verdicts['qiandao']['true_cost']
assert.ok(t['money_cny'] <= 3000)
assert.ok(Number(String(t['wake']).replace(':', '')) >= 630)
assert.ok(t['energy_arrival_pct'] >= 40)
assert.ok(t['usable_hours'] >= requiredUsableHours(req.motivation))

// 6. 太湖也可行且更便宜(同一可行口径内)
assert.equal(verdicts['taihu']['feasible'], true)
assert.ok(verdicts['taihu']['true_cost']['money_cny'] <= verdicts['qiandao']['true_cost']['money_cny'])

// 7. 回答不空手而归
assert.ok(result.answer_md.includes('千岛湖'))
assert.ok(result.answer_md.includes('下一次出发'))
assert.ok(result.answer_md.includes('待你决定的两个问题'))

// 8. 预算差一口气的场景:报告差额而非拒绝
const tight = structuredClone(payload)
tight['request']['budget_cny'] = 900
const tightReq = parseRequest(tight['request'])
const v = await solveCandidate(candidates.find(c => c.id === 'qiandao')!, tightReq)
assert.equal(v.feasible, false)
assert.ok(v.unsatCore.includes('budget'))
assert.ok(v.suggestions.some(s => s.text.includes('预算提高到')))

console.log('TS ENGINE TESTS: 8/8 OK')
