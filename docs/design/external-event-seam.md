[English](external-event-seam.md) | [简体中文](external-event-seam.zh-CN.md)

# External-Event-Driven Seam Design (#82 world2agent compatibility direction, issue #119 / D-31)

> Status: **design document (2026-09-04, issue #119; updated 2026-09-12)**. This document designs; it commits to no runtime implementation — for the landing
> sequence see §6, where segments 1-2 have already landed (local probe + wish-pool consumption) and only the remaining w2a sensor producer is trigger-gated.
> Principle: **consume existing seams; build no new runtime**.
> Already landed locally and preserved: the channel probe (§6.1) and the wish-pool consumer (§6.2). The w2a/0.1 envelope
> **contract-only** slice is approved as an inert, default-off typing/validation contract (§5.1) that activates no live path;
> real bridge/sensor/auth/consumer activation stays trigger-gated under issue #82. Nothing here claims any remote sensor path
> is implemented or verified.
> Related: issue #82 (world2agent protocol integration), ADR-18 (effect interpreter)/ADR-24 (turn budget),
> D-8 (static flattening + health-state-driven dynamic advice), `capabilities/channel-health.ts` (health surface),
> `src/wish-pool.ts` (wish-pool recall), `capabilities/async-workorders*`/`turn-handoff-collect.ts`
> (cross-process work-order closed-loop precedent).

## 1. What this answers

issue #82's ask: let **external-world events** (site redesigns/risk-control upgrades/API deprecations/quota policy changes/
the user's actions elsewhere) drive agent behavior, instead of relying only on user sessions "stumbling into" them. This design gives
the gotry-side seam form: **external events become new producers for two existing surfaces** —

1. **The channel health surface** (`channel-health.ts`): a site breaks → set the channel state to `down` → routing advice
   excludes it immediately (zero change to existing logic);
2. **Wish-pool conditions** (`wish-pool.ts`): events as a new fact source for recall evaluation (still a pull
   model, no push).

## 2. Current state: in-process routing state vs. persisted out-of-band events, and the unconnected w2a producer

Two surfaces are easy to conflate, so state them separately:

- **Session verdict → in-process routing state**: `noteChannelVerdict` writes the in-process `channelState` map
  (needs-setup→down, hit→clear, miss/error→no change, cooldown expiry), and `routingAdvice` reads that map **plus an explicit
  down set projected by the caller**;
- **Local probe → persisted health events**: the landed read-only probe (`ts/scripts/channel-probe.ts`, §6.1) is already an
  **out-of-band local producer**. On anomaly it calls `recordChannelEvent` (down), on recovery it writes `'ok'` (latest-wins override),
  landing persisted health. Persisted health is read by wish-pool recall, existing doctor readers, and — since #436 — the six
  non-hit tool results, which read it at the tool-result boundary and exclude the union of the session state and the persisted down set.

What is still open:

- In-session facts like flyai quota exhaustion or Ctrip (携程) challenged propagate fine through the verdict path (#106-#108 already closed);
- Out-of-band facts — a 12306 redesign, a Ctrip risk-control policy upgrade, an API going offline — are only recorded where the local
  probe covers them; the **remote w2a sensor producer is not connected** (issue #82);
- **Persisted-health routing propagation (#436) is implemented for tool results**: a persisted `down` removes the channel from the
  `routing` advice appended to the six non-hit tool results, with no verdict call involved. The tool-result boundary reads the latest
  persisted event per channel under a strict timestamp caliber, projects the pure down set, and unions it with the session state;
  only `down` adds a persisted exclusion (`cooldown` stays a pacing state; `'ok'` recovery or expiry only ceases the exclusion), and
  none of it clears an in-session failure. The static persona routing card and the
  default reader caliber (doctor / wish pool / probe) are unchanged.

## 3. Seam design: events as new producers for the health surface and the wish pool

### 3.1 Health-surface producer (the core; landable in a single PR)

External events enter the health surface in **exactly the same recording form as a tool verdict**:

```ts
recordChannelEvent(stateRoot, { channel: 'session:ctrip-flight', state: 'down',
                               reason: 'site-redesign', at: <iso> })
```

- Events are not a new mechanism; they are a second producer of an existing recording form. Consumers: wish-pool recall and the
  doctor's persisted-health reader read the persisted surface directly, and the six non-hit tool-result `routing` fields read it
  through the strict-timestamp reader plus a pure down projection (#436). A persisted producer therefore reaches routing advice even
  when this process recorded no verdict. Exclusion follows the existing routing rules: only `down` excludes a channel — `'ok'`,
  `cooldown` and expiry are not exclusions and clear no session down. The persona routing card stays static — it renders the order
  table, not health filtering.
- Recovery likewise goes through events (`state: 'ok'`) or natural expiry (same semantics as cooldown expiry).

### 3.2 Three producer classes (trust tiers; decision point in §5)

| Producer | Trust | Notes |
|---|---|---|
| Local probe tick (loopx/cron-driven read-only health check) | Locally trusted (owner machine) | No auth needed; the probe itself is read-only, writes go to local files |
| User/agent manual | Existing gate | Invoked via the tool surface, same family as session-consent/approval cards |
| world2agent remote callback | **needs auth (deferred)** | Signature/channel binding undecided; decide when a real callback party appears |

### 3.3 Wish-pool triggering: events are a new fact source for recall, not push

- Wish-pool recall is a **pull model** (`gotry_wish_pool_list` 0..1 recall, `WishMatchContext`
  = days/budget/month). After an event is recorded, recall evaluation can use "channel events" as a fact source of the context
  (e.g. an "exact-date miss event on a route" corroborating/refuting a wish's feasibility conditions).
- **No push**: before the M5 WriteGate opens, gotry has no proactive reach channel — what events change is the
  information quality of "the next recall/the next conversation", not an interruption of the user.

### 3.4 Work-order surface fulfillment (precedent already in place)

If an event needs **work** (e.g. re-calibrating an adapter after a site redesign), open an async work order — the cross-process
closed loop (`async-collect` / `turn-handoff-collect`, the "come back in an hour" form) is an existing mechanism;
sensor events are just a new work-order source.

## 4. Boundaries: what we do not do (the boundary is the trust)

- **No message bus/resident listener service**: in the single-machine local form, the JSONL file surface + heartbeat tick already cover it;
  a resident process is a new ops surface and a new failure surface.
- **No push notifications**: same as §3.3 — no reach channel before M5.
- **No cross-machine event replication**: multi-user ledgerization (RFC §6.5) is trigger-deferred (D-15); the event surface follows it.
- **Events do not enter the turn-policy classifier**: ADR-24 iron rule (control-plane verdicts are pure functions with zero IO) — events enter
  the model's view via tool results/recall, not routing verdicts.

## 5. Decision point (D-31, trigger-based)

**External-event write permission and the trust model**: who may set `down`? Local probes need no auth (they write local files, same level as
incidents); world2agent remote callbacks need signature/channel binding — **decide when the first real callback party
appears**, do not preset. Until decided, the remote surface stays closed (the seam exists only for local producers).

### 5.1 Approved contract-only slice (2026-09-12, issue #432)

The founder authorized a **contract-only** slice for the w2a/0.1 envelope, with the reference pinned at
[`schema/0.1/schema.ts`](https://github.com/machinepulse-ai/world2agent/blob/7e5fc4d441699993b8f1ef7d3b9776065b7a93e0/schema/0.1/schema.ts)
(`machinepulse-ai/world2agent` commit `7e5fc4d441699993b8f1ef7d3b9776065b7a93e0`). As scoped, the slice is a pure, deterministic adapter that projects only inert untrusted
event metadata; it invents no sensor-specific wire schema and installs no runtime dependency. Its boundary:

- **Default off**: it is reachable only with an explicit caller-supplied enabled option — no environment-based product switch, no listener,
  no token, and no consumer/runtime registration;
- **Exact reviewed tuple**: mapping requires an exact match on the reviewed source/package/version/type tuple; anything else is a stable rejection;
- **Claims are not authentication**: sender/source fields are untrusted data, and a tuple match is not an auth check;
- **No writes or dispatch**: channel-health writes, ledger/fact/wish-pool mutation, planner/tool dispatch, booking and payments stay unreachable.

Approving the contract **activates nothing live**: real bridge/sensor selection, auth/token ownership and consumer integration remain
trigger-gated under issue #82, and no M4/M5/M6 admission changes. The landed local probe and wish-pool consumer (§6.1/§6.2) are preserved.
Implementation and its verification are tracked in issue #432.

## 6. Landing sequence (trigger-based; each segment an independent PR)

1. **Minimal sensor probe row** ✅ (landed 2026-09-07: `ts/scripts/channel-probe.ts`, run-all §52): read-only probe ticks (drivable by loopx/cron) run
   side-effect-free probes against key channels; on anomaly call `recordChannelEvent` (down), on recovery write `'ok'` (latest-wins override),
   landing persisted health. Persisted-health readers (wish-pool recall, doctor) benefit immediately; since #436 the six non-hit tool
   results read the same surface through the strict-timestamp reader plus a pure down projection, so a persisted `down` excludes the
   channel from `routing` advice (session down still wins);
2. **Wish-pool consumption** ✅ (landed 2026-09-07: a `conditions.channels` optional condition + at recall time,
   a named channel being down refutes the feasibility condition, run-all §53; the "corroboration" render surface is left to a later slice);
3. **w2a/0.1 envelope contract-only adapter** (approved 2026-09-12, issue #432): the inert, default-off slice in §5.1 — contract only;
   it wires no producer and no consumer;
4. **world2agent callback (live)**: wire the remote producer after the auth model is decided (D-31); real sensor/bridge/consumer
   activation remains open under #82.

## 7. Compatibility with existing verdicts

- **ADR-18 (the interpreter does no automatic routing)**: what events change is "availability facts"; routing advice remains advice, not dispatch —
  precisely the natural extension of D-8's "static flattening + health-state-driven dynamic advice";
- **D-8/persona (19)**: the flattening is untouched; advice is projected from health state (events enrich health state);
- **WriteGate boundary**: the event surface is read-only + records facts, with no site-writing action of any kind; the M5 red line is unaffected.
