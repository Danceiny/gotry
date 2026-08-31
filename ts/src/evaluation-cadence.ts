import { assertPublicArtifactSafe } from './evaluation-contracts.ts'

export const CADENCES = ['pr', 'nightly', 'weekly', 'milestone'] as const
export const STOP_SIGNALS = ['source_revision_drift', 'license_unresolved', 'scorer_ceiling_invalid', 'known_bad_no_longer_fails', 'hard_violation', 'matched_regression', 'variance_breach', 'budget_breach'] as const
type Cadence = typeof CADENCES[number]
type StopSignal = typeof STOP_SIGNALS[number]

export interface EvaluationCadenceLevel { cadence: Cadence; pass_k: number; max_cost_usd: number; max_wall_minutes: number; max_tool_calls_per_case: 18; human_calibration: { required: boolean; min_samples: number } }
export interface EvaluationCadencePolicy { schema: 'gotry_evaluation_cadence_policy_v1'; levels: EvaluationCadenceLevel[]; cross_benchmark_window: { min_prs: 3; max_prs: 5 }; performance_tradeoff_disclosure_threshold: 0.2; round_delivery: { exactly_one_gotry_pr: true; exactly_one_discussion_78_comment: true; update_existing_comment: true }; stop_signals: StopSignal[]; failure_registry_signals: StopSignal[]; public_safety: { artifact_classification: 'public_safe'; contains_third_party_prompt: false; contains_gold: false; contains_oracle: false; contains_private_data: false } }
export interface EvaluationCadenceDecision { cadence: Cadence; admission: boolean; failure_registry: boolean; stop_signals: StopSignal[]; launches_external_runs: false; pass_k: number; max_cost_usd: number; max_wall_minutes: number; max_tool_calls_per_case: 18; human_calibration: { required: boolean; min_samples: number }; cross_benchmark_window: { min_prs: 3; max_prs: 5 }; performance_tradeoff_disclosure_threshold: 0.2; delivery: EvaluationCadencePolicy['round_delivery']; cross_benchmark_synthesis: { required: boolean; overdue: boolean } }

function object(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`); return value as Record<string, unknown> }
function exact(value: Record<string, unknown>, label: string, keys: string[]): void { const actual = Object.keys(value).sort(); const expected = [...keys].sort(); if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} keys must be exact`); }
function number(value: unknown, label: string, min = 0): number { if (typeof value !== 'number' || !Number.isFinite(value) || value < min) throw new Error(`${label} must be finite and non-negative`); return value }
function integer(value: unknown, label: string, min = 0): number { const n = number(value, label, min); if (!Number.isInteger(n)) throw new Error(`${label} must be an integer`); return n }
function literal<T extends string>(value: unknown, label: string, allowed: readonly T[]): T { if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error(`${label} is invalid`); return value as T }
function bool(value: unknown, label: string, expected: boolean): boolean { if (value !== expected) throw new Error(`${label} must be ${expected}`); return expected }

