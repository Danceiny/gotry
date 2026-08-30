import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  BENCHMARK_IDS, applyMutationVector, assertPublicArtifactSafe, deriveMatchedPairs,
  evaluationFingerprint, parseBenchmarkRegistry, parseEvalCase, parseEvalFailureCluster,
  parseEvalRunReceipt, parseEvaluationFoundation, parseMutationVectors, stableEvaluationJson,
  type EvaluationFoundationV0, type EvalRunReceiptV0,
} from '../src/evaluation-contracts.ts'

const load = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'))
const registry = parseBenchmarkRegistry(load('data/evaluation/benchmark-registry.json'))
assert.deepEqual(registry.map(item => item.benchmark_id), [...BENCHMARK_IDS])
assert.equal(registry.length, 7)
assert.deepEqual(Object.fromEntries(registry.map(item => [item.benchmark_id, item.native_metrics.values.map(metric => metric.receipt_key)])), {
  trek: ['task_perfect_feasible', 'task_perfect_infeasible', 'cat_efficiency'],
  travelplanner: ['commonsense_micro_pass_rate', 'commonsense_macro_pass_rate', 'hard_micro_pass_rate', 'hard_macro_pass_rate', 'final_pass_rate'],
  chinatravel: ['epr_micro', 'epr_macro', 'c_lpr', 'fpr', 'dav', 'att', 'ddr', 'overall_score'],
  travelbench: ['reasoning_planning_score', 'summarization_extraction_score', 'presentation_score', 'user_interaction_score', 'average_score', 'unsolved_accuracy'],
  tau2: ['avg_reward', 'pass_hat_1'], locomo: ['qa_f1'], bfcl: ['category_accuracy', 'overall_accuracy'],
})

