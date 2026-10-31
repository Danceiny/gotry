/** Production composition entry for GoTry's BFF-only Booking Copilot server. */

import { AsyncResource } from 'node:async_hooks'
import { mkdirSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureLedger, type StateLedger } from '../state-ledger.ts'
import {
  buildDshPlannerEnvironment,
  createDshEmbeddedBookingPlanner,
  type DshEmbeddedBookingPlannerHandle,
  type DshEmbeddedBookingPlannerOptions,
} from './dsh-planner.ts'
import { BookingCopilotTaskRuntime } from './runtime.ts'
import { BOOKING_COPILOT_INGRESS_MODES, type BookingCopilotIngressMode, type BookingIngressBinding, type BookingIngressPrincipal } from './contracts.ts'
import type { BookingTenancy, TenantPlannerProvider } from './tenancy.ts'
import type { ManagedDshResourceLimits } from './managed-dsh-run-port.ts'
import type { LlmTicketIssuer, LlmTicketOptions, LlmUsageReport } from '../tenant-seam/llm-broker.ts'
import { sharedProcessTreeGovernor } from '../tenant-seam/process-governor.ts'
import {
  startBookingCopilotServer,
  type BookingCopilotServerHandle,
  type BookingCopilotServerOptions,
} from './server.ts'

export interface BookingCopilotStartupConfig {
  apiKey: string
  stateRoot: string
  host: string
  port: number
  artifactId?: string
  /** Planner turn deadline in ms; the planner's own default applies when unset. */
  plannerTurnTimeoutMs?: number
  /** Defaults to bound-turn-only; a complete injected seam enables ingress. */
  ingressMode: BookingCopilotIngressMode
}

export interface BookingCopilotStartupHandle {
  port: number
  close(): Promise<void>
}

export interface BookingCopilotStartupDependencies {
  ensureLedger(stateRoot: string): StateLedger
  runtimeFactory(ledger: StateLedger): BookingCopilotTaskRuntime
  createPlanner(options: DshEmbeddedBookingPlannerOptions): Promise<DshEmbeddedBookingPlannerHandle>
  /** Optional in-process BFF identity seam; standalone use is bound-turn-only. */
  ingressBinding?: BookingIngressBinding
  principal?: BookingIngressPrincipal
  /**
   * The multi-tenant form (AaaS). When present, no shared ledger, runtime, planner or principal is created: every
   * request is authenticated and placed in its own tenant by the tenancy, which this process then owns and closes.
   */
  tenancy?: BookingTenancy
  startServer(options: BookingCopilotServerOptions): Promise<BookingCopilotServerHandle>
}

const DEFAULT_DEPENDENCIES: BookingCopilotStartupDependencies = {
  ensureLedger,
  runtimeFactory: (ledger) => new BookingCopilotTaskRuntime(ledger),
  createPlanner: createDshEmbeddedBookingPlanner,
  startServer: startBookingCopilotServer,
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 3_082
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0 || value > 65_535) throw new Error('booking_copilot_invalid_port')
  return value
}

/** Operator-tunable planner deadline; the bounds mirror the planner's own validation. */
function parsePlannerTurnTimeout(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1 || value > 120_000) {
    throw new Error('booking_copilot_planner_timeout_invalid')
  }
  return value
}

