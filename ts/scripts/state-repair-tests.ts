/**
 * state-ledger 数据修复控制面测试(issue #254;run-all 新节)。
 * 全部在隔离 stateRoot fixture 上验证:
 *  1. inventory 零写入(库哈希不变)+ 候选/无标记行分类正确;
 *  2. plan:缺映射/非 local 现状/非法目标租户逐项报错;跨 tenant 同 idem_key 冲突显式暴露;
 *  3. execute:--execute 缺省拒绝 CLI;from 守卫逐行 UPDATE;幂等重跑 skipped;
 *  4. rollback:从 backup 恢复且校验和验证;损毁 backup 拒绝恢复;
 *  5. 中途失败恢复:journal 已应用行在重跑时跳过,失败行后续补齐;
 *  6. founder 数据守卫:dsh-runtime 路径拒绝无标志操作。
 * 运行(在 ts/ 下):npx tsx scripts/state-repair-tests.ts
 */

import Database from 'better-sqlite3'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { ensureLedger } from '../src/state-ledger.ts'
import { executeRepair, inventoryRepair, planRepair, rollbackRepair, type RepairMapping } from '../src/state-repair.ts'

let pass = 0
function ok(msg: string): void { pass += 1; console.log(`  ok - ${msg}`) }

function cli(args: string[]): { json: any; stdout: string } {
  const r = spawnSync('npx', ['tsx', 'scripts/state-repair-cli.ts', ...args], { encoding: 'utf-8', cwd: join(process.cwd()) })
  const start = r.stdout.indexOf('{')
  return { json: JSON.parse(r.stdout.slice(start >= 0 ? start : 0)), stdout: r.stdout }
}
function dbHash(root: string): string {
  return createHash('sha256').update(readFileSync(join(root, 'gotry-state', 'gotry-state.db'))).digest('hex')
}
function seed(root: string): void {
  const ledger = ensureLedger(root, 'local')
  ledger.close()
  const db = new Database(join(root, 'gotry-state', 'gotry-state.db'))
  db.exec(`INSERT INTO events (tenant_id, ts, actor, kind, subject_id, payload, idem_key) VALUES
    ('local', '2026-09-01T00:00:00Z', 'runtime', 'wish_pool_add', 'w-1', '{"name":"本地愿望","tenant_id":"local"}', 'local-1'),
    ('local', '2026-09-01T00:00:01Z', 'tenant:acme', 'wish_pool_add', 'w-2', '{"name":"误记愿望","tenant_id":"acme"}', 'local-2'),
    ('local', '2026-09-01T00:00:02Z', 'runtime', 'motivation_save', '', '{"brief":"普通本地画像"}', 'local-3'),
    ('acme', '2026-09-01T00:00:03Z', 'runtime', 'wish_pool_add', 'w-2', '{"name":"acme 同 idem 愿望"}', 'local-2')`)
  db.close()
}

// ---- 1. inventory 零写入 + 分类 ----
{
  const root = mkdtempSync(join(tmpdir(), 'gotry-repair-'))
  seed(root)
  const before = dbHash(root)
  const inv = inventoryRepair(root)
  assert.equal(inv.integrity, 'ok', 'inventory integrity_check ok')
  assert.equal(inv.localRowCounts.events, 3, 'inventory counts local events')
  assert.equal(inv.candidates.length, 1, 'inventory flags exactly the explicit-marker row')
  assert.equal(inv.candidates[0].key.seq, 2, 'candidate is the tenant:acme event')
  assert.ok(inv.candidates[0].evidence.length >= 1, 'candidate carries explicit evidence')
  assert.equal(dbHash(root), before, 'inventory is zero-write (db hash unchanged)')
  console.log('  #1 inventory zero-write + classification OK')
}

// ---- 2. plan 校验与冲突暴露 ----
{
  const root = mkdtempSync(join(tmpdir(), 'gotry-repair-plan-'))
  seed(root)
  const bad: RepairMapping = { events: [{ seq: 2, to: 'local' }, { seq: 2, to: 'bad tenant!' }] }
  const plan = planRepair(root, bad)
  assert.ok(plan.errors.length >= 2, 'plan reports invalid target tenants (local / illegal chars)')
  const missing: RepairMapping = { events: [{ seq: 999, to: 'acme' }, { seq: 1, to: 'acme' }] }
  const planMissing = planRepair(root, missing)
  assert.ok(planMissing.errors.some(e => e.includes('seq=999: not found')), 'plan reports not-found seq')
  assert.equal(planMissing.changes.length, 1, 'plan still lists the existing mapped row')
  const good: RepairMapping = { events: [{ seq: 2, to: 'acme' }] }
  const plan2 = planRepair(root, good)
  assert.equal(plan2.errors.length, 0, 'valid mapping plans clean')
  assert.equal(plan2.changes.length, 1, 'one planned change')
  assert.equal(plan2.collisions.length, 1, 'cross-tenant same idem_key collision exposed in plan')
  assert.ok(plan2.collisions[0].reason.includes('idem_key'), 'collision reason names the unique constraint')
  console.log('  #2 plan validation + collision OK')
}

