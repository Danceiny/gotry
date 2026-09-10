[English](write-gate-production-design.md) | [简体中文](write-gate-production-design.zh-CN.md)

# WriteGate Productionization Design Proposal (issue #225 / M5)

> Positioning: a WriteGate productionization proposal ahead of closing the M5 transactional loop; it defines approval receipts, one-time confirmation, supplier unknown state, reconciliation/compensation, commission disclosure, and the integration boundary for HotelByte as the first supply chain.
> Status: proposal (2026-09-08; design only; unseals no booking/payment implementation)
> Upstream: [`../roadmap.md`](../roadmap.md) M5, [`../architecture.md`](../architecture.md) ADR-15/17/18/23, [`../rfc/transactional-state-rfc.md`](../rfc/transactional-state-rfc.md) §4.3, [`booking-saga-fsm.md`](booking-saga-fsm.md), [`effect-interpreter.md`](effect-interpreter.md), [`milestone-delivery-plan.md`](milestone-delivery-plan.md), issues #136/#225.
> Downstream: implementation PRs for the WriteGate core/outbox/supplier adapter after M5 Entry; the B2B sponsor disclosure surface is covered in [`../milestones/m6-b2b-reuse-walkthrough.md`](../milestones/m6-b2b-reuse-walkthrough.md).

## 0. Abstract

