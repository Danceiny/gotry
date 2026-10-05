[English](trigger-drill-report-core.md) | [简体中文](trigger-drill-report-core.zh-CN.md)

# Trigger Drill Report: Core Dormant Trackers

> Role: record what simulated external triggers prove and do not prove about the activation machinery of three dormant trackers, #82, #275 and #422.
> Status: living (2026-10-05). Simulated-trigger drills only. The three core drill trackers #82, #275 and #422 were closed on 2026-10-05 as deferred, not completed — open a new issue when a real trigger appears.
> Upstream: [#82](https://github.com/Danceiny/gotry/issues/82), [#275](https://github.com/Danceiny/gotry/issues/275), [#422](https://github.com/Danceiny/gotry/issues/422); [architecture](../architecture.md) row D-15 and section 10; [external-event-seam](../design/external-event-seam.md); [callback-party-decision-template](../design/callback-party-decision-template.md); [transactional-state-rfc](../rfc/transactional-state-rfc.md).
> Downstream: the D-15 and D-31 decision surfaces; the reviewer of run-all sections 81, 82 and 83.

## Evidence boundary

**A simulated trigger is not the real trigger.** Every result in this document is labelled `simulated_trigger_drill` / `synthetic` in the suites themselves. These drills exercise activation machinery so the path is proven before a real trigger arrives. They do not satisfy any tracker's trigger condition, do not count as real-party, real-user or real-supplier evidence, and change no admission gate. The three trackers were closed on 2026-10-05 as deferred, not completed; a real trigger needs a new issue.

What counts as evidence here: real OS child processes, real SQLite files on `mkdtemp` roots, the real installed dsh SDK dispose path, the real `bin/gotry-process-liveness.js` cleanup, real process-table facts from `ps`, and the OS-level Node permission model.

What does not count: a fixture process emitting envelopes is not a sensor supply chain; N child processes are not a second user; a fixture `dshBin` is not a product callsite. No network, no model, no credentials, no listening socket, no shared state write, no new dependency, and no edit to any kernel-pinned file.

## Drill 1 — issue #82 simulated world2agent sensor

Suite: `ts/scripts/drill-w2a-sensor-tests.ts`, registered as run-all section 81. Result on the recorded run: exit 0, 284 assertions passed. Assertion counts in this document are the observed counts of one run, not a contract; the suites gate on exit code, and the multi-writer suite in particular adds assertions only on the branches a contended host takes.

**Trigger simulated.** A separate OS process acts as the sensor plus local bridge. It replays a fixed synthetic plan of `w2a/0.1` envelopes as newline-delimited JSON, and delivers them two ways: through a real process-to-process stdin pipe, and through a spool file. A second OS process hosts the landed inert adapter entry (`ts/capabilities/external-event.ts`) under the Node permission model with read-only allowances.

**Activation path exercised.** Default-off across the pipeline; the exact reviewed source tuple; a hostile corpus; side-effect isolation; and a trace of where a live activation would attach.

- Default-off: with no explicit enable argument, every delivered envelope, including the benign one, is rejected `disabled-by-default` and no metadata is projected.
- Exact tuple: mutating any single one of `sensor_id`, `package`, `sensor_version`, `source_type` yields `tuple-not-allowed`; enabling with an empty allowlist still refuses.
- Hostile corpus, with identical verdicts in-process and cross-process: spoofed sender claims (`authenticated`, `signature`, `verified_by`, a forged `user_identity`), replay of the same `signal_id`, an oversized payload, a 20000-level nested payload, prototype-pollution keys at three levels, natural-language injection in `event.summary` plus an invented `event.instruction`, an unknown event type, and timestamp skew at both ends of the range. Accepted envelopes project exactly ten inert keys with `trust: 'untrusted'`, and never echo the imperative text, the identity claim, the attachment data or the opaque payload.
- Side-effect isolation: the adapter host runs with `--permission` and read-only allowances, so `fs` write and `child_process` are refused by the OS with `ERR_ACCESS_DENIED` rather than by a promise inside the test. The network is a weaker claim and is stated as such: the Node permission model has no portable `net` scope across the versions this repo runs on, and `process.permission.has('net')` reports it absent even on the Node 26 host where the connect was still refused with `ERR_ACCESS_DENIED`. The suite therefore gates only on "no outbound connection succeeded", accepts `ECONNREFUSED` as well, and credits the permission model with the refusal only when `has('net')` reports the scope enforced. On top of that: zero `fetch` calls, zero timers created, a clean prototype chain, zero files created under the isolated root, and no `gotry-state` directory ever materialised.

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

Suite: `ts/scripts/drill-multiuser-ledger-tests.ts`, registered as run-all section 82. Result on the recorded run after the D15 fixes: exit 0, 240 assertions passed (the count varies with how much contention the host produces, because the liveness branches add assertions only when they are taken). The drill no longer reads `ts/src/state-ledger.ts` only: the founder decided on 2026-10-05 to fix the two defects it found, so the kernel file changed and the drill's D15 expectations are flipped to gated assertions.

Safety and liveness are separated on purpose. The gating assertions are the ones that must hold on any host at any speed: `integrity_check`, no duplicated `(tenant_id, idem_key)` pair, the ledger holding exactly the rows the workers believe they wrote, the accounting identity over every attempt, tenant isolation, and fold equal to the direct read with a non-vacuous row count. How many attempts a slow shared runner gets through, and which SQLite contention codes it sees, is reported through observations and never gated — a dormant unadmitted path must not be able to turn the regression red. Failure codes are checked against a known contention set rather than pinned to one literal, so a code outside that set still reads as a new failure mode.

Two mechanical notes that make the evidence real rather than nominal. The fold check copies the `-wal` and `-shm` sidecars with the database file: the ledger runs in WAL mode and these victims are `SIGKILL`ed, so nothing checkpoints, and copying only `gotry-state.db` would compare an empty projection against an empty projection and pass vacuously. Every fold assertion is therefore paired with an event-count equality against the in-place read; for the `after-commit` crash point the copy carries the one committed event, which is the proof the sidecar travelled. The suite-level time bound is a diagnostic backstop sized well above the real cost, not a performance assertion, and its timeout path reaps the child set and removes the temp root itself, because `process.exit` skips `finally` and two of the workers loop forever by design.

### Coverage matrix

| #275 acceptance bullet | Existing proof | Status after this drill |
|---|---|---|
| Record the triggering evidence and select one deployment topology | none | GAP, needs the real trigger. A drill cannot choose a topology. |
| Define tenant ownership, fencing token or receipt, idempotency, conflict resolution, backup and restore, rollback contracts | tenant ownership in `ts/src/state-ledger.ts` plus `ts/scripts/ledger-tests.ts` section 11; fencing and claim in `docs/design/write-gate-production-design.md` sections 5.3 and 5.4 plus `ts/src/write-gate.ts`; idempotency via the `events_idem` unique index; conflict resolution via the forward-only dispatch trigger; backup and rollback in `ts/scripts/state-repair-tests.ts` | PARTIAL. Contracts exist for a single-writer local form. The multi-writer contract, replication semantics and rollback across machines are still undefined. |
| Prove concurrent writer and stale-claim rejection with isolated state roots and crash/reopen tests | two-process claim race in `ts/scripts/write-gate-tests.ts` section 4; receipt, operation and event-sequence races in `ts/scripts/booking-copilot-*-concurrency-proof-tests.ts`; crash and resume in `ts/scripts/ledger-tests.ts` section 9 with `ts/scripts/ledger-workflow-crash.ts` | EXERCISED OFFLINE (simulated; does not close the bullet). This drill adds N-process (not two) claim contention, N-process concurrent appends on one tenant and on two tenants, named crash points inside one transaction, timing-varied kills on the real product write path, and a cold-open race. |
| Verify backup restore and tenant isolation end to end; fixtures do not count as production rollout evidence | offline file-copy backup with checksum rollback in `ts/scripts/state-repair-tests.ts`; tenant isolation in `ts/scripts/ledger-tests.ts` section 11 and `ts/scripts/write-gate-tests.ts` section 5 | PARTIAL. This drill adds a SQLite online backup taken under live write load, restore with checksum verification, a prefix check on the event sequence, and fold self-consistency. End-to-end production rollout evidence is excluded by the bullet's own wording. |
| Run ledger suites, isolated smoke, and full regression; sync architecture, roadmap and current-state surfaces | run-all sections 28, 29 and 68 | INTEGRATOR. The drill registers section 82; the serial full regression and the authority reconciliation belong to the integrator. |
| Litestream streaming backup | none | `needs real trigger + dependency decision`. Not installed; the drill asserts its absence so no document can claim it. |
| cr-sqlite multi-writer replication | none | `needs real trigger + dependency decision`. Not installed; absence asserted. |

### What the drill ran

- **Cold-open race (A0, A0b, A0c).** Three rounds of six processes each opening the same fresh ledger with no start gun. Safety held every time: `integrity_check` ok, no duplicated idem key, fold rebuild equal to the direct read. Since the D15-1 fix the liveness side is gated too: 18 of 18 processes open successfully, and the only admitted failure is the typed `LedgerBusyError`. Two deterministic arms replace the timing luck — a start-gunned open against a write lock held in rollback-journal mode and released after 400 ms must succeed (A0b), and the same open against a lock that is never released must give up with the typed error (A0c).
- **N concurrent writers (A).** Three worker processes per tenant, on one tenant and on two tenants, over a seeded ledger file. The append-only event face: every distinct idem key landed exactly once per tenant, no `(tenant_id, idem_key)` pair appeared twice, every attempt was an insert or a dedupe with zero errors, and each tenant owned exactly its own rows and read only its own rows. The read-modify-write product face (`appendWish` with one shared wish name): exactly one `added` per tenant with the rest becoming updates, one projection row per tenant under the stable name-derived id, `integrity_check` ok, and fold equal to the direct read.
- **Crash drill (B).** Four named crash points inside one transaction built through the ledger's public surface, two iterations each, every one a real `SIGKILL`: `before-transaction`, `after-event-insert`, `after-projection-write`, `after-commit`. For the three pre-commit points, zero events and zero projection rows survived; for `after-commit`, exactly one of each survived. Plus three timing-varied kills on the real product write path with a deterministic seed, after which the committed `wish.added` count always equalled the projection row count and the fold always equalled the direct read.
- **Stale claim with fencing (C).** Four dispatcher processes racing one queued outbox intent: exactly one winner, three refused with a closed-set reason, one outbox row in `dispatching`, one immutable `attempt_id`, one claim event, and zero writes from the losers. A stale dispatcher retrying after the winner is refused `not-claimable`; an expired lease does not make the intent claimable again; a direct SQL reset to `queued` is refused by the storage-level forward-only trigger rather than by an application check; and tenant-b claiming the same `idem_key` sees `missing-intent`.
- **Backup and restore (D).** A SQLite online backup taken through `better-sqlite3` while a separate process wrote continuously, then restored by copy with checksum verification. The restored snapshot passed `integrity_check`, the live source still passed it, the snapshot was never ahead of its source, no duplicated idem key survived, the snapshot event sequence was a prefix of the source sequence, and the restored fold equalled the restored direct read.

### Defects found

**Defect D15-1 (FIXED 2026-10-05, founder decision): a concurrent first open of a fresh ledger threw an untyped `SQLITE_BUSY` out of `openDb`.**

**The fix.** `openDb` now installs `busy_timeout` before anything contendable (the WAL switch included), retries the `journal_mode = WAL` switch on contention codes while re-checking whether another process already switched it, and runs version detection plus schema creation and migration together inside one `BEGIN IMMEDIATE` transaction instead of detecting the version outside the transaction. Both open-path retries are bounded by a wall-clock budget and the only remaining failure exit is the typed `LedgerBusyError` (`code: 'GOTRY_LEDGER_BUSY'`, keeping the underlying SQLite code in `sqliteCode` and `cause`). A re-open whose schema is already current now takes no write lock at all, which also removes the per-open `kv` write that made the cold-open window denser. The drill's expectation is flipped and gated: 18 of 18 processes open successfully, and any failure must be the typed error. Two deterministic arms were added — a start-gunned child that opens while another process holds a write lock in rollback-journal mode must wait and succeed (A0b), and the same race with the lock never released must fail with the typed error (A0c). Reverting only `ts/src/state-ledger.ts` to the pre-fix file turns A0-6, A0-7, A0b and A0c red (9 of 18 opens, raw `SQLITE_BUSY` at `state-ledger.ts:708` and `:745`).

The defect as originally recorded, for the audit trail:

Minimal repro: run `ts/scripts/drill-multiuser-ledger-tests.ts` section A0, or spawn six processes that each call `openDb(freshStateRoot, 'local')` with no coordination. Observed across runs: one to five of eighteen processes failed, always with code `SQLITE_BUSY`, at two callsites inside `ts/src/state-ledger.ts` `openDb` — the `pragma('journal_mode = WAL')` call and the `db.exec(SCHEMA)` call inside the schema-migration transaction. The caller receives a raw SQLite error, not a typed rejection, and no retry is attempted.

Contributing ordering fact: in `openDb`, `pragma('journal_mode = WAL')` runs before `pragma('busy_timeout = 5000')`, so the exclusive lock the WAL switch takes is held while the other connections still have no busy handler installed.

The failure code is not a single literal. Three consecutive runs recorded 7, 8 and 11 successful opens out of 18, and two of those runs produced `SQLITE_BUSY_SNAPSHOT` alongside `SQLITE_BUSY`. An earlier version of this suite pinned the code to `SQLITE_BUSY` alone and would have gone red on two of those three runs, which is why the check now accepts a known contention set and reports any divergence from the recorded baseline instead of failing on it.

Classification at the time: an input to the D-15 decision, not a main regression, because D-15 admits no multi-writer path and ADR-16 gives one-ledger-owner semantics, so the single-writer product form never reaches this race. The founder decided on 2026-10-05 to fix it anyway: the same shape was also being hit outside the drill (issue #619), and the fix changes behaviour only on the contended path. `ts/src/state-ledger.ts` is kernel-pinned, so the frozen manifest `ts/data/kernel-manifest.json` was re-pinned to the new file hash in the same change.

**Defect D15-2 (FIXED 2026-10-05, founder decision): the read-modify-write product path needed a caller-side retry loop that the ledger did not provide.**

As recorded: `appendWish` ran a deferred read-modify-write transaction, so cross-process contention surfaced raw `SQLITE_BUSY` and `SQLITE_BUSY_SNAPSHOT` to the caller. In the drill, six processes needed six to nine caller-side retries to complete twelve attempts; without a retry loop an earlier run left two of six and eight of twelve attempts unrecovered. Safety always held — `integrity_check` ok, one wish row per tenant, fold equal to the direct read — but there was no typed rejection and no built-in retry.

**The fix.** The root cause is that a deferred transaction whose first statement is a read takes only a read snapshot; when it later writes, SQLite cannot upgrade a stale snapshot and returns `SQLITE_BUSY_SNAPSHOT` *immediately, without ever calling the busy handler* — so `busy_timeout` was powerless on that path. Every ledger transaction was audited against one criterion, whether its first statement is a `SELECT`. The six read-first ones (`appendMotivationPatch`, `appendWish`, `appendTripEvent`, `appendCompanion`, `confirmOutcome`, and the legacy-import transaction) now run `BEGIN IMMEDIATE` through one helper with a bounded contention retry behind it; the eight write-first ones (`appendUtilityEvent`, `rebuildProjections`, `createWorkflowRun`, `finishWorkflowRun`, `requestPendingWrite`, `confirmPendingWrite`, `compensatePendingWrite`, `forgetSubject`) already take the write lock on their first statement and were deliberately left deferred, with the audit table recorded in the source. The drill keeps its caller-side retry loop purely as an instrument and now gates the count at zero; reverting only the ledger file turns that assertion red with 3 retries over 6 attempts on one tenant and 10 over 12 on two.

**Observation, not a defect: the fencing token is monotonic only vacuously.** The forward-only dispatch-status trigger makes a second claim impossible, so no `fencing_token` above 1 is observable today. The design document's monotonic-increase property is therefore untestable in the current shape; a real multi-machine lease handoff would be the first thing to exercise it.

**What only the real trigger can supply.** The triggering evidence itself (a second real user, a multi-machine deployment, or an approved AaaS initiative) and the chosen deployment topology; the multi-writer and replication contract; a Litestream or cr-sqlite dependency decision and the operational evidence that follows it; cross-machine clock, lease and ownership semantics; a real lease handoff that would make the fencing token advance; and production rollout evidence, which #275 explicitly says fixtures cannot be.

## Drill 3 — issue #422 dsh SDK descendant cleanup (re-baseline)

Suite: `ts/scripts/drill-sdk-descendant-cleanup-tests.ts`, registered as run-all section 83. Result on the recorded run: exit 0, 42 assertions passed. No vendor or `node_modules` edit, and no upstream proposal beyond this documentation.

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
