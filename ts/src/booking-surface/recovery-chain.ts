/**
 * Booking Copilot unavailable/changed 恢复链契约层（issue #142 非门控切片）。
 *
 * ⚠ 非运行时激活：纯函数契约层，不发起供应商调用、不读凭据、不接线 runtime seam——
 * #142 合并 gate 中「四 surface 真实库存」与「真实 Checkout/QueryOrders 证据」仍是
 * no-spend 门控项（等真实供应商/UAT）。本层只把恢复链的**结构化处置**固化为可离线
 * 证明的契约：检测（识别分类）→ 恢复（受控重试）→ 用户沟通（显式披露）→ 审计（可对账）。
 * 检测/恢复的合法性判定仍归 availability reducer（ADR-23 availability-policy.ts）所有；
 * 本层是它的用户沟通与审计投影，不替代、不绕过。
 *
 * 词汇复用（不发明新通道）：
 *   - 分类闭集复用 ActionReceipt.status 闭集（changed/unavailable/no_match/applied/partial/
 *     stale/failed/needs_input/unsupported，contracts.ts）与 offer.availability/gap 观测形态；
 *   - 每酒店有界恢复预算复用 availability-policy 的 MAX_OFFER_QUERIES_PER_HOTEL /
 *     MAX_OFFER_CHECKS_PER_HOTEL（RECOVERY_REUSED_BUDGETS 冻结引用，防两处漂移）；
 *   - 恢复轮次的模型调用语义对齐 planner 三次调用预算（dsh-planner attempt < 3）：
 *     每个触发源最多 3 次计入预算的恢复轮，第 4 次结构性拒绝、必须降级；
 *   - 审计事件命名沿用账本 booking.copilot.* 命名空间（runtime.ts 事件 kind 惯例）；
 *     链校验形态对齐 booking-saga 的 sagaTraceViolations（开立→推进→终态吸收）。
 *
 * 红线（全部结构性编码）：
 *   - changed/unavailable 必须显式分类——不静默当确认，也不静默丢弃；
 *   - 不可确认证据只产生 inconclusive，不得宣称「市场无房」（与 availability reducer 同红线）；
 *   - 恢复命中与用户原选择不同酒店/报价 = 替换，必须先出显式披露——静默换房换航结构性拒绝；
 *   - 恢复耗尽只能显式降级并向用户披露，不得静默替换或假称确认；
 *   - 版本位移（v1→v2）的解决必须携带非空变化说明——不静默换版；
 *   - 每条审计事件带 receiptDigest 可回溯；resolved/degraded 为吸收终态，其后不得再有事件；
 *   - 纯函数：每次推进返回新状态，原状态不可变。
 */

import { createHash } from 'node:crypto'
import type { ActionReceipt } from './contracts.ts'
import { MAX_OFFER_CHECKS_PER_HOTEL, MAX_OFFER_QUERIES_PER_HOTEL } from './availability-policy.ts'

export const RECOVERY_CHAIN_SCHEMA = 'booking_recovery_chain.v1'

/** 每个触发源最多 3 次计入预算的恢复轮——对齐 planner 三次调用预算的语义（dsh-planner attempt < 3）。 */
export const MAX_RECOVERY_MODEL_TURNS_PER_TRIGGER = 3
export const MAX_RECOVERY_BUDGET_NOTE =
  '3 counted model turns per trigger, aligned with the planner three-call attempt budget (dsh-planner); ' +
  'per-hotel query/check budgets stay policy-owned (availability-policy MAX_OFFER_QUERIES_PER_HOTEL / MAX_OFFER_CHECKS_PER_HOTEL)'

/** 恢复重试计入的既有预算（冻结引用 availability-policy 常量，防两处漂移）。 */
export const RECOVERY_REUSED_BUDGETS = {
  offerQueriesPerHotel: MAX_OFFER_QUERIES_PER_HOTEL,
  offerChecksPerHotel: MAX_OFFER_CHECKS_PER_HOTEL,
  modelTurnsPerTrigger: MAX_RECOVERY_MODEL_TURNS_PER_TRIGGER,
} as const

