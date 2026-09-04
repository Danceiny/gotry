/** Production composition entry for GoTry's BFF-only Booking Copilot server. */

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
    ingressMode: ingressMode as BookingCopilotIngressMode,
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
    const plannerOptions = { stateRoot: config.stateRoot, env: buildDshPlannerEnvironment(env) }
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
