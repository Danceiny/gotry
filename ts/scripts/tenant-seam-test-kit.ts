/**
 * Shared fixtures of the AaaS A2 seam suites: a fleet of replicas that serve the Booking Copilot surface in its
 * multi-tenant form over real HTTP, with a credential table standing in for the A3 authenticator, a scripted planner
 * standing in for the model, and the helpers to read what landed in each tenant's own ledger.
 *
 * Everything is offline and deterministic: manual clocks, a directory for the object store, SQLite lease files, one
 * state root per replica under a caller-owned temp directory. Nothing here reads the founder's runtime state.
 */

import assert from 'node:assert/strict'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BOOKING_SURFACE_SCHEMA_SHA256, BOOKING_SURFACE_SCHEMA_VERSION, type BookingCopilotTurn, type BookingSurfaceEvent } from '../src/booking-surface/contracts.ts'
import { type BookingPlannerDecision, type BookingPlannerSession, type BookingPlannerSessionFactory } from '../src/booking-surface/runtime.ts'
import { startBookingCopilotServer, type BookingCopilotServerHandle } from '../src/booking-surface/server.ts'
import { BookingTenancy, sharedPlannerProvider, type TenantPlannerContext, type TenantPlannerProvider } from '../src/booking-surface/tenancy.ts'
import { loadPriceTable } from '../src/llm-price-table.ts'
import type { BookingIngressBinding, BookingIngressPrincipal, IngressTurn } from '../src/booking-surface/contracts.ts'
import {
  deriveSeamTenant,
  StaticOrganizationKeyring,
  TenantQuotas,
  type AuthenticatedCaller,
  type CallerAuthenticator,
  type QuotaPolicy,
  type SeamTenant,
} from '../src/tenant-seam/index.ts'
import { DirDurableStore } from '../src/tenant-state/durable-store.ts'
import { SqliteLeaseStore } from '../src/tenant-state/lease-store.ts'
import { TenantRouter, type TenantHandle } from '../src/tenant-state/tenant-router.ts'
import { ManualClock } from './tenant-state-test-kit.ts'

export const TS_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
export const PRICE_TABLE = loadPriceTable(join(TS_ROOT, 'data', 'llm-price-table.json'))
export const MODEL = 'deepseek-v4-flash'
export const TTL = 10_000
export const MARGIN = 2_000

export const KEYRING = new StaticOrganizationKeyring({ acme: Buffer.alloc(32, 0x31), globex: Buffer.alloc(32, 0x32) })

/** Credential -> caller. This table is the test double of the A3 authenticator; the seam trusts nothing else. */
export const CALLERS: Record<string, AuthenticatedCaller> = {
  'cred-acme-alice': { organization: 'acme', issuer: 'https://idp.acme.example', subject: 'alice', scope: 'booking:read' },
  'cred-acme-bob': { organization: 'acme', issuer: 'https://idp.acme.example', subject: 'bob', scope: 'booking:read' },
  'cred-acme-carol': { organization: 'acme', issuer: 'https://idp.acme.example', subject: 'carol', scope: 'booking:read' },
  'cred-acme-alice-elsewhere': { organization: 'acme', issuer: 'https://other-idp.acme.example', subject: 'alice', scope: 'booking:read' },
  'cred-globex-alice': { organization: 'globex', issuer: 'https://idp.globex.example', subject: 'alice', scope: 'booking:read' },
}

export const ROOMY: QuotaPolicy = {
  tenant: {
    concurrentTurns: 4,
    turns: { limit: 1_000, windowMs: 60_000 },
    llm: { tokens: 1_000_000_000, costUsd: 1_000, windowMs: 3_600_000 },
    bridgeJobs: { limit: 100, windowMs: 60_000 },
    ledgerBytes: 1_000_000_000,
  },
  organization: {
    concurrentTurns: 16,
    turns: { limit: 10_000, windowMs: 60_000 },
    llm: { tokens: 1_000_000_000, costUsd: 1_000, windowMs: 3_600_000 },
    bridgeJobs: { limit: 1_000, windowMs: 60_000 },
    ledgerBytes: 1_000_000_000_000,
  },
  globalConcurrentTurns: 64,
  unprovenInvocation: { tokens: 10_000, costUsd: 0.05 },
}

