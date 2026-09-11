[English](README.md) | [简体中文](README.zh-CN.md)

# GoTry Docs Conventions and Master Index

> Role: the **organizational contract and sole index** of this directory — where a new doc goes, how it is named, what header it carries, how its lifecycle flows, plus a one-line index of every document.
> Upstream: `AGENTS.md` (repo contract); state-face discipline: `architecture.md` §11.
> Discipline: one file carries one concern; version history belongs to git; no `vN` filename suffixes.
> Bilingual: every document is a pair — English base `x.md` + Chinese mirror `x.zh-CN.md` — maintained together in the same commit; **divergence within a pair is a bug**.

---

## 1. Directory Taxonomy (by lifecycle stage, not by topic)

| Directory | Role | Entry condition | Exit condition |
|---|---|---|---|
| `docs/` root | **Current authorities + living queue** | Confirmed by founder/contract as the sole authority (e.g. "sole technical authority", "sole timeline") | Moves to the matching subdirectory after ceding authority |
| `design/` | Module-level design docs (proposal/accepted/active) | Has an upstream ADR/issue; describes a module's vocabulary, invariants, and decisions | Absorbed by an authority → move to `milestones/` or delete |
| `rfc/` | Proposal originals (pending or adopted) | Needs a founder decision; filename ends in `-rfc` | Adopted → mark `accepted` and keep; rejected → mark `rejected` and keep |
| `research/` | Investigations and postmortems (frozen) | Time-sensitive surveys, competitive research, postmortems | Never leaves; adopted conclusions are absorbed into authorities, the original freezes |
| `milestones/` | Milestone memos (historical record) | Phase output, walkthrough, reconciliation, or decision memo of a milestone | Never leaves; frozen when the milestone closes |
| `evaluation/` | Evaluation system (contracts, ledgers, comparisons, verification records) | Material about evaluation/benchmark/e2e/persona comparisons | Contract-type docs may stay living long-term |
| `ops/` | Release and compliance operations | Store submissions, privacy policies, other external compliance texts | Long-term living |
| `assets/` | Tool-generated artifacts (architecture diagrams, visualizations) | Output of archify and similar tools | Overwritten on regeneration |
| `superpowers/` | The superpowers workflow's own namespace (plans/specs) | Written automatically by superpowers skills | Tool-managed; no hand-written docs |

**Decision rule**: ask "what lifecycle stage is this doc in", not "what topic is it about". An M5-related investigation still goes to `research/`, not `m5/`.

## 2. Naming Rules

- kebab-case lowercase throughout; no `vN` version suffixes (version history belongs to git).
- **Bilingual pairs (loopx convention)**: English base `x.md` + Chinese mirror `x.zh-CN.md`; machine-generated documents (e.g. `CHANGELOG.md`) and the tool-managed `superpowers/` namespace are exempt. New docs land bilingual from day one; editing one side requires syncing the other in the same commit. Mechanical check: `node scripts/check-docs-i18n.mjs` (existence + heading/code-block/link count parity).
- Authorities: bare topic name (`architecture.md`, `roadmap.md`), no prefixes or suffixes.
- RFC: `<topic>-rfc.md`; design: `<topic>-design.md` or `<role>-guide.md`; research: `<topic>-research.md`; postmortem: `<topic>-postmortem.md`.
- Milestone memo: `<milestone>-<topic>.md` (e.g. `m3-web-gap.md`); one-off plans/specs: `YYYY-MM-DD-<topic>.md`.
- Existing filenames are not retroactively renamed (historical prefixes act as dating); these rules bind new documents.

## 3. Universal Header Block (required on every document)

```markdown
# <Title>

> 定位/Role: one-sentence concern (unique in the repo, non-overlapping)
> 状态/Status: living | proposal | accepted | rejected | frozen(YYYY-MM-DD)
> 上游/Upstream: the authority this document obeys (ADR/master outline/contract)
> 下游/Downstream: consumers of this document (code modules/other docs/people)
```

Fields may be added as needed (e.g. `读者/audience`, `日期/date`, `信源纪律/source discipline`), but `定位` and `状态` are mandatory.

## 4. Body Skeleton per Category

