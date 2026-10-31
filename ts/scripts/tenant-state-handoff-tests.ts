/**
 * Graceful handoff, forget and the guarded view, as an independent review found them wanting (AaaS A1;
 * docs/rfc/aaas-rfc.md §4.2 items 5 and 6, §4.6; threats S-6 and S-12).
 *
 * The contract being pinned is the one the router already states: a write is acknowledged only if the lease is held
 * before and after it, and a graceful handoff loses nothing that was acknowledged. Each check below is a way the first
 * implementation let an acknowledged write be lost, a flush be reported that did not land, a raw handle escape the
 * guard, a forgotten tenant's image survive, or a throwing observer hold a lease.
 *
 * Offline and deterministic: a directory stands in for the object store, fake clocks move time by hand, and a slow
 * upload is a hook that moves the clocks while the upload is "in flight". Two checks use real timers (the lease must
 * be renewed while a handoff drains). The founder's runtime state root is never opened.
 *
 *   H  handoff: writes after the final image are refused, the lease outlives the drain and the upload, a flush whose
 *      lease lapsed is reported as failed, a failed flush resumes service, an abandon stays abandoned
 *   V  the guarded view hands out nothing raw
 *   F  forget: an upload under way cannot leave the tenant's image behind
 *   O  an observer that throws cannot hold a lease
 *   L  a replica keeps no copy of a tenant it handed off with everything flushed
 *
 * Run: cd ts && npx tsx scripts/tenant-state-handoff-tests.ts
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { DirDurableStore } from '../src/tenant-state/durable-store.ts'
import { FencedError, TenantDrainingError } from '../src/tenant-state/errors.ts'
import { deriveLedgerTenantId, leaseKeyFor, tenantRootFor } from '../src/tenant-state/ids.ts'
import { SqliteLeaseStore } from '../src/tenant-state/lease-store.ts'
import { TenantRouter, type RouterEvent, type TenantHandle } from '../src/tenant-state/tenant-router.ts'
import { ledgerDbPath } from '../src/state-ledger.ts'
import { FaultyDurableStore, ManualClock } from './tenant-state-test-kit.ts'

const ORG = 'acme'
const KEY = Buffer.alloc(32, 9)
const TENANT = deriveLedgerTenantId(KEY, 'https://idp.example/acme', 'handoff-user')
const LEASE_KEY = leaseKeyFor(ORG, TENANT)
const TTL = 10_000
const MARGIN = 2_000

let passed = 0
const only = process.env.GOTRY_TEST_ONLY
async function check(label: string, assertion: () => void | Promise<void>): Promise<void> {
  if (only && !label.startsWith(only)) return
  await assertion()
  passed += 1
  console.log(`  ok - ${label}`)
}

const root = mkdtempSync(join(tmpdir(), 'gotry-tenant-handoff-'))
const cleanups: Array<() => void | Promise<void>> = []

interface Replica {
  readonly router: TenantRouter
  readonly clock: ManualClock
  readonly stateRoot: string
  readonly events: RouterEvent[]
}

function makeFleet(name: string, options: { realTime?: { ttlMs: number; marginMs: number } } = {}) {
  const dir = join(root, name)
  const storeClock = new ManualClock(1_000_000)
  const clocks: ManualClock[] = []
  const leases = options.realTime
    ? new SqliteLeaseStore({ path: join(dir, 'leases.db') })
    : new SqliteLeaseStore({ path: join(dir, 'leases.db'), nowMs: () => storeClock.nowMs() })
  const durable = new FaultyDurableStore(new DirDurableStore(join(dir, 'durable')))
  cleanups.push(() => leases.close())
  return {
    durable,
    leases,
    replica(id: string, onEvent?: (event: RouterEvent) => void): Replica {
      const clock = new ManualClock(5_000)
      clocks.push(clock)
      const events: RouterEvent[] = []
      const stateRoot = join(dir, 'nodes', id)
      const router = new TenantRouter({
        stateRoot,
        replicaId: id,
        leases,
        durable,
        ttlMs: options.realTime?.ttlMs ?? TTL,
        marginMs: options.realTime?.marginMs ?? MARGIN,
        ...(options.realTime ? {} : { clock, autoRenew: false }),
        snapshotEveryMs: 0,
        onEvent: (event) => { events.push(event); onEvent?.(event) },
      })
      cleanups.push(() => router.close().then(() => undefined, () => undefined))
      return { router, clock, stateRoot, events }
    },
    /** Time passes everywhere: the store and every replica's own monotonic clock. */
    advance(ms: number): void {
      storeClock.advance(ms)
      for (const clock of clocks) clock.advance(ms)
    },
  }
}

