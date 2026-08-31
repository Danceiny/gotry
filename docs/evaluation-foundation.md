# Evaluation Phase 0 foundation

## Scope

Phase 0 provides registry, case, run-receipt, and failure-cluster v0 contracts plus deterministic validators. It installs and executes no benchmark adapter, external runner, or official evaluator.

The versioned cadence policy covers PR, nightly, weekly, and milestone planning. Its pure planner returns admission, `pass^k`, cost/wall/tool budgets, human-calibration requirements, failure-registry routing, and the 3–5 optimization-PR synthesis window. It never schedules or launches an adapter, spends a budget, or generates a benchmark score.

## Ownership and storage

GoTry git owns the TypeScript contracts, seven-row public metadata registry, and synthetic diagnostic fixtures. Upstream prompts, answers, gold, trajectories, judge/evaluator payloads, private user material, credentials, and absolute paths remain outside this repository. Every `license.upstream_rights` code/data/evaluator determination carries a value, declared-or-not-separately-declared status, and exact verification URL; `metadata_only_no_upstream_payload` is GoTry's stricter storage policy.

## Admission

Each benchmark has independent official-entry, data, and evaluator HTTPS pins with revision kind/value and source scope. `not_separately_declared` is an explicit unknown. Every native metric maps one stable receipt key to its exact upstream label, scope, and source URL. Registry source-fence category names are metadata; publishable case/run/failure values are structurally traversed for non-empty credentials, absolute paths, and raw sensitive payloads.

A case fixes isolated state, canonical UTC instant, UTC/IANA timezone, finite budgets, forbidden writes, scorer revision, and four literal-false safety flags. A repository run has `evidence_kind=synthetic_fixture`, `pairing=null`, `official_result=false`, null qualification receipts, and `fixture_only=true`. It can never be countable. Failure clusters close all run/case links to their exact benchmark set.

## Aggregate countability

`matched_pair_countable` exists only in derived output. Admission requires exactly two `observed_external` receipts with one reciprocal baseline/treatment pair, succeeded terminal states, the same provider/model, case, benchmark, protocol, model parameters, scorer, tools, source fence, integrity, evaluator, and native metric keys; distinct baseline/treatment GoTry SHAs as the sole treatment variable `gotry_sha`; candidate fingerprints recomputed from the canonical `{ treatment_variable: 'gotry_sha', gotry_sha }` object; zero hard/leakage hits; a countable registry default; and non-null official-evaluator/source-fence/integrity evidence receipts. A caller-supplied `EvaluationEvidenceResolverV0` must resolve six public-safe artifacts (three per run); each artifact is canonically fingerprinted and closed to run identity, binding SHA, evaluator metrics, source-fence input digest, and integrity candidate/control values. Case-set, scorer, source-fence, and evaluator fingerprints are recomputed from the aggregate registry/case objects rather than trusted from receipt booleans.

The repository known-good fixture derives zero pairs. The focused test constructs one in-memory `observed_external` object solely to falsify aggregate admission logic. That object is not written to git and is not a baseline, production result, official score, or Agent-quality evidence.

## Verification and next phase

Run `cd ts && npx tsx scripts/evaluation-contract-tests.ts && npx tsx scripts/evaluation-cadence-tests.ts`, then `./scripts/run-all-tests.sh`. An adapter, external evaluator execution, result receipt, baseline, or Agent change requires a separately approved later plan and PR. Foundation and adapter work is not an Agent optimization round and does not create a new round comment in Discussion #78.
