/**
 * Z3 lifecycle contract for issue #227.
 *
 * Runtime proof, not source-regex proof: it uses the real shared z3-solver
 * Context, low-level wrapper stats, and live objects crossing withZ3 sessions.
 */

import assert from 'node:assert/strict'
import { getZ3, getZ3LifecycleStats, initZ3Context, withZ3 } from '../src/z3-shared.ts'

function counter(stats: ReturnType<typeof getZ3LifecycleStats>, bucket: 'nativeCleanupCalls' | 'deferredCleanupCalls' | 'drainedCleanupCalls', name: string): number {
  return stats[bucket][name] ?? 0
}

const NativeFinalizationRegistry = globalThis.FinalizationRegistry
const registryEvents: string[] = []
const fakePtr = { fake: 'ctx' }
const fakeCtx = await initZ3Context(async () => {
  assert.equal(globalThis.FinalizationRegistry, NativeFinalizationRegistry, 'init await window must not replace global FinalizationRegistry')
  const registry = new FinalizationRegistry(() => registryEvents.push('unrelated-cleanup'))
  registry.register({ unrelated: true }, 'held')
  await Promise.resolve()
  assert.equal(globalThis.FinalizationRegistry, NativeFinalizationRegistry, 'global FinalizationRegistry identity must stay stable after await')
  return {
    Context(name: string) {
      assert.equal(name, 'main')
      return { ptr: fakePtr }
    },
    Z3: {
      enable_concurrent_dec_ref(ptr: unknown) {
        assert.equal(ptr, fakePtr)
      },
    },
  }
})
assert.equal(fakeCtx.ptr, fakePtr)
assert.deepEqual(registryEvents, [], 'unrelated FinalizationRegistry must keep normal non-forced semantics')
assert.equal(globalThis.FinalizationRegistry, NativeFinalizationRegistry)

await assert.rejects(
  initZ3Context(async () => ({
    Context() { return { ptr: {} } },
    Z3: {},
  })),
  /missing enable_concurrent_dec_ref/,
)

const beforeCold = getZ3LifecycleStats()
const contexts = await Promise.all(Array.from({ length: 8 }, () => getZ3()))
assert.equal(new Set(contexts).size, 1, 'concurrent cold getZ3 must return the exact same Context object')
const afterCold = getZ3LifecycleStats()
assert.equal(afterCold.contextsCreated - beforeCold.contextsCreated, 1, 'cold start must create exactly one real Context')
assert.equal(afterCold.concurrentDecRefEnabled - beforeCold.concurrentDecRefEnabled, 1, 'concurrent dec-ref hook must run once for the real Context')
assert.ok(afterCold.cleanupWrappedFunctions.includes('dec_ref'), 'AST cleanup entry must be wrapped locally')
assert.ok(afterCold.cleanupWrappedFunctions.includes('solver_dec_ref'), 'Solver cleanup entry must be wrapped locally')
assert.ok(afterCold.cleanupWrappedFunctions.includes('model_dec_ref'), 'Model cleanup entry must be wrapped locally')
assert.ok(afterCold.cleanupWrappedFunctions.includes('optimize_dec_ref'), 'Optimize cleanup entry must be wrapped locally')
assert.ok(afterCold.cleanupWrappedFunctions.includes('ast_vector_dec_ref'), 'AstVector cleanup entry must be wrapped locally')
assert.ok(afterCold.asyncWrappedFunctions.includes('solver_check_assumptions'), 'Solver.check native async entry must be tracked')
assert.ok(afterCold.asyncWrappedFunctions.includes('optimize_check'), 'Optimize.check native async entry must be tracked')

const beforeDefer = getZ3LifecycleStats()
const queued = await withZ3('z3-lifecycle.defer-explicit-release', async z3 => {
  const s = new z3.Solver()
  s.add(z3.Bool.val(true))
  s.release()
  const stats = getZ3LifecycleStats()
  assert.ok(stats.currentDeferredQueueDepth > 0, 'release during active withZ3 must be queued, not run inline')
  return stats.currentDeferredQueueDepth
})
assert.ok(queued > 0)
const afterDefer = getZ3LifecycleStats()
assert.equal(afterDefer.currentDeferredQueueDepth, 0, 'queued cleanup must drain after withZ3 settles')
assert.ok(counter(afterDefer, 'deferredCleanupCalls', 'solver_dec_ref') > counter(beforeDefer, 'deferredCleanupCalls', 'solver_dec_ref'))
assert.ok(counter(afterDefer, 'drainedCleanupCalls', 'solver_dec_ref') > counter(beforeDefer, 'drainedCleanupCalls', 'solver_dec_ref'))

