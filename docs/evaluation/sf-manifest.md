[English](sf-manifest.md) | [简体中文](sf-manifest.zh-CN.md)

# sf-01..08 frozen manifest — case list, channels, and live-session requirements (issue #272 offline segment)

> Positioning: the frozen v1 manifest of the 8 session-flight benchmark cases, consolidating `ts/data/sf-golden-manifest.json` (scoring golden), the RFC P3.6–P3.8 evidence trail, and the per-case channel/live-session classification. Status: frozen v1 (2026-09-18); cases are added/changed only via a new manifest revision.

## Frozen case table (from `ts/data/sf-golden-manifest.json`, threshold 0.9)

| Case | Route | Date | Known flights (substring match) | Price band (CNY) |
|---|---|---|---|---|
| sf-01 | 上海 → 丽江 | 2026-10-01 | HO5577, MU6145, 9C8779 | 800–4000 |
| sf-02 | 北京 → 大理 | 2026-10-02 | CA1441, MU5712, 3U8831 | 800–4500 |
| sf-03 | 上海 → 三亚 | 2026-11-11 | 9C8779, MU5377, HU7177, CZ6766 | 500–3000 |
| sf-04 | 广州 → 昆明 | 2026-12-20 | CZ3497, MU5738, 3U8805, 8L9628 | 400–2500 |
| sf-05 | 深圳 → 成都 | 2026-10-05 | CZ3453, MU5402, CA4314, 3U8744 | 400–2500 |
| sf-06 | 杭州 → 厦门 | 2026-10-06 | GJ7153, MU5520, CZ6955 | 300–2000 |
| sf-07 | 西安 → 桂林 | 2026-10-07 | JD5143, MU2176, CZ6319 | 400–2500 |
| sf-08 | 重庆 → 贵阳 | 2026-10-08 | G52667, CZ5817, MU2146, GY7122 | 250–1800 |

Scoring contract: hard fields (`query_id`/`from`/`to`/`currency`/`source`/`verdict`) exact; soft fields ±60 min time / ±15 % price band / flight-number substring.

## Channel matrix — what needs an authorized live browser session

| Channel | Needs live login? | Covers | Status |
|---|---|---|---|
| manual golden (`--golden` default, `sf-golden-manifest.json`) | **no** | all 8, offline scoring comparator | ✅ frozen (P3.7) |
| static golden (`--golden=static`, OpenFlights fixed revision + estimated bands) | **no** | all 8, route/carrier + estimated schedules | ✅ frozen (P3.8) |
| session-benchmark offline fixtures (`session-benchmark.ts`) | **no** | sf-01 fixture self-test | ✅ met |
| session adapter **live** (Ctrip logged-in via extension bridge) | **YES — explicitly authorized live browser session** | real verdicts for all 8 | ⏳ awaiting: one-time extension install + logged-in state (P3.6 gate) |
| flyai comparator (`--golden=flyai`) | no (official key; quota-gated) | all 8 (sf-07/sf-08 historically flyai hits) | ✅ exercised (trial-limit risk noted) |

**Classification summary**: all 8 cases are fully offline-regression-coverable (manual/static golden + offline fixtures) — no live session is needed for regression protection. The only item that requires an explicitly authorized live browser session is the **real-session dual-source batch rerun** (the P3.6/P3.7 "awaiting logged-in state" gate), which additionally needs a one-time extension install by the user; risk-control trigger count must stay 0 during such runs (RFC §3.5 red line).

## Evidence status (already banked)

- **P3.6 local live test**: 8 queries, 7/8 verdict=hit, 6/6 manual-golden soft hits at 100 % (sf-01 MU6145 ¥3240 7.9 s … sf-08 miss 25 s flyai); ReadGuard 8/8 zero writes; challenge 0/8.
- **P3.7 dual-source**: flyai trial-limit → pluggable golden shipped; batch reruns await logged-in state.
- **P3.8 static lifecycle**: two consecutive logged-in 8-query rounds, official 8/8 hit both times, scorable hits 13/13 = 100 %.

Evidence files live owner-locally under `~/.gotry/evidence/session/sf-XX/<ts>.json`; `sf-summary.ts` rebuilds the unified rollup. No cookie values or personal itinerary data enter git/issues.
