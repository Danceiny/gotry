/** Durable, task-scoped runtime for the embedded Booking Copilot. */

import { createHash, randomUUID } from 'node:crypto'
import type { StateLedger } from '../state-ledger.ts'
import {
  BOOKING_READ_ACTION_KINDS,
  BOOKING_COPILOT_MAX_OPERATIONS,
  type ActionReceipt,
  type BookingCopilotTurn,
  type BookingReadAction,
  type BookingReadActionKind,
  type BookingSurfaceEvent,
  type BookingSurface,
  type BookingWorkspaceSnapshot,
  type BookingWorkspaceIngressSnapshot,
  type BookingRequestKey,
  type BookingInternalDecisionKey,
  type BookingIngressPrincipal,
  type CriterionBlocker,
  type IngressTurn,
  type RelaxationApprovalRef,
  type RelaxationApproval,
  type UserTurn,
} from './contracts.ts'
import {
  validateApprovalAgainstBlocker,
  validateCriterionBlocker,
  validateBookingReadAction,
  validateBookingSurfaceEvent,
  validateBookingSurface,
  isBookingDateTime,
  isSafeBookingRequestKey,
} from './validation.ts'
import {
  assertWorkspaceLoadedOfferRefsUnique,
  canIssueOfferCheck,
  createAvailabilityPolicy,
  reduceAvailabilityAction,
  reduceAvailabilityReceipt,
  validateOffersReceiptWorkspace,
  availabilityPolicyResult,
  validateAvailabilityPolicy,
  type AvailabilityExhaustion,
  type AvailabilityPolicyState,
} from './availability-policy.ts'
import { normalizeBookingErrorCode, safeBookingErrorMessage } from './error-codes.ts'

const LEDGER_SCHEMA = 'booking.copilot.ledger' as const
const ACTOR = 'system:booking-copilot'
const STARTED = 'booking.copilot.task.started'
const TURN = 'booking.copilot.user.turn.observed'
const ACTION = 'booking.copilot.action.issued'
const RECEIPT = 'booking.copilot.receipt.observed'
const EVENT = 'booking.copilot.event.emitted'
const APPROVAL_GRANTED = 'booking.copilot.approval.granted'
const APPROVAL_OFFERED = 'booking.copilot.approval.option.offered'
const APPROVAL_CONSUMED = 'booking.copilot.approval.consumed'
const DECISION_BATCH = 'booking.copilot.decision.batch'
const REQUEST_BINDING = 'booking.copilot.request.binding'

export type BookingCopilotTaskPhase = 'planning' | 'submitted' | 'working' | 'waiting_receipt' | 'input_required' | 'terminal' | 'error'

export interface BookingApprovalState {
  approval?: RelaxationApproval
  blocker: CriterionBlocker
  options: RelaxationApproval[]
  optionsEmitted: boolean
  nonce: string
  expiresAt: string
  sourceTurnId: string
  presentationRequestKey: string
}

export interface BookingActionCheckpoint {
  actionId: string
  kind: BookingReadActionKind
  contextRef: string
  expectedRevision: number
  factRefs: string[]
  input: Record<string, any>
  reasonDigest: string
  inputDigest: string
  actionDigest: string
  eventId: string
  sequence: number
  emittedAt: string
  sourceTurnId: string
  relaxationApprovalRef?: RelaxationApprovalRef
}

export interface BookingCopilotTaskState {
  schemaVersion: 'booking.surface'
  taskId: string
  contextRef: string
  surface: BookingSurface
  revision: number
  allowedActions: BookingReadActionKind[]
  userTurnCount: number
  /** Durable task-level operation ordinal, folded from action ledger rows. */
  operationCount: number
  lastTurnId?: string
  phase: BookingCopilotTaskPhase
  lastSequence: number
  pendingAction?: BookingActionCheckpoint
  lastReceipt?: ActionReceipt
  awaitingApproval?: BookingApprovalState
  workspaceDigest?: string
  workspaceSemanticDigest?: string
  workspaceSnapshot?: BookingWorkspaceSnapshot
  availability: AvailabilityPolicyState
  replayUpgradeRequired?: boolean
  legacySuppressedDecisionRequestKeys?: string[]
  legacySuppressedRequestBindingKeys?: string[]
  legacySuppressedReceiptActionIds?: string[]
  legacySuppressedApprovalTargetActionIds?: string[]
}

export type BookingSurfaceEventDraft =
  | Pick<Extract<BookingSurfaceEvent, { kind: 'status' }>, 'kind' | 'status'>
  | Pick<Extract<BookingSurfaceEvent, { kind: 'question' }>, 'kind' | 'question'>
  | Pick<Extract<BookingSurfaceEvent, { kind: 'explanation' }>, 'kind' | 'explanation'>
  | Pick<Extract<BookingSurfaceEvent, { kind: 'terminal' }>, 'kind' | 'terminal'>
  | Pick<Extract<BookingSurfaceEvent, { kind: 'error' }>, 'kind' | 'error'>

export type BookingPlannerDecision =
  | { kind: 'operation'; action: BookingReadAction }
  | BookingSurfaceEventDraft

export interface BookingPlannerSession {
  next(input: { turn: BookingCopilotTurn; task: BookingCopilotTaskState }): Promise<readonly BookingPlannerDecision[]>
}

export type BookingPlannerSessionFactory = (initialTask: BookingCopilotTaskState) => BookingPlannerSession

export interface BookingCopilotRuntimeOptions {
  idFactory?: (prefix: string) => string
  contextRefFactory?: () => string
  now?: () => string
  approvalTtlMs?: number
}

interface Row { seq: number; kind: string; payload: string }
interface BasePayload { schema: typeof LEDGER_SCHEMA; taskId: string; contextRef: string; [key: string]: unknown }
interface StartedPayload extends BasePayload { surface: BookingSurface; revision: number; allowedActions: BookingReadActionKind[]; workspaceDigest: string; workspaceSemanticDigest: string; workspace: BookingWorkspaceSnapshot; availability: AvailabilityPolicyState; availabilityDigest: string }
interface TurnPayload extends BasePayload { requestDigest: string; workspaceDigest: string; workspaceSemanticDigest: string; workspace: BookingWorkspaceSnapshot; turnId: string }
interface ActionPayload extends BasePayload { action: BookingActionCheckpoint; operationCount?: number; availability: AvailabilityPolicyState; availabilityDigest: string }
interface ReceiptPayload extends BasePayload { receipt: ActionReceipt; receiptDigest: string; operationCount?: number; workspaceDigest: string; workspaceSemanticDigest: string; workspace: BookingWorkspaceSnapshot; availability: AvailabilityPolicyState; availabilityDigest: string; availabilityTerminal?: AvailabilityExhaustion }
interface EventPayload extends BasePayload { eventId: string; sequence: number; emittedAt: string; eventKind: Exclude<BookingSurfaceEvent['kind'], 'operation'>; status?: 'submitted'|'working'|'waiting_receipt'|'input_required'; contentDigest: string }
interface ApprovalPayload extends BasePayload { approval: BookingApprovalState; ref?: RelaxationApprovalRef; approvalDigest: string }
interface DecisionBatchPayload extends BasePayload { requestKey: string; events: BookingSurfaceEvent[] }
interface RequestBindingPayload extends BasePayload { requestKey: BookingRequestKey; requestDigest: string; turnId: string; workspaceDigest: string; workspaceSemanticDigest: string; surface: BookingSurface; capabilityDigest: string; principalDigest: string; scopeDigest: string; taskHandle?: string }
export interface BookingIngressRequestBindingInput { requestKey: BookingRequestKey; principal: BookingIngressPrincipal; taskHandle?: string }
interface ReplayConsumedIdentities { events: Map<string, EventPayload>; actions: Map<string, BookingActionCheckpoint>; pendingBatchKeys: Set<string>; pendingBatchOpen: boolean }

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) out[key] = stable((value as Record<string, unknown>)[key])
  return out
}

export function bookingDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
}

export function bookingWorkspaceDigest(workspace: BookingWorkspaceSnapshot | BookingWorkspaceIngressSnapshot): string {
  const { contextRef: _contextRef, ...contextBoundWorkspace } = workspace as Record<string, unknown>
  return bookingDigest(contextBoundWorkspace)
}

function bookingWorkspaceSemanticDigest(workspace: BookingWorkspaceSnapshot | BookingWorkspaceIngressSnapshot): string {
  const { contextRef: _contextRef, revision: _revision, ...semanticWorkspace } = workspace as Record<string, unknown>
  return bookingDigest(semanticWorkspace)
}

export function bookingTurnDigest(turn: Extract<BookingCopilotTurn, { kind: 'user.turn' | 'user.turn.ingress' }>): string {
  return bookingDigest(turn)
}

function canonicalReceiptDigest(value: ActionReceipt): string { return bookingDigest(value) }
function replayDigestMatches(recordedDigest: unknown, raw: unknown, normalized: unknown): boolean {
  return typeof recordedDigest === 'string' && (recordedDigest === bookingDigest(raw) || recordedDigest === bookingDigest(normalized))
}

function replayWorkspaceDigestMatches(recordedDigest: unknown, raw: BookingWorkspaceSnapshot, normalized: BookingWorkspaceSnapshot): boolean {
  return typeof recordedDigest === 'string' && (recordedDigest === bookingWorkspaceDigest(raw) || recordedDigest === bookingWorkspaceDigest(normalized))
}

function replayWorkspaceSemanticDigestMatches(recordedDigest: unknown, raw: BookingWorkspaceSnapshot, normalized: BookingWorkspaceSnapshot): boolean {
  return typeof recordedDigest === 'string' && (recordedDigest === bookingWorkspaceSemanticDigest(raw) || recordedDigest === bookingWorkspaceSemanticDigest(normalized))
}

function rememberReplayWorkspaceDigest(digests: Map<string, string>, recordedDigest: unknown, raw: BookingWorkspaceSnapshot, normalized: BookingWorkspaceSnapshot): void {
  const normalizedDigest = bookingWorkspaceDigest(normalized)
  digests.set(bookingWorkspaceDigest(raw), normalizedDigest)
  if (typeof recordedDigest === 'string') digests.set(recordedDigest, normalizedDigest)
}

function legacyOfferVersionRef(contextRef: string, offer: Record<string, unknown>): string {
  return `legacy-offer-version:${bookingDigest({
    contextRef,
    offerRef: offer.offerRef,
    hotelRef: offer.hotelRef,
    evidenceLevel: offer.evidenceLevel,
    factRefs: Array.isArray(offer.factRefs) ? offer.factRefs : [],
  }).slice(0, 40)}`
}

function normalizeWorkspaceForReplay(raw: BookingWorkspaceSnapshot): BookingWorkspaceSnapshot {
  const candidate = raw as unknown as Record<string, unknown>
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(candidate.loadedOffers) || typeof candidate.contextRef !== 'string') throw new Error('booking_malformed_workspace')
  const workspace = structuredClone(raw) as BookingWorkspaceSnapshot & { verifiedOfferRef?: string }
  workspace.loadedOffers = workspace.loadedOffers.map((offer) => offer.offerVersionRef ? offer : { ...offer, offerVersionRef: legacyOfferVersionRef(workspace.contextRef, offer as unknown as Record<string, unknown>) })
  delete workspace.verifiedOfferRef
  return workspace
}

function resolveReplayOfferVersion(offerRef: string, workspace?: BookingWorkspaceSnapshot, action?: BookingActionCheckpoint, actionId?: string, priorAvailability?: AvailabilityPolicyState): string {
  const priorAttempt = actionId ? priorAvailability?.attempts.find((attempt) => attempt.actionId === actionId) : undefined
  if (priorAttempt?.offerVersionRef) return priorAttempt.offerVersionRef
  if (action?.kind === 'offer.check' && action.actionId === actionId && action.input.offerRef === offerRef && typeof action.input.offerVersionRef === 'string') return action.input.offerVersionRef
  const match = workspace?.loadedOffers.find((offer) => offer.offerRef === offerRef)
  if (match?.offerVersionRef) return match.offerVersionRef
  throw new Error('booking_replan_required:offer_version_unbound')
}

function normalizeAvailabilityPolicyForReplay(raw: AvailabilityPolicyState, workspace?: BookingWorkspaceSnapshot, action?: BookingActionCheckpoint, priorAvailability?: AvailabilityPolicyState, workspaceDigestMap = new Map<string, string>(), receipt?: ActionReceipt): AvailabilityPolicyState {
  const normalized = structuredClone(raw) as AvailabilityPolicyState
  if (normalized.hotels && typeof normalized.hotels === 'object') {
    for (const [hotelRef, hotel] of Object.entries(normalized.hotels) as Array<[string, AvailabilityPolicyState['hotels'][string]]>) {
      const rawHotel = (raw.hotels as Record<string, unknown> | undefined)?.[hotelRef] as Record<string, unknown> | undefined
      const priorHotel = priorAvailability?.hotels[hotelRef]
      if (!Array.isArray(hotel.tombstonedOfferRefs)) hotel.tombstonedOfferRefs = priorHotel ? [...priorHotel.tombstonedOfferRefs] : []
      if (!Array.isArray(hotel.tombstonedOfferVersionRefs)) hotel.tombstonedOfferVersionRefs = priorHotel ? [...priorHotel.tombstonedOfferVersionRefs] : []
      if (rawHotel && Array.isArray(rawHotel.tombstonedOfferRefs) && priorHotel) {
        for (const ref of priorHotel.tombstonedOfferRefs) if (!hotel.tombstonedOfferRefs.includes(ref)) throw new Error('booking_replan_required:tombstone_regression')
      }
      if (rawHotel && Array.isArray(rawHotel.tombstonedOfferVersionRefs) && priorHotel) {
        for (const ref of priorHotel.tombstonedOfferVersionRefs) if (!hotel.tombstonedOfferVersionRefs.includes(ref)) throw new Error('booking_replan_required:tombstone_regression')
      }
      const source = hotel.currentGeneration?.source
      if (source?.kind === 'workspace_snapshot') {
        const mappedDigest = workspaceDigestMap.get(source.workspaceDigest)
        if (mappedDigest) source.workspaceDigest = mappedDigest
      }
    }
  }
  if (Array.isArray(normalized.attempts)) {
    normalized.attempts = normalized.attempts.map((attempt) => attempt.offerVersionRef ? attempt : { ...attempt, offerVersionRef: resolveReplayOfferVersion(attempt.offerRef, workspace, action, attempt.actionId, priorAvailability) })
  }
  const availability = receipt?.observation.kind === 'offer.availability' ? receipt.observation : undefined
  if (receipt && action?.kind === 'offer.check' && availability && availability.offerRef === action.input.offerRef && availability.checkedOfferVersionRef === action.input.offerVersionRef) {
    const attempt = normalized.attempts.find((candidate) => candidate.actionId === action.actionId)
    const hotel = attempt ? normalized.hotels[attempt.hotelRef] : undefined
    if (hotel) {
      if (receipt.status === 'changed' && availability.available === true && availability.currentOfferVersionRef && availability.currentOfferVersionRef !== action.input.offerVersionRef) {
        if (!hotel.tombstonedOfferVersionRefs.includes(action.input.offerVersionRef)) hotel.tombstonedOfferVersionRefs.push(action.input.offerVersionRef)
      }
      const completeNegative = (receipt.status === 'unavailable' || receipt.status === 'no_match')
        && receipt.resultContract.outcome === 'empty'
        && receipt.resultContract.gapCodes.length === 0
        && receipt.resultContract.blockers.length === 0
        && availability.available === false
        && !availability.currentOfferVersionRef
        && !availability.verifiedOfferRef
        && !availability.gapCodes?.length
      if (completeNegative) {
        if (!hotel.tombstonedOfferVersionRefs.includes(action.input.offerVersionRef)) hotel.tombstonedOfferVersionRefs.push(action.input.offerVersionRef)
        if (!hotel.tombstonedOfferRefs.includes(action.input.offerRef)) hotel.tombstonedOfferRefs.push(action.input.offerRef)
      }
    }
  }
  return normalized
}

