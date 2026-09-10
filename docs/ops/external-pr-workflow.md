[English](external-pr-workflow.md) | [简体中文](external-pr-workflow.zh-CN.md)

# External PR Workflow (Maintainer Side)

> Position: operating procedure for receiving, verifying, reviewing, adjudicating, and archiving PRs from external contributors (including automation bots) — the contributor-side rules are in [CONTRIBUTING.md](../../CONTRIBUTING.md) and are not repeated here.
> Status: living
> Upstream: [AGENTS.md](../../AGENTS.md) (repository contract), CONTRIBUTING.md (Pull Request process)
> Downstream: the operating surface for maintainers and execution agents handling external PRs; GitHub CI (`.github/workflows/ci.yml`)
> Last updated: 2026-09-10
> Boundary: in-repo Claude Code/worktree lanes authorized by founder are internal execution lanes; they do not enter the external-bot T0/T1 veto. They must still publish a delivery record per §0 and pass the normal review gates.

## At a glance

- External PRs are triaged by provenance first (human / bot / suspected spam) before entering review; bot PRs are distrusted by default and are not treated as ordinary contributions.
- The supply-chain precheck is a hard gate: any diff touching `.github/`, dependency manifests, or the build/release chain is an outright veto and does not enter code review.
- Claim verification precedes code review: a vulnerability claimed by a bot PR must be falsified or confirmed against source; scanner conclusions are not taken as true.
- The final-SHA local evidence that external contributors cannot produce is run on their behalf by the maintainer; green CI is only a supplementary signal.
- Three adjudication outcomes: merge / request changes / close; every outcome leaves an evidence-backed comment in the PR, and a close must also state its reason. The merge method follows the merge methods the repository actually allows; squash or linear history is not mandated.
- The first case was #250 (automated security scanner): verified as a false positive (dynamic values were already `?`-parameter-bound); founder ruled to merge it as defensive hardening (2026-09-09); the §3 technical analysis is the distillation of that case.

---

## 0. Public delivery ledger (shared by all execution lanes)

- **Issue kickoff**: record acceptance criteria, dependencies, base SHA, branch/worktree, named-file scope, execution routing, and the final gate.
- **Draft PR**: link the issue; record exact head, changed files, conflicts/drift against current `origin/main`, local commands and exit codes, and E2E boundaries; keep the numbered TODO at the top while gates are unmet.
- **Review**: bind every conclusion to the reviewed head; fixes point back to the corresponding finding; a new head re-runs applicable gates.
- **Merge**: record the reviewed head, the actual merge method, the merge SHA, destination-SHA verification, and the next open tracker.
- **Security boundary**: publish dependency/version/test/PR facts; raw private alert text, exploit details, credentials, and host information stay only in GitHub Security.

---

## 1. Intake and triage (T0)

After a PR appears in this repository (including cross-repo fork PRs), classify its source type first; the type determines the strictness that follows.

| Type | Criteria | Default stance |
|---|---|---|
| Human external contribution | Author is a real person, description follows the template, diff matches the description | Normal review; all CONTRIBUTING.md gates apply |
| Automation bot | Dependabot / security scanners (semgrep family) / AI-agent generation marks (templated body, rule-ID tables, fixed sign-off links) | Distrust by default: verify claims first, discuss code after |
| Suspected spam | Meaningless changes (whitespace/rename flooding), body inconsistent with the diff, smuggled external links | Close directly; report where warranted |

A bot PR's body is itself treated as a claim: scanner conclusions and threat-model narratives are unverified in this repository; AI-agent-generated descriptions are especially likely to mismatch the diff.

## 2. Supply-chain security precheck (T1, hard gate)

Before reading code logic, run the diff checklist; any single hit below is an outright veto (close and list the hits in a comment):

- Changes to `.github/` (workflows, templates), `scripts/publish-*`, or the build/release chain (`build-dist` etc.);
- Changes to dependency manifests or lockfiles (`package.json` / `package-lock.json` / `pnpm-*`) that are not routine Dependabot upgrades;
- Introduction of new network egress, subprocess execution, or `eval`-style dynamic execution;
- Smuggled-in files unrelated to the claim, or invisible content such as zero-width characters/homoglyphs.

After the precheck passes, the diff should contain only files within the claimed scope; any out-of-scope file sends it back to T0 for reclassification as suspected spam.

