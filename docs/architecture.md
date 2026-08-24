# GoTry 技术文档(唯一技术权威面)

> 定位:本仓的**完整技术文档**——系统是什么、怎么构成的、每个模块在哪、怎么跑、往哪演进。
> 纪律:单一文件承载单一关注点,版本历史归 git,不设 vN 文件后缀;上游为总纲(`gotry-master-outline.md`)与产品设计(`gotry-product-design.md`)。
> 下游:loopx todos 依本文§9 演进阶段与§10 债务清单派生;引擎/求解器细节工作只在债务清单标注时进行。

---

## 1. 系统是什么

**GoTry 是「从出发到下一次出发」的 AI 旅行 Agent**:动机访谈进、已验证的行程方案与选择题出;LLM 负责理解与解释,确定性组件负责判定与算术,写操作永远有闸。

**当前形态(诚实定位,2026-08-23 `v0.0.1-rc.3-dev` @ `244a0ae`)**:dsh 成品可用(`./gotry`,DeepSeek 原生)——人格(八条行为契约,新增时间感知)+ 十二工具(**可行性/骨架/酒店/天气/航班/Anything/网页/视频字幕/GitHub搜索/AgentReach统一路由/动机/愿望池**);机票三层(骨架 168 对+校验桥+锚点)+ 酒店 hbcli 桥(实时/静态降级+证据标注)+ **Anything 通用搜索**(gotry `capabilities/anything.ts` → hbcli `search anything [keywords...]` → hotel-be `/api/search/anything`;三仓 commit 244a0ae/c38ff65d1/43236a0);OpenSky 实时 ADS-B + Open-Meteo 天气免费接入;**agent-reach 100% follow**(Panniantong/Agent-Reach v1.5.0 CLI 装于 .venv/(python3.11 单 venv, 与 z3-solver 同址) + 13 渠道路由表代码化 ts/capabilities/agent-reach-router.ts + gotry_agent_reach 统一工具 + 真 doctor 体检);**License MIT 落定**(2026-08-23);证据链从工具到用户渲染面贯穿。**v0.0.1-rc.3 收口**: 去掉 Python oracle(cli.py / bridge.callFeasibilityEngine / loop.ts erhai-python-bridge / diff-test ts-vs-python)——**纯 TS unified 求解**(`solveChoiceSegment` 枚举,~6ms/次);npm 一键启动骨架(根 package.json + bin/gotry.js + vendored dsh 0.1.1-rc.2 pnpm install);headless 路径实测 ✓;D-NEW 进程护栏(incident-log fsync 兜底 dsh 异常退出);README '一行安装' 5 步段;engine/journey 退纯 oracle;run-all-tests **11 套 exit=0 ALL SUITES GREEN**(weather + opensky + anything 三新能力层均纳入)。M3 最小可用产品。

## 2. 总体架构:五层与现状

