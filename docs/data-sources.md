# GoTry 数据源架构(唯一数据源权威面)

> 定位:本仓**外部数据从哪来**的唯一权威——领域 × 源 × 新鲜度 × 证据链 × 降级路径。
> 系统怎么构成的看 `architecture.md`;时间线看 `roadmap.md`;本文只管数据。
> 下游:能力层封装(`ts/capabilities/`)与 dsh 插件工具(`ts/src/index.ts`)依本文派生。
>
> L4 不变量(全源适用):证据链标注必达用户——`[实时API:xxx@ts]` / `[静态包:估算]` / `[骨架:源]`;
> 估算必须显式标记;查不到 ≠ 不存在(三值语义)。

---

## 1. 设计原则(为什么这样分)

1. **LLM 永不造数**(ADR-10):班次/价格/坐标/天气只来自能力层;LLM 只产骨架与锚点。
2. **免费层打底,付费层按需**:静态骨架(离线可用) → 免费实时(Open-Meteo/OpenSky/OSM) → 复用 hotel-be(供应链已有) → 付费(暂无)。
3. **复用不重写**(总纲复用矩阵):hotel-be 已接的能力(Google Place/酒店库存)通过 hbcli 桥复用,GoTry 不直连。
4. **降级不阻塞**:任何实时源失败都降级到静态包/骨架并标注,规划不中断(能力层契约:永远返回一种结果)。
5. **每域至少一个免费源**:种子用户期不因配额/凭证卡死。

---

## 2. 领域矩阵(现状 × 目标)

| 领域 | 现状(v0.0.1-rc.3) | 新鲜度 | 证据链 | 目标(按里程碑) |
|---|---|---|---|---|
| **航线通航性** | ✅ OpenFlights 骨架 168 枢纽对(ODbL,`data/openflights-skeleton.json`) | 静态(月级) | `[骨架:openflights]` | 保持;扩枢纽集;Amadeus 已关停不回 |
| **航班班次/时刻** | ⚠️ 静态包 `data/flights_2026.json`(公开渠道调研,5 段链) | 静态(2026-07 调研) | `[静态包:估算]` | M4:aviationstack 校验层(§7-1 已批三层组合);票价 M5 |
| **航班真实执飞** | ⚠️ OpenSky 匿名桥已写(`ts/scripts/opensky-check.ts`,400 credits/天) | 近 7 天 | `[实时API:opensky]` | 接进插件工具(现为脚本,未挂 dsh 工具面) |
| **酒店库存/报价** | ✅ hbcli 桥(实时,证书过期降级中)+ 静态包 `data/hotels_2026.json` 回退 | 实时/静态 | `[实时API:hbcli@ts]` / `[静态包:估算]` | 保持;hbcli UAT 证书恢复即回实时 |
| **酒店点评/评分** | ❌ 无 | — | — | **复用 hotel-be**:geography `GetPlaceReviews`(Google Places v1)——链路见 §4 |
| **POI/地点搜索** | ❌ 无(候选目的地硬编码在金标准包) | — | — | **双轨**:① 复用 hotel-be Google Place(富数据,收费) ② OSM Nominatim/Overpass(免费兜底,TREK 模式) |
| **天气/季节性** | ❌ 无(LLM 人格里有雨季常识,无数据) | — | — | M3 末:Open-Meteo(免费无 key,16 天预报+历史气候)——TREK 同款 |
| **地面交通(接驳/铁路)** | ⚠️ 段内 transfer 硬编码在数据包(minutes/priceCny) | 静态 | `[静态包:估算]` | M4:OSRM 免费自托管(路线/时长);12306 无开放 API 不接 |
| **地理/行政区划** | ❌ 无 | — | — | TREK 模式:bundled GeoJSON atlas(脚本构建,离线) |
| **时区** | ⚠️ 手写在数据包(tz_offset_min/origin_tz_offset_min) | 静态 | — | M4:用时区库(`Intl`/`tz-lookup`)替代手写 |
| **汇率** | ❌ 无(全 CNY 硬编码) | — | — | M4:exchangerate 免费层,或 hotel-be 若有 |
| **签证/入境** | ❌ 无 | — | — | M5 前不接;靠 LLM 常识+提示用户核实 |

---

