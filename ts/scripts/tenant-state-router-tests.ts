/**
 * Tenant router and tenant-bound handle (AaaS A1.3, docs/rfc/aaas-rfc.md §4.2 items 5 and 6, §4.4; threats S-1, S-2, S-6).
 *
 * Offline and deterministic: a directory stands in for the object store, SQLite lease files for the lease
 * store, fake clocks for expiry, so every replica is a router over its own state root in one process. Two
 * checks use real timers (background renewal, periodic snapshots). No network, no model, and the
 * founder's runtime state root is never opened.
 *
 *   T  opening: one handle per tenant, a tenant another replica owns is refused with its owner named,
 *      bad ids are refused before any store or file is touched, tenants are isolated from each other.
 *   G  the guard: once the lease is not provably held, every call on the handle's ledger fails, down to
 *      a statement prepared earlier; a write is acknowledged only if the lease holds before and after.
 *   H  handoff: graceful (zero loss, the next owner starts at once), crash (the declared RPO), a failed
 *      flush that keeps serving, a drain that lets in-flight work finish, abandon, forget, router close.
 *   L  lifecycle: loss, background renewal, periodic snapshots, events without personal data.
 *
 * Run: cd ts && npx tsx scripts/tenant-state-router-tests.ts
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { DirDurableStore } from '../src/tenant-state/durable-store.ts'
import {
  DurableStoreUnavailableError,
  FencedError,
  InvalidTenantIdError,
  LeaseHeldError,
  LeaseLostError,
  RestoreVerificationError,
  RouterClosedError,
  TenantDrainingError,
} from '../src/tenant-state/errors.ts'
import { deriveLedgerTenantId, leaseKeyFor, tenantRootFor } from '../src/tenant-state/ids.ts'
import { SqliteLeaseStore } from '../src/tenant-state/lease-store.ts'
import { TenantRouter, type RouterEvent, type TenantHandle } from '../src/tenant-state/tenant-router.ts'
import { ledgerDbPath } from '../src/state-ledger.ts'
import { FaultyDurableStore, ManualClock } from './tenant-state-test-kit.ts'

const ORG = 'acme'
const ORG_KEY = Buffer.alloc(32, 5)
const ISSUER = 'https://idp.example/acme'
const TENANT_A = deriveLedgerTenantId(ORG_KEY, ISSUER, 'user-1')
const TENANT_B = deriveLedgerTenantId(ORG_KEY, ISSUER, 'user-2')
const KEY_A = leaseKeyFor(ORG, TENANT_A)
const TTL = 10_000
const MARGIN = 2_000

let passed = 0
async function check(label: string, assertion: () => void | Promise<void>): Promise<void> {
  await assertion()
  passed += 1
  console.log(`  ok - ${label}`)
}

const root = mkdtempSync(join(tmpdir(), 'gotry-tenant-router-'))
const cleanups: Array<() => void | Promise<void>> = []

interface Fleet {
  readonly dir: string
  readonly leases: SqliteLeaseStore
  readonly storeClock: ManualClock
  readonly store: DirDurableStore
  readonly durable: FaultyDurableStore
  /** A replica: a router with its own state root, clock and event log. Time moves by hand unless `autoRenew` is asked for. */
  replica(id: string, options?: { snapshotEveryMs?: number }): Replica
  advance(ms: number, frozen?: readonly ManualClock[]): void
}

interface Replica {
  readonly id: string
  readonly router: TenantRouter
  readonly clock: ManualClock
  readonly stateRoot: string
  readonly events: RouterEvent[]
}

