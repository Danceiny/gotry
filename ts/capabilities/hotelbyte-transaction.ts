/**
 * HotelByte 交易 bridge 与 unknown 查单对账契约层(issue #232 契约/模块切片)。
 *
 * ⚠ 非运行时激活:本模块是纯函数契约层,不 spawn 子进程、不发起网络请求、
 * 不读取任何凭据,与真实 HotelByte 二进制/UAT 零接触(见 issue #318 的
 * GOTRY_HBCLI_LIVE 显式 opt-in 门——真实调用面在 M5 Entry 后才允许接线,
 * 且必须挂在该门之后)。一切行为由 fixture/合成数据证明(hotelbyte-reconcile-tests)。
 *
 * 词汇与边界(上游文档为准):
 *   - docs/design/write-gate-production-design.md §3(SupplierOutcome/WriteEffectIntent/
 *     attempt_id/fencing)、§5.3(dispatch 未知态)、§6(准入矩阵)、§7(unknown 查单/恢复窗口);
 *   - docs/design/fact-writegate-seam.md(读侧 fact 与写侧 SupplierOutcome 两闸分离)。
 *
 * 与 #231(WriteGate outbox)的接口边界:本模块只消费 outbox intent 的**引用 ID 字符串**
 * (`outboxIntentRef` 占位)与审批凭证摘要,不实现、不触碰 outbox/dispatch 持久化——
 * attempt 领取、fencing token、账本事务由 #231 落地;两者以该 ID 关联(#231 未合前为占位)。
 *
 * 对账红线(全部结构性编码,见 advanceReconciliation):
 *   - unknown/无法确认的查单结果必须有显式对账分类——不静默当成功,也不静默丢弃;
 *   - CLI exit0 非成功证明:timeout/kill/坏响应/无绑定成功/部分确认一律 unknown;
 *   - 查单 miss 在恢复窗口内(后端 180s Phase1 + 最长 10min Phase2)保持 unknown,禁止重订;
 *   - 时间届满本身不是无订单证明——只转人工,不自动 reconciled_failed;
 *   - 只有绑定 attempt/customerReferenceNo 的权威终态负证据(供应商终态取消/失败、
 *     绑定 attempt 的人工无订单确认)才允许新 intent;
 *   - 同 ref 多单/参考号不匹配 = 冲突,显式 manual_reconcile;
 *   - 终态后出现反证只置 conflict 交人工,不静默翻转;
 *   - 每次推进追加审计事件(带 probeDigest),记录不可变(pure function)。
 */

import { createHash } from 'node:crypto'

/** HotelByte 后端恢复窗口:Phase1 180s + Phase2 最长 10min(600s);上界 780s。 */
export const RECOVERY_WINDOW_PHASE1_SECONDS = 180
export const RECOVERY_WINDOW_PHASE2_MAX_SECONDS = 600
export const RECOVERY_WINDOW_TOTAL_MAX_SECONDS =
  RECOVERY_WINDOW_PHASE1_SECONDS + RECOVERY_WINDOW_PHASE2_MAX_SECONDS

/** 对账状态投影(write-gate-production-design §3 SupplierOutcome 的对账子集;cancel/refund 面归 #233)。 */
export type SupplierOutcomeStatus = 'unknown' | 'reconciled_success' | 'reconciled_failed'

/** 对账推进后的行动指令:unknown 期间结构性禁止重订。 */
export type ReconcileNextAction = 'keep_querying' | 'manual_reconcile' | 'terminal'

/** 审计链事件:每次对账推进追加一条,带探针摘要(probeDigest)可回溯原始输入。 */
export interface ReconciliationEvent {
  at: string
  action: string
  from: SupplierOutcomeStatus
  to: SupplierOutcomeStatus
  reason: string
  /** sha256(原始探针输入的规范化 JSON)——证据链,不落敏感原值 */
  probeDigest: string
}

