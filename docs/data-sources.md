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
2. **免费层打底,付费层按需**:静态骨架(离线可用) → 免费实时(Open-Meteo/OpenSky) → **复用 hotel-be Anything 主路径**(企业级 POI 缓存/ranking,无 key,免费) → M4 scale-up Google Place(地理评分/照片;按次收费) → 付费(暂无)。
3. **复用不重写**(总纲复用矩阵):hotel-be 已接的能力(Google Place/酒店库存)通过 hbcli 桥复用,GoTry 不直连。
4. **降级不阻塞**:任何实时源失败都降级到静态包/骨架并标注,规划不中断(能力层契约:永远返回一种结果)。
5. **每域至少一个免费源**:种子用户期不因配额/凭证卡死。

---

## 2. 领域矩阵(现状 × 目标)

| 领域 | 现状(v0.0.1-rc.3) | 新鲜度 | 证据链 | 目标(按里程碑) |
|---|---|---|---|---|
| **航线通航性** | ✅ OpenFlights 骨架 168 枢纽对(ODbL,`data/openflights-skeleton.json`) | 静态(月级) | `[骨架:openflights]` | 保持;扩枢纽集;Amadeus 已关停不回 |
| **航班班次/时刻** | ⚠️ 静态包 `data/flights_2026.json`(公开渠道调研,5 段链) | 静态(2026-07 调研) | `[静态包:估算]` | M4:aviationstack 校验层(§7-1 已批三层组合);票价 M5 |
| **航班实时观测** | ✅ OpenSky 已接(`capabilities/opensky.ts` + `gotry_flight_verify` 工具;`/api/states/all` 当前 ADS-B 全球观测,~400 credits/天) | 实时 | `[实时API:opensky]` | ✅ 已落地(2026-08-22) |
| **酒店库存/报价** | ✅ hbcli 桥(实时,证书过期降级中)+ 静态包 `data/hotels_2026.json` 回退;**2026-08-29 起 npm 安装期自动按官方脚本安装 hbcli**(hotelbyte-cli 为公开仓 github.com/hotelbyte-com/hotelbyte-cli,MIT——D-19 初判「无分发渠道」有误已改口径;`gotry setup` 手动入口;能力层带 ~/.local/bin、~/.staicli/current 候选回退;实时数据仍需用户凭证,未配时静态包为默认) | 实时/静态 | `[实时API:hbcli@ts]` / `[静态包:估算]` | 保持;hbcli UAT 证书恢复即回实时 |
| **酒店点评/评分** | ✅ **复用 hotel-be Anything**(内含酒店 + 城市/区域混合 candidate)+ M4 scale-up:Google Place 评分/照片 | Any(hit/miss),M4:geography | `hbcli-anything` | M3:DONE(founder 校准 Anything 复用);M4:Google Place scale-up 路径(geography GetPlaceReviews) |
| **POI/地点搜索** | ✅ Anything(混合 城市+酒店+place 候选) + OSM Nominatim 兜底 | Any | `hbcli-anything` / M4 `osm-nominatim` | M3:DONE;TREK 同款,免费兜底 |
| **天气/季节性** | ✅ Open-Meteo 已接(`capabilities/weather.ts`:预报≤16 天+历史气候基线;免费无 key;工具 `gotry_weather_check`;2026-08-29 地理编码别名阶梯 `resolvePlace`:产品词表别名优先→原样→去后缀+population 防歧义,「普吉岛」经 Phuket 别名命中) | 实时 | `[实时API:open-meteo@ts]` | 保持;WMO 码已映射中文 |
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
                    │   [已建] weather.ts / opensky.ts / anything.ts│
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

## 4. POI 通用搜索 — Anything 复用优先(founder 校准,2026-08-23)

**当前决策(M3 主路径)**:GoTry 的 POI / 地点 / 酒店搜索**走 hotel-be Anything 函数**——已存在(search/service/geography.go:232),不新增 Places service。Anything 是企业级 FuzzySearch + 混合 城市/酒店 ranking,质量远超 LLM 常识(ADR-10 翻译≠造数禁止)。

```
gotry 插件(gotry_anything_search)
  → ts/capabilities/anything.ts(spawn hbcli search anything)
    → hbcli(external/hotelbyte-cli/src/commands/search.ts:search anything)
      → hotel-be /api/search/anything(公开面,go-zero dispatcher 反射)
        → search/service.Anything 函数(SearchReq{keyword, contentType?, parentDestinationId?})
          → 混合 candidates[city|hotel|place] 返回
            证据链:[实时API:hbcli-anything@ts](hit/miss/error 三值)
```

