# GoTry Evaluation Phase 0 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Sol supplies the disk brief and reviews; exactly one Luna writer executes this one Task in the worktree with `fork_turns=none`.

**Goal:** Add deterministic TypeScript contracts for seven benchmark metadata records, safe cases, diagnostic run receipts, aggregate-only matched-pair admission, and failure clusters without an adapter, external runner, Python runtime dependency, baseline/result claim, or Agent uplift claim.

**Architecture:** One strict TypeScript module owns the four v0 parsers, canonical fingerprints, structured public-safety traversal, graph closure, and aggregate matching. Repository fixtures are synthetic, unmatched, unqualified, and diagnostic-only. The countable positive path exists only as an in-memory test object marked `observed_external`; it is admitted only when registry/case-derived fingerprints, evidence receipts, model identity, native metric keys, and all pair controls close.

**Tech Stack:** Node.js 22/24, TypeScript 5.6 strict NodeNext ESM, `tsx`, `node:assert/strict`, JSON, Bash.

**Spec:** `docs/superpowers/specs/2026-08-30-gotry-multi-benchmark-evaluation-program-design.md`

## Scope and execution precondition

- Phase 0 only: no adapter, benchmark/evaluator execution, external runner, Python bridge/dependency, upstream payload, baseline, production result, Agent change, LoopX write, or uplift claim.
- One Luna writer, one worktree, one vertical-slice commit, one later PR. Steps 1–7 prohibit commits so all six §11 state surfaces move atomically.
- The approved spec and this plan must be present in the execution base, and the worktree must be clean:

```bash
PHASE0_BASE_SHA="$(git rev-parse HEAD)"
printf 'execution-base=%s\n' "$PHASE0_BASE_SHA"
git cat-file -e "$PHASE0_BASE_SHA:docs/superpowers/specs/2026-08-30-gotry-multi-benchmark-evaluation-program-design.md"
git cat-file -e "$PHASE0_BASE_SHA:docs/superpowers/plans/2026-08-31-gotry-evaluation-phase0-foundation.md"
test -z "$(git status --porcelain=v1)"
test "$(git branch --show-current)" != main
```

Expected: every check exits `0`; the printed SHA is the clean base containing both documents. This value is informational and is not exported for later steps.

## Files and interfaces

| File | Responsibility |
|---|---|
| `ts/src/evaluation-contracts.ts` | Four v0 parsers, `evaluationFingerprint`, public-safety traversal, closure, aggregate matching |
| `ts/data/evaluation/benchmark-registry.json` | Seven independently pinned metadata records |
| `ts/data/evaluation/known-good.json` | One unmatched synthetic diagnostic case/run/failure graph |
| `ts/data/evaluation/known-bad.json` | Inert mutation instructions; never a publishable artifact |
| `ts/scripts/evaluation-contract-tests.ts` | Positive test-only aggregate, negative vectors, determinism, integration checks |
| `scripts/run-all-tests.sh` | Offline §45 gate |
| `docs/evaluation-foundation.md` | Ownership/admission/non-result guide |
| `docs/architecture.md` | §1/§9/§10 state plus §12 map |
| `docs/roadmap.md`, `README.md`, `docs/stage1-top-down-design.md` | Remaining three state surfaces |

Exports: `BENCHMARK_IDS`, `parseBenchmarkRegistry`, `parseEvalCase`, `parseEvalRunReceipt`, `parseEvalFailureCluster`, `parseEvaluationFoundation`, `deriveMatchedPairs`, `assertPublicArtifactSafe`, `evaluationFingerprint`, `stableEvaluationJson`, `parseMutationVectors`, `applyMutationVector`.

---

### Task 1: Deliver the complete Phase 0 vertical slice

**Files:** create the six evaluation files and guide above; modify `scripts/run-all-tests.sh`, `docs/architecture.md`, `docs/roadmap.md`, `README.md`, and `docs/stage1-top-down-design.md`.

- [ ] **Step 1: Write the complete failing contract suite and prove RED**

Create `ts/scripts/evaluation-contract-tests.ts` exactly:

```ts
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
assert.deepEqual(deriveMatchedPairs(diagnostic), [])
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
const observed = (role: 'baseline' | 'treatment'): EvalRunReceiptV0 => ({
  ...seed,
  run_id: `run:trek:${role}-test-only`, evidence_kind: 'observed_external',
  gotry_sha: role === 'baseline' ? '1111111111111111111111111111111111111111' : '2222222222222222222222222222222222222222',
  pairing: { pair_id: 'pair:trek:test-only', role, counterpart_run_id: `run:trek:${role === 'baseline' ? 'treatment' : 'baseline'}-test-only` },
  model: { provider: 'test-provider', model: 'test-model' }, controls,
  qualification: {
    official_result: true, source_fence_passed: true, integrity_passed: true,
    evidence_receipts: {
      official_evaluator_output_sha256: '9999999999999999999999999999999999999999999999999999999999999999',
      source_fence_audit_sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      integrity_audit_sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  experiment: {
    changed_variables: role === 'baseline' ? [] : ['gotry_sha'],
    candidate_sha256: evaluationFingerprint({ treatment_variable: 'gotry_sha', gotry_sha: role === 'baseline' ? '1111111111111111111111111111111111111111' : '2222222222222222222222222222222222222222' }),
  },
  evidence_summary: { ...seed.evidence_summary, fixture_only: false, statement: 'test-only observed-external aggregate admission object' },
})
const countable = parseEvaluationFoundation({
  registry, cases: [observedCase], run_receipts: [observed('baseline'), observed('treatment')],
  failure_clusters: [{ ...diagnostic.failure_clusters[0], run_ids: ['run:trek:baseline-test-only', 'run:trek:treatment-test-only'] }],
})
const pairs = deriveMatchedPairs(countable)
assert.deepEqual(pairs, [{
  schema_version: 'gotry_eval_matched_pair_derived_v0', pair_id: 'pair:trek:test-only', benchmark_id: 'trek',
  case_id: 'gotry:foundation:case-001', baseline_run_id: 'run:trek:baseline-test-only',
  treatment_run_id: 'run:trek:treatment-test-only', treatment_variable: 'gotry_sha', matched_pair_countable: true,
}])

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
  assert.throws(() => vector.target === 'foundation' ? deriveMatchedPairs(parseEvaluationFoundation(mutated))
    : vector.target === 'registry' ? parseBenchmarkRegistry(mutated)
      : vector.target === 'case' ? parseEvalCase(mutated)
        : vector.target === 'run' ? parseEvalRunReceipt(mutated) : parseEvalFailureCluster(mutated), new RegExp(vector.expected_error), vector.id)
}

const runAll = readFileSync('../scripts/run-all-tests.sh', 'utf8')
assert.match(runAll, /=== 45\. Evaluation Phase 0 foundation/)
assert.match(runAll, /npx tsx scripts\/evaluation-contract-tests\.ts/)
console.log(`canonical sha256: ${digest1}`)
console.log(`evaluation-contract tests: ${registry.length} registry, ${pairs.length} test-only matched pair, ${vectors.length} negative vectors green`)
```

Run: `cd ts && npx tsx scripts/evaluation-contract-tests.ts`

Expected: exit `1` with `ERR_MODULE_NOT_FOUND` naming `ts/src/evaluation-contracts.ts`. Do not commit.

- [ ] **Step 2: Implement the contracts, strict parsers, structured safety, closure, and aggregate derivation**

Create `ts/src/evaluation-contracts.ts` by concatenating the next four blocks in order.

```ts
import { createHash } from 'node:crypto'

export const BENCHMARK_IDS = ['trek', 'travelplanner', 'chinatravel', 'travelbench', 'tau2', 'locomo', 'bfcl'] as const
export type BenchmarkId = typeof BENCHMARK_IDS[number]
type RevisionKind = 'git_commit' | 'content_sha256' | 'not_separately_declared'
export interface RevisionV0 { kind: RevisionKind; value: string | null }
export interface ProvenancePinV0 { url: string; revision: RevisionV0; source_scope: string }
export interface NativeMetricV0 { receipt_key: string; upstream_label: string; scope: string; source_url: string }
export interface LicenseDeterminationV0 { value: string; determination: 'declared' | 'not_separately_declared'; source_url: string }
export interface BenchmarkRegistryEntryV0 {
  schema_version: 'gotry_benchmark_registry_entry_v0'; benchmark_id: BenchmarkId
  provenance: { official_entry: ProvenancePinV0; data: ProvenancePinV0; evaluator: ProvenancePinV0 }
  license: { upstream_rights: { code: LicenseDeterminationV0; data: LicenseDeterminationV0; evaluator: LicenseDeterminationV0 }; repo_storage_policy: 'metadata_only_no_upstream_payload' }
  task_scopes: string[]; native_metrics: { status: 'declared'; values: NativeMetricV0[] } | { status: 'not_separately_declared'; values: [] }
  source_fence: { solver_allowed_field_classes: string[]; solver_forbidden_field_classes: string[] }
  countability_default: 'countable_if_qualified' | 'diagnostic_only'
}
export interface EvalCaseV0 {
  schema_version: 'gotry_eval_case_v0'; case_id: string; benchmark_id: BenchmarkId
  input_ref: { kind: 'gotry_owned_synthetic' | 'external_opaque_reference'; revision: RevisionV0; digest_sha256: string }
  isolation: { state_root: 'ephemeral'; network: 'denied' | 'benchmark_declared'; writes: 'forbidden' }
  clock: { now: string; timezone: string }; allowed_effects: string[]; forbidden_effects: string[]
  budget: { max_seconds: number; max_cost_usd: number; max_tool_calls: number; max_turns: number }
  scorer_revision: RevisionV0
  public_safety: { contains_third_party_prompt: false; contains_gold: false; contains_oracle: false; contains_private_data: false }
}
export interface EvalRunReceiptV0 {
  schema_version: 'gotry_eval_run_receipt_v0'; run_id: string; benchmark_id: BenchmarkId; case_id: string
  evidence_kind: 'synthetic_fixture' | 'observed_external'
  pairing: null | { pair_id: string; role: 'baseline' | 'treatment'; counterpart_run_id: string }
  status: 'running' | 'succeeded' | 'failed' | 'blocked'; started_at: string; finished_at: string | null; gotry_sha: string
  model: { provider: string; model: string }
  controls: { case_set_sha256: string; protocol_control_sha256: string; model_parameters_sha256: string; scorer_sha256: string; tool_snapshot_sha256: string; source_fence_sha256: string; integrity_sha256: string; official_evaluator_sha256: string }
  qualification: { official_result: boolean; source_fence_passed: boolean; integrity_passed: boolean; evidence_receipts: { official_evaluator_output_sha256: string | null; source_fence_audit_sha256: string | null; integrity_audit_sha256: string | null } }
  experiment: { changed_variables: string[]; candidate_sha256: string }; native_metrics: Record<string, number>
  guardrails: { hard_violation_count: number; forbidden_leakage_hits: number; latency_ms: number; cost_usd: number; tool_calls: number; turns: number }
  evidence_summary: { artifact_classification: 'public_safe'; sha256: string[]; counts: Record<string, number>; reason_codes: string[]; fixture_only: boolean; statement: string }
}
export const FAILURE_CATEGORIES = ['schema_or_format','grounding_or_provenance','constraint_or_feasibility','time_or_location_continuity','cost_or_cardinality','tool_selection_or_arguments','policy_or_write_safety','preference_elicitation','memory_retrieval_or_temporal_reasoning','reliability_cost_or_latency'] as const
export interface EvalFailureClusterV0 { schema_version: 'gotry_eval_failure_cluster_v0'; cluster_id: string; category: typeof FAILURE_CATEGORIES[number]; severity: 'P0'|'P1'|'P2'|'P3'; benchmark_ids: BenchmarkId[]; case_ids: string[]; run_ids: string[]; reproduction: { condition: string; minimum_repetitions: number; observed_repetitions: number }; falsifiable_hypothesis: string; gotry_regression_id: string; suggested_surface: 'agent'|'tool_policy'|'deterministic'|'evaluation'; state: 'observed'|'confirmed'|'resolved'|'rejected' }
export interface EvaluationFoundationV0 { registry: BenchmarkRegistryEntryV0[]; cases: EvalCaseV0[]; run_receipts: EvalRunReceiptV0[]; failure_clusters: EvalFailureClusterV0[] }
export interface DerivedMatchedPairV0 { schema_version: 'gotry_eval_matched_pair_derived_v0'; pair_id: string; benchmark_id: BenchmarkId; case_id: string; baseline_run_id: string; treatment_run_id: string; treatment_variable: string; matched_pair_countable: true }
type MutationValueKind = 'literal'|'synthetic_absolute_path'|'nan'|'duplicate_treatment_receipt'
export interface MutationVectorV0 { id: string; foundation_kind: 'diagnostic_repository'|'countable_test_only'; target: 'registry'|'case'|'run'|'failure'|'foundation'; operation: 'replace'|'remove'|'append'; path: string; value_kind: MutationValueKind; value?: unknown; expected_error: string }
```