/** 对账记录:绑定键在进入 unknown 时即冻结(不可变 attempt),全程可追溯。 */
export interface ReconciliationState {
  /** 不可变 attempt:任何外部调用前由 #231 dispatch 层持久化;对账永远引用同一 attempt */
  readonly attemptId: string
  /** 同 intent 不可变 attempt 键(供应商侧后端允许 Cancelled/Failed 同 ref 再建,永久幂等不可假定) */
  readonly customerReferenceNo: string
  /** 账本 intent 幂等键(#231 事务 1 产物) */
  readonly intentIdemKey: string
  /** 规范化请求摘要(确认后不可更换旅客/联系人仍沿用旧授权) */
  readonly requestFingerprintSha256: string
  readonly enteredUnknownAt: string
  /** 恢复窗口上界(enter + 780s);届满 ≠ 无订单证明 */
  readonly recoveryWindowEndsAt: string
  /** 读侧可追溯:进入本 intent 的 bookable fact 锚 */
  readonly factId?: string
  /** L3 审批凭证摘要(只存 digest,不存原值) */
  readonly approvalReceiptDigest?: string
  /** outbox intent 引用(#231 WriteEffectIntent 占位;#231 未合前为纯 ID 占位) */
  readonly outboxIntentRef?: string
  readonly status: SupplierOutcomeStatus
  readonly nextAction: ReconcileNextAction
  /** 显式冲突标记:多单/参考号不匹配/终态反证——必须人工,不静默收敛 */
  readonly conflict: boolean
  readonly history: readonly ReconciliationEvent[]
}

/** 进入 unknown 的种子(booking 调用后不可判定即建;绑定键缺一即拒)。 */
export interface ReconciliationSeed {
  attemptId: string
  customerReferenceNo: string
  intentIdemKey: string
  requestFingerprintSha256: string
  enteredUnknownAt: string
  recoveryWindowEndsAt: string
  factId?: string
  approvalReceiptDigest?: string
  outboxIntentRef?: string
}

function requireBinding(key: string, value: string | undefined): string {
  const v = (value ?? '').trim()
  if (!v) throw new Error(`hotelbyte-reconcile: 对账记录缺绑定键 ${key}(fail-closed;无绑定键即无法追溯)`)
  return v
}

function probeDigest(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input ?? null)).digest('hex')
}

/** 恢复窗口上界:enterUnknownAt + 780s(180s Phase1 + 最长 10min Phase2)。 */
export function recoveryWindowEndsAt(enteredUnknownAt: string): string {
  return new Date(Date.parse(enteredUnknownAt) + RECOVERY_WINDOW_TOTAL_MAX_SECONDS * 1000).toISOString()
}

/**
 * 进入 unknown:booking 结果不可判定(超时/被杀/坏响应/部分确认)即建对账记录。
 * 绑定键缺失直接抛错——没有绑定键的对账是不可追溯的黑洞,红线拒绝。
 */
export function enterUnknown(seed: ReconciliationSeed): ReconciliationState {
  const attemptId = requireBinding('attemptId', seed.attemptId)
  const customerReferenceNo = requireBinding('customerReferenceNo', seed.customerReferenceNo)
  const intentIdemKey = requireBinding('intentIdemKey', seed.intentIdemKey)
  const requestFingerprintSha256 = requireBinding('requestFingerprintSha256', seed.requestFingerprintSha256)
  const recoveryWindowEndsAtV = requireBinding('recoveryWindowEndsAt', seed.recoveryWindowEndsAt)
  const enteredUnknownAt = requireBinding('enteredUnknownAt', seed.enteredUnknownAt)
  if (Number.isNaN(Date.parse(enteredUnknownAt)) || Number.isNaN(Date.parse(recoveryWindowEndsAtV))) {
    throw new Error('hotelbyte-reconcile: enteredUnknownAt/recoveryWindowEndsAt 必须是可解析时间')
  }
  return {
    attemptId,
    customerReferenceNo,
    intentIdemKey,
    requestFingerprintSha256,
    enteredUnknownAt,
    recoveryWindowEndsAt: recoveryWindowEndsAtV,
    factId: seed.factId,
    approvalReceiptDigest: seed.approvalReceiptDigest,
    outboxIntentRef: seed.outboxIntentRef,
    status: 'unknown',
    nextAction: 'keep_querying',
    conflict: false,
    history: [{
      at: enteredUnknownAt,
      action: 'enter_unknown',
      from: 'unknown',
      to: 'unknown',
      reason: 'booking 结果不可判定,进入显式对账(禁止盲目重试/重订)',
      probeDigest: probeDigest(seed),
    }],
  }
}

/** book 执行结果(由未来受控子进程 adapter 灌入;本模块只做分类,不执行)。 */
export interface BookExecutionResult {
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  stdout: string
  stderr: string
}

export type BookBridgeClassification =
  | { kind: 'binding_verified'; customerReferenceNo: string; payload: Record<string, unknown> }
  | { kind: 'supplier_failed'; reason: string; payload: Record<string, unknown> | null }
  | { kind: 'unknown'; reason: string }

