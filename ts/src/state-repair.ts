/**
 * state-ledger 数据修复控制面(issue #254)。
 *
 * 背景(D2/ADR-16 边界):legacy/v1 数据只安全归入默认 `local`;历史上被误写为
 * `local` 的非 local tenant 事件无法无证据自动反推,必须走人工 data-repair。
 * 本模块是那条人工通道的**控制面**:只读 inventory/dry-run、显式证据映射驱动的
 * 迁移计划、带 backup/校验和/幂等日志/回滚的受限执行。真实产品数据的执行始终
 * 是单独的 owner gate——本模块不读不写 `ts/dsh-runtime/gotry-state/`。
 *
 * 纪律:
 * - inventory/dry-run 零写入(只读连接,integrity_check,输出 before/after 计划);
 * - 迁移必须携带显式映射(逐行 from/to),无证据(无映射)的记录零迁移;
 * - 执行前 backup(文件级拷贝 + SHA-256),逐行 UPDATE 带 from 守卫,追加式
 *   journal(幂等:重跑时已完成行自动跳过);回滚 = 从校验过的 backup 恢复;
 * - 跨 tenant 同 `wish_id`/`idem_key` 冲突在 plan 阶段显式暴露,不静默。
 */

import Database from 'better-sqlite3'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { ledgerDbPath } from './state-ledger.ts'

export const REPAIR_TABLES = ['events', 'projection_docs', 'projection_items', 'workflow_runs'] as const
export type RepairTable = typeof REPAIR_TABLES[number]

export interface RepairCandidate {
  table: RepairTable
  /** 行定位:events 按 seq;projection_docs 按 subject;projection_items 按 subject+item_id;workflow_runs 按 id */
  key: Record<string, string | number>
  kind: string
  actor: string
  /** 命中的显式非 local 标记(payload/actor 内的 tenant 证据) */
  evidence: string[]
  classification: 'candidate' | 'unresolvable'
}

export interface RepairInventory {
  stateRoot: string
  dbPath: string
  dbSha256: string
  generatedAt: string
  integrity: string
  localRowCounts: Record<RepairTable, number>
  candidates: RepairCandidate[]
}

export interface RepairMappingRow {
  key: Record<string, string | number>
  to: string
}
export interface RepairMapping {
  events?: Array<{ seq: number; to: string }>
  projection_docs?: Array<{ subject: string; to: string }>
  projection_items?: Array<{ subject: string; item_id: string; to: string }>
  workflow_runs?: Array<{ id: string; to: string }>
}

