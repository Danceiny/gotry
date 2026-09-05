/**
 * BFF-only HTTP/SSE seam for the embedded Booking Copilot.
 *
 * The browser never calls this server directly. A same-origin HotelByte BFF
 * authenticates the actor, mints contextRef and sends a strict planner turn
 * with a deployment-level Bearer key. No portal token field exists here.
 */

import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  BOOKING_COPILOT_ACCEPTED_TURN_KINDS,
  BOOKING_COPILOT_INGRESS_MODES,
  BOOKING_READ_ACTION_KINDS,
  BOOKING_SURFACE_ALLOWED_ACTIONS,
  BOOKING_SURFACE_SCHEMA_SHA256,
  BOOKING_SURFACE_SCHEMA_SHA256_HEADER,
  BOOKING_SURFACE_SCHEMA_VERSION,
  BOOKING_SURFACE_VERSION_HEADER,
  type BookingCopilotIngressMode,
  type BookingCopilotTurn,
  type BookingIngressBinding,
  type BookingIngressPrincipal,
  type BookingReadActionKind,
  type BookingSurfaceEvent,
  type BookingWorkspaceSnapshot,
  type IngressTurn,
} from './contracts.ts'
import {
  BookingCopilotTaskRuntime,
  type BookingCopilotTaskState,
  type BookingIngressRequestBindingInput,
  type BookingPlannerSessionFactory,
} from './runtime.ts'
import { validateBookingSurface } from './validation.ts'
import { normalizeBookingErrorCode, safeBookingErrorMessage } from './error-codes.ts'

export interface BookingCopilotComposition {
  runtime: BookingCopilotTaskRuntime
  plannerFactory: BookingPlannerSessionFactory
  /** Optional BFF-owned identity binding. GoTry never accepts browser identity. */
  ingressBinding?: BookingIngressBinding
  /** Principal authenticated by the HotelByte BFF, never by browser input. */
  principal?: BookingIngressPrincipal
  /** Explicit process composition mode; omitted means infer from a complete pair. */
  ingressMode?: BookingCopilotIngressMode
}

export interface BookingCopilotServerOptions extends BookingCopilotComposition {
  /** Deployment credential shared only with the HotelByte BFF. */
  apiKey: string
  host?: string
  port?: number
  maxBodyBytes?: number
  /** GoTry source commit loaded from the root-owned release artifact. */
  artifactId?: string
}

export interface BookingCopilotServerHandle {
  server: Server
  port: number
  close(): Promise<void>
}

interface BookingCopilotRuntimeIdentity {
  nodeVersion: string
  nodeModulesAbi: string
  releaseTuple: string
  glibcVersion: string
}

const sessionsByComposition = new WeakMap<BookingCopilotComposition, Map<string, ReturnType<BookingPlannerSessionFactory>>>()
const decisionFlightsByComposition = new WeakMap<BookingCopilotComposition, Map<string, Promise<BookingSurfaceEvent[]>>>()
function sessionsFor(composition: BookingCopilotComposition): Map<string, ReturnType<BookingPlannerSessionFactory>> {
  let sessions = sessionsByComposition.get(composition)
  if (!sessions) { sessions = new Map(); sessionsByComposition.set(composition, sessions) }
  return sessions
}
function decisionFlightsFor(composition: BookingCopilotComposition): Map<string, Promise<BookingSurfaceEvent[]>> {
  let flights = decisionFlightsByComposition.get(composition)
  if (!flights) { flights = new Map(); decisionFlightsByComposition.set(composition, flights) }
  return flights
}
async function runDecisionSingleFlight(composition: BookingCopilotComposition, key: string, work: () => Promise<BookingSurfaceEvent[]>): Promise<BookingSurfaceEvent[]> {
  const flights = decisionFlightsFor(composition)
  const prior = flights.get(key)
  if (prior) return prior
  const current = work()
  flights.set(key, current)
  try { return await current } finally { if (flights.get(key) === current) flights.delete(key) }
}

function runtimeIdentity(): BookingCopilotRuntimeIdentity {
  const report = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined
  const header = report?.header
  const glibcVersion = header?.glibcVersionRuntime ?? ''
  return {
    nodeVersion: process.version,
    nodeModulesAbi: process.versions.modules ?? '',
    releaseTuple: `${process.platform}-${process.arch}-${glibcVersion ? 'glibc' : 'unknown'}`,
    glibcVersion,
  }
}

function safeSecretEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expected)
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage, maxBodyBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let exceeded = false
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBodyBytes) {
        exceeded = true
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => exceeded ? reject(new Error('payload_too_large')) : resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function write(res: ServerResponse, event: BookingSurfaceEvent): void {
  res.write(`event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`)
}

function sameCapabilities(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().every((kind, index) => kind === [...b].sort()[index])
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).length === allowed.length && Object.keys(value).every((key) => allowed.includes(key))
}

const SURFACE_ACTION_MATRIX = BOOKING_SURFACE_ALLOWED_ACTIONS

function validSurfaceActions(surface: unknown, allowed: unknown): allowed is BookingWorkspaceSnapshot['capabilities']['allowedActions'] {
  if (typeof surface !== 'string' || !Object.prototype.hasOwnProperty.call(SURFACE_ACTION_MATRIX, surface)) return false
  if (!Array.isArray(allowed) || allowed.length < 1 || new Set(allowed).size !== allowed.length) return false
  const matrix = SURFACE_ACTION_MATRIX[surface as BookingWorkspaceSnapshot['surface']]
  return allowed.every((action) => typeof action === 'string'
    && matrix.includes(action as BookingReadActionKind)
    && (BOOKING_READ_ACTION_KINDS as readonly string[]).includes(action))
}

function validBoundWorkspaceAuthority(workspace: BookingWorkspaceSnapshot): boolean {
  return workspace.capabilities.surface === workspace.surface
    && validSurfaceActions(workspace.surface, workspace.capabilities.allowedActions)
}

function validIngressBinding(binding: unknown, ingress: IngressTurn): binding is {
  taskId: string
  turnId: string
  contextRef: string
  surface: BookingWorkspaceSnapshot['surface']
  allowedActions: BookingWorkspaceSnapshot['capabilities']['allowedActions']
} {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return false
  const candidate = binding as Record<string, unknown>
  if (!exactKeys(candidate, ['taskId', 'turnId', 'contextRef', 'surface', 'allowedActions'])) return false
  if (typeof candidate.taskId !== 'string' || typeof candidate.turnId !== 'string' || typeof candidate.contextRef !== 'string') return false
  if (typeof candidate.surface !== 'string' || candidate.surface !== ingress.surfaceHint || !Object.prototype.hasOwnProperty.call(SURFACE_ACTION_MATRIX, candidate.surface)) return false
  return validSurfaceActions(candidate.surface, candidate.allowedActions)
}

function fallbackErrorEvent(task: BookingCopilotTaskState, code: string): BookingSurfaceEvent {
  return {
    schemaVersion: BOOKING_SURFACE_SCHEMA_VERSION,
    eventId: `error-${task.taskId}-${task.lastSequence + 1}`,
    taskId: task.taskId,
    contextRef: task.contextRef,
    sequence: task.lastSequence + 1,
    emittedAt: new Date().toISOString(),
    kind: 'error',
    error: { code: normalizeBookingErrorCode(code), message: safeBookingErrorMessage(normalizeBookingErrorCode(code)), retryable: false },
  }
}

function writeTypedError(res: ServerResponse, composition: BookingCopilotComposition, task: BookingCopilotTaskState, error: unknown, requestKey?: string, includeSubmitted = false): void {
  const code = normalizeBookingErrorCode(error)
  // Operator-side diagnosability only: the raw boundary error stays on the
  // server stderr/journal; clients keep receiving the safe typed vocabulary.
  console.error(`[booking-copilot] planner boundary error (${code}):`, error instanceof Error ? error.stack || error.message : error)
  try {
    const decision = { kind: 'error' as const, error: { code, message: safeBookingErrorMessage(code), retryable: false } }
    if (requestKey) {
      const events = composition.runtime.applyDecisionBatch(task.taskId, requestKey, [decision], includeSubmitted)
      for (const event of events) write(res, event)
      return
    }
    write(res, composition.runtime.emitEvent(task.taskId, decision))
  } catch {
    // The stream is already committed. Emit a schema-valid, non-durable
    // typed envelope instead of silently returning an empty HTTP 200 stream.
    write(res, fallbackErrorEvent(task, code))
  }
}