```ts
function obj(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`); return value as Record<string, unknown> }
function exact(value: Record<string, unknown>, label: string, keys: readonly string[]): void { const unknown = Object.keys(value).filter(key => !keys.includes(key)); const missing = keys.filter(key => !(key in value)); if (unknown.length) throw new Error(`${label} contains undeclared fields: ${unknown.join(',')}`); if (missing.length) throw new Error(`${label} missing fields: ${missing.join(',')}`) }
function text(value: unknown, label: string): string { if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be non-empty text`); return value }
function id(value: unknown, label: string): string { const out = text(value, label); if (!/^[a-z0-9][a-z0-9:._-]+$/.test(out)) throw new Error(`${label} must be a stable identifier`); return out }
function lit<T extends string>(value: unknown, label: string, values: readonly T[]): T { const out = text(value, label); if (!values.includes(out as T)) throw new Error(`${label} invalid literal`); return out as T }
function boolean(value: unknown, label: string): boolean { if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`); return value }
function finite(value: unknown, label: string, min = 0): number { if (typeof value !== 'number' || !Number.isFinite(value) || value < min) throw new Error(`${label} must be a finite number >= ${min}`); return value }
function integer(value: unknown, label: string, min = 0): number { const out = finite(value, label, min); if (!Number.isInteger(out)) throw new Error(`${label} must be an integer`); return out }
function strings(value: unknown, label: string, empty = false): string[] { if (!Array.isArray(value) || (!empty && value.length === 0)) throw new Error(`${label} must be an array`); const out = value.map((item, index) => text(item, `${label}[${index}]`)); if (new Set(out).size !== out.length) throw new Error(`${label} must be unique`); return out }
function digest(value: unknown, label: string): string { const out = text(value, label); if (!/^[0-9a-f]{64}$/.test(out)) throw new Error(`${label} must be lowercase SHA-256`); return out }
function commit(value: unknown, label: string): string { const out = text(value, label); if (!/^[0-9a-f]{40}$/.test(out)) throw new Error(`${label} must be a lowercase 40-character Git commit`); return out }
function url(value: unknown, label: string): string { const out = text(value, label); let parsed: URL; try { parsed = new URL(out) } catch { throw new Error(`${label} must be a valid URL`) }; if (parsed.protocol !== 'https:') throw new Error(`${label} must use https`); if (parsed.username || parsed.password) throw new Error(`${label} must not contain credentials`); return out }
function instant(value: unknown, label: string): string { const out = text(value, label); const date = new Date(out); if (!Number.isFinite(date.valueOf()) || date.toISOString() !== out) throw new Error(`${label} must be canonical ISO UTC with milliseconds`); return out }
function zone(value: unknown, label: string): string { const out = text(value, label); if (out === 'UTC') return out; try { new Intl.DateTimeFormat('en', { timeZone: out }).format(new Date(0)) } catch { throw new Error(`${label} must be UTC or an IANA timezone`) }; if (!out.includes('/')) throw new Error(`${label} must be UTC or an IANA timezone`); return out }
function revision(value: unknown, label: string): RevisionV0 { const root = obj(value, label); exact(root, label, ['kind','value']); const kind = lit(root.kind, `${label}.kind`, ['git_commit','content_sha256','not_separately_declared']); if (kind === 'not_separately_declared') { if (root.value !== null) throw new Error(`${label}.value must be null`); return { kind, value: null } }; return { kind, value: kind === 'git_commit' ? commit(root.value, `${label}.value`) : digest(root.value, `${label}.value`) } }
function pin(value: unknown, label: string): ProvenancePinV0 { const root = obj(value, label); exact(root, label, ['url','revision','source_scope']); return { url: url(root.url, `${label}.url`), revision: revision(root.revision, `${label}.revision`), source_scope: text(root.source_scope, `${label}.source_scope`) } }
function licenseDetermination(value: unknown, label: string): LicenseDeterminationV0 { const root=obj(value,label); exact(root,label,['value','determination','source_url']); const determination=lit(root.determination,`${label}.determination`,['declared','not_separately_declared']); const resolved=text(root.value,`${label}.value`); if(determination==='not_separately_declared'&&resolved!=='not_separately_declared') throw new Error(`${label}.value must be not_separately_declared`); return {value:resolved,determination,source_url:url(root.source_url,`${label}.source_url`)} }
export function stableEvaluationJson(value: unknown): string { const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort) : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a],[b]) => a.localeCompare(b)).map(([key, child]) => [key, sort(child)])) : item; return `${JSON.stringify(sort(value), null, 2)}\n` }
export function evaluationFingerprint(value: unknown): string { return createHash('sha256').update(stableEvaluationJson(value)).digest('hex') }

const credentialKeys = new Set(['api_key','access_token','refresh_token','password','credential','credentials','authorization','cookie'])
const rawKeys = new Set(['raw_prompt','raw_answer','gold_answer','oracle_payload','private_payload','secret_payload','trajectory_payload'])
export function assertPublicArtifactSafe(value: unknown, label = 'artifact'): void {
  const walk = (item: unknown, path: string): void => {
    if (Array.isArray(item)) return item.forEach((child, index) => walk(child, `${path}[${index}]`))
    if (typeof item === 'string') { if (item.startsWith('/') || /^[A-Za-z]:[\\/]/.test(item) || item.startsWith('file://')) throw new Error(`${path} contains an absolute path`); return }
    if (!item || typeof item !== 'object') return
    for (const [key, child] of Object.entries(item)) { if (credentialKeys.has(key) && child !== '' && child !== null) throw new Error(`${path}.${key} contains credentials`); if (rawKeys.has(key) && child !== '' && child !== null) throw new Error(`${path}.${key} contains raw sensitive payload`); walk(child, `${path}.${key}`) }
  }
  walk(value, label)
}

function registryEntry(value: unknown, label: string): BenchmarkRegistryEntryV0 {
  const root = obj(value, label); exact(root, label, ['schema_version','benchmark_id','provenance','license','task_scopes','native_metrics','source_fence','countability_default'])
  const provenance = obj(root.provenance, `${label}.provenance`); exact(provenance, `${label}.provenance`, ['official_entry','data','evaluator'])
  const license = obj(root.license, `${label}.license`); exact(license, `${label}.license`, ['upstream_rights','repo_storage_policy']); const rights = obj(license.upstream_rights, `${label}.license.upstream_rights`); exact(rights, `${label}.license.upstream_rights`, ['code','data','evaluator'])
  const metrics = obj(root.native_metrics, `${label}.native_metrics`); exact(metrics, `${label}.native_metrics`, ['status','values']); if (!Array.isArray(metrics.values)) throw new Error(`${label}.native_metrics.values must be an array`)
  const status = lit(metrics.status, `${label}.native_metrics.status`, ['declared','not_separately_declared'])
  const values = metrics.values.map((raw, index) => { const metric = obj(raw, `${label}.metric[${index}]`); exact(metric, `${label}.metric[${index}]`, ['receipt_key','upstream_label','scope','source_url']); return { receipt_key: id(metric.receipt_key, `${label}.metric.receipt_key`), upstream_label: text(metric.upstream_label, `${label}.metric.upstream_label`), scope: text(metric.scope, `${label}.metric.scope`), source_url: url(metric.source_url, `${label}.metric.source_url`) } })
  if (status === 'declared' && values.length === 0) throw new Error(`${label} declared metrics must be non-empty`); if (status === 'not_separately_declared' && values.length !== 0) throw new Error(`${label} undeclared metrics must be empty`)
  const fence = obj(root.source_fence, `${label}.source_fence`); exact(fence, `${label}.source_fence`, ['solver_allowed_field_classes','solver_forbidden_field_classes'])
  return { schema_version: lit(root.schema_version, `${label}.schema_version`, ['gotry_benchmark_registry_entry_v0']), benchmark_id: lit(root.benchmark_id, `${label}.benchmark_id`, BENCHMARK_IDS), provenance: { official_entry: pin(provenance.official_entry, `${label}.official_entry`), data: pin(provenance.data, `${label}.data`), evaluator: pin(provenance.evaluator, `${label}.evaluator`) }, license: { upstream_rights: { code: licenseDetermination(rights.code, `${label}.rights.code`), data: licenseDetermination(rights.data, `${label}.rights.data`), evaluator: licenseDetermination(rights.evaluator, `${label}.rights.evaluator`) }, repo_storage_policy: lit(license.repo_storage_policy, `${label}.storage`, ['metadata_only_no_upstream_payload']) }, task_scopes: strings(root.task_scopes, `${label}.task_scopes`), native_metrics: status === 'declared' ? { status, values } : { status, values: [] }, source_fence: { solver_allowed_field_classes: strings(fence.solver_allowed_field_classes, `${label}.allowed`), solver_forbidden_field_classes: strings(fence.solver_forbidden_field_classes, `${label}.forbidden`) }, countability_default: lit(root.countability_default, `${label}.countability_default`, ['countable_if_qualified','diagnostic_only']) }
}
export function parseBenchmarkRegistry(value: unknown): BenchmarkRegistryEntryV0[] { if (!Array.isArray(value) || value.length !== 7) throw new Error('registry must contain exactly seven entries'); const out = value.map((item,index) => registryEntry(item, `registry[${index}]`)); if (out.some((item,index) => item.benchmark_id !== BENCHMARK_IDS[index])) throw new Error('registry must use canonical unique order'); return out }
```

```ts
export function parseEvalCase(value: unknown): EvalCaseV0 {
  const root = obj(value, 'case'); exact(root, 'case', ['schema_version','case_id','benchmark_id','input_ref','isolation','clock','allowed_effects','forbidden_effects','budget','scorer_revision','public_safety'])
  const input = obj(root.input_ref, 'case.input_ref'); exact(input, 'case.input_ref', ['kind','revision','digest_sha256']); const isolation = obj(root.isolation, 'case.isolation'); exact(isolation, 'case.isolation', ['state_root','network','writes']); const clock = obj(root.clock, 'case.clock'); exact(clock, 'case.clock', ['now','timezone']); const budget = obj(root.budget, 'case.budget'); exact(budget, 'case.budget', ['max_seconds','max_cost_usd','max_tool_calls','max_turns']); const safety = obj(root.public_safety, 'case.public_safety'); exact(safety, 'case.public_safety', ['contains_third_party_prompt','contains_gold','contains_oracle','contains_private_data'])
  for (const [key, flag] of Object.entries(safety)) if (boolean(flag, `case.public_safety.${key}`) !== false) throw new Error(`case.public_safety.${key} must be false`)
  const out: EvalCaseV0 = { schema_version: lit(root.schema_version, 'case.schema_version', ['gotry_eval_case_v0']), case_id: id(root.case_id, 'case.case_id'), benchmark_id: lit(root.benchmark_id, 'case.benchmark_id', BENCHMARK_IDS), input_ref: { kind: lit(input.kind, 'case.input_ref.kind', ['gotry_owned_synthetic','external_opaque_reference']), revision: revision(input.revision, 'case.input_ref.revision'), digest_sha256: digest(input.digest_sha256, 'case.input_ref.digest_sha256') }, isolation: { state_root: lit(isolation.state_root, 'case.state_root', ['ephemeral']), network: lit(isolation.network, 'case.network', ['denied','benchmark_declared']), writes: lit(isolation.writes, 'case.writes', ['forbidden']) }, clock: { now: instant(clock.now, 'case.clock.now'), timezone: zone(clock.timezone, 'case.clock.timezone') }, allowed_effects: strings(root.allowed_effects, 'case.allowed_effects', true), forbidden_effects: strings(root.forbidden_effects, 'case.forbidden_effects'), budget: { max_seconds: finite(budget.max_seconds, 'case.max_seconds'), max_cost_usd: finite(budget.max_cost_usd, 'case.max_cost_usd'), max_tool_calls: integer(budget.max_tool_calls, 'case.max_tool_calls'), max_turns: integer(budget.max_turns, 'case.max_turns') }, scorer_revision: revision(root.scorer_revision, 'case.scorer_revision'), public_safety: { contains_third_party_prompt:false, contains_gold:false, contains_oracle:false, contains_private_data:false } }
  assertPublicArtifactSafe(out, 'case'); return out
}

