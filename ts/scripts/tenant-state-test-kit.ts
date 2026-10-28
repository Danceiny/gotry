/**
 * Shared fixtures of the tenant-state suites (AaaS A1): fake clocks for the offline, deterministic runs.
 */

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
