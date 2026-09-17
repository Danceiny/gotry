/**
 * BFF-only typed HTTP/SSE seam proof.
 *
 * Run with Node 24 from the repository root:
 *   npx --yes --package=node@24 --package=tsx --call \
 *     'tsx ts/scripts/booking-copilot-server-proof-tests.ts'
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureLedger } from '../src/state-ledger.ts'
import { closeBackend, createBackendServer } from '../src/backend/kernel.ts'
import { startBookingCopilotModule } from '../src/backend/modules/booking-copilot.ts'
import { BookingCopilotTaskRuntime, type BookingPlannerDecision, type BookingPlannerSessionFactory } from '../src/booking-surface/runtime.ts'
import { startBookingCopilotServer } from '../src/booking-surface/server.ts'
import type { BookingSurfaceEvent } from '../src/booking-surface/contracts.ts'
import { BOOKING_SURFACE_FEATURES, BOOKING_SURFACE_SCHEMA_SHA256, BOOKING_SURFACE_SCHEMA_VERSION } from '../src/booking-surface/contracts.ts'

const API_KEY = 'server-to-server-key'
const SCHEMA_VERSION = BOOKING_SURFACE_SCHEMA_VERSION
const SCHEMA_SHA256 = BOOKING_SURFACE_SCHEMA_SHA256
const ARTIFACT_ID = '1111111111111111111111111111111111111111'
const stateRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-server-'))
const ledger = ensureLedger(stateRoot)
let nextId = 0
const runtime = new BookingCopilotTaskRuntime(ledger, {
  idFactory: (prefix) => `${prefix}-${++nextId}`,
  now: () => '2026-08-30T12:00:00.000Z',
})

let factoryCalls = 0
let sessionTurns = 0
let sessionCloses = 0
const plannerFactory: BookingPlannerSessionFactory = (initialTask) => {
  factoryCalls += 1
  assert.equal(initialTask.taskId, 'task-http-1')
  return {
    async next({ task }) {
      sessionTurns += 1
      if (sessionTurns === 1) {
        return [{
          kind: 'operation',
          action: {
            schemaVersion: 'booking.surface',
            kind: 'search.run',
            actionId: 'action-http-1',
            contextRef: task.contextRef,
            expectedRevision: task.revision,
            reason: 'Run the authoritative workspace search',
            factRefs: [],
            input: {},
          },
          intent: { schemaVersion: 'booking.intent.v1', target: 'search.results' },
        }]
      }
      return [
        {
          kind: 'explanation',
          explanation: { text: '{"kind":"search.run","input":{}}', factRefs: [] },
        },
        {
          kind: 'terminal',
          terminal: { status: 'completed', summary: 'Stopped at the requested search result.', factRefs: [] },
        },
      ]
    },
    async close() { sessionCloses += 1 },
  }
}

const serverHandle = await startBookingCopilotServer({
  apiKey: API_KEY,
  runtime,
  plannerFactory,
  artifactId: ARTIFACT_ID,
})
const endpoint = `http://127.0.0.1:${serverHandle.port}/a2a/booking-copilot/turn`
const expectedProbe = {
  schemaVersion: SCHEMA_VERSION,
  schemaSha256: SCHEMA_SHA256,
  status: 'ready',
  ingressMode: 'bff-bound-turn-only',
  acceptedTurnKinds: ['user.turn', 'action.receipt.continuation'],
  features: [...BOOKING_SURFACE_FEATURES],
}
const runtimeReport = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined
const runtimeGlibcVersion = runtimeReport?.header?.glibcVersionRuntime ?? ''
const runtimeReleaseTuple = `${process.platform}-${process.arch}-${runtimeGlibcVersion ? 'glibc' : 'unknown'}`
await assert.rejects(
  startBookingCopilotServer({
    apiKey: API_KEY,
    runtime,
    plannerFactory,
    artifactId: 'not-a-commit',
  }),
  /booking_copilot_artifact_id_invalid/,
)
for (const path of ['/healthz', '/status']) {
  const probeUrl = `http://127.0.0.1:${serverHandle.port}${path}`
  for (const authorization of [undefined, 'Bearer wrong-key']) {
    const rejected = await fetch(probeUrl, authorization ? { headers: { authorization } } : undefined)
    assert.equal(rejected.status, 401, `${path} rejects ${authorization ? 'wrong' : 'missing'} bearer`)
  }
  const authorized = await fetch(probeUrl, { headers: { authorization: `Bearer ${API_KEY}` } })
  assert.equal(authorized.status, 200, `${path} accepts deployment bearer`)
  assert.equal(authorized.headers.get('x-booking-surface-version'), SCHEMA_VERSION, `${path} returns canonical schema version header`)
  assert.equal(authorized.headers.get('x-booking-surface-schema-sha256'), SCHEMA_SHA256, `${path} returns canonical schema hash header`)
  assert.equal(authorized.headers.get('x-booking-surface-features'), BOOKING_SURFACE_FEATURES.join(','), `${path} advertises additive features independently of the schema hash`)
  assert.equal(authorized.headers.get('x-gotry-artifact-id'), ARTIFACT_ID, `${path} returns the running release identity`)
  assert.equal(authorized.headers.get('x-gotry-node-version'), process.version, `${path} returns the actual Node runtime`)
  assert.equal(authorized.headers.get('x-gotry-node-modules-abi'), process.versions.modules, `${path} returns the actual native ABI`)
  assert.equal(authorized.headers.get('x-gotry-release-tuple'), runtimeReleaseTuple, `${path} returns the actual runtime tuple`)
  assert.equal(authorized.headers.get('x-gotry-glibc-version'), runtimeGlibcVersion || null, `${path} returns glibc only when present`)
  assert.deepEqual(await authorized.json(), expectedProbe, `${path} exposes only typed readiness contract`)
}

const workspace = {
  schemaVersion: 'booking.surface',
  contextRef: 'ctx-http-1',
  surface: 'tenant',
  revision: 0,
  locale: 'zh-CN',
  currency: 'AED',
  searchDraft: {},
  results: { status: 'idle' },
  visibleHotels: [],
  loadedOffers: [],
  shortlistedOfferRefs: [],
  capabilities: {
    surface: 'tenant',
    allowedActions: ['search.run'],
  },
}
const userTurn = {
  schemaVersion: 'booking.surface',
  kind: 'user.turn',
  taskId: 'task-http-1',
  turnId: 'http-turn-1',
  workspace,
  request: { text: '执行当前搜索' },
}

const post = (
  body: unknown,
  authorization = `Bearer ${API_KEY}`,
  schemaHeaders: Record<string, string> = {
    'x-booking-surface-version': SCHEMA_VERSION,
    'x-booking-surface-schema-sha256': SCHEMA_SHA256,
  },
) => fetch(endpoint, {
  method: 'POST',
  headers: { authorization, 'content-type': 'application/json', accept: 'text/event-stream', ...schemaHeaders },
  body: JSON.stringify(body),
})

const turnFor = (taskId: string, contextRef: string) => ({
  ...userTurn,
  taskId,
  turnId: `${taskId}-turn-1`,
  workspace: { ...workspace, contextRef },
})

// Optional fields/actions are admitted only from the fresh fleet feature
// intersection supplied by the authenticated BFF. An old compatible BFF may
// keep sending the base matrix; GoTry narrows it without failing the turn.
const featureRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-feature-negotiation-'))
const featureLedger = ensureLedger(featureRoot)
const featureRuntime = new BookingCopilotTaskRuntime(featureLedger)
const featureTasks: Array<{ actions: string[]; orderCount: number }> = []
const featureServer = await startBookingCopilotServer({
  apiKey: API_KEY,
  runtime: featureRuntime,
  plannerFactory: (initialTask) => {
    const orders = initialTask.workspaceSnapshot?.observableOrders ?? []
    featureTasks.push({ actions: [...initialTask.allowedActions], orderCount: orders.length })
    const decision: BookingPlannerDecision = initialTask.allowedActions.includes('order.observe') && orders[0]
      ? {
          kind: 'operation' as const,
          intent: { schemaVersion: 'booking.intent.v1' as const, target: 'order.observed' as const },
          action: {
            schemaVersion: 'booking.surface' as const, kind: 'order.observe' as const,
            actionId: `action-${initialTask.taskId}`, contextRef: initialTask.contextRef,
            expectedRevision: initialTask.revision, reason: 'Observe the trusted existing order.',
            factRefs: [...orders[0].factRefs], input: { orderRef: orders[0].orderRef },
          },
        }
      : {
          kind: 'operation' as const,
          intent: { schemaVersion: 'booking.intent.v1' as const, target: 'search.results' as const },
          action: {
            schemaVersion: 'booking.surface' as const, kind: 'search.run' as const,
            actionId: `action-${initialTask.taskId}`, contextRef: initialTask.contextRef,
            expectedRevision: initialTask.revision, reason: 'Run the authoritative search.', factRefs: [], input: {},
          },
        }
    return { async next() { return [decision] } }
  },
})
try {
  const optionalWorkspace = {
    ...workspace,
    contextRef: 'ctx-feature-old-bff',
    observableOrders: [{ orderRef: 'order-feature-1', factRefs: ['order:feature:1'] }],
    capabilities: { surface: 'tenant', allowedActions: ['search.run', 'order.observe'] },
  }
  const optionalEndpoint = `http://127.0.0.1:${featureServer.port}/a2a/booking-copilot/turn`
  const optionalHeaders = {
    authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json', accept: 'text/event-stream',
    'x-booking-surface-version': SCHEMA_VERSION, 'x-booking-surface-schema-sha256': SCHEMA_SHA256,
  }
  const oldBffResponse = await fetch(optionalEndpoint, {
    method: 'POST', headers: optionalHeaders,
    body: JSON.stringify({ ...userTurn, taskId: 'task-feature-old-bff', turnId: 'turn-feature-old-bff', workspace: optionalWorkspace }),
  })
  assert.equal(oldBffResponse.status, 200, 'an old same-line BFF base matrix is narrowed instead of rejected')
  assert.match(await oldBffResponse.text(), /"kind":"search.run"/)
  assert.deepEqual(featureTasks[0], { actions: ['search.run'], orderCount: 0 }, 'missing feature evidence strips the optional action and authority projection')

  const negotiatedResponse = await fetch(optionalEndpoint, {
    method: 'POST', headers: { ...optionalHeaders, 'x-booking-surface-features': 'future-unknown,trusted-order-observation-v1' },
    body: JSON.stringify({ ...userTurn, taskId: 'task-feature-negotiated', turnId: 'turn-feature-negotiated', workspace: { ...optionalWorkspace, contextRef: 'ctx-feature-negotiated' } }),
  })
  assert.equal(negotiatedResponse.status, 200)
  assert.match(await negotiatedResponse.text(), /"kind":"order.observe"/)
  assert.deepEqual(featureTasks[1], { actions: ['search.run', 'order.observe'], orderCount: 1 }, 'known fleet-intersection feature enables only its optional action and projection')
} finally {
  await featureServer.close()
  featureLedger.close()
  rmSync(featureRoot, { recursive: true, force: true })
}

const noAuth = await fetch(endpoint, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(userTurn),
})
assert.equal(noAuth.status, 401, 'server-to-server key is fail-closed')

const missingSchemaHeaders = await post(userTurn, `Bearer ${API_KEY}`, {})
assert.equal(missingSchemaHeaders.status, 409, 'the breaking-version header is required')
const malformedSchemaHash = await post(userTurn, `Bearer ${API_KEY}`, {
  'x-booking-surface-version': SCHEMA_VERSION,
  'x-booking-surface-schema-sha256': 'not-a-sha256',
})
assert.equal(malformedSchemaHash.status, 400, 'a supplied schema hash remains a well-formed diagnostic identity')

const directIngress = await post({
  schemaVersion: 'booking.surface',
  kind: 'user.turn.ingress',
  requestKey: 'browser-request-1',
  surfaceHint: 'tenant',
  workspace: {
    schemaVersion: 'booking.surface', revision: 0, locale: 'zh-CN', currency: 'AED',
    searchDraft: {}, results: { status: 'idle' }, visibleHotels: [], loadedOffers: [], shortlistedOfferRefs: [],
  },
  request: { text: 'browser must use same-origin BFF' },
})
assert.equal(directIngress.status, 503, 'GoTry server rejects unbound browser ingress')
assert.equal((await directIngress.json()).error.code, 'trusted_ingress_binding_required')

const tokenSmuggle = await post({ ...userTurn, portalToken: 'ST:must-not-cross-boundary' })
assert.equal(tokenSmuggle.status, 400, 'strict planner turn rejects portal token fields')

const versionOnly = await post(userTurn, `Bearer ${API_KEY}`, {
  'x-booking-surface-version': SCHEMA_VERSION,
})
assert.equal(versionOnly.status, 200, 'the compatibility version is sufficient when the diagnostic hash is omitted')
assert.equal(versionOnly.headers.get('x-booking-surface-schema-sha256'), SCHEMA_SHA256, 'the server still advertises its exact local schema hash')
const versionOnlyBody = await versionOnly.text()

const first = await post(userTurn, `Bearer ${API_KEY}`, {
  'x-booking-surface-version': SCHEMA_VERSION,
  'x-booking-surface-schema-sha256': '0'.repeat(64),
})
assert.equal(first.status, 200)
assert.equal(first.headers.get('x-booking-surface-schema-sha256'), SCHEMA_SHA256, 'a compatible peer hash is accepted and the local canonical hash is advertised back')
assert.match(String(first.headers.get('content-type')), /text\/event-stream/)
assert.equal(first.headers.get('x-booking-surface-version'), SCHEMA_VERSION)
assert.equal(first.headers.get('x-booking-surface-schema-sha256'), SCHEMA_SHA256)

function parseSse(body: string): BookingSurfaceEvent[] {
  return body.trim().split('\n\n').map((frame) => {
    const data = frame.split('\n').find((line) => line.startsWith('data: '))
    assert.ok(data, `SSE frame has data: ${frame}`)
    return JSON.parse(data.slice('data: '.length)) as BookingSurfaceEvent
  })
}

type OpenSseResponse = {
  statusCode: number
  firstEvents: Promise<BookingSurfaceEvent[]>
  body: Promise<string>
}

/** Open an SSE stream without undici's body buffering, so the proof can
 * observe the durable progress prefix while the planner remains gated. */
