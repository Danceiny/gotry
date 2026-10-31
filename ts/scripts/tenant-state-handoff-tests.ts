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
 *   D  the drain is bounded, a stuck tenant holds nobody else, and a tenant that is closed meanwhile settles its handoff
 *   R  one renewal chain, however a failed handoff and a slow lease store interleave
 *   T  run() takes a synchronous callback
 *   V  the guarded view hands out nothing raw
 *   F  forget: an upload under way cannot leave the tenant's image behind, and forget wins against a handoff
 *   S  copies of a dead epoch are deleted when the tenant is next opened
 *   P  a destructive call takes only the tenant's own paths
 *   O  an observer that throws cannot hold a lease
 *   L  a replica keeps no copy of a tenant it handed off with everything flushed
 *
 * Run: cd ts && npx tsx scripts/tenant-state-handoff-tests.ts
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import type Database from 'better-sqlite3'
import { DirDurableStore } from '../src/tenant-state/durable-store.ts'
import { forgetTenant } from '../src/tenant-state/epoch-copies.ts'
import { FencedError, TenantDrainingError } from '../src/tenant-state/errors.ts'
import { deriveLedgerTenantId, leaseKeyFor, tenantRootFor } from '../src/tenant-state/ids.ts'
import { SqliteLeaseStore, type LeaseStore } from '../src/tenant-state/lease-store.ts'
import { TenantLease } from '../src/tenant-state/tenant-lease.ts'
import { TenantRouter, type RouterEvent, type TenantHandle, type TenantRouterOptions } from '../src/tenant-state/tenant-router.ts'
import { ledgerDbPath } from '../src/state-ledger.ts'
import { FaultyDurableStore, ManualClock } from './tenant-state-test-kit.ts'

const ORG = 'acme'
const KEY = Buffer.alloc(32, 9)
const TENANT = deriveLedgerTenantId(KEY, 'https://idp.example/acme', 'handoff-user')
const LEASE_KEY = leaseKeyFor(ORG, TENANT)
const TENANT_2 = deriveLedgerTenantId(KEY, 'https://idp.example/acme', 'handoff-user-2')
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

/** A call that has to come back: when it does not, the check fails with this message instead of the suite stalling. */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms) })])
  } finally {
    clearTimeout(timer)
  }
}

type Settled = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: unknown }
const settle = (promise: Promise<unknown>): Promise<Settled> => promise.then((value): Settled => ({ ok: true, value }), (error: unknown): Settled => ({ ok: false, error }))

async function waitFor(condition: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const until = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await sleep(10)
  }
}

const codeOf = (error: unknown): string | undefined => (error as { code?: string } | null)?.code

interface Replica {
  readonly router: TenantRouter
  readonly clock: ManualClock
  readonly stateRoot: string
  readonly events: RouterEvent[]
}

