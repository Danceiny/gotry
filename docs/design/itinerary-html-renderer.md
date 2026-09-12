[English](itinerary-html-renderer.md) | [简体中文](itinerary-html-renderer.zh-CN.md)

# Itinerary HTML Renderer (issue #442, parent #438)

> Role: the runtime contract, evidence discipline and rejection set of the pure itinerary HTML renderer `ts/src/itinerary-html.ts`.
> Status: proposal — internal slice (2026-09-12). The renderer is not yet called from the product chain; wiring is owned by the later integration slice of #438.
> Upstream: issue [#442](https://github.com/Danceiny/gotry/issues/442) (parent #438), `docs/design/external-event-seam.md` for the "contract first, activation later" pattern, and the fact model `ts/src/bookable-facts.ts`.
> Downstream: `ts/scripts/itinerary-html-tests.ts`, and the future caller that loads the fact registry and writes the HTML artifact.

## 1. Contract

The renderer is a pure, bounded function: no IO, no service, no `Date.now`, no subprocess, no Markdown parsing, no arithmetic.

```ts
renderItineraryHtml(input: unknown):
  | { ok: true; html: string }
  | { ok: false; errors: string[] }
```

Input carries a title, an explicit itinerary (`trip_start` / `trip_end` / `stays` / `od_segments`) and the facts the **caller** selected from the registry. The renderer never queries upstream. Output is one self-contained HTML document: inline CSS, semantic navigation anchors, native `details`/`summary` disclosure, no script and no remote resource of any kind.

## 2. Two planes, never merged

- **Plan plane** — the user's scheduling intent (`stays`, `od_segments`). Cards are labelled as plan, not as bookable.
- **Evidence plane** — `BookableFact` records, each rendered with its own `bookability`, `EvidenceTier`, `source`, `query_id`, `fetched_at` and `as_of`.

Consequences that the code enforces structurally, not by prose alone:

- A planned stay card shows the plan fields plus a pointer to the independently recorded hotel facts; hotel facts are rendered in a separate "destination-level hotel facts" block. A stay is linked only to facts whose destination and both dates match exactly — evidence for another window stays independent. A destination + date-range inventory hit therefore can never be read as "this chosen hotel has a room".
- No overall verified badge exists. A weak tier (`route_exists`, `historical_schedule`, `benchmark_price`) or an `unverified` / `conflict` / `unavailable_exact_date` state is labelled as such and never upgraded.
- Missing price, missing time and missing evidence stay missing; nothing is invented and no cross-currency total is produced.

## 3. Decision log

- **Why no Markdown back-parsing**: the planning model must come from an explicit structure. Reconstructing a planning model from rendered text is exactly the failure mode the fact gate exists to stop.
- **Why no nights/budget arithmetic here**: the evaluate authority already owns that arithmetic. Any second implementation would drift from it silently; the renderer's own fields for those concerns are not accepted at all.
- **Why invalid input fails instead of being skipped**: silently dropping a stay or a segment yields a document that looks complete but is not. A rejected render is recoverable; a quietly truncated itinerary is not.
- **Why no fact anchors (`fact:<id>`) in the HTML**: those anchors belong to the Markdown artifact gate. Embedding them would make a whole HTML file parse as anchor-bearing rows; the fact id is shown as visible text instead.
- **Why no browser-side interactivity**: script-free disclosure keeps the artifact inert in every host that renders it, including plain previews.

## 4. Bounded input, bounded output

Rejected with an explicit error: unknown/missing fields, wrong types, unsupported `mode` / `bookability` / `tier` / `verdict` / fact `schema`, impossible calendar dates (month length and leap years are checked, not just the shape), malformed ISO timestamps, non-finite or out-of-range numbers, oversized arrays and oversized strings, inverted trip windows, zero-night stays, and a rendered document above the byte cap. Error text never echoes the offending input back.

## 5. Slice status

Landed here: the module, its focused test suite and this document. Still open for #438: product wiring, the artifact path, browser E2E of navigation/disclosure/narrow-screen/escaping, the six state surfaces and the bilingual status sync, and a root review of the integrated chain. This renderer's static fixtures are not supplier evidence and do not stand in for a real inventory check.
