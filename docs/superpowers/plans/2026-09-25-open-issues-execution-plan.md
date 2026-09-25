[English](2026-09-25-open-issues-execution-plan.md) | [简体中文](2026-09-25-open-issues-execution-plan.zh-CN.md)

# Open Issues Execution Plan

> Role: a dated execution proposal for the 30 open issues, including remaining work, ordering, and acceptance; not a new milestone authority.
> Status: first engineering wave implemented; local full regression passed; awaiting merge and remaining live acceptance. Inspected 2026-09-25.
> Upstream: [repository contract](../../../AGENTS.md), [master outline](../../gotry-master-outline.md), [architecture](../../architecture.md), [roadmap](../../roadmap.md), and each linked issue's scope.
> Downstream: issue triage, independently reviewable PRs, and evidence collection.
> For agentic workers: implement admitted tasks using `superpowers:subagent-driven-development` or `superpowers:executing-plans`; preserve the gates below.

**Goal:** turn the open queue into a usable travel-planning delivery sequence, prioritizing core planning and integration usability, then real M3 evidence.

**Architecture:** retain the existing planner, fact registry, deck/export, session bridge, and evidence collectors. Finish bounded product gaps, collect real outcomes, and activate additional capabilities only when their recorded triggers occur.

**Tech Stack:** TypeScript, dsh plugins, Chrome extension, GitHub Actions, existing cohort scripts; no additional product runtime or Python dependency.

