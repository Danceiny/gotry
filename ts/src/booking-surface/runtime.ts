/**
 * Durable, task-scoped runtime for the embedded Booking Copilot.
 *
 * This is deliberately not a chat transcript. The ledger stores task identity,
 * typed operation metadata, typed receipts and digests of prose/payloads. Raw
 * user text and raw action criteria never enter durable state.
 */

import { createHash, randomUUID } from 'node:crypto'
import type { StateLedger } from '../state-ledger.ts'
import {
  type ActionReceiptContinuationV1,
  type ActionReceiptV1,
  type BookingExplanationEventV1,
  type BookingQuestionEventV1,
  type BookingReadActionKindV1,
  type BookingReadActionV1,
  type BookingStatusEventV1,
  type BookingSurfaceEventV1,
  type BookingTerminalEventV1,
  type BookingErrorEventV1,
  type BookingOperationEventV1,
  type BookingSurfaceV1,
  type UserTurnV1,
} from './contracts.ts'
import {
  validateBookingCopilotTurnV1,
  validateActionReceiptV1,
  validateBookingReadActionV1,
  validateBookingSurfaceEventV1,
} from './validation.ts'
import { normalizeBookingErrorCode, safeBookingErrorMessage } from './error-codes.ts'

export type {
  ActionReceiptContinuationV1,
  ActionReceiptV1,
  BookingReadActionV1,
  BookingSurfaceEventV1,
  UserTurnV1,
} from './contracts.ts'

const LEDGER_SCHEMA = 'booking.copilot.ledger.v1' as const
const LEDGER_ACTOR = 'system:booking-copilot'
const TASK_STARTED = 'booking.copilot.task.started'
const USER_TURN_OBSERVED = 'booking.copilot.user.turn.observed'
const ACTION_ISSUED = 'booking.copilot.action.issued'
const RECEIPT_OBSERVED = 'booking.copilot.receipt.observed'
const EVENT_EMITTED = 'booking.copilot.event.emitted'

export type BookingCopilotTaskPhaseV1 = 'planning' | 'waiting_receipt'

export interface BookingActionCheckpointV1 {
  actionId: string
  kind: BookingReadActionKindV1
  contextRef: string
  expectedRevision: number
  factRefs: string[]
  reasonDigest: string
  inputDigest: string
  actionDigest: string
  eventId: string
  sequence: number
  emittedAt: string
}

export interface BookingCopilotTaskStateV1 {
  schemaVersion: 'booking.surface.v1'
  taskId: string
  contextRef: string
  surface: BookingSurfaceV1
  revision: number
  allowedActions: BookingReadActionKindV1[]
  userTurnCount: number
  lastUserTurnDigest?: string
  phase: BookingCopilotTaskPhaseV1
  lastSequence: number
  pendingAction?: BookingActionCheckpointV1
  lastReceipt?: ActionReceiptV1
}

export type BookingSurfaceEventDraftV1 =
  | Pick<BookingStatusEventV1, 'kind' | 'status'>
  | Pick<BookingQuestionEventV1, 'kind' | 'question'>
  | Pick<BookingExplanationEventV1, 'kind' | 'explanation'>
  | Pick<BookingTerminalEventV1, 'kind' | 'terminal'>
  | Pick<BookingErrorEventV1, 'kind' | 'error'>

export interface BookingCopilotRuntimeOptions {
  idFactory?: (prefix: string) => string
  now?: () => string
}

interface LedgerPayloadBase {
  schema: typeof LEDGER_SCHEMA
  taskId: string
  contextRef: string
}

interface TaskStartedPayload extends LedgerPayloadBase {
  surface: BookingSurfaceV1
  revision: number
  allowedActions: BookingReadActionKindV1[]
}

interface UserTurnObservedPayload extends LedgerPayloadBase {
  requestDigest: string
}

interface ActionIssuedPayload extends LedgerPayloadBase {
  action: BookingActionCheckpointV1
}

interface ReceiptObservedPayload extends LedgerPayloadBase {
  receipt: ActionReceiptV1
  receiptDigest: string
}

interface EventEmittedPayload extends LedgerPayloadBase {
  eventId: string
  sequence: number
  emittedAt: string
  eventKind: Exclude<BookingSurfaceEventV1['kind'], 'operation'>
  contentDigest: string
}

interface BookingLedgerRow {
  seq: number
  kind: string
  payload: string
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (typeof value !== 'object' || value === null) return value
  const source = value as Record<string, unknown>
  const target: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) target[key] = stableValue(source[key])
  return target
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex')
}