/** 检测分类（闭集；与 ActionReceipt.status 词汇一一对应，不发明新通道）。 */
export type RecoveryClassification =
  | { kind: 'confirmed'; offerRef: string; offerVersionRef: string; verifiedOfferRef: string }
  | { kind: 'changed'; offerRef: string; checkedOfferVersionRef: string; currentOfferVersionRef?: string; changedFactRefs: string[]; reason: string }
  | { kind: 'unavailable'; offerRef: string; offerVersionRef: string; reason: string }
  | { kind: 'inconclusive'; reason: string }
  | { kind: 'unrelated'; observationKind: ActionReceipt['observation']['kind']; reason: string }

export type RecoveryChainPhase = 'detected' | 'recovering' | 'resolved' | 'degraded'

/** 受控恢复的路径闭集：换版重查 / 同酒店重查 / 替代候选——恢复不开新的无界重试通道。 */
export type RecoveryApproach = 'recheck_version' | 'requery_same_hotel' | 'alternative_candidate'
const RECOVERY_APPROACHES: ReadonlySet<string> = new Set(['recheck_version', 'requery_same_hotel', 'alternative_candidate'])

export interface RecoverySelectionRef { hotelRef: string; offerRef: string; offerVersionRef: string }

export type RecoveryAuditEventKind =
  | 'recovery.detected'
  | 'recovery.attempt'
  | 'recovery.disclosed'
  | 'recovery.resolved'
  | 'recovery.degraded'

/** 审计事件（账本 booking.copilot.* 命名空间惯例；receiptDigest 证据链，不落敏感原值）。 */
export interface RecoveryAuditEvent {
  at: string
  kind: RecoveryAuditEventKind
  from: RecoveryChainPhase
  to: RecoveryChainPhase
  reason: string
  /** sha256(分类输入 receipt 的规范 JSON)——可回溯原始凭证 */
  receiptDigest?: string
  target?: RecoverySelectionRef
  substitution?: boolean
}

export interface RecoveryChainState {
  readonly schemaVersion: typeof RECOVERY_CHAIN_SCHEMA
  readonly taskId: string
  readonly contextRef: string
  readonly trigger: 'changed' | 'unavailable' | 'inconclusive'
  readonly triggerReason: string
  /** 用户原选择：替换判定的不变基线 */
  readonly originalSelection: RecoverySelectionRef
  readonly countedModelTurns: number
  readonly phase: RecoveryChainPhase
  readonly substitutionDisclosed: boolean
  readonly resolvedTo?: RecoverySelectionRef
  readonly history: readonly RecoveryAuditEvent[]
}

function isNonEmpty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 }
function requireBinding(key: string, value: unknown): string {
  if (!isNonEmpty(value)) throw new Error(`recovery_binding_missing:${key}`)
  return value
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, stable((value as Record<string, unknown>)[key])]))
}

/** 分类输入 receipt 的规范摘要（键排序后 sha256；证据链锚点）。 */
export function receiptDigestOf(receipt: ActionReceipt): string {
  return createHash('sha256').update(JSON.stringify(stable(receipt))).digest('hex')
}


/**
 * 检测（识别分类）：把一张 action receipt 分类到恢复链闭集。
 *  - offer.availability 观测：完整分类 + 连贯性守卫（与 availability reducer 同一套不变式，
 *    违例抛 availability_receipt_incoherent / availability_observation_required 同名错误）；
 *  - offers.state 观测：query seam，generation 折叠归 policy 所有 → unrelated；
 *  - gap 观测：不可确认 → inconclusive（不得宣称市场无房）；
 *  - 其余观测上的 changed/unavailable/no_match 是错配凭证 → fail-closed 抛错；
 *    其余状态（applied/partial/…）落在其他 seam → unrelated。
 */
