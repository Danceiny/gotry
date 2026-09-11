[English](enterprise-travel-reference-study.md) | [简体中文](enterprise-travel-reference-study.zh-CN.md)

# Enterprise-Grade Travel Agent System Reference Study → gotry Borrowing Decisions (2026-09-03)

> Subject: an enterprise-grade travel Agent production system (hereafter the "T system"; ReAct orchestration + deterministic DAG dual-track,
> production-grade state plane, compliance consolidation layer, event-driven rendering; material = the eight-dimension comparative analysis and deep read provided by the founder,
> source de-identified). This document answers only: **which mechanisms are worth borrowing for gotry, into what form, by which milestone, and which are
> explicitly not borrowed**. All conclusions map onto existing ADR/RFC/debt/milestone seams; no castles in the air.
>
> Prior judgment: the T system is strong in **engineering and production infrastructure**; gotry is strong in **formal methods and product philosophy**
> (Z3 solving / evidence chain / door-to-door full cost / wish pool). The two are not substitutes; all borrowing in this document is constrained by
> "don't dilute differentiation".

## Decision Summary Table

| # | T system mechanism | gotry decision | Landing point/seam |
|---|---|---|---|
| 1 | Dual-track execution: ReAct orchestration + deterministic DAG state machine owns real submission | **Adopt as M5 design input** (no code now) | ADR-17 `booking_saga_fsm.v1` + RFC S4 WriteGate L0-L4; M5 Entry checklist gains three items (see below) |
| 2 | Production-grade state: change-stream push + session-lease distributed lock + pending CAS + crash-recoverable persistent turn coordinator | **Defer** (trigger discipline established, don't build ahead) | When D-15 triggers, implement referencing its checklist |
| 3 | Write-operation closed loop: sealed interface compile-time isolation + op uniquely derived from Kind + pending persistence + second confirmation | **Adopt as M5 design input** (same batch as #1) | The ADR-17 edge table already has gate/external-event edge types and the HITL suspend-resume form; isomorphic |
| 4 | Compliance consolidation layer: a Model decorator consolidates ALLOW/MASKING/DEGRADE/REJECT, zero business changes | **Adopt as M6 design input** | M6 B2B compliance layer paradigm; the current C-side physical isolation red line stays |
| 5 | Event-driven rendering: emit structured events during execution, incremental block-by-block push | **Partially exists already, no new mechanism** | Booking Copilot v2 typed SSE is already the isomorphic face (§49); dsh product surface incremental rendering is constrained by upstream rendering capability, see below |
| 6 | Dual-model tiering + slot small model + context compaction | **Not adopted (status quo)** | ADR-24 Tier 0 deterministic routing (zero LLM) + slot-spec deterministic extraction already cover the same problem; model selection belongs to the dsh host |
| 7 | Domain skill system (tool set + prompt + boundary guards + renderers) | **Direction adopted, lands M6** | Corresponds to the M6 "one B2B scenario, zero kernel changes" delivery form; the current single tenant doesn't abstract ahead (YAGNI) |
| 8 | Engineering maturity (rendering parity test / routing eval / canary release) | **Continuously adopted, no new action** | run-all's existing anti-drift test family + evaluation lane (#96/#100/#102) are the corresponding faces |

## Per-Dimension Decisions and Rationale

### 1+3. Dual-Track Execution and Write-Operation Closed Loop → M5 Design Input (Three Mechanisms Enter the M5 Entry Checklist)

The T system's core insight: not every part of travel suits LLM ReAct — query/explain/recommend suit LLMs;
"select → confirm → submit → pay" is a strong-process, strong-confirmation, strong-compliance state machine that must use a deterministic DAG.

gotry's corresponding seam **is already frozen at the vocabulary layer**: ADR-17 `booking_saga_fsm.v1`'s edge table is the DAG
(four-edge total-function table + closed rejection set + deterministic/gate/external-event three edge types + HITL approval
suspend-resume), and the RFC S4 WriteGate L0-L4 progressive authorization vocabulary is already in the roadmap M5 deliverables. The T system's
practice **validates this direction** and adds three implementation mechanisms that must be reconciled item by item at M5 Entry:

1. **Write boundary separation**: the LLM (at the ReAct position) only orchestrates and produces "pending-confirmation actions"; real submission
   after confirmation can only go through the deterministic state machine (the DAG position). Mapping: gotry L2 suggestions may be produced by the LLM;
   L3/L4 submissions must go through the saga edge table; the LLM must not directly construct write calls.
2. **Pending state persistence**: before user confirmation, state lands in shared storage; the next turn resumes from pending, not relying on the
   LLM to re-understand context. Mapping: gotry already has the `pending_writes` saga + the ADR-15 ledger (the empty receipt physical CHECK
   recorded in D-22 is an M5 Entry redemption item), naturally compatible; turn-handoff work orders
   (ADR-24) are another existing face of "cross-turn recovery".
3. **Sealed interface + op uniquely derived from Kind**: the Executor accepts no raw IDs; write paths are isolated at compile time;
   sensitive-parameter handling is its own module (this module in the T system is nearly 800 lines — the polishing cost of a security boundary is unavoidable,
   and the budget must anticipate it). Mapping: booking-saga's closed rejection set is the vocabulary-layer embryo of the same idea,
   upgraded to a closed type set at M5 implementation.

Constraint unchanged: M5 Entry = M4 exit + supply chain agreement (roadmap); no write path is touched before that is met
(AGENTS.md red line: no direct write may be implemented before confirmation).

### 2. Production-Grade State Persistence → Deferred, D-15 Trigger Discipline Unchanged

The T system's change-stream push, session-lease distributed lock, pending CAS, and crash-recoverable persistent turn coordinator
are necessities of the multi-instance/FaaS form. gotry is a local single instance; the ADR-15 SQLite ledger + ADR-16 dual-form
freeze already cover the current form; D-15 has explicit triggers (second real user / multi-machine deployment / AaaS project initiation) before
Litestream/cr-sqlite/claim-fence implementation starts.

**Registration**: when D-15 triggers, the T system's lease/CAS/pending-recovery trio is the reference implementation checklist.
Don't build ahead (§9 principle: don't optimize the next stage's work early).

### 4. Compliance Consolidation Layer → M6 Design Input (Decorator Pattern Zero-Intrusion Consolidation)

The T system's compliance consolidation is a decorator over the Model interface: uniformly wrapping every model instance once at the service layer,
four actions ALLOW/MASKING/DEGRADE/REJECT, streaming masking-restore + multi-turn masking preservation, zero changes at business call sites.

gotry status quo: C-side single user; the privacy red line is physical isolation (no collection of passwords/verification codes/cookie values; the session channel
takes only cookie names). Moving toward M6 B2B (travel agency embedding), enterprise itinerary/expense/identity data must pass a compliance layer.
**The decorator pattern is the paradigm choice for zero-intrusion integration**: gotry's model calls concentrate in the dsh host layer; at M6,
adding a similar wrapper at the dsh-llm bridge face suffices — no per-tool changes needed. Registered as an M6 deliverable candidate; not implemented now
(the C-side has no sensitive-data egress surface).

### 5. Event-Driven Incremental Rendering → Isomorphic Face Already Exists, No New Mechanism

The T system emits events block by block during DAG execution (headline/table/card/notice), pushing incrementally to the frontend —
users don't wait for the full run; and it has rendering parity tests guaranteeing that event rendering is byte-identical to templates.

gotry counterpart: **Booking Copilot v2's typed SSE event stream is already an isomorphic implementation** (action.receipt /
approval.granted/consumed / decision batch, precise replay, run-all §49). The dsh product surface's
one-shot rendering is a host rendering capability constraint, not a face gotry can change unilaterally; the perceived wait of long computation already has a product answer in ADR-24
handoff (file a work order + announce ETA + follow-up method). Conclusion: **no new mechanism**; if dsh
upstream opens incremental rendering capability, then map "solving progress events" (constraints captured / candidates emerging one by one) into it —
registered as a dsh capability dependency, no gotry-side work item created.

### 6. Dual-Model Tiering / Slot Small Model / Context Compaction → Not Adopted (Status Quo)

The T system uses fast/slow dual-model tiering + a purpose-trained slot-extraction small model + layered context compaction.
gotry's same problems are covered by cheaper mechanisms:

- turn triage = ADR-24 `turn-policy.ts` **deterministic classifier (zero LLM)**, cheaper than a small model and reproducible;
- slot extraction = `slot-spec.ts` deterministic code (character-preservation discipline), no dependence on LLM structured extraction;
- context pressure = avoided via handoff work orders (persisted + ETA), not compression;
- model selection belongs to dsh host configuration; gotry holds no model routing surface (dual-model tiering has no entry point and no need).

Revisit if real cost/latency pressure data appears in the future; don't introduce something merely because the T system has it and gotry doesn't.

### 7. Domain Skill System → Direction Adopted, Lands M6

The T system's flight/hotel/train/requisition/order skills = tool set + prompt + boundary guards
+ multiple renderers (enterprise IM cards / multiple open UI protocols / Web Markdown). This is exactly the natural delivery form of M6 "one B2B scenario
(travel agency embedding) runs through with zero kernel changes": different customers load different skill combinations.

gotry status quo: tools grouped by retrieval/judgment/memory/artifacts are already shaped in the architecture face and the README, but there is no skill-level packaging.
**The current single-tenant C-side doesn't abstract ahead** (YAGNI); at M6 Entry, reorganize the tool registration surface by skill boundaries,
with renderer adaptation following (customer rendering surfaces beyond the dsh native UI).

### 8. Engineering Maturity → Continuously Adopted, No New Action

The T system's rendering parity test (byte-identical), routing eval, and canary release map to gotry's existing faces:

- parity test idea = gotry's anti-drift test family (§38 extended-bridge constant lock, 12306 station-table snapshot anti-drift
  (2026-09-03, `data/stations-12306-verify.json`), dual-source fixture scorer §25);
