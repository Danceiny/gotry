[English](round12-canary-report.md) | [简体中文](round12-canary-report.zh-CN.md)

# Round 12 frozen canary — first countable official-score run report (issue #203/#215 closure)

> Positioning: full run report of the Round 12 frozen treatment (regenerated harness, issue #203/#215 closure segment). Companion to the per-turn engineering ledger (`benchmark-environment-bridge.md` Round 12) and the Discussion #78 Round 12 comment. Status: frozen evidence, no uplift claims.

## Identity

| Field | Value |
|---|---|
| GoTry SHA | `f6e76b88fd50504a1f27056a211014f6d8125b81` |
| Case | `phase2_extended_20250322201643676309_00001` (current HF data revision; 2 days, Shenzhen→Shanghai, 1 traveler) |
| Model | `MiniMax-M3` (owner relay credential; recorded nowhere) |
| Bridge | `gotry_benchmark_environment_bridge_v4` — 21 frozen tool descriptors, closed `body_schema` projected from the official `output_schema.json` (config SHA-256 `762f4e5e4989ff0e…`) |
| Adapter | `adapter-v1` exact `gotry_benchmark_tool_result_v1` envelope (SHA-256 `e6485036ac4ef0bf…`) |
| Budgets | soft 360 s / hard 600 s; bridge timeout 30 s; max output 64 KiB |
| Result | planner exit `0`; **terminal 4840 bytes** (SHA-256 `c9d039675208b934…`); official-schema unconditional-required violations **0** |

## Official scores (pinned evaluator, b071db25 tree)

```
{MicEPR: 33.33, MacEPR: 0.0, C-LPR: 0.0, FPR: 0.0, DAV: 0.0, ATT: 0.0, DDR: 0.0, overall: 3.33}
```

First non-null official scores in twelve rounds. Single case, no matched-pair baseline — **no uplift is claimed**.

## Constraint-level findings (the actionable summary)

MicEPR 33.33 = one of three commonsense groups passed. Per-group findings:

1. **Exact-copy discipline (prices/rooms)**: the plan wrote an accommodation price (`1092`) and room count (`2`) that contradict the queried tool output, and a restaurant price (`434`) absent from the database — the model queried correctly but transcribed from inference instead of copying verbatim.
2. **Transport stage semantics**: the `goto` tool returns multi-stage metro itineraries (metro = three stages). The model collapsed segments into single-stage `walk` entries whose duration/distance contradict the tool (e.g. `12:50` vs `12:59`, 1 km vs 2.44 km). Correct behavior: copy the tool's stage list verbatim.
3. **Time-chain discipline**: hard-logic failures are chained-time violations — an activity starting before arrival transport lands, a transport departing before the previous activity ends, and an inter-position accommodation activity with an empty `transports` list.
4. **What passed**: schema structure (0 violations through the v4 closed `body_schema` gate), the first commonsense group (attraction/category structure), and intercity flight selection (real `CZ3588`/`CZ3589` from tool output).

## Next-round optimization targets

These are model-behavior failure modes, addressable at the product contract layer (persona/tooling guidance), not bridge defects: (a) verbatim-copy rule extended to prices/rooms (currently names only); (b) transport stages copied verbatim from `goto` output; (c) chained-time rule (previous end ≤ next start). Baseline pairing and sample scaling remain separate admissions.
