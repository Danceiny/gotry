/**
 * Epoch-scoped durable copies (AaaS A1.2, docs/rfc/aaas-rfc.md §4.2 item 3 and §4.3 mode D-a; threats S-6 and S-12).
 *
 * Offline and deterministic: a directory stands in for the object store, SQLite lease files for the lease
 * store, fake clocks for expiry. Replicas are separate state roots in one process. No network, no model,
 * and the founder's runtime state root is never opened.
 *
 *   K  the directory store passes the DurableStore conformance checks, and the checks can fail.
 *   S  publishing: a verified, self-contained image in the holder's epoch prefix; fenced holders publish nothing.
 *   V  image verification: foreign-tenant rows, a non-database and a broken fold are refused.
 *   R  restoring: the newest lineage wins, a base pins the exact snapshot, corrupt copies are passed over.
 *   X  takeover: a paused owner's late upload never reaches a later owner's ledger; local files never survive.
 *   F  forget: every copy goes, the floor masks late uploads, and a sweep removes them.
 *   I  faults: a store outage and a crash between an image and its manifest.
 *
 * Run: cd ts && npx tsx scripts/tenant-state-copies-tests.ts
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'

import { ledgerDbPath, openDb, type StateLedger } from '../src/state-ledger.ts'
import { DirDurableStore, type DurableStore } from '../src/tenant-state/durable-store.ts'
import {
  forgetTenant,
  publishSnapshot,
  resolveRestorePoint,
  restoreTenantLedger,
  sweepMaskedCopies,
  verifyLedgerImage,
  type EpochCopyContext,
  type RestoreResult,
} from '../src/tenant-state/epoch-copies.ts'
import {
  CopyConflictError,
  DurableStoreUnavailableError,
  FencedError,
  LeaseLostError,
  RestoreVerificationError,
} from '../src/tenant-state/errors.ts'
import { deriveLedgerTenantId, leaseKeyFor, tenantRootFor } from '../src/tenant-state/ids.ts'
import { SqliteLeaseStore } from '../src/tenant-state/lease-store.ts'
import { TenantLease } from '../src/tenant-state/tenant-lease.ts'
import { runDurableStoreConformance } from './tenant-state-durable-conformance.ts'
import { FaultyDurableStore, ManualClock, TrippingClock } from './tenant-state-test-kit.ts'

const ORG = 'acme'
const ORG_KEY = Buffer.alloc(32, 9)
const ISSUER = 'https://idp.example/acme'
const TENANT = deriveLedgerTenantId(ORG_KEY, ISSUER, 'user-1')
const OTHER_TENANT = deriveLedgerTenantId(ORG_KEY, ISSUER, 'user-2')
const KEY = leaseKeyFor(ORG, TENANT)
const TTL = 10_000
const MARGIN = 2_000

let passed = 0
async function check(label: string, assertion: () => void | Promise<void>): Promise<void> {
  await assertion()
  passed += 1
  console.log(`  ok - ${label}`)
}

/** Breaks one rule of the contract: a put overwrites what exists. */
class OverwritingDurableStore implements DurableStore {
  private readonly inner: DurableStore
  private readonly written = new Map<string, Uint8Array>()

  constructor(inner: DurableStore) {
    this.inner = inner
  }

  async putIfAbsent(key: string, bytes: Uint8Array): Promise<boolean> {
    this.written.set(key, bytes)
    return true
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.written.get(key) ?? this.inner.get(key)
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.written.keys()].filter(key => key.startsWith(prefix)).sort()
  }

  async deletePrefix(prefix: string): Promise<number> {
    return this.inner.deletePrefix(prefix)
  }
}

/** Breaks another rule: the partial last segment of a prefix is ignored, so a listing returns the whole directory. */
/** A store whose delete treats the prefix as raw text, so `acme` would take `acme2` too. */
class RawPrefixDeleteDurableStore implements DurableStore {
  constructor(private readonly inner: DurableStore, private readonly directory: string) {}

  putIfAbsent(key: string, bytes: Uint8Array): Promise<boolean> { return this.inner.putIfAbsent(key, bytes) }
  get(key: string): Promise<Uint8Array | null> { return this.inner.get(key) }
  list(prefix: string): Promise<string[]> { return this.inner.list(prefix) }
  async deletePrefix(prefix: string): Promise<number> {
    const keys = await this.inner.list(prefix)
    for (const key of keys) rmSync(join(this.directory, ...key.split('/')), { force: true })
    return keys.length
  }
}

class DirectoryOnlyListDurableStore implements DurableStore {
  private readonly inner: DurableStore

  constructor(inner: DurableStore) {
    this.inner = inner
  }

