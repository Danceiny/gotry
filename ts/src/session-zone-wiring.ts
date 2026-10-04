/**
 * 会话双区记忆的会话接线(P4-3,docs/design/session-dual-zone-memory-design.md §5):
 * 把 P4-1 契约 + P4-2 账本落点接到真实会话面——捕获缝、persona 读回、owner 确认
 * 晋升、更正即弃。**默认关闭**:`sessionZones: 'off' | 'on'` 插件配置,关时接线惰性
 * (零账本事件、读回空串、工具不注册、execute 不被包裹)。
 *
 * 纪律:
 *  - 证据只走**指针**(session_ref + 观察序号),永不承载转写原文;session_ref 是
 *    会话 id 的单向摘要(不透明、有界、无路径字符,与 session-link 护栏同族),
 *    分区里永远看不到宿主会话 id 原文。
 *  - 工具观察缝只从**闭集白名单**工具的结果信封里投影形状字段(verdict / 条数 /
 *    价格带两个数),不读名称、不读 URL、不读任何自由文本;投影后仍过 P4-1 写闸
 *    (负面清单二次把关)。捕获失败永不影响工具返回值。
 *  - 晋升只有 owner 确认一条入口:模型可**提议**(零落账),确认必须携带 owner 原话
 *    引用;命中既有语义的晋升**经既有闸**落入唯一写权威(动机/时间线/同行人),
 *    笔记本只记断言 + 血缘,绝不成为平行事实库(设计 §3 路由规则)。
 *  - 路由缺料 fail-closed(`routing_required`):宁可拒绝晋升,也不在笔记本里私存
 *    一份本该归动机/时间线/同行人的事实。
 *
 * 边界:观测计数与指标在 P4-4;本模块零定时器、零网络;所有 IO 只在账本公开面。
 */

import { createHash } from 'node:crypto'
import {
  OWNER_QUOTE_MAX,
  isConfirmSurface,
  isHotNoteKind,
  isHotTier,
  isNotebookKind,
  makeHotNoteId,
  readNotebook,
  readWorkingZone,
  validSessionRef,
  type ConfirmSurface,
  type HotCaptureInput,
  type HotNote,
  type HotNoteKind,
  type HotTier,
  type NotebookEntry,
  type NotebookKind,
  type OwnerConfirm,
} from './session-zones.ts'
import {
  appendZoneWrite,
  appendZoneWrites,
  readZoneLog,
  type ZoneAppendResult,
  type ZoneLedgerErrorCode,
} from './session-zone-ledger.ts'
import { noteZoneSignal } from './session-zone-observation.ts'
import type { StateLedger } from './state-ledger.ts'

// ---- 总闸(默认关;未知值 fail-closed 关) -----------------------------------------

export const ZONE_SWITCH_VALUES = ['off', 'on'] as const
export type ZoneSwitch = (typeof ZONE_SWITCH_VALUES)[number]

/** 未知/缺失/非字符串一律视为 off——开关只认明示的 'on' */
export function resolveZoneSwitch(raw: unknown): ZoneSwitch {
  return raw === 'on' ? 'on' : 'off'
}

// ---- 会话引用(单向摘要;不透明、有界、无路径字符) --------------------------------

export const ZONE_SESSION_REF_PREFIX = 's-'

/**
 * 宿主会话 id → 不透明分区会话引用。单向摘要:分区与导出里永不出现宿主 id 原文
 * (会话 id 可能本身就是路径/长串/含 PII 形态的字符串)。
 * 非字符串/空白 → null(无会话身份即不捕获,不猜)。
 */
export function zoneSessionRef(rawSessionId: unknown): string | null {
  if (typeof rawSessionId !== 'string' || rawSessionId.trim().length === 0) return null
  const ref = ZONE_SESSION_REF_PREFIX + createHash('sha256').update(rawSessionId.trim()).digest('hex').slice(0, 24)
  return validSessionRef(ref) ? ref : null
}

/** 从 dsh exec 取会话身份(与 lavish-tools 同一权威:exec.agent.session.id,无 agent.id 回落) */
export function zoneSessionRefFromExec(exec: unknown): string | null {
  const candidate = exec as { agent?: { session?: { id?: unknown } } } | null
  return zoneSessionRef(candidate?.agent?.session?.id)
}

/**
 * 观察序号(证据指针的第二个分量):dsh 未向插件暴露转写行号,这里用**本进程内
 * 该会话的单调观察序号**作指针——它只说「这是本会话第 n 个捕获点」,不承载内容。
 */
const observationCursor = new Map<string, number>()

export function nextObservationTurn(sessionRef: string): number {
  const next = (observationCursor.get(sessionRef) ?? -1) + 1
  observationCursor.set(sessionRef, next)
  return next
}