**Spec:** [#559](https://github.com/Danceiny/gotry/issues/559) records the founder's product-first priority; [M4–M6 delivery graph](../../design/milestone-delivery-plan.md) owns downstream admission.

## 1. Initial inspection baseline and priority decision

- Local and remote `main`: `fb1cbf2ea2b5dc5619c0cf454ab70edb17da9e02`; 30 open issues, zero open PRs.
- No async order lacked its deliverable. Existing untracked `dist-extension/` is outside this planning change.
- Eight recent feature issues already have merged implementations. Four satisfy their original slices after reconciliation; #577 still lacks wish-condition enforcement; #569 lacks QR decode evidence, while #573/#580 have reproducible token-validation gaps.
- #559 A/B and the skeleton-warning fix landed in #560/#562/#563. The Agent-Reach error-copy gap remains; do not reimplement onboarding or suppress EK329 based on a stale skeleton.
- Seven targeted offline suites ran at this SHA: deck 226, artifact 131, export 147, demo 21, share 73, recall 67, session-link 83; **748 passed, zero failed**. This inspection did not rerun full regression or live acceptance.
- Additional pure-function probes reproduced three failures outside those assertions: production session-link verification throws when the secret is absent; an injected invalid clock accepts an expired session-link token and an expired share token. These are contract defects, not evidence of activated external services.
- Latest main CI [36054797657](https://github.com/Danceiny/gotry/actions/runs/36054797657) is cancelled, not green. Extension workflow [36054797665](https://github.com/Danceiny/gotry/actions/runs/36054797665) packed successfully but skipped publishing.
- [GitHub extension release](https://github.com/Danceiny/gotry/releases/tag/ext-v0.2.0.25) and source manifest are `0.2.0.25`. The [public store listing](https://chromewebstore.google.com/detail/gotry-session-bridge/oeajpiccmonococjcegddlooeeohlbgd) still shows `0.1.0`; manual submission/review status is unverified. Release prose is not a submission receipt.

**Recommended order:** reconcile landed work → finish #559 and token/QR acceptance → repair and verify distribution → use the product with real participants → let observed gaps select further core work. Prepare cohort collection in parallel from the first wave. Keep #511 event-driven; more diagnostics without a recurrence do not advance this objective.

## 2. Global constraints and review focus

- Arithmetic stays in evaluate; solving stays in unified; no new calls to deprecated engine/journey compatibility layers. Kernel changes require the existing manifest decision and full-stack regression.
- No test writes to `ts/dsh-runtime/gotry-state/`. Use explicit temporary `stateRoot`; private admitted evidence belongs in the ignored evidence directory.
- Internal assets remain bridge/reference only. No new TS↔Python feasibility bridge or Python dependency surface.
- Share adapters, recall runtime, and session-link consumers are not activated by their contract tests. M5 writes remain sealed.
- Release version and release action require founder confirmation under AGENTS.md. First inspect existing authorization and receipts; do not repeat an already authorized submission or ask for the same approval twice.
- Update only concern-owned authorities whose facts change, in both languages; do not append implementation history to frozen research. Stage only owned files.

| Review focus | Owning task and expected result |
|---|---|
| SVG looks plausible but scans incorrectly; no-host bundle implies a working link | T2: independent decode must recover the exact payload; local-only intent is explicit |
| Process stderr or upstream credential fragments reach user copy | T1: bounded human-readable failure with source attribution and preserved structured recovery semantics |
| Green pack job or HTTP 200 is described as store publication | T3: artifact path, response state, review receipt, store pull-back, and installed version remain distinct |
| Synthetic demo, retries, or a repeated person inflates cohort success | T4/T6: frozen eligibility, denominator, provenance, private consent, and separate engineering evidence |
| A token accepts an invalid clock, or a read/link path crosses its authority | T1b/T5/T7: invalid tokens fail closed; challenge stop, Checkout ownership, and milestone gates remain explicit |

## 3. Disposition of all 30 open issues

| Issue | Remaining work / disposition | Execution route |
|---|---|---|
| [#564](https://github.com/Danceiny/gotry/issues/564) | Renderer merged via #565 | T0 closure candidate |
| [#566](https://github.com/Danceiny/gotry/issues/566) | Product render entry merged via #567 | T0 closure candidate |
| [#568](https://github.com/Danceiny/gotry/issues/568) | Export merged via #570; reconcile accepted basename-prefixed filenames with original checklist | T0 closure candidate |
| [#569](https://github.com/Danceiny/gotry/issues/569) | QR implementation #575/#576 merged; this wave adds independent decode and `local_only`; physical scan remains | T2, keep open |
| [#571](https://github.com/Danceiny/gotry/issues/571) | Offline script merged via #572; not a deployed zero-install landing site | T0 closure candidate |
| [#573](https://github.com/Danceiny/gotry/issues/573) | Consent/token/stubs merged via #574; this wave fixes invalid-clock validation, awaiting merge | T1b, keep open; no outbound activation |
| [#577](https://github.com/Danceiny/gotry/issues/577) | Recall signal pairing merged via #578; wish `conditions` are not evaluated | T0 follow-up below; keep open |
| [#580](https://github.com/Danceiny/gotry/issues/580) | Link contract merged via #581; this wave fixes missing-secret and invalid-clock validation, awaiting merge | T1b, keep open; no route/scheme activation |
| [#559](https://github.com/Danceiny/gotry/issues/559) | Agent-Reach error and recovery guidance fixed in this wave; awaiting merge | T1, then T4 product walkthrough |
| [#346](https://github.com/Danceiny/gotry/issues/346) | Shared store-release gate and receipt authority | T3; retain until actual acceptance |
| [#537](https://github.com/Danceiny/gotry/issues/537) | Version in title is stale; current join-chain acceptance belongs to the same release as #346 | T3; one release, separate acceptance checklist |
| [#272](https://github.com/Danceiny/gotry/issues/272) | Real connected/degraded adapter evidence and packaged entry | T5; manifest #501 already merged |
| [#22](https://github.com/Danceiny/gotry/issues/22) | Real 50–200-user M3 outcome set | T6; highest product-evidence priority |
| [#20](https://github.com/Danceiny/gotry/issues/20) | Real paired repeat cohort and reflux baseline | T6 in parallel; does not waive M3 Exit |
| [#142](https://github.com/Danceiny/gotry/issues/142) | Four-surface real inventory, recovery, Checkout and QueryOrders evidence | T7 independent UAT lane |
| [#511](https://github.com/Danceiny/gotry/issues/511) | Original intermittent SDK handshake cause still unknown; diagnostics already landed | Resume only on recurrence or a newly blocked delivery |
| [#429](https://github.com/Danceiny/gotry/issues/429) | Admit one named traffic/transit/fare/address use case at a time | First expansion candidate after T4 evidence; public reads do not require M5 |
| [#422](https://github.com/Danceiny/gotry/issues/422) | Unmanaged direct-SDK descendant ownership trigger | Audit concrete callsite before scheduling; current Copilot uses ManagedDshRunPort ownership |
| [#275](https://github.com/Danceiny/gotry/issues/275) | Second real user, multi-machine, or AaaS triggers topology/fencing review | Review before cohort scale-out, not an indefinitely dormant ticket |
| [#344](https://github.com/Danceiny/gotry/issues/344) | First real non-CNY quote, budget, or destination requirement triggers Money/FX contract | Check during T4/T6 intake; no evidence yet that trigger is absent |
| [#255](https://github.com/Danceiny/gotry/issues/255) | P4 requires real usage/multi-user trigger plus explicit implementation approval | Defer activation; record actual trigger |
| [#339](https://github.com/Danceiny/gotry/issues/339) | City-scenario tiering needs reviewed real samples | Defer until sample and ranking hypothesis exist |
| [#276](https://github.com/Danceiny/gotry/issues/276) | Internal SearchSrv needs measured external-path bottleneck or an internal caller | Defer until trigger and cross-repo ownership |
| [#345](https://github.com/Danceiny/gotry/issues/345) | Dedicated Place/reviews requires Anything quality gap and paid quota approval | Defer until evidence and three-repo owners |
| [#342](https://github.com/Danceiny/gotry/issues/342) | Offline atlas requires scheduled offline/map/normalization need and redistributable data | Defer until product trigger |
| [#82](https://github.com/Danceiny/gotry/issues/82) | Inert contract #432 is complete; real callback/sensor/auth/consumer activation remains | Admit a named callback/sensor, trust model and consumer; share/recall consumers retain their own separate activation gates |
| [#340](https://github.com/Danceiny/gotry/issues/340) | Actual transaction-outcome feedback needs admitted supply/WriteGate and real final outcomes | After M5 admission and real outcome evidence |
| [#136](https://github.com/Danceiny/gotry/issues/136) | M5 Entry = M4 Exit + supply authorization; mechanisms already exist | Prepare missing protocol evidence only; no transaction activation |
| [#137](https://github.com/Danceiny/gotry/issues/137) | M6 Entry = M5 Exit + explicit P6 approval; then real pilot | Keep gated; reuse fixtures are not pilot evidence |
| [#18](https://github.com/Danceiny/gotry/issues/18) | Program coordination and remaining evidence gates | T0 reconciliation; not a separate feature task |

## 4. Waves, ownership, and stop conditions

| Wave | Deliverables | Parallelism / exit |
|---|---|---|
| 1 — next bounded execution batch | T0 reconciliation; T1 error copy; T1b token validation; T2 QR acceptance; T3 release preparation; T6 sampling preparation | One owner per PR; reviewer independent. T1/T1b/T2/T3 can run separately; serialize shared runner/index edits. Done when reviewable changes and evidence exist |
| 2 — actual product use | T4 three-scenario walkthrough; T5 authorized session evidence; T6 seed use/revisit; T7 if UAT ready | Start admitted lanes without waiting on all others. Close measured defects; preserve missing-input status |
| 3 — evidence-selected expansion | At most one next core/data gap from T4/T6, with #429 address clarification as a candidate | No preselected broad feature program; each new slice needs a real example and acceptance before implementation |

Current execution: Claude Code used the user-confirmed existing configuration in isolated worktrees. T1/T1b implementation, automated T2 acceptance and offline T3 preparation are delivered for integration review. T0 found four closure candidates and one remaining #577 scope gap; no issue state has changed. T6 has a preparation handoff, with real enrollment and collection still pending.

Effort is bounded by deliverables, not a promise about store review or cohort arrival. Waiting for login, review, users, or suppliers consumes no repeated diagnostic work. External outreach is not authorized by this plan; prepare materials and use explicitly admitted sessions.

## 5. Executable tasks

### T0 — Reconcile delivery before selecting new work

**Files/surfaces:** linked issues; `docs/design/itinerary-deck-renderer.{md,zh-CN.md}`; concern-specific authority pointers; existing LoopX task readback.
**Consumes / produces:** current issue acceptance + exact merged SHAs → one remaining-work ledger and evidence-based closure candidates.

- [x] Verify merged SHA, original scope, acceptance evidence and downstream exclusions for the five original closure candidates. #564/#566/#568/#571 satisfy their slices; #577 remains open because wish conditions are not evaluated. For #568 reconcile `<stem>.html`, `<stem>.manifest.json`, `<stem>.qr.svg`; do not rename working code merely to match a stale checklist.
- [x] Correct the renderer design header that still says no product entry; keep current progress in design/issue surfaces, not the frozen Karpo study.
- [x] Reconcile #142's completed #473/#476 prerequisites in architecture D-29; live UAT stays open. Do not repeat #272's already-merged #501 manifest freeze or #231/#234/#235 groundwork.
- [ ] Reconcile #18's stale #512 issue status when updating the issue surface.
- [x] Reconcile stale deck/QR status in the code-map pair. Correct #511's overstrong inference in the readiness report pair: zero provider requests do not prove initialize failed; use the ordered stage chain. This documentation correction does not resolve the original intermittent incident.
- [x] Read the LoopX execution contract: zero registered agents and no current binding. Use direct user-authorized Claude Code execution; do not invent Todo IDs, mutate the unbound lane, create another goal or install a heartbeat.
- [ ] For #577, clarify whether `RecallSignal` carries raw observations or already-matched authoritative inputs and identify where wish `conditions` are enforced. Implement or demonstrate that enforcement with matching and non-matching offline cases, then reconcile the original scope and design. Keep this follow-up within the pure evaluator and read-only integration; runtime activation stays out of scope.
- [ ] When issue updates/closures are explicitly authorized, record scope and evidence, then close only fully satisfied feature tickets. Parent evidence gates stay open. This planning pass itself posts no comments and closes no issues.

### T1 — Finish #559's remaining integration failure experience

**Files:** modify `ts/capabilities/agent-reach.ts`; extend `ts/scripts/agent-reach-wrapper-tests.ts` or add a deterministic error suite; register a new suite only if needed; update `docs/data-sources.{md,zh-CN.md}` only if its contract changes.
**Consumes / produces:** existing ReachResult verdict, setup, inventory and evidence → safe user copy with the same routing/recovery semantics.

- [x] Add deterministic cases for missing executable/package, timeout, malformed bridge JSON, nonzero stderr and empty response. Pin the currently raw-stderr case before changing it; keep successful data and unknown-channel inventory intact.
- [x] Follow `anything.ts` failure classification at the existing boundary. Preserve source tags and upstream `needs-setup` instructions; do not add a second channel registry, automatic retries or a new Python surface.
- [x] Assert the user sees cause, affected capability and next action; no raw traceback, secret-like diagnostic value, or false booking-failure claim.
- [x] Run deterministic error cases (14 sections), typecheck and isolated smoke; the existing optional wrapper suite retains its dependency/live skip rules.
- [ ] Merge the fix and reconcile acceptance before closing #559; full regression has passed.

### T1b — Repair the existing share/session-link validation boundaries

**Files:** `ts/src/session-link/session-link.ts`, `ts/src/share/share-token.ts`, `ts/scripts/session-link-tests.ts`, `ts/scripts/share-tests.ts`; corresponding design pairs if the contract wording changes.
**Consumes / produces:** existing token, optional secret and injected clock → existing invalid/expired result union without acceptance on an invalid time.

- [x] Add failing tests for production without a secret, an expired signed token with `now: () => new Date(NaN)`, and a clock callback that throws. Repeat the invalid-clock cases for both token families; run configuration tests in isolated subprocess environments.
- [x] Move verification-time secret resolution into a guarded body and reject non-finite current time. Keep deliberate configuration/signing exceptions at issuance; session-link verification must return `link_invalid` for operational validation errors, and share verification must preserve its `token_invalid`/`token_expired` vocabulary.
- [x] Preserve normal round trips, expiry boundaries, signature checks, target binding, unknown-key rejection and the ban on write actions. Do not register a deep-link handler, sender or tick process.
- [x] Run both token suites (share 85, session-link 96), typecheck and isolated smoke, including expiry boundaries and malformed runtime keys.
- [ ] Merge and reconcile #573/#580 acceptance before closure; full regression has passed.

### T2 — Complete #569's real QR acceptance

**Files:** `ts/scripts/itinerary-deck-export-tests.ts`, `ts/capabilities/itinerary-deck-export.ts`, renderer design pair; package/lockfiles only if an approved open-source test decoder is needed.
**Consumes / produces:** generated SVG and manifest → independently decoded payload and an explicit distinction between hosted URL and local-only marker.

- [x] Decode the actual generated SVG through an independent decoder after rasterization; compare exact URL for ordinary and UTF-8 payloads, and the literal local-only marker when URL is absent. Different bytes and a `<path>` element are insufficient proof.
- [x] Check the issue's `local_only` expectation against the accepted manifest contract. Either deliver an explicit compatible indicator or record an approved scope reconciliation; absence of `target_url` must not imply an online destination. Keep decoder dependencies out of runtime where possible.
- [ ] Exercise practical display size and quiet-zone behavior with a real scanner, record the payload without using private links, and retain oversized-input zero-write/collision regressions. Adjust margin only if evidence requires it.
- [x] Re-run export (170), renderer (226), artifact (131), typecheck and isolated smoke; clean dependency installation also passes export and typecheck.
- [ ] Merge and reconcile the outstanding physical-scan acceptance before closing #569; full regression has passed.

### T3 — Make the extension release path verifiable, then finish distribution

**Files:** `.github/workflows/extension-publish.yml`, `docs/extension-store-publish.{md,zh-CN.md}`, `docs/ops/extension-webstore-submission.{md,zh-CN.md}`, existing extension/package tests as needed.
**Consumes / produces:** exact source/version + built archive → validated archive path and explicit upload/review/store states; one shared release for #346/#537.

- [ ] Read existing authorization and the actual dashboard/API receipt first. The release note says review pending, but the two observed workflows only packed. If a manual submission already exists, record it and avoid resubmission.
- [x] Fix the download/upload path mismatch before automated submission: upload-artifact roots the three files at their common `dist-extension` directory, while download-artifact defaults to the workspace. Explicitly download to `dist-extension` and assert the archive exists before OAuth/network calls. See upstream [upload behavior](https://github.com/actions/upload-artifact/tree/v4#upload-using-multiple-paths-and-exclusions) and [download behavior](https://github.com/actions/download-artifact/tree/v4#download-single-artifact).
- [x] Validate publish response semantics against the current official API; HTTP success alone is insufficient. Fail closed on missing token, malformed response, or rejected status. Reconcile documentation's five secrets with the current four-secret direct API workflow.
- [x] Prove pack→download→file lookup and response classification offline, including HTTP-success/application-rejection. Prepare exact SHA, version, permission diff, checksum and rollback package without overwriting the user's existing `dist-extension/` work.
- [ ] Only after the existing/new founder authorization covers the exact release, submit or continue review. After approval, install from the store and prove portal ticket → bridge connected → Dida login/hit or truthful degraded state, plus update behavior. Preserve challenge stop and zero transaction writes.
- [ ] Close #346/#537 only at their respective accepted exit conditions; an upload, pending review, GitHub Release or unpacked test is not store pull-back proof.

### T4 — Use three complete journeys to choose the next core capability

**Files/surfaces:** existing `ts/scripts/replay.ts`, `ts/scripts/engine-run.ts`, deck/export entries, `docs/capability-onboarding.{md,zh-CN.md}`; a concise bilingual evaluation report if new evidence is collected.
**Consumes / produces:** current usable product → ranked, reproducible user-visible gaps; no automatic new feature commitment.

- [ ] Walk three cases: multi-city trip with work window and booked hotel; infeasible Erhai wish with conditions and alternatives; missing optional integration followed by recovery and a readable deck.
- [ ] Record question count/repetition, preserved constraints, time to usable plan, evidence/price freshness, degradation explanation and artifact usability. Mock replay establishes deterministic behavior only; a bounded real-model session is needed for dialogue quality.
- [ ] Use explicit isolated state and a controlled credential/budget path for any live model run. Do not change historical fixtures' dates to make stale evidence look live; create dated inputs for live use.
- [ ] Rank observed failures by blocked planning decisions. Create one independent scope per confirmed defect before implementing it. Check #344 non-CNY and #429 address needs during intake; do not automatically add FX, routing, hosted sharing or new recall runtime.

### T5 — Complete #272 with real session evidence

**Files/surfaces:** `ts/scripts/sf-live-benchmark.ts`, `ts/scripts/sf-summary.ts`, `ts/data/sf-golden-manifest.json`, session adapter/RFC contracts, ignored evidence output.
**Consumes / produces:** authorized connected browser and pinned package → real per-adapter connected/degraded evidence, separate from static comparator proofs.

- [ ] Reuse the frozen sf-01..08 manifest; inspect whether its dated queries remain usable and record an explicit new window when needed, without silently rewriting historical evidence.
- [ ] With authorized login and store/unpacked channel identified, run one bounded batch into an explicit private evidence directory. Stop on challenge/guard violation; preserve attempted/not-attempted rows and missing-adapter coverage.
- [ ] Rebuild summaries from that same directory and inspect packaged entry, transport shape, login/hit/degraded behavior and cleanup. D-37 branded-Chrome/store behavior needs its own real observation.
- [ ] Separate code defects into isolated PRs. Keep #272 open for unproven supported adapters; do not call a static/manual comparator proof real supplier verification.

### T6 — Start real M3 outcomes and paired M4 follow-up

**Files/surfaces:** `ts/scripts/product-metrics.ts`, `ts/scripts/nightly-evidence.ts`, `ts/scripts/memory-lifecycle.ts`, `ts/scripts/memory-value-report.ts`; ignored `ts/gotry-state/evidence/`.
**Consumes / produces:** admitted, consented observations → de-identified cohort, rerunnable summaries, and explicit missing evidence.

- [x] Prepare the existing collector commands and an input checklist covering eligibility, window, consent, owner and follow-up. These inputs are not yet frozen; no real cohort rows were collected.

- [ ] Freeze eligibility, observation window, denominator, consent, evidence owner and follow-up method before collecting. At the second real user or any multi-machine proposal, perform #275 topology/fencing review before expansion; the trigger does not automatically mandate replication software.
- [ ] Use the existing collection/scoring contracts. Track genuine delivered/finalized plans and audited POI claims; keep fixture/developer walkthrough records separate. Do not fabricate participation or send invitations without explicit outreach authorization.
- [ ] For #22 collect 50–200 real users; require finalization ≥40%, NPS ≥40 with response denominator, POI hallucination <1%, and in-window rerunnable real-LLM nightly evidence.
- [ ] In parallel, schedule paired first/repeat observation for #20: real `observed_private` N≥5, p50/p75 active durations, median reduction ≥50%, reflux baseline, traceable preferences and human source-review attestation. Collector exports remain candidates until reviewed.
- [x] If evidence is absent, record waiting/backoff/no-spend. Formal M4 admission still follows M3 Exit; a few successful interviews are not either milestone exit.

### T7 — Run Booking UAT when its independent prerequisites exist

**Files/surfaces:** `docs/architecture.{md,zh-CN.md}` §1.4 / D-29, `docs/evaluation/copilot-readiness-report.{md,zh-CN.md}`, current booking proof scripts, #142 UAT evidence and exact GoTry/hotel-be/hotel-fe SHAs.
**Consumes / produces:** authorized four-surface environment → real inventory/recovery/Checkout/QueryOrders evidence; no M5 activation.

- [ ] Reconcile already-delivered authority/readiness work, then freeze actual deployed versions, host identity and supplier/UAT scope.
- [ ] Cover tenant/customer/storefront/payment-link; observe typed availability transitions on real inventory and at least one unavailable/changed offer recovery through re-search and a fresh CheckAvail.
- [ ] Keep Book owned by the existing Checkout and within its authorized UAT scope. Capture unknown→QueryOrders reconciliation and process cleanup; do not add a GoTry supplier write to satisfy the test.
- [ ] If environments or business permission are absent, leave the lane waiting while T1–T6 proceed. #136 production admission and #137 pilot remain separate gates.

## 6. Verification and handoff

The integrated source passed `scripts/run-all-tests.sh` with all live supplier/session switches disabled (exit 0, `ALL SUITES GREEN`, runtime Node 26.9.0). Targeted typecheck/smoke and the changed suites also passed; release classification has 159 assertions. Optional Agent Reach installation, STAICLI tarball proof and live probes retain their explicit skips. Final documentation changes passed the bilingual and readability gates.

Existing targeted commands, run from the repository root:

```bash
cd ts
npx tsx scripts/itinerary-deck-tests.ts
npx tsx scripts/itinerary-deck-artifact-tests.ts
npx tsx scripts/itinerary-deck-export-tests.ts
npx tsx scripts/gotry-try-demo-tests.ts
npx tsx scripts/share-tests.ts
npx tsx scripts/recall-tests.ts
npx tsx scripts/session-link-tests.ts
npx tsc --noEmit
npx tsx scripts/smoke.ts
cd ..
node scripts/check-docs-i18n.mjs
node scripts/check-doc-readability.mjs
GOTRY_SESSION_LIVE=0 GOTRY_HBCLI_LIVE=0 GOTRY_HOTELBYTE_SKILLS_LIVE=0 ./scripts/run-all-tests.sh
```

For each implementation PR, attach exact tested SHA, commands, exit results, explicit skips and remaining live gates. A cancelled CI run does not prove a code failure or a passing gate; report local and remote evidence separately. Follow the existing merge/release authorization, and never merge with known red tests.

The current delivery covers T0–T3 engineering and T6 preparation. Next execute the bounded #577 follow-up, physical QR scan and admitted T4–T7 evidence lanes; store actions still require their recorded release authorization. Use independent implementation/review lanes for disjoint files, with one integration owner. This proposal adds no scheduled task, release, external message, product-state write or issue closure; those actions are governed by their existing scope and authorization.
