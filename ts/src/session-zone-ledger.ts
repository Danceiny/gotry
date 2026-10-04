/**
 * 会话双区记忆的账本落点(P4-2,docs/design/session-dual-zone-memory-design.md §2):
 * 把 P4-1 纯核(session-zones.ts)的六个边界事件落到**既有** events 表上,零新表、
 * 零 schema 迁移、对内核钉死的 state-ledger.ts 零改动——只走它的公开面
 * (`db.transaction` / `readEvents` / `insertEvent` / `forgetSubject`)。
 *
 *  - 写路径 = 单事务{fold 读当前 revs;守门闸;INSERT}:守门在事务内,拒绝即回滚,
 *    账本无痕(与 motivation/wish 红线同纪律)。批量写共用一个事务 → 全有或全无。
 *  - 幂等键 = P4-1 的 `zoneIdemKey`(物理化为 events 表的 UNIQUE 部分索引):同一
 *    rev 的重放在守门层返回 appended:false,万一绕过守门也会在 UNIQUE 处变成物理
 *    no-op(insertEvent 返回 null)——两道都保证「同 rev 重放零新行」。
 *  - 读路径 = `readEvents(kind)` ×6 + P4-1 的确定性 fold(`readTrips`/
 *    `projectUtilityNow` 同款):无持久投影(P4 v1 单用户量级下读时 fold 够用)。
 *    过期是读时视图,不是事件——墙钟动作不进 append-only 账本。
 *  - 删除 = 既有 `forgetSubject`(物理硬删 + 审计一行;红线 6「可删除」);
 *    会话级遗忘把该会话全部主体放进**一次** forgetSubject 调用 → 仍只留一行审计。
 *  - 导出 = 从 fold 派生的两个视图(`hot-context.jsonl` / `notebook.json`),
 *    state-cli export 单向写出;**视图永不是写路径**(导出零新事件)。
 *
 * 边界:本模块不接会话捕获缝/persona 读回(P4-3),不做观测与指标(P4-4);
 * 日志类事件在 state-ledger 的 `foldEvent` default 分支无投影,与
 * `trip.logged`/`memory_utility.event` 完全同形。
 */

import {
  ZONE_EVENT_KINDS,
  captureHotNote,
  dropHotNote,
  dropNotebookEntry,
  foldZoneEvents,
  makeHotNoteId,
  promoteHotNote,
  readNotebook,
  reviseHotNote,
  reviseNotebookEntry,
  zoneIdemKey,
  type HotCaptureInput,
  type HotNote,
  type HotReviseInput,
  type NotebookEntry,
  type NotebookReviseInput,
  type PromoteInput,
  type ZoneEvent,
  type ZoneEventKind,
  type ZoneState,
  type ZoneWriteErrorCode,
  type ZoneWriteResult,
} from './session-zones.ts'
import type { StateLedger } from './state-ledger.ts'

/** 工作区三事件(forget 的 hot 主体 kinds) */
export const HOT_ZONE_EVENT_KINDS: readonly ZoneEventKind[] = [
  'hotctx.note.captured',
  'hotctx.note.revised',
  'hotctx.note.dropped',
]
/** 笔记本三事件(forget 的 durable 主体 kinds) */
export const NOTEBOOK_ZONE_EVENT_KINDS: readonly ZoneEventKind[] = [
  'notebook.entry.promoted',
  'notebook.entry.revised',
  'notebook.entry.dropped',
]

/** 单 kind 读上界:触顶即 fail-closed(截断的日志 fold 出来的 rev 是错的,不许写) */
export const ZONE_LOG_READ_LIMIT = 20_000

/** 默认 actor(P4-3 的工具面会传各自的具名 actor) */
export const ZONE_DEFAULT_ACTOR = 'tool:gotry_session_zone'

/**
 * 账本层错误码闭集 = P4-1 写门码 + 两个物理化码:
 *  - `log_truncated`:读不全就不许写(不在截断日志上猜 rev);
 *  - `idem_collision`:守门闸说该追加,但幂等键已存在(同毫秒 drop→重捕获等生代碰撞)。
 *    **显式报错,不静默吞**:静默的 appended:false 会让调用方以为「幂等跳过」,
 *    实际上这次写入根本没发生。调用方换一个写入时刻重试即可。
 */