interface BookPayload {
  status?: string
  customerReferenceNo?: string
  [k: string]: unknown
}

function parseBookPayload(stdout: string): { json: BookPayload | null; parseError?: string } {
  const start = stdout.search(/[{[]/)
  if (start < 0) return { json: null, parseError: 'no-json-marker' }
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { json: null, parseError: 'non-object-json' }
    }
    return { json: parsed as BookPayload }
  } catch (e) {
    return { json: null, parseError: `unparseable:${(e as Error).message.slice(0, 80)}` }
  }
}

/**
 * book 执行分类(验收 §3:CLI exit0 非成功证明;timeout/kill/坏响应/结果不确定归 unknown):
 *   - timedOut / signal / 非零退码且无显式业务结论 → unknown;
 *   - exit0 + 非 JSON → unknown;exit0 + 显式业务失败 → supplier_failed;
 *   - exit0 + success 但缺/错 customerReferenceNo 绑定 → unknown(不可归因即不可当成功);
 *   - exit0 + pending/部分确认 → unknown;
 *   - exit0 + success + 参考号匹配本 attempt → binding_verified。
 */
export function classifyBookExecution(r: BookExecutionResult, expectedReferenceNo: string): BookBridgeClassification {
  if (r.timedOut) return { kind: 'unknown', reason: 'timeout(30s abort;后端可能仍在处理,进入 unknown 对账)' }
  if (r.signal) return { kind: 'unknown', reason: `process_killed:${r.signal}(副作用不可判定)` }
  const { json, parseError } = parseBookPayload(r.stdout)
  if (r.exitCode !== 0) {
    if (json?.status === 'failed') return { kind: 'supplier_failed', reason: 'nonzero-exit + explicit failed payload', payload: json }
    return { kind: 'unknown', reason: `nonzero_exit:${r.exitCode ?? 'null'}(无显式业务结论,不假定无副作用${parseError ? `;${parseError}` : ''})` }
  }
  if (!json) return { kind: 'unknown', reason: `exit0_non_json(坏响应,不可当成功;${parseError ?? 'empty'})` }
  if (json.status === 'failed') return { kind: 'supplier_failed', reason: 'explicit failed payload', payload: json }
  if (json.status === 'success') {
    const ref = typeof json.customerReferenceNo === 'string' ? json.customerReferenceNo.trim() : ''
    if (!ref) return { kind: 'unknown', reason: 'exit0_success_missing_reference(无绑定成功不可归因)' }
    if (ref !== expectedReferenceNo) return { kind: 'unknown', reason: `exit0_success_reference_mismatch(返回 ${ref},本 attempt ${expectedReferenceNo})` }
    return { kind: 'binding_verified', customerReferenceNo: ref, payload: json }
  }
  // pending / 其它一切不确定状态:部分确认 ≠ 成功
  return { kind: 'unknown', reason: `partial_or_indeterminate(status=${String(json.status ?? 'absent')})` }
}

/** 查单探针(query-orders;按授权查询面,只按 customerReferenceNo/attempt 查)。 */
export type QueryOrdersProbe =
  | { kind: 'hit'; orders: Array<{ customerReferenceNo: string; orderRef: string; supplierStatus: string }> }
  | { kind: 'miss' }
  | { kind: 'query_failed'; reason: string }
  | { kind: 'malformed'; reason: string }
  | { kind: 'permission_denied' }
  /** 人工对账结论:必须携带绑定 attempt 的非空操作证据(工单号/后台截图引用等) */
  | { kind: 'manual_no_order'; operatorEvidence: string }

/** 供应商终态取消/失败词汇(权威负证据来源;迟到自动取消按回执收敛)。 */
const SUPPLIER_TERMINAL_NEGATIVE = new Set(['cancelled', 'canceled', 'auto_canceled', 'failed', 'expired'])

/**
 * 对账状态机推进(纯函数;原状态不可变,返回带追加审计事件的新状态)。
 * 转移表对齐 write-gate-production-design §7 矩阵,红线见模块头注释。
 */
