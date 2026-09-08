/**
 * M4 memory value evidence scorer (GitHub Issue #20/#223).
 *
 * The scorer is deliberately read-only. It accepts a public fixture or a
 * private observed cohort manifest and emits one deterministic JSON report.
 * Synthetic fixtures can prove the contract and calculations, but can never
 * satisfy M4 Exit. Observed-private inputs only become exit-eligible when a
 * human source-review attestation contract is present; the scorer validates
 * that contract shape but does not inspect private raw material.
 *
 * Usage:
 *   npx tsx scripts/memory-value-report.ts data/memory-value-fixture.json
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

type JsonObject = Record<string, unknown>
type EvidenceKind = 'synthetic_fixture' | 'observed_private'
type SourceReviewState = 'not_required_for_synthetic' | 'candidate' | 'manual_attested'
type P4State = 'closed' | 'open'
type RefluxKind = 'recalled' | 'verified_outcome'
type AssertionConsumer = 'ranking' | 'explanation' | 'hard_filter'

interface WaitInterval {
  code: string
  startedAtMs: number
  completedAtMs: number
}

interface FlowScore {
  activeSeconds: number
  completedAtMs: number
  flowId: string
  startedAtMs: number
}

interface SourceReviewReport {
  required_for_exit: boolean
  state: SourceReviewState | 'unknown'
  contract_met: boolean
  provenance_verified_by_scorer: false
  reviewed_at: string | null
  reviewer_ref: string | null
  attestation_ref: string | null
  private_source_digest_sha256: string | null
  reviewed_summary_digest_sha256: string | null
  current_summary_digest_sha256: string | null
  reason: string
}

interface SourceReviewScore {
  report: SourceReviewReport
}

export interface MemoryValueReport {
  schema: 'memory_value_report.v1'
  contract_valid: boolean
  errors: string[]
  source: {
    fixture_schema: string
    evidence_kind: string
    quantile_method: 'nearest_rank'
    active_duration_rule: 'wall_clock_minus_non_overlapping_predeclared_external_waits'
    id_format: 'hmac-sha256:<64lowerhex>'
    source_review: SourceReviewReport
  }
  cohort: {
    eligible_pair_count: number
    first_active_seconds: { p50: number; p75: number }
    returning_active_seconds: { p50: number; p75: number }
    paired_reduction_ratio: { p50: number; p75: number }
    target_median_reduction_ratio: number
    target_met: boolean
    minimum_pair_count_for_exit: number
    sample_size_met: boolean
  }
  experience_reflux: {
    recalled_experience_count: number
    verified_experience_count: number
    baseline: number | null
    baseline_available: boolean
    real_evidence: boolean
  }
  preference_assertions: {
    total_count: number
    traceable_count: number
    traceable_ratio: number
    hard_filter_violation_count: number
    contract_met: boolean
  }
  p4: {
    state: P4State | 'unknown'
    trigger_observed: boolean
    contract_met: boolean
  }
  exit_evidence_eligible: boolean
  exit_ready: boolean
}

const M4_ACCEPTANCE = {
  minimumPairCountForExit: 5,
  targetMedianReductionRatio: 0.5,
} as const

const HMAC_REF = /^hmac-sha256:[0-9a-f]{64}$/
const SHA256 = /^[0-9a-f]{64}$/
const ISO_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000
}

function nearestRankRaw(values: number[], percentile: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1)
  return sorted[index]!
}

function nearestRank(values: number[], percentile: number): number {
  return round(nearestRankRaw(values, percentile))
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function memoryValueSummaryDigest(input: unknown): string {
  const payload = isObject(input)
    ? Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'source_review'))
    : input
  return createHash('sha256').update(canonical(payload)).digest('hex')
}

function exactKeys(value: JsonObject, label: string, keys: readonly string[], errors: string[]): void {
  const expected = new Set(keys)
  if (Object.keys(value).some(key => !expected.has(key))) {
    errors.push(`${label} contains undeclared field(s)`)
  }
  if (keys.some(key => !(key in value))) {
    errors.push(`${label} is missing required field(s)`)
  }
}

function object(value: unknown, label: string, errors: string[]): JsonObject | null {
  if (!isObject(value)) {
    errors.push(`${label} must be an object`)
    return null
  }
  return value
}

function array(value: unknown, label: string, errors: string[], options: { nonEmpty?: boolean } = {}): unknown[] {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`)
    return []
  }
  if (options.nonEmpty && value.length === 0) errors.push(`${label} must be a non-empty array`)
  return value
}

function string(value: unknown, label: string, errors: string[]): string | null {
  if (!nonEmptyString(value)) {
    errors.push(`${label} must be a non-empty string`)
    return null
  }
  return value
}

function nullableString(value: unknown, label: string, errors: string[]): string | null {
  if (value === null) return null
  return string(value, label, errors)
}

function boolean(value: unknown, label: string, errors: string[]): boolean | null {
  if (typeof value !== 'boolean') {
    errors.push(`${label} must be boolean`)
    return null
  }
  return value
}

function finiteNumber(value: unknown, label: string, errors: string[]): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${label} must be a finite number`)
    return null
  }
  return value
}

function integer(value: unknown, label: string, errors: string[]): number | null {
  const result = finiteNumber(value, label, errors)
  if (result === null) return null
  if (!Number.isInteger(result)) {
    errors.push(`${label} must be an integer`)
    return null
  }
  return result
}

function literal<T extends string>(value: unknown, label: string, allowed: readonly T[], errors: string[]): T | null {
  const result = string(value, label, errors)
  if (result === null) return null
  if (!allowed.includes(result as T)) {
    errors.push(`${label} must be one of the declared enum values`)
    return null
  }
  return result as T
}

function hmacRef(value: unknown, label: string, errors: string[]): string | null {
  const result = string(value, label, errors)
  if (result === null) return null
  if (!HMAC_REF.test(result)) {
    errors.push(`${label} must be an hmac-sha256 pseudonymous reference`)
    return null
  }
  return result
}

function nullableHmacRef(value: unknown, label: string, errors: string[]): string | null {
  if (value === null) return null
  return hmacRef(value, label, errors)
}

function nullableSha256(value: unknown, label: string, errors: string[]): string | null {
  if (value === null) return null
  const result = string(value, label, errors)
  if (result === null) return null
  if (!SHA256.test(result)) {
    errors.push(`${label} must be a lowercase SHA-256 digest`)
    return null
  }
  return result
}

function parseTimestamp(value: unknown, label: string, errors: string[]): { text: string; ms: number } | null {
  const result = string(value, label, errors)
  if (result === null) return null
  if (!ISO_UTC_TIMESTAMP.test(result)) {
    errors.push(`${label} must be a strict UTC ISO timestamp`)
    return null
  }
  const parsed = Date.parse(result)
  if (!Number.isFinite(parsed)) {
    errors.push(`${label} must be a valid UTC ISO timestamp`)
    return null
  }
  const canonical = new Date(parsed).toISOString()
  const normalized = result.includes('.') ? result : result.replace('Z', '.000Z')
  if (canonical !== normalized) {
    errors.push(`${label} must be a valid UTC ISO timestamp`)
    return null
  }
  return { text: result, ms: parsed }
}

function nullableTimestamp(value: unknown, label: string, errors: string[]): { text: string; ms: number } | null {
  if (value === null) return null
  return parseTimestamp(value, label, errors)
}

function assertUnique(value: string | null, seen: Set<string>, label: string, errors: string[]): void {
  if (value === null) return
  if (seen.has(value)) errors.push(`${label} must be unique`)
  else seen.add(value)
}

function waitCode(value: unknown, label: string, allowedWaitCodes: Set<string>, errors: string[]): string | null {
  const code = string(value, label, errors)
  if (code === null) return null
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(code) || !allowedWaitCodes.has(code)) {
    errors.push(`${label} must be predeclared by measurement_policy`)
    return null
  }
  return code
}

function scoreFlow(
  value: unknown,
  path: string,
  expectedEligibleIndex: 1 | 2,
  allowedWaitCodes: Set<string>,
  errors: string[],
): FlowScore | null {
  const raw = object(value, path, errors)
  if (raw === null) return null
  exactKeys(raw, path, ['flow_id', 'eligible_planning_index', 'eligible', 'status', 'started_at', 'completed_at', 'external_waits'], errors)

  const flowId = hmacRef(raw.flow_id, `${path}.flow_id`, errors)
  const eligible = boolean(raw.eligible, `${path}.eligible`, errors)
  if (eligible !== true) errors.push(`${path}.eligible must be true`)
  literal(raw.status, `${path}.status`, ['completed'], errors)
  const eligiblePlanningIndex = integer(raw.eligible_planning_index, `${path}.eligible_planning_index`, errors)
  if (eligiblePlanningIndex !== null && eligiblePlanningIndex !== expectedEligibleIndex) {
    errors.push(`${path}.eligible_planning_index must match the paired flow position`)
  }

  const startedAt = parseTimestamp(raw.started_at, `${path}.started_at`, errors)
  const completedAt = parseTimestamp(raw.completed_at, `${path}.completed_at`, errors)
  if (startedAt === null || completedAt === null) return null
  if (completedAt.ms <= startedAt.ms) {
    errors.push(`${path}.completed_at must be after started_at`)
    return null
  }

  const waits: WaitInterval[] = []
  for (const [index, rawWait] of array(raw.external_waits, `${path}.external_waits`, errors).entries()) {
    const waitPath = `${path}.external_waits[${index}]`
    const wait = object(rawWait, waitPath, errors)
    if (wait === null) continue
    exactKeys(wait, waitPath, ['code', 'started_at', 'completed_at'], errors)
    const code = waitCode(wait.code, `${waitPath}.code`, allowedWaitCodes, errors)
    const waitStartedAt = parseTimestamp(wait.started_at, `${waitPath}.started_at`, errors)
    const waitCompletedAt = parseTimestamp(wait.completed_at, `${waitPath}.completed_at`, errors)
    if (code === null || waitStartedAt === null || waitCompletedAt === null) continue
    if (waitCompletedAt.ms <= waitStartedAt.ms) {
      errors.push(`${waitPath}.completed_at must be after started_at`)
      continue
    }
    if (waitStartedAt.ms < startedAt.ms || waitCompletedAt.ms > completedAt.ms) {
      errors.push(`${waitPath} must stay inside the planning flow`)
      continue
    }
    waits.push({ code, startedAtMs: waitStartedAt.ms, completedAtMs: waitCompletedAt.ms })
  }

  waits.sort((a, b) => a.startedAtMs - b.startedAtMs)
  for (let index = 1; index < waits.length; index += 1) {
    if (waits[index]!.startedAtMs < waits[index - 1]!.completedAtMs) {
      errors.push(`${path}.external_waits must not overlap`)
    }
  }

  const externalWaitMs = waits.reduce((total, wait) => total + wait.completedAtMs - wait.startedAtMs, 0)
  const activeSeconds = (completedAt.ms - startedAt.ms - externalWaitMs) / 1_000
  if (activeSeconds <= 0) errors.push(`${path} must have positive active planning duration`)

  return flowId === null
    ? null
    : { activeSeconds, completedAtMs: completedAt.ms, flowId, startedAtMs: startedAt.ms }
}

function sourceReviewReport(
  evidenceKind: EvidenceKind | null,
  state: SourceReviewState | 'unknown',
  contractMet: boolean,
  fields: {
    reviewedAt?: string | null
    reviewerRef?: string | null
    attestationRef?: string | null
    privateSourceDigest?: string | null
    reviewedSummaryDigest?: string | null
    currentSummaryDigest?: string | null
  } = {},
): SourceReviewReport {
  const shared = {
    reviewed_at: fields.reviewedAt ?? null,
    reviewer_ref: fields.reviewerRef ?? null,
    attestation_ref: fields.attestationRef ?? null,
    private_source_digest_sha256: fields.privateSourceDigest ?? null,
    reviewed_summary_digest_sha256: fields.reviewedSummaryDigest ?? null,
    current_summary_digest_sha256: fields.currentSummaryDigest ?? null,
  }
  if (evidenceKind === 'synthetic_fixture') {
    return {
      required_for_exit: false,
      state,
      contract_met: false,
      provenance_verified_by_scorer: false,
      ...shared,
      reason: 'synthetic_fixture validates formulas only and is never business evidence',
    }
  }
  if (contractMet) {
    return {
      required_for_exit: true,
      state,
      contract_met: true,
      provenance_verified_by_scorer: false,
      ...shared,
      reason: 'manual source-review attestation contract is present for this scoring payload; raw private source review remains a human responsibility',
    }
  }
  return {
    required_for_exit: evidenceKind === 'observed_private',
    state,
    contract_met: false,
    provenance_verified_by_scorer: false,
    ...shared,
    reason: evidenceKind === 'observed_private'
      ? 'observed_private remains a candidate until the manual source-review attestation contract matches this scoring payload'
      : 'source kind is not exit-eligible',
  }
}

function scoreSourceReview(
  value: unknown,
  evidenceKind: EvidenceKind | null,
  currentSummaryDigest: string,
  errors: string[],
): SourceReviewScore {
  const raw = object(value, 'source_review', errors)
  if (raw === null) {
    return { report: sourceReviewReport(evidenceKind, 'unknown', false, { currentSummaryDigest }) }
  }
  exactKeys(raw, 'source_review', [
    'schema_version',
    'state',
    'reviewed_at',
    'reviewer_ref',
    'attestation_ref',
    'private_source_digest_sha256',
    'reviewed_summary_digest_sha256',
    'checks',
  ], errors)
  literal(raw.schema_version, 'source_review.schema_version', ['memory_value_source_review.v1'], errors)
  const state = literal(raw.state, 'source_review.state', ['not_required_for_synthetic', 'candidate', 'manual_attested'], errors) ?? 'unknown'
  const reviewedAt = nullableTimestamp(raw.reviewed_at, 'source_review.reviewed_at', errors)
  const reviewerRef = nullableHmacRef(raw.reviewer_ref, 'source_review.reviewer_ref', errors)
  const attestationRef = nullableHmacRef(raw.attestation_ref, 'source_review.attestation_ref', errors)
  const privateSourceDigest = nullableSha256(raw.private_source_digest_sha256, 'source_review.private_source_digest_sha256', errors)
  const reviewedSummaryDigest = nullableSha256(raw.reviewed_summary_digest_sha256, 'source_review.reviewed_summary_digest_sha256', errors)
  if (reviewedSummaryDigest !== null && reviewedSummaryDigest !== currentSummaryDigest) {
    errors.push('source_review.reviewed_summary_digest_sha256 must match the current scoring payload digest')
  }

  const checks = object(raw.checks, 'source_review.checks', errors)
  const parsedChecks: Record<string, boolean> = {}
  if (checks !== null) {
    exactKeys(checks, 'source_review.checks', [
      'raw_private_material_excluded',
      'paired_cohort_source_reviewed',
      'summary_matches_private_source',
      'no_synthetic_or_test_subjects',
    ], errors)
    for (const key of [
      'raw_private_material_excluded',
      'paired_cohort_source_reviewed',
      'summary_matches_private_source',
      'no_synthetic_or_test_subjects',
    ] as const) {
      const parsed = boolean(checks[key], `source_review.checks.${key}`, errors)
      if (parsed !== null) parsedChecks[key] = parsed
    }
  }

  if (evidenceKind === 'synthetic_fixture' && state !== 'not_required_for_synthetic') {
    errors.push('source_review.state must match synthetic evidence')
  }
  if (evidenceKind === 'observed_private' && state === 'not_required_for_synthetic') {
    errors.push('source_review.state must require observed private review')
  }

  const allReviewChecksMet = [
    parsedChecks.raw_private_material_excluded,
    parsedChecks.paired_cohort_source_reviewed,
    parsedChecks.summary_matches_private_source,
    parsedChecks.no_synthetic_or_test_subjects,
  ].every(Boolean)
  const contractMet = evidenceKind === 'observed_private'
    && state === 'manual_attested'
    && reviewedAt !== null
    && reviewerRef !== null
    && attestationRef !== null
    && privateSourceDigest !== null
    && reviewedSummaryDigest === currentSummaryDigest
    && allReviewChecksMet

  return {
    report: sourceReviewReport(evidenceKind, state, contractMet, {
      reviewedAt: reviewedAt?.text ?? null,
      reviewerRef,
      attestationRef,
      privateSourceDigest,
      reviewedSummaryDigest,
      currentSummaryDigest,
    }),
  }
}

function invalidReport(
  errors: string[],
  schema = '',
  evidenceKind: EvidenceKind | '' = '',
  sourceReview = sourceReviewReport(evidenceKind || null, 'unknown', false),
): MemoryValueReport {
  return {
    schema: 'memory_value_report.v1',
    contract_valid: false,
    errors,
    source: {
      fixture_schema: schema,
      evidence_kind: evidenceKind,
      quantile_method: 'nearest_rank',
      active_duration_rule: 'wall_clock_minus_non_overlapping_predeclared_external_waits',
      id_format: 'hmac-sha256:<64lowerhex>',
      source_review: sourceReview,
    },
    cohort: {
      eligible_pair_count: 0,
      first_active_seconds: { p50: 0, p75: 0 },
      returning_active_seconds: { p50: 0, p75: 0 },
      paired_reduction_ratio: { p50: 0, p75: 0 },
      target_median_reduction_ratio: 0,
      target_met: false,
      minimum_pair_count_for_exit: 0,
      sample_size_met: false,
    },
    experience_reflux: {
      recalled_experience_count: 0,
      verified_experience_count: 0,
      baseline: null,
      baseline_available: false,
      real_evidence: false,
    },
    preference_assertions: {
      total_count: 0,
      traceable_count: 0,
      traceable_ratio: 0,
      hard_filter_violation_count: 0,
      contract_met: false,
    },
    p4: { state: 'unknown', trigger_observed: false, contract_met: false },
    exit_evidence_eligible: false,
    exit_ready: false,
  }
}

export function scoreMemoryValue(input: unknown): MemoryValueReport {
  const errors: string[] = []
  if (!isObject(input)) return invalidReport(['root must be an object'])
  exactKeys(input, 'root', ['schema', 'evidence_kind', 'source_review', 'measurement_policy', 'pairs', 'experience_reflux_events', 'preference_assertions', 'p4'], errors)
  const currentSummaryDigest = memoryValueSummaryDigest(input)

  const schema = literal(input.schema, 'schema', ['memory_value_fixture.v1'], errors)
  const evidenceKind = literal(input.evidence_kind, 'evidence_kind', ['synthetic_fixture', 'observed_private'], errors)
  const sourceReview = scoreSourceReview(input.source_review, evidenceKind, currentSummaryDigest, errors).report

  const policy = object(input.measurement_policy, 'measurement_policy', errors)
  const allowedWaitCodes = new Set<string>()
  if (policy !== null) {
    exactKeys(policy, 'measurement_policy', [
      'quantile_method',
      'predeclared_external_wait_codes',
      'minimum_pair_count_for_exit',
      'target_median_reduction_ratio',
    ], errors)
    literal(policy.quantile_method, 'measurement_policy.quantile_method', ['nearest_rank'], errors)

    for (const code of array(policy.predeclared_external_wait_codes, 'measurement_policy.predeclared_external_wait_codes', errors, { nonEmpty: true })) {
      if (!nonEmptyString(code) || !/^[a-z][a-z0-9_]{0,31}$/.test(code)) {
        errors.push('measurement_policy.predeclared_external_wait_codes must contain declared wait-code strings')
        continue
      }
      if (allowedWaitCodes.has(code)) errors.push('measurement_policy.predeclared_external_wait_codes must not contain duplicates')
      allowedWaitCodes.add(code)
    }

    const minimumPairCount = integer(policy.minimum_pair_count_for_exit, 'measurement_policy.minimum_pair_count_for_exit', errors)
    if (minimumPairCount !== null && minimumPairCount !== M4_ACCEPTANCE.minimumPairCountForExit) {
      errors.push(`measurement_policy.minimum_pair_count_for_exit is frozen at ${M4_ACCEPTANCE.minimumPairCountForExit}`)
    }
    const targetReduction = finiteNumber(policy.target_median_reduction_ratio, 'measurement_policy.target_median_reduction_ratio', errors)
    if (targetReduction !== null && targetReduction !== M4_ACCEPTANCE.targetMedianReductionRatio) {
      errors.push(`measurement_policy.target_median_reduction_ratio is frozen at ${M4_ACCEPTANCE.targetMedianReductionRatio}`)
    }
  }

  const firstDurations: number[] = []
  const returningDurations: number[] = []
  const reductions: number[] = []
  const pairIds = new Set<string>()
  const subjectRefs = new Set<string>()
  const flowIds = new Set<string>()
  for (const [index, rawPair] of array(input.pairs, 'pairs', errors, { nonEmpty: true }).entries()) {
    const pairPath = `pairs[${index}]`
    const pair = object(rawPair, pairPath, errors)
    if (pair === null) continue
    exactKeys(pair, pairPath, ['pair_id', 'subject_ref', 'first', 'returning'], errors)
    const pairId = hmacRef(pair.pair_id, `${pairPath}.pair_id`, errors)
    const subjectRef = hmacRef(pair.subject_ref, `${pairPath}.subject_ref`, errors)
    assertUnique(pairId, pairIds, `${pairPath}.pair_id`, errors)
    assertUnique(subjectRef, subjectRefs, `${pairPath}.subject_ref`, errors)

    const first = scoreFlow(pair.first, `${pairPath}.first`, 1, allowedWaitCodes, errors)
    const returning = scoreFlow(pair.returning, `${pairPath}.returning`, 2, allowedWaitCodes, errors)
    for (const flow of [first, returning]) {
      if (!flow) continue
      assertUnique(flow.flowId, flowIds, `${pairPath}.flow_id`, errors)
    }
    if (!first || !returning || first.activeSeconds <= 0 || returning.activeSeconds <= 0) continue
    if (returning.startedAtMs <= first.completedAtMs) {
      errors.push(`${pairPath}.returning must start after the first completed flow`)
    }
    firstDurations.push(first.activeSeconds)
    returningDurations.push(returning.activeSeconds)
    reductions.push((first.activeSeconds - returning.activeSeconds) / first.activeSeconds)
  }

  const recalled = new Set<string>()
  const verified = new Set<string>()
  const refluxEventKeys = new Set<string>()
  const refluxEvidenceRefs = new Set<string>()
  for (const [index, rawEvent] of array(input.experience_reflux_events, 'experience_reflux_events', errors).entries()) {
    const eventPath = `experience_reflux_events[${index}]`
    const event = object(rawEvent, eventPath, errors)
    if (event === null) continue
    exactKeys(event, eventPath, ['experience_id', 'kind', 'evidence_ref'], errors)
    const experienceId = hmacRef(event.experience_id, `${eventPath}.experience_id`, errors)
    const kind = literal(event.kind, `${eventPath}.kind`, ['recalled', 'verified_outcome'], errors)
    const evidenceRef = hmacRef(event.evidence_ref, `${eventPath}.evidence_ref`, errors)
    assertUnique(evidenceRef, refluxEvidenceRefs, `${eventPath}.evidence_ref`, errors)
    if (experienceId === null || kind === null) continue
    assertUnique(`${kind}:${experienceId}`, refluxEventKeys, `${eventPath}.experience_id+kind`, errors)
    if (kind === 'recalled') recalled.add(experienceId)
    else verified.add(experienceId)
  }
  for (const experienceId of verified) {
    if (!recalled.has(experienceId)) errors.push('each verified_outcome experience must have a recalled event')
  }
  const verifiedRecalledCount = [...verified].filter(id => recalled.has(id)).length
  const refluxBaseline = recalled.size > 0 ? round(verifiedRecalledCount / recalled.size) : null

  const assertionsRaw = array(input.preference_assertions, 'preference_assertions', errors)
  let traceableCount = 0
  let hardFilterViolationCount = 0
  const assertionIds = new Set<string>()
  for (const [index, rawAssertion] of assertionsRaw.entries()) {
    const assertionPath = `preference_assertions[${index}]`
    const assertion = object(rawAssertion, assertionPath, errors)
    if (assertion === null) continue
    exactKeys(assertion, assertionPath, ['assertion_id', 'evidence_ref', 'consumer', 'hard_filter'], errors)
    const assertionId = hmacRef(assertion.assertion_id, `${assertionPath}.assertion_id`, errors)
    const evidenceRef = hmacRef(assertion.evidence_ref, `${assertionPath}.evidence_ref`, errors)
    const consumer = literal<AssertionConsumer>(assertion.consumer, `${assertionPath}.consumer`, ['ranking', 'explanation', 'hard_filter'], errors)
    const hardFilter = boolean(assertion.hard_filter, `${assertionPath}.hard_filter`, errors)
    assertUnique(assertionId, assertionIds, `${assertionPath}.assertion_id`, errors)
    if (evidenceRef !== null) traceableCount += 1
    if (hardFilter === true || consumer === 'hard_filter') hardFilterViolationCount += 1
  }
  const traceableRatio = assertionsRaw.length > 0 ? round(traceableCount / assertionsRaw.length) : 0
  const assertionContractMet = assertionsRaw.length > 0 && traceableRatio === 1 && hardFilterViolationCount === 0

  let p4State: P4State | 'unknown' = 'unknown'
  let p4TriggerObserved = false
  const rawP4 = object(input.p4, 'p4', errors)
  if (rawP4 !== null) {
    exactKeys(rawP4, 'p4', ['state', 'triggers'], errors)
    p4State = literal<P4State>(rawP4.state, 'p4.state', ['closed', 'open'], errors) ?? 'unknown'
    const triggers = object(rawP4.triggers, 'p4.triggers', errors)
    if (triggers !== null) {
      exactKeys(triggers, 'p4.triggers', ['real_usage', 'multi_user'], errors)
      const realUsage = boolean(triggers.real_usage, 'p4.triggers.real_usage', errors)
      const multiUser = boolean(triggers.multi_user, 'p4.triggers.multi_user', errors)
      p4TriggerObserved = realUsage === true || multiUser === true
    }
  }
  const p4ContractMet = p4TriggerObserved || p4State === 'closed'

  if (errors.length > 0) return invalidReport(errors, schema ?? '', evidenceKind ?? '', sourceReview)

  const medianReduction = nearestRankRaw(reductions, 0.5)
  const sampleSizeMet = firstDurations.length >= M4_ACCEPTANCE.minimumPairCountForExit
  const targetMet = medianReduction >= M4_ACCEPTANCE.targetMedianReductionRatio
  const sourceEvidenceEligible = evidenceKind === 'observed_private' && sourceReview.contract_met
  const baselineAvailable = refluxBaseline !== null
  const exitReady = sourceEvidenceEligible
    && sampleSizeMet
    && targetMet
    && baselineAvailable
    && assertionContractMet
    && p4ContractMet

  return {
    schema: 'memory_value_report.v1',
    contract_valid: true,
    errors: [],
    source: {
      fixture_schema: schema!,
      evidence_kind: evidenceKind!,
      quantile_method: 'nearest_rank',
      active_duration_rule: 'wall_clock_minus_non_overlapping_predeclared_external_waits',
      id_format: 'hmac-sha256:<64lowerhex>',
      source_review: sourceReview,
    },
    cohort: {
      eligible_pair_count: firstDurations.length,
      first_active_seconds: { p50: nearestRank(firstDurations, 0.5), p75: nearestRank(firstDurations, 0.75) },
      returning_active_seconds: { p50: nearestRank(returningDurations, 0.5), p75: nearestRank(returningDurations, 0.75) },
      paired_reduction_ratio: { p50: round(medianReduction), p75: nearestRank(reductions, 0.75) },
      target_median_reduction_ratio: M4_ACCEPTANCE.targetMedianReductionRatio,
      target_met: targetMet,
      minimum_pair_count_for_exit: M4_ACCEPTANCE.minimumPairCountForExit,
      sample_size_met: sampleSizeMet,
    },
    experience_reflux: {
      recalled_experience_count: recalled.size,
      verified_experience_count: verifiedRecalledCount,
      baseline: refluxBaseline,
      baseline_available: baselineAvailable,
      real_evidence: sourceEvidenceEligible,
    },
    preference_assertions: {
      total_count: assertionsRaw.length,
      traceable_count: traceableCount,
      traceable_ratio: traceableRatio,
      hard_filter_violation_count: hardFilterViolationCount,
      contract_met: assertionContractMet,
    },
    p4: {
      state: p4State,
      trigger_observed: p4TriggerObserved,
      contract_met: p4ContractMet,
    },
    exit_evidence_eligible: sourceEvidenceEligible,
    exit_ready: exitReady,
  }
}

function main(): void {
  const inputPath = process.argv[2]
  if (!inputPath) {
    console.error('usage: npx tsx scripts/memory-value-report.ts <fixture-or-private-manifest.json>')
    process.exitCode = 2
    return
  }

  let input: unknown
  try {
    input = JSON.parse(readFileSync(resolve(inputPath), 'utf8'))
  } catch {
    console.error('MEMORY_VALUE_INPUT_INVALID: input file could not be read or parsed')
    process.exitCode = 2
    return
  }

  const report = scoreMemoryValue(input)
  console.log(JSON.stringify(report, null, 2))
  if (!report.contract_valid) process.exitCode = 2
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) main()
