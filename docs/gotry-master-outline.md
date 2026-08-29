# GoTry 总纲:工作分解与复用基线

> 单一现行版(历史见 git log;不设文件级版本号)
> **日期**:2026-08-22
> **定位**:**本文是 GoTry 全部后续工作的指南(single source of truth)**。业务、产品、技术三条线的任何新文档、新决策、新实现,先对照本文的复用矩阵(第 2 章)与决策门(第 5 章)。
> **两条刚性约束**(创始人指令,优先级高于任何单篇文档的局部优化):
> 1. **Harness 必须以 deepseek-harness(dsh)为参考基线**,不自研 agent 运行时。
> 2. **参考过的开源项目在实现时一律不重写**:优先直接 import、桥接等确定性方案;确需移植的,以「模式移植 + 对照原实现验收」为底线。

---

## 0. 阅读说明与使用方式

- GoTry 是一个宏大的业务/产品/技术规划,**不可能一次性完成**。本文把它分解为三条工作线、一组工作包、一串决策门——后续所有工作都在这个框架里推进。
- 文档体系分两层:**总纲层(本文)** 定方向、定复用、定顺序;**分篇文档** 承载各自领域的完整设计。分篇与总纲冲突时,先改总纲再动工。
- 已存在的《GoTry 产品设计》(D1,`gotry-product-design.md` v0.4 部分)是产品线的第一篇分篇;本文对其架构章的修订要求见 3.8。

---

## 1. 全景:三条工作线与文档体系

### 1.1 三条工作线

| 线 | 回答的问题 | 当前状态 |
|---|---|---|
| **业务线(B)** | 在哪个市场、给谁、靠什么赚钱、合规怎么过 | 市场未锁定(D1 §3.3),商业计划未启动 |
| **产品线(P)** | 用户旅程、产品机制、指标体系 | D1 v0.1 已有完整产品定义,待细化到可实施 |
| **技术线(T)** | harness、插件、能力复用、评测、成本 | 本文首次确立技术基线(第 3 章),PoC 未启动 |

三线并行推进,以决策门(第 5 章)同步节奏:技术线的 PoC 结果反哺业务线的市场判断,业务线的市场锁定约束技术线的供应链选型。

### 1.2 文档地图(编号即后续工作交付物)

| 编号 | 文档 | 线 | 状态 | 说明 |
|---|---|---|---|---|
| D0 | 总纲(本文) | 全部 | v0.1 | 工作分解、复用矩阵、决策门 |
| D1 | GoTry 产品设计 | P | v0.1 已存在 | 定位/主循环/透明机制/指标/路线图;§7 架构需按本文第 3 章修订 |
| D2 | 技术架构设计 | T | 未启动 | harness 基线(dsh)、插件清单、桥接设计、数据模型 |
| D3 | 业务计划书 | B | 未启动 | 市场、GTM、财务逻辑(参照 stai-business-plan 体例) |
| D4 | 评测方案与评测集 | T | 未启动 | 可行性/事实性/透明度三件套 + 成本维度 |
| D5 | MVP 实施计划 | P+T | 未启动 | 对应产品 M1 的工程落地:范围、里程碑、验收 |
| D6 | 合规清单 | B | 未启动 | 佣金披露、支付/外汇、数据跨境、主动触达 📍随市场 |

---

## 2. 复用与集成矩阵(本纲要的核心)

**原则:不重写。** 每个参考项目给出确定的复用策略,策略只有三种:**import**(直接引入源码/包,仅限许可证明确的 open-source)、**bridge**(进程外/接口级运行时桥接,不引代码)、**reference**(仅借鉴设计,不引代码)。**代码级复用只发生在 open-source import;内部资产一律只 bridge 运行时能力或作 reference——不存在「移植代码/对照原实现」的中间态。**

