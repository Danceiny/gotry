[English](copilot-readiness-report.md) | [简体中文](copilot-readiness-report.zh-CN.md)

# Booking Copilot readiness and process cleanup report

> Role: verify runtime readiness, provider-stall timing, and process ownership for issues #506, #508, and #509.
> Status: passed locally on 2026-09-19; follow-ups #510 and #511 remain open.
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

## Scenario results

| Scenario | Required evidence and observed result |
|---|---|
| Same-port readiness and provider stall | Hold real CLI startup for 1800 ms; warmup remains pending and consumes zero model calls. After initialize, the request contains `booking_run_search`, reaches local SSE, and returns `PLANNER_PROVIDER_TIMEOUT` within 3000 ms. Worker and CLI exit on close. |
| Cold startup | Keep startup blocked. The unchanged 1500 ms turn budget returns a typed timeout before any provider call; both processes are reaped. |
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