export function classifyRecoveryTrigger(receipt: ActionReceipt): RecoveryClassification {
  const observation = receipt.observation
  if (observation.kind === 'offers.state') return { kind: 'unrelated', observationKind: observation.kind, reason: 'query seam: generation folding is availability-policy owned' }
  if (observation.kind === 'gap') return { kind: 'inconclusive', reason: `gap observation (${observation.code}): unconfirmable evidence — not_claim_market_empty` }
  if (observation.kind !== 'offer.availability') {
    if (['changed', 'unavailable', 'no_match'].includes(receipt.status)) throw new Error('availability_observation_required')
    return { kind: 'unrelated', observationKind: observation.kind, reason: `receipt status ${receipt.status} rides a non-offer observation` }
  }
  const { offerRef, checkedOfferVersionRef, available, currentOfferVersionRef, verifiedOfferRef, changedFactRefs } = observation
  // 连贯性守卫（镜像 recordOfferCheckReceipt 的 incoherent 判定，fail-closed）
  if (available && (receipt.resultContract.outcome === 'empty' || ['unavailable', 'no_match', 'failed', 'stale', 'unsupported'].includes(receipt.status))) throw new Error('availability_receipt_incoherent')
  if (!available && (verifiedOfferRef || currentOfferVersionRef)) throw new Error('availability_receipt_incoherent')
  if (['unavailable', 'no_match'].includes(receipt.status) && receipt.resultContract.outcome !== 'empty') throw new Error('availability_receipt_incoherent')
  if (receipt.status === 'applied' && available && currentOfferVersionRef === checkedOfferVersionRef && verifiedOfferRef && changedFactRefs.length === 0) {
    return { kind: 'confirmed', offerRef, offerVersionRef: checkedOfferVersionRef, verifiedOfferRef }
  }
  if (receipt.status === 'changed' && available && currentOfferVersionRef && currentOfferVersionRef !== checkedOfferVersionRef) {
    return { kind: 'changed', offerRef, checkedOfferVersionRef, currentOfferVersionRef, changedFactRefs, reason: `supplier superseded ${checkedOfferVersionRef} with ${currentOfferVersionRef} (${changedFactRefs.join(',') || 'unspecified facts'})` }
  }
  if (['unavailable', 'no_match'].includes(receipt.status) && !available) {
    return { kind: 'unavailable', offerRef, offerVersionRef: checkedOfferVersionRef, reason: `complete negative evidence (${receipt.status}, empty outcome)` }
  }
  return { kind: 'inconclusive', reason: `status ${receipt.status}: unconfirmable evidence — partial/stale/failed/gap cannot claim market empty (not_claim_market_empty)` }
}

function isSelection(value: unknown): value is RecoverySelectionRef {
  const candidate = value as RecoverySelectionRef
  return Boolean(candidate && isNonEmpty(candidate.hotelRef) && isNonEmpty(candidate.offerRef) && isNonEmpty(candidate.offerVersionRef))
}

function sameOfferTarget(a: RecoverySelectionRef, b: RecoverySelectionRef): boolean {
  return a.hotelRef === b.hotelRef && a.offerRef === b.offerRef
}

/**
 * 开立恢复链：检测出 changed/unavailable/inconclusive 触发后建链（fail-closed 绑定键 +
 * 首条 recovery.detected 审计事件）。confirmed 无需恢复链、unrelated 无触发，均拒绝开链。
 */
export function openRecoveryChain(seed: {
  taskId: string
  contextRef: string
  receipt: ActionReceipt
  originalSelection: RecoverySelectionRef
  at: string
}): RecoveryChainState {
  const taskId = requireBinding('taskId', seed.taskId)
  const contextRef = requireBinding('contextRef', seed.contextRef)
  if (!isNonEmpty(seed.at)) throw new Error('recovery_binding_missing:at')
  const originalSelection = seed.originalSelection
  if (!isSelection(originalSelection)) throw new Error('recovery_binding_missing:originalSelection')
  const classification = classifyRecoveryTrigger(seed.receipt)
  if (classification.kind === 'confirmed') throw new Error('recovery_chain_not_required')
  if (classification.kind === 'unrelated') throw new Error('recovery_trigger_absent')
  return {
    schemaVersion: RECOVERY_CHAIN_SCHEMA,
    taskId,
    contextRef,
    trigger: classification.kind,
    triggerReason: classification.reason,
    originalSelection: { ...originalSelection },
    countedModelTurns: 0,
    phase: 'detected',
    substitutionDisclosed: false,
    history: [{
      at: seed.at,
      kind: 'recovery.detected',
      from: 'detected',
      to: 'detected',
      reason: classification.reason,
      receiptDigest: receiptDigestOf(seed.receipt),
      target: { ...originalSelection },
    }],
  }
}

/**
 * 受控恢复推进：一步一凭证（重查/换版复查/替代候选的检查结果）。
 *  - confirmed → resolved；目标与原选择不同酒店/报价且未先披露 = 静默替换，结构性拒绝；
 *  - 其余分类 → 计入预算的恢复轮（countedModelTurns + 1，含确认轮）；超 3 次拒绝、必须降级；
 *  - resolved/degraded 为吸收终态，其后不得再有 attempt。
 */
