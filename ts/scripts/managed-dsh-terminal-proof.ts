import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { ManagedDshRunPort } from '../src/booking-surface/managed-dsh-run-port.ts'

type Outcome =
  | { status: 'fulfilled'; value: unknown }
  | { status: 'rejected'; reason: unknown }

const pendingWorkerPath = fileURLToPath(new URL('./fixtures/managed-dsh-pending-worker-fixture.mjs', import.meta.url))

// Attach a rejection handler in the same turn as every operation that can reject.
// This proof intentionally exercises real SDK promises, so it must not synthesize
// a completed `done` promise or leave a rejected close/run promise unobserved.
function observe<T>(promise: Promise<T>): Promise<Outcome> {
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

async function rejectedWith(promise: Promise<Outcome>, expected: string, label: string): Promise<void> {
  const outcome = await bounded(promise, 1_500, `${label}: promise did not settle`)
  assert.equal(outcome.status, 'rejected', `${label}: promise must reject`)
  const message = reasonMessage(outcome.reason)
  assert.equal(message, expected, `${label}: stable public error`)
}

async function rejectedBeforeNextImmediate(promise: Promise<Outcome>, expected: string, label: string): Promise<void> {
  let immediate: ReturnType<typeof setImmediate> | undefined
  try {
    const outcome = await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        immediate = setImmediate(() => reject(new Error(`${label}: promise did not reject before next setImmediate`)))
      }),
    ])
    assert.equal(outcome.status, 'rejected', `${label}: promise must reject`)
    assert.equal(reasonMessage(outcome.reason), expected, `${label}: stable public error`)
  } finally {
    if (immediate) clearImmediate(immediate)
  }
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`fixture marker did not appear: ${path}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function waitForFileText(path: string, expected: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path) || readFileSync(path, 'utf8') !== expected) {
    if (Date.now() >= deadline) throw new Error(`fixture marker did not reach ${expected}: ${path}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function waitForDead(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    if (Date.now() >= deadline) throw new Error(`fixture process ${pid} was not reaped`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function cleanup(port: ManagedDshRunPort | undefined): Promise<void> {
  if (!port) return
  // Keep cleanup rejection observed even when an assertion fails earlier.
  await bounded(observe(port.close()), 2_000, 'cleanup did not settle')
}

async function proveNaturalExitRejectsNewRequests(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'gotry-managed-dsh-terminal-exit-'))
  const pidFile = join(root, 'pid.json')
  const requestFile = join(root, 'requests')
  const statusFile = join(root, 'status.json')
  let port: ManagedDshRunPort | undefined
  try {
    port = new ManagedDshRunPort({
      workerPath: pendingWorkerPath,
      graceMs: 50,
      env: {
        ...process.env,
        MANAGED_DSH_FIXTURE_PID_FILE: pidFile,
        MANAGED_DSH_FIXTURE_REQUEST_FILE: requestFile,
        MANAGED_DSH_FIXTURE_STATUS_FILE: statusFile,
        MANAGED_DSH_FIXTURE_EXIT_AFTER_REQUESTS: '1',
        MANAGED_DSH_FIXTURE_EXIT_CODE: '23',
      },
    })
    await waitForFile(pidFile, 1_000)

    const oldPending = observe(port.run('terminal exit pending run', { sessionId: 'managed-dsh-terminal-exit-old' }))
    await waitForFileText(requestFile, '1', 1_000)
    await rejectedWith(oldPending, 'managed DSH worker exited', 'natural exit pending run')
    await waitForFile(statusFile, 1_000)
    const status = JSON.parse(readFileSync(statusFile, 'utf8')) as { exitCode: number | null; signal: string | null; stderr: string }
    assert.equal(status.exitCode, 23, 'fixture naturally exits with code 23')
    assert.equal(status.signal, null, 'fixture natural exit has no signal')
    assert.ok(status.stderr.length <= 128, 'fixture stderr evidence is bounded')

    // Wait for the real handle.done rejection/settlement path above, then probe
    // both public request methods after the worker has exited.
    await rejectedBeforeNextImmediate(observe(port.run('terminal exit post run', { sessionId: 'managed-dsh-terminal-exit-new' })), 'managed DSH worker exited', 'natural exit new run')
    await rejectedBeforeNextImmediate(observe(port.warmup()), 'managed DSH worker exited', 'natural exit new warmup')

    const closePromise = port.close()
    const repeatedClosePromise = port.close()
    assert.strictEqual(repeatedClosePromise, closePromise, 'natural exit repeated close returns one cleanup promise')
    assert.equal((await bounded(observe(closePromise), 2_000, 'natural exit close did not settle')).status, 'fulfilled', 'natural exit close succeeds')
  } finally {
    await cleanup(port)
    rmSync(root, { recursive: true, force: true })
  }
  console.log('PASS managed DSH terminal natural exit: old pending and post-exit run/warmup reject immediately')
}

