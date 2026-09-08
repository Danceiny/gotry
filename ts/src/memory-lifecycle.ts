/**
 * Explicit opt-in M4 planning lifecycle observation collector.
 *
 * This module owns the deterministic contract behind scripts/memory-lifecycle.ts:
 * - every subject/flow/evidence identifier is HMAC-SHA256 pseudonymous;
 * - the wait-code vocabulary is frozen at dataset init;
 * - lifecycle events are append-only and idempotent;
 * - exports target the memory-value scorer input contract without claiming source attestation.
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
  truncateSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

export const MEMORY_LIFECYCLE_STORE_SCHEMA = 'memory_lifecycle_observations.v1' as const
export const MEMORY_LIFECYCLE_MANIFEST_SCHEMA = 'memory_lifecycle_manifest.v1' as const
export const MEMORY_LIFECYCLE_EVENT_SCHEMA = 'memory_lifecycle_event.v1' as const
export const MEMORY_VALUE_FIXTURE_SCHEMA = 'memory_value_fixture.v1' as const
export const MEMORY_VALUE_SOURCE_REVIEW_SCHEMA = 'memory_value_source_review.v1' as const
export const HMAC_REF_PATTERN = /^hmac-sha256:[0-9a-f]{64}$/
export const SHA256_PATTERN = /^[0-9a-f]{64}$/
export const WAIT_CODE_PATTERN = /^[a-z][a-z0-9_]{0,31}$/

export type MemoryLifecycleSourceKind = 'synthetic_fixture' | 'observed_private'
export type SourceReviewState = 'not_required_for_synthetic' | 'candidate' | 'manual_attested'
export type RefluxKind = 'recalled' | 'verified_outcome'
export type PreferenceConsumer = 'ranking' | 'explanation'
export type CommandStatus = 'recorded' | 'unchanged'

export type MemoryLifecycleErrorCode =
  | 'bad_args'
  | 'dataset_already_initialized'
  | 'dataset_consent_mismatch'
  | 'dataset_key_mismatch'
  | 'dataset_not_initialized'
  | 'dataset_source_mismatch'
  | 'flow_limit_reached'
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
  | 'unsafe_state_root'

export class MemoryLifecycleError extends Error {
  readonly code: MemoryLifecycleErrorCode

  constructor(code: MemoryLifecycleErrorCode) {
    super(code)
    this.code = code
  }
}

export interface Clock {
  now(): Date
}

export const systemClock: Clock = {
  now: () => new Date(),
}

export interface CommonCommandOptions {
  stateRoot: string
  consent: string
  hmacKey: string | undefined
}

export interface InitDatasetOptions extends CommonCommandOptions {
  dataset: string
  sourceKind: MemoryLifecycleSourceKind
  waitCodes: string[]
}

export interface FlowCommandOptions extends CommonCommandOptions {
  subject: string
  flow: string
}

export interface WaitStartOptions extends FlowCommandOptions {
  wait: string
  code: string
}

export interface WaitEndOptions extends FlowCommandOptions {
  wait: string
}

export interface RecordRefluxOptions extends CommonCommandOptions {
  experience: string
  kind: RefluxKind
  evidence: string
}

export interface RecordPreferenceOptions extends CommonCommandOptions {
  assertion: string
  evidence: string
  consumer: PreferenceConsumer
}

export interface ExportOptions extends CommonCommandOptions {
  out?: string
}

export interface MemoryLifecycleCliResult {
  schema: 'memory_lifecycle_cli_result.v1'
  ok: true
  command: string
  status: CommandStatus
  dataset_ref?: string
  event_ref?: string
  source_kind?: MemoryLifecycleSourceKind
  wait_code_count?: number
  pair_count?: number
  output_written?: boolean
}

interface PreparedCommon {
  consentRef: string
  hmacKey: string
  stateRoot: string
  storeRoot: string
}

export interface MemoryLifecycleManifest {
  schema_version: typeof MEMORY_LIFECYCLE_MANIFEST_SCHEMA
  collector_schema: typeof MEMORY_LIFECYCLE_STORE_SCHEMA
  dataset_ref: string
  dataset_key_verifier: string
  source_kind: MemoryLifecycleSourceKind
  created_at: string
  consent_ref: string
  measurement_policy: {
    quantile_method: 'nearest_rank'
    predeclared_external_wait_codes: string[]
    minimum_pair_count_for_exit: 5
    target_median_reduction_ratio: 0.5
  }
  p4: {
    state: 'closed'
    triggers: {
      real_usage: false
      multi_user: false
    }
  }
}

interface BaseLifecycleEvent {
  schema_version: typeof MEMORY_LIFECYCLE_EVENT_SCHEMA
  event_ref: string
  kind: string
  occurred_at: string
  consent_ref: string
}

export interface FlowStartedEvent extends BaseLifecycleEvent {
  kind: 'flow_started'
  subject_ref: string
  flow_ref: string
  eligible: true
}

export interface ExternalWaitStartedEvent extends BaseLifecycleEvent {
  kind: 'external_wait_started'
  subject_ref: string
  flow_ref: string
  wait_ref: string
  code: string
}

export interface ExternalWaitEndedEvent extends BaseLifecycleEvent {
  kind: 'external_wait_ended'
  subject_ref: string
  flow_ref: string
  wait_ref: string
}

export interface FlowCompletedEvent extends BaseLifecycleEvent {
  kind: 'flow_completed'
  subject_ref: string
  flow_ref: string
  status: 'completed'
}

export interface ExperienceRefluxRecordedEvent extends BaseLifecycleEvent {
  kind: 'experience_reflux_recorded'
  reflux_kind: RefluxKind
  experience_ref: string
  evidence_ref: string
}

export interface PreferenceRecordedEvent extends BaseLifecycleEvent {
  kind: 'preference_recorded'
  assertion_ref: string
  evidence_ref: string
  consumer: PreferenceConsumer
  hard_filter: false
}

export type MemoryLifecycleEvent =
  | FlowStartedEvent
  | ExternalWaitStartedEvent
  | ExternalWaitEndedEvent
  | FlowCompletedEvent
  | ExperienceRefluxRecordedEvent
  | PreferenceRecordedEvent

export interface FlowProjection {
  subjectRef: string
  flowRef: string
  eligible: true
  startedAt: string
  completedAt?: string
  waits: Map<string, WaitProjection>
}

export interface WaitProjection {
  waitRef: string
  code: string
  startedAt: string
  completedAt?: string
}

export interface ExperienceRefluxProjection {
  refluxKind: RefluxKind
  experienceRef: string
  evidenceRef: string
}

export interface PreferenceProjection {
  assertionRef: string
  evidenceRef: string
  consumer: PreferenceConsumer
  hardFilter: false
}

export interface MemoryLifecycleProjection {
  flows: Map<string, FlowProjection>
  flowsBySubject: Map<string, FlowProjection[]>
  refluxEvents: ExperienceRefluxProjection[]
  preferences: PreferenceProjection[]
}

export interface MemoryValueFixture {
  schema: typeof MEMORY_VALUE_FIXTURE_SCHEMA
  evidence_kind: MemoryLifecycleSourceKind
  source_review: {
    schema_version: typeof MEMORY_VALUE_SOURCE_REVIEW_SCHEMA
    state: SourceReviewState
    reviewed_at: string | null
    reviewer_ref: string | null
    attestation_ref: string | null
    private_source_digest_sha256: string | null
    reviewed_summary_digest_sha256: string | null
    checks: {
      raw_private_material_excluded: boolean
      paired_cohort_source_reviewed: boolean
      summary_matches_private_source: boolean
      no_synthetic_or_test_subjects: boolean
    }
  }
  measurement_policy: MemoryLifecycleManifest['measurement_policy']
  pairs: Array<{
    pair_id: string
    subject_ref: string
    first: MemoryValueFlow
    returning: MemoryValueFlow
  }>
  experience_reflux_events: Array<{
    experience_id: string
    kind: RefluxKind
    evidence_ref: string
  }>
  preference_assertions: Array<{
    assertion_id: string
    evidence_ref: string
    consumer: PreferenceConsumer
    hard_filter: false
  }>
  p4: MemoryLifecycleManifest['p4']
}

interface MemoryValueFlow {
  flow_id: string
  eligible_planning_index: 1 | 2
  eligible: true
  status: 'completed'
  started_at: string
  completed_at: string
  external_waits: Array<{
    code: string
    started_at: string
    completed_at: string
  }>
}

function fail(code: MemoryLifecycleErrorCode): never {
  throw new MemoryLifecycleError(code)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function assertRawLabel(value: string, limit = 512): string {
  if (!nonEmptyString(value)) fail('invalid_input')
  if (value.length > limit) fail('invalid_input')
  if (/[\u0000-\u001f\u007f]/u.test(value)) fail('invalid_input')
  return value
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

function normalizeHmacKey(key: string | undefined): string {
  if (!nonEmptyString(key)) fail('missing_hmac_key')
  const trimmed = key.trim()
  if (trimmed.length < 32) fail('invalid_hmac_key')
  if (/[\u0000-\u001f\u007f]/u.test(trimmed)) fail('invalid_hmac_key')
  return trimmed
}

function normalizeWaitCodes(codes: string[]): string[] {
  if (!Array.isArray(codes) || codes.length === 0) fail('invalid_input')
  const seen = new Set<string>()
  for (const raw of codes) {
    const code = assertRawLabel(raw, 32)
    if (!WAIT_CODE_PATTERN.test(code)) fail('invalid_input')
    if (seen.has(code)) fail('invalid_input')
    seen.add(code)
  }
  return [...seen].sort()
}

function assertSourceKind(value: MemoryLifecycleSourceKind): MemoryLifecycleSourceKind {
  if (value !== 'synthetic_fixture' && value !== 'observed_private') fail('invalid_input')
  return value
}

function assertRefluxKind(value: RefluxKind): RefluxKind {
  if (value !== 'recalled' && value !== 'verified_outcome') fail('invalid_input')
  return value
}

function assertPreferenceConsumer(value: PreferenceConsumer): PreferenceConsumer {
  if (value !== 'ranking' && value !== 'explanation') fail('invalid_input')
  return value
}

function assertHmacRef(value: unknown): string {
  if (!nonEmptyString(value) || !HMAC_REF_PATTERN.test(value)) fail('invalid_store')
  return value
}

function assertEventObject(value: unknown): Record<string, unknown> {
  if (!isObject(value)) fail('invalid_store')
  if (value.schema_version !== MEMORY_LIFECYCLE_EVENT_SCHEMA) fail('invalid_store')
  assertHmacRef(value.event_ref)
  if (!nonEmptyString(value.kind)) fail('invalid_store')
  if (!nonEmptyString(value.occurred_at)) fail('invalid_store')
  parseIsoMs(value.occurred_at)
  assertHmacRef(value.consent_ref)
  return value
}

function normalizePolicyPath(path: string): string {
  return resolve(path).replace(/\\/g, '/')
}

function assertSafePolicyPath(path: string): void {
  const normalized = normalizePolicyPath(path)
  if (normalized === '/' || normalized.endsWith('/.git') || normalized.includes('/.git/')) fail('unsafe_state_root')
  if (normalized.endsWith('/ts/dsh-runtime') || normalized.includes('/ts/dsh-runtime/')) fail('unsafe_state_root')
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

function assertManagedStoreIsolation(storeRoot: string): void {
  const resolvedStoreRoot = resolve(storeRoot)
  const stateRoot = resolve(resolvedStoreRoot, '..', '..')
  assertSafePolicyPath(stateRoot)
  assertSafePolicyPath(resolvedStoreRoot)
  assertSafePolicyPath(realpathOrUnsafe(nearestExistingAncestor(stateRoot)))

  if (!existsSync(stateRoot)) {
    assertSafePolicyPath(realpathOrUnsafe(nearestExistingAncestor(resolvedStoreRoot)))
    return
  }

  const stateRootReal = realpathOrUnsafe(stateRoot)
  assertSafePolicyPath(stateRootReal)
  for (const managedPath of [join(stateRoot, 'gotry-state'), resolvedStoreRoot]) {
    const existing = nearestExistingAncestor(managedPath)
    const existingReal = realpathOrUnsafe(existing)
    assertSafePolicyPath(existingReal)
    if (!sameOrChildPath(stateRootReal, existingReal)) fail('unsafe_state_root')
  }
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
    storeRoot: join(stateRoot, 'gotry-state', 'memory-lifecycle'),
  }
}

export function pseudonymousRef(hmacKey: string, kind: string, parts: readonly string[]): string {
  const key = normalizeHmacKey(hmacKey)
  const hmac = createHmac('sha256', key)
  hmac.update('gotry-memory-lifecycle.v1')
  hmac.update('\0')
  hmac.update(assertRawLabel(kind, 64))
  for (const part of parts) {
    hmac.update('\0')
    hmac.update(assertRawLabel(part, 2048))
  }
  return `hmac-sha256:${hmac.digest('hex')}`
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

export function memoryValueSummaryDigest(input: unknown): string {
  const payload = isObject(input)
    ? Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'source_review'))
    : input
  return sha256Hex(canonicalJson(payload))
}

function eventRef(hmacKey: string, kind: string, parts: readonly string[]): string {
  return pseudonymousRef(hmacKey, `event:${kind}`, parts)
}

function subjectRef(hmacKey: string, subject: string): string {
  return pseudonymousRef(hmacKey, 'subject', [subject])
}

function flowRef(hmacKey: string, subject: string, flow: string): string {
  return pseudonymousRef(hmacKey, 'flow', [subjectRef(hmacKey, subject), flow])
}

function waitRef(hmacKey: string, subject: string, flow: string, wait: string): string {
  return pseudonymousRef(hmacKey, 'external-wait', [flowRef(hmacKey, subject, flow), wait])
}

function experienceRef(hmacKey: string, experience: string): string {
  return pseudonymousRef(hmacKey, 'experience', [experience])
}

function evidenceRef(hmacKey: string, evidence: string): string {
  return pseudonymousRef(hmacKey, 'evidence', [evidence])
}

function assertionRef(hmacKey: string, assertion: string): string {
  return pseudonymousRef(hmacKey, 'preference-assertion', [assertion])
}

function datasetRef(hmacKey: string, dataset: string): string {
  return pseudonymousRef(hmacKey, 'dataset', [dataset])
}

function datasetKeyVerifier(hmacKey: string): string {
  return pseudonymousRef(hmacKey, 'dataset-key-verifier', [MEMORY_LIFECYCLE_STORE_SCHEMA])
}

const OPEN_NOFOLLOW = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
let tempFileCounter = 0

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
    if (error instanceof MemoryLifecycleError) throw error
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
  return resolvedPath
}

function privateTempPath(path: string): string {
  tempFileCounter += 1
  return join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.${tempFileCounter}.${randomBytes(6).toString('hex')}.tmp`)
}

function writeAllSync(fd: number, content: string | Buffer): void {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content)
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
    if (caught instanceof MemoryLifecycleError) throw caught
    if (isNodeError(caught, 'ELOOP')) fail('unsafe_state_root')
    fail('internal_error')
  }
  try { chmodSync(path, 0o600) } catch { /* best effort */ }
}

