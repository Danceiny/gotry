/**
 * The tenant router of the AaaS state layer (docs/rfc/aaas-rfc.md §4.2 items 5 and 6, §4.4).
 *
 * One replica asks the router for a tenant by `(organization, ledger tenant)`. The router acquires the
 * lease, restores the ledger from the newest verified durable copy, and returns a handle. The handle is
 * the only way to the tenant's ledger, and it is tenant-bound: no method takes a tenant id.
 *
 * A write is acknowledged only if the lease is provably held before the work and after it. `run` and
 * `runAsync` bracket the work, and the ledger the handle exposes is a guarded view, so a long-lived
 * consumer that keeps the ledger (a booking runtime, say) is stopped the same way: every call, including
 * every prepared statement, first proves the lease. A write that was applied locally but not acknowledged
 * is harmless, because a later owner restores from the durable copy and local files never survive.
 *
 * Reads go to the owner. A request for a tenant another replica owns fails with `LeaseHeldError`, whose
 * record names the owner; forwarding to it belongs to the deployment layer (A3).
 */

import type Database from 'better-sqlite3'
import type { StateLedger } from '../state-ledger.ts'
import type { DurableStore } from './durable-store.ts'
import {
  discardLocalLedger,
  forgetTenant,
  publishSnapshot,
  restoreTenantLedger,
  type EpochCopyContext,
  type RestoreResult,
  type SnapshotManifest,
  type SnapshotRef,
} from './epoch-copies.ts'
import { DrainTimeoutError, FencedError, LeaseLostError, ReplicaAtCapacityError, RouterClosedError, TenantDrainingError } from './errors.ts'
import { leaseKeyFor, tenantRootFor } from './ids.ts'
import type { LeaseStore } from './lease-store.ts'
import { systemMonotonicClock, TenantLease, type MonotonicClock } from './tenant-lease.ts'

// ---- guarded views ----------------------------------------------------------------

type Callable = (...args: unknown[]) => unknown
type Gate = () => void

/** An iterator that proves the lease on every step. Closing it is cleanup and always allowed. */
function guardedIterator(iterator: Iterator<unknown>, assertHeld: Gate): IterableIterator<unknown> {
  const guarded: IterableIterator<unknown> = {
    next: () => {
      assertHeld()
      return iterator.next()
    },
    return: (value?: unknown) => iterator.return?.(value) ?? { done: true, value },
    [Symbol.iterator]: () => guarded,
  }
  return guarded
}

/**
 * A prepared statement behind a gate. This is a facade, not a proxy: better-sqlite3 statements carry read-only
 * properties, among them a raw `database` handle, that a proxy would have to return unchanged and so would leak.
 */
function guardedStatement(statement: Database.Statement, assertHeld: Gate): object {
  const target = statement as unknown as Record<string, Callable>
  const facade: Record<string, unknown> = {}
  for (const name of ['run', 'get', 'all', 'columns']) {
    facade[name] = (...args: unknown[]) => {
      assertHeld()
      return Reflect.apply(target[name], statement, args)
    }
  }
  facade.iterate = (...args: unknown[]) => {
    assertHeld()
    return guardedIterator(Reflect.apply(target.iterate, statement, args) as Iterator<unknown>, assertHeld)
  }
  for (const name of ['bind', 'pluck', 'expand', 'raw', 'safeIntegers']) {
    facade[name] = (...args: unknown[]) => {
      assertHeld()
      Reflect.apply(target[name], statement, args)
      return facade
    }
  }
  for (const name of ['reader', 'readonly', 'source', 'busy']) {
    Object.defineProperty(facade, name, { get: () => (statement as unknown as Record<string, unknown>)[name], enumerable: true })
  }
  Object.defineProperty(facade, 'database', { get: () => guardedDatabase(statement.database, assertHeld), enumerable: true })
  return facade
}

/** A transaction function behind a gate, with its `.deferred`, `.immediate` and `.exclusive` variants. Its raw `database` handle is not passed on. */
function guardedTransaction(transaction: Callable, assertHeld: Gate): Callable {
  const gate = (fn: Callable): Callable => function (this: unknown, ...args: unknown[]) {
    assertHeld()
    return Reflect.apply(fn, this, args)
  }
  const guarded = gate(transaction)
  for (const mode of ['default', 'deferred', 'immediate', 'exclusive']) {
    const variant = (transaction as unknown as Record<string, unknown>)[mode]
    if (typeof variant === 'function') Object.defineProperty(guarded, mode, { value: gate(variant as Callable), enumerable: true })
  }
  return guarded
}

