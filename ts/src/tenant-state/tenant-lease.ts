/**
 * The holder side of a tenant lease (docs/rfc/aaas-rfc.md §4.2, items 2, 4 and 6).
 *
 * A replica owns a tenant between a successful `acquire` and the first of: an
 * explicit `release`, a refused `renew`, or the local fence deadline. The deadline
 * is measured on the replica's monotonic clock from BEFORE the request was sent,
 * so the round trip, the store's clock and any skew between the two clocks only
 * make the holder stop earlier:
 *
 *     fence = sentAt + grantedTtl - margin
 *
 * `assertHeld()` is the synchronous gate of the write path. A write is
 * acknowledged only if the gate passes before it and after it.
 *
 * What the local fence cannot see is a frozen clock: a process paused between its
 * check and its acknowledgement. That case is covered by the durable layer, whose
 * copies are scoped by epoch, not by this class.
 */

import { performance } from 'node:perf_hooks'
import { FencedError, LeaseLostError, type FenceReason } from './errors.ts'
import { assertLeaseTtl, type LeaseRecord, type LeaseStore } from './lease-store.ts'

/**
 * A monotonic clock owned by the replica. Production uses `performance.now()`, which
 * does not jump with wall-clock changes. It stops while a host is suspended, which
 * is the frozen-clock case above.
 */
export interface MonotonicClock {
  nowMs(): number
}

export const systemMonotonicClock: MonotonicClock = { nowMs: () => performance.now() }

export interface TenantLeaseOptions {
  readonly store: LeaseStore
  readonly key: string
  /** Unique per process incarnation: a restarted replica is a different holder and waits for expiry or release. */
  readonly replicaId: string
  readonly ttlMs: number
  /** The agreed clock-skew and scheduling bound; the holder stops this long before the store would admit anyone else. */
  readonly marginMs: number
  readonly clock?: MonotonicClock
}

type HolderState = 'held' | 'released' | 'lost'

export class TenantLease {
  readonly key: string
  readonly replicaId: string
  readonly epoch: number
  private readonly store: LeaseStore
  private readonly clock: MonotonicClock
  private readonly ttlMs: number
  private readonly marginMs: number
  private fenceAtMs: number
  private state: HolderState = 'held'
  private tail: Promise<void> = Promise.resolve()

  private constructor(options: TenantLeaseOptions, clock: MonotonicClock, record: LeaseRecord, fenceAtMs: number) {
    this.key = options.key
    this.replicaId = options.replicaId
    this.epoch = record.epoch
    this.store = options.store
    this.clock = clock
    this.ttlMs = options.ttlMs
    this.marginMs = options.marginMs
    this.fenceAtMs = fenceAtMs
  }

  /**
   * @throws LeaseHeldError when another holder has an unexpired lease
   * @throws LeaseStoreUnavailableError when the store cannot be reached
   */
  static async acquire(options: TenantLeaseOptions): Promise<TenantLease> {
    assertLeaseTtl(options.ttlMs)
    if (!Number.isInteger(options.marginMs) || options.marginMs < 0 || options.marginMs >= options.ttlMs) {
      throw new RangeError(`lease margin must be an integer within [0, ttl), got ${String(options.marginMs)} for ttl ${options.ttlMs}`)
    }
    const clock = options.clock ?? systemMonotonicClock
    const sentAt = clock.nowMs()
    const grant = await options.store.acquire(options.key, options.replicaId, options.ttlMs)
    if (grant.record.owner !== options.replicaId || grant.record.key !== options.key) {
      throw new LeaseLostError(`${options.key}: the store granted the lease to ${grant.record.owner}`)
    }
    const lease = new TenantLease(options, clock, grant.record, sentAt + grant.ttlMs - options.marginMs)
    if (lease.fenceAtMs <= clock.nowMs()) {
      // The round trip consumed the usable part of the lease; hand it back instead of holding an already fenced epoch.
      await lease.release().catch(() => undefined)
      throw new LeaseLostError(`${options.key}: the grant of epoch ${grant.record.epoch} was consumed by the round trip`)
    }
    return lease
  }

  /** The synchronous gate of the write path. */
  assertHeld(): void {
    if (this.state === 'released') throw this.fenced('lease_released')
    if (this.state === 'lost') throw this.fenced('lease_lost')
    if (this.clock.nowMs() >= this.fenceAtMs) throw this.fenced('lease_expired_locally')
  }

  isHeld(): boolean {
    try {
      this.assertHeld()
      return true
    } catch {
      return false
    }
  }

  /** Milliseconds until the local fence; zero or negative once fenced. */
  remainingMs(): number {
    return this.fenceAtMs - this.clock.nowMs()
  }

  /**
   * Extends the lease; the epoch stays. A refusal is terminal for this holder. Any other
   * failure leaves the deadline untouched: the holder fails closed when it passes, and a
   * later successful renewal resumes it, because an unchanged epoch means nobody else held it.
   */
  renew(): Promise<void> {
    return this.serialize(async () => {
      if (this.state !== 'held') throw this.fenced(this.state === 'released' ? 'lease_released' : 'lease_lost')
      const sentAt = this.clock.nowMs()
      try {
        const grant = await this.store.renew(this.key, this.replicaId, this.epoch, this.ttlMs)
        if (grant.record.epoch !== this.epoch || grant.record.owner !== this.replicaId) {
          throw new LeaseLostError(`${this.key}: renewal answered for epoch ${grant.record.epoch}`)
        }
        this.fenceAtMs = Math.max(this.fenceAtMs, sentAt + grant.ttlMs - this.marginMs)
      } catch (error) {
        if (error instanceof LeaseLostError) this.state = 'lost'
        throw error
      }
    })
  }

  /**
   * Graceful handoff step: stop acknowledging first, then tell the store, so the next owner
   * can start at once. If the store cannot be reached the lease simply expires; the error is
   * rethrown so the caller knows the handoff degraded to waiting out the TTL.
   */
  release(): Promise<void> {
    return this.serialize(async () => {
      if (this.state !== 'held') return
      this.state = 'released'
      try {
        await this.store.release(this.key, this.replicaId, this.epoch)
      } catch (error) {
        if (error instanceof LeaseLostError) return
        throw error
      }
    })
  }

  /** Marks every durable copy up to this epoch dead (forget). Requires a lease that is provably held. */
  async markForgotten(): Promise<LeaseRecord> {
    this.assertHeld()
    return this.store.markForgotten(this.key, this.replicaId, this.epoch)
  }

  private fenced(reason: FenceReason): FencedError {
    return new FencedError(reason, this.key, this.epoch)
  }

  /** Renewals and the release of one holder run one at a time, in call order. */
  private serialize<T>(step: () => Promise<T>): Promise<T> {
    const run = this.tail.then(step, step)
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }
}
