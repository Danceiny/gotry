[English](user-session-data-rfc.md) | [简体中文](user-session-data-rfc.zh-CN.md)

# User-Session Data Plane RFC: Filling OTA Retrieval with the User's Own Account Sessions (Chartered)

> Status: **accepted** (G7/G8/G9 were settled on 2026-08-28: G7 chartered, G8 deferred, G9 approved; P0 completed the same day, see §5 for details)
> Positioning: **a data-source extension proposal under "official channels first, user sessions fill the gaps"** — answering "if we do not integrate each OTA's API, where does retrieval data come from?".
> Upstream: the master-outline reuse matrix (`../gotry-master-outline.md` §2 — this RFC is that revision proposal, the "amend the master outline before breaking ground" one) + `../data-sources.md` (the single authoritative surface for data sources; a fifth layer is added upon adoption).
> Research window: 2025 H2 – 2026-08-28 (four tracks: engineering patterns / GUI agent capability / compliance / product precedents; two subagent tracks died and were completed by the main session; sources in the appendix).
> This document covers the data plane only; transactions (booking/payment) remain in M5 WriteGate territory. **This RFC contains no write path.**

---

## 0. Summary and decision request

**Conclusion first**: "read-only retrieval using the user's own logged-in state" is **feasible under the engineering and compliance realities of 2026, but it must land on four principles: "official channels first, sessions fill the gaps, read-only with physical isolation, data never leaves this machine"**. Retrieval-style browser tasks have entered the sweet spot of top models (WebVoyager-class ~88%); the DOM/a11y-first hybrid architecture has clear industry consensus; a single on-site search can be compressed to seconds-level latency / two-cents-level cost. The real risk is not technical: ① platform risk control countering automation frequency, ② the boundary of "operator scraping" under Chinese law, ③ prompt injection (backstopped by read-only + physical interception). The research also found that **domestic official channels really did open in 2025-2026** (Fliggy (飞猪) FlyAI / Ctrip (携程) Business Travel MCP / Amap (高德) MCP) — consume the official free channels first; user sessions only fill the seams official channels cannot cover (the Ctrip consumer side, Meituan (美团) local, 12306).

**Three questions for the founder to decide** (details in the §5 decision gates; **settled on 2026-08-28**: founder directive "manage this project with loopx and start implementing"):

| # | Question | Recommendation | Decision |
|---|---|---|---|
| **G7** | Whether to charter the user-session data plane (an M4 increment, not crowding the M4 mainline memory domain) | **Charter; proceed through the four phases of §4** | ✅ **Chartered** (loopx goal `gotry-session-data-goal`, agent `gotry-session-builder`; P0 completed the same day, see §4) |
| **G8** | Whether to include 12306 in the first batch of site adapters | **Not for now** (the fiercest history of platform confrontation; criminal case law is concentrated on the ticket-grabbing write side; hold a separate charter review once the Ctrip/Meituan pipelines are stable) | ✅ **Deferred per recommendation** — moreover, P0 live testing showed the Fliggy FlyAI `search-train` official channel covers train-ticket retrieval (real data on the Shanghai→Dali transfer itinerary), further weakening the 12306 session need; the precondition for reopening the review becomes "a capability gap appearing on the FlyAI train-ticket side" |
| **G9** | Official-channel due diligence first: apply for the Fliggy FlyAI key + Amap MCP key | **Approve the application actions** (zero cost; determines the real size of the session-plane gap) | ✅ **Approved and executed**: FlyAI **works in live testing without a key** (8 tools, all read-only, real flight/train data; the key is an optional enhancement and the application entry point is undisclosed); the Amap acquisition steps are recorded in `../tokens.md` (to be configured as soon as the founder provides the key) |

---

## 1. Problem: where exactly is the data gap (a projection of data-sources.md §2)

| Domain | Current state | Nature of the gap |
|---|---|---|
| Flight schedules/fares | static package (2026-07 research); OpenSky covers only ADS-B of aircraft "already in the air" | **no real-time fares or schedules** — when a user asks "how much is Beijing-Dali for the October holiday", we can only answer with an estimate |
| Rail (12306) | ❌ none | no open API; the official side has always been hard-line toward third parties |
| Ctrip consumer / Meituan local inventory | the hbcli bridge covers only the hotel-be domain | Meituan homestays/attraction tickets and Ctrip first-party packaged products have no source |
| Hotels | hbcli real-time (degraded while its certificate is expired) | a primary path exists; the session plane is backup, not the main force |

Core judgment: **GoTry is a "feasibility engine + evidence chain" product; missing real-time quotes/schedules directly hurts the M3 exit metric (finalization rate) and the M5 transaction loop**. Before M5 there is no commercial supply chain, and official self-serve APIs (Amadeus is shut down and not coming back) cover China's domestic market weakly — "the user's own account" is currently the only real-time source with zero business cost.

---

## 2. Industry best practices (research conclusions, 2025H2–2026-08)

### 2.1 Capability: retrieval tasks are in the sweet spot; transactional tasks remain untrustworthy

- WebVoyager (live web retrieval) top tier: Gemini 2.5 Computer Use 88.9% (2025-10 model card), OpenAI CUA 87.0%; Online-Mind2Web: UI-TARS-2 88.2% (2025-09). **Retrieval/navigation ~85-90%; transactional tasks involving state changes drop to 50-65%** (WebArena CUA 58.1%).
- The 2026 generation is still cashing in quickly (OSWorld: 42%→61% in 4 months; on OSWorld 2.0, Opus 5 / GPT-5.6 already at 60-70% with figures varying by source, not fully confirmed) — **the architecture must be model-swappable, tied to no single vendor**.
- Chinese OTA sites are more complex than the English benchmarks; estimate at 70-80% of these numbers.

### 2.2 Technical route: three session-reuse channels, the extension bridge as PRIMARY

