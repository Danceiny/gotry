/**
 * 账本 tenant 修复 apply 测试(issue #254 执行面,run-all §29c)。
 *
 * 覆盖:授权门零写 / 合法 apply 后目标 tenant 可见且不串读 /
 * 跨租户同 wish_id·idem_key 拒绝 / 重复 apply 幂等 / 注入失败事务回滚 /
 * backup rollback / 绝不触碰 ts/dsh-runtime/gotry-state/。
 *
 * 运行(在 ts/ 下):npx tsx scripts/ledger-repair-apply-tests.ts
 */

import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { ensureLedger, ledgerDbPath, openDb } from '../src/state-ledger.ts'
import { planLedgerRepair } from '../src/ledger-repair-plan.ts'
import {
  REPAIR_APPLY_SCHEMA,
  REPAIR_RECEIPT_SCHEMA,
  RepairApplyError,
  applyLedgerRepair,
  restoreRepairBackup,
  stampPath,
  validateRepairBackup,
} from '../src/ledger-repair-apply.ts'

let pass = 0
let fail = 0
function assert(cond: boolean, msg: string): void {
  if (cond) { pass++; console.log(`  ok - ${msg}`) } else { fail++; console.error(`  FAIL - ${msg}`) }
}

function snapshotDir(path: string): string {
  if (!existsSync(path)) return '<missing>'
  const h = createHash('sha256')
  const walk = (p: string, rel: string): void => {
    const st = statSync(p)
    if (st.isDirectory()) {
      h.update(`dir:${rel}\n`)
      for (const name of readdirSync(p).sort()) walk(join(p, name), rel ? `${rel}/${name}` : name)
    } else if (st.isFile()) {
      h.update(`file:${rel}:${st.size}\n`); h.update(readFileSync(p)); h.update('\n')
    } else {
      h.update(`other:${rel}\n`)
    }
  }
  walk(path, '')
  return h.digest('hex')
}

/** Snapshot that excludes backup/stamp artifacts created by intentional apply. */
function snapshotLedgerCore(root: string): string {
  const dbPath = ledgerDbPath(root)
  const h = createHash('sha256')
  for (const suffix of ['', '-wal', '-shm']) {
    const p = dbPath + suffix
    if (!existsSync(p)) { h.update(`missing:${suffix}\n`); continue }
    const st = statSync(p)
    h.update(`file:${suffix}:${st.size}\n`); h.update(readFileSync(p)); h.update('\n')
  }
  return h.digest('hex')
}

const roots: string[] = []
function newRoot(tag: string): string {
  const r = mkdtempSync(join(tmpdir(), `gotry-repair-apply-${tag}-`))
  roots.push(r)
  return r
}

