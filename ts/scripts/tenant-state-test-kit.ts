/**
 * Shared fixtures of the tenant-state suites (AaaS A1): fake clocks for the offline, deterministic runs.
 */

import type { DurableStore } from '../src/tenant-state/durable-store.ts'
import { DurableStoreUnavailableError } from '../src/tenant-state/errors.ts'
import type { MonotonicClock } from '../src/tenant-state/tenant-lease.ts'

export class ManualClock implements MonotonicClock {
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

/** A clock that jumps forward by itself on one read, to trip a gate that sits between two reads. */
export class TrippingClock extends ManualClock {
  private readsUntilJump = -1
  private jumpMs = 0

  /** After `reads` more reads, the next read first moves the clock forward by `jumpMs`. */
  arm(reads: number, jumpMs: number): void {
    this.readsUntilJump = reads
    this.jumpMs = jumpMs
  }

  override nowMs(): number {
    if (this.readsUntilJump === 0) {
      this.readsUntilJump = -1
      this.advance(this.jumpMs)
    } else if (this.readsUntilJump > 0) {
      this.readsUntilJump -= 1
    }
    return super.nowMs()
  }
}

/** A durable store with an outage switch and one-shot failures, to cut the network at chosen moments. */
export class FaultyDurableStore implements DurableStore {
  down = false
  failNextPut: RegExp | null = null
  conflictNextPut: RegExp | null = null
  /** Runs once, just before the next listing is answered: a way to land another replica's upload inside a restore. */
  beforeNextList: (() => Promise<void>) | null = null
  private readonly inner: DurableStore

  constructor(inner: DurableStore) {
    this.inner = inner
  }

  private gate(): void {
    if (this.down) throw new DurableStoreUnavailableError('injected outage')
  }

  async putIfAbsent(key: string, bytes: Uint8Array): Promise<boolean> {
    this.gate()
    if (this.failNextPut?.test(key)) {
      this.failNextPut = null
      throw new DurableStoreUnavailableError(`injected failure for ${key}`)
    }
    if (this.conflictNextPut?.test(key)) {
      this.conflictNextPut = null
      return false
    }
    return this.inner.putIfAbsent(key, bytes)
  }

  async get(key: string): Promise<Uint8Array | null> {
    this.gate()
    return this.inner.get(key)
  }

  async list(prefix: string): Promise<string[]> {
    this.gate()
    const hook = this.beforeNextList
    if (hook) {
      this.beforeNextList = null
      await hook()
    }
    return this.inner.list(prefix)
  }

  async deletePrefix(prefix: string): Promise<number> {
    this.gate()
    return this.inner.deletePrefix(prefix)
  }
}
