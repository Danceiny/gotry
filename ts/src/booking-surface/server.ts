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
  BOOKING_SURFACE_FEATURES,
  BOOKING_SURFACE_FEATURES_HEADER,
  BOOKING_SURFACE_SCHEMA_SHA256,
  BOOKING_SURFACE_SCHEMA_SHA256_HEADER,
  BOOKING_SURFACE_SCHEMA_VERSION,
  BOOKING_SURFACE_VERSION_HEADER,
  bookingSurfaceActionsForFeatures,
  type BookingCopilotIngressMode,
  type BookingCopilotTurn,
  type BookingIngressBinding,
  type BookingIngressPrincipal,
  type BookingReadActionKind,
  type BookingSurfaceFeature,
  type BookingSurfaceEvent,
  type BookingWorkspaceSnapshot,
  type ObservableOrderFact,
  type IngressTurn,
} from './contracts.ts'
import {
  bookingDigest,
  BookingCopilotTaskRuntime,
  type BookingCopilotTaskState,
  type BookingIngressRequestBindingInput,
  type BookingPlannerSessionFactory,
} from './runtime.ts'
import { validateBookingSurface } from './validation.ts'
import { extractBookingDispatchReason, normalizeBookingErrorCode, safeBookingErrorMessage } from './error-codes.ts'

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

export interface BookingCopilotRuntimeIdentity {
  nodeVersion: string
  nodeModulesAbi: string
  releaseTuple: string
  glibcVersion: string
}

/** gotry-backend 模块挂载用的流量处理依赖(startBookingCopilotServer 与 backend 模块共用) */
export interface BookingCopilotTrafficDeps {
  apiKey: string
  composition: BookingCopilotComposition
  maxBodyBytes: number
  artifactId?: string
  ingressMode: BookingCopilotIngressMode
  runningIdentity: BookingCopilotRuntimeIdentity
}

/**
 * 单请求处理闭包(startBookingCopilotServer 的 createServer 回调原样摘出):
 * 探活(/healthz /status)+ 唯一 turn 路由 + 鉴权 + schema 头校验。
 * gotry-backend 的 booking-copilot 模块复用同一闭包,保证两条挂载路径行为逐字一致。
 */
export function bookingCopilotTrafficHandler(deps: BookingCopilotTrafficDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { apiKey, composition, maxBodyBytes, artifactId, ingressMode, runningIdentity } = deps
  return async (req, res) => {
    const isProbe = req.method === 'GET' && (req.url === '/healthz' || req.url === '/status')
    if (!isProbe && (req.method !== 'POST' || req.url !== '/a2a/booking-copilot/turn')) {
      sendJson(res, 404, { error: { code: 'not_found' } })
      return
    }
    const auth = String(req.headers.authorization ?? '')
    if (!safeSecretEqual(auth, `Bearer ${apiKey}`)) {
      sendJson(res, 401, { error: { code: 'unauthorized' } })
      return
    }
    if (lifecycleFor(composition).shuttingDown) {
      sendJson(res, 503, { error: { code: 'booking_copilot_shutting_down' } })
      return
    }
    if (isProbe) {
      res.setHeader(BOOKING_SURFACE_VERSION_HEADER, BOOKING_SURFACE_SCHEMA_VERSION)
      res.setHeader(BOOKING_SURFACE_SCHEMA_SHA256_HEADER, BOOKING_SURFACE_SCHEMA_SHA256)
      res.setHeader(BOOKING_SURFACE_FEATURES_HEADER, BOOKING_SURFACE_FEATURES.join(','))
      if (artifactId) res.setHeader('X-GoTry-Artifact-ID', artifactId)
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
        features: [...BOOKING_SURFACE_FEATURES],
      }
      res.setHeader('X-GoTry-Ingress-Mode', ingressMode)
      res.setHeader('X-GoTry-Accepted-Turn-Kinds', acceptedTurnKinds.join(','))
      sendJson(res, 200, healthBody)
      return
    }
    const schemaVersion = String(req.headers[BOOKING_SURFACE_VERSION_HEADER] ?? '')
    const schemaHash = String(req.headers[BOOKING_SURFACE_SCHEMA_SHA256_HEADER] ?? '')
    // `booking.surface` is the v1 compatibility line. Compatible additive
    // releases keep this version and may have different schema bytes; the
    // canonical payload validator below remains authoritative. Only a breaking
    // contract line changes this version and is rejected at the version gate.
    if (schemaVersion !== BOOKING_SURFACE_SCHEMA_VERSION) {
      sendJson(res, 409, {
        error: {
          code: 'booking_surface_schema_mismatch',
          expectedVersion: BOOKING_SURFACE_SCHEMA_VERSION,
        },
      })
      return
    }
    if (schemaHash && !/^[0-9a-f]{64}$/i.test(schemaHash)) {
      sendJson(res, 400, { error: { code: 'booking_surface_schema_hash_invalid' } })
      return
    }
    const lifecycle = lifecycleFor(composition)
    lifecycle.acceptedRequests += 1
    try {
      await handleBookingCopilotRequest(req, res, composition, maxBodyBytes, negotiatedBookingSurfaceFeatures(req))
    } finally {
      finishAcceptedRequest(lifecycle)
    }
  }
}