export interface PlannedChange {
  table: RepairTable
  key: Record<string, string | number>
  from: string
  to: string
}
export interface RepairPlan {
  changes: PlannedChange[]
  collisions: Array<PlannedChange & { reason: string }>
  errors: string[]
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function openReadonly(stateRoot: string): Database.Database {
  const path = ledgerDbPath(stateRoot)
  if (!existsSync(path)) throw new Error(`state ledger not found: ${path}`)
  const db = new Database(path, { readonly: true })
  return db
}

const TENANT_MARKERS = [
  /"tenant_id"\s*:\s*"(?!local")[^"]+"/i,
  /"tenant"\s*:\s*"(?!local")[^"]+"/i,
]

function evidenceIn(text: string): string[] {
  const hits: string[] = []
  for (const re of TENANT_MARKERS) {
    const m = text.match(re)
    if (m) hits.push(m[0])
  }
  if (/(^|[\s:@])tenant:[A-Za-z0-9_.-]+/i.test(text)) hits.push('actor tenant: prefix')
  return hits
}

/** 只读 inventory:扫描 local 行,列出带显式非 local 标记的候选与无法判定项。零写入。 */
export function inventoryRepair(stateRoot: string, options?: { now?: Date }): RepairInventory {
  const db = openReadonly(stateRoot)
  try {
    const integrity = (db.pragma('integrity_check', { simple: true }) as string) || 'unknown'
    const candidates: RepairCandidate[] = []
    const localRowCounts: Record<RepairTable, number> = {
      events: 0, projection_docs: 0, projection_items: 0, workflow_runs: 0,
    }

    const events = db.prepare("SELECT seq, tenant_id, ts, actor, kind, subject_id, payload, idem_key, run_id FROM events WHERE tenant_id = 'local' ORDER BY seq").all() as Array<Record<string, unknown>>
    localRowCounts.events = events.length
    for (const r of events) {
      const haystack = `${String(r.actor ?? '')} ${String(r.payload ?? '')}`
      const evidence = evidenceIn(haystack)
      if (evidence.length > 0) {
        candidates.push({
          table: 'events', key: { seq: Number(r.seq) }, kind: String(r.kind ?? ''),
          actor: String(r.actor ?? ''), evidence, classification: 'candidate',
        })
      }
    }

    const pdocs = db.prepare("SELECT tenant_id, subject, doc FROM projection_docs WHERE tenant_id = 'local'").all() as Array<Record<string, unknown>>
    localRowCounts.projection_docs = pdocs.length
    for (const r of pdocs) {
      const evidence = evidenceIn(String(r.doc ?? ''))
      if (evidence.length > 0) {
        candidates.push({
          table: 'projection_docs', key: { subject: String(r.subject) }, kind: 'projection_doc',
          actor: '', evidence, classification: 'candidate',
        })
      }
    }

    const pitems = db.prepare("SELECT tenant_id, subject, item_id, doc FROM projection_items WHERE tenant_id = 'local'").all() as Array<Record<string, unknown>>
    localRowCounts.projection_items = pitems.length
    for (const r of pitems) {
      const evidence = evidenceIn(String(r.doc ?? ''))
      if (evidence.length > 0) {
        candidates.push({
          table: 'projection_items', key: { subject: String(r.subject), item_id: String(r.item_id) }, kind: 'projection_item',
          actor: '', evidence, classification: 'candidate',
        })
      }
    }

    const runs = db.prepare("SELECT tenant_id, id, goal, ticket_json, state_json FROM workflow_runs WHERE tenant_id = 'local'").all() as Array<Record<string, unknown>>
    localRowCounts.workflow_runs = runs.length
    for (const r of runs) {
      const haystack = `${String(r.ticket_json ?? '')} ${String(r.state_json ?? '')}`
      const evidence = evidenceIn(haystack)
      if (evidence.length > 0) {
        candidates.push({
          table: 'workflow_runs', key: { id: String(r.id) }, kind: String(r.goal ?? ''),
          actor: '', evidence, classification: 'candidate',
        })
      }
    }

    return {
      stateRoot,
      dbPath: ledgerDbPath(stateRoot),
      dbSha256: sha256File(ledgerDbPath(stateRoot)),
      generatedAt: (options?.now ?? new Date()).toISOString(),
      integrity,
      localRowCounts,
      candidates,
    }
  } finally {
    db.close()
  }
}

function validateMappingShape(mapping: RepairMapping): string[] {
  const errors: string[] = []
  for (const [table, rows] of Object.entries(mapping) as Array<[RepairTable, RepairMappingRow[] | undefined]>) {
    if (!REPAIR_TABLES.includes(table)) { errors.push(`unknown table: ${table}`); continue }
    if (!Array.isArray(rows)) { errors.push(`${table}: mapping must be an array`); continue }
    for (const row of rows) {
      if (!row.to || row.to === 'local' || /[^a-z0-9_.-]/i.test(String(row.to))) {
        errors.push(`${table}: invalid target tenant ${JSON.stringify(row.to ?? null)}`)
      }
    }
  }
  return errors
}

/** 只读 plan:校验映射,逐行核对当前 tenant(from 守卫),暴露跨 tenant 唯一键冲突。 */
export function planRepair(stateRoot: string, mapping: RepairMapping): RepairPlan {
  const errors = validateMappingShape(mapping)
  const changes: PlannedChange[] = []
  const collisions: Array<PlannedChange & { reason: string }> = []
  if (errors.length > 0) return { changes, collisions, errors }

  const db = openReadonly(stateRoot)
  try {
    for (const row of mapping.events ?? []) {
      const cur = db.prepare("SELECT tenant_id FROM events WHERE seq = ?").get(row.seq) as { tenant_id: string } | undefined
      if (!cur) { errors.push(`events seq=${row.seq}: not found`); continue }
      // 重定向(from=当前租户)是 owner 显式意图:from 守卫在执行层按当前值强制
      changes.push({ table: 'events', key: { seq: row.seq }, from: cur.tenant_id, to: row.to })
    }
    for (const row of mapping.projection_docs ?? []) {
      const cur = db.prepare("SELECT tenant_id FROM projection_docs WHERE subject = ? AND tenant_id = 'local'").get(row.subject) as { tenant_id: string } | undefined
      if (!cur) { errors.push(`projection_docs subject=${row.subject}: not found under local`); continue }
      changes.push({ table: 'projection_docs', key: { subject: row.subject }, from: cur.tenant_id, to: row.to })
    }
    for (const row of mapping.projection_items ?? []) {
      const cur = db.prepare("SELECT tenant_id FROM projection_items WHERE subject = ? AND item_id = ? AND tenant_id = 'local'").get(row.subject, row.item_id) as { tenant_id: string } | undefined
      if (!cur) { errors.push(`projection_items ${row.subject}/${row.item_id}: not found under local`); continue }
      changes.push({ table: 'projection_items', key: { subject: row.subject, item_id: row.item_id }, from: cur.tenant_id, to: row.to })
    }
    for (const row of mapping.workflow_runs ?? []) {
      const cur = db.prepare("SELECT tenant_id FROM workflow_runs WHERE id = ? AND tenant_id = 'local'").get(row.id) as { tenant_id: string } | undefined
      if (!cur) { errors.push(`workflow_runs id=${row.id}: not found under local`); continue }
      changes.push({ table: 'workflow_runs', key: { id: row.id }, from: cur.tenant_id, to: row.to })
    }

    // 唯一键冲突:events (tenant_id, idem_key);projection 主键 (tenant_id, subject[/item_id]);workflow_runs (tenant_id, id)
    for (const c of changes) {
      if (c.table === 'events') {
        const row = db.prepare("SELECT idem_key FROM events WHERE seq = ?").get((c.key as { seq: number }).seq) as { idem_key?: string | null }
        if (row.idem_key !== null && row.idem_key !== undefined) {
          const dup = db.prepare("SELECT seq FROM events WHERE tenant_id = ? AND idem_key = ? AND seq != ?").get(c.to, row.idem_key, (c.key as { seq: number }).seq)
          if (dup) collisions.push({ ...c, reason: `UNIQUE (tenant_id, idem_key) collision: tenant ${c.to} already has idem_key ${row.idem_key}` })
        }
      }
      if (c.table === 'projection_docs') {
        const dup = db.prepare("SELECT subject FROM projection_docs WHERE tenant_id = ? AND subject = ?").get(c.to, (c.key as { subject: string }).subject)
        if (dup) collisions.push({ ...c, reason: `PRIMARY KEY collision: tenant ${c.to} already has subject ${(c.key as { subject: string }).subject}` })
      }
      if (c.table === 'projection_items') {
        const k = c.key as { subject: string; item_id: string }
        const dup = db.prepare("SELECT item_id FROM projection_items WHERE tenant_id = ? AND subject = ? AND item_id = ?").get(c.to, k.subject, k.item_id)
        if (dup) collisions.push({ ...c, reason: `PRIMARY KEY collision: tenant ${c.to} already has ${k.subject}/${k.item_id}` })
      }
      if (c.table === 'workflow_runs') {
        const dup = db.prepare("SELECT id FROM workflow_runs WHERE tenant_id = ? AND id = ?").get(c.to, (c.key as { id: string }).id)
        if (dup) collisions.push({ ...c, reason: `PRIMARY KEY collision: tenant ${c.to} already has workflow run ${(c.key as { id: string }).id}` })
      }
    }
    return { changes, collisions, errors }
  } finally {
    db.close()
  }
}

export interface RepairJournalEntry {
  at: string
  table: RepairTable
  key: Record<string, string | number>
  from: string
  to: string
}

export interface RepairExecuteResult {
  backupDir: string
  backupSha256: string
  journalPath: string
  applied: RepairJournalEntry[]
  skipped: number
  changes: PlannedChange[]
  collisions: RepairPlan['collisions']
  errors: string[]
  integrity: string
}

function keyWhere(key: Record<string, string | number>): { clause: string; params: unknown[] } {
  const parts = Object.entries(key).map(([k]) => `${k} = ?`)
  return { clause: parts.join(' AND '), params: Object.values(key) }
}

/**
 * 受限执行:backup → 逐行 UPDATE(from 守卫)+ 追加 journal(幂等)→ integrity_check。
 * 显式映射之外零迁移;冲突行拒绝;任何 SQL 失败即抛出(已应用行留在 journal 中可审计)。
 */
export function executeRepair(stateRoot: string, mapping: RepairMapping, options?: { backupDir?: string; now?: Date }): RepairExecuteResult {
  const plan = planRepair(stateRoot, mapping)
  if (plan.errors.length > 0) throw new Error(`repair plan invalid: ${plan.errors.join('; ')}`)
  const movable = plan.changes.filter(c => !plan.collisions.some(col => col.table === c.table && JSON.stringify(col.key) === JSON.stringify(c.key)))

  const dbPath = ledgerDbPath(stateRoot)
  const stamp = (options?.now ?? new Date()).toISOString().replace(/[:.]/g, '-')
  const backupDir = options?.backupDir ?? join(stateRoot, 'state-repair-backup', stamp)
  mkdirSync(backupDir, { recursive: true })
  const backupPath = join(backupDir, 'gotry-state.db')
  copyFileSync(dbPath, backupPath)
  const backupSha256 = sha256File(backupPath)
  writeFileSync(join(backupDir, 'backup-sha256.txt'), backupSha256, 'utf8')

  // journal 挂 stateRoot 稳定路径(幂等跨执行可见);backup 目录仅存快照与校验和
  const journalPath = join(stateRoot, 'gotry-state', 'state-repair-journal.jsonl')

  const db = new Database(dbPath)
  const applied: RepairJournalEntry[] = []
  let skipped = 0
  try {
    // 已完成行(幂等):journal 里已记录的 (table,key,to) 跳过
    const done = new Set<string>()
    if (existsSync(journalPath)) {
      for (const line of readFileSync(journalPath, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const e = JSON.parse(line) as RepairJournalEntry
          done.add(`${e.table}:${JSON.stringify(e.key)}:${e.to}`)
        } catch { /* 尾部半行忽略 */ }
      }
    }
    const update = db.prepare('UPDATE events SET tenant_id = ? WHERE seq = ? AND tenant_id = ?')  // 守卫参数用 c.from
    const updatePd = db.prepare('UPDATE projection_docs SET tenant_id = ? WHERE subject = ? AND tenant_id = ?')
    const updatePi = db.prepare('UPDATE projection_items SET tenant_id = ? WHERE subject = ? AND item_id = ? AND tenant_id = ?')
    const updateWr = db.prepare('UPDATE workflow_runs SET tenant_id = ? WHERE id = ? AND tenant_id = ?')
    for (const c of movable) {
      const idem = `${c.table}:${JSON.stringify(c.key)}:${c.to}`
      if (done.has(idem) || c.from === c.to) { skipped += 1; continue }
      const k = c.key as Record<string, unknown>
      let info: { changes: number }
      if (c.table === 'events') info = update.run(c.to, k.seq, c.from)
      else if (c.table === 'projection_docs') info = updatePd.run(c.to, (k as { subject: string }).subject, c.from)
      else if (c.table === 'projection_items') info = updatePi.run(c.to, (k as { subject: string }).subject, (k as { item_id: string }).item_id, c.from)
      else info = updateWr.run(c.to, (k as { id: string }).id, c.from)
      if (info.changes !== 1) throw new Error(`repair row changed ${info.changes} rows (expected 1): ${c.table} ${JSON.stringify(c.key)}`)
      const entry: RepairJournalEntry = { at: (options?.now ?? new Date()).toISOString(), table: c.table, key: c.key, from: c.from, to: c.to }
      appendFileSync(journalPath, JSON.stringify(entry) + '\n', 'utf8')
      applied.push(entry)
    }
    const integrity = (db.pragma('integrity_check', { simple: true }) as string) || 'unknown'
    return { backupDir, backupSha256, journalPath, applied, skipped, changes: plan.changes, collisions: plan.collisions, errors: plan.errors, integrity }
  } finally {
    db.close()
  }
}

/** 回滚:用校验过的 backup 覆盖当前账本文件。调用方必须保证无打开的账本连接。 */
export function rollbackRepair(stateRoot: string, backupDir: string): { restoredSha256: string; verified: boolean } {
  const backupPath = join(backupDir, 'gotry-state.db')
  if (!existsSync(backupPath)) throw new Error(`backup not found: ${backupPath}`)
  const expected = sha256File(backupPath)
  const recorded = join(backupDir, 'backup-sha256.txt')
  if (existsSync(recorded) && readFileSync(recorded, 'utf8').trim() !== expected) {
    throw new Error('backup checksum mismatch: recorded SHA-256 does not match backup file')
  }
  const dbPath = ledgerDbPath(stateRoot)
  if (!existsSync(dbPath)) throw new Error(`state ledger not found: ${dbPath}`)
  copyFileSync(backupPath, dbPath)
  return { restoredSha256: sha256File(dbPath), verified: sha256File(dbPath) === expected }
}
