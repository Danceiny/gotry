[English](persona-sim-report.md) | [简体中文](persona-sim-report.zh-CN.md)

# LLM-persona simulation of the M3 capture path

> Role: the usage contract and evidence boundary of `ts/scripts/persona-sim.ts` — a synthetic-only harness that drives simulated travellers through the real GoTry session logic to validate the M3 capture path end to end.
> Status: living contract; offline dry run verified on 2026-10-04, real-LLM batch not yet executed.
> Upstream: [roadmap](../roadmap.md) §3 M3 gate, [evaluation foundation](evaluation-foundation.md), [issue #22](https://github.com/Danceiny/gotry/issues/22).
> Downstream: `ts/scripts/persona-sim.ts`, `ts/src/m3-cohort.ts`, `scripts/run-all-tests.sh` §75/§76.

## Evidence boundary

Everything this harness produces is synthetic and is labelled as such in the bytes it writes. It counts as evidence for exactly three things: that the M3 capture path works end to end, that the funnel arithmetic in `ts/scripts/product-metrics.ts` is driven by real records rather than hand-written ones, and that the system-side measurements a session can observe for itself (interview friction, solver verdict, fact-gate claim traceability) are actually derivable.

It counts as evidence for nothing else. A persona is a language model reading a card, not a traveller. Simulated finalization and simulated NPS measure the card, not value delivered to a person. No record produced here can contribute to M3 or M4 exit, and two record-level facts enforce that independently of each other: every simulated participant is enrolled `test_or_staff=true`, so the scorer's own exclusion drops all of them and its eligible sample is 0 even if a manifest were relabelled; and the manifest carries `evidence_kind=synthetic_fixture`, which the scorer refuses to turn into `business_pass=true` whatever the numbers say. The capture store additionally refuses to mix simulated and real participants in one store or one evidence root. The M3 gate still requires an admitted 50–200 real seed-user evidence set.

The export attestation is a weaker, different claim and is described as such: it carries a keyed MAC, so it detects tampering by anyone who does not hold the capture key, and it proves the four files are the unmodified output of that store. It says nothing about whether the participants were real people — that is a fact about collection, which no digest can establish. Because the scorer excludes every simulated participant by design, the funnel numbers in this report are computed by the harness over its own outcomes, using the scorer's formulas, and are labelled as the simulation's numbers.

## Real and simulated surfaces

Real in every run: the deterministic interview (`ts/src/loop.ts` `interviewNext`), the translation seam and its spec/validation gate, the planning-window gate, the unified solver (`ts/src/unified.ts`) including the Erhai candidate-choice path, the deterministic plan renderer, and the registered `gotry_fact_gate` tool mounted by `ts/src/index.ts` `apply()` against a per-persona isolated `stateRoot` and reading that session's own bookable-fact registry.

Simulated in every run: the traveller. The persona's utterances, the decision to finalize and the NPS score all come from the persona model reading a persona card from `ts/data/persona-sim/personas.json`. Each card is grounded in material already in this repository — the "Try It" prompts in the [user guide](../user-guide.md) and the frozen prompt and ground truth in the [persona bench](persona-bench/README.md) — so a card documents a scenario the repository already claims to handle, rather than one invented to be easy.

The deck ships seven cards covering a hard-constraint no-match that must be told "infeasible", a two-week workation with a multi-leg chain, a slow-pace trip with parents, a red-eye that has to land before Monday work, a budget-tight student, a vague-wish drifter who never reaches a plan, and a companion arriving separately who answers in single words.

## Method: why this seam

The harness drives the product in-process through the same seam `ts/scripts/nightly-evidence.ts` already uses for M3 nightly evidence: `createOpenAICompatLlm` as the `LlmPort`, `newState`/`runTurn` as the multi-turn session, and `solveUnified` behind `realtimeSolvePort`. The product's own tools are mounted with `apply()` against an isolated `stateRoot`, exactly the way `ts/scripts/smoke.ts` does it, so the claim audit runs through the registered tool rather than a re-implementation of it.

The alternative was to boot `DeepSeekHarness` from `@deepseek-ai/dsh-sdk-client` against the real plugin profile, the way `scripts/booking-surface-package-proof.ts` does. That path additionally exercises the dsh runtime's own tool dispatch and the model's tool-selection behaviour, which this harness does not. It was rejected for this slice because it costs a runtime boot per session (the package proof pins a multi-second initialize budget and a teardown ladder on top), it needs a packed install to be faithful, and it would put the M3 capture path behind a dependency the existing M3 evidence producer does not use. Choosing the nightly seam keeps the capture path and the nightly evidence path on the same code, so a drift in one surfaces in the other. The gap is stated rather than hidden: tool-call selection by the product model is not measured here.

## How to run

The offline dry run needs no credentials, no network and no state: a local OpenAI-compatible fixture endpoint serves scripted replies for both models, and the whole pipeline — session, delivered plan, finalize decision, NPS, claim lock, cohort records, scorer — runs deterministically.

```bash
cd ts && npx tsx scripts/persona-sim.ts --dry-run                      # human-readable
cd ts && npx tsx scripts/persona-sim.ts --dry-run --format json        # machine-readable
cd ts && npx tsx scripts/persona-sim.ts --dry-run --persona erhai-weekend-unwind
```

A real batch is a separate, credentialed act. It spends money, so it is budget-gated, fail-closed on an unpriced model, and fail-closed when a provider omits usage (cost becomes unprovable). Without `LLM_API_KEY` it exits 0 in state `waiting_external_evidence` having written nothing and spent nothing — the same stop rule as `ts/scripts/nightly-evidence.ts`. The HMAC key is custodied outside this repository and is never printed.

```bash
cd ts && \
  LLM_API_KEY="$YOUR_KEY" \
  LLM_BASE_URL="$YOUR_BASE_URL" \
  LLM_MODEL=MiniMax-M2 \
  GOTRY_PERSONA_MODEL=MiniMax-M2 \
  GOTRY_PERSONA_BUDGET_USD=0.25 \
  GOTRY_M3_COHORT_HMAC_KEY="$YOUR_32_PLUS_CHAR_KEY" \
  npx tsx scripts/persona-sim.ts \
    --consent 'operator reviewed issue #22 synthetic persona scope' \
    --evidence-root "$HOME/gotry-evidence/persona-sim-$(date +%Y%m%d)" \
    --state-root "$HOME/gotry-evidence/persona-sim-$(date +%Y%m%d)-capture" \
    --concurrency 2 --format json
```

Both roots are mandatory for a real batch: a paid run must not write its evidence into a temp directory the harness then deletes. The budget is enforced between turns, not only between sessions, so two concurrent sessions cannot both run to completion past the limit; a batch that trips the gate still exports what it already paid for — the spend happened and the records are facts about it — reports `cost_over_budget`, and exits 3.

Exit codes: 0 for a completed batch or the waiting state, 1 for a fail-closed refusal, 3 when the budget gate stopped the batch early. The evidence root receives `manifest.json`, `cohort.jsonl`, `provenance.jsonl` and `export-attestation.json`, written all-or-nothing. `GOTRY_M3_COHORT_HMAC_KEY=… npx tsx scripts/m3-cohort.ts verify --evidence-root <dir>` re-derives every digest and checks the keyed MAC (it needs the key; without it the check would be recomputable by anyone), and `npx tsx scripts/product-metrics.ts --evidence-root <dir> --format json` scores it. Both will say `synthetic_fixture`, and the scorer will say `business_pass: false` with an eligible sample of 0.

If a capture is interrupted, `npx tsx scripts/m3-cohort.ts lock-status --state-root <dir>` reports whether a `lock_busy` is a live writer or a leftover from a killed one, and `unlock` clears only a lock whose recorded pid is gone.

## Sample dry-run output

Verbatim from `npx tsx scripts/persona-sim.ts --dry-run` on 2026-10-05, with the temporary evidence path elided. The stderr line is part of the real output and is discussed under limitations.

```text
[gotry] solveUnified aborted — solver_input_not_integer(求解器失败,不是「不可行」判定): solveUnified: Z3 整数编码只接受有限整数,下列输入不是(issue #620):yn0.bufferMin=NaN、yn0.originTransferMin=NaN、yn0.destTransferMin=NaN
# persona-sim (dry_run_complete) — SYNTHETIC ONLY, never M3/M4 evidence

- models: product=MiniMax-M2 persona=MiniMax-M2 real_llm=false
- cost: computed $0.028674 / budget $0.25 (real spend $0)
- evidence root: <temp>/evidence

| persona | turns | delivered | finalized | nps | solver | extracted | audited | invalid | gate | error |
|---|---|---|---|---|---|---|---|---|---|---|
| erhai-weekend-unwind | 1 | true | false | 6 | candidate_choice | 2 | 0 | 0 | blocked | - |
| krabi-dive-buddy-terse | 3 | true | true | 7 | feasible | 7 | 0 | 0 | blocked | - |
| phuket-with-parents | 3 | true | true | 8 | feasible | 6 | 0 | 0 | blocked | - |
| phuket-workation-multileg | 3 | true | true | 9 | feasible | 7 | 0 | 0 | blocked | - |
| redeye-dubai-monday | 2 | true | true | 9 | feasible | 7 | 0 | 0 | blocked | - |
| vague-wish-drifter | 3 | false | false | - | none | - | - | - | - | - |
| yunnan-budget-student | 1 | true | false | 4 | solver_error(solver_input_not_integer) | 0 | 0 | 0 | pass | - |

- harness funnel (simulation, computed here): delivered=6/7 finalized=4 finalization=0.666667 nps=0(n=6) claims extracted=29 audited=0 invalid=0 poi=unavailable errored=0
- scorer (excludes every simulated participant via test_or_staff): participants=0 finalization=unavailable nps=unavailable poi=unavailable test_or_staff_excluded=6
- business_pass: false — evidence_kind=synthetic_fixture cannot prove business pass
```

Read this as a capture-path result, not a product result. Six of seven personas reached a delivered plan, four finalized, and the drifter stayed in the interview and therefore produced no cohort record at all — which is how a real funnel would record it. The scorer line is all `unavailable` on purpose: all six records are `test_or_staff`, so its eligible set is empty, which is exactly the record-level exclusion that keeps simulated participants out of M3. The claim columns show why the POI rate is `unavailable` rather than a flattering 0%: the gate extracted 29 bookable claims and could adjudicate none of them, because no exact-date retrieval ran. The computed cost is the sealed price table applied to the fixture's reported token usage; real spend is zero.

## How the claim audit is derived

`locked_claims` and `invalid_claims` in each cohort record come from the registered `gotry_fact_gate` tool run on the delivered plan markdown, against the fact registry in that session's own isolated `stateRoot`. `locked_claims` is the **audited** denominator, not the extracted claim count: a claim joins it only when the registry could adjudicate it, i.e. it came back traceable or contradicted. `invalid_claims` counts only violations where the registry actively contradicts the artifact — `not_in_source`, `contradicted`, `airport_mapping_conflict`, `price_contradicted`, `fact_anchor_unknown`, `unconditional_check`, `self_transfer_called_through`, and the itinerary-invariant kinds. The extracted count, the traceable count, the per-kind breakdown and the gate verdict are all reported per persona.

Counting every extracted claim as audited would have been a flattering lie: with an empty registry a plan whose claims are all `route_unqueried` would record 0/N and the scorer would print a 0% POI rate with `pass=true` — an entirely unaudited plan scoring as a clean one. With the audited denominator, an empty registry yields `locked_claims=0`, which the scorer reports as `unavailable` with `pass=false`. That is the truth about a simulated run: no exact-date retrieval runs, so nothing is adjudicable.

What this is therefore not: a POI hallucination rate. An unverified claim is not a hallucinated one. The M3 metric's intent — audited invalid POI claims over locked audited claims — needs a human auditor comparing claims against ground truth. This harness cannot produce that number and does not pretend to; what it does establish is that the field is populated from a real measurement rather than by hand, and that an unaudited plan cannot masquerade as an accurate one.

## Limitations

The persona model decides finalization and NPS, so both are properties of the deck. Changing a card changes the funnel; the provenance digest recorded with every record is the SHA-256 of the exact persona system prompt, so a changed card is visible in the evidence rather than silent.

A session whose persona contract breaks (malformed JSON, a score for a plan it never saw, a finalize before delivery) is recorded as an error and contributes no cohort record. The same granularity applies to a capture write that fails and to a session that trips the budget mid-flight: the error is attached to that persona, the rest of the batch still exports. That is fail-closed but it biases the funnel, so the per-persona error list and the funnel's `errored` count are part of the output and must be read with the numbers.

The dry run does not exercise the slot-to-spec date-consistency gate: the fixture returns no slot extraction, so that gate takes its documented "no slots, no participation" branch. A real-LLM batch does exercise it.

`data/yunnan-pack.json` still fails `solveUnified` deterministically, and the persona deck keeps that case because the simulation is what surfaced it. The cause is now located and the outcome no longer lies (issue #620): leg `yn0` omits `buffer_min`, `origin_transfer_min` and `dest_transfer_min`, the v1 pack parser turns each missing field into `NaN`, and Z3's `Int.val` rejects a non-integer with a WASM `Assertion failed`. `solveUnified` now refuses to build that encoding at all, reports `solver_error.code = solver_input_not_integer` naming every offending field, and the harness classifies it as its own `solver_error` verdict instead of folding it into `infeasible`. Nothing in the user-facing reply says "infeasible" and no machine token reaches it. What remains open is the data: the three missing minutes are a real-world fact the pack's own `meta.reconcil` defers to founder calibration, so neither the parser nor this fix invents them.

The product model's tool-call selection is not measured, because the harness drives the session seam rather than the dsh runtime (see method). `ts/src/dsh-llm.ts` `chat()` bounds each request (`GOTRY_LLM_TIMEOUT_MS`, default 300 s) and fails with a typed `LlmRequestError`, but the harness's per-session deadline (`sessionDeadlineMs`, 180 s) is shorter than that default, so a stalled product provider is still attributed to the session (`persona_timeout`) rather than to the call; a lower `GOTRY_LLM_TIMEOUT_MS` surfaces it per call, recorded as `internal_error` with the `llm timeout:` detail.

The session's POI probe reaches a live `hbcli` backend when one is installed, and has no offline opt-in switch of its own. The harness scrubs `PATH` and `HOME` for the duration of a batch so that probe always takes its degraded path; the test suite asserts with a fetch spy that nothing outside `127.0.0.1` is contacted.

## Verification

`./scripts/run-all-tests.sh` §75 runs `ts/scripts/m3-cohort-tests.ts` (capture contract, the four synthetic-labelling falsifications each with its red baseline, a fully recomputed forgery that only the keyed MAC catches, all-or-nothing export into a partially occupied root, and writer-lock reclaim) and §76 runs `ts/scripts/persona-sim-tests.ts` (deck contract, the no-credential stop rule, the full offline pipeline, byte determinism, the record-level and manifest-level exclusions proven separately, the budget and pricing gates, the unsafe-state-root refusal, bounded turns and the PII sentinel). Both suites are offline and deterministic; neither writes outside a `mkdtemp` root, and §76's fetch spy throws on any host other than `127.0.0.1` rather than merely recording it, so a regression cannot carry a credential off the machine.