/** Handles one already-authenticated request inside the sole HTTP listener. */
async function handleBookingCopilotRequest(req: IncomingMessage, res: ServerResponse, composition: BookingCopilotComposition, maxBodyBytes: number): Promise<void> {
  let turn: Exclude<BookingCopilotTurn, IngressTurn>
  let browserRequestKey: string | undefined
  let requestBinding: BookingIngressRequestBindingInput | undefined
  try {
    const parsed = JSON.parse(await readBody(req, maxBodyBytes)) as unknown
    const valid = validateBookingSurface(parsed)
    if (!valid.ok) { sendJson(res, 400, { error: { code: 'invalid_booking_surface_turn', details: valid.errors } }); return }
    if ((parsed as BookingCopilotTurn).kind === 'user.turn.ingress') {
      const ingress = parsed as IngressTurn
      browserRequestKey = ingress.requestKey
      if (composition.ingressMode !== 'bff-ingress-binding' || !composition.ingressBinding || !composition.principal) {
        sendJson(res, 503, { error: { code: 'trusted_ingress_binding_required', mode: composition.ingressMode ?? 'bff-bound-turn-only', acceptedTurnKinds: [...BOOKING_COPILOT_ACCEPTED_TURN_KINDS] } })
        return
      }
      const binding = await composition.ingressBinding.bind(ingress, composition.principal)
      if (!validIngressBinding(binding, ingress)) { sendJson(res, 502, { error: { code: 'invalid_ingress_binding' } }); return }
      const boundWorkspace = {
        ...ingress.workspace,
        contextRef: binding.contextRef,
        surface: binding.surface,
        capabilities: { surface: binding.surface, allowedActions: [...binding.allowedActions] },
      } as BookingWorkspaceSnapshot
      turn = { schemaVersion: BOOKING_SURFACE_SCHEMA_VERSION, kind: 'user.turn', taskId: binding.taskId, turnId: binding.turnId, workspace: boundWorkspace, request: ingress.request }
      requestBinding = { requestKey: ingress.requestKey, principal: composition.principal, ...(ingress.taskHandle ? { taskHandle: ingress.taskHandle } : {}) }
      const boundValid = validateBookingSurface(turn)
      if (!boundValid.ok) { sendJson(res, 502, { error: { code: 'invalid_ingress_binding', details: boundValid.errors } }); return }
    } else {
      turn = parsed as Exclude<BookingCopilotTurn, IngressTurn>
      if (!validBoundWorkspaceAuthority(turn.workspace)) {
        sendJson(res, 403, { error: { code: 'invalid_bound_turn_authority' } })
        return
      }
    }
  } catch (error) { const code = normalizeBookingErrorCode(error); sendJson(res, code === 'PAYLOAD_TOO_LARGE' ? 413 : 400, { error: { code } }); return }

  let task: BookingCopilotTaskState; let fresh = false; let replayKey: string | undefined; let replayEvents: BookingSurfaceEvent[] | null = null; let activeDecisionKey: string | undefined
  try {
    fresh = turn.kind === 'action.receipt.continuation' ? false : !turn.taskId || composition.runtime.resumeTask(turn.taskId) === null
    if (turn.kind === 'action.receipt.continuation') {
      replayKey = `receipt:${turn.receipt.actionId}:${composition.runtime.receiptDigest(turn.receipt)}`
      task = composition.runtime.continueWithReceipt(turn)
      if (task.awaitingApproval) {
        replayKey = composition.runtime.approvalPresentationRequestKey(turn.taskId)
      }
      replayEvents = composition.runtime.readDecisionBatch(turn.taskId, replayKey)
      if (!replayEvents && task.phase === 'terminal') replayEvents = composition.runtime.terminalDecisionBatch(turn.taskId, replayKey)
    } else {
      const existing = turn.taskId ? composition.runtime.resumeTask(turn.taskId) : null
      if (requestBinding && turn.kind === 'user.turn') composition.runtime.assertRequestBinding(browserRequestKey!, turn, requestBinding)
      const requestReplayKey = existing && browserRequestKey ? `ingress:${existing.taskId}:${browserRequestKey}` : undefined
      const directReplayKey = existing && turn.kind === 'user.turn' && turn.turnId ? `turn:${existing.taskId}:${turn.turnId}` : undefined
      const stableReplayKey = requestReplayKey ?? directReplayKey
      const stableReplay = stableReplayKey ? composition.runtime.readDecisionBatch(existing!.taskId, stableReplayKey) : null
      if (stableReplay) {
        if (existing && turn.kind === 'user.turn' && directReplayKey) composition.runtime.assertTurnBinding(existing.taskId, turn)
        task = existing!
        replayKey = stableReplayKey
        replayEvents = stableReplay
      } else if (existing?.phase === 'terminal' || existing?.phase === 'error') {
        throw new Error('task_terminal')
      } else if (existing?.phase === 'waiting_receipt') {
        const workspace = turn.workspace as BookingWorkspaceSnapshot
        if (workspace.contextRef !== existing.contextRef || workspace.surface !== existing.surface || workspace.revision !== existing.revision || workspace.capabilities.surface !== existing.surface || !sameCapabilities(workspace.capabilities.allowedActions, existing.allowedActions)) throw new Error('task_conflict:workspace_mismatch')
        // A waiting task can only be replayed with the caller's stable turn
        // identity. Without it, an identical sentence is not distinguishable
        // from a new user turn and must not receive an old operation batch.
        if (!turn.turnId || existing.lastTurnId !== turn.turnId) throw new Error('receipt_required')
        replayKey = browserRequestKey ? `ingress:${existing.taskId}:${browserRequestKey}` : `turn:${existing.taskId}:${existing.lastTurnId ?? existing.userTurnCount}`
        replayEvents = composition.runtime.readDecisionBatch(existing.taskId, replayKey)
        if (!replayEvents) throw new Error('receipt_required')
        task = existing
      } else {
        task = composition.runtime.startTask(turn, requestBinding)
        if (turn.kind === 'user.turn' && turn.taskId) {
          replayKey = browserRequestKey ? `ingress:${task.taskId}:${browserRequestKey}` : `turn:${task.taskId}:${turn.turnId ?? task.userTurnCount}`
          replayEvents = composition.runtime.readDecisionBatch(task.taskId, replayKey)
        }
      }
    }
  } catch (error) { sendJson(res, 409, { error: { code: normalizeBookingErrorCode(error) } }); return }

  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-content-type-options': 'nosniff', [BOOKING_SURFACE_VERSION_HEADER]: BOOKING_SURFACE_SCHEMA_VERSION, [BOOKING_SURFACE_SCHEMA_SHA256_HEADER]: BOOKING_SURFACE_SCHEMA_SHA256 })
  try {
    if (replayEvents) {
      for (const event of replayEvents) write(res, event)
    } else {
      const requestKey = replayKey ?? `turn:${task.taskId}:${task.userTurnCount}`
      activeDecisionKey = requestKey
      const flightKey = JSON.stringify([task.taskId, requestKey])
      const decisionEvents = await runDecisionSingleFlight(composition, flightKey, async () => {
        if (turn.kind === 'action.receipt.continuation' && task.awaitingApproval) {
          return composition.runtime.applyDecisionBatch(task.taskId, requestKey, [composition.runtime.approvalQuestion(task.taskId)], false)
        }
        const sessions = sessionsFor(composition)
        const session = sessions.get(task.taskId) ?? composition.plannerFactory(task)
        sessions.set(task.taskId, session)
        const decisions = await session.next({ turn, task: composition.runtime.resumeTask(task.taskId) ?? task })
        const plannerDecisions = decisions.length ? decisions : [{ kind: 'error' as const, error: { code: 'PLANNER_NO_DECISION', message: 'Planner returned no typed decision.', retryable: false } }]
        return composition.runtime.applyDecisionBatch(task.taskId, requestKey, plannerDecisions, fresh)
      })
      for (const event of decisionEvents) write(res, event)
    }
  } catch (error) {
    writeTypedError(res, composition, task, error, activeDecisionKey, fresh)
  } finally { res.end() }
}