export type ZoneLedgerErrorCode = ZoneWriteErrorCode | 'log_truncated' | 'idem_collision'

export interface ZoneAppendOk {
  ok: true
  /** true=真落了一行事件;false=幂等 no-op(守门层同内容重放 或 UNIQUE 命中) */
  appended: boolean
  idemKey: string
  seq?: number
  event?: ZoneEvent
  detail?: string
}
export interface ZoneAppendErr {
  ok: false
  code: ZoneLedgerErrorCode
  detail: string
}
export type ZoneAppendResult = ZoneAppendOk | ZoneAppendErr

/** 写请求闭集(与 P4-1 五个写门 + 两个 drop 一一对应,外加一个组合写门) */
export type ZoneWriteRequest =
  | { op: 'capture'; input: HotCaptureInput }
  /**
   * 捕获或续命(组合写门:同 id 已存在 → touch 续 TTL,不存在 → 诞生)。
   * 为什么需要它:note_id 自「会话+层+kind+规范载荷」语义派生,所以**只有**同一
   * 语义片段会撞 id;而过期是读时视图——过期笔记仍在 fold 状态里,纯 capture 会
   * 以 stale_rev 拒收,于是「同一检索 30min 后再跑一次」永远刷不新那条笔记,
   * 工作区会悄悄停止供述该形态(P4-3 复查发现)。touch 是写入 → TTL 自新写入起算,
   * 过期笔记也因此复活;rev+1 保留血缘,不另起生代。
   */
  | { op: 'capture_or_touch'; input: HotCaptureInput }
  | { op: 'revise'; input: HotReviseInput }
  | { op: 'drop'; note_id: string; ts: string }
  | { op: 'promote'; input: PromoteInput }
  | { op: 'notebook_revise'; input: NotebookReviseInput }
  | { op: 'notebook_drop'; entry_id: string; ts: string }

export interface ZoneLogRead {
  /** 确定性 fold 结果(重建 == 直读) */
  state: ZoneState
  /** 按 seq 升序的事件序列(fold 的唯一输入) */
  events: ZoneEvent[]
  /** 某个 kind 触到读上界:日志可能不全 → 写路径 fail-closed */
  truncated: boolean
  /** 形状不合法的事件行数(确定性跳过;fold 本就不会投影它们) */
  malformed: number
}

interface ZoneEventRow {
  seq: number
  ts: string
  kind: string
  payload: string
}

/** 事件行 → ZoneEvent(形状不合法返回 null:确定性跳过,不猜) */
function rowToZoneEvent(row: ZoneEventRow): ZoneEvent | null {
  let payload: unknown
  try {
    payload = JSON.parse(row.payload)
  } catch {
    return null
  }
  if (typeof payload !== 'object' || payload === null) return null
  const p = payload as { note?: unknown; entry?: unknown; note_id?: unknown; entry_id?: unknown }
  switch (row.kind) {
    case 'hotctx.note.captured':
    case 'hotctx.note.revised':
      return typeof p.note === 'object' && p.note !== null
        ? { kind: row.kind, ts: row.ts, note: p.note as HotNote }
        : null
    case 'hotctx.note.dropped':
      return typeof p.note_id === 'string' && p.note_id.length > 0
        ? { kind: row.kind, ts: row.ts, note_id: p.note_id }
        : null
    case 'notebook.entry.promoted':
    case 'notebook.entry.revised':
      return typeof p.entry === 'object' && p.entry !== null
        ? { kind: row.kind, ts: row.ts, entry: p.entry as NotebookEntry }
        : null
    case 'notebook.entry.dropped':
      return typeof p.entry_id === 'string' && p.entry_id.length > 0
        ? { kind: row.kind, ts: row.ts, entry_id: p.entry_id }
        : null
    default:
      return null
  }
}

