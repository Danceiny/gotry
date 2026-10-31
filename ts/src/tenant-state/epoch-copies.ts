/**
 * Epoch-scoped durable copies of a tenant ledger (docs/rfc/aaas-rfc.md §4.2 item 3 and §4.3, mode D-a).
 *
 * Every owner copies only into the prefix of its own epoch:
 *
 *     <org>/<tenant>/e<epoch>/base.json         where this epoch's ledger started: one pinned snapshot, or empty
 *     <org>/<tenant>/e<epoch>/snap-<n>.db       an immutable, verified image of the ledger
 *     <org>/<tenant>/e<epoch>/snap-<n>.json     its manifest; written last, so a manifest means a complete image
 *
 * A new owner never trusts what it finds beside its own epoch. It restores the newest verified snapshot
 * of the newest lineage, then pins that exact snapshot in its own `base.json` before it serves a write.
 * Anything a superseded owner uploads later goes into a dead prefix. A newer epoch's base never points at
 * it, so it can never become authoritative. Integrity therefore rests on the lease epoch and on these
 * rules, not on clocks. What can be lost under D-a is the tail of acknowledged writes after the last
 * snapshot, which is the declared RPO.
 *
 * Only the ledger file is copied. Files beside it (planner working files, tickets, artifacts) are not
 * replicated yet (RFC gap 6, fact F-2).
 */

import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ledgerDbPath, ledgerExists, openDb, type StateLedger } from '../state-ledger.ts'
import type { DurableStore } from './durable-store.ts'
import { CopyConflictError, RestoreVerificationError } from './errors.ts'
import { leaseKeyFor } from './ids.ts'
import type { TenantLease } from './tenant-lease.ts'

const MAX_SNAPSHOT_BYTES = 512 * 1024 * 1024
const HEX64 = /^[0-9a-f]{64}$/
const TENANT_TABLES = ['events', 'projection_docs', 'projection_items', 'workflow_runs', 'workflow_steps', 'pending_writes'] as const

export interface SnapshotRef {
  readonly epoch: number
  readonly seq: number
  readonly sha256: string
}

export interface SnapshotManifest extends SnapshotRef {
  readonly v: 1
  readonly tenant: string
  readonly bytes: number
  readonly events: number
  readonly maxEventSeq: number
  /** Diagnostic only: no decision reads it. */
  readonly createdAtMs: number
}

interface BaseRecord {
  readonly v: 1
  readonly epoch: number
  readonly from: SnapshotRef | null
}

export interface LedgerImageFacts {
  readonly events: number
  readonly maxEventSeq: number
}

export interface EpochCopyContext {
  readonly durable: DurableStore
  readonly lease: TenantLease
  readonly organization: string
  readonly ledgerTenant: string
  /** The tenant's state root: its ledger is `<tenantRoot>/gotry-state/gotry-state.db`. */
  readonly tenantRoot: string
}

// ---- layout ------------------------------------------------------------------

export function epochPrefixOf(leaseKey: string, epoch: number): string {
  return `${leaseKey}/e${String(epoch).padStart(8, '0')}/`
}

function snapshotKeyOf(leaseKey: string, epoch: number, seq: number, extension: 'db' | 'json'): string {
  return `${epochPrefixOf(leaseKey, epoch)}snap-${String(seq).padStart(6, '0')}.${extension}`
}

function baseKeyOf(leaseKey: string, epoch: number): string {
  return `${epochPrefixOf(leaseKey, epoch)}base.json`
}

function epochOfKey(objectKey: string): number | null {
  const match = /\/e(\d{8,})\/[^/]+$/.exec(objectKey)
  return match ? Number(match[1]) : null
}

function snapshotSeqsOf(keys: readonly string[], extension: 'db' | 'json'): number[] {
  const pattern = new RegExp(`/snap-(\\d{6})\\.${extension}$`)
  const seqs = new Set<number>()
  for (const key of keys) {
    const match = pattern.exec(key)
    if (match) seqs.add(Number(match[1]))
  }
  return [...seqs].sort((a, b) => b - a)
}

