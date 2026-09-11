[English](maka-research.md) | [简体中文](maka-research.zh-CN.md)

# Apache Maka (Incubating) Research → GoTry ADR-15 Transactional State Foundation Comparison

> Status: **research draft; conclusions await founder decision** (2026-08-28)
> Subject: [apache/maka](https://github.com/apache/maka) (an Apache Incubator podling, a local-first AI agent workspace). This document answers only four questions: what maka is, what its durable-execution mechanism is, an item-by-item comparison against the GoTry ADR-15 five-piece set, and what to adopt / not adopt / whether a re-review is triggered.
> Upstream authority: `../architecture.md` §8 ADR-15, `../rfc/transactional-state-rfc.md`; the reuse matrix (`../gotry-master-outline.md` §2) is a hard constraint on the adoption list.
> Source discipline: primary sources first (Incubator status page / mailing list on apache.org; architecture and schema cite in-repo file paths); secondary sources (Reddit etc.) serve only as leads and are marked unverified.

## §1 What It Is

| Item | Fact | Source |
|---|---|---|
| Exact name | **Apache Maka (Incubating)**; no official Chinese name (the Chinese README keeps "Maka" untranslated and declares "the English original prevails") | [podling status page](https://incubator.apache.org/projects/maka.html), [README.zh-CN.md](https://github.com/apache/maka/blob/main/README.zh-CN.md) |
| One-line positioning | "a local-first AI agent runtime and workspace" — a local-first AI agent runtime and workspace; model messages, tool calls, tool results, permission decisions, and termination events are all recorded as an append-only log | [repo description](https://github.com/apache/maka) |
| Product shape | Electron desktop (macOS ARM early public build / Windows unsigned preview / Linux desktop unsupported) + TUI/CLI (`maka-agent` npm package) + declarative Eval; all three shapes execute through the same Runtime Host process | [README](https://github.com/apache/maka), [CLI README](https://github.com/apache/maka/blob/main/packages/cli/README.md) |
| Donor | No single-company donation: the code was originally at `github.com/maka-agent/maka-agent` (created 2026-05-27, Apache-2.0) and moved to the apache org on entering the Incubator (the old address now 301-redirects to apache/maka); the proposal positions it as a "vendor-neutral community donation"; founder Jie Wen (jackwener, listed with Botiverse, Inc.); 7 initial committers spread across 6 organizations + 1 independent developer | [maka-proposal-zh-review.txt](https://github.com/apache/maka/blob/main/maka-proposal-zh-review.txt) (draft v0.11; the English original prevails for the official version), [api.github.com redirect test](https://api.github.com/repos/maka-agent/maka-agent) |
| Incubation timeline | [DISCUSS] from 2026-08-05 → [VOTE] 2026-08-09 (initiated by champion tison) → [RESULT] accepted into the Incubator on 2026-08-13; GitHub repository created 2026-05-27 | [marc.info archive](https://marc.info/?l=incubator-general&s=maka&w=2&r=1&q=b), [podling status page](https://incubator.apache.org/projects/maka.html) |
| Champion / Mentors | champion: tison (Zili Chen); mentors: xuanwo (Hao Ding) / benjobs (Huajie Wang) / psiace (Zhuoran Shang) / tanxinyu (Xinyu Tan) | [podling status page](https://incubator.apache.org/projects/maka.html) |
| Current stage | Early podling: most of the Incubator setup checklist is unchecked (SGA receipt / ASF copyright headers / CLA and LDAP for all committers marked pending); no graduation/retirement markers; the proposal self-estimates incubation at "about two years, depending on forming a sustainable, diverse committer base" | [podling status page](https://incubator.apache.org/projects/maka.html), [proposal review](https://github.com/apache/maka/blob/main/maka-proposal-zh-review.txt) |
| Provenance doubt | A post on Reddit r/PiCodingAgent speculates that maka is "partially based on the Pi coding agent"; the in-repo NOTICE contains only the standard ASF paragraph, zero third-party attributions; a full code search for badlogic / pi-mono / "pi coding agent" returns 0 hits — **the speculation has no code-level evidence and is recorded as an unverified community rumor** | [Reddit post](https://www.reddit.com/r/PiCodingAgent/comments/1vuxacp/looks_like_apache_maka_agent_is_partially_based/), [NOTICE](https://github.com/apache/maka/blob/main/NOTICE), GitHub code search test |

Conclusion: the opposite of "no such project" — maka is real, entered the Incubator on 2026-08-13, and its positioning is closely aligned with GoTry: **local-first, single-machine, TS, append-only ledger as the authority**. It is the Apache-side specimen of the "transactional agent execution" direction.

## §2 Architecture Deep Dive (Key Focus)

### 2.1 Layers and Core Concepts

```
Desktop / TUI / CLI / Bot → Runtime Host (the sole execution authority)
  → SessionManager → RuntimeKernel → AgentRun (durable execution envelope)
  → AgentBackend (AiSdkBackend: model/tool loop) + ToolRuntime
  → Runtime Event Log (canonical)
  → Context / Session / UI / Recovery projections
Eval (Experiment → Cells → Attempts → Results) → Runtime Host
```

Sources: [ARCHITECTURE.md](https://github.com/apache/maka/blob/main/ARCHITECTURE.md), [runtime-core-architecture-draft.md](https://github.com/apache/maka/blob/main/docs/architecture/runtime-core-architecture-draft.md) (the production path verified on 2026-08-23).

- **Single execution authority**: "Maka has one execution authority: Runtime Host" — no client owns a second Runtime (ARCHITECTURE.md).
- **Core equation** (isomorphic to GoTry's "projection = fold(events)"; original text): `State(t) = Project(RuntimeEvents[0..t], policy, runtime configuration)`; "Log is the source of truth; state is a materialized view". Model history, UI read models, terminal-state determination, recovery, and context compaction are all projections of the same log ([core draft §Conclusion-first](https://github.com/apache/maka/blob/main/docs/architecture/runtime-core-architecture-draft.md)).
- **Three lifecycle identities**: Session (long interaction) / Turn (user-visible round) / Run (a concrete execution attempt; AgentRun is the durable envelope); plus invocationId as a compatibility field for event correlation.
- **Intellectual sources (its own account)**: Google ADK (Session = fact container, Events carry actions/stateDelta) + the distributed-systems log-first tradition (WAL/event sourcing/Kafka); it explicitly declares it is "not an in-process Kafka and does not do consensus logging" ([core draft §Two lines of intellectual influence](https://github.com/apache/maka/blob/main/docs/architecture/runtime-core-architecture-draft.md)).
- **Package structure**: `packages/core` (pure contracts: Session/RuntimeEvent/AgentRun/permission/protocol), `packages/storage` (interactive runtime store + SQLite control plane), `packages/runtime` (SessionManager/AgentRun/adapters/recovery), `packages/runtime-host` (host lifecycle/protocol), `packages/eval`, `packages/cli`, `apps/desktop` (ARCHITECTURE.md Code boundaries table).

### 2.2 Modeling of Agent Execution and State

- **A RuntimeEvent is not "role+text" but a seven-dimension orthogonal decomposition**: Identity (sessionId/invocationId/runId/turnId/branch), Ordering, Source (role×author dual axes: a permission-decision fact has role=system but author=user), Content, **Actions** (state delta/permission/artifact/usage/end), Correlation (stable tool call-result pairing), Lifecycle (partial/status) ([core draft §What one RuntimeEvent preserves](https://github.com/apache/maka/blob/main/docs/architecture/runtime-core-architecture-draft.md), [packages/core/src/runtime-event.ts](https://github.com/apache/maka/blob/main/packages/core/src/runtime-event.ts)).
- **Permission = runtime control flow, not a dialog**: an out-of-bounds tool returns `sandbox_boundary_required` + a concrete expansion; the model calls `request_sandbox_boundary` to initiate a boundary-expansion request; execution parks at an identified location to wait; the Session projection shows `waiting_for_user` but the Run identity is not lost ("parked"). Requests and decisions are both typed facts (carrying only actions.stateDelta, no content) (core draft §Permission is runtime control flow).
- **Platform sandboxes**: macOS Seatbelt / Linux bubblewrap+seccomp / Windows AppContainer broker; all fail-closed, with no silent fallback to host execution ([packages/runtime/src/sandbox/README.md](https://github.com/apache/maka/blob/main/packages/runtime/src/sandbox/README.md)).
- **Task ledger**:
  - session-level task model with four tools, `task_create/task_update/task_list/task_get`; a six-state machine (pending/in_progress/blocked/completed/failed/cancelled) + controlled transitions; **evidence is mandatory in the contract** — blocked must carry blockedReason, failed must carry failureReason, completed must carry completionEvidence; recovery classifier `resumeTrust` (trusted/needs_revalidation/stale/repaired/untrusted);
  - child agents can only claim tasks, never steal them: "A successful child does not complete the task. The parent agent must verify the result and supply completionEvidence". Explicit non-goal: "no workflow engine" ([docs/session-task-ledger-lifecycle.md](https://github.com/apache/maka/blob/main/docs/session-task-ledger-lifecycle.md)).

### 2.3 Persistence / Transactions / Durable-Execution Mechanism

**Storage choices**:
- SQLite (`runtime.sqlite` as the live record), but using **`node:sqlite` (Node's built-in DatabaseSync) rather than better-sqlite3**;
- PRAGMA: WAL + `synchronous = FULL` + `foreign_keys = ON` + `busy_timeout = 5000` ([packages/storage/src/sqlite-runtime-schema.ts](https://github.com/apache/maka/blob/main/packages/storage/src/sqlite-runtime-schema.ts) `configureSqliteRuntimeDatabase`).
- Schemas are sharded by domain, each versioned independently: runtime v12 / core-execution v5 / workflow v9 / session-metadata / usage / artifact / long-term-memory (each in `sqlite-*-schema.ts`, [packages/storage/src](https://github.com/apache/maka/tree/main/packages/storage/src)).

**Event sourcing (physical-layer evidence, [sqlite-runtime-schema.ts](https://github.com/apache/maka/blob/main/packages/storage/src/sqlite-runtime-schema.ts) MIGRATIONS)**:

| Table | Responsibility | Key constraints |
|---|---|---|
| `runtime_events` | semantic ledger (the sole authority) | `event_seq > 0 CHECK`, `UNIQUE(invocation_id, event_seq)` — the storage-layer meaning of "ordered log" |
| `tool_journal_events` | tool operation journal (state stream) | `journal_event_id UNIQUE`, `canonical_args_hash`, `recovery_mode`, `external_handle`, FK → runtime_events |
| `tool_operations` | current state of tool operations | `UNIQUE(invocation_id, provider_tool_call_id)` = tool-call-level idempotency key; `version > 0` |
| `runtime_continuation_claims` | claim credentials for resuming after a crash | `source_event_high_water > 0`, `source_prefix_digest`, `boundary_digest UNIQUE`, quadruple UNIQUE + three target UNIQUEs — **database unique constraints as claim idempotency** |
| `runtime_capabilities` | migration capability gating (capability/version rows) | recovery / continuation / workspace_version authority each registered |
| `runtime_workspace_epochs/versions/heads` | git workspace versioning (epoch→version→head, commit/tree oid, bound to accepted_event) | origin_kind CHECK = 'baseline' etc. |
| `runtime_session_event_ordinals` | session-level dense ordinals | WITHOUT ROWID + ON DELETE CASCADE |

The workflow domain ([sqlite-workflow-schema.ts](https://github.com/apache/maka/blob/main/packages/storage/src/sqlite-workflow-schema.ts)) is standard **events+projection pairing**: `workflow_task_ledger_events`/`workflow_task_ledger_projections`, `workflow_plan_events`/`workflow_plan_projections` (`store_version UNIQUE` optimistic concurrency), `workflow_scheduled_tasks` + `workflow_scheduled_task_fires` (`task_id UNIQUE` — **a scheduled task can fire only once; the fire claim is idempotent**), `workflow_work_board_items` (revision ≥1 CAS + scope CHECK).
- The core execution domain ([sqlite-core-execution-schema.ts](https://github.com/apache/maka/blob/main/packages/storage/src/sqlite-core-execution-schema.ts)) additionally has `core_root_turn_admissions`/`core_root_turn_start_rejections`/`core_root_source_message_proofs` (turn admission/rejection/message proof = turn-level intent-before-execute) and `core_interaction_requests`/`core_interaction_outcomes` (permission request→ruling persisted; FK forces pairing).

**intent-before-execute (three places, all "persist first, execute second")**:
- ① `AgentRun.begin()` persists the initial user RuntimeEvent before dispatching the Backend;
- ② Run Composer: builds an immutable Run Composition (system prompt/tool catalog/policies and their revisions) → commits it to the AgentRun store → **calls the provider only after the commit succeeds** ("Provider dispatch waits for a durable Run Composition commit", [runtime-host-architecture.md](https://github.com/apache/maka/blob/main/docs/architecture/runtime-host-architecture.md) rule 8);
- ③ Tool layer T1/T2: Phase 2 "T1 guaranteed before tool execution and T2 before returning the result" ([runtime-resume-architecture.md](https://github.com/apache/maka/blob/main/docs/architecture/runtime-resume-architecture.md) phase table).

**Crash recovery (Phase 0-4, tiered fact capabilities)** ([runtime-resume-architecture.md](https://github.com/apache/maka/blob/main/docs/architecture/runtime-resume-architecture.md)):

| Phase | Question answered | Status |
|---|---|---|
| 0 | With only committed RuntimeEvents, is this prefix safe to replay | Implemented |
| 1 | Can a new Run be created at a complete safe boundary | Implemented, feature-flagged (default off, `MAKA_RUNTIME_SAFE_BOUNDARY_RESUME=1`) |
| 2 | Can T1 (before execution) / T2 (before returning the result) be guaranteed | Implemented in SQLite canonical mode |
| 3A | A single authority for recovery facts + atomic bundle | Implemented |
| 3 | Can tool-specific evidence adjudicate unknown side effects | Designed; production reconciler not wired |
| 4 | Can the Runtime boundary bind to workspace snapshots (restore/rebaseline) | Designed, not implemented |

Five design rules: resume creates a **new execution** (it does not revive the old stack); the RuntimeEvent is the sole source of recovery facts; **a missing result ≠ failure and also does not prove non-execution**; if safety cannot be proven, park (model self-reports cannot raise the evidence grade); workspace identity proves only "same workspace", not "content unchanged". Recovery order = repair (converge the old Run's terminal state) → resolve/reconcile (tool state) → resume (continue under a new identity); a continuation consumes a one-shot start proof, does not duplicate user events, and records lineage via `continuationSource`.

**Terminal invariant (log-first invariant)**: "A terminal Run must have exactly one valid terminal RuntimeEvent, and a terminal Run header must be supported by that terminal fact." After the first terminal fact takes effect, the remainder drains silently; a stream with no terminal event converges to a `missing_terminal_event` structured failure; when the header contradicts the facts, repair conservatively (core draft §The log-first invariant). Startup recovery "does not re-execute model requests or tool side effects" — it does state repair only, not checkpoint resume.

**Honesty boundary (its own declared list of non-promises)**: no instruction-pointer recovery; **no promise of exactly-once for arbitrary Bash / remote API / subprocess side effects**; no automatic settlement of real side effects left T1-without-T2; process crash + SQLite transaction atomicity ≠ proof of power-loss durability; no bit-exact thread-level replay; the Runtime Host "does not promise that an arbitrary external side effect happens exactly once...must not retry automatically unless the operation explicitly permits it" (host architecture + resume document, "Current limitations and explicit non-goals").

### 2.4 Concurrency Model

Three layers of single-writer, no distributed components:

1. **In-process**: `SerializedOperationLane` (a promise-chain serial lane, "Admits an operation into its owner before waiting for earlier operations", [packages/storage/src/serialized-operation-lane.ts](https://github.com/apache/maka/blob/main/packages/storage/src/serialized-operation-lane.ts));
2. **Cross-process**: the Host Kernel holds an **exclusive writer lease** on the State Root ("One State Root has at most one writer owner"); turn-level admission reserves atomically ("One Session has at most one root Hosted Execution or pending root admission"); plus file locks (corroborated by test fixtures such as root-lock/artifact-writer-lock);
3. **SQLite layer**: busy_timeout + migrations double-read `user_version` under `BEGIN IMMEDIATE` to prevent concurrent openers from migrating twice.

CAS variants: work_board `revision`, plan `store_version`, goal `authority_revision` (all optimistic versions materialized as UNIQUE/CHECK). A client disconnect does not cancel admitted executions; streams/notifications never serve as the recovery authority — "recovery always rereads durable facts".

### 2.5 Memory and Evaluation (Relevant to the GoTry Memory and Inspection Surfaces)

- Durable long-term memory subsystem: `packages/storage/src/sqlite-long-term-memory-{schema,store}.ts` + `memory-extraction(+-proposal).ts` (memory extraction into SQLite, with a crash test `sqlite-long-term-memory-crash.test.ts`);
- Eval kernel: Experiment = benchmark+executor+subjects+tasks+repetitions; Cell = task×repetition×subject; the attempt log is **append-only**, "result selection always uses the earliest valid attempt" — the operator cannot cherry-pick results;
  - "A/B is simply a two-arm Experiment" ([packages/eval/README.md](https://github.com/apache/maka/blob/main/packages/eval/README.md), [ARCHITECTURE.md](https://github.com/apache/maka/blob/main/ARCHITECTURE.md)).
## §3 Developer Surface

**Key abstractions**: SessionManager.sendMessage() (facade) / RuntimeKernel.startTurn() (control plane) / AgentRun (execution envelope) / RuntimeEvent (seven-dimension fact) / TaskLedgerStore (task ledger port) / Run Composition (frozen model-visible baseline).

**Real examples** (source: [packages/cli/README.md](https://github.com/apache/maka/blob/main/packages/cli/README.md)):

```sh
npm install --global maka-agent@next
cd path/to/project && maka
maka run "Summarize this project and identify its highest-risk area"
maka run --graph "Implement two independent slices, integrate them, then review the result"
maka eval run experiment.json --out .maka-eval/run-001
```

The model-side tool surface is exactly the task ledger four-piece set; the host-side workspace target is a closed union type (source: [runtime-host-architecture.md](https://github.com/apache/maka/blob/main/docs/architecture/runtime-host-architecture.md)):

```ts
type WorkspaceTarget =
  | { kind: "project"; projectId: string }
  | { kind: "host_path"; path: string };
```

Local data shape: under `<profile>/workspaces/default/`, `runtime.sqlite` + `connection-catalog.json` + `credential-vault.json` (plaintext local files, protected by the OS account boundary) + `settings.json` + `artifacts/` ([README](https://github.com/apache/maka)); old JSONL transcripts are not migrated. Note: **Maka has no embeddable library-style API** — its external surface is the CLI/TUI/desktop/Runtime Host protocol; the "ledger" is not exposed as a public library; the `maka-agent` npm package is only the CLI distribution shell.

## §4 Ecosystem and Comparison (Its Own Account)

- **No comparison with Temporal/DBOS/LangGraph/Restate**: a whole-repo code search for "DBOS" and "LangGraph" returns 0 hits; the 10 hits for "Temporal" are all the time-dimension (temporal) word in long-term-memory, unrelated to workflow engines (GitHub code search test, 2026-08-28).
- Its self-positioning frame of reference is **Google ADK** (Session = fact container, events carry actions) and the **log-first tradition of WAL/event sourcing/Kafka** (core draft §Two lines of intellectual influence + Further reading links to the ADK blog post and the Kafka design document).
- It draws a clear line against the "workflow engine": the task ledger's explicit non-goals are "no workflow engine; no cron or automation scheduling; no replacement for AgentRun/RuntimeEvent..." ([session-task-ledger-lifecycle.md](https://github.com/apache/maka/blob/main/docs/session-task-ledger-lifecycle.md)). It is not a Temporal-style orchestration platform; it is "the single-machine log as the runtime".
- The README doc tree carries six bilingual Chinese-English in-depth articles and a DeepWiki mirror; no official comparison piece has been published.

## §5 Maturity

| Dimension | Fact | Source |
|---|---|---|
| Activity | 3,817 stars / 359 forks / 3,971 commits / ~96 contributors / 323 open issues; latest push 2026-08-28 (still active that day); the proposal snapshot on 2026-08-03 showed 1,104 stars — about 3.5x after the incubation announcement | [api.github.com](https://api.github.com/repos/apache/maka) test, [proposal review](https://github.com/apache/maka/blob/main/maka-proposal-zh-review.txt) |
| Releases | 14 GitHub releases (latest v0.1.11, 2026-08-18); npm `maka-agent` dist-tags: next=0.1.0-beta.1, latest=0.0.0-alpha.0; **no ASF-approved release yet** (README: "Apache Maka has not yet made an Apache release"; `.github/ASF_SOURCE_RELEASE.md` governs source releases) | [releases](https://github.com/apache/maka/releases), [npm](https://www.npmjs.com/package/maka-agent), [README.zh-CN](https://github.com/apache/maka/blob/main/README.zh-CN.md) |
| License | Apache-2.0 + ASF trademark and incubation disclaimer | [repo](https://github.com/apache/maka) |
| Known limitations | Platform: desktop is the macOS ARM early public build only (Windows unsigned preview, Linux desktop unsupported); resume is off by default; Phase 3 reconciler / Phase 4 workspace snapshots not implemented; plaintext credential vault; no proof of power-loss durability; Incubator setup (SGA/copyright headers/CLA) incomplete | [README](https://github.com/apache/maka), [resume architecture](https://github.com/apache/maka/blob/main/docs/architecture/runtime-resume-architecture.md), [podling status page](https://incubator.apache.org/projects/maka.html) |
| Roadmap | resume PR B (immutable event-seq high-water mark + prefix digest + DB-unique claims), PR C/D (production file-evidence reconciler + host-owner lifecycle), Windows sandbox (issue #2142), Phase 4 git workspace continuity | [resume architecture tail section](https://github.com/apache/maka/blob/main/docs/architecture/runtime-resume-architecture.md), [sandbox README](https://github.com/apache/maka/blob/main/packages/runtime/src/sandbox/README.md) |
| Governance risks (self-acknowledged in the proposal) | community homogeneity (Chinese-speaking collaboration circle), dependence on paid developers; mitigation = decisions on the English mailing list, cross-circle recruitment; name risk ("Maka" was used beforehand; PODLINGNAMESEARCH pending) | [proposal review](https://github.com/apache/maka/blob/main/maka-proposal-zh-review.txt) |

## §6 Comparison with GoTry ADR-15 (Five-Piece Set, Item by Item)

The ADR-15 five-piece set is defined in `../rfc/transactional-state-rfc.md` §2.2; maka-side evidence is in §2.

| # | Five-piece set | GoTry (landed) | Apache Maka | Verdict |
|---|---|---|---|---|
| 1 | append-only ledger as the sole authority | `events` table with semantic idempotency keys materialized as UNIQUE (`state-ledger.ts`) | `runtime_events`, `UNIQUE(invocation_id, event_seq)`; tools/turns/continuations each have UNIQUE idempotency keys; "State is a projection over the ordered log" | **Same**. Difference: GoTry hangs idempotency keys on **semantic keys** (same wish / same confirmation), maka on **execution-flow keys** (same invocation / same tool call / same claim) — the former prevents business duplicates, the latter prevents execution duplicates; complementary, not conflicting |
| 2 | projection = deterministic fold, rebuildable via DROP | projection tables + `state-cli rebuild`; gatekeeper pure functions reused as fold handlers | projections are first-class citizens: model history/UI/terminal state/recovery/compaction are all projections; the workflow domain physically pairs events+projections | **Same; maka goes further** (it treats even the "next prompt" as a projection: compaction changes the projection, not the history) |
| 3 | red lines baked into transactions/schema | evidence/conditions validated inside the write transaction; rejection rolls back | evidence is mandatory in the task ledger contract (blocked/failed/completed must carry reason/evidence); CHECK constraints throughout the schema; the fail-closed principle runs through sandboxing/recovery | **Same idea, different placement**: GoTry enforces domain red lines (profile evidence / wish conditions), maka enforces execution red lines (task evidence / safety boundaries). GoTry needs no change |
| 4 | step log + intent-before-execute; after a crash, done steps re-execute zero times | `workflow_runs/steps`; after kill -9, done steps fetch their result instead of re-executing (exactly-once) | T1/T2 tool journal + Run Composition committing before the provider is called + `core_root_turn_admissions` + `latest_model_call_sequence` high-water mark; recovery "never repeats a completed tool" | **Same**. maka is finer-grained: model calls themselves have a high-water mark (never paying twice for an LLM call = maka's model-call sequence watermark ≈ the same motivation as GoTry TS-3). GoTry already covers this |
| 5 | saga for external side effects | `pending_writes` (pending/confirmed/compensated + idempotency key + receipt + compensation; the foundation of WriteGate L2/L3) | **no saga state machine**. The counterpart = permission interaction (request→outcome) + sandbox expansion approval + park semantics; it explicitly declines to promise exactly-once for arbitrary external side effects and does not auto-retry outcome-unknown | **Different trade-off**: maka "honestly parks + leaves unknown", GoTry "closes the loop with compensation". See §7-A2 — GoTry should absorb its unknown state |

Incremental differences beyond the ledger (maka has, GoTry lacks): a resident host process and client protocol (not adopted, §7), platform sandboxes, git workspace versioning, task ledger/WorkBoard/Agent Graph subagents, the Eval container kernel, the durable long-term memory subsystem. GoTry has, maka lacks: **reuse of semantic-layer gatekeeper pure functions** (maka projections have no domain-semantic gatekeeper concept), `rewind` time-travel debugging (maka's "debugger at any event boundary" is future work), `VACUUM INTO` what-if forks, and the ledger-operations CLI surface (export/forget/tick).

## §7 Conclusion: Adopt / Do Not Adopt / Re-Review Triggers

### A. Adoption List (each item: value / cost / reuse-matrix compliance / suggested slice)

| # | Adoption item | Value | Cost | Reuse matrix | Slice suggestion |
|---|---|---|---|---|---|
| A1 | **Terminal invariant**: "a terminal state must be supported by a terminal event; a run with no terminal fact converges to a structured failure and is never left running forever" | guards against the "work order/turn stuck in running" failure class that the maka documentation names as the hardest; GoTry's `state-cli tick` reclamation is an approximation but lacks an explicit judgment for this invariant | small: add a convergence check to `state-ledger.ts` + a §28 assertion | purely in-repo implementation, zero dependencies | fold into a small ledger-hardening slice before M5 (≈0.5d) |
| A2 | **add an `unknown` state to pending_writes** (pending→executing→{confirmed,compensated,unknown}): a crash after execution but before the receipt must not be auto-retried nor judged failed | maka devotes an entire resume-architecture chapter to arguing "a missing result ≠ failure and ≠ non-execution"; GoTry needs exactly this vocabulary when WriteGate M5 is decided, otherwise the idempotency key invites the misjudgment that "retrying is safe" | small: extend the state machine by one state + tick only alerts on unknown, takes no action | purely in-repo | fold into the M5 WriteGate design (the table is already reserved in TS-4) |
| A3 | **a `resumeTrust`-style recovery classifier vocabulary** (trusted/needs_revalidation/stale/repaired/untrusted) for work-order recovery and projection health checks, kept out of model context | gives `state-cli doctor` a conservative grading language; inspection reports can judge "is this recovery trustworthy" | small | purely in-repo | same slice as A1 |
| A4 | **two migration disciplines**: double-read the version number under `BEGIN IMMEDIATE` to guard against concurrent openers; capability rows gating per-domain schema versions | GoTry's first-write auto-migration is already safe, but under multiple processes (cli+web+nudge in concurrency) the double-read is cheap insurance | minimal | purely in-repo | opportunistically with the next `state-ledger.ts` change |
| A5 | **eval honesty discipline**: append-only attempts + earliest-valid-attempt-wins (no cherry-picking results) + a "single-arm and multi-arm are not comparable"-style boundary statement | a posture template for when the GoTry inspection layer (ADR-11) issues reports — prevents "picking the flattering replay" | zero code; write it into the inspection report spec | documentation | takes effect with the next inspection round |
| A6 | **record node:sqlite as a production reference** | maka runs production + crash harnesses on node:sqlite, corroborating that the ADR-15 D1 fallback option is genuinely viable | zero | node built-in = zero dependencies | no action; recorded in this file only, to be cited if better-sqlite3 native friction worsens |

### B. Explicitly Not Adopted (with reasons)

| # | Item | Reason |
|---|---|---|
| B1 | Runtime Host resident process + IPC/WebSocket protocol + remote Host | assumes a server/multi-client premise; GoTry is single-machine single-user with the dsh harness as host (ADR-15 §1.3 explicitly leaves the harness session layer untouched); introducing a second execution authority directly violates the dsh boundary |
| B2 | Electron desktop / platform sandboxes (Seatbelt/bubblewrap/AppContainer) / Computer Use | GoTry has no code-execution or file-work surface (same conclusion as the deerflow research: the solver runs in-process at ~6ms); GoTry's write protection uses the ReadGuard/WriteGate vocabulary and needs no OS sandbox |
| B3 | Eval container kernel (Harbor/Pier/mitmproxy/nftables egress policies) | heavyweight benchmark infrastructure; the GoTry inspection layer (replay/time-eval) already covers product needs, and the reuse matrix also forbids importing this dependency blob |
| B4 | git workspace versioning (workspace epochs/versions/heads) | GoTry has no file-based workspace; the ledger + the one-way `state-cli export` view already covers red line 6 |
| B5 | task ledger / WorkBoard / Agent Graph subagents | domain mismatch: maka manages code-workbench tasks, while GoTry's durable work orders (workflow_runs/steps) + wish pool semantics already suffice; importing it would be over-engineering |
| B6 | four coexisting event vocabularies (SessionEvent/StoredMessage/RuntimeEvent/operational run events) | maka itself lists this under "current costs"; GoTry's "zero refactor of the semantic layer" route exists precisely to avoid this tax |

### C. ADR-15 Re-Review Trigger Verdict

**Not triggered**. The re-review condition is "multi-user AaaS-ization or a need for multi-writer / multi-endpoint replication"; maka is precisely the counter-example: a single-writer (single State Root exclusive writer lease), single-machine local-first TS+SQLite system with no server-side component — **the same shape family as ADR-15**. Its remote Host is also just a connection form of "one State Root, one owner", not multi-writer replication. It can serve as one piece of external corroboration for the ADR-15 re-review condition: the benchmark project in this direction chose the same single-writer boundary. Incidental finding (does not constitute a re-review): maka chose `synchronous=FULL` while GoTry chose NORMAL (the single-machine balance between crash safety and write latency, argued in RFC §4.4); maka also honestly states "a process-crash proof ≠ a power-loss durability proof" — if GoTry later adds power-loss durability tests, re-evaluate the upgrade.

## §8 Complete Reference List

Primary (ASF / official repository):

1. Apache Maka podling status page (entered the Incubator 2026-08-13; mentors/champion; setup checklist) — https://incubator.apache.org/projects/maka.html
2. apache/maka repository (README/description/topics/license/star count) — https://github.com/apache/maka
3. ARCHITECTURE.md (backend authority: single execution authority/layers/package boundaries/Eval boundary) — https://github.com/apache/maka/blob/main/ARCHITECTURE.md
4. maka-proposal-zh-review.txt (Chinese-language proposal review v0.11: donation form/initial committers and affiliations/timeline/risks) — https://github.com/apache/maka/blob/main/maka-proposal-zh-review.txt
5. docs/architecture/runtime-core-architecture-draft.md (Log is the Runtime; State(t)=Project; terminal invariant; ADK/Kafka intellectual sources; verified 2026-08-23) — https://github.com/apache/maka/blob/main/docs/architecture/runtime-core-architecture-draft.md
6. docs/architecture/runtime-host-architecture.md (State Root writer lease; admission; Run Composition commits before dispatch; 13 rules; side effects not guaranteed exactly-once) — https://github.com/apache/maka/blob/main/docs/architecture/runtime-host-architecture.md
7. docs/architecture/runtime-resume-architecture.md (Phase 0-4; T1/T2; park/fail-closed; capability matrix; explicit non-promise list; PR B/C/D roadmap) — https://github.com/apache/maka/blob/main/docs/architecture/runtime-resume-architecture.md
8. docs/session-task-ledger-lifecycle.md (task state machine/mandatory evidence/resumeTrust/child-agent claim/non-goal "no workflow engine") — https://github.com/apache/maka/blob/main/docs/session-task-ledger-lifecycle.md
9. packages/storage/src/sqlite-runtime-schema.ts (runtime_events/tool_journal/tool_operations/continuation_claims/capabilities; node:sqlite; WAL+FULL; migrations double-read under BEGIN IMMEDIATE) — https://github.com/apache/maka/blob/main/packages/storage/src/sqlite-runtime-schema.ts
10. packages/storage/src/sqlite-workflow-schema.ts (events+projections pairs for task/plan; scheduled_task_fires single-fire; work_board revision CAS) — https://github.com/apache/maka/blob/main/packages/storage/src/sqlite-workflow-schema.ts
11. packages/storage/src/sqlite-core-execution-schema.ts (turn admissions/rejections/proofs; interaction request→outcome; model-call high-water mark) — https://github.com/apache/maka/blob/main/packages/storage/src/sqlite-core-execution-schema.ts
12. packages/storage/src/serialized-operation-lane.ts (in-process serial lane) — https://github.com/apache/maka/blob/main/packages/storage/src/serialized-operation-lane.ts
13. packages/runtime/src/sandbox/README.md (Seatbelt/bubblewrap/AppContainer, fail-closed) — https://github.com/apache/maka/blob/main/packages/runtime/src/sandbox/README.md
14. packages/core/src/runtime-event.ts (RuntimeEvent contract: role×author×status×origin×visibility) — https://github.com/apache/maka/blob/main/packages/core/src/runtime-event.ts
15. packages/cli/README.md (install/first run/upgrade/runtime-host service; platform verification matrix) — https://github.com/apache/maka/blob/main/packages/cli/README.md
16. packages/eval/README.md (Experiment/Cell/Attempt; earliest-valid-attempt; the honesty boundary against out-of-bounds strategies) — https://github.com/apache/maka/blob/main/packages/eval/README.md
17. README.zh-CN.md (Chinese positioning; no-Apache-release statement; resume off by default) — https://github.com/apache/maka/blob/main/README.zh-CN.md
18. NOTICE (ASF standard attribution only, no third parties) — https://github.com/apache/maka/blob/main/NOTICE
19. docs/README.md (documentation authority map) — https://github.com/apache/maka/blob/main/docs/README.md
20. marc.info incubator-general archive ([VOTE] 2026-08-09 → [RESULT] 2026-08-13) — https://marc.info/?l=incubator-general&s=maka&w=2&r=1&q=b
21. Whimsy PPMC roster / board minutes — https://whimsy.apache.org/roster/ppmc/maka · https://whimsy.apache.org/board/minutes/maka.html
22. maka-agent npm (dist-tags next=0.1.0-beta.1) — https://www.npmjs.com/package/maka-agent
23. GitHub releases (14 total; latest v0.1.11, 2026-08-18) — https://github.com/apache/maka/releases

Secondary (leads only; either verified back against primary sources or marked unverified):

24. Reddit r/PiCodingAgent "maka partially based on Pi" — unverified (see §1 provenance doubt) — https://www.reddit.com/r/PiCodingAgent/comments/1vuxacp/looks_like_apache_maka_agent_is_partially_based/
25. MoClaw blog post "The Agent That Logs Everything" and other third-party coverage — not used in conclusions

GoTry side (in-repo): `docs/architecture.md` §8 ADR-15 / §11 state surfaces; `docs/rfc/transactional-state-rfc.md` (five-piece set/TS-0..5/D1-D5); `docs/research/deerflow-research.md` (style and the "do not borrow" precedent).