type PlannerSession = ReturnType<BookingPlannerSessionFactory>

interface PlannerLifecycle {
  active: Map<string, PlannerSession>
  /** Close operations detached from request latency, but still owned by the composition. */
  closing: Set<Promise<void>>
  /** Sticky cleanup failures surfaced by shutdown; close is not assumed retryable. */
  cleanupFailures: Map<PlannerSession, unknown>
  /** Turn handlers admitted before shutdown began. */
  acceptedRequests: number
  acceptedRequestDrainWaiters: Set<() => void>
  shuttingDown: boolean
  shutdownPromise?: Promise<void>
}

const plannerLifecycles = new WeakMap<BookingCopilotComposition, PlannerLifecycle>()
const decisionFlightsByComposition = new WeakMap<BookingCopilotComposition, Map<string, Promise<BookingSurfaceEvent[]>>>()

function lifecycleFor(composition: BookingCopilotComposition): PlannerLifecycle {
  let lifecycle = plannerLifecycles.get(composition)
  if (!lifecycle) {
    lifecycle = {
      active: new Map(),
      closing: new Set(),
      cleanupFailures: new Map(),
      acceptedRequests: 0,
      acceptedRequestDrainWaiters: new Set(),
      shuttingDown: false,
    }
    plannerLifecycles.set(composition, lifecycle)
  }
  return lifecycle
}

function finishAcceptedRequest(lifecycle: PlannerLifecycle): void {
  lifecycle.acceptedRequests -= 1
  if (lifecycle.acceptedRequests !== 0) return
  for (const resolve of lifecycle.acceptedRequestDrainWaiters) resolve()
  lifecycle.acceptedRequestDrainWaiters.clear()
}

function drainAcceptedRequests(composition: BookingCopilotComposition): Promise<void> {
  const lifecycle = lifecycleFor(composition)
  if (lifecycle.acceptedRequests === 0) return Promise.resolve()
  return new Promise((resolve) => lifecycle.acceptedRequestDrainWaiters.add(resolve))
}

function sessionsFor(composition: BookingCopilotComposition): Map<string, PlannerSession> {
  return lifecycleFor(composition).active
}

function schedulePlannerSessionClose(composition: BookingCopilotComposition, session: PlannerSession): void {
  const lifecycle = lifecycleFor(composition)
  const cleanup = Promise.resolve().then(() => session.close?.()).then(
    () => { lifecycle.cleanupFailures.delete(session) },
    (error: unknown) => {
      lifecycle.cleanupFailures.set(session, error)
      // Cleanup must not replace an already-durable booking outcome. Keep the
      // failure machine-readable and free of task/prompt/PII values. Session
      // close promises are allowed to be sticky, so shutdown reports the
      // original failure rather than retrying and laundering it into success.
      console.error(JSON.stringify({ code: 'PLANNER_SESSION_CLOSE_FAILED' }))
    },
  )
  lifecycle.closing.add(cleanup)
  void cleanup.then(() => lifecycle.closing.delete(cleanup))
}

/** Detach a session from the request path and close it in the composition lifecycle. */
function releasePlannerSession(composition: BookingCopilotComposition, taskId: string): void {
  const sessions = sessionsFor(composition)
  const session = sessions.get(taskId)
  if (!session) return
  sessions.delete(taskId)
  schedulePlannerSessionClose(composition, session)
}