/**
 * 会话绑定(persona 读回用:resource 层只在**本会话**可读)。
 *
 * 按 scope 键存,不存进程全局:dsh 的 agent-loop 以 agent 对象为 ScopeKey
 * (`createScope(loopCtx, this)`),工具侧的 `exec.agent` 与 persona 组装侧的
 * `AssembleContext.scope` 因此是同一个对象身份。进程全局单值会让同一宿主进程里
 * 的两个会话互相读到对方的 resource 层笔记——那正是设计 §1.1 禁止的事
 * (P4-3 复查发现)。WeakMap:会话消失即自动回收。
 * 取不到 scope(轻量宿主/无绑定)→ null → 读回**不出** resource 段(fail-closed)。
 */
const sessionRefByScope = new WeakMap<object, string>()

/** 从 exec 取 scope 键(与 dsh agent-loop 的 ScopeKey 同一对象身份) */
export function zoneScopeOfExec(exec: unknown): object | undefined {
  const agent = (exec as { agent?: unknown } | null)?.agent
  return typeof agent === 'object' && agent !== null ? agent : undefined
}

export function bindZoneSession(scope: object | undefined, sessionRef: string | null): void {
  if (!scope) return
  if (sessionRef === null) {
    sessionRefByScope.delete(scope)
    return
  }
  if (!validSessionRef(sessionRef)) return
  sessionRefByScope.set(scope, sessionRef)
}

export function boundZoneSession(scope: object | undefined): string | null {
  if (!scope) return null
  return sessionRefByScope.get(scope) ?? null
}

/** 测试用:清空观察游标与提议去重集(scope 绑定随对象回收,无需清)。产品路径不调用。 */
export function resetZoneSessionBindingForTests(): void {
  observationCursor.clear()
  proposalSeen.clear()
}

// ---- 工具观察缝(闭集白名单 + 形状投影) -------------------------------------------

/** 可观察工具闭集:只有检索类工具的结果信封进入工作区(resource 层) */
export const ZONE_OBSERVABLE_TOOLS = [
  'gotry_flyai_search',
  'gotry_hotel_search',
  'gotry_session_search',
  'gotry_anything_search',
] as const
export type ZoneObservableTool = (typeof ZONE_OBSERVABLE_TOOLS)[number]

export function isZoneObservableTool(name: unknown): name is ZoneObservableTool {
  return typeof name === 'string' && (ZONE_OBSERVABLE_TOOLS as readonly string[]).includes(name)
}

const RESULT_LIST_KEYS = ['options', 'hotels', 'pois', 'trains', 'rates', 'keywords', 'packages'] as const
const ZONE_VERDICTS = ['hit', 'miss', 'error', 'declined'] as const

function verdictOf(result: Record<string, unknown>): string {
  const v = result['verdict']
  if (typeof v === 'string' && (ZONE_VERDICTS as readonly string[]).includes(v)) return v
  return result['ok'] === true ? 'hit' : 'error'
}

/** 结果信封里的候选数(只数长度,不读任何条目字段) */
function optionCountOf(result: Record<string, unknown>): number {
  let count = 0
  for (const key of RESULT_LIST_KEYS) {
    const list = result[key]
    if (Array.isArray(list)) count = Math.max(count, list.length)
  }
  return count
}

/** 结果信封里的价格带(只取有限正数的 min/max 两个数;没有就没有) */
function priceBandOf(result: Record<string, unknown>): { low: number; high: number; samples: number } | null {
  const prices: number[] = []
  for (const key of RESULT_LIST_KEYS) {
    const list = result[key]
    if (!Array.isArray(list)) continue
    for (const item of list) {
      const price = (item as { price?: unknown } | null)?.price
      if (typeof price === 'number' && Number.isFinite(price) && price > 0) prices.push(price)
    }
  }
  if (prices.length === 0) return null
  return { low: Math.min(...prices), high: Math.max(...prices), samples: prices.length }
}

/**
 * 工具观察 → resource 层捕获输入(纯函数):
 *  - 白名单外工具 / 非对象结果 → 零捕获;
 *  - availability 笔记 = { tool, verdict, option_count };
 *  - 命中价格时追加 price_band 笔记 = { tool, low, high, samples };
 *  - 两者都只含形状数字与闭集标签,**零名称、零 URL、零自由文本**。
 */
export function projectToolObservation(input: {
  tool: string
  result: unknown
  session_ref: string
  turn: number
  ts: string
}): HotCaptureInput[] {
  if (!isZoneObservableTool(input.tool)) return []
  if (typeof input.result !== 'object' || input.result === null || Array.isArray(input.result)) return []
  const result = input.result as Record<string, unknown>
  const verdict = verdictOf(result)
  const evidence_ref = { session_ref: input.session_ref, turn: input.turn }
  const captures: HotCaptureInput[] = [{
    session_ref: input.session_ref,
    tier: 'resource',
    kind: 'availability',
    payload: { tool: input.tool, verdict, option_count: optionCountOf(result) },
    evidence_ref,
    ts: input.ts,
  }]
  const band = priceBandOf(result)
  if (band) {
    captures.push({
      session_ref: input.session_ref,
      tier: 'resource',
      kind: 'price_band',
      payload: { tool: input.tool, low: band.low, high: band.high, samples: band.samples },
      evidence_ref,
      ts: input.ts,
    })
  }
  return captures
}

