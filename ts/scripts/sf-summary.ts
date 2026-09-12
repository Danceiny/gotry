/**
 * Rebuild the offline sf-01..08 evidence summary from one coherent batch.
 *
 * The default root is retained for humans, while tests and proofs must pass
 * --evidence-root explicitly so no shared founder state is read or written.
 */
import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SESSION_FIELD_ACCURACY_THRESHOLD } from '../capabilities/session/benchmark.ts'

export const EXPECTED_QUERY_IDS = Array.from({ length: 8 }, (_, index) => `sf-${(index + 1).toString().padStart(2, '0')}`)

type JsonObject = Record<string, unknown>

interface CanonicalFilename {
  stem: string
  captureAt: string
  chronologyMs: number
}

interface FileInventory {
  queryId: string
  file: string
  absolutePath: string
  canonical: CanonicalFilename | null
}

interface LoadedRecord extends FileInventory {
  record: JsonObject
  explicitBatchId: string | null
  explicitBatchCaptureAt: string | null
  captureAt: string | null
  startedAt: string | null
  chronologyMs: number
}

interface BatchCandidate {
  id: string
  identitySource: string
  captureAt: string | null
  chronologyMs: number
  files: FileInventory[]
  records: LoadedRecord[]
  conflictReason: string | null
}

export interface SummaryRecord {
  query_id: string
  expected: unknown
  official_source: string | null
  requested_source: string | null
  effective_source: string | null
  fallback_reason: string | null
  batch_id: string
  batch_identity_source: string
  evidence_captured_at: string | null
  started_at: string | null
  capture: {
    evidence_captured_at: string | null
    started_at: string | null
    session_fetched_at: string | null
  }
  official_provenance: unknown
  manifest_provenance: unknown
  manifest_sha256: string | null
  manifest_hash: string | null
  batch_provenance: unknown
  session_verdict: string | null
  session_flight: { flight_no: string; dep: string; arr: string; price: number } | null
  soft_score: { accuracy: number; pass: boolean; missing: string[]; incorrect: string[] } | null
  session_latency_ms: number | null
  session_error: string | null
}

export interface RunSummary {
  schema_version: 'gotry_sf_summary_v2'
  generated_at: string
  /** Legacy field; this is the selected batch capture time, never rebuild time. */
  started_at: string | null
  batch_capture_at: string | null
  selected_batch: {
    batch_id: string | null
    identity_source: string | null
    started_at: string | null
    record_count: number
    query_ids: string[]
  }
  status: 'ok' | 'fail_closed'
  total: number
  threshold: number
  accuracy_pass: number
  accuracy_eligible: number
  comparable: number
  hit: number
  challenge: number
  /** 选中批次里出现 challenged/challenge_stop/guard_violation 证据(issue #411):
   *  这类批次按 RFC §3.5 提前停止,缺条是预期行为,但绝不标为完整/有效校准 */
  challenge_stop_detected: boolean
  live_under_15s: number
  missing_query_ids: string[]
  malformed_records: Array<{ query_id: string; file: string; reason: string }>
  invalid_records: Array<{ query_id: string; file: string; reason: string }>
  selected_malformed_records: Array<{ query_id: string; file: string; reason: string }>
  selected_invalid_records: Array<{ query_id: string; file: string; reason: string }>
  unknown_batch_records: Array<{ query_id: string; file: string; reason: string }>
  sources: {
    manual_golden_query_ids: string[]
    static_query_ids: string[]
    flyai_query_ids: string[]
    unknown_query_ids: string[]
  }
  records: SummaryRecord[]
  errors: string[]
}

