[English](flyai-drain-bounded-report.md) | [简体中文](flyai-drain-bounded-report.zh-CN.md)

# FlyAI stderr drain bounded report

> Role: close out #516 — after the FlyAI CLI main process exits, descendants still holding the stderr pipe can no longer make `flyaiSearch` wait without bound, and the process-tree policy no longer lives in a per-helper copy.
> Status: mechanism delivered and regression-locked; no real FlyAI endpoint, account, or model was touched.
> Upstream: [architecture](../architecture.md), [effect policy](../design/effect-interpreter.md), [#516](https://github.com/Danceiny/gotry/issues/516), [#514](https://github.com/Danceiny/gotry/issues/514), [#523](https://github.com/Danceiny/gotry/pull/523).
> Downstream: capability maintainers (flyai / hbcli / anything) and PR reviewers.

## Resource ownership (single boundary, no per-helper policy)

| Resource | Owner | Bound |
| --- | --- | --- |
| CLI main process lifecycle | `spawnBounded` (`capabilities/spawn-bounded.ts`, shared with hbcli/anything) | `timeoutMs` deadline → SIGKILL whole group |
| Descendant tree | Same `spawnBounded` private process group | abort → SIGTERM group → 500 ms grace → SIGKILL; bounded settlement (hard settle) |
| stdout | Temp file opened/read/unlinked per call by the flyai wrapper (issue #84 anti-truncation; kept) | file semantics, no pipe-buffer bound |
| stderr pipe after main exit | `drainMs` window (default 3 000 ms; query-tunable) | at deadline → SIGKILL group → settle `drainTimedOut` |

Before this change the same guarantee existed only as an in-file copy inside `flyai.ts`; #516's acceptance explicitly prefers reusing the repository process-group cleanup boundary. `spawnBounded` gained two opt-in knobs (`stdoutFd`, `drainMs`) plus an exit-`signal`/`drainTimedOut` result surface; hbcli/anything behavior is unchanged (their suites and `spawn-bounded-abort-tests` stay green on the same defaults).

## Exit reason vs drain timeout (no success fact from incomplete collection)

`FlyaiLocalTermination` gains `drain-timeout`. When the main process has already exited (its exit code is preserved in the message) but the pipe did not release within `drainMs`, the group is killed and the call fail-closes: verdict `error`, `retryable: false`, `options` never exposed, and the classification runs before any HTTP text scan — a stale `429 Trial limit` printed before the drain deadline cannot be relabeled `needs-setup`. The registered tool writes no inventory facts on this path. A release inside the window keeps plain exit-0 semantics (`hit`), so the drain window itself does not invent failures.

## Regression lock (real registered tool entry)

`ts/scripts/flyai-tests.ts` case 1d runs through `apply` → `gotry_flyai_search` → production effect with a real fake CLI child tree:

- pipe-holding descendant (`sleep 30 &`, valid hit payload, exit 0): returns within bound (≥ drainMs, < 3.5 s), `localTermination: 'drain-timeout'`, zero facts, holder PID confirmed dead by read-back, no stdout temp-file leak;
- drain timeout carrying stale 429 text: one attempt, verdict `error`, no `setup` guidance;
- within-window release (`sleep 0.2 &`): `hit` with its typed positive fact — bounded normal exit preserved.

The signal, deadline, spawn-failure, and empty-exit forms keep their case 1c single-attempt fail-closed locks on the same shared boundary.

## Validation

- `npx tsc --noEmit` exit 0; `flyai-tests` (incl. 1b/1c/1d) green ×4 consecutive runs; `spawn-bounded-abort-tests` 8/8; `hbcli-tests` 8/8; `anything-tests` 7/7; `smoke` OK (isolated stateRoot).
- Full regression and the Node 22/24 matrix run on the delivery PR CI (both full-regression jobs must be green); duration and full-log SHA-256 are recorded in the PR and the issue comment.
- No deadline was relaxed to mask a hang: every bound above is a settle bound, and the hung-descendant fixture is asserted to terminate, not skipped.

## Reproduction

```sh
(cd ts && npx tsc --noEmit)
(cd ts && npx tsx scripts/flyai-tests.ts)
GOTRY_SESSION_LIVE=0 GOTRY_HBCLI_LIVE=0 GOTRY_HOTELBYTE_SKILLS_LIVE=0 GOTRY_LAVISH_LIVE=0 bash scripts/run-all-tests.sh
```

## Remaining limits

- A descendant that escapes the process group (e.g. `setsid`) is outside group signalling; this is the documented `spawn-bounded` boundary — callers needing stronger proof must read back known PIDs (case 1d does).
- On win32 `spawnBounded` detaches unconditionally, whereas the old flyai copy spawned non-detached there; win32 is not a tested platform for this repository (CI is Linux, development is Darwin).
