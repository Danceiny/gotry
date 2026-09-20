[English](flyai-supplier-acceptance-report.md) | [简体中文](flyai-supplier-acceptance-report.zh-CN.md)

# FlyAI supplier acceptance report

> Role: product acceptance evidence and limits for the FlyAI integration.
> Status: frozen（2026-09-20）
> Upstream: [supplier contract](../design/flyai-supplier-skill-design.md), [#521](https://github.com/Danceiny/gotry/issues/521).
> Downstream: maintainers reviewing the integration and its regression gate.

## Decision and environment

The installed-product controlled E2E passed all nine scenarios below. This proves setup persistence, model-visible tools and results, and inventory error boundaries through real GoTry and dsh processes. Live anonymous official CLI observations are separate supporting evidence. Formal-key read-only acceptance was completed by the follow-up live retest below; live model quality, booking and payment remain unaccepted.

Runtime source: `e8925001084b9f1234ef09a504c04c183edaa81d`. Node `24.10.0`, package `0.0.1-rc.24`, dsh `0.1.5-rc.1`, official FlyAI CLI pinned to `1.0.16`. A packed tarball was installed into a separate temporary consumer with a locked dependency graph; all 232 dsh packages passed closure verification. Tarball SHA-256: `a43794bf4d8cc082c6317473c69a51e9a9e96bb1111b4993bc177b8cd3f65970`.

Every scenario uses a fresh HOME, DSH_HOME and working directory. The controlled CLI receives a synthetic key and validates its source. A local SSE model relay issues real tool calls and records the actual observations returned by dsh. A process-scoped sleep assertion keeps test timing meaningful. No founder state or real credentials were changed.

## Installed-product results

| Scenario | Required observation | Result |
|---|---|---|
| Local setup and restart | Hidden/stdin candidate verified before save; mode 0600; fresh status and doctor read config; model status/check show verified config; key absent from output/history | Pass |
| All eight search kinds | One real tool call per kind; pinned CLI arguments; structured fields, images, links, units and masked prices reach the model | Pass |
| Transfer flight | Both segments retained; final arrival and total duration retained; summary says transfer; persisted flight fact has `nonstop:false` | Pass |
| HTTP 401 / 403 | One provider invocation each; auth-error / forbidden; zero inventory facts | Pass |
| Trial 429 | One invocation; setup guidance; zero inventory facts | Pass |
| Ordinary 429 recovery | Two invocations; second succeeds and may write a positive fact | Pass |
| Malformed / Sentinel | One invocation each; error remains visible; zero inventory facts | Pass |
| Valid empty result | One invocation; miss and a negative inventory fact | Pass |
| Local timeout | One invocation; local termination; zero inventory facts | Pass |

The success scenario also runs the setup check, so it contains nine product provider invocations for eight search kinds. Together with eight fault/empty scenarios, the harness has nine process scenarios. No fixture result is described as live availability.

## Official anonymous observations

On 2026-09-20, isolated direct calls to the actual official CLI returned ten items each for flight, train, hotel, POI, keyword, Marriott hotel and Marriott package. Flight included seven direct and three connecting itineraries. AI search first exceeded a 20-second bound; a different, narrower query subsequently returned a successful string payload under a 45-second bound. The first timeout is preserved and is not counted as a pass.

The adapter replayed the eight captured response shapes offline. This exposed previously incorrect Marriott field assumptions and nullable fields; normalized output now preserves official names, IDs, pictures, links and price text. These direct CLI calls do not prove the full installed GoTry chain against live services or a formal key.

## Defects found and retested

- [#525](https://github.com/Danceiny/gotry/issues/525): candidate keys could leak through CLI or malformed-JSON diagnostics; generic sanitized errors retain the previous config.
- [#526](https://github.com/Danceiny/gotry/issues/526): Marriott hotel/package fields differed from the old fixtures; real-shape replay and installed observations now pass.
- [#527](https://github.com/Danceiny/gotry/issues/527): connecting routes lost later legs and could be marked nonstop; both model output and persisted facts now agree.
- [#528](https://github.com/Danceiny/gotry/issues/528): the first installed run showed only a summary to the model; structured results now survive rendering without duplicating raw provider data.
- [#529](https://github.com/Danceiny/gotry/issues/529): the next run turned 401 into negative inventory; only hit/miss may now cross the fact boundary.
- [#530](https://github.com/Danceiny/gotry/issues/530): the official CLI's first run creates `~/.flyai` at 0755 with a 0600 device-id, which the save path rejected; the directory is now tightened to 0700 for the current owner while symlinks and foreign owners stay rejected, and the device-id is preserved.
- [#517](https://github.com/Danceiny/gotry/issues/517): local nonzero exit alone does not authorize retry; explicit HTTP 5xx evidence does. Focused registered-tool checks cover attempts and zero final error facts.

The initial 100 ms timeout fixture stopped Node before its event was recorded. It was replaced with a 15-second hanging fixture and a 2-second product deadline; the one-invocation assertion remains strict. Earlier failures remain in the local evidence set rather than being relabeled.

## Formal-key live retest (#530)

On 2026-09-20 the config-directory fix was retested with an authorized real key on the installed product. A tarball packed from `feat/flyai-skill-integration-521` (head `c3a4f21` plus the uncommitted fix) was installed into a clean temporary consumer; the official `@fly-ai/flyai-cli@1.0.16` ran through a recording shim, and the key reached the run only from an isolated 0600 file into a fresh HOME.

- Setup: `gotry setup flyai --stdin` verified the candidate with the official CLI, whose first run created `~/.flyai` (0755) and a 0600 device-id; the save then tightened the directory to 0700, wrote the config at 0600, preserved the device-id and wrote the 0600 verification receipt. Setup output and history contained no key bytes.
- Product: the model relay confirmed setup status/check (`verified:true`, check `hit`, receipt saved) and all eight read-only search kinds returned `hit` against the live provider (latencies 2.3–15.8 s, 44 inventory facts, directory 0700, config 0600).
- The controlled nine-scenario harness and the full local regression (`ALL SUITES GREEN`, including the harness's setup-verify budget raised from 5 s to 15 s to absorb regression-load process startup) passed at the same tree.
- Sanitized evidence, including the live receipt and a credential-leak scan, is kept in `.loopx/engineering/tick-1730-qoder-530-live-retest/`. Key-bearing temporary roots were deleted after the run; no booking or payment was attempted.

## Reproduction and merge gate

The [product harness](../../scripts/flyai-product-e2e.mjs) preserves per-case relay bodies, CLI events, stdout, stderr, fact paths and a final receipt. Install the current built tarball into a clean consumer, then run:

```sh
caffeinate -s node scripts/flyai-product-e2e.mjs /absolute/consumer/node_modules/.bin/gotry /new/evidence-directory
GOTRY_SESSION_LIVE=0 GOTRY_HBCLI_LIVE=0 GOTRY_BRIDGE_E2E_BIN=/absolute/consumer/node_modules/.bin/gotry GOTRY_BUDGET_E2E_BIN=/absolute/consumer/node_modules/.bin/gotry ./scripts/run-all-tests.sh
```

Full regression is a separate merge gate: the PR must record final-commit local typecheck, full-regression exit code and `ALL SUITES GREEN`, plus CI and review. This report does not substitute focused tests for that gate and makes no npm release claim.
