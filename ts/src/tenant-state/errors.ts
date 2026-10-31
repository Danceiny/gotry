/**
 * Typed failures of the per-tenant state layer (AaaS A1, docs/rfc/aaas-rfc.md §4.2).
 *
 * `code` is the stable surface: callers branch on it or on `instanceof`, never on
 * messages. Every class maps to an availability outcome and never to silent
 * success: a holder that cannot prove it still owns a tenant must stop
 * acknowledging writes for it.
 */

import type { LeaseRecord } from './lease-store.ts'

export class TenantStateError extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = new.target.name
    this.code = code
  }
}

/** Another holder has an unexpired lease. Carries the record so a router can forward to that owner. */
export class LeaseHeldError extends TenantStateError {
  readonly record: LeaseRecord

  constructor(record: LeaseRecord) {
    super('GOTRY_TENANT_LEASE_HELD', `lease ${record.key} is held by ${record.owner} at epoch ${record.epoch}`)
    this.record = record
  }
}

/** The caller does not hold the lease any more (expired, taken over, or never held). Terminal for that holder. */
export class LeaseLostError extends TenantStateError {
  constructor(message: string) {
    super('GOTRY_TENANT_LEASE_LOST', message)
  }
}

export type FenceReason = 'lease_released' | 'lease_lost' | 'lease_expired_locally'

/** The write path must not acknowledge: this process cannot prove it still owns the tenant. */
export class FencedError extends TenantStateError {
  readonly reason: FenceReason

  constructor(reason: FenceReason, key: string, epoch: number) {
    super('GOTRY_TENANT_FENCED', `tenant ${key} epoch ${epoch} is fenced: ${reason}`)
    this.reason = reason
  }
}

/** The lease store could not be reached or answered with a contention failure. Owners keep their local deadline and fail closed when it passes. */
export class LeaseStoreUnavailableError extends TenantStateError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('GOTRY_TENANT_LEASE_STORE_UNAVAILABLE', message, options)
  }
}

/** An organization or tenant id is not in the fixed, path-safe format (threat S-3). */
export class InvalidTenantIdError extends TenantStateError {
  constructor(message: string) {
    super('GOTRY_TENANT_ID_INVALID', message)
  }
}

/** The durable store failed or could not be reached. Replication lag grows; a stricter durability mode would refuse writes. */
export class DurableStoreUnavailableError extends TenantStateError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('GOTRY_TENANT_DURABLE_STORE_UNAVAILABLE', message, options)
  }
}

/** A durable copy exists but cannot be trusted: a failed checksum, integrity, tenant or fold check. */
export class RestoreVerificationError extends TenantStateError {
  readonly skipped: readonly string[]

  constructor(message: string, skipped: readonly string[] = []) {
    super('GOTRY_TENANT_RESTORE_INVALID', message)
    this.skipped = skipped
  }
}

/** Something else wrote into this holder's own epoch prefix: the single-writer invariant is broken. */
export class CopyConflictError extends TenantStateError {
  constructor(message: string) {
    super('GOTRY_TENANT_COPY_CONFLICT', message)
  }
}

/** The tenant is being handed off: in-flight work finishes, new work is refused and should be retried on the next owner. */
export class TenantDrainingError extends TenantStateError {
  constructor(key: string) {
    super('GOTRY_TENANT_DRAINING', `tenant ${key} is being handed off`)
  }
}

/**
 * A handoff gave up waiting for calls that were already running. The tenant serves again, nothing was flushed or released,
 * and the caller decides: retry later, or abandon the tenant and give up its writes since the last snapshot. Waiting for
 * ever would hold the lease for ever, because it is renewed through the drain.
 */
export class DrainTimeoutError extends TenantStateError {
  readonly inFlight: number
  readonly timeoutMs: number

  constructor(key: string, inFlight: number, timeoutMs: number) {
    super('GOTRY_TENANT_DRAIN_TIMEOUT', `tenant ${key} still had ${inFlight} call(s) running after ${timeoutMs} ms of draining`)
    this.inFlight = inFlight
    this.timeoutMs = timeoutMs
  }
}

/** The router was closed; no tenant can be opened through it any more. */
export class RouterClosedError extends TenantStateError {
  constructor() {
    super('GOTRY_TENANT_ROUTER_CLOSED', 'the tenant router is closed')
  }
}

/**
 * This replica already holds as many tenants as it was configured to. Each open tenant costs file descriptors (about
 * three) and memory; past the process's descriptor limit every tenant, and every socket, would start failing at once.
 * The request is refused before the lease or any file is touched and belongs on another replica or later.
 */
export class ReplicaAtCapacityError extends TenantStateError {
  constructor(readonly limit: number) {
    super('GOTRY_TENANT_REPLICA_AT_CAPACITY', 'this replica is serving as many tenants as it is configured to')
  }
}
