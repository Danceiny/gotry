# 用户会话数据面 RFC:用用户自己的账号会话补齐 OTA 检索(待拍板)

> 定位:**「官方通道优先、用户会话补缺」的数据源扩展提案**——回答「不接每家 OTA 的 API,检索数据从哪来」。
> 上游:总纲复用矩阵(`gotry-master-outline.md` §2,本 RFC 即「先改总纲再动工」的那个修订提案)+ `data-sources.md`(数据源唯一权威面,采纳后增补第五层)。
> 调研时窗:2025 下半年 – 2026-08-28(四路:工程模式/GUI agent 能力/合规/产品先例;子代理两路挂掉由主会话补齐,来源见附录)。
> 本文只管数据面;交易(预订/支付)仍属 M5 WriteGate 范畴,**本 RFC 不含任何写路径**。

---

## 0. 摘要与决策请求

**结论先行**:「用用户自己的登录态做只读检索」在 2026 年的工程与合规现实下**可行,但必须以「官方通道优先、会话补缺、只读物理隔离、数据不出本机」四原则落地**。检索型浏览器任务已进入顶级模型甜区(WebVoyager 类 ~88%),DOM/a11y 优先的混合架构有明确业内共识,单次站内检索可压到秒级/两美分级;真正的风险不在技术,在①平台风控对自动化频率的反制、②中国法下「经营者抓取」的边界、③prompt injection(只读 + 物理拦截兜底)。同时调研发现**国内官方通道 2025-2026 真的开了**(飞猪 FlyAI / 携程商旅 MCP / 高德 MCP),应先吃官方免费的,用户会话只补官方覆盖不了的缝(携程 C 端、美团本地、12306)。

**请 founder 拍板三道题**(详见 §5 决策门;**2026-08-28 已结算**:founder 指令「用 loopx 管理这个项目,开始实施」):

| # | 问题 | 推荐 | 决策 |
|---|---|---|---|
| **G7** | 用户会话数据面是否立项(M4 增量,不挤 M4 主线记忆域) | **立项,按 §4 四阶段推进** | ✅ **已立项**(loopx goal `gotry-session-data-goal`,agent `gotry-session-builder`,P0 于同日完成见 §4) |
| **G8** | 12306 是否纳入首批站点适配器 | **暂不纳入**(平台对抗史最烈、刑事判例集中在抢票写侧;等携程/美团链路稳定后单独立项评审) | ✅ **按推荐暂缓**——且 P0 实测飞猪 FlyAI `search-train` 官方通道覆盖火车票检索(上海→大理中转链真数据),12306 会话需求进一步弱化,恢复评审的前提改为「FlyAI 火车票面出现能力缺口」 |
| **G9** | 官方通道尽调先行:飞猪 FlyAI key + 高德 MCP key 申请 | **批准申请动作**(零成本,决定会话面的真实缺口大小) | ✅ **已批并执行**:FlyAI **无 key 已实测可用**(8 工具全只读,机/火车票真实数据;key 为可选增强,申请入口未披露);高德获取步骤已落 `tokens.md`(等 founder 给 key 即配) |

---

## 1. 问题:数据缺口到底在哪(data-sources.md §2 投影)

| 领域 | 现状 | 缺口性质 |
|---|---|---|
| 航班班次/票价 | 静态包(2026-07 调研),OpenSky 只覆盖「已在天上」的 ADS-B | **无实时票价与班期**——用户问「十一北京-大理多少钱」只能答估算 |
| 铁路(12306) | ❌ 无 | 无开放 API,官方对第三方一贯强硬 |
| 携程 C 端/美团本地库存 | hbcli 桥只覆盖 hotel-be 域 | 美团民宿/门票、携程自营打包无来源 |
| 酒店 | hbcli 实时(证书过期降级中) | 有主链路,会话面是备份非主力 |

核心判断:**GoTry 是「可行性引擎 + 证据链」产品,缺实时报价/班期直接伤 M3 exit 指标(定稿率)与 M5 交易闭环**。M5 前无商业供应链,官方自助 API(Amadeus 已关停不回)对中国国内覆盖弱——「用户自己的账号」是目前唯一零商务成本的实时来源。

---

## 2. 业内最佳实践(2025H2–2026-08 调研结论)

### 2.1 能力面:检索型任务在甜区,交易型仍不可托付

- WebVoyager(实时网页检索)顶级:Gemini 2.5 Computer Use 88.9%(2025-10 模型卡)、OpenAI CUA 87.0%;Online-Mind2Web:UI-TARS-2 88.2%(2025-09)。**检索/导航 ~85-90%,含状态变更的交易型掉到 50-65%**(WebArena CUA 58.1%)。
- 2026 代际仍在快速兑现(OSWorld:4 个月 42%→61%;OSWorld 2.0 上 Opus 5 / GPT-5.6 已 60-70% 口径不一,未完全证实)——**架构必须模型可换,不绑死任何一家**。
- 中文 OTA 站点复杂度高于英文基准,按 7-8 折预估。

### 2.2 技术路线:会话复用三通道,GoTry 取「专用 profile 首发」

