/**
 * booking-copilot 模块(gotry-backend 的能力单元之一;booking surface 能力)。
 *
 * 组装 = startup.ts 同款(ensureLedger → TaskRuntime → dsh planner),路由挂载 =
 * server.ts 摘出的 bookingCopilotTrafficHandler(与独立部署形态逐字一致:
 * POST /a2a/booking-copilot/turn + GET /healthz|/status 探活,Bearer apiKey,
 * schema 头校验)。ingress 固定 bound-turn-only(注入 seam 是部署级组合,本模块不携带)。
 */

import { mkdirSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { BackendModule } from '../kernel.ts'
import { ensureLedger, type StateLedger } from '../../state-ledger.ts'
import { BookingCopilotTaskRuntime } from '../../booking-surface/runtime.ts'
import {
  buildDshPlannerEnvironment,
  createDshEmbeddedBookingPlanner,
  type DshEmbeddedBookingPlannerHandle,
} from '../../booking-surface/dsh-planner.ts'
import {
  bookingCopilotTrafficHandler,
  runtimeIdentity,
  shutdownBookingCopilotTraffic,
  type BookingCopilotComposition,
} from '../../booking-surface/server.ts'
import { resolveBookingCopilotStartupConfig } from '../../booking-surface/startup.ts'

export interface BookingCopilotModule extends BackendModule {
  close(): Promise<void>
}

export interface BookingCopilotModuleDependencies {
  ensureLedger(stateRoot: string): StateLedger
  createPlanner(options: Parameters<typeof createDshEmbeddedBookingPlanner>[0]): Promise<DshEmbeddedBookingPlannerHandle>
}

const DEFAULT_DEPENDENCIES: BookingCopilotModuleDependencies = {
  ensureLedger,
  createPlanner: createDshEmbeddedBookingPlanner,
}

export async function startBookingCopilotModule(
  env: Record<string, string | undefined> = process.env,
  dependencies: BookingCopilotModuleDependencies = DEFAULT_DEPENDENCIES,
): Promise<BookingCopilotModule> {
  const config = resolveBookingCopilotStartupConfig(env)
  mkdirSync(config.stateRoot, { recursive: true })
  const ledger: StateLedger = dependencies.ensureLedger(config.stateRoot)
  let planner: DshEmbeddedBookingPlannerHandle | undefined
  try {
    planner = await dependencies.createPlanner({ stateRoot: config.stateRoot, env: buildDshPlannerEnvironment(env) })
  } catch (error) {
    try { ledger.close() } catch { /* 聚合首错优先 */ }
    throw error
  }
  const composition: BookingCopilotComposition = {
    runtime: new BookingCopilotTaskRuntime(ledger),
    plannerFactory: planner.plannerFactory,
    ingressMode: 'bff-bound-turn-only',
  }
  const traffic = bookingCopilotTrafficHandler({
    apiKey: config.apiKey,
    composition,
    maxBodyBytes: 1_000_000,
    ...(config.artifactId !== undefined ? { artifactId: config.artifactId } : {}),
    ingressMode: 'bff-bound-turn-only',
    runningIdentity: runtimeIdentity(),
  })
  const respond = (req: IncomingMessage, res: ServerResponse): Promise<void> => traffic(req, res)
  let closePromise: Promise<void> | undefined
  return {
    name: 'booking-copilot',
    routes: [
      { method: 'POST', path: '/a2a/booking-copilot/turn', handle: respond },
      { method: 'GET', path: '/healthz', handle: respond },
      { method: 'GET', path: '/status', handle: respond },
    ],
    async close() {
      if (!closePromise) {
        closePromise = (async () => {
          const failures: unknown[] = []
          try { await shutdownBookingCopilotTraffic(composition) } catch (error) { failures.push(error) }
          try { await planner.close() } catch (error) { failures.push(error) }
          try { ledger.close() } catch (error) { failures.push(error) }
          if (failures.length > 0) throw new AggregateError(failures, 'booking_copilot_module_close_failed')
        })()
      }
      return closePromise
    },
  }
}