function normalizeActionCheckpointForReplay(raw: BookingActionCheckpoint, workspace?: BookingWorkspaceSnapshot): BookingActionCheckpoint {
  if (!['offer.select', 'offer.check', 'checkout.prepare'].includes(raw.kind) || typeof raw.input.offerVersionRef === 'string') return raw
  if (typeof raw.input.offerRef !== 'string') throw new Error('booking_replan_required:offer_version_unbound')
  const offerVersionRef = resolveReplayOfferVersion(raw.input.offerRef, workspace, undefined, raw.actionId)
  const input: Record<string, any> = { ...raw.input, offerVersionRef }
  if (raw.kind === 'checkout.prepare' && (!workspace?.verifiedOffer || workspace.verifiedOffer.offerRef !== input.offerRef || workspace.verifiedOffer.offerVersionRef !== offerVersionRef || workspace.verifiedOffer.verifiedOfferRef !== input.verifiedOfferRef)) throw new Error('booking_replan_required:legacy_checkout_unverified')
  const { actionDigest: _rawActionDigest, ...rawBase } = raw
  const normalizedBase: Omit<BookingActionCheckpoint, 'actionDigest'> = { ...rawBase, input, inputDigest: bookingDigest(input) }
  return { ...normalizedBase, actionDigest: checkpointDigest(normalizedBase) }
}

function checkpointDigestMatchesForReplay(raw: BookingActionCheckpoint, normalized: BookingActionCheckpoint): boolean {
  const { actionDigest: _rawDigest, ...rawBase } = raw
  const { actionDigest: _normalizedDigest, ...normalizedBase } = normalized
  return raw.actionDigest === checkpointDigest(rawBase) || raw.actionDigest === checkpointDigest(normalizedBase)
}

function replanAfterReplayUpgradeGap(state: BookingCopilotTaskState, workspace = state.workspaceSnapshot, revision = workspace?.revision): BookingCopilotTaskState {
  if (!workspace) return { ...state, phase: 'error', pendingAction: undefined }
  const safeRevision = typeof revision === 'number' && Number.isSafeInteger(revision) ? revision : state.revision
  return {
    ...state,
    revision: safeRevision,
    phase: 'planning',
    pendingAction: undefined,
    awaitingApproval: undefined,
    workspaceDigest: bookingWorkspaceDigest(workspace),
    workspaceSemanticDigest: bookingWorkspaceSemanticDigest(workspace),
    workspaceSnapshot: workspace,
    availability: createAvailabilityPolicy(workspace),
    replayUpgradeRequired: true,
  }
}

function assertReplayUpgradeReanchored(state: Pick<BookingCopilotTaskState, 'replayUpgradeRequired'>): void {
  if (state.replayUpgradeRequired) throw new Error('reanchor_turn_required')
}

function consumedIdentityKey(eventId: string, sequence: number): string { return `${eventId}\0${sequence}` }

function clearPendingBatch(consumed: ReplayConsumedIdentities): void {
  consumed.pendingBatchKeys.clear()
  consumed.pendingBatchOpen = false
}

function rememberPendingBatchKey(consumed: ReplayConsumedIdentities, key: string): void {
  consumed.pendingBatchKeys.add(key)
}

function rememberConsumedEventIdentity(consumed: ReplayConsumedIdentities, payload: EventPayload): void {
  if (payload.eventKind === 'status' && (payload.status === 'submitted' || payload.status === 'working') && !consumed.pendingBatchOpen) {
    clearPendingBatch(consumed)
    consumed.pendingBatchOpen = true
  }
  const key = consumedIdentityKey(payload.eventId, payload.sequence)
  consumed.events.set(key, payload)
  rememberPendingBatchKey(consumed, key)
}

function rememberConsumedActionIdentity(consumed: ReplayConsumedIdentities, action: BookingActionCheckpoint): void {
  const key = consumedIdentityKey(action.eventId, action.sequence)
  consumed.actions.set(key, action)
  rememberPendingBatchKey(consumed, key)
}

function consumeSkippedActionOrdinal(state: BookingCopilotTaskState, payload: ActionPayload, consumed?: ReplayConsumedIdentities): void {
  const action = payload.action
  const operationCount = payload.operationCount ?? state.operationCount + 1
  if (!action || typeof action !== 'object') throw new Error('skip_action_invalid')
  const { actionDigest: _actionDigest, ...actionBase } = action
  if (action.actionDigest !== checkpointDigest(actionBase) || !Number.isSafeInteger(operationCount) || operationCount !== state.operationCount + 1 || operationCount > BOOKING_COPILOT_MAX_OPERATIONS || !Number.isSafeInteger(action.sequence) || action.sequence <= state.lastSequence) throw new Error('skip_action_invalid')
  state.operationCount = operationCount
  state.lastSequence = action.sequence
  if (consumed) {
    rememberConsumedActionIdentity(consumed, action)
  }
}

function eventDraftDigest(event: Exclude<BookingSurfaceEvent, { kind: 'operation' }>): string {
  if (event.kind === 'status') return bookingDigest({ kind: event.kind, status: event.status })
  if (event.kind === 'question') return bookingDigest({ kind: event.kind, question: event.question })
  if (event.kind === 'explanation') return bookingDigest({ kind: event.kind, explanation: event.explanation })
  if (event.kind === 'terminal') return bookingDigest({ kind: event.kind, terminal: event.terminal })
  return bookingDigest({ kind: event.kind, error: event.error })
}

function eventPayloadMatchesEvent(payload: EventPayload, event: Exclude<BookingSurfaceEvent, { kind: 'operation' }>): boolean {
  const expectedDigest = eventDraftDigest(event)
  const legacyTerminalDigest = event.kind === 'terminal' ? bookingDigest(event.terminal) : undefined
  return payload.eventId === event.eventId
    && payload.sequence === event.sequence
    && payload.emittedAt === event.emittedAt
    && payload.contextRef === event.contextRef
    && payload.eventKind === event.kind
    && (event.kind !== 'status' || payload.status === event.status)
    && (payload.contentDigest === expectedDigest || payload.contentDigest === legacyTerminalDigest)
}

function actionFromOperationEventForReplay(event: Extract<BookingSurfaceEvent, { kind: 'operation' }>, checkpoint: BookingActionCheckpoint): BookingReadAction {
  const action = event.action
  if ((action.kind === 'offer.select' || action.kind === 'offer.check' || action.kind === 'checkout.prepare') && typeof action.input.offerRef === 'string' && typeof action.input.offerVersionRef !== 'string' && typeof checkpoint.input.offerVersionRef === 'string') {
    return { ...action, input: { ...action.input, offerVersionRef: checkpoint.input.offerVersionRef } } as BookingReadAction
  }
  return action
}

function operationEventMatchesAction(event: Extract<BookingSurfaceEvent, { kind: 'operation' }>, checkpoint: BookingActionCheckpoint): boolean {
  return event.eventId === checkpoint.eventId
    && event.sequence === checkpoint.sequence
    && event.emittedAt === checkpoint.emittedAt
    && event.contextRef === checkpoint.contextRef
    && matchesCheckpoint(actionFromOperationEventForReplay(event, checkpoint), checkpoint)
}

function normalizeDecisionBatchEnvelopeForReplay(payload: DecisionBatchPayload, consumed: ReplayConsumedIdentities, requireSchemaValid = false): BookingSurfaceEvent[] {
  if (typeof payload.requestKey !== 'string' || !payload.requestKey || !payload.events.length) throw new Error('skip_decision_batch_invalid')
  let lastBatchSequence = -1
  const seen = new Set<string>()
  const normalizedEvents: BookingSurfaceEvent[] = []
  for (const event of payload.events) {
    if (!Number.isSafeInteger(event.sequence) || event.sequence <= lastBatchSequence) throw new Error('skip_decision_batch_invalid')
    lastBatchSequence = event.sequence
    const key = consumedIdentityKey(event.eventId, event.sequence)
    if (seen.has(key)) throw new Error('skip_decision_batch_invalid')
    seen.add(key)
    if (event.kind === 'operation') {
      const checkpoint = consumed.actions.get(key)
      if (!checkpoint || !operationEventMatchesAction(event, checkpoint)) throw new Error('skip_decision_batch_invalid')
      const normalized = { ...event, action: actionFromOperationEventForReplay(event, checkpoint) } as BookingSurfaceEvent
      if (requireSchemaValid && !validateBookingSurfaceEvent(normalized).ok) throw new Error('skip_decision_batch_invalid')
      normalizedEvents.push(normalized)
    } else {
      const recorded = consumed.events.get(key)
      if (!recorded || !validateBookingSurfaceEvent(event).ok || !eventPayloadMatchesEvent(recorded, event)) throw new Error('skip_decision_batch_invalid')
      normalizedEvents.push(event)
    }
    if (!consumed.pendingBatchKeys.has(key)) throw new Error('skip_decision_batch_invalid')
  }
  if (seen.size !== consumed.pendingBatchKeys.size) throw new Error('skip_decision_batch_invalid')
  for (const key of consumed.pendingBatchKeys) if (!seen.has(key)) throw new Error('skip_decision_batch_invalid')
  clearPendingBatch(consumed)
  return normalizedEvents
}

function consumeSkippedEventSequence(state: BookingCopilotTaskState, payload: EventPayload | DecisionBatchPayload, consumed: ReplayConsumedIdentities): void {
  if (!payload || typeof payload !== 'object') throw new Error('skip_event_invalid')
  if ('sequence' in payload) {
    const eventPayload = payload as EventPayload
    if (typeof eventPayload.eventId !== 'string' || !eventPayload.eventId || !['status', 'question', 'explanation', 'terminal', 'error'].includes(String(eventPayload.eventKind)) || typeof eventPayload.contentDigest !== 'string' || !/^[0-9a-f]{64}$/.test(eventPayload.contentDigest) || typeof eventPayload.sequence !== 'number' || !Number.isSafeInteger(eventPayload.sequence) || eventPayload.sequence <= state.lastSequence) throw new Error('skip_event_invalid')
    state.lastSequence = eventPayload.sequence
    rememberConsumedEventIdentity(consumed, eventPayload)
  } else if ('events' in payload && Array.isArray(payload.events)) {
    normalizeDecisionBatchEnvelopeForReplay(payload, consumed)
  }
}

function normalizeReceiptForReplay(raw: ActionReceipt, action: BookingActionCheckpoint, workspace: BookingWorkspaceSnapshot): ActionReceipt {
  const receipt = structuredClone(raw) as ActionReceipt
  if (action.kind === 'offer.select' && receipt.observation.kind === 'offer.selection' && receipt.observation.offerRef === action.input.offerRef && !receipt.observation.offerVersionRef) {
    receipt.observation.offerVersionRef = action.input.offerVersionRef
  }
  if (action.kind === 'checkout.prepare' && receipt.observation.kind === 'checkout.handoff' && receipt.observation.offerRef === action.input.offerRef && !receipt.observation.offerVersionRef) {
    if (!workspace.verifiedOffer || workspace.verifiedOffer.offerRef !== action.input.offerRef || workspace.verifiedOffer.offerVersionRef !== action.input.offerVersionRef || workspace.verifiedOffer.verifiedOfferRef !== action.input.verifiedOfferRef) throw new Error('booking_replan_required:legacy_checkout_unverified')
    receipt.observation.offerVersionRef = action.input.offerVersionRef
  }
  if (action.kind === 'offer.check' && receipt.observation.kind === 'offer.availability' && receipt.observation.offerRef === action.input.offerRef) {
    if (!receipt.observation.checkedOfferVersionRef) receipt.observation.checkedOfferVersionRef = action.input.offerVersionRef
    if (receipt.status === 'applied' && receipt.observation.available === true && !receipt.observation.currentOfferVersionRef) receipt.observation.currentOfferVersionRef = action.input.offerVersionRef
    if (receipt.status === 'changed' && receipt.observation.available === true && !receipt.observation.currentOfferVersionRef) {
      const current = workspace.loadedOffers.find((offer) => offer.offerRef === action.input.offerRef && offer.offerVersionRef !== action.input.offerVersionRef)
      if (!current) throw new Error('booking_replan_required:changed_version_unbound')
      receipt.observation.currentOfferVersionRef = current.offerVersionRef
    }
    if (receipt.status === 'applied' && receipt.observation.verifiedOfferRef && (!workspace.verifiedOffer || workspace.verifiedOffer.offerRef !== action.input.offerRef || workspace.verifiedOffer.offerVersionRef !== action.input.offerVersionRef || workspace.verifiedOffer.verifiedOfferRef !== receipt.observation.verifiedOfferRef)) throw new Error('booking_replan_required:legacy_verified_scalar')
  }
  if (receipt.resultContract.blockers.length && bookingDigest(raw) !== bookingDigest(receipt)) throw new Error('booking_replan_required:legacy_blocker_digest')
  return receipt
}

