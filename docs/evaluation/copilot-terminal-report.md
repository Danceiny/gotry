[English](copilot-terminal-report.md) | [简体中文](copilot-terminal-report.zh-CN.md)

# Booking Copilot worker termination report

> Role: verify that a terminated managed worker cannot accept requests that hang indefinitely.
> Status: focused checks passed; full-regression gate blocked on 2026-09-19.
> Upstream: [architecture](../architecture.md), [#510](https://github.com/Danceiny/gotry/issues/510), [readiness report](copilot-readiness-report.md).
> Downstream: Booking Copilot maintainers and PR reviewers.

## Evidence boundary

This is a subprocess lifecycle regression: the production `ManagedDshRunPort` calls the installed dsh subprocess runtime and exchanges JSON lines with a controlled, real worker process. It covers OS exit, spawn failure, request settlement, and process-tree cleanup. It does not exercise a real model, browser interaction, supplier booking, or payment, and is not a feature-level business acceptance result. The full regression separately retains the existing local SDK/CLI/plugin/provider-fixture path. Tests use temporary roots; recorded validation invocations use isolated HOME and do not touch founder data.

## Finding and design

The old implementation rejected requests pending at worker exit but forgot the terminal state. A later `run` or `warmup` wrote to a dead worker and could wait indefinitely. The final negative control failed because a new run did not reject before the next `setImmediate`.

The port now records a safe terminal error before rejecting existing waiters. Later calls reject without allocating a request or writing to stdin. Normal exit and signal termination return `managed DSH worker exited`; a rejected subprocess outcome returns `managed DSH worker failed`, without forwarding the raw SDK error. Explicit close retains its existing errors and cleanup ownership. No retry, worker restart, longer deadline, or provider behavior was added.

This repairs the existing lifecycle contract under ADR-23; it does not introduce a new architecture boundary. Reconciliation against architecture §11 found no change to system shape, milestone gates, public usage, or recorded architecture debt. The evidence report and its index are the affected documentation authorities.

A related review finding is tracked as [#513](https://github.com/Danceiny/gotry/issues/513): if cleanup observation fails before the worker outcome is consumed, the old close path leaves a rejected derived promise unhandled. A supporting fault-injection test uses a real spawn-failure handle and injects only the SDK-documented cleanup rejection or timeout. The fix observes worker failure as a value immediately and only throws it after successful cleanup, preserving cleanup-error precedence. This is synthetic failure coverage, separate from the real-process scenarios below.

## Scenario matrix

| Scenario | Required observation |
|---|---|
| Natural exit 23 | An accepted request rejects; after observing exit, new run and warmup reject before the next event-loop turn. |
| External SIGKILL | An accepted request rejects; new calls reject immediately; close removes the surviving grandchild. |
| Missing working directory | Real spawn failure rejects pending and subsequent calls with the safe failure message; repeated close returns one bounded rejection. |
| Explicit close | Two pending runs and one warmup reject; subsequent calls report closed; repeated close returns the same promise. |
| Cleanup observer failure | Injected rejection and timeout preserve the outer cleanup error, return one close promise, and produce no unhandled rejection. |
| Cleanup | Worker and TERM-resistant grandchild are absent after bounded close; natural and signal exits retain idempotent cleanup. |

The immediate checks are event-loop assertions, not latency promises. Existing requests have a 1500 ms test bound; cleanup has a 2000 ms outer bound. Every potentially rejected operation receives a handler immediately.

## Validation record

Environment: macOS 26.6.2, arm64; locked npm installs at both package roots; dsh subprocess runtime 0.1.5-rc.1. Base: `7f40844`. The full attempt finished at 2026-09-19T11:34:29.019539+00:00. Recorded validation invocations use isolated HOME. The source is pushed for continuation; no PR may be opened until the final committed SHA passes the complete local gate.

| Check | Result |
|---|---|
| Original terminal behavior, Node 22.23.2 | Expected exit 1: a new run did not reject before the next `setImmediate`. |
| Original close behavior, Node 22.23.2 | Expected exit 1: injected observation rejection and timeout each produced an unhandled worker-failure rejection. |
| Three focused proofs, Node 22.23.2 and 24.16.0 | All six commands exit 0; terminal, existing pending/tree, and cleanup-failure contracts passed. |
| TypeScript and dist compatibility, Node 22.23.2 | Both exit 0. |
| Full regression, Node 22.23.2 | Exit 1, `REGRESSION FAILED`, 1078.59 seconds. FlyAI hotel fixture failed; the new Copilot proofs passed inside this run. |
| Bilingual structure, readability, whitespace | Passed. |

Production source SHA-256: `68f5cde3f4b8f57ce9e14d41f52f7fca94bd4bf425d1e524806efeef74869138`. Failed full log SHA-256: `ef84759ec88a6eeedcdc60ea32cc87a2121aaa5bf1127e65185a43035cef604b`. Production and proof source digests were unchanged throughout validation. Negative-control log digests: terminal `c857b16e4daf9282ec40d7f0c643ae20329101796bca55bf4f49a80c4ac3f518`; cleanup `7536108abb27e47f3acbf579a286e1afbf8bbf713069817b3fef45c4dfbc86ac`. Each control runs the final proof against the original port in an isolated source overlay, without replacing the working implementation.

The blocking failure is tracked in [#514](https://github.com/Danceiny/gotry/issues/514). `flyai-tests.ts:249` expected hotel malformed count `1/2`, but received `exit -1`. FlyAI was not changed in this patch. The existing helper discards the exit signal and does not record whether its 5000 ms timer fired; the old log cannot identify the cause. A later host snapshot showed load 103.81 and about 25 GB swap in use, which suggests resource pressure but does not prove the failed child timed out. Do not treat a later passing run as a root-cause fix.

An earlier full run was stopped after review found #513; it is not counted as a pass. Neither the interrupted nor failed run satisfies the final-SHA gate. Optional live HotelByte, remote skills, session/login and Lavish probes, the external STAICLI tarball, and optional Agent Reach doctor assertions remain outside this report. The historical Python oracle is not part of the regression entry.

## Reproduction and limits

```sh
(cd ts && npx tsc --noEmit)
(cd ts && npx tsx scripts/managed-dsh-terminal-proof.ts)
(cd ts && npx tsx scripts/managed-dsh-close-failure-proof.ts)
(cd ts && npx tsx scripts/managed-dsh-run-port-proof.ts)
node scripts/build-dist-compat-tests.mjs
GOTRY_SESSION_LIVE=0 GOTRY_HBCLI_LIVE=0 GOTRY_HOTELBYTE_SKILLS_LIVE=0 GOTRY_LAVISH_LIVE=0 bash scripts/run-all-tests.sh
```

Select the intended Node binary in PATH and use a temporary HOME so the regression entry cannot switch Node through the user's nvm setup. The new proof is included in the full entry. Live supplier/model acceptance remains outside this report. The independent clean-consumer SDK startup investigation [#511](https://github.com/Danceiny/gotry/issues/511) remains open; a green regression does not explain its earlier failure.

Cleanup evidence covers the managed process group tested here; it does not prove cleanup of descendants that deliberately escape that group.
