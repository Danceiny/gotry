[English](README.md) | [简体中文](README.zh-CN.md)

# GoTry

> **Body and soul — more travel, less tourism.**
> *身体和灵魂,更多旅行,更少旅游。*

GoTry is an AI travel agent for **"departure to next departure."** You tell it where you want to go and why; it interviews you about your working hours and existing bookings, then hands you a **formally verified itinerary** — computed by a Z3 solver, not guessed by a model.

[![CI](https://github.com/Danceiny/gotry/actions/workflows/ci.yml/badge.svg)](https://github.com/Danceiny/gotry/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@danceiny/gotry)](https://www.npmjs.com/package/@danceiny/gotry)
[![License: MIT](https://img.shields.io/badge/License-MIT-informational)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.15-blue)](https://www.npmjs.com/package/@danceiny/gotry)
[![Docs](https://img.shields.io/badge/docs-architecture.md-blue)](docs/architecture.md)

**[What GoTry Does](#what-gotry-does)** · **[How It Works](#how-it-works)** · **[Tools](#tools)** · **[Demo](#demo)** · **[Quick Start](#quick-start)** · **[Consent and Privacy](#consent-and-privacy)** · **[Trustworthy by Construction](#trustworthy-by-construction)** · **[Project Status](#project-status)** · **[Roadmap](#roadmap)** · **[For AI Agents](#for-ai-agents)** · **[Documentation](#documentation)** · **[License](#license)**

> **Tip for newcomers:** one command is enough to feel the difference — `npx @danceiny/gotry web`, open `http://127.0.0.1:3080`, and say *"I want three relaxing days in Dali."* The agent interviews you first; then the solver, not the model, decides what is feasible. Full walkthrough: [`docs/user-guide.md`](docs/user-guide.md).

## What GoTry Does

GoTry turns "I want to go somewhere" into "can I — and how, at what true cost?" When the answer is "not this weekend," the destination is caught in a wish pool with its conditions instead of being dropped.

- **For travelers** — a conversational planner that asks the questions that actually matter (working window, booked resources, departure city, budget), then returns a verdict per destination: feasible or not, why, and the **smallest change that makes it feasible**.
- **For agent builders** — a working example of an agent where the LLM only listens, translates, and explains. Decisions and arithmetic live in a Z3 solver; every deliverable number carries a provenance tag; write operations are gated by design.
- **Evidence built in** — an estimate never poses as realtime. Tags are attached by the render layer, never by the model, and switch honestly on degradation. Bookable claims that cannot trace to an exact-date tool result are blocked before delivery.

## How It Works

One planning pass is a pipeline. The model owns the two language-heavy ends; the solver owns everything numeric:

| Stage | Who | Output |
|---|---|---|
| Motivation interview | LLM | Mandatory questions: working window / booked resources / departure city |
| Fact extraction | LLM | Working-hours semantics, leave semantics |
| Feasibility verdict | **Z3 solver** | Which destinations are feasible / infeasible, why, and the smallest change that makes them feasible |
| Door-to-door true cost | Solver | Real flight duration (incl. time zones) + early-wake penalty + transfer cost + arrival energy |
| Evidence chain | Render layer | Every number carries a source tag |
| Delivery gate | Fact gate | Bookable claims must trace to exact-date tool results, or the artifact is blocked |
| Memory | Domain layer | Infeasible today → wish pool, with explicit recall conditions |

Vocabulary you will meet in a GoTry answer:

- **Evidence tag** — `[skeleton:openflights]` route existence verified against the public route database; `[realtime:...]` pulled live from an API seconds ago; `[static-pack:estimate]` a researched estimate — not realtime, verify before booking. On degradation the tag switches honestly.
- **Door-to-door true cost** — the ticket price plus what the trip actually takes from you: real duration across time zones, the early-wake penalty, transfers, and the energy you land with.
- **Wish pool** — "next departure" storage. An infeasible dream is saved with explicit conditions (e.g. "5+ days, off-season") and recalled when they can be met.
- **Fact gate** — pre-delivery check on itinerary artifacts: every bookable claim (flight no. / time / airport / price / policy) must trace to an exact-date tool result; unverifiable means blocked — never presented as a verified plan.

Architecture, five layers:

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
| L2 | `ts/src/index.ts` (dsh plugin) | 21 tools, time-anchor & memory-brief variables; execute isolation + consent gate + per-turn tool budget + process guards |
| L3 | `ts/src/unified.ts` · `py/gotry_feasibility/` | single solving entry (candidate enumeration + flight-chain Z3) |
| L4 | `ts/capabilities/effect.ts` · `hbcli.ts` · `skeleton-check.ts` | effect interpreter (backoff retry / circuit breaker / mock interpreter) + realtime inventory bridge + OpenFlights skeleton (three-valued semantics) |
| L5 | loopx governance | objective / gates / evidence / quota |

> Full ADRs / evolution / debt ledger: [`docs/architecture.md`](docs/architecture.md) (Chinese — English versions planned for v0.1.0).

## Tools

22 tools in six groups:

| Group | Tool | What it does |
|---|---|---|
| **Realtime retrieval (OTA/official, read-only)** | `gotry_flyai_search` | Live flight/train/hotel quotes via the Fliggy official channel (masked hotel prices upstream; real prices on the jumpUrl page; exhausted anonymous trial quota degrades as `needs-setup` with key guidance, never silent retries) |
| | `gotry_session_search` | Ctrip flights **and hotels** + 12306 trains on the **user's own Chrome session** (consent-gated, physically read-only; hotels = `kind:"hotel"` + optional `cityId`, real logged-in prices; trains = `kind:"train"`, public query face — codes/times/seat availability, no prices in the list API) |
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
| **Factuality gate** | `gotry_fact_gate` | Pre-delivery gate for itinerary artifacts — see [fact gate](#how-it-works) above |
| **General external** | `gotry_web_search` · `gotry_video_subtitle` · `gotry_github_search` · `gotry_agent_reach` | web / subtitles / GitHub / all-channel external info (via Agent-Reach) |
| **Self-check** | `gotry_doctor` | Read-only health check of optional dependencies (extension / Agent-Reach .venv / hbcli / FlyAI key **+ recent trial-quota exhaustion time** / dsh-calendar mount state / sidebar) with exact repair guidance; installs only ever happen via the user running `npx gotry doctor --fix`. LLM keys are the dsh host's business — deliberately out of scope. Report lands in `gotry-state/doctor-report.md` (sidebar-workbench previewable) |

> **Channel routing**: retrieval tools stay flat (no hidden dispatch); the persona routing card and the `routing` suggestions attached to failed search results are **generated from one channel registry** (official API > user session > web fallback, filtered by per-session channel health). When a channel exhausts its quota the result says so and names the next channel — retry-blindness is a contract violation, not a prompt hope.

## Demo

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

> Tag guide: `[skeleton:openflights]` means "this route can be flown" was verified against the public route database; `[realtime:...]` marks data pulled live seconds ago; `[static-pack:estimate]` flags an off-season estimate — **verify before booking**. Tags are attached by the render layer, never by the model.

## Quick Start

### npm (recommended)

```bash
npx @danceiny/gotry web
# → open http://127.0.0.1:3080 and chat: "I want three relaxing days in Dali"
# LLM key & model: handled by the dsh host UI; nothing for gotry to ask on the CLI
```

| Entry | Command | When |
|---|---|---|
| Web chat (recommended) | `npx @danceiny/gotry web` | multi-turn planning with visualized reasoning → `:3080` |
| Headless one-shot | `npx @danceiny/gotry "Two recovery days from Shenzhen, budget 3000"` | scripts / CI / targeted debugging → stdout |
| Dependency doctor | `npx @danceiny/gotry doctor` (`--fix` to repair) | optional channels misbehaving: checks extension / Agent-Reach / hbcli / FlyAI key / sidebar, prints exact repair guidance, writes `gotry-state/doctor-report.md` (previewable in the sidebar workbench) |

Requires Node ≥ 22.15. LLM credentials are managed by your dsh host UI — gotry itself never asks for or echoes them. OpenAI-compatible endpoints (MiniMax / relays / self-hosted gateways) are handled by the dsh model configuration. First cold start takes 6–15 s; if port `:3080` is taken, free it first; unexpected exits leave evidence in `gotry-state/incidents.jsonl` (nothing silent).

> **Cost accounting** — `ts/data/llm-price-table.json` (schema `gotry_llm_price_table_v2`) is the single source of truth for nightly run cost. Adding a model or switching relays = a PR against this file (peak-conservative upper bounds only); unknown models **fail closed** — no guessed prices. Drift monitor: `npx tsx ts/scripts/price-drift-watch.ts` (offline baseline diff; `--fetch` for live official pages). It never auto-applies changes.

### Developer source install

```bash
git clone https://github.com/Danceiny/gotry && cd gotry
npm ci && npm --prefix ts ci                      # pinned root/TS closure
node scripts/build-dist.mjs                       # build the JS runtime
./gotry web                                       # in-repo entry, same UX
```

The source entry and the npm package resolve the same 216-package DeepSeek Harness `0.1.2-alpha.3` closure (exact direct dependencies; publish preverify rejects omissions, mixed versions, and ranges). Source normal runs keep their state under `ts/dsh-runtime/gotry-state/`; benchmark opt-in and npm-package runs use the invocation directory for isolation.

## Consent and Privacy

The account-session channel reads realtime hotel/flight data from **your own logged-in Chrome**, under four hard rules:

1. **Login happens on the external website.** GoTry never offers, fills, or collects any password / SMS code / cookie value. It only answers one boolean question — "does a login-ticket cookie exist" (reads cookie **names** only, zero values touched). Existing logins are auto-detected with zero popups.
2. **Consent card, once per session.** The first account-session use pops a runtime approval card; approval holds for the session, a refusal revokes it (no repeat prompting). Master switch `sessionAccess: ask|allow|off` at any time.
3. **Physically read-only.** A ReadGuard aborts all write requests at the network layer — ordering/payment is unreachable in transport. The agent never touches credentials or captchas; on a captcha it stops and hands control back to you.
4. **Never hijacks your browser.** Retrieval/login always open their own dedicated tab; the login page is brought to front and stays with you; routine test runs never open browser windows.

One-time prerequisite: the [GoTry Session Bridge](https://chromewebstore.google.com/detail/gotry-session-bridge/oeajpiccmonococjcegddlooeeohlbgd) Chrome extension — handled by the dsh host UI when an account-session tool first needs it (`gotry_session_search` surfaces the install URL as a clickable link in the verdict). The extension itself is one-click on the Chrome Web Store, auto-updates, and the gotry side never asks the user to load unpacked or to run a setup wizard. Zero Chrome system dialogs afterwards — the extension passively forwards the site's own search responses (read-only by construction; cookies are read by NAME only, values never leave the browser). A background health-watch auto-replays your query once the extension is connected. Until installed, tools return `needs-extension` with the store URL and spend nothing.

## Trustworthy by Construction

1. **The model translates; the solver decides.** The LLM never produces feasibility verdicts or arithmetic — those are computed by Z3 against the extracted facts.
2. **Every number carries a source tag** — attached by the render layer, never the model. Tags switch honestly on degradation; an estimate never poses as realtime.
3. **No write path exists.** Booking/payment-class tools must pass WriteGate before any implementation ships; the future booking seam is already pinned by the `booking_saga_fsm.v1` edge table.
4. **Login never touches credentials.** Login happens on the external website; GoTry reads cookie names only; consent is asked once per session and revocable.
5. **Retrieval is physically read-only.** A ReadGuard aborts write requests at the network layer; a captcha stops the agent and hands control back to you.
6. **Unverifiable means blocked.** The fact gate refuses to deliver any itinerary whose bookable claims cannot trace to exact-date tool results — it is never presented as a verified plan.
7. **Prices fail closed.** Unknown models get no guessed price; the price table changes only by PR; the drift monitor reports, never auto-applies.
8. **Your data is yours.** Product state lives under `gotry-state/`; automated tests and smoke runs use isolated state roots and never write the founder's real product data.

## Project Status

Current release: **v0.0.1-rc.17** (npm dist-tag `rc`; `latest` stays on rc.16 per the dsh-as-LLM-host install convention). Evaluation is at Phase 0 foundation — deterministic contracts, validators, and a cadence policy; no external benchmark scores, no spend, no uplift claims.

**Working today** (full-stack regression green; every item has deterministic tests):

- **Z3 solving engine** — feasibility verdicts + door-to-door whole-cost; the historical concurrency race is fixed and regression-gated
- **Realtime retrieval** — flights/trains/hotels (Fliggy official channel), destination/hotel catalogs, weather, live flight observation, route connectivity; realtime prices can overwrite solver prices (`GOTRY_REALTIME_PRICING=1`); exhausted FlyAI anonymous trial quota is classified `needs-setup` with key guidance (no blind retries)
- **Dependency doctor** — `npx gotry doctor` (CLI) / `gotry_doctor` (in-chat tool): read-only health check of optional dependencies (extension / Agent-Reach / hbcli / FlyAI key / sidebar) with exact repair guidance; `--fix` installs; LLM keys stay with the dsh host
- **Account-session search** — Ctrip flights **and hotels** + 12306 trains on your Chrome (hotels 2026-09-03: real logged-in prices via passive sniffing; trains 2026-09-03: public left-ticket query; interface surfaces calibrate with the first live session); observed runs scored every landed hit 13/13 with zero write attempts, while non-hits stay explicit `miss` records — no live-availability claim beyond that
- **Extension install on demand** — `[GoTry Session Bridge](https://chromewebstore.google.com/detail/gotry-session-bridge/oeajpiccmonococjcegddlooeeohlbgd)` is offered as a clickable link in the dsh UI when an account-session tool first needs it (one-click install + auto-update); the gotry side never runs a setup wizard
- **Memory & reachability** — motivation profile / wish pool / companions / travel timeline; English solve output via `GOTRY_LOCALE=en`
- **Routed turn budgets** — every turn is classified (quick / sync / deep-planning) by a deterministic, zero-LLM router; time is the only budget and the deadline exit follows the task: quick and sync turns converge to an answer, deep-planning turns hand off to a persisted background ticket (`gotry_turn_handoff.v1`, ETA ≈1h) instead of dying mid-stream; the ticket is collected in the background by `scripts/turn-handoff-collect.ts` (idempotent, recursion-guarded child planner) and surfaces in-chat via the read-only `gotry_turn_handoff_list` tool; exercised end-to-end through a packaged consumer install in CI

**Open limitations** (honest list):

- **M3 Exit not closed** — engineering & distribution are ready, but real seed-user evidence (50–200 person cohort) has not been accumulated; automated tests prove contracts and formulas, not business pass
- **Hotel session adapters** — Ctrip-hotel / Meituan logged-in surfaces await real login-state backfill; flights are done
- **Interface language** — English covers the deterministic solve-output layer; the dsh host UI and dialogue surface belong to the host / calibration samples
- **External benchmark generalization** — every frozen external run to date remains diagnostic-only (no score, no uplift claim); the round-by-round engineering ledger lives in [`docs/benchmark-environment-bridge.md`](docs/benchmark-environment-bridge.md)
- **Booking** — nothing bookable ships today; M5 opens only through WriteGate and the booking-saga FSM

<details>
<summary>Deeper engineering state (ledger contracts / evidence contracts / milestone stance)</summary>

The authoritative state lives in the docs, not this README: transactional state ledger (ADR-15) + dual-form freeze (ADR-16: one ledger semantics for local+web); the M3 real-cohort evidence contract stands (fixtures don't count toward Exit; 50–200 real samples open the gate); the M4 paired-cohort value evidence contract (synthetic data is never Exit evidence); the async work-order terminal contract (`gotry_async_terminal.v1`: 4/4 → succeeded / ledger settled / exit 0). Details: [`docs/roadmap.md`](docs/roadmap.md) / [`docs/architecture.md`](docs/architecture.md) §1 and issues #19–#22.

</details>

## Roadmap

| # | Milestone | Scope | Status |
|---|---|---|---|
| M0 | Deterministic pipeline | dual engine implementations + real data packs + reconciliation | ✅ |
| M1 | Agent form established | LLM in the loop; chat as interface; gates as choice cards | ✅ 2026-08-22 |
| M2 | Realtime data | hotelbyte bridge + flight sources; evidence chain switches to realtime tags | ✅ 2026-08-22 |
| M3 | MVP | minimal web face + 50–200 seed users (Erhai / Phuket scenarios) | **← current — evidence open** |
| M4 | Memory & "next departure" | six-layer memory C-end domain; paired-cohort value evidence | founder-authorized parallel |
| M5 | Transaction loop | WriteGate in production; booking / payment / refunds | entry-gated |
| M6 | B2B embedding | principal/sponsor plugin with zero kernel changes | entry-gated |

The single authoritative timeline — entry/exit conditions, deliverables, and gates per milestone — is [`docs/roadmap.md`](docs/roadmap.md).

## Verify

```bash
./scripts/run-all-tests.sh                     # full-stack suite (pure TS, no Python needed)
cd ts
npx tsx scripts/evaluation-contract-tests.ts   # evaluation Phase 0 contracts (offline)
npx tsx scripts/evaluation-cadence-tests.ts    # deterministic cadence policy/planner
```

The suite covers golden engines, dialogue replay, cross-process async work-orders, plugin smoke, realtime bridges, process guards, i18n, memory domain, the Z3 concurrency gate, the fact gate, and a packaged-consumer turn-deadline E2E, among others; the authoritative section list is whatever `scripts/run-all-tests.sh` enumerates. The live session benchmark (`npx tsx scripts/sf-live-benchmark.ts --golden=static`) is opt-in, requires your connected Chrome session, and never runs in CI.

## Contributing

Branch off latest `main` (`feat/ · fix/ · docs/ · chore/`), full suite green locally, open a Pull Request — `main` never takes direct pushes. CI (Node 22/24, typecheck + all suites) plus maintainer review, then squash-merge. **Red tests never merge.** Full guide: [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports / feature suggestions: use the issue templates (search existing issues first).

## For AI Agents

If you are an agent working in this repository, [`AGENTS.md`](AGENTS.md) is the binding contract — read it first. In brief:

- **Sweep async work orders on entry**: `ts/gotry-state/async/*.json` without a matching `.deliverable.md` → `cd ts && npx tsx scripts/async-collect.ts <id>`.
- **Layer discipline**: arithmetic only in the evaluate layer of `model.ts` / `unified.py`; solving only in `unified.ts` / `unified.py`; `engine.*` / `journey.*` are deprecated compatibility layers — new code must not call them. Any side change requires the full-stack regression.
- **Never write shared state**: `ts/dsh-runtime/gotry-state/` is the founder's real product data; validate write paths with an isolated `stateRoot` only.
- **State-sync discipline**: any commit changing the system's shape/state/debt must sync the six state faces of `architecture.md` §11 in the same commit; stage only named files — never `git add -A`.

Program-level context: [`docs/gotry-master-outline.md`](docs/gotry-master-outline.md). Technical authority: [`docs/architecture.md`](docs/architecture.md).

## Documentation

| Document | Purpose |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | System, ADRs, evolution, debt ledger (Chinese, authoritative) |
| [`docs/gotry-master-outline.md`](docs/gotry-master-outline.md) | Program master outline & reuse matrix |
| [`docs/gotry-product-design.md`](docs/gotry-product-design.md) | Product design: main loop, transparency, whole-cost model |
| [`docs/roadmap.md`](docs/roadmap.md) | M0–M6 timeline & current position |
| [`docs/user-guide.md`](docs/user-guide.md) | End-user guide |
| [`docs/data-sources.md`](docs/data-sources.md) | Data sources & evidence-chain policy |
| [`docs/extension-privacy.md`](docs/extension-privacy.md) | Session Bridge extension privacy |
| [`docs/benchmark-environment-bridge.md`](docs/benchmark-environment-bridge.md) | External benchmark bridge — engineering ledger |
| [`docs/evaluation-foundation.md`](docs/evaluation-foundation.md) | Evaluation Phase 0 foundation |
| [`docs/booking-saga-fsm.md`](docs/booking-saga-fsm.md) | Booking saga FSM (the M5 seam vocabulary) |
| [`docs/kimi-postmortem.md`](docs/kimi-postmortem.md) | A real AI-travel-planning failure postmortem (cautionary tale) |
| [`docs/release-notes.md`](docs/release-notes.md) | Release decisions per version (the "why") |
| [`CHANGELOG.md`](CHANGELOG.md) | Machine-derived changelog (Keep a Changelog + Conventional Commits) |
| [`docs/tokens.md`](docs/tokens.md) | npm 2FA / release mechanics |

## License

**MIT** — same as upstream dsh. See [LICENSE](LICENSE).

---

**Built with**: DeepSeek Harness 0.1.2-alpha.3 (root-pinned) · Cordis · Z3 (WASM) · loopx (pipx) · hotelbyte-cli · Agent-Reach v1.5.0 · OpenFlights · TypeScript

**Version baseline: `v0.0.1-rc.16` (npm `latest`).** The authoritative verification gates for the current checkout are enumerated by `scripts/run-all-tests.sh`; release flow: `scripts/publish-npm.sh`.
