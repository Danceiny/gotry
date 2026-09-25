[English](recall-trigger.md) | [简体中文](recall-trigger.zh-CN.md)

# Recall Trigger Evaluator and Tick Scheduler (issue #577)

> Role: the contract vocabulary, pure-function implementations, and orchestration seam for Phase D recall triggering — tick sources, a 5-class reason closed set, the why-now card, and a wish-pool read-only integration. **No setInterval activation, no push, no wish-pool mutation** (all M4).
> Status: internal contract slice with wish-condition eligibility and match-hit evidence. Phase D of the karpo-deck-web borrowing roadmap; the pull-model constraint comes from `docs/design/external-event-seam.md` §3.3/§4 (no push before M5 WriteGate).
> Upstream: issue #577; research decision §3 Phase D of [karpo-deck-web research](../research/karpo-deck-web-research.md); seam constraint from [external-event-seam.md](external-event-seam.md).
> Downstream: `ts/scripts/recall-tests.ts` (run-all §6i); future M4 slices (real tick source via the seam's local producer, dsh tool registration, wish-pool mutation wiring).

## TL;DR

- `TickSource` interface with `InMemoryTickSource` (test) and `PeriodicTickSource` (**default `enabled=false`**; M4 opts in). `RecallTickScheduler` orchestrates tick → evaluate → card → sink, one tick per `run()` — it never loops on its own.
- `evaluateRecallTriggers(pool, ctx)` — pure function pairing wish-pool candidates with signals. **5-class `RecallReason` closed set** (`holiday_proximity` / `price_drop` / `weather_window` / `route_new` / `availability_recovered`); **candidates must first pass the condition-eligibility gate**: `ctx.match_context` (a `WishMatchContext`) feeds the existing `scoreWishMatch` from `wish-pool.ts` (reused verbatim — no second matcher); any one days/budget/month hit grants recall eligibility, a named down channel vetoes. Signals — including targeted ones — cannot bypass the gate; a missing/invalid `match_context` fails closed to an empty result, never broadcast. Each trigger carries its actual `match_hits`. Malformed signals are skipped, not crashed.
- `buildWhyNowCard(trigger)` — pure function producing a data card (title / reason label / current value / threshold / action hint / **source tag mandatory** / `match_evidence` when the trigger carries condition hits). `renderWhyNowCardLine(card)` renders one line for logs/conversation and states the boundary: matched wish conditions are not all trip conditions satisfied.
- `evaluatePoolRecall(input)` — read-only wish-pool integration (no mutation; recall/notification stays M4).
- 96 assertions (run-all §6i) covering: opt-in discipline (three-state start, blocking next, bounded pending, defensive copies), 5-reason reachability under valid conditions, broadcast vs targeted matching behind the eligibility gate, muted/no-id filtering, source-tag presence, match-hit evidence through trigger → card → render boundary, per-card delivery fault tolerance, scheduler end-to-end with per-tick provenance stamps.

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

`evaluateRecallTriggers(pool, { now, signals, match_context })` applies two gates in order:

1. **Eligibility** — a candidate enters matching only if `scoreWishMatch(entry, match_context)` returns a match: any one of days/budget/month hits against the injected window, and no condition-named channel in `match_context.channelDown` when the down-set is provided. The scorer is imported from `ts/src/wish-pool.ts` and reused verbatim — this module never duplicates its arithmetic or thresholds.
2. **Matching** — targeted (`signal.wish_ids` non-empty): exact wish_id match among eligible candidates. Broadcast (`wish_ids` empty/absent): matches all eligible candidates (not `muted`, non-empty string `wish_id`). **A targeted signal cannot bypass the eligibility gate.**

- One wish × multiple signals → multiple triggers (one card per signal).
- Malformed signals (unknown reason / empty source / missing fields / null / non-object) are skipped silently — the closed set is enforced at the boundary, not trusted from input.
- Empty signals or empty pool → empty array. **No hard push.**

### Condition-eligibility boundary rules (issue #577 completion)

- **Missing or malformed `match_context` fails closed** to an empty result — never downgraded to a broadcast. A context with string or non-finite numeric fields, or a non-Set-like `channelDown` (such as an array), is rejected. An unknown window must not authorize 「现在可以去了」.
- **An empty context `{}` is well-formed but arms nothing**: zero window facts → zero hits → zero triggers.
- **Any one hit qualifies** (the scorer's existing semantics): one days/budget/month hit is recall *eligibility*, not proof that all trip conditions are satisfied. The veto and the arithmetic are the scorer's, unchanged.
- **Producer vs matcher responsibility**: a signal is a producer-provided event notice — `current_value`/`threshold` are human display strings, not typed price/date facts. The evaluator never parses them; typed facts enter only through `match_context`.
- Each `RecallTrigger` carries `match_hits` — the scorer's per-condition hit strings (e.g. `days≥5`), always non-empty when a trigger exists.
- Malformed runtime shapes (string/number `conditions`, string `best_months`, null entries) are judged by the scorer's own defensive semantics and never throw; an unexpected scorer throw demotes only that one entry.

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
  match_evidence?: string[] // actual condition hits, e.g. 「days≥5」 — absent = no evidence attached
}
```

The research doc's red line — **proactive with provenance** — is structurally enforced: `source_tag` is derived from `signal.source`, which the evaluator requires to be a non-empty string before a signal can fire at all. A card without provenance cannot be constructed.

**Evidence honesty (#577 completion)**: `buildWhyNowCard` copies `trigger.match_hits` into `match_evidence` only when it is a non-empty array of non-empty strings — all-or-nothing, no cropping, no invention. A manually constructed trigger without hits produces a card that states the signal but carries no condition evidence; its render line keeps the plain `[证据边界:仅证据驱动]` marker. When evidence is present, the render line states the matched conditions (`;命中条件:days≥5+…`) and the boundary marker explicitly refuses the stronger claim: `[证据边界:仅命中上述愿望条件,非全部出行条件已满足]`. A card never asserts that all trip conditions are satisfied.

## 4. Wish-pool integration

`evaluatePoolRecall({ pool, tick, signals, match_context })` — composes the evaluator and card builder over a `WishPoolEntry[]`, passing `match_context` through unchanged. **Read-only**: the module imports the type but never calls `wish-pool.ts` mutation functions. What happens after a trigger fires (mute, notify, schedule) is M4's concern. The Phase E plan-it action (`buildPlanItAction`) consumes only `card.wish_id` and is unaffected by the optional evidence field — the session-link suite pins this.

## 5. Decision log

- **Why eligibility precedes signal routing.** Reuse `scoreWishMatch` as the single judgment layer: a reason event (holiday proximity, price drop, …) raises the *information quality* of a recall; the wish's own conditions against the injected window decide *eligibility*. Duplicating or extending that arithmetic here would create a second matcher to keep in sync.
- **Why one hit qualifies — and why the card says so.** By the scorer's existing semantics, any days/budget/month hit grants recall eligibility; it is not proof that all trip conditions are satisfied. That boundary is carried into the card (`match_evidence` + the render boundary clause) rather than left implied by the 「现在可以去了」 title.
- **Why the evaluator never parses signal strings.** `current_value`/`threshold` are producer display strings; parsing them here would fork the producer's rendering contract and invite divergent price/date semantics. Typed facts enter only through `match_context`.
- **Why missing context fails closed.** Broadcasting when the window is unknown would recreate the #577 overreach in the presence of a broken caller; an empty return is the only honest answer.
- **Why no push.** The external-event seam design (§3.3/§4) is explicit: gotry has no proactive reach channel before the M5 WriteGate opens; events change the *information quality* of the next recall/conversation, not interrupt the user. The why-now card enriches pull-model recall; the sink is an injected downstream, never a notification channel.
- **Why `PeriodicTickSource` defaults to disabled.** The repo's runtime-activation discipline (w2a/0.1 contract-only slice precedent): a background loop that starts silently is a new ops surface and failure surface. `enabled=false` + explicit opt-in keeps this slice activation-free.
- **Why `run(tick)` processes exactly one tick.** A scheduler that loops internally owns its lifecycle — the caller can't bound it. One-tick-per-call keeps tests deterministic and gives M4's producer full iteration control.
- **Why the reason set is closed at five.** Each reason must have a provenance source (holiday calendar, price monitor, weather forecast, schedule update, channel health) that M4 can actually wire; inventing reasons ahead of sensors invites unfired vocabulary. New reasons arrive with their sensor, in one reviewed change.
- **Why the title is closed vocabulary.** 「现在可以去了:{name}」 is a contract surface for renderers (deck, conversation, SMS); free-form titles would make bilingual rendering and audit filtering unbounded. Changing the wording is a contract change.
- **Why muted and id-less entries are filtered at evaluation.** Mirrors `pickNudgeWish`'s discipline: muted wishes are never recalled; entries without a stable wish_id cannot be referenced by downstream mutation. Filtering here (not at the card layer) keeps cards valid by construction.

## 6. Slice status and explicit non-claims

Landed here: `ts/src/recall/{tick,evaluator,card,integration}.ts` + `ts/scripts/recall-tests.ts` (96 assertions, run-all §6i). No runtime activation was added: the evaluator, card builder, and integration remain pure functions with no I/O, state, or timers.

Not in this slice: real tick activation (M4, via the seam's local producer under issue #82); dsh tool registration (`gotry_recall_*`); wish-pool mutation on trigger (mute/notify); signal producers (holiday calendar / price monitor / weather / schedule / channel-health adapters that actually populate `RecallSignal`); any push notification path (M5 WriteGate). The seam is contract-complete; M4 plugs the producer and wires the consumer without touching this module's API.

## 7. Cross-references

- `docs/research/karpo-deck-web-research.md` §3 Phase D — the slicing decision.
- `docs/design/external-event-seam.md` §3.3/§4 — the pull-model constraint this slice obeys.
- `ts/src/wish-pool.ts` — the candidate shape and stability discipline this module mirrors.
- `docs/code-map.md` rows for `ts/src/recall/*`.