export function resolveBookingCopilotStartupConfig(
  env: Record<string, string | undefined> = process.env,
): BookingCopilotStartupConfig {
  const apiKey = env.GOTRY_BOOKING_COPILOT_API_KEY ?? ''
  if (!apiKey) throw new Error('booking_copilot_api_key_required')
  const stateRoot = env.GOTRY_BOOKING_COPILOT_STATE_ROOT ?? ''
  if (!stateRoot) throw new Error('booking_copilot_state_root_required')
  if (!isAbsolute(stateRoot)) throw new Error('booking_copilot_state_root_must_be_absolute')
  const artifactId = env.GOTRY_BOOKING_COPILOT_ARTIFACT_ID || undefined
  if (artifactId !== undefined && !/^[0-9a-f]{40}$/.test(artifactId)) {
    throw new Error('booking_copilot_artifact_id_invalid')
  }
  const rawIngressMode = env.GOTRY_BOOKING_COPILOT_INGRESS_MODE
  const ingressMode = rawIngressMode === undefined || rawIngressMode === '' ? 'bff-bound-turn-only' : rawIngressMode
  if (!(BOOKING_COPILOT_INGRESS_MODES as readonly string[]).includes(ingressMode)) {
    throw new Error('booking_copilot_ingress_mode_invalid')
  }
  return {
    apiKey,
    stateRoot,
    host: env.GOTRY_BOOKING_COPILOT_HOST || '127.0.0.1',
    port: parsePort(env.GOTRY_BOOKING_COPILOT_PORT),
    artifactId,
    plannerTurnTimeoutMs: parsePlannerTurnTimeout(env.GOTRY_BOOKING_COPILOT_PLANNER_TIMEOUT_MS),
    ingressMode: ingressMode as BookingCopilotIngressMode,
  }
}

export interface BookingCopilotTenantStartupConfig {
  host: string
  port: number
  artifactId?: string
  /** Set only when the environment names a mode explicitly; it must then agree with the tenancy. */
  ingressMode?: BookingCopilotIngressMode
}

/** The listener settings of the multi-tenant form. There is no deployment key and no shared state root: the tenancy holds both roles. */
export function resolveBookingCopilotTenantStartupConfig(
  env: Record<string, string | undefined> = process.env,
): BookingCopilotTenantStartupConfig {
  const artifactId = env.GOTRY_BOOKING_COPILOT_ARTIFACT_ID || undefined
  if (artifactId !== undefined && !/^[0-9a-f]{40}$/.test(artifactId)) {
    throw new Error('booking_copilot_artifact_id_invalid')
  }
  const rawIngressMode = env.GOTRY_BOOKING_COPILOT_INGRESS_MODE
  if (rawIngressMode !== undefined && rawIngressMode !== '' && !(BOOKING_COPILOT_INGRESS_MODES as readonly string[]).includes(rawIngressMode)) {
    throw new Error('booking_copilot_ingress_mode_invalid')
  }
  return {
    host: env.GOTRY_BOOKING_COPILOT_HOST || '127.0.0.1',
    port: parsePort(env.GOTRY_BOOKING_COPILOT_PORT),
    ...(artifactId === undefined ? {} : { artifactId }),
    ...(rawIngressMode === undefined || rawIngressMode === '' ? {} : { ingressMode: rawIngressMode as BookingCopilotIngressMode }),
  }
}

/**
 * Ceilings for each planner process tree in the multi-tenant form (docs/rfc/aaas-rfc.md §4.8, threat S-17). Every
 * tenant on a replica shares its CPU and memory, so one runaway child must be stopped by a limit and not by the
 * operating system's OOM killer. These numbers are a ceiling for a runaway, not a budget, and are unreviewed: they sit
 * well above what an idle booted planner tree costs (see docs/ops/aaas-capacity-baseline.md) and a deployment that
 * knows better passes its own `resourceLimits`.
 */
export const DEFAULT_TENANT_PLANNER_RESOURCE_LIMITS: ManagedDshResourceLimits = Object.freeze({
  heapMb: 512,
  maxRssBytes: 1536 * 1024 * 1024,
  maxCpuSeconds: 120,
  maxLineChars: 8 * 1024 * 1024,
})

/**
 * The sampler is the only thing between a runaway planner child and the replica. If it cannot see the process table, the
 * limits would silently govern nothing, so this fails first, with a name, before any child starts. Limits that need no
 * sampler (a heap ceiling, a line cap) have nothing to check.
 */
export async function assertPlannerLimitsEnforceable(limits: ManagedDshResourceLimits): Promise<void> {
  if (limits.maxRssBytes === undefined && limits.maxCpuSeconds === undefined) return
  await (limits.governor ?? sharedProcessTreeGovernor()).probe()
}

/**
 * One planner per tenant, each rooted in that tenant's own directory, so planner sessions and working files never sit
 * beside another tenant's. Planners are created lazily by the dsh adapter (no process starts until a session needs one).
 * The dsh adapter does not report token usage yet, so until it does every invocation is charged the quota policy's
 * worst case (`TenantQuotas.chargeUnprovenInvocation`).
 */