const registryFacts = Object.fromEntries(registry.map(entry => [entry.benchmark_id, {
  owner: new URL(entry.provenance.official_entry.url).pathname.split('/')[1],
  pins: Object.entries(entry.provenance).map(([kind, pin]) => `${kind}|${pin.url}|${pin.revision.kind}|${pin.revision.value ?? 'null'}|${pin.source_scope}`),
  rights: Object.entries(entry.license.upstream_rights).map(([kind, right]) => `${kind}|${right.value}|${right.determination}|${right.source_url}`),
  metrics: entry.native_metrics.values.map(metric => `${metric.receipt_key}|${metric.upstream_label}|${metric.scope}|${metric.source_url}`),
}]))
assert.deepEqual(registryFacts, {
  "trek": {"owner":"TonyQJH","pins":["official_entry|https://github.com/TonyQJH/TREK-A-Travel-Reasoning-and-Evaluation-Kit-for-LLM-Agents-in-Complex-Trip-Planning/blob/6ceb4ebb2debd69c5c7c4ba34b5b17524756912b/README.md|git_commit|6ceb4ebb2debd69c5c7c4ba34b5b17524756912b|official definition","data|https://github.com/TonyQJH/TREK-A-Travel-Reasoning-and-Evaluation-Kit-for-LLM-Agents-in-Complex-Trip-Planning/tree/6ceb4ebb2debd69c5c7c4ba34b5b17524756912b/api/data/v2|git_commit|6ceb4ebb2debd69c5c7c4ba34b5b17524756912b|task data v2","evaluator|https://github.com/TonyQJH/TREK-A-Travel-Reasoning-and-Evaluation-Kit-for-LLM-Agents-in-Complex-Trip-Planning/blob/6ceb4ebb2debd69c5c7c4ba34b5b17524756912b/scoring.py|git_commit|6ceb4ebb2debd69c5c7c4ba34b5b17524756912b|official nine-dimension scoring implementation"],"rights":["code|MIT|declared|https://github.com/TonyQJH/TREK-A-Travel-Reasoning-and-Evaluation-Kit-for-LLM-Agents-in-Complex-Trip-Planning/blob/6ceb4ebb2debd69c5c7c4ba34b5b17524756912b/LICENSE","data|CC-BY-4.0|declared|https://github.com/TonyQJH/TREK-A-Travel-Reasoning-and-Evaluation-Kit-for-LLM-Agents-in-Complex-Trip-Planning/blob/6ceb4ebb2debd69c5c7c4ba34b5b17524756912b/README.md#data-and-license","evaluator|MIT|declared|https://github.com/TonyQJH/TREK-A-Travel-Reasoning-and-Evaluation-Kit-for-LLM-Agents-in-Complex-Trip-Planning/blob/6ceb4ebb2debd69c5c7c4ba34b5b17524756912b/LICENSE"],"metrics":["task_perfect_feasible|task_perfect_feasible|task-perfect feasible|https://github.com/TonyQJH/TREK-A-Travel-Reasoning-and-Evaluation-Kit-for-LLM-Agents-in-Complex-Trip-Planning/blob/6ceb4ebb2debd69c5c7c4ba34b5b17524756912b/scoring.py","task_perfect_infeasible|task_perfect_infeasible|task-perfect infeasible|https://github.com/TonyQJH/TREK-A-Travel-Reasoning-and-Evaluation-Kit-for-LLM-Agents-in-Complex-Trip-Planning/blob/6ceb4ebb2debd69c5c7c4ba34b5b17524756912b/scoring.py","cat_efficiency|cat_efficiency|category efficiency|https://github.com/TonyQJH/TREK-A-Travel-Reasoning-and-Evaluation-Kit-for-LLM-Agents-in-Complex-Trip-Planning/blob/6ceb4ebb2debd69c5c7c4ba34b5b17524756912b/scoring.py"]},
  "travelplanner": {"owner":"OSU-NLP-Group","pins":["official_entry|https://github.com/OSU-NLP-Group/TravelPlanner/blob/e52c87f4ac348a3410c46dc3553c519db5ec5e23/README.md|git_commit|e52c87f4ac348a3410c46dc3553c519db5ec5e23|official definition","data|https://huggingface.co/datasets/osunlp/TravelPlanner/tree/8736504ecfc31b7f8b7e40122873c337e83fff7c|git_commit|8736504ecfc31b7f8b7e40122873c337e83fff7c|official Hugging Face dataset git revision","evaluator|https://github.com/OSU-NLP-Group/TravelPlanner/blob/e52c87f4ac348a3410c46dc3553c519db5ec5e23/evaluation/eval.py|git_commit|e52c87f4ac348a3410c46dc3553c519db5ec5e23|official evaluator"],"rights":["code|MIT|declared|https://github.com/OSU-NLP-Group/TravelPlanner/blob/e52c87f4ac348a3410c46dc3553c519db5ec5e23/LICENSE","data|CC-BY-4.0|declared|https://huggingface.co/datasets/osunlp/TravelPlanner/blob/8736504ecfc31b7f8b7e40122873c337e83fff7c/README.md","evaluator|MIT|declared|https://github.com/OSU-NLP-Group/TravelPlanner/blob/e52c87f4ac348a3410c46dc3553c519db5ec5e23/LICENSE"],"metrics":["commonsense_micro_pass_rate|Commonsense Constraint Micro Pass Rate|commonsense micro|https://github.com/OSU-NLP-Group/TravelPlanner/blob/e52c87f4ac348a3410c46dc3553c519db5ec5e23/evaluation/eval.py","commonsense_macro_pass_rate|Commonsense Constraint Macro Pass Rate|commonsense macro|https://github.com/OSU-NLP-Group/TravelPlanner/blob/e52c87f4ac348a3410c46dc3553c519db5ec5e23/evaluation/eval.py","hard_micro_pass_rate|Hard Constraint Micro Pass Rate|hard-constraint micro|https://github.com/OSU-NLP-Group/TravelPlanner/blob/e52c87f4ac348a3410c46dc3553c519db5ec5e23/evaluation/eval.py","hard_macro_pass_rate|Hard Constraint Macro Pass Rate|hard-constraint macro|https://github.com/OSU-NLP-Group/TravelPlanner/blob/e52c87f4ac348a3410c46dc3553c519db5ec5e23/evaluation/eval.py","final_pass_rate|Final Pass Rate|complete itinerary|https://github.com/OSU-NLP-Group/TravelPlanner/blob/e52c87f4ac348a3410c46dc3553c519db5ec5e23/evaluation/eval.py"]},
  "chinatravel": {"owner":"chinatravel-competition","pins":["official_entry|https://github.com/chinatravel-competition/IJCAI2026/blob/49d02bc322dda7ffbf53dfb7c3d2ced6b4bd4e8b/index.html|git_commit|49d02bc322dda7ffbf53dfb7c3d2ced6b4bd4e8b|official competition entry","data|https://github.com/chinatravel-competition/IJCAI2026/blob/49d02bc322dda7ffbf53dfb7c3d2ced6b4bd4e8b/TPC_IJCAI_2026_phase2_familiar_100_data.zip|git_commit|49d02bc322dda7ffbf53dfb7c3d2ced6b4bd4e8b|public familiar-track archive","evaluator|https://github.com/LAMDA-NeSy/ChinaTravel/blob/b071db251905b14002ec98e8b36afca7b6d6cd04/eval_tpc.py|git_commit|b071db251905b14002ec98e8b36afca7b6d6cd04|official TPC evaluator implementation"],"rights":["code|not_separately_declared|not_separately_declared|https://github.com/LAMDA-NeSy/ChinaTravel/blob/b071db251905b14002ec98e8b36afca7b6d6cd04/README.md","data|CC-BY-NC-SA-4.0|declared|https://huggingface.co/datasets/LAMDA-NeSy/ChinaTravel/blob/44d5dbf3bba26bdf9a212c3e76d3242b67f0d349/README.md","evaluator|not_separately_declared|not_separately_declared|https://github.com/LAMDA-NeSy/ChinaTravel/blob/b071db251905b14002ec98e8b36afca7b6d6cd04/README.md"],"metrics":["epr_micro|EPR-micro|element pass micro|https://github.com/LAMDA-NeSy/ChinaTravel/blob/b071db251905b14002ec98e8b36afca7b6d6cd04/eval_tpc.py","epr_macro|EPR-macro|element pass macro|https://github.com/LAMDA-NeSy/ChinaTravel/blob/b071db251905b14002ec98e8b36afca7b6d6cd04/eval_tpc.py","c_lpr|C-LPR|constraint-level pass|https://github.com/LAMDA-NeSy/ChinaTravel/blob/b071db251905b14002ec98e8b36afca7b6d6cd04/eval_tpc.py","fpr|FPR|final pass|https://github.com/LAMDA-NeSy/ChinaTravel/blob/b071db251905b14002ec98e8b36afca7b6d6cd04/eval_tpc.py","dav|DAV|Daily Average Attractions Visited|https://github.com/LAMDA-NeSy/ChinaTravel/blob/b071db251905b14002ec98e8b36afca7b6d6cd04/eval_tpc.py","att|ATT|Averaged Transportation Time|https://github.com/LAMDA-NeSy/ChinaTravel/blob/b071db251905b14002ec98e8b36afca7b6d6cd04/eval_tpc.py","ddr|DDR|Daily Dining Recommendations|https://github.com/LAMDA-NeSy/ChinaTravel/blob/b071db251905b14002ec98e8b36afca7b6d6cd04/eval_tpc.py","overall_score|Overall Score|weighted overall score|https://github.com/LAMDA-NeSy/ChinaTravel/blob/b071db251905b14002ec98e8b36afca7b6d6cd04/eval_tpc.py"]},
  "travelbench": {"owner":"small-xiangcheng","pins":["official_entry|https://github.com/small-xiangcheng/TravelBench/blob/445a29d9a9b6457fc95fe647c532b6b79e21c43f/README.md|git_commit|445a29d9a9b6457fc95fe647c532b6b79e21c43f|official definition","data|https://github.com/small-xiangcheng/TravelBench/tree/445a29d9a9b6457fc95fe647c532b6b79e21c43f/datas|git_commit|445a29d9a9b6457fc95fe647c532b6b79e21c43f|official data directory","evaluator|https://github.com/small-xiangcheng/TravelBench/blob/445a29d9a9b6457fc95fe647c532b6b79e21c43f/travelbench/evaluation/evaluate.py|git_commit|445a29d9a9b6457fc95fe647c532b6b79e21c43f|official evaluator"],"rights":["code|MIT|declared|https://github.com/small-xiangcheng/TravelBench/blob/445a29d9a9b6457fc95fe647c532b6b79e21c43f/LICENSE","data|CC-BY-NC-4.0|declared|https://github.com/small-xiangcheng/TravelBench/blob/445a29d9a9b6457fc95fe647c532b6b79e21c43f/datas/LICENSE","evaluator|MIT|declared|https://github.com/small-xiangcheng/TravelBench/blob/445a29d9a9b6457fc95fe647c532b6b79e21c43f/LICENSE"],"metrics":["reasoning_planning_score|reasoning_planning_score|reasoning and planning|https://github.com/small-xiangcheng/TravelBench/blob/445a29d9a9b6457fc95fe647c532b6b79e21c43f/travelbench/evaluation/evaluate.py","summarization_extraction_score|summarization_extraction_score|summarization and extraction|https://github.com/small-xiangcheng/TravelBench/blob/445a29d9a9b6457fc95fe647c532b6b79e21c43f/travelbench/evaluation/evaluate.py","presentation_score|presentation_score|presentation|https://github.com/small-xiangcheng/TravelBench/blob/445a29d9a9b6457fc95fe647c532b6b79e21c43f/travelbench/evaluation/evaluate.py","user_interaction_score|user_interaction_score|user interaction|https://github.com/small-xiangcheng/TravelBench/blob/445a29d9a9b6457fc95fe647c532b6b79e21c43f/travelbench/evaluation/evaluate.py","average_score|average_score|average across dimensions|https://github.com/small-xiangcheng/TravelBench/blob/445a29d9a9b6457fc95fe647c532b6b79e21c43f/travelbench/evaluation/evaluate.py","unsolved_accuracy|unsolved_accuracy|unsolved cases|https://github.com/small-xiangcheng/TravelBench/blob/445a29d9a9b6457fc95fe647c532b6b79e21c43f/travelbench/evaluation/evaluate_unsolved.py"]},
  "tau2": {"owner":"sierra-research","pins":["official_entry|https://github.com/sierra-research/tau2-bench/blob/a2c024725189473d2d7cea3a5cfdbcc67478e41f/README.md|git_commit|a2c024725189473d2d7cea3a5cfdbcc67478e41f|official definition","data|https://github.com/sierra-research/tau2-bench/tree/a2c024725189473d2d7cea3a5cfdbcc67478e41f/data/tau2|git_commit|a2c024725189473d2d7cea3a5cfdbcc67478e41f|official data","evaluator|https://github.com/sierra-research/tau2-bench/blob/a2c024725189473d2d7cea3a5cfdbcc67478e41f/src/tau2/metrics/agent_metrics.py|git_commit|a2c024725189473d2d7cea3a5cfdbcc67478e41f|official agent metrics implementation"],"rights":["code|MIT|declared|https://github.com/sierra-research/tau2-bench/blob/a2c024725189473d2d7cea3a5cfdbcc67478e41f/LICENSE","data|not_separately_declared|not_separately_declared|https://github.com/sierra-research/tau2-bench/blob/a2c024725189473d2d7cea3a5cfdbcc67478e41f/README.md","evaluator|MIT|declared|https://github.com/sierra-research/tau2-bench/blob/a2c024725189473d2d7cea3a5cfdbcc67478e41f/LICENSE"],"metrics":["avg_reward|avg_reward|average reward|https://github.com/sierra-research/tau2-bench/blob/a2c024725189473d2d7cea3a5cfdbcc67478e41f/src/tau2/metrics/agent_metrics.py","pass_hat_1|pass^1|mean task pass^1|https://github.com/sierra-research/tau2-bench/blob/a2c024725189473d2d7cea3a5cfdbcc67478e41f/src/tau2/metrics/agent_metrics.py"]},
  "locomo": {"owner":"snap-research","pins":["official_entry|https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/README.MD|git_commit|3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376|official definition","data|https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/data/locomo10.json|git_commit|3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376|official data","evaluator|https://github.com/snap-research/locomo/tree/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/task_eval|git_commit|3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376|official task evaluation directory"],"rights":["code|CC-BY-NC-4.0|declared|https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/LICENSE.txt","data|CC-BY-NC-4.0|declared|https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/LICENSE.txt","evaluator|CC-BY-NC-4.0|declared|https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/LICENSE.txt"],"metrics":["qa_f1|F1|question-answering token F1|https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/task_eval/evaluate_qa.py"]},
  "bfcl": {"owner":"ShishirPatil","pins":["official_entry|https://github.com/ShishirPatil/gorilla/blob/6ea57973c7a6097fd7c5915698c54c17c5b1b6c8/berkeley-function-call-leaderboard/README.md|git_commit|6ea57973c7a6097fd7c5915698c54c17c5b1b6c8|official BFCL definition","data|https://github.com/ShishirPatil/gorilla/tree/6ea57973c7a6097fd7c5915698c54c17c5b1b6c8/berkeley-function-call-leaderboard/bfcl_eval/data|git_commit|6ea57973c7a6097fd7c5915698c54c17c5b1b6c8|BFCL data","evaluator|https://github.com/ShishirPatil/gorilla/tree/6ea57973c7a6097fd7c5915698c54c17c5b1b6c8/berkeley-function-call-leaderboard/bfcl_eval|git_commit|6ea57973c7a6097fd7c5915698c54c17c5b1b6c8|BFCL evaluator"],"rights":["code|Apache-2.0|declared|https://github.com/ShishirPatil/gorilla/blob/6ea57973c7a6097fd7c5915698c54c17c5b1b6c8/LICENSE","data|Apache-2.0|declared|https://github.com/ShishirPatil/gorilla/blob/6ea57973c7a6097fd7c5915698c54c17c5b1b6c8/berkeley-function-call-leaderboard/README.md","evaluator|Apache-2.0|declared|https://github.com/ShishirPatil/gorilla/blob/6ea57973c7a6097fd7c5915698c54c17c5b1b6c8/LICENSE"],"metrics":["category_accuracy|accuracy|per test_category|https://github.com/ShishirPatil/gorilla/blob/6ea57973c7a6097fd7c5915698c54c17c5b1b6c8/berkeley-function-call-leaderboard/bfcl_eval/eval_checker/eval_runner_helper.py","overall_accuracy|Overall Acc|overall accuracy|https://github.com/ShishirPatil/gorilla/blob/6ea57973c7a6097fd7c5915698c54c17c5b1b6c8/berkeley-function-call-leaderboard/README.md"]},
})


