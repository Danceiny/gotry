/**
 * 会话双区记忆分区契约纯核(P4-1,docs/design/session-dual-zone-memory-design.md):
 * 一个账本上的两个分区——会话工作区(hot_context:随会话生灭,30min/24h 分层快过期,
 * 永不 owner 确认)与持久笔记本(trip_notebook:跨会话存活,唯一入口是 owner 确认晋升,
 * 模型只可提议,永不自晋升)。
 *
 * 本模块只交契约核,纯函数、零 IO、零定时器、零网络、零 import:
 *  - 闭集:zone(hot_context|trip_notebook)/tier/kind/确认表面/事件 kind,未知拒收;
 *  - 写侧负面清单(设计 §4 双重负面清单的写侧,companions 守卫同族):
 *    证件号/手机号/URL/凭证形态零入区;证据只走指针(session_ref+turn)与有界引用;
 *  - owner 确认引用闸:缺引用或引用超界拒收(ADR-14「归因只认 owner 确认」落到存储面);
 *  - rev CAS:同 rev 同内容的重放是幂等 no-op;父 rev ≠ 当前 fold rev → stale_rev
 *    fail-closed(类型化错误词表,乐观修订在插入前被拒);
 *  - 注入时钟的分层 TTL:resource 30min / intent 24h,自**写入**起算(读不续命);
 *    过期不是事件,是读时纯函数视图(墙钟动作不进 append-only 账本,fold 才可确定);
 *  - 确定性 fold:事件序列 → 分区状态,重建 == 直读(state-ledger 投影纪律的纯核版)。
 *
 * 边界(P4-2/P4-3 的事,本 PR 不做):不接账本(state-ledger.ts 零改动,内核 manifest
 * 零漂移);不接会话捕获缝/persona 读回;导出侧负面清单属 P4-4 观测面。
 * 期限语义:live ⇔ now < ttl_expires_at(到期瞬间即过期);坏时钟/坏时间戳 fail-closed。
 */

// ---- 闭集(类型化;未知值在守门处拒收,fold 对伪造文档拒投影) ---------------------

export const SESSION_ZONES = ['hot_context', 'trip_notebook'] as const
export type SessionZone = (typeof SESSION_ZONES)[number]

/** 工作区分层:resource=搜索结果/可售形态/价格带指针;intent=目的地/日期/人数/预算立场 */
export const HOT_TIERS = ['resource', 'intent'] as const
export type HotTier = (typeof HOT_TIERS)[number]

/** 工作区笔记 kind 闭集(设计 §1.1「kind (closed set)」的 v1 词表;载荷为 slot-spec 族结构片段) */
export const HOT_NOTE_KINDS = [
  'availability',
  'price_band',
  'destination',
  'date_window',
  'party_size',
  'budget_stance',
] as const
export type HotNoteKind = (typeof HOT_NOTE_KINDS)[number]

/** 笔记本条目 kind 闭集(设计 §1.2 明文) */
export const NOTEBOOK_KINDS = ['trip_fact', 'preference', 'constraint', 'lesson'] as const
export type NotebookKind = (typeof NOTEBOOK_KINDS)[number]

/** owner 确认表面闭集(设计 §1.2 owner_confirm.surface) */
export const CONFIRM_SURFACES = ['user_reply', 'approval_card'] as const
export type ConfirmSurface = (typeof CONFIRM_SURFACES)[number]

/** 六个边界事件 kind(设计 §1.3/§2;P4-2 以日志类事件落在既有 events 表) */
export const ZONE_EVENT_KINDS = [
  'hotctx.note.captured',
  'hotctx.note.revised',
  'hotctx.note.dropped',
  'notebook.entry.promoted',
  'notebook.entry.revised',
  'notebook.entry.dropped',
] as const
export type ZoneEventKind = (typeof ZONE_EVENT_KINDS)[number]

export function isSessionZone(v: unknown): v is SessionZone {
  return typeof v === 'string' && (SESSION_ZONES as readonly string[]).includes(v)
}
export function isHotTier(v: unknown): v is HotTier {
  return typeof v === 'string' && (HOT_TIERS as readonly string[]).includes(v)
}
export function isHotNoteKind(v: unknown): v is HotNoteKind {
  return typeof v === 'string' && (HOT_NOTE_KINDS as readonly string[]).includes(v)
}
export function isNotebookKind(v: unknown): v is NotebookKind {
  return typeof v === 'string' && (NOTEBOOK_KINDS as readonly string[]).includes(v)
}
export function isConfirmSurface(v: unknown): v is ConfirmSurface {
  return typeof v === 'string' && (CONFIRM_SURFACES as readonly string[]).includes(v)
}
export function isZoneEventKind(v: unknown): v is ZoneEventKind {
  return typeof v === 'string' && (ZONE_EVENT_KINDS as readonly string[]).includes(v)
}

