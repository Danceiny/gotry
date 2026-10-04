/**
 * Explicit opt-in M3 seed-cohort capture core (issue #22).
 *
 * `scripts/product-metrics.ts` is the M3 scorer; before this module nothing in the
 * repository produced the `gotry_m3_cohort_record_v1` / `gotry_m3_evidence_manifest_v1`
 * records it consumes. This module owns the deterministic capture contract behind
 * `scripts/m3-cohort.ts`:
 *   - every participant/plan/cohort identifier is HMAC-SHA256 pseudonymous; raw labels
 *     (the only place a human handle could appear) are never persisted;
 *   - the sample window, eligibility, exclusion-code vocabulary and acceptance thresholds
 *     are frozen at `init` and must equal the scorer's own frozen values;
 *   - funnel events are append-only and idempotent by HMAC event ref;
 *   - `evidence_kind` is frozen at `init` and decides who may be captured:
 *       `real_seed_cohort`  → simulated participants are refused outright;
 *       `synthetic_fixture` → every participant MUST carry a simulation provenance block.
 *     The two can therefore never be mixed in one store or one evidence root.
 *   - export writes exactly the scorer's v1 shapes plus two sidecars the scorer ignores
 *     (`provenance.jsonl`, `export-attestation.json`); the attestation binds the digests
 *     so relabelling a synthetic export as real is detectable.
 *
 * Path/lock/atomic-write discipline deliberately mirrors `memory-lifecycle.ts` rather than
 * importing it: the two collectors keep independent error-code domains and independent
 * store roots, and a shared private helper surface would couple their fail-closed codes.
 *
 * Arithmetic discipline: this module computes no metric. It records funnel facts and lets
 * `scripts/product-metrics.ts` do every division.
 */

import { createHash, createHmac, randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

export const M3_COHORT_STORE_SCHEMA = 'gotry_m3_cohort_capture.v1' as const
export const M3_COHORT_MANIFEST_SCHEMA = 'gotry_m3_cohort_capture_manifest.v1' as const
export const M3_COHORT_EVENT_SCHEMA = 'gotry_m3_cohort_capture_event.v1' as const
export const M3_COHORT_RECORD_SCHEMA = 'gotry_m3_cohort_record_v1' as const
export const M3_EVIDENCE_MANIFEST_SCHEMA = 'gotry_m3_evidence_manifest_v1' as const
export const M3_SIMULATION_PROVENANCE_SCHEMA = 'gotry_m3_simulation_provenance_v1' as const
export const M3_EXPORT_ATTESTATION_SCHEMA = 'gotry_m3_export_attestation_v1' as const

export const HMAC_REF_PATTERN = /^hmac-sha256:[0-9a-f]{64}$/
export const SHA256_PATTERN = /^[0-9a-f]{64}$/
export const PERSONA_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/
export const MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:\-/]{0,95}$/

/** Frozen copies of the scorer's own acceptance thresholds (`scripts/product-metrics.ts`).
 *  A drift here is caught by `m3-cohort-tests.ts`, which asserts the scorer accepts the
 *  manifest this module writes. */
export const M3_ACCEPTANCE = {
  sampleMinimum: 50,
  sampleMaximum: 200,
  finalizationMinimum: 0.4,
  npsMinimum: 40,
  poiExclusiveMaximum: 0.01,
} as const

export const M3_FORMULAS = {
  finalization: 'finalized_eligible_delivered_plans / eligible_delivered_plans',
  nps: '100 * (promoters_9_10 - detractors_0_6) / valid_responses',
  poi: 'audited_invalid_poi_claims / locked_audited_poi_claims',
} as const

export const M3_EXCLUSION_CODES = [
  'outside_locked_window',
  'not_invited',
  'consent_missing_or_withdrawn',
  'test_or_staff',
  'attribution_not_allowed',
] as const

export type M3EvidenceKind = 'real_seed_cohort' | 'synthetic_fixture'
export type M3Attribution = 'gotry_primary' | 'gotry_assisted'
export type CommandStatus = 'recorded' | 'unchanged'

export type M3CohortErrorCode =
  | 'bad_args'
  | 'cohort_already_initialized'
  | 'cohort_consent_mismatch'
  | 'cohort_key_mismatch'
  | 'cohort_not_initialized'
  | 'evidence_kind_mismatch'
  | 'evidence_root_conflict'
  | 'export_validation_failed'
  | 'internal_error'
  | 'invalid_hmac_key'
  | 'invalid_input'
  | 'invalid_store'
  | 'invalid_transition'
  | 'lock_busy'
  | 'missing_consent'
  | 'missing_hmac_key'
  | 'missing_state_root'
  | 'output_exists'
  | 'simulation_forbidden_in_real_cohort'
  | 'simulation_label_required'
  | 'unsafe_state_root'

export class M3CohortError extends Error {
  readonly code: M3CohortErrorCode

  constructor(code: M3CohortErrorCode) {
    super(code)
    this.code = code
  }
}

function fail(code: M3CohortErrorCode): never {
  throw new M3CohortError(code)
}

export interface Clock {
  now(): Date
}

export const systemClock: Clock = { now: () => new Date() }

// ---------------------------------------------------------------------------
// Scorer-facing shapes (structural duplicates of scripts/product-metrics.ts;
// the capture side must be able to build them without importing a script)
// ---------------------------------------------------------------------------

export interface M3EvidenceManifest {
  schema_version: typeof M3_EVIDENCE_MANIFEST_SCHEMA
  evidence_kind: M3EvidenceKind
  cohort_id: string
  locked_at: string
  window: { start_at: string; end_at: string; timezone: string }
  eligibility: {
    sample_unit: 'unique_participant_with_eligible_delivered_plan'
    requires_invitation: true
    requires_consent: true
    allowed_attribution: M3Attribution[]
    exclusion_codes: string[]
  }
  metrics: {
    sample_size: { minimum: number; maximum: number }
    finalization_rate: { formula: string; minimum: number }
    nps: { formula: string; minimum: number }
    poi_hallucination_rate: { formula: string; exclusive_maximum: number }
  }
  nightly: {
    requires_real_llm: true
    requires_prompt_set_sha256: true
    requires_output_sha256: true
    requires_cost_usd: true
  }
}

export interface M3CohortRecord {
  schema_version: typeof M3_COHORT_RECORD_SCHEMA
  participant_key: string
  plan_key: string
  invited: boolean
  consent: boolean
  test_or_staff: boolean
  attribution: M3Attribution
  delivered_at: string
  finalized_at: string | null
  nps_score: number | null
  nps_recorded_at: string | null
  poi_audit: { locked_at: string; locked_claims: number; invalid_claims: number }
}

/** Unmistakable synthetic label. Lives in the `provenance.jsonl` sidecar — never inside a
 *  `gotry_m3_cohort_record_v1`, so existing fixtures and the scorer's exact-key check stay
 *  byte-compatible. */
export interface M3SimulationProvenance {
  schema_version: typeof M3_SIMULATION_PROVENANCE_SCHEMA
  kind: 'llm_persona'
  persona_id: string
  product_model: string
  persona_model: string
  prompt_digest: string
}

export interface M3SimulationProvenanceRow extends M3SimulationProvenance {
  participant_key: string
  plan_key: string
}

export interface M3ExportAttestation {
  schema_version: typeof M3_EXPORT_ATTESTATION_SCHEMA
  cohort_id: string
  evidence_kind: M3EvidenceKind
  exported_at: string
  record_count: number
  simulated_record_count: number
  capture_manifest_digest_sha256: string
  manifest_sha256: string
  /** Digest of the `gotry_m3_cohort_record_v1` lines only. `scripts/nightly-evidence.ts`
   *  appends `gotry_m3_nightly_run_v1` lines to the same `cohort.jsonl` after export; those
   *  carry their own prompt/output digests and are deliberately outside this attestation,
   *  so a legitimate nightly append does not invalidate it while any edit to a cohort
   *  record does. */
  cohort_records_sha256: string
  provenance_jsonl_sha256: string
}

/** The cohort-record subset of a `cohort.jsonl`, in file order, as the digest sees it. */
export function cohortRecordLines(cohortJsonl: string): string[] {
  const lines: string[] = []
  for (const line of cohortJsonl.split('\n')) {
    if (line.trim() === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      fail('export_validation_failed')
    }
    if (!isObject(parsed)) fail('export_validation_failed')
    if (parsed['schema_version'] === M3_COHORT_RECORD_SCHEMA) lines.push(line)
  }
  return lines
}