function openSseRequest(url: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<OpenSseResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(new URL(url), { method: init.method, headers: init.headers })
    request.once('error', reject)
    request.end(init.body)
    request.once('response', (response) => {
      let text = ''
      let resolveFirst!: (events: BookingSurfaceEvent[]) => void
      let rejectFirst!: (error: Error) => void
      let firstSettled = false
      const firstEvents = new Promise<BookingSurfaceEvent[]>((firstResolve, firstReject) => {
        resolveFirst = firstResolve
        rejectFirst = firstReject
      })
      const body = new Promise<string>((bodyResolve, bodyReject) => {
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          text += chunk
          if (firstSettled) return
          const events: BookingSurfaceEvent[] = []
          for (const frame of text.split('\n\n')) {
            const data = frame.split('\n').find((line) => line.startsWith('data: '))
            if (!data) continue
            try { events.push(JSON.parse(data.slice('data: '.length)) as BookingSurfaceEvent) } catch { /* incomplete frame */ }
          }
          if (events.length >= 2) {
            firstSettled = true
            resolveFirst(events)
          }
        })
        response.on('end', () => {
          if (!firstSettled) rejectFirst(new Error('sse_ended_before_progress'))
          bodyResolve(text)
        })
        response.on('error', (error) => {
          if (!firstSettled) rejectFirst(error)
          bodyReject(error)
        })
      })
      resolve({ statusCode: response.statusCode ?? 0, firstEvents, body })
    })
  })
}

