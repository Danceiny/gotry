[English](README.md) | [简体中文](README.zh-CN.md)

# Agent product-persona comparison bench: one real trip, how each AI answers

> Method: feed the founder's real trip prompt (§1, frozen verbatim text) to each AI, archive the answers verbatim, read off each product's "product persona" against the ground truth (§2) and the comparison matrix (§3), then feed the findings back into GoTry's behavior contract (§7).
> Conclusion first: **each of them hands the "travel engineer" role back to the user in its own way** — Kimi turns you into the calendar and the reviewer through apology-driven rescheduling; Fliggy (飞猪) turns you into the order-placer through flawless formatting. GoTry's differentiation is not "answering fuller", it is "answering truer": calendar anchoring, interview first, a time account on every case, and no number without a source.
> The single most valuable finding of this round (§4): **Kimi and Fliggy, two unrelated products, both landed every weekday they had to compute themselves on the 2025 calendar** — calendar grounding is a mechanism that must be productized, not model luck.

## 0. Archived entries and material scope

| Agent | Material form | Transcript | Review |
|---|---|---|---|
| Kimi (Moonshot AI) | Real 13-turn multi-turn conversation (2026-08, `data/行程细化计划.docx`) | Not archived in this format; the material itself is the postmortem | [`docs/research/kimi-postmortem.md`](../../research/kimi-postmortem.md) |
| Fliggy AI Open Platform (飞猪) | Single-turn live test (2026-09-04, prompt fed verbatim) | [`fliggy.md`](./fliggy.md) | Review in the same file |

The material is asymmetric, stated as-is: on the Kimi side the "state and incremental revision" dimension can be examined; the Fliggy side is single-turn and that dimension is recorded as n/a. Every future entry runs this prompt as a single-turn live test first; entries with real multi-turn material are labeled separately.

## 1. Standard prompt (frozen, verbatim)

> Feeding discipline: no cutting, no editing, no added context (including the typo 「感到曼谷」 — that too is a test item). The year is deliberately withheld: whether the model can anchor to 2026 is itself the first test.

```
7.17周五22:40落地深圳， 7.18早上去香港办银行开户&保险签约；然后争取7.18当天飞泰国普吉岛，跟女朋友在普吉岛见面；然后在普吉岛和附近（对岸有个万xx的海边小城听说也不错）待两周，我这两周居家办公，女朋友就在附近潜水出海游玩；然后争取周五晚上或者周六早上感到曼谷，周末在曼谷度过；然后周日或者周一飞昆明，在云南玩一周（我请假一周）。 8.9要赶到深圳，当晚，也就是8.10周一凌晨（周日晚）从深圳起飞可以在周一上班前到迪拜（机场回来直接去上班[Lol]）。  请给我做机票和酒店的行程规划和推荐。
```

Test-point annotations from the designer's perspective:

- **No year** → calendar grounding. True 2026 calendar: 7.17=Friday (user-given), 7.18=Saturday, 7.31=Friday, 8.1=Saturday, 8.9=Sunday, 8.10=Monday (user-given).
- **「周五晚上或者周六早上赶到曼谷」** ("get to Bangkok Friday night or Saturday morning") → derived anchor; correct conversion = **7.31 night / 8.1 morning**; not 8.1/8.2.
- **「居家办公两周」** ("working from home for two weeks") → the hidden skeleton of a workation is the work window (real constraint: employer time zone UTC+4, 10:00–19:00 = 13:00–22:00 in Phuket; see the Kimi postmortem M-1) — not given in the prompt, so it must be asked.
- **「跟女朋友在普吉岛见面」** ("meet my girlfriend in Phuket") → the companion is an independent passenger flow; her departure point / legs / budget are all absent from the prompt.
- **「对岸有个万xx的海边小城」** ("a seaside town called wan-xx across the water") → vague reference; ground truth = Krabi (across the Andaman Sea; Kimi postmortem §3).
- **「8.10 周一凌晨(周日晚)」** ("8.10 Monday pre-dawn (Sunday night)") → an ambiguity the user already resolved; asking it again = failing to read the brief.
- **「机场回来直接去上班 [Lol]」** ("straight to work from the airport [Lol]") → the arrival-state account of a red-eye leg (landing energy / jet lag); a real constraint under the joke.

## 2. Ground truth: the 8 items a full-score answer must address

| # | Required item | Truth / requirement | Source |
|---|---|---|---|
| G1 | Calendar assertions | Weekdays asserted on the 2026 calendar throughout; 「周五晚/周六早赶曼谷」 (Bangkok by Friday night / Saturday morning) = 7.31 night / 8.1 morning | 2026 calendar |
| G2 | Work window | A two-week workation must ask about meeting hours / employer time zone (real: UTC+4 10–19, determines the daily rhythm) | Founder's real constraint |
| G3 | Booked anchors | Must ask about existing bookings (real: Phuket leg already booked at The Title Rawai; Bangkok leg KBV→BKK self-purchased) | Kimi postmortem F2/F5 |
| G4 | Companion passenger flow | 「见面」 ("meet up") = two arrival chains; her departure point / fare unknown; budgeting as "single person" is wrong | Prompt text |
| G5 | The wan-xx reference | = Krabi; give evidence or ask; listing three candidates in parallel does not count as a hit | Real trip |
| G6 | 7.18 same-day risk | Morning bank account + signing in Hong Kong, then flying to Phuket the same day is a high-risk day: it calls for an "infeasible / high-risk" verdict with buffer design, not a casual "direct flight in the afternoon" | Common sense + banking practice |
| G7 | The Dubai red-eye account | 8.10 pre-dawn departure, landing before work on Monday, straight to work on landing: the arrival energy / jet-lag account must be computed | Prompt text |
| G8 | Entry policies | Thailand (visa-free for Chinese passports, with validity noted) + passport validity + UAE entry policy; policy statements must carry an "as of" date | Facts, must carry as-of validity |