const raw = load('data/evaluation/known-good.json') as Record<string, unknown>
const diagnostic = parseEvaluationFoundation({ registry, ...raw })
assert.equal(diagnostic.cases.length, 1)
assert.equal(diagnostic.run_receipts.length, 1)
assert.equal(diagnostic.run_receipts[0]!.evidence_kind, 'synthetic_fixture')
assert.equal(diagnostic.run_receipts[0]!.pairing, null)
assert.equal(diagnostic.run_receipts[0]!.qualification.official_result, false)
const emptyResolver = { resolve: () => undefined }
assert.deepEqual(deriveMatchedPairs(diagnostic, emptyResolver), [])
for (const item of diagnostic.cases) parseEvalCase(item)
for (const item of diagnostic.run_receipts) parseEvalRunReceipt(item)
for (const item of diagnostic.failure_clusters) parseEvalFailureCluster(item)
for (const item of [...diagnostic.cases, ...diagnostic.run_receipts, ...diagnostic.failure_clusters]) assertPublicArtifactSafe(item, 'repository fixture')

const trek = registry.find(item => item.benchmark_id === 'trek')!
const evalCase = diagnostic.cases[0]!
const observedCase = { ...evalCase, input_ref: { ...evalCase.input_ref, kind: 'external_opaque_reference' as const } }
const seed = diagnostic.run_receipts[0]!
const controls = {
  ...seed.controls,
  case_set_sha256: evaluationFingerprint([observedCase]),
  scorer_sha256: evaluationFingerprint(observedCase.scorer_revision),
  source_fence_sha256: evaluationFingerprint(trek.source_fence),
  official_evaluator_sha256: evaluationFingerprint(trek.provenance.evaluator),
}
const observed = (role: 'baseline' | 'treatment'): EvalRunReceiptV0 => {
 const run = {
  ...seed,
  run_id: `run:trek:${role}-test-only`, evidence_kind: 'observed_external',
  gotry_sha: role === 'baseline' ? '1111111111111111111111111111111111111111' : '2222222222222222222222222222222222222222',
  pairing: { pair_id: 'pair:trek:test-only', role, counterpart_run_id: `run:trek:${role === 'baseline' ? 'treatment' : 'baseline'}-test-only` },
  model: { provider: 'test-provider', model: 'test-model' }, controls,
  qualification: {
    official_result: true, source_fence_passed: true, integrity_passed: true,
    evidence_receipts: { official_evaluator_output_sha256: null, source_fence_audit_sha256: null, integrity_audit_sha256: null },
  },
  experiment: {
    changed_variables: role === 'baseline' ? [] : ['gotry_sha'],
    candidate_sha256: evaluationFingerprint({ treatment_variable: 'gotry_sha', gotry_sha: role === 'baseline' ? '1111111111111111111111111111111111111111' : '2222222222222222222222222222222222222222' }),
  },
  evidence_summary: { ...seed.evidence_summary, fixture_only: false, statement: 'test-only observed-external aggregate admission object' },
 } as EvalRunReceiptV0
 const { evidence_receipts: _receipts, ...qualification } = run.qualification; const bound = { ...run, qualification }
 const base = { schema_version: 'gotry_eval_evidence_artifact_v0', run_id: run.run_id, benchmark_id: run.benchmark_id, case_id: run.case_id, run_binding_sha256: evaluationFingerprint(bound) }
 const artifacts = {
   official_evaluator: { ...base, artifact_kind: 'official_evaluator', evaluator_sha256: run.controls.official_evaluator_sha256, native_metrics_sha256: evaluationFingerprint(run.native_metrics), native_metrics: run.native_metrics, official_result: true },
   source_fence_audit: { ...base, artifact_kind: 'source_fence_audit', source_fence_sha256: run.controls.source_fence_sha256, input_digest_sha256: observedCase.input_ref.digest_sha256, source_fence_passed: true, forbidden_field_hits: 0 },
   integrity_audit: { ...base, artifact_kind: 'integrity_audit', integrity_sha256: run.controls.integrity_sha256, candidate_sha256: run.experiment.candidate_sha256, integrity_passed: true },
 }
 run.qualification.evidence_receipts = { official_evaluator_output_sha256: evaluationFingerprint(artifacts.official_evaluator), source_fence_audit_sha256: evaluationFingerprint(artifacts.source_fence_audit), integrity_audit_sha256: evaluationFingerprint(artifacts.integrity_audit) }
 return run
}
const countable = parseEvaluationFoundation({
  registry, cases: [observedCase], run_receipts: [observed('baseline'), observed('treatment')],
  failure_clusters: [{ ...diagnostic.failure_clusters[0], run_ids: ['run:trek:baseline-test-only', 'run:trek:treatment-test-only'] }],
})
const artifactResolver = { resolve(sha256: string): unknown {
  for (const run of countable.run_receipts) { const { evidence_receipts: _receipts, ...qualification } = run.qualification; const bound = { ...run, qualification }; const base = { schema_version: 'gotry_eval_evidence_artifact_v0', run_id: run.run_id, benchmark_id: run.benchmark_id, case_id: run.case_id, run_binding_sha256: evaluationFingerprint(bound) }; const artifacts = [{ ...base, artifact_kind: 'official_evaluator', evaluator_sha256: run.controls.official_evaluator_sha256, native_metrics_sha256: evaluationFingerprint(run.native_metrics), native_metrics: run.native_metrics, official_result: true }, { ...base, artifact_kind: 'source_fence_audit', source_fence_sha256: run.controls.source_fence_sha256, input_digest_sha256: observedCase.input_ref.digest_sha256, source_fence_passed: true, forbidden_field_hits: 0 }, { ...base, artifact_kind: 'integrity_audit', integrity_sha256: run.controls.integrity_sha256, candidate_sha256: run.experiment.candidate_sha256, integrity_passed: true }]; const found = artifacts.find(item => evaluationFingerprint(item) === sha256); if (found) return found }
  return undefined
} }
const fingerprintMismatchResolver = { resolve(sha256: string): unknown { const artifact = artifactResolver.resolve(sha256) as Record<string, unknown> | undefined; if (!artifact) return undefined; const changed = structuredClone(artifact); if (changed.artifact_kind === 'official_evaluator') changed.official_result = false; return changed } }; assert.throws(() => deriveMatchedPairs(countable, fingerprintMismatchResolver), /fingerprint mismatch/)
const pairs = deriveMatchedPairs(countable, artifactResolver)
assert.deepEqual(pairs, [{
  schema_version: 'gotry_eval_matched_pair_derived_v0', pair_id: 'pair:trek:test-only', benchmark_id: 'trek',
  case_id: 'gotry:foundation:case-001', baseline_run_id: 'run:trek:baseline-test-only',
  treatment_run_id: 'run:trek:treatment-test-only', treatment_variable: 'gotry_sha', matched_pair_countable: true,
}])