const firstBody = await first.text()
assert.equal(firstBody, versionOnlyBody, 'a different same-line diagnostic hash replays the same typed result')
const firstEvents = parseSse(firstBody)
assert.deepEqual(firstEvents.map((event) => event.kind), ['status', 'status', 'operation', 'status'])
assert.equal(firstEvents[3]!.kind === 'status' ? firstEvents[3].status : '', 'waiting_receipt', 'the operation leaves the task durably waiting for its receipt')
assert.ok(firstEvents.every((event) => event.contextRef === workspace.contextRef), 'every typed event carries BFF-minted contextRef')
const operation = firstEvents[2]
assert.equal(operation?.kind, 'operation')
assert.equal(factoryCalls, 1)
assert.equal(sessionTurns, 1)

const receiptTurn = {
  schemaVersion: 'booking.surface',
  kind: 'action.receipt.continuation',
  taskId: 'task-http-1',
  workspace: {
    ...workspace,
    revision: 1,
    results: { status: 'ready', resultCount: 2, searchSessionRef: 'search-http-1' },
  },
  receipt: {
    schemaVersion: 'booking.surface',
    kind: 'action.receipt',
    actionId: 'action-http-1',
    contextRef: workspace.contextRef,
    status: 'applied',
    revision: 1,
    observation: { kind: 'search.state', searchSessionRef: 'search-http-1', resultCount: 2 },
    resultContract: { outcome: 'complete', hardCriteriaMet: true, factRefs: [], gapCodes: [], blockers: [], relaxationsApplied: [] },
  },
}
const second = await post(receiptTurn)
assert.equal(second.status, 200)
const secondEvents = parseSse(await second.text())
assert.deepEqual(secondEvents.map((event) => event.kind), ['status', 'explanation', 'terminal'])
assert.equal(factoryCalls, 1, 'one task reuses one planner session across receipt continuations')
assert.equal(sessionTurns, 2)
assert.equal(sessionCloses, 1, 'a durable terminal decision releases the task-scoped planner session')
assert.ok(!secondEvents.some((event) => event.kind === 'operation'), 'JSON-looking explanation text is not parsed into an operation')
assert.ok(secondEvents[0]!.sequence > firstEvents.at(-1)!.sequence, 'SSE sequence is monotonic across turns')