function cohortRecordsDigest(lines: readonly string[]): string {
  return sha256Hex(lines.join('\n') + (lines.length > 0 ? '\n' : ''))
}

// ---------------------------------------------------------------------------
// Capture store shapes
// ---------------------------------------------------------------------------

export interface M3CaptureManifest {
  schema_version: typeof M3_COHORT_MANIFEST_SCHEMA
  capture_schema: typeof M3_COHORT_STORE_SCHEMA
  cohort_ref: string
  cohort_key_verifier: string
  created_at: string
  consent_ref: string
  evidence_manifest: M3EvidenceManifest
}

interface BaseCaptureEvent {
  schema_version: typeof M3_COHORT_EVENT_SCHEMA
  event_ref: string
  kind: string
  occurred_at: string
  consent_ref: string
}

export interface ParticipantEnrolledEvent extends BaseCaptureEvent {
  kind: 'participant_enrolled'
  participant_key: string
  invited: boolean
  consent: boolean
  test_or_staff: boolean
  simulation: M3SimulationProvenance | null
}

export interface PlanDeliveredEvent extends BaseCaptureEvent {
  kind: 'plan_delivered'
  participant_key: string
  plan_key: string
  attribution: M3Attribution
}

export interface PlanFinalizedEvent extends BaseCaptureEvent {
  kind: 'plan_finalized'
  participant_key: string
  plan_key: string
}

export interface NpsRecordedEvent extends BaseCaptureEvent {
  kind: 'nps_recorded'
  participant_key: string
  plan_key: string
  nps_score: number
}

export interface PoiAuditLockedEvent extends BaseCaptureEvent {
  kind: 'poi_audit_locked'
  participant_key: string
  plan_key: string
  locked_claims: number
  invalid_claims: number
}

export type M3CaptureEvent =
  | ParticipantEnrolledEvent
  | PlanDeliveredEvent
  | PlanFinalizedEvent
  | NpsRecordedEvent
  | PoiAuditLockedEvent

export interface ParticipantProjection {
  participantKey: string
  invited: boolean
  consent: boolean
  testOrStaff: boolean
  simulation: M3SimulationProvenance | null
  enrolledAt: string
}

export interface PlanProjection {
  participantKey: string
  planKey: string
  attribution: M3Attribution
  deliveredAt: string
  finalizedAt?: string
  npsScore?: number
  npsRecordedAt?: string
  poiLockedAt?: string
  lockedClaims?: number
  invalidClaims?: number
}

export interface M3CaptureProjection {
  participants: Map<string, ParticipantProjection>
  plans: Map<string, PlanProjection>
}

export interface M3CohortCliResult {
  schema: 'gotry_m3_cohort_cli_result.v1'
  ok: true
  command: string
  status: CommandStatus
  cohort_ref?: string
  event_ref?: string
  evidence_kind?: M3EvidenceKind
  participant_key?: string
  plan_key?: string
  record_count?: number
  simulated_record_count?: number
  output_written?: boolean
}

// ---------------------------------------------------------------------------
// Validation primitives
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function assertRawLabel(value: unknown, limit = 512): string {
  if (!nonEmptyString(value)) fail('invalid_input')
  const text = value as string
  if (text.length > limit) fail('invalid_input')
  if (/[\u0000-\u001f\u007f]/u.test(text)) fail('invalid_input')
  return text
}

function assertIsoDate(date: Date): string {
  const ms = date.getTime()
  if (!Number.isFinite(ms)) fail('invalid_input')
  return date.toISOString()
}

function parseIsoMs(value: string): number {
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) fail('invalid_store')
  if (new Date(ms).toISOString() !== value) fail('invalid_store')
  return ms
}

function assertTimestampInput(value: unknown): string {
  const text = assertRawLabel(value, 64)
  const ms = Date.parse(text)
  if (!Number.isFinite(ms)) fail('invalid_input')
  if (new Date(ms).toISOString() !== text) fail('invalid_input')
  return text
}

function normalizeHmacKey(key: string | undefined): string {
  if (!nonEmptyString(key)) fail('missing_hmac_key')
  const trimmed = (key as string).trim()
  if (trimmed.length < 32) fail('invalid_hmac_key')
  if (/[\u0000-\u001f\u007f]/u.test(trimmed)) fail('invalid_hmac_key')
  return trimmed
}

function assertEvidenceKind(value: unknown): M3EvidenceKind {
  if (value !== 'real_seed_cohort' && value !== 'synthetic_fixture') fail('invalid_input')
  return value
}

function assertAttribution(value: unknown): M3Attribution {
  if (value !== 'gotry_primary' && value !== 'gotry_assisted') fail('invalid_input')
  return value
}

function assertNonNegativeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) fail('invalid_input')
  return value
}

function assertNpsScore(value: unknown): number {
  const score = assertNonNegativeInteger(value)
  if (score > 10) fail('invalid_input')
  return score
}

function assertHmacRef(value: unknown): string {
  if (!nonEmptyString(value) || !HMAC_REF_PATTERN.test(value as string)) fail('invalid_store')
  return value as string
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Domain-separated pseudonym. The `evidence_kind` is part of the domain: a record captured
 *  as synthetic cannot be relabelled real and still recompute to the same key. */
export function pseudonymousRef(hmacKey: string, kind: string, parts: readonly string[]): string {
  const key = normalizeHmacKey(hmacKey)
  const hmac = createHmac('sha256', key)
  hmac.update('gotry-m3-cohort.v1')
  hmac.update('\0')
  hmac.update(assertRawLabel(kind, 64))
  for (const part of parts) {
    hmac.update('\0')
    hmac.update(assertRawLabel(part, 2048))
  }
  return `hmac-sha256:${hmac.digest('hex')}`
}

export function participantKeyFor(hmacKey: string, evidenceKind: M3EvidenceKind, participant: string): string {
  return pseudonymousRef(hmacKey, `participant:${assertEvidenceKind(evidenceKind)}`, [assertRawLabel(participant)])
}

export function planKeyFor(hmacKey: string, evidenceKind: M3EvidenceKind, participant: string, plan: string): string {
  return pseudonymousRef(hmacKey, `plan:${assertEvidenceKind(evidenceKind)}`, [
    participantKeyFor(hmacKey, evidenceKind, participant),
    assertRawLabel(plan),
  ])
}

function cohortRefFor(hmacKey: string, cohort: string): string {
  return pseudonymousRef(hmacKey, 'cohort', [assertRawLabel(cohort)])
}

function cohortKeyVerifier(hmacKey: string): string {
  return pseudonymousRef(hmacKey, 'cohort-key-verifier', [M3_COHORT_STORE_SCHEMA])
}

function eventRef(hmacKey: string, kind: string, parts: readonly string[]): string {
  return pseudonymousRef(hmacKey, `event:${kind}`, parts)
}

export function assertSimulationProvenance(value: unknown): M3SimulationProvenance {
  if (!isObject(value)) fail('invalid_input')
  const expected = new Set(['schema_version', 'kind', 'persona_id', 'product_model', 'persona_model', 'prompt_digest'])
  for (const key of Object.keys(value)) if (!expected.has(key)) fail('invalid_input')
  if (value['schema_version'] !== M3_SIMULATION_PROVENANCE_SCHEMA) fail('invalid_input')
  if (value['kind'] !== 'llm_persona') fail('invalid_input')
  const personaId = assertRawLabel(value['persona_id'], 64)
  if (!PERSONA_ID_PATTERN.test(personaId)) fail('invalid_input')
  const productModel = assertRawLabel(value['product_model'], 96)
  const personaModel = assertRawLabel(value['persona_model'], 96)
  if (!MODEL_NAME_PATTERN.test(productModel) || !MODEL_NAME_PATTERN.test(personaModel)) fail('invalid_input')
  const digest = assertRawLabel(value['prompt_digest'], 64)
  if (!SHA256_PATTERN.test(digest)) fail('invalid_input')
  return {
    schema_version: M3_SIMULATION_PROVENANCE_SCHEMA,
    kind: 'llm_persona',
    persona_id: personaId,
    product_model: productModel,
    persona_model: personaModel,
    prompt_digest: digest,
  }
}

// ---------------------------------------------------------------------------
// Path safety / atomic private IO
// ---------------------------------------------------------------------------

function normalizePolicyPath(path: string): string {
  return resolve(path).replace(/\\/g, '/')
}

function assertSafePolicyPath(path: string): void {
  const normalized = normalizePolicyPath(path)
  if (normalized === '/' || normalized.endsWith('/.git') || normalized.includes('/.git/')) fail('unsafe_state_root')
  if (normalized.endsWith('/ts/dsh-runtime') || normalized.includes('/ts/dsh-runtime/')) fail('unsafe_state_root')
  if (normalized.endsWith('/.dsh') || normalized.includes('/.dsh/')) fail('unsafe_state_root')
  if (normalized.endsWith('/.gotry') || normalized.includes('/.gotry/')) fail('unsafe_state_root')
}

function nearestExistingAncestor(path: string): string {
  let current = resolve(path)
  for (;;) {
    if (existsSync(current)) return current
    const parent = dirname(current)
    if (parent === current) return current
    current = parent
  }
}

function realpathOrUnsafe(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    fail('unsafe_state_root')
  }
}