export function createDshTenantPlannerProvider(
  base: Omit<DshEmbeddedBookingPlannerOptions, 'stateRoot'>,
  createPlanner: (options: DshEmbeddedBookingPlannerOptions) => Promise<DshEmbeddedBookingPlannerHandle> = createDshEmbeddedBookingPlanner,
): TenantPlannerProvider {
  // The real dsh planner of the tenant form never holds the deployment's LLM credential (docs/rfc/aaas-rfc.md §4.8, S-18):
  // it is built with a broker that gives each planner process tree a ticket. A planner factory injected by a suite is
  // the caller's own business and is not asked for one.
  if (createPlanner === createDshEmbeddedBookingPlanner && base.llmTickets === undefined) {
    throw new Error('tenant_planner_credential_broker_required')
  }
  const handles: DshEmbeddedBookingPlannerHandle[] = []
  const realPlanner = createPlanner === createDshEmbeddedBookingPlanner
  let governable = false
  return {
    async forTenant(context) {
      if (realPlanner && !governable) {
        await assertPlannerLimitsEnforceable(base.resourceLimits ?? DEFAULT_TENANT_PLANNER_RESOURCE_LIMITS)
        governable = true
      }
      // Tickets issued for this tenant report their measured usage to this tenant's meter. The report is bound to the
      // async context where the ticket is issued, which is inside the planner invocation that needs the port: the broker
      // answers from its own request context, and the report must still land on the invocation that asked (and on no other).
      const issuer = base.llmTickets
      const llmTickets: LlmTicketIssuer | undefined = issuer && {
        issue: (options: LlmTicketOptions = {}) => issuer.issue({
          ...options,
          onUsage: AsyncResource.bind((report: LlmUsageReport) => context.reportUsage(report.model, report.usage)),
        }),
      }
      const handle = await createPlanner({
        ...base,
        ...(llmTickets ? { llmTickets } : {}),
        resourceLimits: base.resourceLimits ?? DEFAULT_TENANT_PLANNER_RESOURCE_LIMITS,
        // Both come from the tenant, never from the deployment-wide base: a shared label or root would defeat the point.
        cachePartition: context.cachePartition,
        stateRoot: context.tenantRoot,
      })
      handles.push(handle)
      return handle.plannerFactory
    },
    async close() {
      const failures: unknown[] = []
      for (const handle of handles.splice(0)) {
        try { await handle.close() } catch (error) { failures.push(error) }
      }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'booking_copilot_planner_shutdown_failed')
    },
  }
}

async function startTenantCopilot(
  env: Record<string, string | undefined>,
  dependencies: BookingCopilotStartupDependencies,
  tenancy: BookingTenancy,
): Promise<BookingCopilotStartupHandle> {
  if (dependencies.ingressBinding || dependencies.principal) throw new Error('booking_copilot_tenancy_shared_conflict')
  const config = resolveBookingCopilotTenantStartupConfig(env)
  if (config.ingressMode !== undefined && config.ingressMode !== tenancy.ingressMode) throw new Error('booking_copilot_ingress_mode_conflict')
  let server: BookingCopilotServerHandle
  try {
    server = await dependencies.startServer({
      tenancy,
      ingressMode: tenancy.ingressMode,
      host: config.host,
      port: config.port,
      ...(config.artifactId === undefined ? {} : { artifactId: config.artifactId }),
    })
  } catch (error) {
    try { await tenancy.close() } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'booking_copilot_startup_and_cleanup_failed')
    }
    throw error
  }
  let closed = false
  return {
    port: server.port,
    async close() {
      if (closed) return
      closed = true
      const failures: unknown[] = []
      // Stop taking turns and drain the ones in flight first; then give the tenants back (planners, then leases).
      try { await server.close() } catch (error) { failures.push(error) }
      try { await tenancy.close() } catch (error) { failures.push(error) }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'booking_copilot_shutdown_failed')
    },
  }
}

