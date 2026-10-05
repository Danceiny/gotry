[English](roadmap.md) | [简体中文](roadmap.zh-CN.md)

# GoTry Roadmap

> Role: the single authority for milestone order, entry gates, exit evidence, and the current product position.
> Status: living.
> Upstream: product strategy and founder decisions recorded in [`gotry-master-outline.md`](gotry-master-outline.md).
> Downstream: delivery planning, release decisions, and milestone acceptance.
> Evidence discipline: shipped mechanisms, local proofs, real-user evidence, and business authorization are separate claims.

## TL;DR

- M0–M2 established the deterministic planning loop, agent form, and realtime evidence path.
- M3 is current. Its real seed-user evidence is still open; engineering activity does not substitute for that exit gate.
- M4 engineering may proceed in parallel, but formal M4 entry still depends on M3 exit and its own real repeat-user cohort.
- Booking Copilot is an embedded, read-action engineering line. Real four-surface inventory and unavailable-offer recovery remain open as [`architecture.md` §10 D-29](architecture.md#101-open-working-face); the tracker issue was closed as deferred on 2026-10-05 (see §1).
- M5 transaction writes remain sealed behind WriteGate and supply-chain authorization. M6 additionally requires M5 exit, founder approval, and a real pilot.

## 1. Current Position

| Surface | Current position | Authority |
|---|---|---|
| Published package | npm `latest` points to `0.0.1-rc.24`; the compatibility `rc` tag remains on `0.0.1-rc.20`. Source `main` may be ahead of both. | [`release-notes.md`](release-notes.md) and [CHANGELOG](../CHANGELOG.md) |
| Product milestone | M3 evidence is open. The web product and deterministic scorer exist; the real 50–200 seed-user outcome set does not yet satisfy the exit gate. | [#22](https://github.com/Danceiny/gotry/issues/22) |
| Evaluation | Deterministic contracts and validators exist. No official external score or uplift is claimed without an admitted, complete cohort. | [`evaluation/evaluation-foundation.md`](evaluation/evaluation-foundation.md) |
| Memory | M4 collectors and scorers are engineering support only. A real `observed_private` repeat cohort with source review remains required. | [`architecture.md` §10 D-19](architecture.md#101-open-working-face), [#20](https://github.com/Danceiny/gotry/issues/20) (closed as deferred) |
| Booking Copilot | GoTry can plan typed read actions for an existing booking workspace; `Book` remains owned by Checkout. Real inventory, recovery, Checkout, and order-state evidence remain open. | [`architecture.md` §10 D-29](architecture.md#101-open-working-face), [#142](https://github.com/Danceiny/gotry/issues/142) (closed as deferred) |
| Transactions and B2B | M5 and M6 are not admitted. Offline contracts and fixtures do not unlock supplier writes or prove a pilot. | [`architecture.md` §10 D-22 and D-33](architecture.md#101-open-working-face), [#136](https://github.com/Danceiny/gotry/issues/136) and [#137](https://github.com/Danceiny/gotry/issues/137) (closed as deferred) |

**Tracker state (2026-10-05).** The founder closed [#20](https://github.com/Danceiny/gotry/issues/20), [#136](https://github.com/Danceiny/gotry/issues/136), [#137](https://github.com/Danceiny/gotry/issues/137), and [#142](https://github.com/Danceiny/gotry/issues/142) as deferred (state: not planned): M4–M6 are not the product's core capability for now, and Booking Copilot acceptance waits for a UAT window. Closing is not acceptance — every gate in §3 and every debt row linked above stays unmet, no requirement is relaxed, and the closed issues are history, not trackers. To resume, open a new issue that links the closed one once its trigger exists: for M4 a real repeat cohort; for M5 named supply-agreement values with signing or internal-authorization evidence; for M6 M5 exit plus a founder P6 decision; for Booking Copilot an authorized UAT deploy and a logged-in Dida browser window.

Detailed current architecture belongs to [`architecture.md`](architecture.md). Per-tool contracts belong to [`tools.md`](tools.md). Per-change history belongs to git, [CHANGELOG](../CHANGELOG.md), and [`release-notes.md`](release-notes.md), not this roadmap.

## 2. Milestone Sequence

| # | Outcome | Entry | Exit evidence | Status |
|---|---|---|---|---|
| M0 | Deterministic pipeline | Product premise | Reconciled engines and a reproducible data pack | Achieved |
| M1 | Agent form | M0 | A real LLM session asks load-bearing questions and delivers a gated plan without inventing arithmetic | Achieved |
| M2 | Realtime evidence | M1 plus data-source decisions | Realtime-versus-static deltas are measurable and provenance is visible | Achieved |
| M3 | Minimal usable product | M2 plus G1 market lock | Finalization ≥40%, NPS ≥40, POI hallucination <1% across the admitted 50–200-user evidence set | Current; evidence open |
| M4 | Memory and next departure | M3 exit | Repeat planning time drops ≥50% and experience-reflux has a reviewed baseline | Parallel engineering only |
| M5 | Transaction loop | M4 exit plus supply-chain authorization | Zero booking mis-operation incidents and measured unit economics | Sealed |
| M6 | B2B packaging | M5 exit plus explicit founder approval | Frozen-kernel reuse, real agency-embedding E2E, and a signed pilot | Sealed |

The sequence is strict even when engineering work is parallel: an offline contract, fixture, or local proof can prepare a later milestone but cannot satisfy its entry or exit evidence.

## 3. Active Gates

### M3 — real product evidence

- Tracker: [#22](https://github.com/Danceiny/gotry/issues/22).
- Required: an admitted, de-identified 50–200-user evidence set and all three exit metrics.
- Rejected substitute: invitation counts, deterministic fixtures, or implementation coverage alone.

### M4 — repeat-user value

- Tracker: [#20](https://github.com/Danceiny/gotry/issues/20) — closed 2026-10-05 as deferred; the requirements below are unchanged.
- Required: a real `observed_private` repeat cohort, N≥5, paired planning-time comparison, reflux baseline, and manual source-review attestation.
- Rejected substitute: historical wish logs, candidate/synthetic exports, or scorer output without the real cohort.

### M5 — authorized transaction chain

- Tracker: [#136](https://github.com/Danceiny/gotry/issues/136) — closed 2026-10-05 as deferred; the requirements below are unchanged.
- Required before activation: M4 exit and a supply agreement or internal authorization.
- Required for exit: the actual WriteGate-controlled booking, payment, change/refund chain; commission disclosure; reconciliation; zero-misoperation and unit-economics evidence.
- Red line: no supplier write is activated by a design document, pure contract, mock CLI, or Booking Copilot read action.

### M6 — verified B2B reuse

- Tracker: [#137](https://github.com/Danceiny/gotry/issues/137) — closed 2026-10-05 as deferred; the requirements below are unchanged.
- Required before activation: M5 exit and explicit founder approval.
- Required for exit: fixed kernel-set zero diff, runtime and functional-path coverage, a real agency-embedding E2E, and a signed pilot.
- Rejected substitute: a walkthrough, unsigned intent, or loaded-LOC ratio alone.

## 4. Supporting Documents

| Concern | Document |
|---|---|
| Current system, ADRs, and open debt | [`architecture.md`](architecture.md) |
| M4–M6 dependency graph | [`design/milestone-delivery-plan.md`](design/milestone-delivery-plan.md) |
| M5 transaction authority and recovery | [`design/write-gate-production-design.md`](design/write-gate-production-design.md) |
| M6 decision material | [`milestones/m6-b2b-reuse-walkthrough.md`](milestones/m6-b2b-reuse-walkthrough.md) |
| Evaluation admission | [`evaluation/evaluation-foundation.md`](evaluation/evaluation-foundation.md) |

## 5. Legacy Model Mapping

| Legacy model | Canonical mapping |
|---|---|
| Technical Stage 0/1/2/3/4 | M0 / M1 / M2 / M4 / M6; M3 and M5 are product/business intersections |
| Outline Phase 0/1/2/3 | M0–M1 / M1–M3 / M3–M5 / M5–M6 |
| Product M1/M2/M3 | M3 / M4 / M5 |
