/**
 * Compute isolation of the planner children (AaaS, docs/rfc/aaas-rfc.md §4.8; threat S-17).
 *
 * The tenant boundary of the state layer says nothing about CPU and memory, and every tenant on a replica shares
 * them. These checks prove that a runaway planner child is stopped by a limit this process enforces, is reported as a
 * typed non-retryable failure, takes nothing else down, and that a port built without limits is unchanged.
 *
 * The governor checks are deterministic (injected process table and kill). The port checks use real processes: a
 * fixture worker that leaks off-heap memory, leaks in a grandchild, spins, exhausts its V8 heap, or writes a line
 * that never ends. Every runaway mode bounds itself, so a broken guard fails a check instead of the machine.
 *
 *   G  governor: time formats, process-table parsing, tree membership, pid reuse, breach rules, one breach per watch,
 *      isolation between watches, failed samples, overlapping ticks, validation, the timer
 *   P  ports (real processes): memory, memory in a grandchild, CPU, V8 heap, unbounded line, neighbours unaffected,
 *      a port without limits unchanged
 *   D  planner: a resource kill is a non-retryable PLANNER_FAILED with its own metric; the tenant provider's defaults
 *   R  replica capacity: a replica holds no more tenants than it was configured to (each costs file descriptors), and
 *      past that a tenant is refused before its lease or any file exists
 *
 * Run: cd ts && npx tsx scripts/tenant-compute-isolation-tests.ts
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

import {
  createDshEmbeddedBookingPlanner,
  createRealRunPort,
  type DshEmbeddedBookingPlannerOptions,
  type DshPlannerRunPort,
  type DshPlannerRunResult,
  type DshPlannerTurnMetric,
} from '../src/booking-surface/dsh-planner.ts'
import { createManagedDshRunPort, ManagedDshResourceLimitError, ManagedDshRunPort } from '../src/booking-surface/managed-dsh-run-port.ts'
import type { BookingCopilotTaskState } from '../src/booking-surface/runtime.ts'
import { assertPlannerLimitsEnforceable, createDshTenantPlannerProvider, DEFAULT_TENANT_PLANNER_RESOURCE_LIMITS } from '../src/booking-surface/startup.ts'
import { tenantRejection } from '../src/booking-surface/tenancy.ts'
import { DirDurableStore } from '../src/tenant-state/durable-store.ts'
import { ReplicaAtCapacityError } from '../src/tenant-state/errors.ts'
import { deriveLedgerTenantId } from '../src/tenant-state/ids.ts'
import { SqliteLeaseStore } from '../src/tenant-state/lease-store.ts'
import { TenantRouter } from '../src/tenant-state/tenant-router.ts'
import {
  parseCpuSeconds,
  parsePsTable,
  ProcessTableUnavailableError,
  ProcessTreeGovernor,
  sharedProcessTreeGovernor,
  treeOf,
  type ProcessRow,
} from '../src/tenant-seam/process-governor.ts'

const MIB = 1024 * 1024
// Every managed port registers a process-exit hook; this suite builds more of them than a service ever holds at once.
process.setMaxListeners(100)
const FIXTURE = fileURLToPath(new URL('./fixtures/tenant-runaway-worker-fixture.mjs', import.meta.url))

let passed = 0
async function check(label: string, assertion: () => void | Promise<void>): Promise<void> {
  await assertion()
  passed += 1
  console.log(`  ok - ${label}`)
}

function row(pid: number, ppid: number, rssMiB: number, cpuSeconds = 0): ProcessRow {
  return { pid, ppid, rssBytes: rssMiB * MIB, cpuSeconds }
}

const ME = 1

function harness(table: () => ProcessRow[] | Promise<ProcessRow[]>) {
  const killed: number[][] = []
  const faults: unknown[] = []
  const order: string[] = []
  const governor = new ProcessTreeGovernor({
    intervalMs: 3_600_000,
    table: async () => table(),
    kill: (pids) => { order.push('killed'); killed.push([...pids].sort((a, b) => a - b)) },
    onFault: (error) => { faults.push(error) },
  })
  return { governor, killed, faults, order }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function waitFor(condition: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for: ${label}`)
    await sleep(20)
  }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new assert.AssertionError({ message: 'expected the promise to reject' })
}

// ---- G: governor ------------------------------------------------------------------------------

console.log('G  governor')

await check('G1 CPU time parses in the Linux and Darwin formats and rejects anything else', () => {
  assert.equal(parseCpuSeconds('00:00:05'), 5)
  assert.equal(parseCpuSeconds('01:02:03'), 3_723)
  assert.equal(parseCpuSeconds('1-02:03:04'), 86_400 + 7_384)
  assert.equal(parseCpuSeconds('0:00.05'), 0.05)
  assert.equal(parseCpuSeconds('12:34.56'), 754.56)
  assert.equal(parseCpuSeconds('1:02:03.45'), 3_723.45)
  for (const bad of ['', 'abc', '12', '1:2:3:4', '-1:00', '1-', ':30']) assert.ok(Number.isNaN(parseCpuSeconds(bad)), `"${bad}" is not a CPU time`)
})

await check('G2 the process table is parsed in KiB, and a line that does not parse is dropped, not guessed', () => {
  const rows = parsePsTable('  100     1   2048 00:00:07\n  101   100    512 0:01.50\n\nnot a row\n  102 100 xx 00:00:01\n  103 100 64 garbage\n')
  assert.deepEqual(rows, [
    { pid: 100, ppid: 1, rssBytes: 2_048 * 1024, cpuSeconds: 7 },
    { pid: 101, ppid: 100, rssBytes: 512 * 1024, cpuSeconds: 1.5 },
  ])
})

await check('G3 a tree is the root and its descendants, summed; siblings and strangers are not in it', () => {
  const sample = treeOf([row(100, ME, 10, 1), row(101, 100, 20, 2), row(102, 101, 30, 3), row(103, 100, 5, 1), row(200, ME, 500, 50), row(201, 200, 500, 50)], { rootPid: 100, parentPid: ME })
  assert.ok(sample)
  assert.deepEqual([...sample.pids].sort((a, b) => a - b), [100, 101, 102, 103])
  assert.equal(sample.rssBytes, 65 * MIB)
  assert.equal(sample.cpuSeconds, 7)
})

await check('G4 a reused pid is not the root: a different parent means the tree is not sampled and nothing is killed', async () => {
  assert.equal(treeOf([row(100, 999, 4_000, 4_000)], { rootPid: 100, parentPid: ME }), null)
  const { governor, killed } = harness(() => [row(100, 999, 4_000, 4_000)])
  let breaches = 0
  governor.watch({ rootPid: 100, parentPid: ME }, { maxRssBytes: MIB, maxCpuSeconds: 1 }, () => { breaches += 1 })
  await governor.tick()
  assert.equal(breaches, 0)
  assert.deepEqual(killed, [])
  assert.equal(treeOf([], { rootPid: 100, parentPid: ME }), null, 'a root that is gone has no tree')
})

await check('G5 memory: over the limit is a breach, at the limit is not; the whole tree is killed and the owner told why first', async () => {
  let table = [row(100, ME, 100), row(101, 100, 90), row(102, 101, 10)]
  const { governor, killed, order } = harness(() => table)
  const breaches: unknown[] = []
  governor.watch({ rootPid: 100, parentPid: ME }, { maxRssBytes: 200 * MIB }, (breach) => { breaches.push(breach); order.push('told') })
  await governor.tick()
  assert.equal(breaches.length, 0, 'exactly at the limit is within it')
  table = [row(100, ME, 100), row(101, 100, 90), row(102, 101, 10), row(103, 102, 1)]
  await governor.tick()
  assert.deepEqual(breaches, [{ kind: 'memory', limit: 200 * MIB, observed: 201 * MIB }])
  assert.deepEqual(killed, [[100, 101, 102, 103]])
  assert.deepEqual(order, ['told', 'killed'])
})

await check('G6 CPU: over the limit is a breach, and memory is reported first when both are over', async () => {
  const cpuOnly = harness(() => [row(100, ME, 10, 31), row(101, 100, 10, 30)])
  const seen: unknown[] = []
  cpuOnly.governor.watch({ rootPid: 100, parentPid: ME }, { maxCpuSeconds: 60 }, (breach) => seen.push(breach))
  await cpuOnly.governor.tick()
  assert.deepEqual(seen, [{ kind: 'cpu', limit: 60, observed: 61 }])
  const both = harness(() => [row(100, ME, 500, 500)])
  const bothSeen: Array<{ kind: string }> = []
  both.governor.watch({ rootPid: 100, parentPid: ME }, { maxRssBytes: MIB, maxCpuSeconds: 1 }, (breach) => bothSeen.push(breach))
  await both.governor.tick()
  assert.deepEqual(bothSeen.map((breach) => breach.kind), ['memory'])
})

await check('G7 a watch breaches once: later ticks neither tell the owner again nor kill again', async () => {
  const { governor, killed } = harness(() => [row(100, ME, 900)])
  let told = 0
  governor.watch({ rootPid: 100, parentPid: ME }, { maxRssBytes: 100 * MIB }, () => { told += 1 })
  await governor.tick()
  await governor.tick()
  await governor.tick()
  assert.equal(told, 1)
  assert.equal(killed.length, 1)
  assert.equal(governor.size, 0)
})

await check('G8 watches are independent: only the tree over its limit is killed, and the neighbour is not told anything', async () => {
  const { governor, killed } = harness(() => [row(100, ME, 900), row(101, 100, 1), row(200, ME, 50), row(201, 200, 1)])
  const told: string[] = []
  governor.watch({ rootPid: 100, parentPid: ME }, { maxRssBytes: 100 * MIB }, () => told.push('hot'))
  governor.watch({ rootPid: 200, parentPid: ME }, { maxRssBytes: 100 * MIB }, () => told.push('calm'))
  await governor.tick()
  assert.deepEqual(told, ['hot'])
  assert.deepEqual(killed, [[100, 101]])
  assert.equal(governor.size, 1, 'the calm tree is still watched')
})

await check('G9 unwatch stops a watch for good, and is safe to call twice or after a breach', async () => {
  const { governor, killed } = harness(() => [row(100, ME, 900)])
  const unwatch = governor.watch({ rootPid: 100, parentPid: ME }, { maxRssBytes: MIB }, () => undefined)
  unwatch()
  unwatch()
  await governor.tick()
  assert.deepEqual(killed, [])
  const afterBreach = harness(() => [row(100, ME, 900)])
  const stop = afterBreach.governor.watch({ rootPid: 100, parentPid: ME }, { maxRssBytes: MIB }, () => undefined)
  await afterBreach.governor.tick()
  stop()
  assert.equal(afterBreach.governor.size, 0)
})

await check('G10 a failed sample kills nothing, is counted and reported, and the next sample works', async () => {
  let fail = true
  const { governor, killed, faults } = harness(() => {
    if (fail) throw new Error('ps unavailable')
    return [row(100, ME, 900)]
  })
  let told = 0
  governor.watch({ rootPid: 100, parentPid: ME }, { maxRssBytes: MIB }, () => { told += 1 })
  await governor.tick()
  assert.equal(governor.failedSamples, 1)
  assert.equal(faults.length, 1)
  assert.deepEqual(killed, [])
  assert.equal(told, 0)
  fail = false
  await governor.tick()
  assert.equal(told, 1)
  assert.equal(killed.length, 1)
})

await check('G11 ticks never overlap: a slow table is read once however many ticks ask', async () => {
  let reads = 0
  const { governor } = harness(async () => { reads += 1; await sleep(60); return [row(100, ME, 1)] })
  governor.watch({ rootPid: 100, parentPid: ME }, { maxRssBytes: 100 * MIB }, () => undefined)
  await Promise.all([governor.tick(), governor.tick(), governor.tick()])
  assert.equal(reads, 1)
})

await check('G12 a breach handler that throws is reported, and the tree is killed all the same', async () => {
  const { governor, killed, faults } = harness(() => [row(100, ME, 900)])
  governor.watch({ rootPid: 100, parentPid: ME }, { maxRssBytes: MIB }, () => { throw new Error('handler bug') })
  await governor.tick()
  assert.deepEqual(killed, [[100]])
  assert.equal(faults.length, 1)
})

await check('G13 limits are validated; a watch with no limit watches nothing and starts no timer', () => {
  const { governor } = harness(() => [])
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => governor.watch({ rootPid: 100, parentPid: ME }, { maxRssBytes: bad }, () => undefined), RangeError)
    assert.throws(() => governor.watch({ rootPid: 100, parentPid: ME }, { maxCpuSeconds: bad }, () => undefined), RangeError)
  }
  assert.throws(() => governor.watch({ rootPid: 0, parentPid: ME }, { maxRssBytes: MIB }, () => undefined), RangeError)
  assert.throws(() => governor.watch({ rootPid: 100, parentPid: 1.5 }, { maxRssBytes: MIB }, () => undefined), RangeError)
  const none = governor.watch({ rootPid: 100, parentPid: ME }, {}, () => undefined)
  assert.equal(governor.size, 0, 'a watch with no limit is not registered at all')
  none()
  assert.throws(() => new ProcessTreeGovernor({ intervalMs: 0 }), RangeError)
})

await check('G14 the timer drives sampling on its own, and close() stops it', async () => {
  let reads = 0
  const killed: number[][] = []
  const governor = new ProcessTreeGovernor({ intervalMs: 15, table: async () => { reads += 1; return [row(100, ME, 900)] }, kill: (pids) => { killed.push([...pids]) } })
  let told = 0
  governor.watch({ rootPid: 100, parentPid: ME }, { maxRssBytes: MIB }, () => { told += 1 })
  await waitFor(() => told === 1, 2_000, 'the timer to sample')
  assert.deepEqual(killed, [[100]])
  const readsAtBreach = reads
  await sleep(80)
  assert.equal(reads, readsAtBreach, 'with nothing left to watch the timer stopped')
  governor.close()
})

await check('G15 a governor that cannot see the process table says so: it must read, and it must show this very process', async () => {
  const seeing = harness(() => [row(process.pid, 1, 50), row(100, process.pid, 5)])
  await seeing.governor.probe()
  const failing = harness(() => { throw new Error('ps: command not found') })
  await assert.rejects(failing.governor.probe(), (error: unknown) => error instanceof ProcessTableUnavailableError && (error.cause as Error).message === 'ps: command not found')
  const blind = harness(() => [row(100, 1, 50)])
  await assert.rejects(blind.governor.probe(), ProcessTableUnavailableError)
  const empty = harness(() => [row(process.pid, 1, 0)])
  await assert.rejects(empty.governor.probe(), ProcessTableUnavailableError)
})

// ---- P: ports with real processes -----------------------------------------------------------

console.log('P  ports (real processes)')

const scratch = mkdtempSync(join(tmpdir(), 'gotry-compute-isolation-'))
const ports: ManagedDshRunPort[] = []
function portOf(options: ConstructorParameters<typeof ManagedDshRunPort>[0] = {}): ManagedDshRunPort {
  const port = new ManagedDshRunPort({ workerPath: FIXTURE, graceMs: 50, ...options })
  ports.push(port)
  return port
}
function pidFileEnv(name: string, extra: Record<string, string> = {}): { env: NodeJS.ProcessEnv; read: () => number } {
  const file = join(scratch, `${name}.pid`)
  return { env: { ...process.env, TENANT_FIXTURE_PID_FILE: file, ...extra }, read: () => Number(readFileSync(file, 'utf8')) }
}
async function readPid(read: () => number): Promise<number> {
  await waitFor(() => { try { return read() > 0 } catch { return false } }, 5_000, 'the worker pid file')
  return read()
}

const fast = new ProcessTreeGovernor({ intervalMs: 100 })

await check('P1 a worker that leaks off-heap memory is killed once its tree is over the limit, with a typed reason', async () => {
  const worker = pidFileEnv('memory')
  const port = portOf({ env: worker.env, limits: { maxRssBytes: 300 * MIB, governor: fast } })
  const pid = await readPid(worker.read)
  const started = Date.now()
  const error = await rejection(port.run('memory', { sessionId: 'p1' }))
  assert.ok(error instanceof ManagedDshResourceLimitError, `expected a resource-limit error, got ${String(error)}`)
  assert.equal(error.breach.kind, 'memory')
  assert.equal(error.breach.limit, 300 * MIB)
  assert.ok(error.breach.observed > 300 * MIB)
  assert.ok(Date.now() - started < 15_000, 'the kill is prompt')
  await waitFor(() => !alive(pid), 5_000, 'the worker to be gone')
  const again = await rejection(port.run('ok', { sessionId: 'p1' }))
  assert.ok(again instanceof ManagedDshResourceLimitError, 'the port stays failed with the same reason')
})

await check('P2 a runaway grandchild counts against the tree: the whole tree is killed, not just the worker', async () => {
  const worker = pidFileEnv('grandchild')
  const port = portOf({ env: worker.env, limits: { maxRssBytes: 300 * MIB, governor: fast } })
  const pid = await readPid(worker.read)
  const spawned = await port.run('memory-in-child', { sessionId: 'p2' })
  const childPid = (spawned.events[0] as { childPid: number }).childPid
  assert.ok(alive(childPid))
  await waitFor(() => !alive(childPid) && !alive(pid), 15_000, 'the grandchild and the worker to be gone')
  const error = await rejection(port.run('ok', { sessionId: 'p2' }))
  assert.ok(error instanceof ManagedDshResourceLimitError)
  assert.equal(error.breach.kind, 'memory')
})

await check('P3 a worker that spins is killed once its tree is over the CPU limit', async () => {
  const worker = pidFileEnv('cpu')
  const port = portOf({ env: worker.env, limits: { maxCpuSeconds: 1, governor: fast } })
  const pid = await readPid(worker.read)
  const error = await rejection(port.run('cpu', { sessionId: 'p3' }))
  assert.ok(error instanceof ManagedDshResourceLimitError, `expected a resource-limit error, got ${String(error)}`)
  assert.equal(error.breach.kind, 'cpu')
  await waitFor(() => !alive(pid), 5_000, 'the worker to be gone')
})

await check('P4 the V8 heap ceiling reaches the worker, and a worker that exhausts it is a typed resource-limit death', async () => {
  const worker = pidFileEnv('heap')
  const port = portOf({ env: worker.env, limits: { heapMb: 64 } })
  await readPid(worker.read)
  const error = await rejection(port.run('heap', { sessionId: 'p4' }))
  assert.ok(error instanceof ManagedDshResourceLimitError, `expected a resource-limit error, got ${String(error)}`)
  assert.equal(error.breach.kind, 'heap')
  assert.equal(error.breach.limit, 64 * MIB)
  const inspector = portOf({ limits: { heapMb: 96 } })
  const seen = await inspector.run('ok', { sessionId: 'p4b' })
  assert.match(String((seen.events[0] as { nodeOptions: string }).nodeOptions), /--max-old-space-size=96/)
  assert.ok((seen.events[0] as { execArgv: string[] }).execArgv.includes('--max-old-space-size=96'), 'the worker\'s own command line carries it too')
  const inherited = portOf({ env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=9999 --no-warnings' }, limits: { heapMb: 96 } })
  const merged = String(((await inherited.run('ok', { sessionId: 'p4c' })).events[0] as { nodeOptions: string }).nodeOptions)
  assert.match(merged, /--max-old-space-size=96/)
  assert.doesNotMatch(merged, /9999/, 'the limit replaces a ceiling that was already set instead of sitting beside it')
  assert.match(merged, /--no-warnings/, 'other options are kept')
})

await check('P5 a line that never ends is cut off at the cap: typed, and this process does not grow with it', async () => {
  const worker = pidFileEnv('flood')
  const port = portOf({ env: worker.env, limits: { maxLineChars: MIB } })
  const pid = await readPid(worker.read)
  const before = process.memoryUsage().rss
  const error = await rejection(port.run('flood', { sessionId: 'p5' }))
  assert.ok(error instanceof ManagedDshResourceLimitError, `expected a resource-limit error, got ${String(error)}`)
  assert.equal(error.breach.kind, 'output')
  assert.equal(error.breach.limit, MIB)
  assert.ok(error.breach.observed > MIB)
  await waitFor(() => !alive(pid), 5_000, 'the worker to be gone')
  const grown = process.memoryUsage().rss - before
  assert.ok(grown < 128 * MIB, `the parent grew by ${Math.round(grown / MIB)} MiB while a 256 MiB line was written`)
})

await check('P6 a runaway does not move its neighbours: another port answers promptly while it leaks, and after it is killed', async () => {
  const hot = pidFileEnv('hot')
  const hotPort = portOf({ env: hot.env, limits: { maxRssBytes: 300 * MIB, governor: fast } })
  const neighbour = portOf({ limits: { maxRssBytes: 300 * MIB, governor: fast } })
  await readPid(hot.read)
  const runaway = rejection(hotPort.run('memory', { sessionId: 'p6-hot' }))
  const latencies: number[] = []
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const started = Date.now()
    const result = await neighbour.run('ok', { sessionId: `p6-${attempt}` })
    latencies.push(Date.now() - started)
    assert.equal(result.finalResponse, 'ok')
  }
  assert.ok(Math.max(...latencies) < 10_000, `the neighbour answered in ${latencies.join(', ')} ms while the other leaked`)
  assert.ok(await runaway instanceof ManagedDshResourceLimitError)
  assert.equal((await neighbour.run('ok', { sessionId: 'p6-after' })).finalResponse, 'ok', 'the neighbour is still served after the kill')
})

await check('P7 without limits nothing changes: no ceiling in the environment, nothing watched, the shared governor idle', async () => {
  const before = sharedProcessTreeGovernor().size
  const port = portOf()
  const result = await port.run('ok', { sessionId: 'p7' })
  assert.doesNotMatch(String((result.events[0] as { nodeOptions: string | null }).nodeOptions ?? ''), /max-old-space-size/)
  assert.equal(sharedProcessTreeGovernor().size, before)
  const heapOnly = portOf({ limits: { heapMb: 128 } })
  await heapOnly.run('ok', { sessionId: 'p7b' })
  assert.equal(sharedProcessTreeGovernor().size, before, 'a heap ceiling alone needs no sampler')
})

await check('P8 closing a port stops its watch; a port whose limits are not positive numbers is refused before it spawns anything', async () => {
  const governor = new ProcessTreeGovernor({ intervalMs: 100 })
  const port = portOf({ limits: { maxRssBytes: 1_000 * MIB, governor } })
  await port.run('ok', { sessionId: 'p8' })
  assert.equal(governor.size, 1)
  const closing = port.close()
  assert.equal(governor.size, 0, 'the watch ends the moment close begins, not when the worker finally exits')
  await closing
  for (const limits of [{ heapMb: 0 }, { maxRssBytes: -1 }, { maxCpuSeconds: Number.NaN }, { maxLineChars: 0 }]) {
    assert.throws(() => new ManagedDshRunPort({ workerPath: FIXTURE, limits }), RangeError)
  }
  governor.close()
})

await check('P10 a governor that was asked for and never attached says so; one that attached is silent', async () => {
  const silentLines: string[] = []
  const silent = portOf({
    env: { ...process.env, TENANT_FIXTURE_NO_LIFECYCLE: '1' },
    limits: { maxRssBytes: 1_000 * MIB, attachDeadlineMs: 150, governor: fast },
    bootLog: (line: string) => silentLines.push(line),
  })
  await waitFor(() => silentLines.length > 0, 5_000, 'the missing governor to be reported')
  assert.match(silentLines[0]!, /^RESOURCE_GOVERNOR_UNATTACHED \{"role":"unspecified","afterMs":150\}$/)
  void silent
  const attachedLines: string[] = []
  const attached = portOf({ limits: { maxRssBytes: 1_000 * MIB, attachDeadlineMs: 150, governor: fast }, bootLog: (line: string) => attachedLines.push(line) })
  await attached.run('ok', { sessionId: 'p10' })
  await sleep(400)
  assert.deepEqual(attachedLines, [])
  const heapOnly: string[] = []
  portOf({ env: { ...process.env, TENANT_FIXTURE_NO_LIFECYCLE: '1' }, limits: { heapMb: 64, attachDeadlineMs: 150 }, bootLog: (line: string) => heapOnly.push(line) })
  await sleep(400)
  assert.deepEqual(heapOnly, [], 'a heap ceiling needs no sampler, so nothing is missing')
  assert.throws(() => new ManagedDshRunPort({ workerPath: FIXTURE, limits: { attachDeadlineMs: 0 } }), RangeError)
})

await check('P9 the planner hands its limits to the real worker: the ceiling is on its command line and its tree is watched until the port closes', async () => {
  const governor = new ProcessTreeGovernor({ intervalMs: 3_600_000 })
  const stateRoot = mkdtempSync(join(scratch, 'real-port-'))
  const previousWarmup = process.env.GOTRY_BOOKING_COPILOT_WARMUP
  process.env.GOTRY_BOOKING_COPILOT_WARMUP = '0'
  try {
    const port = await createRealRunPort({
      stateRoot,
      env: { PATH: process.env.PATH, DEEPSEEK_API_KEY: 'unused-key', DEEPSEEK_BASE_URL: 'http://127.0.0.1:9/v1', DEEPSEEK_PROVIDER: 'gateway-chat', DEEPSEEK_MODEL: 'probe-model' },
      resourceLimits: { heapMb: 77, maxRssBytes: 4_000 * MIB, governor },
    })
    await port.warmup!()
    const table = execFileSync('/bin/ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } })
    const workers = table.split('\n').filter((line) => new RegExp(`^\\s*\\d+\\s+${process.pid}\\s+`).test(line) && line.includes('--max-old-space-size=77'))
    assert.equal(workers.length, 1, 'one real worker, started with the ceiling on its command line')
    assert.equal(governor.size, 1, 'and its tree is watched')
    await port.close()
    assert.equal(governor.size, 0, 'closing the port ends the watch')
  } finally {
    if (previousWarmup === undefined) delete process.env.GOTRY_BOOKING_COPILOT_WARMUP
    else process.env.GOTRY_BOOKING_COPILOT_WARMUP = previousWarmup
    governor.close()
  }
})

// ---- D: planner ------------------------------------------------------------------------------

console.log('D  planner')

const task: BookingCopilotTaskState = {
  schemaVersion: 'booking.surface',
  taskId: 'task-compute-1',
  contextRef: 'ctx-compute-1',
  surface: 'tenant',
  revision: 0,
  allowedActions: ['search.patch', 'search.run'],
  userTurnCount: 1,
  lastTurnId: 'turn-compute-1',
  operationCount: 0,
  phase: 'planning',
  lastSequence: 0,
  availability: { initialized: true, recoveryStarted: false, availabilityPhase: 'need_offers', activeHotelOrdinal: 0, hotelRefs: [], hotels: {}, attempts: [], queryReservations: [] },
}
task.workspaceSnapshot = {
  schemaVersion: 'booking.surface',
  contextRef: task.contextRef,
  surface: 'tenant',
  revision: 0,
  locale: 'zh-CN',
  currency: 'AED',
  searchDraft: {},
  results: { status: 'idle' },
  visibleHotels: [],
  loadedOffers: [],
  shortlistedOfferRefs: [],
  capabilities: { surface: 'tenant', allowedActions: ['search.patch', 'search.run'] },
}
const turn = {
  schemaVersion: 'booking.surface' as const,
  kind: 'user.turn' as const,
  taskId: task.taskId,
  turnId: task.lastTurnId!,
  workspace: task.workspaceSnapshot,
  request: { text: 'Find hotels' },
}

await check('D1 a resource kill ends the turn as a non-retryable PLANNER_FAILED, once, on the port that was killed', async () => {
  let factoryCalls = 0
  let closed = 0
  let runs = 0
  const metrics: DshPlannerTurnMetric[] = []
  const planner = await createDshEmbeddedBookingPlanner({
    runPortFactory: () => {
      factoryCalls += 1
      const port: DshPlannerRunPort = {
        run: async (): Promise<DshPlannerRunResult> => { runs += 1; throw new ManagedDshResourceLimitError({ kind: 'memory', limit: 1, observed: 2 }) },
        async close() { closed += 1 },
        bootObservation: () => undefined,
      }
      return port
    },
    turnTimeoutMs: 20_000,
    onMetric: (metric) => metrics.push(metric),
  } as DshEmbeddedBookingPlannerOptions)
  const decisions = await planner.plannerFactory(task).next({ task, turn })
  assert.equal(decisions.length, 1)
  const decision = decisions[0]!
  assert.equal(decision.kind, 'error')
  if (decision.kind !== 'error') throw new Error('unreachable')
  assert.equal(decision.error.code, 'PLANNER_FAILED')
  assert.equal(decision.error.retryable, false)
  assert.equal(runs, 1, 'the killed run is not repeated')
  assert.equal(factoryCalls, 1, 'no fresh port is made to run the same turn again')
  assert.equal(closed, 1, 'the killed port is retired')
  assert.equal(metrics[0]?.outcome, 'resource_limit')
  assert.doesNotMatch(JSON.stringify(decision), /memory|limit|observed/i, 'the answer names no limit and no number')
  await planner.close()
})

await check('D2 end to end: a real worker tree that leaks inside a real planner turn is killed, answered, and gone', async () => {
  const worker = pidFileEnv('planner', { TENANT_FIXTURE_MODE: 'memory' })
  let created: DshPlannerRunPort | undefined
  const metrics: DshPlannerTurnMetric[] = []
  const planner = await createDshEmbeddedBookingPlanner({
    runPortFactory: () => {
      created = createManagedDshRunPort({ workerPath: FIXTURE, graceMs: 50, env: worker.env, limits: { maxRssBytes: 300 * MIB, governor: fast } })
      return created
    },
    turnTimeoutMs: 60_000,
    stallSoftBudgetMs: 60_000,
    onMetric: (metric) => metrics.push(metric),
  } as DshEmbeddedBookingPlannerOptions)
  const started = Date.now()
  const decisions = await planner.plannerFactory(task).next({ task, turn })
  const decision = decisions[0]!
  assert.equal(decision.kind, 'error')
  if (decision.kind !== 'error') throw new Error('unreachable')
  assert.equal(decision.error.code, 'PLANNER_FAILED')
  assert.equal(decision.error.retryable, false)
  assert.equal(metrics[0]?.outcome, 'resource_limit')
  assert.ok(Date.now() - started < 30_000)
  await waitFor(() => !alive(worker.read()), 5_000, 'the planner worker to be gone')
  await planner.close()
})

await check('D4 limits that need a sampler are checked before the first child starts; a blind sampler stops the real tenant planner, loudly', async () => {
  const blind = new ProcessTreeGovernor({ table: async () => [] })
  const seeing = new ProcessTreeGovernor({ table: async () => [row(process.pid, 1, 50)] })
  await assertPlannerLimitsEnforceable({ maxRssBytes: MIB, governor: seeing })
  await assertPlannerLimitsEnforceable({ heapMb: 64, maxLineChars: MIB, governor: blind })
  await assert.rejects(assertPlannerLimitsEnforceable({ maxCpuSeconds: 5, governor: blind }), ProcessTableUnavailableError)
  const stubTickets = { issue: () => { throw new Error('no child may be started') } }
  const provider = createDshTenantPlannerProvider({ llmTickets: stubTickets, resourceLimits: { maxRssBytes: MIB, governor: blind } })
  await assert.rejects(
    provider.forTenant({ tenantRoot: join(scratch, 'tenant-blind'), cachePartition: `pc-${'a'.repeat(32)}`, reportUsage() {} }),
    ProcessTableUnavailableError,
  )
  await provider.close()
})

await check('D3 the tenant planner provider hands every tenant the default ceilings, and a deployment can set its own', async () => {
  const seen: Array<DshEmbeddedBookingPlannerOptions> = []
  const fake = async (options: DshEmbeddedBookingPlannerOptions) => {
    seen.push(options)
    return { plannerFactory: () => ({ next: async () => [] }), close: async () => undefined }
  }
  const context = { tenantRoot: join(scratch, 'tenant-a'), cachePartition: 'unused', reportUsage: () => undefined } as unknown as Parameters<ReturnType<typeof createDshTenantPlannerProvider>['forTenant']>[0]
  await createDshTenantPlannerProvider({}, fake).forTenant(context)
  assert.deepEqual(seen[0]!.resourceLimits, DEFAULT_TENANT_PLANNER_RESOURCE_LIMITS)
  const custom = { heapMb: 256, maxRssBytes: 700 * MIB }
  await createDshTenantPlannerProvider({ resourceLimits: custom }, fake).forTenant(context)
  assert.deepEqual(seen[1]!.resourceLimits, custom)
  assert.ok(Object.isFrozen(DEFAULT_TENANT_PLANNER_RESOURCE_LIMITS))
  const limits = DEFAULT_TENANT_PLANNER_RESOURCE_LIMITS
  assert.ok(limits.heapMb! > 0 && limits.maxRssBytes! > limits.heapMb! * MIB, 'the tree ceiling leaves room for more than one heap')
  assert.ok(limits.maxCpuSeconds! > 0 && limits.maxLineChars! > 0)
})

// ---- R: replica capacity ---------------------------------------------------------------------------

console.log('R  replica capacity')

const ORG = 'acme'
const ORG_KEY = Buffer.alloc(32, 0x42)
const tenantNumber = (n: number): string => deriveLedgerTenantId(ORG_KEY, 'https://idp.acme.example', `capacity-user-${n}`)
const routerCleanups: Array<() => void | Promise<void>> = []

function capacityFleet(name: string, maxOpenTenants?: number) {
  const dir = join(scratch, name)
  const leases = new SqliteLeaseStore({ path: join(dir, 'leases.db') })
  routerCleanups.push(() => leases.close())
  const router = new TenantRouter({
    stateRoot: join(dir, 'node'), replicaId: `replica-${name}`, leases, durable: new DirDurableStore(join(dir, 'durable')),
    ttlMs: 60_000, marginMs: 2_000, autoRenew: false, ...(maxOpenTenants === undefined ? {} : { maxOpenTenants }),
  })
  routerCleanups.push(() => router.close().then(() => undefined))
  return { router, leases }
}

await check('R1 a replica at its cap refuses a new tenant before its lease or any file exists, and keeps serving the ones it has', async () => {
  const { router, leases } = capacityFleet('r1', 3)
  const handles = [await router.openTenant(ORG, tenantNumber(1)), await router.openTenant(ORG, tenantNumber(2)), await router.openTenant(ORG, tenantNumber(3))]
  const refused = await rejection(router.openTenant(ORG, tenantNumber(4)))
  assert.ok(refused instanceof ReplicaAtCapacityError)
  assert.equal(refused.limit, 3)
  assert.equal(existsSync(router.tenantRootOf(ORG, tenantNumber(4))), false, 'no directory for the refused tenant')
  assert.ok(!leases.history().some((entry) => entry.key.endsWith(tenantNumber(4))), 'no lease was taken for it')
  assert.strictEqual(await router.openTenant(ORG, tenantNumber(2)), handles[1], 'a tenant already held is still served at the cap')
  assert.equal(router.openCount(), 3)
  await handles[0]!.handoff()
  const fits = await router.openTenant(ORG, tenantNumber(4))
  assert.ok(fits.isOpen(), 'a handoff frees a slot')
})

await check('R2 the cap counts tenants still opening, so a burst cannot overshoot it', async () => {
  const { router } = capacityFleet('r2', 3)
  const settled = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => router.openTenant(ORG, tenantNumber(100 + i))))
  const opened = settled.filter((result) => result.status === 'fulfilled').length
  const refused = settled.filter((result) => result.status === 'rejected' && result.reason instanceof ReplicaAtCapacityError).length
  assert.equal(opened, 3)
  assert.equal(refused, 9)
  assert.equal(router.openCount(), 3)
  const same = await Promise.all(Array.from({ length: 6 }, () => router.openTenant(ORG, tenantNumber(100))))
  assert.ok(same.every((handle) => handle === same[0]), 'concurrent opens of one tenant still share one acquisition')
})

await check('R3 without a cap nothing changes, and a cap that is not a positive integer is refused at construction', async () => {
  const { router } = capacityFleet('r3')
  for (let i = 0; i < 25; i += 1) await router.openTenant(ORG, tenantNumber(200 + i))
  assert.equal(router.openCount(), 25)
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => new TenantRouter({ stateRoot: join(scratch, 'bad'), replicaId: 'x', leases: {} as never, durable: {} as never, maxOpenTenants: bad }), RangeError, String(bad))
  }
})

await check('R4 at the HTTP boundary a full replica is a typed 503 with no retry hint, and names no limit', () => {
  const rejection503 = tenantRejection(new ReplicaAtCapacityError(3))
  assert.equal(rejection503.status, 503)
  assert.equal(rejection503.retryAfterSeconds, undefined, 'no retry hint: only a handoff frees a slot, so retrying this replica soon would not help')
  assert.deepEqual(rejection503.body, { error: { code: 'tenant_unavailable' } })
})

// ---- cleanup ---------------------------------------------------------------------------------

await Promise.allSettled(ports.map((port) => port.close()))
for (const cleanup of routerCleanups.reverse()) { try { await cleanup() } catch { /* best effort */ } }
fast.close()
sharedProcessTreeGovernor().close()
rmSync(scratch, { recursive: true, force: true })
console.log(`tenant-compute-isolation: ${passed} checks passed`)
process.exit(0)