/**
 * 观察缝落账(非抛出):任何失败(账本不可用/写闸拒绝)都只是「没记住」,
 * 绝不影响工具返回值——记忆面永远不能把产品主路径带红。
 *
 * 写门用 `capture_or_touch`:同一检索重复出现时**续命**(TTL 自本次写入起算),
 * 而不是撞 stale_rev 被默默丢掉。纯 capture 会让 30min 后的同一检索永远刷不新
 * 那条 resource 笔记,工作区于是悄悄停止供述该形态(P4-3 复查发现)。
 * 返回值区分 captured/touched/rejected,让「没记住」在计数上可见而不是无声。
 */
export function observeToolResult(
  ledger: StateLedger | null,
  input: { tool: string; result: unknown; session_ref: string; ts: string },
): { captured: number; touched: number; rejected: number } {
  const zero = { captured: 0, touched: 0, rejected: 0 }
  if (!ledger) return zero
  try {
    const turn = nextObservationTurn(input.session_ref)
    const captures = projectToolObservation({ ...input, turn })
    let captured = 0
    let touched = 0
    let rejected = 0
    for (const capture of captures) {
      // 逐条独立事务:一条被负面清单拒收不连带丢掉另一条形状笔记
      const r = appendZoneWrite(ledger, { op: 'capture_or_touch', input: capture }, { actor: `tool:${input.tool}` })
      if (!r.ok) rejected++
      else if (!r.appended) touched++ // 同 ts 同内容重放:已是本次写入时刻,无需续命
      else if (r.event?.kind === 'hotctx.note.revised') touched++
      else captured++
    }
    return { captured, touched, rejected }
  } catch {
    return zero
  }
}

// ---- 用户陈述吸收(契约 18 同款:模型带 typed 片段,不带原文) ----------------------

export type ZoneNoteAction = 'capture' | 'revise' | 'drop' | 'propose' | 'deny'
export const ZONE_NOTE_ACTIONS: readonly ZoneNoteAction[] = ['capture', 'revise', 'drop', 'propose', 'deny']

export function isZoneNoteAction(v: unknown): v is ZoneNoteAction {
  return typeof v === 'string' && (ZONE_NOTE_ACTIONS as readonly string[]).includes(v)
}

/**
 * 提议/否决去重集(进程内;观测计数与指标口径对齐):
 * 指标 ① 的分母按 `proposal_ref` 去重,所以同一「笔记 × 目标 kind」的重复提议
 * 只算一个提议;确认侧同理——只在**真的落了**笔记本条目时记一次 confirm。
 */
const proposalSeen = new Set<string>()

function markProposal(scope: 'propose' | 'deny' | 'confirm', noteId: string, kind?: string): boolean {
  const key = `${scope}|${noteId}|${kind ?? ''}`
  if (proposalSeen.has(key)) return false
  proposalSeen.add(key)
  return true
}

export type ZoneWiringErrorCode =
  | ZoneLedgerErrorCode
  | 'switch_off' // 总闸关闭(默认):接线惰性
  | 'bad_session' // 无会话身份(exec 未携带 session.id)
  | 'bad_action' // action 闭集外
  | 'routing_required' // 命中既有语义但缺路由载荷(拒绝私存平行事实)
  | 'routed_rejected' // 既有闸拒绝(冲突/校验);整笔晋升回滚
  | 'no_ledger' // 账本不可用

export interface ZoneWiringErr {
  ok: false
  code: ZoneWiringErrorCode
  detail: string
}

function err(code: ZoneWiringErrorCode, detail: string): ZoneWiringErr {
  return { ok: false, code, detail }
}

export interface ZoneNoteInput {
  action: ZoneNoteAction
  tier?: string
  kind?: string
  payload?: Record<string, unknown>
  noteId?: string
  expectedRev?: number
  /** 晋升提议的目标 kind(propose 时用于告诉 owner 要确认什么) */
  promoteKind?: string
}

export interface ZoneNoteOk {
  ok: true
  action: ZoneNoteAction
  appended: boolean
  noteId?: string
  /** propose 永不落账:模型只可提议,owner 确认才写 */
  proposed?: boolean
  requiresOwnerConfirm?: boolean
  ask?: string
  detail?: string
}

/**
 * 用户陈述吸收 / 更正即弃 / 晋升提议的统一入口。
 * propose 分支**零落账**:返回一句要 owner 确认的话术,写入只能走
 * `promoteWithRouting`(必须携带 owner 原话引用)。
 */