function optionalDigest(value: unknown, label: string): string | null { return value === null ? null : digest(value, label) }
// The only schema-free object maps are native_metrics and evidence counts. Their leaves are numeric;
// native_metrics keys close exactly to registry receipt_key values in parseEvaluationFoundation.
function numberMap(value: unknown, label: string, integers = false): Record<string, number> { const root = obj(value, label); return Object.fromEntries(Object.entries(root).map(([key,item]) => [id(key, `${label}.key`), integers ? integer(item, `${label}.${key}`) : finite(item, `${label}.${key}`, Number.NEGATIVE_INFINITY)])) }
export function parseEvalRunReceipt(value: unknown): EvalRunReceiptV0 {
  const root = obj(value, 'run'); exact(root, 'run', ['schema_version','run_id','benchmark_id','case_id','evidence_kind','pairing','status','started_at','finished_at','gotry_sha','model','controls','qualification','experiment','native_metrics','guardrails','evidence_summary'])
  const model = obj(root.model, 'run.model'); exact(model, 'run.model', ['provider','model']); const controls = obj(root.controls, 'run.controls'); const controlKeys = ['case_set_sha256','protocol_control_sha256','model_parameters_sha256','scorer_sha256','tool_snapshot_sha256','source_fence_sha256','integrity_sha256','official_evaluator_sha256'] as const; exact(controls, 'run.controls', controlKeys)
  const qualification = obj(root.qualification, 'run.qualification'); exact(qualification, 'run.qualification', ['official_result','source_fence_passed','integrity_passed','evidence_receipts']); const receipts = obj(qualification.evidence_receipts, 'run.qualification.evidence_receipts'); exact(receipts, 'run.qualification.evidence_receipts', ['official_evaluator_output_sha256','source_fence_audit_sha256','integrity_audit_sha256'])
  const experiment = obj(root.experiment, 'run.experiment'); exact(experiment, 'run.experiment', ['changed_variables','candidate_sha256']); const guard = obj(root.guardrails, 'run.guardrails'); exact(guard, 'run.guardrails', ['hard_violation_count','forbidden_leakage_hits','latency_ms','cost_usd','tool_calls','turns']); const summary = obj(root.evidence_summary, 'run.evidence_summary'); exact(summary, 'run.evidence_summary', ['artifact_classification','sha256','counts','reason_codes','fixture_only','statement'])
  let pairing: EvalRunReceiptV0['pairing'] = null; if (root.pairing !== null) { const item = obj(root.pairing, 'run.pairing'); exact(item, 'run.pairing', ['pair_id','role','counterpart_run_id']); pairing = { pair_id:id(item.pair_id,'run.pair_id'), role:lit(item.role,'run.role',['baseline','treatment']), counterpart_run_id:id(item.counterpart_run_id,'run.counterpart') } }
  const evidence_kind = lit(root.evidence_kind, 'run.evidence_kind', ['synthetic_fixture','observed_external']); const status = lit(root.status, 'run.status', ['running','succeeded','failed','blocked']); const finished_at = root.finished_at === null ? null : instant(root.finished_at, 'run.finished_at'); if ((status === 'running') !== (finished_at === null)) throw new Error('run.finished_at must be null only while running')
  const out: EvalRunReceiptV0 = { schema_version:lit(root.schema_version,'run.schema_version',['gotry_eval_run_receipt_v0']), run_id:id(root.run_id,'run.run_id'), benchmark_id:lit(root.benchmark_id,'run.benchmark_id',BENCHMARK_IDS), case_id:id(root.case_id,'run.case_id'), evidence_kind, pairing, status, started_at:instant(root.started_at,'run.started_at'), finished_at, gotry_sha:commit(root.gotry_sha,'run.gotry_sha'), model:{provider:text(model.provider,'run.provider'),model:text(model.model,'run.model')}, controls:Object.fromEntries(controlKeys.map(key => [key,digest(controls[key],`run.controls.${key}`)])) as EvalRunReceiptV0['controls'], qualification:{official_result:boolean(qualification.official_result,'run.official_result'),source_fence_passed:boolean(qualification.source_fence_passed,'run.source_fence_passed'),integrity_passed:boolean(qualification.integrity_passed,'run.integrity_passed'),evidence_receipts:{official_evaluator_output_sha256:optionalDigest(receipts.official_evaluator_output_sha256,'run.evaluator_receipt'),source_fence_audit_sha256:optionalDigest(receipts.source_fence_audit_sha256,'run.fence_receipt'),integrity_audit_sha256:optionalDigest(receipts.integrity_audit_sha256,'run.integrity_receipt')}}, experiment:{changed_variables:strings(experiment.changed_variables,'run.changed_variables',true),candidate_sha256:digest(experiment.candidate_sha256,'run.candidate')}, native_metrics:numberMap(root.native_metrics,'run.native_metrics'), guardrails:{hard_violation_count:integer(guard.hard_violation_count,'run.hard'),forbidden_leakage_hits:integer(guard.forbidden_leakage_hits,'run.leakage'),latency_ms:finite(guard.latency_ms,'run.latency'),cost_usd:finite(guard.cost_usd,'run.cost'),tool_calls:integer(guard.tool_calls,'run.tools'),turns:integer(guard.turns,'run.turns')}, evidence_summary:{artifact_classification:lit(summary.artifact_classification,'run.classification',['public_safe']),sha256:strings(summary.sha256,'run.sha256',true).map((item,index)=>digest(item,`run.sha256[${index}]`)),counts:numberMap(summary.counts,'run.counts',true),reason_codes:strings(summary.reason_codes,'run.reason_codes',true),fixture_only:boolean(summary.fixture_only,'run.fixture_only'),statement:text(summary.statement,'run.statement')} }
  if(out.finished_at!==null&&new Date(out.finished_at).valueOf()<new Date(out.started_at).valueOf()) throw new Error('run.finished_at must not precede started_at')
  if (evidence_kind === 'synthetic_fixture' && (pairing !== null || out.qualification.official_result || Object.values(out.qualification.evidence_receipts).some(Boolean) || !out.evidence_summary.fixture_only)) throw new Error('synthetic fixture must be unmatched, unqualified, receipt-free, and fixture-only')
  if (evidence_kind === 'observed_external' && out.evidence_summary.fixture_only) throw new Error('observed_external receipt must set fixture_only=false')
  assertPublicArtifactSafe(out, 'run'); return out
}

export function parseEvalFailureCluster(value: unknown): EvalFailureClusterV0 { const root=obj(value,'failure'); exact(root,'failure',['schema_version','cluster_id','category','severity','benchmark_ids','case_ids','run_ids','reproduction','falsifiable_hypothesis','gotry_regression_id','suggested_surface','state']); const reproduction=obj(root.reproduction,'failure.reproduction'); exact(reproduction,'failure.reproduction',['condition','minimum_repetitions','observed_repetitions']); const out:EvalFailureClusterV0={schema_version:lit(root.schema_version,'failure.schema_version',['gotry_eval_failure_cluster_v0']),cluster_id:id(root.cluster_id,'failure.cluster_id'),category:lit(root.category,'failure.category',FAILURE_CATEGORIES),severity:lit(root.severity,'failure.severity',['P0','P1','P2','P3']),benchmark_ids:strings(root.benchmark_ids,'failure.benchmark_ids').map(item=>lit(item,'failure.benchmark',BENCHMARK_IDS)),case_ids:strings(root.case_ids,'failure.case_ids'),run_ids:strings(root.run_ids,'failure.run_ids'),reproduction:{condition:text(reproduction.condition,'failure.condition'),minimum_repetitions:integer(reproduction.minimum_repetitions,'failure.minimum',1),observed_repetitions:integer(reproduction.observed_repetitions,'failure.observed')},falsifiable_hypothesis:text(root.falsifiable_hypothesis,'failure.hypothesis'),gotry_regression_id:id(root.gotry_regression_id,'failure.regression'),suggested_surface:lit(root.suggested_surface,'failure.surface',['agent','tool_policy','deterministic','evaluation']),state:lit(root.state,'failure.state',['observed','confirmed','resolved','rejected'])}; if(out.state==='confirmed'&&out.reproduction.observed_repetitions<out.reproduction.minimum_repetitions) throw new Error('confirmed failure lacks repetitions'); assertPublicArtifactSafe(out,'failure'); return out }
```

```ts
export function parseEvaluationFoundation(value: unknown): EvaluationFoundationV0 {
  const root=obj(value,'foundation'); exact(root,'foundation',['registry','cases','run_receipts','failure_clusters']); const registry=parseBenchmarkRegistry(root.registry); if(!Array.isArray(root.cases)||!Array.isArray(root.run_receipts)||!Array.isArray(root.failure_clusters)) throw new Error('foundation collections must be arrays'); const cases=root.cases.map(parseEvalCase), runs=root.run_receipts.map(parseEvalRunReceipt), failures=root.failure_clusters.map(parseEvalFailureCluster)
  const unique=(values:string[],label:string):void=>{if(new Set(values).size!==values.length) throw new Error(`${label} ids must be unique`)}; unique(cases.map(item=>item.case_id),'case'); unique(runs.map(item=>item.run_id),'run'); unique(failures.map(item=>item.cluster_id),'failure')
  const caseById=new Map(cases.map(item=>[item.case_id,item])), runById=new Map(runs.map(item=>[item.run_id,item])), registryById=new Map(registry.map(item=>[item.benchmark_id,item]))
  for(const run of runs){const linked=caseById.get(run.case_id), entry=registryById.get(run.benchmark_id); if(!linked||linked.benchmark_id!==run.benchmark_id||!entry) throw new Error(`run ${run.run_id} must close to case and registry`); const metricKeys=Object.keys(run.native_metrics).sort(), declared=entry.native_metrics.values.map(metric=>metric.receipt_key).sort(); if(JSON.stringify(metricKeys)!==JSON.stringify(declared)) throw new Error(`run ${run.run_id} metric keys must equal registry receipt keys`)}
  for(const failure of failures){const linkedCases=failure.case_ids.map(key=>caseById.get(key)), linkedRuns=failure.run_ids.map(key=>runById.get(key)); if(linkedCases.some(item=>!item)||linkedRuns.some(item=>!item)) throw new Error(`failure ${failure.cluster_id} has unclosed links`); const actual=new Set([...linkedCases,...linkedRuns].map(item=>item!.benchmark_id)); if(actual.size!==failure.benchmark_ids.length||failure.benchmark_ids.some(key=>!actual.has(key))) throw new Error(`failure ${failure.cluster_id} benchmark closure must equal linked case and run benchmarks`)}
  return {registry,cases,run_receipts:runs,failure_clusters:failures}
}

