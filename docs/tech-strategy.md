[English](tech-strategy.md) | [简体中文](tech-strategy.zh-CN.md)

# GoTry Technology Selection and Six-Month Iteration Roadmap (M2–M4)

> Positioning: **the single source of selection rationale, evaluation system, division of labor, and the continuous improvement loop**. Timeline authority remains with `roadmap.md` (Entry/Exit for M0–M6); this document only covers "what to use, who builds it, and how to keep getting better".
> Constraints: reuse follows the master outline §2 three strategies — import = OSS with a clear license; bridge = out-of-process runtime bridge; reference = design borrowing only; **there is no middle state**. The founder's two hard constraints take priority: the harness takes dsh as the reference baseline, no self-built agent runtime; open-source projects once referenced are never rewritten.
> Discipline: **a new import must first go through §7 decision registration, be backfilled into the master outline §2 reuse matrix after founder approval, and only then may work begin.**

---

## 1. Review Conclusions Summary (2026-08-22, after M1 exit)

The architecture design is healthy: code and docs are highly consistent, and layering discipline has real enforcement anchors in tests. The real systemic risk was **doc freshness having no mechanism** (now covered by `architecture.md` §11); the main engineering gaps are the deprecated layer still bearing load (D-7) and the dialogue loop previously not in CI (D-8).

**Strengths (keep)**: arithmetic/solving layering + dual-implementation diffing — the verification strength of the correctness core far exceeds projects at the same stage; contract-first, mock-first, replay-as-behavioral-regression (core practices of every agent harness, already intrinsic); ADR pre-registered retirement conditions + anchor column; red lines enforced in code (throw on missing evidence); ADR-10 proves the learning loop "failure → same-day ADR → validation gate lands in code" works.