export interface CliOptions {
  evidenceRoot: string
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function nestedString(value: unknown, ...keys: string[]): string | null {
  let current: unknown = value
  for (const key of keys) {
    if (!isObject(current)) return null
    current = current[key]
  }
  return stringValue(current)
}

function firstString(record: JsonObject, paths: string[][]): string | null {
  for (const path of paths) {
    const value = path.length === 1 ? record[path[0]!] : nestedString(record, ...path)
    const result = stringValue(value)
    if (result !== null) return result
  }
  return null
}

function parseTime(value: string | null): number {
  if (value === null) return Number.NEGATIVE_INFINITY
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY
}

function canonicalFilename(file: string): CanonicalFilename | null {
  // sf-live-benchmark uses runStartedAt.replace(/[:.]/g, '-') for every
  // evidence filename. Only that exact ISO-with-safe-time-punctuation form
  // is a legacy batch identity; arbitrary filenames remain unknown.
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.json$/.exec(file)
  if (match === null) return null
  const captureAt = `${match[1]}:${match[2]}:${match[3]}.${match[4]}Z`
  const chronologyMs = parseTime(captureAt)
  if (!Number.isFinite(chronologyMs)) return null
  return { stem: file.slice(0, -'.json'.length), captureAt, chronologyMs }
}

function captureAt(record: JsonObject): string | null {
  return firstString(record, [
    ['evidence_captured_at'],
    ['captured_at'],
    ['capture_time'],
    ['evidence_capture_time'],
    ['official_captured_at'],
    ['evidence', 'captured_at'],
  ])
}

function startedAt(record: JsonObject): string | null {
  return firstString(record, [
    ['started_at'],
    ['evidence', 'started_at'],
  ])
}

function sessionFetchedAt(record: JsonObject): string | null {
  return nestedString(record.session, 'fetched_at')
}

function explicitBatch(record: JsonObject): { id: string | null; captureAt: string | null; conflict: string | null } {
  const values = [
    stringValue(record.batch_id),
    stringValue(record.batchId),
    stringValue(record.run_id),
    stringValue(record.runId),
    nestedString(record.batch, 'id'),
    nestedString(record.batch, 'batch_id'),
  ].filter((value): value is string => value !== null)
  const unique = Array.from(new Set(values))
  const capture = firstString(record, [
    ['batch_captured_at'],
    ['batch_capture_at'],
    ['batch_started_at'],
    ['run_started_at'],
    ['batch', 'captured_at'],
    ['batch', 'started_at'],
  ])
  const validCapture = capture !== null && Number.isFinite(parseTime(capture)) ? capture : null
  return {
    id: unique[0] ?? null,
    captureAt: validCapture,
    conflict: unique.length > 1 ? `conflicting explicit batch IDs: ${unique.join(', ')}` : null,
  }
}

function recordChronology(record: JsonObject, captured: string | null, started: string | null): number {
  return Math.max(parseTime(captured), parseTime(started), parseTime(sessionFetchedAt(record)))
}

function relativePath(root: string, path: string): string {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
}

function inventoryFiles(evidenceRoot: string): { files: FileInventory[]; candidates: BatchCandidate[]; invalidRecords: RunSummary['invalid_records'] } {
  const files: FileInventory[] = []
  const invalidRecords: RunSummary['invalid_records'] = []
  const canonicalGroups = new Map<string, FileInventory[]>()
  for (const queryId of EXPECTED_QUERY_IDS) {
    const queryDir = join(evidenceRoot, queryId)
    let names: string[]
    try {
      if (!statSync(queryDir).isDirectory()) {
        invalidRecords.push({ query_id: queryId, file: queryId, reason: 'query path is not a directory' })
        continue
      }
      names = readdirSync(queryDir).filter((name) => name.endsWith('.json')).sort()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      invalidRecords.push({ query_id: queryId, file: queryId, reason: error instanceof Error ? error.message : String(error) })
      continue
    }
    for (const name of names) {
      const entry: FileInventory = {
        queryId,
        file: relativePath(evidenceRoot, join(queryDir, name)),
        absolutePath: join(queryDir, name),
        canonical: canonicalFilename(name),
      }
      files.push(entry)
      if (entry.canonical !== null) {
        const group = canonicalGroups.get(entry.canonical.stem) ?? []
        group.push(entry)
        canonicalGroups.set(entry.canonical.stem, group)
      }
    }
  }
  const candidates = Array.from(canonicalGroups.entries()).map(([stem, group]) => {
    const canonical = group.find((entry) => entry.canonical !== null)?.canonical ?? null
    return {
      id: stem,
      identitySource: 'canonical_filename',
      captureAt: canonical?.captureAt ?? null,
      chronologyMs: canonical?.chronologyMs ?? Number.NEGATIVE_INFINITY,
      files: group,
      records: [],
      conflictReason: null,
    }
  })
  return { files, candidates, invalidRecords }
}

function readRecords(inventory: FileInventory[]): {
  records: LoadedRecord[]
  malformedRecords: RunSummary['malformed_records']
  invalidRecords: RunSummary['invalid_records']
  unknownBatchRecords: RunSummary['unknown_batch_records']
} {
  const records: LoadedRecord[] = []
  const malformedRecords: RunSummary['malformed_records'] = []
  const invalidRecords: RunSummary['invalid_records'] = []
  const unknownBatchRecords: RunSummary['unknown_batch_records'] = []
  for (const file of inventory) {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(file.absolutePath, 'utf8'))
    } catch (error) {
      malformedRecords.push({ query_id: file.queryId, file: file.file, reason: error instanceof Error ? error.message : String(error) })
      continue
    }
    if (!isObject(parsed)) {
      invalidRecords.push({ query_id: file.queryId, file: file.file, reason: 'record must be a JSON object' })
      continue
    }
    if (parsed.query_id !== file.queryId) {
      invalidRecords.push({ query_id: file.queryId, file: file.file, reason: `query_id must be ${file.queryId}` })
      continue
    }
    const explicit = explicitBatch(parsed)
    if (explicit.conflict !== null) {
      invalidRecords.push({ query_id: file.queryId, file: file.file, reason: explicit.conflict })
      continue
    }
    const captured = captureAt(parsed)
    const started = startedAt(parsed)
    const loaded: LoadedRecord = {
      ...file,
      record: parsed,
      explicitBatchId: explicit.id,
      explicitBatchCaptureAt: explicit.captureAt,
      captureAt: captured,
      startedAt: started,
      chronologyMs: recordChronology(parsed, captured, started),
    }
    records.push(loaded)
    if (file.canonical === null && (explicit.id === null || explicit.captureAt === null)) {
      unknownBatchRecords.push({
        query_id: file.queryId,
        file: file.file,
        reason: explicit.id === null ? 'missing defensible batch identity' : 'explicit batch ID lacks a valid batch capture timestamp',
      })
    }
  }
  return { records, malformedRecords, invalidRecords, unknownBatchRecords }
}

