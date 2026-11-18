/**
 * Idle release of open-tenant slots (A3 of #674, docs/rfc/aaas-rfc.md §4.8(g)).
 *
 * Until idle release composes with tenant affinity, one organization with many users can fill the slots and
 * every other new tenant is refused by that replica. `idleReleaseMs` lets a replica free the slot of a tenant
 * whose last work through the handle is past the threshold, by handing it off the ordinary way (drain, final
 * snapshot, lease released) — no second destruction path.
 *
 * Offline and deterministic: fake clocks decide idleness (the injected monotonic clock is the decision, the
 * real timer behind it only wakes), SQLite lease files stand in for the lease store, a directory for the
 * object store, and every replica is a router over its own state root in one process. The wakes are real
 * timers, so the checks wait a few hundred milliseconds each. No network, no model, and the founder's
 * runtime state root is never opened.
 *
 *   I  idle release: the default keeps the slot for ever, a quiet tenant is handed off at the threshold with
 *      a flushed final snapshot, activity through run or the guarded ledger restarts the period, and a
 *      handoff that failed keeps serving and retries after another full period.
 *   W  work already running is never cut: the busy tenant stays, and it is released one period after the work.
 *   C  capacity: slots still full refuse with ReplicaAtCapacityError; after an idle release a new tenant opens.
 *   V  validation: idleReleaseMs must be an integer within [0, 2^31-1]; zero is off, like unset.
 *
 * Run: cd ts && npx tsx scripts/tenant-router-idle-release-tests.ts
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { DirDurableStore } from '../src/tenant-state/durable-store.ts'
import { ReplicaAtCapacityError } from '../src/tenant-state/errors.ts'
import { deriveLedgerTenantId, leaseKeyFor } from '../src/tenant-state/ids.ts'
import { SqliteLeaseStore } from '../src/tenant-state/lease-store.ts'
import { TenantRouter, type RouterEvent, type TenantHandle } from '../src/tenant-state/tenant-router.ts'
import { FaultyDurableStore, ManualClock } from './tenant-state-test-kit.ts'

const ORG = 'acme'
const ORG_KEY = Buffer.alloc(32, 5)
const ISSUER = 'https://idp.example/acme'
const TENANT_A = deriveLedgerTenantId(ORG_KEY, ISSUER, 'user-1')
const TENANT_B = deriveLedgerTenantId(ORG_KEY, ISSUER, 'user-2')
const TENANT_C = deriveLedgerTenantId(ORG_KEY, ISSUER, 'user-3')
const KEY_A = leaseKeyFor(ORG, TENANT_A)
const TTL = 10_000
const MARGIN = 2_000
/** The idle period under test: short, because the wake is a real timer the suite waits for. */
const IDLE = 60
/** Longer than several wakes: whatever the idle timer was armed for, it has fired within this. */
const QUIET = 300

let passed = 0
async function check(label: string, assertion: () => Promise<void>): Promise<void> {
  await assertion()
  passed += 1
  console.log(`  ok - ${label}`)
}

const root = mkdtempSync(join(tmpdir(), 'gotry-tenant-router-idle-'))
const cleanups: Array<() => void | Promise<void>> = []

interface Replica {
  readonly id: string
  readonly router: TenantRouter
  readonly clock: ManualClock
  readonly stateRoot: string
  readonly events: RouterEvent[]
}

interface Fleet {
  readonly dir: string
  readonly leases: SqliteLeaseStore
  readonly storeClock: ManualClock
  readonly durable: FaultyDurableStore
  replica(id: string, options?: { maxOpenTenants?: number; idleReleaseMs?: number }): Replica
  advance(ms: number): void
}

