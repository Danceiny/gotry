[English](aaas-rfc.md) | [简体中文](aaas-rfc.zh-CN.md)

# RFC: GoTry as a Multi-User Agent Service (AaaS) — State, Identity, and Deployment

> Role: the A0 design proposal for serving GoTry as one cloud service shared by many users — state layer, tenant model, durability, identity, topology, and the ADR re-review it triggers.
> Status: **accepted** (A0 of [#674](https://github.com/Danceiny/gotry/issues/674), drafted 2026-10-26, accepted 2026-10-28). The founder merged the proposal in [#675](https://github.com/Danceiny/gotry/pull/675) and directed development to start. No per-question override was given, so Q1–Q7 stand as recommended (§8.1); an override re-opens only the questions it names.
> Upstream: the founder decision of 2026-10-21 (#674); [architecture](../architecture.md) §8 (ADR-14/15/16/17/23) and §10 (D-15); [master outline](../gotry-master-outline.md) §2 reuse matrix; [transactional-state RFC](transactional-state-rfc.md) TS-5; [LoopX-inspired RFC](loopx-inspired-upgrades-rfc.md) §6.5.
> Downstream: the A1–A4 work items of #674; the ADR re-review results, absorbed into architecture §8 and [ADR expansions](../adr-expansions.md) on acceptance; [AaaS security design](../design/aaas-security-design.md).
> Deployment facts: hotel-be `docs/architecture/gotry-backend-deployment-architecture.md`, last verified 2026-10-24. Constraint IDs C1–C16 refer to that document.

## 0. Summary and decision request

- **State boundary.** Adopt *keyed single writer per tenant*: one ledger per tenant, at most one writer per ledger at any instant, and ownership held as a lease whose fencing epoch the durable layer checks. This is ADR-15 re-scoped from one ledger per installation to one ledger per tenant.
- **Physical binding.** Keep the existing SQLite ledger and kernel schema, one file per tenant, copied off-node. A shared Postgres or MySQL ledger stays the named fallback with explicit switch triggers. cr-sqlite is rejected for service state.
- **Tenant model.** A tenant is a ledger owner, one per end user. An organization is the deploying party; it owns credentials, browser lanes and quotas. The trusted seam derives `tenant_id` from the authenticated BFF principal; payloads, tools and the model never supply it.
- **Durability.** Declare the RPO instead of implying "no loss". Asynchronous off-node streaming (an RPO of seconds) is admissible while writes stay sealed. RPO = 0 becomes a precondition for the WriteGate outbox before M5 can unseal on AaaS.
- **Topology.** A dedicated intranet gotry tier with N replicas and tenant-affine routing sits behind the BFF. A new boundary ADR replaces C2 for that tier. The browser-reachable surface stays zero (C16).
- **ADR re-review.** ADR-14, ADR-15, ADR-17 and ADR-23 hold with the additions in §5. ADR-16 stays frozen, and its deferred sync and claim items activate.
- **Decisions.** Q1–Q7 in §8.1 were accepted as recommended on 2026-10-28, and A1 has started. Facts F-1–F-4 are established read-only in parallel.

## 1. Problem

### 1.1 Trigger

The founder chartered the AaaS initiative on 2026-10-21 (#674). That satisfies the "approved AaaS initiative" trigger of D-15, formerly tracked by the closed [#275](https://github.com/Danceiny/gotry/issues/275). It also fires the written re-review conditions of ADR-14, ADR-15, ADR-17 and ADR-23.

The goal: many users, each under their own identity, call one cloud GoTry service. State is isolated per user, concurrent writes are safe, the service scales horizontally, and a single failure loses no data.

### 1.2 Baseline

| Concern | Current fact | Anchor |
|---|---|---|
| Service | `gotry-backend` is one process with one HTTP surface and a module registry: booking-copilot, session-search and booking-executor. It listens on `127.0.0.1:3082`; the hotel-be BFF is its only caller. | `ts/src/gotry-backend.ts`; `ts/src/backend/kernel.ts`; C1, C2 |
| Fleet | One instance runs next to the hotel-be BFF on each serving node: UAT plus four production nodes (as of 2026-10-24). Each instance has its own state root. Nothing replicates between nodes. | hotel-be deployment §4; C7 |
| Product ledger | One SQLite file per state root, in WAL mode. Every table carries `tenant_id`. Server paths open the default tenant `local`. | `ts/src/state-ledger.ts` (`openDb(stateRoot, tenant = 'local')`); ADR-15, ADR-16 |
| Booking Copilot | All BFF users of a node share tenant `local`. Isolation between them rests on ADR-23 request bindings that carry principal and scope digests. | `ts/src/booking-surface/runtime.ts` |
| Session bridge | `bridge.db` lives per node. Jobs, clients, pacing and events have no tenant or organization column. A job matches on site capability, preferred origin and preferred client id. | `ts/capabilities/session/bridge-ledger.ts`; `extension-bridge.ts` (`jobMatches`) |
| Execution plane | Supplier sessions live in employee browsers through the Stai Travel Bridge extension. The server runs zero Chrome. | C10, C15, C16 |
| Concurrency evidence | Offline drills prove N-process safety on one ledger file and fixed two cold-open defects. They satisfy no trigger. | [trigger drill report](../evaluation/trigger-drill-report-core.md), Drill 2 |

### 1.3 Gaps the baseline cannot close

1. **Node-bound state.** A tenant's state lives on whichever node served it, and other nodes cannot see it. This repository does not establish whether hotel-be keeps one task's turns on one node (fact F-1).
2. **No off-node copy.** Losing a node loses its ledgers (D-15).
3. **Shared-tenant scans.** The events table has two indexes: the `seq` primary key and a partial unique index on `(tenant_id, idem_key)`. The request-binding lookup reads and parses every request-binding event of the tenant, and per-task reads filter on `run_id` and `kind` without a supporting index. On a shared `local` tenant, per-request cost therefore grows with the node's whole history across all users.
4. **No organization dimension in the bridge.** Once two organizations share one service, a job could be claimed by another organization's extension, which means another organization's supplier login. Pacing is per node and per site.
5. **Bearer-only identity.** Each surface has one shared bearer key (C13), and the BFF asserts the principal fields. That is acceptable on loopback (C2) and insufficient once the service leaves it.
6. **State outside the ledger.** The booking planner runs dsh with the state root as its working directory. Handoff tickets, deliverables and artifacts are files. A tenant's durable state is therefore a directory, not only one SQLite file (fact F-2).

## 2. Goals, non-goals and scope

| Goal | Testable statement |
|---|---|
| G1 isolation | Cross-tenant and cross-organization reads and writes are rejected in every adversarial case of the A2 suite. |
| G2 concurrency safety | No lost update and no double consumption of a request key, approval or claim under N writers and crash injection. |
| G3 horizontal scaling | Adding a replica moves tenants without manual re-sharding and without downtime beyond one graceful handoff per moved tenant. |
| G4 failure | A single failure never corrupts state and never yields two authorities. Data loss is bounded by the declared RPO of §4.3. |

**Non-goals inherited as red lines.** The charter unseals none of them.

- Writes stay behind WriteGate and M5 Entry (AGENTS.md red line).
- Supplier login state stays in employee browsers (founder, 2026-09-11). The cloud orchestrates, authenticates and queues only.
- The M3 evidence gate ([#22](https://github.com/Danceiny/gotry/issues/22)) is not bypassed. AaaS is a parallel engineering line.
- M6 commercial multi-tenancy (sponsors) stays behind [#137](https://github.com/Danceiny/gotry/issues/137).
- No Python surface and no TS↔Python bridge. The dsh harness session layer is not modified.
- Access control lives at the presentation layer. Host- and storage-level controls (file permissions, encryption at rest, operator audit) are not designed ahead of need (founder, 2026-10-26).

**Scope of AaaS v1.** The `gotry-backend` surfaces (booking-copilot, session bridge, executor) become multi-tenant and multi-replica. A hosted multi-user form of the conversational dsh agent is a later step behind its own decision (Q6), because dsh is a single-user harness.

## 3. State-layer options

### 3.1 Two independent axes

- **Partitioning:** one shared store for all tenants, or one ledger per tenant.
- **Durability:** local WAL only (today), asynchronous off-node copies, or synchronous replication.

### 3.2 Candidates

| Option | Mechanism | Fit with GoTry | License | Verdict |
|---|---|---|---|---|
| K: keyed SQLite per tenant | One ledger file per tenant and an owner lease with a fencing epoch — the shape of Durable Objects and Restate virtual objects | Keeps the ADR-15 schema and the synchronous kernel; bounds scans per tenant; forget becomes a file deletion. Needs routing, a lease store and off-node durability. | better-sqlite3, MIT, already imported | **Recommended** |
| L: Litestream | Streams each database's WAL to S3-compatible storage; restore-based failover; one writer per database | The durability medium for K. Asynchronous, so RPO > 0. It is a separate Go daemon, which C1 forbids on today's hosts, and per-tenant per-epoch replica paths must be configured dynamically (F-3). | Apache-2.0, active | **Recommended for K, subject to Q4** |
| C: cr-sqlite | CRDT merge of concurrent writers, per column | Eventual consistency cannot guarantee consume-once: two replicas can each consume the same approval or claim before they merge. ADR-16's event union is already a grow-only merge. | MIT | **Rejected** for service state |
| P: shared Postgres or MySQL | One multi-writer database with row-level security; per-tenant advisory locks can emulate a keyed writer | Stateless replicas, mature HA and point-in-time recovery, and RPO = 0 with a synchronous standby. But the kernel ledger and five other modules call better-sqlite3 synchronously, with over 110 `prepare` call sites in `state-ledger.ts`, `write-gate.ts`, the booking runtime and the bridge ledger alone. An async client rewrites a kernel-pinned file and splits the local and server bindings. The two hotel-be configuration files inspected reference MySQL and do not mention Postgres. | PostgreSQL License; `pg` MIT | **Fallback** (§3.4) |
| R: Raft-replicated SQLite | rqlite (HTTP API) or dqlite (C library) | Synchronous, but rqlite runs a transaction as one submitted statement batch, while the ledger relies on interactive read-then-write transactions. dqlite is a C library with no Node binding in this repository's dependency set. | rqlite MIT; dqlite LGPL-3.0 with an exception (GitHub reports NOASSERTION) | **Rejected** |
| F: LiteFS | FUSE replication with a primary lease | Activity has slowed (last push 2026-05). Needs FUSE on a supervisor-managed fleet. | Apache-2.0 | **Not selected** |

### 3.3 Why keyed single writer

1. **The semantics already exist.** One file is one writer domain today. The drills prove N-process safety on it, and the contention fixes are in the kernel.
2. **Consume-once needs a linearizable writer.** ADR-23 approvals, request bindings and the WriteGate claim each allow exactly one winner. One writer per tenant gives that directly; a multi-writer store gives it through transactions; a CRDT cannot.
3. **ADR-16 already named this binding.** Its Web binding is "the same schema on a per-user SQLite file (or Postgres, isomorphic schema)".
4. **State blast radius and cost stay per tenant.** A corrupt file, a hot tenant or an unindexed scan affects one tenant's state only. Compute is not partitioned: the tenants of a replica share its CPU, memory and file descriptors, and §4.8 says what bounds that.
5. **The kernel stays frozen.** Routing, leases and replication live outside the five kernel-pinned files, except for a possible epoch guard (§9).

### 3.4 Switch triggers to the fallback (option P)

1. A product needs transactions or consistent reads across tenants.
2. A data class needs RPO = 0 before the path in §4.3 can be proven.
3. A3 drills show ownership churn or routing instability beyond the agreed budget.
4. Tenant count times per-file overhead exceeds the replica budget. The measured per-tenant cost (about three file descriptors and a quarter of a MiB when idle, in the [capacity baseline](../ops/aaas-capacity-baseline.md)) is what this compares against.

## 4. Proposal

### 4.1 Vocabulary and tenant model

| Term | Meaning in this RFC | Not to be confused with |
|---|---|---|
| Tenant (ledger tenant) | The owner of one ledger, one per end user. In B2C it is the traveler; in an internal deployment it is the employee. | hotelbyte's business "tenant", which this RFC calls an organization |
| Organization | The deploying party. It owns BFF credentials, extension lanes, quotas and policy. | The M6 sponsor, which stays out of scope |
| BFF principal | The ADR-23 security identity: who may call. It derives the tenant; it is never stored as motivation. | The M6 traveler principal, whose motivation the ledger holds |

- **Derivation.** `tenant_id = "t-" + hex(HMAC-SHA256(K_org, issuer ‖ 0x00 ‖ subject))[0..32]`, computed in GoTry from the authenticated principal. `issuer` is the organization's subject namespace. `K_org` is a per-organization server-side key, so ids are neither guessable nor reversible.
- **Granularity.** The ledger owner is the person. The principal's `scope` stays an authorization attribute inside the tenant, bound as ADR-23 binds it today (Q2).
- **Local form.** The local product keeps tenant `local`; nothing changes for it.
- **Defense in depth.** Inside a tenant file, `tenant_id` holds that tenant's id, not `local`. A file opened under the wrong tenant returns zero rows.

```text
<stateRoot>/orgs/<org_id>/
  gotry-state/bridge.db              # target layout; as built in A2: one shared ledger per node with an organization column
  tenants/<tenant_id>/               # the ownership and replication unit
    gotry-state/gotry-state.db       # the ADR-15 ledger, tenant_id = <tenant_id>
    ...                              # planner working files, tickets, artifacts (F-2)

lease record: { key: "<org_id>/<tenant_id>", owner: <replica_id>, epoch: <int>, lease_until: <ts> }
```

### 4.2 Ownership, fencing and the write path

These are the contracts A1 must prove offline.

1. **One lease per tenant.** A lease store with linearizable compare-and-set holds the record shown above.
2. **Acquisition increments the epoch.** A replica may write a tenant's ledger only while it holds the lease. Acquisition is `CAS(epoch → epoch + 1)`; renewal keeps the epoch.
3. **Epoch-scoped durable copies.** Each owner copies only into the prefix of its own epoch. A new owner restores the newest verified snapshot of the newest lineage below its own epoch, and pins that exact snapshot in its own `base.json` before it serves a write. A snapshot a superseded owner uploads after the pin sits above it and is never read; one that lands before the pin is the window described in §4.3.
4. **Self-fencing before expiry.** An owner stops acknowledging writes at `lease_until − margin` on its monotonic clock unless it has renewed. The margin covers the agreed clock-skew bound.
5. **Reads go to the owner.** A1 admits no stale replica reads.
6. **Two handoff paths.** A graceful handoff drains in-flight work while the lease keeps being renewed, closes the ledger view the moment the final image is taken (a write made through it after that could not be in the image, so it is refused), flushes the copy, checks that the lease was still held when the upload landed (an image that landed after it lapsed is reported as failed, not as flushed), releases the lease and removes the replica's local ledger files. A failure handoff waits for expiry; the new owner restores at epoch + 1.
7. **Conflict resolution.** No concurrent writers exist within a tenant to reconcile. A stale epoch loses, and idempotency keys make retries safe.

Integrity follows from items 1–3 alone and does not depend on clocks: an imperfect lease service costs availability, not correctness (the fencing-token argument in Appendix A). Durability of acknowledged writes depends on the medium in §4.3.

The lease store is decision Q3. Candidates are hotel-be's MySQL (one row per tenant, CAS on the primary), Redis (acceptable only because fencing protects integrity; its failover can grant two leases), or object-storage conditional writes (support varies by store, fact F-3).

### 4.3 Durability and RPO

| Mode | Mechanism | RPO | Use |
|---|---|---|---|
| D-a asynchronous | Stream each tenant file to the S3-compatible store (Litestream class); restore = latest snapshot plus WAL | The replication lag at the moment of failure; more only if clock skew exceeds the self-fencing margin | **Recommended for A1–A3**, while writes stay sealed |
| D-b acknowledged | Respond to the BFF only after the committed change is durable off-node, through an epoch-conditional append | Zero for acknowledged writes, independent of clocks | **Required before M5 unseals on AaaS** |

- **Why D-a suffices now.** No money-moving state exists while writes are sealed. The data at risk is the last seconds of planning turns, and the BFF can replay them with the same request key.
- **Why D-a stops at M5.** Losing a persisted `dispatching` claim after a supplier call would re-queue the intent and allow a second booking. The [WriteGate design](../design/write-gate-production-design.md) §5.3 forbids exactly that.
- **Why D-b needs ledger work.** Not every authoritative row is an event today. `workflow_steps` intent and done rows change without an event, so an event-only copy would restore runs without their step results. D-b therefore needs page-level capture or event-complete step logs, and both touch the kernel.
- **A window D-a cannot close.** The base pin protects everything a superseded owner uploads after its successor pinned. A paused owner whose monotonic clock is frozen (a VM freeze; a `SIGSTOP` does not stop the clock) can still land a snapshot between its successor taking the lease and pinning its base, a span about as long as the restore, and that snapshot is restored. D-b closes it, and so would a seal on the previous epoch. The A1 suites pin the window (`tenant-state-copies-tests`, X3), so closing it flips a test.
- **Restore verification.** A restored copy must pass `integrity_check`, its fold must equal its direct read, and its event sequence must be a prefix of the source (the drill D properties).
- **Rollback.** Restoring a tenant to an earlier snapshot uses the same verified restore path and is itself an epoch bump.
- **Forget across copies.** Red line 6 requires that delete means delete: forget deletes the tenant's ledger and its off-node copies together.

### 4.4 Identity, authorization and quotas (A2)

- **Authentication stays BFF-bound** (ADR-23). Only the trusted BFF calls GoTry; the browser never reaches it (C16).
- **Principal assertion.** Today one shared bearer key per surface carries principal fields. Once the service leaves loopback, per-organization credentials plus mTLS, or a short-lived signed assertion bound to the request digest, replace it. The A3 boundary ADR decides which.
- **Authorization at one seam.** Every handler resolves `(organization, tenant)` once, at the seam. Ledger handles are tenant-bound objects. No API accepts a raw tenant id.
- **Quotas and metering** per tenant and per organization: concurrent turns, turn rate, LLM token and cost budget priced by the frozen table (ADR-20), bridge job rate, per-site pacing per organization, and ledger size.
- **A2 exit suite.** Forged tenant fields, a foreign `taskHandle` or `requestKey`, path-shaped ids and cross-organization bridge results are all rejected.
- **As built in A2.** `deriveSeamTenant` is the one place a tenant is derived: from the caller an injected `CallerAuthenticator` vouched for, into an opaque `SeamTenant` that every quota API requires. A request is authenticated, placed in its tenant, admitted against its quotas (a typed 429 before the body is read, a lease is taken or a planner starts, for concurrency, rate and LLM budget; a ledger-size refusal is decided once the tenant is open) and served from the guarded ledger of `TenantRouter.openTenant`. The decision work runs inside `handle.runAsync`, so a handoff drains it and a lease lost mid-stream cuts the connection instead of acknowledging; a planner error that coincides with a lost lease cuts that one connection too, and whatever escapes a request ends that request, never the replica. The bridge ledger and job matching carry an organization (one shared `bridge.db` with an `organization` column; the migration of a legacy file is one way, so roll back only while every row is `local`, otherwise restore a copy taken before the first start of the new binary). How the BFF proves a user's identity on the wire is not decided here: until A3 supplies a production authenticator, deployments keep running the shared-key form of the surface. Evidence: run-all §93 to §95.

### 4.5 Deployment topology (A3)

- **Target.** A dedicated gotry tier of N ≥ 2 replicas on the intranet, behind the BFF. Any replica accepts a request and forwards it to the tenant's owner, or acquires ownership when the lease is free. A tenant's planner sessions run on its owner replica.
- **Routing.** Tenant-affine consistent hashing on `tenant_id`, at the BFF or in a gotry-side router, keeps ownership churn low.
- **Boundary.** A new ADR replaces C2 for this tier: an intranet bind, per-organization credentials, never in public nginx, and never browser-reachable (C16 unchanged). It also amends C1 if the durability medium needs a sidecar.
- **Bridge.** The same lease pattern applies per organization. An extension long-poll that lands on any replica is forwarded to the organization's bridge owner. Job matching adds organization equality.
- **Observability.** Per-tenant and per-organization metrics keyed by the HMAC id, lease and epoch events, replication lag, and quota rejections; no PII.
- **Rolling deploys.** Ownership moves only between replicas with compatible schema and feature sets, by the ADR-23 intersection rule.
- **Transitional alternative (Q5).** Keep per-node loopback instances, add tenant-sticky routing in hotel-be, and share the durable store. This changes fewer boundaries, but scaling stays coupled to hotel-be nodes.

### 4.6 Failure modes

| Failure | Detection | Effect | Recovery | Invariant kept |
|---|---|---|---|---|
| Owner replica crashes | Lease expiry | Tenant unavailable for at most the TTL plus restore | New owner restores at epoch + 1 | No two authorities; loss bounded by the RPO |
| Owner partitioned from the lease store | Renewal fails | Owner self-fences at lease end | New owner elsewhere | Stale writes land in a dead prefix |
| Lease store unavailable | Acquire or renew errors | No new ownership; owners stop at lease end | Typed 503 until it returns | No dual owner |
| Object store unavailable | Replication errors and lag alarms | D-a: the RPO grows; D-b: writes return 503 | Resume and backfill | D-b never acknowledges silently |
| Clock skew | Lease margin monitoring | — | Margins sized to the skew bound | Integrity does not depend on clocks |
| Corrupt tenant file | `integrity_check` at open | One tenant affected | Restore from the durable copy | Blast radius of one tenant |
| Hot tenant | Quota counters | Throttled | Typed 429 | Other tenants unaffected |
| In-flight turn lost | Client timeout | Retry | The same request key replays | No duplicate effect (ADR-23 binding) |
| Bridge owner crashes | Lease expiry | Queued jobs wait; claimed jobs settle `unresolved` | New bridge owner (`recoverOnBoot` semantics) | No cross-organization claim |
| Mixed-version fleet | Feature advertisement | Optional features turn off | — | ADR-23 intersection rule |
| Two replicas share one file by misconfiguration | The lease epoch: a restore replaces the file by atomic rename, so the older writer holds an unlinked file (a guard in `kv` checked on every write would change the kernel) | The older writer is fenced at its next renewal | Fix the configuration | Single writer |

### 4.7 Leaving the per-node islands

- **Inventory first (F-2).** Read-only counts of tenants, event kinds and files in each node's state roots.
- **Booking Copilot history.** Tasks are short-lived. Proposal: no migration. New tasks go to tenant ledgers; node ledgers stay read-only for audit and are archived later (Q7).
- **No inference.** Events already recorded under `local` are never re-attributed by guesswork (ADR-16). Any move uses the authorized repair procedure of [#254](https://github.com/Danceiny/gotry/issues/254).

### 4.8 Execution isolation: compute, credentials, cache, browser (A2)

The state layer isolates what a tenant stores. This section covers what a tenant's turn runs on and with. In AaaS v1 that is narrow, and the design says so first.

- **What a v1 planner can do.** The embedded planner is typed planning only: the dsh shell, file, sandbox, subprocess and pty plugins are disabled, `toolBash` is off, and the only tools are the thirteen `booking_*` capabilities, each of which yields one validated decision. Assistant text is ignored. No model-generated code or command runs on the server, so a per-task microVM or gVisor sandbox would isolate nothing the planner can reach. Supplier login state is not on the server at all (S-9): "credentials stay out of the sandbox" reduces to "the credentials are not in the cloud".
- **What the tenants of a replica still share.** CPU, memory, file descriptors, the planner's LLM credential, the provider's prompt cache, and the executor's host browser. The state layer isolates none of them. Each has a control with a falsification test:

| Shared resource | Threat | Control | Evidence |
|---|---|---|---|
| CPU and memory of a replica | S-17 | Every planner process tree runs under ceilings: a V8 heap cap, a sampled tree RSS and CPU cap, and a cap on a worker's unterminated line. A tree over a ceiling is killed and its turn ends as a non-retryable `PLANNER_FAILED`, never rerun on a fresh port | run-all §96 |
| File descriptors of a replica | S-17 | `maxOpenTenants`: a tenant over the cap is refused before its lease or any file exists (a typed 503 with no retry hint). An open tenant holds about three descriptors; a slot is freed only by a handoff or by closing the router | run-all §96, [capacity baseline](../ops/aaas-capacity-baseline.md) |
| The LLM credential | S-18 | A loopback broker holds the upstream key and base URL; each planner process tree gets a short-lived ticket that works only against the broker, for a bounded number of requests, and dies with its port. The broker also measures usage, so spend is charged to the tenant whose invocation asked instead of the configured worst case | run-all §97 |
| The provider's prompt cache | S-16 | A per-tenant HMAC label sits after the instructions every tenant shares and before any tenant-derived byte, so two tenants can share a cached prefix only up to it | run-all §98 |
| The executor's host browser | S-19 | The module knows whose supplier login the host browser holds and serves only that organization; a caller's organization is resolved by the host, never read from the request | run-all §99 |
| Capacity | trigger 4 | A probe measures tenants held open, takeover latency and a booted planner with the real code | run-all §100, [capacity baseline](../ops/aaas-capacity-baseline.md) |

- **Limits, stated plainly.** (a) The tree sampler reads `ps` once a second, so a runaway can overshoot between samples; the V8 heap cap is the first line for JavaScript allocations. RSS counts pages shared between processes once per process, and CPU time has one-second resolution on Linux. The heap ceiling also reaches the dsh runtime below the worker (`NODE_OPTIONS`), which holds most of a turn's memory. A worker that dies of its own ceiling is recognised from its stderr tail; when the runtime is what dies, the worker reports an ordinary failed run, and the caller gets the same non-retryable `PLANNER_FAILED`, only without the `resource_limit` metric. A single-threaded spinner is normally ended first by the turn's own deadline, as a retryable timeout; the CPU ceiling is for bursts across threads and processes. Where the process table cannot be read, or does not show the service itself, the real tenant planner refuses to start a child instead of running it ungoverned. (b) The default ceilings are unreviewed and were set from one machine's idle footprint; a deployment passes its own after probing real nodes. (c) Planner children still share the replica's OS user and network: there is no uid separation, no cgroup and no egress policy, so a child can reach any host it could before, and it still inherits the rest of the parent's environment minus the names the runtime's scrub treats as secret. Host- and network-level controls are ops redundancy, which the decision of 2026-10-26 leaves for later. (d) The broker narrows what a compromised *child* gets. Anyone who can run code in the gotry process can still read the key. It carries the chat-completions route (`DEEPSEEK_PROVIDER=gateway-chat`) only, and a planner configured with a broker on another route fails at construction. (e) The cache label assumes the provider caches by prompt prefix, and it changes nothing about what the operator's own bill shows. (f) The binding stops a second organization from using the host browser. It does not make that browser safe to share, and nothing here is a multi-tenant cloud browser. (g) A replica frees an open-tenant slot only when a tenant is handed off or the router closes; there is no idle eviction. Until A3 composes idle release with tenant affinity, one organization with many users can fill the slots and every other new tenant is refused by that replica; without the cap the same event would exhaust descriptors for all of them at once.
- **Entry criteria for what is not built.** The hosted conversational agent (Q6) and a multi-tenant cloud executor browser run model-steered code or a browser on the server, which is exactly what the controls above do not cover. Neither starts before: (1) its own ADR and a founder decision; (2) one disposable sandbox per task, with a boundary stronger than a shared kernel (a microVM or a gVisor-class runtime), no persistent profile, destroyed when the task ends; (3) deny-by-default egress through a credential-injecting proxy, of which the broker is the first, loopback form; (4) resource accounting enforced by the sandbox, not sampled from outside; (5) the capacity baseline measured again with the sandbox in place; and (6) for a browser, a founder decision on how a tenant's supplier login would reach it at all, since cookie values may not cross the bridge or live on the server (S-9, 2026-09-11): that is a decision about a red line before it is an ADR.

## 5. ADR re-review (kickoff)

| ADR | Trigger | Finding | Proposed addition on acceptance |
|---|---|---|---|
| 14 memory utility | Multi-user AaaS ledgerization | Holds per tenant. Attribution still needs the tenant's own confirmation. | No cross-tenant utility aggregation; a second consumer still re-opens the ADR. |
| 15 transactional state | AaaS and multi-writer | **Holds as keyed single writer.** The single-file authority is re-scoped to one file per tenant. | "One ledger per tenant is that tenant's sole authority; at most one writer at any instant, fenced by epoch; off-node durability with a declared RPO." Anchor: the A1 suites. |
| 16 dual form (never re-review) | Its deferred items (AaaS) | The freeze holds. Its deferred sync protocol and claim/CAS implementation activate now. | The per-user SQLite file becomes the server binding; sync stays event replication. |
| 17 booking saga | Parallel multi-writer booking flows | Holds. Keyed single writer serializes a tenant's saga, so no parallel writer is admitted. | On AaaS the saga state lives in the tenant ledger, and D-b (RPO = 0) is a precondition before M5 unseals. |
| 23 Booking Copilot boundary | Multi-writer and cross-host | Holds. Continuity across hosts comes from tenant routing, not from shared state. | Tenant derivation in the trusted seam; tenant-scoped `requestKey` and `taskHandle`; per-organization credentials once off loopback. |

**The issue's question, answered.** Keyed single writer holds under multi-tenancy when two conditions hold: the lease store offers linearizable compare-and-set, and the durable layer is fenced by epoch. If either is missing, the design degrades to a split-brain risk and must not ship.

C2 is a hotel-be deployment constraint, not an ADR. The A3 boundary ADR replaces it for the gotry tier.

## 6. Threat model (summary)

The draft lives in [AaaS security design](../design/aaas-security-design.md). The threats that most shape this RFC:

- cross-tenant access through forged identifiers or shared caches;
- cross-organization bridge routing onto another organization's supplier login;
- stale-owner writes after a partition;
- bearer keys exposed once the service leaves loopback;
- cost, turn and bridge exhaustion by one tenant;
- deleted data surviving in off-node copies.
- a runaway planner child taking a replica's CPU, memory or file descriptors from every tenant on it;
- the planner's LLM credential reachable from a process that model output steers;
- a provider's prompt cache letting one tenant infer another's content;
- a second organization riding the executor's host browser and its supplier login.

## 7. Rollout plan (every phase can stop)

| Phase | Deliverable | Exit evidence | If stopped |
|---|---|---|---|
| A0 design | This RFC, the ADR re-review, the threat model, document reconciliation, facts F-1–F-4 | The founder accepts the RFC (Q1–Q7 answered) | D-15 records the met trigger; nothing changes at runtime |
| A1 state layer | Tenant router and leases outside the kernel; epoch-scoped copies; restore and verification; offline concurrency and fault-injection suites on isolated state roots | Suites green; every #275 checklist bullet mapped to a passing test or a recorded decision | Not deployed; per-node islands unchanged |
| A2 identity and quotas | Seam-derived tenants, organization keys, quotas and metering | Adversarial suite: every cross-tenant read and write rejected (run-all §93 quotas and metering, §94 seam and surface, §95 bridge organization); execution isolation and capacity (§96 compute, §97 credentials, §98 cache partition, §99 executor binding, §100 capacity probe) | Single-organization deployment only |
| A3 deployment | Intranet tier with N replicas, the boundary ADR, observability | UAT multi-replica run plus failure drills: owner kill, partition, lease store down, object store down, restore | Roll back to per-node loopback |
| A4 production | The first real second user: hotelbyte employees | Production multi-user evidence; D-15 moves to the debt archive | Stay at A3 on UAT |

Simulated drills, fixtures and offline suites never count as A3 or A4 evidence.

| #275 checklist bullet | Where it closes |
|---|---|
| Record the triggering evidence and select one deployment topology | A0: the trigger is #674; the topology is Q5 |
| Define tenant ownership, fencing, idempotency, conflict resolution, backup/restore and rollback contracts | Defined in §4 and proven in A1: run-all §89 (lease and fencing), §90 (copies, verified restore, forget) and §91 (router, handoff). Choosing an earlier snapshot on purpose is an operator action and waits for A3; the restore path already falls back to an older verified one (§90) |
| Prove concurrent-writer and stale-claim rejection with isolated state roots and crash/reopen tests | A1: run-all §89 (six processes race one lease), §91 (a fenced handle refuses every call) and §92 (kills, a pause past the lease and a graceful handoff under four contending replicas) |
| Verify backup restore and tenant isolation end to end | A1 offline: §90 (verified restore, a foreign-tenant image refused), §91 and §92 (two tenants, the ledger equal to its lineage); A3 for rollout evidence |
| Run ledger suites, isolated smoke and full regression; sync the authority surfaces | Every phase |

## 8. Decisions, facts to establish, and risks

### 8.1 Founder decisions

| # | Question | Decision (accepted as recommended, 2026-10-28) |
|---|---|---|
| Q1 | Adopt keyed single writer per tenant as ADR-15's restated boundary? | Yes |
| Q2 | Make the ledger owner the person, with the principal scope as an attribute? | Yes |
| Q3 | Which lease store? | hotel-be MySQL, one row per tenant |
| Q4 | Which durability mode? | D-a through A3, importing Litestream after the master-outline revision; D-b before M5 on AaaS |
| Q5 | Which topology? | A dedicated intranet tier with a new boundary ADR |
| Q6 | What is AaaS v1's scope? | The `gotry-backend` surfaces first; the hosted conversational agent later, by its own decision |
| Q7 | What happens to the existing per-node `local` ledgers? | Archive read-only; no migration |

### 8.2 Facts to establish before the A1 design freeze (read-only)

- **F-1** How hotel-be routes successive turns of one task across nodes.
- **F-2** What each node's state roots contain: tenants, event kinds and counts, and planner working files.
- **F-3** Whether hotelbyte's S3-compatible store supports conditional writes, and whether Litestream can copy a dynamic set of tenant files into epoch-specific paths on it.
- **F-4** Whether hotel-be's MySQL can host a lease table, and who owns its schema.

### 8.3 Risks

| Risk | Mitigation |
|---|---|
| In-house lease and fencing code is subtle | Fencing turns lease bugs into availability loss; fault-injection suites; falsification tests that must fail against a deliberately broken guard |
| Ownership churn under non-sticky routing | Tenant-affine routing; churn metrics with a budget (switch trigger 3) |
| A sidecar daemon conflicts with C1 | Decided in the A3 boundary ADR; D-b needs no sidecar |
| Kernel-pinned files would change | Keep the router and leases outside the kernel; any epoch guard inside `state-ledger.ts` needs explicit founder approval and a manifest re-pin |
| Vocabulary collision with hotelbyte's "tenant" | The §4.1 table; code names `ledgerTenant` and `organization` |
| Cost exhaustion by one tenant | Per-tenant and per-organization budgets before A4 |
| Hidden coupling to hotel-be routing | F-1 before the A1 design freeze |
| A runaway planner child takes a replica's CPU, memory or file descriptors from every tenant on it | Process-tree ceilings with a typed non-retryable failure; `maxOpenTenants`; a runaway-child drill in A3; ceilings re-set from probes of the real nodes |
| The planner's LLM credential is read from a process that model output steers | The loopback credential broker; the real planner of the tenant form cannot be built without one. A compromised gotry process still reads the key |
| One tenant infers another's content from the provider's prompt cache | The per-tenant cache label; whether the provider isolates caches itself is an open question |

## 9. Reconciliation with repository discipline

- **Reuse matrix.** No new import lands before acceptance. Adding Litestream, `pg` or any other candidate first revises master outline §2 (outline §6).
- **Kernel manifest.** `state-ledger.ts` is pinned. Routing, leases and replication stay outside the kernel. An epoch guard inside the kernel requires explicit founder approval.
- **State discipline.** All A1 tests run on isolated state roots, never on founder runtime state.
- **Write path.** No WriteGate behavior changes. Booking writes stay sealed.
- **Language and harness.** No Python; dsh follows main and is not modified.
- **Same-commit rule.** The acceptance changed the owning authorities in one commit: architecture §8, ADR expansions, the roadmap, the master outline and the decision queue. Architecture §10 (D-15) already carried the met trigger and is unchanged.

## Appendix A. Sources

- Martin Kleppmann, [How to do distributed locking](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html): fencing tokens make lock-service failures a liveness problem, not a safety one.
- SQLite, [Write-Ahead Logging](https://www.sqlite.org/wal.html): WAL needs shared memory on one host unless exclusive locking mode is used.
- [Litestream](https://github.com/benbjohnson/litestream): streaming WAL replication to object storage, one writer per database.
- [cr-sqlite](https://github.com/vlcn-io/cr-sqlite): CRDT-based multi-writer SQLite.
- [rqlite](https://github.com/rqlite/rqlite) and [dqlite](https://github.com/canonical/dqlite): Raft-replicated SQLite.
- [LiteFS](https://github.com/superfly/litefs): FUSE-based SQLite replication.
- PostgreSQL, [Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html); [node-postgres](https://github.com/brianc/node-postgres).
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/) and [Restate](https://docs.restate.dev/): keyed single-writer state.
- Licenses and last-push dates were read from the GitHub API on 2026-10-26.