function completeCandidates(initial: BatchCandidate[], records: LoadedRecord[]): BatchCandidate[] {
  const candidates = initial.map((candidate) => {
    const members = records.filter((record) => record.canonical?.stem === candidate.id)
    const explicitIds = Array.from(new Set(members.map((record) => record.explicitBatchId).filter((value): value is string => value !== null)))
    const conflictReason = explicitIds.length > 1 ? `conflicting explicit batch IDs in filename batch: ${explicitIds.join(', ')}` : null
    const explicitCaptureTimes = Array.from(new Set(members.map((record) => record.explicitBatchCaptureAt).filter((value): value is string => value !== null)))
    const captureAt = candidate.captureAt
    return {
      ...candidate,
      id: conflictReason === null && explicitIds.length === 1 ? explicitIds[0]! : candidate.id,
      identitySource: conflictReason === null && explicitIds.length === 1 ? 'explicit_batch_id+canonical_filename' : candidate.identitySource,
      captureAt,
      records: members,
      conflictReason: conflictReason ?? (explicitCaptureTimes.length > 1 ? `conflicting explicit batch capture times: ${explicitCaptureTimes.join(', ')}` : null),
    }
  })
  const canonicalStems = new Set(initial.flatMap((candidate) => candidate.files.map((file) => file.canonical?.stem).filter((value): value is string => value !== undefined)))
  const explicitOnly = new Map<string, LoadedRecord[]>()
  for (const record of records) {
    if (record.canonical !== null || record.explicitBatchId === null || record.explicitBatchCaptureAt === null) continue
    const group = explicitOnly.get(record.explicitBatchId) ?? []
    group.push(record)
    explicitOnly.set(record.explicitBatchId, group)
  }
  for (const [id, members] of explicitOnly) {
    if (canonicalStems.has(members[0]!.canonical?.stem ?? '')) continue
    const captureTimes = Array.from(new Set(members.map((record) => record.explicitBatchCaptureAt).filter((value): value is string => value !== null)))
    const captureAt = captureTimes[0] ?? null
    candidates.push({
      id,
      identitySource: 'explicit_batch_id',
      captureAt,
      chronologyMs: parseTime(captureAt),
      files: members,
      records: members,
      conflictReason: captureTimes.length > 1 ? `conflicting explicit batch capture times: ${captureTimes.join(', ')}` : null,
    })
  }
  return candidates
}

