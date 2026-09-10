[English](decisions-needed.md) | [简体中文](decisions-needed.zh-CN.md)

# Decisions Needed — Founder Decision Items Summary

> Position: the entry point for all matters that currently need a founder decision to unblock; each item includes path, context, scope of impact, and a recommendation; items are independent — reply one by one in priority order.
> Status: living (decision queue; settled items are annotated and archived in place)
> Upstream: the design/milestone documents that triggered the decisions — [`milestones/m6-b2b-reuse-walkthrough.md`](milestones/m6-b2b-reuse-walkthrough.md) (P6 walkthrough), [`design/milestone-delivery-plan.md`](design/milestone-delivery-plan.md) (M4→M6 task graph), [`design/external-event-seam.md`](design/external-event-seam.md) (D-31 seam).
> Downstream: implementation/Exit evidence advanced per receipt, and issue gate updates; a founder YES only satisfies the corresponding decision gate — it does not auto-rewrite milestone Entry.
> Items are independent — you can reply one by one in priority order; work advances per receipt.

**At a glance: 1 item currently pending — #137 P6 founder review (overall plan approval).** An explicit P6 YES still does not satisfy M6 Entry: M5 Exit remains a precondition gate, and P6 approval does not bypass M5. The entry conditions for M5 Entry are tracked in #136. D-1~D-9 and D-4a are all settled; D-31 is trigger-based (decide only when the first real world2agent callback party appears; see below) and is not currently an open runtime surface.

## Pending

### #137 P6 founder review (overall plan approval)

**Currently pending**: the founder has not yet explicitly approved the overall M6 plan or a revised draft. Only an explicit YES, or explicit approval of a revised draft, satisfies P6 Exit. **A P6 YES still does not satisfy M6 Entry** — M5 Exit remains a precondition gate, and P6 approval does not bypass M5; the two are parallel preconditions, and if either is unmet M6 does not open.
**Location**: [`milestones/m6-b2b-reuse-walkthrough.md`](milestones/m6-b2b-reuse-walkthrough.md) (draft, awaiting founder review); issue #137; task graph in [`design/milestone-delivery-plan.md`](design/milestone-delivery-plan.md) M6-1/M6-2.

### D-31 External-Event Write Trust Model

**Trigger-based**: decide only when the first real world2agent callback party appears. Local probes need no auth; remote callbacks require signature/channel binding; the remote surface stays closed until decided. Open-trigger tracking: issue #82; issue #119 is the closed design record.
**Location**: [`design/external-event-seam.md`](design/external-event-seam.md); open-trigger tracking issue #82; design record issue #119 (closed).

---

## Settled (Archived; Newly Pinned Decisions on Top)

