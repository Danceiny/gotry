/**
 * 事务化状态账本(ADR-15,docs/transactional-state-rfc.md):
 * 「文件即权威」→「单文件 SQLite 账本即权威」。
 *
 *   - events 表 = 唯一权威(append-only;语义幂等键物理化为 UNIQUE 索引)
 *   - 投影表(projection_docs/items)= 日志的确定性 fold,可随时 DROP 重建
 *   - 红线进事务:evidence/conditions 校验发生在写事务内,拒绝即回滚账本无痕
 *   - 一次写 = 单事务{INSERT event; UPDATE 投影},跨文件分叉在物理上不可能
 *   - 语义层零改造:mergeProfile/appendTrip/upsertCompanion/appendEvent 纯函数
 *     原样复用为写路径守门与 fold 处理器(memory-design §1.6「账本化只换存储面」)
 *
 * 迁移纪律(D2 one-shot):旧 JSON/JSONL 文件在首次写时自动导入为 events
 * (单事务 + 导入前快照到 gotry-state/pre-ledger-backup/);此后文件降级为
 * 导出视图(state-cli export),永不再回流。读路径带文件回退(未迁移 root
 * 仍可读旧文件),写路径必经账本——工具外无写入路径。
 *
 * 引擎:better-sqlite3(复用矩阵 open-source import 通道),WAL + NORMAL,
 * 同步 API 与仓内 readFileSync 风格一致;busy_timeout 容忍跨进程
 * (dsh 运行时 / async-collect / state-cli tick 并存)。
 */

import Database from 'better-sqlite3'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join } from 'node:path'
import { mergeProfile, type MergedProfile, type ProfilePatch } from './memory-capture.ts'
import { appendEvent as gateUtilityEvent, projectUtility, type MemoryUtilityEvent, type UtilityStatus } from './memory-utility.ts'
import { appendTrip as gateTrip, type TimelineEvent } from './travel-timeline.ts'
import { upsertCompanion, type CompanionProfile, type CompanionConstraints } from './companions.ts'
import type { WishPoolEntry } from './wish-pool.ts'

const SCHEMA_VERSION = '1'

export interface LedgerEventRow {
  seq: number
  ts: string
  actor: string
  kind: string
  subject_id: string
  payload: string
  idem_key: string | null
  run_id: string | null
}

/** 稳定 wish 主键:名称语义派生(重放/同名幂等更新不再依赖墙钟;RFC §1.1 id 不稳定缺口的修复) */
export function makeWishId(name: string): string {
  return 'w-' + createHash('sha256').update(String(name).trim()).digest('hex').slice(0, 10)
}

function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

/** stateRoot 可相对可绝对(与 incident-log.resolveIncidentsPath 同款解析) */
function stateDirOf(stateRoot: string): string {
  const root = isAbsolute(stateRoot) ? stateRoot : join(process.cwd(), stateRoot)
  return join(root, 'gotry-state')
}

export function ledgerDbPath(stateRoot: string): string {
  return join(stateDirOf(stateRoot), 'gotry-state.db')
}

export function ledgerExists(stateRoot: string): boolean {
  return existsSync(ledgerDbPath(stateRoot))
}

const LEGACY_FILES = ['motivation-profile.json', 'wish-pool.json', 'memory-utility.jsonl', 'trips.jsonl', 'companions.json'] as const