async function drainPlannerSessions(composition: BookingCopilotComposition): Promise<void> {
  const lifecycle = lifecycleFor(composition)
  for (const [taskId, session] of lifecycle.active) {
    lifecycle.active.delete(taskId)
    schedulePlannerSessionClose(composition, session)
  }
  while (lifecycle.closing.size > 0) {
    await Promise.all([...lifecycle.closing])
  }

  if (lifecycle.cleanupFailures.size > 0) {
    throw new AggregateError([...lifecycle.cleanupFailures.values()], 'planner session cleanup failed during shutdown')
  }
}

async function drainDecisionFlights(composition: BookingCopilotComposition): Promise<void> {
  const flights = decisionFlightsFor(composition)
  while (flights.size > 0) {
    await Promise.allSettled([...flights.values()])
  }
}

/**
 * Stop admitting turns and drain every planner resource owned by a composition.
 * This is shared by the standalone listener and the unified gotry-backend
 * module, whose listener is owned by the backend kernel.
 */
export function shutdownBookingCopilotTraffic(composition: BookingCopilotComposition): Promise<void> {
  const lifecycle = lifecycleFor(composition)
  if (lifecycle.shutdownPromise) return lifecycle.shutdownPromise
  lifecycle.shuttingDown = true
  lifecycle.shutdownPromise = (async () => {
    await drainAcceptedRequests(composition)
    await drainDecisionFlights(composition)
    await drainPlannerSessions(composition)
  })()
  return lifecycle.shutdownPromise
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

export function runtimeIdentity(): BookingCopilotRuntimeIdentity {
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
  res.flushHeaders()
  res.socket?.setNoDelay(true)
  res.socket?.uncork()
}

function flush(res: ServerResponse): void {
  res.flushHeaders()
  const maybeFlush = res as ServerResponse & { flush?: () => void }
  maybeFlush.flush?.()
}

function sameCapabilities(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().every((kind, index) => kind === [...b].sort()[index])
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).length === allowed.length && Object.keys(value).every((key) => allowed.includes(key))
}

const SURFACE_ACTION_MATRIX = BOOKING_SURFACE_ALLOWED_ACTIONS

/**
 * The authenticated BFF sends the fresh fleet-wide feature intersection in
 * the same header that GoTry advertises on probes. Missing, malformed, and
 * unknown values fail closed to the empty optional-feature set.
 */
function negotiatedBookingSurfaceFeatures(req: IncomingMessage): BookingSurfaceFeature[] {
  const raw = req.headers[BOOKING_SURFACE_FEATURES_HEADER]
  if (typeof raw !== 'string' || raw.trim() === '') return []
  const values = new Set(raw.split(',').map((value) => value.trim()).filter(Boolean))
  return BOOKING_SURFACE_FEATURES.filter((feature) => values.has(feature))
}

function validSurfaceActions(surface: unknown, allowed: unknown): allowed is BookingWorkspaceSnapshot['capabilities']['allowedActions'] {
  if (typeof surface !== 'string' || !Object.prototype.hasOwnProperty.call(SURFACE_ACTION_MATRIX, surface)) return false
  if (!Array.isArray(allowed) || allowed.length < 1 || new Set(allowed).size !== allowed.length) return false
  const matrix = SURFACE_ACTION_MATRIX[surface as BookingWorkspaceSnapshot['surface']]
  return allowed.every((action) => typeof action === 'string'
    && matrix.includes(action as BookingReadActionKind)
    && (BOOKING_READ_ACTION_KINDS as readonly string[]).includes(action))
}

function validObservableOrders(value: unknown): value is ObservableOrderFact[] {
  if (!Array.isArray(value) || value.length > 100) return false
  const orderRefs = new Set<string>()
  return value.every((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false
    const candidate = item as Record<string, unknown>
    if (!exactKeys(candidate, ['orderRef', 'factRefs']) || typeof candidate.orderRef !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(candidate.orderRef) || orderRefs.has(candidate.orderRef)) return false
    if (!Array.isArray(candidate.factRefs) || candidate.factRefs.length > 64 || new Set(candidate.factRefs).size !== candidate.factRefs.length || candidate.factRefs.some((ref) => typeof ref !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(ref))) return false
    orderRefs.add(candidate.orderRef)
    return true
  })
}

function validBoundWorkspaceAuthority(workspace: BookingWorkspaceSnapshot): boolean {
  return workspace.capabilities.surface === workspace.surface
    && validSurfaceActions(workspace.surface, workspace.capabilities.allowedActions)
    && (workspace.observableOrders === undefined || validObservableOrders(workspace.observableOrders))
}

