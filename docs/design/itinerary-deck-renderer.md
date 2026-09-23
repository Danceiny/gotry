[English](itinerary-deck-renderer.md) | [简体中文](itinerary-deck-renderer.zh-CN.md)

# Itinerary Deck Renderer (issue #564)

> Role: the runtime contract, deterministic slide derivation, and decision log of the pure deck renderer `ts/src/itinerary-deck.ts`, plus the shared document-contract layer `ts/src/itinerary-doc-shared.ts` that both projections build on.
> Status: internal slice (2026-09-23). The renderer is a pure function with no product entry yet — no registered tool writes deck files in this slice; the product path, static export, and QR belong to later slices of issue #564.
> Upstream: issue #564; borrowing decision #1 of [karpo-deck-web research](../research/karpo-deck-web-research.md); contract vocabulary inherited from [itinerary-html-renderer.md](itinerary-html-renderer.md).
> Downstream: `ts/scripts/itinerary-deck-tests.ts` (run-all §6d); future deck product-entry / static-export slices; design-system seeds for later phases.

## TL;DR

- `renderItineraryDeck(input: unknown)` renders one self-contained slide-deck HTML from the same explicit itinerary + registered facts as the single-page document — another projection, not another implementation.
- The contract is identical to `renderItineraryHtml`: pure, bounded, fail-closed, zero script, no remote resource, no arithmetic, and the same shared 2 MiB byte cap.
- Slides are **deterministically derived, never caller-composed**: cover → by-date → one slide per segment → one per stay → hotel evidence → policy (only when policy facts exist) → evidence appendix → all flight/train facts.
- Paging is pure CSS scroll-snap (`y proximity`) with CSS-counter page numbers; the scripted-deck question (research decision point D-2) is resolved as zero-script — no ADR exception is opened.
- Single source of truth: input validation, fact normalization, fact cards, and two-plane prose live in `itinerary-doc-shared.ts`; a drift-lock test asserts both projections reject the same malformed input with byte-identical error arrays.

## 1. Contract

```ts
renderItineraryDeck(input: unknown):
  | { ok: true; html: string }
  | { ok: false; errors: string[] }
```

`input` carries a title, an explicit itinerary (`trip_start` / `trip_end` / `stays` / `od_segments`), and the facts the **caller** selected from the registry — the same shape the single-page renderer accepts. The renderer never queries upstream, never reads a clock, never parses Markdown, and performs no nights/budget/time arithmetic. Output is one self-contained HTML document: inline CSS, zero `<script>`, zero remote resources, plus deck layout (scroll-snap slides, sticky anchor nav, print page-breaks).

## 2. Two planes, never merged (inherited, not re-stated)

The plan plane (explicit stays/segments) and the evidence plane (registered `BookableFact` records with tier/bookability/source/query_id/fetched_at/as_of) are the same two planes as the single-page document, rendered by the same shared functions. A destination + date-range inventory hit can never be read as "this chosen hotel has a room"; no overall verified badge exists; missing price, missing time, and missing evidence stay missing. The deck is a layout change, not a semantic one.

## 3. Deterministic page derivation (the deck spec)

The slide list is a fixed projection of the normalized input — there is no caller-composable `slides` field:

| Order | Slide | Presence |
|---|---|---|
| 1 | Cover: title, trip window, two-plane statement, evidence-boundary notice, fact counts | always |
| 2 | By-date index (stays by check-in, segments by departure date; no calendar days are synthesized) | always |
| 3.. | One slide per `od_segment` (plan card + its route+date-matched facts, negatives kept) | per segment |
| .. | One slide per stay (plan card + exact-window hotel-fact pointers) | per stay |
| .. | Hotel evidence: destination-level hotel facts, independently titled | always (explicit empty state) |
| .. | Policy facts + policy note | only when policy facts exist |
| .. | Evidence appendix: facts no planned entry matched (own empty state) | always |
| .. | All flight/train facts (incl. negatives and conflicts, explicit empty state) | always |

The deck nav is group-level anchor links that shrink with the derivation (no links to non-existent slides); per-segment/per-stay navigation is the by-date page's job, same as the single-page TOC.

## 4. Decision log

- **Why slides are derived, not caller-composed**: a composable `slides` field would move composition authority to the caller and re-open the plan/evidence merge risk at the deck layer; derivation keeps composition inside the deterministic projection. The page list is therefore fixed vocabulary, like the renderer's enum sets.
- **Why zero script (research D-2)**: the single-page inert-HTML contract (renders safely in any host, including plain previews) transfers unchanged. Scroll-snap paging, page numbers (CSS counters), and per-slide print page-breaks all work without a single `<script>`; no scripted-deck ADR exception is needed.
- **Why scroll-snap `proximity`, not `mandatory`**: a slide taller than the viewport must not trap the reader mid-scroll; `proximity` keeps snap behavior without making long evidence slides unnavigable.
- **Why CSS-counter page numbers**: page numbers are layout, not data; counters keep them automatic without script, and tests assert the counter CSS rather than baked per-page text.
- **Why one shared byte cap and one LIMITS table**: a deck that allowed itself more bytes than the single-page document would reward re-shaping data to the roomier format; the cap is a property of the document family, so it lives in the shared layer.
- **Why the evidence-boundary notice wording unified to "本文档"**: the shared `EVIDENCE_BOUNDARY_NOTICE` is used by both projections verbatim; the deck is one document, so the cover says "本文档". This is the only deliberate wording change to the single-page output in this slice (the pinned test substrings were unchanged).
- **Why print page-breaks**: the deck prints as one page per slide — a zero-cost "print to PDF" path until a real export slice exists.

## 5. Shared contract layer (`ts/src/itinerary-doc-shared.ts`)

Validation primitives, fact normalization, fact cards, plan cards, evidence sections, date-index and leftover composition, the two-plane prose, and the base component CSS moved verbatim from `itinerary-html.ts`. Rationale: any second implementation of the same validation or prose would drift silently — the same reasoning the renderer design already applied to arithmetic. `itinerary-html.ts` re-exports `ITINERARY_HTML_LIMITS` / `ItineraryHtmlInput` / `ItineraryHtmlResult`, so existing consumers (`itinerary-artifact.ts`, existing suites) are untouched; only the §6 source-purity test widened to cover both modules.

## 6. Rejection set and anti-drift lock

Every rejection of the single-page renderer is the deck's rejection, byte for byte: both entries call the same `normalizeDocInput` and the same `docBytesError`. The deck suite pins this with a drift-lock — for each malformed-input case (bad dates, bad enums, bad fact schemas, inverted windows, zero-night stays, missing flight numbers, noisy input with error caps), the two `errors` arrays must be `JSON.stringify`-identical, and both must flip `ok` together. Any future validator change that touches one projection but not the other fails the gate by construction.

## 7. Slice status and explicit non-claims

Landed here: the shared layer, the deck renderer, the deterministic deck suite (163 assertions, run-all §6d), and the widened source-purity checks. Not in this slice: a registered product entry writing deck files, static export/deploy, QR, any runtime activation, and any share/consent surface — all later slices of issue #564. The deck renders only caller-supplied structure plus registry-selected facts; its fixtures are synthetic and stand for no supplier evidence.