/**
 * 进程级事故日志(D-NEW 护栏):fsync append-only JSONL。
 *
 * 目的: dsh 0.1.1-rc.1 只接 SIGINT/SIGTERM,缺 uncaughtException/unhandledRejection——
 * 任一插件 wasm/runtime 异常穿透到 node 层都会让整个 web UI 进程死亡,
 * 现场不存。这次(Z3 WASM mk_bool_var 崩溃)教训:连个取证都没有。
 *
 * 设计: 进程级 handler 同步写盘(fsync),尽量在进程被杀前留下事故证据。
 * handler 自身不再抛——再次抛出会绕过 handler,变成无声死亡。
 *
 * §11 状态面同步:事故日志是 gotry-state/incidents.jsonl,
 * 用户可见(README 第 x 节),可清理。
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

/**
 * 写入一条事故并 fsync。同步执行——handler 内异步无效。
 * 自身 try/catch 自保,不让写入失败再抛一次把进程杀掉。
 */
export function recordIncident(inc: Incident, stateRoot?: string): boolean {
  const target = stateRoot ? resolveIncidentsPath(stateRoot) : (logPath ?? resolveIncidentsPath('.'))
  try {
    ensureDir(target)
    appendFileSync(target, JSON.stringify(inc) + '\n', { flag: 'a' })
    // fsync: 让盘数据落定,免得被杀时缓冲丢
    const fd = require('node:fs').openSync(target, 'a')
    require('node:fs').fsyncSync(fd)
    require('node:fs').closeSync(fd)
    return true
  } catch {
    // 绝对不能在这里抛——我们正在处理已经抛过一次的进程级错误
    return false
  }
}

/**
 * 安装进程级护栏:进程整个生命周期仅生效一次(重复调用安全)。
 * 必须同步执行——异步发生在事件循环下一次,而 wasm 崩溃后已无下一轮。
 *
 * @returns 一个 disposer,卸载所有监听(测试场景使用)
 */
export function installProcessGuards(stateRoot: string, labels?: { uncaughtException?: string; unhandledRejection?: string }): () => void {
  if (installed) return () => { /* 已装,no-op */ }
  installed = true
  logPath = resolveIncidentsPath(stateRoot)

  const uncaughtHandler = (err: Error, origin: NodeJS.UncaughtExceptionOrigin | 'uncaughtException') => {
    recordIncident({
      ts: new Date().toISOString(),
      kind: 'uncaughtException',
      message: (err?.message ?? String(err)).slice(0, 2000),
      stack: (err?.stack ?? '').slice(0, 4000),
      source: labels?.uncaughtException ?? String(origin),
    }, stateRoot)
    // 不调用 process.exit——让 dsh/上级容器的重启策略负责;
    // 如果 dsh 不接住,我们至少留下事故记录。
  }

  const rejectionHandler = (reason: unknown, promise: Promise<unknown>) => {
    const msg = reason instanceof Error ? reason.message : String(reason)
    const stack = reason instanceof Error ? (reason.stack ?? '') : ''
    recordIncident({
      ts: new Date().toISOString(),
      kind: 'unhandledRejection',
      message: msg.slice(0, 2000),
      stack: stack.slice(0, 4000),
      source: labels?.unhandledRejection ?? 'promise',
    }, stateRoot)
  }

  process.on('uncaughtException', uncaughtHandler)
  process.on('unhandledRejection', rejectionHandler)
  return () => {
    process.off('uncaughtException', uncaughtHandler)
    process.off('unhandledRejection', rejectionHandler)
    installed = false
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
      const err = e instanceof Error ? e : new Error(String(e))
      recordIncident({
        ts: new Date().toISOString(),
        kind: 'tool_execute_error',
        message: `${name}: ${err.message}`.slice(0, 2000),
        stack: (err.stack ?? '').slice(0, 4000),
        source: name,
      }, stateRoot)
      return {
        ok: false,
        summary: `gotry_${name} 内部错误(已隔离,会话继续): ${err.message.slice(0, 300)}`,
        evidence: `[incident:tool_execute_error@${new Date().toISOString()}]`,
      } as R
    }
  }
}

/** CLI 调试:从命令行单独跑查看当前进程是否已挂护栏 */
if (import.meta.url === `file://${fileURLToPath(import.meta.url)}` && process.argv[2] === '--smoke') {
  const stateRoot = process.argv[3] ?? '.'
  installProcessGuards(stateRoot, { uncaughtException: 'smoke', unhandledRejection: 'smoke' })
  writeFileSync(resolveIncidentsPath(stateRoot) + '.smoke', 'ok')
  // 触发一次未捕获,应被写盘(不真正杀进程——进程继续跑完)
  setTimeout(() => Promise.reject(new Error('intentional smoke-rejection')), 50)
  setTimeout(() => { console.log('SMOKE OK'); process.exit(0) }, 500)
}