// Each adversarial artifact is re-signed and its receipt updated, so deriveMatchedPairs
// reaches the semantic closure under test rather than stopping at the fingerprint gate.
const exerciseArtifact = (runIndex: number, kind: 'official_evaluator'|'source_fence_audit'|'integrity_audit', mutate: (artifact: Record<string, unknown>) => void, expected: RegExp): void => {
  const foundation = structuredClone(countable) as EvaluationFoundationV0
  const run = foundation.run_receipts[runIndex]!
  const receiptKey = kind === 'official_evaluator' ? 'official_evaluator_output_sha256' : kind === 'source_fence_audit' ? 'source_fence_audit_sha256' : 'integrity_audit_sha256'
  const original = artifactResolver.resolve(run.qualification.evidence_receipts[receiptKey]!) as Record<string, unknown>
  const artifact = structuredClone(original); mutate(artifact)
  const digest = evaluationFingerprint(artifact)
  run.qualification.evidence_receipts[receiptKey] = digest
  const resolver = { resolve(sha256: string): unknown { return sha256 === digest ? artifact : artifactResolver.resolve(sha256) } }
  assert.throws(() => deriveMatchedPairs(foundation, resolver), expected)
}
assert.throws(() => deriveMatchedPairs(countable, { resolve: () => undefined }), /artifact/)
exerciseArtifact(0, 'official_evaluator', a => { a.evaluator_sha256 = 'f'.repeat(64) }, /evaluator artifact mismatch/)
exerciseArtifact(0, 'official_evaluator', a => { a.native_metrics = { altered: 1 }; a.native_metrics_sha256 = evaluationFingerprint(a.native_metrics) }, /evaluator artifact mismatch/)
exerciseArtifact(0, 'source_fence_audit', a => { a.input_digest_sha256 = 'f'.repeat(64) }, /source-fence artifact mismatch/)
exerciseArtifact(0, 'source_fence_audit', a => { a.source_fence_passed = false }, /source-fence artifact mismatch/)
exerciseArtifact(0, 'source_fence_audit', a => { a.forbidden_field_hits = 1 }, /source-fence artifact mismatch/)
exerciseArtifact(0, 'integrity_audit', a => { a.candidate_sha256 = 'f'.repeat(64) }, /integrity artifact mismatch/)
exerciseArtifact(0, 'integrity_audit', a => { a.integrity_passed = false }, /integrity artifact mismatch/)
const treatmentReuse = structuredClone(countable) as EvaluationFoundationV0
const baselineReceipt = treatmentReuse.run_receipts[0]!.qualification.evidence_receipts.official_evaluator_output_sha256!
treatmentReuse.run_receipts[1]!.qualification.evidence_receipts.official_evaluator_output_sha256 = baselineReceipt
assert.throws(() => deriveMatchedPairs(treatmentReuse, artifactResolver), /fingerprint mismatch|binding mismatch/)