- routing eval = the evaluation lane's Round series (#96 transport failure taxonomy / #100 minimal kernel /
  #102 typed tool contracts, in progress);
- canary release = the npm dist-tag mechanism + release confirmation system (rc → latest migration is canary semantics).

Self-acknowledged gap: gotry has no benchmark pass record outside the travel domain (D-28; external benchmarks after multiple rounds are still
diagnostic-only) — a genuinely behind point in engineering maturity, advanced by the evaluation lane at its own pace;
this study does not change priorities.

## Differentiation Preservation List (Don't Get Led Astray)

| gotry has, T system lacks | Preservation rationale |
|---|---|
| Z3 formal solving (model translates, solver decides) | the fundamental path to reducing hallucination; the T system does feasibility judgment with LLM+rules, no SMT solver |
| Evidence chain labels (`[实时API]`/`[会话]`/`[静态包]`) | an honesty labeling system attached at the rendering layer; the T system has no counterpart |
| Door-to-door full cost (early-rise penalty / arrival energy) | a philosophical difference in recommendation ranking, beyond price/time |
| Wish pool "next departure" closed loop | a product design that stores conditions for infeasible requests and auto-recalls next time |
| Open-source transparent ADR culture + honest labeling of unfinished items | the foundation of collaboration trust |

## Counterintuitive Findings (Reasons Written Into Decisions)

The T system's core orchestration is a single file of ~3.7k lines; sensitive-parameter handling a single file of nearly 800 lines — even for production-grade systems,
the Agent core loop and security boundary need extremely large amounts of engineering code polish. **gotry should not pursue code-volume equivalence; it should pursue
equal safety via formal methods with a smaller code surface**: Z3 converges "LLM guesses + rules patch" into constraint solving;
booking_saga_fsm converges the orchestration state machine into a vocabulary-layer edge table. But M5 write-path safety code volume will genuinely grow
(closed parameter sets / confirmation surfaces / audit chain) — the scale budget must anticipate this: formalization reduces **decision-logic** code,
not **security-boundary** code.

## Impact on the v0.0.1 Formal Release

**No blockers**. All eight dimensions of borrowing land as M5/M6 design inputs or "isomorphic face already exists / not adopted"; the
real gaps before v0.0.1 are the bug cluster exposed by the 2026-09-02 real session (#106/#107/#108, fixes all landed, the remainder are
founder decision items) and the evaluation lane's #102. This study requires no code changes within v0.0.1 scope.