export function applyZoneNote(
  ledger: StateLedger | null,
  input: ZoneNoteInput & { session_ref: string; ts: string },
): ZoneNoteOk | ZoneWiringErr {
  if (!isZoneNoteAction(input.action)) {
    return err('bad_action', `未知 action:${String(input.action)}(闭集 ${ZONE_NOTE_ACTIONS.join('|')})`)
  }
  if (!validSessionRef(input.session_ref)) return err('bad_session', '缺少会话身份:无 session 绑定不捕获')
  if (!ledger) return err('no_ledger', '账本不可用:本轮不记忆(不影响工具主路径)')

  if (input.action === 'propose') {
    const kind = input.promoteKind
    if (!isNotebookKind(kind)) {
      return err('closed_set', `未知笔记本 kind:${String(kind)}(闭集 trip_fact|preference|constraint|lesson)`)
    }
    if (typeof input.noteId !== 'string' || input.noteId.length === 0) {
      return err('unknown_subject', 'propose 需要 noteId(提议把哪条工作区笔记转为持久条目)')
    }
    const { state } = readZoneLog(ledger)
    if (!state.hot[input.noteId]) return err('unknown_subject', `工作区笔记不存在:${input.noteId}`)
    // 按提议主体去重:指标 ① 的分母是 proposal_ref(每个提议一次),
    // 同一条笔记被重复提议两次仍是**一个**提议——否则计数口径与指标口径不同(复查发现)。
    if (markProposal('propose', input.noteId, kind)) noteZoneSignal('proposal')
    return {
      ok: true,
      action: 'propose',
      appended: false,
      proposed: true,
      noteId: input.noteId,
      requiresOwnerConfirm: true,
      ask: '这条要不要我长期记住?请用你自己的话回我一句确认(模型自述不算确认);确认后我再写入笔记本。',
      detail: '提议零落账:持久区唯一入口是 owner 确认晋升',
    }
  }

  // owner 否决晋升提议(P4-4 观测面需要真实分母:没有否决面,确认率恒为 1 = 假指标)。
  // 零落账:笔记仍留在工作区服务本次会话,只是本会话不再提议它进笔记本。
  if (input.action === 'deny') {
    if (typeof input.noteId !== 'string' || input.noteId.length === 0) {
      return err('unknown_subject', 'deny 需要 noteId(owner 否决的是哪条提议)')
    }
    const { state } = readZoneLog(ledger)
    if (!state.hot[input.noteId]) return err('unknown_subject', `工作区笔记不存在:${input.noteId}`)
    if (markProposal('deny', input.noteId)) noteZoneSignal('deny')
    return {
      ok: true,
      action: 'deny',
      appended: false,
      noteId: input.noteId,
      detail: 'owner 否决:零落账;笔记仍服务本会话,本会话不再提议它进笔记本',
    }
  }

  if (input.action === 'drop') {
    if (typeof input.noteId !== 'string' || input.noteId.length === 0) {
      return err('unknown_subject', 'drop 需要 noteId')
    }
    const r = appendZoneWrite(ledger, { op: 'drop', note_id: input.noteId, ts: input.ts })
    return r.ok
      ? { ok: true, action: 'drop', appended: r.appended, noteId: input.noteId, detail: r.detail }
      : err(r.code, r.detail)
  }

  if (input.action === 'revise') {
    if (typeof input.noteId !== 'string' || input.noteId.length === 0) {
      return err('unknown_subject', 'revise 需要 noteId')
    }
    if (!Number.isInteger(input.expectedRev) || (input.expectedRev as number) < 1) {
      return err('stale_rev', 'revise 需要 expectedRev(≥1 整数;父 rev 必须等于当前 rev)')
    }
    if (input.kind !== undefined && !isHotNoteKind(input.kind)) {
      return err('closed_set', `未知 kind:${String(input.kind)}`)
    }
    const r = appendZoneWrite(ledger, {
      op: 'revise',
      input: {
        note_id: input.noteId,
        expected_rev: input.expectedRev as number,
        ...(input.payload !== undefined ? { payload: input.payload } : {}),
        ...(input.kind !== undefined ? { kind: input.kind as HotNoteKind } : {}),
        ts: input.ts,
      },
    })
    return r.ok
      ? { ok: true, action: 'revise', appended: r.appended, noteId: input.noteId, detail: r.detail }
      : err(r.code, r.detail)
  }

  // capture:用户陈述片段入 intent 层(默认);tier 由调用方显式给
  if (!isHotTier(input.tier)) return err('closed_set', `未知 tier:${String(input.tier)}(闭集 resource|intent)`)
  if (!isHotNoteKind(input.kind)) return err('closed_set', `未知 kind:${String(input.kind)}`)
  if (typeof input.payload !== 'object' || input.payload === null || Array.isArray(input.payload)) {
    return err('payload_bound', 'payload 必须是结构化对象(slot-spec 族片段,不接受自由文本)')
  }
  const turn = nextObservationTurn(input.session_ref)
  // capture_or_touch:用户把同一片段再说一次 = 它仍在场 → 续 TTL,不是 stale_rev
  const r = appendZoneWrite(ledger, {
    op: 'capture_or_touch',
    input: {
      session_ref: input.session_ref,
      tier: input.tier as HotTier,
      kind: input.kind as HotNoteKind,
      payload: input.payload,
      evidence_ref: { session_ref: input.session_ref, turn },
      ts: input.ts,
    },
  }, { actor: 'tool:gotry_session_zone_note' })
  if (!r.ok) return err(r.code, r.detail)
  const noteId = r.event?.kind === 'hotctx.note.captured' || r.event?.kind === 'hotctx.note.revised'
    ? r.event.note.note_id
    : makeHotNoteId({ session_ref: input.session_ref, tier: input.tier as HotTier, kind: input.kind as HotNoteKind, payload: input.payload }) ?? undefined
  return { ok: true, action: 'capture', appended: r.appended, noteId, detail: r.detail }
}

