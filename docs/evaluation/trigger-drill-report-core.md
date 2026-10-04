[English](trigger-drill-report-core.md) | [简体中文](trigger-drill-report-core.zh-CN.md)

# Trigger Drill Report: Core Dormant Trackers

> Role: record what simulated external triggers prove and do not prove about the activation machinery of three dormant trackers, #82, #275 and #422.
> Status: living (2026-10-04). Simulated-trigger drills only; all three trackers stay open.
> Upstream: [#82](https://github.com/Danceiny/gotry/issues/82), [#275](https://github.com/Danceiny/gotry/issues/275), [#422](https://github.com/Danceiny/gotry/issues/422); [architecture](../architecture.md) row D-15 and section 10; [external-event-seam](../design/external-event-seam.md); [callback-party-decision-template](../design/callback-party-decision-template.md); [transactional-state-rfc](../rfc/transactional-state-rfc.md).
> Downstream: the D-15 and D-31 decision surfaces; the reviewer of run-all sections 81, 82 and 83.

## Evidence boundary

**A simulated trigger is not the real trigger.** Every result in this document is labelled `simulated_trigger_drill` / `synthetic` in the suites themselves. These drills exercise activation machinery so the path is proven before a real trigger arrives. They do not satisfy any tracker's trigger condition, do not count as real-party, real-user or real-supplier evidence, and change no admission gate. All three trackers remain open.

What counts as evidence here: real OS child processes, real SQLite files on `mkdtemp` roots, the real installed dsh SDK dispose path, the real `bin/gotry-process-liveness.js` cleanup, real process-table facts from `ps`, and the OS-level Node permission model.

What does not count: a fixture process emitting envelopes is not a sensor supply chain; N child processes are not a second user; a fixture `dshBin` is not a product callsite. No network, no model, no credentials, no listening socket, no shared state write, no new dependency, and no edit to any kernel-pinned file.

## Drill 1 — issue #82 simulated world2agent sensor

Suite: `ts/scripts/drill-w2a-sensor-tests.ts`, registered as run-all section 81. Result: exit 0, 282 assertions passed.

**Trigger simulated.** A separate OS process acts as the sensor plus local bridge. It replays a fixed synthetic plan of `w2a/0.1` envelopes as newline-delimited JSON, and delivers them two ways: through a real process-to-process stdin pipe, and through a spool file. A second OS process hosts the landed inert adapter entry (`ts/capabilities/external-event.ts`) under the Node permission model with read-only allowances.

**Activation path exercised.** Default-off across the pipeline; the exact reviewed source tuple; a hostile corpus; side-effect isolation; and a trace of where a live activation would attach.

- Default-off: with no explicit enable argument, every delivered envelope, including the benign one, is rejected `disabled-by-default` and no metadata is projected.
- Exact tuple: mutating any single one of `sensor_id`, `package`, `sensor_version`, `source_type` yields `tuple-not-allowed`; enabling with an empty allowlist still refuses.
- Hostile corpus, with identical verdicts in-process and cross-process: spoofed sender claims (`authenticated`, `signature`, `verified_by`, a forged `user_identity`), replay of the same `signal_id`, an oversized payload, a 20000-level nested payload, prototype-pollution keys at three levels, natural-language injection in `event.summary` plus an invented `event.instruction`, an unknown event type, and timestamp skew at both ends of the range. Accepted envelopes project exactly ten inert keys with `trust: 'untrusted'`, and never echo the imperative text, the identity claim, the attachment data or the opaque payload.
- Side-effect isolation: the adapter host runs with `--permission` and read-only allowances, so `fs` write, `child_process` and network are refused by the OS with `ERR_ACCESS_DENIED` rather than by a promise inside the test. On top of that: zero `fetch` calls, zero timers created, a clean prototype chain, zero files created under the isolated root, and no `gotry-state` directory ever materialised.

**The composition boundary, reported rather than wired.** The brief asked for a composition test with a benign simulated sensor event only if the contract allows it. It does not, and the suite proves why instead of inventing a path:

- The approved producer really works. On an isolated root the drill drives the landed local-probe path (`evaluateProbeResults` to `recordChannelEvent` to `readLatestChannelEvents`) and observes a persisted `down` and a latest-wins `'ok'` recovery, which is the input the tool-result routing advice reads under #436.
- The w2a metadata structurally cannot reach it. No projected field is a `channel-registry` id, and the inert metadata has no `channel` vocabulary at all. Composing `ingestExternalEvent` into `recordChannelEvent` would require inventing an event-type-to-channel mapping plus a write path. D-31 item F keeps the GoTry-side consumer at zero contract presets, and the seam's approved contract-only slice declares channel-health writes unreachable. The drill therefore reports the boundary.
- Zero product callers: a grep over `src`, `capabilities` and `scripts` finds no caller of the adapter outside the module itself and its test suites.

**Decision-template checklist (executable).** Fifteen items drawn from the callback-party decision template, each asserted against an observable repo fact: six `satisfied_by_contract`, nine `needs_real_party`.

| Classification | Items |
|---|---|
| `satisfied_by_contract` | exact tuple pinning; self-declared identity carries zero weight; events demoted to facts, never instructions; no reachable write action; no resident listener and no environment-variable product switch; unverifiable events fail closed with one stable reason each |
| `needs_real_party` | channel form; signature and channel binding; token ownership; public-registry and provenance boundary; per-source integrity digests; replay and nonce discipline; clock and freshness window; per-source event-type scoping; GoTry-side consumer registration |

**What only the real trigger can supply.** A named sensor package with a public registry entry, an identifiable owner and a reachable security contact; the provenance and integrity digests that make a reviewed tuple verifiable; the channel-form, signature-binding and token-ownership decisions (D-31); a replay or nonce store, which a pure adapter cannot have; a clock and freshness policy; a per-source event-type scope; and the chosen GoTry-side consumer. No drill can supply any of these.

**Defects found: none.** The inert contract behaved exactly as documented under every hostile input tried.

## Drill 2 — issue #275 D-15 second user and multi-writer

Suite: `ts/scripts/drill-multiuser-ledger-tests.ts`, registered as run-all section 82. Result: exit 0, 194 assertions passed. `ts/src/state-ledger.ts` was read only.

### Coverage matrix

| #275 acceptance bullet | Existing proof | Status after this drill |
|---|---|---|
| Record the triggering evidence and select one deployment topology | none | GAP, needs the real trigger. A drill cannot choose a topology. |
| Define tenant ownership, fencing token or receipt, idempotency, conflict resolution, backup and restore, rollback contracts | tenant ownership in `ts/src/state-ledger.ts` plus `ts/scripts/ledger-tests.ts` section 11; fencing and claim in `docs/design/write-gate-production-design.md` sections 5.3 and 5.4 plus `ts/src/write-gate.ts`; idempotency via the `events_idem` unique index; conflict resolution via the forward-only dispatch trigger; backup and rollback in `ts/scripts/state-repair-tests.ts` | PARTIAL. Contracts exist for a single-writer local form. The multi-writer contract, replication semantics and rollback across machines are still undefined. |
| Prove concurrent writer and stale-claim rejection with isolated state roots and crash/reopen tests | two-process claim race in `ts/scripts/write-gate-tests.ts` section 4; receipt, operation and event-sequence races in `ts/scripts/booking-copilot-*-concurrency-proof-tests.ts`; crash and resume in `ts/scripts/ledger-tests.ts` section 9 with `ts/scripts/ledger-workflow-crash.ts` | CLOSED OFFLINE by this drill, which adds: N-process (not two) claim contention; N-process concurrent appends on one tenant and on two tenants; named crash points inside one transaction; timing-varied kills on the real product write path; and a cold-open race. |
| Verify backup restore and tenant isolation end to end; fixtures do not count as production rollout evidence | offline file-copy backup with checksum rollback in `ts/scripts/state-repair-tests.ts`; tenant isolation in `ts/scripts/ledger-tests.ts` section 11 and `ts/scripts/write-gate-tests.ts` section 5 | PARTIAL. This drill adds a SQLite online backup taken under live write load, restore with checksum verification, a prefix check on the event sequence, and fold self-consistency. End-to-end production rollout evidence is excluded by the bullet's own wording. |
| Run ledger suites, isolated smoke, and full regression; sync architecture, roadmap and current-state surfaces | run-all sections 28, 29 and 68 | INTEGRATOR. The drill registers section 82; the serial full regression and the authority reconciliation belong to the integrator. |
| Litestream streaming backup | none | `needs real trigger + dependency decision`. Not installed; the drill asserts its absence so no document can claim it. |
| cr-sqlite multi-writer replication | none | `needs real trigger + dependency decision`. Not installed; absence asserted. |

### What the drill ran

- **Cold-open race (A0).** Three rounds of six processes each opening the same fresh ledger with no start gun. Safety held every time: `integrity_check` ok, no duplicated idem key, fold rebuild equal to the direct read, at least one process creating the ledger.
- **N concurrent writers (A).** Three worker processes per tenant, on one tenant and on two tenants, over a seeded ledger file. The append-only event face: every distinct idem key landed exactly once per tenant, no `(tenant_id, idem_key)` pair appeared twice, every attempt was an insert or a dedupe with zero errors, and each tenant owned exactly its own rows and read only its own rows. The read-modify-write product face (`appendWish` with one shared wish name): exactly one `added` per tenant with the rest becoming updates, one projection row per tenant under the stable name-derived id, `integrity_check` ok, and fold equal to the direct read.
- **Crash drill (B).** Four named crash points inside one transaction built through the ledger's public surface, two iterations each, every one a real `SIGKILL`: `before-transaction`, `after-event-insert`, `after-projection-write`, `after-commit`. For the three pre-commit points, zero events and zero projection rows survived; for `after-commit`, exactly one of each survived. Plus three timing-varied kills on the real product write path with a deterministic seed, after which the committed `wish.added` count always equalled the projection row count and the fold always equalled the direct read.
- **Stale claim with fencing (C).** Four dispatcher processes racing one queued outbox intent: exactly one winner, three refused with a closed-set reason, one outbox row in `dispatching`, one immutable `attempt_id`, one claim event, and zero writes from the losers. A stale dispatcher retrying after the winner is refused `not-claimable`; an expired lease does not make the intent claimable again; a direct SQL reset to `queued` is refused by the storage-level forward-only trigger rather than by an application check; and tenant-b claiming the same `idem_key` sees `missing-intent`.
- **Backup and restore (D).** A SQLite online backup taken through `better-sqlite3` while a separate process wrote continuously, then restored by copy with checksum verification. The restored snapshot passed `integrity_check`, the live source still passed it, the snapshot was never ahead of its source, no duplicated idem key survived, the snapshot event sequence was a prefix of the source sequence, and the restored fold equalled the restored direct read.

### Defects found

**Defect D15-1 (real, reported, not fixed): a concurrent first open of a fresh ledger throws an untyped `SQLITE_BUSY` out of `openDb`.**

Minimal repro: run `ts/scripts/drill-multiuser-ledger-tests.ts` section A0, or spawn six processes that each call `openDb(freshStateRoot, 'local')` with no coordination. Observed across runs: one to five of eighteen processes failed, always with code `SQLITE_BUSY`, at two callsites inside `ts/src/state-ledger.ts` `openDb` — the `pragma('journal_mode = WAL')` call and the `db.exec(SCHEMA)` call inside the schema-migration transaction. The caller receives a raw SQLite error, not a typed rejection, and no retry is attempted.

Contributing ordering fact: in `openDb`, `pragma('journal_mode = WAL')` runs before `pragma('busy_timeout = 5000')`, so the exclusive lock the WAL switch takes is held while the other connections still have no busy handler installed.

Classification: this is an input to the D-15 decision, not a main regression. D-15 states that no multi-writer path is admitted, and ADR-16 gives one-ledger-owner semantics, so the single-writer product form never reaches this race. `ts/src/state-ledger.ts` is kernel-pinned, so the drill does not touch it; the mitigation (serialise the first open, or set `busy_timeout` before `journal_mode`) belongs to the D-15 decision. The drill pins the failure code with an explicit flip message rather than making the regression red, because a red gate on a dormant unadmitted path would block the integrator without protecting any admitted contract.

**Defect D15-2 (real, reported, not fixed): the read-modify-write product path needs a caller-side retry loop that the ledger does not provide.**

`appendWish` runs a deferred read-modify-write transaction, so cross-process contention surfaces raw `SQLITE_BUSY` and `SQLITE_BUSY_SNAPSHOT` to the caller. In the drill, six processes needed six to nine caller-side retries to complete twelve attempts; without a retry loop an earlier run left two of six and eight of twelve attempts unrecovered. Safety always held — `integrity_check` ok, one wish row per tenant, fold equal to the direct read — but there is no typed rejection and no built-in retry. Same classification as D15-1: a D-15 design input, with the single-writer form unaffected.

**Observation, not a defect: the fencing token is monotonic only vacuously.** The forward-only dispatch-status trigger makes a second claim impossible, so no `fencing_token` above 1 is observable today. The design document's monotonic-increase property is therefore untestable in the current shape; a real multi-machine lease handoff would be the first thing to exercise it.

**What only the real trigger can supply.** The triggering evidence itself (a second real user, a multi-machine deployment, or an approved AaaS initiative) and the chosen deployment topology; the multi-writer and replication contract; a Litestream or cr-sqlite dependency decision and the operational evidence that follows it; cross-machine clock, lease and ownership semantics; a real lease handoff that would make the fencing token advance; and production rollout evidence, which #275 explicitly says fixtures cannot be.

## Drill 3 — issue #422 dsh SDK descendant cleanup (re-baseline)

Suite: `ts/scripts/drill-sdk-descendant-cleanup-tests.ts`, registered as run-all section 83. Result: exit 0, 42 assertions passed. No vendor or `node_modules` edit, and no upstream proposal beyond this documentation.

**Trigger simulated, and why this is a re-baseline.** The dsh family moved from 0.1.5-rc.1 to 0.2.0-rc.2 on 2026-10-02, so #422's premise needed re-measuring on the installed version. The drill drives the SDK direct transport with `profile: 'sdk-minimal'` and a fixture `dshBin`, as `scripts/booking-surface-package-proof.ts` already does. The fixture leader immediately spawns a `SIGTERM`-ignoring descendant which itself spawns a grandchild, so a direct-child-only teardown cannot pass by accident.

**Static evidence.** The installed `@deepseek-ai/dsh-sdk-client` is 0.2.0-rc.2. Its transport spawn passes no `detached` option, so the runtime is not a process-group leader; the module contains no `process.kill(-pid)` and no `setsid`, so it never signals a process group; and the dispose ladder signals the direct child handle only, `SIGTERM` then `SIGKILL`. The SDK itself documents that it runs outside any harness context and therefore spawns directly rather than through the `dsh-subprocess` service.

**Result: the #422 gap is confirmed on 0.2.0-rc.2.**

| Arm | Leader after teardown | Descendant | Grandchild | Bound |
|---|---|---|---|---|
| SDK `HarnessClient.close()`, unresponsive runtime that ignores `SIGTERM` | reaped | survives | survives | 913 ms |
| SDK `HarnessClient.close()`, cooperative runtime answering `shutdown` and exiting on stdin EOF | exits cleanly | survives | survives | 3 ms |
| SDK `DeepSeekHarness.start()` then `close()` | reaped | survives | n/a | bounded |
| Control: `bin/gotry-process-liveness.js` `spawnOwnedChild` plus `terminateOwnedChild` | reaped | reaped | reaped | 1242 ms |

Before teardown, the process table showed the leader, descendant and grandchild all sharing the drill's own process group (`pgid` 1915 for pids 1947, 1948 and 1949 in the recorded run), confirming the SDK created no private group. After the SDK dispose, the survivors were reparented to pid 1 and kept running. In the control arm the same fixture leader became its own group leader, the whole subtree shared that private group, the group was observably non-empty before cleanup and observably empty after, and zero processes survived.

The cooperative arm matters: a clean leader exit also leaves the descendant running, so the gap is one of ownership, not of signal strength. The high-level arm matters too: `DeepSeekHarness` inherits the same gap, so the gap is in the transport and not in the API layer.

**Signal and exit semantics, missing-binary semantics, no unsafe retry.** A missing `dshBin` is reported as `TransportClosedError` after 29 ms with `JSON-RPC input closed` and `exit code: 1`; because `dshBin` is launched as `node <path>`, this is not a spawn `ENOENT`, and the real `Cannot find module` cause survives only in the retained stderr tail. A direct-connect product callsite that logs only the error class would mis-diagnose a packaging failure as a protocol failure. `close()` is idempotent and terminal: a second `close()` is a no-op, `start()` afterwards is refused with `TransportClosedError`, and exactly one runtime pid existed over the whole lifecycle, so the SDK never silently respawns.

**Pinned expectations.** Every observation above is asserted with an explicit `IF THIS FLIPS, #422 premise changed` message, including the SDK version itself. If the descendant assertions read false on a future version, descendant cleanup was fixed upstream and #422 can be closed with evidence; if the version assertion fails, every other pinned result in the suite is void and must be re-measured.

**Leak discipline.** The suite tracks every pid it learns about and force-reaps all of them twice in the final `finally`, regardless of which assertion failed, then asserts that nothing it spawned is alive. The recorded run tracked fifteen fixture pids with zero survivors.

**What only the real trigger can supply.** The concrete product callsite that would put the direct-connect form into a runtime; the recorded architecture and founder decision on upstream ownership of descendant cleanup; whether the fix is upstream, a GoTry-side wrapper, or a refusal to use the direct transport; the real dsh runtime's own descendant behaviour, which a fixture cannot represent; and the package-form and full-regression verification that #422's acceptance list requires before activation.

## Reconciliation notes for the integrator

Facts that other authorities may want, listed here rather than edited into shared documents:

- `docs/architecture.md` section 10 and row D-15: three new trigger-drill suites exist at run-all sections 81, 82 and 83; the #422 gap is re-confirmed on dsh SDK 0.2.0-rc.2; two D-15 defects (D15-1 cold-open `SQLITE_BUSY` out of `openDb`, D15-2 no built-in retry on the deferred read-modify-write path) are recorded here with minimal repros.
- The trackers' own state is unchanged: #82, #275 and #422 all stay open, and no admission gate, dependency or vendor file moved.
