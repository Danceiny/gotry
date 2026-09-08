/**
 * Z3 WASM 运行时单例(README Known limitations「Z3 WASM race」的根治面)。
 *
 * 历史:engine/journey/unified 三模块各自 `init().Context('main')`:
 *   - 一进程内并存 2-3 份独立 WASM 实例(内存放大;系统压力下 2GB 堆分配失败的 OOM 形态);
 *   - 候选求解用 Promise.all 并发多候选共享同一 Context,z3-solver 的 async API
 *     (Asyncify)不允许并发 unwind,交错即栈损坏 → `memory access out of bounds`
 *     (run-all §1 重试止血的真因;rc.4 曾试统一单例但残留自建 Context 触发 mismatch 被回滚)。
 *
 * #227 补充:
 *   - getZ3 必须在第一个 await 之前缓存 Promise,否则冷启动并发会创建多个 Context 对象;
 *   - z3-solver 5.2.0 high-level FinalizationRegistry 的 cleanup 直接调用 low-level
 *     `dec_ref`/`*_dec_ref`,不经过 GoTry `withZ3`。V8 判定对象不可达的时机保持不变;
 *     GoTry 只在 Z3 会话活跃时把实际 native cleanup 推迟到会话 settle 后同步 drain,
 *     防止 GC cleanup 与 check()/AST 构造并发碰同一 WASM heap。
 *
 * 现在的口径:三模块全部 import 本模块——单一 WASM 实例 + 单一 Context + 会话级
 * 互斥(await chain 占链)。低层 cleanup 队列是局部包装,不替换全局 FinalizationRegistry,
 * 不主动 free 仍可达对象;显式 release/GC finalizer 仍由 z3-solver 的所有权语义决定。
 */

import { AsyncLocalStorage } from 'node:async_hooks'

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Z3Ctx = any

type Z3Api = {
  Context: (name: string) => Z3Ctx
  Z3: Record<string, any>
}

type DeferredCleanup = {
  name: string
  args: any[]
  invoke: () => void
}

export interface Z3LifecycleStats {
  initAttempts: number
  contextsCreated: number
  concurrentDecRefEnabled: number
  sessionsStarted: number
  sessionsSettled: number
  cleanupWrappedFunctions: string[]
  asyncWrappedFunctions: string[]
  cleanupQueueLimit: number
  activeNativeCalls: number
  nativeCleanupCalls: Record<string, number>
  deferredCleanupCalls: Record<string, number>
  drainedCleanupCalls: Record<string, number>
  maxDeferredQueueDepth: number
  currentDeferredQueueDepth: number
  poisoned: string | null
}

const MAX_DEFERRED_CLEANUPS = parseCleanupQueueLimit()
const ASYNC_LOW_LEVEL_CALLS = new Set([
  'simplify', 'simplify_ex', 'eval_smtlib2_string',
  'tactic_apply', 'tactic_apply_ex',
  'solver_check', 'solver_check_assumptions', 'solver_get_consequences', 'solver_cube',
  'algebraic_roots', 'algebraic_eval',
  'fixedpoint_query', 'fixedpoint_query_relations', 'fixedpoint_query_from_lvl',
  'optimize_check', 'polynomial_subresultants',
])
const nestedSession = new AsyncLocalStorage<string>()
const cleanupWrappedFunctions = new Set<string>()
const asyncWrappedFunctions = new Set<string>()
const nativeCleanupCalls: Record<string, number> = {}
const deferredCleanupCalls: Record<string, number> = {}
const drainedCleanupCalls: Record<string, number> = {}
const deferredCleanups: DeferredCleanup[] = []
const nativeIdleWaiters: Array<() => void> = []

let z3Promise: Promise<Z3Ctx> | null = null
let z3SessionActive = false
let activeNativeCalls = 0
let z3Poisoned: { error: Error; fatalNative: boolean } | null = null
let maxDeferredQueueDepth = 0
const lifecycleStats = {
  initAttempts: 0,
  contextsCreated: 0,
  concurrentDecRefEnabled: 0,
  sessionsStarted: 0,
  sessionsSettled: 0,
}
/** 求解互斥链:后到会话排队等前一会话完全 settle(成败皆放行,不吞异常) */
let chain: Promise<unknown> = Promise.resolve()

function incCounter(counters: Record<string, number>, name: string): void {
  counters[name] = (counters[name] ?? 0) + 1
}