/** 事件 → 落账载荷(与 `trip.logged` 的 `{ trip }` 同形:变更后全量文档随事件走) */
function eventPayload(ev: ZoneEvent): { subjectId: string; payload: Record<string, unknown> } {
  switch (ev.kind) {
    case 'hotctx.note.captured':
    case 'hotctx.note.revised':
      return { subjectId: ev.note.note_id, payload: { note: ev.note } }
    case 'hotctx.note.dropped':
      return { subjectId: ev.note_id, payload: { note_id: ev.note_id } }
    case 'notebook.entry.promoted':
    case 'notebook.entry.revised':
      return { subjectId: ev.entry.entry_id, payload: { entry: ev.entry } }
    case 'notebook.entry.dropped':
      return { subjectId: ev.entry_id, payload: { entry_id: ev.entry_id } }
  }
}

/**
 * 读分区日志:六个 kind 各自 `readEvents` → 按 seq 升序归并 → P4-1 确定性 fold。
 * 任一 kind 触到 limit 即 truncated(写路径据此 fail-closed:截断日志的 rev 不可信)。
 */
export function readZoneLog(ledger: StateLedger, opts: { limit?: number } = {}): ZoneLogRead {
  const limit = opts.limit ?? ZONE_LOG_READ_LIMIT
  const rows: ZoneEventRow[] = []
  let truncated = false
  for (const kind of ZONE_EVENT_KINDS) {
    const batch = ledger.readEvents(kind, limit)
    if (batch.length >= limit) truncated = true
    for (const r of batch) rows.push({ seq: r.seq, ts: r.ts, kind: r.kind, payload: r.payload })
  }
  rows.sort((a, b) => a.seq - b.seq)
  const events: ZoneEvent[] = []
  let malformed = 0
  for (const row of rows) {
    const ev = rowToZoneEvent(row)
    if (ev === null) malformed++
    else events.push(ev)
  }
  return { state: foldZoneEvents(events), events, truncated, malformed }
}

/** 单请求过 P4-1 写门(账本层不重写任何算术/闸语义,只转发) */
function gateRequest(state: ZoneState, req: ZoneWriteRequest): ZoneWriteResult {
  switch (req.op) {
    case 'capture':
      return captureHotNote(state, req.input)
    case 'capture_or_touch': {
      // 先走 capture 的完整闸链(闭集/形状/有界/负面清单/时钟);只有「同 id 已存在」
      // 这一种拒收(stale_rev)才转成续命写入——其余拒收原样上报,闸语义零放宽。
      const birth = captureHotNote(state, req.input)
      if (birth.ok || birth.code !== 'stale_rev') return birth
      const noteId = makeHotNoteId({
        session_ref: req.input.session_ref,
        tier: req.input.tier,
        kind: req.input.kind,
        payload: req.input.payload,
      })
      const cur = noteId === null ? undefined : state.hot[noteId]
      if (!cur) return birth
      // 同一写入时刻的同形重放:TTL 已自该时刻起算,再续一次只是空转 rev → 幂等 no-op。
      // (id 由会话+层+kind+规范载荷派生,所以撞到这里时载荷与 kind 必然相同,只有 ts 可能不同。)
      if (cur.last_touched_at === req.input.ts) {
        return {
          ok: true,
          appended: false,
          idemKey: zoneIdemKey({ kind: 'hotctx.note.revised', ts: req.input.ts, note: cur }),
          detail: '同写入时刻同形重放:幂等 no-op(TTL 已自该时刻起算)',
        }
      }
      // 同语义片段再次出现 = 续命写入(TTL 自本次写入起算;过期笔记据此复活)
      return reviseHotNote(state, {
        note_id: cur.note_id,
        expected_rev: cur.rev,
        payload: req.input.payload,
        kind: req.input.kind,
        ts: req.input.ts,
      })
    }
    case 'revise':
      return reviseHotNote(state, req.input)
    case 'drop':
      return dropHotNote(state, req.note_id, req.ts)
    case 'promote':
      return promoteHotNote(state, req.input)
    case 'notebook_revise':
      return reviseNotebookEntry(state, req.input)
    case 'notebook_drop':
      return dropNotebookEntry(state, req.entry_id, req.ts)
  }
}

export interface ZoneAppendOptions {
  actor?: string
  limit?: number
  /**
   * 测试缝(崩溃注入):全部 INSERT 完成、事务**尚未提交**时调用。
   * 产品路径永不传;仅用于证明 kill -9 后要么全有要么全无。
   */
  beforeCommit?: () => void
}

