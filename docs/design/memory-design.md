[English](memory-design.md) | [简体中文](memory-design.zh-CN.md)

# GoTry Memory Domain Design (Consumer-Side Six-Layer Redesign)

> Status: **active design** (the formal design document for M4's "six-layer framework redesign" delivery; landed portions are marked ✅, phased increments in §4)
> Upstream: `gotry-master-outline.md` §3.5 (six-layer reference framework, T-system design reference; neither code nor schema is copied; T system = a production enterprise travel Agent system, source desensitized), `gotry-product-design.md` §7.6 (long-horizon state and memory)
> Discipline: the memory domain lives in a single file; version history belongs to git
> Date: 2026-08-28

## 1. Design Stance (Non-Negotiable)

1. **Backend engineering is the substance, the LLM is the application**: deterministic facts (dates/cities/orders/constraints) are never handed to LLM memory; the LLM only owns what genuinely requires semantic understanding (motivation, retrospective) — extraction already goes through contract (18) dynamic absorption (evidence = the user's own words), with gating in code (mergeProfile/appendEvent).
2. **Traceability is P0**: every preference assertion must trace back to the user's own words or a tool result — every profile weight carries evidence, and the utility event stream is append-only. Isomorphic to the D1 §6.3 evidence chain.
3. **The profile only feeds ranking, never hard filters**: the rank channel uses memory for weight tuning (future shape `semantic × bounded_modifier`, bounded by RFC S2); hard filters consume only the user's explicit constraints in the current turn — otherwise memory would filter the search down to nothing.
4. **Memory belongs to the user (red line 6)**: everything lands in the single `gotry-state/` directory — visible, editable, deletable, exportable; sensitive fields (ID documents/contact details) are never stored — when needed, the backend fills them from the logged-in session, with fail-closed clarification.
5. **Negative list**: never store IDs/tokens/URLs/raw conversation text; personalization uses only the profile and aggregated behavior (product design §7.6 privacy stance).
6. **Multi-user AaaS forward compatibility** (RFC §6.5): in the single-user phase all memory is an append-only event stream + stable primary keys; a future ledger form (CAS/receipt) is a storage-layer swap with zero changes to the semantic layer. (2026-08-28: the storage layer has been delivered — the ADR-15 ledger landed, events as the single authority + projection fold, gate pure functions reused as-is — the "zero changes to the semantic layer" promise held; multi-user claim/CAS implementation remains deferred behind its trigger as D-15)

## 2. Six Layers × Current-State Mapping

| Layer | Consumer semantics | Carrier | Status |
|---|---|---|---|
| **M1 User basics** | Home city/time zone/work window | tenant-scoped `homeCityPreference { value, evidence, updated_at }` + `{{motivation_brief}}` | ✅ Work window/time zone are in the profile; home city supports explicit write and read-back as a soft default: the current turn's explicit origin wins, an explicit null clears it, a missing/malformed/unbound typed preference asks for an explicit origin, and deterministic candidates are never hard-filtered. The #20 real-cohort gate stays open |
| **M2 Motivation and preference profile** | Motivation weight spectrum (multi-year), stamina tier, pace tier, budget tier | motivation-profile.weights/hard + `{{motivation_brief}}` read-back | ✅ Core landed (T1: extraction to the LLM / gating to code / read-back injection) + **P3 time-window decay landed (§4)**; **residual on evidencing city-scene tiering →** [#339](https://github.com/Danceiny/gotry/issues/339) |
| **M3 Budget standard** | Budget tier (motivation-interview calibration + historical behavior) | budgetTier gate → profile | ✅ Gate calibrated; **residual on refluxing the gap between actual deals and planning estimates →** [#340](https://github.com/Danceiny/gotry/issues/340) (**the write gate is governed by [#136](https://github.com/Danceiny/gotry/issues/136)/[#231](https://github.com/Danceiny/gotry/issues/231)/[#232](https://github.com/Danceiny/gotry/issues/232)/[#233](https://github.com/Danceiny/gotry/issues/233); not implemented before real transactions land**) |
| **M4 Travel timeline** | Where/when/with whom (foundation for three-level origin resolution) | `gotry-state/trips.jsonl` (§4 P1) | ✅ Landed 2026-08-28 (§4 P1) |
| **M5 Companion profiles** | Companions + constraints (hypertension/motion sickness/stamina), sensitive-fill form | `gotry-state/companions.json` (§4 P2) | ✅ Landed 2026-08-28 (§4 P2) |
| **M6 Session dual-zone memory** | Trip Notebook (durable) + Hot Context (tiered expiry) | the dsh session's own transcript | ❌ **P4 (not P3)**, depends on real usage-pattern data; the gate is tracked by [#255](https://github.com/Danceiny/gotry/issues/255) and stays closed until real usage patterns or multi-user trigger it |

**GoTry increments beyond the reference framework** (absent from both the T system and ai-agent-book; original to this domain):

- **Utility attribution sidecar** (`memory-utility.ts`, ADR-14): three event kinds — recalled/applied/verified_outcome; attribution accepts only owner confirmation — "recalled ≠ useful". This is a **yardstick** above the six layers, measuring whether each layer's memory is worth storing.
- **Outreach discipline** (`wish-pool.ts` 0..1): the memory output surface is bound by the "never proactively sell" red line (product red line 96).

## 3. Closed Behavior Chains (2026-08-27/28)

```
Write: contract (18) dynamic absorption → motivation_save (mergeProfile gate: append without deleting history / idempotent / weight changes carry evidence)
Read: {{motivation_brief}} persona injection (empty = first visit) — a revisit is never asked an already-answered field again
Utility: wish_id + memory-utility.jsonl (attribution accepts only owner confirmation; the model may not rate itself "useful")
Outreach: gotry_wish_pool_list 0..1 (new intents check the pool first); nudge-digest three channels (dismissible)
Metrics: memory-metrics read-only projection (reflux-rate baseline verified/recalled)
```

Verified on the real model: e2e §13 (four-hop read-back verbatim identical) / §14 (0..1 semantics enforced).

## 4. Phased Increments (each independently acceptable, no new dependencies)

### P1 Travel Timeline (M4 layer) — **✅ landed 2026-08-28**

`gotry-state/trips.jsonl` append-only: `{ trip_id, destination, start, end, companions?, source, evidence }`.
- **Write sources**: (1) user speech ("my last Dali trip was over National Day" → contract (18)-style dynamic absorption, evidence = the quoted words); (2) trip confirmation (when a wish's verified_outcome lands, a timeline event is attached automatically). Both sources pass the gate pure function (date parsing reuses slot-spec; on conflict, stop — never guess).
- **Consumption**: three-level origin resolution (future trip → timeline → ask the user); "visited, stop recommending" feeds the ranking channel; the reflux-rate numerator becomes accurate (verified_outcome ⟺ the timeline holds the matching trip).
- **Acceptance (met)**: assertions 100% traceable; cross-consistency gating (verified with no timeline = inspection gap exposed, no automatic backfill). Landed = `travel-timeline.ts` pure function + the `gotry_trip_log` tool + optional automatic timeline attachment on confirm-outcome (lands only when tripStart is passed, otherwise the gap remains) + `{{motivation_brief}}` injection of "visited" lines (last 3). run-all §20, 7/7 assertions.

### P2 Companion Profiles (M5-6 layers) — **✅ landed 2026-08-28**

`gotry-state/companions.json`: `{ companion_id, label, constraints: { mobility, health, prefs }, evidence }`.
- Writes follow the motivation-interview pattern (contract (18)); **health/accessibility constraints only feed ranking and itinerary-structure suggestions, never hard filters**; when rendering, "you said last time you get motion sickness"-style references must carry an evidence pointer (the behavior face of product design story three).
- Acceptance (met): negative-list guard cases (ID numbers/phone numbers rejected, 4/4 assertions, run-all §21); references traceable (evidence array). Landed = `companions.ts` pure function + `gotry_companion_save` (tool 15) + the `{{motivation_brief}}` companion line.

### P3 Time-Window Decay (M2 layer) — **✅ landed 2026-08-28**

Behavioral preferences decay over tiered windows of 30/90/180/365d (a deterministic reducer; confidence only decreases, never deleted — the same boundary as loopx memory-utility); **motivation weights never decay** (product design: destinations change, motivations stay stable across years).
- Acceptance (met): floor 0.1 — old but never extinguished / monotone / ceiling 1; zero motivation decay is a constructive guarantee (the module exposes no profile API, 5/5 assertions, run-all §23). Landed = the `memory-decay.ts` primitive + a "fresh confidence" column per wish in memory-metrics; the future behavioral-preference layer reuses it directly.

### P4 Session Dual-Zone Memory (M6 layer, deferred)

Trip Notebook (durable, background LLM extraction, negative list enforced) + Hot Context (tiered expiry: 30min resources / 24h intents, CAS against concurrency). **Depends on real usage-pattern data**; does not start before multi-user.

## 5. Hooks into Milestones/Acceptance

- **M4 exit**: "revisit planning duration down ≥50% vs the first visit" ← the read-back chain (mechanism proven in e2e §13) + the Issue #20/#223 paired-cohort scorer + the #228 lifecycle collector (contract, collection path, and synthetic/candidate export are wired; the real repeat cohort has not arrived); "experience reflux rate has a baseline" ← memory-metrics (process face) + the Issue #20/#228 experience reflux observation face. After P1 landed, the reflux-rate numerator upgraded from "owner verbal confirmation" to "timeline trips" — a qualitative change in the baseline.
- **M5 technical line T7**: preference assertions 100% traceable; the "profile never enters hard filters" guard case — this design's §1.2/1.3 is its acceptance definition.
- **Multi-user AaaS**: every layer lands as append-only + stable primary keys; ledgerization (RFC §6.5) only swaps the storage face.

## 6. Explicitly Not Doing

- Storing raw conversation text (privacy stance); storing sensitive ID/payment fields (the backend fills them); free-form LLM memory (extraction is always gated); implementing M5/P4 early for the sake of "memory completeness" (no spend without real callers).

## 7. Issue #20 Value Evidence Contract

`ts/scripts/memory-value-report.ts` scores `memory_value_fixture.v1` read-only:

- **paired cohort**: each pair accepts only the first and the next `eligible + completed` planning flow of a single anonymized subject; the returning flow must complete later than the first flow. Active planning duration = wall clock − pre-declared, mutually non-overlapping external waits. Quantiles are fixed to nearest-rank; the report gives N, first-visit/revisit p50/p75, and per-pair reduction p50/p75; threshold comparisons use the unrounded raw ratio, rounding only for report display.
- **Exit threshold freeze**: the M4 Exit minimum sample count is fixed at `minimum_pair_count_for_exit=5`, and the median reduction at `target_median_reduction_ratio=0.5`; inputs cannot lower the thresholds; non-frozen parameters are rejected fail-closed by the scorer.
- **experience reflux**: counted by experience_id as the intersection of recalled and verified_outcome; baseline = verified/recalled; every event must carry evidence_ref.
- **Preference red line**: the report gives the traceable ratio and the hard-filter violation count; acceptance requires 100% traceable and 0 hard filters.
- **P4 gate**: must stay `closed` without real usage or a multi-user trigger.
- **Evidence grades**: `synthetic_fixture` proves only the contract and the algorithms, `exit_evidence_eligible=false`; a private `observed_private` cohort likewise cannot close Exit by `evidence_kind` self-report, HMAC string shape, or evidence_ref shape alone. Observed input must be exact schema layer by layer, use `hmac-sha256:<64lowerhex>` pseudonymized keys for all subject/flow/pair/experience/assertion/evidence refs, and carry a `memory_value_source_review.v1` manual source review attestation contract; that contract must contain `reviewed_summary_digest_sha256`, matching the scorer's canonical JSON SHA-256 of the scoring payload outside `source_review`; a stale attestation cannot cover a modified summary. With a missing or mismatched attestation, the report counts only as candidate — metrics compute but `exit_ready=false`. The observed_private exported by the #228 collector still yields only candidate source_review and never generates reviewer/attestation fields. Real evidence stays in the manifest/paired-cohort/summary under `ts/gotry-state/evidence/m4/`; raw user material must not be committed; the scorer only validates the attestation contract shape and the summary digest binding — verifying raw material remains a manual review responsibility.
- **Compatibility migration**: from 2026-09-08, an old observed manifest that is missing `source_review.reviewed_summary_digest_sha256`, uses plaintext/non-HMAC ids, carries undeclared fields, or attempts to lower thresholds is rejected by the CLI as contract-invalid/exit 2; private evidence producers must re-pseudonymize, compute the current summary digest, and complete the source-review attestation before rerunning. The public synthetic fixture moves from N=3 to N=5 metric positives, but business eligibility remains false throughout.

Fixture rerun:

```bash
cd ts
npx tsx scripts/memory-value-report.ts data/memory-value-fixture.json
npx tsx scripts/memory-lifecycle-tests.ts
```

For collector usage and persistence invariants, see `memory-lifecycle-collector.md`.
