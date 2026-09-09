/**
 * 账本 tenant 归属修复:只读 inventory + dry-run 计划(issue #254 第一切片)。
 *
 * 背景(docs/design/milestone-delivery-plan.md §161):legacy/v1 数据只安全归入默认
 * `local`;历史上被误写为 `local` 的非 local tenant 事件**无法无证据自动反推**,
 * 必须走人工 data-repair。本模块只回答两个问题:
 *   1) inventory:源 tenant scope 下有哪些候选事件、全库租户分布如何;
 *   2) dry-run:给定**人工确认的显式证据映射**,计划会把哪些事件搬到哪个 tenant,
 *      哪些因无证据原地保留,哪些因冲突被拒。
 *
 * 三条硬纪律:
 *
 *   A. **物理零写**。本模块从不打开正本账本:先把 db(连同 -wal/-shm)复制到临时
 *      目录,只在副本上开 readonly 句柄读,用完即删。两个理由:
 *        - `openDb`/`openLedgerIfExists` 在 v1 形态账本上会 ALTER events 加
 *          tenant_id、把 user_version 顶到 2、DROP 重建全部投影(实测:一次
 *          「只读」意图的 countEvents 就改写了 v1 账本);
 *        - 即便老老实实用 readonly 直开正本,SQLite 为 WAL 库建共享内存索引时
 *          仍会在正本目录里生成 -shm/-wal(实测),只读连接也无权清理。
 *      巡检工具不允许有任何一种副作用,所以零写做成结构性的:正本只被读取一次。
 *
 *   B. **无证据不搬移**。没有出现在映射里的事件一律 `retain`;映射本身缺 evidence、
 *      格式不对、seq 不在 scope 内的,一律 `reject`。推测不是证据,本模块不做任何
 *      基于 payload/时间/命名的启发式归属推断。
 *
 *   C. **计划不是执行**。产出只是计划对象与报告;真实 apply/migration 属于单独的
 *      owner gate,本模块不提供写路径(`applyAuthorized` 恒为 false)。
 *
 * 计划对同一输入是确定性的(entries 按 seq 排序,digest 只覆盖判定内容),
 * 因此重复 dry-run 必然产出同一 `planDigest`。
 */

import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ledgerDbPath, ledgerExists } from './state-ledger.ts'

export const REPAIR_PLAN_SCHEMA = 'gotry.ledger-repair-plan/1'

/** 判定:搬移 / 原地保留 / 拒绝(拒绝 = 计划不可 apply) */
export type RepairDecision = 'move' | 'retain' | 'reject'

/** 人工确认的证据映射条目——evidence 是硬前置,不可为空 */
export interface RepairEvidenceMapping {
  seq: number
  fromTenant: string
  toTenant: string
  evidence: string
}

export interface CandidateEvent {
  seq: number
  tenantId: string
  ts: string
  actor: string
  kind: string
  subjectId: string
  idemKey: string | null
}

export interface PlanEntry {
  seq: number
  kind: string
  subjectId: string
  idemKey: string | null
  ts: string
  decision: RepairDecision
  beforeTenant: string
  afterTenant: string
  /** 机器可断言的理由码 */
  reason: string
  /** 人读补充 */
  detail: string
  evidence: string | null
}

/** 映射条目本身不合法时的拒绝记录(没有对应事件,单列) */
export interface RejectedMapping {
  index: number
  reason: string
  detail: string
  raw: unknown
}

export interface TenantCount {
  tenant: string
  events: number
}

export interface RepairPlan {
  schema: typeof REPAIR_PLAN_SCHEMA
  dbPath: string
  sourceTenant: string
  /** 全库租户分布(before)与按计划模拟后的分布(after)——可审计的 before/after */
  tenantCensusBefore: TenantCount[]
  tenantCensusAfter: TenantCount[]
  entries: PlanEntry[]
  rejectedMappings: RejectedMapping[]
  totals: {
    candidates: number
    move: number
    retain: number
    reject: number
    rejectedMappings: number
  }
  /** 无冲突且确有搬移时为 true;仍**不**代表被授权执行 */
  applyable: boolean
  /** 本切片恒为 false:真实 apply 在单独 owner gate 后 */
  applyAuthorized: false
  planDigest: string
  notes: string[]
}

