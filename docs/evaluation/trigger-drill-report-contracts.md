[English](trigger-drill-report-contracts.md) | [简体中文](trigger-drill-report-contracts.zh-CN.md)

# Trigger drill report: three dormant trackers at contract level

> Role: record what three simulated-trigger drills (#340, #339, #429) actually proved at contract level, and what they explicitly did not prove.
> Status: living; the three trackers stay open and default-off.
> Upstream: [architecture.md](../architecture.md) D-39 and §10, [write-gate production design](../design/write-gate-production-design.md), [memory design](../design/memory-design.md), [loopx-inspired upgrades RFC](../rfc/loopx-inspired-upgrades-rfc.md).
> Downstream: reviewers of the three trackers, and whoever implements an admitted slice once a real trigger fires.

## 1. Evidence boundary (read first)

**A simulated trigger is not the real trigger.** Every result in this report carries the label `simulated_trigger_drill` / `fixture_contract`: the activation machinery was built and exercised against fixtures and mocks, so that when a real trigger appears the path is already proven. None of it satisfies a tracker's trigger condition.

Specifically, nothing here counts as:

- real-order, real-refund or WriteGate-admission evidence (#340);
- a real usage sample, a validated scenario vocabulary, or a city-scenario profile (#339);
- a named provider, a licence, a coverage/freshness measurement, or provider availability (#429);
- an M4/M5/M6 Exit, or a milestone exit of any kind.

All three trackers remain **open and default-off**. In code this is structural, not a convention: `OUTCOME_TRIGGER_FIRED`, `CITY_SCENARIO_TIER_TRIGGER_FIRED` and `D39_LIVE_ROUTE_TRIGGER_FIRED` are all frozen `false`; the supplier-outcome source registry, the city-scenario taxonomy registry and the live-route provider registry are all frozen empty; and no product file imports any of the three modules. The accepted narrow D-39 path of issue #341 is unchanged — not one byte of `ts/capabilities/ground-transfer.ts` was edited.

No network, no LLM, no credentials, no subprocess, no shared state. All work happened in an isolated worktree.

## 2. TL;DR

- Three pure contract modules plus three focused suites were added, all default-off with zero product callers: **295 assertions green** (135 + 79 + 81), typecheck exit 0, isolated smoke exit 0, kernel manifest gate zero drift.
- #340: the association key, the status alphabet, append-only/revocable projection, the negative list, and the guard that deviation calibration can never override a hard budget are all encoded and falsified.
- #339: only the **mechanism** ships — a versioned taxonomy schema with an **empty** registry. No tier content exists in code, and admission is refused before validation while the trigger is false. Candidate scenario vocabulary appears in §4.4 as an explicitly unvalidated hypothesis.
- #429: a nine-clause conformance gate that any future live-route adapter must pass. Run against the existing ground-transfer logic it found **three real gaps** (§5.4), one of which is reachable in product output today.
- Nothing was fixed in existing code: the gaps are reported with minimal repros for the owner to rule on.

## 3. Drill 1 — #340 outcome vs planning estimate

### 3.1 Trigger simulated

#340's real trigger is "supplier protocol and WriteGate admission in place, plus authorized real order/refund authority facts". It has not fired. The drill simulated it by replaying the **hotelbyte fake-CLI outcome vocabulary** as fixtures — read-only reuse of the words already observed in `ts/scripts/hotelbyte-spawn-e2e-tests.ts` and `ts/capabilities/hotelbyte-transaction.ts`. The real CLI was never invoked.

### 3.2 What was built and exercised

`ts/src/outcome-projection.ts` — pure, zero IO, injected clock, closed error-code set, fail-closed:

- **Association key**: four mandatory keys (plan estimate, immutable quote, supplier attempt, ledger intent idempotency key) with a deterministic derived `projectionKey`. No key is defaulted or derived from a sibling.
- **Currency and time basis**: reuses the fx-contract `MoneyAmount` / `NormalizedAmount` types. Deviation requires both sides pinned to **one declared valuation instant**; a cross-currency comparison works only through a real FX fact at that instant, and a mixed-instant basis is refused. No FX rate is ever guessed.
- **Status alphabet**: `pending / confirmed / failed / cancelled / refunded / unknown`. `confirmed` is the only settled success; `unknown` and `pending` are **never** success and **never** zero deviation — they return a typed refusal with no number at all, so there is no 0 to average by accident. The local ledger word `compensated` is refused by name as a supplier outcome, and the cancel service fee is refused as a refund amount.
- **Append-only, revocable projection**: replay of an idempotency key with the same payload is a zero-entry no-op; the same key with a different payload is a conflict, never an overwrite. A revocation is itself an appended entry — nothing is deleted or mutated — and the fold skips revoked observations. A **late** terminal observation (observed earlier than the last probe, arriving after it) is accepted and flagged; a terminal never regresses to an open status, and a terminal that the frozen lifecycle DAG cannot reach is an explicit conflict.
- **Negative list**: the evidence record is key-**allow**-listed (ten digest/pointer fields) with named refusals for sensitive order fields, plus a value scan for credential, document, mobile, email and URL shapes. An unlisted key is refused even when it looks harmless.
- **Calibration guard**: deviation produces bounded ppm advice for ranking and future estimate display only, with an explanation and its basis. Indeterminate outcomes are counted, never valued. A thin sample yields neutral. The hard budget verdict admits only an `AuthoritativeTotal` built from an immutable quote or a supplier final amount, so a calibrated amount is structurally unable to reach it.
- **Ingestion seam**: interface and data shape only. `ingestSupplierOutcome` refuses with `trigger_deferred` before reading any source.

### 3.3 Results

`ts/scripts/outcome-projection-tests.ts`: **135 assertions pass, exit 0**. Registered as run-all **§85**. No defect was found in existing code by this drill; the module is new, so its falsifications target its own guards (§7).

### 3.4 What only the real trigger can supply

A real-order E2E (needs M5 plus authorized real records); real deviation distributions; any calibration bound or minimum-sample constant justified by data; the actual supplier status words a live adapter will emit and their mapping; the admitted supplier-outcome source and its authorization basis; and whether `refunded` nets against the original charge in the way the aftercare surface of #233 expects.

## 4. Drill 2 — #339 city × scenario tiering

### 4.1 Trigger simulated

#339's real trigger is "reviewable real usage samples, with an explicit scenario vocabulary and success metric". It has not fired, and the tracker is explicit that a profile must not be fabricated from fixtures. So this drill simulated only the **shape** of admission: test-only probe entries whose city and scenario keys are meaningless placeholders (`city-a`, `scenario-x`), constructed by passing `{ triggerFired: true }` explicitly.

### 4.2 What was built and exercised

`ts/src/city-scenario-tier.ts` — mechanism only, no taxonomy content:

- **Versioned schema, empty registry**: `CITY_SCENARIO_TIER_REGISTRY` is frozen `[]` and the suite asserts that declaration is literally `= []` in source. `admitTierEntry` refuses with `trigger_not_fired` **before validating anything** while the gate is false, so no tier can enter from a fixture.
- **Mandatory provenance and retirement per tier**: an evidence grade from the RFC S2 ordering; a sample source whose admitted set has exactly one member, `real_usage_sample` (a fixture-sourced sample is refused by name); at least three reviewable sample references; an accountable reviewer; a freeze instant; a stated retirement condition; and a review deadline that must postdate the freeze.
- **Bounded modifier**: integer ppm within declared bounds, with the lower bound strictly above zero by design, so no tier can annihilate a candidate. Zero, negative, out-of-range, fractional and non-numeric values are all refused. A defective registry entry is refused at read time rather than silently clamped.
- **Neutral fallback, never a guess**: five stated reasons return the neutral ×1.0 modifier — trigger not fired, empty registry, unknown city, unknown scenario, conflicting evidence. A conflict surfaces both tier ids and elects no winner. A blank or non-string key is reported as a caller error instead of being silently neutralized.
- **Ranking only**: `applyTierRanking` has no filter, exclude, drop or threshold parameter, and no such field in its result rows. It keeps each candidate's original semantic score so the unmodified ranking is always recoverable, ties keep declaration order, and an internal invariant refuses any result whose candidate set is not exactly the input.

The declared bounds are drill-declared, not data-derived: the repo states the ranking **form** `semantic × bounded_modifier` but fixes no numeric interval anywhere, so the interval must be re-frozen from real samples.

### 4.3 Results

`ts/scripts/city-scenario-tier-tests.ts`: **79 assertions pass, exit 0**. Registered as run-all **§86**. The key falsification is a battery over eleven semantic scores by three registries, plus the hostile case of the lower-bound modifier applied to a zero semantic score: the candidate is never dropped.

Note on wiring: the only code that actually orders destination candidates today is in `ts/src/unified.ts`, which is kernel-pinned. A tier modifier therefore cannot be wired into live ranking without a kernel change — which is a separate, founder-level decision and is not part of this drill.

### 4.4 Hypothesis note (unvalidated; real samples required)

The following are **candidate scenario-vocabulary ideas drawn from repo documents**. They are unvalidated, they are deliberately absent from code, and real samples are required before any of them becomes a taxonomy member (#339 trigger). Three provenance tiers, strongest first:

1. **Already a closed set in code** (narrow, destination-pack routing rather than a tier): `erhai`, `workation`, `yunnan`, `generic` in `ts/src/dsh-llm.ts`, where `generic` deliberately fails closed and does not enter solving. `workation` is the only token that appears both in code and in the persona-bench analysis, making it the strongest-provenance candidate in the survey.
2. **GoTry's own designer-voice analysis** (`docs/evaluation/persona-bench/README.md`): workation and its work window; companion convergence (meet up / converge / travel together) as a second arrival chain; the red-eye arrival state; a weekend that is in fact shifted by a day. `docs/user-guide.md` adds: multi-leg trip with work windows, return visit, and an unwind/recuperate framing with a no-early-wake constraint.
3. **Archived competitor output — treat as a warning, not as vocabulary**: the richest cluster of city-area-to-scenario phrasing in `docs/evaluation/persona-bench/` is a verbatim archived competitor answer that the same bench explicitly criticises as an OTA sales guide rather than trip planning. Lifting its tags (nightlife, quiet, surf/dive, upscale resort, culture and food, shopping, backpacker, city centre, good views) would import exactly the persona the bench exists to reject.

Terms **absent** from both documents, and therefore not to be invented: business trip, family, honeymoon, solo, pet, senior, festival, conference, citywalk, foodie, ski, hiking, museum, luxury.

### 4.5 What only the real trigger can supply

The taxonomy members themselves and their city coverage; the scenario vocabulary and its success metric; the numeric modifier interval justified by data; the before/after ranking hypotheses with real counterexamples; per-tier sample references and reviewer; and the decision on whether any of this is wired into kernel ranking at all.

## 5. Drill 3 — #429 D-39 live route sources

### 5.1 Trigger simulated

#429 admits each wider D-39 path (live traffic, transit, rail, fare, address resolution) independently, each needing a named product use case plus the actual provider and access boundary plus reviewable authority/freshness/coverage evidence. No path's trigger has fired. The drill simulated "a named use case plus a candidate provider" at contract level: the use case is deliberately the already-accepted #341 shape (destination driving estimate, no fare authority), and the provider is an offline mock. No routing provider was contacted and no dependency was added.

### 5.2 What was built and exercised

`ts/capabilities/route-provider-conformance.ts` — the admission gate any future live-route adapter must pass. It declares zero imports (so zero network, cache, timer or filesystem surface, and no coupling to the evaluate/solve kernel), and the suite asserts that import surface mechanically.

Eight fault modes are declared and driven: unavailable, stale, mismatched direction, mode relabel, estimate as live traffic, challenge, rate limited, partial result. Nine conformance clauses must all pass:

- **direction binding** — verified against the **response**'s echoed origin/destination, never assumed from the request; the swapped pair is a different fact;
- **mode isolation** — the provider's own mode claim must equal the use case's, so driving is never relabelled as transit nor the reverse, and a response with no explicit mode claim is refused rather than labelled by the request;
- **evidence class isolation** — an estimate claiming live traffic is refused as an escalation, and a weaker class filling a stronger promise is refused as a shortfall;
- **freshness contract** — a path without a declared window is not admitted, and an observation postdating the gate clock is refused (a provider publication timestamp is not a host observation instant);
- **source identity** — provider id, legal basis, access boundary and the exact reviewed source SHA are mandatory, and a read-only use case cannot be served by a transaction-boundary provider;
- **fault fail-closed** — an unclassified failure is refused rather than treated as a licence to degrade;
- **static fallback preserved** — a refusal leaves the static mode, minutes, price and the original price label byte-identical;
- **fare authority separate** — a route provider is never its own fare authority;
- **fault detail sanitized** — markup, credential assignments and URLs never reach the evidence surface, and the provider fragment is length-bounded.

The gate is itself falsifiable: an adapter whose fault is silently accepted flips that clause to fail, and an **unprobed** clause is reported as fail and blocks admission, because "untested" is not conformance.

### 5.3 Results

`ts/scripts/route-provider-conformance-tests.ts`: **81 assertions pass, exit 0**. Registered as run-all **§87**. Driven against the existing ground-transfer logic, six clauses pass today and three are gaps:

| Clause | Existing ground-transfer behaviour |
|---|---|
| fare authority separate | Pass — a provider-asserted fare is not admitted; static price and label stand |
| evidence class isolation (escalating direction) | Pass — a payload claiming live traffic still yields `not-live-route-estimate` |
| static fallback preserved | Pass — an unavailable provider leaves mode, minutes, price and label unchanged |
| fault fail-closed | Pass — provider error and self-contradictory route both fall back, no minutes override |
| direction binding (request side) | Pass — each direction is queried with its own ordered pair; no cache sharing |
| freshness contract | Pass — a stale cache entry is re-queried and, on failure, reported stale, never served as a hit |
| mode isolation | **GAP-429-1** |
| direction binding (response side) | **GAP-429-2** |
| fault detail sanitized | **GAP-429-3** |

### 5.4 Defects found in existing code

These were found by the drill and are **not fixed here**: `ts/capabilities/ground-transfer.ts` was not edited. The suite pins current behaviour as characterization assertions labelled `GAP-429-n`, so run-all stays green and a future fix must flip them.

**GAP-429-1 (mode isolation).** `parseRouteResult` keeps only `provider`, `distanceM`, `durationS`, `polyline`, `steps`. A provider payload asserting a contradicting `mode` is silently dropped, and the route fact is labelled `mode: 'driving'` from the request. Its duration is then bound into the solver.

```ts
// provider returns a TRANSIT route under the driving tool
provider: async () => ({ provider: 'mock-transit', distanceM: 30000, durationS: 3600, mode: 'transit' })
// observed: resolution.applied === true
//           resolution.outbound.routeFact.mode === 'driving'
//           candidates[0].destTransfers[0].minutesOut === 60   // transit minutes bound as driving
```

Severity today is low — the only wired provider is the registered `map_driving_route` tool, which is driving by construction — but this is exactly the clause a transit or rail path must satisfy, so the check must exist before any such adapter is admitted.

**GAP-429-2 (direction binding, response side).** Direction binding is enforced on the request side (the cache key includes direction and the ordered pair) but the response is never verified against what was requested. A provider that resolves a different origin/destination has its duration bound as the airport transfer.

```ts
// provider routes an entirely different O/D and says so in its own fields
provider: async () => ({ provider: 'mock-wrong-od', distanceM: 999, durationS: 60,
                         resolvedOrigin: '0,0', resolvedDestination: '1,1' })
// observed: resolution.applied === true
//           resolution.outbound.routeFact.origin.longitude === 100.1   // the REQUESTED pair, echoed back
//           candidates[0].destTransfers[0].minutesOut === 1            // a 999 m / 60 s route as the transfer
```

**GAP-429-3 (fault detail sanitized) — product-reachable.** `safeErrorMessage` only strips newlines and truncates to 400 characters, so a provider-thrown error message reaches `fallbackReason` verbatim, and `exposeGroundTransferEvidence` carries it into the tool result and into each matching verdict's `transfer_evidence`. That function is wired in the live product path at `ts/src/index.ts:801`, reached from the registered feasibility tool.

```ts
provider: async () => { throw new Error(
  'HTTP 403 <html><body>Please complete the CAPTCHA. token=abc123 cookie=sid=XYZ ...</body></html>') }
// observed: resolution.outbound.fallbackReason contains 'token=abc123' and '<html>'
//           JSON.stringify(exposeGroundTransferEvidence({verdicts:[...]}, resolution)) contains 'token=abc123'
```

Today's wired provider throws either a fixed `GROUND_TRANSFER_*` string or `map_driving_route failed: <nested tool error>`, so the channel currently carries a dsh tool error message rather than raw provider markup. The leak becomes material the moment a live route adapter is wired — that is, on exactly the #429 path. The remedy shape already exists and is tested: `sanitizeFaultDetail` makes the same string safe, and `faultDetailLeak` flags it.

### 5.5 What only the real trigger can supply

The provider identity, licence and quota conditions; actual coverage and freshness measurements; a separately authoritative fare source; an authorized minimal real path recorded at an exact source SHA; and the per-path founder decision that admits any of live traffic, transit, rail, fare or address resolution.

## 6. Verification record (commands and exit codes)

Baseline before the work, at `origin/main` 7077695: typecheck exit 0, isolated smoke exit 0, existing ground-transfer suite exit 0. All commands below were run from the isolated worktree after the three commits.

```text
cd ts && npx tsx scripts/outcome-projection-tests.ts        exit 0   135 pass
cd ts && npx tsx scripts/city-scenario-tier-tests.ts        exit 0    79 pass
cd ts && npx tsx scripts/route-provider-conformance-tests.ts exit 0   81 pass
cd ts && npx tsc --noEmit                                   exit 0
cd ts && npx tsx scripts/smoke.ts                           exit 0   SMOKE OK
cd ts && npx tsx scripts/kernel-manifest-gate.ts            exit 0   zero drift, kernel 5/5 loaded
cd ts && npx tsx scripts/kernel-manifest-tests.ts           exit 0   §1-§7 green
node scripts/check-docs-i18n.mjs                            exit 0   86 bilingual pairs
node scripts/check-doc-readability.mjs                      exit 0   8 reader-facing files
bash -n scripts/run-all-tests.sh                            exit 0
```

The full `scripts/run-all-tests.sh` was deliberately **not** run here: it binds fixed ports and is CPU-heavy, and several agents were working in parallel. The integrator runs it serially. Sections §85, §86 and §87 were appended at the end of that script in the existing format.

## 7. Red baselines (falsifications shown red, then reverted)

Each mutation below was applied to the new module, observed red, and reverted; the suite returned to green and typecheck stayed at exit 0.

```text
#340  drop the calibrated-amount guard in hardBudgetVerdict
      -> 1 FAIL: "a calibrated amount smuggled into the hard budget verdict is refused"  (exit 1)
#340  let `unknown` be deviation-comparable
      -> 5 FAIL incl. "unknown is refused, NOT reported as zero deviation"               (exit 1)
#339  add a score filter to applyTierRanking
      -> 15 FAIL incl. the no-hard-filter falsification battery                          (exit 1)
#339  let conflicting evidence silently elect the first tier
      -> 3 FAIL incl. "conflicting evidence -> neutral, no winner elected"               (exit 1)
#429  drop response-side direction binding
      -> 3 FAIL incl. "expected refusal direction_mismatch, got ADMISSION"               (exit 1)
#429  disable fault-detail scrubbing
      -> 8 FAIL incl. "the cookie and token values never survive sanitization"           (exit 1)
```

## 8. Boundaries not crossed

No kernel-pinned file was touched (`unified.ts`, `model.ts`, `state-ledger.ts`, `bookable-facts.ts`, `artifact-gate.ts`), and the kernel manifest gate reports zero drift. `ts/capabilities/ground-transfer.ts` was not edited despite the three gaps found in it. No shared authority document was edited: facts that the integrator may want to reconcile are listed in the hand-back report rather than written into `architecture.md`, `roadmap.md`, the root README or release notes. No dependency was added and `package.json` was not touched — the three new modules have zero product callers and therefore do not ship, following the same precedent as the FX, geo-atlas and session-zones contract slices. No state directory, user home path or credential store was read or written.