| Type | Body skeleton |
|---|---|
| Authority (root) | Header (with audience/discipline) → **table of contents** → numbered `## N.` sections → revision history lives in git, never inline |
| `design/` | Status + upstream ADR/issue → vocabulary/invariants/rejected closed set → decision log ("why we don't do X" is mandatory) |
| `rfc/` | `§0 summary & decision request` (conclusion first) → problem → options/research → proposal → rollout plan (each phase stoppable) → decision gates & risk register → reconciliation with repo discipline → appendix (sources) |
| `research/` | Header (with source discipline: primary sources first, secondary labeled) → conclusions first → body → full reference list |
| `milestones/` | Milestone number/segment + decision gate → output body; mark `frozen` in the header once frozen |
| `evaluation/` | **Evidence-boundary statement** (what counts and what does not count as evidence) → contract/ledger body |
| `ops/` | Purpose + last-updated date → procedures/submission materials |

## 5. Lifecycle Rules

- **RFC**: `proposal` before the decision; `accepted` after (original text kept untouched; content absorbed into authorities); later evolution only edits the authorities.
- **Research/milestone memos**: `frozen(date)` once finalized; afterwards only the header status may change, never the body (historical fidelity).
- **Authorities**: evolve continuously, `living`; any commit that changes system shape/state/debt syncs the six state faces of `architecture.md` §11 in the same commit.
- **Design docs**: `proposal → accepted → active`; once absorbed by an authority, mark the status and cede.

## 6. Reference Discipline

- Moving/renaming any document requires, **in the same commit**: the root README bilingual index tables, the `architecture.md` §12 doc map, and any code comments or script strings that reference it; both sides of a bilingual pair move together.
- Inter-document links always use relative-path markdown links, never bare filenames (bare names cannot be mechanically verified after moves). Chinese mirrors link to each other's `.zh-CN.md`; English bases link to base names.
- The four base paths pinned by the `AGENTS.md` contract (`architecture.md`, `gotry-master-outline.md`, `tokens.md`, `release-notes.md`) and `docs/release-notes.md` read by the release gate **must not move**; their `.zh-CN.md` mirrors follow the base wherever it goes. If a move is truly needed, update the contract and `scripts/publish-npm.sh` first.

## 7. Readability Discipline (established 2026-09-05 after the repo-wide de-bloating)

Readability is not polish; it is a usability metric of documentation. Rules:

1. **Summary first**: any document over 80 lines needs a "速览/TL;DR" section (3–7 bullets) right after the header block, sufficient to answer "what is this, what does it conclude, what does it have to do with me". Exception: documents with an existing executive summary/Goal section don't duplicate it.
2. **One sentence, one meaning**: a single sentence carries at most one judgment; nested parentheticals are flattened into independent short sentences; one bullet carries one fact — split into sub-items if it doesn't fit.
3. **Intra-doc dedup**: a conclusion/fact appears exactly once per document; repetitions are deleted or turned into pointers ("see §x"). Cross-document dedup follows authority cession — details belong to the dedicated doc (e.g. the per-turn benchmark ledger lives in `evaluation/benchmark-environment-bridge.md`), other places keep a summary plus a link. Exception: duplication among the six state faces (`architecture.md` §11) is deliberate — leave it.
4. **Enumerations sink**: lists/parameter tables/itemized rationale go into tables or an appendix; the body keeps conclusions.
5. **Version history belongs to git**: documents **never** carry revision-history/changelog sections; historical narrative cedes to `release-notes.md` and to frozen headers.
6. **Honest status**: a document's header status matches reality (an approved project doesn't say "pending"); stale status is fixed on sight, never left behind.
7. **Evidence-fidelity red line**: transcripts, verbatim quotes, fixtures/commands/version numbers are never altered; readability work only touches expository prose.

## 8. Master Index

### Root (current authorities, bilingual pairs)

> The table links the English bases; the Chinese mirror is the same name with a `.zh-CN` suffix.

