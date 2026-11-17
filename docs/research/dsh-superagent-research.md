[English](dsh-superagent-research.md) | [简体中文](dsh-superagent-research.zh-CN.md)

# dsh-superagent Route Research → gotry Adoption Boundary and Landing Path (issue #696)

> Status: frozen (research base, 2026-11-17; adoption progress lives in [issue #696](https://github.com/Danceiny/gotry/issues/696))
> Subject: [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) (MIT; officially a research prototype; single commit; ~23.6k stars)
> Context: founder decision 2026-11-17 — "dsh's super agent technical route is very suitable; follow up".
> Source discipline: primary = the repository itself (README, SETUP, docs/000–008; this document takes docs/007-architecture and docs/003-execution in full as its basis); secondary sources (news coverage and the accompanying paper) are labeled and not relied upon.

## Conclusions (read this first)

1. **What the route is**: a router-plus-worker orchestrator running inside the dsh host. Sources (GitHub/Feishu) produce Triggers → Intake stores and deduplicates → Eval has the main session assess candidates → Decision (accept/stop/ignore/unavailable) → an accept creates a Ticket (carrying a Mandate admission basis) → an Assignment gives each Ticket one isolated dsh session and directory → the worker reports back (waiting/ready/blocked/failed/dropped) → the Outbox replies in order to the original conversation. Persistence is a single SQLite file, one writer per state kind, an effect queue enqueued inside transactions and executed afterCommit, and outbox receipts.
2. **gotry adopts on two surfaces**: surface one (lands first) = the gotry repository's own development process — the AGENTS.md async work-order sweep plus the LoopX tick discipline is already a hand-rolled Trigger→Ticket→Assignment loop; surface two (reference) = AaaS (#674) — single-writer/durable effects/outbox/policy gate are isomorphic to the A1 state layer and A2 identity/quota work; absorb the design, do not vendor the code.
3. **Hard prerequisite**: superagent requires `engines: dsh ^0.2.1-alpha.2` (all family peers ^0.2.1-alpha.2, cordis 4.0.5-alpha.1, schemastery 3.18.5-alpha.1); gotry main pins `@deepseek-ai/dsh 0.2.0-rc.2`. **No deploy without the upgrade** (#696 P1 gate). Founder addendum 2026-11-17: gotry is an experimental project and **dsh always tracks the latest** — P1 goes straight to the latest line (0.2.2-rc.3) without slowing down for superagent's 0.2.1-line peers; that peer gap is resolved at P2 by superagent's own upgrade or a relaxed engine check.
4. **Maturity boundary**: officially a research prototype, not production, and it differs from the internal/paper version; no record pruning (trigger/disposition/decision/outbox grow without bound); the directory wrappers "establish defaults, not a security boundary", and workers run commands unapproved as the operator's OS user. Adoption = pilot first, then adapt; direct productization is refused.

## 1. What the route is

**Five-stage pipeline** (five single-direction Engine parts): Intake (Trigger storage, dedup, fan-out) → Evals (candidate assessment, deadline requeue, third expiry recorded unavailable) → Tickets (lifecycle, Mandate, thread subscriptions) → Assignments (execution facts and worker reports) → Replies (ack/answer/result/attention outbound messages).

**Two roles**: the main session (`dsh-superagent-router` preset, 14 orchestrator_* tools, 5-second shell/wait caps — the router does no work itself) plus one Executor session per Ticket (`dsh-superagent-worker` preset, 6 tools, foreground commands move to background jobs after 5 seconds, a 30-minute background limit, worker-slot concurrency plus one extra slot for a human wake).

**Authorization model**: the Policy gate sets admission strength by Trigger origin; a Mandate records the admission basis (addressed/followup/admission/bot); policies are versioned and revalidated against live Tickets on change; "acts only when asked or when a team-written rule allows it". A proactive candidate defaults to a "would accept" record; auto mode plus an explicit rule is required to accept automatically.

**Recovery model**: store first, do afterwards (effects enqueue inside the transaction and run after commit); after a restart, interrupted Assignments resume with a recovery note (oldest Ticket first); a message counts as read once it entered session history and a Report or turn end followed; the outbox delivers per Ticket per conversation in order and escalates after three consecutive failures to a system problem.

## 2. Why it fits gotry

- **Same root**: both are dsh/cordis plugin bundles (its cordis.patch.yml three-plugin shape matches gotry's packaging), so there is no cross-host bridging cost; gotry's dsh dependency tree already carries the subagent/jobs/schedule/webhook infrastructure.
- **Same problem**: what the gotry repository today holds up by discipline — "audit every open issue each tick", the one-hour async work-order loop, per-lane isolated worktrees — is exactly what this route mechanizes as Intake→Eval→Ticket→Assignment; founder disciplines like "test runs need a formal summary" and "check the branch before committing" can sink into the worker preset and prompts.
- **Isomorphic** (surface two): AaaS A1's claim/CAS/fencing corresponds to its single writer plus directory lock plus transactional effects; A2's auth/quota corresponds to the Policy gate, Mandate revalidation, and worker slots. See the §4 mapping table.

## 3. Surface one: this repository's pilot (P2–P3)

- **Deployment shape**: a dedicated machine profile with an isolated `stateRoot` (State Discipline red line: never touch the founder's real data under `ts/gotry-state/`); it watches this repository's issues/PRs; the agent account is authorized by the founder (the repository has no writable bot account today).
- **P2 read-only gate**: assess only (the Eval surface shows candidate cards), never execute (no Assignments opened); verifies that the admission table, policy versioning, and the panel's attention flow genuinely work; exit evidence = founder-reviewed run records.
- **P3 execution gate**: execute a real work item under a whitelist Mandate (prepare uses `git worktree` for an isolated checkout — isomorphic to the worktree isolation mandate); evaluate adopt-or-drop against the existing LoopX flow.
- **Explicitly not enabled**: auto-merge (its default allows auto-merging sub-200-line PRs — gotry release discipline requires founder confirmation; incompatible) and auto-mode proactive acceptance (keep "acts only when asked").

## 4. Surface two: AaaS (#674) reference mapping

| superagent mechanism | AaaS counterpart | How absorbed |
|---|---|---|
| Single-writer SQLite plus a directory lock | A1 keyed per-tenant single writer | Design reference (an RFC comparison entry) |
| Transactional, afterCommit-executed effect queue | A1 durable task/recovery semantics | Design reference |
| Outbox receipts (ordered, backoff, three-failure escalation, dropped records kept) | A1/A3 message reliability | Design reference |
| Policy gate + Mandate basis + versioned revalidation | A2 principal/auth/quota | Concept alignment |
| Worker slots plus a human-wake extra slot | A3 concurrency/scaling | Design reference |

Under the reuse matrix: MIT open source may be imported; but "research prototype, adapt before use" — AaaS absorbs the patterns only and does not take this package as a runtime dependency.

## 5. Risks and prerequisites

| Item | Fact | Countermeasure |
|---|---|---|
| dsh version gate | superagent needs ≥0.2.1-alpha.2, main pins 0.2.0-rc.2; founder ruled always-latest | #696 P1: whole-family upgrade straight to latest (0.2.0-rc.2 → 0.2.2-rc.3) + full regression (the 0.1.5→0.2.0 contract checklist from PR #610 is reusable) |
| Security boundary | wrappers/directories are defaults, not a security boundary; workers execute unapproved as the operator's OS user | Minimize the pilot machine, use a dedicated OS user, read-only credentials first |
| Unbounded growth | No record pruning | Rebuild the pilot stateRoot periodically; add retention before adoption |
| Divergence from paper/internal | Officially, published code ≠ internal version | Only the repository itself is a primary source |
| Single commit, no history | Upstream fix cadence cannot be tracked | Pin the commit SHA; upgrading means re-evaluation |

## 6. Explicitly not adopted

- **Not into the product runtime**: gotry's product is a travel agent, not an orchestrator; superagent has zero relationship with the booking/payment path.
- **No Feishu source**: gotry development lives on GitHub; the Feishu source stays out of the first version.
- **The management panel is not product UI**: the panel is pilot operations only.

## 7. Landing order

P0 this document (#696) → P1 the dsh upgrade gate (its own PR) → P2 read-only pilot → P3 execution pilot and the adopt-or-drop decision. Each stage's exit gate is the stage table in #696.

---

Sources (primary): [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) · `docs/007-architecture.md` · `docs/003-execution.md` · `SETUP.md` · `package.json` (engines/peers)
Secondary (background only, not relied on for mechanics): Help Net Security 2026-11-02 coverage · the accompanying paper *Exploring Super-agent Design: Towards a More Autonomous Agent System* (full text not read)