// Progress is its own durable batch. It must reach the client while the
// planner is still gated, and the final batch must not repeat submitted or
// working. The same request key is single-flight and replays progress plus
// final events byte-for-byte.
const progressRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-server-progress-'))
const progressLedger = ensureLedger(progressRoot)
const progressRuntime = new BookingCopilotTaskRuntime(progressLedger, { contextRefFactory: () => 'ctx-progress' })
let progressPlannerCalls = 0
let releaseProgressPlanner!: () => void
const progressPlannerGate = new Promise<void>((resolve) => { releaseProgressPlanner = resolve })
const progressServer = await startBookingCopilotServer({
  apiKey: API_KEY,
  runtime: progressRuntime,
  plannerFactory: () => ({
    async next() {
      progressPlannerCalls += 1
      await progressPlannerGate
      return [{ kind: 'terminal', terminal: { status: 'completed', summary: 'Progress gate released.', factRefs: [] } }]
    },
    async close() {},
  }),
})
const progressEndpoint = `http://127.0.0.1:${progressServer.port}/a2a/booking-copilot/turn`
const progressRequestKey = 'turn:task-progress-gated:task-progress-gated-turn-1'
const progressRequest = {
  method: 'POST',
  headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json', accept: 'text/event-stream', 'x-booking-surface-version': SCHEMA_VERSION, 'x-booking-surface-schema-sha256': SCHEMA_SHA256 },
  body: JSON.stringify(turnFor('task-progress-gated', 'ctx-progress')),
}
const progressResponse = await openSseRequest(progressEndpoint, progressRequest)
const progressPrefix = await Promise.race([
  progressResponse.firstEvents,
  new Promise<BookingSurfaceEvent[]>((_, reject) => setTimeout(() => reject(new Error('sse_progress_prefix_timeout')), 2_000)),
])
assert.equal(progressResponse.statusCode, 200)
assert.deepEqual(progressPrefix.slice(0, 2).map((event) => event.kind), ['status', 'status'], 'client receives submitted/working before planner release')
assert.deepEqual(progressPrefix.slice(0, 2).map((event) => event.kind === 'status' ? event.status : ''), ['submitted', 'working'], 'first SSE frames carry typed status fields')
assert.equal(progressPrefix.some((event) => event.kind === 'terminal'), false, 'client receives no terminal before planner release')
assert.equal(progressPlannerCalls, 1, 'planner is admitted only after durable submitted/working progress is flushed')
const concurrentProgressResponse = await openSseRequest(progressEndpoint, progressRequest)
const concurrentProgressPrefix = await Promise.race([
  concurrentProgressResponse.firstEvents,
  new Promise<BookingSurfaceEvent[]>((_, reject) => setTimeout(() => reject(new Error('concurrent_sse_progress_prefix_timeout')), 2_000)),
])
assert.deepEqual(concurrentProgressPrefix.slice(0, 2).map((event) => event.kind === 'status' ? event.status : ''), ['submitted', 'working'], 'duplicate request receives durable progress before the first planner flight is released')
releaseProgressPlanner()
const progressBody = await progressResponse.body
const progressEvents = parseSse(progressBody)
assert.deepEqual(progressEvents.map((event) => event.kind), ['status', 'status', 'terminal'])
assert.deepEqual(progressEvents.map((event) => event.sequence), [1, 2, 3], 'durable progress and final events use monotonic task sequences')
assert.equal(concurrentProgressResponse.statusCode, 200)
assert.equal(await concurrentProgressResponse.body, progressBody, 'concurrent identical requests receive the same progress and final batch')
assert.equal(progressPlannerCalls, 1, 'concurrent identical requests enter the planner once')
const progressReplay = await fetch(progressEndpoint, progressRequest)
assert.equal(await progressReplay.text(), progressBody, 'replay combines the exact durable progress and final batches')
assert.equal(progressPlannerCalls, 1, 'final replay does not re-enter the planner')
await progressServer.close()

