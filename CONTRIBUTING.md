[English](CONTRIBUTING.md) | [简体中文](CONTRIBUTING.zh-CN.md)

# Contributing — Joining Development

> *How to set up, branch, test, and submit changes. Project rule: `main` is updated through reviewed Pull Requests with local final-SHA evidence plus CI signal.*

Welcome to GoTry! GoTry is an AI travel agent "from departure to the next departure" — it answers "can I go, how do I get there, what is the true cost" with a **math solver** first, instead of letting the model guess. This document is the single authoritative contribution guide; for a quick start see the [README](README.md), and for the technical authority see [`docs/architecture.md`](docs/architecture.md).

---

## 🧭 Setup from Scratch — Setup

**Prerequisites**:

- **Node 22.15+** (`nvm install 22` or later; a hard `package.json` engines constraint)
- **npm** (both root and `ts/` use npm; `package-lock.json` pins public-registry versions)
- **pnpm** (only needed when maintaining the legacy vendored dsh runtime; not needed for normal source development)
- Optional: an LLM API key (for real-model inspection runs; all automated tests are mocked and need no key)
- Optional: a Python `.venv` (agent-reach wrapper; when missing, tests automatically degrade to needs-setup assertions)

```bash
git clone https://github.com/Danceiny/gotry
cd gotry

# ① Install dependencies
#    root pins the product surface and the DSH runtime closure; ts runs in a subshell (the cd does not leak — later commands stay at the repo root).
npm ci --strict-peer-deps
(cd ts && npm ci --strict-peer-deps)

# ② Build the JS runtime of the source checkout
node scripts/build-dist.mjs

# ③ Configure environment variables
cp .env.example .env      # fill in LLM_API_KEY (DeepSeek sk-... or an OpenAI-compatible protocol)
```

> **Why two dependency manifests**: the root `package.json` is the publish manifest of the npm package form (`@danceiny/gotry`), and it also pins all 230 DSH `0.1.5-alpha.1` runtime packages shared by the source and published forms as exact direct dependencies; the manifest, package-lock, and root pnpm importer must expose the same 230-name set — publish preverify rejects missing pins, mixed versions, and ranges. `ts/package.json` is the development manifest for the plugin source and the entire test suites. A normal source run keeps the dsh cwd at `ts/dsh-runtime/`, and real runtime state keeps landing in `ts/dsh-runtime/gotry-state/`; benchmark opt-in and npm-package runs use invoking-directory isolation. The legacy directories under `ts/dsh-runtime/vendor/` are kept only as lock-consistency evidence; at runtime everything resolves through the root dependency closure; `node_modules/` and the runtime `gotry-state/` remain ignored.

---

## 🧪 Local Verification — Verify before you push

**Must run before committing; the section numbers/suite list printed by the script are the sole authority — docs do not hard-code a `§1–N` count**:

```bash
(cd ts && npx tsc --noEmit)
node scripts/build-dist-compat-tests.mjs        # exact dist/ESM/import proof on the current Node
GOTRY_SESSION_LIVE=0 ./scripts/run-all-tests.sh   # the last line must contain ALL SUITES GREEN
```

Every PR description must paste the commands, exit codes, and key final lines from the **final SHA**. CI runs typecheck + the full-stack regression on Node 22/24, and the focused dist compatibility gate on Node 22/24/26; it can only supplement local evidence — it cannot replace a local rerun on the final SHA.

The weather regression uses a controlled deterministic fixture; real Open-Meteo/Nominatim are only variable peripheral observations and do not decide the merge gate. When live channels such as OpenSky/FlyAI are offline or rate-limited, the corresponding suites have degradation assertions; session-surface live sniffing can be turned off with `GOTRY_SESSION_LIVE=0` by default. The HotelByte supplier UAT is not controlled by that switch; it is offline by default and does not probe the local `hbcli` or credentials.

HotelByte offline regression (included in the full-stack entry by default):

```bash
GOTRY_HBCLI_LIVE=0 ./scripts/run-all-tests.sh
```

The real UAT runs only in explicitly authorized environments (it uses an isolated temporary credential surface and calls the HotelByte UAT; it is not part of the default regression):

```bash
cd ts && GOTRY_HBCLI_LIVE=1 npx tsx scripts/hbcli-e2e-tests.ts
```

`GOTRY_HOTELBYTE_SKILLS_LIVE=1` only enables the remote `hotelbyte-skills` contract read in §17; unset, `0`, or any other value runs only the local tool-description contract and does not read the GitHub keychain. `GOTRY_SESSION_LIVE` does not open the HotelByte UAT.

Run a single suite:

```bash
cd ts && npx tsx scripts/engine-tests.ts        # golden standard (§1)
cd ts && npx tsx scripts/replay.ts              # dialogue replay (mock §4)
cd ts && npx tsx scripts/ledger-tests.ts        # transaction ledger (§28)
cd ts && npx tsx scripts/z3-race-tests.ts       # Z3 concurrency race gate (§30)
cd ts && npx tsc --noEmit && npx tsx scripts/smoke.ts   # types + plugin smoke (must run after upgrades)
```