function checkpointDigest(action: Pick<BookingActionCheckpointV1, 'actionId' | 'kind' | 'contextRef' | 'expectedRevision' | 'factRefs' | 'reasonDigest' | 'inputDigest' | 'eventId' | 'sequence' | 'emittedAt'>): string {
  return digest({
    actionId: action.actionId,
    kind: action.kind,
    contextRef: action.contextRef,
    expectedRevision: action.expectedRevision,
    factRefs: action.factRefs,
    reasonDigest: action.reasonDigest,
    inputDigest: action.inputDigest,
    eventId: action.eventId,
    sequence: action.sequence,
    emittedAt: action.emittedAt,
  })
}

function actionMatchesCheckpoint(action: BookingReadActionV1, checkpoint: BookingActionCheckpointV1): boolean {
  return checkpoint.actionDigest === checkpointDigest({
    actionId: checkpoint.actionId,
    kind: action.kind,
    contextRef: action.contextRef,
    expectedRevision: action.expectedRevision,
    factRefs: action.factRefs,
    reasonDigest: digest(action.reason),
    inputDigest: digest(action.input),
    eventId: checkpoint.eventId,
    sequence: checkpoint.sequence,
    emittedAt: checkpoint.emittedAt,
  })
}

function assertSafeFactRefs(action: BookingReadActionV1): void {
  const opaque = (ref: string) => /^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(ref) && !/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/i.test(ref)
  if (!opaque(action.actionId)) throw new Error('unsafe_action_id')
  if (action.factRefs.some((ref) => !opaque(ref))) throw new Error('unsafe_fact_ref')
}

function validationMessage(result: ReturnType<typeof validateBookingCopilotTurnV1>): string {
  return result.ok ? '' : result.errors.join('; ')
}

function assertTaskId(taskId: string): void {
  if (!taskId) throw new Error('invalid_task_id')
}

function sameActionAllowlist(left: readonly BookingReadActionKindV1[], right: readonly BookingReadActionKindV1[]): boolean {
  return left.length === right.length && [...left].sort().every((kind, index) => kind === [...right].sort()[index])
}

export class BookingCopilotTaskRuntime {
  private readonly idFactory: (prefix: string) => string
  private readonly now: () => string

  constructor(
    private readonly ledger: StateLedger,
    options: BookingCopilotRuntimeOptions = {},
  ) {
    this.idFactory = options.idFactory ?? ((prefix) => `${prefix}-${randomUUID()}`)
    this.now = options.now ?? (() => new Date().toISOString())
  }

  startTask(turn: UserTurnV1): BookingCopilotTaskStateV1 {
    const validation = validateBookingCopilotTurnV1(turn)
    if (!validation.ok || turn.kind !== 'user.turn') throw new Error(`invalid_planner_turn:${validationMessage(validation)}`)
    const taskId = turn.taskId ?? this.idFactory('task')
    assertTaskId(taskId)
    const requestDigest = digest(turn.request.text)
    // The task fold and its user-turn append must share one write transaction.
    // An immediate transaction serializes separate processes before either can
    // derive state (and therefore an ordinal/next event sequence) from a stale
    // snapshot.
    const apply = this.ledger.db.transaction(() => {
      const existing = this.resumeTask(taskId)
      if (existing) {
        if (existing.contextRef !== turn.workspace.contextRef) throw new Error('task_conflict:context_mismatch')
        if (existing.surface !== turn.workspace.surface) throw new Error('task_conflict:surface_mismatch')
        if (existing.revision !== turn.workspace.revision) throw new Error('task_conflict:revision_mismatch')
        if (!sameActionAllowlist(existing.allowedActions, turn.workspace.capabilities.allowedActions)) {
          throw new Error('task_conflict:capability_mismatch')
        }
        if (existing.phase === 'waiting_receipt') throw new Error('receipt_required')
        this.observeUserTurn(taskId, existing.contextRef, requestDigest, existing.userTurnCount + 1)
        return this.requireTask(taskId)
      }
      const foreign = this.ledger.db.prepare(
        "SELECT 1 AS present FROM events WHERE tenant_id = ? AND run_id = ? AND kind LIKE 'booking.copilot.v2.%' LIMIT 1",
      ).get(this.ledger.tenant, taskId) as { present: number } | undefined
      if (foreign) throw new Error('task_conflict:protocol_version')
      const payload: TaskStartedPayload = {
        schema: LEDGER_SCHEMA,
        taskId,
        contextRef: turn.workspace.contextRef,
        surface: turn.workspace.surface,
        revision: turn.workspace.revision,
        allowedActions: [...turn.workspace.capabilities.allowedActions],
      }
      this.appendLedgerEvent(TASK_STARTED, taskId, payload, `booking-copilot:task:${taskId}`)
      this.observeUserTurn(taskId, turn.workspace.contextRef, requestDigest, 1)
      return this.requireTask(taskId)
    })
    return apply.immediate()
  }