// ---- 形状(设计 §1.1 HotNote / §1.2 NotebookEntry) --------------------------------

export interface ZoneEvidenceRef {
  /** dsh 会话转写内指针:不透明本地会话引用(无路径字符/有界;永不承载内容) */
  session_ref: string
  /** turn 序号(≥0;指针,不是转写文本) */
  turn: number
}

export interface HotNote {
  schema: 'session_zone_hot_note.v1'
  /** 诞生身份(自 session_ref/tier/kind/诞生载荷语义派生);后续修订不漂移 */
  note_id: string
  zone: 'hot_context'
  tier: HotTier
  kind: HotNoteKind
  /** 有界结构化片段(slot-spec 族类型;除有界引用外无自由文本) */
  payload: Record<string, unknown>
  evidence_ref: ZoneEvidenceRef
  /** 归属会话(resource 层只在本会话可读;intent 层跨会话可读到过期) */
  session_ref: string
  created_at: string
  /** 每写必更:TTL 自最后一次写入起算 */
  last_touched_at: string
  /** tier + 最后写入的确定性派生(expiresAtOf;读时不改) */
  ttl_expires_at: string
  rev: number
}

export interface OwnerConfirm {
  surface: ConfirmSurface
  /** owner 原话的有界引用(缺失或超界即拒;模型自述永远不是确认) */
  quote: string
}

export interface NotebookEntry {
  schema: 'session_zone_notebook_entry.v1'
  /** 诞生身份(自晋升 lineage+kind 语义派生);后续修订不漂移 */
  entry_id: string
  zone: 'trip_notebook'
  kind: NotebookKind
  payload: Record<string, unknown>
  /** 用户原话或工具结果引用(有界) */
  evidence: string
  /** 晋升血缘:源自哪个会话的哪条工作区笔记 */
  origin: { session_ref: string; note_id?: string }
  owner_confirm: OwnerConfirm
  created_at: string
  updated_at: string
  rev: number
}

// ---- 事件(变更后全量文档随事件走;fold 直接落,重建==直读) ------------------------

export type ZoneEvent =
  | { kind: 'hotctx.note.captured'; ts: string; note: HotNote }
  | { kind: 'hotctx.note.revised'; ts: string; note: HotNote }
  | { kind: 'hotctx.note.dropped'; ts: string; note_id: string }
  | { kind: 'notebook.entry.promoted'; ts: string; entry: NotebookEntry }
  | { kind: 'notebook.entry.revised'; ts: string; entry: NotebookEntry }
  | { kind: 'notebook.entry.dropped'; ts: string; entry_id: string }

/**
 * 幂等键(设计 §2 钉死的 rev 写键:P4-2 落账本直接复用):
 * rev 写 `hotctx:<note_id>:<rev>` / `notebook:<entry_id>:<rev>`——同 rev 重放物理 no-op;
 * drop 键带 ts:同一事件重放仍去重,且不跨生命周期碰撞(drop→再捕获循环不误伤)。
 */
export function zoneIdemKey(ev: ZoneEvent): string {
  switch (ev.kind) {
    case 'hotctx.note.captured':
    case 'hotctx.note.revised':
      return `hotctx:${ev.note.note_id}:${ev.note.rev}`
    case 'notebook.entry.promoted':
    case 'notebook.entry.revised':
      return `notebook:${ev.entry.entry_id}:${ev.entry.rev}`
    case 'hotctx.note.dropped':
      return `hotctx:${ev.note_id}:drop:${ev.ts}`
    case 'notebook.entry.dropped':
      return `notebook:${ev.entry_id}:drop:${ev.ts}`
  }
}

// ---- 分区状态与确定性 fold --------------------------------------------------------

export interface ZoneState {
  /** note_id → 活的工作区笔记(drop 即移出状态;历史在事件日志) */
  hot: Record<string, HotNote>
  /** entry_id → 活的笔记本条目(持久区无 TTL;drop 即移出,审计行在事件日志) */
  notebook: Record<string, NotebookEntry>
}

