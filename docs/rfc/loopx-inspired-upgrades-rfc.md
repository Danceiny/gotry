[English](loopx-inspired-upgrades-rfc.md) | [简体中文](loopx-inspired-upgrades-rfc.zh-CN.md)

# RFC: Mapping Upgrades from the LoopX RFC Set onto GoTry — Minimal Slices Across Four Seams

> Status: **accepted** (2026-08-27 founder directive: "These don't need my sign-off, right? The loopx-inspired items can be executed directly as recommended" — the four slices execute in the §7 order, and each slice syncs the state surfaces per §11 when it lands)
> Amendment (same-day founder directive): GoTry will in the future deliver **multi-user Agent as a Service** — shared-goal-authority-state-provider (claim/CAS/online authority) is not out of scope but the **future core topic of the multi-user phase**, moved from the not-adopted list into the §6.5 long-term adoption surface
> Author: gotry-builder-01 (loopx governance plane)
> Date: 2026-08-27
> Upstream authority: `../architecture.md` (technical authority), `../roadmap.md` (M0-M6 timeline), `../gotry-product-design.md` (product surface)
> Downstream impact: each slice syncs the state surfaces per §11 when it lands, and is registered as an ADR as needed

## 0. What This Is and Is Not

This document is a **technical proposal (RFC)**: having read all 13 papers in loopx `docs/architecture/rfcs/` (1 Accepted, 4 Active Research/Product Direction, 8 Draft/Integration), it distills the module designs and technical ideas that have a **real seam** with GoTry's existing architecture, and gives minimal verifiable slices and an execution order.

**What it is not**: not porting loopx's control plane into GoTry (inside gotry, loopx only carries L5 governance; this document borrows **design patterns** only and introduces no loopx runtime dependency); not doing M5/M6 work early (all slices stay within the current M3/M4 boundary); not a one-shot big rewrite (each slice is independent and can be killed alone).

**How to read it**: §1 is the fit-point summary table (which RFC ideas align with which gotry line); §2-§5 are the four concrete slices (each: source RFC → gotry current state → design → minimal slice → acceptance); §6 is what is explicitly not adopted; §7 is the recommended execution plan.

## 1. Fit-Point Summary Table: loopx RFC Ideas ↔ GoTry Seams

Six shared philosophies run across the loopx RFC set (details in the research notes, omitted here): observations never escalate into authority; typed packet + receipt, prose is not evidence; protocol ritual is not progress; read-only projection before execution; bounded context first; structural de-sensitization of the public surface.

Mapping these six onto GoTry's lines yields four real fit points:

| # | loopx RFC source | Core mechanism | GoTry current state (gap) | Value |
|---|---|---|---|---|
| **S1** | agent-loop-effect-interpreter (Accepted) | canonical packet with four slots (effect_request/interpretation/observation/next_effect) + handlers as data + five-property settlement | the 12 tools' parameter contracts grow freely, unwrapQuery is a stopgap defense; execute return values have no unified envelope; **already re-enacting a problem loopx has solved** | High (governance debt; drags on every new tool) |
| **S2** | post-outcome-memory-utility-attribution (Draft) | recall→application→verified_outcome→attribution sidecar; six-way semantic separation; evidence tiering; `rank_score=semantic*bounded_modifier` | wish-pool.json only takes in and never lets out; no trip-materialization verification, no concept of "suggestion quality"; the north star "next departure rate" has no measurement foundation | High (feeds the M4 north star directly) |
| **S3** | human-attention-wishlist (Draft) | three attention types gate/request/wish; wishes are non-blocking and never wake on their own; `piggyback_or_digest`; 0..1/turn to prevent protocol ritual | "proactive follow-up (closable)" is a single roadmap line with no mechanism design; the wish pool has an entry point but no legitimate outreach form | Medium (an M4 prerequisite; defines the legal boundary of follow-up) |
| **S4** | long-running-agent-reliability (L0–L4 levels) | observer-first product entry; L1 non-interference as a machine contract; authority only via explicit rollback-capable seams | WriteGate is M5's binary "go to production"; booking write authority has no progressive authorization path | Low (philosophy only, not mechanism — a decision framework for the M5 sign-off) |