  resumeTask(taskId: string): BookingCopilotTaskStateV1 | null {
    assertTaskId(taskId)
    const rows = this.readTaskRows(taskId)
    if (rows.length === 0) return null
    let state: BookingCopilotTaskStateV1 | null = null
    for (const row of rows) {
      const payload = JSON.parse(row.payload) as Record<string, unknown>
      if (payload.schema !== LEDGER_SCHEMA || payload.taskId !== taskId) throw new Error(`ledger_corrupt:${taskId}:seq=${row.seq}`)
      if (row.kind === TASK_STARTED) {
        const started = payload as unknown as TaskStartedPayload
        if (state) throw new Error(`ledger_corrupt:${taskId}:duplicate_start`)
        state = {
          schemaVersion: 'booking.surface.v1',
          taskId,
          contextRef: started.contextRef,
          surface: started.surface,
          revision: started.revision,
          allowedActions: [...started.allowedActions],
          userTurnCount: 0,
          phase: 'planning',
          lastSequence: 0,
        }
        continue
      }
      if (!state) throw new Error(`ledger_corrupt:${taskId}:event_before_start`)
      if (payload.contextRef !== state.contextRef) throw new Error(`ledger_corrupt:${taskId}:context_drift`)
      if (row.kind === USER_TURN_OBSERVED) {
        const observed = payload as unknown as UserTurnObservedPayload
        state.userTurnCount += 1
        state.lastUserTurnDigest = observed.requestDigest
      } else if (row.kind === ACTION_ISSUED) {
        const issued = payload as unknown as ActionIssuedPayload
        if (issued.action.actionDigest !== checkpointDigest(issued.action)) throw new Error(`ledger_corrupt:${taskId}:action`)
        if (state.pendingAction) throw new Error(`ledger_corrupt:${taskId}:parallel_actions`)
        state.pendingAction = issued.action
        state.phase = 'waiting_receipt'
        state.lastSequence = Math.max(state.lastSequence, issued.action.sequence)
      } else if (row.kind === RECEIPT_OBSERVED) {
        const observed = payload as unknown as ReceiptObservedPayload
        if (observed.receiptDigest !== digest(observed.receipt) || !validateActionReceiptV1(observed.receipt).ok) {
          throw new Error(`ledger_corrupt:${taskId}:receipt`)
        }
        if (!state.pendingAction || state.pendingAction.actionId !== observed.receipt.actionId) {
          throw new Error(`ledger_corrupt:${taskId}:orphan_receipt`)
        }
        state.lastReceipt = observed.receipt
        state.revision = observed.receipt.revision
        delete state.pendingAction
        state.phase = 'planning'
      } else if (row.kind === EVENT_EMITTED) {
        const emitted = payload as unknown as EventEmittedPayload
        state.lastSequence = Math.max(state.lastSequence, emitted.sequence)
      }
    }
    return state
  }

