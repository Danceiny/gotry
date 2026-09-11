[English](user-guide.md) | [简体中文](user-guide.zh-CN.md)

# GoTry User Guide

> One line to start, chat in the browser. The LLM handles understanding you; the math solver handles verdicts and arithmetic — every number carries its evidence source.

## Getting Started (Two Ways)

**npm (recommended, no clone)**:

```bash
npx @danceiny/gotry web
# the LLM key is configured in the dsh host UI; the gotry CLI stays silent
```

> Any npm-compatible registry (npmjs / npmmirror / a company-internal mirror) can run this command; when a mirror's `latest` lags, pin an exact version (e.g. `npx @danceiny/gotry@0.0.1-rc.22 web`). Note: **inside the gotry repo directory**, use the source entry `./gotry web` instead — a bare-name npx inside the repo gets misjudged by npm exec as "already installed locally" and reports `sh: gotry: command not found`.

**Source (developers)**:

```bash
git clone https://github.com/Danceiny/gotry && cd gotry
npm ci && npm --prefix ts ci                     # root/TS pinned closure
node scripts/build-dist.mjs                      # build the source runtime
./gotry web
```

Open **http://127.0.0.1:3080** in your browser (the dsh UI; first cold start takes 6-15 seconds).

## How to Use It: The Conversation Is the Interface

No forms, no navigation — just type as if talking to a person. GoTry first asks about
missing key information (work windows / already-booked resources); every open question
is a **multiple-choice question with trade-offs**; write operations always ask you first.

### Try It: An Infeasible Dream Gets Caught

```
我想去洱海边发呆,就这周末,我在上海,预算3000,别让我早起。年假了不用办公,还没订任何东西。
```

Expected: the engine rules that "2 days cannot fit an Erhai-style unwind (conflict:
duration)" → Erhai **does not get a no**; it enters the "next departure" list
(go conditions: 5+ days / spring or autumn), and you immediately get **feasible**
alternatives (Qiandao Lake / Taihu Lake) with wake-up time, arrival energy,
door-to-door all-in cost, and the evidence chain.

### Try It: A Multi-Leg Trip with Work Windows

```
7.17周五22:40落地深圳,7.18早上去香港办银行开户;争取当天飞普吉岛,8.10周一凌晨从深圳起飞去迪拜上班前到。请给我做机票和酒店的行程规划。
```

Expected: the engine judges each leg's schedule (work windows take effect; conflicting
flights are excluded with reasons); for red-eye legs it computes "arrival energy"
instead of only looking at ticket price; resources you booked before are treated as
hard anchors — nothing gets replanned from scratch.

### Try It: A Return Visit (Cross-Session Memory)

Open GoTry a second time and say "想出去走走": it **does not re-ask** the fields you
already answered, like work windows or budget (the profile is already in the system
prompt); if a "next departure" wish you made earlier has its conditions hit, it
mentions at most 1 — and does not disturb you when nothing hits.

## Where Your Data Lives (Visible, Exportable, Deletable)

The data directory depends on how you run it: a normal source run lands in `ts/dsh-runtime/gotry-state/`; an npm-package run lands in `gotry-state/` under the invoking directory; benchmark opt-in uses an isolated invoking directory to avoid writing shared state. The authoritative write surface is the `gotry-state.db` SQLite ledger in the same directory; the JSON/JSONL files below are export views for compatibility with the old form, convenient for viewing and backup — **they never flow back into the ledger**.

| View/file | Contents |
|---|---|
| `motivation-profile.json` | Motivation profile (weights/hard constraints, each entry carrying evidence in your own words) |
| `wish-pool.json` | The "next departure" list (with go conditions; muted = dormant, not deleted) |
| `memory-utility.jsonl` | Wish utility events (recall/confirmation; attribution only counts what you said yourself) |

For troubleshooting or backup, developers can use the in-repo ledger CLI (all examples use an isolated root):

```bash
cd ts
npx tsx scripts/state-cli.ts stats --state-root <root>
npx tsx scripts/state-cli.ts export --state-root <root>       # local only: DB → legacy views
npx tsx scripts/state-cli.ts forget --state-root <root> wish <wish_id>
```

`--tenant <tenant>` is only a ledger scope parameter, not authentication or authorization. The three commands `tick` / `export` / `whatif` only support `--tenant local`: `tick` invokes the local async settlement path, `export` writes shared legacy filenames, and `whatif` is a whole-database admin snapshot rather than a tenant export; passing anything other than local is refused before creating directories, opening the database, solving, or writing files.

To delete a wish / companion / motivation profile, prefer `state-cli forget` or ask GoTry to clean up in conversation; do not treat hand-editing a legacy view as a ledger update.