function makeFleet(name: string): Fleet {
  const dir = join(root, name)
  const storeClock = new ManualClock(1_000_000)
  const leases = new SqliteLeaseStore({ path: join(dir, 'leases.db'), nowMs: () => storeClock.nowMs() })
  const store = new DirDurableStore(join(dir, 'durable'))
  const durable = new FaultyDurableStore(store)
  const clocks: ManualClock[] = []
  cleanups.push(() => leases.close())
  return {
    dir,
    leases,
    storeClock,
    store,
    durable,
    replica(id, options = {}): Replica {
      const clock = new ManualClock(5_000)
      clocks.push(clock)
      const events: RouterEvent[] = []
      const stateRoot = join(dir, 'nodes', id)
      const router = new TenantRouter({
        stateRoot,
        replicaId: id,
        leases,
        durable,
        ttlMs: TTL,
        marginMs: MARGIN,
        clock,
        autoRenew: false,
        snapshotEveryMs: options.snapshotEveryMs ?? 0,
        onEvent: (event) => { events.push(event) },
      })
      cleanups.push(() => router.close().then(() => undefined))
      return { id, router, clock, stateRoot, events }
    },
    advance(ms, frozen = []): void {
      storeClock.advance(ms)
      for (const clock of clocks) if (!frozen.includes(clock)) clock.advance(ms)
    },
  }
}

function write(handle: TenantHandle, prefix: string, count: number): string[] {
  const keys: string[] = []
  handle.run((ledger) => {
    for (let index = 1; index <= count; index += 1) {
      const idemKey = `${prefix}-${index}`
      assert.notEqual(ledger.insertEvent({ actor: 'test', kind: 'tenant-state.test', payload: { index }, idemKey }), null)
      keys.push(idemKey)
    }
  })
  return keys
}

function keysOf(handle: TenantHandle): string[] {
  return handle.run(ledger => (ledger.db.prepare("SELECT idem_key FROM events WHERE kind = 'tenant-state.test' ORDER BY seq").all() as Array<{ idem_key: string }>).map(row => row.idem_key))
}

function fencedWith(reason: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof FencedError && error.reason === reason
}

const prefixOf = (key: string): string => `${key}/`

