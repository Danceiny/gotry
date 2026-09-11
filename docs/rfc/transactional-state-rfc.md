[English](transactional-state-rfc.md) | [简体中文](transactional-state-rfc.zh-CN.md)

# RFC: GoTry Transactional State Backbone — Industry Survey and Implementation Plan

> Status: **accepted** (2026-08-28 founder directive "go with your recommendations" — D1-D5 all executed as recommended; TS-0..TS-4 landed, TS-5 trigger-based and deferred = D-15)
> Upstream authority: `../architecture.md` (technical authority), `../gotry-master-outline.md` §2 reuse matrix, `loopx-inspired-upgrades-rfc.md` (S4/§6.5), `../design/memory-design.md` §1.6, `../tech-strategy.md` T6
> Author: gotry-builder (2026-08-28, driven by industry survey + in-repo current-state inventory)
> Discipline: one file carries one concern; version history belongs to git

## 0. The Claim in One Sentence

Upgrade "file as authority" to "**a single-file SQLite ledger as the authority**": an append-only event stream (physicalized) + a projection of current state (reusing the existing pure-function gates) + schema-level red lines + durable work-order step logs + a pending_writes saga (the WriteGate substrate). **Zero rework of the semantic layer** — this is exactly the payoff path reserved by memory-design §1.6 ("ledgerization is a storage-surface replacement; the semantic layer changes zero"), and it conflicts with no already-accepted decision.

## 1. Why Now

### 1.1 Current Gaps (inventory evidence, 2026-08-28)

All persistence = bare JSON/JSONL files, zero database. Item by item:

