[English](copilot-cleanup-diagnostic-report.md) | [简体中文](copilot-cleanup-diagnostic-report.zh-CN.md)

# Copilot cleanup diagnostic report

> Role: verify failure attribution and preservation for the process cleanup investigation.
> Status: implemented; original cleanup timeout remains unresolved in #518.
> Upstream: [architecture](../architecture.md), [#518](https://github.com/Danceiny/gotry/issues/518).
> Downstream: Copilot runtime maintainers and regression reviewers.

## Evidence boundary

The core proof runs the installed DSH SDK, worker, CLI, GoTry plugin and local HTTP/SSE provider in isolated HOME and state directories. It exercises the runtime end to end. The diagnostic proof uses real controlled worker trees with injected observation failures. It verifies the error contract, not a reproduction or repair of the historical timeout. Neither proves browser UAT, real supplier inventory, model quality or production latency.

## Failure and decision

The failed main-integration run used Node 22.23.2 and ended after 736.98 seconds with exit 1 and `REGRESSION FAILED`. Its log SHA-256 is `17b3de0579b43b5f44ddefb58c579057711dcba240d4fbfab6c64d90fc60ba1b`. The visible stack reached the ordinary planner's `close()` in the core proof's `finally`; the nested cause was a managed process-tree cleanup timeout. The source matched main `01b110a4219aa6d25586df844017f9d66675be89`.

That log lacked process identity and could hide an earlier body error. On macOS, the installed subprocess runtime observes a detached process group; lack of observed quiescence does not identify the remaining process or prove its cause. A passing rerun alone does not resolve the failure.

## Change and compatibility

- The private worker protocol reports its own PID and parent PID. The wrapper accepts the first valid direct-child identity. Missing or non-direct identities remain unknown.
- Task and warmer cleanup errors carry separate role labels, worker outcome, elapsed time, existing deadline and grace, plus a bounded process-group snapshot. Only PID, PPID, PGID and process state are retained; no argv, environment, provider stderr or request content.
- The failure-only snapshot has a separate 250 ms observation budget, at most 32 returned members, and explicit unavailable/unsupported states. Group inspection is supported only for the installed Darwin detached fallback; Linux native scopes and Windows Jobs are explicitly unsupported. The PGID is the expected group, not a guarantee that escaped descendants are contained or that PID reuse is impossible. Safe snapshot JSON stays in the error message so nested default error logs retain its values.
- The existing 500 ms TERM-to-KILL grace and 2000 ms default cleanup deadline stay unchanged. A failed close remains failed and sticky. The derived worker outcome is observed even if range observation fails, retaining the safety also tracked in [#513](https://github.com/Danceiny/gotry/issues/513).
- The core proof preserves the body error first and attempts later cleanup operations in dependency order. The local fixture server closes its connections; isolated state is removed only after successful cleanup, otherwise its retained path is logged. A bounded child control verifies masking, ordered error retention and state retention. It uses the same Node executable as the parent test.

No runtime dependency, vendor fork, transaction capability or architectural boundary changes. Rollback is the diagnostic/worker protocol and test change together; older workers remain compatible with unknown PID diagnostics. Architecture §11 current shape, roadmap and milestone gates remain unchanged; this report and the documentation index own the new evidence.

## Validation matrix

Base: `01b110a4219aa6d25586df844017f9d66675be89`. Locked installs at the root and `ts/`; macOS arm64; Node 22.23.2 and 24.16.0. Logs are retained in the local engineering evidence bundle and summarized on the issue.

| Check | Result and limit |
|---|---|
| Old main wrapper, same real-tree diagnostic proof | Expected exit 1 at the missing typed diagnostic assertion; actual child tree is still cleaned. |
| Injected timeout and rejected observation | Exit 0 on Node 22 and 24; role and worker identity retained, no private error text, repeated close is sticky, real worker/grandchild reaped. This is fault injection. |
| Body plus two cleanup failures | Bounded child process verifies old masking and new ordered error retention; every later cleanup attempt executes; failed cleanup retains isolated state. |
| Real SDK core, Node 22 | Root runs exit 0 in 11.99 and 12.14 seconds. The second uses the portable Node executable selection. After review fixes, another root run passed in 9.53 seconds, including state retention and nested-error logging controls. Historical cleanup failure did not recur. |
| Real SDK core, Node 24 | Exit 0 in 9.90 seconds before review refinements and 13.69 seconds afterward; same core log digest as Node 22. The reviewed diagnostic proof also passed in 5.97 seconds. |
| Typecheck and dist compatibility | Exit 0 for typecheck (4.48 seconds) and dist compatibility (3.88 seconds). |
| Complete regression | Precommit candidate exit 0 in 873.54 seconds; final line `ALL SUITES GREEN`. Final-commit evidence is recorded on the linked issue/PR. |

Old-wrapper negative-control log SHA-256: `04867b22c1d1a3373f49382014edd2dcb027d0308c561638b18d113ba7d5d913`. Node 22 diagnostic log: `f35906fd42089060b4a85d8151cd06010c888fabf0717cd68e61c95a4e99122a`. Both root Node 22 core logs: `c48aeb391d5c39136a369a7b8823943e8c89943ce380d6791c10a9f86baaf6a2`.

Precommit full log SHA-256: `bb15d2d598f06179a208eb74268495daf10e9d98948f8cce3690cc8d5a0972bd`. Completed at `2026-09-19T14:29:23.375253+00:00`. This gate covers the frozen runtime/test sources; the report records its result afterward. The final-commit rerun remains a PR prerequisite.

## Reproduction and remaining gate

Select the intended Node binary in PATH, create a temporary HOME, and keep all live flags at 0. Do not run these checks against the founder's shared state.

```sh
(cd ts && npx tsc --noEmit)
node scripts/build-dist-compat-tests.mjs
(cd ts && npx tsx scripts/managed-dsh-cleanup-diagnostic-proof.ts)
(cd ts && npx tsx scripts/booking-copilot-dsh-core-proof-tests.ts)
GOTRY_SESSION_LIVE=0 GOTRY_HBCLI_LIVE=0 GOTRY_HOTELBYTE_SKILLS_LIVE=0 GOTRY_LAVISH_LIVE=0 ./scripts/run-all-tests.sh
```

The original timeout still needs a diagnostic-bearing reproduction identifying the role, outcome and surviving group members. Keep #518 open until that evidence supports a repair and final regression. The independent #510 terminal-state and #511 package-startup investigations retain their own acceptance requirements.
