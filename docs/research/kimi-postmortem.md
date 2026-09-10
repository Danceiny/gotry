[English](kimi-postmortem.md) | [简体中文](kimi-postmortem.zh-CN.md)

# Kimi Trip-Conversation Postmortem: One Real Dissatisfaction, GoTry's Counterexample Textbook

> Status: frozen (postmortem teaching material, 2026-08-22)
> Source material: `data/行程细化计划.docx` (13 rounds of real dialogue between the initiator and Kimi, 2026-08).
> How to read: each failure → root cause → GoTry's corresponding mechanism. The ending carries the "ground truth extraction" (fed to P0-5 reconciliation).
> Conclusion first: **across 13 rounds the user was forced to play four roles — "calendar, constraint collector, feasibility engine, density auditor" — and every one of them is something the product should have built in.**

## 1. Failure list

### F1. Calendar year scrambled, and the "apology-refit" looped for three rounds
- Symptom: Kimi read dates on the 2025 calendar and "corrected" the user's correct 2026 weekdays into wrong ones; the user corrected it at least three times ("周四周五是工作日啊" — "Thursday and Friday are workdays!"; "8月1日是周六。。" — "August 1 is a Saturday.."; "8.1是周六。。" — "8.1 is a Saturday.."), and each time Kimi went "你说得对,完全明白!" ("You're right, completely understood!") and refit the entire plan, only to err again the next round.
- Root cause: dates were not data but text regenerated on every pass; no calendar grounding, no persistent state.
- **GoTry mechanism**: dates are first-class data (TripState/anchors); the weekday mapping is asserted once at modeling time (the golden test case does exactly this); a refit is an incremental revision, not a tear-down (D1 §5.3 versioning).

### F2. Key constraints surfaced late; no interview ever happened
- Symptom: two constraints that changed everything — **work hours UTC+4 10:00-19:00 (= Phuket 13:00-22:00, evenings not free at all)** and **the already-booked hotel (The Title Rawai 7.18-23)** — were volunteered by the user only in round 6. The previous 5 rounds of planning all rested on wrong assumptions.
- Root cause: no motivation/constraint interview; generation first, zero questions.
- **GoTry mechanism**: the "why this trip" interview is the first interface (D1 §5.1); a work-hours window is a hard-constraint type that directly shapes the daily rhythm (the time ledger in full cost §6.5).

### F3. Density illusion, seen through by the user alone
- Symptom: "曼谷3天,云南5天,这合适吗?云南各个地方的交通距离和时间你别当做不存在" ("Bangkok 3 days, Yunnan 5 days — is that reasonable? Don't treat the travel distances and times between the various places in Yunnan as nonexistent") — Kimi's Yunnan plan changed cities every day, in reality half of each day spent on the road; only after the user called it out in one sentence did Kimi patch in the "transit count / pure-play days" ledger.
- Root cause: no door-to-door accounting; the "nominal plan" and the "actual time ledger" were disconnected.
- **GoTry mechanism**: this is exactly the feasibility engine's native output — usable_hours (effective rest/play time) accounted per day, "transit days" explicitly marked, instead of being masked by a list of city names.

### F4. Missing sense of proportion
- Symptom: "云南有很多地方啊。。。曼谷才一个城市。。。。" ("Yunnan has so many places... Bangkok is just one city....") — the user questioned the city/region ratio of the time allocation; Kimi had no such perspective.
- Root cause: no "experience density" concept in the optimization objective.
- **GoTry mechanism**: the motivation spectrum determines the ratio (the weights of relationship/exploration/work); the engine prices time allocation by motivation (D1 §4.2).

### F5. The user ended up being the feasibility engine
- Symptom: "我买了8.1周六早上甲米飞曼谷的飞机票,10:25落地" ("I bought a ticket for the 8.1 Saturday-morning flight from Krabi to Bangkok, landing at 10:25") — the anchor flight segment was searched, booked, and reported to the AI by the user. The planner should have completed validation before the user committed.
- Root cause: the AI only recommended and never verified; no "solve first, then suggest" architecture.
- **GoTry mechanism**: the inverse application of WriteGate — **FlightGate**: recommendations pass the engine first (anchors/connectors/energy); the user pays only after seeing verified options.

### F6. The "right thing" appeared only in the final round, far too late
- Symptom: the final round's BKK→Kunming→Lijiang four-option comparison (arrival times / can you still explore that day / number of transfers) was high quality — door-to-door arrival state, option comparison; this is exactly what the engine does every day. But it appeared in round 13, not round 1.
- Root cause: the capability existed, the architecture did not — verification and comparison were never made the default path.
- **GoTry mechanism**: this is not a feature, it is architecture: LLM translates, solver renders the verdict, LLM explains; this table appears in round 1.

## 2. The ironic part (for fairness)

Kimi's destination research itself was not bad: the Rawai recommendation (close to Chalong pier + quiet + digital-nomad friendly) matches the independent conclusion of GoTry's data pack research; the final routing (via Kunming to Lijiang, the DR5042 every-Thursday schedule constraint) was real information. **The failure was not knowledge but architecture: no state, no interview, no verification, no incremental revision.** — a living proof of "harness engineering is the competitive edge" (master outline appendix A-5).

## 3. Ground truth extraction (→ P0-5 reconciliation input)

| Reconciliation question | Real answer (from the conversation) | demo side |
|---|---|---|
| Q6 where to stay in Phuket | **Rawai, The Title East Wing** (7.18-23, 5 nights total, then on to Krabi) | The data pack recommended Chalong/Rawai ✅ hit |
| Q7 what 万xx refers to | **Krabi (甲米)** (flew BKK from Krabi airport on 8.1) | Research ranking placed Krabi/Ao Nang first ✅ hit |
| Q3 timing for Bangkok | **Saturday morning 8.1** (KBV→BKK landing 10:25) | The gate offered this option ✅ |
| Q4 the Yunnan routing | **Lijiang Shuhe 3 nights + Dali Caicun 2 nights**, flying to Lijiang with a Kunming transfer | The demo offered two options, classic route / Dali deep-dive; reality = slow stays in two cities, closer to the "Dali deep-dive" variant △ |
| New finding | **Work hours UTC+4 10-19 (Phuket 13:00-22:00)**: online in the evenings; it dictates the daily rhythm | ⚠️ The engine does not model work windows — recorded as model gap M-1 |
| New finding | BKK→Yunnan actually went **FD582 08:10 DMK→KMG + Kunming flight to Lijiang** (DR5042 Thursday-only constraint) | The demo stopped at KMG as the endpoint △ |

**New model gap M-1 (work-window constraint)**: the work window (with timezone conversion) should become a first-class constraint of the Segment/unified model — the core variable of the workation scenario; in the Kimi conversation it overturned the entire daily rhythm. Filed on loopx.

## 4. This conversation as the Stage 1 acceptance criterion

> **Given the same opening line, GoTry should ask about work hours and booked resources and assert the 2026 calendar in round 1; deliver the engine-verified five-segment flight plan + arrival-state table in round 2; with zero calendar errors and zero "full refits" throughout.**
> The final table Kimi produced after 13 rounds and three apologies is GoTry's factory output.