| Gap | Evidence | Corresponding industry failure mode* |
|---|---|---|
| append-only is only a semantic discipline; physically it is a full rewrite | `memory-utility.jsonl`/`trips.jsonl` are both read-modify-write whole-file rewrites (`ts/src/index.ts:381-383`, `ts/src/index.ts:499-507`) | partial writes |
| Cross-file writes have no transaction boundary | confirm-outcome writes the memory-utility and trips files at the same time (`ts/src/index.ts:385-412`); a mid-way crash forks them | partial writes / cascading bad reads |
| Async work orders are not atomic | `persistAsyncTicket` is a bare `fs.writeFile` (`ts/src/loop.ts:310-329`), no tmp/rename/journal | recovery gap |
| No concurrency control | no locks / no versions / no CAS anywhere in the repo (the only lock sample is loopx's own `.loopx/registry.json.lock`) | blast radius |
| Red lines rely on convention, not physical enforcement | the evidence red line lives in the `mergeProfile` pure-function layer (already strong), but the 2026-08-26 inspection contamination incident proved that writing files directly, bypassing the tools, meets no physical interception | approval loss / blast radius |
| Audit chain broken | the production path of `gotry_session_search` never passes auditPath (`ts/src/index.ts:748-769`); the ReadGuard audit is an in-memory counter | audit gap |
| Unstable ids | wish_id / work-order ids are all timestamp-derived (`w${Date.now().toString(36)}`); no defense against concurrent collisions or clock rollback | idempotency missing |
| stateRoot fragmentation | `ASYNC_DIR` hardcodes a relative path and never attaches to stateRoot (`ts/src/loop.ts:303`) | — |

*The seven failure modes from Cockroach Labs' "Why Agent Loops Fail in Production": partial writes / cascading bad reads / blast radius / memory drift / recovery gap / approval loss / audit gap.

### 1.2 Three Approaching Triggers

1. **Seed users are imminent** (roadmap: remaining M3 = real seed users): one state copy per user; crash consistency shifts from "the founder can see it himself" to "product responsibility".
2. **M5 WriteGate needs a substrate**: tech-strategy T6 already lists the elements — idempotency keys / pending state / receipts; RFC S4 already fixed the L0-L4 vocabulary. All of these need a durable substrate where pending/receipt can land; today there is nowhere to put them.
3. **RFC §6.5 trigger conditions are near**: "complete the claim-fence-receipt design review before the second real user appears". For claim/CAS/receipt to hold in the multi-user phase, the prerequisite is a ledger in the single-machine phase (single authority + stable primary keys + idempotency keys). Starting the TS line now is prepaying that debt.

### 1.3 What We Will Not Do (guarding against over-engineering)

- **No Postgres/DBOS/Temporal/Restate platforms**: a single-user local product needs no server side and no broker; the "SQLite school" (§2.7) already provides a production-grade alternative model.
- **No touching the dsh harness session layer**: the dependency tree ships dsh with `dsh-session-persistence-jsonl`/`dsh-session-checkpoint-policy`/`dsh-session-projection`/`dsh-session-query-sqlite`; those four handle harness session persistence. This ledger governs only the **product state layer** (profile / wish pool / timeline / work orders / write authority); each layer governs its own side, with no duplicate journal.
- **No premature multi-user**: claim-fence-receipt stays deferred behind the RFC §6.5 trigger (TS-5).
- **No new Python surface** (hard constraint from the master outline).

## 2. Industry Frontier Scan (2025-2026)

### 2.1 Summary Table

| # | Approach | Core mechanism | What GoTry takes / leaves |
|---|---|---|---|
| 1 | **LoopX** (agent control plane; already surveyed first-hand in the in-repo RFC) | typed packet+receipt, observations never escalate into authority, read-only projection before execution, authority only via explicit rollback-capable seams, claim/CAS/receipt | Take: receipt/claim need a ledger landing spot — this plan supplies exactly that persistence layer; S1-S4 already mapped, no duplication |
| 2 | **DBOS** ("Postgres is all you need for durable execution") | before each step, record a checkpoint in a Postgres transaction; after a crash, recover from the journal; steps exactly-once | Take: the step-log mechanism; Leave: the Postgres service (replaced by single-machine SQLite) |
| 3 | **Temporal / Restate** | platform-level durable execution; event history + signal/query; Restate virtual objects serialize per key as single-writer + durable state | Take: the "one keyed single-writer per session" shape; Leave: platform deployment |
| 4 | **LangGraph** | checkpointer (SQLite/Postgres saver) stores checkpoints per thread; time travel = replay + fork | Take: the replay/fork debugging shape; rebuildable projections |
| 5 | **Letta (MemGPT)** | full agent state (memory blocks / history / tool config) lives in Postgres/SQLite; the agent edits its own memory via tools | Confirms "agent state as database rows"; GoTry's semantic layering is stronger — only the physical layer is missing |
| 6 | **Claude Code / Codex transcript school** | the JSONL transcript is the source of truth; resume/fork rebuilds from the transcript (arXiv 2604.14228); the Agent SDK treats "write JSONL every turn" as a first-class contract | Confirms append-only log-driven harnesses hold at production scale; GoTry's JSONL streams already share the shape — what is missing is "a single authority + transaction protection" |
| 7 | **SQLite durable school** (Obelisk et al.) | "control plane, or a single SQLite file?" — a single-SQLite execution log + Litestream→S3 = a complete durable-execution model (append-only log / deterministic replay / retryable activities), no broker; it honestly declares the async-replication RPO window | **The school adopted directly**: single-machine local-first + user data visible and deletable — a perfect fit |
| 8 | **TigerFS** (timescale) | Postgres mounted as a transactional file system; writes are transactions; v0.7 rolls back to any point; ships with agent skills | Take: the idea that "file writes need versions and rollback"; Leave: Postgres (ledger + projection export covers this need) |
| 9 | **Academic line**: SagaLLM / ATOMIX / DeltaState / GA-Rollback | saga compensation for agent rollback; timely transactional tool use; millisecond-level checkpoint/rollback; replayable environment stepping with rollback | Take: compensation semantics as the reference for the WriteGate saga |
| 10 | **Cockroach Labs' seven failure modes** | transactions / idempotency keys `ON CONFLICT DO NOTHING` / checkpoint tables / approvals stored in the database / append-only audit with privilege protection / temporal reads | Take: the §1.1 failure-mode alignment comes from this article; "approvals into the database" maps directly to pending_writes |
| 11 | **Effectful programming (algebraic effects)** | effects as protocols, handlers as data; an agent's pause/resume/side effects modeled as an effect interpreter; the LoopX effect-interpreter is the engineering of this line | Take: TS-3 step logs = effect execution logs (intent → observation landed in the ledger); the S1 tool-packet already laid the envelope |

### 2.2 The Shared Skeleton (the five-piece set)

Having scanned every school, the converged consensus of 2026:

1. **The append-only log is the sole authority** (source of truth); current state is only a view of the log.
2. **Current state = a deterministic projection of the log** (a pure-function fold); it can be dropped and rebuilt at any time.
3. **Invariants go into the schema/transactions**, not into conventions — a red line is either physically enforced or it does not exist.
4. **Long tasks = step logs + intent-before-execute**: record intent before executing; after a crash, done steps do not re-execute (exactly-once), untouched steps retry.
5. **External side effects = sagas**: pending → confirmed/compensated, idempotency keys deduplicate, receipts are the proof; database transactions protect internal state only, and the external world is handled with compensation.

GoTry's semantic layer is already being built in the shape of 2/3/5 (pure-function gates / idempotency keys / L0-L4 vocabulary); this plan fills in the **physical layer** of the five-piece set in one pass.

## 3. Existing Assets (all retained, zero rewrite)

| Asset | Evidence | Place in the new architecture |
|---|---|---|
| The full pure-function gating set | `mergeProfile` (`ts/src/memory-capture.ts:28-59`, appends never delete history / idempotent / weight changes carry evidence), `appendEvent` (`ts/src/memory-utility.ts:41-54`), `appendTrip` (`ts/src/travel-timeline.ts:48-62`), `upsertCompanion` (`ts/src/companions.ts:69-113`), `pickNudgeWish` (`ts/src/wish-pool.ts:53-66`) | They become the **fold handlers** and the projection-update logic directly, not one line changed |
| append-only semantic discipline + idempotent semantic keys | the pure functions above | Upgraded from "discipline" to "physical properties of the events table" |
| Atomic-write samples | `writeJson` tmp+rename (`ts/src/bridge.ts:33-39`); incident fsync (`ts/capabilities/incident-log.ts:51-65`) | Retired into implementation details of the export path |
| Test isolation shape | smoke mkdtemp stateRoot (`ts/scripts/smoke.ts:20-34`) | stateRoot becomes the DB path; the isolation shape stays **unchanged** (a throwaway DB in tmpdir) |
| Red-line vocabulary | ReadGuard (physically read-only mirror, `ts/capabilities/session/read-guard.ts`), WriteGate L0-L4 (RFC S4) | ReadGuard untouched; WriteGate gains a pending_writes landing spot |
## 4. Target Architecture

```
stateRoot/gotry-state.db        ← single-file SQLite, WAL mode, synchronous=NORMAL
├── events            the ledger (sole authority): seq PK / ts / actor / kind / subject_id /
│                     payload JSON / idem_key / run_id
├── projections        motivation_profile / wish_pool / companions / trips_view
│                     (derived data; DROP and rebuild via fold(events) at any time)
├── workflow_runs     durable work orders: id / goal / status / created / updated
├── workflow_steps    step log: run_id / seq / name / intent_ts / done_ts /
│                     status(pending|done|failed) / result
├── pending_writes    WriteGate saga: idem_key UNIQUE / seam / payload /
│                     status(pending|confirmed|compensated) / receipt
└── kv                schema_version and misc
```

### 4.1 Read/Write Discipline

- **Write = one transaction** `{INSERT INTO events; UPDATE projection}` — projections and events commit in the same transaction and never fork (this fixes the cross-file fork in §1.1).
- **Red lines go into the schema**: the evidence check from `mergeProfile` runs inside the transaction; missing evidence rolls back (the INSERT fails, the ledger shows no trace); a non-empty CHECK on wish conditions; the `idem_key` UNIQUE constraint physicalizes idempotency. "Red lines into code" upgrades to "red lines into schema" — bypassing the tools to write the DB directly no longer works (there is no write path outside the tools), and writing files while bypassing the DB no longer touches the authoritative state.
- **Read = query the projections directly** (the fast path, zero rework); **rebuild = fold(events)** (isomorphic to a LangGraph rebuild).
- **Export = a command dumps the projections back to the old JSON/JSONL filenames**: files are demoted from "authority" to "view", and red line 6 (user data visible, editable, deletable, exportable) keeps holding — a user deleting an exported file deletes the view; truly deleting data = `gotry-state forget <subject>` (one transaction deletes all events for that subject + rebuilds the projections, and the deletion itself is an auditable event... if red line 6 demands "delete means really delete", then a physical DELETE plus VACUUM; both are supported — decision point D5).
- **Replay/fork = fold to any seq**: "what if this profile write had never happened" becomes one command (LangGraph replay/fork; shared by debugging and gold-standard regression).
- **Crash safety = WAL + transactions**: kill -9 at any moment, and after restart it is all-or-nothing; work orders / profile / timeline no longer have half-written rows.

### 4.2 Durable Work Orders (making "come back in an hour" real)

`workflow_steps` implements DBOS/Obelisk-style step logging:

```
requestAsync(goal)    → transaction {INSERT run + step(intent)} → visible immediately
collectDeepPlanning   → each step: record intent → execute (LLM/solver) → record done+result
any process resumes   → read steps: done ones take the result directly without re-executing
                        (exactly-once, LLM calls are never paid for twice); failed/hanging
                        intent ones retry
```

async-collect upgrades from "reading a JSON work order" to "resuming a journaled run"; the driver (loopx tick / manual / future notifications) can switch freely, and the recovery semantics do not depend on the driver — this fills the **state-surface** half of tech-strategy's open item "async scheduling has no in-repo implementation" (the scheduler itself remains a separate decision, D3).

On reclaim, the terminal state is also written as a `gotry_async_terminal.v1` event result and emitted as a same-shaped JSON: only 4/4 on the four no-disappointment checks enters `settled`/exit 0; any miss enters `failed`/exit 2; the recital reuses the structured terminal state from the ledger, still with zero recomputation.

### 4.3 WriteGate Substrate (M5 prerequisite)

- L2 (advisory): only INSERT into `pending_writes` (status=pending), no execution.
- L3 (named-seam confirmation): pending → confirmed, carrying a receipt (the acknowledgement from the external world); failure / reversal → compensated (saga compensation, cf. SagaLLM).
- `idem_key` UNIQUE = the physical guarantee that "the same booking confirmation cannot be placed twice" (product red line: three-step confirmation + idempotency key).
- what-if rehearsal = copy the DB (`VACUUM INTO`), fold on the copy, and only after confirmation run the saga on the original — the physicalization of LoopX's "read-only projection before execution".
- ReadGuard stays as is: retrieval state is physically read-only and disjoint from pending_writes.
- **Addendum (2026-08-29, adopted as issue #17 / ADR-17)**: the saga state-advance vocabulary is now explicit as `booking_saga_fsm.v1` (`ts/src/booking-saga.ts` + `docs/booking-saga-fsm.md`; run-all §36 physical reconciliation) — when M5 unseals, the booking seam may only traverse that edge table; the known limitation "an empty receipt has no physical CHECK" = D-22.

### 4.4 Technology Choices

| Item | Decision | Rationale |
|---|---|---|
| Engine | SQLite, better-sqlite3 (primary) / node:sqlite (fallback, decision point D1) | reuse-matrix import channel ✓; the synchronous API has zero friction with the existing readFileSync code style; a single file = backup/fork/isolation all free |
| Mode | WAL + synchronous=NORMAL | the balance point between single-machine crash safety and write latency; Litestream-style backup will also require WAL |
| Platform | no Postgres/DBOS/Temporal/Restate | §1.3; the durable-execution five-piece set is complete inside a single SQLite (evidenced by the §2.7 school) |
| dsh boundary | the harness session layer belongs to dsh's four packages; the product state layer belongs to this ledger | no duplicate journal; dsh follows main, untouched |
## 5. Reconciliation with Existing Decisions (proof of no conflict)

| Existing decision | Relation to this plan |
|---|---|
| Reuse matrix (master outline §2) | better-sqlite3 = open-source import, the legal channel; no internal-asset code introduced |
| memory-design §1.6 "ledgerization = storage-surface replacement, zero semantic-layer rework" | this plan is the execution of that replacement; the six-layer carriers switch from files to ledger + exported views, and the six design stances of §1 are preserved item by item (traceability = evidence into events; the negative list = negative schema fields; red line 6 = export + forget) |
| RFC (loopx) S4 WriteGate L0-L4 | pending_writes is the physical landing spot for L2/L3; "every level rollback-capable" = the saga state machine + DB-copy forking |
| RFC (loopx) §6.5 claim-fence-receipt | the ledger is the single-machine prerequisite for claim/CAS; multi-user implementation stays deferred behind the trigger (TS-5) |
| tech-strategy T6 (idempotency keys / pending state / receipt) | TS-4 directly delivers the substrate for all three elements |
| ADR-14 (utility sidecar) | the memory-utility event stream physicalizes as one events kind, semantic keys unchanged |
| Red line 6 + the 2026-08-26 contamination lesson | a single point of authoritative state (the DB) + no write path outside the tools + the forget command; inspection/testing still uses an isolated stateRoot (shape unchanged) |

## 6. Phased Execution Plan (each slice independently killable)

| Slice | Content | Deliverables and acceptance | Tests | Estimate | Rollback |
|---|---|---|---|---|---|
| **TS-0 establish the case** | founder signs off this RFC; register ADR-15 "Transactional State Backbone" (anchor = TS-1 tests); note on syncing the 6 state surfaces | docs + an ADR entry | — | 0.5d | not needed |
| **TS-1 ledger foundation** | sqlite store module (open/migrate/transaction/events table); evidence/conditions/idem constraints; `--migrate` imports the existing motivation-profile + wish-pool (backfilled as events); projection export command (old filenames) | the ledger stays consistent after an injected crash (kill -9 mid-tx); an INSERT without evidence is rejected; replay with the same idem_key is idempotent | run-all adds §28 | 1-2d | the ledger stays module-internal, unattached to the main path, zero behavior change |
| **TS-2 full migration + projection replay** | memory-utility/trips/companions into the ledger; confirm-outcome in one transaction; `gotry-state log/rebuild/rewind` debug commands | DROP projections → fold → byte-identical to direct reads; replay to any seq is correct; the two-file write can no longer fork | run-all §29 | 1d | the export command restores file-as-authority in reverse |
| **TS-3 durable work orders** | async ticket → workflow_runs/steps; async-collect recovery semantics (done never re-executes); fix `ASYNC_DIR` to attach to stateRoot (`loop.ts:303`); fix `gotry_session_search` auditPath persistence (`index.ts:748-769`) | rerun after kill -9 mid-collect: zero duplicate LLM/solver calls, consistent work-order terminal state; the audit JSONL is visible on the production path | run-all §5 upgraded | 1-2d | keep one version of JSON work-order compatible reads |
| **TS-4 WriteGate substrate** | pending_writes table + idempotency keys + receipt vocabulary (physical preparation for L2/L3); the what-if DB-copy fork command | double confirmation with the same idem_key rejected; a pending→confirmed→compensated state-machine walk-through; copy forks never touch the original | run-all §30 | 1d | the table is kept but unused, unsealed when M5 is signed off |
| **TS-5 trigger-based deferral** | Litestream backup / cr-sqlite multi-device / RFC §6.5 claim-fence-receipt implementation | triggers: a second real user / multi-machine deployment / AaaS kickoff | — | — | — |

**Execution discipline** (per slice): full-stack regression green (`scripts/run-all-tests.sh`); sync the 6 state surfaces in the same commit; stage named files only, `git add -A` forbidden; migrating the founder's real data (`ts/dsh-runtime/gotry-state/`) is a **separate step** — first verify the full chain on an isolated stateRoot, the real migration is executed by the founder personally, and `VACUUM INTO` leaves a snapshot beforehand (the 2026-08-26 lesson became discipline).

**Order dependencies**: TS-1 → TS-2 → TS-3 serial; TS-4 depends only on TS-1 and can move earlier; TS-0 anytime. Total investment is roughly 4-7 working days, and the slices can interleave into the M4 / session-data cadence.

## 7. Explicitly Not Doing

- Postgres / DBOS / Temporal / Restate and any server-side components (§1.3);
- multi-writer replication (cr-sqlite), cloud backup (Litestream) — trigger-based, TS-5;
- touching dsh's four harness-session packages;
- a Python surface, rewriting solver semantics, implementing the full M5 WriteGate early (TS-4 only builds the substrate);
- storing raw conversation text (red line: the negative list stays in force; events payloads carry structured semantics only).

## 8. Risks

| Risk | Mitigation |
|---|---|
| An accident while migrating the founder's real data | isolated verification → the founder runs it personally → a snapshot before migration; the export command keeps the old filenames so a human can eyeball them |
| Confusion during a dual-authority period (files + DB) | no dual-write period: a one-shot migration + one-way exported views (DB→file); files never flow back (decision point D2) |
| SQLite native module install friction (better-sqlite3) | prebuilt binaries cover the mainstream platforms; node:sqlite as the fallback (zero dependencies); release gate item 4, the README live test, would expose any friction |
| Ledger bloat (unbounded event growth) | single-user volume is tiny (the same order as YAML/JSONL); `gotry-state compact` is reserved (a seq high-watermark snapshot) |
| Over-engineering | six slices, each independently killable; if TS-1 fails we cut losses, and the semantic-layer assets are untouched |

## 9. Decision Points (all settled by the 2026-08-28 founder "go with your recommendations")

| # | Question | Decision |
|---|---|---|
| D1 | better-sqlite3 vs node:sqlite | **better-sqlite3** (the open-source import channel; the synchronous API fits in-repo style) |
| D2 | one-shot migration vs a dual-write transition period | **one-shot + one-way exported views**; landing shape = automatic migration on first write (a `pre-ledger-backup/` snapshot before import) + explicit `state-cli migrate` |
| D3 | Scheduler shape | **in-repo `state-cli tick`** (recovery semantics are already decoupled from the driver; can swap to loopx tick anytime) |
| D4 | Is TS-4 fixed as an M5 Entry prerequisite | **Yes** (the pending_writes/receipt substrate is in place; unsealed when M5 is signed off) |
| D5 | `forget` semantics | **physical hard delete + one audit line** (red line 6 "deletable" interpreted from the user's perspective) |
| D6 | Dual-form architecture (local + Web) | **one set of ledger semantics, two host bindings; tenant_id is a first-class field from day one; sync = event replication, not state translation** (ADR-16; the core freeze against "a big refactor later") |

## 9.1 Execution Notes (two deviations from the original §6 plan, both landed with tests)

- Migration trigger: the original plan's "founder executes personally" is refined to "**automatic migration on first write + automatic snapshot**, with explicit `state-cli migrate` available beforehand" — the safety essence (snapshot / single transaction / one-shot) is preserved, and the product path has no window where "the tool is unavailable before migration".
- Test sections: the saga assertions are merged into §28 (ledger-tests, 39 assertions, including crash-recovery exactly-once and pending_writes/what-if); the CLI surface is §29 (state-cli-tests, 14 assertions) — one section fewer than the three sections §28/§29/§30 in the §6 table, with no reduction in coverage.

## 10. References (industry survey sources)

- LoopX: control plane for long-running agents — [dev.to](https://dev.to/arshtechpro/loopx-a-control-plane-for-ai-agents-that-have-to-keep-working-for-days-47n); for the in-repo first-hand survey see `loopx-inspired-upgrades-rfc.md`
- DBOS: [Durable Execution for Crashproof AI Agents](https://www.dbos.dev/blog/durable-execution-crashproof-ai-agents) / [Postgres Is All You Need for Durable Execution](https://www.dbos.dev/blog/postgres-is-all-you-need-for-durable-execution)
- SQLite durable school: [Do your agents need a durable-execution control plane, or a SQLite file?](https://agentnativeengineering.com/field-notes/2026-05-31-sqlite-durable-vs-cloud-queue/) / [SQLite Is All You Need for Durable Workflows](https://dev.to/lymy1205/sqlite-is-all-you-need-for-durable-workflows-3fkn)
- Cockroach Labs: [Why Agent Loops Fail in Production](https://www.cockroachlabs.com/blog/agent-loops-production-database-patterns/)
- Temporal: [Durable Execution Meets AI](https://temporal.io/blog/durable-execution-meets-ai-why-temporal-is-the-perfect-foundation-for-ai); Restate: [Restate vs Temporal](https://restate.dev/vs/temporal)
- LangGraph: [Persistence](https://docs.langchain.com/oss/python/langgraph/persistence) / [Use Time Travel](https://docs.langchain.com/oss/python/langgraph/use-time-travel)
- Letta: [Platform for Stateful LLM Agents](https://blog.stackademic.com/letta-platform-for-stateful-llm-agents-a83b58a1c926)
- Claude Code transcript school: [Manage Sessions](https://code.claude.com/docs/en/sessions) / [Session Browser Cookbook](https://platform.claude.com/cookbook/claude-agent-sdk-05-building-a-session-browser) / [The Design Space of AI Agent Systems (arXiv 2604.14228)](https://arxiv.org/html/2604.14228v1)
- TigerFS: [tigerfs.io](https://tigerfs.io/) / [timescale/tigerfs](https://github.com/timescale/tigerfs)
- Academic: [SagaLLM (arXiv 2503.11951)](https://arxiv.org/html/2503.11951v3) / [Semantic Isolation for Durable AI Workflows (arXiv 2608.05412)](https://arxiv.org/html/2608.05412v1)
- Effectful programming: [Effects as Protocols and Context as Agents](https://interjectedfuture.com/effects-as-protocols-and-context-as-agents/) / [Algebraic Effects for the Rest of Us](https://overreacted.io/algebraic-effects-for-the-rest-of-us/)
- Local-first replication (trigger-based): [cr-sqlite](https://github.com/vlcn-io/cr-sqlite) / [Litestream](https://litestream.io/)
