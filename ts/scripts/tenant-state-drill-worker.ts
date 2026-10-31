/**
 * Child process of tenant-state-drill-tests.ts: one replica serving two tenants through a TenantRouter.
 *
 * argv: <state root> <lease db> <durable dir> <log dir> <replica id> <organization> <tenant a> <tenant b>
 *
 * The replica keeps trying to own both tenants. For each tenant it holds, it writes one numbered event at a
 * time and publishes a snapshot every 120 ms. It logs, before and after every step, what it is about to do and
 * what was acknowledged, in a file that survives its own death, so the drill can compare the final ledger with
 * what the replica believed. On SIGTERM it hands every tenant off gracefully and exits; while it does, a consumer that
 * keeps the ledger it was handed (a booking runtime does) goes on writing through it, inside a `runAsync` bracket the
 * drain has to wait for, and then tries once more after the bracket, when the view has to refuse.
 *
 * TENANT_DRILL_SLOW_PUT_MS makes the object store slow to take an image, as a real one can be.
 */

import { closeSync, openSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { DirDurableStore, type DurableStore } from '../src/tenant-state/durable-store.ts'
import { LeaseHeldError } from '../src/tenant-state/errors.ts'
import { SqliteLeaseStore } from '../src/tenant-state/lease-store.ts'
import { TenantRouter, type TenantHandle } from '../src/tenant-state/tenant-router.ts'

const [stateRoot, leaseDb, durableDir, logDir, replicaId, organization, tenantA, tenantB] = process.argv.slice(2)

const SNAPSHOT_EVERY_MS = 120
const RETRY_AFTER_HELD_MS = 150
const DRAIN_WRITER_MS = 150
const SLOW_PUT_MS = Number(process.env.TENANT_DRILL_SLOW_PUT_MS ?? 0)

/** The reference store with a delay before every image it takes, so an upload is a window and not an instant. */
class SlowImages implements DurableStore {
  constructor(private readonly inner: DurableStore, private readonly ms: number) {}

  async putIfAbsent(key: string, bytes: Uint8Array): Promise<boolean> {
    if (key.endsWith('.db')) await sleep(this.ms)
    return this.inner.putIfAbsent(key, bytes)
  }

  get(key: string): Promise<Uint8Array | null> { return this.inner.get(key) }
  list(prefix: string): Promise<string[]> { return this.inner.list(prefix) }
  deletePrefix(prefix: string): Promise<number> { return this.inner.deletePrefix(prefix) }
}

const log = openSync(join(logDir, `${replicaId}.jsonl`), 'a')
function record(entry: Record<string, unknown>): void {
  writeSync(log, `${JSON.stringify({ ...entry, replica: replicaId, wall: Date.now() })}\n`)
}

const router = new TenantRouter({
  stateRoot,
  replicaId,
  leases: new SqliteLeaseStore({ path: leaseDb }),
  durable: SLOW_PUT_MS > 0 ? new SlowImages(new DirDurableStore(durableDir), SLOW_PUT_MS) : new DirDurableStore(durableDir),
  ttlMs: 1_500,
  marginMs: 400,
  autoRenew: true,
  renewEveryMs: 300,
  onEvent: (event) => { record({ t: 'event', event: event.type, key: event.key, epoch: event.epoch, flushed: 'flushed' in event ? event.flushed : undefined }) },
})

interface Seat {
  readonly label: string
  readonly tenant: string
  handle: TenantHandle | null
  epoch: number
  next: number
  nextTryAt: number
  lastSnapshotAt: number
}

const seats: Seat[] = [
  { label: 'a', tenant: tenantA, handle: null, epoch: 0, next: 1, nextTryAt: 0, lastSnapshotAt: 0 },
  { label: 'b', tenant: tenantB, handle: null, epoch: 0, next: 1, nextTryAt: 0, lastSnapshotAt: 0 },
]

let stopping = false
process.on('SIGTERM', () => { stopping = true })
record({ t: 'start', pid: process.pid })

while (!stopping) {
  for (const seat of seats) {
    if (!seat.handle?.isOpen()) {
      seat.handle = null
      if (Date.now() < seat.nextTryAt) continue
      try {
        const handle = await router.openTenant(organization, seat.tenant)
        seat.handle = handle
        seat.epoch = handle.epoch
        seat.next = 1
        seat.lastSnapshotAt = Date.now()
        record({ t: 'open', tenant: seat.label, epoch: handle.epoch, from: handle.restoredFrom })
      } catch (error) {
        seat.nextTryAt = Date.now() + RETRY_AFTER_HELD_MS
        if (!(error instanceof LeaseHeldError)) record({ t: 'open-failed', tenant: seat.label, code: (error as { code?: string }).code ?? String(error) })
        continue
      }
    }
    const handle = seat.handle as TenantHandle
    const n = seat.next
    try {
      let at = 0
      handle.run((ledger) => {
        at = Date.now()
        ledger.insertEvent({ actor: 'drill', kind: 'tenant-state.drill', payload: { n }, idemKey: `${seat.label}:${seat.epoch}:${n}` })
      })
      record({ t: 'ack', tenant: seat.label, epoch: seat.epoch, n, at })
      seat.next += 1
    } catch (error) {
      record({ t: 'refused', tenant: seat.label, epoch: seat.epoch, n, code: (error as { code?: string }).code ?? String(error) })
      await sleep(20)
      continue
    }
    if (Date.now() - seat.lastSnapshotAt >= SNAPSHOT_EVERY_MS) {
      // Nothing else writes in this process, so the image holds exactly the writes acknowledged so far.
      const covered = seat.next - 1
      record({ t: 'snap-start', tenant: seat.label, epoch: seat.epoch, covered })
      try {
        const manifest = await handle.snapshot()
        record({ t: 'snap', tenant: seat.label, epoch: seat.epoch, seq: manifest.seq, covered })
      } catch (error) {
        record({ t: 'snap-failed', tenant: seat.label, epoch: seat.epoch, code: (error as { code?: string }).code ?? String(error) })
      }
      seat.lastSnapshotAt = Date.now()
    }
  }
  await sleep(4)
}

/**
 * The long-lived consumer. Inside a `runAsync` bracket it writes through the ledger for a while, which the drain has to
 * wait for and the final image has to hold; once the bracket is over it tries the view again, which has to be refused
 * as soon as the image is being taken. Every acknowledged write is logged like the loop's own, so the verification
 * counts them the same way.
 */
async function drainingWriter(seat: Seat): Promise<void> {
  const handle = seat.handle as TenantHandle
  const note = (entry: Record<string, unknown>): void => record({ ...entry, tenant: seat.label, epoch: seat.epoch, via: 'view' })
  const until = Date.now() + DRAIN_WRITER_MS
  try {
    await handle.runAsync(async (ledger) => {
      while (Date.now() < until) {
        const n = seat.next
        ledger.insertEvent({ actor: 'drill', kind: 'tenant-state.drill', payload: { n }, idemKey: `${seat.label}:${seat.epoch}:${n}` })
        note({ t: 'ack', n, at: Date.now() })
        seat.next += 1
        await sleep(3)
      }
    })
  } catch (error) {
    note({ t: 'refused', n: seat.next, code: (error as { code?: string }).code ?? String(error) })
    return
  }
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const n = seat.next
    try {
      handle.ledger.insertEvent({ actor: 'drill', kind: 'tenant-state.drill', payload: { n }, idemKey: `${seat.label}:${seat.epoch}:${n}` })
      note({ t: 'ack', n, at: Date.now() })
      seat.next += 1
    } catch (error) {
      note({ t: 'refused', n, code: (error as { code?: string }).code ?? String(error) })
      return
    }
    await sleep(2)
  }
}

record({ t: 'draining' })
const writers = seats.filter(seat => seat.handle?.isOpen()).map(seat => drainingWriter(seat))
const failed = await router.close()
await Promise.all(writers)
record({ t: 'closed', failed })
closeSync(log)
process.exit(0)