function makeFleet(name: string): Fleet {
  const dir = join(root, name)
  const storeClock = new ManualClock(1_000_000)
  const leases = new SqliteLeaseStore({ path: join(dir, 'leases.db'), nowMs: () => storeClock.nowMs() })
  const durable = new FaultyDurableStore(new DirDurableStore(join(dir, 'durable')))
  const clocks: ManualClock[] = []
  cleanups.push(() => leases.close())
  return {
    dir,
    leases,
    storeClock,
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
        maxOpenTenants: options.maxOpenTenants,
        idleReleaseMs: options.idleReleaseMs,
        onEvent: (event) => { events.push(event) },
      })
      cleanups.push(() => router.close().then(() => undefined))
      return { id, router, clock, stateRoot, events }
    },
    advance(ms): void {
      storeClock.advance(ms)
      for (const clock of clocks) clock.advance(ms)
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

try {
  // ---- I: idle release ------------------------------------------------------------------
  console.log('-- I idle release')
  await check('I1 without idleReleaseMs a quiet tenant keeps its slot no matter how long nothing happens', async () => {
    const fleet = makeFleet('i1')
    const a = fleet.replica('replica-a')
    const handle = await a.router.openTenant(ORG, TENANT_A)
    write(handle, 'k', 1)
    fleet.advance(TTL)
    await sleep(QUIET)
    assert.equal(handle.isOpen(), true)
    assert.equal(a.router.openCount(), 1)
    assert.deepEqual(a.events.filter(event => event.type === 'released'), [], 'the §4.8(g) behavior: the slot is held until a handoff or the router closes')
  })

  await check('I2 a quiet tenant is handed off at the threshold the ordinary way — final snapshot, lease released — and the successor reads every write', async () => {
    const fleet = makeFleet('i2')
    const a = fleet.replica('replica-a', { idleReleaseMs: IDLE })
    const b = fleet.replica('replica-b')
    const handle = await a.router.openTenant(ORG, TENANT_A)
    const written = write(handle, 'k', 3)
    fleet.advance(IDLE)
    await sleep(QUIET)
    assert.equal(handle.isOpen(), false)
    assert.equal(a.router.openCount(), 0)
    assert.deepEqual(a.events.map(event => event.type), ['acquired', 'restored', 'snapshot', 'released'], 'the ordinary handoff path: drain, final snapshot, release — no second destruction path')
    assert.deepEqual(a.events.at(-1), { type: 'released', key: KEY_A, epoch: 1, flushed: true })
    const next = await b.router.openTenant(ORG, TENANT_A)
    assert.equal(next.epoch, 2)
    assert.deepEqual(keysOf(next), written)
  })

  await check('I3 work through run and a read on the guarded ledger each restart the period: the release waits for a full quiet period', async () => {
    const fleet = makeFleet('i3')
    const a = fleet.replica('replica-a', { idleReleaseMs: IDLE })
    const handle = await a.router.openTenant(ORG, TENANT_A)
    fleet.advance(IDLE - 10)
    await sleep(QUIET)
    assert.equal(handle.isOpen(), true, '50 of 60 ms is not idle enough')
    write(handle, 'k', 1)
    fleet.advance(IDLE - 10)
    await sleep(QUIET)
    assert.equal(handle.isOpen(), true, 'the run restarted the period')
    handle.ledger.db.prepare('SELECT COUNT(*) AS n FROM events').get()
    fleet.advance(IDLE - 10)
    await sleep(QUIET)
    assert.equal(handle.isOpen(), true, 'the guarded-ledger read restarted the period')
    fleet.advance(10)
    await sleep(QUIET)
    assert.equal(handle.isOpen(), false, 'a full quiet period after the last activity releases')
  })

  await check('I4 an idle handoff whose flush fails keeps serving, and the next attempt waits for another full idle period', async () => {
    const fleet = makeFleet('i4')
    const a = fleet.replica('replica-a', { idleReleaseMs: IDLE })
    const b = fleet.replica('replica-b')
    const handle = await a.router.openTenant(ORG, TENANT_A)
    const written = write(handle, 'k', 2)
    fleet.durable.down = true
    fleet.advance(IDLE)
    await sleep(QUIET)
    assert.equal(handle.isOpen(), true, 'a failed flush keeps serving')
    assert.deepEqual(a.events.filter(event => event.type === 'released'), [])
    fleet.durable.down = false
    fleet.advance(IDLE / 2)
    await sleep(QUIET)
    assert.equal(handle.isOpen(), true, 'halfway into the fresh period: no retry yet')
    fleet.advance(IDLE / 2 + 1)
    await sleep(QUIET)
    assert.equal(handle.isOpen(), false)
    assert.deepEqual(keysOf(await b.router.openTenant(ORG, TENANT_A)), written)
  })

  // ---- W: work already running ------------------------------------------------------------
  console.log('-- W work in flight')
  await check('W1 work already running is never cut: the busy tenant stays, and it is released one full period after the work ends', async () => {
    const fleet = makeFleet('w1')
    const a = fleet.replica('replica-a', { idleReleaseMs: IDLE })
    const handle = await a.router.openTenant(ORG, TENANT_A)
    write(handle, 'k', 1)
    let finish: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { finish = resolve })
    const work = handle.runAsync(async (ledger) => {
      await gate
      ledger.insertEvent({ actor: 'test', kind: 'tenant-state.test', payload: {}, idemKey: 'late' })
      return 'done'
    })
    fleet.advance(5 * IDLE)
    await sleep(QUIET)
    assert.equal(handle.isOpen(), true, 'the tenant with work in flight is not evicted')
    assert.deepEqual(a.events.filter(event => event.type === 'released'), [])
    finish()
    assert.equal(await work, 'done')
    assert.deepEqual(keysOf(handle), ['k-1', 'late'], 'the work finished and was acknowledged')
    fleet.advance(IDLE)
    await sleep(QUIET)
    assert.equal(handle.isOpen(), false)
    assert.deepEqual(a.events.at(-1), { type: 'released', key: KEY_A, epoch: 1, flushed: true })
  })

  // ---- C: capacity ---------------------------------------------------------------------------
  console.log('-- C capacity')
  await check('C1 full slots refuse with ReplicaAtCapacityError; the idle release of one tenant frees its slot for a new tenant', async () => {
    const fleet = makeFleet('c1')
    const a = fleet.replica('replica-a', { maxOpenTenants: 2, idleReleaseMs: IDLE })
    await a.router.openTenant(ORG, TENANT_A)
    const kept = await a.router.openTenant(ORG, TENANT_B)
    write(kept, 'k', 1)
    await assert.rejects(() => a.router.openTenant(ORG, TENANT_C), ReplicaAtCapacityError)
    fleet.advance(IDLE / 2)
    await sleep(QUIET)
    await assert.rejects(() => a.router.openTenant(ORG, TENANT_C), ReplicaAtCapacityError, 'still full before the quiet tenant reaches the threshold')
    write(kept, 'm', 1)
    fleet.advance(IDLE / 2)
    await sleep(QUIET)
    assert.equal(a.router.openCount(), 1, 'the quiet tenant released')
    assert.equal(kept.isOpen(), true, 'the tenant that kept working stays')
    const third = await a.router.openTenant(ORG, TENANT_C)
    assert.equal(third.epoch, 1)
    assert.equal(a.router.openCount(), 2)
  })

  // ---- V: validation --------------------------------------------------------------------------
  console.log('-- V validation')
  await check('V1 idleReleaseMs must be an integer within [0, 2^31-1]; zero is off, like unset', async () => {
    const fleet = makeFleet('v1')
    const bads: number[] = [-1, 1.5, Number.NaN, 2_147_483_648]
    for (const bad of bads) {
      assert.throws(() => fleet.replica('bad', { idleReleaseMs: bad }), RangeError, `idleReleaseMs ${String(bad)}`)
    }
    const a = fleet.replica('replica-zero', { idleReleaseMs: 0 })
    const handle = await a.router.openTenant(ORG, TENANT_A)
    fleet.advance(IDLE * 10)
    await sleep(QUIET)
    assert.equal(handle.isOpen(), true, 'zero keeps the §4.8(g) behavior')
  })

  console.log(`tenant-router-idle-release-tests: ${passed} checks passed`)
} finally {
  for (const cleanup of [...cleanups].reverse()) {
    try { await cleanup() } catch { /* best effort */ }
  }
  rmSync(root, { recursive: true, force: true })
}