/** The database of a ledger: every method proves the lease first, and statements and transactions come back guarded. */
function guardedDatabase(db: Database.Database, assertHeld: Gate): Database.Database {
  const guarded: Database.Database = new Proxy(db, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      // The router owns the connection its own writes, its snapshots and its handoff depend on; a consumer cannot close it.
      if (property === 'close') return () => guarded
      return (...args: unknown[]) => {
        assertHeld()
        const result = Reflect.apply(value as Callable, target, args)
        // `exec`, `defaultSafeIntegers`, `function`, `loadExtension` and the like return the database itself; what a
        // caller chains onto it has to stay behind the gate.
        if (result === target) return guarded
        if (property === 'prepare') return guardedStatement(result as Database.Statement, assertHeld)
        if (property === 'transaction') return guardedTransaction(result as Callable, assertHeld)
        return result
      }
    },
  })
  return guarded
}

/**
 * The ledger as a handle exposes it. The router owns its lifecycle, so `close` does nothing here, and the view is
 * read-only: nothing a consumer does to it changes the ledger the router holds.
 */
function guardedLedger(ledger: StateLedger, assertHeld: Gate): StateLedger {
  return new Proxy(ledger, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target)
      if (property === 'db') return guardedDatabase(value as Database.Database, assertHeld)
      if (typeof value !== 'function') return value
      if (property === 'close') return () => undefined
      return (...args: unknown[]) => {
        assertHeld()
        return Reflect.apply(value as Callable, target, args)
      }
    },
    // `Object.getOwnPropertyDescriptor(ledger, 'db').value` is a second way to the database that `get` does not cover.
    getOwnPropertyDescriptor(target, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property)
      if (property === 'db' && descriptor && 'value' in descriptor) return { ...descriptor, value: guardedDatabase(descriptor.value as Database.Database, assertHeld) }
      return descriptor
    },
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
  })
}

// ---- events and options ---------------------------------------------------------------

/** What a router reports about its tenants. Keys are `<organization>/<hmac tenant id>`: no personal data. */
export type RouterEvent =
  | { readonly type: 'acquired'; readonly key: string; readonly epoch: number }
  | { readonly type: 'restored'; readonly key: string; readonly epoch: number; readonly from: SnapshotRef | null; readonly skipped: number }
  | { readonly type: 'renewed'; readonly key: string; readonly epoch: number }
  | { readonly type: 'renew_failed'; readonly key: string; readonly epoch: number; readonly code: string }
  | { readonly type: 'snapshot'; readonly key: string; readonly epoch: number; readonly seq: number }
  | { readonly type: 'snapshot_failed'; readonly key: string; readonly epoch: number; readonly code: string }
  | { readonly type: 'lost'; readonly key: string; readonly epoch: number }
  | { readonly type: 'drain_timeout'; readonly key: string; readonly epoch: number; readonly inFlight: number }
  | { readonly type: 'released'; readonly key: string; readonly epoch: number; readonly flushed: boolean }

export interface TenantRouterOptions {
  readonly stateRoot: string
  /** Unique per process incarnation. It is what the lease record shows as the owner, so it should also say where the replica can be reached. */
  readonly replicaId: string
  readonly leases: LeaseStore
  readonly durable: DurableStore
  readonly ttlMs?: number
  readonly marginMs?: number
  readonly clock?: MonotonicClock
  /** Renew in the background every `renewEveryMs`. Suites that drive time by hand turn it off. */
  readonly autoRenew?: boolean
  readonly renewEveryMs?: number
  /** Publish a snapshot this often while serving. Zero (the default) leaves snapshots to the caller and to handoff. */
  readonly snapshotEveryMs?: number
  /**
   * The most tenants this replica holds at once, counting those still opening and those draining. A tenant over it is
   * refused with `ReplicaAtCapacityError` before its lease or any file is touched. Each open tenant holds about three file
   * descriptors (docs/ops/aaas-capacity-baseline.md), so a deployment sets this from its descriptor limit; unset, as
   * before, there is no cap and the limit is whatever the process runs out of first.
   */
  readonly maxOpenTenants?: number
  /**
   * The longest a handoff waits for calls that were already running (`runAsync`) to finish. The lease is renewed through the
   * drain, so a call that never returns would otherwise hold the tenant on this replica for ever and keep `close()` waiting. When
   * it passes, `handoff()` rejects with `DrainTimeoutError`, the tenant serves again and a `drain_timeout` event says so. Set it
   * below the termination grace period of the deployment. Default 120 s.
   */
  readonly drainTimeoutMs?: number
  /** Tenants `close()` hands off at the same time, so that one stuck tenant does not hold the ones behind it. Default 8. */
  readonly closeConcurrency?: number
  readonly onEvent?: (event: RouterEvent) => void
}

