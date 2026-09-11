[English](data-sources.md) | [简体中文](data-sources.zh-CN.md)

# GoTry 数据源架构（唯一数据源权威面）

> 定位：本仓**外部数据从哪来**的唯一权威——领域 × 源 × 新鲜度 × 证据链 × 降级路径。
> 系统怎么构成的看 `architecture.md`；时间线看 `roadmap.md`；本文只管数据。
> 下游：能力层封装（`ts/capabilities/`）与 dsh 插件工具（`ts/src/index.ts`）依本文派生。
>
> L4 不变量（全源适用）：证据链标注必达用户——`[实时API:xxx@ts]` / `[静态包:估算]` / `[骨架:源]`；
> 估算必须显式标记；查不到 ≠ 不存在（三值语义）。

---

## 1. 设计原则（为什么这样分）

1. **LLM 永不造数**（ADR-10）：班次/价格/坐标/天气只来自能力层；LLM 只产骨架与锚点。
2. **免费层打底，付费层按需**：静态骨架（离线可用） → 免费实时（Open-Meteo/OpenSky） → **复用 hotel-be Anything 主路径**（企业级 POI 缓存/ranking，无 key，免费） → M4 scale-up Google Place（地理评分/照片；按次收费） → 付费（暂无）。
3. **复用不重写**（总纲复用矩阵）：hotel-be 已接的能力（Google Place/酒店库存）通过 hbcli 桥复用，GoTry 不直连。
4. **降级不阻塞**：任何实时源失败都降级到静态包/骨架并标注，规划不中断（能力层契约：永远返回一种结果）。
5. **每域至少一个免费源**：种子用户期不因配额/凭证卡死。

---

## 2. 领域矩阵（现状 × 目标）

