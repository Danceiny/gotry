[English](karpo-deck-web-research.md) | [简体中文](karpo-deck-web-research.zh-CN.md)

# Karpo Deck Web Reference Study → gotry Finished-Product Borrowing Decisions (2026-09-22)

> Status: frozen (competitive reference study, 2026-09-22).
> Subject: **karpo-deck-web.vercel.app** — a deployed Next.js/Vercel pitch-deck site for "Karpo", a proactive-AI lifestyle and
> experience-discovery product (observed deck content names: MachinePulse platform, a Karpo app, iMessage integration, proactive
> place/event recommendations from user preferences and context, a QR CTA, Instagram/X brand presence, a Singapore + North America team).
> This document answers only: **which "finished-product" capabilities gotry should borrow or fill, in what shape, up to which milestone,
> and which it explicitly does not borrow**. All conclusions map to existing seams (itinerary HTML renderer contract, external-event seam,
> wish pool, channel registry, consent precedent). No implementation is proposed here; this document opens no issue and commits to no runtime.
> Source discipline: primary = the site's own rendered content, fetched once on 2026-09-21 (asset inventory and link graph observed;
> a JS-rendered SPA read through its server-rendered text and asset paths — docs, pricing, login, app internals, and recommendation
> provenance were not observable); secondary = web search (no independent coverage found: no public repository, no press). Observed facts
> and inferences are labeled; the category reading ("proactive AI lifestyle") is the site's own positioning language, not a verified vendor claim.

**Prior judgment**: karpo sells the feeling; gotry sells the truth. karpo's deck validates one category fact — an AI consumer product can be
made **visually consumable, shareable, and proactively triggered**. gotry's distance from that class of product feel is not the kernel; it is
four missing product faces (deck rendering, sharing, proactive triggering, storefront) plus a design system. Every borrowing below is constrained
by "do not dilute evidence discipline": the fact gate, the sealed WriteGate, and the privacy rules stay untouched.

## TL;DR

- **What was observed**: an 11-page webp slide deck served through Next.js Image on Vercel, closing with a QR CTA into iMessage; positioning as
  "proactive AI lifestyle" with a MachinePulse platform, an app, and Instagram/X brand surfaces.
- **What it proves for gotry**: product polish is a render/share/trigger/storefront problem, not a kernel problem — gotry already owns every seam
  needed to extend into those faces.
- **Six borrow decisions**: an itinerary deck renderer inheriting the `itinerary-html.ts` contract; static export + QR; outbound notification
  adapters as the dual of the channel registry; a proactive wish-pool feed activating the external-event seam's own landing sequence; a
  "Why we built GoTry" landing deck plus a fixture-driven `gotry try` demo; a shared design system with image cards.
- **Four anti-borrows**: unprovenanced proactive push, hidden technology, iMessage-only channeling, platform-first narrative before M3 exit.
- **Milestone discipline is unchanged**: phases A–C are new read-only surfaces that may serve the open M3 exit; proactive triggering (phase D)
  is M4 engineering and activates no runtime during the M3 evidence period. `roadmap.md` stays the sole timeline authority.
- **Six open decision points** are candidates for the founder decision queue; this document opens no issue and commits to no implementation.

## Decision summary table

| # | karpo surface (observed) | gotry decision | Landing point / seam |
|---|---|---|---|
| 1 | Slide-deck site: 11 webp pages through Next.js Image on Vercel | **Borrow the form** (deck renderer proposal; no code now) | Inherit the pure-renderer contract of `ts/src/itinerary-html.ts` (see [`itinerary-html-renderer.md`](../design/itinerary-html-renderer.md)); a typed deck spec between the unified model and rendering; the plan/evidence two-plane split preserved at spec level |
| 2 | QR CTA closing the deck (into iMessage) | **Borrow the form; gate the reach** | Static self-contained export + QR is a render-layer extension; sharing itself needs a one-time consent card extending the `session-consent.ts` precedent; de-identified by construction (registry facts only) |
| 3 | "MachinePulse" proactive platform + app | **Borrow the direction only; no new runtime** | The external-event seam already owns this vocabulary — "consume existing seams; build no new runtime" ([`external-event-seam.md`](../design/external-event-seam.md)); its segments 1–2 have landed (local probe + wish-pool consumer), the remaining producer is trigger-gated; a proactive wish-pool feed is that seam's own M4-shaped activation, not a new platform |
| 4 | iMessage integration | **Borrow the channel family, not the channel** | Outbound notification adapters as the dual of `channel-registry.ts` / `channel-health.ts` (inbound data sources vs outbound delivery faces); default-off, consent-carded, quiet-hours built in |
| 5 | Instagram/X brand presence | **Partially borrow** (image-card pipeline) | Seed from existing demo SVG assets and the bilingual + dark/light asset precedents; one design system consumed by deck, cards, and landing |
| 6 | "Why we built Karpo" single-page narrative | **Borrow the storefront shape** | "Why we built GoTry" exists as prose in [`gotry-product-design.md`](../gotry-product-design.md) (tourism vs travel, §2; the three differentiators, §1); a landing deck + fixture-driven `gotry try` are zero-kernel surfaces — the pure renderer is offline-demonstrable |
| 7 | Proactive recommendations without visible provenance | **Explicitly not borrowed** | Every proactive push must carry a why-now trigger explanation and a source tag; otherwise do not push (fact-gate red line) |
| 8 | Technology hidden behind lifestyle copy | **Explicitly not borrowed** | Determinism is the brand: the 4.4% → 93%+ feasibility contrast (product design §1) is hero-slide material, not a secret |
| 9 | Platform narrative shipped ahead of public evidence | **Explicitly not borrowed before M3 exit** | `roadmap.md` M3 gate: engineering activity does not substitute for the 50–200-user evidence set; an honest "we are verifying" progress card is stronger than a platform story |

