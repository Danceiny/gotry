[English](p6-founder-decision-brief.md) | [简体中文](p6-founder-decision-brief.zh-CN.md)

# P6 Founder Decision Brief (issue #137, M6-2)

> Role: the one-page decision face for the P6 founder review — what P6 is, the two hard M6 Entry prerequisites and their current state, the plan essentials, the risks, and the exact questions awaiting a founder answer; decision support only, never a decision receipt.
> Status: decision-ready (2026-10-02; this brief only assembles open questions — nothing inside is decided; P6 Exit still rests on the founder's explicit words in issue #137).
> Upstream: [milestones/m6-b2b-reuse-walkthrough.md](../milestones/m6-b2b-reuse-walkthrough.md) (the P6 draft), [milestone-delivery-plan.md](milestone-delivery-plan.md) M6-1..M6-5, [roadmap.md](../roadmap.md) M6 row, issue #137 owner comments (2026-09-08/09/10).
> Downstream: the founder replies in issue #137; [decisions-needed.md](../decisions-needed.md) archives the #137 item on receipt; #234 coverage-caliber freezing and #235 activation gating read the outcome.

## TL;DR

- P6 is the founder review gate of the M6 B2B reuse walkthrough; P6 Exit = an explicit `YES` approving the overall plan, or explicit approval of a revised draft — an engineering draft never substitutes.
- M6 Entry has two parallel hard prerequisites: M5 Exit (issue #136) and P6 founder approval. Both are currently unmet; a P6 YES does not bypass M5.
- Plan essentials: travel-agency embedding primary + destination tourism board secondary; three isolated principals; only three plugin slots as the change surface; reuse proven by a fixed frozen kernel-set zero-diff plus two separate coverage reports.
- The open questions the founder should answer (plus the overall YES) are listed in §5 with yes/no/revise reply slots; §6 states what starts immediately after approval.

## 1. What P6 is

- Master outline P6 row (§3.7): pick 1–2 B2B forms and walk through the two-layers-of-why wrapping and the reuse boundary, red lines carried throughout.
- P6 Exit: the walkthrough memo passes founder review — an explicit YES, or explicit approval of a revised draft. NO or proposed changes keep it TODO; nobody but the founder freezes it.
- The memo under review: [m6-b2b-reuse-walkthrough.md](../milestones/m6-b2b-reuse-walkthrough.md), draft, in main since PR #249 (merge 293bbb6).

## 2. The two hard M6 Entry prerequisites and their current state

| Prerequisite | Tracked in | Current state |
|---|---|---|
| M5 Exit | #136 | Not met. M5 Entry itself needs M4 Exit (#20 real `observed_private` N≥5 repeat cohort + reflux baseline — TODO) and the HotelByte supply agreement M5-0 (no signing/internal-authorization evidence obtained). The M5 transaction runtime stays sealed. |
| P6 founder approval | #137 (M6-2) | Not met. No explicit founder YES or approved revised draft is recorded; the walkthrough memo stays draft. |

- The two are parallel: either unmet keeps M6 sealed. P6 approval completing first only shortens the wait; it opens no implementation.
- In-repo pre-entry assets (already in main, sealed at the runtime boundary): #231 WriteGate/outbox core, #232/#233 adapter and cancel/refund contracts, #234 kernel manifest + import-trace proof tooling, #235 sponsor plugin contract + default-off fixtures, tenant isolation base (#229/#237/#236/#241).

## 3. The P6 plan in brief

1. Two B2B forms: travel-agency embedding (primary, matching the M6 engineering proof and pilot form) + destination tourism board (secondary, existing to falsify agency-specific design of the plugin slots).
2. Three isolated principals: traveler principal (the motivation subject) / sponsor (the commercial and inventory layer) / BFF `BookingIngressPrincipal` (ADR-23 security identity); namespaces `traveler.*` and `sponsor.*`; sponsor goals never enter MotivationProfile.
3. The only change surface is three plugin slots: entry, inventory pool, sponsor configuration/disclosure; the reuse seam single point is MotivationProfile + hard constraints; "zero kernel change" is exactly the hypothesis the proof must hold.
4. Reuse proof caliber: fixed frozen `kernel-set` zero-diff + runtime actually-loaded coverage + pre-declared functional-path coverage, reported separately; the loaded LOC ratio is auxiliary only; the "99% reuse" slogan is replaced by this measured caliber.
5. Sponsor revenue disclosure: preferred as plugin-injected rendered fragments, the kernel keeps zero sponsor semantics; the disclosure digest enters the request fingerprint.
6. M6 Exit splits in two: the engineering half (zero-diff + both coverage reports + agency-embedding E2E) and the commercial half (a real signed pilot, M6-5, sales/legal — engineering never signs on the founder's behalf).

## 4. Risks the founder should weigh

| Risk | What it means | Where tracked |
|---|---|---|
| Plugin slots are hypotheses | No sponsor type, configuration, inventory interface, disclosure slot, or B2B E2E exists yet; three-slot completeness stays unproven until the secondary form runs | walkthrough §0/§3 |
| Engineering metrics are not outcomes | Zero kernel diff and coverage prove "kernel untouched", not traveler satisfaction, NPS, or sponsor conversion | walkthrough §4 |
| Approved-but-sealed window | P6 YES before M5 Exit leaves an interval where nothing may activate; parallel engineering must not reverse-infer gate opening | #137 owner comments |
| Commercial pilot unsigned | The unsigned status only explains why M6 stays TODO; it can never satisfy M6 Exit | M6-5 |
| Disclosure slot undecided | If M5 forces a schema reservation first, the kernel gains sponsor semantics — exactly the dependency the plan avoids | open question Q2 |

## 5. Decision questions awaiting the founder

Advisory defaults restate the walkthrough memo's lean; none is a decision. Reply per item: `YES` / `NO` / `Change to: ____`.

| # | Question | Advisory default (not decided) | Founder reply |
|---|---|---|---|
| Q1 | Approve the overall plan boundary set (walkthrough §8)? | the memo awaits exactly this YES | ____ |
| Q2 | Disclosure slot placement: plugin-injected rendered fragments (kernel zero sponsor-awareness), schema reservation only if M5 forces it? | plugin injection | ____ |
| Q3 | Keep the destination tourism board as the secondary form (falsifies agency-specific slot design)? | keep | ____ |
| Q4 | Adopt the measured reuse caliber (frozen kernel-set zero-diff + two coverage reports + LOC auxiliary) replacing the "99%" slogan? | adopt | ____ |
| Q5 | Split M6 Exit into the engineering half and the commercial half (real signed pilot)? | split | ____ |
| Q6 | (M6-5, commercial dependency, not a P6 Exit condition) Named pilot subject and scope, when available | none yet | ____ |

## 6. First steps after approval

1. Record the receipt in #137 (the YES itself or the approved revised draft); [decisions-needed.md](../decisions-needed.md) moves #137 to settled; only then may the walkthrough memo turn `frozen(date)`.
2. Under #234, freeze `kernel-set.txt` and the two coverage calibers — explicitly allowed before M5 Exit per the #137 owner comments (2026-09-09); LOC stays auxiliary.
3. #235 stays Entry-gated: real sponsor activation waits for M5 Exit + P6; contract, fixture, and failing-test refinement may continue.
4. The M5 lane is unchanged and remains the critical path: #136 M5-0 named values + #20 M4 Exit. No M6 implementation starts on a P6 YES alone.

## 7. What this brief is not

- Not a decision receipt: nothing here satisfies P6 Exit; only the founder's explicit words in #137 do.
- Not a gate rewrite: M6 Entry stays M5 Exit + P6 approval; this brief adds no condition and removes none.
- Not a pilot substitute: commercial terms and signing live in M6-5 with the founder and sales/legal.
