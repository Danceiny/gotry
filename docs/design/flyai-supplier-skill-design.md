[English](flyai-supplier-skill-design.md) | [简体中文](flyai-supplier-skill-design.zh-CN.md)

# FlyAI supplier skill integration

> Role: public capability, credential and evidence contract for the FlyAI integration.
> Status: active
> Upstream: [architecture](../architecture.md), [#521](https://github.com/Danceiny/gotry/issues/521).
> Downstream: adapter, model tools, local setup CLI and acceptance tests.

## Capability boundary

The adapter uses the public MIT-licensed `@fly-ai/flyai-cli@1.0.16`. This is technical integration with a public interface; it does not imply a partnership endorsement. All eight commands are read-only. Booking and payment remain human actions on upstream links.

| Tool kind | Public CLI command | Query surface |
|---|---|---|
| flight | search-flight | Origin, optional destination/date/range, return date, cabin, route, hours, price and sorting |
| train | search-train | Origin, optional destination/date/range, seat, service number, hours, price and sorting |
| hotel | search-hotel | Destination, dates, keywords, POI, stars, beds, type, price and sorting |
| poi | search-poi | City, level, keyword and public category |
| keyword | keyword-search | Query |
| ai | ai-search | Natural-language query; preserve data without inventing inventory facts |
| marriott-hotel | search-marriott-hotel | Destination, dates, brands, name, beds, price and sorting |
| marriott-package | search-marriott-package | Keyword and price sorting |

For `marriott-hotel`, `destName` maps to `--dest-name`; `hotelBrands` and `hotelName` are merged with `keyWords` into the CLI's single `--key-words` value, while bed, date, max-price and sort filters use their dedicated flags. The generic `hotelTypes` and `hotelStars` filters are rejected for this kind. For `marriott-package`, `keyword` maps to the single `--keyword` dimension and `sortType` is limited to `price_asc` or `price_desc`.

The flat `gotry_flyai_search` schema retains `from/to/date/checkIn/checkOut` aliases. Masked prices are displayed verbatim and never converted to a numeric quote. Only exact-date flight/train queries with origin, destination and one departure date, or hotel queries with destination and paired stay dates, can write valid hit/miss inventory facts. Exploration results and all errors write none.

## Credential ownership

The local `gotry setup flyai` command accepts hidden terminal input or `--stdin`, verifies the candidate before saving, and supports `--status` and `--clear`. Keys never enter command arguments or model parameters. Failed verification or storage preserves the prior configuration. The official configuration path is `~/.flyai/config.json`; directory/file modes are `0700/0600`.

Resolution follows nonempty `FLYAI_API_KEY`, then `DEBUG_FLYAI_API_KEY`, then the config file, then anonymous shared trial. Debug endpoints are explicit, and their userinfo/query values are hidden. A verification receipt binds the key hash, source and complete endpoint fingerprint; changing any invalidates it. A nonempty key proves configuration only, and a debug check proves only that endpoint.

The model tool `gotry_flyai_setup` accepts only `status/check`. Check performs a read-only query and may update a verification receipt; it never changes credentials. Anonymous checks make no claim of a valid formal key or unlimited quota.

## Error and cancellation contract

Authentication failure, forbidden access, trial exhaustion, Sentinel, malformed responses and local process termination do not retry. Ordinary rate limiting and explicitly classified upstream network/HTTP 5xx failures may retry once. A nonzero exit code alone does not determine retry policy. Only valid empty results mean miss; errors cannot become negative inventory facts.

Host cancellation uses the main effect interpreter ownership and backoff contract. Cancelling a search stops its owned CLI process group and releases its own breaker probe without clearing prior failures.

## Decisions and acceptance

Reject model-side key saving because model arguments and history are durable. Reject interpreting masked prices as numbers and malformed payloads as empty results because both fabricate inventory evidence. Reject hidden provider switching because it breaks source attribution.

Acceptance combines isolated local setup, a fresh status/doctor process, installed-product model tool calls for all eight kinds, error recovery, secret scans and full regression. Controlled model/provider responses verify product wiring; they do not establish live supplier availability or formal-key authorization. Those boundaries must remain separate in the test report.