function chooseBatch(candidates: BatchCandidate[]): BatchCandidate | null {
  return candidates.slice().sort((left, right) => {
    if (right.chronologyMs !== left.chronologyMs) return right.chronologyMs - left.chronologyMs
    if (right.files.length !== left.files.length) return right.files.length - left.files.length
    return right.id.localeCompare(left.id)
  })[0] ?? null
}

function selectBatchRecords(batch: BatchCandidate): Map<string, LoadedRecord> {
  const selected = new Map<string, LoadedRecord>()
  for (const record of batch.records) {
    const previous = selected.get(record.queryId)
    if (previous === undefined || record.chronologyMs > previous.chronologyMs || (record.chronologyMs === previous.chronologyMs && record.file > previous.file)) selected.set(record.queryId, record)
  }
  return selected
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function sourceFields(record: JsonObject): { official: string | null; requested: string | null; effective: string | null; fallback: string | null } {
  const requested = stringValue(record.requested_source)
  const effective = stringValue(record.effective_source) ?? stringValue(record.official_source) ?? nestedString(record.official, 'source')
  return {
    official: stringValue(record.official_source) ?? effective,
    requested,
    effective,
    fallback: stringValue(record.fallback_reason),
  }
}

function sourceBucket(record: SummaryRecord): keyof RunSummary['sources'] {
  const normalizedRequested = record.requested_source?.toLowerCase()
  const normalizedEffective = record.effective_source?.toLowerCase() ?? ''
  if (normalizedRequested === 'static' || normalizedEffective.startsWith('static')) return 'static_query_ids'
  if (normalizedEffective === 'manual-golden' || normalizedEffective === 'manual') return 'manual_golden_query_ids'
  if (normalizedEffective === 'flyai' || normalizedEffective.startsWith('flyai')) return 'flyai_query_ids'
  return 'unknown_query_ids'
}

function toSummaryRecord(item: LoadedRecord, batchId: string, batchIdentitySource: string): SummaryRecord {
  const record = item.record
  const fields = sourceFields(record)
  const session = isObject(record.session) ? record.session : null
  const soft = isObject(record.softScore) ? record.softScore : null
  const segments = session && Array.isArray(session.route_segments) ? session.route_segments : []
  const firstSegment = isObject(segments[0]) ? segments[0] : null
  const verdict = stringValue(session?.verdict) ?? stringValue(record.sessionVerdict)
  const price = numberValue(session?.price)
  const sessionFlight = verdict === 'hit' && firstSegment !== null
    ? {
        flight_no: stringValue(firstSegment.transport_number) ?? '',
        dep: stringValue(firstSegment.departure_at) ?? '',
        arr: stringValue(firstSegment.arrival_at) ?? '',
        price: price ?? 0,
      }
    : null
  const sessionFetched = sessionFetchedAt(record)
  const softScore = soft === null ? null : {
    accuracy: numberValue(soft.accuracy) ?? 0,
    pass: soft.pass === true,
    missing: Array.isArray(soft.missing) ? soft.missing.filter((value): value is string => typeof value === 'string') : [],
    incorrect: Array.isArray(soft.incorrect) ? soft.incorrect.filter((value): value is string => typeof value === 'string') : [],
  }
  return {
    query_id: item.queryId,
    expected: record.expected ?? null,
    official_source: fields.official,
    requested_source: fields.requested,
    effective_source: fields.effective,
    fallback_reason: fields.fallback,
    batch_id: batchId,
    batch_identity_source: batchIdentitySource,
    evidence_captured_at: item.captureAt,
    started_at: item.startedAt,
    capture: {
      evidence_captured_at: item.captureAt,
      started_at: item.startedAt,
      session_fetched_at: sessionFetched,
    },
    official_provenance: record.official_provenance ?? null,
    manifest_provenance: record.manifest_provenance ?? record.manifest ?? null,
    manifest_sha256: stringValue(record.manifest_sha256) ?? nestedString(record.manifest_provenance, 'sha256'),
    manifest_hash: stringValue(record.manifest_hash) ?? nestedString(record.manifest_provenance, 'hash'),
    batch_provenance: record.batch_provenance ?? null,
    session_verdict: verdict,
    session_flight: sessionFlight,
    soft_score: softScore,
    session_latency_ms: numberValue(record.sessionLatencyMs),
    session_error: stringValue(record.sessionError),
  }
}

function challengeStopHit(item: LoadedRecord): boolean {
  // 新证据:session.verdict / doubleSource.state 承载语义;旧证据(改写 bug 时代):
  // session.verdict 被改写为 error,但顶层 sessionVerdict 仍是 challenged——一并识别
  if (nestedString(item.record.session, 'verdict') === 'challenged') return true
  if (stringValue(item.record.sessionVerdict) === 'challenged') return true
  const state = nestedString(item.record.doubleSource, 'state')
  return state === 'challenge_stop' || state === 'guard_violation'
}

function buildErrors(summary: Pick<RunSummary, 'selected_batch' | 'missing_query_ids' | 'selected_malformed_records' | 'selected_invalid_records' | 'challenge_stop_detected'>, conflictReason: string | null): string[] {
  const errors: string[] = []
  if (summary.selected_batch.batch_id === null) errors.push('no defensible batch identity found')
  if (conflictReason !== null) errors.push(conflictReason)
  if (summary.missing_query_ids.length > 0) errors.push(`missing query IDs: ${summary.missing_query_ids.join(', ')}`)
  if (summary.selected_malformed_records.length > 0) errors.push(`malformed JSON: ${summary.selected_malformed_records.map((item) => item.file).join(', ')}`)
  if (summary.selected_invalid_records.length > 0) errors.push(`invalid records: ${summary.selected_invalid_records.map((item) => item.file).join(', ')}`)
  if (summary.challenge_stop_detected) errors.push('challenge/guard stop evidence: batch is not a complete calibration')
  return errors
}

export function parseCliArgs(args: string[]): CliOptions {
  let evidenceRoot: string | null = null
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === '--evidence-root') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error('--evidence-root requires a path')
      evidenceRoot = value
      index += 1
    } else if (arg.startsWith('--evidence-root=')) {
      const value = arg.slice('--evidence-root='.length)
      if (value.length === 0) throw new Error('--evidence-root requires a path')
      evidenceRoot = value
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return { evidenceRoot: resolve(evidenceRoot ?? join(homedir(), '.gotry', 'evidence', 'session')) }
}