// ---- 晋升路由(设计 §3:命中既有语义即经既有闸,笔记本绝不平行存事实) ------------

export const PROMOTION_AUTHORITIES = ['motivation', 'timeline', 'companion', 'notebook'] as const
export type PromotionAuthority = (typeof PROMOTION_AUTHORITIES)[number]

/** 同行人语义的识别键(载荷里点名了同行人 → 约束归 companion 闸) */
export const COMPANION_LABEL_KEYS = ['companion_label', 'companion'] as const

/**
 * 路由分类(纯函数):
 *  - preference → 动机画像(gotry_motivation_save 的同一闸)
 *  - trip_fact  → 旅行时间线(gotry_trip_log 的同一闸)
 *  - constraint + 载荷点名同行人 → 同行人档案(gotry_companion_save 的同一闸)
 *  - constraint(无同行人)/ lesson → 笔记本自身就是该语义的唯一权威
 */
export function classifyPromotionRouting(kind: NotebookKind, payload: Record<string, unknown>): PromotionAuthority {
  if (kind === 'preference') return 'motivation'
  if (kind === 'trip_fact') return 'timeline'
  if (kind === 'constraint') {
    const named = COMPANION_LABEL_KEYS.some(k => typeof payload[k] === 'string' && (payload[k] as string).trim().length > 0)
    return named ? 'companion' : 'notebook'
  }
  return 'notebook'
}

/**
 * 路由逃逸检测(纯函数;分类之后、落账之前):notebook 路由只对**真的没有既有
 * 权威**的断言成立。两条判据——
 *  1. 载荷带着权威形状键(偏好权重/行程日期/同行人约束字段);
 *  2. 源工作区笔记的 kind 本身就属于某个既有权威的语义(destination/date_window →
 *     时间线,party_size → 同行人,budget_stance → 动机画像)。
 * 命中任一条即返回拒收理由:请改按对应 kind 声明并带上该权威的路由载荷。
 * 模型自己选的 kind 不构成豁免——这正是「单一写权威」要防的事。
 */
export function routingEscapeViolation(input: {
  kind: NotebookKind
  authority: PromotionAuthority
  payload: Record<string, unknown>
  sourceKind: string
}): string | null {
  if (input.authority !== 'notebook') return null
  for (const [authority, keys] of Object.entries(AUTHORITY_SHAPED_KEYS)) {
    const hit = keys.find(k => input.payload[k] !== undefined)
    if (hit !== undefined) {
      return `载荷字段 ${hit} 属 ${authority} 语义:kind=${input.kind} 会绕过该权威的闸私存事实;请按对应 kind 声明并带上 ${authority} 路由载荷`
    }
  }
  const sourceAuthority = HOT_KIND_AUTHORITY[input.sourceKind]
  if (sourceAuthority) {
    return `源笔记 kind=${input.sourceKind} 属 ${sourceAuthority} 语义:kind=${input.kind} 会绕过该权威的闸;请按对应 kind 声明并带上 ${sourceAuthority} 路由载荷`
  }
  return null
}

/** 路由载荷与分类权威必须一致:为 A 权威备料却声明成 B 类别,同样是绕闸 */
export function routedPayloadMismatch(input: {
  authority: PromotionAuthority
  supplied: ZoneRoutedPayloads
}): string | null {
  const supplied: Array<'motivation' | 'timeline' | 'companion'> = []
  if (input.supplied.motivation !== undefined) supplied.push('motivation')
  if (input.supplied.trip !== undefined) supplied.push('timeline')
  if (input.supplied.companion !== undefined) supplied.push('companion')
  const stray = supplied.filter(a => a !== input.authority)
  if (stray.length === 0) return null
  return `路由载荷 ${stray.join('/')} 与本次分类权威 ${input.authority} 不符:请按该事实真正的类别声明 kind(模型选的 kind 不构成豁免)`
}

/**
 * 权威形状键(路由逃逸检测):出现在 notebook 路由的载荷里,就说明这条断言其实
 * 有既有写权威——把它当「教训/一般约束」存进笔记本等于绕闸私存(复查发现:
 * 同一条持久偏好只要声明成 kind='lesson',或同行人约束的载荷不写 companion_label,
 * 就永远到不了既有闸)。检测到即 routing_required 拒收,要求改声明到对应 kind。
 */
