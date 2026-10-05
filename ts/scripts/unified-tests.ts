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
// 工作窗口生效后 f2 被迫选 VZ303(¥350),有效组合区间下移(M-1 后重算)
assert.equal(r1.money_cny, r1.legs!.reduce((a, l) => a + l.price_cny, 0))
assert.ok(7280 <= r1.money_cny! && r1.money_cny! <= 8350, `money=${r1.money_cny}`)
const byLeg = Object.fromEntries(r1.legs!.map(l => [l.leg, l]))
assert.notEqual(byLeg['f4'].service, 'DZ6252')       // 负例被锚点排除
assert.equal(byLeg['f5'].service, 'EK329')
assert.equal(byLeg['f5'].energy_pct, 79)              // 红眼睡眠模型(D-6 校准:机上 75 + 落地接驳 45min×5%/h≈+4 → 79;上限 80)
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

// 5. Issue #620:yunnan-pack 的 yn0 段缺 buffer_min/origin_transfer_min/dest_transfer_min
//    → 旧实现 Number(undefined)=NaN → Int.val(NaN) 在 z3 WASM 里 `Assertion failed`
//    → 被兜底翻译成「不可行 + unsat_core:['wasm_runtime_error']」。三条红线:
//    ① parse 边界必须点名拒收(不默认补 0);② 绕过 parse 的 NaN spec 必须以
//    solver_error 返回而**绝不**是 infeasible;③ 补齐那三个字段后整包必须真能判定。
const yunnanRaw = JSON.parse(await readFile(join('..', 'data', 'yunnan-pack.json'), 'utf-8'))

// ① 真实数据包:yn0 的三个缺字段 → NaN → 必须是显式 solver_error,绝不是「不可行」
const yunnanSpecRaw = parseFlightPackToSpec(structuredClone(yunnanRaw))
yunnanSpecRaw.budgetCny = 9000
assert.ok(Number.isNaN(yunnanSpecRaw.segments[0].options[0].move!.bufferMin), 'yn0 缺 buffer_min 的事实前提')
const rYunnanRaw = await solveUnified(yunnanSpecRaw)
assert.equal(rYunnanRaw.solver_error?.code, 'solver_input_not_integer', `yunnan 包必须以 solver_error 返回(got ${JSON.stringify(rYunnanRaw)})`)
assert.ok(rYunnanRaw.solver_error!.message.includes('yn0.bufferMin'), `solver_error 必须点名出问题的段与字段(got ${rYunnanRaw.solver_error!.message})`)
assert.equal(rYunnanRaw.feasible, false, 'solver_error 轮次没有产出可行解')
assert.deepEqual(rYunnanRaw.unsat_core, undefined, '求解器失败不得伪造 unsat_core(机器 token 不进冲突位)')
assert.ok(!JSON.stringify(rYunnanRaw).includes('wasm_runtime_error'), '不得再出现 wasm_runtime_error 这个伪冲突 token')

// ② 最小输入:健康包里塞一个 NaN 接驳分钟 → 同样是 solver_error,点名到字段
const nanSpec = parseFlightPackToSpec(pack)
nanSpec.budgetCny = 9000
nanSpec.segments[0].options[0].move!.bufferMin = Number.NaN
const rNan = await solveUnified(nanSpec)
assert.equal(rNan.solver_error?.code, 'solver_input_not_integer', `NaN 接驳必须以 solver_error 返回(got ${JSON.stringify(rNan)})`)
assert.ok(rNan.solver_error!.message.includes('f1.bufferMin'), `solver_error 必须点名字段(got ${rNan.solver_error!.message})`)
assert.equal(rNan.feasible, false, 'solver_error 轮次没有产出可行解')

// ③ 补齐 yn0 的三个字段(由测试提供,不改数据包:真值待 founder 校准)→ 整包真能判定,
//    证明断言失败的最小输入正是这三个字段,其余四段编码本身没问题
const yunnanFixed = structuredClone(yunnanRaw)
Object.assign((yunnanFixed['legs'] as Array<Record<string, unknown>>)[0], {
  buffer_min: 60, origin_transfer_min: 30, dest_transfer_min: 30,
})
const yunnanSpec = parseFlightPackToSpec(yunnanFixed)
yunnanSpec.budgetCny = 9000
const rYunnan = await solveUnified(yunnanSpec)
assert.equal(rYunnan.solver_error, undefined, `补齐三字段后不得再有求解器失败(got ${JSON.stringify(rYunnan.solver_error)})`)
assert.equal(rYunnan.feasible, true, `yunnan 整包应可行(unsat_core=${JSON.stringify(rYunnan.unsat_core)})`)
assert.equal(rYunnan.legs!.length, 5, '五段全判定')

console.log(`TS UNIFIED TESTS: 5/5 OK(工作窗口生效,f2=VZ303,¥${r1.money_cny};#620 yunnan NaN→solver_error 点名 yn0,补齐三字段后可行 ¥${rYunnan.money_cny})`)