const retained = await withZ3('z3-lifecycle.retain-live-owner', async z3 => {
  const x = z3.Int.const('life_retained_x')
  const solver = new z3.Solver()
  solver.add(x.eq(7))
  assert.equal(await solver.check(), 'sat')
  const model = solver.model()
  return { x, solver, model }
})
const afterRetain = getZ3LifecycleStats()
assert.equal(afterRetain.currentDeferredQueueDepth, 0, 'withZ3 must not force-free live returned owners')
await withZ3('z3-lifecycle.use-retained-owner', async () => {
  assert.equal(String(await retained.model.eval(retained.x, true)), '7', 'live returned Model/Ast must remain usable in a later session')
  retained.model.release()
  retained.solver.release()
})
const afterRetainedRelease = getZ3LifecycleStats()
assert.ok(counter(afterRetainedRelease, 'drainedCleanupCalls', 'model_dec_ref') > counter(afterRetain, 'drainedCleanupCalls', 'model_dec_ref'))
assert.ok(counter(afterRetainedRelease, 'drainedCleanupCalls', 'solver_dec_ref') > counter(afterRetain, 'drainedCleanupCalls', 'solver_dec_ref'))

let releaseFirst!: () => void
let firstPromise!: Promise<string>
const firstEntered = new Promise<void>(resolve => {
  firstPromise = withZ3('z3-lifecycle.barrier-first', async z3 => {
    resolve()
    await new Promise<void>(r => { releaseFirst = r })
    const s = new z3.Solver()
    try {
      s.add(z3.Bool.val(true))
      assert.equal(await s.check(), 'sat')
      return 'first'
    } finally {
      s.release()
    }
  })
})
await firstEntered
let secondRan = false
const second = withZ3('z3-lifecycle.barrier-second', async z3 => {
  secondRan = true
  const s = new z3.Solver()
  try {
    s.add(z3.Bool.val(true))
    assert.equal(await s.check(), 'sat')
    return 'second'
  } finally {
    s.release()
  }
})
const raced = await Promise.race([second.then(() => 'settled'), new Promise<string>(resolve => setTimeout(() => resolve('queued'), 20))])
assert.equal(raced, 'queued', 'independent second withZ3 call must queue while first session awaits')
assert.equal(secondRan, false)
releaseFirst()
assert.equal(await firstPromise, 'first')
assert.equal(await second, 'second')
assert.equal(secondRan, true)

await assert.rejects(
  withZ3('z3-lifecycle.nested-outer', async () => withZ3('z3-lifecycle.nested-inner', async () => null)),
  /nested withZ3 is forbidden/,
)

let caughtFalsy = false
try {
  await withZ3('z3-lifecycle.falsy-rejection', async () => Promise.reject(undefined))
} catch (error) {
  caughtFalsy = true
  assert.equal(error, undefined)
}
assert.equal(caughtFalsy, true, 'withZ3 must preserve falsy rejection values')
assert.equal(await withZ3('z3-lifecycle.after-falsy-rejection', async z3 => {
  const s = new z3.Solver()
  try {
    s.add(z3.Bool.val(true))
    return await s.check()
  } finally {
    s.release()
  }
}), 'sat')

const beforeOptimize = getZ3LifecycleStats()
const optValue = await withZ3('z3-lifecycle.optimize', async z3 => {
  const x = z3.Int.const('life_opt_x')
  const opt = new z3.Optimize()
  try {
    opt.add(x.ge(2), x.le(5))
    const obj = opt.minimize(x)
    assert.equal(await opt.check(), 'sat')
    assert.equal(String(await opt.getLower(obj)), '2')
    const model = opt.model()
    try {
      return String(await model.eval(x, true))
    } finally {
      model.release()
    }
  } finally {
    opt.release()
  }
})
assert.equal(optValue, '2')
const afterOptimize = getZ3LifecycleStats()
assert.ok(counter(afterOptimize, 'drainedCleanupCalls', 'optimize_dec_ref') > counter(beforeOptimize, 'drainedCleanupCalls', 'optimize_dec_ref'))
assert.equal(afterOptimize.sessionsStarted, afterOptimize.sessionsSettled)
assert.equal(afterOptimize.currentDeferredQueueDepth, 0)
assert.equal(afterOptimize.poisoned, null)

console.log(`Z3 LIFECYCLE TESTS OK(contexts=1, cleanup=${afterOptimize.cleanupWrappedFunctions.length}, async=${afterOptimize.asyncWrappedFunctions.length}, maxQueue=${afterOptimize.maxDeferredQueueDepth})`)
