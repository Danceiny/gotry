[English](itinerary-html-renderer.md) | [简体中文](itinerary-html-renderer.zh-CN.md)

# Itinerary HTML Renderer (issue #442, parent #438)

> Role: the runtime contract, evidence discipline and rejection set of the pure itinerary HTML renderer `ts/src/itinerary-html.ts`, plus the product generation entry `ts/capabilities/itinerary-artifact.ts` that feeds it.
> Status: internal slice (2026-09-12). The renderer is now reachable from a real product path (registered tool `gotry_itinerary_render` → one new HTML file in the session working directory). Native HTML preview proof is accepted on #448, persistent regression lives in `ts/scripts/dsh-artifact-web-e2e.ts` (re-runnable: `GOTRY_ARTIFACT_WEB_E2E_OUT=<dir> npx tsx ts/scripts/dsh-artifact-web-e2e.ts`); the registered Lavish browser feedback chain is covered by #443 CLOSED + PR #456 merged acceptance.
> Upstream: issue [#442](https://github.com/Danceiny/gotry/issues/442) (parent #438), `docs/design/external-event-seam.md` for the "contract first, activation later" pattern, and the fact model `ts/src/bookable-facts.ts`.
> Downstream: `ts/scripts/itinerary-html-tests.ts`, `ts/scripts/itinerary-artifact-tests.ts`, and the artifact list/read journey that revisits the generated file.

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

## 5. Product generation entry

The registered tool `gotry_itinerary_render` (`ts/capabilities/itinerary-artifact.ts`) is the only product path that writes an itinerary document. Call shape: `title`, the explicit `itinerary` object (same shape as the renderer's, no nights/budget fields) and `fact_ids` (required string array, empty allowed), plus an optional `basename`.

- **Facts come only from the registry.** The tool never accepts caller-supplied fact objects, does not read Markdown, and does not guess facts. Selected ids are resolved against the current `config.stateRoot` fact log (`loadFactRegistry`); unknown, duplicate and over-limit ids are rejected, and a malformed registered row is rejected by the renderer's runtime validation instead of being quietly dropped.
- **Empty `fact_ids` is a legitimate input** and renders an explicitly unverified plan: the document states the missing evidence and carries no overall verified badge; only per-fact bookability/tier/source labels exist.
- **One new file, never an overwrite.** The target is the canonicalized session working directory top level; a basename must match `gotry-itinerary-<ASCII token>.html` (no separators, no `..`), otherwise a crypto-random name is generated. The session working directory must be **explicitly provided and absolute**: a missing, empty, whitespace-only or relative cwd fails closed in the tool boundary and again in the capability — there is deliberately no fallback to the process cwd, because a guessed landing spot is how a document ends up in an unrelated directory. The host-provided path is used **verbatim**: whitespace is inspected only to decide whether the value is empty, and never normalized — a trailing space can be part of a real directory name, and trimming it would redirect the write to a same-named sibling. The file is created with `O_CREAT|O_EXCL` (`wx`), so an existing file and a symlink pointing elsewhere both fail instead of being followed or replaced; `.git`/`node_modules` directories are refused. Writes land only in the session working directory — never in `stateRoot`.
- **Failure means zero bytes written.** Invalid input, unregistered ids, a rejected render, a taken basename and a refused directory all return structured errors before any file is opened. The result returns the final real path of the written file; the work is local document generation only — no booking, payment or supplier write.
- **Revisit journey.** The generated `.html` is discovered and read through `gotry_artifacts_list` / `gotry_artifacts_read` (source-card text view). The host's own native HTML preview is a separate UI surface with its own sandbox behavior and is not claimed here.

## 6. Slice status

Landed here: the renderer, the generation entry (registered tool + run-all §6c suites), the real-browser coverage (navigation, native details and Return-keyboard, narrow-screen readability, escaping) and this document. Native HTML preview sandbox acceptance = #448 proof accepted with persistent regression in `ts/scripts/dsh-artifact-web-e2e.ts` (re-runnable: `GOTRY_ARTIFACT_WEB_E2E_OUT=<dir> npx tsx ts/scripts/dsh-artifact-web-e2e.ts`); the registered Lavish browser feedback chain = #443 CLOSED + PR #456 merged acceptance; the generated-document browser coverage is closed by #442 CLOSED + PR #449 merged acceptance. The generated document is a projection of caller-supplied structure plus registered facts — its fixtures are not supplier evidence and do not stand in for a real inventory check.
