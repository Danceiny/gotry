[English](stage1-top-down-design.md) | [简体中文](stage1-top-down-design.zh-CN.md)

# Stage 1 Top-Level Design: Top-Down (Contracts → Loop → Wiring Intelligence to Reality)

> Role: frozen historical design for the original Stage 1 conversation loop and component contracts.
> Status: frozen(2026-09-13).
> Current authority: [GoTry architecture](../architecture.md). Runtime inventory, delivery state, and open work must be read there rather than inferred from this snapshot.
> Interpretation: counts, status labels, and “to define” entries below describe the Stage 1 baseline at the time of design; they are not a current implementation ledger.
> Historical decision preserved: validate the loop top-down with a deterministic mock LLM before using a real model; model access changes intelligence quality, not whether the architecture can be tested.

## 1. Top-level black box: system behavior of one session

Input (the user's first message, a real case):
> Landing in Shenzhen at 22:40 on Friday 7.17; on the morning of 7.18, going to Hong Kong to open a bank account & sign an insurance contract; ... departing Shenzhen in the early hours of Monday 8.10, to arrive in Dubai before work on Monday. Please plan and recommend flights and hotels for my trip.

The system must complete this in one turn (what Kimi botched over 13 turns):

```
user message ──► ① calendar/fact assertion (2026 calendar, weekday mapping computed once, persisted into state forever)
          ──► ② interview completion (ask for whatever is missing: work hours? booked resources? companions? budget tier?)
          ──► ③ JourneySpec extraction (natural language → unified model, the LLM's translation duty)
          ──► ④ solving (unified engine, deterministic duty: anchors/work windows/full cost/wish pool)
          ──► ⑤ rendering (transparent cards + full-cost table + multiple-choice gates, LLM explanation + templates)
          ──► ⑥ when complex: async ("come back in an hour", loopx tick)
```

② is incremental follow-up rather than starting over; ③④⑤ are re-entrant each turn (when the user changes one answer, only the affected segments re-run). **State persists; the human is not a system component.**

## 2. First-level decomposition: component contracts

### 2.1 Session state TripState (the top-level data contract; every component reads and writes around it)

```ts
TripState = {
  calendar: { year: 2026, assertedWeekdays: {...} }        // ① output; assert once, use for life
  profile: { workWindow?, companions?, budgetTier?, ... }  // ② output (Kimi retrospective: these two used to appear last)
  spec?: JourneySpec                                       // ③ output (unified model, already exists)
  solve?: SolveResult                                      // ④ output (already exists: verdicts/exclusions/red_flags)
  gates: Gate[]                                            // ⑤ pending questions (multiple choice)
  wishes: WishEntry[]                                      // "the next trip"
}
```

### 2.2 Tool surface (L2 contract; registered as dsh plugins, 3 exist, 2 to add)

| Tool | Responsibility | Status |
|---|---|---|
| `gotry_interview_next(TripState) → Question[]` | Deterministic (missing-field driven, not LLM improvisation) | **To define** |
| `gotry_spec_extract(conversation history) → JourneySpec` | LLM (translation) | **To define** (inside the dsh runtime) |
| `gotry_solve(JourneySpec) → SolveResult` | Deterministic (implemented: unified) | ✅ |
| `gotry_render(SolveResult) → cards/tables/gates` | Templates + LLM polish | Partial (answer_md exists) |
| `gotry_wish_pool_add` / `gotry_motivation_save` | Deterministic | ✅ (plugins exist; `motivation_save` accepts `homeCity` + optional/explicit exact `homeCityEvidence`, persisting `homeCityPreference { value, evidence, updated_at }`; `resolveDefaultOrigin` serves only as the precedence contract — issue #338) |

The iron law of responsibility is unchanged: the LLM only does question phrasing for ②, translation for ③, and explanation for ⑤; **verdicts and arithmetic are always deterministic components**.

### 2.3 Conversation loop (L2 orchestration contract)

```
loop:
  msg ← user
  state ← TripState.load(session)
  ①if new facts conflict with calendar/profile → point it out and confirm (never silently reshuffle)
  ②qs = interview_next(state); if qs non-empty and msg unanswered → follow up (incremental)
  ③spec = spec_extract(history + state)     // LLM
  ④state.solve = solve(spec)                // deterministic
  ⑤reply = render(state.solve) + gates      // LLM+templates
  TripState.save(state); → reply
```

## 3. Top-down implementation order (each step has independent acceptance; leaves move last)

| Step | What | Acceptance | Depends on |
|---|---|---|---|
| S1 | **Contract freeze**: TripState and the 5 tools' schemas (TS types + JSON Schema) land in `ts/src/contracts.ts` | Contract walkthrough passes (one founder review) | None |
| S2 | **Mock vertical slice**: mock-LLM (deterministic script: reads a script and replays the user-side input of the Kimi conversation) + real tool surface → the §2.3 loop runs end to end | Replay with your original opening line: the system proactively asks for the work window and the booked hotel, the calendar is asserted once, and it produces the plan and gates — **zero API key throughout** | S1 |
| S3 | Solver mount (wire the finished unified into the loop as the implementation of gotry_solve) | Replay output is equivalent to the current demo plan document | S2 |
| S4 | Real LLM hookup (dsh runtime + DEEPSEEK_API_KEY) | Same opening line, real conversation quality ≥ mock replay (the acceptance criterion from the Kimi retrospective) | S2+key |
| S5 | Async mode made real (loopx tick drives "in an hour") | The four no-disappointment criteria hold in real conversations | S4 |

**This order demotes "waiting for the key" from an architecture blocker to a quality variable of S4: S1-S3 can all be done now.**

## 4. New ADRs

- **ADR-8 (mock-LLM first)**: architectural validation of the conversation loop uses a deterministic scripted LLM and does not depend on a real model; intelligence quality and architectural correctness are decoupled. Retirement condition: after S4 completes, the mock is kept as a regression fixture.
- **ADR-9 (interview determinism)**: `interview_next` is driven by missing fields (a configurable question bank); the LLM only polishes question wording — the root cause of Kimi's "never interviews" disease is improvisation, and deterministic driving is the cure.

## 5. Relation to debt and milestones

- D-3 (LLM not in the loop) decomposes into: S1-S3 (architecture, actionable) + S4 (intelligence, waiting for the key) — the "architecture half" of the debt no longer blocks.
- D-4 (UI) stays after Stage 1; this design's L1 is "conversation as the interface", with gates presented as in-message multiple choice.
- The existing unified solver/data packs/plugins = the leaves of this design, zero rework.