1. **The Entry gate has two items**: M5 can be implemented only after M4 Exit and the supply chain agreement are both satisfied; this document does not change roadmap Exit/Entry.
2. **First supply chain**: M5 first integrates `hotelbyte-cli` (a public MIT CLI; hotel-be internal assets are only bridged/referenced). Currently there is no evidence of a signed supply chain agreement or internal authorization; only read-only interface investigation and contract preparation are under way.
3. **Core invariant**: any booking/payment/refund-class write effect must first have a `pending_writes` L2 intent, then a one-time trusted L3 receipt; no receipt, no external side effect.
4. **The receipt is authorized by a trusted human confirmation callback, not by a model tool call**: the nonce/challenge is prepared server-side before presentation and bound to the immutable request; the receipt issuance and consumption channels accept only trusted host UI confirmation callbacks — the model can only request presentation. Preparation/presentation → trusted confirmation → atomic consumption + outbox; a prepared challenge does not constitute authorization.
5. **The request fingerprint binds the request, not the button**: it must include actor, tenant, traveler principal, supplier, product/offer, amount, currency, terms digest, validity period, presentation version, and nonce; it must also bind the canonical payload digest of the actual supplier request (covering fulfillment-affecting fields in holder/guests), or explicitly bind the existing immutable `payload_digest`. Sensitive fields themselves are never written to the public ledger; replacing the traveler or contact after presentation/confirmation must result in zero writes.
6. **A local outbox is not external exactly-once**: the receipt consumption transaction produces exactly one local outbox intent; the dispatcher obtains sole dispatch rights through an atomic database claim, and persists `dispatching` plus immutable attempt id/fencing metadata before any supplier/network call, so that among concurrent workers only one has the right to dispatch. **Only while the atomic claim/`dispatching` transaction has not yet committed does the intent remain `queued` and claimable by another worker; once `dispatching` and the immutable attempt id are persisted, no matter whether the crash is deemed to have happened before or after the outbound call, whether network logs exist, or whether the lease has expired, the intent can no longer be re-claimed, re-dispatched, or re-booked — missing records only mean evidence absence and do not prove no outbound call.** A crash/timeout/lease expiry with persisted `dispatching` uniformly enters `unknown`; only query or manual reconcile with the same attempt/`customerReferenceNo` is allowed. GoTry guarantees that the same ledger intent is consumed once and registers exactly one write effect intent, and that the same `attempt_id` books at most once; whether external side effects duplicate depends on supplier idempotency/queryability. Blind retries are forbidden while unknown. Fencing/lease can only protect local state transitions; they cannot recall a request already sent to the supplier; lease expiry does not imply no side effect, nor may an intent with persisted `dispatching` return to queued and book again.
7. **Supplier unknown is a first-class outcome**: after timeout, process exit, non-JSON responses, or connection loss, an external side effect may already exist; enter order query or manual reconciliation, and the user-visible copy must not read as failure or refund. A query-orders miss stays unknown within the recovery window and must not become reconciled_failed followed by rebooking.
8. **Cancel ≠ compensation ≠ refund received**: canceling a pending, unexecuted suggestion is only a local cancel; refund/change after confirmation is real compensation; HotelByte's cancellation order, refund order, wallet refund, and fees must be projected separately.
9. **Pre-dispatch re-validation at the dispatch point (#231/#232 tightening)**: a queued effect is re-checked before any supplier/network call for authorization, quote/receipt validity, the current immutable request digest, routing/Buyer, and revocation status. On expiry/change/revocation, supplier write=0 and the flow returns to re-quoting/trusted confirmation; a request already in unknown keeps being queried and must not be rebooked on the grounds of expiry. This item and the atomic claim/attempt fencing of item 6 are both proposal designs and unseal no runtime.

## 1. Non-goals and red lines

- Do not implement production booking, payment, ticketing, refunds, or supplier adapters.
- Do not add a runtime framework; continue reusing the ADR-15 single SQLite ledger, ADR-17 `booking_saga_fsm.v1`, and the ADR-18 effect interpreter.
- The atomic claim, `dispatching`/attempt id/fencing, and pre-dispatch re-validation of §5.3/§5.4, together with the §12 dispatch falsification, are proposal designs and acceptance criteria for future implementation under #231/#232; today no code lands and no tests run, and they must not be claimed as implemented or executed.
- Do not claim M5 Exit with sandbox fixtures; fixtures can only prove gate semantics.
- Do not record a supplier API "request sent" or a CLI `exit 0` as "booking succeeded"; success must come from supplier confirmation, `result.status=verified`, or a queryable order result.
- Do not store ID numbers, phone numbers, emails, bank cards, cookies, OTPs, payment tokens, original order numbers, or raw conversations in public audit logs.
- Do not copy hotel-be internal code; HotelByte enters GoTry only through the public MIT `hotelbyte-cli`, a subprocess bridge, and the supply chain agreement.

## 2. HotelByte first supply chain facts and unproven premises

### 2.1 Versions and release artifacts (all three must be distinguished)

M5 design cannot rely on version strings alone; it must distinguish the local backend snapshot, the public CLI source, and the actual npm release artifact.

| Artifact | Identifier | Meaning |
|---|---|---|
| hotel-be local reference | `16467805bb454df89fc894a7823da674348566e3` | internal backend snapshot; bridge/reference only, no code copying |
| CLI gitlink old source | `hotelbyte-com/hotelbyte-cli` `d62030bb9c132e5797e07371c5af0d2b97fdb819`, `staicli@0.0.2` | historical source snapshot; not the basis for the current release artifact |
| CLI 0.0.3 release commit | `41b5c1a8cc85f736aed753705c8c4b83b7666b4a`; PR [#12](https://github.com/hotelbyte-com/hotelbyte-cli/pull/12) `fba0d9f32e22281217f0c754142aa78cf9091847` adds Node/npm distribution | the 0.0.3 release point; includes the placeholder-ticket fallback fix |
| CLI current master | `e3bae224d8cee0bb34795198eafcf689a1620df6`; PR [#13](https://github.com/hotelbyte-com/hotelbyte-cli/pull/13) adds 401 ticket-clearing retry + per-invocation credential home reading, still declares 0.0.3 | master contains #13, but the npm 0.0.3 tarball does not contain #13 |
| npm actual release artifact | [staicli@0.0.3](https://registry.npmjs.org/staicli/0.0.3), published 2026-09-08T14:21:22.665Z; integrity `sha512-xGzw6KBQ4r5l+CXDbU/35p2nh6ia4t7Hjh+D34IxQEgtaOOkt9iUATmxlFwcspmXCo6NuHoYFhCJ/rJ3rso5fg==`; the registry has no gitHead | the adapter must pin this release artifact and must not hard-bind to current master |
| GoTry bootstrap requirement | main `2626167` [`bin/gotry-bootstrap.js`](https://github.com/Danceiny/gotry/blob/2626167a0617c12dacb145307c3db2a566b1ffe8/bin/gotry-bootstrap.js#L104) defaults to `hbcli>=0.0.3` (environment can override) | an installation check only; it does not prove trade authentication |

The public CLI repo has no tags/releases; the docs repo has native releases only for 0.0.2/0.0.1; the `staicli-v0.0.3` API returns 404. This confirms the actual npm 0.0.3 package but not a native 0.0.3 release. The adapter must record the actual bin/package digest and capabilities, and must not hard-bind to master.

### 2.2 Real entry points (current investigation; not yet the agreement)

| Stage | CLI/API | Design implication |
|---|---|---|
| rate | `search hotel-rates` → `/api/search/hotelRates` | persist `sessionId`/`ratePkgId`; later check/book depends on same-session semantics |
| availability | `search check-avail` → `/api/search/checkAvail` | available is `status=1`; the original-currency amount, cancellation policy, and offer source must be preserved |
| book | `trade book` → `/api/trade/book` | requires `sessionId`/`ratePkgId`/`holder`/`guests`; the backend validates against the session-cached CheckAvail |
| query | `trade query-orders --customer-reference-nos` → `/api/trade/queryOrders` | a permission-filtered platform order query; OpenAPI users cannot penetrate through to the supplier |
| cancel | `trade cancel` → `/api/trade/cancel` | requires `customerReferenceNo` plus the customer-facing `supplierReferenceNo` from the response; the CLI has no refund command |

Relative to the old snapshot, `trade.ts` is unchanged: `customerReferenceNo` is optional; there is no tenant selector/refund command/OTP parameter/timeout flag; HTTP still aborts at 30 seconds.

### 2.3 Authentication and trade capability gaps

1. **Portal-first is not fixed**: npm 0.0.3 and current master still prefer an available portal ticket; `trade`/`checkAvail` share `run→makeClient`, and there is no endpoint-level OpenAPI identity selection; 0.0.3 only skips the stored-ticket placeholder and falls back, which cannot be called enforced OpenAPI. An isolated credential home plus a fixed Buyer/environment remains necessary. See [helpers](https://github.com/hotelbyte-com/hotelbyte-cli/blob/e3bae224d8cee0bb34795198eafcf689a1620df6/src/commands/helpers.ts#L40), [check-avail](https://github.com/hotelbyte-com/hotelbyte-cli/blob/e3bae224d8cee0bb34795198eafcf689a1620df6/src/commands/search.ts#L105).
2. **Read-auth retry must not be reused for trade**: npm 0.0.3 `run` is single-shot; master's 401 ticket-clearing retry may still select portal again — audience selection is not fixed (see [retry](https://github.com/hotelbyte-com/hotelbyte-cli/blob/e3bae224d8cee0bb34795198eafcf689a1620df6/src/commands/helpers.ts#L88)). The trade adapter must not unconditionally reuse any future read-auth retry strategy for trade.
3. **#142 corrected the historical 401 attribution**: the historical 401 was corrected to a rate-selection error, not missing entitlement; and the issue being closed does not mean real booking/refund UAT either.

### 2.4 Premises that must remain TODO

1. **No signed/authorized evidence exists for the agreement**: Buyer, environment, supply routes, commission/after-sales fields, the manual reconciliation SLA, and the real UAT scope all remain to be verified.
2. **`customerReferenceNo` is not permanently idempotent**: it is optional in the CLI, but GoTry must enforce persistence. The backend reuses in-flight/succeeded orders by Buyer+ref, and Cancelled/Failed allows re-creating with the same ref; the same authorization intent binds only to an immutable attempt, and a new order requires new authorization.
3. **30s CLI abort plus a long recovery window**: the CLI HttpClient aborts after 30 seconds by default; the backend recovers for 180 seconds in Phase1 and then up to 10 minutes in Phase2, and late orders may be auto-canceled. GoTry treats timeout/process exit/non-JSON as unknown; query orders first and respect the recovery window.
4. **Identity isolation has no general selector yet**: no `tenantEntityId` selector or `DistributorOption` has been found in the current CLI/backend; M5 first integration can only pin one authorized Buyer/supply route. Before M6 or multi-route, upstream must provide a real selector plus session/order binding plus mismatch rejection.
5. **Cancel/refund fields cannot be simplified**: `supplierReferenceNo` may be a platform order number and must not be decoded locally; `cancel.serviceFee` is not the customer refund amount; order, cancellation, refund order, and wallet refund are distinct outcomes.
6. **UAT ONLINE Book has OTP/fully-refundable policy requirements**: the CLI has no test/OTP channel. Do not bypass it, do not read OTPs, and do not perform real transactions.
7. **The existing GoTry read-only hbcli bridge cannot be reused as the trade boundary**: `ts/capabilities/hbcli.ts` spawn inherits `process.env`, injects default uat/token env, SIGKILLs on timeout, only checks exit 0 before attempting JSON, and can statically fall back on read failure; the trade adapter must build a new controlled env/credential home/identity boundary.

## 3. Vocabulary and objects

| Term | Responsibility | Required fields/constraints |
|---|---|---|
| `WriteIntent` | L2 suggestion state; registers only, never executes | `idem_key`,`tenant_id`,`actor_ref`,`principal_ref`,`seam`,`payload_digest`,`created_at`,`expires_at`; the existing entry point is `requestPendingWrite` |
| `RequestFingerprint` | the canonical request the user sees and authorizes | SHA-256 over canonical JSON; fields in §4; computed and frozen server-side before presentation, immutable after confirmation |
| `PreparedChallenge` | a one-time presentation challenge prepared server-side before presentation | `challenge_id`,`idem_key`,`request_fingerprint_sha256`,`presentation_key`,`delivery_nonce_digest`,`actor_ref`,`tenant_id`,`seam`,`prepared_at`,`expires_at`,`status=prepared\|confirmed\|consumed\|expired`; the nonce is generated before presentation and bound to the immutable request; `prepared` does not constitute authorization, and an unconfirmed challenge cannot be consumed |
| `ApprovalReceipt` | the L3 one-time confirmation credential, issued by the server only after a trusted human confirmation callback | `receipt_id`,`challenge_id`,`idem_key`,`request_fingerprint_sha256`,`actor_ref`,`tenant_id`,`principal_ref`,`amount_total`,`currency`,`terms_digest`,`valid_until`,`approved_at`,`presentation_key`,`delivery_nonce_digest`; generated by the server-side ledger after the trusted confirmation callback; model/client assembly is not accepted |
| `ApprovalClaim` | the one-time consumption authority for receipt/nonce | standalone table `approval_claims(tenant_id, receipt_id PRIMARY KEY, challenge_id, idem_key, nonce_digest, request_fingerprint_sha256, issued_at, consumed_at)`; `receipt_id` globally unique, `challenge_id`/`nonce_digest` unique; recorded in the same SQLite transaction as the outbox intent |
| `WriteEffectIntent` | a pending external side effect intent in the outbox | `tenant_id`,`effect_name`,`idem_key`,`receipt_id`,`supplier_attempt_key`,`request_fingerprint_sha256`,`attempt_budget`,`next_action`; dispatch state `dispatch_status=queued\|dispatching\|dispatched\|rejected`, immutable `attempt_id`, `fencing_token`, `claimed_by`, `lease_until`, `reject_reason`; `attempt_id` is persisted before any supplier/network call and is immutable; `rejected` is an undispatchable terminal state at the outbox/dispatch layer (pre-dispatch re-validation failure), **not** a new `pending_writes` state |
| `SupplierOutcome` | the projection of the supplier result | `success | failed | unknown | reconciled_success | reconciled_failed | cancel_submitted | refund_pending | refunded | compensated_failed`, with supplier receipt/refund digests attached |
| `RedactedAuditEvent` | the shareable audit surface | HMAC pseudonymous subjects + digests + amount/currency/terms version; no PII/secrets/raw supplier payloads |

The one-time consumption authority for receipt/nonce uses the standalone `approval_claims` table. The single-consumption semantics of `receipt_id`/`challenge_id`/`nonce_digest` live at a different layer from the events' business idempotency `idem_key`; a standalone table lets unique constraints directly express "one challenge can be confirmed only once, and one receipt can be consumed by only one intent", and during crash recovery the claim replays in the same transaction as the outbox.

`pending_writes.status` continues to use only ADR-17's `pending | confirmed | compensated`. Supplier `unknown` is not stuffed into the saga state alphabet; instead it becomes a `SupplierOutcome` projection: locally the receipt has already been consumed and the state has entered confirmed, but the external world is not yet decidable. This does not overturn `booking_saga_fsm.v1` while honestly expressing reconciliation status.

## 4. Request fingerprint fields

The request fingerprint must be canonicalized by code and referenced from the same source in all three places: the presentation card, the approval receipt, and the supplier write effect.

| Field | Description | Consequence of change |
|---|---|---|
| `schema` | `gotry_write_request_fingerprint.v1` | mismatch rejects confirmation |
| `tenant_id` | ledger tenant; must exist even before M6 | a different tenant means a different request |
| `actor_ref` | the human or L4 policy initiating confirmation, HMAC pseudonym | an actor change requires re-confirmation |
| `principal_ref` | the traveler principal, HMAC pseudonym; in B2B not the same as the sponsor/BFF principal | a principal change requires re-confirmation |
| `sponsor_ref` | optional, HMAC pseudonym; B2B/partner inventory only | a sponsor change requires re-disclosure |
| `seam` | a named seam, e.g. `hotelbyte-hotel-book-confirm` | an unregistered seam fails closed |
| `supplier` | vendor/channel + CLI/API version + Buyer/route digest | a vendor or identity-route change requires re-confirmation |
| `product_ref` | `sessionId`/`ratePkgId`/offer digest; no PII stored | an offer change requires re-confirmation |
| `travel_terms` | digest of check-in/check-out, party size, room type, breakfast, cancellation policy, taxes/fees, etc. | a terms change requires re-confirmation |
| `amount_total` | the user-authorized total amount in the smallest currency unit; original currency preserved | an amount change requires re-confirmation |
| `currency` | ISO 4217 or the supplier's original-currency mapping | a currency change requires re-confirmation |
| `commission_disclosure` | digest of the commission/sponsorship/rebate terms; may be none but must be explicit | a disclosure change requires re-confirmation |
| `valid_until` | the offer/authorization validity period; must precede the supplier quote expiry | expiry rejects confirmation |
| `presentation_key` | digest of the card version the user actually saw | card re-layout or field removal requires re-confirmation |
| `delivery_nonce_digest` | the nonce/challenge digest generated by the server before presentation and durably bound to the immutable request; the fingerprint the user sees already contains this nonce | nonce mismatch, confirmation without presentation, or a fingerprint change after confirmation are all rejected |

**Supplier payload digest binding (#231/#232 tightening)**: `request_fingerprint_sha256` must bind the canonical payload digest of the actual supplier request — covering the fulfillment-affecting fields in the holder/guests objects (guest identity/party size/room type/dates, etc.) — or explicitly bind the existing immutable `payload_digest`. Comparing only amount/room type must not allow swapping the traveler or the booking contact after presentation/confirmation; replacing holder/guests or the contact after presentation or confirmation must result in zero supplier writes and requires a new quote/intent/receipt. Sensitive fields (ID numbers/phone numbers/emails/payment tokens) themselves are never written to the public ledger; only their digests or HMAC pseudonyms enter the fingerprint and the audit surface (see §11).

## 5. State machine and execution sequence

### 5.1 L2: suggestion state and pre-presentation preparation

1. When the planner generates a writable suggestion, it calls the existing `requestPendingWrite`. If a later implementation needs a new facade, it must be explicitly defined in the implementation PR with an ADR documenting the handover.
2. `payload` stores only presentable semantics and digests; sensitive traveler/payment fields never enter the ledger.
3. A repeated proposal with the same `tenant_id + idem_key` is a no-op and returns the existing pending/confirmed/compensated state.
4. The presentation card must include the total price, currency, terms summary, validity period, cancellation rules, commission/sponsorship disclosure, and "confirmation consumes exactly once".
5. **Pre-presentation preparation**: the server computes/generates the `RequestFingerprint` and `delivery_nonce` before presenting to the user, writes the `PreparedChallenge` (`status=prepared`), and binds them to the immutable request. The fingerprint the user sees already contains this nonce; after confirmation neither the fingerprint nor the nonce may change. `prepared` does not constitute authorization and can only be escalated by one trusted confirmation callback.

### 5.2 L3: trusted human confirmation and atomic consumption

**Authorization source (a model tool call is not human confirmation)**:

The receipt issuance and consumption channels accept only approval authority derived from trusted host UI/interaction confirmation callbacks. The callback must carry the server-bound actor/tenant/seam/presentation challenge; the model/planner may request presentation of a writable card within the same authenticated session, but **must not call the receipt issuance or confirmation consumption channels**. With the same legitimate actor and legitimate snapshot, a model-initiated confirmation must be rejected and must not produce an outbox; only a real human callback can authorize. Field matching is not user permission.

**Order: preparation/presentation → trusted confirmation → atomic consumption + outbox**:

1. **Preparation/presentation**: the server generates the `PreparedChallenge` before presentation (nonce + fingerprint + presentation_key, `status=prepared`); the card renders from this record.
2. **Trusted confirmation**: the trusted host confirmation callback references `challenge_id`; the server validates the callback binding (actor/tenant/seam/presentation challenge consistent with the `PreparedChallenge`), sets `PreparedChallenge.status` to `confirmed`, and issues the `ApprovalReceipt` (`approval_claims.consumed_at` still empty). Unconfirmed challenges cannot be consumed.
3. **Atomic consumption + outbox**: within one SQLite transaction:
   - read the pending intent and the `approval_claims` issuance record; verify tenant/actor/principal/seam/receipt_id/challenge_id consistency;
   - recompute the request fingerprint; it must match the issuance record's `request_fingerprint_sha256` byte for byte;
   - verify `valid_until` has not passed, `presentation_key` matches the presented version, and `nonce_digest` is unconsumed;
   - run `UPDATE approval_claims SET consumed_at=? WHERE receipt_id=? AND consumed_at IS NULL` with 1 affected row (atomic single consumption); replaying the same receipt/nonce/challenge across intents returns `approval-claimed` and must not execute a supplier effect;
   - run `UPDATE pending_writes ... WHERE status='pending' AND receipt_id=?` with 1 affected row;
   - append `write.confirmed` and the `WriteEffectIntent` outbox intent (carrying `receipt_id`).

**Rejections**: an old nonce, confirming with an old challenge after re-presentation, changing fingerprint/nonce after confirmation, a model-initiated confirmation, cross-intent replay — all fail closed, with no outbox and no supplier effect.

The `approval_claims` consumption, the `pending_writes` state transition, and the `WriteEffectIntent` outbox append must live in one SQLite transaction. Crash injection must cover three orderings: claim consumed but outbox not written; outbox written but pending not transitioned; transitioned but claim not written — after a restart from any interruption, no duplicate effect intent or second consumption may appear. A `PreparedChallenge` that stays `prepared` unconfirmed expires per `expires_at`; expired challenges cannot be confirmed or consumed.

Under concurrency, of two confirmation requests only one can move `consumed_at` from NULL to non-NULL and write out one effect intent; the other returns `already-confirmed`, `approval-claimed`, or `absorbed-compensated` and must not execute the supplier effect again.
### 5.3 outbox: crash recovery and the "local once" accounting

- **Crash before confirmation**: still pending; the user can confirm again; an unconsumed old nonce is handled per its validity period.
- **Crash after the confirmation transaction, before the supplier call**: the outbox intent exists (`dispatch_status=queued`) but is not attempted; after a worker restarts, it executes the intent via the §5.4 atomic claim.
- **Crash after claim persistence, before the network call**: once `dispatch_status=dispatching` and the immutable `attempt_id`/`fencing_token` are persisted, no matter whether the crash is deemed to have happened before or after the outbound call, whether network logs exist, or whether the lease has expired, the intent can no longer be re-claimed, re-dispatched, or re-booked — missing records only mean evidence absence and do not prove no outbound call; it uniformly enters `unknown`, and only query or manual reconcile with the same `attempt_id`/`customerReferenceNo` is allowed. Only while the atomic claim/`dispatching` transaction has **not yet committed** does the intent remain `queued`, claimable by another worker.
- **Crash/timeout/non-JSON/process exit during the supplier call**: the state enters `unknown`; reconcile first via the supplier attempt key, `customerReferenceNo`, or the order query API; directly replaying the write effect is forbidden.
- **Crash after supplier success, before projection**: fold to success via the supplier receipt/order lookup; if lookup is unavailable, manual reconcile.
- **Explicit supplier failed return**: record the failed outcome; if the supplier confirms that no external side effect occurred, a new quote/intent can be regenerated at the user's choice.
- **Lease expiry**: an expired `lease_until` on the dispatching record **does not imply no side effect**, nor may an intent with persisted dispatching return to `queued` and book again; it uniformly enters unknown/query/manual reconcile, reconciled by attempt id. If the lease expires and a late supplier success arrives, it still books only once (folded to `reconciled_success`).

If a supplier does not support a stable order query key or a manual reconciliation SLA, that supplier cannot enter the automated production WriteGate; it can only stay on manual handling or remain unintegrated.

### 5.4 Dispatch rights and attempt fencing (atomic claim, #231/#232 tightening)

The receipt consumption transaction (§5.2) produces only one local outbox intent (`dispatch_status=queued`); before actually initiating any supplier/network call, the dispatcher must first obtain the **sole dispatch right** for that intent in one atomic database claim, and persist the dispatch state and immutable attempt metadata in the same transaction:

- **Atomic claim**: `UPDATE write_effect_intents SET dispatch_status='dispatching', attempt_id=?, fencing_token=?, claimed_by=?, lease_until=? WHERE tenant_id=? AND idem_key=? AND dispatch_status='queued'` (or an equivalent conditional update; a globally unique `effect_id` whose tenant ownership has been verified inside a trusted transaction may also be used); the claim succeeds only with 1 affected row; subsequent fold/query is likewise scoped to `tenant_id + idem_key`. Among concurrent workers only the one that wins the claim has the right to dispatch; the losers fail and must not initiate supplier calls. The fencing token increases monotonically and is used to reject unauthorized writes from stale leases.
- **Persist before calling**: `dispatching`, the immutable `attempt_id`, and the `fencing_token` must be persisted **before any supplier/network call** (recorded in the same transaction as the claim). The `attempt_id` is immutable once persisted; reconciliation always references the same `attempt_id` and must not start another; after persistence no re-dispatch or book replay is allowed.
- **Crash partitioning**: only while the atomic claim/`dispatching` transaction has **not yet committed** does the intent remain `queued`, claimable by another worker. Once `dispatching` and the immutable `attempt_id` are persisted, no matter whether the crash happened before or after the outbound call, whether network logs exist, or whether the lease expired, the intent can no longer be re-claimed, re-dispatched, or re-booked — missing records only mean evidence absence and do not prove no outbound call; it uniformly enters unknown/query/manual reconcile. A database fencing token cannot stop a request already sent to the supplier; fencing/lease can only protect local state transitions, cannot recall a request already sent, and lease expiry must not be used to infer no side effect or to return persisted dispatching to queued.
- **Local once accounting**: GoTry guarantees that the same ledger intent is consumed once, registers exactly one write effect intent, and that the same `attempt_id` books at most once; whether external side effects duplicate depends on supplier idempotency/queryability, and blind retries are forbidden while unknown.

### 5.5 Pre-dispatch re-validation at the dispatch point (#231/#232 tightening)

After winning the claim and before initiating any supplier/network call, the dispatcher must re-check the following at the same dispatch point:

1. **Authorization**: the receipt is still valid, `approval_claims.consumed_at` still points to this intent, and there has been no cross-intent replay.
2. **Quote/receipt validity**: `valid_until` has not passed and is no later than the supplier quote expiry.
3. **Current immutable request digest**: `request_fingerprint_sha256` (including the §4 supplier payload digest) matches the persisted issuance record byte for byte; holder/guests/contact/routing/amount/terms were not swapped after presentation or confirmation.
4. **Routing/Buyer**: supplier, Buyer, and supply route match the issuance record; identity isolation has not drifted.
5. **Revocation status**: no L4 revoke or explicit revocation has been triggered (§9).

If any item is expired/changed/revoked and the call has **not yet gone out**: **supplier write=0**; record the local rejection reason at the outbox/dispatch (or challenge) layer, set the old effect to an undispatchable terminal state (`dispatch_status=rejected` + `reject_reason`), and **never** return it to `queued`; the user/system then separately creates a new quote/new intent/new trusted confirmation. **A request already in unknown keeps being queried and manually reconciled; authorization expiry must not return it to queued or rebook it.** Layer constraint: the rejection reason exists only at the outbox/dispatch/challenge layer; ADR-17's `pending|confirmed|compensated` three-state alphabet for `pending_writes` is not extended (no `stale`/`cancelled` is added to `pending_writes`); undispatched or preflight-rejected cases always have zero supplier writes and are not projected as supplier failed/canceled orders/refunds. This item is a proposal design and unseals no runtime.

## 6. HotelByte adapter admission matrix

| Dimension | Must design/verify | Minimal fixture E2E | Real UAT gate |
|---|---|---|---|
| CLI source | pin the npm `staicli@0.0.3` release artifact (integrity in §2.1), no hard-binding to master; fix the `--json --env=uat` prefix; do not assume flags are position-independent | `trade book --help` exit0; `--tenant-entity-id` exit1 unknown option; version/integrity drift fails closed | use the release artifact authorized by the agreement; master contains #13 but the npm tarball does not — do not mix them |
| credential boundary | isolated credential home + controlled env; do not inherit GoTry's full `process.env` | zero credential reads when the fake home is absent; errors redacted | fixed Buyer/environment/route authorized by the agreement |
| quote snapshot | `sessionId`/`ratePkgId`/check-avail status/amount/currency/cancellation policy/source digest | check-avail fixtures with status=1/0/changed | a real quote has a validity period and cancellation terms |
| booking | enforce `customerReferenceNo` persistence; immutable attempt per intent | `verified`/`pending`/`failed`/exit0-but-pending all projected correctly | UAT Book runs under a legal fully-refundable policy; OTP is never read by GoTry |
| unknown | 30s abort/timeout/non-json/kill all map to unknown | after unknown, only query/manual reconcile, no rebooking | respect the 180s + up-to-10min recovery window |
| query-orders | query permission-scoped platform orders only by `customerReferenceNo` | query success/miss/multiple/permission-denied | manual reconciliation fields are sufficient; no raw chat needed |
| cancel | requires `customerReferenceNo + supplierReferenceNo`; the CLI has no refund | cancel submitted/failed/serviceFee is not refund | cancellation, refund order, and wallet refund have real field sources |
| multi-route | no selector currently; only one fixed Buyer/route | `--tenant-entity-id` negative case fails closed | no multi-route before upstream provides selector/session/order binding |

## 7. Supplier unknown state and manual reconciliation

The user copy for unknown must be "outcome unknown, reconciling" — not "failed" and not "refunded".

**A query-orders miss does not mean it did not happen**: the HotelByte backend has a long recovery window (180s Phase1 plus up to 10min Phase2; late orders may be auto-canceled). An empty `query-orders` result within the recovery window can only stay `unknown`; it must not become `reconciled_failed` followed by rebooking. unknown converges to `reconciled_failed` only when one of the following authoritative negative evidences holds: an agreement-defined stable terminal failure, an explicit supplier cancellation, an explicit no-order proof bound to the Buyer/attempt, or the recovery window ending with queries still empty and manual reconciliation confirming it.

| Scenario | Ledger state | User copy | Follow-up action |
|---|---|---|---|
| cancel while pending, unconfirmed | `compensated` | local suggestion canceled; no order placed / no charge | no supplier action |
| after confirmation, CLI timeout/abort/non-json | `confirmed` + `SupplierOutcome.unknown` | supplier outcome unknown; do not place the order again; reconciliation has started | `query-orders` or manual reconciliation |
| query miss within the window | `confirmed` + `unknown` (unchanged) | still reconciling; the supplier may create the order late; do not rebook | wait out the recovery window / query again / manual reconciliation |
| query still empty after the window + manual confirmation of no order | `confirmed` + `reconciled_failed` | no order/charge was produced; a new quote is possible | new intent + new receipt |
| query finds success (including a late-created order) | `confirmed` + `reconciled_success` | the booking is confirmed; show the supplier receipt summary | later cancellation goes through compensation |
| late order auto-canceled by the supplier | `confirmed` + `reconciled_failed` or `cancel_submitted` (per the supplier receipt) | the order was canceled by the supplier; handle it per its rules | show the cancellation receipt; rebooking goes through a new intent |
| cancel submitted but the refund has not arrived | `compensated` + `refund_pending` | the refund/change was submitted; refund status pending update | later order query / wallet restore projection |
| refund received | `compensated` + `refunded` | the refund has arrived per the supplier's rules | show the amount/currency/fee source |

**Negative E2E cases (must be covered)**: timeout → query miss within the window → late success (unknown upgrades to reconciled_success, no rebooking); timeout → query miss within the window → late auto-cancel (converges to reconciled_failed or cancel_submitted, no rebooking); timeout → query still empty after the window → manual confirmation of no order (only then is reconciled_failed + a new intent allowed). In every negative case, no second order of the same kind may be initiated during the unknown period.

Manual reconciliation needs these minimal fields: tenant, idem_key, `customerReferenceNo`, supplier attempt key, request fingerprint digest, time window, amount/currency, and supplier candidate digests. Requiring a human to inspect raw user chat or cookies is not allowed.

## 8. Cancel, compensation, and refund term separation

- `pending → compensated`: **cancel the local suggestion**. No external side effect has occurred; do not write "refund".
- `confirmed → compensated`: **a real compensation flow**. It requires a supplier cancellation/refund/rebooking receipt or an explicit failure reason.
- HotelByte `trade cancel` does not close the full refund chain; cancellation, refund order, wallet refund, fees, and the customer refund amount must be separate outcomes.
- During unknown the user may not initiate a second order of the same kind; the options are only "wait for reconciliation / contact a human / give up and accept the risk". If the supplier agreement allows safely canceling the unknown request by `customerReferenceNo`, it must still be recorded as an external compensation attempt.

## 9. L4 automation and revocation

L4 is not "no confirmation" but "the user pre-confirms a revocable policy". The policy itself needs an L3 receipt:

- scope: supplier, destination/date range, amount cap, currency, party size, inventory type, validity period.
- guard: every automatic write still recomputes the request fingerprint; out of scope, downgrade to L3.
- revoke: revocation is a ledger event that immediately blocks future effect intents; an executed effect can only go through compensation and cannot be erased by revocation.
- audit: the receipt of every automatic write is annotated with `approval_mode='l4_policy'`, the policy digest, and that run's request fingerprint.
- expiry: the policy must expire; renewal requires a new receipt.

## 10. Commission/sponsorship disclosure

Before confirmation, every writable card must disclose:

1. The total price the user pays and its currency.
2. Whether GoTry/partners receive commissions, rebates, sponsorship, or preferred-placement benefits.
3. The disclosure source: supplier fields, contract rules, or "no benefit". Unknown must not default to none.
4. In B2B, sponsor benefits and traveler motivations are presented separately; disclosing sponsor benefits does not satisfy traveler motivations.
5. The disclosure digest enters the request fingerprint; a disclosure change invalidates the old receipt.

The M6 sponsor disclosure slot remains a proposal: prefer injecting render fragments from a sponsor plugin, keeping the kernel unaware of sponsors. If M5's consumer-first path needs a schema reservation, the B2C empty value must remain explicit and auditable.

## 11. Audit and redaction

| Data | Public/committable | Private/local | Forbidden |
|---|---|---|---|
| tenant/actor/principal/sponsor | HMAC-SHA256 pseudonyms | salt/key private | names, emails, phone numbers |
| request | SHA-256 digest + presentable summary | the raw supplier payload may be stored encrypted locally | cookies, OTPs, payment tokens |
| receipt | receipt id + digest + amount/currency/validity | the raw approval event may be stored locally | full raw chat transcripts |
| supplier outcome | success/failed/unknown + supplier receipt digest | order query screenshots/order numbers may be stored encrypted locally | unredacted order numbers entering git |
| errors | reason code + redacted evidence | detailed logs stay local | echoing user secrets or raw supplier responses |

All error output must lead with a reason code; a supplier raw response must not be pasted directly into LLM-visible text.

## 12. Acceptance matrix

| Category | Positive E2E | Negative/falsification | Pass criteria |
|---|---|---|---|
| receipt binding | confirm after presentation of the same pending intent; the receipt digest matches the request fingerprint | amount +1, currency changed, terms digest changed, presentation_key changed, nonce reused | positive: confirmed + one local effect intent; negative: fail-closed with no supplier effect |
| authorization source | a trusted host UI confirmation callback carries actor/tenant/seam/challenge; the server issues the receipt | a model initiates confirmation under the same legitimate actor + legitimate snapshot; the client supplies its own receipt_id/nonce/fingerprint | the model confirmation is rejected with no outbox; only human callbacks authorize; field matching ≠ permission |
| nonce ordering | the nonce/fingerprint is prepared server-side before presentation and bound to the immutable request | the nonce is generated after presentation; the fingerprint is changed after confirmation; an old challenge is used to confirm after re-presentation | the fingerprint the user saw contains the nonce; immutable after confirmation; stale/re-presented challenges rejected |
| receipt issuance authority | a trusted confirmation callback references challenge_id; the server issues the receipt and binds it to pending | replaying the same receipt/challenge across intents; consuming a prepared challenge directly | only ledger issuance records are valid; prepared does not authorize; cross-intent replay returns approval-claimed with no effect |
| actor/tenant/principal | a tenant A actor confirms A's intent | tenant B confirms using the same idem_key/receipt; a BFF principal posed as the traveler principal | all cross-tenant/cross-principal attempts rejected; the audit sees only HMACs |
| one-time confirmation | two concurrent confirmations of the same idem_key | two processes submit the receipt simultaneously | only one `approval_claims.consumed_at`, only one `write.confirmed`, only one local effect intent |
| crash recovery | kill after the confirmation transaction, restart the worker | crash injection in three orderings: claim consumption/outbox/pending transition | no lost claim, no duplicate effect intent, no second consumption; the terminal state can fold |
| unique dispatch right (#231/#232) | two dispatchers compete for the same queued intent | two workers claim the same intent simultaneously | only one claim succeeds (`dispatch_status=dispatching`, unique `attempt_id`); the loser makes no supplier call |
| dispatch tenant boundary (#231/#232) | tenants A/B each hold a queued intent with the same `idem_key` | an A worker claims/folds/queries the B intent by `idem_key` alone | claim/fold/query are all scoped to `tenant_id + idem_key` (or a global `effect_id` with verified ownership); cross-tenant affected rows=0, supplier write=0 |
| attempt fencing ordering (#231/#232) | while the claim transaction is uncommitted the intent stays queued and can be claimed by another worker; crash (before/after the outbound call) after dispatching+attempt persistence, lease expiry | the outbound call happens before the claim is persisted; a persisted-dispatching intent is returned to queued and booked again | only an uncommitted claim transaction may return to queued; after dispatching+attempt persistence, any crash must not book/re-dispatch — uniformly unknown, folded by attempt id; lease expiry never returns to queued |
| persisted-dispatching crash with no network log (#231/#232 falsification) | — | inferring no outbound call from the absence of network logs, then booking/re-dispatching | still must not book; enter unknown/query/manual reconcile |
| lease/fencing/authorization expiry returning to queued (#231/#232 falsification) | — | lease expiry/fencing invalidation/authorization expiry returning unknown or persisted dispatching to queued and booking again | cannot return to queued; unknown keeps querying; a preflight failure means zero writes and a new intent |
| pre-dispatch re-validation (#231/#232) | quote/receipt valid, digest unchanged, routing/Buyer consistent, not revoked | calling out anyway with an expired quote/changed digest/changed routing or Buyer/revoked status; returning the old effect to queued | expired/changed/revoked and not yet called out: set the old effect to `rejected` (outbox layer) with zero writes, create a new quote/intent/receipt, and never return to queued; already-unknown keeps querying — authorization expiry never returns to queued or rebooks |
| queue/preflight local rejection layering (#231/#232 falsification) | preflight finds expiry/change/revocation before the outbound call; the old effect is undispatchable | adding `stale`/`cancelled` states to `pending_writes`; projecting undispatched expiry as supplier failed/cancel/refund | the rejection is recorded only at the outbox/dispatch/challenge layer; ADR-17 `pending_writes` keeps its `pending\|confirmed\|compensated` three states; zero supplier failure/refund projection |
| fingerprint bound to supplier payload (#231/#232) | holder/guests fulfillment fields included in the supplier payload digest | swapping the traveler or contact after presentation/confirmation and booking anyway | zero writes after a swap; a new quote/intent/receipt is required |
| lease expiry + late success (#231/#232) | the supplier creates the order late after the dispatching lease expired | inferring no side effect from lease expiry and rebooking; a late success booking a second time | exactly one booking, folded by attempt id to `reconciled_success` |
| HotelByte unknown | CLI timeout/non-json/exit0-pending fixtures | automatically retrying the same write effect or concurrently rebooking | unknown + query/manual reconcile; blind retries forbidden |
| query-orders | customerReferenceNo finds success/multiple orders; a miss within the window stays unknown | turning an in-window miss into reconciled_failed and rebooking; decoding/guessing supplierReferenceNo; unauthorized supplier penetration | project only through the authorized query surface; a miss within the recovery window does not negate the external side effect |
| cancel vs compensation | pending cancel; confirmed cancel/refund pending/refunded | writing a pending cancel as a refund; showing money refunded while compensated | copy and ledger terms stay separated consistently; confirmed compensation has a receipt/outcome |
| L4 revoke | one automatic write within policy scope, triggered again after revocation | an outbox still emitted after revoke; automatic writes beyond scope | revocation blocks the future; beyond scope downgrades to L3 |
| commission disclosure | the confirmation card includes commission/no-commission/sponsorship source | allowing forward while disclosure is unknown; a disclosure change reusing the old receipt | the disclosure digest enters the fingerprint |
| audit redaction | generate a redacted audit report | errors containing email/token/raw order id | the shareable report has no PII/secrets |

> **Dispatch falsification execution criteria**: the rows marked `(#231/#232)` above — unique dispatch right, tenant boundary, attempt fencing ordering, persisted-dispatching crash with no network log, lease/fencing/authorization expiry returning to queued, pre-dispatch re-validation, queue/preflight local rejection layering, fingerprint bound to supplier payload, and lease expiry + late success — are the minimum falsification acceptance tests that **must be run** when #231/#232 is implemented; this is currently a proposal, these tests **have not been executed**, and they must not be claimed as passed. Minimum falsification list: (1) two dispatchers competing for the same intent dispatch exactly once, and with the same `idem_key` across A/B each side can only claim/fold/query its own tenant's intent, with cross-tenant affected rows=0 and supplier write=0; (2) only an uncommitted claim transaction may return to queued — any crash after attempt persistence/before the network, or after the network/before projection (absence of network logs included) must neither blindly replay nor book, uniformly entering unknown; (3) queue/preflight local rejection means zero writes, the old effect is set to `rejected` and never returns to queued, ADR-17 `pending_writes` keeps its `pending|confirmed|compensated` three states unchanged, and no supplier failure/refund is projected; (4) changing holder/guests or the Buyer after confirmation means zero writes; (5) lease/fencing/authorization expiry cannot return unknown or persisted dispatching to queued; with an expired lease and a late supplier success there is still exactly one booking.

## 13. Handover relationships with existing designs

- `booking-saga-fsm.md` remains the authority on the saga alphabet and the edge table; this document only defines which receipt/outbox/outcome fields each edge carries when M5 is productionized.
- `effect-interpreter.md` remains the authority on effect seams; when registering write effects, a per-effect resilience policy must be added, all off by default, and read-effect retries must not be inherited.
- `transactional-state-rfc.md` remains the ADR-15 ledger foundation; this document does not change the TS-5 triggers.
- `milestone-delivery-plan.md` is the program task graph; the HotelByte adapter, agreement verification, UAT, and baseline stability debt are tracked there.
- `m6-b2b-reuse-walkthrough.md` carries the sponsor/principal disclosure and the B2B reuse accounting; M6 must not reuse the BFF security principal semantics to carry traveler motivations.

## 14. M5 Entry/Exit cross-check

**Entry requires all of the following simultaneously**:

1. M4 Exit: a real `observed_private` repeat cohort with N≥5 and a paired median planning duration reduction ≥50%; the experience reflux baseline has a real denominator.
2. Supply chain agreement: the HotelByte M5-0 matrix fields are available, especially Buyer/environment/routes, a stable order query key, offer validity, cancellation/refund/commission/after-sales fields, the manual reconciliation SLA, and the UAT boundary.

**Concrete scope required for trade testing**:

- pre-entry: only credential-free help/flag/fixture checks are allowed; no business network traffic, no OTP reading.
- post-entry sandbox/UAT: a pinned `hbcli` version, an isolated credential home, a controlled env, a fixed Buyer/route, the `--json --env=uat` prefix, fully-refundable policy constraints; any OTP operation is handled by the supplier/manual process, and GoTry never touches it.
- production: real ordering/cancellation/refund enters only after the receipt + disclosure + unknown reconcile + manual support paths have all passed their gates.

**Exit still follows the roadmap**: zero booking misoperation incidents; measured unit economics. This document does not change Exit, and sandbox passes must not substitute for real incident/unit-economics evidence.