**To view generated files (itinerary md, work-order deliverables) you don't have to dig through directories** — two paths:

1. Just say in conversation "看看我生成的行程 / 打开上次的规划" — GoTry lists registered artifacts with `gotry_artifacts_list`, then reads them with `gotry_artifacts_read` as a **line-numbered file view** (read-only, paginated; **the first line shows "source + full path"**, and shows the content version so a stale summary is not mistaken for new content). The public `./client` adapter renders custom list/read cards per runtime `block` in DSH Web, with clickable paths; the actual fresh-profile list→select/open→read→edit→updated-read evidence is generated by `ts/scripts/dsh-artifact-web-e2e.ts`. The workspace/sidebar file tree remains an extra preview surface. Readable scope = your gotry stateRoot + the **session working directory** (excluding `node_modules`/`.git`); **read-only text types** (`md/txt/json/jsonl/csv/log/yaml/yml`) — over 2 MB, outside the allowed directories, an extension not on the whitelist, or a symlink-escaping path all return `ok: false` with a `hint`;
2. **The dsh web sidebar workbench** (dsh-better-sidebar, the first UI component of dsh-market): expand the workbench on the right side of the `gotry web` page and click an itinerary md / work-order deliverable in the file tree to see product-grade rendering (tables/charts/PDF all supported). Install: `npx @danceiny/gotry doctor --fix` (the doctor report `gotry-state/doctor-report.md` is also previewed in this workbench); not installing it does not affect path 1.

## First-Run Onboarding (`gotry web`, issues #258/#267)

The first time `npx @danceiny/gotry web` starts on an interactive TTY, if the startup doctor finds optional capabilities that gotry *can* auto-install (the `hbcli` binary / Agent-Reach `.venv` / dsh-better-sidebar), gotry asks **exactly once**: "configure now? (y/N)". Answering `y` reuses the existing idempotent `doctor --fix` installer (no second installer is built); answering `n` continues to web immediately. Each gap is reported in one of three classes with a concrete reason — `installed` (auto-installed on this machine), `needs-user-action` (Chrome Web Store extension, `hbcli` login, FlyAI key, `dsh-calendar` profile config — never faked as automated), or `unavailable` (e.g. a bundled plugin missing → reinstall gotry). Partial failure does not block web; a later run does not reinstall already-healthy items. The retry command is `npx @danceiny/gotry doctor --fix`.

**Zero-prompt, zero-install, web still starts** under: CI, benchmark, non-TTY, fully healthy environments, `GOTRY_SETUP_SKIP=1`, the onboarding-specific opt-out `GOTRY_ONBOARDING_SKIP=1` (or `--no-onboarding`). gotry never installs during `postinstall` or in a detached background task. This is an M4 UX proof backed by deterministic isolated tests; it does not satisfy #20 real repeat-cohort Exit evidence. Full coverage including conditions and three-class results: [`docs/tools.md`](tools.md#web-startup-onboarding-258267).

## Advanced: Headless One-Shot Q&A

```bash
npx @danceiny/gotry "我想从深圳休整两天,预算3000,别早起"   # stdout gets the verdict + evidence chain
npx @danceiny/gotry help
```

## Every Number You See

| What you see | Source | Meaning |
|---|---|---|
| ¥850/person | Solver | Door-to-door all-in cost (ticket + transfers + lodging + local) |
| 06:35 wake-up | Engine computation | Home→hub + early check-in + schedule back-calculation |
| Arrival energy 84% | Energy model | 100 − wake-up penalty − transfer drain (a formula, not a guess) |
| [实时API:open-meteo] | Open-Meteo | Weather/climate, always checked before a verdict |
| [骨架:openflights] | OpenFlights | Three-valued route reachability verification (negative ≠ falsified) |
| [静态包:估算] | Manual research | Prices are estimates; verify before booking |

Flight numbers / schedules / airports / prices / policies in itinerary artifacts have an additional pre-delivery gate: before delivering an artifact containing such "bookable facts", the agent must reconcile them with `gotry_fact_gate` — each one must trace back to an **exact-date retrieval** tool result (what was found, and on which day something was not found, all go on the ledger). A schedule that cannot be found is marked "unconfirmed / currently not sellable, recheck at D-xx" — historical schedules or adjacent dates are never used to fill the gap; if the gate does not pass, the agent must not claim a "verified plan".

## Known Limitations

- Chinese first (the launch scenario is China outbound travel); an English UI comes in a later version
- Flight prices are explicitly labeled when they are estimates; real-time fares come in a later milestone
- Running many solves in a row can occasionally hit a z3 WASM memory error (just retry; registered as a known issue)
- When you hit a bug: `gotry-state/incidents.jsonl` contains incident evidence — attach it when filing an issue
