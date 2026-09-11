/**
 * gotry-backend 统一入口(founder 口径:「我只允许一个 gotry 包装出来的服务」)。
 *
 * 一个进程、一个 HTTP 服务面;能力 = 模块(booking-copilot、session-search,后续
 * a2a 协议端口亦归此服务),模块自带鉴权/探活,内核只做路由分发。hotel-be 是
 * 外层 BFF,只认本服务。
 *
 * 端口:GOTRY_BACKEND_PORT > GOTRY_BOOKING_COPILOT_PORT > 3082(向后兼容:
 * 默认与既有 booking-copilot 部署同端口,路由合同不变,hotel-be BFF 零改动)。
 *
 * 环境变量:
 *   booking-copilot 模块:GOTRY_BOOKING_COPILOT_API_KEY/STATE_ROOT/INGRESS_MODE/
 *     ARTIFACT_ID + DEEPSEEK/LLM keys(dsh planner,同独立部署)
 *   session-search 模块:GOTRY_BACKEND_SESSION_API_KEY(缺 = 该模块 fail-closed 503)、
 *     GOTRY_SESSION_TRANSPORT=cdp、CHROME_USER_DATA_DIR、GOTRY_SESSION_AUDIT_PATH
 *
 * 运行:node bin/gotry-backend.js(编译产物)或 tsx ts/src/gotry-backend.ts(源码形态)。
 */

import { startBookingCopilotModule } from './backend/modules/booking-copilot.ts'
import { startBookingExecutorModule } from './backend/modules/booking-executor.ts'
import { startSessionSearchModule } from './backend/modules/session-search.ts'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { closeBackend, createBackendServer, type BackendModule } from './backend/kernel.ts'

export interface GotryBackendHandle {
  port: number
  moduleNames: string[]
  close(): Promise<void>
}

export async function startGotryBackendFromEnvironment(
  env: Record<string, string | undefined> = process.env,
): Promise<GotryBackendHandle> {
  const modules: BackendModule[] = []
  modules.push(await startBookingCopilotModule(env))
  modules.push(startSessionSearchModule({
    apiKey: () => env.GOTRY_BACKEND_SESSION_API_KEY ?? '',
    auditPath: env.GOTRY_SESSION_AUDIT_PATH,
  }))
  modules.push(startBookingExecutorModule({
    apiKey: () => env.GOTRY_BACKEND_BOOKING_API_KEY ?? '',
    evidenceDir: () => env.GOTRY_BACKEND_EVIDENCE_DIR ?? '/var/lib/gotry-backend/booking-evidence',
  }))
  const port = Number(env.GOTRY_BACKEND_PORT ?? env.GOTRY_BOOKING_COPILOT_PORT ?? 3082)
  const handle = await createBackendServer({
    modules,
    host: env.GOTRY_BACKEND_HOST ?? '127.0.0.1',
    port: Number.isSafeInteger(port) && port > 0 ? port : 3082,
  })
  return {
    port: handle.port,
    moduleNames: handle.moduleNames,
    close: () => closeBackend(handle, modules),
  }
}

async function runCli(): Promise<void> {
  const handle = await startGotryBackendFromEnvironment()
  process.stderr.write(`[gotry-backend] listening on http://127.0.0.1:${handle.port}; modules=${handle.moduleNames.join(',')}\n`)
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    void handle.close().then(() => process.exit(0), (error) => {
      process.stderr.write(`[gotry-backend] shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(1)
    })
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`[gotry-backend] startup failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