G2/G3 are not in the prompt text — **precisely because they are not, the interview is a required item**. These 8 items double as the scorecard for every entrant below.

## 3. Comparison matrix (8 dimensions)

| Dimension | Kimi (13-turn real conversation) | Fliggy AI Open Platform (single-turn) | GoTry behavior contract |
|---|---|---|---|
| Calendar grounding | ✗ Read dates on the 2025 calendar; three user corrections, three apology-driven reschedules (F1) | ✗ Every derived weekday fell on the 2025 calendar (8.1「周五」/8.9「周六」), contradicting its own self-answered 「7.18 周六」 within the page (§4) | (2)(8)(9) + time-anchor card |
| Constraint interview | ✗ Zero questions throughout; the two constraints that change everything were spoken by the user only at turn 6 (F2) | △ Has a follow-up instinct, but asks sales-qualification questions (budget / star rating / seaside); zero hits on the G1–G8 required items; even asks back the 8.10 ambiguity the user had already resolved | (1)(10) |
| Feasibility / time account | ✗ A different Yunnan city every day, half of each day on the road — the user pointed it out personally (F3) | ✗ Hong Kong account + signing + same-day flight to Phuket with no time account at all; EK327 「约8小时」 contradicts 「02:00→次日06:00」 | (4) + door-to-door full cost |
| Fact verifiability | △ Destination research genuinely usable (Rawai recommendation / DR5042 schedule) | ✗ 「国泰/港龙」 (Cathay/Dragonair) listed as selling (Dragonair ceased operations in 2020); EK327 never verified against an anchor; all prices without source or as-of validity | (3)(7)(13)(20) |
| Structural completeness | △ A decent comparison table only emerged at turn 13 (F6) | ✓✓ Single-turn delivery of six transport legs + four-location lodging + budget + reminders; the most complete skeleton | (5) + delivery gate: completeness must come from verification |
| State and increment | ✗ After 「你说得对,完全明白!」 it scrapped the whole plan and rescheduled, then erred again the next turn | n/a (single-turn, not examined) | D1 §5.3 versioned revision |
| Commercial alignment | ○ No commercial shape | → The answer's shape = a list of sellable products; the closing questions are conversion-qualification questions | Fiduciary to the user: read-only recommendation + WriteGate |
| Risk disclosure | △ Given only when pushed | △ The reminder block (visa / WiFi / buffer) is intuitively right, but the same page sells an infeasible plan without flagging it | Verdict-style output: say "infeasible" outright |

One-line persona verdicts:

- **Kimi = a knowledgeable but stateless chatterbox**: the knowledge is real, but over 13 turns the user was forced into four roles — calendar, constraint collector, feasibility engine, density reviewer.
- **Fliggy = a perfectly formatted OTA sales guide**: what it answers is really "a person about to place an order", not "a person planning a trip" — the skeleton comes free, the accounting never arrives.
- **GoTry = the trip's trust engineer**: anchor the calendar and surface the work window at turn 1; every leg afterwards carries a time account and an evidence chain; when infeasible, say infeasible.

## 4. Best finding of this round: every weekday the two had to compute landed on the 2025 calendar

The true 2026 calendar has 8.1=Saturday and 8.9=Sunday. The derived weekdays in Fliggy's answer match the **2025** calendar one for one (2025-08-01=Friday, 2025-08-09=Saturday):

| Date | True 2026 calendar | Fliggy's answer | Nature |
|---|---|---|---|
| 7.17 | Friday | Friday ✓ | Copied from the user's words |
| 7.18 | Saturday | Saturday ✓ (self-answered in the overview) | Copied / self-answered |
| 「周五晚赶曼谷」 (Bangkok by Friday night) | **7.31 night** | 「8.1 周五晚」 (8.1, Friday night) ✗ | Derived (old calendar) |
| 「周六早赶曼谷」 (Bangkok by Saturday morning) | **8.1 morning** | 「8.2 周六早」 (8.2, Saturday morning) ✗ | Derived (old calendar) |
| 8.3 | Monday | 「周日」 (Sunday) ✗ | Derived (old calendar) |
| 8.9 | Sunday | 「周六」 (Saturday) ✗ | Derived (old calendar) |
| 8.10 | Monday | Monday ✓ | Copied from the user's words |

