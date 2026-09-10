[English](m2-flight-data-options.md) | [简体中文](m2-flight-data-options.zh-CN.md)

# M2 segment 2: flight free-data-source recommendation (§7-1 decision-gate material)

> Status: frozen (historical memo, 2026-08-22)
> Key fact (2026-08 research): **Amadeus Self-Service shut down on 2026-07-17** (new registrations suspended earlier; only the Enterprise portal remains) — the first candidate listed in tech-strategy §2.1 is dead, and this memo re-ranks accordingly.

## 1. Candidate comparison (free tiers)

| Data source | Free quota | Coverage | Limits | Fit for GoTry |
|---|---|---|---|---|
| **OpenSky Network** | 4,000 credits/day, open source | Real-time ADS-B tracks | No fares/schedule tables; answers "where the aircraft is", not "which flights exist" | Verification source: confirm a flight actually operated (the [实时API] tag in the engine's evidence chain) |
| **aviationstack** | 100 requests/month | Real-time schedules + history + routes | Free tier is plain-text HTTP; tiny volume | Supplementary sampling: real schedule samples (use the 100/month sparingly) |
| **OpenFlights** | Full static database download | Airports/airlines/routes/aircraft | No times, no prices | **Skeleton layer**: city-pair reachability (legitimacy check for the engine's candidate set) |
| User bookedResources | Unlimited | User's already-ticketed itineraries | Must be provided by the user | **Anchor source**: real schedules + prices (zero cost, high fidelity) |
| Hand-curated static pack (current state) | — | Gold-standard use cases | Requires manual effort | Baseline maintained |

## 2. Recommendation (presented to §7-1)

**Three-layer combo, all free, zero new code dependencies** (data enters the capability layer via the CLI/JSON bridge, consistent with ADR-3's bridge convergence):

1. **Skeleton layer = OpenFlights static pack** (one-time import into the data/ layer; city-pair reachability checks);
2. **Anchor layer = user bookedResources** (the field already exists in the contract; accumulates naturally once M3 seed users start);
3. **Verification layer = OpenSky (primary, ample volume) + aviationstack (small monthly samples)** — evidence chain tagged [实时API:opensky/aviationstack].

**Explicitly not doing**: fare aggregation (Skyscanner/Kiwi etc. are all commercially licensed) — during M2, prices continue as static-pack estimates + explicit tags; resolved with supply-chain agreements at the M5 transaction loop.

## 3. Segment 3 landing order if the founder approves

T3-1 capability-hotelbe (hbcli bridge; all six hotel capabilities in place) → T3-2 opensky verification bridge (single-file script, not inside the plugin) → T3-3 OpenFlights static pack import, with reachability checks wired into the engine's candidate set.

Sources: [PhocusWire: Amadeus self-service shutdown](https://www.phocuswire.com/amadeus-shut-down-self-service-apis-portal-developers), [Amadeus for Developers](https://developers.amadeus.com/), [aviationstack pricing](https://aviationstack.com/pricing), [OpenSky API](https://opensky-network.org/data/api), [Thunderbit comparison](https://thunderbit.com/blog/best-flight-api-with-free-tiers), [Geekflare](https://geekflare.com/dev/flight-data-api/)
