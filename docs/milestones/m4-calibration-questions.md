[English](m4-calibration-questions.md) | [简体中文](m4-calibration-questions.zh-CN.md)

# M4 calibration questions (2026-08-23)

> Status: frozen (historical memo, 2026-08-23)
> A quick answer sheet for you (founder): 5 questions, just answer them directly. After each answer, gotry-builder-01 absorbs it into the engine + data sources immediately.
> Source: `demo-reconciliation.md` has already mined three answers (f2/f3/f4); **only 4 questions remain for the founder**.
> How to submit: paste the answers to questions 1-5 into the "Your answers" block at the end of this file `/docs/milestones/m4-calibration-questions.md` (or just send them to me in the conversation).

---

## 1. f1 Hong Kong→Phuket (普吉岛): actual flight?

**Purpose**: calibrate the "permit duration → Hong Kong departure time window" mapping — it is the actual argument of the M-1 work-window constraint.

- (a) **CX773** 7.18 12:15 HKG→HKT 14:30 (tested)
- (b) **HX741** 7.18 20:20 HKG→HKT 23:35 (tested)
- (c) **Other** (please fill in flight number + times)

What you **actually took**: ＿＿＿＿

---

## 2. f4 Kunming→Shenzhen: actual arrival time in Shenzhen on 8.9?

**Purpose**: calibrate the `arrive_by` anchor (the model uses 21:00) — whether this anchor is too tight/too loose directly decides "home that night vs another night at Shenzhen airport".

Your **actual arrival time at Shenzhen Bao'an Airport on 8.9**: ＿＿＿＿ (format: HH:MM)

---

## 3. Which Rawai room type exactly?

**Purpose**: calibrate the "The Title" room-type dimension in `data/hotels_2026.json` — economy/standard/suite, price tiers differing 3x. When the model recommends for family trips in the future, it will match against the **price tier you actually accepted**.

`The Title East Wing Rawai` — the **room type** you booked:
- (a) Deluxe Studio (~¥300/night)
- (b) One-Bedroom Suite (~¥600/night)
- (c) Two-Bedroom Pool Villa (~¥1200+/night)
- (d) Other (please fill in)

**Actual price tier**: ＿＿＿＿ (yuan/night)

---

## 4. After EK329 landed in Shenzhen in the early morning of 8.10, when could you get home (Nanshan/Futian/Luohu etc.)?

**Purpose**: calibrate the D-6 energy model — is the 4.5h margin enough after a late-night red-eye landing? 4.5h is base cost; from **wheels-down to lying in bed** you actually add **N hours** (immigration + baggage claim + taxi/family pickup + ride home). I currently estimate N as 1.5h — but you never replied.

Your **actual EK329 7.18 landing → home** took: ＿＿＿＿ (hours)

---

## 5. Total spend breakdown (2 weeks Phuket + Yunnan + the Dubai end)?

**Purpose**: calibrate the LLM's "how much budget to set" recommendation + which candidate budgetTier (economy/comfort/convenience) matches you.

| Item | Actual spend (RMB or local currency) |
|---|---|
| Flights (2 international + 2 domestic legs) | ＿＿＿＿ |
| Stays (2 weeks: 1 Rawai main base + 1 Yunnan) | ＿＿＿＿ |
| Local transport (charter/transfers) | ＿＿＿＿ |
| Meals (rough estimate) | ＿＿＿＿ |
| Entertainment/diving/hot springs etc. | ＿＿＿＿ |
| **Total** | ＿＿＿＿ |

---

## Your answers

> Copy this block below → fill it in → commit, done. **Format is loose**: write as little as you can get away with; gotry-builder-01 will infer from whatever answers you give.

```yaml
f1_actual: ""               # (a) CX773 12:15  / (b) HX741 20:20  / (c) flight number + times
f4_szx_arrival: ""           # 8.9 HH:MM arrival at Shenzhen Bao'an Airport
rawai_room_type: ""          # (a) Studio / (b) Suite / (c) Pool Villa / (d) other
rawai_nightly_price: 0       # integer, yuan/night
szt_arrival_hours: 0         # hours used from 8.10 landing → lying in bed
total_spend_breakdown:
  flights: 0
  accommodation: 0
  ground_transport: 0
  meals: 0
  activities: 0
  total: 0                   # sum of the 5 items above; filling just this one is enough
```

## Your answers (as actually filled)

<!-- fill in answers here -->

```

```
