/**
 * 同行人档案单测(memory-design P2,companion_profile.v1):
 * 负面清单守卫(证件/电话零入库)/upsert 合并(追加不删史/幂等)/brief 摘要形状。
 * 运行:cd ts && npx tsx scripts/companion-tests.ts
 */

import assert from 'node:assert/strict'
import { companionId, sensitiveViolation, upsertCompanion, type CompanionProfile } from '../src/companions.ts'

let n = 0
function pass(name: string, body: () => void) {
  body()
  console.log(`  ${++n}. ${name} OK`)
}

pass('负面清单守卫:证件号/手机号拒收入库(红线 6 工程形态)', () => {
  assert.ok(sensitiveViolation('护照号 E12345678')?.includes('负面清单'), '证件拒')
  assert.ok(sensitiveViolation('我电话 13812345678')?.includes('负面清单'), '手机号拒')
  assert.equal(sensitiveViolation('爸爸65,轻度高血压,走不动山路'), null, '行为约束正常')
  const r = upsertCompanion([], {
    label: '爸爸',
    constraints: { health: ['轻度高血压'] },
    evidence: '身份证号 110101199001011234,轻度高血压',
  })
  assert.equal(r.appended, false)
  assert.ok(r.reason?.includes('负面清单'))
})

pass('新建:约束+证据落库,companion_id 语义派生', () => {
  const r = upsertCompanion([], {
    label: '爸 爸',
    constraints: { health: ['轻度高血压'], mobility: '步行≤4h' },
    evidence: '爸爸65有轻度高血压,别太累',
  })
  assert.equal(r.appended, true)
  assert.equal(r.companionId, '爸爸')
  const p = r.profiles[0]!
  assert.deepEqual(p.constraints.health, ['轻度高血压'])
  assert.deepEqual(p.evidence, ['爸爸65有轻度高血压,别太累'])
})

pass('upsert 合并:数组追加不删史/覆盖取新/幂等', () => {
  let ps: CompanionProfile[] = []
  ps = upsertCompanion(ps, {
    label: '爸爸',
    constraints: { health: ['轻度高血压'], mobility: '步行≤4h' },
    evidence: '原话一',
  }).profiles
  ps = upsertCompanion(ps, {
    label: '爸爸',
    constraints: { health: ['晕车'], mobility: '步行≤3h' },
    evidence: '原话二:晕车',
  }).profiles
  const p = ps.find(x => x.companion_id === '爸爸')!
  assert.deepEqual(p.constraints.health, ['轻度高血压', '晕车'], '数组追加不删史')
  assert.equal(p.constraints.mobility, '步行≤3h', '标量取新值')
  assert.equal(p.evidence.length, 2, '证据两条')
  const r3 = upsertCompanion(ps, {
    label: '爸爸',
    constraints: { health: ['晕车'], mobility: '步行≤3h' },
    evidence: '原话二:晕车',
  })
  assert.equal(r3.appended, false, '全量相同幂等 no-op')
})

pass('多人并存与 id 稳定性', () => {
  let ps: CompanionProfile[] = []
  ps = upsertCompanion(ps, { label: '爸爸', constraints: { health: ['高血压'] }, evidence: 'a' }).profiles
  ps = upsertCompanion(ps, { label: '女朋友', constraints: { prefs: ['怕吵'] }, evidence: 'b' }).profiles
  assert.equal(ps.length, 2)
  assert.equal(companionId('女 朋友'), '女朋友')
})

console.log(`\nCOMPANION TESTS: ${n}/4 OK(memory-design P2 守门面)`)