export interface TenantHandle {
  readonly organization: string
  readonly ledgerTenant: string
  readonly epoch: number
  /** The snapshot this epoch started from, or `null` for an empty ledger. */
  readonly restoredFrom: SnapshotRef | null
  /** A guarded view: every call proves the lease first. */
  readonly ledger: StateLedger
  isOpen(): boolean
  /** Runs `work` on the ledger and returns its result only if the lease is held before and after. */
  run<T>(work: (ledger: StateLedger) => T): T
  runAsync<T>(work: (ledger: StateLedger) => Promise<T>): Promise<T>
  renew(): Promise<void>
  snapshot(): Promise<SnapshotManifest>
  /** Graceful handoff: drain, publish a final snapshot, release the lease. If the flush fails the handle keeps serving. */
  handoff(): Promise<void>
  /** Stops without a flush and releases the lease at once. Writes after the last snapshot are given up. */
  abandon(): Promise<void>
  /** Forget: every durable copy and the local files go, then the lease is handed back. */
  forget(): Promise<{ readonly deletedObjects: number; readonly floor: number }>
}

interface HandleDeps {
  readonly key: string
  readonly organization: string
  readonly ledgerTenant: string
  readonly lease: TenantLease
  readonly context: EpochCopyContext
  readonly restored: RestoreResult
  readonly autoRenew: boolean
  readonly renewEveryMs: number
  readonly snapshotEveryMs: number
  readonly drainTimeoutMs: number
  emit(event: RouterEvent): void
  detach(handle: TenantHandle): void
}

/** A refused renewal, or a lease that was released or lost, ends the tenure for good. A merely expired local deadline does not: a renewal can resume it. */
function endsTenure(error: unknown): boolean {
  return error instanceof LeaseLostError || (error instanceof FencedError && error.reason !== 'lease_expired_locally')
}

type TenantState = 'serving' | 'draining' | 'flushing' | 'forgetting' | 'closed'

