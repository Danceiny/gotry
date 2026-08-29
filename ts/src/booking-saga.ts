/**
 * 预订 saga 状态机(booking_saga_fsm.v1)——issue #17 采纳三点的具名化落点。
 *
 * 立场(docs/booking-saga-fsm.md / ADR-17):不引入编排框架;预订 saga 的状态字母表与边表
 * 就是账本 pending_writes(status CHECK:pending|confirmed|compensated)的显式化。
 * 本模块是纯函数词汇层,零依赖、零行为、不接线任何 seam——M5 拍板 WriteGate 生产化时
 * 以此为唯一状态推进词汇(具名化 = 状态与边不再散落在 SQL 字符串里)。
 *
 * 物理对账目标(state-ledger.ts,TS-4 基座):
 *  - propose  = requestPendingWrite(∅ → pending,L2 只登记不执行;idem_key UNIQUE,重复提议 no-op)
 *  - confirm  = confirmPendingWrite(pending → confirmed,L3 具名 seam 确认,携 receipt;无 receipt 则视为缺省空串)
 *  - compensate = compensatePendingWrite(pending|confirmed → compensated,吸收态,无出边)
 *  - 审计事件 kind:write.pending / write.confirmed / write.compensated
 */

export const BOOKING_SAGA_SCHEMA = 'booking_saga_fsm.v1'

export type SagaStatus = 'pending' | 'confirmed' | 'compensated'
export type SagaOrigin = 'none' | SagaStatus
export type SagaTrigger = 'propose' | 'confirm' | 'compensate'
export type SagaLedgerEvent = 'write.pending' | 'write.confirmed' | 'write.compensated'

/** 状态字母表(与 pending_writes.status CHECK 约束逐字一致) */
export const SAGA_STATUSES = ['pending', 'confirmed', 'compensated'] as const satisfies readonly SagaStatus[]

export interface SagaEdge {
  from: SagaOrigin
  trigger: SagaTrigger
  to: SagaStatus
  event: SagaLedgerEvent
  /** 边的守卫说明;物理执行在账本事务内(UNIQUE 守卫/CHECK),此处为语义面 */
  guard: string
}

/**
 * 边表(预订流程 FSM 的全部合法转移):
 *  ∅ --propose--> pending --confirm--> confirmed
 *        │             │
 *        └---(任何状态) --compensate--> compensated(吸收态,无出边)
 */
export const SAGA_EDGES: ReadonlyArray<SagaEdge> = [
  { from: 'none', trigger: 'propose', to: 'pending', event: 'write.pending', guard: 'L2 只登记不执行;idem_key UNIQUE(重复提议 no-op)' },
  { from: 'pending', trigger: 'confirm', to: 'confirmed', event: 'write.confirmed', guard: 'L3 具名 seam 确认,必携 receipt;已确认不可再确认' },
  { from: 'pending', trigger: 'compensate', to: 'compensated', event: 'write.compensated', guard: '外部写未发生,取消即终态(无补偿动作)' },
  { from: 'confirmed', trigger: 'compensate', to: 'compensated', event: 'write.compensated', guard: '已发生副作用的 saga 补偿(退改),receipt 保留(COALESCE)' },
]

export type SagaRejection =
  | 'missing-subject'
  | 'idem-exists'
  | 'already-confirmed'
  | 'absorbed-compensated'
  | 'already-compensated'

/** 非边组合的拒绝理由(结构化,拒绝即不动——与账本 changes=0 同义) */
export const SAGA_REJECTIONS: ReadonlyArray<{ from: SagaOrigin; trigger: SagaTrigger; reason: SagaRejection }> = [
  { from: 'none', trigger: 'confirm', reason: 'missing-subject' },
  { from: 'none', trigger: 'compensate', reason: 'missing-subject' },
  { from: 'pending', trigger: 'propose', reason: 'idem-exists' },
  { from: 'confirmed', trigger: 'propose', reason: 'idem-exists' },
  { from: 'confirmed', trigger: 'confirm', reason: 'already-confirmed' },
  { from: 'compensated', trigger: 'propose', reason: 'idem-exists' },
  { from: 'compensated', trigger: 'confirm', reason: 'absorbed-compensated' },
  { from: 'compensated', trigger: 'compensate', reason: 'already-compensated' },
]

