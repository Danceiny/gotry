/**
 * Z3 WASM 运行时单例(README Known limitations「Z3 WASM race」的根治面)。
 *
 * 历史:engine/journey/unified 三模块各自 `init().Context('main')`:
 *   - 一进程内并存 2-3 份独立 WASM 实例(内存放大;系统压力下 2GB 堆分配失败的 OOM 形态);
 *   - 候选求解用 Promise.all 并发多候选共享同一 Context,z3-solver 的 async API
 *     (Asyncify)不允许并发 unwind,交错即栈损坏 → `memory access out of bounds`
 *     (run-all §1 重试止血的真因;rc.4 曾试统一单例但残留自建 Context 触发 mismatch 被回滚)。
 *
 * 现在的口径:三模块全部 import 本模块——单一 WASM 实例 + 单一 Context + 会话级
 * 互斥(await chain 占链)。无并发交错,无跨 Context AST(单 Context 内同名 const
 * 返回同一 AST,各自 Solver 只挂自己的断言集,eval 互不相干——原语义不变)。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Z3Ctx = any

let z3Promise: Promise<Z3Ctx> | null = null
/** 求解互斥链:后到会话排队等前一会话完全 settle(成败皆放行,不吞异常) */
let chain: Promise<unknown> = Promise.resolve()

export async function getZ3(): Promise<Z3Ctx> {
  // 延迟到首次实际求解才加载:避免 dsh 加载 GoTry 模块时启动 WASM worker,
  // 引起 worker 线程内存冲突(z3-built.wasm 多线程 unsafe)。
  if (!z3Promise) {
    const { init } = await import('z3-solver')
    z3Promise = (async () => (await init()).Context('main'))()
  }
  return z3Promise
}

/** Z3 求解会话互斥门:全程独占 WASM 实例,防 Asyncify 并发 unwind(栈损坏根因)。 */
export async function withZ3<T>(label: string, session: (z3: Z3Ctx) => Promise<T>): Promise<T> {
  const z3 = await getZ3()
  const turn = chain.then(() => session(z3))
  // 链推进到本会话 settlement(吞掉的只是链上对前序错误的转发,异常仍从本会话返回值抛出)
  chain = turn.then(() => undefined, () => undefined)
  return turn
}