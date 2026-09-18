[English](round12-canary-report.md) | [简体中文](round12-canary-report.zh-CN.md)

# Round 12 frozen canary — first countable official-score run report (issues #203/#215)

> What this is: the evaluation summary of the Round 12 frozen canary — what we ran, what came back, why the score looks the way it does, and what to fix next. Hashes and the full config manifest stay in the [engineering ledger](benchmark-environment-bridge.md) Round 12; this report is the readable account.

## TL;DR

We rebuilt the benchmark harness on the v4 bridge, ran one frozen canary case end-to-end with `MiniMax-M3`, and for the first time in twelve rounds the official evaluator actually scored the plan: **overall 3.33 / 100** (schema ✅, commonsense ⅓, logic 0). The score is low by design of the scorer — and the failure list is exactly the to-do list for the next round: the model must copy prices, transport stages, and times verbatim from tool output instead of improvising them.

## What ran

One frozen case (Shenzhen → Shanghai, 2 days, 1 traveler; current HF data revision) through the full GoTry child on main: v4 bridge config (21 frozen tool descriptors + closed terminal `body_schema`), v1-envelope adapter, `MiniMax-M3` via the owner relay, soft/hard budgets 360/600 s. The agent explored the environment through the bridge (tools → calls) and emitted one `<output>` plan. Full identity is recorded in the [ledger Round 12](benchmark-environment-bridge.md); nothing here is recreated from memory.

## What came back

- Planner exited 0; the terminal plan was **4,840 bytes, structurally perfect** — zero violations against the official schema's unconditional-required keys. The Round 12 gate did its job: 12 rounds of "evaluator never entered" ended here.
- Official scores: **overall 3.33**, MicEPR 33.33 (1 of 3 commonsense groups passed), C-LPR 0, FPR 0, DAV/ATT/DDR 0.

## Why the score looks like this (per-constraint findings)

The scorer found three failure families. None of them are bridge defects — they are model transcription/hygiene behaviors, which means they are fixable at the product contract layer:

1. **Improvised prices and rooms.** The plan wrote an accommodation price of 1092 with 2 rooms where the tool data says otherwise, and a restaurant price of 434 that does not exist in the database. The model queried the right things, then typed numbers from its own prior instead of copying the tool output.
2. **Collapsed transport stages.** The `goto` tool returns metro itineraries as three-stage trips; the plan rewrote them as single-stage walks with a duration of 20 min where the tool says 29 min and a distance of 1 km where the tool says 2.44 km. Every mismatch is the model editing tool data.
3. **Broken time chain and a teleporting hotel.** Day-2 activity/transport times don't chain (a transport departs before the previous activity ends), the arrival flight lands at 09:30 but the plan starts the day at 07:00 in the wrong city, and one accommodation activity carries an empty `transports` list.

What passed: the entire v4 structural gate, the first commonsense group (attraction/category structure), and real intercity flight selection (CZ3588/CZ3589 taken from tool output).

## Next round's targets (product contract layer)

(a) extend the verbatim-copy rule from names to **prices and room counts**; (b) **transport stages copied verbatim** from `goto` output (never re-derived); (c) a **chained-time rule** (previous end ≤ next start, arrival before first activity). These are persona/tooling-guidance changes with the same test-and-PR loop as #192/#2. Baseline pairing and sample scaling remain separate admissions.