export function startBookingCopilotServer(options: BookingCopilotServerOptions): Promise<BookingCopilotServerHandle> {
  if (!options.apiKey) return Promise.reject(new Error('booking_copilot_api_key_required'))
  if (options.artifactId !== undefined && !/^[0-9a-f]{40}$/.test(options.artifactId)) {
    return Promise.reject(new Error('booking_copilot_artifact_id_invalid'))
  }
  if (!options.runtime || !options.plannerFactory) {
    return Promise.reject(new Error('booking_copilot_runtime_and_planner_required'))
  }
  const hasIngressBinding = Boolean(options.ingressBinding)
  const hasPrincipal = Boolean(options.principal)
  if (hasIngressBinding !== hasPrincipal) {
    return Promise.reject(new Error('booking_copilot_ingress_binding_pair_required'))
  }
  if (hasIngressBinding && (typeof options.ingressBinding?.bind !== 'function'
    || typeof options.principal?.subject !== 'string' || options.principal.subject.length === 0 || options.principal.subject.length > 256
    || typeof options.principal?.scope !== 'string' || options.principal.scope.length === 0 || options.principal.scope.length > 256)) {
    return Promise.reject(new Error('booking_copilot_ingress_binding_invalid'))
  }
  const ingressMode: BookingCopilotIngressMode = options.ingressMode ?? (hasIngressBinding ? 'bff-ingress-binding' : 'bff-bound-turn-only')
  if (!BOOKING_COPILOT_INGRESS_MODES.includes(ingressMode)) {
    return Promise.reject(new Error('booking_copilot_ingress_mode_invalid'))
  }
  if (ingressMode === 'bff-ingress-binding' && !hasIngressBinding) {
    return Promise.reject(new Error('booking_copilot_ingress_binding_required'))
  }
  if (ingressMode === 'bff-bound-turn-only' && hasIngressBinding) {
    return Promise.reject(new Error('booking_copilot_ingress_mode_conflict'))
  }
  const composition: BookingCopilotComposition = {
    runtime: options.runtime,
    plannerFactory: options.plannerFactory,
    ...(hasIngressBinding ? { ingressBinding: options.ingressBinding, principal: options.principal } : {}),
    ingressMode,
  }
  const maxBodyBytes = options.maxBodyBytes ?? 1_000_000
  const runningIdentity = runtimeIdentity()

  const server = createServer(async (req, res) => {
    const isProbe = req.method === 'GET' && (req.url === '/healthz' || req.url === '/status')
    if (!isProbe && (req.method !== 'POST' || req.url !== '/a2a/booking-copilot/turn')) {
      sendJson(res, 404, { error: { code: 'not_found' } })
      return
    }
    const auth = String(req.headers.authorization ?? '')
    if (!safeSecretEqual(auth, `Bearer ${options.apiKey}`)) {
      sendJson(res, 401, { error: { code: 'unauthorized' } })
      return
    }
    if (isProbe) {
      res.setHeader(BOOKING_SURFACE_VERSION_HEADER, BOOKING_SURFACE_SCHEMA_VERSION)
      res.setHeader(BOOKING_SURFACE_SCHEMA_SHA256_HEADER, BOOKING_SURFACE_SCHEMA_SHA256)
      if (options.artifactId) res.setHeader('X-GoTry-Artifact-ID', options.artifactId)
      res.setHeader('X-GoTry-Node-Version', runningIdentity.nodeVersion)
      res.setHeader('X-GoTry-Node-Modules-ABI', runningIdentity.nodeModulesAbi)
      res.setHeader('X-GoTry-Release-Tuple', runningIdentity.releaseTuple)
      if (runningIdentity.glibcVersion) res.setHeader('X-GoTry-Glibc-Version', runningIdentity.glibcVersion)
      const acceptedTurnKinds = ingressMode === 'bff-ingress-binding'
        ? [...BOOKING_COPILOT_ACCEPTED_TURN_KINDS, 'user.turn.ingress' as const]
        : [...BOOKING_COPILOT_ACCEPTED_TURN_KINDS]
      const healthBody: Record<string, unknown> = {
        schemaVersion: BOOKING_SURFACE_SCHEMA_VERSION,
        schemaSha256: BOOKING_SURFACE_SCHEMA_SHA256,
        status: 'ready',
        ingressMode,
        acceptedTurnKinds,
      }
      res.setHeader('X-GoTry-Ingress-Mode', ingressMode)
      res.setHeader('X-GoTry-Accepted-Turn-Kinds', acceptedTurnKinds.join(','))
      sendJson(res, 200, healthBody)
      return
    }
    const schemaVersion = String(req.headers[BOOKING_SURFACE_VERSION_HEADER] ?? '')
    const schemaHash = String(req.headers[BOOKING_SURFACE_SCHEMA_SHA256_HEADER] ?? '')
    if (schemaVersion !== BOOKING_SURFACE_SCHEMA_VERSION || schemaHash !== BOOKING_SURFACE_SCHEMA_SHA256) {
      sendJson(res, 409, {
        error: {
          code: 'booking_surface_schema_mismatch',
          expectedVersion: BOOKING_SURFACE_SCHEMA_VERSION,
          expectedSchemaSha256: BOOKING_SURFACE_SCHEMA_SHA256,
        },
      })
      return
    }
    await handleBookingCopilotRequest(req, res, composition, maxBodyBytes)
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
      server.off('error', reject)
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : (options.port ?? 0)
      resolve({
        server,
        port,
        close: () => new Promise<void>((done, fail) => server.close((error) => error ? fail(error) : done())),
      })
    })
  })
}