export function tenantOf(credential: string): SeamTenant {
  const caller = CALLERS[credential]
  assert.ok(caller, `unknown test credential ${credential}`)
  return deriveSeamTenant(caller, KEYRING)
}

// ---- requests ---------------------------------------------------------------------------

export const workspace = (contextRef: string, currency = 'AED') => ({
  schemaVersion: 'booking.surface',
  contextRef,
  surface: 'tenant',
  revision: 0,
  locale: 'en-US',
  currency,
  searchDraft: {},
  results: { status: 'idle' },
  visibleHotels: [],
  loadedOffers: [],
  shortlistedOfferRefs: [],
  capabilities: { surface: 'tenant', allowedActions: ['search.run'] },
})

export const userTurn = (taskId: string, contextRef: string, text: string, currency = 'AED') => ({
  schemaVersion: 'booking.surface',
  kind: 'user.turn',
  taskId,
  turnId: `${taskId}-turn-1`,
  workspace: workspace(contextRef, currency),
  request: { text },
})

export const ingressTurn = (requestKey: string, taskHandle: string, text: string) => ({
  schemaVersion: 'booking.surface',
  kind: 'user.turn.ingress',
  requestKey,
  taskHandle,
  surfaceHint: 'tenant',
  workspace: { schemaVersion: 'booking.surface', revision: 0, locale: 'en-US', currency: 'AED', searchDraft: {}, results: { status: 'idle' }, visibleHotels: [], loadedOffers: [], shortlistedOfferRefs: [] },
  request: { text },
})

export interface Reply {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly text: string
}

export function sseEvents(text: string): Array<{ event: string; data: BookingSurfaceEvent & Record<string, unknown> }> {
  return text.split('\n\n').filter((block) => block.trim() !== '').map((block) => {
    const lines = block.split('\n')
    const event = lines.find((line) => line.startsWith('event: '))?.slice(7) ?? ''
    const data = lines.find((line) => line.startsWith('data: '))?.slice(6) ?? 'null'
    return { event, data: JSON.parse(data) as BookingSurfaceEvent & Record<string, unknown> }
  })
}

/** Every key name anywhere in a JSON value. */
export function keyNamesOf(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) keyNamesOf(item, into)
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      into.add(key)
      keyNamesOf(child, into)
    }
  }
  return into
}

// ---- the planner ----------------------------------------------------------------------

export interface PlannerCall {
  readonly taskId: string
  readonly contextRef: string
  readonly text: string
}

export interface Gate {
  readonly entered: Promise<void>
  open(): void
}

export function gate(): { gate: Gate; wait: Promise<void>; markEntered(): void } {
  let open!: () => void
  let entered!: () => void
  const wait = new Promise<void>((resolve) => { open = resolve })
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve })
  return { gate: { entered: enteredPromise, open }, wait, markEntered: entered }
}

export interface PlannerKit {
  readonly calls: PlannerCall[]
  factoryCalls: number
  closes: number
  /** Planner invocations whose text matches stay open until the gate does. */
  hold(textPattern: RegExp): Gate
  /** Opens every gate, so that a failed check cannot leave a request hanging a shutdown. */
  releaseAll(): void
  /** Replaces the decisions the planner returns. */
  script: ((call: { turn: BookingCopilotTurn; taskId: string; contextRef: string; revision: number; text: string }) => readonly BookingPlannerDecision[] | Promise<readonly BookingPlannerDecision[]>) | null
  readonly factory: BookingPlannerSessionFactory
}

function textOf(turn: BookingCopilotTurn): string {
  return turn.kind === 'user.turn' || turn.kind === 'user.turn.ingress' ? turn.request.text : ''
}

export function searchRunDecision(taskId: string, contextRef: string, revision: number, who: string): BookingPlannerDecision {
  return {
    kind: 'operation',
    action: {
      schemaVersion: 'booking.surface',
      kind: 'search.run',
      actionId: `action-${taskId}`,
      contextRef,
      expectedRevision: revision,
      reason: `Run the authoritative workspace search for ${who}`,
      factRefs: [],
      input: {},
    },
    intent: { schemaVersion: 'booking.intent.v1', target: 'search.results' },
  }
}

