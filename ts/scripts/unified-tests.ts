/**
 * TS 统一求解器断言(镜像 py test_unified 的航班链部分 + D-2 回归)。
 * 运行(在 ts/ 下):npx tsx scripts/unified-tests.ts
 */

import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
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

// 5. Issue #620 / #635:云南包的 yn0 衔接段缺 buffer_min/origin_transfer_min/dest_transfer_min
//    → 旧实现 Number(undefined)=NaN → Int.val(NaN) 在 z3 WASM 里 `Assertion failed`
//    → 被兜底翻译成「不可行 + unsat_core:['wasm_runtime_error']」。五条红线:
//    ① 出厂数据包里挂接引擎的每一段(`legs`)三字段必须是非负整数;缺真值的段只能记在
//       `advisory_legs`(带理由、不挂接)——替它填数等于编造真实世界的事实(ADR-10);
//    ② 出厂云南包整包可判定,yn0 不进求解(founder 2026-10-05 选「标 advisory」);
//    ③ 防线仍在:缺字段的包(由测试构造)必须以 solver_error 返回而**绝不**是 infeasible;
//    ④ 最小输入:健康包里塞一个 NaN 接驳分钟 → 同样是 solver_error;
//    ⑤ 晋升路径:founder 给出三个真值后,把 advisory 段搬回 legs 即可整包判定。
const DATA_DIR = join('..', 'data')
const TRANSFER_FIELDS = ['buffer_min', 'origin_transfer_min', 'dest_transfer_min'] as const
const yunnanRaw = JSON.parse(await readFile(join(DATA_DIR, 'yunnan-pack.json'), 'utf-8'))

// ① 数据完整性:data/ 下每个带 legs 的包,挂接引擎的段三字段齐全;advisory 段自带理由且不与 legs 重名
let auditedPacks = 0
for (const file of (await readdir(DATA_DIR)).filter(f => f.endsWith('.json')).sort()) {
  const raw = JSON.parse(await readFile(join(DATA_DIR, file), 'utf-8')) as Record<string, unknown>
  if (!Array.isArray(raw['legs'])) continue
  auditedPacks += 1
  const legs = raw['legs'] as Array<Record<string, unknown>>
  for (const leg of legs) {
    for (const field of TRANSFER_FIELDS) {
      const value = leg[field]
      assert.ok(typeof value === 'number' && Number.isInteger(value) && value >= 0,
        `${file}: leg ${String(leg['id'])}.${field} 必须是非负整数(got ${JSON.stringify(value)});缺真值的段请放进 advisory_legs,不要补编造值(issue #635)`)
    }
  }
  const engineIds = new Set(legs.map(leg => String(leg['id'])))
  for (const advisory of (raw['advisory_legs'] ?? []) as Array<Record<string, unknown>>) {
    const reason = advisory['advisory_reason']
    assert.ok(typeof reason === 'string' && reason.trim() !== '', `${file}: advisory 段 ${String(advisory['id'])} 必须写明 advisory_reason`)
    assert.ok(!engineIds.has(String(advisory['id'])), `${file}: ${String(advisory['id'])} 不能同时在 legs 与 advisory_legs`)
  }
}
assert.ok(auditedPacks >= 2, `数据完整性审计应覆盖航班包与云南包(审计了 ${auditedPacks} 个)`)

// ② 出厂云南包按产品同款路径整包可判定;advisory 段 yn0 不进引擎段链,也不参与求解
const yunnanSpec = parseFlightPackToSpec(structuredClone(yunnanRaw))
assert.deepEqual(yunnanSpec.segments.map(s => s.id), ['yn1', 'yn2', 'yn3', 'yn4'], 'advisory 段 yn0 不得进引擎段链')
yunnanSpec.budgetCny = 9000
const rYunnan = await solveUnified(yunnanSpec)
assert.equal(rYunnan.solver_error, undefined, `出厂云南包不得再有求解器失败(got ${JSON.stringify(rYunnan.solver_error)})`)
assert.equal(rYunnan.feasible, true, `出厂云南包应可行(unsat_core=${JSON.stringify(rYunnan.unsat_core)})`)
assert.deepEqual(rYunnan.legs!.map(l => l.leg), ['yn1', 'yn2', 'yn3', 'yn4'], '四段全判定,yn0 不在其中')