export function attemptRecoveryStep(
  state: RecoveryChainState,
  attempt: { receipt: ActionReceipt; target: RecoverySelectionRef; approach: RecoveryApproach },
  at: string,
): RecoveryChainState {
  if (state.phase === 'resolved' || state.phase === 'degraded') throw new Error('recovery_chain_terminal')
  if (!RECOVERY_APPROACHES.has(attempt.approach)) throw new Error('recovery_approach_invalid')
  if (!isNonEmpty(at)) throw new Error('recovery_binding_missing:at')
  if (!isSelection(attempt.target)) throw new Error('recovery_binding_missing:target')
  const classification = classifyRecoveryTrigger(attempt.receipt)
  if (classification.kind === 'unrelated') throw new Error('recovery_trigger_absent')
  if (classification.kind === 'confirmed') {
    if (!sameOfferTarget(attempt.target, state.originalSelection) && !state.substitutionDisclosed) {
      throw new Error('recovery_silent_swap_forbidden')
    }
    const versionShifted = attempt.target.offerVersionRef !== state.originalSelection.offerVersionRef
    return {
      ...state,
      phase: 'resolved',
      resolvedTo: { ...attempt.target },
      history: [...state.history, {
        at,
        kind: 'recovery.resolved',
        from: state.phase,
        to: 'resolved',
        reason: `confirmed via ${attempt.approach}${versionShifted ? ' on superseded version' : ''}`,
        receiptDigest: receiptDigestOf(attempt.receipt),
        target: { ...attempt.target },
        substitution: !sameOfferTarget(attempt.target, state.originalSelection),
      }],
    }
  }
  if (state.countedModelTurns + 1 > MAX_RECOVERY_MODEL_TURNS_PER_TRIGGER) {
    throw new Error(`recovery_model_turn_budget_exhausted (${MAX_RECOVERY_MODEL_TURNS_PER_TRIGGER} counted turns per trigger; degrade explicitly instead of retrying)`)
  }
  const reason = classification.reason
  return {
    ...state,
    phase: 'recovering',
    countedModelTurns: state.countedModelTurns + 1,
    history: [...state.history, {
      at,
      kind: 'recovery.attempt',
      from: state.phase,
      to: 'recovering',
      reason: `${attempt.approach}: ${classification.kind}: ${reason}`,
      receiptDigest: receiptDigestOf(attempt.receipt),
      target: { ...attempt.target },
    }],
  }
}

/**
 * 替换披露：恢复将落在与用户原选择不同的酒店/报价上时，必须在确认前显式披露。
 * 空披露文本拒绝——「显式说明变化，不静默换房换航」的结构化落点。
 */
export function discloseSubstitution(
  state: RecoveryChainState,
  disclosure: { target: RecoverySelectionRef; disclosureText: string; at: string },
): RecoveryChainState {
  if (state.phase === 'resolved' || state.phase === 'degraded') throw new Error('recovery_chain_terminal')
  if (!isNonEmpty(disclosure.disclosureText)) throw new Error('recovery_disclosure_required')
  if (!isSelection(disclosure.target)) throw new Error('recovery_binding_missing:target')
  if (!isNonEmpty(disclosure.at)) throw new Error('recovery_binding_missing:at')
  return {
    ...state,
    substitutionDisclosed: true,
    history: [...state.history, {
      at: disclosure.at,
      kind: 'recovery.disclosed',
      from: state.phase,
      to: state.phase,
      reason: disclosure.disclosureText.slice(0, 500),
      target: { ...disclosure.target },
      substitution: true,
    }],
  }
}

/**
 * 显式降级：恢复预算耗尽（或有界候选全负/不可确认）时，只能携非空用户披露降级结束——
 * 静默降级拒绝；降级后链吸收，不得再推进。
 */
export function degradeRecoveryChain(
  state: RecoveryChainState,
  degrade: { reason: string; disclosureText: string; at: string },
): RecoveryChainState {
  if (state.phase === 'resolved' || state.phase === 'degraded') throw new Error('recovery_chain_terminal')
  if (!isNonEmpty(degrade.reason)) throw new Error('recovery_binding_missing:reason')
  if (!isNonEmpty(degrade.disclosureText)) throw new Error('recovery_degrade_requires_disclosure')
  if (!isNonEmpty(degrade.at)) throw new Error('recovery_binding_missing:at')
  return {
    ...state,
    phase: 'degraded',
    history: [...state.history,
      {
        at: degrade.at,
        kind: 'recovery.disclosed',
        from: state.phase,
        to: state.phase,
        reason: degrade.disclosureText.slice(0, 500),
        substitution: false,
      },
      {
        at: degrade.at,
        kind: 'recovery.degraded',
        from: state.phase,
        to: 'degraded',
        reason: degrade.reason.slice(0, 500),
      },
    ],
  }
}

