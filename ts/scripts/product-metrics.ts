/**
 * M3 真实种子 cohort 指标评分器(issue #22)。
 *
 * 私有证据默认位于 gotry-state/evidence/m3/:
 *   manifest.json  冻结样本窗口、纳排、分母、归因与阈值
 *   cohort.jsonl   脱敏 plan 记录与 nightly real-LLM 运行记录
 *   summary.json   可复跑的聚合结果(仅显式 --write-summary 时写入)
 *
 * 运行:
 *   npx tsx scripts/product-metrics.ts --evidence-root gotry-state/evidence/m3 --format json
 *   npx tsx scripts/product-metrics.ts --evidence-root gotry-state/evidence/m3 --write-summary
 *   npx tsx scripts/product-metrics.ts --fixture data/product-metrics-fixture.json --format json
 *
 * 纪律:
 *   - fixture 只验证 schema 与公式,永远不能得到 business_pass=true。
 *   - participant/plan/run 只接受 HMAC-SHA256 假名键;未知字段 fail-closed,
 *     防止姓名、邮箱、电话、原始会话等进入证据面。
 *   - 分母为 0 时指标 unavailable(pass=false),不得把空样本算作 0% 幻觉。
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

type EvidenceKind = 'real_seed_cohort' | 'synthetic_fixture'
type Attribution = 'gotry_primary' | 'gotry_assisted'

export interface M3EvidenceManifest {
  schema_version: 'gotry_m3_evidence_manifest_v1'
  evidence_kind: EvidenceKind
  cohort_id: string
  locked_at: string
  window: {
    start_at: string
    end_at: string
    timezone: string
  }
  eligibility: {
    sample_unit: 'unique_participant_with_eligible_delivered_plan'
    requires_invitation: true
    requires_consent: true
    allowed_attribution: Attribution[]
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
  schema_version: 'gotry_m3_cohort_record_v1'
  participant_key: string
  plan_key: string
  invited: boolean
  consent: boolean
  test_or_staff: boolean
  attribution: Attribution
  delivered_at: string
  finalized_at: string | null
  nps_score: number | null
  nps_recorded_at: string | null
  poi_audit: {
    locked_at: string
    locked_claims: number
    invalid_claims: number
  }
}

export interface M3NightlyRun {
  schema_version: 'gotry_m3_nightly_run_v1'
  run_key: string
  executed_at: string
  real_llm: boolean
  prompt_set_sha256: string
  output_sha256: string
  cost_usd: number
}

export interface M3ProductMetricsSummary {
  schema_version: 'gotry_m3_product_metrics_summary_v1'
  evidence_kind: EvidenceKind
  cohort_id: string
  evidence_digest_sha256: string
  sample: {
    participants: number
    minimum: number
    maximum: number
    pass: boolean
  }
  finalization: {
    numerator: number
    denominator: number
    rate: number | null
    pass: boolean
  }
  nps: {
    promoters: number
    passives: number
    detractors: number
    denominator: number
    score: number | null
    pass: boolean
  }
  poi_hallucination: {
    invalid_claims: number
    locked_claims: number
    rate: number | null
    pass: boolean
  }
  nightly: {
    replayable_real_llm_runs: number
    cost_usd: number
    pass: boolean
  }
  exclusions: Record<string, number>
  business_pass: boolean
  business_pass_reason: string
}

const FORMULAS = {
  finalization: 'finalized_eligible_delivered_plans / eligible_delivered_plans',
  nps: '100 * (promoters_9_10 - detractors_0_6) / valid_responses',
  poi: 'audited_invalid_poi_claims / locked_audited_poi_claims',
} as const

const EXCLUSION_CODES = [
  'outside_locked_window',
  'not_invited',
  'consent_missing_or_withdrawn',
  'test_or_staff',
  'attribution_not_allowed',
] as const

const M3_ACCEPTANCE = {
  sampleMinimum: 50,
  sampleMaximum: 200,
  finalizationMinimum: 0.4,
  npsMinimum: 40,
  poiExclusiveMaximum: 0.01,
} as const

const HMAC_KEY = /^hmac-sha256:[0-9a-f]{64}$/
const SHA256 = /^[0-9a-f]{64}$/

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, label: string, keys: readonly string[]): void {
  const expected = new Set(keys)
  const unknown = Object.keys(value).filter(key => !expected.has(key))
  const missing = keys.filter(key => !(key in value))
  if (unknown.length > 0) throw new Error(`${label} contains undeclared fields: ${unknown.join(', ')}`)
  if (missing.length > 0) throw new Error(`${label} missing fields: ${missing.join(', ')}`)
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`)
  return value
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`)
  return value
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`)
  return value
}

function integer(value: unknown, label: string): number {
  const result = finiteNumber(value, label)
  if (!Number.isInteger(result)) throw new Error(`${label} must be an integer`)
  return result
}

function timestamp(value: unknown, label: string): string {
  const result = string(value, label)
  if (!Number.isFinite(Date.parse(result))) throw new Error(`${label} must be an ISO timestamp`)
  return result
}

function nullableTimestamp(value: unknown, label: string): string | null {
  if (value === null) return null
  return timestamp(value, label)
}

function nullableNps(value: unknown, label: string): number | null {
  if (value === null) return null
  const result = integer(value, label)
  if (result < 0 || result > 10) throw new Error(`${label} must be an integer from 0 to 10`)
  return result
}

function hmacKey(value: unknown, label: string): string {
  const result = string(value, label)
  if (!HMAC_KEY.test(result)) throw new Error(`${label} must be an hmac-sha256 pseudonymous key`)
  return result
}

function sha256(value: unknown, label: string): string {
  const result = string(value, label)
  if (!SHA256.test(result)) throw new Error(`${label} must be a lowercase SHA-256 digest`)
  return result
}

function literal<T extends string>(value: unknown, label: string, allowed: readonly T[]): T {
  const result = string(value, label)
  if (!allowed.includes(result as T)) throw new Error(`${label} must be one of ${allowed.join(', ')}`)
  return result as T
}

function literalArray<T extends string>(value: unknown, label: string, allowed: readonly T[]): T[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array`)
  const result = value.map((item, index) => literal(item, `${label}[${index}]`, allowed))
  if (new Set(result).size !== result.length) throw new Error(`${label} must not contain duplicates`)
  return result
}

function exactStringArray(value: unknown, label: string, expected: readonly string[]): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`${label} must be a string array`)
  }
  const actual = [...value].sort()
  const wanted = [...expected].sort()
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} must freeze exactly: ${wanted.join(', ')}`)
  }
  return value as string[]
}

function requiredTrue(value: unknown, label: string): true {
  if (value !== true) throw new Error(`${label} must be true in schema v1`)
  return true
}

export function parseManifest(raw: unknown): M3EvidenceManifest {
  const root = object(raw, 'manifest')
  exactKeys(root, 'manifest', ['schema_version', 'evidence_kind', 'cohort_id', 'locked_at', 'window', 'eligibility', 'metrics', 'nightly'])

  const window = object(root.window, 'manifest.window')
  exactKeys(window, 'manifest.window', ['start_at', 'end_at', 'timezone'])
  const startAt = timestamp(window.start_at, 'manifest.window.start_at')
  const endAt = timestamp(window.end_at, 'manifest.window.end_at')
  if (Date.parse(startAt) > Date.parse(endAt)) throw new Error('manifest.window start_at must not be after end_at')

  const eligibility = object(root.eligibility, 'manifest.eligibility')
  exactKeys(eligibility, 'manifest.eligibility', ['sample_unit', 'requires_invitation', 'requires_consent', 'allowed_attribution', 'exclusion_codes'])

  const metrics = object(root.metrics, 'manifest.metrics')
  exactKeys(metrics, 'manifest.metrics', ['sample_size', 'finalization_rate', 'nps', 'poi_hallucination_rate'])
  const sampleSize = object(metrics.sample_size, 'manifest.metrics.sample_size')
  exactKeys(sampleSize, 'manifest.metrics.sample_size', ['minimum', 'maximum'])
  const finalization = object(metrics.finalization_rate, 'manifest.metrics.finalization_rate')
  exactKeys(finalization, 'manifest.metrics.finalization_rate', ['formula', 'minimum'])
  const nps = object(metrics.nps, 'manifest.metrics.nps')
  exactKeys(nps, 'manifest.metrics.nps', ['formula', 'minimum'])
  const poi = object(metrics.poi_hallucination_rate, 'manifest.metrics.poi_hallucination_rate')
  exactKeys(poi, 'manifest.metrics.poi_hallucination_rate', ['formula', 'exclusive_maximum'])

  const nightly = object(root.nightly, 'manifest.nightly')
  exactKeys(nightly, 'manifest.nightly', ['requires_real_llm', 'requires_prompt_set_sha256', 'requires_output_sha256', 'requires_cost_usd'])

  const minimum = integer(sampleSize.minimum, 'manifest.metrics.sample_size.minimum')
  const maximum = integer(sampleSize.maximum, 'manifest.metrics.sample_size.maximum')
  if (minimum < 1 || maximum < minimum) throw new Error('manifest sample size bounds are invalid')

  const finalizationMinimum = finiteNumber(finalization.minimum, 'manifest.metrics.finalization_rate.minimum')
  const npsMinimum = finiteNumber(nps.minimum, 'manifest.metrics.nps.minimum')
  const poiMaximum = finiteNumber(poi.exclusive_maximum, 'manifest.metrics.poi_hallucination_rate.exclusive_maximum')
  if (finalizationMinimum < 0 || finalizationMinimum > 1) throw new Error('finalization minimum must be within 0..1')
  if (npsMinimum < -100 || npsMinimum > 100) throw new Error('NPS minimum must be within -100..100')
  if (poiMaximum <= 0 || poiMaximum > 1) throw new Error('POI exclusive maximum must be within 0..1')
  if (minimum !== M3_ACCEPTANCE.sampleMinimum || maximum !== M3_ACCEPTANCE.sampleMaximum) {
    throw new Error(`M3 sample size thresholds are frozen at ${M3_ACCEPTANCE.sampleMinimum}..${M3_ACCEPTANCE.sampleMaximum}`)
  }
  if (finalizationMinimum !== M3_ACCEPTANCE.finalizationMinimum) {
    throw new Error(`M3 finalization threshold is frozen at ${M3_ACCEPTANCE.finalizationMinimum}`)
  }
  if (npsMinimum !== M3_ACCEPTANCE.npsMinimum) {
    throw new Error(`M3 NPS threshold is frozen at ${M3_ACCEPTANCE.npsMinimum}`)
  }
  if (poiMaximum !== M3_ACCEPTANCE.poiExclusiveMaximum) {
    throw new Error(`M3 POI hallucination threshold is frozen at ${M3_ACCEPTANCE.poiExclusiveMaximum}`)
  }

  return {
    schema_version: literal(root.schema_version, 'manifest.schema_version', ['gotry_m3_evidence_manifest_v1']),
    evidence_kind: literal(root.evidence_kind, 'manifest.evidence_kind', ['real_seed_cohort', 'synthetic_fixture']),
    cohort_id: string(root.cohort_id, 'manifest.cohort_id'),
    locked_at: timestamp(root.locked_at, 'manifest.locked_at'),
    window: { start_at: startAt, end_at: endAt, timezone: string(window.timezone, 'manifest.window.timezone') },
    eligibility: {
      sample_unit: literal(eligibility.sample_unit, 'manifest.eligibility.sample_unit', ['unique_participant_with_eligible_delivered_plan']),
      requires_invitation: requiredTrue(eligibility.requires_invitation, 'manifest.eligibility.requires_invitation'),
      requires_consent: requiredTrue(eligibility.requires_consent, 'manifest.eligibility.requires_consent'),
      allowed_attribution: literalArray(eligibility.allowed_attribution, 'manifest.eligibility.allowed_attribution', ['gotry_primary', 'gotry_assisted']),
      exclusion_codes: exactStringArray(eligibility.exclusion_codes, 'manifest.eligibility.exclusion_codes', EXCLUSION_CODES),
    },
    metrics: {
      sample_size: { minimum, maximum },
      finalization_rate: {
        formula: literal(finalization.formula, 'manifest.metrics.finalization_rate.formula', [FORMULAS.finalization]),
        minimum: finalizationMinimum,
      },
      nps: {
        formula: literal(nps.formula, 'manifest.metrics.nps.formula', [FORMULAS.nps]),
        minimum: npsMinimum,
      },
      poi_hallucination_rate: {
        formula: literal(poi.formula, 'manifest.metrics.poi_hallucination_rate.formula', [FORMULAS.poi]),
        exclusive_maximum: poiMaximum,
      },
    },
    nightly: {
      requires_real_llm: requiredTrue(nightly.requires_real_llm, 'manifest.nightly.requires_real_llm'),
      requires_prompt_set_sha256: requiredTrue(nightly.requires_prompt_set_sha256, 'manifest.nightly.requires_prompt_set_sha256'),
      requires_output_sha256: requiredTrue(nightly.requires_output_sha256, 'manifest.nightly.requires_output_sha256'),
      requires_cost_usd: requiredTrue(nightly.requires_cost_usd, 'manifest.nightly.requires_cost_usd'),
    },
  }
}

export function parseCohortRecord(raw: unknown, index: number): M3CohortRecord {
  const label = `cohort[${index}]`
  const root = object(raw, label)
  exactKeys(root, label, ['schema_version', 'participant_key', 'plan_key', 'invited', 'consent', 'test_or_staff', 'attribution', 'delivered_at', 'finalized_at', 'nps_score', 'nps_recorded_at', 'poi_audit'])
  const poi = object(root.poi_audit, `${label}.poi_audit`)
  exactKeys(poi, `${label}.poi_audit`, ['locked_at', 'locked_claims', 'invalid_claims'])
  const lockedClaims = integer(poi.locked_claims, `${label}.poi_audit.locked_claims`)
  const invalidClaims = integer(poi.invalid_claims, `${label}.poi_audit.invalid_claims`)
  if (lockedClaims < 0 || invalidClaims < 0 || invalidClaims > lockedClaims) {
    throw new Error(`${label}.poi_audit requires 0 <= invalid_claims <= locked_claims`)
  }
  const deliveredAt = timestamp(root.delivered_at, `${label}.delivered_at`)
  const finalizedAt = nullableTimestamp(root.finalized_at, `${label}.finalized_at`)
  const npsScore = nullableNps(root.nps_score, `${label}.nps_score`)
  const npsRecordedAt = nullableTimestamp(root.nps_recorded_at, `${label}.nps_recorded_at`)
  const poiLockedAt = timestamp(poi.locked_at, `${label}.poi_audit.locked_at`)
  if (finalizedAt !== null && Date.parse(finalizedAt) < Date.parse(deliveredAt)) {
    throw new Error(`${label}.finalized_at must not be before delivered_at`)
  }
  if ((npsScore === null) !== (npsRecordedAt === null)) {
    throw new Error(`${label}.nps_score and nps_recorded_at must both be null or both be set`)
  }
  if (npsRecordedAt !== null && Date.parse(npsRecordedAt) < Date.parse(deliveredAt)) {
    throw new Error(`${label}.nps_recorded_at must not be before delivered_at`)
  }
  if (Date.parse(poiLockedAt) < Date.parse(deliveredAt)) {
    throw new Error(`${label}.poi_audit.locked_at must not be before delivered_at`)
  }
  return {
    schema_version: literal(root.schema_version, `${label}.schema_version`, ['gotry_m3_cohort_record_v1']),
    participant_key: hmacKey(root.participant_key, `${label}.participant_key`),
    plan_key: hmacKey(root.plan_key, `${label}.plan_key`),
    invited: boolean(root.invited, `${label}.invited`),
    consent: boolean(root.consent, `${label}.consent`),
    test_or_staff: boolean(root.test_or_staff, `${label}.test_or_staff`),
    attribution: literal(root.attribution, `${label}.attribution`, ['gotry_primary', 'gotry_assisted']),
    delivered_at: deliveredAt,
    finalized_at: finalizedAt,
    nps_score: npsScore,
    nps_recorded_at: npsRecordedAt,
    poi_audit: { locked_at: poiLockedAt, locked_claims: lockedClaims, invalid_claims: invalidClaims },
  }
}

export function parseNightlyRun(raw: unknown, index: number): M3NightlyRun {
  const label = `nightly_runs[${index}]`
  const root = object(raw, label)
  exactKeys(root, label, ['schema_version', 'run_key', 'executed_at', 'real_llm', 'prompt_set_sha256', 'output_sha256', 'cost_usd'])
  const costUsd = finiteNumber(root.cost_usd, `${label}.cost_usd`)
  if (costUsd < 0) throw new Error(`${label}.cost_usd must be non-negative`)
  return {
    schema_version: literal(root.schema_version, `${label}.schema_version`, ['gotry_m3_nightly_run_v1']),
    run_key: hmacKey(root.run_key, `${label}.run_key`),
    executed_at: timestamp(root.executed_at, `${label}.executed_at`),
    real_llm: boolean(root.real_llm, `${label}.real_llm`),
    prompt_set_sha256: sha256(root.prompt_set_sha256, `${label}.prompt_set_sha256`),
    output_sha256: sha256(root.output_sha256, `${label}.output_sha256`),
    cost_usd: costUsd,
  }
}

function round(value: number): number {
  return Number(value.toFixed(6))
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function exclusionsFor(manifest: M3EvidenceManifest, record: M3CohortRecord): string[] {
  const result: string[] = []
  const delivered = Date.parse(record.delivered_at)
  if (delivered < Date.parse(manifest.window.start_at) || delivered > Date.parse(manifest.window.end_at)) result.push('outside_locked_window')
  if (!record.invited) result.push('not_invited')
  if (!record.consent) result.push('consent_missing_or_withdrawn')
  if (record.test_or_staff) result.push('test_or_staff')
  if (!manifest.eligibility.allowed_attribution.includes(record.attribution)) result.push('attribution_not_allowed')
  return result
}

export function scoreProductMetrics(
  manifest: M3EvidenceManifest,
  cohort: M3CohortRecord[],
  nightlyRuns: M3NightlyRun[],
): M3ProductMetricsSummary {
  const planKeys = new Set<string>()
  const runKeys = new Set<string>()
  for (const record of cohort) {
    if (planKeys.has(record.plan_key)) throw new Error(`duplicate plan_key: ${record.plan_key}`)
    planKeys.add(record.plan_key)
  }
  for (const run of nightlyRuns) {
    if (runKeys.has(run.run_key)) throw new Error(`duplicate run_key: ${run.run_key}`)
    runKeys.add(run.run_key)
  }

  const exclusionCounts: Record<string, number> = Object.fromEntries(EXCLUSION_CODES.map(code => [code, 0]))
  const eligible = cohort.filter(record => {
    const exclusions = exclusionsFor(manifest, record)
    for (const code of exclusions) exclusionCounts[code] += 1
    return exclusions.length === 0
  })
  const participants = new Set(eligible.map(record => record.participant_key))

  const windowEnd = Date.parse(manifest.window.end_at)
  const finalized = eligible.filter(record => record.finalized_at !== null && Date.parse(record.finalized_at) <= windowEnd).length
  const finalizationRate = eligible.length === 0 ? null : round(finalized / eligible.length)

  const npsByParticipant = new Map<string, number>()
  for (const record of eligible) {
    if (record.nps_score === null || record.nps_recorded_at === null || Date.parse(record.nps_recorded_at) > windowEnd) continue
    if (npsByParticipant.has(record.participant_key)) {
      throw new Error(`participant has more than one NPS response in the locked window: ${record.participant_key}`)
    }
    npsByParticipant.set(record.participant_key, record.nps_score)
  }
  const scores = [...npsByParticipant.values()]
  const promoters = scores.filter(score => score >= 9).length
  const detractors = scores.filter(score => score <= 6).length
  const passives = scores.length - promoters - detractors
  const npsScore = scores.length === 0 ? null : round(100 * (promoters - detractors) / scores.length)

  const lockedAudits = eligible.filter(record => Date.parse(record.poi_audit.locked_at) <= windowEnd)
  const lockedClaims = lockedAudits.reduce((sum, record) => sum + record.poi_audit.locked_claims, 0)
  const invalidClaims = lockedAudits.reduce((sum, record) => sum + record.poi_audit.invalid_claims, 0)
  const poiRate = lockedClaims === 0 ? null : round(invalidClaims / lockedClaims)

  const windowStart = Date.parse(manifest.window.start_at)
  const replayableRuns = nightlyRuns.filter(run => {
    const executedAt = Date.parse(run.executed_at)
    return run.real_llm && executedAt >= windowStart && executedAt <= windowEnd
  })
  const nightlyCost = round(replayableRuns.reduce((sum, run) => sum + run.cost_usd, 0))

  const samplePass = participants.size >= manifest.metrics.sample_size.minimum && participants.size <= manifest.metrics.sample_size.maximum
  const finalizationPass = finalizationRate !== null && finalizationRate >= manifest.metrics.finalization_rate.minimum
  const npsPass = npsScore !== null && npsScore >= manifest.metrics.nps.minimum
  const poiPass = poiRate !== null && poiRate < manifest.metrics.poi_hallucination_rate.exclusive_maximum
  const nightlyPass = replayableRuns.length > 0
  const metricPass = samplePass && finalizationPass && npsPass && poiPass && nightlyPass
  const businessPass = manifest.evidence_kind === 'real_seed_cohort' && metricPass
  const failedChecks = [
    !samplePass && 'sample_size',
    !finalizationPass && 'finalization_rate',
    !npsPass && 'nps',
    !poiPass && 'poi_hallucination_rate',
    !nightlyPass && 'nightly_real_llm',
  ].filter(Boolean)
  const businessPassReason = manifest.evidence_kind === 'synthetic_fixture'
    ? 'evidence_kind=synthetic_fixture cannot prove business pass'
    : businessPass
      ? 'all locked M3 acceptance thresholds passed on real_seed_cohort evidence'
      : `real_seed_cohort acceptance gaps: ${failedChecks.join(', ')}`

  return {
    schema_version: 'gotry_m3_product_metrics_summary_v1',
    evidence_kind: manifest.evidence_kind,
    cohort_id: manifest.cohort_id,
    evidence_digest_sha256: createHash('sha256').update(canonical({ manifest, cohort, nightlyRuns })).digest('hex'),
    sample: {
      participants: participants.size,
      minimum: manifest.metrics.sample_size.minimum,
      maximum: manifest.metrics.sample_size.maximum,
      pass: samplePass,
    },
    finalization: { numerator: finalized, denominator: eligible.length, rate: finalizationRate, pass: finalizationPass },
    nps: { promoters, passives, detractors, denominator: scores.length, score: npsScore, pass: npsPass },
    poi_hallucination: { invalid_claims: invalidClaims, locked_claims: lockedClaims, rate: poiRate, pass: poiPass },
    nightly: { replayable_real_llm_runs: replayableRuns.length, cost_usd: nightlyCost, pass: nightlyPass },
    exclusions: exclusionCounts,
    business_pass: businessPass,
    business_pass_reason: businessPassReason,
  }
}

function parseJsonLines(contents: string): unknown[] {
  return contents.split(/\r?\n/).flatMap((line, index) => {
    if (line.trim() === '') return []
    try {
      return [JSON.parse(line)]
    } catch (error) {
      throw new Error(`cohort.jsonl line ${index + 1} is invalid JSON: ${(error as Error).message}`)
    }
  })
}

function loadFixture(path: string): { manifest: M3EvidenceManifest; cohort: M3CohortRecord[]; nightlyRuns: M3NightlyRun[] } {
  const raw = object(JSON.parse(readFileSync(path, 'utf8')), 'fixture')
  exactKeys(raw, 'fixture', ['schema_version', 'manifest', 'cohort', 'nightly_runs'])
  literal(raw.schema_version, 'fixture.schema_version', ['gotry_m3_product_metrics_fixture_v1'])
  if (!Array.isArray(raw.cohort)) throw new Error('fixture.cohort must be an array')
  if (!Array.isArray(raw.nightly_runs)) throw new Error('fixture.nightly_runs must be an array')
  return {
    manifest: parseManifest(raw.manifest),
    cohort: raw.cohort.map(parseCohortRecord),
    nightlyRuns: raw.nightly_runs.map(parseNightlyRun),
  }
}

function loadEvidenceRoot(root: string): { manifest: M3EvidenceManifest; cohort: M3CohortRecord[]; nightlyRuns: M3NightlyRun[] } {
  const manifest = parseManifest(JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')))
  const records = parseJsonLines(readFileSync(join(root, 'cohort.jsonl'), 'utf8'))
  const cohort: M3CohortRecord[] = []
  const nightlyRuns: M3NightlyRun[] = []
  for (const record of records) {
    const schema = object(record, 'cohort.jsonl record').schema_version
    if (schema === 'gotry_m3_cohort_record_v1') cohort.push(parseCohortRecord(record, cohort.length))
    else if (schema === 'gotry_m3_nightly_run_v1') nightlyRuns.push(parseNightlyRun(record, nightlyRuns.length))
    else throw new Error(`cohort.jsonl contains unknown schema_version: ${String(schema)}`)
  }
  return { manifest, cohort, nightlyRuns }
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function renderMarkdown(summary: M3ProductMetricsSummary): string {
  const percent = (value: number | null): string => value === null ? 'unavailable' : `${round(value * 100)}%`
  return [
    `# M3 cohort 指标摘要(${summary.evidence_kind})`,
    '',
    `- 样本: ${summary.sample.participants} 人(pass=${summary.sample.pass};要求 ${summary.sample.minimum}..${summary.sample.maximum})`,
    `- 定稿率: ${summary.finalization.numerator}/${summary.finalization.denominator} = ${percent(summary.finalization.rate)}(pass=${summary.finalization.pass})`,
    `- NPS: ${summary.nps.score ?? 'unavailable'}(responses=${summary.nps.denominator};pass=${summary.nps.pass})`,
    `- POI 幻觉率: ${summary.poi_hallucination.invalid_claims}/${summary.poi_hallucination.locked_claims} = ${percent(summary.poi_hallucination.rate)}(pass=${summary.poi_hallucination.pass})`,
    `- Nightly real-LLM: ${summary.nightly.replayable_real_llm_runs} runs, $${summary.nightly.cost_usd}(pass=${summary.nightly.pass})`,
    `- Business pass: ${summary.business_pass} — ${summary.business_pass_reason}`,
    `- Evidence digest: ${summary.evidence_digest_sha256}`,
  ].join('\n')
}

function main(): void {
  const fixturePath = arg('--fixture')
  const evidenceRoot = arg('--evidence-root') ?? 'gotry-state/evidence/m3'
  const loaded = fixturePath ? loadFixture(fixturePath) : loadEvidenceRoot(evidenceRoot)
  const summary = scoreProductMetrics(loaded.manifest, loaded.cohort, loaded.nightlyRuns)
  if (process.argv.includes('--write-summary')) {
    if (fixturePath) throw new Error('--write-summary is forbidden for synthetic fixtures')
    mkdirSync(evidenceRoot, { recursive: true })
    writeFileSync(join(evidenceRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  }
  if ((arg('--format') ?? 'markdown') === 'json') console.log(JSON.stringify(summary))
  else console.log(renderMarkdown(summary))
}

if (process.argv[1]?.endsWith('product-metrics.ts')) {
  try {
    main()
  } catch (error) {
    console.error(`M3 product metrics error: ${(error as Error).message}`)
    process.exitCode = 1
  }
}
