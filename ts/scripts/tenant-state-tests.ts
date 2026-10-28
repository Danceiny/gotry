/**
 * Tenant ownership core (AaaS A1.1, docs/rfc/aaas-rfc.md §4.2 items 1, 2, 4 and 6; threats S-1/S-3, S-6).
 *
 * Offline and deterministic: SQLite lease files in mkdtemp directories, fake clocks for expiry and
 * self-fencing, and a few real child processes racing one lease file. No network, no model, no shared
 * state write; the founder's runtime state root is never opened.
 *
 *   A  tenant and organization ids: derivation, path-safe validators, nothing touches the filesystem first.
 *   B  the reference lease store passes the LeaseStore conformance checks; its triggers refuse an epoch
 *      that goes backwards or skips, and a deleted lease row.
 *   C  the conformance checks can fail: three deliberately broken stores each turn named checks red.
 *   D  the holder session: the fence deadline, renewal, outage, takeover, a frozen clock, graceful
 *      release, a round trip that eats the lease, and call ordering.
 *   E  real processes: six race one acquisition and exactly one wins; the same after an expiry.
 *
 * Run: cd ts && npx tsx scripts/tenant-state-tests.ts
 */

import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import {
  FencedError,
  InvalidTenantIdError,
  LeaseHeldError,
  LeaseLostError,
  LeaseStoreUnavailableError,
  TenantStateError,
} from '../src/tenant-state/errors.ts'
import {
  assertLedgerTenantId,
  assertOrganizationId,
  deriveLedgerTenantId,
  leaseKeyFor,
  tenantRootFor,
} from '../src/tenant-state/ids.ts'
import {
  SqliteLeaseStore,
  type LeaseGrant,
  type LeaseRecord,
  type LeaseStore,
} from '../src/tenant-state/lease-store.ts'
import { TenantLease, type MonotonicClock } from '../src/tenant-state/tenant-lease.ts'
import { runLeaseStoreConformance } from './tenant-state-lease-conformance.ts'

const TS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORKER = join(TS_DIR, 'scripts', 'tenant-state-lease-worker.ts')

let passed = 0
async function check(label: string, assertion: () => void | Promise<void>): Promise<void> {
  await assertion()
  passed += 1
  console.log(`  ok - ${label}`)
}

class ManualClock implements MonotonicClock {
  private now: number

  constructor(start: number) {
    this.now = start
  }

  nowMs(): number {
    return this.now
  }

  advance(ms: number): void {
    this.now += ms
  }
}

/** A lease store whose network can be cut, and whose acquire can be made slow. */
class FaultyLeaseStore implements LeaseStore {
  down = false
  afterAcquire: (() => void) | null = null
  private readonly inner: LeaseStore

  constructor(inner: LeaseStore) {
    this.inner = inner
  }

  private gate(): void {
    if (this.down) throw new LeaseStoreUnavailableError('injected outage')
  }

  async read(key: string): Promise<LeaseRecord | null> {
    this.gate()
    return this.inner.read(key)
  }

  async acquire(key: string, owner: string, ttlMs: number): Promise<LeaseGrant> {
    this.gate()
    const grant = await this.inner.acquire(key, owner, ttlMs)
    this.afterAcquire?.()
    return grant
  }

  async renew(key: string, owner: string, epoch: number, ttlMs: number): Promise<LeaseGrant> {
    this.gate()
    return this.inner.renew(key, owner, epoch, ttlMs)
  }

  async release(key: string, owner: string, epoch: number): Promise<LeaseRecord> {
    this.gate()
    return this.inner.release(key, owner, epoch)
  }

  async markForgotten(key: string, owner: string, epoch: number): Promise<LeaseRecord> {
    this.gate()
    return this.inner.markForgotten(key, owner, epoch)
  }
}

/** Delegates everything; each broken store below overrides exactly one behavior. */
class DelegatingLeaseStore implements LeaseStore {
  protected readonly inner: LeaseStore

  constructor(inner: LeaseStore) {
    this.inner = inner
  }