export type SagaVerdict =
  | { ok: true; from: SagaOrigin; trigger: SagaTrigger; to: SagaStatus; event: SagaLedgerEvent; guard: string; reason: null }
  | { ok: false; from: SagaOrigin; trigger: SagaTrigger; to: null; event: null; guard: null; reason: SagaRejection }

/** 触发解析:唯一归宿或结构化拒绝(预订 seam 的状态推进只许走这张表的边) */
export function resolveSagaTrigger(origin: SagaOrigin, trigger: SagaTrigger): SagaVerdict {
  const edge = SAGA_EDGES.find(e => e.from === origin && e.trigger === trigger)
  if (edge) return { ok: true, from: origin, trigger, to: edge.to, event: edge.event, guard: edge.guard, reason: null }
  const rejection = SAGA_REJECTIONS.find(e => e.from === origin && e.trigger === trigger)
  return { ok: false, from: origin, trigger, to: null, event: null, guard: null, reason: rejection!.reason }
}

/** 触发器 → 账本事件 kind 的唯一映射(写入侧命名不再各处硬编码) */
export const SAGA_TRIGGER_EVENT: Record<SagaTrigger, SagaLedgerEvent> = {
  propose: 'write.pending',
  confirm: 'write.confirmed',
  compensate: 'write.compensated',
}

/** 账本事件 kind → 触发器(读取/审计侧);非 saga 事件返回 null */
export function triggerOfEventKind(kind: string): SagaTrigger | null {
  if (kind === 'write.pending') return 'propose'
  if (kind === 'write.confirmed') return 'confirm'
  if (kind === 'write.compensated') return 'compensate'
  return null
}

export interface SagaAuditEvent {
  seq?: number
  kind: string
  /** write.confirmed 携带的外部回执(payload.receipt) */
  receipt?: string | null
}

/**
 * 审计链校验(单 idem_key 的 write.* 事件序列):必须恰好走出边表的一条合法路径。
 *  - 链以 write.pending 开头;
 *  - confirm/compensate 至多各一次;
 *  - compensated 之后不允许任何 saga 事件(吸收态);
 *  - write.confirmed 的 receipt 为空(缺省/空串)即违例——L3 具名确认必携外部回执;
 *  - 非 write.* 事件(其他域审计)穿插不计。
 * 返回违例清单(空数组 = 链合法)。
 */
export function sagaTraceViolations(events: ReadonlyArray<SagaAuditEvent>): string[] {
  const violations: string[] = []
  let stage: SagaOrigin = 'none'
  for (const ev of events) {
    const trigger = triggerOfEventKind(ev.kind)
    if (!trigger) continue
    const verdict = resolveSagaTrigger(stage, trigger)
    const at = `seq=${ev.seq ?? '?'} ${ev.kind}`
    if (!verdict.ok) {
      violations.push(`${at}: 非法(${stage} --${trigger}--> 拒绝 ${verdict.reason})`)
      continue
    }
    stage = verdict.to
    if (trigger === 'confirm' && (ev.receipt === undefined || ev.receipt === null || ev.receipt === '')) {
      violations.push(`${at}: receipt 为空(L3 具名确认必携外部回执)`)
    }
  }
  return violations
}

/** 完整合法路径集合(文档/测试共用):∅→pending→confirmed→compensated 与其前缀 */
export function sagaLegalPaths(): ReadonlyArray<ReadonlyArray<SagaTrigger>> {
  return [['propose'], ['propose', 'compensate'], ['propose', 'confirm'], ['propose', 'confirm', 'compensate']]
}