import assert from 'node:assert/strict'
import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { ManagedDshRunPort } from '../src/booking-surface/managed-dsh-run-port.ts'
import { ManagedDshCleanupError } from '../src/booking-surface/managed-dsh-cleanup-diagnostic.ts'

/**
 * Supporting proof for #510's close failure path.
 *
 * This is fault injection, not a complete provider E2E: dsh-subprocess-local
 * supplies the real spawn-failure handle, while waitForExit is replaced in
 * memory with each result allowed by its public contract (reject or false).
 *
 * Process-lifecycle containment (full-regression hang, GH run 36137453638 /
 * Node 24 job 108078849783): the native linux-scope owner's shared observation
 * has no cancellable wait and no wall-clock bound (#541). After this proof's
 * bounded observation window aborts, the scope owner's pending timers and
 * systemctl work stay referenced and kept the process alive after the result
 * had printed. The proof therefore pins the runtime's PUBLIC test hooks
 * (`SpawnInternals.platform`, documented "host platform override", consumed
 * synchronously by selectContainmentMode) to select the deterministic POSIX
 * fallback owner: a spawn that never started a child has no pid, so its
 * range-emptiness is observable immediately and the process can exit
 * naturally. The hooks are saved/restored synchronously around the (fully
 * synchronous) port construction; the global `process.platform` is never
 * touched and the real missing-cwd failure is preserved.
 */

type Handle = {
  done: Promise<unknown>
  waitForExit: (signal?: AbortSignal) => Promise<boolean>
}

type Outcome<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown }

/** Recorded ordinary spawn invocation (public SpawnInternals.spawn hook). */
type RecordedSpawn = { program: string; args: readonly string[]; options: SpawnOptions }

const workerPath = fileURLToPath(new URL('./fixtures/managed-dsh-pending-worker-fixture.mjs', import.meta.url))

function observe<T>(promise: Promise<T>): Promise<Outcome<T>> {
  return promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason }),
  )
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function reasonMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

async function assertRejected<T>(promise: Promise<Outcome<T>>, expected: string, label: string): Promise<void> {
  const outcome = await bounded(promise, 2_000, `${label}: close did not settle`)
  assert.equal(outcome.status, 'rejected', `${label}: close must reject`)
  const reason = (outcome as { status: 'rejected'; reason: unknown }).reason
  // Since #518 close failures carry the typed safe diagnostic; the stable
  // public meaning lives before its appended diagnostic payload.
  assert.ok(reason instanceof ManagedDshCleanupError, `${label}: close failure carries the typed cleanup diagnostic`)
  assert.equal(reason.message.split(';')[0], expected, `${label}: stable close error`)
}

async function settleInjectedHandle(
  port: ManagedDshRunPort,
  originalWaitForExit: Handle['waitForExit'],
  doneOutcome: Promise<Outcome<unknown>>,
): Promise<void> {
  const handle = (port as unknown as { handle: Handle }).handle
  handle.waitForExit = originalWaitForExit
  // The pinned fallback owner makes the real observation deterministic: the
  // spawn never produced a child (no pid), so the owner's liveness probe is
  // immediately false and confirmed-empty arrives without any provider-side
  // wait. The bounded window stays as harness safety, not as a contract.
  const rangeEmpty = await bounded(originalWaitForExit(AbortSignal.timeout(12_000)), 13_500, 'real handle cleanup did not settle')
  assert.equal(rangeEmpty, true, 'real handle cleanup must confirm the range empty (deterministic fallback owner)')
  const done = await bounded(doneOutcome, 2_500, 'real handle done did not settle')
  assert.equal(done.status, 'rejected', 'real spawn-failure handle.done rejects')
  await bounded(observe(port.close()), 2_500, 'sticky close promise did not settle')
}

const runtimeProto = LocalSubprocessRuntime.prototype as unknown as {
  spawn: (this: LocalSubprocessRuntime, spec: Parameters<LocalSubprocessRuntime['spawn']>[0]) => ReturnType<LocalSubprocessRuntime['spawn']>
}

/**
 * Construct the port with the runtime's PUBLIC test hooks pinned to the POSIX
 * fallback owner for the one synchronous spawn the constructor performs.
 * `platform: 'darwin'` routes selectContainmentMode away from the linux-scope
 * owner whose uncancellable shared wait can hang the runner; the recorded
 * `spawn` hook delegates to the real node spawn so the missing-cwd failure is
 * genuine. Prototype and per-instance internals are restored before any
 * asynchronous assertion can observe them.
 */