  putIfAbsent(key: string, bytes: Uint8Array): Promise<boolean> { return this.inner.putIfAbsent(key, bytes) }
  get(key: string): Promise<Uint8Array | null> { return this.inner.get(key) }
  deletePrefix(prefix: string): Promise<number> { return this.inner.deletePrefix(prefix) }
  list(prefix: string): Promise<string[]> { return this.inner.list(prefix.slice(0, prefix.lastIndexOf('/') + 1)) }
}

const root = mkdtempSync(join(tmpdir(), 'gotry-tenant-copies-'))
const worlds: World[] = []
const openLedgers: StateLedger[] = []

interface World {
  readonly dir: string
  readonly leases: SqliteLeaseStore
  readonly storeClock: ManualClock
  readonly durableDir: string
  readonly store: DirDurableStore
  readonly durable: FaultyDurableStore
  replicaClock(): ManualClock
  /** Moves the store clock and every replica clock together, except the frozen ones. */
  advance(ms: number, frozen?: readonly ManualClock[]): void
  pathOf(key: string): string
}

function makeWorld(name: string): World {
  const dir = join(root, name)
  const storeClock = new ManualClock(1_000_000)
  const leases = new SqliteLeaseStore({ path: join(dir, 'leases.db'), nowMs: () => storeClock.nowMs() })
  const durableDir = join(dir, 'durable')
  const store = new DirDurableStore(durableDir)
  const clocks: ManualClock[] = []
  const world: World = {
    dir,
    leases,
    storeClock,
    durableDir,
    store,
    durable: new FaultyDurableStore(store),
    replicaClock(): ManualClock {
      const clock = new ManualClock(5_000)
      clocks.push(clock)
      return clock
    },
    advance(ms: number, frozen: readonly ManualClock[] = []): void {
      storeClock.advance(ms)
      for (const clock of clocks) if (!frozen.includes(clock)) clock.advance(ms)
    },
    pathOf(key: string): string {
      return join(durableDir, ...key.split('/'))
    },
  }
  worlds.push(world)
  return world
}

interface Replica {
  readonly id: string
  readonly clock: ManualClock
  readonly lease: TenantLease
  readonly context: EpochCopyContext
  readonly tenantRoot: string
  readonly restored: RestoreResult
  readonly ledger: StateLedger
}

async function acquire(world: World, id: string, clock: ManualClock, node: string = id): Promise<{ lease: TenantLease; context: EpochCopyContext; tenantRoot: string }> {
  const lease = await TenantLease.acquire({ store: world.leases, key: KEY, replicaId: id, ttlMs: TTL, marginMs: MARGIN, clock })
  const tenantRoot = tenantRootFor(join(world.dir, 'nodes', node), ORG, TENANT)
  return { lease, tenantRoot, context: { durable: world.durable, lease, organization: ORG, ledgerTenant: TENANT, tenantRoot } }
}

/** A replica taking over the tenant: acquire the lease at the next epoch, then restore the ledger. */
async function boot(world: World, id: string, options: { node?: string; clock?: ManualClock } = {}): Promise<Replica> {
  const clock = options.clock ?? world.replicaClock()
  const { lease, context, tenantRoot } = await acquire(world, id, clock, options.node)
  const restored = await restoreTenantLedger(context)
  openLedgers.push(restored.ledger)
  return { id, clock, lease, context, tenantRoot, restored, ledger: restored.ledger }
}

function appendEvents(ledger: StateLedger, prefix: string, count: number): string[] {
  const keys: string[] = []
  for (let index = 1; index <= count; index += 1) {
    const idemKey = `${prefix}-${index}`
    assert.notEqual(ledger.insertEvent({ actor: 'test', kind: 'tenant-state.test', payload: { index }, idemKey }), null)
    keys.push(idemKey)
  }
  return keys
}

function addWishes(ledger: StateLedger, count: number): void {
  for (let index = 1; index <= count; index += 1) ledger.appendWish({ name: `wish-${index}`, reason: 'test', conditions: { days: index } })
}

function idemKeys(ledger: StateLedger): string[] {
  return (ledger.db.prepare("SELECT idem_key FROM events WHERE kind = 'tenant-state.test' ORDER BY seq").all() as Array<{ idem_key: string }>).map(row => row.idem_key)
}

function eventRows(ledger: StateLedger): unknown[] {
  return ledger.db.prepare('SELECT seq, tenant_id, ts, actor, kind, subject_id, payload, idem_key, run_id FROM events ORDER BY seq').all()
}