function errorText(result: { ok: true } | { ok: false; errors: string[] }): string { return result.ok ? '' : result.errors.join('; ') }
function assertTaskId(taskId: string): void { if (!/^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(taskId)) throw new Error('invalid_task_id') }
function assertSafeRef(value: string): void { if (!/^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(value)) throw new Error('unsafe_opaque_ref') }
function safeIdentity(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(value) }
function sameActions(a: readonly string[], b: readonly string[]): boolean { return a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]) }
function availabilityPolicyTerminal(state: AvailabilityPolicyState): AvailabilityExhaustion | undefined { return availabilityPolicyResult(state) }
function taskHasTerminalBudget(state: Pick<BookingCopilotTaskState, 'operationCount' | 'availability'>): boolean {
  return state.operationCount >= BOOKING_COPILOT_MAX_OPERATIONS || Boolean(state.availability.terminal)
}
function assertRequestKey(requestKey: string): asserts requestKey is BookingRequestKey {
  if (!isSafeBookingRequestKey(requestKey)) throw new Error('unsafe_request_key')
}
/** Decision batches are runtime-owned and may contain long task/turn/action refs. */
function assertInternalDecisionKey(requestKey: string): asserts requestKey is BookingInternalDecisionKey {
  if (typeof requestKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,2047}$/.test(requestKey)) throw new Error('unsafe_internal_decision_key')
}

function assertDecisionBatchFinality(decisions: readonly BookingPlannerDecision[]): void {
  let finalSeen = false
  for (const decision of decisions) {
    const isFinal = decision.kind === 'terminal' || decision.kind === 'error'
    if (finalSeen) throw new Error('decision_batch_finality')
    if (isFinal) finalSeen = true
  }
}
function assertPrincipal(principal: BookingIngressPrincipal): void {
  if (!principal || typeof principal.subject !== 'string' || !principal.subject || principal.subject.length > 256 || typeof principal.scope !== 'string' || !principal.scope || principal.scope.length > 256) throw new Error('trusted_principal_required')
}

function assertAvailabilityLiveness(state: BookingCopilotTaskState, decisions: readonly BookingPlannerDecision[]): void {
  if (!state.availability.recoveryStarted || state.awaitingApproval) return
  const operations = decisions.filter((decision): decision is Extract<BookingPlannerDecision, { kind: 'operation' }> => decision.kind === 'operation')
  if (operations.length !== 1 || !state.workspaceSnapshot) throw new Error('availability_operation_required')
  const action = operations[0].action
  const activeHotelRef = state.availability.hotelRefs[state.availability.activeHotelOrdinal]
  if (!activeHotelRef) throw new Error('availability_active_hotel_missing')
  if (state.availability.availabilityPhase === 'need_offers') {
    if (action.kind !== 'offers.query' || action.input.hotelRefs.length !== 1 || action.input.hotelRefs[0] !== activeHotelRef) throw new Error('availability_operation_incompatible')
  } else if (state.availability.availabilityPhase === 'need_check') {
    if (action.kind !== 'offer.check' || action.input.offerRef === undefined || action.input.offerVersionRef === undefined || !state.availability.hotels[activeHotelRef]?.currentOfferRefs.includes(action.input.offerRef) || !canIssueOfferCheck(state.availability, state.workspaceSnapshot, action.input.offerRef, action.input.offerVersionRef).ok) throw new Error('availability_operation_incompatible')
  } else {
    throw new Error('availability_operation_incompatible')
  }
}

function checkpointDigest(action: Omit<BookingActionCheckpoint, 'actionDigest'>): string {
  return bookingDigest(action)
}

function checkpointFor(action: BookingReadAction, eventId: string, sequence: number, emittedAt: string, sourceTurnId: string): BookingActionCheckpoint {
  const base: Omit<BookingActionCheckpoint, 'actionDigest'> = {
    actionId: action.actionId,
    kind: action.kind,
    contextRef: action.contextRef,
    expectedRevision: action.expectedRevision,
    factRefs: [...action.factRefs],
    reasonDigest: bookingDigest(action.reason),
    inputDigest: bookingDigest(action.input),
    input: action.input,
    eventId,
    sequence,
    emittedAt,
    sourceTurnId,
    ...(action.relaxationApprovalRef ? { relaxationApprovalRef: action.relaxationApprovalRef } : {}),
  }
  return { ...base, actionDigest: checkpointDigest(base) }
}

function matchesCheckpoint(action: BookingReadAction, checkpoint: BookingActionCheckpoint): boolean {
  const candidate = checkpointFor(
    action.relaxationApprovalRef || !checkpoint.relaxationApprovalRef ? action : { ...action, relaxationApprovalRef: checkpoint.relaxationApprovalRef },
    checkpoint.eventId,
    checkpoint.sequence,
    checkpoint.emittedAt,
    checkpoint.sourceTurnId,
  )
  const { actionDigest: _ignored, ...candidateBase } = candidate
  return checkpoint.actionDigest === checkpointDigest(candidateBase)
}

function receiptSourceDigest(receipt: ActionReceipt): string {
  return bookingDigest({
    ...receipt,
    resultContract: {
      ...receipt.resultContract,
      blockers: receipt.resultContract.blockers.map(({ sourceReceiptDigest: _ignored, ...blocker }) => blocker),
    },
  })
}

function assertCanonicalReceipt(receipt: ActionReceipt): void {
  const expected = receiptSourceDigest(receipt)
  if (receipt.resultContract.blockers.some((blocker) => blocker.sourceReceiptDigest !== expected)) throw new Error('receipt_source_digest_mismatch')
}

function receiptObservationMatchesAction(observation: ActionReceipt['observation']['kind'], action: BookingReadActionKind): boolean {
  if (observation === 'gap') return true
  const expected: Partial<Record<BookingReadActionKind, ActionReceipt['observation']['kind']>> = {
    'search.patch': 'search.state', 'search.run': 'search.state', 'results.view.patch': 'results.state',
    'hotel.focus': 'hotel.focus', 'hotel.select': 'hotel.selection', 'offers.query': 'offers.state',
    'offers.view.patch': 'offers.state', 'offers.compare': 'offers.state', 'offer.select': 'offer.selection',
    'offer.check': 'offer.availability', 'checkout.prepare': 'checkout.handoff', 'order.observe': 'order.state',
  }
  return expected[action] === observation
}

function sameRefSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().every((value, index) => value === [...b].sort()[index])
}

function receiptTargetMatchesAction(receipt: ActionReceipt, action: { kind: BookingReadActionKind; input: Record<string, any> }): boolean {
  const observation = receipt.observation
  const input = action.input
  if (action.kind === 'hotel.focus' && observation.kind === 'hotel.focus') return observation.hotelRef === input.hotelRef
  if (action.kind === 'hotel.select' && observation.kind === 'hotel.selection') return observation.hotelRef === input.hotelRef
  if (action.kind === 'offer.select' && observation.kind === 'offer.selection') return observation.offerRef === input.offerRef && observation.offerVersionRef === input.offerVersionRef
  if (action.kind === 'offer.check' && observation.kind === 'offer.availability') return observation.offerRef === input.offerRef && observation.checkedOfferVersionRef === input.offerVersionRef
  if (action.kind === 'checkout.prepare' && observation.kind === 'checkout.handoff') return observation.offerRef === input.offerRef && observation.offerVersionRef === input.offerVersionRef && observation.verifiedOfferRef === input.verifiedOfferRef
  if (action.kind === 'offers.query' && observation.kind === 'offers.state') return sameRefSet(observation.hotelRefs, input.hotelRefs)
  if (action.kind === 'offers.view.patch' && observation.kind === 'offers.state') return observation.hotelRefs.includes(input.hotelRef)
  if (action.kind === 'offers.compare' && observation.kind === 'offers.state') return input.offerRefs.every((offerRef: string) => observation.offerRefs.includes(offerRef))
  if (action.kind === 'order.observe' && observation.kind === 'order.state') return observation.orderRef === input.orderRef
  return observation.kind === 'gap' || action.kind === 'search.patch' || action.kind === 'search.run' || action.kind === 'results.view.patch'
}

function workspaceBoundaryMatches(a: BookingWorkspaceSnapshot, b: BookingWorkspaceSnapshot): boolean {
  return a.locale === b.locale && a.currency === b.currency && a.surface === b.surface && a.contextRef === b.contextRef && a.capabilities.surface === b.capabilities.surface && sameActions(a.capabilities.allowedActions, b.capabilities.allowedActions)
}

function workspaceHasOfferVersion(workspace: BookingWorkspaceSnapshot, offerRef: string, offerVersionRef: string): boolean {
  return workspace.loadedOffers.some((offer) => offer.offerRef === offerRef && offer.offerVersionRef === offerVersionRef)
}

function verifiedOfferMatches(workspace: BookingWorkspaceSnapshot, input: { offerRef: string; offerVersionRef: string; verifiedOfferRef: string }): boolean {
  return workspace.verifiedOffer?.offerRef === input.offerRef && workspace.verifiedOffer.offerVersionRef === input.offerVersionRef && workspace.verifiedOffer.verifiedOfferRef === input.verifiedOfferRef
}

function verifiedOfferUnexpired(workspace: BookingWorkspaceSnapshot, now: string): boolean {
  return Boolean(workspace.verifiedOffer && isBookingDateTime(workspace.verifiedOffer.expiresAt) && Date.parse(workspace.verifiedOffer.expiresAt) > Date.parse(now))
}

function actionHitsCurrentOfferVersion(workspace: BookingWorkspaceSnapshot, action: BookingReadAction, now?: string): boolean {
  if (action.kind === 'offer.select' || action.kind === 'offer.check') return workspaceHasOfferVersion(workspace, action.input.offerRef, action.input.offerVersionRef)
  if (action.kind === 'checkout.prepare') return workspaceHasOfferVersion(workspace, action.input.offerRef, action.input.offerVersionRef) && verifiedOfferMatches(workspace, action.input) && (now === undefined || verifiedOfferUnexpired(workspace, now))
  return true
}

function shortlistAfterCheckedOffer(previous: readonly string[], current: readonly string[], checkedOfferRef: string): boolean {
  if (sameActions(previous, current)) return true
  const removedChecked = previous.filter((ref) => ref !== checkedOfferRef)
  return removedChecked.length === previous.length - 1 && sameActions(removedChecked, current)
}

function loadedOffersUnchanged(previous: BookingWorkspaceSnapshot, current: BookingWorkspaceSnapshot): boolean {
  return sameActions(previous.loadedOffers.map((offer) => bookingDigest(offer)), current.loadedOffers.map((offer) => bookingDigest(offer)))
}

function changedFactRefsMatch(previousFactRefs: readonly string[], currentFactRefs: readonly string[], changedFactRefs: readonly string[]): boolean {
  if (!changedFactRefs.length) return false
  const before = new Set(previousFactRefs)
  const after = new Set(currentFactRefs)
  const diff = [
    ...previousFactRefs.filter((ref) => !after.has(ref)),
    ...currentFactRefs.filter((ref) => !before.has(ref)),
  ]
  return sameActions(diff, changedFactRefs)
}

function loadedOffersChangedVersionOnly(previous: BookingWorkspaceSnapshot, current: BookingWorkspaceSnapshot, offerRef: string, currentOfferVersionRef: string, changedFactRefs: readonly string[]): boolean {
  if (previous.loadedOffers.length !== current.loadedOffers.length) return false
  const previousChecked = previous.loadedOffers.find((offer) => offer.offerRef === offerRef)
  const currentChecked = current.loadedOffers.find((offer) => offer.offerRef === offerRef)
  if (!previousChecked || !currentChecked || previousChecked.hotelRef !== currentChecked.hotelRef || currentChecked.offerVersionRef !== currentOfferVersionRef || previousChecked.offerVersionRef === currentChecked.offerVersionRef) return false
  if (previousChecked.evidenceLevel !== currentChecked.evidenceLevel) return false
  if (!changedFactRefsMatch(previousChecked.factRefs, currentChecked.factRefs, changedFactRefs)) return false
  const previousOther = previous.loadedOffers.filter((offer) => offer.offerRef !== offerRef).map((offer) => bookingDigest(offer))
  const currentOther = current.loadedOffers.filter((offer) => offer.offerRef !== offerRef).map((offer) => bookingDigest(offer))
  return sameActions(previousOther, currentOther)
}

function availabilityReceiptIsComplete(receipt: ActionReceipt): boolean {
  return receipt.resultContract.outcome === 'complete'
    && receipt.resultContract.hardCriteriaMet
    && receipt.resultContract.gapCodes.length === 0
    && receipt.resultContract.blockers.length === 0
}