async function proveExplicitCloseIsBoundedAndIdempotent(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'gotry-managed-dsh-terminal-close-'))
  const pidFile = join(root, 'pid.json')
  const requestFile = join(root, 'requests')
  let port: ManagedDshRunPort | undefined
  try {
    port = new ManagedDshRunPort({
      workerPath: pendingWorkerPath,
      graceMs: 50,
      env: {
        ...process.env,
        MANAGED_DSH_FIXTURE_PID_FILE: pidFile,
        MANAGED_DSH_FIXTURE_REQUEST_FILE: requestFile,
      },
    })
    await waitForFile(pidFile, 1_000)
    const pids = JSON.parse(readFileSync(pidFile, 'utf8')) as { workerPid: number; grandchildPid: number | null }
    assert.ok(Number.isInteger(pids.workerPid) && Number.isInteger(pids.grandchildPid), 'fixture reports worker tree')

    const pending = [
      observe(port.run('terminal close first run', { sessionId: 'managed-dsh-terminal-close-1' })),
      observe(port.run('terminal close second run', { sessionId: 'managed-dsh-terminal-close-2' })),
      observe(port.warmup()),
    ]
    await waitForFileText(requestFile, '3', 1_000)

    const closePromise = port.close()
    const repeatedClosePromise = port.close()
    assert.strictEqual(repeatedClosePromise, closePromise, 'repeated close returns one cleanup promise')
    const closeOutcome = observe(closePromise)
    const repeatedOutcome = observe(repeatedClosePromise)
    for (const [index, request] of pending.entries()) {
      await rejectedWith(request, 'managed DSH run port closed', `explicit close old pending ${index + 1}`)
    }
    assert.equal((await bounded(closeOutcome, 2_000, 'explicit close did not settle')).status, 'fulfilled', 'explicit close succeeds')
    assert.equal((await bounded(repeatedOutcome, 2_000, 'repeated close did not settle')).status, 'fulfilled', 'repeated close succeeds')

    await rejectedWith(observe(port.run('terminal close post run', { sessionId: 'managed-dsh-terminal-close-new' })), 'managed DSH run port is closed', 'explicit close new run')
    await rejectedWith(observe(port.warmup()), 'managed DSH run port is closed', 'explicit close new warmup')
    await waitForDead(pids.workerPid, 1_000)
    await waitForDead(pids.grandchildPid!, 1_000)
  } finally {
    await cleanup(port)
    rmSync(root, { recursive: true, force: true })
  }
  console.log('PASS managed DSH terminal explicit close: pending rejection, idempotent close, signal cleanup, and closed guards')
}