**Not a fit**: research-exploration (governance-plane self-use, not a product seam), shared-goal-authority (multi-machine coordination; GoTry is single-user single-machine), typescript-migration (loopx's own Python→TS; GoTry already removed Python), benchmark C0-C4 (gotry already has ADR-11's three evaluation layers; overlapping), agent-im-openviking (IM collaboration; no corresponding scenario).

## 2. S1: Canonical Packet Discipline for Tool Calls (Effect Interpreter Mapping)

**Source**: loopx `agent-loop-effect-interpreter-v0` (Accepted). Core: model every tool interaction as `model → effect_request → harness interprets → observation → model`; handlers are data, not callables (they must be serializable across process boundaries); composition must prove five properties (identity/associativity/ordered short-circuit/replay/non-commutativity).

**gotry current state**: the 12 tools' execute signatures rely on convention; argument parsing already has three shapes (bare value / wrapped object / string primary key) — `unwrapQuery` is an after-the-fact patch; execute returns free-form JSON, and `as never` already appears in two places (motivation/hotel); guardToolExecute intercepts exceptions, but **success-path return shapes have no envelope at all**. Every new tool re-solves "what exactly do the arguments look like and what does the LLM see as the return value".

**Design** (take the discipline only, not loopx's schema names — avoiding a second abstraction layer):

```typescript
// ts/src/tool-packet.ts (new file, pure types, zero runtime)
interface GotryEffectRequest<TArgs>  { tool: string; args: TArgs }        // model→harness
interface GotryObservation<TValue>   { ok: boolean; value?: TValue;       // harness→model
                                       error?: { kind: string; message: string } }
// unwrapQuery is promoted to the "interpretation" layer: the three args shapes normalize here, in exactly one place
```

- **Minimal slice**: (1) all 12 tools' execute uniformly return `GotryObservation` (guardToolExecute's exception degradation is naturally the `ok:false` branch; this just makes the shape explicit); (2) unwrapQuery moves from index.ts to tool-packet.ts and is renamed `interpretArgs` (semantic relocation); (3) the two `as never` occurrences are eliminated (types become self-consistent once the observation envelope exists).
- **Acceptance**: mock calls of all 12 tools green (existing smoke/replay untouched); tsc at 0 errors; one new packet unit test (the replay+non-commutativity of the five properties asserted with existing fixtures).
- **Cost**: about 60 lines of diff, zero behavior change (pure shape normalization).
- **Decision point**: whether to accept the constraint that "tool return values have an envelope from now on" (a slight burden on new tools, determinism for callers).

## 3. S2: Memory Utility Attribution Sidecar — the Wish Pool's North-Star Foundation (Post-Outcome Memory Mapping)

**Source**: loopx `post-outcome-memory-utility-attribution-v0`. Core: recall ≠ use ≠ useful; the six semantics (recall/use/outcome/attribution/utility status/lifecycle) must be recorded independently; evidence tiers `owner_correction > controlled_replay > deterministic_effect > evaluator_inference`; attribution granularity `item/set/none`; ranking form `rank = semantic × bounded_modifier` (utility must not resurrect semantically irrelevant items).

**gotry current state**: `wish-pool.json` only takes in and never lets out (contract 6 "wishes enter the pool" + the `gotry_wish_pool_add` tool); **no mechanism whatsoever knows whether a wish later materialized or whether the suggestions were any good**; the M4 north star "next departure rate" currently has no measurement foundation — it can only be fished out of chat logs by hand. This is exactly what the loopx RFC calls "claiming use ≠ making the outcome better".

**Design** (a pure sidecar, off by default, fail-open, not in the main path):

