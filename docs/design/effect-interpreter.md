[English](effect-interpreter.md) | [简体中文](effect-interpreter.zh-CN.md)

# Effect Interpreter effect_interpreter.v1 (design document, adopted from issue #16, ADR-18)

> Status: accepted (2026-08-29). The vocabulary layer + production/mock dual interpreters + vertical slices have landed; smoke/run-all §37 are the anchors.
> Related: `../architecture.md` §8 ADR-18; `../data-sources.md` (data-source authority surface); `tool-packet.ts` (ADR-13, an earlier instance of the same tool-boundary idea).

## 1. Problem (breakdown of issue #16's original text)

issue #16, "multi-channel price comparison and external-dependency isolation", asks for three things:

1. **Separate effect description from interpreter**: the agent does not call `Ctrip.Query()` directly; it emits a pure-data effect
   `{ "effect": "SEARCH_FLIGHT", "params": {...} }`;
2. **Multi-environment interpreters**: a production interpreter (real API calls, with exponential-backoff retry/circuit breaker/rate limiting),
   a browser+CUA interpreter (browser-use operating OTA UIs, pluginized open source), and a mock interpreter (CI/local with no network);
3. Landing point: the architectural prerequisite for multi-channel price comparison.

## 2. Verdicts (item by item: adopt/amend/not adopt)

- **Adopt (effects as data)**: this repo already has precedents of the same idea — the packet discipline for tool boundaries (ADR-13,
  `tool-packet.ts`, the loopx effect-interpreter mapping) and the LLM-side `LlmPort` (mock-llm vs
  dsh-llm). But **the channel side has no unified seam**: each tool's execute calls capability-layer functions directly,
  and fetch/spawn/timeout/degradation/evidence cross-cutting logic is copied by every one of them. This design sinks "effect value + interpreter"
  into L4 (`ts/capabilities/effect.ts`), vocabulary name `effect_interpreter.v1`.
- **Adopt (resilience cross-cutting into the interpretation layer)**: exponential-backoff retry + circuit breaker land as
  `ts/capabilities/resilience.ts`, decided explicitly by a **per-effect policy table**, **all off by default — zero behavior change**;
  rate limiting is not rebuilt — the session-plane cadence gate (session-search §3.4, ≥30s) already exists within the channel,
  and is not re-implemented at this layer.
- **Amend (browser/CUA interpreter)**: a visual-click CUA is not done — the zero-Python-dependency repo red line condemns
  Python browser-use; the retrieval surface's a11y/DOM-first principle (user-session-data-rfc) also rules out visual automation.
  The browser interpreter is adopted as **SESSION_\* effects**: CDP attach to the user's own Chrome + ReadGuard
  (physical write interception) + the account authorization gate (session-consent). The issue's envisioned "pluginization for
  long-tail scenarios" is carried by the adapter form (session/adapters/*); no second browser runtime is introduced.
- **Not adopt (automatic multi-channel routing)**: the interpreter **does not** do automatic cross-channel routing/degradation ordering/price-comparison aggregation —
  the flat OTA tool surface and "no preset routing priority" are founder verdicts (persona 19/architecture §9
  second batch); price comparison happens at the agent layer (parallel multi-tool calls + evidence chain annotated per source). Multi-channel
  price comparison thereby gains its **architectural prerequisite** (every channel replaceable/breakable/mockable), not a price-comparison
  implementation at this layer.

## 3. Vocabulary (effect_interpreter.v1)

```
Effect value (pure data):  { effect: string, params: unknown }          // GotryEffect
Interpreted outcome:        { result: channel-native observation | null, // EffectOutcome (no re-wrapping; the ADR-13 surface stays undisturbed)
                              trace:  { attempts, backoffMs, breaker, declined?, evidence[] } }
Rejection surface (flat):   declinedObservation(): { ok:false, verdict:'error', summary, evidence }
```

- Interpreter interface `EffectInterpreter = (fx: GotryEffect) => Promise<EffectOutcome>`:
  - **Production interpreter** `makeProductionInterpreter({ handlers?, breakers?, now?, sleep? })`:
    look up the registry → breaker gate → `withRetry` (exponential backoff, base×2^(n-1) capped) → channel handler
    (current capability-layer functions, zero rewrite) → the channel observation passed through as-is + trace cross-cutting evidence
    `[效应:<NAME>@ts] attempts=… backoff=… breaker=…`;
  - **Mock interpreter** `makeMockInterpreter(fixtures)`: fixture replay, deterministic zero network — the recorded form of a channel
    observation is exactly its replay form (a third member of the same idea as mock-llm); CI/offline patrols
    "running the full chain with no network" use this channel;
  - `selectInterpreter('production'|'mock')` multi-environment injection.
- **Circuit-breaker semantics** (CircuitBreaker, resilience.ts): closed → (consecutive failures reach the threshold; one call one count,
  counted only after retries are exhausted) → open (zero-execution rejection, no error thrown) → cooldown elapsed → half-open single
  probe (success → closed and reset to zero; failure → open again, cooldown restarts). The state is an **in-process transient** (precedent:
  the session cadence gate), not persisted as a durable asset; tests are fully deterministic with an injected clock/immediate sleep.