export function makePlanner(): PlannerKit {
  const holds: Array<{ pattern: RegExp; gate: ReturnType<typeof gate> }> = []
  const kit: PlannerKit = {
    calls: [],
    factoryCalls: 0,
    closes: 0,
    script: null,
    hold(pattern) {
      const held = gate()
      holds.push({ pattern, gate: held })
      return held.gate
    },
    releaseAll() {
      for (const held of holds) held.gate.gate.open()
    },
    factory: () => {
      kit.factoryCalls += 1
      const session: BookingPlannerSession = {
        async next({ turn, task }) {
          const text = textOf(turn)
          kit.calls.push({ taskId: task.taskId, contextRef: task.contextRef, text })
          for (const held of holds) {
            if (held.pattern.test(text)) {
              held.gate.markEntered()
              await held.gate.wait
            }
          }
          if (kit.script) return kit.script({ turn, taskId: task.taskId, contextRef: task.contextRef, revision: task.revision, text })
          // A receipt closes the task; anything else runs the search for whoever the text says it is for.
          if (turn.kind === 'action.receipt.continuation') {
            return [
              { kind: 'explanation', explanation: { text: 'The search ran.', factRefs: [] } },
              { kind: 'terminal', terminal: { status: 'completed', summary: 'Stopped at the requested search result.', factRefs: [] } },
            ]
          }
          return [searchRunDecision(task.taskId, task.contextRef, task.revision, text.split(' as ')[1] ?? 'anyone')]
        },
        async close() { kit.closes += 1 },
      }
      return session
    },
  }
  return kit
}

// ---- the fleet --------------------------------------------------------------------------------

export interface Fleet {
  readonly dir: string
  readonly storeClock: ManualClock
  readonly leases: SqliteLeaseStore
  readonly durable: DirDurableStore
  readonly clocks: ManualClock[]
  advance(ms: number, frozen?: readonly ManualClock[]): void
}

export function makeFleet(dir: string, cleanups: Array<() => void | Promise<void>>): Fleet {
  const storeClock = new ManualClock(1_000_000)
  const leases = new SqliteLeaseStore({ path: join(dir, 'leases.db'), nowMs: () => storeClock.nowMs() })
  cleanups.push(() => leases.close())
  const clocks: ManualClock[] = []
  return {
    dir,
    storeClock,
    leases,
    durable: new DirDurableStore(join(dir, 'durable')),
    clocks,
    advance(ms, frozen = []) {
      storeClock.advance(ms)
      for (const clock of clocks) if (!frozen.includes(clock)) clock.advance(ms)
    },
  }
}

export interface ServiceOptions {
  readonly policy?: QuotaPolicy
  readonly ingress?: boolean
  readonly planner?: PlannerKit
  readonly provider?: TenantPlannerProvider
  /** Wraps the tenancy the server is given (the service keeps the real one): a way to make one request fail in a chosen way. */
  readonly wrapTenancy?: (tenancy: BookingTenancy) => BookingTenancy
}

export interface Service {
  readonly id: string
  readonly stateRoot: string
  readonly router: TenantRouter
  readonly quotas: TenantQuotas
  readonly tenancy: BookingTenancy
  readonly planner: PlannerKit
  readonly clock: ManualClock
  readonly server: BookingCopilotServerHandle
  readonly endpoint: string
  /** The headers the authenticator was handed, one entry per call. */
  readonly seenHeaders: string[][]
  /** The principals the ingress binding was handed. */
  readonly bound: Array<{ requestKey: string; principal: BookingIngressPrincipal }>
  post(body: unknown, credential: string | null, extraHeaders?: Record<string, string>): Promise<Reply>
  /** Like `post`, but keeps whatever arrived before the connection ended, and says how it ended. */
  postRaw(body: unknown, credential: string, onData?: (chunk: string) => void): Promise<{ status: number; text: string; ended: 'end' | 'aborted' }>
  /** The live handle of a tenant on this replica, or `null` if this replica never opened it. */
  handleOf(credential: string): TenantHandle | null
  close(): Promise<void>
}