```jsonl
// gotry-state/memory-utility.jsonl (append-only, same level as motivation-profile.json)
{"schema":"memory_utility_observation.v0","wish_id":"w20260827-dali","event":"recalled","ctx":"turn-uuid"}
{"schema":"memory_utility_observation.v0","wish_id":"w20260827-dali","event":"applied","detail":"user accepted 5-day window"}
{"schema":"memory_utility_observation.v0","wish_id":"w20260827-dali","event":"verified_outcome","detail":"booked 2026-10-01"}
// attribution (optional, unknown by default): evidence_tier tiers, owner_correction strongest
```

- **Minimal slice**: (1) add a stable `wish_id` to every entry in `wish-pool.json` (the primary key is missing today); (2) add `ts/src/memory-utility.ts`, a pure-function layer: append the three event kinds + a read-only projection (per wish `utility_status: unknown|helpful|harmful|neutral`); (3) the motivation interview tool appends a `recalled` event when it recalls a wish (this is the only write point; everything else waits for explicit founder/user confirmation in later conversation before appending `verified_outcome` — **the model never gets to call itself "useful"**).
- **Acceptance**: three sidecar assertions (append is idempotent / the projection is read-only / utility stays unknown without a verified_outcome); existing wish-pool tests unbroken.
- **Cost**: about 120 lines in a new file + two one-line hooks.
- **Decision point**: whether to accept "wishes get a primary key + a utility event stream from now on" (red line 6, user data visible and deletable — the sidecar sits at the same level as the profile; deleting clears the whole file, which is compliant).

## 4. S3: The Legitimate Form of "Next Departure" Follow-Up (Human Attention Wishlist Mapping)

**Source**: loopx `human-attention-wishlist-v0`. Core: human attention splits into three types — `gate` (the only one that can block), `request` (non-blocking notification by default), `wish` (presented only in passing, **must never on its own flip DONT_NOTIFY into NOTIFY**); wishes have a stable `wish_key` for dedup, at most 1 per material turn, and an active cap; presentation strategy `piggyback_or_digest`; a wish raises priority, not authority.

**gotry current state**: roadmap M4 says "proactive follow-up (closable)" but has no mechanism design; product-surface red line 96 says "never market to users who did not ask; proactive outreach has exactly one legitimate form: the 'next departure' suggestion (and it is closable)". **What is missing: what form the follow-up takes, when it is legitimate, and how it avoids becoming a nuisance**. loopx's three types happen to be the answer to this question.