// ---- 理由码 ------------------------------------------------------------------

export const REASON = {
  NO_EVIDENCE: 'no_explicit_evidence',
  MAPPED: 'explicit_evidence_mapping',
  MAPPING_NOT_OBJECT: 'mapping_not_object',
  MAPPING_SEQ_INVALID: 'mapping_seq_invalid',
  MAPPING_FROM_INVALID: 'mapping_from_tenant_invalid',
  MAPPING_TO_INVALID: 'mapping_to_tenant_invalid',
  MAPPING_EVIDENCE_MISSING: 'mapping_evidence_missing',
  MAPPING_DUPLICATE_SEQ: 'mapping_duplicate_seq',
  MAPPING_OUT_OF_SCOPE: 'mapping_from_tenant_out_of_scope',
  EVENT_NOT_IN_SCOPE: 'event_not_found_in_scope',
  TARGET_EQUALS_SOURCE: 'target_tenant_equals_source',
  IDEM_CONFLICT: 'target_idem_key_conflict',
  SUBJECT_CONFLICT: 'target_subject_conflict',
} as const

export const REPAIR_MAPPING_ROOT_NOT_ARRAY = 'mapping_root_not_array'

// ---- 只读句柄 ----------------------------------------------------------------

/** WAL 形态下 DB 的全部物理组成:主库 + -wal + -shm,缺一不可完整复制 */
const DB_SIDECARS = ['', '-wal', '-shm'] as const

/**
 * 在**账本的临时不可变副本**上执行 fn。
 *
 * 为什么不直接只读打开正本:SQLite 以 readonly 打开一个 WAL 模式库时,仍需要
 * 建立 `-shm`(必要时还有 `-wal`)共享内存索引——实测这会在正本目录里**凭空生成
 * 两个 sidecar 文件**,只读连接又无权在关闭时 checkpoint 清理它们。对一个数据
 * 修复巡检工具来说,「读一下就在现场留下文件」是不可接受的。
 *
 * 所以零写在这里是**结构性**的:正本自始至终没有被任何 SQLite 连接打开过,
 * 只被 copyFileSync 读了一遍。sidecar 一并复制,保证未 checkpoint 的 WAL 数据
 * 也在视图内(直接只拷主库会读到陈旧状态)。
 *
 * 前提:复制期间账本无并发写入。修复巡检本就应在静默的账本上做。
 */