/** 单事件应用(fold 内部件;结构性守卫让重放/悬空/越级事件天然 no-op,fold 全且确定) */
function applyZoneEvent(state: ZoneState, ev: ZoneEvent): void {
  switch (ev.kind) {
    case 'hotctx.note.captured': {
      const n = ev.note
      // 未知分区/tier/kind 拒投影;已存在 → 首写胜(同 rev 重放 no-op)
      if (!validHotDoc(n) || state.hot[n.note_id]) return
      state.hot[n.note_id] = n
      return
    }
    case 'hotctx.note.revised': {
      const n = ev.note
      const cur = state.hot[n.note_id]
      // CAS 链断裂(悬空/重放/越级)跳过:写时 CAS 已拒,这里保持确定性
      if (!validHotDoc(n) || !cur || n.rev !== cur.rev + 1) return
      state.hot[n.note_id] = n
      return
    }
    case 'hotctx.note.dropped':
      delete state.hot[ev.note_id]
      return
    case 'notebook.entry.promoted': {
      const e = ev.entry
      if (!validNotebookDoc(e) || state.notebook[e.entry_id]) return
      state.notebook[e.entry_id] = e
      return
    }
    case 'notebook.entry.revised': {
      const e = ev.entry
      const cur = state.notebook[e.entry_id]
      if (!validNotebookDoc(e) || !cur || e.rev !== cur.rev + 1) return
      state.notebook[e.entry_id] = e
      return
    }
    case 'notebook.entry.dropped':
      delete state.notebook[ev.entry_id]
      return
  }
}

/** 确定性 fold:事件序列 → 分区状态(纯函数,不改入参;重建==直读的可验证性来源) */
export function foldZoneEvents(events: readonly ZoneEvent[]): ZoneState {
  const state: ZoneState = { hot: {}, notebook: {} }
  for (const ev of events) {
    if (!isZoneEventKind((ev as { kind?: unknown })?.kind)) continue // 未知事件 kind 拒投影
    applyZoneEvent(state, ev)
  }
  return state
}

/** 文档级闭集守卫(fold 对伪造文档 fail-closed;守门与 fold 共用同一词表) */
function validHotDoc(n: unknown): n is HotNote {
  const d = n as HotNote
  return (
    !!d && d.zone === 'hot_context' && isHotTier(d.tier) && isHotNoteKind(d.kind) &&
    typeof d.note_id === 'string' && d.note_id.length > 0 &&
    typeof d.rev === 'number' && Number.isInteger(d.rev) && d.rev >= 1
  )
}

function validNotebookDoc(e: unknown): e is NotebookEntry {
  const d = e as NotebookEntry
  return (
    !!d && d.zone === 'trip_notebook' && isNotebookKind(d.kind) &&
    isConfirmSurface(d.owner_confirm?.surface) &&
    typeof d.entry_id === 'string' && d.entry_id.length > 0 &&
    typeof d.rev === 'number' && Number.isInteger(d.rev) && d.rev >= 1
  )
}

// ---- 写侧负面清单(设计 §4 双重负面清单的写侧;companions 守卫同族) ----------------

const WRITE_NEGATIVE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\d{15,17}[Xx]?/, label: '疑似证件号/卡号' },
  { re: /1[3-9]\d{9}/, label: '疑似手机号' },
  { re: /(护照|身份证|证件号|通行证)\s*号?\s*[:：]?\s*\w+/i, label: '证件信息' },
  { re: /https?:\/\/\S+/i, label: 'URL' },
  { re: /\bwww\.[\w-]+(?:\.[\w-]+)+/i, label: 'URL' },
  { re: /\b[\w-]+\.(?:com|cn|net|org|io|dev|app|co|xyz|info|biz|edu|gov)\b(?:\/\S*)?/i, label: 'URL' },
  { re: /(?:api[_-]?key|secret|token|password|passwd)\s*[:=]\s*\S+/i, label: '凭证形态' },
  { re: /\bbearer\s+[A-Za-z0-9._-]{8,}/i, label: '凭证形态' },
  { re: /\bsk-[A-Za-z0-9]{12,}/, label: '凭证形态' },
]

