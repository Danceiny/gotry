/**
 * M4 memory value evidence scorer (GitHub Issue #20).
 *
 * The scorer is deliberately read-only. It accepts a public fixture or a
 * private observed cohort manifest and emits one deterministic JSON report.
 * Synthetic fixtures can prove the contract and calculations, but can never
 * satisfy M4 Exit.
 *
 * Usage:
 *   npx tsx scripts/memory-value-report.ts data/memory-value-fixture.json
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

type JsonObject = Record<string, unknown>

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

export interface MemoryValueReport {
  schema: 'memory_value_report.v1'
  contract_valid: boolean
  errors: string[]
  source: {
    fixture_schema: string
    evidence_kind: string
    quantile_method: 'nearest_rank'
    active_duration_rule: 'wall_clock_minus_non_overlapping_predeclared_external_waits'
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
    state: string
    trigger_observed: boolean
    contract_met: boolean
  }
  exit_evidence_eligible: boolean
  exit_ready: boolean
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000
}

function nearestRank(values: number[], percentile: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1)
  return round(sorted[index])
}

function parseTimestamp(value: unknown, path: string, errors: string[]): number | null {
  if (!nonEmptyString(value)) {
    errors.push(`${path} must be a non-empty ISO timestamp`)
    return null
  }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) {
    errors.push(`${path} is not a valid ISO timestamp`)
    return null
  }
  return parsed
}

function scoreFlow(
  value: unknown,
  path: string,
  expectedEligibleIndex: number,
  allowedWaitCodes: Set<string>,
  errors: string[],
): FlowScore | null {
  if (!isObject(value)) {
    errors.push(`${path} must be an object`)
    return null
  }

  const flowId = value.flow_id
  if (!nonEmptyString(flowId)) errors.push(`${path}.flow_id must be non-empty`)
  if (value.eligible !== true) errors.push(`${path}.eligible must be true`)
  if (value.status !== 'completed') errors.push(`${path}.status must be completed`)
  if (value.eligible_planning_index !== expectedEligibleIndex) {
    errors.push(`${path}.eligible_planning_index must be ${expectedEligibleIndex}`)
  }

  const startedAtMs = parseTimestamp(value.started_at, `${path}.started_at`, errors)
  const completedAtMs = parseTimestamp(value.completed_at, `${path}.completed_at`, errors)
  if (startedAtMs === null || completedAtMs === null) return null
  if (completedAtMs <= startedAtMs) {
    errors.push(`${path}.completed_at must be after started_at`)
    return null
  }

  const rawWaits = value.external_waits
  if (!Array.isArray(rawWaits)) {
    errors.push(`${path}.external_waits must be an array`)
    return null
  }

  const waits: WaitInterval[] = []
  for (const [index, rawWait] of rawWaits.entries()) {
    const waitPath = `${path}.external_waits[${index}]`
    if (!isObject(rawWait)) {
      errors.push(`${waitPath} must be an object`)
      continue
    }
    const code = rawWait.code
    if (!nonEmptyString(code) || !allowedWaitCodes.has(code)) {
      errors.push(`${waitPath}.code must be predeclared by measurement_policy`)
      continue
    }
    const waitStartedAtMs = parseTimestamp(rawWait.started_at, `${waitPath}.started_at`, errors)
    const waitCompletedAtMs = parseTimestamp(rawWait.completed_at, `${waitPath}.completed_at`, errors)
    if (waitStartedAtMs === null || waitCompletedAtMs === null) continue
    if (waitCompletedAtMs <= waitStartedAtMs) {
      errors.push(`${waitPath}.completed_at must be after started_at`)
      continue
    }
    if (waitStartedAtMs < startedAtMs || waitCompletedAtMs > completedAtMs) {
      errors.push(`${waitPath} must stay inside the planning flow`)
      continue
    }
    waits.push({ code, startedAtMs: waitStartedAtMs, completedAtMs: waitCompletedAtMs })
  }

  waits.sort((a, b) => a.startedAtMs - b.startedAtMs)
  for (let index = 1; index < waits.length; index += 1) {
    if (waits[index].startedAtMs < waits[index - 1].completedAtMs) {
      errors.push(`${path}.external_waits must not overlap`)
    }
  }

  const externalWaitMs = waits.reduce((total, wait) => total + wait.completedAtMs - wait.startedAtMs, 0)
  const activeSeconds = (completedAtMs - startedAtMs - externalWaitMs) / 1_000
  if (activeSeconds <= 0) errors.push(`${path} must have positive active planning duration`)

  return nonEmptyString(flowId)
    ? { activeSeconds: round(activeSeconds), completedAtMs, flowId, startedAtMs }
    : null
}

function invalidReport(errors: string[], schema = '', evidenceKind = ''): MemoryValueReport {
  return {
    schema: 'memory_value_report.v1',
    contract_valid: false,
    errors,
    source: {
      fixture_schema: schema,
      evidence_kind: evidenceKind,
      quantile_method: 'nearest_rank',
      active_duration_rule: 'wall_clock_minus_non_overlapping_predeclared_external_waits',
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

  const schema = nonEmptyString(input.schema) ? input.schema : ''
  const evidenceKind = nonEmptyString(input.evidence_kind) ? input.evidence_kind : ''
  if (schema !== 'memory_value_fixture.v1') errors.push('schema must be memory_value_fixture.v1')
  if (!['synthetic_fixture', 'observed_private'].includes(evidenceKind)) {
    errors.push('evidence_kind must be synthetic_fixture or observed_private')
  }

  const policy = input.measurement_policy
  if (!isObject(policy)) return invalidReport([...errors, 'measurement_policy must be an object'], schema, evidenceKind)
  if (policy.quantile_method !== 'nearest_rank') errors.push('measurement_policy.quantile_method must be nearest_rank')

  const rawWaitCodes = policy.predeclared_external_wait_codes
  const allowedWaitCodes = new Set<string>()
  if (!Array.isArray(rawWaitCodes) || rawWaitCodes.length === 0) {
    errors.push('measurement_policy.predeclared_external_wait_codes must be a non-empty array')
  } else {
    for (const code of rawWaitCodes) {
      if (nonEmptyString(code)) allowedWaitCodes.add(code)
      else errors.push('measurement_policy.predeclared_external_wait_codes must contain non-empty strings')
    }
  }

  const minimumPairCount = policy.minimum_pair_count_for_exit
  const targetReduction = policy.target_median_reduction_ratio
  if (!Number.isInteger(minimumPairCount) || (minimumPairCount as number) <= 0) {
    errors.push('measurement_policy.minimum_pair_count_for_exit must be a positive integer')
  }
  if (!finiteNumber(targetReduction) || targetReduction < 0 || targetReduction > 1) {
    errors.push('measurement_policy.target_median_reduction_ratio must be between 0 and 1')
  }

  const rawPairs = input.pairs
  if (!Array.isArray(rawPairs) || rawPairs.length === 0) {
    errors.push('pairs must be a non-empty array')
  }

  const firstDurations: number[] = []
  const returningDurations: number[] = []
  const reductions: number[] = []
  const pairIds = new Set<string>()
  const subjectRefs = new Set<string>()
  const flowIds = new Set<string>()
  for (const [index, rawPair] of (Array.isArray(rawPairs) ? rawPairs : []).entries()) {
    const pairPath = `pairs[${index}]`
    if (!isObject(rawPair)) {
      errors.push(`${pairPath} must be an object`)
      continue
    }
    if (!nonEmptyString(rawPair.pair_id)) errors.push(`${pairPath}.pair_id must be non-empty`)
    else if (pairIds.has(rawPair.pair_id)) errors.push(`${pairPath}.pair_id must be unique`)
    else pairIds.add(rawPair.pair_id)
    if (!nonEmptyString(rawPair.subject_ref)) {
      errors.push(`${pairPath}.subject_ref must be a non-empty pseudonymous reference`)
    } else if (subjectRefs.has(rawPair.subject_ref)) {
      errors.push(`${pairPath}.subject_ref must be unique across the paired cohort`)
    } else {
      subjectRefs.add(rawPair.subject_ref)
    }

    const first = scoreFlow(rawPair.first, `${pairPath}.first`, 1, allowedWaitCodes, errors)
    const returning = scoreFlow(rawPair.returning, `${pairPath}.returning`, 2, allowedWaitCodes, errors)
    for (const flow of [first, returning]) {
      if (!flow) continue
      if (flowIds.has(flow.flowId)) errors.push(`${pairPath} flow_id values must be globally unique`)
      flowIds.add(flow.flowId)
    }
    if (!first || !returning || first.activeSeconds <= 0 || returning.activeSeconds <= 0) continue
    if (returning.startedAtMs <= first.completedAtMs) {
      errors.push(`${pairPath}.returning must start after the first completed flow`)
    }
    firstDurations.push(first.activeSeconds)
    returningDurations.push(returning.activeSeconds)
    reductions.push(round((first.activeSeconds - returning.activeSeconds) / first.activeSeconds))
  }

  const rawRefluxEvents = input.experience_reflux_events
  if (!Array.isArray(rawRefluxEvents)) errors.push('experience_reflux_events must be an array')
  const recalled = new Set<string>()
  const verified = new Set<string>()
  for (const [index, rawEvent] of (Array.isArray(rawRefluxEvents) ? rawRefluxEvents : []).entries()) {
    const eventPath = `experience_reflux_events[${index}]`
    if (!isObject(rawEvent)) {
      errors.push(`${eventPath} must be an object`)
      continue
    }
    if (!nonEmptyString(rawEvent.experience_id)) {
      errors.push(`${eventPath}.experience_id must be non-empty`)
      continue
    }
    if (!nonEmptyString(rawEvent.evidence_ref)) errors.push(`${eventPath}.evidence_ref must be non-empty`)
    if (rawEvent.kind === 'recalled') recalled.add(rawEvent.experience_id)
    else if (rawEvent.kind === 'verified_outcome') verified.add(rawEvent.experience_id)
    else errors.push(`${eventPath}.kind must be recalled or verified_outcome`)
  }
  for (const experienceId of verified) {
    if (!recalled.has(experienceId)) errors.push(`verified experience ${experienceId} must have a recalled event`)
  }
  const verifiedRecalledCount = [...verified].filter(id => recalled.has(id)).length
  const refluxBaseline = recalled.size > 0 ? round(verifiedRecalledCount / recalled.size) : null

  const rawAssertions = input.preference_assertions
  if (!Array.isArray(rawAssertions)) errors.push('preference_assertions must be an array')
  let traceableCount = 0
  let hardFilterViolationCount = 0
  const assertions = Array.isArray(rawAssertions) ? rawAssertions : []
  for (const [index, rawAssertion] of assertions.entries()) {
    const assertionPath = `preference_assertions[${index}]`
    if (!isObject(rawAssertion)) {
      errors.push(`${assertionPath} must be an object`)
      continue
    }
    if (!nonEmptyString(rawAssertion.assertion_id)) errors.push(`${assertionPath}.assertion_id must be non-empty`)
    if (nonEmptyString(rawAssertion.evidence_ref)) traceableCount += 1
    if (rawAssertion.hard_filter === true || rawAssertion.consumer === 'hard_filter') hardFilterViolationCount += 1
  }
  const traceableRatio = assertions.length > 0 ? round(traceableCount / assertions.length) : 0
  const assertionContractMet = assertions.length > 0 && traceableRatio === 1 && hardFilterViolationCount === 0

  const rawP4 = input.p4
  let p4State = 'unknown'
  let p4TriggerObserved = false
  if (!isObject(rawP4) || !isObject(rawP4.triggers)) {
    errors.push('p4.state and p4.triggers must be declared')
  } else {
    if (nonEmptyString(rawP4.state)) p4State = rawP4.state
    else errors.push('p4.state must be non-empty')
    p4TriggerObserved = rawP4.triggers.real_usage === true || rawP4.triggers.multi_user === true
  }
  const p4ContractMet = p4TriggerObserved || p4State === 'closed'

  if (errors.length > 0) return invalidReport(errors, schema, evidenceKind)

  const medianReduction = nearestRank(reductions, 0.5)
  const numericMinimumPairCount = minimumPairCount as number
  const numericTargetReduction = targetReduction as number
  const sampleSizeMet = firstDurations.length >= numericMinimumPairCount
  const targetMet = medianReduction >= numericTargetReduction
  const exitEvidenceEligible = evidenceKind === 'observed_private'
  const baselineAvailable = refluxBaseline !== null
  const exitReady = exitEvidenceEligible
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
      fixture_schema: schema,
      evidence_kind: evidenceKind,
      quantile_method: 'nearest_rank',
      active_duration_rule: 'wall_clock_minus_non_overlapping_predeclared_external_waits',
    },
    cohort: {
      eligible_pair_count: firstDurations.length,
      first_active_seconds: { p50: nearestRank(firstDurations, 0.5), p75: nearestRank(firstDurations, 0.75) },
      returning_active_seconds: { p50: nearestRank(returningDurations, 0.5), p75: nearestRank(returningDurations, 0.75) },
      paired_reduction_ratio: { p50: medianReduction, p75: nearestRank(reductions, 0.75) },
      target_median_reduction_ratio: numericTargetReduction,
      target_met: targetMet,
      minimum_pair_count_for_exit: numericMinimumPairCount,
      sample_size_met: sampleSizeMet,
    },
    experience_reflux: {
      recalled_experience_count: recalled.size,
      verified_experience_count: verifiedRecalledCount,
      baseline: refluxBaseline,
      baseline_available: baselineAvailable,
      real_evidence: exitEvidenceEligible,
    },
    preference_assertions: {
      total_count: assertions.length,
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
    exit_evidence_eligible: exitEvidenceEligible,
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`cannot read memory value input: ${message}`)
    process.exitCode = 2
    return
  }

  const report = scoreMemoryValue(input)
  console.log(JSON.stringify(report, null, 2))
  if (!report.contract_valid) process.exitCode = 2
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) main()