/**
 * Old compatible BFF releases may still send the base action matrix. Fresh
 * tasks are narrowed to the negotiated optional features instead of failing
 * the whole turn. Existing task allowlists remain stable across a rolling
 * deploy, while unsupported trusted projections are still removed so no new
 * optional action can gain authority.
 */
function narrowWorkspaceOptionalAuthority(
  workspace: BookingWorkspaceSnapshot,
  features: readonly BookingSurfaceFeature[],
  existingTaskActions?: readonly BookingReadActionKind[],
): BookingWorkspaceSnapshot | null {
  const negotiated = new Set(bookingSurfaceActionsForFeatures(workspace.surface, features))
  if (existingTaskActions?.some((action) => !workspace.capabilities.allowedActions.includes(action))) return null
  const allowedActions = existingTaskActions
    ? [...existingTaskActions]
    : workspace.capabilities.allowedActions.filter((action) => negotiated.has(action))
  if (allowedActions.length === 0) return null
  const { observableOrders, ...base } = workspace
  return {
    ...base,
    capabilities: { surface: workspace.surface, allowedActions },
    ...(features.includes('trusted-order-observation-v1') && observableOrders !== undefined
      ? { observableOrders: observableOrders.map((order) => ({ orderRef: order.orderRef, factRefs: [...order.factRefs] })) }
      : {}),
  }
}

function validIngressBinding(binding: unknown, ingress: IngressTurn): binding is {
  taskId: string
  turnId: string
  contextRef: string
  surface: BookingWorkspaceSnapshot['surface']
  allowedActions: BookingWorkspaceSnapshot['capabilities']['allowedActions']
  observableOrders?: ObservableOrderFact[]
} {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return false
  const candidate = binding as Record<string, unknown>
  if (!exactKeys(candidate, ['taskId', 'turnId', 'contextRef', 'surface', 'allowedActions'])
    && !exactKeys(candidate, ['taskId', 'turnId', 'contextRef', 'surface', 'allowedActions', 'observableOrders'])) return false
  if (typeof candidate.taskId !== 'string' || typeof candidate.turnId !== 'string' || typeof candidate.contextRef !== 'string') return false
  if (typeof candidate.surface !== 'string' || candidate.surface !== ingress.surfaceHint || !Object.prototype.hasOwnProperty.call(SURFACE_ACTION_MATRIX, candidate.surface)) return false
  return validSurfaceActions(candidate.surface, candidate.allowedActions)
    && (candidate.observableOrders === undefined || validObservableOrders(candidate.observableOrders))
}

