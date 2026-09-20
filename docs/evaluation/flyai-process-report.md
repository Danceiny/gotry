[English](flyai-process-report.md) | [简体中文](flyai-process-report.zh-CN.md)

# FlyAI local process termination report

> Role: close out #514 — attribute the offline hotel fixture `exit -1` failure as far as the surviving evidence allows, and lock the local-termination classification the original helper could not express.
> Status: mechanism closed; the original intermittent cause is not claimed as eliminated.
> Upstream: [architecture](../architecture.md), [effect policy](../design/effect-interpreter.md), [#514](https://github.com/Danceiny/gotry/issues/514), [#516](https://github.com/Danceiny/gotry/issues/516), [#517](https://github.com/Danceiny/gotry/issues/517).
> Downstream: capability maintainers and PR reviewers.

## Finding and evidence boundary

A Node 22.23.2 full regression failed at the mixed hotel fixture: the expected malformed ratio `1/2` was replaced by `flyai@error ... exit -1` (`ts/scripts/flyai-tests.ts`). The run exited 1 after 1078.59 seconds; full-log SHA-256 `ef84759ec88a6eeedcdc60ea32cc87a2121aaa5bf1127e65185a43035cef604b`. The helper folded a null close code to `-1` and discarded both the signal and whether its 5000 ms deadline fired, so that log cannot distinguish a test-deadline kill from any other termination. This rules out calling it a hotel-parser defect or closing the issue on a green rerun.

## Diagnosis history (frozen branch)

Branch `fix/flyai-exit-diagnostics-514` (`b520eef`, `1fa6921`) ran isolated bounded controls against an instrumented copy: external SIGTERM resolved in 24 ms as `exit -1`; a 150 ms controlled deadline fired SIGKILL at 153 ms, also published as `exit -1`; the original hotel fixture returned the expected `1/2` ratio in 763 ms; an empty-output control entered the parse-failure branch. A subprocess that printed quota text and then received SIGTERM falsified the old classification: the old implementation returned needs-setup; the instrumented one returned error with the signal retained (fixture SHA-256 `88bca8c70612da31bc80a9c339ef5527565336828ec4e7508f6d4de47e7b2724`). The branch's process-record design was superseded by main's evolution and was not merged; the experiments and their boundary remain the attributable record for the original failure.

## Final mechanism

Main absorbed the requirement through [#523](https://github.com/Danceiny/gotry/pull/523) cancellation ownership and the [#531](https://github.com/Danceiny/gotry/pull/531) FlyAI skill integration (`38d56cf` fail closed on local process termination):

- The spawn helper retains exit code, `signal`, `timedOut`, `drainTimedOut`, and `cancelled`; nothing else about the command leaks into results.
- `flyaiSearch` classifies caller cancellation as verdict `cancelled`, a fired local deadline as verdict `timeout` with `localTermination: 'deadline'`, and signal/spawn/empty-exit terminations as `localTermination` — all before any HTTP text scan, so stale 429 output printed before termination cannot classify as quota needs-setup.
- Every local termination carries `retryable: false`; the effect policy retries only `retryable === true`, so a terminated invocation is never re-attempted while upstream transient errors keep their existing two-attempt budget.
- The malformed-ratio and zero-fact assertions are unchanged: malformed siblings still fail the whole response and write no inventory facts; no deadline was relaxed, no test skipped.

## Regression lock added by this closeout

The one shape #514 was opened for — termination carrying stale quota text — had code handling but no automated lock. `ts/scripts/flyai-tests.ts` case 1c now runs a controlled CLI that prints `HTTP 429 Trial limit reached` to stderr and then self-terminates: exactly one attempt, verdict `error`, `localTermination: 'empty-exit'`, `retryable: false`, and no `setup` guidance. A regression to text-first classification fails this case.

## Validation

Focused gates on the closeout tree: `npx tsc --noEmit` exit 0; the FlyAI suite including cases 1b/1c exit 0; the full regression (which wires the i18n and readability checks) ran on the identical final tree — duration, exit status, and full-log SHA-256 are recorded in the associated PR and issue comment.

## Reproduction

```sh
(cd ts && npx tsc --noEmit)
(cd ts && npx tsx scripts/flyai-tests.ts)
GOTRY_SESSION_LIVE=0 GOTRY_HBCLI_LIVE=0 GOTRY_HOTELBYTE_SKILLS_LIVE=0 GOTRY_LAVISH_LIVE=0 bash scripts/run-all-tests.sh
```

## Remaining limits

The original intermittent `exit -1` never reproduced under instrumentation; this report claims the ambiguity is eliminated, not the cause. If it recurs, the final tree attributes it in a single run — verdict `timeout` versus `localTermination` versus parse-failure. stderr inherited by descendants is bounded separately by open [#516](https://github.com/Danceiny/gotry/issues/516). No run here touched a real FlyAI network endpoint, account, or model.