Real-LLM inspection runs (`replay-real.ts` / `time-eval-tests.ts --real`, the ADR-11 layer) **consume real keys**; maintainers run them locally — they do not enter CI.

---

## 🌿 Branching & Committing — Branch & Commit

- **`main` is the only long-lived branch**; project collaboration rules require all changes to go through Pull Requests. There is no dev/staging.
- Cut a topic branch from the latest `main`; **one branch does one thing**; naming: `feat/` · `fix/` · `docs/` · `chore/`.

```bash
git checkout main && git pull && git checkout -b fix/your-topic
```

Commit conventions (Conventional Commits; write the description in Chinese):

- Format `type(scope): one sentence that states the "why"`, e.g. `fix(D-17): Z3 WASM race 根治——单一实例+会话级互斥`.
- **The commit message focuses on motivation**: why the change, not what changed (the diff speaks for itself).
- **Stage only the specific files you own**: `git add -A` / `git commit -am` sweeping the whole worktree is forbidden — during parallel development the worktree often mixes in others' work in progress.
- **No merging with red tests**: a fully green `run-all-tests.sh` on the local final SHA is a precondition for opening a PR.

---

## 🔀 Pull Request Workflow — PR Workflow

1. Locally on the final SHA, run `(cd ts && npx tsc --noEmit)` and `GOTRY_SESSION_LIVE=0 ./scripts/run-all-tests.sh`, and record the exit codes and the `ALL SUITES GREEN` final line.
2. Behavioral, user-visible, or business-effect changes must add one minimal E2E evidence item; pure docs/index changes must give a path/link check or state the burden-of-proof for N/A.
3. Push the branch and open a PR: the description must state clearly "**why the change · what changed · final-SHA local evidence · E2E line · N/A/skipped boundaries**".
4. CI's Node 22/24 typecheck + full-stack regression and the Node 22/24/26 focused dist compatibility gate must be green, but only as supplementary signals; a maintainer review must pass.
5. For merge method and head guarding, see [`docs/ops/external-pr-workflow.md`](docs/ops/external-pr-workflow.md): the maintainer picks a merge method the repo allows, verifies the exact head, and records the destination SHA.

---

## 🐛 Issue Guide — Issues

- **Search existing issues before filing one** — avoid duplicates.
- **Bugs**: use the [Bug report template](.github/ISSUE_TEMPLATE/bug_report.yml) — repro steps / expected / actual / Node version / relevant evidence chain (lines in GoTry output carrying a `[来源标注]` source tag are the most valuable).
- **Feature requests**: use the [Feature request template](.github/ISSUE_TEMPLATE/feature_request.yml) — spell out the **user scenario** and its relationship to the "transparency mechanism" (decisions should be verifiable, never a black box).
- For environment issues, self-check first: `./gotry doctor` output, Node version, whether `.env` is in place.

---

## 🏛️ Code Discipline — Engineering rules

These are hard constraints (details in [`AGENTS.md`](AGENTS.md) and [`docs/architecture.md`](docs/architecture.md)):

- **Layering discipline**: arithmetic lives only in the evaluate layer of `model.ts`/`unified.py`; solving lives only in `unified.ts`/`unified.py`; `engine.*`/`journey.*` are deprecated compatibility layers — **new code must not call them**.
- **No TS↔Python bridge**: `py/gotry_feasibility` serves only as a historical comparison oracle, with zero references from the product runtime and toolchain; **no new Python dependency surface may be added**.
- **Red lines in code**: a motivation profile without evidence is refused persistence; wish pool entries mandate conditions; write operations (booking/payment tools) must pass WriteGate (no direct write may be implemented before confirmation exists).
- **File an ADR first for behavioral or architectural changes** (`architecture.md` §8; three birth channels: failure / reconciliation / milestone review).
- **State-surface sync**: any commit that changes the system's current shape/state/debt must synchronize the 6 state surfaces listed in `architecture.md` §11 **in the same commit**.
- **Semantic/architecture/maintenance compatibility**: semantic changes must state the user-visible differences and the minimal E2E; architectural changes must state the ADR/design concessions; maintenance changes must state the compatibility surface, the rollback surface, and which files are not changed.
- **Data red line**: inspections/tests **must not write into shared runtime state** (the founder's real data lives in `ts/dsh-runtime/gotry-state/`) — always use an isolated `stateRoot` to verify write paths.

---

## 🚢 Release — Release

Releases are founder-confirmed (whether to release and which version is confirmed by the founder; after confirmation, the executor tags / pushes the remote / publishes to npm). Contributors need not worry about this; the five release gates and the registry pull-back verification are in [`AGENTS.md`](AGENTS.md) and [`docs/release-notes.md`](docs/release-notes.md).

---

## 📜 License

MIT. Submitting means you agree to license your contribution under **MIT**, consistent with the repository license.