/** 批量写被拒时的回滚载体(事务内抛出 → better-sqlite3 回滚 → 外层取回结果) */
class ZoneBatchRejected extends Error {
  readonly results: ZoneAppendResult[]
  constructor(results: ZoneAppendResult[]) {
    super('zone batch rejected')
    this.results = results
  }
}

/**
 * 批量追加(单事务,全有或全无):
 *  - 事务内先 fold 读一次当前状态,逐请求过闸并把已接受的事件并入在算状态
 *    (批内自洽:同一事务里 capture→revise 的 rev CAS 成立);
 *  - 任一请求被拒 → 抛出 → 整个事务回滚 → 账本零新行,返回逐项结果;
 *  - 日志截断 → 第一项即 `log_truncated`,零写入(不在不全的日志上猜 rev)。
 */
export function appendZoneWrites(
  ledger: StateLedger,
  requests: readonly ZoneWriteRequest[],
  opts: ZoneAppendOptions = {},
): ZoneAppendResult[] {
  if (requests.length === 0) return []
  const actor = opts.actor ?? ZONE_DEFAULT_ACTOR
  const run = ledger.db.transaction((): ZoneAppendResult[] => {
    const read = readZoneLog(ledger, { limit: opts.limit })
    if (read.truncated) {
      throw new ZoneBatchRejected([
        { ok: false, code: 'log_truncated', detail: `分区事件日志触到读上界(${opts.limit ?? ZONE_LOG_READ_LIMIT});截断日志的 rev 不可信,写路径 fail-closed` },
      ])
    }
    const events = [...read.events]
    let state = read.state
    const results: ZoneAppendResult[] = []
    for (const req of requests) {
      const gate = gateRequest(state, req)
      if (!gate.ok) {
        results.push({ ok: false, code: gate.code, detail: gate.detail })
        throw new ZoneBatchRejected(results)
      }
      if (!gate.appended) {
        results.push({ ok: true, appended: false, idemKey: gate.idemKey, detail: gate.detail })
        continue
      }
      const ev = gate.event!
      const { subjectId, payload } = eventPayload(ev)
      const seq = ledger.insertEvent({ actor, kind: ev.kind, subjectId, payload, idemKey: gate.idemKey, ts: ev.ts })
      if (seq === null) {
        // 守门闸刚说该追加(fold 里没有这条),却撞上既有幂等键 → 生代碰撞:
        // 同一毫秒内 capture→drop→重捕获会复用 `<id>:<created_at>:1`。这不是幂等重放,
        // 而是**这次写入没发生**。静默报 appended:false 会骗调用方,所以显式失败、整批回滚。
        results.push({
          ok: false,
          code: 'idem_collision',
          detail: `幂等键已存在但 fold 中无此主体(生代碰撞:${gate.idemKey});本次写入未发生,请用不同的写入时刻重试`,
        })
        throw new ZoneBatchRejected(results)
      }
      events.push(ev)
      state = foldZoneEvents(events)
      results.push({ ok: true, appended: true, idemKey: gate.idemKey, seq, event: ev })
    }
    opts.beforeCommit?.()
    return results
  })
  try {
    return run()
  } catch (e) {
    if (e instanceof ZoneBatchRejected) return e.results
    throw e
  }
}

/** 单请求追加(批量的 1 元特例) */
export function appendZoneWrite(
  ledger: StateLedger,
  request: ZoneWriteRequest,
  opts: ZoneAppendOptions = {},
): ZoneAppendResult {
  return appendZoneWrites(ledger, [request], opts)[0]!
}

// ---- 遗忘(红线 6:物理硬删 + 审计一行) -------------------------------------------

export interface ZoneForgetSubject {
  zone: 'hot_context' | 'trip_notebook'
  id: string
}

/** 主体级遗忘:一次 forgetSubject 调用 → 物理删除全部相关事件 + 恰一行审计 */
export function forgetZoneSubjects(
  ledger: StateLedger,
  subjects: readonly ZoneForgetSubject[],
  actor = 'system:state-cli',
): { deleted: number; subjects: number } {
  if (subjects.length === 0) return { deleted: 0, subjects: 0 }
  const specs = subjects.map(s => ({
    kinds: [...(s.zone === 'hot_context' ? HOT_ZONE_EVENT_KINDS : NOTEBOOK_ZONE_EVENT_KINDS)],
    subjectId: s.id,
  }))
  const r = ledger.forgetSubject(specs, actor)
  return { deleted: r.deleted, subjects: specs.length }
}

