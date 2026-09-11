[English](s1-walkthrough.md) | [简体中文](s1-walkthrough.zh-CN.md)

# S1 contract walkthrough conclusions (self-check version, for the founder's one-minute confirmation)

> Status: frozen (historical memo, 2026-08-22)
> Walkthrough method: not a paper review — the contract was used twice in real combat (the M1 exit MiniMax-M2 three-round replay `bb880f3`, and a real dsh runtime end-to-end `68ea364`); each walkthrough point below is answered with combat evidence.

## Walkthrough point ①: Gate allows only multiple-choice

- **Contract**: `Gate = { id, question, options[≥2], answer? }` — `options` is an array; structurally there is no place for free text.
- **Combat evidence**: in replay round 3, the budget gate rendered as "Economy (save money…) / Comfort (office quality…) / Convenience-first (least time)" — each of the three options carries its trade-off; the third of the async deliverable's four no-disappointment items (`all pending questions are simple multiple-choice gates`) is asserted in `collectDeepPlanning` as `g.options.length >= 2`, and both deliveries passed 4/4.
- **Conclusion**: ✅ holds. Type constraint + runtime assertion, two-layer guarantee.

## Walkthrough point ②: workWindow must carry evidence

- **Contract**: `WorkWindowProfile.evidence: string` (a non-optional field, no `?`).
- **Combat evidence**: in replay round 2 the user said "work hours UTC+4 10:00-19:00" → both mock and real LLM persisted `evidence: 'user verbatim: my work hours are 10am to 7pm UTC+4'`; the work-window exclusion reason cites this source in rendering ("work window (local 13:00-22:00)" traces back through the conversion chain: 10:00 UTC+4 + (420−240)min = 13:00). **Note**: the plugin tool `gotry_motivation_save` throws when evidence is missing (the P0 anti-hallucination red line) — the same discipline exists in pairs on the contracts and plugin sides.
- **Conclusion**: ✅ holds. Required field + consumer-side throw, double insurance.
- **Known boundary**: the contract's type layer cannot enforce "evidence must be user verbatim" (it can rely only on LLM extraction discipline and the plugin's throw) — same family of problems as the ADR-10 validation gate; accept this boundary and rely on replay fixtures for regression.

## Walkthrough point ③: spec_extract's three-way assumption classification

- **Contract**: `SpecAssumption.source: 'user-verbatim' | 'inferred' | 'default'`.
- **Combat evidence**: after ADR-10 landed, `extractSpec`'s skeleton JSON system prompt requires "anchors only for what the user explicitly said or what is necessary"; in the dsh E2E, the M2-extracted skeleton anchors (arriveBy etc.) all came from the itinerary's original text; assumption classification is annotated field by field in `extractFacts`' return value (`assumptions: [{field, source: 'user-verbatim'}]`). **inferred/default have no runtime instances to date** — an honest gap: the three-way type surface is complete, but only the first class has ever been exercised at runtime.
- **Conclusion**: ✅ types hold; ⚠️ runtime coverage incomplete (inferred/default not combat-tested). Recommendation: before M3 seed users, add a replay case of "the user didn't say enough and inference is needed" (e.g., budget tier inferred as comfort from "somewhere comfortable to stay").

## Overall conclusion

**Recommendation: S1 freeze approved.** All three walkthrough points have type + combat two-layer evidence; the only runtime coverage gap (③'s inferred/default) does not block the freeze — it is a test-coverage issue, not a contract-design issue; file it as an M3 prerequisite.

**The founder only needs one line back**: "S1 freeze approved", or point out any walkthrough point that fails.