// ③ 防线仍在:缺三个字段的包(由测试从出厂包构造)→ NaN → 必须是显式 solver_error,绝不是「不可行」
const yunnanGap = structuredClone(yunnanRaw)
for (const field of TRANSFER_FIELDS) delete (yunnanGap['legs'] as Array<Record<string, unknown>>)[0][field]
const yunnanGapSpec = parseFlightPackToSpec(yunnanGap)
yunnanGapSpec.budgetCny = 9000
assert.ok(Number.isNaN(yunnanGapSpec.segments[0].options[0].move!.bufferMin), '缺 buffer_min 的事实前提')
const rYunnanGap = await solveUnified(yunnanGapSpec)
assert.equal(rYunnanGap.solver_error?.code, 'solver_input_not_integer', `缺字段的包必须以 solver_error 返回(got ${JSON.stringify(rYunnanGap)})`)
assert.ok(rYunnanGap.solver_error!.message.includes('yn1.bufferMin'), `solver_error 必须点名出问题的段与字段(got ${rYunnanGap.solver_error!.message})`)
assert.equal(rYunnanGap.feasible, false, 'solver_error 轮次没有产出可行解')
assert.deepEqual(rYunnanGap.unsat_core, undefined, '求解器失败不得伪造 unsat_core(机器 token 不进冲突位)')
assert.ok(!JSON.stringify(rYunnanGap).includes('wasm_runtime_error'), '不得再出现 wasm_runtime_error 这个伪冲突 token')

// ④ 最小输入:健康包里塞一个 NaN 接驳分钟 → 同样是 solver_error,点名到字段
const nanSpec = parseFlightPackToSpec(pack)
nanSpec.budgetCny = 9000
nanSpec.segments[0].options[0].move!.bufferMin = Number.NaN
const rNan = await solveUnified(nanSpec)
assert.equal(rNan.solver_error?.code, 'solver_input_not_integer', `NaN 接驳必须以 solver_error 返回(got ${JSON.stringify(rNan)})`)
assert.ok(rNan.solver_error!.message.includes('f1.bufferMin'), `solver_error 必须点名字段(got ${rNan.solver_error!.message})`)
assert.equal(rNan.feasible, false, 'solver_error 轮次没有产出可行解')

// ⑤ 晋升路径:三个真值由测试提供(数据包里不写——真值待 founder 校准),把 advisory 段搬回 legs 的头部
//    → 五段全判定,证明「补齐三个整数」正是 yn0 从 advisory 晋升所需的全部
const yunnanPromoted = structuredClone(yunnanRaw)
const [promotedYn0] = yunnanPromoted['advisory_legs'] as Array<Record<string, unknown>>
delete promotedYn0['advisory_reason']
Object.assign(promotedYn0, { buffer_min: 60, origin_transfer_min: 30, dest_transfer_min: 30 })
yunnanPromoted['legs'] = [promotedYn0, ...(yunnanPromoted['legs'] as unknown[])]
delete yunnanPromoted['advisory_legs']
const promotedSpec = parseFlightPackToSpec(yunnanPromoted)
promotedSpec.budgetCny = 9000
const rPromoted = await solveUnified(promotedSpec)
assert.equal(rPromoted.solver_error, undefined, `补齐三字段后不得再有求解器失败(got ${JSON.stringify(rPromoted.solver_error)})`)
assert.equal(rPromoted.feasible, true, `晋升后的云南包应可行(unsat_core=${JSON.stringify(rPromoted.unsat_core)})`)
assert.equal(rPromoted.legs!.length, 5, '晋升后五段全判定')

console.log(`TS UNIFIED TESTS: 5/5 OK(工作窗口生效,f2=VZ303,¥${r1.money_cny};#620/#635 ${auditedPacks} 个包三字段齐全,出厂云南包四段可行,缺字段→solver_error 点名 yn1,晋升后五段可行)`)
