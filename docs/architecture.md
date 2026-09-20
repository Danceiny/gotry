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
The full module inventory (one row per module/suite: role, status, and the verification section that pins it) lives in the concern-owned authority [code-map.md](code-map.md). The core reading path: `ts/src/unified.ts` (unified model + Z3 solve, the only solve entry) → `ts/src/loop.ts` (conversation loop) → `ts/src/index.ts` (dsh plugin wiring); the deprecated `engine.ts`/`journey.ts` remain golden-comparison oracles only; capability layers (channel registry, session retrieval, memory, wish pool) are itemized in the code map.

→ Full inventory: [code-map.md](code-map.md)


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

**Search scheduling**: `gotry_hotel_search` and `gotry_anything_search` declare independent read-only calls safe for the existing dsh bounded scheduler. Dependent calls wait for earlier observations; other tools retain their existing exclusive execution. The host cancellation signal reaches the effect and CLI layers. No second scheduler is introduced. Performance acceptance and limits live in the [measurement report](evaluation/parallel-search-perf-report.md).

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
| 12 | Time-awareness layering: anchor card (arithmetic in code) + slots preserved verbatim (LLM neither converts nor translates) + expiry/language verdicts in the code layer | [8.12](adr-expansions.md#812-time-awareness-layering) | **2026-08-27 review (triggered by D-10 slice A): design holds**; supplementary boundary in [8.12](adr-expansions.md#812-time-awareness-layering) | `time-anchor.ts`; `travel-slots.ts`; `slot-spec.ts`; `time-eval-tests.ts` |
| 13 | Tool observation envelope (RFC S1, effect-interpreter mapping): 12 tools' success path flat `ok:true` + payload, failure `{ok:false,summary,evidence}` (guard fallback same shape, `ToolFailure` compile-time aligned); single entry `interpretArgs` normalizing the three parameter forms (former unwrapQuery moved to `tool-packet.ts`) | per-tool free-form returns (shape drift, every new tool re-guesses) / nested envelope `{ok,value}` (renderers/callers all forced to unwrap, high intrusion) | re-review when a second real caller (neither dsh nor smoke) needs a different observation shape | `tool-packet.ts`; `incident-log.ts guardToolExecute`; smoke §9 |
| 14 | Memory utility sidecar (RFC S2/S3): three event classes append-only, **attribution only on owner confirmation**; wish stable id + dormancy; recall 0..1/turn | [8.14](adr-expansions.md#814-memory-utility-sidecar) | re-review on multi-user AaaS ledgerization (RFC §6.5) or a second utility consumer | `memory-utility.ts`; `index.ts gotry_wish_pool_list`; smoke §10 |
| 15 | Transactional state foundation (RFC `rfc/transactional-state-rfc.md`, converging the industry's durable-execution five-piece set) | [8.15](adr-expansions.md#815-transactional-state-foundation) | re-review on multi-user AaaS-ification (RFC §6.5 claim/CAS implementation) or when multi-writer/multi-end replication is needed (cr-sqlite/Litestream, trigger = D-15) | `state-ledger.ts`; run-all §28/§29 |
| 16 | Dual-form architecture freeze (local + Web): **one ledger semantics, two host bindings**; `tenant_id` first-class field; append/read/fold/rebuild all scoped to the current ledger owner; sync = event replication, not state translation | [8.16](adr-expansions.md#816-dual-form-architecture-freeze) | never re-review (dual-form is the product-form foundation); sync protocol and claim/CAS implementation deferred to triggers; historical local events must not be tenant-back-inferred without evidence | `state-ledger.ts` schema v2; run-all §28 dual-form assertions |
| 17 | Booking saga state-machine naming (issue #17 adopted, 2026-08-29) | [8.17](adr-expansions.md#817-booking-saga-state-machine-naming) | re-review when M5 decides WriteGate (the unsealing delta's schema CHECK / seam vocabulary / L4 automation classes); if a booking flow needing parallel multi-writers appears, re-review the keyed single-writer form | `ts/src/booking-saga.ts`; `docs/design/booking-saga-fsm.md`; run-all §36 |
| 18 | Effect interpreter effect_interpreter.v1 (issue #16 adopted, 2026-08-29) | [8.18](adr-expansions.md#818-effect-interpreter-effect_interpreterv1) | re-review the "flat" boundary when a product verdict needing cross-channel price aggregation appears; write effects (booking/payment) entering the registry must follow the booking_saga_fsm.v1 edge table (M5 Entry) | `ts/capabilities/effect.ts` `resilience.ts`; `docs/design/effect-interpreter.md`; run-all §37 |
| 19 | Single source of bookable facts + artifact fact gate (issue #46, 2026-08-30) | [8.19](adr-expansions.md#819-single-source-of-bookable-facts--artifact-fact-gate) | re-review coverage when a second gated artifact class appears (e.g. hotel direct booking); re-review the policy-fact production end after a live policy source lands; the root-fix direction = artifacts generated only by render primitives (structured → markdown one-way), reverse extraction demoted to fallback | `ts/src/bookable-facts.ts` `ts/src/artifact-gate.ts`; `data/airline-airports.json`; run-all §39; smoke §16 |
| 20 | Provider-aware price table v2 + long-term price-drift mechanism (issue #49, 2026-08-30): frozen price table `gotry_llm_price_table_v2` (DeepSeek tiered + MiniMax flat, unknown models fail closed, no price guessing) + four-provider drift monitoring, **never auto-apply prices** (adjustments via PR + human review) | manual price check at release (lags) / auto-apply (rejected: an official 5% drop was once mistaken for our bug) | re-review when monitoring false positives become systemic, or when the price-source form changes | `ts/data/llm-price-table.json`; `ts/scripts/price-drift-watch.ts`; run-all §41/§42 |
| 21 | Extension distribution three channels (issue #21 distribution channel, 2026-08-30; store track listed 2026-09-02) | [8.21](adr-expansions.md#821-extension-distribution-three-channels) | ~~re-review wizard steps after store approval~~ (triggered: wizard degraded to offline health-watch waiting; install = the browser's business, rendering = dsh UI's business, §3.3 responsibilities handed back); re-review mirror defaults if GitHub-unreachable regions normalize; re-review the channel abstraction when a second distribution artifact appears | `ts/capabilities/session/extension-distribution.ts`; `scripts/package-extension.mjs`; run-all §43; `docs/ops/extension-webstore-submission.md` |
| 22 | static golden is an **auditable benchmark comparator**, not a live flight source (issue #67) | [8.22](adr-expansions.md#822-static-golden--auditable-comparator) | re-review as a new provider when an official flight API appears that needs no private credentials, has a clear license, and is stable, or when hbcli publishes a flight contract; static remains only a deterministic regression fixture | `ts/capabilities/session/static-flight-golden.ts`; `ts/data/sf-static-routes.json`; run-all §44 |
| 23 | embedded Booking Copilot security boundary and BFF request identity binding (single booking.surface contract) | [8.23](adr-expansions.md#823-adr-23-embedded-booking-copilot-security-boundary-and-bff-request-identity-binding) | off-page automatic write/payment must enter the M5 WriteGate proposal/ADR follow-up implementation; multi-writer/cross-host triggers ADR-15/16 re-review; ~~retire v1 after all consumers migrate to v2~~ (**triggered 2026-09-05**: #133 converged to a single contract, v1 retired, files promoted to suffix-free canonical names) | `schemas/booking.surface.schema.json`; `ts/src/booking-surface/` (contracts/runtime/server/startup etc.); run-all proof surface |
| 24 | Turn budget = routing + wall-clock dual exits: deterministic classification → converge/handoff; handoff files an independent work order awaiting a loopx tick to collect | [8.24](adr-expansions.md#824-adr-24-turn-budget--routing--wall-clock-dual-exits-turn-policy--turn-deadline) | when routing misclassification becomes systemic (user feedback "what should have been answered in person got handed off" observable), first expand the Tier 0 signal vocabulary, then consider Tier 2 (structured state); when handoff work orders back up and need a real collector, start the loopx tick design; if the evaluation-side 60s is too tight, adjust the env pin first | `ts/src/turn-policy.ts`; `ts/src/turn-deadline.ts`; `ts/src/index.ts` wiring; `ts/scripts/turn-policy-tests.ts`; `ts/scripts/agent-planning-turn-deadline-{tests,e2e}.ts`; `scripts/run-all-tests.sh` §45 |
| 25 | Channel health surface and dynamic routing advice (issue #106/#107/#108, D-7/D-8/D-9 adopted 2026-09-03): the tool surface stays flat (ADR-18 judgment untouched), the interpreter does no hidden rerouting; the channel registry single data source generates the persona card/tool descriptions/doctor lines; on retrieval verdict≠hit an ordered `routing` advice is injected into the result (availability > evidence level > efficiency lexicographic, health-state filtered), the contract teaches at the failure site; quota five-class taxonomy (user-session/user-key/anonymous-trial/free-public/static) freezes attribution semantics; calendar not mounted by default (D-9) | interpreter auto-rerouting (rejected: the model thinks it called A but actually went through B, breaking call auditability) / static priority inversion (rejected: every new user pays the extension-install cost first) / prose doctrine only (rejected: prose rots, ordinary models can't read it) | when routing advice misfires systemically, fix registry data first; re-review together with ADR-18 when a cross-channel price-aggregation product verdict appears; the official key pool (product-wide application) awaits re-review at M3 real-cohort scale | `ts/capabilities/channel-registry.ts` `channel-health.ts`; `docs/design/tool-orchestration-design.md`; run-all §50; smoke (flyai needs-setup→routing) |

The per-decision bodies live in the concern-owned authority [adr-expansions.md](adr-expansions.md), edited with their ADR rows.

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
