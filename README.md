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
# → open http://127.0.0.1:3080 and chat: "I want three relaxing days in Dali"
```

| You want | Command |
|---|---|
| 🖥️ Conversational planner (recommended) | `npx @danceiny/gotry web` → chat UI on :3080 |
| 🤖 Scripted / one-shot answer | `npx @danceiny/gotry "Two recovery days from Shenzhen, budget 3000"` |
| 🛠️ Developer: run from source | see [source install](#%EF%B8%8F-developer-source-install) below |

- Requires Node 22+ and one LLM API key. Zero-config startup — the dsh runtime is mounted automatically via a cordis patch.

---

## ✨ What it does

GoTry turns "I want to go somewhere" into "can I, how, and at what true cost":

| Stage | Who | Output |
|---|---|---|
| **Motivation interview** | LLM | Mandatory questions: working window / booked resources / departure city |
| **Fact extraction** | LLM | Working hours semantics, leave semantics |
| **Feasibility verdict** | **Z3 solver** | Which destinations are feasible / infeasible, why, and the **smallest change that makes them feasible** |
| **Door-to-door true cost** | Solver | Real flight duration (incl. time zones) + early-wake penalty + transfer cost + arrival energy % |
| **Evidence chain** | Render layer | Every number tagged: `[骨架:openflights]` / `[实时API:flyai]` / `[静态包:估算]` |

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
cp .env.example .env                              # ② set LLM_API_KEY
./gotry web                                       # ③ in-repo entry, same UX
```

| Entry | Command | When |
|---|---|---|
| dsh Web chat (recommended) | `./gotry web` | multi-turn planning with visualized reasoning → :3080 |
| headless one-shot | `./gotry "one full task"` | scripts / CI / targeted debugging → stdout |

---

## 🧰 18 tools

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
| **General external** | `gotry_web_search` · `gotry_video_subtitle` · `gotry_github_search` · `gotry_agent_reach` | web / subtitles / GitHub / all-channel external info (via Agent-Reach) |

---

## 🔐 Account session: consent & privacy

The account session channel reads realtime hotel/flight data from **the user's own logged-in Chrome**, under four hard rules:

1. **Login happens on the external website.** GoTry never offers, fills, or collects any password / SMS code / cookie value. It only answers one boolean question: "does a login-ticket cookie exist" (reads cookie **names** only — zero values touched).
2. **Consent card, once per session.** The first account-session use pops a runtime approval card; approval holds for the session, a refusal revokes it for the session (no repeat prompting). Master switch `sessionAccess: ask|allow|off` at any time.
3. **Physically read-only.** A ReadGuard aborts all write requests at the network layer (ordering/payment is unreachable in transport); the agent never touches credentials or captchas — on a captcha it stops and hands control back.
4. **Never hijacks your browser.** Retrieval/login always open their own dedicated tab; the login page is brought to front and stays with you; routine test runs never open browser windows.

> One-time prerequisite: in your daily Chrome, open `chrome://inspect/#remote-debugging` and enable the switch (Chrome 144+). Without it the tools return `needs-attach` with instructions and spend nothing.

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

---