function parseCleanupQueueLimit(): number {
  const raw = process.env.GOTRY_Z3_CLEANUP_QUEUE_LIMIT ?? '2000000'
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) throw new Error(`GOTRY_Z3_CLEANUP_QUEUE_LIMIT must be a positive integer: ${raw}`)
  return value
}

function poisonZ3(error: unknown, fatalNative = false): Error {
  const err = error instanceof Error ? error : new Error(String(error))
  if (!z3Poisoned) z3Poisoned = { error: err, fatalNative }
  else z3Poisoned.fatalNative = z3Poisoned.fatalNative || fatalNative
  return err
}

function poisonMessage(): string | null {
  return z3Poisoned ? z3Poisoned.error.message : null
}

function hasFatalNativePoison(): boolean {
  return z3Poisoned ? z3Poisoned.fatalNative : false
}

function callNativeCleanup(name: string, invoke: () => void, fromDrain: boolean): Error | null {
  try {
    invoke()
    if (fromDrain) incCounter(drainedCleanupCalls, name)
    return null
  } catch (error) {
    const err = poisonZ3(error, isFatalZ3Error(error))
    // This wrapper can be reached from z3-solver's FinalizationRegistry cleanup.
    // Never throw from the cleanup call-site; surface the poison at the next controlled withZ3 entry.
    return err
  }
}

function deferNativeCleanup(cleanup: DeferredCleanup): void {
  deferredCleanups.push(cleanup)
  incCounter(deferredCleanupCalls, cleanup.name)
  if (deferredCleanups.length > maxDeferredQueueDepth) maxDeferredQueueDepth = deferredCleanups.length
  if (deferredCleanups.length > MAX_DEFERRED_CLEANUPS) {
    poisonZ3(new Error(`Z3 cleanup queue overflow (${deferredCleanups.length}/${MAX_DEFERRED_CLEANUPS})`), false)
  }
}

function beginNativeCall(): void {
  activeNativeCalls += 1
}

function finishNativeCall(): void {
  activeNativeCalls -= 1
  if (activeNativeCalls < 0) {
    activeNativeCalls = 0
    poisonZ3(new Error('Z3 native async call counter underflow'))
  }
  if (activeNativeCalls === 0) {
    for (const resolve of nativeIdleWaiters.splice(0)) resolve()
    if (!z3SessionActive && !hasFatalNativePoison()) drainDeferredCleanups()
  }
}

async function waitForNativeIdle(): Promise<void> {
  if (activeNativeCalls === 0) return
  await new Promise<void>(resolve => nativeIdleWaiters.push(resolve))
}

function trackNativePromise<T>(name: string, promise: Promise<T>): Promise<T> {
  return promise.then(
    value => value,
    error => {
      if (isFatalZ3Error(error)) poisonZ3(error, true)
      throw error
    },
  ).finally(() => finishNativeCall())
}

function drainDeferredCleanups(): Error | null {
  let firstError: Error | null = null
  while (deferredCleanups.length > 0) {
    const cleanup = deferredCleanups.pop()!
    const err = callNativeCleanup(cleanup.name, cleanup.invoke, true)
    if (!err) continue
    if (!firstError) firstError = err
    if (hasFatalNativePoison()) {
      deferredCleanups.push(cleanup)
      break
    }
  }
  return firstError
}

function installZ3RuntimeGuards(Z3: Record<string, any>): void {
  for (const name of Object.keys(Z3)) {
    if (ASYNC_LOW_LEVEL_CALLS.has(name)) {
      const original = Z3[name]
      if (typeof original === 'function' && !(original as any).__gotryNativeAsyncWrapped) {
        const wrapped = (...args: any[]) => {
          beginNativeCall()
          let result: unknown
          try {
            result = original(...args)
          } catch (error) {
            if (isFatalZ3Error(error)) poisonZ3(error, true)
            finishNativeCall()
            throw error
          }
          if (result instanceof Promise) return trackNativePromise(name, result)
          finishNativeCall()
          return result
        }
        Object.defineProperty(wrapped, '__gotryNativeAsyncWrapped', { value: true })
        Z3[name] = wrapped
        asyncWrappedFunctions.add(name)
      }
    }

    if (name !== 'dec_ref' && !name.endsWith('_dec_ref')) continue
    const original = Z3[name]
    if (typeof original !== 'function' || (original as any).__gotryCleanupQueueWrapped) continue
    const wrapped = (...args: any[]) => {
      incCounter(nativeCleanupCalls, name)
      const invoke = () => original(...args)
      if (hasFatalNativePoison() || z3SessionActive || activeNativeCalls > 0) {
        deferNativeCleanup({ name, args, invoke })
        return undefined
      }
      return callNativeCleanup(name, invoke, false)
    }
    Object.defineProperty(wrapped, '__gotryCleanupQueueWrapped', { value: true })
    Z3[name] = wrapped
    cleanupWrappedFunctions.add(name)
  }
}