/** A promise in disguise: anything with a `then` function. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === 'object' || typeof value === 'function') && value !== null && typeof (value as { then?: unknown }).then === 'function'
}

class OpenTenant implements TenantHandle {
  readonly organization: string
  readonly ledgerTenant: string
  readonly epoch: number
  readonly restoredFrom: SnapshotRef | null
  readonly ledger: StateLedger
  private readonly raw: StateLedger
  private readonly deps: HandleDeps
  // `draining`: new work is refused and what already runs may finish. `flushing` begins when the drain is over and the
  // final image is about to be taken: from then on a write through the ledger could not be in the image, so the view is
  // closed to every call until the tenant is closed or serving again. `forgetting`: the tenant is being deleted; nothing is
  // served, but the lease is renewed until the deletion has handed it back.
  private state: TenantState = 'serving'
  private inFlight = 0
  private readonly idleWaiters = new Set<() => void>()
  private renewTimer: ReturnType<typeof setTimeout> | null = null
  private renewTicking = false
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null
  private snapshotTail: Promise<unknown> = Promise.resolve()
  private snapshotQueued = 0

  constructor(deps: HandleDeps) {
    this.deps = deps
    this.organization = deps.organization
    this.ledgerTenant = deps.ledgerTenant
    this.epoch = deps.lease.epoch
    this.restoredFrom = deps.restored.restoredFrom
    this.raw = deps.restored.ledger
    // Work that began before a handoff may finish and new work is refused at `run`; the view itself stays open while
    // the drain waits, so writes made in that time are in the final image, and closes when the image is taken.
    this.ledger = guardedLedger(this.raw, () => this.assertViewUsable())
  }

  isOpen(): boolean {
    return this.state === 'serving'
  }

  isDraining(): boolean {
    return this.state === 'draining' || this.state === 'flushing'
  }

  /** The state as it is now, for a check after an await: another call may have changed it, which a narrowed `this.state` or getter does not show. */
  private phaseNow(): TenantState {
    return this.state
  }

  /** Called once by the router, after the handle is registered. */
  begin(): void {
    this.scheduleRenewal()
    this.scheduleSnapshot()
  }

  run<T>(work: (ledger: StateLedger) => T): T {
    this.assertServing()
    const result = work(this.ledger)
    if (isThenable(result)) {
      // The callback is already running, and what is left of it is outside the lease bracket and the drain. Nobody awaits
      // the promise it returned, so its failure is taken here instead of becoming an unhandled rejection.
      void Promise.resolve(result).catch(() => undefined)
      throw new TypeError('TenantHandle.run takes a synchronous callback: use runAsync for work that awaits')
    }
    this.deps.lease.assertHeld()
    return result
  }

  async runAsync<T>(work: (ledger: StateLedger) => Promise<T>): Promise<T> {
    this.assertServing()
    this.inFlight += 1
    try {
      const result = await work(this.ledger)
      this.deps.lease.assertHeld()
      return result
    } finally {
      this.inFlight -= 1
      if (this.inFlight === 0) this.wakeIdleWaiters()
    }
  }

  async renew(): Promise<void> {
    try {
      await this.deps.lease.renew()
      this.emit({ type: 'renewed', key: this.deps.key, epoch: this.epoch })
    } catch (error) {
      if (endsTenure(error)) this.markLost()
      throw error
    }
  }

  snapshot(): Promise<SnapshotManifest> {
    this.snapshotQueued += 1
    const run = this.snapshotTail.then(() => this.publishNow(), () => this.publishNow())
    this.snapshotTail = run.catch(() => undefined).finally(() => { this.snapshotQueued -= 1 })
    return run
  }

  async handoff(): Promise<void> {
    if (this.state === 'closed') return
    if (this.state !== 'serving') throw new TenantDrainingError(this.deps.key)
    this.setState('draining')
    // Only the periodic snapshots stop. The lease keeps being renewed through the drain and the final upload: both can
    // take longer than a lease, and a handoff that let it lapse would flush into a prefix no successor reads.
    this.stopSnapshotTimer()
    try {
      const drained = await this.drain()
      if (drained === 'timeout') {
        // The lease is renewed through the drain, so a call that never returns would hold the tenant here for ever.
        this.emit({ type: 'drain_timeout', key: this.deps.key, epoch: this.epoch, inFlight: this.inFlight })
        throw new DrainTimeoutError(this.deps.key, this.inFlight, this.deps.drainTimeoutMs)
      }
      // Closed meanwhile (abandoned, forgotten, lease lost): there is nothing left to flush, and a closed handle stays closed.
      if (this.phaseNow() !== 'draining') throw new TenantDrainingError(this.deps.key)
      this.setState('flushing')
      await this.snapshot()
      // The same if it happened while the image was uploading. A forget deletes what this flush uploaded and needs the lease
      // to finish; an abandon or a lost lease has ended the tenure. Releasing now, and reporting a flush, would be false.
      if (this.phaseNow() !== 'flushing') throw new TenantDrainingError(this.deps.key)
    } catch (error) {
      // A flush that failed for want of a store leaves the tenant serving; one that failed because the lease is gone ends it.
      if (endsTenure(error)) this.markLost()
      else if (this.isDraining()) {
        this.setState('serving')
        this.begin()
      }
      throw error
    }
    await this.finish(true)
  }

  async abandon(): Promise<void> {
    // A forget that is under way owns the end of the tenure: it hands the lease back itself.
    if (this.state === 'closed' || this.state === 'forgetting') return
    this.stopTimers()
    await this.finish(false)
  }

  async forget(): Promise<{ readonly deletedObjects: number; readonly floor: number }> {
    this.deps.lease.assertHeld()
    if (this.state === 'forgetting') throw new TenantDrainingError(this.deps.key)
    // Nothing is served from here on, but the lease keeps being renewed: waiting for an upload under way can take longer than
    // the lease, and a forget that let it lapse could no longer delete.
    this.stopSnapshotTimer()
    this.setState('forgetting')
    this.closeLedger()
    this.deps.detach(this)
    try {
      // An upload already under way would land after the deletion and leave the tenant's image in the store, where nothing
      // would look for it again. Snapshots queued behind it refuse to start now that the tenant is being forgotten.
      await this.snapshotTail.catch(() => undefined)
      const outcome = await forgetTenant(this.deps.context)
      this.emit({ type: 'released', key: this.deps.key, epoch: this.epoch, flushed: false })
      return outcome
    } finally {
      this.setState('closed')
      this.stopTimers()
    }
  }

  private assertServing(): void {
    if (this.state === 'serving') {
      this.deps.lease.assertHeld()
      return
    }
    // A lease that is gone says so first. With the lease still held, a handoff, a forget or an abandon is under way.
    if (this.state === 'closed') this.deps.lease.assertHeld()
    throw new TenantDrainingError(this.deps.key)
  }

  /** The gate of the ledger a consumer holds: the lease, and a view that is open only while the tenant is served or draining. */
  private assertViewUsable(): void {
    this.deps.lease.assertHeld()
    if (this.state !== 'serving' && this.state !== 'draining') throw new TenantDrainingError(this.deps.key)
  }

  private setState(next: TenantState): void {
    this.state = next
    // Whoever waits for the in-flight work to end is also waiting for the tenant to stay a tenant: closing it ends the wait.
    if (next === 'closed' || next === 'forgetting') this.wakeIdleWaiters()
  }

  private emit(event: RouterEvent): void {
    try {
      this.deps.emit(event)
    } catch {
      // A broken observer must never take a tenant down.
    }
  }

  private async publishNow(): Promise<SnapshotManifest> {
    // A snapshot queued before a forget, an abandon or a lost lease must not start after it.
    if (this.state === 'closed' || this.state === 'forgetting') throw new TenantDrainingError(this.deps.key)
    try {
      const manifest = await publishSnapshot(this.deps.context)
      this.emit({ type: 'snapshot', key: this.deps.key, epoch: this.epoch, seq: manifest.seq })
      return manifest
    } catch (error) {
      this.emit({ type: 'snapshot_failed', key: this.deps.key, epoch: this.epoch, code: (error as { code?: string }).code ?? 'unknown' })
      throw error
    }
  }

  /**
   * Waits until the calls that were running are done, the tenant is closed, or `drainTimeoutMs` has passed. The timer
   * keeps the process alive on purpose: a graceful stop that gave up the moment nothing else was pending would exit
   * without flushing.
   */
  private drain(): Promise<'idle' | 'closed' | 'timeout'> {
    if (this.inFlight === 0) return Promise.resolve('idle')
    return new Promise((resolve) => {
      const end = (outcome: 'idle' | 'closed' | 'timeout'): void => {
        clearTimeout(timer)
        this.idleWaiters.delete(wake)
        resolve(outcome)
      }
      const wake = (): void => end(this.state === 'draining' ? 'idle' : 'closed')
      const timer = setTimeout(() => end('timeout'), this.deps.drainTimeoutMs)
      this.idleWaiters.add(wake)
    })
  }

  private wakeIdleWaiters(): void {
    for (const wake of [...this.idleWaiters]) wake()
  }

  private closeLedger(): void {
    try {
      this.raw.close()
    } catch {
      // Already closed.
    }
  }

  private async finish(flushed: boolean): Promise<void> {
    this.setState('closed')
    this.stopTimers()
    this.closeLedger()
    // With everything flushed the durable copy is the authority, and this replica keeps no copy of the tenant's data. An
    // abandoned tenant keeps its file: it may hold writes that exist nowhere else, until the next open of that tenant on this
    // replica, whose restore replaces it.
    if (flushed) {
      try { discardLocalLedger(this.deps.context) } catch { /* a leftover file is discarded at the next restore */ }
    }
    this.deps.detach(this)
    try {
      await this.deps.lease.release()
    } finally {
      this.emit({ type: 'released', key: this.deps.key, epoch: this.epoch, flushed })
    }
  }

  /** The lease is gone for good: stop serving, close the ledger, leave the stale local file to be replaced by the next restore. */
  private markLost(): void {
    if (this.state === 'closed') return
    this.setState('closed')
    this.stopTimers()
    this.closeLedger()
    this.deps.detach(this)
    this.emit({ type: 'lost', key: this.deps.key, epoch: this.epoch })
  }

  private stopTimers(): void {
    if (this.renewTimer) clearTimeout(this.renewTimer)
    this.renewTimer = null
    this.stopSnapshotTimer()
  }

  private stopSnapshotTimer(): void {
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer)
    this.snapshotTimer = null
  }

  private scheduleRenewal(): void {
    // Idempotent, and never beside a renewal that is under way: a handoff that fails resumes service while its renewals never
    // stopped, and a second chain would double them for the rest of the tenure.
    if (!this.deps.autoRenew || this.state === 'closed' || this.renewTimer || this.renewTicking) return
    this.renewTimer = setTimeout(() => { void this.renewTick() }, this.deps.renewEveryMs)
    this.renewTimer.unref()
  }

  private async renewTick(): Promise<void> {
    this.renewTimer = null
    this.renewTicking = true
    try {
      await this.renew()
    } catch (error) {
      if (this.state !== 'closed') this.emit({ type: 'renew_failed', key: this.deps.key, epoch: this.epoch, code: (error as { code?: string }).code ?? 'unknown' })
    } finally {
      this.renewTicking = false
    }
    this.scheduleRenewal()
  }

  private scheduleSnapshot(): void {
    if (this.deps.snapshotEveryMs <= 0 || this.state === 'closed' || this.snapshotTimer) return
    this.snapshotTimer = setTimeout(() => { void this.snapshotTick() }, this.deps.snapshotEveryMs)
    this.snapshotTimer.unref()
  }

  private async snapshotTick(): Promise<void> {
    this.snapshotTimer = null
    if (this.snapshotQueued === 0) await this.snapshot().catch(() => undefined)
    this.scheduleSnapshot()
  }
}

