[English](README.md) | [简体中文](README.zh-CN.md)

# GoTry

> **Body and soul — more travel, less tourism.**
> *身体和灵魂,更多旅行,更少旅游。*

GoTry is an AI travel agent for **"departure to next departure."** You say where you want to go and why; it asks what needs asking, then lets code — not the model — make the call: can you go, how, and at what true cost. Every number comes with a source; nothing is hallucinated.

[![GitHub Stars](https://img.shields.io/github/stars/Danceiny/gotry?style=social)](https://github.com/Danceiny/gotry/stargazers)
[![CI](https://github.com/Danceiny/gotry/actions/workflows/ci.yml/badge.svg)](https://github.com/Danceiny/gotry/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@danceiny/gotry)](https://www.npmjs.com/package/@danceiny/gotry)
[![License: MIT](https://img.shields.io/badge/License-MIT-informational)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.15-blue)](https://www.npmjs.com/package/@danceiny/gotry)
[![Docs](https://img.shields.io/badge/docs-architecture.md-blue)](docs/architecture.md)

**[What it does](#what-gotry-does)** · **[How it works](#how-it-works)** · **[Demo](#demo)** · **[Benchmark](#benchmark)** · **[Quick start](#quick-start)** · **[Privacy & trust](#privacy-and-trust)** · **[Status & roadmap](#project-status-and-roadmap)** · **[Contributing](#contributing)** · **[Docs](#documentation)**

## What GoTry Does

Turns "I want to go somewhere" into "can I go, how, and at what true cost?" If this weekend won't work, GoTry doesn't drop the idea — the destination is parked in a wish pool with the exact conditions that would reopen it.

- **For travelers** — it asks the right questions first (which days you can leave, departing from where, on what budget), then gives every destination a straight answer: yes, no, or why — plus the smallest change that turns a no into a yes.
- **For agent builders** — the LLM only listens, translates, and explains; numbers are computed and verdicts made by code. Every delivered number carries a source tag; writes are gated by design.

## How It Works

The model owns the language ends; deterministic code owns the numbers:

```mermaid
flowchart LR
  U(["Traveler: 'I want three relaxing days in Dali'"]) --> A
  subgraph LANG["LLM owns — language"]
    A["Motivation interview<br/>working window · bookings · departure city"] --> B["Fact extraction<br/>working-hours &amp; leave semantics"]
  end
  subgraph NUM["Deterministic TypeScript kernel — ordinary choice path"]
    C["Candidate enumeration<br/>solveChoiceSegment"] --> D["Evaluate each choice<br/>evaluateChoice · true-cost checks"] --> V["Choice verdict<br/>feasible / infeasible · recommendation"]
  end
  subgraph Z3PATH["Separate script/control-plane entry"]
    Z["solveUnified<br/>script/control-plane flight-chain · Z3"]
  end
  subgraph GATE["Gates &amp; memory"]
    E["Evidence chain<br/>every number carries a source tag"] --> F{"Fact gate"}
    F -->|"all claims trace to exact-date tools"| G["Verified itinerary delivered"]
    F -->|"unverifiable"| H["Blocked — never posed as verified"]
    I[("Wish pool<br/>saved with recall conditions")]
  end
  B --> C
  V --> E
  B -.->|"separate script/control-plane entry"| Z
  Z --> E
  V -.->|"infeasible today"| I
  I -.->|"conditions met — enumerate again"| C
  classDef llm fill:#1f6feb22,stroke:#1f6feb,color:#1f6feb;
  classDef solver fill:#2ea04322,stroke:#2ea043,color:#2ea043;
  classDef gate fill:#d2992222,stroke:#d29922,color:#9e6a03;
  class A,B llm;
  class C,D solver;
  class E,F,G,H,I gate;
```

Architecture — the sync path from chat through the kernel to the fact gate, plus the state/async control plane and the read-only data layer:

<a href="docs/assets/gotry-system-architecture.en.html">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/gotry-system-architecture.en.dark.png" />
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/gotry-system-architecture.en.light.png" />
    <img alt="GoTry system architecture — sync path from chat through TypeScript candidate enumeration, evaluation, and choice to the fact gate, with the explicit flight-chain Z3 path shown separately, plus the state/async control plane and the read-only data layer" src="docs/assets/gotry-system-architecture.en.light.png" />
  </picture>
</a>

> Interactive version: [`docs/assets/gotry-system-architecture.en.html`](docs/assets/gotry-system-architecture.en.html) (archify, showcase-validated). Layers: L2 dsh plugin · L3 `ts/src/unified.ts` kernel · L4 effect interpreter + realtime bridges · L5 loopx governance. ADRs: [`docs/architecture.md`](docs/architecture.md).

Tool groups: realtime retrieval (Fliggy official channel + your own Chrome session, read-only) · catalog · decision engine · memory · artifacts (list/read + itinerary HTML generation) · fact gate · external search · `gotry_doctor` self-check · **Lavish local review (default-off; #443)** — five `gotry_lavish_open` / `_poll` / `_reply` / `_end` / `_stop` tools bound to the host session id + absolute cwd that the host supplies, only present when the trusted `lavishAxiPackageRoot` is set to the absolute path of an installed `lavish-axi@0.1.67` package (see [Lavish configuration and lifecycle](docs/design/lavish-local.md#9-registration-into-the-product-tool-surface)). No hidden dispatch — a channel registry returns an ordered suggestion list; the model or user chooses. Per-tool contracts: [`docs/tools.md`](docs/tools.md).

The offline session benchmark marks challenge/guard truncation fail-closed; only a normally completed eight-query batch is `batch_complete`, and production cadence remains 35 seconds. The sf-summary CLI accepts symlinked or aliased entrypoint paths and produces the same validated summary as the canonical path.

External-event integration is still inert by default: the #432 W2A `w2a/0.1` adapter only validates bounded serialized core envelopes behind explicit exact tuple admission, strips opaque/free-text fields, and returns untrusted metadata. It registers no listener or consumer and performs no network, process, health, wish-pool, ledger, or booking side effect; actual sensor activation remains #82.

Persisted channel-health events also drive routing advice: the six non-hit tool results read the latest persisted health state at the tool-result boundary and exclude a channel named by either the in-session verdict state or the persisted down set. Rows with missing, unparseable, future, or retention-expired timestamps are dropped before latest-wins, so a bad row cannot hide an earlier valid down; only `down` adds a persisted exclusion (`cooldown` stays a pacing state, and recovery or expiry only ceases the exclusion), and none of it clears an in-session failure. The static persona routing card is unchanged.

Artifact discovery now covers HTML itinerary files and pages across the full list: `gotry_artifacts_list` finds top-level `.md` / `.html` / `.htm` in the working directory case-insensitively, with `offset` (zero-based nonnegative integer) and `search` (literal case-insensitive substring over `id`/`title`/filename; trim then empty = no filter; no regex/glob, body content never searched) on top of the default page size of 20 (cap 50) so a real user looking for last week's plan can enumerate every eligible artifact and find an older one by name — the model is collect → canonical-path dedupe → search filter → deterministic global sort (`updated` DESC + `(source, id, canonical path)` codepoint tie-break) → page slice, with the previous per-source `slice(0, limit)` early-trim removed so older cwd artifacts stay reachable across pages. `total` reflects the post-filter set; `nextOffset` is present only when more pages exist; an `offset` past the end returns an empty page with the known total + `truncated:false` + no `nextOffset`. `gotry_artifacts_read` keeps returning `.html` / `.htm` as source text — `lang: html`, original line numbers, full-content fingerprint and paging, under the same path/size guards. The read card is a source view: it does not parse markup, runs no script or inline event handler and fetches nothing, and the web client renders these lines as plain React text under an HTML-source header. Opening a listed HTML entry is a separate action that the client labels `Open HTML preview` (visible badge plus a note that the page's scripts may run), because it hands the file to the host's native HTML preview — that rendering is the host's behaviour, not this tool's. The registered Lavish browser feedback chain (#443 CLOSED + PR #456 merged acceptance) covers interactive editing feedback; native HTML preview proof is accepted on #448 and its persistent regression lives in `ts/scripts/dsh-artifact-web-e2e.ts` (re-runnable: `GOTRY_ARTIFACT_WEB_E2E_OUT=<dir> npx tsx ts/scripts/dsh-artifact-web-e2e.ts`).

## Demo

https://github.com/user-attachments/assets/6628c254-eba1-4017-a883-c70d22616939

*Illustrative animation-harness capture of a condensed transcript — not a real `gotry web` product UI E2E (sources: [SVG](docs/assets/demo.en.svg) · [webm](docs/assets/demo.en.webm)):*

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

> Tags: `[skeleton:openflights]` route verified against the public route DB · `[realtime:...]` pulled live seconds ago · `[static-pack:estimate]` estimate — **verify before booking**. Attached by the render layer, never the model.

## Benchmark

The same real multi-country workation prompt — with planted traps (no year given, a vague "Wan-xx", an already-resolved ambiguity) — goes verbatim to mainstream assistants; answers are archived word-for-word and scored against a ground-truth rubric ([`docs/evaluation/persona-bench/`](docs/evaluation/persona-bench/)).

| Dimension | Generic chat assistant (Kimi, 13 real turns) | OTA agent (Fliggy open platform, single turn) | GoTry contract |
|---|---|---|---|
| Calendar grounding | ✗ 2025 calendar; three user corrections, three apology-refits | ✗ derived weekdays land on the 2025 calendar — contradicting its own answer on the same page | (2)(8)(9) + time-anchor card |
| Constraint interview | ✗ zero questions; both load-bearing constraints surfaced by the user at turn 6 | △ asks sales qualifiers (budget / star level / sea view); zero must-asks | (1)(10) |
| Feasibility & time accounting | ✗ density illusion, caught by the user | ✗ HK errands + same-day flight with no time budget; an "8h" flight contradicting its own arrival time | (4) + door-to-door true cost |
| Fact provenance | △ destination research holds up | ✗ sells a defunct airline (retired 2020); every price unsourced | (3)(7)(13)(20) |
| Structure completeness | △ decent comparison table only at turn 13 | ✓✓ full skeleton in one turn — completeness is table stakes | verified completeness (fact gate) |
| Persona in one line | erudite but stateless chatter — the user ends up doing four jobs | a flawless-brochure OTA clerk — every section ends in a price table | trusted travel engineer: interview first, the solver decides, infeasible says infeasible |

> **Evidence boundary:** a qualitative comparison, not a scorecard. The Kimi/Fliggy columns summarize archived transcripts (13 turns vs one); the GoTry column summarizes repository behavior contracts. No ranking or uplift is asserted.

Single best finding: two unrelated products derived their weekdays from the 2025 calendar — calendar grounding must be a mechanism, not model luck ([postmortem](docs/research/kimi-postmortem.md)).

## Quick Start

```bash
npx @danceiny/gotry web        # → http://127.0.0.1:3080
npx @danceiny/gotry doctor     # optional-channel health check (--fix to repair)
npx @danceiny/gotry "Two recovery days from Shenzhen, budget 3000"   # headless one-shot
```

Node ≥ 22.15. LLM keys live in the dsh host UI (OpenAI-compatible endpoints included) — gotry never asks for or echoes them. Any npm-compatible registry works; pin an exact version if a mirror's `latest` lags. Inside this repo use the source entry `./gotry web` (bare-name npx fails there). Eligible launches may offer a one-time capability check; CI / non-TTY never prompts, never installs. Onboarding details + operator scripts: [`docs/tools.md`](docs/tools.md). Source install: `npm ci && npm --prefix ts ci && node scripts/build-dist.mjs` — the same pinned DSH `0.1.5-rc.1` closure as the npm package. Full-stack verify: `./scripts/run-all-tests.sh`.

## Privacy and Trust

The account-session channel reads realtime data from **your own logged-in Chrome**, under four hard rules:

1. **Login happens on the external website** — no passwords, SMS codes, or cookie values; cookie *names* only.
2. **Consent card, once per session** — refusal revokes it; master switch `sessionAccess: ask|allow|off`.
3. **Physically read-only** — a ReadGuard aborts writes at the network layer; a captcha stops the agent.
4. **Never hijacks your browser** — dedicated tabs only; tests never open windows.

One-time prerequisite: the [GoTry Session Bridge](https://chromewebstore.google.com/detail/gotry-session-bridge/oeajpiccmonococjcegddlooeeohlbgd) extension (one-click, auto-updates) — until installed, tools return `needs-extension` with the store link and spend nothing.

Trust is structural, not promised:

1. **The model translates; code decides** — no LLM feasibility verdicts or arithmetic.
2. **Every number carries a source tag** — attached by the render layer, switched honestly on degradation.
3. **No write path exists** — booking/payment tools must pass WriteGate before they ship.
4. **Unverifiable means blocked** — the fact gate never lets an untraceable claim ship as "verified"; anchors are fingerprinted.
5. **Prices fail closed** — unknown model, no guessed price; the price table changes only by PR.
6. **Your data is yours** — state under `gotry-state/`; tests run on isolated roots.

## Project Status and Roadmap
- From 2026-09-13, the embedded Booking Copilot personaPrefix now reaches the first outgoing DSH model request (#467); engineering slice only, real Booking UAT remains #142.
- For `search.run` and `search.patch`, the runtime validates the host's post-action workspace: a higher revision requires cleared hotel focus, loaded offers, shortlist, selection, and verification; an unchanged revision permits no content mutation. Missing optional fields compare safely. Maintained regressions cover this boundary; real UAT remains #142.

**v0.0.1-rc.24** on npm (`latest`). Pre-1.0: the core loop works end to end; evaluation is still at deterministic contracts and validators, with no external scores or uplift claims. External W2A events are contract-only and inert; no real sensor bridge or consumer is active yet.

**Working today** — interview → deterministic feasibility verdict → itinerary with door-to-door true cost · realtime retrieval (Fliggy + your own Chrome session, read-only) with typed, invocation-bound facts · memory (motivation, wish pool, companions, timeline) on a tenant-scoped ledger · local itinerary HTML document generation (`gotry_itinerary_render`: facts only from the session fact registry, one new file in the session working directory, never overwritten; native HTML preview proof accepted on #448, persistent regression in `ts/scripts/dsh-artifact-web-e2e.ts`) · self-check doctor with scoped, approved repair.

**Not yet** — nothing is bookable today; booking ships only behind the WriteGate user-confirmation design · live-availability evidence is still partial · the real-user cohort study has not reached its exit bar · English covers the solver output layer only.

```mermaid
timeline
  title From departure to next departure
  M0 ✅ : Deterministic pipeline — dual engines reconciled
  M1 ✅ : Agent form — chat as interface
  M2 ✅ : Realtime data — evidence tags go live
  M3 ◀ current : MVP — web face + 50–200 seed users, evidence open
  M4 : Memory &amp; next departure — wish pool · cohort evidence
  M5 : Transaction loop — WriteGate-gated booking
  M6 : B2B embedding — zero-kernel-diff sponsor plugin
```

Milestone gates: [`docs/roadmap.md`](docs/roadmap.md) · engineering state: [`docs/architecture.md`](docs/architecture.md) · per-version decisions: [`docs/release-notes.md`](docs/release-notes.md) + [CHANGELOG.md](CHANGELOG.md).

## Contributing

Branch off latest `main` (`feat/ · fix/ · docs/ · chore/`), keep typecheck + full regression green, open a PR. **Red tests never merge.** Guide: [CONTRIBUTING.md](CONTRIBUTING.md).

AI agents: [`AGENTS.md`](AGENTS.md) is the binding contract — sweep async work orders on entry · arithmetic only in the evaluate layer, solving only in `unified.*` · never write shared state (`ts/dsh-runtime/gotry-state/`) · sync the six state faces of `architecture.md` §11 in the same commit · stage named files only, no `git add -A`.

## Documentation

Documents ship as bilingual pairs (`x.md` English + `x.zh-CN.md` 中文); divergence within a pair is treated as a bug (machine-generated `CHANGELOG.md` and the tool-managed `superpowers/` namespace exempt).

| Document | Purpose |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | System, ADRs, evolution, debt (authoritative) |
| [`docs/roadmap.md`](docs/roadmap.md) | M0–M6 timeline & current position |
| [`docs/user-guide.md`](docs/user-guide.md) | End-user guide |
| [`docs/tools.md`](docs/tools.md) | Tool reference: contracts, routing, onboarding |
| [`docs/data-sources.md`](docs/data-sources.md) | Data sources & evidence-chain policy |
| [`docs/release-notes.md`](docs/release-notes.md) | Release decisions per version (the "why") |
| [`CHANGELOG.md`](CHANGELOG.md) | Machine-derived changelog |
| [`docs/README.md`](docs/README.md) | Docs conventions & full index |

## License

**MIT** — same as upstream dsh. See [LICENSE](LICENSE).

**Built with**: DeepSeek Harness 0.1.5-rc.1 (root-pinned) · Cordis · Z3 (WASM) · loopx (pipx) · hotelbyte-cli · Agent-Reach v1.5.0 · OpenFlights · TypeScript

**Version baseline: `v0.0.1-rc.24` (npm `latest`).** Verification gates: `scripts/run-all-tests.sh`; release flow: `scripts/publish-npm.sh`.

<a href="https://www.star-history.com/?repos=danceiny%2Fgotry&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=danceiny/gotry&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=danceiny/gotry&type=date&theme=light&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=danceiny/gotry&type=date&legend=top-left" />
 </picture>
</a>
