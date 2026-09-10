[English](data-sources.md) | [简体中文](data-sources.zh-CN.md)

# GoTry Data Source Architecture (Sole Authority on Data Sources)

> Position: the sole authority in this repo on **where external data comes from** — domain × source × freshness × evidence chain × fallback path.
> For how the system is composed, see `architecture.md`; for the timeline, see `roadmap.md`; this document covers data only.
> Downstream: the capability-layer wrappers (`ts/capabilities/`) and the dsh plugin tools (`ts/src/index.ts`) derive from this document.
>
> L4 invariant (applies to all sources): evidence-chain annotations must reach the user — `[实时API:xxx@ts]` / `[静态包:估算]` / `[骨架:源]`;
> estimates must be explicitly marked; not found ≠ does not exist (three-valued semantics).

---

## 1. Design Principles (Why This Division)

1. **The LLM never fabricates data** (ADR-10): schedules/prices/coordinates/weather come only from the capability layer; the LLM produces only skeletons and anchors.
2. **Free tiers as the base, paid tiers on demand**: static skeleton (offline-capable) → free realtime (Open-Meteo/OpenSky) → **reuse the hotel-be Anything main path** (enterprise-grade POI cache/ranking, no key, free) → M4 scale-up Google Place (geographic ratings/photos; pay-per-call) → paid (none for now).
3. **Reuse, don't rewrite** (master-outline reuse matrix): capabilities already integrated in hotel-be (Google Place / hotel inventory) are reused via the hbcli bridge; GoTry never connects directly.
4. **Fallback never blocks**: any realtime source failure falls back to the static pack/skeleton with annotation, and planning is never interrupted (capability-layer contract: always return some kind of result).
5. **At least one free source per domain**: no deadlock on quotas/credentials during the seed-user phase.

---

## 2. Domain Matrix (Current State × Target)

