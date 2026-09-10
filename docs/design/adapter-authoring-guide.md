[English](adapter-authoring-guide.md) | [简体中文](adapter-authoring-guide.zh-CN.md)

# Session Adapter Authoring Guide (D-13)

> Status: living (engineering handbook)
> Positioning: **the engineering handbook for whoever is onboarding a new site/new channel**. The adapter is this repo's extension unit for the tool ecosystem
> (`tool-orchestration-design.md` §5③): adding a site never touches the core — you only add "an adapter + a registry row + tests".
> Template = **the 12306 first-party calibration method** (empirically landed 2026-09-03: telecode table fully calibrated against the official station table for all 129 cities,
> seat-bucket index aligned; it once caught the Nanning NIZ→NNZ wrong code — see `capabilities/session/adapters/rail-12306.ts`).
> Related: `../data-sources.md` (data-source authority surface/site matrix), `../rfc/user-session-data-rfc.md` (session-plane RFC),
> `benchmark.ts` (double-source shape gate), run-all §38/§41.

## 0. One iron rule: adapters are **read-only** at the transport layer

The extension bridge (GoTry Session Bridge) never issues requests on a site's behalf — it only passively forwards **the site's own query responses**
(the `session-bridge.v1` job protocol); gotry never touches credentials/CAPTCHAs, and a challenge page means stop (`challenged`).
Any design that "sends the user's requests out for them" is overreach and is rejected at review.

## 1. The four-step method (12306 template)

### Step 1: Probe (discover the site's public query surface)

- Find the site's **public query interface** (12306 ticket-availability query, Ctrip (携程) hotel list page) — surfaces that need no login come first;
  logged-in surfaces go through the authorization gate (see §3 discipline 3).
- Distill the **NETWORK_HINTS vocabulary** (e.g. the `NETWORK_HINTS` in `ctrip-flight.ts`): the extension side uses it to decide
  "this response is a search result" (URL/field-name/hostname matching); the more accurate the vocabulary, the fewer false positives.
- Record **manually verified notes** on request parameters and response shape (provenance material for later fixtures).
- For site-specific vocabulary (telecodes/city ids/seat buckets), copy from the official site surface first and mark the `as_of` date.

### Step 2: First-party golden-standard fixture

- Measure once in a **real session** and freeze the response into a fixture, **traceable field by field**
  (following the fixture-meta idea of `ts/data/golden-trip-2027-facts.json`: source/capture time/audited value).
- Site-specific mappings are **checked in full against the official station table**, no sampling (this is exactly how the full 12306 telecode
  calibration over 129 cities caught NIZ→NNZ). Mapping constants go into the adapter (the `STATION_TELECODES` shape),
  verified item by item against the official station table, then frozen.
- Enumeration mappings (seat bucket `cN`→seat class, seat-type codes) are likewise checked item by item and locked into adapter constants.

### Step 3: Double-source shape gate

- Implement the site-result → `SessionComparableRecord` mapping (`benchmark.ts`, `session-double-source.v1`);
  required fields are listed in `REQUIRED_COMPARABLE_FIELDS`.
- Score the fixture with `scoreSessionFixture`: **field-level accuracy ≥ 0.9 is required for calibration to pass**
  (`SESSION_FIELD_ACCURACY_THRESHOLD`) — "looks right" does not count; only field-level correctness counts.
- Each of the eight-value verdict taxonomy (`hit/miss/error/challenged/cooldown/needs-login/needs-extension/…`)
  must have its judging rationale given one by one and one example each in tests; **transport failures never land negative facts** (ADR-19).

### Step 4: Drift lock

- Site-specific mappings become **anti-drift assertions** in tests (count assertions + sampled key-field assertions, e.g.
  "telecode table ≥129 cities and Nanning=NNZ"): a site redesign turns CI red instead of failing silently inside a user session.
- The fixture score ≥0.9 assertion goes into run-all (same family as the §38 extension bridge / §41 session-plane anchors).
- Facts that rot over time (policies/schedules) carry a `review_by` recheck gate (ADR-19 discipline).

## 2. New-adapter onboarding checklist (file level)