/** 写闸:内容命中负面清单 → 返回拒收理由;否则 null(分区永不承载转写原文/凭证/URL/敏感身份) */
export function zoneWriteViolation(text: string): string | null {
  for (const { re, label } of WRITE_NEGATIVE_PATTERNS) {
    if (re.test(text)) return `负面清单拒收:${label}不入分区(证据走指针与有界引用)`
  }
  return null
}

// ---- 有界与形状常量 ---------------------------------------------------------------

export const OWNER_QUOTE_MAX = 200
export const HOT_PAYLOAD_MAX_JSON = 2048
export const SESSION_REF_MAX = 64
const CANONICAL_MAX_DEPTH = 6

/** 不透明会话引用形状(session-link 契约同族:无路径字符/无空白/有界) */
export function validSessionRef(ref: unknown): boolean {
  return (
    typeof ref === 'string' && ref.length > 0 && ref.length <= SESSION_REF_MAX &&
    !/[\/\\\s\u0000-\u001f]/.test(ref) && !ref.includes('..')
  )
}

/**
 * 规范 JSON(键排序,确定性):载荷规范化/id 派生/负面清单扫描的单一事实源。
 * 环/超深/undefined → null(不猜,fail-closed)。注意:载荷承载 slot-spec 族类型
 * (YYYY-MM-DD 日期/字符串/常规数值),不承载毫秒纪元戳等长数字串。
 */
export function canonicalJson(v: unknown, depth = 0, seen: Set<object> = new Set()): string | null {
  if (v === undefined || typeof v === 'function') return null
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (depth > CANONICAL_MAX_DEPTH || seen.has(v)) return null
  seen.add(v)
  if (Array.isArray(v)) {
    const parts: string[] = []
    for (const x of v) {
      const p = canonicalJson(x, depth + 1, seen)
      if (p === null) return null
      parts.push(p)
    }
    return '[' + parts.join(',') + ']'
  }
  const obj = v as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const parts: string[] = []
  for (const k of keys) {
    const p = canonicalJson(obj[k], depth + 1, seen)
    if (p === null) return null
    parts.push(JSON.stringify(k) + ':' + p)
  }
  return '{' + parts.join(',') + '}'
}

// ---- 注入时钟的分层 TTL(读时纯函数视图;读不 mutate、不续命) ----------------------

/** master outline §3.5 layer 5:resource 30min / intent 24h;自最后一次**写入**起算 */
export const HOT_TTL_MS: Record<HotTier, number> = {
  resource: 30 * 60_000,
  intent: 24 * 60 * 60_000,
}

/** 到期时刻 = 最后写入 + 分层窗(确定性派生;坏时间戳 → null 不猜) */
export function expiresAtOf(tier: HotTier, lastWriteIso: string): string | null {
  const t = Date.parse(lastWriteIso)
  if (Number.isNaN(t)) return null
  return new Date(t + HOT_TTL_MS[tier]).toISOString()
}

/** 过期判定(读时视图):live ⇔ now < ttl_expires_at;坏时钟/坏时间戳 fail-closed */
export function isHotNoteLive(note: HotNote, nowIso: string): boolean {
  const now = Date.parse(nowIso)
  const exp = Date.parse(note.ttl_expires_at)
  if (Number.isNaN(now) || Number.isNaN(exp)) return false
  return now < exp
}

/** 读视图:工作区活笔记(resource 只在本会话可读;intent 跨会话可读到过期;note_id 确定序) */
export function readWorkingZone(state: ZoneState, q: { now: string; session_ref: string }): HotNote[] {
  return Object.values(state.hot)
    .filter(n => n.tier === 'intent' || n.session_ref === q.session_ref)
    .filter(n => isHotNoteLive(n, q.now))
    .sort((a, b) => (a.note_id < b.note_id ? -1 : 1))
}

/** 读视图:笔记本全量(持久区无 TTL、无会话域;entry_id 确定序) */
export function readNotebook(state: ZoneState): NotebookEntry[] {
  return Object.values(state.notebook).sort((a, b) => (a.entry_id < b.entry_id ? -1 : 1))
}

// ---- 写门:类型化结果(成功/幂等 no-op/类型化拒绝) ---------------------------------

