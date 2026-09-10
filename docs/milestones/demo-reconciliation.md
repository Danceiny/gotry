[English](demo-reconciliation.md) | [简体中文](demo-reconciliation.zh-CN.md)

# Demo Reconciliation (P0-5)

> Status: frozen (historical memo, 2026-08-27)
> Reconciliation = demo output vs the real trip. Ground truth comes from two sources: the task brief itself (§1) and
> the initiator's original Kimi conversation (`data/行程细化计划.docx`, postmortem in `../research/kimi-postmortem.md`).
> Reconciliation is not a scoring ritual: every difference must be attributed to one of "data error / model gap / product gap".

## 1. Mutually corroborated points (no questions needed)

| # | Demo side | Real side | Conclusion |
|---|---|---|---|
| 1 | 7.17 is a Friday, 8.01 a Saturday, 8.09 a Sunday, 8.10 a Monday (2026 calendar) | The brief's exact words "7.17 Friday", "8.10 Monday" | ✅ Calendar fully matches; the replay scenario holds |
| 2 | EK328 (DXB 11:00→SZX 22:40) matches the brief's "lands in Shenzhen at 22:40" exactly | The initiator's workplace is Dubai | ✅ The entry leg is the return direction of Emirates' Shenzhen line; choosing EK329 for the return is the natural closure of the same route |
| 3 | The engine verdict on the 8.10 early-morning red-eye: "feasible with 4.5h margin" | The brief's tone "[Lol]" — it really happened and the person involved saw it as feasible | ✅ Direction agrees; awaiting real-experience detail to calibrate the energy model (does 75% match felt energy) |
| 4 | For "fly to Phuket (普吉岛) on 7.18 itself" the engine produced a tight-but-feasible path (CX773, leaving Hong Kong Island at 12:15) | Brief: "try to fly on 7.18 itself" | ⏳ The wording "try to" implies uncertainty existed at the time — permit duration is the key variable; awaiting the real permit-processing time |
| 5 | Stay research: Chalong/Rawai = digital-nomad zone + dive pier, a double match; recommended as main base | Kimi conversation: actually booked **The Title East Wing Rawai** (7.18-23) | ✅ **Hit** (area level) |
| 6 | 万xx research ranking: Krabi Ao Nang > Khao Lak (Similan closed) > Trang | Kimi conversation: flew to Bangkok from **Krabi** airport on 8.1 | ✅ **Hit** (research first preference = real choice) |
| 7 | Gate q3 was **deterministically answered** by the M-1 work window: all Friday evening flights excluded, only Saturday-morning VZ303 left | Kimi conversation: "I bought a ticket for **Krabi to Bangkok on Saturday morning, Aug 1**, landing 10:25" | ✅ **Model hit and consistent with reality** — one rule answered what burned Kimi three rounds |
| 8 | Gate q4 offered two options: classic loop / Dali in depth | Kimi conversation: actual = 3 nights in Shuhe, Lijiang (丽江) + 2 nights in Caicun, Dali (大理) (slow two-city stay) | △ Right direction (slow stay); granularity to absorb: the two-city slow stay should become the default recommendation for workation-style Yunnan |

## 2. Question list awaiting the initiator (each maps to a model/product calibration point)

~~Answered 3/6/7/8 (see §1 rows 5-8; ground truth from the Kimi conversation)~~. Remaining:

**Flight legs (2 questions; 2 more mined from the conversation)**:
1. Which flight did f1 actually take? (CX773 14:45 / HX741 20:20 / other) — calibrates the "permit duration → departure time" mapping
2. f4 Kunming→Shenzhen: what time did it actually reach Shenzhen on 8.9? (calibrates whether the arrive_by anchor at 21:00 is too loose or too tight)