| Channel | Mechanism | 2026 status | Decision |
|---|---|---|---|
| A. Attach the user's daily Chrome | since Chrome 136 (2025-05) the default profile blocks the debug port; Chrome 144+ restored the official path (`chrome://inspect/#remote-debugging`, enabled manually once) | requires the user's Chrome ≥144 + manually flipping the switch; only one debug client at a time | **⚠ Downgraded to explicit fallback (2026-08-30 founder ruling)**: chrome-devtools-mcp #825 confirmed Chrome 144+ **pops a browser permission dialog on every connection with no persistent approval**; per-connection popups are unusable (founder: "the authorization actions are too frequent — completely unusable"). `GOTRY_SESSION_TRANSPORT=cdp` remains an explicit opt-in for diagnostics/testing; no more automatic fallback |
| B. Dedicated persistent profile | Playwright `launchPersistentContext` (can use the user's installed Chrome, zero browser downloads); log in once, reused across sessions | playwright-mcp's default mode, the most mature | **Testing/fallback only** (live testing shows nobody logs in on an anonymous bare window; founder: "no anonymous instances") |
| C. **Extension takeover** | **MV3 extension + local bridge**: one-time install; the extension passively sniffs, in **its own tabs**, the retrieval responses the sites themselves emit (zero write behavior in the extension) and returns them to Node via `127.0.0.1` long polling; no `chrome.debugger` (no warning bar) | gotry's in-house `extension/` (GoTry Session Bridge, 4 files, zero build, manifest fixed key = stable extension ID across machines) + Node-side `session/extension-bridge.ts` (`node:http` long-polling bridge, zero new dependencies; origin allowlist) | **✅ PRIMARY (2026-08-30 founder ruling, issue #21)**: system dialogs drop from "1 per connection" to **0**; the authorization model = one-time install (~30 seconds) + manifest-key-derived fixed ID origin allowlist + the in-session consent gate unchanged; the `needs-extension` verdict is a waiting no-spend user gate |

Explicitly not doing: direct reads of the cookie disk store (Chrome App-Bound Encryption has sealed it off), cloud session services (Browserbase Contexts/Steel Profiles — credentials leave this machine, violating local-first and the red lines), **the browser-use ecosystem (Python — violates the zero-Python-dependency discipline; the TS port on npm is unofficial and unverified)**, and LaVague (unmaintained since 2025-01). A **native messaging host** (the extension launches a local process via the OS registry; stronger pairing) is listed as a phase-2 alternative: the install surface is heavier (it requires writing the NativeMessagingHosts registry), and the current "loopback + origin allowlist + fixed extension ID" already covers the single-user local threat model; recorded among the §5 risk-review triggers.

Risk-control exposure: attaching a real session = the user's real fingerprint, the smallest possible exposure; Playwright's native driver has structural leaks (automatic Runtime.enable calls and the like, which rebrowser-patches/Patchright are fixing) — **a dedicated profile + the user's manual first login + read-only + human-speed cadence** is the industry-standard combination; there is no need to introduce the stealth family (the puppeteer stealth plugin died in 2023-03). **Never automatically bypass captchas/sliders** — stop on detection and hand back to the user; this is also the compliance lifeline (see 2.4).

### 2.3 Extraction and maintenance: three-tier degradation, XHR sniffing is the hidden trump card for retrieval

Industry consensus: **DOM/a11y first (cheap, fast, deterministic), vision as fallback (new sites / anti-scraping obfuscation / canvas), screenshots only for result verification**. A pure computer-use screenshot pipeline is overkill for retrieval scenarios (2-5s/step vs a11y <100ms/step).

```
① XHR/fetch in-page sniffing (preferred) — the requests are sent by the site itself; read the responses only;
   the JSON structure is an order of magnitude more stable than the DOM and immune to UI redesigns (only API changes hurt)
   precedent: the 12306 leftTicket/query* JSON has been used by the open-source ecosystem for years
② a11y snapshot + structured extraction (when the site has no clean JSON; a Zod schema constrains the output)
③ vision-model fallback (long tail / redesign windows; only when ① and ② fail)
Anti-pattern red line: never forge/replay on-site APIs outside the page context (you hit signature + device-fingerprint checks, and this is the most heavily prosecuted zone of "bypassing anti-scraping")
```

Playbook maintenance: build a lightweight local **action cache + invalidation fallback** (a localization of Stagehand's cloud-cache idea: key = instruction + DOM fingerprint → deterministic locator; on a miss, fall back to LLM re-location and write back; "a wrong cached click is worse than a slow one"). Stagehand v4's cache/self-heal is available only on the Browserbase cloud, so it must be built locally — this is exactly gotry's in-house increment. OTA result pages are the highest-frequency A/B iteration surface; XHR sniffing moves the maintenance surface from "UI redesigns" down to "API changes".

### 2.4 Compliance: a threefold boundary (engineering research, not legal advice)

**US/EU**: the hiQ v. LinkedIn endgame — a win on the CFAA front (scraping public data does not constitute "unauthorized access"), but a 2022-12 settlement and hiQ permanently stopping scraping: **won the legal principle, lost the business**. Ryanair v. Booking.com: in 2024-07 a Delaware jury found Booking violated the CFAA; in 2025-01 the judge's JMOL **overturned the jury verdict** — the route of platforms wielding the CFAA against scraping was pushed back, but the Ryanair lineage (Ireland/Germany injunctions; CJEU PR Aviation 2015 allowing ToS-based restrictions) shows the OTAs'/airlines' litigation will is extremely strong. Air Canada v. Seats.aero: the 2024-03 preliminary injunction was denied, with an antitrust counterclaim in 2025 — but that case was **centralized, large-scale scraping of 265,000 records**, fundamentally different from GoTry's distributed model of "each user on their own machine, their own session, echoing back only their own data" — which is exactly our design defense point.

**China** (the launch market, the most important): the Interim Provisions on Anti-Unfair Competition on the Network §19 (effective 2024-09, absorbed into the anti-unfair-competition law revision draft) prohibit "using technical means to illegally obtain or use data legally held by other operators" — the regulatory target is **data shuttling and competitive use between operators** (case law of the Dianping (大众点评) v. Baidu type); GoTry's "retrieval results echo back only the user themself, no shared pooled repository, data never leaves this machine" deliberately stays outside that provision's range. All public criminal cases under the red line (the crime of illegally obtaining computer information system data) share the same features: **bypassing anti-scraping measures (forged device_id / cracked verification) + profit motive (proxy ticket-grabbing / selling tools)** — the 2025-08 Shanghai Jing'an 12306 proxy-ticket-grabbing case, the Ding case, the Damai case, and the Shengpin case, without exception.

On the PIPL side, "a user entrusting the processing of their own data" has clear room; the required elements are explicit authorization + minimization + revocability. **Four compliance pillars (into code, not into slides): ① read-only, zero writes; ② never bypass any anti-scraping measure (a captcha appearing = stop + hand back to the user); ③ retrieval results never enter any shared storage (experience backflow returns only "assertion-level conclusions" and only desensitized, see §3.6); ④ explicit user authorization + site allowlist + switchable off at any time.**

### 2.5 Competition and alternatives: official channels opened in China in 2025-2026

- **Fliggy FlyAI open platform** (flyai.open.fliggy.com; CLI `@fly-ai/flyai-cli`, skill repo `alibaba-flyai/flyai-skill`): flights/hotels/attractions/vacations, all scenarios, "real-time direct connection to the official product catalog".
  - **P0 live testing (2026-08-28, no key, no login)**: 8 tools, all read-only (search-flight/search-train/search-hotel/search-poi/keyword/ai/Marriott×2, no booking primitives whatsoever; transactions go through jumpUrl to Fliggy and are completed by a human); `search-flight --origin 上海 --destination 丽江 --dep-date 2026-10-01` returns structured journeys/segments/ticketPrice (Spring Airlines 9C6617 from ¥1790); `search-train` returns a real transfer itinerary (Hongqiao G201→Kunming South→Dali).
  - Single-line JSON stdout, agent-native (the same shape as hbcli); pricing/quota/thresholds are not disclosed in the README; the key is an optional enhancement.
- Ctrip Business Travel MCP (enterprise AI integration, business-travel domain); Amap MCP Server (POI/maps/routes, integrated with Tongyi Lingma (通义灵码)/TRAE, free quota) — Amap can immediately strengthen gotry's existing map surface.
- The mileage-tools precedent as a cautionary tale: AwardWallet was blocked by American Airlines and airlines widely added 2FA walls — **platform technical countermeasures are the norm; every single channel must be designed as "severable"**.

**Conclusion: the data-plane ordering = official free channels (hbcli/Fliggy FlyAI/Amap MCP/OpenSky/Open-Meteo) → user-session gap-filling (the Ctrip consumer side/Meituan/future 12306) → static-package fallback**. User sessions are a bridge, not the endgame; the endgame is the M5 supply chain or the full opening of official agent channels.

### 2.6 Security: prompt injection cannot be fully solved; read-only is the only fallback

The Comet incident (disclosed by Brave in 2025-08: an injection hidden in Reddit comments → cross-site account takeover) proved SOP/CORS fail against agentic browsers; the Anthropic red team: injection success rate 23.6%→11.2% (with defenses); OpenAI officially admitted it is " unlikely to ever be fully solved". **The countermeasure is not a better model; it is a smaller blast radius**: a read-only allowlisted action set + physical interception of transaction endpoints at the transport layer + untrusted tagging of page content before it enters the model + structured task intent (site + query terms + fields) with abort on deviation. gotry's WriteGate red line is fulfilled here ahead of time as **ReadGuard** (see §3.4).

---

## 3. Solution: the five-layer data plane and user-session capability design

### 3.1 Data-source layer promotion (data-sources.md becomes five layers upon adoption)

```
static package → free real-time (OpenSky/Open-Meteo) → hbcli bridge (hotel-be) → 【NEW】official agent channels (Fliggy FlyAI/Amap MCP) → 【NEW】user-session gap-filling
```

Domain-matrix delta (revised after P0 — **flight/rail primary paths move to the FlyAI official channel; the session plane contracts to cross-validation and official blind spots**):

| Domain | Primary path (after P0) | Session-plane action | Evidence-chain annotation |
|---|---|---|---|
| Flight schedules/fares | **FlyAI `search-flight` (official, no key)**; OpenSky observation; static-package reconciliation | sniff the Ctrip flight page and **cross-validate** against FlyAI (a natural reconciliation oracle from P1: dual-source same-query consistency assertions) | `[实时API:flyai@ts]` / `[会话:ctrip-flight@ts]` |
| Rail 12306 | **FlyAI `search-train` (official; the anonymous trial quota is shared and easily rate-limited, erratum 2026-09-02)** | **Implemented (2026-09-03)**: passive sniffing of the kyfw leftTicket background tab (remaining tickets/schedules/durations; the list API has no fares and presents that as-is); the public query surface has no login gate; telecode and seat-bucket index **first-party calibration complete** (2026-09-03, official station_name.js 129 cities + the queryLeftTicket cN conversion function, locked by snapshot anti-drift tests; previously caught the Nanning NIZ→NNZ wrong code) | `[实时API:flyai@ts]` / `[会话:train-12306@ts]` |
| Meituan local (homestays/attraction tickets) | ❌ no official channel (blind spot) | on-site search sniffing | `[会话:meituan@ts]` |
| Hotels | hbcli (hotel-be) + FlyAI `search-hotel` (trial quota shared and easily rate-limited, erratum 2026-09-02) | **Implemented (2026-09-03)**: passive sniffing of the hotels.ctrip.com background tab (URL hint + shape-signature fallback), real prices under the user's own logged-in state; the city-code table calibrated by live tests across 35 cities (2026-09-03, verified item-by-item against page titles; Dubai=220, etc.); the API path unilaterally confirmed (restapi/soa2/34951/fetchHotelList); the price-field path awaits final verification with the first real session | `[实时API:hbcli@ts]` / `[实时API:flyai@ts]` / `[会话:ctrip-hotel@ts]` |

New annotation semantics (an L4 contract addition): `[会话:site@ts]` = **real-time search within the user's own session, not an official API; prices/inventory follow the site's pages** — a three-way split from `[实时API]`/`[静态包:估算]`, same freshness as real-time, lower authority than an official API (query results that have hit a slider must be tagged `degraded`).

### 3.2 Code shape (aligned with the existing layering)

```
ts/capabilities/flyai.ts            official channel: a new P0 priority — spawn @fly-ai/flyai-cli (npx), wire search-flight/search-train first,
                                     pipeline layer aligned with the agent-reach pattern (timeout / never throw / evidence chain); lands in P1 in the same batch as the session skeleton
                                     【2026-08-29 second batch implemented: kind=flight|train|hotel — search-hotel wired (masked price
                                     priceRaw preserved; the real price is completed by a human via detailUrl), the OTA tool surface flattened (no primary / degraded routing)】
ts/capabilities/session-search.ts    session-plane transport orchestration: lane selection (extension default / cdp explicit / persistent test) → navigate → sniff
                                     → extract → guard → evidence chain; resolveTransportMode pure function
ts/capabilities/session/
  extension-bridge.ts  local bridge (2026-08-30, zero new dependencies): node:http lazy singleton, bound to 127.0.0.1 only, port pool 8791-8795
                       (one-to-one with manifest host_permissions); origin allowlist (fixed extension ID); /jobs long polling
                       (hold ≤20s < the MV3 SW 30s survival window) / /results replies (≤8MB) / /health heartbeat / /status diagnostics;
                       queued+inFlight dual tables (migrate on pickup; replies routed by jobId); parked jobs dispatched immediately (a new job skips the one-polling-cycle wait)
  extension-channel.ts lane client: three job wrappers — cookie-names (ticket **names**; no value field in the protocol) / open-login (foregrounded, left to the user) /
                       search (passive sniffing reply); classifyBridgeFailure pure function (only extension-not-connected
                       is a user gate → needs-extension; everything else degrades to error)
  transport.ts         CDPAttachTransport (cdp explicit opt-in fallback: DevToolsActivePort discovery + puppeteer-core
                       connect; Chrome 144+ pops a permission dialog per connection — hence the downgrade); persistent = test-isolated profile
  read-guard.ts        ReadGuard (CDP lane): network-layer write-request interception + a DOM submit-button deny-list, fail-closed, full audit log
  adapters/<site>.ts  site adapter: { entry, searchForm locators, networkHints[{urlPattern,parser}], a11yFallback, cooldown }
                      the first adapter = Ctrip flights (the PoC already identified networkHints: search/batchSearch + FlightIntlAndInlandLowestPriceSearch)
  action-cache.ts     local action cache: key = instruction + DOM fingerprint → deterministic locator; on a miss, fall back to LLM re-location and write back
extension/             GoTry Session Bridge (MV3, zero build): manifest (fixed key) / background.js (long-polling SW:
                       search background tab + closing its own page on wrap-up / open-login foregrounds and leaves the tab to the user / cookie-names takes names only and discards values) /
                       content-main.js (MAIN world hook of fetch/XHR; a NETWORK_HINTS hit → CustomEvent) /
                       content-bridge.js (ISOLATED world, CustomEvent↔chrome.runtime)
ts/src/index.ts       the new dsh tool gotry_session_search(site, query, dateSlots) → flat envelope (isomorphic to ADR-13)
```

Dependencies: the transport layer itself has **zero new dependencies** (extension = pure JS, zero build; bridge = hand-written node:http, no ws — the MV3 SW stays alive on the ≤20s long-polling rhythm; HTTP suffices; the publish-preverify dependency-declaration gate also forbids sneaking in transitive dependencies); the cdp fallback lane keeps puppeteer-core as an optional dependency (graceful degradation via dynamic import when the package is absent).

### 3.3 Onboarding UX and distribution channels (finalized after the 2026-09-02 store listing)

**Responsibility hand-back**: the LLM is managed by dsh, extension installation by the browser store, CLI bootstrap by `gotry setup`. The earlier 5-step wizard of "3 clicks + 0 terminal commands" was withdrawn after the 2026-09-02 store listing because it overstepped into browser management (`open` popups, `pbcopy` hijacking the clipboard, `osascript/zenity` seizing the GUI) and into dsh's rendering layer (a stdout text wall instead of a verdict).

**Current shape**:

- **Installation is the browser's job**: the user goes to the [Chrome Web Store](https://chromewebstore.google.com/detail/gotry-session-bridge/oeajpiccmonococjcegddlooeeohlbgd) and clicks "Add to Chrome" (listed 2026-09-02; 0 terminal commands, 0 gotry CLI involvement); auto-updates belong to the store.
- **Rendering is dsh UI's job**: `sessionFlightSearch` / `sessionLogin` return a verdict field on `needs-extension`: `{ verdict:'needs-extension', installUrl, installAction:'add-to-chrome' }`; dsh's native presentResult layer renders `installUrl` as a clickable link; gotry no longer writes a CLI text wall.
- **`gotry setup wizard`** degrades to **offline health-probe waiting** (pure stdout; detect → wait → exit 0/1), so the user can wait in the terminal for the extension to connect on the first try.
- **Automatic replay (health-watch retained, a Node-side responsibility)**: on the first `needs-extension`, a bounded background poll (≤120s, `intervalMs=5000`) starts by default; once the extension is in place, **the same query_id is automatically replayed with the same parameters**; `sessionFlightSearch({immediate:true})` is an explicit opt-out.

**Dual distribution channels (ADR-21)**: the Chrome platform forbids sideloading non-store CRX; one-click install + auto-update exist only through the store.

- **Channel A (GitHub Releases, landed 2026-08-30)**: `gotry setup --extension-from=github` explicit opt-in (env `GOTRY_EXTENSION_SOURCE` is equivalent; the default bundled preserves offline determinism). Download chain: the trio of stable Release asset names (`gotry-session-bridge.tar.gz`/`-store.zip`/`extension-dist-manifest.json`) → SHA256 → fixed-key pinning (reject the install if the key differs from bundled) → version comparison → atomic swap into `~/.gotry/extension`; any failure explicitly degrades to bundled. `GOTRY_EXTENSION_RELEASE_BASE` can override the base URL (mirrors/testing).
- **Channel B (Chrome Web Store, listed 2026-09-02)**: the store materials and privacy policy are in `../ops/extension-webstore-submission.md` and `../ops/extension-privacy.md`.

**Offline contract (run-all §40/§43)**:

- (1) `gotry setup wizard --dry-run`: zero network, zero browser, zero clipboard, zero GUI spawn; it validates only command output and exit codes
- (2) health-watch three timing branches: ready at 0ms / ready midway / timeout at 120s+1ms
- (3) the wizard calls no `spawn` at all (`open/pbcopy/xclip/osascript/zenity/msg/clip` all retired)
- (4) per-query retry-after-watch: ready within the watch → automatic replay of the same query_id; the artifacts hit the same evidence file
- (5) the `needs-extension` verdict carries `installUrl` + `installAction:'add-to-chrome'`
- (6) Channel A: asset-name/URL contract + packaging-script anti-drift / dist-manifest fail-closed / version comparison / loopback e2e six states / CLI single-line JSON contract

**Reconciliation with existing constraints**: the transport layer's zero-new-dependency discipline (no spawn import in the wizard; health-watch is Node http polling); ReadGuard unchanged (onboarding never touches cookie values; it verifies only the extension heartbeat and the existence of logged-in-state cookie names); login productization unchanged (`gotry_session_login` has the extension pop the login entry in the user's Chrome — the same extension as the store install, two uses of one thing); the "switchable off at any time" triple: the extension card toggle + `GOTRY_SETUP_EXTENSION=0` + `sessionAccess: off`.

### 3.4 ReadGuard (the physical impossibility of write operations, not just a promise)

1. **Network layer**: CDP Fetch/Network domain interception — a deny-list (POST/PUT/DELETE + the URL patterns `/order|/pay|/submit|/trade|/booking`) aborts matched requests and persists an audit record (`session-incidents.jsonl`, aligned with the incident-log convention);
2. **DOM layer**: submit-type buttons (role=button whose text matches place-order/pay/book/submit-order) are **removed outright** from the a11y snapshot — the model never even sees a clickable submit element;
3. **Action layer**: the tool surface exposes only three action semantics — navigate/fill-search/click-result — with no submit primitive;
4. fail-closed: a session whose guard did not initialize successfully may not initiate any navigation.

This is WriteGate (L0-L4) mirrored into the retrieval posture: **a write is not "forbidden behavior"; it is a "nonexistent primitive"**.

**The guard model takes a different shape per lane (added by the 2026-08-30 transport-layer ruling)**:

- **Extension lane (PRIMARY)**: physically read-only is carried by "zero write behavior in the extension itself" — the background SW never sends any request to a site (all fetches point only at the 127.0.0.1 bridge; asserted at the code level by run-all §38); it only "navigates to allowlisted-domain job URLs + passively forwards NETWORK_HINTS hits". Request-level abort does not exist and is not needed (the agent never injects interactions; every page request is sent by the site itself). The fail-closed invariant = "verdict on a missing bridge/extension handshake, zero spend" (`needs-extension`, bounded wait, no silent fallback to CDP).
- **cdp lane (explicit fallback)**: keeps the original four layers above — puppeteer request interception with classifyRequest dual-factor abort + audit JSONL + fail-closed (if the guard cannot be installed, the whole session cannot open).
- Shared by both sides: audits land in the same `session-incidents.jsonl` (extension jobs distinguished by `kind:'extension-session-job'`); `evaluateDoubleSource`'s `read_guard_blocked!=0 → guard_violation/no_spend_stop` is unchanged; `needs-extension` → `waiting_extension` (the waiting-* family is all no-spend).

**Human-machine shared-control tab discipline (2026-08-29)**: retrieval and login guidance always open **independent new tabs** (the login page is foregrounded and left on the user's side) and never navigate the user's existing tabs — the browser belongs to the user; we only touch pages we opened ourselves (extension lane: the retrieval background tab auto-closes on wrap-up and the login tab is left to the user; CDP lane: wrap-up only closes its own page + disconnects); live probes are off by default (`GOTRY_SESSION_LIVE=1` opt-in), and tests never open windows automatically.

### 3.5 Cadence, circuit-breaking, and the consent gate (making "act human" into code)

- **Cadence**: on-site query interval ≥30s, ≤10 per session, a configurable daily cap (`GOTRY_SESSION_*` environment variables); on detecting a slider/captcha/risk-control redirect: **immediate circuit-break + cooldown + notify the user for manual handling** — never retry, never bypass (compliance pillar ②).
- **Batch stop (issue #411, 2026-09-12)**: `sf-live-benchmark` preserves the structured `challenged` verdict and stops the current batch at the first `challenge_stop` or `guard_violation`; it records attempted/unattempted query IDs and marks incomplete batches fail-closed. This is an offline engineering contract and does not authorize or simulate login, site access, or inventory calibration.
- **Consent gate v2 (pillar ④ in code, landed 2026-08-29)**: tools that use the user's own logged-in state (`gotry_session_search`) go through dsh `tools/pre-execute` (`session-consent.ts`) and request authorization via an `ApprovalService` consent card **on the first call per session per site**; allowed-once is recorded in the session's granted set (no re-prompt within the session); rejected/cancelled is recorded as denied = **revoked for this session** (no card, no execution — a refusal is a ruling, not something to pester repeatedly); with no approval channel available, always fail-closed (headless with no user present = no authorization). The first version prompted per call; the founder's live testing judged it harassment ("a prompt every time, and often unclickable"), and it was changed to once per session that same day.
  - **User-facing Chinese copy spec**: the body text of the consent gate (and any similar user-facing prompt) must use natural Chinese user phrasing, full-width Chinese punctuation (`，。；：、？！（）「」『』——……`), and Chinese sentence-final punctuation; tool names, config keys (`sessionAccess=off`), platform/environment identifiers (`ReadGuard`, `headless`, `web`, `agent`, `allow`, `ask`, `off`, etc.) and technical terms keep their original values untranslated; reason IDs, status sets, caches, policies, schemas, function signatures, and decision logic all remain unchanged.
- **Switches**: plugin config `sessionAccess: ask|allow|off` (off at any time / pre-authorized / master switch); the site allowlist = the current adapter registry state (ctrip-flight only). **The Fliggy anonymous channel does not pass the gate** (its calls carry no user identity, so there is no account risk-control/PIPL processing surface; its obligations to the user are covered by "read-only + transactions completed by a human via jumpUrl + quota rate-limiting as structured error"); asserted by session-tests §I.
- **Login bootstrap**: `scripts/session-login.ts` — attach the user's daily Chrome → open a login-entry tab → the human logs in → read-only polling of ticket cookie names (never reading values, never touching credentials); the `needs-login` copy points to it. **Tests never open a browser window automatically** (live sections are `GOTRY_SESSION_LIVE=1` opt-in — founder feedback "anonymous windows repeatedly opening Ctrip / the UI crashing" = test harassment, fixed the same day).
- **Logged-in-state persistence (2026-08-28 founder correction: "any browser we open must carry a logged-in state, never an anonymous instance")**: the default profile moves to `~/.gotry/session-profile` (persistent; the logged-in state is not lost); the `sessionFlightSearch` login gate: anonymous is denied by default (verdict=`needs-login`); `allowAnonymous` is limited to pipeline self-checks and the evidence chain is tagged `anonymous=自检态`. If profile migration is ever needed long-term: AES-GCM on disk + the key in the OS keychain (macOS `security`/Windows DPAPI/Linux libsecret; keytar is dead and unused), 0600 permissions. Login is always completed manually by the user (the agent never touches passwords/OTP/captchas, aligned with Operator's takeover mode and master outline 3.5 "the model never touches sensitive information").

### 3.6 Injection protection

Before page text enters the LLM it is uniformly wrapped in an untrusted fence (`<<UNTRUSTED_PAGE_CONTENT>>`, instruction stripping + a length cap); retrieval tasks carry structured intent {site, query, fields}; parsed output passes a Zod schema and out-of-scope fields are dropped; result cards get a second validation before rendering (price/time format and sanity ranges).

### 3.7 Data boundary (the firewall against the shared experience layer)

Session retrieval results **exist only in the current session context and a local cache (short TTL, for dedup only)**; M4 experience backflow / the wish pool **must not reference raw session data** — only user-confirmed assertion-level conclusions ("Dali flights at the ¥1600 level for the October holiday") and nothing account-attributable. This goes into memory-utility's merge gatekeeper as a P0 assertion.

---

## 4. Implementation plan (each phase can be halted independently)

| Phase | Status | Budget |
|---|---|---|
| **P0 due diligence** | ✅ completed 2026-08-28 | actual 1 tick |
| **P1 skeleton** | ✅ completed 2026-08-28 | actual 1 tick |
| **P2 surface** | ◐ 2026-08-28 main body complete (remainder awaits logged-in state) | actual 3 ticks |
| **P3 productization** | ◐ 2026-08-28 slice 1/2 complete | actual 2 ticks |
| **P3.5 transport-layer ruling: extension bridge** | ✅ completed 2026-08-30 (option C promoted to PRIMARY) | 1 tick |
| **P4 distribution channels (ADR-21)** | ✅ channel A landed 2026-08-30; channel B store listing 2026-09-02 | 1 tick |
| **P3.6 Onboarding UX responsibility hand-back** | ✅ completed 2026-09-02 (the wizard degraded to offline health-probe waiting) | 0 ticks (responsibility hand-back) |
| **P3.7 dual-source e2e real batch run (goal 2)** | ✅ completed 2026-08-30 (commit `60669f8` + PR #66 follow-up) | 1 tick |
| **P3.8 Issue #67 static vendor + default-bridge lifecycle** | ✅ 2026-08-30 | 1 tick |

#### P0 due diligence

- **Scope**: ① the Fliggy FlyAI key application + read-only capability probing (determines the session plane's real gap); ② the Amap MCP key; ③ a local Chrome attach PoC (~30 lines: connect a dedicated profile, open the Ctrip flight page, sniff 1 XHR and print the JSON); ④ backfill the G7/G8/G9 decisions into this RFC.
- **Exit (met)**: ① FlyAI works in live testing without a key — 8 tools, all read-only; the official channel is open for flights/trains (memo into data-sources.md §8); ② the Amap acquisition steps are recorded in tokens.md (awaiting the key); ③ the PoC ran two rounds with zero risk-control and zero interaction, and the main APIs were identified (`search/batchSearch` ~550KB + the low-price calendar ~81KB; script `ts/scripts/session-attach-poc.ts`; playwright-core 1.62.1 devDep); ④ the decision table is settled. **Conclusion revised: flight/rail primary paths move to FlyAI; the session plane contracts to "Ctrip consumer-side cross-validation + Meituan local + official-channel blind spots"**.

#### P1 skeleton

- **Scope**: transport + ReadGuard + the adapter interface + the first adapter (**Ctrip flights**, reconciled directly against the existing flight static package); the evidence chain `[会话:*]`; isolated-stateRoot tests (aligned with the inspection state discipline; never touching dsh-runtime real state).
- **Exit (met)**: `capabilities/flyai.ts` + `capabilities/session-search.ts` + `session/{transport,read-guard,adapters/ctrip-flight}` — five pieces landed; `session-tests.ts` 25 assertions all green (ReadGuard dual-factor / camelCase compound write terms / fixture parsing / city-code table three values / cadence gate cooldown / live FlyAI hit / live session sniffing hit + zero guard interceptions + audit file absent); run-all §24 full-stack ALL GREEN. The first dual-source comparison record (FlyAI ¥230 vs session ¥1611) — **the price gap is explained (2026-08-28): FlyAI's lowest price is a Nanjing-transfer + overnight-linkage itinerary, while Ctrip's first screen ¥1611 is a direct flight; the dual-source comparison assertion criteria = bucket by journeyType, align dates per segment, then compare** — the price gap itself is the value argument for cross-validation.

#### P2 surface

- **Scope**: the action-cache self-heal layer ✅ (run-all §26); the Meituan adapter skeleton + a11y fallback extractor ✅ (§27; **anonymous 403 in live testing — logged-in state is a hard 403-level prerequisite; the networkHint awaits backfilling after login**); the golden standard 20-query set + the flyai baseline ✅ (fa-01..04: e2e §14, including a live three-value miss case and the masked-train-price discovery); **the #21 field fixture scorer / dual-source contract / waiting-attach no-spend ✅** (`session/benchmark.ts`, run-all §25); Fliggy needs no session adapter (covered by the official FlyAI channel); the real sf-01..08 field-level ≥90% batch run still awaits logged-in state.
- **Exit**: the fixture contract is now in deterministic regression; real batch runs still need Chrome permission confirmation and a CDP handshake.

#### P3 productization

- **Scope**: the `gotry_flyai_search`+`gotry_session_search` dual tools ✅ (smoke §12, hit/rate-limited both legal terminal states); the persona contract **(19) three-tier routing** ✅ (repo-root yml, direct/transfer bucketing); the e2e §14 empirical record ✅; six status surfaces synced ✅; run-all §25-27 all green.
- **Exit**: real-model e2e **flyai side ✅** (e2e §15, 8ddb997: the real model actually invoked the flyai tool, a three-source evidence chain coexisting, multi-lane collaboration demonstrated); **awaiting logged-in state**: one real-model e2e session-side case + the dual-source sf-01..08 batch (risk-control trigger count = 0 during the live-test window; the same criteria apply here).

#### P3.5 transport-layer ruling: extension bridge

- **Rationale (founder live testing)**: "Chrome attach's per-connection permission dialog is far too frequent — completely unusable" — chrome-devtools-mcp #825 confirmed Chrome 144+ pops a dialog on every connection with no persistent approval; the CDP route is unusable for the product.
- **Landed**: `extension/` GoTry Session Bridge (MV3, four files, zero build; manifest fixed key = stable extension ID; SW long polling; MAIN-world sniffing; cookie-names takes names only) + `session/extension-bridge.ts` (node:http loopback bridge, zero new dependencies, origin allowlist, <20s long polling keeps the SW alive) + `extension-channel.ts` three-job wrappers + session-search/login lane routing (extension default; cdp explicit via `GOTRY_SESSION_TRANSPORT=cdp`; no silent fallback) + `gotry setup` extension placement (`~/.gotry/extension`, idempotent, skippable via `GOTRY_SETUP_EXTENSION=0`).
- **Exit (met)**: 0 system dialogs per session; run-all §38 full offline contract 23 assertions (manifest / fixed-ID derivation / Node↔extension constant anti-drift / origin 403 / long-polling idempotence / heartbeat / closed loop / timeout / needs-extension no-spend / waiting_extension); bootstrap-tests 5/5; the real sf-01..08 dual-source batch awaits a one-time extension install by the user to finish (the gate drops from "open the debug port + click a dialog per connection" to "install the extension once").

#### P4 distribution channels (ADR-21)

- **Rationale**: founder directive "artifact download and installation must also become a better user experience; GitHub may be used as a distribution channel"; under the Chrome platform constraints the two channels split duties — GitHub Releases can only improve downloads; one-click install + auto-update exist only through the store.
- **Exit (met)**: Channel A: the `--extension-from=github` download chain (stable asset names / SHA256 / key pinning / atomic swap / fallback to bundled on failure) + `scripts/package-extension.mjs` packaging (produces artifacts only; upload is confirmation-gated); Channel B: two store documents (see §3.3) + approved and listed 2026-09-02 (D-25 cleared); run-all §43 + bootstrap-tests 8/8.

#### P3.6 Onboarding UX responsibility hand-back

- The content is the §3.3 "responsibility hand-back" redesign (2026-09-02), not repeated here.
- **Exit (met)**: run-all §40 onboarding-tests 9/9 (dry-run zero-network zero-GUI / health-watch three timing branches / wizard calls no spawn / retry-after-watch replays the same query_id / withAutoRetry end-to-end / probe boundary constants / the extensionDir contract, etc.); bootstrap-tests 8/8 (wizard dry-run + the real path + the two extension-distribution cases).

#### P3.7 dual-source e2e real batch run (goal 2)

- **Rationale (the founder's real question "flyai is just one vendor — can we switch to others?")**: after P3.6, batch runs hit FlyAI `Trial limit reached`, leaving field scoring with no comparison source → move to a **pluggable official golden**: ① default manual-golden (`ts/data/sf-golden-manifest.json` public schedules + price bands, zero network, zero vendor); ② `--golden=flyai` switches back to FlyAI explicitly (hbcli / other official channels can plug in the same way); ③ field scoring moves to **soft hits** (hard fields query_id/from/to/currency/source/verdict must match exactly; soft fields use a ±60min time window / ±15% price band / flight-number substring match against known_flights).
- **Official-channel due diligence (2026-08-30)**: `hbcli` covers only the hotel-be domain, not flights/trains; `OpenFlights` has route relationships but no schedules; Ctrip's `flights.ctrip.com/schedule/*.html` public timetable returns 432 risk-control — conclusion = a manual golden + public schedule knowledge is the most stable option today.
- **Exit (met)**: local live test of 8 queries: **7/8 verdict=hit / 6/6 manual-golden soft hits at 100%** (sf-01 MU6145 ¥3240 7.9s / sf-02 CA1441 ¥2605 6.3s / sf-03 9C8779 ¥810 5.3s / sf-04 CZ3497 ¥1340 4.2s / sf-05 hit 7s / sf-06 GJ7153 ¥680 6.2s / sf-07 JD5143 ¥630 4.2s flyai / sf-08 miss 25s flyai); live <15s **7/7 hit, all passing**; ReadGuard 8/8 zero writes; challenge 0/8. Evidence persisted to `~/.gotry/evidence/session/sf-XX/<ts>.json` + the sf-summary rollup; `sf-summary.ts` rebuilds the unified summary in one command.

#### P3.8 Issue #67 static vendor + default-bridge lifecycle

- **Scope**: `--golden=static` provides route/carrier from a fixed OpenFlights revision; schedules/price bands are explicitly tagged estimated; requested/effective/provenance/fallback live in the same evidence record; on a static error on stderr, fall back to manual.
- **Exit (met)**: two consecutive logged-in 8-query rounds: official 8/8 hit both times, fallback 0; session hit 3/8 and 5/8 respectively, and all scorable hits (3+5 records) scored 13/13=100%, with non-hits explicitly shown as miss. The default bridge's parked timer/socket uses `unref`; wizardless `keepBridge` unchanged; §38 24/24, §40 9/9.

Dependencies and parallelism: P0 can start immediately (without waiting for the M4 memory domain); from P1 on, work alternates with M4 and does not crowd the M4 mainline (the session plane is a data-domain increment, orthogonal to the memory domain).

**New debt registrations (registered upon adoption)**: D-13 the session-adapter maintenance surface (breaks on API changes; mitigated by the action cache + golden-standard monitoring); D-14 the playwright-core optional dependency's distribution size and install experience.

---

## 5. Decision gates and risk register

**Decision gates (new, written back into master outline §5.2)**: G7 chartering the user-session data plane / G8 whether to include 12306 (**recommend deferral**: the case law is all on the write side, but platform hostility is the fiercest; hold a separate review once the pipeline is stable) / G9 approval of official-channel due diligence. All three gates were settled on 2026-08-28 (see the §0 decision table).

| Risk | Level | Mitigation |
|---|---|---|
| R1 account risk control (login kicks/sliders/bans) | Medium | dedicated profile + human-speed cadence + read-only + circuit-breaking; on trigger, cool down and notify; the loss surface per account = one re-loginable session |
| R2 the China law boundary (anti-unfair-competition §19 / the criminal red line) | Medium | the four pillars in code; **never bypass anti-scraping measures, never profit from proxy ticket-grabbing, never share or pool data**; G8 defers 12306; get one legal opinion before commercial operation (M5) |
| R3 prompt injection | Low (because read-only) | ReadGuard physical isolation + the untrusted fence + schema validation; zero write primitives = zero blast radius |
| R4 adapter maintenance (OTA redesigns) | Medium | XHR first (immune to UI redesigns) + action-cache self-heal + golden-standard monitoring; start with ≤3 sites |
| R5 user perception ("the agent touches my browser") | Low | **the extension bridge as primary carrier (2026-08-30 ruling)**: one-time install, zero system dialogs, and the extension card is the master switch (double control with the sessionAccess consent gate); the retrieval background tab auto-closes on wrap-up and the login tab is foregrounded and left to the user; site allowlist; one switch turns everything off. The original "dedicated profile at launch" was retired per the founder's correction (nobody logs in on an anonymous instance) |
| R6 platform channel evolution (official MCP fully opening / tightening) | Medium | official channels first in the data-plane ordering; the session layer separates transport from adapters, so if either side is cut off it can be replaced alone; **transport-layer lane separation (extension/cdp/persistent) means that when the Chrome security model tightens further, only the lane changes, not the semantics** |

---

## 6. Reconciliation with repository disciplines

- **Reuse matrix revision proposal** (new rows in master outline §2): `@fly-ai/flyai-cli | MIT | import(npx spawn, zero channel-knowledge pipeline layer) | the Fliggy official read-only retrieval channel (flights/trains/hotels/POI); transactions are completed by a human via jumpUrl`; `playwright-core | Apache-2.0 | import(devDep) | cdp fallback-lane transport (Chrome 144+ per-connection dialogs proven non-productizable in live testing; downgraded to diagnostics/explicit opt-in on 2026-08-30)`;
  - `the Chrome Extensions MV3 platform | platform capability | reference + in-house | the session-transport primary carrier, GoTry Session Bridge (extension/, in-house, 2026-08-30 PRIMARY): one-time install, MAIN-world passive sniffing, fixed-key extension ID; playwright-mcp --extension is design reference only, no code imported`; `browser-use | — | explicitly not imported (Python violates discipline, and its isolated Chromium ≠ the user's desktop Chrome — the target extension cannot be installed; a false substitute)`;
  - `the Chrome Web Store listing checklist (listed 2026-09-02, §3.3) | platform native | reference | the store submission materials (single purpose / permission justifications / privacy disclosures / copy / follow-up release process) + the wizard degraded to offline health-probe waiting, pbcopy/osascript/zenity untouched; installation is the browser's job, rendering is dsh UI's job`; `GitHub Releases + the platform tar | platform capability/native | reference | extension distribution channel A (2026-08-30, ADR-21, §3.3): stable asset names + SHA256 dist-manifest + tar -xzf extraction, zero new npm dependencies`.
- **Red lines into code**: ReadGuard = the retrieval-posture precursor to WriteGate; the motivation-profile/wish-pool red lines are untouched; `[会话:*]` enters the L4 evidence-chain contract.
- **Status sync**: the P3 wrap-up syncs the six status surfaces per `../architecture.md` §11 in the same commit.
- **Inspection state discipline**: all session-plane tests use an isolated stateRoot / a dedicated test profile and never touch the founder's real browser profile or dsh-runtime shared state (the session-plane version of the 2026-08-26 lesson).

---

## Appendix: key sources (first-hand preferred; accessed/verified 2026-08-28)

- Engineering: the Chrome 136 debug restrictions (developer.chrome.com/blog/remote-debugging-port, 2025-03); App-Bound Encryption (security.googleblog.com, 2024-07); chrome-devtools-mcp `--autoConnect` (github.com/ChromeDevTools/chrome-devtools-mcp); playwright-mcp `--extension` and persistent profiles (github.com/microsoft/playwright-mcp); Stagehand v4 (docs.stagehand.dev); rebrowser-patches / Patchright; the Playwright auth/network docs; the 12306 JSON precedent (github.com/testerSunshine/12306); Electron safeStorage backends for comparison.
- Capability: the Gemini 2.5 CU model card (2025-10); UI-TARS-2 (arXiv:2509.02544); the OpenAI CUA/Agent/Atlas official pages; the Anthropic Claude for Chrome red team (2025-08); OpenAI Atlas hardening (2025-12); the Comet injection (Brave, 2025-08); OSWorld/OSWorld 2.0.
- Compliance: the hiQ endgame (Morgan Lewis/ZwillGen, 2022-12); Ryanair v. Booking (Reuters 2024-07; Cooley 2025-01 JMOL); Air Canada v. Seats.aero (AwardWallet/JD Supra); the Interim Provisions on Anti-Unfair Competition on the Network §19 (Global Law Office / King & Wood Mallesons interpretations); 12306 criminal case law (the Ding case in the SPC case corpus; the 2025-08 Jing'an proxy-ticket-grabbing case).
- Official channels: Fliggy FlyAI (flyai.open.fliggy.com); Ctrip Business Travel MCP (ct.ctrip.com); the Amap MCP Server (developer.amap.com).
