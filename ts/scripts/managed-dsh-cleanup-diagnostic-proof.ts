import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { ManagedDshRunPort } from '../src/booking-surface/managed-dsh-run-port.ts'
import {
  ManagedDshCleanupError,
  managedDshGroupIsQuiescent,
  parseManagedDshGroupSnapshot,
  readManagedDshWorkerStart,
  snapshotManagedDshGroup,
  type ManagedDshProcessGroupSnapshot,
} from '../src/booking-surface/managed-dsh-cleanup-diagnostic.ts'

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
    assert.equal(diagnostic.schemaVersion, 'managed-dsh-cleanup.v2')
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
      assert.deepEqual(Object.keys(member).sort(), ['pgid', 'pid', 'ppid', 'startedAt', 'state', 'zombie'])
      assert.equal(member.zombie, member.state.startsWith('Z'), 'zombie flag matches the observed state letter')
    }
    if (kind === 'timeout' && diagnostic.processGroup.status === 'observed') {
      // Right after terminate() the real fixture tree still holds live members,
      // so the safe snapshot must classify it as not quiescent.
      assert.equal(diagnostic.processGroup.classification, 'has-live-members')
      assert.ok(diagnostic.processGroup.liveMemberCount! >= 1)
      assert.equal(managedDshGroupIsQuiescent(diagnostic.processGroup), false)
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

/** Classify crafted ps tables without signalling anything. */
async function proveSyntheticClassification(): Promise<void> {
  const anchor = 'Sun Sep 20 19:59:16 2026'
  const zombieOnly = parseManagedDshGroupSnapshot(' 4242 1 4242 Z    Sun Sep 20 19:59:16 2026', 4242, anchor)
  assert.equal(zombieOnly.status, 'observed')
  assert.equal(zombieOnly.classification, 'zombie-only')
  assert.deepEqual([zombieOnly.liveMemberCount, zombieOnly.zombieMemberCount], [0, 1])
  assert.equal(zombieOnly.workerIdentity, 'match')
  assert.equal(managedDshGroupIsQuiescent(zombieOnly), true, 'a group holding only un-reaped zombies is quiescent')
  const reused = parseManagedDshGroupSnapshot(' 4242 1 4242 Z    Mon Dec 1 08:00:00 2025', 4242, anchor)
  assert.equal(reused.workerIdentity, 'mismatch', 'a start time that differs from the live anchor proves PID reuse')
  const live = parseManagedDshGroupSnapshot(' 4242 1 4242 Ss   Sun Sep 20 19:59:16 2026\n 4243 4242 4242 R    Sun Sep 20 19:59:17 2026', 4242, anchor)
  assert.equal(live.classification, 'has-live-members')
  assert.deepEqual([live.liveMemberCount, live.zombieMemberCount], [2, 0])
  assert.equal(live.workerIdentity, 'match')
  assert.equal(managedDshGroupIsQuiescent(live), false)
  const mixed = parseManagedDshGroupSnapshot(' 4242 1 4242 Z    Sun Sep 20 19:59:16 2026\n 4243 4242 4242 U    Sun Sep 20 19:59:17 2026', 4242, null)
  assert.equal(mixed.classification, 'has-live-members', 'an uninterruptible member is live, never zombie')
  assert.equal(mixed.workerIdentity, 'unknown', 'without a live anchor identity stays unknown')
  const empty = parseManagedDshGroupSnapshot('', 4242, anchor)
  assert.equal(empty.classification, 'empty')
  assert.equal(managedDshGroupIsQuiescent(empty), true)
  assert.equal(parseManagedDshGroupSnapshot('4243 1 999 Z Sun Sep 20 19:59:16 2026', 4242).classification, 'empty', 'foreign groups are excluded')
  console.log('MANAGED DSH CLEANUP DIAGNOSTIC: synthetic tables classify zombie-only, live, uninterruptible, empty and reused identities')
}

/**
 * A live process that never reaps its child keeps a real zombie inside its own
 * process group for as long as it lives: `sh -c 'sleep 0.3 & exec sleep 600'`
 * leaves the exited background job owned by the exec'd sleep.
 */
async function proveRealGroupClassification(): Promise<void> {
  if (process.platform !== 'darwin') {
    console.log('MANAGED DSH CLEANUP DIAGNOSTIC: real group classification is Darwin-only, skipped')
    return
  }
  const holder = spawn('/bin/sh', ['-c', 'sleep 0.3 & exec sleep 600'], { detached: true, stdio: 'ignore' })
  try {
    const anchor = await readManagedDshWorkerStart(holder.pid!)
    assert.ok(anchor, 'live holder reports its start-time anchor')
    const deadline = Date.now() + 2_000
    let group: ManagedDshProcessGroupSnapshot | undefined
    while (Date.now() < deadline) {
      group = await snapshotManagedDshGroup(holder.pid!, anchor)
      if (group.status === 'observed' && group.zombieMemberCount! >= 1) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.equal(group!.status, 'observed')
    assert.equal(group!.classification, 'has-live-members', 'a live member holding a zombie is not zombie-only')
    assert.ok(group!.liveMemberCount! >= 1 && group!.zombieMemberCount! >= 1, 'the real group holds one live holder and one real zombie')
    for (const member of group!.members) {
      assert.ok(member.startedAt, 'every real member carries a start time')
      assert.equal(member.zombie, member.state.startsWith('Z'))
    }
    assert.equal(group!.workerIdentity, 'match', 'the live anchor matches the observed holder identity')
    assert.equal(managedDshGroupIsQuiescent(group!), false)
    console.log(`MANAGED DSH CLEANUP DIAGNOSTIC: real group ${holder.pid} classified with live holder and real zombie member`)
  } finally {
    try { process.kill(-holder.pid!, 'SIGKILL') } catch { /* already gone */ }
    const reaped = Date.now() + 2_000
    while (Date.now() < reaped) {
      try { process.kill(-holder.pid!, 0); await new Promise((resolve) => setTimeout(resolve, 50)) } catch { break }
    }
  }
}

/** The close verdict: an observation deadline plus a quiescent group is a successful cleanup, not a timeout. */
async function proveCloseVerdict(classification: 'zombie-only' | 'empty' | 'has-live-members'): Promise<void> {
  let observedPgid: number | null = null
  const port = new ManagedDshRunPort({
    workerPath, graceMs: 50, cleanupRole: 'task',
    groupObserver: async (pid) => {
      observedPgid = pid
      const table = classification === 'empty' ? '' : ` ${pid} 1 ${pid} ${classification === 'zombie-only' ? 'Z' : 'Ss'}   Sun Sep 20 19:59:16 2026`
      return parseManagedDshGroupSnapshot(table, pid, null)
    },
  })
  const handle = (port as unknown as { handle: SubprocessHandle }).handle
  const waitForExit = handle.waitForExit.bind(handle)
  try {
    await port.run('fixture', { sessionId: 'cleanup-verdict-proof' })
    handle.waitForExit = async () => false
    const closing = port.close()
    if (classification === 'has-live-members') {
      const error = await closing.then(() => undefined, (reason: unknown) => reason)
      assert.ok(error instanceof ManagedDshCleanupError, 'a live member still converts the deadline into a failure')
      assert.equal(error.message.split(';')[0], 'managed DSH process tree cleanup timeout')
      assert.equal(error.diagnostic.processGroup.classification, 'has-live-members')
      assert.equal(error.diagnostic.processGroup.liveMemberCount, 1)
    } else {
      await closing
    }
    assert.ok(Number.isInteger(observedPgid) && observedPgid! > 0, 'the verdict observer receives the owned worker identity')
    assert.equal(await waitForExit(AbortSignal.timeout(2_000)), true, 'the real runtime still reaps the tree in every verdict case')
  } finally {
    handle.waitForExit = waitForExit
    handle.terminate()
    assert.equal(await waitForExit(AbortSignal.timeout(2_000)), true, 'proof cleans its own processes even after an assertion failure')
  }
}

await proveFailedObservation('timeout')
await proveFailedObservation('rejected')
await proveSyntheticClassification()
await proveRealGroupClassification()
await proveCloseVerdict('zombie-only')
await proveCloseVerdict('empty')
await proveCloseVerdict('has-live-members')
assert.equal((await snapshotManagedDshGroup(null)).status, 'unknown_worker')
console.log('MANAGED DSH CLEANUP DIAGNOSTIC PROOF: observation failures, zombie classification, identity anchors and verdict-by-quiescence OK')