function validIngressApprovalAuthority(ingress: IngressTurn, binding: { taskId: string; contextRef: string }): boolean {
  if (!ingress.request.approval) return true
  return ingress.request.approval.taskId === binding.taskId
    && ingress.request.approval.contextRef === binding.contextRef
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
  // Provider/adapter exceptions can contain response bodies, URLs or request
  // context. Preserve only the closed code and coarse thrown-value class.
  console.error('[booking-copilot] planner boundary error:', JSON.stringify({
    code,
    thrownType: error instanceof Error ? 'error' : typeof error,
  }))
  try {
    const decision = { kind: 'error' as const, error: { code, message: safeBookingErrorMessage(code), retryable: false } }
    if (requestKey) {
      const events = composition.runtime.applyDecisionBatch(task.taskId, requestKey, [decision], includeSubmitted, { suppressProgressStatuses: true })
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
async function handleBookingCopilotRequest(
  req: IncomingMessage,
  res: ServerResponse,
  composition: BookingCopilotComposition,
  maxBodyBytes: number,
  negotiatedFeatures: readonly BookingSurfaceFeature[],
): Promise<void> {
  let turn: Exclude<BookingCopilotTurn, IngressTurn>
  let browserRequestKey: string | undefined
  let requestBinding: BookingIngressRequestBindingInput | undefined
  let authorityFailureStatus = 403
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
      if (!validIngressApprovalAuthority(ingress, binding)) { sendJson(res, 400, { error: { code: 'invalid_ingress_approval_authority' } }); return }
      const proposedBoundWorkspace = {
        ...ingress.workspace,
        contextRef: binding.contextRef,
        surface: binding.surface,
        capabilities: { surface: binding.surface, allowedActions: [...binding.allowedActions] },
        ...(binding.observableOrders !== undefined ? { observableOrders: binding.observableOrders.map((order) => ({ orderRef: order.orderRef, factRefs: [...order.factRefs] })) } : {}),
      } as BookingWorkspaceSnapshot
      const boundRequest = ingress.request.approval
        ? { text: ingress.request.text, approval: { ...ingress.request.approval } }
        : { text: ingress.request.text }
      turn = { schemaVersion: BOOKING_SURFACE_SCHEMA_VERSION, kind: 'user.turn', taskId: binding.taskId, turnId: binding.turnId, workspace: proposedBoundWorkspace, request: boundRequest }
      requestBinding = { requestKey: ingress.requestKey, principal: composition.principal, ...(ingress.taskHandle ? { taskHandle: ingress.taskHandle } : {}) }
      authorityFailureStatus = 502
      const boundValid = validateBookingSurface(turn)
      if (!boundValid.ok) { sendJson(res, 502, { error: { code: 'invalid_ingress_binding', details: boundValid.errors } }); return }
    } else {
      const boundTurn = parsed as Exclude<BookingCopilotTurn, IngressTurn>
      if (!validBoundWorkspaceAuthority(boundTurn.workspace)) {
        sendJson(res, 403, { error: { code: 'invalid_bound_turn_authority' } })
        return
      }
      turn = boundTurn
    }
  } catch (error) { const code = normalizeBookingErrorCode(error); sendJson(res, code === 'PAYLOAD_TOO_LARGE' ? 413 : 400, { error: { code } }); return }

  let task: BookingCopilotTaskState; let fresh = false; let replayKey: string | undefined; let replayEvents: BookingSurfaceEvent[] | null = null; let activeDecisionKey: string | undefined
  try {
    const existingAtAdmission = turn.taskId ? composition.runtime.resumeTask(turn.taskId) : null
    const narrowedWorkspace = narrowWorkspaceOptionalAuthority(turn.workspace, negotiatedFeatures, existingAtAdmission?.allowedActions)
    if (!narrowedWorkspace) {
      const code = authorityFailureStatus === 502 ? 'invalid_ingress_binding' : 'invalid_bound_turn_authority'
      sendJson(res, authorityFailureStatus, { error: { code } })
      return
    }
    turn = { ...turn, workspace: narrowedWorkspace }
    fresh = turn.kind === 'action.receipt.continuation' ? false : existingAtAdmission === null
    if (turn.kind === 'action.receipt.continuation') {
      replayKey = `receipt:${turn.receipt.actionId}:${composition.runtime.receiptDigest(turn.receipt)}`
      task = composition.runtime.continueWithReceipt(turn)
      if (task.awaitingApproval) {
        replayKey = composition.runtime.approvalPresentationRequestKey(turn.taskId)
      }
      replayEvents = composition.runtime.readDecisionBatch(turn.taskId, replayKey)
      if (!replayEvents && task.phase === 'terminal') replayEvents = composition.runtime.terminalDecisionBatch(turn.taskId, replayKey)
    } else {
      const existing = existingAtAdmission
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
        if (turn.kind === 'user.turn' && turn.request.approval) composition.runtime.assertApprovalNotConsumed(existing.taskId, turn.request.approval)
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
        if (existing && turn.kind === 'user.turn' && turn.request.approval) composition.runtime.assertApprovalNotConsumed(existing.taskId, turn.request.approval)
        task = composition.runtime.startTask(turn, requestBinding)
        if (turn.kind === 'user.turn' && turn.taskId) {
          replayKey = browserRequestKey ? `ingress:${task.taskId}:${browserRequestKey}` : `turn:${task.taskId}:${turn.turnId ?? task.userTurnCount}`
          replayEvents = composition.runtime.readDecisionBatch(task.taskId, replayKey)
        }
      }
    }
  } catch (error) {
    const code = normalizeBookingErrorCode(error)
    console.error(JSON.stringify({ code, reason: extractBookingDispatchReason(error) }))
    sendJson(res, 409, { error: { code } }); return
  }

  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-content-type-options': 'nosniff', [BOOKING_SURFACE_VERSION_HEADER]: BOOKING_SURFACE_SCHEMA_VERSION, [BOOKING_SURFACE_SCHEMA_SHA256_HEADER]: BOOKING_SURFACE_SCHEMA_SHA256 })
  res.flushHeaders()
  try {
    if (replayEvents) {
      const progressEvents = composition.runtime.readProgressBatch(task.taskId, replayKey ?? `turn:${task.taskId}:${task.userTurnCount}`) ?? []
      for (const event of progressEvents) write(res, event)
      if (progressEvents.length) {
        flush(res)
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      if (task.phase === 'terminal' || task.phase === 'error') releasePlannerSession(composition, task.taskId)
      for (const event of replayEvents) write(res, event)
    } else {
      const requestKey = replayKey ?? `turn:${task.taskId}:${task.userTurnCount}`
      activeDecisionKey = requestKey
      // A concurrent identical request may arrive after the first request has
      // committed progress but before its planner flight finishes. Re-serve
      // the durable progress batch so it receives the same prefix instead of
      // exposing a terminal-only tail.
      const newlyPersistedProgress = composition.runtime.ensureProgressBatch(task.taskId, requestKey, fresh)
      const progressEvents = newlyPersistedProgress.length > 0
        ? newlyPersistedProgress
        : (composition.runtime.readProgressBatch(task.taskId, requestKey) ?? [])
      const approval = turn.kind === 'user.turn' ? turn.request.approval : undefined
      const flightKey = JSON.stringify([task.taskId, approval ? `approval:${bookingDigest(approval)}` : requestKey])
      // Register or join the decision flight before yielding after the progress
      // flush. A duplicate that observed the durable progress must never miss
      // an about-to-finish flight and pay for a second model invocation.
      const decisionOutcome = runDecisionSingleFlight(composition, flightKey, async () => {
        // Cover the complementary late-join case: the prior flight may have
        // committed its exact batch and left the in-memory map between request
        // admission and this work starting.
        const durableDecision = composition.runtime.readDecisionBatch(task.taskId, requestKey)
        if (durableDecision) return durableDecision
        if (turn.kind === 'action.receipt.continuation' && task.awaitingApproval) {
          return composition.runtime.applyDecisionBatch(task.taskId, requestKey, [composition.runtime.approvalQuestion(task.taskId)], false)
        }
        const sessions = sessionsFor(composition)
        const session = sessions.get(task.taskId) ?? composition.plannerFactory(task)
        sessions.set(task.taskId, session)
        const decisions = await session.next({ turn, task: composition.runtime.resumeTask(task.taskId) ?? task })
        const plannerDecisions = decisions.length ? decisions : [{ kind: 'error' as const, error: { code: 'PLANNER_NO_DECISION', message: 'Planner returned no typed decision.', retryable: false } }]
        const events = composition.runtime.applyDecisionBatch(task.taskId, requestKey, plannerDecisions, fresh, { suppressProgressStatuses: true })
        const updated = composition.runtime.resumeTask(task.taskId)
        if (updated?.phase === 'terminal' || updated?.phase === 'error') releasePlannerSession(composition, task.taskId)
        return events
      }).then(
        (events) => ({ ok: true as const, events }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      for (const event of progressEvents) write(res, event)
      if (progressEvents.length) {
        flush(res)
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      const outcome = await decisionOutcome
      if (!outcome.ok) throw outcome.error
      for (const event of outcome.events) write(res, event)
    }
  } catch (error) {
    writeTypedError(res, composition, task, error, activeDecisionKey, fresh)
    const updated = composition.runtime.resumeTask(task.taskId)
    if (updated?.phase === 'terminal' || updated?.phase === 'error') releasePlannerSession(composition, task.taskId)
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

  const server = createServer((req, res) => {
    void bookingCopilotTrafficHandler({
      apiKey: options.apiKey,
      composition,
      maxBodyBytes,
      ...(options.artifactId !== undefined ? { artifactId: options.artifactId } : {}),
      ingressMode,
      runningIdentity,
    })(req, res)
  })
  let closePromise: Promise<void> | undefined

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
      server.off('error', reject)
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : (options.port ?? 0)
      resolve({
        server,
        port,
        close: () => {
          if (closePromise) return closePromise
          const trafficShutdown = shutdownBookingCopilotTraffic(composition)
          closePromise = (async () => {
            const listenerShutdown = new Promise<void>((done, fail) => server.close((error) => error ? fail(error) : done()))
            const results = await Promise.allSettled([listenerShutdown, trafficShutdown])
            const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
            if (failures.length > 0) throw new AggregateError(failures, 'booking_copilot_server_close_failed')
          })()
          return closePromise
        },
      })
    })
  })
}