  read(key: string): Promise<LeaseRecord | null> { return this.inner.read(key) }
  acquire(key: string, owner: string, ttlMs: number): Promise<LeaseGrant> { return this.inner.acquire(key, owner, ttlMs) }
  renew(key: string, owner: string, epoch: number, ttlMs: number): Promise<LeaseGrant> { return this.inner.renew(key, owner, epoch, ttlMs) }
  release(key: string, owner: string, epoch: number): Promise<LeaseRecord> { return this.inner.release(key, owner, epoch) }
  markForgotten(key: string, owner: string, epoch: number): Promise<LeaseRecord> { return this.inner.markForgotten(key, owner, epoch) }
}

/** No compare-and-set: acquiring evicts whoever holds the lease. */
class EvictingLeaseStore extends DelegatingLeaseStore {
  override async acquire(key: string, owner: string, ttlMs: number): Promise<LeaseGrant> {
    const current = await this.inner.read(key)
    if (current) await this.inner.release(key, current.owner, current.epoch)
    return this.inner.acquire(key, owner, ttlMs)
  }
}

/** The epoch is no fencing token: every grant reports epoch 1. */
class FlatEpochLeaseStore extends DelegatingLeaseStore {
  override async acquire(key: string, owner: string, ttlMs: number): Promise<LeaseGrant> {
    const grant = await this.inner.acquire(key, owner, ttlMs)
    return { ...grant, record: { ...grant.record, epoch: 1 } }
  }
}

/** Renewal does not check who asks: a stale holder revives the current lease. */
class TokenBlindRenewLeaseStore extends DelegatingLeaseStore {
  override async renew(key: string, owner: string, epoch: number, ttlMs: number): Promise<LeaseGrant> {
    const current = await this.inner.read(key)
    if (!current) throw new LeaseLostError(`${key}: unknown`)
    return this.inner.renew(key, current.owner, current.epoch, ttlMs)
  }
}

/** Every renewal and release takes a little real time, and the store counts how many are in flight at once. */
class CountingLeaseStore extends DelegatingLeaseStore {
  inFlight = 0
  maxInFlight = 0

  private async tracked<T>(run: () => Promise<T>): Promise<T> {
    this.inFlight += 1
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    try {
      await sleep(5)
      return await run()
    } finally {
      this.inFlight -= 1
    }
  }

  override renew(key: string, owner: string, epoch: number, ttlMs: number): Promise<LeaseGrant> {
    return this.tracked(() => this.inner.renew(key, owner, epoch, ttlMs))
  }

  override release(key: string, owner: string, epoch: number): Promise<LeaseRecord> {
    return this.tracked(() => this.inner.release(key, owner, epoch))
  }
}

function fencedReason(run: () => void): string | undefined {
  try {
    run()
  } catch (error) {
    if (error instanceof FencedError) return error.reason
    throw error
  }
  return undefined
}

const root = mkdtempSync(join(tmpdir(), 'gotry-tenant-state-'))
const children = new Set<ChildProcess>()