const canonical1 = stableEvaluationJson(diagnostic)
const canonical2 = stableEvaluationJson(parseEvaluationFoundation(JSON.parse(canonical1)))
const digest1 = createHash('sha256').update(canonical1).digest('hex')
const digest2 = createHash('sha256').update(canonical2).digest('hex')
assert.equal(canonical1, canonical2); assert.equal(digest1, digest2); assert.match(digest1, /^[0-9a-f]{64}$/)

const vectors = parseMutationVectors(load('data/evaluation/known-bad.json'))
assert.equal(vectors.length, 39)
for (const vector of vectors) {
  const base: EvaluationFoundationV0 = vector.foundation_kind === 'countable_test_only' ? countable : diagnostic
  const mutated = applyMutationVector(base, vector)
  assert.throws(() => vector.target === 'foundation' ? deriveMatchedPairs(parseEvaluationFoundation(mutated), vector.foundation_kind === 'countable_test_only' ? artifactResolver : emptyResolver)
    : vector.target === 'registry' ? parseBenchmarkRegistry(mutated)
      : vector.target === 'case' ? parseEvalCase(mutated)
        : vector.target === 'run' ? parseEvalRunReceipt(mutated) : parseEvalFailureCluster(mutated), new RegExp(vector.expected_error), vector.id)
}

