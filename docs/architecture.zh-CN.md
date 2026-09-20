[English](architecture.md) | [简体中文](architecture.zh-CN.md)

# GoTry 技术文档（唯一技术权威面）

> 定位：当前系统形态、长期架构决定与未偿技术义务。
> 状态：living。
> 读者：维护者与交付 Agent。看产品形态从 §1 开始，看决策从 §8 开始，要接工作看 §10。
> 历史边界：发布过程归[发布说明](release-notes.zh-CN.md)，已清偿义务归[债务存档](debt-archive.zh-CN.md)，逐行实现历史归 Git。

**速览**

- GoTry 是证据优先的 AI 旅行 Agent：模型负责理解与解释，typed、确定性组件负责判断与算术，写动作始终受闸。
- 五层职责保持分离：交互、编排、统一行程模型与求解、数据／效应、交付治理。
- Local 与 Web 共用 tenant-scoped 账本语义、能力契约、来源证据和授权边界。
- Booking Copilot 是既有预订工作台里的只读 planner；搜索事实、Checkout、`Book`、支付和 guest 数据都不归它所有。
- 当前工程 proof 不代表真实用户 cohort、供应商库存、Booking 恢复、交易、benchmark uplift 或 B2B pilot 已通过闸门。

**目录**

| | | | |
|---|---|---|---|
| [1 系统是什么](#1-系统是什么) | [2 总体架构](#2-总体架构五层与现状) | [3 代码地图](#3-代码地图每个模块是什么) | [4 统一行程模型](#4-统一行程模型领域核心唯一求解入口) |
| [5 对话循环](#5-对话循环l2) | [6 数据与运行时](#6-数据与运行时) | [7 测试与验证](#7-测试与验证策略) | [8 ADR](#8-adr) |
| [9 演进](#9-演进) | [10 债务清单](#10-债务清单) | [11 保鲜机制](#11-保鲜机制) | [12 文档地图](#12-文档地图) |

---

## 1. 系统是什么

> 本节只描述系统当前形态。变更过程归 §9，发布历史归[发布说明](release-notes.zh-CN.md)，已清偿债务归[债务存档](debt-archive.zh-CN.md)。

GoTry 是覆盖「一次出发到下一次出发」的证据优先旅行 Agent。模型负责理解意图、解释选择；typed 契约、确定性代码与显式授权闸决定哪些事实可信、哪些动作可执行。

### 1.1 交付形态与入口

| 关注点 | 当前形态 |
|---|---|
| 用户入口 | 源码工作区中的 `./gotry`，或 npm 的 `npx @danceiny/gotry@latest web` |
| 运行时 | Node `>=22.15.0` 上的 TypeScript／ESM，使用已选择的 DSH provider route |
| 产品形态 | Local 与 Web 共用工具契约、证据规则和账本语义 |
| 版本权威 | `package.json`、npm dist-tag 与[发布说明](release-notes.zh-CN.md) |
| 许可证 | MIT |

### 1.2 能力面

注册工具清单以代码为准；本文只列稳定能力类别，不复制数量或逐 issue 实现记录。

| 能力 | 当前边界 | 详细权威 |
|---|---|---|
| 规划与判定 | 动机访谈、可行性、行程构建和多选闸；算术与约束求解留在代码中。 | §3–§5；[工具契约](tools.zh-CN.md) |
| 证据检索 | 酒店、航班、火车、天气、地图、网页、视频和用户会话来源返回带来源与新鲜度的 typed observation；miss、挑战、畸形响应和传输失败保持不同语义。 | [数据源](data-sources.zh-CN.md)；[会话 RFC](rfc/user-session-data-rfc.zh-CN.md) |
| 产物 | 工单与行程 Markdown／HTML 可列出并作为源码阅读；生成只消费注册事实，预览与显式选择的本地复核是独立宿主能力。 | [产物事实闸](#819-可下单事实单一数据源--产物事实闸)；[Lavish 契约](design/lavish-local.zh-CN.md) |
| 记忆与连续性 | 动机、偏好、愿望池、同行人、时间线和后台工单按显式归属与溯源规则持久化。 | [记忆设计](design/memory-design.zh-CN.md)；ADR-15 |
| Booking Copilot | 内嵌 planner 针对既有预订工作台提出 typed 只读动作；搜索结果、报价、CheckAvail、Checkout 与订单状态仍由宿主掌握。 | §1.4；ADR-23；D-29 |
| 运维与外部事件 | Doctor、通道健康、指标与有界外部事件信封只暴露诊断或 inert 接缝，不静默改路由、写入或激活传感器。 | [外部事件接缝](design/external-event-seam.zh-CN.md)；§3 |

### 1.3 信任与执行不变量

| 边界 | 不变量 |
|---|---|
| 事实 | 影响可行性、价格、政策或可订性的断言必须绑定注册证据；未知、借用、畸形、过期或矛盾锚点一律 fail-closed。 |
| 时间 | host-local 时间锚、真实日历校验、IANA 时区和 DST 歧义检查由确定性代码执行；模型不做日期算术。 |
| 用户会话 | 浏览器检索保持只读、按站点授权、受节律限制且可审计；登录在外部站点完成，票据值不进入模型上下文。 |
| 状态 | tenant-scoped SQLite 账本是权威；投影可重建，幂等、待处理写入和 durable 工单终态显式化。 |
| 外部效应 | 工具代码描述效应，解译器负责渠道访问、重试、断路与测试替代；建议不等于隐藏派发。 |
| 长任务 | 每轮以当面回答、durable handoff 或 typed 终态之一结束；后台工单 ID 与子 Agent ID 不可混用。 |
| 写动作 | 预订、支付和供应商写入不进入普通工具面；未来写入必须另行准入 WriteGate，并由可信宿主做一次性授权。 |
| 评测 | fixture 与本地 proof 只证明工程行为；synthetic evidence、诊断 benchmark 与隔离 adapter 不代表真实用户、供应商或业务验收。 |

### 1.4 Booking Copilot 边界

Booking Copilot 是既有预订旅程里的助手，不是平行预订产品。

- 单一 canonical `booking.surface` 契约定义 planner 动作注册表、observation、receipt、工作区 revision 与生命周期事件；assistant 文本不可执行。
- Embedded persona 与 decision envelope 只以已注册的公开 DSH `system-prompt` 面为目标；未注册 patch 行不能承载决策权威。
- 生产 turn 通过已鉴权、BFF-bound 的上下文进入。浏览器 token、部署凭证、holder／guest PII、供应商成本和不透明后端 session blob 不进入 planner snapshot。
- Embedded profile 只暴露读动作：修改或运行搜索、筛选和聚焦结果、查询或比较报价、选择和验价、准备 Checkout、观察订单状态；不暴露 `Book`、支付、金额覆盖或 guest 数据修改。
- 具体 action 严格校验 schema、capability、expected revision、action identity 与事实引用。只有 parse／schema-shape 调用且在同一次 DSH run 中严格配对 SDK `INVALID_ARGS` 时，才允许跳过并由后续 canonical call 修复；成功调用、未配对拒绝、authority-invalid 输入与保留引用必须 fail-closed。adapter 不改写已成功的模型动作。
- 更高 search revision 可以替换或清空 `results` 与 `visibleHotels`，但必须清空 `focusedHotelRef`、`loadedOffers`、`shortlistedOfferRefs`、`selectedOfferRef` 与 `verifiedOffer`；revision 增加时，`search.patch` 也可以改变 `searchDraft`。同 revision 时，两个 search action 均不得修改工作区内容。缺失的 optional 值必须安全比较，且不能把 `undefined` 与 `null` 视为相同。迟到响应不得覆盖更新的用户状态，任何 Checkout handoff 都必须从随后核验的报价重新派生。
- Checkout 是唯一交易授权面。产品验收要求 changed／unavailable 报价先回到真实搜索和 CheckAvail 再建立新 handoff，并要求未知预订结果以相同 customer reference 通过 QueryOrders 对账；这些交易行为不是当前已激活的 GoTry 写能力。

以上实现契约不等于产品验收。tenant、customer、storefront 与 payment-link 四 surface 的真实库存旅程和 unavailable／changed 恢复仍归 D-29 与 [#142](https://github.com/Danceiny/gotry/issues/142)。

### 1.5 当前产品限制

| 领域 | 当前限制 |
|---|---|
| M3 | 工程与分发机制已存在；要求的真实种子用户 cohort 尚未进入证据面。 |
| M4 | 采集与 scorer 契约已存在；回访用户价值仍需 observed-private cohort 与人工 source review。 |
| M5 | WriteGate 只是未激活的机制与提案面；当前 runtime 声明不准入供应商交易路径。 |
| M6 | B2B 复用需要独立 Entry 决策、供应链证据与真实 pilot。 |
| Booking | tenant、customer、storefront、payment-link 的真实库存、恢复、Checkout 与订单对账仍开放。 |
| 外部事件 | W2A 是有界 inert 信封；默认没有 sensor listener 或 consumer 激活。 |
| Benchmark | 当前外部运行仅为 diagnostic-only；只有冻结、matched 且 evaluator 已执行的证据集满足 D-28，才可改变这一口径。 |

里程碑顺序与退出闸统一维护在[路线图](roadmap.zh-CN.md)。

## 2. 总体架构：五层与现状

```
L1 交互:对话即界面(gates 以消息内选择题呈现;独立 UI 属 Stage 1 后)
L2 编排：对话循环 ts/src/loop.ts —— LlmPort（mock／real、provider-neutral）+ 确定性访谈 + 求解挂载
    └ dsh 插件 gotry-tools：注册 typed 产品工具；bin/gotry-inner.js 根据 cordis.gotry-patch.yml 生成组合
L3 领域:统一行程模型 ts|py unified.* —— Segment/Option/锚点/工作窗口/时区
    └ 可行性引擎:Z3 选择 + 命名约束 + unsat core 归因 + Optimize 最优
L4 数据:静态数据包 data/*.json(真实班期+估算价,证据标注)+ 金标准用例
L5 治理:loopx(objective/gate/evidence/quota,验证后才花费)
```

| 层 | 职责 | 契约 | 不变量（任何演进不得破坏） |
|---|---|---|---|
| L1 | 呈现与采集 | 透明卡片 schema（D1 §6） | why/cost 必达用户；gate 只能是选择题 |
| L2 | 理解与编排 | `ts/src/contracts.ts`（TripState+五工具） | LLM 不做算术判定；写操作必过 WriteGate |
| L3 | 判定与核算 | 统一行程模型（§4）+TrueCost | 算术与求解分层；算术纯函数可独立测试 |
| L4 | 数据与能力 | CLI/JSON 桥（hotelbyte-cli 式） | 证据链标注（[实时API]/[共享经验]/[估算]）；估算必须显式标记 |
| L5 | 治理 | loopx 状态 | 验证后才花费；阻塞记录而非空转 |

数据流（洱海金标准，一次调用走完全程）：

```
素材(照片+一句话)→ 动机访谈(确定性缺失字段驱动)→ JourneySpec 抽取
  → solve_unified(Z3 选班,锚点/工作窗口/预算命名约束)
  → {verdicts, exclusions(带理由), red_flags, 最优预算} → 渲染(卡片+gates)
  → 不可行候选 → wish pool(成行条件:天数/预算/季节)
```

## 3. 代码地图（每个模块是什么）
完整模块清单(每个模块/测试套件一行:职责、状态与钉住它的验证分节)已迁至关注面权威文档[代码地图](code-map.zh-CN.md)。核心阅读路径:`ts/src/unified.ts`(统一模型+Z3 求解,唯一求解入口)→ `ts/src/loop.ts`(会话循环)→ `ts/src/index.ts`(dsh 插件接线);已退役的 `engine.ts`/`journey.ts` 仅作 golden 对比 oracle;能力层(通道注册表、会话检索、记忆、愿望池)逐项见代码地图。

→ 完整清单:[code-map.zh-CN.md](code-map.zh-CN.md)


## 4. 统一行程模型（领域核心，唯一求解入口）

```
JourneySpec = { segments, budget?, workWindow?, 默认起床线, … }
Segment     = { id, role: choice|fixed, anchors{arrive_by/depart_after/…}, options[] }
Option      = { id, move(services×transfers×缓冲×红眼×tz), stay?(晚数/价格/work_window), score, min_days }
```

- 两种形态同一模型：候选选择（洱海=1 段 3 目的地 Option）与段链（demo=5 段）；旧 engine/journey 是其在单段/固定链上的退化，已 deprecated。
- **求解分层**：算术纯函数（`evaluate_*`：起床/到达/精力/有效时长/金钱）与 Z3 选择（命名约束，unsat core 归因，Optimize 最优）严格分离。
- **时区语义（D-5 已清偿）**：真实飞行=（到−发）−时差；门到门=前置+真实飞行+接驳（EK329 全链 11h20m，飞行 7h35m 与官网逐分一致）。
- **工作窗口（M-1 已落地）**：家时区→出发地当地换算；工作日窗口内起飞的 Option 求解前确定性排除，理由入记录——gate q3 被一条规则确定性回答（周五晚班全排除，只剩周六早，与真实选择一致）。
- **红眼睡眠模型**：精力=30+8×（飞行−1h），clamp[30,75]；EK329 落地 75%（待对账 Q10 校准）。

## 5. 对话循环（L2）

`runTurn(state, msg, llm, solve)`：抽取事实（日历一次断言，冲突显式指出）→ 增量访谈（缺失字段驱动，workWindow/bookedResources 为求解前置，budgetTier 降为 gate 不阻塞）→ 约束齐备则 extractSpec→solve→渲染（方案+排除理由+红旗+gates 选择题）。复杂行程切**异步深度规划**（「一小时后回来看看」；回访交付自带不失望四条自检）。详细设计见 `design/stage1-top-down-design.md`。

**搜索调度**：`gotry_hotel_search` 与 `gotry_anything_search` 将独立只读调用交给 dsh 既有有界并发调度器。依赖查询等待前序结果，其他工具保持原有独占执行；宿主取消信号贯穿效应层与 CLI 层，不另建调度器。性能验收与限制见[测试报告](evaluation/parallel-search-perf-report.zh-CN.md)。

**重放验收**（`ts/scripts/replay.ts`）：Kimi 的 13 轮失败 = GoTry 3 轮；日历零反复；工作窗口与已订酒店首轮即被问出；终轮即已验证方案。

## 6. 数据与运行时

> **数据源唯一权威面 = `data-sources.md`**（2026-08-22 立）：领域矩阵 × 四层架构（静态包/免费实时/hbcli 桥/OSM 生态） × Google Place 链路（hbcli→search OpenAPI→geography） × 证据链契约 × TREK 参考采纳。本节只留运行时概要。

- 运行时：两条已实证路径——①TS 进程内（自研循环，~6ms/解）；②真实 dsh headless+cordis 组合（pi-ai→MiniMax，`cordis.gotry-patch.yml`，68ea364）。v0.0.1-rc.2 起 Python CLI 桥下线，纯 TS。环境三件套 `LLM_API_KEY/LLM_BASE_URL/LLM_MODEL`（兼容旧 DEEPSEEK_*）。
- 复用落地：dsh（import，rc 已对齐）/loopx（import，0.5.1 运行中）/Z3（import，双绑定）/hotelbyte-cli（import+extend，place 链路见 data-sources.md §4）/T 系统·ai-agent-book·TREK（reference，零代码——TREK 数据面模式采纳表见 data-sources.md §5）。内核清单已冻结（issue #234，PR 待链）：`ts/data/kernel-manifest.json` 钉住内核模块面（引擎 `unified.ts`/`model.ts`，账本 `state-ledger.ts`，闸 `bookable-facts.ts`/`artifact-gate.ts`；逐项 SHA256 + 依据，绑定冻结 baseSHA），机械闸（run-all §63）证明哈希零漂移 + 真实运行 import trace 全加载 + 同引擎/账本/闸路径功能覆盖 + 证据快照哈希绑定。

## 7. 测试与验证策略

**评测三层（ADR-11）**：
- **回归层（防退化）**：TS-vs-TS 双路径稳定性（同 spec 不同 module instance）+ 金标准断言（洱海 8+5、普吉链 4、统一模型 20/20）+ **重放夹具**（mock 重放即行为级回归，Kimi 对话是失败基线）。**v0.0.1-rc.2 起：** 不再依赖 Python oracle 差分；run-all-tests 9 套一次性绿，无需 Python 运行时。全栈入口：`scripts/run-all-tests.sh`。
- **质量层（防漂移）**：评测集+指标面板——POI 幻觉率、定稿率、不失望四条、NPS；M3 上线（见 `tech-strategy.md` §4），此前以 replay 终态断言兜底。
- **巡检层（防「mock 绿而真智能烂」）**：真 LLM 重放（`replay-real.ts`）的 nightly 形态已落地——`nightly-evidence.ts`（封存 prompt 集 + 封存价表，预算闸 `GOTRY_NIGHTLY_BUDGET_USD`，无凭证 waiting/backoff/no-spend 零写入，run-all §35；真跑花钱不进 CI，heartbeat/founder 手动执行）。产出 `gotry_m3_nightly_run_v1` 记录追加进**私有证据账本** `ts/gotry-state/evidence/m3/cohort.jsonl`（git 忽略）；`cost_usd` 只来自 dsh-llm 的 usage 累计器 × 封存价表。ADR-10 正是 mock 绿而真 LLM 烂出来的，教训制度化。

## 8. ADR

**生命周期**：提案 → 采纳 →（已清偿 | 被取代 | 退役）；「永不复审」是显式终态类（ADR-7/9/10 依据的是不变量级判断）。**三个诞生渠道**：① 失败诞生——真实运行暴露 mock/推演看不见的问题，当天立 ADR（ADR-10 模式）；② 对账诞生——`milestones/demo-reconciliation.md` §三：模型缺项→记 ADR 并评估是否进引擎；③ 里程碑复审诞生——M-exit 全表过一遍淘汰/复审条件（§11），触发的当即立项。**锚点**：每条 ADR 必须有代码/测试执行锚点，或显式标注「流程级」——没有锚点的 ADR 会在演进中悄悄失效而无人察觉。

| # | 决策 | 备选与取舍 | 淘汰/复审条件 | 锚点 |
|---|---|---|---|---|
| 1 | Z3 作判定层 | 规则引擎/OR-Tools/纯 LLM（4.4%） | 求解 >500ms 或变量 >10³ 评估 OR-Tools；unsat core 不可让渡 | `unified.ts`/`unified.py` 求解层；双侧套件 |
| 2 | 双实现 TS 生产+Python oracle | 单实现（无对账） | **2026-08-22 v0.0.1-rc.2：** Python oracle 路径下线（diff-test 改为 TS-vs-TS，run-all-tests 不再依赖 Python 运行时）；py/ 保留为历史对照（不删），**不再被产品运行时引用**——npm 一键分发前提 |
| 3 | 桥接收敛：进程内优先 | 全 TS/全 Python | **2026-08-22 v0.0.1-rc.2：** Python 桥下线，仅剩 hbcli 桥（vs hbcli & hbcli fallback）；每桥 ≤2 不变 | `ts/capabilities/hbcli.ts`；`bridge.latency.jsonl` |
| 4 | loopx 为控制平面 | 自研状态机 | 概念冲突且无法适配时 | 流程级（`.loopx/` 治理状态） |
| 5 | 统一行程模型 | 维持双引擎 | 已清偿（engine/journey 退役日=迁移完成日，D-7 跟踪） | `unified.ts`/`unified.py` |
| 6 | 静态数据包（demo 期） | 直接接 API | M2 退役为夹具 | `data/*.json`；金标准用例 |
| 7 | 算术/求解分层 | 混合 | 永不复审 | `model.ts`/`model.py` 纯函数层（分层测试结构） |
| 8 | mock-LLM 先行 | 等 API key（伪阻塞） | S4 完成后 mock 留作回归夹具（已兑现） | `ts/src/mock-llm.ts`；`ts/scripts/replay.ts` |
| 9 | 访谈确定性（缺失字段驱动） | LLM 即兴（Kimi 病根） | 永不复审 | `loop.ts interviewNext`；replay 夹具（首轮问出工作窗口） |
| 10 | 翻译≠造数：LLM 只产骨架与锚点，班次数据永远来自能力层（数据包→实时API）；spec 校验闸兜底 | 让 LLM 直接产出完整 spec（实测：MiniMax-M2 编不出时刻，要么编造要么卡死） | 永不复审 | `loop.ts validateSpec`；`dsh-llm.ts SKELETON_SYSTEM`；`replay-real.ts` |
| 11 | 评测分层进架构：回归层（单元/差分/重放）防退化、质量层（评测集+指标面板）防漂移、巡检层（nightly 真 LLM 重放带预算闸）防「mock 绿而真智能烂」；M-exit 必过对应层级 | 只靠重放夹具（质量漂移无感）/事后补评测工具（指标不进架构等于不存在） | M3 exit 指标面板上线后复审一次 | `run-all-tests.sh`；replay 三件套；`tech-strategy.md` §4 |
| 12 | 时间感分层：锚点卡（算术进代码）+ 槽位逐字保留（LLM 不换算不翻译）+ 过期/language 判定归代码层 | [§8.12](adr-expansions.zh-CN.md#812-时间感分层) | **2026-08-27 复审（D-10 切片 A 触发）：设计成立**，补充边界[§8.12](adr-expansions.zh-CN.md#812-时间感分层) | `time-anchor.ts`；`travel-slots.ts`；`slot-spec.ts`；`time-eval-tests.ts` |
| 13 | 工具观察 envelope（RFC S1，effect-interpreter 映射）：12 工具成功路径平铺 `ok:true` + 载荷，失败 `{ok:false,summary,evidence}`（guard 兜底同形，`ToolFailure` 编译期对齐）；参数三形态归一唯一入口 `interpretArgs`（原 unwrapQuery 移居 `tool-packet.ts`） | 逐工具自由返回（形状漂移，每个新工具重新猜）/嵌套 envelope `{ok,value}`（渲染/调用方全要拆包，侵入大） | 出现第二个真实调用方（非 dsh 非 smoke）需要不同观察形状时复审 | `tool-packet.ts`；`incident-log.ts guardToolExecute`；smoke §9 |
| 14 | 记忆效用 sidecar（RFC S2/S3）：三类事件 append-only，**归因只认 owner 确认**；wish 稳定 id + 休眠制；召回 0..1/轮 | [§8.14](adr-expansions.zh-CN.md#814-记忆效用-sidecar) | 多用户 AaaS 账本化（RFC §6.5）或出现第二个效用消费方时复审 | `memory-utility.ts`；`index.ts gotry_wish_pool_list`；smoke §10 |
| 15 | 事务化状态基座（RFC `rfc/transactional-state-rfc.md`，业界 durable-execution 五件套收敛） | [§8.15](adr-expansions.zh-CN.md#815-事务化状态基座) | 多用户 AaaS 化（RFC §6.5 claim/CAS 实装）或需要多写者/多端复制（cr-sqlite/Litestream，触发式=D-15）时复审 | `state-ledger.ts`；run-all §28/§29 |
| 16 | 双形态架构冻结（本地+Web）：**一套账本语义，两种宿主绑定**；`tenant_id` 一等字段；append/read/fold/rebuild 全部以当前 ledger owner 为作用域；同步=事件复制非状态翻译 | [§8.16](adr-expansions.zh-CN.md#816-双形态架构冻结) | 永不复审（双形态是产品形态基座）；同步协议与 claim/CAS 实装按触发器后置；历史 local 事件不可无证据自动反推租户 | `state-ledger.ts` schema v2；run-all §28 双形态断言 |
| 17 | 预订 saga 状态机具名化（issue #17 采纳，2026-08-29） | [§8.17](adr-expansions.zh-CN.md#817-预订-saga-状态机具名化) | M5 拍板 WriteGate 时复审（启封增量的 schema CHECK/seam 词汇/L4 自动类）；若出现需要并行多写者的预订流，复审 keyed 单写者形态 | `ts/src/booking-saga.ts`；`docs/design/booking-saga-fsm.md`；run-all §36 |
| 18 | 效应解译器 effect_interpreter.v1（issue #16 采纳，2026-08-29） | [§8.18](adr-expansions.zh-CN.md#818-效应解译器-effect_interpreterv1) | 出现需要跨渠道比价聚合的产品裁决时复审「平铺」边界；写效应（预订/支付）入注册表时必须走 booking_saga_fsm.v1 边表（M5 Entry） | `ts/capabilities/effect.ts` `resilience.ts`；`docs/design/effect-interpreter.md`；run-all §37 |
| 19 | 可下单事实单一数据源 + 产物事实闸（issue #46,2026-08-30） | [§8.19](adr-expansions.zh-CN.md#819-可下单事实单一数据源--产物事实闸) | 出现第二类需闸产物（如酒店直订）时复审覆盖面；政策实时源接入后复审政策事实生产端；根治方向=产物只由渲染原语生成（结构化→markdown 单向），反向抽取降为兜底 | `ts/src/bookable-facts.ts` `ts/src/artifact-gate.ts`；`data/airline-airports.json`；run-all §39；smoke §16 |
| 20 | 价表 provider-aware v2 + 价格漂移长机制（issue #49,2026-08-30）：封存价表 `gotry_llm_price_table_v2`（DeepSeek tiered + MiniMax flat，未知模型 fail-closed 不猜价）+ 四 provider 漂移监测，**永不自动 apply 价格**（调整走 PR + 人 review） | 发版时人工核价（滞后）/自动 apply（拒绝：官方 down 5% 曾被误认为我方 bug） | 监测误报成系统性问题、或价格源形态变化时复审 | `ts/data/llm-price-table.json`；`ts/scripts/price-drift-watch.ts`；run-all §41/§42 |
| 21 | 扩展分发三通道（issue #21 分发通道，2026-08-30；商店轨 2026-09-02 上架） | [§8.21](adr-expansions.zh-CN.md#821-扩展分发三通道) | ~~商店过审后复审 wizard 步骤~~（已触发：wizard 退化为离线健康探活等待；安装=浏览器的事、渲染=dsh UI 的事，§3.3 职责返交落地）；GitHub 不可达地区常态化时复审镜像默认值；出现第二分发产物时复审通道抽象 | `ts/capabilities/session/extension-distribution.ts`；`scripts/package-extension.mjs`；run-all §43；`docs/ops/extension-webstore-submission.md` |
| 22 | static golden 是**可审计 benchmark comparator**，不是实时航班源（issue #67） | [§8.22](adr-expansions.zh-CN.md#822-static-golden--可审计-comparator) | 出现可免私有凭证、许可清晰且稳定的官方 flight API，或 hbcli 发布 flight 合同时复审其为新 provider；static 仍只保留为确定性回归夹具 | `ts/capabilities/session/static-flight-golden.ts`；`ts/data/sf-static-routes.json`；run-all §44 |
| 23 | embedded Booking Copilot 安全边界与 BFF request identity binding（单一 booking.surface 契约） | [§8.23](adr-expansions.zh-CN.md#823-adr-23embedded-booking-copilot-安全边界与-bff-request-identity-binding) | 出现离页自动写/支付必须进入 M5 WriteGate proposal/ADR 后续实现；出现多写者/跨 host 触发 ADR-15/16 复审；~~所有消费方迁移 v2 后再退 v1~~（**已触发 2026-09-05**：#133 收敛为单一契约，v1 退役，文件转正为无后缀 canonical 名） | `schemas/booking.surface.schema.json`；`ts/src/booking-surface/`（contracts/runtime/server/startup 等）；run-all 证明面 |
| 24 | turn 预算 = 路由 + wall-clock 双出口：确定性分类 → converge/handoff；handoff 落独立工单待 loopx tick 收 | [§8.24](adr-expansions.zh-CN.md#824-adr-24turn-预算--路由--wall-clock-双出口（turn-policy-/-turn-deadline）) | 路由误分成系统性问题时（用户反馈「该当面答的被转后台」可观测），先扩 Tier 0 信号词表再考虑 Tier 2（结构化状态）；handoff 工单积压需要真实收集器时启动 loopx tick 设计；评测端 60s 太紧先调 env pin | `ts/src/turn-policy.ts`；`ts/src/turn-deadline.ts`；`ts/src/index.ts` 装配；`ts/scripts/turn-policy-tests.ts`；`ts/scripts/agent-planning-turn-deadline-{tests,e2e}.ts`；`scripts/run-all-tests.sh` §45 |
| 25 | 通道健康面与动态路由建议（issue #106/#107/#108，D-7/D-8/D-9 采纳 2026-09-03）：工具面保持平铺（ADR-18 判定不动）、解译器不做隐藏改道；通道注册表单一数据来源生成 persona 卡/工具描述/doctor 行；检索 verdict≠hit 时结果内注入 `routing` 有序建议（可用性>证据级>效率字典序，健康态过滤），契约在失败现场教学；配额五分类（user-session/user-key/anonymous-trial/free-public/static）冻结归属语义；calendar 默认不挂载（D-9） | 解译器自动改道（拒绝：模型以为调 A 实际走 B，破坏调用可审计性）/静态反转优先级（拒绝：每个新用户先付扩展安装成本）/只靠 prose 教义（拒绝：prose 腐坏，普通模型读不动） | routing 建议误配成系统性问题时先修注册表数据；出现跨通道比价聚合产品裁决时与 ADR-18 一起复审；正式 key 池（产品统一申请）待 M3 真实 cohort 规模复审 | `ts/capabilities/channel-registry.ts` `channel-health.ts`；`docs/design/tool-orchestration-design.md`；run-all §50；smoke（flyai needs-setup→routing） |

逐决策正文已迁至关注面权威文档 [adr-expansions.zh-CN.md](adr-expansions.zh-CN.md),与其 ADR 行同改。

## 9. 演进

本节记录长期有效的架构转变，不承担逐 issue 变更日志。当前契约归 §§1–8，开放义务归 §10，里程碑顺序归[路线图](roadmap.zh-CN.md)，逐变更历史归 git、[CHANGELOG](../CHANGELOG.md) 与[发布说明](release-notes.zh-CN.md)。

### 9.1 长期有效的转变

| 阶段 | 长期结果 | 当前权威 |
|---|---|---|
| M0–M2 | 确定性选择评估、Agent 对话闭环与带来源的实时检索，取代模型自算与无来源声明。 | §§2–7 与 ADR-10／19 |
| M3 | dsh Web／runtime 形态、产物面、只读会话检索与产品证据机制成为当前交付形态。 | §§1–7；[工具契约](tools.zh-CN.md)；[数据源](data-sources.zh-CN.md) |
| M4 准备 | 租户作用域记忆、愿望召回、生命周期 collector 与评测准入属于工程支持。真实回访用户证据仍是里程碑闸门。 | §10；[路线图](roadmap.zh-CN.md)；[评测基座](evaluation/evaluation-foundation.zh-CN.md) |
| M5／M6 准备 | WriteGate、预订 saga、对账、披露、内核复用与 sponsor 边界只以受闸契约或默认关闭机制存在。它们不会激活供应商写入，也不能证明真实试点。 | ADR-17／18；§10；[WriteGate 设计](design/write-gate-production-design.zh-CN.md) |

### 9.2 当前工程线

- **检索与会话：**注册工具使用 typed 结果契约、来源标注、通道健康与只读浏览器桥。供应商 shape 与 live 校准归[数据源](data-sources.zh-CN.md)和[适配器手册](design/adapter-authoring-guide.zh-CN.md)。
- **产物与评审：**行程渲染只从 registry 选择的事实创建一个受限新文件；list／read 与可选本地评审是独立能力。输入、路径、预览与生命周期细则归[工具契约](tools.zh-CN.md)和对应设计文档。
- **证据与评测：**确定性 fixture 只证明工程边界。外部 score、uplift、供应商库存、用户价值与里程碑退出均需各自准入的真实证据集。
- **外部事件：**W2A 契约默认关闭且 inert。接受 envelope 不会自动产生 listener、consumer、状态写入或交易权威。
- **交易：**预订、支付、退改、退款与佣金效应仍受 M5 准入与 WriteGate 约束。只读调查与纯契约不会启封该边界。

### 9.3 Booking Copilot 边界

长期转变是从独立对话式预订流程，转向既有搜索、报价与 Checkout 工作台中的 BFF-bound typed 只读动作。宿主事实与 Checkout 权威保持不变；当前可执行边界只在 §1.4 与 ADR-23 维护一次。

真实库存、unavailable／changed 恢复、Checkout 与 QueryOrders 证据仍归 D-29 和 [#142](https://github.com/Danceiny/gotry/issues/142)。

### 9.4 历史细节

本节刻意不保留已关闭 issue 叙事、精确测试计数、短期包版本和带日期的实现日记。时间线查 git 与发布说明，已清偿义务查[债务归档](debt-archive.zh-CN.md)，长期契约与证据账本查各自的设计或评测文档。

## 10. 债务清单

> 这是未偿义务清单，不是变更日志。已清偿项移入[债务存档](debt-archive.zh-CN.md)；实现过程归 §9、发布说明、issue 与 Git。每行只保留尚缺条件、可移除它的证据和跟踪权威。

### 10.1 未清偿（工作面）

| ID | 未偿义务 | 退出证据与跟踪 |
|---|---|---|
| 账本修复／#254 | 历史事件可能被错误记在默认 `local` tenant。只读 plan 和需授权的 apply／rollback 已存在，但 fixture 不能证明真实数据是否需要修复。 | 按[操作手册](ops/ledger-tenant-repair.zh-CN.md)使用带校验和备份与 digest 绑定流程，产出 founder 授权的真实修复 receipt，或记录确认无需修复的决定。 |
| SDK 直连 runtime 触发器 | 未来 `dsh-sdk-client` 产品 runtime 不会自动继承 CLI launcher 的进程组清理保证；在提出这种 runtime 前保持 dormant。 | 激活前为具体直连生命周期指定后代进程归属并证明有界清理；本跟踪项不授权 vendor fork 或 runtime 激活。[#422](https://github.com/Danceiny/gotry/issues/422) |
| D-37 | CfT／Chromium 扩展 API 目前看不到 Dida 的 HttpOnly 票据 cookie，因此 quick login check 可能误报 `needs-login`；页面请求与被动响应嗅探仍可工作。 | 上游修复，或经验证的品牌 Chrome + 商店扩展路径能够观察所需登录态。[#272](https://github.com/Danceiny/gotry/issues/272) |
| D-13 | 用户会话 adapter 仍会受真实站点与浏览器漂移影响；离线 parser 和 static comparator 不代表 connected 行为。 | 按[会话 RFC](rfc/user-session-data-rfc.zh-CN.md)为每个支持 adapter 采集真实 connected 与显式 degraded 证据，包括 challenge／guard stop 语义和 packaged entry 行为。[#272](https://github.com/Danceiny/gotry/issues/272) |
| D-15 | 单文件 tenant 账本尚无已准入的多写者、云备份或多机复制路径。 | 只有第二个真实用户、多机部署或 AaaS 立项触发；届时定义并证明 claim fencing、备份与复制语义。[#275](https://github.com/Danceiny/gotry/issues/275) |
| D-18 | M3 缺少真实种子用户证据。 | 真实 50–200 人 cohort 同时达到完成率 ≥40%、NPS ≥40、POI 幻觉率 <1%，并具备窗口内可复跑 nightly 证据；synthetic fixture 与无凭证 waiting run 不计入。[#22](https://github.com/Danceiny/gotry/issues/22) |
| D-19 | M4 缺少可观察的回访用户价值。 | `observed_private` cohort 达到 N≥5、规划时间 median reduction ≥0.5，输入采用 HMAC 假名键，具备人工 source review，且 review digest 绑定报告 summary；candidate 或 synthetic export 不计入。[#20](https://github.com/Danceiny/gotry/issues/20) |
| D-22 | `pending_writes` 仍缺 booking saga 契约指定的物理非空 receipt CHECK；outbox 自身已有约束，但不能替代这一接缝。 | 在已准入的 M5 Entry 中加入 schema CHECK 并冻结接缝词汇，且不得提前激活供应商写路径。[#136](https://github.com/Danceiny/gotry/issues/136)、[#231](https://github.com/Danceiny/gotry/issues/231) |
| D-26 | 事实闸对部分无锚文本仍依赖有界反向抽取，尚无已准入的 FX／多币种结算政策或完整 live-source 覆盖；已知或带锚断言当前仍 fail-closed。 | 将每项残余替换为具名 canonical fact path 和反例；只有真实供应商报价、预算或目的地需求出现时才准入非 CNY 处理。[#381](https://github.com/Danceiny/gotry/issues/381)、[#344](https://github.com/Danceiny/gotry/issues/344) |
| D-28 | 外部 benchmark 尚未产出 matched、可归因证据集；diagnostic run 与部分 terminal 不能支持 uplift 声明。 | 冻结 cohort 必须得到有效非空 terminal 且 evaluator 已执行，再满足原 manifest 与 registry 控制后才允许 aggregate 或 uplift 陈述。[#203](https://github.com/Danceiny/gotry/issues/203)、[评测契约](evaluation/evaluation-foundation.zh-CN.md) |
| D-29 | Booking Copilot 缺少真实库存产品验收；工程契约、fixture 与可复现产物不能替代该旅程。 | 先解决 [#473](https://github.com/Danceiny/gotry/issues/473) 的权威错误优先级；冻结 GoTry、hotel-be、hotel-fe 精确 SHA；覆盖 tenant、customer、storefront、payment-link；至少让一条 unavailable／changed 报价经重新搜索、新 CheckAvail 与原 Checkout 恢复；`Book` 只在 Checkout；未知结果经 QueryOrders 对账并留存清理证据。产品跟踪：[#142](https://github.com/Danceiny/gotry/issues/142)。 |
| D-33 | M4→M6 program 仍缺把回访用户价值、供应链与 B2B 复用连接起来的真实证据和准入决定。 | 满足 D-18／D-19；取得 M5 protocol、buyer、routing、reconciliation、UAT signing 或内部授权证据；再取得独立 M6 Entry 决定与真实 pilot 合同。[#270](https://github.com/Danceiny/gotry/issues/270)、[#136](https://github.com/Danceiny/gotry/issues/136)、[#137](https://github.com/Danceiny/gotry/issues/137) |
| D-39 | 地面接驳逻辑仅覆盖显式坐标驾车估算与静态价格证据；live traffic、transit／rail、fare、地址解析和更广组合未准入。 | 每条扩展路径都需要具名产品场景、数据源、新鲜度契约、访问边界与真实数据证明；只读路由不授权任何写路径。[#429](https://github.com/Danceiny/gotry/issues/429) |

## 11. 保鲜机制

保鲜指在正确抽象层保持语义一致，不是把同一段 issue 文字复制进所有文档。

| 权威面 | 负责 | 不得退化为 |
|---|---|---|
| §1 | 稳定的当前系统形态与不变量 | 带日期的实现日记 |
| §9 | 长期架构转变与当前工程边界 | 逐 commit 变更日志 |
| §10 | 开放技术债与偿还条件 | 已落地功能清单 |
| [路线图](roadmap.zh-CN.md) | 里程碑顺序、准入、退出与当前闸门 | 实现流水账 |
| 根 [README](../README.zh-CN.md) | 面向用户的承诺、可用／未可用边界与权威入口 | issue 或测试报告 |
| [Stage 1 设计](design/stage1-top-down-design.zh-CN.md) | 冻结的历史设计 | 当前状态面 |

**同提交规则：**只更新所负责事实确实变化的权威面，其他文档保留短指针。跨文档复制实现段落、日期、测试计数或 issue 序列属于文档缺陷，不属于同步。

**M-exit 保鲜清单：**

1. 对账上表中受影响的权威面，并确认指针仍可解析。
2. 逐条检查 ADR 的淘汰或复审条件；触发时立即建 issue 或改状态。
3. 债务只在 §10 新增或关闭；已清偿项移入[债务归档](debt-archive.zh-CN.md)。
4. 易腐计数改为代码或测试入口引用。
5. 可复跑命令与精确 SHA 放进 commit 或 PR 证据，不塞进面向读者的摘要。
6. 运行双语与读者状态面文档闸。

**复审节奏：**事件驱动。每次里程碑退出复审全表；ADR 条件触发时立即复审。

## 12. 文档地图

组织契约与完整文档索引归 [docs/README.zh-CN.md](README.zh-CN.md)。本文只保留理解架构所需的稳定入口：

| 需要 | 权威来源 |
|---|---|
| 里程碑顺序与闸门 | [roadmap.zh-CN.md](roadmap.zh-CN.md) |
| 产品模型 | [gotry-product-design.zh-CN.md](gotry-product-design.zh-CN.md) |
| 程序决策与复用约束 | [gotry-master-outline.zh-CN.md](gotry-master-outline.zh-CN.md) |
| 数据源与证据政策 | [data-sources.zh-CN.md](data-sources.zh-CN.md) |
| 工具契约与运维入口 | [tools.zh-CN.md](tools.zh-CN.md) |
| 发布决策与时间线 | [release-notes.zh-CN.md](release-notes.zh-CN.md) 与 [CHANGELOG](../CHANGELOG.md) |
| 开放技术债 | 本文 §10 |
| 其他设计、研究、里程碑、评测与运维文档 | [文档总索引](README.zh-CN.md) |