export async function makeService(fleet: Fleet, id: string, cleanups: Array<() => void | Promise<void>>, options: ServiceOptions = {}): Promise<Service> {
  const clock = new ManualClock(5_000)
  fleet.clocks.push(clock)
  const stateRoot = join(fleet.dir, 'nodes', id)
  const router = new TenantRouter({
    stateRoot, replicaId: id, leases: fleet.leases, durable: fleet.durable, ttlMs: TTL, marginMs: MARGIN, clock, autoRenew: false,
  })
  const quotas = new TenantQuotas({ policy: options.policy ?? ROOMY, priceTable: PRICE_TABLE, model: MODEL, clock: () => clock.nowMs() })
  const planner = options.planner ?? makePlanner()
  const seenHeaders: string[][] = []
  const bound: Array<{ requestKey: string; principal: BookingIngressPrincipal }> = []
  const authenticator: CallerAuthenticator = {
    authenticate(request) {
      seenHeaders.push(Object.keys(request.headers).sort())
      const match = /^Bearer (cred-[a-z0-9-]+)$/.exec(String(request.headers.authorization ?? ''))
      return match ? (CALLERS[match[1]!] ?? null) : null
    },
  }
  const binding: BookingIngressBinding = {
    bind(input: IngressTurn, principal: BookingIngressPrincipal) {
      bound.push({ requestKey: input.requestKey, principal: { ...principal } })
      return { taskId: 'task-bound', turnId: `turn-${input.requestKey}`, contextRef: 'ctx-bound', surface: 'tenant' as const, allowedActions: ['search.run' as const] }
    },
  }
  const tenancy = new BookingTenancy({
    authenticator,
    keyring: KEYRING,
    router,
    quotas,
    planners: options.provider ?? sharedPlannerProvider(planner.factory),
    ...(options.ingress ? { ingressBinding: binding } : {}),
  })
  const server = await startBookingCopilotServer({ tenancy: options.wrapTenancy ? options.wrapTenancy(tenancy) : tenancy, host: '127.0.0.1', port: 0 })
  const endpoint = `http://127.0.0.1:${server.port}/a2a/booking-copilot/turn`
  const schemaHeaders = { 'x-booking-surface-version': BOOKING_SURFACE_SCHEMA_VERSION, 'x-booking-surface-schema-sha256': BOOKING_SURFACE_SCHEMA_SHA256 }
  let closed = false
  const service: Service = {
    id, stateRoot, router, quotas, tenancy, planner, clock, server, endpoint, seenHeaders, bound,
    async post(body, credential, extraHeaders = {}) {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...schemaHeaders, ...(credential ? { authorization: `Bearer ${credential}` } : {}), ...extraHeaders },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      })
      const headers: IncomingHttpHeaders = {}
      response.headers.forEach((value, key) => { headers[key] = value })
      return { status: response.status, headers, text: await response.text() }
    },
    postRaw(body, credential, onData) {
      return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body)
        const req = httpRequest(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), authorization: `Bearer ${credential}`, ...schemaHeaders },
        }, (res) => {
          let text = ''
          res.setEncoding('utf8')
          res.on('data', (chunk: string) => { text += chunk; onData?.(chunk) })
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text, ended: 'end' }))
          res.on('aborted', () => resolve({ status: res.statusCode ?? 0, text, ended: 'aborted' }))
          res.on('error', () => resolve({ status: res.statusCode ?? 0, text, ended: 'aborted' }))
          res.on('close', () => resolve({ status: res.statusCode ?? 0, text, ended: res.complete ? 'end' : 'aborted' }))
        })
        req.on('error', reject)
        req.end(payload)
      })
    },
    handleOf(credential) {
      const tenant = tenantOf(credential)
      return router.handleOf(tenant.organization, tenant.ledgerTenant)
    },
    async close() {
      if (closed) return
      closed = true
      planner.releaseAll()
      await server.close().catch(() => undefined)
      await tenancy.close().catch(() => undefined)
    },
  }
  cleanups.push(() => service.close())
  return service
}

// ---- reading a tenant's own ledger ----------------------------------------------------------------

export interface EventRow {
  readonly seq: number
  readonly kind: string
  readonly run_id: string | null
  readonly idem_key: string | null
  readonly tenant_id: string
  readonly payload: string
}

/** All rows of a tenant's ledger, or `null` when this replica has not opened the tenant (so nothing was written here). */
export function rowsOf(service: Service, credential: string): EventRow[] | null {
  const handle = service.handleOf(credential)
  if (!handle) return null
  return handle.run((ledger) => ledger.db.prepare('SELECT seq, kind, run_id, idem_key, tenant_id, payload FROM events ORDER BY seq').all() as EventRow[])
}

export type { TenantPlannerContext }
