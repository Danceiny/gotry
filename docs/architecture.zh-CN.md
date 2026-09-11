[English](architecture.md) | [简体中文](architecture.zh-CN.md)

# GoTry 技术文档（唯一技术权威面）

> 定位：本仓的**完整技术文档**——系统是什么、怎么构成的、每个模块在哪、怎么跑、往哪演进。
> 读者：接手或维护本仓的工程 agent 与人。想知道「现在是什么形态」看 §1，「为什么这么定」看 §8，「该接什么活」看 §10。
> 纪律：单一文件承载单一关注点，版本历史归 git，不设 vN 文件后缀；上游为总纲（`gotry-master-outline.md`）与产品设计（`gotry-product-design.md`）。
> 下游：loopx todos 依本文§9 演进阶段与§10 债务清单派生；引擎/求解器细节工作只在债务清单标注时进行。

**速览**

- GoTry 是「从出发到下一次出发」的 AI 旅行 Agent：LLM 负责理解与解释，确定性组件负责判定与算术，写操作永远有闸。
- 当前形态：M3 最小可用、分发链路无堵点；M3 Exit 缺真实 cohort 证据（D-18），M4 记忆域经 founder 授权并行推进。
- dsh 外层生命周期由 GoTry launcher 负责：child 在独立 POSIX process group 中运行，exit/error（含继承 stdio 导致 close 延迟）、异常 close 与 parent-only SIGINT/SIGTERM 经过有界 TERM→KILL 并确认 direct child/group 清空；这不覆盖 dsh SDK transport 或其内部 supervisor 的更深层 owner 契约。
- M4 评分与显式同意采集、tenant CLI 边界、Z3 生命周期及全栈稳定性修复均已进入 main；#258/#267 web onboarding 只是 M4 UX 工程面，其 POSIX onboarding/installer 进程组与 accepted-install signal/timeout 清理不提升 #20 Exit。M4→M6 living 任务图与 M5 WriteGate 仍只排依赖和验收。真实 M3/M4 cohort、供应协议/内部授权、P6 批准与真实试点仍为 TODO，各里程碑 Entry/Exit 不变。
- 五层：L1 交互 / L2 编排（dsh 插件）/ L3 统一行程模型 + Z3 / L4 数据能力 / L5 loopx 治理。
- 状态基座：单文件 SQLite 账本（ADR-15），本地+Web 一套账本语义（ADR-16）；`tenant_id` 贯穿 append/read/fold/rebuild，旧 local 历史不猜租户；外部依赖全走效应解译器（ADR-18）。
- 外部 benchmark：Round 1–10 frozen treatment 与 Round 11 wire 切片均不产生可归因 official score/uplift，Round 12 结构半场（config v4 closed body schema）已合入而冻结重跑未跑（D-28）；逐轮事实见 §9，工程合同见 `evaluation/benchmark-environment-bridge.md`。
- **#290 兼容注（2026-09-09）**：目标 `dsh-system-prompt` Config 公开 `personaPrefix` / `personaSuffix`，legacy `persona:` 不投影；桥 handler 结构性归类错误：`timed_out` 是 deadline 中止，`spawn_failed` 是同步 spawn 或 rejected 公开 `done`，`runner_failed` 是 resolved 非零退出或 resolved 之后读取 collected output 失败。详见 §9 #290 条目。不宣称 release/publication、M5/M6 entry、Windows 执行或真实 supplier/HotelByte 准入。
- **#327 严格重复 tool-call 参数修订（2026-09-10）**：planner 先保留普通单对象 `JSON.parse`；仅在完整输入由至少两个、仅以空白分隔且深结构相等的顶层 JSON 对象组成时恢复。前缀、尾部垃圾、截断/冲突对象、非对象序列和单个非法对象均 fail-closed；恢复扫描尊重字符串内花括号与转义，不再改写 raw control chars。证据限于离线 `runPort → tool/call → parseToolDecision` proof，不构成真实 provider reliability、HotelByte UAT、M3/M4 cohort 或 M5/M6 admission。
- **#341 地面接驳第一切片（#364 方向绑定）**：`gotry_feasibility_check` 只接受显式起点/终点经纬度与 `mode=driving`，通过已注册公开 `map_driving_route` 结果生成带 `asOf`、freshness/cache、provenance 与 evidence class 的路线事实；抵达方向（A→B）与返程方向（B→A）分别请求、缓存与降级，任一方向 miss/error/stale/不匹配仅回退该方向到静态估算，不借用另一方向的动态值；仅改具名 destination 的静态 `taxi` transfer 分钟（持有 `minutesOut` / `minutesRet` 覆盖供 `evaluateChoice` 按方向消费），`bus`/`bus_plus_taxi` 保持静态值并返回明确回退，静态价格始终标 `[静态包:估算]`。`asOf` 是宿主观察/查询时间而非 provider 发布时间；缓存命中与过期重查可见，provider 失败、非法坐标、不支持模式和绑定不一致均明确保留静态值；不覆盖 live traffic、transit/rail/fare，也不改变 #20/M5/M6 既有准入边界。
- **公开交付台账（#270）**：所有执行 lane 以 issue 启动、Draft PR、exact-head review、merge/destination 回执留档；founder 授权的仓内 Claude Code/worktree 不适用外部机器人 T0/T1 一票否决，但仍过正常 review 与证据闸。公开合同见 `ops/external-pr-workflow.md` §0；本地/fixture 证明不改变 #20/#22/#136/#137 的真实 gate。
- 找活干去 §10.1；时间线归 `roadmap.md`；文档组织规范归 `README.md`。

**目录**

