/**
 * 账本 tenant 归属修复:授权 apply / backup / rollback / 回执(issue #254 执行面)。
 *
 * 硬纪律:
 *   A. 三重门:显式 `--i-authorize-apply` + 匹配的 `planDigest` + 可 apply 的证据映射计划。
 *   B. 写前强制 backup(db + -wal/-shm + manifest 校验和);损坏 backup fail-closed。
 *   C. 原地 UPDATE 保留 seq;CAS `WHERE seq=? AND tenant_id=?`;整批单一事务。
 *   D. 成功后对受影响 tenant 调用既有 rebuildProjections;不做启发式归属。
 *   E. 幂等:若映射目标已全部就位且存在同 digest 的 applied stamp,重跑成功且无额外变更。
 *   F. 本模块默认不触碰 founder 真账本;真实 repair 另走 owner gate + 私有回执。
 */

import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { ledgerDbPath, ledgerExists, openDb } from './state-ledger.ts'
import {
  type PlanEntry,
  type RepairEvidenceMapping,
  type RepairPlan,
  type TenantCount,
  parseEvidenceMappings,
  planLedgerRepair,
} from './ledger-repair-plan.ts'

export const REPAIR_BACKUP_SCHEMA = 'gotry.ledger-repair-backup/1'
export const REPAIR_APPLY_SCHEMA = 'gotry.ledger-repair-apply/1'
export const REPAIR_RECEIPT_SCHEMA = 'gotry.ledger-repair-receipt/1'
export const REPAIR_APPLIED_STAMP_SCHEMA = 'gotry.ledger-repair-applied/1'

const DB_SIDECARS = ['', '-wal', '-shm'] as const

export type ApplyMoveStatus = 'moved' | 'already_applied'

export interface ApplyMoveRecord {
  seq: number
  beforeTenant: string
  afterTenant: string
  status: ApplyMoveStatus
  kind: string
  subjectId: string
  idemKey: string | null
  evidence: string | null
}

export interface RepairBackupManifest {
  schema: typeof REPAIR_BACKUP_SCHEMA
  planDigest: string
  mappingSha256: string
  createdAt: string
  sourceTenant: string
  tenantCensusBefore: TenantCount[]
  files: Array<{ suffix: string; present: boolean; sha256: string | null; bytes: number | null }>
  gitHead: string | null
}

export interface RepairAppliedStamp {
  schema: typeof REPAIR_APPLIED_STAMP_SCHEMA
  planDigest: string
  mappingSha256: string
  appliedAt: string
  sourceTenant: string
  moves: ApplyMoveRecord[]
  tenantCensusAfter: TenantCount[]
  backupDir: string
}

export interface RepairReceipt {
  schema: typeof REPAIR_RECEIPT_SCHEMA
  planDigest: string
  mappingSha256: string
  authorizedBy: string
  executedAt: string
  gitHead: string | null
  stateRootFingerprint: string
  stateRootRedacted: string
  backupDirRedacted: string
  sourceTenant: string
  tenantCensusBefore: TenantCount[]
  tenantCensusAfter: TenantCount[]
  affectedSeqs: number[]
  moves: ApplyMoveRecord[]
  mode: 'applied' | 'already_applied'
  notes: string[]
}

export interface RepairApplyResult {
  schema: typeof REPAIR_APPLY_SCHEMA
  applyAuthorized: true
  mode: 'applied' | 'already_applied'
  planDigest: string
  mappingSha256: string
  backupDir: string
  sourceTenant: string
  tenantCensusBefore: TenantCount[]
  tenantCensusAfter: TenantCount[]
  moves: ApplyMoveRecord[]
  rebuiltTenants: string[]
  receipt: RepairReceipt
  notes: string[]
}

export class RepairApplyError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'RepairApplyError'
    this.code = code
  }
}