## What the reference is (observation record, 2026-09-21)

Primary observation of [karpo-deck-web.vercel.app](https://karpo-deck-web.vercel.app/) (single fetch; SPA content read from server-rendered text and the asset inventory):

| Observation | Detail |
|---|---|
| Deployment | Vercel (Next.js `/_next/image` pipeline; deployment id `dpl_HYwhfQEVbeTY9Gbif6imo5VgSqWJ` observed) |
| Deck form | 11 slide images, `/images/page-01.webp` … `/images/page-11.webp` |
| Positioning language | "proactive AI lifestyle"; experience discovery "personal and effortless" (paraphrased from rendered content) |
| Named surfaces | MachinePulse platform; Karpo app; iMessage integration; proactive place/event recommendations from preferences and context |
| Outbound links | `karpo.ai`, `instagram.com/karpo.ai`, `x.com/Karpo_AI`, several Instagram reels |
| Closing CTA | QR code to text Karpo (into iMessage) |
| Team signal | Singapore and North America |
| Not observable | docs, pricing, login, source repository, recommendation provenance, app internals |

Secondary search found no independent coverage — no public repository and no press; the product is known here only through its own deck.

**Category fact extracted** (inference, labeled as such): an AI consumer product can be shipped as *visually consumable + shareable + proactively
triggered*. That fact — not karpo's domain (lifestyle discovery, adjacent to but different from gotry's travel planning) — is what this document borrows.

## Per-dimension borrowing decisions

### 1. Itinerary → shareable deck (borrow; render-layer extension, no kernel)

The renderer seam is already frozen in contract form ([`itinerary-html-renderer.md`](../design/itinerary-html-renderer.md)): `renderItineraryHtml` is a
pure bounded function — no IO, no clock, no subprocess, no Markdown back-parsing, **no arithmetic**; inline CSS, zero script, no remote resource;
the plan plane and the evidence plane never merge; oversized or malformed input fails closed.

A deck is the same contract with a page structure: a typed **deck spec** (page enumeration, per-page component types, evidence-badge slots) between the
unified model and rendering, with the two-plane split enforced at spec level so a deck page can never upgrade plan into bookable. The product entry
follows the `itinerary-artifact.ts` pattern: registry-selected facts only, one new file, `O_CREAT|O_EXCL`, failure writes zero bytes.

Why this is first: it serves the open M3 exit — seed users get a showable artifact (a finalization and NPS surface) — and the pure renderer makes a
fixture-driven offline demo possible for the storefront.

### 2. Static export + QR (borrow the form; sharing consent-gated)

The deck output is already self-contained by contract; static export + QR is packaging, not a new runtime. The privacy stance transfers unchanged:
no hosted backend in this phase, no secret leaves the machine, and the shared artifact renders only registry facts. Sharing itself extends the
consent-card precedent (`session-consent.ts`: once per session, refusal revokes, master switch) — a shared deck is de-identified by construction.

### 3. Proactive wish-pool feed (borrow the direction; M4 engineering, seam-owned)

The seam design already wrote the rule: **consume existing seams; build no new runtime** ([`external-event-seam.md`](../design/external-event-seam.md)).
Its landing sequence has segments 1–2 landed (the local channel probe as a cron-driven read-only tick, and the wish-pool consumer); the remaining w2a
sensor producer is trigger-gated under issue #82. A proactive "next-departure feed" is that seam's own M4-shaped activation: a tick evaluates
wish-pool recall conditions, and every push carries **why-now + source tag** — proactive with provenance, the thing karpo's deck does not show and
gotry's fact gate requires.

Milestone discipline: the M3 evidence period does no proactive push (the `roadmap.md` M3/M4 gates are unchanged); a one-tap "Yes, plan it"
deep-links back into the local session and touches no write path — the WriteGate stays sealed.

### 4. Outbound notification adapters (borrow the family, not iMessage)

gotry's channel system is inbound today (data sources and their health). An outbound face is its dual: adapters (iMessage, SMS, Slack, webhook)
behind one consent gate, default-off, quiet-hours built in, failures bounded and silent-retried. iMessage is the first candidate adapter because
karpo demonstrated the pattern, not because it is the only channel.

