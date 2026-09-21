[English](clean-consumer-boot-diagnostics-report.md) | [简体中文](clean-consumer-boot-diagnostics-report.zh-CN.md)

# Clean-consumer SDK boot diagnostics report

> Role: advance [#511](https://github.com/Danceiny/gotry/issues/511) — the clean-consumer SDK boot failure must leave a classified record instead of a bare stack tail, and the residual timeout hypothesis must be tested with a bounded reproduction.
> Status: diagnostics strengthened and regression-locked; the original 20 088 ms timeout was **not** reproduced (30 bounded boots), so #511 stays open.
> Upstream: [architecture](../architecture.md), [#511](https://github.com/Danceiny/gotry/issues/511), [#506](https://github.com/Danceiny/gotry/issues/506), [#488](https://github.com/Danceiny/gotry/issues/488), [#518](https://github.com/Danceiny/gotry/issues/518).
> Downstream: Booking Copilot / package-proof maintainers and PR reviewers.

## Evidence boundary

Everything below runs the packaged clean consumer against a local HTTP/SSE fixture under an isolated `HOME` and an isolated consumer root. No real provider, model, account, or secret is touched, and the founder's runtime state is never written. These are local runtime proofs, not browser UAT, live supplier acceptance, or a production latency guarantee.

## Why the previous diagnostics could still be blind

The earlier instrumentation recorded phase, request count and a closed error class on the *caught* path. Three gaps remained, and the first one matches the recorded failure signature exactly.

| Observed signature | Previous behaviour | Gap |
| --- | --- | --- |
| exit 1, stdout 0 bytes, ~731 bytes of raw stderr | An error thrown asynchronously (outside the awaited call) bypassed the hooks, so Node printed its own stack | The phase and request count were lost, and `recordFailure` never ran |
| Two or more failure records | One aggregate JSON array was printed once at the end | The parent keeps a bounded stderr tail, which truncates the head — the root-cause record |
| `JsonRpcResponseError` from any JSON-RPC error response | Not in the safe-name allowlist | Degraded to `"error":"unknown"`, discarding the one useful bit |

## What changed

The clean-consumer script in `scripts/booking-surface-package-proof.ts` now installs its failure handling **before the first `await`**, so the earliest failures are classified too:

- phases follow the issue's wording: `boot` → `initialize` → `model_run` → `complete` → `cleanup`;
- `uncaughtException` and `unhandledRejection` produce the same record shape as the caught path, tagged with a `hook` field, then exit 1;
- each record is flushed on its own line as it happens, and when more than one failure exists the root cause is re-emitted last as `CORE_BOOT_FAILURE_ROOT`, so the bounded tail always carries root cause *and* phase;
- the allowlist gains `JsonRpcResponseError` (the class the SDK actually raises for error responses) and a numeric `errorCode` is recorded when present.

The proof also runs one deliberately faulted consumer boot and asserts the resulting diagnostics: exit non-zero, a parsed record carrying phase, `hook`, safe error name, elapsed time and request count, and — the point of the regression — that the record and its phase survive the parent's 256-byte stderr tail.

## Bounded reproduction campaign

Thirty bounded boots were run against the packaged consumer under three load conditions, with a fresh `dsh-home` per run. No boot failed, so the pure CPU-saturation hypothesis is not confirmed.

| Condition | Runs | Result | Boot time |
| --- | --- | --- | --- |
| Idle host, load ~7 | 10 | 10/10 pass | 366–388 ms (first run 1 909 ms) |
| Idle host, load ~14 | 10 | 10/10 pass | 350–385 ms (first run 1 144 ms) |
| Saturated host, load 150–250 | 10 | 10/10 pass | 1 120–9 245 ms |

Latency is strongly load-elastic (roughly 15–25× between the idle and saturated conditions) while correctness held throughout, which is recorded as a bounded negative rather than a fix. The saturated phase ran on the artifact before the handler-ordering change; that change only moves handler registration earlier and does not alter the happy path.

A separate observation during the campaign is a harness artifact, not the #511 bug: re-running the consumer against a *warm* `dsh-home` with the same session id fails fast with `JsonRpcResponseError: session "package-proof-core" already exists`. Discovering it is what exposed the `unknown` classification gap above. Per-invocation consumer roots are unique, so the proof is unaffected.

## Validation

Implementation base: `dbaf06fe1647c8d67559bb8274d07611bbf93cae`. Environment: macOS 27.2, arm64; locked installs at both package roots; dsh 0.1.5-rc.1, TypeScript 5.9.3, tsx 4.23.13.

| Check | Result |
| --- | --- |
| Full regression, Node 26.9.0, final tree | Exit 0, ALL SUITES GREEN, 864 s; the package proof ran its faulted-boot assertions inside this regression |
| Package proof, Node 22.23.2, final tree | Exit 0, 46 s |
| `tsc --noEmit` (ts project) | Exit 0 |
| Isolated `smoke` | SMOKE OK |
| Bilingual documentation gates | Pending the delivery commit |

Full regression log SHA-256: `321b03611ccd900d39df6fbfc1ceeb43ff8dd507deecb3a8e0bddc969934ead7`. Node 22 proof log SHA-256: `0ddd53c3dee9393c85abb074f1adf4fabeca8be2c4c5272c48a73acc5a7975ad`. Quiet campaign log SHA-256: `88d1ad5d1a588e4ce232f2ff1d59b6c36ab504fe341b89d0d503b08d1f7d829f`. Saturated campaign log SHA-256: `80f24eb07d314d82836f49329b8b1b6a16fd8605306fb6ae6fed9c1ede3158ab`. The original 2026-09-19 failure log SHA-256 remains `05112150d9ac3fb6f31344f81db33a9fc2f2f54d0838c5daa1af3a8948bdfd52`; its content was never archived, so it cannot be re-classified retroactively.

## Reproduction

```sh
(cd ts && npx tsc --noEmit)
(cd ts && npx tsx scripts/smoke.ts)
node scripts/build-dist.mjs
npx tsx scripts/booking-surface-package-proof.ts
bash scripts/run-all-tests.sh
```

## Remaining limits

- The original cause is still unknown. The recorded signature (exit 1, stdout empty, ~731 bytes of raw stderr at 20 088 ms) cannot be attributed from the surviving evidence; the strengthened record is what will attribute a recurrence to a phase, a request count and an error class.
- The campaign varied host load only. Sandbox state, filesystem latency and SDK-internal retry behaviour were held constant; the SDK's request timeout is left unbounded by the proof's options, so a stall would appear as a phase record rather than a timeout error.
- The faulted boot injects its error before `harness.start()`, so no runtime subprocess is spawned and no orphan can leak. Proving the same classification while a run is in flight would require teardown guarantees the proof does not currently assert.
- The `unknown` classification remains for error classes outside the allowlist; widening it is a deliberate, separate decision.