try {
  // ---- A: ids ----------------------------------------------------------------
  console.log('-- A tenant and organization ids')
  const ORG_KEY = Buffer.alloc(32, 7)
  const ISSUER = 'https://idp.example/acme'
  const TENANT_A = deriveLedgerTenantId(ORG_KEY, ISSUER, 'user-1')
  const TENANT_B = deriveLedgerTenantId(ORG_KEY, ISSUER, 'user-2')

  await check('A1 derivation is HMAC-SHA256 over issuer, NUL and subject, truncated to 128 bits (known answer)', () => {
    assert.equal(TENANT_A, 't-3129611eac9be1d5994a2b216b06ed27')
    const independent = createHmac('sha256', ORG_KEY).update(`${ISSUER}\u0000user-1`).digest('hex').slice(0, 32)
    assert.equal(TENANT_A, `t-${independent}`)
    assert.equal(deriveLedgerTenantId(ORG_KEY, ISSUER, 'user-1'), TENANT_A, 'deterministic')
  })

  await check('A2 the id changes with the key, the issuer and the subject; the separator keeps field boundaries', () => {
    assert.notEqual(TENANT_A, TENANT_B)
    assert.notEqual(TENANT_A, deriveLedgerTenantId(Buffer.alloc(32, 8), ISSUER, 'user-1'))
    assert.notEqual(TENANT_A, deriveLedgerTenantId(ORG_KEY, 'https://idp.example/other', 'user-1'))
    assert.notEqual(deriveLedgerTenantId(ORG_KEY, 'ab', 'c'), deriveLedgerTenantId(ORG_KEY, 'a', 'bc'))
  })

  await check('A3 non-ASCII and astral subjects derive; lone surrogates, NUL, empty, oversized and short keys are refused', () => {
    assert.match(deriveLedgerTenantId(ORG_KEY, ISSUER, '用户-é-😀'), /^t-[0-9a-f]{32}$/)
    const refused = (run: () => unknown): void => assert.throws(run, (error: unknown) => error instanceof InvalidTenantIdError && error.code === 'GOTRY_TENANT_ID_INVALID')
    refused(() => deriveLedgerTenantId(ORG_KEY, ISSUER, '\ud800'))
    refused(() => deriveLedgerTenantId(ORG_KEY, ISSUER, 'a\ud801b'))
    refused(() => deriveLedgerTenantId(ORG_KEY, 'iss\u0000x', 'user'))
    refused(() => deriveLedgerTenantId(ORG_KEY, ISSUER, 'user\u0000x'))
    refused(() => deriveLedgerTenantId(ORG_KEY, '', 'user'))
    refused(() => deriveLedgerTenantId(ORG_KEY, ISSUER, ''))
    refused(() => deriveLedgerTenantId(ORG_KEY, ISSUER, 'x'.repeat(513)))
    refused(() => deriveLedgerTenantId(Buffer.alloc(31, 7), ISSUER, 'user'))
    refused(() => deriveLedgerTenantId('not-bytes' as unknown as Uint8Array, ISSUER, 'user'))
    assert.match(deriveLedgerTenantId(ORG_KEY, ISSUER, 'x'.repeat(512)), /^t-[0-9a-f]{32}$/, '512 bytes is the inclusive limit')
  })

  await check('A4 validators accept the fixed formats and refuse path-shaped, cased, padded and non-string ids', () => {
    for (const ok of ['acme', 'a', 'acme-eu-1', '0day']) assert.equal(assertOrganizationId(ok), ok)
    for (const bad of ['', 'Acme', '-acme', 'a_b', 'a/b', '..', '../x', 'a'.repeat(64), 'acme\n', ' acme', 'ac me', 123, null, undefined]) {
      assert.throws(() => assertOrganizationId(bad), InvalidTenantIdError, `organization ${JSON.stringify(bad)}`)
    }
    assert.equal(assertLedgerTenantId(TENANT_A), TENANT_A)
    const hex = TENANT_A.slice(2)
    for (const bad of ['local', 't-', `t-${hex.slice(1)}`, `t-${hex}0`, `t-${hex.toUpperCase()}`, `T-${hex}`, `${TENANT_A}\n`, `../${TENANT_A}`, `${TENANT_A}/..`, `t-${'g'.repeat(32)}`, 42, null]) {
      assert.throws(() => assertLedgerTenantId(bad), InvalidTenantIdError, `tenant ${JSON.stringify(bad)}`)
    }
  })

  await check('A5 tenantRootFor and leaseKeyFor build from validated ids only, and refuse bad ids before any filesystem call', () => {
    const stateRoot = join(root, 'ids-state')
    assert.equal(tenantRootFor(stateRoot, 'acme', TENANT_A), join(stateRoot, 'orgs', 'acme', 'tenants', TENANT_A))
    assert.equal(leaseKeyFor('acme', TENANT_A), `acme/${TENANT_A}`)
    for (const [org, tenant] of [['..', TENANT_A], ['acme', '../../etc'], ['acme/x', TENANT_A], ['acme', `${TENANT_A}/../${TENANT_B}`], ['', TENANT_A]] as const) {
      assert.throws(() => tenantRootFor(stateRoot, org, tenant), InvalidTenantIdError)
      assert.throws(() => leaseKeyFor(org, tenant), InvalidTenantIdError)
    }
    assert.deepEqual(readdirSync(root).filter(name => name === 'ids-state'), [], 'no directory was created for any id, valid or not')
  })

  // ---- B: reference lease store ---------------------------------------------------
  console.log('-- B reference lease store')
  const conformanceClock = new ManualClock(1_000_000)
  const conformanceDb = join(root, 'conformance', 'leases.db')
  const referenceStore = new SqliteLeaseStore({ path: conformanceDb, nowMs: () => conformanceClock.nowMs() })

  await check('B1 the reference store passes every LeaseStore conformance check', async () => {
    const failures = await runLeaseStoreConformance(
      { store: referenceStore, advance: (ms) => conformanceClock.advance(ms), now: () => conformanceClock.nowMs() },
      'reference',
    )
    assert.deepEqual(failures, [])
  })

  await check('B2 the lease expires exactly when the store clock reaches its end, not before', async () => {
    const key = 'boundary/b2'
    const grant = await referenceStore.acquire(key, 'a', 1_000)
    conformanceClock.advance(999)
    await assert.rejects(() => referenceStore.acquire(key, 'b', 1_000), LeaseHeldError, 'one millisecond before the end')
    conformanceClock.advance(1)
    assert.equal(conformanceClock.nowMs(), grant.record.leaseUntilMs)
    const next = await referenceStore.acquire(key, 'b', 1_000)
    assert.equal(next.record.epoch, 2, 'at the end instant the lease is over')
  })

  await check('B3 storage triggers refuse an epoch that goes back or skips, a lower forgotten floor, and a deleted row', async () => {
    const key = 'triggers/b3'
    await referenceStore.acquire(key, 'a', 1_000)
    await referenceStore.markForgotten(key, 'a', 1)
    const raw = new Database(conformanceDb)
    try {
      raw.pragma('busy_timeout = 5000')
      assert.throws(() => raw.prepare('UPDATE leases SET epoch = epoch - 1 WHERE key = ?').run(key), /moves forward by exactly one/)
      assert.throws(() => raw.prepare('UPDATE leases SET epoch = epoch + 2 WHERE key = ?').run(key), /moves forward by exactly one/)
      assert.throws(() => raw.prepare('UPDATE leases SET forgotten_at_epoch = 0 WHERE key = ?').run(key), /never moves back/)
      assert.throws(() => raw.prepare('DELETE FROM leases WHERE key = ?').run(key), /never deleted/)
      assert.equal((raw.prepare('SELECT epoch, forgotten_at_epoch AS floor FROM leases WHERE key = ?').get(key) as { epoch: number; floor: number }).epoch, 1)
    } finally {
      raw.close()
    }
    const renewed = await referenceStore.renew(key, 'a', 1, 1_000)
    assert.equal(renewed.record.forgottenAtEpoch, 1, 'the refused statements left the row usable and intact')
  })

  await check('B4 the audit trail lists every granted operation in order with strictly increasing acquire epochs', async () => {
    const trail = referenceStore.history('reference/check-6')
    assert.deepEqual(trail.map(entry => `${entry.op}:${entry.epoch}`), ['acquire:1', 'acquire:2', 'renew:2'])
    const all = referenceStore.history()
    const acquires = new Map<string, number>()
    for (const entry of all.filter(item => item.op === 'acquire')) {
      assert.equal(entry.epoch, (acquires.get(entry.key) ?? 0) + 1, `${entry.key} acquires move one epoch at a time`)
      acquires.set(entry.key, entry.epoch)
    }
  })
  referenceStore.close()

  // ---- C: the checks can fail ------------------------------------------------------
  console.log('-- C the conformance checks can fail')
  async function brokenRun(name: string, wrap: (inner: LeaseStore) => LeaseStore): Promise<string[]> {
    const clock = new ManualClock(2_000_000)
    const inner = new SqliteLeaseStore({ path: join(root, 'broken', `${name}.db`), nowMs: () => clock.nowMs() })
    try {
      const failures = await runLeaseStoreConformance({ store: wrap(inner), advance: (ms) => clock.advance(ms), now: () => clock.nowMs() }, name)
      return failures.map(failure => failure.check)
    } finally {
      inner.close()
    }
  }

  await check('C1 a store without compare-and-set fails the exclusivity checks', async () => {
    const failed = await brokenRun('evicting', inner => new EvictingLeaseStore(inner))
    assert.ok(failed.includes('acquire is refused while another unexpired lease exists'), failed.join(' | '))
    assert.ok(failed.includes('acquire is refused for the current holder too'), failed.join(' | '))
  })

  await check('C2 a store whose epoch is not a fencing token fails the epoch checks', async () => {
    const failed = await brokenRun('flat-epoch', inner => new FlatEpochLeaseStore(inner))
    assert.ok(failed.includes('epochs strictly increase and never repeat'), failed.join(' | '))
    assert.ok(failed.includes('an expired lease is taken at epoch + 1 and the old holder is refused everywhere'), failed.join(' | '))
  })

  await check('C3 a store that renews for anyone fails the stale-holder checks', async () => {
    const failed = await brokenRun('token-blind', inner => new TokenBlindRenewLeaseStore(inner))
    assert.ok(failed.includes('renew by another owner or for another epoch is refused'), failed.join(' | '))
    assert.ok(failed.includes('an expired lease is taken at epoch + 1 and the old holder is refused everywhere'), failed.join(' | '))
  })

  // ---- D: holder session -----------------------------------------------------------
  console.log('-- D holder session')
  const TTL = 10_000
  const MARGIN = 2_000
  const KEY = leaseKeyFor('acme', TENANT_A)

  interface World {
    readonly store: SqliteLeaseStore
    readonly faulty: FaultyLeaseStore
    readonly storeClock: ManualClock
    replica(): ManualClock
    /** Moves the store clock and every replica clock together, as a healthy fleet would. */
    advance(ms: number): void
  }

  function makeWorld(name: string): World {
    const storeClock = new ManualClock(1_000_000)
    const store = new SqliteLeaseStore({ path: join(root, 'holder', `${name}.db`), nowMs: () => storeClock.nowMs() })
    const clocks: ManualClock[] = []
    return {
      store,
      faulty: new FaultyLeaseStore(store),
      storeClock,
      replica(): ManualClock {
        const clock = new ManualClock(5_000)
        clocks.push(clock)
        return clock
      },
      advance(ms: number): void {
        storeClock.advance(ms)
        for (const clock of clocks) clock.advance(ms)
      },
    }
  }

  const hold = (world: World, replicaId: string, clock: ManualClock, store: LeaseStore = world.store): Promise<TenantLease> =>
    TenantLease.acquire({ store, key: KEY, replicaId, ttlMs: TTL, marginMs: MARGIN, clock })

  await check('D1 the holder stops acknowledging at sent-at + ttl - margin: held one tick before, fenced on the tick', async () => {
    const world = makeWorld('d1')
    const lease = await hold(world, 'r1', world.replica())
    assert.equal(lease.epoch, 1)
    assert.equal(lease.remainingMs(), TTL - MARGIN)
    lease.assertHeld()
    world.advance(TTL - MARGIN - 1)
    lease.assertHeld()
    assert.equal(lease.isHeld(), true)
    world.advance(1)
    assert.equal(fencedReason(() => lease.assertHeld()), 'lease_expired_locally')
    assert.equal(lease.isHeld(), false)
    const record = await world.store.read(KEY)
    assert.ok(record && record.leaseUntilMs > world.storeClock.nowMs(), 'the store still lists the lease as valid: the holder fenced itself early')
    world.store.close()
  })

  await check('D2 a renewal keeps the epoch and restarts the window from the moment it was sent', async () => {
    const world = makeWorld('d2')
    const lease = await hold(world, 'r1', world.replica())
    world.advance(3_000)
    await lease.renew()
    assert.equal(lease.epoch, 1)
    assert.equal(lease.remainingMs(), TTL - MARGIN)
    const record = await world.store.read(KEY)
    assert.equal(record?.leaseUntilMs, world.storeClock.nowMs() + TTL)
    world.store.close()
  })

  await check('D3 a store outage fails the holder closed at its deadline; a renewal that gets through resumes it', async () => {
    const world = makeWorld('d3')
    const lease = await hold(world, 'r1', world.replica(), world.faulty)
    world.advance(5_000)
    world.faulty.down = true
    await assert.rejects(() => lease.renew(), LeaseStoreUnavailableError)
    assert.equal(lease.isHeld(), true, 'an unreachable store does not end the lease before its deadline')
    world.advance(3_500)
    assert.equal(fencedReason(() => lease.assertHeld()), 'lease_expired_locally', 'owners stop at lease end while the store is down')
    world.faulty.down = false
    await lease.renew()
    assert.equal(lease.isHeld(), true, 'the epoch never changed, so nobody else held the tenant: resuming is safe')
    assert.equal(lease.epoch, 1)
    world.store.close()
  })

  await check('D4 a renewal that arrives after the store lease ended is refused and the holder is finished for good', async () => {
    const world = makeWorld('d4')
    const lease = await hold(world, 'r1', world.replica(), world.faulty)
    world.faulty.down = true
    world.advance(10_500)
    world.faulty.down = false
    await assert.rejects(() => lease.renew(), LeaseLostError)
    assert.equal(fencedReason(() => lease.assertHeld()), 'lease_lost')
    await assert.rejects(() => lease.renew(), (error: unknown) => error instanceof FencedError && error.reason === 'lease_lost')
    world.store.close()
  })

  await check('D5 takeover after expiry: the new holder gets epoch + 1, the old one is refused and is fenced', async () => {
    const world = makeWorld('d5')
    const a = await hold(world, 'r1', world.replica())
    world.advance(TTL + 1)
    const b = await hold(world, 'r2', world.replica())
    assert.equal(b.epoch, 2)
    assert.equal(fencedReason(() => a.assertHeld()), 'lease_expired_locally')
    await assert.rejects(() => a.renew(), LeaseLostError)
    assert.equal(fencedReason(() => a.assertHeld()), 'lease_lost')
    b.assertHeld()
    await assert.rejects(() => hold(world, 'r3', world.replica()), (error: unknown) => error instanceof LeaseHeldError && error.record.owner === 'r2' && error.record.epoch === 2)
    world.store.close()
  })

  await check('D6 limit of the local fence: a frozen clock cannot see a takeover, but the store refuses the old holder', async () => {
    const world = makeWorld('d6')
    const frozen = world.replica()
    const a = await hold(world, 'r1', frozen)
    world.storeClock.advance(TTL + 1)
    const b = await hold(world, 'r2', world.replica())
    assert.equal(b.epoch, 2)
    assert.equal(a.isHeld(), true, 'a process paused between its check and its acknowledgement still passes the local gate')
    await assert.rejects(() => a.renew(), LeaseLostError, 'the lease store, not the local clock, ends it')
    assert.equal(a.isHeld(), false)
    world.store.close()
  })

  await check('D7 graceful release: the holder stops first, the next owner starts at once at epoch + 1, release is idempotent', async () => {
    const world = makeWorld('d7')
    const a = await hold(world, 'r1', world.replica())
    await a.release()
    assert.equal(fencedReason(() => a.assertHeld()), 'lease_released')
    const b = await hold(world, 'r2', world.replica())
    assert.equal(b.epoch, 2)
    await a.release()
    await assert.rejects(() => a.renew(), (error: unknown) => error instanceof FencedError && error.reason === 'lease_released')
    b.assertHeld()
    world.store.close()
  })

  await check('D8 release while the store is down still stops the holder; the next owner waits out the lease', async () => {
    const world = makeWorld('d8')
    const a = await hold(world, 'r1', world.replica(), world.faulty)
    world.faulty.down = true
    await assert.rejects(() => a.release(), LeaseStoreUnavailableError)
    assert.equal(fencedReason(() => a.assertHeld()), 'lease_released')
    world.faulty.down = false
    await assert.rejects(() => hold(world, 'r2', world.replica()), LeaseHeldError)
    world.advance(TTL + 1)
    assert.equal((await hold(world, 'r2', world.replica())).epoch, 2)
    world.store.close()
  })

  await check('D9 a round trip that eats the usable lease is handed back, not held as an already fenced epoch', async () => {
    const world = makeWorld('d9')
    const slow = world.replica()
    world.faulty.afterAcquire = () => slow.advance(TTL)
    await assert.rejects(() => hold(world, 'r1', slow, world.faulty), LeaseLostError)
    world.faulty.afterAcquire = null
    const record = await world.store.read(KEY)
    assert.equal(record?.epoch, 1)
    assert.ok(record && record.leaseUntilMs <= world.storeClock.nowMs(), 'the consumed grant was released at once')
    assert.equal((await hold(world, 'r2', world.replica())).epoch, 2, 'the next owner needs no wait')
    world.store.close()
  })

  await check('D10 renew and release of one holder run one at a time in call order', async () => {
    const world = makeWorld('d10')
    const lease = await hold(world, 'r1', world.replica())
    const results = await Promise.allSettled([lease.renew(), lease.renew(), lease.release(), lease.renew()])
    assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled', 'fulfilled', 'rejected'])
    assert.equal(fencedReason(() => lease.assertHeld()), 'lease_released')
    assert.deepEqual(world.store.history(KEY).map(entry => entry.op), ['acquire', 'renew', 'renew', 'release'])
    world.store.close()
  })

  await check('D10b a holder has at most one renewal or release outstanding at the store, however many calls overlap', async () => {
    const world = makeWorld('d10b')
    const counting = new CountingLeaseStore(world.store)
    const lease = await hold(world, 'r1', world.replica(), counting)
    const results = await Promise.allSettled([lease.renew(), lease.renew(), lease.renew(), lease.release()])
    assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled'])
    assert.equal(counting.maxInFlight, 1, 'the second call waited for the first')
    assert.deepEqual(world.store.history(KEY).map(entry => entry.op), ['acquire', 'renew', 'renew', 'renew', 'release'])
    world.store.close()
  })

  await check('D11 forget needs a lease that is provably held and records the floor at the holder epoch', async () => {
    const world = makeWorld('d11')
    const lease = await hold(world, 'r1', world.replica())
    const marked = await lease.markForgotten()
    assert.equal(marked.forgottenAtEpoch, 1)
    world.advance(TTL - MARGIN)
    await assert.rejects(() => lease.markForgotten(), FencedError, 'a fenced holder cannot forget')
    world.advance(MARGIN + 1)
    const next = await hold(world, 'r2', world.replica())
    assert.equal(next.epoch, 2)
    assert.equal((await world.store.read(KEY))?.forgottenAtEpoch, 1, 'the floor outlives the holder that set it')
    world.store.close()
  })

  await check('D12 acquire refuses a margin that leaves no usable window, a ttl outside the store bounds, and a blank replica id', async () => {
    const world = makeWorld('d12')
    const clock = world.replica()
    const base = { store: world.store, key: KEY, replicaId: 'r1', ttlMs: TTL, marginMs: MARGIN, clock }
    await assert.rejects(() => TenantLease.acquire({ ...base, marginMs: TTL }), RangeError)
    await assert.rejects(() => TenantLease.acquire({ ...base, marginMs: -1 }), RangeError)
    await assert.rejects(() => TenantLease.acquire({ ...base, ttlMs: 50, marginMs: 10 }), RangeError)
    await assert.rejects(() => TenantLease.acquire({ ...base, replicaId: '' }), RangeError)
    assert.equal(await world.store.read(KEY), null, 'no refused request reached the store')
    world.store.close()
  })

  await check('D13 every typed failure is a TenantStateError with a stable code', () => {
    const codes = [
      new LeaseHeldError({ key: 'k', owner: 'o', epoch: 1, leaseUntilMs: 0, forgottenAtEpoch: 0 }),
      new LeaseLostError('x'),
      new FencedError('lease_lost', 'k', 1),
      new LeaseStoreUnavailableError('x'),
      new InvalidTenantIdError('x'),
    ].map(error => {
      assert.ok(error instanceof TenantStateError)
      return error.code
    })
    assert.deepEqual(codes, [
      'GOTRY_TENANT_LEASE_HELD',
      'GOTRY_TENANT_LEASE_LOST',
      'GOTRY_TENANT_FENCED',
      'GOTRY_TENANT_LEASE_STORE_UNAVAILABLE',
      'GOTRY_TENANT_ID_INVALID',
    ])
  })

  // ---- E: real processes -------------------------------------------------------------
  console.log('-- E real processes racing one lease file')

  interface RaceOutcome {
    replicaId: string
    outcome: 'granted' | 'held' | 'error'
    epoch?: number
    owner?: string
    message?: string
  }

  async function raceAcquire(dbPath: string, key: string, replicaIds: string[], ttlMs: number, round: string): Promise<RaceOutcome[]> {
    const goFile = join(root, `go-${round}`)
    const runs = replicaIds.map((replicaId) => {
      const child = spawn(process.execPath, ['--import', 'tsx', WORKER, dbPath, goFile, key, replicaId, String(ttlMs)], {
        cwd: TS_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      children.add(child)
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      const ready = new Promise<void>((resolve) => {
        const poll = setInterval(() => { if (stdout.includes('ready\n')) { clearInterval(poll); resolve() } }, 5)
        child.once('close', () => { clearInterval(poll); resolve() })
      })
      const closed = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        child.once('close', (code) => { children.delete(child); resolve({ code, stdout, stderr }) })
      })
      return { ready, closed }
    })
    const budget = setTimeout(() => { for (const child of children) child.kill('SIGKILL') }, 60_000)
    try {
      await Promise.all(runs.map(run => run.ready))
      writeFileSync(goFile, 'go')
      const results = await Promise.all(runs.map(run => run.closed))
      return results.map((result, index) => {
        assert.equal(result.code, 0, `${replicaIds[index]} exited ${String(result.code)}: ${result.stderr}`)
        const lines = result.stdout.trim().split('\n')
        return JSON.parse(lines[lines.length - 1]) as RaceOutcome
      })
    } finally {
      clearTimeout(budget)
    }
  }

  const raceDb = join(root, 'race', 'leases.db')
  const observer = new SqliteLeaseStore({ path: raceDb })

  await check('E1 six processes acquire one fresh lease at the same moment: exactly one is granted, epoch 1; the rest are told who holds it', async () => {
    const key = leaseKeyFor('acme', TENANT_A)
    const outcomes = await raceAcquire(raceDb, key, ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'], 60_000, 'e1')
    const granted = outcomes.filter(outcome => outcome.outcome === 'granted')
    assert.equal(granted.length, 1, JSON.stringify(outcomes))
    assert.equal(granted[0].epoch, 1)
    for (const loser of outcomes.filter(outcome => outcome.outcome !== 'granted')) {
      assert.equal(loser.outcome, 'held', JSON.stringify(loser))
      assert.equal(loser.owner, granted[0].replicaId)
      assert.equal(loser.epoch, 1)
    }
    assert.deepEqual(observer.history(key).map(entry => `${entry.op}:${entry.owner}:${entry.epoch}`), [`acquire:${granted[0].replicaId}:1`])
  })

  await check('E2 after the lease expires in real time, six fresh processes race again: exactly one is granted, epoch 2', async () => {
    const key = leaseKeyFor('acme', TENANT_B)
    const first = await raceAcquire(raceDb, key, ['q1', 'q2', 'q3'], 1_500, 'e2a')
    assert.equal(first.filter(outcome => outcome.outcome === 'granted').length, 1)
    for (let waited = 0; ; waited += 20) {
      const record = await observer.read(key)
      if (record && record.leaseUntilMs <= Date.now()) break
      assert.ok(waited < 5_000, 'the lease never expired')
      await sleep(20)
    }
    const second = await raceAcquire(raceDb, key, ['s1', 's2', 's3', 's4', 's5', 's6'], 60_000, 'e2b')
    const granted = second.filter(outcome => outcome.outcome === 'granted')
    assert.equal(granted.length, 1, JSON.stringify(second))
    assert.equal(granted[0].epoch, 2)
    assert.deepEqual(observer.history(key).map(entry => entry.epoch), [1, 2])
    assert.ok(second.filter(outcome => outcome.outcome === 'held').every(outcome => outcome.epoch === 2 && outcome.owner === granted[0].replicaId))
  })
  observer.close()

  console.log(`tenant-state-tests: ${passed} checks passed`)
} finally {
  for (const child of children) child.kill('SIGKILL')
  rmSync(root, { recursive: true, force: true })
}