function constructPortWithFallbackOwner(options: { cwd: string; workerPath: string; graceMs: number }): {
  port: ManagedDshRunPort
  spawnCalls: RecordedSpawn[]
  pinnedInternals: SpawnOptions | null
  prototypeRestored: boolean
} {
  const spawnCalls: RecordedSpawn[] = []
  let pinnedInternals: Record<string, unknown> | null = null
  const originalProtoSpawn = runtimeProto.spawn
  runtimeProto.spawn = function (this: LocalSubprocessRuntime, spec) {
    pinnedInternals = this.internals as unknown as Record<string, unknown>
    const hadPlatform = Object.hasOwn(this.internals, 'platform')
    const previousPlatform = this.internals.platform
    const previousSpawn = this.internals.spawn
    this.internals.platform = 'darwin'
    this.internals.spawn = (program, args, opts) => {
      spawnCalls.push({ program, args: [...args], options: opts })
      return (previousSpawn ?? nodeSpawn)(program, args, opts)
    }
    try {
      return originalProtoSpawn.call(this, spec)
    } finally {
      if (previousSpawn !== undefined) this.internals.spawn = previousSpawn
      else delete this.internals.spawn
      if (hadPlatform) this.internals.platform = previousPlatform
      else delete this.internals.platform
    }
  }
  let port: ManagedDshRunPort
  try {
    port = new ManagedDshRunPort(options)
  } finally {
    runtimeProto.spawn = originalProtoSpawn
  }
  return { port, spawnCalls, pinnedInternals, prototypeRestored: runtimeProto.spawn === originalProtoSpawn }
}

async function proveCloseFailure(
  mode: 'reject' | 'false',
  expected: string,
  unhandled: unknown[],
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), `gotry-510-close-${mode}-`))
  const missingCwd = join(root, 'missing-cwd')
  const { port, spawnCalls, pinnedInternals, prototypeRestored } = constructPortWithFallbackOwner({
    cwd: missingCwd,
    workerPath,
    graceMs: 50,
  })
  // Containment-selection coverage: the pinned platform hook must have routed
  // this spawn through the POSIX fallback owner — the ordinary spawn hook
  // fired exactly once for the real Node executable with the real missing
  // cwd and detached POSIX options (the native linux-scope branch would have
  // exec'd systemd-run instead).
  assert.equal(spawnCalls.length, 1, `${mode}: ordinary spawn fired exactly once (fallback owner selected)`)
  assert.equal(spawnCalls[0].program, process.execPath, `${mode}: real worker executable spawned`)
  assert.equal(spawnCalls[0].args.at(-1), workerPath, `${mode}: real worker path spawned`)
  assert.equal(spawnCalls[0].options.cwd, missingCwd, `${mode}: real missing cwd passed to the real spawn`)
  assert.equal(spawnCalls[0].options.detached, true, `${mode}: detached POSIX fallback owner selected`)
  // Hook restoration coverage: nothing observable of the test hooks may
  // outlive the synchronous construction.
  assert.ok(prototypeRestored, `${mode}: runtime prototype spawn restored`)
  assert.ok(pinnedInternals !== null && !Object.hasOwn(pinnedInternals, 'platform') && !Object.hasOwn(pinnedInternals, 'spawn'),
    `${mode}: internals test hooks restored`)
  const handle = (port as unknown as { handle: Handle }).handle
  const originalWaitForExit = handle.waitForExit.bind(handle)
  const doneOutcome = observe(handle.done)
  const unhandledAtStart = unhandled.length
  const injected = mode === 'reject'
    ? () => Promise.reject(new Error('fault-injected observation failure'))
    : () => Promise.resolve(false)
  handle.waitForExit = injected

  try {
    const closePromise = port.close()
    const repeatedClosePromise = port.close()
    assert.strictEqual(repeatedClosePromise, closePromise, `${mode}: repeated close returns one Promise`)
    await assertRejected(observe(closePromise), expected, mode)
    await assertRejected(observe(repeatedClosePromise), expected, `${mode} repeated close`)
    await settleInjectedHandle(port, originalWaitForExit, doneOutcome)
    // Give the real done rejection a turn to expose an unhandled derived
    // outcome Promise. The proof itself observes every public close Promise.
    await new Promise<void>((resolve) => setImmediate(resolve))
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(
      unhandled.length,
      unhandledAtStart,
      `${mode}: no unhandled rejection from close cleanup (${unhandled.slice(unhandledAtStart).map(reasonMessage).join('; ')})`,
    )
  } finally {
    handle.waitForExit = originalWaitForExit
    await bounded(observe(port.close()), 2_500, `${mode}: final cleanup did not settle`)
    rmSync(root, { recursive: true, force: true })
  }
}

const unhandled: unknown[] = []
const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
process.on('unhandledRejection', onUnhandled)
try {
  const failures: unknown[] = []
  for (const [mode, expected] of [
    ['reject', 'managed DSH process tree observation failed'],
    ['false', 'managed DSH process tree cleanup timeout'],
  ] as const) {
    try {
      await proveCloseFailure(mode, expected, unhandled)
    } catch (error) {
      failures.push(error)
      console.error(`MANAGED DSH CLOSE FAILURE PROOF RED (${mode}):`, error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'managed DSH close failure proof failed')
  console.log('MANAGED DSH CLOSE FAILURE PROOF: observation reject/timeout are bounded, idempotent, and handled')
} finally {
  process.off('unhandledRejection', onUnhandled)
}