function offerCheckPostActionMatches(previous: BookingWorkspaceSnapshot, current: BookingWorkspaceSnapshot, action: { kind: 'offer.check'; input: { offerRef: string; offerVersionRef: string } }, receipt: ActionReceipt): boolean {
  const checkedOfferRef = action.input.offerRef
  const checkedOfferVersionRef = action.input.offerVersionRef
  const observation = receipt.observation.kind === 'offer.availability' ? receipt.observation : undefined
  const negative = receipt.status === 'unavailable' || receipt.status === 'no_match'
  if (['applied', 'changed', 'unavailable', 'no_match'].includes(receipt.status) && !observation) return false
  if (receipt.status === 'applied' && observation?.available && observation.verifiedOfferRef) {
    if (!availabilityReceiptIsComplete(receipt) || observation.gapCodes?.length) return false
    if (!loadedOffersUnchanged(previous, current)) return false
    if (observation.checkedOfferVersionRef !== checkedOfferVersionRef || observation.currentOfferVersionRef !== checkedOfferVersionRef) return false
    if (current.selectedOfferRef !== checkedOfferRef) return false
    if (!sameActions(previous.shortlistedOfferRefs, current.shortlistedOfferRefs)) return false
    if (!current.verifiedOffer || current.verifiedOffer.offerRef !== checkedOfferRef || current.verifiedOffer.offerVersionRef !== checkedOfferVersionRef || current.verifiedOffer.verifiedOfferRef !== observation.verifiedOfferRef || Number.isNaN(Date.parse(current.verifiedOffer.expiresAt))) return false
    return true
  }
  if (receipt.status === 'changed' && observation?.available && observation.currentOfferVersionRef) {
    if (observation.checkedOfferVersionRef !== checkedOfferVersionRef || observation.currentOfferVersionRef === checkedOfferVersionRef || observation.verifiedOfferRef || !observation.changedFactRefs.length) return false
    if (!loadedOffersChangedVersionOnly(previous, current, checkedOfferRef, observation.currentOfferVersionRef, observation.changedFactRefs)) return false
    if (current.selectedOfferRef !== checkedOfferRef || current.verifiedOffer !== undefined) return false
    return sameActions(previous.shortlistedOfferRefs, current.shortlistedOfferRefs)
  }
  if (!loadedOffersUnchanged(previous, current)) return false
  if (negative) {
    if (current.selectedOfferRef !== undefined || current.verifiedOffer !== undefined) return false
    if (!shortlistAfterCheckedOffer(previous.shortlistedOfferRefs, current.shortlistedOfferRefs, checkedOfferRef)) return false
    return !current.shortlistedOfferRefs.includes(checkedOfferRef)
  }
  if (!sameActions(previous.shortlistedOfferRefs, current.shortlistedOfferRefs)) return false
  if (previous.selectedOfferRef !== current.selectedOfferRef) return false
  if (bookingDigest(previous.verifiedOffer ?? null) !== bookingDigest(current.verifiedOffer ?? null)) return false
  return true
}

function offerSelectPostActionMatches(previous: BookingWorkspaceSnapshot, current: BookingWorkspaceSnapshot, action: { kind: 'offer.select'; input: { offerRef: string; offerVersionRef: string } }, receipt: ActionReceipt): boolean {
  if (receipt.status !== 'applied') return current.selectedOfferRef === previous.selectedOfferRef && loadedOffersUnchanged(previous, current)
  if (receipt.observation.kind !== 'offer.selection' || receipt.observation.offerRef !== action.input.offerRef || receipt.observation.offerVersionRef !== action.input.offerVersionRef) return false
  if (current.selectedOfferRef !== action.input.offerRef) return false
  return loadedOffersUnchanged(previous, current)
}

function workspacePostActionMatches(previous: BookingWorkspaceSnapshot, current: BookingWorkspaceSnapshot, action: BookingActionCheckpoint, receipt: ActionReceipt): boolean {
  if (!workspaceBoundaryMatches(previous, current)) return false
  const mutable: Partial<Record<BookingReadActionKind, string[]>> = {
    'search.patch': ['searchDraft'], 'search.run': ['results', 'visibleHotels'], 'results.view.patch': ['results'],
    'hotel.focus': ['focusedHotelRef'], 'hotel.select': ['focusedHotelRef'],
    'offers.query': ['loadedOffers'], 'offers.view.patch': ['loadedOffers'],
    'offer.select': ['selectedOfferRef'], 'offer.check': ['selectedOfferRef', 'shortlistedOfferRefs', 'verifiedOffer', 'loadedOffers'],
  }
  if (action.kind === 'offer.select' && !offerSelectPostActionMatches(previous, current, { kind: 'offer.select', input: { offerRef: action.input.offerRef, offerVersionRef: action.input.offerVersionRef } }, receipt)) return false
  if (action.kind === 'offer.check' && !offerCheckPostActionMatches(previous, current, { kind: 'offer.check', input: { offerRef: action.input.offerRef, offerVersionRef: action.input.offerVersionRef } }, receipt)) return false
  const allowed = new Set(['revision', ...(mutable[action.kind] ?? [])])
  const keys = new Set([...Object.keys(previous), ...Object.keys(current)])
  for (const key of keys) {
    if (allowed.has(key)) continue
    if (bookingDigest((previous as unknown as Record<string, unknown>)[key]) !== bookingDigest((current as unknown as Record<string, unknown>)[key])) return false
  }
  return true
}

function approvalOption(taskId: string, contextRef: string, sourceTurnId: string, presentationRequestKey: string, blocker: CriterionBlocker, to: RelaxationApproval['to'], deliveryNonce: string): RelaxationApproval {
  const base = {
    taskId, contextRef, sourceTurnId, presentationRequestKey,
    approvalId: `approval-${blocker.blockerId}-${to}`, deliveryNonce, blockerId: blocker.blockerId,
    sourceActionId: blocker.sourceActionId, sourceReceiptDigest: blocker.sourceReceiptDigest,
    scope: blocker.scope, code: blocker.code, criterionPath: blocker.criterionPath,
    valueDigest: blocker.valueDigest, from: 'must' as const, to, approved: true as const,
  }
  return { ...base, optionDigest: bookingDigest(base) }
}

function approvalOptionDigest(approval: RelaxationApproval): string {
  const { optionDigest: _optionDigest, ...base } = approval
  return bookingDigest(base)
}

function presentationKey(taskId: string, sourceTurnId: string, actionId: string, receiptDigest: string): string {
  return `approval:${taskId}:${sourceTurnId}:${actionId}:${receiptDigest}`
}

type ApprovalTarget = Pick<BookingReadAction, 'actionId' | 'expectedRevision' | 'kind' | 'contextRef'>
function assertApprovalRef(ref: RelaxationApprovalRef, state: BookingCopilotTaskState, action: ApprovalTarget): void {
  const approval = state.awaitingApproval?.approval
  const blocker = state.awaitingApproval?.blocker
  if (!approval || !blocker || ref.approvalId !== approval.approvalId || ref.blockerId !== blocker.blockerId || ref.contextRef !== state.contextRef || ref.sourceTurnId !== state.awaitingApproval?.sourceTurnId || ref.presentationRequestKey !== state.awaitingApproval?.presentationRequestKey || ref.sourceActionId !== blocker.sourceActionId || ref.targetActionId !== action.actionId || ref.sourceRevision !== action.expectedRevision || ref.targetActionKind !== action.kind || ref.to !== approval.to || ref.expiresAt !== state.awaitingApproval?.expiresAt || ref.nonce !== state.awaitingApproval?.nonce || ref.sourceReceiptDigest !== blocker.sourceReceiptDigest || ref.scope !== blocker.scope || ref.code !== blocker.code || ref.criterionPath !== blocker.criterionPath || ref.valueDigest !== blocker.valueDigest) throw new Error('ledger_corrupt:approval_ref')
}

export class BookingCopilotTaskRuntime {
  private readonly idFactory: (prefix: string) => string
  private readonly contextRefFactory: () => string
  private readonly now: () => string
  private readonly approvalTtlMs: number

  constructor(private readonly ledger: StateLedger, options: BookingCopilotRuntimeOptions = {}) {
    this.idFactory = options.idFactory ?? ((prefix) => `${prefix}-${randomUUID()}`)
    this.contextRefFactory = options.contextRefFactory ?? (() => this.idFactory('context'))
    this.now = options.now ?? (() => new Date().toISOString())
    this.approvalTtlMs = options.approvalTtlMs ?? 120_000
  }

  /** Read-only conflict check used before startTask can append a new turn. */
  assertRequestBinding(requestKey: string, turn: UserTurn, input: BookingIngressRequestBindingInput): void {
    assertRequestKey(requestKey)
    assertPrincipal(input.principal)
    if (input.requestKey !== requestKey) throw new Error('request_conflict')
    const existing = this.requestBinding(requestKey)
    if (!existing) return
    const candidate = this.requestBindingPayload(requestKey, turn, input)
    if (existing.requestDigest !== candidate.requestDigest || existing.turnId !== candidate.turnId || existing.workspaceDigest !== candidate.workspaceDigest || existing.workspaceSemanticDigest !== candidate.workspaceSemanticDigest || existing.surface !== candidate.surface || existing.capabilityDigest !== candidate.capabilityDigest || existing.contextRef !== turn.workspace.contextRef || existing.principalDigest !== candidate.principalDigest || existing.scopeDigest !== candidate.scopeDigest || existing.taskHandle !== candidate.taskHandle) throw new Error('request_conflict')
  }

  /** Verifies a direct planner turn against its durable TURN row. */
  assertTurnBinding(taskId: string, turn: UserTurn): void {
    assertTaskId(taskId)
    const row = this.ledger.db.prepare(`SELECT payload FROM events WHERE tenant_id = ? AND run_id = ? AND kind = ? ORDER BY seq DESC`).all(this.ledger.tenant, taskId, TURN) as Array<{ payload: string }>
    const observed = row.map(({ payload }) => JSON.parse(payload) as TurnPayload).find((candidate) => candidate.turnId === turn.turnId)
    if (!observed || observed.requestDigest !== bookingTurnDigest(turn) || observed.workspaceDigest !== bookingWorkspaceDigest(turn.workspace) || observed.workspaceSemanticDigest !== bookingWorkspaceSemanticDigest(turn.workspace) || observed.contextRef !== turn.workspace.contextRef) throw new Error('turn_conflict')
  }

  /** Persists the per-requestKey receipt/replay binding after task creation. */
  persistRequestBinding(requestKey: string, turn: UserTurn, input: BookingIngressRequestBindingInput): void {
    assertRequestKey(requestKey)
    assertPrincipal(input.principal)
    if (input.requestKey !== requestKey) throw new Error('request_conflict')
    const run = this.ledger.db.transaction(() => {
      const state = this.requireTask(turn.taskId)
      if (state.phase === 'terminal' || state.phase === 'error') throw new Error('task_terminal')
      assertReplayUpgradeReanchored(state)
      this.appendRequestBindingInTransaction(requestKey, turn, input)
    })
    run.immediate()
  }

  /** Binds the untrusted ingress snapshot to server-owned task/context/capabilities. */
  bindIngressTurn(turn: IngressTurn, task: BookingCopilotTaskState, turnId: string): UserTurn {
    assertSafeRef(turnId)
    return {
      schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId,
      workspace: {
        ...turn.workspace,
        schemaVersion: 'booking.surface', contextRef: task.contextRef, surface: task.surface,
        capabilities: { surface: task.surface, allowedActions: [...task.allowedActions] },
      },
      request: { text: turn.request.text },
    }
  }

  startTask(turn: BookingCopilotTurn, requestBinding?: BookingIngressRequestBindingInput): BookingCopilotTaskState {
    const validation = validateBookingSurface(turn)
    if (!validation.ok) throw new Error(`invalid_planner_turn:${errorText(validation)}`)
    if (turn.kind === 'user.turn.ingress') throw new Error('ingress_binding_required')
    if (turn.kind === 'action.receipt.continuation') throw new Error('receipt_continuation_requires_continue')
    const userTurn = turn as UserTurn
    if (!userTurn.taskId) throw new Error('invalid_planner_turn:task_id_required')
    const taskId = userTurn.taskId
    assertTaskId(taskId)
    const turnId = userTurn.turnId
    if (!turnId) throw new Error('invalid_planner_turn:turn_id_required')
    assertSafeRef(turnId)
    const contextRef = userTurn.workspace.contextRef
    const surface = userTurn.workspace.surface
    const revision = userTurn.workspace.revision
    const allowedActions = [...userTurn.workspace.capabilities.allowedActions]
    const requestDigest = bookingTurnDigest(turn)
    const boundWorkspace = userTurn.workspace
    assertWorkspaceLoadedOfferRefsUnique(boundWorkspace)
    const workspaceDigest = bookingWorkspaceDigest(boundWorkspace)
    const workspaceSemanticDigest = bookingWorkspaceSemanticDigest(boundWorkspace)
    const availability = createAvailabilityPolicy(boundWorkspace)
    const run = this.ledger.db.transaction(() => {
      const existing = this.resumeTask(taskId)
      if (existing) {
        if (existing.contextRef !== contextRef) throw new Error('task_conflict:context_mismatch')
        if (existing.surface !== surface) throw new Error('task_conflict:surface_mismatch')
        if (existing.revision !== revision && existing.phase !== 'waiting_receipt' && !existing.replayUpgradeRequired) throw new Error('task_conflict:revision_mismatch')
        if (!sameActions(existing.allowedActions, allowedActions)) throw new Error('task_conflict:capability_mismatch')
        if (existing.phase === 'terminal' || existing.phase === 'error') throw new Error('task_terminal')
        if (turnId && existing.lastTurnId === turnId) {
          this.assertTurnBinding(taskId, userTurn)
          if (requestBinding) {
            assertReplayUpgradeReanchored(existing)
            this.appendRequestBindingInTransaction(requestBinding.requestKey, userTurn, requestBinding)
          }
          return existing
        }
        if (existing.phase === 'waiting_receipt') throw new Error('receipt_required')
        const approval = userTurn && 'approval' in userTurn.request ? userTurn.request.approval : undefined
        let approvalState: BookingApprovalState | undefined
        if (approval) {
          assertReplayUpgradeReanchored(existing)
          const awaiting = existing.awaitingApproval
          if (!awaiting) throw new Error('approval_not_awaiting')
          if (!awaiting.optionsEmitted) throw new Error('approval_not_presented')
          if (Date.parse(awaiting.expiresAt) <= Date.parse(this.now())) throw new Error('approval_expired')
          const checked = validateApprovalAgainstBlocker(approval, awaiting.blocker)
          const option = awaiting.options.find((candidate) => candidate.optionDigest === approval.optionDigest && bookingDigest(candidate) === bookingDigest(approval))
          if (!checked.ok || !option || approval.taskId !== existing.taskId || approval.contextRef !== existing.contextRef || approval.sourceTurnId !== awaiting.sourceTurnId || approval.presentationRequestKey !== awaiting.presentationRequestKey || approval.optionDigest !== approvalOptionDigest(approval) || (awaiting.approval && bookingDigest(approval) !== bookingDigest(awaiting.approval))) throw new Error('approval_mismatch')
          if (awaiting.approval && bookingDigest(awaiting.approval) === bookingDigest(approval)) return existing
          approvalState = { ...awaiting, approval }
          this.appendApproval(taskId, existing.contextRef, approvalState)
        } else if (existing.awaitingApproval) {
          throw new Error('approval_required')
        }
        this.appendTurn(taskId, existing.contextRef, requestDigest, workspaceDigest, workspaceSemanticDigest, existing.userTurnCount + 1, turnId, boundWorkspace)
        if (requestBinding) this.appendRequestBindingInTransaction(requestBinding.requestKey, userTurn, requestBinding)
        return this.requireTask(taskId)
      }
      if (userTurn?.request.approval) throw new Error('approval_not_awaiting')
      const started: StartedPayload = { schema: LEDGER_SCHEMA, taskId, contextRef, surface, revision, allowedActions, workspaceDigest, workspaceSemanticDigest, workspace: boundWorkspace, availability, availabilityDigest: bookingDigest(availability) }
      this.append(STARTED, taskId, started, `booking-copilot:task:${taskId}`)
      this.appendTurn(taskId, contextRef, requestDigest, workspaceDigest, workspaceSemanticDigest, 1, turnId, boundWorkspace)
      if (requestBinding) this.appendRequestBindingInTransaction(requestBinding.requestKey, userTurn, requestBinding)
      return this.requireTask(taskId)
    })
    return run.immediate()
  }

