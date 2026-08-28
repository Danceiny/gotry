# GoTry 技术文档(唯一技术权威面)

> 定位:本仓的**完整技术文档**——系统是什么、怎么构成的、每个模块在哪、怎么跑、往哪演进。
> 纪律:单一文件承载单一关注点,版本历史归 git,不设 vN 文件后缀;上游为总纲(`gotry-master-outline.md`)与产品设计(`gotry-product-design.md`)。
> 下游:loopx todos 依本文§9 演进阶段与§10 债务清单派生;引擎/求解器细节工作只在债务清单标注时进行。

---

## 1. 系统是什么

**GoTry 是「从出发到下一次出发」的 AI 旅行 Agent**:动机访谈进、已验证的行程方案与选择题出;LLM 负责理解与解释,确定性组件负责判定与算术,写操作永远有闸。

**当前形态(诚实定位,2026-08-22 `v0.0.1-rc.7`)**:dsh 成品可用(`./gotry` 或 `npx @danceiny/gotry@rc web`,DeepSeek 原生)——人格(行为契约 18 条,锚点卡/记忆 brief 注入 persona,运行时组合唯一来源=仓根 cordis.gotry-patch.yml——2026-08-28 发现 ts/ 副本分叉致产品面跑旧人格,当日归一退役副本)+ 十七工具(可行性/骨架/酒店/天气/航班/Anything/网页/视频字幕/GitHub搜索/AgentReach wrapper/动机/愿望池/愿望召回/旅行时间线/同行人/**飞猪官方检索/会话检索**——2026-08-28 会话数据面 P3 切片1:gotry_flyai_search 实时机/火只读主链路 + gotry_session_search 用户登录态交叉验证,ReadGuard 物理只读,smoke §12);机票三层(骨架 168 对+校验桥+锚点)+ 酒店 hbcli 桥(实时/静态降级+证据标注)+ Anything 通用搜索(gotry anything.ts;实时链 2026-08-25 终局撤回——hotel-be @path 免鉴权面按 founder 判定无附加值,两 PR 关闭,静态包兜底;酒店域实时改走已注解的 hotel-list 面);OpenSky 实时 ADS-B + Open-Meteo 天气免费接入;**agent-reach wrapper 化**(上游 v1.5.0 装于 .venv;反射桥 agent-reach-bridge.py 直调上游注册表,零渠道知识,needs-setup 透传上游 check() 原话;真 LLM 会话复验 e2e-prompts §7/§8);**License MIT**;**npm 公开分发已通且 latest 直指 rc.8**(`@danceiny/gotry@0.0.1-rc.8` 2026-08-28 发布:web 授权登录+恢复码 OTP;干净安装 headless 实测跑通;`rc` tag 暂留 rc.7);工具 execute 统一 guardToolExecute 异常隔离(D-NEW gotry 侧收尾)+ 平铺观察 envelope(ADR-13);py 树仅剩 gotry_feasibility oracle(D-7 清偿);run-all-tests 全栈回归全绿(套件清单见 `scripts/run-all-tests.sh` 分节,计数不落字)。M3 最小可用产品,分发链路无已知堵点。**时间感知硬化(2026-08-27,时间评测驱动)**:确定性时间锚点层 `ts/src/time-anchor.ts`(今天/明天后天大后天/本周下周下下周/下个月分段/季度/节日锚点,纯函数;注入 persona `{{time_anchor_card}}` 与 legacy 抽取全链路——此前 FACTS/SKELETON 无时间注入,过期语义无从谈起);`ts/src/travel-slots.ts` 差旅槽位抽取(travel_slot_extraction.v1:时间表达逐字保留,过期判定与 language 检测归代码层);`ts/src/slot-spec.ts` 槽位→日期解析层(锚点卡词表换算+spec 一致性闸,D-10 三切片清偿);评测基建 `data/time-slot-eval.json`(25 题)+ `ts/scripts/time-eval-tests.ts`(确定性部分进 CI;真模型巡检基线 11/25 → 25/25,P0 8/8);顺带清偿 dsh-llm 环境变量模块顶冻结致 .env 不生效的存量隐患(改调用时惰性读取)。**M4 记忆效用 sidecar(2026-08-27,RFC S2/S3)**:`ts/src/memory-utility.ts`(recalled/applied/verified_outcome 三类事件 + 归因只认 owner 确认,模型不许自评「有用」)+ wish 稳定 wish_id/muted + `gotry_wish_pool_list`(0..1 条件召回,muted 不召回,北极星「下一次出发率」的度量底座)。**记忆读回(T1 写读闭环,2026-08-28)**:画像此前只写不读,新会话模型盲访——`{{motivation_brief}}` persona 变量把 motivation-profile 渲染成紧凑 brief 注入(空=首访,契约 (1) 据此分支;回访不重复问已答字段,冲突以用户当轮为准)——M4 exit「回访规划时长降 ≥50%」的机制前提。**记忆域 P3 时间窗衰减落地(2026-08-28)**:`memory-decay.ts` 分级窗口原语(只降不删/地板 0.1/动机零衰减构造性保证)+ memory-metrics 新鲜置信度列——行为记忆按 30/90/180/365d 分级新鲜度参与投影。**记忆域 P2 同行人档案落地(2026-08-28)**:`companions.ts` + `gotry_companion_save`(15 工具)+ brief 同行人行——P1/P2 连续落地(memory-design §4)。**记忆域 P1 时间线落地(2026-08-28)**:`travel-timeline.ts` + `gotry_trip_log`(第 14 工具)+ confirm-outcome 自动挂时间线 + brief「去过」行——M4 分期 P1 完成(memory-design §4)。**记忆域正式设计(2026-08-28)**:`memory-design.md` 落地 M4 交付「六层框架重设计」——六层(M1 用户基础/M2 动机偏好/M3 预算/M4 时间线/M5 同行人/M6 双区会话)现状映射 + 分期增量(P1 旅行时间线→P2 同行人档案→P3 时间窗衰减→P4 双区会话后置)+ 铁律(溯源 P0/排序不硬过滤/负面清单/多用户前向兼容)。**北极星过程面度量(2026-08-28)**:`scripts/memory-metrics.ts` 只读投影(wish 在册/休眠、效用事件计数、经验回流率基线 verified/recalled,run-all-tests §20)——M4 exit「经验回流率有基线」的工具前提。**主动回访骨架(2026-08-28)**:`scripts/nudge-digest.ts`(0..1 条件匹配经 `wish-pool.ts` 纯函数,三通道 stdout/file/lark——lark 等 GOTRY_LARK_WEBHOOK 配置即插即用,投递失败降级 stdout 不阻塞;`GOTRY_NUDGE_ENABLED=false` 全局关闭,契约「可关闭」,run-all §21)。**真模型巡检轮(2026-08-28,ADR-11 巡检层)**:persona 扩三处(motivation_brief/0..1/归因禁令)+13 工具后全量巡检——time-eval --real 25/25(P0 8/8)保持;replay-real 抓出 D-10 闸多段误伤并当日收窄修复(见 D-10),修复后真模型多段行程全链求解恢复;同轮暴露 probePoi 三类误触发(短句直通把访谈答案整句当关键词/订酒店抓「我订了」/多段首查抓「机票和」),当日收紧——关键词方向性(动词宾语后置、住宿名词后段优先、短裸地名 ≤12 字加陈述动词闸),probe-poi §7 金标准噪音回归,订酒店改抓真实名称段(The Title…)。**会话数据面 P1(2026-08-28,RFC `user-session-data-rfc.md` G7 立项)**:官方通道 `capabilities/flyai.ts`(飞猪 FlyAI 无 key 只读,机/火车票;spawn CLI 管道,agent-reach 同构)+ 会话面 `capabilities/session-search.ts` + `session/{transport,read-guard,adapters/ctrip-flight}`(playwright-core 专用 profile;ReadGuard 方法×URL 双因子写拦截+审计+fail-closed;携程 batchSearch 嗅探;节律闸 ≥30s;证据链 `[会话:ctrip-flight@ts]`;live 需 headful);run-all §24,session-tests 25 断言。工具面接线在 P3。**事务化状态基座(2026-08-28,ADR-15,RFC `transactional-state-rfc.md` accepted)**:「文件即权威」升级为「单文件 SQLite 账本即权威」(`ts/src/state-ledger.ts`,better-sqlite3/WAL):events append-only 唯一权威(语义幂等键 UNIQUE 物理化,wish_id 改语义派生)+ 投影表可 fold 重建(mergeProfile/appendTrip/upsertCompanion 守门纯函数原样复用为写路径与 fold 处理器,语义层零改造)+ 红线(evidence/conditions)进事务、拒绝即回滚 + confirm-outcome 单事务(效用+行程同生,跨文件分叉物理不可能)+ 异步工单 durable 恢复(workflow_steps intent-before-execute,崩溃后 done 步骤零重执行,exactly-once)+ pending_writes saga(WriteGate L2/L3 基座:幂等键/receipt/补偿,what-if VACUUM INTO 分叉);五状态工具写路径与 brief/nudge/metrics 读路径全部接线,`gotry_session_search` 审计落盘生产路径,ASYNC_DIR 接 stateRoot;旧 JSON/JSONL 降级为单向导出视图(`state-cli export`,红线 6),首写自动 one-shot 迁移+快照(`pre-ledger-backup/`);run-all §28(39 断言)/§29(CLI e2e 14 断言)。

## 2. 总体架构:五层与现状

```
L1 交互:对话即界面(gates 以消息内选择题呈现;独立 UI 属 Stage 1 后)
L2 编排:对话循环 ts/src/loop.ts —— LlmPort(mock✅/真✅ provider-neutral) + 确定性访谈 + 求解挂载
    └ dsh 插件 gotry-tools:✅ 已在真实 dsh 0.1.1-rc.1 headless 运行时端到端(68ea364)——模型经 pi-ai(MiniMax-M2)主动调用 gotry_feasibility_check 并引用引擎数字;组合见 cordis.gotry-patch.yml(bin/gotry-inner.js 运行时生成;ts/ 下旧副本已退役 2026-08-28)
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
| `ts/capabilities/session-search.ts` + `session/` | **会话检索面**(RFC P1):transport(playwright-core 专用 profile)/ReadGuard(写请求物理拦截+审计,fail-closed)/携程机票适配器(batchSearch 嗅探)/action-cache 自愈层(变量化key+指纹被动失效+miss回写);节律闸;`[会话:*]` 证据链 | ✅ run-all §24/§25 |
| `ts/src/state-ledger.ts` | **事务化状态账本**(ADR-15):SQLite 单文件唯一权威(events append-only+语义幂等键/投影表 fold 可重建/workflow_steps durable 工单/pending_writes saga);守门纯函数复用为写路径与 fold 处理器;读路径带旧文件回退;首写自动 one-shot 迁移+快照 | ✅ run-all §28 |
| `ts/scripts/state-cli.ts` | **账本操作面**(ADR-15):migrate/export(视图单向)/log/stats/rebuild/rewind/forget(物理硬删带审计)/tick(回收 pending 工单)/whatif(VACUUM INTO 分叉)/pw-*(WriteGate saga CLI 面) | ✅ run-all §29 |
| `ts/scripts/time-eval-tests.ts` `data/time-slot-eval.json` | 时间感评测(25 题):确定性部分进 CI,`--real` 真模型巡检(只读报告) | ✅ 真模型 25/25 |
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

- 运行时:三条已实证路径——①TS 进程内(自研循环,~6ms/解);②真实 dsh headless+cordis 组合(pi-ai→MiniMax,`cordis.gotry-patch.yml`,68ea364);**(v0.0.1-rc.2 起第三条** Python CLI 桥下线,纯 TS)。环境三件套 `LLM_API_KEY/LLM_BASE_URL/LLM_MODEL`(兼容旧 DEEPSEEK_*)。
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
| 12 | 时间感分层:锚点卡(time-anchor 纯函数,算术进代码)+ 槽位逐字保留(LLM 不换算不翻译)+ 过期/language 判定归代码层;时间评测集进仓(data/time-slot-eval.json,只增不改语义),质量层首块落地 | 全 LLM 感知(锚点缺失实测:legacy 路径无今天注入,过期无从判)/代码全量解析中文相对日期(表达开放,维护黑洞) | **2026-08-27 复审(D-10 切片 A 触发):设计成立**;补充边界——解析层只认锚点卡词表+绝对表达+「+N」后缀,词表外 unresolved 逐字保留,不开式解析(锚点:`slot-spec.ts`;time-eval §5) | `time-anchor.ts`;`travel-slots.ts`;`slot-spec.ts`;`time-eval-tests.ts` |
| 13 | 工具观察 envelope(RFC S1,effect-interpreter 映射):12 工具成功路径平铺 `ok:true` + 载荷,失败 `{ok:false,summary,evidence}`(guard 兜底同形,`ToolFailure` 编译期对齐);参数三形态归一唯一入口 `interpretArgs`(原 unwrapQuery 移居 `tool-packet.ts`) | 逐工具自由返回(形状漂移,每个新工具重新猜)/嵌套 envelope `{ok,value}`(渲染/调用方全要拆包,侵入大) | 出现第二个真实调用方(非 dsh 非 smoke)需要不同观察形状时复审 | `tool-packet.ts`;`incident-log.ts guardToolExecute`;smoke §9 |
| 14 | 记忆效用 sidecar(RFC S2/S3,post-outcome-memory 映射):recalled/applied/verified_outcome 三类事件 append-only(`gotry-state/memory-utility.jsonl`),归因只认 owner 确认(attribution 只能在 confirm-outcome 由用户明说落盘,模型不许自评「有用」);wish 稳定 `wish_id` + muted(休眠不删除);召回 0..1/轮(`gotry_wish_pool_list` 条件评分,muted 永不召回,无命中不硬推)——M4 北极星「下一次出发率」的度量底座 | 召回即记「有用」(自称用了≠让结果变好)/wish 删除制(憧憬不被拒绝) | 多用户 AaaS 账本化(RFC §6.5)或出现第二个效用消费方时复审 | `memory-utility.ts`;`index.ts gotry_wish_pool_list`;smoke §10 |
| 15 | 事务化状态基座(RFC `transactional-state-rfc`,业界 durable-execution 五件套收敛):单文件 SQLite 账本(better-sqlite3,WAL)= 唯一权威——events append-only(语义幂等键 UNIQUE 物理化,wish_id 语义派生)+ 投影表 fold 可重建(纯函数守门原样复用,语义层零改造)+ 红线进事务(evidence/conditions 拒绝即回滚)+ durable 工单(workflow_steps intent-before-execute,崩溃恢复 exactly-once)+ pending_writes saga(WriteGate L2/L3 基座:幂等键/receipt/补偿)+ what-if 分叉(VACUUM INTO);旧 JSON/JSONL 降级单向导出视图(红线 6);one-shot 迁移(首写自动+快照 `pre-ledger-backup/`) | Postgres/DBOS/Temporal/Restate 平台(单用户本地产品不需要服务端;SQLite durable 学派「一文件即控制面」)/纯文件加固 tmp+rename(修不了跨文件分叉与并发)/node:sqlite(零依赖但较新,D1 落选备选) | 多用户 AaaS 化(RFC §6.5 claim/CAS 实装)或需要多写者/多端复制(cr-sqlite/Litestream,触发式=D-15)时复审 | `state-ledger.ts`;run-all §28/§29 |

## 9. 演进(时间线唯一来源= `roadmap.md` 的 M0-M6;此处只保留原则与现状)

原则:**不跳阶段,不提前优化下阶段的事**;每阶段 Entry/Exit/gate 见 roadmap。旧 Stage 0-4 与总纲 Phase、产品 M1-M3 已归并映射到 M0-M6(映射表在 roadmap)。

- **M0 ✅ / M1 ✅(bb880f3)/ M2 ✅(b0cfd97)**:M2 交付 = §7-1 三层组合(骨架+校验+锚点)+ hbcli 桥 + dsh 端到端(DeepSeek 原生,人格+五工具)+ 一键入口 `./gotry`;G1/S1/§7-1 三 gate 由创始人指令结算。
- **当前 = M3(工程面完成,分发就位 `v0.0.1-rc.7`)**:三场景全验(洱海/云南/普吉);完全去 Python(仅剩 gotry_feasibility oracle 对照,D-7 清偿);**D-4 DONE**(Anything 三仓闭环 244a0ae/c38ff65d1/43236a0);agent-reach wrapper 化 + 真 LLM e2e 复验;**npm 公开分发打通**(rc.5→rc.7:隔离发布命令/dist 预编译/.env 首跑修复;干净安装实测 web 200);12 工具 execute 异常隔离;16 套 ALL GREEN。**当前 = M4 记忆域(2026-08-26 founder 指令开闸)**:T1 双层落地——①提取=LLM 的活:契约 (18) 要求模型当轮经 motivation_save 并入新事实(evidence=用户原话),不做第二套正则引擎(founder 校正「正则 rules 不对」后确立分工);②合并守门=代码的活:`memory-capture.ts` mergeProfile(追加不删史/幂等/权重变更须伴证据 P0/空守卫,§18 三断言)。后续:runTurn 接线、主动回访(可关闭)、北极星度量。此后 M5 交易 → M6 B2B。
- **时间感优化(2026-08-27,外部时间评测驱动)**:时间锚点层(算术进代码,LLM 查卡不自算)+ 槽位抽取 v1(逐字保留)+ 25 题评测集与评分脚本落地,ADR-11 质量层首块兑现(原定 M3,迟到的落地);真模型(deepseek-chat)25/25。slot→spec 求解桥接未做(D-10)。
- **tsc 存量清零 + loopx RFC 专项(2026-08-27)**:`npx tsc --noEmit` 14 错清零(D-11 清偿,1bf9671);同日完成 loopx 13 篇架构 RFC 通读与映射,产出 `loopx-inspired-upgrades-rfc.md`——**founder 当日指令 accepted(「按建议执行」)**,四切片 S1-S4 按序落地;同指令确立**多用户 Agent as a Service** 为未来方向(shared-goal-authority 类 claim/CAS 机制转入远期采纳面,RFC §6.5)。**S1 已落地**:`tool-packet.ts` 观察 envelope(平铺 ok:true/ok:false summary,guard 兜底同形编译期对齐)+ unwrapQuery 升格 interpretArgs;S2 记忆效用 sidecar → S3 wish 触达纪律 → S4 WriteGate 词汇依次推进(D-12)。
- **事务化状态基座落地(2026-08-28,ADR-15)**:业界调研(loopx/DBOS/Temporal/Restate/LangGraph/Letta/Claude Code transcript 学派/SQLite durable 学派/TigerFS/SagaLLM/Cockroach 七失效模式)收敛五件套(append-only 账本/投影/约束即红线/步骤日志/saga 补偿)→ `transactional-state-rfc.md` 立例、founder 当日 accepted(「按你的建议来」,D1-D5 全按建议结算)。TS-0..TS-4 一次落地:`state-ledger.ts` 账本 + 五状态工具写路径接线 + brief/nudge/metrics 读路径回退兼容 + `state-cli` 操作面 + durable 工单崩溃恢复 exactly-once(§28 子进程 exit 9 实证)+ pending_writes saga;run-all §28(39 断言)/§29(14 断言),全栈 §1-§29 ALL GREEN。TS-5 触发式后置=D-15。

## 10. 债务清单(引擎细节工作只能来自这里)

| # | 债务 | 状态/赎回时机 |
|---|---|---|
| D-1 双引擎算术复制 | **已清偿**(统一模型落地,洱海对账等价) |
| D-2 TS unsatCore 竖线 | **已清偿**(coreOf 剥竖线+回归断言) |
| D-3 LLM 未进环 | **已清偿**(S4 由 MiniMax-M2 完成,`bb880f3`;mock 留作回归夹具,ADR-8 兑现) |
| D-5 时区语义 | **已清偿**(EK329 官网逐分一致) |
| D-4 gate/卡片无承载界面 | **词表内赎回 2026-08-22**:feasibility + 酒店/天气/Anything/AgentReach 五工具 presentResult 结果卡(可行性:候选判定+预算行;酒店:N 家(实时/静态);天气:ok/降级;Anything:N hits;AgentReach:✅/🔧/📦/❌ verdict)+ 12 工具 kind 图标分类(search/fetch/execute/edit,零 other);**地图位已解 2026-08-22**:宿主插件 dsh-map-tools v0.4.4(7 个 map_* 原生工具:驾/公/步/骑路线+地理编码+POI,零 key 走 OSRM,高德可后配)——装于 vendored runtime,npm 分发经根包依赖 + inner 运行时 require 解析;patch 条目占位、缺依赖整块剔除不挡启动;root ./gotry 统一改走 inner(修复旧 profile patch 暗中承重) |
| D-4a'(agent-reach 100% follow) | **已完成 2026-08-23;2026-08-22 wrapper 化**: Agent-Reach v1.5.0 装于 .venv(与 z3-solver 同址);gotry 侧为薄壳 —— agent-reach-bridge.py 反射桥(get_channel+getattr 直调上游注册表)+ agent-reach.ts 管道层,零渠道知识,上游加渠道零改动;gotry_agent_reach(action=reach 反射 / status 真 doctor);needs-setup 透传上游 check() 原话 |
| D-4\'(Anything 数据接入) | **已完成 2026-08-23**: gotry capabilities/anything.ts 11 套实测 5/5 + hbcli `search anything` 子命令 + hotel-be `/api/search/anything` `@path` 注解;三仓 commit 闭环(244a0ae/c38ff65d1/43236a0) |
| D-6 红眼睡眠模型未校准 | **已校准 2026-08-28**:红眼航段落地后接驳(机场→住处/办公室)乘车补眠回血(1h≈+5%,上限 80)——对账真值:引擎原算 75%(机上睡眠),你真实体感 80%(75+1.5h 路上补眠);落地补眠此前未算,现加 `groundRecoveryMin` 参数;EK329 精力 75→79(45min 接驳×5%/h≈+4),unified 断言同步 |
| D-7 deprecated 层仍承重 | **大部赎回**:dsh 插件进程内路径切轨 solveChoiceSegment(枚举,~0ms)、cli.py 桥切轨 solve_choice_segment、diff-test 切轨统一模型对统一模型;engine/journey 退纯 oracle(保留为金标准对照)。**尾债清偿 2026-08-22**:删 build_plan.py + gotry_async/demo.py + run-golden-case.sh(已断:调 rc.3 删除的 cli.py);py 树仅剩 gotry_feasibility oracle 对照 + 其 unittest |
| D-8 对话循环不进 CI | **已清偿**(replay 带终态断言 + 异步工单跨进程闭环 + smoke 进 `run-all-tests.sh` §5-7) |
| [D-NEW] dsh 进程保活缺失 | **部分赎回(gotry 侧)**: plugins/apply 内 installProcessGuards 挂 uncaughtException + unhandledRejection;incident-log.ts 同步 fsync append-only,handler 不调 process.exit——被崩溃穿透时仍能留下证据(JSONL incidents.jsonl),不阻塞 dsh 控制流。incident-tests 2/2 绿(handler 装上后未捕获异常仍记录,后续控制流不卡)。**gotry 侧收尾 2026-08-22**: 12 工具 execute 统一经 guardToolExecute 异常隔离——抛错/拒绝降级结构化错误返回 LLM + tool_execute_error 落盘,不再穿透 cordis 到 dsh 主循环(incident 套 3/3);残余仅 vendored dsh 自身容错,记 M3 |
| D-9 节日锚点表硬编码 | **2026-08-28 扩表清偿**:SPRING_FESTIVAL 覆盖 2026-2031(2029-02-13/2030-02-03/2031-01-23),time-eval §1b 回归闸(2030 锚点断言 2031 春节)。**跨 2031 前必须再扩表**,否则春节锚点静默缺失 |
| D-10 slot→spec 求解桥接未做 | **已清偿 2026-08-27(三切片)**:A `slot-spec.ts` 解析层(锚点卡词表/绝对/+N → 绝对日期,词表外 unresolved;time-eval §5);B 工具面接线(`gotry_hotel_search` 日期槽位收逐字表达,unresolved 降级无日期搜索+date_notes,smoke §8);C spec 链路一致性闸(runTurn 求解前比对,分歧不求解、追问确认,replay 尾段)。**ADR-12 复审结论:设计成立**,解析范围必须有界(只解析锚点卡词表,不做开放式中文相对日期解析——被拒备选即维护黑洞)。**闸范围边界(2026-08-28 真模型巡检修正)**:槽位 v1 只有 trip 级主日期,闸仅校验恰好一个带日期段的 spec;多段行程逐段日期无槽位真值,不判(金标准六段行程曾被全段误判分歧拦死求解,巡检抓出后收窄,多段旁路回归进 replay 尾段) |
| D-11 `npx tsc --noEmit` 存量 14 错 | **已清偿**(1bf9671,语义零变更:tsc 0 错;smoke/memory §18 全过;17 套 ALL GREEN) |
| D-12 loopx RFC 映射升级四接缝 | **已全部落地(RFC accepted 2026-08-27)**:S1 tool-packet envelope(ADR-13);S2+S3 记忆效用 sidecar + wish 触达 0..1(ADR-14);S4 WriteGate L0-L4 渐进授权词汇进 roadmap M5 交付物(2026-08-28);多用户 AaaS 方向见 RFC §6.5 远期采纳面 |
| D-13 会话适配器维护面(RFC user-session-data-rfc) | 站点接口改版即断(当前携程 batchSearch);P2 action-cache 自愈 + 金标准监控赎回;断时降级 `[实时API:flyai]` 主链路 |
| D-14 playwright-core 分发面(RFC) | P1 仅 devDep(产品运行时零依赖);P3 工具接线时需转 optional peer + 启动检测缺则降级提示(dsh-map-tools 模式) |
| D-15 账本触发式后置面(ADR-15 TS-5) | Litestream 云备份 / cr-sqlite 多写者复制 / RFC(loopx) §6.5 claim-fence-receipt 多用户实装——仅在触发器出现时启动:第二真实用户 / 多机部署 / AaaS 立项 |

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
| `dsh-plugins-shortlist.md` | dsh 社区插件选型(awesome-dsh-plugin 全量调研,issue #9) |
| `deerflow-research.md` | DeerFlow 研究 → gotry 优化目标 T1-T4(issue #10) |
| `hotelbyte-skills-design.md` | hotelbyte-skills 架构(知识进仓/执行留 gotry,issue #5) |
| `e2e-prompts.md` | dsh 端到端真 LLM 验证记录(§1-§11,wrapper/澄清卡/背景调查等) |
| `memory-design.md` | **记忆域设计**:C 端六层重设计(M1-M6 现状映射/P1-P4 分期增量/铁律与验收),M4 交付「六层框架重设计」的正式文档 |
| `loopx-inspired-upgrades-rfc.md` | **RFC(accepted 2026-08-27)**:loopx 13 篇架构 RFC 的映射升级——四道接缝(S1 工具 packet 纪律/S2 记忆效用 sidecar/S3 wish 触达 0..1 纪律/S4 WriteGate L0-L4 词汇) |
| `transactional-state-rfc.md` | **RFC(accepted 2026-08-28,ADR-15)**:事务化状态基座——业界 durable-execution 调研收敛五件套 + GoTry 落地架构 + TS-0..TS-5 执行计划与决策记录(D1-D5) |