function legacyFilesPresent(stateRoot: string): boolean {
  const dir = stateDirOf(stateRoot)
  return LEGACY_FILES.some(f => existsSync(join(dir, f)))
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Error && (e as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL DEFAULT 'local',
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject_id TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL,
  idem_key TEXT,
  run_id TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS events_idem ON events(tenant_id, idem_key) WHERE idem_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS projection_docs (
  tenant_id TEXT NOT NULL DEFAULT 'local',
  subject TEXT NOT NULL,
  doc TEXT NOT NULL,
  PRIMARY KEY (tenant_id, subject)
);
CREATE TABLE IF NOT EXISTS projection_items (
  tenant_id TEXT NOT NULL DEFAULT 'local',
  subject TEXT NOT NULL,
  item_id TEXT NOT NULL,
  doc TEXT NOT NULL,
  ord INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, subject, item_id)
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  tenant_id TEXT NOT NULL DEFAULT 'local',
  id TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','settled','failed')),
  ticket_json TEXT NOT NULL,
  state_json TEXT NOT NULL,
  deliverable TEXT,
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE TABLE IF NOT EXISTS workflow_steps (
  tenant_id TEXT NOT NULL DEFAULT 'local',
  run_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('intent','done','failed')),
  result TEXT,
  intent_ts TEXT NOT NULL,
  done_ts TEXT,
  PRIMARY KEY (tenant_id, run_id, name)
);

CREATE TABLE IF NOT EXISTS pending_writes (
  tenant_id TEXT NOT NULL DEFAULT 'local',
  idem_key TEXT NOT NULL,
  seam TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','confirmed','compensated')),
  receipt TEXT,
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  PRIMARY KEY (tenant_id, idem_key)
);

CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`

export interface WorkflowRunRow {
  id: string
  goal: string
  status: string
  ticket_json: string
  state_json: string
  deliverable: string | null
  created: string
  updated: string
}

export class StateLedger {
  readonly db: Database.Database
  readonly stateRoot: string
  readonly tenant: string
  readonly dbPath: string

  constructor(db: Database.Database, stateRoot: string, tenant = 'local') {
    this.db = db
    this.stateRoot = stateRoot
    this.tenant = tenant
    this.dbPath = ledgerDbPath(stateRoot)
  }

  // ---- 基础事件面 ------------------------------------------------------------

  /** 事件插入(idem 命中 → 返回 null,不抛;红线校验异常向上抛 = 事务回滚) */
  insertEvent(ev: {
    actor: string
    kind: string
    subjectId?: string
    payload: unknown
    idemKey?: string
    runId?: string
    ts?: string
  }): number | null {
    const stmt = this.db.prepare(
      `INSERT INTO events (ts, actor, kind, subject_id, payload, idem_key, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    try {
      const info = stmt.run(
        ev.ts ?? new Date().toISOString(),
        ev.actor,
        ev.kind,
        ev.subjectId ?? '',
        JSON.stringify(ev.payload),
        ev.idemKey ?? null,
        ev.runId ?? null,
      )
      return Number(info.lastInsertRowid)
    } catch (e) {
      if (isUniqueViolation(e)) return null
      throw e
    }
  }

  readEvents(kind?: string, limit = 100): LedgerEventRow[] {
    const where = kind ? 'WHERE kind = ?' : ''
    const rows = this.db.prepare(
      `SELECT seq, ts, actor, kind, subject_id, payload, idem_key, run_id
       FROM events ${where} ORDER BY seq DESC LIMIT ?`,
    ).all(...(kind ? [kind, limit] : [limit])) as LedgerEventRow[]
    return rows
  }

  countEvents(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE tenant_id = ?').get(this.tenant) as { n: number }).n
  }

  // ---- 读:投影与日志类事件 ----------------------------------------------------

  readMotivation(): (MergedProfile & { updated_at?: string }) | null {
    const row = this.db.prepare(`SELECT doc FROM projection_docs WHERE subject = 'motivation' AND tenant_id = ?`).get(this.tenant) as { doc: string } | undefined
    return row ? JSON.parse(row.doc) : null
  }

  readWishPool(): WishPoolEntry[] {
    const rows = this.db.prepare(
      `SELECT doc FROM projection_items WHERE subject = 'wish_pool' AND tenant_id = ? ORDER BY ord, rowid`,
    ).all(this.tenant) as Array<{ doc: string }>
    return rows.map(r => JSON.parse(r.doc) as WishPoolEntry)
  }

  readCompanions(): CompanionProfile[] {
    const rows = this.db.prepare(
      `SELECT doc FROM projection_items WHERE subject = 'companions' AND tenant_id = ? ORDER BY ord, rowid`,
    ).all(this.tenant) as Array<{ doc: string }>
    return rows.map(r => JSON.parse(r.doc) as CompanionProfile)
  }

  readUtilityEvents(): MemoryUtilityEvent[] {
    const rows = this.db.prepare(
      `SELECT payload FROM events WHERE kind = 'memory_utility.event' AND tenant_id = ? ORDER BY seq`,
    ).all(this.tenant) as Array<{ payload: string }>
    return rows.map(r => (JSON.parse(r.payload) as { event: MemoryUtilityEvent }).event)
  }

  readTrips(): TimelineEvent[] {
    const rows = this.db.prepare(
      `SELECT payload FROM events WHERE kind = 'trip.logged' AND tenant_id = ? ORDER BY seq`,
    ).all(this.tenant) as Array<{ payload: string }>
    return rows.map(r => (JSON.parse(r.payload) as { trip: TimelineEvent }).trip)
  }

  /** 效用投影(与文件版 projectUtility 同源同构) */
  projectUtilityNow(): Record<string, { wish_id: string; status: UtilityStatus; recalled: number; applied: number; verified: number; last_event_ts?: string }> {
    return projectUtility(this.readUtilityEvents())
  }

  // ---- 写:单事务{INSERT event; UPDATE 投影},守门纯函数原样复用 -----------------
  // 红线进事务:evidence 缺失/conditions 空 → mergeProfile/校验拒绝 → 事务回滚,账本无痕。

  /** 动机画像增量补丁(守门 = mergeProfile:追加不删史/幂等/权重变更须伴新证据) */
  appendMotivationPatch(patch: ProfilePatch, actor = 'tool:gotry_motivation_save'): {
    saved: boolean
    profile: MergedProfile & { updated_at?: string }
  } {
    const ts = new Date().toISOString()
    const run = this.db.transaction((): { saved: boolean; profile: MergedProfile & { updated_at?: string } } => {
      const current = this.readMotivation()
      const merged = mergeProfile(current, patch)
      if (!merged) {
        const unchanged = { ...(current ?? { weights: {}, evidence: [], hard: {} }), updated_at: current?.updated_at ?? ts } as MergedProfile & { updated_at?: string }
        return { saved: false, profile: unchanged }
      }
      const doc = { ...merged, updated_at: ts }
      this.insertEvent({ actor, kind: 'motivation.patch', subjectId: 'motivation', payload: { patch }, ts })
      this.db.prepare(
        `INSERT INTO projection_docs (tenant_id, subject, doc) VALUES (?, 'motivation', ?)
         ON CONFLICT(tenant_id, subject) DO UPDATE SET doc = excluded.doc`,
      ).run(this.tenant, JSON.stringify(doc))
      return { saved: true, profile: doc }
    })
    return run()
  }

  /** 愿望入池/同名幂等更新(红线:conditions 必填非空) */
  appendWish(entry: {
    name?: unknown
    reason?: unknown
    conditions?: unknown
    muted?: unknown
  }, actor = 'tool:gotry_wish_pool_add'): { added: boolean; wish_id: string; total: number } {
    const name = String(entry.name ?? '').trim()
    const conditions = entry.conditions as Record<string, unknown> | undefined
    if (!name || !conditions || typeof conditions !== 'object' || Object.keys(conditions).length === 0) {
      throw new Error('wish pool entry requires name and conditions (fulfilment conditions are the whole point)')
    }
    const ts = new Date().toISOString()
    const run = this.db.transaction((): { added: boolean; wish_id: string; total: number } => {
      const pool = this.readWishPool()
      const existing = pool.find(w => String(w.name ?? '') === name)
      if (existing) {
        const id = typeof existing.wish_id === 'string' && existing.wish_id ? existing.wish_id : makeWishId(name)
        const next = {
          ...existing,
          wish_id: id,
          reason: entry.reason !== undefined ? entry.reason : existing.reason,
          conditions,
          ...(entry.muted !== undefined ? { muted: Boolean(entry.muted) } : {}),
        } as WishPoolEntry
        this.insertEvent({ actor, kind: 'wish.updated', subjectId: id, payload: { wish_id: id, patch: { reason: next.reason, conditions, ...(entry.muted !== undefined ? { muted: Boolean(entry.muted) } : {}) } }, ts })
        this.upsertItem('wish_pool', id, next)
        return { added: false, wish_id: id, total: pool.length }
      }
      const id = makeWishId(name)
      const doc = {
        wish_id: id,
        name,
        reason: entry.reason ?? '',
        conditions,
        ...(entry.muted !== undefined ? { muted: Boolean(entry.muted) } : {}),
        added_at: ts,
      } as WishPoolEntry
      const seq = this.insertEvent({ actor, kind: 'wish.added', subjectId: id, payload: { wish: doc }, ts })
      this.insertItem('wish_pool', id, doc, seq ?? 0)
      return { added: true, wish_id: id, total: pool.length + 1 }
    })
    return run()
  }

  /** 效用事件(幂等键 = 语义 event_id;verified 无归因自动降级 applied——纯函数同款纪律) */
  appendUtilityEvent(ev: Omit<MemoryUtilityEvent, 'schema' | 'event_id'>, actor = 'tool:gotry_wish_pool_list'): { appended: boolean; events: MemoryUtilityEvent[] } {
    const full = gateUtilityEvent([], ev).events[0]
    if (!full) return { appended: false, events: this.readUtilityEvents() }
    const run = this.db.transaction((): boolean => {
      return this.insertEvent({ actor, kind: 'memory_utility.event', subjectId: full.wish_id, payload: { event: full }, idemKey: `mu:${full.event_id}` }) !== null
    })
    return { appended: run(), events: this.readUtilityEvents() }
  }

  /** 时间线行程(守门 = appendTrip:必填/绝对日期/重叠冲突即停;幂等键 = trip_id) */
  appendTripEvent(ev: Omit<TimelineEvent, 'schema' | 'trip_id' | 'ts'>, actor = 'tool:gotry_trip_log'): { appended: boolean; tripId?: string; reason?: string; total: number } {
    const run = this.db.transaction((): { appended: boolean; tripId?: string; reason?: string; total: number } => {
      const existing = this.readTrips()
      const gate = gateTrip(existing, ev)
      if (!gate.appended) return { appended: false, tripId: gate.tripId, reason: gate.reason, total: existing.length }
      const full = gate.events[gate.events.length - 1] as TimelineEvent
      this.insertEvent({ actor, kind: 'trip.logged', subjectId: full.trip_id, payload: { trip: full }, idemKey: `trip:${full.trip_id}` })
      return { appended: true, tripId: full.trip_id, total: gate.events.length }
    })
    return run()
  }

  /** 同行人档案(守门 = upsertCompanion:负面清单拒收/追加不删史/幂等) */
  appendCompanion(patch: { label: string; constraints: CompanionConstraints; evidence: string }, actor = 'tool:gotry_companion_save'): { appended: boolean; companionId: string; reason?: string; total: number } {
    const run = this.db.transaction((): { appended: boolean; companionId: string; reason?: string; total: number } => {
      const profiles = this.readCompanions()
      const res = upsertCompanion(profiles, patch)
      if (!res.appended) return { appended: false, companionId: res.companionId, reason: res.reason, total: profiles.length }
      this.insertEvent({ actor, kind: 'companion.saved', subjectId: res.companionId, payload: { patch } })
      this.replaceItems('companions', res.profiles.map(p => [p.companion_id, p]))
      return { appended: true, companionId: res.companionId, total: res.profiles.length }
    })
    return run()
  }

  /**
   * 成行确认(原跨两文件写 → 单事务):verified_outcome 效用事件 + 可选时间线行程,
   * 同事务提交,崩溃后要么全有要么全无(RFC §1.1 partial-writes 缺口的修复)。
   */
  confirmOutcome(input: {
    wishId: string
    attribution: 'helpful' | 'harmful' | 'neutral'
    detail?: string
    trip?: Omit<TimelineEvent, 'schema' | 'trip_id' | 'ts'>
  }, actor = 'tool:gotry_wish_pool_list'): {
    recorded: boolean
    trip?: { appended: boolean; tripId?: string; reason?: string }
  } {
    const run = this.db.transaction((): { recorded: boolean; trip?: { appended: boolean; tripId?: string; reason?: string } } => {
      const now = new Date().toISOString()
      const full = gateUtilityEvent([], {
        wish_id: input.wishId, kind: 'verified_outcome', ts: now,
        ctx: 'gotry_wish_pool_list.confirm', detail: input.detail, attribution: input.attribution,
      }).events[0]
      const recorded = full
        ? this.insertEvent({ actor, kind: 'memory_utility.event', subjectId: full.wish_id, payload: { event: full }, idemKey: `mu:${full.event_id}` }) !== null
        : false
      let trip: { appended: boolean; tripId?: string; reason?: string } | undefined
      if (input.trip) {
        const existing = this.readTrips()
        const gate = gateTrip(existing, input.trip)
        if (gate.appended) {
          const fullTrip = gate.events[gate.events.length - 1] as TimelineEvent
          this.insertEvent({ actor, kind: 'trip.logged', subjectId: fullTrip.trip_id, payload: { trip: fullTrip }, idemKey: `trip:${fullTrip.trip_id}` })
        }
        trip = { appended: gate.appended, tripId: gate.tripId, reason: gate.reason }
      }
      return { recorded, trip }
    })
    return run()
  }

  // ---- 投影维护 ---------------------------------------------------------------

  private upsertItem(subject: string, itemId: string, doc: unknown): void {
    const ord = (this.db.prepare(
      `SELECT ord FROM projection_items WHERE subject = ? AND item_id = ? AND tenant_id = ?`,
    ).get(subject, itemId, this.tenant) as { ord: number } | undefined)?.ord ?? this.nextOrd(subject)
    this.db.prepare(
      `INSERT INTO projection_items (tenant_id, subject, item_id, doc, ord) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, subject, item_id) DO UPDATE SET doc = excluded.doc`,
    ).run(this.tenant, subject, itemId, JSON.stringify(doc), ord)
  }

  private insertItem(subject: string, itemId: string, doc: unknown, ord: number): void {
    this.db.prepare(
      `INSERT INTO projection_items (tenant_id, subject, item_id, doc, ord) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, subject, item_id) DO UPDATE SET doc = excluded.doc`,
    ).run(this.tenant, subject, itemId, JSON.stringify(doc), ord)
  }

  private replaceItems(subject: string, items: Array<[string, unknown]>): void {
    this.db.prepare('DELETE FROM projection_items WHERE subject = ? AND tenant_id = ?').run(subject, this.tenant)
    const ins = this.db.prepare('INSERT INTO projection_items (tenant_id, subject, item_id, doc, ord) VALUES (?, ?, ?, ?, ?)')
    items.forEach(([id, doc], i) => ins.run(this.tenant, subject, id, JSON.stringify(doc), i))
  }

  private nextOrd(subject: string): number {
    return ((this.db.prepare(
      'SELECT COALESCE(MAX(ord), -1) AS m FROM projection_items WHERE subject = ? AND tenant_id = ?',
    ).get(subject, this.tenant) as { m: number }).m ?? -1) + 1
  }

  /**
   * fold 重建:DROP 全部投影 → 重放 events(可截到 toSeq)→ 重建投影。
   * 与写路径共用同一套纯函数 → 直读投影与 fold 结果一致(账本/投影永不分叉的可验证性)。
   */
  rebuildProjections(toSeq?: number): { events: number; wishes: number; companions: number } {
    const run = this.db.transaction((): { events: number; wishes: number; companions: number } => {
      this.db.prepare('DELETE FROM projection_docs WHERE tenant_id = ?').run(this.tenant)
      this.db.prepare('DELETE FROM projection_items WHERE tenant_id = ?').run(this.tenant)
      const rows = (toSeq === undefined
        ? this.db.prepare('SELECT seq, ts, kind, subject_id, payload FROM events WHERE tenant_id = ? ORDER BY seq')
        : this.db.prepare('SELECT seq, ts, kind, subject_id, payload FROM events WHERE seq <= ? AND tenant_id = ? ORDER BY seq')
      ).all(...(toSeq === undefined ? [this.tenant] : [toSeq, this.tenant])) as Array<{ seq: number; ts: string; kind: string; subject_id: string; payload: string }>
      for (const row of rows) this.foldEvent(row)
      const wishes = (this.db.prepare(`SELECT COUNT(*) AS n FROM projection_items WHERE subject = 'wish_pool' AND tenant_id = ?`).get(this.tenant) as { n: number }).n
      const companions = (this.db.prepare(`SELECT COUNT(*) AS n FROM projection_items WHERE subject = 'companions' AND tenant_id = ?`).get(this.tenant) as { n: number }).n
      return { events: rows.length, wishes, companions }
    })
    return run()
  }

  private foldEvent(row: { seq: number; ts: string; kind: string; subject_id: string; payload: string }): void {
    const p = JSON.parse(row.payload) as Record<string, unknown>
    switch (row.kind) {
      case 'motivation.imported': {
        const doc = p['profile'] as MergedProfile & { updated_at?: string }
        this.db.prepare(
          `INSERT INTO projection_docs (tenant_id, subject, doc) VALUES (?, 'motivation', ?)
           ON CONFLICT(tenant_id, subject) DO UPDATE SET doc = excluded.doc`,
        ).run(this.tenant, JSON.stringify(doc))
        break
      }
      case 'motivation.patch': {
        const current = this.readMotivation()
        const merged = mergeProfile(current, p['patch'] as ProfilePatch)
        if (merged) {
          const doc = { ...merged, updated_at: row.ts }
          this.db.prepare(
            `INSERT INTO projection_docs (tenant_id, subject, doc) VALUES (?, 'motivation', ?)
             ON CONFLICT(tenant_id, subject) DO UPDATE SET doc = excluded.doc`,
          ).run(this.tenant, JSON.stringify(doc))
        }
        break
      }
      case 'wish.imported':
      case 'wish.added': {
        const wish = (p['wish'] ?? p['profile']) as WishPoolEntry
        this.insertItem('wish_pool', String(wish.wish_id ?? row.subject_id), wish, row.seq)
        break
      }
      case 'wish.updated': {
        const id = String(p['wish_id'])
        const patch = (p['patch'] ?? {}) as Record<string, unknown>
        const rows = this.db.prepare(`SELECT doc FROM projection_items WHERE subject = 'wish_pool' AND item_id = ?`).get(id) as { doc: string } | undefined
        if (rows) {
          const doc = { ...JSON.parse(rows.doc), ...patch } as WishPoolEntry
          this.upsertItem('wish_pool', id, doc)
        }
        break
      }
      case 'companion.imported': {
        const profile = p['profile'] as CompanionProfile
        this.insertItem('companions', profile.companion_id, profile, row.seq)
        break
      }
      case 'companion.saved': {
        const patch = p['patch'] as { label: string; constraints: CompanionConstraints; evidence: string }
        const res = upsertCompanion(this.readCompanions(), patch)
        this.replaceItems('companions', res.profiles.map(c => [c.companion_id, c]))
        break
      }
      default:
        break // 日志类事件(memory_utility/trip/async/write/forget)无投影
    }
  }

  // ---- durable 工单(TS-3) -----------------------------------------------------

  createWorkflowRun(input: { id: string; goal: string; ticket: unknown; state: unknown }, actor = 'system:async-request'): void {
    const ts = new Date().toISOString()
    const run = this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO workflow_runs (tenant_id, id, goal, status, ticket_json, state_json, deliverable, created, updated)
         VALUES (?, ?, ?, 'pending', ?, ?, NULL, ?, ?)
         ON CONFLICT(tenant_id, id) DO UPDATE SET updated = excluded.updated`,
      ).run(this.tenant, input.id, input.goal, JSON.stringify(input.ticket), JSON.stringify(input.state), ts, ts)
      this.insertEvent({ actor, kind: 'async.run_created', subjectId: input.id, payload: { ticket: input.ticket }, runId: input.id, ts })
    })
    run()
  }

  getWorkflowRun(id: string): WorkflowRunRow | undefined {
    return this.db.prepare('SELECT * FROM workflow_runs WHERE id = ? AND tenant_id = ?').get(id, this.tenant) as WorkflowRunRow | undefined
  }

  pendingWorkflowRuns(): Array<{ id: string; goal: string }> {
    return this.db.prepare(`SELECT id, goal FROM workflow_runs WHERE status = 'pending' AND tenant_id = ? ORDER BY created`).all(this.tenant) as Array<{ id: string; goal: string }>
  }

  getWorkflowStep(runId: string, name: string): { status: string; result: string | null } | undefined {
    return this.db.prepare('SELECT status, result FROM workflow_steps WHERE run_id = ? AND name = ? AND tenant_id = ?').get(runId, name, this.tenant) as { status: string; result: string | null } | undefined
  }

  markStepIntent(runId: string, name: string): void {
    this.db.prepare(
      `INSERT INTO workflow_steps (tenant_id, run_id, name, status, intent_ts) VALUES (?, ?, ?, 'intent', ?)
       ON CONFLICT(tenant_id, run_id, name) DO NOTHING`,
    ).run(this.tenant, runId, name, new Date().toISOString())
  }

  markStepDone(runId: string, name: string, result: unknown): void {
    this.db.prepare(
      `UPDATE workflow_steps SET status = 'done', result = ?, done_ts = ? WHERE run_id = ? AND name = ? AND tenant_id = ?`,
    ).run(JSON.stringify(result), new Date().toISOString(), runId, name, this.tenant)
  }

  private finishWorkflowRun(
    id: string,
    status: 'settled' | 'failed',
    eventKind: 'async.settled' | 'async.failed',
    deliverable: string,
    terminalOutcome?: unknown,
    actor = 'system:async-collect',
  ): void {
    const run = this.db.transaction(() => {
      const update = this.db.prepare(
        `UPDATE workflow_runs SET status = ?, deliverable = ?, updated = ?
         WHERE id = ? AND tenant_id = ? AND status = 'pending'`,
      ).run(status, deliverable, new Date().toISOString(), id, this.tenant)
      if (update.changes === 0) {
        const existing = this.getWorkflowRun(id)
        if (existing?.status === status) return
        throw new Error(`workflow ${id} cannot transition ${existing?.status ?? 'missing'} -> ${status}`)
      }
      this.insertEvent({
        actor,
        kind: eventKind,
        subjectId: id,
        payload: { bytes: deliverable.length, terminal_outcome: terminalOutcome },
        idemKey: `async-terminal:${id}`,
        runId: id,
      })
    })
    run()
  }

  settleWorkflowRun(id: string, deliverable: string, terminalOutcome?: unknown, actor = 'system:async-collect'): void {
    this.finishWorkflowRun(id, 'settled', 'async.settled', deliverable, terminalOutcome, actor)
  }

  failWorkflowRun(id: string, deliverable: string, terminalOutcome: unknown, actor = 'system:async-collect'): void {
    this.finishWorkflowRun(id, 'failed', 'async.failed', deliverable, terminalOutcome, actor)
  }

  getWorkflowTerminalOutcome(id: string): Record<string, unknown> | null {
    const row = this.db.prepare(
      `SELECT payload FROM events
       WHERE tenant_id = ? AND run_id = ? AND kind IN ('async.settled', 'async.failed')
       ORDER BY seq DESC LIMIT 1`,
    ).get(this.tenant, id) as { payload: string } | undefined
    if (!row) return null
    try {
      const payload = JSON.parse(row.payload) as { terminal_outcome?: Record<string, unknown> }
      return payload.terminal_outcome ?? null
    } catch {
      return null
    }
  }

  // ---- WriteGate saga 基座(TS-4, RFC S4 L2/L3 物理预备) -----------------------

  /** 登记一笔待确认外部写(幂等键去重:同一确认不可能登记两次)。L2 = 只登记不执行。 */
  requestPendingWrite(input: { idemKey: string; seam: string; payload: unknown }, actor = 'system:writegate'): { created: boolean; status: string } {
    const ts = new Date().toISOString()
    const run = this.db.transaction((): { created: boolean; status: string } => {
      const info = this.db.prepare(
        `INSERT INTO pending_writes (tenant_id, idem_key, seam, payload, status, created, updated)
         VALUES (?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT(tenant_id, idem_key) DO NOTHING`,
      ).run(this.tenant, input.idemKey, input.seam, JSON.stringify(input.payload ?? {}), ts, ts)
      if (info.changes === 0) {
        const row = this.db.prepare('SELECT status FROM pending_writes WHERE idem_key = ? AND tenant_id = ?').get(input.idemKey, this.tenant) as { status: string }
        return { created: false, status: row.status }
      }
      this.insertEvent({ actor, kind: 'write.pending', subjectId: input.idemKey, payload: { seam: input.seam, payload: input.payload }, idemKey: `pw:${sha(input.idemKey)}:pending` })
      return { created: true, status: 'pending' }
    })
    return run()
  }

  /** L3:具名 seam 确认——pending → confirmed,携 receipt(外部世界回执) */
  confirmPendingWrite(idemKey: string, receipt: string, actor = 'system:writegate'): { ok: boolean; status: string } {
    const run = this.db.transaction((): { ok: boolean; status: string } => {
      const info = this.db.prepare(
        `UPDATE pending_writes SET status = 'confirmed', receipt = ?, updated = ? WHERE idem_key = ? AND status = 'pending' AND tenant_id = ?`,
      ).run(receipt, new Date().toISOString(), idemKey, this.tenant)
      if (info.changes === 0) {
        const row = this.db.prepare('SELECT status FROM pending_writes WHERE idem_key = ? AND tenant_id = ?').get(idemKey, this.tenant) as { status: string } | undefined
        return { ok: false, status: row?.status ?? 'missing' }
      }
      this.insertEvent({ actor, kind: 'write.confirmed', subjectId: idemKey, payload: { receipt } })
      return { ok: true, status: 'confirmed' }
    })
    return run()
  }

  /** saga 补偿:pending/confirmed → compensated(SagaLLM 式补偿语义) */
  compensatePendingWrite(idemKey: string, note: string, actor = 'system:writegate'): { ok: boolean; status: string } {
    const run = this.db.transaction((): { ok: boolean; status: string } => {
      const info = this.db.prepare(
        `UPDATE pending_writes SET status = 'compensated', receipt = COALESCE(receipt, ?), updated = ? WHERE idem_key = ? AND status != 'compensated' AND tenant_id = ?`,
      ).run(note, new Date().toISOString(), idemKey, this.tenant)
      if (info.changes === 0) {
        const row = this.db.prepare('SELECT status FROM pending_writes WHERE idem_key = ? AND tenant_id = ?').get(idemKey, this.tenant) as { status: string } | undefined
        return { ok: false, status: row?.status ?? 'missing' }
      }
      this.insertEvent({ actor, kind: 'write.compensated', subjectId: idemKey, payload: { note } })
      return { ok: true, status: 'compensated' }
    })
    return run()
  }

  listPendingWrites(): Array<{ idem_key: string; seam: string; status: string; receipt: string | null; created: string }> {
    return this.db.prepare('SELECT idem_key, seam, status, receipt, created FROM pending_writes WHERE tenant_id = ? ORDER BY created').all(this.tenant) as Array<{ idem_key: string; seam: string; status: string; receipt: string | null; created: string }>
  }

  /** what-if 分叉:VACUUM INTO 副本,预演不触正本(LoopX「先只读投影后执行」的物理化) */
  forkWhatIf(destPath: string): string {
    this.db.prepare('VACUUM INTO ?').run(destPath)
    return destPath
  }

  // ---- forget(D5:物理硬删,审计只留一行) ---------------------------------------

  /** 物理删除某主体的全部事件并重建投影;删除本身留一行审计事件(红线 6「可删除」)。 */
  forgetSubject(subjects: Array<{ kinds: string[]; subjectId: string }>, actor = 'system:state-cli'): { deleted: number } {
    const run = this.db.transaction((): { deleted: number } => {
      let deleted = 0
      for (const s of subjects) {
        const placeholders = s.kinds.map(() => '?').join(',')
        const info = this.db.prepare(
          `DELETE FROM events WHERE subject_id = ? AND tenant_id = ? AND kind IN (${placeholders})`,
        ).run(s.subjectId, this.tenant, ...s.kinds)
        deleted += info.changes
      }
      this.insertEvent({ actor, kind: 'forget.executed', payload: { subjects } })
      this.rebuildProjections()
      return { deleted }
    })
    return run()
  }

  close(): void {
    this.db.close()
    for (const [key, value] of openLedgers) if (value === this) openLedgers.delete(key)
  }
}

// ---- 打开/迁移(one-shot D2;模块级缓存避免每次读开新句柄) ----------------------

const openLedgers = new Map<string, StateLedger>()

export function openDb(stateRoot: string, tenant = 'local'): StateLedger {
  const path = ledgerDbPath(stateRoot)
  const cacheKey = `${path}::${tenant}`
  const cached = openLedgers.get(cacheKey)
  if (cached) return cached
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('busy_timeout = 5000')
  // schema v1→v2 迁移:v1 无 tenant_id 列(user_version 未设置过,实际为 0)
  const version = db.pragma('user_version', { simple: true }) as number
  if (version < 2) {
    // 检测是否真有 v1 数据(有 events 表但无 tenant_id 列)
    const hasEventsTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'").get() !== undefined
    const eventsHasTenant = hasEventsTable && (db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>).some(c => c.name === 'tenant_id')
    const isV1 = hasEventsTable && !eventsHasTenant
    
    db.transaction(() => {
      if (isV1) {
        // v1 → v2:events 加 tenant_id,回填 'local';投影/工单/pending_writes 强制重建(旧表无 tenant_id)
        db.exec(`
          ALTER TABLE events ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'local';
          DROP INDEX IF EXISTS events_idem;
          CREATE UNIQUE INDEX events_idem ON events(tenant_id, idem_key) WHERE idem_key IS NOT NULL;
          DROP TABLE IF EXISTS projection_docs;
          DROP TABLE IF EXISTS projection_items;
          DROP TABLE IF EXISTS workflow_runs;
          DROP TABLE IF EXISTS workflow_steps;
          DROP TABLE IF EXISTS pending_writes;
        `)
      } else {
        // v2 幂等:检查 workflow_runs 是否缺 tenant_id(修一次跑坏的迁移)
        const wrHasTenant = (db.prepare("PRAGMA table_info(workflow_runs)").all() as Array<{ name: string }>).some(c => c.name === 'tenant_id')
        if (!wrHasTenant && db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workflow_runs'").get()) {
          db.exec(`
            DROP TABLE IF EXISTS workflow_runs;
            DROP TABLE IF EXISTS workflow_steps;
            DROP TABLE IF EXISTS pending_writes;
            DROP TABLE IF EXISTS projection_docs;
            DROP TABLE IF EXISTS projection_items;
          `)
        }
      }
      db.exec(SCHEMA)
      db.pragma('user_version = 2')
      db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run('schema_version', '2')
    })()
    // v1 升级后:从 events 重建投影(v1 投影表已 DROP)
    if (isV1) {
      const ledger = new StateLedger(db, stateRoot, tenant)
      ledger.rebuildProjections()
    }
  } else {
    db.exec(SCHEMA) // 幂等建表(IF NOT EXISTS)
    db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run('schema_version', '2')
  }
  const ledger = new StateLedger(db, stateRoot, tenant)
  openLedgers.set(cacheKey, ledger)
  return ledger
}

/** 只读场景:账本不存在返回 null(调用方走文件回退) */
export function openLedgerIfExists(stateRoot: string, tenant = 'local'): StateLedger | null {
  if (!ledgerExists(stateRoot)) return null
  return openDb(stateRoot, tenant)
}

export interface MigrationReport {
  migrated: boolean
  imported: { motivation: boolean; wishes: number; utilityEvents: number; trips: number; companions: number }
  backupDir: string | null
}

/**
 * 确保账本可用(写路径必经):
 *  - DB 已存在 → 直接用
 *  - 无 DB 无旧文件 → 建空账本(fresh root,smoke/测试形态)
 *  - 无 DB 有旧文件 → 快照 → 建账本 → 旧数据单事务导入为 events(one-shot;
 *    导入幂等键 + kv 旗标双保险,并发 ensure 不重复导入)
 */
export function ensureLedger(stateRoot: string, tenant = 'local'): StateLedger {
  if (ledgerExists(stateRoot)) return openDb(stateRoot, tenant)
  const dir = stateDirOf(stateRoot)
  const hasLegacy = legacyFilesPresent(stateRoot)
  let backupDir: string | null = null
  if (hasLegacy) {
    backupDir = join(dir, 'pre-ledger-backup')
    mkdirSync(backupDir, { recursive: true })
    for (const f of LEGACY_FILES) {
      if (existsSync(join(dir, f))) copyFileSync(join(dir, f), join(backupDir, f))
    }
  }
  const ledger = openDb(stateRoot, tenant)
  if (hasLegacy) importLegacyInto(ledger, dir)
  return ledger
}

function importLegacyInto(ledger: StateLedger, dir: string): MigrationReport['imported'] {
  const imported = { motivation: false, wishes: 0, utilityEvents: 0, trips: 0, companions: 0 }
  const run = ledger.db.transaction(() => {
    const flag = ledger.db.prepare(`SELECT v FROM kv WHERE k = 'legacy_imported_v1'`).get() as { v: string } | undefined
    if (flag) return
    const readJsonSafe = (p: string): unknown | null => {
      try { return JSON.parse(readFileSync(p, 'utf-8')) } catch { return null }
    }
    // 动机画像:整档快照事件(fold 直接落投影)
    const profile = readJsonSafe(join(dir, 'motivation-profile.json')) as Record<string, unknown> | null
    if (profile) {
      if (ledger.insertEvent({ actor: 'system:migrate', kind: 'motivation.imported', subjectId: 'motivation', payload: { profile }, idemKey: 'import:motivation' }) !== null) imported.motivation = true
    }
    // 愿望池:逐条导入(保留原 wish_id)
    const pool = readJsonSafe(join(dir, 'wish-pool.json')) as Array<Record<string, unknown>> | null
    if (Array.isArray(pool)) {
      for (const w of pool) {
        const id = String(w['wish_id'] ?? makeWishId(String(w['name'] ?? '')))
        const wish = { ...w, wish_id: id }
        if (ledger.insertEvent({ actor: 'system:migrate', kind: 'wish.imported', subjectId: id, payload: { wish }, idemKey: `import:wish:${id}` }) !== null) imported.wishes++
      }
    }
    // 效用流:逐行导入(语义 event_id 即幂等键)
    try {
      const lines = readFileSync(join(dir, 'memory-utility.jsonl'), 'utf-8').split('\n').filter(Boolean)
      for (const line of lines) {
        try {
          const ev = JSON.parse(line) as MemoryUtilityEvent
          if (ledger.insertEvent({ actor: 'system:migrate', kind: 'memory_utility.event', subjectId: ev.wish_id, payload: { event: ev }, idemKey: `mu:${ev.event_id}` }) !== null) imported.utilityEvents++
        } catch { /* 脏行跳过:导入永不因单行失败而中断 */ }
      }
    } catch { /* 文件不存在 */ }
    // 时间线:逐行导入(trip_id 幂等)
    try {
      const lines = readFileSync(join(dir, 'trips.jsonl'), 'utf-8').split('\n').filter(Boolean)
      for (const line of lines) {
        try {
          const trip = JSON.parse(line) as TimelineEvent
          if (ledger.insertEvent({ actor: 'system:migrate', kind: 'trip.logged', subjectId: trip.trip_id, payload: { trip }, idemKey: `trip:${trip.trip_id}` }) !== null) imported.trips++
        } catch { /* 脏行跳过 */ }
      }
    } catch { /* 文件不存在 */ }
    // 同行人:逐条导入(保留 companion_id)
    const companions = readJsonSafe(join(dir, 'companions.json')) as Array<Record<string, unknown>> | null
    if (Array.isArray(companions)) {
      for (const c of companions) {
        const id = String(c['companion_id'] ?? '')
        if (!id) continue
        if (ledger.insertEvent({ actor: 'system:migrate', kind: 'companion.imported', subjectId: id, payload: { profile: c }, idemKey: `import:companion:${id}` }) !== null) imported.companions++
      }
    }
    ledger.rebuildProjections()
    ledger.db.prepare(`INSERT INTO kv (k, v) VALUES ('legacy_imported_v1', 'done') ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run()
  })
  run()
  return imported
}