| Document | Concern |
|---|---|
| [architecture.md](architecture.md) | Sole technical authority: system/modules/ADRs/evolution/debt/freshness mechanism |
| [gotry-master-outline.md](gotry-master-outline.md) | Master outline: work breakdown/reuse matrix/decision gates |
| [gotry-product-design.md](gotry-product-design.md) | Product design: main loop/transparency mechanism/full-cost model |
| [roadmap.md](roadmap.md) | Sole timeline: M0–M6 milestones and current position |
| [tech-strategy.md](tech-strategy.md) | Tech selection & half-year iteration route (M2–M4): selection matrix/evaluation/decision register |
| [data-sources.md](data-sources.md) | Sole data-source authority: domain matrix/freshness/evidence-chain contract |
| [user-guide.md](user-guide.md) | End-user guide |
| [tools.md](tools.md) | Tool reference: 23 registered tools grouped, per-tool contracts/channel routing/web onboarding/operator scripts |
| [release-notes.md](release-notes.md) | Per-version release decisions (the "why", human-written decision face) |
| [tokens.md](tokens.md) | Sole token authority: npm 2FA/publish mechanics/channel acquisition table |
| [decisions-needed.md](decisions-needed.md) | Decision queue awaiting the founder |
| [g5-authorization-ledger.md](g5-authorization-ledger.md) | G5 internal-travel-bridge authorization ledger (GRANT entries maintained founder-side only; read mechanically by `ts/scripts/g5-guard.ts`, issue #348) |
| [debt-archive.md](debt-archive.md) | Paid-off debt archive (append-only evidence; open debts live in architecture.md §10.1) |

### design/ (module design)

> The table links the English bases; the Chinese mirror is the same name with a `.zh-CN` suffix.

| Document | Concern |
|---|---|
| [design/memory-design.md](design/memory-design.md) | Memory domain design: six-layer C-end redesign (M4 deliverable) |
| [design/memory-lifecycle-collector.md](design/memory-lifecycle-collector.md) | M4 lifecycle collector usage contract: explicit opt-in, isolated stateRoot, HMAC/consent, atomic persistence and #223/#238 scorer export; produces candidate/synthetic only, never replaces the real cohort |
| [design/milestone-delivery-plan.md](design/milestone-delivery-plan.md) | M4→M6 living task graph (issue #225): #20/#22/#136/#137 real gates, #231–#235 successors and the #270 public delivery ledger; pre-admission contains only authorized design/read-only/fixture/failing-before work |
| [design/write-gate-production-design.md](design/write-gate-production-design.md) | M5 WriteGate production proposal (issue #225/#136): HotelByte versions/artifacts, trusted receipt issuance/consumption authority, approval_claims persistence, query-miss stays unknown, reconciliation/compensation/disclosure |
| [design/fact-writegate-seam.md](design/fact-writegate-seam.md) | fact-anchor × M5 WriteGate seam (issue #303, #273 sub-slice): read-path gate vs write-path gate contracts, five-step minimal chain, non-success write receipts fail closed, depends on #136/#231, no unsealing before M5 Entry |
| [design/effect-interpreter.md](design/effect-interpreter.md) | Effect interpreter design (accepted, ADR-18): vocabulary/resilience strategy table/decision log |
| [design/booking-saga-fsm.md](design/booking-saga-fsm.md) | Booking saga state machine (accepted, ADR-17): alphabet/edge table/M5 seam vocabulary |
| [design/tool-orchestration-design.md](design/tool-orchestration-design.md) | Tool orchestration & channel health face design (proposal, issue #106/#107/#108) |
| [design/adapter-authoring-guide.md](design/adapter-authoring-guide.md) | Session adapter author handbook (D-13, #272): four-step method/drift locks/red lines |
| [design/external-event-seam.md](design/external-event-seam.md) | External event-driven seam design (#82 direction/D-31, design only, no implementation promise) |
| [design/hotelbyte-skills-design.md](design/hotelbyte-skills-design.md) | hotelbyte-skills architecture (knowledge enters the repo / execution stays in gotry, issue #5) |
| [design/stage1-top-down-design.md](design/stage1-top-down-design.md) | Stage 1 top-level design (historical original); **its status header is state face ⑥ of §11** |

### rfc/ (proposal originals)

| Document | Concern |
|---|---|
| [rfc/transactional-state-rfc.md](rfc/transactional-state-rfc.md) | Transactional state foundation RFC (accepted 2026-08-28, ADR-15) |
| [rfc/user-session-data-rfc.md](rfc/user-session-data-rfc.md) | User session data plane RFC (approved 2026-08-28): official channel first + session backfill |
| [rfc/loopx-inspired-upgrades-rfc.md](rfc/loopx-inspired-upgrades-rfc.md) | LoopX-inspired upgrade RFC (accepted 2026-08-27): minimal slices across four seams |

### research/ (investigations & postmortems, frozen)

| Document | Concern |
|---|---|
| [research/maka-research.md](research/maka-research.md) | Apache Maka research → point-by-point mapping onto the ADR-15 five-piece set (draft for decision) |
| [research/deerflow-research.md](research/deerflow-research.md) | DeerFlow research → optimization goals T1–T4 (issue #10) |
| [research/enterprise-travel-reference-study.md](research/enterprise-travel-reference-study.md) | Enterprise travel agent eight-dimension reference study (2026-09-03, sources anonymized) |
| [research/dsh-plugins-shortlist.md](research/dsh-plugins-shortlist.md) | dsh community plugin selection survey (issue #9) |
| [research/kimi-postmortem.md](research/kimi-postmortem.md) | Kimi itinerary conversation postmortem: counter-example textbook and ground-truth extraction |

### milestones/ (milestone memos, frozen)

| Document | Concern |
|---|---|
| [milestones/demo-plan-2026-07-17.md](milestones/demo-plan-2026-07-17.md) | First usable demo delivery (Phuket workation) |
| [milestones/demo-reconciliation.md](milestones/demo-reconciliation.md) | Demo reconciliation document (P0-5) |
| [milestones/g1-market-memo.md](milestones/g1-market-memo.md) | G1 launch-market lockdown decision memo |
| [milestones/m2-capability-gap.md](milestones/m2-capability-gap.md) | M2 segment 1: hotelbyte-cli command gap inventory |
| [milestones/m2-flight-data-options.md](milestones/m2-flight-data-options.md) | M2 segment 2: free flight data source selection (§7-1 decision-gate material) |
| [milestones/m3-web-gap.md](milestones/m3-web-gap.md) | M3 segment 1: minimal web face hands-on and gap list |
| [milestones/m4-calibration-questions.md](milestones/m4-calibration-questions.md) | M4 calibration question list |
| [milestones/m6-b2b-reuse-walkthrough.md](milestones/m6-b2b-reuse-walkthrough.md) | M6 P6 B2B reuse walkthrough minutes (draft, pending founder review) |
| [milestones/s1-walkthrough.md](milestones/s1-walkthrough.md) | S1 contract walkthrough conclusions |

### evaluation/ (evaluation system)

| Document | Concern |
|---|---|
| [evaluation/evaluation-foundation.md](evaluation/evaluation-foundation.md) | Evaluation Phase 0: contracts/registries/admission & boundary statements |
| [evaluation/benchmark-environment-bridge.md](evaluation/benchmark-environment-bridge.md) | External benchmark bridge: Phase 1 seam and per-turn engineering ledger |
| [evaluation/e2e-prompts.md](evaluation/e2e-prompts.md) | dsh e2e end-to-end real-LLM verification records (continuously updated) |
| [evaluation/persona-bench/](evaluation/persona-bench/) | Product-persona comparison: archived answers to the same real prompt/scorecards/persona distillation |

### ops/ (release & compliance)

| Document | Concern |
|---|---|
| [ops/extension-privacy.md](ops/extension-privacy.md) | Session Bridge extension privacy policy |
| [ops/extension-webstore-submission.md](ops/extension-webstore-submission.md) | Chrome Web Store submission materials and the current dsh UI install handoff (ADR-21 channel B) |
| [ops/external-pr-workflow.md](ops/external-pr-workflow.md) | Public issue→PR→review→merge ledger; plus triage/verification/adjudication rules for external PRs (including automation bots) |
| [ops/security.md](ops/security.md) | Security policy and vulnerability disclosure: reporting channel, triage discipline, append-only security event log |
| [ops/ledger-tenant-repair.md](ops/ledger-tenant-repair.md) | #254 ledger tenant repair owner-gate checklist (dry-run → authorize → apply → private receipt) |

### assets/ and superpowers/

- `assets/`: archify-generated system architecture diagrams (`gotry-system-architecture.*`), regenerated by the external archify tool; no in-repo consumers.
- `superpowers/`: superpowers workflow plans/specs (evaluation plan Phase 0 etc.), tool-managed.