export type ZoneWriteErrorCode =
  | 'closed_set' // 闭集违规(未知 tier/kind/确认表面/分区)
  | 'negative_list' // 写侧负面清单(证件/手机号/URL/凭证形态)
  | 'bad_session_ref' // session_ref 形状(无路径字符/有界/非空)
  | 'bad_evidence_ref' // 证据指针形状(turn 非负整数)
  | 'bad_ts' // 注入时钟不是合法 ISO 时间戳(不猜)
  | 'payload_bound' // 载荷非结构化对象/超界/超深/含环
  | 'owner_confirm' // owner 确认引用缺失/为空/超界
  | 'stale_rev' // rev CAS fail-closed(父 rev ≠ 当前 fold rev)
  | 'unknown_subject' // 目标笔记/条目不存在(已 drop 或从未存在)
  | 'source_expired' // 晋升源已过期(读时视图判定,同一过期函数)

export interface ZoneWriteOk {
  ok: true
  /** true=产生待追加事件;false=幂等 no-op(同 rev 同内容重放,零事件) */
  appended: boolean
  event?: ZoneEvent
  idemKey: string
  detail?: string
}
export interface ZoneWriteErr {
  ok: false
  code: ZoneWriteErrorCode
  detail: string
}
export type ZoneWriteResult = ZoneWriteOk | ZoneWriteErr

function rejected(code: ZoneWriteErrorCode, detail: string): ZoneWriteErr {
  return { ok: false, code, detail }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a as Record<string, unknown>).sort()
  const kb = Object.keys(b as Record<string, unknown>).sort()
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false
  return ka.every(k => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

/** 载荷闸:必须是纯结构化对象、可规范化、有界(结构片段,不是自由文本) */
function checkedPayload(payload: unknown): { ok: true; canonical: string } | { ok: false; detail: string } {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, detail: 'payload 必须为结构化对象(slot-spec 族类型,不接受数组/自由文本)' }
  }
  const canonical = canonicalJson(payload)
  if (canonical === null) return { ok: false, detail: 'payload 不可规范化(超深/含环/含 undefined)' }
  if (canonical.length > HOT_PAYLOAD_MAX_JSON) {
    return { ok: false, detail: `payload 超界(${canonical.length}>${HOT_PAYLOAD_MAX_JSON})` }
  }
  return { ok: true, canonical }
}

/** 稳定诞生 id:同会话同 tier 同 kind 同诞生载荷 = 同一笔记(重放天然幂等) */
export function makeHotNoteId(input: {
  session_ref: string
  tier: HotTier
  kind: HotNoteKind
  payload: Record<string, unknown>
}): string | null {
  const canonical = canonicalJson(input.payload)
  if (canonical === null) return null
  return `hn|${input.session_ref}|${input.tier}|${input.kind}|${canonical}`
}

/** 稳定条目 id:自晋升血缘+kind 派生(修订不漂移;同源同 kind 重晋升天然幂等) */
export function makeNotebookEntryId(input: { session_ref: string; note_id: string; kind: NotebookKind }): string {
  return `nb|${input.session_ref}|${input.note_id}|${input.kind}`
}

/** owner 确认引用闸:表面闭集 + 引用非空且有界(设计 §1.2「the gate rejects a missing or oversized quote」) */
function checkedOwnerConfirm(confirm: unknown): { ok: true; confirm: OwnerConfirm } | { ok: false; code: ZoneWriteErrorCode; detail: string } {
  if (typeof confirm !== 'object' || confirm === null) {
    return { ok: false, code: 'owner_confirm', detail: 'owner_confirm 缺失(晋升/修订必须携带 owner 确认引用)' }
  }
  const c = confirm as { surface?: unknown; quote?: unknown }
  if (!isConfirmSurface(c.surface)) {
    return { ok: false, code: 'closed_set', detail: `未知确认表面:${String(c.surface)}(闭集 ${CONFIRM_SURFACES.join('|')})` }
  }
  if (typeof c.quote !== 'string' || c.quote.trim().length === 0) {
    return { ok: false, code: 'owner_confirm', detail: 'owner 确认引用缺失或为空(模型自述不是确认)' }
  }
  if (c.quote.length > OWNER_QUOTE_MAX) {
    return { ok: false, code: 'owner_confirm', detail: `owner 确认引用超界(${c.quote.length}>${OWNER_QUOTE_MAX})` }
  }
  return { ok: true, confirm: { surface: c.surface, quote: c.quote } }
}

/** 全文档负面清单扫描(id 内嵌规范载荷,扫全文档即覆盖载荷/引用/指针) */
function docViolation(canonical: string): ZoneWriteErr | null {
  const v = zoneWriteViolation(canonical)
  return v ? rejected('negative_list', v) : null
}

