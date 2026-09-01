/** Request adapter for the unified Booking Copilot HTTP/SSE server. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  BOOKING_SURFACE_SCHEMA_V2_SHA256,
  BOOKING_SURFACE_SCHEMA_VERSION_V2,
  type BookingCopilotTurnV2,
  type BookingSurfaceEventV2,
  type BookingWorkspaceSnapshotV2,
} from './contracts-v2.ts'
import {
  BookingCopilotTaskRuntimeV2,
  bookingV2TurnDigest,
  type BookingPlannerSessionFactoryV2,
  type BookingCopilotTaskStateV2,
} from './runtime-v2.ts'
import { validateBookingSurfaceV2 } from './validation-v2.ts'

export interface BookingCopilotV2Adapter {
  runtime: BookingCopilotTaskRuntimeV2
  plannerFactory: BookingPlannerSessionFactoryV2
}

const sessionsByAdapter = new WeakMap<BookingCopilotV2Adapter, Map<string, ReturnType<BookingPlannerSessionFactoryV2>>>()
function sessionsFor(adapter: BookingCopilotV2Adapter): Map<string, ReturnType<BookingPlannerSessionFactoryV2>> {
  let sessions = sessionsByAdapter.get(adapter)
  if (!sessions) { sessions = new Map(); sessionsByAdapter.set(adapter, sessions) }
  return sessions
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
function errorCode(error: unknown): string { return error instanceof Error && error.message ? error.message.split(':', 1)[0]! : 'planner_failed' }

function requestDigest(turn: Extract<BookingCopilotTurnV2, { kind: 'user.turn' | 'user.turn.ingress' }>): string {
  return bookingV2TurnDigest(turn)
}
function sameCapabilities(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().every((kind, index) => kind === [...b].sort()[index])
}

/** Handles one already-authenticated v2 request inside server.ts's sole listener. */
export async function handleBookingCopilotV2Request(req: IncomingMessage, res: ServerResponse, adapter: BookingCopilotV2Adapter, maxBodyBytes: number): Promise<void> {
  let turn: BookingCopilotTurnV2
  try {
    const parsed = JSON.parse(await readBody(req, maxBodyBytes)) as unknown
    const valid = validateBookingSurfaceV2(parsed)
    if (!valid.ok) { send(res, 400, { error: { code: 'invalid_booking_surface_turn', details: valid.errors } }); return }
    turn = parsed as BookingCopilotTurnV2
  } catch (error) { send(res, errorCode(error) === 'payload_too_large' ? 413 : 400, { error: { code: errorCode(error) } }); return }

  let task: BookingCopilotTaskStateV2; let fresh = false; let replayKey: string | undefined; let replayEvents: BookingSurfaceEventV2[] | null = null
  try {
    fresh = turn.kind === 'action.receipt.continuation' ? false : !turn.taskId || adapter.runtime.resumeTask(turn.taskId) === null
    if (turn.kind === 'action.receipt.continuation') {
      replayKey = `receipt:${turn.receipt.actionId}:${adapter.runtime.receiptDigest(turn.receipt)}`
      task = adapter.runtime.continueWithReceipt(turn)
      if (task.awaitingApproval) {
        replayKey = adapter.runtime.approvalPresentationRequestKey(turn.taskId)
      }
      replayEvents = adapter.runtime.readDecisionBatch(turn.taskId, replayKey)
    } else {
      const existing = turn.taskId ? adapter.runtime.resumeTask(turn.taskId) : null
      if (existing?.phase === 'waiting_receipt') {
        const workspace = turn.workspace as BookingWorkspaceSnapshotV2
        if (turn.kind === 'user.turn.ingress') {
          if (!turn.turnId || existing.lastTurnId !== turn.turnId || existing.lastUserTurnDigest !== requestDigest(turn)) throw new Error('receipt_required')
        } else {
          if (workspace.contextRef !== existing.contextRef || workspace.surface !== existing.surface || workspace.revision !== existing.revision || workspace.capabilities.surface !== existing.surface || !sameCapabilities(workspace.capabilities.allowedActions, existing.allowedActions)) throw new Error('task_conflict:workspace_mismatch')
          // A waiting task can only be replayed with the caller's stable
          // ingress identity.  Without it, an identical sentence is not
          // distinguishable from a new user turn and must not receive the old
          // operation batch by ordinal/text coincidence.
          if (!turn.turnId || existing.lastTurnId !== turn.turnId) throw new Error('receipt_required')
          if (existing.lastUserTurnDigest !== requestDigest(turn)) throw new Error('receipt_required')
        }
        replayKey = `turn:${existing.taskId}:${existing.lastTurnId ?? existing.userTurnCount}`
        replayEvents = adapter.runtime.readDecisionBatch(existing.taskId, replayKey)
        if (!replayEvents) throw new Error('receipt_required')
        task = existing
      } else {
        task = adapter.runtime.startTask(turn)
        if ((turn.kind === 'user.turn' || turn.kind === 'user.turn.ingress') && turn.taskId) {
          replayKey = `turn:${task.taskId}:${turn.turnId ?? task.userTurnCount}`
          replayEvents = adapter.runtime.readDecisionBatch(task.taskId, replayKey)
        }
      }
    }
  } catch (error) { send(res, 409, { error: { code: errorCode(error) } }); return }

  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-content-type-options': 'nosniff', 'x-booking-surface-version': BOOKING_SURFACE_SCHEMA_VERSION_V2, 'x-booking-surface-schema-sha256': BOOKING_SURFACE_SCHEMA_V2_SHA256 })
  try {
    if (replayEvents) {
      for (const event of replayEvents) write(res, event)
    } else {
      const requestKey = replayKey ?? `turn:${task.taskId}:${task.userTurnCount}`
      let decisionEvents: BookingSurfaceEventV2[]
      if (turn.kind === 'action.receipt.continuation' && task.awaitingApproval) {
        decisionEvents = adapter.runtime.applyDecisionBatch(task.taskId, requestKey, [adapter.runtime.approvalQuestion(task.taskId)], false)
      } else {
        const sessions = sessionsFor(adapter)
        const session = sessions.get(task.taskId) ?? adapter.plannerFactory(task)
        sessions.set(task.taskId, session)
        const plannerTurn = turn.kind === 'user.turn.ingress' ? adapter.runtime.bindIngressTurn(turn, task) : turn
        const decisions = await session.next({ turn: plannerTurn, task: adapter.runtime.resumeTask(task.taskId) ?? task })
        const plannerDecisions = decisions.length ? decisions : [{ kind: 'error' as const, error: { code: 'PLANNER_NO_DECISION', message: 'Planner returned no typed decision.', retryable: false } }]
        decisionEvents = adapter.runtime.applyDecisionBatch(task.taskId, requestKey, plannerDecisions, fresh)
      }
      for (const event of decisionEvents) write(res, event)
    }
  } catch (error) {
    try { write(res, adapter.runtime.emitEvent(task.taskId, { kind: 'error', error: { code: errorCode(error), message: error instanceof Error ? error.message : 'planner_failed', retryable: false } })) } catch { /* committed stream: close honestly */ }
  } finally { res.end() }
}