function publishTempNoOverwrite(tempPath: string, finalPath: string, existsCode: MemoryLifecycleErrorCode): void {
  try {
    linkSync(tempPath, finalPath)
  } catch (error) {
    if (isNodeError(error, 'EEXIST')) fail(existsCode)
    fail('internal_error')
  }
}

function writeManagedFileNoOverwrite(storeRoot: string, path: string, content: string, existsCode: MemoryLifecycleErrorCode): void {
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

function writePrivateFileNoOverwrite(path: string, content: string): void {
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
  const payload = `${line}\n`
  let fd = -1
  let caught: unknown
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | OPEN_NOFOLLOW, 0o600)
    writeAllSync(fd, payload)
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
    if (caught instanceof MemoryLifecycleError) throw caught
    if (isNodeError(caught, 'ELOOP')) fail('unsafe_state_root')
    fail('internal_error')
  }
  try { chmodSync(path, 0o600) } catch { /* best effort */ }
}

function isNodeError(error: unknown, code: string): boolean {
  return isObject(error) && error.code === code
}

function withStoreLock<T>(storeRoot: string, createStore: boolean, body: () => T): T {
  assertManagedStoreIsolation(storeRoot)
  if (createStore) ensurePrivateDir(storeRoot)
  else if (!existsSync(storeRoot)) fail('dataset_not_initialized')
  assertManagedStoreIsolation(storeRoot)

  const lockPath = join(storeRoot, '.writer.lock')
  assertManagedFilePath(storeRoot, lockPath)
  let fd = -1
  let createdLock = false
  try {
    fd = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | OPEN_NOFOLLOW, 0o600)
    createdLock = true
    writeAllSync(fd, JSON.stringify({ schema_version: 'memory_lifecycle_lock.v1', pid: process.pid }))
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

function manifestPath(storeRoot: string): string {
  return join(storeRoot, 'manifest.json')
}

function eventsPath(storeRoot: string): string {
  return join(storeRoot, 'events.jsonl')
}

function readManifest(storeRoot: string): MemoryLifecycleManifest {
  const path = manifestPath(storeRoot)
  assertManagedFilePath(storeRoot, path)
  if (!existsSync(path)) fail('dataset_not_initialized')
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    fail('invalid_store')
  }
  return assertManifest(parsed)
}

