/**
 * BFF-only typed HTTP/SSE seam proof.
 *
 * Run with Node 24 from the repository root:
 *   npx --yes --package=node@24 --package=tsx --call \
 *     'tsx ts/scripts/booking-copilot-server-proof-tests.ts'
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureLedger } from '../src/state-ledger.ts'
import { BookingCopilotTaskRuntime, type BookingSurfaceEventV1 } from '../src/booking-surface/runtime.ts'
import {
  startBookingCopilotServer,
  type BookingPlannerSessionFactoryV1,
} from '../src/booking-surface/server.ts'
import { BOOKING_SURFACE_SCHEMA_SHA256, BOOKING_SURFACE_SCHEMA_VERSION } from '../src/booking-surface/contracts.ts'

const API_KEY = 'server-to-server-key'
const SCHEMA_VERSION = BOOKING_SURFACE_SCHEMA_VERSION
const SCHEMA_SHA256 = BOOKING_SURFACE_SCHEMA_SHA256
const stateRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-server-'))
const ledger = ensureLedger(stateRoot)
let nextId = 0
const runtime = new BookingCopilotTaskRuntime(ledger, {
  idFactory: (prefix) => `${prefix}-${++nextId}`,
  now: () => '2026-08-30T12:00:00.000Z',
})

let factoryCalls = 0
let sessionTurns = 0
const plannerFactory: BookingPlannerSessionFactoryV1 = (initialTask) => {
  factoryCalls += 1
  assert.equal(initialTask.taskId, 'task-http-1')
  return {
    async next({ task }) {
      sessionTurns += 1
      if (sessionTurns === 1) {
        return [{
          kind: 'operation',
          action: {
            schemaVersion: 'booking.surface.v1',
            kind: 'search.run',
            actionId: 'action-http-1',
            contextRef: task.contextRef,
            expectedRevision: task.revision,
            reason: 'Run the authoritative workspace search',
            factRefs: [],
            input: {},
          },
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
  }
}

const serverHandle = await startBookingCopilotServer({
  apiKey: API_KEY,
  runtime,
  plannerFactory,
})
const endpoint = `http://127.0.0.1:${serverHandle.port}/a2a/booking-copilot/turn`

const workspace = {
  schemaVersion: 'booking.surface.v1',
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
  schemaVersion: 'booking.surface.v1',
  kind: 'user.turn',
  taskId: 'task-http-1',
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

const noAuth = await fetch(endpoint, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(userTurn),
})
assert.equal(noAuth.status, 401, 'server-to-server key is fail-closed')

const missingSchemaHeaders = await post(userTurn, `Bearer ${API_KEY}`, {})
assert.equal(missingSchemaHeaders.status, 409, 'schema version/hash headers are required')
const wrongSchemaHash = await post(userTurn, `Bearer ${API_KEY}`, {
  'x-booking-surface-version': SCHEMA_VERSION,
  'x-booking-surface-schema-sha256': '0'.repeat(64),
})
assert.equal(wrongSchemaHash.status, 409, 'schema drift is rejected before planning')

const directIngress = await post({
  schemaVersion: 'booking.surface.v1',
  kind: 'user.turn.ingress',
  surfaceHint: 'tenant',
  workspace: { ...workspace, contextRef: undefined, surface: undefined, capabilities: undefined },
  request: { text: 'browser must use same-origin BFF' },
})
assert.equal(directIngress.status, 400, 'GoTry server rejects unbound browser ingress')

const tokenSmuggle = await post({ ...userTurn, portalToken: 'ST:must-not-cross-boundary' })
assert.equal(tokenSmuggle.status, 400, 'strict planner turn rejects portal token fields')

const first = await post(userTurn)
assert.equal(first.status, 200)
assert.match(String(first.headers.get('content-type')), /text\/event-stream/)
assert.equal(first.headers.get('x-booking-surface-version'), SCHEMA_VERSION)
assert.equal(first.headers.get('x-booking-surface-schema-sha256'), SCHEMA_SHA256)

function parseSse(body: string): BookingSurfaceEventV1[] {
  return body.trim().split('\n\n').map((frame) => {
    const data = frame.split('\n').find((line) => line.startsWith('data: '))
    assert.ok(data, `SSE frame has data: ${frame}`)
    return JSON.parse(data.slice('data: '.length)) as BookingSurfaceEventV1
  })
}

const firstEvents = parseSse(await first.text())
assert.deepEqual(firstEvents.map((event) => event.kind), ['status', 'status', 'operation'])
assert.ok(firstEvents.every((event) => event.contextRef === workspace.contextRef), 'every typed event carries BFF-minted contextRef')
const operation = firstEvents[2]
assert.equal(operation?.kind, 'operation')
assert.equal(factoryCalls, 1)
assert.equal(sessionTurns, 1)

const receiptTurn = {
  schemaVersion: 'booking.surface.v1',
  kind: 'action.receipt.continuation',
  taskId: 'task-http-1',
  workspace: {
    ...workspace,
    revision: 1,
    results: { status: 'ready', resultCount: 2, searchSessionRef: 'search-http-1' },
  },
  receipt: {
    schemaVersion: 'booking.surface.v1',
    kind: 'action.receipt',
    actionId: 'action-http-1',
    contextRef: workspace.contextRef,
    status: 'applied',
    revision: 1,
    observation: { kind: 'search.state', searchSessionRef: 'search-http-1', resultCount: 2 },
    resultContract: { outcome: 'complete', hardCriteriaMet: true, factRefs: [], gapCodes: [] },
  },
}
const second = await post(receiptTurn)
assert.equal(second.status, 200)
const secondEvents = parseSse(await second.text())
assert.deepEqual(secondEvents.map((event) => event.kind), ['status', 'explanation', 'terminal'])
assert.equal(factoryCalls, 1, 'one task reuses one planner session across receipt continuations')
assert.equal(sessionTurns, 2)
assert.ok(!secondEvents.some((event) => event.kind === 'operation'), 'JSON-looking explanation text is not parsed into an operation')
assert.ok(secondEvents[0]!.sequence > firstEvents.at(-1)!.sequence, 'SSE sequence is monotonic across turns')

await serverHandle.close()

let recoveredLastReceipt = false
const restarted = await startBookingCopilotServer({
  apiKey: API_KEY,
  runtime: new BookingCopilotTaskRuntime(ledger, {
    idFactory: (prefix) => `${prefix}-restart-${++nextId}`,
    now: () => '2026-08-30T12:01:00.000Z',
  }),
  plannerFactory: (initialTask) => {
    recoveredLastReceipt = initialTask.lastReceipt?.actionId === 'action-http-1'
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
  body: JSON.stringify({ ...userTurn, workspace: receiptTurn.workspace }),
})
assert.equal(afterRestartResponse.status, 200)
assert.equal(recoveredLastReceipt, true, 'new server process seam restores task from last typed receipt')
const restartEvents = parseSse(await afterRestartResponse.text())
assert.ok(restartEvents[0]!.sequence > secondEvents.at(-1)!.sequence, 'sequence resumes from durable ledger after server restart')

await restarted.close()
ledger.close()
rmSync(stateRoot, { recursive: true, force: true })
console.log('BOOKING COPILOT SERVER PROOF: BFF auth/typed SSE/task session/restart/no-token/no-text-action OK')
