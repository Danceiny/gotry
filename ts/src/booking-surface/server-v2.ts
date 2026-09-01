/** Request adapter for the unified Booking Copilot HTTP/SSE server. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  BOOKING_SURFACE_SCHEMA_V2_SHA256,
  BOOKING_SURFACE_SCHEMA_VERSION_V2,
  BOOKING_READ_ACTION_KINDS_V2,
  BOOKING_SURFACE_ALLOWED_ACTIONS_V2,
  type BookingCopilotTurnV2,
  type BookingIngressBindingV2,
  type BookingIngressPrincipalV2,
  type IngressTurnV2,
  type UserTurnV2,
  type BookingSurfaceEventV2,
  type BookingWorkspaceSnapshotV2,
} from './contracts-v2.ts'
import {
  BookingCopilotTaskRuntimeV2,
  type BookingPlannerSessionFactoryV2,
  type BookingCopilotTaskStateV2,
  type BookingIngressRequestBindingInputV2,
} from './runtime-v2.ts'
import { validateBookingSurfaceV2 } from './validation-v2.ts'
import { normalizeBookingErrorCode, safeBookingErrorMessage } from './error-codes.ts'

export interface BookingCopilotV2Adapter {
  runtime: BookingCopilotTaskRuntimeV2
  plannerFactory: BookingPlannerSessionFactoryV2
  /** BFF-owned identity binding. GoTry never accepts browser task/turn/context identity. */
  ingressBinding?: BookingIngressBindingV2
  /** Principal authenticated by the HotelByte BFF, never by browser input. */
  principal?: BookingIngressPrincipalV2
}

const sessionsByAdapter = new WeakMap<BookingCopilotV2Adapter, Map<string, ReturnType<BookingPlannerSessionFactoryV2>>>()
const decisionFlightsByAdapter = new WeakMap<BookingCopilotV2Adapter, Map<string, Promise<BookingSurfaceEventV2[]>>>()
function sessionsFor(adapter: BookingCopilotV2Adapter): Map<string, ReturnType<BookingPlannerSessionFactoryV2>> {
  let sessions = sessionsByAdapter.get(adapter)
  if (!sessions) { sessions = new Map(); sessionsByAdapter.set(adapter, sessions) }
  return sessions
}
function decisionFlightsFor(adapter: BookingCopilotV2Adapter): Map<string, Promise<BookingSurfaceEventV2[]>> {
  let flights = decisionFlightsByAdapter.get(adapter)
  if (!flights) { flights = new Map(); decisionFlightsByAdapter.set(adapter, flights) }
  return flights
}
async function runDecisionSingleFlight(adapter: BookingCopilotV2Adapter, key: string, work: () => Promise<BookingSurfaceEventV2[]>): Promise<BookingSurfaceEventV2[]> {
  const flights = decisionFlightsFor(adapter)
  const prior = flights.get(key)
  if (prior) return prior
  const current = work()
  flights.set(key, current)
  try { return await current } finally { if (flights.get(key) === current) flights.delete(key) }
}