```
L1 交互:对话即界面(gates 以消息内选择题呈现;独立 UI 属 Stage 1 后)
L2 编排:对话循环 ts/src/loop.ts —— LlmPort(mock✅/真✅ provider-neutral) + 确定性访谈 + 求解挂载
    └ dsh 插件 gotry-tools:✅ 已在真实 dsh 0.1.1-rc.1 headless 运行时端到端(68ea364)——模型经 pi-ai(MiniMax-M2)主动调用 gotry_feasibility_check 并引用引擎数字;组合见 ts/cordis.gotry-patch.yml
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
| `py/gotry_feasibility/unified.py` | Python oracle(v0.0.1-rc.2 后**仅历史对照**,不再被产品运行时引用) | 保留 |
| `py/gotry_demo/` | **已删 2026-08-22**(D-7 尾债:demo 规划书生成器曾调废弃 journey.solve_journey;产物 docs/demo-plan-2026-07-17.md 留 git 历史) | — |
| `ts/scripts/replay.ts` `replay-async.ts` | **验收夹具**:真实对话重放(13 轮→3 轮)与异步形态 | ✅ |
| `ts/scripts/{engine,journey,unified,diff}-tests.ts` | 套件(8/5/4 断言+TS-vs-TS 同 spec 稳定性) | ✅(diff-test 顺序偶发为已知问题,v0.0.1-rc.2 后不再依赖 Python) |
| `data/golden_erhai.json` `flights_2026.json` `hotels_2026.json` `golden_trip_2026.json` `行程细化计划.docx` | 金标准用例/班期/住宿/完整任务/Kimi 对话原件 | — |

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

- 运行时:三条已实证路径——①TS 进程内(自研循环,~6ms/解);②真实 dsh headless+cordis 组合(pi-ai→MiniMax,`ts/cordis.gotry-patch.yml`,68ea364);**(v0.0.1-rc.2 起第三条** Python CLI 桥下线,纯 TS)。环境三件套 `LLM_API_KEY/LLM_BASE_URL/LLM_MODEL`(兼容旧 DEEPSEEK_*)。
- 复用落地:dsh(import,rc 已对齐)/loopx(import,0.5.1 运行中)/Z3(import,双绑定)/hotelbyte-cli(import+extend,place 链路见 data-sources.md §4)/travel_agent·ai-agent-book·TREK(reference,零代码——TREK 数据面模式采纳表见 data-sources.md §5)。

## 7. 测试与验证策略

**评测三层(ADR-11)**:
- **回归层(防退化)**:TS-vs-TS 双路径稳定性(同 spec 不同 module instance)+ 金标准断言(洱海 8+5、普吉链 4、统一模型 20/20)+ **重放夹具**(mock 重放即行为级回归,Kimi 对话是失败基线)。**v0.0.1-rc.2 起:** 不再依赖 Python oracle 差分;run-all-tests 9 套一次性绿,无需 Python 运行时。全栈入口:`scripts/run-all-tests.sh`。
- **质量层(防漂移)**:评测集+指标面板——POI 幻觉率、定稿率、不失望四条、NPS;M3 上线(见 `tech-strategy.md` §4),此前以 replay 终态断言兜底。
- **巡检层(防「mock 绿而真智能烂」)**:真 LLM 重放(`replay-real.ts`)转 nightly,带预算闸;ADR-10 正是 mock 绿而真 LLM 烂出来的,教训制度化。

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

## 9. 演进(时间线唯一来源= `roadmap.md` 的 M0-M6;此处只保留原则与现状)

原则:**不跳阶段,不提前优化下阶段的事**;每阶段 Entry/Exit/gate 见 roadmap。旧 Stage 0-4 与总纲 Phase、产品 M1-M3 已归并映射到 M0-M6(映射表在 roadmap)。

- **M0 ✅ / M1 ✅(bb880f3)/ M2 ✅(b0cfd97)**:M2 交付 = §7-1 三层组合(骨架+校验+锚点)+ hbcli 桥 + dsh 端到端(DeepSeek 原生,人格+五工具)+ 一键入口 `./gotry`;G1/S1/§7-1 三 gate 由创始人指令结算。
- **当前 = M3(工程面完成,tag `v0.0.1-rc.3` @ `3e7791a`,HEAD `v0.0.1-rc.3-dev` @ `244a0ae`)**:薄壳七段 ✅(三页/路由/休假/持久化/云南包/Markdown/UX);三场景全验(洱海/云南/普吉)。**v0.0.1-rc.3 收口**:完全去 Python(cli.py / bridge.callFeasibilityEngine / loop erhai-python-bridge / diff-test ts-vs-python / gotry bash 全部下线);npm 一键启动骨架(根 package.json + bin/gotry.js + vendored dsh 0.1.1-rc.2);headless 实测 ✓(fix 默认 mode + argv 解析);D-NEW 进程护栏(incident-log fsync);**D-4 DONE** (Anything 通用搜索:gotry capabilities/anything.ts + hbcli `search anything` 子命令 + hotel-be `/api/search/anything` @path 注解;三仓 commit 闭环);天气 / OpenSky / Anything 三能力层实测 11 套 exit=0;README '一行安装' 5 步段(从 4 步扩到 5:加 vendored dsh runtime pnpm install)。**M3 剩余=种子用户启动(等 remote 与 License 决策)**。此后 M4 记忆 → M5 交易 → M6 B2B。不跳阶段。

## 10. 债务清单(引擎细节工作只能来自这里)

| # | 债务 | 状态/赎回时机 |
|---|---|---|
| D-1 双引擎算术复制 | **已清偿**(统一模型落地,洱海对账等价) |
| D-2 TS unsatCore 竖线 | **已清偿**(coreOf 剥竖线+回归断言) |
| D-3 LLM 未进环 | **已清偿**(S4 由 MiniMax-M2 完成,`bb880f3`;mock 留作回归夹具,ADR-8 兑现) |
| D-5 时区语义 | **已清偿**(EK329 官网逐分一致) |
| D-4 gate/卡片无承载界面 | **大部赎回**(薄壳三页,v0.0.1-rc;地图位/预算条待) |
| D-4a'(agent-reach 100% follow) | **已完成 2026-08-23;2026-08-22 wrapper 化**: Agent-Reach v1.5.0 装于 .venv(与 z3-solver 同址);gotry 侧为薄壳 —— agent-reach-bridge.py 反射桥(get_channel+getattr 直调上游注册表)+ agent-reach.ts 管道层,零渠道知识,上游加渠道零改动;gotry_agent_reach(action=reach 反射 / status 真 doctor);needs-setup 透传上游 check() 原话 |
| D-4\'(Anything 数据接入) | **已完成 2026-08-23**: gotry capabilities/anything.ts 11 套实测 5/5 + hbcli `search anything` 子命令 + hotel-be `/api/search/anything` `@path` 注解;三仓 commit 闭环(244a0ae/c38ff65d1/43236a0) |
| D-6 红眼睡眠模型未校准 | 对账 Q10 |
| D-7 deprecated 层仍承重 | **大部赎回**:dsh 插件进程内路径切轨 solveChoiceSegment(枚举,~0ms)、cli.py 桥切轨 solve_choice_segment、diff-test 切轨统一模型对统一模型;engine/journey 退纯 oracle(保留为金标准对照)。**尾债清偿 2026-08-22**:删 build_plan.py + gotry_async/demo.py + run-golden-case.sh(已断:调 rc.3 删除的 cli.py);py 树仅剩 gotry_feasibility oracle 对照 + 其 unittest |
| D-8 对话循环不进 CI | **已清偿**(replay 带终态断言 + 异步工单跨进程闭环 + smoke 进 `run-all-tests.sh` §5-7) |
| [D-NEW] dsh 进程保活缺失 | **部分赎回(gotry 侧)**: plugins/apply 内 installProcessGuards 挂 uncaughtException + unhandledRejection;incident-log.ts 同步 fsync append-only,handler 不调 process.exit——被崩溃穿透时仍能留下证据(JSONL incidents.jsonl),不阻塞 dsh 控制流。incident-tests 2/2 绿(handler 装上后未捕获异常仍记录,后续控制流不卡)。**gotry 侧收尾 2026-08-22**: 12 工具 execute 统一经 guardToolExecute 异常隔离——抛错/拒绝降级结构化错误返回 LLM + tool_execute_error 落盘,不再穿透 cordis 到 dsh 主循环(incident 套 3/3);残余仅 vendored dsh 自身容错,记 M3 |

## 11. 保鲜机制(文档与现实的同步纪律)

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
| `stage1-top-down-design.md` | Stage 1 详细设计与实现序 |
| `kimi-postmortem.md` | 反例教材与地面真值提取 |
| `demo-plan-2026-07-17.md` `demo-reconciliation.md` | demo 交付物与对账 |
