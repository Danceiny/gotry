/**
 * M4 memory value scorer contract tests(issue #223).
 *
 * Focus:
 *   - frozen M4 thresholds (N>=5, median reduction >=0.5) cannot be weakened
 *   - public synthetic fixture keeps correct calculations but never closes M4
 *   - observed_private is only a candidate without a human source-review attestation
 *   - manual attestation is bound to the current scoring payload digest
 *   - root/nested unknown fields and PII-like values are rejected without echoing attacker keys/values
 *   - all id refs use hmac-sha256:<64lowerhex>; chronology/waits/duplicates/P4/preference guards fail closed
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { memoryValueSummaryDigest, scoreMemoryValue } from './memory-value-report.ts'

type MutableJson = Record<string, any>

const fixture = JSON.parse(readFileSync('data/memory-value-fixture.json', 'utf8')) as MutableJson
const hmac = (n: number): string => `hmac-sha256:${n.toString(16).padStart(64, '0')}`

let passed = 0
function ok(label: string): void {
  passed += 1
  console.log(`  ok ${label}`)
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function asText(value: unknown): string {
  return JSON.stringify(value)
}

function assertInvalid(value: unknown, label: string): void {
  const report = scoreMemoryValue(value)
  assert.equal(report.contract_valid, false, label)
  assert.equal(report.exit_ready, false, label)
}

function observedCopy(): MutableJson {
  const payload = clone(fixture)
  payload.evidence_kind = 'observed_private'
  return payload
}

function manualAttestation(payload: MutableJson): MutableJson {
  return {
    schema_version: 'memory_value_source_review.v1',
    state: 'manual_attested',
    reviewed_at: '2026-09-08T00:00:00Z',
    reviewer_ref: hmac(9001),
    attestation_ref: hmac(9002),
    private_source_digest_sha256: 'a'.repeat(64),
    reviewed_summary_digest_sha256: memoryValueSummaryDigest(payload),
    checks: {
      raw_private_material_excluded: true,
      paired_cohort_source_reviewed: true,
      summary_matches_private_source: true,
      no_synthetic_or_test_subjects: true,
    },
  }
}

function attest(payload: MutableJson): MutableJson {
  payload.source_review = manualAttestation(payload)
  return payload
}

function setPairDurations(payload: MutableJson, firstMs: number, returningMs: number): void {
  for (const [index, pair] of payload.pairs.entries()) {
    const firstStartedAt = Date.UTC(2026, 8, 1 + index, 10, 0, 0, 0)
    const returningStartedAt = Date.UTC(2026, 8, 8 + index, 10, 0, 0, 0)
    pair.first.started_at = new Date(firstStartedAt).toISOString()
    pair.first.completed_at = new Date(firstStartedAt + firstMs).toISOString()
    pair.first.external_waits = []
    pair.returning.started_at = new Date(returningStartedAt).toISOString()
    pair.returning.completed_at = new Date(returningStartedAt + returningMs).toISOString()
    pair.returning.external_waits = []
  }
}

function runCli(input: unknown): { status: number | null; stdout: string; stderr: string; report: MutableJson } {
  const root = mkdtempSync(join(tmpdir(), 'gotry-memory-value-'))
  const path = join(root, 'input.json')
  writeFileSync(path, JSON.stringify(input), 'utf8')
  const result = spawnSync('npx', ['tsx', 'scripts/memory-value-report.ts', path], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
  let report: MutableJson
  try {
    report = JSON.parse(result.stdout)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, report }
}

function runMalformedCli(contents: string): { status: number | null; stdout: string; stderr: string } {
  const root = mkdtempSync(join(tmpdir(), 'privacy-sentinel-path-'))
  const path = join(root, 'privacy-sentinel-input.json')
  writeFileSync(path, contents, 'utf8')
  const result = spawnSync('npx', ['tsx', 'scripts/memory-value-report.ts', path], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
  rmSync(root, { recursive: true, force: true })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

// ---- 1. synthetic fixture: metric-positive but business-ineligible ----
const synthetic = scoreMemoryValue(fixture)
assert.equal(synthetic.contract_valid, true)
assert.equal(synthetic.cohort.eligible_pair_count, 5)
assert.deepEqual(synthetic.cohort.first_active_seconds, { p50: 720, p75: 900 })
assert.deepEqual(synthetic.cohort.returning_active_seconds, { p50: 360, p75: 450 })
assert.deepEqual(synthetic.cohort.paired_reduction_ratio, { p50: 0.5, p75: 0.5 })
assert.equal(synthetic.cohort.minimum_pair_count_for_exit, 5)
assert.equal(synthetic.cohort.target_median_reduction_ratio, 0.5)
assert.equal(synthetic.cohort.sample_size_met, true)
assert.equal(synthetic.cohort.target_met, true)
assert.equal(synthetic.experience_reflux.baseline, 0.5)
assert.equal(synthetic.preference_assertions.traceable_ratio, 1)
assert.equal(synthetic.preference_assertions.hard_filter_violation_count, 0)
assert.equal(synthetic.p4.contract_met, true)
assert.equal(synthetic.source.source_review.contract_met, false)
assert.equal(synthetic.exit_evidence_eligible, false)
assert.equal(synthetic.exit_ready, false)
ok('synthetic fixture N=5/0.5 指标通过但不可作为 M4 Exit 证据')

// ---- 2. legal manual_attested observed-private positive path ----
const manualPositive = attest(observedCopy())
const manualPositiveReport = scoreMemoryValue(manualPositive)
assert.equal(manualPositiveReport.contract_valid, true)
assert.equal(manualPositiveReport.source.source_review.contract_met, true)
assert.equal(manualPositiveReport.source.source_review.provenance_verified_by_scorer, false)
assert.equal(manualPositiveReport.source.source_review.reviewed_summary_digest_sha256, memoryValueSummaryDigest(manualPositive))
assert.equal(manualPositiveReport.source.source_review.current_summary_digest_sha256, memoryValueSummaryDigest(manualPositive))
assert.equal(manualPositiveReport.source.source_review.reviewer_ref, hmac(9001))
assert.equal(manualPositiveReport.source.source_review.attestation_ref, hmac(9002))
assert.equal(manualPositiveReport.experience_reflux.real_evidence, true)
assert.equal(manualPositiveReport.exit_evidence_eligible, true)
assert.equal(manualPositiveReport.exit_ready, true)
ok('合法 manual_attested observed_private 在数字门槛与人工声明齐备时可达 ready')

// ---- 3. observed_private without provenance remains candidate despite passing metrics ----
const candidate = observedCopy()
candidate.source_review = {
  schema_version: 'memory_value_source_review.v1',
  state: 'candidate',
  reviewed_at: null,
  reviewer_ref: null,
  attestation_ref: null,
  private_source_digest_sha256: null,
  reviewed_summary_digest_sha256: null,
  checks: {
    raw_private_material_excluded: true,
    paired_cohort_source_reviewed: true,
    summary_matches_private_source: true,
    no_synthetic_or_test_subjects: false,
  },
}
const candidateReport = scoreMemoryValue(candidate)
assert.equal(candidateReport.contract_valid, true)
assert.equal(candidateReport.cohort.sample_size_met, true)
assert.equal(candidateReport.cohort.target_met, true)
assert.equal(candidateReport.source.evidence_kind, 'observed_private')
assert.equal(candidateReport.source.source_review.required_for_exit, true)
assert.equal(candidateReport.source.source_review.contract_met, false)
assert.equal(candidateReport.source.source_review.provenance_verified_by_scorer, false)
assert.equal(candidateReport.experience_reflux.real_evidence, false)
assert.equal(candidateReport.exit_evidence_eligible, false)
assert.equal(candidateReport.exit_ready, false)
ok('observed_private 缺人工 source-review attestation 时只可作为 candidate')

// ---- 4. attestation digest binds the current scoring payload ----
const staleAttestation = attest(observedCopy())
staleAttestation.pairs[0].returning.completed_at = '2026-08-08T10:07:00Z'
const staleAttestationReport = scoreMemoryValue(staleAttestation)
assert.equal(staleAttestationReport.contract_valid, false)
assert.equal(staleAttestationReport.exit_ready, false)
assert.match(asText(staleAttestationReport.errors), /reviewed_summary_digest_sha256/)
assert.notEqual(
  staleAttestation.source_review.reviewed_summary_digest_sha256,
  memoryValueSummaryDigest(staleAttestation),
)
ok('manual attestation 的 reviewed_summary_digest 绑定本次评分 payload,改 summary 后旧 attestation 失效')

// ---- 5. raw ratio threshold: report may round to 0.5, comparison must not ----
const exactHalf = observedCopy()
setPairDurations(exactHalf, 2_000_000, 1_000_000)
attest(exactHalf)
const exactHalfReport = scoreMemoryValue(exactHalf)
assert.equal(exactHalfReport.contract_valid, true)
assert.equal(exactHalfReport.cohort.paired_reduction_ratio.p50, 0.5)
assert.equal(exactHalfReport.cohort.target_met, true)
assert.equal(exactHalfReport.exit_ready, true)
const justUnderHalf = observedCopy()
setPairDurations(justUnderHalf, 2_000_001, 1_000_001)
attest(justUnderHalf)
const justUnderHalfReport = scoreMemoryValue(justUnderHalf)
assert.equal(justUnderHalfReport.contract_valid, true)
assert.equal(justUnderHalfReport.cohort.paired_reduction_ratio.p50, 0.5)
assert.equal(justUnderHalfReport.cohort.target_met, false)
assert.equal(justUnderHalfReport.exit_ready, false)
ok('raw ratio 比较:exact 50% 通过,49.999975% 即使展示 round 到 50% 仍未达标')

// ---- 6. original exploit: self-declared observed, N=1, target=0, email ids, undeclared fields ----
const exploit = clone(fixture)
exploit.evidence_kind = 'observed_private'
delete exploit.source_review
exploit.attacker_note = 'self-declared observed'
exploit.user_email = 'victim@example.com'
exploit.measurement_policy.minimum_pair_count_for_exit = 1
exploit.measurement_policy.target_median_reduction_ratio = 0
exploit.pairs = [exploit.pairs[0]]
exploit.pairs[0].subject_ref = 'victim@example.com'
exploit.pairs[0].returning.raw_transcript = 'PII leak field'
const exploitReport = scoreMemoryValue(exploit)
assert.equal(exploitReport.contract_valid, false)
assert.equal(exploitReport.exit_ready, false)
const exploitText = asText(exploitReport)
assert.doesNotMatch(exploitText, /victim@example\.com/)
assert.doesNotMatch(exploitText, /attacker_note/)
assert.doesNotMatch(exploitText, /raw_transcript/)
assert.doesNotMatch(exploitText, /PII leak field/)
ok('原反例红:observed 自报+降阈+明文邮箱+未知字段 fail-closed 且不回显攻击者 key/value')

// ---- 7. frozen policy and HMAC id format ----
const relaxedPolicy = clone(fixture)
relaxedPolicy.measurement_policy.minimum_pair_count_for_exit = 1
relaxedPolicy.measurement_policy.target_median_reduction_ratio = 0.49
assertInvalid(relaxedPolicy, 'weakened M4 threshold must be invalid')
const nonHmacIds = clone(fixture)
nonHmacIds.pairs[0].pair_id = 'pair-a'
nonHmacIds.pairs[0].subject_ref = 'user@example.com'
nonHmacIds.pairs[0].first.flow_id = 'flow-a-first'
nonHmacIds.experience_reflux_events[0].experience_id = 'experience-a'
nonHmacIds.experience_reflux_events[0].evidence_ref = 'fixture:evidence'
nonHmacIds.preference_assertions[0].assertion_id = 'preference-a'
nonHmacIds.preference_assertions[0].evidence_ref = 'raw evidence ref'
assertInvalid(nonHmacIds, 'all ids/refs must be hmac-sha256 pseudonyms')
ok('M4 阈值冻结且 subject/flow/pair/experience/assertion/evidence ref 均要求 HMAC')

// ---- 8. strict timestamps, first/return chronology, and wait interval guard ----
const invalidDate = clone(fixture)
invalidDate.pairs[0].first.started_at = '2026-02-30T10:00:00Z'
assertInvalid(invalidDate, 'invalid calendar date must be rejected')
const nonIsoDate = clone(fixture)
nonIsoDate.pairs[0].first.started_at = '2026-08-01 10:00:00'
assertInvalid(nonIsoDate, 'non-ISO timestamp must be rejected')
const reversedReturn = clone(fixture)
reversedReturn.pairs[0].returning.started_at = '2026-07-31T10:00:00Z'
reversedReturn.pairs[0].returning.completed_at = '2026-07-31T10:08:00Z'
reversedReturn.pairs[0].returning.external_waits = []
assertInvalid(reversedReturn, 'returning flow must follow first flow')
const outsideWait = clone(fixture)
outsideWait.pairs[0].returning.external_waits[0].started_at = '2026-08-08T09:59:00Z'
assertInvalid(outsideWait, 'external wait must stay inside flow')
const overlappingWait = clone(fixture)
overlappingWait.pairs[0].returning.external_waits.push({
  code: 'tool_latency',
  started_at: '2026-08-08T10:05:00Z',
  completed_at: '2026-08-08T10:07:00Z',
})
assertInvalid(overlappingWait, 'external waits must not overlap')
ok('严格 ISO 日期、首返时序、等待区间与不重叠守卫')

// ---- 9. duplicate pair/subject/flow and reflux/assertion pairing; preference evidence_ref may be reused ----
const duplicatePair = clone(fixture)
duplicatePair.pairs[1].pair_id = duplicatePair.pairs[0].pair_id
assertInvalid(duplicatePair, 'pair ids must be unique')
const duplicateSubject = clone(fixture)
duplicateSubject.pairs[1].subject_ref = duplicateSubject.pairs[0].subject_ref
assertInvalid(duplicateSubject, 'subjects must be unique')
const duplicateFlow = clone(fixture)
duplicateFlow.pairs[1].first.flow_id = duplicateFlow.pairs[0].first.flow_id
assertInvalid(duplicateFlow, 'flow ids must be globally unique')
const duplicateReflux = clone(fixture)
duplicateReflux.experience_reflux_events.push({
  experience_id: duplicateReflux.experience_reflux_events[0].experience_id,
  kind: duplicateReflux.experience_reflux_events[0].kind,
  evidence_ref: hmac(604),
})
assertInvalid(duplicateReflux, 'same experience/kind reflux event must not duplicate')
const unpairedVerified = clone(fixture)
unpairedVerified.experience_reflux_events.push({ experience_id: hmac(599), kind: 'verified_outcome', evidence_ref: hmac(605) })
assertInvalid(unpairedVerified, 'verified outcome must have recalled event')
const duplicateAssertion = clone(fixture)
duplicateAssertion.preference_assertions[1].assertion_id = duplicateAssertion.preference_assertions[0].assertion_id
assertInvalid(duplicateAssertion, 'assertion ids must be unique')
const sharedPreferenceEvidence = clone(fixture)
sharedPreferenceEvidence.preference_assertions[1].evidence_ref = sharedPreferenceEvidence.preference_assertions[0].evidence_ref
const sharedPreferenceEvidenceReport = scoreMemoryValue(sharedPreferenceEvidence)
assert.equal(sharedPreferenceEvidenceReport.contract_valid, true)
assert.equal(sharedPreferenceEvidenceReport.preference_assertions.contract_met, true)
ok('重复 pair/subject/flow、回流重复/配对、断言重复 fail-closed；preference evidence_ref 可合法复用')

// ---- 10. explicit hard_filter bool, consumer enum, and P4 bool/state ----
const hardFilter = clone(fixture)
hardFilter.preference_assertions[0].hard_filter = true
const hardFilterReport = scoreMemoryValue(hardFilter)
assert.equal(hardFilterReport.contract_valid, true)
assert.equal(hardFilterReport.preference_assertions.hard_filter_violation_count, 1)
assert.equal(hardFilterReport.preference_assertions.contract_met, false)
assert.equal(hardFilterReport.exit_ready, false)
const hardFilterConsumer = clone(fixture)
hardFilterConsumer.preference_assertions[0].consumer = 'hard_filter'
const hardFilterConsumerReport = scoreMemoryValue(hardFilterConsumer)
assert.equal(hardFilterConsumerReport.contract_valid, true)
assert.equal(hardFilterConsumerReport.preference_assertions.hard_filter_violation_count, 1)
assert.equal(hardFilterConsumerReport.preference_assertions.contract_met, false)
const missingHardFilterBool = clone(fixture)
missingHardFilterBool.preference_assertions[0].hard_filter = 'false'
assertInvalid(missingHardFilterBool, 'hard_filter must be explicit boolean')
const badConsumer = clone(fixture)
badConsumer.preference_assertions[0].consumer = 'prompt'
assertInvalid(badConsumer, 'consumer must be declared enum')
const earlyP4 = clone(fixture)
earlyP4.p4.state = 'open'
const earlyP4Report = scoreMemoryValue(earlyP4)
assert.equal(earlyP4Report.contract_valid, true)
assert.equal(earlyP4Report.p4.contract_met, false)
assert.equal(earlyP4Report.exit_ready, false)
const badP4Bool = clone(fixture)
badP4Bool.p4.triggers.real_usage = 'false'
assertInvalid(badP4Bool, 'P4 triggers must be boolean')
const badP4State = clone(fixture)
badP4State.p4.state = 'paused'
assertInvalid(badP4State, 'P4 state must be declared enum')
ok('偏好硬过滤、consumer enum、显式 bool 与 P4 状态/触发守卫')

// ---- 11. CLI E2E: isolated JSON input -> report + exit code; malformed JSON never echoes private text/path ----
const cliSynthetic = runCli(fixture)
assert.equal(cliSynthetic.status, 0)
assert.equal(cliSynthetic.report.contract_valid, true)
assert.equal(cliSynthetic.report.exit_ready, false)
const cliExploit = runCli(exploit)
assert.equal(cliExploit.status, 2)
assert.equal(cliExploit.report.contract_valid, false)
assert.equal(cliExploit.report.exit_ready, false)
const cliExploitText = asText(cliExploit.report)
assert.doesNotMatch(cliExploitText, /victim@example\.com|attacker_note|raw_transcript|PII leak field/)
const malformed = runMalformedCli('{"schema":"privacy-sentinel-value", "unterminated": ')
assert.equal(malformed.status, 2)
assert.equal(malformed.stdout, '')
assert.match(malformed.stderr, /MEMORY_VALUE_INPUT_INVALID/)
assert.doesNotMatch(`${malformed.stdout}\n${malformed.stderr}`, /privacy-sentinel/)
ok('CLI E2E:隔离 synthetic/恶意/畸形 JSON 输入产生确定 exit 且不回显私有值或路径')

console.log(`memory-value tests: ${passed} 组断言全绿(严格 schema/source-review digest/raw ratio/PII fail-closed)`)