function send(res: ServerResponse, status: number, body: unknown): void { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)) }
function readBody(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0; let tooLarge = false
    req.on('data', (chunk: Buffer) => { size += chunk.length; if (size > max) tooLarge = true; else chunks.push(chunk) })
    req.on('end', () => tooLarge ? reject(new Error('payload_too_large')) : resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
function write(res: ServerResponse, event: BookingSurfaceEventV2): void { res.write(`event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`) }
export { normalizeBookingErrorCode as bookingPlannerErrorCode, safeBookingErrorMessage as bookingPlannerErrorMessage } from './error-codes.ts'

function sameCapabilities(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().every((kind, index) => kind === [...b].sort()[index])
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).length === allowed.length && Object.keys(value).every((key) => allowed.includes(key))
}

const SURFACE_ACTION_MATRIX: Record<BookingWorkspaceSnapshotV2['surface'], readonly string[]> = BOOKING_SURFACE_ALLOWED_ACTIONS_V2

function validIngressBinding(binding: unknown, ingress: IngressTurnV2): binding is {
  taskId: string
  turnId: string
  contextRef: string
  surface: BookingWorkspaceSnapshotV2['surface']
  allowedActions: BookingWorkspaceSnapshotV2['capabilities']['allowedActions']
} {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return false
  const candidate = binding as Record<string, unknown>
  if (!exactKeys(candidate, ['taskId', 'turnId', 'contextRef', 'surface', 'allowedActions'])) return false
  if (typeof candidate.taskId !== 'string' || typeof candidate.turnId !== 'string' || typeof candidate.contextRef !== 'string') return false
  if (typeof candidate.surface !== 'string' || candidate.surface !== ingress.surfaceHint || !Object.prototype.hasOwnProperty.call(SURFACE_ACTION_MATRIX, candidate.surface)) return false
  if (!Array.isArray(candidate.allowedActions) || candidate.allowedActions.length < 1) return false
  const allowed = candidate.allowedActions as unknown[]
  const matrix = SURFACE_ACTION_MATRIX[candidate.surface as BookingWorkspaceSnapshotV2['surface']]
  return new Set(allowed).size === allowed.length && allowed.every((action) => typeof action === 'string' && matrix.includes(action) && (BOOKING_READ_ACTION_KINDS_V2 as readonly string[]).includes(action))
}

function fallbackErrorEvent(task: BookingCopilotTaskStateV2, code: string): BookingSurfaceEventV2 {
  return {
    schemaVersion: BOOKING_SURFACE_SCHEMA_VERSION_V2,
    eventId: `error-${task.taskId}-${task.lastSequence + 1}`,
    taskId: task.taskId,
    contextRef: task.contextRef,
    sequence: task.lastSequence + 1,
    emittedAt: new Date().toISOString(),
    kind: 'error',
    error: { code: normalizeBookingErrorCode(code), message: safeBookingErrorMessage(normalizeBookingErrorCode(code)), retryable: false },
  }
}

function writeTypedError(res: ServerResponse, adapter: BookingCopilotV2Adapter, task: BookingCopilotTaskStateV2, error: unknown, requestKey?: string, includeSubmitted = false): void {
  const code = normalizeBookingErrorCode(error)
  try {
    const decision = { kind: 'error' as const, error: { code, message: safeBookingErrorMessage(code), retryable: false } }
    if (requestKey) {
      const events = adapter.runtime.applyDecisionBatch(task.taskId, requestKey, [decision], includeSubmitted)
      for (const event of events) write(res, event)
      return
    }
    write(res, adapter.runtime.emitEvent(task.taskId, decision))
  } catch {
    // The stream is already committed. Emit a schema-valid, non-durable
    // typed envelope instead of silently returning an empty HTTP 200 stream.
    write(res, fallbackErrorEvent(task, code))
  }
}

/** Handles one already-authenticated v2 request inside server.ts's sole listener. */
export async function handleBookingCopilotV2Request(req: IncomingMessage, res: ServerResponse, adapter: BookingCopilotV2Adapter, maxBodyBytes: number): Promise<void> {
  let turn: Exclude<BookingCopilotTurnV2, IngressTurnV2>
  let browserRequestKey: string | undefined
  let requestBinding: BookingIngressRequestBindingInputV2 | undefined
  try {
    const parsed = JSON.parse(await readBody(req, maxBodyBytes)) as unknown
    const valid = validateBookingSurfaceV2(parsed)
    if (!valid.ok) { send(res, 400, { error: { code: 'invalid_booking_surface_turn', details: valid.errors } }); return }
    if ((parsed as BookingCopilotTurnV2).kind === 'user.turn.ingress') {
      const ingress = parsed as IngressTurnV2
      browserRequestKey = ingress.requestKey
      if (!adapter.ingressBinding || !adapter.principal) { send(res, 503, { error: { code: 'trusted_ingress_binding_required' } }); return }
      const binding = await adapter.ingressBinding.bind(ingress, adapter.principal)
      if (!validIngressBinding(binding, ingress)) { send(res, 502, { error: { code: 'invalid_ingress_binding' } }); return }
      const boundWorkspace = {
        ...ingress.workspace,
        contextRef: binding.contextRef,
        surface: binding.surface,
        capabilities: { surface: binding.surface, allowedActions: [...binding.allowedActions] },
      } as BookingWorkspaceSnapshotV2
      turn = { schemaVersion: 'booking.surface.v2', kind: 'user.turn', taskId: binding.taskId, turnId: binding.turnId, workspace: boundWorkspace, request: ingress.request }
      requestBinding = { requestKey: ingress.requestKey, principal: adapter.principal, ...(ingress.taskHandle ? { taskHandle: ingress.taskHandle } : {}) }
      const boundValid = validateBookingSurfaceV2(turn)
      if (!boundValid.ok) { send(res, 502, { error: { code: 'invalid_ingress_binding', details: boundValid.errors } }); return }
    } else {
      turn = parsed as Exclude<BookingCopilotTurnV2, IngressTurnV2>
    }
  } catch (error) { const code = normalizeBookingErrorCode(error); send(res, code === 'PAYLOAD_TOO_LARGE' ? 413 : 400, { error: { code } }); return }

  let task: BookingCopilotTaskStateV2; let fresh = false; let replayKey: string | undefined; let replayEvents: BookingSurfaceEventV2[] | null = null; let activeDecisionKey: string | undefined
  try {
    fresh = turn.kind === 'action.receipt.continuation' ? false : !turn.taskId || adapter.runtime.resumeTask(turn.taskId) === null
    if (turn.kind === 'action.receipt.continuation') {
      replayKey = `receipt:${turn.receipt.actionId}:${adapter.runtime.receiptDigest(turn.receipt)}`
      task = adapter.runtime.continueWithReceipt(turn)
      if (task.awaitingApproval) {
        replayKey = adapter.runtime.approvalPresentationRequestKey(turn.taskId)
      }
      replayEvents = adapter.runtime.readDecisionBatch(turn.taskId, replayKey)
      if (!replayEvents && task.phase === 'terminal') replayEvents = adapter.runtime.terminalDecisionBatch(turn.taskId, replayKey)
    } else {
      const existing = turn.taskId ? adapter.runtime.resumeTask(turn.taskId) : null
      if (requestBinding && turn.kind === 'user.turn') adapter.runtime.assertRequestBinding(browserRequestKey!, turn, requestBinding)
      const requestReplayKey = existing && browserRequestKey ? `ingress:${existing.taskId}:${browserRequestKey}` : undefined
      const directReplayKey = existing && turn.kind === 'user.turn' && turn.turnId ? `turn:${existing.taskId}:${turn.turnId}` : undefined
      const stableReplayKey = requestReplayKey ?? directReplayKey
      const stableReplay = stableReplayKey ? adapter.runtime.readDecisionBatch(existing!.taskId, stableReplayKey) : null
      if (stableReplay) {
        if (existing && turn.kind === 'user.turn' && directReplayKey) adapter.runtime.assertTurnBinding(existing.taskId, turn)
        task = existing!
        replayKey = stableReplayKey
        replayEvents = stableReplay
      } else if (existing?.phase === 'terminal' || existing?.phase === 'error') {
        throw new Error('task_terminal')
      } else if (existing?.phase === 'waiting_receipt') {
        const workspace = turn.workspace as BookingWorkspaceSnapshotV2
        if (workspace.contextRef !== existing.contextRef || workspace.surface !== existing.surface || workspace.revision !== existing.revision || workspace.capabilities.surface !== existing.surface || !sameCapabilities(workspace.capabilities.allowedActions, existing.allowedActions)) throw new Error('task_conflict:workspace_mismatch')
        // A waiting task can only be replayed with the caller's stable turn
        // identity. Without it, an identical sentence is not distinguishable
        // from a new user turn and must not receive an old operation batch.
        if (!turn.turnId || existing.lastTurnId !== turn.turnId) throw new Error('receipt_required')
        replayKey = browserRequestKey ? `ingress:${existing.taskId}:${browserRequestKey}` : `turn:${existing.taskId}:${existing.lastTurnId ?? existing.userTurnCount}`
        replayEvents = adapter.runtime.readDecisionBatch(existing.taskId, replayKey)
        if (!replayEvents) throw new Error('receipt_required')
        task = existing
      } else {
        task = adapter.runtime.startTask(turn, requestBinding)
        if (turn.kind === 'user.turn' && turn.taskId) {
          replayKey = browserRequestKey ? `ingress:${task.taskId}:${browserRequestKey}` : `turn:${task.taskId}:${turn.turnId ?? task.userTurnCount}`
          replayEvents = adapter.runtime.readDecisionBatch(task.taskId, replayKey)
        }
      }
    }
  } catch (error) { send(res, 409, { error: { code: normalizeBookingErrorCode(error) } }); return }

  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-content-type-options': 'nosniff', 'x-booking-surface-version': BOOKING_SURFACE_SCHEMA_VERSION_V2, 'x-booking-surface-schema-sha256': BOOKING_SURFACE_SCHEMA_V2_SHA256 })
  try {
    if (replayEvents) {
      for (const event of replayEvents) write(res, event)
    } else {
      const requestKey = replayKey ?? `turn:${task.taskId}:${task.userTurnCount}`
      activeDecisionKey = requestKey
      const flightKey = JSON.stringify([task.taskId, requestKey])
      const decisionEvents = await runDecisionSingleFlight(adapter, flightKey, async () => {
        if (turn.kind === 'action.receipt.continuation' && task.awaitingApproval) {
          return adapter.runtime.applyDecisionBatch(task.taskId, requestKey, [adapter.runtime.approvalQuestion(task.taskId)], false)
        }
        const sessions = sessionsFor(adapter)
        const session = sessions.get(task.taskId) ?? adapter.plannerFactory(task)
        sessions.set(task.taskId, session)
        const decisions = await session.next({ turn, task: adapter.runtime.resumeTask(task.taskId) ?? task })
        const plannerDecisions = decisions.length ? decisions : [{ kind: 'error' as const, error: { code: 'PLANNER_NO_DECISION', message: 'Planner returned no typed decision.', retryable: false } }]
        return adapter.runtime.applyDecisionBatch(task.taskId, requestKey, plannerDecisions, fresh)
      })
      for (const event of decisionEvents) write(res, event)
    }
  } catch (error) {
    writeTypedError(res, adapter, task, error, activeDecisionKey, fresh)
  } finally { res.end() }
}