**Anchors given by the user were all copied correctly; anchors it had to compute were all wrong** — a date is regenerated text each time, not data. The harder one: Fliggy's overview self-answers 「7.18 周六 → 普吉」 (7.18 Saturday → Phuket), and on the same page answers 「8.1 周五晚」 (8.1, Friday night); 7.18 and 8.1 are exactly 14 days apart, so in no year can one be a Saturday and the other a Friday — **this calendar contradicts itself within the page, and it has no mechanism that could ever notice**. Kimi made the same-shaped error across turns (F1: read dates on the 2025 calendar, corrected three times).

Implications:

1. The **same-shaped failure** on two different teams, models, and product forms shows that "the old calendar in the training prior overrides unanchored date reasoning" is a systemic risk — model upgrades or prompt reminders are not a reliable fix;
2. GoTry's countermeasure is not "remind the model about the year" but turning dates into data: the time-anchor card as the sole basis — always consult the card, never self-compute (contract (2)); year-boundary assertion (contract (9)); assert once when modeling anchors, reschedule through versioned increments (D1 §5.3);
3. The harm to the user is concrete: whoever books by 「8.1 周五晚出发」 (departing Friday night 8.1) books the wrong day, and the whole Bangkok "weekend" is in fact shifted by one day.

## 5. Fliggy single-turn review (excerpts)

The full transcript and item-by-item evidence are in [`fliggy.md`](./fliggy.md). Summary:

- **Credit**: the six-leg skeleton and the trip overview delivered in one shot (highest structural completeness of the three); budget summary; reminder-block instincts (visa / jet lag / WiFi / flight buffer); Shenzhen↔Hong Kong with a multimodal comparison of cross-border bus / high-speed rail / taxi; 「凌晨航班→前一晚住宝安机场附近」 is the one sentence in the whole text closest to door-to-door thinking; Thailand visa-free for Chinese passports answered correctly with the 「2024 年起」 (since 2024) as-of qualifier.
- **Debit**: every ✗ item in the §3 matrix — calendar (§4), zero hits on G2–G4, no verdict on the high-risk 7.18 day, EK327 arithmetic self-contradiction, defunct Dragonair still on sale, prices without sources, re-asking answered questions.
- **The most "OTA sales guide" moment**: every analysis section ends at a price table, and the three closing questions are all conversion qualification (budget range / star rating / seaside or not) — everything asked is 「你准备花多少钱」 ("how much are you ready to spend"), never a single 「你几点开会」 ("what time are your meetings").

## 6. Kimi multi-turn postmortem

See [`docs/research/kimi-postmortem.md`](../../research/kimi-postmortem.md). Its conclusions, restated in this comparison-bench framework: Kimi's failure is not knowledge but architecture (stateless, no interview, no verification, no increments); the four-option comparison table it only grew at turn 13 (arrival times / can I still explore that day / transfer count) is exactly GoTry's factory output.

## 7. Feedback into the GoTry behavior contract

Checked against the 21 behavior contracts in [`cordis.gotry-patch.yml`](../../../cordis.gotry-patch.yml):

- **Items empirically proven by the bench** (competitor failures = existence proofs for these items): (1) motivation first; (2)(8)(9) the time-anchor trio; (3)(13) translation fabricates no numbers / external facts go to tools first; (4) judgment belongs to the engine; (5) open decisions become multiple-choice; (7) evidence chain; (10) never re-ask; (20) fact gate.
- **Landed (endorsed by the founder on 2026-09-04; issues [#121](https://github.com/Danceiny/gotry/issues/121)/[#122](https://github.com/Danceiny/gotry/issues/122))**:
  - **Companion passenger-flow interview → extension of contract (1)**: when a trip involves companions (meet up / converge / travel together), the companion is a second arrival chain and must be asked about in the same way — departing from where / booked already or not / own time window; once clarified, persist via `gotry_companion_save`, with arrival accounts and budget computed separately per chain;
  - **Explicit arrival-state presentation → new contract (22), the arrival account is mandatory**: for red-eye / pre-dawn departures, or legs with hard commitments on landing day, the local arrival time (including date offset), time difference, arrival energy, and a previous-night lodging suggestion must be stated explicitly — a correct timetable is not a feasible trip.
- **e2e feedback**: this prompt (§1) doubles as an e2e acceptance input, graded by §2's G1–G8 — the same stance as §4 of the Kimi postmortem: **the final table Kimi traded 13 turns for should be GoTry's factory output.**

## 8. Maintenance discipline: how to archive the next entrant

1. Feed the §1 frozen prompt verbatim, single turn, no follow-ups, no corrections (real multi-turn material is tested and labeled separately);
2. Archive the transcript at `docs/persona-bench/<agent>.md`: the header records channel / turns / collection date, the output verbatim (format-faithful), followed by the review (credit first, then debits, each item with verbatim evidence, persona verdict at the end);
3. Add a column to the §3 matrix; fold factual findings into §4; contract feedback into §7 (attach an issue trace for anything that lands);
4. Review discipline matches the Kimi postmortem: credit stated honestly (write 「讽刺的部分」 — "the ironic parts" — too), every debit backed by evidence; never write the other side weak for rhetorical effect — **the bench's output is mechanisms, not wins and losses**.