## 🏛️ Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ L1  chat-as-interface; gates are in-message choice cards       │
│ L2  orchestration  dsh runtime + GoTry plugin (ReAct); 18 tools│
│ L3  domain  unified itinerary model + Z3 feasibility engine    │
│ L4  data  static packs + hotelbyte-cli bridge + OpenFlights    │
│ L5  governance  LoopX (objective / gates / evidence / quota)   │
└──────────────────────────────────────────────────────────────┘
```

| Layer | Module | Role |
|---|---|---|
| L2 | `ts/src/index.ts` (dsh plugin) | 18 tools, time-anchor & memory-brief variables; execute isolation + consent gate + process guards |
| L3 | `ts/src/unified.ts` · `py/gotry_feasibility/` | single solving entry (candidate enumeration + flight-chain Z3) |
| L4 | `ts/capabilities/hbcli.ts` · `skeleton-check.ts` | realtime inventory bridge + OpenFlights skeleton (three-valued semantics) |
| L5 | loopx governance | objective / gates / evidence / quota |

> 📖 Full ADRs / evolution / debt ledger: [`docs/architecture.md`](docs/architecture.md) (Chinese — English versions planned for v0.1.0)

---

## ⚠️ Status & limitations

**Ready (green, verifiable):**

- ✅ **Z3 WASM race fixed** (`z3-shared.ts` single instance + session-level mutex; run-all §30 concurrency regression gate)
- ✅ **Realtime flight/hotel/session retrieval** via the FlyAI official channel (flight/train/hotel; `GOTRY_REALTIME_PRICING=1` optionally overwrites priced legs in the solver)
- ✅ **English output for the deterministic solve layer** (`GOTRY_LOCALE=en`, zero missing keys)
- ✅ **Account session: consent gate + productized login + auto-detection** (see [🔐 Account session](#-account-session-consent--privacy))
- License MIT; legacy shell frontend removed (dsh web is the only product surface)

**Open (honest list):**

- ⏳ **M3 Exit not closed** — engineering & distribution ready, but real seed-user evidence (50–200 person cohort) not yet accumulated; synthetic fixtures prove contracts, not business pass
- ⏳ **Non-Chinese UI remnants** — the dsh web UI belongs to the host; tool result cards and persona dialogue localization await M4 calibration samples
- ⏳ **Ctrip-hotel / Meituan session adapters** — flight done; hotel session surfaces await real login-state backfill (next tick)

<details>
<summary>📖 Full status ledger (transactional state / evidence contracts / milestone stance)</summary>

Transactional state ledger (ADR-15, `gotry_async_terminal.v1`: 4/4→`succeeded`/ledger `settled`/exit 0; non-4/4→`failed`/`failed`/exit 2; replaying the terminal state recomputes nothing); dual-form architecture freeze (ADR-16: one ledger semantics for local+Web, tenant_id first-class); session-data-plane #21 field fixture scorer, dual-source contract and waiting-attach no-spend are in deterministic regression, real sf-01..08 not yet accepted; milestone stance (2026-08-29): M3 engineering & distribution ready but real seed-user evidence not closed, M4 proceeds under founder authorization without constituting M3 Exit proof, M5/M6 only after their Entry gates — details in [`docs/roadmap.md`](docs/roadmap.md) and [`docs/architecture.md`](docs/architecture.md).

</details>

---

## 🧪 Verify

```bash
./scripts/run-all-tests.sh
```

One-shot full-stack green (pure TS, no Python needed): golden engines · dialogue replay · cross-process async work-orders · plugin smoke · hbcli · process guards · weather · flights · Anything · probePoi · agent-reach · dual-path stability · time-awareness eval · memory domain · **Z3 race (§30) · realtime pricing (§31) · i18n catalog (§32) · M3 cohort evidence contract (§33) · M4 value evidence contract (§34)**.

---

## 🤝 Contributing

> *PR-based flow: branch off the latest `main`, full suite green, open a Pull Request — `main` never takes direct pushes. Full guide: [CONTRIBUTING.md](CONTRIBUTING.md).*

Standard open-source flow: branch off latest `main` (`feat/ · fix/ · docs/ · chore/`), full suite green locally, open a PR; CI (Node 22/24, typecheck + all suites) plus maintainer review, then squash-merge. **Red tests never merge.**

---

## 📜 License

**MIT** (2026-08-23) — same as upstream dsh. See [LICENSE](LICENSE).

---

**Built with**: DeepSeek Harness 0.1.2-alpha.1 (vendored) · Cordis · Z3 (WASM) · loopx (pipx) · hotelbyte-cli · Agent-Reach v1.5.0 (`.venv/`) · OpenFlights · TypeScript

**Last verified against `v0.0.1-rc.14` (2026-08-29)** — full-stack regression green §1-§34 (release flow: `scripts/publish-npm.sh`).