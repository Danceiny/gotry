/**
 * Fault-injection drill of the per-tenant state layer (AaaS A1.4, docs/rfc/aaas-rfc.md §4.2, §4.6 and §7; #275 checklist).
 *
 * Real OS processes are the replicas. Four of them contend for two tenants through one SQLite lease file and one
 * durable directory, each on its own state root, writing numbered events and snapshotting every 120 ms. The drill
 * kills owners with SIGKILL, freezes an owner with SIGSTOP past its lease and resumes it, and hands tenants off
 * with SIGTERM. Afterwards a verifier takes each tenant over and checks the ledger against what the replicas logged.
 *
 * What it proves (all offline, on isolated roots, no network, no model):
 *   I1  the lease epochs of a tenant are consecutive: no epoch was granted twice or skipped;
 *   I2  each epoch has at most one writer;
 *   I3  no write is acknowledged after the next owner took the lease (the local gate works on a real clock);
 *   I4  the restored ledger is intact, holds only this tenant, and is exactly the lineage the durable copies describe:
 *       every pinned snapshot holds exactly the writes acknowledged before it began, and nothing else is there;
 *   I5  a graceful handoff loses nothing, also from a consumer that keeps writing through the ledger it holds while the
 *       replica hands off (and is refused once the final image is being taken), over an object store that is slow to
 *       take an image; a crash loses only the writes after the last snapshot;
 *   I6  the two tenants never see each other's writes.
 *
 * A simulated trigger is not the real trigger: this is engineering evidence for A1 and counts for none of A3 or A4.
 *
 * Run: cd ts && npx tsx scripts/tenant-state-drill-tests.ts
 */

import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { DirDurableStore } from '../src/tenant-state/durable-store.ts'
import { LeaseHeldError } from '../src/tenant-state/errors.ts'
import { deriveLedgerTenantId, leaseKeyFor } from '../src/tenant-state/ids.ts'
import { SqliteLeaseStore } from '../src/tenant-state/lease-store.ts'
import { TenantRouter, type TenantHandle } from '../src/tenant-state/tenant-router.ts'

const TS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORKER = join(TS_DIR, 'scripts', 'tenant-state-drill-worker.ts')
const ORG = 'acme'
const ORG_KEY = Buffer.alloc(32, 3)
const TENANT_A = deriveLedgerTenantId(ORG_KEY, 'https://idp.example/acme', 'user-1')
const TENANT_B = deriveLedgerTenantId(ORG_KEY, 'https://idp.example/acme', 'user-2')
const KEY_A = leaseKeyFor(ORG, TENANT_A)
const KEY_B = leaseKeyFor(ORG, TENANT_B)
const TENANTS = [{ label: 'a', tenant: TENANT_A, key: KEY_A }, { label: 'b', tenant: TENANT_B, key: KEY_B }] as const
const DEADLINE_MS = 170_000

const root = mkdtempSync(join(tmpdir(), 'gotry-tenant-drill-'))
const leaseDb = join(root, 'leases.db')
const durableDir = join(root, 'durable')
const logDir = join(root, 'logs')
mkdirSync(logDir, { recursive: true })
mkdirSync(join(root, 'tmp'), { recursive: true })
const leases = new SqliteLeaseStore({ path: leaseDb })
const durable = new DirDurableStore(durableDir)

let passed = 0
function ok(condition: unknown, message: string): void {
  assert.ok(condition, message)
  passed += 1
}

function eq(actual: unknown, expected: unknown, message: string): void {
  assert.deepEqual(actual, expected, message)
  passed += 1
}

// ---- processes -------------------------------------------------------------------------

interface Replica {
  readonly id: string
  readonly child: ChildProcess
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  stderr: string
}

const replicas = new Map<string, Replica>()
let nextReplica = 1