function sameOrChildPath(parent: string, child: string): boolean {
  const distance = relative(parent, child)
  return distance === '' || (!distance.startsWith('..') && !isAbsolute(distance))
}

function assertSafeStateRoot(stateRoot: string): string {
  if (!nonEmptyString(stateRoot)) fail('missing_state_root')
  const resolved = resolve(stateRoot)
  assertSafePolicyPath(resolved)
  assertSafePolicyPath(realpathOrUnsafe(nearestExistingAncestor(resolved)))
  return resolved
}

export function storeRootForStateRoot(stateRoot: string): string {
  return join(assertSafeStateRoot(stateRoot), 'gotry-state', 'm3-cohort')
}

function assertManagedStoreIsolation(storeRoot: string): void {
  const resolvedStoreRoot = resolve(storeRoot)
  const stateRoot = resolve(resolvedStoreRoot, '..', '..')
  assertSafePolicyPath(stateRoot)
  assertSafePolicyPath(resolvedStoreRoot)
  assertSafePolicyPath(realpathOrUnsafe(nearestExistingAncestor(stateRoot)))
  if (!existsSync(stateRoot)) return
  const stateRootReal = realpathOrUnsafe(stateRoot)
  assertSafePolicyPath(stateRootReal)
  for (const managedPath of [join(stateRoot, 'gotry-state'), resolvedStoreRoot]) {
    const existingReal = realpathOrUnsafe(nearestExistingAncestor(managedPath))
    assertSafePolicyPath(existingReal)
    if (!sameOrChildPath(stateRootReal, existingReal)) fail('unsafe_state_root')
  }
}

const OPEN_NOFOLLOW = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
let tempFileCounter = 0

function isNodeError(error: unknown, code: string): boolean {
  return isObject(error) && error['code'] === code
}

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  try { chmodSync(path, 0o700) } catch { /* best effort on non-POSIX filesystems */ }
}

function pathExistsByLstat(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false
    fail('unsafe_state_root')
  }
}

function assertNoSymlinkLeaf(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) fail('unsafe_state_root')
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return
    if (error instanceof M3CohortError) throw error
    fail('unsafe_state_root')
  }
}

function assertManagedFilePath(storeRoot: string, path: string): void {
  const resolvedStoreRoot = resolve(storeRoot)
  const resolvedPath = resolve(path)
  if (!sameOrChildPath(resolvedStoreRoot, resolvedPath)) fail('unsafe_state_root')
  assertSafePolicyPath(resolvedPath)
  assertManagedStoreIsolation(resolvedStoreRoot)
  const stateRootReal = realpathOrUnsafe(resolve(resolvedStoreRoot, '..', '..'))
  const parentReal = realpathOrUnsafe(nearestExistingAncestor(dirname(resolvedPath)))
  assertSafePolicyPath(parentReal)
  if (!sameOrChildPath(stateRootReal, parentReal)) fail('unsafe_state_root')
  assertNoSymlinkLeaf(resolvedPath)
}

function assertOutputPath(path: string): string {
  const resolvedPath = resolve(path)
  assertSafePolicyPath(resolvedPath)
  const parent = dirname(resolvedPath)
  assertSafePolicyPath(parent)
  assertSafePolicyPath(realpathOrUnsafe(nearestExistingAncestor(parent)))
  if (existsSync(parent)) assertSafePolicyPath(realpathOrUnsafe(parent))
  assertNoSymlinkLeaf(resolvedPath)
  return resolvedPath
}