  resumeTask(taskId: string): BookingCopilotTaskState | null {
    assertTaskId(taskId)
    const rows = this.rows(taskId)
    if (!rows.length) return null
    let state: BookingCopilotTaskState | null = null
    let skipLegacyUpgradeTail = false
    const replayWorkspaceDigests = new Map<string, string>()
    const consumed: ReplayConsumedIdentities = { events: new Map(), actions: new Map(), pendingBatchKeys: new Set(), pendingBatchOpen: false }
    const suppressedDecisionRequestKeys = new Set<string>()
    const suppressedRequestBindingKeys = new Set<string>()
    const suppressedReceiptActionIds = new Set<string>()
    const suppressedApprovalTargetActionIds = new Set<string>()
    for (const row of rows) {
      const payload = JSON.parse(row.payload) as BasePayload & Record<string, any>
      if (payload.schema !== LEDGER_SCHEMA || payload.taskId !== taskId) throw new Error(`ledger_corrupt:${taskId}:seq=${row.seq}`)
      if (row.kind === STARTED) {
        skipLegacyUpgradeTail = false
        if (state) throw new Error(`ledger_corrupt:${taskId}:duplicate_start`)
        const started = payload as StartedPayload
        let startedWorkspace: BookingWorkspaceSnapshot
        try { startedWorkspace = normalizeWorkspaceForReplay(started.workspace) } catch { throw new Error(`ledger_corrupt:${taskId}:start_workspace`) }
        let initialAvailability: AvailabilityPolicyState
        try { initialAvailability = createAvailabilityPolicy(startedWorkspace) } catch { throw new Error(`ledger_corrupt:${taskId}:start_availability`) }
        try { assertWorkspaceLoadedOfferRefsUnique(startedWorkspace) } catch { throw new Error(`ledger_corrupt:${taskId}:start_workspace`) }
        rememberReplayWorkspaceDigest(replayWorkspaceDigests, started.workspaceDigest, started.workspace, startedWorkspace)
        const startedAvailability = normalizeAvailabilityPolicyForReplay(started.availability, startedWorkspace, undefined, undefined, replayWorkspaceDigests)
        if (!started.workspaceDigest || !started.workspaceSemanticDigest || !started.workspace || !started.availability || !started.availabilityDigest || !validateAvailabilityPolicy(startedAvailability) || !replayDigestMatches(started.availabilityDigest, started.availability, startedAvailability) || bookingDigest(initialAvailability) !== bookingDigest(startedAvailability) || !replayWorkspaceDigestMatches(started.workspaceDigest, started.workspace, startedWorkspace) || !replayWorkspaceSemanticDigestMatches(started.workspaceSemanticDigest, started.workspace, startedWorkspace)) throw new Error(`ledger_corrupt:${taskId}:start_workspace`)
        state = { schemaVersion: 'booking.surface', taskId, contextRef: started.contextRef, surface: started.surface, revision: started.revision, allowedActions: [...started.allowedActions], userTurnCount: 0, operationCount: 0, phase: startedAvailability.terminal ? 'terminal' : 'planning', lastSequence: 0, workspaceDigest: bookingWorkspaceDigest(startedWorkspace), workspaceSemanticDigest: bookingWorkspaceSemanticDigest(startedWorkspace), workspaceSnapshot: startedWorkspace, availability: startedAvailability }
      } else {
        if (!state) throw new Error(`ledger_corrupt:${taskId}:event_before_start`)
        if (payload.contextRef !== state.contextRef) throw new Error(`ledger_corrupt:${taskId}:context_drift`)
        if (row.kind === REQUEST_BINDING) {
          if (skipLegacyUpgradeTail) {
            const binding = payload as RequestBindingPayload
            if (typeof binding.requestKey === 'string') suppressedRequestBindingKeys.add(binding.requestKey)
            continue
          }
          const binding = payload as RequestBindingPayload
          const turnRows = this.ledger.db.prepare(`SELECT payload FROM events WHERE tenant_id = ? AND run_id = ? AND kind = ?`).all(this.ledger.tenant, taskId, TURN) as Array<{ payload: string }>
          const rawBoundTurn = turnRows.map(({ payload }) => JSON.parse(payload) as TurnPayload).find((candidate) => candidate.turnId === binding.turnId)
          let boundTurn: TurnPayload | undefined
          try { boundTurn = rawBoundTurn ? { ...rawBoundTurn, workspace: normalizeWorkspaceForReplay(rawBoundTurn.workspace) } : undefined } catch { throw new Error(`ledger_corrupt:${taskId}:request_binding`) }
          if (!isSafeBookingRequestKey(binding.requestKey) || !safeIdentity(binding.turnId) || !safeIdentity(binding.contextRef) || (binding.taskHandle !== undefined && !safeIdentity(binding.taskHandle)) || !/^[0-9a-f]{64}$/.test(binding.requestDigest) || !/^[0-9a-f]{64}$/.test(binding.workspaceDigest) || !/^[0-9a-f]{64}$/.test(binding.workspaceSemanticDigest) || !/^[0-9a-f]{64}$/.test(binding.capabilityDigest) || !/^[0-9a-f]{64}$/.test(binding.principalDigest) || !/^[0-9a-f]{64}$/.test(binding.scopeDigest) || !['tenant', 'customer_portal', 'storefront', 'payment_link'].includes(binding.surface) || !boundTurn || boundTurn.requestDigest !== binding.requestDigest || boundTurn.workspaceDigest !== binding.workspaceDigest || boundTurn.workspaceSemanticDigest !== binding.workspaceSemanticDigest || bookingDigest(boundTurn.workspace.capabilities) !== binding.capabilityDigest || boundTurn.workspace.surface !== binding.surface) throw new Error(`ledger_corrupt:${taskId}:request_binding`)
        } else if (row.kind === TURN) {
          skipLegacyUpgradeTail = false
          const t = payload as TurnPayload
          if (Object.prototype.hasOwnProperty.call(payload, 'approval')) throw new Error(`ledger_corrupt:${taskId}:turn_approval`)
          let turnWorkspace: BookingWorkspaceSnapshot
          try { turnWorkspace = normalizeWorkspaceForReplay(t.workspace) } catch { throw new Error(`ledger_corrupt:${taskId}:turn_workspace`) }
          try { assertWorkspaceLoadedOfferRefsUnique(turnWorkspace) } catch { throw new Error(`ledger_corrupt:${taskId}:turn_workspace`) }
          if (!t.workspaceDigest || !t.workspaceSemanticDigest || !t.workspace || !replayWorkspaceDigestMatches(t.workspaceDigest, t.workspace, turnWorkspace) || !replayWorkspaceSemanticDigestMatches(t.workspaceSemanticDigest, t.workspace, turnWorkspace)) throw new Error(`ledger_corrupt:${taskId}:turn_workspace`)
          rememberReplayWorkspaceDigest(replayWorkspaceDigests, t.workspaceDigest, t.workspace, turnWorkspace)
          state.userTurnCount++
          state.lastTurnId = t.turnId
          state.workspaceDigest = bookingWorkspaceDigest(turnWorkspace)
          state.workspaceSemanticDigest = bookingWorkspaceSemanticDigest(turnWorkspace)
          state.workspaceSnapshot = turnWorkspace
          state.revision = turnWorkspace.revision
          delete state.replayUpgradeRequired
          // Approval authority is established only by APPROVAL_GRANTED; a turn
          // is merely an observation and cannot restore or mutate approval state.
        } else if (row.kind === APPROVAL_GRANTED) {
          if (skipLegacyUpgradeTail) continue
          const granted = payload as ApprovalPayload
          if (!granted.approval || granted.approvalDigest !== bookingDigest(granted.approval) || !granted.approval.sourceTurnId || !granted.approval.presentationRequestKey || !validateCriterionBlocker(granted.approval.blocker).ok || !granted.approval.options?.length || granted.approval.options.some((option) => !validateApprovalAgainstBlocker(option, granted.approval!.blocker).ok || option.taskId !== taskId || option.contextRef !== state!.contextRef || option.sourceTurnId !== granted.approval!.sourceTurnId || option.presentationRequestKey !== granted.approval!.presentationRequestKey || option.optionDigest !== approvalOptionDigest(option)) || (granted.approval.approval && !granted.approval.options.some((option) => bookingDigest(option) === bookingDigest(granted.approval!.approval!)))) throw new Error(`ledger_corrupt:${taskId}:approval_granted`)
          state.awaitingApproval = granted.approval; state.phase = 'input_required'
        } else if (row.kind === APPROVAL_OFFERED) {
          if (skipLegacyUpgradeTail) continue
          const offered = payload as ApprovalPayload
          if (!offered.approval || offered.approvalDigest !== bookingDigest(offered.approval) || !state.awaitingApproval || bookingDigest(offered.approval) !== bookingDigest(state.awaitingApproval)) throw new Error(`ledger_corrupt:${taskId}:approval_offered`)
          // This is a durable outbox intent only.  It is deliberately not
          // evidence that the question entered a replayable output batch:
          // a crash between this row and DECISION_BATCH must still reject an
          // approval until the exact question can be replayed.
          state.phase = 'input_required'
        } else if (row.kind === ACTION) {
          const actionPayload = payload as ActionPayload
          if (skipLegacyUpgradeTail) { try { consumeSkippedActionOrdinal(state, actionPayload, consumed) } catch { throw new Error(`ledger_corrupt:${taskId}:action`) } continue }
          const rawAction = actionPayload.action
          const operationCount = actionPayload.operationCount ?? state.operationCount + 1
          const { actionDigest: _rawActionDigest, ...rawActionBase } = rawAction
          if (rawAction.actionDigest !== checkpointDigest(rawActionBase) || rawAction.contextRef !== state.contextRef || !Number.isSafeInteger(operationCount) || operationCount !== state.operationCount + 1 || operationCount > BOOKING_COPILOT_MAX_OPERATIONS || !Number.isSafeInteger(rawAction.sequence) || rawAction.sequence <= state.lastSequence) throw new Error(`ledger_corrupt:${taskId}:action`)
          let a: BookingActionCheckpoint
          try { a = normalizeActionCheckpointForReplay(rawAction, state.workspaceSnapshot) } catch (error) {
            if (error instanceof Error && error.message.startsWith('booking_replan_required:')) { state = replanAfterReplayUpgradeGap(state); try { consumeSkippedActionOrdinal(state, actionPayload, consumed) } catch { throw new Error(`ledger_corrupt:${taskId}:action`) } skipLegacyUpgradeTail = true; continue }
            throw error
          }
          const { actionDigest: _actionDigest, ...actionBase } = a
          if (!actionPayload.availability || actionPayload.availabilityDigest !== bookingDigest(actionPayload.availability)) throw new Error(`ledger_corrupt:${taskId}:action`)
          let actionAvailability: AvailabilityPolicyState
          try { actionAvailability = normalizeAvailabilityPolicyForReplay(actionPayload.availability, state.workspaceSnapshot, a, state.availability, replayWorkspaceDigests) } catch (error) {
            if (error instanceof Error && error.message.startsWith('booking_replan_required:')) { state = replanAfterReplayUpgradeGap(state); try { consumeSkippedActionOrdinal(state, actionPayload, consumed) } catch { throw new Error(`ledger_corrupt:${taskId}:action`) } skipLegacyUpgradeTail = true; continue }
            throw error
          }
          if (!checkpointDigestMatchesForReplay(rawAction, a) || a.actionDigest !== checkpointDigest(actionBase) || !Number.isSafeInteger(operationCount) || operationCount !== state.operationCount + 1 || operationCount > BOOKING_COPILOT_MAX_OPERATIONS || !validateAvailabilityPolicy(actionAvailability) || !replayDigestMatches(actionPayload.availabilityDigest, actionPayload.availability, actionAvailability) || !state.workspaceSnapshot) throw new Error(`ledger_corrupt:${taskId}:action`)
          if (a.relaxationApprovalRef) assertApprovalRef(a.relaxationApprovalRef, state, a)
          if (state.pendingAction) throw new Error(`ledger_corrupt:${taskId}:parallel_actions`)
          let expectedAvailability: AvailabilityPolicyState
          try { expectedAvailability = reduceAvailabilityAction(state.availability, state.workspaceSnapshot, a) } catch { throw new Error(`ledger_corrupt:${taskId}:action_transition`) }
          if (bookingDigest(expectedAvailability) !== bookingDigest(actionAvailability)) throw new Error(`ledger_corrupt:${taskId}:action_transition`)
          state.operationCount = operationCount
          state.availability = actionAvailability
          state.pendingAction = a; state.phase = 'waiting_receipt'; state.lastSequence = Math.max(state.lastSequence, a.sequence)
          {
            rememberConsumedActionIdentity(consumed, a)
          }
          delete state.awaitingApproval
        } else if (row.kind === RECEIPT) {
          if (skipLegacyUpgradeTail) {
            const r = payload as ReceiptPayload
            if (typeof r.receipt?.actionId === 'string') suppressedReceiptActionIds.add(r.receipt.actionId)
            continue
          }
          const r = payload as ReceiptPayload
          const operationCount = r.operationCount ?? state.operationCount
          if (!state.pendingAction || state.pendingAction.actionId !== r.receipt.actionId) throw new Error(`ledger_corrupt:${taskId}:orphan_receipt`)
          let receiptWorkspace: BookingWorkspaceSnapshot
          try { receiptWorkspace = normalizeWorkspaceForReplay(r.workspace) } catch { throw new Error(`ledger_corrupt:${taskId}:receipt_workspace`) }
          try { assertWorkspaceLoadedOfferRefsUnique(receiptWorkspace) } catch { throw new Error(`ledger_corrupt:${taskId}:receipt_workspace`) }
          if (!r.workspaceDigest || !r.workspaceSemanticDigest || !r.workspace || !replayWorkspaceDigestMatches(r.workspaceDigest, r.workspace, receiptWorkspace) || !replayWorkspaceSemanticDigestMatches(r.workspaceSemanticDigest, r.workspace, receiptWorkspace)) throw new Error(`ledger_corrupt:${taskId}:receipt_workspace`)
          rememberReplayWorkspaceDigest(replayWorkspaceDigests, r.workspaceDigest, r.workspace, receiptWorkspace)
          if (!replayDigestMatches(r.receiptDigest, r.receipt, r.receipt) || r.receipt.contextRef !== state.contextRef || r.receipt.actionId !== state.pendingAction.actionId || !Number.isSafeInteger(r.receipt.revision) || r.receipt.revision < state.pendingAction.expectedRevision || !Number.isSafeInteger(operationCount) || operationCount !== state.operationCount) throw new Error(`ledger_corrupt:${taskId}:receipt`)
          if (!r.availability || r.availabilityDigest !== bookingDigest(r.availability)) throw new Error(`ledger_corrupt:${taskId}:receipt`)
          let receipt: ActionReceipt
          try { receipt = normalizeReceiptForReplay(r.receipt, state.pendingAction, receiptWorkspace) } catch (error) {
            if (error instanceof Error && error.message.startsWith('booking_replan_required:')) { clearPendingBatch(consumed); state = replanAfterReplayUpgradeGap(state, receiptWorkspace, r.receipt.revision); skipLegacyUpgradeTail = true; continue }
            throw error
          }
          let receiptAvailability: AvailabilityPolicyState
          try { receiptAvailability = normalizeAvailabilityPolicyForReplay(r.availability, receiptWorkspace, state.pendingAction, state.availability, replayWorkspaceDigests, receipt) } catch (error) {
            if (error instanceof Error && error.message.startsWith('booking_replan_required:')) { clearPendingBatch(consumed); state = replanAfterReplayUpgradeGap(state, receiptWorkspace, r.receipt.revision); skipLegacyUpgradeTail = true; continue }
            throw error
          }
          if (!replayDigestMatches(r.receiptDigest, r.receipt, receipt) || !validateBookingSurface(receipt).ok || !r.availability || !r.availabilityDigest || !validateAvailabilityPolicy(receiptAvailability) || !replayDigestMatches(r.availabilityDigest, r.availability, receiptAvailability)) throw new Error(`ledger_corrupt:${taskId}:receipt`)
          if (Boolean(r.availabilityTerminal) !== Boolean(receiptAvailability.terminal) || (r.availabilityTerminal && receiptAvailability.terminal && bookingDigest(r.availabilityTerminal) !== bookingDigest(receiptAvailability.terminal))) throw new Error(`ledger_corrupt:${taskId}:availability_terminal`)
          assertCanonicalReceipt(receipt)
          if (!state.workspaceSnapshot || !workspacePostActionMatches(state.workspaceSnapshot, receiptWorkspace, state.pendingAction, receipt) || !receiptObservationMatchesAction(receipt.observation.kind, state.pendingAction.kind) || !receiptTargetMatchesAction(receipt, state.pendingAction)) throw new Error(`ledger_corrupt:${taskId}:receipt_transition`)
          let expectedAvailability: AvailabilityPolicyState
          try { expectedAvailability = reduceAvailabilityReceipt(state.availability, receiptWorkspace, receipt, state.pendingAction) } catch { throw new Error(`ledger_corrupt:${taskId}:receipt_transition`) }
          if (bookingDigest(expectedAvailability) !== bookingDigest(receiptAvailability)) throw new Error(`ledger_corrupt:${taskId}:receipt_transition`)
          state.lastReceipt = receipt; state.revision = receipt.revision; state.workspaceDigest = bookingWorkspaceDigest(receiptWorkspace); state.workspaceSemanticDigest = bookingWorkspaceSemanticDigest(receiptWorkspace); state.workspaceSnapshot = receiptWorkspace; state.availability = receiptAvailability; delete state.pendingAction; state.phase = receiptAvailability.terminal || state.operationCount >= BOOKING_COPILOT_MAX_OPERATIONS ? 'terminal' : 'planning'
          clearPendingBatch(consumed)
          delete state.awaitingApproval
        } else if (row.kind === APPROVAL_CONSUMED) {
          if (skipLegacyUpgradeTail) {
            const consumed = payload as ApprovalPayload
            if (typeof consumed.ref?.targetActionId === 'string') suppressedApprovalTargetActionIds.add(consumed.ref.targetActionId)
            continue
          }
          const consumed = payload as ApprovalPayload
          if (!consumed.ref || consumed.approvalDigest !== bookingDigest(consumed.ref) || !consumed.approval?.approval || !consumed.approval.options?.some((option) => bookingDigest(option) === bookingDigest(consumed.approval!.approval!)) || !state.awaitingApproval || bookingDigest(consumed.approval) !== bookingDigest(state.awaitingApproval) || consumed.ref.approvalId !== consumed.approval.approval.approvalId || consumed.ref.blockerId !== consumed.approval.blocker.blockerId || consumed.ref.contextRef !== state.contextRef || consumed.ref.sourceTurnId !== consumed.approval.sourceTurnId || consumed.ref.presentationRequestKey !== consumed.approval.presentationRequestKey || consumed.ref.sourceActionId !== consumed.approval.blocker.sourceActionId || consumed.ref.targetActionId === '' || consumed.ref.sourceReceiptDigest !== consumed.approval.blocker.sourceReceiptDigest || consumed.ref.nonce !== consumed.approval.nonce || consumed.ref.nonce !== consumed.approval.approval.deliveryNonce || consumed.ref.to !== consumed.approval.approval.to || consumed.ref.scope !== consumed.approval.blocker.scope || consumed.ref.code !== consumed.approval.blocker.code || consumed.ref.criterionPath !== consumed.approval.blocker.criterionPath || consumed.ref.valueDigest !== consumed.approval.blocker.valueDigest) throw new Error(`ledger_corrupt:${taskId}:approval`)
        } else if (row.kind === DECISION_BATCH) {
          const batch = payload as DecisionBatchPayload
          if (skipLegacyUpgradeTail) {
            try { consumeSkippedEventSequence(state, batch, consumed) } catch { throw new Error(`ledger_corrupt:${taskId}:decision_batch`) }
            if (typeof batch.requestKey === 'string') suppressedDecisionRequestKeys.add(batch.requestKey)
            continue
          }
          if (!batch.requestKey || !Array.isArray(batch.events) || batch.events.some((event) => event.taskId !== taskId)) throw new Error(`ledger_corrupt:${taskId}:decision_batch`)
          let batchEvents: BookingSurfaceEvent[]
          try { batchEvents = normalizeDecisionBatchEnvelopeForReplay(batch, consumed, true) } catch { throw new Error(`ledger_corrupt:${taskId}:decision_batch`) }
          for (const event of batchEvents) {
            if (event.kind !== 'question') continue
            const awaiting = state.awaitingApproval
            if (!awaiting || bookingDigest(event.question.blocker) !== bookingDigest(awaiting.blocker) || event.question.approvalOptions.length !== awaiting.options.length || event.question.approvalOptions.some(({ approval }) => !awaiting.options.some((option) => bookingDigest(option) === bookingDigest(approval)))) throw new Error(`ledger_corrupt:${taskId}:decision_batch_question`)
            // Only the atomic, durable batch makes the presentation nonce
            // usable.  APPROVAL_OFFERED alone is intentionally insufficient.
            awaiting.optionsEmitted = true
            state.phase = 'input_required'
          }
        } else if (row.kind === EVENT) {
          const event = payload as EventPayload
          if (skipLegacyUpgradeTail) { try { consumeSkippedEventSequence(state, event, consumed) } catch { throw new Error(`ledger_corrupt:${taskId}:event`) } continue }
          state.lastSequence = Math.max(state.lastSequence, event.sequence)
          {
            rememberConsumedEventIdentity(consumed, event)
          }
          if (event.eventKind === 'status') state.phase = event.status === 'submitted' ? 'submitted' : event.status === 'working' ? 'working' : event.status === 'waiting_receipt' ? 'waiting_receipt' : 'input_required'
          else if (event.eventKind === 'question') state.phase = 'input_required'
          else if (event.eventKind === 'terminal') state.phase = 'terminal'
          else if (event.eventKind === 'error') state.phase = 'error'
        }
      }
    }
    if (state) {
      if (suppressedDecisionRequestKeys.size) state.legacySuppressedDecisionRequestKeys = [...suppressedDecisionRequestKeys]
      if (suppressedRequestBindingKeys.size) state.legacySuppressedRequestBindingKeys = [...suppressedRequestBindingKeys]
      if (suppressedReceiptActionIds.size) state.legacySuppressedReceiptActionIds = [...suppressedReceiptActionIds]
      if (suppressedApprovalTargetActionIds.size) state.legacySuppressedApprovalTargetActionIds = [...suppressedApprovalTargetActionIds]
    }
    return state
  }