**Anything 不够时 — Google Place scale-up 路径(M4 后)**:

```
gotry(gotry_place_search 工具, 拟新增)
  → hbcli search place-search "<query>" (拟新增)
    → hotel-be /api/search/googlePlaces/search (拟新增 — geography /SearchPlace 暴露)
      → geography/service/google_service.go:SearchPlace
        → Google Places v1(geography 仓已接个人 API key,按次收费)
```

**Anything vs Google Place 决策矩阵**(M4 决策点 D-4a):

| 选 | Anything | Google Place Scale-up |
|---|---|---|
| 质量 | 企业级 FuzzySearch(ranking 算法 + 缓存) | 评分 / 照片 / 营业时间 |
| 配额 | 无(走酒店-be 内部) | 按次计费(geography 个人 key) |
| 数据更新 | 酒店-be 主仓更新即生效 | Google 实时 |
| 何时选 | 种子用户期 / 任何地方+酒店混合查 | M4 校准数据后升级 |

**当前 Anything 降级链**(L4 不变量,降级不阻塞):
- hbcli 不可达 → verdict=`unavailable` + 证据链 `[实时API:hbcli-anything@error@ts]`
- Anything miss(0 候选) → verdict=`miss` 让 LLM 换搜索词
- agent-reach 是 Anything 再下一级的最后兜底(.shared/skills/,D-4a 决定用不用)

**变更历史**:
- 2026-08-22 段:Google Place 链路定案为唯一路径
- **2026-08-23 段**:founder 锐评「anything 就是 hotel-be 的接口啊」+「hotelbyte-cli / hotel-be 是你的 workspace 范围」,**Anything 复用作主路径**,Google Place scale-up 后置。三仓 commit 闭环 (gotry `244a0ae` + hbcli `43236a0` + hotel-be `c38ff65d1`)。
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
- 证据链标注 `[实时API:hbcli-anything@ts]`(M3 Anything 主路径);M4 scale-up 后才有 `[实时API:hbcli-place@ts]`(Google Place 收费源)与 `[实时API:osm-nominatim@ts]`(OSM 兑底)。

**为什么双轨(OSM 兜底)**:种子用户期配额/凭证不可控;Nominatim/Overpass 免费无 key(TREK 同款),数据薄(无评分/照片)但坐标/名称/类目可用——符合「每域至少一个免费源」原则。

---

## 5. TREK 参考(liketrek/TREK,12.6k★,AGPL-3.0——仅设计参考,零代码复制)

TREK 是自托管协作旅行规划器,数据面成熟度最高,可借鉴的模式:

| 域 | TREK 的做法 | GoTry 采纳 |
|---|---|---|
| POI 搜索 | M3 用 hotel-be Anything(企业级);M4 scale-up Google Places(有 key)+ OSM 兜底;地图探索 OSM-only by design | ✅ M3:DONE(Anything 主路径,OSM 仅作 M4 兑底的兑底);设计原则与 TREK 一致 |
| 天气 | Open-Meteo(免费无 key,16 天预报 + 历史气候回退),WMO 码映射 | ✅ M3 末接同款;历史气候做季节性推荐的数据底座(替 LLM 常识) |
| 地理 | bundled GeoJSON atlas(admin0/admin1 脚本构建,离线可用) | ✅ M4:「去过的地方」地图页复用此模式 |
| 预订导入 | KDE Itinerary(邮件/PDF 解析航班酒店确认单) | ⏸ M5(交易后才有导入需求);gotry 的 bookedResources 锚点可吃这个 |
| AI 接入 | MCP server 暴露 places/weather 工具(带 scopes/权限) | ✅ 已同构——gotry 走 dsh 插件工具面,本质同 MCP 模式 |
| 安全 | 所有外部 fetch 过 SSRF guard | ✅ 采纳进 capabilities 层契约(外部 URL 必须过检查) |

**不采纳**:TREK 的协作/多用户/预算分摊(不是 gotry 的 M3-M5 范围);其 AGPL-3.0 许可证意味着**零代码复制**(design reference only,总纲「不重写也不抄」纪律)。

---

### agent-reach 100% follow → wrapper 化(2026-08-23 落地;2026-08-22 founder 纠偏「wrapper 不是 router」后重构)

**Panniantong/Agent-Reach v1.5.0**(MIT, 74k★)是 installer + doctor + 路由知识(SKILL.md),实际读取由上游工具完成。GoTry 100% follow:

- **CLI 真装**: `.venv/`(python3.11 venv, 单 venv 整合)装上游 `agent-reach` v1.5.0 → `agent-reach doctor` 真跑(4/15 渠道 ready)
- **wrapper 化(2026-08-22 重构)**: 删 300 行 13 渠道 switch —— 渠道枚举/方法选择/setup 文案是在重复上游注册表,且实测已漂移(gotry 写 exa/xhs,上游真名 exa_search/xiaohongshu)。三层分工:
  - 知识 → 上游(`agent_reach.channels` 注册表 + `Channel.check()` 原话 + guides/);决策 → dsh LLM(未知渠道/方法时返回上游自描述清单,LLM 自纠);管道 → gotry(spawn/超时/永不抛错/证据链)
  - `ts/capabilities/agent-reach-bridge.py`: 通用反射桥,`get_channel()`+`getattr()` 直调上游 python API(web.read / v2ex.get_hot_topics / xueqiu.get_stock_quote ...),上游加渠道零改动
  - `ts/capabilities/agent-reach.ts`: 薄壳;needs-setup 文案 = 上游 `check()` 原话透传不转述;CLI 工具型渠道(github→gh/字幕→yt-dlp)仍由专用工具当执行面
- **dsh 工具**: `gotry_agent_reach`(action=status 走真 doctor / action=reach 反射调 `<channel>.<method>`)+ 专用工具 web_search/video_subtitle/github_search
- **证据链**: `[agent-reach:<channel>.<method>@<ts>]` 进 L4 契约

## 6. 证据链标注契约(L4 不变量执行细则)

| 标注 | 语义 | 触发 |
|---|---|---|
| `[实时API:hbcli@<ISO ts>]` | hotel-be 实时(酒店库存;未来含 place) | hbcli 退码 0 |
| `[实时API:hbcli-place@<ts>]` | **M4 scale-up 路径**:Google Place 经 hbcli(收费源,带配额) | place 查询成功 | placeholder, M3 实际走 `[实时API:hbcli-anything@ts]` |
| `[实时API:osm-nominatim@<ts>]` | **M4 scale-up 路径**:OSM 免费兜底 | hbcli 失败/超配额 | placeholder, M3 实际走 `[实时API:hbcli-anything@ts]` |
| `[实时API:opensky@<ts>]` | 航班实时观测(ADS-B 当前快照;OpenSky 匿名路径只支持实时,历史查需鉴权) | OpenSky 命中 |
| `[实时API:open-meteo@<ts>]` | 天气预报(M3 末) | 天气查询成功 |
| `[骨架:openflights]` | 通航性三值(肯定/枢纽对否定≠证伪/枢纽外无结论) | 求解预过滤 |
| `[静态包:估算]` | 公开渠道调研估算,预订前需核实 | 一切降级回退 |

三值语义(通航性专用):**检出=强肯定;枢纽对查空=降权信号,永不排除(骨架滞后会错杀);枢纽集外=无结论**。

---

## 7. 演进(与 roadmap 对齐,本文只列数据侧)

- **M3 末(当前)**:~~Open-Meteo 接入~~ ✅ 已完成(`capabilities/weather.ts` + `gotry_weather_check` 工具,5 断言实测);~~OpenSky 从脚本挂到插件工具面~~ ✅ 已完成(`capabilities/opensky.ts` + `gotry_flight_verify` 工具,3 断言实测)。M3 末数据增量两条全闭环。
- **M4**:`capabilities/place.ts` 双轨(hbcli-place + OSM 兜底);OSRM 时长估算进 transfer;时区库替代手写;汇率免费层。
- **hotel-be 侧依赖(gate)**:search 模块 place OpenAPI + geography 白名单 + `hbcli search place`——三段都在 hotel-be 仓,由该仓 lane 推进;gotry 侧等 `hbcli search place --json` 可用即零改动接上(能力层已留降级位)。
- **M5**:票价(aviationstack 校验层升级);KDE Itinerary 式预订导入(bookedResources 数据源)。

---

## 8. 官方 agent 通道尽调(2026-08-28,RFC `user-session-data-rfc.md` P0)