export function deriveMatchedPairs(foundation: EvaluationFoundationV0): DerivedMatchedPairV0[] {
  const groups=new Map<string,EvalRunReceiptV0[]>(); for(const run of foundation.run_receipts) if(run.pairing) groups.set(run.pairing.pair_id,[...(groups.get(run.pairing.pair_id)??[]),run]); const registry=new Map(foundation.registry.map(item=>[item.benchmark_id,item])), cases=new Map(foundation.cases.map(item=>[item.case_id,item]))
  return [...groups.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([pairId,members])=>{
    if(members.length!==2) throw new Error(`pair ${pairId} must contain exactly two receipts`); const baseline=members.find(item=>item.pairing?.role==='baseline'), treatment=members.find(item=>item.pairing?.role==='treatment'); if(!baseline||!treatment) throw new Error(`pair ${pairId} must contain opposite baseline and treatment roles`); if(baseline.pairing!.counterpart_run_id!==treatment.run_id||treatment.pairing!.counterpart_run_id!==baseline.run_id) throw new Error(`pair ${pairId} counterpart references must be reciprocal`); if(baseline.benchmark_id!==treatment.benchmark_id||baseline.case_id!==treatment.case_id) throw new Error(`pair ${pairId} must share benchmark and case`)
    const entry=registry.get(baseline.benchmark_id)!, evalCase=cases.get(baseline.case_id)!; if(entry.countability_default!=='countable_if_qualified') throw new Error(`pair ${pairId} benchmark is diagnostic only`); if(evalCase.input_ref.kind!=='external_opaque_reference') throw new Error(`pair ${pairId} requires an external opaque case reference`); if([baseline,treatment].some(run=>run.evidence_kind!=='observed_external')) throw new Error(`pair ${pairId} requires observed_external evidence`); if(baseline.status!=='succeeded'||treatment.status!=='succeeded') throw new Error(`pair ${pairId} requires succeeded terminal receipts`); if(baseline.model.provider!==treatment.model.provider||baseline.model.model!==treatment.model.model) throw new Error(`pair ${pairId} model identity must match`)
    for(const key of ['case_set_sha256','protocol_control_sha256','model_parameters_sha256','scorer_sha256','tool_snapshot_sha256','source_fence_sha256','integrity_sha256','official_evaluator_sha256'] as const) if(baseline.controls[key]!==treatment.controls[key]) throw new Error(`pair ${pairId} control mismatch: ${key}`)
    if(baseline.controls.scorer_sha256!==evaluationFingerprint(evalCase.scorer_revision)) throw new Error(`pair ${pairId} scorer fingerprint does not close`); if(baseline.controls.case_set_sha256!==evaluationFingerprint(foundation.cases.filter(item=>item.benchmark_id===baseline.benchmark_id))) throw new Error(`pair ${pairId} case-set fingerprint does not close`); if(baseline.controls.source_fence_sha256!==evaluationFingerprint(entry.source_fence)) throw new Error(`pair ${pairId} source-fence fingerprint does not close`); if(baseline.controls.official_evaluator_sha256!==evaluationFingerprint(entry.provenance.evaluator)) throw new Error(`pair ${pairId} evaluator fingerprint does not close`)
    for(const run of [baseline,treatment]) { const receipts=Object.values(run.qualification.evidence_receipts); if(!run.qualification.official_result||!run.qualification.source_fence_passed||!run.qualification.integrity_passed||receipts.some(item=>item===null)) throw new Error(`pair ${pairId} lacks qualification evidence receipts`) }
    if(baseline.gotry_sha===treatment.gotry_sha) throw new Error(`pair ${pairId} baseline and treatment gotry_sha must differ`); if(baseline.experiment.changed_variables.length!==0||JSON.stringify(treatment.experiment.changed_variables)!==JSON.stringify(['gotry_sha'])) throw new Error(`pair ${pairId} treatment variable must be exactly gotry_sha`); for(const run of [baseline,treatment]) if(run.experiment.candidate_sha256!==evaluationFingerprint({treatment_variable:'gotry_sha',gotry_sha:run.gotry_sha})) throw new Error(`pair ${pairId} candidate fingerprint does not close to gotry_sha`); if([baseline,treatment].some(run=>run.guardrails.hard_violation_count!==0||run.guardrails.forbidden_leakage_hits!==0)) throw new Error(`pair ${pairId} has hard violation or leakage`)
    return {schema_version:'gotry_eval_matched_pair_derived_v0',pair_id:pairId,benchmark_id:baseline.benchmark_id,case_id:baseline.case_id,baseline_run_id:baseline.run_id,treatment_run_id:treatment.run_id,treatment_variable:'gotry_sha',matched_pair_countable:true}
  })
}