  withReceiptDigest<T extends ActionReceipt>(receipt: T): T {
    // The source receipt digest is the authority used by the approval binding.
    const sourceDigest = receiptSourceDigest(receipt)
    return { ...receipt, resultContract: { ...receipt.resultContract, blockers: receipt.resultContract.blockers.map((b) => ({ ...b, sourceReceiptDigest: sourceDigest })) } }
  }

  receiptDigest(receipt: ActionReceipt): string { return canonicalReceiptDigest(receipt) }

  /** Builds the only relaxation question exposed to the planner stream. The
   * blocker is ledger-derived; a planner cannot invent its tuple or ref. */
  approvalQuestion(taskId: string): BookingSurfaceEventDraft {
    const task = this.requireTask(taskId)
    const awaiting = task.awaitingApproval
    if (!awaiting) throw new Error('approval_not_awaiting')
    return {
      kind: 'question',
      question: {
        questionId: `question-${awaiting.blocker.blockerId}`,
        prompt: `Relax required criterion ${awaiting.blocker.criterionPath}?`,
        missingFields: [awaiting.blocker.criterionPath],
        type: 'relaxation_approval_required',
        blocker: awaiting.blocker,
        approvalOptions: awaiting.options.map((approval) => ({ approval })),
      },
    }
  }

  approvalPresentationRequestKey(taskId: string): string {
    const task = this.requireTask(taskId)
    const awaiting = task.awaitingApproval
    if (!awaiting) throw new Error('approval_not_awaiting')
    return awaiting.presentationRequestKey
  }

  commitDecisionBatch(taskId: string, requestKey: string, decisions: readonly BookingPlannerDecision[]): BookingSurfaceEvent[] {
    return this.applyDecisionBatch(taskId, requestKey, decisions)
  }

  readDecisionBatch(taskId: string, requestKey: string): BookingSurfaceEvent[] | null {
    const state = this.requireTask(taskId)
    if (state.legacySuppressedDecisionRequestKeys?.includes(requestKey)) throw new Error('request_key_invalidated')
    const rows = this.ledger.db.prepare('SELECT seq, payload FROM events WHERE tenant_id = ? AND run_id = ? AND kind = ? ORDER BY seq DESC').all(this.ledger.tenant, taskId, DECISION_BATCH) as Array<{ seq: number; payload: string }>
    for (const row of rows) {
      const payload = JSON.parse(row.payload) as DecisionBatchPayload
      if (payload.requestKey !== requestKey) continue
      if (payload.schema !== LEDGER_SCHEMA || payload.taskId !== taskId || payload.contextRef !== state.contextRef || !Array.isArray(payload.events) || payload.events.some((event) => event.taskId !== taskId || event.contextRef !== state.contextRef)) throw new Error(`ledger_corrupt:${taskId}:decision_batch`)
      const events = this.normalizeDecisionBatchFromDurableRows(taskId, payload.events, row.seq)
      if (!events) throw new Error(`ledger_corrupt:${taskId}:decision_batch`)
      for (const event of events) {
        if (event.kind !== 'question') continue
        const awaiting = state.awaitingApproval
        if (!awaiting || requestKey !== awaiting.presentationRequestKey || bookingDigest(event.question.blocker) !== bookingDigest(awaiting.blocker) || event.question.approvalOptions.length !== awaiting.options.length || event.question.approvalOptions.some(({ approval }) => !awaiting.options.some((option) => option.optionDigest === approval.optionDigest && bookingDigest(option) === bookingDigest(approval)))) throw new Error(`ledger_corrupt:${taskId}:decision_batch_question`)
      }
      return events
    }
    return null
  }

  /** Materializes the durable policy/budget terminal response once, before SSE. */
  terminalDecisionBatch(taskId: string, requestKey: string): BookingSurfaceEvent[] {
    assertInternalDecisionKey(requestKey)
    const prior = this.readDecisionBatch(taskId, requestKey)
    if (prior) return prior
    const state = this.requireTask(taskId)
    if (state.phase === 'terminal' || state.phase === 'error') throw new Error('task_terminal')
    assertReplayUpgradeReanchored(state)
    const run = this.ledger.db.transaction(() => {
      const state = this.requireTask(taskId)
      if (!taskHasTerminalBudget(state) || state.phase !== 'terminal') throw new Error('task_not_terminal')
      assertReplayUpgradeReanchored(state)
      const event = this.terminalEvent(state)
      this.appendTerminalEvent(taskId, event)
      this.append(DECISION_BATCH, taskId, { schema: LEDGER_SCHEMA, taskId, contextRef: state.contextRef, requestKey, events: [event] }, `booking-copilot:decision-batch:${taskId}:${requestKey}`)
      return [event]
    })
    return run.immediate()
  }