**飞猪 FlyAI**(`@fly-ai/flyai-cli`,MIT,npx 直跑,**无 key 无登录已实测**):
- 8 工具全只读:`search-flight` / `search-train` / `search-hotel` / `search-poi` / `keyword-search` / `ai-search` / 万豪×2;预订经结果内 `jumpUrl` 跳飞猪完成——**交易不进 skill,与 WriteGate 哲学同构**。
- 实测(2026-08-28,本机):上海→丽江 2026-10-01 机票,春秋 9C6617 浦东 17:05→三义 20:50 ¥1790 等结构化 journeys/segments/ticketPrice JSON;上海→大理火车票,虹桥 10:00 G201 二等→昆明南→大理 22:47 中转链。
- 单行 JSON stdout,agent-native(hbcli 同款形态)。**意义:机票班期/票价与铁路检索的官方免费通道已开——用户会话面的真实缺口收缩为「携程 C 端交叉验证 + 美团本地」;12306 会话需求(G8)大幅弱化**。
- 未明:收费/配额/企业门槛(README 未披露,`FLYAI_API_KEY` 可选增强)。接入形态:`capabilities/flyai.ts` **已落地(P1,2026-08-28)**——spawn CLI 管道层,session-tests F 节 live 断言。
- **限流实测(2026-08-28 下午)**:高频调用后返 `SentinelBlockException by fly-ai-search`(CLI exit=0、stdout 非业务 JSON)——**配额未文档化,恢复窗口未知**;flyai.ts 已把该形态纳入结构化 error(带 stdout 片段),测试/smoke 按「hit 或 sentinel 降级」双合法终态。金标准跑批(fa-01..04)当日被拦,待限流窗口过后由心跳轮重试。**2026-08-29 缺口修复(Issue #24)**:该限流输出是合法 JSON,曾走 `data?.itemList ?? []` 被吞成 0/0 静默 miss——现按形状判别(无 `data.itemList` 即 error),离线回归见 run-all §7b;工具层 summary 三分支(hit/miss/error)+过去日期显式提示。

**会话数据面 P1(RFC §4,2026-08-28)**:`capabilities/session-search.ts` + `session/{transport,read-guard,adapters/ctrip-flight}` 落地——ReadGuard(方法×URL 双因子 + 驼峰复合写词,写请求物理 abort + 审计,fail-closed)+ 携程机票适配器(batchSearch 嗅探→结构化)+ 节律闸(同站 ≥30s);证据链新标注 `[会话:ctrip-flight@ts]` 生效;run-all §24。live 会话检索需 headful(headless 下携程只回壳页,实测)。登录态为存在前提(founder 纠偏 2026-08-28,同日二次纠偏「仍然匿名实例」后**定案 CDP attach 为默认传输**):`openSession(mode=cdp)` attach 日常 Chrome(chrome://inspect/#remote-debugging 一次性开关,Chrome 144+,本机 147 ✓),登录态/指纹=用户本人,ReadGuard 同样生效;`needs-attach`/`needs-login` 双降级 verdict;`scripts/session-attach-diagnose.ts` 校准票据名单(只读不导航);persistent 专用 profile 降为测试/后备(实测:匿名窗口无人会登录,History/Cookies 双 0 行)。

**美团实测边界(2026-08-28 tick)**:匿名实例 hotel.meituan.com 直接 **403**(headful 新 profile)——三站最强反爬,登录态是 403 级硬前置;适配器骨架已落(`adapters/meituan-local.ts`:城市拼音表/登录票据名单/networkHint 占位/a11y 兜底 `extractListings`),真实接口形状待登录态就绪后回填。a11y 兜底抽取器 `session/extract.ts`(快照条目/提交件剔除/nameAffinity)与金标准查询集 `data/session-golden-20.json`(20 条,只增不改)同批落地(run-all §26)。

**携程机票页 XHR 嗅探 PoC**(`ts/scripts/session-attach-poc.ts`,playwright-core 1.62.1 + 专用测试 profile `/tmp/gotry-session-poc-profile`):
- 两次实测均零风控、零交互只读;主搜索接口已识别:`flights.ctrip.com/international/search/api/search/batchSearch`(~550KB,国内票同走)+ `FlightIntlAndInlandLowestPriceSearch` 低价日历(~81KB)——P1 携程适配器的 networkHints 直接可用。



## 修订史

| 日期 | 变更 |
|---|---|
| 2026-08-22 | 立 v1:领域矩阵现状盘点、四层架构图、Google Place 链路 founde 定案(hbcli→search OpenAPI→geography)、TREK 参考采纳表、证据链契约细则、M3-M5 数据侧演进 |
| 2026-08-28 | 新增 §8 官方 agent 通道尽调(RFC P0):飞猪 FlyAI 无 key 实测可用(机/火只读搜索,会话面缺口收缩)+ 携程机票 XHR 嗅探 PoC(batchSearch 接口识别,零风控) |
| 2026-08-29 | Issue #24 工具可用性硬化:flyai Sentinel 合法-JSON 形状由静默 miss 改判 error(§8);weather 地理编码别名阶梯 resolvePlace(§2);hbcli 定性更正(hotelbyte-cli 系公开仓)+ 安装期官方方式自举 + ENOENT 人话化(D-19,§2) |
