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
} from '../../booking-surface/server.ts'
import { resolveBookingCopilotStartupConfig } from '../../booking-surface/startup.ts'

export interface BookingCopilotModule extends BackendModule {
  close(): Promise<void>
}

export async function startBookingCopilotModule(
  env: Record<string, string | undefined> = process.env,
): Promise<BookingCopilotModule> {
  const config = resolveBookingCopilotStartupConfig(env)
  mkdirSync(config.stateRoot, { recursive: true })
  const ledger: StateLedger = ensureLedger(config.stateRoot)
  let planner: DshEmbeddedBookingPlannerHandle | undefined
  try {
    planner = await createDshEmbeddedBookingPlanner({ stateRoot: config.stateRoot, env: buildDshPlannerEnvironment(env) })
  } catch (error) {
    try { ledger.close() } catch { /* 聚合首错优先 */ }
    throw error
  }
  const traffic = bookingCopilotTrafficHandler({
    apiKey: config.apiKey,
    composition: {
      runtime: new BookingCopilotTaskRuntime(ledger),
      plannerFactory: planner.plannerFactory,
      ingressMode: 'bff-bound-turn-only',
    },
    maxBodyBytes: 1_000_000,
    ...(config.artifactId !== undefined ? { artifactId: config.artifactId } : {}),
    ingressMode: 'bff-bound-turn-only',
    runningIdentity: runtimeIdentity(),
  })
  const respond = (req: IncomingMessage, res: ServerResponse): Promise<void> => traffic(req, res)
  return {
    name: 'booking-copilot',
    routes: [
      { method: 'POST', path: '/a2a/booking-copilot/turn', handle: respond },
      { method: 'GET', path: '/healthz', handle: respond },
      { method: 'GET', path: '/status', handle: respond },
    ],
    async close() {
      await planner.close()
      ledger.close()
    },
  }
}