async function proveSignalTerminationRejectsPending(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'gotry-managed-dsh-terminal-signal-'))
  const pidFile = join(root, 'pid.json')
  const requestFile = join(root, 'requests')
  let port: ManagedDshRunPort | undefined
  try {
    port = new ManagedDshRunPort({
      workerPath: pendingWorkerPath,
      graceMs: 50,
      env: { ...process.env, MANAGED_DSH_FIXTURE_PID_FILE: pidFile, MANAGED_DSH_FIXTURE_REQUEST_FILE: requestFile },
    })
    await waitForFile(pidFile, 1_000)
    const pids = JSON.parse(readFileSync(pidFile, 'utf8')) as { workerPid: number; grandchildPid: number | null }
    assert.ok(Number.isInteger(pids.workerPid) && Number.isInteger(pids.grandchildPid), 'signal fixture reports its worker tree')
    const oldPending = observe(port.run('terminal signal pending run', { sessionId: 'managed-dsh-terminal-signal-old' }))
    await waitForFileText(requestFile, '1', 1_000)

    // Kill the real child from outside the port. This exercises the SDK's
    // signal-shaped done resolution, rather than ManagedDshRunPort.close().
    process.kill(pids.workerPid, 'SIGKILL')
    await rejectedWith(oldPending, 'managed DSH worker exited', 'signal exit pending run')
    await waitForDead(pids.workerPid, 1_000)
    await rejectedBeforeNextImmediate(observe(port.run('terminal signal post run', { sessionId: 'managed-dsh-terminal-signal-new' })), 'managed DSH worker exited', 'signal exit new run')
    await rejectedBeforeNextImmediate(observe(port.warmup()), 'managed DSH worker exited', 'signal exit new warmup')

    const closePromise = port.close()
    const repeatedClosePromise = port.close()
    assert.strictEqual(repeatedClosePromise, closePromise, 'signal exit repeated close returns one cleanup promise')
    assert.equal((await bounded(observe(closePromise), 2_000, 'signal exit close did not settle')).status, 'fulfilled', 'signal exit close succeeds')
    await waitForDead(pids.grandchildPid!, 1_000)
  } finally {
    await cleanup(port)
    rmSync(root, { recursive: true, force: true })
  }
  console.log('PASS managed DSH terminal signal: SIGKILL, post-signal guards, idempotent close, and tree cleanup')
}

async function proveSpawnFailureIsSanitized(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'gotry-managed-dsh-terminal-spawn-'))
  const missingCwd = join(root, 'missing-cwd')
  let port: ManagedDshRunPort | undefined
  try {
    // dsh-subprocess-local returns a live handle and rejects handle.done for a
    // missing cwd; this uses that real failure path rather than a fake promise.
    port = new ManagedDshRunPort({
      cwd: missingCwd,
      workerPath: pendingWorkerPath,
      graceMs: 50,
      env: { ...process.env },
    })
    await rejectedWith(observe(port.run('terminal spawn failure run', { sessionId: 'managed-dsh-terminal-spawn-failure' })), 'managed DSH worker failed', 'spawn failure run')
    await rejectedBeforeNextImmediate(observe(port.warmup()), 'managed DSH worker failed', 'spawn failure warmup')
    await rejectedBeforeNextImmediate(observe(port.run('terminal spawn failure post run', { sessionId: 'managed-dsh-terminal-spawn-failure-post' })), 'managed DSH worker failed', 'spawn failure post run')

    const closePromise = port.close()
    const repeatedClosePromise = port.close()
    assert.strictEqual(repeatedClosePromise, closePromise, 'spawn failure repeated close is idempotent')
    await rejectedWith(observe(closePromise), 'managed DSH worker failed', 'spawn failure close')
    await rejectedWith(observe(repeatedClosePromise), 'managed DSH worker failed', 'spawn failure repeated close')
  } finally {
    await cleanup(port)
    rmSync(root, { recursive: true, force: true })
  }
  console.log('PASS managed DSH terminal spawn failure: real missing cwd and sanitized immediate guards')
}

await proveNaturalExitRejectsNewRequests()
await proveExplicitCloseIsBoundedAndIdempotent()
await proveSignalTerminationRejectsPending()
await proveSpawnFailureIsSanitized()
assert.ok(existsSync(join(process.cwd(), 'node_modules/@deepseek-ai/dsh-subprocess-local')), 'proof uses installed dsh subprocess-local runtime')
console.log('MANAGED DSH TERMINAL PROOF: natural exit, explicit close, signal cleanup, and spawn failure are bounded and sanitized')