| # | Item | Decision | Settled |
|---|---|---|---|
| D-9 | dsh-calendar distribution surface | **Not mounted by default**; mount state goes into the setup state surface (`~/.gotry/calendar.json`, `npx @danceiny/gotry setup calendar` on/off); environment variables are forbidden from controlling product behavior (founder correction 2026-09-03); doctor gains a host-plugin section | ✅ 2026-09-03 (ADR-25, run-all §50) |
| D-8 | Tool orchestration strategy | **Static flat layout + health-driven dynamic suggestions**: the tool surface stays flat, the interpreter does no hidden dispatch; when the channel health surface + verdict≠hit, a `routing` ranking table is injected into results (availability > evidence level > efficiency); persona (19) shrinks to a registry-generated fragment | ✅ 2026-09-03 (same as above) |
| D-7 | Quota ownership for quota-bearing tools | **Layered ownership**: the anonymous trial pool = the first-experience acquisition layer; formal use upgrades to user-key/user-session; the unified product key pool is deferred, to be reviewed when the M3 real cohort reaches scale; doctor gains quota probing | ✅ 2026-09-03 (same as above) |
| D-2 | M4 calibration seven questions | auto-guess 5/7 + founder supplied the remaining 4 questions (2026-08-26): f1 ~16:xx departure, 23:00 landing / f4 actual Kunming→Zhuhai + ride-share back to Shenzhen / Rawai apartment first-night failure, hotel change the next day / massage-parlor overnight after EK329; attached principle: calibration never blocks, dynamically follow motivations | ✅ ground truth absorbed into data/*.json meta.reconcil |
| D-6 | OSM fallback | **OSM plan deleted** — Anything/agent-reach already unified it; OSM is a fallback of a fallback, over-engineering; revisit at M4 scale-up depending on HBc quota | ✅ 2026-08-24 |
| D-5 | OpenSky real-time observation | keep 1 tick | ✅ |
| D-4a | agent-reach residual channels | 100% follow → wrapper-ized (reflection bridge, deleted the 13-channel switch); 8 channels need cookies (founder 0 work logged as pending; whoever has the cookies takes the channel) | ✅ 2026-08-22/23 |
| D-4 | hotel-be Anything general search integration | Option A: reuse hotel-be's existing Anything + hbcli as the unified transport | ✅ 2026-08-23 three-repo commit loop closed |
| D-3 | npm publish | Working since 2026-08-22: `@danceiny/gotry` scoped publish (the bare gotry name collides with go-try); founder enabled 2FA + recovery codes as OTP; publish commands fully isolate NPM_CONFIG_USERCONFIG | ✅ scripts/publish-npm.sh |
| D-1 | License | **MIT** | ✅ 2026-08-23 |

## Settled Details (The Three Items with Follow-Up Operational Value)

### D-2 Calibration Ground Truth (YAML Snapshot, Absorbed into the Engine)

```yaml
# f1 actual HKG→HKT flight
f1_actual: "HX741 20:20"          # (b) HX741 evening flight: flying on Kimi 7.18 same day hits the morning peak; CX773 12:15 is too tight
# f4 8.9 KMG→SZX actual arrival time
f4_szx_arrival: "22:00"             # middle value — EK328/DZ6252 cross midnight, leaving a 4h buffer for the EK329 red-eye
# Rawai room type + price tier (your long-stay + work style)
rawai_room_type: "Studio"          # (a) single-room comfort tier; not a suite
rawai_nightly_price: 400           # about ¥400/night
# 8.10 early morning: EK329 lands → into bed
szt_arrival_hours: 1.5             # SZX→Nanshan drive time (you live in Nanshan)
# 8.10 early-morning red-eye → office energy self-rating (0-100, baseline D-6 landing model)
energy_8_10: 80                    # estimate: red-eye 11h landing energy 75% + 1.5h road catch-up sleep 10% 80%; >70 counts as "feasible"
# total trip spend breakdown (2 weeks Phuket + Yunnan + Dubai round trip; Kimi 7.18-8.10)
total_spend_breakdown:
  flights_international: 4000     # SZX-HKG 1k + HKG-OMDB 1.6k + OMDB-HKT 0.5k + KMG-SZX 0.9k
  accommodation_2w: 4200          # Rawai 6 nights*¥400 + Krabi weekend 2 nights*¥600 + Yunnan 5 nights*¥300
  ground_transport: 1200           # Phuket + Krabi chartered car + Yunnan leg chartered car + airport transfers
  meals_2w: 1500
  activities_diving_hot_spring: 1000
  total: 11900                      # sum of the 4 items above (measured typical budget ≈¥12k, between the demo budget tiers ¥12.6k/¥16.3k)
```

### D-4 Architecture Chain (Verified Live)

```
dsh LLM
  └─(gotry_anything_search 工具)→ gotry capabilities/anything.ts
    └─(spawn hbcli search anything --json)─→ hotelbyte-cli
      └─(POST /api/search/anything)─→ hotel-be api/dispatcher
        └─(go-zero analyzer + @path注解)─→ search/service.Anything
          └─(混合 城市+酒店 search)─→ candidates[]
```

Landing spots: `hotel-be/search/service/geography.go` (the @path annotation exposes `/api/search/anything`), `hotelbyte-cli/src/commands/search.ts` (anything subcommand), `gotry/ts/capabilities/anything.ts` + `ts/scripts/anything-tests.ts` (5/5) + `ts/src/index.ts` tool registration. Leftovers (not blocking go-live): hotel-be `registerInternalServices` could add `SearchSrv` on the internal path (after M4 scale-up); Anything has no `lat/lng` fallback (`region.latitude` is sufficient).

### D-7/D-8/D-9 Option Records (2026-09-03; Full Design Text in `docs/design/tool-orchestration-design.md`)

- **D-7 quota ownership**: chose A, layered ownership. Rejected B (unified product key pool — three unknowns come due immediately: cost / abuse surface / upstream ToS) and C (status quo, quotas invisible). Trigger: the flyai anonymous trial shared pool hit its 429 limit (measured in the 2026-09-02 Dubai session), exposing that "quota ownership" was undefined.
- **D-8 orchestration strategy**: chose A, static flat layout + dynamic suggestions. Rejected B (interpreter-layer automatic rerouting — the model calls A but actually goes through B, breaking call auditability and overturning the ADR-18 decision record) and C (reversing the static priority — every new user pays the extension-install cost once up front). Under A, "session bridge priority" changes from a constant to a projection of the health surface: when flyai is healthy it is recommended first (zero friction); at the moment of a 429, session is promoted to first recommendation with install/login guidance attached.
- **D-9 calendar distribution**: chose A, not mounted by default. Rejected B (keep default mounting + doctor guidance — treating the symptom: the model would still hit one error first). Trigger: dsh-calendar sits inside the gotry distribution surface and, when unconfigured, the tool errors and degrades; mid-session the model hits "username not configured"; gotry's only need for calendar is reading the work window, and the persona (1) interview always asks about the work window in the first round anyway.
