/**
 * 骨架层集成验证(§7-1 消费面):开 skeletonHub + 带 route 的段 → 结果带三值标注;
 * 枢纽间否定只标注不排除——EK329(数据集滞后的新航线)必须存活。
 * 运行(在 ts/ 下):npx tsx scripts/skeleton-integration-test.ts
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseFlightPackToSpec, solveUnified } from '../src/unified.ts'

const pack = JSON.parse(await readFile(join('..', 'data', 'flights_2026.json'), 'utf-8'))
const spec = parseFlightPackToSpec(pack)
spec.budgetCny = 9000
spec.skeletonHub = true
spec.segments.forEach(s => { if (s.id === 'f5') s.route = 'SZX->DXB'; if (s.id === 'f1') s.route = 'HKG->HKT' })
const r = await solveUnified(spec)
assert.equal(r.feasible, true, '骨架否定不排除——EK329 必须仍在')
const f5 = r.legs!.find(l => l.leg === 'f5')
assert.equal(f5?.service, 'EK329', 'EK329 存活(骨架滞后容错)')
assert.ok((r.skeleton_notes ?? []).some(n => n.includes('SZX') && n.includes('❌')), `枢纽否定标注在: ${r.skeleton_notes}`)
assert.ok((r.skeleton_notes ?? []).some(n => n.includes('HKG') && n.includes('✅')), '正向标注在')
console.log(`骨架集成 OK:EK329 在枢纽否定下存活,标注=[${r.skeleton_notes?.join(' | ')}]`)
