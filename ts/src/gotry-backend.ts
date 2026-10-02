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
 *     GOTRY_SESSION_TRANSPORT=cdp、CHROME_USER_DATA_DIR、GOTRY_SESSION_AUDIT_PATH、
 *     GOTRY_BACKEND_STATE_ROOT(桥作业账本根,缺省 '.';账本文件 <stateRoot>/gotry-state/bridge.db)
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

/**
 * #511:服务运行时启动阶段标记。四类启动标记(CORE_BOOT_STAGE/CORE_BOOT_FAILURE/
 * HARNESS_BOOT_TIMEOUT/PLANNER_BOOT_TIMEOUT)此前只存在于构建期 proof 脚本输出,
 * 服务进程从不打印——「复发即定位」在运行时面不成立。行形状与 proof 脚本同族
 * (`标记 + JSON`),字段封闭(phase/module/port/elapsedMs),不含密钥/凭证。
 */
export function formatBackendBootStage(phase: string, detail: Record<string, unknown>): string {
  return `CORE_BOOT_STAGE ${JSON.stringify({ phase, ...detail })}`
}

/** 启动失败行:数组形状与 booking-surface-package-proof 的 CORE_BOOT_FAILURE 对齐;error 只留有界摘要 */
export function formatBackendBootFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return `CORE_BOOT_FAILURE ${JSON.stringify([{ phase: 'startup', error: message.slice(0, 200) }])}`
}

export function resolveGotryBackendPort(env: Record<string, string | undefined>): number {
  const raw = env.GOTRY_BACKEND_PORT ?? env.GOTRY_BOOKING_COPILOT_PORT
  if (raw === undefined) return 3082
  if (!/^(?:0|[1-9][0-9]{0,4})$/.test(raw)) throw new Error('gotry_backend_invalid_port')
  const port = Number(raw)
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error('gotry_backend_invalid_port')
  return port
}

export async function startGotryBackendFromEnvironment(
  env: Record<string, string | undefined> = process.env,
  log: (line: string) => void = (line) => { process.stderr.write(`${line}\n`) },
): Promise<GotryBackendHandle> {
  const bootStartedAt = Date.now()
  const bootStage = (phase: string, detail: Record<string, unknown>): void => {
    try {
      log(formatBackendBootStage(phase, { elapsedMs: Date.now() - bootStartedAt, ...detail }))
    } catch { /* 启动阶段行不反噬启动本身 */ }
  }
  // 失败标记也必须由本函数发:编译产物 bin/gotry-backend.js 包装层直接调用这里,
  // 源码形态 runCli 的 catch 在 bin 形态不可达(#511 的失败面要在服务运行时可见)
  const bootFailure = (error: unknown): void => {
    try {
      log(formatBackendBootFailure(error))
    } catch { /* 同上 */ }
  }
  const modules: BackendModule[] = []
  try {
    modules.push(await startBookingCopilotModule(env))
    bootStage('module_mounted', { module: 'booking-copilot' })
    modules.push(startSessionSearchModule({
      apiKey: () => env.GOTRY_BACKEND_SESSION_API_KEY ?? '',
      auditPath: env.GOTRY_SESSION_AUDIT_PATH,
      // 批次 A「桥作业账本化」:挂载路径桥队列/在飞/节律/客户端注册落 SQLite
      // (<stateRoot>/gotry-state/bridge.db),重启经 recoverOnBoot 收敛,不丢在飞作业。
      stateRoot: env.GOTRY_BACKEND_STATE_ROOT ?? '.',
    }))
    bootStage('module_mounted', { module: 'session-search' })
    modules.push(startBookingExecutorModule({
      apiKey: () => env.GOTRY_BACKEND_BOOKING_API_KEY ?? '',
      evidenceDir: () => env.GOTRY_BACKEND_EVIDENCE_DIR ?? '/var/lib/gotry-backend/booking-evidence',
    }))
    bootStage('module_mounted', { module: 'booking-executor' })
    const handle = await createBackendServer({
      modules,
      host: env.GOTRY_BACKEND_HOST ?? '127.0.0.1',
      port: resolveGotryBackendPort(env),
    })
    bootStage('listening', { port: handle.port, modules: handle.moduleNames.join(',') })
    return {
      port: handle.port,
      moduleNames: handle.moduleNames,
      close: () => closeBackend(handle, modules),
    }
  } catch (error) {
    bootFailure(error)
    throw error
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
    // CORE_BOOT_FAILURE 标记已在 startGotryBackendFromEnvironment 的失败路径落过
    // (#511);这里补源码 CLI 形态的可读行
    process.stderr.write(`[gotry-backend] startup failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