// ---- the router -------------------------------------------------------------------------

const DEFAULT_TTL_MS = 10_000
const DEFAULT_MARGIN_MS = 2_000
const DEFAULT_DRAIN_TIMEOUT_MS = 120_000
const DEFAULT_CLOSE_CONCURRENCY = 8
const MAX_TIMER_MS = 2_147_483_647

export class TenantRouter {
  private readonly options: TenantRouterOptions
  private readonly clock: MonotonicClock
  private readonly handles = new Map<string, OpenTenant>()
  private readonly opening = new Map<string, Promise<TenantHandle>>()
  private closed = false

  constructor(options: TenantRouterOptions) {
    if (typeof options.replicaId !== 'string' || options.replicaId.length === 0) throw new RangeError('replicaId must be a non-empty string')
    if (options.maxOpenTenants !== undefined && (!Number.isSafeInteger(options.maxOpenTenants) || options.maxOpenTenants < 1)) throw new RangeError('maxOpenTenants must be a positive integer')
    if (options.drainTimeoutMs !== undefined && (!Number.isSafeInteger(options.drainTimeoutMs) || options.drainTimeoutMs < 1 || options.drainTimeoutMs > MAX_TIMER_MS)) throw new RangeError(`drainTimeoutMs must be an integer within [1, ${MAX_TIMER_MS}]`)
    if (options.closeConcurrency !== undefined && (!Number.isSafeInteger(options.closeConcurrency) || options.closeConcurrency < 1)) throw new RangeError('closeConcurrency must be a positive integer')
    this.options = options
    this.clock = options.clock ?? systemMonotonicClock
  }