| 项目 | 许可证 | 策略 | 在 GoTry 中的角色 | 集成形态 | 主要风险与对策 |
|---|---|---|---|---|---|
| **deepseek-harness (dsh)** | MIT | **import** | Agent 运行时基座(harness 层全部) | TS monorepo 直接引入;GoTry 全部领域能力做成 dsh 插件 | dev preview 有破坏性变更 → **已决:不锁版本,跟 main,bet on it**(G2 已关);升级纳入日常回归 |
| **loopx** | MIT | **import** | 长程任务控制平面:TripState 的 objective/gates/evidence/quota;**异步深度规划的执行面**(见 3.6) | Python CLI/JSON,由 dsh 插件经子进程调用;零依赖,桥接成本低 | TS↔Python 跨语言 → 桥接面收敛为 trip-state + async-planner 两个插件 |
| **Z3** | MIT | **import** | 可行性引擎的约束求解器(不自研求解器) | Python 包(z3-solver),作为 feasibility 插件的库依赖 | 求解超时 → 约束规模上限 + 超时降级为规则校验 |
| **ai-agent-book** | Apache-2.0 | **reference** | 评测方法、记忆与上下文工程的设计参考 | 不引代码 | 书的 demo code 太弱(创始人判断),仅作设计参考;memory 实现基座见 travel_agent(3.5) |
| **travel_agent(内部)** | 内部资产 | **bridge + reference** | ①bridge:机票/酒店/偏好/差标等 MCP 工具(travel-mcp-app,含 travel_get_user_preferences)在 PoC/MVP 期运行时桥接(受 G5 约束);②reference:双执行、WriteGate、tool-owned dates、可恢复 SSE、**六层后端 memory(见 3.5)**——与 ai-agent-book 同级,**只作设计参考,代码与 schema 均不搬用**,GoTry 按 C 端休闲旅行域自行实现 | MCP 协议桥(运行时调用,不引代码) | 内部资产不可代码级使用(创始人明确);且企业差旅域语义(差标/审批/部门)与 C 端休闲本就不宜照搬 |
| **hotel-be(自有)** | 自有资产 | **bridge** | 原子能力:城市/目的地搜索、酒店搜索/报价/详情/静态数据、订单 | **已决:以 CLI 方式开放(G4 已关)**,基座为 hotelbyte-cli,见下行 | CLI 命令缺口(如地理映射)→ 同风格扩展回馈上游 |
| **hotelbyte-cli** | MIT | **import + extend** | capability-hotelbe 的基座:agent-native CLI(hbcli),全命令 `--json`、`@file` 载荷、凭证自动探测、自更新单二进制(Bun/TS) | dsh 插件经子进程调用 CLI;盘点命令缺口后以同风格扩展 | 能力对齐 → T3 先做命令缺口盘点 |
| **Chrome Extensions(MV3)平台** | 平台能力 | **reference + 自研** | 会话数据面传输主载(issue #21 方案 C,2026-08-30 founder 定案):GoTry Session Bridge 扩展一次性安装,替代 Chrome 144+ 逐连接 CDP 权限框(实测不可产品化);playwright-mcp `--extension` 仅作设计对照,不引代码 | `extension/` 自研 MV3 四文件(零构建,manifest 固定 key=扩展 ID 稳定)↔ Node 回环桥(`session/extension-bridge.ts`,`node:http` 长轮询,零新依赖);授权=一次性安装 + origin 白名单 + 既有会话内授权闸不变 | Chrome 安全模型再收紧 → 车道分离(扩展/cdp/persistent)只动车道不动语义;CWS 上架前手动加载,分发面后置(native messaging 备选二期) |
| **TREK** | AGPL-3.0 | **reference + rewrite(照着重写)** | 行程规划器的设计蓝本:Day planner/地图/预算/协作的功能面;trip/day/place/budget 领域工具 schema(150+ 工具、细粒度 OAuth scope、限流) | **已决:照着重写**(G3 已关)——以功能面与 schema 设计为参考自行实现,不引代码、不自托管 | AGPL 禁止 import;重写纪律:参考设计与 schema,**不逐行翻译源码** |
| **layla.ai** | 商业闭源 | reference | 竞品与定价锚点,无代码复用 | — | — |
| 小红书 / 圆周轨迹 | 平台/闭源 | reference | 共享经验层(D1 §6.6)的形态参照与差异化对象:民间智慧密度高但非结构化 | 数据不可引;冷启动只做事实断言的人工提炼,不搬运内容(版权红线) | 形态可学,数据自建 |

矩阵结论:**复用矩阵中不再有许可证硬阻塞**——open-source(MIT/Apache)直接 import;内部资产 bridge 运行时;AGPL 项目(TREK)与内部代码(travel_agent)一律照着重写。

---

## 3. 技术基线:Harness = deepseek-harness

### 3.1 基线立场

- **Agent = Model + Harness**(dsh 的公式)。GoTry 不自研 agent 循环、插件系统、会话管理——这些是 dsh 的本体;GoTry 的工程价值全部落在**领域插件**与**数据/供应链资产**上。
- dsh 的「一切皆插件」(Cordis 组合式内核)与 D1 的架构原则(第 7 章)天然对齐:双执行、WriteGate、透明层本来就是「能力组合」而非「框架改造」。
- 来源:[deepseek-harness 仓库](https://github.com/deepseek-ai/deepseek-harness)、[deepseek.com/harness](https://deepseek.com/harness/)、[The New Stack 报道](https://thenewstack.io/deepseek-harness-open-source-plugins/)。

### 3.2 目标运行时形态

```
dsh 内核(Cordis,import)
  └── GoTry 插件包(gotry-plugins,自研的唯一主场)
        ├── motivation-interview   动机访谈(PureAgent 模式;B2B 复用接缝,见 3.7)
        ├── graph-dispatcher       确定性流程 DAG(设计参考 travel_agent)
        ├── write-gate             写操作确认闸(设计参考 travel_agent)
        ├── trip-state             长程状态(bridge → loopx)
        ├── async-planner          异步深度规划编排(基于 trip-state,见 3.6)
        ├── feasibility-engine     可行性引擎(import Z3)
        ├── transparency-card      推荐卡片渲染与证据链(D1 §6)
        ├── memory                 后端工程 memory 基座 + LLM 语义层(设计参考 travel_agent,见 3.5)
        ├── recommender            排序与可解释(D1 §6.4)
        ├── capability-hotelbe     hotel-be 原子能力 connector(import/extend hotelbyte-cli)
        └── capability-travel-mcp  travel-mcp-app 工具桥(bridge,PoC/MVP 期)
```

### 3.3 语言与桥接策略

- 主体语言随 dsh:**TypeScript**;Python 侧(loopx、Z3、评测)不硬迁,经 **CLI/JSON 子进程桥**集成,桥接面收敛为 `trip-state` 与 `feasibility-engine` 两个插件,不做大面积 FFI。
- 评测集独立仓库(参照 travel-agent-evaluation-set 实践),CI 中跑回归。

### 3.4 版本与升级纪律

- **已决:不锁版本,跟 main,bet on it**(创始人决策,G2 已关)。dsh 升级是日常:每次升级跑插件兼容性回归后合入,不设单独决策门。
- dsh 插件生态(dsh-plugin topic)持续扫描:优先复用社区插件(会话、UI、模型接入),同样遵循「不重写」。

### 3.5 Memory 基线:后端工程为体,LLM 为用

**立场:能用后端工程解决的(确定性事实),绝不交给 LLM 记忆;LLM 只负责必须语义理解的部分(动机、复盘)。** 设计参考是 travel_agent——它在 LLM 出现之前就用扎实的后端工程实现了初级但特别好用的 memory 效果。其六层结构作为 GoTry memory 设计的参考框架(**代码与 schema 均不搬用**,GoTry 按 C 端休闲旅行域自行设计实现):

| 层 | 参考内容(travel_agent 已验证的形态) | GoTry 对应 |
|---|---|---|
| 1 用户档案 | 常驻城市、币种、证件(登录态解析,**模型永不接触**) | 出发地默认值、敏感信息后端填充 |
| 2 行为偏好画像 | 三级分解(user 级/city 级/实体级 factor)+ 时间窗(30/90/180/365d)+ 群体兜底;常坐航班号按航线、同城机场偏好、偏好时段槽位、舱位/星级默认 | 旅行版:常住酒店、常飞航线、节奏档、体力档、预算档 |
| 3 标准与预算 | 差标按城市+日期+币种;期望价位 = 标准 + 用户习惯超差价差 | 预算档画像(动机访谈校准 + 历史行为) |
| 4 行程时间线 | 历史订单逐日城市驻留;位置推断事实权重(hotel_order 100/flight 90/todo 10)+ 冲突即停 | 「去过哪、何时」;出发地三级解析(未来行程→档案→问用户) |
| 5 会话双区记忆 | Trip Notebook(durable,后台 LLM 提取,**负面清单:永不存 ID/token/URL**)+ Hot Context(30min 资源层/24h 意图层分层过期,CAS 防并发) | 双区会话记忆参考其分区/过期/净化**设计**,schema 自行定义 |
| 6 敏感身份填充 | 常用乘机人/联系人由后端从登录态解析,多候选 fail-closed 澄清 | 同行人档案(红线 6 的工程形态) |

**两条铁律采纳为 GoTry 设计原则**(travel_agent 生产验证):
1. 画像只进**排序通道**,永不进硬过滤(否则会把搜索筛空);
2. 任何偏好断言必须可溯源到工具结果或用户原话(P0 反幻觉,与 D1 §6.3 证据链同构)。

**LLM 语义层是自研增量**(ai-agent-book 仅作设计参考):动机画像(跨年)、旅行复盘沉淀——写入走与 WriteGate 同级的审计路径,用户可见、可编辑(红线 6)。

**设计参考阅读清单**(`~/work/travel_agent`,用于理解设计,非移植目标):`internal/domain/hotel/types/preferences.go`(偏好三级分解)、`internal/pureagent/session_memory.go` + `hot_context.go` + `internal/chatstore/notebook.go`(双区会话记忆三件套)、`internal/pureagent/agenttools/location_prediction_tool.go`(位置推断)、`internal/pureagent/sensitive_tool_arguments.go`(敏感填充)、`internal/application/flight/user_profile_cache.go`(请求级画像缓存,singleflight)。

### 3.6 异步深度规划:「一小时后回来,不失望」

loopx 被看好的产品化理由:**特别复杂的规划,同步聊天是错的形态**。期望的产品效果——告诉用户「过一个小时再来看看」,然后不失望。今天 99.999% 的产品在一小时后让用户失望(空转、半生不熟的方案、或干脆忘了);agent 完全可以多做一些检查工作,配上几个简单的问题,用户看过几次就会习惯这种节奏。

- **触发**:复杂规划(多城市/多约束/长线/跨供应链)时,agent 提议切换深度规划模式:「我后台做,约一小时后回来看看」。
- **后台工作(loopx tick 循环)**:多轮约束求解与候选对比;价格/库存/开放时间逐项校验;自检清单(可行性引擎全项通过、证据链完整);quota 控制无进展即停;过程证据留存。
- **回访交付**:不是一段生成的行程,而是「**已验证的行程 + 几个简单问题**」——问题全部是封闭式选择题(loopx 显式 user gate:Day3 两种取舍选哪个、预算加不加 ¥300),不是重新访谈。
- **通知**:完成或遇阻时应用内/推送提醒;用户可随时中途查看进度。

**「不失望」验收四条**(进 D4 评测):
1. 承诺时间后必有明确产物(不许空转、不许静默失败);
2. 产物通过自检清单(可行性引擎全绿、证据链完整);
3. 待决问题全部是简单选择题(带 trade-off 说明);
4. 做不到的诚实说(unsat core + 替代方案),绝不端上来半生不熟的方案。

技术支撑:loopx 的 objective/gates/evidence/quota 模式天然就是这个产品形态的控制平面;async-planner 插件负责编排与进度呈现。

### 3.7 动机层:最大差异点与 B2B 复用接缝

创始人判断:**「为什么出发」是 GoTry 最大的产品差异点,也是践行 everything-is-plugin 的关键点**——因为它同时是 B2B 版本的复用接缝。B2B 为什么出发?因为 ta 的客户要因为 xxx 出发——**两层为什么的包裹**。

**契约设计**(T2 落实,MotivationProfile 为核心数据对象):

- **principal(出行人)与 sponsor(运营方)分离**:B2C 里两者合一(用户自己);B2B 里 principal 是企业的终端客户,sponsor 是企业(旅行社/TMC/酒店/航司/目的地文旅)。动机访谈到达的永远是 principal。
- **下游只消费契约,不感知差异**:可行性引擎、推荐、透明卡片、行程器、记忆、异步规划全部只消费 MotivationProfile + 约束集——这是「B2B 复用 99%」的技术保证;变化只发生在入口、库存池与 sponsor 配置(以 dsh 插件替换/包裹的方式完成)。
- **红线随行**:B2B 版本中 sponsor 的收益同样对 traveler 披露——透明价值观是 B2B 的信任卖点,不是成本。
- **素材解析契约**:任何素材(照片/地名/链接/攻略)→ 憧憬(意象+情绪)→ 硬约束(出发地/时间/预算/体力)→ 候选集;**素材中的目的地只是软偏好**。产品铁律与洱海案例见 D1 §5.1/§4.3。

### 3.8 对 D1《产品设计》的修订要求(列为例行工作项,不阻塞本纲要)

D1 需要 v0.2 修订:①§7.1 分层架构改写为 3.2 的 dsh 插件视图,§7.2/7.4 标注设计参考来源(travel_agent);②§7.6 记忆分层改写为 3.5 的「后端工程为体,LLM 为用」六层框架;③§5.3 规划一节补充异步深度规划(3.6)作为复杂规划的标准形态;④§7.8 hotel-be 桥接改写为 hotelbyte-cli CLI 方式。产品语义(主循环、透明、WriteGate、可行性)不变。

---

## 4. 工作分解(WBS)

每个工作包:交付物 → 依赖 → 验收。编号 P/B/T 对应三线;**粗体**为 Phase 0 必做。

### 业务线(B)

| 包 | 交付物 | 依赖 | 验收 |
|---|---|---|---|
| **B1 市场锁定决策包** | 三候选市场(中国出境/国内/全球英文)的量化对比 + 建议 | 无(素材已在 D1 §3.3) | 创始人做出 G1 决策 |
| B2 商业计划书(D3) | 市场规模、GTM、单位经济、融资叙事 | G1 | 与 D1 价值观无冲突的完整 BP |
| B3 合规清单(D6) | 佣金披露口径、支付/外汇、数据跨境、主动触达频控 | G1 | 每项有法务意见或明确风险等级 |

### 产品线(P)

| 包 | 交付物 | 依赖 | 验收 |
|---|---|---|---|
| **P1 透明机制规范** | 推荐卡片 schema(what/why/全成本:D1 §6.5 的钱+门到门+到达状态/备选 + 证据与新鲜度字段)、佣金披露格式 | 无(语义已在 D1 §6) | schema 可被 transparency-card 插件直接实现 |
| P2 主循环交互细化 | 七阶段交互稿与文案基调(动机访谈问题库 v1) | 无 | 覆盖 D1 三类画像的进入路径 |
| P3 指标与埋点字典 | 北极星与过程指标的口径、埋点、护栏 | P1 | 每个指标可计算、有 owner |
| P4 D1 架构章修订 | 按本文 3.8 的修订点改写(憧憬素材与 B2B 动机接缝两项已于 v0.5 时直接落入 D1) | Phase 0 PoC 结论 | 与 D2 一致 |
| P5 异步深度规划体验设计 | 触发话术、进度呈现、回访交付(gate 选择题)、「不失望」验收口径(3.6) | 无 | 交互稿过创始人评审 |
| P6 B2B 场景与动机契约推演 | 选 1-2 个 B2B 形态(如旅行社嵌入、目的地文旅),推演两层为什么的包裹与 99% 复用边界;红线随行口径 | 3.7 | B2B 复用推演纪要通过创始人评审 |
| P7 共享经验层设计 | 经验条目 schema(断言+印证+时间衰减)、回流机制(联动 D1 5.6)、置信与反滥用、冷启动策略 | D1 §6.6 | schema 冻结 + 首批种子经验入库(含创始人的大理/丽江经验) |

### 技术线(T)

| 包 | 交付物 | 依赖 | 验收 |
|---|---|---|---|
| **T1 Harness 基线 PoC** | dsh(跟 main)引入 + 一个 GoTry 插件跑通 + loopx 桥接 demo(含分钟级异步 tick,模拟 3.6)+ Z3 求解 demo(最小约束集:**门到门时间**(班次/起床时刻/到达状态,D1 §6.5)/地理/预算) | 无 | 端到端:自然语言 → 约束 → 可行/无解+unsat core;异步模式产出「已验证结果 + 选择题」 |
| T2 技术架构设计(D2) | 插件清单细化、TripState 数据模型、桥接协议、部署形态 | T1 | 可指导 D5 |
| T3 能力桥接 | capability-hotelbe(以 hotelbyte-cli 为基:命令缺口盘点 → 同风格扩展缺的命令 → dsh 插件经 CLI 调用)+ capability-travel-mcp | G5(travel-mcp 审批) | 两个插件在 dsh 内可用,`--json` 结构化输出带证据字段 |
| T4 评测方案与评测集(D4) | 可行性/事实性/透明度三评测集 + 成本维度 + 「不失望」四条(3.6)+ CI 回归 | T1, P1 | 基线指标可报告(D1 §7.9 目标) |
| T5 成本工程基线 | 模型分级路由、上下文压缩、缓存、批处理的首版实现与度量 | T1 | 单会话成本可测量可报告 |
| T6 WriteGate 与双执行实现 | write-gate + graph-dispatcher(设计参考 travel_agent,自行实现) | T2 | 自有用例全绿:幂等、pending state、未证明只读默认按写 |
| T7 Memory 分层实现 | 按 3.5 六层框架自行实现(C 端域字段重设计;参考双区会话记忆、位置推断、请求级画像缓存的**设计**)+ LLM 语义层(动机画像,审计写入) | T2 | 偏好断言 100% 可溯源;「画像不进硬过滤」有守卫用例 |
| T8 结构化行程器实现 | 照着重写 TREK 的功能面:Day planner(拖拽/跨天)、地图视图、预算视图、清单导入(GPX/分享清单)+ trip/day/place/budget 工具 schema(参考其 150+ 工具与细粒度 scope) | T2, P2 | D1 §5.3 验收:交互完整 + 可行性实时校验接入 |

---

## 5. 阶段计划与决策门

### 5.1 阶段

- **Phase 0(立即,约 2-4 周)**:本纲要 + T1 PoC + P1 透明规范 + B1 市场决策包。产出:技术基线被 PoC 证实/证伪,市场锁定,透明 schema 冻结。
- **Phase 1**:T2/D2 → D5(MVP 实施计划)→ 启动产品 M1(对应 D1 路线图:动机访谈+规划+结构化行程+透明卡片+可行性 v1,无预订)。
- **Phase 2/3**:对应产品 M2/M3,业务线 D3/D6 在 G1 后并行推进。

### 5.2 决策门

| 门 | 问题 | 选项 | 影响 | 时点 | 状态 |
|---|---|---|---|---|---|
| **G1** | 首发市场锁定 | 中国出境 / 国内深度 / 全球英文 | 全部 📍 项、供应链、合规 | Phase 0 末 | 开放(B1 支撑) |
| G2 | dsh 版本策略 | — | — | — | **已决:跟 main,不锁版本,bet on it(2026-08-22)** |
| G3 | TREK 复用路径 | — | — | — | **已决:照着重写——以设计为参考自行实现,不引代码、不自托管(2026-08-22)** |
| G4 | hotel-be 原子能力暴露形态 | — | — | — | **已决:CLI 方式,以 hotelbyte-cli 为基(2026-08-22)** |
| **G5** | travel-mcp 桥接的内部审批 | 桥接 / 不桥接(改接外部供应商) | PoC/MVP 期能力来源 | T3 前 | 开放(内部资产使用授权) |

---

## 6. 变更管理与文档纪律

- **先改纲要,再动工**:任何工作包若要偏离复用矩阵或新增参考项目,先提修订(本文升版),再执行。
- 分篇文档头部维护「状态/依赖的总纲版本」;总纲升版时同步检查各分篇的引用点。
- 每个决策门关闭后,结论回写本文对应表格(状态列),并同步到受影响文档。

---

## 7. 待确认事项(继承 D1 §12 并新增)

| # | 事项 | 来源 | 建议决策时点 |
|---|---|---|---|
| 1-8 | (继承 D1 §12 的 8 项:市场、产品形态、hotel-be 暴露形态、机票/活动供应链、佣金披露合规、订阅定价、主动触达频控、团队预算) | D1 | 见 D1 |
| 9 | TREK 的 AGPL 合规意见 | 本文 G3 | 已决:照着重写,无需法务意见 |
| 10 | dsh 版本锁定与升级节奏 | 本文 G2 | 已决:跟 main,bet on it |
| 11 | TS↔Python 桥接面最终形态(loopx/Z3 是否长期保留 Python 侧) | 本文 3.3 | T2 中 |

---

## 附录:本文新增参考来源

- [deepseek-ai/deepseek-harness(GitHub)](https://github.com/deepseek-ai/deepseek-harness) — MIT,一切皆插件,Cordis 内核,Agent = Model + Harness
- [DeepSeek Harness 官方页](https://deepseek.com/harness/)
- [The New Stack: DeepSeek open sources an agent harness where everything is a plugin](https://thenewstack.io/deepseek-harness-open-source-plugins/)
- [Eigent AI: DeepSeek Harness — Open-Source Agent Runtime](https://www.eigent.ai/blog/deepseek-harness-agent-runtime)
- [hotelbyte-com/hotelbyte-cli(GitHub)](https://github.com/hotelbyte-com/hotelbyte-cli) — MIT,agent-native CLI(hbcli),全命令 `--json`、`@file` 载荷、凭证自动探测、自更新单二进制
- travel_agent memory 蓝本:本地仓库 `~/work/travel_agent`(六层后端 memory,3.5 节列有精确文件清单)

## 修订史

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.1 | 2026-08-22 | 初稿:工作分解、复用矩阵、dsh 基线、决策门 |
| v0.2 | 2026-08-22 | 吸纳创始人四项反馈:①memory 基线改为 travel_agent 六层 port,ai-agent-book 降为设计参考(3.5);②capability-hotelbe 定为 hotelbyte-cli CLI 方式(G4 关);③dsh 不锁版本 bet on it(G2 关);④新增异步深度规划「一小时后回来,不失望」(3.6)及工作包 P5/T7 |
| v0.3 | 2026-08-22 | 创始人澄清:travel_agent 代码不能直接用,与 ai-agent-book 同为设计参考——废除 port 策略,复用策略收敛为 import/bridge/reference 三种;代码级复用仅限 open-source import |
| v0.4 | 2026-08-22 | 创始人决策:G3 关闭——TREK 不卡 AGPL 法务,照着重写(reference + rewrite):以功能面与工具 schema 为参考自行实现;新增工作包 T8(结构化行程器) |
| v0.5 | 2026-08-22 | 创始人判断落纲:①动机层 = 最大差异点 + B2B 复用接缝(新 3.7,两层为什么包裹,principal/sponsor 分离,原 3.7 顺延为 3.8);②新增「素材是憧憬的表达式,不是目的地指令」铁律(约束先于素材 + 意象检索 + 下一次出发清单);D1 同步增量(v0.2 部分);新增工作包 P6 |
| v0.6 | 2026-08-22 | 创始人成本观落纲:全成本模型(D1 §6.5)——成本的真实单位是生命体验;门到门全成本(班次/前置缓冲/生物钟/接驳/到达状态/金钱);钱-时间-精力兑换率由动机设定;穷游不评判、只透明兑换;P1 卡片 schema 与 T1 PoC 约束集同步 |
| v0.7 | 2026-08-22 | 创始人数据观落纲:共享经验层(D1 §6.6)——官方渠道不存在的数据(丽江/大理打车与管理差异案例),以结构化经验条目存在(断言+印证+时间衰减),回流挂 5.6;消费面挂卡片证据/可行性校准/动机匹配;冷启动含创始团队首批经验;新增工作包 P7 与矩阵行(小红书/圆周轨迹 = reference) |