function insertRaw(dbPath: string, rows: Array<{ tenant: string; kind: string; subject: string; idem: string | null }>): void {
  const db = new Database(dbPath)
  const stmt = db.prepare(
    `INSERT INTO events (tenant_id, ts, actor, kind, subject_id, payload, idem_key, run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  )
  for (const r of rows) {
    stmt.run(r.tenant, '2026-09-01T00:00:00.000Z', 'test:fixture', r.kind, r.subject, JSON.stringify({ wish: { wish_id: r.subject, reason: 'x', conditions: [] } }), r.idem)
  }
  db.close()
}

function seedLedger(root: string, rows: Array<{ tenant: string; kind: string; subject: string; idem: string | null }>): void {
  const led = ensureLedger(root, 'local')
  led.close()
  insertRaw(ledgerDbPath(root), rows)
}

function writeMapping(root: string, name: string, value: unknown): string {
  const p = join(root, name)
  writeFileSync(p, JSON.stringify(value), 'utf-8')
  return p
}

function cli(args: string[]): SpawnSyncReturns<string> {
  return spawnSync('npx', ['tsx', 'scripts/state-cli.ts', ...args], { encoding: 'utf-8' }) as SpawnSyncReturns<string>
}

function expectApplyError(fn: () => void, code: string, label: string): void {
  try {
    fn()
    assert(false, `${label} 应失败`)
  } catch (e) {
    assert(e instanceof RepairApplyError && e.code === code, `${label} → ${code}`)
  }
}

const FOUNDER_STATE = resolve(join('dsh-runtime', 'gotry-state'))
assert(!FOUNDER_STATE.includes(tmpdir()), 'founder 路径不在 tmp(对照用)')
const founderBefore = existsSync(FOUNDER_STATE) ? snapshotDir(FOUNDER_STATE) : '<absent>'

console.log('\n== A. 授权门:无授权 / digest 错 / 不可 apply → 零写 ==')
{
  const root = newRoot('gate')
  seedLedger(root, [
    { tenant: 'local', kind: 'wish.added', subject: 'w-1', idem: 'import:wish:w-1' },
    { tenant: 'local', kind: 'wish.added', subject: 'w-2', idem: 'import:wish:w-2' },
  ])
  const mappings = [{ seq: 1, fromTenant: 'local', toTenant: 'tenant-a', evidence: 'owner-note-1' }]
  const plan = planLedgerRepair({ stateRoot: root, mappings })
  assert(plan.applyable === true, '夹具计划可 apply')
  const before = snapshotLedgerCore(root)

  expectApplyError(
    () => applyLedgerRepair({
      stateRoot: root, mappings, planDigest: plan.planDigest,
      // @ts-expect-error intentional unauthorized
      authorizeApply: false,
    }),
    'apply_not_authorized',
    'authorizeApply=false',
  )
  // TypeScript blocks false; also prove digest mismatch zero-write:
  expectApplyError(
    () => applyLedgerRepair({
      stateRoot: root, mappings, planDigest: '0123456789abcdef', authorizeApply: true,
    }),
    'plan_digest_mismatch',
    'digest 错误',
  )
  expectApplyError(
    () => applyLedgerRepair({
      stateRoot: root, mappings: [], planDigest: planLedgerRepair({ stateRoot: root, mappings: [] }).planDigest,
      authorizeApply: true,
    }),
    'plan_not_applyable',
    '无映射不可 apply',
  )
  assert(snapshotLedgerCore(root) === before, '授权失败后 ledger 核心字节不变')

  const mapPath = writeMapping(root, 'map.json', mappings)
  const noFlag = cli(['repair-apply', root, '--mapping', mapPath, '--plan-digest', plan.planDigest])
  assert(noFlag.status === 1, 'CLI 缺 --i-authorize-apply → exit 1')
  assert(snapshotLedgerCore(root) === before, 'CLI 缺授权零写')
}

console.log('\n== B. 合法 apply:目标可见、local/其他不串读、回执 schema ==')
{
  const root = newRoot('apply')
  seedLedger(root, [
    { tenant: 'local', kind: 'wish.added', subject: 'w-move', idem: 'import:wish:w-move' },
    { tenant: 'local', kind: 'wish.added', subject: 'w-keep', idem: 'import:wish:w-keep' },
    { tenant: 'tenant-b', kind: 'wish.added', subject: 'w-b', idem: 'import:wish:w-b' },
  ])
  const mappings = [{ seq: 1, fromTenant: 'local', toTenant: 'tenant-a', evidence: 'ticket-254-evidence' }]
  const plan = planLedgerRepair({ stateRoot: root, mappings })
  assert(plan.applyable && plan.totals.move === 1, '一条 move')
  const receiptOut = join(root, 'receipt.json')
  const result = applyLedgerRepair({
    stateRoot: root, mappings, planDigest: plan.planDigest, authorizeApply: true, receiptOut,
  })
  assert(result.schema === REPAIR_APPLY_SCHEMA, 'apply result schema')
  assert(result.applyAuthorized === true, 'applyAuthorized=true')
  assert(result.mode === 'applied', 'mode=applied')
  assert(result.moves.length === 1 && result.moves[0]!.status === 'moved', '一条 moved')
  assert(existsSync(result.backupDir), 'backup 目录存在')
  validateRepairBackup(result.backupDir)
  assert(existsSync(stampPath(root, plan.planDigest)), 'applied stamp 存在')
  const receipt = JSON.parse(readFileSync(receiptOut, 'utf-8')) as { schema: string; stateRootRedacted: string }
  assert(receipt.schema === REPAIR_RECEIPT_SCHEMA, 'receipt schema')
  assert(!receipt.stateRootRedacted.includes(root), '回执路径已脱敏')

  const a = openDb(root, 'tenant-a')
  const local = openDb(root, 'local')
  const b = openDb(root, 'tenant-b')
  const aEvents = a.readEvents()
  const localEvents = local.readEvents()
  const bEvents = b.readEvents()
  assert(aEvents.some(e => e.subject_id === 'w-move' && e.seq === 1), '目标 tenant-a 可见 w-move')
  assert(!localEvents.some(e => e.subject_id === 'w-move'), 'local 不再看到 w-move')
  assert(localEvents.some(e => e.subject_id === 'w-keep'), 'local 仍见 w-keep')
  assert(!bEvents.some(e => e.subject_id === 'w-move'), 'tenant-b 不串读 w-move')
  assert(a.readWishPool().some(w => w.wish_id === 'w-move'), '目标 tenant fold 出愿望')
  assert(!local.readWishPool().some(w => w.wish_id === 'w-move'), 'local 投影无 w-move')
  a.close(); local.close(); b.close()
}

console.log('\n== C. 跨租户同 wish_id / idem_key → plan 拒 → apply 拒写 ==')
{
  const root = newRoot('conflict')
  seedLedger(root, [
    { tenant: 'local', kind: 'wish.added', subject: 'same', idem: 'idem-same' },
    { tenant: 'tenant-a', kind: 'wish.added', subject: 'same', idem: 'idem-other' },
  ])
  const mapSubject = [{ seq: 1, fromTenant: 'local', toTenant: 'tenant-a', evidence: 'e' }]
  const p1 = planLedgerRepair({ stateRoot: root, mappings: mapSubject })
  assert(p1.applyable === false && p1.entries.some(e => e.decision === 'reject'), '同 subject 冲突拒绝')
  const before = snapshotLedgerCore(root)
  expectApplyError(
    () => applyLedgerRepair({ stateRoot: root, mappings: mapSubject, planDigest: p1.planDigest, authorizeApply: true }),
    'plan_not_applyable',
    'subject 冲突不可 apply',
  )
  assert(snapshotLedgerCore(root) === before, '冲突场景零写')

  const root2 = newRoot('idem')
  seedLedger(root2, [
    { tenant: 'local', kind: 'wish.added', subject: 'w1', idem: 'shared-idem' },
    { tenant: 'tenant-a', kind: 'wish.added', subject: 'w2', idem: 'shared-idem' },
  ])
  const mapIdem = [{ seq: 1, fromTenant: 'local', toTenant: 'tenant-a', evidence: 'e' }]
  const p2 = planLedgerRepair({ stateRoot: root2, mappings: mapIdem })
  assert(p2.applyable === false, '同 idem_key 冲突拒绝')
}

console.log('\n== D. 重复 apply 幂等 ==')
{
  const root = newRoot('idempotent')
  seedLedger(root, [
    { tenant: 'local', kind: 'wish.added', subject: 'w-once', idem: 'import:wish:w-once' },
  ])
  const mappings = [{ seq: 1, fromTenant: 'local', toTenant: 'tenant-a', evidence: 'once' }]
  const plan = planLedgerRepair({ stateRoot: root, mappings })
  const first = applyLedgerRepair({
    stateRoot: root, mappings, planDigest: plan.planDigest, authorizeApply: true,
  })
  assert(first.mode === 'applied', '首次 applied')
  const coreAfterFirst = snapshotLedgerCore(root)
  const second = applyLedgerRepair({
    stateRoot: root, mappings, planDigest: plan.planDigest, authorizeApply: true,
  })
  assert(second.mode === 'already_applied', '二次 already_applied')
  assert(second.moves.every(m => m.status === 'already_applied'), '全部 already_applied')
  assert(snapshotLedgerCore(root) === coreAfterFirst, '幂等重跑 ledger 核心不变')
}

console.log('\n== E. 注入失败:事务 abort + rollback 还原 ==')
{
  const root = newRoot('fail')
  seedLedger(root, [
    { tenant: 'local', kind: 'wish.added', subject: 'w-a', idem: 'import:wish:w-a' },
    { tenant: 'local', kind: 'wish.added', subject: 'w-b', idem: 'import:wish:w-b' },
  ])
  const mappings = [
    { seq: 1, fromTenant: 'local', toTenant: 'tenant-a', evidence: 'e1' },
    { seq: 2, fromTenant: 'local', toTenant: 'tenant-a', evidence: 'e2' },
  ]
  const plan = planLedgerRepair({ stateRoot: root, mappings })
  const before = snapshotLedgerCore(root)
  expectApplyError(
    () => applyLedgerRepair({
      stateRoot: root, mappings, planDigest: plan.planDigest, authorizeApply: true,
      hooks: { injectFailureAfterMoves: 1 },
    }),
    'injected_failure',
    '注入失败',
  )
  assert(snapshotLedgerCore(root) === before, '事务 abort 后 ledger 回到 apply 前')

  // Successful apply then rollback from backup
  const ok = applyLedgerRepair({
    stateRoot: root, mappings, planDigest: plan.planDigest, authorizeApply: true,
  })
  assert(ok.mode === 'applied', '成功 apply 以便 rollback')
  const afterApply = snapshotLedgerCore(root)
  assert(afterApply !== before, 'apply 改变了 ledger')
  restoreRepairBackup({ stateRoot: root, backupDir: ok.backupDir, authorizeRollback: true })
  // After restore, census should match pre-apply (backup was taken before moves)
  const local = openDb(root, 'local')
  const a = openDb(root, 'tenant-a')
  assert(local.readEvents().filter(e => e.subject_id === 'w-a' || e.subject_id === 'w-b').length === 2, 'rollback 后 local 仍有两条')
  assert(a.readEvents().filter(e => e.subject_id === 'w-a' || e.subject_id === 'w-b').length === 0, 'rollback 后 tenant-a 无这两条')
  local.close(); a.close()
}

console.log('\n== F. CLI repair-apply / repair-rollback 端到端 ==')
{
  const root = newRoot('cli')
  seedLedger(root, [
    { tenant: 'local', kind: 'wish.added', subject: 'w-cli', idem: 'import:wish:w-cli' },
  ])
  const mappings = [{ seq: 1, fromTenant: 'local', toTenant: 'tenant-a', evidence: 'cli-e' }]
  const mapPath = writeMapping(root, 'map.json', mappings)
  const planText = cli(['repair-plan', root, '--mapping', mapPath, '--format', 'json'])
  assert(planText.status === 0, 'repair-plan json ok')
  const plan = JSON.parse(planText.stdout ?? '{}') as { planDigest: string; applyable: boolean }
  const receiptOut = join(root, 'out-receipt.json')
  const applied = cli([
    'repair-apply', root,
    '--mapping', mapPath,
    '--plan-digest', plan.planDigest,
    '--i-authorize-apply',
    '--format', 'json',
    '--receipt-out', receiptOut,
  ])
  assert(applied.status === 0, 'repair-apply exit 0')
  const body = JSON.parse(applied.stdout ?? '{}') as { mode: string; backupDir: string; applyAuthorized: boolean }
  assert(body.mode === 'applied' && body.applyAuthorized === true, 'CLI apply 结果')
  assert(existsSync(receiptOut), 'CLI 写出 receipt')

  const again = cli([
    'repair-apply', root,
    '--mapping', mapPath,
    '--plan-digest', plan.planDigest,
    '--i-authorize-apply',
    '--format', 'json',
  ])
  assert(again.status === 0, '幂等 CLI apply exit 0')
  const body2 = JSON.parse(again.stdout ?? '{}') as { mode: string }
  assert(body2.mode === 'already_applied', 'CLI 幂等 already_applied')

  const rolled = cli([
    'repair-rollback', root,
    '--backup', body.backupDir,
    '--i-authorize-rollback',
  ])
  assert(rolled.status === 0, 'repair-rollback exit 0')
  const local = openDb(root, 'local')
  assert(local.readEvents().some(e => e.subject_id === 'w-cli'), 'rollback 后 local 可见')
  local.close()

  const noBackupFlag = cli(['repair-rollback', root, '--backup', body.backupDir])
  assert(noBackupFlag.status === 1, '缺 rollback 授权旗标失败')
}

console.log('\n== G. founder 真账本未被触碰 ==')
{
  const founderAfter = existsSync(FOUNDER_STATE) ? snapshotDir(FOUNDER_STATE) : '<absent>'
  assert(founderBefore === founderAfter, 'ts/dsh-runtime/gotry-state/ 内容哈希不变')
  for (const r of roots) {
    assert(!resolve(r).startsWith(resolve('dsh-runtime')), `隔离 root 不在 dsh-runtime:${r}`)
  }
}

for (const r of roots) rmSync(r, { recursive: true, force: true })

console.log(`\n${pass} ok, ${fail} fail`)
if (fail > 0) process.exit(1)