/** 用户沟通投影：结构化披露（substitution/versionShifted/确定性说明文本）。 */
export function buildUserDisclosure(state: RecoveryChainState): {
  substitution: boolean
  versionShifted: boolean
  text: string
} {
  if (state.phase === 'resolved' && state.resolvedTo) {
    const substitution = !sameOfferTarget(state.resolvedTo, state.originalSelection)
    const versionShifted = state.resolvedTo.offerVersionRef !== state.originalSelection.offerVersionRef
    if (substitution) {
      return {
        substitution,
        versionShifted,
        text: `Availability changed: original ${state.originalSelection.hotelRef}/${state.originalSelection.offerRef} could not be confirmed (${state.triggerReason}). The substitute ${state.resolvedTo.hotelRef}/${state.resolvedTo.offerRef} is disclosed explicitly for your approval — no silent swap.`,
      }
    }
    if (versionShifted) {
      return {
        substitution,
        versionShifted,
        text: `Availability changed: ${state.originalSelection.offerRef} moved from version ${state.originalSelection.offerVersionRef} to ${state.resolvedTo.offerVersionRef} at the supplier; re-confirmed on the new version.`,
      }
    }
    return { substitution, versionShifted, text: 'Original selection confirmed after recovery.' }
  }
  if (state.phase === 'degraded') {
    return { substitution: false, versionShifted: false, text: `Recovery exhausted for ${state.originalSelection.hotelRef}/${state.originalSelection.offerRef}: ${state.triggerReason}. Task ended explicitly with no substitute booked.` }
  }
  return { substitution: false, versionShifted: false, text: `Recovery in progress: supplier reported ${state.trigger} — ${state.triggerReason}` }
}

/**
 * 审计链校验（形态对齐 booking-saga 的 sagaTraceViolations；空数组 = 链合法）：
 *  - 必须以恰好一条 recovery.detected 开链；
 *  - resolved/degraded 至多各一次且为吸收终态——其后不得有任何事件；
 *  - attempt/disclosed 只许出现在终态前；
 *  - resolved 目标与 detected 原目标不同酒店/报价时，之前必须有 substitution=true 的披露；
 *  - degraded 之前必须有披露事件（静默降级违例）。
 */
export function recoveryAuditViolations(events: ReadonlyArray<RecoveryAuditEvent>): string[] {
  const violations: string[] = []
  let opened = false
  let detectedTarget: RecoverySelectionRef | undefined
  let terminal: 'resolved' | 'degraded' | undefined
  let disclosedSubstitution = false
  let disclosedSeen = false
  events.forEach((event, index) => {
    const at = `#${index} ${event.kind}`
    if (terminal) { violations.push(`${at}: 终态(${terminal})后出现事件(吸收态)`) ; return }
    switch (event.kind) {
      case 'recovery.detected': {
        if (opened) { violations.push(`${at}: 重复开链`); return }
        opened = true
        detectedTarget = event.target
        return
      }
      case 'recovery.attempt': {
        if (!opened) { violations.push(`${at}: 开链前的 attempt`); return }
        return
      }
      case 'recovery.disclosed': {
        if (!opened) { violations.push(`${at}: 开链前的披露`); return }
        disclosedSeen = true
        if (event.substitution) disclosedSubstitution = true
        return
      }
      case 'recovery.resolved': {
        if (!opened) { violations.push(`${at}: 开链前的 resolved`); return }
        if (detectedTarget && event.target && !sameOfferTarget(event.target, detectedTarget) && !disclosedSubstitution) {
          violations.push(`${at}: 静默替换(resolved 目标偏离原选择且无披露)`)
        }
        terminal = 'resolved'
        return
      }
      case 'recovery.degraded': {
        if (!opened) { violations.push(`${at}: 开链前的 degraded`); return }
        if (!disclosedSeen) violations.push(`${at}: 静默降级(degraded 前无披露)`)
        terminal = 'degraded'
        return
      }
      default:
        violations.push(`${at}: 未知事件 kind`)
    }
  })
  if (!opened) violations.push('链未以 recovery.detected 开立')
  return violations
}
