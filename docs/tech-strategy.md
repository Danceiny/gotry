# GoTry 技术选型与半年迭代路线(M2–M4)

> 定位:**选型理由、评测体系、分工与持续优化回路的唯一来源**。时间线权威仍归 `roadmap.md`(M0-M6 的 Entry/Exit),本文只管「用什么、谁来做、怎么持续变好」。
> 约束:复用遵循总纲 §2 三策略——import=许可证明确的 OSS;bridge=进程外运行时桥;reference=仅借鉴设计;**不存在中间态**。创始人两条刚性约束优先:harness 以 dsh 为参考基线、不自研 agent 运行时;参考过的开源项目一律不重写。
> 纪律:**新增 import 先经 §7 决策登记,创始人批准后回填总纲 §2 复用矩阵,再动工。**

---

## 1. 评审结论摘要(2026-08-22,M1 exit 后)

架构设计健康:代码与文档高度一致,分层纪律在测试里有真实执行锚点。真正的系统性风险是**文档保鲜曾无机制**(已由 `architecture.md` §11 补上);主要工程缺口是 deprecated 层仍承重(D-7)与对话循环曾不进 CI(D-8)。

**强项(保持)**:算术/求解分层 + 双实现差分,正确性核心的验证强度远超同阶段项目;契约先行、mock 先行、重放即行为级回归(各 agent harness 的核心实践,已内生);ADR 预登记淘汰条件 + 锚点列;红线在代码里执行(evidence 缺失即 throw);ADR-10 证明「失败→当天立 ADR→校验闸落代码」的学习闭环工作。

**缺口(全部挂账)**:① 状态分裂→§11 保鲜机制(已落地);② deprecated 层仍承重→D-7(M2 W2 赎回);③ 对话循环不进 CI→D-8(批 0 赎回);④ 契约分裂(contracts.ts 五工具草案 vs 插件三工具;`TripState.wishes`/`Gate.answer` 无读写)→M2 W1;⑤ 工程卫生(zod 死依赖/SPEC_SYSTEM 死代码/命名残留/无 pyproject/z3 版本不齐/wish-pool 无去重)→批 0;⑥ 异步调度无仓内实现→M3 W5;⑦ WriteGate 零代码(M5 有意留白,设计稿前置 M3 W4);⑧ 可观测缺失(M3 三指标无度量基建)→M2 W5 埋 schema、M3 W2 上系统。

## 2. 能力缺口 → 选型矩阵

| 能力缺口 | 里程碑 | 策略 | 候选(许可证) | 理由 | 决策门 |
|---|---|---|---|---|---|
| LLM 抽象 | M2 | 维持 + 评估迁移 | `@deepseek-ai/dsh-llm`(dsh 系) | 现适配器已 provider-neutral;dsh 基线规则:不自研 dsh 已给的。功能对齐(think 剥离/json_object)则迁 | §7-6 |
| 机票数据源 | M2 Entry | bridge + 数据包 | 见 §2.1 | 无商业合作期免费/开源优先 | §7-1(创始人) |
| 酒店数据 | M2 | import + extend | hotelbyte-cli(MIT,已决 T3) | 缺口以同风格扩展回馈上游 | 已决(G4) |
| MCP 桥 | M2–M3 | bridge→import SDK | `@modelcontextprotocol/sdk`(MIT) | G5 关闭后桥 travel_agent;此前守 CLI/JSON 桥 ≤2(ADR-3) | G5(外部) |
| 测试框架 | 全程 | **不 import** | 保持 node:assert + unittest | 零框架纪律够用;重放即行为回归已覆盖 promptfoo/deepeval 的核心价值,避免依赖膨胀。M3 面板不够再复议 | §7(默认维持) |
| LLM 可观测 | M2 埋点/M3 系统 | 自研 schema + import 评估 | JSONL trace(自研);Langfuse(MIT,引入前核证) | 先延伸 bridge-latency 模式落 trace;面板需求(幻觉率/定稿率)真实出现再上系统 | §7-5 |
| 最小 Web 面 | M3 | import 候选 | assistant-ui(MIT)+ Vercel AI SDK(引入前核证) | gates 选择题/透明卡片需要承载界面(D-4 赎回);UX 参考 Claude Code 权限询问(闭源 reference) | §7-3 |
| 记忆层 | M4 | **自研核心优先** | mem0(Apache-2.0)备选 | travel_agent 六层仅 reference(内部资产红线);两条铁律(画像只进排序不进硬过滤、断言可溯源)实现量小;向量库推迟到证据出现 | §7-4 |
| WriteGate | M3 设计/M5 实现 | **自研** | reference:Claude Code permission modes(闭源)+ travel_agent write-gate(内部,仅设计) | T6 要素:幂等键、pending state、未证明只读默认按写 | §7(设计稿 M3 W4) |
| Agent 运行时 | 全程 | import(已决) | dsh 跟 main | 创始人约束,不自研、不重写 | 已决(G2) |

### 2.1 数据源即能力:免费/开源优先路线

数据源是 L4 能力层的一部分,不是外部依赖的注脚。无商业合作期(现在 → M5 之前)的组合:

1. **免费额度官方 API**:Amadeus Self-Service 测试层(免费月度额度,sandbox 数据)、aviationstack 免费层等——班期/票价的真实样本,量小但真;
2. **公开数据集**:OpenFlights(机场/航线静态)、OpenSky Network(实时 ADS-B 位置,免费社区 API)、GTFS(海外地面交通)——静态骨架与校验源;
3. **用户已订资源自带**:`bookedResources` 模式——用户把已出票的行程单交给系统,围绕真实锚点规划。这在产品上是「半自助行程」场景,在数据上是零成本的真实锚点源;
4. **人工提炼静态包**(现状沿用):demo 期数据包模式,证据标注分级保持诚实。

证据链标注在数据短缺期是护城河:`[实时API]`/`[公开数据集]`/`[估算]` 三级标注让数据质量对用户透明——这正是 GoTry 透明机制的差异化。**商业供应链后置 M5**:有交易量才有谈判筹码,且 WriteGate 上线前本来不需要订座级数据。国内铁路(12306)无官方开放 API,灰色库不入,走静态包+人工提炼。

## 3. 半年迭代路线与分工(2026-09 → 2027-02)

Owner 标签:【创始人】=拍板/走查/商业;【agent】=工程执行(loopx 派单,可多 agent 并行,守具名暂存纪律);【外部】=审批/合作依赖。假设:创始人+agent 协作,不跳阶段、不提前优化下阶段的事。

### 批 0(2026-08 本周)
- 【agent】已完成:M1 exit 状态同步(`3ed6194`)、ADR 保鲜机制(`0bfacff`)、本文。
- 【agent】进行中:hygiene 批(删 zod 死依赖与 SPEC_SYSTEM 死代码、`createDeepSeekLlm` 改 provider-neutral 名、wish-pool 去重、pyproject.toml + 锁 z3 与 TS 同版);replay+smoke 进 `run-all-tests.sh`(**D-8 清偿**)。
- 【agent,并行会话已启动】M2 W0:dsh 真实运行时组合(`ts/cordis.gotry-patch.yml` + `ts/dsh-runtime/`,`538018f`/`5acedb3`),当前 blocker = MiniMax 流协议。

### M2 实时数据(9–10 月,约 8 周)
- **W0 dsh 真实运行时接通**【agent】:gotry-tools 在真实 dsh 里端到端跑通;MiniMax 流协议适配落 `dsh-llm.ts`。
- **W1 契约转正**【创始人走查 + agent 接线】:S1 三走查点(Gate 只允许选择题/workWindow 必带 evidence/assumptions 三分类);五工具注册表与插件三工具名对齐;`TripState.wishes`/`Gate.answer` 接线或删除(不留无读写的类型)。
- **W2 D-7 迁移**【agent】:TS unified 补候选形态求解(对齐 `unified.py solve_choice_segment`,差分护航)→ dsh 插件与 `cli.py` 切到 unified → engine/journey 退纯 oracle。**D-7 清偿日 = ADR-5 兑现日**。
- **W3 酒店桥**【agent】:hotelbyte-cli import+extend(T3),缺口同风格扩展回馈上游。
- **W4 航班桥**【agent,前置 §7-1】:按 §2.1 组合落地航班能力插件;**ADR-6 兑现**——静态包退役为测试夹具。
- **W5 观测埋点**【agent】:LLM trace JSONL(schema:prompt 摘要/响应/延迟/token/校验闸结果);dsh-llm 迁移评估(§7-6)。
- **Exit 勾稽**:同一 JourneySpec 实时 vs 静态的求解差异可度量、可归因 + §11 保鲜清单过一遍。

### M3 最小可用产品(11–1 月,约 10 周)
- **硬前置**:G1 市场锁定【创始人】——总纲 B1 决策包素材已齐。
- **W1 最小 Web 面**【agent,前置 §7-3】:透明卡片+动机访谈+gates 选择题的可体验形态,**D-4 清偿**。
- **W2 指标面板**【agent,前置 §7-5】:幻觉率/定稿率/NPS 度量上线(评测质量层,§4);种子数据回流进评测集。
- **W3 种子用户**【创始人+agent】:50–200 人邀请制,洱海+普吉两类场景。
- **W4 WriteGate 设计稿**【agent 起草,创始人评审】:幂等键/pending state/未证明只读默认按写;产出 ADR 候选。
- **W5 S5 后半**【agent】:loopx tick 真驱动异步调度,AGENTS.md 人肉清扫规则退役。
- **Exit 勾稽**:定稿率 ≥40%、NPS ≥40、POI 幻觉 <1%(评测三件套全绿)。

### M4 记忆与「下一次出发」 entry(2 月)
- 记忆选型决策(§7-4)【创始人】;北极星(下一次出发率)度量上线【agent】;对账七题=红眼模型与偏好的首批校准样本,**D-6 赎回**【agent】。
- **半年底状态**:M4 进行中;M5(WriteGate 生产化/交易闭环)设计就绪。

## 4. 评测体系(ADR-11 落地)

评测是 agent 产品的一等架构件,不是事后工具。三层各司其职:

| 层 | 防什么 | 形态 | 现状 |
|---|---|---|---|
| 回归层 | 退化(改坏了) | 单元(20/20)+ 差分(TS↔Python)+ 重放夹具(mock) | ✅ `run-all-tests.sh`;replay 批 0 进 CI |
| 质量层 | 漂移(不知不觉变烂) | 评测集 + 指标面板:POI 幻觉率、定稿率、不失望四条、NPS | M3 W2 上线;此前 replay 终态断言兜底 |
| 巡检层 | 「mock 绿而真智能烂」 | nightly 真 LLM 重放(`replay-real.ts`),带预算闸与结果归档 | 批 0 挂 loopx todo;ADR-10 的教训制度化 |

纪律:评测集只增不改语义(改语义=新用例);每个 M-exit 必须过对应层级,指标不进架构文档等于不存在。评测数据回流路径:种子用户会话(脱敏)→ 评测集候选 → 对账后入册。

## 5. harness 实践吸收矩阵(reference 面,代码引入一律走 §7)

| 来源 | 实践 | GoTry 落点 | 策略 |
|---|---|---|---|
| Claude Code(闭源) | permission modes | WriteGate 设计稿(M3 W4):未证明只读默认按写、确认 UX | reference |
| Claude Code(闭源) | hooks(事件点挂执行) | loopx tick 接线、S5 后半异步调度 | reference |
| Claude Code(闭源) | context compaction | M3+ 长会话(多段行程反复改)的上下文压缩 | reference |
| Claude Code(闭源) | CLAUDE.md 契约 | 已有 AGENTS.md,持续加厚(保鲜/暂存纪律即两例) | reference |
| OpenHands(MIT) | 评测 harness/trajectory 回放 | §4 巡检层与评测集组织的参考 | reference(需代码时再评估 import) |
| Aider / OpenCode | 工具面组织、编辑协议 | dsh 插件工具面演进参考 | reference |
| LangGraph(MIT) | 图式状态机 | **仅 reference,不 import**——与 ADR-9 确定性循环、dsh 基线冲突 | reference |
| mem0 / Letta(Apache-2.0) | 记忆分层与写入门禁 | M4 记忆域设计参考;mem0 为 import 备选 | reference / import 备选 |
| Langfuse(MIT) | LLM trace/评测面板 | M3 W2 指标面板候选 | import 候选(§7-5) |
| travel_agent(内部) | write-gate/六层 memory/tool-owned dates | **仅设计参考,代码与 schema 均不搬用**(内部资产红线) | reference |

## 6. 持续优化回路(怎么持续变好)

```
真实使用(种子用户/对账/巡检报警)
  → 对账(demo-reconciliation 模式,三类去向:数据误差改数据 / 模型缺项记 ADR / 产品缺项进 loopx todo)
  → 落地(ADR 进 §8 表带锚点;债务进 §10 表带赎回时机;产品项进 loopx)
  → 验证(回归层全绿 + 巡检层 nightly + 质量层面板)
  → M-exit 保鲜清单勾稽,进入下一里程碑
```

节奏:**nightly**=真 LLM 重放(预算闸);**每周**=对账会(种子期后);**每个 M-exit**=ADR 全表复审 + 债务表勾稽 + 状态面同步(§11)。loopx todos 只从 `architecture.md` §9/§10 与本文派生——优化事项不许只活在对话里。

## 7. 决策登记(待创始人拍板)

| # | 决策项 | 建议时点 | 判据 | 建议 | 状态 |
|---|---|---|---|---|---|
| 1 | 机票数据源组合 | M2 Entry(即现在) | 班期/票价覆盖、免费额度、许可、证据标注成本 | Amadeus 测试层 + OpenFlights 静态 + bookedResources 自带;灰色库不入 | 待拍板 |
| 2 | G1 市场锁定 | M3 Entry 前 | 总纲 B1 决策包(素材已齐) | 中国出境优先(证据链与供应链半径最短) | 待拍板 |
| 3 | Web 面框架 | M3 entry | gate/卡片渲染匹配度、许可证核证、bundle 重量 | assistant-ui(MIT)+ AI SDK;不满足则自研最小面 | 待拍板 |
| 4 | 记忆方案 | M4 entry | 两条铁律的实现成本、向量库是否真需要、运维面 | 自研核心(MotivationProfile 契约延伸),mem0 备选 | 待拍板 |
| 5 | Langfuse 可观测 | M3 entry | JSONL trace 是否已够用、自托管成本 | 先 JSONL;面板需求确认后 import(核证许可证) | 待拍板 |
| 6 | dsh-llm 迁移 | M2 中 | 与现适配器功能差(think 剥离/json_object)、dsh 基线规则 | 功能对齐则迁——不自研 dsh 已给的 | 待评估 |
| 7 | 总纲 §2 拟增行 | 随上述批准回填 | 许可证明确、策略唯一(import/bridge/reference) | 拟增:`@modelcontextprotocol/sdk`(G5 关闭后,MIT)、assistant-ui(MIT,核证)、Langfuse(MIT,核证)、mem0(Apache-2.0,备选) | 随批 |