export function parseMutationVectors(value: unknown): MutationVectorV0[] { if(!Array.isArray(value)) throw new Error('mutation vectors must be an array'); return value.map((raw,index)=>{const root=obj(raw,`mutation[${index}]`), kind=lit(root.value_kind,'mutation.value_kind',['literal','synthetic_absolute_path','nan','duplicate_treatment_receipt']), keys=kind==='literal'?['id','foundation_kind','target','operation','path','value_kind','value','expected_error']:['id','foundation_kind','target','operation','path','value_kind','expected_error']; exact(root,`mutation[${index}]`,keys); return {id:id(root.id,'mutation.id'),foundation_kind:lit(root.foundation_kind,'mutation.foundation_kind',['diagnostic_repository','countable_test_only']),target:lit(root.target,'mutation.target',['registry','case','run','failure','foundation']),operation:lit(root.operation,'mutation.operation',['replace','remove','append']),path:text(root.path,'mutation.path'),value_kind:kind,...(kind==='literal'?{value:root.value}:{}),expected_error:text(root.expected_error,'mutation.expected_error')}}) }
export function applyMutationVector(foundation: EvaluationFoundationV0, vector: MutationVectorV0): unknown { const cloned=JSON.parse(JSON.stringify(foundation)) as Record<string,unknown>; const selected:unknown=vector.target==='foundation'?cloned:vector.target==='registry'?cloned.registry:vector.target==='case'?(cloned.cases as unknown[])[0]:vector.target==='run'?(cloned.run_receipts as unknown[])[0]:(cloned.failure_clusters as unknown[])[0]; let value:unknown=vector.value; if(vector.value_kind==='synthetic_absolute_path') value=['','Users','fixture','private.json'].join('/'); if(vector.value_kind==='nan') value=Number.NaN; if(vector.value_kind==='duplicate_treatment_receipt'){const run=structuredClone((cloned.run_receipts as EvalRunReceiptV0[])[1]!);run.run_id='run:trek:treatment-duplicate';value=run} const parts=vector.path.split('.').filter(Boolean);let parent=selected as Record<string,unknown>;for(const part of parts.slice(0,-1))parent=parent[part] as Record<string,unknown>;const leaf=parts.at(-1)!;if(vector.operation==='remove')Array.isArray(parent)?parent.splice(Number(leaf),1):delete parent[leaf];else if(vector.operation==='append')(parent[leaf] as unknown[]).push(value);else parent[leaf]=value;return selected }
```

Run: `cd ts && npx tsc --noEmit`

Expected: exit `0`; TypeScript compilation does not read the JSON fixtures. Do not commit.

- [ ] **Step 3: Add the seven exact registry rows and diagnostic repository fixtures**

Create `ts/data/evaluation/benchmark-registry.json`. Use the full JSON below verbatim; every native metric object has `receipt_key`, exact `upstream_label`, scope, and exact source URL.

```json
[
 {"schema_version":"gotry_benchmark_registry_entry_v0","benchmark_id":"trek","provenance":{"official_entry":{"url":"https://github.com/TonyQJH/TREK-A-Travel-Reasoning-and-Evaluation-Kit-for-LLM-Agents-in-Complex-Trip-Planning/blob/6ceb4ebb2debd69c5c7c4ba34b5b17524756912b/README.md","revision":{"kind":"git_commit","value":"6ceb4ebb2debd69c5c7c4ba34b5b17524756912b"},"source_scope":"official definition"},"data":{"url":"https://github.com/TonyQJH/TREK-A-Travel-Reasoning-and-Evaluation-Kit-for-LLM-Agents-in-Complex-Trip-Planning/tree/6ceb4ebb2debd69c5c7c4ba34b5b17524756912b/api/data/v2","revision":{"kind":"git_commit","value":"6ceb4ebb2debd69c5c7c4ba34b5b17524756912b"},"source_scope":"task data v2"},"evaluator":{"url":"https://github.com/TonyQJH/TREK-A-Travel-Reasoning-and-Evaluation-Kit-for-LLM-Agents-in-Complex-Trip-Planning/blob/6ceb4ebb2debd69c5c7c4ba34b5b17524756912b/scoring.py","revision":{"kind":"git_commit","value":"6ceb4ebb2debd69c5c7c4ba34b5b17524756912b"},"source_scope":"official nine-dimension scoring implementation"}},"license":{"upstream_rights":{"code":{"value":"MIT","determination":"declared","source_url":"https://github.com/TonyQJH/TREK-A-Travel-Reasoning-and-Evaluation-Kit-for-LLM-Agents-in-Complex-Trip-Planning/blob/6ceb4ebb2debd69c5c7c4ba34b5b17524756912b/LICENSE"},"data":{"value":"CC-BY-4.0","determination":"declared","source_url":"https://github.com/TonyQJH/TREK-A-Travel-Reasoning-and-Evaluation-Kit-for-LLM-Agents-in-Complex-Trip-Planning/blob/6ceb4ebb2debd69c5c7c4ba34b5b17524756912b/README.md#data-and-license"},"evaluator":{"value":"MIT","determination":"declared","source_url":"https://github.com/TonyQJH/TREK-A-Travel-Reasoning-and-Evaluation-Kit-for-LLM-Agents-in-Complex-Trip-Planning/blob/6ceb4ebb2debd69c5c7c4ba34b5b17524756912b/LICENSE"}},"repo_storage_policy":"metadata_only_no_upstream_payload"},"task_scopes":["travel planning feasibility and efficiency"],"native_metrics":{"status":"declared","values":[{"receipt_key":"task_perfect_feasible","upstream_label":"task_perfect_feasible","scope":"task-perfect feasible","source_url":"https://github.com/TonyQJH/TREK-A-Travel-Reasoning-and-Evaluation-Kit-for-LLM-Agents-in-Complex-Trip-Planning/blob/6ceb4ebb2debd69c5c7c4ba34b5b17524756912b/scoring.py"},{"receipt_key":"task_perfect_infeasible","upstream_label":"task_perfect_infeasible","scope":"task-perfect infeasible","source_url":"https://github.com/TonyQJH/TREK-A-Travel-Reasoning-and-Evaluation-Kit-for-LLM-Agents-in-Complex-Trip-Planning/blob/6ceb4ebb2debd69c5c7c4ba34b5b17524756912b/scoring.py"},{"receipt_key":"cat_efficiency","upstream_label":"cat_efficiency","scope":"category efficiency","source_url":"https://github.com/TonyQJH/TREK-A-Travel-Reasoning-and-Evaluation-Kit-for-LLM-Agents-in-Complex-Trip-Planning/blob/6ceb4ebb2debd69c5c7c4ba34b5b17524756912b/scoring.py"}]},"source_fence":{"solver_allowed_field_classes":["task_input"],"solver_forbidden_field_classes":["gold_plan","evaluator_internal_state","held_out_answer"]},"countability_default":"countable_if_qualified"},
 {"schema_version":"gotry_benchmark_registry_entry_v0","benchmark_id":"travelplanner","provenance":{"official_entry":{"url":"https://github.com/OSU-NLP-Group/TravelPlanner/blob/e52c87f4ac348a3410c46dc3553c519db5ec5e23/README.md","revision":{"kind":"git_commit","value":"e52c87f4ac348a3410c46dc3553c519db5ec5e23"},"source_scope":"official definition"},"data":{"url":"https://huggingface.co/datasets/osunlp/TravelPlanner/tree/8736504ecfc31b7f8b7e40122873c337e83fff7c","revision":{"kind":"git_commit","value":"8736504ecfc31b7f8b7e40122873c337e83fff7c"},"source_scope":"official Hugging Face dataset git revision"},"evaluator":{"url":"https://github.com/OSU-NLP-Group/TravelPlanner/blob/e52c87f4ac348a3410c46dc3553c519db5ec5e23/evaluation/eval.py","revision":{"kind":"git_commit","value":"e52c87f4ac348a3410c46dc3553c519db5ec5e23"},"source_scope":"official evaluator"}},"license":{"upstream_rights":{"code":{"value":"MIT","determination":"declared","source_url":"https://github.com/OSU-NLP-Group/TravelPlanner/blob/e52c87f4ac348a3410c46dc3553c519db5ec5e23/LICENSE"},"data":{"value":"CC-BY-4.0","determination":"declared","source_url":"https://huggingface.co/datasets/osunlp/TravelPlanner/blob/8736504ecfc31b7f8b7e40122873c337e83fff7c/README.md"},"evaluator":{"value":"MIT","determination":"declared","source_url":"https://github.com/OSU-NLP-Group/TravelPlanner/blob/e52c87f4ac348a3410c46dc3553c519db5ec5e23/LICENSE"}},"repo_storage_policy":"metadata_only_no_upstream_payload"},"task_scopes":["travel itinerary planning under commonsense and hard constraints"],"native_metrics":{"status":"declared","values":[{"receipt_key":"commonsense_micro_pass_rate","upstream_label":"Commonsense Constraint Micro Pass Rate","scope":"commonsense micro","source_url":"https://github.com/OSU-NLP-Group/TravelPlanner/blob/e52c87f4ac348a3410c46dc3553c519db5ec5e23/evaluation/eval.py"},{"receipt_key":"commonsense_macro_pass_rate","upstream_label":"Commonsense Constraint Macro Pass Rate","scope":"commonsense macro","source_url":"https://github.com/OSU-NLP-Group/TravelPlanner/blob/e52c87f4ac348a3410c46dc3553c519db5ec5e23/evaluation/eval.py"},{"receipt_key":"hard_micro_pass_rate","upstream_label":"Hard Constraint Micro Pass Rate","scope":"hard-constraint micro","source_url":"https://github.com/OSU-NLP-Group/TravelPlanner/blob/e52c87f4ac348a3410c46dc3553c519db5ec5e23/evaluation/eval.py"},{"receipt_key":"hard_macro_pass_rate","upstream_label":"Hard Constraint Macro Pass Rate","scope":"hard-constraint macro","source_url":"https://github.com/OSU-NLP-Group/TravelPlanner/blob/e52c87f4ac348a3410c46dc3553c519db5ec5e23/evaluation/eval.py"},{"receipt_key":"final_pass_rate","upstream_label":"Final Pass Rate","scope":"complete itinerary","source_url":"https://github.com/OSU-NLP-Group/TravelPlanner/blob/e52c87f4ac348a3410c46dc3553c519db5ec5e23/evaluation/eval.py"}]},"source_fence":{"solver_allowed_field_classes":["query","public_database"],"solver_forbidden_field_classes":["reference_plan","evaluator_state","held_out_answer"]},"countability_default":"countable_if_qualified"},
 {"schema_version":"gotry_benchmark_registry_entry_v0","benchmark_id":"chinatravel","provenance":{"official_entry":{"url":"https://github.com/chinatravel-competition/IJCAI2026/blob/49d02bc322dda7ffbf53dfb7c3d2ced6b4bd4e8b/index.html","revision":{"kind":"git_commit","value":"49d02bc322dda7ffbf53dfb7c3d2ced6b4bd4e8b"},"source_scope":"official competition entry"},"data":{"url":"https://github.com/chinatravel-competition/IJCAI2026/blob/49d02bc322dda7ffbf53dfb7c3d2ced6b4bd4e8b/TPC_IJCAI_2026_phase2_familiar_100_data.zip","revision":{"kind":"git_commit","value":"49d02bc322dda7ffbf53dfb7c3d2ced6b4bd4e8b"},"source_scope":"public familiar-track archive"},"evaluator":{"url":"https://github.com/LAMDA-NeSy/ChinaTravel/blob/b071db251905b14002ec98e8b36afca7b6d6cd04/eval_tpc.py","revision":{"kind":"git_commit","value":"b071db251905b14002ec98e8b36afca7b6d6cd04"},"source_scope":"official TPC evaluator implementation"}},"license":{"upstream_rights":{"code":{"value":"not_separately_declared","determination":"not_separately_declared","source_url":"https://github.com/LAMDA-NeSy/ChinaTravel/blob/b071db251905b14002ec98e8b36afca7b6d6cd04/README.md"},"data":{"value":"CC-BY-NC-SA-4.0","determination":"declared","source_url":"https://huggingface.co/datasets/LAMDA-NeSy/ChinaTravel/blob/44d5dbf3bba26bdf9a212c3e76d3242b67f0d349/README.md"},"evaluator":{"value":"not_separately_declared","determination":"not_separately_declared","source_url":"https://github.com/LAMDA-NeSy/ChinaTravel/blob/b071db251905b14002ec98e8b36afca7b6d6cd04/README.md"}},"repo_storage_policy":"metadata_only_no_upstream_payload"},"task_scopes":["China multi-day itinerary planning public familiar track"],"native_metrics":{"status":"declared","values":[{"receipt_key":"epr_micro","upstream_label":"EPR-micro","scope":"element pass micro","source_url":"https://github.com/LAMDA-NeSy/ChinaTravel/blob/b071db251905b14002ec98e8b36afca7b6d6cd04/eval_tpc.py"},{"receipt_key":"epr_macro","upstream_label":"EPR-macro","scope":"element pass macro","source_url":"https://github.com/LAMDA-NeSy/ChinaTravel/blob/b071db251905b14002ec98e8b36afca7b6d6cd04/eval_tpc.py"},{"receipt_key":"c_lpr","upstream_label":"C-LPR","scope":"constraint-level pass","source_url":"https://github.com/LAMDA-NeSy/ChinaTravel/blob/b071db251905b14002ec98e8b36afca7b6d6cd04/eval_tpc.py"},{"receipt_key":"fpr","upstream_label":"FPR","scope":"final pass","source_url":"https://github.com/LAMDA-NeSy/ChinaTravel/blob/b071db251905b14002ec98e8b36afca7b6d6cd04/eval_tpc.py"},{"receipt_key":"dav","upstream_label":"DAV","scope":"Daily Average Attractions Visited","source_url":"https://github.com/LAMDA-NeSy/ChinaTravel/blob/b071db251905b14002ec98e8b36afca7b6d6cd04/eval_tpc.py"},{"receipt_key":"att","upstream_label":"ATT","scope":"Averaged Transportation Time","source_url":"https://github.com/LAMDA-NeSy/ChinaTravel/blob/b071db251905b14002ec98e8b36afca7b6d6cd04/eval_tpc.py"},{"receipt_key":"ddr","upstream_label":"DDR","scope":"Daily Dining Recommendations","source_url":"https://github.com/LAMDA-NeSy/ChinaTravel/blob/b071db251905b14002ec98e8b36afca7b6d6cd04/eval_tpc.py"},{"receipt_key":"overall_score","upstream_label":"Overall Score","scope":"weighted overall score","source_url":"https://github.com/LAMDA-NeSy/ChinaTravel/blob/b071db251905b14002ec98e8b36afca7b6d6cd04/eval_tpc.py"}]},"source_fence":{"solver_allowed_field_classes":["public_task_input","declared_public_resources"],"solver_forbidden_field_classes":["hard_logic_py","hard_logic_nl","dsl","official_feedback","held_out_answer","verifier_only_fields"]},"countability_default":"diagnostic_only"},
 {"schema_version":"gotry_benchmark_registry_entry_v0","benchmark_id":"travelbench","provenance":{"official_entry":{"url":"https://github.com/small-xiangcheng/TravelBench/blob/445a29d9a9b6457fc95fe647c532b6b79e21c43f/README.md","revision":{"kind":"git_commit","value":"445a29d9a9b6457fc95fe647c532b6b79e21c43f"},"source_scope":"official definition"},"data":{"url":"https://github.com/small-xiangcheng/TravelBench/tree/445a29d9a9b6457fc95fe647c532b6b79e21c43f/datas","revision":{"kind":"git_commit","value":"445a29d9a9b6457fc95fe647c532b6b79e21c43f"},"source_scope":"official data directory"},"evaluator":{"url":"https://github.com/small-xiangcheng/TravelBench/blob/445a29d9a9b6457fc95fe647c532b6b79e21c43f/travelbench/evaluation/evaluate.py","revision":{"kind":"git_commit","value":"445a29d9a9b6457fc95fe647c532b6b79e21c43f"},"source_scope":"official evaluator"}},"license":{"upstream_rights":{"code":{"value":"MIT","determination":"declared","source_url":"https://github.com/small-xiangcheng/TravelBench/blob/445a29d9a9b6457fc95fe647c532b6b79e21c43f/LICENSE"},"data":{"value":"CC-BY-NC-4.0","determination":"declared","source_url":"https://github.com/small-xiangcheng/TravelBench/blob/445a29d9a9b6457fc95fe647c532b6b79e21c43f/datas/LICENSE"},"evaluator":{"value":"MIT","determination":"declared","source_url":"https://github.com/small-xiangcheng/TravelBench/blob/445a29d9a9b6457fc95fe647c532b6b79e21c43f/LICENSE"}},"repo_storage_policy":"metadata_only_no_upstream_payload"},"task_scopes":["travel reasoning and planning","summarization and extraction","presentation","user interaction","unsolvable"],"native_metrics":{"status":"declared","values":[{"receipt_key":"reasoning_planning_score","upstream_label":"reasoning_planning_score","scope":"reasoning and planning","source_url":"https://github.com/small-xiangcheng/TravelBench/blob/445a29d9a9b6457fc95fe647c532b6b79e21c43f/travelbench/evaluation/evaluate.py"},{"receipt_key":"summarization_extraction_score","upstream_label":"summarization_extraction_score","scope":"summarization and extraction","source_url":"https://github.com/small-xiangcheng/TravelBench/blob/445a29d9a9b6457fc95fe647c532b6b79e21c43f/travelbench/evaluation/evaluate.py"},{"receipt_key":"presentation_score","upstream_label":"presentation_score","scope":"presentation","source_url":"https://github.com/small-xiangcheng/TravelBench/blob/445a29d9a9b6457fc95fe647c532b6b79e21c43f/travelbench/evaluation/evaluate.py"},{"receipt_key":"user_interaction_score","upstream_label":"user_interaction_score","scope":"user interaction","source_url":"https://github.com/small-xiangcheng/TravelBench/blob/445a29d9a9b6457fc95fe647c532b6b79e21c43f/travelbench/evaluation/evaluate.py"},{"receipt_key":"average_score","upstream_label":"average_score","scope":"average across dimensions","source_url":"https://github.com/small-xiangcheng/TravelBench/blob/445a29d9a9b6457fc95fe647c532b6b79e21c43f/travelbench/evaluation/evaluate.py"},{"receipt_key":"unsolved_accuracy","upstream_label":"unsolved_accuracy","scope":"unsolved cases","source_url":"https://github.com/small-xiangcheng/TravelBench/blob/445a29d9a9b6457fc95fe647c532b6b79e21c43f/travelbench/evaluation/evaluate_unsolved.py"}]},"source_fence":{"solver_allowed_field_classes":["task_input","tool_observation"],"solver_forbidden_field_classes":["reference_answer","judge_prompt","evaluator_state"]},"countability_default":"diagnostic_only"},
 {"schema_version":"gotry_benchmark_registry_entry_v0","benchmark_id":"tau2","provenance":{"official_entry":{"url":"https://github.com/sierra-research/tau2-bench/blob/a2c024725189473d2d7cea3a5cfdbcc67478e41f/README.md","revision":{"kind":"git_commit","value":"a2c024725189473d2d7cea3a5cfdbcc67478e41f"},"source_scope":"official definition"},"data":{"url":"https://github.com/sierra-research/tau2-bench/tree/a2c024725189473d2d7cea3a5cfdbcc67478e41f/data/tau2","revision":{"kind":"git_commit","value":"a2c024725189473d2d7cea3a5cfdbcc67478e41f"},"source_scope":"official data"},"evaluator":{"url":"https://github.com/sierra-research/tau2-bench/blob/a2c024725189473d2d7cea3a5cfdbcc67478e41f/src/tau2/metrics/agent_metrics.py","revision":{"kind":"git_commit","value":"a2c024725189473d2d7cea3a5cfdbcc67478e41f"},"source_scope":"official agent metrics implementation"}},"license":{"upstream_rights":{"code":{"value":"MIT","determination":"declared","source_url":"https://github.com/sierra-research/tau2-bench/blob/a2c024725189473d2d7cea3a5cfdbcc67478e41f/LICENSE"},"data":{"value":"not_separately_declared","determination":"not_separately_declared","source_url":"https://github.com/sierra-research/tau2-bench/blob/a2c024725189473d2d7cea3a5cfdbcc67478e41f/README.md"},"evaluator":{"value":"MIT","determination":"declared","source_url":"https://github.com/sierra-research/tau2-bench/blob/a2c024725189473d2d7cea3a5cfdbcc67478e41f/LICENSE"}},"repo_storage_policy":"metadata_only_no_upstream_payload"},"task_scopes":["tool-agent-user interaction"],"native_metrics":{"status":"declared","values":[{"receipt_key":"avg_reward","upstream_label":"avg_reward","scope":"average reward","source_url":"https://github.com/sierra-research/tau2-bench/blob/a2c024725189473d2d7cea3a5cfdbcc67478e41f/src/tau2/metrics/agent_metrics.py"},{"receipt_key":"pass_hat_1","upstream_label":"pass^1","scope":"mean task pass^1","source_url":"https://github.com/sierra-research/tau2-bench/blob/a2c024725189473d2d7cea3a5cfdbcc67478e41f/src/tau2/metrics/agent_metrics.py"}]},"source_fence":{"solver_allowed_field_classes":["user_message","tool_schema","tool_result"],"solver_forbidden_field_classes":["reward_annotation","hidden_state","reference_trajectory"]},"countability_default":"countable_if_qualified"},
 {"schema_version":"gotry_benchmark_registry_entry_v0","benchmark_id":"locomo","provenance":{"official_entry":{"url":"https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/README.MD","revision":{"kind":"git_commit","value":"3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376"},"source_scope":"official definition"},"data":{"url":"https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/data/locomo10.json","revision":{"kind":"git_commit","value":"3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376"},"source_scope":"official data"},"evaluator":{"url":"https://github.com/snap-research/locomo/tree/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/task_eval","revision":{"kind":"git_commit","value":"3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376"},"source_scope":"official task evaluation directory"}},"license":{"upstream_rights":{"code":{"value":"CC-BY-NC-4.0","determination":"declared","source_url":"https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/LICENSE.txt"},"data":{"value":"CC-BY-NC-4.0","determination":"declared","source_url":"https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/LICENSE.txt"},"evaluator":{"value":"CC-BY-NC-4.0","determination":"declared","source_url":"https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/LICENSE.txt"}},"repo_storage_policy":"metadata_only_no_upstream_payload"},"task_scopes":["question-answering"],"native_metrics":{"status":"declared","values":[{"receipt_key":"qa_f1","upstream_label":"F1","scope":"question-answering token F1","source_url":"https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/task_eval/evaluate_qa.py"}]},"source_fence":{"solver_allowed_field_classes":["conversation_context","question","public_media_reference"],"solver_forbidden_field_classes":["answer_key","judge_annotation","future_turn"]},"countability_default":"diagnostic_only"},
 {"schema_version":"gotry_benchmark_registry_entry_v0","benchmark_id":"bfcl","provenance":{"official_entry":{"url":"https://github.com/ShishirPatil/gorilla/blob/6ea57973c7a6097fd7c5915698c54c17c5b1b6c8/berkeley-function-call-leaderboard/README.md","revision":{"kind":"git_commit","value":"6ea57973c7a6097fd7c5915698c54c17c5b1b6c8"},"source_scope":"official BFCL definition"},"data":{"url":"https://github.com/ShishirPatil/gorilla/tree/6ea57973c7a6097fd7c5915698c54c17c5b1b6c8/berkeley-function-call-leaderboard/bfcl_eval/data","revision":{"kind":"git_commit","value":"6ea57973c7a6097fd7c5915698c54c17c5b1b6c8"},"source_scope":"BFCL data"},"evaluator":{"url":"https://github.com/ShishirPatil/gorilla/tree/6ea57973c7a6097fd7c5915698c54c17c5b1b6c8/berkeley-function-call-leaderboard/bfcl_eval","revision":{"kind":"git_commit","value":"6ea57973c7a6097fd7c5915698c54c17c5b1b6c8"},"source_scope":"BFCL evaluator"}},"license":{"upstream_rights":{"code":{"value":"Apache-2.0","determination":"declared","source_url":"https://github.com/ShishirPatil/gorilla/blob/6ea57973c7a6097fd7c5915698c54c17c5b1b6c8/LICENSE"},"data":{"value":"Apache-2.0","determination":"declared","source_url":"https://github.com/ShishirPatil/gorilla/blob/6ea57973c7a6097fd7c5915698c54c17c5b1b6c8/berkeley-function-call-leaderboard/README.md"},"evaluator":{"value":"Apache-2.0","determination":"declared","source_url":"https://github.com/ShishirPatil/gorilla/blob/6ea57973c7a6097fd7c5915698c54c17c5b1b6c8/LICENSE"}},"repo_storage_policy":"metadata_only_no_upstream_payload"},"task_scopes":["function calling across categories"],"native_metrics":{"status":"declared","values":[{"receipt_key":"category_accuracy","upstream_label":"accuracy","scope":"per test_category","source_url":"https://github.com/ShishirPatil/gorilla/blob/6ea57973c7a6097fd7c5915698c54c17c5b1b6c8/berkeley-function-call-leaderboard/bfcl_eval/eval_checker/eval_runner_helper.py"},{"receipt_key":"overall_accuracy","upstream_label":"Overall Acc","scope":"overall accuracy","source_url":"https://github.com/ShishirPatil/gorilla/blob/6ea57973c7a6097fd7c5915698c54c17c5b1b6c8/berkeley-function-call-leaderboard/README.md"}]},"source_fence":{"solver_allowed_field_classes":["user_query","function_schema"],"solver_forbidden_field_classes":["expected_call","checker_state","category_answer"]},"countability_default":"countable_if_qualified"}
]
```

LoCoMo v0 deliberately registers only the official question-answering F1 metric. Event-summarization and multimodal-dialog-generation metric names are excluded from v0 because the pinned sources do not separately declare stable receipt labels and scopes for them.

Create `ts/data/evaluation/known-good.json` exactly. This repository fixture is unmatched, unqualified, receipt-free, synthetic, and therefore produces zero matched pairs:

```json
{
 "cases":[{"schema_version":"gotry_eval_case_v0","case_id":"gotry:foundation:case-001","benchmark_id":"trek","input_ref":{"kind":"gotry_owned_synthetic","revision":{"kind":"content_sha256","value":"1111111111111111111111111111111111111111111111111111111111111111"},"digest_sha256":"1111111111111111111111111111111111111111111111111111111111111111"},"isolation":{"state_root":"ephemeral","network":"denied","writes":"forbidden"},"clock":{"now":"2026-08-31T00:00:00.000Z","timezone":"UTC"},"allowed_effects":[],"forbidden_effects":["external_write"],"budget":{"max_seconds":30,"max_cost_usd":0,"max_tool_calls":4,"max_turns":8},"scorer_revision":{"kind":"content_sha256","value":"4444444444444444444444444444444444444444444444444444444444444444"},"public_safety":{"contains_third_party_prompt":false,"contains_gold":false,"contains_oracle":false,"contains_private_data":false}}],
 "run_receipts":[{"schema_version":"gotry_eval_run_receipt_v0","run_id":"run:trek:diagnostic-001","benchmark_id":"trek","case_id":"gotry:foundation:case-001","evidence_kind":"synthetic_fixture","pairing":null,"status":"succeeded","started_at":"2026-08-31T00:00:00.000Z","finished_at":"2026-08-31T00:00:01.000Z","gotry_sha":"f9e63fbea0968dd3468f0eef2366b6207454df25","model":{"provider":"fixture","model":"fixture-model"},"controls":{"case_set_sha256":"1111111111111111111111111111111111111111111111111111111111111111","protocol_control_sha256":"2222222222222222222222222222222222222222222222222222222222222222","model_parameters_sha256":"3333333333333333333333333333333333333333333333333333333333333333","scorer_sha256":"4444444444444444444444444444444444444444444444444444444444444444","tool_snapshot_sha256":"5555555555555555555555555555555555555555555555555555555555555555","source_fence_sha256":"6666666666666666666666666666666666666666666666666666666666666666","integrity_sha256":"7777777777777777777777777777777777777777777777777777777777777777","official_evaluator_sha256":"8888888888888888888888888888888888888888888888888888888888888888"},"qualification":{"official_result":false,"source_fence_passed":false,"integrity_passed":false,"evidence_receipts":{"official_evaluator_output_sha256":null,"source_fence_audit_sha256":null,"integrity_audit_sha256":null}},"experiment":{"changed_variables":[],"candidate_sha256":"4be2fcdc1472caf02ac6cb032672405cfad2a3510c13d3c516ba34f4bf0db3b4"},"native_metrics":{"task_perfect_feasible":0,"task_perfect_infeasible":0,"cat_efficiency":0},"guardrails":{"hard_violation_count":0,"forbidden_leakage_hits":0,"latency_ms":1,"cost_usd":0,"tool_calls":0,"turns":0},"evidence_summary":{"artifact_classification":"public_safe","sha256":[],"counts":{"cases":1},"reason_codes":["synthetic_contract_fixture_only"],"fixture_only":true,"statement":"diagnostic parser fixture; not benchmark evidence"}}],
 "failure_clusters":[{"schema_version":"gotry_eval_failure_cluster_v0","cluster_id":"cluster:foundation:001","category":"schema_or_format","severity":"P3","benchmark_ids":["trek"],"case_ids":["gotry:foundation:case-001"],"run_ids":["run:trek:diagnostic-001"],"reproduction":{"condition":"synthetic validator exemplar","minimum_repetitions":1,"observed_repetitions":1},"falsifiable_hypothesis":"Rejecting the canonical diagnostic receipt would falsify parser compatibility.","gotry_regression_id":"regression:foundation:001","suggested_surface":"evaluation","state":"confirmed"}]
}
```

Create `ts/data/evaluation/known-bad.json` exactly. It contains only inert mutation instructions. The absolute path and `NaN` are synthesized in test memory; mutation paths may name safety categories because this envelope is never scanned or published as an evaluation artifact.

```json
[
 {"id":"registry-bad-revision","foundation_kind":"diagnostic_repository","target":"registry","operation":"replace","path":"0.provenance.official_entry.revision.value","value_kind":"literal","value":"abc","expected_error":"40-character Git commit"},
 {"id":"registry-url-credentials","foundation_kind":"diagnostic_repository","target":"registry","operation":"replace","path":"0.provenance.data.url","value_kind":"literal","value":"https://user:pass@example.com/data","expected_error":"must not contain credentials"},
 {"id":"case-time","foundation_kind":"diagnostic_repository","target":"case","operation":"replace","path":"clock.now","value_kind":"literal","value":"2026-08-31T00:00:00Z","expected_error":"canonical ISO UTC with milliseconds"},
 {"id":"case-zone","foundation_kind":"diagnostic_repository","target":"case","operation":"replace","path":"clock.timezone","value_kind":"literal","value":"Mars/Olympus","expected_error":"UTC or an IANA timezone"},
 {"id":"run-path","foundation_kind":"diagnostic_repository","target":"run","operation":"replace","path":"evidence_summary.statement","value_kind":"synthetic_absolute_path","expected_error":"contains an absolute path"},
 {"id":"case-gold","foundation_kind":"diagnostic_repository","target":"case","operation":"replace","path":"public_safety.contains_gold","value_kind":"literal","value":true,"expected_error":"contains_gold must be false"},
 {"id":"run-nan","foundation_kind":"diagnostic_repository","target":"run","operation":"replace","path":"native_metrics.task_perfect_feasible","value_kind":"nan","expected_error":"finite number"},
 {"id":"run-negative-count","foundation_kind":"diagnostic_repository","target":"run","operation":"replace","path":"evidence_summary.counts.cases","value_kind":"literal","value":-1,"expected_error":"finite number >= 0"},
 {"id":"run-metric-registry-closure","foundation_kind":"diagnostic_repository","target":"foundation","operation":"replace","path":"run_receipts.0.native_metrics","value_kind":"literal","value":{"task_perfect_feasible":0},"expected_error":"metric keys must equal registry receipt keys"},
 {"id":"pair-synthetic-kind","foundation_kind":"countable_test_only","target":"foundation","operation":"replace","path":"run_receipts.0.evidence_kind","value_kind":"literal","value":"synthetic_fixture","expected_error":"synthetic fixture must be unmatched"},
 {"id":"pair-synthetic-case","foundation_kind":"countable_test_only","target":"foundation","operation":"replace","path":"cases.0.input_ref.kind","value_kind":"literal","value":"gotry_owned_synthetic","expected_error":"requires an external opaque case reference"},
 {"id":"pair-missing-member","foundation_kind":"countable_test_only","target":"foundation","operation":"replace","path":"run_receipts.0.pairing","value_kind":"literal","value":null,"expected_error":"exactly two receipts"},
 {"id":"pair-third-member","foundation_kind":"countable_test_only","target":"foundation","operation":"append","path":"run_receipts","value_kind":"duplicate_treatment_receipt","expected_error":"exactly two receipts"},
 {"id":"pair-same-role","foundation_kind":"countable_test_only","target":"foundation","operation":"replace","path":"run_receipts.1.pairing.role","value_kind":"literal","value":"baseline","expected_error":"opposite baseline and treatment roles"},
 {"id":"pair-nonreciprocal","foundation_kind":"countable_test_only","target":"foundation","operation":"replace","path":"run_receipts.1.pairing.counterpart_run_id","value_kind":"literal","value":"run:trek:other","expected_error":"references must be reciprocal"},
 {"id":"pair-case-set","foundation_kind":"countable_test_only","target":"foundation","operation":"replace","path":"run_receipts.1.controls.case_set_sha256","value_kind":"literal","value":"9999999999999999999999999999999999999999999999999999999999999999","expected_error":"case_set_sha256"},
 {"id":"pair-protocol","foundation_kind":"countable_test_only","target":"foundation","operation":"replace","path":"run_receipts.1.controls.protocol_control_sha256","value_kind":"literal","value":"9999999999999999999999999999999999999999999999999999999999999999","expected_error":"protocol_control_sha256"},
 {"id":"pair-model-parameters","foundation_kind":"countable_test_only","target":"foundation","operation":"replace","path":"run_receipts.1.controls.model_parameters_sha256","value_kind":"literal","value":"9999999999999999999999999999999999999999999999999999999999999999","expected_error":"model_parameters_sha256"},
 {"id":"pair-scorer-control","foundation_kind":"countable_test_only","target":"foundation","operation":"replace","path":"run_receipts.1.controls.scorer_sha256","value_kind":"literal","value":"9999999999999999999999999999999999999999999999999999999999999999","expected_error":"scorer_sha256"},
 {"id":"pair-tool","foundation_kind":"countable_test_only","target":"foundation","operation":"replace","path":"run_receipts.1.controls.tool_snapshot_sha256","value_kind":"literal","value":"9999999999999999999999999999999999999999999999999999999999999999","expected_error":"tool_snapshot_sha256"},
 {"id":"pair-source-control","foundation_kind":"countable_test_only","target":"foundation","operation":"replace","path":"run_receipts.1.controls.source_fence_sha256","value_kind":"literal","value":"9999999999999999999999999999999999999999999999999999999999999999","expected_error":"source_fence_sha256"},
 {"id":"pair-integrity","foundation_kind":"countable_test_only","target":"foundation","operation":"replace","path":"run_receipts.1.controls.integrity_sha256","value_kind":"literal","value":"9999999999999999999999999999999999999999999999999999999999999999","expected_error":"integrity_sha256"},
 {"id":"pair-evaluator-control","foundation_kind":"countable_test_only","target":"foundation","operation":"replace","path":"run_receipts.1.controls.official_evaluator_sha256","value_kind":"literal","value":"9999999999999999999999999999999999999999999999999999999999999999","expected_error":"official_evaluator_sha256"},
 {"id":"pair-model-identity","foundation_kind":"countable_test_only","target":"foundation","operation":"replace","path":"run_receipts.1.model.model","value_kind":"literal","value":"different-model","expected_error":"model identity must match"},
 {"id":"pair-case-set-derived","foundation_kind":"countable_test_only","target":"foundation","operation":"replace","path":"cases.0.budget.max_seconds","value_kind":"literal","value":31,"expected_error":"case-set fingerprint does not close"},
 {"id":"pair-scorer-derived","foundation_kind":"countable_test_only","target":"foundation","operation":"replace","path":"cases.0.scorer_revision.value","value_kind":"literal","value":"9999999999999999999999999999999999999999999999999999999999999999","expected_error":"scorer fingerprint does not close"},
 {"id":"pair-source-derived","foundation_kind":"countable_test_only","target":"foundation","operation":"replace","path":"registry.0.source_fence.solver_allowed_field_classes","value_kind":"literal","value":["different_task_input"],"expected_error":"source-fence fingerprint does not close"},
 {"id":"pair-evaluator-derived","foundation_kind":"countable_test_only","target":"foundation","operation":"replace","path":"registry.0.provenance.evaluator.source_scope","value_kind":"literal","value":"different official scorer scope","expected_error":"evaluator fingerprint does not close"},
 {"id":"pair-official-result","foundation_kind":"countable_test_only","target":"foundation","operation":"replace","path":"run_receipts.0.qualification.official_result","value_kind":"literal","value":false,"expected_error":"lacks qualification evidence receipts"},
 {"id":"pair-missing-evidence-receipt","foundation_kind":"countable_test_only","target":"foundation","operation":"replace","path":"run_receipts.0.qualification.evidence_receipts.integrity_audit_sha256","value_kind":"literal","value":null,"expected_error":"lacks qualification evidence receipts"},
 {"id":"pair-treatment-count","foundation_kind":"countable_test_only","target":"foundation","operation":"replace","path":"run_receipts.1.experiment.changed_variables","value_kind":"literal","value":["prompt_revision","tool_policy"],"expected_error":"treatment variable must be exactly gotry_sha"},
 {"id":"pair-diagnostic-default","foundation_kind":"countable_test_only","target":"foundation","operation":"replace","path":"registry.0.countability_default","value_kind":"literal","value":"diagnostic_only","expected_error":"diagnostic only"},
 {"id":"cluster-benchmark-closure","foundation_kind":"diagnostic_repository","target":"foundation","operation":"replace","path":"failure_clusters.0.benchmark_ids","value_kind":"literal","value":["trek","bfcl"],"expected_error":"benchmark closure must equal linked case and run benchmarks"},
 {"id":"pair-hard-violation","foundation_kind":"countable_test_only","target":"foundation","operation":"replace","path":"run_receipts.1.guardrails.hard_violation_count","value_kind":"literal","value":1,"expected_error":"hard violation or leakage"},
 {"id":"run-finished-before-started","foundation_kind":"diagnostic_repository","target":"run","operation":"replace","path":"finished_at","value_kind":"literal","value":"2026-08-30T23:59:59.000Z","expected_error":"finished_at must not precede started_at"},
 {"id":"pair-observed-marked-fixture","foundation_kind":"countable_test_only","target":"foundation","operation":"replace","path":"run_receipts.0.evidence_summary.fixture_only","value_kind":"literal","value":true,"expected_error":"observed_external receipt must set fixture_only=false"},
 {"id":"pair-same-gotry-sha","foundation_kind":"countable_test_only","target":"foundation","operation":"replace","path":"run_receipts.1.gotry_sha","value_kind":"literal","value":"1111111111111111111111111111111111111111","expected_error":"baseline and treatment gotry_sha must differ"},
 {"id":"pair-candidate-closure","foundation_kind":"countable_test_only","target":"foundation","operation":"replace","path":"run_receipts.1.experiment.candidate_sha256","value_kind":"literal","value":"9999999999999999999999999999999999999999999999999999999999999999","expected_error":"candidate fingerprint does not close to gotry_sha"},
 {"id":"pair-declared-variable-mismatch","foundation_kind":"countable_test_only","target":"foundation","operation":"replace","path":"run_receipts.1.experiment.changed_variables","value_kind":"literal","value":["prompt_revision"],"expected_error":"treatment variable must be exactly gotry_sha"}
]
```

Run: `cd ts && npx tsx scripts/evaluation-contract-tests.ts`

Expected: exit `1` only at the missing §45 assertion; before it, the repository fixture yields zero pairs, the in-memory `observed_external` object yields one pair, and all 39 negative vectors throw their exact error fragment. Do not commit.

- [ ] **Step 4: Add §45 and prove focused GREEN twice**

Insert after §44's three commands and before the final blank `echo` in `scripts/run-all-tests.sh`:

```bash
echo
echo "=== 45. Evaluation Phase 0 foundation(four v0 contracts/seven-source registry/diagnostic fixtures/test-only aggregate admission;no adapter,runner,Python,uplift claim) ==="
(cd ts && npx tsx scripts/evaluation-contract-tests.ts) || FAIL=1
```

Run:

```bash
cd ts
npx tsx scripts/evaluation-contract-tests.ts | tee /tmp/gotry-eval-foundation-first.log
npx tsx scripts/evaluation-contract-tests.ts | tee /tmp/gotry-eval-foundation-second.log
diff -u /tmp/gotry-eval-foundation-first.log /tmp/gotry-eval-foundation-second.log
grep -Eq '^canonical sha256: [0-9a-f]{64}$' /tmp/gotry-eval-foundation-first.log
grep -Fx 'evaluation-contract tests: 7 registry, 1 test-only matched pair, 39 negative vectors green' /tmp/gotry-eval-foundation-first.log
```

Expected: five exit codes `0`; both logs are byte-identical. Do not commit.

- [ ] **Step 5: Add the complete ownership/admission/non-result guide**

Create `docs/evaluation-foundation.md` exactly:

```markdown
# Evaluation Phase 0 foundation

