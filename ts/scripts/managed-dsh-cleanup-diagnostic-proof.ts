import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { ManagedDshRunPort } from '../src/booking-surface/managed-dsh-run-port.ts'
import { ManagedDshCleanupError, snapshotManagedDshGroup } from '../src/booking-surface/managed-dsh-cleanup-diagnostic.ts'

const workerPath = fileURLToPath(new URL('./fixtures/managed-dsh-worker-fixture.mjs', import.meta.url))

async function proveFailedObservation(kind: 'timeout' | 'rejected'): Promise<void> {
  const port = new ManagedDshRunPort({ workerPath, graceMs: 50, cleanupRole: kind === 'timeout' ? 'task' : 'warmer' })
  // This seam injects an observation failure, not a real process-cleanup bug.
  // Launch and termination still use the installed runtime and real child tree.
  const handle = (port as unknown as { handle: SubprocessHandle }).handle
  const waitForExit = handle.waitForExit.bind(handle)
  try {
    const result = await port.run('fixture', { sessionId: 'cleanup-diagnostic-proof' })
    const descendant = (result.events[0] as { grandchildPid: number }).grandchildPid
    handle.waitForExit = async () => {
      if (kind === 'rejected') throw new Error('PRIVATE_PROVIDER_TOKEN_DO_NOT_EXPOSE')
      return false
    }
    const closing = port.close()
    assert.strictEqual(port.close(), closing, 'failure remains sticky for every close caller')
    const error = await closing.then(() => undefined, (reason: unknown) => reason)
    assert.ok(error instanceof ManagedDshCleanupError, 'failure carries a typed safe diagnostic')
    const diagnostic = error.diagnostic
    assert.equal(diagnostic.role, kind === 'timeout' ? 'task' : 'warmer')
    assert.equal(diagnostic.schemaVersion, 'managed-dsh-cleanup.v1')
    if (process.platform === 'darwin') assert.ok(Number.isSafeInteger(diagnostic.workerPid) && diagnostic.workerPid! > 0, 'direct fallback receipt identifies the worker')
    assert.equal(diagnostic.deadlineMs, 1_000, 'existing minimum teardown deadline is preserved')
    assert.equal(diagnostic.graceMs, 50)
    assert.ok(diagnostic.elapsedMs >= 0)
    assert.ok(['pending', 'exited', 'failed'].includes(diagnostic.workerOutcome.state))
    assert.equal(diagnostic.processGroup.expectedPgid, process.platform === 'darwin' ? diagnostic.workerPid : null)
    assert.equal(JSON.stringify(error).includes('PRIVATE_'), false, 'provider observation errors are not forwarded')
    const log = spawnSync(process.execPath, ['--input-type=module', '-e',
      'let error = new Error(process.argv[1]); for (let i = 0; i < 3; i++) error = new AggregateError([error], "nested cleanup"); throw error',
      error.message], { encoding: 'utf8', timeout: 5_000 })
    assert.equal(log.status, 1, 'nested uncaught error child fails as intended')
    assert.ok(log.stderr.includes(`diagnostic=${JSON.stringify(diagnostic)}`), 'default nested error log retains every safe diagnostic value')
    assert.equal(log.stderr.includes('PRIVATE_'), false, 'nested log does not expose provider errors')
    for (const member of diagnostic.processGroup.members) {
      assert.equal(member.pgid, diagnostic.workerPid, 'only the owned process group is returned')
      assert.deepEqual(Object.keys(member).sort(), ['pgid', 'pid', 'ppid', 'state'])
    }
    assert.equal(await waitForExit(AbortSignal.timeout(2_000)), true, 'actual runtime still reaps the worker tree')
    if (process.platform !== 'win32') assert.throws(() => process.kill(descendant, 0), 'grandchild is reaped')
    console.log(`MANAGED DSH CLEANUP DIAGNOSTIC: ${kind} observation preserves ${diagnostic.role} identity and actual tree teardown`)
  } finally {
    handle.waitForExit = waitForExit
    handle.terminate()
    assert.equal(await waitForExit(AbortSignal.timeout(2_000)), true, 'proof cleans its own processes even after an assertion failure')
  }
}

await proveFailedObservation('timeout')
await proveFailedObservation('rejected')
assert.equal((await snapshotManagedDshGroup(null)).status, 'unknown_worker')
console.log('MANAGED DSH CLEANUP DIAGNOSTIC PROOF: controlled observation failures, safe identity, sticky failure and real child cleanup OK')
