[English](external-event-seam.md) | [简体中文](external-event-seam.zh-CN.md)

# External-Event-Driven Seam Design (#82 world2agent compatibility direction, issue #119 / D-31)

> Status: **design document (2026-09-04, issue #119)**. This round designs only and commits to no implementation — for the landing sequence see §6;
> progress is trigger-based (the first real sensor starts the first segment). Principle: **consume existing seams; build no new runtime**.
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

## 2. Current state: the health surface has exactly one producer, and it is in-band

Today the only fact source of `channelState`/`routingAdvice` is the **tool-call verdict**
(`noteChannelVerdict`: needs-setup→down, hit→clear, miss/error→no change, cooldown expiry). This means:

- In-session facts like flyai quota exhaustion or Ctrip (携程) challenged propagate fine (#106-#108 already closed);
- **Out-of-band** facts have no entry point — a 12306 redesign, a Ctrip risk-control policy upgrade, an API going offline: the system has no way to know,
  and can only wait for the next real search failure, with the user session bearing the discovery cost.

## 3. Seam design: events as new producers for the health surface and the wish pool

### 3.1 Health-surface producer (the core; landable in a single PR)

External events enter the health surface in **exactly the same recording form as a tool verdict**:

```ts
recordChannelEvent(stateRoot, { channel: 'session:ctrip-flight', state: 'down',
                               reason: 'site-redesign', at: <iso> })
```

- `routingAdvice`'s down-exclusion, the doctor's quota visibility rows, and the persona routing-card caliber — **all take effect
  with zero changes** (they only read the event surface). Events are not a new mechanism; they are a second producer of an existing mechanism.
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

## 6. Landing sequence (trigger-based; each segment an independent PR)

1. **Minimal sensor probe row** ✅ (landed 2026-09-07: `ts/scripts/channel-probe.ts`, run-all §52): read-only probe ticks (drivable by loopx/cron) run
   side-effect-free probes against key channels; on anomaly call `recordChannelEvent` (down), on recovery write `'ok'` (latest-wins override) — routing/doctor benefit immediately;
2. **Wish-pool consumption** ✅ (landed 2026-09-07: a `conditions.channels` optional condition + at recall time,
   a named channel being down refutes the feasibility condition, run-all §53; the "corroboration" render surface is left to a later slice):
3. **world2agent callback**: wire the remote producer after the auth model is decided (D-31).

## 7. Compatibility with existing verdicts

- **ADR-18 (the interpreter does no automatic routing)**: what events change is "availability facts"; routing advice remains advice, not dispatch —
  precisely the natural extension of D-8's "static flattening + health-state-driven dynamic advice";
- **D-8/persona (19)**: the flattening is untouched; advice is projected from health state (events enrich health state);
- **WriteGate boundary**: the event surface is read-only + records facts, with no site-writing action of any kind; the M5 red line is unaffected.