### 5. Storefront: landing deck + `gotry try` (borrow; zero kernel)

- "Why we built GoTry": the narrative exists as prose in [`gotry-product-design.md`](../gotry-product-design.md); a landing deck is that prose
  re-rendered — bilingual by the doc-pair discipline, static on any host.
- Benchmark contrast cards: the persona-bench comparison is README material today; three side-by-side cards ("generic assistant / OTA agent /
  GoTry") render it for non-technical readers.
- `gotry try`: a fixed fixture → the pure deck renderer → an embedded static demo; no npm install, no network, no LLM key — possible precisely
  because the renderer is a pure function.
- M3 progress card: "we are verifying, evidence open" — honest status as a brand surface, in the roadmap's own gate language.

### 6. Trust as a visible surface (borrow a form karpo lacks)

gotry's structural trust is already product-grade material: evidence badges (source tags are render-layer-owned today), the no-write promise card
(the WriteGate sealed status rendered as "we will not book or pay for you"), "I don't know" cards (fact-gate blocks rendered as guidance, not
silence), and commission-disclosure slots (product design §1 mechanism; rendered as "we currently earn nothing" before M5).

## Anti-borrow list

| # | karpo practice | Why gotry does not borrow |
|---|---|---|
| 1 | Proactive push without visible provenance | The fact gate never lets an untraceable claim ship as verified; a push without why-now + source tag is exactly that, in notification form |
| 2 | Technology hidden behind lifestyle copy | Deterministic feasibility is the differentiator (product design §1: 4.4% → 93%+); hiding it would erase the moat |
| 3 | iMessage as the single integration channel | gotry's channel vocabulary is a registry, not a single integration; outbound adapters ship as a family |
| 4 | Platform narrative shipped ahead of public evidence | The M3 exit gate is a real 50–200-user evidence set (`roadmap.md`); "we are verifying" beats "we are a platform" |

## Sequencing proposal (candidate; authority stays with the roadmap)

| Phase | Content | Kernel touched? | Milestone fit |
|---|---|---|---|
| A | `gotry try` 离线 demo fixture(#571):固定合成行程 + 空 fact_ids → `renderItineraryDeck` → tmpdir 落盘 + stdout 路径/字节/幻灯数;零安装零 LLM key 零 dsh 主机 | No — new surfaces only | 服务 M3 种子用户漏斗 |
| B | Deck spec + deck renderer (inherits the `itinerary-html.ts` contract) + static export + QR (#569 real matrix via `qrcode` npm) | No — render-layer extension | M3 |
| C | Share consent card + token + outbound adapters (issue #573, slice-1: 4 no-op adapter stubs + HMAC token + consent state machine + shareDeck orchestration; M4 slices replace stubs + add dsh tool registration) | No — read-only delivery faces | M3→M4 |
| D | Recall trigger contract layer (issue #577: tick source + 5-class RecallReason evaluator + why-now card with mandatory source tag; PeriodicTickSource default-off; no push, no mutation — M4 wires the seam's producer) | Seam activation only, per the external-event seam's own gating | M4 engineering |
| E | One-tap deep-link back into the local session; hosted sharing service (a separate decision) | No write path; WriteGate untouched | M4+ |

Every phase follows the repo's existing patterns: contract first, activation later; one PR per slice; bilingual pairs in the same commit; red tests never merge.

## Open decision points (candidates for the founder decision queue)

1. Deployment shape for sharing: static-only first (recommended here) vs a hosted read-only service as a separate milestone-level decision.
2. Zero-script deck contract: keep the inert-HTML contract with CSS-only paging (recommended) vs an explicit scripted-deck ADR exception.
3. Outbound consent model: default-off, one-time card, quiet-hours built in — a stronger restraint default than the inbound precedent.
4. Proactive milestone attribution: confirm phases D–E stay M4 engineering until the M3 exit gate is met.
5. Landing repo home: `web/site/` inside this repo (reuses the bilingual and CI discipline) vs a separate repo for release decoupling.
6. Hosted-atom boundary: if a hosted surface ever needs city-search or hotel-static atoms, reuse hotel-be per product design §0; gotry does not build a second stack.

## References

- Primary: [karpo-deck-web.vercel.app](https://karpo-deck-web.vercel.app/), fetched 2026-09-21 — rendered content and asset inventory as recorded above; single fetch.
- [`docs/design/itinerary-html-renderer.md`](../design/itinerary-html-renderer.md) — the renderer contract this study proposes to inherit.
- [`docs/design/external-event-seam.md`](../design/external-event-seam.md) — the seam authority for the proactive direction.
- [`docs/roadmap.md`](../roadmap.md) — sole timeline authority; milestone gates referenced throughout.
- [`docs/gotry-product-design.md`](../gotry-product-design.md) — mission, tourism-vs-travel narrative, transparency mechanism.
- [`docs/architecture.md`](../architecture.md) — ADR index and documentation authority for any adoption.