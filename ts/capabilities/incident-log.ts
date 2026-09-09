/**
 * 进程级事故日志(D-NEW):同步、durable 的 JSONL 诊断记录。
 *
 * `uncaughtExceptionMonitor` 只观察 fatal 事故并留下证据；宿主仍决定
 * 是否退出。GoTry 不吞掉 fatal 事件、不调用 process.exit、也不隐式重启。
 * 工具 execute 的业务失败仍由 guardToolExecute 转成结构化失败返回。
 *
 * §11 状态面同步:事故日志是 gotry-state/incidents.jsonl,
 * 用户可见、可清理。
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ToolFailure } from '../src/tool-packet.ts'

export type IncidentKind = 'uncaughtException' | 'unhandledRejection' | 'plugin_error' | 'tool_execute_error'

export interface Incident {
  ts: string
  kind: IncidentKind
  message: string
  stack?: string
  /** 来自哪个来源(plugin_name / service url 等) */
  source?: string
}

/** 解析 gotry-state 绝对路径(stateRoot 可相对也可绝对) */
export function resolveIncidentsPath(stateRoot: string, filename = 'incidents.jsonl'): string {
  const root = isAbsolute(stateRoot)
    ? stateRoot
    : join(process.cwd(), stateRoot)
  return join(root, 'gotry-state', filename)
}

function ensureDir(path: string): void {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

let installed = false
let logPath: string | null = null
let activeMonitor: ((err: Error, origin: NodeJS.UncaughtExceptionOrigin) => void) | null = null

function safeErrorMessage(value: unknown): string {
  try {
    if (value instanceof Error) return typeof value.message === 'string' ? value.message : '[error-without-message]'
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint' || typeof value === 'symbol') return String(value)
    const json = JSON.stringify(value)
    return typeof json === 'string' ? json : '[unprintable-error]'
  } catch {
    return '[unprintable-error]'
  }
}

function safeErrorStack(value: unknown): string {
  try {
    const stack = (value as { stack?: unknown } | null | undefined)?.stack
    return typeof stack === 'string' ? stack : ''
  } catch {
    return ''
  }
}

/**
 * 写入一条事故并 fsync。整个 append 使用同一个 fd，并保证所有失败路径
 * 都尝试 close；返回 true 只表示写入、fsync、close 全部成功。
 */
export function recordIncident(inc: Incident, stateRoot?: string): boolean {
  const target = stateRoot ? resolveIncidentsPath(stateRoot) : (logPath ?? resolveIncidentsPath('.'))
  let fd: number | undefined
  let closeAttempted = false
  try {
    ensureDir(target)
    fd = openSync(target, 'a')
    writeFileSync(fd, JSON.stringify(inc) + '\n', { encoding: 'utf8' })
    fsyncSync(fd)
    closeAttempted = true
    closeSync(fd)
    fd = undefined
    return true
  } catch {
    // 事故处理中的诊断失败绝不能再次抛出。
    return false
  } finally {
    if (fd !== undefined && !closeAttempted) {
      closeAttempted = true
      try { closeSync(fd) } catch { /* best effort close on a failed write */ }
    }
  }
}

/**
 * 安装进程级事故观察器。只挂 monitor，不改变 Node/dsh 的 fatal 行为。
 * 进程整个生命周期仅生效一次；disposer 供宿主卸载和测试使用。
 */
export function installProcessGuards(stateRoot: string, labels?: { uncaughtException?: string; unhandledRejection?: string }): () => void {
  if (installed) return () => { /* 已装,no-op */ }
  installed = true
  logPath = resolveIncidentsPath(stateRoot)

  const monitor = (err: Error, origin: NodeJS.UncaughtExceptionOrigin) => {
    try {
      const kind: IncidentKind = origin === 'unhandledRejection' ? 'unhandledRejection' : 'uncaughtException'
      const source = kind === 'unhandledRejection'
        ? (labels?.unhandledRejection ?? 'promise')
        : (labels?.uncaughtException ?? origin)
      recordIncident({
        ts: new Date().toISOString(),
        kind,
        message: safeErrorMessage(err).slice(0, 2000),
        stack: safeErrorStack(err).slice(0, 4000),
        source,
      }, stateRoot)
    } catch {
      // Formatting must never replace the original fatal event. Keep a final
      // plain fallback attempt for diagnostics, while the host retains control.
      try {
        recordIncident({
          ts: new Date().toISOString(),
          kind: origin === 'unhandledRejection' ? 'unhandledRejection' : 'uncaughtException',
          message: '[incident-observer-fallback]',
          source: 'incident-observer',
        }, stateRoot)
      } catch { /* observer is strictly best effort */ }
    }
  }

  process.on('uncaughtExceptionMonitor', monitor)
  activeMonitor = monitor
  let active = true
  return () => {
    if (!active) return
    active = false
    if (activeMonitor !== monitor) return
    process.off('uncaughtExceptionMonitor', monitor)
    installed = false
    logPath = null
    activeMonitor = null
  }
}

/**
 * 工具执行面异常隔离(D-NEW gotry 侧收尾):dsh 的一个工具 execute 抛错/拒绝
 * 会沿 cordis 传到主循环,拖垮整个会话。包装后:降级为结构化错误返回给 LLM、
 * 事故落盘,永不向上抛。落盘失败也不抛(双保险,仍返回结构化错误)。
 */
export function guardToolExecute<A, R>(name: string, stateRoot: string, execute: (args: A, exec: unknown) => R | Promise<R>): (args: A, exec: unknown) => Promise<R> {
  return async (args: A, exec: unknown): Promise<R> => {
    try {
      return await execute(args, exec)
    } catch (e) {
      const message = safeErrorMessage(e)
      recordIncident({
        ts: new Date().toISOString(),
        kind: 'tool_execute_error',
        message: `${name}: ${message}`.slice(0, 2000),
        stack: safeErrorStack(e).slice(0, 4000),
        source: name,
      }, stateRoot)
      const failure: ToolFailure = {
        ok: false,
        summary: `gotry_${name} 内部错误(已隔离,会话继续): ${message.slice(0, 300)}`,
        evidence: `[incident:tool_execute_error@${new Date().toISOString()}]`,
      }
      return failure as R
    }
  }
}

/** CLI 调试:最小 fatal 子进程会留下事故证据并按 Node 原生语义非零退出。 */
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url && process.argv[2] === '--smoke') {
  const stateRoot = process.argv[3] ?? '.'
  installProcessGuards(stateRoot, { uncaughtException: 'smoke', unhandledRejection: 'smoke' })
  setTimeout(() => { throw new Error('intentional smoke-uncaught') }, 50)
}