// The same late-join guard applies when the durable final batch is an error;
// retrying the HTTP request must replay it without buying another model call.
const errorProgressRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-server-progress-error-'))
const errorProgressLedger = ensureLedger(errorProgressRoot)
const errorProgressRuntime = new BookingCopilotTaskRuntime(errorProgressLedger, { contextRefFactory: () => 'ctx-progress-error' })
let errorProgressPlannerCalls = 0
let releaseErrorProgressPlanner!: () => void
const errorProgressPlannerGate = new Promise<void>((resolve) => { releaseErrorProgressPlanner = resolve })
const errorProgressServer = await startBookingCopilotServer({
  apiKey: API_KEY,
  runtime: errorProgressRuntime,
  plannerFactory: () => ({
    async next() {
      errorProgressPlannerCalls += 1
      await errorProgressPlannerGate
      return [{ kind: 'error', error: { code: 'PLANNER_PROVIDER_UNAVAILABLE', message: 'fixture text is replaced', retryable: true } }]
    },
    async close() {},
  }),
})
const errorProgressEndpoint = `http://127.0.0.1:${errorProgressServer.port}/a2a/booking-copilot/turn`
const errorProgressRequest = {
  method: 'POST',
  headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json', accept: 'text/event-stream', 'x-booking-surface-version': SCHEMA_VERSION, 'x-booking-surface-schema-sha256': SCHEMA_SHA256 },
  body: JSON.stringify(turnFor('task-progress-error', 'ctx-progress-error')),
}
const firstErrorProgressResponse = await openSseRequest(errorProgressEndpoint, errorProgressRequest)
await Promise.race([
  firstErrorProgressResponse.firstEvents,
  new Promise<BookingSurfaceEvent[]>((_, reject) => setTimeout(() => reject(new Error('error_sse_progress_prefix_timeout')), 2_000)),
])
const concurrentErrorProgressResponse = await openSseRequest(errorProgressEndpoint, errorProgressRequest)
await Promise.race([
  concurrentErrorProgressResponse.firstEvents,
  new Promise<BookingSurfaceEvent[]>((_, reject) => setTimeout(() => reject(new Error('concurrent_error_sse_progress_prefix_timeout')), 2_000)),
])
releaseErrorProgressPlanner()
const errorProgressBody = await firstErrorProgressResponse.body
assert.deepEqual(parseSse(errorProgressBody).map((event) => event.kind), ['status', 'status', 'error'])
assert.equal(await concurrentErrorProgressResponse.body, errorProgressBody, 'concurrent identical error requests receive the same progress and final batch')
assert.equal(errorProgressPlannerCalls, 1, 'concurrent identical error requests enter the planner once')
await errorProgressServer.close()
errorProgressLedger.close()
rmSync(errorProgressRoot, { recursive: true, force: true })

async function assertImmediateDecisionFailureIsHandled(
  name: string,
  failure: 'planner-throw' | 'apply-throw',
  expectedCode: string,
): Promise<void> {
  const failureRoot = mkdtempSync(join(tmpdir(), `gotry-booking-server-${name}-`))
  const failureLedger = ensureLedger(failureRoot)
  const contextRef = `ctx-${name}`
  const taskId = `task-${name}`
  const failureRuntime = new BookingCopilotTaskRuntime(failureLedger, { contextRefFactory: () => contextRef })
  let plannerCalls = 0
  const failureServer = await startBookingCopilotServer({
    apiKey: API_KEY,
    runtime: failureRuntime,
    plannerFactory: () => ({
      async next() {
        plannerCalls += 1
        if (failure === 'planner-throw') throw new Error('raw provider failure must stay private')
        return [{
          kind: 'operation' as const,
          intent: { schemaVersion: 'booking.intent.v1' as const, target: 'results.refined' as const },
          action: {
            schemaVersion: 'booking.surface' as const,
            kind: 'results.view.patch' as const,
            actionId: `action-${name}`,
            contextRef,
            expectedRevision: 0,
            reason: 'Exercise immediate apply failure handling',
            factRefs: [],
            input: { patch: { sort: 'price_asc' as const } },
          },
        }]
      },
      async close() {},
    }),
  })
  const failureEndpoint = `http://127.0.0.1:${failureServer.port}/a2a/booking-copilot/turn`
  const failureRequest = {
    method: 'POST',
    headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json', accept: 'text/event-stream', 'x-booking-surface-version': SCHEMA_VERSION, 'x-booking-surface-schema-sha256': SCHEMA_SHA256 },
    body: JSON.stringify(turnFor(taskId, contextRef)),
  }
  const response = await fetch(failureEndpoint, failureRequest)
  const body = await response.text()
  const events = parseSse(body)
  assert.deepEqual(events.map((event) => event.kind), ['status', 'status', 'error'], `${name} remains a typed SSE response after progress`)
  const lastEvent = events.at(-1)
  assert.equal(lastEvent?.kind === 'error' ? lastEvent.error.code : '', expectedCode)
  assert.doesNotMatch(body, /typed runtime boundary/, 'the reported opaque boundary message is retired')
  const replay = await fetch(failureEndpoint, failureRequest)
  assert.equal(await replay.text(), body, `${name} replays the exact durable error batch`)
  assert.equal(plannerCalls, 1, `${name} enters the planner once`)
  await failureServer.close()
  failureLedger.close()
  rmSync(failureRoot, { recursive: true, force: true })
}