## Scope

Phase 0 provides registry, case, run-receipt, and failure-cluster v0 contracts plus deterministic validators. It installs and executes no benchmark adapter, external runner, or official evaluator.

## Ownership and storage

GoTry git owns the TypeScript contracts, seven-row public metadata registry, and synthetic diagnostic fixtures. Upstream prompts, answers, gold, trajectories, judge/evaluator payloads, private user material, credentials, and absolute paths remain outside this repository. Every `license.upstream_rights` code/data/evaluator determination carries a value, declared-or-not-separately-declared status, and exact verification URL; `metadata_only_no_upstream_payload` is GoTry's stricter storage policy.

## Admission

Each benchmark has independent official-entry, data, and evaluator HTTPS pins with revision kind/value and source scope. `not_separately_declared` is an explicit unknown. Every native metric maps one stable receipt key to its exact upstream label, scope, and source URL. Registry source-fence category names are metadata; publishable case/run/failure values are structurally traversed for non-empty credentials, absolute paths, and raw sensitive payloads.

A case fixes isolated state, canonical UTC instant, UTC/IANA timezone, finite budgets, forbidden writes, scorer revision, and four literal-false safety flags. A repository run has `evidence_kind=synthetic_fixture`, `pairing=null`, `official_result=false`, null qualification receipts, and `fixture_only=true`. It can never be countable. Failure clusters close all run/case links to their exact benchmark set.