// ---- 读路径统一出口:账本优先,未迁移 root 回退旧文件(只读,绝不反向写) ---------

function readLegacyJson<T>(stateRoot: string, name: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(join(stateDirOf(stateRoot), name), 'utf-8')) as T
  } catch {
    return fallback
  }
}

function readLegacyJsonl<T>(stateRoot: string, name: string): T[] {
  try {
    return readFileSync(join(stateDirOf(stateRoot), name), 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l) as T)
  } catch {
    return []
  }
}

export function readMotivationWithFallback(stateRoot: string): (MergedProfile & { updated_at?: string }) | null {
  const ledger = openLedgerIfExists(stateRoot)
  if (ledger) return ledger.readMotivation()
  return readLegacyJson<(MergedProfile & { updated_at?: string }) | null>(stateRoot, 'motivation-profile.json', null)
}

export function readWishPoolWithFallback(stateRoot: string): WishPoolEntry[] {
  const ledger = openLedgerIfExists(stateRoot)
  if (ledger) return ledger.readWishPool()
  return readLegacyJson<WishPoolEntry[]>(stateRoot, 'wish-pool.json', [])
}

export function readUtilityEventsWithFallback(stateRoot: string): MemoryUtilityEvent[] {
  const ledger = openLedgerIfExists(stateRoot)
  if (ledger) return ledger.readUtilityEvents()
  return readLegacyJsonl<MemoryUtilityEvent>(stateRoot, 'memory-utility.jsonl')
}

export function readTripsWithFallback(stateRoot: string): TimelineEvent[] {
  const ledger = openLedgerIfExists(stateRoot)
  if (ledger) return ledger.readTrips()
  return readLegacyJsonl<TimelineEvent>(stateRoot, 'trips.jsonl')
}

export function readCompanionsWithFallback(stateRoot: string): CompanionProfile[] {
  const ledger = openLedgerIfExists(stateRoot)
  if (ledger) return ledger.readCompanions()
  return readLegacyJson<CompanionProfile[]>(stateRoot, 'companions.json', [])
}