// ---- 工作区写门 -------------------------------------------------------------------

export interface HotCaptureInput {
  session_ref: string
  tier: HotTier
  kind: HotNoteKind
  payload: Record<string, unknown>
  evidence_ref: ZoneEvidenceRef
  /** 写入时刻(注入时钟;TTL 基点) */
  ts: string
}

/**
 * 捕获笔记(隐含父 rev 0):
 *  - 闭集/形状/有界/负面清单逐闸;
 *  - 同 note_id 已存在且全文档相等 → 幂等 no-op(重放);
 *  - 已存在且不相等 → stale_rev fail-closed(活笔记再断言走 revise;capture 只诞生)。
 */
export function captureHotNote(state: ZoneState, input: HotCaptureInput): ZoneWriteResult {
  if (!isHotTier(input.tier)) {
    return rejected('closed_set', `未知 tier:${String(input.tier)}(闭集 ${HOT_TIERS.join('|')})`)
  }
  if (!isHotNoteKind(input.kind)) {
    return rejected('closed_set', `未知 kind:${String(input.kind)}(闭集 ${HOT_NOTE_KINDS.join('|')})`)
  }
  if (!validSessionRef(input.session_ref) || !validSessionRef(input.evidence_ref?.session_ref)) {
    return rejected('bad_session_ref', `session_ref 形状不合法(不透明引用:无路径字符/无空白/≤${SESSION_REF_MAX})`)
  }
  if (!Number.isInteger(input.evidence_ref?.turn) || input.evidence_ref.turn < 0) {
    return rejected('bad_evidence_ref', 'evidence_ref.turn 必须为 ≥0 整数(转写指针,不是内容)')
  }
  const payloadCheck = checkedPayload(input.payload)
  if (!payloadCheck.ok) return rejected('payload_bound', payloadCheck.detail)
  const expires = expiresAtOf(input.tier, input.ts)
  if (expires === null) return rejected('bad_ts', `ts 不是合法 ISO 时间戳:${input.ts}`)
  const note: HotNote = {
    schema: 'session_zone_hot_note.v1',
    note_id: `hn|${input.session_ref}|${input.tier}|${input.kind}|${payloadCheck.canonical}`,
    zone: 'hot_context',
    tier: input.tier,
    kind: input.kind,
    payload: input.payload,
    evidence_ref: { session_ref: input.evidence_ref.session_ref, turn: input.evidence_ref.turn },
    session_ref: input.session_ref,
    created_at: input.ts,
    last_touched_at: input.ts,
    ttl_expires_at: expires,
    rev: 1,
  }
  const violation = docViolation(canonicalJson(note) ?? '')
  if (violation) return violation
  const existing = state.hot[note.note_id]
  if (existing) {
    if (deepEqual(existing, note)) {
      return { ok: true, appended: false, idemKey: zoneIdemKey({ kind: 'hotctx.note.captured', ts: input.ts, note }), detail: '同 rev 同内容重放:幂等 no-op' }
    }
    return rejected('stale_rev', `capture 隐含父 rev 0,当前 fold rev ${existing.rev}(活笔记再断言走 revise)`)
  }
  const event: ZoneEvent = { kind: 'hotctx.note.captured', ts: input.ts, note }
  return { ok: true, appended: true, event, idemKey: zoneIdemKey(event) }
}

export interface HotReviseInput {
  note_id: string
  /** 父 rev(CAS):必须等于当前 fold rev,否则 stale_rev fail-closed */
  expected_rev: number
  payload?: Record<string, unknown>
  kind?: HotNoteKind
  /** tier 出生即定(改分层=改 TTL 语义:更正即 drop 后重捕获,不就地变层) */
  ts: string
}

/**
 * CAS 修订(rev+1;每写续 TTL——「时钟自最后一次写入起算」):
 *  - 同内容同时戳的父 rev 重放(即产生当前 rev 的那次写)→ 幂等 no-op;
 *  - expected_rev ≠ 当前 fold rev(旧/未来)→ stale_rev fail-closed;
 *  - 仅不传 payload/kind 的纯 touch 也合法(续 TTL 是写入,不是读)。
 */