## Aggregate countability

`matched_pair_countable` exists only in derived output. Admission requires exactly two `observed_external` receipts with one reciprocal baseline/treatment pair, succeeded terminal states, the same provider/model, case, benchmark, protocol, model parameters, scorer, tools, source fence, integrity, evaluator, and native metric keys; distinct baseline/treatment GoTry SHAs as the sole treatment variable `gotry_sha`; candidate fingerprints recomputed from the canonical `{ treatment_variable: 'gotry_sha', gotry_sha }` object; zero hard/leakage hits; a countable registry default; and non-null official-evaluator/source-fence/integrity evidence receipts. Case-set, scorer, source-fence, and evaluator fingerprints are recomputed from the aggregate registry/case objects rather than trusted from receipt booleans.

The repository known-good fixture derives zero pairs. The focused test constructs one in-memory `observed_external` object solely to falsify aggregate admission logic. That object is not written to git and is not a baseline, production result, official score, or Agent-quality evidence.

## Verification and next phase

Run `cd ts && npx tsx scripts/evaluation-contract-tests.ts`, then `./scripts/run-all-tests.sh`. An adapter, external evaluator execution, result receipt, baseline, or Agent change requires a separately approved later plan and PR.
```

Run:

```bash
rg -n '^## (Scope|Ownership and storage|Admission|Aggregate countability|Verification and next phase)$' docs/evaluation-foundation.md
rg -n 'derives zero pairs|not written to git|separately approved later plan and PR' docs/evaluation-foundation.md
```

Expected: both commands exit `0`; five headings and all three non-result statements are present. Do not commit.

- [ ] **Step 6: Synchronize the six §11 state surfaces and §12 map**

Use this exact sentence once in each state surface (three occurrences in `architecture.md`, one in each other file):

```text
Evaluation Phase 0 foundation boundary: contracts/registry/validators/unmatched diagnostic fixtures plus test-only aggregate admission; no adapter, external runner, Python runtime dependency, baseline, matched production evidence, or Agent uplift claim.
```

Insert it at these exact positions:

1. `docs/architecture.md` §1 final paragraph before `## 2`.
2. `docs/architecture.md` §9 final paragraph before `## 10`.
3. `docs/architecture.md` §10 immediately before `## 11`, as this exact row:

```markdown
| D-27 Evaluation Phase 0→Phase 1 adapter admission | Evaluation Phase 0 foundation boundary: contracts/registry/validators/unmatched diagnostic fixtures plus test-only aggregate admission; no adapter, external runner, Python runtime dependency, baseline, matched production evidence, or Agent uplift claim. | **open**: adapter admission requires a separate approved plan/PR and the license/evaluator/source-fence controls in [`evaluation-foundation.md`](evaluation-foundation.md) |
```

4. `docs/roadmap.md` `## 当前位置(2026-08-27)` after its opening position paragraphs; do not move M3–M6 markers.
5. `README.md` immediately below `## ⚠️ Status & limitations`.
6. `docs/stage1-top-down-design.md` as a blockquote immediately before `> 创始人指令`.

In `docs/architecture.md` §12 add exactly:

```markdown
| [`evaluation-foundation.md`](evaluation-foundation.md) | Evaluation Phase 0 contracts, registry ownership, aggregate admission, and non-uplift boundary |
```

In `README.md` `## 🧪 Verify` add inside its Bash block:

```bash
# Evaluation Phase 0 diagnostic contracts (offline; no adapter/runner/Python)
cd ts && npx tsx scripts/evaluation-contract-tests.ts
```

Run:

```bash
node --input-type=module <<'NODE'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const boundary='Evaluation Phase 0 foundation boundary: contracts/registry/validators/unmatched diagnostic fixtures plus test-only aggregate admission; no adapter, external runner, Python runtime dependency, baseline, matched production evidence, or Agent uplift claim.'
const esc=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
const architecture=readFileSync('docs/architecture.md','utf8'), roadmap=readFileSync('docs/roadmap.md','utf8'), readme=readFileSync('README.md','utf8'), stage=readFileSync('docs/stage1-top-down-design.md','utf8')
const section=(text,start,end)=>text.split(start)[1]?.split(end)[0]??''
assert.equal((architecture.match(new RegExp(esc(boundary),'g'))??[]).length,3)
assert.match(section(architecture,'## 1. 系统是什么','## 2. 总体架构'),new RegExp(esc(boundary)))
assert.match(section(architecture,'## 9. 演进','## 10. 债务清单'),new RegExp(esc(boundary)))
assert.match(section(architecture,'## 10. 债务清单','## 11. 保鲜机制'),new RegExp(esc(boundary)))
assert.equal((roadmap.match(/Evaluation Phase 0 foundation boundary:/g)??[]).length,1)
assert.equal((readme.match(/Evaluation Phase 0 foundation boundary:/g)??[]).length,1)
assert.equal((stage.match(/Evaluation Phase 0 foundation boundary:/g)??[]).length,1)
assert.match(architecture,/evaluation-foundation\.md.*aggregate admission/); assert.match(readme,/evaluation-contract-tests\.ts/)
assert.doesNotMatch([architecture,roadmap,readme,stage].join('\n'),/Agent (quality )?(improved|uplift proven)|智能体.{0,12}(提升|改善).{0,12}(已证|证明)|基线.{0,6}(已建立|已完成)/i)
console.log('evaluation Phase 0 state surfaces: 6/6 same boundary')
NODE
```

Expected: exit `0`, printing exactly `evaluation Phase 0 state surfaces: 6/6 same boundary`. Do not commit.

- [ ] **Step 7: Prove base-relative dependency/Python isolation and all pre-commit gates**

From repository root:

```bash
PHASE0_BASE_SHA="$(git rev-parse HEAD)"
git cat-file -e "$PHASE0_BASE_SHA:docs/superpowers/specs/2026-08-30-gotry-multi-benchmark-evaluation-program-design.md"
git cat-file -e "$PHASE0_BASE_SHA:docs/superpowers/plans/2026-08-31-gotry-evaluation-phase0-foundation.md"
git diff --exit-code "$PHASE0_BASE_SHA" -- ':(glob)**/package.json' ':(glob)**/*lock*' pyproject.toml pnpm-workspace.yaml ts/dsh-runtime/pnpm-workspace.yaml
PHASE0_BASE_SHA="$PHASE0_BASE_SHA" node --input-type=module <<'NODE'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
const base=process.env.PHASE0_BASE_SHA; assert.match(base??'',/^[0-9a-f]{40}$/)
for(const file of ['package.json','ts/package.json','ts/dsh-runtime/package.json']){
  const before=JSON.parse(execFileSync('git',['show',`${base}:${file}`],{encoding:'utf8'})); const after=JSON.parse(readFileSync(file,'utf8'))
  assert.deepEqual(after.dependencies??{},before.dependencies??{},`${file} dependencies drifted`)
  assert.deepEqual(after.devDependencies??{},before.devDependencies??{},`${file} devDependencies drifted`)
}
console.log('root/ts/runtime dependencies and devDependencies unchanged from PHASE0_BASE_SHA')
NODE
if rg -n "node:child_process|spawn\(|execFile\(|python[0-9]*|\.py(['\"]|$)|gotry_feasibility" ts/src/evaluation-contracts.ts; then echo 'unexpected Python/process runtime surface' >&2; exit 1; fi
cd ts
npx tsc --noEmit
npx tsx scripts/smoke.ts
cd ..
./scripts/run-all-tests.sh
git diff --check
```

Expected: all commands exit `0`; manifest/lock diff and source scan are silent; the dependency proof prints its exact sentence; smoke uses its existing terminator; full stack prints §45 and ends `ALL SUITES GREEN`; `git diff --check` is silent. Do not commit.

- [ ] **Step 8: Create the only implementation commit**

```bash
git status --short
git diff -- ts/src/evaluation-contracts.ts ts/data/evaluation/benchmark-registry.json ts/data/evaluation/known-good.json ts/data/evaluation/known-bad.json ts/scripts/evaluation-contract-tests.ts scripts/run-all-tests.sh docs/evaluation-foundation.md docs/architecture.md docs/roadmap.md README.md docs/stage1-top-down-design.md
git add ts/src/evaluation-contracts.ts ts/data/evaluation/benchmark-registry.json ts/data/evaluation/known-good.json ts/data/evaluation/known-bad.json ts/scripts/evaluation-contract-tests.ts scripts/run-all-tests.sh docs/evaluation-foundation.md docs/architecture.md docs/roadmap.md README.md docs/stage1-top-down-design.md
test "$(git diff --cached --name-only | wc -l | tr -d ' ')" = 11
git commit -m "feat: establish deterministic evaluation contracts"
```

Expected: only those eleven paths are staged; commit exits `0`. This is the one vertical-slice commit for the one Phase 0 PR.

- [ ] **Step 9: Re-run final SHA-bound evidence, self-review, then inspect status last**

```bash
PHASE0_FINAL_SHA="$(git rev-parse HEAD)"
PHASE0_BASE_SHA="$(git rev-parse HEAD^)"
test "$PHASE0_FINAL_SHA" != "$PHASE0_BASE_SHA"
git cat-file -e "$PHASE0_BASE_SHA:docs/superpowers/specs/2026-08-30-gotry-multi-benchmark-evaluation-program-design.md"
git cat-file -e "$PHASE0_BASE_SHA:docs/superpowers/plans/2026-08-31-gotry-evaluation-phase0-foundation.md"
cd ts
npx tsx scripts/evaluation-contract-tests.ts
npx tsc --noEmit
npx tsx scripts/smoke.ts
cd ..
./scripts/run-all-tests.sh
git diff --exit-code "$PHASE0_BASE_SHA" -- ':(glob)**/package.json' ':(glob)**/*lock*' pyproject.toml pnpm-workspace.yaml ts/dsh-runtime/pnpm-workspace.yaml
git show --check --oneline --stat "$PHASE0_FINAL_SHA"
node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs'
const terms=['T'+'BD','T'+'ODO','implement '+'later','fill in '+'details','appropriate '+'error','handle '+'edge cases','write tests '+'for','similar to '+'task','类似'+' Task','稍后'+'实现']
const files=['ts/src/evaluation-contracts.ts','ts/scripts/evaluation-contract-tests.ts','ts/data/evaluation/benchmark-registry.json','ts/data/evaluation/known-good.json','ts/data/evaluation/known-bad.json','docs/evaluation-foundation.md']
const hits=files.flatMap(file=>terms.filter(term=>readFileSync(file,'utf8').toLowerCase().includes(term.toLowerCase())).map(term=>`${file}: ${term}`))
if(hits.length){console.error(hits.join('\n'));process.exit(1)}
NODE
node --input-type=module <<'NODE'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const source=readFileSync('ts/src/evaluation-contracts.ts','utf8'), tests=readFileSync('ts/scripts/evaluation-contract-tests.ts','utf8'), good=readFileSync('ts/data/evaluation/known-good.json','utf8')
for(const name of ['parseBenchmarkRegistry','parseEvalCase','parseEvalRunReceipt','parseEvalFailureCluster','parseEvaluationFoundation','deriveMatchedPairs','assertPublicArtifactSafe','evaluationFingerprint','stableEvaluationJson']){assert.match(source,new RegExp(`export function ${name}\\b`));assert.match(tests,new RegExp(`\\b${name}\\b`))}
assert.doesNotMatch(good,/matched_pair_countable|observed_external|"official_result":true/)
assert.match(good,/"pairing":null/); assert.match(good,/"evidence_kind":"synthetic_fixture"/); assert.match(source,/matched_pair_countable:true/)
console.log('type/signature/diagnostic-fixture/countability self-review: green')
NODE
git status --short
```

Expected: all tests exit `0` on `PHASE0_FINAL_SHA`; full stack ends `ALL SUITES GREEN`; base-relative dependency/lock proof, commit whitespace check, and placeholder scan are silent; self-review prints its exact green line; the final `git status --short` is empty. Do not push or create the PR without separate authorization.

## Sol final-review checklist

- Four v0 contracts, seven registry records, deterministic canonicalization, strict URL/revision/time/timezone/numeric/count validators, structured public safety, and multi-benchmark graph closure are executable.
- Repository fixtures are synthetic/unmatched/unqualified/diagnostic and derive zero pairs; only a test-memory `observed_external` aggregate exercises the true path.
- A derived pair requires exactly two reciprocal opposite roles, same provider/model, all controls, registry metric keys, recomputed case-set/scorer/source-fence/evaluator fingerprints, qualification receipts, distinct GoTry SHAs as the sole `gotry_sha` treatment, candidate closure to each run SHA, and zero hard/leakage violations; diagnostic registry defaults cannot become countable.
- TREK, TravelPlanner, ChinaTravel, TravelBench, tau2, LoCoMo, and BFCL use exact owners and independent entry/data/evaluator pins, structured rights determinations with source URLs, and exact metric label/scope/source maps; ChinaTravel familiar, TravelBench, and LoCoMo remain diagnostic-only, and LoCoMo v0 explicitly admits QA F1 only.
- No adapter, runner, Python runtime dependency, upstream payload, baseline/result, Agent change, or uplift claim enters Phase 0; all six state surfaces use the same boundary; the slice has one commit and one later PR boundary.
