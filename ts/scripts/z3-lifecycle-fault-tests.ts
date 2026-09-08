/** Poison/overflow edge contracts for the local Z3 cleanup queue (#227).
 *
 * Each scenario runs in a child process because a poisoned Z3 instance must refuse
 * further solves for that process by design.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getZ3LifecycleStats, initZ3Context, withZ3 } from '../src/z3-shared.ts'

type FakeZ3 = Record<string, any>

function makeFakeApi(Z3: FakeZ3) {
  Z3.enable_concurrent_dec_ref ??= () => undefined
  return {
    Context(name: string) {
      assert.equal(name, 'main')
      return { ptr: { fake: 'ctx' } }
    },
    Z3,
  }
}

async function gcCleanupDoesNotThrow(): Promise<void> {
  const fakeZ3: FakeZ3 = {
    dec_ref() {
      throw new Error('injected gc cleanup failure')
    },
  }
  await initZ3Context(async () => makeFakeApi(fakeZ3))
  assert.doesNotThrow(() => fakeZ3.dec_ref('ctx', 'ast'), 'cleanup wrapper must not throw into a FinalizationRegistry call-site')
  const stats = getZ3LifecycleStats()
  assert.match(stats.poisoned ?? '', /injected gc cleanup failure/)
  assert.equal(stats.currentDeferredQueueDepth, 0)
  await assert.rejects(
    withZ3('z3-fault.after-gc-cleanup-failure', async () => null),
    /Z3 context is poisoned/,
  )
}

async function overflowKeepsCleanupReferences(): Promise<void> {
  let resolveCheck!: (value: 'sat') => void
  let nativeDecRefs = 0
  const fakeZ3: FakeZ3 = {
    solver_check_assumptions() {
      return new Promise<'sat'>(resolve => { resolveCheck = resolve })
    },
    dec_ref() {
      nativeDecRefs += 1
    },
  }
  await initZ3Context(async () => makeFakeApi(fakeZ3))
  const pending = fakeZ3.solver_check_assumptions()
  assert.equal(getZ3LifecycleStats().activeNativeCalls, 1, 'controlled native call must be active before cleanup is queued')
  const total = Number(process.env.GOTRY_Z3_CLEANUP_QUEUE_LIMIT ?? '16') + 1
  for (let i = 0; i < total; i++) fakeZ3.dec_ref('ctx', `ast-${i}`)
  const queued = getZ3LifecycleStats()
  assert.equal(queued.currentDeferredQueueDepth, total, 'overflow must retain every cleanup reference')
  assert.match(queued.poisoned ?? '', /cleanup queue overflow/)
  assert.equal(nativeDecRefs, 0, 'cleanup must not run while a native async call is pending')
  resolveCheck('sat')
  await pending
  const drained = getZ3LifecycleStats()
  assert.equal(drained.currentDeferredQueueDepth, 0, 'non-fatal overflow queue must still be drainable')
  assert.equal(nativeDecRefs, total, 'overflow must not drop any cleanup')
  await assert.rejects(
    withZ3('z3-fault.after-overflow', async () => null),
    /Z3 context is poisoned/,
  )
}

async function drainStopsOnFatalCleanup(): Promise<void> {
  let nativeDecRefAttempts = 0
  const fakeZ3: FakeZ3 = {
    dec_ref() {
      nativeDecRefAttempts += 1
      throw new Error('memory access out of bounds during cleanup')
    },
  }
  await initZ3Context(async () => makeFakeApi(fakeZ3))
  await assert.rejects(
    withZ3('z3-fault.drain-fatal-stop', async () => {
      fakeZ3.dec_ref('ctx', 'ast-a')
      fakeZ3.dec_ref('ctx', 'ast-b')
    }),
    /memory access out of bounds/,
  )
  const stats = getZ3LifecycleStats()
  assert.match(stats.poisoned ?? '', /memory access out of bounds/)
  assert.equal(nativeDecRefAttempts, 1, 'drain must stop after first fatal cleanup')
  assert.equal(stats.currentDeferredQueueDepth, 2, 'fatal drain must retain failed and remaining cleanup references')
}

async function syncFatalPoisonsBeforeFinish(): Promise<void> {
  let nativeDecRefs = 0
  const fakeZ3: FakeZ3 = {
    solver_check_assumptions() {
      fakeZ3.dec_ref('ctx', 'queued-before-sync-fatal')
      throw new Error('RuntimeError: Aborted(Runtime error: The application has corrupted its heap memory area (address zero)!)')
    },
    dec_ref() {
      nativeDecRefs += 1
    },
  }
  await initZ3Context(async () => makeFakeApi(fakeZ3))
  assert.throws(() => fakeZ3.solver_check_assumptions(), /corrupted its heap memory/)
  const stats = getZ3LifecycleStats()
  assert.match(stats.poisoned ?? '', /corrupted its heap memory/)
  assert.equal(stats.currentDeferredQueueDepth, 1, 'sync fatal must quarantine queued cleanup before finish wakes drain')
  assert.equal(nativeDecRefs, 0, 'finishNativeCall must not drain after a synchronous fatal native error')
}

async function nativeBarrierWaitsBeforeSettling(): Promise<void> {
  let resolveCheck!: (value: 'sat') => void
  let nativeDecRefs = 0
  let entered!: Promise<void>
  let markEntered!: () => void
  entered = new Promise<void>(resolve => { markEntered = resolve })
  const fakeZ3: FakeZ3 = {
    solver_check_assumptions() {
      return new Promise<'sat'>(resolve => { resolveCheck = resolve })
    },
    dec_ref() {
      nativeDecRefs += 1
    },
  }
  await initZ3Context(async () => makeFakeApi(fakeZ3))
  const session = withZ3('z3-fault.native-barrier', async () => {
    const pending = fakeZ3.solver_check_assumptions()
    assert.equal(getZ3LifecycleStats().activeNativeCalls, 1, 'native barrier must be active before session error is injected')
    fakeZ3.dec_ref('ctx', 'queued-during-native')
    markEntered()
    void pending
    throw new Error('injected domain failure after native start')
  })
  await entered
  assert.equal(getZ3LifecycleStats().activeNativeCalls, 1)
  assert.equal(getZ3LifecycleStats().currentDeferredQueueDepth, 1)
  assert.equal(nativeDecRefs, 0)
  const raced = await Promise.race([session.then(() => 'settled', () => 'rejected'), new Promise<string>(resolve => setTimeout(() => resolve('pending'), 20))])
  assert.equal(raced, 'pending', 'withZ3 must not settle before the active native Promise settles')
  resolveCheck('sat')
  await assert.rejects(session, /injected domain failure/)
  const stats = getZ3LifecycleStats()
  assert.equal(stats.activeNativeCalls, 0)
  assert.equal(stats.currentDeferredQueueDepth, 0)
  assert.equal(nativeDecRefs, 1)
  assert.equal(await withZ3('z3-fault.after-domain-failure', async () => 'healthy'), 'healthy')
}

async function fatalSkipsNativeCleanupAndRefusesNewSolve(): Promise<void> {
  const before = getZ3LifecycleStats()
  await assert.rejects(
    withZ3('z3-fault.fatal-session', async z3 => {
      const solver = new z3.Solver()
      solver.add(z3.Bool.val(true))
      solver.release()
      throw new Error('RuntimeError: Aborted(Runtime error: The application has corrupted its heap memory area (address zero)!)')
    }),
    /corrupted its heap memory/,
  )
  const after = getZ3LifecycleStats()
  assert.match(after.poisoned ?? '', /corrupted its heap memory/)
  assert.ok(after.currentDeferredQueueDepth > 0, 'fatal context must quarantine queued cleanup references instead of touching native heap')
  assert.equal(after.drainedCleanupCalls['solver_dec_ref'] ?? 0, before.drainedCleanupCalls['solver_dec_ref'] ?? 0)
  await assert.rejects(
    withZ3('z3-fault.after-fatal', async () => null),
    /Z3 context is poisoned/,
  )
}

async function childMain(scenario: string): Promise<void> {
  if (scenario === 'gc-cleanup') await gcCleanupDoesNotThrow()
  else if (scenario === 'overflow') await overflowKeepsCleanupReferences()
  else if (scenario === 'drain-fatal-stop') await drainStopsOnFatalCleanup()
  else if (scenario === 'sync-fatal') await syncFatalPoisonsBeforeFinish()
  else if (scenario === 'native-barrier') await nativeBarrierWaitsBeforeSettling()
  else if (scenario === 'fatal') await fatalSkipsNativeCleanupAndRefusesNewSolve()
  else throw new Error(`unknown scenario: ${scenario}`)
  console.log(`Z3 LIFECYCLE FAULT CHILD OK(${scenario})`)
}

const child = process.argv.find(arg => arg.startsWith('--child='))?.slice('--child='.length)
if (child) {
  await childMain(child)
} else {
  const tsRoot = process.cwd()
  const tsxCli = join(tsRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  assert.ok(existsSync(tsxCli), `tsx CLI not found: ${tsxCli}`)
  for (const scenario of ['gc-cleanup', 'overflow', 'drain-fatal-stop', 'sync-fatal', 'native-barrier', 'fatal']) {
    const result = spawnSync(process.execPath, [tsxCli, 'scripts/z3-lifecycle-fault-tests.ts', `--child=${scenario}`], {
      cwd: tsRoot,
      env: {
        ...process.env,
        ...(scenario === 'overflow' ? { GOTRY_Z3_CLEANUP_QUEUE_LIMIT: '16' } : {}),
      },
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    })
    assert.equal(result.status, 0, `${scenario} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`)
    assert.match(result.stdout ?? '', new RegExp(`Z3 LIFECYCLE FAULT CHILD OK\\(${scenario}\\)`))
  }
  console.log('Z3 LIFECYCLE FAULT TESTS OK(gc cleanup no-throw / overflow keeps refs / drain fatal stop / sync fatal quarantine / native barrier / fatal quarantine)')
}