/**
 * 会话级遗忘:该会话的全部工作区笔记 + 血缘指向该会话的全部笔记本条目,
 * 放进**一次** forgetSubject 调用 → 仍只留一行审计(「删除本身留一行」)。
 *
 * 截断即拒(fail-closed):主体集合是从 fold 推出来的,而 `readEvents` 触到读上界时
 * 丢的是**最老**的事件——在截断日志上做遗忘会静默漏删主体,红线 6「可删除」就
 * fail-open 了。宁可报错让调用方提高上界/先归档,也不假装删干净了。
 */
export function forgetZoneSession(
  ledger: StateLedger,
  sessionRef: string,
  actor = 'system:state-cli',
  opts: { limit?: number } = {},
): { ok: true; deleted: number; subjects: number } | { ok: false; code: 'log_truncated'; detail: string } {
  const { state, truncated } = readZoneLog(ledger, opts)
  if (truncated) {
    return {
      ok: false,
      code: 'log_truncated',
      detail: `分区事件日志触到读上界(${opts.limit ?? ZONE_LOG_READ_LIMIT}):截断日志会漏掉最老的主体,遗忘拒绝在不完整视图上执行`,
    }
  }
  const subjects: ZoneForgetSubject[] = []
  for (const note of Object.values(state.hot)) {
    if (note.session_ref === sessionRef) subjects.push({ zone: 'hot_context', id: note.note_id })
  }
  for (const entry of Object.values(state.notebook)) {
    if (entry.origin?.session_ref === sessionRef) subjects.push({ zone: 'trip_notebook', id: entry.entry_id })
  }
  const r = forgetZoneSubjects(ledger, subjects, actor)
  return { ok: true, deleted: r.deleted, subjects: r.subjects }
}

// ---- 导出视图(从 fold 派生;单向 DB→文件,永不是写路径) --------------------------

export const ZONE_EXPORT_HOT_FILE = 'hot-context.jsonl'
export const ZONE_EXPORT_NOTEBOOK_FILE = 'notebook.json'

export interface ZoneExportViews {
  /** 每行一条工作区笔记(note_id 确定序);空 = '' */
  hotContextJsonl: string
  /** 笔记本全量数组(entry_id 确定序);空 = '[]' */
  notebookJson: string
}

/**
 * 两个派生视图:直接取 fold 结果渲染,确定性排序。
 * hot 视图导出的是 fold 里**未被 drop** 的全部笔记(每条自带 ttl_expires_at,
 * 过期判定留给读者/同一纯函数)——导出不引入第二个过期口径。
 */
export function renderZoneExportViews(state: ZoneState): ZoneExportViews {
  const notes = Object.values(state.hot).sort((a, b) => (a.note_id < b.note_id ? -1 : 1))
  return {
    hotContextJsonl: notes.length ? notes.map(n => JSON.stringify(n)).join('\n') + '\n' : '',
    notebookJson: JSON.stringify(readNotebook(state), null, 2),
  }
}

/**
 * 账本 → 导出视图(导出面唯一入口;截断即拒 fail-closed)。
 * 「可见可导出」同样不能 fail-open:截断日志导出的是**残缺**视图,而读者会把
 * 它当全量。纯渲染器 `renderZoneExportViews` 留给已确认完整的 state 使用。
 */
export function readZoneExportViews(
  ledger: StateLedger,
  opts: { limit?: number } = {},
): { ok: true; views: ZoneExportViews } | { ok: false; code: 'log_truncated'; detail: string } {
  const { state, truncated } = readZoneLog(ledger, opts)
  if (truncated) {
    return {
      ok: false,
      code: 'log_truncated',
      detail: `分区事件日志触到读上界(${opts.limit ?? ZONE_LOG_READ_LIMIT}):导出拒绝输出残缺视图(读者会把它当全量)`,
    }
  }
  return { ok: true, views: renderZoneExportViews(state) }
}
