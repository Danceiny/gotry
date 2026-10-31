/**
 * Lease store of the AaaS state layer (docs/rfc/aaas-rfc.md §4.2, decision Q3).
 *
 * One record per tenant says which replica may write that tenant's ledger and at
 * which epoch. The contract is a linearizable compare-and-set per key:
 *
 *   - `acquire` succeeds only when no record exists or the record has expired on
 *     the STORE's clock, and then moves the epoch from n to n + 1;
 *   - `renew` keeps the epoch and succeeds only for the current, unexpired holder;
 *   - `release` expires the lease at once and keeps the epoch (the epoch floor);
 *   - epochs never decrease, and records are never deleted.
 *
 * Integrity of the tenant's data does not rest on clocks: durable copies are
 * scoped by epoch (A1.2), so a stale holder can cost availability but cannot make
 * its writes authoritative. The store's clock only decides who may try next.
 *
 * `SqliteLeaseStore` is the reference implementation: one SQLite file whose write
 * lock serializes writers across processes on one host. It is what the offline
 * suites and single-host drills run against. The production binding (hotel-be
 * MySQL, one row per tenant, CAS on the primary) must pass the same conformance
 * suite before it is used.
 */

import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { LeaseHeldError, LeaseLostError, LeaseStoreUnavailableError, TenantStateError } from './errors.ts'

/** One row per tenant. `leaseUntilMs` is on the store's own clock; `epoch` only ever grows. */
export interface LeaseRecord {
  readonly key: string
  readonly owner: string
  readonly epoch: number
  readonly leaseUntilMs: number
  /** Restore ignores durable copies of epochs up to and including this one; 0 when nothing was forgotten. */
  readonly forgottenAtEpoch: number
}

export interface LeaseGrant {
  readonly record: LeaseRecord
  /** The duration the store granted. Holders measure it from before they sent the request. */
  readonly ttlMs: number
}

export interface LeaseStore {
  read(key: string): Promise<LeaseRecord | null>
  /** @throws LeaseHeldError while another unexpired lease exists (the caller's own included). */
  acquire(key: string, owner: string, ttlMs: number): Promise<LeaseGrant>
  /** @throws LeaseLostError unless the caller holds that epoch and its lease has not expired. */
  renew(key: string, owner: string, epoch: number, ttlMs: number): Promise<LeaseGrant>
  /** Graceful handoff: expires the lease now and keeps the epoch. @throws LeaseLostError for a stale caller. */
  release(key: string, owner: string, epoch: number): Promise<LeaseRecord>
  /** Records that every durable copy up to `epoch` is dead. Only the current holder may. */
  markForgotten(key: string, owner: string, epoch: number): Promise<LeaseRecord>
}

export const MIN_LEASE_TTL_MS = 100
export const MAX_LEASE_TTL_MS = 10 * 60_000
const MAX_TEXT_LENGTH = 200

export function assertLeaseTtl(ttlMs: number): void {
  if (!Number.isInteger(ttlMs) || ttlMs < MIN_LEASE_TTL_MS || ttlMs > MAX_LEASE_TTL_MS) {
    throw new RangeError(`lease ttl must be an integer within [${MIN_LEASE_TTL_MS}, ${MAX_LEASE_TTL_MS}] ms, got ${String(ttlMs)}`)
  }
}

function assertText(name: string, value: unknown): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TEXT_LENGTH) {
    throw new RangeError(`${name} must be a non-empty string of at most ${MAX_TEXT_LENGTH} characters`)
  }
}

function assertEpoch(epoch: number): void {
  if (!Number.isInteger(epoch) || epoch < 1) throw new RangeError(`epoch must be a positive integer, got ${String(epoch)}`)
}

interface LeaseRow {
  key: string
  owner: string
  epoch: number
  lease_until_ms: number
  forgotten_at_epoch: number
}

function toRecord(row: LeaseRow): LeaseRecord {
  return { key: row.key, owner: row.owner, epoch: row.epoch, leaseUntilMs: row.lease_until_ms, forgottenAtEpoch: row.forgotten_at_epoch }
}