function spawnReplica(): Replica {
  const id = `w${nextReplica++}`
  const child = spawn(process.execPath, ['--import', 'tsx', WORKER, join(root, 'nodes', id), leaseDb, durableDir, logDir, id, ORG, TENANT_A, TENANT_B], {
    cwd: TS_DIR,
    // A replica killed mid-snapshot cannot clean up its scratch directory, so it gets one inside the drill root.
    env: { ...process.env, TMPDIR: join(root, 'tmp'), TENANT_DRILL_SLOW_PUT_MS: '40' },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  const replica: Replica = {
    id,
    child,
    stderr: '',
    exited: new Promise((resolve) => { child.once('close', (code, signal) => { resolve({ code, signal }) }) }),
  }
  child.stderr?.on('data', (chunk: Buffer) => { replica.stderr += chunk.toString() })
  replicas.set(id, replica)
  return replica
}

const deadline = setTimeout(() => {
  for (const replica of replicas.values()) replica.child.kill('SIGKILL')
  console.error(`DRILL DEADLINE: ${DEADLINE_MS} ms exceeded, replicas killed`)
  process.exit(1)
}, DEADLINE_MS)

async function waitFor<T>(label: string, probe: () => T | Promise<T>, accept: (value: T) => boolean, timeoutMs = 25_000): Promise<T> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (accept(value)) return value
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`)
    await sleep(25)
  }
}

// ---- logs ------------------------------------------------------------------------------------

interface Entry {
  t: string
  replica: string
  via?: string
  wall: number
  tenant?: string
  epoch?: number
  n?: number
  at?: number
  seq?: number
  covered?: number
  code?: string
  event?: string
  key?: string
  flushed?: boolean
}

function readLogs(): Entry[] {
  const entries: Entry[] = []
  for (const file of readdirSync(logDir)) {
    for (const line of readFileSync(join(logDir, file), 'utf8').split('\n')) {
      if (!line) continue
      try {
        entries.push(JSON.parse(line) as Entry)
      } catch {
        // A replica killed mid-write leaves one torn last line.
      }
    }
  }
  return entries.sort((a, b) => a.wall - b.wall)
}

const acksIn = (label: string, epoch: number): number => readLogs().filter(e => e.t === 'ack' && e.tenant === label && e.epoch === epoch).length
const epochOf = async (key: string): Promise<number> => (await leases.read(key))?.epoch ?? 0

async function crash(replica: Replica): Promise<void> {
  replica.child.kill('SIGKILL')
  await replica.exited
  replicas.delete(replica.id)
  spawnReplica()
}

async function takeover(label: string, key: string, previous: number): Promise<number> {
  const epoch = await waitFor(`a new owner of tenant ${label}`, () => epochOf(key), value => value > previous)
  await waitFor(`acknowledged writes by the owner of epoch ${epoch} of tenant ${label}`, () => acksIn(label, epoch), count => count >= 8)
  return epoch
}

try {
  // ---- scenario ------------------------------------------------------------------------------------
  console.log('-- scenario: four replicas, two tenants, kills, a pause and a graceful handoff')
  for (let index = 0; index < 4; index += 1) spawnReplica()
  for (const { label, key } of TENANTS) {
    await waitFor(`tenant ${label} to be served`, async () => ({ epoch: await epochOf(key), acks: acksIn(label, 1) }), value => value.epoch >= 1 && value.acks >= 15)
  }
  await sleep(1_200)

  const killedEpochs: Array<{ label: string; epoch: number }> = []
  let epochA = await epochOf(KEY_A)
  for (let round = 1; round <= 2; round += 1) {
    const record = await leases.read(KEY_A)
    const owner = replicas.get(record?.owner ?? '')
    assert.ok(owner, `the owner of tenant a (${record?.owner}) is one of ours`)
    killedEpochs.push({ label: 'a', epoch: record?.epoch ?? 0 })
    await crash(owner)
    epochA = await takeover('a', KEY_A, epochA)
  }
  console.log(`  ok - two SIGKILLs of the owner of tenant a: epoch now ${epochA}`)

  const recordB = await leases.read(KEY_B)
  const frozen = replicas.get(recordB?.owner ?? '')
  assert.ok(frozen, 'the owner of tenant b is one of ours')
  const frozenEpoch = recordB?.epoch ?? 0
  frozen.child.kill('SIGSTOP')
  const takenAt = Date.now()
  const epochB = await takeover('b', KEY_B, frozenEpoch)
  await sleep(700)
  const resumedAt = Date.now()
  frozen.child.kill('SIGCONT')
  await sleep(1_800)
  const afterResume = readLogs().filter(e => e.replica === frozen.id && e.wall >= resumedAt && (e.t === 'refused' || (e.t === 'event' && e.event === 'lost')))
  assert.ok(afterResume.length > 0, 'a frozen owner that wakes up past its lease is refused or told it lost the tenant, and the logs show it')
  console.log(`  ok - owner of tenant b frozen past its lease (epoch ${frozenEpoch} -> ${epochB}), resumed after ${resumedAt - takenAt} ms: ${afterResume.length} refusals or losses logged after the resume`)

  const gracefulOwner = replicas.get((await leases.read(KEY_A))?.owner ?? '')
  assert.ok(gracefulOwner, 'the owner of tenant a is one of ours')
  const gracefulEpoch = await epochOf(KEY_A)
  gracefulOwner.child.kill('SIGTERM')
  await gracefulOwner.exited
  replicas.delete(gracefulOwner.id)
  spawnReplica()
  epochA = await takeover('a', KEY_A, gracefulEpoch)
  console.log(`  ok - graceful SIGTERM handoff of tenant a: epoch ${gracefulEpoch} -> ${epochA}`)

  await sleep(1_500)
  await waitFor('every replica to have started', () => readLogs().filter(e => e.t === 'start').length, count => count === nextReplica - 1, 30_000)
  for (const replica of [...replicas.values()]) replica.child.kill('SIGTERM')
  for (const replica of [...replicas.values()]) {
    const settled = await Promise.race([replica.exited, sleep(20_000).then(() => 'timeout' as const)])
    if (settled === 'timeout') replica.child.kill('SIGKILL')
    const ended = await replica.exited
    assert.ok(settled !== 'timeout' && ended.code === 0, `replica ${replica.id} ended with ${String(ended.code)} ${String(ended.signal)}: ${replica.stderr.slice(0, 400)}`)
  }
  clearTimeout(deadline)

  // ---- verification --------------------------------------------------------------------------------------
  console.log('-- verification: a fresh replica takes each tenant over and the ledger is compared with the logs')
  const verifier = new TenantRouter({
    stateRoot: join(root, 'verifier'), replicaId: 'verifier', leases, durable, ttlMs: 1_500, marginMs: 400, autoRenew: true,
  })
  const logs = readLogs()
  eq(logs.filter(e => e.t === 'start').length, nextReplica - 1, 'every replica logged its start')

  const gracefulEpochs = new Map<string, Set<number>>()
  for (const entry of logs) {
    if (entry.t === 'event' && entry.event === 'released' && entry.flushed === true && entry.key !== undefined && entry.epoch !== undefined) {
      gracefulEpochs.set(entry.key, (gracefulEpochs.get(entry.key) ?? new Set<number>()).add(entry.epoch))
    }
  }

  let totalAcks = 0
  let totalLost = 0
  let checkedLinks = 0
  for (const { label, tenant, key } of TENANTS) {
    let handle: TenantHandle | null = null
    for (let waited = 0; handle === null; waited += 150) {
      try {
        handle = await verifier.openTenant(ORG, tenant)
      } catch (error) {
        if (!(error instanceof LeaseHeldError) || waited > 15_000) throw error
        await sleep(150)
      }
    }

    // I1: consecutive epochs, one grant each.
    const grants = leases.history(key).filter(entry => entry.op === 'acquire')
    eq(grants.map(entry => entry.epoch), grants.map((_, index) => index + 1), `I1 tenant ${label}: lease epochs are consecutive`)
    ok(grants.length >= (label === 'a' ? 5 : 3), `tenant ${label} changed hands at least ${label === 'a' ? 5 : 3} times (${grants.length} grants)`)
    const grantedAt = new Map(grants.map(entry => [entry.epoch, entry.atMs]))

    // I2 and I3: one writer per epoch, and no acknowledgement after the next owner took the lease.
    const acks = logs.filter(e => e.t === 'ack' && e.tenant === label)
    const writers = new Map<number, Set<string>>()
    for (const ack of acks) writers.set(ack.epoch as number, (writers.get(ack.epoch as number) ?? new Set<string>()).add(ack.replica))
    for (const [epoch, who] of writers) ok(who.size === 1, `I2 tenant ${label} epoch ${epoch}: written by ${[...who].join(', ')}`)
    for (const ack of acks) {
      const next = grantedAt.get((ack.epoch as number) + 1)
      if (next !== undefined) ok((ack.at as number) < next, `I3 tenant ${label}: ack of epoch ${ack.epoch} #${ack.n} at ${ack.at} is before the next grant at ${next}`)
    }

    // I4: the lineage described by the durable copies, and the ledger equal to it.
    const restored = handle.restoredFrom
    assert.ok(restored, `tenant ${label} has a durable lineage to restore`)
    const chain: Array<{ epoch: number; seq: number }> = []
    for (let cursor: { epoch: number; seq: number } | null = restored; cursor !== null;) {
      chain.unshift({ epoch: cursor.epoch, seq: cursor.seq })
      const baseBytes = await durable.get(`${key}/e${String(cursor.epoch).padStart(8, '0')}/base.json`)
      assert.ok(baseBytes, `epoch ${cursor.epoch} pinned its base`)
      const base = JSON.parse(Buffer.from(baseBytes).toString('utf8')) as { from: { epoch: number; seq: number } | null }
      cursor = base.from
    }
    const startsByEpoch = new Map<number, number[]>()
    for (const entry of logs) {
      if (entry.t === 'snap-start' && entry.tenant === label) startsByEpoch.set(entry.epoch as number, [...startsByEpoch.get(entry.epoch as number) ?? [], entry.covered as number])
    }
    const expected = new Set<string>()
    const writesInChain = new Map<number, number>()
    let previousEvents = 0
    for (const link of chain) {
      const manifestBytes = await durable.get(`${key}/e${String(link.epoch).padStart(8, '0')}/snap-${String(link.seq).padStart(6, '0')}.json`)
      assert.ok(manifestBytes, `the manifest of e${link.epoch}/snap-${link.seq} exists`)
      const manifest = JSON.parse(Buffer.from(manifestBytes).toString('utf8')) as { events: number }
      const written = manifest.events - previousEvents
      previousEvents = manifest.events
      writesInChain.set(link.epoch, written)
      const covered = startsByEpoch.get(link.epoch)?.[link.seq - 1]
      if (covered !== undefined) {
        eq(written, covered, `I4 tenant ${label}: e${link.epoch}/snap-${link.seq} holds exactly the ${covered} writes acknowledged before it began`)
        checkedLinks += 1
      }
      for (let n = 1; n <= written; n += 1) expected.add(`${label}:${link.epoch}:${n}`)
    }
    const present = handle.run(ledger => (ledger.db.prepare("SELECT idem_key FROM events WHERE kind = 'tenant-state.drill'").all() as Array<{ idem_key: string }>).map(row => row.idem_key))
    eq(new Set(present), expected, `I4/I6 tenant ${label}: the ledger holds exactly the lineage, no write of another epoch, replica or tenant`)
    eq(present.length, expected.size, `I4 tenant ${label}: no event twice`)

    // I5: graceful epochs lose nothing; crashed epochs lose only the tail after their last pinned snapshot.
    for (const epoch of gracefulEpochs.get(key) ?? []) {
      eq(writesInChain.get(epoch) ?? 0, acksIn(label, epoch), `I5 tenant ${label}: graceful epoch ${epoch} lost no acknowledged write`)
    }
    let lost = 0
    for (const [epoch, who] of writers) {
      void who
      const tail = acksIn(label, epoch) - (writesInChain.get(epoch) ?? 0)
      ok(tail >= 0, `I5 tenant ${label} epoch ${epoch}: the lineage holds no more than was acknowledged`)
      ok(tail <= 400, `I5 tenant ${label} epoch ${epoch}: the lost tail (${tail}) stays within a few snapshot intervals`)
      lost += tail
    }
    totalAcks += acks.length
    totalLost += lost
    console.log(`  ok - tenant ${label}: ${grants.length} epochs, ${acks.length} acknowledged writes, lineage of ${chain.length} snapshots with ${expected.size} events, ${lost} acknowledged writes in crashed tails`)
  }
  await verifier.close()

  ok(checkedLinks > 0, `I4 the per-link check ran on ${checkedLinks} snapshots of the lineages, it is not skipped for want of a log`)
  const viewAcks = logs.filter(e => e.t === 'ack' && e.via === 'view').length
  const viewRefusals = logs.filter(e => e.t === 'refused' && e.via === 'view')
  ok(viewAcks > 0, `I5 a consumer that kept the ledger wrote ${viewAcks} acknowledged events through it while its replica handed off, and none of them is missing from the final images`)
  ok(viewRefusals.length > 0 && viewRefusals.every(e => (e.code ?? '').startsWith('GOTRY_TENANT_')), `I5 every refusal of that consumer is a typed tenant error (${viewRefusals.length} refusals), and not an untyped failure`)
  ok(viewRefusals.some(e => e.code === 'GOTRY_TENANT_DRAINING'), 'I5 at least one of them is the draining error: once the final image was being taken, the view said so (a replica starved past its lease may be fenced instead)')

  const killed = killedEpochs.length
  console.log(`tenant-state-drill-tests: ${passed} assertions passed (${killed} SIGKILLs, 1 SIGSTOP past the lease, 1 graceful handoff, ${totalAcks} acknowledged writes, ${totalLost} lost in crashed tails)`)
} finally {
  clearTimeout(deadline)
  for (const replica of replicas.values()) replica.child.kill('SIGKILL')
  leases.close()
  rmSync(root, { recursive: true, force: true })
}