function assertManifest(value: unknown): MemoryLifecycleManifest {
  if (!isObject(value)) fail('invalid_store')
  if (value.schema_version !== MEMORY_LIFECYCLE_MANIFEST_SCHEMA) fail('invalid_store')
  if (value.collector_schema !== MEMORY_LIFECYCLE_STORE_SCHEMA) fail('invalid_store')
  const ref = assertHmacRef(value.dataset_ref)
  const keyVerifier = assertHmacRef(value.dataset_key_verifier)
  const source = value.source_kind
  if (source !== 'synthetic_fixture' && source !== 'observed_private') fail('invalid_store')
  if (!nonEmptyString(value.created_at)) fail('invalid_store')
  parseIsoMs(value.created_at)
  const consentRef = assertHmacRef(value.consent_ref)
  if (!isObject(value.measurement_policy)) fail('invalid_store')
  const policy = value.measurement_policy
  if (policy.quantile_method !== 'nearest_rank') fail('invalid_store')
  if (!Array.isArray(policy.predeclared_external_wait_codes)) fail('invalid_store')
  const waitCodes = normalizeWaitCodes(policy.predeclared_external_wait_codes.map(String))
  if (policy.minimum_pair_count_for_exit !== 5) fail('invalid_store')
  if (policy.target_median_reduction_ratio !== 0.5) fail('invalid_store')
  if (!isObject(value.p4) || value.p4.state !== 'closed' || !isObject(value.p4.triggers)) fail('invalid_store')
  if (value.p4.triggers.real_usage !== false || value.p4.triggers.multi_user !== false) fail('invalid_store')
  return {
    schema_version: MEMORY_LIFECYCLE_MANIFEST_SCHEMA,
    collector_schema: MEMORY_LIFECYCLE_STORE_SCHEMA,
    dataset_ref: ref,
    dataset_key_verifier: keyVerifier,
    source_kind: source,
    created_at: value.created_at,
    consent_ref: consentRef,
    measurement_policy: {
      quantile_method: 'nearest_rank',
      predeclared_external_wait_codes: waitCodes,
      minimum_pair_count_for_exit: 5,
      target_median_reduction_ratio: 0.5,
    },
    p4: { state: 'closed', triggers: { real_usage: false, multi_user: false } },
  }
}