export interface LeaseHistoryEntry {
  readonly key: string
  readonly op: 'acquire' | 'renew' | 'release' | 'forget'
  readonly owner: string
  readonly epoch: number
  readonly atMs: number
}

/**
 * The storage-level triggers carry the invariants a buggy caller must not be able
 * to break: epochs move by exactly one, the forgotten floor never moves back, and
 * a lease row (the epoch floor of its tenant) is never deleted.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS leases (
  key TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK (epoch >= 1),
  lease_until_ms INTEGER NOT NULL,
  forgotten_at_epoch INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS lease_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('acquire', 'renew', 'release', 'forget')),
  owner TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  at_ms INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS leases_epoch_forward_only
BEFORE UPDATE OF epoch ON leases
WHEN NEW.epoch <> OLD.epoch AND NEW.epoch <> OLD.epoch + 1
BEGIN SELECT RAISE(ABORT, 'lease epoch moves forward by exactly one'); END;
CREATE TRIGGER IF NOT EXISTS leases_forgotten_floor_forward_only
BEFORE UPDATE OF forgotten_at_epoch ON leases
WHEN NEW.forgotten_at_epoch < OLD.forgotten_at_epoch
BEGIN SELECT RAISE(ABORT, 'the forgotten floor never moves back'); END;
CREATE TRIGGER IF NOT EXISTS leases_never_deleted
BEFORE DELETE ON leases
BEGIN SELECT RAISE(ABORT, 'a lease row is the epoch floor of its tenant and is never deleted'); END;
`

export interface SqliteLeaseStoreOptions {
  readonly path: string
  /** The store's clock. Injected so the offline suites control expiry; defaults to the wall clock. */
  readonly nowMs?: () => number
}

export class SqliteLeaseStore implements LeaseStore {
  private readonly db: Database.Database
  private readonly nowMs: () => number

  constructor(options: SqliteLeaseStoreOptions) {
    mkdirSync(dirname(options.path), { recursive: true })
    this.db = new Database(options.path)
    this.nowMs = options.nowMs ?? Date.now
    // busy_timeout before anything contendable: sibling processes must wait for the write lock, not fail at once.
    this.db.pragma('busy_timeout = 5000')
    this.immediate(() => { this.db.exec(SCHEMA) })
  }

  close(): void {
    this.db.close()
  }

  async read(key: string): Promise<LeaseRecord | null> {
    assertText('key', key)
    const row = this.guard(() => this.selectRow(key))
    return row ? toRecord(row) : null
  }

  async acquire(key: string, owner: string, ttlMs: number): Promise<LeaseGrant> {
    assertText('key', key)
    assertText('owner', owner)
    assertLeaseTtl(ttlMs)
    return this.immediate(() => {
      const now = this.nowMs()
      const row = this.selectRow(key)
      if (row && row.lease_until_ms > now) throw new LeaseHeldError(toRecord(row))
      const epoch = row ? row.epoch + 1 : 1
      if (row) {
        this.db.prepare('UPDATE leases SET owner = ?, epoch = ?, lease_until_ms = ? WHERE key = ?').run(owner, epoch, now + ttlMs, key)
      } else {
        this.db.prepare('INSERT INTO leases (key, owner, epoch, lease_until_ms) VALUES (?, ?, ?, ?)').run(key, owner, epoch, now + ttlMs)
      }
      this.log(key, 'acquire', owner, epoch, now)
      return { record: this.mustSelect(key), ttlMs }
    })
  }

  async renew(key: string, owner: string, epoch: number, ttlMs: number): Promise<LeaseGrant> {
    assertText('key', key)
    assertText('owner', owner)
    assertEpoch(epoch)
    assertLeaseTtl(ttlMs)
    return this.immediate(() => {
      const now = this.nowMs()
      const row = this.requireHolder(key, owner, epoch, now)
      this.db.prepare('UPDATE leases SET lease_until_ms = ? WHERE key = ?').run(now + ttlMs, row.key)
      this.log(key, 'renew', owner, epoch, now)
      return { record: this.mustSelect(key), ttlMs }
    })
  }