export function parseEvaluationCadencePolicy(value: unknown): EvaluationCadencePolicy {
  const root = object(value, 'policy')
  exact(root, 'policy', ['schema', 'levels', 'cross_benchmark_window', 'performance_tradeoff_disclosure_threshold', 'round_delivery', 'stop_signals', 'failure_registry_signals', 'public_safety'])
  if (root.schema !== 'gotry_evaluation_cadence_policy_v1') throw new Error('policy schema is invalid')
  if (!Array.isArray(root.levels) || root.levels.length !== 4) throw new Error('policy levels must be complete')
  for (let index = 0; index < root.levels.length; index += 1) if (!Object.hasOwn(root.levels, index)) throw new Error('policy levels must be dense')
  const levels = root.levels.map((raw, i) => {
    const item = object(raw, `policy.levels[${i}]`)
    exact(item, `policy.levels[${i}]`, ['cadence', 'pass_k', 'max_cost_usd', 'max_wall_minutes', 'max_tool_calls_per_case', 'human_calibration'])
    const cadence = literal(item.cadence, 'cadence', CADENCES)
    if (cadence !== CADENCES[i]) throw new Error('policy levels must use canonical order')
    const calibration = object(item.human_calibration, 'human_calibration')
    exact(calibration, 'human_calibration', ['required', 'min_samples'])
    const pass_k = integer(item.pass_k, 'pass_k', 1)
    const max_cost_usd = number(item.max_cost_usd, 'max_cost_usd')
    const max_wall_minutes = number(item.max_wall_minutes, 'max_wall_minutes')
    if (item.max_tool_calls_per_case !== 18) throw new Error('max_tool_calls_per_case must be 18')
    const required = Boolean(calibration.required)
    if (calibration.required !== required) throw new Error('human calibration required must be boolean')
    const min_samples = integer(calibration.min_samples, 'min_samples')
    const expected = [[1, 0, 20, false, 0], [2, 2, 90, false, 0], [3, 10, 360, true, 10], [5, 50, 1440, true, 30]][i]!
    if (pass_k !== expected[0] || max_cost_usd !== expected[1] || max_wall_minutes !== expected[2] || required !== expected[3] || min_samples !== expected[4]) throw new Error('policy level literals are invalid')
    return { cadence, pass_k, max_cost_usd, max_wall_minutes, max_tool_calls_per_case: 18, human_calibration: { required, min_samples } }
  })
  const window = object(root.cross_benchmark_window, 'cross_benchmark_window'); exact(window, 'cross_benchmark_window', ['min_prs', 'max_prs']); if (window.min_prs !== 3 || window.max_prs !== 5) throw new Error('cross benchmark window must be 3..5')
  if (root.performance_tradeoff_disclosure_threshold !== 0.2) throw new Error('tradeoff threshold must be 0.2')
  const delivery = object(root.round_delivery, 'round_delivery'); exact(delivery, 'round_delivery', ['exactly_one_gotry_pr', 'exactly_one_discussion_78_comment', 'update_existing_comment']); for (const key of Object.keys(delivery)) bool(delivery[key], `round_delivery.${key}`, true)
  if (!Array.isArray(root.stop_signals) || JSON.stringify(root.stop_signals) !== JSON.stringify(STOP_SIGNALS)) throw new Error('stop signals must be the complete canonical set')
  if (!Array.isArray(root.failure_registry_signals) || JSON.stringify(root.failure_registry_signals) !== JSON.stringify(STOP_SIGNALS.slice(4))) throw new Error('failure registry signals are invalid')
  const publicSafety = object(root.public_safety, 'public_safety'); exact(publicSafety, 'public_safety', ['artifact_classification', 'contains_third_party_prompt', 'contains_gold', 'contains_oracle', 'contains_private_data']); if (publicSafety.artifact_classification !== 'public_safe') throw new Error('policy must be public safe'); for (const key of ['contains_third_party_prompt', 'contains_gold', 'contains_oracle', 'contains_private_data']) bool(publicSafety[key], `public_safety.${key}`, false)
  const policy = { schema: root.schema, levels, cross_benchmark_window: { min_prs: 3, max_prs: 5 }, performance_tradeoff_disclosure_threshold: 0.2, round_delivery: { exactly_one_gotry_pr: true, exactly_one_discussion_78_comment: true, update_existing_comment: true }, stop_signals: [...STOP_SIGNALS], failure_registry_signals: [...STOP_SIGNALS.slice(4)], public_safety: { artifact_classification: 'public_safe', contains_third_party_prompt: false, contains_gold: false, contains_oracle: false, contains_private_data: false } } as EvaluationCadencePolicy
  assertPublicArtifactSafe(policy, 'evaluation cadence policy')
  return policy
}

export function planEvaluationCadence(policy: EvaluationCadencePolicy, input: { cadence: string; signals: string[]; recent_optimization_prs: number[] }): EvaluationCadenceDecision {
  const inputObject = object(input, 'planner input')
  exact(inputObject, 'planner input', ['cadence', 'signals', 'recent_optimization_prs'])
  if (!CADENCES.includes(input.cadence as Cadence) || !Array.isArray(input.signals) || !Array.isArray(input.recent_optimization_prs)) throw new Error('planner input is invalid')
  for (let index = 0; index < input.signals.length; index += 1) if (!Object.hasOwn(input.signals, index)) throw new Error('stop signals must be dense')
  for (let index = 0; index < input.recent_optimization_prs.length; index += 1) if (!Object.hasOwn(input.recent_optimization_prs, index)) throw new Error('recent optimization PR IDs must be dense')
  if (input.recent_optimization_prs.some((id) => !Number.isInteger(id) || id < 1) || new Set(input.recent_optimization_prs).size !== input.recent_optimization_prs.length) throw new Error('recent optimization PR IDs must be positive and unique')
  const normalizedPolicy = parseEvaluationCadencePolicy(policy)
  const cadence = input.cadence as Cadence
  const signals = input.signals.map((signal) => literal(signal, 'stop signal', STOP_SIGNALS))
  if (new Set(signals).size !== signals.length) throw new Error('stop signals must be unique')
  const level = normalizedPolicy.levels.find((item) => item.cadence === cadence); if (!level) throw new Error('cadence is not configured')
  const failure_registry = signals.some((signal) => normalizedPolicy.failure_registry_signals.includes(signal))
  const decision = { cadence, admission: signals.length === 0, failure_registry, stop_signals: signals, launches_external_runs: false as const, pass_k: level.pass_k, max_cost_usd: level.max_cost_usd, max_wall_minutes: level.max_wall_minutes, max_tool_calls_per_case: 18 as const, human_calibration: level.human_calibration, cross_benchmark_window: { min_prs: 3, max_prs: 5 }, performance_tradeoff_disclosure_threshold: 0.2, delivery: normalizedPolicy.round_delivery, cross_benchmark_synthesis: { required: input.recent_optimization_prs.length >= 3, overdue: input.recent_optimization_prs.length > 5 } } as EvaluationCadenceDecision
  assertPublicArtifactSafe(decision, 'evaluation cadence decision')
  return decision
}