| 领域 | 现状 | 新鲜度 | 证据链 | 目标（按里程碑） |
|---|---|---|---|---|
| **航线通航性** | ✅ OpenFlights 骨架 168 枢纽对（ODbL，`data/openflights-skeleton.json`） | 静态（月级） | `[骨架:openflights]` | 保持；扩枢纽集；Amadeus 已关停不回 |
| **航班班次/时刻** | ⚠️ 静态包 `data/flights_2026.json`（公开渠道调研，5 段链）+ FlyAI 官方免费通道（`capabilities/flyai.ts`，已落地 P1,2026-08-28）+ 会话通道（`session-search.ts` + 携程适配器，扩展桥 PRIMARY）；OpenFlights 骨架作为通航性金标准 | 实时（FlyAI / 会话）/ 静态（降级） | `[实时API:flyai@ts]` / `[会话:ctrip-flight@ts]` / `[骨架:openflights]` / `[静态包:估算]` | 票价：见 M5（airline price 路径），当前路径 = FlyAI + 会话（扩展桥）交叉验证；**aviationstack 已不在路径**（从校验层移出，免费层 + 官方接口已覆盖原目标） |
| **航班实时观测** | ✅ OpenSky 已接（`capabilities/opensky.ts` + `gotry_flight_verify` 工具；`/api/states/all` 当前 ADS-B 全球观测，~400 credits/天） | 实时 | `[实时API:opensky]` | ✅ 已落地（2026-08-22） |
| **酒店库存/报价** | ✅ hbcli 桥（实时——2026-08-30 全流程 E2E 实测通道/鉴权/搜索编排全通，run-all §7d）+ 飞猪 `search-hotel`（打码价保真）+ 静态包按目的地过滤回退 | 实时/静态 | `[实时API:hbcli@ts]` / `[实时API:flyai@ts]` / `[静态包:估算]` | 保持；UAT 目的地/库存数据补齐后 hotel-list 即回实时（通道已证）；OTA 工具面平铺（无主/降级路由，按查询取用） |
| **酒店点评/评分** | ✅ **复用 hotel-be Anything**（内含酒店 + 城市/区域混合 candidate）；M4 Google Place scale-up 路径为闸后置（geography 仓个人 key + 配额封顶），残余 → [#345](https://github.com/Danceiny/gotry/issues/345)（first review/photo pull trigger 未到时不实现） | Any（hit/miss），M4：geography | `hbcli-anything` | M3：DONE（founder 校准 Anything 复用）；M4：Google Place scale-up 路径（geography GetPlaceReviews） |
| **POI/地点搜索** | ✅ Anything（混合 城市+酒店+place 候选） + OSM 兜底（`dsh-map-tools` 内嵌 Nominatim/Photon 免费回退，`ts/scripts/map-tools-vendor-package-proof.ts` 已 vendored 证） | Any | `hbcli-anything` / M4 `osm-nominatim` | M3：DONE；TREK 同款，免费兜底 |
| **天气/季节性** | ✅ Open-Meteo 已接（`capabilities/weather.ts`：预报≤16 天+历史气候基线；免费无 key；工具 `gotry_weather_check`）；地理编码双源：Open-Meteo（主，人口/行政级排序防同名小地压主城）+ OSM Nominatim（中文兜底——open-meteo 中文名覆盖有洞，issue #24 实测「普吉岛」0 结果） | 实时 | `[实时API:open-meteo@ts]` / 兜底 `[实时API:nominatim@ts]` | 保持；WMO 码已映射中文 |
| **地面交通（接驳/铁路）** | ⚠️ **#341 第一切片**：仅接受显式起点/终点经纬度与 `mode=driving`；`ts/capabilities/ground-transfer.ts` 通过已注册公开 `map_driving_route` 委托路线结果，抵达方向（A→B）与返程方向（B→A）分别请求与绑定，任一方向 miss/error/stale/不匹配仅回退该方向到静态估算；候选 transfer 持有 `minutesOut` / `minutesRet` 覆盖供 `evaluateChoice` 按方向消费；仅把分钟绑定到具名静态 `taxi` transfer；`bus`/`bus_plus_taxi` 不调用路线 provider，静态价格不改写 | 路线估算 + 按方向隔离且有界 cache（方向=origin/destination pair）；**不是实时交通** | 路线事实=`map_driving_route` + `asOf`（宿主观察/查询时间，非 provider 发布时间）/freshness/cache；回退=`[静态包:估算]`；自相矛盾路线事实（正距离零耗时）按 provider miss 拒绝（2026-09-11 边界冻结） | live traffic、transit/rail、fare、地址解析与更广泛 transfer 仍未接入——gated 真实数据工作，离线边界已于 2026-09-11 钉闭；12306 不由本切片假设 |
| **地理/行政区划** | ⚠️ 在线地图由 `dsh-map-tools` Nominatim/Photon 兜底（已 vendored，运行时免费）；**bundled GeoJSON atlas 尚未构建**（offline-first 需求触发后再实现），残余 → [#342](https://github.com/Danceiny/gotry/issues/342) | 实时（在线） | `[实时API:nominatim@ts]` | TREK 模式：bundled GeoJSON atlas（脚本构建，离线） |
| **时区** | v2 flight pack 使用显式 IANA zone 与 local date 解析 UTC instant；`Intl.DateTimeFormat` 是运行时权威，未知 zone 与 DST gap/overlap 在边界拒收，UTC instant 用于 elapsed duration 与 home-zone work-window 投影。静态 v1 的 numeric offset 继续兼容；该确定性契约不代表 live schedules，prices，availability 或 inventory | 动态（运行时常量）+静态 v1 | `[运行时权威:Intl.DateTimeFormat]`（v2） / `[静态包:估算]`（v1 数值） | v2 显式 IANA；v1 保持兼容 |
| **汇率** | ❌ 无（全 CNY 硬编码）；**multi-currency FX 仍属触发后置**——中国出境首发当前以 CNY 出境结算路径为主，首条真实非 CNY booking 触发后再实现，残余 → [#344](https://github.com/Danceiny/gotry/issues/344) | — | — | 多币种 FX（Exchangerate.host 等免费层或 hotel-be） |
| **签证/入境** | ✅ 政策事实生产端 v1（2026-09-05，issue #141）：C 档中国领事服务网（cs.mfa.gov.cn）国家指南树，礼貌抓取（永不重试+断路器护站）→ 签证入境章节抽取 → `PolicyFact(as_of + D+30 review_by + 来源证据链)`落账 | 静态快照抓取 | `[实时API:cs-mfa@ts]` | Timatic/Sherpa° 后议（founder 拍板 C 档免费权威源先行） |

---

## 3. 分层架构（数据怎么流）

```
                    ┌──────────────────────────────────────────────┐
                    │ L1 用户面:证据链标注([实时API:x@ts]/[静态包:估算])│
                    └──────────────┬───────────────────────────────┘
                                   │
                    ┌──────────────▼───────────────────────────────┐
                    │ L2 dsh 插件工具面(ts/src/index.ts,五工具)      │
                    │   gotry_feasibility_check / skeleton_check    │
                    │   hotel_search / motivation_save / wish_pool  │
                    └──────────────┬───────────────────────────────┘
                                   │
                    ┌──────────────▼───────────────────────────────┐
                    │ L3 能力层封装(ts/capabilities/)               │
                    │   hbcli.ts(进程桥+降级+证据链)                │
                    │   incident-log.ts(护栏)                      │
                    │   [已建] weather.ts / opensky.ts / anything.ts│
                    └──────────────┬───────────────────────────────┘
                                   │
        ┌──────────────┬───────────┼──────────────┬─────────────────┐
        ▼              ▼           ▼              ▼                 ▼
   ┌─────────┐   ┌──────────┐ ┌─────────┐  ┌────────────┐  ┌──────────────┐
   │静态包    │   │免费实时   │ │hbcli 桥 │  │OSM 生态     │  │FlyAI 官方    │
   │data/*.  │   │OpenSky   │ │hotel-be │  │(dsh-map-   │  │免费通道       │
   │json     │   │Open-Meteo│ │search   │  │tools 内嵌   │  │(机票/酒店/   │
   │金标准    │   │          │ │OpenAPI  │  │Nominatim/  │  │POI/铁路,已   │
   │         │   │          │ │         │  │Photon/     │  │落地 P1)      │
   │         │   │          │ │         │  │OSRM)       │  │              │
   └─────────┘   └──────────┘ └────┬────┘  └────────────┘  └──────────────┘
                                    │ 内网 HTTP
                            ┌───────▼────────────────┐
                            │ hotel-be               │
                            │ search 模块(OpenAPI)   │
                            │  └─ geography(内网)     │
                            │      └─ Google Places  │
                            │         v1(按次收费)    │
                            └────────────────────────┘
```

**每域一条主链路 + 一条降级链路**；降级产物必须带证据标注，规划永不阻塞。

---

## 4. POI 通用搜索 — Anything 复用优先（founder 校准，2026-08-23）

**当前决策（M3 主路径）**：GoTry 的 POI / 地点 / 酒店搜索**走 hotel-be Anything 函数**——已存在（search/service/geography.go:232），不新增 Places service。Anything 是企业级 FuzzySearch + 混合 城市/酒店 ranking，质量远超 LLM 常识（ADR-10 翻译≠造数禁止）。

```
gotry 插件(gotry_anything_search)
  → ts/capabilities/anything.ts(spawn hbcli search anything)
    → hbcli(external/hotelbyte-cli/src/commands/search.ts:search anything)
      → hotel-be /api/search/anything(公开面,go-zero dispatcher 反射)
        → search/service.Anything 函数(SearchReq{keyword, contentType?, parentDestinationId?})
          → 混合 candidates[city|hotel|place] 返回
            证据链:[实时API:hbcli-anything@ts](hit/miss/error 三值)
```

**Anything 不够时 — Google Place scale-up 路径（M4 后）**：

```
gotry(gotry_place_search 工具, 拟新增)
  → hbcli search place-search "<query>" (拟新增)
    → hotel-be /api/search/googlePlaces/search (拟新增 — geography /SearchPlace 暴露)
      → geography/service/google_service.go:SearchPlace
        → Google Places v1(geography 仓已接个人 API key,按次收费)
```

**Anything vs Google Place 决策矩阵**（M4 决策点 D-4a）：

| 选 | Anything | Google Place Scale-up |
|---|---|---|
| 质量 | 企业级 FuzzySearch（ranking 算法 + 缓存） | 评分 / 照片 / 营业时间 |
| 配额 | 无（走酒店-be 内部） | 按次计费（geography 个人 key） |
| 数据更新 | 酒店-be 主仓更新即生效 | Google 实时 |
| 何时选 | 种子用户期 / 任何地方+酒店混合查 | M4 校准数据后升级 |

**当前 Anything 降级链**（L4 不变量，降级不阻塞）：
- hbcli 不可达 → verdict=`unavailable` + 证据链 `[实时API:hbcli-anything@error@ts]`
- Anything miss（0 候选） → verdict=`miss` 让 LLM 换搜索词
- agent-reach 是 Anything 再下一级的最后兜底（.shared/skills/，D-4a 决定用不用）

**决策由来**：2026-08-22 曾定案 Google Place 链路为唯一路径；2026-08-23 founder 锐评「anything 就是 hotel-be 的接口啊」+「hotelbyte-cli / hotel-be 是你的 workspace 范围」，改 **Anything 复用作主路径**，Google Place scale-up 后置。三仓 commit 闭环（gotry `244a0ae` + hbcli `43236a0` + hotel-be `c38ff65d1`）。

**现状缺口**（按链路顺序）：

| 段 | 现状 | 缺口 | 归属仓 |
|---|---|---|---|
| geography → Google | ✅ 已接（`geography/service/google_service.go`，API key 已配） | `SearchPlace`/`GetPlaceReviews` 不在 `InternalExposedMethods` 白名单（`geography/service/interface.go:93`） | hotel-be |
| search → geography | ❌ 未暴露 | search 模块需新增 place OpenAPI endpoint（转调 geography，含配额封顶——个人 key 按次计费） | hotel-be |
| hbcli → search | ❌ 无命令 | `hbcli search place <query>` / `hbcli search place-reviews <id>` + `--json` | hotel-be（external/） |
| gotry → hbcli | ❌ 未接 | `capabilities/place.ts`（hbcliPlaceSearch，失败降级 OSM Nominatim 兜底） | gotry |

**配额红线**：Google Places 个人账号按次收费（hotel-be 侧已多处封顶）；gotry 侧必须：
- 每会话 place 查询上限（默认 10 次），超限自动切 OSM；
- 证据链标注 `[实时API:hbcli-anything@ts]`（M3 Anything 主路径）；M4 scale-up 后才有 `[实时API:hbcli-place@ts]`（Google Place 收费源）与 `[实时API:osm-nominatim@ts]`（OSM 兜底）。

**为什么双轨（OSM 兜底）**：种子用户期配额/凭证不可控；Nominatim/Overpass 免费无 key（TREK 同款），数据薄（无评分/照片）但坐标/名称/类目可用——符合「每域至少一个免费源」原则。

---

## 5. TREK 参考（liketrek/TREK，12.6k★，AGPL-3.0——仅设计参考，零代码复制）

TREK 是自托管协作旅行规划器，数据面成熟度最高，可借鉴的模式：

| 域 | TREK 的做法 | GoTry 采纳 |
|---|---|---|
| POI 搜索 | M3 用 hotel-be Anything（企业级）；M4 scale-up Google Places（有 key）+ OSM 兜底；地图探索 OSM-only by design | ✅ M3：DONE（Anything 主路径，OSM 仅作 M4 兜底的兜底）；设计原则与 TREK 一致 |
| 天气 | Open-Meteo（免费无 key，16 天预报 + 历史气候回退），WMO 码映射 | ✅ M3 末接同款；历史气候做季节性推荐的数据底座（替 LLM 常识） |
| 地理 | bundled GeoJSON atlas（admin0/admin1 脚本构建，离线可用） | ✅ M4：「去过的地方」地图页复用此模式 |
| 预订导入 | KDE Itinerary（邮件/PDF 解析航班酒店确认单） | ⏸ M5（交易后才有导入需求）；gotry 的 bookedResources 锚点可吃这个 |
| AI 接入 | MCP server 暴露 places/weather 工具（带 scopes/权限） | ✅ 已同构——gotry 走 dsh 插件工具面，本质同 MCP 模式 |
| 安全 | 所有外部 fetch 过 SSRF guard | ✅ 采纳进 capabilities 层契约（外部 URL 必须过检查） |

**不采纳**：TREK 的协作/多用户/预算分摊（不是 gotry 的 M3-M5 范围）；其 AGPL-3.0 许可证意味着**零代码复制**（design reference only，总纲「不重写也不抄」纪律）。

### agent-reach 100% follow → wrapper 化（2026-08-23 落地；2026-08-22 founder 纠偏「wrapper 不是 router」后重构）

**Panniantong/Agent-Reach v1.5.0**（MIT， 74k★）是 installer + doctor + 路由知识（SKILL.md），实际读取由上游工具完成。GoTry 100% follow：

- **CLI 真装**： `.venv/`（python3.11 venv， 单 venv 整合）装上游 `agent-reach` v1.5.0 → `agent-reach doctor` 真跑（4/15 渠道 ready）
- **wrapper 化（2026-08-22 重构）**： 删 300 行 13 渠道 switch —— 渠道枚举/方法选择/setup 文案是在重复上游注册表，且实测已漂移（gotry 写 exa/xhs，上游真名 exa_search/xiaohongshu）。三层分工：
  - 知识 → 上游（`agent_reach.channels` 注册表 + `Channel.check()` 原话 + guides/）；决策 → dsh LLM（未知渠道/方法时返回上游自描述清单，LLM 自纠）；管道 → gotry（spawn/超时/永不抛错/证据链）
  - `ts/capabilities/agent-reach-bridge.py`： 通用反射桥，`get_channel()`+`getattr()` 直调上游 python API（web.read / v2ex.get_hot_topics / xueqiu.get_stock_quote ...），上游加渠道零改动
  - `ts/capabilities/agent-reach.ts`： 薄壳；needs-setup 文案 = 上游 `check()` 原话透传不转述；CLI 工具型渠道（github→gh/字幕→yt-dlp）仍由专用工具当执行面
- **dsh 工具**： `gotry_agent_reach`（action=status 走真 doctor / action=reach 反射调 `<channel>.<method>`）+ 专用工具 web_search/video_subtitle/github_search
- **证据链**： `[agent-reach:<channel>.<method>@<ts>]` 进 L4 契约

## 6. 证据链标注契约（L4 不变量执行细则）

| 标注 | 语义 | 触发 |
|---|---|---|
| `[实时API:hbcli@<ISO ts>]` | hotel-be 实时（酒店库存；未来含 place） | hbcli 退码 0 |
| `[实时API:hbcli-place@<ts>]` | **M4 scale-up 路径**：Google Place 经 hbcli（收费源，带配额） | place 查询成功（placeholder；M3 实际走 `[实时API:hbcli-anything@ts]`） |
| `[实时API:osm-nominatim@<ts>]` | **M4 scale-up 路径**：OSM 免费兜底 | hbcli 失败/超配额（placeholder；M3 同上） |
| `[实时API:opensky@<ts>]` | 航班实时观测（ADS-B 当前快照；OpenSky 匿名路径只支持实时，历史查需鉴权） | OpenSky 命中 |
| `[实时API:open-meteo@<ts>]` | 天气预报（M3 末） | 天气查询成功 |
| `[骨架:openflights]` | 通航性三值（肯定/枢纽对否定≠证伪/枢纽外无结论） | 求解预过滤 |
| `[静态包:估算]` | 公开渠道调研估算，预订前需核实 | 一切降级回退 |

三值语义（通航性专用）：**检出=强肯定；枢纽对查空=降权信号，永不排除（骨架滞后会错杀）；枢纽集外=无结论**。

韧性横切落位（2026-08-29，issue #16 采纳/ADR-18）：对外渠道的重试/熔断/节律不再逐能力层复制——效应解译器 `effect_interpreter.v1`（`ts/capabilities/effect.ts`，设计文档 `design/effect-interpreter.md`）按 per-效应策略表统一执行：重试只认瞬时类失败（**Sentinel 限流永不重试**），SESSION 通道永不重试不熔断（风控红线，治理在节律闸+授权闸）；解译层横切证据 `[效应:<NAME>@<ts>]` 与上表渠道证据链并存（渠道标注不动，解译层只记 attempts/backoff/breaker 与拒绝面）。23 工具外部依赖面已全收敛（issue #115,2026-09-04）。

可下单事实落账契约（2026-08-30，issue #46/ADR-19）：
- flyai/session 机/火 **exact-date** 检索结果（hit 与 miss）逐条落 `<stateRoot>/gotry-state/bookable-facts.jsonl` 侧车（`gotry_bookable_fact.v1`：query_id 可重放、IATA 归一、live_inventory/route_exists/historical_schedule/benchmark_price 四层 tier 永不合并）；产物中的可下单 claim 必须回溯到侧车条目。
- `gotry_fact_gate` 反向抽取 markdown claim 逐条对账，exact-date miss 的 route+date 被航班号/时刻填充 = not_in_source 违例（产物 blocked）；政策表述只允许「截至 YYYY-MM-DD」+复核日期，冲突永不得 ✓，联程仅 protected_connection=true。

---

## 7. 演进（与 roadmap 对齐，本文只列数据侧）

- **M3 末（历史节点，2026-08 月内）**：
  - Open-Meteo 接入 ✅（`capabilities/weather.ts` + `gotry_weather_check`）；OpenSky 挂到插件工具面 ✅（`capabilities/opensky.ts` + `gotry_flight_verify`）。
  - **LLM 价表 v2 + 价格漂移长机制（2026-08-30，issue #49）**：`ts/data/llm-price-table.json` provider-aware（DeepSeek tiered_peak_offpeak + MiniMax flat_no_offpeak，MiniMax M2/M2.1/M3 入表），ADR-11「peak only-high-not-low」是单一真理，unknown model → fail-closed 不猜价；`ts/scripts/price-drift-watch.ts` 覆盖 DeepSeek/MiniMax/OpenAI/Anthropic 四家，默认离线对照 baseline fixture 输出 PR-就绪 Markdown diff，`--fetch` 拉官方页，**永不自动 apply 价格**（走 PR + 人 review）；run-all §41。
- **M4（当前）**：见 `roadmap.md` M4 节点；数据侧新增 = FlyAI 官方通道接入 + 会话数据面 P1（扩展桥 PRIMARY）+ 政策事实生产端 v1（#141）；§7 仅列**数据源面**增量，产品/UI 增量以 `roadmap.md` 为权威。
- **M4 当前工程残余**：
  - **#341 地面接驳第一切片**：显式坐标 + `mode=driving` 通过注册的公开 `map_driving_route` 进入 deterministic planner adapter；抵达方向（A→B）与返程方向（B→A）分别请求、缓存与降级，任一方向 miss/error/stale/不匹配仅回退该方向到静态估算，候选 transfer 持有 `minutesOut` / `minutesRet` 覆盖供 `evaluateChoice` 按方向消费；仅静态 `taxi` transfer 接收路线分钟，`bus`/`bus_plus_taxi` 保持静态值并返回明确回退，静态价格标 `[静态包:估算]`。过期缓存按方向重新查询；非法坐标、不支持模式与绑定不一致按方向保留静态值；不覆盖单次 live OSRM、实时交通、transit/rail/fare 或地址解析。
  - 第一切片之外的 rail/transit、fare、live traffic 与非显式坐标解析仍是 #341 后续边界。
- **触发后置残余**：
  - **#345 三仓门**：GoTry 专用 paid Place/reviews 链——hotel-be `search` 模块新增 place OpenAPI endpoint（转调 geography，带配额封顶），hotel-be `geography` 把 `SearchPlace`/`GetPlaceReviews` 加入 `InternalExposedMethods` 白名单；hotelbyte-cli 新增 `search place` / `search place-reviews` 命令 + `--json`；GoTry 侧新增 `capabilities/place.ts`（hbcliPlaceSearch，失败降级 OSM Nominatim 兜底）。**触发 = first review/photo pull need**（founder + 用量）——触发前不开闸，触发后才动三仓。#276 = hotel-be 内部 `SearchSrv` 在 M4 规模下的扩容路径，**独立**于 #345 三仓门，不得合并。
  - **#342 bundled GeoJSON atlas**（脚本构建、离线）；触发 = offline-first 需求。
  - **#344 多币种 FX**；触发 = first real non-CNY booking（中国出境首发当前以 CNY 出境结算路径为主）。
- **M5**：票价路径 = FlyAI + 会话（扩展桥）交叉验证，aviationstack 已不在路径（免费层 + 官方接口已覆盖原目标）；KDE Itinerary 式预订导入（bookedResources 数据源）。

---

## 8. 官方 agent 通道与会话面尽调（2026-08-28 起，RFC `rfc/user-session-data-rfc.md` P0）

### 飞猪 FlyAI（`@fly-ai/flyai-cli`，MIT，npx 直跑，无 key 无登录已实测）

- 8 工具全只读：`search-flight` / `search-train` / `search-hotel` / `search-poi` / `keyword-search` / `ai-search` / 万豪×2；预订经结果内 `jumpUrl` 跳飞猪完成——**交易不进 skill，与 WriteGate 哲学同构**。
- 实测（2026-08-28，本机）：上海→丽江 2026-10-01 机票，春秋 9C6617 浦东 17:05→三义 20:50 ¥1790 等结构化 journeys/segments/ticketPrice JSON；上海→大理火车票，虹桥 10:00 G201 二等→昆明南→大理 22:47 中转链。
- 单行 JSON stdout，agent-native（hbcli 同款形态）。**意义：机票班期/票价与铁路检索的官方免费通道已开——用户会话面的真实缺口收缩为「携程 C 端交叉验证 + 美团本地」；12306 会话需求（G8）大幅弱化**。
- 未明：收费/配额/企业门槛（README 未披露，`FLYAI_API_KEY` 可选增强）。接入形态：`capabilities/flyai.ts` **已落地（P1,2026-08-28）**——spawn CLI 管道层，session-tests F 节 live 断言。
- **限流实测（2026-08-28 下午）**：高频调用后返 `SentinelBlockException by fly-ai-search`（CLI exit=0、stdout 非业务 JSON）——配额未文档化，恢复窗口未知；flyai.ts 已把该形态纳入结构化 error（带 stdout 片段），测试/smoke 按「hit 或 sentinel 降级」双合法终态。**2026-08-29 缺口修复（Issue #24）**：该限流输出是合法 JSON，曾走 `data?.itemList ?? []` 被吞成 0/0 静默 miss——现按形状判别（无 `data.itemList` 即 error），离线回归见 run-all §7b；工具层 summary 三分支（hit/miss/error）+过去日期显式提示。

### 会话数据面 P1（RFC §4,2026-08-28）

- `capabilities/session-search.ts` + `session/{transport,read-guard,adapters/ctrip-flight}` 落地——ReadGuard（方法×URL 双因子 + 驼峰复合写词，写请求物理 abort + 审计，fail-closed）+ 携程机票适配器（batchSearch 嗅探→结构化）+ 节律闸（同站 ≥30s）；证据链新标注 `[会话:ctrip-flight@ts]` 生效；run-all §24。live 会话检索需 headful（headless 下携程只回壳页，实测）。
- 登录态为存在前提（founder 纠偏 2026-08-28）：persistent 专用 profile 降为测试/后备（实测：匿名窗口无人会登录，History/Cookies 双 0 行）；**2026-08-30 传输层定案（founder「逐连接权限框根本无法使用」）：扩展桥升 PRIMARY**——`extension/` GoTry Session Bridge（MV3 一次性安装，manifest 固定 key=扩展 ID）在自身标签页被动嗅探站点自身请求（扩展零写行为），`session/extension-bridge.ts` 回环桥（node:http 零新依赖，origin 白名单）长轮询配对；系统弹窗每会话 0 次，cookie 只读名字值即弃，cdp 降为 `GOTRY_SESSION_TRANSPORT=cdp` 显式诊断后备（不静默回退）；run-all §38 全离线合同。

### #21 双源验收合同（2026-08-29）

`session/benchmark.ts` 把 query/segments/journey type/逐段时刻与班次/currency/price/source/fetched_at/verdict 固化为字段级 fixture scorer（缺字段计错，默认 ≥90%）；双源对齐按同 journey/segments/时刻/班次判断，价格差独立记录、不要求相等。`needs-attach`/`needs-login` 返回 waiting-user no-spend，challenge 或 ReadGuard blocked>0 立即 fail-closed；当前只验证脱敏 fixture，不触碰日常 Chrome，真实 sf-01..08 仍需权限确认和 CDP 握手。

### P3.7 static golden vendor + 登录态实跑（Issue #67,2026-08-30）

- `ts/scripts/sf-live-benchmark.ts --golden=static` 使用版本化 `ts/data/sf-static-routes.json`：route/carrier 取自 OpenFlights `routes.dat` 的 ODbL 固定 revision `4b969f8e91eb800c45f0e0e2355a0fbb93de27e4`，覆盖 sf-01..08。
- OpenFlights 不含 schedule/price/availability，故 `departure_at`、`arrival_at`、`transport_number` 与 `price` 作为 estimated fields，其时刻/价格带来自 `sf-golden-manifest.json`。每条 evidence 同时写 `requested_source=static` 与实际 `effective_source`，并携 route URL/revision/license、band source、fallback reason。
- 快照读取/校验或路由覆盖失败时 stderr 明示 `fallback=manual-golden`，拒绝静默换源；该 vendor 是 benchmark comparator，**不能证明实时班期、实时票价或可售库存**。provider-independent 软评分与 CLI vendor 闭集进入 run-all §44。
- **登录态实跑**：sf-01..08 连续两轮以 `requested_source=static` 执行，effective 全为 `static-openflights+manual-band`，official 每轮 8/8 hit、`fallback_count=0`；携程 session 分别 3/8 与 5/8 hit，两轮全部可评分 hit（3+5 条）soft score 均 13/13=100%，非 hit 为明示 miss。该分母只覆盖会话 hit，不能反推 8/8 可售性。

### 边界实测（2026-08-28/29）

- **美团**：匿名实例 hotel.meituan.com 直接 **403**（headful 新 profile）——三站最强反爬，登录态是 403 级硬前置；适配器骨架已落（`adapters/meituan-local.ts`：城市拼音表/登录票据名单/networkHint 占位/a11y 兜底 `extractListings`），真实接口形状待登录态就绪后回填。a11y 兜底抽取器 `session/extract.ts` 与金标准查询集 `data/session-golden-20.json`（20 条，只增不改）同批落地（run-all §26）。
- **携程机票 XHR 嗅探 PoC**（`ts/scripts/session-attach-poc.ts`，playwright-core 1.62.1 + 专用测试 profile）：两次实测均零风控、零交互只读；主搜索接口已识别：`flights.ctrip.com/international/search/api/search/batchSearch`（~550KB，国内票同走）+ `FlightIntlAndInlandLowestPriceSearch` 低价日历（~81KB）——P1 携程适配器的 networkHints 直接可用。
- **Dida 供应商门户（2026-09-09 实装，hotel-be portal integration 迁移线）**：员工登录经 hotel-be portal 自动填充跳板在 dida 官网由人完成，gotry 只在用户本人 Chrome 登录态被动嗅探 `portal-webapi.dida.com/HotelPriceAPI/SearchRealTime|SearchMonitor`（2026-07 抓包口径；接口名首个真会话后校准，D-13 同款边界）；解析=SearchRealTime 信封逐计划展平（`RoomTypeList`∪`RoomList`，`RatePlanID/Price/TotalPrice/Currency/Inventory/ReferenceNo`），SearchMonitor 形状未捕获前不猜测只转发；票据 cookie `CN_M_DidaTravel` 名字级。SPA 边界：find 页加载自发请求才可嗅，页内点击触发的检索属用户本人浏览行为（零 DOM 交互不变量）。
- **OTA 平铺（2026-08-29，founder 口径「不要区分主路径/降级路径」）**：工具描述与 persona （19） 删「主链路/交叉验证/三级路由」层级话术；**拍平的是路由优先级，不是 L4 证据链纪律**（逐源标注照旧必达用户）。
- **账号授权闸 v2（2026-08-29）**：`tools/pre-execute` 监听器（`session-consent.ts`）对账号面工具每会话每站点首次调用弹审批卡；allowed-once 会话内免再弹，**拒绝=本会话吊销**；无审批通道 fail-closed；`sessionAccess: ask|allow|off` 三态；站点白名单=适配器注册表现状（ctrip-flight + ctrip-hotel + train-12306）。飞猪通道**不过闸**（匿名无用户身份）。session-tests §I + smoke §13。
- **登录产品化（第 18 工具 `gotry_session_login`，2026-08-29）**：`needs-login` 时 agent 直调——attach 用户 Chrome、弹登录入口、等用户在**携程官网**完成登录；**语义红线：登录永远发生在外部网站——gotry 永不收集/存储/传输密码、验证码或任何 cookie 值**，只读票据 cookie 名这个存在性事实（session-tests §J3 值不泄露断言）。登录引导页不挂 ReadGuard（transport `guard:false` 唯一豁免面）：写拦截会物理 abort 用户本人的登录 POST（隐私+可靠性双输）。
- **测试纪律（2026-08-29 founder 反馈根治）**：例行回归**永不自动开浏览器窗口**——session-tests live 节默认 SKIP，`GOTRY_SESSION_LIVE=1` 显式 opt-in。
- **人机共治标签页纪律（2026-08-29，founder「我根本就看不到登录页面」根治）**：登录引导与会话检索一律 `newPage` 开**自己的独立标签页**（登录页 `bringToFront` 置前台、`closeOwnPage=false` 留给用户），绝不劫持用户既有标签页；检索页用完即关自己的页。
- **未接（独立 tick）**：携程酒店/美团酒店会话适配器——登录态 seam 与美团 403 硬前置未解，见上。
- **browser-use 假象澄清**：其隔离 Chromium ≠ 用户桌面 Chrome，装不到目标扩展，**显式不引入**（Python 违纪，二次理由）。
- **onboarding 沿革**：issue #21 P3.6 的 5 步 wizard（2026-08-30）已于 2026-09-02 商店上架后按「职责返交」撤销——安装回浏览器、渲染回 dsh UI，wizard 退化为离线健康探活等待；全文见 `rfc/user-session-data-rfc.md` §3.3。
