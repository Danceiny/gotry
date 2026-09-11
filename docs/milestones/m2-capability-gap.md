[English](m2-capability-gap.md) | [简体中文](m2-capability-gap.zh-CN.md)

# M2 data-source bridge: hotelbyte-cli command gap inventory (segment 1 output)

> Status: frozen (historical memo, 2026-08-22)
> Basis: tech-strategy §2.1 (free/open-source first) and §2 (hotel data = import + extend hotelbyte-cli, decided as G4).
> Method: cloned the hotelbyte-com/hotelbyte-cli source, enumerated the actual commands, and cross-checked them against GoTry capability-layer needs.

## 1. hbcli existing commands (vs GoTry needs)

| GoTry capability-layer need | hbcli command | Coverage | Gap note |
|---|---|---|---|
| City search | `search destinations` | ✅ full | Directly usable |
| Hotel search | `search hotel-list` | ✅ full | Directly usable |
| Hotel rates | `search hotel-rates` / `search check-avail` | ✅ full | Directly usable |
| Hotel detail | `search hotel-detail` | ✅ full | Directly usable |
| Hotel static data | `search hotels-metadata` | ✅ full | Directly usable |
| Order queries | `orders list/detail/dashboard/...` | ✅ | For the M5 transaction loop |
| **Geo mapping** | — | ❌ **gap** | POI coordinates → hotel distance matrix (data source for the engine's OfficeDistance/transfer durations) |
| Flight data | — | ❌ **gap (expected)** | hbcli is hotel-domain only; flights go through §2.1's Amadeus/aviationstack/public datasets |

## 2. Conclusion and extension plan

**The gap is smaller than expected**: all six hotel-domain capabilities already exist in hbcli, with `--json` support on every command (summarized from the source's CLI-Anything pattern). Only two real gaps:

1. **Geo-mapping command (the "command gap" in the G4 memo)** — extension direction: `search geo-mapping` (input: POI coordinate set + hotel ID set; output: distance matrix). An upstream extension, contributed back to hotelbyte-com/hotelbyte-cli.
2. **Flight data source** — outside hbcli's domain; take the free route (segment 2): Amadeus test tier (free monthly quota) → OpenFlights/OpenSky (static skeleton) → user bookedResources (real anchors).

**Implementation path for the capability-hotelbe plugin (segment 3)**: inside the dsh plugin, call `hbcli search ... --json` via subprocess; evidence fields carry `[实时API:hbcli]` + fetch time — consistent with bridge.ts's latency-metering pattern. **Prerequisite: hbcli must actually run** (needs the HotelByte API environment/credentials; without uat/prod credentials commands throw auth errors — segment 3's first step verifies whether auth can be skipped or must be mocked).

## 3. Following segments (within M2)

- Segment 2: flight free-data-source research and selection (§7-1 decision gate: founder)
- Segment 3: capability-hotelbe plugin (hbcli bridge + evidence tagging)
- Segment 4: geo-mapping command extension (contributed upstream)
