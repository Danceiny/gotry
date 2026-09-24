[English](recall-trigger.md) | [简体中文](recall-trigger.zh-CN.md)

# Recall Trigger Evaluator and Tick Scheduler (issue #577)

> Role: the contract vocabulary, pure-function implementations, and orchestration seam for Phase D recall triggering — tick sources, a 5-class reason closed set, the why-now card, and a wish-pool read-only integration. **No setInterval activation, no push, no wish-pool mutation** (all M4).
> Status: internal slice (2026-09-24). Phase D of the karpo-deck-web borrowing roadmap; the pull-model constraint comes from `docs/design/external-event-seam.md` §3.3/§4 (no push before M5 WriteGate).
> Upstream: issue #577; research decision §3 Phase D of [karpo-deck-web research](../research/karpo-deck-web-research.md); seam constraint from [external-event-seam.md](external-event-seam.md).
> Downstream: `ts/scripts/recall-tests.ts` (run-all §6i); future M4 slices (real tick source via the seam's local producer, dsh tool registration, wish-pool mutation wiring).

## TL;DR

- `TickSource` interface with `InMemoryTickSource` (test) and `PeriodicTickSource` (**default `enabled=false`**; M4 opts in). `RecallTickScheduler` orchestrates tick → evaluate → card → sink, one tick per `run()` — it never loops on its own.
- `evaluateRecallTriggers(pool, ctx)` — pure function pairing wish-pool candidates with signals. **5-class `RecallReason` closed set** (`holiday_proximity` / `price_drop` / `weather_window` / `route_new` / `availability_recovered`); broadcast signals match all valid candidates, targeted signals match by wish_id. Malformed signals are skipped, not crashed.
- `buildWhyNowCard(trigger)` — pure function producing a data card (title / reason label / current value / threshold / action hint / **source tag mandatory**). `renderWhyNowCardLine(card)` renders one line for logs/conversation.
- `evaluatePoolRecall(input)` — read-only wish-pool integration (no mutation; recall/notification stays M4).
- 49 assertions (run-all §6i, after the self-review hardening pass) covering: opt-in discipline (three-state start, blocking next, bounded pending, defensive copies), 5-reason reachability, broadcast vs targeted matching, muted/no-id filtering, source-tag presence, per-card delivery fault tolerance, scheduler end-to-end with per-tick provenance stamps.

## 1. Tick sources

```ts
export interface RecallTick { at: Date; source: string }
export interface TickSource { next(): Promise<RecallTick | null> }
```

- `InMemoryTickSource` — pre-seeded queue; drains to `null`. Test-only. Defensive deep-copies ticks on both construction and `next()` so callers mutating a returned tick cannot corrupt the queue snapshot.
- `PeriodicTickSource` — wraps `setInterval`; **`enabled` defaults to `false`** and must be explicitly set to `true` at construction. `start()` returns a three-state `'started' | 'disabled' | 'already-running'` (no conflation). Constructor throws on non-positive `intervalMs` or non-positive-integer `maxPending` (fail-closed). The timer is `unref()`-ed (does not hold the event loop). The pending queue is bounded (`maxPending`, default 100, drop-oldest). **`next()` blocks while running; returns `null` when not running** (never-started or stopped — drain-loop callers exit safely, never hang). `stop()` clears pending and wakes all waiters with `null` (no leaked consumer coroutines, no stale ticks after restart). This slice never constructs an enabled instance in product code — M4 wires the seam's local producer (issue #82).
- `RecallTickScheduler` — takes `{ evaluate, toCard, sink }` deps; `run(tick)` processes exactly one tick and returns `{ delivered, failed, errors? }`. **Never throws**: an `evaluate` throw returns `{0, 0, ['evaluate: …']}`; a per-card `toCard`/`deliver` throw skips only that card (`failed++`, message captured in `errors`, first 4). No internal loop: the caller (test now, M4 producer later) drives iteration. `toCard(evaluation, tick)` receives the tick — cards must stamp `evaluated_at` from `tick.at`, not an outer-scope clock.

## 2. Evaluator: the 5-class closed set

```ts
export type RecallReason =
  | 'holiday_proximity' | 'price_drop' | 'weather_window'
  | 'route_new' | 'availability_recovered'
```

`evaluateRecallTriggers(pool, { now, signals })` pairs each well-formed signal with matching candidates:

- **Targeted** (`signal.wish_ids` non-empty): exact wish_id match only.
- **Broadcast** (`wish_ids` empty/absent): matches all candidates that are not `muted` and have a non-empty string `wish_id` (the same stability discipline as `wish-pool.ts`'s `pickNudgeWish`).
- One wish × multiple signals → multiple triggers (one card per signal).
- Malformed signals (unknown reason / empty source / missing fields / null / non-object) are skipped silently — the closed set is enforced at the boundary, not trusted from input.
- Empty signals or empty pool → empty array. **No hard push.**

## 3. Why-now card

```ts
export interface WhyNowCard {
  title: string           // 「现在可以去了:{wish_name}」 — closed vocabulary
  reason: RecallReason
  reason_label: string    // e.g. 「假期临近」
  current_value: string   // e.g. 「2026-10-01(距今 7 天)」
  threshold: string       // e.g. 「距假期 ≤14 天」
  action_hint: string     // per-reason closed set (5 variants)
  source_tag: string      // 「[source:{signal.source}]」 — MANDATORY
  evaluated_at: string    // ISO
  evidence_boundary: true // renderers must surface this
}
```

The research doc's red line — **proactive with provenance** — is structurally enforced: `source_tag` is derived from `signal.source`, which the evaluator requires to be a non-empty string before a signal can fire at all. A card without provenance cannot be constructed.

## 4. Wish-pool integration

`evaluatePoolRecall({ pool, tick, signals })` — composes the evaluator and card builder over a `WishPoolEntry[]`. **Read-only**: the module imports the type but never calls `wish-pool.ts` mutation functions. What happens after a trigger fires (mute, notify, schedule) is M4's concern.

## 5. Decision log

- **Why no push.** The external-event seam design (§3.3/§4) is explicit: gotry has no proactive reach channel before the M5 WriteGate opens; events change the *information quality* of the next recall/conversation, not interrupt the user. The why-now card enriches pull-model recall; the sink is an injected downstream, never a notification channel.
- **Why `PeriodicTickSource` defaults to disabled.** The repo's runtime-activation discipline (w2a/0.1 contract-only slice precedent): a background loop that starts silently is a new ops surface and failure surface. `enabled=false` + explicit opt-in keeps this slice activation-free.
- **Why `run(tick)` processes exactly one tick.** A scheduler that loops internally owns its lifecycle — the caller can't bound it. One-tick-per-call keeps tests deterministic and gives M4's producer full iteration control.
- **Why the reason set is closed at five.** Each reason must have a provenance source (holiday calendar, price monitor, weather forecast, schedule update, channel health) that M4 can actually wire; inventing reasons ahead of sensors invites unfired vocabulary. New reasons arrive with their sensor, in one reviewed change.
- **Why the title is closed vocabulary.** 「现在可以去了:{name}」 is a contract surface for renderers (deck, conversation, SMS); free-form titles would make bilingual rendering and audit filtering unbounded. Changing the wording is a contract change.
- **Why muted and id-less entries are filtered at evaluation.** Mirrors `pickNudgeWish`'s discipline: muted wishes are never recalled; entries without a stable wish_id cannot be referenced by downstream mutation. Filtering here (not at the card layer) keeps cards valid by construction.

## 6. Slice status and explicit non-claims

Landed here: `ts/src/recall/{tick,evaluator,card,integration}.ts` + `ts/scripts/recall-tests.ts` (49 assertions after the self-review hardening pass, run-all §6i).

Not in this slice: real tick activation (M4, via the seam's local producer under issue #82); dsh tool registration (`gotry_recall_*`); wish-pool mutation on trigger (mute/notify); signal producers (holiday calendar / price monitor / weather / schedule / channel-health adapters that actually populate `RecallSignal`); any push notification path (M5 WriteGate). The seam is contract-complete; M4 plugs the producer and wires the consumer without touching this module's API.

## 7. Cross-references

- `docs/research/karpo-deck-web-research.md` §3 Phase D — the slicing decision.
- `docs/design/external-event-seam.md` §3.3/§4 — the pull-model constraint this slice obeys.
- `ts/src/wish-pool.ts` — the candidate shape and stability discipline this module mirrors.
- `docs/code-map.md` rows for `ts/src/recall/*`.