function sha256Bytes(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function sha256File(path: string): { sha256: string; bytes: number } {
  const bytes = readFileSync(path)
  return { sha256: sha256Bytes(bytes), bytes: bytes.length }
}

function fileDigestOrMissing(path: string): { present: boolean; sha256: string | null; bytes: number | null } {
  if (!existsSync(path)) return { present: false, sha256: null, bytes: null }
  const d = sha256File(path)
  return { present: true, sha256: d.sha256, bytes: d.bytes }
}

function sourceComponentDigest(path: string): string {
  const d = fileDigestOrMissing(path)
  if (!d.present) return 'missing'
  return `present:${d.bytes}:${d.sha256}`
}

function sourceGroupDigest(dbPath: string): string {
  return DB_SIDECARS.map(suffix => `${suffix}\0${sourceComponentDigest(dbPath + suffix)}`).join('\n')
}

export function mappingContentSha256(mappings: unknown): string {
  return sha256Bytes(JSON.stringify(mappings))
}

export function redactedPath(path: string): string {
  return sha256Bytes(path).slice(0, 16)
}

export function stateRootFingerprint(stateRoot: string): string {
  const dbPath = ledgerDbPath(stateRoot)
  return sha256Bytes(sourceGroupDigest(dbPath)).slice(0, 32)
}

function tryGitHead(): string | null {
  try {
    // Lazy require via spawn would be heavy; allow env override for tests / CI.
    if (process.env['GOTRY_REPAIR_GIT_HEAD']) return process.env['GOTRY_REPAIR_GIT_HEAD']
    return null
  } catch {
    return null
  }
}

function backupRoot(stateRoot: string): string {
  return join(stateRoot, '.gotry-repair-backup')
}

function stampDir(stateRoot: string): string {
  return join(stateRoot, 'gotry-state', '.gotry-repair-applied')
}

export function stampPath(stateRoot: string, planDigest: string): string {
  return join(stampDir(stateRoot), `${planDigest}.json`)
}

function isoStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf-8')
  renameSync(tmp, path)
}

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T
}