export function reviseHotNote(state: ZoneState, input: HotReviseInput): ZoneWriteResult {
  const cur = state.hot[input.note_id]
  if (!cur) return rejected('unknown_subject', `工作区笔记不存在:${input.note_id}(已 drop 或未捕获)`)
  if (input.kind !== undefined && !isHotNoteKind(input.kind)) {
    return rejected('closed_set', `未知 kind:${String(input.kind)}(闭集 ${HOT_NOTE_KINDS.join('|')})`)
  }
  let canonicalPayload: string | null = null
  if (input.payload !== undefined) {
    const payloadCheck = checkedPayload(input.payload)
    if (!payloadCheck.ok) return rejected('payload_bound', payloadCheck.detail)
    canonicalPayload = payloadCheck.canonical
  }
  const expires = expiresAtOf(cur.tier, input.ts)
  if (expires === null) return rejected('bad_ts', `ts 不是合法 ISO 时间戳:${input.ts}`)
  const next: HotNote = {
    ...cur,
    kind: input.kind ?? cur.kind,
    payload: input.payload ?? cur.payload,
    last_touched_at: input.ts,
    ttl_expires_at: expires,
    rev: input.expected_rev + 1,
  }
  const violation = docViolation(canonicalJson(next) ?? '')
  if (violation) return violation
  if (deepEqual(cur, next)) {
    return { ok: true, appended: false, idemKey: zoneIdemKey({ kind: 'hotctx.note.revised', ts: input.ts, note: next }), detail: '同 rev 同内容重放:幂等 no-op' }
  }
  if (input.expected_rev !== cur.rev) {
    return rejected('stale_rev', `父 rev ${input.expected_rev} ≠ 当前 fold rev ${cur.rev}(fail-closed,插入前拒绝)`)
  }
  const event: ZoneEvent = { kind: 'hotctx.note.revised', ts: input.ts, note: next }
  return { ok: true, appended: true, event, idemKey: zoneIdemKey(event) }
}

/** 更正/矛盾即弃(drop 后仍真可重捕获;审计行随事件日志存活) */
export function dropHotNote(state: ZoneState, note_id: string, ts: string): ZoneWriteResult {
  if (!state.hot[note_id]) return rejected('unknown_subject', `工作区笔记不存在:${note_id}`)
  const event: ZoneEvent = { kind: 'hotctx.note.dropped', ts, note_id }
  return { ok: true, appended: true, event, idemKey: zoneIdemKey(event) }
}

// ---- 晋升与笔记本写门(owner 确认是唯一入口;模型只可提议,永不自晋升) ---------------

export interface PromoteInput {
  note_id: string
  kind: NotebookKind
  payload?: Record<string, unknown>
  owner_confirm: OwnerConfirm
  /** 写入时刻 = 过期判定时钟(注入:晋升只在源笔记未过期时合法) */
  ts: string
}

/**
 * owner 确认晋升(hot → durable;隐含条目父 rev 0):
 *  - 源笔记必须活在同一过期函数下(过期源 fail-closed:source_expired);
 *  - owner_confirm 闸(表面闭集/引用非空有界);
 *  - 同 entry_id 已存在且全文档相等 → 幂等 no-op;不相等 → stale_rev(改条目走 notebook 修订);
 *  - 晋升不移除工作区笔记(它仍服务本会话直到过期/drop);lineage 进 origin。
 */
export function promoteHotNote(state: ZoneState, input: PromoteInput): ZoneWriteResult {
  const cur = state.hot[input.note_id]
  if (!cur) return rejected('unknown_subject', `工作区笔记不存在:${input.note_id}(已 drop/未捕获/已过期出视图)`)
  if (!isNotebookKind(input.kind)) {
    return rejected('closed_set', `未知笔记本 kind:${String(input.kind)}(闭集 ${NOTEBOOK_KINDS.join('|')})`)
  }
  const confirmCheck = checkedOwnerConfirm(input.owner_confirm)
  if (!confirmCheck.ok) return rejected(confirmCheck.code, confirmCheck.detail)
  if (!isHotNoteLive(cur, input.ts)) {
    return rejected('source_expired', `晋升源已过期(到期 ${cur.ttl_expires_at},时钟 ${input.ts};过期不是事件,读时判定)`)
  }
  const payload = input.payload ?? cur.payload
  const payloadCheck = checkedPayload(payload)
  if (!payloadCheck.ok) return rejected('payload_bound', payloadCheck.detail)
  const entry: NotebookEntry = {
    schema: 'session_zone_notebook_entry.v1',
    entry_id: makeNotebookEntryId({ session_ref: cur.session_ref, note_id: cur.note_id, kind: input.kind }),
    zone: 'trip_notebook',
    kind: input.kind,
    payload,
    evidence: confirmCheck.confirm.quote,
    origin: { session_ref: cur.session_ref, note_id: cur.note_id },
    owner_confirm: confirmCheck.confirm,
    created_at: input.ts,
    updated_at: input.ts,
    rev: 1,
  }
  const violation = docViolation(canonicalJson(entry) ?? '')
  if (violation) return violation
  const existing = state.notebook[entry.entry_id]
  if (existing) {
    if (deepEqual(existing, entry)) {
      return { ok: true, appended: false, idemKey: zoneIdemKey({ kind: 'notebook.entry.promoted', ts: input.ts, entry }), detail: '同 rev 同内容重放:幂等 no-op' }
    }
    return rejected('stale_rev', `晋升隐含父 rev 0,当前 fold rev ${existing.rev}(改条目走 notebook 修订)`)
  }
  const event: ZoneEvent = { kind: 'notebook.entry.promoted', ts: input.ts, entry }
  return { ok: true, appended: true, event, idemKey: zoneIdemKey(event) }
}