export const AUTHORITY_SHAPED_KEYS: Record<'motivation' | 'timeline' | 'companion', readonly string[]> = {
  motivation: ['weights', 'hard', 'homeCity', 'home_city', 'budget_tier', 'budgetTier', 'motivation', 'preference', 'redeye', 'wake_not_before'],
  timeline: ['destination', 'start', 'end', 'trip', 'visited', 'city', 'date_window', 'checkIn', 'checkOut'],
  companion: ['companion_label', 'companion', 'companions', 'mobility', 'health', 'prefs', 'party_size', 'adults'],
}

/** 源笔记 kind → 已有写权威的语义(notebook 路由在这些 kind 上须显式举证) */
export const HOT_KIND_AUTHORITY: Record<string, 'motivation' | 'timeline' | 'companion'> = {
  destination: 'timeline',
  date_window: 'timeline',
  party_size: 'companion',
  budget_stance: 'motivation',
}

export interface ZoneRoutedPayloads {
  motivation?: { weights?: Record<string, number>; hard?: Record<string, unknown>; homeCity?: string | null }
  trip?: { destination: string; start: string; end?: string; companions?: string[] }
  companion?: { label: string; constraints: { mobility?: string; health?: string[]; prefs?: string[] } }
}

export interface ZonePromotionInput extends ZoneRoutedPayloads {
  noteId: string
  kind: string
  ownerQuote: string
  surface: string
  payload?: Record<string, unknown>
  ts: string
}

export interface ZonePromotionOk {
  ok: true
  appended: boolean
  entryId?: string
  authority: PromotionAuthority
  /** 既有闸的落地结果(notebook 路由时缺席) */
  routed?: { authority: PromotionAuthority; applied: boolean; idempotent: boolean; ref?: string }
  detail?: string
}

/**
 * 动机断言落地核对(纯函数):返回第一个**没有**出现在结果画像里的字段描述,
 * 全部落地则返回 null。`appendMotivationPatch` 的 saved:false 既可能是「无变化」
 * (已落地,幂等)也可能是「被拒」(未落地),且不带 reason——核对结果是唯一
 * 可靠的区分方式,也顺带覆盖未来新增的拒收理由。
 */
function motivationPatchUnmet(
  patch: NonNullable<ZoneRoutedPayloads['motivation']>,
  profile: { weights?: Record<string, number>; hard?: Record<string, unknown>; homeCityPreference?: { value: string | null } },
): string | null {
  for (const [k, v] of Object.entries(patch.weights ?? {})) {
    if (profile.weights?.[k] !== v) return `weights.${k} 未落地`
  }
  for (const [k, v] of Object.entries(patch.hard ?? {})) {
    if (JSON.stringify(profile.hard?.[k]) !== JSON.stringify(v)) return `hard.${k} 未落地`
  }
  if (patch.homeCity !== undefined) {
    const current = profile.homeCityPreference?.value
    const expected = typeof patch.homeCity === 'string' ? patch.homeCity.trim() : patch.homeCity
    if (current !== expected) return 'homeCity 未落地'
  }
  return null
}

/** 回滚载体:路由闸拒绝 → 抛出 → 整个外层事务回滚(笔记本条目与权威写不可能分叉) */
class ZonePromotionRejected extends Error {
  readonly failure: ZoneWiringErr
  constructor(failure: ZoneWiringErr) {
    super(failure.code)
    this.failure = failure
  }
}

/**
 * owner 确认晋升(唯一持久区入口):
 *  1) owner 引用闸(缺失/超界/表面闭集外即拒;模型自述永远不是确认);
 *  2) 路由分类 → 命中既有语义时**必须**带该权威的载荷,否则 routing_required 拒绝;
 *  3) 单一外层事务:既有闸写入 + 笔记本事件同生共死(nested savepoint);
 *  4) 既有闸拒绝(冲突/校验)→ 整笔回滚,返回 routed_rejected。
 */