**Gaps (all on the books)**: ① state fragmentation → §11 freshness mechanism (landed); ② deprecated layer still bearing load → D-7 (redeemed M2 W2); ③ dialogue loop not in CI → D-8 (redeemed in batch 0); ④ contract split (contracts.ts five-tool draft vs plugin three tools; `TripState.wishes`/`Gate.answer` have no readers/writers) → M2 W1; ⑤ engineering hygiene (zod dead dependency / SPEC_SYSTEM dead code / naming residue / no pyproject / z3 version mismatch / wish-pool no dedup) → batch 0; ⑥ async scheduling has no in-repo implementation → M3 W5; ⑦ WriteGate zero code (M5 intentionally left blank, design draft brought forward to M3 W4); ⑧ observability missing (M3's three metrics have no measurement infrastructure) → M2 W5 schema instrumentation, M3 W2 system.

## 2. Capability Gaps → Selection Matrix

| Capability gap | Milestone | Strategy | Candidates (license) | Rationale | Decision gate |
|---|---|---|---|---|---|
| LLM abstraction | M2 | maintain + evaluate migration | `@deepseek-ai/dsh-llm` (dsh family) | current adapter already provider-neutral; dsh baseline rule: don't self-build what dsh already provides. Migrate on feature parity (think stripping/json_object) | §7-6 |
| Flight data source | M2 Entry | bridge + data pack | see §2.1 | free/open-source first during the no-commercial-partnership period | §7-1 (founder) |
| Hotel data | M2 | import + extend | hotelbyte-cli (MIT, decided T3) | extend gaps in the same style and contribute back upstream | decided (G4) |
| MCP bridge | M2–M3 | bridge→import SDK | `@modelcontextprotocol/sdk` (MIT) | after G5 closes, bridge the T system (an enterprise-grade travel Agent system, de-identified); until then keep CLI/JSON bridge ≤2 (ADR-3) | G5 (external) |
| Test framework | throughout | **do not import** | keep node:assert + unittest | zero-framework discipline suffices; replay-as-behavioral-regression already covers the core value of promptfoo/deepeval, avoiding dependency bloat. Revisit if the M3 panel falls short | §7 (default maintain) |
| LLM observability | M2 instrumentation / M3 system | self-built schema + import evaluation | JSONL trace (self-built); Langfuse (MIT, verify before introducing) | first extend the bridge-latency pattern to land trace; bring in a system only when panel needs (hallucination rate/finalization rate) genuinely appear | §7-5 |
| Minimal web surface | M3 | import candidate | assistant-ui (MIT) + Vercel AI SDK (verify before introducing) | gates multiple-choice / transparency cards need a host UI (D-4 redemption); UX references Claude Code permission prompts (closed-source reference) | §7-3 |
| Memory layer | M4 | **self-built core first** | mem0 (Apache-2.0) as fallback | T system six layers are reference-only (internal asset red line); the two iron rules (profile enters ranking only, not hard filtering; assertions traceable) are small to implement; vector store deferred until evidence appears | §7-4 |
| WriteGate | M3 design / M5 implementation | **self-built** | reference: Claude Code permission modes (closed-source) + T system write-gate (internal, design only) | T6 elements: idempotency key, pending state, unproven read-only defaults to write | §7 (design draft M3 W4) |
| Agent runtime | throughout | import (decided) | dsh tracking main | founder constraint: no self-build, no rewrite | decided (G2) |

### 2.1 Data Sources as Capability: The Free/Open-Source First Route

Data sources are part of the L4 capability layer, not a footnote to external dependencies. The mix during the no-commercial-partnership period (now → before M5):

1. **Free-tier official APIs**: Amadeus Self-Service test tier (free monthly quota, sandbox data), aviationstack free tier, etc. — real samples of schedules/fares, small in volume but real;
2. **Public datasets**: OpenFlights (airport/route static), OpenSky Network (real-time ADS-B positions, free community API), GTFS (overseas ground transport) — static skeleton and validation sources;
3. **User's already-booked resources**: the `bookedResources` pattern — users hand over ticketed itineraries, and the system plans around real anchors. Product-wise this is the "semi-self-service itinerary" scenario; data-wise it is a zero-cost source of real anchors;
4. **Manually distilled static packs** (status quo continues): the demo-phase data pack pattern, with graded evidence labeling to stay honest.

Evidence chain labeling is a moat during data scarcity: the three-level labels `[实时API]`/`[公开数据集]`/`[估算]` make data quality transparent to users — exactly GoTry's transparency differentiation. **Commercial supply chain deferred to M5**: negotiating leverage requires transaction volume, and booking-grade data is not needed before WriteGate ships anyway. Domestic rail (12306) has no official open API; gray-market databases are not admitted — use static packs + manual distillation.

## 3. Six-Month Iteration Roadmap and Division of Labor (2026-09 → 2027-02)

Owner labels: 【Founder】 = final calls/walkthroughs/business; 【agent】 = engineering execution (loopx dispatches work orders; multiple agents may run in parallel, observing named-staging discipline); 【external】 = approval/partnership dependencies. Assumption: founder + agent collaboration, no stage-skipping, no premature optimization of the next stage's work.

### Batch 0 (week of 2026-08)
- 【agent】 Done: M1 exit state sync (`3ed6194`), ADR freshness mechanism (`0bfacff`), this document.
- 【agent】 Done (historical snapshot): hygiene batch (removed zod dead dependency and SPEC_SYSTEM dead code, renamed `createDeepSeekLlm` to a provider-neutral name, wish-pool dedup, pyproject.toml + pinned z3 to the same version as TS); replay+smoke entered `run-all-tests.sh` (**D-8 cleared**, closed within the month of 2026-08).
- 【agent】 Done (historical snapshot): M2 W0 real dsh runtime assembly (`ts/cordis.gotry-patch.yml` + `ts/dsh-runtime/`, `538018f`/`5acedb3`), the early MiniMax stream protocol blocker resolved; M2 has exited, see the `roadmap.md` historical node (exit `b0cfd97`, §7-1 three-layer mix landed end-to-end).

### M2 Real-Time Data (Sep–Oct, ~8 weeks)
- **W0 real dsh runtime hookup** 【agent】: gotry-tools runs end-to-end in real dsh; MiniMax stream protocol adaptation lands in `dsh-llm.ts`.
- **W1 contract ratification** 【founder walkthrough + agent wiring】: S1 three walkthrough points (Gate only allows multiple choice / workWindow must carry evidence / assumptions three-way classification); align the five-tool registry with the plugin three tool names; wire or delete `TripState.wishes`/`Gate.answer` (leave no types without readers/writers).
- **W2 D-7 migration** 【agent】: TS unified adds candidate-form solving (align with `unified.py solve_choice_segment`, diffing as escort) → dsh plugin and `cli.py` switch to unified → engine/journey demote to pure oracle. **D-7 clearance day = ADR-5 cash-in day**.
- **W3 hotel bridge** 【agent】: hotelbyte-cli import+extend (T3), gaps extended in the same style and contributed back upstream.
- **W4 flight bridge** 【agent, precondition §7-1】: land the flight capability plugin per the §2.1 mix; **ADR-6 cash-in** — the static pack retires to test fixture.
- **W5 observability instrumentation** 【agent】: LLM trace JSONL (schema: prompt digest/response/latency/token/validation gate result); dsh-llm migration evaluation (§7-6).
- **Exit cross-check**: solving differences between real-time vs static on the same JourneySpec are measurable and attributable + run through the §11 freshness checklist once.

### M3 Minimum Viable Product (Nov–Jan, ~10 weeks)
- **Hard precondition**: G1 market lock 【founder】 — master outline B1 decision package materials are complete (**historical snapshot**: G1 was locked on 2026-08-22 as China outbound first launch, see §7 decision 2 and the `gotry-master-outline.md` G1 row; the text here is kept as the strategy context at the time of writing).
- **W1 minimal web surface** 【agent, precondition §7-3】: an experienceable form of transparency cards + motivation interview + gates multiple choice, **D-4 cleared**.
- **W2 metrics panel** 【agent, precondition §7-5】: hallucination rate/finalization rate/NPS measurement online (evaluation quality layer, §4); seed data flows back into the evaluation set.
- **W3 seed users** 【founder+agent】: 50–200 people invite-only, Erhai + Phuket two scenario types.
- **W4 WriteGate design draft** 【agent drafts, founder reviews】: idempotency key / pending state / unproven read-only defaults to write; produce ADR candidates.
- **W5 S5 second half** 【agent】: loopx tick truly drives async scheduling, the AGENTS.md manual-sweep rule retires.
- **Exit cross-check**: finalization rate ≥40%, NPS ≥40, POI hallucination <1% (evaluation trio all green).

### M4 Memory and "Next Departure" Entry (Feb)
- Memory selection decision (§7-4) 【founder】; north star (next-departure rate) measurement online 【agent】; the reconciliation seven questions = first calibration samples for the red-eye model and preferences, **D-6 redemption** 【agent】.
- **Half-year-end state**: M4 in progress; M5 (WriteGate productionization / transaction loop) design-ready.

## 4. Evaluation System (ADR-11 Landing)

Evaluation is a first-class architectural component of an agent product, not an afterthought tool. Three layers, each with its own job:

| Layer | Guards against | Form | Status |
|---|---|---|---|
| Regression layer | regression (breaking things) | unit (20/20) + diffing (TS↔Python) + replay fixtures (mock) | ✅ `run-all-tests.sh`; replay entered CI in batch 0 |
| Quality layer | drift (quietly getting worse) | evaluation set + metrics panel: POI hallucination rate, finalization rate, four no-disappointment items, NPS | online M3 W2; until then replay terminal-state assertions as backstop |
| Patrol layer | "mock green but real intelligence bad" | nightly real LLM replay (`replay-real.ts`), with budget gate and result archival | batch 0 filed as loopx todo; the ADR-10 lesson institutionalized |

Discipline: the evaluation set only grows, never changes semantics (changing semantics = new case); every M-exit must pass the corresponding layer; a metric not in the architecture doc does not exist. Evaluation data reflow path: seed user sessions (de-identified) → evaluation set candidates → enrolled after reconciliation.

## 5. Harness Practice Absorption Matrix (reference plane; all code introduction goes through §7)

| Source | Practice | GoTry landing point | Strategy |
|---|---|---|---|
| Claude Code (closed-source) | permission modes | WriteGate design draft (M3 W4): unproven read-only defaults to write, confirmation UX | reference |
| Claude Code (closed-source) | hooks (execution at event points) | loopx tick wiring, S5 second-half async scheduling | reference |
| Claude Code (closed-source) | context compaction | M3+ long-session (multi-segment itinerary repeated edits) context compaction | reference |
| Claude Code (closed-source) | CLAUDE.md contract | AGENTS.md already exists, keep thickening (freshness/staging discipline are two examples) | reference |
| OpenHands (MIT) | evaluation harness/trajectory replay | reference for the §4 patrol layer and evaluation set organization | reference (evaluate import when code is needed) |
| Aider / OpenCode | tool surface organization, edit protocol | reference for dsh plugin tool surface evolution | reference |
| LangGraph (MIT) | graph-style state machine | **reference only, no import** — conflicts with the ADR-9 deterministic loop and the dsh baseline | reference |
| mem0 / Letta (Apache-2.0) | memory layering and write gating | M4 memory domain design reference; mem0 as import fallback | reference / import fallback |
| Langfuse (MIT) | LLM trace/evaluation panel | M3 W2 metrics panel candidate | import candidate (§7-5) |
| T system (internal, de-identified) | write-gate/six-layer memory/tool-owned dates | **design reference only; no code or schema copied** (internal asset red line) | reference |

## 6. Continuous Improvement Loop (How to Keep Getting Better)

```
real usage (seed users / reconciliation / patrol alarms)
  → reconciliation (demo-reconciliation pattern, three destinations: data error → fix data / model gap → record ADR / product gap → loopx todo)
  → landing (ADRs enter the §8 table with anchors; debt enters the §10 table with redemption timing; product items enter loopx)
  → verification (regression layer all green + patrol layer nightly + quality layer panel)
  → M-exit freshness checklist cross-check, enter the next milestone
```

Cadence: **nightly** = real LLM replay (budget gate); **weekly** = reconciliation meeting (post-seed phase); **every M-exit** = full ADR table review + debt table cross-check + state-plane sync (§11). loopx todos derive only from `architecture.md` §9/§10 and this document — optimization items must not live only in conversations.

## 7. Decision Log (Settlement Status Refreshed)

| # | Decision item | Recommendation | Status |
|---|---|---|---|
| 1 | Flight data source mix | Amadeus test tier + OpenFlights static + bookedResources user-supplied; gray-market databases not admitted | ✅ Decided (three-layer mix = skeleton + validation + anchors, landed M2; Amadeus later replaced by the FlyAI official channel after shutdown) |
| 2 | G1 market lock | China outbound first (shortest evidence chain and supply chain radius) | ✅ Decided (2026-08-22, China outbound first launch) |
| 3 | Web surface framework | assistant-ui (MIT) + AI SDK; if insufficient, self-build a minimal surface | ✅ Decided (no framework introduced — dsh web is the only product surface, D-4 cleared; thin shell `shell/` deleted) |
| 4 | Memory solution | self-built core (MotivationProfile contract extension), mem0 as fallback | ✅ Decided (self-built six layers, `design/memory-design.md`) |
| 5 | Langfuse observability | JSONL first; import after the panel need is confirmed (verify license) | ✅ Executed per recommendation (JSONL trace landed; Langfuse not introduced, need has not appeared) |
| 6 | dsh-llm migration | migrate on feature parity — don't self-build what dsh already provides | Not migrated (maintaining the provider-neutral adapter; the feature gap is not blocking) |
| 7 | Master outline §2 proposed additions | proposed: `@modelcontextprotocol/sdk` (after G5 closes, MIT), assistant-ui (MIT, verify), Langfuse (MIT, verify), mem0 (Apache-2.0, fallback) | Majority lapsed (candidates in 3/4/5 all not introduced); new imports still follow this section's registration discipline |