/** Initialize one shared Context and install the local low-level cleanup queue. */
export async function initZ3Context(loadInit: () => Promise<Z3Api>): Promise<Z3Ctx> {
  lifecycleStats.initAttempts += 1
  const api = await loadInit()
  installZ3RuntimeGuards(api.Z3)
  const ctx = api.Context('main')
  lifecycleStats.contextsCreated += 1
  if (typeof api.Z3.enable_concurrent_dec_ref !== 'function') {
    throw new Error('z3-solver low-level API missing enable_concurrent_dec_ref; refusing unsafe Z3 context')
  }
  api.Z3.enable_concurrent_dec_ref(ctx.ptr)
  lifecycleStats.concurrentDecRefEnabled += 1
  return ctx
}

export async function getZ3(): Promise<Z3Ctx> {
  // 延迟到首次实际求解才加载:避免 dsh 加载 GoTry 模块时启动 WASM worker。
  // Promise 必须在第一个 await 之前写入缓存,防冷启动并发创建多 Context。
  if (!z3Promise) {
    z3Promise = (async () => {
      const { init } = await import('z3-solver')
      return initZ3Context(init)
    })().catch(error => {
      z3Promise = null
      throw error
    })
  }
  return z3Promise
}

/** Z3 求解会话互斥门:全程独占 WASM 实例,防 Asyncify 并发 unwind(栈损坏根因)。 */
export async function withZ3<T>(label: string, session: (z3: Z3Ctx) => Promise<T>): Promise<T> {
  const outer = nestedSession.getStore()
  if (outer) throw new Error(`nested withZ3 is forbidden (${outer} -> ${label})`)
  const z3 = await getZ3()
  const turn = chain.then(() => nestedSession.run(label, () => runZ3Session(label, z3, session)))
  // 链推进到本会话 settlement(吞掉的只是链上对前序错误的转发,异常仍从本会话返回值抛出)
  chain = turn.then(() => undefined, () => undefined)
  return turn
}

async function runZ3Session<T>(label: string, z3: Z3Ctx, session: (z3: Z3Ctx) => Promise<T>): Promise<T> {
  if (poisonMessage()) throw new Error(`Z3 context is poisoned; refusing new solve (${poisonMessage()})`)
  lifecycleStats.sessionsStarted += 1
  z3SessionActive = true
  let value: T | undefined
  let sessionFailed = false
  let sessionError: unknown
  let cleanupError: Error | null = null
  try {
    value = await session(z3)
  } catch (error) {
    sessionFailed = true
    sessionError = error
  } finally {
    await waitForNativeIdle()
    if (sessionFailed && isFatalZ3Error(sessionError)) poisonZ3(sessionError, true)
    z3SessionActive = false
    cleanupError = hasFatalNativePoison() ? null : drainDeferredCleanups()
    lifecycleStats.sessionsSettled += 1
  }
  if (sessionFailed) {
    if (cleanupError && typeof sessionError === 'object' && sessionError !== null) {
      ;(sessionError as { z3CleanupError?: Error }).z3CleanupError = cleanupError
    }
    throw sessionError
  }
  if (cleanupError) throw cleanupError
  if (poisonMessage()) throw new Error(`Z3 context is poisoned after ${label}; refusing result reuse (${poisonMessage()})`)
  return value as T
}

function isFatalZ3Error(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return /memory access out of bounds|corrupted (?:its )?heap memory|RuntimeError: Aborted|abort\(Runtime error/i.test(text)
}

export function getZ3LifecycleStats(): Z3LifecycleStats {
  return {
    ...lifecycleStats,
    cleanupWrappedFunctions: [...cleanupWrappedFunctions].sort(),
    asyncWrappedFunctions: [...asyncWrappedFunctions].sort(),
    cleanupQueueLimit: MAX_DEFERRED_CLEANUPS,
    activeNativeCalls,
    nativeCleanupCalls: { ...nativeCleanupCalls },
    deferredCleanupCalls: { ...deferredCleanupCalls },
    drainedCleanupCalls: { ...drainedCleanupCalls },
    maxDeferredQueueDepth,
    currentDeferredQueueDepth: deferredCleanups.length,
    poisoned: poisonMessage(),
  }
}