export function buildSummary(evidenceRoot: string, generatedAt = new Date().toISOString()): { summary: RunSummary; summaryPath: string } {
  const root = resolve(evidenceRoot)
  const inventory = inventoryFiles(root)
  const loaded = readRecords(inventory.files)
  const candidates = completeCandidates(inventory.candidates, loaded.records)
  const batch = chooseBatch(candidates)
  const selected = batch === null ? new Map<string, LoadedRecord>() : selectBatchRecords(batch)
  const selectedRecords = EXPECTED_QUERY_IDS.flatMap((queryId) => {
    const item = selected.get(queryId)
    return item === undefined || batch === null ? [] : [toSummaryRecord(item, batch.id, batch.identitySource)]
  })
  const selectedFiles = new Set(batch?.files.map((file) => file.file) ?? [])
  const selectedMalformed = loaded.malformedRecords.filter((item) => selectedFiles.has(item.file))
  const selectedInvalid = [...inventory.invalidRecords, ...loaded.invalidRecords].filter((item) => selectedFiles.has(item.file))
  const missingQueryIds = EXPECTED_QUERY_IDS.filter((queryId) => !selected.has(queryId))
  const batchCaptureAt = batch?.captureAt ?? null
  const summary: RunSummary = {
    schema_version: 'gotry_sf_summary_v2',
    generated_at: generatedAt,
    started_at: batchCaptureAt,
    batch_capture_at: batchCaptureAt,
    selected_batch: {
      batch_id: batch?.id ?? null,
      identity_source: batch?.identitySource ?? null,
      started_at: batchCaptureAt,
      record_count: selectedRecords.length,
      query_ids: selectedRecords.map((record) => record.query_id),
    },
    status: 'fail_closed',
    total: selectedRecords.length,
    threshold: SESSION_FIELD_ACCURACY_THRESHOLD,
    accuracy_pass: selectedRecords.filter((record) => record.soft_score?.pass === true).length,
    accuracy_eligible: selectedRecords.filter((record) => record.soft_score !== null).length,
    comparable: selectedRecords.filter((record) => {
      const item = selected.get(record.query_id)
      return item !== undefined && isObject(item.record.doubleSource) && item.record.doubleSource.state === 'comparable'
    }).length,
    hit: selectedRecords.filter((record) => record.session_verdict === 'hit').length,
    challenge: selectedRecords.filter((record) => record.session_verdict === 'challenged').length,
    challenge_stop_detected: selectedRecords.some((record) => challengeStopHit(selected.get(record.query_id)!)),
    live_under_15s: selectedRecords.filter((record) => record.session_verdict === 'hit' && record.session_latency_ms !== null && record.session_latency_ms < 15_000).length,
    missing_query_ids: missingQueryIds,
    malformed_records: loaded.malformedRecords,
    invalid_records: [...inventory.invalidRecords, ...loaded.invalidRecords],
    selected_malformed_records: selectedMalformed,
    selected_invalid_records: selectedInvalid,
    unknown_batch_records: loaded.unknownBatchRecords,
    sources: {
      manual_golden_query_ids: [],
      static_query_ids: [],
      flyai_query_ids: [],
      unknown_query_ids: [],
    },
    records: selectedRecords,
    errors: [],
  }
  for (const record of summary.records) summary.sources[sourceBucket(record)].push(record.query_id)
  summary.errors = buildErrors(summary, batch?.conflictReason ?? (batch === null ? null : null))
  summary.status = summary.errors.length === 0 ? 'ok' : 'fail_closed'

  const summaryPath = join(root, 'sf-summary', `${generatedAt.replace(/[:.]/g, '-')}.json`)
  mkdirSync(dirname(summaryPath), { recursive: true })
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2))
  return { summary, summaryPath }
}

