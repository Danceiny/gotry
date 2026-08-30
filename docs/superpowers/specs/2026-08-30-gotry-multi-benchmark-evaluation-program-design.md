# GoTry 多 Benchmark 评测与 Agent 优化计划

状态：设计确认，等待实现计划

日期：2026-08-30

讨论入口：[GitHub Discussion #78](https://github.com/Danceiny/gotry/discussions/78)

## 1. 决策

GoTry 采用“先建立基线，再按失败簇优化”的多 benchmark 计划。ChinaTravel 是第一个诊断切片，不是唯一目标。

公开 benchmark 保留各自的官方指标，不折算成一个总分。GoTry 统一的是运行协议、证据边界、失败分类和交付方式：同一批 case、模型参数、工具快照与 scorer 下的 baseline/treatment matched pair，才支持“这次改动带来提升”的判断。

每个优化轮次只处理一个 GoTry Agent 缺陷簇，并对应：

1. 一个独立的 `Danceiny/gotry` PR；
2. 一组 GoTry 自有的确定性回归；
3. 一次匹配的外部 benchmark 复测与必要的跨 benchmark guardrail；
4. Discussion #78 中一条唯一对应的评论。

## 2. 目标与非目标

### 目标

- 覆盖旅行规划、工具策略、函数调用、多轮偏好、长期记忆和能力边界。
- 用公开 benchmark 发现可复现的 Agent 缺陷，而不是凭单次对话调 prompt。
- 把外部失败提炼成 GoTry 自有回归，防止第三方数据、服务或排行榜变化后失去守门能力。
- 同时记录质量、硬违规、成本、时延、工具调用数、轮数与稳定性。
- 每累计 3–5 个优化 PR，形成一次跨 benchmark 综合判断。

### 非目标

- 不为某一道题、某个排行榜或某个 evaluator 写硬编码规则。
- 不把本地公开集分数称为官方 held-out 成绩。
- 不把不同 benchmark 的百分比分数直接相加或平均。
- 不把外部数据、hidden gold、oracle 字段、原始 trajectory 或私有用户材料提交进 GoTry。
- 不在 GoTry 产品运行时或工具链增加 Python 依赖，也不建立 TS↔Python 桥。
- 不用外部 benchmark 代替 GoTry 的真实用户结果指标。

## 3. 能力矩阵

| 能力簇 | 外部锚点 | 主要诊断面 | 数据与评分边界 |
|---|---|---|---|
| 行程可行性与约束推理 | [TREK](https://github.com/TonyQJH/TREK-A-Travel-Reasoning-and-Evaluation-Kit-for-LLM-Agents-in-Complex-Trip-Planning) | typed infeasible、预算、时空约束、隐式需求、工具效率 | 代码 MIT、数据 CC BY 4.0；synthetic KB；确定性 scorer |
| 多约束旅行规划 | [TravelPlanner](https://github.com/OSU-NLP-Group/TravelPlanner) | hard/common-sense constraints、规划完整性、工具参数、幻觉 | 代码 MIT、数据 CC BY 4.0；本地 validation 与官方 test 分开记录 |
| 中文开放式旅行规划 | [ChinaTravel](https://chinatravel-competition.github.io/IJCAI2026/) | 环境 grounding、位置链、时序、成本、偏好与组合约束 | 数据为非商业/相同方式共享许可；`hard_logic*`、DSL 和 verifier-only 字段不得进入 solver；公开/familiar 运行只算 diagnostic |
| 多轮偏好与能力边界 | [TravelBench](https://github.com/small-xiangcheng/TravelBench) | preference elicitation、工具错误、呈现质量、unsolvable | 代码 MIT、数据 CC BY-NC 4.0；单/多轮依赖固定 LLM judge，unsolvable 更确定 |
| 工具策略与政策稳定性 | [τ²-bench](https://github.com/sierra-research/tau2-bench) | policy adherence、状态结果、`pass^k`、多轮工具使用 | MIT；外部 Python 运行环境隔离；只映射与 GoTry 产品语义有关的 domain slice |
| 长期记忆 | [LoCoMo](https://snap-research.github.io/locomo/) | 多 session 召回、时间/因果推理、multi-hop memory | CC BY-NC 4.0；先使用文本 QA，未稳定发布的多模态路径不进入首轮 |
| 函数调用 | [BFCL](https://gorilla.cs.berkeley.edu/leaderboard.html) | simple/multiple/parallel/multi-turn、relevance abstention、执行正确性 | Apache 2.0；固定官方 evaluator 版本；需外部搜索凭证的类别不进入默认基线 |

GoTry 自有 benchmark 仍是主指标，覆盖确定性求解、事实闸、时间槽、session、记忆、WriteGate、完整旅行规划 E2E 和真实用户结果。外部 benchmark 负责提供坐标与反例。

## 4. 架构与数据流

```mermaid
flowchart LR
  A[外部 benchmark 隔离环境] --> B[GoTry Agent 调用协议]
  B --> C[官方 evaluator]
  C --> D[公开安全的 run receipt]
  D --> E[LoopX experiment board]
  E --> F[失败分类与缺陷簇]
  F --> G[单一 GoTry 优化 PR]
  G --> H[自有回归 + matched 复测]
  H --> I[Discussion #78 对应评论]
```

### 4.1 GoTry 仓内拥有的部分

实现阶段新增四类 provider-neutral 合同：

- `gotry_benchmark_registry_entry_v0`：官方入口、revision、许可、任务类别、指标、数据边界、可计分条件。
- `gotry_eval_case_v0`：case 标识、输入类别、隔离状态、时钟/时区、允许与禁止效应、预算和 scorer 版本；不含第三方原始题面或 gold。
- `gotry_eval_run_receipt_v0`：GoTry SHA、模型、prompt/tool/scorer revision、原生指标、通用 guardrail、countability 和证据摘要。
- `gotry_eval_failure_cluster_v0`：失败类别、严重度、受影响 benchmark/case、复现条件、GoTry 自有 regression id 和建议优化面。

仓内只保存合同、校验器、许可安全的 registry 元数据、脱敏 receipt 和 GoTry 自有案例。它们进入 TypeScript 测试面，并由 `scripts/run-all-tests.sh` 守门。

### 4.2 外部执行环境拥有的部分

第三方仓库、Python 环境、数据集、官方 evaluator、原始输出、trajectory、judge 细节和 oracle/gold 放在隔离且忽略的 owner-local 工作区。外部 runner 通过 JSON/JSONL 边界调用 GoTry，不进入 GoTry 产品依赖图。

外部执行环境只能向仓内或 LoopX board 交付公开安全 receipt。receipt 不记录本机绝对路径、凭证、原始题面、原始答案、hidden evaluation 或 verifier 源码。

### 4.3 LoopX 实验账与 PR 计划

LoopX experiment board 保存每个稳定 `run_id` 的 baseline、treatment、countability、effort 和 insight。多 PR 计划只创建一个 grouped continuous monitor：

```text
task_class=continuous_monitor
action_kind=pr_program_reconcile
target_key=pr-program-gotry-evaluation-rounds
```

monitor 只在 PR 生命周期、SHA、检查、review、requirement coverage 或依赖关系发生实质变化时更新；安静轮询不算交付进展。

## 5. Benchmark 接入与基线顺序

### Phase 0：公共合同

先提交一个 GoTry foundation PR，内容限于 registry、schema、校验器、公开安全夹具与运行文档。该 PR 不宣称 Agent 质量提升。

每个 benchmark 接入都必须通过五个检查：

1. 钉住上游 revision、许可与数据入口；
2. 证明 solver 看不到 hidden gold、oracle 或 evaluator-only 字段；
3. 用官方 gold/known-good 输出验证 scorer ceiling；
4. 用 known-bad 输出证明 scorer 能失败；
5. 先登记 running row，再写 terminal receipt。

### Phase 1：快速且确定的 canary

1. 收口当前 ChinaTravel 冻结 5-query canary；它保持 diagnostic-only。
2. 接入 TREK canary，覆盖 feasible 与 typed-infeasible。
3. 接入 BFCL canary，先覆盖不需要外部搜索凭证的函数调用类别。

这三条先检验 schema、工具调用和确定性 scorer，避免把格式/桥接问题带进昂贵评测。

### Phase 2：完整能力面 canary

依次接入 TravelPlanner validation、TravelBench 三个 subtask、τ²-bench 的相关 domain slice、LoCoMo 文本 QA。每条 canary 至少覆盖官方任务类别；不足以支持质量结论时，只标记 adapter/runner 可用。

### Phase 3：冻结 baseline

在修改 Agent 前冻结七条 baseline：优先使用完整公开 validation；若公开集过大或成本超过单次预算，使用预注册的 100-case 分层切片。baseline 必须记录抽样规则和 category coverage，后续 treatment 不得换题、换 scorer 或换工具快照。

### Phase 4：按缺陷簇优化

全部 baseline 进入终态后再选择优化轮次。唯一例外是 P0 硬违规：事实来源错误、越权写入、hidden-gold 泄漏、隐私泄漏或已证实的不可执行计划，可以立即开修复 PR，但仍需保留原 baseline 与独立 guardrail。

## 6. 指标与可计分边界

每个 benchmark 保留原生 primary metric。GoTry 统一增加这些 guardrail：

- hard violation count；
- schema/output validity；
- forbidden/oracle leakage hits；
- latency p50/p95 与单 case 上限；
- cost、tool calls、turns；
- `pass^k` 或重复运行方差；
- evidence/provenance completeness。

不生成跨 benchmark 总分。综合判断使用能力矩阵：改善、持平、退化、证据不足。

一条比较只有同时满足以下条件，才能支持提升声明：

- baseline 与 treatment 都终态；
- case 集、模型参数、prompt protocol、工具快照和 scorer 一致，唯一变量是待评改动；
- source fence 与 integrity qualification 通过；
- 官方结果或预先定义的本地官方-evaluator结果存在；
- comparison 在 LoopX 中为 `matched_pair_countable=true`。

ChinaTravel public/familiar、非固定 LLM judge、未校准 human label 和任何本地猜测性 scorer 默认 `diagnostic_only`。LLM judge 评测必须固定 judge model、temperature、prompt、代码 revision，并重复至少 3 次；没有人工校准时不得充当硬发布闸。

质量提高但成本、p95 时延或工具调用数恶化超过 20% 时，PR 不得写成无条件提升；必须声明取舍并给出后续优化项。官方绝对预算优先于 20% 相对阈值，例如 ChinaTravel 仍受每 case 300 秒和 100 queries/5 小时约束。

## 7. 失败分类与选题

统一失败类别：

- `schema_or_format`
- `grounding_or_provenance`
- `constraint_or_feasibility`
- `time_or_location_continuity`
- `cost_or_cardinality`
- `tool_selection_or_arguments`
- `policy_or_write_safety`
- `preference_elicitation`
- `memory_retrieval_or_temporal_reasoning`
- `reliability_cost_or_latency`

选题优先级依次看：硬违规、跨 benchmark 复现、GoTry 产品相关性、影响 case 数、修复是否能进入确定性回归。单一 benchmark 的分数波动不能单独决定优先级。

## 8. 单轮优化与 PR 契约

每轮 PR 必须同时具备：

1. 一个具名失败簇和可证伪的修复假设；
2. 一个聚焦 GoTry 自身的 Agent、工具策略、确定性层或评测层改动；
3. 至少一个先失败后通过的 GoTry 自有 regression；
4. 相同协议下的 baseline/treatment 复测；
5. 至少一个相关的独立 benchmark 或 GoTry held-out guardrail；
6. treatment SHA 上的适用本地测试与干净 task worktree；
7. 不包含第三方原始数据、oracle、私有证据或绝对本机路径。
8. 若提交改变 GoTry 当前形态、状态或债务，同一提交同步 `architecture.md` §1/§9/§10、`roadmap.md` 当前位置、`README.md` 当前形态和 `stage1-top-down-design.md` 状态头六个状态面。

PR 标题和正文描述 GoTry 缺陷，不用外部 benchmark 名称冒充产品能力。benchmark 名称只放在证据段。

PR 推送、URL 与 SHA 读回后，在 Discussion #78 新增一条对应评论。评论包含：失败簇、GoTry 改动、PR URL、treatment SHA、测试、同协议前后指标、成本/时延取舍和 countability 边界。同一轮只创建一条评论；后续状态变化编辑原评论，不追加第二条。

adapter/foundation PR 与 Agent 优化 PR 分开。前者只证明评测链可运行，不宣称质量改善。

## 9. 公私与许可边界

- TREK、TravelPlanner、τ²-bench、BFCL 可提交许可安全的适配合同，但仍不复制不必要的上游数据。
- ChinaTravel、TravelBench、LoCoMo 的非商业数据不进入 GoTry git 历史、PR artifact 或 Discussion 原文。
- ChinaTravel 的 `hard_logic_py`、`hard_logic_nl`、DSL、官方 feedback、held-out answer 和 verifier-only 字段只允许 scorer/post-run analyst 读取。
- TravelBench 的 judge 输出与 judge prompt 不进入 solver trajectory；LoCoMo 的原始长对话不转存到 GoTry。
- 任何公开证据先经过 artifact classification，只发布 hash、计数、reason code、聚合指标和脱敏摘要。

## 10. 失败处理与停止条件

- source revision 漂移、许可不清、scorer ceiling 不成立或 known-bad 不失败时，停止该 benchmark 的新 run admission。
- runner 中断必须把同一 `run_id` 写成明确终态；不得遗留“看起来仍在运行”的行。
- 外部服务、凭证或官方 held-out 不可用时，记录 `TODO(blocked)`，不补造分数。
- treatment 在目标 slice 提升但独立 guardrail 退化时，不能进入“通用优化”结论；修复或改标为 benchmark-specific。
- 连续两个优化轮次没有新增失败面、改善或可证伪假设时，停止该簇并重新做跨 benchmark 归因。

## 11. 节奏与综合输出

- 每个 PR：Layer 1 全栈回归 + 受影响的 Layer 2 matched slice。
- Nightly：低成本 canary、固定预算、真实评分，不只记录输出 hash。
- Weekly：冻结 baseline 的分层复跑、失败聚类、成本/时延趋势与人工抽检。
- 每 3–5 个优化 PR：发布一次跨 benchmark 综合建议，区分通用能力、旅行领域特化、性能代价、证据不足和下一轮优先级。
- Milestone/release：公开 benchmark 子集、GoTry 自有 held-out 与真实产品 outcome 分层报告，不互相替代。

## 12. 实现验收

计划进入持续运行前，必须看到这些证据：

1. 七个 benchmark 都有 revision、许可、任务、指标、隐藏字段和 countability 定义；
2. registry/case/run/failure 四类合同有确定性校验与 known-good/known-bad 测试；
3. 外部 runner 与 GoTry 产品依赖图隔离，`package.json` 无新增 Python 或 benchmark runtime 依赖；
4. 七条 baseline 都进入终态，未满足计分条件的行明确为 diagnostic-only；
5. 每个优化失败簇都有 GoTry 自有 regression id；
6. 一个 grouped PR monitor 覆盖全部优化轮次，没有 per-PR monitor；
7. PR 与 Discussion #78 的一一对应关系可读回；
8. 没有 matched pair 时，文档和评论不出现提升声明。

实现拆成三个层次：先交付公共合同与 registry foundation PR；再逐 benchmark 建 baseline；最后按失败簇提交独立 Agent 优化 PR。任何一层的 adapter 可用，都不自动证明后一层的质量改善。

本设计是 program-level 边界，不对应一个大而全的实现 PR。下一份实现计划只覆盖 Phase 0 foundation；每个 benchmark 接入和每个 Agent 优化轮次分别形成后续计划与独立 PR。
