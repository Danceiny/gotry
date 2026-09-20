[English](copilot-darwin-zombie-quiescence-report.md) | [简体中文](copilot-darwin-zombie-quiescence-report.zh-CN.md)

# Copilot Darwin zombie quiescence report

> Role: attribute the #518 cleanup timeout mechanism and land the verdict-by-quiescence repair.
> Status: mechanism verified at OS/runtime level; the 2026-09-19 event itself remains non-reproduced, and event-level attribution stays open in #518.
> Upstream: [copilot-cleanup-diagnostic-report](copilot-cleanup-diagnostic-report.md), [architecture](../architecture.md), [#518](https://github.com/Danceiny/gotry/issues/518).
> Downstream: Copilot runtime maintainers and regression reviewers.

## Evidence boundary

All experiments use detached process groups owned by this investigation and read-only `ps` observation of PID, PPID, PGID, state and start time. No argv, environment, provider output or request content is collected. Reproduction runs use the real core proof with the installed DSH SDK, worker, plugin and a local HTTP/SSE fixture model in isolated state directories. No real supplier, account, credential or real model was accessed. Nothing here proves browser UAT, supplier inventory or production latency.

## Mechanism and verification

The installed `@deepseek-ai/dsh-subprocess-local` `0.1.5-rc.1` Darwin fallback observes a detached worker group by polling `kill(-pgid, 0)` and maps EPERM to "alive"; its `waitForExit(signal)` resolves `false` once the caller's abort deadline fires, which `ManagedDshRunPort.close()` reported as `managed DSH process tree cleanup timeout`. The same runtime already refines zombie-only groups to quiescent on Linux (`linuxProcessGroupHasLiveMembers`); the Darwin path has no equivalent.

A controlled OS-level experiment on this host confirmed the missing half: after the last live member is killed, a group holding only an un-reaped zombie answers `kill(-pgid, 0)` with EPERM (and SIGKILL also EPERM), and only the owner's reap restores ESRCH. Zombies cannot be accelerated by any signal, so under reap lag the 2000 ms deadline measures reap completion, not termination completion — a sufficient mechanism for the observed failure shape. This is a verified mechanism, not proof that the 2026-09-19 event followed it; an un-reaped live member (for example an uninterruptible state) or PGID identity reuse remain unexcluded hypotheses for that event, which is exactly what the v2 diagnostic now records.

## Change and compatibility

- The cleanup diagnostic advances to `managed-dsh-cleanup.v2`: each snapshot member gains a read-only `startedAt` (`ps lstart`) and a `zombie` flag, and the group gains `classification` (`empty` / `zombie-only` / `has-live-members`), live/zombie member counts, a start-time anchor captured once while the worker is alive, and `workerIdentity` (`match` / `mismatch` / `worker-absent` / `unknown`) so PID reuse is provable from evidence. The snapshot stays bounded (250 ms, 32 members, PID/PPID/PGID/state/start time only) and stays failure-path only.
- `ManagedDshRunPort.close()` keeps the unchanged grace and deadline. When the observation deadline expires, it now verifies quiescence through the same safe snapshot: a group with no live member is a completed cleanup (zombies only disappear when their owner reaps them); any non-zombie member — or an unobservable group — still fails with the v2 diagnostic. Non-Darwin verdicts and sticky-failure semantics are unchanged.
- A `groupObserver` constructor seam (same style as `workerPath`) lets proofs stage verdicts without signalling real processes; the real path always uses the ps snapshot.

No runtime dependency, deadline, grace or assertion was relaxed. Rollback is the diagnostic module, the run-port verdict and the proofs together; v1 consumers see only the new schema version string.

## Reproduction matrix

All runs on this host use the official Node 22.23.2 darwin-arm64 build (tarball SHA-256 `61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6`) with isolated state directories. The historical timeout did not reproduce: on pre-fix main, one standalone run, six sequential runs under sustained fork churn (two bounded churn processes) and four runs under doubled churn all passed with zero cleanup timeouts; three runs under six saturated CPU spinners failed with a different, earlier shape — the first planner turn returned an `error` decision instead of `operation`, before any cleanup — recorded as a load-tolerance boundary of the core proof, not #518. Four churn-loaded runs on the repaired branch passed. The original event carried no PID evidence, so event-level attribution remains open; a recurrence now records zombie-only versus live-member classification and start-time identities.

## Validation matrix

- `npx tsc --noEmit` and `npx tsx scripts/smoke.ts` pass on the repaired branch (Node 26.9.0 host default).
- The expanded diagnostic proof covers injected observation failures, synthetic tables (zombie-only, live, uninterruptible, empty, reused identity), a real live holder keeping a real zombie in its own group, and close verdicts: zombie-only and empty groups complete cleanup, a live member still fails with the typed diagnostic, and the real runtime still reaps every tree.
- `managed-dsh-run-port-proof`, planner/plugin/readiness/warmer proofs and the real core proof pass on the repaired branch under Node 22.23.2 and the host default.
- Final full regression on the repaired branch: exit 0, `ALL SUITES GREEN`, 583 seconds on Node 22.23.2; log SHA-256 `6a1ba839a2160071010612c9f852daf750b0527de2373ce3b208835f9f94f8bb`.