| Action | File |
|---|---|
| Adapter body (vocabulary/URL construction/response normalization) | `ts/capabilities/session/adapters/<site>.ts` |
| Effect registry: handler + policy-table row (after D-23: no policy-table row, no effect) | `ts/capabilities/effect.ts` (`DEFAULT_HANDLERS` + `SPECS`) |
| Channel registry row (id/intent/quota class/evidence level/setup) | `ts/capabilities/channel-registry.ts` (`CHANNELS`) |
| Tool branch or retrieval entry + verdict-taxonomy rendering | `ts/src/index.ts` |
| fixtures + scoring assertions + drift lock | `ts/scripts/session-*-tests.ts` / fixtures directory |
| Data-source matrix row + calibration record | `docs/data-sources.md` |

"Casually wiring in a channel" without a policy-table row/registry row is rejected at review: the channel health surface, routing advice,
and doctor rows are all generated from the registry; an off-table channel is invisible to the model and unauditable.

## 3. Discipline checklist (red lines, reviewed item by item)

1. **Read-only transport**: the extension never issues requests (§0 iron rule); adapters write no site state.
2. **Cadence gate**: two searches on the same site ≥30s apart (built into `session-search`); adapters must not bypass it.
3. **Authorization gate**: logged-in surfaces must pass the `sessionAccess` approval card (first card per session per site; a rejection
   revokes for the rest of that session); public query surfaces (12306) do not need it.
4. **Challenged means stop**: CAPTCHA/risk-control pages = the upstream said no; never retry (effect policy-table `retry: null`).
5. **Zero credential handling**: login stores only the read-only ticket cookie **names** (`LOGIN_COOKIE_NAMES`), never their values;
   login always happens on the site's official web page — `gotry_session_login` only guides and confirms.
6. **Masked-price fidelity**: upstream-masked prices (`priceRaw` "¥7xx") are preserved as-is and never zeroed out to fake a real price;
   a numeric price lands in a field only when the site states it explicitly (hotel facts carry no numeric price, D-26).
7. **Evidence chain annotated per source**: every result carries the same-style evidence `[会话:<site>@ts]`; negative facts and errors
   are stated separately — never merged into "no results or failure".
8. **Effect-registry discipline**: backoff/breaker policy rows are decided explicitly one by one (pass-through surfaces never retry;
   only timeout-class failures may retry).

## 4. Ctrip (携程) interface-surface real-session calibration checklist (D-13 leftover; execution depends on founder login; public tracking = #272)

> Prerequisite: `scripts/session-login.ts` completes the real Ctrip login (and logs into Meituan (美团) in the same window) — that founder
> action is attached to the user todo of `gotry-session-data-goal`; run the calibration in the same window as it.

- [ ] **ctrip-flight**: compare the `batchSearch` response shape field by field against the fixture (field names/price fields/
  timezone of times); double-source score ≥0.9.
- [ ] **ctrip-hotel**: verify the list-page `cityId` code-table expansion (coverage spot-checks for cities outside the code table via
  web-search guidance); regression on the `roomInfo[].priceInfo.price` path (2026-09-03 first-party calibration a0cd1ad).
- [ ] **meituan-local** (homestays/attraction tickets): after login, live-test NETWORK_HINTS + calibrate breaker cooldown parameters
  (gotry-session-data-goal P2 item).
- [ ] **Golden-standard 20-query batch run** (grouping per `ts/data/session-golden-20.json`): 8 sf (`flight`,
  sf-01..sf-08) + 8 mt (4 `meituan-hotel` mt-01..mt-04 + 4 `meituan-minsu` mt-05..mt-08)
  + 4 fa (2 `flyai-flight` fa-01..fa-02 + 2 `flyai-train` fa-03..fa-04); historical live results for sf-01..08 are in
  `../data-sources.md` (field-level ≥90% and live <15s remain the unified recheck gate — RFC acceptance criteria).
- [ ] **Cookie ticket name-list calibration**: after logging in on both sides, verify `LOGIN_COOKIE_NAMES` full coverage and zero false positives.
- [ ] Write calibration conclusions back to `../data-sources.md` (domain matrix row).

## 5. References: existing exemplars

- **rail-12306.ts**: the telecode/seat-bucket first-party calibration template (source of this guide's four-step method).
- **ctrip-flight.ts / ctrip-hotel.ts**: NETWORK_HINTS + logged-in surface + authorization-gate exemplars.
- **meituan-local.ts**: half-finished skeleton (a11y fallback direction, pending logged-in live testing).
- **session/benchmark.ts**: the double-source shape gate's scorer and threshold.