  issueOperation(taskId: string, action: BookingReadActionV1): BookingOperationEventV1 {
    const validation = validateBookingReadActionV1(action)
    if (!validation.ok) throw new Error(`invalid_action:${validation.errors.join('; ')}`)
    assertSafeFactRefs(action)
    const apply = this.ledger.db.transaction(() => {
      const state = this.requireTask(taskId)
      const reasonDigest = digest(action.reason)
      const inputDigest = digest(action.input)
      if (state.pendingAction) {
        if (state.pendingAction.actionId !== action.actionId) throw new Error('receipt_required')
        if (!actionMatchesCheckpoint(action, state.pendingAction)) throw new Error('action_conflict')
        return {
          schemaVersion: 'booking.surface.v1' as const, eventId: state.pendingAction.eventId, taskId,
          contextRef: state.pendingAction.contextRef, sequence: state.pendingAction.sequence,
          emittedAt: state.pendingAction.emittedAt, kind: 'operation' as const, action,
        }
      }
      const historicalReceipt = this.ledger.db.prepare(
        `SELECT payload FROM events WHERE tenant_id = ? AND run_id = ? AND kind = ?`,
      ).all(this.ledger.tenant, taskId, RECEIPT_OBSERVED) as Array<{ payload: string }>
      if (historicalReceipt.some((row) => (JSON.parse(row.payload) as ReceiptObservedPayload).receipt?.actionId === action.actionId)) throw new Error('action_already_receipted')
      if (state.lastReceipt?.actionId === action.actionId) throw new Error('action_already_receipted')
      if (action.contextRef !== state.contextRef) throw new Error('context_mismatch')
      if (!new Set<string>(state.allowedActions).has(action.kind)) throw new Error('unsupported_action')
      if (action.expectedRevision !== state.revision) throw new Error('stale_revision')
      const event: BookingOperationEventV1 = {
        schemaVersion: 'booking.surface.v1', eventId: this.idFactory('event'), taskId,
        contextRef: state.contextRef, sequence: state.lastSequence + 1, emittedAt: this.now(), kind: 'operation', action,
      }
      const eventValidation = validateBookingSurfaceEventV1(event)
      if (!eventValidation.ok) throw new Error(`invalid_operation_event:${eventValidation.errors.join('; ')}`)
      const checkpointBase = { actionId: action.actionId, kind: action.kind, contextRef: action.contextRef, expectedRevision: action.expectedRevision, factRefs: [...action.factRefs], reasonDigest, inputDigest, eventId: event.eventId, sequence: event.sequence, emittedAt: event.emittedAt }
      const checkpoint: BookingActionCheckpointV1 = { ...checkpointBase, actionDigest: checkpointDigest(checkpointBase) }
      const payload: ActionIssuedPayload = { schema: LEDGER_SCHEMA, taskId, contextRef: state.contextRef, action: checkpoint }
      this.appendActionIssued(taskId, payload, `booking-copilot:action:${taskId.length}:${taskId}:${action.actionId.length}:${action.actionId}`)
      return event
    })
    return apply.immediate()
  }