function privateTempPath(path: string): string {
  tempFileCounter += 1
  return join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.${tempFileCounter}.${randomBytes(6).toString('hex')}.tmp`)
}

function writeAllSync(fd: number, content: string): void {
  const bytes = Buffer.from(content)
  let offset = 0
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset)
    if (!Number.isInteger(written) || written <= 0) fail('internal_error')
    offset += written
  }
}

function writePrivateTempFile(path: string, content: string): void {
  let fd = -1
  let created = false
  let caught: unknown
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | OPEN_NOFOLLOW, 0o600)
    created = true
    writeAllSync(fd, content)
  } catch (error) {
    caught = error
  } finally {
    if (fd >= 0) {
      try { closeSync(fd) } catch (error) { caught ??= error }
    }
    if (caught !== undefined && created) {
      try { unlinkSync(path) } catch { /* best effort temp cleanup */ }
    }
  }
  if (caught !== undefined) {
    if (caught instanceof M3CohortError) throw caught
    if (isNodeError(caught, 'ELOOP')) fail('unsafe_state_root')
    fail('internal_error')
  }
  try { chmodSync(path, 0o600) } catch { /* best effort */ }
}

function publishTempNoOverwrite(tempPath: string, finalPath: string, existsCode: M3CohortErrorCode): void {
  try {
    linkSync(tempPath, finalPath)
  } catch (error) {
    if (isNodeError(error, 'EEXIST')) fail(existsCode)
    fail('internal_error')
  }
}

function writeManagedFileNoOverwrite(storeRoot: string, path: string, content: string, existsCode: M3CohortErrorCode): void {
  assertManagedFilePath(storeRoot, path)
  ensurePrivateDir(dirname(path))
  assertManagedFilePath(storeRoot, path)
  if (pathExistsByLstat(path)) fail(existsCode)
  const tempPath = privateTempPath(path)
  let tempCreated = false
  try {
    assertManagedFilePath(storeRoot, tempPath)
    writePrivateTempFile(tempPath, content)
    tempCreated = true
    assertManagedFilePath(storeRoot, path)
    publishTempNoOverwrite(tempPath, path, existsCode)
  } finally {
    if (tempCreated) {
      try { unlinkSync(tempPath) } catch { /* best effort temp cleanup */ }
    }
  }
  try { chmodSync(path, 0o600) } catch { /* best effort */ }
}

function writeOutputFileNoOverwrite(path: string, content: string): void {
  const finalPath = assertOutputPath(path)
  ensurePrivateDir(dirname(finalPath))
  assertOutputPath(finalPath)
  if (pathExistsByLstat(finalPath)) fail('output_exists')
  const tempPath = privateTempPath(finalPath)
  let tempCreated = false
  try {
    assertOutputPath(tempPath)
    writePrivateTempFile(tempPath, content)
    tempCreated = true
    assertOutputPath(finalPath)
    if (pathExistsByLstat(finalPath)) fail('output_exists')
    publishTempNoOverwrite(tempPath, finalPath, 'output_exists')
  } finally {
    if (tempCreated) {
      try { unlinkSync(tempPath) } catch { /* best effort temp cleanup */ }
    }
  }
  try { chmodSync(finalPath, 0o600) } catch { /* best effort */ }
}

function appendPrivateLine(storeRoot: string, path: string, line: string): void {
  assertManagedFilePath(storeRoot, path)
  ensurePrivateDir(dirname(path))
  assertManagedFilePath(storeRoot, path)
  const existedBefore = pathExistsByLstat(path)
  const originalSize = existedBefore ? statSync(path).size : 0
  let fd = -1
  let caught: unknown
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | OPEN_NOFOLLOW, 0o600)
    writeAllSync(fd, `${line}\n`)
  } catch (error) {
    caught = error
    if (fd >= 0) {
      try { ftruncateSync(fd, originalSize) } catch { /* keep original error */ }
    }
  } finally {
    if (fd >= 0) {
      try { closeSync(fd) } catch { /* close is non-semantic after append/truncate */ }
    }
    if (caught !== undefined && !existedBefore) {
      try { unlinkSync(path) } catch { /* best effort rollback */ }
    }
  }
  if (caught !== undefined) {
    if (caught instanceof M3CohortError) throw caught
    if (isNodeError(caught, 'ELOOP')) fail('unsafe_state_root')
    fail('internal_error')
  }
  try { chmodSync(path, 0o600) } catch { /* best effort */ }
}

function withStoreLock<T>(storeRoot: string, createStore: boolean, body: () => T): T {
  assertManagedStoreIsolation(storeRoot)
  if (createStore) ensurePrivateDir(storeRoot)
  else if (!existsSync(storeRoot)) fail('cohort_not_initialized')
  assertManagedStoreIsolation(storeRoot)

  const lockPath = join(storeRoot, '.writer.lock')
  assertManagedFilePath(storeRoot, lockPath)
  let fd = -1
  let createdLock = false
  try {
    fd = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | OPEN_NOFOLLOW, 0o600)
    createdLock = true
    writeAllSync(fd, JSON.stringify({ schema_version: 'gotry_m3_cohort_lock.v1', pid: process.pid }))
  } catch (error) {
    if (fd >= 0) {
      try { closeSync(fd) } catch { /* preserve original error */ }
      fd = -1
    }
    if (createdLock) {
      try { unlinkSync(lockPath) } catch { /* best effort for this writer's failed lock */ }
    }
    if (isNodeError(error, 'EEXIST')) fail('lock_busy')
    fail('internal_error')
  } finally {
    if (fd >= 0) closeSync(fd)
  }

  try {
    assertManagedStoreIsolation(storeRoot)
    return body()
  } finally {
    try { unlinkSync(lockPath) } catch { /* lock cleanup is best effort */ }
  }
}

// ---------------------------------------------------------------------------
// Store read/write
// ---------------------------------------------------------------------------

function manifestPath(storeRoot: string): string {
  return join(storeRoot, 'manifest.json')
}

function eventsPath(storeRoot: string): string {
  return join(storeRoot, 'events.jsonl')
}

export interface CommonCommandOptions {
  stateRoot: string
  consent: string
  hmacKey: string | undefined
}

interface PreparedCommon {
  consentRef: string
  hmacKey: string
  stateRoot: string
  storeRoot: string
}

function prepareCommon(options: CommonCommandOptions): PreparedCommon {
  const stateRoot = assertSafeStateRoot(options.stateRoot)
  if (!nonEmptyString(options.consent)) fail('missing_consent')
  const hmacKey = normalizeHmacKey(options.hmacKey)
  const consent = assertRawLabel(options.consent, 512)
  return {
    consentRef: pseudonymousRef(hmacKey, 'consent', [consent]),
    hmacKey,
    stateRoot,
    storeRoot: join(stateRoot, 'gotry-state', 'm3-cohort'),
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const expected = new Set(keys)
  for (const key of Object.keys(value)) if (!expected.has(key)) fail('invalid_store')
  for (const key of keys) if (!(key in value)) fail('invalid_store')
}

function assertEvidenceManifest(value: unknown): M3EvidenceManifest {
  if (!isObject(value)) fail('invalid_store')
  exactKeys(value, ['schema_version', 'evidence_kind', 'cohort_id', 'locked_at', 'window', 'eligibility', 'metrics', 'nightly'])
  if (value['schema_version'] !== M3_EVIDENCE_MANIFEST_SCHEMA) fail('invalid_store')
  const window = value['window']
  const eligibility = value['eligibility']
  const metrics = value['metrics']
  const nightly = value['nightly']
  if (!isObject(window) || !isObject(eligibility) || !isObject(metrics) || !isObject(nightly)) fail('invalid_store')
  exactKeys(window, ['start_at', 'end_at', 'timezone'])
  exactKeys(eligibility, ['sample_unit', 'requires_invitation', 'requires_consent', 'allowed_attribution', 'exclusion_codes'])
  exactKeys(metrics, ['sample_size', 'finalization_rate', 'nps', 'poi_hallucination_rate'])
  exactKeys(nightly, ['requires_real_llm', 'requires_prompt_set_sha256', 'requires_output_sha256', 'requires_cost_usd'])
  const kind = value['evidence_kind']
  if (kind !== 'real_seed_cohort' && kind !== 'synthetic_fixture') fail('invalid_store')
  if (!nonEmptyString(value['cohort_id'])) fail('invalid_store')
  parseIsoMs(String(value['locked_at']))
  const startAt = String(window['start_at'])
  const endAt = String(window['end_at'])
  if (parseIsoMs(startAt) > parseIsoMs(endAt)) fail('invalid_store')
  if (eligibility['sample_unit'] !== 'unique_participant_with_eligible_delivered_plan') fail('invalid_store')
  if (eligibility['requires_invitation'] !== true || eligibility['requires_consent'] !== true) fail('invalid_store')
  const attribution = eligibility['allowed_attribution']
  if (!Array.isArray(attribution) || attribution.length === 0) fail('invalid_store')
  const allowed = attribution.map(item => {
    if (item !== 'gotry_primary' && item !== 'gotry_assisted') fail('invalid_store')
    return item
  })
  if (new Set(allowed).size !== allowed.length) fail('invalid_store')
  const exclusions = eligibility['exclusion_codes']
  if (!Array.isArray(exclusions)) fail('invalid_store')
  if (canonicalJson([...exclusions].sort()) !== canonicalJson([...M3_EXCLUSION_CODES].sort())) fail('invalid_store')
  const sampleSize = metrics['sample_size']
  const finalization = metrics['finalization_rate']
  const nps = metrics['nps']
  const poi = metrics['poi_hallucination_rate']
  if (!isObject(sampleSize) || !isObject(finalization) || !isObject(nps) || !isObject(poi)) fail('invalid_store')
  exactKeys(sampleSize, ['minimum', 'maximum'])
  exactKeys(finalization, ['formula', 'minimum'])
  exactKeys(nps, ['formula', 'minimum'])
  exactKeys(poi, ['formula', 'exclusive_maximum'])
  if (sampleSize['minimum'] !== M3_ACCEPTANCE.sampleMinimum || sampleSize['maximum'] !== M3_ACCEPTANCE.sampleMaximum) fail('invalid_store')
  if (finalization['formula'] !== M3_FORMULAS.finalization || finalization['minimum'] !== M3_ACCEPTANCE.finalizationMinimum) fail('invalid_store')
  if (nps['formula'] !== M3_FORMULAS.nps || nps['minimum'] !== M3_ACCEPTANCE.npsMinimum) fail('invalid_store')
  if (poi['formula'] !== M3_FORMULAS.poi || poi['exclusive_maximum'] !== M3_ACCEPTANCE.poiExclusiveMaximum) fail('invalid_store')
  if (nightly['requires_real_llm'] !== true || nightly['requires_prompt_set_sha256'] !== true) fail('invalid_store')
  if (nightly['requires_output_sha256'] !== true || nightly['requires_cost_usd'] !== true) fail('invalid_store')
  return {
    schema_version: M3_EVIDENCE_MANIFEST_SCHEMA,
    evidence_kind: kind,
    cohort_id: String(value['cohort_id']),
    locked_at: String(value['locked_at']),
    window: { start_at: startAt, end_at: endAt, timezone: String(window['timezone']) },
    eligibility: {
      sample_unit: 'unique_participant_with_eligible_delivered_plan',
      requires_invitation: true,
      requires_consent: true,
      allowed_attribution: allowed as M3Attribution[],
      exclusion_codes: [...M3_EXCLUSION_CODES],
    },
    metrics: {
      sample_size: { minimum: M3_ACCEPTANCE.sampleMinimum, maximum: M3_ACCEPTANCE.sampleMaximum },
      finalization_rate: { formula: M3_FORMULAS.finalization, minimum: M3_ACCEPTANCE.finalizationMinimum },
      nps: { formula: M3_FORMULAS.nps, minimum: M3_ACCEPTANCE.npsMinimum },
      poi_hallucination_rate: { formula: M3_FORMULAS.poi, exclusive_maximum: M3_ACCEPTANCE.poiExclusiveMaximum },
    },
    nightly: {
      requires_real_llm: true,
      requires_prompt_set_sha256: true,
      requires_output_sha256: true,
      requires_cost_usd: true,
    },
  }
}

function assertCaptureManifest(value: unknown): M3CaptureManifest {
  if (!isObject(value)) fail('invalid_store')
  exactKeys(value, ['schema_version', 'capture_schema', 'cohort_ref', 'cohort_key_verifier', 'created_at', 'consent_ref', 'evidence_manifest'])
  if (value['schema_version'] !== M3_COHORT_MANIFEST_SCHEMA) fail('invalid_store')
  if (value['capture_schema'] !== M3_COHORT_STORE_SCHEMA) fail('invalid_store')
  const cohortRef = assertHmacRef(value['cohort_ref'])
  const verifier = assertHmacRef(value['cohort_key_verifier'])
  const consentRef = assertHmacRef(value['consent_ref'])
  parseIsoMs(String(value['created_at']))
  return {
    schema_version: M3_COHORT_MANIFEST_SCHEMA,
    capture_schema: M3_COHORT_STORE_SCHEMA,
    cohort_ref: cohortRef,
    cohort_key_verifier: verifier,
    created_at: String(value['created_at']),
    consent_ref: consentRef,
    evidence_manifest: assertEvidenceManifest(value['evidence_manifest']),
  }
}

function readManifest(storeRoot: string): M3CaptureManifest {
  const path = manifestPath(storeRoot)
  assertManagedFilePath(storeRoot, path)
  if (!existsSync(path)) fail('cohort_not_initialized')
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    fail('invalid_store')
  }
  return assertCaptureManifest(parsed)
}

function assertCaptureEvent(value: unknown): M3CaptureEvent {
  if (!isObject(value)) fail('invalid_store')
  if (value['schema_version'] !== M3_COHORT_EVENT_SCHEMA) fail('invalid_store')
  const base = {
    schema_version: M3_COHORT_EVENT_SCHEMA as typeof M3_COHORT_EVENT_SCHEMA,
    event_ref: assertHmacRef(value['event_ref']),
    occurred_at: (() => { parseIsoMs(String(value['occurred_at'])); return String(value['occurred_at']) })(),
    consent_ref: assertHmacRef(value['consent_ref']),
  }
  switch (value['kind']) {
    case 'participant_enrolled': {
      exactKeys(value, ['schema_version', 'event_ref', 'kind', 'occurred_at', 'consent_ref', 'participant_key', 'invited', 'consent', 'test_or_staff', 'simulation'])
      for (const flag of ['invited', 'consent', 'test_or_staff'] as const) {
        if (typeof value[flag] !== 'boolean') fail('invalid_store')
      }
      const simulation = value['simulation']
      let parsedSimulation: M3SimulationProvenance | null = null
      if (simulation !== null) {
        try {
          parsedSimulation = assertSimulationProvenance(simulation)
        } catch {
          fail('invalid_store')
        }
      }
      return {
        ...base,
        kind: 'participant_enrolled',
        participant_key: assertHmacRef(value['participant_key']),
        invited: value['invited'] as boolean,
        consent: value['consent'] as boolean,
        test_or_staff: value['test_or_staff'] as boolean,
        simulation: parsedSimulation,
      }
    }
    case 'plan_delivered': {
      exactKeys(value, ['schema_version', 'event_ref', 'kind', 'occurred_at', 'consent_ref', 'participant_key', 'plan_key', 'attribution'])
      const attribution = value['attribution']
      if (attribution !== 'gotry_primary' && attribution !== 'gotry_assisted') fail('invalid_store')
      return {
        ...base,
        kind: 'plan_delivered',
        participant_key: assertHmacRef(value['participant_key']),
        plan_key: assertHmacRef(value['plan_key']),
        attribution,
      }
    }
    case 'plan_finalized': {
      exactKeys(value, ['schema_version', 'event_ref', 'kind', 'occurred_at', 'consent_ref', 'participant_key', 'plan_key'])
      return {
        ...base,
        kind: 'plan_finalized',
        participant_key: assertHmacRef(value['participant_key']),
        plan_key: assertHmacRef(value['plan_key']),
      }
    }
    case 'nps_recorded': {
      exactKeys(value, ['schema_version', 'event_ref', 'kind', 'occurred_at', 'consent_ref', 'participant_key', 'plan_key', 'nps_score'])
      const score = value['nps_score']
      if (typeof score !== 'number' || !Number.isInteger(score) || score < 0 || score > 10) fail('invalid_store')
      return {
        ...base,
        kind: 'nps_recorded',
        participant_key: assertHmacRef(value['participant_key']),
        plan_key: assertHmacRef(value['plan_key']),
        nps_score: score,
      }
    }
    case 'poi_audit_locked': {
      exactKeys(value, ['schema_version', 'event_ref', 'kind', 'occurred_at', 'consent_ref', 'participant_key', 'plan_key', 'locked_claims', 'invalid_claims'])
      const locked = value['locked_claims']
      const invalid = value['invalid_claims']
      if (typeof locked !== 'number' || !Number.isInteger(locked) || locked < 0) fail('invalid_store')
      if (typeof invalid !== 'number' || !Number.isInteger(invalid) || invalid < 0 || invalid > locked) fail('invalid_store')
      return {
        ...base,
        kind: 'poi_audit_locked',
        participant_key: assertHmacRef(value['participant_key']),
        plan_key: assertHmacRef(value['plan_key']),
        locked_claims: locked,
        invalid_claims: invalid,
      }
    }
    default:
      fail('invalid_store')
  }
}

function readEvents(storeRoot: string): M3CaptureEvent[] {
  const path = eventsPath(storeRoot)
  assertManagedFilePath(storeRoot, path)
  if (!existsSync(path)) return []
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    fail('invalid_store')
  }
  const events: M3CaptureEvent[] = []
  const seen = new Map<string, string>()
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      fail('invalid_store')
    }
    const event = assertCaptureEvent(parsed)
    const canonical = canonicalJson(event)
    const prior = seen.get(event.event_ref)
    if (prior !== undefined) {
      if (prior !== canonical) fail('invalid_store')
      continue
    }
    seen.set(event.event_ref, canonical)
    events.push(event)
  }
  return events
}

export function projectCaptureEvents(events: readonly M3CaptureEvent[]): M3CaptureProjection {
  const participants = new Map<string, ParticipantProjection>()
  const plans = new Map<string, PlanProjection>()
  const npsByParticipant = new Set<string>()

  for (const event of events) {
    switch (event.kind) {
      case 'participant_enrolled': {
        if (participants.has(event.participant_key)) fail('invalid_store')
        participants.set(event.participant_key, {
          participantKey: event.participant_key,
          invited: event.invited,
          consent: event.consent,
          testOrStaff: event.test_or_staff,
          simulation: event.simulation,
          enrolledAt: event.occurred_at,
        })
        break
      }
      case 'plan_delivered': {
        const participant = participants.get(event.participant_key)
        if (!participant) fail('invalid_store')
        if (plans.has(event.plan_key)) fail('invalid_store')
        if (parseIsoMs(event.occurred_at) < parseIsoMs(participant.enrolledAt)) fail('invalid_store')
        plans.set(event.plan_key, {
          participantKey: event.participant_key,
          planKey: event.plan_key,
          attribution: event.attribution,
          deliveredAt: event.occurred_at,
        })
        break
      }
      case 'plan_finalized': {
        const plan = plans.get(event.plan_key)
        if (!plan || plan.participantKey !== event.participant_key || plan.finalizedAt !== undefined) fail('invalid_store')
        if (parseIsoMs(event.occurred_at) < parseIsoMs(plan.deliveredAt)) fail('invalid_store')
        plan.finalizedAt = event.occurred_at
        break
      }
      case 'nps_recorded': {
        const plan = plans.get(event.plan_key)
        if (!plan || plan.participantKey !== event.participant_key || plan.npsScore !== undefined) fail('invalid_store')
        if (npsByParticipant.has(event.participant_key)) fail('invalid_store')
        if (parseIsoMs(event.occurred_at) < parseIsoMs(plan.deliveredAt)) fail('invalid_store')
        npsByParticipant.add(event.participant_key)
        plan.npsScore = event.nps_score
        plan.npsRecordedAt = event.occurred_at
        break
      }
      case 'poi_audit_locked': {
        const plan = plans.get(event.plan_key)
        if (!plan || plan.participantKey !== event.participant_key || plan.poiLockedAt !== undefined) fail('invalid_store')
        if (parseIsoMs(event.occurred_at) < parseIsoMs(plan.deliveredAt)) fail('invalid_store')
        plan.poiLockedAt = event.occurred_at
        plan.lockedClaims = event.locked_claims
        plan.invalidClaims = event.invalid_claims
        break
      }
    }
  }
  return { participants, plans }
}

function assertCandidateProjection(events: readonly M3CaptureEvent[], event: M3CaptureEvent): void {
  try {
    projectCaptureEvents([...events, event])
  } catch (error) {
    if (error instanceof M3CohortError && error.code === 'invalid_store') fail('invalid_transition')
    throw error
  }
}

function appendEvent(storeRoot: string, events: readonly M3CaptureEvent[], event: M3CaptureEvent): void {
  assertCandidateProjection(events, event)
  assertManagedStoreIsolation(storeRoot)
  appendPrivateLine(storeRoot, eventsPath(storeRoot), JSON.stringify(event))
}

function eventExists(events: readonly M3CaptureEvent[], ref: string): boolean {
  return events.some(event => event.event_ref === ref)
}

function assertCohortKeyMatches(manifest: M3CaptureManifest, hmacKey: string): void {
  if (manifest.cohort_key_verifier !== cohortKeyVerifier(hmacKey)) fail('cohort_key_mismatch')
}

function loadLockedStore(common: PreparedCommon): { manifest: M3CaptureManifest; events: M3CaptureEvent[]; projection: M3CaptureProjection } {
  const manifest = readManifest(common.storeRoot)
  assertCohortKeyMatches(manifest, common.hmacKey)
  if (manifest.consent_ref !== common.consentRef) fail('cohort_consent_mismatch')
  const events = readEvents(common.storeRoot)
  if (events.some(event => event.consent_ref !== manifest.consent_ref)) fail('invalid_store')
  return { manifest, events, projection: projectCaptureEvents(events) }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export interface InitCohortOptions extends CommonCommandOptions {
  cohort: string
  evidenceKind: M3EvidenceKind
  windowStartAt: string
  windowEndAt: string
  timezone: string
  allowedAttribution: M3Attribution[]
}

function buildEvidenceManifest(options: InitCohortOptions, cohortRef: string, lockedAt: string): M3EvidenceManifest {
  const kind = assertEvidenceKind(options.evidenceKind)
  const startAt = assertTimestampInput(options.windowStartAt)
  const endAt = assertTimestampInput(options.windowEndAt)
  if (Date.parse(startAt) > Date.parse(endAt)) fail('invalid_input')
  const timezone = assertRawLabel(options.timezone, 64)
  if (!Array.isArray(options.allowedAttribution) || options.allowedAttribution.length === 0) fail('invalid_input')
  const allowed = options.allowedAttribution.map(assertAttribution)
  if (new Set(allowed).size !== allowed.length) fail('invalid_input')
  return {
    schema_version: M3_EVIDENCE_MANIFEST_SCHEMA,
    evidence_kind: kind,
    // The cohort id published into the evidence root is itself the pseudonym: an operator
    // label never crosses into the evidence face.
    cohort_id: cohortRef,
    locked_at: lockedAt,
    window: { start_at: startAt, end_at: endAt, timezone },
    eligibility: {
      sample_unit: 'unique_participant_with_eligible_delivered_plan',
      requires_invitation: true,
      requires_consent: true,
      allowed_attribution: allowed,
      exclusion_codes: [...M3_EXCLUSION_CODES],
    },
    metrics: {
      sample_size: { minimum: M3_ACCEPTANCE.sampleMinimum, maximum: M3_ACCEPTANCE.sampleMaximum },
      finalization_rate: { formula: M3_FORMULAS.finalization, minimum: M3_ACCEPTANCE.finalizationMinimum },
      nps: { formula: M3_FORMULAS.nps, minimum: M3_ACCEPTANCE.npsMinimum },
      poi_hallucination_rate: { formula: M3_FORMULAS.poi, exclusive_maximum: M3_ACCEPTANCE.poiExclusiveMaximum },
    },
    nightly: {
      requires_real_llm: true,
      requires_prompt_set_sha256: true,
      requires_output_sha256: true,
      requires_cost_usd: true,
    },
  }
}

function sameFrozenCohort(existing: M3CaptureManifest, next: M3CaptureManifest): boolean {
  return existing.cohort_ref === next.cohort_ref
    && existing.cohort_key_verifier === next.cohort_key_verifier
    && existing.consent_ref === next.consent_ref
    && canonicalJson({ ...existing.evidence_manifest, locked_at: '' }) === canonicalJson({ ...next.evidence_manifest, locked_at: '' })
}

export function initM3Cohort(options: InitCohortOptions, clock: Clock = systemClock): M3CohortCliResult {
  const common = prepareCommon(options)
  const cohortRef = cohortRefFor(common.hmacKey, options.cohort)
  const next: M3CaptureManifest = {
    schema_version: M3_COHORT_MANIFEST_SCHEMA,
    capture_schema: M3_COHORT_STORE_SCHEMA,
    cohort_ref: cohortRef,
    cohort_key_verifier: cohortKeyVerifier(common.hmacKey),
    created_at: assertIsoDate(clock.now()),
    consent_ref: common.consentRef,
    evidence_manifest: buildEvidenceManifest(options, cohortRef, assertIsoDate(clock.now())),
  }
  return withStoreLock(common.storeRoot, true, () => {
    const path = manifestPath(common.storeRoot)
    if (existsSync(path)) {
      const existing = readManifest(common.storeRoot)
      assertCohortKeyMatches(existing, common.hmacKey)
      if (existing.consent_ref !== next.consent_ref) fail('cohort_consent_mismatch')
      if (existing.evidence_manifest.evidence_kind !== next.evidence_manifest.evidence_kind) fail('evidence_kind_mismatch')
      if (!sameFrozenCohort(existing, next)) fail('cohort_already_initialized')
      return {
        schema: 'gotry_m3_cohort_cli_result.v1',
        ok: true,
        command: 'init',
        status: 'unchanged',
        cohort_ref: existing.cohort_ref,
        evidence_kind: existing.evidence_manifest.evidence_kind,
      }
    }
    writeManagedFileNoOverwrite(common.storeRoot, path, `${JSON.stringify(next, null, 2)}\n`, 'cohort_already_initialized')
    return {
      schema: 'gotry_m3_cohort_cli_result.v1',
      ok: true,
      command: 'init',
      status: 'recorded',
      cohort_ref: next.cohort_ref,
      evidence_kind: next.evidence_manifest.evidence_kind,
    }
  })
}

export interface EnrollOptions extends CommonCommandOptions {
  participant: string
  invited: boolean
  participantConsent: boolean
  testOrStaff: boolean
  simulation?: M3SimulationProvenance
}

export function enrollParticipant(options: EnrollOptions, clock: Clock = systemClock): M3CohortCliResult {
  const common = prepareCommon(options)
  const participantLabel = assertRawLabel(options.participant)
  for (const flag of [options.invited, options.participantConsent, options.testOrStaff]) {
    if (typeof flag !== 'boolean') fail('invalid_input')
  }
  const simulation = options.simulation === undefined ? null : assertSimulationProvenance(options.simulation)
  return withStoreLock(common.storeRoot, false, () => {
    const { manifest, events } = loadLockedStore(common)
    const kind = manifest.evidence_manifest.evidence_kind
    // The two evidence kinds are mutually exclusive by construction: a simulated
    // participant can never enter a real cohort, and an unlabelled participant can never
    // enter a synthetic one.
    if (kind === 'real_seed_cohort' && simulation !== null) fail('simulation_forbidden_in_real_cohort')
    if (kind === 'synthetic_fixture' && simulation === null) fail('simulation_label_required')
    const participantKey = participantKeyFor(common.hmacKey, kind, participantLabel)
    const ref = eventRef(common.hmacKey, 'participant_enrolled', [
      participantKey,
      String(options.invited),
      String(options.participantConsent),
      String(options.testOrStaff),
      simulation === null ? 'none' : canonicalJson(simulation),
    ])
    if (eventExists(events, ref)) {
      return { schema: 'gotry_m3_cohort_cli_result.v1', ok: true, command: 'enroll', status: 'unchanged', event_ref: ref, participant_key: participantKey }
    }
    const event: ParticipantEnrolledEvent = {
      schema_version: M3_COHORT_EVENT_SCHEMA,
      event_ref: ref,
      kind: 'participant_enrolled',
      occurred_at: assertIsoDate(clock.now()),
      consent_ref: common.consentRef,
      participant_key: participantKey,
      invited: options.invited,
      consent: options.participantConsent,
      test_or_staff: options.testOrStaff,
      simulation,
    }
    appendEvent(common.storeRoot, events, event)
    return { schema: 'gotry_m3_cohort_cli_result.v1', ok: true, command: 'enroll', status: 'recorded', event_ref: ref, participant_key: participantKey }
  })
}

interface PlanCommandContext {
  common: PreparedCommon
  manifest: M3CaptureManifest
  events: M3CaptureEvent[]
  participantKey: string
  planKey: string
}

function withPlanContext<T>(
  options: CommonCommandOptions & { participant: string; plan: string },
  body: (context: PlanCommandContext) => T,
): T {
  const common = prepareCommon(options)
  const participantLabel = assertRawLabel(options.participant)
  const planLabel = assertRawLabel(options.plan)
  return withStoreLock(common.storeRoot, false, () => {
    const { manifest, events } = loadLockedStore(common)
    const kind = manifest.evidence_manifest.evidence_kind
    return body({
      common,
      manifest,
      events,
      participantKey: participantKeyFor(common.hmacKey, kind, participantLabel),
      planKey: planKeyFor(common.hmacKey, kind, participantLabel, planLabel),
    })
  })
}

export interface DeliverOptions extends CommonCommandOptions {
  participant: string
  plan: string
  attribution: M3Attribution
}

export function recordPlanDelivered(options: DeliverOptions, clock: Clock = systemClock): M3CohortCliResult {
  const attribution = assertAttribution(options.attribution)
  return withPlanContext(options, ({ common, events, participantKey, planKey }) => {
    const ref = eventRef(common.hmacKey, 'plan_delivered', [participantKey, planKey, attribution])
    if (eventExists(events, ref)) {
      return { schema: 'gotry_m3_cohort_cli_result.v1', ok: true, command: 'deliver', status: 'unchanged', event_ref: ref, plan_key: planKey } as M3CohortCliResult
    }
    const event: PlanDeliveredEvent = {
      schema_version: M3_COHORT_EVENT_SCHEMA,
      event_ref: ref,
      kind: 'plan_delivered',
      occurred_at: assertIsoDate(clock.now()),
      consent_ref: common.consentRef,
      participant_key: participantKey,
      plan_key: planKey,
      attribution,
    }
    appendEvent(common.storeRoot, events, event)
    return { schema: 'gotry_m3_cohort_cli_result.v1', ok: true, command: 'deliver', status: 'recorded', event_ref: ref, plan_key: planKey } as M3CohortCliResult
  })
}

export function recordPlanFinalized(
  options: CommonCommandOptions & { participant: string; plan: string },
  clock: Clock = systemClock,
): M3CohortCliResult {
  return withPlanContext(options, ({ common, events, participantKey, planKey }) => {
    const ref = eventRef(common.hmacKey, 'plan_finalized', [participantKey, planKey])
    if (eventExists(events, ref)) {
      return { schema: 'gotry_m3_cohort_cli_result.v1', ok: true, command: 'finalize', status: 'unchanged', event_ref: ref, plan_key: planKey } as M3CohortCliResult
    }
    const event: PlanFinalizedEvent = {
      schema_version: M3_COHORT_EVENT_SCHEMA,
      event_ref: ref,
      kind: 'plan_finalized',
      occurred_at: assertIsoDate(clock.now()),
      consent_ref: common.consentRef,
      participant_key: participantKey,
      plan_key: planKey,
    }
    appendEvent(common.storeRoot, events, event)
    return { schema: 'gotry_m3_cohort_cli_result.v1', ok: true, command: 'finalize', status: 'recorded', event_ref: ref, plan_key: planKey } as M3CohortCliResult
  })
}

export interface NpsOptions extends CommonCommandOptions {
  participant: string
  plan: string
  score: number
}

export function recordNps(options: NpsOptions, clock: Clock = systemClock): M3CohortCliResult {
  const score = assertNpsScore(options.score)
  return withPlanContext(options, ({ common, events, participantKey, planKey }) => {
    const ref = eventRef(common.hmacKey, 'nps_recorded', [participantKey, planKey, String(score)])
    if (eventExists(events, ref)) {
      return { schema: 'gotry_m3_cohort_cli_result.v1', ok: true, command: 'nps', status: 'unchanged', event_ref: ref, plan_key: planKey } as M3CohortCliResult
    }
    const event: NpsRecordedEvent = {
      schema_version: M3_COHORT_EVENT_SCHEMA,
      event_ref: ref,
      kind: 'nps_recorded',
      occurred_at: assertIsoDate(clock.now()),
      consent_ref: common.consentRef,
      participant_key: participantKey,
      plan_key: planKey,
      nps_score: score,
    }
    appendEvent(common.storeRoot, events, event)
    return { schema: 'gotry_m3_cohort_cli_result.v1', ok: true, command: 'nps', status: 'recorded', event_ref: ref, plan_key: planKey } as M3CohortCliResult
  })
}

export interface PoiLockOptions extends CommonCommandOptions {
  participant: string
  plan: string
  lockedClaims: number
  invalidClaims: number
}

export function recordPoiLock(options: PoiLockOptions, clock: Clock = systemClock): M3CohortCliResult {
  const locked = assertNonNegativeInteger(options.lockedClaims)
  const invalid = assertNonNegativeInteger(options.invalidClaims)
  if (invalid > locked) fail('invalid_input')
  return withPlanContext(options, ({ common, events, participantKey, planKey }) => {
    const ref = eventRef(common.hmacKey, 'poi_audit_locked', [participantKey, planKey, String(locked), String(invalid)])
    if (eventExists(events, ref)) {
      return { schema: 'gotry_m3_cohort_cli_result.v1', ok: true, command: 'poi-lock', status: 'unchanged', event_ref: ref, plan_key: planKey } as M3CohortCliResult
    }
    const event: PoiAuditLockedEvent = {
      schema_version: M3_COHORT_EVENT_SCHEMA,
      event_ref: ref,
      kind: 'poi_audit_locked',
      occurred_at: assertIsoDate(clock.now()),
      consent_ref: common.consentRef,
      participant_key: participantKey,
      plan_key: planKey,
      locked_claims: locked,
      invalid_claims: invalid,
    }
    appendEvent(common.storeRoot, events, event)
    return { schema: 'gotry_m3_cohort_cli_result.v1', ok: true, command: 'poi-lock', status: 'recorded', event_ref: ref, plan_key: planKey } as M3CohortCliResult
  })
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface M3ExportPayload {
  manifest: M3EvidenceManifest
  cohort: M3CohortRecord[]
  provenance: M3SimulationProvenanceRow[]
  attestation: M3ExportAttestation
}

/** Build the evidence payload from the capture store. A plan without a locked POI audit is
 *  not exportable: the scorer requires `poi_audit`, and inventing one would be fabrication. */
export function buildExportPayload(
  manifest: M3CaptureManifest,
  events: readonly M3CaptureEvent[],
  exportedAt: string,
): M3ExportPayload {
  const projection = projectCaptureEvents(events)
  const evidenceKind = manifest.evidence_manifest.evidence_kind
  const cohort: M3CohortRecord[] = []
  const provenance: M3SimulationProvenanceRow[] = []
  const plans = [...projection.plans.values()].sort((a, b) => a.planKey.localeCompare(b.planKey))
  for (const plan of plans) {
    const participant = projection.participants.get(plan.participantKey)
    if (!participant) fail('invalid_store')
    if (plan.poiLockedAt === undefined || plan.lockedClaims === undefined || plan.invalidClaims === undefined) continue
    // The capture-side kind gate is re-asserted at export: nothing may slip through a
    // store that was mutated between commands.
    if (evidenceKind === 'real_seed_cohort' && participant.simulation !== null) fail('simulation_forbidden_in_real_cohort')
    if (evidenceKind === 'synthetic_fixture' && participant.simulation === null) fail('simulation_label_required')
    cohort.push({
      schema_version: M3_COHORT_RECORD_SCHEMA,
      participant_key: plan.participantKey,
      plan_key: plan.planKey,
      invited: participant.invited,
      consent: participant.consent,
      test_or_staff: participant.testOrStaff,
      attribution: plan.attribution,
      delivered_at: plan.deliveredAt,
      finalized_at: plan.finalizedAt ?? null,
      nps_score: plan.npsScore ?? null,
      nps_recorded_at: plan.npsRecordedAt ?? null,
      poi_audit: { locked_at: plan.poiLockedAt, locked_claims: plan.lockedClaims, invalid_claims: plan.invalidClaims },
    })
    if (participant.simulation !== null) {
      provenance.push({ ...participant.simulation, participant_key: plan.participantKey, plan_key: plan.planKey })
    }
  }

  const manifestBytes = `${JSON.stringify(manifest.evidence_manifest, null, 2)}\n`
  const recordLines = cohort.map(record => JSON.stringify(record))
  const provenanceBytes = provenance.map(row => JSON.stringify(row)).join('\n') + (provenance.length > 0 ? '\n' : '')
  const attestation: M3ExportAttestation = {
    schema_version: M3_EXPORT_ATTESTATION_SCHEMA,
    cohort_id: manifest.evidence_manifest.cohort_id,
    evidence_kind: evidenceKind,
    exported_at: exportedAt,
    record_count: cohort.length,
    simulated_record_count: provenance.length,
    capture_manifest_digest_sha256: sha256Hex(canonicalJson(manifest)),
    manifest_sha256: sha256Hex(manifestBytes),
    cohort_records_sha256: cohortRecordsDigest(recordLines),
    provenance_jsonl_sha256: sha256Hex(provenanceBytes),
  }
  return { manifest: manifest.evidence_manifest, cohort, provenance, attestation }
}

export interface ExportOptions extends CommonCommandOptions {
  evidenceRoot: string
  /** Consumer-side validation hook. The CLI injects `scripts/product-metrics.ts` so nothing
   *  is written that the real scorer cannot read; it throws to refuse the export. */
  validate?: (payload: M3ExportPayload) => void
}

export function exportM3Cohort(options: ExportOptions, clock: Clock = systemClock): { payload: M3ExportPayload; result: M3CohortCliResult } {
  const common = prepareCommon(options)
  const evidenceRoot = assertOutputPath(assertRawLabel(options.evidenceRoot, 4096))
  return withStoreLock(common.storeRoot, false, () => {
    const { manifest, events } = loadLockedStore(common)
    const payload = buildExportPayload(manifest, events, assertIsoDate(clock.now()))

    // An evidence root that already carries an attestation of a different kind is never
    // appended to: real and simulated evidence never share a directory.
    const attestationPath = join(evidenceRoot, 'export-attestation.json')
    if (existsSync(attestationPath)) {
      try {
        const existing = JSON.parse(readFileSync(attestationPath, 'utf8')) as Record<string, unknown>
        if (existing['evidence_kind'] !== payload.attestation.evidence_kind) fail('evidence_root_conflict')
      } catch (error) {
        if (error instanceof M3CohortError) throw error
        fail('evidence_root_conflict')
      }
      fail('output_exists')
    }

    if (options.validate) {
      try {
        options.validate(payload)
      } catch (error) {
        if (error instanceof M3CohortError) throw error
        fail('export_validation_failed')
      }
    }

    const manifestBytes = `${JSON.stringify(payload.manifest, null, 2)}\n`
    const recordLines = payload.cohort.map(record => JSON.stringify(record))
    const cohortBytes = recordLines.join('\n') + (recordLines.length > 0 ? '\n' : '')
    const provenanceBytes = payload.provenance.map(row => JSON.stringify(row)).join('\n') + (payload.provenance.length > 0 ? '\n' : '')
    writeOutputFileNoOverwrite(join(evidenceRoot, 'manifest.json'), manifestBytes)
    writeOutputFileNoOverwrite(join(evidenceRoot, 'cohort.jsonl'), cohortBytes)
    writeOutputFileNoOverwrite(join(evidenceRoot, 'provenance.jsonl'), provenanceBytes)
    writeOutputFileNoOverwrite(attestationPath, `${JSON.stringify(payload.attestation, null, 2)}\n`)

    return {
      payload,
      result: {
        schema: 'gotry_m3_cohort_cli_result.v1',
        ok: true,
        command: 'export',
        status: 'recorded',
        cohort_ref: manifest.cohort_ref,
        evidence_kind: payload.attestation.evidence_kind,
        record_count: payload.attestation.record_count,
        simulated_record_count: payload.attestation.simulated_record_count,
        output_written: true,
      },
    }
  })
}

export interface VerifyExportResult {
  schema: 'gotry_m3_export_verification.v1'
  ok: true
  evidence_kind: M3EvidenceKind
  record_count: number
  simulated_record_count: number
  cohort_id: string
}

/**
 * Re-derive every digest in `export-attestation.json` from the bytes on disk.
 *
 * This is the check that makes a one-field relabel detectable: flipping
 * `manifest.json.evidence_kind` from `synthetic_fixture` to `real_seed_cohort` leaves the
 * scorer happy (it trusts the manifest) but breaks `manifest_sha256`, and the attestation's
 * own `evidence_kind` no longer matches the manifest's.
 */
export function verifyExportedEvidence(evidenceRoot: string): VerifyExportResult {
  const root = assertOutputPath(assertRawLabel(evidenceRoot, 4096))
  const read = (name: string): string => {
    const path = join(root, name)
    assertNoSymlinkLeaf(path)
    if (!existsSync(path)) fail('export_validation_failed')
    try {
      return readFileSync(path, 'utf8')
    } catch {
      fail('export_validation_failed')
    }
  }
  const manifestBytes = read('manifest.json')
  const cohortBytes = read('cohort.jsonl')
  const provenanceBytes = read('provenance.jsonl')
  let attestation: Record<string, unknown>
  try {
    attestation = JSON.parse(read('export-attestation.json')) as Record<string, unknown>
  } catch {
    fail('export_validation_failed')
  }
  if (!isObject(attestation)) fail('export_validation_failed')
  exactKeys(attestation, [
    'schema_version', 'cohort_id', 'evidence_kind', 'exported_at', 'record_count',
    'simulated_record_count', 'capture_manifest_digest_sha256', 'manifest_sha256',
    'cohort_records_sha256', 'provenance_jsonl_sha256',
  ])
  if (attestation['schema_version'] !== M3_EXPORT_ATTESTATION_SCHEMA) fail('export_validation_failed')
  const evidenceKind = assertEvidenceKind(attestation['evidence_kind'])
  const recordLines = cohortRecordLines(cohortBytes)
  if (sha256Hex(manifestBytes) !== attestation['manifest_sha256']) fail('export_validation_failed')
  if (cohortRecordsDigest(recordLines) !== attestation['cohort_records_sha256']) fail('export_validation_failed')
  if (sha256Hex(provenanceBytes) !== attestation['provenance_jsonl_sha256']) fail('export_validation_failed')

  const manifest = assertEvidenceManifest(JSON.parse(manifestBytes))
  if (manifest.evidence_kind !== evidenceKind) fail('export_validation_failed')
  if (manifest.cohort_id !== attestation['cohort_id']) fail('export_validation_failed')

  const records = recordLines.map(line => JSON.parse(line) as Record<string, unknown>)
  if (records.length !== attestation['record_count']) fail('export_validation_failed')
  const provenanceRows = provenanceBytes.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as Record<string, unknown>)
  if (provenanceRows.length !== attestation['simulated_record_count']) fail('export_validation_failed')
  // A synthetic export must label every single record; a real export must label none.
  const planKeys = new Set(records.map(record => String(record['plan_key'])))
  const labelled = new Set(provenanceRows.map(row => String(row['plan_key'])))
  if (evidenceKind === 'synthetic_fixture') {
    if (labelled.size !== planKeys.size) fail('export_validation_failed')
    for (const key of planKeys) if (!labelled.has(key)) fail('export_validation_failed')
  } else if (labelled.size !== 0) {
    fail('export_validation_failed')
  }
  for (const row of provenanceRows) {
    const { participant_key: _participant, plan_key: _plan, ...rest } = row
    assertSimulationProvenance(rest)
  }
  return {
    schema: 'gotry_m3_export_verification.v1',
    ok: true,
    evidence_kind: evidenceKind,
    record_count: records.length,
    simulated_record_count: provenanceRows.length,
    cohort_id: manifest.cohort_id,
  }
}

export function readStoreForTests(stateRoot: string): { manifest: M3CaptureManifest; events: M3CaptureEvent[] } {
  const storeRoot = storeRootForStateRoot(stateRoot)
  return { manifest: readManifest(storeRoot), events: readEvents(storeRoot) }
}

export function fileMode(path: string): number {
  return statSync(path).mode & 0o777
}