## 3. Claim verification (T2, bot PRs only)

Security claims are falsified or confirmed one by one against source code. Confirmed false-positive patterns in this repository (cite this section directly when the same pattern appears):

| False-positive pattern | Why it is safe | Default call (adjudication may override) |
|---|---|---|
| Template-string interpolation into SQL, but interpolating compile-time constants (e.g. the static where branch in `readEvents`) | The interpolated content carries no user input; all dynamic values are bound via `?` placeholders (better-sqlite3 `prepare().all()/run()`) | Duplicating the expansion into branch-repeated SQL — no security gain, degraded maintainability |
| `IN (${placeholders})` where placeholders is a `?` string generated from array length | This is the standard form of parameter binding — exactly the right injection defense | Rewriting as `+` concatenation — zero security value, and concatenation is exactly the shape injection rules should watch for |
| "Remove exploit primitive" style boilerplate hedging | Conservative wording when the scanner lacks data-flow evidence; not a risk in this repository | Refactoring correct code just to silence a scanner alert |

Technical verdict and adjudication are independent: "why it is safe" is the verification conclusion and does not change with a merge or a close. Whether to merge alert-silencing hardening is maintainer discretion — to reduce scanner noise or to encourage external contribution, the default call may be overridden and merged (first case #250 was merged by founder); the default stance is not to refactor correct code to silence alerts.

Compatibility/upgrade claims (Dependabot): read the upstream changelog and breaking-change notes; check semver and `engines` constraints.

The verification conclusion goes into the PR comment whether it confirms or rejects: a false positive must state its evidence — which lines, where the values come from, where the binding happens.

## 4. Review and testing (T3)

- External contributors often cannot provide the final-SHA local evidence CONTRIBUTING requires — the maintainer runs it on their behalf and pastes it into the PR: `cd ts && npx tsc --noEmit` + `GOTRY_SESSION_LIVE=0 ./scripts/run-all-tests.sh`.
- Changes touching the model/unified layers or the ledger run the corresponding full-stack regression per the AGENTS.md layering discipline; pure-doc changes substitute N/A + burden-of-proof per the PR template.
- Layering discipline, red lines (WriteGate / evidence / conditions), and deprecated-layer bans go item by item through the CONTRIBUTING.md checklist.
- CI for fork PRs runs automatically via the `pull_request:` trigger (Node 22/24); CI is a supplementary signal, not a replacement for local evidence.

## 5. Adjudication and etiquette (T4)

| Adjudication | Conditions | Action |
|---|---|---|
| Merge | A real fix, or defensive hardening where verification found no real vulnerability but the maintainer ruled to accept it; behavior preserved, tests green, precheck clean | Merge into main with a repository-allowed merge method (the repository does not mandate squash or linear history); delete the branch where possible; the PR record must carry the final commit/SHA |
| Request changes | Right direction but incomplete implementation or evidence | List the specific gaps; bot PRs are not iterated on and are generally handled as closes |
| Close | False positive / out of scope / degrades code / suspected spam | Evidence-backed closing comment: why it is a false positive, this repo's corresponding invariant, and a welcome for human follow-up |

**Actual merge-method policy**: the repository allows the merge methods GitHub provides (merge commit / squash / rebase) and does not presuppose squash or linear history. For first case #250 the maintainer chose **merge commit + exact-head guard** — first confirm the merged PR head is exactly the verified commit, then record the final main commit/SHA back into the PR, preventing head drift or provenance ambiguity; delete the branch after merging where possible; the PR record (comment or merge information) must carry the final commit/SHA for later cross-checking and traceability.

Closing etiquette in four parts: thank the motive → give the evidence → give the invariant → leave an invite (human fix-style contributions are always welcome). Templated bots usually never reply; the primary readers of the comment are future maintainers and genuine human contributors who hit the same kind of PR.

When the same bot repeats the same false-positive report against the same target: close directly and cite the PR number of the earlier disposition in the comment; do not re-argue at length.

## 6. Archival (T5)

- Version narratives arising from merges belong to CHANGELOG (derived automatically from the commit log) and `release-notes.md` (human-written why); this document does not maintain them case by case.
- Dispositions are archived in each PR's comments; only when a new false-positive pattern or a new precheck rule appears should the corresponding §2/§3 entries here be updated.