export interface NotebookReviseInput {
  entry_id: string
  expected_rev: number
  kind?: NotebookKind
  payload?: Record<string, unknown>
  evidence?: string
  /** 每次修订都是 owner 行为:必须携带新的确认引用(设计 §1.2「at birth or by later revision」) */
  owner_confirm: OwnerConfirm
  ts: string
}

/** owner 修订笔记本条目(CAS rev+1;幂等重放 no-op;stale_rev fail-closed;持久区无 TTL) */
export function reviseNotebookEntry(state: ZoneState, input: NotebookReviseInput): ZoneWriteResult {
  const cur = state.notebook[input.entry_id]
  if (!cur) return rejected('unknown_subject', `笔记本条目不存在:${input.entry_id}`)
  if (input.kind !== undefined && !isNotebookKind(input.kind)) {
    return rejected('closed_set', `未知笔记本 kind:${String(input.kind)}(闭集 ${NOTEBOOK_KINDS.join('|')})`)
  }
  const confirmCheck = checkedOwnerConfirm(input.owner_confirm)
  if (!confirmCheck.ok) return rejected(confirmCheck.code, confirmCheck.detail)
  const payload = input.payload ?? cur.payload
  const payloadCheck = checkedPayload(payload)
  if (!payloadCheck.ok) return rejected('payload_bound', payloadCheck.detail)
  if (input.evidence !== undefined && (input.evidence.trim().length === 0 || input.evidence.length > OWNER_QUOTE_MAX)) {
    return rejected('owner_confirm', `evidence 引用为空或超界(> ${OWNER_QUOTE_MAX})`)
  }
  const next: NotebookEntry = {
    ...cur,
    kind: input.kind ?? cur.kind,
    payload,
    evidence: input.evidence ?? cur.evidence,
    owner_confirm: confirmCheck.confirm,
    updated_at: input.ts,
    rev: input.expected_rev + 1,
  }
  const violation = docViolation(canonicalJson(next) ?? '')
  if (violation) return violation
  if (deepEqual(cur, next)) {
    return { ok: true, appended: false, idemKey: zoneIdemKey({ kind: 'notebook.entry.revised', ts: input.ts, entry: next }), detail: '同 rev 同内容重放:幂等 no-op' }
  }
  if (input.expected_rev !== cur.rev) {
    return rejected('stale_rev', `父 rev ${input.expected_rev} ≠ 当前 fold rev ${cur.rev}(fail-closed,插入前拒绝)`)
  }
  const event: ZoneEvent = { kind: 'notebook.entry.revised', ts: input.ts, entry: next }
  return { ok: true, appended: true, event, idemKey: zoneIdemKey(event) }
}

/** owner 移除条目(物理删除=遗忘;审计行随事件日志存活——设计 §1.3) */
export function dropNotebookEntry(state: ZoneState, entry_id: string, ts: string): ZoneWriteResult {
  if (!state.notebook[entry_id]) return rejected('unknown_subject', `笔记本条目不存在:${entry_id}`)
  const event: ZoneEvent = { kind: 'notebook.entry.dropped', ts, entry_id }
  return { ok: true, appended: true, event, idemKey: zoneIdemKey(event) }
}