function readEvents(storeRoot: string, recoverUncommittedTail = false): MemoryLifecycleEvent[] {
  const path = eventsPath(storeRoot)
  assertManagedFilePath(storeRoot, path)
  if (!existsSync(path)) return []
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    fail('invalid_store')
  }
  if (recoverUncommittedTail) raw = recoverCommittedEventLog(storeRoot, path, raw)
  return parseEventLines(raw.split('\n'))
}

function recoverCommittedEventLog(storeRoot: string, path: string, raw: string): string {
  if (raw === '' || raw.endsWith('\n')) return raw
  const committedLength = raw.lastIndexOf('\n') + 1
  const committedRaw = raw.slice(0, committedLength)
  parseEventLines(committedRaw.split('\n'))
  const tail = raw.slice(committedLength)
  if (tail.trim() !== '') {
    try {
      parseEventLines([...committedRaw.split('\n').filter(line => line.trim() !== ''), tail])
      appendPrivateLine(storeRoot, path, '')
      return `${raw}\n`
    } catch (error) {
      if (!(error instanceof MemoryLifecycleError) || error.code !== 'invalid_store') throw error
    }
  }
  try {
    assertManagedFilePath(storeRoot, path)
    truncateSync(path, committedLength)
  } catch (error) {
    if (error instanceof MemoryLifecycleError) throw error
    fail('invalid_store')
  }
  return committedRaw
}

