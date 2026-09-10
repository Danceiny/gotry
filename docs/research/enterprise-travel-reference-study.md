[English](enterprise-travel-reference-study.md) | [简体中文](enterprise-travel-reference-study.zh-CN.md)

# Enterprise Travel Agent System Reference Study → gotry Borrowing Decisions (2026-09-03)

> Status: frozen (reference study, 2026-09-03; sources anonymized)
> Subject: a production enterprise travel Agent system (hereafter "the T system"; ReAct orchestration + deterministic DAG dual track,
> production-grade state surface, compliance choke layer, event-driven rendering; material = the eight-dimension comparison and deep reading provided by the founder,
> sources anonymized). This document answers only: **which mechanisms gotry should borrow, in what shape, up to which milestone, and which
> it explicitly does not borrow**. All conclusions map to existing ADR/RFC/debt/milestone seams; no castles in the air.
>
> Prior judgment: the T system is strong at **engineering and production infrastructure**; gotry is strong at **formal methods and product philosophy**
> (Z3 solving / evidence chains / door-to-door full cost / wish pool). The two are not substitutes; every borrowing in this document is
> constrained by "do not dilute differentiation".

## Decision summary table

| # | T system mechanism | gotry decision | Landing point/seam |
|---|---|---|---|
| 1 | Dual-track execution: ReAct orchestration + a deterministic DAG state machine owning real submissions | **Adopted as M5 design input** (no code written now) | ADR-17 `booking_saga_fsm.v1` + RFC S4 WriteGate L0-L4; three items added to the M5 Entry checklist (below) |
| 2 | Production-grade state: change-stream push + session-lease distributed locks + pending CAS + a crash-recoverable persisted turn coordinator | **Deferred** (the trigger discipline is already set; not done early) | When D-15 triggers, implement against its checklist with this as reference |
| 3 | Write-operation closed loop: sealed interface compile-time isolation + op uniquely derived from Kind + pending persistence + second confirmation | **Adopted as M5 design input** (same batch as #1) | The ADR-17 edge table already has gate/external-event edge types and the HITL suspend-resume shape — isomorphic |
| 4 | Compliance choke layer: Model decorators choke ALLOW/MASKING/DEGRADE/REJECT, zero business-code change | **Adopted as M6 design input** | The M6 B2B compliance layer paradigm; the current C-end physical-isolation red line stays |
| 5 | Event-driven rendering: emit structured events during execution, incremental push chunk by chunk | **Partially exists already; no new mechanism** | Booking Copilot v2 typed SSE is already the isomorphic surface (§49); incremental rendering on the dsh product surface is constrained by upstream rendering capability, see below |
| 6 | Dual-model tiering + slot-extraction small model + context compression | **Not adopted (status quo)** | ADR-24 Tier 0 deterministic routing (zero LLM) + slot-spec deterministic extraction already cover the same problem; model choice belongs to the dsh host |
| 7 | Domain skill system (tool set + prompt + boundary guards + renderers) | **Direction adopted, lands in M6** | Matches the M6 delivery shape "one B2B scenario with zero kernel changes"; no premature abstraction in the current single-tenant stage (YAGNI) |
| 8 | Engineering maturity (render parity tests / routing evals / canary releases) | **Continuously adopted, no new action** | run-all's existing anti-drift test family + the evaluation lane (#96/#100/#102) are the corresponding surfaces |

## Per-dimension decisions and rationale

### 1+3. Dual-track execution and the write-operation closed loop → M5 design input (three mechanisms enter the M5 Entry checklist)

The T system's core insight: not every leg of travel suits LLM ReAct — search/explanation/recommendation suit the LLM,
while "select → confirm → submit → pay" is a strongly sequential, strongly confirmed, compliance-heavy state machine that must be a deterministic DAG.

gotry's corresponding seam **is already frozen in the vocabulary layer**: the edge table of ADR-17 `booking_saga_fsm.v1` is that DAG
(four edges as a full function table + a rejection closed set + the three edge types deterministic/gate/external-event + HITL approval
suspend-resume), and RFC S4's WriteGate L0-L4 progressive-authorization vocabulary is already in the roadmap M5 deliverables. The T system's
practice **validates this direction** and adds three implementation mechanisms that must be checked off one by one at M5 Entry:

1. **Write-boundary separation**: the LLM (in the ReAct seat) only orchestrates and produces "actions pending confirmation"; after
   confirmation, real submission goes only through the deterministic state machine (the DAG seat). Mapping: gotry L2 suggestions may be
   LLM-produced; L3/L4 submissions must go through the saga edge table, and the LLM must not construct write calls directly.
2. **pending state persistence**: before user confirmation, state lands in shared storage; the next round resumes from pending instead of
   relying on the LLM to re-understand context. Mapping: gotry already has the `pending_writes` saga + the ADR-15 ledger (the empty-receipt
   physical CHECK recorded in D-22 is an M5 Entry redemption item) — naturally compatible; the turn-handoff work order
   (ADR-24) is another existing surface for "cross-turn recovery".
3. **sealed interface + op uniquely derived from Kind**: the Executor accepts no bare IDs; write paths are isolated at compile time;
   sensitive-parameter handling is a separate module (nearly 800 lines in the T system — the polishing cost of a security boundary is
   unavoidable; budget for it). Mapping: booking-saga's rejection closed set is the vocabulary-layer embryo of the same idea;
   upgrade it to a type closed set at M5 implementation.

The constraint is unchanged: M5 Entry = M4 exit + the supply-chain protocol (roadmap); until then, no write path is touched
(AGENTS.md red line: no direct writes may be implemented before confirmation).

### 2. Production-grade state persistence → deferred; the D-15 trigger discipline is unchanged

The T system's change-stream push, session-lease distributed locks, pending CAS, and crash-recoverable persisted turn coordinator
are necessities for multi-instance/FaaS deployments. gotry is a local single instance; the ADR-15 SQLite ledger + the ADR-16 dual-form
freeze already cover the current form; D-15 names explicit triggers (a second real user / multi-machine deployment / an AaaS kickoff) before
Litestream/cr-sqlite/claim-fence implementation starts.

**Registered**: when D-15 triggers, the T system's lease/CAS/pending-recovery trio is the reference implementation checklist.
Not done early (the §9 principle: do not optimize the next stage in advance).

### 4. Compliance choke layer → M6 design input (decorator pattern, zero-intrusion choke)

The T system's compliance choke is a decorator on the Model interface: at the service layer, every model instance is uniformly wrapped once,
with the four actions ALLOW/MASKING/DEGRADE/REJECT, streaming redaction restoration + multi-turn redaction persistence, and zero change at business call sites.

gotry today: C-end single user; the privacy red line is physical isolation (no collecting passwords/verification codes/cookie values; the session channel
takes cookie names only). When moving to M6 B2B (travel-agency embedding), enterprise itinerary/expense/identity data must pass a compliance layer.
**The decorator pattern is the paradigm choice for zero-intrusion adoption**: gotry's model calls concentrate in the dsh host layer; at M6, adding
an equivalent wrapper on the dsh-llm bridge surface suffices — no per-tool changes. Registered as an M6 deliverable candidate; not implemented now
(the C end has no sensitive-data egress surface).

### 5. Event-driven incremental rendering → an isomorphic surface already exists; no new mechanism

The T system emits events chunk by chunk during DAG execution (headline/table/card/notice) and pushes them to the frontend incrementally,
so the user never waits for the whole run to finish; it also has render parity tests guaranteeing byte-identical event rendering against templates.

gotry's counterpart: **Booking Copilot v2's typed SSE event stream is already the isomorphic implementation** (action.receipt /
approval.granted/consumed / decision batch, exact replay, run-all §49). The one-shot rendering on the dsh product surface is a host rendering
capability constraint, not a surface gotry can change unilaterally; perceived waiting during long computations already has a product answer in the ADR-24
handoff (drop a work order + state the ETA + a way to come back). Conclusion: **no new mechanism**; if the dsh
upstream opens up incremental rendering capability, map the "solve-progress events" (captured constraints / candidates appearing one by one) into it —
registered as a dsh capability dependency; no gotry-side work item is opened.

### 6. Dual-model tiering / slot-extraction small model / context compression → not adopted (status quo)

The T system uses fast/slow dual-model tiering + a specially trained slot-extraction small model + layered context compression.
gotry's same problems are already covered by cheaper mechanisms:

- turn triage = ADR-24 `turn-policy.ts`, a **deterministic classifier (zero LLM)** — cheaper than a small model and reproducible;
- slot extraction = `slot-spec.ts` deterministic code (verbatim-retention discipline), with no dependence on LLM structured extraction;
- context pressure = avoided via handoff work orders (persisted to disk + ETA), not compression;
- model choice belongs to dsh host configuration; gotry holds no model-routing surface (dual-model tiering has no foothold and no necessity).

If real cost/latency-pressure data appears later, revisit; do not introduce this merely because the T system has it and gotry does not.

### 7. Domain skill system → direction adopted, lands in M6

The T system's flight/hotel/train/requisition/order skill = tool set + prompt + boundary guards
+ multiple renderers (enterprise IM cards / various open UI protocols / Web Markdown). This is exactly the natural delivery shape of M6's "one B2B scenario
(travel-agency embedding) running through with zero kernel changes": different customers load different skill combinations.

gotry today: tools grouped by retrieval/verdict/memory/artifacts have taken shape on the architecture surface and in the README, but there is no skill-level packaging.
**No premature abstraction in the current single-tenant C end** (YAGNI); at M6 Entry, reorganize the tool registration surface along skill boundaries,
with renderer adaptations coming along (customer rendering surfaces beyond dsh's native UI).

### 8. Engineering maturity → continuously adopted, no new action

The T system's render parity tests (byte-identical), routing evals, and canary releases map onto gotry's existing surfaces:

- the parity-test idea = gotry's anti-drift test family (§38 extension-bridge constant locks, the 12306 station-table snapshot anti-drift
  check (2026-09-03, `data/stations-12306-verify.json`), the dual-source fixture scorer §25);
- routing evals = the evaluation lane's Round series (#96 transport-failure taxonomy / #100 minimal kernel /
  #102 typed tool contracts, in progress);
- canary releases = the npm dist-tag mechanism + release confirmation discipline (the rc → latest migration is canary semantics).

Self-acknowledged gap: gotry has no passing record on benchmarks outside the travel domain (D-28; external benchmark rounds remain
diagnostic-only) — a genuine lag in engineering maturity, to be advanced by the evaluation lane at its own pace,
with no priority change because of this study.

## Differentiation retention list (not led astray)

| gotry has, T system lacks | Why it is kept |
|---|---|
| Z3 formal solving (the model translates, the solver decides) | The fundamental path to reducing hallucination; the T system judges feasibility with LLM+rules, with no SMT solver |
| Evidence chain labels (`[实时API]`/`[会话]`/`[静态包]` — realtime-API/session/static-pack) | An honest labeling system attached at the render layer; the T system has no counterpart |
| Door-to-door full cost (early-start penalty / arrival energy) | A philosophical difference in recommendation ranking, beyond price/time |
| The wish pool "next trip" closed loop | A product design where infeasible requests are stored with conditions and recalled automatically next time |
| Open transparent ADR culture + honest labeling of unfinished items | The foundation of collaboration trust |

## Counterintuitive finding (the reason written into the decisions)

The T system's core orchestration is a single file of about 3.7k lines; its sensitive-parameter handling is a single file of nearly 800 lines —
even a production-grade system needs an enormous amount of engineering code polished around the Agent core loop and security boundaries.
**gotry should not chase code-volume parity; it should chase equal safety with a smaller code surface via formal methods**: Z3 converges
"LLM guesses + rules patch" into constraint solving, and booking_saga_fsm converges the orchestration state machine into a vocabulary-layer
edge table. But the safety code volume of the M5 write path will genuinely grow (parameter closed sets / confirmation surfaces / audit chains);
the size budget must anticipate this — formal methods shrink the code of **verdict logic**, not the code of **security boundaries**.

## Impact on the v0.0.1 official release

**No blockers**. All eight-dimension borrowings land as M5/M6 design inputs or "isomorphic surface already exists / not adopted"; the real gaps
before v0.0.1 are the bug cluster exposed by the 2026-09-02 real session (#106/#107/#108, fixes all landed, remnants are
founder decision items) and the evaluation lane's #102. This study requires no code changes within the v0.0.1 scope.