await assertImmediateDecisionFailureIsHandled('immediate-planner-throw', 'planner-throw', 'PLANNER_FAILED')
await assertImmediateDecisionFailureIsHandled('immediate-apply-throw', 'apply-throw', 'UNSUPPORTED_ACTION')

// A crash after the progress commit but before the planner's final decision
// reuses the same progress event identities after runtime reconstruction.
const crashProgressRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-server-progress-crash-'))
const crashProgressLedger = ensureLedger(crashProgressRoot)
const crashProgressRuntime = new BookingCopilotTaskRuntime(crashProgressLedger, { contextRefFactory: () => 'ctx-progress-crash' })
const crashTurn = { ...turnFor('task-progress-crash', 'ctx-progress-crash'), request: { text: 'crash after progress' } } as Parameters<BookingCopilotTaskRuntime['startTask']>[0]
crashProgressRuntime.startTask(crashTurn)
const crashRequestKey = 'turn:task-progress-crash:1'
const crashProgress = crashProgressRuntime.ensureProgressBatch('task-progress-crash', crashRequestKey, true)
const crashProgressIdentity = crashProgress.map((event) => [event.eventId, event.sequence])
crashProgressLedger.close()
const recoveredProgressLedger = ensureLedger(crashProgressRoot)
const recoveredProgressRuntime = new BookingCopilotTaskRuntime(recoveredProgressLedger, { contextRefFactory: () => 'ctx-progress-crash' })
assert.deepEqual(recoveredProgressRuntime.readProgressBatch('task-progress-crash', crashRequestKey)?.map((event) => [event.eventId, event.sequence]), crashProgressIdentity, 'crash recovery reuses durable progress event identities')
const recoveredFinal = recoveredProgressRuntime.applyDecisionBatch('task-progress-crash', crashRequestKey, [{ kind: 'terminal', terminal: { status: 'completed', summary: 'Recovered after progress.', factRefs: [] } }], false, { suppressProgressStatuses: true })
const recoveredCombined = [...(recoveredProgressRuntime.readProgressBatch('task-progress-crash', crashRequestKey) ?? []), ...recoveredFinal]
assert.deepEqual(recoveredCombined.map((event) => event.sequence), [1, 2, 3], 'crash recovery continues the sequence without duplicating progress')
recoveredProgressLedger.close()
rmSync(crashProgressRoot, { recursive: true, force: true })
progressLedger.close()
const reopenedProgressLedger = ensureLedger(progressRoot)
const progressRestartRuntime = new BookingCopilotTaskRuntime(reopenedProgressLedger, { contextRefFactory: () => 'ctx-progress' })
assert.deepEqual(progressRestartRuntime.readProgressBatch('task-progress-gated', progressRequestKey)?.map((event) => [event.eventId, event.sequence]), progressEvents.slice(0, 2).map((event) => [event.eventId, event.sequence]), 'progress batch survives a runtime restart with stable event identities')
reopenedProgressLedger.close()
rmSync(progressRoot, { recursive: true, force: true })

// A slow subprocess/session close is cleanup work, not part of the user-visible
// SSE critical path. The response must be writable while close is still gated.
let slowCloseStarted = false
let releaseSlowClose!: () => void
const slowCloseGate = new Promise<void>((resolve) => { releaseSlowClose = resolve })
const slowRuntime = new BookingCopilotTaskRuntime(ledger, {
  idFactory: (prefix) => `${prefix}-slow-${++nextId}`,
  now: () => '2026-08-30T12:02:00.000Z',
})
const slowServer = await startBookingCopilotServer({
  apiKey: API_KEY,
  runtime: slowRuntime,
  plannerFactory: () => ({
    async next() {
      return [{ kind: 'terminal', terminal: { status: 'completed', summary: 'Slow cleanup proof.', factRefs: [] } }]
    },
    async close() { slowCloseStarted = true; await slowCloseGate },
  }),
})
const slowEndpoint = `http://127.0.0.1:${slowServer.port}/a2a/booking-copilot/turn`
const slowResponse = await fetch(slowEndpoint, {
  method: 'POST',
  headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json', accept: 'text/event-stream', 'x-booking-surface-version': SCHEMA_VERSION, 'x-booking-surface-schema-sha256': SCHEMA_SHA256 },
  body: JSON.stringify(turnFor('task-slow-close', 'ctx-slow-close')),
  signal: AbortSignal.timeout(1_000),
})
const slowStartedAt = Date.now()
const slowBody = await slowResponse.text()
const slowElapsedMs = Date.now() - slowStartedAt
assert.equal(slowResponse.status, 200)
assert.match(slowBody, /event: terminal/)
assert.ok(slowElapsedMs < 500, `SSE response is not blocked by slow cleanup (${slowElapsedMs}ms)`)
await new Promise<void>((resolve) => setImmediate(resolve))
assert.equal(slowCloseStarted, true, 'terminal cleanup is scheduled before the SSE response ends')
releaseSlowClose()
await slowServer.close()