function parseEventLines(lines: string[]): MemoryLifecycleEvent[] {
  const events: MemoryLifecycleEvent[] = []
  const seen = new Map<string, string>()
  for (const line of lines) {
    if (line.trim() === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      fail('invalid_store')
    }
    const event = assertLifecycleEvent(parsed)
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

function assertLifecycleEvent(value: unknown): MemoryLifecycleEvent {
  const raw = assertEventObject(value)
  switch (raw.kind) {
    case 'flow_started':
      if (raw.eligible !== true) fail('invalid_store')
      return {
        schema_version: MEMORY_LIFECYCLE_EVENT_SCHEMA,
        event_ref: raw.event_ref as string,
        kind: 'flow_started',
        occurred_at: raw.occurred_at as string,
        consent_ref: raw.consent_ref as string,
        subject_ref: assertHmacRef(raw.subject_ref),
        flow_ref: assertHmacRef(raw.flow_ref),
        eligible: true,
      }
    case 'external_wait_started':
      if (!nonEmptyString(raw.code) || !WAIT_CODE_PATTERN.test(raw.code)) fail('invalid_store')
      return {
        schema_version: MEMORY_LIFECYCLE_EVENT_SCHEMA,
        event_ref: raw.event_ref as string,
        kind: 'external_wait_started',
        occurred_at: raw.occurred_at as string,
        consent_ref: raw.consent_ref as string,
        subject_ref: assertHmacRef(raw.subject_ref),
        flow_ref: assertHmacRef(raw.flow_ref),
        wait_ref: assertHmacRef(raw.wait_ref),
        code: raw.code,
      }
    case 'external_wait_ended':
      return {
        schema_version: MEMORY_LIFECYCLE_EVENT_SCHEMA,
        event_ref: raw.event_ref as string,
        kind: 'external_wait_ended',
        occurred_at: raw.occurred_at as string,
        consent_ref: raw.consent_ref as string,
        subject_ref: assertHmacRef(raw.subject_ref),
        flow_ref: assertHmacRef(raw.flow_ref),
        wait_ref: assertHmacRef(raw.wait_ref),
      }
    case 'flow_completed':
      if (raw.status !== 'completed') fail('invalid_store')
      return {
        schema_version: MEMORY_LIFECYCLE_EVENT_SCHEMA,
        event_ref: raw.event_ref as string,
        kind: 'flow_completed',
        occurred_at: raw.occurred_at as string,
        consent_ref: raw.consent_ref as string,
        subject_ref: assertHmacRef(raw.subject_ref),
        flow_ref: assertHmacRef(raw.flow_ref),
        status: 'completed',
      }
    case 'experience_reflux_recorded': {
      const kind = raw.reflux_kind
      if (kind !== 'recalled' && kind !== 'verified_outcome') fail('invalid_store')
      return {
        schema_version: MEMORY_LIFECYCLE_EVENT_SCHEMA,
        event_ref: raw.event_ref as string,
        kind: 'experience_reflux_recorded',
        occurred_at: raw.occurred_at as string,
        consent_ref: raw.consent_ref as string,
        reflux_kind: kind,
        experience_ref: assertHmacRef(raw.experience_ref),
        evidence_ref: assertHmacRef(raw.evidence_ref),
      }
    }
    case 'preference_recorded': {
      const consumer = raw.consumer
      if (consumer !== 'ranking' && consumer !== 'explanation') fail('invalid_store')
      if (raw.hard_filter !== false) fail('invalid_store')
      return {
        schema_version: MEMORY_LIFECYCLE_EVENT_SCHEMA,
        event_ref: raw.event_ref as string,
        kind: 'preference_recorded',
        occurred_at: raw.occurred_at as string,
        consent_ref: raw.consent_ref as string,
        assertion_ref: assertHmacRef(raw.assertion_ref),
        evidence_ref: assertHmacRef(raw.evidence_ref),
        consumer,
        hard_filter: false,
      }
    }
    default:
      fail('invalid_store')
  }
}

function eventExists(events: MemoryLifecycleEvent[], ref: string): boolean {
  return events.some(event => event.event_ref === ref)
}

function appendEvent(storeRoot: string, events: readonly MemoryLifecycleEvent[], event: MemoryLifecycleEvent): void {
  assertCandidateProjection(events, event)
  assertManagedStoreIsolation(storeRoot)
  appendPrivateLine(storeRoot, eventsPath(storeRoot), JSON.stringify(event))
}

function assertCandidateProjection(events: readonly MemoryLifecycleEvent[], event: MemoryLifecycleEvent): void {
  try {
    projectLifecycleEvents([...events, event])
  } catch (error) {
    if (error instanceof MemoryLifecycleError && error.code === 'invalid_store') fail('invalid_transition')
    throw error
  }
}

export function projectLifecycleEvents(events: readonly MemoryLifecycleEvent[]): MemoryLifecycleProjection {
  const flows = new Map<string, FlowProjection>()
  const flowsBySubject = new Map<string, FlowProjection[]>()
  const refluxEvents: ExperienceRefluxProjection[] = []
  const preferences: PreferenceProjection[] = []
  const refluxKinds = new Set<string>()
  const assertionRefs = new Set<string>()

  for (const event of events) {
    switch (event.kind) {
      case 'flow_started': {
        if (flows.has(event.flow_ref)) fail('invalid_store')
        const subjectFlows = flowsBySubject.get(event.subject_ref) ?? []
        if (subjectFlows.some(existing => existing.completedAt === undefined)) fail('invalid_store')
        const startedAtMs = parseIsoMs(event.occurred_at)
        const lastCompleted = subjectFlows
          .filter(existing => existing.completedAt !== undefined)
          .sort(compareFlows)
          .at(-1)
        if (lastCompleted && startedAtMs <= parseIsoMs(lastCompleted.completedAt!)) fail('invalid_store')
        const flow: FlowProjection = {
          subjectRef: event.subject_ref,
          flowRef: event.flow_ref,
          eligible: true,
          startedAt: event.occurred_at,
          waits: new Map(),
        }
        subjectFlows.push(flow)
        flowsBySubject.set(event.subject_ref, subjectFlows)
        flows.set(event.flow_ref, flow)
        break
      }
      case 'external_wait_started': {
        const flow = flows.get(event.flow_ref)
        if (!flow || flow.subjectRef !== event.subject_ref || flow.completedAt !== undefined) fail('invalid_store')
        if (flow.waits.has(event.wait_ref)) fail('invalid_store')
        if ([...flow.waits.values()].some(wait => wait.completedAt === undefined)) fail('invalid_store')
        const startedAtMs = parseIsoMs(event.occurred_at)
        if (startedAtMs < parseIsoMs(flow.startedAt)) fail('invalid_store')
        for (const wait of flow.waits.values()) {
          if (wait.completedAt && startedAtMs < parseIsoMs(wait.completedAt)) fail('invalid_store')
        }
        flow.waits.set(event.wait_ref, { waitRef: event.wait_ref, code: event.code, startedAt: event.occurred_at })
        break
      }
      case 'external_wait_ended': {
        const flow = flows.get(event.flow_ref)
        const wait = flow?.waits.get(event.wait_ref)
        if (!flow || flow.subjectRef !== event.subject_ref || flow.completedAt !== undefined || !wait || wait.completedAt !== undefined) {
          fail('invalid_store')
        }
        if (parseIsoMs(event.occurred_at) <= parseIsoMs(wait.startedAt)) fail('invalid_store')
        wait.completedAt = event.occurred_at
        break
      }
      case 'flow_completed': {
        const flow = flows.get(event.flow_ref)
        if (!flow || flow.subjectRef !== event.subject_ref || flow.completedAt !== undefined) fail('invalid_store')
        if ([...flow.waits.values()].some(wait => wait.completedAt === undefined)) fail('invalid_store')
        if (parseIsoMs(event.occurred_at) <= parseIsoMs(flow.startedAt)) fail('invalid_store')
        const completedAtMs = parseIsoMs(event.occurred_at)
        for (const wait of flow.waits.values()) {
          if (parseIsoMs(wait.startedAt) < parseIsoMs(flow.startedAt) || parseIsoMs(wait.completedAt!) > completedAtMs) fail('invalid_store')
        }
        flow.completedAt = event.occurred_at
        break
      }
      case 'experience_reflux_recorded': {
        const key = `${event.reflux_kind}:${event.experience_ref}`
        if (refluxKinds.has(key)) fail('invalid_store')
        refluxKinds.add(key)
        refluxEvents.push({ refluxKind: event.reflux_kind, experienceRef: event.experience_ref, evidenceRef: event.evidence_ref })
        break
      }
      case 'preference_recorded':
        if (assertionRefs.has(event.assertion_ref)) fail('invalid_store')
        assertionRefs.add(event.assertion_ref)
        preferences.push({
          assertionRef: event.assertion_ref,
          evidenceRef: event.evidence_ref,
          consumer: event.consumer,
          hardFilter: false,
        })
        break
    }
  }

  return { flows, flowsBySubject, refluxEvents, preferences }
}

function buildManifest(options: InitDatasetOptions, common: PreparedCommon, clock: Clock): MemoryLifecycleManifest {
  return {
    schema_version: MEMORY_LIFECYCLE_MANIFEST_SCHEMA,
    collector_schema: MEMORY_LIFECYCLE_STORE_SCHEMA,
    dataset_ref: datasetRef(common.hmacKey, assertRawLabel(options.dataset)),
    dataset_key_verifier: datasetKeyVerifier(common.hmacKey),
    source_kind: assertSourceKind(options.sourceKind),
    created_at: assertIsoDate(clock.now()),
    consent_ref: common.consentRef,
    measurement_policy: {
      quantile_method: 'nearest_rank',
      predeclared_external_wait_codes: normalizeWaitCodes(options.waitCodes),
      minimum_pair_count_for_exit: 5,
      target_median_reduction_ratio: 0.5,
    },
    p4: { state: 'closed', triggers: { real_usage: false, multi_user: false } },
  }
}

function sameFrozenDataset(existing: MemoryLifecycleManifest, next: MemoryLifecycleManifest): boolean {
  return existing.dataset_ref === next.dataset_ref
    && existing.dataset_key_verifier === next.dataset_key_verifier
    && existing.source_kind === next.source_kind
    && existing.consent_ref === next.consent_ref
    && canonicalJson(existing.measurement_policy) === canonicalJson(next.measurement_policy)
}

function assertDatasetKeyMatches(manifest: MemoryLifecycleManifest, hmacKey: string): void {
  if (manifest.dataset_key_verifier !== datasetKeyVerifier(hmacKey)) fail('dataset_key_mismatch')
}

function assertDatasetConsentMatches(manifest: MemoryLifecycleManifest, consentRef: string): void {
  if (manifest.consent_ref !== consentRef) fail('dataset_consent_mismatch')
}

function assertEventsBelongToDataset(manifest: MemoryLifecycleManifest, events: readonly MemoryLifecycleEvent[]): void {
  if (events.some(event => event.consent_ref !== manifest.consent_ref)) fail('invalid_store')
}

export function initMemoryLifecycleDataset(options: InitDatasetOptions, clock: Clock = systemClock): MemoryLifecycleCliResult {
  const common = prepareCommon(options)
  const next = buildManifest(options, common, clock)
  return withStoreLock(common.storeRoot, true, () => {
    const path = manifestPath(common.storeRoot)
    if (existsSync(path)) {
      const existing = readManifest(common.storeRoot)
      assertDatasetKeyMatches(existing, common.hmacKey)
      if (existing.source_kind !== next.source_kind) fail('dataset_source_mismatch')
      if (existing.consent_ref !== next.consent_ref) fail('dataset_consent_mismatch')
      if (!sameFrozenDataset(existing, next)) fail('dataset_already_initialized')
      return {
        schema: 'memory_lifecycle_cli_result.v1',
        ok: true,
        command: 'init',
        status: 'unchanged',
        dataset_ref: existing.dataset_ref,
        source_kind: existing.source_kind,
        wait_code_count: existing.measurement_policy.predeclared_external_wait_codes.length,
      }
    }
    writeManagedFileNoOverwrite(common.storeRoot, path, `${JSON.stringify(next, null, 2)}\n`, 'dataset_already_initialized')
    return {
      schema: 'memory_lifecycle_cli_result.v1',
      ok: true,
      command: 'init',
      status: 'recorded',
      dataset_ref: next.dataset_ref,
      source_kind: next.source_kind,
      wait_code_count: next.measurement_policy.predeclared_external_wait_codes.length,
    }
  })
}

function loadLockedStore(common: PreparedCommon): { manifest: MemoryLifecycleManifest; events: MemoryLifecycleEvent[]; projection: MemoryLifecycleProjection } {
  const manifest = readManifest(common.storeRoot)
  assertDatasetKeyMatches(manifest, common.hmacKey)
  assertDatasetConsentMatches(manifest, common.consentRef)
  const events = readEvents(common.storeRoot, true)
  assertEventsBelongToDataset(manifest, events)
  return { manifest, events, projection: projectLifecycleEvents(events) }
}

function completedSubjectFlows(projection: MemoryLifecycleProjection, subject: string): FlowProjection[] {
  return (projection.flowsBySubject.get(subject) ?? [])
    .filter(flow => flow.completedAt !== undefined)
    .sort(compareFlows)
}

function compareFlows(a: FlowProjection, b: FlowProjection): number {
  return parseIsoMs(a.startedAt) - parseIsoMs(b.startedAt) || parseIsoMs(a.completedAt ?? a.startedAt) - parseIsoMs(b.completedAt ?? b.startedAt) || a.flowRef.localeCompare(b.flowRef)
}

function activeSubjectFlow(projection: MemoryLifecycleProjection, subject: string): FlowProjection | undefined {
  return (projection.flowsBySubject.get(subject) ?? []).find(flow => flow.completedAt === undefined)
}

export function startMemoryLifecycleFlow(options: FlowCommandOptions, clock: Clock = systemClock): MemoryLifecycleCliResult {
  const common = prepareCommon(options)
  const subject = subjectRef(common.hmacKey, assertRawLabel(options.subject))
  const flow = flowRef(common.hmacKey, options.subject, assertRawLabel(options.flow))
  const ref = eventRef(common.hmacKey, 'flow_started', [subject, flow])
  return withStoreLock(common.storeRoot, false, () => {
    const { events, projection } = loadLockedStore(common)
    if (eventExists(events, ref)) return eventResult('start', 'unchanged', ref)
    if (activeSubjectFlow(projection, subject)) fail('invalid_transition')
    if (completedSubjectFlows(projection, subject).length >= 2) fail('flow_limit_reached')
    if (projection.flows.has(flow)) fail('invalid_transition')
    const event: FlowStartedEvent = {
      schema_version: MEMORY_LIFECYCLE_EVENT_SCHEMA,
      event_ref: ref,
      kind: 'flow_started',
      occurred_at: assertIsoDate(clock.now()),
      consent_ref: common.consentRef,
      subject_ref: subject,
      flow_ref: flow,
      eligible: true,
    }
    appendEvent(common.storeRoot, events, event)
    return eventResult('start', 'recorded', ref)
  })
}

export function startExternalWait(options: WaitStartOptions, clock: Clock = systemClock): MemoryLifecycleCliResult {
  const common = prepareCommon(options)
  const subject = subjectRef(common.hmacKey, assertRawLabel(options.subject))
  const flow = flowRef(common.hmacKey, options.subject, assertRawLabel(options.flow))
  const wait = waitRef(common.hmacKey, options.subject, options.flow, assertRawLabel(options.wait))
  const code = assertRawLabel(options.code, 32)
  if (!WAIT_CODE_PATTERN.test(code)) fail('invalid_input')
  const ref = eventRef(common.hmacKey, 'external_wait_started', [subject, flow, wait, code])
  return withStoreLock(common.storeRoot, false, () => {
    const { manifest, events, projection } = loadLockedStore(common)
    if (eventExists(events, ref)) return eventResult('wait-start', 'unchanged', ref)
    if (!manifest.measurement_policy.predeclared_external_wait_codes.includes(code)) fail('invalid_input')
    const active = activeSubjectFlow(projection, subject)
    if (!active || active.flowRef !== flow) fail('invalid_transition')
    if (active.waits.has(wait)) fail('invalid_transition')
    if ([...active.waits.values()].some(existing => existing.completedAt === undefined)) fail('invalid_transition')
    const occurredAt = assertIsoDate(clock.now())
    if (parseIsoMs(occurredAt) < parseIsoMs(active.startedAt)) fail('invalid_transition')
    const event: ExternalWaitStartedEvent = {
      schema_version: MEMORY_LIFECYCLE_EVENT_SCHEMA,
      event_ref: ref,
      kind: 'external_wait_started',
      occurred_at: occurredAt,
      consent_ref: common.consentRef,
      subject_ref: subject,
      flow_ref: flow,
      wait_ref: wait,
      code,
    }
    appendEvent(common.storeRoot, events, event)
    return eventResult('wait-start', 'recorded', ref)
  })
}

export function endExternalWait(options: WaitEndOptions, clock: Clock = systemClock): MemoryLifecycleCliResult {
  const common = prepareCommon(options)
  const subject = subjectRef(common.hmacKey, assertRawLabel(options.subject))
  const flow = flowRef(common.hmacKey, options.subject, assertRawLabel(options.flow))
  const wait = waitRef(common.hmacKey, options.subject, options.flow, assertRawLabel(options.wait))
  const ref = eventRef(common.hmacKey, 'external_wait_ended', [subject, flow, wait])
  return withStoreLock(common.storeRoot, false, () => {
    const { events, projection } = loadLockedStore(common)
    if (eventExists(events, ref)) return eventResult('wait-end', 'unchanged', ref)
    const active = activeSubjectFlow(projection, subject)
    const interval = active?.waits.get(wait)
    if (!active || active.flowRef !== flow || !interval || interval.completedAt !== undefined) fail('invalid_transition')
    const occurredAt = assertIsoDate(clock.now())
    if (parseIsoMs(occurredAt) <= parseIsoMs(interval.startedAt)) fail('invalid_transition')
    const event: ExternalWaitEndedEvent = {
      schema_version: MEMORY_LIFECYCLE_EVENT_SCHEMA,
      event_ref: ref,
      kind: 'external_wait_ended',
      occurred_at: occurredAt,
      consent_ref: common.consentRef,
      subject_ref: subject,
      flow_ref: flow,
      wait_ref: wait,
    }
    appendEvent(common.storeRoot, events, event)
    return eventResult('wait-end', 'recorded', ref)
  })
}

export function completeMemoryLifecycleFlow(options: FlowCommandOptions, clock: Clock = systemClock): MemoryLifecycleCliResult {
  const common = prepareCommon(options)
  const subject = subjectRef(common.hmacKey, assertRawLabel(options.subject))
  const flow = flowRef(common.hmacKey, options.subject, assertRawLabel(options.flow))
  const ref = eventRef(common.hmacKey, 'flow_completed', [subject, flow])
  return withStoreLock(common.storeRoot, false, () => {
    const { events, projection } = loadLockedStore(common)
    if (eventExists(events, ref)) return eventResult('complete', 'unchanged', ref)
    const active = activeSubjectFlow(projection, subject)
    if (!active || active.flowRef !== flow) fail('invalid_transition')
    if ([...active.waits.values()].some(wait => wait.completedAt === undefined)) fail('invalid_transition')
    const occurredAt = assertIsoDate(clock.now())
    if (parseIsoMs(occurredAt) <= parseIsoMs(active.startedAt)) fail('invalid_transition')
    const event: FlowCompletedEvent = {
      schema_version: MEMORY_LIFECYCLE_EVENT_SCHEMA,
      event_ref: ref,
      kind: 'flow_completed',
      occurred_at: occurredAt,
      consent_ref: common.consentRef,
      subject_ref: subject,
      flow_ref: flow,
      status: 'completed',
    }
    appendEvent(common.storeRoot, events, event)
    return eventResult('complete', 'recorded', ref)
  })
}

export function recordExperienceReflux(options: RecordRefluxOptions, clock: Clock = systemClock): MemoryLifecycleCliResult {
  const common = prepareCommon(options)
  const kind = assertRefluxKind(options.kind)
  const experience = experienceRef(common.hmacKey, assertRawLabel(options.experience))
  const evidence = evidenceRef(common.hmacKey, assertRawLabel(options.evidence, 2048))
  const ref = eventRef(common.hmacKey, 'experience_reflux_recorded', [kind, experience, evidence])
  return withStoreLock(common.storeRoot, false, () => {
    const { events, projection } = loadLockedStore(common)
    if (eventExists(events, ref)) return eventResult('record-reflux', 'unchanged', ref)
    if (projection.refluxEvents.some(event => event.experienceRef === experience && event.refluxKind === kind)) fail('invalid_transition')
    if (kind === 'verified_outcome' && !projection.refluxEvents.some(event => event.experienceRef === experience && event.refluxKind === 'recalled')) {
      fail('invalid_transition')
    }
    const event: ExperienceRefluxRecordedEvent = {
      schema_version: MEMORY_LIFECYCLE_EVENT_SCHEMA,
      event_ref: ref,
      kind: 'experience_reflux_recorded',
      occurred_at: assertIsoDate(clock.now()),
      consent_ref: common.consentRef,
      reflux_kind: kind,
      experience_ref: experience,
      evidence_ref: evidence,
    }
    appendEvent(common.storeRoot, events, event)
    return eventResult('record-reflux', 'recorded', ref)
  })
}

export function recordPreferenceAssertion(options: RecordPreferenceOptions, clock: Clock = systemClock): MemoryLifecycleCliResult {
  const common = prepareCommon(options)
  const consumer = assertPreferenceConsumer(options.consumer)
  const assertion = assertionRef(common.hmacKey, assertRawLabel(options.assertion))
  const evidence = evidenceRef(common.hmacKey, assertRawLabel(options.evidence, 2048))
  const ref = eventRef(common.hmacKey, 'preference_recorded', [assertion, evidence, consumer])
  return withStoreLock(common.storeRoot, false, () => {
    const { events, projection } = loadLockedStore(common)
    if (eventExists(events, ref)) return eventResult('record-preference', 'unchanged', ref)
    if (projection.preferences.some(preference => preference.assertionRef === assertion)) fail('invalid_transition')
    const event: PreferenceRecordedEvent = {
      schema_version: MEMORY_LIFECYCLE_EVENT_SCHEMA,
      event_ref: ref,
      kind: 'preference_recorded',
      occurred_at: assertIsoDate(clock.now()),
      consent_ref: common.consentRef,
      assertion_ref: assertion,
      evidence_ref: evidence,
      consumer,
      hard_filter: false,
    }
    appendEvent(common.storeRoot, events, event)
    return eventResult('record-preference', 'recorded', ref)
  })
}

function eventResult(command: string, status: CommandStatus, ref: string): MemoryLifecycleCliResult {
  return { schema: 'memory_lifecycle_cli_result.v1', ok: true, command, status, event_ref: ref }
}

export function buildMemoryValueFixture(
  manifest: MemoryLifecycleManifest,
  events: readonly MemoryLifecycleEvent[],
  hmacKey: string,
): MemoryValueFixture {
  assertDatasetKeyMatches(manifest, hmacKey)
  assertEventsBelongToDataset(manifest, events)
  const projection = projectLifecycleEvents(events)
  const pairs: MemoryValueFixture['pairs'] = []
  for (const [subject, flows] of [...projection.flowsBySubject.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const completed = flows.filter(flow => flow.completedAt !== undefined).sort(compareFlows)
    if (completed.length < 2) continue
    const first = completed[0]!
    const returning = completed[1]!
    if (parseIsoMs(returning.startedAt) <= parseIsoMs(first.completedAt!)) fail('invalid_store')
    const pairId = pseudonymousRef(hmacKey, 'pair', [subject, first.flowRef, returning.flowRef])
    pairs.push({
      pair_id: pairId,
      subject_ref: subject,
      first: flowToMemoryValue(first, 1),
      returning: flowToMemoryValue(returning, 2),
    })
  }

  const base = {
    schema: MEMORY_VALUE_FIXTURE_SCHEMA,
    evidence_kind: manifest.source_kind,
    measurement_policy: manifest.measurement_policy,
    pairs,
    experience_reflux_events: projection.refluxEvents
      .slice()
      .sort((a, b) => a.experienceRef.localeCompare(b.experienceRef) || a.refluxKind.localeCompare(b.refluxKind))
      .map(event => ({ experience_id: event.experienceRef, kind: event.refluxKind, evidence_ref: event.evidenceRef })),
    preference_assertions: projection.preferences
      .slice()
      .sort((a, b) => a.assertionRef.localeCompare(b.assertionRef))
      .map(preference => ({
        assertion_id: preference.assertionRef,
        evidence_ref: preference.evidenceRef,
        consumer: preference.consumer,
        hard_filter: false as const,
      })),
    p4: manifest.p4,
  }
  const summaryDigest = memoryValueSummaryDigest(base)
  return {
    schema: base.schema,
    evidence_kind: base.evidence_kind,
    source_review: sourceReviewFor(manifest.source_kind, summaryDigest),
    measurement_policy: base.measurement_policy,
    pairs: base.pairs,
    experience_reflux_events: base.experience_reflux_events,
    preference_assertions: base.preference_assertions,
    p4: base.p4,
  }
}

function flowToMemoryValue(flow: FlowProjection, eligiblePlanningIndex: 1 | 2): MemoryValueFlow {
  if (!flow.completedAt) fail('invalid_store')
  const waits = [...flow.waits.values()]
    .sort((a, b) => parseIsoMs(a.startedAt) - parseIsoMs(b.startedAt) || a.waitRef.localeCompare(b.waitRef))
    .map(wait => {
      if (!wait.completedAt) fail('invalid_store')
      return { code: wait.code, started_at: wait.startedAt, completed_at: wait.completedAt }
    })
  for (let index = 1; index < waits.length; index += 1) {
    if (parseIsoMs(waits[index]!.started_at) < parseIsoMs(waits[index - 1]!.completed_at)) fail('invalid_store')
  }
  return {
    flow_id: flow.flowRef,
    eligible_planning_index: eligiblePlanningIndex,
    eligible: true,
    status: 'completed',
    started_at: flow.startedAt,
    completed_at: flow.completedAt,
    external_waits: waits,
  }
}

function sourceReviewFor(sourceKind: MemoryLifecycleSourceKind, summaryDigest: string): MemoryValueFixture['source_review'] {
  if (!SHA256_PATTERN.test(summaryDigest)) fail('internal_error')
  if (sourceKind === 'synthetic_fixture') {
    return {
      schema_version: MEMORY_VALUE_SOURCE_REVIEW_SCHEMA,
      state: 'not_required_for_synthetic',
      reviewed_at: null,
      reviewer_ref: null,
      attestation_ref: null,
      private_source_digest_sha256: null,
      reviewed_summary_digest_sha256: null,
      checks: {
        raw_private_material_excluded: false,
        paired_cohort_source_reviewed: false,
        summary_matches_private_source: false,
        no_synthetic_or_test_subjects: false,
      },
    }
  }
  return {
    schema_version: MEMORY_VALUE_SOURCE_REVIEW_SCHEMA,
    state: 'candidate',
    reviewed_at: null,
    reviewer_ref: null,
    attestation_ref: null,
    private_source_digest_sha256: null,
    reviewed_summary_digest_sha256: summaryDigest,
    checks: {
      raw_private_material_excluded: true,
      paired_cohort_source_reviewed: false,
      summary_matches_private_source: false,
      no_synthetic_or_test_subjects: false,
    },
  }
}

export function exportMemoryLifecycleFixture(options: ExportOptions): { fixture: MemoryValueFixture; result: MemoryLifecycleCliResult } {
  const common = prepareCommon(options)
  return withStoreLock(common.storeRoot, false, () => {
    const { manifest, events } = loadLockedStore(common)
    const fixture = buildMemoryValueFixture(manifest, events, common.hmacKey)
    if (options.out) {
      const outputPath = resolve(options.out)
      writePrivateFileNoOverwrite(outputPath, `${JSON.stringify(fixture, null, 2)}\n`)
    }
    return {
      fixture,
      result: {
        schema: 'memory_lifecycle_cli_result.v1',
        ok: true,
        command: 'export',
        status: 'recorded',
        dataset_ref: manifest.dataset_ref,
        source_kind: manifest.source_kind,
        pair_count: fixture.pairs.length,
        output_written: Boolean(options.out),
      },
    }
  })
}

export function readStoreForTests(stateRoot: string): { manifest: MemoryLifecycleManifest; events: MemoryLifecycleEvent[] } {
  const safeRoot = assertSafeStateRoot(stateRoot)
  const storeRoot = join(safeRoot, 'gotry-state', 'memory-lifecycle')
  return { manifest: readManifest(storeRoot), events: readEvents(storeRoot) }
}

export function storeRootForStateRoot(stateRoot: string): string {
  return join(assertSafeStateRoot(stateRoot), 'gotry-state', 'memory-lifecycle')
}

export function fileMode(path: string): number {
  return statSync(path).mode & 0o777
}