try {
  // ---- T: opening ---------------------------------------------------------------------
  console.log('-- T opening')
  await check('T1 a first open acquires epoch 1 and restores empty; further and concurrent opens share one handle', async () => {
    const fleet = makeFleet('t1')
    const a = fleet.replica('replica-a')
    const [first, second, third] = await Promise.all([a.router.openTenant(ORG, TENANT_A), a.router.openTenant(ORG, TENANT_A), a.router.openTenant(ORG, TENANT_A)])
    assert.equal(first, second)
    assert.equal(second, third)
    assert.equal(first.epoch, 1)
    assert.equal(first.restoredFrom, null)
    assert.deepEqual([first.organization, first.ledgerTenant], [ORG, TENANT_A])
    assert.equal(first.ledger.tenant, TENANT_A)
    assert.equal(await a.router.openTenant(ORG, TENANT_A), first)
    assert.equal(a.router.handleOf(ORG, TENANT_A), first)
    assert.equal(a.router.openCount(), 1)
    assert.deepEqual(a.events.map(event => event.type), ['acquired', 'restored'], 'one acquisition served all three callers')
    assert.deepEqual(write(first, 'k', 3), ['k-1', 'k-2', 'k-3'])
    assert.deepEqual(keysOf(first), ['k-1', 'k-2', 'k-3'])
    first.ledger.close()
    assert.deepEqual(keysOf(first), ['k-1', 'k-2', 'k-3'], 'a consumer cannot close the ledger the router owns')
  })

  await check('T2 a tenant another replica owns is refused with the owner named, and the refusing replica touches no file', async () => {
    const fleet = makeFleet('t2')
    const a = fleet.replica('replica-a')
    const b = fleet.replica('replica-b')
    await a.router.openTenant(ORG, TENANT_A)
    await assert.rejects(() => b.router.openTenant(ORG, TENANT_A), (error: unknown) => error instanceof LeaseHeldError && error.record.owner === 'replica-a' && error.record.epoch === 1)
    assert.equal(b.router.openCount(), 0)
    assert.equal(existsSync(b.stateRoot), false, 'no directory was created for a tenant this replica does not own')
    assert.deepEqual(b.events, [])
  })

  await check('T3 ids outside the fixed format are refused before any store or file is touched', async () => {
    const fleet = makeFleet('t3')
    const a = fleet.replica('replica-a')
    for (const [organization, tenant] of [['..', TENANT_A], [ORG, '../../etc'], ['Acme', TENANT_A], [ORG, `${TENANT_A}/../${TENANT_B}`], ['', TENANT_A], [ORG, 'local']] as const) {
      await assert.rejects(() => a.router.openTenant(organization, tenant), InvalidTenantIdError)
    }
    assert.equal(existsSync(a.stateRoot), false)
    assert.deepEqual(fleet.leases.history(), [], 'the lease store never saw a refused id')
    assert.deepEqual(await fleet.store.list('a'), [])
    assert.throws(() => a.router.handleOf('..', TENANT_A), InvalidTenantIdError)
  })

  await check('T4 two tenants on one replica are isolated: own root, own epoch, own rows, own tenant column', async () => {
    const fleet = makeFleet('t4')
    const a = fleet.replica('replica-a')
    const one = await a.router.openTenant(ORG, TENANT_A)
    const two = await a.router.openTenant(ORG, TENANT_B)
    assert.notEqual(one, two)
    assert.deepEqual([one.epoch, two.epoch], [1, 1])
    write(one, 'one', 4)
    write(two, 'two', 2)
    assert.deepEqual(keysOf(one), ['one-1', 'one-2', 'one-3', 'one-4'])
    assert.deepEqual(keysOf(two), ['two-1', 'two-2'])
    assert.equal(one.ledger.tenant, TENANT_A)
    assert.equal(two.ledger.tenant, TENANT_B)
    assert.notEqual(tenantRootFor(a.stateRoot, ORG, TENANT_A), tenantRootFor(a.stateRoot, ORG, TENANT_B))
    assert.equal(a.router.openCount(), 2)
  })

  // ---- G: the guard ----------------------------------------------------------------------
  console.log('-- G the guard')
  await check('G1 once the lease is not provably held every call on the ledger fails, down to a statement or transaction made earlier, and nothing is written', async () => {
    const fleet = makeFleet('g1')
    const a = fleet.replica('replica-a')
    const handle = await a.router.openTenant(ORG, TENANT_A)
    write(handle, 'k', 2)
    const prepared = handle.ledger.db.prepare('SELECT COUNT(*) AS n FROM events')
    const insert = handle.ledger.db.prepare("INSERT INTO events (tenant_id, ts, actor, kind, subject_id, payload) VALUES (?, 'now', 'test', 'tenant-state.test', '', '{}')")
    const transaction = handle.ledger.db.transaction(() => 'ran')
    const before = (prepared.get() as { n: number }).n
    assert.equal(transaction(), 'ran', 'a transaction built while the lease held runs while it holds')
    assert.equal((transaction as unknown as { database?: unknown }).database, undefined, 'a guarded transaction does not hand out the raw database')
    const rows = handle.ledger.db.prepare('SELECT idem_key FROM events').iterate()
    const piped = handle.ledger.db.prepare('SELECT COUNT(*) AS n FROM events').pluck()
    assert.equal(piped.get(), before, 'chaining works while the lease holds')

    fleet.advance(TTL - MARGIN)
    const fenced = fencedWith('lease_expired_locally')
    assert.throws(() => handle.run(() => 1), fenced)
    assert.throws(() => handle.ledger.insertEvent({ actor: 'test', kind: 'tenant-state.test', payload: {}, idemKey: 'late' }), fenced)
    assert.throws(() => handle.ledger.readEvents(), fenced)
    assert.throws(() => handle.ledger.db.prepare('SELECT 1').get(), fenced)
    assert.throws(() => handle.ledger.db.exec('SELECT 1'), fenced)
    assert.throws(() => handle.ledger.db.transaction(() => 1)(), fenced)
    assert.throws(() => handle.ledger.db.transaction(() => 1).immediate(), fenced)
    assert.throws(() => prepared.get(), fenced, 'a statement prepared while the lease held is guarded at use')
    assert.throws(() => insert.run(TENANT_A), fenced)
    assert.throws(() => transaction(), fenced, 'a transaction built earlier is guarded at use')
    assert.throws(() => transaction.immediate(), fenced)
    assert.throws(() => rows.next(), fenced, 'an iterator started earlier proves the lease on every step')
    assert.throws(() => piped.get(), fenced, 'a chained statement stays guarded')
    assert.throws(() => prepared.database.prepare('SELECT 1'), fenced, 'the database reached through a statement is guarded too')
    rows.return?.()
    assert.equal(handle.ledger.tenant, TENANT_A, 'plain properties stay readable')

    await handle.renew()
    assert.equal((prepared.get() as { n: number }).n, before, 'nothing was written while the handle was fenced')
    assert.equal(handle.run(() => 'serving again'), 'serving again', 'a renewal at an unchanged epoch resumes the tenant')
  })

  await check('G2 run acknowledges only if the lease holds after the work too: work that outlives the lease is refused and never reaches the next owner', async () => {
    const fleet = makeFleet('g2')
    const a = fleet.replica('replica-a')
    const handle = await a.router.openTenant(ORG, TENANT_A)
    write(handle, 'kept', 3)
    await handle.snapshot()
    assert.throws(() => handle.run((ledger) => {
      ledger.insertEvent({ actor: 'test', kind: 'tenant-state.test', payload: {}, idemKey: 'unacknowledged' })
      a.clock.advance(TTL)
    }), fencedWith('lease_expired_locally'))
    fleet.advance(TTL + 1, [a.clock])
    const b = fleet.replica('replica-b')
    const next = await b.router.openTenant(ORG, TENANT_A)
    assert.deepEqual(keysOf(next), ['kept-1', 'kept-2', 'kept-3'], 'the unacknowledged write is not in the lineage the next owner restores')
  })

  await check('G3 runAsync has the same bracket across awaits', async () => {
    const fleet = makeFleet('g3')
    const a = fleet.replica('replica-a')
    const handle = await a.router.openTenant(ORG, TENANT_A)
    assert.equal(await handle.runAsync(async (ledger) => {
      await sleep(1)
      ledger.insertEvent({ actor: 'test', kind: 'tenant-state.test', payload: {}, idemKey: 'ok' })
      return 'acknowledged'
    }), 'acknowledged')
    await assert.rejects(() => handle.runAsync(async () => {
      await sleep(1)
      a.clock.advance(TTL)
    }), fencedWith('lease_expired_locally'))
  })

  await check('G4 a manual renewal restarts the window from the moment it was sent', async () => {
    const fleet = makeFleet('g4')
    const a = fleet.replica('replica-a')
    const handle = await a.router.openTenant(ORG, TENANT_A)
    fleet.advance(5_000)
    await handle.renew()
    fleet.advance(5_000)
    assert.equal(handle.run(() => 'still held'), 'still held', 'the first window would have ended at 8000; the renewal moved it to 13000')
    assert.deepEqual(a.events.map(event => event.type), ['acquired', 'restored', 'renewed'])
  })

  // ---- H: handoff --------------------------------------------------------------------------------
  console.log('-- H handoff')
  await check('H1 graceful handoff loses nothing: the final snapshot is flushed, the lease released, and the next owner starts at once with every write', async () => {
    const fleet = makeFleet('h1')
    const a = fleet.replica('replica-a')
    const b = fleet.replica('replica-b')
    const handle = await a.router.openTenant(ORG, TENANT_A)
    const written = write(handle, 'k', 10)
    await handle.handoff()
    assert.deepEqual(a.events.map(event => event.type), ['acquired', 'restored', 'snapshot', 'released'])
    assert.equal(handle.isOpen(), false)
    assert.equal(a.router.openCount(), 0)
    assert.throws(() => handle.run(() => 1), fencedWith('lease_released'))

    const next = await b.router.openTenant(ORG, TENANT_A)
    assert.equal(next.epoch, 2, 'no waiting for the lease to expire')
    assert.deepEqual(keysOf(next), written)
  })

  await check('H2 a crash loses exactly the writes after the last snapshot, and the lineage stays intact for the owner after that', async () => {
    const fleet = makeFleet('h2')
    const frozen = fleet.replica('replica-a')
    const handle = await frozen.router.openTenant(ORG, TENANT_A)
    const kept = write(handle, 'k', 5)
    await handle.snapshot()
    write(handle, 'lost', 3)

    fleet.advance(TTL + 1, [frozen.clock])
    const b = fleet.replica('replica-b')
    const second = await b.router.openTenant(ORG, TENANT_A)
    assert.equal(second.epoch, 2)
    assert.deepEqual(keysOf(second), kept, 'the three writes after the snapshot are the declared RPO')
    const more = write(second, 'm', 2)
    await second.handoff()

    const c = fleet.replica('replica-c')
    assert.deepEqual(keysOf(await c.router.openTenant(ORG, TENANT_A)), [...kept, ...more])
  })

  await check('H3 a handoff whose flush fails keeps serving and keeps the lease; once the store is back it completes with every write', async () => {
    const fleet = makeFleet('h3')
    const a = fleet.replica('replica-a')
    const b = fleet.replica('replica-b')
    const handle = await a.router.openTenant(ORG, TENANT_A)
    write(handle, 'k', 3)
    fleet.durable.down = true
    await assert.rejects(() => handle.handoff(), DurableStoreUnavailableError)
    assert.equal(handle.isOpen(), true, 'the tenant keeps serving: releasing now would hand the next owner an older copy')
    await assert.rejects(() => b.router.openTenant(ORG, TENANT_A), LeaseHeldError)
    const more = write(handle, 'm', 2)
    fleet.durable.down = false
    await handle.handoff()
    assert.deepEqual(keysOf(await b.router.openTenant(ORG, TENANT_A)), ['k-1', 'k-2', 'k-3', ...more])
  })

  await check('H4 abandon releases at once without a flush: the writes after the last snapshot are given up on purpose', async () => {
    const fleet = makeFleet('h4')
    const a = fleet.replica('replica-a')
    const b = fleet.replica('replica-b')
    const handle = await a.router.openTenant(ORG, TENANT_A)
    const kept = write(handle, 'k', 2)
    await handle.snapshot()
    write(handle, 'gone', 2)
    fleet.durable.down = true
    await handle.abandon()
    fleet.durable.down = false
    assert.deepEqual(a.events.at(-1), { type: 'released', key: KEY_A, epoch: 1, flushed: false })
    assert.deepEqual(keysOf(await b.router.openTenant(ORG, TENANT_A)), kept)
  })

  await check('H5 a drain lets in-flight work finish and be acknowledged, refuses new work, then hands off with that work included', async () => {
    const fleet = makeFleet('h5')
    const a = fleet.replica('replica-a')
    const b = fleet.replica('replica-b')
    const handle = await a.router.openTenant(ORG, TENANT_A)
    let finish: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { finish = resolve })
    const inFlight = handle.runAsync(async (ledger) => {
      await gate
      ledger.insertEvent({ actor: 'test', kind: 'tenant-state.test', payload: {}, idemKey: 'in-flight' })
      return 'done'
    })
    const handoff = handle.handoff()
    await sleep(5)
    assert.equal(handle.isOpen(), false)
    assert.throws(() => handle.run(() => 1), TenantDrainingError)
    await assert.rejects(() => handle.runAsync(async () => 1), TenantDrainingError)
    await assert.rejects(() => handle.handoff(), TenantDrainingError, 'a second handoff does not start while one drains')
    await assert.rejects(() => a.router.openTenant(ORG, TENANT_A), TenantDrainingError, 'opening a tenant that is being handed off says so, instead of reporting it held by this replica')
    finish()
    assert.equal(await inFlight, 'done')
    await handoff
    assert.deepEqual(keysOf(await b.router.openTenant(ORG, TENANT_A)), ['in-flight'])
  })

  await check('H6 forget through the handle deletes every copy and the local files, closes the handle, and the next open starts empty at the next epoch', async () => {
    const fleet = makeFleet('h6')
    const a = fleet.replica('replica-a')
    const handle = await a.router.openTenant(ORG, TENANT_A)
    write(handle, 'k', 4)
    await handle.snapshot()
    assert.ok((await fleet.store.list(prefixOf(KEY_A))).length > 0)
    const outcome = await handle.forget()
    assert.equal(outcome.floor, 1)
    assert.deepEqual(await fleet.store.list(prefixOf(KEY_A)), [])
    assert.equal(existsSync(ledgerDbPath(tenantRootFor(a.stateRoot, ORG, TENANT_A))), false)
    assert.equal(handle.isOpen(), false)
    assert.equal(a.router.openCount(), 0)

    const reopened = await a.router.openTenant(ORG, TENANT_A)
    assert.equal(reopened.epoch, 2)
    assert.equal(reopened.restoredFrom, null)
    assert.deepEqual(keysOf(reopened), [])
  })

  await check('H7 closing the router hands every tenant off with a flush and refuses new opens', async () => {
    const fleet = makeFleet('h7')
    const a = fleet.replica('replica-a')
    const b = fleet.replica('replica-b')
    const one = await a.router.openTenant(ORG, TENANT_A)
    const two = await a.router.openTenant(ORG, TENANT_B)
    const keysOne = write(one, 'one', 3)
    const keysTwo = write(two, 'two', 2)
    assert.deepEqual(await a.router.close(), [])
    assert.equal(a.router.openCount(), 0)
    await assert.rejects(() => a.router.openTenant(ORG, TENANT_A), RouterClosedError)
    assert.deepEqual(keysOf(await b.router.openTenant(ORG, TENANT_A)), keysOne)
    assert.deepEqual(keysOf(await b.router.openTenant(ORG, TENANT_B)), keysTwo)
  })

  // ---- L: lifecycle ---------------------------------------------------------------------------------
  console.log('-- L lifecycle')
  await check('L1 losing the lease ends the handle for good: it leaves the registry, refuses work, and the tenant cannot be reopened while someone else holds it', async () => {
    const fleet = makeFleet('l1')
    const frozen = fleet.replica('replica-a')
    const b = fleet.replica('replica-b')
    const handle = await frozen.router.openTenant(ORG, TENANT_A)
    write(handle, 'k', 2)
    fleet.advance(TTL + 1, [frozen.clock])
    await b.router.openTenant(ORG, TENANT_A)
    assert.equal(handle.isOpen(), true, 'a frozen clock cannot see the takeover')
    await assert.rejects(() => handle.renew(), LeaseLostError)
    assert.equal(handle.isOpen(), false)
    assert.equal(frozen.router.handleOf(ORG, TENANT_A), null)
    assert.throws(() => handle.run(() => 1), fencedWith('lease_lost'))
    assert.deepEqual(frozen.events.at(-1), { type: 'lost', key: KEY_A, epoch: 1 })
    await assert.rejects(() => frozen.router.openTenant(ORG, TENANT_A), (error: unknown) => error instanceof LeaseHeldError && error.record.owner === 'replica-b')
  })

  await check('L2 a restore that fails releases the lease again and serves nothing', async () => {
    const fleet = makeFleet('l2')
    const a = fleet.replica('replica-a')
    const handle = await a.router.openTenant(ORG, TENANT_A)
    write(handle, 'k', 2)
    await handle.handoff()
    const image = join(fleet.dir, 'durable', ...`${KEY_A}/e00000001/snap-000001.db`.split('/'))
    const bytes = readFileSync(image)
    bytes[0] ^= 0xff
    writeFileSync(image, bytes)

    const b = fleet.replica('replica-b')
    await assert.rejects(() => b.router.openTenant(ORG, TENANT_A), RestoreVerificationError)
    assert.equal(b.router.openCount(), 0)
    assert.deepEqual(b.events.map(event => event.type), ['acquired'])
    const record = await fleet.leases.read(KEY_A)
    assert.ok(record && record.epoch === 2 && record.leaseUntilMs <= fleet.storeClock.nowMs(), 'the failed attempt gave the lease back')
  })

  await check('L3 background renewal keeps a tenant across more than two lease terms on real timers, and abandon stops it and frees the tenant', async () => {
    const dir = join(root, 'l3')
    const leases = new SqliteLeaseStore({ path: join(dir, 'leases.db') })
    cleanups.push(() => leases.close())
    const durable = new DirDurableStore(join(dir, 'durable'))
    const events: RouterEvent[] = []
    const router = new TenantRouter({
      stateRoot: join(dir, 'a'), replicaId: 'replica-a', leases, durable,
      ttlMs: 1_000, marginMs: 250, renewEveryMs: 150, autoRenew: true, onEvent: (event) => { events.push(event) },
    })
    const handle = await router.openTenant(ORG, TENANT_A)
    await sleep(2_300)
    assert.equal(handle.isOpen(), true)
    assert.equal(handle.run(() => 'served after two terms'), 'served after two terms')
    assert.equal((await leases.read(KEY_A))?.epoch, 1, 'renewals never changed the epoch')
    assert.ok(events.filter(event => event.type === 'renewed').length >= 8, `renewals: ${events.filter(event => event.type === 'renewed').length}`)
    await handle.abandon()
    const next = new TenantRouter({ stateRoot: join(dir, 'b'), replicaId: 'replica-b', leases, durable, ttlMs: 1_000, marginMs: 250, autoRenew: false })
    assert.equal((await next.openTenant(ORG, TENANT_A)).epoch, 2, 'abandon released the lease at once')
    await next.close()
  })

  await check('L4 periodic snapshots publish while serving, one at a time, with contiguous sequence numbers', async () => {
    const fleet = makeFleet('l4')
    const a = fleet.replica('replica-a', { snapshotEveryMs: 40 })
    const handle = await a.router.openTenant(ORG, TENANT_A)
    write(handle, 'k', 6)
    await sleep(700)
    await handle.handoff()
    const manifests = (await fleet.store.list(`${KEY_A}/e00000001/snap-`)).filter(key => key.endsWith('.json'))
    assert.ok(manifests.length >= 3, `${manifests.length} snapshots in 700 ms plus the final one`)
    assert.deepEqual(manifests.map(key => Number(/snap-(\d{6})\.json$/.exec(key)?.[1])), manifests.map((_, index) => index + 1))
    assert.equal(a.events.filter(event => event.type === 'snapshot').length, manifests.length)
  })

  await check('L5 events carry only the organization and the hmac tenant id, an epoch and codes: no personal data', async () => {
    const fleet = makeFleet('l5')
    const a = fleet.replica('replica-a')
    const handle = await a.router.openTenant(ORG, TENANT_A)
    write(handle, 'secret-looking-key', 1)
    await handle.snapshot()
    fleet.durable.down = true
    await handle.snapshot().catch(() => undefined)
    fleet.durable.down = false
    await handle.handoff()
    assert.ok(a.events.length >= 5)
    for (const event of a.events) {
      assert.equal(event.key, KEY_A)
      assert.doesNotMatch(JSON.stringify(event), /secret-looking-key|user-1|idp\.example/)
    }
  })

  await check('L6 snapshots requested together run one after the other and take consecutive sequence numbers', async () => {
    const fleet = makeFleet('l6')
    const a = fleet.replica('replica-a')
    const handle = await a.router.openTenant(ORG, TENANT_A)
    write(handle, 'k', 3)
    const manifests = await Promise.all([handle.snapshot(), handle.snapshot(), handle.snapshot()])
    assert.deepEqual(manifests.map(manifest => manifest.seq), [1, 2, 3])
  })

  console.log(`tenant-state-router-tests: ${passed} checks passed`)
} finally {
  for (const cleanup of [...cleanups].reverse()) {
    try { await cleanup() } catch { /* best effort */ }
  }
  rmSync(root, { recursive: true, force: true })
}