export function promoteWithRouting(
  ledger: StateLedger | null,
  input: ZonePromotionInput,
): ZonePromotionOk | ZoneWiringErr {
  if (!ledger) return err('no_ledger', '账本不可用:晋升不落账')
  if (!isNotebookKind(input.kind)) {
    return err('closed_set', `未知笔记本 kind:${String(input.kind)}(闭集 trip_fact|preference|constraint|lesson)`)
  }
  if (!isConfirmSurface(input.surface)) {
    return err('closed_set', `未知确认表面:${String(input.surface)}(闭集 user_reply|approval_card)`)
  }
  if (typeof input.ownerQuote !== 'string' || input.ownerQuote.trim().length === 0) {
    return err('owner_confirm', 'owner 确认引用缺失:晋升必须携带用户本人的原话(模型自述不算确认)')
  }
  if (input.ownerQuote.length > OWNER_QUOTE_MAX) {
    return err('owner_confirm', `owner 确认引用超界(${input.ownerQuote.length}>${OWNER_QUOTE_MAX})`)
  }
  const kind = input.kind as NotebookKind
  const confirm: OwnerConfirm = { surface: input.surface as ConfirmSurface, quote: input.ownerQuote }

  const run = ledger.db.transaction((): ZonePromotionOk => {
    const { state } = readZoneLog(ledger)
    const source = state.hot[input.noteId]
    if (!source) {
      throw new ZonePromotionRejected(err('unknown_subject', `工作区笔记不存在:${input.noteId}(已 drop/未捕获)`))
    }
    const payload = input.payload ?? source.payload
    const authority = classifyPromotionRouting(kind, payload)
    // 路由逃逸两道闸(分类之后、任何写入之前):载荷/源 kind 暗示既有权威,
    // 或路由载荷与分类权威不符 → 一律拒收,绝不在笔记本里私存有主的事实。
    const escape = routingEscapeViolation({ kind, authority, payload, sourceKind: source.kind })
    if (escape) throw new ZonePromotionRejected(err('routing_required', escape))
    const mismatch = routedPayloadMismatch({
      authority,
      supplied: {
        ...(input.motivation !== undefined ? { motivation: input.motivation } : {}),
        ...(input.trip !== undefined ? { trip: input.trip } : {}),
        ...(input.companion !== undefined ? { companion: input.companion } : {}),
      },
    })
    if (mismatch) throw new ZonePromotionRejected(err('routing_required', mismatch))
    let routed: ZonePromotionOk['routed']
    if (authority === 'motivation') {
      const patch = input.motivation
      if (!patch || (patch.weights === undefined && patch.hard === undefined && patch.homeCity === undefined)) {
        throw new ZonePromotionRejected(err(
          'routing_required',
          'preference 晋升必须经动机画像闸:请带 motivation.{weights|hard|homeCity} 至少一项(单一写权威,笔记本不私存偏好)',
        ))
      }
      const res = ledger.appendMotivationPatch({
        ...(patch.weights !== undefined ? { weights: patch.weights } : {}),
        ...(patch.hard !== undefined ? { hard: patch.hard } : {}),
        ...(patch.homeCity !== undefined ? { homeCity: patch.homeCity, homeCityEvidence: input.ownerQuote } : {}),
        evidence: [input.ownerQuote],
      }, 'tool:gotry_session_zone_promote')
      // 动机闸的 saved:false 是二义的(「无变化」与「被拒」同一个返回,且不带 reason),
      // 不能像时间线/同行人那样读 reason。所以改为**核对结果**:断言的每个字段必须
      // 真的出现在返回画像里,否则就是被拒 → 整笔回滚(复查发现:被拒的偏好晋升
      // 原先仍会落一条笔记本条目,等于笔记本替动机画像背书)。
      const unmet = motivationPatchUnmet(patch, res.profile)
      if (unmet) {
        throw new ZonePromotionRejected(err('routed_rejected', `动机画像闸未落地该断言(${unmet});整笔晋升回滚`))
      }
      routed = { authority, applied: res.saved, idempotent: !res.saved }
    } else if (authority === 'timeline') {
      const trip = input.trip
      if (!trip || typeof trip.destination !== 'string' || typeof trip.start !== 'string') {
        throw new ZonePromotionRejected(err(
          'routing_required',
          'trip_fact 晋升必须经时间线闸:请带 trip.{destination,start(YYYY-MM-DD),end?}(单一写权威,笔记本不私存行程)',
        ))
      }
      const res = ledger.appendTripEvent({
        destination: trip.destination,
        start: trip.start,
        ...(trip.end !== undefined ? { end: trip.end } : {}),
        ...(trip.companions !== undefined ? { companions: trip.companions } : {}),
        source: 'user-verbatim',
        evidence: input.ownerQuote,
      }, 'tool:gotry_session_zone_promote')
      if (!res.appended && res.reason) {
        throw new ZonePromotionRejected(err('routed_rejected', `时间线闸拒绝:${res.reason}(整笔晋升回滚)`))
      }
      routed = { authority, applied: res.appended, idempotent: !res.appended, ...(res.tripId ? { ref: res.tripId } : {}) }
    } else if (authority === 'companion') {
      const companion = input.companion
      if (!companion || typeof companion.label !== 'string' || companion.label.trim().length === 0) {
        throw new ZonePromotionRejected(err(
          'routing_required',
          '同行人约束晋升必须经同行人闸:请带 companion.{label,constraints}(单一写权威,笔记本不私存同行人约束)',
        ))
      }
      const res = ledger.appendCompanion({
        label: companion.label,
        constraints: companion.constraints ?? {},
        evidence: input.ownerQuote,
      }, 'tool:gotry_session_zone_promote')
      if (!res.appended && res.reason) {
        throw new ZonePromotionRejected(err('routed_rejected', `同行人闸拒绝:${res.reason}(整笔晋升回滚)`))
      }
      routed = { authority, applied: res.appended, idempotent: !res.appended, ...(res.companionId ? { ref: res.companionId } : {}) }
    }

    const results: ZoneAppendResult[] = appendZoneWrites(ledger, [{
      op: 'promote',
      input: {
        note_id: input.noteId,
        kind,
        ...(input.payload !== undefined ? { payload: input.payload } : {}),
        owner_confirm: confirm,
        ts: input.ts,
      },
    }], { actor: 'tool:gotry_session_zone_promote' })
    const r = results[0]!
    if (!r.ok) throw new ZonePromotionRejected(err(r.code, r.detail))
    // 只有真的落了条目才算一次 owner 确认(幂等重放不是第二次确认);同口径去重
    if (r.appended && markProposal('confirm', input.noteId, kind)) noteZoneSignal('confirm')
    const entryId = r.event?.kind === 'notebook.entry.promoted' ? r.event.entry.entry_id : undefined
    return {
      ok: true,
      appended: r.appended,
      ...(entryId ? { entryId } : {}),
      authority,
      ...(routed ? { routed } : {}),
      ...(r.detail ? { detail: r.detail } : {}),
    }
  })
  try {
    return run()
  } catch (e) {
    if (e instanceof ZonePromotionRejected) return e.failure
    return err('routed_rejected', `晋升事务失败,整笔回滚:${e instanceof Error ? e.message : String(e)}`)
  }
}