// A failed detached close remains sticky and is surfaced during shutdown;
// the request still returns its durable terminal event immediately. Session
// close is not assumed retryable because the real DSH session caches its close
// promise and a second call must not launder the first cleanup failure.
let failingCloseAttempts = 0
const cleanupErrorLogs: string[] = []
const originalConsoleError = console.error
console.error = (...args: unknown[]) => { cleanupErrorLogs.push(args.map(String).join(' ')) }
const retryRuntime = new BookingCopilotTaskRuntime(ledger, {
  idFactory: (prefix) => `${prefix}-retry-${++nextId}`,
  now: () => '2026-08-30T12:03:00.000Z',
})
const retryServer = await startBookingCopilotServer({
  apiKey: API_KEY,
  runtime: retryRuntime,
  plannerFactory: () => ({
    async next() {
      return [{ kind: 'terminal', terminal: { status: 'completed', summary: 'Retry cleanup proof.', factRefs: [] } }]
    },
    async close() {
      failingCloseAttempts += 1
      if (failingCloseAttempts === 1) throw new Error('injected cleanup failure')
    },
  }),
})
const retryResponse = await fetch(`http://127.0.0.1:${retryServer.port}/a2a/booking-copilot/turn`, {
  method: 'POST',
  headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json', accept: 'text/event-stream', 'x-booking-surface-version': SCHEMA_VERSION, 'x-booking-surface-schema-sha256': SCHEMA_SHA256 },
  body: JSON.stringify(turnFor('task-retry-close', 'ctx-retry-close')),
})
assert.equal(retryResponse.status, 200)
assert.match(await retryResponse.text(), /event: terminal/)
await new Promise<void>((resolve) => setImmediate(resolve))
assert.equal(failingCloseAttempts, 1, 'failed close is recorded without delaying the response')
await assert.rejects(retryServer.close(), /booking_copilot_server_close_failed/, 'shutdown surfaces the sticky detached cleanup failure')
assert.equal(failingCloseAttempts, 1, 'shutdown never retries a non-retryable session close')
console.error = originalConsoleError
assert.ok(cleanupErrorLogs.some((line) => line.includes('PLANNER_SESSION_CLOSE_FAILED')), 'cleanup failure is reported with a closed machine-readable code')

// Shutdown stops new turns while an accepted planner flight drains. A late
// request must not create a second planner execution after shutdown begins.
let flightStarted = false
let releaseFlight!: () => void
const flightGate = new Promise<void>((resolve) => { releaseFlight = resolve })
let flightPlannerCalls = 0
let flightStartedResolve!: () => void
const flightStartedSignal = new Promise<void>((resolve) => { flightStartedResolve = resolve })
const flightRuntime = new BookingCopilotTaskRuntime(ledger, {
  idFactory: (prefix) => `${prefix}-flight-${++nextId}`,
  now: () => '2026-08-30T12:04:00.000Z',
})
const flightServer = await startBookingCopilotServer({
  apiKey: API_KEY,
  runtime: flightRuntime,
  plannerFactory: () => ({
    async next() {
      flightPlannerCalls += 1
      flightStarted = true
      flightStartedResolve()
      await flightGate
      return [{ kind: 'terminal', terminal: { status: 'completed', summary: 'Shutdown flight proof.', factRefs: [] } }]
    },
    async close() {},
  }),
})
const flightEndpoint = `http://127.0.0.1:${flightServer.port}/a2a/booking-copilot/turn`
const flightResponsePromise = fetch(flightEndpoint, {
  method: 'POST',
  headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json', accept: 'text/event-stream', 'x-booking-surface-version': SCHEMA_VERSION, 'x-booking-surface-schema-sha256': SCHEMA_SHA256 },
  body: JSON.stringify(turnFor('task-shutdown-flight', 'ctx-shutdown-flight')),
})
await flightStartedSignal
assert.equal(flightStarted, true)
const shutdownPromise = flightServer.close()
const lateResponse = await fetch(flightEndpoint, {
  method: 'POST',
  headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json', accept: 'text/event-stream', 'x-booking-surface-version': SCHEMA_VERSION, 'x-booking-surface-schema-sha256': SCHEMA_SHA256 },
  body: JSON.stringify(turnFor('task-late-after-shutdown', 'ctx-late-after-shutdown')),
}).catch(() => null)
if (lateResponse) assert.equal(lateResponse.status, 503, 'shutdown rejects late turns before planner dispatch')
assert.equal(flightPlannerCalls, 1, 'late turn never executes a second planner flight')
releaseFlight()
const flightResponse = await flightResponsePromise
assert.equal(flightResponse.status, 200)
assert.match(await flightResponse.text(), /event: terminal/)
await shutdownPromise