## 3. 分层架构(数据怎么流)

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
                    │   [待建] place.ts / weather.ts / opensky.ts   │
                    └──────────────┬───────────────────────────────┘
                                   │
        ┌──────────────┬───────────┼──────────────┬─────────────────┐
        ▼              ▼           ▼              ▼                 ▼
   ┌─────────┐   ┌──────────┐ ┌─────────┐  ┌────────────┐  ┌──────────────┐
   │静态包    │   │免费实时   │ │hbcli 桥 │  │OSM 生态     │  │[M5]付费       │
   │data/*.  │   │OpenSky   │ │hotel-be │  │Nominatim/  │  │aviationstack │
   │json     │   │Open-Meteo│ │search   │  │Overpass/   │  │(校验层,已批)  │
   │金标准    │   │          │ │OpenAPI  │  │OSRM        │  │              │
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

**每域一条主链路 + 一条降级链路**;降级产物必须带证据标注,规划永不阻塞。

---

## 4. Google Place 链路(founder 定案,2026-08-22)

**决策**:GoTry 的 POI/地点/点评数据**不直连 Google**,复用 hotel-be 已接入的 Google Places v1。

**链路**(四段,前两段在 hotel-be 侧):

```
gotry 插件(gotry_place_search 工具)
  → ts/capabilities/hbcli.ts(进程桥,spawn hbcli search place --json)
    → hbcli(external/hotelbyte-cli,新增 search place 命令)
      → hotel-be search 模块(新增 OpenAPI endpoint: place 搜索/点评)
        → geography 模块(内网服务,已接 Google Places v1:
          SearchPlace / GetPlaceReviews,google_service.go)
          → Google(出站 gRPC)
```

**现状缺口**(按链路顺序):

| 段 | 现状 | 缺口 | 归属仓 |
|---|---|---|---|
| geography → Google | ✅ 已接(`geography/service/google_service.go`,API key 已配) | `SearchPlace`/`GetPlaceReviews` 不在 `InternalExposedMethods` 白名单(`geography/service/interface.go:93`) | hotel-be |
| search → geography | ❌ 未暴露 | search 模块需新增 place OpenAPI endpoint(转调 geography,含配额封顶——个人 key 按次计费) | hotel-be |
| hbcli → search | ❌ 无命令 | `hbcli search place <query>` / `hbcli search place-reviews <id>` + `--json` | hotel-be(external/) |
| gotry → hbcli | ❌ 未接 | `capabilities/place.ts`(hbcliPlaceSearch,失败降级 OSM Nominatim 兜底) | gotry |

**配额红线**:Google Places 个人账号按次收费(hotel-be 侧已多处封顶);gotry 侧必须:
- 每会话 place 查询上限(默认 10 次),超限自动切 OSM;
- 证据链标注 `[实时API:hbcli-place@ts]`;OSM 兜底标 `[实时API:osm-nominatim@ts]`。

**为什么双轨(OSM 兜底)**:种子用户期配额/凭证不可控;Nominatim/Overpass 免费无 key(TREK 同款),数据薄(无评分/照片)但坐标/名称/类目可用——符合「每域至少一个免费源」原则。

---

## 5. TREK 参考(liketrek/TREK,12.6k★,AGPL-3.0——仅设计参考,零代码复制)

TREK 是自托管协作旅行规划器,数据面成熟度最高,可借鉴的模式:

| 域 | TREK 的做法 | GoTry 采纳 |
|---|---|---|
| POI 搜索 | 双 provider:Google Places(有 key)/ Nominatim+Overpass(免费);地图探索 OSM-only by design | ✅ 双轨同构(§4);探索类需求 OSM 优先省配额 |
| 天气 | Open-Meteo(免费无 key,16 天预报 + 历史气候回退),WMO 码映射 | ✅ M3 末接同款;历史气候做季节性推荐的数据底座(替 LLM 常识) |
| 地理 | bundled GeoJSON atlas(admin0/admin1 脚本构建,离线可用) | ✅ M4:「去过的地方」地图页复用此模式 |
| 预订导入 | KDE Itinerary(邮件/PDF 解析航班酒店确认单) | ⏸ M5(交易后才有导入需求);gotry 的 bookedResources 锚点可吃这个 |
| AI 接入 | MCP server 暴露 places/weather 工具(带 scopes/权限) | ✅ 已同构——gotry 走 dsh 插件工具面,本质同 MCP 模式 |
| 安全 | 所有外部 fetch 过 SSRF guard | ✅ 采纳进 capabilities 层契约(外部 URL 必须过检查) |

**不采纳**:TREK 的协作/多用户/预算分摊(不是 gotry 的 M3-M5 范围);其 AGPL-3.0 许可证意味着**零代码复制**(design reference only,总纲「不重写也不抄」纪律)。

---

## 6. 证据链标注契约(L4 不变量执行细则)

| 标注 | 语义 | 触发 |
|---|---|---|
| `[实时API:hbcli@<ISO ts>]` | hotel-be 实时(酒店库存;未来含 place) | hbcli 退码 0 |
| `[实时API:hbcli-place@<ts>]` | Google Place 经 hbcli(收费源,带配额) | place 查询成功 |
| `[实时API:osm-nominatim@<ts>]` | OSM 免费兜底 | hbcli 失败/超配额 |
| `[实时API:opensky@<ts>]` | 航班真实执飞校验(ADS-B,近 7 天) | OpenSky 命中 |
| `[实时API:open-meteo@<ts>]` | 天气预报(M3 末) | 天气查询成功 |
| `[骨架:openflights]` | 通航性三值(肯定/枢纽对否定≠证伪/枢纽外无结论) | 求解预过滤 |
| `[静态包:估算]` | 公开渠道调研估算,预订前需核实 | 一切降级回退 |

三值语义(通航性专用):**检出=强肯定;枢纽对查空=降权信号,永不排除(骨架滞后会错杀);枢纽集外=无结论**。

---

## 7. 演进(与 roadmap 对齐,本文只列数据侧)

- **M3 末(当前)**:Open-Meteo 接入(免费无 key,当天可完);OpenSky 从脚本挂到插件工具面。
- **M4**:`capabilities/place.ts` 双轨(hbcli-place + OSM 兜底);OSRM 时长估算进 transfer;时区库替代手写;汇率免费层。
- **hotel-be 侧依赖(gate)**:search 模块 place OpenAPI + geography 白名单 + `hbcli search place`——三段都在 hotel-be 仓,由该仓 lane 推进;gotry 侧等 `hbcli search place --json` 可用即零改动接上(能力层已留降级位)。
- **M5**:票价(aviationstack 校验层升级);KDE Itinerary 式预订导入(bookedResources 数据源)。

---

## 修订史

| 日期 | 变更 |
|---|---|
| 2026-08-22 | 立 v1:领域矩阵现状盘点、四层架构图、Google Place 链路 founde 定案(hbcli→search OpenAPI→geography)、TREK 参考采纳表、证据链契约细则、M3-M5 数据侧演进 |