export function main(args = process.argv.slice(2)): number {
  try {
    const options = parseCliArgs(args)
    const { summary, summaryPath } = buildSummary(options.evidenceRoot)
    console.log('──── sf-summary (coherent offline batch) ────')
    console.log(`status: ${summary.status}`)
    console.log(`selected batch: ${summary.selected_batch.batch_id ?? '(none)'}`)
    console.log(`batch capture: ${summary.batch_capture_at ?? '(unknown)'}`)
    console.log(`generated at: ${summary.generated_at}`)
    console.log(`total: ${summary.total}/${EXPECTED_QUERY_IDS.length}`)
    console.log(`verdict=hit: ${summary.hit}/${summary.total}`)
    if (summary.challenge_stop_detected) console.log('challenge stop detected: 部分批次为挑战截断产物(RFC §3.5),不计为完整/有效校准')
    console.log(`soft score ≥${summary.threshold * 100}%: ${summary.accuracy_pass}/${summary.accuracy_eligible}`)
    console.log(`manual golden query_ids: ${summary.sources.manual_golden_query_ids.join(', ') || '(none)'}`)
    console.log(`static query_ids: ${summary.sources.static_query_ids.join(', ') || '(none)'}`)
    console.log(`flyai query_ids: ${summary.sources.flyai_query_ids.join(', ') || '(none)'}`)
    console.log(`unknown source query_ids: ${summary.sources.unknown_query_ids.join(', ') || '(none)'}`)
    if (summary.missing_query_ids.length > 0) console.error(`missing query IDs: ${summary.missing_query_ids.join(', ')}`)
    if (summary.selected_malformed_records.length > 0) console.error(`malformed JSON: ${summary.selected_malformed_records.map((item) => item.file).join(', ')}`)
    if (summary.selected_invalid_records.length > 0) console.error(`invalid records: ${summary.selected_invalid_records.map((item) => item.file).join(', ')}`)
    if (summary.malformed_records.length > summary.selected_malformed_records.length) console.error(`diagnostic malformed JSON outside selected batch: ${summary.malformed_records.length - summary.selected_malformed_records.length}`)
    console.log(`summary: ${summaryPath}`)
    return summary.status === 'ok' ? 0 : 1
  } catch (error) {
    console.error(`[sf-summary] fail-closed: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

// Issue #420: realpathSync canonicalizes the invocation path and the module
// URL so the entrypoint guard still recognizes file- and directory-symlink
// invocations. Without canonicalization, `resolve(process.argv[1])` keeps the
// symlink path while `fileURLToPath(import.meta.url)` is the real path, and
// the mismatch silently skips main(). When imported from another module,
// `process.argv[1]` points at the importer, not at this file, so the guard
// still fails and main() stays inert.
function canonicalEntry(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1])
if (invokedPath !== null && canonicalEntry(invokedPath) === canonicalEntry(fileURLToPath(import.meta.url))) process.exitCode = main()
