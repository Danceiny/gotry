[English](booking-saga-fsm.md) | [简体中文](booking-saga-fsm.zh-CN.md)

# Booking Saga State Machine (booking_saga_fsm.v1) — design formalization of the issue #17 adoption surface

> Status: **accepted** (2026-08-29 founder directive "move on it now"; executes the three points of the issue #17 evaluation that "are truly worth taking")
> Upstream authority: `../architecture.md` (technical authority surface/ADR-15/ADR-16/ADR-17), `../rfc/transactional-state-rfc.md` (§4.3 WriteGate foundation), `../gotry-master-outline.md` §2 (reuse matrix), `../roadmap.md` (M5 Entry gate)
> Execution anchors: `ts/src/booking-saga.ts` (pure-function vocabulary layer) + `ts/scripts/booking-saga-tests.ts` (run-all §36, 25 assertions)
> Discipline: one file carries one concern; version history belongs to git; **this delivery names the design foundation of M5 — it is not an implementation of the transaction loop and does not constitute M3/M5 Exit evidence** (D-20 discipline)

## 0. The one-sentence claim

M5's booking/payment/refund-change flows **do not need an orchestration framework** (LangGraph/Temporal-class): the booking-flow state machine **already physically exists** inside the TS-4 transactional foundation — the `pending_writes` three-state CHECK + idempotency keys + the three saga methods are it. All three mechanisms proposed in issue #17 already have a home; what was missing was only "naming": this design converges states, edges, events, and rejection reasons into an explicit vocabulary layer (`booking-saga.ts`), and stipulates that once M5 is unsealed, any booking seam may only traverse this edge table.

## 1. State alphabet and edge table (code is the authority: `ts/src/booking-saga.ts`)

- **State alphabet** (verbatim identical to the `state-ledger.ts` pending_writes.status CHECK): `pending | confirmed | compensated`; plus `none` (∅, subject not registered) as the start.
- **Triggers**: `propose` (L2, register only, no execution) / `confirm` (L3 named-seam confirmation, carries a receipt) / `compensate` (saga compensation).
- **Edge table** (total function, 12 cells = 4 edges + 8 rejections; no holes, no third state):

```
∅ --propose--> pending --confirm--> confirmed
                  │                    │
                  └---- compensate ----┴--> compensated   (absorbing state, no outgoing edges)
```

| from | trigger | to | Ledger event | Guard |
|---|---|---|---|---|
| none | propose | pending | `write.pending` | L2 registers only, executes nothing; idem_key UNIQUE, a duplicate proposal = no-op |
| pending | confirm | confirmed | `write.confirmed` | L3 named-seam confirmation, must carry a receipt; a confirmed write cannot be confirmed again |
| pending | compensate | compensated | `write.compensated` | The external write never happened, so cancellation is terminal (zero compensation actions) |
| confirmed | compensate | compensated | `write.compensated` | Saga compensation (refund/change) of side effects that did happen; receipt retained (COALESCE) |

Rejection-reason closed set: `missing-subject / idem-exists / already-confirmed / absorbed-compensated / already-compensated` — structured rejections, **a rejection moves nothing** (synonymous with the ledger's `changes=0`). compensated is an absorbing state; the receipt is immutable after confirmed; idempotency keys guarantee "the same booking cannot be confirmed twice".

- **Audit chain** (`sagaTraceViolations`): the `write.*` event sequence for a single idem_key must walk exactly one legal path of the edge table; a `write.confirmed` with an empty receipt is a violation. The vocabulary layer validates the real event stream of the physical ledger — **the vocabulary layer and the ledger do not fork; a fork means regression red** (§36 physical reconciliation, 25 assertions).
- **Known boundary (honest surface)**: the ledger's physical layer does not yet block empty receipts (the vocabulary-layer audit already covers it); the physical CHECK lands in the schema when M5 is decided.

## 2. Edge-type vocabulary (grounding issue #17's "edges" as GoTry vocabulary)

Of the "edges" in multi-agent flow diagrams, GoTry has only three kinds, all with existing carriers:

| Edge type | Semantics | Existing carrier | Example |
|---|---|---|---|
| **deterministic-edge** | Code-level decision, no LLM involved | Z3 named constraints + unsat core (`unified.ts`); gate guards; the validateSpec gate | Compliance checks (travel policy/working window/red-eye) = deterministic exclusion before solving; violations enter exclusions with a reason — **candidates carrying violations are never given downstream**, stronger than "a compliance agent returns a boolean and we route on it" |
| **gate-edge** | User decision point, the only interactive form | L1 gates' in-message multiple choice (D1 contract; `loop.ts`) | A trade-off choice like "pay ¥300 more for an upgrade?" |
| **external-event-edge** | An external-world event resumes the flow (approval/refund/timeout) | Durable work orders (`workflow_steps` suspend/resume) + the pending_writes saga + ApprovalSeam (`session-consent.ts`, already in production) | A supervisor's approval result = one ledger event, pending → confirmed/compensated |

**Corollary (HITL needs no new framework)**: "waiting 24h for approval" is not a pause/resume mechanism but a **persistent suspension in the pending state** — the ledger is the suspended state, the process may die and restart (ADR-15 crash safety), and when the external event arrives the flow resumes along the edge; the approval channel reuses the dsh ApprovalSeam (the session gate is already the production form, headless fail-closed).

## 3. Where the issue #17 mechanisms land (mapping table)

| issue #17 proposal | Home | Status |
|---|---|---|
| Shared State + atomic updates | Ledger single transaction (events and projections born together) | ✅ ADR-15 |
| Checkpointers | events append-only + projection fold rebuild | ✅ |
| Long transactions across restarts, no duplicate side effects | workflow_steps exactly-once + `gotry_async_terminal.v1` + idem_key UNIQUE | ✅ (D-21) |
| HITL pause-resume | Durable work-order suspend/resume + ApprovalSeam approval cards | ✅ in production (session gate); enterprise approval is an M5 seam wiring |
| Compliance-agent conditional edges | **deterministic-edge**: Z3 named constraints/unsat core; compliance is never built as an LLM agent node | ✅ already architectural discipline (invariant table L2 "LLM does no arithmetic verdicts") |
| Explicit state machine (StateGraph form) | `booking_saga_fsm.v1`: alphabet + edge table + parser + audit-chain validation, pure functions | ✅ landed here |
| Adopting the LangGraph framework | Rejected (ADR-4's rejected alternative = a self-built state-machine control plane; outside the reuse matrix; RFC (transactional-state) §2.1 already scanned) | Not adopted |

## 4. M5 unsealing increments (trigger = M5 Entry: M4 exit + supply-chain protocol; zero implementation before trigger)

1. Booking seam landing: named-seam registration vocabulary `<domain>-<action>-confirm` (e.g. `flight-order-confirm`; the vocabulary is frozen at the M5 decision);
2. Empty-receipt physical gate: pending_writes gains "receipt non-empty (CHECK)", with the schema version bump;
3. L2/L4 wiring: the authorization vocabulary for the suggested state (register-only) and the auto class (L4) is tiered per the RFC (loopx) S4, each tier rollback-able;
4. Approval-waiting state: if enterprise approval (external event) needs cross-session visibility, extend the `waiting-approval` no-spend vocabulary (same family as the session-double-source waiting-*, no spend).

**Any one of these landing changes the system's shape and requires the six-surface state sync + full-stack regression; they are M5 deliverables, not this document's fulfillment**.

## 5. Explicitly not doing (boundaries)

- No LangGraph/Temporal/orchestration framework or any new runtime (ADR-4 / master-outline rigid constraint 1 / RFC §1.3);
- No touching the dsh harness session layer, no new Python surface;
- Compliance/policy checks are **never built as LLM agent nodes** (determinism belongs to code; violations must carry an unsat core or a rule reason);
- This state machine does not contain the business booking flow diagram (segment order/approver routing, etc.) — that is the seam design delivered with M5; the alphabet only governs saga state progression.

## 6. Decision record (why this shape rather than a LangGraph shape)

1. ADR-4's rejected alternative was precisely a "self-built state machine" control plane — this state machine is **the vocabulary layer of the ledger saga**, not a control plane, and does not touch L2 orchestration (loop.ts/dsh);
2. Reuse matrix: LangGraph is not in the matrix; introducing an external orchestration framework requires amending the master outline first;
3. The M5 Entry gate (M4 exit + supply-chain protocol) is not open; the transaction loop must not be implemented in reverse ahead of it (D-20);
4. The decisive mechanisms (suspend-resume/idempotency/compensation/audit) are already physically complete in a single SQLite ledger (RFC transactional-state §2/§4); the LangGraph checkpointer is the same school's server-side form.