  continueWithReceipt(turn: ActionReceiptContinuationV1): BookingCopilotTaskStateV1 {
    const validation = validateBookingCopilotTurnV1(turn)
    if (!validation.ok || turn.kind !== 'action.receipt.continuation') {
      throw new Error(`invalid_receipt_continuation:${validationMessage(validation)}`)
    }
    const receiptDigest = digest(turn.receipt)
    const apply = this.ledger.db.transaction(() => {
      const state = this.requireTask(turn.taskId)
      if (turn.workspace.contextRef !== state.contextRef || turn.receipt.contextRef !== state.contextRef) throw new Error('context_mismatch')
      // Receipt replay is keyed by task + action, not merely by the latest fold state.
      const history = this.ledger.db.prepare(
        `SELECT payload FROM events WHERE tenant_id = ? AND run_id = ? AND kind = ? ORDER BY seq`,
      ).all(this.ledger.tenant, turn.taskId, RECEIPT_OBSERVED) as Array<{ payload: string }>
      for (const row of history) {
        const prior = JSON.parse(row.payload) as ReceiptObservedPayload
        if (prior.receipt?.actionId !== turn.receipt.actionId) continue
        if (prior.schema !== LEDGER_SCHEMA || prior.taskId !== turn.taskId || prior.contextRef !== state.contextRef || prior.receiptDigest !== digest(prior.receipt) || !validateActionReceiptV1(prior.receipt).ok) throw new Error('ledger_corrupt:receipt')
        if (prior.receiptDigest !== receiptDigest) throw new Error('receipt_conflict')
        return state
      }
      if (!state.pendingAction) throw new Error('unexpected_receipt')
      if (state.pendingAction.actionId !== turn.receipt.actionId) throw new Error('receipt_action_mismatch')
      if (turn.receipt.revision < state.pendingAction.expectedRevision) throw new Error('revision_regression')
      const payload: ReceiptObservedPayload = { schema: LEDGER_SCHEMA, taskId: turn.taskId, contextRef: state.contextRef, receipt: turn.receipt, receiptDigest }
      const idemKey = `booking-copilot:receipt:${turn.taskId.length}:${turn.taskId}:${turn.receipt.actionId.length}:${turn.receipt.actionId}`
      const info = this.ledger.db.prepare(
        `INSERT INTO events (tenant_id, ts, actor, kind, subject_id, payload, idem_key, run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(this.ledger.tenant, this.now(), LEDGER_ACTOR, RECEIPT_OBSERVED, turn.taskId, JSON.stringify(payload), idemKey, turn.taskId)
      if (info.changes !== 1) throw new Error('ledger_write_failed:receipt')
      return this.requireTask(turn.taskId)
    })
    return apply.immediate()
  }

  emitEvent(taskId: string, draft: BookingSurfaceEventDraftV1): Exclude<BookingSurfaceEventV1, BookingOperationEventV1> {
    // Sequence allocation is part of the same immediate transaction as the
    // durable append. This makes the fold read and next-sequence write one
    // critical section across independent runtime processes.
    const apply = this.ledger.db.transaction(() => {
      const state = this.requireTask(taskId)
      const safeDraft = draft.kind === 'error'
        ? { ...draft, error: { ...draft.error, code: normalizeBookingErrorCode(draft.error.code), message: safeBookingErrorMessage(normalizeBookingErrorCode(draft.error.code)) } }
        : draft
      const event = {
        schemaVersion: 'booking.surface.v1',
        eventId: this.idFactory('event'),
        taskId,
        contextRef: state.contextRef,
        sequence: state.lastSequence + 1,
        emittedAt: this.now(),
        ...safeDraft,
      } as Exclude<BookingSurfaceEventV1, BookingOperationEventV1>
      const validation = validateBookingSurfaceEventV1(event)
      if (!validation.ok) throw new Error(`invalid_event:${validation.errors.join('; ')}`)
      const payload: EventEmittedPayload = {
        schema: LEDGER_SCHEMA,
        taskId,
        contextRef: state.contextRef,
        eventId: event.eventId,
        sequence: event.sequence,
        emittedAt: event.emittedAt,
        eventKind: event.kind,
        contentDigest: digest(safeDraft),
      }
      this.appendLedgerEvent(EVENT_EMITTED, taskId, payload, `booking-copilot:event:${taskId}:${event.eventId}`)
      return event
    })
    return apply.immediate()
  }

  private requireTask(taskId: string): BookingCopilotTaskStateV1 {
    const state = this.resumeTask(taskId)
    if (!state) throw new Error('task_not_found')
    return state
  }

  private readTaskRows(taskId: string): BookingLedgerRow[] {
    return this.ledger.db.prepare(
      `SELECT seq, kind, payload FROM events
       WHERE tenant_id = ? AND run_id = ?
         AND kind IN (?, ?, ?, ?, ?)
       ORDER BY seq`,
    ).all(
      this.ledger.tenant,
      taskId,
      TASK_STARTED,
      USER_TURN_OBSERVED,
      ACTION_ISSUED,
      RECEIPT_OBSERVED,
      EVENT_EMITTED,
    ) as BookingLedgerRow[]
  }

  private observeUserTurn(taskId: string, contextRef: string, requestDigest: string, ordinal: number): void {
    const payload: UserTurnObservedPayload = {
      schema: LEDGER_SCHEMA,
      taskId,
      contextRef,
      requestDigest,
    }
    this.appendLedgerEvent(
      USER_TURN_OBSERVED,
      taskId,
      payload,
      `booking-copilot:user-turn:${taskId}:${ordinal}`,
    )
  }

  private appendLedgerEvent(kind: string, taskId: string, payload: LedgerPayloadBase, idemKey: string): number {
    const result = this.ledger.db.prepare(
      `INSERT OR IGNORE INTO events
       (tenant_id, ts, actor, kind, subject_id, payload, idem_key, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      this.ledger.tenant,
      this.now(),
      LEDGER_ACTOR,
      kind,
      taskId,
      JSON.stringify(payload),
      idemKey,
      taskId,
    )
    if (result.changes > 0) return Number(result.lastInsertRowid)
    const existing = this.ledger.db.prepare(
      'SELECT seq FROM events WHERE tenant_id = ? AND idem_key = ?',
    ).get(this.ledger.tenant, idemKey) as { seq: number } | undefined
    if (!existing) throw new Error(`ledger_write_failed:${kind}`)
    return existing.seq
  }

  private appendActionIssued(taskId: string, payload: ActionIssuedPayload, idemKey: string): number {
    const result = this.ledger.db.prepare(
      `INSERT INTO events (tenant_id, ts, actor, kind, subject_id, payload, idem_key, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(this.ledger.tenant, this.now(), LEDGER_ACTOR, ACTION_ISSUED, taskId, JSON.stringify(payload), idemKey, taskId)
    if (result.changes !== 1) throw new Error('ledger_write_failed:action')
    return Number(result.lastInsertRowid)
  }
}
