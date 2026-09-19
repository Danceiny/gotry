[English](dida-runner-stop-report.md) | [简体中文](dida-runner-stop-report.zh-CN.md)

# Dida live runner stop verification

> Role: command-level evidence for Dida runner stop, cleanup, and opt-in gates.
> Status: validated scenario report; final-SHA gate receipts accompany the PR.
> Upstream: [#502](https://github.com/Danceiny/gotry/issues/502), [#504](https://github.com/Danceiny/gotry/issues/504), [#515](https://github.com/Danceiny/gotry/issues/515), and the repository contract.
> Downstream: live-runner maintainers and PR reviewers.

## Scope and implementation

The runner requires `GOTRY_SESSION_LIVE === '1'` and credentials before creating its temporary profile or browser. It calls the existing `sessionDidaSearch` once, without resetting the limiter or retrying terminal results. At search completion or rejection it aborts new assistant work, immediately attempts browser close, and waits for both close and assistant completion concurrently. Each cleanup promise has a 5000 ms deadline. Incomplete cleanup produces an explicit phase-specific error and exit 1, never a successful search result.

PR [#505](https://github.com/Danceiny/gotry/pull/505) integrates main `7f4084492ee9d5acf9e41e9cc5269cb2d3e8198b`. Its two index conflicts retain the Dida, SF isolation, and Copilot readiness reports; the automatic merge also retains their regression entries. No session capability, provider protocol, persistent state, or dependency is changed.

## Scenario matrix and real boundary

The test spawns the actual runner entry from an unchanged source copy in an isolated temporary directory. Browser transport, the Chrome executable, and session responses are synthetic. The original DOM IIFE executes in `node:vm` against a minimal document/button fixture: evaluation attempts, scrolling, and actual mock button clicks have separate events. Thus an evaluation attempt is not counted as a click. Terminal cases with no button keep assistance active until search ends; the hit case proves one button click and early assistant completion.

| Cases | Required observations | Result |
|---|---|---|
| challenged, cooldown, needs-login, needs-extension, error | Exit 2; one search, zero limiter resets, zero button clicks; no DOM dispatch after the terminal event; close invoked | 5 passed |
| hit, button present | Exit 0; one search, zero resets, exactly one button click; close invoked | Passed |
| thrown search error | Exit 1; one search, zero resets, no late DOM dispatch; close invoked | Passed |
| unset, empty, 0, false, random live flag | Exit 1 before browser creation; zero search and network attempts | 5 passed |
| enabled flag with missing credentials | Exit 1 before browser creation; zero search and network attempts | Passed |
| evaluation pending until close | Close is invoked and releases evaluation; close settles; terminal exit 2 | Passed |
| evaluation never settles | Close settles; explicit `cleanup timeout: click assistance`; exit 1 | Passed |
| browser close never settles | Close invoked; explicit `cleanup timeout: browser close`; exit 1 | Passed |

All enabled cases assert the browser marker and close invocation. A network trap rejects fetch attempts. Production waits are shortened only in the temporary preload; the 5000 ms cleanup deadline becomes 200 ms, while exact error text and process exit remain asserted. Forced harness timeouts are failures, not accepted cleanup. Canonical Playwright file hashes must remain unchanged before and after each harness run.

## Independent validation and negative controls

On macOS arm64 with isolated HOME and lockfile dependencies, the coordinator independently passed all 16 scenarios on Node 22.23.2 in 11.62 seconds and Node 24.16.0 in 11.39 seconds; both exit 0. Raw textual logs share SHA-256 `39adccf333dcab13f0ab241d9d016fb508ce4ddf0fdfcecf64052bf18b5a097b`. This is command-level runner E2E, not real supplier acceptance.

The same final harness executes immutable old runner source through `DIDA502_RUN_BASELINE=1`. Base `20d728e3668d302821bad0f8687ca8ef55d29ed5` makes three searches and three limiter resets for non-hit terminal results and continues DOM evaluations after the result; nonempty invalid flags start the fake browser and time out. The old test's historical “20 clicks” label was incorrect: those were evaluation attempts, not proven clicks. The current absent-button fixture records zero clicks and separately observes the extra evaluations.

The cleanup-specific control uses old PR head `9377cf1c39e95c1d8884ace34a0c69be9541691c` and the pending-until-close fixture. Old cleanup waits for the evaluation before attempting browser close, so the runner hits the harness's 15-second timeout without a close event. The fixed runner invokes close first and returns exit 2. This directly reproduces [#515](https://github.com/Danceiny/gotry/issues/515), including the circular wait hidden by the earlier passing tests.

Precommit typecheck, dist compatibility and full regression all passed, exit 0. Full regression took 859.02 seconds, completed at `2026-09-19T12:53:30.995581+00:00`, and ended with `ALL SUITES GREEN`; log SHA-256: `8db5251862cf86e0851c71d3ec0075fa13034c9420161f216feafef9ca7270b5`. The PR records subsequent final-SHA local and CI receipts; this precommit record does not replace them.

## Reproduction

```sh
(cd ts && npx tsc --noEmit)
(cd ts && npx tsx scripts/dida-runner-stop-tests.ts)
(cd ts && DIDA502_RUN_BASELINE=1 DIDA502_BASELINE_REF=20d728e3668d302821bad0f8687ca8ef55d29ed5 npx tsx scripts/dida-runner-stop-tests.ts) # expected failure
(cd ts && DIDA502_RUN_BASELINE=1 DIDA502_BASELINE_REF=9377cf1c39e95c1d8884ace34a0c69be9541691c DIDA502_ONLY_CLEANUP_CASES=1 DIDA502_CLEANUP_CASE=pending-evaluate-released-by-close npx tsx scripts/dida-runner-stop-tests.ts) # expected failure
node scripts/build-dist-compat-tests.mjs
GOTRY_SESSION_LIVE=0 GOTRY_HBCLI_LIVE=0 GOTRY_HOTELBYTE_SKILLS_LIVE=0 GOTRY_LAVISH_LIVE=0 bash scripts/run-all-tests.sh
```

Install both root and TS dependencies with `npm ci --no-audit --no-fund --strict-peer-deps`, select the Node version in PATH, and use a temporary HOME. Full regression includes this command. Its skips cover live HotelByte UAT, the external staicli tarball, optional Agent Reach doctor, remote skills verification, and real Lavish, supplier-session and LLM paths.

## Failed attempts and limitations

An early harness draft linked canonical dependencies before writing a stub and overwrote two local Playwright files. That evidence was discarded; both files were restored from the verified lockfile archive and the worktree dependencies reinstalled independently. The current harness has separate dependencies and hash checks. An early full run with incomplete root dependencies was stopped with exit 143. The first post-main integration run was also stopped with exit 143 when the unbounded cleanup defect was found; neither is passing evidence. The previous CI head failed in the Copilot stalled-provider readiness fixture; main already contains #512's fix, so the changed head requires fresh local and CI validation.

No real Dida account, supplier response, extension bridge, or canonical session verdict classification is exercised. Those live acceptance requirements remain in [#272](https://github.com/Danceiny/gotry/issues/272). Tests prove the runner's use of the supplied verdict, not how the provider produces it. Already dispatched DOM operations cannot be undone by AbortSignal; the bound limits waiting and reports uncertainty. Browser startup/login failures before search and real Chrome process-tree reaping remain outside this runner-stop proof. Tests do not write shared product state.

Architecture §11 reconciliation: only this report and its bilingual index reflect the changed evidence. System shape, provider availability, milestone acceptance and release status are unchanged.
