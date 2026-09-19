[English](dida-runner-stop-report.md) | [简体中文](dida-runner-stop-report.zh-CN.md)

# Dida live runner stop verification

> Role: command-level evidence for Dida live-runner stop, cleanup, and opt-in gates.
> Status: frozen(2026-09-19)
> Upstream: GitHub issues #502/#504 and the GoTry repository contract.
> Downstream: `ts/scripts/session-dida-live-e2e.ts`, its regression command, and maintainers reviewing live-session evidence.

This report covers GitHub issues [#502](https://github.com/Danceiny/gotry/issues/502) and [#504](https://github.com/Danceiny/gotry/issues/504) on branch `fix/dida-live-stop-502`, based on `origin/main` at `20d728e3668d302821bad0f8687ca8ef55d29ed5`.

## Scope and implementation

The runner now requires `GOTRY_SESSION_LIVE === "1"` before it creates a browser process. It performs one `sessionDidaSearch` call, removes the rate limiter reset and retry loop, and aborts and joins the concurrent click assistant in a `finally` path before closing the browser. The implementation commit is `af1060c28e9b6c1dc40341a553093e6d21b2c8b6`.

## Reproduction and fixed command E2E

The command `cd ts && npx tsx scripts/dida-runner-stop-tests.ts` spawns the real `scripts/session-dida-live-e2e.ts` entry in a temporary overlay. The runner source is copied unchanged. The session module, browser adapter and Chrome executable are synthetic; a test-only timer preload shortens waits and a fetch trap rejects network attempts. Events record all assistant DOM evaluations, clicks, terminal results and browser close. Assertions require the assistant to have started and no new DOM evaluation dispatched after the terminal result. This run observed two clicks and two overlay evaluations before each result; the test requires at least one click, not an exact timing-dependent count.

| Case | Expected process exit | Search calls | Rate resets | Assistant cleanup | Result |
|---|---:|---:|---:|---|---|
| `challenged` | 2 | 1 | 0 | 2 clicks before result; browser closed | pass |
| `cooldown` | 2 | 1 | 0 | 2 clicks before result; browser closed | pass |
| `needs-login` | 2 | 1 | 0 | 2 clicks before result; browser closed | pass |
| `needs-extension` | 2 | 1 | 0 | 2 clicks before result; browser closed | pass |
| ordinary `error` | 2 | 1 | 0 | 2 clicks before result; browser closed | pass |
| `hit` | 0 | 1 | 0 | 2 clicks before result; browser closed | pass |
| thrown search error | 1 | 1 | 0 | 2 clicks before error; browser closed | pass |

The same command verifies the #504 gate for unset, `0`, `false`, and random non-`1` values, plus missing credentials. Each exits with code 1 before the fake browser marker is created, with zero search calls and an empty network trap. The fixed run log is `/tmp/gotry-dida-stop-502-root-e2e.log`.

## Baseline evidence

The old runner from fixed ref `20d728e3668d302821bad0f8687ca8ef55d29ed5` was executed through the same overlay with `DIDA502_RUN_BASELINE=1 DIDA502_BASELINE_REF=20d728e3668d302821bad0f8687ca8ef55d29ed5`. For `challenged`, `cooldown`, `needs-login`, and `needs-extension`, it made three searches, three rate resets, and twenty assistant clicks; the assistant continued after the terminal result. The old runner also launched the fake browser for non-empty invalid live flags and timed out, demonstrating the #504 gate defect. The baseline log is `/tmp/gotry-dida-stop-502-root-baseline.log`; it is intentionally red and is not a passing test artifact.

An early draft of the harness briefly linked the complete `node_modules` directory before writing a stub. That run was discarded after it overwrote two local Playwright files. Both files were restored from the lockfile-pinned 1.63.0 npm archive after SHA-512 verification, and the real package import was checked. The worktree dependencies were then independently installed with `npm ci`. The final harness creates an independent temporary dependency directory and checks SHA-256 for the canonical `playwright-core/package.json` and `index.js` before and after the run.

The first full-regression attempt had an incomplete worktree environment: only TS dependencies were installed, so the root build could not load TypeScript and later liveness fixtures lacked `dist`. It was stopped with exit 143 and retained as `/tmp/gotry-dida-stop-502-full-incomplete-env.log`. It is not passing evidence. Root and TS dependencies were then both installed with the CI strict-peer command before the final run. The previously failing liveness fixture passed with the complete environment.

## Environment and validation

Execution date: 2026-09-19. Environment: macOS arm64, Node 24.10.0 for focused commands and Node 24.16.0 selected by the full-regression script, TypeScript 5.9.3, tsx 4.23.13, playwright-core 1.63.0, dsh-session 0.1.5-rc.1. Dependencies came from the committed lockfile. Root independently reviewed the final diff, reran the command E2E and typecheck, and owns full-regression validation.

| Check | Observed result |
|---|---|
| Final command E2E | 12/12 scenarios pass, exit 0; 7 search outcomes and 5 opt-in cases |
| Old runner with final harness | Expected failure, exit 1; retry/reset/late-action and invalid-opt-in defects reproduced |
| TypeScript typecheck | Pass, exit 0 |
| Repository full regression | Pass, exit 0; `ALL SUITES GREEN` |
| Documentation checks | 64 bilingual pairs and 8 reader-facing files pass; whitespace check clean |

Reproduce from the implementation checkout:

```sh
npm ci --no-audit --no-fund --strict-peer-deps
cd ts
npm ci --no-audit --no-fund --strict-peer-deps
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/tsx scripts/dida-runner-stop-tests.ts
DIDA502_RUN_BASELINE=1 ./node_modules/.bin/tsx scripts/dida-runner-stop-tests.ts # expected exit 1
cd ..
GOTRY_SESSION_LIVE=0 GOTRY_HBCLI_LIVE=0 GOTRY_HOTELBYTE_SKILLS_LIVE=0 GOTRY_LAVISH_LIVE=0 bash scripts/run-all-tests.sh
```

The baseline defaults to the exact base SHA above. Full-regression log: `/tmp/gotry-dida-stop-502-full.log`. These local logs are supporting artifacts; the committed scenario table and commands preserve the reviewable evidence. Four explicit skips remain: HotelByte live UAT, the external staicli tarball proof, optional Agent Reach doctor (7 assertions), and the opt-in real Lavish probe. Other live supplier and real-LLM paths were disabled; no live-feature acceptance is inferred.

Final full-regression completion: `2026-09-19 08:40:15 UTC`. Local full-log SHA-256: `65dd68eeca04983cb917612cd71b693de187a84bf7167eeb26b2827b92515f6b`.

## Evidence boundary and remaining limitation

This is a synthetic, command-level runner E2E: it exercises the real runner entry, login-flow control, concurrent assistant, terminal exit mapping, cleanup, and strict opt-in without supplier traffic. A live supplier E2E with a real Dida account, browser login, extension bridge, and portal responses was not run because it would require user login and vendor network access. Therefore the live supplier acceptance evidence remains open separately from this deterministic regression.

The accepted scope is the runner control-flow fix for #502/#504. An already dispatched browser evaluation cannot be undone by AbortSignal; the runner stops new assistance and joins the current task. Browser startup/login failures before search, real Chrome process reaping and supplier/bridge behavior are not proven by the synthetic browser-close assertion. No test writes shared `ts/dsh-runtime/gotry-state`, `ts/gotry-state`, or `gotry-state` data.