Already mined (conversation round 12+):
- ✅ **f3 answer**: **8.4 Tuesday FD582 DMK 08:10→KMG 11:25 + connection Kunming→Lijiang** (the direction adopted after Kimi's final-round four-option comparison) — the demo's MU6088 8.3 option was the backup; the real choice came a day later (leave started only on 8.4)
- ✅ **f2 origin**: departed 8.1 from **Krabi (Ao Nang)** — the two-week 『万xx』 relocation actually meant 3 nights in Ao Nang (weekend mode)

**Stays (0 questions, all mined)**:
- ✅ Rawai The Title 7.18-23 (5 nights) → continued stay through 8.1 (Rawai base, including a "weekend relocation" pattern of two Krabi trips of 2 nights each across 2 weekends, not a full move) — the demo's "main base + mid-trip relocation" prediction hit structurally

**Spend and felt experience (2 questions)**:
6. Rough range of the total actual spend? (checks the hit rate of the tiered budget ¥12.6k/¥16.3k)
7. Real felt experience of the 8.10 Dubai landing and heading straight to the office (self-rated energy 0-100)? (calibrates red-eye sleep model D-6)

## 2 (supplement): auto-guess answers (absorbed 2026-08-24; founder corrections apply immediately)

| Question | auto-guess | Basis | Status |
|---|---|---|---|
| f1 actual flight | **HX741 20:20** | Evening flight; Kimi flew on 7.18 itself + morning rush hour, CX773 12:15 too tight | Entered flights_2026 f1.evidence |
| f4 SZX arrival | **≈22:00** | Midpoint of MU6088/DZ6252; leaves a 4h buffer for the EK329 red-eye | Entered f4.evidence |
| Rawai room type | **Studio ≈¥400/night** | Long stay + work-oriented; not a suite | Entered yunnan-pack meta.reconcil |
| EK329 landing→home | **≈1.5h** | SZX→Nanshan drive (D-6 energy model landing-leg convention) | Entered f5.evidence |
| 8.10 energy (0-100) | **80** | 11h red-eye landing at 75% + 1.5h nap en route ≈ +10% | Entered the engine.ts energy table |
| Total spend | **≈¥11.9k** | Flights ¥4k + 2-week stays ¥4.2k + transfers ¥1.2k + meals ¥1.5k + diving/hot springs ¥1k; falls inside the demo's budget tier ¥12.6k | Entered the f1/f4/f5.evidence breakdown |
| Remaining 2 questions (spend detail) | **Never asked; no real answer needed** | demo-reconciliation will not press; founder corrections apply immediately | — |

Correction method: edit any line of the D-2 auto-guess YAML in `docs/decisions-needed.md` + commit; gotry-builder-01 rewrites the data pack from the revised values.

## 3. Three destinations after reconciliation (pre-registered)

- **Data error** → fix the data pack (schedules/prices); model untouched;
- **Model gap** → record an ADR and evaluate whether it enters the engine (e.g., permit-duration distribution, monsoon-season go-to-sea rate);
- **Product gap** → into loopx todo (e.g., meet-up planning for two people arriving at different airports, modeling the girlfriend's independent itinerary).

## Status

Ground truth for 4 questions has been extracted from the Kimi conversation into §1; **the remaining 7 questions are blocked on the initiator's input**. Once answers arrive, attribute each one and update this document and the data pack.

## Reconciliation endgame (2026-08-26)

All seven ground-truth values absorbed (founder provided the remaining four on 2026-08-26; see the final meta.reconcil entries in data/flights_2026.json and data/yunnan-pack.json):
- f1: actually departed ~16:xx and landed HKT 23:00 (metro to the Hong Kong airport at 13:xx fits well)
- f4: actually Kunming→Zhuhai (never been; wanted to see it for half a day), returned to Shenzhen by ride-hail since luggage was inconvenient
- Rawai: the apartment's first night failed (property unreachable / key not found / poor condition); switching to an ordinary hotel the next day was better across the board
- After EK329: no lodging in Shenzhen; spent the night at a massage parlor (better value and comfort than a hotel)

**Principle settled (-founder instruction)**: none of these are blocking issues — the system should dynamically follow the motivations and purposes discovered in the user's chat; for open choices like flight number or room type, the agent offers persuasive options instead of asking outward.
