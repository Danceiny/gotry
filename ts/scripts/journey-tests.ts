/**
 * TS multi-leg 引擎断言(镜像 py/tests/test_journey.py 的 5 条)。
 * 运行(在 ts/ 下):npx tsx scripts/journey-tests.ts
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { solveJourney, parseFlightPackLegs } from '../src/journey.ts'
import { hhmmToMin } from '../src/model.ts'

const pack = JSON.parse(await readFile(join('..', 'data', 'flights_2026.json'), 'utf-8'))
const legs = parseFlightPackLegs(pack)

// 1. 五段全链可行且锚点全过(真实数据包)。可行解在等价班次间任取
//    (两侧求解器取解顺序不同),故断言内部一致性与有效解区间,不断言具体金额。
const r1 = await solveJourney({ legs, budgetCny: 9000 })
assert.equal(r1.feasible, true)
assert.equal(r1.money_cny, r1.legs!.reduce((a, l) => a + l.price_cny, 0))
assert.ok(r1.money_cny! >= 8380 && r1.money_cny! <= 8550, `有效解区间: ${r1.money_cny}`)

// 2. 红眼段:EK329 落地精力 75%,跨日起床显示「前一日」
const f5 = r1.legs!.find(l => l.service === 'EK329')!
assert.equal(f5.energy_pct, 75)
assert.ok(f5.wake.includes('前一日'), `wake 跨日显示: ${f5.wake}`)

// 3. 负例防护:深夜班 DZ6252 被排除(f4 应选 MU5233 或 ZH9108)
const f4 = r1.legs!.find(l => ['MU5233', 'ZH9108'].includes(l.service))
assert.ok(f4, 'f4 选择了白天班,深夜班被 arrive_by 锚点排除')

// 4. 锚点冲突:把 f1 的到达锚点收紧到不可能 → core 点名 f1:arrive_by 并给放宽方案
const tight = legs.map(l => l.id === 'f1' ? { ...l, arriveByMin: hhmmToMin('15:00') } : l)
const r2 = await solveJourney({ legs: tight })
assert.equal(r2.feasible, false)
assert.ok(r2.unsat_core!.includes('f1:arrive_by'))
assert.ok(r2.suggestions!.some(sg => sg.relax === 'f1:arrive_by'))

// 5. 预算冲突:core 点名 total:budget
const r3 = await solveJourney({ legs, budgetCny: 1000 })
assert.equal(r3.feasible, false)
assert.ok(r3.unsat_core!.includes('total:budget'))
assert.ok(r3.suggestions!.some(sg => sg.relax === 'total:budget'))

console.log(`TS JOURNEY TESTS: 5/5 OK(五段全链可行,¥${r1.money_cny},与 Python oracle 结构一致)`)