export function withImmutableLedgerCopy<T>(stateRoot: string, fn: (db: Database.Database) => T): T {
  const src = ledgerDbPath(stateRoot)
  if (!ledgerExists(stateRoot)) throw new Error(`账本不存在(未迁移 root):${src}`)
  const scratch = mkdtempSync(join(tmpdir(), 'gotry-repair-plan-'))
  try {
    const dest = join(scratch, 'ledger-copy.db')
    for (const suffix of DB_SIDECARS) {
      if (existsSync(src + suffix)) copyFileSync(src + suffix, dest + suffix)
    }
    // 副本上再叠一层 readonly:即便有 bug 想写,也在 SQLite 引擎层被拒。
    const db = new Database(dest, { readonly: true, fileMustExist: true })
    try {
      return fn(db)
    } finally {
      db.close()
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

function eventsHasTenantColumn(db: Database.Database): boolean {
  const cols = db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>
  return cols.some(c => c.name === 'tenant_id')
}

function eventsTableExists(db: Database.Database): boolean {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'").get() !== undefined
}

// ---- inventory ---------------------------------------------------------------

export interface LedgerInventory {
  dbPath: string
  /** v1 形态(events 无 tenant_id):全部事件在物理上就只有 local 一种归属 */
  schemaShape: 'v1-no-tenant-column' | 'v2-tenant-scoped'
  tenantCensus: TenantCount[]
  candidates: CandidateEvent[]
}

/**
 * 只读盘点:全库租户分布 + 源 tenant scope 下的候选事件。
 * v1 形态(无 tenant_id 列)按 `local` 呈现,绝不就地迁移。
 */
export function inventoryLedger(db: Database.Database, dbPath: string, sourceTenant: string): LedgerInventory {
  if (!eventsTableExists(db)) {
    return { dbPath, schemaShape: 'v2-tenant-scoped', tenantCensus: [], candidates: [] }
  }
  const hasTenant = eventsHasTenantColumn(db)
  if (!hasTenant) {
    const rows = db.prepare(
      `SELECT seq, ts, actor, kind, subject_id, idem_key FROM events ORDER BY seq`,
    ).all() as Array<{ seq: number; ts: string; actor: string; kind: string; subject_id: string; idem_key: string | null }>
    const candidates = sourceTenant === 'local'
      ? rows.map(r => ({
          seq: r.seq, tenantId: 'local', ts: r.ts, actor: r.actor,
          kind: r.kind, subjectId: r.subject_id, idemKey: r.idem_key,
        }))
      : []
    return {
      dbPath,
      schemaShape: 'v1-no-tenant-column',
      tenantCensus: rows.length ? [{ tenant: 'local', events: rows.length }] : [],
      candidates,
    }
  }
  const census = db.prepare(
    `SELECT tenant_id AS tenant, COUNT(*) AS events FROM events GROUP BY tenant_id ORDER BY tenant_id`,
  ).all() as TenantCount[]
  const candidates = (db.prepare(
    `SELECT seq, tenant_id, ts, actor, kind, subject_id, idem_key
     FROM events WHERE tenant_id = ? ORDER BY seq`,
  ).all(sourceTenant) as Array<{ seq: number; tenant_id: string; ts: string; actor: string; kind: string; subject_id: string; idem_key: string | null }>)
    .map(r => ({
      seq: r.seq, tenantId: r.tenant_id, ts: r.ts, actor: r.actor,
      kind: r.kind, subjectId: r.subject_id, idemKey: r.idem_key,
    }))
  return { dbPath, schemaShape: 'v2-tenant-scoped', tenantCensus: census, candidates }
}

// ---- 证据映射解析(fail-closed) -----------------------------------------------

export interface ParsedMappings {
  valid: RepairEvidenceMapping[]
  rejected: RejectedMapping[]
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== ''
}

/**
 * 解析映射数组。任何一条不合法只影响它自己(记为 rejected),但整个计划因此
 * 不可 apply——**绝不**「跳过坏条目继续搬好条目」地默默降级。
 */
export function parseEvidenceMappings(raw: unknown, sourceTenant: string): ParsedMappings {
  const valid: RepairEvidenceMapping[] = []
  const rejected: RejectedMapping[] = []
  if (raw === undefined || raw === null) return { valid, rejected }
  if (!Array.isArray(raw)) {
    return { valid, rejected: [{ index: -1, reason: REPAIR_MAPPING_ROOT_NOT_ARRAY, detail: '映射文件根节点必须是数组', raw }] }
  }
  const seen = new Map<number, number>()
  raw.forEach((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      rejected.push({ index, reason: REASON.MAPPING_NOT_OBJECT, detail: '映射条目必须是对象', raw: item })
      return
    }
    const m = item as Record<string, unknown>
    if (!isPositiveInt(m['seq'])) {
      rejected.push({ index, reason: REASON.MAPPING_SEQ_INVALID, detail: 'seq 必须是正整数', raw: item })
      return
    }
    const seq = m['seq']
    if (!nonEmptyString(m['fromTenant'])) {
      rejected.push({ index, reason: REASON.MAPPING_FROM_INVALID, detail: 'fromTenant 必须是非空字符串', raw: item })
      return
    }
    if (!nonEmptyString(m['toTenant'])) {
      rejected.push({ index, reason: REASON.MAPPING_TO_INVALID, detail: 'toTenant 必须是非空字符串', raw: item })
      return
    }
    if (!nonEmptyString(m['evidence'])) {
      rejected.push({ index, reason: REASON.MAPPING_EVIDENCE_MISSING, detail: 'evidence 必填且非空——无证据不得搬移', raw: item })
      return
    }
    if (m['fromTenant'].trim() !== sourceTenant) {
      rejected.push({ index, reason: REASON.MAPPING_OUT_OF_SCOPE, detail: `fromTenant 必须等于本次 scope 的源租户 ${sourceTenant}`, raw: item })
      return
    }
    const prev = seen.get(seq)
    if (prev !== undefined) {
      rejected.push({ index, reason: REASON.MAPPING_DUPLICATE_SEQ, detail: `seq ${seq} 已在第 ${prev} 条出现,重复映射意图不明`, raw: item })
      return
    }
    seen.set(seq, index)
    valid.push({
      seq,
      fromTenant: m['fromTenant'].trim(),
      toTenant: m['toTenant'].trim(),
      evidence: m['evidence'].trim(),
    })
  })
  return { valid, rejected }
}

/** 读映射文件;文件缺失/非 JSON 一律抛错(fail-closed,不退化成「无映射」) */
export function loadEvidenceMappingFile(path: string): unknown {
  let text: string
  try {
    text = readFileSync(path, 'utf-8')
  } catch {
    throw new Error(`证据映射文件不可读:${path}`)
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(`证据映射文件不是合法 JSON:${path}`)
  }
}

// ---- 计划 --------------------------------------------------------------------

function canonical(entries: PlanEntry[], sourceTenant: string): string {
  const lines = entries.map(e =>
    [e.seq, e.decision, e.beforeTenant, e.afterTenant, e.reason, e.kind, e.subjectId, e.idemKey ?? ''].join(' '),
  )
  return [sourceTenant, ...lines].join('\n')
}

/**
 * 构造 dry-run 计划。纯函数式:只读 db、只算、不写。
 *
 * 冲突检测覆盖 issue 点名的两类跨租户同 id 场景:
 *   - 目标租户已存在同 `idem_key`(events_idem 唯一索引会撞)→ reject
 *   - 目标租户已存在同 kind+subject_id(如同 `wish_id`)→ reject
 * 两者都只判定不改动,冲突事件留在原地。
 */
export function buildRepairPlan(
  db: Database.Database,
  opts: { stateRoot: string; sourceTenant: string; mappings?: unknown },
): RepairPlan {
  const dbPath = ledgerDbPath(opts.stateRoot)
  const sourceTenant = opts.sourceTenant
  const inv = inventoryLedger(db, dbPath, sourceTenant)
  const { valid, rejected } = parseEvidenceMappings(opts.mappings, sourceTenant)

  const bySeq = new Map<number, CandidateEvent>()
  for (const c of inv.candidates) bySeq.set(c.seq, c)

  const hasTenant = inv.schemaShape === 'v2-tenant-scoped'
  const idemHit = hasTenant
    ? db.prepare(`SELECT 1 AS hit FROM events WHERE tenant_id = ? AND idem_key = ? LIMIT 1`)
    : null
  const subjectHit = hasTenant
    ? db.prepare(`SELECT 1 AS hit FROM events WHERE tenant_id = ? AND kind = ? AND subject_id = ? LIMIT 1`)
    : null

  const decided = new Map<number, PlanEntry>()

  for (const m of valid) {
    const ev = bySeq.get(m.seq)
    if (!ev) {
      // seq 不在源 scope 内:可能不存在,也可能属于别的租户——都不许动
      decided.set(m.seq, {
        seq: m.seq, kind: '<unknown>', subjectId: '<unknown>', idemKey: null, ts: '<unknown>',
        decision: 'reject', beforeTenant: sourceTenant, afterTenant: sourceTenant,
        reason: REASON.EVENT_NOT_IN_SCOPE,
        detail: `seq ${m.seq} 不在源租户 ${sourceTenant} 的事件范围内`,
        evidence: m.evidence,
      })
      continue
    }
    const base = {
      seq: ev.seq, kind: ev.kind, subjectId: ev.subjectId, idemKey: ev.idemKey, ts: ev.ts,
      beforeTenant: ev.tenantId, evidence: m.evidence,
    }
    if (m.toTenant === sourceTenant) {
      decided.set(ev.seq, {
        ...base, decision: 'reject', afterTenant: ev.tenantId,
        reason: REASON.TARGET_EQUALS_SOURCE, detail: '目标租户与源租户相同,无搬移语义',
      })
      continue
    }
    if (!hasTenant) {
      // v1 形态没有 tenant_id 列,任何搬移都得先做 schema 迁移——不在只读计划的能力内
      decided.set(ev.seq, {
        ...base, decision: 'reject', afterTenant: ev.tenantId,
        reason: REASON.EVENT_NOT_IN_SCOPE,
        detail: 'v1 形态账本(events 无 tenant_id 列)无法在不迁移 schema 的前提下计划搬移',
      })
      continue
    }
    if (ev.idemKey !== null && idemHit!.get(m.toTenant, ev.idemKey) !== undefined) {
      decided.set(ev.seq, {
        ...base, decision: 'reject', afterTenant: ev.tenantId,
        reason: REASON.IDEM_CONFLICT,
        detail: `目标租户 ${m.toTenant} 已存在同 idem_key「${ev.idemKey}」,搬移会撞唯一索引`,
      })
      continue
    }
    // subject 冲突只对具名主体有意义;subject_id 为空的日志类事件(forget.executed 等)
    // 天然同名,不能据此判冲突,否则会把合法搬移误拒。
    if (ev.subjectId !== '' && subjectHit!.get(m.toTenant, ev.kind, ev.subjectId) !== undefined) {
      decided.set(ev.seq, {
        ...base, decision: 'reject', afterTenant: ev.tenantId,
        reason: REASON.SUBJECT_CONFLICT,
        detail: `目标租户 ${m.toTenant} 已存在同 ${ev.kind}/${ev.subjectId},归属需人工再确认`,
      })
      continue
    }
    decided.set(ev.seq, {
      ...base, decision: 'move', afterTenant: m.toTenant,
      reason: REASON.MAPPED, detail: `依据人工证据搬移到 ${m.toTenant}`,
    })
  }

  // 未被映射覆盖的候选事件:一律原地保留
  const entries: PlanEntry[] = []
  for (const c of inv.candidates) {
    const d = decided.get(c.seq)
    if (d) { entries.push(d); continue }
    entries.push({
      seq: c.seq, kind: c.kind, subjectId: c.subjectId, idemKey: c.idemKey, ts: c.ts,
      decision: 'retain', beforeTenant: c.tenantId, afterTenant: c.tenantId,
      reason: REASON.NO_EVIDENCE, detail: '无显式证据映射,原地保留(不做任何归属推测)',
      evidence: null,
    })
  }
  // 映射指向 scope 外 seq 的拒绝项也要出现在计划里
  for (const [seq, d] of decided) if (!bySeq.has(seq)) entries.push(d)
  entries.sort((a, b) => a.seq - b.seq)

  const moves = entries.filter(e => e.decision === 'move')
  const rejects = entries.filter(e => e.decision === 'reject')
  const retains = entries.filter(e => e.decision === 'retain')

  // after 分布:纯内存模拟
  const after = new Map<string, number>()
  for (const t of inv.tenantCensus) after.set(t.tenant, t.events)
  for (const m of moves) {
    after.set(m.beforeTenant, (after.get(m.beforeTenant) ?? 0) - 1)
    after.set(m.afterTenant, (after.get(m.afterTenant) ?? 0) + 1)
  }
  const tenantCensusAfter = [...after.entries()]
    .filter(([, n]) => n > 0)
    .map(([tenant, events]) => ({ tenant, events }))
    .sort((a, b) => a.tenant.localeCompare(b.tenant))

  const blocked = rejects.length > 0 || rejected.length > 0
  const notes = [
    '本报告是 dry-run:未对账本做任何写入(正本从未被打开,只在临时副本上只读读取)。',
    '未提供显式证据映射的事件一律原地保留;本工具不做任何归属推测。',
    '真实 apply/migration 属于单独的 owner gate,本切片不提供写路径。',
  ]
  if (blocked) notes.push('存在被拒条目,计划整体不可 apply——请先人工消解冲突或补充证据。')
  if (inv.schemaShape === 'v1-no-tenant-column') {
    notes.push('账本为 v1 形态(events 无 tenant_id 列):全部事件物理上只有 local 归属;本工具只读呈现,不就地迁移 schema。')
  }

  const planDigest = createHash('sha256').update(canonical(entries, sourceTenant)).digest('hex').slice(0, 16)

  return {
    schema: REPAIR_PLAN_SCHEMA,
    dbPath,
    sourceTenant,
    tenantCensusBefore: inv.tenantCensus,
    tenantCensusAfter,
    entries,
    rejectedMappings: rejected,
    totals: {
      candidates: inv.candidates.length,
      move: moves.length,
      retain: retains.length,
      reject: rejects.length,
      rejectedMappings: rejected.length,
    },
    applyable: !blocked && moves.length > 0,
    applyAuthorized: false,
    planDigest,
  notes,
  }
}

/** 一次性只读入口:临时不可变副本 → 出计划 → 清理副本(正本零触碰) */
export function planLedgerRepair(opts: { stateRoot: string; sourceTenant?: string; mappings?: unknown }): RepairPlan {
  return withImmutableLedgerCopy(opts.stateRoot, db =>
    buildRepairPlan(db, {
      stateRoot: opts.stateRoot,
      sourceTenant: opts.sourceTenant ?? 'local',
      mappings: opts.mappings,
    }),
  )
}

// ---- 报告 --------------------------------------------------------------------

function census(list: TenantCount[]): string {
  return list.length ? list.map(t => `${t.tenant}=${t.events}`).join(' ') : '(空)'
}

/** 人读 before/after 报告(确定性:同一计划逐字节相同) */
export function formatRepairPlan(plan: RepairPlan): string {
  const out: string[] = []
  out.push(`账本 tenant 修复计划(dry-run,零写)`)
  out.push(`db: ${plan.dbPath}`)
  out.push(`源租户 scope: ${plan.sourceTenant}`)
  out.push(`租户分布 before: ${census(plan.tenantCensusBefore)}`)
  out.push(`租户分布 after : ${census(plan.tenantCensusAfter)}`)
  out.push('')
  out.push(`候选 ${plan.totals.candidates} / 搬移 ${plan.totals.move} / 保留 ${plan.totals.retain} / 拒绝 ${plan.totals.reject} / 非法映射 ${plan.totals.rejectedMappings}`)
  out.push('')
  if (plan.entries.length === 0) {
    out.push('(源租户 scope 下无候选事件)')
  } else {
    out.push(`  seq  判定      before -> after            kind/subject                      理由`)
    for (const e of plan.entries) {
      const move = `${e.beforeTenant} -> ${e.afterTenant}`
      out.push(
        `${String(e.seq).padStart(5)}  ${e.decision.padEnd(8)}  ${move.padEnd(24)}  ${`${e.kind}/${e.subjectId}`.padEnd(32)}  ${e.reason}`,
      )
    }
  }
  if (plan.rejectedMappings.length) {
    out.push('')
    out.push('非法映射条目(不产生任何搬移):')
    for (const r of plan.rejectedMappings) {
      out.push(`  #${r.index}  ${r.reason}  ${r.detail}`)
    }
  }
  out.push('')
  for (const n of plan.notes) out.push(`* ${n}`)
  out.push('')
  out.push(`applyable=${plan.applyable} applyAuthorized=${plan.applyAuthorized}`)
  out.push(`plan-digest=${plan.planDigest}`)
  return out.join('\n')
}
