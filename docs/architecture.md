[English](architecture.md) | [简体中文](architecture.zh-CN.md)

# GoTry Technical Documentation (Single Technical Authority)

> Position: current system shape, durable architecture decisions, and open technical obligations.
> Status: living.
> Audience: maintainers and delivery agents. Start with §1 for the product shape, §8 for decisions, and §10 for open work.
> History boundary: release chronology belongs in [release notes](release-notes.md), closed obligations in the [debt archive](debt-archive.md), and line-level implementation history in Git.

**At a glance**

- GoTry is an evidence-first AI travel agent: models interpret and explain; typed, deterministic components decide and calculate; writes remain gated.
- Five layers stay distinct: interaction, orchestration, unified trip model and solving, data/effects, and delivery governance.
- Local and Web forms share tenant-scoped ledger semantics, capability contracts, source evidence, and authorization boundaries.
- Booking Copilot is a read-only planner inside the existing booking workspace. It does not own search facts, Checkout, `Book`, payment, or guest data.
- Current engineering proofs do not close real-user cohorts, supplier inventory, Booking recovery, transaction, benchmark uplift, or B2B pilot gates.

**Table of contents**

| | | | |
|---|---|---|---|
| [1 What the system is](#1-what-the-system-is) | [2 Overall architecture](#2-overall-architecture-five-layers-and-current-state) | [3 Code map](#3-code-map-what-each-module-is) | [4 Unified itinerary model](#4-unified-itinerary-model-domain-core-only-solve-entry) |
| [5 Conversation loop](#5-conversation-loop-l2) | [6 Data and runtime](#6-data-and-runtime) | [7 Testing and verification](#7-testing-and-verification-strategy) | [8 ADR](#8-adr) |
| [9 Evolution](#9-evolution) | [10 Debt register](#10-debt-register) | [11 Freshness mechanism](#11-freshness-mechanism) | [12 Document map](#12-document-map) |

---

## 1. What the system is

> This section describes the current system shape. Change chronology belongs in §9, release history in [release notes](release-notes.md), and closed debt in the [debt archive](debt-archive.md).

GoTry is an evidence-first AI travel agent for the journey from one departure to the next. The model interprets intent and explains choices; typed contracts, deterministic code, and explicit authorization gates decide what can be trusted or executed.

### 1.1 Delivery form and entry

| Concern | Current form |
|---|---|
| User entry | `./gotry` in a checkout, or `npx @danceiny/gotry@latest web` from npm |
| Runtime | TypeScript/ESM on Node `>=22.15.0`, using the selected DSH provider route |
| Product shape | Local and Web forms share the same tool contracts, evidence rules, and ledger semantics |
| Version authority | `package.json`, npm dist-tags, and [release notes](release-notes.md) |
| License | MIT |

### 1.2 Capability surface

The registered tool inventory lives in code; this document names stable capability classes rather than copying counts or per-issue implementation notes.

| Capability | Current boundary | Detailed authority |
|---|---|---|
| Planning and decision | Motivation interview, feasibility, itinerary construction, and multiple-choice gates; arithmetic and constraint solving stay in code. | §3–§5; [tool contracts](tools.md) |
| Evidence retrieval | Hotel, flight, rail, weather, maps, web, video, and user-session sources return typed observations with source and freshness metadata. A miss, challenge, malformed response, and transport failure remain distinct. | [data sources](data-sources.md); [session RFC](rfc/user-session-data-rfc.md) |
| Artifacts | Work orders and itinerary Markdown/HTML can be listed and read as source. Generation consumes registered facts; preview and opt-in local review are separate host capabilities. | [artifact fact gate](#819-single-source-of-bookable-facts--artifact-fact-gate); [Lavish contract](design/lavish-local.md) |
| Memory and continuity | Motivation, preferences, wish pool, companions, timeline, and background work persist under explicit ownership and provenance rules. | [memory design](design/memory-design.md); ADR-15 |
| Booking Copilot | The embedded planner proposes typed, read-only actions against an existing booking workspace. The host remains authoritative for search results, offers, CheckAvail, Checkout, and order state. | §1.4; ADR-23; D-29 |
| Operations and external events | Doctor, channel health, metrics, and bounded external-event envelopes expose diagnostic or inert seams. They do not silently reroute, write, or activate sensors. | [external-event seam](design/external-event-seam.md); §3 |

### 1.3 Trust and execution invariants

| Boundary | Invariant |
|---|---|
| Facts | Claims that affect feasibility, price, policy, or bookability must bind to registered evidence. Unknown, borrowed, malformed, stale, or contradicted anchors fail closed. |
| Time | Host-local time anchors, real calendar validation, IANA zones, and DST ambiguity checks run in deterministic code; the model does not perform date arithmetic. |
| User sessions | Browser-backed retrieval is read-only, site-scoped, consent-gated, paced, and auditable. Login completes on the external site; ticket values are not exposed as model context. |
| State | A tenant-scoped SQLite ledger is the authority. Projections are rebuildable; idempotency, pending writes, and durable task outcomes are explicit. |
| External effects | Tool code describes effects; the interpreter owns channel access, retry, circuit breaking, and test substitution. Advice is not hidden dispatch. |
| Long-running work | Every turn ends with an answer, a durable handoff, or a typed terminal outcome. Background task identifiers and child-agent identifiers are not interchangeable. |
| Writes | Booking, payment, and supplier writes are sealed from the ordinary tool surface. Any future write requires the separately admitted WriteGate and a trusted-host, one-time authorization. |
| Evaluation | Fixtures and local proofs establish engineering behavior only. Synthetic evidence, diagnostic benchmark runs, and isolated adapters never imply real-user, supplier, or business acceptance. |

### 1.4 Booking Copilot boundary

Booking Copilot is an assistant inside an existing booking journey, not a parallel booking product.

- One canonical `booking.surface` contract defines the planner's action registry, observations, receipts, workspace revisions, and lifecycle events. Assistant prose is non-executable.
- The embedded persona and decision envelope target the registered public DSH `system-prompt` surface; an unregistered patch row cannot carry decision authority.
- Production turns enter through an authenticated BFF-bound context. Browser tokens, deployment credentials, guest/holder PII, supplier cost, and opaque backend session blobs are outside the planner snapshot.
- The embedded profile exposes read actions only: patch or run search, refine and focus results, query or compare offers, select and check an offer, prepare Checkout, and observe order state. It exposes no `Book`, payment, amount override, or guest-data mutation.
- Concrete actions validate schema, capability, expected revision, action identity, and referenced facts. Only a parse/schema-shape call with a strictly paired SDK `INVALID_ARGS` in the same DSH run may be skipped and repaired by a subsequent canonical call; successful calls, unpaired rejections, authority-invalid inputs, and reserved references fail closed. Adapters do not rewrite a successful model action.
- A higher search revision may replace or clear `results` and `visibleHotels`, but must clear `focusedHotelRef`, `loadedOffers`, `shortlistedOfferRefs`, `selectedOfferRef`, and `verifiedOffer`; `search.patch` may also change `searchDraft` when the revision increases. At the same revision, neither search action may mutate workspace content. Missing optional values remain comparable without treating `undefined` and `null` as equal. Late responses cannot overwrite newer user state; any Checkout handoff must be derived again from the resulting verified offer.
- Checkout is the only transaction authorization surface. Product acceptance requires a changed or unavailable quote to return through real search and CheckAvail before a new handoff, and any unknown booking outcome to be reconciled through QueryOrders with the same customer reference. These transaction behaviors are not active GoTry write capabilities.

The implementation contracts above are not product acceptance. The four-surface real-inventory journey and unavailable/changed recovery remain D-29 and [#142](https://github.com/Danceiny/gotry/issues/142).

### 1.5 Current product limits

| Area | Current limit |
|---|---|
| M3 | Engineering and distribution mechanisms exist; the required real seed-user cohort is still absent. |
| M4 | Collection and scoring contracts exist; repeat-user value still requires an observed-private cohort and human source review. |
| M5 | WriteGate is a non-activated mechanism and proposal surface. No supplier transaction path is admitted by current runtime claims. |
| M6 | B2B reuse requires its own entry decision, supply-chain evidence, and real pilot. |
| Booking | Real inventory across tenant, customer, storefront, and payment-link; recovery; Checkout; and order reconciliation are still open. |
| External events | W2A is a bounded inert envelope; no sensor listener or consumer is active by default. |
| Benchmarks | Current external runs are diagnostic-only unless a frozen, matched, evaluator-executed evidence set satisfies the gate in D-28. |

Milestone ordering and exit gates are maintained in the [roadmap](roadmap.md).

## 2. Overall architecture: five layers and current state

```
L1 interaction: conversation is the interface (gates presented as in-message multiple choice; standalone UI is post-Stage-1)
L2 orchestration: conversation loop ts/src/loop.ts — LlmPort (mock/real, provider-neutral) + deterministic interview + solve mount
    └ dsh plugin gotry-tools: registered typed product tools; composition is generated by bin/gotry-inner.js from cordis.gotry-patch.yml
L3 domain: unified itinerary model ts|py unified.* — Segment/Option/anchors/work window/timezone
    └ feasibility engine: Z3 selection + named constraints + unsat-core attribution + Optimize optimum
L4 data: static pack data/*.json (real schedules + estimated prices, evidence-annotated) + golden cases
L5 governance: loopx (objective/gate/evidence/quota; spend only after verification)
```

| Layer | Responsibility | Contract | Invariants (no evolution may break) |
|---|---|---|---|
| L1 | Presentation and capture | transparent card schema (D1 §6) | why/cost must reach the user; gates can only be multiple choice |
| L2 | Understanding and orchestration | `ts/src/contracts.ts` (TripState + five tools) | LLM does no arithmetic verdicts; writes must pass WriteGate |
| L3 | Verdict and accounting | unified itinerary model (§4) + TrueCost | arithmetic and solving are layered; arithmetic is pure functions, independently testable |
| L4 | Data and capability | CLI/JSON bridge (hotelbyte-cli style) | evidence-chain annotation ([live API]/[shared experience]/[estimate]); estimates must be explicitly marked |
| L5 | Governance | loopx state | spend only after verification; blockers recorded, not spun on |

Data flow (Erhai golden case, one call end to end):

```
materials (photos + one sentence) → motivation interview (driven by deterministic missing fields) → JourneySpec extraction
  → solve_unified (Z3 picks departures; anchors/work window/budget as named constraints)
  → {verdicts, exclusions (with reasons), red_flags, optimal budget} → render (cards + gates)
  → infeasible candidates → wish pool (recall conditions: days/budget/season)
```

## 3. Code map (what each module is)

| File | Role | Status |
|---|---|---|
| `ts/src/contracts.ts` | top-level data and tool contracts (TripState / five-tool IO / wire schema) | draft, awaiting founder walkthrough |
| `ts/src/loop.ts` | conversation loop: runTurn/interviewNext/async deep planning (request/collect + no-disappointment four) | ✅ replay-verified |
| `ts/src/mock-llm.ts` | scripted LLM (ADR-8): deterministic replay of the intelligence side of real conversations | ✅ (kept as regression fixture after S4) |
| `ts/src/unified.ts` | **unified itinerary model TS edition (only solve entry)**: Segment/Option/timezone/work window + Z3 solving (flight chains) + enumeration solving (candidate form) | ✅ 4/4 + candidate reconciliation |
| `ts/src/model.ts` | door-to-door full-cost arithmetic (pure functions, single-candidate form) | ✅ |
| `ts/src/engine.ts` `journey.ts` | the old two solve surfaces (pure oracles, golden comparison) | **deprecated** |
| `ts/src/index.ts` `bridge.ts` | dsh plugin (pure TS unified solve + hbcli bridge + process guardrails, latency metering) | ✅ smoke |
| `ts/src/turn-policy.ts` `turn-deadline.ts` | Agent per-turn "routing + wall-clock dual exits": deterministic classification (quick/sync/deep, zero LLM) → TurnPolicy; schema synchronously suppressed past the hard threshold; converge=EXHAUSTED / handoff=file `gotry_turn_handoff.v1` work order + ETA announcement; benchmark pins a fixed policy | ✅ run-all §45 |
| `py/gotry_feasibility/unified.py` | Python oracle (**historical comparison only after v0.0.1-rc.2**, no longer referenced by the product runtime) | retained |
| `py/gotry_demo/` | **deleted 2026-08-22** (D-7 tail debt: the demo plan generator once called the deprecated journey.solve_journey; artifact docs/milestones/demo-plan-2026-07-17.md remains in git history) | — |
| `ts/scripts/replay.ts` `replay-async.ts` | **acceptance fixtures**: real conversation replay (13 turns → 3 turns) and async form | ✅ |
| `ts/scripts/{engine,journey,unified,diff}-tests.ts` | suites (8/5/4 assertions + TS-vs-TS same-spec stability) | ✅ (occasional diff-test ordering is a known issue; no Python dependency after v0.0.1-rc.2) |
| `ts/src/time-anchor.ts` | **time anchor layer** (ADR-12, pure functions): anchor-card rendering (today / relative week / month segments / quarter / festivals) + absolute month-day parsing; the single source of "today" for persona and the extraction chain | ✅ time-eval §1 |
| `ts/src/travel-slots.ts` | **slot extraction layer** (travel_slot_extraction.v1): schema + extraction prompt + expiry validation + language detection + scorer; verbatim preserved, verdicts belong to code | ✅ time-eval §2-4 |
| `ts/src/slot-spec.ts` | **slot→date resolution layer** (D-10 slice A): anchor-card vocabulary + absolute expressions + "+N" suffix → YYYY-MM-DD; out-of-vocabulary unresolved kept verbatim (ADR-12 boundary: no open-ended parsing); spec date-consistency gate | ✅ time-eval §5 |
| `ts/src/tool-packet.ts` | **tool observation envelope** (RFC S1/ADR-13): GotryObservation flat-sealed shape + ToolFailure + interpretArgs, the single entry normalizing the three parameter forms | ✅ smoke §9 |
| `ts/src/memory-utility.ts` | **memory utility sidecar** (RFC S2/ADR-14): recalled/applied/verified_outcome events + idempotent append + read-only projection; attribution only on owner confirmation | ✅ smoke §10 |
| `ts/src/memory-lifecycle.ts` `ts/scripts/memory-lifecycle.ts` | **M4 planning lifecycle collector** (#228): writes only with explicit stateRoot/consent/HMAC; dataset key verifier + source/wait freeze; first-return flow/wait/reflux/preference HMAC-pseudonymized; JSONL+manifest write-all/atomic publish/path isolation; exports to #223 scorer candidate/synthetic, manufactures no manual attestation | ✅ run-all §55 |
| `ts/src/memory-decay.ts` | **time-window decay primitives** (memory-design P3): 30/90/180/365d tiered factors (floor 0.1) + kind weights + freshness confidence; zero decay on the motivation layer is a construction guarantee | ✅ run-all §23 |
| `ts/src/companions.ts` | **companion profiles** (memory-design P2): upsert merge + negative-list guard (zero ID/phone ingestion); constraints only enter ranking | ✅ run-all §21 |
| `ts/src/travel-timeline.ts` | **travel timeline** (memory-design P1): trips.jsonl append-only + idempotent / overlap-conflict halts + verified↔timeline cross-consistency | ✅ run-all §20 |
| `ts/src/wish-pool.ts` | **wish pool matching pure functions**: condition scoring + 0..1 selection (muted excluded / deterministic tie-break); shared by wish_pool_list and nudge | ✅ run-all §21 |
| `ts/capabilities/channel-registry.ts` `ts/capabilities/channel-health.ts` | **channel registry + channel health surface** (design/tool-orchestration-design.md, issue #106/#107/#108/D-7/D-8/D-9): single data source of channel×intent×quota class×evidence level; persona routing card and `routing` advice generated from the same source; session transient state (down/cooldown, cleared on hit) + `channel-health.jsonl` persistent event surface; ordering = lexicographic (availability, evidence level, efficiency); advice is not dispatch | ✅ run-all §50 |
| `ts/capabilities/flyai.ts` | **FlyAI official channel**: pipeline layer of Fliggy's 8 read-only tools (search-flight/train wired first), evidence chain `[live API: flyai@ts]` | ✅ run-all §24-F |
| `ts/capabilities/session-search.ts` + `session/` + `extension/` | **session retrieval surface** (RFC P1-P3.5): transport = extension bridge PRIMARY (`extension/` MV3 + `extension-bridge.ts` loopback bridge, zero new dependencies; **capability routing**: a site's jobs are dispatched only to pollers declaring that site) / cdp explicit fallback (ReadGuard physically intercepts write requests + audit, fail-closed) / persistent for tests; Ctrip flight adapter (batchSearch sniffing) / dida supplier-portal adapter (SearchRealTime envelope flattening, 2026-09-09) / action-cache self-healing layer (variable keys + fingerprint passive invalidation + miss write-back); pacing gate; `[session:*]` evidence chain | ✅ run-all §25/§38 |
| `ts/capabilities/session/extension-distribution.ts` + `ts/scripts/extension-distribution-cli.ts` | **extension distribution channel** (ADR-21 distribution A): GitHub Releases download chain (stable asset names / dist-manifest fail-closed parsing / SHA256 / platform tar extraction / key pinning / version comparison / atomic swap), explicit degradation to bundled on failure; CLI single-line JSON for bootstrap spawn | ✅ run-all §43 |
| `ts/capabilities/artifacts.ts` | **artifact surface** (issue #25 minimal slice): artifact discovery (ledger workflow_runs authoritative + ledgerless fallback async directory view + dsh working-directory top-level md) + line-window read (dsh read card); read-only, path/extension whitelist | ✅ smoke §13 |
| `ts/capabilities/effect.ts` `ts/capabilities/resilience.ts` | **effect interpreter + resilience primitives** (effect_interpreter.v1, issue #16 adopted / ADR-18): effect-value registry (channel handlers + policy table) + production/mock interpreters (channel observations passed through verbatim + trace cross-cutting evidence) + exponential backoff (withRetry) / circuit-breaker tri-state (CircuitBreaker); all 23 tools' external-dependency surface converged (issue #115) | ✅ run-all §37 |
| `ts/src/state-ledger.ts` | **transactional state ledger** (ADR-15): SQLite single file as sole authority (events append-only + semantic idempotency keys / projection tables fold-rebuildable / workflow_steps durable work orders / pending_writes saga); `gotry_async_terminal.v1` freezes the 4/4 / non-4/4 terminal states, exit codes, and zero-recompute re-invocation; gatekeeping pure functions reused as write-path and fold processors; read path falls back to legacy files; first write auto one-shot migration + snapshot | ✅ run-all §28 |
| `ts/src/booking-saga.ts` `ts/scripts/booking-saga-tests.ts` | **booking saga state-machine vocabulary layer** (booking_saga_fsm.v1, issue #17 adopted / ADR-17): state alphabet + four edges as full-function edge table + structured rejection closed set + audit-chain validation; §36 physically reconciled cell-by-cell against the ledger saga base | ✅ run-all §36 (pure functions, zero write-path wiring) |
| `ts/src/booking-surface/recovery-chain.ts` `ts/scripts/booking-recovery-chain-tests.ts` | **unavailable/changed recovery-chain contract** (issue #142 non-gated slice): pure-function disposition chain over supplier changed/unavailable verdicts — detection classifies receipts into the existing `ActionReceipt.status` closed set (confirmed/changed/unavailable/inconclusive/unrelated, no new channels; incoherent receipts fail closed with the policy's own `availability_receipt_incoherent`/`availability_observation_required` vocabulary); controlled recovery records requery/recheck-version/alternative-candidate steps inside the planner three-call budget semantics (a 4th counted turn is refused — degrade explicitly instead), with the availability-policy per-hotel budgets frozen-referenced (`RECOVERY_REUSED_BUDGETS`); user-communication red lines: resolving onto a different hotel/offer without prior explicit disclosure is structurally refused (`recovery_silent_swap_forbidden`), a version shift requires an explicit old→new explanation, and exhausted recovery may only degrade with a mandatory non-empty disclosure; audit events (`booking.copilot.recovery.*` namespace) carry receipt digests and validate saga-style (detected → attempt* → disclosed? → resolved/degraded absorbing); detection/legality stay owned by the availability reducer (ADR-23) — this layer is its user-communication and audit projection, non-runtime-activated | ✅ run-all §65 (offline fixtures; zero real supplier calls) |
| `ts/capabilities/hotelbyte-transaction.ts` `ts/scripts/hotelbyte-reconcile-tests.ts` `ts/scripts/hotelbyte-spawn-e2e-tests.ts` | **HotelByte transaction bridge + unknown query-orders reconciliation contract** (issue #232, M5 pre-entry): pure-function reconciliation state machine per `design/write-gate-production-design.md` §7 — book-execution classification (CLI exit0 is not success proof: timeout/kill/non-JSON/unbound success/partial confirmation classify unknown; explicit business failure classifies supplier_failed); fail-closed seed bindings (attemptId/customerReferenceNo/idem key/fingerprint required; fact_id/approval-receipt-digest/outbox-ref traceability on every record, probeDigest on every event); miss stays unknown inside the 180s+600s recovery window with rebooking structurally forbidden; window expiry alone is never no-order proof and only escalates to manual; authoritative terminal negative evidence bound to the attempt is the only new-intent gate; multi-order/reference-mismatch/post-terminal counter-evidence surface explicit conflict, never silent success or silent drop; the pure contract layer itself has no spawn/network/credentials, and the spawn-level full-chain E2E (§5) executes only a local fake CLI fixture — non-runtime-activation | ✅ run-all §60 (offline fixtures; zero real supplier calls); spawn-level E2E landed: run-all §66 (PR pending link) |
| `ts/capabilities/sponsor-plugin.ts` `ts/scripts/sponsor-reuse-tests.ts` | **sponsor plugin + same-kernel end-to-end reuse proof face** (issue #235, M6 pre-entry): traveler principal/sponsor/BFF principal three-subject separation (missing or conflated ids fail closed at construction); authorization route closed set + mandatory session/order binding (no credential field anywhere on the chain — copying Buyer/credentials is structurally excluded); runtime activation default-off (`SPONSOR_RUNTIME_ACTIVATION_DEFAULT=false`, explicit opt-in only, real wiring behind #137 M6 Entry); same-kernel reuse = the module only imports kernel functions (`booking_saga_fsm.v1` state machine + wish-pool condition scoring, zero copy/no re-declaration, kernel drift turns the suite red), and one runner drives both B2C and B2B forms with cell-identical saga edge sequences; red lines structurally encoded: kernel full-condition-hit enforced before ranking (commission cannot redeem unmet traveler conditions; tie-break only by sponsor declared order with mandatory bias disclosure), disclosure digest enters the confirmation fingerprint, empty receipt rejected in both forms, cancel/refund walks the same kernel edges; isolation: no `ts/src/**` file references the sponsor module (C-side default path untouched) and the B2C trace passes the leak checker with zero findings | ✅ run-all §64 (offline fixtures; non-runtime-activation, zero real calls) |
| `ts/src/booking-surface/cancel-refund-commission.ts` `ts/scripts/issue-233-cancel-refund-commission-tests.ts` | **cancel/refund independent outcomes + commission disclosure contract layer** (issue #233, M5-4 pre-entry, pure functions): cancellation and refund are two outcome objects with disjoint status closed sets — no merged success state, asymmetric terminals (cancel confirmed + refund failed/pending/unknown) are first-class; `supplierReferenceNo` constructible only from supplier return values; `refunded` binds supplier/wallet authoritative evidence; `cancel.serviceFee` can never become the customer refund amount and is disclosed separately; commission/sponsorship disclosure (who pays / to whom / amount basis; unknown must not default to none; explicit none requires a recorded contract rule) with canonical-JSON SHA-256 digest bound into the request-fingerprint field `commission_disclosure` — a disclosure change invalidates the old receipt; a mechanical user-copy token gate keeps ledger tokens and wording consistent (480-combo matrix) | ✅ run-all §62 (contract only — zero supplier/payment call surface, not wired into any runtime path) |
| `ts/src/bookable-facts.ts` | **bookable fact model** (gotry_bookable_fact.v1, issue #46/ADR-19, pure functions): fact schema (route / exact local date / flight number / marketing+operating carrier / airports / price / source / query_id / confidence tier / bookability four states) + flyai/session result converters (hit = positive fact / miss = negative fact / error not recorded) + IATA normalization + judgment primitives (claim expressibility fail-closed / same-day connection hard constraint / night-count·O&D·budget invariants / detour detection) + render primitives (codeshare dual-carrier / DMK landing note / unbookable wording / connections only protected_connection) | ✅ run-all §39 |
| `ts/src/artifact-gate.ts` `ts/capabilities/fact-log.ts` | **artifact fact gate + fact sidecar** (issue #46/ADR-19): markdown bookable-claim reverse extraction (flight number / carrier nonstop / Chinese carrier names / airport mapping / policy "as-of" context / ✓ / connection assertions, subsection context inheritance) → item-by-item back-trace to the registry (not_in_source / route_unqueried / time contradiction / price contradiction / connection violation, etc.); the 21st tool `gotry_fact_gate`; when blocked, no "verified" claim; fact-log appends to the `<stateRoot>/gotry-state/bookable-facts.jsonl` sidecar (never blocks the retrieval main path) | ✅ run-all §39 + smoke §16 |
| `data/airline-airports.json` `ts/data/golden-trip-2027-facts.json` | airline→airport mapping + city→IATA vocabulary (gotry_airline_airports.v1, as_of snapshot + review_by): FD=DMK/VZ=BKK conflict detection surface, gate fails closed on missing load; golden fixture = the 2027 trip fact set locked to issue #46 audit values (11 queries) + good/bad itinerary invariant pair | ✅ run-all §39 |
| `ts/scripts/state-cli.ts` | **ledger operation surface** (ADR-15): migrate/log/stats/rebuild/rewind/forget/pw-* go through the centralized parser then pass to StateLedger tenant-scoped; unknown/duplicate/missing-value/illegal numerics (including `.5`/`+.5`) fail closed. export/tick/whatif are explicitly local-only: they would respectively write a shared legacy filename, invoke local async settlement, and generate a whole-database admin snapshot (not a tenant export); non-local is rejected before mkdir/openDb/solve/write | ✅ run-all §29; #241/#243 landed in main and closed |
| `ts/scripts/product-metrics.ts` `ts/data/product-metrics-fixture.json` + `ts/scripts/nightly-evidence.ts` `ts/data/m3-nightly-prompts.json` `ts/data/llm-price-table.json` | **M3 cohort evidence scoring surface + nightly evidence producer (Issue #22)**: threshold-frozen manifest + de-identified cohort/nightly schema + finalization-rate/NPS/POI-hallucination-rate scorers; fixtures and real evidence are segregated, unknown fields fail closed; the nightly producer freezes the prompt set and price table (peak conservative upper bound, unknown models fail closed), no-credentials waiting/backoff/no-spend, exit 3 on over-budget, records must pass the consumer's parseNightlyRun before being written | ✅ run-all §33/§35; real cohort still to be collected, nightly real-run records await a credentialed environment |
| `ts/scripts/time-eval-tests.ts` `data/time-slot-eval.json` | time-awareness evaluation (25 questions): deterministic part in CI, `--real` real-model inspection (read-only report) | ✅ real model 25/25 |
| `data/golden_erhai.json` `flights_2026.json` `hotels_2026.json` `golden_trip_2026.json` `行程细化计划.docx` | golden case / schedules / accommodation / full task / Kimi conversation originals | — |

## 4. Unified itinerary model (domain core, only solve entry)

```
JourneySpec = { segments, budget?, workWindow?, default wake-up line, … }
Segment     = { id, role: choice|fixed, anchors{arrive_by/depart_after/…}, options[] }
Option      = { id, move(services×transfers×buffer×red-eye×tz), stay?(nights/price/work_window), score, min_days }
```

- Two forms, one model: candidate choice (Erhai = 1 segment, 3 destination Options) and segment chain (demo = 5 segments); the old engine/journey are its degenerate cases on single-segment/fixed-chain, now deprecated.
- **Solve layering**: arithmetic pure functions (`evaluate_*`: wake-up/arrival/energy/effective duration/money) strictly separated from Z3 selection (named constraints, unsat-core attribution, Optimize optimum).
- **Timezone semantics (D-5 discharged)**: real flight = (arrival − departure) − time difference; door-to-door = pre-flight + real flight + transfer (EK329 full chain 11h20m, flight 7h35m, minute-for-minute identical to the official site).
- **Work window (M-1 landed)**: home timezone → origin-local conversion; Options departing inside the workday window are deterministically excluded before solving, with reasons recorded — gate q3 is deterministically answered by one rule (all Friday-evening departures excluded, only Saturday morning left, matching the real choice).
- **Red-eye sleep model**: energy = 30+8×(flight−1h), clamp[30,75]; EK329 lands at 75% (awaiting reconciliation, Q10 calibration).

## 5. Conversation loop (L2)

`runTurn(state, msg, llm, solve)`: extract facts (calendar asserted once, conflicts pointed out explicitly) → incremental interview (driven by missing fields; workWindow/bookedResources are solve prerequisites; budgetTier demoted to a gate, non-blocking) → when constraints are complete, extractSpec→solve→render (plan + exclusion reasons + red flags + gate multiple-choice). Complex trips switch to **async deep planning** ("come back in an hour"; revisits deliver with the no-disappointment four self-check). Detailed design in `design/stage1-top-down-design.md`.

**Replay acceptance** (`ts/scripts/replay.ts`): Kimi's 13-turn failure = GoTry's 3 turns; zero calendar back-and-forth; the work window and booked hotel are asked out in the first turn; the final turn is already a verified plan.

## 6. Data and runtime

> **Single authority for data sources = `data-sources.md`** (established 2026-08-22): domain matrix × four-layer architecture (static pack / free realtime / hbcli bridge / OSM ecosystem) × Google Place chain (hbcli→search OpenAPI→geography) × evidence-chain contract × TREK reference adoption. This section keeps only the runtime summary.

- Runtime: two empirically proven paths — ① TS in-process (self-built loop, ~6ms/solve); ② real dsh headless + cordis composition (pi-ai→MiniMax, `cordis.gotry-patch.yml`, 68ea364). Since v0.0.1-rc.2 the Python CLI bridge is offline, pure TS. Environment trio `LLM_API_KEY/LLM_BASE_URL/LLM_MODEL` (backward compatible with old DEEPSEEK_*).
- Reuse landed: dsh (import, rc aligned) / loopx (import, 0.5.1 running) / Z3 (import, dual bindings) / hotelbyte-cli (import+extend, place chain in data-sources.md §4) / T system·ai-agent-book·TREK (reference, zero code — TREK data-surface pattern adoption table in data-sources.md §5). Kernel manifest frozen (issue #234, PR link pending): `ts/data/kernel-manifest.json` pins the kernel module surface (engine `unified.ts`/`model.ts`, ledger `state-ledger.ts`, gate `bookable-facts.ts`/`artifact-gate.ts`; SHA256 + basis per entry, bound to the freeze baseSHA) and the mechanical gate (run-all §63) proves zero hash drift + real runtime import-trace loading + same engine/ledger/gate functional-path coverage + evidence-snapshot hash binding.

## 7. Testing and verification strategy

**Three evaluation layers (ADR-11)**:
- **Regression layer (anti-regression)**: TS-vs-TS dual-path stability (same spec, different module instances) + golden assertions (Erhai 8+5, Phuket chain 4, unified model 20/20) + **replay fixture** (mock replay is behavior-level regression; the Kimi conversation is the failure baseline). **Since v0.0.1-rc.2:** no more reliance on the Python oracle diff; run-all-tests' 9 suites pass in one go with no Python runtime. Full-stack entry: `scripts/run-all-tests.sh`.
- **Quality layer (anti-drift)**: evaluation set + metrics panel — POI hallucination rate, finalization rate, no-disappointment four, NPS; goes live at M3 (see `tech-strategy.md` §4); before that, replay terminal-state assertions are the backstop.
- **Inspection layer (anti "mock green while real intelligence rots")**: the nightly form of real-LLM replay (`replay-real.ts`) has landed — `nightly-evidence.ts` (frozen prompt set + frozen price table, budget gate `GOTRY_NIGHTLY_BUDGET_USD`, no-credential waiting/backoff/no-spend zero writes, run-all §35; real runs that cost money stay out of CI, executed manually by heartbeat/founder). Output `gotry_m3_nightly_run_v1` records append to the **private evidence ledger** `ts/gotry-state/evidence/m3/cohort.jsonl` (git-ignored); `cost_usd` comes only from dsh-llm's usage accumulator × the frozen price table. ADR-10 was born exactly from mock-green-while-real-LLM-rotted; the lesson is institutionalized.

## 8. ADR

**Lifecycle**: proposal → adopted → (discharged | superseded | retired); "never re-review" is an explicit terminal class (ADR-7/9/10 rest on invariant-level judgments). **Three birth channels**: ① born of failure — a real run exposes a problem mock/derivation cannot see, ADR filed the same day (the ADR-10 pattern); ② born of reconciliation — `milestones/demo-reconciliation.md` §3: model gaps → file an ADR and evaluate whether it enters the engine; ③ born of milestone review — the M-exit pass walks every retirement/re-review condition of the whole table (§11), and whatever triggers is filed on the spot. **Anchor**: every ADR must have a code/test execution anchor, or be explicitly marked "process-level" — an ADR without an anchor silently rots away as the system evolves, unnoticed.

| # | Decision | Alternatives and trade-offs | Retirement/re-review condition | Anchor |
|---|---|---|---|---|
| 1 | Z3 as the verdict layer | rule engine / OR-Tools / pure LLM (4.4%) | evaluate OR-Tools if solve >500ms or variables >10³; unsat core non-negotiable | `unified.ts`/`unified.py` solve layer; dual-side suites |
| 2 | Dual implementation: TS production + Python oracle | single implementation (no reconciliation) | **2026-08-22 v0.0.1-rc.2:** Python oracle path offline (diff-test switched to TS-vs-TS; run-all-tests no longer needs a Python runtime); py/ retained as historical comparison (not deleted), **no longer referenced by the product runtime** — prerequisite for one-command npm distribution |
| 3 | Bridge convergence: in-process first | all-TS / all-Python | **2026-08-22 v0.0.1-rc.2:** Python bridge offline, only the hbcli bridge remains (vs hbcli & hbcli fallback); invariant ≤2 bridges | `ts/capabilities/hbcli.ts`; `bridge.latency.jsonl` |
| 4 | loopx as control plane | self-built state machine | when concepts clash beyond adaptation | process-level (`.loopx/` governance state) |
| 5 | Unified itinerary model | keep dual engines | discharged (engine/journey retirement day = migration completion day, tracked by D-7) | `unified.ts`/`unified.py` |
| 6 | Static pack (demo phase) | wire APIs directly | retired into fixtures at M2 | `data/*.json`; golden cases |
| 7 | Arithmetic/solve layering | mixed | never re-review | `model.ts`/`model.py` pure-function layer (layered test structure) |
| 8 | mock-LLM first | wait for API key (pseudo-blocker) | after S4 the mock stays as regression fixture (fulfilled) | `ts/src/mock-llm.ts`; `ts/scripts/replay.ts` |
| 9 | Deterministic interview (missing-field driven) | LLM improvisation (the Kimi disease) | never re-review | `loop.ts interviewNext`; replay fixture (work window asked out in turn one) |
| 10 | Translation ≠ fabrication: the LLM only produces skeleton and anchors; schedule data always comes from the capability layer (static pack → live API); spec validation gate as backstop | let the LLM produce the full spec directly (measured: MiniMax-M2 cannot make up timetables — it either fabricates or deadlocks) | never re-review | `loop.ts validateSpec`; `dsh-llm.ts SKELETON_SYSTEM`; `replay-real.ts` |
| 11 | Evaluation layering enters the architecture: regression layer (unit/diff/replay) against regression, quality layer (evaluation set + metrics panel) against drift, inspection layer (nightly real-LLM replay with budget gate) against "mock green while real intelligence rots"; M-exit must pass the corresponding layer | replay fixture only (quality drift unfelt) / evaluation tooling added after the fact (metrics not in the architecture = nonexistent) | re-review once after the M3-exit metrics panel goes live | `run-all-tests.sh`; replay trio; `tech-strategy.md` §4 |
| 12 | Time-awareness layering: anchor card (arithmetic in code) + slots preserved verbatim (LLM neither converts nor translates) + expiry/language verdicts in the code layer | see §8.12 | **2026-08-27 review (triggered by D-10 slice A): design holds**; supplementary boundary in §8.12 | `time-anchor.ts`; `travel-slots.ts`; `slot-spec.ts`; `time-eval-tests.ts` |
| 13 | Tool observation envelope (RFC S1, effect-interpreter mapping): 12 tools' success path flat `ok:true` + payload, failure `{ok:false,summary,evidence}` (guard fallback same shape, `ToolFailure` compile-time aligned); single entry `interpretArgs` normalizing the three parameter forms (former unwrapQuery moved to `tool-packet.ts`) | per-tool free-form returns (shape drift, every new tool re-guesses) / nested envelope `{ok,value}` (renderers/callers all forced to unwrap, high intrusion) | re-review when a second real caller (neither dsh nor smoke) needs a different observation shape | `tool-packet.ts`; `incident-log.ts guardToolExecute`; smoke §9 |
| 14 | Memory utility sidecar (RFC S2/S3): three event classes append-only, **attribution only on owner confirmation**; wish stable id + dormancy; recall 0..1/turn | see §8.14 | re-review on multi-user AaaS ledgerization (RFC §6.5) or a second utility consumer | `memory-utility.ts`; `index.ts gotry_wish_pool_list`; smoke §10 |
| 15 | Transactional state foundation (RFC `rfc/transactional-state-rfc.md`, converging the industry's durable-execution five-piece set) | see §8.15 | re-review on multi-user AaaS-ification (RFC §6.5 claim/CAS implementation) or when multi-writer/multi-end replication is needed (cr-sqlite/Litestream, trigger = D-15) | `state-ledger.ts`; run-all §28/§29 |
| 16 | Dual-form architecture freeze (local + Web): **one ledger semantics, two host bindings**; `tenant_id` first-class field; append/read/fold/rebuild all scoped to the current ledger owner; sync = event replication, not state translation | see §8.16 | never re-review (dual-form is the product-form foundation); sync protocol and claim/CAS implementation deferred to triggers; historical local events must not be tenant-back-inferred without evidence | `state-ledger.ts` schema v2; run-all §28 dual-form assertions |
| 17 | Booking saga state-machine naming (issue #17 adopted, 2026-08-29) | see §8.17 | re-review when M5 decides WriteGate (the unsealing delta's schema CHECK / seam vocabulary / L4 automation classes); if a booking flow needing parallel multi-writers appears, re-review the keyed single-writer form | `ts/src/booking-saga.ts`; `docs/design/booking-saga-fsm.md`; run-all §36 |
| 18 | Effect interpreter effect_interpreter.v1 (issue #16 adopted, 2026-08-29) | see §8.18 | re-review the "flat" boundary when a product verdict needing cross-channel price aggregation appears; write effects (booking/payment) entering the registry must follow the booking_saga_fsm.v1 edge table (M5 Entry) | `ts/capabilities/effect.ts` `resilience.ts`; `docs/design/effect-interpreter.md`; run-all §37 |
| 19 | Single source of bookable facts + artifact fact gate (issue #46, 2026-08-30) | see §8.19 | re-review coverage when a second gated artifact class appears (e.g. hotel direct booking); re-review the policy-fact production end after a live policy source lands; the root-fix direction = artifacts generated only by render primitives (structured → markdown one-way), reverse extraction demoted to fallback | `ts/src/bookable-facts.ts` `ts/src/artifact-gate.ts`; `data/airline-airports.json`; run-all §39; smoke §16 |
| 20 | Provider-aware price table v2 + long-term price-drift mechanism (issue #49, 2026-08-30): frozen price table `gotry_llm_price_table_v2` (DeepSeek tiered + MiniMax flat, unknown models fail closed, no price guessing) + four-provider drift monitoring, **never auto-apply prices** (adjustments via PR + human review) | manual price check at release (lags) / auto-apply (rejected: an official 5% drop was once mistaken for our bug) | re-review when monitoring false positives become systemic, or when the price-source form changes | `ts/data/llm-price-table.json`; `ts/scripts/price-drift-watch.ts`; run-all §41/§42 |
| 21 | Extension distribution three channels (issue #21 distribution channel, 2026-08-30; store track listed 2026-09-02) | see §8.21 | ~~re-review wizard steps after store approval~~ (triggered: wizard degraded to offline health-watch waiting; install = the browser's business, rendering = dsh UI's business, §3.3 responsibilities handed back); re-review mirror defaults if GitHub-unreachable regions normalize; re-review the channel abstraction when a second distribution artifact appears | `ts/capabilities/session/extension-distribution.ts`; `scripts/package-extension.mjs`; run-all §43; `docs/ops/extension-webstore-submission.md` |
| 22 | static golden is an **auditable benchmark comparator**, not a live flight source (issue #67) | see §8.22 | re-review as a new provider when an official flight API appears that needs no private credentials, has a clear license, and is stable, or when hbcli publishes a flight contract; static remains only a deterministic regression fixture | `ts/capabilities/session/static-flight-golden.ts`; `ts/data/sf-static-routes.json`; run-all §44 |
| 23 | embedded Booking Copilot security boundary and BFF request identity binding (single booking.surface contract) | see §8.23 | off-page automatic write/payment must enter the M5 WriteGate proposal/ADR follow-up implementation; multi-writer/cross-host triggers ADR-15/16 re-review; ~~retire v1 after all consumers migrate to v2~~ (**triggered 2026-09-05**: #133 converged to a single contract, v1 retired, files promoted to suffix-free canonical names) | `schemas/booking.surface.schema.json`; `ts/src/booking-surface/` (contracts/runtime/server/startup etc.); run-all proof surface |
| 24 | Turn budget = routing + wall-clock dual exits: deterministic classification → converge/handoff; handoff files an independent work order awaiting a loopx tick to collect | see §8.24 | when routing misclassification becomes systemic (user feedback "what should have been answered in person got handed off" observable), first expand the Tier 0 signal vocabulary, then consider Tier 2 (structured state); when handoff work orders back up and need a real collector, start the loopx tick design; if the evaluation-side 60s is too tight, adjust the env pin first | `ts/src/turn-policy.ts`; `ts/src/turn-deadline.ts`; `ts/src/index.ts` wiring; `ts/scripts/turn-policy-tests.ts`; `ts/scripts/agent-planning-turn-deadline-{tests,e2e}.ts`; `scripts/run-all-tests.sh` §45 |
| 25 | Channel health surface and dynamic routing advice (issue #106/#107/#108, D-7/D-8/D-9 adopted 2026-09-03): the tool surface stays flat (ADR-18 judgment untouched), the interpreter does no hidden rerouting; the channel registry single data source generates the persona card/tool descriptions/doctor lines; on retrieval verdict≠hit an ordered `routing` advice is injected into the result (availability > evidence level > efficiency lexicographic, health-state filtered), the contract teaches at the failure site; quota five-class taxonomy (user-session/user-key/anonymous-trial/free-public/static) freezes attribution semantics; calendar not mounted by default (D-9) | interpreter auto-rerouting (rejected: the model thinks it called A but actually went through B, breaking call auditability) / static priority inversion (rejected: every new user pays the extension-install cost first) / prose doctrine only (rejected: prose rots, ordinary models can't read it) | when routing advice misfires systemically, fix registry data first; re-review together with ADR-18 when a cross-channel price-aggregation product verdict appears; the official key pool (product-wide application) awaits re-review at M3 real-cohort scale | `ts/capabilities/channel-registry.ts` `channel-health.ts`; `docs/design/tool-orchestration-design.md`; run-all §50; smoke (flyai needs-setup→routing) |

### ADR expansions (the bodies referenced as "see §8.x" in the table)

#### 8.12 Time-awareness layering
- The time evaluation set entered the repo (`data/time-slot-eval.json`, append-only, semantics unchanged) — the quality layer's first piece landed.
- Alternatives and trade-offs: all-LLM perception — measured anchor absence (the legacy path injects no "today", expiry unjudgeable); full code parsing of Chinese relative dates — open-ended expressions, a maintenance black hole.
- **Boundary added by re-review**: the resolution layer recognizes only the anchor-card vocabulary + absolute expressions + the "+N" suffix; out-of-vocabulary unresolved is preserved verbatim, **no open-ended parsing** (anchor `slot-spec.ts`; time-eval §5).

#### 8.14 Memory utility sidecar
- Three event classes `recalled`/`applied`/`verified_outcome` append-only (`gotry-state/memory-utility.jsonl`).
- **Attribution discipline**: attribution can only be recorded at confirm-outcome, explicitly stated by the user; **the model is not allowed to self-rate "useful"**.
- Wish stable `wish_id` + muted (dormant, not deleted); recall 0..1/turn (`gotry_wish_pool_list` condition scoring; muted never recalled; no hit, no hard push) — the measurement base of the M4 north star "next-departure rate".
- Alternatives and trade-offs: recording "useful" on recall — self-claimed usage ≠ improving outcomes; wish deletion — aspirations should not be rejected.

#### 8.15 Transactional state foundation
Single-file SQLite ledger (better-sqlite3, WAL) = sole authority, converging the industry's durable-execution five-piece set:
1. **events append-only**: semantic idempotency keys physicalized as UNIQUE, `wish_id` semantically derived.
2. **projection tables fold-rebuildable**: gatekeeping pure functions reused as-is, zero semantic-layer rework.
3. **red lines in transactions**: evidence/conditions rejection rolls back.
4. **durable work orders**: `workflow_steps` intent-before-execute, crash recovery exactly-once.
5. **pending_writes saga**: WriteGate L2/L3 foundation (idempotency key/receipt/compensation) + what-if fork (VACUUM INTO).

Old JSON/JSONL degrade to one-way export views (red line 6); one-shot migration (automatic on first write + snapshot `pre-ledger-backup/`).

Alternatives and trade-offs: Postgres/DBOS/Temporal/Restate platforms — a single-user local product needs no server side (the SQLite durable school, "one file is the control plane"); pure file hardening tmp+rename — cannot fix cross-file forks and concurrency; `node:sqlite` — zero-dependency but newer, the D1 runner-up.

#### 8.16 Dual-form architecture freeze
- **One ledger semantics, two host bindings**: local = better-sqlite3 reading the file directly; Web = the same schema on a per-user SQLite file (or Postgres, isomorphic schema).
- **`tenant_id` is first-class from day one**: events/projections/work orders/pending_writes all carry the tenant column, constant `'local'` in the single-user phase, primary keys namespaced against cross-user collisions.
- **Execution boundary (issue #224 fix)**: `insertEvent` must write the current ledger tenant; `readEvents(kind?)`, projection fold, and `rebuildProjections(toSeq?)` must carry the tenant condition; the `wish.updated` fold looks up existing items of the current tenant — cross-tenant same `wish_id` never cross-reads. legacy JSON/JSONL and v1 DBs migrate only into `local`; non-local events already miswritten as `local` by the old bug lack an auditable owner, cannot be guessed back by schema migration, and can only go through a manual data-repair issue/PR with external evidence.
- **Sync = replication of ledger events, not translation of state**: event rows carry `tenant_id` + idempotency keys, dual-end merge naturally idempotent. Writes must go through the ledger; reads must carry tenant context into the invariant tables.
- Alternatives and trade-offs: local and Web each growing their own logic — the multi-user-phase merge could only be rebuilt from scratch; cloud-authoritative + local cache — violates red line 6 local-first; syncing projections instead of events — projections are derived state, merging would fork.

#### 8.17 Booking saga state-machine naming
The booking/payment/refund saga **introduces no orchestration framework (LangGraph etc.)**; the FSM lands as the vocabulary layer of the ledger's `pending_writes` (`ts/src/booking-saga.ts`, `booking_saga_fsm.v1` pure functions): the state alphabet matches the CHECK constraint verbatim, edges fully functionalized.

Alternatives and trade-offs: LangGraph/Temporal-style frameworks — a second runtime, violating the harness baseline and the reuse matrix; states scattered across SQL strings — edge semantics drift with no vocabulary; multi-agent prompt coordination — implicit dependencies.

#### 8.18 Effect interpreter `effect_interpreter.v1`
"Effect description + interpreter" sinks to the L4 channel boundary — the tool/orchestration layer only produces pure-data effect values `{effect, params}`; channel access, backoff-retry, circuit breaker, and compile-time mocks all converge into the interpretation layer.

Alternatives and trade-offs: per-tool free calls into the capability layer — cross-cutting logic duplicated, no backoff/circuit-breaking/mock surface; Python browser-use — violates zero-Python-dependency; interpreter with built-in multi-channel routing order — violates OTA flatness.

#### 8.19 Single source of bookable facts + artifact fact gate
Every bookable fact (flight number/times/airports/price/policy) **is allowed to exist only in the structured fact layer** (`gotry_bookable_fact.v1`); artifacts pass the gate before rendering.

This slice completes the inline hard-price boundary of the shared flight/train primitives: when an exact-date fact's price is CNY, only the `¥NNN`/`CNY NNN` within the flight/train's own window are bound for reliable consistency checking; inconsistency produces `price_contradicted`; source fact missing price, unsupported hard currency, or no anchor with price outside the heuristic 120-character window produces `unverified_price_claim`; from-prices/approximate prices and non-numerics are still not compared, no conversion or tolerance inference, hotel `priceRaw` keeps redacted semantics. Does not close [#273](https://github.com/Danceiny/gotry/issues/273) or all D-26 residuals.

Alternatives and trade-offs: LLM self-annotation — unenforceable (issue #46 empirical failure); lenient release at render time — unverified facts out the door; policy surface wired to a live visa API — v1 policy facts are render-side + gate-side only, the production end is recorded as D-26.

**Root-fix direction**: artifacts generated only by render primitives (structured → markdown one-way); reverse extraction demoted to a transitional state.

#### 8.21 Extension distribution three channels
The Chrome platform forbids non-store CRX direct install — GitHub Releases only does "download" (stable asset names tar.gz/store-zip/dist-manifest); the Web Store is the "one-click install + auto-update". Three channels, same extension: **Chrome Web Store (listed 2026-09-02, recommended)** one-click install/auto-update; the GitHub channel is explicit opt-in (review-free, faster version updates); bundled guarantees the offline deterministic fallback.

**Listing field notes**: the store re-signs with its own generated signing key and does not honor the manifest-fixed key — the store edition's extension ID (`oeajpiccmonococjcegddlooeeohlbgd`) differs from the unpacked fixed ID (`olpgkofjhhiiiahdkkbcninhjmegghfe`); the bridge Origin whitelist trusts both channels equally (`EXTENSION_ORIGINS`, run-all §38); the port pool/host whitelist do not drift with the channel.

Alternatives and trade-offs: install CRX from arbitrary URLs — forbidden by the platform; npm package as the only channel — extension updates forced onto the rc release train; independent pinning — conflicts with the decoupling goal; self-hosted update server — violates the zero-infrastructure surface.

#### 8.22 static golden = auditable comparator
route/carrier come only from the OpenFlights pinned revision; times/prices come from the manual band with every field marked estimated; `requested`/`effective` source, revision/license, and fallback reason are recorded in the same evidence entry. **On snapshot or route failure, warn on stderr then fall back to manual; silently switching source or masquerading as live availability is forbidden.**

Alternatives and trade-offs: `hbcli search-flight` — neither local nor upstream has this capability (N/A); Ctrip credential-free open API — not found, and the public page returns 432 (N/A); simply renaming manual to static — provenance fraud; keeping manual only — continued vendor lock.

#### 8.23 ADR-23: embedded Booking Copilot security boundary and BFF request identity binding

> **Status update (2026-09-05)**: the re-review condition "retire v1 after all consumers migrate to v2" **has triggered** — #133 (stacked merge #134) converged the dual protocols into a single `booking.surface` contract: the v1-only runtime was deleted, the v2 stack promoted to suffix-free canonical files (`contracts.ts`/`runtime.ts`/`server.ts`/`startup.ts`), `SCHEMA_VERSION='booking.surface'`, a single HTTP path with a single handshake, version vocabulary removed from the ledger; JSON wire field names unchanged. Below is the decision text from the dual-protocol era (the boundary design still holds); the current form defers to this entry.

Booking Copilot is a BFF-only embedded read-action surface inside the existing workbench:

- **Protocol form (historical)**: v1 was kept compatible, v2 ran in parallel as a closed typed contract; the same listener, task ownership, and ledger dispatched by request version+schema hash. **Converged to a single contract since 2026-09-05, v1 retired**.
- **identity binding**: production standalone's `bff-bound-turn-only` accepts only internal `user.turn`/receipt continuations already bound by the BFF; the v2 browser submits only a safe opaque `requestKey`/optional `taskHandle`, and only a full authenticated principal/scope + BFF trusted binding seam can atomically map `user.turn.ingress` to a server-generated, durably bound `taskId + turnId + contextRef + surface + allowedActions`. Under bound-turn-only, ingress returns a typed 503 before any ledger/planner side effect; a taskHandle can bind only one task/context within an actor scope.
- **one-time approval**: a must blocker can only be released via an option persisted by the runtime and actually presented; the approval binds field-by-field the task, context, source turn, source action, source receipt digest, canonical presentation key, random delivery nonce, and option digest, and can be consumed only once.
- **availability reducer (typed recovery sub-state-machine)**: one recovery freezes at most 5 candidate hotels; each generation holds at most 3 current OfferRefs per hotel; each hotel lifecycle allows at most 2 CheckAvail and 2 offers/HotelRates generations. `unavailable`, material `changed`, or an unconfirmable gap invalidates the whole generation and requires a fresh query; partial evidence yields only inconclusive exhaustion — it cannot claim the market has no rooms. generation/attempt/candidate/receipt digest/workspace revision fold with the ledger; restarts and identical replays do not add budget; terminal is an absorbing state. The recovery-chain contract layer (`ts/src/booking-surface/recovery-chain.ts`, run-all §65) projects this reducer into the user-communication and audit surface: explicit disclosure of supplier changed/unavailable verdicts, no silent hotel/offer substitution, and saga-shaped `booking.copilot.recovery.*` audit events — the #142 merge-gate real-inventory evidence remains gated no-spend.
- **same-revision replay guard (ordinary TURN branch)**: applied AFTER the confirmed-availability `confirmed_workspace_drift` rejection so the historical specific diagnostic stays stable; `BookingCopilotTaskRuntime.resumeTask` then compares the durable workspace semantic digest (contextRef/revision stripped) of every ordinary `booking.copilot.user.turn.observed` row against the prior state at the same revision; a silent drift fails closed as `ledger_corrupt:<task>:same_revision_turn_workspace_drift` instead of letting a row written by an old public `startTask` (no live-time CAS) smuggle a verifiedOffer/loadedOffer/selection drift into replay and turn the replayed workspace into checkout authority. The explicit `replayUpgradeRequired` reanchor and the confirmed-availability `confirmed_workspace_drift` rejection stay intact; the live-time `startTask` guard (`workspace_mismatch` at same revision without an active reanchor) remains the primary defense.

Explicitly rejected alternatives: a standalone chat booking page; replacing v1 with a breaking v2; free-text/JSON execution; treating server outbox intent as already displayed; exposing `Book` on the embedded surface. Current capability excludes portal tokens, PII, or supplier-cost egress; off-page automatic write/payment is deferred to the M5 WriteGate proposal (`design/write-gate-production-design.md`); multi-writer or cross-host triggers ADR-15/16 re-review.

#### 8.24 ADR-24: turn budget = routing + wall-clock dual exits (turn-policy / turn-deadline)

**Problem (shaped by the 2026-09-02 trajectory)**: every conversation turn must end in one of three states — ① answered in person ② handed to async with a revisit promise ③ converged answer; a fourth state "the stream died and nothing was delivered" is never allowed. The old step-count gate (16 soft / 18 hard) and the v1 fixed wall-clock gate (60s/120s) share the same wrong shape: at the deadline "refuse tools + force a final" — the model can still die mid-stream and the trajectory user gets nothing.

**v2 design (complexity decides the exit structure, not a mapping onto bigger constants)**:

- **Routing layer** (`ts/src/turn-policy.ts`): every user/message (source.kind=user; plugin/skill injections do not participate) is deterministically classified quick / sync-planning / deep-planning. Pure function, zero LLM, zero IO — control-plane verdicts must be deterministic (the accountability iron rule; ADR-9 is the same-shape precedent); the router cannot spend the resource it allocates; LLM routing would break evaluation reproducibility (§45 offline E2E has zero real LLM). v1 rule inputs are only Tier 0 (date-span extractor + constraint vocabulary + message length); `loop.ts`'s `isComplex` is the S5 loop architecture's post-interview review, is not on the product path (its only caller is the replay script), and judges the trajectory's first message false, **so it does not enter this layer**. Misclassification is bounded: the worst outcome is "what could have been answered in person got handed off" (recoverable next turn), so the router only needs to be good enough, not perfect.
- **Allocation layer**: classification → `TurnPolicy={softMs,hardMs,exit}`. The threshold table is data, not code (evaluation/deployment swap tables, not executors): quick 120s/180s converge; sync-planning 300s/600s converge; deep-planning 120s/240s **handoff** (the sync window only suffices for scoping + filing the work order).
- **Execution layer** (`ts/src/turn-deadline.ts`): on hard-threshold refusal, inherited tool schemas are **synchronously** suppressed (trajectory lesson: deferring to `step/end` makes the model loop on the refusal result within the same step until token truncation), then return by exit: converge=`TURN_DEADLINE_EXHAUSTED` (answer with the evidence at hand); handoff=files a `gotry_turn_handoff.v1` work order (`<stateRoot>/gotry-state/turn-handoffs/`, containing the user's original text / ETA≈1 hour / status=open) and instructs the model to state in one sentence "handed to background + ETA + how to revisit". The work order is an **independent format in an independent directory**: async-collect would immediately settle a spec-less state as failed (a false failure); the handoff collector is the future loopx agent tick — filing the work order already fulfills the three-state promise (documented, revisit-able), it does not need the collector to exist first.
- **Wiring**: the product path `apply()` installs by default (routing+handoff is product behavior); benchmark opt-in pins the fixed `{60s,120s,converge}` policy for reproducibility. `GOTRY_TURN_DEADLINE_SOFT_MS`/`_HARD_MS` only pin numbers, never change exits; `GOTRY_TURN_HANDOFF_ROOT` pins the work-order isolation root (in source mode the dsh cwd is the founder's real data directory `ts/dsh-runtime`; tests must pin it — inspection state discipline). Programmatic calls without an agent do not count; turn/session terminal states release state and limits. CI first builds a tarball of the current SHA, resolves the dsh peer closure in an isolated pnpm consumer, then hands that install entry to the same E2E — it does not pass the root dev tree off as the published form.
- **Verification** (`run-all §45`): `turn-policy-tests.ts` table tests (the first fixture = the trajectory user's original text; the canonical deep case must hit — the regression anchor of the whole redesign); `agent-planning-turn-deadline-tests.ts` Cordis integration (converge/handoff dual exits, work-order fields, plugin message discipline, lifecycle); the E2E drags a synthetic deep message + relay past the hard threshold, asserting the handoff result, work order filed in the isolated root, final request text-only, non-empty final.

**Collection loop (2026-09-02 v2 completion, the background half of "come back in an hour")**:

- `ts/scripts/turn-handoff-collect.ts` (single `<ticketId>` / `--all`, the turn-handoff counterpart of async-collect) loads open work orders → spawns a headless planning session with `GOTRY_HANDOFF_CHILD=1` (`bin/gotry-inner.js`, overridable via `GOTRY_HANDOFF_PLANNER_BIN`; recursion guard: the child session's only exit is converge + long leash (300s/900s); the parent's numeric pins and work-order root are cleared in the child environment — foreground may hand off to background, background must produce a deliverable, it must not hand off again) → captures the final answer and settles.
- `settleTurnHandoffTicket` atomically writes `<id>.deliverable.md` + work-order status settled/failed (settledAt/deliverableFile/error). Terminal idempotence: an already-settled work order re-invocation returns the deliverable plus the `gotry_turn_handoff_terminal.v1` JSON (succeeded exit 0 / failed exit 2), zero recompute, zero re-spend; a failed deliverable is an honest failure note ("not completed, please re-initiate; no partial results to deliver").
- Revisit surface: the product path registers the read-only tool `gotry_turn_handoff_list` — when the user asks "is the plan ready", the model queries work-order status; settled attaches a deliverable excerpt (≤600 chars; full text in the same directory's .deliverable.md); fabricating nonexistent deliverables is forbidden.
- Scheduling: the collector is a one-shot command (drivable by cron/loopx tick/manual; `--all` scans all open). v1 honest boundary: the work order carries only the user's original text; the planning session is a fresh context (fresh cwd/DSH_HOME); the original session's already-read workspace/calendar conclusions do not migrate with the work order — the planner re-fetches as needed. E2E loop closure: §45's packaged-binary E2E runs the collector with the real binary as planner after the handoff assertion, asserting ticket open→settled and the deliverable containing the planner's final.

Re-review triggers: when routing misclassification becomes systemic ("what should have been answered in person got handed off" observable), first expand the Tier 0 vocabulary, then consider Tier 2 (structured state); when handoff work orders back up and need a real collector, start the loopx tick design; if the evaluation-side 60s is too tight, adjust the env pin first.

Explicitly rejected alternatives: any constant gate that kills the turn at the deadline (fixed or LLM-dynamically-generated — same shape, same trajectory failure mode); LLM routing (loses on consistency/reproducibility/cost three ways; if future signals prove insufficient, earn authorization via loopx RFC S4's L1 shadow→L2 advisory shadow-comparison path, not granted by default); handoff reusing the loop work-order format (async-collect false failure); thresholds handed over to the dsh host (violates the gotry/dsh layering).

## 9. Evolution

This section records durable architecture transitions, not an issue-by-issue change log. Current contracts live in §§1–8, open obligations live in §10, milestone order lives in [the roadmap](roadmap.md), and per-change history lives in git, [CHANGELOG](../CHANGELOG.md), and [release notes](release-notes.md).

### 9.1 Durable transitions

| Epoch | Durable result | Current authority |
|---|---|---|
| M0–M2 | Deterministic choice evaluation, an agent conversation loop, and provenance-bearing realtime retrieval replaced model-authored arithmetic and unsourced claims. | §§2–7 and ADR-10/19 |
| M3 | The dsh web/runtime form, artifact surface, read-only session retrieval, and product-evidence machinery became the current delivery shape. | §§1–7; [tools](tools.md); [data sources](data-sources.md) |
| M4 preparation | Tenant-scoped memory, wish-pool recall, lifecycle collectors, and evaluation admission exist as engineering support. Real repeat-user evidence remains a milestone gate. | §10; [roadmap](roadmap.md); [evaluation foundation](evaluation/evaluation-foundation.md) |
| M5/M6 preparation | WriteGate, booking saga, reconciliation, disclosure, kernel-reuse, and sponsor boundaries exist only as gated contracts or default-off mechanisms. They do not activate supplier writes or prove a pilot. | ADR-17/18; §10; [WriteGate design](design/write-gate-production-design.md) |

### 9.2 Current engineering lines

- **Retrieval and sessions:** registered tools use typed result contracts, provenance, channel health, and a read-only browser bridge. Provider-specific shapes and live calibration belong to [data sources](data-sources.md) and [the adapter guide](design/adapter-authoring-guide.md).
- **Artifacts and review:** itinerary rendering creates a new bounded file from registry-selected facts; list/read and optional local review remain separate capabilities. Detailed input, path, preview, and lifecycle rules belong to [tools](tools.md) and their owning design documents.
- **Evidence and evaluation:** deterministic fixtures prove engineering boundaries only. External scores, uplift, supplier availability, user value, and milestone exits require their admitted real evidence sets.
- **External events:** the W2A contract is default-off and inert. No listener, consumer, state write, or transaction authority follows merely from accepting an envelope.
- **Transactions:** booking, payment, change, refund, and commission effects remain behind M5 entry and WriteGate. Read-only investigation and pure contracts never unseal that boundary.

### 9.3 Booking Copilot boundary

The durable transition is from a standalone conversational booking flow to BFF-bound, typed read actions inside the existing search/offer/Checkout workspace. Host facts and Checkout authority remain in place; the current executable boundary is maintained once in §1.4 and ADR-23.

Real inventory, unavailable/changed recovery, Checkout, and QueryOrders evidence remain D-29 and [#142](https://github.com/Danceiny/gotry/issues/142).

### 9.4 Historical detail

Closed issue narratives, exact test counts, transient package versions, and dated implementation diaries are intentionally absent here. Use git and release notes for chronology, the [debt archive](debt-archive.md) for paid-off obligations, and the owning design or evaluation document for durable contracts and evidence ledgers.

## 10. Debt Register

> This is an open-obligation register, not a change log. Closed items move to the [debt archive](debt-archive.md); implementation chronology belongs in §9, release notes, issues, and Git. Each row keeps only the remaining condition, the proof that can remove it, and its tracking authority.

### 10.1 Open (working face)

| ID | Open obligation | Exit evidence and tracking |
|---|---|---|
| Ledger repair / #254 | Historical events may have been recorded under the default `local` tenant. Read-only planning plus authorized apply/rollback exists, but fixtures do not establish whether a real repair is needed. | Produce a founder-authorized real repair receipt, or a recorded decision that no repair is required, using the checksummed backup and digest-bound procedure in [the runbook](ops/ledger-tenant-repair.md). |
| Direct SDK runtime trigger | A future `dsh-sdk-client` product runtime would not inherit the CLI launcher's process-group cleanup guarantee. This is dormant until such a runtime is proposed. | Before activation, assign descendant ownership and prove bounded cleanup for the concrete direct-connect lifecycle; no vendor fork or runtime activation is implied by this tracker. [#422](https://github.com/Danceiny/gotry/issues/422) |
| D-37 | CfT/Chromium extension APIs cannot currently observe the HttpOnly Dida ticket cookie, so the quick login check can report `needs-login` even though page requests and passive response sniffing still work. | An upstream fix, or a validated branded-Chrome plus store-extension path that observes the required login state. [#272](https://github.com/Danceiny/gotry/issues/272) |
| D-13 | User-session adapters remain vulnerable to live site and browser drift. Offline parsers and static comparators do not establish connected behavior. | Capture real connected and explicit degraded evidence for each supported adapter under the [session RFC](rfc/user-session-data-rfc.md), including challenge/guard stop semantics and packaged entry behavior. [#272](https://github.com/Danceiny/gotry/issues/272) |
| D-15 | The single-file tenant ledger has no admitted multi-writer, cloud-backup, or multi-machine replication path. | Triggered only by a second real user, multi-machine deployment, or AaaS initiative; then specify and prove claim fencing, backup, and replication semantics. [#275](https://github.com/Danceiny/gotry/issues/275) |
| D-18 | M3 lacks real seed-user evidence. | A real 50–200-person cohort must simultaneously show completion rate ≥40%, NPS ≥40, POI hallucination rate <1%, and rerunnable in-window nightly evidence. Synthetic fixtures and credential-free waiting runs do not count. [#22](https://github.com/Danceiny/gotry/issues/22) |
| D-19 | M4 lacks observed repeat-user value. | An `observed_private` cohort with N≥5 and median planning-time reduction ≥0.5, HMAC-pseudonymous inputs, human source review, and a review digest bound to the reported summary. Candidate or synthetic exports do not count. [#20](https://github.com/Danceiny/gotry/issues/20) |
| D-22 | `pending_writes` still lacks the physical non-empty receipt CHECK named by the booking saga contract. The outbox has its own constraints, but that does not settle this seam. | At an admitted M5 Entry, add the schema CHECK and freeze the seam vocabulary without activating a supplier write path prematurely. [#136](https://github.com/Danceiny/gotry/issues/136), [#231](https://github.com/Danceiny/gotry/issues/231) |
| D-26 | The fact gate still relies on bounded reverse extraction for some unanchored text and has no admitted FX/multi-currency settlement policy or complete live-source coverage. Known or anchored claims remain fail-closed today. | Replace each residual with a named canonical fact path and counterexamples; admit non-CNY handling only when a real supplier quote, budget, or destination requires it. [#381](https://github.com/Danceiny/gotry/issues/381), [#344](https://github.com/Danceiny/gotry/issues/344) |
| D-28 | External benchmark runs have not produced a matched, attributable evidence set; diagnostic runs and partial terminals cannot support uplift claims. | A frozen cohort must reach valid non-empty terminals with the evaluator executed, then satisfy the original manifest and registry controls before any aggregate or uplift statement. [#203](https://github.com/Danceiny/gotry/issues/203), [evaluation contract](evaluation/evaluation-foundation.md) |
| D-29 | Booking Copilot lacks real-inventory product acceptance. Engineering contracts, fixtures, and reproducible artifacts do not substitute for this journey. | Resolve the authority-precedence correction in [#473](https://github.com/Danceiny/gotry/issues/473); freeze exact GoTry, hotel-be, and hotel-fe SHAs; exercise tenant, customer, storefront, and payment-link; recover at least one unavailable/changed quote through re-search, a new CheckAvail, and the original Checkout; keep `Book` in Checkout; reconcile unknown outcomes through QueryOrders and capture cleanup evidence. Product tracking: [#142](https://github.com/Danceiny/gotry/issues/142). |
| D-33 | The M4→M6 program still lacks the real evidence and admission decisions that connect repeat-user value, a supply chain, and B2B reuse. | Satisfy D-18/D-19; obtain M5 protocol, buyer, routing, reconciliation, UAT-signing or internal authorization evidence; then obtain an independent M6 entry decision and real pilot contract. [#270](https://github.com/Danceiny/gotry/issues/270), [#136](https://github.com/Danceiny/gotry/issues/136), [#137](https://github.com/Danceiny/gotry/issues/137) |
| D-39 | Ground-transfer logic is bounded to explicit-coordinate driving estimates and static price evidence; live traffic, transit/rail, fares, address resolution, and broader combinations are not admitted. | Each wider path needs a named product use case, source, freshness contract, access boundary, and real-data proof. Read-only routing does not authorize any write path. [#429](https://github.com/Danceiny/gotry/issues/429) |

## 11. Freshness Mechanism

Freshness means semantic consistency at the correct abstraction level, not copying the same issue paragraph into every document.

| Authority | Owns | Must not become |
|---|---|---|
| §1 | Stable current system shape and invariants | A dated implementation diary |
| §9 | Durable architecture transitions and current engineering boundaries | A commit-by-commit changelog |
| §10 | Open technical debt and its redemption condition | A list of already-landed features |
| [roadmap](roadmap.md) | Milestone order, entry, exit, and current gate | An implementation ledger |
| Root [README](../README.md) | User-facing promise, available/not-yet boundary, and pointers | An issue or test report |
| [Stage 1 design](design/stage1-top-down-design.md) | Frozen historical design | A current-state surface |

**Same-commit rule:** update every authority whose owned fact actually changes. Other documents keep a short pointer. Duplicating implementation prose, dates, test counts, or issue sequences across surfaces is a documentation defect, not synchronization.

**M-exit freshness checklist:**

1. Reconcile the affected authorities above and confirm that pointers still resolve.
2. Review every ADR against its retirement or re-review condition; open an issue or change status when triggered.
3. Add or close debt only in §10; move paid-off entries to the [debt archive](debt-archive.md).
4. Replace rotting counts with code or test-entry references.
5. Put rerunnable evidence commands and exact SHAs in the commit or PR evidence, not in reader-facing summaries.
6. Run the bilingual and reader-surface documentation gates.

**Re-review cadence:** event-driven. Every milestone exit reviews the full table; a triggered ADR condition is reviewed immediately.

## 12. Document Map

The organizational contract and complete document index live in [docs/README.md](README.md). This authority keeps only the stable routes readers need to interpret the architecture:

| Need | Authority |
|---|---|
| Milestone order and gates | [roadmap.md](roadmap.md) |
| Product model | [gotry-product-design.md](gotry-product-design.md) |
| Program decisions and reuse constraints | [gotry-master-outline.md](gotry-master-outline.md) |
| Data-source and evidence policy | [data-sources.md](data-sources.md) |
| Tool contracts and operator paths | [tools.md](tools.md) |
| Release decisions and chronology | [release-notes.md](release-notes.md) and [CHANGELOG](../CHANGELOG.md) |
| Open technical debt | §10 of this document |
| All other designs, research, milestones, evaluation, and operations docs | [docs master index](README.md) |