- **Retry semantics**: only "transient-class" failures are retried (timeouts/network breaks/socket); failures where the upstream clearly says "no"
  (FlyAI Sentinel rate limiting, 429 trial-quota exhaustion) and ENOENT-class doomed failures are never retried — retry is an amplifier, not a fixer.

### Channel resilience policy table (authority surface; the code is the implementation, `SPECS`)

| Effect | Channel | Retry | Breaker | Cadence/Authorization | Rationale |
|---|---|---|---|---|---|
| `FLYAI_SEARCH` | cli | transient-class 2 times / starting 500ms | 3 consecutive errors / open 60s | – | data-sources §8: Sentinel rate limiting is never hard-retried; the breaker protects an unpublished quota; 429 trial-quota exhaustion maps to needs-setup (the tool surface blocks blind retries, 2026-09-02 Dubai session) |
| `HBCLI_HOTEL_SEARCH` | cli | timeout only, 2 times / starting 300ms | 3 consecutive errors / open 60s | – | the hbcli contract "candidate paths are switching, not retrying" covers only ENOENT-class; timeout (upstream cold-start building the backend session can exceed 30s) recovers with 1 retry (2026-09-02 Dubai session live record) |
| `HBCLI_HOTEL_RATES` | cli | timeout only, 2 times / starting 300ms | 3 consecutive errors / open 60s | – | same HBCLI family (timeout-only); the price surface **has no static degradation — fail-closed** (no fare estimation, same caliber as the bookable-facts evidence grading) |
| `HBCLI_CHECK_AVAIL` | cli | timeout only, 2 times / starting 300ms | 3 consecutive errors / open 60s | – | same as above; price-verification unavailable means honest failure (a booking-chain order precondition, M0) |
| `SESSION_FLIGHT_SEARCH` | browser | **never** | **not participating** | in-channel ≥30s cadence gate + account authorization gate | risk control/challenge = "the upstream said no"; retry is a red line; needs-login/cooldown are states, not faults |
| `WEATHER_GEOCODE/FORECAST/CLIMATE` | api | 2 times / 400ms | 3 consecutive errors / open 30s | – | retrying transient jitter of free sources is legitimate; the breaker keeps free quotas from idling away |
| `OPENSKY_FLIGHT_VERIFY` | api | 2 times / 400ms | 3 consecutive errors / open 30s | – | same as above (~400 credits/day) |

A new effect = add one handler row to the registry + one policy row to SPECS + one assertion in the §37 tests; **no policy-table
row, no effect** — resilience is an explicit decision, not a default inheritance.

## 4. Landing points and migration surface (as of this commit)

Connected (production-interpreter singleton; breaker state lives with the process):

- The five tools: `gotry_flyai_search` / `gotry_hotel_search` / `gotry_session_search` /
  `gotry_weather_check` / `gotry_flight_verify` (index.ts execute all now go through
  `interpretEffect`; breaker/not-registered rejections return the flat failure surface, never disguised as a miss);
- The solving chain: `realtime-pricing.ts`'s default query port (the `RealtimeQueryPort` injection surface is unchanged;
  the default implementation now goes through the interpreter — multi-segment itinerary queries automatically gain backoff + breaker).

Not connected (debt D-23; migration path = move channel by channel, remove one cross-cutting copy per move): `gotry_anything_search`,
`gotry_web_search`, `gotry_video_subtitle`, `gotry_github_search`, `gotry_agent_reach`,
`gotry_session_login` and the other channel tools still call the capability layer directly (they enjoy the same never-throw contract,
but have no backoff/breaker/mock fixtures yet).

## 5. Tests and anchors

`ts/scripts/effect-tests.ts` (run-all §37, purely offline): registry closedness / backoff-cap chain and accounting /
breaker three states (clock injection) / Sentinel not retried but breaker counted / breaker zero-execution rejection + cooldown single-probe recovery / mock fixture
replay / SESSION red line (never retry, no breaker) / real-handler static-package degradation smoke (custom nonexistent bin,
zero network).

## 6. Relation to existing vocabularies

- ADR-13 (tool packet discipline): the tool boundary's effect_request→interpretation→observation already exists in dsh; this layer is the
  isomorphic sink for the **channel boundary**; the two do not conflict (the tool surface stays flat);
- M5 WriteGate (ADR-15 pending_writes saga / ADR-17 booking_saga_fsm.v1): if write effects
  (booking/payment) ever enter the interpreter registry, they must traverse the booking_saga_fsm.v1 edge table — this vocabulary
  layer covers read effects only and does not constitute M5 milestone evidence;
- Reuse matrix: the interpreter is gotry's own code, no external code introduced; the mock channel and the fake-CLI injection form
  already used by flyai/hbcli tests are **at different layers and do not replace each other** — the fake CLI sits inside the handler (replacing the kernel
  process), the interpreter mock sits at the handler boundary (replacing an entire channel); CI's network-free full-chain runs use the latter.
