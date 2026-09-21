[English](copilot-readiness-report.md) | [简体中文](copilot-readiness-report.zh-CN.md)

# Booking Copilot readiness and process cleanup report

> Role: verify runtime readiness, provider-stall timing, and process ownership for issues #506, #508, and #509.
> Status: passed locally on 2026-09-19; the #511 attribution follows below.
> Upstream: [architecture](../architecture.md), [#506](https://github.com/Danceiny/gotry/issues/506), [#508](https://github.com/Danceiny/gotry/issues/508), [#509](https://github.com/Danceiny/gotry/issues/509).
> Downstream: Booking Copilot maintainers and PR reviewers.

## Evidence boundary

The successful flow uses the installed dsh SDK, managed worker, actual dsh CLI, GoTry plugin, and local HTTP/SSE provider fixture. It verifies readiness through timeout and process-tree cleanup. #508 uses a controlled worker fixture through the installed subprocess runtime; it proves pending rejection and process ownership, not the dsh SDK model path. Other failure cases use controlled CLI processes. These are local runtime end-to-end tests, not browser UAT, real-model quality, live supplier acceptance, or a production latency guarantee. Tests use isolated state and HOME; they do not write the founder's product data.

## Diagnosis and change

The original Node 22 CI attempt failed at `real stalled provider was not reached` after 1053 ms. Its single rerun failed at the same assertion after 1066 ms with zero model steps. See [first attempt](https://github.com/Danceiny/gotry/actions/runs/35432681703/job/105869943674) and [rerun](https://github.com/Danceiny/gotry/actions/runs/35432681703/job/105872459772). The fixture timed startup and provider stall together; it could hit the soft-stall deadline before a model request existed.

`DeepSeekHarness` construction is lazy. The old warmup acknowledged construction without awaiting `start()` and the initialize handshake. Warmup now waits for that handshake. The provider-stall test warms the same port before starting its turn timer; a separate cold-start case retains the original deadline. A disposable background warmer cannot prove another task port is ready. This finding does not establish a Node-22-only SDK defect or fix production cold-start latency.

Two lifecycle defects were also corrected: pending waiters are a `Map` and must be rejected through `Map.values()`; closing a task port must also close its background warmer before deleting their shared scratch directory. Default-preheat cleanup has its own real-process proof.

## Validation record

Implementation: `e037c7458f9901d28ab3dacadae3d56386de7e84`; base: `00c76fb5cce84a7e3ad0c27af1f2da47c688d859`. Source digests were unchanged throughout final regression. The report-only commit follows the implementation commit.

Environment: macOS 26.6.2, arm64; locked installs at both package roots; dsh 0.1.5-rc.1, TypeScript 5.9.3, tsx 4.23.13. Final validation: 2026-09-19T10:34:44.767968+00:00. Negative controls used Node 24.10.0 and restored only the behavior under test.

| Check | Result |
|---|---|
| Old readiness behavior with controlled startup | Expected exit 1: warmup reported ready before the real runtime started and initialized. |
| Old pending-waiter behavior | Independently replayed in an isolated source overlay; expected exit 1: worker-exit requests did not settle. |
| Old detached-warmer behavior | With real warmup retained and only detached cleanup restored, expected exit 1: close returned while a blocked runtime tree remained alive. |
| Targeted runtime, readiness, pending-waiter, and default-warmer tests | All four commands passed in both final Node matrices. Earlier focused readiness/core proofs also passed on Node 22.23.2 and 24.10.0. |
| Full regression, Node 22.23.2 | Exit 0, ALL SUITES GREEN; 610.29 seconds. |
| Full regression, Node 24.16.0 | Exit 0, ALL SUITES GREEN; 758.05 seconds. |
| TypeScript, bilingual structure, readability, whitespace | TypeScript exit 0; bilingual structure, readability, and whitespace checks passed. |

Node 22 full log SHA-256: `d5c199d31b8427eb2fe35d61e9f9adfad6eaf7bcd35f1afba28bc2d2360b7929`. Node 24 full log SHA-256: `b870066cb29925e88f4d5c93163e0b06406f21b043024bc4065be575a24d417e`.

An earlier full run was deliberately stopped after the independent warmer finding. The first completed Node 22 run then failed the existing clean-consumer SDK boot at 20088 ms; the new readiness, core, pending, and warmer proofs passed in that run. Neither attempt is counted as a full pass. First completed failure log SHA-256: `05112150d9ac3fb6f31344f81db33a9fc2f2f54d0838c5daa1af3a8948bdfd52`.

One isolated phase-instrumented reproduction passed. The original cause remains unresolved in [#511](https://github.com/Danceiny/gotry/issues/511); the package proof now records phase, request count and a closed error class without retries or a longer timeout. The new worker fixture is explicitly excluded from the npm package.

Explicit final-run exclusions: live HotelByte UAT; external STAICLI tarball proof (artifact not supplied); seven optional Agent Reach doctor assertions (not installed); remote hotelbyte-skills, FlyAI flight/hotel, session/login, and Lavish live probes. The regression entry no longer runs the historical Python oracle.

## Clean-consumer boot timeout attribution (#511)

The original failure left four observable facts: exit 1, 20088 ms, 0 stdout bytes, 731 stderr bytes. The log body is lost and the original environment never reproduced. Those four facts are enough to localize the stage.

- Exit 1 with zero stdout bytes means the script never reached its success branch and the error escaped uncaught; the outer `spawnSync` bound is 60000 ms, so the outer timeout did not kill it.
- The clean consumer overrides no SDK timing option, so it inherits the SDK defaults: a 10000 ms initialize deadline, a 1000 ms shutdown, a 6000 ms stdin-EOF grace and a 3000 ms SIGTERM grace (`@deepseek-ai/dsh-sdk-client` 0.1.5-rc.1 `lib/index.js` lines 185, 537, 542, 543). `DeepSeekHarness.start()` runs the whole teardown ladder before rethrowing an initialize failure.
- The four segments sum to 20000 ms. Measured three times against a runtime that never answers the handshake: `initializeMs=10001..10003`, `closeMs=10010..10038`, `totalMs=20013..20040` — within 48-75 ms of the observed 20088 ms.

So the original failure happened at the initialize handshake: the runtime did not answer within 10000 ms, and the teardown ladder then burned roughly another 10000 ms. The alternative reading needs a post-handshake segment to consume about 9000 ms by coincidence; the script had no model-request counter then, so it cannot be told apart after the fact, while the new diagnostics can tell them apart now (a zero request count means the handshake never completed). Production ports clamp the three graces to 500 ms each and run a one-shot warmup process (`ts/src/booking-surface/dsh-planner.ts`); the package proof has no warmup and keeps the defaults.

On this machine a packed clean consumer completes the handshake in 589, 958 and 1093 ms against the same budget, roughly a 9-17x margin. So "the deadline is too tight for a normal cold boot" does not hold; the original failure looks like a runtime stalled or starved for a long time — that regression ran in parallel with other suites and was the first full run. The original stderr is lost, so nothing further separates the two.

What is retained: the consumer script now writes a record straight to fd 2 at every stage and re-flushes the failure record from an uncaught-exception hook, so the "exit 1, zero stdout bytes" shape can no longer swallow the stage; the package proof also prints the stage timings of a normal boot, pins the default budget composition as an assertion, and keeps a negative control for an uncaught escape. The boot-failure diagnostic reports those records in order rather than truncating stderr from the end, because the 256-byte tail that the original log was cut to drops the earliest stages — the ones that separate a cold-boot stall from a cleanup stall; a retention control pins that the same trace survives both the tail comparison and the secret-redaction rule. [#511](https://github.com/Danceiny/gotry/issues/511) still tracks the original cause.

## Local boot budget split from the provider budget (#554)

The founder ruling of 2026-09-21 is that only an LLM call may tolerate seconds of latency: our own process start and teardown must be bounded on our own terms and must not inherit a model-side fallback. [#554](https://github.com/Danceiny/gotry/issues/554) instrumented the handshake first; the measured distribution is 2213-2386 ms for the first handshake on a cold page cache and, across 20 fresh workers with a warm page cache, min 344 / p50 385 / p95 505 / max 505 ms.

Two changes follow from that measurement. Neither touches the model-side budgets (`turnTimeoutMs` 12000 ms, `softStallBudgetMs` two thirds of it).

- **An explicit boot deadline.** Production task and warmer ports now pass `initializeTimeoutMs = PLANNER_BOOT_BUDGET_MS` (5000 ms, `ts/src/booking-surface/dsh-planner.ts`) instead of inheriting the SDK's 10000 ms model-side fallback. 5000 ms keeps more than 2x headroom over the worst cold observation and about 10x over the hot p95.
- **A typed boot failure.** A handshake that never completes is no longer reported as `PLANNER_PROVIDER_TIMEOUT`, which claimed a provider stall when no provider call had been made. The worker classifies the phase it owns (`HARNESS_BOOT_TIMEOUT` versus `HARNESS_START_FAILED` / `HARNESS_RUN_FAILED`), the port lets only that closed set cross the process boundary, and the planner returns `PLANNER_BOOT_TIMEOUT` with its own `boot_timeout` metric outcome.

Measured after the change against a runtime that never answers the handshake: with a 20000 ms turn budget, so the 13333 ms soft-stall budget is wider than the boot budget, the turn settles in **6055 ms** — the boot deadline fired, the teardown ladder added about 1000 ms, and zero provider requests were made. Under the SDK fallback the same case would land near 11 s, so the bound is live rather than merely declared. The cold-start case on a 1500 ms turn budget now reports `PLANNER_BOOT_TIMEOUT` instead of the provider code. The 5000 ms value is **a cap, not an observed cost**: observed handshakes are 0.34-2.4 s.

## Scenario results

| Scenario | Required evidence and observed result |
|---|---|
| Same-port readiness and provider stall | Hold real CLI startup for 1800 ms; warmup remains pending and consumes zero model calls. After initialize, the request contains `booking_run_search`, reaches local SSE, and returns `PLANNER_PROVIDER_TIMEOUT` within 3000 ms. Worker and CLI exit on close. |
| Cold startup | Keep startup blocked. The unchanged 1500 ms turn budget returns a typed **boot** timeout (`PLANNER_BOOT_TIMEOUT`, because the handshake never completed) before any provider call; both processes are reaped. A second case widens the turn budget to 20000 ms so only the 5000 ms boot deadline can settle it, and asserts that it does. |
| Initialize failure | Controlled CLI exit 23, signal null; warmup rejects with exactly `HARNESS_START_FAILED`. Private fixture stderr is absent from the returned error; both processes are reaped. |
| Worker exit and caller close | Each case starts two runs and one warmup, waits until the worker has received all three, and requires all promises to reject within 1500 ms. Repeated close returns the same promise; close also reaps a TERM-resistant grandchild. |
| Default background warmer | With default warmup enabled and both CLI startup gates blocked, close is bounded, rejects the task warmup, reaps both worker/CLI trees, and removes isolated scratch; repeated close returns the same promise; zero provider requests. |
| Existing core path | Actual plugin tool calls, argument repair, continuation, provider stall, and subprocess ownership remain passing. |

Final Node 22/24 observations: provider arrival 32–34 ms; typed provider timeout 1015–1016 ms; ready-tree close 98–133 ms; cold timeout 1001–1004 ms. These timings are observations, not new service objectives. Failure output records startup phase, provider request count, safe error class, and fixture process evidence without exposing raw provider stderr.

Known follow-up: after a worker has exited, **new** run/warmup requests can still hang until explicit close. This separate terminal-state defect is recorded in [#510](https://github.com/Danceiny/gotry/issues/510) and is not fixed by this change; the pending-request proof covers requests submitted before exit.

## Reproduction

After `npm ci --no-audit --no-fund --strict-peer-deps` at both package roots, run:

```sh
(cd ts && npx tsc --noEmit)
(cd ts && npx tsx scripts/booking-copilot-dsh-core-proof-tests.ts)
(cd ts && npx tsx scripts/booking-copilot-dsh-readiness-proof.ts)
(cd ts && npx tsx scripts/managed-dsh-run-port-proof.ts)
(cd ts && npx tsx scripts/booking-copilot-dsh-warmer-proof.ts)
GOTRY_SESSION_LIVE=0 GOTRY_HBCLI_LIVE=0 GOTRY_HOTELBYTE_SKILLS_LIVE=0 GOTRY_LAVISH_LIVE=0 bash scripts/run-all-tests.sh
```

To reproduce the matrix, choose the exact Node binary in PATH and use a temporary HOME, preventing the regression script's nvm setup from switching versions. Preserve the npm cache separately. All four targeted commands are part of the full regression. Readiness prewarming changes the test setup only; normal first-turn timeout semantics remain unchanged.
