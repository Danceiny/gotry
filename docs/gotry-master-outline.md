[English](gotry-master-outline.md) | [简体中文](gotry-master-outline.zh-CN.md)

# GoTry Master Outline: Work Breakdown and Reuse Baseline

> Single current version (history in git log; no file-level version numbers)
> **Date**: 2026-08-22
> **Role**: **this document is the guide for all subsequent GoTry work (single source of truth)**. Any new document, decision, or implementation on the business, product, or technology lines first checks this document's reuse matrix (Chapter 2) and decision gates (Chapter 5).
> **Two rigid constraints** (founder directives; priority above any single document's local optimization):
> 1. **The harness must use deepseek-harness (dsh) as the reference baseline** — no in-house agent runtime.
> 2. **Referenced open-source projects are never reimplemented**: prefer direct import, bridging, and other deterministic approaches; where a port is truly needed, the floor is "pattern port + acceptance against the original implementation".

---

## 0. Reading Guide and Usage

- GoTry is a grand business/product/technology plan and **cannot be completed in one pass**. This document decomposes it into three work lines, a set of work packages, and a sequence of decision gates — all subsequent work advances inside this framework.
- The document system has two layers: **the master-outline layer (this document)** sets direction, reuse, and ordering; **the per-domain documents** carry the complete design of their own domain. When a per-domain document conflicts with the outline, fix the outline first, then start work.
- The existing "GoTry Product Design" (D1, part of `gotry-product-design.md` v0.4) is the product line's first per-domain document; the revision requirements for its architecture chapter are in 3.8.

---

## 1. Panorama: Three Work Lines and the Document System

### 1.1 The Three Work Lines

| Line | Question it answers | Current state |
|---|---|---|
| **Business (B)** | Which market, for whom, earning how, passing compliance how | Market not locked (D1 §3.3), business plan not started |
| **Product (P)** | User journey, product mechanics, metric system | D1 v0.1 already has a complete product definition, to be refined into something implementable |
| **Technology (T)** | Harness, plugins, capability reuse, evaluation, cost | This document establishes the technology baseline for the first time (Chapter 3); PoC not started |

The three lines advance in parallel, synchronized by the decision gates (Chapter 5): the tech line's PoC results feed the business line's market judgment; the business line's market lockdown constrains the tech line's supply-chain selection.

### 1.2 Document Map (the numbers are the deliverables of subsequent work)

| # | Document | Line | Status | Notes |
|---|---|---|---|---|
| D0 | Master outline (this document) | All | v0.1 | Work breakdown, reuse matrix, decision gates |
| D1 | GoTry Product Design | P | v0.1 exists | Positioning/main loop/transparency/metrics/roadmap; §7 architecture needs revision per Chapter 3 |
| D2 | Technical architecture design | T | ✅ exists as `architecture.md` (the sole technical authority) | harness baseline (dsh), plugin inventory, bridging design, data model |
| D3 | Business plan | B | Not started | Market, GTM, financial logic (modeled on the stai-business-plan format) |
| D4 | Evaluation plan and evaluation set | T | Not started | Feasibility/factuality/transparency trio + the cost dimension |
| D5 | MVP implementation plan | P+T | Not started | The engineering landing of product M1: scope, milestones, acceptance |
| D6 | Compliance checklist | B | Not started | Commission disclosure, payments/FX, data cross-border, proactive outreach 📍 follows the market |

---

## 2. Reuse and Integration Matrix (the core of this outline)

**Principle: never rewrite.** Each referenced project gets one definitive reuse strategy, and there are only three: **import** (bring in the source/package directly, only for clearly licensed open-source), **bridge** (out-of-process/interface-level runtime bridging, no code brought in), **reference** (learn from the design only, no code). **Code-level reuse happens only via open-source import; internal assets are only ever bridged at runtime or referenced — there is no middle state of "porting code / accepting against the original".**

| Project | License | Strategy | Role in GoTry | Integration form | Main risk and countermeasure |
|---|---|---|---|---|---|
| **deepseek-harness (dsh)** | MIT | **import** | Agent runtime foundation (the entire harness layer) | Imported directly into the TS monorepo; all GoTry domain capabilities built as dsh plugins | dev preview has breaking changes → **decided: no version pinning, follow main, bet on it** (G2 closed); upgrades folded into the daily regression |
| **loopx** | MIT | **import** | Long-horizon task control plane: TripState's objective/gates/evidence/quota; **the execution face of async deep planning** (see 3.6) | Python CLI/JSON, invoked by the dsh plugin via subprocess; zero dependencies, low bridging cost | TS↔Python cross-language → the bridge surface converges to the trip-state and async-planner plugins |
| **Z3** | MIT | **import** | The feasibility engine's constraint solver (no in-house solver) | Python package (z3-solver), a library dependency of the feasibility plugin | Solver timeout → constraint-size cap + timeout degradation to rule validation |
| **ai-agent-book** | Apache-2.0 | **reference** | Design reference for evaluation methodology, memory, and context engineering | No code imported | The book's demo code is weak (founder's judgment); design reference only; the memory implementation base is in the T system (3.5) |
| **T system (an enterprise travel-agent production system, source anonymized)** | Internal asset | **bridge + reference** | ① bridge: masked MCP tools (flights/hotels/preferences/travel standards etc.) bridged at runtime during PoC/MVP (constrained by G5); ② reference: dual execution, WriteGate, tool-owned dates, resumable SSE, **the six-layer backend memory (see 3.5)** — **design reference only; neither code nor schema is copied**; GoTry implements its own for the C-end leisure-travel domain | MCP protocol bridge (runtime invocation, no code) | Internal assets may not be used at the code level (explicit founder directive); enterprise-travel semantics (travel standards/approvals/departments) should not be copied into the C-end |
| **hotel-be (proprietary)** | Proprietary | **bridge** | Atomic capabilities: city/destination search, hotel search/quotes/details/static data, orders | **Decided: exposed as a CLI (G4 closed)**; the base is hotelbyte-cli, see the row below | CLI command gaps (e.g. geo-mapping) → same-style extensions contributed upstream |
| **hotelbyte-cli** | MIT | **import + extend** | The base of capability-hotelbe: an agent-native CLI (hbcli), `--json` on every command, `@file` payloads, automatic credential detection, self-updating single binary (Bun/TS) | The dsh plugin invokes the CLI via subprocess; after inventorying command gaps, extend in the same style | Capability alignment → T3 starts with the command-gap inventory |
| **Chrome Extensions (MV3) platform** | Platform capability | **reference + self-built** | The session data plane's main transport (issue #21 option C, founder verdict 2026-08-30): the GoTry Session Bridge extension is installed once, replacing Chrome 144+'s per-connection CDP permission box (verified unshippable); playwright-mcp `--extension` is a design contrast only, no code imported | `extension/` self-built MV3 four files (zero build, manifest fixed key = extension ID) ↔ Node loopback bridge (`session/extension-bridge.ts`, `node:http` long polling, zero new dependencies); authorization = one-time install + origin whitelist + the in-session consent gate | Chrome's security model tightens further → lane separation (extension/cdp/persistent) touches lanes, not semantics; the CWS listing is live (2026-09-02; the store re-signs the key ⇒ the store version has its own ID, and the bridge carries a dual-Origin whitelist), with the GitHub Releases/bundled channel retained; native messaging is the phase-2 fallback |
| **TREK** | AGPL-3.0 | **reference + rewrite (rewrite from the design)** | The design blueprint for the itinerary planner: the functional face of Day planner/map/budget/collaboration; the trip/day/place/budget domain tool schemas (150+ tools, fine-grained OAuth scopes, rate limiting) | **Decided: rewrite from the design** (G3 closed) — implement ourselves using the functional face and schema designs as reference; no code imported, no self-hosting | AGPL forbids import; rewrite discipline: reference the design and schemas, **never translate the source line by line** |
| **layla.ai** | Commercial closed-source | reference | Competitor and pricing anchor; no code reuse | — | — |
| Xiaohongshu (小红书) / Yuanzhou (圆周轨迹) | Platform/closed-source | reference | The shape reference and differentiation target for the shared-experience layer (D1 §6.6): high folk-wisdom density but unstructured | Data cannot be imported; cold start does only human distillation of factual assertions, never content搬运 — never carries content over (copyright red line) | The shape can be learned; the data is built in-house |

