[English](session-dual-zone-memory-design.md) | [简体中文](session-dual-zone-memory-design.zh-CN.md)

# GoTry Session Dual-Zone Memory Design (P4 / M6 Layer)

> Role: the implementation-level design for issue #255's P4 session dual-zone memory — working zone + durable notebook on the ADR-15 ledger; this charter delivers design + PR split only, no implementation code.
> Status: **proposal** (founder approved entering the implementation flow on 2026-10-02; implementation PRs start only after this design merges)
> Upstream: [memory-design.md](memory-design.md) §1/§2 M6/§4 P4, the [transactional-state RFC](../rfc/transactional-state-rfc.md) (ADR-15/16), [issue #255](https://github.com/Danceiny/gotry/issues/255) pre-start acceptance, `gotry-master-outline.md` §3.5 layer 5.
> Downstream: the PR series P4-1..P4-4 (§5), `memory-design.md` §4 P4 status sync, the #228-family observation face.
> Date: 2026-10-02

## 0. TL;DR

- Two zones over one ledger: a **session working zone** (born and dying with the session window, tiered fast expiry 30min/24h, never owner-confirmed) and a **durable notebook** (survives sessions, the only entry path is owner-confirmed promotion — the model may propose, never self-promote).
- Zero new tables: six new log-type event kinds on the existing `events` table plus a read-time deterministic fold in a new pure module — the `trip.logged`/`memory_utility.event` pattern, no edits to the kernel-pinned `state-ledger.ts`.
- No layer is redone: motivation/wish pool/timeline/companions keep their existing gates as the single write authorities; a promoted entry that matches their semantics routes through them; the notebook is not a parallel fact store.
- Value is falsifiable or it does not count: promotion confirm rate, re-ask avoidance within the intent TTL, and stale-hit rate — all offline-computable from ledger events plus #228-family opt-in exports; "remembers more" and fixtures prove nothing.
- Not doing: multi-user claim/CAS physicalization (stays behind D-15), any live data collection, raw conversation text / IDs / tokens / URLs in either zone, new schema, and touching the frozen #20 scorer `p4` gate.

## 1. Dual-Zone Definitions (the M6 Layer Contract)

### 1.1 Working zone (`hot_context`)

The working set of one live planning session. It exists so a returning session stops re-asking what the previous turn or the previous session (within the intent TTL) already established.

- **Membership rule**: a fact belongs to the working zone iff (a) it is derived from this session's user statements or tool results, (b) its usefulness decays with time, and (c) it has not received owner confirmation for durable storage. Facts that pass (a) but fail (b) are promotion candidates, not working-zone residents.
- **Data shape**: `HotNote = { schema, note_id, zone:'hot', tier:'resource'|'intent', kind (closed set), payload (bounded structured fragment — slot-spec-family types, no free text beyond a quoted-evidence cap), evidence_ref (a pointer into the dsh session transcript: session_ref + turn index — never content), ttl_expires_at (deterministic from tier and last write), rev, created_at, last_touched_at }`.
- **TTL tiers** (master outline §3.5 layer 5): `resource` 30min (search results, availability shapes, price-band pointers), `intent` 24h (destinations, dates, party size, budget stance still in play). The clock counts from the last **write**; reads never extend life.
- **Zone semantics**: `session_ref` is an opaque local session reference (same shape family as the session-link contract: no path characters, bounded length). Resource-tier notes are readable only inside their session; intent-tier notes stay readable across sessions until expiry — that 24h window is exactly the "came back the next day" case.

### 1.2 Durable zone (`trip_notebook`)

Structured assertions that survive sessions. Every entry is owner-confirmed at birth or by later revision.

- **Membership rule**: an entry exists in the notebook iff the owner confirmed it; the durable zone has no other write path. This is ADR-14's "attribution only on owner confirmation" discipline applied to storage itself.
- **Data shape**: `NotebookEntry = { schema, entry_id, zone:'durable', kind (closed set: trip_fact|preference|constraint|lesson), payload (structured assertion), evidence (the user's own words or a tool-result ref), origin ({session_ref, note_id?} promotion lineage), owner_confirm ({surface:'user_reply'|'approval_card', quote} — the gate rejects a missing or oversized quote), created_at, updated_at, rev }`.
- **Trust tier**: the confirmation is mediated by the model like every existing memory write (same tier as `motivation_save`); the gate enforces the evidence quote, the fold preserves the lineage, and the audit trail carries the surface.

### 1.3 Zone assignment and boundary events

| Input shape | Zone | Boundary event |
|---|---|---|
| Tool-observation fragment, freshness-bound | hot / resource | `hotctx.note.captured` |
| User-statement fragment still in play | hot / intent | `hotctx.note.captured` |
| Correction or contradiction of a live note | hot | `hotctx.note.dropped` (then re-capture if still true) |
| CAS update of a live note | hot | `hotctx.note.revised` (rev+1) |
| Owner confirms a promotion candidate | hot → durable | `notebook.entry.promoted` |
| Owner edits a durable entry | durable | `notebook.entry.revised` |
| Owner removes a durable entry | durable | `notebook.entry.dropped` (audit line survives; physical delete = forget) |

Expiry is **not** an event: it is a read-time view computed by a pure function of the event log and the (injected) clock. A wall-clock sweep would put time actions into an append-only ledger and break fold determinism. Promotion is legal only while the source note is un-expired under that same function.

## 2. Ledger Landing Point (ADR-15/16 Reuse, Zero New Tables)

- **Event kinds** (six, §1.3) land on the existing `events` table as log-type events — the `foldEvent` default branch already projects nothing for log kinds, exactly like `trip.logged` and `memory_utility.event`. `subject_id` = note/entry id; idem keys are `hotctx:<note_id>:<generation>:<rev>` / `notebook:<entry_id>:<generation>:<rev>`, so a replayed write at the same rev is a physical no-op (the same trick as `mu:` / `trip:` keys). The generation is the document's `created_at` (birth instant, carried unchanged through revisions): ids are semantically derived, so a re-capture after a drop reuses the same id at rev 1 — without a generation the UNIQUE index would physically swallow the "still true after the correction" re-capture that §1.3 mandates (found while physicalizing in P4-2).
- **Write path**: one transaction {fold-read current revs; gate checks; INSERT} run from the new module through the ledger's public surface (`db.transaction` + `readEvents` + `insertEvent`). Optimistic revision CAS: a write whose parent rev is not the current fold rev is rejected fail-closed as `stale_rev` before any insert. Single-writer per session holds by ADR-16's one-ledger-owner semantics; cross-process/cross-host fencing stays deferred behind D-15 ([#275](https://github.com/Danceiny/gotry/issues/275)), and the rev vocabulary is chosen now so that fencing later adds physics, not semantics.
- **Read path**: `readEvents(kind)` + a deterministic fold in the new pure module (the `readTrips` + `projectUtilityNow` pattern). No persisted projection in P4 v1: per-session volume is tiny at single-user scale, and a later `projection_items` subject is a semantics-free optimization. Expiry and liveness are computed inside this fold.
- **Delete/export**: the new kinds plug into the existing `forgetSubject` (red line 6 "deletable" = physical delete plus one audit line); `state-cli export` gains two derived views (`hot-context.jsonl`, `notebook.json`) read from the fold — a view, never a write path.
- **Zero-new-table argument**: every dual-zone datum is small, subject-scoped, append-only with idem dedupe, and viewable as a fold — the `events` shape covers all four. A dedicated table would only pay off as TTL indexes or per-session claim rows at multi-writer scale, which is precisely the ADR-15 re-review trigger (D-15). If D-15 fires: claim/fence physicalization plus optional persisted projections; the event vocabulary and this design's semantics survive unchanged ("sync = event replication, not state translation").
- **Kernel freeze**: `state-ledger.ts` is pinned by the kernel manifest (run-all §63 gate); this design requires zero edits to it, and P4-2's acceptance includes that gate green with zero hash drift.

## 3. Relation to the Existing Memory Surfaces

- **ADR-14 utility sidecar — unchanged**: notebook entries are not wishes and emit no `memory_utility` events in P4. The owner-confirmation discipline is inherited structurally (`owner_confirm` at promotion; the model never self-promotes). Per-entry utility accounting (recalled/applied/verified_outcome keyed on entry_id) would be a second utility consumer — that is ADR-14's own re-review trigger, not this design.
- **Wish pool — untouched**: the notebook has no `conditions` field and no outreach; the 0..1 never-proactively-sell red line stays wish-pool-only.
- **Motivation profile — untouched**: promotion never writes `mergeProfile` weights. A promoted entry that **is** a durable preference routes through `gotry_motivation_save` (contract-18 absorption) — the existing gate stays the single write authority for that semantic.
- **Timeline / companions — same routing rule**: a promoted trip fact routes through `gotry_trip_log`; a companion constraint routes through `gotry_companion_save`. The notebook records the assertion plus lineage; it never becomes a parallel store.
- **Ledger — single write authority**: dual-zone adds event kinds, never a second store. The dsh session transcript remains the raw-conversation authority inside dsh's own four packages (ADR-15 §1.3 boundary); both zones store pointers (`session_ref` + turn index), never transcript content.
- **P4 does not redo landed layers**: M1–M5 surfaces, the read-back chain, and memory-metrics keep their contracts; the only touch is the additive status sync in `memory-design.md` §2/§4. Migration path (checklist item 3): zone state is new, so nothing migrates — additive event kinds need no schema migration, and no existing surface changes authority.

## 4. Trigger Semantics and Falsifiable Value Evidence (#255)

- **Trigger record**: the founder approved entering the implementation flow on 2026-10-02; this charter (design + PR split) precedes the implementation PRs, and the issue stays the tracker until the PR series lands. The #255 checklist maps: ownership/expiry/CAS/delete/export → §1–§2; single write authority + migration → §3; privacy boundary → this section; falsifiable metrics → this section; founder approval → the header.
- **Privacy boundary (checklist item 1)**: neither zone and no export may contain raw conversation text, credentials, URLs, or sensitive identity fields. The negative list is enforced twice — at the zone write gate (pure function, same family as the companions guard) and at the export gate of the observation face. Evidence is carried as pointers and bounded quotes, never transcript content.
- **Evidence collection**: the [#228](https://github.com/Danceiny/gotry/issues/228) collector discipline, reused — explicit opt-in, isolated `stateRoot`, HMAC-pseudonymous refs, a consent statement, shape-only counters (captures / revisions / drops per tier, promotion proposals vs confirms vs denies, expiry ages, working-zone read hits and misses). No resident service, no auto-telemetry, no product-session attachment; exports are candidate-grade under the [#20](https://github.com/Danceiny/gotry/issues/20) evidence grades and never self-attest.
- **Falsifiable metrics (checklist item 4)** — "remembers more" cannot pass any of them:
  1. **Promotion signal quality** — owner confirm rate and deny rate among promotion proposals; a durable zone that mostly collects denials is a mis-tuned proposer.
  2. **Working-zone payoff** — re-ask avoidance: fields not re-asked in a returning session within the intent TTL, over the same fields the paired first visit asked (paired shape borrowed from #20; computed from flows, not content).
  3. **Stale-hit rate** — owner corrections of zone-served facts over zone-served facts; above a declared bound the TTL tiers are falsified the other way.
- Thresholds for these metrics are frozen in the P4-4 metric contract at PR time (the #20 threshold-freeze discipline — this design does not invent numbers). Fixtures prove only the metric contracts; `synthetic_fixture` never claims value. The frozen `p4` gate inside the #20 scorer/manifest contract follows its own evidence rules and is not flipped by this charter.
- **Activation switch**: `sessionZones: 'off' | 'on'` plugin config, default off — the same triple-switch family as `sessionAccess`. The founder enables it locally; real use then produces `observed_private` candidates through the collector, never through ambient collection.

## 5. Implementation Split (PR Series, All-Offline Acceptance)

Serial chain, each PR independently acceptable; every acceptance item is an offline test form (pure suites + isolated-stateRoot smoke; no network, no live collection).

| PR | Scope | Acceptance assertions (offline) |
|---|---|---|
| **P4-1 zone contract pure core** | new `ts/src/session-zones.ts`: typed closed sets, `HotNote`/`NotebookEntry` shapes, gates (negative list, owner-confirm quote, rev CAS), TTL/expiry pure function with injected clock, deterministic fold + read views | closed-set violations rejected; negative list rejects ID/phone/URL-shaped payloads; `stale_rev` fails closed; expiry monotone in the injected clock; fold is a pure function of events (rebuild == direct read); new run-all section (number assigned at PR time) |
| **P4-2 ledger landing + delete/export** | the six event kinds; transactional append via the ledger public surface (zero `state-ledger.ts` edits); `forgetSubject` integration; two export views | idem replay at the same rev is a no-op; a kill-9 mid-append leaves all-or-nothing; forget removes zone events plus one audit line; export view equals fold output; run-all §63 kernel-manifest gate green with zero drift |
| **P4-3 session wiring (default-off)** | capture seams (tool-observation boundary and contract-18-style user-statement absorption, evidence pointers only); persona read-back `{{session_zone_brief}}` (budget-capped: live working notes, intent-tier notes on return, notebook lines); promotion flow through an owner-confirmation surface; drop-on-correct | isolated-stateRoot smoke, zero writes to `dsh-runtime`; negative-list guard active end-to-end; read-back empty on first visit; promotion without a confirm quote is rejected; wiring inert with `sessionZones:'off'` |
| **P4-4 observation + metrics + status sync** | opt-in shape-only counters, HMAC candidate export (collector family), the three falsifiable metrics as read-only projections, `memory-design.md` §2/§4 status sync | fixture proves the metric contracts (not value); export carries counters and refs only — no content fields (asserted); zero timers/network in the observation path; bilingual docs and status surfaces synced in the same commit |

## 6. Explicitly Not Doing

- Multi-user replication, claim/fence/receipt physicalization — behind D-15 ([#275](https://github.com/Danceiny/gotry/issues/275)).
- Any live or ambient data collection; the observation face is opt-in CLI-shaped, the #228 family.
- Raw conversation text, IDs, tokens, URLs, or sensitive identity fields in either zone or any export.
- New tables, schema migrations, or edits to kernel-manifest-pinned files (`state-ledger.ts` untouched throughout).
- Touching dsh's four harness-session packages; the transcript stays dsh's own authority.
- Re-doing M1–M5 surfaces, paralleling their write authorities, or storing free-form LLM memory (every capture passes typed gates).
- Flipping the frozen #20 scorer `p4` gate from this work; it follows its own evidence rules.

## 7. Decision Log (Rejected Alternatives)

| Rejected | Why |
|---|---|
| Read-extends-life TTL | read-path side effects break fold determinism and replay; life counts from writes only |
| Persisted `projection_items` subjects in P4 v1 | read-fold suffices at single-user scale; persisting now buys nothing and adds rebuild surface |
| A dedicated zone table with TTL columns | only pays at multi-writer scale — exactly the D-15 re-review trigger; the event vocabulary covers v1 |
| Expiry/drop sweep events | wall-clock actions do not belong in an append-only ledger; expiry is a read-time view |
| The notebook as a parallel fact store | single write authority per semantic (§3 routing rule); a second store forks truth |
| Per-entry utility events now | that is a second ADR-14 consumer — ADR-14's own re-review trigger decides, not P4 |
| Model-initiated promotion | storage inherits the ADR-14 owner-confirmation discipline; propose-only |
