/**
 * 骨架层集成验证(§7-1 消费面):开 skeletonHub + 带 route 的段 → 结果带三值标注;
 * 枢纽间否定只标注不排除——EK329(数据集滞后的新航线)必须存活。
 * 用户面(issue #559 卡点 4):unscaffolded leg 必须挂 ⚠ 前缀,避免用户读到「正常选择」后才在尾部 skeleton_notes 发现矛盾。
 * 内核冻结面(#234)不可擅动,⚠ 标记由 loop.ts:renderSolve 从 skeleton_notes 字符串编码里推断。
 * 运行(在 ts/ 下):npx tsx scripts/skeleton-integration-test.ts
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseFlightPackToSpec, solveUnified } from '../src/unified.ts'
import { renderSolve, newState } from '../src/loop.ts'

const pack = JSON.parse(await readFile(join('..', 'data', 'flights_2026.json'), 'utf-8'))
const spec = parseFlightPackToSpec(pack)
spec.budgetCny = 9000
spec.skeletonHub = true
spec.segments.forEach(s => { if (s.id === 'f5') s.route = 'SZX->DXB'; if (s.id === 'f1') s.route = 'HKG->HKT' })
const r = await solveUnified(spec)
assert.equal(r.feasible, true, '骨架否定不排除——EK329 必须仍在')
const f5 = r.legs!.find(l => l.leg === 'f5')
assert.equal(f5?.service, 'EK329', 'EK329 存活(骨架滞后容错)')

// §7-1 issue #559 卡点 4:骨架证据不再承诺「降权或中转」——承认骨架滞后,让用户据行程复核
assert.ok((r.skeleton_notes ?? []).some(n => n.includes('SZX') && n.includes('❌')), `枢纽否定标注在: ${r.skeleton_notes}`)
assert.ok((r.skeleton_notes ?? []).some(n => n.includes('HKG') && n.includes('✅')), '正向标注在')
assert.ok(
  !(r.skeleton_notes ?? []).some(n => n.includes('应将此候选降权') || n.includes('要求中转')),
  '骨架证据不再承诺「降权或中转」——承认骨架滞后,让用户据行程复核',
)

// §7-1 issue #559 卡点 4:renderSolve 从 skeleton_notes 推断 unscaffolded leg,
// 给 ⚠ 前缀 + 补充说明,用户读到即知(不动 #234 内核冻结面)
const state = newState()
state.solve = r as unknown as Parameters<typeof renderSolve>[0]['solve']
const rendered = renderSolve(state)
const f5Line = rendered.split('\n').find(line => line.includes('f5') && line.includes('EK329')) ?? ''
assert.ok(f5Line.startsWith('- ⚠'), `f5 EK329 用户面必须有 ⚠ 前缀(实测行=${f5Line})`)
assert.ok(f5Line.includes('枢纽对未在骨架覆盖'), 'f5 用户面行内必须说明「枢纽对未在骨架覆盖」')
const f1Line = rendered.split('\n').find(line => line.includes('f1 ') && line.includes(':') && line.includes('起飞') && !line.startsWith('- ⚠')) ?? ''
assert.ok(f1Line.length > 0, 'f1 HKG↔HKT 正向覆盖的 leg 行必须在(实测查找结果为空)')
assert.ok(!f1Line.startsWith('- ⚠'), `f1 正向覆盖不应有 ⚠ 前缀(实测行=${f1Line})`)

console.log(`骨架集成 OK:EK329 仍存活,用户面 ⚠ 前缀落地;EK329 行=[${f5Line.trim()}]`)