// ---- 3/4/5. execute(--execute 闸/from 守卫/幂等)+ rollback + 中途失败恢复 ----
{
  const root = mkdtempSync(join(tmpdir(), 'gotry-repair-exec-'))
  seed(root)
  // CLI 缺 --execute 必须拒绝
  const refused = cli(['execute', root, '/nonexistent.json'])
  assert.equal(refused.json.ok, false, 'CLI execute without --execute is refused')
  assert.ok(refused.stdout.includes('gated action'), 'refusal names the gate')
  // founder 数据守卫
  const founderRefused = cli(['inventory', '/Users/bytedance/work/gotry/ts/dsh-runtime'])
  assert.equal(founderRefused.json.ok, false, 'founder runtime state refused without explicit flag')

  const mapping: RepairMapping = { events: [{ seq: 2, to: 'globex' }] }
  const result = executeRepair(root, mapping)
  assert.equal(result.applied.length, 1, 'execute applies exactly the mapped row')
  assert.ok(result.backupSha256, 'backup taken with SHA-256')
  assert.ok(existsSync(result.journalPath), 'journal written')
  assert.equal(result.integrity, 'ok', 'post-repair integrity ok')
  const db = new Database(join(root, 'gotry-state', 'gotry-state.db'))
  const moved = db.prepare("SELECT tenant_id FROM events WHERE seq = 2").get() as { tenant_id: string }
  assert.equal(moved.tenant_id, 'globex', 'row moved to target tenant')
  const unchanged = db.prepare("SELECT tenant_id FROM events WHERE seq = 3").get() as { tenant_id: string }
  assert.equal(unchanged.tenant_id, 'local', 'unmapped row untouched')
  db.close()

  // 幂等重跑
  const again = executeRepair(root, mapping)
  assert.equal(again.applied.length, 0, 're-run applies nothing (idempotent via journal)')
  assert.equal(again.skipped, 1, 're-run skips the journalized row')

  // 重定向 + 扩展:journal 化行改靶(acme 冲突故用 zenith),新行补齐
  const mapping2: RepairMapping = { events: [{ seq: 2, to: 'zenith' }, { seq: 3, to: 'globex' }] }
  const third = executeRepair(root, mapping2)
  assert.equal(third.applied.length, 2, 'retarget + extend apply together')
  const db3 = new Database(join(root, 'gotry-state', 'gotry-state.db'))
  const seq2 = db3.prepare("SELECT tenant_id FROM events WHERE seq = 2").get() as { tenant_id: string }
  const seq3 = db3.prepare("SELECT tenant_id FROM events WHERE seq = 3").get() as { tenant_id: string }
  assert.equal(seq2.tenant_id, 'zenith', 'retargeted row lands at zenith')
  assert.equal(seq3.tenant_id, 'globex', 'new row lands at globex')
  db3.close()

  // rollback:校验和验证 + 恢复 + 损毁拒绝
  const rolled = rollbackRepair(root, result.backupDir)
  assert.ok(rolled.verified, 'rollback verifies backup checksum')
  const db2 = new Database(join(root, 'gotry-state', 'gotry-state.db'))
  const restored = db2.prepare("SELECT tenant_id FROM events WHERE seq = 2").get() as { tenant_id: string }
  assert.equal(restored.tenant_id, 'local', 'rollback restores original tenant')
  db2.close()
  const tampered = mkdtempSync(join(tmpdir(), 'gotry-repair-bad-'))
  const { writeFileSync, copyFileSync } = await import('node:fs')
  copyFileSync(join(result.backupDir, 'gotry-state.db'), join(tampered, 'gotry-state.db'))
  writeFileSync(join(tampered, 'backup-sha256.txt'), 'deadbeef')
  assert.throws(() => rollbackRepair(root, tampered), /checksum mismatch/, 'tampered backup refused')
  rmSync(tampered, { recursive: true, force: true })
  console.log('  #3-5 execute/idempotency/rollback OK')
}

// ---- 6. CLI plan/execute JSON 面(真 mapping 文件) ----
{
  const root = mkdtempSync(join(tmpdir(), 'gotry-repair-cli-'))
  seed(root)
  const { writeFileSync } = await import('node:fs')
  const mapPath = join(root, 'mapping.json')
  writeFileSync(mapPath, JSON.stringify({ events: [{ seq: 2, to: 'acme' }] }))
  const planned = cli(['plan', root, mapPath])
  assert.equal(planned.json.ok, true, 'CLI plan returns ok JSON')
  assert.equal(planned.json.plan.changes.length, 1, 'CLI plan lists the mapped change')
  assert.equal(planned.json.plan.collisions.length, 1, 'CLI plan surfaces the collision')
  console.log('  #6 CLI JSON surface OK')
}

console.log('STATE REPAIR TESTS: OK (inventory/plan/execute/idempotency/rollback/CLI founder-guard)')
