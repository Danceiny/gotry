# GoTry 技术文档(唯一技术权威面)

> 定位:本仓的**完整技术文档**——系统是什么、怎么构成的、每个模块在哪、怎么跑、往哪演进。
> 读者:接手或维护本仓的工程 agent 与人。想知道「现在是什么形态」看 §1,「为什么这么定」看 §8,「该接什么活」看 §10。
> 纪律:单一文件承载单一关注点,版本历史归 git,不设 vN 文件后缀;上游为总纲(`gotry-master-outline.md`)与产品设计(`gotry-product-design.md`)。
> 下游:loopx todos 依本文§9 演进阶段与§10 债务清单派生;引擎/求解器细节工作只在债务清单标注时进行。

**目录**

| | | | |
|---|---|---|---|
| [1 系统是什么](#1-系统是什么) | [2 总体架构](#2-总体架构五层与现状) | [3 代码地图](#3-代码地图每个模块是什么) | [4 统一行程模型](#4-统一行程模型领域核心唯一求解入口) |
| [5 对话循环](#5-对话循环l2) | [6 数据与运行时](#6-数据与运行时) | [7 测试与验证](#7-测试与验证策略) | [8 ADR](#8-adr) |
| [9 演进](#9-演进时间线唯一来源-roadmapmd-的-m0-m6此处只保留原则与现状) | [10 债务清单](#10-债务清单引擎细节工作只能来自这里) | [11 保鲜机制](#11-保鲜机制文档与现实的同步纪律) | [12 文档地图](#12-文档地图) |

---

## 1. 系统是什么

> 本节只回答「系统**现在**是什么」。「什么时候发生了什么、为什么改」一律归 §9 演进与
> `release-notes.md`——本节出现日期叙事即为错位(§11 保鲜纪律第 4 条)。

**GoTry 是「从出发到下一次出发」的 AI 旅行 Agent**:动机访谈进、已验证的行程方案与选择题出;LLM 负责理解与解释,确定性组件负责判定与算术,写操作永远有闸。

M3 最小可用产品,分发链路无已知堵点。

### 1.1 交付形态与入口

| | |
|---|---|
| 入口 | `./gotry`(仓内)或 `npx @danceiny/gotry@latest web`(npm) |
| 运行时 | dsh 成品形态,DeepSeek 原生 |
| 版本 | 见 `package.json` 与 `release-notes.md`;**`rc` dist-tag 已指向最新 rc(2026-09-02 #50② 完成),`@rc` 可用;用户引导仍优先 `@latest`** |
| License | MIT |
| 人格 | 行为契约 21 条;锚点卡与记忆 brief 注入 persona。**运行时组合唯一来源 = 仓根 `cordis.gotry-patch.yml`** |

### 1.2 能力面

工具面注册于 `ts/src/index.ts`(**清单与计数以代码为准,此处不落数字**——§11 保鲜清单第 4 条):

- **判定类**:可行性、骨架校验、航班校验、**产物事实闸 `gotry_fact_gate`**(交付前必过,blocked 不得宣称「已验证方案」)
- **检索类**:酒店(hbcli 桥)、天气、Anything 通用搜索、网页、视频字幕、GitHub、飞猪官方检索(机/火/酒)、会话检索
- **记忆类**:动机、愿望池(入池/召回)、旅行时间线、同行人
- **产物类**:产物 list/read(账本工单交付 + 工作目录 md,只读)
- **账号类**:会话登录 `gotry_session_login`(在用户 Chrome 弹登录入口,票据 cookie 名零值过手)
- **回合类**:`gotry_turn_handoff_list` 后台深度规划工单复访查询(只读;open=后台规划中/ETA,settled=交付物摘录,failed=诚实失败说明;收集结算由 `scripts/turn-handoff-collect.ts` 驱动,ADR-24 v2)
- **外联**:AgentReach wrapper(上游装于 `.venv`,反射桥 `agent-reach-bridge.py` 直调上游注册表,零渠道知识)

**工具面无预设路由优先级**(persona (19) 已删「三级路由」改平铺),证据链逐源标注。

数据接入:机票三层(骨架 168 对 + 校验桥 + 锚点)、酒店 hbcli 桥(实时/静态降级 + 证据标注)、OpenSky 实时 ADS-B、Open-Meteo 天气、飞猪 FlyAI 官方只读通道。

### 1.3 账号会话与授权闸

- **授权闸**:`tools/pre-execute` 监听器(`session-consent.ts`)在**每会话每站点首次调用**时经 dsh 原生 ApprovalService 请求授权。allowed-once 记入会话 granted 集,会话内后续调用免弹;**用户拒绝 = 本会话吊销**,不再弹卡也不再执行。无审批通道 / headless 一律 **fail-closed 拒绝**。
- **开关**:插件 config `sessionAccess: ask|allow|off`(随时可关 / 明示预授权 / 总闸关闭)——RFC 支柱④「用户明示授权 + 站点白名单 + 随时可关」进代码。
- **登录**:`capabilities/session-login.ts` 在用户 Chrome 弹登录入口,登录**永远在外部网站完成**;登录引导页不挂 ReadGuard 是唯一豁免面(检索面不变量不变)。
- **只读不变量**:ReadGuard 方法×URL 双因子写拦截 + 审计 + fail-closed;节律闸;证据链 `[会话:*]`。

### 1.4 事实性与状态基座

- **可下单事实单一数据源**(ADR-19):`ts/src/bookable-facts.ts`(`gotry_bookable_fact.v1`,纯函数)——flyai/session exact-date 工具结果逐条落账,hit 正事实 / miss 负事实,query_id 可重放,IATA 归一;四层证据 tier **永不合并**。**exact-date miss =「未确认/当前不可售,到 D-xx 复核」**,禁止用历史班期/相邻日期/航线页回填。
- **状态权威 = 单文件 SQLite 账本**(ADR-15,`ts/src/state-ledger.ts`):events append-only + 投影 fold 可重建 + 红线进事务 + 工单 durable 恢复(exactly-once)+ pending_writes saga。旧 JSON/JSONL 降级为单向导出视图。
- **双形态冻结**(ADR-16):本地 + Web 一套账本语义,`tenant_id` 一等字段,同步 = 事件复制而非状态翻译。
- **预订 saga 词汇层**(ADR-17,`ts/src/booking-saga.ts`):状态字母表与 pending_writes CHECK 逐字一致。
- **异步终态合同**:`gotry_async_terminal.v1` 将 4/4 映射为 `succeeded`/ledger `settled`/exit 0,非 4/4 映射为 `failed`/ledger `failed`/exit 2;终态复诵返回同一结构化结果与退出码且零重算。

### 1.5 记忆域与时间感知

- **记忆域六层**(设计见 `memory-design.md`):动机 brief 读回 persona、效用 sidecar(归因只认 owner 确认)、愿望池 0..1 召回(`gotry_wish_pool_list`)、旅行时间线(`gotry_trip_log`)、同行人档案(`gotry_companion_save`)、时间窗衰减(只降不删/地板 0.1/动机零衰减)。度量与触达:`scripts/memory-metrics.ts` 只读投影 + `scripts/nudge-digest.ts` 主动回访(`GOTRY_NUDGE_ENABLED=false` 可全局关闭)。
- **时间感知**:确定性锚点层 `ts/src/time-anchor.ts` + 槽位抽取 `travel-slots.ts` + 槽位→日期解析 `slot-spec.ts`。**算术进代码,LLM 查卡不自算**。

### 1.6 工程不变量

- 工具 execute 统一经 `guardToolExecute` 异常隔离 + 平铺观察 envelope(ADR-13)。
- Agent 工具循环的预算闸是「路由 + wall-clock 双出口」(ADR-24 v2):`ts/src/turn-policy.ts` 在每个 user/message(source.kind=user;plugin/skill 注入不参与)落地时用确定性分类器(纯函数、零 LLM、零 IO;Tier 0 信号=日期跨度/约束词/消息长度,`loop.ts` 的 isComplex 不在产品路径、不进此层)把本轮分为 quick / sync-planning / deep-planning,并产出 `TurnPolicy={softMs,hardMs,exit}`——复杂度决定**出口结构**:quick/sync 到点 converge(用已有证据作答),deep-planning 同步窗口只够摸底+落单,硬阈出口 handoff。`ts/src/turn-deadline.ts` 在 `tools/execute` 越过硬阈时**同步**抑制继承工具 schema(2026-09-02 轨迹教训:延迟到 `step/end` 会让模型在同一 step 内回环拒绝结果直到 token 截断),并按 exit 返回两种结构化结果:converge=`TURN_DEADLINE_EXHAUSTED`;handoff=落 `gotry_turn_handoff.v1` 工单(`<stateRoot>/gotry-state/turn-handoffs/`,独立格式独立目录——async-collect 对无 spec state 会假失败,handoff 收集器是未来的 loopx agent tick)并指令模型告知用户 ETA(约 1 小时,S5 文案)与回访方式。软阈注入 `TURN_DEADLINE_SOFT`(converge=收敛作答;handoff=收尾摸底)。三态出口保证任何一轮终结于「当面答完 / 转后台承诺 / 收敛作答」,不允许流死掉。转后台承诺由收集器兑现:`scripts/turn-handoff-collect.ts` 派生 GOTRY_HANDOFF_CHILD 子会话(唯一出口 converge,防递归)产出交付物并结算工单,复访经只读工具 `gotry_turn_handoff_list` 查询。Benchmark opt-in 不走路由,钉死 `{60s,120s,converge}` 固定 policy 保可复现;`GOTRY_TURN_DEADLINE_SOFT_MS`/`_HARD_MS` 是评测/E2E 专用数值 pin(不改出口语义),`GOTRY_TURN_HANDOFF_ROOT` 是工单隔离根 seam(source 模式 dsh cwd 是创始人真实数据目录,测试必须钉)。无 agent 的程序化调用不计,turn/session 终态释放状态与限制。CI 先打当前 SHA 的 tarball、在隔离 pnpm consumer 中解析 dsh peer closure,再把该安装入口交给同一 E2E,不借 root 开发树冒充发布形态。
- 外部依赖走**效应描述 + 解译器**(ADR-18):工具层只产纯数据效应值 `{effect, params}`,渠道访问/退避重试/断路器/编译期 mock 收敛到 `ts/capabilities/effect.ts` 与 `resilience.ts`。
- **HotelByte embedded Booking Copilot 是只读协作面，不是 M5 写闸启封**:`booking.surface.v1` 与 `booking.surface.v2` 共享同一 BFF listener、task ownership 与闭合 typed read-action profile；v2 通过 version+schema hash 逐请求 dispatch。生产 standalone 默认运行 `bff-bound-turn-only`，只接受 deployment-key 认证且已由 BFF 绑定的 `user.turn`/receipt continuation；浏览器 `user.turn.ingress` 只有在完整 authenticated principal/scope + BFF trusted binding seam 下才开放，并原子解析为服务端生成的 `taskId + turnId + contextRef + surface + allowedActions`。bound-turn-only 模式对 ingress 在 ledger/planner 副作用前返回 typed 503；GoTry 不接受浏览器自赋身份或能力。v2 durable ledger 投影包含六个生命周期阶段、七个 phase 字面值（`terminal`/`error` 为两种终态结果），v1 保持 legacy 两态投影；must blocker 只能由绑定 task/context/source turn/action/receipt/presentation key、随机 delivery nonce 与 option digest 的一次性 approval 放行。部署候选固定 exact GoTry SHA/schema 与 Linux glibc + Node 24/ABI provenance，鉴权 health 回显实际进程 identity 与 ingress mode；四 surface 真实库存、不可订重试链与原 Checkout/订单观察仍是外部 UAT gate，未通过前不得宣称产品验收或可合并。
- py 树仅剩 `gotry_feasibility` oracle,产品运行时零 Python 依赖(D-7 清偿)。
- Phase 1 外部 benchmark bridge 默认关闭:仅接受当前 POSIX uid 持有、非 symlink、非 group/world-writable 的绝对 config,固定 executable/cwd/argv 与有限 allowlist,无任意 shell;runner 只收到最小环境，模型参数与输出结构有界，gold/oracle/expected answer/score 等键递归 fail-closed；adapter admission 可按工具配置 `allowed_output_keys` 正向键合同，visible result 出现未声明键即拒绝且不反射。opt-in 只允许 cold-start + headless one-shot：发现 live agent 即拒绝；每个 agent 强制 native、root-captured `gotry_benchmark_environment` definition-only，最终 prompt assembly 与 downstream `agent/pre-step` 双重重验 exact schema/definition，额外工具、同名 shadow 或 PTC transport 漂移均在模型请求前 fail-closed；局部安装自动回滚，agent disposal 释放 scoped effect；若插件先卸载，live agent 保留 fail-closed quarantine，直至 agent/process disposal，HMR 不得在旧 agent 上热挂。Round 3 的 agent conformance 层把 CLI/shell 叙述翻译为 native `query.action=call` 合同，只有 allowed call 的配对成功 result 之后才接受 owner-local `terminal_output` 指定的单一 tagged JSON object；缺 call 或坏终态最多一次模型纠偏，格式纠偏不得重复派发 bridge，第二次失约稳定 fail-closed。parent CLI 对 stdout 有界缓冲并用同一 parser 二次验收，失败正文不出门。config 的 writes forbidden/network denied 仍由 owner/host OS enforcement，synthetic E2E 不证明 OS sandbox；bridge 不携带 hidden query loader，也不把 Python harness 变成产品依赖。Round 2 唯一冻结 treatment 为 diagnostic-only：provider preflight 与 planner exit 0，runner exit 3，evaluation/official scores 为 null，暴露的正是 CLI prompt 与 bridge-only 工具/终态合同不一致；Round 3 尚无新官方分数，不声称 uplift 或 external benchmark closure。
- Round 3 新冻结 treatment 的 provider preflight 通过且 runner 只派发一次，但 planner/runner 均 exit 1，3.796 秒内停止，parent 释放 0 字节，evaluator 未进入，official scores 仍为 null。Round 4 因而在任何 optional host plugin 解析前把已验证 config 的顶层 insert 投影为唯一 `gotry-tools`，并对 insert 块、gotry plugin name 与 config-path anchor 做唯一性检查；inline/reordered/第二 insert/未来插件、spoofed name、缺失或重复锚点均在 relay 前 fail-closed，default-off 组合不变。Round 4 treatment（SHA `5ebddb2`）primary preflight=pass，但 planner/runner 均在 30.968s 以 exit 1 结束，parent 释放 0 字节，evaluator 未进入，official scores 全为 null；产品 gate 使用 Node v24.20.0，而 treatment 使用 v26.3.0，因此仅 diagnostic-only、无 uplift。GitHub Node 22/24 §48 另暴露 source default-off 30s lifecycle hang。Round 5 仅限移除 timer/keepalive preload、将锁定的 DSH runtime closure 设为 alpha.3、保留源码普通运行的 `ts/dsh-runtime/gotry-state/` 状态连续性、让 benchmark/package 用调用目录隔离，并增加 benchmark-only 结构化诊断 pipe（allowlisted redacted reason codes），stdout 继续 fail-closed；其 frozen treatment（代码 SHA `752e54c`）在 140.715 秒后以 `child_nonzero_exit`、0 terminal bytes、evaluator/official scores null 停止，仅 diagnostic-only，后续纯 lock-consistency 提交不改写该 UID 归属。source 与 clean-package poison E2E 只证明启动合同，不构成 benchmark uplift。
- Round 5 package closure 不变量:package.json、package-lock 与 root pnpm importer 的 DSH 名称集合必须同为 216，且全部以同一 `0.1.2-alpha.3` 精确直接依赖进入 tarball；publish preverify 对漏钉、混版和 range 声明 fail-closed，避免 clean npm/pnpm consumer 在上游发布新 alpha 时产生 prerelease 混装。
- Round 6 将 benchmark child 的最终 `turn/end.reason` 映射为闭合、脱敏的粗粒度诊断枚举，并通过 per-session 单写仲裁保证 bridge/conformance 专项原因优先于随后出现的通用 runtime 原因。分类只读取结构化 `kind`、allowlisted `code` 与有限 HTTP `status`，不读取或反射 message、stderr、路径、prompt、request id 或凭证；模型重试仅以最终 `turn/end` 为准，恢复成功不产生失败诊断。代码 SHA `c61600b` 的 ChinaTravel frozen treatment（`..._00001`，`deepseek-v4-flash`）在 49.546 秒后稳定报告 `child_runtime_error`，0 terminal bytes，evaluator/official scores null，leakage 与本地凭证/端点扫描均为 0。stdout、重试策略、prompt、工具执行与评分逻辑不变；该工程变化与诊断证据本身不构成 benchmark uplift。
- **Round 7 minimal kernel（代码 SHA `edb9392896625adbb48abae4a2ecf968dbfc0349`）**：benchmark opt-in 仅保留 tool budget、model override、唯一 bridge、tool isolation/conformance；产品 prompt variables、process guards、consent hooks 与普通 GoTry tools 均不装，默认路径不变。CLI 对 system-prompt 做稳定、task-agnostic persona 投影，并要求 root patch 仅含 canonical `- insert:` 与 `- id: system-prompt` 各一；缺失、重复、quoted/reordered/flow/noncanonical root item 均 fail-closed。ChinaTravel frozen treatment UID `e20241028160248698752`（case `easy`，`deepseek-v4-flash`）preflight pass、未回退，80.463s 后 runner exit 1，terminal 0 bytes/invalid，evaluator 未进入、official null、不可计分、无 uplift/外部 benchmark closure；白名单归因为 `child_bridge_runner_failed`。下一轮聚焦 generic bridge tool schema 与可恢复 domain-error contract，不改 provider routing/scoring。
- 全栈回归见 `scripts/run-all-tests.sh` 分节(计数不落字)。

### 1.7 里程碑口径(Issue #19)

M3 工程与分发面已就绪,**但真实种子用户 evidence 未收口,M3 Exit 仍开放**。M4 由 founder 授权并行推进,Issue #20 scorer 已落地而真实 `observed_private` N≥5 仍缺——**这些 M4 切片不构成 M3 Exit 证明**。M5/M6 仅在各自 Entry gate 满足后启动。

证据面现状:`ts/scripts/product-metrics.ts`(M3 cohort)与 `ts/scripts/memory-value-report.ts`(M4 价值)固化了样本窗/纳排/分母/归因与阈值,输入只接受 HMAC-SHA256 假名键且未知字段 fail-closed;synthetic fixture **永不产生 business pass**。真实证据只进入被忽略的 `ts/gotry-state/evidence/`。

Evaluation Phase 0 foundation boundary: contracts/registry/validators/unmatched diagnostic fixtures/test-only aggregate admission plus a deterministic PR/nightly/weekly/milestone cadence policy/planner. It returns admission, `pass^k`, budgets, calibration, failure-registry, and cross-benchmark synthesis obligations only; it does not schedule or launch adapters, spend, generate a benchmark score, create an Agent optimization round, or support an uplift claim. No external runner, Python runtime dependency, baseline, or matched production evidence is included.

Phase 1 外部 benchmark bridge 默认关闭:owner-local config、固定 direct argv/allowlist、最小 runner 环境、参数/输出结构上限、递归 no-oracle 键拒绝与可选 per-tool `allowed_output_keys` 正向键合同都由产品 seam 执行；opt-in 仅接受 cold-start + headless one-shot，并把每个 agent 固定为 native、原始 bridge definition-only，最终 assembly 与 downstream pre-step 任一 surface 漂移都 fail-closed。Round 3 conformance 把 prompt 中 CLI/shell/Python 操作映射为 allowed native `query.action=call`，只有配对成功 result 后才接受 owner-local `terminal_output` 指定的单一 tagged JSON object；缺 call 或坏终态最多一次纠偏，格式纠偏不再派发 bridge，headless parent 用同一 parser 二次验收 stdout。agent disposal 释放 scoped effect；插件先卸载时 live agent 保持 quarantine 至 agent/process disposal，HMR 不热挂。writes forbidden/network denied 仍必须由 owner/host OS enforce，synthetic E2E 不证明 OS sandbox。bridge 不携带 hidden query loader,不把 Python harness 变成产品依赖。Round 2 唯一冻结 treatment 只得到 diagnostic-only 终态，evaluation/official scores 为 null；Round 3 尚无官方分数。

Round 4 startup composition 只在 benchmark opt-in 生效：config 先验证，patch 顶层 insert 再投影为唯一 `gotry-tools`，随后才允许继续启动；任何第二 insert、伪装 gotry name、allowlist/config-path anchor 缺失或重复都以稳定泛化错误在 relay 前拒绝。普通 GoTry default-off 的 calendar/map/ask-user 与未来插件组合保持原行为。Round 4 treatment（SHA `5ebddb2`）primary preflight=pass，但 planner/runner 均在 30.968s 以 exit 1 结束，释放 0 字节，evaluator 未进入，official scores 全为 null；产品 gate 使用 Node v24.20.0，而 treatment 使用 v26.3.0，因此仅 diagnostic-only、无 uplift。GitHub Node 22/24 §48 另暴露 source default-off 30s lifecycle hang。Round 5 仅限移除 timer/keepalive preload、将锁定的 DSH runtime closure 设为 alpha.3、保留源码普通运行的 `ts/dsh-runtime/gotry-state/` 状态连续性、让 benchmark/package 用调用目录隔离，并增加 benchmark-only 结构化诊断 pipe（allowlisted redacted reason codes），stdout 继续 fail-closed；其 frozen treatment（代码 SHA `752e54c`）在 140.715 秒后以 `child_nonzero_exit`、0 terminal bytes、evaluator/official scores null 停止，仅 diagnostic-only，后续纯 lock-consistency 提交不改写该 UID 归属。

Round 6 只观察最终结构化 `turn/end`，以 per-session 单写仲裁把失败投影为闭合、脱敏的 coarse enum，bridge/conformance 专项原因优先，恢复成功的 transient retry 零失败输出。代码 SHA `c61600b` 的 ChinaTravel 冻结 treatment（`..._00001`，`deepseek-v4-flash`）在 49.546 秒后稳定报告 `child_runtime_error`，0 terminal bytes，evaluator/official scores null，leakage 与本地凭证/端点扫描均为 0。该结果只消除了 `child_nonzero_exit` 的归因歧义，不产生 score/uplift 结论；后续纯文档 successor 不改写 treatment 归属。

## 2. 总体架构:五层与现状

```
L1 交互:对话即界面(gates 以消息内选择题呈现;独立 UI 属 Stage 1 后)
L2 编排:对话循环 ts/src/loop.ts —— LlmPort(mock✅/真✅ provider-neutral) + 确定性访谈 + 求解挂载
    └ dsh 插件 gotry-tools:✅ 已在真实 dsh headless 运行时端到端(68ea364 rc.1 起实证;2026-08-29 曾用 vendored `0.1.2-alpha.1`;Round 5 起 source/package 共用 root-pinned `0.1.2-alpha.3`)——模型经 pi-ai(MiniMax-M2)主动调用 gotry_feasibility_check 并引用引擎数字;组合见 cordis.gotry-patch.yml(bin/gotry-inner.js 运行时生成;ts/ 下旧副本已退役 2026-08-28)
L3 领域:统一行程模型 ts|py unified.* —— Segment/Option/锚点/工作窗口/时区
    └ 可行性引擎:Z3 选择 + 命名约束 + unsat core 归因 + Optimize 最优
L4 数据:静态数据包 data/*.json(真实班期+估算价,证据标注)+ 金标准用例
L5 治理:loopx(objective/gate/evidence/quota,验证后才花费)
```

| 层 | 职责 | 契约 | 不变量(任何演进不得破坏) |
|---|---|---|---|
| L1 | 呈现与采集 | 透明卡片 schema(D1 §6) | why/cost 必达用户;gate 只能是选择题 |
| L2 | 理解与编排 | `ts/src/contracts.ts`(TripState+五工具) | LLM 不做算术判定;写操作必过 WriteGate |
| L3 | 判定与核算 | 统一行程模型(§4)+TrueCost | 算术与求解分层;算术纯函数可独立测试 |
| L4 | 数据与能力 | CLI/JSON 桥(hotelbyte-cli 式) | 证据链标注([实时API]/[共享经验]/[估算]);估算必须显式标记 |
| L5 | 治理 | loopx 状态 | 验证后才花费;阻塞记录而非空转 |

数据流(洱海金标准,一次调用走完全程):

```
素材(照片+一句话)→ 动机访谈(确定性缺失字段驱动)→ JourneySpec 抽取
  → solve_unified(Z3 选班,锚点/工作窗口/预算命名约束)
  → {verdicts, exclusions(带理由), red_flags, 最优预算} → 渲染(卡片+gates)
  → 不可行候选 → wish pool(成行条件:天数/预算/季节)
```

## 3. 代码地图(每个模块是什么)

| 文件 | 角色 | 状态 |
|---|---|---|
| `ts/src/contracts.ts` | 顶层数据与工具契约(TripState/五工具 IO/wire schema) | 草案,待创始人走查 |
| `ts/src/loop.ts` | 对话循环:runTurn/interviewNext/异步深度规划(request/collect+不失望四条) | ✅ 重放验证 |
| `ts/src/mock-llm.ts` | 剧本 LLM(ADR-8):确定性重放真实对话的智能侧 | ✅(S4 后留作回归夹具) |
| `ts/src/unified.ts` | **统一行程模型 TS 版(唯一求解入口)**:Segment/Option/时区/工作窗口+Z3 求解(航班链)+枚举求解(候选形态) | ✅ 4/4+候选对账 |
| `ts/src/model.ts` | 门到门全成本算术(纯函数,单候选形态) | ✅ |
| `ts/src/engine.ts` `journey.ts` | 旧两套求解面(纯 oracle,金标准对照) | **deprecated** |
| `ts/src/index.ts` `bridge.ts` | dsh 插件(纯 TS unified 求解 + hbcli 桥 + 进程护栏,延迟计量) | ✅ smoke |
| `ts/src/turn-policy.ts` `turn-deadline.ts` | Agent 每轮「路由 + wall-clock 双出口」:确定性分类(quick/sync/deep,零 LLM)→ TurnPolicy;越硬阈同步抑制 schema,converge=EXHAUSTED / handoff=落 `gotry_turn_handoff.v1` 工单+ETA 告知;benchmark 钉固定 policy | ✅ run-all §45 |
| `py/gotry_feasibility/unified.py` | Python oracle(v0.0.1-rc.2 后**仅历史对照**,不再被产品运行时引用) | 保留 |
| `py/gotry_demo/` | **已删 2026-08-22**(D-7 尾债:demo 规划书生成器曾调废弃 journey.solve_journey;产物 docs/demo-plan-2026-07-17.md 留 git 历史) | — |
| `ts/scripts/replay.ts` `replay-async.ts` | **验收夹具**:真实对话重放(13 轮→3 轮)与异步形态 | ✅ |
| `ts/scripts/{engine,journey,unified,diff}-tests.ts` | 套件(8/5/4 断言+TS-vs-TS 同 spec 稳定性) | ✅(diff-test 顺序偶发为已知问题,v0.0.1-rc.2 后不再依赖 Python) |
| `ts/src/time-anchor.ts` | **时间锚点层**(ADR-12,纯函数):锚点卡渲染(今天/相对周/月分段/季度/节日)+ 绝对月日解析;persona 与抽取链路的「今天」唯一来源 | ✅ time-eval §1 |
| `ts/src/travel-slots.ts` | **槽位抽取层**(travel_slot_extraction.v1):schema + 抽取 prompt + 过期校验 + language 检测 + 评分器;逐字保留,判定归代码 | ✅ time-eval §2-4 |
| `ts/src/slot-spec.ts` | **槽位→日期解析层**(D-10 切片 A):锚点卡词表 + 绝对表达 + 「+N」后缀 → YYYY-MM-DD;词表外 unresolved 逐字保留(ADR-12 边界:不做开放式解析);spec 日期一致性闸 | ✅ time-eval §5 |
| `ts/src/tool-packet.ts` | **工具观察 envelope**(RFC S1/ADR-13):GotryObservation 平封形状 + ToolFailure + interpretArgs 参数三形态归一唯一入口 | ✅ smoke §9 |
| `ts/src/memory-utility.ts` | **记忆效用 sidecar**(RFC S2/ADR-14):recalled/applied/verified_outcome 事件 + 幂等追加 + 只读投影;归因只认 owner 确认 | ✅ smoke §10 |
| `ts/src/memory-decay.ts` | **时间窗衰减原语**(memory-design P3):30/90/180/365d 分级因子(地板 0.1)+ 种类权重 + 新鲜置信度;动机层零衰减为构造性保证 | ✅ run-all §23 |
| `ts/src/companions.ts` | **同行人档案**(memory-design P2):upsert 合并 + 负面清单守卫(证件/电话零入库);约束只进排序 | ✅ run-all §21 |
| `ts/src/travel-timeline.ts` | **旅行时间线**(memory-design P1):trips.jsonl append-only + 幂等/重叠冲突即停 + verified↔timeline 交叉一致 | ✅ run-all §20 |
| `ts/src/wish-pool.ts` | **愿望池匹配纯函数**:条件评分 + 0..1 挑选(muted 排除/确定性 tie-break);wish_pool_list 与 nudge 共用 | ✅ run-all §21 |
| `ts/capabilities/flyai.ts` | **FlyAI 官方通道**:飞猪 8 只读工具的管道层(search-flight/train 先接),证据链 `[实时API:flyai@ts]` | ✅ run-all §24-F |
| `ts/capabilities/session-search.ts` + `session/` + `extension/` | **会话检索面**(RFC P1-P3.5):传输=扩展桥 PRIMARY(`extension/` MV3 + `extension-bridge.ts` 回环桥,零新依赖)/cdp 显式后备(ReadGuard 写请求物理拦截+审计,fail-closed)/persistent 测试;携程机票适配器(batchSearch 嗅探)/action-cache 自愈层(变量化key+指纹被动失效+miss回写);节律闸;`[会话:*]` 证据链 | ✅ run-all §25/§38 |
| `ts/capabilities/session/extension-distribution.ts` + `ts/scripts/extension-distribution-cli.ts` | **扩展分发通道**(ADR-21 分发 A):GitHub Releases 下载链(稳定资产名/dist-manifest fail-closed 解析/SHA256/平台 tar 解压/key 钉扎/版本比较/原子交换),失败显式降级 bundled;CLI 单行 JSON 供 bootstrap spawn | ✅ run-all §43 |
| `ts/capabilities/artifacts.ts` | **产物面**(issue #25 最小切片):产物发现(账本 workflow_runs 权威 + 无账本回退 async 目录视图 + dsh 工作目录顶层 md)+ 行号窗口读取(dsh read 卡);只读,路径/扩展名白名单 | ✅ smoke §13 |
| `ts/capabilities/effect.ts` `ts/capabilities/resilience.ts` | **效应解译器 + 韧性原语**(effect_interpreter.v1,issue #16 采纳/ADR-18):效应值注册表(渠道 handler+策略表)+生产/mock 解译器(渠道 observation 原样透传+trace 横切证据)+ 指数退避(withRetry)/断路器三态(CircuitBreaker);已接 flyai/hotel/session/weather/flight_verify 五工具与 realtime-pricing 默认查询口,余下渠道走 D-23 增量迁移 | ✅ run-all §37 |
| `ts/src/state-ledger.ts` | **事务化状态账本**(ADR-15):SQLite 单文件唯一权威(events append-only+语义幂等键/投影表 fold 可重建/workflow_steps durable 工单/pending_writes saga)；`gotry_async_terminal.v1` 固化 4/4/非 4/4 终态、退出码与零重算复诵;守门纯函数复用为写路径与 fold 处理器;读路径带旧文件回退;首写自动 one-shot 迁移+快照 | ✅ run-all §28 |
| `ts/src/booking-saga.ts` `ts/scripts/booking-saga-tests.ts` | **预订 saga 状态机词汇层**(booking_saga_fsm.v1,issue #17 采纳/ADR-17):状态字母表+四条边全函数边表+结构化拒绝闭集+审计链校验;§36 与账本 saga 基座逐格物理对账 | ✅ run-all §36(纯函数,零写路径接线) |
| `ts/src/bookable-facts.ts` | **可下单事实模型**(gotry_bookable_fact.v1,issue #46/ADR-19,纯函数):事实 schema(route/exact local date/航班号/营销+实际承运/机场/价格/来源/query_id/置信 tier/bookability 四态)+ flyai/session 结果转换器(hit 正事实/miss 负事实/error 不落)+ IATA 归一 + 判定原语(claim 可述性 fail-closed/同日衔接硬约束/夜数·O&D·预算不变式/迂回检测)+ 渲染原语(codeshare 双承运/落 DMK 注记/不可售措辞/联程仅 protected_connection) | ✅ run-all §39 |
| `ts/src/artifact-gate.ts` `ts/capabilities/fact-log.ts` | **产物事实闸 + 事实侧车**(issue #46/ADR-19):markdown 可下单 claim 反向抽取(航班号/承运直飞/中文承运名/机场映射/政策「截至」语境/✓/联程断言,小节上下文继承)→ 逐条回溯注册表(not_in_source/route_unqueried/时刻矛盾/联程违例等 12 类违例);第 21 工具 `gotry_fact_gate`,blocked 不得宣称已验证;fact-log 落 `<stateRoot>/gotry-state/bookable-facts.jsonl` 侧车(永不阻塞检索主路径) | ✅ run-all §39 + smoke §16 |
| `data/airline-airports.json` `ts/data/golden-trip-2027-facts.json` | 航司→机场映射 + 城市→IATA 词表(gotry_airline_airports.v1,as_of 快照+review_by):FD=DMK/VZ=BKK 冲突检测面,闸加载缺失即 fail-closed;golden fixture=issue #46 审计值锁定的 2027 行程事实集(11 查询)+ 好/坏行程不变式对 | ✅ run-all §39 |
| `ts/scripts/state-cli.ts` | **账本操作面**(ADR-15):migrate/export(视图单向)/log/stats/rebuild/rewind/forget(物理硬删带审计)/tick(回收 pending 工单)/whatif(VACUUM INTO 分叉)/pw-*(WriteGate saga CLI 面) | ✅ run-all §29 |
| `ts/scripts/product-metrics.ts` `ts/data/product-metrics-fixture.json` + `ts/scripts/nightly-evidence.ts` `ts/data/m3-nightly-prompts.json` `ts/data/llm-price-table.json` | **M3 cohort 证据评分面 + nightly 证据生产器(Issue #22)**:阈值冻结 manifest + 脱敏 cohort/nightly schema + 定稿率/NPS/POI 幻觉率 scorer； **详见下方「ts/scripts/product-metrics.ts ts/data/pr」** | ✅ run-all §33/§35；真实 cohort 待收集,nightly 真跑记录待凭证环境执行 |
| `ts/scripts/time-eval-tests.ts` `data/time-slot-eval.json` | 时间感评测(25 题):确定性部分进 CI,`--real` 真模型巡检(只读报告) | ✅ 真模型 25/25 |
| `data/golden_erhai.json` `flights_2026.json` `hotels_2026.json` `golden_trip_2026.json` `行程细化计划.docx` | 金标准用例/班期/住宿/完整任务/Kimi 对话原件 | — |

**ts/scripts/product-metrics.ts ts/data/pr**
- **M3 cohort 证据评分面 + nightly 证据生产器(Issue #22)**:阈值冻结 manifest + 脱敏 cohort/nightly schema + 定稿率/NPS/POI 幻觉率 scorer；fixture 与真实证据分流，未知字段 fail-closed；nightly 生产器封存 prompt 集与价表(peak 保守上界,未知模型 fail-closed)、无凭证 waiting/backoff/no-spend、超预算退 3,记录写入前必过消费方 parseNightlyRun


## 4. 统一行程模型(领域核心,唯一求解入口)

```
JourneySpec = { segments, budget?, workWindow?, 默认起床线, … }
Segment     = { id, role: choice|fixed, anchors{arrive_by/depart_after/…}, options[] }
Option      = { id, move(services×transfers×缓冲×红眼×tz), stay?(晚数/价格/work_window), score, min_days }
```

- 两种形态同一模型:候选选择(洱海=1 段 3 目的地 Option)与段链(demo=5 段);旧 engine/journey 是其在单段/固定链上的退化,已 deprecated。
- **求解分层**:算术纯函数(`evaluate_*`:起床/到达/精力/有效时长/金钱)与 Z3 选择(命名约束,unsat core 归因,Optimize 最优)严格分离。
- **时区语义(D-5 已清偿)**:真实飞行=(到−发)−时差;门到门=前置+真实飞行+接驳(EK329 全链 11h20m,飞行 7h35m 与官网逐分一致)。
- **工作窗口(M-1 已落地)**:家时区→出发地当地换算;工作日窗口内起飞的 Option 求解前确定性排除,理由入记录——gate q3 被一条规则确定性回答(周五晚班全排除,只剩周六早,与真实选择一致)。
- **红眼睡眠模型**:精力=30+8×(飞行−1h),clamp[30,75];EK329 落地 75%(待对账 Q10 校准)。

## 5. 对话循环(L2)

`runTurn(state, msg, llm, solve)`:抽取事实(日历一次断言,冲突显式指出)→ 增量访谈(缺失字段驱动,workWindow/bookedResources 为求解前置,budgetTier 降为 gate 不阻塞)→ 约束齐备则 extractSpec→solve→渲染(方案+排除理由+红旗+gates 选择题)。复杂行程切**异步深度规划**(「一小时后回来看看」;回访交付自带不失望四条自检)。详细设计见 `stage1-top-down-design.md`。

**重放验收**(`ts/scripts/replay.ts`):Kimi 的 13 轮失败 = GoTry 3 轮;日历零反复;工作窗口与已订酒店首轮即被问出;终轮即已验证方案。

## 6. 数据与运行时

> **数据源唯一权威面 = `data-sources.md`**(2026-08-22 立):领域矩阵 × 四层架构(静态包/免费实时/hbcli 桥/OSM 生态) × Google Place 链路(hbcli→search OpenAPI→geography) × 证据链契约 × TREK 参考采纳。本节只留运行时概要。

- 运行时:三条已实证路径——①TS 进程内(自研循环,~6ms/解);②真实 dsh headless+cordis 组合(pi-ai→MiniMax,`cordis.gotry-patch.yml`,68ea364);**(v0.0.1-rc.2 起第三条** Python CLI 桥下线,纯 TS)。环境三件套 `LLM_API_KEY/LLM_BASE_URL/LLM_MODEL`(兼容旧 DEEPSEEK_*)。
- 复用落地:dsh(import,rc 已对齐)/loopx(import,0.5.1 运行中)/Z3(import,双绑定)/hotelbyte-cli(import+extend,place 链路见 data-sources.md §4)/travel_agent·ai-agent-book·TREK(reference,零代码——TREK 数据面模式采纳表见 data-sources.md §5)。

## 7. 测试与验证策略

**评测三层(ADR-11)**:
- **回归层(防退化)**:TS-vs-TS 双路径稳定性(同 spec 不同 module instance)+ 金标准断言(洱海 8+5、普吉链 4、统一模型 20/20)+ **重放夹具**(mock 重放即行为级回归,Kimi 对话是失败基线)。**v0.0.1-rc.2 起:** 不再依赖 Python oracle 差分;run-all-tests 9 套一次性绿,无需 Python 运行时。全栈入口:`scripts/run-all-tests.sh`。
- **质量层(防漂移)**:评测集+指标面板——POI 幻觉率、定稿率、不失望四条、NPS;M3 上线(见 `tech-strategy.md` §4),此前以 replay 终态断言兜底。
- **巡检层(防「mock 绿而真智能烂」)**:真 LLM 重放(`replay-real.ts`)的 nightly 形态已落地——`nightly-evidence.ts`(封存 prompt 集 + 封存价表,预算闸 `GOTRY_NIGHTLY_BUDGET_USD`,无凭证 waiting/backoff/no-spend 零写入,run-all §35;真跑花钱不进 CI,heartbeat/founder 手动执行)。产出 `gotry_m3_nightly_run_v1` 记录追加进**私有证据账本** `ts/gotry-state/evidence/m3/cohort.jsonl`(git 忽略);`cost_usd` 只来自 dsh-llm 的 usage 累计器 × 封存价表。ADR-10 正是 mock 绿而真 LLM 烂出来的,教训制度化。

## 8. ADR

**生命周期**:提案 → 采纳 →(已清偿 | 被取代 | 退役);「永不复审」是显式终态类(ADR-7/9/10 依据的是不变量级判断)。**三个诞生渠道**:① 失败诞生——真实运行暴露 mock/推演看不见的问题,当天立 ADR(ADR-10 模式);② 对账诞生——`demo-reconciliation.md` §三:模型缺项→记 ADR 并评估是否进引擎;③ 里程碑复审诞生——M-exit 全表过一遍淘汰/复审条件(§11),触发的当即立项。**锚点**:每条 ADR 必须有代码/测试执行锚点,或显式标注「流程级」——没有锚点的 ADR 会在演进中悄悄失效而无人察觉。

| # | 决策 | 备选与取舍 | 淘汰/复审条件 | 锚点 |
|---|---|---|---|---|
| 1 | Z3 作判定层 | 规则引擎/OR-Tools/纯 LLM(4.4%) | 求解 >500ms 或变量 >10³ 评估 OR-Tools;unsat core 不可让渡 | `unified.ts`/`unified.py` 求解层;双侧套件 |
| 2 | 双实现 TS 生产+Python oracle | 单实现(无对账) | **2026-08-22 v0.0.1-rc.2:** Python oracle 路径下线(diff-test 改为 TS-vs-TS,run-all-tests 不再依赖 Python 运行时);py/ 保留为历史对照(不删),**不再被产品运行时引用**——npm 一键分发前提 |
| 3 | 桥接收敛:进程内优先 | 全 TS/全 Python | **2026-08-22 v0.0.1-rc.2:** Python 桥下线,仅剩 hbcli 桥(vs hbcli & hbcli fallback);每桥 ≤2 不变 | `ts/capabilities/hbcli.ts`;`bridge.latency.jsonl` |
| 4 | loopx 为控制平面 | 自研状态机 | 概念冲突且无法适配时 | 流程级(`.loopx/` 治理状态) |
| 5 | 统一行程模型 | 维持双引擎 | 已清偿(engine/journey 退役日=迁移完成日,D-7 跟踪) | `unified.ts`/`unified.py` |
| 6 | 静态数据包(demo 期) | 直接接 API | M2 退役为夹具 | `data/*.json`;金标准用例 |
| 7 | 算术/求解分层 | 混合 | 永不复审 | `model.ts`/`model.py` 纯函数层(分层测试结构) |
| 8 | mock-LLM 先行 | 等 API key(伪阻塞) | S4 完成后 mock 留作回归夹具(已兑现) | `ts/src/mock-llm.ts`;`ts/scripts/replay.ts` |
| 9 | 访谈确定性(缺失字段驱动) | LLM 即兴(Kimi 病根) | 永不复审 | `loop.ts interviewNext`;replay 夹具(首轮问出工作窗口) |
| 10 | 翻译≠造数:LLM 只产骨架与锚点,班次数据永远来自能力层(数据包→实时API);spec 校验闸兜底 | 让 LLM 直接产出完整 spec(实测:MiniMax-M2 编不出时刻,要么编造要么卡死) | 永不复审 | `loop.ts validateSpec`;`dsh-llm.ts SKELETON_SYSTEM`;`replay-real.ts` |
| 11 | 评测分层进架构:回归层(单元/差分/重放)防退化、质量层(评测集+指标面板)防漂移、巡检层(nightly 真 LLM 重放带预算闸)防「mock 绿而真智能烂」;M-exit 必过对应层级 | 只靠重放夹具(质量漂移无感)/事后补评测工具(指标不进架构等于不存在) | M3 exit 指标面板上线后复审一次 | `run-all-tests.sh`;replay 三件套;`tech-strategy.md` §4 |
| 12 | 时间感分层:锚点卡(算术进代码)+ 槽位逐字保留(LLM 不换算不翻译)+ 过期/language 判定归代码层 | 见 §8.12 | **2026-08-27 复审(D-10 切片 A 触发):设计成立**,补充边界见 §8.12 | `time-anchor.ts`;`travel-slots.ts`;`slot-spec.ts`;`time-eval-tests.ts` |
| 13 | 工具观察 envelope(RFC S1,effect-interpreter 映射):12 工具成功路径平铺 `ok:true` + 载荷,失败 `{ok:false,summary,evidence}`(guard 兜底同形,`ToolFailure` 编译期对齐);参数三形态归一唯一入口 `interpretArgs`(原 unwrapQuery 移居 `tool-packet.ts`) | 逐工具自由返回(形状漂移,每个新工具重新猜)/嵌套 envelope `{ok,value}`(渲染/调用方全要拆包,侵入大) | 出现第二个真实调用方(非 dsh 非 smoke)需要不同观察形状时复审 | `tool-packet.ts`;`incident-log.ts guardToolExecute`;smoke §9 |
| 14 | 记忆效用 sidecar(RFC S2/S3):三类事件 append-only,**归因只认 owner 确认**;wish 稳定 id + 休眠制;召回 0..1/轮 | 见 §8.14 | 多用户 AaaS 账本化(RFC §6.5)或出现第二个效用消费方时复审 | `memory-utility.ts`;`index.ts gotry_wish_pool_list`;smoke §10 |
| 15 | 事务化状态基座(RFC `transactional-state-rfc`,业界 durable-execution 五件套收敛) | 见 §8.15 | 多用户 AaaS 化(RFC §6.5 claim/CAS 实装)或需要多写者/多端复制(cr-sqlite/Litestream,触发式=D-15)时复审 | `state-ledger.ts`;run-all §28/§29 |
| 16 | 双形态架构冻结(本地+Web):**一套账本语义,两种宿主绑定**;`tenant_id` 一等字段;同步=事件复制非状态翻译 | 见 §8.16 | 永不复审(双形态是产品形态基座);同步协议与 claim/CAS 实装按触发器后置 | `state-ledger.ts` schema v2;run-all §28 双形态断言 |
| 17 | 预订 saga 状态机具名化(issue #17 采纳,2026-08-29) | 见 §8.17 | M5 拍板 WriteGate 时复审(启封增量的 schema CHECK/seam 词汇/L4 自动类);若出现需要并行多写者的预订流,复审 keyed 单写者形态 | `ts/src/booking-saga.ts`;`docs/booking-saga-fsm.md`;run-all §36 |
| 18 | 效应解译器 effect_interpreter.v1(issue #16 采纳,2026-08-29) | 见 §8.18 | 出现需要跨渠道比价聚合的产品裁决时复审「平铺」边界;写效应(预订/支付)入注册表时必须走 booking_saga_fsm.v1 边表(M5 Entry) | `ts/capabilities/effect.ts` `resilience.ts`;`docs/effect-interpreter.md`;run-all §37 |
| 19 | 可下单事实单一数据源 + 产物事实闸(issue #46,2026-08-30) | 见 §8.19 | 出现第二类需闸产物(如酒店直订)时复审覆盖面;政策实时源接入后复审政策事实生产端;根治方向=产物只由渲染原语生成(结构化→markdown 单向),反向抽取降为兜底 | `ts/src/bookable-facts.ts` `ts/src/artifact-gate.ts`;`data/airline-airports.json`;run-all §39;smoke §16 |
| 21 | 扩展分发三通道(issue #21 分发通道,2026-08-30;商店轨 2026-09-02 上架) | 见 §8.21 | ~~商店过审后复审 wizard 步骤~~(已触发:wizard 退化为离线健康探活等待;安装=浏览器的事、渲染=dsh UI 的事,§3.3 职责返交落地);GitHub 不可达地区常态化时复审镜像默认值;出现第二分发产物时复审通道抽象 | `ts/capabilities/session/extension-distribution.ts`;`scripts/package-extension.mjs`;run-all §43;`docs/extension-webstore-submission.md` |
| 22 | static golden 是**可审计 benchmark comparator**,不是实时航班源(issue #67) | 见 §8.22 | 出现可免私有凭证、许可清晰且稳定的官方 flight API,或 hbcli 发布 flight 合同时复审其为新 provider;static 仍只保留为确定性回归夹具 | `ts/capabilities/session/static-flight-golden.ts`;`ts/data/sf-static-routes.json`;run-all §44 |
| 23 | embedded Booking Copilot 双协议安全边界与 BFF request identity binding | 见 §8.23 | 出现离页自动写/支付必须另立 M5 WriteGate ADR；出现多写者/跨 host 触发 ADR-15/16 复审；所有消费方迁移 v2 后再退 v1 | `schemas/booking.surface.v2.schema.json`;`ts/src/booking-surface/contracts-v2.ts`;`runtime-v2.ts`;`server.ts`/`startup.ts`;v2 runtime/package/run-all proofs |
| 24 | turn 预算 = 路由 + wall-clock 双出口:确定性分类 → converge/handoff;handoff 落独立工单待 loopx tick 收 | 见 §8.24 | 路由误分成系统性问题时(用户反馈「该当面答的被转后台」可观测),先扩 Tier 0 信号词表再考虑 Tier 2(结构化状态);handoff 工单积压需要真实收集器时启动 loopx tick 设计;评测端 60s 太紧先调 env pin | `ts/src/turn-policy.ts`;`ts/src/turn-deadline.ts`;`ts/src/index.ts` 装配;`ts/scripts/turn-policy-tests.ts`;`ts/scripts/agent-planning-turn-deadline-{tests,e2e}.ts`;`scripts/run-all-tests.sh` §45 |

### ADR 展开(表内「见 §8.x」的正文)

#### 8.12 时间感分层
- 时间评测集进仓(`data/time-slot-eval.json`,只增不改语义),质量层首块落地。
- 备选与取舍:全 LLM 感知——锚点缺失实测(legacy 路径无「今天」注入,过期无从判);代码全量解析中文相对日期——表达开放,维护黑洞。
- **复审补充的边界**:解析层只认锚点卡词表 + 绝对表达 + 「+N」后缀;词表外 unresolved 逐字保留,**不做开放式解析**(锚点 `slot-spec.ts`;time-eval §5)。

#### 8.14 记忆效用 sidecar
- `recalled`/`applied`/`verified_outcome` 三类事件 append-only(`gotry-state/memory-utility.jsonl`)。
- **归因纪律**:attribution 只能在 confirm-outcome 由用户明说落盘,**模型不许自评「有用」**。
- wish 稳定 `wish_id` + muted(休眠不删除);召回 0..1/轮(`gotry_wish_pool_list` 条件评分,muted 永不召回,无命中不硬推)——M4 北极星「下一次出发率」的度量底座。
- 备选与取舍:召回即记「有用」——自称用了 ≠ 让结果变好;wish 删除制——憧憬不该被拒绝。

#### 8.15 事务化状态基座
单文件 SQLite 账本(better-sqlite3,WAL)= 唯一权威,业界 durable-execution 五件套收敛:
1. **events append-only**:语义幂等键 UNIQUE 物理化,`wish_id` 语义派生。
2. **投影表 fold 可重建**:纯函数守门原样复用,语义层零改造。
3. **红线进事务**:evidence/conditions 拒绝即回滚。
4. **durable 工单**:`workflow_steps` intent-before-execute,崩溃恢复 exactly-once。
5. **pending_writes saga**:WriteGate L2/L3 基座(幂等键/receipt/补偿)+ what-if 分叉(VACUUM INTO)。

旧 JSON/JSONL 降级为单向导出视图(红线 6);one-shot 迁移(首写自动 + 快照 `pre-ledger-backup/`)。

备选与取舍:Postgres/DBOS/Temporal/Restate 平台——单用户本地产品不需要服务端(SQLite durable 学派「一文件即控制面」);纯文件加固 tmp+rename——修不了跨文件分叉与并发;`node:sqlite`——零依赖但较新,D1 落选备选。

#### 8.16 双形态架构冻结
- **一套账本语义,两种宿主绑定**:本地 = better-sqlite3 直读文件;Web = 同一 schema 跑在每用户 SQLite 文件(或 Postgres,schema 同构)。
- **`tenant_id` 从第一天就是一等字段**:events/投影/工单/pending_writes 全部带租户列,单用户期恒为 `'local'`,主键空间化防跨用户撞。
- **同步 = 账本事件的复制,而非状态的翻译**:events 行带 `tenant_id` + 幂等键,双端合并天然幂等。写必经账本,读必带租户上下文进不变量表。
- 备选与取舍:本地与 Web 各长一套逻辑——多用户期合并只能推倒重来;云端权威 + 本地缓存——违反红线 6 本地优先;同步投影而非事件——投影是派生态,合并会分叉。

#### 8.17 预订 saga 状态机具名化
预订/支付/退改的 saga **不引入编排框架(LangGraph 等)**,FSM 落为账本 `pending_writes` 的词汇层(`ts/src/booking-saga.ts`,`booking_saga_fsm.v1` 纯函数):状态字母表与 CHECK 约束逐字一致,边全函数化。

备选与取舍:LangGraph/Temporal 式框架——第二运行时,违反 harness 基线与复用矩阵;状态散落 SQL 字符串——边语义漂移无词表;多 Agent 提示词协同——隐式依赖。

#### 8.18 效应解译器 `effect_interpreter.v1`
「效应描述 + 解译器」下沉到 L4 渠道边界——工具/编排层只产纯数据效应值 `{effect, params}`;渠道访问、退避重试、断路器、编译期 mock 全部收敛到解译层。

备选与取舍:逐工具自由调用能力层——横切逻辑复制,无退避/熔断/mock 面;Python browser-use——违反零 Python 依赖;解译器内置多渠道路由排序——违反 OTA 平铺。

#### 8.19 可下单事实单一数据源 + 产物事实闸
每个可下单事实(航班号/时刻/机场/价格/政策)**只允许存在于结构化事实层**(`gotry_bookable_fact.v1`),产物渲染前过闸。

备选与取舍:LLM 自觉标注——无强制力(issue #46 实证失败);渲染时宽松放行——未核验事实出门;政策面接实时签证 API——v1 政策事实仅渲染侧 + 闸侧,生产端记 D-26。

**根治方向**:产物只由渲染原语生成(结构化 → markdown 单向),反向抽取降为过渡态。

#### 8.21 扩展分发三通道
Chrome 平台禁止非商店 CRX 直装——GitHub Releases 只做「下载」(稳定资产名 tar.gz/store-zip/dist-manifest),Web Store 才是「一键装 + 自动更新」。三通道同一扩展:**Chrome Web Store(2026-09-02 上架,推荐)** 一键装/自动更新;GitHub 通道显式 opt-in(免审核、版本更新更快);bundled 保离线确定性兜底。

**上架实测**:商店用自己生成的签名 key 重签,不认 manifest 固定 key——商店版扩展 ID(`oeajpiccmonococjcegddlooeeohlbgd`)与 unpacked 固定 ID(`olpgkofjhhiiiahdkkbcninhjmegghfe`)不同;桥 Origin 白名单双通道同信(`EXTENSION_ORIGINS`,run-all §38),端口池/host 白名单不随通道漂移。

备选与取舍:任意 URL 装 CRX——平台禁止;npm 包唯一通道——扩展更新被迫跟 rc 发版火车;独立 pinning——与解耦目标冲突;自建更新服务器——违反零基建面。

#### 8.22 static golden = 可审计 comparator
route/carrier 只取 OpenFlights 固定 revision;时刻/价格取 manual band 且逐字段标 estimated;`requested`/`effective` source、revision/license 与 fallback reason 同条 evidence 落盘。**快照或路由失败必须 stderr 告警后回退 manual,禁止静默换源或伪装 live availability。**

备选与取舍:`hbcli search-flight`——本机与上游均无此能力(N/A);携程免凭证开放 API——未找到且公开页 432(N/A);直接把 manual 改名 static——来源造假;仅保 manual——继续 vendor 锁。

#### 8.23 ADR-23：embedded Booking Copilot 双协议安全边界与 BFF request identity binding
Booking Copilot 是既有工作台内的 BFF-only embedded read-action 面：v1 保持兼容，v2 使用 closed typed contract；两者由同一 listener、task ownership 与 ledger 按请求 version+schema hash dispatch。生产 standalone 的 `bff-bound-turn-only` 模式只接受已由 BFF 绑定的 internal `user.turn`/receipt continuation；v2 浏览器只提交安全 opaque `requestKey`/可选 `taskHandle`，只有完整 authenticated principal/scope + BFF trusted binding seam 才能把 `user.turn.ingress` 原子返回为服务端生成并持久绑定的 `taskId + turnId + contextRef + surface + allowedActions`。bound-turn-only 下 ingress 在任何 ledger/planner side effect 前返回 typed 503；taskHandle 在 actor scope 内只能绑定一个 task/context。must blocker 只能经 runtime 持久化并实际呈现的 option 放行，且 approval 逐字段绑定 task、context、source turn、source action、source receipt digest、canonical presentation key、随机 delivery nonce 与 option digest，只能消费一次。

可用性恢复同样是 runtime-owned 的 typed reducer：一次 recovery 冻结最多 5 家候选酒店；每家 generation 最多考虑 3 个当前 OfferRef，每家生命周期最多 2 次 CheckAvail、最多 2 次 offers/HotelRates generation。`unavailable`、material `changed` 或不可确认 gap 会使整个 generation 失效并要求 fresh query；partial evidence 只能产生 inconclusive exhaustion，不能宣称市场无房。generation、attempt、candidate、receipt digest 与 workspace revision 随 ledger action/receipt fold，重启和相同 action/receipt replay 不增加预算或调用；terminal 是吸收态，不能再发 operation/status。

明确拒绝的备选：独立聊天预订页；用 breaking v2 替换 v1；自由文本/JSON 执行；把 server outbox 意图当作已展示；在 embedded 面暴露 `Book`。当前能力不包含 portal token、PII 或供应商成本出站；离页自动写/支付须另立 M5 WriteGate ADR，多写者或跨 host 则按 ADR-15/16 复审。

#### 8.24 ADR-24：turn 预算 = 路由 + wall-clock 双出口（turn-policy / turn-deadline）
**问题陈述(2026-09-02 轨迹定形)**:任何一轮对话必须终结在三态之一——①当面答完 ②转异步并给出回访承诺 ③收敛作答;绝不允许第四态「流死掉、什么都没交付」。原 `tool-budget.ts` 步数闸(16 软/18 硬)与 v1 的固定 wall-clock 闸(60s/120s)同属一个错误形状:到点「拒绝工具 + 逼出 final」——模型仍可能在流中死掉,轨迹用户拿不到任何东西。

**v2 设计(复杂度决定出口结构,不是映射到更大的常数)**:
- **路由层**(`ts/src/turn-policy.ts`):每个 user/message(source.kind=user;plugin/skill 注入不参与)确定性分类 quick / sync-planning / deep-planning。纯函数、零 LLM、零 IO——控制面判定必须确定性(责任铁律;ADR-9 同型先例),路由器不能花它要分配的资源,且 LLM 路由会破坏评测可复现(§45 离线 E2E 零真 LLM)。v1 规则输入只有 Tier 0(日期跨度提取器+约束词表+消息长度);`loop.ts` 的 `isComplex` 是 S5 循环架构的访谈后复核,不在产品路径(唯一调用者是 replay 脚本),且对轨迹首消息判 false,**不进此层**。误分有界:三态出口保证最坏结局是「本可当面答的被转后台」(下一轮可救),所以路由器只需够用不需完美——这也是确定性优先成立的前提。
- **分配层**:分类 → `TurnPolicy={softMs,hardMs,exit}`。阈值表是数据不是代码(评测/部署换表不换执行器):quick 120s/180s converge;sync-planning 300s/600s converge;deep-planning 120s/240s **handoff**(同步窗口只够摸底+落单)。
- **执行层**(`ts/src/turn-deadline.ts`):硬阈拒绝时**同步**抑制继承工具 schema(轨迹教训:延迟到 `step/end` 模型会在同 step 回环拒绝结果直到 token 截断),按 exit 返回:converge=`TURN_DEADLINE_EXHAUSTED`(用已有证据作答);handoff=落 `gotry_turn_handoff.v1` 工单(`<stateRoot>/gotry-state/turn-handoffs/`,含用户原文/ETA=约1小时/status=open)并指令模型一句话告知「已转后台+预计时间+回访方式」。工单是**独立格式独立目录**:async-collect 对无 spec 的 state 会立即结算 failed(假失败),handoff 收集器是未来的 loopx agent tick——落单本身已是三态承诺的兑现(有据可查、可回访),不等收集器存在才有意义。
- **装配**:产品路径 `apply()` 默认装(路由+handoff 是产品行为);benchmark opt-in 钉死 `{60s,120s,converge}` 固定 policy 保可复现。`GOTRY_TURN_DEADLINE_SOFT_MS`/`_HARD_MS` 仅 pin 数值不改出口;`GOTRY_TURN_HANDOFF_ROOT` 钉工单隔离根(source 模式 dsh cwd 是创始人真实数据目录 `ts/dsh-runtime`,测试必须钉,巡检状态纪律)。
- **验证**(`run-all §45`):`turn-policy-tests.ts` 表测(首条 fixture=轨迹用户原文,canonical deep case 必须命中——整个重设计的回归锚点);`agent-planning-turn-deadline-tests.ts` Cordis 集成(converge/handoff 双出口、工单字段、plugin 消息纪律、生命周期);E2E 以合成 deep 消息+relay 拖过硬阈,断言 handoff 结果、工单落隔离根、最终请求 text-only、非空 final。

**收集闭环(2026-09-02 v2 补全,「一小时后回来看看」的后台半段)**:`ts/scripts/turn-handoff-collect.ts`(单张 `<ticketId>` / `--all`,async-collect 的 turn-handoff 对位)加载 open 工单 → 以 `GOTRY_HANDOFF_CHILD=1` 派生 headless 规划会话(`bin/gotry-inner.js`,可经 `GOTRY_HANDOFF_PLANNER_BIN` 覆盖;递归防护:子会话唯一出口 converge + 长 leash(300s/900s),父进程的数值 pin 与工单根在子环境清除——前台转后台、后台必须产出交付物,不得再次 handoff)→ 捕获最终答复结算:`settleTurnHandoffTicket` 原子写 `<id>.deliverable.md` + 工单 status settled/failed(settledAt/deliverableFile/error)。终态幂等:已结算工单复诵交付物与 `gotry_turn_handoff_terminal.v1` JSON(succeeded exit 0 / failed exit 2),零重算零再花;failed 交付物是诚实失败说明(「没有完成,请重新发起,无部分结果可交付」)。复访面:产品路径注册只读工具 `gotry_turn_handoff_list`——用户回问「规划好了吗」时模型查工单状态,settled 附交付物摘录(≤600 字,全文在同目录 .deliverable.md),禁止编造不存在的交付物。调度:收集器是一次式命令(cron/loopx tick/人工均可驱动,`--all` 扫全部 open)。v1 诚实边界:工单只携带用户原文,规划会话是全新上下文(fresh cwd/DSH_HOME),原会话已读的工作区/日历结论不随单迁移,由规划器按需重取。E2E 闭环:§45 的打包二进制 E2E 在 handoff 断言后以真二进制为 planner 跑收集器,断言 ticket open→settled、交付物含规划器 final。

复审触发:路由误分成系统性问题(「该当面答的被转后台」可观测)时先扩 Tier 0 词表再考虑 Tier 2(结构化状态);handoff 工单积压需要真实收集器时启动 loopx tick 设计;评测端 60s 太紧先调 env pin。

明确拒绝的备选:到点杀 turn 的任何常数闸(固定或 LLM 动态生成——形态不变则轨迹失败模式不变);LLM 路由(一致性/可复现/成本三输;若未来信号不足,走 loopx RFC S4 的 L1 shadow→L2 advisory 影子对比路径挣授权,不默认给);handoff 复用 loop 工单格式(async-collect 假失败);阈值交 dsh 宿主传(违反 gotry/dsh 分层)。


## 9. 演进(时间线唯一来源= `roadmap.md` 的 M0-M6;此处只保留原则与现状)

原则:**不跳阶段,不提前优化下阶段的事**;每阶段 Entry/Exit/gate 见 roadmap。旧 Stage 0-4 与总纲 Phase、产品 M1-M3 已归并映射到 M0-M6(映射表在 roadmap)。

- **M0 ✅ / M1 ✅(bb880f3)/ M2 ✅(b0cfd97)**:M2 交付 = §7-1 三层组合(骨架+校验+锚点)+ hbcli 桥 + dsh 端到端(DeepSeek 原生,人格+五工具)+ 一键入口 `./gotry`;G1/S1/§7-1 三 gate 由创始人指令结算。
- **当前主线 = M3 evidence 未收口；并行线 = founder 授权的 M4 记忆域**:M3 工程与分发面已就绪，真实种子用户的定稿率/NPS/POI 幻觉率证据仍是 Exit 缺口。M4 自 2026-08-26 起获 founder 授权并行推进；T1 及后续记忆切片、Issue #20 scorer 的落地都不构成 M3 Exit 证明，真实 `observed_private` N≥5 repeat cohort 仍缺。M5 交易与 M6 B2B 仅在各自 Entry gate 满足后启动，不得由并行实现倒推开闸。
- **HotelByte Booking Copilot 产品验收并行线**:当前候选以 v1/v2 双协议兼容的 GoTry 作为既有搜索/报价/Checkout 工作台的 BFF-only typed read-action planner；两协议共用单 listener、task ownership 与 runtime ownership，v2 浏览器 requestKey/taskHandle 只能通过带 principal/scope 的 BFF trusted binding 原子映射为服务端 taskId/turnId/contextRef/surface/allowedActions，taskHandle 在 actor scope 内单 task 绑定，并以 presentation identity 绑定一次性 approval，Linux release builder 固定 SHA/schema/runtime provenance，health 暴露实际 artifact/Node/ABI/release tuple 供部署端闭合。该线不含 `Book`，不构成 M5 Entry；四 surface 真实库存与“不可订→重搜→新 CheckAvail→原 Checkout”证据尚未取得，见 D-29。

- **M3 真实证据并行线(Issue #22)**:v1 manifest、脱敏 cohort/nightly schema、确定性 scorer 与 fixture 守门已进入工程面；业务达标只接受阈值冻结的 `real_seed_cohort`，fixture 恒 fail。真实 cohort 仍为空，等待 50–200 个脱敏样本，不宣称 M3 Exit。
- **Evaluation → Agent 优化 Round 1(Discussion #78,ChinaTravel canary 反馈)**:冻结 grounding-v3 canary 的首例终态通过,第二例暴露 planner 在重复工具调用中超过 300s；因此不生成 5-query 聚合。GoTry 侧把收敛边界下沉到 `tools/execute`:16 次软提示、18 次 body 上限、同一步第 19 次起结构化拒绝,并在 `step/end` 让下一步 native request text-only。Round 1 treatment-attested installed GoTry 已实际运行，exact DeepSeek 因 environment unavailable/schema-invalid 得 0，GLM 为 300s timeout。run-all §45 同时覆盖 Cordis integration/并行/生命周期与真实 `bin/gotry-inner.js → dist → dsh headless` 离线 E2E(18 个正常结果、1 个结构化拒绝、下一请求零工具 schema、非空 final)；CI 对当前 SHA 打包并在隔离 pnpm consumer 中安装,由 `GOTRY_BUDGET_E2E_BIN` 重放同一链路。frozen ChinaTravel treatment 与 5-query 恢复仍是 D-28 外部验收,离线 runtime E2E 不替代 benchmark evidence。**Round 1 后续(ADR-24 v2)**:真实轨迹(dsh 用户安排行程)显示任何「到点杀 turn」形态的闸——步数或固定 wall-clock——都会复现同一失败:模型在同 step 回环拒绝结果、token 截断、用户拿不到答复。最终形态是「路由 + wall-clock 双出口」:确定性分类器(`turn-policy.ts`,零 LLM,Tier 0 信号)把每轮分为 quick/sync/deep 并产出 TurnPolicy;deep-planning 硬阈出口是 handoff——落 `gotry_turn_handoff.v1` 工单并告知用户 ETA 与回访方式,而非逼出一个没有证据的 final。产品路径默认装(路由+handoff 是产品行为),benchmark opt-in 钉固定 policy 保可复现;run-all §45 = 路由表测(轨迹原文为回归锚点)+ Cordis 集成 + 打包二进制 headless E2E(handoff 结果/工单落隔离根/最终请求 text-only/非空 final)。handoff 工单的收集闭环已于同日补全:`scripts/turn-handoff-collect.ts`(GOTRY_HANDOFF_CHILD 递归防护 + 幂等结算 + gotry_turn_handoff_terminal.v1 终态)+ 只读复访工具 `gotry_turn_handoff_list`,§45 E2E 以真打包二进制跑通「handoff→收集→settled→交付物」全链。
- **Evaluation → Phase 1 environment bridge (Round 2)**:新增 default-off、owner-local config 与 host-enforced isolation contract；产品 seam 执行固定 direct argv/allowlist、最小 runner 环境、参数/输出结构上限、递归 no-oracle 键拒绝与可选 per-tool `allowed_output_keys` 正向键合同，未声明 visible-output 键 fail-closed 且不反射。benchmark opt-in 只允许 cold-start；agent 被强制为 native、原始 bridge definition-only，最终 assembly 与 downstream pre-step 双重核验 exact tool surface，same-name shadow/额外 schema/PTC 漂移均拒绝。双层 effect 覆盖局部回滚与 agent disposal；插件先卸载时不解除 live agent 的 guard/restriction，而保留 fail-closed quarantine 到 agent/process disposal，HMR 不热挂。writes/network 仍由 owner/host OS enforce，synthetic E2E 不证明 OS sandbox。unit + model-driven source/installed-package synthetic E2E 已覆盖注册、allowlist、argv、marker history、环境隔离、正向输出合同、真实 timeout/truncation 与 final text。它只提供显式 benchmark CLI seam,不调度、不花费、不读取 hidden query loader,也不引入 Python 产品依赖。唯一冻结 treatment 已到终态但只计 diagnostic-only：provider preflight PASS，planner exit 0 / 30.826s，runner exit 3，evaluation 与 official scores 均 null，forbidden hits 0，attestation/cleanup PASS。agent 只叙述想走 CLI/工具，没有 structured bridge call 与 tagged JSON；因此 evaluator 未执行，本轮无 uplift（[Round 2 evidence](https://github.com/Danceiny/gotry/discussions/78#discussioncomment-18215707)）。
- **Evaluation → Agent conformance (Round 3)**:在 bridge/adapter 之外新增 provider-neutral conformance 层。owner-local config 必须声明通用 `terminal_output` tag/size 合同；system section 明确把 prompt 内 CLI/shell/Python 操作映射为唯一 native bridge 的 `query:{action:"call",tool,arguments}`。只有 allowed action-call 的配对成功 result 之后，单一 tagged JSON object 才能结束 turn。无 call 或终态格式错误最多一次固定 steer；格式纠偏复用历史 result 并禁止再次执行 bridge，二次失约以稳定 code fail-closed。headless parent 对 stdout 有界捕获并用同一 parser 验收，未通过的正文不转发。新 frozen treatment 的 provider preflight 通过、runner 只派发一次，但 planner/runner exit 1、parent 终态 0 字节、evaluator 未进入、official scores 为 null；该证据把下一处缺口定位到 benchmark child/plugin startup，不构成 uplift。
- **Evaluation → Startup composition isolation (Round 4)**:owner-local config 验证后、任何 optional host plugin 解析/导入前，CLI 把顶层 insert 投影为唯一 `gotry-tools`；inline/reordered/未来 non-GoTry sibling 安全裁掉。顶层 insert 必须恰好一块，gotry plugin name 与 config-path 注入锚点必须恰好一次；第二 insert、spoofed name、缺失/重复 allowlist 或 anchor 均在 relay 前稳定 fail-closed。default-off 普通组合不变。source/clean-installed E2E 用两个真实执行 poison 分别覆盖 inline/reordered future plugin，并覆盖第二 insert、spoofed name 与 anchor 漂移。Round 4 treatment（SHA `5ebddb2`）primary preflight=pass，但 planner/runner 均在 30.968s 以 exit 1 结束，释放 0 字节，evaluator 未进入，official scores 全为 null；产品 gate 使用 Node v24.20.0，而 treatment 使用 v26.3.0，因此仅 diagnostic-only、无 uplift。
- **Evaluation → Headless lifecycle containment (Round 5)**:Round 5 仅限移除 timer/keepalive preload、将锁定的 DSH runtime closure 设为 alpha.3、保留源码普通运行的 `ts/dsh-runtime/gotry-state/` 状态连续性、让 benchmark/package 用调用目录隔离，并增加 benchmark-only 结构化诊断 pipe（allowlisted redacted reason codes），stdout 继续 fail-closed；其 frozen treatment（代码 SHA `752e54c`）在 140.715 秒后以 `child_nonzero_exit`、0 terminal bytes、evaluator/official scores null 停止，仅 diagnostic-only，后续纯 lock-consistency 提交不改写该 UID 归属。GitHub Node 22/24 §48 已暴露 source default-off 30s lifecycle hang；Round 5 不据此宣称 benchmark score 或 external closure。
- **Round 5 runtime resolution**:source checkout 与 npm package 都解析同一组 216 个精确直接依赖的 DSH `0.1.2-alpha.3` closure；manifest、package-lock 与 root pnpm importer 的 DSH 名称集合必须同为 216，publish preverify 对漏钉、混版或 range 声明 fail-closed。source 普通运行的 dsh cwd 保持 `ts/dsh-runtime/`，状态继续落 `ts/dsh-runtime/gotry-state/`，benchmark opt-in 与 npm package 使用调用目录隔离；legacy `ts/dsh-runtime` alpha.1 仅保留为非 benchmark 解析兼容，不承诺可运行。benchmark 在 spawn 前验证实际 DSH 版本，漂移即稳定非零拒绝；Node 下界统一为 22.15，并在任何 DSH import/spawn 前拒绝旧版本。
- **Evaluation → Structured terminal diagnostics (Round 6)**:benchmark-only conformance 监听真实 session 的最终 `turn/end`，把 model auth/capacity/server/transport/stream/request、generic runtime 以及 blocked/max-tokens/aborted/interrupted 投影为固定 enum；未知 code 与所有自由文本统一收敛为 generic，不跨 FD3。per-session arbiter 在最终 turn end 才单次写入，bridge/conformance reason 的优先级更高，成功恢复的 transient retry 零写入。代码 SHA `c61600b` 的 ChinaTravel 冻结 treatment（`..._00001`，`deepseek-v4-flash`）在 49.546 秒后稳定报告 `child_runtime_error`，0 terminal bytes，evaluator/official scores null，leakage 与本地凭证/端点扫描均为 0；该 evidence 只改善失败归因，不改 agent 决策、重试、工具或 evaluator，也不产生 uplift。
- **Evaluation → Minimal benchmark kernel (Round 7)**：代码 SHA `edb9392896625adbb48abae4a2ecf968dbfc0349` 将 benchmark opt-in 收敛为 tool budget、model override、唯一 bridge、isolation/conformance；不装产品 prompt variables、process guards、consent 或普通工具，normal path 不变。system-prompt 投影为稳定 task-agnostic persona，root patch 仅接受 canonical `insert` 与 `system-prompt` 各一，其他 root item/变体 fail-closed。UID `e20241028160248698752`（`easy`，`deepseek-v4-flash`）preflight pass、未回退，80.463s 后 runner exit 1、terminal 0 bytes/invalid，evaluator 未进入、official null、不可计分、无 uplift/外部 closure；原因稳定为 `child_bridge_runner_failed`。下一轮问题是 generic bridge schema 与可恢复 domain-error contract。
- **时间感优化(2026-08-27,外部时间评测驱动)**:时间锚点层(算术进代码,LLM 查卡不自算)+ 槽位抽取 v1(逐字保留)+ 25 题评测集与评分脚本落地,ADR-11 质量层首块兑现(原定 M3,迟到的落地);真模型(deepseek-chat)25/25。slot→spec 求解桥接未做(D-10)。
- **tsc 存量清零 + loopx RFC 专项(2026-08-27)**:
  - `npx tsc --noEmit` 14 错清零(D-11 清偿,1bf9671);同日完成 loopx 13 篇架构 RFC 通读与映射,产出 `loopx-inspired-upgrades-rfc.md`——**founder 当日指令 accepted(「按建议执行」)**,四切片 S1-S4 按序落地;同指令确立**多用户 Agent as a Service** 为未来方向(shared-goal-authority 类 claim/CAS 机制转入远期采纳面,RFC §6.5)。
  - **S1 已落地**:`tool-packet.ts` 观察 envelope(平铺 ok:true/ok:false summary,guard 兜底同形编译期对齐)+ unwrapQuery 升格 interpretArgs;S2 记忆效用 sidecar → S3 wish 触达纪律 → S4 WriteGate 词汇依次推进(D-12)。
- **事务化状态基座落地(2026-08-28,ADR-15)**:
  - 业界调研(loopx/DBOS/Temporal/Restate/LangGraph/Letta/Claude Code transcript 学派/SQLite durable 学派/TigerFS/SagaLLM/Cockroach 七失效模式)收敛五件套(append-only 账本/投影/约束即红线/步骤日志/saga 补偿)→ `transactional-state-rfc.md` 立例、founder 当日 accepted(「按你的建议来」,D1-D5 全按建议结算)。
  - TS-0..TS-4 一次落地:`state-ledger.ts` 账本 + 五状态工具写路径接线 + brief/nudge/metrics 读路径回退兼容 + `state-cli` 操作面 + durable 工单崩溃恢复 exactly-once(§28 子进程 exit 9 实证)+ `gotry_async_terminal.v1` 4/4/非 4/4 结构化终态、差异退出码与零重算复诵 + pending_writes saga;run-all §28/§29。
  - TS-5 触发式后置=D-15。
  - **同日 ADR-16 双形态冻结**:本地+Web 一套账本语义,tenant_id 一等字段(schema v2),同步=事件复制非状态翻译;§28 双形态断言(同库双租户互不串)。
- **会话数据面 #21 首切片(2026-08-29)**:`session/benchmark.ts` 固化 required comparable fields 的 fixture scorer(缺字段计错、默认 90% 闸)与双源合同(按 journey/segments/时刻/班次对齐,价格只记差值不判等)；`needs-attach`/`needs-login` 为 waiting-user no-spend,challenge 与 ReadGuard 非零 fail-closed。纯 fixture 已进 run-all §25；真实 sf-01..08 仍等待 Chrome attach 权限确认与握手。
- **扩展分发双通道(2026-08-30,issue #21,ADR-21)**:founder 指令「产物下载和安装也得做成更好的用户体验,可以用 github 作为分发渠道」。Chrome 平台约束**诚实前置**——非商店不可免「开发者模式加载已解压」的 3 次点击,GitHub 只能改善下载。双通道分工:
  - **GitHub Releases 下载通道(已落)**:`gotry setup --extension-from=github` 显式 opt-in(env `GOTRY_EXTENSION_SOURCE` 等效),默认仍 bundled 保离线确定性。
  - **Chrome Web Store 通道(2026-08-30 提交,2026-09-02 过审上架 v0.1.0)**:一键装 + 自动更新的唯一平台路径,现为推荐安装方式。商店材料(单一用途声明/权限逐条理由/隐私披露/双语文案)与隐私政策落 `docs/extension-webstore-submission.md`、`docs/extension-privacy.md`。**上架实测**:商店用自己签名 key 重签、不认 manifest 固定 key——商店版 ID `oeajpiccmonococjcegddlooeeohlbgd` ≠ unpacked 固定 ID;桥 Origin 白名单改双通道同信(`EXTENSION_ORIGINS`,§38 回归),向导/README/工具文案全部商店优先(D-25 清偿)。
  - 回归:run-all §43(资产名/打包脚本防漂移、dist-manifest fail-closed、版本比较、回环 e2e)。
  - **注**:本条曾在 §1 出现两份内容矛盾的副本(一份「材料就绪未提交」、一份「已提交审核中」),2026-08-31 文档重构时以后者为准合并。
- **会话传输层定案扩展桥(2026-08-30,#21 方案 C 升 PRIMARY)**:
  - founder 实测「Chrome attach 逐连接权限框根本无法使用」(chrome-devtools-mcp #825:每次连接必弹、无持久化批准)→ CDP 降显式 opt-in、扩展桥主载——`extension/`(MV3 零构建,固定 key=扩展 ID,SW 长轮询,MAIN-world 被动嗅探,cookie-names 只取名)+ `extension-bridge.ts`(`node:http` 回环桥,origin 白名单,零新依赖)+ 车道路由(扩展默认/cdp 显式/persistent 测试);登录快路径免标签页;守卫按车道分形(扩展=零写行为+hints 白名单,cdp=请求级 abort);
  - `needs-extension` → `waiting_extension`(waiting-* 同族 no-spend);run-all §38(23 断言)+ bootstrap-tests 5/5;真实 sf-01..08 门禁降为「装一次扩展」。
- **Issue #67 static golden(2026-08-30)**:`sf-live-benchmark` 的 vendor 闭集扩为 `manual|flyai|static`；`static` 由 OpenFlights 固定修订提供 route/carrier,由手工 manifest 提供估算时刻/价格带,并把 requested/effective source、estimated fields、provenance、fallback reason 逐条写进 evidence。静态源异常时 stderr 告警后回退 manual；它不声称实时班期/价格/库存。run-all §44 固化 CLI fail-closed、八条覆盖、回退与 provider-independent 软评分。
- **Issue #67 登录态真跑与桥退出语义(2026-08-30)**:连续两轮 static official 均 8/8 命中且零 fallback;session hit 数从 3/8 波动到 5/8,全部可评分 hit(3+5 条)均 13/13=100%,非 hit 必须显式披露且不进软评分分母。真扩展在线场景触发的 CLI 不退出已以默认桥 parked timer/socket `unref` 修复;`keepBridge` wizard 轨通过 §40 9/9,§38 增子进程回归至 24 段。
- **M4 Issue #20 价值证据切片(2026-08-29)**:paired-cohort 合同、active-planning 扣 wait 口径、experience-reflux 与偏好/P4 红线被一个只读 scorer + 合成 fixture 固化并接入 run-all §34。合成数据明确不可关闭 M4;下一阶段只等真实 `observed_private` N≥5 repeat cohort,无样本时 waiting/backoff/no-spend。
- **已知限制清算第一刀(2026-08-29,founder 指令「解决这些 known limitations」)**:
  - **Z3 WASM race 根治**:历史债「三模块各自 init 的 WASM 实例并存 + `Promise.all` 同 Context 并发」双重根因,经 `ts/src/z3-shared.ts`(单一实例 / 单一 Context / 会话级互斥 `withZ3`)关闭;engine/journey/unified 三模块全部过门,engine.solve 弃 `Promise.all` 改串行。当年 rc.4 单例回滚的 Context mismatch 来自混用残留 Context,本次三入口同门无混用面。run-all §1 重试止血退役 + §30 并发回归闸。
  - **薄壳遗留**(`shell/` 目录)物理删除,dsh web 确认为唯一产品面。
  - **实时票价接入**:`ts/src/realtime-pricing.ts`——dated 航班链段经 FlyAI 官方只读通道按航班号精确匹配覆写 spec 价格,证据链 `[实时API:flyai@ts]` 并进 skeleton_notes;miss/error/打码价/无匹配一律降级回静态包,永不抛错。`realtimeSolvePort`(env 闸 `GOTRY_REALTIME_PRICING`,默认关)接线 replay-real——**静态包由唯一来源变为显式降级**,run-all §31。
  - **i18n 英文面工程层**:`i18n.ts` 消息目录——zh-CN 默认且与金标准逐字节一致,`GOTRY_LOCALE=en` 切英文、en 缺键回退 zh;覆盖求解确定性面(候选/航班链 answer_md、放宽建议、排除理由、wish 理由)。run-all §32;工具卡与人格对话面挂 M4 校准样本随补。
- **贡献基建(2026-08-29,开源协作面)**:GitHub Actions CI(node 22/24 矩阵:typecheck + 全栈回归,`GOTRY_SESSION_LIVE=0`);`CONTRIBUTING.md` + issue/PR 模板;lockfile(root/ts 双份)与 dsh-runtime 三 manifest 入 git,resolved 全量从内部镜像改指 registry.npmjs.org(integrity 逐包验证);贡献流程改 PR 制。
- **onboarding wizard(2026-08-30,#21 · 2026-09-02 职责返交重设)**:
  - 2026-08-30 立项:founder 实测「能装 ≠ 装到能用」——上版隐性状态要求 5 次点击 + 1 个原生文件对话框 + 跨 app 切换 + 装完自己重跑。首版闭环 `npx gotry setup wizard`:5 步编排 + 复制扩展路径(pbcopy/xclip)+ 直达 `chrome://extensions` + 跨平台 GUI 面板(macOS osascript / Linux zenity / Windows msg / headless 终端)+ 后台 health-watch ≤120s 探活 + 扩展就位后自动重放同 query_id。用户侧降至 **3 次点击 + 0 次终端命令 + 装完零重跑**。
  - **2026-09-02 商店上架后撤销**:gotry 越界管起了浏览器(`open` 弹窗、`pbcopy` 动剪贴板、`osascript/zenity` 抢 GUI)与 dsh 渲染层(用 stdout 文字墙代替 verdict)。LLM 由 dsh 管、扩展由浏览器商店管、CLI 自举由 `gotry setup` 管——三条职责原本就分清。wizard 退化为**离线健康探活等待**(纯 stdout,不动 spawn);商店页安装回浏览器;`sessionFlightSearch`/`sessionLogin` 在 `needs-extension` 时返回 `verdict.installUrl` 给 dsh UI 直接渲可点链接。
  - 落地:`ts/capabilities/session/wizard.ts`(2 步纯 Node:`ensure-extension-files` + `watch-extension-ready`)+ `health-watch.ts`(默认 120s/5s、有界、AbortSignal 可取消,继续保留)+ `scripts/health-watch-cli.ts`;`scripts/wizard-bootstrap.ts` 已删除(wizard.ts 直接被 onboarding-tests import);run-all §40 onboarding-tests 9/9 + bootstrap-tests wizard 节。
- **价表 provider-aware v2 + 价格漂移监测(2026-08-30,issue #49,ADR-20)**:
  - 封存价表从 `gotry_llm_price_table_v1`(DeepSeek V4 only)升 `v2`(`providers.<id>.models.<model>` 平铺 + `family`/`price_strategy`/`source_url`/`aliases`);MiniMax M2/M2.1/M3 入表;`ts/scripts/price-drift-watch.ts` 监测四家主流 provider(DeepSeek/MiniMax/OpenAI/Anthropic),**永不自动 apply 价格**(ADR-11 纪律)。
  - 同批 CHANGELOG 自动化:`ts/scripts/build-changelog.ts` + `CHANGELOG.md`(Keep a Changelog 1.1.0 + Conventional Commits 解析)。run-all §41/§42。

- **dsh runtime 跟进上游(2026-08-29 起,issue #15)**:2026-08-29 上游 `dsh-v0.1.2-alpha.1` 未发 npm 时，先以全量 241 包 vendored tarball 解堵；Round 5 已将公开 root/package closure 锁到 npm `0.1.2-alpha.3`，source 与 package 都 root-first 解析，source 普通运行仍以 `ts/dsh-runtime/` 为 dsh cwd 保持状态连续性，package/benchmark 使用调用目录隔离；旧 vendor 只作非 benchmark legacy 解析兼容，不承诺可运行。legacy 溯源与后续独立升级流程见 `ts/dsh-runtime/vendor/README.md`。

- **OTA 平铺 + 账号授权闸(2026-08-29 第二批,founder 口径「OTA 这些都是工具,不要区分主路径/降级路径;用用户账号必须跟用户确认」)**:
  - ①酒店接入官方只读通道——flyai `search-hotel` 实测(大理:结构化 name/star/打码价 ¥7xx/detailUrl;解析契约 `FlyaiHotelOption`,打码价保 priceRaw 原值、数字价恒 0,防「¥7xx 截成 7 伪装真价」),`gotry_flyai_search` kind=flight|train|hotel 三形态,参数闸 per-kind;②OTA 工具面平铺——工具描述与 persona (19) 去「主链路/交叉验证/三级路由」层级话术(数据层 L4 证据链逐源标注照旧,拍平的是路由优先级不是标注纪律);③账号授权闸(v2,当日二迭代):`session-consent.ts` 挂 `tools/pre-execute`,**每会话每站点首次调用**弹审批卡→会话内记住,**拒绝=本会话吊销**(不再弹卡不再执行;
    首版逐次弹卡被 founder 实测否决——「每次都要弹,经常无法点击」),sessionAccess `ask|allow|off` 三态,无审批通道/headless fail-closed;授权状态存 Weak<agent> 绝不跨会话延续;④**登录态 seam 落地**:`scripts/session-login.ts`(cdp attach→开登录入口→人登录→只读轮询票据名)替代「跑脚本」空指引;⑤测试纪律:session-tests live 节默认 SKIP,`GOTRY_SESSION_LIVE=1` 显式开启——**例行回归永不自动开用户浏览器窗口**。
  - run-all §24(session-tests §H/§I)+ smoke §12-13;全栈回归全绿。

- **预订 saga 状态机具名化(2026-08-29 第二批,issue #17 采纳)**:针对「多 Agent 协同用 FSM 显式建模副作用传递」提议,逐机理勾稽(共享态/检查点/防重复副作用/HITL 在账本与 durable 工单已物理存在)后,落地词汇层 `booking-saga.ts` + 设计文档 `booking-saga-fsm.md` + ADR-17;LangGraph 编排不引入,合规恒为 deterministic-edge,HITL 审批 = pending 挂起 + 外部事件恢复;run-all §36 物理对账 25 断言。

- **产物面(2026-08-29,issue #25,两步)**:①dsh 内查看——`gotry_artifacts_list/read` 把账本工单交付与工作目录 md 变为可发现、可读对象(read 卡);②成熟面板——dsh-market 调研(dshmarket.com,2495 插件)选型 **dsh-better-sidebar**(★3083/18.9 万周装,#1 UI 组件;自建零依赖 webui 因品质不达产品级当日撤回),`gotry setup` 宿主层安装(GOTRY_SETUP_SIDEBAR=0 可跳,幂等/失败降级路①),dsh web 侧栏工作台浏览+渲染工作区产物;产物 Tab(registerTab client-half)为下一阶段。

- **效应解译器(2026-08-29,issue #16 采纳,ADR-18)**:
-  - 「效应描述+解译器」落地 L4 渠道边界——`ts/capabilities/effect.ts`(effect_interpreter.v1:效应值注册表+生产/mock 双解译器+渠道 observation 原样透传)与 `resilience.ts`(指数退避 withRetry+断路器三态)。关键保守边界:①韧性策略 per-效应显式拍板,没有策略行就没有效应(默认全关=对既有行为零改变);②FlyAI Sentinel 上游「说不」永不重试但计熔断(3 连错开 60s 保配额),SESSION 通道永不重试不熔断(风控红线),免费源 2 次退避;③浏览器解译=SESSION_* 效应(既有 CDP 通道),零 Python 红线不做视觉 CUA;④不做渠道自动路由/比价(OTA 平铺 founder 判定,agent 层比价)。
-  - 垂直切片接 5 工具+realtime-pricing 默认查询口,余下渠道增量迁移(D-23)。设计文档 `effect-interpreter.md`;run-all §37;smoke/flyai/hbcli/weather/session/realtime-pricing 套件同轮全绿。
- **可下单事实闸(2026-08-30,issue #46,ADR-19)**:真实会话产物(2027 远期行程)把 exact-date 全 miss 的航班用「当前班期网页+历史」回填并标 ✓/推荐——根因=可下单事实无单一数据源、产物无闸。落地:`bookable-facts.ts`(gotry_bookable_fact.v1 纯函数层)+ `artifact-gate.ts`(产物闸)+ `fact-log.ts`(侧车落账)+ 第 21 工具 `gotry_fact_gate` + persona (20) 红线 + `data/airline-airports.json` 映射快照;locked golden 2027 E2E(issue 审计值夹具)复现全部违例并抓出(44 断言,run-all §39;smoke §16 接线验证)。覆盖面缺口记 D-26。
- **npm 形态自定义端点修复(2026-08-30,issue #48,未随版本发布)**:
  - rc.15 回拉实测暴露——bin/gotry-inner.js env 映射只做 `LLM_API_KEY → DEEPSEEK_API_KEY`,base 不映射,vendored dsh(llm-deepseek 读 `DEEPSEEK_BASE_URL`)把 OpenAI 兼容端点的 key 发往 DeepSeek 官方端点必然 401,README「OpenAI 兼容均可」承诺行为未跟上;同点补 `LLM_BASE_URL → DEEPSEEK_BASE_URL`(显式 DEEPSEEK_BASE_URL 优先,默认官方路径零改变);
    - 两侧拼接语义核验一致(dsh-llm-deepseek 与 `ts/src/dsh-llm.ts` 均为 `${base}/chat/completions`,自定义端点一般含 `/v1`);README.md/README.zh-CN.md(30 秒上手/前置/源码安装三处×2)+ .env.example + bin help 同步配法。
  - **已知缺口(同日由 issue #77 闭环,见下条)**:`LLM_MODEL` 不进 dsh 模型表(模型选择=dsh 默认 deepseek-v4-* 或用户 ~/.dsh 设置),严格中转(仅认特定模型名)落空。
- **LLM_MODEL 接通 dsh 会话面(2026-08-30,issue #77,未随版本发布)**:
  - 三件套 `.env` 的 `LLM_MODEL` 此前在 dsh 会话面零消费者——#48 修复 E2E 实测暴露(mock 中转 + `LLM_MODEL=MiniMax-M2`,请求体 model 仍是 ~/.dsh 用户层选的 glm-5.3-flash),dsh 模型选择只来自 llm-deepseek `DEFAULT_MODELS` 或用户 ~/.dsh 设置,README/.env.example 形成「配了即生效」错觉,严格中转必然打不通。
    修复双轨:① bin/gotry-inner.js 把 `LLM_MODEL` 映射为 `GOTRY_LLM_MODEL`,gotry-tools 插件(`capabilities/model-override.ts`)在 `agent/request` 瀑布挂根监听、post-next 覆盖 provider/model(内存态零持久化,进程退即散,不改写用户 ~/.dsh)——必须走这条是因为 dsh settings 分层为 schema 默认 < composition 配置 < 用户层,web UI 选过模型后单靠 composition patch 压不过;瀑布按注册序嵌套(先注册=最外层、post-next 最后生效),插件随 cordis patch 在根组装载先于任何 agent 创建,显式 .env 意图因此压过一切持久层选择;
    覆盖同时清掉继承的 reasoningEffort(与 installModelSelection 同语义,不错配上一模型的推理档);② 运行时 cordis patch 追加两条 by-id 覆盖(`agent-default-model` 默认模型 + `llm-deepseek` 目录单条目替换——显式指定模型多为中转场景,默认 v4-* 目录对其是误导,不硬编码上游 DEFAULT_MODELS 防漂移;cordis patch 语义核验:applyEntryPatches 对 by-id 浅层键赋值、config 整体替换,未知 id 仅 warn+skip 优雅退化)。默认路径保护:`LLM_MODEL` 不设时两轨均不动作,.env.example 默认行注释化,dsh 内置默认/用户 web 选择面不变。
  - E2E:`ts/scripts/model-override-e2e.ts` mock 中转四场景(指定模型→请求体 model 一致/指定+预置用户层→env 压过/不设→内置默认 deepseek-v4-flash/不设+用户层→用户选择保留;②④ 同一 settings 文件仅差 env,对照证明覆盖因果),隔离 DSH_HOME、要求 current tarball 的 clean installed-package bin,全绿；不再靠临时移动 vendored 依赖伪装 package mode。smoke §17 单元回归(未设零监听/无事件总线不抛/覆盖语义)。附查发现一项环境债:vendored 仓内形态 Node 兼容窗口断裂,记 D-27。

Evaluation Phase 0 foundation boundary: contracts/registry/validators/unmatched diagnostic fixtures/test-only aggregate admission plus a deterministic PR/nightly/weekly/milestone cadence policy/planner. It returns admission, `pass^k`, budgets, calibration, failure-registry, and cross-benchmark synthesis obligations only; it does not schedule or launch adapters, spend, generate a benchmark score, create an Agent optimization round, or support an uplift claim. No external runner, Python runtime dependency, baseline, or matched production evidence is included.

## 10. 债务清单(引擎细节工作只能来自这里)

> 债务只能在本表诞生,不许只活在代码注释里(§11 M-exit 清单第 3 条)。
> **§10.1 = 仍然开着的债**(要接的活从这里来);**§10.2 = 已清偿存档**(留证据,不再是工作面)。
>
> `D-24` 曾被会话扩展 onboarding 与事实闸覆盖面重复占用；事实闸债务现已迁至 `D-26`,编号冲突解除。

### 10.1 未清偿(工作面)

| # | 债务 | 状态 / 赎回时机 |
|---|---|---|
| [D-NEW] dsh 进程保活缺失 | 见下方「[D-NEW] dsh 进程保活缺失」 |
| D-9 节日锚点表硬编码 | **2026-08-28 扩表清偿**:SPRING_FESTIVAL 覆盖 2026-2031(2029-02-13/2030-02-03/2031-01-23),time-eval §1b 回归闸(2030 锚点断言 2031 春节)。**跨 2031 前必须再扩表**,否则春节锚点静默缺失 |
| D-12 loopx RFC 映射升级四接缝 | **已全部落地(RFC accepted 2026-08-27)**:S1 tool-packet envelope(ADR-13);S2+S3 记忆效用 sidecar + wish 触达 0..1(ADR-14);S4 WriteGate L0-L4 渐进授权词汇进 roadmap M5 交付物(2026-08-28);多用户 AaaS 方向见 RFC §6.5 远期采纳面 |
| D-13 会话适配器维护面(RFC user-session-data-rfc) | 见下方「D-13 会话适配器维护面」 |
| D-24 会话扩展 onboarding UX 缺口(issue #21 隐性状态) | 见下方「D-24 会话扩展 onboarding UX 缺口」 |
| D-15 账本触发式后置面(ADR-15 TS-5) | Litestream 云备份 / cr-sqlite 多写者复制 / RFC(loopx) §6.5 claim-fence-receipt 多用户实装——仅在触发器出现时启动:第二真实用户 / 多机部署 / AaaS 立项 |
| D-16 上游 dsh 发布面断裂 | 见下方「D-16 上游 dsh 发布面断裂」 |
| D-18 M3 Exit 真实 cohort 证据缺口 | 见下方「D-18 M3 Exit 真实 cohort 证据缺口」 |
| D-19 M4 真实 repeat cohort 缺口 | **证据合同已落地 2026-08-29**:Issue #20 fixture scorer 固定 paired/active-planning/reflux/溯源/P4 口径,synthetic fixture 不得充当 Exit。赎回条件=私有 `observed_private` cohort 达 N≥5 并产出脱敏 summary;无真实样本时 waiting/backoff/no-spend,不扩 schema 假装进展。 |
| D-22 pending_writes 空 receipt 无物理 CHECK(booking_saga_fsm.v1 已知边界) | 词汇层审计链已兜住(`sagaTraceViolations` 对空 receipt 报违例,run-all §36);**赎回时机 = M5 Entry 拍板**:pending_writes 随 schema 升版加 `receipt 非空 CHECK` + 具名 seam 词汇冻结(`booking-saga-fsm.md` §4),未到 M5 Entry 不动写路径 |
| D-23 效应解译器迁移未完成(ADR-18) | 见下方「D-23 效应解译器迁移未完成」 |
| D-26 事实闸覆盖面缺口(ADR-19) | v1 闸覆盖航班+政策 claim;酒店 claim 未入抽取面(flyai hotel 打码价语义独立,不落 bookable facts);政策事实只有渲染侧+闸侧,生产端无实时签证/入境源——政策 claim 只能降级「未确认」或省掉;反向抽取为正则启发式,不保证 100% claim 召回,根治方向=产物只由渲染原语单向生成;M5 WriteGate 接线预订类写工具时复审 | `ts/src/artifact-gate.ts`;run-all §39 |
| D-27 vendored 仓内形态 Node 兼容窗口断裂 | 见下方「D-27 vendored 仓内形态 Node 兼容窗口断裂」 |
| D-28 外部 benchmark 驱动的 Agent 泛化证据缺口 | 见下方「D-28 外部 benchmark 驱动的 Agent 泛化证据缺口」 |

**[D-NEW] dsh 进程保活缺失**

**部分赎回(gotry 侧)**:
- plugins/apply 内 installProcessGuards 挂 uncaughtException + unhandledRejection;incident-log.ts 同步 fsync append-only,handler 不调 process.exit——被崩溃穿透时仍能留下证据(JSONL incidents.jsonl),不阻塞 dsh 控制流。incident-tests 2/2 绿(handler 装上后未捕获异常仍记录,后续控制流不卡)。**gotry 侧收尾 2026-08-22**: 12 工具 execute 统一经 guardToolExecute 异常隔离——
- 抛错/拒绝降级结构化错误返回 LLM + tool_execute_error 落盘,不再穿透 cordis 到 dsh 主循环(incident 套 3/3);残余仅 vendored dsh 自身容错,记 M3

**D-13 会话适配器维护面(RFC user-session-data-rfc)**

**部分清偿 2026-08-30**:action-cache + 金标准输入 + #21 字段 fixture scorer/双源 shape gate 已落;传输层定案扩展桥(§38 防漂移测试把 Node 常量与扩展代码锁死);Issue #67 增加 `--golden=static` 离线 comparator(OpenFlights 固定 route/carrier + manual 时刻/价格带,requested/effective/provenance/fallback 可审计,§44),但它不是实时可售性来源、也不降低携程 batchSearch 改版风险;真实 sf-01..08 会话证据仍依赖用户扩展连接,站点断时按既有渠道显式降级

**D-24 会话扩展 onboarding UX 缺口(issue #21 隐性状态)**

**部分清偿 2026-08-30**:
- **基础版(founder 实测)**:2026-08-30 实证「能装≠装到能用」,降到 **3 次点击 + 0 次终端命令**(5 步 wizard + 剪贴板 + GUI 面板 + health-watch 自动重放)
- `ts/capabilities/session/{wizard,health-watch}.ts` + `ts/scripts/health-watch-cli.ts`(bootstrap spawn tsx 子进程,inline 降级兜) + bootstrap `wizard` 子命令 + run-all §40 onboarding-tests 9/9 + bootstrap-tests 7/7 wizard 节。
- **2026-09-02 商店上架 + 职责返交**:wizard 撤销 5 步形态,`sessionFlightSearch`/`sessionLogin` 在 `needs-extension` 时返回 `verdict.installUrl`,dsh UI 直接渲可点链接——用户侧进一步降到 1 次点击(Chrome 商店「添加至 Chrome」)+ dsh 自动 retry,gotry CLI 完全不介入。

**D-16 上游 dsh 发布面断裂（Round 5 工程面已清偿）**

**已验证解法②并落地 2026-08-28(记忆域 lane)**:
- D-16 前提有误——npmjs 上 dsh-scope **有完整 0.1.x**(0.1.1-rc.2 在列;lane 查的是滞后的内部 bnpm 镜像)。根 dependencies 已显式钉 `dsh-scope@0.1.1-rc.2`,干净安装实测:ERESOLVE 仅降级为 warning、ledger/index/dsh-tools 全部 import OK、五导出齐(AuthoritativeEntries 等)。rc.10 已发布(founder 确认制下 agent 执行:web 登录 + 浏览器二次验证,恢复码被 npm 拒收改用 web OTP 通道)。
- **2026-08-29 增补**:dsh 家族 0.1.2-alpha.1 未发 npm 时，以 `ts/dsh-runtime/vendor/` 全量源码 tarball 暂时解除 repo 工作副本堵点。
- **Round 5 清偿**:root manifest、package-lock 与 root pnpm importer 把公开 npm `0.1.2-alpha.3` closure 的 216 个 `@deepseek-ai/dsh*` 包全部声明为精确直接依赖，publish preverify 永久拒绝名称集合漂移、漏钉、混版与 range；source/package runtime root-first 解析。source 普通运行保留 `ts/dsh-runtime/` cwd 与 `ts/dsh-runtime/gotry-state/` 连续性，package/benchmark 使用调用目录隔离。legacy alpha.1 vendor 不再承载 benchmark 或推荐源码安装路径，只保留解析兼容且不承诺可运行。发布 GoTry 新版本仍受 founder 确认制与独立发布闸约束，本轮不发布。

**D-18 M3 Exit 真实 cohort 证据缺口**

**进行中(Issue #22)**:公开面已有冻结 manifest、严格脱敏 schema、确定性 scorer 与 synthetic fixture 守门；nightly real-LLM 证据生产器已进入工程面(封存 prompt 集/价表、无凭证 waiting 零写入、预算闸),验收⑥「nightly 可复跑」的机械前提已就位,真实 nightly 记录待凭证环境真跑。私有真实样本尚未进入 `ts/gotry-state/evidence/m3/`。只有 50–200 人真实 cohort 同时达到定稿率 ≥40%、NPS ≥40、POI 幻觉率 <1% 且窗口内 nightly real-LLM 可复跑,才允许业务达标;无样本时不关闭 M3 Exit。 | `product-metrics.ts`;`nightly-evidence.ts`;run-all §33/§35

**D-23 效应解译器迁移未完成(ADR-18)**

**部分清偿**:词汇层+生产/mock 解译器+韧性横切已落地,五工具(flyai/hotel/session/weather/flight_verify)与 realtime-pricing 默认查询口已走 `interpretEffect`;`anything/web_search/video_subtitle/github_search/agent_reach/session_login` 等其余渠道工具仍直连能力层(同款永不抛错契约,无退避/熔断/mock 面)。按渠道逐个搬,搬一个删一横切;全部走通即抄销 | `ts/capabilities/effect.ts`;`docs/effect-interpreter.md` §4;run-all §37

**D-27 vendored 仓内形态 Node 兼容窗口断裂**

**发现于 2026-08-30(issue #77 E2E 前置)，Round 5 部分清偿**:
- `session-persistence-jsonl` 需 `node:zlib` 的 `createZstdDecompress`（Node ≥22.15，22.14 实测缺导出）；Round 5 已把 package engines、CLI 启动前闸与源码安装文档统一到 22.15+，并让 source checkout 优先解析 root alpha.3 closure；source 普通运行仍保持 `ts/dsh-runtime/` cwd 与状态连续性。
- legacy `ts/dsh-runtime` alpha.1 只保留为非 benchmark 解析兼容；其 `.ts` 直载仍受 Node strip-only 限制，parameter properties（`ts/capabilities/resilience.ts:109` 与 `session/action-cache.ts:61`）在 Node 26 会触发 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。benchmark 对该 legacy runtime 在 spawn 前稳定拒绝，npm/dist 形态不受影响，且 legacy fallback 不承诺可运行。**剩余赎回**:若继续保留 legacy vendored 工作流，独立 PR 升级整套 vendor 或改两处 parameter properties 并真跑 smoke；不得把 legacy fallback 当 alpha.3 parity 证据 | `ts/capabilities/resilience.ts`;`ts/capabilities/session/action-cache.ts`

**D-28 外部 benchmark 驱动的 Agent 泛化证据缺口**

ChinaTravel grounding-v3 的冻结 5-query canary 只完成 1 个可评分终态,第二例在 planner 重复工具调用中触发 300s timeout；因此当前没有合法 5-query 聚合。Round 1 已增加 GoTry 每轮工具预算与 text-only 收敛边界,且 npm-mode dist + dsh headless 离线 E2E 证明真实 runtime 会执行 18 个 body、结构化拒绝同批第 19 次、随后无工具完成 final；Round 1 exact DeepSeek treatment 仍为 environment unavailable/schema-invalid 0,另一个 GLM run 为 300s timeout。Round 2 bridge 已通过 unit 与 model-driven source/installed-package synthetic E2E，并加入 per-tool 正向输出键合同及 cold-start/native/exact-definition-only 工具隔离；其唯一冻结 treatment 的 provider/planner 正常，但 agent 没有产生 structured bridge call 与 tagged JSON，runner 在 evaluator 前退出，official scores 全为 null。Round 3 以 provider-neutral conformance 修复 CLI→native call、成功 result 配对、一次固定纠偏、格式纠偏零重复派发与 parent tagged-JSON stdout 闸；其新冻结 treatment 仍以 planner/runner exit 1、0 字节终态停在 evaluator 前。Round 4 再把 benchmark 启动投影为唯一 `gotry-tools`，并对 insert/plugin-name/config-path 锚点全链 fail-closed；其 treatment（SHA `5ebddb2`）primary preflight=pass，但 planner/runner 均在 30.968s 以 exit 1 结束，释放 0 字节，evaluator 未进入，official scores 全为 null；产品 gate 使用 Node v24.20.0，而 treatment 使用 v26.3.0，因此仅 diagnostic-only、无 uplift。GitHub Node 22/24 §48 另暴露 source default-off 30s lifecycle hang。Round 5 仅限移除 timer/keepalive preload、将锁定的 DSH runtime closure 设为 alpha.3、保留源码普通运行的 `ts/dsh-runtime/gotry-state/` 状态连续性、让 benchmark/package 用调用目录隔离，并增加 benchmark-only 结构化诊断 pipe（allowlisted redacted reason codes），stdout 继续 fail-closed；其 frozen treatment（代码 SHA `752e54c`）在 140.715 秒后以 `child_nonzero_exit`、0 terminal bytes、evaluator/official scores null 停止，仅 diagnostic-only，后续纯 lock-consistency 提交不改写该 UID 归属。**赎回顺序**:source/installed startup+conformance 合同与全回归通过 → 新冻结 case 在 no-oracle 边界下 `exit=0`、非空 terminal、planner<300s且 evaluator 执行 → 原 manifest 5/5 终态且 schema/forbidden/七指标完整 → 按 registry 扩展其他公开 benchmark并在 3–5 个独立优化 PR 后综合归因；在匹配 evidence 前不声称分数提升或 external closure。

Round 6 只把最终结构化 `turn/end` 细分为闭合、脱敏的原因族，并用 per-session 单写仲裁保留更具体的 bridge/conformance 原因；它不解析 raw stderr，也不修改重试、prompt、工具或 scorer。代码 SHA `c61600b` 的新 frozen treatment 在 49.546 秒后把此前泛化的 `child_nonzero_exit` 收敛为 `child_runtime_error`，但仍为 0 terminal bytes、evaluator/official scores null；因此 D-28 仍开放，当前不产生 score/uplift 结论。
Round 7 将 benchmark opt-in 收敛为 minimal kernel，并把 system-prompt/root patch 做成稳定 task-agnostic、canonical fail-closed 投影；默认路径不变。代码 SHA `edb9392896625adbb48abae4a2ecf968dbfc0349` 的 ChinaTravel frozen treatment UID `e20241028160248698752`（`easy`，`deepseek-v4-flash`）80.463s 后 runner exit 1、terminal 0 bytes/invalid，evaluator 未进入、official null、不可计分；白名单归因为 `child_bridge_runner_failed`，不产生 uplift 或 external closure。下一轮只研究 generic bridge tool schema 与可恢复 domain-error contract。

### 10.2 已清偿(存档)

| # | 债务 | 清偿 |
|---|---|---|
| D-1 双引擎算术复制 | **已清偿**(统一模型落地,洱海对账等价) |
| D-2 TS unsatCore 竖线 | **已清偿**(coreOf 剥竖线+回归断言) |
| D-3 LLM 未进环 | **已清偿**(S4 由 MiniMax-M2 完成,`bb880f3`;mock 留作回归夹具,ADR-8 兑现) |
| D-5 时区语义 | **已清偿**(EK329 官网逐分一致) |
| D-4 gate/卡片无承载界面 | 已清偿,详见下方 |
| D-4a'(agent-reach 100% follow) | 已清偿,详见下方 |
| D-4\'(Anything 数据接入) | **已完成 2026-08-23**: gotry capabilities/anything.ts 11 套实测 5/5 + hbcli `search anything` 子命令 + hotel-be `/api/search/anything` `@path` 注解;三仓 commit 闭环(244a0ae/c38ff65d1/43236a0) |
| D-6 红眼睡眠模型未校准 | **已校准 2026-08-28**:红眼航段落地后接驳(机场→住处/办公室)乘车补眠回血(1h≈+5%,上限 80)——对账真值:引擎原算 75%(机上睡眠),你真实体感 80%(75+1.5h 路上补眠);落地补眠此前未算,现加 `groundRecoveryMin` 参数;EK329 精力 75→79(45min 接驳×5%/h≈+4),unified 断言同步 |
| D-7 deprecated 层仍承重 | 已清偿,详见下方 |
| D-8 对话循环不进 CI | **已清偿**(replay 带终态断言 + 异步工单跨进程闭环 + smoke 进 `run-all-tests.sh` §5-7) |
| D-10 slot→spec 求解桥接未做 | 已清偿,详见下方 |
| D-11 `npx tsc --noEmit` 存量 14 错 | **已清偿**(1bf9671,语义零变更:tsc 0 错;smoke/memory §18 全过;17 套 ALL GREEN) |
| D-26 扩展在线时默认桥钉住 CLI | 已清偿,详见下方 |
| D-25 扩展商店上架(ADR-21 分发 B 轨) | 已清偿 2026-09-02,详见下方 |
| D-14 playwright-core 分发面(RFC) | **基本清偿 2026-08-30**:传输主载改自研扩展桥(零新依赖,node:http);puppeteer-core 降为 cdp 显式后备车道的可选依赖(动态导入+缺包优雅降级);`extension/` 进 npm files 白名单,`gotry setup` 负责落位与加载指引。**残余**:D-16 上游发布面断裂修复前,session 面在 npm 干净安装下的端到端实测未完成 |
| D-17 Z3 WASM race(README Known limitation) | 已清偿,详见下方 |
| D-20 六状态面里程碑口径漂移 | **已清偿 2026-08-29(Issue #19)**:六状态面统一为「M3 真实 evidence 未收口；M4 为 founder 授权并行，不是 M3 Exit 证明；M5/M6 仅受各自 Entry gate 开闸」。后续不得把工程交付、发布或并行切片等同于里程碑退出证据。 |
| D-21 async 非 4/4 被误结算为成功 | 已清偿,详见下方 |

**D-4 gate/卡片无承载界面**

**词表内赎回 2026-08-22**:
- feasibility + 酒店/天气/Anything/AgentReach 五工具 presentResult 结果卡(可行性:候选判定+预算行;酒店:N 家(实时/静态);天气:ok/降级;Anything:N hits;AgentReach:✅/🔧/📦/❌ verdict)+ 12 工具 kind 图标分类(search/fetch/execute/edit,零 other);**地图位已解 2026-08-22**:宿主插件 dsh-map-tools v0.4.4(7 个 map_* 原生工具:驾/公/步/骑路线+地理编码+POI,零 key 走 OSRM,高德可后配)——
- dsh-map-tools 仍是可选宿主插件：legacy vendored runtime 可提供，root/package 形态按当前依赖可解析性挂载；patch 条目占位、缺依赖整块剔除不挡启动；root `./gotry` 统一走 inner。

**D-4a'(agent-reach 100% follow)**

**已完成 2026-08-23;2026-08-22 wrapper 化**: Agent-Reach v1.5.0 装于 .venv(与 z3-solver 同址);gotry 侧为薄壳 —— agent-reach-bridge.py 反射桥(get_channel+getattr 直调上游注册表)+ agent-reach.ts 管道层,零渠道知识,上游加渠道零改动;gotry_agent_reach(action=reach 反射 / status 真 doctor);needs-setup 透传上游 check() 原话

**D-7 deprecated 层仍承重**

**大部赎回**:dsh 插件进程内路径切轨 solveChoiceSegment(枚举,~0ms)、cli.py 桥切轨 solve_choice_segment、diff-test 切轨统一模型对统一模型;engine/journey 退纯 oracle(保留为金标准对照)。**尾债清偿 2026-08-22**:删 build_plan.py + gotry_async/demo.py + run-golden-case.sh(已断:调 rc.3 删除的 cli.py);py 树仅剩 gotry_feasibility oracle 对照 + 其 unittest

**D-10 slot→spec 求解桥接未做**

**已清偿 2026-08-27(三切片)**:
- A `slot-spec.ts` 解析层(锚点卡词表/绝对/+N → 绝对日期,词表外 unresolved;time-eval §5);B 工具面接线(`gotry_hotel_search` 日期槽位收逐字表达,unresolved 降级无日期搜索+date_notes,smoke §8);C spec 链路一致性闸(runTurn 求解前比对,分歧不求解、追问确认,replay 尾段)。**ADR-12 复审结论:设计成立**,解析范围必须有界(只解析锚点卡词表,不做开放式中文相对日期解析——被拒备选即维护黑洞)。
- **闸范围边界(2026-08-28 真模型巡检修正)**:槽位 v1 只有 trip 级主日期,闸仅校验恰好一个带日期段的 spec;多段行程逐段日期无槽位真值,不判(金标准六段行程曾被全段误判分歧拦死求解,巡检抓出后收窄,多段旁路回归进 replay 尾段)

**D-26 扩展在线时默认桥钉住 CLI**

**已清偿 2026-08-30**:`server.unref()` 不会自动解开已接受 socket 与 parked 长轮询 timer,导致 `SMOKE OK` 后进程仍存活;默认桥对两者 `unref`,active submit timer 与 `keepBridge=true` 保持引用。§38 子进程红→绿 + §40 9/9 + 真扩展 smoke exit 0 守住。

**D-25 扩展商店上架(ADR-21 分发 B 轨)**

**已清偿 2026-09-02**:Chrome Web Store 过审发布 v0.1.0([商店页](https://chromewebstore.google.com/detail/gotry-session-bridge/oeajpiccmonococjcegddlooeeohlbgd)),一键装 + 自动更新通道打通。上架实测坐实材料预案——商店用自己签名 key 重签、不认 manifest 固定 key,商店版 ID 与 unpacked 固定 ID 不同;影响面按预案收口:桥 Origin 白名单双通道同信(`EXTENSION_ORIGINS`,§38 新增商店源断言),扩展代码/manifest 零改动。wizard/README/needs-extension 文案全部商店优先;「已装商店版自动跳过 dev-mode 三步」检测残余转 D-24。

**D-17 Z3 WASM race(README Known limitation)**

**已清偿 2026-08-29**(`z3-shared.ts`):双重根因一并关闭——①三模块(engine/journey/unified)各自 `init()` 使单进程并存 2-3 份 WASM 实例(内存放大,系统压力下 2GB 堆分配失败的 OOM 形态);②`engine.solve` 用 `Promise.all` 多候选并发共享同一 Context,z3 async 会话交错即栈损坏(`mk_bool_var memory access out of bounds`,run-all §1 长期靠「重试一次」止血)。
- 现三入口经 `withZ3` 会话级互斥(单实例单 Context,门内禁嵌套),rc.4 当年单例回滚的「Context mismatch」源于残留自建 Context 混用,现无混用面;run-all §1 止血退役,新增 §30 并发回归闸(进程内三形态同轮并发 ×12 与顺序基线逐项对账) | `z3-shared.ts`;run-all §30

**D-21 async 非 4/4 被误结算为成功**

**已清偿 2026-08-29(Issue #19)**:`collectDeepPlanning` 产出 `gotry_async_terminal.v1`；collector 仅在 4/4 时写 `succeeded`/ledger `settled`/exit 0，任一未达写 `failed`/ledger `failed`/exit 2；账本保存结构化结果，终态复诵零重算且保持同一退出码。隔离 `stateRoot` 回归见 run-all §28。

| # | 债务 | 状态 / 赎回时机 |
|---|---|---|
| D-28 Evaluation Phase 0→Phase 1 adapter admission | Evaluation Phase 0 foundation now includes contracts/registry/validators, unmatched diagnostic fixtures/test-only aggregate admission, and a deterministic cadence policy/planner. The planner has no scheduler, launch, spend, scorer, baseline, or uplift effect. | **open**: every adapter, external runner, baseline, and matched production-evidence path still requires a separate approved plan/PR plus the license/evaluator/source-fence controls in [`evaluation-foundation.md`](evaluation-foundation.md) |
| D-29 Booking Copilot 真实库存产品验收 | typed read-action/BFF/task ledger 与可复现 Linux 产物只证明工程边界；不证明供应商库存、不可订恢复或 Checkout/订单状态业务效果 | **open**:冻结三仓 exact SHA 后，在 tenant/customer/storefront/payment-link 四 surface 跑真实库存；至少一条 unavailable/changed 报价必须经重新搜索、新 CheckAvail、原 Checkout 恢复；Book 仍仅由 Checkout 授权，并以 QueryOrders/清理证据收口 |

## 11. 保鲜机制(文档与现实的同步纪律)

**Booking Copilot v2 当前生命周期投影**：六个阶段为 `planning → submitted → working → waiting_receipt → input_required → terminal outcome`；公开类型保留七个 phase 字面值，其中终态结果分为 `terminal` 与 `error`。`action.receipt`、`approval.granted/consumed` 与 decision batch 是恢复和精确 SSE replay 的权威事件，BFF 生成并重用稳定 opaque `taskId + turnId` 身份对绑定 durable user turn replay，presentation key/随机 delivery nonce/option digest 绑定 approval。availability reducer 另有 `need_offers → waiting_offers → need_check → waiting_check → terminal` typed 子状态，并持久化 candidate/generation/attempt budget；它不改变外层六状态投影。v1 保持 legacy 两态 `planning → waiting_receipt` 投影；两协议共用 listener 与 task ownership，但不把 v1 宣称为 v2 生命周期投影。

**状态面清单**(全仓只有这 6 处记载「当前状态」,其余文档一律状态让渡):① 本文 §1 当前形态;② 本文 §9 演进;③ 本文 §10 债务清单;④ `roadmap.md` 当前位置;⑤ `README.md` 当前形态;⑥ `stage1-top-down-design.md` 状态头。

**同提交同步规则**:任何改变系统当前形态/状态/债务的提交,必须在同一提交内同步全部状态面——`bb880f3`(M1 exit)只改了 §1 与 ADR 表,四处状态面滞后了一个提交周期,本节由此而立。

**M-exit 保鲜清单**(里程碑退出提交的勾稽项,结果附于提交信息):
1. 6 处状态面全部同步(或显式让渡并注明让渡对象);
2. ADR 全表逐条过「淘汰/复审条件」,触发的当即立项或改状态;
3. 债务清单勾销与新增——债务只能在本表诞生,不许只活在代码注释里;
4. 计数类表述(ADR 数、测试数)改为引用而非数字——数字会腐烂;
5. 验收证据可复跑:夹具/脚本命令写进提交信息。

**复审节奏**:不靠日历,靠事件——M-exit 必审全表;淘汰条件被触发(求解 >500ms、差分 20 次无分歧、桥延迟 >500ms)随时审。

## 12. 文档地图

| 文档 | 关注点 |
|---|---|
| `roadmap.md` | **时间线唯一来源**:M0-M6 里程碑三线视图与旧模型归并 |
| `data-sources.md` | **数据源唯一权威面**:领域矩阵/四层架构/Google Place 链路/证据链契约/TREK 参考 |
| `tokens.md` | **token 唯一权威面**:npm 三路径(web会话/granular bypass/OIDC)+ agent-reach 8 渠道获取表 + 统一 .env 存放 |
| `tech-strategy.md` | 技术选型与半年迭代路线(M2–M4):选型矩阵/评测体系/分工/持续优化回路/决策登记 |
| 本文 | 技术:系统/模块/模型/循环/数据概要/ADR/演进/债务 |
| `gotry-master-outline.md` | 程序:工作分解/复用矩阵/决策门(总纲) |
| `gotry-product-design.md` | 产品:主循环/透明机制/全成本/共享经验 |
| [`evaluation-foundation.md`](evaluation-foundation.md) | Evaluation Phase 0 contracts, registry ownership, aggregate admission, and non-uplift boundary |
| `stage1-top-down-design.md` | Stage 1 详细设计与实现序 |
| `kimi-postmortem.md` | 反例教材与地面真值提取 |
| `demo-plan-2026-07-17.md` `demo-reconciliation.md` | demo 交付物与对账 |
| `dsh-plugins-shortlist.md` | dsh 社区插件选型(awesome-dsh-plugin 全量调研,issue #9) |
| `deerflow-research.md` | DeerFlow 研究 → gotry 优化目标 T1-T4(issue #10) |
| `maka-research.md` | Apache Maka(Incubating)研究 → 与 ADR-15 事务化状态基座逐项对照(durable-execution 机制/可采纳面,研究底稿供 founder 拍板) |
| `hotelbyte-skills-design.md` | hotelbyte-skills 架构(知识进仓/执行留 gotry,issue #5) |
| `e2e-prompts.md` | dsh 端到端真 LLM 验证记录(§1-§11,wrapper/澄清卡/背景调查等) |
| `memory-design.md` | **记忆域设计**:C 端六层重设计(M1-M6 现状映射/P1-P4 分期增量/铁律与验收),M4 交付「六层框架重设计」的正式文档 |
| `loopx-inspired-upgrades-rfc.md` | **RFC(accepted 2026-08-27)**:loopx 13 篇架构 RFC 的映射升级——四道接缝(S1 工具 packet 纪律/S2 记忆效用 sidecar/S3 wish 触达 0..1 纪律/S4 WriteGate L0-L4 词汇) |
| `transactional-state-rfc.md` | **RFC(accepted 2026-08-28,ADR-15)**:事务化状态基座——业界 durable-execution 调研收敛五件套 + GoTry 落地架构 + TS-0..TS-5 执行计划与决策记录(D1-D5) |
| `booking-saga-fsm.md` | **预订 saga 状态机设计(issue #17 采纳,ADR-17)**:booking_saga_fsm.v1 字母表/边表/拒绝闭集 + 三种边型词汇(deterministic/gate/external-event)+ HITL 审批的挂起-恢复形态 + M5 启封增量与不引入编排框架的判定记录 |
| `effect-interpreter.md` | **效应解译器设计(issue #16 采纳,ADR-18)**:effect_interpreter.v1 词汇(效应值/EffectOutcome/trace)+ 渠道韧性策略表(退避/断路/节律依据逐行)+ 生产/mock 双解译器 + 为什么不做视觉 CUA 与自动多渠道路由的判定记录 + D-23 迁移面 || `user-session-data-rfc.md` | **RFC**:用户会话数据面——官方通道优先 + 用户会话补缺,四阶段落地(P0-P4)与决策门 |
| `user-guide.md` | 面向使用者的上手指南(dsh 形态用法) |
| `release-notes.md` | 发版记录(按版本归档,最新在上) |
| `decisions-needed.md` | 待创始人拍板的决策清单 |
| `m3-web-gap.md` | M3 Web 形态缺口(G-1..G-4 方向) |
| `m4-calibration-questions.md` | M4 校准问题集 |
| `extension-webstore-submission.md` · `extension-privacy.md` | Chrome Web Store 上架材料与隐私政策(ADR-21 通道 B) |
| `maka-research.md` | MAKA 竞品/形态研究 |
| `m2-capability-gap.md` · `m2-flight-data-options.md` | M2 期能力缺口与机票数据选型(历史备忘) |
| `s1-walkthrough.md` · `g1-market-memo.md` | Stage 1 走查与 G1 首发市场备忘(历史备忘) |