  /**
   * The handle of a tenant this replica owns, acquiring the lease and restoring the ledger first if needed.
   * Concurrent calls for one tenant share one acquisition.
   *
   * @throws InvalidTenantIdError for an id that is not in the fixed format, before any store or file is touched
   * @throws LeaseHeldError when another replica owns the tenant; the record names it
   */
  openTenant(organization: string, ledgerTenant: string): Promise<TenantHandle> {
    if (this.closed) return Promise.reject(new RouterClosedError())
    let key: string
    try {
      key = leaseKeyFor(organization, ledgerTenant)
    } catch (error) {
      return Promise.reject(error)
    }
    const existing = this.handles.get(key)
    if (existing?.isOpen()) return Promise.resolve(existing)
    // Our own lease is still held while a handoff drains, so an acquisition would only be told it is held by us.
    if (existing?.isDraining()) return Promise.reject(new TenantDrainingError(key))
    const pending = this.opening.get(key)
    if (pending) return pending
    const cap = this.options.maxOpenTenants
    // A tenant being opened already holds a slot, and so does one being handed off: both still hold their descriptors.
    if (cap !== undefined && new Set([...this.handles.keys(), ...this.opening.keys()]).size >= cap) return Promise.reject(new ReplicaAtCapacityError(cap))
    const attempt = this.open(organization, ledgerTenant, key).finally(() => { this.opening.delete(key) })
    this.opening.set(key, attempt)
    return attempt
  }