// ---- persona 读回(预算有界;首访为空串) ------------------------------------------

export const ZONE_BRIEF_MAX_WORKING = 6
export const ZONE_BRIEF_MAX_NOTEBOOK = 5
export const ZONE_BRIEF_MAX_CHARS = 900

function compactPayload(payload: Record<string, unknown>, max = 120): string {
  const body = Object.entries(payload)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}`)
    .join(' ')
  return body.length > max ? body.slice(0, max - 1) + '…' : body
}

/**
 * 读回 brief(纯函数;空 = 首访/无活笔记):
 *  - 在谈(intent 层,跨会话可读到过期)= 「回来接着聊」的那部分;
 *  - 本次会话资源(resource 层)只在绑定会话内出现;
 *  - 笔记本 = owner 确认过的持久条目(带原话依据指针)。
 * 预算:每段条数上界 + 全文字符上界(超界截断并显式标注)。
 */
export function renderZoneBrief(input: {
  working: readonly HotNote[]
  notebook: readonly NotebookEntry[]
  sessionRef: string | null
}): string {
  const intent = input.working.filter(n => n.tier === 'intent').slice(0, ZONE_BRIEF_MAX_WORKING)
  const resource = input.sessionRef
    ? input.working.filter(n => n.tier === 'resource' && n.session_ref === input.sessionRef).slice(0, ZONE_BRIEF_MAX_WORKING)
    : []
  const notebook = input.notebook.slice(0, ZONE_BRIEF_MAX_NOTEBOOK)
  if (intent.length === 0 && resource.length === 0 && notebook.length === 0) return ''
  const lines: string[] = ['## 会话双区记忆(工作区=仍在谈的;笔记本=你确认过要长期记的;与你当轮说法冲突时以你为准)']
  if (intent.length) {
    lines.push(`- 仍在谈(24h 内): ${intent.map(n => `${n.kind}{${compactPayload(n.payload)}}`).join('; ')}——已确立的字段不重复问`)
  }
  if (resource.length) {
    lines.push(`- 本次会话查到的(30min 内): ${resource.map(n => `${n.kind}{${compactPayload(n.payload)}}`).join('; ')}——过期即失效,可下单事实仍须当轮工具复核`)
  }
  if (notebook.length) {
    lines.push(`- 笔记本(你确认过): ${notebook.map(e => `${e.kind}{${compactPayload(e.payload)}}`).join('; ')}——引用时带当初的原话依据`)
  }
  const text = lines.join('\n')
  return text.length > ZONE_BRIEF_MAX_CHARS ? text.slice(0, ZONE_BRIEF_MAX_CHARS - 1) + '…' : text
}

/**
 * 读回组装(账本 → fold → 读视图 → brief):
 * 总闸关闭 / 无账本 / 读失败 一律返回空串——读回永不抛,永不建库。
 */
export function renderSessionZoneBrief(input: {
  ledger: StateLedger | null
  now: string
  /** 本次组装 scope 绑定的会话引用;null = 未绑定 → 读回不出 resource 段(fail-closed) */
  sessionRef: string | null
  zoneSwitch: ZoneSwitch
}): string {
  if (input.zoneSwitch !== 'on' || !input.ledger) return ''
  try {
    const { state } = readZoneLog(input.ledger)
    const working = readWorkingZone(state, { now: input.now, session_ref: input.sessionRef ?? '' })
    const brief = renderZoneBrief({ working, notebook: readNotebook(state), sessionRef: input.sessionRef })
    // 工作区读命中/未命中(形状计数;opt-in 关闭时为 no-op)
    noteZoneSignal(brief === '' ? 'read_miss' : 'read_hit')
    return brief
  } catch {
    return ''
  }
}