async function closeAll(
  server: BookingCopilotServerHandle | undefined,
  planner: DshEmbeddedBookingPlannerHandle | undefined,
  ledger: StateLedger | undefined,
): Promise<void> {
  const failures: unknown[] = []
  for (const close of [
    server ? () => server.close() : undefined,
    planner ? () => planner.close() : undefined,
    ledger ? () => Promise.resolve(ledger.close()) : undefined,
  ]) {
    if (!close) continue
    try { await close() } catch (error) { failures.push(error) }
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'booking_copilot_shutdown_failed')
}

/**
 * Boot one process-scoped dsh core and task-scoped sessions behind the typed
 * HTTP/SSE server. Only the HTTP layer receives the BFF deployment key.
 */
export async function startBookingCopilotFromEnvironment(
  env: Record<string, string | undefined> = process.env,
  dependencies: BookingCopilotStartupDependencies = DEFAULT_DEPENDENCIES,
): Promise<BookingCopilotStartupHandle> {
  if (dependencies.tenancy) return startTenantCopilot(env, dependencies, dependencies.tenancy)
  const config = resolveBookingCopilotStartupConfig(env)
  const activeDependencies = dependencies
  const hasIngressBinding = Boolean(activeDependencies.ingressBinding)
  const hasPrincipal = Boolean(activeDependencies.principal)
  if (hasIngressBinding !== hasPrincipal) throw new Error('booking_copilot_ingress_binding_pair_required')
  const ingressPair = hasIngressBinding && hasPrincipal
  if (ingressPair && env.GOTRY_BOOKING_COPILOT_INGRESS_MODE !== undefined && config.ingressMode === 'bff-bound-turn-only') {
    throw new Error('booking_copilot_ingress_mode_conflict')
  }
  if (!ingressPair && config.ingressMode === 'bff-ingress-binding') throw new Error('booking_copilot_ingress_binding_required')
  if (ingressPair && (typeof activeDependencies.ingressBinding?.bind !== 'function'
    || typeof activeDependencies.principal?.subject !== 'string' || activeDependencies.principal.subject.length === 0 || activeDependencies.principal.subject.length > 256
    || typeof activeDependencies.principal?.scope !== 'string' || activeDependencies.principal.scope.length === 0 || activeDependencies.principal.scope.length > 256)) {
    throw new Error('booking_copilot_ingress_binding_invalid')
  }
  const activeIngressMode: BookingCopilotIngressMode = ingressPair ? 'bff-ingress-binding' : 'bff-bound-turn-only'
  mkdirSync(config.stateRoot, { recursive: true })
  let ledger: StateLedger | undefined
  let planner: DshEmbeddedBookingPlannerHandle | undefined
  let server: BookingCopilotServerHandle | undefined
  try {
    ledger = dependencies.ensureLedger(config.stateRoot)
    const plannerOptions = {
      stateRoot: config.stateRoot,
      env: buildDshPlannerEnvironment(env),
      ...(config.plannerTurnTimeoutMs === undefined ? {} : { turnTimeoutMs: config.plannerTurnTimeoutMs }),
    }
    const runtime = activeDependencies.runtimeFactory(ledger)
    planner = await activeDependencies.createPlanner(plannerOptions)
    server = await activeDependencies.startServer({
      apiKey: config.apiKey, runtime, plannerFactory: planner.plannerFactory,
      ...(ingressPair ? { ingressBinding: activeDependencies.ingressBinding, principal: activeDependencies.principal } : {}),
      ingressMode: activeIngressMode,
      host: config.host, port: config.port, artifactId: config.artifactId,
    })
  } catch (error) {
    try { await closeAll(server, planner, ledger) } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'booking_copilot_startup_and_cleanup_failed')
    }
    throw error
  }

  let closed = false
  return {
    port: server.port,
    async close() {
      if (closed) return
      closed = true
      await closeAll(server, planner, ledger)
    },
  }
}

async function runCli(): Promise<void> {
  const handle = await startBookingCopilotFromEnvironment()
  process.stderr.write(`[gotry-booking-copilot] listening on http://127.0.0.1:${handle.port}/a2a/booking-copilot/turn\n`)
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    void handle.close().then(() => process.exit(0), (error) => {
      process.stderr.write(`[gotry-booking-copilot] shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(1)
    })
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`[gotry-booking-copilot] startup failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
