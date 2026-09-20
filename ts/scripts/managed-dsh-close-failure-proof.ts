import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ManagedDshRunPort } from '../src/booking-surface/managed-dsh-run-port.ts'
import { ManagedDshCleanupError } from '../src/booking-surface/managed-dsh-cleanup-diagnostic.ts'

/**
 * Supporting proof for #510's close failure path.
 *
 * This is fault injection, not a complete provider E2E: dsh-subprocess-local
 * supplies the real spawn-failure handle, while waitForExit is replaced in
 * memory with each result allowed by its public contract (reject or false).
 */

type Handle = {
  done: Promise<unknown>
  waitForExit: (signal?: AbortSignal) => Promise<boolean>
}

type Outcome<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown }

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
  // The real provider handle may still be finishing its spawn-failure cleanup
  // after the injected outer close has returned. On the linux-scope path that
  // cleanup polls via systemctl (per-call timeout 5s); a loaded CI runner can
  // legitimately take past 2s to settle, so the observation budget is 15s —
  // bounded, but wide enough that CI load cannot abort it into a false (#541).
  // The close-path assertions above keep their tight original bounds.
  const rangeEmpty = await bounded(originalWaitForExit(AbortSignal.timeout(15_000)), 16_000, 'real handle cleanup did not settle')
  assert.equal(rangeEmpty, true, 'real handle cleanup observes an empty managed range')
  const done = await bounded(doneOutcome, 2_500, 'real handle done did not settle')
  assert.equal(done.status, 'rejected', 'real spawn-failure handle.done rejects')
  await bounded(observe(port.close()), 2_500, 'sticky close promise did not settle')
}

async function proveCloseFailure(
  mode: 'reject' | 'false',
  expected: string,
  unhandled: unknown[],
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), `gotry-510-close-${mode}-`))
  const missingCwd = join(root, 'missing-cwd')
  const port = new ManagedDshRunPort({ cwd: missingCwd, workerPath, graceMs: 50 })
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