  /** The open handle of a tenant, if this replica currently serves it. */
  handleOf(organization: string, ledgerTenant: string): TenantHandle | null {
    const existing = this.handles.get(leaseKeyFor(organization, ledgerTenant))
    return existing?.isOpen() ? existing : null
  }

  openCount(): number {
    return [...this.handles.values()].filter(handle => handle.isOpen()).length
  }

  /**
   * The directory of one tenant on this replica: its ledger and everything that must travel with it (planner working
   * files, tickets). A consumer that keeps per-tenant files puts them here, never beside another tenant's.
   */
  tenantRootOf(organization: string, ledgerTenant: string): string {
    return tenantRootFor(this.options.stateRoot, organization, ledgerTenant)
  }

  /**
   * Hands every open tenant off gracefully and refuses new ones. Resolves with the tenants whose flush failed, among them
   * those whose drain ran past `drainTimeoutMs`. Tenants are handed off several at a time, so one that cannot finish holds
   * back only the slot it sits in, and for no longer than its deadline.
   */
  async close(): Promise<string[]> {
    this.closed = true
    const queue = [...this.handles]
    const flushed: boolean[] = new Array<boolean>(queue.length).fill(false)
    let next = 0
    const lane = async (): Promise<void> => {
      for (;;) {
        const index = next
        next += 1
        if (index >= queue.length) return
        try {
          await queue[index]![1].handoff()
          flushed[index] = true
        } catch {
          // Reported below, in the order the tenants were opened.
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(this.options.closeConcurrency ?? DEFAULT_CLOSE_CONCURRENCY, queue.length) }, lane))
    return queue.filter((_, index) => !flushed[index]).map(([key]) => key)
  }

  private async open(organization: string, ledgerTenant: string, key: string): Promise<TenantHandle> {
    const { options } = this
    // A broken observer must never leave a lease held and unrenewed: it is told what happened, and nothing it throws matters.
    const emit = (event: RouterEvent): void => {
      try {
        options.onEvent?.(event)
      } catch {
        // Ignored on purpose.
      }
    }
    const lease = await TenantLease.acquire({
      store: options.leases,
      key,
      replicaId: options.replicaId,
      ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
      marginMs: options.marginMs ?? DEFAULT_MARGIN_MS,
      clock: this.clock,
    })
    emit({ type: 'acquired', key, epoch: lease.epoch })
    const context: EpochCopyContext = {
      durable: options.durable,
      lease,
      organization,
      ledgerTenant,
      tenantRoot: tenantRootFor(options.stateRoot, organization, ledgerTenant),
    }
    let restored: RestoreResult
    try {
      restored = await restoreTenantLedger(context)
    } catch (error) {
      await lease.release().catch(() => undefined)
      throw error
    }
    emit({ type: 'restored', key, epoch: lease.epoch, from: restored.restoredFrom, skipped: restored.skipped.length })
    if (this.closed) {
      restored.ledger.close()
      await lease.release().catch(() => undefined)
      throw new RouterClosedError()
    }
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    const handle = new OpenTenant({
      key,
      organization,
      ledgerTenant,
      lease,
      context,
      restored,
      autoRenew: options.autoRenew ?? true,
      renewEveryMs: options.renewEveryMs ?? Math.max(50, Math.floor(ttlMs / 3)),
      snapshotEveryMs: options.snapshotEveryMs ?? 0,
      drainTimeoutMs: options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS,
      emit,
      detach: (gone) => { if (this.handles.get(key) === gone) this.handles.delete(key) },
    })
    this.handles.set(key, handle)
    handle.begin()
    return handle
  }
}