  async release(key: string, owner: string, epoch: number): Promise<LeaseRecord> {
    assertText('key', key)
    assertText('owner', owner)
    assertEpoch(epoch)
    return this.immediate(() => {
      const now = this.nowMs()
      const row = this.selectRow(key)
      if (!row || row.owner !== owner || row.epoch !== epoch) throw new LeaseLostError(`${key}: epoch ${epoch} is not held by ${owner}`)
      this.db.prepare('UPDATE leases SET lease_until_ms = ? WHERE key = ?').run(Math.min(row.lease_until_ms, now), key)
      this.log(key, 'release', owner, epoch, now)
      return this.mustSelect(key)
    })
  }

  async markForgotten(key: string, owner: string, epoch: number): Promise<LeaseRecord> {
    assertText('key', key)
    assertText('owner', owner)
    assertEpoch(epoch)
    return this.immediate(() => {
      const now = this.nowMs()
      const row = this.requireHolder(key, owner, epoch, now)
      this.db.prepare('UPDATE leases SET forgotten_at_epoch = ? WHERE key = ?').run(Math.max(row.forgotten_at_epoch, epoch), key)
      this.log(key, 'forget', owner, epoch, now)
      return this.mustSelect(key)
    })
  }

  /** Audit trail for suites: every granted operation in order. Not part of the LeaseStore contract. */
  history(key?: string): LeaseHistoryEntry[] {
    const rows = (key === undefined
      ? this.db.prepare('SELECT key, op, owner, epoch, at_ms FROM lease_log ORDER BY id').all()
      : this.db.prepare('SELECT key, op, owner, epoch, at_ms FROM lease_log WHERE key = ? ORDER BY id').all(key)) as Array<{ key: string; op: LeaseHistoryEntry['op']; owner: string; epoch: number; at_ms: number }>
    return rows.map(row => ({ key: row.key, op: row.op, owner: row.owner, epoch: row.epoch, atMs: row.at_ms }))
  }

  private requireHolder(key: string, owner: string, epoch: number, now: number): LeaseRow {
    const row = this.selectRow(key)
    if (!row || row.owner !== owner || row.epoch !== epoch) throw new LeaseLostError(`${key}: epoch ${epoch} is not held by ${owner}`)
    if (row.lease_until_ms <= now) throw new LeaseLostError(`${key}: the lease of epoch ${epoch} expired`)
    return row
  }

  private selectRow(key: string): LeaseRow | undefined {
    return this.db.prepare('SELECT key, owner, epoch, lease_until_ms, forgotten_at_epoch FROM leases WHERE key = ?').get(key) as LeaseRow | undefined
  }

  private mustSelect(key: string): LeaseRecord {
    const row = this.selectRow(key)
    if (!row) throw new LeaseStoreUnavailableError(`${key}: lease row vanished inside its transaction`)
    return toRecord(row)
  }

  private log(key: string, op: LeaseHistoryEntry['op'], owner: string, epoch: number, atMs: number): void {
    this.db.prepare('INSERT INTO lease_log (key, op, owner, epoch, at_ms) VALUES (?, ?, ?, ?, ?)').run(key, op, owner, epoch, atMs)
  }

  /** Contention is an availability problem of the store; every other failure is a real error and passes through. */
  private guard<T>(fn: () => T): T {
    try {
      return fn()
    } catch (error) {
      if (error instanceof TenantStateError) throw error
      const code = (error as { code?: unknown } | null)?.code
      if (typeof code === 'string' && code.startsWith('SQLITE_BUSY')) {
        throw new LeaseStoreUnavailableError('lease store is busy', { cause: error })
      }
      throw error
    }
  }

  private immediate<T>(fn: () => T): T {
    return this.guard(() => this.db.transaction(fn).immediate())
  }
}