// ---- manifests -----------------------------------------------------------------

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function parseJson(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'))
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

function parseManifest(bytes: Uint8Array, tenant: string, epoch: number, seq: number): SnapshotManifest | null {
  const value = parseJson(bytes)
  if (!value || value.v !== 1 || value.tenant !== tenant || value.epoch !== epoch || value.seq !== seq) return null
  if (typeof value.sha256 !== 'string' || !HEX64.test(value.sha256)) return null
  if (![value.bytes, value.events, value.maxEventSeq, value.createdAtMs].every(isCount)) return null
  return value as unknown as SnapshotManifest
}

function parseBase(bytes: Uint8Array, epoch: number): BaseRecord | null {
  const value = parseJson(bytes)
  if (!value || value.v !== 1 || value.epoch !== epoch) return null
  if (value.from === null) return { v: 1, epoch, from: null }
  const from = value.from as Record<string, unknown> | undefined
  if (!from || typeof from !== 'object' || !isCount(from.epoch) || !isCount(from.seq) || from.epoch < 1 || from.epoch >= epoch || from.seq < 1) return null
  if (typeof from.sha256 !== 'string' || !HEX64.test(from.sha256)) return null
  return { v: 1, epoch, from: { epoch: from.epoch, seq: from.seq, sha256: from.sha256 } }
}

function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function refLabel(epoch: number, seq: number): string {
  return `e${epoch}/snap-${seq}`
}

// ---- verification --------------------------------------------------------------

/**
 * A ledger image is trusted only if SQLite finds it intact, it holds rows of this tenant and no
 * other, and replaying its events reproduces its projections (the drill D properties). The checks
 * run on a scratch copy, so the image itself is never opened for writing.
 */
export function verifyLedgerImage(imagePath: string, ledgerTenant: string): LedgerImageFacts {
  const scratch = mkdtempSync(join(tmpdir(), 'gotry-verify-'))
  try {
    mkdirSync(dirname(ledgerDbPath(scratch)), { recursive: true })
    copyFileSync(imagePath, ledgerDbPath(scratch))
    const facts = inspectImage(ledgerDbPath(scratch), ledgerTenant)
    assertFoldReproducesProjections(scratch, ledgerTenant)
    return facts
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

function inspectImage(copyPath: string, ledgerTenant: string): LedgerImageFacts {
  const db = new Database(copyPath, { fileMustExist: true })
  try {
    const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new RestoreVerificationError('ledger image failed integrity_check')
    for (const table of TENANT_TABLES) {
      const foreign = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id <> ?`).get(ledgerTenant) as { n: number }
      if (foreign.n !== 0) throw new RestoreVerificationError(`ledger image holds rows of another tenant in ${table}`)
    }
    const row = db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(seq), 0) AS m FROM events').get() as { n: number; m: number }
    return { events: row.n, maxEventSeq: row.m }
  } catch (error) {
    if (error instanceof RestoreVerificationError) throw error
    throw new RestoreVerificationError(`ledger image is not a readable ledger: ${(error as Error).message}`)
  } finally {
    db.close()
  }
}

function assertFoldReproducesProjections(scratchRoot: string, ledgerTenant: string): void {
  let ledger: StateLedger
  try {
    ledger = openDb(scratchRoot, ledgerTenant)
  } catch (error) {
    throw new RestoreVerificationError(`ledger image could not be opened as a ledger: ${(error as Error).message}`)
  }
  try {
    const before = JSON.stringify({ wishes: ledger.readWishPool(), motivation: ledger.readMotivation() })
    ledger.rebuildProjections()
    const after = JSON.stringify({ wishes: ledger.readWishPool(), motivation: ledger.readMotivation() })
    if (before !== after) throw new RestoreVerificationError('ledger image: replaying its events does not reproduce its projections')
  } finally {
    ledger.close()
  }
}

function verifyCandidate(bytes: Uint8Array, manifest: SnapshotManifest, ledgerTenant: string): void {
  if (bytes.byteLength !== manifest.bytes) throw new RestoreVerificationError('size differs from its manifest')
  if (sha256Of(bytes) !== manifest.sha256) throw new RestoreVerificationError('checksum differs from its manifest')
  const scratch = mkdtempSync(join(tmpdir(), 'gotry-candidate-'))
  try {
    const imagePath = join(scratch, 'image.db')
    writeFileSync(imagePath, bytes)
    const facts = verifyLedgerImage(imagePath, ledgerTenant)
    if (facts.events !== manifest.events || facts.maxEventSeq !== manifest.maxEventSeq) {
      throw new RestoreVerificationError('event count or last sequence differs from its manifest')
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

// ---- publishing ----------------------------------------------------------------

function assertContext(context: EpochCopyContext): string {
  const key = leaseKeyFor(context.organization, context.ledgerTenant)
  if (context.lease.key !== key) throw new RangeError(`the lease ${context.lease.key} does not belong to tenant ${key}`)
  return key
}

/**
 * Takes a consistent image of the live ledger, verifies it, and publishes it into this holder's
 * epoch prefix. The lease is checked before the work and again right before the upload.
 */
export async function publishSnapshot(context: EpochCopyContext, options: { nowMs?: () => number } = {}): Promise<SnapshotManifest> {
  const key = assertContext(context)
  const { durable, lease, ledgerTenant } = context
  lease.assertHeld()
  const scratch = mkdtempSync(join(tmpdir(), 'gotry-snapshot-'))
  try {
    const imagePath = join(scratch, 'image.db')
    const source = new Database(ledgerDbPath(context.tenantRoot), { fileMustExist: true })
    try {
      source.pragma('busy_timeout = 8000')
      await source.backup(imagePath)
    } finally {
      source.close()
    }
    // The image must not depend on a -wal or -shm file that would not travel with it.
    const image = new Database(imagePath)
    try {
      image.pragma('journal_mode = DELETE')
    } finally {
      image.close()
    }
    const facts = verifyLedgerImage(imagePath, ledgerTenant)
    const bytes = readFileSync(imagePath)
    if (bytes.byteLength > MAX_SNAPSHOT_BYTES) throw new RangeError(`ledger image of ${bytes.byteLength} bytes exceeds the ${MAX_SNAPSHOT_BYTES} byte limit`)
    const sha256 = sha256Of(bytes)

    lease.assertHeld()
    const existing = await durable.list(`${epochPrefixOf(key, lease.epoch)}snap-`)
    const seq = (snapshotSeqsOf(existing, 'db')[0] ?? 0) + 1
    const manifest: SnapshotManifest = {
      v: 1,
      tenant: ledgerTenant,
      epoch: lease.epoch,
      seq,
      sha256,
      bytes: bytes.byteLength,
      events: facts.events,
      maxEventSeq: facts.maxEventSeq,
      createdAtMs: (options.nowMs ?? Date.now)(),
    }
    if (!await durable.putIfAbsent(snapshotKeyOf(key, lease.epoch, seq, 'db'), bytes)) {
      throw new CopyConflictError(`${refLabel(lease.epoch, seq)} already exists in the prefix of epoch ${lease.epoch}`)
    }
    if (!await durable.putIfAbsent(snapshotKeyOf(key, lease.epoch, seq, 'json'), Buffer.from(JSON.stringify(manifest)))) {
      throw new CopyConflictError(`the manifest of ${refLabel(lease.epoch, seq)} already exists`)
    }
    // The upload took time. An image that landed after the lease lapsed may sit above the base a successor already
    // pinned, and is then never read: reporting it as published would tell a caller its writes are safe when they are not.
    lease.assertHeld()
    return manifest
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** Pins where this epoch's ledger started. Written once, before the owner serves a write or publishes a snapshot. */
async function writeBase(context: EpochCopyContext, key: string, from: SnapshotRef | null): Promise<void> {
  context.lease.assertHeld()
  const record: BaseRecord = { v: 1, epoch: context.lease.epoch, from }
  if (!await context.durable.putIfAbsent(baseKeyOf(key, context.lease.epoch), Buffer.from(JSON.stringify(record)))) {
    throw new CopyConflictError(`the base of epoch ${context.lease.epoch} already exists`)
  }
}

// ---- restoring -------------------------------------------------------------------

export interface RestorePoint {
  readonly manifest: SnapshotManifest
  /** The verified image. */
  readonly bytes: Uint8Array
}

export interface RestoreResolution {
  /** `null` means the lineage starts empty. */
  readonly point: RestorePoint | null
  /** Snapshots that were passed over, with the reason; an operator alert, not an error. */
  readonly skipped: readonly string[]
}

/**
 * The newest verified snapshot of the newest lineage below `ownEpoch` and above the forgotten floor.
 *
 * The newest lineage is the highest epoch that left anything behind. Inside an epoch the newest snapshot
 * that verifies wins; with none, the walk follows that epoch's `base.json` pin to the exact snapshot (and
 * older ones of that epoch) it started from. A snapshot a superseded owner uploaded after a newer epoch
 * pinned its base is above the pin and is never read.
 *
 * @throws RestoreVerificationError when copies exist but none of them verifies
 */
export async function resolveRestorePoint(
  durable: DurableStore,
  leaseKey: string,
  ledgerTenant: string,
  ownEpoch: number,
  forgottenAtEpoch: number,
  verify: (bytes: Uint8Array, manifest: SnapshotManifest) => void,
): Promise<RestoreResolution> {
  const keysByEpoch = new Map<number, string[]>()
  for (const objectKey of await durable.list(`${leaseKey}/e`)) {
    const epoch = epochOfKey(objectKey)
    if (epoch === null || epoch <= forgottenAtEpoch || epoch >= ownEpoch) continue
    keysByEpoch.set(epoch, [...keysByEpoch.get(epoch) ?? [], objectKey])
  }
  const epochsWithEvidence = [...keysByEpoch.keys()].sort((a, b) => b - a)
  const skipped: string[] = []
  const visited = new Set<number>()
  let corrupt = false
  let epoch: number | null = epochsWithEvidence[0] ?? null
  let ceiling = Number.POSITIVE_INFINITY

  while (epoch !== null && !visited.has(epoch)) {
    visited.add(epoch)
    const keys: string[] = keysByEpoch.get(epoch) ?? await durable.list(epochPrefixOf(leaseKey, epoch))
    for (const seq of snapshotSeqsOf(keys, 'json').filter(candidate => candidate <= ceiling)) {
      const label = refLabel(epoch, seq)
      const manifestBytes = await durable.get(snapshotKeyOf(leaseKey, epoch, seq, 'json'))
      const manifest = manifestBytes ? parseManifest(manifestBytes, ledgerTenant, epoch, seq) : null
      if (!manifest) {
        skipped.push(`${label}: manifest is missing or malformed`)
        corrupt = true
        continue
      }
      const bytes = await durable.get(snapshotKeyOf(leaseKey, epoch, seq, 'db'))
      if (!bytes) {
        skipped.push(`${label}: image is missing`)
        corrupt = true
        continue
      }
      try {
        verify(bytes, manifest)
        return { point: { manifest, bytes }, skipped }
      } catch (error) {
        if (!(error instanceof RestoreVerificationError)) throw error
        skipped.push(`${label}: ${error.message}`)
        corrupt = true
      }
    }

    const baseBytes: Uint8Array | null = keys.includes(baseKeyOf(leaseKey, epoch)) ? await durable.get(baseKeyOf(leaseKey, epoch)) : null
    const base: BaseRecord | null = baseBytes ? parseBase(baseBytes, epoch) : null
    if (base?.from === null) break
    if (base?.from) {
      if (base.from.epoch <= forgottenAtEpoch) break
      epoch = base.from.epoch
      ceiling = base.from.seq
      continue
    }
    skipped.push(`e${epoch}: base is missing or malformed`)
    epoch = epochsWithEvidence.find(candidate => candidate < epoch!) ?? null
    ceiling = Number.POSITIVE_INFINITY
  }
  if (corrupt) throw new RestoreVerificationError('durable copies exist but none of them verifies', skipped)
  return { point: null, skipped }
}

export interface RestoreResult {
  readonly ledger: StateLedger
  /** The snapshot this epoch started from, or `null` for an empty ledger. */
  readonly restoredFrom: SnapshotRef | null
  readonly skipped: readonly string[]
  readonly facts: LedgerImageFacts | null
}

function evictCachedLedger(tenantRoot: string, ledgerTenant: string): void {
  if (!ledgerExists(tenantRoot)) return
  try {
    openDb(tenantRoot, ledgerTenant).close()
  } catch {
    // A stale or damaged local file is about to be replaced; failing to open it changes nothing.
  }
}

/**
 * Makes the local ledger of a freshly acquired epoch equal to the newest verified durable copy, pins that
 * copy in this epoch's `base.json`, and opens the ledger. Local files from an earlier tenure are always
 * discarded: only the durable copy is authoritative.
 */
export async function restoreTenantLedger(context: EpochCopyContext): Promise<RestoreResult> {
  const key = assertContext(context)
  const { durable, lease, ledgerTenant, tenantRoot } = context
  lease.assertHeld()
  const resolution = await resolveRestorePoint(
    durable, key, ledgerTenant, lease.epoch, lease.forgottenAtEpoch,
    (bytes, manifest) => verifyCandidate(bytes, manifest, ledgerTenant),
  )
  lease.assertHeld()

  evictCachedLedger(tenantRoot, ledgerTenant)
  const dbPath = ledgerDbPath(tenantRoot)
  mkdirSync(dirname(dbPath), { recursive: true })
  for (const suffix of ['', '-wal', '-shm', '.restoring']) rmSync(`${dbPath}${suffix}`, { force: true })
  const point = resolution.point
  if (point) {
    writeFileSync(`${dbPath}.restoring`, point.bytes)
    renameSync(`${dbPath}.restoring`, dbPath)
  }
  const restoredFrom: SnapshotRef | null = point ? { epoch: point.manifest.epoch, seq: point.manifest.seq, sha256: point.manifest.sha256 } : null
  await writeBase(context, key, restoredFrom)
  return {
    ledger: openDb(tenantRoot, ledgerTenant),
    restoredFrom,
    skipped: resolution.skipped,
    facts: point ? { events: point.manifest.events, maxEventSeq: point.manifest.maxEventSeq } : null,
  }
}

// ---- forgetting --------------------------------------------------------------------

/**
 * Forget means delete (red line 6): the floor goes into the lease record first, so no later restore can
 * read an older copy even if a superseded owner uploads one afterwards; then every durable copy and the
 * local files go; then the lease is handed back. The caller closes the tenant's ledger first.
 */
/**
 * Removes the local ledger files (the database and its -wal and -shm) of a tenure that flushed everything. Other files
 * of the tenant's directory, such as a planner's working files, are not the ledger's and stay.
 */
export function discardLocalLedger(context: EpochCopyContext): void {
  const file = ledgerDbPath(context.tenantRoot)
  for (const path of [file, `${file}-wal`, `${file}-shm`]) rmSync(path, { force: true })
}

export async function forgetTenant(context: EpochCopyContext): Promise<{ readonly deletedObjects: number; readonly floor: number }> {
  const key = assertContext(context)
  context.lease.assertHeld()
  const record = await context.lease.markForgotten()
  const deletedObjects = await context.durable.deletePrefix(`${key}/`)
  rmSync(context.tenantRoot, { recursive: true, force: true })
  await context.lease.release()
  return { deletedObjects, floor: record.forgottenAtEpoch }
}

/** Deletes copies at or below the forgotten floor that a superseded owner uploaded after the forget. */
export async function sweepMaskedCopies(durable: DurableStore, leaseKey: string, forgottenAtEpoch: number): Promise<number> {
  let deleted = 0
  const dead = new Set<number>()
  for (const objectKey of await durable.list(`${leaseKey}/e`)) {
    const epoch = epochOfKey(objectKey)
    if (epoch !== null && epoch <= forgottenAtEpoch) dead.add(epoch)
  }
  for (const epoch of dead) deleted += await durable.deletePrefix(epochPrefixOf(leaseKey, epoch))
  return deleted
}