function censusFromDb(db: Database.Database): TenantCount[] {
  const hasEvents = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'").get()
  if (!hasEvents) return []
  const cols = db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>
  if (!cols.some(c => c.name === 'tenant_id')) {
    const n = (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n
    return n ? [{ tenant: 'local', events: n }] : []
  }
  return db.prepare(
    `SELECT tenant_id AS tenant, COUNT(*) AS events FROM events GROUP BY tenant_id ORDER BY tenant_id`,
  ).all() as TenantCount[]
}

function openWritableDb(stateRoot: string): Database.Database {
  const path = ledgerDbPath(stateRoot)
  if (!existsSync(path)) throw new RepairApplyError('ledger_missing', `账本不存在:${path}`)
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = FULL')
  db.pragma('busy_timeout = 5000')
  return db
}

/** Checkpoint WAL into the main db so backup/restore is a coherent snapshot. */
function checkpointWal(db: Database.Database): void {
  db.pragma('wal_checkpoint(FULL)')
}

export function createRepairBackup(opts: {
  stateRoot: string
  planDigest: string
  mappingSha256: string
  sourceTenant: string
  tenantCensusBefore: TenantCount[]
}): { backupDir: string; manifest: RepairBackupManifest } {
  const dbPath = ledgerDbPath(opts.stateRoot)
  if (!ledgerExists(opts.stateRoot)) {
    throw new RepairApplyError('ledger_missing', `账本不存在:${dbPath}`)
  }

  // Open briefly to checkpoint, then close before copying.
  {
    const db = openWritableDb(opts.stateRoot)
    try {
      checkpointWal(db)
    } finally {
      db.close()
    }
  }

  const before = sourceGroupDigest(dbPath)
  const backupDir = join(backupRoot(opts.stateRoot), `${isoStamp()}-${opts.planDigest}`)
  mkdirSync(backupDir, { recursive: true })

  const files: RepairBackupManifest['files'] = []
  for (const suffix of DB_SIDECARS) {
    const src = dbPath + suffix
    const dest = join(backupDir, `gotry-state.db${suffix}`)
    if (!existsSync(src)) {
      files.push({ suffix, present: false, sha256: null, bytes: null })
      continue
    }
    copyFileSync(src, dest)
    const d = sha256File(dest)
    files.push({ suffix, present: true, sha256: d.sha256, bytes: d.bytes })
  }

  if (sourceGroupDigest(dbPath) !== before) {
    rmSync(backupDir, { recursive: true, force: true })
    throw new RepairApplyError('source_changed_during_backup', '备份期间正本发生变化,已拒绝继续')
  }

  const manifest: RepairBackupManifest = {
    schema: REPAIR_BACKUP_SCHEMA,
    planDigest: opts.planDigest,
    mappingSha256: opts.mappingSha256,
    createdAt: new Date().toISOString(),
    sourceTenant: opts.sourceTenant,
    tenantCensusBefore: opts.tenantCensusBefore,
    files,
    gitHead: tryGitHead(),
  }
  atomicWriteJson(join(backupDir, 'manifest.json'), manifest)
  return { backupDir, manifest }
}

export function loadBackupManifest(backupDir: string): RepairBackupManifest {
  const path = join(backupDir, 'manifest.json')
  if (!existsSync(path)) throw new RepairApplyError('backup_manifest_missing', `缺少 manifest:${path}`)
  const manifest = readJsonFile<RepairBackupManifest>(path)
  if (manifest.schema !== REPAIR_BACKUP_SCHEMA) {
    throw new RepairApplyError('backup_schema_invalid', `未知 backup schema:${String(manifest.schema)}`)
  }
  return manifest
}

/** Verify backup files match manifest checksums. */
export function validateRepairBackup(backupDir: string): RepairBackupManifest {
  const manifest = loadBackupManifest(backupDir)
  for (const f of manifest.files) {
    const path = join(backupDir, `gotry-state.db${f.suffix}`)
    if (!f.present) {
      if (existsSync(path)) {
        throw new RepairApplyError('backup_corrupt', `manifest 标记缺失但文件存在:${path}`)
      }
      continue
    }
    if (!existsSync(path)) {
      throw new RepairApplyError('backup_corrupt', `backup 文件缺失:${path}`)
    }
    const d = sha256File(path)
    if (d.sha256 !== f.sha256 || d.bytes !== f.bytes) {
      throw new RepairApplyError('backup_checksum_mismatch', `backup 校验和不匹配:${path}`)
    }
  }
  return manifest
}

export function restoreRepairBackup(opts: {
  stateRoot: string
  backupDir: string
  authorizeRollback: true
}): { restoredFrom: string; manifest: RepairBackupManifest } {
  if (opts.authorizeRollback !== true) {
    throw new RepairApplyError('rollback_not_authorized', '缺少显式 rollback 授权')
  }
  const manifest = validateRepairBackup(opts.backupDir)
  const dbPath = ledgerDbPath(opts.stateRoot)
  mkdirSync(dirname(dbPath), { recursive: true })

  // Replace live db files. Callers must not hold open SQLite handles on this root.
  for (const suffix of DB_SIDECARS) {
    const live = dbPath + suffix
    if (existsSync(live)) rmSync(live)
  }

  for (const f of manifest.files) {
    if (!f.present) continue
    const src = join(opts.backupDir, `gotry-state.db${f.suffix}`)
    copyFileSync(src, dbPath + f.suffix)
  }

  // Re-validate live files against manifest.
  for (const f of manifest.files) {
    const live = dbPath + f.suffix
    if (!f.present) {
      if (existsSync(live)) {
        throw new RepairApplyError('rollback_verify_failed', `还原后出现不应存在的 sidecar:${live}`)
      }
      continue
    }
    const d = sha256File(live)
    if (d.sha256 !== f.sha256) {
      throw new RepairApplyError('rollback_verify_failed', `还原后校验和与 backup 不一致:${live}`)
    }
  }

  return { restoredFrom: opts.backupDir, manifest }
}

function loadAppliedStamp(stateRoot: string, planDigest: string): RepairAppliedStamp | null {
  const path = stampPath(stateRoot, planDigest)
  if (!existsSync(path)) return null
  const stamp = readJsonFile<RepairAppliedStamp>(path)
  if (stamp.schema !== REPAIR_APPLIED_STAMP_SCHEMA) return null
  if (stamp.planDigest !== planDigest) return null
  return stamp
}

function eventRow(db: Database.Database, seq: number): {
  seq: number
  tenant_id: string
  kind: string
  subject_id: string
  idem_key: string | null
} | undefined {
  return db.prepare(
    `SELECT seq, tenant_id, kind, subject_id, idem_key FROM events WHERE seq = ?`,
  ).get(seq) as {
    seq: number
    tenant_id: string
    kind: string
    subject_id: string
    idem_key: string | null
  } | undefined
}

function verifyAlreadyApplied(
  db: Database.Database,
  mappings: RepairEvidenceMapping[],
  planMoves: PlanEntry[],
): ApplyMoveRecord[] | null {
  const bySeq = new Map(planMoves.map(m => [m.seq, m]))
  const records: ApplyMoveRecord[] = []
  for (const m of mappings) {
    const planned = bySeq.get(m.seq)
    const row = eventRow(db, m.seq)
    if (!row) return null
    if (row.tenant_id !== m.toTenant) return null
    records.push({
      seq: m.seq,
      beforeTenant: m.fromTenant,
      afterTenant: m.toTenant,
      status: 'already_applied',
      kind: planned?.kind ?? row.kind,
      subjectId: planned?.subjectId ?? row.subject_id,
      idemKey: planned?.idemKey ?? row.idem_key,
      evidence: m.evidence,
    })
  }
  return records
}

function buildReceipt(opts: {
  planDigest: string
  mappingSha256: string
  authorizedBy: string
  stateRoot: string
  backupDir: string
  sourceTenant: string
  before: TenantCount[]
  after: TenantCount[]
  moves: ApplyMoveRecord[]
  mode: 'applied' | 'already_applied'
  notes: string[]
}): RepairReceipt {
  return {
    schema: REPAIR_RECEIPT_SCHEMA,
    planDigest: opts.planDigest,
    mappingSha256: opts.mappingSha256,
    authorizedBy: opts.authorizedBy,
    executedAt: new Date().toISOString(),
    gitHead: tryGitHead(),
    stateRootFingerprint: stateRootFingerprint(opts.stateRoot),
    stateRootRedacted: redactedPath(opts.stateRoot),
    backupDirRedacted: redactedPath(opts.backupDir),
    sourceTenant: opts.sourceTenant,
    tenantCensusBefore: opts.before,
    tenantCensusAfter: opts.after,
    affectedSeqs: opts.moves.map(m => m.seq),
    moves: opts.moves,
    mode: opts.mode,
    notes: opts.notes,
  }
}

/**
 * Test-only hook: after N successful CAS moves inside the transaction, throw to
 * prove abort leaves the DB unchanged. Production callers must leave this unset.
 */
export interface ApplyHooks {
  injectFailureAfterMoves?: number
}

export function applyLedgerRepair(opts: {
  stateRoot: string
  sourceTenant?: string
  mappings: unknown
  planDigest: string
  authorizeApply: true
  authorizedBy?: string
  receiptOut?: string
  hooks?: ApplyHooks
}): RepairApplyResult {
  if (opts.authorizeApply !== true) {
    throw new RepairApplyError('apply_not_authorized', '缺少显式 apply 授权')
  }
  if (!/^[0-9a-f]{16}$/.test(opts.planDigest)) {
    throw new RepairApplyError('plan_digest_invalid', `planDigest 必须是 16 位小写 hex:${opts.planDigest}`)
  }
  if (!ledgerExists(opts.stateRoot)) {
    throw new RepairApplyError('ledger_missing', `账本不存在:${ledgerDbPath(opts.stateRoot)}`)
  }

  const sourceTenant = opts.sourceTenant ?? 'local'
  const mappingSha = mappingContentSha256(opts.mappings)
  const authorizedBy = opts.authorizedBy ?? 'cli:i-authorize-apply'

  const plan: RepairPlan = planLedgerRepair({
    stateRoot: opts.stateRoot,
    sourceTenant,
    mappings: opts.mappings,
  })

  const parsed = parseEvidenceMappings(opts.mappings, sourceTenant)
  const intendedMoves = parsed.valid.filter(m => m.toTenant !== m.fromTenant)

  // Path A: fresh applicable plan with matching digest.
  if (plan.planDigest === opts.planDigest && plan.applyable) {
    return executeMoves({
      stateRoot: opts.stateRoot,
      sourceTenant,
      plan,
      mappingSha,
      authorizedBy,
      receiptOut: opts.receiptOut,
      hooks: opts.hooks,
    })
  }

  // Path B: idempotent already-applied (stamp + live rows at destinations).
  const stamp = loadAppliedStamp(opts.stateRoot, opts.planDigest)
  if (stamp && stamp.mappingSha256 === mappingSha) {
    const db = openWritableDb(opts.stateRoot)
    try {
      const records = verifyAlreadyApplied(
        db,
        intendedMoves.length ? intendedMoves : stamp.moves.map(m => ({
          seq: m.seq,
          fromTenant: m.beforeTenant,
          toTenant: m.afterTenant,
          evidence: m.evidence ?? 'stamp',
        })),
        plan.entries.filter(e => e.decision === 'move' || e.decision === 'reject'),
      )
      if (records) {
        const after = censusFromDb(db)
        const notes = [
          '幂等重跑:applied stamp 与目标 tenant 行均已就位,未做额外写入。',
          'fixture 绿不等于真实 founder repair 已执行。',
        ]
        const receipt = buildReceipt({
          planDigest: opts.planDigest,
          mappingSha256: mappingSha,
          authorizedBy,
          stateRoot: opts.stateRoot,
          backupDir: stamp.backupDir,
          sourceTenant,
          before: stamp.tenantCensusAfter,
          after,
          moves: records,
          mode: 'already_applied',
          notes,
        })
        if (opts.receiptOut) atomicWriteJson(opts.receiptOut, receipt)
        return {
          schema: REPAIR_APPLY_SCHEMA,
          applyAuthorized: true,
          mode: 'already_applied',
          planDigest: opts.planDigest,
          mappingSha256: mappingSha,
          backupDir: stamp.backupDir,
          sourceTenant,
          tenantCensusBefore: stamp.tenantCensusAfter,
          tenantCensusAfter: after,
          moves: records,
          rebuiltTenants: [],
          receipt,
          notes,
        }
      }
    } finally {
      db.close()
    }
  }

  if (plan.planDigest !== opts.planDigest) {
    throw new RepairApplyError(
      'plan_digest_mismatch',
      `planDigest 不匹配:expected=${opts.planDigest} actual=${plan.planDigest}`,
    )
  }
  throw new RepairApplyError(
    'plan_not_applyable',
    `计划不可 apply(applyable=${plan.applyable}, move=${plan.totals.move}, reject=${plan.totals.reject})`,
  )
}

function executeMoves(opts: {
  stateRoot: string
  sourceTenant: string
  plan: RepairPlan
  mappingSha: string
  authorizedBy: string
  receiptOut?: string
  hooks?: ApplyHooks
}): RepairApplyResult {
  const moves = opts.plan.entries.filter(e => e.decision === 'move')
  if (moves.length === 0) {
    throw new RepairApplyError('plan_not_applyable', '计划无 move 条目')
  }

  const { backupDir } = createRepairBackup({
    stateRoot: opts.stateRoot,
    planDigest: opts.plan.planDigest,
    mappingSha256: opts.mappingSha,
    sourceTenant: opts.sourceTenant,
    tenantCensusBefore: opts.plan.tenantCensusBefore,
  })
  validateRepairBackup(backupDir)

  const db = openWritableDb(opts.stateRoot)
  const records: ApplyMoveRecord[] = []
  const injectAfter = opts.hooks?.injectFailureAfterMoves
  try {
    const run = db.transaction(() => {
      const update = db.prepare(
        `UPDATE events SET tenant_id = ? WHERE seq = ? AND tenant_id = ?`,
      )
      let movedCount = 0
      for (const m of moves) {
        const row = eventRow(db, m.seq)
        if (!row) {
          throw new RepairApplyError('cas_miss', `seq ${m.seq} 不存在`)
        }
        if (row.tenant_id === m.afterTenant) {
          records.push({
            seq: m.seq,
            beforeTenant: m.beforeTenant,
            afterTenant: m.afterTenant,
            status: 'already_applied',
            kind: m.kind,
            subjectId: m.subjectId,
            idemKey: m.idemKey,
            evidence: m.evidence,
          })
          continue
        }
        if (row.tenant_id !== m.beforeTenant) {
          throw new RepairApplyError(
            'cas_miss',
            `seq ${m.seq} 当前 tenant=${row.tenant_id},期望 before=${m.beforeTenant}`,
          )
        }
        const info = update.run(m.afterTenant, m.seq, m.beforeTenant)
        if (info.changes !== 1) {
          throw new RepairApplyError('cas_miss', `seq ${m.seq} CAS UPDATE 未命中`)
        }
        movedCount++
        records.push({
          seq: m.seq,
          beforeTenant: m.beforeTenant,
          afterTenant: m.afterTenant,
          status: 'moved',
          kind: m.kind,
          subjectId: m.subjectId,
          idemKey: m.idemKey,
          evidence: m.evidence,
        })
        if (injectAfter !== undefined && movedCount >= injectAfter) {
          throw new RepairApplyError('injected_failure', `测试注入失败:已成功 ${movedCount} 条后中止`)
        }
      }
    })
    run()
    checkpointWal(db)
  } catch (error) {
    db.close()
    throw error
  }
  db.close()

  // Rebuild projections for every affected tenant via the normal ledger API.
  const tenants = [...new Set(records.flatMap(r => [r.beforeTenant, r.afterTenant]))].sort()
  for (const tenant of tenants) {
    const led = openDb(opts.stateRoot, tenant)
    led.rebuildProjections()
    led.close()
  }

  const verifyDb = openWritableDb(opts.stateRoot)
  let after: TenantCount[]
  try {
    after = censusFromDb(verifyDb)
    for (const r of records) {
      const row = eventRow(verifyDb, r.seq)
      if (!row || row.tenant_id !== r.afterTenant) {
        throw new RepairApplyError('post_apply_verify_failed', `seq ${r.seq} 未落到 ${r.afterTenant}`)
      }
    }
  } finally {
    verifyDb.close()
  }

  const notes = [
    '已通过显式授权门执行 apply;事件 seq 保留,仅更新 tenant_id。',
    '已对受影响 tenant 重建投影。',
    'fixture/隔离 stateRoot 证据不等于真实 founder repair。',
  ]
  const stamp: RepairAppliedStamp = {
    schema: REPAIR_APPLIED_STAMP_SCHEMA,
    planDigest: opts.plan.planDigest,
    mappingSha256: opts.mappingSha,
    appliedAt: new Date().toISOString(),
    sourceTenant: opts.sourceTenant,
    moves: records,
    tenantCensusAfter: after,
    backupDir,
  }
  atomicWriteJson(stampPath(opts.stateRoot, opts.plan.planDigest), stamp)

  const receipt = buildReceipt({
    planDigest: opts.plan.planDigest,
    mappingSha256: opts.mappingSha,
    authorizedBy: opts.authorizedBy,
    stateRoot: opts.stateRoot,
    backupDir,
    sourceTenant: opts.sourceTenant,
    before: opts.plan.tenantCensusBefore,
    after,
    moves: records,
    mode: 'applied',
    notes,
  })
  if (opts.receiptOut) atomicWriteJson(opts.receiptOut, receipt)

  return {
    schema: REPAIR_APPLY_SCHEMA,
    applyAuthorized: true,
    mode: 'applied',
    planDigest: opts.plan.planDigest,
    mappingSha256: opts.mappingSha,
    backupDir,
    sourceTenant: opts.sourceTenant,
    tenantCensusBefore: opts.plan.tenantCensusBefore,
    tenantCensusAfter: after,
    moves: records,
    rebuiltTenants: tenants,
    receipt,
    notes,
  }
}

export function formatRepairApplyResult(result: RepairApplyResult): string {
  const lines: string[] = []
  lines.push(`账本 tenant 修复 apply(${result.mode})`)
  lines.push(`plan-digest=${result.planDigest}`)
  lines.push(`mapping-sha256=${result.mappingSha256}`)
  lines.push(`backup=${result.backupDir}`)
  lines.push(`源租户 scope: ${result.sourceTenant}`)
  lines.push(`census before: ${result.tenantCensusBefore.map(t => `${t.tenant}=${t.events}`).join(' ') || '(空)'}`)
  lines.push(`census after : ${result.tenantCensusAfter.map(t => `${t.tenant}=${t.events}`).join(' ') || '(空)'}`)
  lines.push(`rebuilt tenants: ${result.rebuiltTenants.join(',') || '(none)'}`)
  lines.push('')
  lines.push(`  seq  status            before -> after`)
  for (const m of result.moves) {
    lines.push(
      `${String(m.seq).padStart(5)}  ${m.status.padEnd(16)}  ${m.beforeTenant} -> ${m.afterTenant}`,
    )
  }
  lines.push('')
  for (const n of result.notes) lines.push(`* ${n}`)
  lines.push(`applyAuthorized=${result.applyAuthorized}`)
  lines.push(`receipt-schema=${result.receipt.schema}`)
  return lines.join('\n')
}
