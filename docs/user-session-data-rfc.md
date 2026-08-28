# 用户会话数据面 RFC:用用户自己的账号会话补齐 OTA 检索(待拍板)

> 定位:**「官方通道优先、用户会话补缺」的数据源扩展提案**——回答「不接每家 OTA 的 API,检索数据从哪来」。
> 上游:总纲复用矩阵(`gotry-master-outline.md` §2,本 RFC 即「先改总纲再动工」的那个修订提案)+ `data-sources.md`(数据源唯一权威面,采纳后增补第五层)。
> 调研时窗:2025 下半年 – 2026-08-28(四路:工程模式/GUI agent 能力/合规/产品先例;子代理两路挂掉由主会话补齐,来源见附录)。
> 本文只管数据面;交易(预订/支付)仍属 M5 WriteGate 范畴,**本 RFC 不含任何写路径**。

---

## 0. 摘要与决策请求

**结论先行**:「用用户自己的登录态做只读检索」在 2026 年的工程与合规现实下**可行,但必须以「官方通道优先、会话补缺、只读物理隔离、数据不出本机」四原则落地**。检索型浏览器任务已进入顶级模型甜区(WebVoyager 类 ~88%),DOM/a11y 优先的混合架构有明确业内共识,单次站内检索可压到秒级/两美分级;真正的风险不在技术,在①平台风控对自动化频率的反制、②中国法下「经营者抓取」的边界、③prompt injection(只读 + 物理拦截兜底)。同时调研发现**国内官方通道 2025-2026 真的开了**(飞猪 FlyAI / 携程商旅 MCP / 高德 MCP),应先吃官方免费的,用户会话只补官方覆盖不了的缝(携程 C 端、美团本地、12306)。

**请 founder 拍板三道题**(详见 §5 决策门):

| # | 问题 | 推荐 |
|---|---|---|
| **G7** | 用户会话数据面是否立项(M4 增量,不挤 M4 主线记忆域) | **立项,按 §4 四阶段推进** |
| **G8** | 12306 是否纳入首批站点适配器 | **暂不纳入**(平台对抗史最烈、刑事判例集中在抢票写侧;等携程/美团链路稳定后单独立项评审) |
| **G9** | 官方通道尽调先行:飞猪 FlyAI key + 高德 MCP key 申请 | **批准申请动作**(零成本,决定会话面的真实缺口大小) |

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
| A. attach 用户日常 Chrome | Chrome 136(2025-05)起默认 profile 禁用调试端口(安全收紧,App-Bound Encryption 动机链);**Chrome 144+ 恢复官方路径**:`chrome://inspect/#remote-debugging` 用户手动开一次开关即可 attach(chrome-devtools-mcp `--autoConnect` 依赖此) | 可行但要求用户 Chrome ≥144 + 手动开开关;同一时刻仅一个调试客户端 | 二期选项 |
| B. **专用持久 profile** | Playwright `launchPersistentContext`(或 `channel:'chrome'` 用用户已装 Chrome,零浏览器下载);登录一次跨会话复用 | playwright-mcp 默认模式,最成熟 | **首发**(用户人工首登,agent 永不碰密码/验证码) |
| C. 扩展接管 | playwright-mcp `--extension` 直接接管用户现有 tab 与登录态;chrome.debugger API 同类 | 官方实现已产品化,但 attach 期间有"started debugging this browser"警告条,用户心智成本高 | 二期选项(最贴近「用户自己的浏览器」心智) |

明确不做:cookie 磁盘库直读(Chrome App-Bound Encryption 已封死)、云端 session 服务(Browserbase Contexts/Steel Profiles——凭证离开本机,违反 local-first 与红线)、**browser-use 生态(Python,违反零 Python 依赖面纪律;npm 上 TS 移植非官方未证实)**、LaVague(2025-01 停更)。

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

**中国**(首发市场,最重要):《网络反不正当竞争暂行规定》§19(2024-09 施行,已被反法修订草案吸收)禁止「利用技术手段非法获取、使用其他经营者合法持有的数据」——规制对象是**经营者之间的数据搬运与竞争性使用**(判例:大众点评 v 百度式);GoTry 的「检索结果只回显用户本人、不沉淀共享库、数据不出本机」刻意留在该条射程外。刑事红线(非法获取计算机信息系统数据罪)的全部公开判例共同特征:**绕过反爬措施(伪造 device_id/破解验证)+ 牟利(代抢/售卖工具)**——2025-08 上海静安代抢 12306 案、丁某案、大麦案、晟品案无一例外。PIPL 侧「用户委托处理自己的数据」有明确空间,要件是明示授权 + 最小化 + 可撤回。**合规四支柱(进代码,不进 PPT):①只读零写;②不绕过任何反爬(验证码出现 = 停 + 交还用户);③检索结果不进任何共享存储(经验回流只回流「断言级结论」且脱敏,见 §3.6);④用户明示授权 + 站点白名单 + 随时可关。**

### 2.5 竞争与替代:官方通道 2025-2026 在中国开了