Matrix conclusion: **no license hard-blockers remain in the reuse matrix** — open-source (MIT/Apache) is imported directly; internal assets are bridged at runtime; AGPL projects (TREK) and internal code (the T system) are always rewritten from the design. Kernel manifest frozen (2026-09-11, issue #234, PR link pending): the GoTry kernel module surface (engine/ledger/gate, 5 files, narrow-not-wide, each with an architecture §/ADR basis) is mechanized into a SHA256 frozen manifest + runtime-module evidence gate (run-all §63) — kernel drift (modification/deletion/bypass/not-loaded) is red; engineering-reuse evidence only, the M6 implementation gate stays behind #137.

---

## 3. Technology Baseline: Harness = deepseek-harness

### 3.1 Baseline Stance

- **Agent = Model + Harness** (dsh's formula). GoTry does not build its own agent loop, plugin system, or session management — those are dsh's essence; GoTry's engineering value lands entirely on **domain plugins** and **data/supply-chain assets**.
- dsh's "everything is a plugin" (the Cordis composable kernel) aligns naturally with D1's architecture principles (Chapter 7): dual execution, WriteGate, and the transparency layer are "capability composition", not "framework modification".
- Sources: [the deepseek-harness repo](https://github.com/deepseek-ai/deepseek-harness), [deepseek.com/harness](https://deepseek.com/harness/), [The New Stack coverage](https://thenewstack.io/deepseek-harness-open-source-plugins/).

### 3.2 Target Runtime Shape

```
dsh kernel (Cordis, import)
  └── GoTry plugin pack (gotry-plugins, the sole in-house arena)
        ├── motivation-interview   motivation interview (ReAct orchestration pattern, referencing the T system; the B2B reuse seam, see 3.7)
        ├── graph-dispatcher       deterministic process DAG (design references the T system)
        ├── write-gate             write-operation confirmation gate (design references the T system)
        ├── trip-state             long-horizon state (bridge → loopx)
        ├── async-planner          async deep-planning orchestration (based on trip-state, see 3.6)
        ├── feasibility-engine     feasibility engine (imports Z3)
        ├── transparency-card      recommendation card rendering and the evidence chain (D1 §6)
        ├── memory                 backend-engineering memory base + the LLM semantic layer (design references the T system, see 3.5)
        ├── recommender            ranking and explainability (D1 §6.4)
        ├── capability-hotelbe     hotel-be atomic-capability connector (import/extend hotelbyte-cli)
        └── capability-travel-mcp  internal travel MCP tool bridge (bridge, PoC/MVP period; upstream tool names masked)
```

### 3.3 Language and Bridging Strategy

- The main language follows dsh: **TypeScript**; the Python side (loopx, Z3, evaluation) is not force-migrated — it integrates via the **CLI/JSON subprocess bridge**, with the bridge surface converging to the two plugins `trip-state` and `feasibility-engine`, and no large-scale FFI.
- The evaluation set lives in its own repo (modeled on the T system's independent evaluation set practice, name anonymized) and runs regression in CI.

### 3.4 Version and Upgrade Discipline

- **Decided: no version pinning, follow main, bet on it** (founder decision, G2 closed). dsh upgrades are routine: each upgrade runs the plugin-compatibility regression before merging, with no separate decision gate.
- The dsh plugin ecosystem (dsh-plugin topic) is continuously scanned: prefer reusing community plugins (sessions, UI, model access), equally following "never rewrite".

### 3.5 Memory Baseline: Backend Engineering as the Body, LLM as the Use

**Stance: whatever backend engineering can solve (deterministic facts) is never left to LLM memory; the LLM handles only what genuinely requires semantic understanding (motivation, retrospectives).** The design reference is the T system — before LLMs existed it used solid backend engineering to achieve a primitive but remarkably effective memory. Its six-layer structure is the reference framework for GoTry memory design (**neither code nor schema is copied**; GoTry designs and implements its own for the C-end leisure-travel domain):

| Layer | Reference content (forms proven in the T system) | GoTry counterpart |
|---|---|---|
| 1 User profile | Home city, currency, documents (parsed from login state, **never touched by the model**) | Departure-city defaults, sensitive-info backend fill |
| 2 Behavioral preference profile | Three-level decomposition (user-level/city-level/entity-level factors) + time windows (30/90/180/365d) + cohort fallback; frequent flight numbers per route, same-city airport preference, preferred time slots, cabin/star defaults | The travel version: regular hotels, frequent routes, pace tier, stamina tier, budget tier |
| 3 Standards and budgets | Travel standards by city+date+currency; expected price = standard + the user's habitual over-standard delta | Budget-tier profile (motivation-interview calibration + historical behavior) |
| 4 Itinerary timeline | Historical orders' per-day city stays; location-inference fact weights (hotel_order 100/flight 90/todo 10) + stop on conflict | "Where and when"; departure-city three-level resolution (future trips → profile → ask the user) |
| 5 Dual-zone session memory | Trip Notebook (durable, backend LLM extraction, **negative list: never store IDs/tokens/URLs**) + Hot Context (tiered expiry: 30min resource layer / 24h intent layer, CAS against concurrency) | The dual-zone session memory references its zoning/expiry/purification **design**; the schema is defined in-house |
| 6 Sensitive identity fill | Frequent flyers/contacts parsed by the backend from login state; multiple candidates fail closed to clarification | Companion profiles (the engineering form of red line 6) |

**Two iron rules adopted as GoTry design principles** (production-proven in the T system):
1. Profiles only enter the **ranking channel**, never hard filters (otherwise they empty out the search);
2. Any preference assertion must trace to a tool result or the user's own words (P0 anti-hallucination, isomorphic to D1 §6.3's evidence chain).

**The LLM semantic layer is the in-house increment** (ai-agent-book is a design reference only): the motivation profile (multi-year) and travel retrospective sedimentation — writes go through an audit path at the same level as WriteGate, user-visible and user-editable (red line 6).

**Design-reference reading list** (T system internals, paths anonymized; for understanding the design only, not a porting target): the three-level preference decomposition (hotel preference types), the dual-zone session-memory trio (session memory + hot context + notebook), the location-inference tool, the sensitive-parameter fill module, the request-level profile cache (singleflight).

### 3.6 Async Deep Planning: "Come Back in an Hour, Not Disappointed"

Why loopx looks productizable: **for genuinely complex planning, synchronous chat is the wrong shape**. The desired product effect — tell the user "come back in an hour" and then not disappoint. Today 99.999% of products disappoint the user an hour later (spinning, half-baked plans, or simply forgetting); an agent can easily do more checking work plus a few simple questions, and users will habituate to the rhythm after a few rounds.

- **Trigger**: for complex planning (multi-city/multi-constraint/long-horizon/cross-supply-chain) the agent proposes switching to deep-planning mode: "I'll work in the background; come back in about an hour."
- **Background work (the loopx tick loop)**: multi-round constraint solving and candidate comparison; item-by-item validation of prices/inventory/opening hours; a self-check list (the feasibility engine fully passing, the evidence chain complete); quota control stops on no progress; process evidence retained.
- **Revisit delivery**: not a generated itinerary but "**a verified itinerary + a few simple questions**" — all questions are closed multiple-choice (loopx explicit user gates: which of Day 3's two trade-offs, whether to add ¥300 to the budget), not a re-interview.
- **Notification**: in-app/push reminders on completion or blockage; the user can check progress at any time.

**The four "not disappointing" acceptance criteria** (into D4 evaluation):
1. There is always a definite deliverable after the promised time (no spinning, no silent failure);
2. The deliverable passes the self-check list (the feasibility engine all green, the evidence chain complete);
3. All open questions are simple multiple-choice (with trade-off explanations);
4. What cannot be done is said honestly (unsat core + alternatives) — a half-baked plan is never served.

Technical support: loopx's objective/gates/evidence/quota pattern is naturally the control plane for this product shape; the async-planner plugin handles orchestration and progress presentation.

### 3.7 The Motivation Layer: the Biggest Differentiator and the B2B Reuse Seam

Founder's judgment: **"why depart" is GoTry's biggest product differentiator and also the key to practicing everything-is-plugin** — because it is simultaneously the B2B version's reuse seam. Why depart in B2B? Because the customer wants to depart because of xxx — **the two-layer wrapping of why**.

**Contract design** (implemented at T2, with MotivationProfile as the core data object):

- **principal (traveler) and sponsor (operator) are separated**: in B2C they are one (the user themselves); in B2B the principal is the enterprise's end customer and the sponsor is the enterprise (agency/TMC/hotel/airline/destination tourism). The motivation interview always reaches the principal.
- **Downstream consumes only the contract, blind to differences**: the feasibility engine, recommendation, transparency cards, the itinerary builder, memory, and async planning all consume only MotivationProfile + the constraint set — that is the technical guarantee of "B2B reuses 99%"; changes happen only at entries, the inventory pool, and sponsor configuration (done by replacing/wrapping dsh plugins).
- **Red lines throughout**: in the B2B version the sponsor's take is equally disclosed to the traveler — the transparency value is B2B's trust selling point, not a cost.
- **Material parsing contract**: any material (photo/place name/link/guide) → aspiration (imagery + emotion) → hard constraints (origin/time/budget/stamina) → candidate set; **the destination inside the material is only a soft preference**. The product iron rule and the Erhai case: D1 §5.1/§4.3.

### 3.8 Revision Requirements for D1 "Product Design" (listed as a routine work item; does not block this outline)

D1 needs a v0.2 revision: ① rewrite §7.1's layered architecture into 3.2's dsh-plugin view and annotate §7.2/7.4 with their design-reference sources (the T system); ② rewrite §7.6's memory layering into 3.5's "backend engineering as the body, LLM as the use" six-layer framework; ③ add async deep planning (3.6) to §5.3's planning section as the standard form for complex planning; ④ rewrite §7.8's hotel-be bridging to the hotelbyte-cli CLI approach. Product semantics (main loop, transparency, WriteGate, feasibility) are unchanged.

---

## 4. Work Breakdown (WBS)

Each work package: deliverables → dependencies → acceptance. The P/B/T numbers map to the three lines; **bold** items are Phase 0 mandatory.

### Business Line (B)

| Package | Deliverables | Dependencies | Acceptance |
|---|---|---|---|
| **B1 market-lockdown decision pack** | Quantified comparison of the three candidate markets (China outbound / domestic / global English) + a recommendation | None (material already in D1 §3.3) | The founder makes the G1 decision |
| B2 business plan (D3) | Market size, GTM, unit economics, funding narrative | G1 | A complete BP with no conflict with D1's values |
| B3 compliance checklist (D6) | Commission-disclosure basis, payments/FX, data cross-border, proactive-outreach frequency caps | G1 | Every item has a legal opinion or a clear risk level |

### Product Line (P)

| Package | Deliverables | Dependencies | Acceptance |
|---|---|---|---|
| **P1 transparency-mechanism spec** | Recommendation card schema (what/why/full cost: D1 §6.5's money + door-to-door + arrival state/alternatives + evidence and freshness fields), commission-disclosure format | None (semantics already in D1 §6) | The schema is directly implementable by the transparency-card plugin |
| P2 main-loop interaction detail | Seven-stage interaction script and copy tone (motivation-interview question bank v1) | None | Covers the entry paths of D1's three personas |
| P3 metrics and tracking dictionary | Definitions, tracking, and guardrails for north-star and process metrics | P1 | Every metric computable with an owner |
| P4 D1 architecture chapter revision | Rewrite per 3.8's revision points (the aspiration-material and B2B motivation-seam items already landed directly in D1 at v0.5) | Phase 0 PoC conclusions | Consistent with D2 |
| P5 async deep-planning experience design | Trigger copy, progress presentation, revisit delivery (gate multiple-choice), the "not disappointing" acceptance basis (3.6) | None | The interaction script passes founder review |
| P6 B2B scenario and motivation-contract walkthrough | Pick 1–2 B2B forms (e.g. agency embedding, destination tourism) and walk through the two-layer why wrapping and the 99% reuse boundary; red-line basis throughout | 3.7 | The B2B reuse walkthrough minutes pass founder review |
| P7 shared-experience layer design | Experience-entry schema (assertion + corroboration + time decay), the reflux mechanism (linked with D1 5.6), confidence and anti-abuse, cold-start strategy | D1 §6.6 | Schema frozen + the first seed experiences ingested (including the founder's Dali/Lijiang experience) |

### Technology Line (T)

| Package | Deliverables | Dependencies | Acceptance |
|---|---|---|---|
| **T1 harness baseline PoC** | dsh (following main) imported + one GoTry plugin working + a loopx bridge demo (including minute-scale async ticks simulating 3.6) + a Z3 solving demo (minimal constraint set: **door-to-door time** (schedules/wake time/arrival state, D1 §6.5)/geo/budget) | None | End to end: natural language → constraints → feasible/no-solution + unsat core; async mode produces "verified results + multiple-choice questions" |
| T2 technical architecture design (D2) | Plugin inventory detail, the TripState data model, bridge protocols, deployment shape | T1 | Can guide D5 |
| T3 capability bridging | capability-hotelbe (based on hotelbyte-cli: command-gap inventory → same-style extensions for missing commands → the dsh plugin calls via CLI) + capability-travel-mcp | G5 (internal travel bridge approval) | Both plugins usable inside dsh, `--json` structured output with evidence fields |
| T4 evaluation plan and evaluation set (D4) | Feasibility/factuality/transparency evaluation sets + the cost dimension + the four "not disappointing" criteria (3.6) + CI regression | T1, P1 | Baseline metrics reportable (D1 §7.9 targets) |
| T5 cost engineering baseline | First implementation and measurement of model-tiered routing, context compression, caching, batching | T1 | Per-session cost measurable and reportable |
| T6 WriteGate and dual execution | write-gate + graph-dispatcher (design references the T system, implemented in-house) | T2 | Own use cases all green: idempotency, pending state, unproven reads defaulting to writes |
| T7 memory layered implementation | Implement in-house per 3.5's six-layer framework (C-end domain field redesign; referencing the **design** of dual-zone session memory, location inference, and the request-level profile cache) + the LLM semantic layer (motivation profile, audited writes) | T2 | Preference assertions 100% traceable; "profiles never enter hard filters" has a guard test |
| T8 structured itinerary builder | Rewrite TREK's functional face from the design: Day planner (drag/cross-day), map view, budget view, list import (GPX/shared lists) + the trip/day/place/budget tool schemas (referencing its 150+ tools and fine-grained scopes) | T2, P2 | D1 §5.3 acceptance: complete interactions + realtime feasibility validation wired in |

---

## 5. Phase Plan and Decision Gates

### 5.1 Phases

- **Phase 0 (immediate, ~2–4 weeks)**: this outline + T1 PoC + P1 transparency spec + B1 market decision pack. Output: the technology baseline confirmed or falsified by the PoC, the market locked, the transparency schema frozen.
- **Phase 1**: T2/D2 → D5 (MVP implementation plan) → start product M1 (per D1's roadmap: motivation interview + planning + structured itinerary + transparency cards + feasibility v1, no booking).
- **Phase 2/3**: correspond to product M2/M3; business-line D3/D6 advance in parallel after G1.

### 5.2 Decision Gates

| Gate | Question | Options | Impact | Timing | Status |
|---|---|---|---|---|---|
| **G1** | Launch-market lockdown | China outbound / domestic depth / global English | All 📍 items, supply chains, compliance | End of Phase 0 | **Decided (2026-08-22, China outbound first; see `tech-strategy.md` §7)** |
| G2 | dsh version strategy | — | — | — | **Decided: follow main, no version pinning, bet on it (2026-08-22)** |
| G3 | TREK reuse path | — | — | — | **Decided: rewrite from the design — implement in-house using the design as reference, no code imported, no self-hosting (2026-08-22)** |
| G4 | hotel-be atomic-capability exposure form | — | — | — | **Decided: CLI form, based on hotelbyte-cli (2026-08-22)** |
| **G5** | Internal approval for the internal travel tool bridge (T-system side, masked) | Bridge / don't bridge (switch to external suppliers) | Capability source during PoC/MVP | Before T3 | **Retained as a future internal-asset lane** — the current product path = the public MIT hotelbyte-cli + the process bridge (the `external/hotelbyte-cli/` public MIT channel); future internal-bridge authorization is tracked separately at [#348](https://github.com/Danceiny/gotry/issues/348) and stays closed until real authorization triggers; HotelByte transaction admission remains governed by [#136](https://github.com/Danceiny/gotry/issues/136) — the two must not substitute for each other. **Mechanical guard landed (2026-09-11, #348)**: `ts/scripts/g5-guard.ts` + the founder-maintained authorization ledger [`g5-authorization-ledger.md`](g5-authorization-ledger.md) (initially empty) fail any unauthorized internal-travel-bridge reference in tracked files (run-all §58); PR link pending. |

---

## 6. Change Management and Document Discipline

- **Change the outline first, then start work**: any work package deviating from the reuse matrix or adding a referenced project raises a revision first (a version bump of this document), then executes.
- Per-domain document headers maintain "outline version of status/dependencies"; when the outline is bumped, all per-domain reference points are re-checked in sync.
- After each decision gate closes, the conclusion is written back into this document's corresponding table (the status column) and synced to the affected documents.

---

## 7. Pending Confirmations (inherited from D1 §12 plus additions)

| # | Item | Source | Suggested decision timing |
|---|---|---|---|
| 1–8 | (the 8 items inherited from D1 §12: market, product form, hotel-be exposure, flight/activity supply chains, commission-disclosure compliance, subscription pricing, outreach frequency caps, team budget) | D1 | See D1 |
| 9 | TREK AGPL compliance opinion | This document G3 | Decided: rewrite from the design; no legal opinion needed |
| 10 | dsh version pinning and upgrade cadence | This document G2 | Decided: follow main, bet on it |
| 11 | The final form of the TS↔Python bridge surface (whether loopx/Z3 keep a Python side long-term) | This document 3.3 | During T2 |

---

## Appendix: New Reference Sources in This Document

- [deepseek-ai/deepseek-harness (GitHub)](https://github.com/deepseek-ai/deepseek-harness) — MIT, everything is a plugin, the Cordis kernel, Agent = Model + Harness
- [The DeepSeek Harness official page](https://deepseek.com/harness/)
- [The New Stack: DeepSeek open sources an agent harness where everything is a plugin](https://thenewstack.io/deepseek-harness-open-source-plugins/)
- [Eigent AI: DeepSeek Harness — Open-Source Agent Runtime](https://www.eigent.ai/blog/deepseek-harness-agent-runtime)
- [hotelbyte-com/hotelbyte-cli (GitHub)](https://github.com/hotelbyte-com/hotelbyte-cli) — MIT, agent-native CLI (hbcli), `--json` on every command, `@file` payloads, automatic credential detection, self-updating single binary
- The T-system memory blueprint (six-layer backend memory; the structure list is in §3.5; local paths anonymized)