**Design** (take the "attention typology" only, not loopx's todo integration):

```
Wish pool outreach discipline:
- At most 1 "next departure" suggestion surfaced per conversation (the 0..1 rule, preventing protocol ritual)
- Presented only in passing when "conditions match" (window/budget/season hitting trip conditions); never starts a conversation on its own
- User opts out (contract 6 is closable) = that wish is marked `muted:true`, never deleted (a wish is not rejected, but it can sleep)
- Any "suggest you travel" push, if one ever exists, must be digest-form and globally disableable — there is no push channel today; this is discipline reserved for M4+
```

- **Minimal slice**: (1) add `wish_id` + `muted` to the wish-pool.json schema (sharing the primary key with S2); (2) add one sentence to the `gotry_wish_pool_add` tool description and persona contract 6: "at most one suggestion per turn, only when conditions hit"; (3) if the render layer already shows wishes, add 0..1 truncation.
- **Acceptance**: a contract-level assertion (at most 1 wish suggestion rendered per conversation); muted wishes never appear in rendering.
- **Cost**: about 30 lines + one contract sentence.
- **Decision point**: whether to make the two rules "0..1 per turn" and "never initiate alone" hard discipline (the technical fulfillment of product-surface red line 96).

## 5. S4: WriteGate's L0–L4 Progressive Authorization Philosophy (Reliability Mapping, Philosophy Only)

**Source**: loopx `long-running-agent-reliability-diagnostics-governed-delivery-v0`. Core: L0 native → L1 Shadow Observer (non-interference is a machine contract) → L2 Advisory (typed recommendation, no execution authority) → L3 Governed Seams (explicit authorization on named checkpoints) → L4 Semantic Control Plane; authority can only be obtained through explicit, rollback-capable, pre-registered seams.

**gotry current state**: WriteGate is M5's binary "go to production" switch. "Reads execute freely; writes (booking/payment) require explicit confirmation" — but what "explicit confirmation" looks like, how wide the post-confirmation scope is, and how to roll back are all blank today.

**Design** (this RFC lands no code; it only sets a decision framework): when M5 signs off WriteGate, define "booking write authority" by L0-L4 level — L2 = suggestions + prices only, L3 = named seams (e.g. "single booking confirmation" as a first-class typed seam carrying a receipt), L4 = auto-renewal types. Each level's rollout must be rollback-capable to the previous level.

- **Minimal slice**: no code. Only in architecture.md's M5 outlook section (if §9 has one) or in the roadmap M5 deliverables description, refine "WriteGate productionization" into one sentence: "L0-L4 progressive authorization, every level rollback-capable".
- **Acceptance**: one sentence landed in the docs, no code.
- **Cost**: zero.
- **Decision point**: whether to adopt L0-L4 as the default leveling vocabulary for the M5 WriteGate.

## 6. Explicitly Not Adopted (and Why)

| loopx RFC | Reason not to adopt |
|---|---|
| research-exploration-control-plane | governance-plane self-use (manages loopx todo/replan), not a GoTry product seam; GoTry's "research" is travel planning itself, with no composition gap problem |
| typescript-control-plane-migration | loopx's own gradual Python→TS migration; GoTry already removed Python (D-7 cleared), so there is no such debt |
| long-horizon-benchmark C0-C4 | GoTry already has ADR-11's three evaluation layers (gold standard / differential / real model); the claim ladders overlap |
| agent-im-openviking / goal-channel | an IM collaboration scenario; GoTry has no external task board / group chat channel (revisit in the multi-user AaaS phase) |

### 6.5 Long-Term Adoption Surface (multi-user Agent-as-a-Service, chartered by the 2026-08-27 founder directive)

GoTry's future is a multi-user Agent as a Service — at that point, the three-layer separation of **shared-goal-authority-state-provider** (storage-surface provider / semantic authority / continuously coordinating supervisor) and the claim/CAS/receipt protocol flip from "not adopted" to the **future core topic**:

- Multi-user = many goals in flight = concurrent writes to the same itinerary / the same user's resources; the single-machine single-user era's "file as authority" (direct reads and writes of wish-pool.json / motivation-profile.json) must upgrade to claim-fence-receipt;
- The existing foundation is compatible with it: S2's memory-utility sidecar is an append-only event stream, and CAS ledgerization is a storage-surface replacement, not a semantic rework;
- Trigger timing: complete the design review before multi-user seeding (shared deployment, a second real user); S2/S3's wish_id/event streams land in the single-user phase already shaped for "future ledgerization" (stable primary keys + append-only), avoiding multi-user-phase rework.

## 7. Execution Plan

**Order** (sorted by "reversibility × value × dependency"; each slice is independent and can be killed alone):

1. **S1 tool-packet** (60 lines, zero behavior change) — landed the same tick it was accepted, 2026-08-27.
2. **S2 memory-utility sidecar** — depends on S1's observation discipline; feeds the M4 north star directly.
3. **S3 wish outreach discipline** — shares the wish_id primary key with S2; the technical fulfillment of product red line 96, in the same batch as S2.
4. **S4 WriteGate L0-L4 vocabulary** — can land at any time before the M5 sign-off (one doc sentence).

**Execution discipline** (the original gate was lifted by the founder's "execute as recommended" directive): each slice syncs the state surfaces per §11 when it lands (architecture §9/§10 + the roadmap's current position); S1/S2 each register an ADR on landing; the multi-user AaaS direction is recorded only in §6.5, not implemented early.

**Red lines**: this RFC introduces no new dependencies, does not touch hotel-be, and does not change solver semantics (nothing outside the §10 debt list gets done); all sidecar files land in `gotry-state/` (red line 6: user data visible, editable, deletable).
