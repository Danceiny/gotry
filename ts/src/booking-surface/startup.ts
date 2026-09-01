/** Production composition entry for GoTry's BFF-only Booking Copilot server. */

import { mkdirSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureLedger, type StateLedger } from '../state-ledger.ts'
import {
  buildDshPlannerEnvironment,
  createDshEmbeddedBookingPlanner,
  createDshEmbeddedBookingPlannerV2,
  type DshEmbeddedBookingPlannerHandleV1,
  type DshEmbeddedBookingPlannerHandleV2,
  type DshEmbeddedBookingPlannerOptionsV1,
} from './dsh-planner.ts'
import { BookingCopilotTaskRuntime } from './runtime.ts'
import { BookingCopilotTaskRuntimeV2 } from './runtime-v2.ts'
import {
  startBookingCopilotServer,
  type BookingCopilotServerHandleV1,
  type BookingCopilotServerOptionsV1,
} from './server.ts'

export interface BookingCopilotStartupConfigV1 {
  apiKey: string
  stateRoot: string
  host: string
  port: number
  artifactId?: string
}

export interface BookingCopilotStartupHandleV1 {
  port: number
  close(): Promise<void>
}

export interface BookingCopilotStartupDependenciesV1 {
  ensureLedger(stateRoot: string): StateLedger
  runtimeFactory(ledger: StateLedger): BookingCopilotTaskRuntime
  createPlanner(options: DshEmbeddedBookingPlannerOptionsV1): Promise<DshEmbeddedBookingPlannerHandleV1>
  runtimeFactoryV2?: (ledger: StateLedger) => BookingCopilotTaskRuntimeV2
  createPlannerV2?: (options: DshEmbeddedBookingPlannerOptionsV1) => Promise<DshEmbeddedBookingPlannerHandleV2>
  startServer(options: BookingCopilotServerOptionsV1): Promise<BookingCopilotServerHandleV1>
}

const DEFAULT_DEPENDENCIES: BookingCopilotStartupDependenciesV1 = {
  ensureLedger,
  runtimeFactory: (ledger) => new BookingCopilotTaskRuntime(ledger),
  createPlanner: createDshEmbeddedBookingPlanner,
  runtimeFactoryV2: (ledger) => new BookingCopilotTaskRuntimeV2(ledger),
  createPlannerV2: createDshEmbeddedBookingPlannerV2,
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
): BookingCopilotStartupConfigV1 {
  const apiKey = env.GOTRY_BOOKING_COPILOT_API_KEY ?? ''
  if (!apiKey) throw new Error('booking_copilot_api_key_required')
  const stateRoot = env.GOTRY_BOOKING_COPILOT_STATE_ROOT ?? ''
  if (!stateRoot) throw new Error('booking_copilot_state_root_required')
  if (!isAbsolute(stateRoot)) throw new Error('booking_copilot_state_root_must_be_absolute')
  const artifactId = env.GOTRY_BOOKING_COPILOT_ARTIFACT_ID || undefined
  if (artifactId !== undefined && !/^[0-9a-f]{40}$/.test(artifactId)) {
    throw new Error('booking_copilot_artifact_id_invalid')
  }
  return {
    apiKey,
    stateRoot,
    host: env.GOTRY_BOOKING_COPILOT_HOST || '127.0.0.1',
    port: parsePort(env.GOTRY_BOOKING_COPILOT_PORT),
    artifactId,
  }
}

async function closeAll(
  server: BookingCopilotServerHandleV1 | undefined,
  planner: DshEmbeddedBookingPlannerHandleV1 | DshEmbeddedBookingPlannerHandleV2 | undefined,
  plannerV2: DshEmbeddedBookingPlannerHandleV2 | undefined,
  ledger: StateLedger | undefined,
): Promise<void> {
  const failures: unknown[] = []
  for (const close of [
    server ? () => server.close() : undefined,
    planner ? () => planner.close() : undefined,
    plannerV2 ? () => plannerV2.close() : undefined,
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
  dependencies: BookingCopilotStartupDependenciesV1 = DEFAULT_DEPENDENCIES,
): Promise<BookingCopilotStartupHandleV1> {
  const config = resolveBookingCopilotStartupConfig(env)
  mkdirSync(config.stateRoot, { recursive: true })
  let ledger: StateLedger | undefined
  let planner: DshEmbeddedBookingPlannerHandleV1 | undefined
  let plannerV2: DshEmbeddedBookingPlannerHandleV2 | undefined
  let server: BookingCopilotServerHandleV1 | undefined
  try {
    ledger = dependencies.ensureLedger(config.stateRoot)
    const plannerOptions = { stateRoot: config.stateRoot, env: buildDshPlannerEnvironment(env) }
    if (!dependencies.runtimeFactoryV2 || !dependencies.createPlannerV2) throw new Error('booking_copilot_v2_startup_dependency_missing')
    const runtime = dependencies.runtimeFactory(ledger)
    planner = await dependencies.createPlanner(plannerOptions)
    const runtimeV2 = dependencies.runtimeFactoryV2(ledger)
    plannerV2 = await dependencies.createPlannerV2(plannerOptions)
    server = await dependencies.startServer({
      apiKey: config.apiKey, runtime, plannerFactory: planner.plannerFactory,
      v2: { runtime: runtimeV2, plannerFactory: plannerV2.plannerFactory },
      host: config.host, port: config.port, artifactId: config.artifactId,
    })
  } catch (error) {
    try { await closeAll(server, planner, plannerV2, ledger) } catch (cleanupError) {
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
      await closeAll(server, planner, plannerV2, ledger)
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
