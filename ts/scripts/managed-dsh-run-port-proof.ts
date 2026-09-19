import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { ManagedDshRunPort } from '../src/booking-surface/managed-dsh-run-port.ts'

const workerPath = fileURLToPath(new URL('./fixtures/managed-dsh-worker-fixture.mjs', import.meta.url))
const port = new ManagedDshRunPort({ workerPath, graceMs: 50 })
const result = await port.run('fixture', { sessionId: 'managed-dsh-proof' })
const pid = (result.events[0] as { grandchildPid: number }).grandchildPid
assert.ok(Number.isInteger(pid) && pid > 0, 'fixture reports its grandchild pid')
const started = Date.now()
await port.close()
assert.ok(Date.now() - started < 2_000, 'tree teardown is bounded')

const deadline = Date.now() + 1_000
let alive = true
while (alive && Date.now() < deadline) {
  try { process.kill(pid, 0) } catch { alive = false }
  if (alive) await new Promise((resolve) => setTimeout(resolve, 25))
}
assert.equal(alive, false, `TERM-resistant grandchild ${pid} must be reaped with its worker tree`)
assert.ok(existsSync(join(process.cwd(), 'node_modules/@deepseek-ai/dsh-subprocess-local')), 'proof uses installed dsh subprocess-local runtime')
console.log('MANAGED DSH RUN PORT TREE PROOF: bounded close reaps TERM-resistant grandchild')

const pendingWorkerPath = fileURLToPath(new URL('./fixtures/managed-dsh-pending-worker-fixture.mjs', import.meta.url))

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
    try { process.kill(pid, 0) } catch { return }
    if (Date.now() >= deadline) throw new Error(`fixture process ${pid} was not reaped`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), timeoutMs) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function assertPendingRejected(settledPromise: Promise<PromiseSettledResult<unknown>[]>, expected: number, label: string): Promise<void> {
  const settled = await bounded(settledPromise, 1_500, `${label}: pending requests did not settle`)
  assert.equal(settled.length, expected, `${label}: every pending request settled`)
  assert.ok(settled.every((entry) => entry.status === 'rejected'), `${label}: every pending request rejected`)
}

async function proveWorkerExitRejectsPending(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'gotry-managed-dsh-exit-'))
  const pidFile = join(root, 'pid.json')
  const requestFile = join(root, 'requests')
  const statusFile = join(root, 'status.json')
  const port = new ManagedDshRunPort({
    workerPath: pendingWorkerPath,
    graceMs: 50,
    env: {
      ...process.env,
      MANAGED_DSH_FIXTURE_PID_FILE: pidFile,
      MANAGED_DSH_FIXTURE_REQUEST_FILE: requestFile,
      MANAGED_DSH_FIXTURE_STATUS_FILE: statusFile,
      MANAGED_DSH_FIXTURE_EXIT_AFTER_REQUESTS: '3',
      MANAGED_DSH_FIXTURE_EXIT_CODE: '23',
    },
  })
  try {
    await waitForFile(pidFile, 1_000)
    const pending = [
      port.run('first pending run', { sessionId: 'managed-dsh-exit-1' }),
      port.run('second pending run', { sessionId: 'managed-dsh-exit-2' }),
      port.warmup(),
    ]
    const settledPromise = Promise.allSettled(pending)
    await waitForFileText(requestFile, '3', 1_000)
    await assertPendingRejected(settledPromise, pending.length, 'worker exit')
    await waitForFile(statusFile, 1_000)
    const status = JSON.parse(readFileSync(statusFile, 'utf8')) as { exitCode: number | null; signal: string | null; stderr: string }
    assert.equal(status.exitCode, 23, 'fixture exit code is recorded')
    assert.equal(status.signal, null, 'fixture exited without a signal')
    assert.ok(status.stderr.length <= 128, 'fixture stderr evidence is bounded')
    assert.equal(status.stderr.includes('PRIVATE_'), false, 'fixture stderr evidence contains no sensitive marker')
  } finally {
    await port.close().catch(() => undefined)
    rmSync(root, { recursive: true, force: true })
  }
}

async function proveCloseRejectsPendingAndReapsTree(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'gotry-managed-dsh-close-'))
  const pidFile = join(root, 'pid.json')
  const requestFile = join(root, 'requests')
  const port = new ManagedDshRunPort({
    workerPath: pendingWorkerPath,
    graceMs: 50,
    env: { ...process.env, MANAGED_DSH_FIXTURE_PID_FILE: pidFile, MANAGED_DSH_FIXTURE_REQUEST_FILE: requestFile },
  })
  try {
    await waitForFile(pidFile, 1_000)
    const pids = JSON.parse(readFileSync(pidFile, 'utf8')) as { workerPid: number; grandchildPid: number }
    assert.ok(Number.isInteger(pids.workerPid) && Number.isInteger(pids.grandchildPid), 'pending fixture reports its worker tree')
    const pending = [
      port.run('first close run', { sessionId: 'managed-dsh-close-1' }),
      port.run('second close run', { sessionId: 'managed-dsh-close-2' }),
      port.warmup(),
    ]
    const settledPromise = Promise.allSettled(pending)
    await waitForFileText(requestFile, '3', 1_000)
    const closeStarted = Date.now()
    const closePromise = port.close()
    assert.strictEqual(port.close(), closePromise, 'repeated close returns the same cleanup promise')
    await assertPendingRejected(settledPromise, pending.length, 'caller close')
    await closePromise
    assert.ok(Date.now() - closeStarted < 2_000, 'caller close and pending rejection are bounded')
    await waitForDead(pids.workerPid, 1_000)
    await waitForDead(pids.grandchildPid, 1_000)
  } finally {
    await port.close().catch(() => undefined)
    rmSync(root, { recursive: true, force: true })
  }
}

await proveWorkerExitRejectsPending()
await proveCloseRejectsPendingAndReapsTree()
console.log('MANAGED DSH RUN PORT PENDING PROOF: worker exit and caller close reject two runs plus warmup; tree cleanup remains bounded')