- **飞猪 FlyAI 开放平台**(flyai.open.fliggy.com):机/酒/景/度假全场景,「实时直连官方商品库」,OpenClaw skill 一行安装(`npx skills add alibaba-flyai/flyai-skill`);门槛/收费/是否开放纯只读搜索未明——**P0 尽调第一优先**。
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

领域矩阵增量(目标态):

| 领域 | 会话面动作 | 证据链标注 |
|---|---|---|
| 航班班次/票价 | 携程机票页查询,XHR 嗅探结构化 | `[会话:ctrip-flight@ts]` |
| 铁路 12306 | (G8 未决,默认关) | `[会话:rail-12306@ts]` |
| 美团本地(民宿/门票) | 站内搜索嗅探 | `[会话:meituan@ts]` |
| 飞猪(若 FlyAI 无只读面) | 站内搜索嗅探 | `[会话:fliggy@ts]` |

新标注语义(L4 契约增补):`[会话:site@ts]` = **用户本人会话内实时检索,非官方 API,价格/库存以站点页面为准**——与 `[实时API]`/`[静态包:估算]` 三分,新鲜度同实时、权威性低于官方 API(命中过滑块的查询结果要标 `degraded`)。

### 3.2 代码形态(对齐现有分层)

```
ts/capabilities/session-search.ts      传输层编排:connect → navigate → sniff → extract → guard → 证据链
ts/capabilities/session/
  transport.ts        SessionTransport 接口 + CDPAttachTransport 首发实现
                      (playwright-core connectOverCDP/launchPersistentContext,channel:'chrome' 不下载浏览器)
  read-guard.ts       ReadGuard:网络层写请求拦截 + DOM 提交按钮黑名单,fail-closed,全量审计日志
  adapters/<site>.ts  站点适配器:{ entry, searchForm locators, networkHints[{urlPattern,parser}], a11yFallback, cooldown }
  action-cache.ts     本地动作缓存:key=指令+DOM 指纹 → 确定性 locator;miss 回退 LLM 重定位并回写
ts/src/index.ts       新 dsh 工具 gotry_session_search(site, query, dateSlots) → 平铺 envelope(ADR-13 同构)
```

依赖:仅 `playwright-core`(轻量,无浏览器下载,Apache-2.0,符合复用矩阵 open-source import);用戶已装 Chrome 走 `channel:'chrome'`。**npm 分发不硬依赖**:optional peer + 启动检测,缺则降级提示安装命令(沿用 dsh-map-tools 的占位剔除模式)。Stagehand v4 / playwright-mcp / chrome-devtools-mcp 作 P0 技术验证对照,P1 起按「自研薄层 + playwright-core」走(理由:三家都带不匹配的耦合——Stagehand 缓存绑云端、playwright-mcp 是进程级 MCP server、devtools-mcp 偏诊断;gotry 只需要 connect + 嗅探 + a11y 快照 ~500 行)。

### 3.3 ReadGuard(写操作的物理不可能性,不只是承诺)

1. **网络层**:CDP Fetch/Network 域拦截——deny-list(POST/PUT/DELETE + URL 模式 `/order|/pay|/submit|/trade|/booking`)命中即 abort 请求并落盘审计(`session-incidents.jsonl`,对齐 incident-log 惯例);
2. **DOM 层**:提交类按钮(role=button 且文本命中 下单/支付/预订/提交订单)从 a11y 快照中**直接剔除**——模型根本看不到可点击的提交件;
3. **动作层**:工具面只暴露 navigate/fill-search/click-result 三类动作语义,无 submit 原语;
4. fail-closed:guard 未初始化成功的会话不允许发起任何导航。

这是 WriteGate(L0-L4)在检索态的镜像:**写不是「被禁止的行为」,是「不存在的原语」**。

### 3.4 节律与熔断(把「像人」做成代码)

- 站内查询间隔 ≥30s、单会话 ≤10 次、日上限可配(`GOTRY_SESSION_*` 环境变量);
- 检测到滑块/验证码/风控跳转:**立即熔断 + 冷却 + 通知用户人工处理**——绝不重试、绝不绕过(合规支柱②);
- 专用 profile 首发不落 cookie 库;登录永由用户人工完成(agent 不碰密码/OTP/验证码,对齐 Operator 的 takeover 模式与总纲 3.5「敏感信息模型永不接触」)。远期若需 profile 迁移:AES-GCM 落盘 + 密钥进 OS keychain(macOS `security`/Windows DPAPI/Linux libsecret;keytar 已死不用),0600 权限。

### 3.5 注入防护

页面文本进 LLM 前统一包不可信围栏(`<<UNTRUSTED_PAGE_CONTENT>>`,指令剥离 + 长度上限);检索任务携带结构化意图 {site, query, fields},解析输出过 Zod schema,超纲字段丢弃;结果卡片渲染前二次校验(价格/时刻格式与 sanity 范围)。

### 3.6 数据边界(与共享经验层的防火墙)