export function advanceReconciliation(
  state: ReconciliationState,
  probe: QueryOrdersProbe,
  now: string,
): ReconciliationState {
  const digest = probeDigest(probe)
  const append = (
    next: Omit<ReconciliationState, 'history'>,
    action: string,
    reason: string,
  ): ReconciliationState => ({
    ...next,
    history: [...state.history, { at: now, action, from: state.status, to: next.status, reason, probeDigest: digest }],
  })

  // 终态吸收 + 反证只置 conflict(不静默翻转)
  if (state.status !== 'unknown') {
    if (probe.kind === 'hit' && probe.orders.length > 0) {
      return append(
        { ...state, conflict: true, nextAction: 'manual_reconcile' },
        'conflict_late_hit_after_terminal',
        `终态(${state.status})后出现订单证据 → 显式冲突交人工复核,不静默翻转`,
      )
    }
    return { ...state }
  }

  if (probe.kind === 'manual_no_order') {
    const evidence = (probe.operatorEvidence ?? '').trim()
    if (!evidence) throw new Error('hotelbyte-reconcile: 人工无订单确认必须携带非空操作证据(绑定 attempt 可追溯)')
    return append(
      { ...state, status: 'reconciled_failed', nextAction: 'terminal', conflict: false },
      'manual_no_order_confirmed',
      `人工权威负证据:${evidence.slice(0, 200)}`,
    )
  }

  const withinWindow = Date.parse(now) <= Date.parse(state.recoveryWindowEndsAt)

  switch (probe.kind) {
    case 'miss': {
      if (withinWindow) {
        return append(
          { ...state, status: 'unknown', nextAction: 'keep_querying', conflict: false },
          'query_miss_within_window',
          '恢复窗口内查无 → 保持 unknown;供应商可能迟到建单,禁止重订',
        )
      }
      return append(
        { ...state, status: 'unknown', nextAction: 'manual_reconcile', conflict: false },
        'query_miss_after_window',
        '窗口届满查无 → 仍 unknown(时间届满本身不是无订单证明),转人工',
      )
    }
    case 'hit': {
      if (probe.orders.length > 1) {
        return append(
          { ...state, status: 'unknown', nextAction: 'manual_reconcile', conflict: true },
          'conflict_multiple_orders',
          `同参考号返回 ${probe.orders.length} 笔订单 → 冲突,人工对账(不静默择一)`,
        )
      }
      const order = probe.orders[0]
      if (order.customerReferenceNo !== state.customerReferenceNo) {
        return append(
          { ...state, status: 'unknown', nextAction: 'manual_reconcile', conflict: true },
          'conflict_reference_mismatch',
          `返回订单参考号 ${order.customerReferenceNo} ≠ 本 attempt ${state.customerReferenceNo} → 冲突,人工对账`,
        )
      }
      const status = order.supplierStatus.toLowerCase()
      if (SUPPLIER_TERMINAL_NEGATIVE.has(status)) {
        return append(
          { ...state, status: 'reconciled_failed', nextAction: 'terminal', conflict: false },
          'supplier_terminal_negative',
          `绑定 attempt 的供应商终态(${order.supplierStatus},orderRef=${order.orderRef})→ 权威负证据,收敛 reconciled_failed`,
        )
      }
      if (status === 'confirmed' || status === 'success' || status === 'completed') {
        return append(
          { ...state, status: 'reconciled_success', nextAction: 'terminal', conflict: false },
          'supplier_terminal_success',
          `绑定 attempt 的供应商终态成功(orderRef=${order.orderRef})→ reconciled_success(含迟到成功,不重订)`,
        )
      }
      return append(
        { ...state, status: 'unknown', nextAction: 'keep_querying', conflict: false },
        'hit_not_terminal',
        `订单存在但非终态(${order.supplierStatus})→ 保持 unknown 继续查`,
      )
    }
    case 'query_failed':
      return append(
        { ...state, status: 'unknown', nextAction: 'keep_querying', conflict: false },
        'query_failed',
        `查询自身失败(${probe.reason.slice(0, 120)})→ 探针失败不证明订单不存在,保持 unknown`,
      )
    case 'malformed':
      return append(
        { ...state, status: 'unknown', nextAction: 'keep_querying', conflict: false },
        'query_malformed',
        `畸形响应(${probe.reason.slice(0, 120)})→ 不静默当 miss,保持 unknown`,
      )
    case 'permission_denied':
      return append(
        { ...state, status: 'unknown', nextAction: 'manual_reconcile', conflict: false },
        'query_permission_denied',
        '查询权限拒绝 → 自助查单不可用,转人工对账',
      )
  }
}

/** 是否允许对同一请求发起新 intent:仅当收敛自绑定 attempt 的权威终态负证据且无未决冲突。 */
export function newIntentAllowed(state: ReconciliationState): boolean {
  return state.status === 'reconciled_failed' && !state.conflict
}
