/**
 * The observability skeleton of the AaaS state layer (A3 of #674, docs/rfc/aaas-rfc.md §4.5).
 *
 * In-process only: one hub subscribes to everything the layer already reports — all nine router events, typed
 * fence refusals, quota 429 refusals (dimension and retry hint, never a plaintext subject), the open-slot gauge,
 * and the lag of a durable-copy publish measured by the caller — and keeps counters a snapshot reads back.
 * Keys are the HMAC ids the layer already uses; no personal data; zero third-party dependencies.
 *
 * Offline and deterministic: the clock is a number the suite moves by hand, the lease store is a SQLite file,
 * the durable store is a directory, and the quota meter runs on a hand-driven clock. Three checks wait on real
 * timers (a drain timeout, a background renewal), a few hundred milliseconds each. No network, no model, and
 * the founder's runtime state root is never opened.
 *
 *   H  the hub: router events of every type counted and streamed, a drain timeout, a lost lease, a refused
 *      renewal, publish lag with a failed publish counted, the open-slot gauge.
 *   Q  quota refusals: dimension and retry hint observed where the meter refuses; a broken observer changes
 *      nothing.
 *   S  the single-callback slots: combineObservers feeds a hub and a deployment's own observer, skips empty
 *      slots, one observer's throw never blocks the others, unsubscribe stops the stream.
 *   P  privacy: everything the hub emitted is keyed by the HMAC lease key and names nobody.
 *
 * Run: cd ts && npx tsx scripts/aaas-observability-tests.ts
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

import { loadPriceTable } from '../src/llm-price-table.ts'
import { DirDurableStore } from '../src/tenant-state/durable-store.ts'
import { DrainTimeoutError, FencedError, LeaseLostError } from '../src/tenant-state/errors.ts'
import { deriveLedgerTenantId, leaseKeyFor } from '../src/tenant-state/ids.ts'
import { SqliteLeaseStore } from '../src/tenant-state/lease-store.ts'
import { ObservabilityHub, combineObservers, type ObservabilityRecord } from '../src/tenant-state/observability.ts'
import { TenantRouter, type RouterEvent, type TenantHandle } from '../src/tenant-state/tenant-router.ts'
import { deriveSeamTenant, QuotaExceededError, StaticOrganizationKeyring, TenantQuotas, type QuotaPolicy, type SeamTenant } from '../src/tenant-seam/index.ts'
import { FaultyDurableStore, ManualClock } from './tenant-state-test-kit.ts'

const TS_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const TABLE = loadPriceTable(join(TS_ROOT, 'data', 'llm-price-table.json'))
const MODEL = 'deepseek-v4-flash'
const KEYRING = new StaticOrganizationKeyring({ acme: Buffer.alloc(32, 7) })
const ORG = 'acme'
const ORG_KEY = Buffer.alloc(32, 5)
const ISSUER = 'https://idp.example/acme'
const TENANT_A = deriveLedgerTenantId(ORG_KEY, ISSUER, 'alice')
const KEY_A = leaseKeyFor(ORG, TENANT_A)
const TENANT_C = deriveLedgerTenantId(ORG_KEY, ISSUER, 'carol')
const KEY_C = leaseKeyFor(ORG, TENANT_C)
const TTL = 10_000
const MARGIN = 2_000

const POLICY: QuotaPolicy = {
  tenant: {
    concurrentTurns: 2,
    turns: { limit: 3, windowMs: 1_000 },
    llm: { tokens: 1_000_000, costUsd: 0.5, windowMs: 10_000 },
    bridgeJobs: { limit: 2, windowMs: 1_000 },
    ledgerBytes: 1_000_000,
  },
  organization: {
    concurrentTurns: 3,
    turns: { limit: 5, windowMs: 1_000 },
    llm: { tokens: 2_000_000, costUsd: 1, windowMs: 10_000 },
    bridgeJobs: { limit: 3, windowMs: 1_000 },
    ledgerBytes: 2_000_000,
  },
  globalConcurrentTurns: 4,
  unprovenInvocation: { tokens: 10_000, costUsd: 0.05 },
}

let passed = 0
async function check(label: string, assertion: () => void | Promise<void>): Promise<void> {
  await assertion()
  passed += 1
  console.log(`  ok - ${label}`)
}

const root = mkdtempSync(join(tmpdir(), 'gotry-aaas-observability-'))
const cleanups: Array<() => void | Promise<void>> = []

const storeClock = new ManualClock(1_000_000)
const leases = new SqliteLeaseStore({ path: join(root, 'leases.db'), nowMs: () => storeClock.nowMs() })
const durable = new FaultyDurableStore(new DirDurableStore(join(root, 'durable')))
cleanups.push(() => leases.close())

interface Replica {
  readonly router: TenantRouter
  readonly clock: ManualClock | undefined
  readonly hub: ObservabilityHub
  readonly hubClock: ManualClock
  readonly records: ObservabilityRecord[]
}

function replica(id: string, options: { autoRenew?: boolean; renewEveryMs?: number; drainTimeoutMs?: number; extraEvents?: RouterEvent[]; useRealClock?: boolean } = {}): Replica {
  const clock = options.useRealClock === true ? undefined : new ManualClock(5_000)
  const hubClock = new ManualClock(100)
  const hub = new ObservabilityHub({ clock: hubClock })
  const records: ObservabilityRecord[] = []
  hub.subscribe((record) => { records.push(record) })
  const extra = options.extraEvents
  const router = new TenantRouter({
    stateRoot: join(root, 'nodes', id),
    replicaId: id,
    leases,
    durable,
    ttlMs: TTL,
    marginMs: MARGIN,
    clock,
    autoRenew: options.autoRenew ?? false,
    renewEveryMs: options.renewEveryMs,
    drainTimeoutMs: options.drainTimeoutMs,
    onEvent: extra ? combineObservers(hub.onEvent, (event) => { extra.push(event) }) : hub.onEvent,
    onFence: hub.onFence,
  })
  cleanups.push(() => router.close().then(() => undefined))
  return { router, clock, hub, hubClock, records }
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

function tenantOf(organization: string, subject: string): SeamTenant {
  return deriveSeamTenant({ organization, issuer: `https://idp.example/${organization}`, subject, scope: 'booking:read' }, KEYRING)
}

function refusalOf(action: () => unknown): QuotaExceededError {
  try {
    action()
  } catch (error) {
    assert.ok(error instanceof QuotaExceededError, `expected a QuotaExceededError, got ${String(error)}`)
    return error
  }
  throw new assert.AssertionError({ message: 'expected the quota meter to refuse' })
}

function keysOfRecord(record: ObservabilityRecord): string[] {
  switch (record.kind) {
    case 'router_event': return [record.event.key]
    case 'fence': return [record.fence.key]
    case 'snapshot_publish': return [record.sample.key]
    default: return []
  }
}

try {
  // ---- H: the hub ---------------------------------------------------------------------------
  console.log('-- H the hub')
  await check('H1 the router events of one life are counted per type and streamed, a second observer on the same slot sees them too, and the counter buckets cover all nine types', async () => {
    const extra: RouterEvent[] = []
    const node = replica('replica-life', { extraEvents: extra })
    const handle = await node.router.openTenant(ORG, TENANT_A)
    write(handle, 'k', 2)
    await handle.snapshot()
    durable.down = true
    await handle.snapshot().catch(() => undefined)
    durable.down = false
    await handle.renew()
    await handle.handoff()
    const counts = node.hub.snapshot().events
    assert.deepEqual({ acquired: counts.acquired, restored: counts.restored, renewed: counts.renewed, snapshot: counts.snapshot, snapshot_failed: counts.snapshot_failed, released: counts.released }, { acquired: 1, restored: 1, renewed: 1, snapshot: 2, snapshot_failed: 1, released: 1 })
    assert.deepEqual([counts.lost, counts.renew_failed, counts.drain_timeout], [0, 0, 0], 'nothing else happened')
    assert.deepEqual(Object.keys(counts).sort(), ['acquired', 'drain_timeout', 'lost', 'released', 'renew_failed', 'renewed', 'restored', 'snapshot', 'snapshot_failed'], 'a bucket for every router event type')
    const events = node.records.filter((record): record is Extract<ObservabilityRecord, { kind: 'router_event' }> => record.kind === 'router_event')
    assert.deepEqual(events.map(record => record.event.type), ['acquired', 'restored', 'snapshot', 'snapshot_failed', 'renewed', 'snapshot', 'released'])
    assert.deepEqual(extra.map(event => event.type), events.map(record => record.event.type), 'the deployment\'s own observer saw the same events')
  })

  await check('H2 a drain that gives up is a drain_timeout record, and the tenant serves again', async () => {
    const node = replica('replica-drain', { drainTimeoutMs: 30 })
    const handle = await node.router.openTenant(ORG, TENANT_A)
    let finish: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { finish = resolve })
    const work = handle.runAsync(async () => {
      await gate
      return 'late'
    })
    await assert.rejects(() => handle.handoff(), DrainTimeoutError)
    assert.equal(node.hub.snapshot().events.drain_timeout, 1)
    assert.equal(handle.isOpen(), true, 'the tenant serves again after the drain gave up')
    finish()
    assert.equal(await work, 'late')
    await handle.handoff()
  })

  await check('H3 a lease lost to a takeover is a lost record with the key and the epoch', async () => {
    const a = replica('replica-losing')
    const b = replica('replica-taking')
    const handle = await a.router.openTenant(ORG, TENANT_C)
    write(handle, 'k', 1)
    storeClock.advance(TTL + 1)
    await b.router.openTenant(ORG, TENANT_C)
    await assert.rejects(() => handle.renew(), LeaseLostError)
    assert.equal(a.hub.snapshot().events.lost, 1)
    const lost = a.records.filter((record): record is Extract<ObservabilityRecord, { kind: 'router_event' }> => record.kind === 'router_event' && record.event.type === 'lost')
    assert.deepEqual(lost.map(record => record.event), [{ type: 'lost', key: KEY_C, epoch: 1 }])
    assert.throws(() => handle.run(() => 1), FencedError)
    const fencesAfterLoss = a.records.filter((record): record is Extract<ObservabilityRecord, { kind: 'fence' }> => record.kind === 'fence')
    assert.deepEqual(fencesAfterLoss.map(record => record.fence.reason), ['lease_lost'], 'a call fenced after the loss is recorded with the loss reason')
  })

  await check('H4 a renewal the store refuses as expired ends the tenure as lost without a renew_failed, and a renewal that throws is a renew_failed record', async () => {
    const node = replica('replica-renew', { autoRenew: true, renewEveryMs: 20, useRealClock: true })
    const handle = await node.router.openTenant(ORG, TENANT_A)
    storeClock.advance(TTL + 1)
    await sleep(400)
    const counts = node.hub.snapshot().events
    assert.equal(counts.lost, 1, 'the expired lease ended the tenure at renewal')
    assert.equal(counts.renew_failed, 0, 'an expired lease is lost, not a failed renewal')
    assert.equal(handle.isOpen(), false)
    const lost = node.records.filter((record): record is Extract<ObservabilityRecord, { kind: 'router_event' }> => record.kind === 'router_event' && record.event.type === 'lost')
    assert.deepEqual(lost.map(record => record.event), [{ type: 'lost', key: KEY_A, epoch: 3 }])

    const hubClock2 = new ManualClock(0)
    const hub2 = new ObservabilityHub({ clock: hubClock2 })
    const store2 = new SqliteLeaseStore({ path: join(root, 'h4b-leases.db'), nowMs: () => 5_000 })
    const router2 = new TenantRouter({
      stateRoot: join(root, 'h4b'), replicaId: 'replica-renew-throw', leases: store2, durable: new FaultyDurableStore(new DirDurableStore(join(root, 'h4b-durable'))),
      ttlMs: TTL, marginMs: MARGIN, autoRenew: true, renewEveryMs: 20, onEvent: hub2.onEvent, onFence: hub2.onFence,
    })
    cleanups.push(() => router2.close().then(() => undefined, () => undefined))
    const handle2 = await router2.openTenant(ORG, TENANT_A)
    assert.equal(handle2.epoch, 1)
    store2.close()
    await sleep(300)
    const counts2 = hub2.snapshot().events
    assert.ok(counts2.renew_failed >= 1, `renew failures on a closed store: ${counts2.renew_failed}`)
  })

  await check('H5 the publish-lag hook measures what the caller closes around publishSnapshot, a failed publish included', async () => {
    const node = replica('replica-publish')
    const handle = await node.router.openTenant(ORG, TENANT_A)
    write(handle, 'h5', 1)
    const first = node.hub.startSnapshotPublish(KEY_A, handle.epoch)
    node.hubClock.advance(500)
    const manifest = await handle.snapshot()
    first.settle(manifest.seq)
    const failed = node.hub.startSnapshotPublish(KEY_A, handle.epoch)
    durable.down = true
    node.hubClock.advance(250)
    await handle.snapshot().catch(() => undefined)
    failed.settle(null)
    durable.down = false
    assert.deepEqual(node.hub.snapshot().publish, { count: 2, failed: 1, lastLagMs: 250, maxLagMs: 500 })
    const samples = node.records.filter((record): record is Extract<ObservabilityRecord, { kind: 'snapshot_publish' }> => record.kind === 'snapshot_publish')
    assert.deepEqual(samples.map(record => record.sample.seq), [manifest.seq, null])
    assert.deepEqual(samples.map(record => record.sample.key), [KEY_A, KEY_A])
    await handle.handoff()
  })

  await check('H6 the open-slot gauge is fed from openCount and rides the subscription stream', async () => {
    const node = replica('replica-gauge')
    const handle = await node.router.openTenant(ORG, TENANT_A)
    node.hub.recordOpenSlots(node.router.openCount())
    assert.equal(node.hub.snapshot().openSlots, 1)
    const gauges = node.records.filter((record): record is Extract<ObservabilityRecord, { kind: 'open_slots' }> => record.kind === 'open_slots')
    assert.deepEqual(gauges.map(gauge => gauge.count), [1])
    await handle.handoff()
    node.hub.recordOpenSlots(node.router.openCount())
    assert.equal(node.hub.snapshot().openSlots, 0)
  })

  // ---- Q: quota refusals -----------------------------------------------------------------
  console.log('-- Q quota refusals')
  await check('Q1 a refusal reaches the hub with scope, dimension, limit and retry hint, and the counters bucket by dimension', () => {
    const hub = new ObservabilityHub({ clock: new ManualClock(0) })
    const records: ObservabilityRecord[] = []
    hub.subscribe((record) => { records.push(record) })
    let now = 0
    const quotas = new TenantQuotas({ policy: POLICY, priceTable: TABLE, model: MODEL, clock: () => now, onRefusal: hub.onQuotaRefusal })
    const tenant = tenantOf('acme', 'quota-user')
    for (let index = 0; index < 3; index += 1) quotas.admitTurn(tenant).release()
    refusalOf(() => quotas.admitTurn(tenant))
    assert.deepEqual(hub.snapshot().refusals, { concurrent_turns: 0, turn_rate: 1, llm_tokens: 0, llm_cost: 0, bridge_jobs: 0, ledger_size: 0 })
    const refusals = records.filter((record): record is Extract<ObservabilityRecord, { kind: 'quota_refusal' }> => record.kind === 'quota_refusal')
    assert.equal(refusals.length, 1)
    assert.deepEqual(refusals[0]!.refusal, { scope: 'tenant', dimension: 'turn_rate', limit: 3, retryAfterMs: 1_000 })
  })

  await check('Q2 an observer that throws changes nothing: the typed error is identical and the account still counts the refusal', () => {
    let now = 0
    const quotas = new TenantQuotas({
      policy: POLICY, priceTable: TABLE, model: MODEL, clock: () => now,
      onRefusal: () => { throw new Error('broken observer') },
    })
    const tenant = tenantOf('acme', 'broken-observer')
    for (let index = 0; index < 3; index += 1) quotas.admitTurn(tenant).release()
    const error = refusalOf(() => quotas.admitTurn(tenant))
    assert.deepEqual([error.scope, error.dimension, error.limit, error.retryAfterMs], ['tenant', 'turn_rate', 3, 1_000])
    assert.equal(quotas.snapshot().tenants.find(entry => entry.key === `${ORG}/${tenant.ledgerTenant}`)?.rejected.turn_rate, 1)
  })

  // ---- S: the single-callback slots ----------------------------------------------------------
  console.log('-- S the single-callback slots')
  await check('S1 combineObservers feeds every observer on one slot, skips empty ones, and one that throws never blocks the others', () => {
    const seen: string[] = []
    const merged = combineObservers<string>(
      undefined,
      (value) => { throw new Error(`boom on ${value}`) },
      (value) => { seen.push(value) },
    )
    merged('x')
    assert.deepEqual(seen, ['x'])
  })

  await check('S2 a subscriber that throws is dropped for that record: the others still see it and the counters still count', () => {
    const hub = new ObservabilityHub()
    const records: ObservabilityRecord[] = []
    hub.subscribe(() => { throw new Error('broken subscriber') })
    hub.subscribe((record) => { records.push(record) })
    hub.onEvent({ type: 'acquired', key: KEY_A, epoch: 1 })
    assert.equal(records.length, 1)
    assert.equal(hub.snapshot().events.acquired, 1)
  })

  await check('S3 the returned function unsubscribes: the listener hears nothing more', () => {
    const hub = new ObservabilityHub()
    let seen = 0
    const off = hub.subscribe(() => { seen += 1 })
    hub.onEvent({ type: 'acquired', key: KEY_A, epoch: 1 })
    assert.equal(seen, 1)
    off()
    hub.onEvent({ type: 'released', key: KEY_A, epoch: 1, flushed: true })
    assert.equal(seen, 1, 'the unsubscribed listener heard nothing more')
  })

  // ---- P: privacy ------------------------------------------------------------------------------
  console.log('-- P privacy')
  await check('P1 everything the hub emitted is keyed by the HMAC lease key and names nobody', async () => {
    const node = replica('replica-p')
    const quotas = new TenantQuotas({ policy: POLICY, priceTable: TABLE, model: MODEL, clock: () => 0, onRefusal: node.hub.onQuotaRefusal })
    const handle = await node.router.openTenant(ORG, TENANT_A)
    write(handle, 'secret-looking-key', 1)
    await handle.snapshot()
    await handle.renew()
    assert.ok(node.clock, 'P1 uses the manual clock')
    node.clock.advance(TTL - MARGIN)
    assert.throws(() => handle.run(() => 1), FencedError)
    await handle.renew()
    quotas.admitTurn(tenantOf('acme', 'quota-subject')).release()
    await handle.handoff()
    const records = node.records
    assert.ok(records.length >= 8, `${records.length} records`)
    for (const record of records) {
      for (const key of keysOfRecord(record)) assert.equal(key, KEY_A)
    }
    const fences = records.filter((record): record is Extract<ObservabilityRecord, { kind: 'fence' }> => record.kind === 'fence')
    assert.deepEqual(fences.map(fence => fence.fence), [{ key: KEY_A, epoch: handle.epoch, reason: 'lease_expired_locally' }])
    assert.doesNotMatch(JSON.stringify(records), /alice|quota-subject|idp\.example|secret-looking-key/)
  })

  await check('F2 a fence after an abandon is recorded with the release reason, and the fences bucket carries all three reasons', async () => {
    const node = replica('replica-fence-release')
    const handle = await node.router.openTenant(ORG, TENANT_A)
    await handle.abandon()
    assert.throws(() => handle.run(() => 1), FencedError)
    const fences = node.records.filter((record): record is Extract<ObservabilityRecord, { kind: 'fence' }> => record.kind === 'fence')
    assert.deepEqual(fences.map(record => record.fence.reason), ['lease_released'])
    const snapshot = node.hub.snapshot().fences
    assert.deepEqual(snapshot, { lease_released: 1, lease_lost: 0, lease_expired_locally: 0 }, 'a bucket for every fence reason')
  })

  console.log(`aaas-observability-tests: ${passed} checks passed`)
} finally {
  for (const cleanup of [...cleanups].reverse()) {
    try { await cleanup() } catch { /* best effort */ }
  }
  rmSync(root, { recursive: true, force: true })
}