会话检索结果**只存在于当前会话上下文与本地缓存(TTL 短,仅去重用)**;M4 经验回流/愿望池**不得引用会话原始数据**,只允许用户确认过的断言级结论(「十一大理机票 ¥1600 级」)且不含账号可归因信息。这条进 memory-utility 的 merge 守门 P0 断言。

---

## 4. 落地计划(四阶段,每阶段可独立叫停)

| 阶段 | 内容 | Exit(验收口径) | 预算 |
|---|---|---|---|
| **P0 尽调** | ①飞猪 FlyAI key 申请+只读能力探测(决定会话面真实缺口);②高德 MCP key;③本机 Chrome attach PoC(~30 行:连专用 profile 打开携程机票页,嗅探 1 条 XHR 并打印 JSON);④G7/G8/G9 决策回填本 RFC | 决策矩阵回填,FlyAI 能力备忘进 data-sources.md | 1-2 tick,零外部成本 |
| **P1 骨架** | transport + ReadGuard + adapter 接口 + 首个适配器(**携程机票**,携程 C 端覆盖最优先且与现有航班静态包直接对账);证据链 `[会话:*]`;隔离 stateRoot 测试(对齐巡检状态纪律,绝不动 dsh-runtime 真实状态) | 单站点:查询→结构化结果→smoke 断言;ReadGuard 拦截用例(伪造写请求必被 abort)全绿 | 2-3 tick |
| **P2 面上** | 美团 + 飞猪适配器;a11y 兜底抽取;action-cache 自愈;节律熔断;缓存命中路径 | 金标准 20 查询字段级准确率 ≥90%;单检索 <15s(缓存命中 <5s);注入围栏用例;熔断用例(滑块 fixture) | 2-3 tick |
| **P3 产品化** | dsh 工具 `gotry_session_search` + 人格契约条目(何时用会话 vs 官方 vs 静态)+ e2e 真模型巡检(e2e-prompts 新 §)+ 六状态面同步(architecture §1/§9、data-sources 五层、roadmap M4 增量、README、stage1、§10 债务) | run-all-tests 新分节全绿;e2e 真模型 1 例会话检索闭环;风控触发次数 = 0(实测期) | 2 tick |

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
| R5 用户心智(「agent 动我浏览器」) | 低 | 首发专用 profile(不动日常浏览器);可见窗口操作;站点白名单;一键全关 |
| R6 平台通道演化(官方 MCP 全面开放/收紧) | 中 | 数据面排序官方优先;会话层传输/适配器分离,任一侧被掐断可单独替换 |

---

## 6. 与仓库纪律的勾稽

- **复用矩阵修订提案**(总纲 §2 新行):`playwright-core | Apache-2.0 | import | 会话检索传输层(connectOverCDP/persistentContext,不下载浏览器)`;`playwright-mcp / Stagehand / chrome-devtools-mcp | MIT/Apache | reference | P0 对照验证,不引依赖`;`browser-use | — | 明确不引入(Python 违纪)`。
- **红线进代码**:ReadGuard = WriteGate 的检索态前置;动机画像/wish pool 红线不动;`[会话:*]` 进 L4 证据链契约。
- **状态同步**:P3 收尾按 architecture.md §11 六状态面同提交同步。
- **巡检状态纪律**:所有会话面测试用隔离 stateRoot / 专用测试 profile,绝不动 founder 真实浏览器 profile 与 dsh-runtime 共享状态(2026-08-26 教训的会话版)。

---

## 附录:关键来源(一手优先,访问/核证 2026-08-28)

工程:Chrome 136 调试限制(developer.chrome.com/blog/remote-debugging-port,2025-03);App-Bound Encryption(security.googleblog.com,2024-07);chrome-devtools-mcp `--autoConnect`(github.com/ChromeDevTools/chrome-devtools-mcp);playwright-mcp `--extension` 与持久 profile(github.com/microsoft/playwright-mcp);Stagehand v4(docs.stagehand.dev);rebrowser-patches / Patchright;Playwright auth/network 文档;12306 JSON 先例(github.com/testerSunshine/12306);Electron safeStorage 后端对照。
能力:Gemini 2.5 CU 模型卡(2025-10);UI-TARS-2(arXiv:2509.02544);OpenAI CUA/Agent/Atlas 官方页;Anthropic Claude for Chrome 红队(2025-08);OpenAI Atlas 加固(2025-12);Comet 注入(Brave,2025-08);OSWorld/OSWorld 2.0。
合规:hiQ 终局(Morgan Lewis/ZwillGen,2022-12);Ryanair v. Booking(Reuters 2024-07;Cooley 2025-01 JMOL);Air Canada v. Seats.aero(AwardWallet/JD Supra);《网络反不正当竞争暂行规定》§19(环球/金杜解读);12306 刑事判例(最高法入库丁某案;2025-08 静安代抢案)。
官方通道:飞猪 FlyAI(flyai.open.fliggy.com);携程商旅 MCP(ct.ctrip.com);高德 MCP Server(developer.amap.com)。