function integrityOf(dbPath: string): string {
  const db = new Database(dbPath, { fileMustExist: true })
  try {
    return String(db.pragma('integrity_check', { simple: true }))
  } finally {
    db.close()
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

const prefixOf = (epoch: number): string => `${KEY}/e${String(epoch).padStart(8, '0')}`
const snapKey = (epoch: number, seq: number, extension: 'db' | 'json'): string => `${prefixOf(epoch)}/snap-${String(seq).padStart(6, '0')}.${extension}`
const baseKey = (epoch: number): string => `${prefixOf(epoch)}/base.json`

function flipByte(path: string, offset: number): void {
  const bytes = readFileSync(path)
  bytes[offset] ^= 0xff
  writeFileSync(path, bytes)
}

function assertFenced(promise: Promise<unknown>, reason: string): Promise<void> {
  return assert.rejects(() => promise, (error: unknown) => error instanceof FencedError && error.reason === reason)
}

try {
  // ---- K: the durable store contract ----------------------------------------------------
  console.log('-- K durable store')
  await check('K1 the directory store passes every DurableStore conformance check', async () => {
    assert.deepEqual(await runDurableStoreConformance(new DirDurableStore(join(root, 'conformance')), 'reference'), [])
  })

  await check('K2 the conformance checks can fail: an overwriting store and a directory-only listing store each turn named checks red', async () => {
    const overwriting = await runDurableStoreConformance(new OverwritingDurableStore(new DirDurableStore(join(root, 'broken-overwrite'))), 'overwriting')
    const names = overwriting.map(failure => failure.check)
    assert.ok(names.includes('put creates an absent key and never overwrites an existing one'), names.join(' | '))
    assert.ok(names.includes('sixteen concurrent puts of one key create it exactly once with intact bytes'), names.join(' | '))
    const directoryOnly = await runDurableStoreConformance(new DirectoryOnlyListDurableStore(new DirDurableStore(join(root, 'broken-listing'))), 'listing')
    assert.ok(directoryOnly.map(failure => failure.check).includes('list returns sorted keys under a prefix, including a partial last segment'), JSON.stringify(directoryOnly))
    const rawDelete = await runDurableStoreConformance(new RawPrefixDeleteDurableStore(new DirDurableStore(join(root, 'broken-delete')), join(root, 'broken-delete')), 'rawdelete')
    assert.ok(rawDelete.map(failure => failure.check).includes('delete takes whole segments only: a prefix that stops inside a name would also take its neighbours'), JSON.stringify(rawDelete))
  })

  // ---- S: publishing ------------------------------------------------------------------------
  console.log('-- S publishing')
  await check('S1 a snapshot lands in the holder epoch prefix with a manifest that matches the stored image; a second one takes the next sequence', async () => {
    const world = makeWorld('s1')
    const r1 = await boot(world, 'r1')
    assert.equal(r1.lease.epoch, 1)
    assert.equal(r1.restored.restoredFrom, null)
    appendEvents(r1.ledger, 'k', 5)
    addWishes(r1.ledger, 2)
    const first = await publishSnapshot(r1.context, { nowMs: () => 42 })
    assert.deepEqual({ epoch: first.epoch, seq: first.seq, tenant: first.tenant, createdAtMs: first.createdAtMs }, { epoch: 1, seq: 1, tenant: TENANT, createdAtMs: 42 })
    assert.equal(first.events, (r1.ledger.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n)
    const stored = await world.store.get(snapKey(1, 1, 'db'))
    assert.ok(stored)
    assert.equal(sha256(stored), first.sha256)
    assert.equal(stored.byteLength, first.bytes)
    assert.equal((await publishSnapshot(r1.context)).seq, 2)
    assert.deepEqual(await world.store.list(`${KEY}/`), [baseKey(1), snapKey(1, 1, 'db'), snapKey(1, 1, 'json'), snapKey(1, 2, 'db'), snapKey(1, 2, 'json')])
    assert.deepEqual(JSON.parse(Buffer.from(await world.store.get(baseKey(1)) as Uint8Array).toString('utf8')), { v: 1, epoch: 1, from: null })
  })

  await check('S2 the stored image is self-contained: rollback-journal header, no -wal or -shm needed', async () => {
    const world = makeWorld('s2')
    const r1 = await boot(world, 'r1')
    appendEvents(r1.ledger, 'k', 3)
    await publishSnapshot(r1.context)
    const stored = Buffer.from(await world.store.get(snapKey(1, 1, 'db')) as Uint8Array)
    assert.equal(stored.subarray(0, 15).toString('latin1'), 'SQLite format 3')
    assert.deepEqual([stored[18], stored[19]], [1, 1], 'file-format versions 1 and 1 mean no write-ahead log')
  })

  await check('S3 a fenced holder publishes nothing: refused at the first gate, and again at the gate right before the upload', async () => {
    const world = makeWorld('s3')
    const r1 = await boot(world, 'r1')
    appendEvents(r1.ledger, 'k', 2)
    const before = await world.store.list(`${KEY}/`)
    world.advance(TTL - MARGIN)
    await assertFenced(publishSnapshot(r1.context), 'lease_expired_locally')
    assert.deepEqual(await world.store.list(`${KEY}/`), before)

    const second = makeWorld('s3b')
    const tripping = new TrippingClock(5_000)
    const r2 = await boot(second, 'r1', { clock: tripping })
    appendEvents(r2.ledger, 'm', 2)
    const listed = await second.store.list(`${KEY}/`)
    tripping.arm(1, TTL)
    await assertFenced(publishSnapshot(r2.context), 'lease_expired_locally')
    assert.deepEqual(await second.store.list(`${KEY}/`), listed, 'the image was built but never uploaded: the gate right before the upload tripped')
  })

  await check('S4 publishing with a lease of another tenant is refused before anything is read', async () => {
    const world = makeWorld('s4')
    const clock = world.replicaClock()
    const otherKey = leaseKeyFor(ORG, OTHER_TENANT)
    const lease = await TenantLease.acquire({ store: world.leases, key: otherKey, replicaId: 'r1', ttlMs: TTL, marginMs: MARGIN, clock })
    const context: EpochCopyContext = { durable: world.durable, lease, organization: ORG, ledgerTenant: TENANT, tenantRoot: tenantRootFor(join(world.dir, 'nodes', 'r1'), ORG, TENANT) }
    await assert.rejects(() => publishSnapshot(context), RangeError)
    await assert.rejects(() => restoreTenantLedger(context), RangeError)
    await assert.rejects(() => forgetTenant(context), RangeError)
    assert.deepEqual(await world.store.list(`${ORG}/`), [])
  })

  await check('S5 publishing refuses a ledger that holds rows of another tenant, and uploads nothing', async () => {
    const world = makeWorld('s5')
    const r1 = await boot(world, 'r1')
    appendEvents(r1.ledger, 'k', 2)
    r1.ledger.db.prepare("INSERT INTO events (tenant_id, ts, actor, kind, subject_id, payload) VALUES (?, '2026-01-01T00:00:00.000Z', 'test', 'tenant-state.test', '', '{}')").run(OTHER_TENANT)
    const before = await world.store.list(`${KEY}/`)
    await assert.rejects(() => publishSnapshot(r1.context), (error: unknown) => error instanceof RestoreVerificationError && /another tenant/.test(error.message))
    assert.deepEqual(await world.store.list(`${KEY}/`), before)
  })

  // ---- V: image verification ---------------------------------------------------------------------
  console.log('-- V image verification')
  function ledgerImage(name: string, tenant: string, seed: (ledger: StateLedger) => void): string {
    const dir = join(root, 'images', name)
    const ledger = openDb(dir, tenant)
    seed(ledger)
    ledger.close()
    const image = join(root, 'images', `${name}.db`)
    mkdirSync(dirname(image), { recursive: true })
    copyFileSync(ledgerDbPath(dir), image)
    return image
  }

  await check('V1 a healthy image verifies and reports its event count and last sequence', () => {
    const image = ledgerImage('v1', TENANT, (ledger) => { appendEvents(ledger, 'k', 4); addWishes(ledger, 2) })
    const facts = verifyLedgerImage(image, TENANT)
    assert.ok(facts.events >= 6 && facts.maxEventSeq >= facts.events)
  })

  await check('V2 an image holding another tenant is refused, even though it is a perfectly healthy ledger', () => {
    const image = ledgerImage('v2', OTHER_TENANT, (ledger) => { appendEvents(ledger, 'o', 3) })
    assert.throws(() => verifyLedgerImage(image, TENANT), (error: unknown) => error instanceof RestoreVerificationError && /another tenant/.test(error.message))
    assert.ok(verifyLedgerImage(image, OTHER_TENANT).events >= 3, 'the same file verifies for its own tenant')
  })

  await check('V3 a file that is not a database is refused', () => {
    const image = ledgerImage('v3', TENANT, (ledger) => { appendEvents(ledger, 'k', 2) })
    flipByte(image, 0)
    assert.throws(() => verifyLedgerImage(image, TENANT), RestoreVerificationError)
  })

  await check('V4 an image whose projections disagree with its events is refused although SQLite finds it intact', () => {
    const image = ledgerImage('v4', TENANT, (ledger) => { addWishes(ledger, 3) })
    const raw = new Database(image)
    try {
      raw.prepare('DELETE FROM projection_items').run()
      raw.prepare('DELETE FROM projection_docs').run()
    } finally {
      raw.close()
    }
    assert.equal(integrityOf(image), 'ok')
    assert.throws(() => verifyLedgerImage(image, TENANT), (error: unknown) => error instanceof RestoreVerificationError && /projections/.test(error.message))
  })

  // ---- R: restoring --------------------------------------------------------------------------------
  console.log('-- R restoring')
  await check('R1 a new owner restores exactly what the old owner published: same event rows, same projections, integrity ok', async () => {
    const world = makeWorld('r1')
    const r1 = await boot(world, 'r1')
    appendEvents(r1.ledger, 'k', 12)
    addWishes(r1.ledger, 3)
    const manifest = await publishSnapshot(r1.context)
    const rows = eventRows(r1.ledger)
    const wishes = r1.ledger.readWishPool()
    assert.ok(wishes.length === 3)
    await r1.lease.release()
    r1.ledger.close()

    const r2 = await boot(world, 'r2')
    assert.equal(r2.lease.epoch, 2)
    assert.deepEqual(r2.restored.restoredFrom, { epoch: 1, seq: 1, sha256: manifest.sha256 })
    assert.deepEqual(r2.restored.facts, { events: manifest.events, maxEventSeq: manifest.maxEventSeq })
    assert.deepEqual(eventRows(r2.ledger), rows, 'the restored event sequence equals the source at the snapshot point')
    assert.deepEqual(r2.ledger.readWishPool(), wishes)
    assert.equal(integrityOf(ledgerDbPath(r2.tenantRoot)), 'ok')
    assert.equal(r2.ledger.tenant, TENANT)
    assert.deepEqual(JSON.parse(Buffer.from(await world.store.get(baseKey(2)) as Uint8Array).toString('utf8')), { v: 1, epoch: 2, from: { epoch: 1, seq: 1, sha256: manifest.sha256 } })
  })

  await check('R2 lineage: the newest epoch with evidence wins, and an epoch that only pinned a base hands that pin on', async () => {
    const world = makeWorld('r2')
    const r1 = await boot(world, 'r1')
    appendEvents(r1.ledger, 'a', 3)
    await publishSnapshot(r1.context)
    appendEvents(r1.ledger, 'b', 3)
    const e1s2 = await publishSnapshot(r1.context)
    await r1.lease.release()

    const r2 = await boot(world, 'r2')
    assert.equal(r2.restored.restoredFrom?.seq, 2)
    assert.equal(r2.restored.restoredFrom?.epoch, 1)
    appendEvents(r2.ledger, 'c', 4)
    const e2s1 = await publishSnapshot(r2.context)
    await r2.lease.release()

    const r3 = await boot(world, 'r3')
    assert.deepEqual(r3.restored.restoredFrom, { epoch: 2, seq: 1, sha256: e2s1.sha256 })
    assert.deepEqual(idemKeys(r3.ledger), ['a-1', 'a-2', 'a-3', 'b-1', 'b-2', 'b-3', 'c-1', 'c-2', 'c-3', 'c-4'])
    await r3.lease.release()

    const r4 = await boot(world, 'r4')
    assert.deepEqual(r4.restored.restoredFrom, { epoch: 2, seq: 1, sha256: e2s1.sha256 }, 'epoch 3 published nothing: epoch 4 follows the base that epoch 3 pinned')
    assert.notEqual(e1s2.sha256, e2s1.sha256)
  })

  await check('R3 a snapshot a superseded owner uploads after a newer epoch pinned its base is never restored', async () => {
    const world = makeWorld('r3')
    const frozen = world.replicaClock()
    const r1 = await boot(world, 'r1', { clock: frozen })
    appendEvents(r1.ledger, 'k', 3)
    const pinned = await publishSnapshot(r1.context)
    appendEvents(r1.ledger, 'late', 2)

    world.advance(TTL + 1, [frozen])
    const r2 = await boot(world, 'r2')
    assert.deepEqual(r2.restored.restoredFrom, { epoch: 1, seq: 1, sha256: pinned.sha256 })

    r1.lease.assertHeld()
    const late = await publishSnapshot(r1.context)
    assert.equal(late.epoch, 1)
    assert.equal(late.seq, 2, 'the paused owner passed its local gate and uploaded into its own, now dead, prefix')

    world.advance(TTL + 1, [frozen])
    const r3 = await boot(world, 'r3')
    assert.deepEqual(r3.restored.restoredFrom, { epoch: 1, seq: 1, sha256: pinned.sha256 }, 'epoch 2 pinned seq 1, so seq 2 is above the pin')
    assert.deepEqual(idemKeys(r3.ledger), ['k-1', 'k-2', 'k-3'])
  })

  await check('R4 a corrupt newest snapshot is passed over for the previous one, and the skip is reported', async () => {
    const world = makeWorld('r4')
    const r1 = await boot(world, 'r1')
    appendEvents(r1.ledger, 'a', 4)
    await publishSnapshot(r1.context)
    appendEvents(r1.ledger, 'b', 4)
    await publishSnapshot(r1.context)
    await r1.lease.release()
    const image = world.pathOf(snapKey(1, 2, 'db'))
    flipByte(image, Math.floor(readFileSync(image).length / 2))

    const r2 = await boot(world, 'r2')
    assert.equal(r2.restored.restoredFrom?.seq, 1)
    assert.equal(r2.restored.skipped.length, 1)
    assert.match(r2.restored.skipped[0], /e1\/snap-2: checksum differs from its manifest/)
    assert.deepEqual(idemKeys(r2.ledger), ['a-1', 'a-2', 'a-3', 'a-4'])
  })

  await check('R5 when every copy is corrupt the restore fails loudly, writes no base and serves nothing', async () => {
    const world = makeWorld('r5')
    const r1 = await boot(world, 'r1')
    appendEvents(r1.ledger, 'a', 3)
    await publishSnapshot(r1.context)
    await r1.lease.release()
    flipByte(world.pathOf(snapKey(1, 1, 'db')), 0)

    const { lease, context } = await acquire(world, 'r2', world.replicaClock())
    await assert.rejects(() => restoreTenantLedger(context), (error: unknown) => error instanceof RestoreVerificationError && error.skipped.length === 1)
    assert.deepEqual(await world.store.list(prefixOf(2)), [], 'no base was pinned for the failed epoch')
    await lease.release()
  })

  await check('R6 an image of another tenant under this tenant\'s key is refused although its checksum and manifest are valid', async () => {
    const world = makeWorld('r6')
    const image = ledgerImage('r6-foreign', OTHER_TENANT, (ledger) => { appendEvents(ledger, 'o', 3) })
    const bytes = readFileSync(image)
    const facts = new Database(image, { readonly: true })
    const counts = facts.prepare('SELECT COUNT(*) AS n, MAX(seq) AS m FROM events').get() as { n: number; m: number }
    facts.close()
    assert.equal(await world.store.putIfAbsent(snapKey(1, 1, 'db'), bytes), true)
    const manifest = { v: 1, tenant: TENANT, epoch: 1, seq: 1, sha256: sha256(bytes), bytes: bytes.byteLength, events: counts.n, maxEventSeq: counts.m, createdAtMs: 0 }
    assert.equal(await world.store.putIfAbsent(snapKey(1, 1, 'json'), Buffer.from(JSON.stringify(manifest))), true)

    const first = await acquire(world, 'r1', world.replicaClock())
    assert.equal(first.lease.epoch, 1)
    await first.lease.release()
    const second = await acquire(world, 'r2', world.replicaClock())
    assert.equal(second.lease.epoch, 2, 'the planted copy sits in epoch 1, below this holder')
    await assert.rejects(() => restoreTenantLedger(second.context), (error: unknown) => error instanceof RestoreVerificationError && /another tenant/.test(error.skipped.join(' ')))
    await second.lease.release()
  })

  await check('R7 a copy conflict is loud: a rogue base in this epoch, or a snapshot slot that is already taken', async () => {
    const world = makeWorld('r7')
    const { lease, context } = await acquire(world, 'r1', world.replicaClock())
    assert.equal(await world.store.putIfAbsent(baseKey(1), Buffer.from('{"rogue":true}')), true)
    await assert.rejects(() => restoreTenantLedger(context), CopyConflictError)
    await lease.release()

    const r2 = await boot(world, 'r2')
    appendEvents(r2.ledger, 'k', 2)
    world.durable.conflictNextPut = /snap-000001\.db$/
    await assert.rejects(() => publishSnapshot(r2.context), CopyConflictError)
  })

  await check('R8 epochs past eight digits are still found, so a flapping loop that burns epochs cannot hide the copies', async () => {
    const world = makeWorld('r8')
    const r1 = await boot(world, 'r1')
    appendEvents(r1.ledger, 'k', 3)
    const manifest = await publishSnapshot(r1.context)
    const image = await world.store.get(snapKey(1, 1, 'db')) as Uint8Array
    const far = 100_000_001
    const farKey = (name: string): string => `${KEY}/e${far}/${name}`
    assert.equal(await world.store.putIfAbsent(farKey('snap-000001.db'), image), true)
    assert.equal(await world.store.putIfAbsent(farKey('snap-000001.json'), Buffer.from(JSON.stringify({ ...manifest, epoch: far }))), true)
    const resolution = await resolveRestorePoint(world.store, KEY, TENANT, far + 1, 0, () => undefined)
    assert.equal(resolution.point?.manifest.epoch, far)
    assert.equal(resolution.point?.manifest.seq, 1)
  })

  // ---- X: takeover ---------------------------------------------------------------------------------------
  console.log('-- X takeover')
  await check('X1 a paused owner uploads after the takeover; the next owner still restores exactly the lineage of the one that took over', async () => {
    const world = makeWorld('x1')
    const frozen = world.replicaClock()
    const r1 = await boot(world, 'r1', { clock: frozen })
    const snapshotted = appendEvents(r1.ledger, 'k', 20)
    await publishSnapshot(r1.context)
    appendEvents(r1.ledger, 'u', 5)

    world.advance(TTL + 1, [frozen])
    const r2 = await boot(world, 'r2')
    assert.deepEqual(idemKeys(r2.ledger), snapshotted, 'the five unsnapshotted writes of the dead owner are the declared RPO')
    const taken = appendEvents(r2.ledger, 'v', 10)
    await publishSnapshot(r2.context)

    const late = await publishSnapshot(r1.context)
    assert.equal(late.events >= 25, true, 'the paused owner, blind to the takeover, uploaded all 25 of its events into its dead prefix')
    await assert.rejects(() => r1.lease.renew(), LeaseLostError, 'the lease store ends it the moment it asks')

    world.advance(TTL + 1, [frozen])
    const r3 = await boot(world, 'r3')
    assert.equal(r3.lease.epoch, 3)
    assert.deepEqual(idemKeys(r3.ledger), [...snapshotted, ...taken])
    assert.equal(idemKeys(r3.ledger).some(key => key.startsWith('u-')), false)
    assert.equal(integrityOf(ledgerDbPath(r3.tenantRoot)), 'ok')
  })

  await check('X2 a replica that takes the tenant again on the same node discards its own stale local file', async () => {
    const world = makeWorld('x2')
    const r1 = await boot(world, 'r1', { node: 'node-a' })
    const kept = appendEvents(r1.ledger, 'k', 6)
    await publishSnapshot(r1.context)
    appendEvents(r1.ledger, 'local-only', 4)
    assert.equal(idemKeys(r1.ledger).length, 10)

    world.advance(TTL + 1)
    const again = await boot(world, 'r1-again', { node: 'node-a' })
    assert.equal(again.lease.epoch, 2)
    assert.deepEqual(idemKeys(again.ledger), kept, 'only the durable copy is authoritative; the four local-only events are gone')
    assert.equal(integrityOf(ledgerDbPath(again.tenantRoot)), 'ok')
  })

  await check('X3 known limit of mode D-a: a frozen-clock owner can land a snapshot between its successor taking the lease and pinning its base, and that snapshot is restored', async () => {
    const world = makeWorld('x3')
    const frozen = world.replicaClock()
    const r1 = await boot(world, 'r1', { clock: frozen })
    appendEvents(r1.ledger, 'k', 3)
    await publishSnapshot(r1.context)
    appendEvents(r1.ledger, 'after-takeover', 2)

    world.advance(TTL + 1, [frozen])
    // The paused owner wakes with its clock where it left it and uploads while its successor is still restoring.
    world.durable.beforeNextList = async () => { await publishSnapshot(r1.context) }
    const r2 = await boot(world, 'r2')
    assert.equal(r2.lease.epoch, 2)
    assert.deepEqual(
      idemKeys(r2.ledger),
      ['k-1', 'k-2', 'k-3', 'after-takeover-1', 'after-takeover-2'],
      'KNOWN LIMIT: durability mode D-a cannot refuse an upload that lands before the base is pinned. FLIP: when the window is closed (the epoch-conditional append of mode D-b, or a seal on the previous epoch), expect only k-1..k-3 here and remove the limit from RFC section 4.3',
    )
    assert.equal(r2.restored.restoredFrom?.seq, 2)
  })

  // ---- F: forget ----------------------------------------------------------------------------------------------
  console.log('-- F forget')
  await check('F1 forget deletes every durable copy and the local files, raises the floor, and hands the lease back', async () => {
    const world = makeWorld('f1')
    const r1 = await boot(world, 'r1')
    appendEvents(r1.ledger, 'k', 5)
    await publishSnapshot(r1.context)
    await publishSnapshot(r1.context)
    assert.equal((await world.store.list(`${KEY}/`)).length, 5)
    r1.ledger.close()

    const outcome = await forgetTenant(r1.context)
    assert.deepEqual(outcome, { deletedObjects: 5, floor: 1 })
    assert.deepEqual(await world.store.list(`${KEY}/`), [])
    assert.equal(await world.store.get(snapKey(1, 1, 'db')), null)
    assert.throws(() => readFileSync(ledgerDbPath(r1.tenantRoot)), /ENOENT/)
    const record = await world.leases.read(KEY)
    assert.equal(record?.forgottenAtEpoch, 1)
    assert.ok(record && record.leaseUntilMs <= world.storeClock.nowMs(), 'the lease was handed back')
    assert.equal(r1.lease.isHeld(), false)

    const r2 = await boot(world, 'r2')
    assert.equal(r2.lease.epoch, 2)
    assert.equal(r2.restored.restoredFrom, null)
    assert.deepEqual(idemKeys(r2.ledger), [], 'the tenant starts from nothing')
  })

  await check('F2 a copy that a superseded owner uploads after the forget is masked by the floor and removed by the sweep', async () => {
    const world = makeWorld('f2')
    const frozen = world.replicaClock()
    const r1 = await boot(world, 'r1', { clock: frozen })
    appendEvents(r1.ledger, 'k', 5)
    const old = await publishSnapshot(r1.context)
    const oldImage = Buffer.from(await world.store.get(snapKey(1, 1, 'db')) as Uint8Array)
    const oldManifest = Buffer.from(await world.store.get(snapKey(1, 1, 'json')) as Uint8Array)
    r1.ledger.close()

    world.advance(TTL + 1, [frozen])
    const r2 = await boot(world, 'r2')
    r2.ledger.close()
    await forgetTenant(r2.context)
    assert.equal(old.epoch, 1)

    // The paused owner of epoch 1 wakes after the forget and re-creates its snapshot.
    assert.equal(await world.store.putIfAbsent(snapKey(1, 1, 'db'), oldImage), true)
    assert.equal(await world.store.putIfAbsent(snapKey(1, 1, 'json'), oldManifest), true)
    assert.equal((await world.store.list(`${KEY}/`)).length, 2)

    const r3 = await boot(world, 'r3')
    assert.equal(r3.lease.epoch, 3)
    assert.equal(r3.lease.forgottenAtEpoch, 2)
    assert.equal(r3.restored.restoredFrom, null, 'the floor masks every copy at or below epoch 2')
    assert.deepEqual(idemKeys(r3.ledger), [])
    assert.equal(await sweepMaskedCopies(world.store, KEY, r3.lease.forgottenAtEpoch), 2)
    assert.deepEqual(await world.store.list(`${KEY}/e00000001/`), [])
  })

  await check('F3 a fenced holder cannot forget, and a refused forget deletes nothing', async () => {
    const world = makeWorld('f3')
    const r1 = await boot(world, 'r1')
    appendEvents(r1.ledger, 'k', 2)
    await publishSnapshot(r1.context)
    const before = await world.store.list(`${KEY}/`)
    world.advance(TTL - MARGIN)
    await assertFenced(forgetTenant(r1.context), 'lease_expired_locally')
    assert.deepEqual(await world.store.list(`${KEY}/`), before)
    assert.equal((await world.leases.read(KEY))?.forgottenAtEpoch, 0)
  })

  // ---- I: faults ---------------------------------------------------------------------------------------------------
  console.log('-- I faults')
  await check('I1 a durable store outage fails publishing and restoring with a typed error, loses no local write, and publishing resumes with the next sequence', async () => {
    const world = makeWorld('i1')
    const r1 = await boot(world, 'r1')
    appendEvents(r1.ledger, 'k', 3)
    await publishSnapshot(r1.context)
    world.durable.down = true
    appendEvents(r1.ledger, 'm', 3)
    await assert.rejects(() => publishSnapshot(r1.context), DurableStoreUnavailableError)
    assert.equal(idemKeys(r1.ledger).length, 6, 'writes are acknowledged locally; replication lag simply grows')
    world.durable.down = false
    assert.equal((await publishSnapshot(r1.context)).seq, 2)
    await r1.lease.release()

    world.durable.down = true
    const { lease, context } = await acquire(world, 'r2', world.replicaClock())
    await assert.rejects(() => restoreTenantLedger(context), DurableStoreUnavailableError)
    world.durable.down = false
    assert.deepEqual((await world.store.list(prefixOf(2))), [], 'the failed restore pinned no base')
    await lease.release()
  })

  await check('I2 a crash between an image and its manifest leaves an orphan that restores ignore and the next publish skips past', async () => {
    const world = makeWorld('i2')
    const r1 = await boot(world, 'r1')
    appendEvents(r1.ledger, 'a', 3)
    await publishSnapshot(r1.context)
    appendEvents(r1.ledger, 'b', 3)
    world.durable.failNextPut = /snap-000002\.json$/
    await assert.rejects(() => publishSnapshot(r1.context), DurableStoreUnavailableError)
    assert.ok(await world.store.get(snapKey(1, 2, 'db')), 'the image was uploaded before the failure')
    assert.equal(await world.store.get(snapKey(1, 2, 'json')), null, 'and its manifest was not')
    assert.equal((await publishSnapshot(r1.context)).seq, 3, 'the orphan slot is not reused')
    await r1.lease.release()

    const r2 = await boot(world, 'r2')
    assert.equal(r2.restored.restoredFrom?.seq, 3)
    assert.deepEqual(r2.restored.skipped, [], 'an orphan image is not a corrupt snapshot')
    assert.equal(idemKeys(r2.ledger).length, 6)
  })

  console.log(`tenant-state-copies-tests: ${passed} checks passed`)
} finally {
  for (const ledger of openLedgers) {
    try { ledger.close() } catch { /* already closed */ }
  }
  for (const world of worlds) world.leases.close()
  rmSync(root, { recursive: true, force: true })
}
