[English](README.md) | [简体中文](README.zh-CN.md)

# GoTry

[![CI](https://github.com/Danceiny/gotry/actions/workflows/ci.yml/badge.svg)](https://github.com/Danceiny/gotry/actions/workflows/ci.yml)

> **Body and soul — more travel, less tourism.**
> *身体和灵魂,更多旅行,更少旅游。*

**GoTry is an AI travel agent for "departure to next departure."** You say where you want to go and why; it asks about your working hours and existing bookings, then hands you a **formally verified itinerary** — computed by a solver, not guessed by a model.

| | |
|---|---|
| **Version** | `v0.0.1-rc.13+` (npm `latest`; [release notes](docs/release-notes.md)) |
| **Runtime** | DeepSeek Harness **0.1.2-alpha.1** (vendored; [upstream](https://github.com/deepseek-ai/DeepSeek-Harness)) · Z3 WASM · Cordis |
| **License** | **MIT** ([LICENSE](LICENSE)) |
| **Docs** | English (this file) · [简体中文 README](README.zh-CN.md) · deep engineering docs are Chinese-first ([docs/architecture.md](docs/architecture.md)) |

---

## ⚡ 30-second start

```bash
npx @danceiny/gotry web
# First run creates .env: LLM_API_KEY=<DeepSeek key, or OpenAI-compatible key>
#   Not using DeepSeek directly? Also set LLM_BASE_URL=<your endpoint, usually ending in /v1>
# → open http://127.0.0.1:3080 and chat: "I want three relaxing days in Dali"
```

> **Switching models / providers?** The price table (`ts/data/llm-price-table.json`, schema `gotry_llm_price_table_v2`) is the single source of truth for `gotry_m3_nightly_run_v1.cost_usd`. Adding a new model or switching relay = update this file via PR (ADR-11, peak-conservative upper bound only). Unknown models **fail-closed** — no guessed prices. Drift monitor: `npx tsx ts/scripts/price-drift-watch.ts` (offline baseline diff; `--fetch` for live official pages). Never auto-applies changes.

| You want | Command |
|---|---|
| 🖥️ Conversational planner (recommended) | `npx @danceiny/gotry web` → chat UI on :3080 |
| 🤖 Scripted / one-shot answer | `npx @danceiny/gotry "Two recovery days from Shenzhen, budget 3000"` |
| 🛠️ Developer: run from source | see [source install](#%EF%B8%8F-developer-source-install) below |

- Requires Node 22+ and one LLM API key. Any OpenAI-compatible endpoint (MiniMax / relays / self-hosted gateways) works too — add `LLM_BASE_URL` to `.env` (usually ends with `/v1`, e.g. `https://api.minimax.io/v1`) and requests follow it instead of the DeepSeek default. Zero-config startup — the dsh runtime is mounted automatically via a cordis patch.

---

## ✨ What it does

GoTry turns "I want to go somewhere" into "can I, how, and at what true cost":

| Stage | Who | Output |
|---|---|---|
| **Motivation interview** | LLM | Mandatory questions: working window / booked resources / departure city |
| **Fact extraction** | LLM | Working hours semantics, leave semantics |
| **Feasibility verdict** | **Z3 solver** | Which destinations are feasible / infeasible, why, and the **smallest change that makes them feasible** |
| **Door-to-door true cost** | Solver | Real flight duration (incl. time zones) + early-wake penalty + transfer cost + arrival energy % |
| **Evidence chain** | Render layer | Every number carries a **source tag**: `[骨架:openflights]` = route existence verified against the public route database; `[实时API:flyai]` = pulled live from an API seconds ago; `[静态包:估算]` = a researched estimate (**not realtime — verify before booking**). On degradation the tag switches honestly — an estimate never poses as realtime |

**Unlike a regular AI chat**, the LLM only translates and explains. **Decisions and arithmetic are computed by a Z3 solver**, not guessed.

---

## 🚀 Quick start

### One-liner (npm, recommended)

```bash
npx @danceiny/gotry web
```

That's it — the dsh chat UI on `:3080` with the GoTry persona mounted. First cold start is 6–15 s; if port `:3080` is taken, free it first; unexpected exits leave evidence in `gotry-state/incidents.jsonl` (nothing silent).

### Developer source install

```bash
git clone https://github.com/Danceiny/gotry && cd gotry
cd ts/dsh-runtime && pnpm install && cd ../..    # ① vendored dsh 0.1.2-alpha.1 (one-off)
cp .env.example .env                              # ② set LLM_API_KEY (+ LLM_BASE_URL if not on DeepSeek)
./gotry web                                       # ③ in-repo entry, same UX
```

| Entry | Command | When |
|---|---|---|
| dsh Web chat (recommended) | `./gotry web` | multi-turn planning with visualized reasoning → :3080 |
| headless one-shot | `./gotry "one full task"` | scripts / CI / targeted debugging → stdout |

---

## 🧰 21 tools

| Group | Tool | What it does |
|---|---|---|
| **Realtime retrieval (OTA/official, read-only)** | `gotry_flyai_search` | Live flight/train/hotel quotes via the Fliggy official channel (masked hotel prices upstream; real prices on the jumpUrl page) |
| | `gotry_session_search` | Ctrip flights on the **user's own logged-in Chrome session** (consent-gated, physically read-only) |
| | `gotry_session_login` | Login bootstrap: auto-detects existing login first; otherwise opens the login entry in the user's Chrome (**zero terminal**) |
| | `gotry_weather_check` | Open-Meteo forecast ≤16 d + historical climate baseline |
| | `gotry_flight_verify` | OpenSky ADS-B live flight observation (three-valued) |
| | `gotry_skeleton_check` | OpenFlights 168-hub-pair connectivity (three-valued) |
| **Inventory & catalog** | `gotry_hotel_search` | hotel-byte realtime bridge, degrades to static pack (tagged) |
| | `gotry_anything_search` | mixed city/hotel/POI catalog (hotel-be Anything) |
| **Decision engine** | `gotry_feasibility_check` | Door-to-door true-cost feasibility (Z3), per-candidate verdicts |
| **Memory & reachability** | `gotry_motivation_save` | Persist motivation profile (evidence mandatory, anti-fabrication) |
| | `gotry_wish_pool_add` / `gotry_wish_pool_list` | "next departure" wish pool + 0..1 conditional recall |
| | `gotry_companion_save` · `gotry_trip_log` | companion profile / travel timeline |
| **Artifacts** | `gotry_artifacts_list` / `gotry_artifacts_read` | Discover & view generated artifacts (async deliverables + working-dir markdown) as a line-numbered file view (read-only) |
| **Factuality gate** | `gotry_fact_gate` | Pre-delivery gate for itinerary artifacts: every bookable claim (flight no./time/airport/price/policy) must trace to an exact-date tool result (hit AND miss recorded); unverifiable ⇒ blocked — never present as a verified plan |
| **General external** | `gotry_web_search` · `gotry_video_subtitle` · `gotry_github_search` · `gotry_agent_reach` | web / subtitles / GitHub / all-channel external info (via Agent-Reach) |

---

## 🔐 Account session: consent & privacy

The account session channel reads realtime hotel/flight data from **the user's own logged-in Chrome**, under four hard rules:

1. **Login happens on the external website.** GoTry never offers, fills, or collects any password / SMS code / cookie value. It only answers one boolean question: "does a login-ticket cookie exist" (reads cookie **names** only — zero values touched).
2. **Consent card, once per session.** The first account-session use pops a runtime approval card; approval holds for the session, a refusal revokes it for the session (no repeat prompting). Master switch `sessionAccess: ask|allow|off` at any time.
3. **Physically read-only.** A ReadGuard aborts all write requests at the network layer (ordering/payment is unreachable in transport); the agent never touches credentials or captchas — on a captcha it stops and hands control back.
4. **Never hijacks your browser.** Retrieval/login always open their own dedicated tab; the login page is brought to front and stays with you; routine test runs never open browser windows.

> One-time prerequisite: install the bundled **GoTry Session Bridge** browser extension (MV3, ~30 seconds): run `npx gotry setup` to place it at `~/.gotry/extension`, then in Chrome open `chrome://extensions`, enable Developer mode and "Load unpacked" that folder. Zero Chrome system dialogs afterwards — the extension passively forwards the site's own search responses (read-only by construction; cookies are read by NAME only, values never leave the browser). Until installed, tools return `needs-extension` with instructions and spend nothing. (A `cdp` fallback via `chrome://inspect` remote debugging still exists for diagnostics: `GOTRY_SESSION_TRANSPORT=cdp` — note Chrome 144+ shows a permission box on every connection.)

---

## 🎬 A conversation — Demo

```
> Two or three days staring at Erhai Lake, leaving from Shanghai, budget 3000, annual leave — no work.

GoTry: constraints captured —
  • window: 2 days   • departure: Shanghai   • budget: ¥3000 all-in
  • motivation: recovery [escape_rest: 0.7]   • no bookings yet

Engine verdict:
  **Erhai, Dali: not feasible now** — a 2-day window can't hold "at least 5 days of Erhai recovery".
    Relax: extend to 5 days, ~¥4950. ★ saved to your "next departure" wish pool.
  **Qiandao Lake: feasible** (G7315 06:35, ¥996, arrival energy 84%, effective rest 4.4h)
  **Taihu Lake: feasible** (G101 09:00, ¥716, effective rest 4.6h)
  Suggestion: Qiandao Lake (imagery match 80%).

[skeleton:openflights] ✓ SZX↔PVG verified [realtime:hbcli] Shanghai airports live
[static-pack:estimate] G7315/G7316 priced on Jul–Aug off-season rates
```

> Tag guide: `[骨架:openflights]` means "this route can be flown" was verified against the public route database; `[实时API:*]` marks data pulled live seconds ago; `[静态包:估算]` flags an off-season estimate — **verify before booking**. Tags are attached by the render layer, never by the model.

---

## 🏛️ Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ L1  chat-as-interface; gates are in-message choice cards       │
│ L2  orchestration  dsh runtime + GoTry plugin (ReAct); 21 tools│
│ L3  domain  unified itinerary model + Z3 feasibility engine    │
│ L4  data  static packs + hotelbyte-cli bridge + OpenFlights    │
│ L5  governance  LoopX (objective / gates / evidence / quota)   │
└──────────────────────────────────────────────────────────────┘
```

| Layer | Module | Role |
|---|---|---|
| L2 | `ts/src/index.ts` (dsh plugin) | 21 tools, time-anchor & memory-brief variables; execute isolation + consent gate + process guards |
| L3 | `ts/src/unified.ts` · `py/gotry_feasibility/` | single solving entry (candidate enumeration + flight-chain Z3) |
| L4 | `ts/capabilities/effect.ts` · `hbcli.ts` · `skeleton-check.ts` | effect interpreter (backoff retry / circuit breaker / mock interpreter, issue #16) + realtime inventory bridge + OpenFlights skeleton (three-valued semantics) |
| L5 | loopx governance | objective / gates / evidence / quota |

> 📖 Full ADRs / evolution / debt ledger: [`docs/architecture.md`](docs/architecture.md) (Chinese — English versions planned for v0.1.0)

---

## ⚠️ Status & limitations

**Working today** (full-stack regression §1–§34 green; every item has deterministic tests):

- **Z3 solving engine** — feasibility verdicts + door-to-door whole-cost; the historical concurrency race is fixed (§30 regression gate)
- **Realtime retrieval** — flight/train/hotel (Fliggy official channel), destination/hotel catalogs, weather, live flight observation, route connectivity; realtime prices can overwrite solver prices (`GOTRY_REALTIME_PRICING=1`)
- **Account session search** — Ctrip flights on your own logged-in Chrome; consent & privacy rules above (see 🔐 **Account session: consent & privacy**)
- **One-time browser extension setup** — `npx gotry setup wizard` walks you through a 30-second install of GoTry Session Bridge (MV3, fixed extension ID, zero system dialogs per session). Background health-watch auto-plays your query once the extension is connected — no manual retry needed.
- **Extension distribution (issue #21, ADR-21)** — the npm-bundled copy stays the default (offline-deterministic). Opt in to the GitHub Releases channel with `npx gotry setup --extension-from=github`: versioned tarball + SHA256 + fixed-key pinning, atomic swap into `~/.gotry/extension`; any failure falls back to the bundled copy. Platform constraint, honestly: only a Chrome Web Store listing can remove the developer-mode load-unpacked clicks — store submission materials are prepared in `docs/extension-webstore-submission.md` (founder to submit).
- **Session data cross-verification (issues #21 / #67)** — 8 benchmark queries (sf-01..sf-08) verified end-to-end: 7/8 verdict=hit, 6/6 manual-golden soft-score 100%, all hits <15s, zero ReadGuard writes. The comparator is pluggable: `--golden=manual` (default), `--golden=flyai`, or `--golden=static`. Static mode pins an ODbL OpenFlights route/carrier snapshot and combines it with manual time/price bands; evidence records requested vs effective source, provenance, estimated fields, and fallback reason. Snapshot/route failure prints a warning to stderr and falls back to manual. Static mode is deterministic benchmark data, **not live schedule, fare, or availability**.
- **Observed static-source runs (2026-08-30, logged-in Chrome)** — two consecutive runs produced static official 8/8 with zero fallback each time; Ctrip session hits varied from 3/8 to 5/8, while every scored hit across both runs (3+5 records) passed 13/13 (100%). Non-hits remain explicit `miss` records, so the ≥90% field score is not presented as 8/8 live availability. The same runs exposed and fixed an online-extension lifecycle bug: idle parked timers/sockets no longer pin the default CLI bridge, while wizard `keepBridge` behavior remains unchanged (§38: 24/24, §40: 9/9).
- **Memory & reachability** — motivation profile / wish pool / companions / travel timeline; English output via `GOTRY_LOCALE=en`

**Open limitations** (as of 2026-08-29, honest list):

- ⏳ **M3 Exit not closed** — engineering & distribution ready, but real seed-user evidence (50–200 person cohort) not yet accumulated; automated tests prove contracts and formulas, not business pass
- ⏳ **Ctrip-hotel / Meituan logged-in adapters** — flights done; hotel session surfaces await real login-state backfill (next tick)
- ⏳ **Interface language** — English currently covers the deterministic solve-output layer only; the dsh host UI and dialogue surface belong to the host / calibration samples

<details>
<summary>📖 Deeper engineering state (ledger contracts / evidence contracts / milestone stance)</summary>

The authoritative state lives in the docs, not this README: transactional state ledger (ADR-15) + dual-form freeze (ADR-16: one ledger semantics for local+web); the M3 real-cohort evidence contract stands (fixtures don't count toward Exit; 50–200 real samples open the gate); the M4 paired-cohort value evidence contract (run-all §34 — synthetic data is never Exit evidence); async work-order terminal contract (`gotry_async_terminal.v1`: 4/4 → succeeded / ledger settled / exit 0). Details: [`docs/roadmap.md`](docs/roadmap.md) / [`docs/architecture.md`](docs/architecture.md) §1 and issues #19–#22.

</details>

---

## 🧪 Verify

```bash
./scripts/run-all-tests.sh
```

One-shot full-stack green (pure TS, no Python needed): golden engines · dialogue replay · cross-process async work-orders · plugin smoke · hbcli · process guards · weather · flights · Anything · probePoi · agent-reach · dual-path stability · time-awareness eval · memory domain · **Z3 race (§30) · realtime pricing (§31) · i18n catalog (§32) · M3 cohort evidence contract (§33) · M4 value evidence contract (§34) · M3 nightly evidence producer contract (§35) · session transport extension bridge (§38) · onboarding UX wizard (§40) · bookable-fact gate (§39) · extension distribution channel (§43) · sf-live static-golden offline contracts (§44)**. The live runner remains `cd ts && npx tsx scripts/sf-live-benchmark.ts --golden=static` and requires the user's connected Chrome session.

---

## 🤝 Contributing

> *PR-based flow: branch off the latest `main`, full suite green, open a Pull Request — `main` never takes direct pushes. Full guide: [CONTRIBUTING.md](CONTRIBUTING.md).*

Standard open-source flow: branch off latest `main` (`feat/ · fix/ · docs/ · chore/`), full suite green locally, open a PR; CI (Node 22/24, typecheck + all suites) plus maintainer review, then squash-merge. **Red tests never merge.**

---

## 📜 License

**MIT** (2026-08-23) — same as upstream dsh. See [LICENSE](LICENSE).

---

**Built with**: DeepSeek Harness 0.1.2-alpha.1 (vendored) · Cordis · Z3 (WASM) · loopx (pipx) · hotelbyte-cli · Agent-Reach v1.5.0 (`.venv/`) · OpenFlights · TypeScript

**Version baseline: `v0.0.1-rc.16` (2026-08-30).** The current checkout's authoritative verification gates are enumerated by `scripts/run-all-tests.sh` (release flow: `scripts/publish-npm.sh`).
