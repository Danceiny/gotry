/**
 * Contract tests for the evaluation cadence policy and planner.
 * Run from ts/: npx tsx scripts/evaluation-cadence-tests.ts
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import {
  parseEvaluationCadencePolicy,
  planEvaluationCadence,
} from '../src/evaluation-cadence.ts'
import { assertPublicArtifactSafe } from '../src/evaluation-contracts.ts'

const policyPath = join(process.cwd(), 'data', 'evaluation', 'cadence-policy.json')

type Policy = Record<string, unknown>

async function loadPolicyFixture(): Promise<Policy> {
  // This must remain a real fixture load: policy behavior is not tested with an inline mock.
  return JSON.parse(await readFile(policyPath, 'utf8')) as Policy
}

function expectThrows(fn: () => unknown, message: string): void {
  assert.throws(fn, /./, message)
}

async function testCanonicalPolicyAndHealthyWeeklyPlan(): Promise<void> {
  const raw = await loadPolicyFixture()
  const policy = parseEvaluationCadencePolicy(raw)
  assertPublicArtifactSafe(policy, 'test policy safety')
  assert.deepEqual(policy.levels.map((level) => level.cadence), ['pr', 'nightly', 'weekly', 'milestone'])
  assert.deepEqual(policy.levels.map((level) => level.pass_k), [1, 2, 3, 5])
  assert.deepEqual(policy.levels.map((level) => level.max_cost_usd), [0, 2, 10, 50])
  assert.deepEqual(policy.levels.map((level) => level.max_wall_minutes), [20, 90, 360, 1440])
  assert.deepEqual(policy.levels.map((level) => level.max_tool_calls_per_case), [18, 18, 18, 18])
  assert.deepEqual(policy.levels.map((level) => [level.human_calibration.required, level.human_calibration.min_samples]), [[false, 0], [false, 0], [true, 10], [true, 30]])

  const decision = planEvaluationCadence(policy, {
    cadence: 'weekly',
    signals: [],
    recent_optimization_prs: [81, 84, 87, 89],
  })
  assert.deepEqual(decision, {
    cadence: 'weekly',
    admission: true,
    failure_registry: false,
    stop_signals: [],
    launches_external_runs: false,
    pass_k: 3,
    max_cost_usd: 10,
    max_wall_minutes: 360,
    max_tool_calls_per_case: 18,
    human_calibration: { required: true, min_samples: 10 },
    cross_benchmark_window: { min_prs: 3, max_prs: 5 },
    performance_tradeoff_disclosure_threshold: 0.2,
    delivery: {
      exactly_one_gotry_pr: true,
      exactly_one_discussion_78_comment: true,
      update_existing_comment: true,
    },
    cross_benchmark_synthesis: { required: true, overdue: false },
  })
  assertPublicArtifactSafe(decision, 'test decision safety')
}

async function testStopSignalsDenyAdmissionAndRegisterFailures(): Promise<void> {
  const policy = parseEvaluationCadencePolicy(await loadPolicyFixture())
  const decision = planEvaluationCadence(policy, {
    cadence: 'weekly',
    signals: ['source_revision_drift', 'hard_violation'],
    recent_optimization_prs: [81, 84, 87],
  })
  assert.equal(decision.admission, false)
  assert.deepEqual(decision.stop_signals, ['source_revision_drift', 'hard_violation'])
  assert.equal(decision.failure_registry, true)

  const nonRegistry = planEvaluationCadence(policy, {
    cadence: 'weekly',
    signals: ['license_unresolved'],
    recent_optimization_prs: [81, 84, 87],
  })
  assert.equal(nonRegistry.admission, false)
  assert.equal(nonRegistry.failure_registry, false)

  const allSignals = planEvaluationCadence(policy, {
    cadence: 'weekly',
    signals: ['source_revision_drift', 'license_unresolved', 'scorer_ceiling_invalid', 'known_bad_no_longer_fails', 'hard_violation', 'matched_regression', 'variance_breach', 'budget_breach'],
    recent_optimization_prs: [],
  })
  assert.equal(allSignals.admission, false)
  assert.equal(allSignals.failure_registry, true)

  const duplicatePrs = { cadence: 'weekly', signals: [], recent_optimization_prs: [81, 81, 82] }
  expectThrows(() => planEvaluationCadence(policy, duplicatePrs), 'duplicate optimization PR IDs must fail closed')
  const sparsePrs: number[] = []; sparsePrs[2] = 81
  expectThrows(() => planEvaluationCadence(policy, { cadence: 'weekly', signals: [], recent_optimization_prs: sparsePrs }), 'sparse optimization PR IDs must fail closed')
  expectThrows(() => planEvaluationCadence(policy, { cadence: 'weekly', signals: [], recent_optimization_prs: [0] }), 'non-positive optimization PR IDs must fail closed')
  expectThrows(() => planEvaluationCadence(policy, { cadence: 'weekly', signals: [], recent_optimization_prs: [1.5] }), 'fractional optimization PR IDs must fail closed')
}

async function testRoundDeliveryAndMilestoneCalibration(): Promise<void> {
  const policy = parseEvaluationCadencePolicy(await loadPolicyFixture())
  const milestone = planEvaluationCadence(policy, {
    cadence: 'milestone',
    signals: [],
    recent_optimization_prs: [81, 84, 87, 89, 91],
  })
  assert.equal(milestone.admission, true)
  assert.equal(milestone.pass_k, 5)
  assert.deepEqual(milestone.human_calibration, { required: true, min_samples: 30 })
  assert.deepEqual(milestone.cross_benchmark_window, { min_prs: 3, max_prs: 5 })
  assert.equal(milestone.performance_tradeoff_disclosure_threshold, 0.2)
  assert.deepEqual(milestone.delivery, {
    exactly_one_gotry_pr: true,
    exactly_one_discussion_78_comment: true,
    update_existing_comment: true,
  })
  assert.deepEqual(milestone.cross_benchmark_synthesis, { required: true, overdue: false })
  assert.deepEqual(planEvaluationCadence(policy, { cadence: 'weekly', signals: [], recent_optimization_prs: [] }).cross_benchmark_synthesis, { required: false, overdue: false })
  assert.deepEqual(planEvaluationCadence(policy, { cadence: 'weekly', signals: [], recent_optimization_prs: [81, 82, 83, 84, 85, 86] }).cross_benchmark_synthesis, { required: true, overdue: true })
}

async function testMalformedPolicyFailsClosed(): Promise<void> {
  const fixture = await loadPolicyFixture()
  const malformed = (change: (copy: Policy) => void): void => {
    const copy = structuredClone(fixture)
    change(copy)
    expectThrows(() => parseEvaluationCadencePolicy(copy), 'malformed policy must fail closed')
  }

  malformed((copy) => { copy.unknown_key = true })
  malformed((copy) => { (copy.levels as Policy[])[0]!.cadence = 'hourly' })
  malformed((copy) => { (copy.levels as Policy[])[0]!.pass_k = -1 })
  malformed((copy) => { (copy.levels as Policy[])[0]!.pass_k = 1.5 })
  malformed((copy) => { copy.levels = [...(copy.levels as Policy[])].reverse() })
  malformed((copy) => { const sparse: Policy[] = []; sparse[3] = (copy.levels as Policy[])[3]!; copy.levels = sparse })
  malformed((copy) => { delete copy.stop_signals })

  const policy = parseEvaluationCadencePolicy(fixture)
  const tamperedPolicy = structuredClone(policy)
  tamperedPolicy.levels[2]!.max_cost_usd = 999
  expectThrows(() => planEvaluationCadence(tamperedPolicy, { cadence: 'weekly', signals: [], recent_optimization_prs: [] }), 'tampered policy budget must fail closed')
  const tamperedDelivery = structuredClone(policy)
  ;(tamperedDelivery.round_delivery as { exactly_one_gotry_pr: boolean }).exactly_one_gotry_pr = false
  expectThrows(() => planEvaluationCadence(tamperedDelivery, { cadence: 'weekly', signals: [], recent_optimization_prs: [] }), 'tampered policy delivery must fail closed')
  expectThrows(() => planEvaluationCadence(policy, {
    cadence: 'hourly',
    signals: [],
    recent_optimization_prs: [],
  }), 'unknown cadence must fail closed')
  expectThrows(() => planEvaluationCadence(policy, {
    cadence: 'weekly',
    signals: ['unknown_signal'],
    recent_optimization_prs: [],
  }), 'unknown stop signal must fail closed')
  expectThrows(() => planEvaluationCadence(policy, {
    cadence: 'weekly',
    signals: ['hard_violation', 'hard_violation'],
    recent_optimization_prs: [],
  }), 'duplicate stop signals must fail closed')
  const sparseSignals: string[] = []; sparseSignals[1] = 'hard_violation'
  expectThrows(() => planEvaluationCadence(policy, {
    cadence: 'weekly',
    signals: sparseSignals,
    recent_optimization_prs: [],
  }), 'sparse stop signals must fail closed')
}

async function testPolicyPublicSafety(): Promise<void> {
  const policy = parseEvaluationCadencePolicy(await loadPolicyFixture())
  assert.deepEqual(policy.public_safety, {
    artifact_classification: 'public_safe',
    contains_third_party_prompt: false,
    contains_gold: false,
    contains_oracle: false,
    contains_private_data: false,
  })
}

async function main(): Promise<void> {
  await testCanonicalPolicyAndHealthyWeeklyPlan()
  await testStopSignalsDenyAdmissionAndRegisterFailures()
  await testRoundDeliveryAndMilestoneCalibration()
  await testMalformedPolicyFailsClosed()
  await testPolicyPublicSafety()
  console.log('evaluation cadence tests: PASS')
}

main().catch((error: unknown) => {
  console.error('evaluation cadence tests: FAIL')
  console.error(error)
  process.exitCode = 1
})