| | | | |
|---|---|---|---|
| [1 系统是什么](#1-系统是什么) | [2 总体架构](#2-总体架构五层与现状) | [3 代码地图](#3-代码地图每个模块是什么) | [4 统一行程模型](#4-统一行程模型领域核心唯一求解入口) |
| [5 对话循环](#5-对话循环l2) | [6 数据与运行时](#6-数据与运行时) | [7 测试与验证](#7-测试与验证策略) | [8 ADR](#8-adr) |
| [9 演进](#9-演进时间线唯一来源-roadmapmd-的-m0-m6此处只保留原则与现状) | [10 债务清单](#10-债务清单引擎细节工作只能来自这里) | [11 保鲜机制](#11-保鲜机制文档与现实的同步纪律) | [12 文档地图](#12-文档地图) |

---

## 1. 系统是什么

> 本节只回答「系统**现在**是什么」。「什么时候发生了什么、为什么改」一律归 §9 演进与
> `release-notes.md`——本节出现日期叙事即为错位（§11 保鲜纪律第 4 条）。

**GoTry 是「从出发到下一次出发」的 AI 旅行 Agent**：动机访谈进、已验证的行程方案与选择题出；LLM 负责理解与解释，确定性组件负责判定与算术，写操作永远有闸。

M3 最小可用产品，分发链路无已知堵点。

**时区面（Issue #343）**：`ts/src/tz-resolver.ts` 将 v2 的显式 IANA zone 与 local date 解析为 UTC instant，在 parse 边界拒收未知 zone 与 DST gap/overlap；`ts/src/model.ts` 的 `doorToDoorFromMove` 统一使用 UTC instant 计算耗时。dsh/mock adapter 保留 v2 pack 的 `homeZone`，profile 只提供 schedule，explicit vacation 移除该行程的 work-window restriction，numeric v1 保持兼容。该确定性契约不代表 live schedules/prices/availability/inventory，数据源边界见 [`docs/data-sources.md`](data-sources.zh-CN.md)。

### 1.1 交付形态与入口

| | |
|---|---|
| 入口 | `./gotry`（仓内）或 `npx @danceiny/gotry@latest web`（npm） |
| 运行时 | dsh 成品形态，DeepSeek 原生 |
| 版本 | 见 `package.json` 与 `release-notes.md`；**`rc` dist-tag 已指向最新 rc（2026-09-02 #50② 完成），`@rc` 可用；用户引导仍优先 `@latest`** |
| License | MIT |
| 人格 | 行为契约 13 条（2026-09-11 瘦身：窄域细则归位工具描述/路由卡，条数回归锚=persona-surface-guard-tests）；锚点卡/记忆 brief/通道路由卡注入 persona。**运行时组合唯一来源 = 仓根 `cordis.gotry-patch.yml`** |

### 1.2 能力面

工具面注册于 `ts/src/index.ts`（**清单与计数以代码为准，此处不落数字**——§11 保鲜清单第 4 条）：

- **判定类**：可行性、骨架校验、航班校验、**产物事实闸 `gotry_fact_gate`**（交付前必过，blocked 不得宣称「已验证方案」）
- **可行性日期边界（Issue #2）**：`gotry_feasibility_check` 对任何带日期候选默认按宿主时钟施加 future 下界；显式 `planning.intent=future` 的请求年份再施加年末上界，过期年份不滚年，预期拒绝返回结构化 validation result 而非 incident。完全 dateless 输入保持旧可行性计算；历史计算必须显式 `planning.intent=historical`。
- **检索类**：酒店（`gotry_hotel_search` hbcli 桥 + **会话面 ctrip-hotel**：用户登录态真实价，被动嗅探）、天气、Anything 通用搜索、网页、视频字幕、GitHub、飞猪官方检索（机/火/酒）、会话检索（机/酒/火；火车=12306 公开查询面；**dida 供应商门户**：hotel-be portal integration 迁移线，2026-09-09）
- **酒店日期输入闸（issue #283，D-36）**：共享 `time-anchor.ts` 的 `parseAbsoluteDate` 使用 `isRealIsoDate` 拒绝不存在的日历日，酒店消费边界再拒缺失日期、算术溢出和退房不晚于入住，有效日期才进入 `HBCLI_HOTEL_SEARCH`。失败统一返回 `verdict=input_required` 且不 dispatch hbcli；有效日期和既有供应商失败后的明确静态降级保持兼容。隔离 fixture 只证明工程边界，不构成真实供应商准入。
- **携程机票 malformed 响应闸（issue #279）**：结构化 batchSearch 解析把合法空列表判为 `miss`、含有效航段判为 `hit`、畸形未知形状判为 `error`；兼容的 `parseBatchSearch` 仍永不抛错并在错误时返回 `[]`。扩展与 CDP 两车道均先判挑战再把 parser error 映射为结构化 `error`，不暴露 options。
- **FlyAI malformed 响应闸（issue #352）**：`gotry_flyai_search` 对精确空 `data.itemList: []` 保持业务 `miss`；机/火/酒店非空列表的每一项都必须通过 typed 条目解析，任一 malformed sibling 即返回 `via=flyai-error` 的整体结构化 `error` 并丢弃有效 sibling，从而不进入事实侧的负库存分支；仅完整合法列表可 `hit`。`flyai-tests.ts` 以隔离假 CLI 覆盖 production effect、事实侧车、空列表、完整命中、三类混合、typed 字段、退出失败与 429；这只是本地离线工程证据，不构成真实 provider/UAT 或 issue closure。
- **离线 sf evidence 汇总（issue #335， Tracks #272）**：`sf-summary.ts --evidence-root <临时根>` 先按 producer canonical evidence filename 盘点批次，再以批次采集时间选最新候选；保留每条记录的 requested/effective/fallback、per-record capture/start 与 manifest/batch provenance，旧无批次记录标为 unknown/ineligible，缺失或损坏的最新批次 fail-closed。该确定性 fixture 证据不代表实时登录态、库存、当前接口 shape 或 packaged connected/degraded calibration。
- **记忆类**：动机、愿望池（入池/召回）、旅行时间线、同行人
- **产物类**：产物 list/read（账本工单交付 + 会话工作目录 md，只读）——**#285 切片（2026-09-10）**：Host 持久化 `presentationMeta`；公开 `./client` adapter 通过 `window.__ModuleLoader__.load` 注册两个自定义 wire name 的 `tool.call.toolview` keyed cards，从 runtime `block` 渲染可点击路径、行号预览、source identity 与 content version，workspace/sidebar 仍是额外文件预览面。读范围白名单 = stateRoot 根 + 会话 dsh 工作目录（排除 node_modules/.git），扩展名白名单 = 文本类（md/txt/json/jsonl/csv/log/yaml/yml）；跨 root / 符号链接越界 / 缺失文件 / 超大文件（>2MB）统一返回 ok:false + error + hint。本层只读，WriteGate 红线不涉及。验收证据 = `scripts/artifacts-capability-tests.ts` 12 项隔离 fixture proof + `scripts/dsh-artifact-web-e2e.ts` fresh-profile Web list→select/open→read→edit→updated-read proof + smoke §15/§15b。
- **账号类**：会话登录 `gotry_session_login`（在用户 Chrome 弹登录入口，票据 cookie 名零值过手）
- **回合类**：`gotry_turn_handoff_list` 后台深度规划工单复访查询（只读；open=后台规划中/ETA，settled=交付物摘录，failed=诚实失败说明；收集结算由 `scripts/turn-handoff-collect.ts` 驱动，ADR-24 v2）
- **Booking planner 只读约束（#282）**：嵌入式 planner 保留所有非空 occupancy 房间与儿童年龄条件；缺 `adults` 继续走 schema 校验和同 session 纠偏，不做语义删除。每次 provider run（含纠偏提示）计入最多三次预算，有效纠正结果沿同一 authority path 返回，provider failure 不静默吞掉。证据限于注入 `runPort` 的离线工程 proof，不替代真实供应商库存/UAT 或 M5 gate。
- **Booking Copilot planner 共享源派生（#263，2026-09-09）**：planner prompt 与 persona 自 `booking.surface` canonical schema 派生而非手维护副本。具体落地：① `ts/src/time-anchor.ts` 导出 `formatUtcOffsetLabel(utcOffsetMinutes)`，固定 `UTC±HH:MM` 零填充双冒号格式（persona 与 dispatcher 共用 `buildTimeAnchor`）；planner 时间锚点卡锚在 host-local 时间，仅作相对日期解析用，明确告知模型不当作旅行者/用户时区。② `ts/src/booking-surface/validation.ts` 导出 canonical schema 字节（`bookingSurfaceSchema`）；planner persona 的 `SearchCriteriaPatch` 字段名列表自 `bookingSurfaceSchema.$defs.SearchCriteriaPatch.properties` 派生——不再维护第二份。③ persona 示例 patch 是 typed `SearchCriteriaPatch` 常量 + `JSON.stringify` 渲染（编译期合同对齐），示例内带 shape-only occupancy 块（`rooms: [{ adults: 2, childAges: [] }]`），模型不得复制字面占位值。④ numeric-key 数组（`{"0": {...}, "1": {}}`）在 must-be-array 修复步被识别、按数字键排序、空对象项丢弃，转为有序值数组；`actionValueAt`/`actionAssignAt` 升级为数组索引感知，嵌套修复（`rooms/0/childAges`）走新生成的数组而非覆盖。⑤ planner LLM 跟随 `DEEPSEEK_MODEL`/`LLM_MODEL` 不再硬编 `glm-4.6`；MiniMax-M2 nested decision envelopes 自动解包；parsed tool arguments 容忍，envelope miss 仅记日志；planner persona 钉死 decision-envelope 示例，decision kind 钉到 `task.allowedActions`；planner token budget 上调适配推理模型。仅声明注入 runPort 的工程 proof，真实库存/UAT 仍属 D-29。
- **gotry-backend 发布构建脚本（#367，2026-09-10）**：`scripts/build-booking-copilot-release.mjs`（与 `scripts/build-gotry-backend-release.mjs` 配套）将 kernel + booking-copilot + session-search 模块打包为 `bin/gotry-backend.js` 消费的发布制品。发布脚本仅在 typed 合同 proof（`ts/scripts/kernel-tests.ts` 8/8）与 booking-copilot server proof（`ts/scripts/booking-copilot-runtime-proof-tests.ts`）全绿后执行；kernel 的模块精确路由表是分发的唯一权威。**非代码行为变更**——同一组 HTTP 端点继续挂 `GOTRY_BACKEND_PORT > GOTRY_BOOKING_COPILOT_PORT > 3082`；本条仅为制品路径可追溯到发布时脚本而非临时拼装。
- **执行环境锁定浏览器客户端（#380，2026-09-11，founder 口径「服务端零 Chrome」）**：`ts/capabilities/session/extension-bridge.ts` 抽出传输无关的 `createBridgeJobQueue`；`handleMountedRequest` 挂载 gotry-backend `/v1/session/bridge/{health,status,jobs,results}` 鉴权面（results 走 query 适配器精确路由内核）。`ts/capabilities/session-search.ts` 引入 `multiCollect` 给 dida 推荐流车道——`hotels` + `recommendPrices` 双齐即结算（扩展侧分桶 + Node 侧 `mergeDidaRatesBodies`）。`ts/src/backend/modules/session-search.ts` 移除 CDP/transport 依赖、仅暴露桥端点；`login/open` 让扩展把 dida 登录页置前台。founder 拍板「hide all config from employees; portal dispatches join ticket」将 hotelbyte 产品的 `join ticket` 派单迁出 CLI 面——员工侧不暴露任何配置，仅 join 流程。`extension/background.js` 与 `extension/content-bridge.js` 接入 remote bridge（chrome.storage + optional_host_permissions + options 页）；dida `multiCollect` 是推荐流的契约接线。§38 扩展合同测试 36/36。版本 bump：`package.json` `0.0.1-rc.22 → 0.0.1-rc.24`、`extension/manifest.json` 跟随（详见 `docs/release-notes.md` v0.0.1-rc.23 / v0.0.1-rc.24）。
- **Booking planner factRef alias 碰撞防护（#212，2026-09-08）**：`dsh-planner.ts` 的 `repairPlannerFactRefs` 现保留字面安全的 factRef 字符串，将不在运行时 ref 字符集（`[A-Za-z0-9:._-]`）的 unsafe 引用走保留 `modelref:` 命名空间，按原 UTF-8 值的完整 SHA-256 索引；`fact_anchor_unknown` 不变量仍对碰撞触发。`recoverFinalResponseDecision` 路径在 `assertPlannerSafeRefs` 之前重新走 `validateBookingReadAction`，把"单一 alias 碰撞绕过 safe-ref gate + validator"的双层缝隙堵上。`booking-copilot-dsh-planner-proof-tests` 与 `booking-copilot-runtime-proof-tests` 各增 7+/6+ 断言。
- **Booking planner schema 拒绝反馈环 + occupancy 修复（#278，2026-09-09）**：模型返回非法工具调用时，planner 重试把具体 schema 拒绝回放进同一 session，让模型自修形状（而不是把 IDENTICAL prompt 盲重试，导致 MiniMax-M3 反复返回同一非法输出）。无 `adults` 的 occupancy 项直接丢弃（仅形态层面：发明项不是用户陈述的条件）。空决策重试推模型走显式 tool call。本切片是 #282 的前置——#282 在 #278 反馈环之上加 at-most-three-budget gate。
- **Booking-executor 观察面（#377，2026-09-10，M1 第 1 切片）**：`ts/src/backend/modules/booking-executor.ts` 仅暴露 `POST /v1/booking/observe`——CDP 打开供应商页面，读取预订入口按钮文本，截图存证。模块刻意不包含 fill/submit 原语——那些属于后续 M5 WriteGate 红线之后的受控执行器。鉴权 fail-closed（`GOTRY_BACKEND_BOOKING_API_KEY`）；域外 `entryUrl` 拒绝。观察器完全可注入，`ts/scripts/booking-executor-tests.ts` 5 个隔离离线合同测试覆盖该面，不触真供应商页面。本切片仅 M1 只读观察，不改变 `gotry web` 用户的产品行为；它铺的是 M5 WriteGate / `approval_claims` / `write_effect_intents` 的审计底座。
- **Dida 供应商门户适配器 v2（#372，2026-09-10）**：D-13 首次真会话校准触发——`ts/capabilities/session/adapters/dida-portal.ts` 现识别 `HotelRecommendAPI/SearchHomepageRecommendHotels`（60 家）与 `SearchHomepageRecommendPrices`（前 6 家起价），外加 `PopularDestinationAPI/SearchHotels`（24 家）+ `SearchHotelPrices`（8 价）；UAT 实测发现页面加载态自发的是推荐流而非 7 月口径的 `HotelPriceAPI/SearchRealTime`。`parseDidaRecommendHotels`/`parseDidaPrices` 兼容 `HotelId` 与 `HotelID` 双键；`SessionDidaRateOption` 携带 `priceDate`。CDP 车道走窗口式多响应收集（按接口分批收 body，窗口末合并解析）；扩展车道维持单响应限制（多嗅探仍需商店提审）。`extension/content-main.js` 嗅探面同步扩充。extension-tests 34/34 + session-tests 200 pass（2 fail = FlyAI 429 环境性）。真实库存/UAT 仍属 D-29。
- **自检类**：`gotry_doctor` 默认只读体检；显式 `action=repair` 时按稳定 item id 选择可自动修复项、请求会话内 scope 审批、复用 bootstrap 幂等安装器并实际复检；CLI 侧同源命令 `npx @danceiny/gotry doctor`，报告落 `gotry-state/doctor-report.md`
  - 覆盖：扩展 / agent-reach `.venv` / hbcli / FlyAI key（含最近匿名试用达限时间）/ dsh-calendar 挂载态 / sidebar / 随包 MIT `dsh-map-tools`（`SettingsProvider.prototype.installSection` 接线，0.1.2-alpha.3 与 0.1.5-alpha.1 均已发布） / `dsh-tool-ask-user`，逐项分级 ok/degraded/missing + 精确补装指引
  - 安装只经三条显式授权入口触发：`npx @danceiny/gotry doctor --fix`、交互式 `gotry web` 启动前的 per-launch onboarding prompt（#258/#267），或 `gotry_doctor action=repair` 的原生审批卡（#284）；三者复用同一套幂等安装器。浏览器商店安装、凭证/API key、profile 配置、包重装与 Node 升级保持用户操作；无审批通道/拒绝/取消均零执行。LLM key 归 dsh 宿主，刻意不管
  - 工具层 not-installed/needs-setup 报错统一指 doctor（2026-09-02 迪拜 session 复盘：阻断对已坏通道的盲目重试）
- **运维面**：质量指标只读聚合 `ts/scripts/build-metrics-report.ts`（2026-09-05，#138 第一切片）——事实闸 verdict 分布与 blocked 率/通道健康 down·cooldown（30 天窗）/事故面（7 天窗；fatal 由 `uncaughtExceptionMonitor` 观测并保留宿主退出语义）/桥延迟 p50·p95·max（**>500ms 超限计数=§11 复审节奏触发锚点的可见面**）/账本与 doctor 报告存在性，聚成单一 markdown；全程只读零 SQLite 打开（`openDb` 建连即可能写 kv），默认 stdout、`--out` 才落盘；工程面交付，不构成 M3 Exit 证据（归 #22）
- **外驱面**：通道探针 tick `ts/scripts/channel-probe.ts`（2026-09-07，外部事件接缝第 1 段，#82 本地生产者）——只读探测无头可探通道（hbcli whoami / open-meteo / opensky；session 系不可探显式 skip，flyai 默认不探防空额度），异常写 `down` 事件、恢复写 `'ok'` 事件（latest-wins 超越 down）进 `channel-health.jsonl`，routing/doctor 零改动受益；loopx/cron 驱动一次一轮，非常驻；第 2 段愿望池消费同日落地（`conditions.channels` 可选条件+召回时 down 否证，`wish-channel-gate-tests` §53）；远程回调面仍待 D-31 拍板（seam 设计 §5）
- **外联**：AgentReach wrapper（上游装于 `.venv`，反射桥 `agent-reach-bridge.py` 直调上游注册表，零渠道知识）

**工具面无预设静态路由优先级**（persona （19） 平铺保持）；通道顺位由**通道注册表**生成、健康态过滤（D-8）：

- `ts/capabilities/channel-registry.ts` 是单一数据来源（意图×通道×配额类×证据级）；persona 路由卡（`{{channel_routing_card}}`）与检索结果内 `routing` 建议（verdict≠hit 时）同源生成。
- 建议不是派发，解译器不做隐藏改道；会话健康面（`channel-health.ts`）记 down/cooldown，`hit` 即清除。
- 证据链逐源标注不变。

数据接入：机票三层（骨架 168 对 + 校验桥 + 锚点）、酒店 hbcli 桥（实时/静态降级 + 证据标注）、OpenSky 实时 ADS-B、Open-Meteo 天气、飞猪 FlyAI 官方只读通道。

### 1.3 账号会话与授权闸

- **授权闸**：`tools/pre-execute` 监听器（`session-consent.ts`）在**每会话每站点首次调用**时经 dsh 原生 ApprovalService 请求授权。allowed-once 记入会话 granted 集，会话内后续调用免弹；**用户拒绝 = 本会话吊销**，不再弹卡也不再执行。无审批通道 / headless 一律 **fail-closed 拒绝**。
- **子代理与 jobs id 边界（#194 A-轨道）**：GoTry 在 `job_output`/`job_kill` 进入 dsh jobs registry 前，经 typed `tools/pre-execute` 读取当前 caller 的 direct-child listing；命中 continuable durable id 时返回宿主同形状的可恢复错误，指向 completion notice、`list_agents` 与 `send_message`（停止当前 turn 用 `interrupt_agent`）。未命中、one-shot 或非 owner 仍交回 dsh 原生 jobs ownership/错误；benchmark minimal kernel 不安装此产品 guard。上游 dsh 的 unknown-id 根契约仍由 [#194](https://github.com/Danceiny/gotry/issues/194) 跟踪。
- **site 绑定（2026-09-10，#308 forward fix）**：同一工具多个 kind（`gotry_session_search` → flight / hotel / dida / train）与 execute 共用 `interpretArgs` 的 query-first 选择，缺省 kind 保持 flight 默认；授权与拒绝均按 site 分桶，未知/malformed kind 失败关闭（deny，不扩权）。12306 仍是公开查询面，但 train 同样经过 `sessionAccess: off|ask|allow` 与每站点拒绝/取消语义，不绕过授权闸。实证回归在 session-tests §I + smoke §13。
- **开关**：插件 config `sessionAccess: ask|allow|off`（随时可关 / 明示预授权 / 总闸关闭）——RFC 支柱④「用户明示授权 + 站点白名单 + 随时可关」进代码。
- **登录**：`capabilities/session-login.ts` 在用户 Chrome 弹登录入口，登录**永远在外部网站完成**；登录引导页不挂 ReadGuard 是唯一豁免面（检索面不变量不变）。
- **只读不变量**：ReadGuard 方法×URL 双因子写拦截 + 审计 + fail-closed；节律闸；证据链 `[会话:*]`。

### 1.4 事实性与状态基座

- **#299/#355 机票/车次 claim 分流与 12306 typed rail facts（2026-09-10，D-26/#273 残余）**：`extractClaims` 将 G/D/C/Z + 3–4 位车次收进独立 `trains`，完整 token 判定不误删合法双字母航司（含 `CZ8582`/`9C8781`）；`flightClaimVerdict` 只看 `kind:'flight'`，`railClaimVerdict` 只看 `kind:'train'` exact-date/route/code/bookable 事实，缺证据输出 `rail_claim_unverified`。FlyAI 与 12306 session 均沿真实注册工具→typed fact log→canonical anchor/`gotry_fact_gate`；12306 parser 区分 recognized nonempty/recognized empty/malformed/transport-runtime error，正事实以 host-captured invocation route/date 与精确 response URL binding 为准，行内 startTrainDate 仅校验并保留、`captured_at_non_future_and_max_age_15m`、`canWebBuy=Y` 与闭集可用座位 token。列表无票价，不新增 RailFact 渲染器或 static-schedule 降级。证据仍限确定性 adapter/fixture，不宣称实时 12306 或 M4/M5/M6 gate。

- **可下单事实单一数据源**（ADR-19）：`ts/src/bookable-facts.ts`（`gotry_bookable_fact.v1`，纯函数）——flyai/session exact-date 工具结果逐条落账，hit 正事实 / miss 负事实，query_id 可重放，IATA 归一；四层证据 tier **永不合并**。**exact-date miss =「未确认/当前不可售，到 D-xx 复核」**，禁止用历史班期/相邻日期/航线页回填。
- **产物事实闸 `gotry_artifact_gate.v1`**（`ts/src/artifact-gate.ts`）：三渲染原语（`renderFlightFact`/`renderHotelFact`/`renderPolicyFact`）行尾内嵌 `<!-- fact:<fact_id> -->` 锚点——产物经渲染原语生成即自带溯源锚，闸侧锚点确定性回溯（启发式让位）；手改锚点（未知 fact_id）或手改锚点行内容（政策行 as_of 与事实不符） = `fact_anchor_unknown` 直接违例。手写/历史产物走启发式回退：航班号/承运直飞/酒店可住/政策关键词/航司机场映射五类 claim + `policy_without_as_of` 时间边界。闸 blocked 不得宣称「已验证方案」（`presentation=verified_label_forbidden`）。
- **政策锚点全字段内容指纹（issue [#359](https://github.com/Danceiny/gotry/issues/359)，父 #273，D-26 残余收口）**：渲染与闸共用单一权威构造器；**当政策行含有 `<!-- fact:` 锚点时**，必须严格等于 canonical 整行 + 单一 `<!-- fact:<id> -->`（subject/statement/source/fetched_at/query_id/as_of），任一改动 → `fact_anchor_unknown`，与未知锚点同源；多锚点、格式异常锚点、非 canonical 前/后置非空文本，或「借合法锚点写相反政策」的借用形态均 fail-closed。**不含** `<!-- fact:` 的手写/历史政策行仍走既有 unanchored/free-text 启发式回退，不在本切片范围（交父 #273 / D-26）。`opts.itinerary.trip_start` 桥接到 `opts.tripStart`，与 `review_by` 同为合法复核提醒形态。**兼容性回退（legacy public callers）**：当调用面未传 `opts.tripStart` 且 itinerary 也无 `trip_start` 时，闸侧接受 renderer 产出的两个固定 canonical 形态 ——（a） 严格等于 `renderPolicyFact(f)` 的 no-reminder 行；（b） 携带 renderer 固定短语 `;远期政策须复核——到 YYYY-MM-DD 再核验一次` 的行，日期须为真实 ISO 阳历日，闸侧抽日期重建 `renderPolicyFact({...f, review_by: date})` 与原行 byte-for-byte 比对，不再手动拆 body/provenance；若事实自带 `review_by`，renderer 唯一合法 reminder 日期就是 `f.review_by`，与抽出日期不一致时 fail-closed。即使 trip 上下文已知，`renderPolicyFact(f)` no-reminder canonical 形态仍合法。body/provenance/锚点结构/位置由 renderer 重建后比对，绑定 subject/statement/as_of/source/fetched_at/query_id/reminder 位置短语/精确锚点。残余：反向抽取仍为正则启发式；价格容忍度、汇率/多币种与 M5 WriteGate 按既有债务复审。
- **航班/酒店锚点字段指纹（issue [#363](https://github.com/Danceiny/gotry/issues/363)，父 #273，D-26 残余收口）**：渲染原语（`renderFlightFact`/`renderHotelFact`）与闸共用同一权威事实，启发式对**航班行从渲染文本重新抽取 flight_no token** 严格 == `fact.flight_no`（大写归一），**酒店行严格包含** `fact.destination` + `fact.check_in` + `fact.check_out`（精确子串）；任一不等 → `fact_anchor_unknown` fail-closed，与未知锚点同源。**字段指纹不替代整行严格比对**（根 contract 第 2 条）：flight_no/承运/时刻/route/价格的可比性、列车 canonical、政策 canonical、§4b 价格兼容形态（总预算/行李费/总计/显式票价/千分位/价待询/¥7xx/约价）、`price_contradicted` 与 `unverified_price_claim` 分类与排序均不被新指纹吞并，沿用既有判定原语。**借用/未知/重复锚点**仍由既有 `fact_anchor_unknown` 路径负责，字段指纹只补齐「保留 anchor/registry/fact_id 改写可见 flight_no/目的地/档期」的根反例 fail-closed。`gotry_fact_gate` 注册闸执行面无新增路径，沿用既有 `loadFactRegistry` + `gateArtifact`。残余：反向抽取仍为正则启发式；价格容忍度、汇率/多币种与 M5 WriteGate 按既有债务复审；父 #273 残余债务保留。
- **事实闸价格边界（issue [#300](https://github.com/Danceiny/gotry/issues/300)，父 [#273](https://github.com/Danceiny/gotry/issues/273)）**：flight/train exact-date 可下单行仅在 canonical fare 字段或明确票价标签字段内，对照该航班/车次自身事实的完整可比较 CNY 硬价；分隔后的带非票价文字标签金额不参与，裸/未归属或畸形 fare money 则 `unverified_price_claim` blocked。数值不一致 = `price_contradicted` blocked；源事实缺价、不支持的硬币种、或无锚点且价格超出启发式 120 字窗口 = `unverified_price_claim` blocked；模糊/非数字不比较，不猜换算，酒店 `priceRaw` 不参与。价格容忍度、汇率和多币种策略仍待 owner/founder 决策。
- **事实闸 read-side 有限词集（issues [#301](https://github.com/Danceiny/gotry/issues/301)/[#302](https://github.com/Danceiny/gotry/issues/302)，父 #273）**：手写/历史产物启发式对 lodging heading（`## 住宿` 等）下无住宿类 token 的可住断言也升为 hotel claim，与五类非关键词住宿 category（度假村/青旅/青年旅舍/别墅/公寓；精品酒店沿用现有 酒店 token）合并触发 `unverifiable_hotel_claim`；政策行命中 13 词有限并集（EVUS/ETA/eVisa/疫苗/疫苗接种/健康申报/隔离/工作签/居留/返程签/护照有效期/黄皮书/保险）且缺 as_of → `policy_without_as_of`。Latin token 大小写不敏感但不嵌入更长 Latin 词。确定性 fixture 覆盖，不宣称实时政策正确性、供应商就绪或 M5/M6 准入。
- **状态权威 = 单文件 SQLite 账本**（ADR-15，`ts/src/state-ledger.ts`）：events append-only + 投影 fold 可重建 + 红线进事务 + 工单 durable 恢复（exactly-once）+ pending_writes saga。旧 JSON/JSONL 降级为单向导出视图。`state-cli` 操作面集中严格解析 cmd/positional/`--state-root`/`--tenant`/`--limit`，未知/重复/缺值/非法 numeric（含 `.5`/`+.5`）在触碰账本前 fail-closed；`--tenant` 只是 scope，不是认证授权。
- **双形态冻结**（ADR-16）：本地 + Web 一套账本语义，`tenant_id` 一等字段；`insertEvent` 写入当前 ledger owner，`readEvents`/投影 fold/rebuild 均先按 tenant 过滤，跨租户同 id/idem_key 不覆盖；同步 = 事件复制而非状态翻译。历史 v1/JSON 只可安全归入默认 `local`，已经错误写成 `local` 的非 local 事件无可靠反推租户，不得由迁移脚本猜修。
- **预订 saga 词汇层**（ADR-17，`ts/src/booking-saga.ts`）：状态字母表与 pending_writes CHECK 逐字一致。
- **WriteGate 机制层**（write_gate.v1，`ts/src/write-gate.ts`，issue [#231](https://github.com/Danceiny/gotry/issues/231)，2026-09-11）：持久化可信审批 + 原子 outbox 以**离线机制/契约层落地——非运行时激活**：不存在任何真实供应商/交易调用，产品运行时在 M5 Entry 前不实例化 `WriteGate`（表结构由 `ensureWriteGate` 惰性创建；账本 SCHEMA、工具注册面与默认路径零变化）。形态：`PreparedChallenge`（nonce/fingerprint/披露由服务端在呈现前冻结；账本只存摘要，原始 nonce 只经可信宿主呈现通道交付）、`ApprovalReceipt`/`ApprovalClaim`（只经可信宿主真人确认回调发行；一次性消费走 `consumed_at IS NULL` 条件 UPDATE）、`WriteEffectIntent` durable outbox（事务 1 = claim 一次性消费 + pending_writes pending→confirmed + outbox 入队单事务原子；事务 2 = queued→dispatching 原子领取，不可变 `attempt_id`/`fencing_token` 先于任何外部调用落库；模型只能请求展示——模型发起的确认一律拒绝且零 outbox）。存储层等价不可绕过约束（D-22 锚点的 outbox 侧面）：复合外键 `(tenant_id, receipt_id) → approval_claims`、receipt 非空 CHECK、dispatching/dispatched 必携领取字段 CHECK、`dispatch_status` 只进不退触发器（dispatching/dispatched/rejected 永不回 queued）、`attempt_id` 落库即不可变触发器。L4 撤回在发行/消费/派发三点阻断；派发前复验失败置 `rejected`（零供应商写，永不回队）。否证套件：run-all §60（事务 1 三崩溃点注入、双进程领取竞争、重放/过期/跨租户反例、裸 SQL 物理红线）。
- **异步终态合同**：`gotry_async_terminal.v1` 将 4/4 映射为 `succeeded`/ledger `settled`/exit 0，非 4/4 映射为 `failed`/ledger `failed`/exit 2；终态复诵返回同一结构化结果与退出码且零重算。
- **Booking Copilot 生命周期投影**（单一 `booking.surface` 契约；2026-09-05 #133 收敛：原 v2 形态转正、v1 退役，双协议时代结束）：`planning → submitted → working → waiting_receipt → input_required → terminal outcome`；公开类型保留七个 phase 字面值（终态分 `terminal`/`error`）。availability reducer 另有 `need_offers → waiting_offers → need_check → waiting_check → terminal` typed 子状态，不改变外层六状态投影。identity binding 与 approval 细节见 §8.23。

### 1.5 记忆域与时间感知

- **记忆域六层**（设计见 `design/memory-design.md`）：动机 brief 读回 persona、效用 sidecar（归因只认 owner 确认）、愿望池 0..1 召回（`gotry_wish_pool_list`）、旅行时间线（`gotry_trip_log`）、同行人档案（`gotry_companion_save`）、时间窗衰减（只降不删/地板 0.1/动机零衰减）。度量与触达：`scripts/memory-metrics.ts` 只读投影 + `scripts/nudge-digest.ts` 主动回访（`GOTRY_NUDGE_ENABLED=false` 可全局关闭）。M4 planning lifecycle 观测另有显式 opt-in CLI `ts/scripts/memory-lifecycle.ts` + 纯逻辑 `ts/src/memory-lifecycle.ts`：只写隔离 `stateRoot`，consent/HMAC 必需，导出 candidate/synthetic scorer 输入，不接真实会话。
- **持久常驻城市/默认出发地（Issue #338）**：写入 patch 接受 `homeCity` 与 optional `homeCityEvidence`（单条非空 evidence 可省略，多条须显式 exact 绑定）；投影保存 `homeCityPreference { value, evidence, updated_at }`。`{{motivation_brief}}` 只将完整 typed preference 读回为软默认，当轮显式出发地优先；typed 缺失/畸形或 evidence 不在 pool 时只要求澄清。默认不 hard-filter 或改变确定性 candidates/recommendation，`resolveDefaultOrigin` 仅是纯 precedence contract。
- **时间感知**：确定性锚点层 `ts/src/time-anchor.ts` + 槽位抽取 `travel-slots.ts` + 槽位→日期解析 `slot-spec.ts`。**算术进代码，LLM 查卡不自算**。命名年份的未来规划在 `loop.ts` 的求解入口按本轮锚点过滤候选：当前年从参考日到年末，未来年为全年；过期年份明确拒绝，历史/回测意图旁路，不把参考日持久化到 `TripState`。

### 1.6 工程不变量

- 工具 execute 统一经 `guardToolExecute` 异常隔离 + 平铺观察 envelope（ADR-13）。
- **turn 预算 = 路由 + wall-clock 双出口**（ADR-24 v2）：每轮终结于「当面答完 / 转后台承诺 / 收敛作答」三态之一，不允许流死掉。确定性分类器（`ts/src/turn-policy.ts`，零 LLM）分 quick/sync/deep；越硬阈同步抑制工具 schema（`ts/src/turn-deadline.ts`）；deep 出口落 `gotry_turn_handoff.v1` 工单并告知 ETA，收集闭环由 `scripts/turn-handoff-collect.ts` 兑现。设计与验证细节见 §8.24。
- 外部依赖走**效应描述 + 解译器**（ADR-18）：工具层只产纯数据效应值 `{effect, params}`，渠道访问/退避重试/断路器/编译期 mock 收敛到 `ts/capabilities/effect.ts` 与 `resilience.ts`。
- **HotelByte embedded Booking Copilot 是只读协作面，不是 M5 写闸启封**：单一 `booking.surface` 契约（2026-09-05 #133 收敛，v1 退役），生产 standalone 默认 `bff-bound-turn-only`，浏览器 `user.turn.ingress` 只在完整 authenticated principal/scope + BFF trusted binding 下开放；must blocker 只能由绑定 task/context/receipt/presentation key 的一次性 approval 放行。离页自动写/支付已有 M5 WriteGate proposal（`design/write-gate-production-design.md`），但 M4 Exit+供应链协议未满足前零交易实现；四 surface 真实库存验收未过前不得宣称产品验收（D-29）。全文见 §8.23。
- **Booking dispatch diagnostics （#329）**：同步 HTTP 409 turn-dispatch rejection 只记录现有 typed `code` 与 exact closed `reason`；带 suffix 或未知错误统一为 `UNCLASSIFIED`。证明为隔离子进程的离线 HTTP/stderr 字节测试，不构成 provider reliability、HotelByte UAT 或 M3/M4/M5/M6 准入。
- py 树仅剩 `gotry_feasibility` oracle，产品运行时零 Python 依赖（D-7 清偿）。
- **外部 benchmark bridge 一律 default-off**（Phase 1 seam）：owner-local config、固定 argv/allowlist、递归 no-oracle 键拒绝、cold-start + headless one-shot、native definition-only agent、启动组合隔离、结构化终态诊断——任一合同漂移 fail-closed。单一 flat `action=tools|call|errors` 协议由 descriptor 同源生成每工具精确 call schema，并在 spawn 前复用同一 validator；adapter 输出只接受 exact result/domain/failure envelope，旧终态不得遮蔽更新的 bridge 事实。逐轮 frozen treatment 事实见 §9，合同全文见 `evaluation/benchmark-environment-bridge.md`。
- **Z3 生命周期边界（#227）**：`ts/src/z3-shared.ts` 是唯一运行时入口：冷初始化 Promise 先缓存（并发只建一个 Context）、会话级互斥 `withZ3`、low-level native cleanup 局部队列（只包装当前 `z3-solver@5.2.0` 的 `dec_ref`/`*_dec_ref` 与 async native call，不改全局 `FinalizationRegistry`，不提前 free 仍可达对象）。GC/explicit release 的 cleanup 若撞上活跃 native check，延迟到 actual native idle 后 drain；fatal WASM/heap 错误先 poison，后续求解 fail-closed。回归锚点：run-all §30/§30b/§30c。
- **Node 构建支持面（#265）**：下界保持 `>=22.15.0`；dist 只用根 `devDependencies` 精确锁定的 TypeScript 5.9.3 转译为 ESM，不依赖全局包、`ts/node_modules`、hoist 或 Python，发布运行时不携带 TypeScript。CI 在 Node 22/24 跑 typecheck + 全栈回归，在 Node 22/24/26 跑 exact 文件集合/ESM/动态 import focused proof。该项只属 M4 开源/发布质量线，不计入 #20 的真实 repeat-cohort，也不满足 #136 供应协议/内部授权或 #137 P6 批准与真实试点；三项 gate 保持 open。

### 1.7 里程碑口径（Issue #19）

M3 工程与分发面已就绪，**但真实种子用户 evidence 未收口，M3 Exit 仍开放**。M4 由 founder 授权并行推进，Issue #20/#223/#238 scorer 已在 main 落地并加严，#228/#248 显式 opt-in planning lifecycle collector 也已在 main，但 collector 只产生隔离 candidate/synthetic 导出，不得替代真实 `observed_private` N≥5 repeat cohort + source-review attestation；issue #225 把 M4→M6 拆成 living 任务图，并记录 ledger/state-cli/Z3/map 基础修复已在 main（#229/#237/#243/#244/#245）。M5 首供应链已选 `hotelbyte-cli`（仅只读调查与契约准备，不代表供应链协议已签）。**这些计划/设计/candidate 导出不构成 M3/M4/M5/M6 Exit 证明**。准入前仅可推进 #136/#137 明确授权的设计、只读调查、fixture 与 failing-before；交易运行时、供应商写入和真实 B2B 路径仅在各自 Entry gate 满足后启动。

证据面现状：`ts/scripts/product-metrics.ts`（M3 cohort）与 `ts/scripts/memory-value-report.ts`（M4 价值）固化了样本窗/纳排/分母/归因与阈值，输入只接受 HMAC-SHA256 假名键且未知字段 fail-closed；synthetic fixture **永不产生 business pass**。`ts/scripts/memory-lifecycle.ts` 只把显式 consent/stateRoot/HMAC 下的首访/回访 lifecycle 事件导出为 #223 scorer 输入，并保持 candidate/synthetic source_review，绝不制造 manual attestation。M4 observed-private 另需 `memory_value_source_review.v1` 人工 source-review attestation 合同，并以 `reviewed_summary_digest_sha256` 绑定本次评分 payload；缺少或 digest 不匹配时只可作为 candidate，不得把 `evidence_kind` 或 HMAC 字符串形状当 provenance。真实证据只进入被忽略的 `ts/gotry-state/evidence/`。

评测边界：Phase 0 只有契约/注册表/校验器与确定性节奏策略（不调度、不花费、不出分、不声称 uplift）；Phase 1 bridge 逐轮 frozen treatment 均为 diagnostic-only、official scores null（见 §9 与 D-28）。契约全文见 `evaluation/evaluation-foundation.md`。

## 2. 总体架构：五层与现状

```
L1 交互:对话即界面(gates 以消息内选择题呈现;独立 UI 属 Stage 1 后)
L2 编排:对话循环 ts/src/loop.ts —— LlmPort(mock✅/真✅ provider-neutral) + 确定性访谈 + 求解挂载
    └ dsh 插件 gotry-tools:✅ 已在真实 dsh headless 运行时端到端(68ea364 rc.1 起实证;2026-08-29 曾用 vendored `0.1.2-alpha.1`;Round 5 起 source/package 共用 root-pinned `0.1.2-alpha.3`;2026-09-09 #268 迁移到 230 包精确 `0.1.5-alpha.1`;2026-09-11 升级到 232 包精确 `0.1.5-rc.1`)——模型经 pi-ai(MiniMax-M2)主动调用 gotry_feasibility_check 并引用引擎数字;组合见 cordis.gotry-patch.yml(bin/gotry-inner.js 运行时生成;ts/ 下旧副本已退役 2026-08-28)
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

| 文件 | 角色 | 状态 |
|---|---|---|
| `ts/src/contracts.ts` | 顶层数据与工具契约（TripState/五工具 IO/wire schema） | 草案，待创始人走查 |
| `ts/src/loop.ts` | 对话循环：runTurn/interviewNext/异步深度规划（request/collect+不失望四条） | ✅ 重放验证 |
| `ts/src/mock-llm.ts` | 剧本 LLM（ADR-8）：确定性重放真实对话的智能侧 | ✅（S4 后留作回归夹具） |
| `ts/src/unified.ts` | **统一行程模型 TS 版（唯一求解入口）**：Segment/Option/时区/工作窗口+Z3 求解（航班链）+枚举求解（候选形态） | ✅ 4/4+候选对账 |
| `ts/src/model.ts` | 门到门全成本算术（纯函数，单候选形态） | ✅ |
| `ts/src/engine.ts` `journey.ts` | 旧两套求解面（纯 oracle，金标准对照） | **deprecated** |
| `ts/src/index.ts` `bridge.ts` | dsh 插件（纯 TS unified 求解 + hbcli 桥 + 进程护栏，延迟计量） | ✅ smoke |
| `ts/src/turn-policy.ts` `turn-deadline.ts` | Agent 每轮「路由 + wall-clock 双出口」：确定性分类（quick/sync/deep，零 LLM）→ TurnPolicy；越硬阈同步抑制 schema，converge=EXHAUSTED / handoff=落 `gotry_turn_handoff.v1` 工单+ETA 告知；benchmark 钉固定 policy | ✅ run-all §45 |
| `py/gotry_feasibility/unified.py` | Python oracle（v0.0.1-rc.2 后**仅历史对照**，不再被产品运行时引用） | 保留 |
| `py/gotry_demo/` | **已删 2026-08-22**（D-7 尾债：demo 规划书生成器曾调废弃 journey.solve_journey；产物 docs/milestones/demo-plan-2026-07-17.md 留 git 历史） | — |
| `ts/scripts/replay.ts` `replay-async.ts` | **验收夹具**：真实对话重放（13 轮→3 轮）与异步形态 | ✅ |
| `ts/scripts/{engine,journey,unified,diff}-tests.ts` | 套件（8/5/4 断言+TS-vs-TS 同 spec 稳定性） | ✅（diff-test 顺序偶发为已知问题，v0.0.1-rc.2 后不再依赖 Python） |
| `ts/src/time-anchor.ts` | **时间锚点层**（ADR-12，纯函数）：锚点卡渲染（今天/相对周/月分段/季度/节日）+ 绝对月日解析；persona 与抽取链路的「今天」唯一来源 | ✅ time-eval §1 |
| `ts/src/travel-slots.ts` | **槽位抽取层**（travel_slot_extraction.v1）：schema + 抽取 prompt + 过期校验 + language 检测 + 评分器；逐字保留，判定归代码 | ✅ time-eval §2-4 |
| `ts/src/slot-spec.ts` | **槽位→日期解析层**（D-10 切片 A）：锚点卡词表 + 绝对表达 + 「+N」后缀 → YYYY-MM-DD；词表外 unresolved 逐字保留（ADR-12 边界：不做开放式解析）；spec 日期一致性闸 | ✅ time-eval §5 |
| `ts/src/tool-packet.ts` | **工具观察 envelope**（RFC S1/ADR-13）：GotryObservation 平封形状 + ToolFailure + interpretArgs 参数三形态归一唯一入口 | ✅ smoke §9 |
| `ts/src/memory-utility.ts` | **记忆效用 sidecar**（RFC S2/ADR-14）：recalled/applied/verified_outcome 事件 + 幂等追加 + 只读投影；归因只认 owner 确认 | ✅ smoke §10 |
| `ts/src/memory-lifecycle.ts` `ts/scripts/memory-lifecycle.ts` | **M4 planning lifecycle collector**（#228）：显式 stateRoot/consent/HMAC 才写；dataset key verifier + source/wait 冻结；首返 flow/wait/reflux/preference HMAC 假名化；JSONL+manifest write-all/原子发布/路径隔离；导出接 #223 scorer candidate/synthetic，不造 manual attestation | ✅ run-all §55 |
| `ts/src/memory-decay.ts` | **时间窗衰减原语**（memory-design P3）：30/90/180/365d 分级因子（地板 0.1）+ 种类权重 + 新鲜置信度；动机层零衰减为构造性保证 | ✅ run-all §23 |
| `ts/src/companions.ts` | **同行人档案**（memory-design P2）：upsert 合并 + 负面清单守卫（证件/电话零入库）；约束只进排序 | ✅ run-all §21 |
| `ts/src/travel-timeline.ts` | **旅行时间线**（memory-design P1）：trips.jsonl append-only + 幂等/重叠冲突即停 + verified↔timeline 交叉一致 | ✅ run-all §20 |
| `ts/src/wish-pool.ts` | **愿望池匹配纯函数**：条件评分 + 0..1 挑选（muted 排除/确定性 tie-break）；wish_pool_list 与 nudge 共用 | ✅ run-all §21 |
| `ts/capabilities/channel-registry.ts` `ts/capabilities/channel-health.ts` | **通道注册表 + 通道健康面**（design/tool-orchestration-design.md，issue #106/#107/#108/D-7/D-8/D-9）：通道×意图×配额类×证据级单一数据来源；persona 路由卡与 `routing` 建议同源生成；会话瞬态态（down/cooldown，hit 即清除）+ `channel-health.jsonl` 持久事件面；排序=lexicographic（可用性，证据级，效率），建议非派发 | ✅ run-all §50 |
| `ts/capabilities/flyai.ts` | **FlyAI 官方通道**：飞猪 8 只读工具的管道层（search-flight/train 先接），证据链 `[实时API:flyai@ts]` | ✅ run-all §24-F |
| `ts/capabilities/session-search.ts` + `session/` + `extension/` | **会话检索面**（RFC P1-P3.5）：传输=扩展桥 PRIMARY（`extension/` MV3 + `extension-bridge.ts` 回环桥，零新依赖；**capability 路由**：站点 job 只派给声明该站点的轮询者）/cdp 显式后备（ReadGuard 写请求物理拦截+审计，fail-closed）/persistent 测试；携程机票适配器（batchSearch 嗅探）/dida 供应商门户适配器（SearchRealTime 信封展平，2026-09-09）/action-cache 自愈层（变量化key+指纹被动失效+miss回写）；节律闸；`[会话:*]` 证据链 | ✅ run-all §25/§38 |
| `ts/capabilities/session/extension-distribution.ts` + `ts/scripts/extension-distribution-cli.ts` | **扩展分发通道**（ADR-21 分发 A）：GitHub Releases 下载链（稳定资产名/dist-manifest fail-closed 解析/SHA256/平台 tar 解压/key 钉扎/版本比较/原子交换），失败显式降级 bundled；CLI 单行 JSON 供 bootstrap spawn | ✅ run-all §43 |
| `ts/capabilities/artifacts.ts` | **产物面**（issue #25 最小切片）：产物发现（账本 workflow_runs 权威 + 无账本回退 async 目录视图 + dsh 工作目录顶层 md）+ 行号窗口读取（dsh read 卡）；只读，路径/扩展名白名单 | ✅ smoke §13 |
| `ts/capabilities/effect.ts` `ts/capabilities/resilience.ts` | **效应解译器 + 韧性原语**（effect_interpreter.v1，issue #16 采纳/ADR-18）：效应值注册表（渠道 handler+策略表）+生产/mock 解译器（渠道 observation 原样透传+trace 横切证据）+ 指数退避（withRetry）/断路器三态（CircuitBreaker）；23 工具外部依赖面全收敛（issue #115） | ✅ run-all §37 |
| `ts/src/state-ledger.ts` | **事务化状态账本**（ADR-15）：SQLite 单文件唯一权威（events append-only+语义幂等键/投影表 fold 可重建/workflow_steps durable 工单/pending_writes saga）；`gotry_async_terminal.v1` 固化 4/4/非 4/4 终态、退出码与零重算复诵；守门纯函数复用为写路径与 fold 处理器；读路径带旧文件回退；首写自动 one-shot 迁移+快照 | ✅ run-all §28 |
| `ts/src/booking-saga.ts` `ts/scripts/booking-saga-tests.ts` | **预订 saga 状态机词汇层**（booking_saga_fsm.v1，issue #17 采纳/ADR-17）：状态字母表+四条边全函数边表+结构化拒绝闭集+审计链校验；§36 与账本 saga 基座逐格物理对账 | ✅ run-all §36（纯函数，零写路径接线） |
| `ts/src/bookable-facts.ts` | **可下单事实模型**（gotry_bookable_fact.v1，issue #46/ADR-19，纯函数）：事实 schema（route/exact local date/航班号/营销+实际承运/机场/价格/来源/query_id/置信 tier/bookability 四态）+ flyai/session 结果转换器（hit 正事实/miss 负事实/error 不落）+ IATA 归一 + 判定原语（claim 可述性 fail-closed/同日衔接硬约束/夜数·O&D·预算不变式/迂回检测）+ 渲染原语（codeshare 双承运/落 DMK 注记/不可售措辞/联程仅 protected_connection） | ✅ run-all §39 |
| `ts/src/artifact-gate.ts` `ts/capabilities/fact-log.ts` | **产物事实闸 + 事实侧车**（issue #46/ADR-19）：markdown 可下单 claim 反向抽取（航班号/承运直飞/中文承运名/机场映射/政策「截至」语境/✓/联程断言，小节上下文继承）→ 逐条回溯注册表（not_in_source/route_unqueried/时刻矛盾/价格矛盾/联程违例等）；第 21 工具 `gotry_fact_gate`，blocked 不得宣称已验证；fact-log 落 `<stateRoot>/gotry-state/bookable-facts.jsonl` 侧车（永不阻塞检索主路径） | ✅ run-all §39 + smoke §16 |
| `data/airline-airports.json` `ts/data/golden-trip-2027-facts.json` | 航司→机场映射 + 城市→IATA 词表（gotry_airline_airports.v1，as_of 快照+review_by）：FD=DMK/VZ=BKK 冲突检测面，闸加载缺失即 fail-closed；golden fixture=issue #46 审计值锁定的 2027 行程事实集（11 查询）+ 好/坏行程不变式对 | ✅ run-all §39 |
| `ts/scripts/state-cli.ts` | **账本操作面**（ADR-15）：migrate/log/stats/rebuild/rewind/forget/pw-* 走集中 parser 后按 tenant scope 传给 StateLedger；未知/重复/缺值/非法 numeric（含 `.5`/`+.5`）fail-closed。export/tick/whatif 明确 local-only：分别会写共享 legacy 文件名、调用本地异步结算、生成整库管理员 snapshot（不是租户 export），非 local 在 mkdir/openDb/solve/write 前拒绝 | ✅ run-all §29；#241/#243 已入 main并关闭 |
| `ts/scripts/product-metrics.ts` `ts/data/product-metrics-fixture.json` + `ts/scripts/nightly-evidence.ts` `ts/data/m3-nightly-prompts.json` `ts/data/llm-price-table.json` | **M3 cohort 证据评分面 + nightly 证据生产器（Issue #22）**：阈值冻结 manifest + 脱敏 cohort/nightly schema + 定稿率/NPS/POI 幻觉率 scorer；fixture 与真实证据分流，未知字段 fail-closed；nightly 生产器封存 prompt 集与价表（peak 保守上界，未知模型 fail-closed）、无凭证 waiting/backoff/no-spend、超预算退 3，记录写入前必过消费方 parseNightlyRun | ✅ run-all §33/§35；真实 cohort 待收集，nightly 真跑记录待凭证环境执行 |
| `ts/scripts/time-eval-tests.ts` `data/time-slot-eval.json` | 时间感评测（25 题）：确定性部分进 CI，`--real` 真模型巡检（只读报告） | ✅ 真模型 25/25 |
| `data/golden_erhai.json` `flights_2026.json` `hotels_2026.json` `golden_trip_2026.json` `行程细化计划.docx` | 金标准用例/班期/住宿/完整任务/Kimi 对话原件 | — |

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

**重放验收**（`ts/scripts/replay.ts`）：Kimi 的 13 轮失败 = GoTry 3 轮；日历零反复；工作窗口与已订酒店首轮即被问出；终轮即已验证方案。

## 6. 数据与运行时

> **数据源唯一权威面 = `data-sources.md`**（2026-08-22 立）：领域矩阵 × 四层架构（静态包/免费实时/hbcli 桥/OSM 生态） × Google Place 链路（hbcli→search OpenAPI→geography） × 证据链契约 × TREK 参考采纳。本节只留运行时概要。

- 运行时：两条已实证路径——①TS 进程内（自研循环，~6ms/解）；②真实 dsh headless+cordis 组合（pi-ai→MiniMax，`cordis.gotry-patch.yml`，68ea364）。v0.0.1-rc.2 起 Python CLI 桥下线，纯 TS。环境三件套 `LLM_API_KEY/LLM_BASE_URL/LLM_MODEL`（兼容旧 DEEPSEEK_*）。
- 复用落地：dsh（import，rc 已对齐）/loopx（import，0.5.1 运行中）/Z3（import，双绑定）/hotelbyte-cli（import+extend，place 链路见 data-sources.md §4）/T 系统·ai-agent-book·TREK（reference，零代码——TREK 数据面模式采纳表见 data-sources.md §5）。

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
| 12 | 时间感分层：锚点卡（算术进代码）+ 槽位逐字保留（LLM 不换算不翻译）+ 过期/language 判定归代码层 | 见 §8.12 | **2026-08-27 复审（D-10 切片 A 触发）：设计成立**，补充边界见 §8.12 | `time-anchor.ts`；`travel-slots.ts`；`slot-spec.ts`；`time-eval-tests.ts` |
| 13 | 工具观察 envelope（RFC S1，effect-interpreter 映射）：12 工具成功路径平铺 `ok:true` + 载荷，失败 `{ok:false,summary,evidence}`（guard 兜底同形，`ToolFailure` 编译期对齐）；参数三形态归一唯一入口 `interpretArgs`（原 unwrapQuery 移居 `tool-packet.ts`） | 逐工具自由返回（形状漂移，每个新工具重新猜）/嵌套 envelope `{ok,value}`（渲染/调用方全要拆包，侵入大） | 出现第二个真实调用方（非 dsh 非 smoke）需要不同观察形状时复审 | `tool-packet.ts`；`incident-log.ts guardToolExecute`；smoke §9 |
| 14 | 记忆效用 sidecar（RFC S2/S3）：三类事件 append-only，**归因只认 owner 确认**；wish 稳定 id + 休眠制；召回 0..1/轮 | 见 §8.14 | 多用户 AaaS 账本化（RFC §6.5）或出现第二个效用消费方时复审 | `memory-utility.ts`；`index.ts gotry_wish_pool_list`；smoke §10 |
| 15 | 事务化状态基座（RFC `rfc/transactional-state-rfc.md`，业界 durable-execution 五件套收敛） | 见 §8.15 | 多用户 AaaS 化（RFC §6.5 claim/CAS 实装）或需要多写者/多端复制（cr-sqlite/Litestream，触发式=D-15）时复审 | `state-ledger.ts`；run-all §28/§29 |
| 16 | 双形态架构冻结（本地+Web）：**一套账本语义，两种宿主绑定**；`tenant_id` 一等字段；append/read/fold/rebuild 全部以当前 ledger owner 为作用域；同步=事件复制非状态翻译 | 见 §8.16 | 永不复审（双形态是产品形态基座）；同步协议与 claim/CAS 实装按触发器后置；历史 local 事件不可无证据自动反推租户 | `state-ledger.ts` schema v2；run-all §28 双形态断言 |
| 17 | 预订 saga 状态机具名化（issue #17 采纳，2026-08-29） | 见 §8.17 | M5 拍板 WriteGate 时复审（启封增量的 schema CHECK/seam 词汇/L4 自动类）；若出现需要并行多写者的预订流，复审 keyed 单写者形态 | `ts/src/booking-saga.ts`；`docs/design/booking-saga-fsm.md`；run-all §36 |
| 18 | 效应解译器 effect_interpreter.v1（issue #16 采纳，2026-08-29） | 见 §8.18 | 出现需要跨渠道比价聚合的产品裁决时复审「平铺」边界；写效应（预订/支付）入注册表时必须走 booking_saga_fsm.v1 边表（M5 Entry） | `ts/capabilities/effect.ts` `resilience.ts`；`docs/design/effect-interpreter.md`；run-all §37 |
| 19 | 可下单事实单一数据源 + 产物事实闸（issue #46,2026-08-30） | 见 §8.19 | 出现第二类需闸产物（如酒店直订）时复审覆盖面；政策实时源接入后复审政策事实生产端；根治方向=产物只由渲染原语生成（结构化→markdown 单向），反向抽取降为兜底 | `ts/src/bookable-facts.ts` `ts/src/artifact-gate.ts`；`data/airline-airports.json`；run-all §39；smoke §16 |
| 20 | 价表 provider-aware v2 + 价格漂移长机制（issue #49,2026-08-30）：封存价表 `gotry_llm_price_table_v2`（DeepSeek tiered + MiniMax flat，未知模型 fail-closed 不猜价）+ 四 provider 漂移监测，**永不自动 apply 价格**（调整走 PR + 人 review） | 发版时人工核价（滞后）/自动 apply（拒绝：官方 down 5% 曾被误认为我方 bug） | 监测误报成系统性问题、或价格源形态变化时复审 | `ts/data/llm-price-table.json`；`ts/scripts/price-drift-watch.ts`；run-all §41/§42 |
| 21 | 扩展分发三通道（issue #21 分发通道，2026-08-30；商店轨 2026-09-02 上架） | 见 §8.21 | ~~商店过审后复审 wizard 步骤~~（已触发：wizard 退化为离线健康探活等待；安装=浏览器的事、渲染=dsh UI 的事，§3.3 职责返交落地）；GitHub 不可达地区常态化时复审镜像默认值；出现第二分发产物时复审通道抽象 | `ts/capabilities/session/extension-distribution.ts`；`scripts/package-extension.mjs`；run-all §43；`docs/ops/extension-webstore-submission.md` |
| 22 | static golden 是**可审计 benchmark comparator**，不是实时航班源（issue #67） | 见 §8.22 | 出现可免私有凭证、许可清晰且稳定的官方 flight API，或 hbcli 发布 flight 合同时复审其为新 provider；static 仍只保留为确定性回归夹具 | `ts/capabilities/session/static-flight-golden.ts`；`ts/data/sf-static-routes.json`；run-all §44 |
| 23 | embedded Booking Copilot 安全边界与 BFF request identity binding（单一 booking.surface 契约） | 见 §8.23 | 出现离页自动写/支付必须进入 M5 WriteGate proposal/ADR 后续实现；出现多写者/跨 host 触发 ADR-15/16 复审；~~所有消费方迁移 v2 后再退 v1~~（**已触发 2026-09-05**：#133 收敛为单一契约，v1 退役，文件转正为无后缀 canonical 名） | `schemas/booking.surface.schema.json`；`ts/src/booking-surface/`（contracts/runtime/server/startup 等）；run-all 证明面 |
| 24 | turn 预算 = 路由 + wall-clock 双出口：确定性分类 → converge/handoff；handoff 落独立工单待 loopx tick 收 | 见 §8.24 | 路由误分成系统性问题时（用户反馈「该当面答的被转后台」可观测），先扩 Tier 0 信号词表再考虑 Tier 2（结构化状态）；handoff 工单积压需要真实收集器时启动 loopx tick 设计；评测端 60s 太紧先调 env pin | `ts/src/turn-policy.ts`；`ts/src/turn-deadline.ts`；`ts/src/index.ts` 装配；`ts/scripts/turn-policy-tests.ts`；`ts/scripts/agent-planning-turn-deadline-{tests,e2e}.ts`；`scripts/run-all-tests.sh` §45 |
| 25 | 通道健康面与动态路由建议（issue #106/#107/#108，D-7/D-8/D-9 采纳 2026-09-03）：工具面保持平铺（ADR-18 判定不动）、解译器不做隐藏改道；通道注册表单一数据来源生成 persona 卡/工具描述/doctor 行；检索 verdict≠hit 时结果内注入 `routing` 有序建议（可用性>证据级>效率字典序，健康态过滤），契约在失败现场教学；配额五分类（user-session/user-key/anonymous-trial/free-public/static）冻结归属语义；calendar 默认不挂载（D-9） | 解译器自动改道（拒绝：模型以为调 A 实际走 B，破坏调用可审计性）/静态反转优先级（拒绝：每个新用户先付扩展安装成本）/只靠 prose 教义（拒绝：prose 腐坏，普通模型读不动） | routing 建议误配成系统性问题时先修注册表数据；出现跨通道比价聚合产品裁决时与 ADR-18 一起复审；正式 key 池（产品统一申请）待 M3 真实 cohort 规模复审 | `ts/capabilities/channel-registry.ts` `channel-health.ts`；`docs/design/tool-orchestration-design.md`；run-all §50；smoke（flyai needs-setup→routing） |

### ADR 展开（表内「见 §8.x」的正文）

#### 8.12 时间感分层
- 时间评测集进仓（`data/time-slot-eval.json`，只增不改语义），质量层首块落地。
- 备选与取舍：全 LLM 感知——锚点缺失实测（legacy 路径无「今天」注入，过期无从判）；代码全量解析中文相对日期——表达开放，维护黑洞。
- **复审补充的边界**：解析层只认锚点卡词表 + 绝对表达 + 「+N」后缀；词表外 unresolved 逐字保留，**不做开放式解析**（锚点 `slot-spec.ts`；time-eval §5）。

#### 8.14 记忆效用 sidecar
- `recalled`/`applied`/`verified_outcome` 三类事件 append-only（`gotry-state/memory-utility.jsonl`）。
- **归因纪律**：attribution 只能在 confirm-outcome 由用户明说落盘，**模型不许自评「有用」**。
- wish 稳定 `wish_id` + muted（休眠不删除）；召回 0..1/轮（`gotry_wish_pool_list` 条件评分，muted 永不召回，无命中不硬推）——M4 北极星「下一次出发率」的度量底座。
- 备选与取舍：召回即记「有用」——自称用了 ≠ 让结果变好；wish 删除制——憧憬不该被拒绝。

#### 8.15 事务化状态基座
单文件 SQLite 账本（better-sqlite3，WAL）= 唯一权威，业界 durable-execution 五件套收敛：
1. **events append-only**：语义幂等键 UNIQUE 物理化，`wish_id` 语义派生。
2. **投影表 fold 可重建**：纯函数守门原样复用，语义层零改造。
3. **红线进事务**：evidence/conditions 拒绝即回滚。
4. **durable 工单**：`workflow_steps` intent-before-execute，崩溃恢复 exactly-once。
5. **pending_writes saga**：WriteGate L2/L3 基座（幂等键/receipt/补偿）+ what-if 分叉（VACUUM INTO）。

旧 JSON/JSONL 降级为单向导出视图（红线 6）；one-shot 迁移（首写自动 + 快照 `pre-ledger-backup/`）。

备选与取舍：Postgres/DBOS/Temporal/Restate 平台——单用户本地产品不需要服务端（SQLite durable 学派「一文件即控制面」）；纯文件加固 tmp+rename——修不了跨文件分叉与并发；`node:sqlite`——零依赖但较新，D1 落选备选。

#### 8.16 双形态架构冻结
- **一套账本语义，两种宿主绑定**：本地 = better-sqlite3 直读文件；Web = 同一 schema 跑在每用户 SQLite 文件（或 Postgres，schema 同构）。
- **`tenant_id` 从第一天就是一等字段**：events/投影/工单/pending_writes 全部带租户列，单用户期恒为 `'local'`，主键空间化防跨用户撞。
- **执行边界（issue #224 修复）**：`insertEvent` 必写当前 ledger tenant；`readEvents(kind?)`、投影 fold 与 `rebuildProjections(toSeq?)` 必带 tenant 条件；`wish.updated` fold 查当前租户已有 item，跨租户同 `wish_id` 不串读。legacy JSON/JSONL 与 v1 DB 只迁入 `local`；已经被旧 bug 写成 `local` 的非 local 事件缺少可审计 owner，不可由 schema 迁移猜回，只能在有外部证据时另走人工 data-repair issue/PR。
- **同步 = 账本事件的复制，而非状态的翻译**：events 行带 `tenant_id` + 幂等键，双端合并天然幂等。写必经账本，读必带租户上下文进不变量表。
- 备选与取舍：本地与 Web 各长一套逻辑——多用户期合并只能推倒重来；云端权威 + 本地缓存——违反红线 6 本地优先；同步投影而非事件——投影是派生态，合并会分叉。

#### 8.17 预订 saga 状态机具名化
预订/支付/退改的 saga **不引入编排框架（LangGraph 等）**，FSM 落为账本 `pending_writes` 的词汇层（`ts/src/booking-saga.ts`，`booking_saga_fsm.v1` 纯函数）：状态字母表与 CHECK 约束逐字一致，边全函数化。

备选与取舍：LangGraph/Temporal 式框架——第二运行时，违反 harness 基线与复用矩阵；状态散落 SQL 字符串——边语义漂移无词表；多 Agent 提示词协同——隐式依赖。

#### 8.18 效应解译器 `effect_interpreter.v1`
「效应描述 + 解译器」下沉到 L4 渠道边界——工具/编排层只产纯数据效应值 `{effect, params}`；渠道访问、退避重试、断路器、编译期 mock 全部收敛到解译层。

备选与取舍：逐工具自由调用能力层——横切逻辑复制，无退避/熔断/mock 面；Python browser-use——违反零 Python 依赖；解译器内置多渠道路由排序——违反 OTA 平铺。

#### 8.19 可下单事实单一数据源 + 产物事实闸
每个可下单事实（航班号/时刻/机场/价格/政策）**只允许存在于结构化事实层**（`gotry_bookable_fact.v1`），产物渲染前过闸。

本切片补齐机/火共享原语的行内硬价边界：exact-date 事实价为 CNY 时，仅绑定航班/车次自身窗口内的 `¥NNN`/`CNY NNN` 做可靠一致性校验；不一致产生 `price_contradicted`，源事实缺价、不支持的硬币种、或无锚点且价格超出启发式 120 字窗口产生 `unverified_price_claim`；起价/约价、非数字仍不比较，不做换算或容忍度推断，酒店 `priceRaw` 保持打码语义。不关闭 [#273](https://github.com/Danceiny/gotry/issues/273) 或 D-26 全部残余。

备选与取舍：LLM 自觉标注——无强制力（issue #46 实证失败）；渲染时宽松放行——未核验事实出门；政策面接实时签证 API——v1 政策事实仅渲染侧 + 闸侧，生产端记 D-26。

**根治方向**：产物只由渲染原语生成（结构化 → markdown 单向），反向抽取降为过渡态。

#### 8.21 扩展分发三通道
Chrome 平台禁止非商店 CRX 直装——GitHub Releases 只做「下载」（稳定资产名 tar.gz/store-zip/dist-manifest），Web Store 才是「一键装 + 自动更新」。三通道同一扩展：**Chrome Web Store（2026-09-02 上架，推荐）** 一键装/自动更新；GitHub 通道显式 opt-in（免审核、版本更新更快）；bundled 保离线确定性兜底。

**上架实测**：商店用自己生成的签名 key 重签，不认 manifest 固定 key——商店版扩展 ID（`oeajpiccmonococjcegddlooeeohlbgd`）与 unpacked 固定 ID（`olpgkofjhhiiiahdkkbcninhjmegghfe`）不同；桥 Origin 白名单双通道同信（`EXTENSION_ORIGINS`，run-all §38），端口池/host 白名单不随通道漂移。

备选与取舍：任意 URL 装 CRX——平台禁止；npm 包唯一通道——扩展更新被迫跟 rc 发版火车；独立 pinning——与解耦目标冲突；自建更新服务器——违反零基建面。

#### 8.22 static golden = 可审计 comparator
route/carrier 只取 OpenFlights 固定 revision；时刻/价格取 manual band 且逐字段标 estimated；`requested`/`effective` source、revision/license 与 fallback reason 同条 evidence 落盘。**快照或路由失败必须 stderr 告警后回退 manual，禁止静默换源或伪装 live availability。**

备选与取舍：`hbcli search-flight`——本机与上游均无此能力（N/A）；携程免凭证开放 API——未找到且公开页 432（N/A）；直接把 manual 改名 static——来源造假；仅保 manual——继续 vendor 锁。

#### 8.23 ADR-23：embedded Booking Copilot 安全边界与 BFF request identity binding

> **状态更新（2026-09-05）**：复审条件「所有消费方迁移 v2 后再退 v1」**已触发**——#133（栈式合流 #134）把双协议收敛为单一 `booking.surface` 契约：v1-only runtime 删除，v2 栈转正为无后缀 canonical 文件（`contracts.ts`/`runtime.ts`/`server.ts`/`startup.ts`），`SCHEMA_VERSION='booking.surface'`，单一 HTTP 路径单一握手，ledger 去掉版本词表；JSON wire 字段名不变。以下为双协议时代的决策原文（边界设计仍然成立），当前形态以本条为准。

Booking Copilot 是既有工作台内的 BFF-only embedded read-action 面：

- **协议形态（历史）**：v1 曾保持兼容，v2 曾以 closed typed contract 并行；同一 listener、task ownership 与 ledger 按请求 version+schema hash dispatch。**2026-09-05 起收敛为单一契约，v1 退役**。
- **identity binding**：生产 standalone 的 `bff-bound-turn-only` 只接受已由 BFF 绑定的 internal `user.turn`/receipt continuation；v2 浏览器只提交安全 opaque `requestKey`/可选 `taskHandle`，只有完整 authenticated principal/scope + BFF trusted binding seam 才能把 `user.turn.ingress` 原子映射为服务端生成并持久绑定的 `taskId + turnId + contextRef + surface + allowedActions`。bound-turn-only 下 ingress 在任何 ledger/planner side effect 前返回 typed 503；taskHandle 在 actor scope 内只能绑定一个 task/context。
- **approval 一次性**：must blocker 只能经 runtime 持久化并实际呈现的 option 放行；approval 逐字段绑定 task、context、source turn、source action、source receipt digest、canonical presentation key、随机 delivery nonce 与 option digest，只能消费一次。
- **availability reducer（typed 恢复子状态机）**：一次 recovery 冻结最多 5 家候选酒店；每家 generation 最多 3 个当前 OfferRef，每家生命周期最多 2 次 CheckAvail、2 次 offers/HotelRates generation。`unavailable`、material `changed` 或不可确认 gap 使整个 generation 失效并要求 fresh query；partial evidence 只产生 inconclusive exhaustion，不能宣称市场无房。generation/attempt/candidate/receipt digest/workspace revision 随 ledger fold，重启与相同 replay 不增加预算；terminal 是吸收态。

明确拒绝的备选：独立聊天预订页；用 breaking v2 替换 v1；自由文本/JSON 执行；把 server outbox 意图当作已展示；在 embedded 面暴露 `Book`。当前能力不包含 portal token、PII 或供应商成本出站；离页自动写/支付已让渡到 M5 WriteGate proposal（`design/write-gate-production-design.md`），多写者或跨 host 则按 ADR-15/16 复审。

#### 8.24 ADR-24：turn 预算 = 路由 + wall-clock 双出口（turn-policy / turn-deadline）

**问题（2026-09-02 轨迹定形）**：任何一轮对话必须终结在三态之一——①当面答完 ②转异步并给出回访承诺 ③收敛作答；绝不允许第四态「流死掉、什么都没交付」。原步数闸（16 软/18 硬）与 v1 固定 wall-clock 闸（60s/120s）同属一个错误形状：到点「拒绝工具 + 逼出 final」——模型仍可能在流中死掉，轨迹用户拿不到任何东西。

**v2 设计（复杂度决定出口结构，不是映射到更大的常数）**：

- **路由层**（`ts/src/turn-policy.ts`）：每个 user/message（source.kind=user；plugin/skill 注入不参与）确定性分类 quick / sync-planning / deep-planning。纯函数、零 LLM、零 IO——控制面判定必须确定性（责任铁律；ADR-9 同型先例）；路由器不能花它要分配的资源；LLM 路由会破坏评测可复现（§45 离线 E2E 零真 LLM）。v1 规则输入只有 Tier 0（日期跨度提取器+约束词表+消息长度）；`loop.ts` 的 `isComplex` 是 S5 循环架构的访谈后复核，不在产品路径（唯一调用者是 replay 脚本），且对轨迹首消息判 false，**不进此层**。误分有界：最坏结局是「本可当面答的被转后台」（下一轮可救），所以路由器只需够用不需完美。
- **分配层**：分类 → `TurnPolicy={softMs,hardMs,exit}`。阈值表是数据不是代码（评测/部署换表不换执行器）：quick 120s/180s converge；sync-planning 300s/600s converge；deep-planning 120s/240s **handoff**（同步窗口只够摸底+落单）。
- **执行层**（`ts/src/turn-deadline.ts`）：硬阈拒绝时**同步**抑制继承工具 schema（轨迹教训：延迟到 `step/end` 模型会在同 step 回环拒绝结果直到 token 截断），按 exit 返回：converge=`TURN_DEADLINE_EXHAUSTED`（用已有证据作答）；handoff=落 `gotry_turn_handoff.v1` 工单（`<stateRoot>/gotry-state/turn-handoffs/`，含用户原文/ETA=约1小时/status=open）并指令模型一句话告知「已转后台+预计时间+回访方式」。工单是**独立格式独立目录**：async-collect 对无 spec 的 state 会立即结算 failed（假失败），handoff 收集器是未来的 loopx agent tick——落单本身已是三态承诺的兑现（有据可查、可回访），不等收集器存在才有意义。
- **装配**：产品路径 `apply()` 默认装（路由+handoff 是产品行为）；benchmark opt-in 钉死 `{60s,120s,converge}` 固定 policy 保可复现。`GOTRY_TURN_DEADLINE_SOFT_MS`/`_HARD_MS` 仅 pin 数值不改出口；`GOTRY_TURN_HANDOFF_ROOT` 钉工单隔离根（source 模式 dsh cwd 是创始人真实数据目录 `ts/dsh-runtime`，测试必须钉，巡检状态纪律）。无 agent 的程序化调用不计，turn/session 终态释放状态与限制。CI 先打当前 SHA 的 tarball、在隔离 pnpm consumer 中解析 dsh peer closure，再把该安装入口交给同一 E2E，不借 root 开发树冒充发布形态。
- **验证**（`run-all §45`）：`turn-policy-tests.ts` 表测（首条 fixture=轨迹用户原文，canonical deep case 必须命中——整个重设计的回归锚点）；`agent-planning-turn-deadline-tests.ts` Cordis 集成（converge/handoff 双出口、工单字段、plugin 消息纪律、生命周期）；E2E 以合成 deep 消息+relay 拖过硬阈，断言 handoff 结果、工单落隔离根、最终请求 text-only、非空 final。

**收集闭环（2026-09-02 v2 补全，「一小时后回来看看」的后台半段）**：

- `ts/scripts/turn-handoff-collect.ts`（单张 `<ticketId>` / `--all`，async-collect 的 turn-handoff 对位）加载 open 工单 → 以 `GOTRY_HANDOFF_CHILD=1` 派生 headless 规划会话（`bin/gotry-inner.js`，可经 `GOTRY_HANDOFF_PLANNER_BIN` 覆盖；递归防护：子会话唯一出口 converge + 长 leash（300s/900s），父进程的数值 pin 与工单根在子环境清除——前台转后台、后台必须产出交付物，不得再次 handoff）→ 捕获最终答复结算。
- `settleTurnHandoffTicket` 原子写 `<id>.deliverable.md` + 工单 status settled/failed（settledAt/deliverableFile/error）。终态幂等：已结算工单复诵交付物与 `gotry_turn_handoff_terminal.v1` JSON（succeeded exit 0 / failed exit 2），零重算零再花；failed 交付物是诚实失败说明（「没有完成，请重新发起，无部分结果可交付」）。
- 复访面：产品路径注册只读工具 `gotry_turn_handoff_list`——用户回问「规划好了吗」时模型查工单状态，settled 附交付物摘录（≤600 字，全文在同目录 .deliverable.md），禁止编造不存在的交付物。
- 调度：收集器是一次式命令（cron/loopx tick/人工均可驱动，`--all` 扫全部 open）。v1 诚实边界：工单只携带用户原文，规划会话是全新上下文（fresh cwd/DSH_HOME），原会话已读的工作区/日历结论不随单迁移，由规划器按需重取。E2E 闭环：§45 的打包二进制 E2E 在 handoff 断言后以真二进制为 planner 跑收集器，断言 ticket open→settled、交付物含规划器 final。

复审触发：路由误分成系统性问题（「该当面答的被转后台」可观测）时先扩 Tier 0 词表再考虑 Tier 2（结构化状态）；handoff 工单积压需要真实收集器时启动 loopx tick 设计；评测端 60s 太紧先调 env pin。

明确拒绝的备选：到点杀 turn 的任何常数闸（固定或 LLM 动态生成——形态不变则轨迹失败模式不变）；LLM 路由（一致性/可复现/成本三输；若未来信号不足，走 loopx RFC S4 的 L1 shadow→L2 advisory 影子对比路径挣授权，不默认给）；handoff 复用 loop 工单格式（async-collect 假失败）；阈值交 dsh 宿主传（违反 gotry/dsh 分层）。

## 9. 演进（时间线唯一来源= `roadmap.md` 的 M0-M6；此处只保留原则与现状）

- **WriteGate 机制层：持久化可信审批 + 原子 outbox（2026-09-11，issue [#231](https://github.com/Danceiny/gotry/issues/231)，M5-2 首件）**：`ts/src/write-gate.ts`（write_gate.v1）落地生产化设计（`design/write-gate-production-design.md` §3/§5，对齐 `design/fact-writegate-seam.md` §2.2 的两段事务次序）的机制/契约层：PreparedChallenge/ApprovalClaim/WriteEffectIntent 持久化，事务 1 = receipt 一次性消费 + pending_writes 转移 + outbox 入队单 SQLite 事务原子，事务 2 = dispatcher 原子领取且不可变 attempt/fencing 先于任何外部调用落库，存储层等价不可绕过约束（复合外键、receipt 非空 CHECK、派发只进不退触发器、attempt 不可变触发器），L4 撤回在发行/消费/派发三点阻断，派发前复验失败置 `rejected`。**非运行时激活：零真实供应商/交易调用；产品运行时在 M5 Entry（#136）前不实例化 WriteGate；默认路径零变化；不宣称外部 exactly-once。**否证：run-all §60（95 断言——模型冒充、prepared 挑战直接消费、跨 intent/租户重放、金额/条款/nonce 漂移、receipt/挑战过期、三崩溃点注入全有或全无、双进程领取竞争恰一赢家、裸 SQL 物理红线；红→绿已由拆除复合外键/只进不退触发器证得）。

- **#299/#355 机票/车次 claim 分流与 12306 typed session（2026-09-10，父 #273）**：完整 G/D/C/Z + 3–4 位车次独立入 `trains`，合法双字母航司（含 `CZ8582`/`9C8781`）保留在 flights；flight/rail verdict 按 fact kind 隔离。FlyAI train 与 `gotry_session_search kind=train` 均沿工具→typed fact log→canonical anchor→`gotry_fact_gate` 路径；12306 typed outcome 区分 empty/malformed/transport，正事实以 host-captured invocation route/date/batch 与精确 response URL binding 为准，行内 startTrainDate 仅校验并保留、`captured_at_non_future_and_max_age_15m`、`canWebBuy=Y` 与闭集可用座位 token，列表不补票价。缺证据仍 `rail_claim_unverified` fail-closed；仅确定性 fixture，不宣称真实供应商可售性或 M4/M5/M6 准入，#299/#273 保持 open。

原则：**不跳阶段，不提前优化下阶段的事**；每阶段 Entry/Exit/gate 见 roadmap。旧 Stage 0-4 与总纲 Phase、产品 M1-M3 已归并映射到 M0-M6（映射表在 roadmap）。

- **M0 ✅ / M1 ✅（bb880f3）/ M2 ✅（b0cfd97）**：M2 交付 = §7-1 三层组合（骨架+校验+锚点）+ hbcli 桥 + dsh 端到端（DeepSeek 原生，人格+五工具）+ 一键入口 `./gotry`；G1/S1/§7-1 三 gate 由创始人指令结算。
- **Issue #202/#242 地图插件 vendoring 回归修复**：root/ts 严格 npm 安装不再解析外部 `dsh-map-tools` peer；`vendor/dsh-map-tools/` 携带上游 `0.5.1` MIT payload，其 vendored settings 接线使用 alpha.3 已发布的 `SettingsProvider.prototype.installSection(owner, ns, schema, entry, hooks)` 方法和普通字符串 namespace，由 proof 验证。`bin/gotry-inner.js`、CLI bootstrap 与 `capabilities/doctor.ts` 同优先级解析仓内绝对入口；打包证明覆盖 unpack/import、32 文件 payload aggregate、7 个 `map_*` 注册、settings watch/reload/dispose 生命周期及无网络 inline 坐标路径。
- **Issue #341 地面接驳接缝**：公开 map-tool 只作为 provider 边界，不深导入 `OsrmClient`；路线估算在 capability 层解析为确定性分钟事实后才进入既有 solver 输入，故 solver/evaluate 不执行网络。`ground_transfer` 同时绑定抵达方向（A→B）与返程方向（B→A），两方向分别请求、缓存与降级，任一方向 miss/error/stale/不匹配仅回退该方向到静态估算，不借用另一方向的动态值；候选 transfer 同时持有 `minutesOut` / `minutesRet` 覆盖供 `evaluateChoice` 按方向消费。第一切片只把路线分钟接到具名 destination 的静态 `taxi` transfer，价格沿用静态包；`bus`/`bus_plus_taxi`、live traffic、transit/rail、fare、地址解析与更广泛 transfer 组合仍未纳入，#364 切片不改变 #20/M5/M6 gate。
- **当前主线 = M3 evidence 未收口；并行线 = founder 授权的 M4 记忆域**：M3 工程与分发面已就绪，真实种子用户的定稿率/NPS/POI 幻觉率证据仍是 Exit 缺口。M4 自 2026-08-26 起获 founder 授权并行推进；T1 及后续记忆切片、Issue #20/#223 scorer、Issue #228 显式 lifecycle collector 都不构成 M3 Exit 证明，真实 `observed_private` N≥5 repeat cohort + source-review attestation 仍缺。M5 交易与 M6 B2B 仅在各自 Entry gate 满足后启动，不得由并行实现倒推开闸。
- **HotelByte Booking Copilot 产品验收并行线**：候选以单一 `booking.surface` 契约（2026-09-05 #133 收敛，原 v2 形态转正、v1 退役）的 GoTry 作为既有搜索/报价/Checkout 工作台的 BFF-only typed read-action planner（边界见 §8.23）。该线不含 `Book`，不构成 M5 Entry；四 surface 真实库存与「不可订→重搜→新 CheckAvail→原 Checkout」证据尚未取得，见 D-29。
- **M3 真实证据并行线（Issue #22）**：v1 manifest、脱敏 cohort/nightly schema、确定性 scorer 与 fixture 守门已进入工程面；业务达标只接受阈值冻结的 `real_seed_cohort`，fixture 恒 fail。真实 cohort 仍为空，等待 50–200 个脱敏样本，不宣称 M3 Exit。
- **时间感优化（2026-08-27，外部时间评测驱动）**：时间锚点层（算术进代码，LLM 查卡不自算）+ 槽位抽取 v1（逐字保留）+ 25 题评测集与评分脚本落地，ADR-11 质量层首块兑现（原定 M3，迟到的落地）；真模型（deepseek-chat）25/25。slot→spec 求解桥接未做（D-10）。
- **tsc 存量清零 + loopx RFC 专项（2026-08-27）**：`npx tsc --noEmit` 14 错清零（D-11 清偿，1bf9671）；同日 loopx 13 篇架构 RFC 通读映射，产出 `rfc/loopx-inspired-upgrades-rfc.md`——**founder 当日 accepted**，四切片 S1-S4 按序落地；同指令确立**多用户 Agent as a Service** 为未来方向（claim/CAS 类机制转入 RFC §6.5 远期采纳面）。S1 tool-packet envelope（ADR-13）已落地；S2/S3/S4 依次推进（D-12）。
- **事务化状态基座落地（2026-08-28，ADR-15）**：业界 durable-execution 调研收敛五件套 → `rfc/transactional-state-rfc.md` 立例、founder 当日 accepted；TS-0..TS-4 一次落地（账本 + 五状态工具写路径 + 读路径回退 + state-cli 操作面 + durable 工单崩溃恢复 exactly-once（§28 子进程 exit 9 实证）+ `gotry_async_terminal.v1` 终态合同 + pending_writes saga，run-all §28/§29）；TS-5 触发式后置=D-15。同日 **ADR-16 双形态冻结**：tenant_id 一等字段（schema v2），同步=事件复制非状态翻译；§28 双形态断言。
- **会话数据面 #21 首切片（2026-08-29）**：`session/benchmark.ts` 固化 required comparable fields 的 fixture scorer（缺字段计错、默认 90% 闸）与双源合同（按 journey/segments/时刻/班次对齐，价格只记差值不判等）；`needs-attach`/`needs-login` 为 waiting-user no-spend，challenge 与 ReadGuard 非零 fail-closed。纯 fixture 已进 run-all §25；真实 sf-01..08 仍等待 Chrome attach 权限确认与握手。
- **扩展分发双通道（2026-08-30，issue #21，ADR-21）**：founder 指令「产物下载和安装也得做成更好的用户体验，可以用 github 作为分发渠道」。Chrome 平台约束**诚实前置**——非商店不可免「开发者模式加载已解压」的 3 次点击，GitHub 只能改善下载。GitHub Releases 下载通道已落（`gotry setup --extension-from=github` 显式 opt-in，默认仍 bundled 保离线确定性）；Chrome Web Store 2026-09-02 过审上架 v0.1.0（一键装+自动更新，现为推荐安装方式；材料与隐私政策见 `ops/` 两篇）。回归：run-all §43。注：本条曾在 §1 出现两份内容矛盾的副本，2026-08-31 文档重构时以「已提交审核中」为准合并。
- **会话传输层定案扩展桥（2026-08-30，#21 方案 C 升 PRIMARY）**：founder 实测「Chrome attach 逐连接权限框根本无法使用」（chrome-devtools-mcp #825：每次连接必弹、无持久化批准）→ CDP 降显式 opt-in、扩展桥主载——`extension/`（MV3 零构建，固定 key=扩展 ID，SW 长轮询，MAIN-world 被动嗅探，cookie-names 只取名）+ `extension-bridge.ts`（`node:http` 回环桥，origin 白名单，零新依赖）+ 车道路由（扩展默认/cdp 显式/persistent 测试）；登录快路径免标签页；守卫按车道分形（扩展=零写行为+hints 白名单，cdp=请求级 abort）；`needs-extension` → `waiting_extension`（waiting-* 同族 no-spend）；run-all §38 + bootstrap-tests；真实 sf-01..08 门禁降为「装一次扩展」。
- **Issue #67 static golden（2026-08-30）**：`sf-live-benchmark` 的 vendor 闭集扩为 `manual|flyai|static`；`static` 由 OpenFlights 固定修订提供 route/carrier，由手工 manifest 提供估算时刻/价格带，requested/effective source、estimated fields、provenance、fallback reason 逐条写进 evidence。静态源异常时 stderr 告警后回退 manual；它不声称实时班期/价格/库存。run-all §44 固化 CLI fail-closed、八条覆盖、回退与 provider-independent 软评分。
- **Issue #335 offline summary repair**：汇总器不再按来源偏好挑 manual、跨批拼 query 或把非 manual 统归 FlyAI；canonical producer filename 是 legacy batch identity，最新批次按文件名采集时间选取并在 corrupt/incomplete 时 fail-closed。run-all §44b 覆盖临时 evidence root、同批八 query、旧 manual 对新 static/error、missing/corrupt 与 legacy unknown。结果仍是 deterministic/offline fixture evidence，不改变 #272 的 live session/calibration gate。
- **Issue #67 登录态真跑与桥退出语义（2026-08-30）**：连续两轮 static official 均 8/8 命中且零 fallback；session hit 数从 3/8 波动到 5/8，全部可评分 hit（3+5 条）均 13/13=100%，非 hit 必须显式披露且不进软评分分母。真扩展在线场景触发的 CLI 不退出已以默认桥 parked timer/socket `unref` 修复；`keepBridge` wizard 轨通过 §40，§38 增子进程回归。
- **M4 Issue #20/#223/#238/#228 价值证据切片（2026-08-29;2026-09-08 scorer 加固与 collector）**：paired-cohort 合同、active-planning 扣 wait 口径、experience-reflux 与偏好/P4 红线被一个只读 scorer + 合成 fixture 固化并接入 run-all §34。#223/#238 追加逐层 exact schema、HMAC-SHA256 假名键、N=5/中位降幅=0.5 阈值冻结（raw ratio 比较，报告才 round）、source-review attestation 与 `reviewed_summary_digest_sha256` 绑定。#228/#248 追加显式 opt-in lifecycle collector：stateRoot/consent/HMAC 必需、dataset key verifier 与 source/wait 冻结、写前完整投影校验、write-all + 原子发布 + 叶子/父目录 realpath 隔离，导出只给 candidate/synthetic source_review。合成数据明确不可关闭 M4，observed-private 缺人工核验合同或 digest 不匹配时也只可作为 candidate。下一阶段仍等待真实 `observed_private` N≥5 repeat cohort，无样本时 waiting/backoff/no-spend。
- **M4→M6 program 任务图（2026-09-08，issue #225）**：`docs/design/milestone-delivery-plan.md` 将已入 main 的 M4 scorer（#238）、explicit opt-in planning lifecycle collector（#248）、ledger tenant/fold/migration（#229/#237）、state-cli（#243）、Z3 生命周期（#244）与 map tools（#245）同仍 TODO 的真实 N≥5 repeat cohort、M5 首供应链 `hotelbyte-cli` 协议核验 + WriteGate、M6 P6 评审+试点条件拆成 owner/责任文件/依赖/E2E/否证/退出标准；`docs/design/write-gate-production-design.md` 仅作 M5 proposal，覆盖 request fingerprint/receipt/一次确认/崩溃恢复/HotelByte unknown 对账/补偿/佣金披露。该批不改 runtime，不启封交易或 B2B 实现，不改变 Exit。
- **M4→M6 公开交付台账（2026-09-10，issue #270）**：issue 启动记录范围/base/执行路由与闸，Draft PR 公布 exact head/漂移/本地证据/TODO，review 绑定 head，merge 记录方法/merge SHA/destination；founder 授权的仓内 Claude lane 免外部机器人 T0/T1 否决但不免正常评审。债务 owner/trigger 见 §10，本地与 fixture 证据不替代 #20/#22/#136/#137 的真实准入。
- **#279 携程机票 malformed 响应隔离修复（2026-09-10）**：三态解析合同为合法 `flightItineraryList: []` → `miss`；非空列表至少一条有效航段 → `hit` 并忽略畸形兄弟；JSON/root/data/list/显式非数组 `priceList` 或非空列表全无有效行 → `error`。兼容 API `parseBatchSearch(body): SessionFlightOption[]` 永不抛错，错误返 `[]`；扩展/CDP 搜索均在 challenge 检测后把 parser error 映射为既有结构化 `error`，不带 options。`flight-malformed-tests.ts` 用声明 `capabilities: ['ctrip-flight']` 的隔离扩展轮询器证明 null、非数组 list/price、全畸形、合法空、命中、混合与 challenge；这是本地解析/编排证据，不满足 #272 live interface calibration、真实 supplier evidence 或 M4/M5/M6 admission。
- **#352 FlyAI malformed 响应隔离修复（2026-09-10）**：精确空 `data.itemList: []` 保持 `miss`；机/火/酒店非空列表任一 item typed 校验失败即整体返回结构化 `error`，丢弃有效 sibling 且不生成负库存事实；仅完整合法列表返回 `hit`。`flyai-tests.ts` 以 production effect、隔离假 CLI 与事实侧车覆盖该边界及既有 429/退出失败语义；这是离线工程证据，不满足真实 provider/UAT 或 issue closure。
- **已知限制清算第一刀（2026-08-29，founder 指令「解决这些 known limitations」）**：
  - **Z3 WASM 生命周期复修（#227,2026-09-08）**：08-29 的单例+互斥仍留下两条 Node24 间歇面——`getZ3` 冷启动 Promise 在 await 后写缓存会并发创建多个 Context；`z3-solver@5.2.0` high-level `FinalizationRegistry` cleanup 直接触发 low-level native `dec_ref`/`*_dec_ref`，不经过 `withZ3`。本轮修复为：Promise 先缓存、启用 `enable_concurrent_dec_ref` fail-closed、局部包装 low-level cleanup 与 actual async native call，仅在活跃 session/native check 时排队 cleanup 并在 idle 后同步 drain；fatal WASM/heap 错误先 poison 并拒绝后续求解。反证覆盖：全局 `FinalizationRegistry` identity 不变、返回的 live Model/Ast 跨 session 仍可用、独立并发请求排队不误判 nested、in-flight native barrier 先进入后才允许 settle。run-all §30/§30b/§30c。
  - **薄壳遗留**（`shell/` 目录）物理删除，dsh web 确认为唯一产品面。
  - **实时票价接入**：`ts/src/realtime-pricing.ts`——dated 航班链段经 FlyAI 官方只读通道按航班号精确匹配覆写 spec 价格，证据链 `[实时API:flyai@ts]` 并进 skeleton_notes；miss/error/打码价/无匹配一律降级回静态包，永不抛错。`realtimeSolvePort`（env 闸 `GOTRY_REALTIME_PRICING`，默认关）接线 replay-real——**静态包由唯一来源变为显式降级**，run-all §31。
  - **i18n 英文面工程层**：`i18n.ts` 消息目录——zh-CN 默认且与金标准逐字节一致，`GOTRY_LOCALE=en` 切英文、en 缺键回退 zh；覆盖求解确定性面（候选/航班链 answer_md、放宽建议、排除理由、wish 理由）。run-all §32；工具卡与人格对话面挂 M4 校准样本随补。
- **贡献基建（2026-08-29，开源协作面）**：GitHub Actions CI（node 22/24 矩阵：typecheck + 全栈回归，`GOTRY_SESSION_LIVE=0`）；`CONTRIBUTING.md` + issue/PR 模板；lockfile（root/ts 双份）与 dsh-runtime 三 manifest 入 git，resolved 全量从内部镜像改指 registry.npmjs.org（integrity 逐包验证）；贡献流程改 PR 制。
- **#271 Phase A 进程事故观察（2026-09-09）**：GoTry-owned `uncaughtExceptionMonitor` 按 origin 同步记录 uncaught/rejection，宿主仍拥有 fatal handler 与退出策略；incident writer 以单一 fd append+fsync+close，任一耐久化失败返回 `false` 且不再抛。native Node24 ESM 反例覆盖 monitor/no-monitor 的非零退出、现有 host handler exit code、writer fsync/close 与 tool structured failure。child close/spawn error、SIGINT、后代进程和上游 dsh supervisor 仍是 #271 未覆盖边界。
- **#271 外层 dsh liveness 收口（2026-09-10，GoTry-owned）**：`bin/gotry-inner.js` 以独立 POSIX 进程组启动 dsh child；exit/error/close 与父进程 SIGINT/SIGTERM 均走有界 TERM→KILL，并等待 direct child 与整个 group 为空，再保留原始退出/信号语义；非 benchmark 路径从 exit 先行清理，保留 benchmark 零退出的 stdout drain/parser。child incident 写入仍在退出前同步完成。`ts/scripts/issue-271-liveness-tests.ts` 以 Node24、fresh package-shaped HOME/DSH_HOME/stateRoot 和真实安装版本 `dsh@0.1.5-alpha.1` 覆盖实际 `bin/gotry-inner.js` 的继承管道 delayed-close、非零、正常零退出与 TERM-resistant descendant，并核对 parent/leader outcome、stderr、产品 incident 行、post-failure marker 与 before/after descendant/group 清理；既有五个 focused cases 继续保留。只证明 GoTry 外层 owner；dsh SDK 直接 transport 与 dsh 内部 supervisor 的更深层契约仍未在本切片宣称清偿，不改上游 vendor/lock。
- **#282 Booking planner 纠偏（2026-09-09）**：`dsh-planner.ts` 不再删除缺 `adults` 的非空 occupancy 房间；schema 纠偏提示占用下一次计数调用，有效结果立即返回，总 provider 调用不超过三次且 provider failure 透传。focused proof 覆盖 occupancy 保留、prose/invalid 纠偏、三次上限与 provider error；仅为注入 runPort 的工程证据，真实库存/UAT 仍属 D-29。
- **酒店日期输入闸（2026-09-09，issue #283，D-36）**：已清偿的日期闸详见 §1.2；该工程证据不改变 M3/M4-M6 真实准入或 Booking 库存业务效果。
- **Node 26 dist 构建兼容闸（2026-09-09，issue #265）**：Node 26 移除 `stripTypeScriptTypes(...,{ mode:'transform' })` 后，dist 构建改走根声明的精确 TypeScript 5.9.3 `transpileModule` + 显式 ESM emit；focused proof 在 Node 22/24/26 核对 source→dist 精确集合、JS/Python/data 资产字节、无相对 `.ts` specifier/无 CommonJS emit wrapper，并执行 skeleton-check 与关键变量动态 import。clean-archive release 先装锁定的 build dev tree，再以剥除 build-only entry 的最终 runtime manifest/lock 严格安装，防 npm optional-peer 把 TypeScript 带回产物。Node 22/24 原 typecheck + 全栈 CI 保持独立。该工程质量证据不改变 #20/#136/#137 的真实准入图。
- **onboarding wizard（2026-08-30，#21 · 2026-09-02 职责返交重设）**：首版闭环 `npx @danceiny/gotry setup wizard`（5 步编排 + 复制扩展路径 + 直达 `chrome://extensions` + 跨平台 GUI 面板 + health-watch 探活 + 扩展就位后自动重放）把用户侧降到 3 次点击 + 0 终端命令。**2026-09-02 商店上架后撤销**：gotry 越界管起了浏览器（`open`/`pbcopy`/`osascript`）与 dsh 渲染层（stdout 文字墙代替 verdict）——LLM 由 dsh 管、扩展由浏览器商店管、CLI 自举由 `gotry setup` 管，三条职责返交。wizard 退化为**离线健康探活等待**（纯 stdout，不动 spawn）；`sessionFlightSearch`/`sessionLogin` 在 `needs-extension` 时返回 `verdict.installUrl` 给 dsh UI 直接渲可点链接。落地 `ts/capabilities/session/wizard.ts` + `health-watch.ts` + `scripts/health-watch-cli.ts`；run-all §40。
- **价表 provider-aware v2 + 价格漂移监测（2026-08-30，issue #49，ADR-20）**：封存价表从 `gotry_llm_price_table_v1`（DeepSeek V4 only）升 `v2`（`providers.<id>.models.<model>` 平铺 + `family`/`price_strategy`/`source_url`/`aliases`）；MiniMax M2/M2.1/M3 入表；`ts/scripts/price-drift-watch.ts` 监测四家主流 provider（DeepSeek/MiniMax/OpenAI/Anthropic），**永不自动 apply 价格**（ADR-11 纪律）。同批 CHANGELOG 自动化：`ts/scripts/build-changelog.ts` + `CHANGELOG.md`。run-all §41/§42。
- **dsh runtime 跟进上游（2026-08-29 起，issue #15）**：上游 `dsh-v0.1.2-alpha.1` 未发 npm 时先以全量 vendored tarball 解堵；Round 5 已将公开 root/package closure 锁到 npm `0.1.2-alpha.3`（source/package root-first 解析，source 普通运行保持 `ts/dsh-runtime/` 状态连续性，package/benchmark 调用目录隔离）；旧 vendor 只作非 benchmark legacy 解析兼容，不承诺可运行。legacy 溯源与升级流程见 `ts/dsh-runtime/vendor/README.md`。
- **OTA 平铺 + 账号授权闸（2026-08-29 第二批，founder 口径「OTA 这些都是工具，不要区分主路径/降级路径；用用户账号必须跟用户确认」）**：①酒店接入 FlyAI `search-hotel` 官方只读通道（解析契约 `FlyaiHotelOption`，打码价保 priceRaw 原值、数字价恒 0，防「¥7xx 截成 7 伪装真价」），`gotry_flyai_search` kind=flight|train|hotel 三形态；②OTA 工具面平铺——工具描述与 persona （19） 去层级话术（L4 证据链逐源标注照旧）；③账号授权闸 v2：`session-consent.ts` 挂 `tools/pre-execute`，每会话每站点首次弹审批→会话内记住，拒绝=本会话吊销（首版逐次弹卡被 founder 实测否决），sessionAccess 三态，无审批通道/headless fail-closed，授权状态存 Weak<agent> 不跨会话；④登录态 seam：`scripts/session-login.ts`（cdp attach→开登录入口→人登录→只读轮询票据名）；⑤测试纪律：session-tests live 节默认 SKIP，`GOTRY_SESSION_LIVE=1` 显式开启——例行回归永不自动开用户浏览器窗口。run-all §24 + smoke §12-13。
- **预订 saga 状态机具名化（2026-08-29 第二批，issue #17 采纳）**：逐机理勾稽（共享态/检查点/防重复副作用/HITL 在账本与 durable 工单已物理存在）后落地词汇层 `booking-saga.ts` + 设计文档 + ADR-17；LangGraph 编排不引入，合规恒为 deterministic-edge，HITL 审批 = pending 挂起 + 外部事件恢复；run-all §36 物理对账。
- **产物面（2026-08-29，issue #25，两步）**：①dsh 内查看——`gotry_artifacts_list/read` 把账本工单交付与工作目录 md 变为可发现、可读对象（read 卡）；②成熟面板——dsh-market 调研（2495 插件）选型 **dsh-better-sidebar**（★3083/18.9 万周装，#1 UI 组件；自建零依赖 webui 因品质不达产品级当日撤回），`gotry setup` 宿主层安装（GOTRY_SETUP_SIDEBAR=0 可跳，幂等/失败降级路①），dsh web 侧栏工作台浏览+渲染工作区产物；产物 Tab（registerTab client-half）为下一阶段。
- **产物视图进入 M4 队列（2026-09-10，issue #285，接 #25 之上）**：list 的 dsh 卡片升级为 `SearchPathsResultView`（`card: 'search' shape: 'paths'`，truncated/total/paths 齐全，客户端 deliverables 列表直接绑到工作区文件，UI 点开任一路径走 read）；read 升级为 `ReadResultView` + `presentCall.locations=[{path,line:1}]`（editor 视图在 call 阶段就 follow-along，fallback content[0] 钉 source 身份行，避免把旧摘要当新内容）。读范围白名单 = stateRoot 根 + dsh 工作目录（排除 node_modules/.git），扩展名白名单 = 文本类（md/txt/json/jsonl/csv/log/yaml/yml）；跨 root / symlink 越界 / 缺失文件 / 超大文件（>2MB）统一返回 ok:false + error + hint。本层只读，WriteGate 红线不涉及；复用既有 dsh 的 `SearchPathsResultView`/`ReadResultView`/`FileLocation`，不新建 chat/file-manager 替代。验收证据 = `scripts/artifacts-capability-tests.ts` 12 项隔离 fixture 离线 proof + smoke §15/§15b dsh 卡片契约断言（`tsc --noEmit` + smoke 全过）；M4 UX 工程面（#258/#267 onboarding 同源）的医生面提示同步指向 gotry_artifacts_list。**Todo（由本切片暴露，留 M4 后续切片）**：list 默认 limit=20，工作区里多份 md 时只取 top-20 by mtime；真用户「找上次那一份」可能要看翻页——list 翻页 / search 子串过滤 / 按 id 直查，留 M4 后续切片。
- **效应解译器（2026-08-29，issue #16 采纳，ADR-18）**：「效应描述+解译器」落地 L4 渠道边界——`ts/capabilities/effect.ts`（效应值注册表+生产/mock 双解译器）与 `resilience.ts`（指数退避+断路器三态）。关键保守边界：①韧性策略 per-效应显式拍板，没有策略行就没有效应（默认全关=对既有行为零改变）；②FlyAI Sentinel 上游「说不」永不重试但计熔断（3 连错开 60s 保配额），SESSION 通道永不重试不熔断（风控红线），免费源 2 次退避；③浏览器解译=SESSION_* 效应（既有 CDP 通道），零 Python 红线不做视觉 CUA；④不做渠道自动路由/比价（OTA 平铺 founder 判定，agent 层比价）。垂直切片接 5 工具+realtime-pricing 默认查询口，余下渠道增量迁移（D-23）；run-all §37。
- **可下单事实闸（2026-08-30，issue #46，ADR-19）**：真实会话产物（2027 远期行程）把 exact-date 全 miss 的航班用「当前班期网页+历史」回填并标 ✓/推荐——根因=可下单事实无单一数据源、产物无闸。落地：`bookable-facts.ts`（纯函数层）+ `artifact-gate.ts`（产物闸）+ `fact-log.ts`（侧车落账）+ 第 21 工具 `gotry_fact_gate` + persona （20） 红线 + `data/airline-airports.json` 映射快照；locked golden 2027 E2E（issue 审计值夹具）复现全部违例并抓出（run-all §39；smoke §16）。覆盖面缺口记 D-26。
- **npm 形态自定义端点修复（2026-08-30，issue #48，未随版本发布）**：rc.15 回拉实测暴露——bin/gotry-inner.js env 映射只做 `LLM_API_KEY → DEEPSEEK_API_KEY`，base 不映射，vendored dsh（llm-deepseek 读 `DEEPSEEK_BASE_URL`）把 OpenAI 兼容端点的 key 发往 DeepSeek 官方端点必然 401，README「OpenAI 兼容均可」承诺行为未跟上；同点补 `LLM_BASE_URL → DEEPSEEK_BASE_URL`（显式 DEEPSEEK_BASE_URL 优先，默认官方路径零改变）；两侧拼接语义核验一致（均为 `${base}/chat/completions`）；README 双语 + .env.example + bin help 同步配法。已知缺口由 issue #77 闭环（见下条）。
- **LLM_MODEL 接通 dsh 会话面（2026-08-30，issue #77，未随版本发布）**：`LLM_MODEL` 此前在 dsh 会话面零消费者（#48 修复 E2E 实测暴露：dsh 模型选择只来自 llm-deepseek `DEFAULT_MODELS` 或用户 ~/.dsh 设置）。修复双轨：① bin/gotry-inner.js 把 `LLM_MODEL` 映射为 `GOTRY_LLM_MODEL`，gotry-tools 插件（`capabilities/model-override.ts`）在 `agent/request` 瀑布 post-next 覆盖 provider/model（内存态零持久化，不改写用户 ~/.dsh；dsh settings 分层为 schema 默认 < composition 配置 < 用户层，web UI 选过模型后单靠 composition patch 压不过；瀑布先注册=最外层、post-next 最后生效，显式 .env 意图因此压过一切持久层选择；覆盖同时清掉继承的 reasoningEffort）；② 运行时 cordis patch 追加两条 by-id 覆盖（`agent-default-model` 默认模型 + `llm-deepseek` 目录单条目替换，不硬编码上游 DEFAULT_MODELS 防漂移）。默认路径保护：`LLM_MODEL` 不设时两轨均不动作。E2E：`ts/scripts/model-override-e2e.ts` mock 中转四场景全绿；smoke §17 单元回归。附查发现 vendored 仓内形态 Node 兼容窗口断裂，记 D-27（已清偿，存档 [`debt-archive.md`](debt-archive.zh-CN.md)）。
- **通道注册表与健康面（2026-09-03，issue #106/#107/#108，ADR-25）**：三个工具调用 issue 统一根因=「失败瞬间模型手里没有结构化的通道状态与改道指引」（flyai 429 跨轮盲重试/配额不可见/未配置的 calendar 会话中段才撞错）。落地：①`channel-registry.ts` 通道×意图×配额类×证据级单一数据来源，persona 路由卡与 `routing` 建议字段生成化；②`channel-health.ts` 会话瞬态态 + JSONL 持久事件面；③doctor v2=flyai 最近达限时间 + dsh-calendar 三态（D-9 默认不挂载；挂载与否由 setup 状态面 `~/.gotry/calendar.json` 决定，`npx @danceiny/gotry setup calendar` on/off——禁止 env 控制产品行为，founder 2026-09-03 纠偏）；④smoke 真跑命中真实 429 验证 needs-setup→routing 全链。设计全文 `design/tool-orchestration-design.md`；run-all §50。typed 参数契约迁移余量记 D-30（已清偿，存档 [`debt-archive.md`](debt-archive.zh-CN.md)）。
- **行为契约横评反哺（2026-09-04，issue #121/#122）**：`evaluation/persona-bench/` 同题横评（Kimi 13 轮/飞猪单轮，founder 拍板）暴露的两条访谈/呈现缺口进契约——①（1） 动机先行扩展「同行人到达链」：行程涉及同行人时必问从哪出发/是否已订/有无自己的时间窗，问明落 `gotry_companion_save`，到达账与预算分链核算（横评 G4：两家都把「跟女朋友见面」做成了单人行程）；②新增 （22） 到达账必达：红眼/凌晨起飞、或落地当天有硬安排的航段，必须显式给出当地到达时刻（含日期偏移）、时差、到达精力与前一晚落脚建议（横评 G7：飞猪「约8小时」与自家「02:00-06:00+1」同页矛盾）。不改工具面、不新增工具。
- **typed 参数契约迁移（2026-09-04，issue #112，D-30，五刀收官）**：①`gotry_flyai_search` 迁 dsh typed ParameterSchemaSpec（平铺七字段，`parameterSchemaSpecToJsonSchema` 投影模型可见，`validateArgs` 宿主权校验；畸形参数入口即结构化拒绝，ToolArgsError 经 guardToolExecute 保持 ADR-13 形状）；②`gotry_session_search`/`gotry_hotel_search`/`gotry_weather_check`（session 三意图无公共 required 字段，按设计 §4③ 保留 `interpretArgs` 容忍层）；③七个模型高频工具（session_login/doctor/artifacts_list/fact_gate/agent_reach/turn_handoff_list/artifacts_read）；④`query:` blob 清零（wish_pool/trip_log/flight_verify/anything/web/video/github；trip_log 的 evidence P0 红线进 schema）；⑤最后三个 payload 形态（feasibility_check/motivation_save/companion_save，evidence 类 P0 红线进嵌套 schema 由宿主权闸）。**23/23 注册工具全部 typed 契约化**；刀法总纲：有 required 字段的工具宿主权拒 blob，全可选工具保留容忍层。普通模型 canary 已跑（`ts/scripts/typed-contract-canary.ts`，MiniMax-M2.7 × 投影后 JSON Schema × 强制 tool_choice，10/10 一次成型；二级观察：无锚点卡时模型裸猜年份，由既有时间锚点卡+过去日期闸在真实会话纠正，非 D-30 缺陷），**D-30 全面清偿**。
- **工具描述首行生成 + doctor 宿主插件覆盖面（2026-09-04，issue #113，L1 残量收口）**：①`toolRoutingHeadline`（channel-registry）——检索工具描述统一前置注册表生成的「服务意图 × 当前通道顺位」卡，七个检索工具经 `routed()` 接线，模型选工具时与失败后拿到同一张表；注册表加行描述自动一致。②doctor 补齐 patch 分发面宿主插件两态（`dsh-map-tools`/`dsh-tool-ask-user`，此前只覆盖 calendar）：这类插件运行时解析失败即整块静默剔除，doctor 候选清单与 bin/gotry-inner.js 解析逻辑同口径。source/package 现由 `ts/dsh-runtime/vendor/dsh-map-tools/` 随包交付 MIT payload；因其 peer 要求 `rc.1` 与 alpha.3 closure 冲突，不再作为外部 npm 依赖。
- **启动一次性 doctor 摘要（2026-09-04，issue #114，L2）**：`npx @danceiny/gotry web`/headless 启动时（bin/gotry-inner.js 在 spawn dsh 前）以分离子进程后台跑只读体检（`gotry-bootstrap.js doctor --summary`）——有待处理项打一行 stderr，全 ok 静默零输出；零写盘、detached+unref 不阻塞启动、恒 exit 0、benchmark 面豁免。「初始化时可见」取代「会话中段撞错」；bootstrap-tests §10 钉行为。
- **解译器迁移收尾（2026-09-04，issue #115，D-23 收口）**：六渠道入效应注册表（`ANYTHING_SEARCH`/`WEB_READ`/`GITHUB_SEARCH`/`VIDEO_SUBTITLE`/`AGENT_REACH`/`SESSION_LOGIN`），**23 工具的全部外部依赖面收敛到 effect_interpreter.v1**（退避/熔断/declined 面统一，没有策略表行就没有效应）。策略行逐条拍板：ANYTHING 同 HBCLI 族（timeout 瞬时重试 1 次）；WEB_READ 同免费公共源族；GITHUB/VIDEO timeout 重试 1 次、not-installed 不重试；AGENT_REACH 反射桥透传永不重试不熔断（wrapper 不是 router，重试即放大上游配额消耗）；SESSION_LOGIN 同浏览器风控族。工具面照旧平铺，证据链逐源标注不变（effect-tests §12 四组断言）。
- **商店版扩展检测·自适应文案（2026-09-04，issue #117，D-24 清偿）**：needs-extension 文案按本地通道落位状态自适应（`needsExtensionSummary`/`localExtensionInstalled`）：本地 unpacked 已落位 → 保留完整双通道指引；未落位（商店版用户/未装）→ 自动跳过开发者模式/本地通道文案，只推商店一键装。桥失败摘要同函数同语义；doctor 扩展项明示「商店版用户可忽略本项」；静态常量 `NEEDS_EXTENSION_HINT` 退役为自适应函数。extension-tests §38 三条新断言。
- **事实闸覆盖面·酒店入闸 + 渲染原语（2026-09-04，issue #118，D-26 收口）**：①`HotelFact`（gotry_bookable_fact.v1 第三形态）——exact-date 酒店检索 hit/miss 落账（flyai-hotel/session:ctrip-hotel 两通道接线）；纪律与机/火同源：摸底不落账、needs-setup/error 传输失败永不落负事实、不落数字价（上游打码价保真，只记在架家数）。②`gotry_fact_gate` 酒店 claim 入闸——断言可住性的行按目的地+档期回溯酒店事实，无事实 fail-closed（`unverifiable_hotel_claim`），exact-date miss 在册却写有房 = `not_in_source`。③**渲染原语单向生成**：`renderFlightFact`/`renderHotelFact` 每条事实行内嵌 `<!-- fact:<fact_id> -->` 锚点——产物经原语渲染即自带溯源锚，闸侧锚点优先确定性回溯（启发式让位），手改/伪造锚点 = `fact_anchor_unknown` 直接违例。fact-gate-tests §10 八断言。余量：政策事实生产端（实时签证 API）仍记 D-26 外部依赖。
- **事实闸覆盖面·政策渲染锚点闭合 + 海关申报关键词（2026-09-10，issue #273，D-26 残余收口切片）**：①`renderPolicyFact` 行尾内嵌 `<!-- fact:<fact_id> -->` 锚点——政策渲染原语与机/火/酒店同源 typed-anchor；产物经原语生成即自带溯源锚，闸侧锚点确定性回溯，手改/伪造锚点 = `fact_anchor_unknown`；启发式 `POLICY_WORD` 仅覆盖手写/历史产物。②锚点行内容指纹仅核对 anchored policy 行的 `截至 YYYY-MM-DD` 与事实 `as_of`，改写或删除日期而保留 fact_id = `fact_anchor_unknown` ——与未知锚点同源 fail-closed；不宣称封闭 statement 全文或所有事实漂移。③`POLICY_WORD` 补「海关申报」（与「入境申报」同性质但被原 regex 漏掉）——手写政策行缺 as_of → `policy_without_as_of` 直接违例。fact-gate-tests §11 八断言（64 pass，red→green）。残余：policy statement 全文指纹不在本切片、M5 WriteGate 接线预订类写工具时复审（归 #136/#231）；12306 typed session 接入已由 §1/§9 所述 #355 切片覆盖，仍仅有确定性 fixture 边界。
- **事实闸覆盖面·政策锚点全字段内容指纹（2026-09-10，issue [#359](https://github.com/Danceiny/gotry/issues/359)，父 [#273](https://github.com/Danceiny/gotry/issues/273)，D-26 残余收口切片）**：`renderPolicyFact` 与注册闸共用单一权威构造器；**当政策行含有 `<!-- fact:` 锚点时**，必须严格等于 canonical 整行 + 单一 `<!-- fact:<id> -->`（subject/statement/source/fetched_at/query_id/as_of），任一改动 → `fact_anchor_unknown`，与未知锚点同源；多锚点、格式异常锚点、非 canonical 前/后置非空文本，或「借合法锚点写相反政策」的借用形态均 fail-closed。**不含** `<!-- fact:` 的政策行仍走 unanchored/free-text 启发式，不在本切片范围（交父 #273 / D-26）。`opts.itinerary.trip_start` 桥接到 `opts.tripStart`，与 `review_by` 同为合法复核提醒形态。父 #273 仍 open，本切片为 D-26 残余收口的进一步收口；确定性 synthetic / isolated evidence，不宣称 live policy、supplier、M5/M6 准入。
- **事实闸覆盖面·航班/酒店锚点字段指纹（2026-09-10，issue [#363](https://github.com/Danceiny/gotry/issues/363)，父 [#273](https://github.com/Danceiny/gotry/issues/273)，D-26 残余收口切片）**：渲染原语（`renderFlightFact`/`renderHotelFact`）与注册闸共用同一权威事实，启发式对**航班行从渲染文本重新抽取 flight_no token** 严格 == `fact.flight_no`（大写归一），**酒店行严格包含** `fact.destination` + `fact.check_in` + `fact.check_out`（精确子串）；任一不等 → `fact_anchor_unknown` fail-closed，与未知锚点同源。**字段指纹不替代整行严格比对**（根 contract 第 2 条）：flight_no/承运/时刻/route/价格的可比性、列车 canonical、政策 canonical、§4b 价格兼容形态（总预算/行李费/总计/显式票价/千分位/价待询/¥7xx/约价）、`price_contradicted` 与 `unverified_price_claim` 分类与排序均不被新指纹吞并，沿用既有判定原语。**借用/未知/重复锚点**仍由既有 `fact_anchor_unknown` 路径负责，字段指纹只补齐「保留 anchor/registry/fact_id 改写可见 flight_no/目的地/档期」的根反例 fail-closed。`gotry_fact_gate` 注册闸执行面无新增路径，沿用既有 `loadFactRegistry` + `gateArtifact`。事实日志走真实 append-only JSONL（`appendFacts`）、隔离临时 `stateRoot` 装载注册定义 → 捕获真实 `gotry_fact_gate.execute()`，无新增执行面；事实根反例=伪造 `UO999`/伪造 destination/伪造 date 等。残余：反向抽取仍为正则启发式；价格容忍度、汇率/多币种策略与 M5 WriteGate 按既有债务复审；父 #273 残余债务保留；不宣称 live supplier、live 12306、live policy 或 M5/M6 准入。

- **事实闸覆盖面·机/火行内价格矛盾（2026-09-10，issue [#300](https://github.com/Danceiny/gotry/issues/300)，父 [#273](https://github.com/Danceiny/gotry/issues/273)）**：exact-date 回溯成功后，flight/train 共享 gate 原语仅在 canonical fare 字段或明确票价标签字段内，对照对应航班/车次事实的完整 `¥NNN`/`CNY NNN` 可比较 CNY 硬价；分隔后的带非票价文字标签金额不参与，裸/未归属或畸形 fare money 产生 `unverified_price_claim` 并 blocked。数值不一致产生 `price_contradicted` 并 blocked；源事实缺价、不支持的硬币种、或无锚点且价格超出启发式 120 字窗口产生 `unverified_price_claim` 并 blocked；非数字/起价/约价不比较，不猜换算，酒店 `priceRaw` 不参与。价格容忍度、汇率/多币种策略仍待 owner/founder 拍板；不关闭 D-26 全部残余。
- **事实闸覆盖面·非关键词住宿 category + 政策词有限并集（2026-09-10，issues [#301](https://github.com/Danceiny/gotry/issues/301)/[#302](https://github.com/Danceiny/gotry/issues/302)，父 #273，D-26 残余收口）**：手写/历史产物的启发式扩词：住宿类增 5 个非关键词 category（精品酒店沿用现有 `酒店` token）+ lodging heading（ATX 1–6）下无住宿类 token 的可住断言也升为 hotel claim，同级/更高级 non-lodging heading 退出上下文、更深 heading 继承；政策类增 13 词有限并集，缺 as_of 直读 fail-closed。Latin token 大小写不敏感但词边界有界（REVUS ≠ EVUS）；窄词表边界——不做 NLP/同义词/任意政策词表扩展。fact-gate-tests §12/§13 覆盖；`run-all §39` 描述同步。确定性 read-side fixture 覆盖，不宣称实时政策正确性、供应商就绪或 M5/M6 准入。
- **指标面板第一切片（2026-09-05，issue #138，ADR-11 质量层工程面）**：`ts/scripts/build-metrics-report.ts` 只读聚合既有落盘侧车（不新增数据源）——事实闸 verdict 分布与 blocked 率/通道健康 down·cooldown（30 天窗）/事故面（7 天窗）/桥延迟百分位与超预算计数（>500ms=复审触发锚点）/账本与 doctor 报告存在性→单一 markdown；坏行跳过同侧车纪律，空根成型，collect 全程零写入；评测三层运行结果仍由 run-all-tests.sh/CI 承载，v1 不重跑评测。持续观测/可视化面留后续切片（metrics-report-tests §1-6 全绿，run-all §51）
- **外部事件接缝第 1 段（2026-09-07，issue #82 本地生产者）**：`ts/scripts/channel-probe.ts` 探针 tick 落地 seam 设计 §6①——只读探测（hbcli whoami/open-meteo/opensky；session 系 skip，flyai 默认不探防空额度），异常写 `down`、恢复写 `'ok'`（latest-wins 超越 down，消费方 `state !== 'down'` 判健康）；channel-health 增 `ChannelEventState`（'ok' 仅持久面），doctor flyai 达限注释与 metrics 通道面均按超越口径兼容；探测结果→事件为纯函数锚点（channel-probe-tests 5/5，run-all §52）。同日第 2 段：愿望池消费——`conditions.channels` 可选条件 + 召回时命名通道处于 down 即否证成行条件（wish-channel-gate-tests 5/5，run-all §53；健康面缺席=行为与旧版一致）。远程回调面（world2agent 桥）仍待 D-31 拍板，拍板包已贴 issue #82
- **persona 域边界表层规则（2026-09-07，issue #192 rc18 用户实修）**：rc18 真实会话中模型把 `gotry_motivation_save` 当宿主 skill 传给 skill 加载器（dsh skill 名合法域 `^[a-z0-9]+(-[a-z0-9]+)*$`，下划线必抛 invalid skill name 硬错误）——persona （16） 补表层规则：gotry 能力一律是工具调用（gotry_ 前缀），绝不进 skill 加载器，skill 调用 invalid/unknown 即改回 tool call；契约仍 22 条（（16） 内部澄清，无新条目），persona-surface-guard-tests 3/3 钉回归（run-all §54）
- **澄清卡示例过锚点卡（2026-09-08，issue #2 rc18 复发实修）**：founder 截图实证——澄清卡把**已过的** 2026 春节/清明/五一当「这 5 天 IRW 余额想用的时候」的候选示例；原 （8） 修复只覆盖推荐链（时间锚点层+年内排除，e2e §11），ask_user_question 卡片的示例枚举是模型自由生成，绕过了锚点卡。persona （8） 内部澄清补一句：澄清卡/访谈/选项里向用户列出的候选时段示例（节日/周末/月份）同样只取今天之后的，已过的节日不进示例枚举；契约仍 22 条（无新条目），persona-surface-guard-tests 4/4 钉回归（run-all §54）。锚点卡本体已正确（2026 视角春节自动取 2027-02-06），缺陷纯在卡片生成未消费锚点。
- **子任务等待纪律（2026-09-08，issue #194 B-轨道）**：rc19 npm 真实会话（founder 截图+session zip 实证）——continuable 子代理 spawn 回执只给 durable id（uuid），模型按 jobs 纪律提示把它当 job id 调 `job_output`，`jobs-local expect()` 裸抛 `unknown job` isError 直达用户。根因两侧：注册侧 dsh-tool-subagent continuable 分支不进 jobs registry（仅 one-shot 后台注册 `subagent-N`）；查询侧对未知 id 无可恢复指引。B-轨道修复：persona 新增 （23） 子任务等待纪律——子代理回执 id 不是 job id，禁对子代理调 job_output/job_kill，完成通知自动送达、追加输入用 send_message；契约 22→23 条。A-轨道（上游 deepseek-harness Discussions 报告，英文草稿已备于 #194 决策包评注）涉对外发布，留 founder 确认。persona-surface-guard-tests 5/5 钉回归（run-all §54）。
- **#194 A-轨道 GoTry 缓解（2026-09-10）**：typed `tools/pre-execute` direct-child guard 在 dsh jobs registry 前识别 continuable durable id，返回 completion notice/`list_agents`/`send_message` 恢复指引；非 owner、one-shot、未命中保留原生 jobs 错误。上游 dsh unknown-id 通用 recoverable contract 仍开放，不改 vendor、不关闭 issue。
- **行为契约瘦身（2026-09-11，M4 人格校准线；founder 指令「profile 提示词太长、窄域说辞不具启发性」）**：`cordis.gotry-patch.yml` 行为契约 23→13 条（折叠文本 4095→2637 字符，−36%）——零信息损失去重：原 （15） 渠道 setup→`gotry_agent_reach` 描述（原文已在）、原 （19） 会话授权/登录细则→`gotry_session_search`/`gotry_session_login` 描述（原文已在）、原 （20） 可下单事实细则（联程保护/FD·VZ 落点/政策表述）→`gotry_fact_gate` 描述（原文已在）；原 （2）（9）（13）（14） 并入时间/事实/检索条。persona 只留跨场景行为契约；回归锚=persona-surface-guard-tests 6/6 改锚（新增四个动态变量注入面与「永不宣称工具预算耗尽」两锚；rc18 表层规则/#2 澄清卡/#194 子任务三事故锚全保留）。run-all §54；随下个 npm 版本分发。

- **安装链三修（2026-09-08，rc.19 `npx doctor --fix` 实测三 issue 收口）**：①sidebar 安装误报——pnpm ≥10.5 默认不执行依赖构建脚本，严格态（pnpm 11）下 `ERR_PNPM_IGNORED_BUILDS` exit 1 但 167 包已完整落盘；`setupSidebar` 改为**按落盘状态判成功**（与 doctor 检查同口径，profile package.json 为唯一事实面），对 dsh plugin 调用附 `npm_config_strict_dep_builds=false` 单次降级 + node-pty 构建被跳过的 approve-builds 指引，不再以 dsh→pnpm 两层转手的 exit code 误报「补装失败」。②map-tools npm 布局真缺——2026-09-04 遗留的「补依赖渠道拍板」落地为**随包 vendor 分发**（`ts/dsh-runtime/vendor/dsh-map-tools/` 进 files[]，inner 解析链 vendor 优先；依赖形态被上游否决：其 peerDependencies 要求 `dsh-settings/dsh-tools >=0.1.2-rc.1` 而运行时锁定 `0.1.2-alpha.3`（semver alpha<rc），npm 严格 peer 解析 ERESOLVE、optionalDependencies 亦不豁免——硬依赖会弄坏 npx 主安装路径）。③ask-user 误报——npm/npx 提升布局下依赖落在包外同级提升位，doctor 两面的 existsSync 硬编码候选全 miss，改与 inner 同口径 createRequire 解析链（dsh 上下文优先→包根上下文→静态候选）。顺带清偿 bin/gotry-inner.js help 文本中已提交的合并冲突标记。doctor-tests §5b/5c + bootstrap-tests §11（run-all §7c/§15b）钉回归。
- **CI 双层修复（2026-09-08，#208/#202；main 自 #197 起全红、rc.19 系带病发布）**：①`Install ts dependencies` 红根因 = runner npm 升级后裸 `npm ci` 强制校验 peer；#208 先以 `--legacy-peer-deps` 恢复流水线并移除 dsh-map-tools 冗余依赖，#202 再把 14 个递归 DSH peer 全部精确钉在 `0.1.2-alpha.3`，CI 与 CONTRIBUTING 回归裸 `npm ci`，lock 全量 resolved 指向 registry.npmjs.org。②typecheck 五连红（turn-deadline 的 session 事件）根因 = 类型面隐性依赖 peer 意外物化：`session/event`/`session/disposed` 声明在 dsh-session 的 cordis Events augmentation 里，pnpm 隔离布局下 root 侧同名包的 augmentation 合并进的是另一个 cordis 实例——显式 `import type` + `dsh-session@0.1.2-alpha.3` 进 ts dependencies，完整 alpha.3 closure 阻止 rc.1 混版本。
- **账本 tenant scope 实装修复（2026-09-08，issue #224）**：独立审计复现 tenant-a/tenant-b 写愿望后 raw events 均落 `local`，`readEvents` 互看，目标租户 rebuild 清空，`wish.updated` fold 跨租户同 id 串读。修复为 `insertEvent` 写当前 tenant、`readEvents`/fold/rebuild 带 tenant 条件、legacy/v1 迁移只归 `local`；新增非 local owner、同 id/idem_key、交错 update、跨进程 reopen、A rebuild 不影响 B/local、重复 rebuild、booking saga audit owner 断言（run-all §28/§36）。历史已误写成 `local` 的非 local 事件不可无证据自动修复，边界见 §8.16。
- **state-cli 租户参数与未隔离命令边界（2026-09-08，issue #226/#241）**：账本 CLI 的 `rootOf`/`tenantOf`/业务 positional 串位收敛为一次集中解析；`--state-root`/`--tenant`/`--limit` 可前后等价，未知/重复/缺值/非法 numeric（含 `.5`/`+.5`）在触碰 state root 前拒绝。`tick`/`export`/`whatif` 明确 local-only：非 local 不再可能调用默认 local 异步结算、覆盖共享 legacy 文件名，或把整库 snapshot 冒充租户导出；`--tenant` 仍只是账本 scope，不是认证授权。#241/#243 已入 main并关闭。
- **gotry-backend 统一服务骨架（2026-09-10，founder 口径「只允许一个 gotry 包装出来的服务」）**：`ts/src/backend/kernel.ts` 内核（一个 HTTP 服务面 + 模块精确路由表；鉴权/探活归模块自持，内核只分发/404/异常隔离）+ 两个平级模块——booking-copilot（booking surface 能力，`server.ts` 摘出 `bookingCopilotTrafficHandler` 供独立部署与模块挂载两条路径逐字复用，server proof 全绿）与 session-search（`POST /v1/session/search|GET /v1/session/status|POST /v1/session/login/open`，hotel-be 聚合工作台 M0 的会话检索面，票据 cookie 名级、值零过手）。入口 `ts/src/gotry-backend.ts` + `bin/gotry-backend.js`；端口 `GOTRY_BACKEND_PORT > GOTRY_BOOKING_COPILOT_PORT > 3082`（路由合同不变，hotel-be BFF 零改动）。gotry-a2a 定位=本服务的 A2A 协议端口（迁移归部署收敛批次）；kernel-tests 8/8 钉回归。
- **Dida 供应商门户会话适配器 + 桥 capability 路由（2026-09-09，hotel-be portal integration 迁移线）**：①`adapters/dida-portal.ts` 接入 session-search 扩展/CDP 双车道（工具面 `gotry_session_search kind=dida`）——entry=`portal.dida.com/hotel/find`，networkHints=portal-webapi `HotelPriceAPI/SearchRealTime|SearchMonitor`（2026-07 hotel-be 抓包口径），解析=SearchRealTime 信封逐计划展平（`RoomTypeList`∪`RoomList` 合并，`referenceNo` 保留给服务端预订链），票据名 `CN_M_DidaTravel` 名字级；登录经 hotel-be portal 自动填充跳板在 dida 官网由人完成，账密永不过 gotry。②`extension-bridge.ts` `/jobs` 轮询体的 `capabilities` 从「上报即弃」升级为**路由依据**——同机多 Chrome/多版本扩展下旧版扩展会领走新站点 cookie-names job 并以 `ok:true names:[]` 毒答（把未登录伪装成普查结论，live E2E 实证）；站点 job 现只派给声明该站点的轮询者，轮询体缺 capabilities 视为 match-all 向前兼容（extension-tests §capability 路由钉回归）。③live E2E 驱动 `scripts/session-dida-live-e2e.ts` + SW/cookie 诊断探针（`dida-sw-probe.ts`/`dida-cookie-probe.ts`，只读 cookie 名）随批落地；§38 防漂移断言随 manifest（`*.dida.com` host_permissions + 双 world content_scripts）同步。**扩展商店版需一次更新提审**（host_permissions 变更），节奏归 founder。已知缺陷入 §10 D-37。#308 forward fix 另锁 query-first 站点选择、flight 缺省与 train 不绕过授权闸。
- **web 启动交互式 onboarding（2026-09-09，issue #258/#267，M4 UX proof；#267 = #266 合并后的 post-merge 加固）**：`npx @danceiny/gotry web` 启动前的显式可选能力配置（每次符合条件的启动评估一次、至多问一次，无跨启动持久确认——不写「已问过」标记），复用 `doctor --fix` 的幂等安装器（setupHbcli/setupReach/setupSidebar，不建第二套）。仅交互式 TTY + 有可自动安装缺项时问一次；y → 安装并给三态结果（installed/needs-user-action/unavailable，各带具体原因）；n → 立即继续 web。无可自动安装项但有需用户操作/不可用缺项时（如 win32 平台不支持自动安装），渲染分类计划与具体原因、不 prompt 不安装，标记 `reported` 让 inner 抑制重复的 detached doctor 摘要。CI/benchmark/非 TTY/全健康/`GOTRY_SETUP_SKIP=1`/`GOTRY_ONBOARDING_SKIP=1`/`--no-onboarding` 均零 prompt 零安装仍启 web；永不 postinstall 或后台任务里安装。`installerEnabled` 接受注入 env，classifyDoctorGap/buildOnboardingPlan/runOnboarding 全链不依赖 ambient `GOTRY_SETUP_*`。**#267 加固**：web-onboarding 子调用改 awaited POSIX process-group `spawn`（JS 可服务 SIGINT/SIGTERM，信号路径清 result+patch 目录），bootstrap installer `run()` 同步进 bounded process-group lifecycle；outer grace 显式覆盖 installer TERM+SIGKILL budget。结果通道改 0700 `mkdtemp` + `0600/wx` 排他写入；落地 `bin/gotry-{inner,bootstrap}.js` `orchestrateWebLaunch`/`runOnboarding`/`renderClassifiedPlan`；bootstrap-tests §12/§20/§21/§22/§23 确定性单测——§21 用临时安装包 fixture + 假 dsh + fixture-local TTY preload 跨过**真实** inner→bootstrap onboarding→dsh-web 进程边界（观察到 prompt 恰好一次），§21c prompt-wait SIGTERM 清理，§21f accepted-install parent SIGTERM 清 stubborn installer，§21g accepted-install onboarding timeout 清 installer 并继续 web。**M4 UX 质量线，不计入 #20 真实 `observed_private` cohort Exit**（D-34 清偿）。
- **DSH runtime closure 迁移 0.1.5-alpha.1（2026-09-09，issue #268）**：root/ts 双 manifest + npm/pnpm 双锁从 `0.1.2-alpha.3`（216 包闭包）精确迁移到 `0.1.5-alpha.1`（230 包闭包：15 新增 sentinel + 移除 `dsh-tool-subagent-report`）。全部 230 个 `@deepseek-ai/dsh*` 包钉死精确版本——拒绝 `^0.1.5-alpha.1` 会匹配 `0.1.5-alpha.2` 的 semver 预发布漂移；CI `npm ci --strict-peer-deps` / pnpm `--strict-peer-dependencies` 显式严格，不依赖本地配置。run-all §23a-§23e 五个确定性证明（subprocess-local：仅公共 API 挂载 Cordis/provider + 真实活跃父进程 spawn 非分离子进程 + 公共 terminate/waitForExit 进程组信号终止整组 → 后代 PID 消失 + 真实 spawnTerminal 跨平台验证 PTY 输出 'pty-line' 与 exitCode=0 + Darwin 预构建下额外断言 node-pty spawn-helper 0755 模式，非 Darwin 平台 helper 不适用、报告 platform-pty 事实而不伪造 stat 不存在的 helper；session V3：隔离临时目录文件字节——V2 编解码器编码 → JSONL 写盘 → catalog 读盘分类 migration-required → V3 恢复 → 独立 V3 继任者写盘 → validation：current 完全解码 → 迁移后源字节比较不变；http-proxy：真实 fetch 回环 SSE=200 + 中毒命中=0 + finally await disposer + await 两服务器关闭 + 全局路由恢复直接；target-closure：root 230 npm/pnpm/importer + ts 三层 230 lock/installed，createRequire 解析拒绝嵌套/混合版本）。设置行为不变；历史 0.1.2-alpha.3 证据在 §9/roadmap/stage1/release-notes 旧条目中保留，不批量替换。此项尚未发布 tag 或 npm 版本；这些确定性证明不构成 M5/M6 准入。
- **DSH alpha.1 公开契约兼容注（2026-09-09，issue #290）**：在 230 包闭包之上修复目标 public 契约差异。①system-prompt Config：`dsh-system-prompt` 公开/读取 `personaPrefix` 与 `personaSuffix`，legacy `persona:` 键不投影；`bin/gotry-inner.js` `projectBenchmarkPatch` 与 `projectBenchmarkSystemPrompt`、`cordis.gotry-patch.yml` 的 `system-prompt` 块、`ts/src/booking-surface/dsh-planner.ts` 的 booking-copilot 内嵌 planner 投射均改写 `personaPrefix: >-`（embedded booking persona 文本）；e2e 与 proof 单测断言 captured benchmark-tool planner 请求携带每个稳定句 exactly once（title 请求在另一 contract 之外）。②`SubprocessHandle` 公开契约：目标 `0.1.5-alpha.1` SubprocessHandle 不暴露 `pid`，仅含 `collected`/`done`/`terminate?`/`waitForExit`；bridge call handler 分阶段归类——`timeout` 优先 → rejected start/provider `done` 路径归 `spawn_failed` → resolved nonzero exitCode 与 post-start `collected.readFrom` 失败归 `runner_failed`；bridge.ts 接口移除旧 `pid` 哨兵，测试 fakeHandle 同步去掉 `pid: -1` 字段、描述改为「public done rejection is classified as spawn/provider failure」并新增「collected output reading failure after a resolved done is runner_failed， not spawn_failed」反例。Secret/tool 隔离与 #286 budget/room/date planner 行为保留；不宣称 release/publication、M5/M6 entry、Windows 执行或真实 supplier/HotelByte 准入。
- **doctor 自助修复（2026-09-10，issue #284，M4 UX 工程面；M4 不计 Exit）**：`gotry_doctor` 显式 `action: 'repair'` 按稳定 item id 只选择 auto-repairable 缺项（agent-reach / hbcli-missing / sidebar），浏览器商店、凭证/API key、profile、包重装与 Node 升级保持 user-action/unavailable。生产执行懒加载 `bin/gotry-bootstrap.js` 并调用既有 `buildOnboardingPlan`/`runOnboardingFix`，因此沿用 `setupHbcli`/`setupReach`/`setupSidebar` 的幂等、超时与进程清理边界。scope-keyed 审批闸在同 agent+同 scope 复用批准，不同 scope 重问，rejected/cancelled 本会话记忆且零执行，unavailable 不缓存。工具结果完整返回 diagnosis → selected/skipped plan → approval → repairs → recheck；安装器退出成功但复检仍坏即 `failed` 并给 `nextAction`，侧栏报告写复检态。`doctor-tests` §7–§13 以隔离 stateRoot、fixture installer 与实际工具注册/审批/真实 bootstrap 编排跨过工具边界，不触碰真实安装和共享状态。默认 `diagnose` 路径保持只读兼容。（D-38 清偿）
- **Issue #2 未来年度规划窗口（2026-09-10）**：命名年份的未来意图在 `time-anchor.ts` 派生本轮 `referenceDate`；注册工具 `gotry_feasibility_check` 对任何带日期候选默认施加宿主时钟 future 下界，显式 `planning.intent=future` 的请求年份再限制至年末。已结束年份不自动滚年，预期拒绝返回结构化校验结果而不进入 incident；完全 dateless 输入保持旧可行性计算，历史/回测必须明确 `historical` 模式。loop 继续只对显式命名年份规划应用窗口，否定过去推荐和多年份歧义不授予 historical 旁路。`time-eval-tests.ts` §6 与 `smoke.ts` 的 registered execute fixture 分别验证规划循环和实际 registered execute；参考日来自注入/宿主时钟，证据为隔离 fixture，不构成供应商或真实业务准入。
- **严格重复 tool-call 参数恢复（2026-09-10，PR #327 修订）**：嵌入式 planner 的 JSON 参数恢复只接受至少两个完整、仅空白分隔且深结构相等的顶层对象；所有输入必须被消费，冲突/不完整/带前后垃圾/非对象序列/单个非法对象均拒绝。公共路径 proof 覆盖字符串花括号与转义；这是确定性离线 fixture 证据，不是 provider reliability、HotelByte UAT 或 M3/M4 业务准入。

- **安全 dispatch 日志（#329,2026-09-10）**：同步 HTTP 409 turn-dispatch catch 使用闭合 reason vocabulary，只对完整固定 token 做区分，未知值与带 suffix 的 token 统一为 `UNCLASSIFIED`；stderr 结构化行只含现有 typed `code` 与 `reason`，HTTP typed response/status 不变。公共 HTTP 请求与子进程 stderr 字节 proof 为确定性离线证据，不替代真实 provider、HotelByte UAT 或 M3/M4/M5/M6 准入。
- **DSH runtime closure 升级 0.1.5-rc.1（2026-09-11）**：root/ts 双 manifest + npm/pnpm 双锁从精确 `0.1.5-alpha.1`（230 包闭包）升级到精确 `0.1.5-rc.1`（232 包闭包：新增 `dsh-chunked-list` / `dsh-client-ui-sidebar-documentpreview` / `dsh-tool-present`；移除 `dsh-client-ui-sidebar-textpreview`）。`REQUIRED_BENCHMARK_DSH_VERSION` 与 `REQUIRED_DSH_RUNTIME_PACKAGE_COUNT` 已同步；publish preverify 仍对漏钉/混版/range fail-closed。GitHub `dsh-v0.1.5-rc.2` 待 npm 全家族发齐后再跟。本切片不宣称 GoTry npm 发版/打 tag。

- **Issue #343 时区演进**：flight-pack v2 以显式 IANA zone 与 local date 生成 UTC instant，由确定性模型使用 UTC instant 计算耗时并以已知 instant 投影 home-zone work window；未知 zone 与 DST gap/overlap 在边界拒收。dsh/mock adapter 保留 pack `homeZone`，profile 只提供 schedule，explicit vacation 移除 work-window restriction，numeric v1 保持兼容；该离线确定性契约不代表 live schedules/prices/availability/inventory。
- **Issue #338 持久默认出发地（2026-09-10）**：写入 patch 接受 `homeCity` 与 optional `homeCityEvidence`（单条非空 evidence 可省略，多条须显式 exact 绑定），事件投影保存 `homeCityPreference { value, evidence, updated_at }`；`{{motivation_brief}}` 只把完整 typed preference 读回为软上下文，当轮显式出发地优先。typed 缺失/畸形、evidence 不在 pool 或非法时间戳均按 missing 要求明确出发地。

### 外部 benchmark 泛化（Round 1–12，Discussion #78，official score 仍为空）

> 工程合同全文见 `evaluation/benchmark-environment-bridge.md`；此处只留逐轮事实摘记。共同结论：official scores 全为 null，不声称 uplift 或 external benchmark closure。

- **Round 1（ChinaTravel canary 反馈）**：冻结 grounding-v3 canary 首例终态通过，第二例 planner 重复工具调用超 300s——不生成 5-query 聚合。GoTry 侧收敛边界下沉到 `tools/execute`（16 软提示/18 次上限/第 19 次结构化拒绝 + 下一步 text-only）。Round 1 treatment-attested installed GoTry 已实际运行；exact DeepSeek 因 environment unavailable/schema-invalid 得 0，GLM 为 300s timeout。run-all §45 覆盖 Cordis 集成与打包二进制离线 E2E；CI 对当前 SHA 打包在隔离 pnpm consumer 中重放同一链路。**后续（ADR-24 v2）**：真实轨迹显示任何「到点杀 turn」形态都会复现同一失败，最终形态=路由 + wall-clock 双出口（§8.24），handoff 收集闭环同日补全。
- **Round 2（environment bridge）**：default-off、owner-local config 与 host-enforced isolation contract 落地（固定 argv/allowlist、最小 runner 环境、递归 no-oracle 键拒绝、per-tool `allowed_output_keys` 正向键合同、cold-start + native definition-only、quarantine 至 disposal）。唯一冻结 treatment 终态但只计 diagnostic-only：provider preflight PASS，planner exit 0 / 30.826s，runner exit 3，scores 均 null——agent 只叙述想走 CLI，没有 structured bridge call 与 tagged JSON，evaluator 未执行（[evidence](https://github.com/Danceiny/gotry/discussions/78#discussioncomment-18215707)）。
- **Round 3（agent conformance）**：新增 provider-neutral conformance 层（prompt 内 CLI/shell/Python 操作映射为唯一 native bridge 的 `query.action=call`；配对成功 result 后才接受单一 tagged JSON object 终态；最多一次固定纠偏，格式纠偏不再派发 bridge；parent 有界捕获 stdout 并二次验收）。新 frozen treatment provider preflight 通过、runner 只派发一次，但 planner/runner exit 1、parent 终态 0 字节、evaluator 未进入、scores null——缺口定位到 benchmark child/plugin startup。
- **Round 4（startup composition isolation）**：config 验证后、任何 optional host plugin 解析前，CLI 把顶层 insert 投影为唯一 `gotry-tools`；insert 块/plugin name/config-path 锚点唯一性检查，漂移即 relay 前 fail-closed；default-off 组合不变。Treatment（SHA `5ebddb2`，重写后 `0e93eae`）primary preflight=pass，planner/runner 均 30.968s exit 1、释放 0 字节、scores null；产品 gate 用 Node v24.20.0 而 treatment 用 v26.3.0，仅 diagnostic-only。GitHub Node 22/24 §48 另暴露 source default-off 30s lifecycle hang。
- **Round 5（headless lifecycle containment + runtime resolution）**：移除 timer/keepalive preload、锁定 DSH runtime closure 为 `0.1.2-alpha.3`、保留 `ts/dsh-runtime/gotry-state/` 状态连续性、benchmark/package 调用目录隔离、benchmark-only 结构化诊断 pipe（allowlisted redacted reason codes），stdout 继续 fail-closed。Frozen treatment（SHA `752e54c`，重写后 `7d6f8a9`）140.715s 后以 `child_nonzero_exit`、0 terminal bytes、scores null 停止。运行时不变量：package.json、package-lock 与 root pnpm importer 的 DSH 名称集合必须同为 216 个精确直接依赖；publish preverify 对漏钉/混版/range 声明 fail-closed；benchmark spawn 前验证实际 DSH 版本；Node 下界统一 22.15。
- **Round 6（structured terminal diagnostics）**：benchmark child 最终 `turn/end.reason` 映射为闭合脱敏的粗粒度诊断枚举，per-session 单写仲裁保证 bridge/conformance 专项原因优先；只读结构化 `kind`、allowlisted `code` 与有限 HTTP `status`，不碰 message/stderr/路径/prompt/凭证。Treatment（SHA `c61600b`，重写后 `ea678f8`；ChinaTravel `..._00001`，`deepseek-v4-flash`）49.546s 后稳定报告 `child_runtime_error`，0 terminal bytes，scores null，leakage 与凭证/端点扫描均为 0——只消除归因歧义，不产生 uplift。
- **Round 7（minimal kernel）**：benchmark opt-in 仅保留 tool budget、model override、唯一 bridge、tool isolation/conformance；产品 prompt variables/process guards/consent/普通工具均不装。CLI 对 system-prompt 做稳定 task-agnostic persona 投影，root patch 仅含 canonical `- insert:` 与 `- id: system-prompt` 各一，变体 fail-closed。Frozen treatment（SHA `edb9392896625adbb48abae4a2ecf968dbfc0349`；UID `e20241028160248698752`，easy，`deepseek-v4-flash`）preflight pass、80.463s 后 runner exit 1、terminal 0 bytes/invalid、scores null；白名单归因 `child_bridge_runner_failed`。下一轮聚焦 generic bridge tool schema 与可恢复 domain-error contract。
- **Round 8（generic flat bridge action + protocol failure inventory）**：`gotry_benchmark_environment` 参数面 query blob → typed 三字段（`action` 枚举 tools/call/errors required + `tool` + `arguments` additionalProperties:true），`BRIDGE_ERROR_CONTRACT` 封闭的 bridge protocol/infrastructure failure 词表（10 码 × recoverable/remedy）经 `action=errors` 可拉取；conformance 契约面同刀法平铺。栈式经 #148→#151 合入（feat 线）。**Round 9（治理面预算与输出上限，#100/#102）**：owner-local 治理环境按 registry 钉定修订自建（ChinaTravel `b071db25` + sandbox en 数据 + 官方 `agent_env` 适配器）后实测钉死两处基础设施真因——① LLM_MODEL 显式覆盖到中转模型时 dsh 按未知模型 256K 预算发 `max_tokens`，MiniMax（输出上限 196608）2013 拒绝，即 Rounds 2-7 `child_nonzero_exit/0 terminal bytes` 的真实根因之一：`bin/gotry-inner.js` 的 llm-deepseek 目录条目现支持 `LLM_MAX_TOKENS` 注入 `maxTokens` 元数据（dsh-llm-deepseek `defaultMaxTokens` 官方通道）；② 治理面钉死预算 60/120s 对官方任务形态（单查询 300s）过紧：`GOTRY_BENCHMARK_SOFT_MS/HARD_MS` 按 run 显式设定，缺省不变、非法值/区间倒置启动即抛（钉死可复现语义不变）。修复后治疗首次全链路存活（22 请求/约 20 次桥调用/65536 上限生效，MiniMax-M2.7 真实探索 ChinaTravel 工具面），余量为预算内收敛（诊断实测：当代推理模型即便被明令禁止仍以 `<think>` 前缀输出，严格终态门对其结构性失效——终态验收现于验证前剥离配对推理块，严格性本体不变，bridge-tests 断言锁死），不构成 external benchmark closure。
- **Round 10（per-tool typed result contract hardening； real `glm-5.3-flash` treatment， main `c843fae`）**：在 Round 8 的单一 flat `tools|call|errors` 协议上，将 owner-local v3 descriptor 的 closed/bounded `input_schema` 同源投影为每工具独立 `call` 分支并在执行前复用；`output_keys` 强制非空，`domain_outcomes` 限定为 finite exact tuple。adapter 只接受 exact `gotry_benchmark_tool_result_v1`：concrete result 的每个 primitive leaf 必须位于声明键下，domain outcome 必须 exit 0，非零退出仍是 infrastructure failure；conformance 以最新 bridge response 为 tagged terminal 时序下界，domain 后失败拒绝、后续 concrete result 可恢复。真实 treatment 暴露 provider/model visibility failure：模型面对顶层 `oneOf` wire schema 未形成可见、可用的工具调用，产生 57 次空 `{}` 调用；没有 countable score。该诊断不改 provider、scorer、evaluator 或默认产品路径；冻结 treatment 与 score 只能由后续独立证据给出。
- **Round 11（flat model-facing bridge wire）**：仅收窄模型可见的 benchmark bridge wire：请求为 flat object，`action` 为 `tools|call|errors` 枚举，`tool` 为从冻结 descriptor 派生的工具名枚举，`arguments` 为 generic object。执行时仍对所选 descriptor 的 exact frozen `input_schema` 做校验；descriptor、adapter result/failure contract、provider/scorer/evaluator、默认产品路径与评分口径均不变。本轮不提供 score/uplift 证据。
- **Round 12（exact terminal schema projection，#215）**：Round 11 冻结治疗暴露新瓶颈——GoTry 只说「输出一个 JSON object」，模型自加 root 键、把 itinerary 行写成直接 activity，official scorer 按约定拒绝 22 处未运行。结构半场收口（#217 合入）：bridge config v4 携带无数据值 closed `body_schema`（结构关键字白名单，enum/const/example/default 与组合形一律拒绝）；同一份结构合同以确定性 outline 投影进 system prompt 与唯一一次 terminal 纠正；接受的终态 body 逐节点 fail-closed 校验——多 root 键/缺 day·activities/错类型/嵌套多余键原样拒绝，零 autofix；v3 及更旧 config fail-closed。source 测试+source/packaged E2E 覆盖合法 ChinaTravel-like 层级、五类拒绝与单一来源投影；冻结重跑（同 case/同 model/同预算，仅合法终态进 pinned official scorer）为剩余段，本 SHA 未跑，不声称 treatment 或 uplift。工程合同 `evaluation/benchmark-environment-bridge.md` Round 12 段。

## 10. 债务清单（引擎细节工作只能来自这里）

> 债务只能在本表诞生，不许只活在代码注释里（§11 M-exit 清单第 3 条）。
> **§10.1 = 仍然开着的债**（要接的活从这里来）；已清偿债务移入 [`debt-archive.md`](debt-archive.zh-CN.md) 存档，不在本文保留。

本轮已清偿的 #279 携程机票 malformed 响应闸留在 [`debt-archive.md`](debt-archive.zh-CN.md)，完整行为与证据边界见 §9；不改变现有 D-36 酒店日期闸与 D-37 Dida/CfT cookie debt 编号。
Issue #2 的日期下界与命名年份窗口现由时间锚点与 planner/registered tool 入口确定性执行：带日期候选默认 future floor，显式 future 年份叠加上界，校验拒绝为结构化结果；完全 dateless 与显式 historical 语义保持不变。不新增并行时间引擎或 Python 运行时，因此不作为未清偿债务重复登记。

PR #327 修订的严格重复 tool-call 参数恢复属于 planner 解析边界收敛，不新增开放债务；其公共路径 proof 仍只覆盖离线 fixture，不替代真实 provider、HotelByte UAT 或里程碑准入证据。

issue #329 的 dispatch 日志收敛属于安全边界加固，不新增开放债务；公共 HTTP/子进程 stderr proof 只证明 deterministic offline contract，不替代真实 provider、HotelByte UAT 或里程碑准入证据。

Issue #343 的时区处理属于模型层 deterministic 边界，不新增开放债务：`ts/src/tz-resolver.ts` 解析 v2 IANA zone 与 local date，`ts/src/model.ts` 以 UTC instant 计算耗时，adapter 保留 v2 pack `homeZone` 并只合并 profile schedule；explicit vacation 移除 work-window restriction，numeric v1 保持兼容。该契约不代表 live schedules/prices/availability/inventory。

Issue #338 当前形态：写入 patch 接受 `homeCity` 与 optional `homeCityEvidence`（单条非空可省略，多条须显式 exact），持久化为 `homeCityPreference { value, evidence, updated_at }`；`{{motivation_brief}}` 仅以完整 typed preference 提供软默认，当轮显式 origin 优先，缺失/畸形或 unbound evidence 返回 missing。`resolveDefaultOrigin` 只承担纯 precedence contract；默认不 hard-filter 或改变确定性候选/推荐。

### 10.1 未清偿（工作面）

> **#254 当前边界（2026-09-11）**：只读 `repair-plan` 与授权 `repair-apply` / `repair-rollback` 执行面已入库（`ledger-repair-plan.ts` / `ledger-repair-apply.ts`，run-all §29b/§29c）。Apply 需三重门（`--mapping` + 匹配的 `planDigest` + `--i-authorize-apply`），写前强制带校验和的 backup，CAS 更新 `tenant_id` 并保留 `seq`，重建受影响 tenant，并通过 applied stamp 幂等。Owner checklist 与回执 schema：[`ops/ledger-tenant-repair.md`](ops/ledger-tenant-repair.zh-CN.md)。关闭 #254 仍需单独的 founder 授权真实（或确认无需）repair 回执——fixture 绿 ≠ 真实 repair；不构成 M5/M6 gate 证据。

| 债务 | 状态 / 赎回时机 |
|---|---|
| [D-NEW] dsh 进程保活缺失 | 见下方「[D-NEW] dsh 进程保活缺失」（公开追踪 = [#271](https://github.com/Danceiny/gotry/issues/271)） |
| D-37 CfT/Chromium 构建 cookies API 对 HttpOnly cookie 不可见 | **2026-09-09 实证**（dida live E2E SW 探针：同一浏览器 CDP 可见 `CN_M_DidaTravel`，扩展 `chrome.cookies.getAll` 全形态过滤仅返回非 HttpOnly 的 `dida-locale`；品牌版 Chrome 144 正常，ctrip 车道实证）。影响：CfT 上登录快查误报 `needs-login`；搜索/嗅探不受影响（页面请求由浏览器自带 cookie，扩展只转发响应文本）。live E2E 以 `allowAnonymous` 自检态 + 驱动前置 GUI 登录跳过闸面。赎回：上游 Chromium 修复，或品牌版 Chrome+商店版扩展组合验证通过；出现第二家依赖 HttpOnly 票据名闸的适配器时提前。锚点 `scripts/dida-sw-probe.ts`（公开追踪 = [#272](https://github.com/Danceiny/gotry/issues/272)） |
| D-9 节日锚点表硬编码 | **改为库生成机制清偿（2026-09-11，issue #274 重做；#384 的 2031→2040 手抄扩表已被否决关闭——换个日子的同款债务）**：SPRING_FESTIVAL 由 `ts/scripts/gen-lunar-anchors.ts` 构建期机械生成（devDependency `lunar-typescript@1.8.6`，MIT，零传递依赖，仅开发态——绝不进 runtime bundle），覆盖 2026–2099，生成块内带 provenance（库版本/生成时间/命令）；双独立 oracle 固化于 time-eval §7（旧表 2026–2031 六条 + 港天文台 2032–2040 九条，逐条一致）；到期即红守卫 `springFestivalHorizonOk`（最晚锚点年份 < 当前年+3 → 测试红）+ 表耗尽后锚点卡显式告警——静默缺失 failure mode 已消灭；漂移闸 = run-all §59（`--check`）。新巡检口径：扩表/换库 = 重跑生成器；守卫自然变红（约 2097）前无需人工排期。（公开追踪 = [#274](https://github.com/Danceiny/gotry/issues/274)） |
| D-13 会话适配器维护面（RFC user-session-data-rfc） | 见下方「D-13 会话适配器维护面」（公开追踪 = [#272](https://github.com/Danceiny/gotry/issues/272)） |
| D-15 账本触发式后置面（ADR-15 TS-5） | Litestream 云备份 / cr-sqlite 多写者复制 / RFC（loopx） §6.5 claim-fence-receipt 多用户实装——仅在触发器出现时启动：第二真实用户 / 多机部署 / AaaS 立项（公开追踪 = [#275](https://github.com/Danceiny/gotry/issues/275)） |
| D-18 M3 Exit 真实 cohort 证据缺口 | 见下方「D-18 M3 Exit 真实 cohort 证据缺口」（公开追踪 = [#22](https://github.com/Danceiny/gotry/issues/22)） |
| D-19 M4 真实 repeat cohort 缺口 | **证据合同已落地并于 2026-09-08 #223/#228 加固**：Issue #20 fixture scorer 固定 paired/active-planning/reflux/溯源/P4 口径，synthetic fixture 不得充当 Exit；阈值冻结为 N≥5 与 median reduction ≥0.5（raw ratio 比较，报告才 round），逐层 exact schema 与 HMAC-SHA256 假名键 fail-closed，observed-private 还需 `memory_value_source_review.v1` 人工 source-review attestation 合同和匹配本次 summary 的 `reviewed_summary_digest_sha256`。#228 collector 只提供显式同意、隔离 stateRoot 的首访/回访 lifecycle 采集与 candidate/synthetic 脱敏导出，不提升 source_review。赎回条件=私有 `observed_private` cohort 达 N≥5、source-review attestation 合同与 summary digest 绑定并产出脱敏 summary；无真实样本、缺人工核验或 digest 不匹配时保持 candidate/waiting/backoff/no-spend，不扩 schema 假装进展。（公开追踪 = [#20](https://github.com/Danceiny/gotry/issues/20)） |
| D-22 pending_writes 空 receipt 无物理 CHECK（booking_saga_fsm.v1 已知边界） | 词汇层审计链已兜住（`sagaTraceViolations` 对空 receipt 报违例，run-all §36）；**赎回时机 = M5 Entry 拍板**：pending_writes 随 schema 升版加 `receipt 非空 CHECK` + 具名 seam 词汇冻结（`design/booking-saga-fsm.md` §4），未到 M5 Entry 不动写路径（M5 Entry 由 [#136](https://github.com/Danceiny/gotry/issues/136) 治理；successor = [#231](https://github.com/Danceiny/gotry/issues/231)）。**outbox 侧面进展（2026-09-11，#231 首件）**：可派发面（`write_effect_intents`）已带存储层等价不可绕过约束——receipt 非空 CHECK、指向 `approval_claims` 的复合外键、领取字段 CHECK、派发只进不退触发器、attempt 不可变触发器——由 run-all §60 裸 SQL 反例证明；`pending_writes` 本表的 CHECK 与 seam 词汇冻结仍是 M5 Entry 拍板项，此处不宣称关闭 |
| D-26 事实闸覆盖面缺口（ADR-19） | **部分收口**：酒店、政策、机/火价格与非关键词住宿/有限政策词集已按上列切片入闸；**#299/#355** 已完成机票/车次 claim 分流与 `gotry_session_search kind=train` typed rail facts：parser 区分 empty/nonempty/malformed/transport，混合畸形行 fail-closed，正事实以 host-captured invocation route/date/batch 与精确 response URL binding 为准，行内 startTrainDate 仅校验并保留、非未来且不超过 15 分钟的采集时间、`canWebBuy=Y` 与闭集可用座位 token，列表不补票价，仅 genuine empty 生成负事实；**#359** 已将 anchored policy 行内容指纹从「仅核对 as_of」扩到全字段加整行结构守门（单一锚点、严格整行匹配、前/后置非空与重复/格式异常锚点 fail-closed），`itinerary.trip_start` 桥接到 `opts.tripStart`，legitimate `review_by` 与 `tripStart` 派生提醒两种合法形态保留；**#363** 已将 anchored flight/hotel 行的字段指纹补齐——航班行重新抽取 `flight_no` token 严格 == 事实，酒店行严格包含 `destination + check_in + check_out` 任一不等即 `fact_anchor_unknown`，**不替代整行严格比对**（根 contract 第 2 条），§4b 价格兼容形态/列车/政策 canonical 沿用既有判定原语；沿 `loadFactRegistry` + `gateArtifact`，无新增执行面，事实根反例=伪造 UO999/伪造 destination/伪造 date。现有未知锚点仍 fail-closed；反向抽取仍为正则启发式，价格容忍度/汇率/多币种策略与 M5 WriteGate 仍按既有债务复审。本条只记录隔离 deterministic fixture 与本地 gate 证据，不代表 live 12306/供应商库存或价格，也不代表 M4/M5/M6 准入或 D-26 全量关闭（公开追踪 = [#381](https://github.com/Danceiny/gotry/issues/381)/[#299](https://github.com/Danceiny/gotry/issues/299)/[#355](https://github.com/Danceiny/gotry/issues/355)/[#359](https://github.com/Danceiny/gotry/issues/359)/[#363](https://github.com/Danceiny/gotry/issues/363)） |
| D-28 外部 benchmark 驱动的 Agent 泛化证据缺口 | 见下方「D-28 外部 benchmark 驱动的 Agent 泛化证据缺口」（公开追踪 = [#203](https://github.com/Danceiny/gotry/issues/203)） |
| D-29 Booking Copilot 真实库存产品验收 | typed read-action/BFF/task ledger 与可复现 Linux 产物只证明工程边界；#282 另以注入 runPort proof 固定 planner 纠偏与三次预算，仍不证明供应商库存、不可订恢复或 Checkout/订单状态业务效果。**open**：冻结三仓 exact SHA 后，在 tenant/customer/storefront/payment-link 四 surface 跑真实库存；至少一条 unavailable/changed 报价必须经重新搜索、新 CheckAvail、原 Checkout 恢复；Book 仍仅由 Checkout 授权，并以 QueryOrders/清理证据收口（公开追踪 = [#142](https://github.com/Danceiny/gotry/issues/142)） |
| D-33 M4→M6 program 证据采集与 gate 闭合缺口 | issue [#225](https://github.com/Danceiny/gotry/issues/225) 已把任务图落入 `docs/design/milestone-delivery-plan.md`；M4 scorer（#238）、显式 opt-in collector（#248）、tenant ledger/CLI 与 Z3/map 稳定性基座均已入 main，#227/#241/#242 已关闭。真实缺口仍是：① M3 50–200 人 cohort 与 M4 `observed_private` N≥5 repeat cohort/reflux baseline；② M5 首供应链 `hotelbyte-cli` 的协议/Buyer/路由/对账/UAT 签署或内部授权证据；③ P6 founder 明确批准与真实试点签约；④ 后继按各 issue 的准入范围执行：[#136](https://github.com/Danceiny/gotry/issues/136)/[#137](https://github.com/Danceiny/gotry/issues/137) 明确授权的设计、只读调查、fixture 与 failing-before 可在 Entry 前推进，交易运行时、供应商写入与真实 B2B 路径须相应 Entry。M5 proposal 见 `docs/design/write-gate-production-design.md`；未满足前不启封交易/B2B 实现。（治理追踪 = [#270](https://github.com/Danceiny/gotry/issues/270)；真 gate = [#20](https://github.com/Danceiny/gotry/issues/20)/[#22](https://github.com/Danceiny/gotry/issues/22)/[#136](https://github.com/Danceiny/gotry/issues/136)/[#137](https://github.com/Danceiny/gotry/issues/137)；successors = [#231](https://github.com/Danceiny/gotry/issues/231)/[#232](https://github.com/Danceiny/gotry/issues/232)/[#233](https://github.com/Danceiny/gotry/issues/233)/[#234](https://github.com/Danceiny/gotry/issues/234)/[#235](https://github.com/Danceiny/gotry/issues/235)） |
| D-39 地面接驳数据边界 | 第一切片涵盖显式坐标驾车路线、公开 `map_driving_route` 边界、具名静态 `taxi` transfer 的抵达方向（A→B）与返程方向（B→A）分别绑定与按方向隔离的缓存/降级、`minutesOut` / `minutesRet` 覆盖消费与静态价格保留；`bus`/`bus_plus_taxi`、live traffic、transit/rail、fare、地址解析和更广泛的 transfer 组合仍未纳入。该切片不改变 #20/M5/M6 gate；后续边界按 [#341](https://github.com/Danceiny/gotry/issues/341) 追踪。 |


**[D-NEW] dsh 进程保活缺失**

**Phase A 部分赎回（gotry 侧，2026-09-09，#271）**：
- `installProcessGuards` 只挂 `uncaughtExceptionMonitor`，按 Node origin 记录 `uncaughtException` / `unhandledRejection`；不安装吞 fatal 的 handler、不调用 `process.exit`、不隐式重启，宿主已有 handler 与 Node/dsh 退出策略继续裁决。
- `recordIncident` 用单一 fd 完成 append、`fsync`、`close`，仅在全链成功时返回 `true`，失败返回 `false` 且正确回收 fd。native Node24 ESM dist 反例已覆盖 monitor/no-monitor、host handler exit code、writer fsync/close；`guardToolExecute` 继续把工具异常降为结构化失败并落盘。
- **外层边界已部分赎回（2026-09-10，#271）**：GoTry launcher 对 dsh child 建立独立 POSIX process group；child exit/error/close 先完成 bounded descendant cleanup（继承 stdio 使 close 延迟时由 exit 触发）与既有 incident writer，再按原始非零/零语义退出；父进程单独收到 SIGINT/SIGTERM 时，先清理该 group、移除 handler，再向自身重发原信号。focused proof 的实际 `bin/gotry-inner.js` package-shaped fixture、stderr/产品 incident、marker、before/after direct child/group 空性见 `ts/scripts/issue-271-liveness-tests.ts` 和 run-all §23f。
- 仍开放的 #271 边界：dsh SDK 直接 transport 所拥有的 runtime child、dsh 内部 supervisor 的存活/重启语义，以及未在本切片执行的真实 host deployment contract。上游 dsh 文档已将无法执行 JavaScript 的退出/逃逸后代责任置于 external supervisor；本切片不改 vendor/lock、不安装隐式 daemon、不宣称上游 supervisor 已修复。Phase A 的 fatal observer 与本 Phase B 的外层 owner 证据均不提升 M3/M4-M6 真实 gate。

**D-13 会话适配器维护面（RFC user-session-data-rfc）**

- **#335 离线汇总子任务**：sf-01..08 summary 现按可辩护的批次身份与批次采集时间选择单一 coherent batch；producer filename 批次保留各 query 独立 `started_at`，source/fallback/provenance 不丢失，最新 corrupt/incomplete batch 不回退旧成功。该子任务只关闭离线汇总缺陷，不关闭 #272 的真实浏览器/session 与 packaged connected/degraded evidence。
- **#308 forward fix（2026-09-10）**：授权 gate 与 `gotry_session_search` execute 共用 `interpretArgs` 的 query-first kind 选择；缺省为 flight，未知/malformed fail-closed，train 仍受 off/ask/allow 与按站点拒绝/取消约束。标准证据见 session-tests §I + smoke §13。

- **部分清偿 2026-08-30**：action-cache + 金标准输入 + #21 字段 fixture scorer/双源 shape gate 已落；传输层定案扩展桥（§38 防漂移测试把 Node 常量与扩展代码锁死）；Issue #67 增加 `--golden=static` 离线 comparator（OpenFlights 固定 route/carrier + manual 时刻/价格带，requested/effective/provenance/fallback 可审计，§44），但它不是实时可售性来源、也不降低携程 batchSearch 改版风险；真实 sf-01..08 会话证据仍依赖用户扩展连接，站点断时按既有渠道显式降级。
- **部分清偿 2026-09-03（12306 第一方校准）**：rail-12306 适配器不再等「首个真会话后校准」——电报码表逐条核对自官方 `station_name.js` 全量站表（32 城起步集→129 城，曾借此纠出南宁 NIZ→NNZ 错码），座位桶索引与站名映射取自官方前端 `queryLeftTicket_end_js.js` 的 cN（result，map） 转换函数（旧公开常识索引与官方现行映射不符，首查前即纠）；`data/stations-12306-verify.json` 快照 + session-tests L 段防漂移断言锁死，携程侧接口面校准仍待真会话。

**D-18 M3 Exit 真实 cohort 证据缺口**

**进行中（Issue #22）**：公开面已有冻结 manifest、严格脱敏 schema、确定性 scorer 与 synthetic fixture 守门；nightly real-LLM 证据生产器已进入工程面（封存 prompt 集/价表、无凭证 waiting 零写入、预算闸），验收⑥「nightly 可复跑」的机械前提已就位，真实 nightly 记录待凭证环境真跑。私有真实样本尚未进入 `ts/gotry-state/evidence/m3/`。只有 50–200 人真实 cohort 同时达到定稿率 ≥40%、NPS ≥40、POI 幻觉率 <1% 且窗口内 nightly real-LLM 可复跑，才允许业务达标；无样本时不关闭 M3 Exit。锚点：`product-metrics.ts`；`nightly-evidence.ts`；run-all §33/§35。

**D-28 外部 benchmark 驱动的 Agent 泛化证据缺口**

- **现状**：ChinaTravel grounding-v3 的冻结 5-query canary 只完成 1 个可评分终态，第二例在 planner 重复工具调用中触发 300s timeout——当前没有合法 5-query 聚合。Round 1–12 逐轮事实见 §9「外部 benchmark 泛化」；Round 10 的 `glm-5.3-flash` treatment 在 main `c843fae` 诊断为顶层 `oneOf` 可见性失败（57 次空 `{}` 调用、无 countable score），Round 11 仅调整模型面对的 flat wire，Round 12 收口结构半场（config v4 closed body schema），当前仍没有可归因的 official score/uplift。
- **子债：Phase 0→Phase 1 adapter admission（open）**：Phase 0 foundation 已含契约/注册表/校验器、unmatched diagnostic fixtures 与确定性节奏 planner（无调度/花费/打分/基线/uplift 效力）；每个 adapter、external runner、baseline 与 matched production-evidence 路径仍需单独批准的 plan/PR，并过 [`evaluation-foundation.md`](evaluation/evaluation-foundation.md) 的 license/evaluator/source-fence 控制。
- **赎回顺序**：source/installed startup+conformance 合同与全回归通过 → 新冻结 case 在 no-oracle 边界下 `exit=0`、非空 terminal、planner<300s 且 evaluator 执行 → 原 manifest 5/5 终态且 schema/forbidden/七指标完整 → 按 registry 扩展其他公开 benchmark 并在 3–5 个独立优化 PR 后综合归因；在匹配 evidence 前不声称分数提升或 external closure。

## 11. 保鲜机制（文档与现实的同步纪律）

**状态面清单**（全仓只有这 6 处记载「当前状态」，其余文档一律状态让渡）：① 本文 §1 当前形态；② 本文 §9 演进；③ 本文 §10 债务清单；④ `roadmap.md` 当前位置；⑤ `README.md` 当前形态；⑥ `design/stage1-top-down-design.md` 状态头。

**同提交同步规则**：任何改变系统当前形态/状态/债务的提交，必须在同一提交内同步全部状态面——`bb880f3`（M1 exit）只改了 §1 与 ADR 表，四处状态面滞后了一个提交周期，本节由此而立。

**M-exit 保鲜清单**（里程碑退出提交的勾稽项，结果附于提交信息）：
1. 6 处状态面全部同步（或显式让渡并注明让渡对象）；
2. ADR 全表逐条过「淘汰/复审条件」，触发的当即立项或改状态；
3. 债务清单勾销与新增——债务只能在本表诞生，不许只活在代码注释里；勾销项移入 [`debt-archive.md`](debt-archive.zh-CN.md) 存档；
4. 计数类表述（ADR 数、测试数）改为引用而非数字——数字会腐烂；
5. 验收证据可复跑：夹具/脚本命令写进提交信息。

**复审节奏**：不靠日历，靠事件——M-exit 必审全表；淘汰条件被触发（求解 >500ms、差分 20 次无分歧、桥延迟 >500ms）随时审。

## 12. 文档地图

组织规范（目录税则/命名/头部块/生命周期）与总索引见 [`README.md`](README.zh-CN.md)。下表按目录分组：

| 文档 | 关注点 |
|---|---|
| 本文 | 技术：系统/模块/模型/循环/数据概要/ADR/演进/债务 |
| `roadmap.md` | **时间线唯一来源**：M0-M6 里程碑三线视图与旧模型归并 |
| `gotry-master-outline.md` | 程序：工作分解/复用矩阵/决策门（总纲） |
| `gotry-product-design.md` | 产品：主循环/透明机制/全成本/共享经验 |
| `data-sources.md` | **数据源唯一权威面**：领域矩阵/四层架构/Google Place 链路/证据链契约/TREK 参考 |
| `tech-strategy.md` | 技术选型与半年迭代路线（M2–M4）：选型矩阵/评测体系/分工/持续优化回路/决策登记 |
| `tokens.md` | **token 唯一权威面**：npm 三路径（web会话/granular bypass/OIDC）+ agent-reach 8 渠道获取表 + 统一 .env 存放 |
| `user-guide.md` | 面向使用者的上手指南（dsh 形态用法） |
| `tools.md` | **工具参考面**：23 个注册工具分组与逐工具契约/降级行为 + 通道路由（注册表只建议不派发）+ web onboarding（#258/#267）与运维脚本面 |
| `release-notes.md` | 发版记录（按版本归档，最新在上） |
| `decisions-needed.md` | 待创始人拍板的决策清单 |
| [`debt-archive.md`](debt-archive.zh-CN.md) | 已清偿债务存档（追加式留证；开着的债与工作面只在本文 §10.1） |
| `design/memory-design.md` | **记忆域设计**：C 端六层重设计（M1-M6 现状映射/P1-P4 分期增量/铁律与验收），M4 交付「六层框架重设计」的正式文档 |
| `design/memory-lifecycle-collector.md` | **M4 planning lifecycle collector 使用合同**（#228/#248）：显式 opt-in CLI、隔离 stateRoot、HMAC/consent/source/wait 冻结、JSONL+manifest 原子持久化与 #223/#238 scorer 导出链；仅产出 candidate/synthetic，不替代真实 cohort |
| `design/milestone-delivery-plan.md` | **M4→M6 living 任务图（issue #225）**：按真实依赖拆分 M4 #223/#238/#228/#248/#20、已入 main 的 ledger/state-cli/Z3/map 基础（#229/#237/#243/#244/#245）、M5 #136 HotelByte 首供应链+WriteGate（#231/#232/#233）、M6 #234/#235/P6/试点与开源质量闸，逐项责任面/责任文件/E2E/否证/退出标准；另跟踪 quality/follow-up 线 #254/#255（#257 已经 PR #264 关闭）（非 M5/M6 Entry 阻断） |
| `design/write-gate-production-design.md` | **M5 WriteGate 生产化 proposal（issue #225/#136）**：HotelByte 版本/发布物、可信 receipt 发行/消费权威、approval_claims 持久化、本地 outbox intent（不宣称外部 exactly-once）、query miss 保持 unknown、supplier unknown/manual reconcile/cancel-vs-compensation/L4 revoke/commission disclosure；只设计不启封交易 |
| `design/effect-interpreter.md` | **效应解译器设计（issue #16 采纳，ADR-18）**：effect_interpreter.v1 词汇（效应值/EffectOutcome/trace）+ 渠道韧性策略表（退避/断路/节律依据逐行）+ 生产/mock 双解译器 + 为什么不做视觉 CUA 与自动多渠道路由的判定记录 + D-23 迁移面 |
| `design/booking-saga-fsm.md` | **预订 saga 状态机设计（issue #17 采纳，ADR-17）**：booking_saga_fsm.v1 字母表/边表/拒绝闭集 + 三种边型词汇（deterministic/gate/external-event）+ HITL 审批的挂起-恢复形态 + M5 启封增量与不引入编排框架的判定记录 |
| `design/tool-orchestration-design.md` | **工具编排与通道健康面设计（proposal，2026-09-03）**：issue #106/#107/#108 收口——通道注册表（数据单一来源）+ 通道健康面（doctor 持久面 + 会话瞬态面）+ DP 编排=健康态驱动的动态建议；含「普通 LLM 下长久保持工具调用性能」与「开放生态可扩展性」两命题回答；拍板点 = decisions-needed D-7/D-8/D-9 |
| `design/adapter-authoring-guide.md` | **Session 适配器作者手册**（D-13）：四步法（探测→第一方金标准→双源 shape gate→漂移锁）/接入清单/纪律红线/携程真会话校准清单 |
| `design/external-event-seam.md` | **外部事件接缝设计**（#82 兼容方向/D-31）：事件=健康面与愿望池的新生产者；信任分级与落地序列（触发式，消费既有接缝不建新运行时） |
| `design/hotelbyte-skills-design.md` | hotelbyte-skills 架构（知识进仓/执行留 gotry，issue #5） |
| `design/stage1-top-down-design.md` | Stage 1 详细设计与实现序（其状态头 = §11 状态面⑥） |
| `rfc/transactional-state-rfc.md` | **RFC（accepted 2026-08-28，ADR-15）**：事务化状态基座——业界 durable-execution 调研收敛五件套 + GoTry 落地架构 + TS-0..TS-5 执行计划与决策记录（D1-D5） |
| `rfc/user-session-data-rfc.md` | **RFC（已立项 2026-08-28）**：用户会话数据面——官方通道优先 + 用户会话补缺，四阶段落地（P0-P4）与决策门（G7/G8/G9 已结算） |
| `rfc/loopx-inspired-upgrades-rfc.md` | **RFC（accepted 2026-08-27）**：loopx 13 篇架构 RFC 的映射升级——四道接缝（S1 工具 packet 纪律/S2 记忆效用 sidecar/S3 wish 触达 0..1 纪律/S4 WriteGate L0-L4 词汇） |
| `research/kimi-postmortem.md` | 反例教材与地面真值提取 |
| `research/maka-research.md` | Apache Maka（Incubating）研究 → 与 ADR-15 事务化状态基座逐项对照（durable-execution 机制/可采纳面，研究底稿供 founder 拍板） |
| `research/deerflow-research.md` | DeerFlow 研究 → gotry 优化目标 T1-T4（issue #10） |
| `research/dsh-plugins-shortlist.md` | dsh 社区插件选型（awesome-dsh-plugin 全量调研，issue #9） |
| `research/enterprise-travel-reference-study.md` | **某企业级差旅 Agent 系统八维参考研究（2026-09-03，来源脱敏）**：双轨执行/写闭环→M5 设计输入（ADR-17/S4 接缝），合规收口装饰器/领域 skill→M6 输入，生产级状态→D-15 触发时参考，双模型/上下文压缩→不采纳（ADR-24 已覆盖）；差异化保留清单与「不追求代码量等价」判定 |
| [`evaluation/evaluation-foundation.md`](evaluation/evaluation-foundation.md) | Evaluation Phase 0 contracts, registry ownership, aggregate admission, and non-uplift boundary |
| `evaluation/benchmark-environment-bridge.md` | 外部 benchmark 桥（Phase 1 接缝，default-off）+ 逐轮工程台账 |
| `evaluation/e2e-prompts.md` | dsh 端到端真 LLM 验证记录（§1-§11，wrapper/澄清卡/背景调查等） |
| `evaluation/persona-bench/` | 产品人格横评：同一真实行程 prompt 各家回答存档/评分卡/人格反哺 |
| `milestones/demo-plan-2026-07-17.md` `milestones/demo-reconciliation.md` | demo 交付物与对账 |
| `milestones/m2-capability-gap.md` `milestones/m2-flight-data-options.md` | M2 期能力缺口与机票数据选型（历史备忘） |
| `milestones/m3-web-gap.md` | M3 Web 形态缺口（G-1..G-4 方向） |
| `milestones/m4-calibration-questions.md` | M4 校准问题集 |
| `milestones/m6-b2b-reuse-walkthrough.md` | M6 P6 B2B 复用推演纪要（draft）：traveler principal/sponsor/BFF principal 分词、复用率实测口径、tenant 对抗、披露插件 proposal；待 founder 评审 |
| `milestones/s1-walkthrough.md` `milestones/g1-market-memo.md` | Stage 1 走查与 G1 首发市场备忘（历史备忘） |
| `ops/extension-webstore-submission.md` · `ops/extension-privacy.md` · `ops/external-pr-workflow.md` · `ops/ledger-tenant-repair.md` | Chrome Web Store 上架材料与隐私政策（ADR-21 通道 B）；外部 PR（含自动化机器人）维护者侧工作流；#254 账本 tenant 修复 owner-gate 清单 |
| `assets/` | archify 生成的系统架构图（工具产物，仓内无消费者） |
| `superpowers/` | superpowers 工作流 plans/specs（评测计划，工具自管） |