  /** Atomically applies planner decisions and records the exact SSE batch before it is sent. */
  applyDecisionBatch(taskId: string, requestKey: string, decisions: readonly BookingPlannerDecision[], includeSubmitted = false): BookingSurfaceEvent[] {
    assertInternalDecisionKey(requestKey)
    const prior = this.readDecisionBatch(taskId, requestKey)
    if (prior) return prior
    const current = this.requireTask(taskId)
    if (current.phase === 'terminal' || current.phase === 'error') throw new Error('task_terminal')
    assertReplayUpgradeReanchored(current)
    assertDecisionBatchFinality(decisions)
    assertAvailabilityLiveness(current, decisions)
    if (current.availability.recoveryStarted && !current.availability.terminal && decisions.some((decision) => decision.kind === 'terminal' || decision.kind === 'error')) throw new Error('availability_terminal_policy_owned')
    for (const decision of decisions) {
      if (decision.kind === 'operation') {
        const checked = validateBookingReadAction(decision.action)
        if (!checked.ok) throw new Error(`invalid_action:${errorText(checked)}`)
      }
    }
    const run = this.ledger.db.transaction(() => {
      const events: BookingSurfaceEvent[] = []
      const before = this.requireTask(taskId)
      assertReplayUpgradeReanchored(before)
      assertAvailabilityLiveness(before, decisions)
      if (before.availability.recoveryStarted && !before.availability.terminal && decisions.some((decision) => decision.kind === 'terminal' || decision.kind === 'error')) throw new Error('availability_terminal_policy_owned')
      for (const decision of decisions) {
        if (decision.kind !== 'question') continue
        const awaiting = before.awaitingApproval
        if (!awaiting || requestKey !== awaiting.presentationRequestKey || bookingDigest(decision.question.blocker) !== bookingDigest(awaiting.blocker) || decision.question.approvalOptions.length !== awaiting.options.length || decision.question.approvalOptions.some(({ approval }) => !awaiting.options.some((option) => option.optionDigest === approval.optionDigest && bookingDigest(option) === bookingDigest(approval)))) throw new Error('approval_presentation_key_mismatch')
        this.ensureApprovalOffered(taskId, before.contextRef, awaiting, requestKey)
      }
      if (includeSubmitted) events.push(this.emitEventInTransaction(taskId, { kind: 'status', status: 'submitted' }))
      events.push(this.emitEventInTransaction(taskId, { kind: 'status', status: 'working' }))
      for (const decision of decisions) {
        if (decision.kind === 'operation') {
          events.push(this.issueOperationInTransaction(taskId, decision.action))
          events.push(this.emitEventInTransaction(taskId, { kind: 'status', status: 'waiting_receipt' }))
        }
        else events.push(this.emitEventInTransaction(taskId, decision))
      }
      const state = this.requireTask(taskId)
      this.append(DECISION_BATCH, taskId, { schema: LEDGER_SCHEMA, taskId, contextRef: state.contextRef, requestKey, events }, `booking-copilot:decision-batch:${taskId}:${requestKey}`)
      return events
    })
    return run.immediate()
  }

  issueOperation(taskId: string, candidate: BookingReadAction): { schemaVersion: 'booking.surface'; eventId: string; taskId: string; contextRef: string; sequence: number; emittedAt: string; kind: 'operation'; action: BookingReadAction } {
    const validation = validateBookingReadAction(candidate)
    if (!validation.ok) throw new Error(`invalid_action:${errorText(validation)}`)
    assertTaskId(taskId); assertSafeRef(candidate.actionId); candidate.factRefs.forEach(assertSafeRef)
    return this.ledger.db.transaction(() => this.issueOperationInTransaction(taskId, candidate)).immediate()
  }

  private issueOperationInTransaction(taskId: string, candidate: BookingReadAction) {
      assertSafeRef(candidate.actionId); candidate.factRefs.forEach(assertSafeRef)
      const state = this.requireTask(taskId)
      if (state.phase === 'terminal' || state.phase === 'error') throw new Error('task_terminal')
      assertReplayUpgradeReanchored(state)
      if (state.pendingAction) {
        if (state.pendingAction.actionId !== candidate.actionId) throw new Error('receipt_required')
        if (!matchesCheckpoint(candidate, state.pendingAction)) throw new Error('action_conflict')
        return this.operationEvent(taskId, state.pendingAction, candidate)
      }
      if (candidate.contextRef !== state.contextRef) throw new Error('context_mismatch')
      if (!state.allowedActions.includes(candidate.kind)) throw new Error('unsupported_action')
      if (candidate.expectedRevision !== state.revision) throw new Error('stale_revision')
      if (state.operationCount >= BOOKING_COPILOT_MAX_OPERATIONS) throw new Error('operation_limit_reached')
      if (candidate.relaxationApprovalRef) throw new Error('approval_ref_planner_owned_forbidden')
      if (!state.workspaceSnapshot) throw new Error(`ledger_corrupt:${taskId}:workspace_missing`)
      if (!actionHitsCurrentOfferVersion(state.workspaceSnapshot, candidate, this.now())) throw new Error('offer_version_not_loaded')
      let action = candidate
      const availability = reduceAvailabilityAction(state.availability, state.workspaceSnapshot, candidate)
      if (state.awaitingApproval) {
        const approval = state.awaitingApproval
        if (!approval.approval || Date.parse(approval.expiresAt) <= Date.parse(this.now())) throw new Error('approval_expired')
        const ref: RelaxationApprovalRef = {
          approvalId: approval.approval.approvalId, blockerId: approval.blocker.blockerId,
          contextRef: state.contextRef, sourceTurnId: approval.sourceTurnId,
          presentationRequestKey: approval.presentationRequestKey, sourceActionId: approval.blocker.sourceActionId,
          targetActionId: candidate.actionId, sourceRevision: candidate.expectedRevision,
          targetActionKind: candidate.kind, to: approval.approval.to, expiresAt: approval.expiresAt,
          nonce: approval.nonce, sourceReceiptDigest: approval.blocker.sourceReceiptDigest,
          scope: approval.blocker.scope, code: approval.blocker.code, criterionPath: approval.blocker.criterionPath,
          valueDigest: approval.blocker.valueDigest,
        }
        action = { ...candidate, relaxationApprovalRef: ref }
        this.append(APPROVAL_CONSUMED, taskId, { schema: LEDGER_SCHEMA, taskId, contextRef: state.contextRef, approval, ref, approvalDigest: bookingDigest(ref) }, `booking-copilot:approval-consumed:${taskId}:${approval.approval.approvalId}:${approval.nonce}`)
      }
      const eventId = this.idFactory('event'); const emittedAt = this.now(); const sequence = state.lastSequence + 1
      const event = { schemaVersion: 'booking.surface' as const, eventId, taskId, contextRef: state.contextRef, sequence, emittedAt, kind: 'operation' as const, action }
      const eventValidation = validateBookingSurfaceEvent(event)
      if (!eventValidation.ok) throw new Error(`invalid_operation_event:${errorText(eventValidation)}`)
      if (!state.lastTurnId) throw new Error(`ledger_corrupt:${taskId}:turn_id`)
      this.appendAction(taskId, state.contextRef, checkpointFor(action, eventId, sequence, emittedAt, state.lastTurnId), state.operationCount + 1, availability)
      return event
  }

  continueWithReceipt(turn: Extract<BookingCopilotTurn, { kind: 'action.receipt.continuation' }>): BookingCopilotTaskState {
    const validation = validateBookingSurface(turn)
    if (!validation.ok) throw new Error(`invalid_receipt_continuation:${errorText(validation)}`)
    assertWorkspaceLoadedOfferRefsUnique(turn.workspace)
    assertCanonicalReceipt(turn.receipt)
    const run = this.ledger.db.transaction(() => {
      const state = this.requireTask(turn.taskId)
      assertReplayUpgradeReanchored(state)
      if (turn.workspace.contextRef !== state.contextRef || turn.receipt.contextRef !== state.contextRef) throw new Error('context_mismatch')
      const receiptWorkspace = bookingWorkspaceDigest(turn.workspace)
      const receiptWorkspaceSemantic = bookingWorkspaceSemanticDigest(turn.workspace)
      if (!state.workspaceSnapshot || !workspaceBoundaryMatches(state.workspaceSnapshot, turn.workspace)) throw new Error('workspace_mismatch')
      const existing = this.ledger.db.prepare(`SELECT payload FROM events WHERE tenant_id = ? AND run_id = ? AND kind = ? ORDER BY seq`).all(this.ledger.tenant, turn.taskId, RECEIPT) as Array<{ payload: string }>
      const receiptDigest = canonicalReceiptDigest(turn.receipt)
      if (state.legacySuppressedReceiptActionIds?.includes(turn.receipt.actionId)) throw new Error('request_key_invalidated')
      for (const row of existing) {
        const prior = JSON.parse(row.payload) as ReceiptPayload
        if (prior.receipt.actionId !== turn.receipt.actionId) continue
        if (prior.receiptDigest !== receiptDigest) throw new Error('receipt_conflict')
        if (prior.workspaceDigest !== receiptWorkspace) throw new Error('workspace_mismatch')
        return state
      }
      if (state.phase === 'terminal' || state.phase === 'error') throw new Error('task_terminal')
      if (!state.pendingAction) throw new Error('unexpected_receipt')
      if (state.pendingAction.actionId !== turn.receipt.actionId) throw new Error('receipt_action_mismatch')
      if (turn.receipt.revision < state.pendingAction.expectedRevision) throw new Error('revision_regression')
      if (turn.receipt.resultContract.blockers.some((blocker) => blocker.sourceActionId !== state.pendingAction!.actionId)) throw new Error('receipt_source_action_mismatch')
      if (!workspacePostActionMatches(state.workspaceSnapshot, turn.workspace, state.pendingAction, turn.receipt)) throw new Error('workspace_mismatch')
      if (!receiptObservationMatchesAction(turn.receipt.observation.kind, state.pendingAction.kind)) throw new Error('receipt_observation_action_mismatch')
      if (!receiptTargetMatchesAction(turn.receipt, state.pendingAction)) throw new Error('receipt_target_mismatch')
      if (state.pendingAction.kind === 'offer.check' && turn.receipt.status === 'applied' && !verifiedOfferUnexpired(turn.workspace, this.now())) throw new Error('receipt_verified_offer_expired')
      // Failed/stale query receipts may carry a typed gap observation; only an
      // offers.state observation can claim passive offer provenance.
      if (state.pendingAction.kind === 'offers.query' && turn.receipt.observation.kind === 'offers.state') validateOffersReceiptWorkspace(turn.receipt, turn.workspace, state.pendingAction.input.hotelRefs)
      if (turn.receipt.resultContract.relaxationsApplied.some((approval) => !this.approvalWasConsumed(turn.taskId, approval, state.pendingAction!.actionId))) throw new Error('receipt_relaxation_unauthorized')
      const pending = state.pendingAction
      if (turn.receipt.revision !== turn.workspace.revision) throw new Error('revision_mismatch')
      const availability = reduceAvailabilityReceipt(state.availability, turn.workspace, turn.receipt, pending)
      const availabilityTerminal = availabilityPolicyTerminal(availability)
      this.append(RECEIPT, turn.taskId, { schema: LEDGER_SCHEMA, taskId: turn.taskId, contextRef: state.contextRef, receipt: turn.receipt, receiptDigest, operationCount: state.operationCount, workspaceDigest: receiptWorkspace, workspaceSemanticDigest: receiptWorkspaceSemantic, workspace: turn.workspace, availability, availabilityDigest: bookingDigest(availability), ...(availabilityTerminal ? { availabilityTerminal } : {}) }, `booking-copilot:receipt:${turn.taskId}:${turn.receipt.actionId}`)
      if (availabilityTerminal || state.operationCount >= BOOKING_COPILOT_MAX_OPERATIONS) {
        const terminalState = this.requireTask(turn.taskId)
        const terminalEvent = this.terminalEvent(terminalState)
        this.appendTerminalEvent(turn.taskId, terminalEvent)
        this.append(DECISION_BATCH, turn.taskId, { schema: LEDGER_SCHEMA, taskId: turn.taskId, contextRef: state.contextRef, requestKey: `receipt:${turn.receipt.actionId}:${receiptDigest}`, events: [terminalEvent] }, `booking-copilot:decision-batch:${turn.taskId}:receipt:${turn.receipt.actionId}:${receiptDigest}`)
        return terminalState
      }
      const blocker = turn.receipt.resultContract.blockers[0]
      if (blocker) {
        // Never derive this claim from the injectable id factory: production
        // and crash proofs must not make a presentation nonce guessable from
        // deterministic task/event ids.
        const nonce = randomUUID()
        const sourceTurnId = state.pendingAction?.sourceTurnId ?? state.lastTurnId ?? `ordinal:${state.userTurnCount}`
        const requestKey = presentationKey(turn.taskId, sourceTurnId, turn.receipt.actionId, receiptDigest)
        const approval = { blocker, options: [approvalOption(turn.taskId, state.contextRef, sourceTurnId, requestKey, blocker, 'prefer', nonce), approvalOption(turn.taskId, state.contextRef, sourceTurnId, requestKey, blocker, 'drop', nonce)], optionsEmitted: false, approval: undefined as never, nonce, expiresAt: new Date(Date.parse(this.now()) + this.approvalTtlMs).toISOString(), sourceTurnId, presentationRequestKey: requestKey }
        this.append(APPROVAL_GRANTED, turn.taskId, { schema: LEDGER_SCHEMA, taskId: turn.taskId, contextRef: state.contextRef, approval, approvalDigest: bookingDigest(approval) }, `booking-copilot:approval-awaiting:${turn.taskId}:${turn.receipt.actionId}`)
      }
      return this.requireTask(turn.taskId)
    })
    return run.immediate()
  }

  emitEvent(taskId: string, draft: BookingSurfaceEventDraft): Exclude<BookingSurfaceEvent, { kind: 'operation' }> {
    return this.ledger.db.transaction(() => {
      const state = this.requireTask(taskId)
      if (state.phase === 'terminal' || state.phase === 'error') throw new Error('task_terminal')
      assertReplayUpgradeReanchored(state)
      return this.emitEventInTransaction(taskId, draft)
    }).immediate()
  }

