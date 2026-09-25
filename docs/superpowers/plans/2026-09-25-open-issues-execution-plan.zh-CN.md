[English](2026-09-25-open-issues-execution-plan.md) | [简体中文](2026-09-25-open-issues-execution-plan.zh-CN.md)

# Open Issues 后续执行计划

> 定位：为初始 30 个开放问题提出执行顺序、剩余工作与验收条件；不新增里程碑权威。
> 状态：第一波工程已通过 #582 合入；关单状态以关联 GitHub issue 为准。#577 条件修复与本计划一同交付，合并及关单回执以关联 issue 为准。基线核查日期为 2026-09-25。
> 上游：[仓库契约](../../../AGENTS.zh-CN.md)、[主纲](../../gotry-master-outline.zh-CN.md)、[架构](../../architecture.zh-CN.md)、[路线图](../../roadmap.zh-CN.md)，以及各关联 issue 的范围。
> 下游：问题整理、可独立审阅的 PR 与证据采集。
> 执行代理：使用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans` 执行已准入任务，保持以下门禁。

**目标：**将开放队列变成能交付旅行规划体验的执行顺序，优先核心规划与集成易用性，随后取得真实 M3 证据。

**完成标准（Definition of Done）：**每个已准入工程 issue 同时满足以下四项才算完成。

1. 约定范围已实现，验收证据已记录；额外验证不得悄然变成新的关单要求。
2. 交付代码的适用回归、CI 及独立审阅通过，受影响权威文档已双语同步。
3. PR 已合入目标分支。
4. issue 已按 completed 关闭，附合并改动与验收证据链接，并回读最终状态。

按创始人指示持续执行到合并与关单。真实证据或发布父项只因其自身验收未满足而保持开放，具体缺口记录在该 issue。发布版本及动作确认仍遵循 AGENTS.md。

**架构：**沿用规划器、事实注册表、deck／导出、会话桥与证据采集器。先补齐明确产品缺口，再采集真实结果；新增能力由已有触发条件决定。

**技术栈：**TypeScript、dsh 插件、Chrome 扩展、GitHub Actions、现有 cohort 脚本；不增加产品运行时或 Python 依赖。

**规格依据：**[#559](https://github.com/Danceiny/gotry/issues/559) 记录创始人的产品优先方向；下游准入遵循 [M4–M6 交付图](../../design/milestone-delivery-plan.zh-CN.md)。

## 1. 初次核查基线与优先级判断

- 本地及远端 `main` 均为 `fb1cbf2ea2b5dc5619c0cf454ab70edb17da9e02`；开放 issue 共 30 个，开放 PR 为零。
- 没有缺少交付物的异步工单。已有未跟踪目录 `dist-extension/` 不属于本次规划改动。
- 最近八个功能 issue 已有合并实现。对账后四个满足原切片，#577 仍缺 wish 条件判定；#569 缺二维码解码证据，#573／#580 存在可复现的 token 校验缺口。
- #559 的 A／B 及骨架警示修复已通过 #560／#562／#563 合入。剩余是 Agent-Reach 错误提示；不重复实现引导，也不依据滞后骨架排除 EK329。
- 当前 SHA 重跑七个离线套件：deck 226、artifact 131、export 147、demo 21、share 73、recall 67、session-link 83；**合计通过 748 项，失败零项**。本次核查没有重跑全量回归或真实业务验收。
- 额外纯函数探针复现了既有断言外的三处失败：生产环境缺 secret 时 session-link 校验抛异常；注入无效时钟时，过期 session-link token 与 share token 均被接受。这些是契约缺陷，不代表外部服务已激活。
- 最新 main CI [36054797657](https://github.com/Danceiny/gotry/actions/runs/36054797657) 已取消，不能算绿。扩展流水线 [36054797665](https://github.com/Danceiny/gotry/actions/runs/36054797665) 打包成功，发布步骤跳过。
- [GitHub 扩展 Release](https://github.com/Danceiny/gotry/releases/tag/ext-v0.2.0.25) 与源码 manifest 均为 `0.2.0.25`。[公开商店页](https://chromewebstore.google.com/detail/gotry-session-bridge/oeajpiccmonococjcegddlooeeohlbgd) 仍显示 `0.1.0`；手动提审及审核状态未核实。Release 文案不等于提审回执。

**建议顺序：**已合入工作对账 → 补齐 #559、token 与二维码验收 → 修通并验证分发 → 真实用户使用 → 用观察到的缺口选择后续核心工作。第一波同步准备 cohort 采集。#511 保持事件触发；没有复发时继续加诊断不能推进本目标。

## 2. 全局约束与审阅重点

- 算术只在 evaluate，求解只在 unified；不新增对废弃 engine／journey 兼容层的调用。内核改动遵循既有清单决策与全栈回归。
- 测试不得写入 `ts/dsh-runtime/gotry-state/`；显式使用临时 `stateRoot`，获准私有证据放入已忽略的证据目录。
- 内部资产仅作桥接或参考；不新增 TS↔Python 可行性桥或 Python 依赖面。
- share 适配器、recall 运行时、session-link 消费端不会因契约测试通过而激活；M5 写路径继续封存。
- 发布版本与动作遵循 AGENTS.md 的创始人确认制。先查已有授权与回执，避免重复提审或重复索要同一授权。
- 只更新事实发生变化的专属权威，双语同步；不向冻结研究追加实现历史。只暂存自有文件。

| 审阅重点 | 负责任务与预期结果 |
|---|---|
| SVG 看起来正常却扫错；本地 bundle 暗示链接可访问 | T2：独立解码必须还原准确载荷，并明确仅本地意图 |
| 进程 stderr 或上游凭据片段进入用户文案 | T1：有边界的人话错误、来源标注，保持结构化恢复语义 |
| 将打包绿灯或 HTTP 200 描述为商店发布 | T3：分别验证产物路径、响应状态、审核回执、商店回拉与安装版本 |
| 合成 demo、重试或重复用户虚增 cohort 成功 | T4／T6：冻结纳入条件、分母、来源、私有同意，分开工程证据 |
| token 接受无效时钟，或只读／链接路径跨越权限 | T1b／T5／T7：无效 token 失败闭合，保持遇挑战停止、Checkout 权威与里程碑门禁 |

## 3. 初始 30 个开放问题的处置

| Issue | 剩余工作或分类 | 执行去向 |
|---|---|---|
| [#564](https://github.com/Danceiny/gotry/issues/564) | 渲染器经 #565 合入 | 已关闭，验收已对齐 |
| [#566](https://github.com/Danceiny/gotry/issues/566) | 产品渲染入口经 #567 合入 | 已关闭，验收已对齐 |
| [#568](https://github.com/Danceiny/gotry/issues/568) | 导出经 #570 合入；按已接受的 basename 前缀布局对齐原验收清单 | 已关闭，验收已对齐 |
| [#569](https://github.com/Danceiny/gotry/issues/569) | 二维码实现 #575／#576 已合入；独立 SVG 解码与 `local_only` 经 #582 合入 | T2 完成，已关闭 |
| [#571](https://github.com/Danceiny/gotry/issues/571) | 离线脚本经 #572 合入；不代表已部署免安装 landing 网站 | 已关闭，验收已对齐 |
| [#573](https://github.com/Danceiny/gotry/issues/573) | 同意／token／stub 经 #574 合入；无效时钟校验经 #582 修复 | T1b 完成，已关闭；外发未激活 |
| [#577](https://github.com/Danceiny/gotry/issues/577) | 召回信号配对经 #578 合入；本次修复复用 wish 条件匹配并传递实际命中明细 | 按下述 T0 完成条件修复与验收 |
| [#580](https://github.com/Danceiny/gotry/issues/580) | 链接契约经 #581 合入；缺 secret 与无效时钟校验经 #582 修复 | T1b 完成，已关闭；不激活路由或 scheme |
| [#559](https://github.com/Danceiny/gotry/issues/559) | Agent-Reach 错误与恢复指引经 #582 合入 | T1 完成，已关闭；T4 单独进行 |
| [#346](https://github.com/Danceiny/gotry/issues/346) | 共同的商店发布门禁与回执权威 | T3，达到实际验收后再收口 |
| [#537](https://github.com/Danceiny/gotry/issues/537) | 标题版本已旧；当前 join 链验收与 #346 属于同次发布 | T3，同次发布、分别保留验收项 |
| [#272](https://github.com/Danceiny/gotry/issues/272) | 真实连接／降级适配器证据与包入口 | T5，manifest #501 已合入 |
| [#22](https://github.com/Danceiny/gotry/issues/22) | 真实 50–200 人 M3 结果集 | T6，产品证据最高优先级 |
| [#20](https://github.com/Danceiny/gotry/issues/20) | 真实配对复访 cohort 与 reflux 基线 | T6 并行，不豁免 M3 Exit |
| [#142](https://github.com/Danceiny/gotry/issues/142) | 四 surface 真实库存、恢复、Checkout 与 QueryOrders 证据 | T7 独立 UAT 线 |
| [#511](https://github.com/Danceiny/gotry/issues/511) | 原始偶发 SDK 握手原因仍未知；诊断已落地 | 复发或实际阻塞交付时恢复 |
| [#429](https://github.com/Danceiny/gotry/issues/429) | 每次只准入一个交通／公交／价格／地址用例 | T4 有证据后的首批扩展候选；公共读取不要求 M5 |
| [#422](https://github.com/Danceiny/gotry/issues/422) | 未托管直连 SDK 的后代进程所有权触发项 | 先审具体调用点；当前 Copilot 由 ManagedDshRunPort 托管 |
| [#275](https://github.com/Danceiny/gotry/issues/275) | 第二位真实用户、多机或 AaaS 触发拓扑与 fencing 审查 | cohort 扩量前复核，不能无限后置 |
| [#344](https://github.com/Danceiny/gotry/issues/344) | 首个真实非 CNY 报价、预算或目的地需求触发 Money／FX 契约 | T4／T6 收集时核查，尚不能断言触发未发生 |
| [#255](https://github.com/Danceiny/gotry/issues/255) | P4 需真实使用／多用户信号及明确实现批准 | 延后激活，记录真实触发 |
| [#339](https://github.com/Danceiny/gotry/issues/339) | 城市场景分级需要审阅后的真实样本 | 样本与排序假设明确后再做 |
| [#276](https://github.com/Danceiny/gotry/issues/276) | 内部 SearchSrv 需量测到外部路径瓶颈或内部调用方 | 触发及跨仓所有权明确后再做 |
| [#345](https://github.com/Danceiny/gotry/issues/345) | 专门 Place／reviews 需 Anything 质量缺口及付费配额批准 | 证据和三仓负责人明确后再做 |
| [#342](https://github.com/Danceiny/gotry/issues/342) | 离线 atlas 需已排期离线／地图／归一化需求与可分发数据 | 产品需求触发后再做 |
| [#82](https://github.com/Danceiny/gotry/issues/82) | 惰性契约 #432 已完成；剩余真实 callback／sensor／auth／consumer 激活 | 准入具名 callback／sensor、信任模型及消费者；share／recall 消费者仍遵守各自独立激活门禁 |
| [#340](https://github.com/Danceiny/gotry/issues/340) | 成交偏差回流需供应链／WriteGate 准入与真实终态 | M5 准入且有真实结果后再做 |
| [#136](https://github.com/Danceiny/gotry/issues/136) | M5 Entry＝M4 Exit＋供应链授权；已有基础机制 | 仅准备缺失协议证据，不激活交易 |
| [#137](https://github.com/Danceiny/gotry/issues/137) | M6 Entry＝M5 Exit＋明确 P6 批准，随后真实试点 | 保持门禁，复用 fixture 不等于试点 |
| [#18](https://github.com/Danceiny/gotry/issues/18) | 总体协调与剩余证据门禁 | T0 对账，不当作独立功能任务 |

## 4. 波次、负责人及停止条件

| 波次 | 交付物 | 并行方式与出口 |
|---|---|---|
| 第一波，下个有界执行批次 | T0 对账、T1 错误提示、T1b token 校验、T2 二维码验收、T3 发布准备、T6 采样准备 | 每 PR 一位负责人，独立审阅；T1／T1b／T2／T3 可并行，共享 runner／索引改动串行。已准入工程项按 DoD 合入并关单；T3／T6 准备完成后，父项未满足验收仍明确开放 |
| 第二波，实际产品使用 | T4 三场景走查、T5 获准会话证据、T6 种子使用及复访；UAT 就绪时跑 T7 | 获准路线独立启动，不互相等待；修复实测缺陷，保留缺失输入状态 |
| 第三波，证据选择扩展 | 最多选择一个 T4／T6 暴露的核心或数据缺口，#429 地址澄清是候选 | 不预先铺开大功能计划；每个新切片先有真实例子和验收，再实施 |

当前执行：Claude Code 按用户确认的既有配置在隔离 worktree 中工作。#582 已合入，八项远端检查通过。#559／#564／#566／#568／#569／#571／#573／#580 已附验收证据关闭。本次 #577 修复有 96 项召回断言通过及独立审阅，合并及关单回执由其 issue 承载。T3 仍属发布准备；T6 已准备采样交接，真实纳入及采集待完成。

工作量以交付物约束，不承诺商店审核或 cohort 到达日期。等待登录、审核、用户或供应商时不重复做诊断。本计划不授权对外招募消息；可以准备材料，使用已明确准入的会话。

## 5. 可执行任务

### T0，先对账，再选择新工作

**文件及管理面：**关联 issues、`docs/design/itinerary-deck-renderer.{md,zh-CN.md}`、专属权威指针、已有 LoopX 任务回读。
**输入与输出：**当前 issue 验收及准确合并 SHA → 唯一剩余工作清单与有证据的收口候选。

- [x] 对原五个收口候选核对合并 SHA、原范围、验收证据及明确排除项。#564／#566／#568／#571 满足原切片；#577 的条件缺口由下述修复承接。#568 对齐 `<stem>.html`、`<stem>.manifest.json`、`<stem>.qr.svg`；不为迎合旧清单而重命名正常工作的实现。
- [x] 修正 renderer 设计文档仍写「没有产品入口」的头部；现态保留在设计及 issue 面，不追加到冻结 Karpo 研究。
- [x] 在 architecture D-29 对账 #142 已完成的 #473／#476 前置，真实 UAT 保持开放。不重复 #272 已合入的 #501 manifest 冻结或 #231／#234／#235 基础工作。
- [x] 核实 #512 已合并，#18 当前正文未将其列为开放依赖；保留父级证据门禁。
- [x] 对齐 code-map 双语对中过期的 deck／QR 状态；修正 #511 readiness 报告双语对的过强推断：零 provider 请求不能证明 initialize 失败，应以有序阶段链为准。这项文档纠正不代表原偶发事件已定位。
- [x] 回读 LoopX 执行契约，注册代理为零，当前 binding 缺失。按用户授权直接调度 Claude Code，不编造 Todo ID，不写无绑定 lane，不另建 goal 或 heartbeat。
- [x] 修复 #577，在信号路由前复用 `scoreWishMatch`，并将实际命中明细传入 trigger／card。`RecallSignal` 承载 producer 提供的事件描述，展示字符串不充当数值事实。命中、未命中、定向绕过、通道否证及部分命中用例均通过，设计双语对明确此边界。运行时激活仍不属于本切片；按上述完成标准完成其合并与关单。
- [x] 按创始人明确指示，为 #559／#564／#566／#568／#569／#571／#573／#580 附合并改动及验收证据并关闭，回读 issue 状态。父级证据门禁保留各自验收条件。

### T1，完成 #559 剩余的集成失败体验

**文件：**修改 `ts/capabilities/agent-reach.ts`；扩展 `ts/scripts/agent-reach-wrapper-tests.ts` 或新增确定性错误套件；仅在必要时注册新套件；数据源契约变化时同步 `docs/data-sources.{md,zh-CN.md}`。
**输入与输出：**既有 ReachResult 的 verdict、setup、inventory、evidence → 安全用户文案，保持路由及恢复语义。

- [x] 增加缺可执行文件／包、超时、畸形桥 JSON、非零退出 stderr、空响应的确定性用例；改动前钉住裸 stderr 反例，保留成功数据与未知渠道 inventory。
- [x] 在既有边界沿用 `anything.ts` 的失败分类；保留来源标签和上游 `needs-setup` 指引，不新建渠道表、不加自动重试或 Python 依赖面。
- [x] 断言用户看到原因、受影响能力和下一步；不暴露 traceback、疑似凭据诊断值，也不暗示预订失败。
- [x] 跑确定性错误用例（14 组）、类型检查与隔离 smoke；既有可选 wrapper 套件保留依赖及真实运行的跳过规则。
- [x] #582 已合并，验收对齐后关闭 #559；本地全量回归及远端 CI 均通过。

### T1b，修复既有 share／session-link 校验边界

**文件：**`ts/src/session-link/session-link.ts`、`ts/src/share/share-token.ts`、`ts/scripts/session-link-tests.ts`、`ts/scripts/share-tests.ts`；契约文字变化时同步相应设计双语对。
**输入与输出：**既有 token、可选 secret、注入时钟 → 既有 invalid／expired 结果联合，无效时间不得接受 token。

- [x] 增加失败测试：生产环境缺 secret、过期签名 token 配 `now: () => new Date(NaN)`、时钟回调抛异常；两类 token 都覆盖无效时钟。配置测试在隔离子进程环境运行。
- [x] 将校验阶段的 secret 解析移入受保护函数体，拒绝非有限当前时间。签发阶段保留有意的配置／签名异常；session-link 校验的运行错误返回 `link_invalid`，share 校验保持 `token_invalid`／`token_expired` 词汇。
- [x] 保留正常往返、过期边界、签名校验、target 绑定、未知键拒绝与写动作禁令；不注册深链处理器、发送端或 tick 进程。
- [x] 跑两套 token 测试（share 85、session-link 96）、类型检查与隔离 smoke，覆盖过期边界和畸形运行时密钥。
- [x] #582 已合并，验收对齐后关闭 #573／#580；本地全量回归及远端 CI 均通过。

### T2，完成 #569 的真实二维码验收

**文件：**`ts/scripts/itinerary-deck-export-tests.ts`、`ts/capabilities/itinerary-deck-export.ts`、renderer 设计双语对；仅在需要获准开源测试解码器时修改包及锁文件。
**输入与输出：**实际 SVG 与 manifest → 独立解码载荷，明确区分托管 URL 与仅本地标记。

- [x] 将实际生成 SVG 栅格化后交独立解码器回读；普通及 UTF-8 URL 必须逐字相等，无 URL 时还原仅本地标记。字节不同及存在 `<path>` 元素不能替代此证据。
- [x] 将 issue 的 `local_only` 预期与已接受 manifest 契约对账；补兼容显式标识，或记录获准范围调整。缺少 `target_url` 不得暗示有线上目的地；测试解码器尽量不进入运行时依赖。
- [x] 在 128／240／480 像素尺寸独立解码实际 SVG，保留静默区、超容量零写入及冲突回归。物理手机实扫属于可选补充验证，不新增为验收门禁；本轮未执行。
- [x] 重跑 export（170）、renderer（226）、artifact（131）、类型检查与隔离 smoke；干净依赖安装后 export 与类型检查也通过。
- [x] #582 已合并，以独立解码证据和对齐后的 manifest 语义关闭 #569；本地全量回归及远端 CI 均通过。

### T3，验证扩展发布路径，再完成分发

**文件：**`.github/workflows/extension-publish.yml`、`docs/extension-store-publish.{md,zh-CN.md}`、`docs/ops/extension-webstore-submission.{md,zh-CN.md}`，以及按需补充的现有扩展／打包测试。
**输入与输出：**准确源码／版本与打包归档 → 可验证产物路径及明确的上传／审核／上架状态；#346／#537 只做同一次发布。

- [ ] 先读既有授权与实际 dashboard／API 回执。Release 文案写审核中，但两次可见流水线只有打包；若已手动提审，记录回执，避免重复提交。
- [x] 自动提审前修复下载与上传路径不一致：upload-artifact 以三文件共同的 `dist-extension` 为根，download-artifact 默认解压到 workspace。显式下载到 `dist-extension`，在 OAuth／网络请求前断言包存在。依据上游[上传行为](https://github.com/actions/upload-artifact/tree/v4#upload-using-multiple-paths-and-exclusions)和[下载行为](https://github.com/actions/download-artifact/tree/v4#download-single-artifact)。
- [x] 按当前官方 API 核对 publish 响应语义，不能只看 HTTP 成功；缺 token、畸形响应、拒绝状态均失败闭合。将文档的五项 secrets 与当前四项直连 API 配置对齐。
- [x] 离线证明打包→下载→文件定位与响应分类，包含 HTTP 成功但应用拒绝；准备准确 SHA、版本、权限差异、校验和及回退包，不覆盖用户已有 `dist-extension/` 工作。
- [ ] 仅在已有或新增创始人授权覆盖准确版本后提审或继续审核；通过后从商店安装，验证 portal 票据→桥连接→Dida 登录／命中或诚实降级及更新行为。遇挑战停止，交易写入为零。
- [ ] #346／#537 各自达到验收出口后再关闭；上传、审核中、GitHub Release、unpacked 测试均不等于商店回拉证明。

### T4，用三个完整旅程选择下一项核心能力

**文件及产品面：**现有 `ts/scripts/replay.ts`、`ts/scripts/engine-run.ts`、deck／导出入口、`docs/capability-onboarding.{md,zh-CN.md}`；产生新证据时写精简双语评估报告。
**输入与输出：**当前可用产品 → 排序后的、可复现用户可见缺口；不自动承诺新功能。

- [ ] 走查三个场景：多城行程＋工作窗口＋已订酒店；不可行洱海愿望＋条件＋替代；可选集成缺失、恢复及可读 deck。
- [ ] 记录提问次数／重复、约束保留、拿到可用计划的时间、来源及价格时效、降级说明、产物可用性。mock replay 只证明确定性行为；对话质量需要有界真实模型会话。
- [ ] 真实模型运行使用明确隔离状态与受控凭据／预算路径。不修改历史 fixture 日期来伪装实时证据，为真实使用建立当期输入。
- [ ] 按被阻塞的规划决策给实测失败排序；实现前给每个确认缺陷单独定范围。输入采集时检查 #344 非 CNY 与 #429 地址需求，不自动新增 FX、路由、托管分享或召回运行时。

### T5，以真实会话证据推进 #272

**文件及证据面：**`ts/scripts/sf-live-benchmark.ts`、`ts/scripts/sf-summary.ts`、`ts/data/sf-golden-manifest.json`、会话适配器及 RFC 契约、已忽略证据输出。
**输入与输出：**已授权连接浏览器及固定包版本 → 每个适配器真实连接／降级证据，与静态比较证明分开。

- [ ] 复用冻结 sf-01..08 manifest；检查其中日期是否仍适合查询，必要时明确记录新窗口，不静默重写历史证据。
- [ ] 获准登录且确认商店／unpacked 通道后，跑一次有界批次到显式私有目录；遇挑战或守卫违例即停，保留已尝试／未尝试及未覆盖适配器。
- [ ] 从同目录重建 summary，检查包入口、transport shape、登录／命中／降级及清理。D-37 的品牌 Chrome／商店行为需要单独真实观察。
- [ ] 代码缺陷拆独立 PR；仍有支持适配器未验证时保持 #272 开放，不把 static／manual 比较器证明写成真实供应商验证。

### T6，开始真实 M3 结果及 M4 配对复访

**文件及证据面：**`ts/scripts/product-metrics.ts`、`ts/scripts/nightly-evidence.ts`、`ts/scripts/memory-lifecycle.ts`、`ts/scripts/memory-value-report.ts`；已忽略的 `ts/gotry-state/evidence/`。
**输入与输出：**获准且取得同意的真实观察 → 脱敏 cohort、可重跑 summary 与明确证据缺口。

- [x] 准备既有采集器命令及输入清单，覆盖纳入条件、窗口、同意、负责人和复访方式。这些输入尚未冻结，未采集真实 cohort 数据。

- [ ] 采集前冻结纳入条件、窗口、分母、同意、证据负责人及复访方式。第二位真实用户或任何多机提案出现时，先做 #275 拓扑／fencing 审查再扩量；触发不代表自动必须实现复制软件。
- [ ] 复用现有采集和评分契约，记录真实交付／定稿计划与审计 POI；fixture／开发者走查单独存放。不伪造参与者，没有明确对外沟通授权时不发邀请。
- [ ] #22 收集真实 50–200 人；同时满足定稿率 ≥40％、NPS ≥40 且报告响应分母、POI 幻觉率 <1％、窗口内可重跑真实模型 nightly 证据。
- [ ] 并行安排 #20 首次／复访配对：真实 `observed_private` N≥5，p50／p75 有效规划时长，中位降幅 ≥50％，reflux 基线，可追溯偏好及人工来源审阅声明。采集器导出在审阅前仍是 candidate。
- [x] 没有证据时记录 waiting／backoff／no-spend。正式 M4 准入仍在 M3 Exit 后；少数成功访谈不等于任一里程碑退出。

### T7，独立前置具备后执行 Booking UAT

**文件及验收面：**`docs/architecture.{md,zh-CN.md}` 的 §1.4／D-29、`docs/evaluation/copilot-readiness-report.{md,zh-CN.md}`、现有 booking 证明脚本、#142 UAT 证据，以及准确的 GoTry／hotel-be／hotel-fe SHA。
**输入与输出：**获准四 surface 环境 → 真实库存／恢复／Checkout／QueryOrders 证据；不激活 M5。

- [ ] 对账已交付权威及就绪工作，固定实际部署版本、主机身份与供应商／UAT 范围。
- [ ] 覆盖 tenant／customer／storefront／payment-link；在真实库存上观察 typed availability 迁移，至少完成一次 unavailable／changed 报价的重新搜索及新 CheckAvail 恢复。
- [ ] Book 继续归现有 Checkout，仅在其已授权 UAT 范围内执行；保留 unknown→QueryOrders 对账与进程清理证据，不为凑验收新增 GoTry 供应商写路径。
- [ ] 环境或业务授权缺失时，该线等待，T1–T6 继续。#136 生产准入与 #137 试点仍是独立门禁。

## 6. 验证与交接

#582 集成源码在关闭真实供应商及会话开关的情况下通过 `scripts/run-all-tests.sh`（退出 0，`ALL SUITES GREEN`，运行时 Node 26.9.0）。定向类型检查、smoke 及改动套件也通过；发布分类共 159 项断言。可选 Agent Reach 安装、STAICLI tarball 证明及真实探针保留明确跳过项。最终文档改动通过双语及可读性门禁。

既有定向命令，从仓库根执行：

```bash
cd ts
npx tsx scripts/itinerary-deck-tests.ts
npx tsx scripts/itinerary-deck-artifact-tests.ts
npx tsx scripts/itinerary-deck-export-tests.ts
npx tsx scripts/gotry-try-demo-tests.ts
npx tsx scripts/share-tests.ts
npx tsx scripts/recall-tests.ts
npx tsx scripts/session-link-tests.ts
npx tsc --noEmit
npx tsx scripts/smoke.ts
cd ..
node scripts/check-docs-i18n.mjs
node scripts/check-doc-readability.mjs
GOTRY_SESSION_LIVE=0 GOTRY_HBCLI_LIVE=0 GOTRY_HOTELBYTE_SKILLS_LIVE=0 ./scripts/run-all-tests.sh
```

每个实现 PR 附准确测试 SHA、命令、退出结果、明确跳过项和剩余真实验收门禁。CI 取消既不证明代码失败，也不证明门禁通过；本地及远端证据分开报告。遵循既有合并／发布授权，已知红测不得合并。

本次交付覆盖 T0–T3 工程与 T6 准备。回读 #577 合并及关单回执，推进已准入的 T4–T7 证据路线；商店动作继续遵循已有发布授权。不同文件可采用独立实现／审阅路线，由一位集成负责人收口。按上述完成标准执行到合并及关单。定时任务、发布及产品状态写入仍遵循各自范围与授权。