| 通道 | 机制 | 2026 现状 | 适配度 |
|---|---|---|---|
| A. attach 用户日常 Chrome | Chrome 136(2025-05)起默认 profile 禁用调试端口(安全收紧,App-Bound Encryption 动机链);**Chrome 144+ 恢复官方路径**:`chrome://inspect/#remote-debugging` 用户手动开一次开关即可 attach(chrome-devtools-mcp `--autoConnect` 依赖此) | 要求用户 Chrome ≥144 + 手动开开关;同一时刻仅一个调试客户端 | **⚠ 降级为显式后备(2026-08-30 founder 定案)**:曾为 PRIMARY(2026-08-28),被产品实测推翻—— **详见下方「A. attach 用户日常 Chrome」** |
| B. **专用持久 profile** | Playwright `launchPersistentContext`(或 `channel:'chrome'` 用用户已装 Chrome,零浏览器下载);登录一次跨会话复用 | playwright-mcp 默认模式,最成熟 | **仅测试/后备**(匿名裸窗口实测无人会登录,founder「不能匿名实例」) |
| C. 扩展接管 | **MV3 扩展 + 本地桥**:一次性安装;扩展在**自己的标签页**里被动嗅探站点自身发出的检索响应(请求由站点代码发出,扩展零写行为),经 `127.0.0.1` 长轮询回传 Node;不用 `chrome.debugger`(无警告条) | gotry 自研 `extension/`(GoTry Session Bridge,4 文件零构建,manifest 固定 key=扩展 ID 跨机器稳定)+ Node 侧 `session/extension-bridge.ts`(`node:http` 长轮询桥,零新依赖;origin 白名单防网页跨域) | **✅ PRIMARY(2026-08-30 founder 定案,issue #21 传输层方案 B/C)**:Chrome 系统级弹窗从「每连接 1 次」降为 **0 次**;授权模型=一次性安装(约 30 秒,`npx gotry setup` 落位指引)+ manifest key 派生固定… **详见下方「C. 扩展接管」** |

明确不做:cookie 磁盘库直读(Chrome App-Bound Encryption 已封死)、云端 session 服务(Browserbase Contexts/Steel Profiles——凭证离开本机,违反 local-first 与红线)、**browser-use 生态(Python,违反零 Python 依赖面纪律;npm 上 TS 移植非官方未证实)**、LaVague(2025-01 停更)。**native messaging 宿主**(扩展经 OS 注册表拉起本机进程,更强配对)列为二期备选:安装面更重(需写 NativeMessagingHosts 注册表),当前「回环 + origin 白名单 + 固定扩展 ID」已覆盖单用户本机威胁模型,记入 §5 风险复审触发。

风控暴露面:attach 真实会话 = 用户真实指纹,暴露面最小;Playwright 原生驱动有结构性泄漏(Runtime.enable 自动调用等,rebrowser-patches/Patchright 在修)——**专用 profile + 用户人工首登 + 只读 + 人速节律**是业内标准组合,不需要引入 stealth 系(puppeteer stealth 插件 2023-03 已死)。**绝不自动绕过验证码/滑块**——检测到即停、交还用户,这同时是合规生命线(见 2.4)。

### 2.3 抽取与维护:三层降级,XHR 嗅探是检索型隐藏王牌

业内共识:**DOM/a11y 优先(便宜、快、确定),视觉兜底(新站点/反爬混淆/canvas),截图只做结果校验**。纯 computer-use 截图流对检索场景是过度杀伤(2-5s/步 vs a11y <100ms/步)。

```
① XHR/fetch 页面内嗅探(首选)——请求由站点自己发出,只读响应;
   JSON 结构比 DOM 稳一个数量级,对 UI 改版免疫(只怕接口改版)
   先例:12306 leftTicket/query* JSON 被开源生态用了多年
② a11y 快照 + 结构化 extract(站点无干净 JSON 时;Zod schema 约束输出)
③ 视觉模型兜底(长尾/改版期;仅在 ①② 失效)
反模式红线:绝不脱离页面上下文伪造/重放站内 API(撞签名+设备指纹校验,且是「绕过反爬」的司法重灾区)
```

剧本维护:自建轻量 **action 缓存 + 失效回退**(Stagehand 云端缓存思路的本地化:key=指令+DOM 指纹 → 确定性 locator;miss 即回退 LLM 重定位并回写;「错误的缓存点击比慢更糟」)。Stagehand v4 的缓存/self-heal 只在 Browserbase 云端可用,本地需自建——这正是 gotry 的自研增量点。OTA 结果页是最高频 AB 迭代面,XHR 嗅探把维护面从「UI 改版」降到「接口改版」。

### 2.4 合规面:三重边界(工程研究,非法务意见)

**美/欧**:hiQ v. LinkedIn 终局——CFAA 面赢(公开数据抓取不构成「越权」)但 2022-12 和解、hiQ 永久停抓:**赢了法理输了生意**。Ryanair v. Booking.com:2024-07 特拉华陪审团判 Booking 违反 CFAA,2025-01 法官 JMOL **推翻陪审团裁决**——平台用 CFAA 打抓取的路被打回去,但 Ryanair 系(爱尔兰/德国禁令、CJEU PR Aviation 2015 允许以 ToS 限制)显示 OTA/航司的诉讼意志极强。Air Canada v. Seats.aero:2024-03 初步禁令被拒,2025 反垄断反诉——但该案是**中心化服务器规模化抓取 26.5 万条**,与「每用户本机、自己会话、只回显本人」分布式的 GoTry 模式有本质差异,这正是我们的设计辩护点。

**中国**(首发市场,最重要):《网络反不正当竞争暂行规定》§19(2024-09 施行,已被反法修订草案吸收)禁止「利用技术手段非法获取、使用其他经营者合法持有的数据」——规制对象是**经营者之间的数据搬运与竞争性使用**(判例:大众点评 v 百度式);GoTry 的「检索结果只回显用户本人、不沉淀共享库、数据不出本机」刻意留在该条射程外。刑事红线(非法获取计算机信息系统数据罪)的全部公开判例共同特征:**绕过反爬措施(伪造 device_id/破解验证)+ 牟利(代抢/售卖工具)**——2025-08 上海静安代抢 12306 案、丁某案、大麦案、晟品案无一例外。
- PIPL 侧「用户委托处理自己的数据」有明确空间,要件是明示授权 + 最小化 + 可撤回。**合规四支柱(进代码,不进 PPT):①只读零写;②不绕过任何反爬(验证码出现 = 停 + 交还用户);③检索结果不进任何共享存储(经验回流只回流「断言级结论」且脱敏,见 §3.6);④用户明示授权 + 站点白名单 + 随时可关。**

### 2.5 竞争与替代:官方通道 2025-2026 在中国开了

- **飞猪 FlyAI 开放平台**(flyai.open.fliggy.com;CLI `@fly-ai/flyai-cli`,skill 仓 `alibaba-flyai/flyai-skill`):机/酒/景/度假全场景,「实时直连官方商品库」,OpenClaw skill 一行安装(`npx skills add alibaba-flyai/flyai-skill`)。
  - **P0 实测(2026-08-28,无 key 无登录)**:8 工具全只读(search-flight/search-train/search-hotel/search-poi/keyword/ai/万豪×2,无任何预订原语,交易经 jumpUrl 跳飞猪由人完成);`search-flight --origin 上海 --destination 丽江 --dep-date 2026-10-01` 返结构化 journeys/segments/ticketPrice(春秋 9C6617 ¥1790 起),`search-train` 返真实中转链(虹桥 G201→昆明南→大理)。
  - 单行 JSON stdout,agent-native(hbcli 同款形态);收费/配额/门槛 README 未披露,key 为可选增强。
- 携程商旅 MCP(企业 AI 对接,差旅域);高德 MCP Server(POI/地图/路线,与通义灵码/TRAE 集成,免费额度)——高德可即时增强 gotry 现有 map 面。
- 里程工具先例的反面教材:AwardWallet 被 American Airlines 封锁访问、航司普遍加 2FA 墙——**平台技术反制是常态,任何单一通道都要按「可被掐断」设计**。

**结论:数据面排序 = 官方免费通道(hbcli/飞猪FlyAI/高德MCP/OpenSky/Open-Meteo)→ 用户会话补缺(携程C端/美团/未来12306)→ 静态包兜底**。用户会话是桥,不是终局;终局是 M5 供应链或官方 agent 通道全面开放。

### 2.6 安全:prompt injection 不可完全解决,只读是唯一兜底

Comet 事故(Brave 2025-08 披露,Reddit 评论藏注入→跨站接管账户)证明 SOP/CORS 对 agentic 浏览器失效;Anthropic 红队:注入成功率 23.6%→11.2%(有防护),OpenAI 官方承认「 unlikely to ever be fully solved」。**对策不是更好的模型,是更小的爆炸半径**:只读白名单动作集 + 交易端点在传输层物理拦截 + 页面内容进模型前打不可信标注 + 结构化任务意图(站点+查询词+字段)偏离即中止。gotry 的 WriteGate 红线在这里提前兑现为 **ReadGuard**(见 §3.3)。

---

## 3. 方案:五层数据面与用户会话能力设计

### 3.1 数据源层级升维(data-sources.md 采纳后改五层)

```
静态包 → 免费实时(OpenSky/Open-Meteo)→ hbcli 桥(hotel-be)→ 【新】官方 agent 通道(飞猪FlyAI/高德MCP)→ 【新】用户会话补缺
```

领域矩阵增量(P0 后修正——**机票/铁路主链路改走 FlyAI 官方通道,会话面收缩为交叉验证与官方盲区**):

| 领域 | 主链路(P0 后) | 会话面动作 | 证据链标注 |
|---|---|---|---|
| 航班班次/票价 | **FlyAI `search-flight`(官方,无 key)**;OpenSky 观测;静态包对账 | 携程机票页嗅探,与 FlyAI **交叉验证**(P1 天然对账 oracle:双源同查询一致性断言) | `[实时API:flyai@ts]` / `[会话:ctrip-flight@ts]` |
| 铁路 12306 | **FlyAI `search-train`(官方;匿名试用额度共享易达限,2026-09-02 勘误)** | **已实装(2026-09-03)**:kyfw leftTicket 后台标签被动嗅探(余票/时刻/历时,列表接口无票价如实呈现);公开查询面无登录闸;电报码与座位桶索引**第一方校准完成**(2026-09-03,官方 station_name.js 129 城 + queryLeftTicket cN 转换函数,快照防漂移测试锁定,曾纠出南宁 NIZ→NNZ 错码) | `[实时API:flyai@ts]` / `[会话:train-12306@ts]` |
| 美团本地(民宿/门票) | ❌ 无官方通道(盲区) | 站内搜索嗅探 | `[会话:meituan@ts]` |
| 酒店 | hbcli(hotel-be)+ FlyAI `search-hotel`(试用额度共享易达限,2026-09-02 勘误)| **已实装(2026-09-03)**:hotels.ctrip.com 后台标签被动嗅探(URL hint + 形状签名兜底),用户本人登录态真实价;城市码表 35 城实测校准(2026-09-03,页面 title 逐条验证;迪拜=220 等),接口路径一方确认(restapi/soa2/34951/fetchHotelList),价格字段路径随首个真会话终验 | `[实时API:hbcli@ts]` / `[实时API:flyai@ts]` / `[会话:ctrip-hotel@ts]` |

新标注语义(L4 契约增补):`[会话:site@ts]` = **用户本人会话内实时检索,非官方 API,价格/库存以站点页面为准**——与 `[实时API]`/`[静态包:估算]` 三分,新鲜度同实时、权威性低于官方 API(命中过滑块的查询结果要标 `degraded`)。

### 3.2 代码形态(对齐现有分层)

```
ts/capabilities/flyai.ts            官方通道:P0 新增优先级——spawn @fly-ai/flyai-cli(npx),search-flight/search-train 先接,
                                     管道层对齐 agent-reach 模式(超时/永不抛错/证据链);P1 与会话骨架同批落地
                                     【2026-08-29 第二批实装:kind=flight|train|hotel——search-hotel 已接(打码价
                                     priceRaw 保真,真实价经 detailUrl 由人完成),OTA 工具面平铺(无主/降级路由)】
ts/capabilities/session-search.ts    会话面传输层编排:车道选择(扩展默认/cdp 显式/persistent 测试)→ navigate → sniff
                                     → extract → guard → 证据链;resolveTransportMode 纯函数
ts/capabilities/session/
  extension-bridge.ts  本地桥(2026-08-30,零新依赖):node:http 懒单例,只绑 127.0.0.1,端口池 8791-8795
                       (与 manifest host_permissions 一一对应);origin 白名单(固定扩展 ID);/jobs 长轮询
                       (hold ≤20s < MV3 SW 30s 存活窗口)/ /results 回包(≤8MB)/ /health 心跳/ /status 诊断;
                       queued+inFlight 双表(取活即迁,回包按 jobId 路由);parked 即时派发(新 job 免等一个轮询周期)
  extension-channel.ts 车道客户端:cookie-names(票据**名字**,协议面无值字段)/ open-login(置前台留用户)/
                       search(被动嗅探回包)三 job 封装;classifyBridgeFailure 纯函数(仅 extension-not-connected
                       是用户门 → needs-extension,其余降级 error)
  transport.ts         CDPAttachTransport(cdp 显式 opt-in 后备:DevToolsActivePort 发现 + puppeteer-core
                       connect;Chrome 144+ 每连接弹权限框——因此降级);persistent=测试隔离 profile
  read-guard.ts        ReadGuard(CDP 车道):网络层写请求拦截 + DOM 提交按钮黑名单,fail-closed,全量审计日志
  adapters/<site>.ts  站点适配器:{ entry, searchForm locators, networkHints[{urlPattern,parser}], a11yFallback, cooldown }
                      首个适配器=携程机票(PoC 已识别 networkHints:search/batchSearch + FlightIntlAndInlandLowestPriceSearch)
  action-cache.ts     本地动作缓存:key=指令+DOM 指纹 → 确定性 locator;miss 回退 LLM 重定位并回写
extension/             GoTry Session Bridge(MV3,零构建):manifest(固定 key)/background.js(长轮询 SW:
                       search 后台标签+收尾关自己页/open-login 置前台留用户/cookie-names 只取名字值即弃)/
                       content-main.js(MAIN world hook fetch/XHR,NETWORK_HINTS 命中→CustomEvent)/
                       content-bridge.js(ISOLATED world,CustomEvent↔chrome.runtime)
ts/src/index.ts       新 dsh 工具 gotry_session_search(site, query, dateSlots) → 平封 envelope(ADR-13 同构)
```

依赖:传输层自身**零新依赖**(扩展=纯 JS 零构建;桥=node:http 手写,不引 ws——MV3 SW 靠 ≤20s 长轮询节奏维持存活,HTTP 够用;publish-preverify 依赖声明闸亦不允许偷用传递依赖);cdp 后备车道保留 puppeteer-core 可选依赖(动态 import 缺包优雅降级)。

### 3.3 Onboarding UX(2026-09-02 商店上架后重设:职责返交)

**立场反转**:上版「3 次点击 + 0 次终端命令」的 UX 形态看似用户友好,实则 gotry 越界管起了浏览器(`open -a "Google Chrome"` 弹窗、`pbcopy`/`xclip` 动剪贴板、`osascript -e 'display dialog ...'` / `zenity` 抢 GUI)与 dsh 渲染层(用 stdout 文字墙代替 verdict)。LLM 由 dsh 管理、扩展安装由浏览器商店管、CLI 自举由 `gotry setup` 管——三条职责原本就分清。

**新形态**(2026-09-02 Chrome Web Store 上架后立刻落地):

- **安装 = 浏览器的事**:用户去 [Chrome 应用商店](https://chromewebstore.google.com/detail/gotry-session-bridge/oeajpiccmonococjcegddlooeeohlbgd) 点「添加至 Chrome」,**0 终端命令、0 gotry CLI 介入**。自动更新归商店。
- **渲染 = dsh UI 的事**:gotry `sessionFlightSearch` / `sessionLogin` 在 `needs-extension` 时返回 verdict 字段:
  ```ts
  { verdict: 'needs-extension', installUrl: 'https://chromewebstore.google.com/detail/...', installAction: 'add-to-chrome' }
  ```
  dsh 原生 presentResult 层把 `installUrl` 渲成可点链接(网页里直接 `<a href target=_blank>`);gotry 不再写「请打开 chrome://extensions...」的 CLI 文字墙。
- **`gotry setup wizard` 子命令**退化为**离线健康探活等待**(纯 stdout,不动剪贴板/不开浏览器/不弹 GUI)。用户在 dsh UI 里看到 needs-extension 链接时,可能顺手在终端敲 `npx gotry setup wizard` 等扩展一跳就连上;纯 Node:detect → wait → exit 0/1。

**自动重放(health-watch 仍保留,Node 端职责合理)**:首次 `sessionFlightSearch` 遇 `needs-extension` 时,默认启动 ≤120s 有界后台轮询(`intervalMs=5000`),扩展一就位**自动重放同一 query_id 同一参数**——用户装完无需自己重跑命令。**`sessionFlightSearch({immediate:true})` 显式 opt-out,跳过 watch**。

**离线合同(测试可固化,run-all §40)**:

- (1) `gotry setup wizard --dry-run` 零网络零浏览器零剪贴板零 GUI spawn,只校验命令输出与退出码(2 步:ensure + watch precheck)
- (2) health-watch 三时序分支:0ms ready / 5s ready(中途 ready)/ 120s+1ms 超时
- (3) wizard 不调任何 `spawn`(`open / pbcopy / xclip / osascript / zenity / msg / clip` 全退役);手工失败(fail 路径)同样不调 spawn
- (4) 单条 query 的 retry-after-watch:watch 内 ready → 自动重放同一 query_id,产物命中同一 evidence 文件
- (5) `sessionFlightSearch` / `sessionLogin` 在 `needs-extension` 时返回的 verdict 含 `installUrl` + `installAction:'add-to-chrome'`,可被 dsh UI 直接渲染成可点链接

**与现有约束的勾稽**:

- §3.2 传输层零新依赖纪律:osascript/pbcopy/zenity/xclip/clip 全退役,wizard.ts 不再有 `spawn` import;health-watch 是 Node http 轮询,职责内
- §3.3 ReadGuard 不变:onboarding 不碰任何 cookie 值,只验证扩展心跳与登录态 cookie 名存在性
- ⑤ 登录产品化不变:shopper 在 dsh UI 里点 `gotry_session_login` 由扩展在用户 Chrome 弹登录入口,跟商店安装是同一条扩展的两种用途

**§3.3 历史形态对比**:

| | 2026-08-30 初版(撤销) | 2026-09-02 上架后(现行) |
|---|---|---|
| 安装入口 | `npx gotry setup wizard`(5 步 GUI 编排) | Chrome 应用商店一键装 |
| CLI 行为 | open Chrome / pbcopy / osascript / zenity | 只输出 stdout |
| needs-extension 渲染 | CLI stdout 一墙文字 + 用户自己操作 | dsh UI verdict.installUrl 可点链接 |
| 用户侧动作 | 3 次点击(开发者模式 + 加载 + 添加) | 1 次点击(添加至 Chrome)+ dsh 自动 retry |
- §3.4 授权闸 v2:onboarding 完成后首条 session 检索仍过 `tools/pre-execute` (session-consent.ts) 审批卡一次——onboarding 只解决「能跑」,不替代「会话内明示授权」
- §2.4 合规四支柱:「随时可关」门加倍——扩展卡片开关 + `GOTRY_SETUP_EXTENSION=0` + `sessionAccess: off` 三重
- §6 复用矩阵同步:`browser-use | — | 明确不引入(Python 违纪,且其隔离 Chromium ≠ 用户桌面 Chrome,装不到目标扩展,假象)`——把「为什么用 browser-use 也装不了扩展」写明,免得反复来问

**分发通道(2026-08-30 增补,ADR-21;founder 指令「产物下载和安装也得做成更好的用户体验,可以用 github 作为分发渠道」)**:

- **平台约束(设计前提)**:Chrome 禁止非商店 CRX 直装——GitHub 只能改善「下载」,消不掉「开发者模式加载已解压」的 3 次点击;一键装 + 自动更新只有 Chrome Web Store。
- **通道 A(GitHub Releases,已落)**:
  - `gotry setup --extension-from=github`(env `GOTRY_EXTENSION_SOURCE` 等效;默认 bundled 保离线确定性)。下载链:Releases 稳定资产名三件套(`gotry-session-bridge.tar.gz` / `-store.zip` / `extension-dist-manifest.json`)→ SHA256 → 固定 key 钉扎(通道产物与 bundled 不同 key 即拒装,防扩展 ID/端口池/host 权限漂移)→ 版本比较 → 原子交换 `~/.gotry/extension`;任何失败显式降级 bundled,不挡 setup。
  - `GOTRY_EXTENSION_RELEASE_BASE` 可覆盖基址(镜像/测试)。信任边界 = TLS + 同源哈希完整性,非独立 pinning(见 ADR-21)。
- **通道 B(Chrome Web Store,材料就绪未提交)**:`docs/extension-webstore-submission.md`(单一用途声明/权限逐条理由/隐私披露/文案/founder 清单)+ `docs/extension-privacy.md`(隐私政策);注册与提交归 founder(D-25)。过审后 wizard 增补「已装商店版跳过 dev-mode 三步」检测。
- **离线合同(run-all §43,35 断言)**:资产名/URL 合同 + 打包脚本防漂移 / dist-manifest fail-closed / 版本比较 / 回环 e2e 六态(installed·up-to-date·check-only·坏 SHA·无网·key 漂移)/ CLI 单行 JSON 契约;bootstrap-tests 8/8 含「不可达基址即时降级 + 非法参数回落 bundled」。

### 3.4 ReadGuard(写操作的物理不可能性,不只是承诺)

1. **网络层**:CDP Fetch/Network 域拦截——deny-list(POST/PUT/DELETE + URL 模式 `/order|/pay|/submit|/trade|/booking`)命中即 abort 请求并落盘审计(`session-incidents.jsonl`,对齐 incident-log 惯例);
2. **DOM 层**:提交类按钮(role=button 且文本命中 下单/支付/预订/提交订单)从 a11y 快照中**直接剔除**——模型根本看不到可点击的提交件;
3. **动作层**:工具面只暴露 navigate/fill-search/click-result 三类动作语义,无 submit 原语;
4. fail-closed:guard 未初始化成功的会话不允许发起任何导航。

这是 WriteGate(L0-L4)在检索态的镜像:**写不是「被禁止的行为」,是「不存在的原语」**。

**守卫模型按车道分形(2026-08-30 传输层定案增补)**:
- **扩展车道(PRIMARY)**:物理只读由「扩展自身零写行为」承担——background SW 绝不向站点发任何请求(全部 fetch 只指向 127.0.0.1 桥,run-all §38 代码面断言),只「导航到白名单域 job URL + 被动转发 NETWORK_HINTS 命中响应」;请求级 abort 不存在也不需要(agent 从不注入交互,页面请求全由站点自己发出)。fail-closed 不变量=「桥/扩展未握手即 verdict,零花费」(`needs-extension`,有界等待,不静默回退 CDP)。
- **cdp 车道(显式后备)**:保留 §3.3 原四层——puppeteer 请求拦截 classifyRequest 双因子 abort + 审计 JSONL + fail-closed(guard 装不上整会话打不开)。
- 两侧共享:审计同落 `session-incidents.jsonl`(扩展 job 以 `kind:'extension-session-job'` 区分)、`evaluateDoubleSource` 的 `read_guard_blocked!=0 → guard_violation/no_spend_stop` 不变、`needs-extension` → `waiting_extension`(waiting-* 同族 no-spend)。

**人机共治标签页纪律(2026-08-29)**:检索与登录引导一律开**独立新标签页**(登录页置前台、留在用户侧),绝不导航用户既有标签页——浏览器属于用户,我们只动自己开的页(扩展车道:检索后台标签收尾自动关、登录标签留给用户;CDP 车道:收尾只关自己的页+断开连接);live 探针默认关(`GOTRY_SESSION_LIVE=1` opt-in),测试永不自动开窗。

### 3.5 节律与熔断(把「像人」做成代码)

- 站内查询间隔 ≥30s、单会话 ≤10 次、日上限可配(`GOTRY_SESSION_*` 环境变量);
- 检测到滑块/验证码/风控跳转:**立即熔断 + 冷却 + 通知用户人工处理**——绝不重试、绝不绕过(合规支柱②);
- **授权闸 v2(支柱④进代码,2026-08-29 第二批落地、同日按 founder 实测改会话内一次)**:
  - 动用用户本人登录态的工具(`gotry_session_search`)经 dsh `tools/pre-execute`(`session-consent.ts`)在**每会话每站点首次调用**时请求 `ApprovalService` 审批卡授权;allowed-once 记入会话 granted 集(会话内免再弹),rejected/cancelled 记入 denied = **本会话吊销**(不弹卡不执行——拒绝是裁决,不反复骚扰);无审批通道一律 fail-closed(headless 无用户在场 = 无授权——「明示授权 + 可撤回」的运行时具象);
  - 插件 config `sessionAccess: ask|allow|off`(随时可关/预授权/总闸);站点白名单=适配器注册表现状(仅 ctrip-flight)。**首版逐调用弹卡经 founder 实测判为骚扰(「每次都要弹,经常无法点击」),当日改会话内一次**。**飞猪匿名通道不过闸**(调用不携带用户身份,无账号风控/PIPL 处理面;其对用户的义务由「只读 + jumpUrl 人完成交易 + 配额限流结构化 error」覆盖);session-tests §I 断言;
- **登录 bootstrap 真脚本(2026-08-29)**:`scripts/session-login.ts`——attach 用户日常 Chrome → 打开登录入口标签 → 人登录 → 只读轮询票据 cookie 名(不读值不碰凭证),`needs-login` 文案指向它;**测试永不自动开浏览器窗口**(session-tests live 节 GOTRY_SESSION_LIVE=1 opt-in——founder 反馈「匿名窗口反复打开携程/界面闪退」= 测试骚扰,当日根治);
- 专用 profile 首发不落 cookie 库;登录永由用户人工完成(agent 不碰密码/OTP/验证码,对齐 Operator 的 takeover 模式与总纲 3.5「敏感信息模型永不接触」)。**2026-08-28 founder 纠偏落地:「打开浏览器必须有登录态,不能是匿名实例」**——默认 profile 挪 `~/.gotry/session-profile`(持久,登录态不丢);`sessionFlightSearch` 登录闸:匿名默认拒(verdict=`needs-login`),`scripts/session-login.ts` 首登 bootstrap(人工登录,轮询票据 cookie);
  - `allowAnonymous` 仅限链路自检且证据链标 `anonymous=自检态`。远期若需 profile 迁移:AES-GCM 落盘 + 密钥进 OS keychain(macOS `security`/Windows DPAPI/Linux libsecret;keytar 已死不用),0600 权限。

### 3.6 注入防护

页面文本进 LLM 前统一包不可信围栏(`<<UNTRUSTED_PAGE_CONTENT>>`,指令剥离 + 长度上限);检索任务携带结构化意图 {site, query, fields},解析输出过 Zod schema,超纲字段丢弃;结果卡片渲染前二次校验(价格/时刻格式与 sanity 范围)。

### 3.7 数据边界(与共享经验层的防火墙)

会话检索结果**只存在于当前会话上下文与本地缓存(TTL 短,仅去重用)**;M4 经验回流/愿望池**不得引用会话原始数据**,只允许用户确认过的断言级结论(「十一大理机票 ¥1600 级」)且不含账号可归因信息。这条进 memory-utility 的 merge 守门 P0 断言。

---

## 4. 落地计划(四阶段,每阶段可独立叫停)

| 阶段 | 状态 | 预算 |
|---|---|---|
| **P0 尽调** ✅ **2026-08-28 完成** | 见 §4「P0 尽调」 | 1-2 tick,零外部成本(实用 1 tick) |
| **P1 骨架** ✅ **2026-08-28 完成** | 见 §4「P1 骨架」 | 2-3 tick(实用 1 tick) |
| **P2 面上** ◐ 2026-08-28 主体完成(余项待登录态) | 见 §4「P2 面上」 | 2-3 tick(实用 3 tick) |
| **P3 产品化** ◐ 2026-08-28 切片 1/2 完成 | 见 §4「P3 产品化」 | 2 tick(实用 2 tick) |
| **P3.5 传输层定案:扩展桥** ✅ **2026-08-30 完成(方案 C 升 PRIMARY)** | 见 §4「P3.5 传输层定案:扩展桥」 | 1 tick |
| **P4 分发通道(ADR-21)** ✅ **2026-08-30 完成(通道 A 落地;通道 B 材料就绪待 founder 提交)** | 见 §4「P4 分发通道(ADR-21)」 | 1 tick |
| **P3.6 Onboarding UX(2026-09-02 职责返交重设)** ✅ **2026-09-02 完成(wizard 退化为离线健康探活等待;安装归浏览器、渲染归 dsh UI)** | 见 §4「P3.6 Onboarding UX(2026-09-02 职责返交重设)」 | 0 tick(职责返交,不再新编功能) |
| **P3.7 双源 e2e 真跑批(goal 2)** ✅ **2026-08-30 完成(commit `60669f8` + PR #66 follow-up)** | 见 §4「P3.7 双源 e2e 真跑批(goal 2)」 | 1 tick |
| **P3.8 Issue #67 static vendor + 默认桥生命周期** ✅ **2026-08-30** | 见 §4「P3.8 Issue #67 static vendor + 默认桥生命周期」 | 1 tick |

#### P0 尽调

**状态**:**P0 尽调** ✅ **2026-08-28 完成**

**内容**:①飞猪 FlyAI key 申请+只读能力探测(决定会话面真实缺口);②高德 MCP key;③本机 Chrome attach PoC(~30 行:连专用 profile 打开携程机票页,嗅探 1 条 XHR 并打印 JSON);④G7/G8/G9 决策回填本 RFC

**Exit(验收口径)**:**已达成**:①FlyAI 无 key 实测可用,8 工具全只读,机/火车票官方通道开(备忘进 data-sources.md §8);②高德获取步骤落 tokens.md(等 key);③PoC 两轮零风控零交互,主接口已识别(`search/batchSearch` ~550KB + 低价日历 ~81KB,脚本 `ts/scripts/session-attach-poc.ts`,playwright-core 1.62.1 devDep);④本节决策表已结算。**结论修正:机票/铁路主链路改走 FlyAI,会话面收缩为「携程 C 端交叉验证 + 美团本地 + 官方通道盲区」**

#### P1 骨架

**状态**:**P1 骨架** ✅ **2026-08-28 完成**

**内容**:transport + ReadGuard + adapter 接口 + 首个适配器(**携程机票**,携程 C 端覆盖最优先且与现有航班静态包直接对账);证据链 `[会话:*]`;隔离 stateRoot 测试(对齐巡检状态纪律,绝不动 dsh-runtime 真实状态)

**Exit(验收口径)**:
- **已达成**:`capabilities/flyai.ts`(官方通道)+ `capabilities/session-search.ts` + `session/{transport,read-guard,adapters/ctrip-flight}` 五件落地;`session-tests.ts` 25 断言全绿(ReadGuard 双因子/驼峰复合写词/fixture 解析/城市码表三值/节律闸 cooldown/live FlyAI hit/live 会话嗅探 hit+guard 零拦截+审计文件不出现);run-all §24 全栈 ALL GREEN;
- 双源对照首记录(FlyAI ¥230 vs 会话 ¥1611)——**价差已解释(2026-08-28):FlyAI 最低价为南京中转+跨天衔接链(浦东23:00→禄口23:55→次日17:00→三义),携程首屏 ¥1611 为直达档;双源对照断言口径=按 journeyType(直达/中转)分桶、逐段日期对齐后再比**,价差本身即交叉验证的价值论据

#### P2 面上

**状态**:**P2 面上** ◐ 2026-08-28 主体完成(余项待登录态)

**内容**:action-cache 自愈层 ✅(run-all §26);美团适配器骨架+a11y 兜底抽取器 ✅(§27;**匿名 403 实测——登录态是 403 级硬前置,networkHint 待登录后回填**);金标准 20 查询集 ✅ + flyai 基线 ✅(fa-01..04:e2e §14,含 miss 三值活例与火车价打码发现);**#21 字段 fixture scorer/双源合同/waiting-attach no-spend ✅**(`session/benchmark.ts`,run-all §25);飞猪无需会话适配器(FlyAI 官方覆盖);真实 sf-01..08 字段级 ≥90% 跑批仍待登录态

**Exit(验收口径)**:fixture 合同已纳入确定性回归;真实跑批仍需 Chrome 权限确认和 CDP 握手

#### P3 产品化

**状态**:**P3 产品化** ◐ 2026-08-28 切片 1/2 完成

**内容**:`gotry_flyai_search`+`gotry_session_search` 双工具 ✅(17 工具,smoke §12,hit/限流双合法终态);人格契约 **(19) 三级路由** ✅(仓根 yml,直达/中转分桶);e2e §14 实证记录 ✅;architecture §1/§3/§10、data-sources §8、roadmap ✅,README 无工具清单免同步,stage1 显式让渡;run-all §25-27 全绿

**Exit(验收口径)**:真模型 e2e **flyai 侧 ✅**(e2e §15,8ddb997:真模型实际调用 flyai 工具,三源证据链并存,多 lane 协同实证);**待登录态**:真模型 e2e session 侧一例 + 双源 sf-01..08 跑批(风控触发次数=0 实测期口径同此)

#### P3.5 传输层定案:扩展桥

**状态**:**P3.5 传输层定案:扩展桥** ✅ **2026-08-30 完成(方案 C 升 PRIMARY)**

**内容**:
- **动因(founder 实测)**:「Chrome attach 逐连接权限框太频繁,根本无法使用」——chrome-devtools-mcp #825 实锤 Chrome 144+ 每连接弹框且无持久化批准,CDP 路线对产品不可用。落地:`extension/` GoTry Session Bridge(MV3 四文件零构建,manifest 固定 key=扩展 ID 稳定;SW 长轮询;MAIN-world 嗅探;
- cookie-names 只取名字)+ `session/extension-bridge.ts`(node:http 回环桥,零新依赖,origin 白名单,长轮询 <20s 维持 SW 存活)+ `extension-channel.ts` 三 job 封装 + session-search/login 车道路由(扩展默认,cdp 显式 `GOTRY_SESSION_TRANSPORT=cdp`,不静默回退)+ `gotry setup` 扩展落位(~/.gotry/extension,幂等,GOTRY_SETUP_EXTENSION=0 可跳)

**Exit(验收口径)**:系统弹窗 0 次/会话;run-all §38 全离线合同 23 断言(manifest/固定 ID 派生/Node↔扩展常量防漂移/origin 403/长轮询幂等/心跳/闭环/超时/needs-extension no-spend/waiting_extension);bootstrap-tests 5/5;会话面既有套件全绿;真实 sf-01..08 双源跑批待用户一次性装扩展后收尾(门禁从「开调试端口+每连接点框」降为「装一次扩展」)

#### P4 分发通道(ADR-21)

**状态**:**P4 分发通道(ADR-21)** ✅ **2026-08-30 完成(通道 A 落地;通道 B 材料就绪待 founder 提交)**

**内容**:**动因(founder 指令「产物下载和安装也得做成更好的用户体验,可以用 github 作为分发渠道」)**:Chrome 平台约束下双通道分工——GitHub Releases 只能改善下载,一键装+自动更新只有商店

**Exit(验收口径)**:通道 A:`--extension-from=github` 下载链(稳定资产名/SHA256/key 钉扎/原子交换/失败降级 bundled)+ `scripts/package-extension.mjs` 打包(只产产物,上传确认制);通道 B:`docs/extension-webstore-submission.md` + `docs/extension-privacy.md`(D-25 赎回条件=founder 注册+提审);run-all §43 35 断言 + bootstrap-tests 8/8

#### P3.6 Onboarding UX(2026-09-02 职责返交重设)

**状态**:**P3.6 职责返交** ✅ **2026-09-02 完成(Chrome Web Store 上架 → gotry 不再介入浏览器)**

**内容**:
- **动因(founder 反思)**:上版「3 次点击 + 0 次终端命令」的 UX 形态看似用户友好,实则 gotry 越界管起了浏览器(`open -a "Google Chrome"` 弹窗、`pbcopy`/`xclip` 动剪贴板、`osascript -e 'display dialog ...'` / `zenity` 抢 GUI)与 dsh 渲染层(stdout 文字墙代替 verdict)。LLM 由 dsh 管理、扩展由浏览器商店管、CLI 自举由 gotry setup 管——三条职责原本就分清。
- **新形态**:安装=浏览器的事(去 Chrome 应用商店点「添加至 Chrome」);渲染=dsh UI 的事(`sessionFlightSearch`/`sessionLogin` 在 `needs-extension` 时返回 verdict.installUrl,dsh 原生 presentResult 层渲可点链接);`gotry setup wizard` 子命令退化为离线健康探活等待(纯 stdout,不动剪贴板/不开浏览器/不弹 GUI)。
- `health-watch`(≤120s 有界后台轮询,扩展一就位**自动重放同一 query**,用户零手工重跑)——这是 Node 端职责,保留;`GOTRY_SESSION_LIVE=0` 总闸 + `sessionAccess` + 扩展卡片三重总闸不变。

**Exit(验收口径)**:
- run-all §40 onboarding-tests **9/9**(已重设:--dry-run 零网络零 GUI / health-watch 三时序 / wizard 不调任何 spawn / retry-after-watch 同 query_id 重放 / wizard 不依赖 platform/panel 参数 / withAutoRetry 端到端 / 探针边界常量 / extensionDir 契约 / 不存在目录不抛);bootstrap-tests 8/8(wizard dry-run + 真实路径 + 扩展分发两条)。
- **前置依赖**:P3.5 已 ✅;**后续 goal**:无(去 3.3 重设已闭合 UX 债务)。

#### P3.7 双源 e2e 真跑批(goal 2)

**状态**:**P3.7 双源 e2e 真跑批(goal 2)** ✅ **2026-08-30 完成(commit `60669f8` + PR #66 follow-up)**

**内容**:
- **动因(founder 实问「flyai 只是一个 vendor,可以切别的?」)**:上一批 P3.6 后跑批发现 FlyAI Trial limit reached(`Trial limit reached. Please visit the console at flyai.open.fliggy.com to get a formal API Key`),字段评分无对照源 → 改**可插拨 official golden**:① 默认 manual-golden(`ts/data/sf-golden-manifest.json` 公开班期 + 价格带,零网络零 vendor);
- ② `--golden=flyai` 显式切回 FlyAI(hbcli / 其他官方通道可同理接入);③ 字段评分改**软命中**(硬字段 query_id/from/to/currency/source/verdict 必中,软字段时间窗口 ±60min / 价格带 ±15% / 班次子串匹配 known_flights)。**官方通道尽调(2026-08-30)**:`hbcli` 只覆盖 hotel-be 域不覆盖机/火;`OpenFlights` 只有通航关系无班次;携程 `flights.ctrip.com/schedule/*.html` 公共时刻表返 432 风控;
- 结论 = 手工 golden + 公开班期知识是当前最稳

**Exit(验收口径)**:
- 本机实测 8 query:**7/8 verdict=hit / 6/6 manual-golden 软命中 100%**(sf-01 MU6145 ¥3240 7.9s / sf-02 CA1441 ¥2605 6.3s / sf-03 9C8779 ¥810 5.3s / sf-04 CZ3497 ¥1340 4.2s / sf-05 hit 7s / sf-06 GJ7153 ¥680 6.2s / sf-07 JD5143 ¥630 4.2s flyai / sf-08 miss 25s flyai);
- live <15s **7/7 hit 全过**(实测 7.9/6.3/5.3/4.2/7/6.2/4.2s);ReadGuard 8/8 zero writes;challenge 0/8。evidence 落盘:`~/.gotry/evidence/session/sf-XX/<ts>.json` + sf-summary 汇总;`sf-summary.ts` 一键重建 unified summary

#### P3.8 Issue #67 static vendor + 默认桥生命周期

**状态**:**P3.8 Issue #67 static vendor + 默认桥生命周期** ✅ **2026-08-30**

**内容**:`--golden=static` 以 OpenFlights 固定 revision 提供 route/carrier,时刻/价格带显式标 estimated,requested/effective/provenance/fallback 同条 evidence;static 异常 stderr 后回退 manual

**Exit(验收口径)**:登录态连续两轮 8-query:official 均 8/8 hit、fallback 0;session 分别 3/8 与 5/8 hit,全部可评分 hit(3+5 条)均 13/13=100%,非 hit 明示 miss。默认桥 parked timer/socket `unref`,wizardless `keepBridge` 不变;§38 24/24、§40 9/9

依赖与并行:P0 可即刻开始(不等 M4 记忆域);P1 起与 M4 交替推进,不挤占 M4 主线(会话面是数据域增量,与记忆域正交)。

**新增债务登记(采纳即立)**:D-13 会话适配器维护面(接口改版即断,靠 action-cache + 金标准监控);D-14 playwright-core optional 依赖的分发体积与安装体验。

---

## 5. 决策门与风险登记

**决策门(新增,回写总纲 §5.2)**:G7 用户会话数据面立项 / G8 12306 纳入与否(**推荐暂缓**:判例全在写侧但平台态度最烈,等链路稳定单独评审)/ G9 官方通道尽调批准。

| 风险 | 等级 | 缓解 |
|---|---|---|
| R1 账号风控(踢登录态/滑块/封号) | 中 | 专用 profile + 人速节律 + 只读 + 熔断;触发即冷却并通知;单账号损失面=一个可重登的会话 |
| R2 中国法边界(反不正当竞争 §19 / 刑事红线) | 中 | 四支柱进代码;**绝不绕过反爬、绝不牟利代抢、绝不共享沉淀**;G8 暂缓 12306;正式商用(M5)前取一次法务意见 |
| R3 prompt injection | 低(因只读) | ReadGuard 物理隔离 + 不可信围栏 + schema 校验;零写原语=爆炸半径为零 |
| R4 适配器维护(OTA 改版) | 中 | XHR 优先(免疫 UI 改版)+ action-cache 自愈 + 金标准监控;站点数起步 ≤3 |
| R5 用户心智(「agent 动我浏览器」) | 低 | **扩展桥主载(2026-08-30 定案)**:一次性安装、零系统弹窗、扩展卡片即总闸(与授权闸 sessionAccess 双重控制);检索后台标签收尾自动关、登录标签置前台留给用户;站点白名单;一键全关。原「专用 profile 首发」已按 founder 纠偏退役(匿名实例无人登录) |
| R6 平台通道演化(官方 MCP 全面开放/收紧) | 中 | 数据面排序官方优先;会话层传输/适配器分离,任一侧被掐断可单独替换;**传输层车道分离(扩展/cdp/persistent)使 Chrome 安全模型再收紧时只动车道不动语义** |

---

## 6. 与仓库纪律的勾稽

- **复用矩阵修订提案**(总纲 §2 新行):`@fly-ai/flyai-cli | MIT | import(npx spawn,零渠道知识管道层) | 飞猪官方只读检索通道(机/火/酒/POI),交易经 jumpUrl 由人完成`;`playwright-core | Apache-2.0 | import(devDep) | cdp 后备车道传输(Chrome 144+ 逐连接弹窗实测不可产品化,2026-08-30 降级为诊断/显式 opt-in)`;
  - `Chrome Extensions MV3 平台 | 平台能力 | reference + 自研 | 会话传输主载 GoTry Session Bridge(extension/ 自研,2026-08-30 PRIMARY):一次性安装、MAIN-world 被动嗅探、固定 key 扩展 ID;playwright-mcp --extension 仅设计对照,不引代码`;`browser-use | — | 明确不引入(Python 违纪,且其隔离 Chromium ≠ 用户桌面 Chrome,装不到目标扩展,假象替代)`;
  - `Chrome Web Store 上架清单(2026-09-02,§3.3 分发通道 B + §3.3 UX 职责返交)| 平台原生 | reference | 商店上架材料(单一用途/权限理由/隐私披露/文案/后续发版流程)+ wizard 退化为离线健康探活等待,不动 pbcopy/osascript/zenity,安装 = 浏览器的事、渲染 = dsh UI 的事`;`GitHub Releases + 平台 tar | 平台能力/原生 | reference | 扩展分发通道 A(2026-08-30,ADR-21,§3.3 分发):稳定资产名 + SHA256 dist-manifest + `tar -xzf` 解压,零新 npm 依赖`。
- **红线进代码**:ReadGuard = WriteGate 的检索态前置;动机画像/wish pool 红线不动;`[会话:*]` 进 L4 证据链契约。
- **状态同步**:P3 收尾按 architecture.md §11 六状态面同提交同步。
- **巡检状态纪律**:所有会话面测试用隔离 stateRoot / 专用测试 profile,绝不动 founder 真实浏览器 profile 与 dsh-runtime 共享状态(2026-08-26 教训的会话版)。

---

## 附录:关键来源(一手优先,访问/核证 2026-08-28)

工程:Chrome 136 调试限制(developer.chrome.com/blog/remote-debugging-port,2025-03);App-Bound Encryption(security.googleblog.com,2024-07);chrome-devtools-mcp `--autoConnect`(github.com/ChromeDevTools/chrome-devtools-mcp);playwright-mcp `--extension` 与持久 profile(github.com/microsoft/playwright-mcp);
- Stagehand v4(docs.stagehand.dev);rebrowser-patches / Patchright;Playwright auth/network 文档;12306 JSON 先例(github.com/testerSunshine/12306);Electron safeStorage 后端对照。
能力:Gemini 2.5 CU 模型卡(2025-10);UI-TARS-2(arXiv:2509.02544);OpenAI CUA/Agent/Atlas 官方页;Anthropic Claude for Chrome 红队(2025-08);OpenAI Atlas 加固(2025-12);Comet 注入(Brave,2025-08);OSWorld/OSWorld 2.0。
合规:hiQ 终局(Morgan Lewis/ZwillGen,2022-12);Ryanair v. Booking(Reuters 2024-07;Cooley 2025-01 JMOL);Air Canada v. Seats.aero(AwardWallet/JD Supra);《网络反不正当竞争暂行规定》§19(环球/金杜解读);12306 刑事判例(最高法入库丁某案;2025-08 静安代抢案)。
官方通道:飞猪 FlyAI(flyai.open.fliggy.com);携程商旅 MCP(ct.ctrip.com);高德 MCP Server(developer.amap.com)。


**A. attach 用户日常 Chrome**

- **⚠ 降级为显式后备(2026-08-30 founder 定案)**:曾为 PRIMARY(2026-08-28),被产品实测推翻——**授权模型官方实锤(chrome-devtools-mcp #825):Chrome 144+ 每次连接尝试都弹浏览器侧权限框等用户点击,持久化批准尚无官方支持**,逐连接弹窗对普通用户/开发者均不可用(founder:「授权操作太频繁了,根本无法使用」)。保留 `GOTRY_SESSION_TRANSPORT=cdp` 显式 opt-in 供诊断/测试,不再自动回退(回退即重新引入弹窗)

**C. 扩展接管**

- **✅ PRIMARY(2026-08-30 founder 定案,issue #21 传输层方案 B/C)**:Chrome 系统级弹窗从「每连接 1 次」降为 **0 次**;授权模型=一次性安装(约 30 秒,`npx gotry setup` 落位指引)+ manifest key 派生固定 ID origin 白名单 + 既有会话内授权闸不变;`needs-extension` verdict 为 waiting no-spend 用户门
