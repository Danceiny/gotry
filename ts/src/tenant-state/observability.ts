/**
 * The in-process observability skeleton of the AaaS state layer (A3 of issue #674, docs/rfc/aaas-rfc.md §4.5).
 *
 * One hub subscribes to everything the layer already reports — every router event, the typed refusals of the
 * write gate, a quota meter's refusals, the open-slot gauge, and the time a durable-copy publish took, which
 * the caller measures because the durable store carries no time metadata — and keeps per-type counters a
 * snapshot reads back. There is no exporter and no third-party dependency: the records stay in the process,
 * and every key in them is an HMAC id or an organization id the layer already uses, so nothing personal
 * crosses it.
 *
 * The option surfaces of the layer take one callback each (`onEvent`, `onFence`, the meter's `onRefusal`),
 * so the hub hands out functions that fit them, and `combineObservers` merges the hub with a deployment's
 * own observer without changing any signature. A broken observer never changes the outcome: what a subscriber
 * throws is dropped, and what the layer hands the hub is counted before anything is dispatched.
 */

import { QUOTA_DIMENSIONS, type QuotaDimension, type QuotaRefusalEvent } from '../tenant-seam/quotas.ts'
import { systemMonotonicClock, type FenceEvent, type MonotonicClock } from './tenant-lease.ts'
import type { RouterEvent } from './tenant-router.ts'

type RouterEventType = RouterEvent['type']
type FenceReason = FenceEvent['reason']

const ROUTER_EVENT_TYPES: readonly RouterEventType[] = ['acquired', 'restored', 'renewed', 'renew_failed', 'snapshot', 'snapshot_failed', 'lost', 'drain_timeout', 'released']
const FENCE_REASONS: readonly FenceReason[] = ['lease_released', 'lease_lost', 'lease_expired_locally']

function zeroCounts<K extends string>(keys: readonly K[]): Record<K, number> {
  const counts = {} as Record<K, number>
  for (const key of keys) counts[key] = 0
  return counts
}

/** One record on the subscription stream. Each kind is also a bucket in `snapshot()`. */
export type ObservabilityRecord =
  | { readonly kind: 'router_event'; readonly event: RouterEvent }
  | { readonly kind: 'fence'; readonly fence: FenceEvent }
  | { readonly kind: 'quota_refusal'; readonly refusal: QuotaRefusalEvent }
  | { readonly kind: 'snapshot_publish'; readonly sample: SnapshotPublishSample }
  | { readonly kind: 'open_slots'; readonly count: number }

export type ObservabilitySubscriber = (record: ObservabilityRecord) => void

/** How long one durable copy took to publish, measured by the caller around `publishSnapshot`. */
export interface SnapshotPublishSample {
  readonly key: string
  readonly epoch: number
  /** The seq of the copy that landed, or `null` when the publish failed. */
  readonly seq: number | null
  /** Monotonic milliseconds from opening the measurement to settling it. */
  readonly lagMs: number
}

export interface SnapshotPublishStats {
  /** Settled measurements, failed ones included. */
  readonly count: number
  readonly failed: number
  readonly lastLagMs: number | null
  readonly maxLagMs: number
}

export interface ObservabilitySnapshot {
  readonly events: Readonly<Record<RouterEventType, number>>
  readonly fences: Readonly<Record<FenceReason, number>>
  readonly refusals: Readonly<Record<QuotaDimension, number>>
  /** The open-slot gauge, as last set by `recordOpenSlots`; zero until then. */
  readonly openSlots: number
  readonly publish: SnapshotPublishStats
}

export interface ObservabilityHubOptions {
  /** Drives the publish-lag measurements. Suites drive it by hand. */
  readonly clock?: MonotonicClock
}

export class ObservabilityHub {
  private readonly clock: MonotonicClock
  private readonly subscribers = new Set<ObservabilitySubscriber>()
  private readonly events = zeroCounts(ROUTER_EVENT_TYPES)
  private readonly fences = zeroCounts(FENCE_REASONS)
  private readonly refusals = zeroCounts(QUOTA_DIMENSIONS)
  private openSlots = 0
  private publishCount = 0
  private publishFailed = 0
  private publishLastLagMs: number | null = null
  private publishMaxLagMs = 0

  constructor(options: ObservabilityHubOptions = {}) {
    this.clock = options.clock ?? systemMonotonicClock
  }

  /** Fits `TenantRouterOptions.onEvent`. */
  readonly onEvent = (event: RouterEvent): void => {
    this.events[event.type] += 1
    this.dispatch({ kind: 'router_event', event })
  }

  /** Fits `TenantRouterOptions.onFence` and `TenantLeaseOptions.onFence`. */
  readonly onFence = (fence: FenceEvent): void => {
    this.fences[fence.reason] += 1
    this.dispatch({ kind: 'fence', fence })
  }

  /** Fits `TenantQuotasOptions.onRefusal`. */
  readonly onQuotaRefusal = (refusal: QuotaRefusalEvent): void => {
    this.refusals[refusal.dimension] += 1
    this.dispatch({ kind: 'quota_refusal', refusal })
  }

  /** Sets the open-slot gauge; a deployment feeds it `TenantRouter.openCount()` where it already polls. */
  recordOpenSlots(count: number): void {
    this.openSlots = count
    this.dispatch({ kind: 'open_slots', count })
  }

  /**
   * Opens a publish-lag measurement to close around one `publishSnapshot`: the durable store carries no time
   * metadata, so the caller measures. Settle with the seq of the copy that landed, or `null` when it failed.
   */
  startSnapshotPublish(key: string, epoch: number): { settle(seq: number | null): void } {
    const startedAt = this.clock.nowMs()
    return {
      settle: (seq: number | null): void => {
        const lagMs = Math.max(0, this.clock.nowMs() - startedAt)
        this.publishCount += 1
        if (seq === null) this.publishFailed += 1
        this.publishLastLagMs = lagMs
        if (lagMs > this.publishMaxLagMs) this.publishMaxLagMs = lagMs
        this.dispatch({ kind: 'snapshot_publish', sample: { key, epoch, seq, lagMs } })
      },
    }
  }

  /** Subscribes to every record; the returned function unsubscribes. A subscriber that throws is dropped for that record only. */
  subscribe(subscriber: ObservabilitySubscriber): () => void {
    this.subscribers.add(subscriber)
    return () => {
      this.subscribers.delete(subscriber)
    }
  }

  snapshot(): ObservabilitySnapshot {
    return {
      events: { ...this.events },
      fences: { ...this.fences },
      refusals: { ...this.refusals },
      openSlots: this.openSlots,
      publish: { count: this.publishCount, failed: this.publishFailed, lastLagMs: this.publishLastLagMs, maxLagMs: this.publishMaxLagMs },
    }
  }

  private dispatch(record: ObservabilityRecord): void {
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber(record)
      } catch {
        // A broken observer must never change the outcome.
      }
    }
  }
}

/** Merges observers for one single-callback option slot (`onEvent`, `onFence`, `onRefusal`): every one given is called, what one throws never reaches the others or the layer. `undefined` slots are skipped. */
export function combineObservers<T>(...observers: ReadonlyArray<((value: T) => void) | undefined>): (value: T) => void {
  const known = observers.filter((observer): observer is (value: T) => void => typeof observer === 'function')
  return (value: T): void => {
    for (const observer of known) {
      try {
        observer(value)
      } catch {
        // Ignored on purpose.
      }
    }
  }
}