const runAll = readFileSync('../scripts/run-all-tests.sh', 'utf8')
assert.match(runAll, /=== 45\. Evaluation Phase 0 foundation/)
assert.match(runAll, /npx tsx scripts\/evaluation-contract-tests\.ts/)
assert.throws(() => deriveMatchedPairs(countable, emptyResolver), /artifact/)
for (const [key, value] of [['apikey', 'secret'], ['access-token', 'secret'], ['apiKey', 'secret'], ['ACCESS-TOKEN', 'secret'], ['client_secret', 'secret'], ['authorization', 'Bearer abcdefghijklmnopqrstuvwxyz123456'], ['value', '/private/file'], ['value', '~/private/file'], ['value', 'C:\\private\\file'], ['value', 'file:///private/file'], ['value', 'sk-abcdefghijklmnopqrstuv'], ['value', 'ghp_abcdefghijklmnopqrstuvwxyz123456'], ['value', 'AKIA1234567890ABCDEF']]) assert.throws(() => assertPublicArtifactSafe({ [key]: value }, 'adversarial'), /absolute path or secret|credentials/)
assert.doesNotThrow(() => assertPublicArtifactSafe({ url: 'https://github.com/org/repo/blob/main/README.md', label: 'question-answering token F1' }, 'benign'))
assert.throws(() => assertPublicArtifactSafe({ value: 'https://example.test/?token=sk-abcdefghijklmnopqrstuv' }, 'https-url-secret'), /absolute path or secret/)
for (const value of ['log=/Users/a/private.json', 'C:\\Users\\a\\secret', 'file:///tmp/x', '~/x', 'https://github.com/org/repo log=/Users/a/x', 'Bearer abcdefghijklmnopqrstuvwxyz123456', 'sk-abcdefghijklmnopqrstuv', 'ghp_abcdefghijklmnopqrstuvwxyz123456', 'AKIA1234567890ABCDEF']) assert.throws(() => assertPublicArtifactSafe({ value }, 'path-or-secret'), /absolute path or secret/)
assert.doesNotThrow(() => assertPublicArtifactSafe({ github: 'https://github.com/org/repo', huggingface: 'https://huggingface.co/datasets/org/name' }, 'public urls'))
for (const key of ['source_fence_passed', 'integrity_passed']) {
  const syntheticFlags = JSON.parse(JSON.stringify(load('data/evaluation/known-good.json'))) as Record<string, unknown>
  const run = (syntheticFlags.run_receipts as Record<string, unknown>[])[0]
  const qualification = run.qualification as Record<string, unknown>
  qualification[key] = true
  assert.equal(qualification[key === 'source_fence_passed' ? 'integrity_passed' : 'source_fence_passed'], false)
  assert.throws(() => parseEvalRunReceipt(run), /synthetic fixture/)
}
console.log(`canonical sha256: ${digest1}`)
console.log(`evaluation-contract tests: ${registry.length} registry, ${pairs.length} test-only matched pair, ${vectors.length} negative vectors green`)
