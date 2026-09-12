[English](milestone-delivery-plan.md) | [简体中文](milestone-delivery-plan.zh-CN.md)

# M4→M6 Delivery Plan and Task Graph (issue #225)

> Positioning: split M4→M5→M6 into a living program task graph deliverable across separate worktrees, spelling out per item the responsibility face, responsible files, dependencies, deliverables, minimal E2E, falsification, and exit criteria.
> Status: living (issue #225). Pre-entry mechanisms for #231 (trusted approval receipts + atomic outbox core), #232/#233 (hotelbyte-cli pure adapter and cancel/refund/commission contracts), #234 (kernel manifest + import trace proof tooling), and #235 (sponsor plugin contract + default-off fixtures) have entered main and remain sealed at the runtime boundary; the program as a whole stays TODO — qualifying real supplier UAT evidence required by #136/#142, accepted P6 approval, and pilot-signing evidence remain outstanding. This document is a plan and responsibility graph, not a replacement for M3/M4/M5/M6 Exit evidence.
> Upstream: [`../roadmap.md`](../roadmap.md), [`../architecture.md`](../architecture.md) §1/§9/§10/§11, [`../gotry-master-outline.md`](../gotry-master-outline.md) §3.5/§3.7, issues #20/#22/#136/#137/#225/#223/#227/#228/#230/#231/#232/#233/#234/#235/#241/#242/#254/#255/#257.
> Downstream: standalone Claude Code worktree tasks, architecture re-verification, PR descriptions, and the contribution gate; public delivery records follow [`../ops/external-pr-workflow.md`](../ops/external-pr-workflow.md) §0.

## 0. Overview

1. **Overall program status: TODO**. The M3 real seed cohort is not closed; the M4 real `observed_private` N≥5 repeat cohort has not been reached; the M5/M6 Entry gates are both unmet.
2. **Status uses only DONE/TODO**; blocking reasons go in each task block's "blockers/dependencies" field.
3. **Foundation code status is not Exit evidence**: tenant ledger/fold/state-cli, Z3/map stability, the M4 scorer (#238), and the opt-in lifecycle collector (#248) are all in main; #227/#241/#242 are closed. A verified engineering foundation does not substitute for a real cohort, a supply agreement/internal authorization, P6 approval, or pilot signing.
4. **Real gates and implementation tasks still open**: #20/#22 real cohort, #136 supply agreement/internal authorization, and #137 P6 approval with a real pilot are all TODO. Before admission only already-authorized #136/#137 design work, read-only investigation, fixtures, and failing-before tests are allowed; the transaction runtime, supplier writes, and the real B2B path still require their respective Entry.
5. **M5 first supply chain**: `hotelbyte-cli` (public MIT CLI; hotel-be internal assets are only bridged/referenced, never copied). No supply agreement signing/internal authorization evidence has been obtained; only read-only interface investigation and contract preparation are underway.
6. **M5 Entry has two components**: M4 Exit + the supply agreement. WriteGate design may proceed; transaction implementation and real book/cancel/refund/UAT stay TODO until Entry is met.
7. **M6 stops at draft + proof scope**: [`../milestones/m6-b2b-reuse-walkthrough.md`](../milestones/m6-b2b-reuse-walkthrough.md) still awaits founder review; zero kernel diff is an engineering metric, not a proxy for traveler outcomes.
8. **Baseline stability is closed out**: #227 passed Node24 typecheck, 3×240, full, and CI on the integration candidate, then merged and closed; the #242 fix is also in main and closed.
9. **Public traceability (#270)**: engineering and docs lanes run per issue: start → Draft PR → exact-head review → merge/destination receipts archived; local/fixture evidence does not replace real admission under #20/#136/#137.

## 1. Dependency graph (no invented management steps)

```text
Z3/map 集成基座(#227/#242,均已关闭) ─> 后续实现仍在各自最终 SHA 运行本地门

M3 real cohort (#22) ─┐
                     ├─> M3 Exit ─> 正式 M4 Entry
M4 scorer hardening (#223,工程加固 #238 已入 main) ─┐
M4 opt-in lifecycle export (#228,collector #248 已入 main) ─┼─> real observed_private repeat cohort N≥5 (#20) ─> M4 Exit
M4 reflux baseline ────────────────┘

M4 Exit + hotelbyte-cli 供应链协议 (#136) ─> M5 Entry ─> #231/#232/#233 pre-entry mechanisms in main (runtime sealed) + qualifying real supplier UAT (#136/#142) → M5 Exit
tenant ledger 代码在 main(#229/#237,验收#230 已关闭) + state-cli 代码在 main(#236) ─┐
CLI 小数边界补丁 #241/PR243(已入 main 7a7f271,issue #241 已关闭) ───────────────┤
M5 Exit + accepted P6 founder approval (#137) ───────────────────────┴─> existing #234 import-only proof tooling (already running) + Entry-gated #235 real sponsor activation (M5 Exit + P6) + real pilot signing → M6 Exit
```

## 2. Task index (≤5 columns)

| ID | Status | Issue | Responsibility face / worktree | Main blocker or next evidence |
|---|---|---|---|---|
| B-1 | DONE (in main) | #227/#244/#245 | baseline fix line | integration candidate passed Node24 typecheck, 3×240, full, and CI; merge tree equivalent, #227 closed |
| B-2 | DONE (in main) | #241/#243 | state-cli integration line | CLI `.5`/`+.5` decimal boundary merged into main and closed |
| M4-1 | DONE (in main) | #223/#238 | `m4-scorer-hardening` | scorer hard N≥5/≥50% + HMAC/strict schema in main; real cohort still at M4-3 |
| M4-2 | DONE (in main) | #228/#248 | `m4m6-collector-20260908` | explicit opt-in lifecycle collection/de-identified export in main; generates candidate/synthetic only |
| M4-3 | TODO | #20 | evidence responsibility face | real `observed_private` N≥5 repeat cohort + reflux baseline |
| M5-0 | TODO | #136 | supply/legal + adapter responsibility face | hotelbyte-cli agreement verification; no signing/internal authorization evidence obtained |
| M5-1 | DONE (in main, design input only) | #225/#136 | docs/program-225 | WriteGate proposal in main (PR #249 merge 293bbb6); #231 core code is already in main; remaining M5 runtime activation, real supplier UAT, and M5 Entry still TODO (#136), transaction runtime stays sealed |
| M5-2 | TODO (pre-entry in main) | #231 | m5-core worktree | trusted approval receipts + atomic outbox core mechanism shipped to main; real supplier effect and M5 Entry still TODO (#136) |
| M5-3 | TODO (pre-entry in main) | #232 | m5-adapter worktree | hotelbyte-cli pure-contract adapter + fake-CLI shipped to main; real supplier UAT and M5 Entry still TODO (#136) |
| M5-4 | TODO (pre-entry in main) | #233 | m5-refund worktree | cancel/refund/wallet outcome + commission/disclosure pure contract shipped to main; real compensation matrix and M5 Exit still TODO |
| M6-0 | DONE (in main) | #229/#237/#230 | ledger integration line | tenant ledger/fold code and acceptance in main |
| M6-0b | DONE (in main) | #236/#241/#243 | state-cli integration line | tenant CLI and decimal boundary in main and closed |
| M6-1 | DONE (in main) | #225/#137 | docs/program-225 | P6 approval draft in main (PR #249 merge 293bbb6); #137 founder YES still TODO, M6 Entry still waits on M5 Exit |
| M6-2 | TODO | #137 | founder review | only an explicit founder YES approving the overall plan or approving a revised draft satisfies P6 Exit |
| M6-3 | TODO (existing tooling in main) | #234 | m6-proof worktree | kernel manifest + import trace proof tooling shipped to main (import-only proof gate already runs); M5 Exit + accepted P6 + real sponsor UAT still TODO (#137) |
| M6-4 | TODO (pre-entry in main) | #235 | m6-plugin worktree | sponsor plugin contract + default-off fixtures shipped to main; Entry-gated real sponsor activation (M5 Exit + P6) + pilot signing still TODO (#137) |
| M6-5 | TODO | #137 | sales/legal | B2B pilot signing/commercial terms; still part of M6 Exit, cannot be moved out |
| Q-1 | DONE (in main) | #225/#240 | docs/program-225 | contribution gate docs entered main with #240 |
| Q-2 | PARTIAL | #254 | data-repair responsibility face | engineering apply/rollback + receipt schema landed; closing still needs a founder-authorized real repair receipt (or confirmation that no move is needed); quality/follow-up line, not an M5/M6 Entry blocker |
| Q-3 | TODO | #255 | design/memory responsibility face | track real usage of P4 session dual-zone memory and multi-user trigger conditions; quality/follow-up line, not an M5/M6 Entry blocker |
| Q-4 | DONE (in main) | #257 | packaging responsibility face | entered main and closed with PR #264 (merge bd45d42): exclude generated node_modules under the vendor directory from the npm tarball; quality/follow-up line, not an M5/M6 Entry blocker |

## 3. M4 task blocks

### M4-1 — #223 scorer hard thresholds and privacy

- **Inputs**: current counterexamples in `ts/scripts/memory-value-report.ts`: inputs can lower `minimum_pair_count_for_exit`/`target_median_reduction_ratio`; `subject_ref` is not HMAC; unknown fields are not rejected.
- **Responsible files**: `ts/scripts/memory-value-report.ts`; `ts/data/memory-value-fixture.json`; required state surfaces.
- **Outputs**: fixed N≥5 and paired median reduction≥50%; target comparison uses the unrounded ratio, rounding only for display; observed_private identities and associated references HMAC-SHA256 only; strict nested schema and calendar validity; synthetic/candidate never Exit; manual source attestation must bind the payload digest of this scoring run; errors/stdout/stderr do not reflect secrets, malformed JSON fragments, or private paths.
- **Minimal E2E**: run the counterexample first to get the old `exit_ready=true`; after the fix, run positive/negative/CLI cases together with isolated input files. Must include an exact 50% positive case, a 49.999975% below-threshold negative case, an invalid-date negative case `2026-02-30T00:00:00Z`, a manual attestation payload digest change negative case, a malformed JSON privacy sentinel not echoed back, and a valid positive case where multiple preference assertions share one evidence_ref.
- **Falsification**: a single pair with target=0 still passes; 49.999975% is rounded into passing; plaintext email/nested unknown fields/synthetic sentinels are accepted or echoed; an old attestation overrides changed pairs; `evidence_ref` is wrongly forced to one-to-one.
- **Exit criteria**: all #223 acceptance passes, plus tsc/run-all/CLI E2E at the final SHA; does not close #20; subject to the #227 merge re-verification gate.

### M4-2 — #228 explicit opt-in planning lifecycle collection/de-identified export

- **Inputs**: #228; the scorer contract after M4-1 hardening; `memory-design.md` §7.
- **Responsible files**: new explicit observation CLI/pure-logic module (defined by the #228 PR); git-ignored `ts/gotry-state/evidence/m4/` serves only as private output.
- **Outputs**: record first visit/next eligible completed flow, start/end, pre-declared wait codes and wait boundaries; HMAC-pseudonymized subject/flow/pair/experience/assertion/evidence; export candidate or synthetic, never manual attested.
- **Minimal E2E**: isolated stateRoot: with opt-in on, collect two eligible flows + waits → export → readable by the #223 scorer; with opt-in off/missing consent/missing HMAC key, zero writes.
- **Falsification**: default product sessions get collected; scanning historical wish/motivation logs to derive a cohort; waits modified after completion; exports containing PII/URL/token.
- **Exit criteria**: #228 acceptance fully passes; real N≥5 stays in M4-3; depends on the #223 contract and #227 stability.

### M4-3 — #20 real repeat cohort and reflux baseline

- **Inputs**: the M4-2 exporter; informed consent from real users; HMAC salt/key stored privately.
- **Responsible files**: private `ts/gotry-state/evidence/m4/manifest.json`, `paired-cohort.jsonl`, `summary.json`; publicly only a de-identified summary or issue status is submitted.
- **Outputs**: N≥5 eligible completed planning pairs from the same users' first visit/return visits; active planning duration excludes pre-declared waits; experience reflux baseline = verified/recalled, with each verified paired by a recalled and an evidence_ref.
- **Minimal E2E**: run the scorer on private copies; the summary reports eligible_pair_count, p50 reduction, and the reflux denominator.
- **Falsification**: N<5; samples are not repeats; waits backfilled after the fact; fixtures used as baseline; consent not traceable by a human audit.
- **Exit criteria**: the #20 M4 paired cohort criteria are met; if not, the numbered gap remains.

## 4. M5 task blocks (first supply chain: hotelbyte-cli)

### M5-0 — #136 HotelByte supply agreement verification

- **Versions and release artifacts (distinguish the three; see [`write-gate-production-design.md`](write-gate-production-design.md) §2 for details)**:
  - hotel-be internal reference snapshot `16467805bb454df89fc894a7823da674348566e3` (bridge/reference only, no code copying).
  - CLI gitlink old source `d62030bb9c132e5797e07371c5af0d2b97fdb819`/`staicli@0.0.2` are historical snapshots, not a basis for the current release artifact.
  - CLI 0.0.3 release commit `41b5c1a8cc85f736aed753705c8c4b83b7666b4a`; current master `e3bae224d8cee0bb34795198eafcf689a1620df6` contains PR #13 but the npm tarball does not.
  - The actual release artifact is npm `staicli@0.0.3` (integrity `sha512-xGzw6KBQ4r5l+...`); the adapter must pin this artifact, not hard-bind master.
  - GoTry main `2626167` bootstrap requires `hbcli>=0.0.3` by default; this is an install check only and proves nothing about trade authentication.
- **Real interfaces (current investigation, not equivalent to the agreement)**:
  - `search hotel-rates` → `/api/search/hotelRates`; returns/saves `sessionId` and `ratePkgId`.
  - `search check-avail` → `/api/search/checkAvail`; available means `status=1`; original-currency amounts, cancellation policies, and quote sources must be preserved.
  - `trade book` → `/api/trade/book`; requires `sessionId`/`ratePkgId`/`holder`/`guests`; the backend validates against the session-cached CheckAvail.
  - `trade query-orders --customer-reference-nos` → `/api/trade/queryOrders`; a permission-filtered platform order query; OpenAPI users cannot pierce through to the supplier.
  - `trade cancel` → `/api/trade/cancel`; requires `customerReferenceNo` plus the `supplierReferenceNo` returned to the customer; the CLI has no refund command.
- **Unproven premises / TODO**:
  - No signing/authorization evidence for the agreement: Buyer, environments, supply routing, commission/after-sales fields, manual reconciliation SLA, and real UAT scope remain to be verified.
  - portal-first is not fixed: npm 0.0.3 and master still prefer an available portal ticket, with no endpoint-level OpenAPI identity selection; 0.0.3 only skips the stored-ticket placeholder and falls back, so it cannot be called forced OpenAPI. An isolated credential home + a fixed Buyer/environment remain necessary.
  - Read-auth retry must not be reused for transactions: on master, the 401 clear-ticket retry may still select portal again; audience selection is not fixed.
  - `customerReferenceNo` is not permanently idempotent: the backend reuses in-flight/succeeded orders by Buyer+ref, and Cancelled/Failed allows rebuilding with the same ref; the same authorization intent binds only to an immutable attempt, and a new order requires new authorization.
  - 30s CLI abort + a long recovery window (180s Phase1, then up to 10min Phase2; late orders can be auto-cancelled): timeout/process exit/non-JSON = unknown; query the order first and respect the recovery window.
  - No general selector: no `tenantEntityId`/`DistributorOption` found in the current CLI/backend; the first M5 integration can only fix one authorized Buyer/supply route; before M6 or multiple routes, upstream must provide a real selector + session/order binding + mismatch rejection.
  - `supplierReferenceNo` may be the platform order number and must not be self-decoded; `cancel.serviceFee` is not the customer refund amount; order/cancel/refund order/wallet refund are distinct outcomes.
  - UAT ONLINE Book has OTP/full-refund-policy requirements and the CLI has no test/OTP channel; do not bypass it, do not read OTP, do not run real transactions.
  - The existing GoTry read-only `ts/capabilities/hbcli.ts` bridge cannot be reused as a transaction boundary (spawn inherits `process.env`, timeout SIGKILL, static fallback on read failure); the transaction adapter must build a new controlled env/credential home/identity boundary.
- **Exit criteria**: supply agreement/fields/UAT scope can be checked off item by item; if unmet, M5 Entry stays closed.

### M5-1 — WriteGate proposal merged into the repo

- **Responsible files**: [`write-gate-production-design.md`](write-gate-production-design.md).
- **Outputs**: trusted receipt issuance/consumption authority; request fingerprint (bound to the actual supplier request canonical payload digest or the existing `payload_digest`, sensitive fields never written publicly to the ledger); approval_claims persistence; local outbox intent (no claim of external exactly-once); dispatcher atomic claim + pre-call persistence of `dispatching`/immutable attempt id/fencing; pre-call revalidation (authorization/quote-receipt validity/immutable digest/routed Buyer/revocation); lease expiry implies neither no side effects nor a reset of what has not executed; the HotelByte unknown/query miss/reconciliation/compensation/disclosure matrix and the admission matrix.
- **Minimal E2E**: document link/path checks; consistent references across the six state surfaces.
- **Falsification**: the document implies M5 has opened the gate; the outbox is written up as external exactly-once; a query miss within the recovery window becomes reconciled_failed; receipts accept client/model-assembled values; omissions of the HotelByte 30s/unknown/query-orders/Buyer/selector/OTP/portal-first gaps; omissions of atomic claim/pre-call attempt persistence/pre-call revalidation/no reset on lease expiry; dispatch falsifications written up as executed.
- **Exit criteria**: the WriteGate proposal entered main with PR #249 (merge 293bbb6), as a design input only before M5 implementation; the #231 core code is already in main — what remains for M5 Entry is runtime activation + qualifying real supplier UAT (#136), and M5 Exit; transaction runtime stays sealed.

### M5-2 — #231 persisted trusted approvals and atomic outbox

- **Status**: pre-entry mechanism shipped to main (`ts/src/write-gate.ts`: `preparePresentation`, `trustedHostConfirm`, `claimForDispatch`, `preDispatchRevalidate`; included by `scripts/run-all-tests.sh` write-gate section); runtime boundary sealed; real supplier effect, M5 Entry, and M5 Exit remain TODO (#136).
- **Prerequisites**: both M5 Entry items met (M4 Exit + supply agreement); M5-1 proposal accepted.
- **Responsible files**: `ts/src/state-ledger.ts`; `ts/src/booking-saga.ts`; `ts/capabilities/effect.ts`; the `approval_claims` table; `write_effect_intents` dispatch-state/attempt/fencing fields; required docs/tests.
- **Outputs**: nonce/fingerprint is prepared server-side as a `PreparedChallenge` before presentation and bound to the immutable request; the receipt issuance and consumption channels accept only trusted host UI confirmation callbacks (carrying actor/tenant/seam/challenge); the model can only request presentation, a model-initiated confirmation is rejected and produces no outbox; `approval_claims(receipt_id PRIMARY KEY, challenge_id, nonce_digest UNIQUE, consumed_at)` plus the `pending_writes` state transition and the outbox intent go in the same SQLite transaction; the order is prepare/present → trusted confirmation → atomic consumption + outbox; replaying the same receipt/nonce/challenge across intents returns `approval-claimed`. `WriteEffectIntent` carries `tenant_id`; the receipt consumption transaction produces exactly one local outbox intent (`dispatch_status=queued`); the dispatcher claims atomically via a conditional update on `tenant_id + idem_key` (or a global `effect_id` with verified tenant ownership), gaining dispatch rights only when affected rows=1, and subsequent fold/query are equally tenant-scoped. Before any supplier/network call, `dispatching` and immutable `attempt_id`/`fencing_token`/`claimed_by`/`lease_until` are persisted in the same transaction; among concurrent workers only the one that won the claim may dispatch. See [`write-gate-production-design.md`](write-gate-production-design.md) §5.3/§5.4 for details.
- **Pre-call revalidation**: after winning a claim and before any supplier/network call, revalidate authorization, quote/receipt validity, the current immutable request digest, the routed Buyer, and revocation status; when expired/changed/revoked and no call has gone out, supplier write=0, the old effect is set to `rejected` at the outbox/dispatch layer and never returns to queued, and a new quote/intent/receipt is created; something already unknown keeps querying, and authorization expiry neither returns it to queued nor rebooks. Rejection does not extend the ADR-17 `pending_writes` three states `pending|confirmed|compensated` and does not project supplier failure/refund. See §5.5 of the same document.
- **Guarantee scope**: the local guarantee is "the same ledger intent is consumed once and registers exactly one write effect intent, and the same `attempt_id` books only once"; whether external side effects duplicate depends on supplier idempotency/duplicate detection; unknown forbids blind retries. An intent stays queued only while the atomic claim/`dispatching` transaction has not committed; once `dispatching` + an immutable attempt id is persisted, regardless of whether the crash happened before/after the outbound call, whether network logs exist, or whether the lease expired, it cannot be re-claimed, re-dispatched, or replay-booked — uniformly unknown/query/manual reconcile (by the same attempt/`customerReferenceNo`); fencing/lease protect only local state transitions and cannot retract a request already sent; lease expiry implies neither no side effects nor returning a persisted dispatching to queued for rebooking.
- **Minimal E2E**: concurrent double confirmation yields exactly one claim/outbox; with the same legitimate actor + legitimate snapshot, a model-initiated confirmation is rejected with no outbox, and only a human callback authorizes; directly consuming a prepared challenge is rejected; receipt expiry/amount/currency/terms/presentation_key/nonce changes fail closed; changing the fingerprint after confirmation is rejected; crash injection covers three orderings — claim consumption/outbox/pending transition; replaying the same receipt across intents is rejected.
- **Falsification**: bypassing WriteGate to call the supplier directly; an empty receipt confirmed; nonce not persisted or generated only after presentation; model tool calls counted as human confirmation; a prepared challenge consumed; duplicate write effect intent registration after a crash; a client-supplied receipt_id accepted; claim/fold/query across tenants on `idem_key` alone; treating a persisted-dispatching crash without network logs as no outbound call and booking; lease/fencing/authorization expiry returning unknown or persisted dispatching to queued; preflight rejection adding `stale`/`cancelled` to `pending_writes` or projecting supplier failure/refund. **Future implementation minimal falsifications (current proposal, none executed)**: ① two dispatchers competing for the same queued intent send exactly once, and A/B with the same `idem_key` can each claim/fold/query only their own tenant's intents — cross-tenant affected rows=0 and supplier write=0; ② only an uncommitted claim transaction may return to queued — any crash after attempt persistence/before the network/after the network/before projection (even without network logs) neither blind-replays nor books, uniformly unknown; ③ queue/preflight local rejection is zero-write, the old effect is set to `rejected` and never returns to queued, and the ADR-17 `pending_writes` three states stay unchanged with no projection of supplier failure/refund; ④ changing holder/guests or Buyer after confirmation is zero-write; ⑤ lease/fencing/authorization expiry cannot return unknown or persisted dispatching to queued; with the lease expired and a late supplier success there is still exactly one book. Do not claim these tests are currently executed.
- **Exit criteria**: fixture/sandbox E2E + run-all; real supplier effects still wait for M5-3.

### M5-3 — #232 hotelbyte-cli trade adapter + unknown/query/reconcile

- **Status**: pre-entry contract + fake-CLI shipped to main (`ts/capabilities/hotelbyte-transaction.ts`: `classifyBookExecution`, `advanceReconciliation`, `newIntentAllowed`; `ts/scripts/hotelbyte-spawn-e2e-tests.ts` `runFake` exercises a local fixture subprocess); real adapter wiring, supplier UAT, and M5 Entry remain TODO (#136).
- **Prerequisites**: M5-0 agreement fields available; M5-2 core ready.
- **Responsible files**: new hotelbyte-cli trade adapter (files defined by the implementation PR); adapter tests; reconciliation docs.
- **Outputs**: pin the npm `staicli@0.0.3` release artifact (integrity per M5-0), not master; isolated credential home; controlled env; fixed global flags prefix; mandatory `customerReferenceNo`; book result.status `verified|pending|failed` projection; unknown → `query-orders` or manual reconcile; a query miss within the recovery window stays unknown. Before initiating `trade book`, the adapter runs the M5-2 pre-call revalidation (authorization/quote-receipt validity/immutable request digest/routed Buyer/revocation); when expired/changed/revoked and no call has gone out, zero supplier writes, the old effect is set to `rejected` at the outbox/dispatch layer and never returns to queued, and a new quote/intent/receipt is created (no extension of the ADR-17 `pending_writes` three states, no projection of supplier failure/refund); `RequestFingerprint` binds the canonical payload digest of the actual supplier request (covering the holder/guests fields that affect fulfillment) or the existing immutable `payload_digest`, with sensitive fields never written publicly to the ledger; replacing travelers or contacts after presentation/confirmation must be zero-write. See [`write-gate-production-design.md`](write-gate-production-design.md) §4/§5.4/§5.5 for details.
- **Minimal E2E**: fixture CLI: book verified/pending/failed/timeout/non-json/exit0-but-pending/query success/miss within window/late success/late auto-cancel; assert that exit0 does not mean success, unknown does not rebook, and an in-window miss does not become reconciled_failed.
- **Falsification**: concurrent rebooking of the same authorization intent; treating the CLI 30s abort as failed; an in-window miss becoming reconciled_failed and then rebooking; compensating without querying the order; credentials or Buyer routing taken from the user's global environment; the read-auth retry policy unconditionally reused for transactions; no revalidation before the outbound call, or still calling out when expired/changed/revoked, or returning the old effect to queued; booking anyway after holder/guests or contacts are replaced post-presentation/confirmation; inferring no side effects from lease expiry and rebooking; preflight rejection adding `stale`/`cancelled` to `pending_writes` or projecting supplier failure/refund. **Future implementation minimal falsifications (current proposal, none executed)**: ① two dispatchers competing for the same intent send exactly once; ② only an uncommitted claim transaction may return to queued — any crash after attempt persistence/before the network/after the network/before projection (even without network logs) neither blind-replays nor books, uniformly unknown; ③ queue/preflight local rejection is zero-write, the old effect is set to `rejected` and never returns to queued, and the ADR-17 `pending_writes` three states stay unchanged with no projection of supplier failure/refund; ④ changing holder/guests or Buyer after confirmation is zero-write; ⑤ lease/fencing/authorization expiry cannot return unknown or persisted dispatching to queued; with the lease expired and a late supplier success there is still exactly one book. Do not claim these tests are currently executed.
- **Exit criteria**: the adapter passes fixture/sandbox and the real UAT gate; without agreement signing/internal authorization evidence or UAT, it stays TODO.

### M5-4 — #233 cancel/refund/wallet outcome + commission/disclosure

- **Status**: pre-entry contract shipped to main (`ts/src/booking-surface/cancel-refund-commission.ts`: cancel/refund validation, disclosure, fingerprint binding); real compensation matrix, customer refund path, and M5 Exit remain TODO.
- **Prerequisites**: M5-3; verification of the supplier cancel/refund/wallet restoration fields.
- **Responsible files**: cancel/refund outcome projection; transparency cards/audit reports; tests.
- **Outputs**: pending cancel and confirmed compensation kept as distinct terms; `trade cancel` receipt, refund order, wallet refund, service fee, and customer refund amount projected separately; commission/sponsorship/after-sales responsibility disclosed before confirmation and included in the fingerprint.
- **Minimal E2E**: a pending cancel writes no refund; a confirmed cancel succeeds while the wallet refund is pending; serviceFee is not treated as the customer refund; a disclosure change invalidates the old receipt.
- **Falsification**: ledger `compensated` unconditionally showing money returned; treating `cancel.serviceFee` as a refund; disclosures appearing only after booking, or an unknown default of zero commission.
- **Exit criteria**: the compensation/disclosure matrix fully passes; measured unit economics belong to M5 Exit separately.

## 5. M6 task blocks

### M6-0 — #229/#237 tenant ledger isolation (DONE, in main)

- **Status**: DONE. The tenant scope fix (#229) and the fold regression (#237) are merged into main and #230 is closed; the M6 sponsor proof must still reference run evidence at its own final SHA.
- **Outputs**: `insertEvent` writes the current tenant; `readEvents`/fold/rebuild all carry tenant conditions; legacy/v1 migrates into `local` only; the same id/idem_key across tenants does not overwrite; non-local historical events miswritten as `local` are not auto-repaired by guessing.
- **Falsification (pinned)**: tenant A reads or rebuilds tenant B projections; after removing `tenant_id` from the fold query, the negative variant fails to fail reliably.
- **Exit criteria**: code and acceptance are in main; later M6 proofs bind to their own final SHA.

### M6-0b — #236/#241 state-cli tenant and decimal boundaries (DONE, in main)

- **Status**: DONE. state-cli strict parsing and the `.5`/`+.5` decimal boundaries are merged into main (#236/#241/#243); #241 is closed; #227/#242 are also closed.
- **Outputs**: `state-cli` parses cmd/positional/`--state-root`/`--tenant`/`--limit` centrally; unknown/duplicate/missing-value/illegal numeric flags fail closed before any state-root side effects; `tick`/`export`/`whatif` are explicitly local-only; `--tenant` is ledger scope only and constitutes no authentication or authorization.
- **Falsification (in main, pending re-verification at a new SHA)**: `rebuild -1`/`rebuild 1.5`/`rebuild .5`/`rebuild +.5` treated as root; flag values becoming business parameters; non-local tick/export/whatif producing file changes.
- **Exit criteria**: #236 and #241/#243 are both in main; later M6 proofs bind to their own final SHA.

### M6-1 — P6 draft proof scope improvements

- **Responsible files**: [`../milestones/m6-b2b-reuse-walkthrough.md`](../milestones/m6-b2b-reuse-walkthrough.md).
- **Outputs**: traveler principal/sponsor/BFF principal kept as distinct terms; calibrating "single-point proven/constructive isolation" as PoC assumptions; the reuse proof needs a baseline SHA, core file set, core diff, runtime trace, and functional path coverage; tenant adversarial checks; disclosure plugin proposal; P6 founder review and pilot signing stay in M6 Exit.
- **Minimal E2E**: document link/path checks.
- **Falsification**: claiming frozen/passed review; relying on LOC reuse rate; using sponsor gains to cover traveler motivation; moving the commercial pilot out of M6 Exit.
- **Exit criteria**: the P6 approval draft entered main with PR #249 (merge 293bbb6), as an approval draft only; the #137 founder explicit YES is still TODO; only explicit founder approval satisfies P6 Exit, and M6 Entry still waits for M5 Exit.

### M6-2 — #137 P6 founder review

- **Inputs**: the M6-1 draft; commercial goals; travel agency/destination candidates.
- **Outputs**: a `YES approval` of the overall plan or specific revision items; only an explicit YES or explicit approval of a revised draft satisfies P6 Exit.
- **Falsification**: engineering declaring P6 exit on its own; implementing without review.
- **Exit criteria**: P6 Exit holds only after explicit founder approval; M6 Entry still waits for M5 Exit.

### M6-3 — #234 reuse proof schema and generation scripts

- **Status**: pre-entry offline proof tooling shipped to main (`ts/data/kernel-manifest.json`; `ts/scripts/kernel-manifest-gate.ts` loads the frozen manifest, validates schema/integrity/functional coverage, runs the runtime import trace; `ts/scripts/kernel-manifest-evidence.ts` builds evidence; `scripts/run-all-tests.sh` invokes the import-only proof gate — it already runs unconditionally); M5 Exit, accepted P6, and real sponsor UAT remain TODO (#137).
- **Responsibility face**: m6-proof worktree; freeze the denominator up front so implementers cannot invent one on the spot.
- **Responsible files**: `ts/data/kernel-manifest.json`, `ts/scripts/kernel-manifest-gate.ts`, `ts/scripts/kernel-manifest-evidence.ts` (already in main, import-only proof gate wired into run-all); future work is real sponsor activation + tenant/sponsor adversarial evidence under #137.
- **Outputs**: a fixed frozen `kernel-set.txt`; `loaded-modules.json`; runtime actually-loaded coverage; pre-declared functional path coverage; LOC only as an auxiliary number.
- **Minimal E2E**: run the sponsor fixture after freezing the full kernel-set; the whole kernel group is zero-diff, with actually-loaded coverage and pre-declared functional path coverage reported separately.
- **Falsification**: shrinking the kernel-set by the modules loaded in this run or hiding changes; substituting a loaded LOC ratio for the two coverage reports; claiming path coverage without going through the fact gate/WriteGate/async.
- **Exit criteria**: a re-runnable denominator exists before the M6 sponsor plugin proof.

### M6-4 — #235 sponsor plugin proof

- **Status**: pre-entry contract/fixture shipped to main (`ts/capabilities/sponsor-plugin.ts`: `createSponsorPlugin`, route authorization, ranking, confirmation fingerprint, `runBookingScenario`; `requireRuntimeActivation` enforces the default-off flag boundary); activation, real traveler outcomes, real agency E2E, and pilot signing remain TODO (#137).
- **Prerequisites**: M5 Exit + explicit M6-2 P6 founder approval + M6-0 tenant isolation evidence + the M6-3 proof schema.
- **Outputs**: the full travel-agency embedding chain: traveler motivation interview → same MotivationProfile/constraints → sponsor inventory → transparency cards with disclosures → provable zero kernel diff.
- **Minimal E2E**: run the sponsor plugin in an isolated tenant/stateRoot; `git diff` over the full fixed `kernel-set` is empty; runtime actually-loaded coverage and pre-declared functional path coverage each pass; tenant/sponsor adversarial checks pass.
- **Falsification**: it only works after changing `model.ts`/`unified.ts`/the core card schema; the BFF principal passing as the traveler; tenant A injecting tenant B sponsor inventory.
- **Exit criteria**: engineering proof numbers are formed; no claims of traveler adoption or commercial outcomes.

### M6-5 — #137 pilot commercial terms/signing

- **Responsibility face**: sales/legal.
- **Outputs**: real pilot signing evidence; a split report of commercial returns and traveler value. Reasons for not signing only explain the TODO and cannot substitute for signing.
- **Falsification**: verbal intent posing as a signature; treating sponsor conversion as traveler motivation uplift.
- **Exit criteria**: the commercial half of M6 Exit has real evidence; unsigned, M6 stays TODO.

## 6. Open-source quality task blocks

### Q-1 — contribution gate documentation fixes

- **Responsible files**: `../../CONTRIBUTING.md`; `../../.github/pull_request_template.md`; `../../README.md`.
- **Outputs**: at the final SHA, local `cd ts && npx tsc --noEmit` + `GOTRY_SESSION_LIVE=0 ./scripts/run-all-tests.sh` are mandatory; CI is supplementary only; the E2E line is mandatory; semantics/architecture/maintenance-compatibility/six-state-surface self-checks; no claim that GitHub branch protection is in effect.
- **Minimal E2E**: document link/path checks + searches for stale section numbers and "CI can substitute for local evidence".
- **Falsification**: PRs still allow CI-only evidence; the template lacks the E2E line; hardcoded counts like `§1–49` persist; claims that branch protection is configured.
- **Exit criteria**: new PRs can provide reproducible evidence per the template.

### Q-2 — #254 manual repair of historical tenant events (data-repair, quality/follow-up)

- **Responsibility face**: data-repair responsibility face; not an M5/M6 Entry blocker.
- **Responsible files**: `ts/src/ledger-repair-plan.ts`, `ts/src/ledger-repair-apply.ts`, `ts/scripts/state-cli.ts` (`repair-plan` / `repair-apply` / `repair-rollback`), run-all §29b/§29c; owner checklist [`../ops/ledger-tenant-repair.md`](../ops/ledger-tenant-repair.md). Boundary per `../architecture.md` §8.16 and D-32 — non-local historical events miswritten as `local` by the old bug lack an auditable owner, cannot be repaired by schema-migration guessing, and can only go through a separate manual data-repair issue/PR when external evidence exists.
- **Outputs**: dry-run plan + authorized apply/rollback with checksummed backup and receipt schema for evidence-backed mappings; without evidence, no repair by guessing. Fixture green ≠ real founder repair.
- **Exit criteria**: engineering apply face merged (PARTIAL); issue close still requires a founder-authorized real repair receipt **or** founder confirmation that no real move is needed; no change to M5/M6 Entry.

### Q-3 — #255 P4 session dual-zone memory usage tracking (design/memory, quality/follow-up)

- **Responsibility face**: design/memory responsibility face; not an M5/M6 Entry blocker.
- **Responsible files**: defined by the tracking PR; `design/memory-design.md`.
- **Outputs**: track real usage of P4 session dual-zone memory and multi-user trigger conditions, providing observational input for the future D-15 trigger surface.
- **Exit criteria**: tracking conclusions land in the design docs; no change to M5/M6 Entry.

### Q-4 — #257 vendor node_modules npm tarball exclusion (packaging, quality/follow-up)

- **Responsibility face**: packaging responsibility face; not an M5/M6 Entry blocker.
- **Responsible files**: defined by the packaging PR; npm pack allowlist/ignore rules and pack-proof related files.
- **Outputs**: exclude the generated `node_modules` under the vendor directory from the npm tarball, avoiding release bloat and accidental packaging.
- **Exit criteria**: entered main with PR #264 (merge bd45d42), #257 closed; packaged artifacts verified to contain no vendor `node_modules`; no change to M5/M6 Entry.

## 7. Current global status checklist

1. DONE (in main): #227 Z3 lifecycle passed Node24 typecheck, 3×240, full, and CI on the integration candidate, then merged and closed.
2. DONE (in main): the #242 dsh-map-tools map regression was fixed by #245 into main and the issue is closed.
3. DONE (in main): #223/#238 M4 scorer hard thresholds, privacy, and schema fixes closed out.
4. DONE (in main): #228/#248 explicit opt-in M4 planning lifecycle local collection and de-identified export; candidate/synthetic only.
5. TODO: #20 real `observed_private` N≥5 repeat cohort and reflux baseline.
6. TODO: #136 HotelByte supply agreement, Buyer/environment/routing, fields, manual reconciliation, and UAT verification (no signing/internal authorization evidence obtained).
7. DONE (in main, design input only): #225/#136 M5-1 WriteGate proposal entered main with PR #249 (merge 293bbb6); #231 core code is already in main — remaining M5 runtime activation + real supplier UAT + M5 Entry still TODO (#136).
8. TODO (pre-entry mechanism in main): #231 trusted approval receipts + atomic outbox core code shipped to main (`ts/src/write-gate.ts`); runtime boundary sealed; real supplier effects, M5 Entry, and M5 Exit remain TODO (#136).
9. TODO (pre-entry contract in main): #232 M5 HotelByte trade adapter pure contract + fake-CLI shipped to main (`ts/capabilities/hotelbyte-transaction.ts` + `ts/scripts/hotelbyte-spawn-e2e-tests.ts`); real supplier UAT and M5 Entry remain TODO (#136).
10. TODO (pre-entry contract in main): #233 M5 cancel/refund/wallet outcome + commission/disclosure contract shipped to main (`ts/src/booking-surface/cancel-refund-commission.ts`); real compensation matrix and M5 Exit remain TODO.
11. DONE (in main): #229/#237 tenant ledger isolation + fold regression with #230 acceptance.
12. DONE (in main): #236 state-cli tenant boundaries and the #241/#243 `.5`/`+.5` decimal boundaries merged and closed.
13. DONE (in main, approval draft only): #225/#137 M6-1 P6 draft/proof scope entered main with PR #249 (merge 293bbb6); the #137 founder YES and M6 Entry remain TODO.
14. TODO: #137 explicit P6 founder approval of the overall plan or approval of a revised draft.
15. TODO (existing tooling in main): #234 M6 kernel manifest + import trace proof tooling shipped to main (`ts/data/kernel-manifest.json`; `ts/scripts/kernel-manifest-gate.ts`; `ts/scripts/kernel-manifest-evidence.ts`); import-only proof gate already runs in `scripts/run-all-tests.sh`; M5 Exit, accepted P6, and real sponsor UAT remain TODO (#137).
16. TODO (pre-entry contract/fixture in main): #235 M6 sponsor plugin contract + default-off fixture shipped to main (`ts/capabilities/sponsor-plugin.ts` with `requireRuntimeActivation` enforcing default-off); Entry-gated real sponsor activation + real agency E2E + pilot signing remain TODO (#137).
17. TODO: #137 B2B pilot commercial terms/signing.
18. PARTIAL (quality/follow-up, not an M5/M6 Entry blocker): #254 engineering apply/rollback + receipt schema landed; closing still needs a founder-authorized real repair receipt or confirmation that no move is needed.
19. TODO (quality/follow-up, not an M5/M6 Entry blocker): #255 tracking real usage of P4 session dual-zone memory and multi-user trigger conditions.
20. DONE (in main, quality/follow-up, not an M5/M6 Entry blocker): #257 entered main and closed with PR #264 (merge bd45d42) — excluding the generated node_modules under the vendor directory from the npm tarball.

## 8. Explicit non-goals

- No deriving Exit from fake cohorts, synthetic fixtures, or historical wish/motivation logs.
- No changing the M4/M5/M6 Exit definitions to bypass the real cohort, the supply agreement, P6 founder review, or pilot signing.
- No implementing production booking/payment/refund-change; until M5 Entry is met, WriteGate stops at the proposal.
- No treating B2B sponsor gains, tenant adversarial results, or kernel reuse rate as evidence of traveler motivation value.
- No treating CI, badges, not-yet-effective branch protection, or template wording as local final SHA evidence.
- No copying hotel-be internal code; HotelByte enters GoTry only through the public MIT `hotelbyte-cli`, the subprocess bridge, and the supply agreement.
