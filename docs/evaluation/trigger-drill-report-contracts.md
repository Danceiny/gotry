[English](trigger-drill-report-contracts.md) | [简体中文](trigger-drill-report-contracts.zh-CN.md)

# Trigger drill report: three dormant trackers at contract level

> Role: record what three simulated-trigger drills (#340, #339, #429) actually proved at contract level, and what they explicitly did not prove.
> Status: living; the three drill trackers (#340, #339, #429) were closed on 2026-10-05 as **deferred, not completed** — every path below stays default-off, and a real trigger needs a new issue.
> Upstream: [architecture.md](../architecture.md) D-39 and §10, [write-gate production design](../design/write-gate-production-design.md), [memory design](../design/memory-design.md), [loopx-inspired upgrades RFC](../rfc/loopx-inspired-upgrades-rfc.md).
> Downstream: reviewers of the three trackers, and whoever implements an admitted slice once a real trigger fires.

## 1. Evidence boundary (read first)

**A simulated trigger is not the real trigger.** Every result in this report carries the label `simulated_trigger_drill` / `fixture_contract`: the activation machinery was built and exercised against fixtures and mocks, so that when a real trigger appears the path is already proven. None of it satisfies a tracker's trigger condition.

Specifically, nothing here counts as:

- real-order, real-refund or WriteGate-admission evidence (#340);
- a real usage sample, a validated scenario vocabulary, or a city-scenario profile (#339);
- a named provider, a licence, a coverage/freshness measurement, or provider availability (#429);
- an M4/M5/M6 Exit, or a milestone exit of any kind.

All three trackers were **closed on 2026-10-05 as deferred — not completed** — and every path remains **default-off**. In code this is structural, not a convention: `OUTCOME_TRIGGER_FIRED`, `CITY_SCENARIO_TIER_TRIGGER_FIRED` and `D39_LIVE_ROUTE_TRIGGER_FIRED` are all frozen `false`; the supplier-outcome source registry, the city-scenario taxonomy registry and the live-route provider registry are all frozen empty; and no product file imports any of the three modules.

One exception to "nothing in the product path changed", stated plainly: the drill found a product-reachable information leak in the accepted narrow D-39 path, and that one defect **was fixed** — `ts/capabilities/ground-transfer.ts` now routes its provider-failure text through the shared sanitizer (§5.4, GAP-429-3). That is a safety fix to an existing surface, not an admission of any new path: no provider is named, no path is admitted, and the resolution semantics, reason prefixes and static fallback are byte-identical. On 2026-10-05 a follow-up pass closed the other two D-39 contract gaps the same way (§5.4, GAP-429-1/2): the provider's own declared mode and resolved endpoints are verified when present, and a contradiction fails closed to the static estimate. Also not an admission — still no provider named, still no path admitted, and every existing reason string and result byte-identical.

No network, no LLM, no credentials, no subprocess, no shared state. All work happened in an isolated worktree.

## 2. TL;DR

- Three pure contract modules plus three focused suites were added, all default-off with zero product callers: **345 assertions green** (155 + 83 + 107, the last count including the 2026-10-05 GAP-429-1/2 regressions), typecheck exit 0, isolated smoke exit 0, kernel manifest gate zero drift.
- #340: the association key, the status alphabet, append-only/revocable projection, the negative list, and the guard that deviation calibration can never override a hard budget are all encoded and falsified.
- #339: only the **mechanism** ships — a versioned taxonomy schema with an **empty** registry. No tier content exists in code, and admission is refused before validation while the trigger is false. Candidate scenario vocabulary appears in §4.4 as an explicitly unvalidated hypothesis.
- #429: a nine-clause conformance gate that any future live-route adapter must pass. Run against the existing ground-transfer logic it found **three real gaps** (§5.4).
- **All three gaps are now fixed**: GAP-429-3 (a provider error body reaching the tool result) in this lane, and the two dormant ones (GAP-429-1/2: response-side mode and direction binding) in the 2026-10-05 follow-up, which flipped their pinned characterization assertions into refusal regressions.

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

`ts/capabilities/route-provider-conformance.ts` — the admission gate any future live-route adapter must pass. Its only import is the pure sibling sanitizer, it reads no clock (the caller must inject `now`), and it has zero network, cache, timer or filesystem surface and no coupling to the evaluate/solve kernel; the suite asserts that import surface mechanically.

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

`ts/scripts/route-provider-conformance-tests.ts`: **107 assertions pass, exit 0**. Registered as run-all **§87**. Driven against the existing ground-transfer logic, all nine clauses now pass — three of them only after the fixes recorded below:

| Clause | Existing ground-transfer behaviour |
|---|---|
| fare authority separate | Pass — a provider-asserted fare is not admitted; static price and label stand |
| evidence class isolation (escalating direction) | Pass — a payload claiming live traffic still yields `not-live-route-estimate` |
| static fallback preserved | Pass — an unavailable provider leaves mode, minutes, price and label unchanged |
| fault fail-closed | Pass — provider error and self-contradictory route both fall back, no minutes override |
| direction binding (request side) | Pass — each direction is queried with its own ordered pair; no cache sharing |
| freshness contract | Pass — a stale cache entry is re-queried and, on failure, reported stale, never served as a hit |
| fault detail sanitized | Pass **after the GAP-429-3 fix in this lane** (was a leak) |
| mode isolation | Pass **after the GAP-429-1 fix (2026-10-05)** — a declared mode other than driving is refused |
| direction binding (response side) | Pass **after the GAP-429-2 fix (2026-10-05)** — a resolved origin/destination outside the tolerance is refused |

### 5.4 Defects found in existing code

Three defects were found in `ts/capabilities/ground-transfer.ts`. GAP-429-3 was product-reachable and **was fixed in this lane**. GAP-429-1 and GAP-429-2 were genuinely dormant (no provider exists that could trigger them today) and stayed pinned as characterization assertions labelled `GAP-429-n` until the owner ruled on the contract change; the founder ruled on **2026-10-05** to fix them, so **all three are now fixed** and the two pinned assertions are flipped refusal regressions in run-all **§87**.

**GAP-429-1 (mode isolation) — FIXED 2026-10-05.** Before: `parseRouteResult` kept only `provider`, `distanceM`, `durationS`, `polyline`, `steps`, so a provider payload asserting a contradicting `mode` was silently dropped, the route fact was labelled `mode: 'driving'` from the request, and its duration was bound into the solver. Now: `PublicMapDrivingRouteResult` carries the provider's own optional `mode`, and a declared mode other than `driving` is refused with `mode_mismatch:<direction>:<detail>` — the existing `<code>:<direction>:<detail>` reason shape, with the conformance gate's own code name — and the static estimate stands.

```ts
// provider returns a TRANSIT route under the driving tool
provider: async () => ({ provider: 'mock-transit', distanceM: 30000, durationS: 3600, mode: 'transit' })
// now: resolution.applied === false
//      resolution.outbound.fallbackReason startsWith 'mode_mismatch:outbound:'
//      resolution.outbound.routeFact === undefined
//      candidates[0].destTransfers[0].minutesOut === undefined   // transit minutes never bound
```

Severity today is still low — the only wired provider is the registered `map_driving_route` tool, which is driving by construction — but this is exactly the clause a transit or rail path must satisfy, and the check now exists before any such adapter can be admitted.

**GAP-429-2 (direction binding, response side) — FIXED 2026-10-05.** Before: direction binding was enforced on the request side (the cache key includes direction and the ordered pair) but the response was never verified against what was requested, so a provider that resolved a different origin/destination had its duration bound as the airport transfer. Now: the optional `resolvedOrigin` / `resolvedDestination` are compared against the pair sent for that direction within `GROUND_TRANSFER_ECHO_TOLERANCE_DEG` (1e-4 degrees, about 11 m — a road-node snap still matches, a different place does not), and a mismatch is refused with `direction_mismatch:<direction>:<detail>`. An echo that cannot be parsed is refused too: present-but-unverifiable fails closed rather than being assumed to be the requested pair. A refusal writes nothing to the cache, so it can never be served later as a cache hit.

```ts
// provider routes an entirely different O/D and says so in its own fields
provider: async () => ({ provider: 'mock-wrong-od', distanceM: 999, durationS: 60,
                         resolvedOrigin: '0,0', resolvedDestination: '1,1' })
// now: resolution.applied === false
//      resolution.outbound.fallbackReason startsWith 'direction_mismatch:outbound:'
//      candidates[0].destTransfers[0].minutesOut === undefined   // the 999 m / 60 s route never binds
```

All three fields stay **optional**, and absent means unverifiable — accepted only because the sole wired provider is driving-only and echoes no origin/destination, which is why every existing reason string and result is byte-identical and `ts/scripts/ground-transfer-tests.ts` passes unchanged. Any future non-driving or address-resolving adapter must supply them; the conformance gate's `mode_isolation` and `direction_binding` clauses already refuse an adapter that does not. A provider-authored claim quoted inside a refusal reason goes through the shared sanitizer first, so the GAP-429-3 boundary holds for the new reasons as well.

**GAP-429-3 (fault detail sanitized) — product-reachable, FIXED.** The pre-fix `safeErrorMessage` only stripped newlines and truncated to 400 characters, so a provider-thrown error message reached `fallbackReason` verbatim, and `exposeGroundTransferEvidence` carried it into the tool result and into each matching verdict's `transfer_evidence`. That function is wired in the live product path at `ts/src/index.ts:801`, reached from the registered feasibility tool, with `createPublicMapDrivingRouteProvider` as the default provider — so this was a live information-leak channel, not a hypothetical one.

The fix extracts the sanitizer into `ts/capabilities/provider-detail-sanitize.ts` (pure, zero imports) so one implementation serves both the #429 conformance gate and the live path, and routes `safeErrorMessage` through it. The historical 400-character bound and the `unknown provider error` empty-case wording are preserved, so every existing reason string is byte-identical.

```ts
provider: async () => { throw new Error(
  'HTTP 403 <html><body>Please complete the CAPTCHA. token=abc123 cookie=sid=XYZ ...</body></html>') }
// before: resolution.outbound.fallbackReason contained 'token=abc123' and '<html>'
//         JSON.stringify(exposeGroundTransferEvidence({verdicts:[...]}, resolution)) contained 'token=abc123'
// after:  'map_driving_route_provider_error:outbound:HTTP 403 [markup-redacted][markup-redacted]
//          Please complete the CAPTCHA. [credential-redacted] [credential-redacted] ...'
//         — classification prefix intact, redaction explicit and auditable, leak check clean
```

Regression coverage is in run-all §87 and runs through the **real** resolution path: a throwing provider carrying markup, a token and a cookie, asserted clean on the outbound reason, the return reason, the aggregate reason and the `exposeGroundTransferEvidence` output. A loop over five already-safe provider messages (including both fixed `GROUND_TRANSFER_*` strings and `map_driving_route failed: ...`) asserts byte-identical pass-through, and the existing `ground-transfer-tests.ts` suite passes unchanged both with and without the fix — so no behaviour changed for anything that was already safe. The only normalization difference is that runs of whitespace now collapse to a single space, where previously only newlines did.

### 5.4a The ruling that closed GAP-429-1 and GAP-429-2

Both were latent rather than live, which is why the drill pinned them instead of fixing them: the only wired provider is the registered `map_driving_route` tool, driving-only by construction and with no origin/destination echo at all, so neither gap had a path to fire. Closing them meant widening `PublicMapDrivingRouteResult` to carry the provider's own mode and resolved endpoints and deciding what to do when a provider omits them — a contract change to the accepted #341 boundary, and therefore the owner's call, not a drill's.

The founder ruled on **2026-10-05**: fix both, with the fields optional and the absent case unchanged. The implementation is the one the conformance gate already specified, so the gate and the product path now refuse the same payload with the same code. Red baseline held: with the capability fix reverted the flipped assertions go red (7 failures, exit 1), and with it restored the suite is green again at 107 assertions, `ground-transfer-tests.ts` passing unchanged in both states.

### 5.5 What only the real trigger can supply

The provider identity, licence and quota conditions; actual coverage and freshness measurements; a separately authoritative fare source; an authorized minimal real path recorded at an exact source SHA; and the per-path founder decision that admits any of live traffic, transit, rail, fare or address resolution.

## 6. Verification record (commands and exit codes)

Baseline before the work, at `origin/main` 7077695: typecheck exit 0, isolated smoke exit 0, existing ground-transfer suite exit 0. All commands below were run from the isolated worktree after the three commits.

```text
cd ts && npx tsx scripts/outcome-projection-tests.ts         exit 0   155 pass
cd ts && npx tsx scripts/city-scenario-tier-tests.ts         exit 0    83 pass
cd ts && npx tsx scripts/route-provider-conformance-tests.ts exit 0    95 pass
cd ts && GOTRY_SESSION_LIVE=0 npx tsx scripts/ground-transfer-tests.ts  exit 0   issue #341 suite OK
cd ts && npx tsx scripts/map-tools-vendor-package-proof.ts   exit 0   vendored map proof OK
cd ts && npx tsc --noEmit                                    exit 0
cd ts && npx tsx scripts/smoke.ts                            exit 0   SMOKE OK
cd ts && npx tsx scripts/kernel-manifest-gate.ts             exit 0   zero drift, kernel 5/5 loaded
cd ts && npx tsx scripts/kernel-manifest-tests.ts            exit 0   §1-§7 green
node scripts/check-docs-i18n.mjs                             exit 0   87 bilingual pairs
node scripts/check-doc-readability.mjs                       exit 0   8 reader-facing files
node scripts/check-doc-readability.mjs --self-test            exit 0   8 negatives + 26 fixtures
bash -n scripts/run-all-tests.sh                             exit 0
```

The full `scripts/run-all-tests.sh` was deliberately **not** run here: it binds fixed ports and is CPU-heavy, and several agents were working in parallel. The integrator runs it serially. Sections §85, §86 and §87 were appended at the end of that script in the existing format.

## 7. Red baselines (falsifications shown red, then reverted)

Each mutation below was applied to the new module, observed red, and reverted; the suite returned to green and typecheck stayed at exit 0.

```text
#340  drop the calibrated-amount guard in hardBudgetVerdict
      -> 1 FAIL: "a calibrated amount smuggled into the hard budget verdict is refused"  (exit 1)
#340  let `unknown` be deviation-comparable
      -> 5 FAIL incl. "unknown is refused, NOT reported as zero deviation"               (exit 1)
#340  restore the UNANCHORED document-number pattern
      -> 12 FAIL: legitimate digests with a 15+ digit run refused as an ID               (exit 1)
#339  add a score filter to applyTierRanking
      -> 15 FAIL incl. the no-hard-filter falsification battery                          (exit 1)
#339  let conflicting evidence silently elect the first tier
      -> 3 FAIL incl. "conflicting evidence -> neutral, no winner elected"               (exit 1)
#339  drop the non-negative semantic guard
      -> 2 FAIL incl. "a NEGATIVE semantic score is refused"                             (exit 1)
#429  drop response-side direction binding (conformance gate)
      -> 3 FAIL incl. "expected refusal direction_mismatch, got ADMISSION"               (exit 1)
#429  disable fault-detail scrubbing (conformance gate)
      -> 8 FAIL incl. "the cookie and token values never survive sanitization"           (exit 1)
#429  restore the pre-fix safeErrorMessage in ground-transfer.ts
      -> 8 FAIL incl. "exposeGroundTransferEvidence carries no provider body"            (exit 1)
      and ground-transfer-tests.ts stays exit 0 BOTH ways -> the fix changes no behaviour
```

One mutation was initially NOT falsifiable and that is itself a finding: a hex-digest exemption branch shadowed the anchored pattern, so unanchoring it produced zero failures. The redundant branch was removed rather than kept as untestable defence, leaving one mechanism (per-leaf scan plus anchors) that the red baseline above actually bites.

## 8. Boundaries not crossed

Scope note: this section records the drill lane itself. The later 2026-10-05 GAP-429-1/2 pass (§5.4) edited `ts/capabilities/ground-transfer.ts`, its §87 drill suite and the D-39 row of `architecture.md` — still no kernel-pinned file, no dependency and no admitted path.

No kernel-pinned file was touched (`unified.ts`, `model.ts`, `state-ledger.ts`, `bookable-facts.ts`, `artifact-gate.ts`), and the kernel manifest gate reports zero drift. `ts/capabilities/ground-transfer.ts` was edited in exactly one respect — its provider-failure text now passes through the shared sanitizer (GAP-429-3) — with the resolution semantics, reason prefixes, length bound, empty-case wording and static fallback all unchanged and the existing suite green both before and after. No shared authority document was edited: facts that the integrator may want to reconcile are listed in the hand-back report rather than written into `architecture.md`, `roadmap.md`, the root README or release notes. No dependency was added and `package.json` was not touched — the three new contract modules have zero product callers and therefore do not ship, following the same precedent as the FX, geo-atlas and session-zones contract slices. The one module that IS now product-reachable is the pure sanitizer, which has zero imports, zero IO and no clock; the #429 conformance gate itself stays free of product callers. No state directory, user home path or credential store was read or written.
