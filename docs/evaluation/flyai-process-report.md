[English](flyai-process-report.md) | [简体中文](flyai-process-report.zh-CN.md)

# FlyAI process outcome report

> Role: verify CLI termination diagnostics and their effect on registered search and inventory facts.
> Status: implementation under validation; final-commit full regression pending.
> Upstream: [architecture](../architecture.md), [effect policy](../design/effect-interpreter.md), [#514](https://github.com/Danceiny/gotry/issues/514).
> Downstream: capability maintainers and PR reviewers.

## Finding and evidence boundary

A Node 22.23.2 full regression failed at the mixed hotel fixture: the expected malformed ratio `1/2` was replaced by `exit -1`. The full run exited 1 after 1078.59 seconds. Its log SHA-256 is `ef84759ec88a6eeedcdc60ea32cc87a2121aaa5bf1127e65185a43035cef604b`. The helper discarded the exit signal and did not retain whether its 5000 ms deadline fired, so that log cannot establish the original cause.

A temporary instrumented copy demonstrated that external SIGTERM and a deadline followed by SIGKILL both mapped to `exit -1`. The mixed hotel payload returned the expected ratio; an explicit empty-output control returned a parse error. The temporary driver reused the hotel label for the empty-output case; the inputs were independently checked. These are diagnostic controls, not a reproduction of the original intermittent cause. Later host pressure and a passing baseline FlyAI suite are evidence to retain, not proof that the root cause was fixed.

This report covers the registered `gotry_flyai_search` tool, the production effect interpreter, a real isolated CLI process, result serialization, and the inventory-fact sidecar. Only the CLI is replaced by a controlled local executable. It is an end-to-end test of the local adapter and policy, with no real FlyAI network, model, account, booking, or payment acceptance.

## Contract and implementation

Every attempted CLI invocation carries a bounded `process` record: nullable `exitCode` and `signal`, boolean `timedOut`, monotonic `elapsedMs`, and an optional OS `spawnErrorCode`. Argument rejection has no process record. Diagnostics survive success, empty results, malformed data, and failures. Spawn messages, paths, arguments, environment values, and partial output are excluded from the new termination diagnostics.

`timedOut` means the configured deadline fired before exit was observed. It does not establish who sent an observed signal. The timer stops at exit; delayed stdio close is not labeled as a live-child timeout. Elapsed time includes startup and output collection through close. The existing file-backed stdout path is retained to avoid pipe truncation.

Spawn failure, signal termination, a fired deadline, and an unknown null exit return `error` before scanning partial output for 429 text. A normal nonzero CLI exit still preserves the existing quota-exhaustion classification. The effect interpreter uses the process record to prevent automatic retries for these terminal local outcomes; upstream transient-error behavior is unchanged. Error outcomes cannot produce positive or negative inventory facts.

## Validation matrix

| Scenario | Required outcome |
|---|---|
| Rejected arguments | No effect attempt, no CLI process, no process record or inventory fact. |
| Delayed stderr close | A normal child exit remains non-timeout; controlled descendants release the pipe, and process diagnostics survive. |
| Ordinary upstream HTTP 500 | Exactly two actual CLI starts, then miss and one negative fact; existing retry behavior is preserved. |
| Normal exit 23 | Exact exit code, no signal or timeout, one attempt, no inventory facts. |
| SIGTERM with 429 text | Signal outcome remains error; no quota-setup classification or automatic retry. |
| Controlled deadline | Deadline recorded separately from observed SIGKILL; one attempt and no facts. |
| Missing executable | Safe ENOENT code, no command/path/argument leakage, no retry or facts. |
| Empty stdout | Successful process exit followed by parse error, no false inventory miss. |
| Mixed hotel payload | Malformed `1/2` remains an error and writes no facts. |
| Ordinary exit 1 plus 429 | Existing needs-setup behavior remains, no inventory facts. |
| Valid miss and hit | Process diagnostics retained and appropriate exact-date facts recorded. |

## Validation record

Base: `7f4084492ee9d5acf9e41e9cc5269cb2d3e8198b`. Dependencies installed from both lockfiles with Node 22.23.2. The unchanged baseline FlyAI suite passed in 13.01 seconds; this does not resolve the historical failure. Verification uses isolated HOME and state roots, preserving founder data.

The coordinator independently ran the same controlled shell subprocess against the baseline and fix. After printing 429, the subprocess terminates with SIGTERM: the old implementation returns needs-setup and fails the invariant with exit 1; the fix returns error, signal=SIGTERM, timedOut=false and exits 0. Fixture SHA-256: `88bca8c70612da31bc80a9c339ef5527565336828ec4e7508f6d4de47e7b2724`. This falsifies the old classification behavior; it does not reproduce the original intermittent failure.

The coordinator independently reran the complete FlyAI suite, including the registered-tool process proof: Node 22.23.2 passed in 34.47 seconds and Node 24.16.0 passed in 19.35 seconds, both exit 0. Both raw textual logs have SHA-256 `65f2cd60692f403c9ec7edbba3c166868014fd07ab08934a8804d3dcfb9deaef`. The final committed SHA full gate remains pending.

A development red run only caught the incorrect expectation that an ENOENT exit code must be null; Node can preserve its -2 sentinel. It is not accepted as an old-implementation regression control. A coordinator-added fact assertion initially needed union-type narrowing; this was corrected before the passing typecheck and focused reruns.

The precommit full regression passed at `2026-09-19 12:36:59 UTC`: exit 0, 584.37 seconds; typecheck and dist compatibility also passed. Full-log SHA-256: `3716ff1ad90f49c527a55cadf07a577d2168ce4f22619cada0ced9259418a066`. Final committed-SHA revalidation is recorded with the PR. Skips include live HotelByte UAT, the external staicli tarball, optional Agent Reach doctor, remote skills verification, and real Lavish, supplier-session and LLM paths; none is claimed as accepted.

## Reproduction and remaining limits

```sh
(cd ts && npx tsc --noEmit)
(cd ts && npx tsx scripts/flyai-process-proof.ts)
(cd ts && npx tsx scripts/flyai-tests.ts)
node scripts/build-dist-compat-tests.mjs
GOTRY_SESSION_LIVE=0 GOTRY_HBCLI_LIVE=0 GOTRY_HOTELBYTE_SKILLS_LIVE=0 GOTRY_LAVISH_LIVE=0 bash scripts/run-all-tests.sh
```

Choose the intended Node binary in PATH and a temporary HOME. The FlyAI suite invokes the process proof, so the existing full-regression entry includes it. No longer deadline, automatic retry, or weaker malformed/fact assertion was introduced. These checks cover the controlled immediate CLI, not cleanup of arbitrary descendants inheriting its stdio. The original uninstrumented failure remains unexplained; a subsequent green run alone must not close that question. A separate bounded control confirmed that both baseline and fix remain pending after 2000 ms with a 500 ms deadline when a descendant retains stderr; terminating the owned descendant releases the result. This existing drain-boundary defect is tracked by [#516](https://github.com/Danceiny/gotry/issues/516).

Architecture §11 reconciliation: the effect-policy table and this report/index change; system shape, milestone gates, and supplier-access promises do not. The repair uses existing Node APIs and adds no dependency or internal code import.