  private emitEventInTransaction(taskId: string, draft: BookingSurfaceEventDraft) {
      const state = this.requireTask(taskId)
      assertReplayUpgradeReanchored(state)
      const safeDraft = draft.kind === 'error'
        ? { ...draft, error: { ...draft.error, code: normalizeBookingErrorCode(draft.error.code), message: safeBookingErrorMessage(normalizeBookingErrorCode(draft.error.code)) } }
        : draft
      const event = { schemaVersion: 'booking.surface' as const, eventId: this.idFactory('event'), taskId, contextRef: state.contextRef, sequence: state.lastSequence + 1, emittedAt: this.now(), ...safeDraft } as Exclude<BookingSurfaceEvent, { kind: 'operation' }>
      const checked = validateBookingSurfaceEvent(event)
      if (!checked.ok) throw new Error(`invalid_event:${errorText(checked)}`)
      this.append(EVENT, taskId, { schema: LEDGER_SCHEMA, taskId, contextRef: state.contextRef, eventId: event.eventId, sequence: event.sequence, emittedAt: event.emittedAt, eventKind: event.kind, ...(event.kind === 'status' ? { status: event.status } : {}), contentDigest: bookingDigest(safeDraft) }, `booking-copilot:event:${taskId}:${event.eventId}`)
      return event
  }

  private operationEvent(taskId: string, checkpoint: BookingActionCheckpoint, action: BookingReadAction) {
    const replayAction = action.relaxationApprovalRef || !checkpoint.relaxationApprovalRef ? action : { ...action, relaxationApprovalRef: checkpoint.relaxationApprovalRef }
    return { schemaVersion: 'booking.surface' as const, eventId: checkpoint.eventId, taskId, contextRef: checkpoint.contextRef, sequence: checkpoint.sequence, emittedAt: checkpoint.emittedAt, kind: 'operation' as const, action: replayAction }
  }
  private terminalEvent(state: BookingCopilotTaskState): Extract<BookingSurfaceEvent, { kind: 'terminal' }> {
    if (!taskHasTerminalBudget(state)) throw new Error('task_not_terminal')
    const terminalCode = state.availability.terminal?.code ?? 'operation_limit_reached'
    const event = { schemaVersion: 'booking.surface' as const, eventId: `terminal-${state.taskId}-${state.operationCount}`, taskId: state.taskId, contextRef: state.contextRef, sequence: state.lastSequence + 1, emittedAt: this.now(), kind: 'terminal' as const, terminal: { status: state.availability.terminal?.code === 'availability_confirmed' ? 'completed' as const : 'stopped' as const, summary: terminalCode, factRefs: [] } }
    const checked = validateBookingSurfaceEvent(event)
    if (!checked.ok) throw new Error(`invalid_terminal_event:${errorText(checked)}`)
    return event
  }

  private requireTask(taskId: string): BookingCopilotTaskState { const state = this.resumeTask(taskId); if (!state) throw new Error('task_not_found'); return state }
  private requestBinding(requestKey: string): RequestBindingPayload | null {
    const rows = this.ledger.db.prepare(`SELECT payload FROM events WHERE tenant_id = ? AND kind = ? ORDER BY seq DESC`).all(this.ledger.tenant, REQUEST_BINDING) as Array<{ payload: string }>
    for (const row of rows) {
      const binding = JSON.parse(row.payload) as RequestBindingPayload
      if (binding.requestKey === requestKey) {
        const state = this.resumeTask(binding.taskId)
        if (state?.legacySuppressedRequestBindingKeys?.includes(requestKey)) throw new Error('request_key_invalidated')
        return binding
      }
    }
    return null
  }
  private requestBindingPayload(requestKey: string, turn: UserTurn, input: BookingIngressRequestBindingInput): Omit<RequestBindingPayload, 'schema' | 'taskId' | 'contextRef'> {
    assertPrincipal(input.principal)
    assertRequestKey(requestKey)
    if (input.taskHandle) assertSafeRef(input.taskHandle)
    return {
      requestKey,
      requestDigest: bookingTurnDigest(turn),
      turnId: turn.turnId,
      workspaceDigest: bookingWorkspaceDigest(turn.workspace),
      workspaceSemanticDigest: bookingWorkspaceSemanticDigest(turn.workspace),
      surface: turn.workspace.surface,
      capabilityDigest: bookingDigest(turn.workspace.capabilities),
      principalDigest: bookingDigest({ subject: input.principal.subject }),
      scopeDigest: bookingDigest({ scope: input.principal.scope }),
      ...(input.taskHandle ? { taskHandle: input.taskHandle } : {}),
    }
  }
  private appendRequestBindingInTransaction(requestKey: string, turn: UserTurn, input: BookingIngressRequestBindingInput): void {
    assertRequestKey(requestKey)
    assertPrincipal(input.principal)
    const payload = this.requestBindingPayload(requestKey, turn, input)
    if (input.taskHandle) {
      const prior = this.ledger.db.prepare(`SELECT payload FROM events WHERE tenant_id = ? AND kind = ?`).all(this.ledger.tenant, REQUEST_BINDING) as Array<{ payload: string }>
      for (const row of prior) {
        const binding = JSON.parse(row.payload) as RequestBindingPayload
        if (binding.taskHandle !== input.taskHandle) continue
        if (binding.principalDigest !== payload.principalDigest || binding.scopeDigest !== payload.scopeDigest) throw new Error('principal_conflict')
        if (binding.taskId !== turn.taskId || binding.contextRef !== turn.workspace.contextRef) throw new Error('task_handle_conflict')
      }
    }
    const existing = this.requestBinding(requestKey)
    if (existing) {
      if (existing.taskId !== turn.taskId || existing.contextRef !== turn.workspace.contextRef || existing.requestDigest !== payload.requestDigest || existing.turnId !== payload.turnId || existing.workspaceDigest !== payload.workspaceDigest || existing.workspaceSemanticDigest !== payload.workspaceSemanticDigest || existing.surface !== payload.surface || existing.capabilityDigest !== payload.capabilityDigest || existing.principalDigest !== payload.principalDigest || existing.scopeDigest !== payload.scopeDigest || existing.taskHandle !== payload.taskHandle) throw new Error('request_conflict')
      return
    }
    this.append(REQUEST_BINDING, turn.taskId, { schema: LEDGER_SCHEMA, taskId: turn.taskId, contextRef: turn.workspace.contextRef, ...payload }, `booking-copilot:request-binding:${requestKey}`)
  }
  private normalizeDecisionBatchFromDurableRows(taskId: string, batchEvents: readonly BookingSurfaceEvent[], batchSeq: number): BookingSurfaceEvent[] | null {
    const individualRows = this.ledger.db.prepare(`SELECT kind, payload FROM events WHERE tenant_id = ? AND run_id = ? AND seq < ? AND kind IN (?, ?) ORDER BY seq`).all(this.ledger.tenant, taskId, batchSeq, EVENT, ACTION) as Array<{ kind: string; payload: string }>
    const turnRows = this.ledger.db.prepare(`SELECT payload FROM events WHERE tenant_id = ? AND run_id = ? AND kind = ? AND seq < ?`).all(this.ledger.tenant, taskId, TURN, batchSeq) as Array<{ payload: string }>
    const sourceWorkspaces = new Map<string, BookingWorkspaceSnapshot>()
    for (const row of turnRows) {
      try {
        const turn = JSON.parse(row.payload) as TurnPayload
        sourceWorkspaces.set(turn.turnId, normalizeWorkspaceForReplay(turn.workspace))
      } catch {
        return null
      }
    }
    const recordedEvents = new Map<string, EventPayload>()
    const recordedActions = new Map<string, BookingActionCheckpoint>()
    for (const row of individualRows) {
      if (row.kind === EVENT) {
        const payload = JSON.parse(row.payload) as EventPayload
        const key = consumedIdentityKey(payload.eventId, payload.sequence)
        if (recordedEvents.has(key) || recordedActions.has(key)) return null
        recordedEvents.set(key, payload)
      } else if (row.kind === ACTION) {
        const payload = JSON.parse(row.payload) as ActionPayload
        let action = payload.action
        try {
          action = normalizeActionCheckpointForReplay(action, sourceWorkspaces.get(action.sourceTurnId))
        } catch {
          return null
        }
        const key = consumedIdentityKey(action.eventId, action.sequence)
        if (recordedEvents.has(key) || recordedActions.has(key)) return null
        recordedActions.set(key, action)
      }
    }
    let lastBatchSequence = -1
    const seen = new Set<string>()
    const normalizedEvents: BookingSurfaceEvent[] = []
    for (const event of batchEvents) {
      if (!Number.isSafeInteger(event.sequence) || event.sequence <= lastBatchSequence) return null
      lastBatchSequence = event.sequence
      const key = consumedIdentityKey(event.eventId, event.sequence)
      if (seen.has(key)) return null
      seen.add(key)
      if (event.kind === 'operation') {
        const checkpoint = recordedActions.get(key)
        if (!checkpoint || !operationEventMatchesAction(event, checkpoint)) return null
        const normalized = { ...event, action: actionFromOperationEventForReplay(event, checkpoint) } as BookingSurfaceEvent
        if (!validateBookingSurfaceEvent(normalized).ok) return null
        normalizedEvents.push(normalized)
      } else {
        const recorded = recordedEvents.get(key)
        if (!recorded || !validateBookingSurfaceEvent(event).ok || !eventPayloadMatchesEvent(recorded, event)) return null
        normalizedEvents.push(event)
      }
    }
    return normalizedEvents
  }
  private rows(taskId: string): Row[] { return this.ledger.db.prepare(`SELECT seq, kind, payload FROM events WHERE tenant_id = ? AND run_id = ? AND kind IN (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ORDER BY seq`).all(this.ledger.tenant, taskId, STARTED, TURN, ACTION, RECEIPT, EVENT, APPROVAL_GRANTED, APPROVAL_OFFERED, APPROVAL_CONSUMED, DECISION_BATCH, REQUEST_BINDING) as Row[] }
  private append(kind: string, taskId: string, payload: BasePayload, idemKey: string): void {
    const result = this.ledger.db.prepare(`INSERT OR IGNORE INTO events (tenant_id, ts, actor, kind, subject_id, payload, idem_key, run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(this.ledger.tenant, this.now(), ACTOR, kind, taskId, JSON.stringify(payload), idemKey, taskId)
    if (result.changes === 0) throw new Error(`ledger_write_failed:${kind}`)
  }
  private appendTurn(taskId: string, contextRef: string, requestDigest: string, workspaceDigest: string, workspaceSemanticDigest: string, ordinal: number, turnId: string, workspace?: BookingWorkspaceSnapshot): void { if (!workspace) throw new Error('ledger_write_failed:turn_workspace'); this.append(TURN, taskId, { schema: LEDGER_SCHEMA, taskId, contextRef, requestDigest, workspaceDigest, workspaceSemanticDigest, workspace, turnId }, `booking-copilot:turn:${taskId}:${turnId}`) }
  private appendApproval(taskId: string, contextRef: string, approval: BookingApprovalState): void { this.append(APPROVAL_GRANTED, taskId, { schema: LEDGER_SCHEMA, taskId, contextRef, approval, approvalDigest: bookingDigest(approval) }, `booking-copilot:approval-granted:${taskId}:${approval.approval?.approvalId ?? 'pending'}:${approval.nonce}`) }
  private appendAction(taskId: string, contextRef: string, action: BookingActionCheckpoint, operationCount: number, availability: AvailabilityPolicyState): void { this.append(ACTION, taskId, { schema: LEDGER_SCHEMA, taskId, contextRef, action, operationCount, availability, availabilityDigest: bookingDigest(availability) }, `booking-copilot:action:${taskId}:${action.actionId}`) }
  private appendTerminalEvent(taskId: string, event: Extract<BookingSurfaceEvent, { kind: 'terminal' }>): void {
    const payload: EventPayload = { schema: LEDGER_SCHEMA, taskId, contextRef: event.contextRef, eventId: event.eventId, sequence: event.sequence, emittedAt: event.emittedAt, eventKind: 'terminal', contentDigest: bookingDigest(event.terminal) }
    const idemKey = `booking-copilot:terminal-event:${taskId}`
    const result = this.ledger.db.prepare(`INSERT OR IGNORE INTO events (tenant_id, ts, actor, kind, subject_id, payload, idem_key, run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(this.ledger.tenant, this.now(), ACTOR, EVENT, taskId, JSON.stringify(payload), idemKey, taskId)
    if (result.changes === 0) {
      const existing = this.ledger.db.prepare('SELECT payload FROM events WHERE tenant_id = ? AND idem_key = ?').get(this.ledger.tenant, idemKey) as { payload: string } | undefined
      if (!existing || (JSON.parse(existing.payload) as EventPayload).contentDigest !== payload.contentDigest) throw new Error('ledger_write_failed:terminal_event')
    }
  }
  private ensureApprovalOffered(taskId: string, contextRef: string, approval: BookingApprovalState, requestKey: string): void {
    if (requestKey !== approval.presentationRequestKey) throw new Error('approval_presentation_key_mismatch')
    const idemKey = `booking-copilot:approval-offered:${taskId}:${requestKey}`
    const exists = this.ledger.db.prepare('SELECT 1 AS present FROM events WHERE tenant_id = ? AND idem_key = ?').get(this.ledger.tenant, idemKey) as { present: number } | undefined
    if (!exists) this.append(APPROVAL_OFFERED, taskId, { schema: LEDGER_SCHEMA, taskId, contextRef, approval, approvalDigest: bookingDigest(approval) }, idemKey)
  }
  private approvalWasConsumed(taskId: string, approval: RelaxationApproval, targetActionId: string): boolean {
    const state = this.resumeTask(taskId)
    if (state?.legacySuppressedApprovalTargetActionIds?.includes(targetActionId)) return false
    const rows = this.ledger.db.prepare(`SELECT payload FROM events WHERE tenant_id = ? AND run_id = ? AND kind = ?`).all(this.ledger.tenant, taskId, APPROVAL_CONSUMED) as Array<{ payload: string }>
    return rows.some(({ payload }) => {
      const consumed = JSON.parse(payload) as ApprovalPayload
      return consumed.ref?.targetActionId === targetActionId && consumed.approval?.approval && bookingDigest(consumed.approval.approval) === bookingDigest(approval)
    })
  }
}
