/**
 * TS 统一求解器断言(镜像 py test_unified 的航班链部分 + D-2 回归)。
 * 运行(在 ts/ 下):npx tsx scripts/unified-tests.ts
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseFlightPackToSpec, solveUnified } from '../src/unified.ts'
import { hhmmToMin } from '../src/model.ts'

const pack = JSON.parse(await readFile(join('..', 'data', 'flights_2026.json'), 'utf-8'))

// 1. 航班包经统一模型求解:可行、区间正确、负例排除、红眼精力
const spec = parseFlightPackToSpec(pack)
spec.budgetCny = 9000
const r1 = await solveUnified(spec)
assert.equal(r1.feasible, true)
assert.ok(7680 <= r1.money_cny! && r1.money_cny! <= 8550, `money=${r1.money_cny}`)
const byLeg = Object.fromEntries(r1.legs!.map(l => [l.leg, l]))
assert.notEqual(byLeg['f4'].service, 'DZ6252')       // 负例被锚点排除
assert.equal(byLeg['f5'].service, 'EK329')
assert.equal(byLeg['f5'].energy_pct, 75)              // 红眼睡眠模型
assert.ok(byLeg['f5'].wake.includes('前一日'))         // 跨日显示

// D-5 时区感知核算(与 Python oracle 同款断言)
assert.equal(byLeg['f5'].door_to_door, '11h20m')      // 3h 前置 + 7h35m 真实飞行 + 45m 接驳
if (byLeg['f3'].service === 'MU6088') {
  assert.equal(byLeg['f3'].door_to_door, '6h15m')     // +1h 时差已扣
}

// 2. D-2 回归:锚点冲突时 core 字符串不带竖线,精确点名
const tight = parseFlightPackToSpec(pack)
tight.segments[0].anchors!.arriveByMin = hhmmToMin('15:00')
const r2 = await solveUnified(tight)
assert.equal(r2.feasible, false)
assert.ok(r2.unsat_core!.includes('f1:arrive_by'), `core=${JSON.stringify(r2.unsat_core)}`)
assert.ok(r2.unsat_core!.every(c => !c.includes('|')), 'core 无竖线残留')
assert.ok(r2.suggestions!.some(sg => sg.relax === 'f1:arrive_by'))

// 3. 预算冲突 core 命名
const poor = parseFlightPackToSpec(pack)
poor.budgetCny = 1000
const r3 = await solveUnified(poor)
assert.equal(r3.feasible, false)
assert.ok(r3.unsat_core!.includes('total:budget'))

// 4. M-1:工作窗口排除周五晚班,gate q3 被确定性回答(与 Python oracle 同款)
const excluded = r1.work_window_exclusions ?? []
assert.ok(excluded.some(e => e.segment === 'f2' && e.option === 'TG216'), JSON.stringify(excluded))
assert.ok(excluded.some(e => e.segment === 'f2' && e.option === 'TG218'))
assert.equal(byLeg['f2'].service, 'VZ303')  // 只剩周六早班——与真实选择一致
const off = parseFlightPackToSpec(pack)
off.budgetCny = 9000
off.workWindow = undefined
const r4 = await solveUnified(off)
assert.deepEqual(r4.work_window_exclusions, [])  // 关掉窗口,周五班恢复可选

console.log(`TS UNIFIED TESTS: 4/4 OK(工作窗口生效,f2=VZ303,¥${r1.money_cny})`)
