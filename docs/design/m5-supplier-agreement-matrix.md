[English](m5-supplier-agreement-matrix.md) | [简体中文](m5-supplier-agreement-matrix.zh-CN.md)

# M5-0 HotelByte Supply Agreement Matrix (issue #136, fillable draft)

> Role: the fillable named-value matrix behind M5 Entry component ② — every field states its semantics, who fills it, and an example format; named values stay blank until the founder and HotelByte supply them.
> Status: fillable draft (2026-10-02; all named values blank; the engineering facts in §2 are pinned read-only; a filled matrix is still not a signed agreement).
> Upstream: [milestone-delivery-plan.md](milestone-delivery-plan.md) §4 M5-0, [write-gate-production-design.md](write-gate-production-design.md) §14, issue #136 owner comments (2026-09-08/09/10 admission matrices).
> Downstream: #136 M5 Entry acceptance; after Entry the #231 → #232 → #233 implementation order; [decisions-needed.md](../decisions-needed.md) links here.

## TL;DR

- M5 Entry has two parallel components: M4 Exit (#20) and the supply agreement — this matrix is the fillable face of the second.
- Block A (agreement and authorization) and blocks C–J (Buyer/selector, route, credentials, environment, commercial fields, reconciliation SLA, UAT guardrails) each carry field/semantics/filler/example/named-value columns.
- §2 pins the read-only engineering facts the named values must not contradict (release artifact, timeouts, unknown semantics, OTP boundary).
- §5 states how a filled matrix flows into M5 Entry acceptance; unfilled cells keep the gate closed.

## 1. How to use this matrix

- Each row is one decision fact. "Filled by" states who supplies the named value: founder, HotelByte, or HotelByte proposing with founder confirmation.
- Named values are non-secret references and decisions only — never keys, passwords, or OTP material.
- Example formats are shapes, not hints at the actual value.
- Corrections to engineering facts go through issue #136 with evidence, not by editing §2 in place.

## 2. Pinned engineering facts (read-only, not fillable)

- The release artifact is npm `staicli@0.0.3` (integrity `sha512-xGzw6KBQ4r5l+CXDbU/35p2nh6ia4t7Hjh+D34IxQEgtaOOkt9iUATmxlFwcspmXCo6NuHoYFhCJ/rJ3rso5fg==`); current master is not hard-bound.
- The CLI aborts at 30s; the backend recovery window is 180s Phase1 then up to 10 minutes Phase2; a late order can be auto-cancelled; timeout/process exit/non-JSON means unknown — query first, respect the window, never rebook concurrently.
- `customerReferenceNo` is not permanently idempotent: the backend reuses in-flight/succeeded orders by Buyer+ref; the same authorization intent binds an immutable attempt.
- No `tenantEntityId` selector or `DistributorOption` exists in the current CLI/backend — the first integration fixes one authorized Buyer and one route (conservative degradation, not a rewrite of the long-term selector intent).
- UAT ONLINE Book requires a fully-refundable policy and OTP; the CLI has no OTP channel; GoTry never reads or bypasses OTP.
- exit0 does not mean success; book result.status is `verified|pending|failed`.

## 3. Block A — agreement status and authorization

| Field | Semantics | Filled by | Example format | Named value |
|---|---|---|---|---|
| A1 Agreement status | Whether a real agreement or internal authorization exists (a filled matrix is not itself signing) | founder | `signed 2026-__-__` / `internal-auth #___` / `unsigned` | ____ |
| A2 Authorizing entity and approver | Who authorized on the HotelByte side, and who approves on the GoTry side | founder | `name / role / channel` | ____ |
| A3 AK/SK reference (non-secret) | Which key pair authorizes this integration — a reference only; the secret never enters the repo | founder | `AK ref: hb-____` | ____ |
| A4 Validity and review date | How long the authorization holds and when it must be re-reviewed | founder | `2026-__-__ → 2027-__-__` | ____ |

## 4. Blocks C–J — the fields to fill

| Field | Semantics | Filled by | Example format | Named value |
|---|---|---|---|---|
| C1 Buyer identity | The single authorized Buyer the first integration fixes | HotelByte proposes, founder confirms | `buyer: ____` | ____ |
| C2 tenantEntityId selector allowlist | Whether an upstream selector exists; the allowlist of permitted tenantEntityId values | HotelByte | `allowlist: [____]` or `not available upstream` | ____ |
| C3 session-order binding | How a session binds to the order so cross-Buyer mistakes are impossible | HotelByte | `session key = ____` | ____ |
| C4 mismatch reason code | The typed code returned when a selector/binding mismatch is rejected | HotelByte | `code: ____` | ____ |
| D Distributor route | The single authorized supply route for the first integration | HotelByte proposes, founder confirms | `route: ____` | ____ |
| E Isolated credential home | Where credentials live, isolated from the user's global environment; no process.env inheritance | engineering proposes, founder approves | `dir: ____` | ____ |
| F Environment | Which environment M5 runs against, and its boundary | founder | `uat` / `prod` | ____ |
| G Route allowlist | The allowed route set; more than one route requires the upstream selector + binding + mismatch rejection (currently unavailable) | founder | `[____]` | ____ |
| H Commercial fields | Quote validity window; cancellation policy fields; refund flow; commission; after-sales responsibility — real values verified per field | HotelByte | `field=value per contract` | ____ |
| I Manual reconciliation SLA | Who reconciles unknown orders, the response window, evidence retention | founder + HotelByte | `SLA: __h / owner: ____` | ____ |
| J UAT guardrails | UAT test subjects and window; budget and order caps; revocable-switch owner; emergency stop contact | founder | `cap: ¥__ / stop: ____` | ____ |

## 5. How a filled matrix flows into M5 Entry

1. Every named value is checked against the §2 engineering facts and the real interface contract — contradictions resolve at #136 with evidence, not inside this document.
2. The signing or internal-authorization evidence (block A) is attached in #136; a filled matrix alone is not a signed agreement.
3. M5 Entry opens only when both parallel components hold: M4 Exit (#20) and this agreement; the matrix alone opens nothing.
4. After Entry, implementation follows #231 → #232 → #233; until then only design contracts, read-only discovery, deterministic fixtures, and failing tests are allowed — no business network, no OTP, no real book/cancel/refund.
5. Unfilled cells keep M5 Entry closed; fixture or sandbox evidence never substitutes.

## 6. What this matrix is not

- Not a signed agreement, and not authorization evidence by itself.
- Not a credential store: secrets, keys, and OTP material never enter this file or the repo.
- Not a runtime switch: filling cells changes no runtime path; the transaction boundary stays sealed until M5 Entry.