function insert(handle: TenantHandle, idemKey: string): void {
  handle.run((ledger) => { assert.notEqual(ledger.insertEvent({ actor: 'test', kind: 'tenant-state.test', payload: { idemKey }, idemKey }), null) })
}

/** A write made straight through the ledger a consumer holds, outside any `run` or `runAsync` bracket. */
function insertThroughView(handle: TenantHandle, idemKey: string): void {
  assert.notEqual(handle.ledger.insertEvent({ actor: 'test', kind: 'tenant-state.test', payload: { idemKey }, idemKey }), null)
}

function keysOf(handle: TenantHandle): string[] {
  return handle.run(ledger => (ledger.db.prepare("SELECT idem_key FROM events WHERE kind = 'tenant-state.test' ORDER BY seq").all() as Array<{ idem_key: string }>).map(row => row.idem_key))
}

const isDraining = (error: unknown): boolean => error instanceof TenantDrainingError

try {
  // ---- H: handoff ------------------------------------------------------------------------------------
  console.log('-- H handoff')

  await check('H1 a write made through the ledger after the final image is taken is refused, so nothing acknowledged is lost', async () => {
    const fleet = makeFleet('h1')
    const a = fleet.replica('replica-a')
    const b = fleet.replica('replica-b')
    const handle = await a.router.openTenant(ORG, TENANT)
    const acknowledged = ['before-1', 'before-2']
    for (const key of acknowledged) insert(handle, key)
    let refusal: unknown
    // The hook runs inside the final upload, after the image was taken: the moment a late writer used to slip in.
    fleet.durable.beforeNextList = async () => {
      try {
        insertThroughView(handle, 'late-1')
        acknowledged.push('late-1')
      } catch (error) {
        refusal = error
      }
    }
    await handle.handoff()
    const next = await b.router.openTenant(ORG, TENANT)
    const restored = keysOf(next)
    for (const key of acknowledged) assert.ok(restored.includes(key), `${key} was acknowledged and has to be in the successor's ledger, which holds ${JSON.stringify(restored)}`)
    assert.ok(isDraining(refusal), `the late write is refused with the draining error, got ${String(refusal)}`)
  })

  await check('H2 reading through the ledger is refused during the final flush too, with the same typed error, and works again if the flush fails', async () => {
    const fleet = makeFleet('h2')
    const a = fleet.replica('replica-a')
    const handle = await a.router.openTenant(ORG, TENANT)
    insert(handle, 'k-1')
    let readDuringFlush: unknown
    fleet.durable.beforeNextList = async () => {
      try { handle.ledger.db.prepare('SELECT 1').get() } catch (error) { readDuringFlush = error }
      fleet.durable.down = true
    }
    await assert.rejects(handle.handoff(), /injected outage/)
    assert.ok(isDraining(readDuringFlush), `the view is closed while the image is being flushed, got ${String(readDuringFlush)}`)
    fleet.durable.down = false
    assert.equal(handle.isOpen(), true, 'a flush that failed for want of a store leaves the tenant serving')
    insert(handle, 'k-2')
    assert.deepEqual(keysOf(handle), ['k-1', 'k-2'])
    insertThroughView(handle, 'k-3')
    await handle.handoff()
  })

  await check('H3 a flush whose lease lapsed during the upload is reported as failed, not as flushed', async () => {
    const fleet = makeFleet('h3')
    const a = fleet.replica('replica-a')
    const handle = await a.router.openTenant(ORG, TENANT)
    insert(handle, 'k-1')
    // The upload takes longer than the lease: by the time it lands, the replica no longer provably holds the tenant.
    fleet.durable.beforeNextList = async () => { fleet.advance(TTL + 1) }
    await assert.rejects(handle.handoff(), (error: unknown) => error instanceof FencedError)
    assert.ok(!a.events.some(event => event.type === 'released' && event.flushed), 'nothing claims the tenant was flushed')
    assert.ok(a.events.some(event => event.type === 'snapshot_failed'), 'and the failed snapshot is told apart from a published one')
  })

  await check('H3b the same, with a successor that took over while the upload was under way: it keeps what it pinned, and the old owner is told its flush did not count', async () => {
    const fleet = makeFleet('h3b')
    const a = fleet.replica('replica-a')
    const b = fleet.replica('replica-b')
    const handle = await a.router.openTenant(ORG, TENANT)
    insert(handle, 'k-1')
    await handle.snapshot()
    insert(handle, 'k-2')
    insert(handle, 'k-3')
    let successor: TenantHandle | undefined
    fleet.durable.beforeNextList = async () => {
      fleet.advance(TTL + 1)
      successor = await b.router.openTenant(ORG, TENANT)
    }
    await assert.rejects(handle.handoff(), (error: unknown) => error instanceof FencedError)
    assert.ok(!a.events.some(event => event.type === 'released' && event.flushed), 'nothing claims the tenant was flushed')
    assert.ok(successor, 'the successor took over')
    assert.deepEqual(keysOf(successor), ['k-1'], 'the late image is above the successor\'s pinned base and is never read')
  })

  await check('H4 the lease is renewed while a handoff drains in-flight work, so work longer than the lease is still flushed', async () => {
    const fleet = makeFleet('h4', { realTime: { ttlMs: 600, marginMs: 100 } })
    const a = fleet.replica('replica-a')
    const b = fleet.replica('replica-b')
    const handle = await a.router.openTenant(ORG, TENANT)
    insert(handle, 'k-1')
    let finished = false
    const work = handle.runAsync(async (ledger) => {
      await sleep(1_500)
      assert.notEqual(ledger.insertEvent({ actor: 'test', kind: 'tenant-state.test', payload: {}, idemKey: 'k-2' }), null)
      finished = true
    })
    await sleep(100)
    await handle.handoff()
    await work
    assert.equal(finished, true)
    assert.ok(!a.events.some(event => event.type === 'lost'), 'the lease was never lost while the drain waited')
    const next = await b.router.openTenant(ORG, TENANT)
    assert.deepEqual(keysOf(next), ['k-1', 'k-2'], 'the work that outlived the lease is in the final image')
  })

  await check('H5 a handoff that resumes service after a failed flush does not double the renewal timers', async () => {
    const fleet = makeFleet('h5', { realTime: { ttlMs: 900, marginMs: 100 } })
    const a = fleet.replica('replica-a')
    const handle = await a.router.openTenant(ORG, TENANT)
    insert(handle, 'k-1')
    for (let attempt = 0; attempt < 3; attempt += 1) {
      fleet.durable.down = true
      await assert.rejects(handle.handoff(), /injected outage/)
      fleet.durable.down = false
    }
    a.events.length = 0
    await sleep(1_300)
    const renewals = a.events.filter(event => event.type === 'renewed').length
    assert.ok(renewals >= 2 && renewals <= 6, `one renewal chain runs (renewTick every 300 ms), saw ${renewals} renewals in 1.3 s`)
    await handle.handoff()
  })

  await check('H6 a handoff that is overtaken by an abandon stays abandoned: it flushes nothing and does not bring the handle back', async () => {
    const fleet = makeFleet('h6')
    const a = fleet.replica('replica-a')
    const handle = await a.router.openTenant(ORG, TENANT)
    insert(handle, 'k-1')
    let release!: () => void
    const hold = new Promise<void>((resolve) => { release = resolve })
    const work = handle.runAsync(async () => { await hold })
    const handingOff = handle.handoff()
    await sleep(20)
    await handle.abandon()
    release()
    await work.catch(() => undefined)
    await assert.rejects(handingOff, isDraining)
    assert.equal(handle.isOpen(), false, 'the abandoned handle is not serving again')
    assert.equal(a.router.handleOf(ORG, TENANT), null)
    const stored = await fleet.durable.list(`${LEASE_KEY}/`)
    assert.deepEqual(stored.filter(key => /snap-/.test(key)), [], `nothing was flushed after the abandon, the store holds ${JSON.stringify(stored)}`)
  })

  // ---- V: the guarded view ------------------------------------------------------------------------------
  console.log('-- V the guarded view')

  await check('V1 no method of the guarded database returns the raw one, so a lease that is gone cannot be bypassed by chaining', async () => {
    const fleet = makeFleet('v1')
    const a = fleet.replica('replica-a')
    const handle = await a.router.openTenant(ORG, TENANT)
    const chained = handle.ledger.db.exec('CREATE TABLE IF NOT EXISTS probe (a INTEGER)')
    const again = handle.ledger.db.defaultSafeIntegers(false)
    // The replica's own clock passes the end of the lease: from here every call through the view has to fail.
    a.clock.advance(TTL)
    assert.throws(() => handle.ledger.db.prepare('SELECT 1'), (error: unknown) => error instanceof FencedError)
    for (const returned of [chained, again]) {
      assert.throws(() => returned.prepare('INSERT INTO probe(a) VALUES (1)').run(), (error: unknown) => error instanceof FencedError, 'what exec and its siblings return is still behind the gate')
    }
  })

  // ---- F: forget ----------------------------------------------------------------------------------------
  console.log('-- F forget')

  await check('F1 a snapshot upload under way cannot outlive forget: the tenant leaves nothing in the store', async () => {
    const fleet = makeFleet('f1')
    const a = fleet.replica('replica-a')
    const handle = await a.router.openTenant(ORG, TENANT)
    insert(handle, 'k-1')
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    fleet.durable.beforeNextList = async () => { await gate }
    const uploading = handle.snapshot().catch(() => undefined)
    await sleep(50)
    const forgetting = handle.forget()
    await sleep(50)
    release()
    await Promise.all([uploading, forgetting])
    assert.deepEqual(await fleet.durable.list(`${LEASE_KEY}/`), [], 'no image, manifest or base of the forgotten tenant is left')
    assert.equal(existsSync(tenantRootFor(a.stateRoot, ORG, TENANT)), false, 'and no local file')
  })

  await check('F2 a snapshot requested after forget has begun is refused and uploads nothing', async () => {
    const fleet = makeFleet('f2')
    const a = fleet.replica('replica-a')
    const handle = await a.router.openTenant(ORG, TENANT)
    insert(handle, 'k-1')
    const forgetting = handle.forget()
    await assert.rejects(handle.snapshot(), isDraining)
    await forgetting
    assert.deepEqual(await fleet.durable.list(`${LEASE_KEY}/`), [])
  })

  // ---- O: observers ------------------------------------------------------------------------------------
  console.log('-- O observers')

  await check('O1 an observer that throws cannot hold a lease: the tenant opens, and the lease is the replica\'s to renew and release', async () => {
    const fleet = makeFleet('o1')
    const a = fleet.replica('replica-a', () => { throw new Error('observer bug') })
    const handle = await a.router.openTenant(ORG, TENANT)
    assert.equal(handle.isOpen(), true)
    insert(handle, 'k-1')
    await handle.handoff()
    const b = fleet.replica('replica-b')
    const next = await b.router.openTenant(ORG, TENANT)
    assert.deepEqual(keysOf(next), ['k-1'])
  })

  // ---- L: local files ------------------------------------------------------------------------------------
  console.log('-- L local files')

  await check('L1 after a handoff that flushed everything the replica keeps no copy of the ledger; after one that did not, it keeps the only copy', async () => {
    const fleet = makeFleet('l1')
    const a = fleet.replica('replica-a')
    const handle = await a.router.openTenant(ORG, TENANT)
    insert(handle, 'k-1')
    const file = ledgerDbPath(tenantRootFor(a.stateRoot, ORG, TENANT))
    assert.equal(existsSync(file), true)
    await handle.handoff()
    for (const suffix of ['', '-wal', '-shm']) assert.equal(existsSync(`${file}${suffix}`), false, `${suffix || 'the ledger'} is gone after a flushed handoff`)

    const kept = await a.router.openTenant(ORG, TENANT)
    insert(kept, 'k-2')
    await kept.abandon()
    assert.equal(existsSync(file), true, 'an abandoned tenant\'s file may hold writes that exist nowhere else, so it stays for an operator')
  })

  console.log(`tenant-state-handoff: ${passed} checks passed`)
} finally {
  for (const cleanup of cleanups.reverse()) {
    try { await cleanup() } catch { /* best effort */ }
  }
  rmSync(root, { recursive: true, force: true })
}
