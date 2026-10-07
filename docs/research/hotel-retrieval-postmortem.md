[English](hotel-retrieval-postmortem.md) | [简体中文](hotel-retrieval-postmortem.zh-CN.md)

# Hotel Retrieval Session Postmortem

> Role: diagnose missing hotel quotes in the exported session and record the evidence boundary of the repair.
> Status: frozen(2026-10-07).
> Upstream: [architecture](../architecture.md), [data sources](../data-sources.md).
> Downstream: hotel retrieval regressions and the native HotelByte configuration flow.
> Sources: the private session export, read-only supplier calls, and official hotel pages. The export and credentials are not committed.

## 1. Conclusions

The session did not establish that Changchun or Harbin had no rooms. It confused failed observations with empty inventory and then blocked an independent hotel provider after flight failures.

| Fault | Evidence | Repair |
|---|---|---|
| hbcli failure reported as realtime zero inventory | The session's hotel tools reported zero hotels. A read-only replay returned business code `300010002` with process exit zero: no available suppliers configured. The wrapper previously counted a missing list as zero. | Reject business errors and invalid hotel-list shapes. Preserve failure evidence and expose other hotel channels. |
| FlyAI hotels blocked by flight failures | The session opened the shared `FLYAI_SEARCH` breaker after flight failures; hotel requests were then declined without reaching the provider. A current direct hotel request returned six priced Changchun entries. | Scope breakers by business kind. Flight protection remains active while hotels can execute independently. |
| Valid FlyAI quotes rejected by an optional rating | A current Harbin response contained nine named, priced hotels; one homestay had `star: " "`, causing the parser to reject all nine. | Normalize blank star text to an absent rating. Keep every valid quote and retain strict types and core-field validation. |
| Ctrip timeout blamed on hotel sniffing | The 8000ms timeout belongs to the cookie-name login precheck; hotel sniffing has a separate timeout. | Identify the job kind and whether it was queued or claimed. Heartbeats alone do not prove job completion. |
| Ctrip failed observations could become negative hotel facts | Empty bodies, malformed JSON, unrecognized responses, and sniff timeouts previously fell through to a successful miss. | Fail closed. Only a recognized empty hotel array without a failure envelope or unparsed entries produces a miss. |
| Harbin could not resolve a hotel entry URL | The city table omitted Harbin; the official list page confirms city ID `5`. | Add the verified ID and lock exact stay dates and occupancy in regression. |

The native configuration page now exposes HotelByte alongside FlyAI. HotelByte App Key and App Secret use confidential fields and the official `openapi:uat` credential-file entry. Validation uses a disposable credential root; unrelated auth modes and environments are preserved. A supplier-configuration error has its own visible state and cannot become a successful inventory check.

## 2. Live Price Evidence

Observed on 2026-10-07. Each official list page visibly showed the requested dates, one room, two adults, and zero children. These are displayed starting prices, not final room offers, stay totals, or booking confirmation.

| Destination | Stay | Hotel | Displayed starting price |
|---|---|---|---|
| Changchun | 2026-12-05 → 2026-12-08 | 全季酒店（长春新天地长春大街店） | CNY 252 |
| Changchun | 2026-12-05 → 2026-12-08 | 长春生态广场希尔顿欢朋酒店 | CNY 389 |
| Harbin | 2026-12-09 → 2026-12-11 | 建国璞隐酒店（哈尔滨中央大街公路大桥地铁站店） | CNY 272 |
| Harbin | 2026-12-09 → 2026-12-11 | 曼哈顿大酒店（哈尔滨中央大街索菲亚广场店） | CNY 238 |

On the current code, the registered `gotry_flyai_search` tool confirmed six Changchun entries for 2026-12-05 → 2026-12-08 with evidence `[实时API:flyai@2026-10-07T09:52:35.050Z] 6/6 hotel options`. This verifies the current provider path; it does not retroactively prove the historical session's credential scope or offer availability.

After the rating repair, the registered tool returned all nine Harbin entries for 2026-12-09 → 2026-12-11, including 哈尔滨中央大街索菲亚美居酒店 at CNY 546 and 哈尔滨悦枫酒店（中央大街地铁站店） at CNY 136. Its evidence was `[实时API:flyai@2026-10-07T09:50:27.529Z] 9/9 hotel options`. Both tests used isolated state roots and synthetic upstream flight faults to open the flight breaker; each real hotel query succeeded while that breaker stayed open. These remain hotel-list prices, not verified room offers or stay totals.

## 3. Verification and Remaining Boundaries

The regression suite exercises the registered hotel tool, real CLI process boundaries with fixtures, the production interpreter, the session collector, and actual HTTP bridge queues. It distinguishes business errors, invalid lists, recognized empty lists, challenges, and queued/claimed timeouts. Native setup tests exercise verification, cancellation, concurrent changes, confidential errors, credential preservation, and supplier status.

These isolated tests do not constitute a live extension search. The installed extension had a current heartbeat, but the historical login-precheck timeout's exact transport failure remains unconfirmed. No extension error was visible to the user. The repair makes future failures diagnosable without claiming a restored extension round trip.

The current hbcli account still requires supplier provisioning by HotelByte. GoTry cannot manufacture inventory by changing its local credentials. The GUI links to the official sandbox application guide and explains this state. The existing running Web process must load the new code before it can show the new interface; no npm release is implied by this source change.

No booking, payment, supplier configuration, shared motivation profile, or shared wish pool was changed.

## 4. References

- [Changchun official hotel list for the requested stay](https://hotels.ctrip.com/hotels/list?city=158&checkin=2026-12-05&checkout=2026-12-08&adult=2).
- [Harbin official hotel list for the requested stay](https://hotels.ctrip.com/hotels/list?city=5&checkin=2026-12-09&checkout=2026-12-11&adult=2).
- [HotelByte sandbox application and provisioning guide](https://hotelbyte.com/zh/guides/sandbox-verification).