function makeFleet(name: string, options: {
  realTime?: { ttlMs: number; marginMs: number }
  /** Options of every router of the fleet, beyond the ones the fleet sets itself. */
  router?: Partial<TenantRouterOptions>
  /** Puts something between the routers and the lease store. */
  wrapLeases?: (inner: LeaseStore) => LeaseStore
} = {}) {
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
        leases: options.wrapLeases ? options.wrapLeases(leases) : leases,
        durable,
        ttlMs: options.realTime?.ttlMs ?? TTL,
        marginMs: options.realTime?.marginMs ?? MARGIN,
        ...(options.realTime ? {} : { clock, autoRenew: false }),
        snapshotEveryMs: 0,
        ...options.router,
        onEvent: (event) => { events.push(event); onEvent?.(event) },
      })
      // A tenant with a call that never returns keeps close() waiting for its drain deadline: the cleanup must not wait for ever.
      cleanups.push(() => within(router.close(), 5_000, 'router.close() in the cleanup').then(() => undefined, () => undefined))
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

  await check('V2 closing the database through the view does not close the router\'s own connection', async () => {
    const fleet = makeFleet('v2')
    const a = fleet.replica('replica-a')
    const handle = await a.router.openTenant(ORG, TENANT)
    handle.ledger.db.close()
    handle.ledger.close()
    insert(handle, 'k-1')
    assert.deepEqual(keysOf(handle), ['k-1'], 'the router\'s connection is still open and the write is there')
  })

  await check('V3 the raw database is not reachable through a property descriptor, and the view cannot be rewritten', async () => {
    const fleet = makeFleet('v3')
    const a = fleet.replica('replica-a')
    const handle = await a.router.openTenant(ORG, TENANT)
    const viaOne = Object.getOwnPropertyDescriptor(handle.ledger, 'db')?.value as Database.Database
    const viaAll = (Object.getOwnPropertyDescriptors(handle.ledger) as Record<string, PropertyDescriptor>).db?.value as Database.Database
    a.clock.advance(TTL)
    for (const [name, db] of [['getOwnPropertyDescriptor', viaOne], ['getOwnPropertyDescriptors', viaAll]] as const) {
      assert.throws(() => db.prepare('SELECT 1'), (error: unknown) => error instanceof FencedError, `${name} hands out the guarded database, which refuses once the lease is gone`)
    }
    assert.throws(() => { (handle.ledger as unknown as { db: unknown }).db = null }, TypeError, 'the view is read-only')
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

  await check('F3 forget while the final flush is under way wins: the handoff does not release the lease, and nothing of the tenant stays in the store', async () => {
    const fleet = makeFleet('f3')
    const a = fleet.replica('replica-a')
    const b = fleet.replica('replica-b')
    const handle = await a.router.openTenant(ORG, TENANT)
    insert(handle, 'k-1')
    insert(handle, 'k-2')
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    fleet.durable.beforeNextList = async () => { await gate }
    const handingOff = settle(handle.handoff())
    const forgetting = settle((async () => { await sleep(50); return handle.forget() })())
    await sleep(100)
    release()
    const [handoff, forgotten] = await Promise.all([within(handingOff, 3_000, 'the handoff'), within(forgetting, 3_000, 'forget')])
    assert.equal(forgotten.ok, true, `forget resolved, got ${forgotten.ok ? '' : String(forgotten.error)}`)
    assert.equal(handoff.ok, false)
    if (!handoff.ok) assert.ok(isDraining(handoff.error), `and the handoff is rejected with the draining error, got ${String(handoff.error)}`)
    assert.deepEqual(await fleet.durable.list(`${LEASE_KEY}/`), [], 'no image, manifest or base of the forgotten tenant is left')
    assert.ok(!a.events.some(event => event.type === 'released' && event.flushed), 'nothing claims the tenant was flushed')
    const next = await b.router.openTenant(ORG, TENANT)
    assert.deepEqual(keysOf(next), [], 'the successor starts from an empty ledger')
  })

  await check('F4 forget keeps the lease renewed while it waits for a slow upload, so it is not fenced before it can delete', async () => {
    const fleet = makeFleet('f4', { realTime: { ttlMs: 600, marginMs: 100 }, router: { renewEveryMs: 150 } })
    const a = fleet.replica('replica-a')
    const handle = await a.router.openTenant(ORG, TENANT)
    insert(handle, 'k-1')
    await handle.snapshot()
    insert(handle, 'k-2')
    fleet.durable.slowPut = { match: /\.db$/, ms: 1_200 }
    const uploading = settle(handle.snapshot())
    await sleep(50)
    const forgotten = await settle(within(handle.forget(), 5_000, 'forget over a slow upload'))
    await uploading
    assert.equal(forgotten.ok, true, `forget resolved, got ${forgotten.ok ? '' : String(forgotten.error)}`)
    assert.deepEqual(await fleet.durable.list(`${LEASE_KEY}/`), [], 'and the image that was uploading is gone with the rest')
  })

  await check('F5 while forget waits for an upload, calls through the handle and the ledger are refused with the typed draining error', async () => {
    const fleet = makeFleet('f5')
    const a = fleet.replica('replica-a')
    const handle = await a.router.openTenant(ORG, TENANT)
    insert(handle, 'k-1')
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    fleet.durable.beforeNextList = async () => { await gate }
    const uploading = settle(handle.snapshot())
    await sleep(30)
    const forgetting = settle(handle.forget())
    try {
      await sleep(30)
      assert.throws(() => insert(handle, 'late-1'), isDraining)
      assert.throws(() => insertThroughView(handle, 'late-2'), isDraining)
      assert.throws(() => handle.ledger.db.prepare('SELECT 1'), isDraining)
    } finally {
      release()
    }
    await Promise.all([uploading, forgetting])
  })

  await check('F6 while forget waits for an upload, an abandon does not take the lease from under it, and a second forget is refused', async () => {
    const fleet = makeFleet('f6')
    const a = fleet.replica('replica-a')
    const handle = await a.router.openTenant(ORG, TENANT)
    insert(handle, 'k-1')
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    fleet.durable.beforeNextList = async () => { await gate }
    const uploading = settle(handle.snapshot())
    await sleep(30)
    const forgetting = settle(handle.forget())
    try {
      await sleep(30)
      await handle.abandon()
      await assert.rejects(handle.forget(), isDraining)
    } finally {
      release()
    }
    const [, forgotten] = await Promise.all([uploading, within(forgetting, 3_000, 'forget')])
    assert.equal(forgotten.ok, true, `forget finished what it began, got ${forgotten.ok ? '' : String(forgotten.error)}`)
    assert.deepEqual(await fleet.durable.list(`${LEASE_KEY}/`), [], 'and the store holds nothing of the tenant')
  })

  // ---- S: dead epochs --------------------------------------------------------------------------------------
  console.log('-- S dead epochs')

  await check('S1 what a superseded owner uploaded after a forget is deleted when the tenant is next opened, and nothing else is', async () => {
    const fleet = makeFleet('s1')
    const a = fleet.replica('replica-a')
    const b = fleet.replica('replica-b')
    const handle = await a.router.openTenant(ORG, TENANT)
    insert(handle, 'k-1')
    await handle.snapshot()
    await handle.forget()
    const other = leaseKeyFor(ORG, TENANT_2)
    // The late upload of an owner that did not know it was superseded lands in the dead epoch, beside a neighbour's own object.
    await fleet.durable.putIfAbsent(`${LEASE_KEY}/e00000001/snap-000009.db`, Buffer.from('late'))
    await fleet.durable.putIfAbsent(`${LEASE_KEY}/e00000001/snap-000009.json`, Buffer.from('{}'))
    await fleet.durable.putIfAbsent(`${other}/e00000001/base.json`, Buffer.from('{}'))
    assert.equal((await fleet.durable.list(`${LEASE_KEY}/`)).length, 2)
    const next = await b.router.openTenant(ORG, TENANT)
    assert.deepEqual(keysOf(next), [])
    assert.deepEqual((await fleet.durable.list(`${LEASE_KEY}/`)).filter(key => /\/e0*1\//.test(key)), [], 'the dead epoch left nothing behind')
    assert.equal((await fleet.durable.list(`${other}/`)).length, 1, 'and another tenant\'s objects were not touched')
  })

  // ---- P: paths ---------------------------------------------------------------------------------------------
  console.log('-- P paths')

  await check('P1 forgetting never deletes a directory that is not the tenant\'s own, whatever root the caller supplies', async () => {
    const dir = join(root, 'p1')
    const storeClock = new ManualClock(1_000_000)
    const leases = new SqliteLeaseStore({ path: join(dir, 'leases.db'), nowMs: () => storeClock.nowMs() })
    cleanups.push(() => leases.close())
    const durable = new DirDurableStore(join(dir, 'durable'))
    const lease = await TenantLease.acquire({ store: leases, key: LEASE_KEY, replicaId: 'replica-p1', ttlMs: TTL, marginMs: MARGIN, clock: new ManualClock(5_000) })
    const keep = (path: string): void => { mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'precious.txt'), 'keep') }
    const unrelated = join(dir, 'somebody-elses-files')
    const sibling = tenantRootFor(join(dir, 'node'), ORG, TENANT_2)
    keep(unrelated)
    keep(sibling)
    for (const tenantRoot of [unrelated, sibling, join(sibling, '..')]) {
      await assert.rejects(forgetTenant({ durable, lease, organization: ORG, ledgerTenant: TENANT, tenantRoot }), RangeError, `a root of ${tenantRoot} is refused`)
    }
    for (const path of [unrelated, sibling]) assert.equal(readFileSync(join(path, 'precious.txt'), 'utf8'), 'keep', `${path} is untouched`)
    const own = tenantRootFor(join(dir, 'node'), ORG, TENANT)
    keep(own)
    await forgetTenant({ durable, lease, organization: ORG, ledgerTenant: TENANT, tenantRoot: own })
    assert.equal(existsSync(own), false, 'the tenant\'s own root is the one that goes')
  })

  await check('P2 deleting by prefix takes whole segments only, so a name that is the start of another one cannot take its neighbour', async () => {
    const store = new DirDurableStore(join(root, 'p2'))
    await store.putIfAbsent('acme/t1/e00000001/base.json', Buffer.from('1'))
    await store.putIfAbsent('acme2/t9/e00000001/base.json', Buffer.from('2'))
    await assert.rejects(store.deletePrefix('acme'), RangeError)
    assert.equal((await store.list('acme2/')).length, 1, 'the neighbour is untouched')
    assert.equal(await store.deletePrefix('acme/'), 1)
    assert.equal((await store.list('acme2/')).length, 1)
  })

  // ---- D: the drain ------------------------------------------------------------------------------------
  console.log('-- D drain')

  await check('D1 a drain that never finishes is bounded: the handoff is rejected with the typed timeout, the operator is told, and the tenant serves again', async () => {
    const fleet = makeFleet('d1', { realTime: { ttlMs: 2_000, marginMs: 200 }, router: { drainTimeoutMs: 300, renewEveryMs: 200 } })
    const a = fleet.replica('replica-a')
    const handle = await a.router.openTenant(ORG, TENANT)
    insert(handle, 'k-1')
    handle.runAsync(() => new Promise<void>(() => undefined)).catch(() => undefined)
    const outcome = await settle(within(handle.handoff(), 3_000, 'a handoff over a call that never returns'))
    assert.equal(outcome.ok, false)
    if (!outcome.ok) assert.equal(codeOf(outcome.error), 'GOTRY_TENANT_DRAIN_TIMEOUT', `rejected with the drain timeout, got ${String(outcome.error)}`)
    assert.equal(handle.isOpen(), true, 'the tenant serves again')
    insert(handle, 'k-2')
    await handle.snapshot()
    assert.deepEqual(keysOf(handle), ['k-1', 'k-2'])
    assert.ok(a.events.some(event => event.type === 'drain_timeout'), 'the operator is told')
    assert.ok(!a.events.some(event => event.type === 'released'), 'and nothing was released')
  })

  await check('D2 close() hands tenants off side by side, so one stuck tenant does not hold the others behind it', async () => {
    const fleet = makeFleet('d2', { realTime: { ttlMs: 3_000, marginMs: 300 }, router: { drainTimeoutMs: 800, renewEveryMs: 300 } })
    const a = fleet.replica('replica-a')
    const first = await a.router.openTenant(ORG, TENANT)
    const second = await a.router.openTenant(ORG, TENANT_2)
    insert(first, 'k-1')
    insert(second, 'k-1')
    first.runAsync(() => new Promise<void>(() => undefined)).catch(() => undefined)
    const closing = a.router.close()
    const secondKey = leaseKeyFor(ORG, TENANT_2)
    const handedOff = (): boolean => a.events.some(event => event.type === 'released' && event.key === secondKey && event.flushed)
    await waitFor(handedOff, 500, 'the second tenant to be handed off while the first is still draining')
    assert.deepEqual(await within(closing, 4_000, 'router.close() with one tenant stuck'), [LEASE_KEY], 'the stuck tenant is reported, and only it')
  })

  for (const how of ['abandon', 'forget', 'lost'] as const) {
    await check(`D3 ${how}: a handoff that waits for a call that never returns is settled by it, not left pending`, async () => {
      const fleet = makeFleet(`d3-${how}`, { router: { drainTimeoutMs: 60_000 } })
      const a = fleet.replica('replica-a')
      const b = fleet.replica('replica-b')
      const handle = await a.router.openTenant(ORG, TENANT)
      insert(handle, 'k-1')
      handle.runAsync(() => new Promise<void>(() => undefined)).catch(() => undefined)
      const handingOff = settle(handle.handoff())
      await sleep(30)
      if (how === 'abandon') await handle.abandon()
      else if (how === 'forget') await handle.forget()
      else {
        // The lease lapses, a successor takes over, and the next renewal is refused: the tenure is over.
        fleet.advance(TTL + 1)
        await b.router.openTenant(ORG, TENANT)
        await handle.renew().catch(() => undefined)
      }
      const outcome = await within(handingOff, 1_000, `a handoff of a tenant that was ${how} meanwhile`)
      assert.equal(outcome.ok, false)
      if (!outcome.ok) assert.ok(isDraining(outcome.error), `the handoff is rejected with the draining error, got ${String(outcome.error)}`)
      assert.equal(handle.isOpen(), false)
      assert.ok(!a.events.some(event => event.type === 'released' && event.flushed), 'and nothing claims a flush')
    })
  }

  // ---- R: the renewal chain ------------------------------------------------------------------------------
  console.log('-- R renewal')

  await check('R1 a failed handoff does not start a second renewal chain while a renewal is still under way', async () => {
    const gate = { hold: false, started: 0, waiting: [] as Array<() => void> }
    const fleet = makeFleet('r1', {
      realTime: { ttlMs: 5_000, marginMs: 500 },
      router: { renewEveryMs: 300 },
      wrapLeases: (inner) => ({
        read: (key) => inner.read(key),
        acquire: (key, owner, ttlMs) => inner.acquire(key, owner, ttlMs),
        release: (key, owner, epoch) => inner.release(key, owner, epoch),
        markForgotten: (key, owner, epoch) => inner.markForgotten(key, owner, epoch),
        renew: async (key, owner, epoch, ttlMs) => {
          gate.started += 1
          if (gate.hold) await new Promise<void>((resolve) => { gate.waiting.push(resolve) })
          return inner.renew(key, owner, epoch, ttlMs)
        },
      }),
    })
    const a = fleet.replica('replica-a')
    gate.hold = true
    const handle = await a.router.openTenant(ORG, TENANT)
    insert(handle, 'k-1')
    await waitFor(() => gate.started === 1, 2_000, 'the first renewal to start')
    fleet.durable.down = true
    await assert.rejects(handle.handoff(), /injected outage/)
    fleet.durable.down = false
    // A second chain would fire its timer in this time and queue a renewal behind the one that is still under way.
    await sleep(450)
    gate.hold = false
    for (const resume of gate.waiting.splice(0)) resume()
    await sleep(120)
    assert.equal(gate.started, 1, 'the next renewal waits for its own timer: no second chain queued one')
    await handle.handoff()
  })

  // ---- T: run() takes a synchronous callback ---------------------------------------------------------------------
  console.log('-- T run')

  await check('T1 run() refuses a callback that returns a promise, and the promise it leaves behind cannot become an unhandled rejection', async () => {
    const fleet = makeFleet('t1')
    const a = fleet.replica('replica-a')
    const handle = await a.router.openTenant(ORG, TENANT)
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      assert.throws(
        () => handle.run((async () => { await sleep(10); throw new Error('floating') }) as unknown as (ledger: unknown) => never),
        (error: unknown) => error instanceof TypeError && /runAsync/.test(error.message),
      )
      await sleep(80)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    assert.deepEqual(unhandled, [], 'the rejection of a floating async callback is not left unhandled')
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

  await check('L2 the local ledger of an abandoned tenure is replaced, not recovered, by the next open on the same replica: the durable copy is the authority', async () => {
    const fleet = makeFleet('l2')
    const a = fleet.replica('replica-a')
    const handle = await a.router.openTenant(ORG, TENANT)
    insert(handle, 'k-1')
    await handle.snapshot()
    insert(handle, 'k-2')
    await handle.abandon()
    const file = ledgerDbPath(tenantRootFor(a.stateRoot, ORG, TENANT))
    assert.equal(existsSync(file), true, 'the abandoned file is there until the next open')
    const again = await a.router.openTenant(ORG, TENANT)
    assert.deepEqual(keysOf(again), ['k-1'], 'k-2 was written after the last snapshot: it is the declared tail of D-a and is not brought back from the old file')
  })

  console.log(`tenant-state-handoff: ${passed} checks passed`)
} finally {
  for (const cleanup of cleanups.reverse()) {
    try { await cleanup() } catch { /* best effort */ }
  }
  rmSync(root, { recursive: true, force: true })
}