// The deployed shape is the unified gotry-backend module, whose listener is
// owned by the kernel. Module shutdown must stop admission, drain an accepted
// turn and close its task session before the process planner/ledger.
const moduleStateRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-module-'))
let releaseModuleFlight!: () => void
const moduleFlightGate = new Promise<void>((resolve) => { releaseModuleFlight = resolve })
let moduleFlightStarted!: () => void
const moduleFlightSignal = new Promise<void>((resolve) => { moduleFlightStarted = resolve })
const moduleCloseOrder: string[] = []
const bookingModule = await startBookingCopilotModule({
  GOTRY_BOOKING_COPILOT_API_KEY: API_KEY,
  GOTRY_BOOKING_COPILOT_STATE_ROOT: moduleStateRoot,
  GOTRY_BOOKING_COPILOT_PORT: '0',
}, {
  ensureLedger,
  async createPlanner() {
    return {
      plannerFactory: () => ({
        async next() {
          moduleFlightStarted()
          await moduleFlightGate
          return [{ kind: 'terminal', terminal: { status: 'completed', summary: 'Unified module shutdown proof.', factRefs: [] } }]
        },
        async close() { moduleCloseOrder.push('session') },
      }),
      async close() { moduleCloseOrder.push('planner') },
    }
  },
})
const backend = await createBackendServer({ modules: [bookingModule], port: 0 })
const moduleEndpoint = `http://127.0.0.1:${backend.port}/a2a/booking-copilot/turn`
let backendClosed = false
try {
  const moduleResponsePromise = fetch(moduleEndpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json', accept: 'text/event-stream', 'x-booking-surface-version': SCHEMA_VERSION, 'x-booking-surface-schema-sha256': SCHEMA_SHA256 },
    body: JSON.stringify(turnFor('task-module-shutdown', 'ctx-module-shutdown')),
  })
  await moduleFlightSignal
  const moduleShutdown = closeBackend(backend, [bookingModule])
  const moduleLateResponse = await fetch(moduleEndpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json', accept: 'text/event-stream', 'x-booking-surface-version': SCHEMA_VERSION, 'x-booking-surface-schema-sha256': SCHEMA_SHA256 },
    body: JSON.stringify(turnFor('task-module-late', 'ctx-module-late')),
  })
  assert.equal(moduleLateResponse.status, 503, 'unified module rejects new turns while its kernel listener is still draining')
  releaseModuleFlight()
  const moduleResponse = await moduleResponsePromise
  assert.equal(moduleResponse.status, 200)
  assert.match(await moduleResponse.text(), /event: terminal/)
  await moduleShutdown
  backendClosed = true
  assert.deepEqual(moduleCloseOrder, ['session', 'planner'], 'unified module drains task sessions before closing the process planner')
} finally {
  releaseModuleFlight()
  if (!backendClosed) await closeBackend(backend, [bookingModule]).catch(() => undefined)
  rmSync(moduleStateRoot, { recursive: true, force: true })
}

await serverHandle.close()

const preRestartRuntime = new BookingCopilotTaskRuntime(ledger, {
  idFactory: (prefix) => `${prefix}-probe-${++nextId}`,
  now: () => '2026-08-30T12:01:00.000Z',
})
const recovered = preRestartRuntime.resumeTask('task-http-1')
assert.equal(recovered?.lastReceipt?.actionId, 'action-http-1', 'new server process seam restores task from last typed receipt')
assert.equal(recovered?.phase, 'terminal', 'the completed task stays durably terminal across restart')
const restarted = await startBookingCopilotServer({
  apiKey: API_KEY,
  runtime: preRestartRuntime,
  plannerFactory: (initialTask) => {
    assert.equal(initialTask.taskId, 'task-http-2')
    return { async next() { return [{ kind: 'terminal', terminal: { status: 'stopped', summary: 'Recovered.', factRefs: [] } }] } }
  },
})
const restartedEndpoint = `http://127.0.0.1:${restarted.port}/a2a/booking-copilot/turn`
const afterRestartResponse = await fetch(restartedEndpoint, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${API_KEY}`,
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'x-booking-surface-version': SCHEMA_VERSION,
    'x-booking-surface-schema-sha256': SCHEMA_SHA256,
  },
  body: JSON.stringify({ ...userTurn, taskId: 'task-http-2', turnId: 'http-restart-turn-1', workspace: { ...workspace, contextRef: 'ctx-http-2' } }),
})
assert.equal(afterRestartResponse.status, 200)
const restartEvents = parseSse(await afterRestartResponse.text())
assert.deepEqual(restartEvents.map((event) => event.kind), ['status', 'status', 'terminal'])
assert.deepEqual(restartEvents.map((event) => event.sequence), [1, 2, 3], 'the restarted process allocates fresh task-scoped sequences after recovering the ledger')

await restarted.close()
ledger.close()
rmSync(stateRoot, { recursive: true, force: true })
// The unified gotry-backend mounts the module, not the standalone startup: the
// planner deadline must be forwarded here too, or a deployment's declared value
// never reaches the serving path (measured: env had 45000, the metric still
// timed out at 12s because only startup.ts applied it).
{
  const deadlineStateRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-deadline-'))
  let seenPlannerTimeout: unknown
  const deadlineModule = await startBookingCopilotModule({
    GOTRY_BOOKING_COPILOT_API_KEY: API_KEY,
    GOTRY_BOOKING_COPILOT_STATE_ROOT: deadlineStateRoot,
    GOTRY_BOOKING_COPILOT_PORT: '0',
    GOTRY_BOOKING_COPILOT_PLANNER_TIMEOUT_MS: '45000',
  }, {
    ensureLedger,
    async createPlanner(options) {
      seenPlannerTimeout = (options as { turnTimeoutMs?: unknown }).turnTimeoutMs
      return {
        plannerFactory: () => ({ async next() { return [] }, async close() {} }),
        async close() {},
      }
    },
  })
  assert.equal(seenPlannerTimeout, 45000, 'the unified module forwards the planner deadline from the environment')
  await deadlineModule.close()
  rmSync(deadlineStateRoot, { recursive: true, force: true })
}

console.log('BOOKING COPILOT SERVER PROOF: BFF auth/typed SSE/task session/restart/no-token/no-text-action OK')