| Domain | Current status | Freshness | Evidence chain | Target (by milestone) |
|---|---|---|---|---|
| **Route viability** | ✅ OpenFlights skeleton with 168 hub pairs (ODbL, `data/openflights-skeleton.json`) | Static (monthly) | `[骨架:openflights]` | Keep; expand the hub set; Amadeus is shut down and will not return |
| **Flight schedules/timetables** | ⚠️ Static pack `data/flights_2026.json` (public-channel research, 5-segment chains) + FlyAI official free channel (`capabilities/flyai.ts`, landed P1, 2026-08-28) + session channel (`session-search.ts` + Ctrip (携程) adapter, extension bridge PRIMARY); OpenFlights skeleton as the gold standard for route viability | Realtime (FlyAI / session) / static (fallback) | `[实时API:flyai@ts]` / `[会话:ctrip-flight@ts]` / `[骨架:openflights]` / `[静态包:估算]` | Fares: see M5 (airline price path); current path = FlyAI + session (extension bridge) cross-validation; **aviationstack is no longer on the path** (removed from the verification layer; the free tier + official APIs already cover the original goal) |
| **Realtime flight observation** | ✅ OpenSky integrated (`capabilities/opensky.ts` + the `gotry_flight_verify` tool; `/api/states/all` current ADS-B global observation, ~400 credits/day) | Realtime | `[实时API:opensky]` | ✅ Landed (2026-08-22) |
| **Hotel inventory/quotes** | ✅ hbcli bridge (realtime — full-flow E2E on 2026-08-30 verified channel/auth/search orchestration end to end, run-all §7d) + Fliggy (飞猪) `search-hotel` (masked-price fidelity) + static-pack fallback filtered by destination | Realtime/static | `[实时API:hbcli@ts]` / `[实时API:flyai@ts]` / `[静态包:估算]` | Keep; hotel-list returns to realtime once UAT destination/inventory data is backfilled (channel already proven); OTA tool surface flattened (no primary/fallback routing; pick per query) |
| **Hotel reviews/ratings** | ✅ **Reuse hotel-be Anything** (contains hotels + mixed city/area candidates); the M4 Google Place scale-up path is gated for later (personal key in the geography repo + quota caps); remainder → [#345](https://github.com/Danceiny/gotry/issues/345) (not implemented until the first review/photo pull trigger arrives) | Any (hit/miss), M4: geography | `hbcli-anything` | M3: DONE (founder calibrated the Anything reuse); M4: Google Place scale-up path (geography GetPlaceReviews) |
| **POI/place search** | ✅ Anything (mixed city+hotel+place candidates) + OSM backstop (`dsh-map-tools` embeds Nominatim/Photon as a free fallback; `ts/scripts/map-tools-vendor-package-proof.ts` proves the vendored package) | Any | `hbcli-anything` / M4 `osm-nominatim` | M3: DONE; same choice as TREK, free backstop |
| **Weather/seasonality** | ✅ Open-Meteo integrated (`capabilities/weather.ts`: forecast ≤16 days + historical climate baseline; free, no key; tool `gotry_weather_check`); dual-source geocoding: Open-Meteo (primary; population/admin-level ranking prevents a same-named small place from outranking the main city) + OSM Nominatim (Chinese-language backstop — open-meteo has gaps in Chinese name coverage; issue #24 measured the query "普吉岛" (Phuket) returning 0 results) | Realtime | `[实时API:open-meteo@ts]` / backstop `[实时API:nominatim@ts]` | Keep; WMO codes already mapped to Chinese |
| **Ground transport (transfers/rail)** | ⚠️ **#341 first slice**: accepts only explicit origin/destination lat/lng and `mode=driving`; `ts/capabilities/ground-transfer.ts` delegates route results through the registered public `map_driving_route`, binding minutes only to the named static `taxi` transfer; `bus`/`bus_plus_taxi` do not call the route provider, and static prices are not rewritten | Route estimate + per-apply cache; **not realtime traffic** | Route facts = `map_driving_route` + `asOf` (host observation/query time, not provider publish time)/freshness/cache; fallback = `[静态包:估算]` | live traffic, transit/rail, fares, address resolution, and broader transfers are still not integrated; 12306 is not assumed by this slice |
| **Geography/administrative divisions** | ⚠️ Online maps are backed by `dsh-map-tools` Nominatim/Photon (vendored, free at runtime); **the bundled GeoJSON atlas has not been built yet** (to be implemented when the offline-first requirement triggers); remainder → [#342](https://github.com/Danceiny/gotry/issues/342) | Realtime (online) | `[实时API:nominatim@ts]` | TREK pattern: bundled GeoJSON atlas (script-built, offline) |
| **Time zones** | The v2 flight pack uses explicit IANA zones and local dates to resolve UTC instants; `Intl.DateTimeFormat` is the runtime authority; unknown zones and DST gaps/overlaps are rejected at the boundary; UTC instants are used for elapsed duration and home-zone work-window projection. The static v1 numeric offset remains compatible; this deterministic contract does not represent live schedules, prices, availability, or inventory | Dynamic (runtime constants) + static v1 | `[运行时权威:Intl.DateTimeFormat]` (v2) / `[静态包:估算]` (v1 numeric) | v2 explicit IANA; v1 remains compatible |
| **Exchange rates** | ❌ None (all CNY hardcoded); **multi-currency FX remains trigger-deferred** — the China-outbound launch currently relies on the CNY settlement path; to be implemented after the first real non-CNY booking triggers it; remainder → [#344](https://github.com/Danceiny/gotry/issues/344) | — | — | Multi-currency FX (free tier such as Exchangerate.host, or hotel-be) |
| **Visas/entry** | ✅ Policy-fact producer v1 (2026-09-05, issue #141): tier-C China Consular Service Network (cs.mfa.gov.cn) country-guide tree, polite crawling (never retry + circuit breaker to protect the site) → visa/entry section extraction → PolicyFact (as_of + D+30 review_by + source evidence chain) booked to the ledger | Static snapshot crawling | `[实时API:cs-mfa@ts]` | Timatic/Sherpa° to be discussed later (founder decided the tier-C free authoritative source goes first) |

---

## 3. Layered Architecture (How Data Flows)

```
                    ┌──────────────────────────────────────────────┐
                    │ L1 用户面:证据链标注([实时API:x@ts]/[静态包:估算])│
                    └──────────────┬───────────────────────────────┘
                                   │
                    ┌──────────────▼───────────────────────────────┐
                    │ L2 dsh 插件工具面(ts/src/index.ts,五工具)      │
                    │   gotry_feasibility_check / skeleton_check    │
                    │   hotel_search / motivation_save / wish_pool  │
                    └──────────────┬───────────────────────────────┘
                                   │
                    ┌──────────────▼───────────────────────────────┐
                    │ L3 能力层封装(ts/capabilities/)               │
                    │   hbcli.ts(进程桥+降级+证据链)                │
                    │   incident-log.ts(护栏)                      │
                    │   [已建] weather.ts / opensky.ts / anything.ts│
                    └──────────────┬───────────────────────────────┘
                                   │
        ┌──────────────┬───────────┼──────────────┬─────────────────┐
        ▼              ▼           ▼              ▼                 ▼
   ┌─────────┐   ┌──────────┐ ┌─────────┐  ┌────────────┐  ┌──────────────┐
   │静态包    │   │免费实时   │ │hbcli 桥 │  │OSM 生态     │  │FlyAI 官方    │
   │data/*.  │   │OpenSky   │ │hotel-be │  │(dsh-map-   │  │免费通道       │
   │json     │   │Open-Meteo│ │search   │  │tools 内嵌   │  │(机票/酒店/   │
   │金标准    │   │          │ │OpenAPI  │  │Nominatim/  │  │POI/铁路,已   │
   │         │   │          │ │         │  │Photon/     │  │落地 P1)      │
   │         │   │          │ │         │  │OSRM)       │  │              │
   └─────────┘   └──────────┘ └────┬────┘  └────────────┘  └──────────────┘
                                    │ 内网 HTTP
                            ┌───────▼────────────────┐
                            │ hotel-be               │
                            │ search 模块(OpenAPI)   │
                            │  └─ geography(内网)     │
                            │      └─ Google Places  │
                            │         v1(按次收费)    │
                            └────────────────────────┘
```

**One primary chain + one fallback chain per domain**; fallback outputs must carry evidence annotations; planning never blocks.

---

## 4. General POI Search — Anything Reuse First (founder calibration, 2026-08-23)

**Current decision (M3 main path)**: GoTry's POI / place / hotel search **goes through the hotel-be Anything function** — it already exists (search/service/geography.go:232); no new Places service is added. Anything is an enterprise-grade FuzzySearch + mixed city/hotel ranking, with quality far beyond LLM common sense (ADR-10: translation is not license to fabricate data).

```
gotry plugin (gotry_anything_search)
  → ts/capabilities/anything.ts (spawn hbcli search anything)
    → hbcli (external/hotelbyte-cli/src/commands/search.ts: search anything)
      → hotel-be /api/search/anything (public surface, go-zero dispatcher reflection)
        → search/service.Anything function (SearchReq{keyword, contentType?, parentDestinationId?})
          → returns mixed candidates[city|hotel|place]
            evidence chain: [实时API:hbcli-anything@ts] (three values: hit/miss/error)
```

**When Anything is not enough — the Google Place scale-up path (post-M4)**:

```
gotry (gotry_place_search tool, planned)
  → hbcli search place-search "<query>" (planned)
    → hotel-be /api/search/googlePlaces/search (planned — exposes geography /SearchPlace)
      → geography/service/google_service.go:SearchPlace
        → Google Places v1 (geography repo already wired with a personal API key, pay-per-call)
```

**Anything vs Google Place decision matrix** (M4 decision point D-4a):

| Option | Anything | Google Place Scale-up |
|---|---|---|
| Quality | Enterprise-grade FuzzySearch (ranking algorithm + cache) | Ratings / photos / opening hours |
| Quota | None (runs inside hotel-be) | Pay-per-call (geography personal key) |
| Data updates | Take effect as soon as the hotel-be master repo updates | Google realtime |
| When to choose | Seed-user phase / any mixed place+hotel query | Upgrade after M4 calibrates the data |

**Current Anything fallback chain** (L4 invariant: fallback never blocks):
- hbcli unreachable → verdict=`unavailable` + evidence chain `[实时API:hbcli-anything@error@ts]`
- Anything miss (0 candidates) → verdict=`miss`, letting the LLM try different search terms
- agent-reach is the last-resort backstop one level below Anything (.shared/skills/; D-4a decides whether to use it)

**Decision history**: on 2026-08-22 the Google Place chain was decided as the sole path; on 2026-08-23 the founder remarked "anything is just hotel-be's interface" and "hotelbyte-cli / hotel-be are within your workspace scope", switching to **Anything reuse as the main path**, with Google Place scale-up deferred. Three-repo commit closure (gotry `244a0ae` + hbcli `43236a0` + hotel-be `c38ff65d1`).

**Current gaps** (in chain order):

| Segment | Status | Gap | Owning repo |
|---|---|---|---|
| geography → Google | ✅ Integrated (`geography/service/google_service.go`, API key configured) | `SearchPlace`/`GetPlaceReviews` are not in the `InternalExposedMethods` whitelist (`geography/service/interface.go:93`) | hotel-be |
| search → geography | ❌ Not exposed | The search module needs a new place OpenAPI endpoint (delegating to geography, with quota caps — the personal key is pay-per-call) | hotel-be |
| hbcli → search | ❌ No command | `hbcli search place <query>` / `hbcli search place-reviews <id>` + `--json` | hotel-be (external/) |
| gotry → hbcli | ❌ Not wired | `capabilities/place.ts` (hbcliPlaceSearch, falls back to OSM Nominatim on failure) | gotry |

**Quota red line**: the Google Places personal account is pay-per-call (hotel-be already caps it in multiple places); the gotry side must:
- cap place queries per session (default 10), automatically switching to OSM beyond the limit;
- annotate the evidence chain with `[实时API:hbcli-anything@ts]` (M3 Anything main path); only after M4 scale-up do `[实时API:hbcli-place@ts]` (Google Place paid source) and `[实时API:osm-nominatim@ts]` (OSM backstop) appear.

**Why dual-track (OSM backstop)**: quotas/credentials are uncontrollable during the seed-user phase; Nominatim/Overpass are free with no key (same choice as TREK), and although the data is thin (no ratings/photos), coordinates/names/categories are usable — consistent with the "at least one free source per domain" principle.

---

## 5. TREK Reference (liketrek/TREK, 12.6k★, AGPL-3.0 — Design Reference Only, Zero Code Copied)

TREK is a self-hosted collaborative travel planner with the most mature data layer. Patterns worth borrowing:

| Domain | TREK's approach | GoTry adoption |
|---|---|---|
| POI search | M3 uses hotel-be Anything (enterprise-grade); M4 scale-up Google Places (with key) + OSM backstop; map exploration is OSM-only by design | ✅ M3: DONE (Anything main path; OSM only as the backstop's backstop in M4); design principles align with TREK |
| Weather | Open-Meteo (free, no key; 16-day forecast + historical climate fallback), WMO code mapping | ✅ Integrated the same at the end of M3; historical climate serves as the data foundation for seasonality recommendations (replacing LLM common sense) |
| Geography | bundled GeoJSON atlas (admin0/admin1, script-built, offline-capable) | ✅ M4: the "places I've been" map page reuses this pattern |
| Booking import | KDE Itinerary (parses flight/hotel confirmations from email/PDF) | ⏸ M5 (import needs arise only after transactions); gotry's bookedResources anchors can consume this |
| AI integration | MCP server exposes places/weather tools (with scopes/permissions) | ✅ Already isomorphic — gotry goes through the dsh plugin tool surface, essentially the same pattern as MCP |
| Security | All external fetches pass through an SSRF guard | ✅ Adopted into the capability-layer contract (external URLs must pass checks) |

**Not adopted**: TREK's collaboration/multi-user/budget-splitting features (outside gotry's M3–M5 scope); its AGPL-3.0 license means **zero code copying** (design reference only; the master outline's "neither rewrite nor copy" discipline).

### agent-reach 100% follow → wrapper-ification (landed 2026-08-23; refactored after the founder's 2026-08-22 correction that "a wrapper is not a router")

**Panniantong/Agent-Reach v1.5.0** (MIT, 74k★) is an installer + doctor + routing knowledge (SKILL.md); actual reading is done by upstream tools. GoTry follows it 100%:

- **CLI really installed**: `.venv/` (python3.11 venv, single consolidated venv) installs upstream `agent-reach` v1.5.0 → `agent-reach doctor` actually runs (4/15 channels ready)
- **Wrapper-ification (refactored 2026-08-22)**: deleted a 300-line, 13-channel switch — channel enumeration/method selection/setup text duplicated the upstream registry and had measurably drifted (gotry used exa/xhs; upstream's real names are exa_search/xiaohongshu). Three-layer division:
  - Knowledge → upstream (the `agent_reach.channels` registry + `Channel.check()` verbatim text + guides/); decisions → dsh LLM (for unknown channels/methods, return the upstream self-description list and let the LLM self-correct); plumbing → gotry (spawn/timeout/never throw/evidence chain)
  - `ts/capabilities/agent-reach-bridge.py`: a generic reflection bridge; `get_channel()`+`getattr()` directly invoke the upstream python API (web.read / v2ex.get_hot_topics / xueqiu.get_stock_quote ...); adding channels upstream requires zero changes here
  - `ts/capabilities/agent-reach.ts`: a thin shell; needs-setup text passes `check()`'s verbatim wording through without paraphrasing; CLI-tool-type channels (github→gh / subtitles→yt-dlp) still use dedicated tools as the execution surface
- **dsh tools**: `gotry_agent_reach` (action=status runs the real doctor / action=reach reflectively invokes `<channel>.<method>`) + dedicated tools web_search/video_subtitle/github_search
- **Evidence chain**: `[agent-reach:<channel>.<method>@<ts>]` enters the L4 contract

## 6. Evidence-Chain Annotation Contract (L4 Invariant Implementation Details)

| Annotation | Semantics | Trigger |
|---|---|---|
| `[实时API:hbcli@<ISO ts>]` | hotel-be realtime (hotel inventory; will include place) | hbcli exit code 0 |
| `[实时API:hbcli-place@<ts>]` | **M4 scale-up path**: Google Place via hbcli (paid source, quota-bound) | place query succeeded (placeholder; M3 actually uses `[实时API:hbcli-anything@ts]`) |
| `[实时API:osm-nominatim@<ts>]` | **M4 scale-up path**: OSM free backstop | hbcli failure/quota exceeded (placeholder; M3 same as above) |
| `[实时API:opensky@<ts>]` | Realtime flight observation (current ADS-B snapshot; OpenSky's anonymous path supports realtime only — historical queries need auth) | OpenSky hit |
| `[实时API:open-meteo@<ts>]` | Weather forecast (end of M3) | weather query succeeded |
| `[骨架:openflights]` | Three-valued viability (affirmative / hub-pair miss ≠ disproof / no conclusion outside hubs) | solve pre-filtering |
| `[静态包:估算]` | Estimate from public-channel research; must be verified before booking | all fallback paths |

Three-valued semantics (viability only): **a hit = strong affirmative; an empty hub-pair lookup = a down-ranking signal, never an exclusion (a stale skeleton would cause false kills); outside the hub set = no conclusion**.

Resilience cross-cutting landed (2026-08-29, issue #16 adopted / ADR-18): retry/circuit-breaking/pacing for external channels is no longer duplicated per capability — the effect interpreter `effect_interpreter.v1` (`ts/capabilities/effect.ts`, design doc `design/effect-interpreter.md`) executes uniformly per a per-effect policy table: retries only recognize transient failures (**Sentinel rate-limiting is never retried**); the SESSION channel is never retried and never circuit-broken (risk-control red line; governance lives in the pacing gate + authorization gate); the interpreter layer's cross-cutting evidence `[效应:<NAME>@<ts>]` coexists with the channel evidence chains in the table above (channel annotations unchanged; the interpreter layer only records attempts/backoff/breaker and rejection surfaces). The external-dependency surface of all 23 tools has fully converged (issue #115, 2026-09-04).

Bookable-fact ledgering contract (2026-08-30, issue #46/ADR-19):
- flyai/session flight/train **exact-date** search results (hits and misses) are recorded line by line into the `<stateRoot>/gotry-state/bookable-facts.jsonl` sidecar (`gotry_bookable_fact.v1`: query_id is replayable, IATA-normalized; the four tiers live_inventory/route_exists/historical_schedule/benchmark_price are never merged); bookable claims in deliverables must trace back to sidecar entries.
- `gotry_fact_gate` reverse-extracts markdown claims and reconciles them one by one; an exact-date miss whose route+date gets filled with a flight number/schedule = a not_in_source violation (deliverable blocked); policy statements are only allowed in the form "as of YYYY-MM-DD" + a review date; conflicts may never receive ✓; connections only with protected_connection=true.

---

## 7. Evolution (Aligned with the Roadmap; This Document Lists Only the Data Side)

- **End of M3 (historical node, within 2026-08)**:
  - Open-Meteo integrated ✅ (`capabilities/weather.ts` + `gotry_weather_check`); OpenSky mounted on the plugin tool surface ✅ (`capabilities/opensky.ts` + `gotry_flight_verify`).
  - **LLM price table v2 + price-drift long-term mechanism (2026-08-30, issue #49)**: `ts/data/llm-price-table.json` is provider-aware (DeepSeek tiered_peak_offpeak + MiniMax flat_no_offpeak; MiniMax M2/M2.1/M3 added to the table); ADR-11 "peak only-high-not-low" is the single truth; unknown model → fail-closed, never guess prices; `ts/scripts/price-drift-watch.ts` covers the four vendors DeepSeek/MiniMax/OpenAI/Anthropic; by default it compares offline against the baseline fixture and outputs a PR-ready Markdown diff; `--fetch` pulls the official pages; **prices are never auto-applied** (they go through PR + human review); run-all §41.
- **M4 (current)**: see the M4 node in `roadmap.md`; data-side additions = FlyAI official channel integration + session data plane P1 (extension bridge PRIMARY) + policy-fact producer v1 (#141); §7 lists only **data-source-plane** increments — product/UI increments are governed by `roadmap.md`.
- **M4 current engineering remainder**:
  - **#341 ground-transfer first slice**: explicit coordinates + `mode=driving` enter the deterministic planner adapter via the registered public `map_driving_route`; only the static `taxi` transfer receives route minutes; `bus`/`bus_plus_taxi`, provider miss/error, stale-recheck failure, invalid coordinates, and unsupported modes keep static minutes/prices and are annotated `[静态包:估算]`. Stale cache is re-queried first; does not cover one-off live OSRM, realtime traffic, transit/rail/fare, or address resolution.
  - Rail/transit, fares, live traffic, and non-explicit coordinate resolution beyond the first slice remain follow-up boundaries of #341.
- **Trigger-deferred remainder**:
  - **#345 three-repo gate**: the GoTry-specific paid Place/reviews chain — the hotel-be `search` module adds a place OpenAPI endpoint (delegating to geography, with quota caps); hotel-be `geography` adds `SearchPlace`/`GetPlaceReviews` to the `InternalExposedMethods` whitelist; hotelbyte-cli adds `search place` / `search place-reviews` commands + `--json`; the GoTry side adds `capabilities/place.ts` (hbcliPlaceSearch, falls back to OSM Nominatim on failure). **Trigger = first review/photo pull need** (founder + usage) — the gate stays closed until triggered; only then do the three repos move. #276 = the scaling path for hotel-be's internal `SearchSrv` at M4 scale; it is **independent** of the #345 three-repo gate and must not be merged with it.
  - **#342 bundled GeoJSON atlas** (script-built, offline); trigger = offline-first requirement.
  - **#344 multi-currency FX**; trigger = first real non-CNY booking (the China-outbound launch currently relies on the CNY settlement path).
- **M5**: fare path = FlyAI + session (extension bridge) cross-validation; aviationstack is no longer on the path (the free tier + official APIs already cover the original goal); KDE Itinerary-style booking import (bookedResources data source).

---

## 8. Due Diligence on Official Agent Channels and the Session Surface (since 2026-08-28, RFC `rfc/user-session-data-rfc.md` P0)

### Fliggy FlyAI (`@fly-ai/flyai-cli`, MIT, runs directly via npx; verified with no key and no login)

- All 8 tools are read-only: `search-flight` / `search-train` / `search-hotel` / `search-poi` / `keyword-search` / `ai-search` / Marriott×2; booking is completed by jumping to Fliggy via the in-result `jumpUrl` — **transactions never enter the skill; this is isomorphic to the WriteGate philosophy**.
- Hands-on test (2026-08-28, local machine): Shanghai→Lijiang flight on 2026-10-01 — Spring Airlines 9C6617 Pudong 17:05→Sanyi 20:50 ¥1790 and other structured journeys/segments/ticketPrice JSON; Shanghai→Dali train ticket — Hongqiao 10:00 G201 second-class →Kunming South→Dali 22:47 connection chain.
- Single-line JSON on stdout, agent-native (same shape as hbcli). **Significance: the official free channel for flight schedules/fares and rail search is now open — the real gap on the user-session surface shrinks to "Ctrip C-side cross-validation + Meituan (美团) local"; the 12306 session requirement (G8) is greatly weakened**.
- Unknown: pricing/quota/enterprise threshold (not disclosed in the README; `FLYAI_API_KEY` is an optional enhancement). Integration form: `capabilities/flyai.ts` **already landed (P1, 2026-08-28)** — a spawn-CLI plumbing layer; session-tests section F has live assertions.
- **Rate-limit test (afternoon of 2026-08-28)**: after high-frequency calls it returns `SentinelBlockException by fly-ai-search` (CLI exit=0, stdout is non-business JSON) — the quota is undocumented and the recovery window is unknown; flyai.ts already folds this shape into a structured error (with a stdout excerpt), and tests/smoke treat "hit or sentinel fallback" as the two legal terminal states. **2026-08-29 gap fix (Issue #24)**: this rate-limit output is valid JSON and was previously swallowed into a 0/0 silent miss via `data?.itemList ?? []` — it is now discriminated by shape (no `data.itemList` means error); offline regression in run-all §7b; the tool-layer summary has three branches (hit/miss/error) plus an explicit prompt for past dates.

### Session Data Plane P1 (RFC §4, 2026-08-28)

- `capabilities/session-search.ts` + `session/{transport,read-guard,adapters/ctrip-flight}` landed — ReadGuard (method×URL two-factor + camelCase compound write verbs; write requests physically aborted + audited; fail-closed) + Ctrip flight adapter (batchSearch sniffing → structured) + pacing gate (same site ≥30s); the new evidence-chain annotation `[会话:ctrip-flight@ts]` is in effect; run-all §24. Live session search requires headful mode (under headless, Ctrip returns only a shell page — verified).
- Login state is an existential prerequisite (founder correction, 2026-08-28): the persistent dedicated profile is demoted to testing/fallback (verified: nobody logs in from an anonymous window — History/Cookies both 0 rows); **2026-08-30 transport-layer decision (founder: "per-connection permission dialogs are simply unusable"): the extension bridge is promoted to PRIMARY** — `extension/` GoTry Session Bridge (MV3, one-time install; manifest pinned key = extension ID) passively sniffs the site's own requests in its own tab (the extension performs zero write actions); `session/extension-bridge.ts` is a loopback bridge (node:http, zero new dependencies, origin whitelist) with long-polling pairing; system dialogs 0 times per session; cookies are read name-only and the value discarded immediately; cdp is demoted to an explicit diagnostic fallback via `GOTRY_SESSION_TRANSPORT=cdp` (no silent fallback); run-all §38 is a fully offline contract.

### #21 Dual-Source Acceptance Contract (2026-08-29)

`session/benchmark.ts` freezes query/segments/journey type/per-segment times and numbers/currency/price/source/fetched_at/verdict into a field-level fixture scorer (missing fields count as errors; default ≥90%); dual-source alignment is judged by identical journey/segments/times/numbers, with price differences recorded independently and not required to be equal. `needs-attach`/`needs-login` return waiting-user no-spend; a challenge or ReadGuard blocked>0 immediately fail-closes; currently only sanitized fixtures are validated — everyday Chrome is not touched; real sf-01..08 still require permission confirmation and a CDP handshake.

### P3.7 Static Golden Vendor + Logged-in Real Runs (Issue #67, 2026-08-30)

- `ts/scripts/sf-live-benchmark.ts --golden=static` uses the versioned `ts/data/sf-static-routes.json`: route/carrier are taken from the ODbL pinned revision `4b969f8e91eb800c45f0e0e2355a0fbb93de27e4` of OpenFlights `routes.dat`, covering sf-01..08.
- OpenFlights contains no schedule/price/availability, so `departure_at`, `arrival_at`, `transport_number`, and `price` are estimated fields whose time/price bands come from `sf-golden-manifest.json`. Each evidence entry records both `requested_source=static` and the actual `effective_source`, and carries the route URL/revision/license, band source, and fallback reason.
- If snapshot reading/validation or route coverage fails, stderr explicitly reports `fallback=manual-golden` — silent source switching is refused; this vendor is a benchmark comparator and **cannot prove realtime schedules, realtime fares, or sellable inventory**. The provider-independent soft scorer and the CLI vendor closed set entered run-all §44.
- **Logged-in real runs**: sf-01..08 executed for two consecutive rounds with `requested_source=static`; effective was `static-openflights+manual-band` throughout; official scored 8/8 hits each round with `fallback_count=0`; the Ctrip session scored 3/8 and 5/8 hits respectively; all scorable hits across the two rounds (3+5 entries) achieved a soft score of 13/13=100%; non-hits were explicit misses. This denominator covers only session hits and cannot be extrapolated to 8/8 sellability.

### Boundary Hands-on Tests (2026-08-28/29)

- **Meituan**: an anonymous instance gets a straight **403** from hotel.meituan.com (headful, new profile) — the strongest anti-scraping of the three sites; login state is a 403-level hard prerequisite; the adapter skeleton has landed (`adapters/meituan-local.ts`: city pinyin table / login ticket allowlist / networkHint placeholders / a11y backstop `extractListings`); the real API shape will be backfilled once login state is ready. The a11y backstop extractor `session/extract.ts` and the golden query set `data/session-golden-20.json` (20 entries, append-only) landed in the same batch (run-all §26).
- **Ctrip flight XHR sniffing PoC** (`ts/scripts/session-attach-poc.ts`, playwright-core 1.62.1 + dedicated test profile): two real runs, both zero risk-control, zero interaction, read-only; the main search API has been identified: `flights.ctrip.com/international/search/api/search/batchSearch` (~550KB; domestic tickets go the same way) + `FlightIntlAndInlandLowestPriceSearch` low-price calendar (~81KB) — directly usable as networkHints for the P1 Ctrip adapter.
- **Dida supplier portal (implemented 2026-09-09, hotel-be portal integration migration line)**: employee login is completed by a human on Dida's official site via the hotel-be portal autofill springboard; gotry only passively sniffs `portal-webapi.dida.com/HotelPriceAPI/SearchRealTime|SearchMonitor` under the user's own Chrome login state (per the 2026-07 packet-capture caliber; the API name will be calibrated after the first real session — same boundary as D-13); parsing = flattening the SearchRealTime envelope plan by plan (`RoomTypeList`∪`RoomList`, `RatePlanID/Price/TotalPrice/Currency/Inventory/ReferenceNo`); until the SearchMonitor shape is captured, it is forwarded without guessing; the ticket cookie `CN_M_DidaTravel` is name-level only. SPA boundary: only requests spontaneously issued by the find page load can be sniffed; searches triggered by in-page clicks count as the user's own browsing behavior (zero-DOM-interaction invariant).
- **OTA flattening (2026-08-29; founder directive: "don't distinguish primary path / fallback path")**: the hierarchical wording "primary chain / cross-validation / three-level routing" was removed from tool descriptions and persona (19); **what is flattened is routing priority, not the L4 evidence-chain discipline** (per-source annotations must still reach the user).
- **Account authorization gate v2 (2026-08-29)**: the `tools/pre-execute` listener (`session-consent.ts`) pops an approval card on the first call per session per site for account-surface tools; allowed-once skips further prompts within the session; **denial = revocation for this session**; with no approval channel it fails closed; `sessionAccess: ask|allow|off` three states; the site whitelist = the current adapter registry (ctrip-flight + ctrip-hotel + train-12306). The Fliggy channel **does not pass through the gate** (anonymous, no user identity). session-tests §I + smoke §13.
- **Login productization (18th tool `gotry_session_login`, 2026-08-29)**: on `needs-login` the agent calls it directly — attach the user's Chrome, pop the login entry, and wait for the user to complete login on **Ctrip's official site**; **semantic red line: login always happens on the external website — gotry never collects/stores/transmits passwords, verification codes, or any cookie values**, reading only the existential fact of the ticket cookie name (session-tests §J3 value-non-leakage assertion). The login guidance page does not mount ReadGuard (transport `guard:false`, the only exempt surface): write interception would physically abort the user's own login POST (a loss for both privacy and reliability).
- **Testing discipline (2026-08-29, root-caused from founder feedback)**: routine regression **never automatically opens a browser window** — the session-tests live section defaults to SKIP; `GOTRY_SESSION_LIVE=1` is an explicit opt-in.
- **Human-machine co-governance tab discipline (2026-08-29, root-caused from the founder's "I simply can't see the login page")**: login guidance and session searches always `newPage` into **their own dedicated tab** (the login page is brought to front with `bringToFront`; `closeOwnPage=false` leaves it for the user), never hijacking the user's existing tabs; the search page closes its own page when done.
- **Not yet integrated (separate tick)**: Ctrip-hotel / Meituan-hotel session adapters — the login-state seam and Meituan's 403 hard prerequisite are unresolved; see above.
- **browser-use illusion clarified**: its isolated Chromium ≠ the user's desktop Chrome; it cannot install the target extension, so it is **explicitly not adopted** (a Python violation being the second reason).
- **Onboarding history**: the 5-step wizard from issue #21 P3.6 (2026-08-30) was withdrawn after the store launch on 2026-09-02 under "returning responsibilities" — installation goes back to the browser, rendering goes back to the dsh UI, and the wizard degrades to offline health-probe waiting; full text in `rfc/user-session-data-rfc.md` §3.3.
