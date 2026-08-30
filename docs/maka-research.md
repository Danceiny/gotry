# Apache Maka(Incubating)研究 → GoTry ADR-15 事务化状态基座对照

> 状态:**研究底稿,结论供 founder 拍板**(2026-08-28)
> 对象:[apache/maka](https://github.com/apache/maka)(Apache 孵化器 podling,本地优先 AI agent 工作台)。本文只回答四件事:maka 是什么、它的 durable-execution 机制是什么、与 GoTry ADR-15 五件套逐项对照、哪些可采纳/不采纳/是否触发复审。
> 上游权威:`architecture.md` §8 ADR-15、`transactional-state-rfc.md`;复用矩阵(`gotry-master-outline.md` §2)是采纳清单的硬约束。
> 信源纪律:一手优先(孵化器状态页/邮件列表存 apache.org,架构与 schema 引仓内文件路径);二手(Reddit 等)仅作线索并标注未证实。

## §1 是什么

| 项 | 事实 | 出处 |
|---|---|---|
| 准确定名 | **Apache Maka (Incubating)**;无官方中文名(中文 README 保留「Maka」不译,并声明「以英文原文为准」) | [podling 状态页](https://incubator.apache.org/projects/maka.html)、[README.zh-CN.md](https://github.com/apache/maka/blob/main/README.zh-CN.md) |
| 一句话定位 | "a local-first AI agent runtime and workspace"——本地优先的 AI agent 运行时与工作台;模型消息、工具调用、工具结果、权限决策、终止事件全部记为 append-only log | [repo description](https://github.com/apache/maka) |
| 产品形态 | Electron 桌面(macOS ARM 早期公开版 / Windows 未签名预览 / Linux 桌面未支持)+ TUI/CLI(`maka-agent` npm 包)+ 声明式 Eval;三形态全部经由同一个 Runtime Host 进程执行 | [README](https://github.com/apache/maka)、[CLI README](https://github.com/apache/maka/blob/main/packages/cli/README.md) |
| 捐赠方 | 无单一公司捐赠:代码原在 `github.com/maka-agent/maka-agent`(2026-05-27 建,Apache-2.0),入孵化时移交 apache org(旧地址现 301 重定向至 apache/maka);提案定位为「vendor-neutral 社区捐赠」,创始人 J… **详见下方「捐赠方」** | [maka-proposal-zh-review.txt](https://github.com/apache/maka/blob/main/maka-proposal-zh-review.txt)(draft v0.11,正式版以英文原文为准)、[api.github.com 重定向实测](https://api.github.com/repos/maka-agent/maka-agent) |
| 孵化时间线 | [DISCUSS] 2026-08-05 起 → [VOTE] 2026-08-09(champion tison 发起)→ [RESULT] 2026-08-13 接受入孵化;GitHub 仓库创建于 2026-05-27 | [marc.info 存档](https://marc.info/?l=incubator-general&s=maka&w=2&r=1&q=b)、[podling 状态页](https://incubator.apache.org/projects/maka.html) |
| Champion / Mentors | champion:tison(Zili Chen);mentors:xuanwo(Hao Ding)/ benjobs(Huajie Wang)/ psiace(Zhuoran Shang)/ tanxinyu(Xinyu Tan) | [podling 状态页](https://incubator.apache.org/projects/maka.html) |
| 当前阶段 | 早期 podling:孵化器 setup 清单大半未勾(SGA 回执/ASF 版权头/全体 committer CLA 与 LDAP 等标 pending);无毕业/退役标志;提案自估孵化「约两年,取决于形成可持续多元 committer base」 | [podling 状态页](https://incubator.apache.org/projects/maka.html)、[proposal review](https://github.com/apache/maka/blob/main/maka-proposal-zh-review.txt) |
| 溯源疑云 | Reddit r/PiCodingAgent 有帖子猜测 maka「部分基于 Pi coding agent」;仓内 NOTICE 仅 ASF 标准段落,零第三方归属;全码搜索 badlogic / pi-mono / "pi coding agent" 均 0 命中——**该猜测无代码级证据,记为未证实的社区传闻** | [Reddit 帖](https://www.reddit.com/r/PiCodingAgent/comments/1vuxacp/looks_like_apache_maka_agent_is_partially_based/)、[NOTICE](https://github.com/apache/maka/blob/main/NOTICE)、GitHub code search 实测 |

结论:不是「查无此项目」的正相反——maka 真实存在、2026-08-13 刚入孵化,且定位与 GoTry 高度同门:**本地优先、单机、TS、append-only 账本即权威**。它就是「agent 执行事务化」方向的 Apache 面标本。

## §2 架构深挖(重点)

### 2.1 分层与核心概念

```
Desktop / TUI / CLI / Bot → Runtime Host(唯一执行权威)
  → SessionManager → RuntimeKernel → AgentRun(durable 执行信封)
  → AgentBackend(AiSdkBackend:模型/工具循环)+ ToolRuntime
  → Runtime Event Log(canonical)
  → Context / Session / UI / Recovery 投影
Eval(Experiment → Cells → Attempts → Results)→ Runtime Host
```

出处:[ARCHITECTURE.md](https://github.com/apache/maka/blob/main/ARCHITECTURE.md)、[runtime-core-architecture-draft.md](https://github.com/apache/maka/blob/main/docs/architecture/runtime-core-architecture-draft.md)(2026-08-23 验证的生产路径)。

- **单一执行权威**:"Maka has one execution authority: Runtime Host"——所有客户端不拥有第二个 Runtime(ARCHITECTURE.md)。
- **核心等式**(与 GoTry「投影 = fold(events)」同构,原文):`State(t) = Project(RuntimeEvents[0..t], policy, runtime configuration)`;"Log is the source of truth; state is a materialized view"。模型历史、UI 读模型、终态判定、恢复、上下文压缩全是同一日志的投影([core draft §结论先行](https://github.com/apache/maka/blob/main/docs/architecture/runtime-core-architecture-draft.md))。
- **三个生命周期身份**:Session(长交互)/ Turn(用户可见回合)/ Run(具体执行尝试,AgentRun 是 durable envelope);外加 invocationId 作事件关联兼容字段。
- **思想来源(它自己的说法)**:Google ADK(Session=事实容器,Event 带 actions/stateDelta)+ 分布式系统 log-first 传统(WAL/event sourcing/Kafka);显式声明「不是进程内 Kafka,不做共识日志」([core draft §Two lines of intellectual influence](https://github.com/apache/maka/blob/main/docs/architecture/runtime-core-architecture-draft.md))。
- **包结构**:`packages/core`(纯契约:Session/RuntimeEvent/AgentRun/permission/protocol)、`packages/storage`(交互运行时 store + SQLite 控制面)、`packages/runtime`(SessionManager/AgentRun/适配器/恢复)、`packages/runtime-host`(宿主生命周期/协议)、`packages/eval`、`packages/cli`、`apps/desktop`(ARCHITECTURE.md Code boundaries 表)。

### 2.2 agent 执行与状态的建模

- **RuntimeEvent 不是「role+text」**:
  - 七维正交分解——
  - Identity(sessionId/invocationId/runId/turnId/branch)、Ordering、Source(role×author 双轴:权限决策 fact 的 role=system 而 author=user)、Content、**Actions**(state delta/permission/artifact/usage/end)、Correlation(工具调用-结果稳定配对)、Lifecycle(partial/status)
    - ([core draft §What one RuntimeEvent preserves](https://github.com/apache/maka/blob/main/docs/architecture/runtime-core-architecture-draft.md)、[packages/core/src/runtime-event.ts](https://github.com/apache/maka/blob/main/packages/core/src/runtime-event.ts))。
- **权限 = 运行时控制流,不是对话框**:越界工具返回 `sandbox_boundary_required` + 具体 expansion;模型调 `request_sandbox_boundary` 发起边界扩权请求;执行停在有身份的位置等待;Session 投影 `waiting_for_user` 但 Run 身份不丢("parked")。请求与决策都是 typed fact(只带 actions.stateDelta,不带 content)(core draft §Permission is runtime control flow)。
- **平台沙箱**:macOS Seatbelt / Linux bubblewrap+seccomp / Windows AppContainer broker;全部 fail-closed,不支持静默降级到宿主执行([packages/runtime/src/sandbox/README.md](https://github.com/apache/maka/blob/main/packages/runtime/src/sandbox/README.md))。
- **任务账本(task ledger)**:
  - session 级任务模型,`task_create/task_update/task_list/task_get` 四工具;六状态机(pending/in_progress/blocked/completed/failed/cancelled)+ 受控转移;**evidence 强制进契约**——blocked 必带 blockedReason、failed 必带 failureReason、completed 必带 completionEvidence;恢复分类器 `resumeTrust`(trusted/needs_revalidation/stale/repaired/untrusted);
  - 子 agent 只能 claim 不能偷任务,"A successful child does not complete the task. The parent agent must verify the result and supply completionEvidence"。显式非目标:"no workflow engine"([docs/session-task-ledger-lifecycle.md](https://github.com/apache/maka/blob/main/docs/session-task-ledger-lifecycle.md))。

### 2.3 持久化 / 事务 / durable-execution 机制

**存储选型**:
- SQLite(`runtime.sqlite` 为 live record),但用 **`node:sqlite`(Node 内置 DatabaseSync)而非 better-sqlite3**;
- PRAGMA:WAL + `synchronous = FULL` + `foreign_keys = ON` + `busy_timeout = 5000`([packages/storage/src/sqlite-runtime-schema.ts](https://github.com/apache/maka/blob/main/packages/storage/src/sqlite-runtime-schema.ts) `configureSqliteRuntimeDatabase`)。
- schema 按域分片、各自版本化:runtime v12 / core-execution v5 / workflow v9 / session-metadata / usage / artifact / long-term-memory(各 `sqlite-*-schema.ts`,[packages/storage/src](https://github.com/apache/maka/tree/main/packages/storage/src))。

**事件溯源(物理层证据,[sqlite-runtime-schema.ts](https://github.com/apache/maka/blob/main/packages/storage/src/sqlite-runtime-schema.ts) MIGRATIONS)**:

| 表 | 职责 | 关键约束 |
|---|---|---|
| `runtime_events` | 语义账本(唯一权威) | `event_seq > 0 CHECK`,`UNIQUE(invocation_id, event_seq)`——「ordered log」的存储层含义 |
| `tool_journal_events` | 工具操作 journal(状态流) | `journal_event_id UNIQUE`,`canonical_args_hash`,`recovery_mode`,`external_handle`,FK → runtime_events |
| `tool_operations` | 工具操作当前态 | `UNIQUE(invocation_id, provider_tool_call_id)` = 工具调用级幂等键;`version > 0` |
| `runtime_continuation_claims` | 崩溃后续跑的领取凭证 | `source_event_high_water > 0`、`source_prefix_digest`、`boundary_digest UNIQUE`、四元组 UNIQUE + target 三 UNIQUE——**用数据库唯一约束做 claim 幂等** |
| `runtime_capabilities` | 迁移能力门控(capability/version 行) | recovery/continuation/workspace_version authority 各自登记 |
| `runtime_workspace_epochs/versions/heads` | git 工作区版本化(epoch→version→head,commit/tree oid,绑 accepted_event) | origin_kind CHECK = 'baseline' 等 |
| `runtime_session_event_ordinals` | session 级稠密序号 | WITHOUT ROWID + ON DELETE CASCADE |

workflow 域([sqlite-workflow-schema.ts](https://github.com/apache/maka/blob/main/packages/storage/src/sqlite-workflow-schema.ts))是标准的 **events+projection 成对**:`workflow_task_ledger_events`/`workflow_task_ledger_projections`、`workflow_plan_events`/`workflow_plan_projections`(`store_version UNIQUE` 乐观并发)、`workflow_scheduled_tasks` + `workflow_scheduled_task_fires`(`task_id UNIQUE`——
- **定时任务只能 fire 一次,fire claim 幂等**)、`workflow_work_board_items`(revision ≥1 CAS + scope CHECK)。
- core 执行域([sqlite-core-execution-schema.ts](https://github.com/apache/maka/blob/main/packages/storage/src/sqlite-core-execution-schema.ts))另有 `core_root_turn_admissions`/`core_root_turn_start_rejections`/`core_root_source_message_proofs`(回合准入/拒绝/消息证明 = 回合级 intent-before-execute)与 `core_interaction_requests`/`core_interaction_outcomes`(权限请求→裁决落库,FK 强制成对)。

**intent-before-execute(三处,全部「先落库再执行」)**:
- ① `AgentRun.begin()` 在派发 Backend 前先持久化 initial user RuntimeEvent;
- ② Run Composer:构建不可变 Run Composition(system prompt/工具目录/策略及修订)→ commit 到 AgentRun store → **commit 成功后才调 provider**("Provider dispatch waits for a durable Run Composition commit",[runtime-host-architecture.md](https://github.com/apache/maka/blob/main/docs/architecture/runtime-host-architecture.md) 规则 8);
- ③ 工具层 T1/T2:Phase 2 "T1 guaranteed before tool execution and T2 before returning the result"([runtime-resume-architecture.md](https://github.com/apache/maka/blob/main/docs/architecture/runtime-resume-architecture.md) 相位表)。

**崩溃恢复(Phase 0-4,分级事实能力)**([runtime-resume-architecture.md](https://github.com/apache/maka/blob/main/docs/architecture/runtime-resume-architecture.md)):

| 相位 | 回答的问题 | 状态 |
|---|---|---|
| 0 | 只有已提交 RuntimeEvents 时,这个前缀可安全重放吗 | Implemented |
| 1 | 在完整安全边界处,可以创建新 Run 吗 | Implemented,feature-flagged(默认关,`MAKA_RUNTIME_SAFE_BOUNDARY_RESUME=1`) |
| 2 | T1(执行前)/T2(返回前)能否保证 | SQLite canonical 模式已实现 |
| 3A | 恢复事实的唯一 authority + 原子 bundle | Implemented |
| 3 | 工具特定证据能否裁决未知副作用 | Designed,生产 reconciler 未接线 |
| 4 | Runtime 边界能否绑定工作区快照(restore/rebaseline) | Designed 未实现 |

五条设计规则:resume 创建**新执行**(不复活旧栈);RuntimeEvent 是唯一恢复事实源;**缺失结果 ≠ 失败也不证明没执行过**;安全不可证即 park(模型自报不能提升证据等级);工作区身份只证「同一工作区」不证「内容未变」。恢复顺序 = repair(旧 Run 终态收敛)→ resolve/reconcile(工具状态)→ resume(新身份续跑);continuation 消费 one-shot start proof、不重复用户事件、以 `continuationSource` 记血统。

**终态不变量(log-first invariant)**:"A terminal Run must have exactly one valid terminal RuntimeEvent, and a terminal Run header must be supported by that terminal fact." 首个 terminal 事实生效后静默排水;无 terminal 事件的流收敛为 `missing_terminal_event` 结构化失败;头与事实矛盾时保守修复(core draft §The log-first invariant)。启动恢复"does not re-execute model requests or tool side effects"——只做状态修复,不做 checkpoint resume。

**诚实边界(它自己声明的「不承诺」清单)**:不恢复指令指针;**不承诺任意 Bash/远端 API/子进程 exactly-once**;不自动结算 T1-without-T2 的真实副作用;进程崩溃 + SQLite 事务原子性 ≠ 断电耐久性证明;不做 bit-exact 线级重放;Runtime Host "does not promise that an arbitrary external side effect happens exactly once...must not retry automatically unless the operation explicitly permits it"(host 架构 + resume 文档「Current limitations and explicit non-goals」)。

### 2.4 并发模型

三层单写者,无分布式组件:

1. **进程内**:`SerializedOperationLane`(promise 链串行通道,"Admits an operation into its owner before waiting for earlier operations",[packages/storage/src/serialized-operation-lane.ts](https://github.com/apache/maka/blob/main/packages/storage/src/serialized-operation-lane.ts));
2. **跨进程**:Host Kernel 持 State Root **独占 writer lease**("One State Root has at most one writer owner");回合级 admission 原子预留("One Session has at most one root Hosted Execution or pending root admission"),另有文件锁(root-lock/artifact-writer-lock 等测试夹具佐证);
3. **SQLite 层**:busy_timeout + 迁移在 `BEGIN IMMEDIATE` 下双读 `user_version` 防并发 opener 重复迁移。

CAS 变体:work_board `revision`、plan `store_version`、goal `authority_revision`(均为 UNIQUE/CHECK 物化的乐观版本)。客户端断连不取消已准入执行;流/通知永不作为恢复权威,"recovery always rereads durable facts"。

### 2.5 记忆与评测(与 GoTry 记忆面/巡检面相关)

- durable 长期记忆子系统:`packages/storage/src/sqlite-long-term-memory-{schema,store}.ts` + `memory-extraction(+-proposal).ts`(记忆抽取进 SQLite,带 crash 测试 `sqlite-long-term-memory-crash.test.ts`);
- Eval 内核:Experiment = benchmark+executor+subjects+tasks+repetitions;Cell = task×repetition×subject;attempt log **append-only**,"result selection always uses the earliest valid attempt"——操作者不能挑结果;
  - "A/B is simply a two-arm Experiment"([packages/eval/README.md](https://github.com/apache/maka/blob/main/packages/eval/README.md)、[ARCHITECTURE.md](https://github.com/apache/maka/blob/main/ARCHITECTURE.md))。

## §3 开发者面

**关键抽象**:SessionManager.sendMessage()(门面)/ RuntimeKernel.startTurn()(控制面)/ AgentRun(执行信封)/ RuntimeEvent(七维事实)/ TaskLedgerStore(任务账本端口)/ Run Composition(模型可见基线冻结)。

**真实样例**(出处:[packages/cli/README.md](https://github.com/apache/maka/blob/main/packages/cli/README.md)):

```sh
npm install --global maka-agent@next
cd path/to/project && maka
maka run "Summarize this project and identify its highest-risk area"
maka run --graph "Implement two independent slices, integrate them, then review the result"
maka eval run experiment.json --out .maka-eval/run-001
```

模型侧工具面即 task ledger 四件套;宿主侧工作区目标是一个闭联合类型(出处:[runtime-host-architecture.md](https://github.com/apache/maka/blob/main/docs/architecture/runtime-host-architecture.md)):

```ts
type WorkspaceTarget =
  | { kind: "project"; projectId: string }
  | { kind: "host_path"; path: string };
```

本地数据形态:`<profile>/workspaces/default/` 下 `runtime.sqlite` + `connection-catalog.json` + `credential-vault.json`(明文本地文件,靠 OS 账户边界保护)+ `settings.json` + `artifacts/`([README](https://github.com/apache/maka));旧 JSONL transcript 不迁移。注意:**Maka 没有 embeddable 库式 API**——对外面是 CLI/TUI/桌面/Runtime Host 协议,「账本」不作为公共库暴露;`maka-agent` npm 包只是 CLI 发行壳。

## §4 生态与对比(它自己的说法)

- **没有与 Temporal/DBOS/LangGraph/Restate 的对比**:全仓 code search「DBOS」「LangGraph」0 命中;「Temporal」10 处命中全部是 long-term-memory 的时间维度(temporal)词,与工作流引擎无关(GitHub code search 实测,2026-08-28)。
- 它的自我定位参照系是 **Google ADK**(Session=事实容器、事件带 actions)与 **WAL/event sourcing/Kafka 的 log-first 传统**(core draft §Two lines of intellectual influence + Further reading 链接 ADK 博文与 Kafka design 文档)。
- 与「workflow engine」划清界限:task ledger 显式非目标 "no workflow engine; no cron or automation scheduling; no replacement for AgentRun/RuntimeEvent..."([session-task-ledger-lifecycle.md](https://github.com/apache/maka/blob/main/docs/session-task-ledger-lifecycle.md))。它不做 Temporal 式编排平台,做「单机日志即运行时」。
- README 文档树里有六篇中英双语深度文章与 DeepWiki 镜像,官方未发对比稿。

## §5 成熟度

| 维度 | 事实 | 出处 |
|---|---|---|
| 活跃度 | 3,817 stars / 359 forks / 3,971 commits / ~96 contributors / 323 open issues;最近 push 2026-08-28(当日仍活跃);提案快照 2026-08-03 时 1,104 stars——入孵化公告后约 3.5x | [api.github.com](https://api.github.com/repos/apache/maka) 实测、[proposal review](https://github.com/apache/maka/blob/main/maka-proposal-zh-review.txt) |
| 版本 | 14 个 GitHub release(最新 v0.1.11,2026-08-18);npm `maka-agent` dist-tags:next=0.1.0-beta.1、latest=0.0.0-alpha.0;**尚无 ASF 审批 release**(README:「Apache Maka 目前还没有发布过 Apache release」,`.github/ASF_SOURCE_RELEASE.md` 管控源发布) | [releases](https://github.com/apache/maka/releases)、[npm](https://www.npmjs.com/package/maka-agent)、[README.zh-CN](https://github.com/apache/maka/blob/main/README.zh-CN.md) |
| License | Apache-2.0 + ASF 商标与孵化免责 | [repo](https://github.com/apache/maka) |
| 已知限制 | 平台:桌面仅 macOS ARM 早期公开版(Windows 未签名预览,Linux 桌面未支持);续跑默认关闭;Phase 3 reconciler / Phase 4 工作区快照未实现;凭据明文保险库;无断电耐久性证明;孵化 setup(SGA/版权头/CLA)未完成 | [README](https://github.com/apache/maka)、[resume 架构](https://github.com/apache/maka/blob/main/docs/architecture/runtime-resume-architecture.md)、[podling 状态页](https://incubator.apache.org/projects/maka.html) |
| 路线图 | resume PR B(不可变 event-seq 高水位+前缀摘要+DB 唯一 claim)、PR C/D(生产文件证据 reconciler + host-owner 生命周期)、Windows 沙箱(issue #2142)、Phase 4 git 工作区连续性 | [resume 架构尾节](https://github.com/apache/maka/blob/main/docs/architecture/runtime-resume-architecture.md)、[sandbox README](https://github.com/apache/maka/blob/main/packages/runtime/src/sandbox/README.md) |
| 治理风险(提案自认) | 社区同质化(中文协作圈)、领薪开发者依赖;缓解=英文邮件列表决策、跨圈招募;名字风险(先期用过 "Maka",PODLINGNAMESEARCH 待完成) | [proposal review](https://github.com/apache/maka/blob/main/maka-proposal-zh-review.txt) |

## §6 与 GoTry ADR-15 对照(五件套逐项)

ADR-15 五件套定义见 `transactional-state-rfc.md` §2.2;maka 侧证据见 §2。

| # | 五件套 | GoTry(已落地) | Apache Maka | 判定 |
|---|---|---|---|---|
| 1 | append-only 账本唯一权威 | `events` 表,语义幂等键 UNIQUE 物理化(`state-ledger.ts`) | `runtime_events`,`UNIQUE(invocation_id, event_seq)`;工具/回合/continuation 各有 UNIQUE 幂等键;「State is a projection over the ordered log」 | **相同**。差异:GoTry 幂等键挂**语义键**(同一愿望/同一确认),maka 挂**执行流键**(同一 invocation/同一工具调用/同一 claim)——前者防业务重复,后者防执行重复,互补不冲突 |
| 2 | 投影 = 确定性 fold,可 DROP 重建 | 投影表+`state-cli rebuild`;守门纯函数复用为 fold 处理器 | 投影是一等公民:模型历史/UI/终态/恢复/压缩全是 projection;workflow 域 events+projections 成对物理化 | **相同,maka 更彻底**(把「下一个 prompt」也当投影:压缩改投影不改历史) |
| 3 | 红线进事务/schema | evidence/conditions 在写事务内校验,拒绝即回滚 | evidence 强制进任务账本契约(blocked/failed/completed 必带原因/证据);CHECK 约束遍布 schema;fail-closed 原则贯穿沙箱/恢复 | **相同思想,落点不同**:GoTry 落领域红线(画像证据/愿望条件),maka 落执行红线(任务证据/安全边界)。GoTry 无需改 |
| 4 | 步骤日志 + intent-before-execute,崩溃后 done 零重执行 | `workflow_runs/steps`,kill -9 后 done 步骤取 result 不重执行(exactly-once) | T1/T2 工具 journal + Run Composition 先 commit 后调 provider + `core_root_turn_admissions` + `latest_model_call_sequence` 高水位;恢复「never repeats a completed tool」 | **相同**。maka 更细:模型调用本身有高水位(LLM 不重复花钱=maka 的 model-call 序列水位 ≈ GoTry TS-3 的同一动机)。GoTry 已覆盖 |
| 5 | 外部副作用 saga | `pending_writes`(pending/confirmed/compensated + 幂等键 + receipt + 补偿;WriteGate L2/L3 基座) | **无 saga 状态机**。对应物=权限 interaction(request→outcome)+ sandbox 扩权批准 + park 语义;显式声明不承诺任意外部副作用 exactly-once、不自动重试 outcome-unknown | **不同取舍**:maka「诚实 park + 留 unknown」,GoTry「补偿闭环」。见 §7-A2——GoTry 应吸收它的 unknown 态 |

账本之外的增量差(maka 有、GoTry 无):常驻宿主进程与客户端协议(§7 不采纳)、平台沙箱、git 工作区版本化、任务账本/WorkBoard/Agent Graph 子代理、Eval 容器内核、durable 长期记忆子系统。GoTry 有、maka 无:**语义层守门纯函数复用**(maka 投影无领域语义守门概念)、`rewind` 时间旅行调试(maka 的「debugger at any event boundary」是 future)、`VACUUM INTO` what-if 分叉、账本操作 CLI 面(export/forget/tick)。

## §7 结论:可采纳 / 不采纳 / 复审触发

### A. 可采纳清单(每项:价值 / 代价 / 复用矩阵合规 / 建议切片)

| # | 采纳项 | 价值 | 代价 | 复用矩阵 | 切片建议 |
|---|---|---|---|---|---|
| A1 | **终态不变量**:「终态状态必须由终态事件支撑;无 terminal 事实的 run 收敛为结构化失败,不许永久 running」 | 防「工单/回合卡死在 running」这一 maka 文档点名的最难失效类;GoTry `state-cli tick` 回收是近似,但没有该不变量的显式判定 | 小:`state-ledger.ts` 加收敛检查 + §28 断言 | 纯仓内实现,零依赖 | 并入 M5 前的账本加固小片(≈0.5d) |
| A2 | **pending_writes 增加 `unknown` 态**(pending→executing→{confirmed,compensated,unknown}):崩溃发生在执行后、receipt 前,不许自动重试也不许判失败 | maka 用整章 resume 架构论证「缺失结果≠失败也≠没执行」;GoTry WriteGate M5 拍板时正需要这个词汇,否则幂等键会诱使「重试即安全」的误判 | 小:状态机扩一态 + tick 对 unknown 只报警不动作 | 纯仓内 | M5 WriteGate 设计时并入(表已在 TS-4 预留) |
| A3 | **`resumeTrust` 式恢复分类器词汇**(trusted/needs_revalidation/stale/repaired/untrusted)用于工单恢复与投影体检,不进模型上下文 | 给 `state-cli doctor` 一套保守分级语言;巡检报告可判定「这次恢复可信吗」 | 小 | 纯仓内 | 与 A1 同片 |
| A4 | **迁移纪律两条**:`BEGIN IMMEDIATE` 下双读版本号防并发 opener;capability 行门控分域 schema 版本 | GoTry 首写自动迁移已安全,但多进程(cli+web+nudge 并发)下双读是廉价保险 | 极小 | 纯仓内 | 下次动 `state-ledger.ts` 顺手 |
| A5 | **eval 诚实纪律**:append-only attempt + earliest-valid-attempt-wins(禁结果挑选)+「单臂与多臂不可比」式边界声明 | GoTry 巡检层(ADR-11)出报告时的姿态范本——防「挑好看的重放」 | 零代码,写进巡检报告规范 | 文档 | 随下次巡检轮生效 |
| A6 | **node:sqlite 作为生产参照备案** | maka 用 node:sqlite 跑生产+崩溃 harness,佐证 ADR-15 D1 的兜底备选真实可用 | 零 | node 内置=零依赖 | 不动作;仅在本文件备案,若未来 better-sqlite3 native 摩擦恶化则援引 |

### B. 明确不采纳(带理由)

| # | 项 | 理由 |
|---|---|---|
| B1 | Runtime Host 常驻进程 + IPC/WebSocket 协议 + 远程 Host | 服务端/多客户端前提;GoTry 是单机单用户,宿主是 dsh harness(ADR-15 §1.3 明确不动 harness 会话层);引入第二执行权威直接违反 dsh 边界 |
| B2 | Electron 桌面 / 平台沙箱(Seatbelt/bubblewrap/AppContainer)/ Computer Use | GoTry 无代码执行与文件工作面(与 deerflow 调研同结论:求解器进程内 ~6ms);GoTry 的写防护走 ReadGuard/WriteGate 词汇,不需要 OS 沙箱 |
| B3 | Eval 容器内核(Harbor/Pier/mitmproxy/nftables 出口策略) | 重量级 benchmark 设施;GoTry 巡检层(replay/time-eval)已覆盖产品需要,复用矩阵也不允许引入这团依赖面 |
| B4 | git 工作区版本化(workspace epochs/versions/heads) | GoTry 无文件型工作区;账本+`state-cli export` 单向视图已覆盖红线 6 |
| B5 | 任务账本/WorkBoard/Agent Graph 子代理 | 领域错位:maka 管代码工作台任务,GoTry 的 durable 工单(workflow_runs/steps)+愿望池语义已足够;引入即过度工程 |
| B6 | 四套事件词汇并存(SessionEvent/StoredMessage/RuntimeEvent/operational run events) | maka 自己把它列为「current costs」;GoTry「语义层零改造」路线正是为了避免这笔税 |

### C. ADR-15 复审触发判定

**不触发**。复审条件是「多用户 AaaS 化或需要多写者/多端复制」;maka 恰是反证样本:它是单写者(single State Root exclusive writer lease)、单机本地优先、无服务端组件的 TS+SQLite 系统——**与 ADR-15 同一形态族**。它的远程 Host 也只是「一个 State Root 一个 owner」的连接形态,不是多写者复制。可作为 ADR-15 复审条件的一个外部佐证:这个方向的标杆选择了同样的单写者边界。附带发现(不构成复审):maka 选 `synchronous=FULL` 而 GoTry 选 NORMAL(单机崩溃安全与写延迟平衡,RFC §4.4 已论证);maka 也诚实声明「进程崩溃证明≠断电耐久证明」——若 GoTry 未来加断电耐久测试,再评估升级。

## §8 参考文献全表

一手(ASF / 官方仓库):

1. Apache Maka podling 状态页(入孵化 2026-08-13,mentors/champion,setup 清单)— https://incubator.apache.org/projects/maka.html
2. apache/maka 仓库(README/描述/topics/license/星数)— https://github.com/apache/maka
3. ARCHITECTURE.md(后端权威:单执行权威/分层/包边界/Eval 边界)— https://github.com/apache/maka/blob/main/ARCHITECTURE.md
4. maka-proposal-zh-review.txt(提案中文 review v0.11:捐赠形态/初始 committer 及 affiliation/时间线/风险)— https://github.com/apache/maka/blob/main/maka-proposal-zh-review.txt
5. docs/architecture/runtime-core-architecture-draft.md(Log is the Runtime;State(t)=Project;终态不变量;ADK/Kafka 思想来源;2026-08-23 验证)— https://github.com/apache/maka/blob/main/docs/architecture/runtime-core-architecture-draft.md
6. docs/architecture/runtime-host-architecture.md(State Root writer lease;admission;Run Composition 先 commit 后 dispatch;13 规则;副作用不保证 exactly-once)— https://github.com/apache/maka/blob/main/docs/architecture/runtime-host-architecture.md
7. docs/architecture/runtime-resume-architecture.md(Phase 0-4;T1/T2;park/fail-closed;能力矩阵;显式不承诺清单;PR B/C/D 路线)— https://github.com/apache/maka/blob/main/docs/architecture/runtime-resume-architecture.md
8. docs/session-task-ledger-lifecycle.md(任务状态机/evidence 强制/resumeTrust/子代理 claim/非目标 no workflow engine)— https://github.com/apache/maka/blob/main/docs/session-task-ledger-lifecycle.md
9. packages/storage/src/sqlite-runtime-schema.ts(runtime_events/tool_journal/tool_operations/continuation_claims/capabilities;node:sqlite;WAL+FULL;迁移 BEGIN IMMEDIATE 双读)— https://github.com/apache/maka/blob/main/packages/storage/src/sqlite-runtime-schema.ts
10. packages/storage/src/sqlite-workflow-schema.ts(task/plan 的 events+projections 对;scheduled_task_fires 单射;work_board revision CAS)— https://github.com/apache/maka/blob/main/packages/storage/src/sqlite-workflow-schema.ts
11. packages/storage/src/sqlite-core-execution-schema.ts(turn admissions/rejections/proofs;interaction request→outcome;model-call 高水位)— https://github.com/apache/maka/blob/main/packages/storage/src/sqlite-core-execution-schema.ts
12. packages/storage/src/serialized-operation-lane.ts(进程内串行通道)— https://github.com/apache/maka/blob/main/packages/storage/src/serialized-operation-lane.ts
13. packages/runtime/src/sandbox/README.md(Seatbelt/bubblewrap/AppContainer,fail-closed)— https://github.com/apache/maka/blob/main/packages/runtime/src/sandbox/README.md
14. packages/core/src/runtime-event.ts(RuntimeEvent 契约:role×author×status×origin×visibility)— https://github.com/apache/maka/blob/main/packages/core/src/runtime-event.ts
15. packages/cli/README.md(安装/首跑/升级/runtime-host service;平台验证矩阵)— https://github.com/apache/maka/blob/main/packages/cli/README.md
16. packages/eval/README.md(Experiment/Cell/Attempt;earliest-valid-attempt;出格策略的诚实边界)— https://github.com/apache/maka/blob/main/packages/eval/README.md
17. README.zh-CN.md(中文定位;无 ASF release 声明;续跑默认关)— https://github.com/apache/maka/blob/main/README.zh-CN.md
18. NOTICE(仅 ASF 标准归属,无第三方)— https://github.com/apache/maka/blob/main/NOTICE
19. docs/README.md(文档权威地图)— https://github.com/apache/maka/blob/main/docs/README.md
20. marc.info incubator-general 存档([VOTE] 2026-08-09 → [RESULT] 2026-08-13)— https://marc.info/?l=incubator-general&s=maka&w=2&r=1&q=b
21. Whimsy PPMC 名册 / board minutes — https://whimsy.apache.org/roster/ppmc/maka · https://whimsy.apache.org/board/minutes/maka.html
22. maka-agent npm(dist-tags next=0.1.0-beta.1)— https://www.npmjs.com/package/maka-agent
23. GitHub releases(14 个,最新 v0.1.11 2026-08-18)— https://github.com/apache/maka/releases

二手(仅线索,已回到一手核实或标注未证实):

24. Reddit r/PiCodingAgent「maka partially based on Pi」——未证实(见 §1 溯源疑云)— https://www.reddit.com/r/PiCodingAgent/comments/1vuxacp/looks_like_apache_maka_agent_is_partially_based/
25. MoClaw 博文「The Agent That Logs Everything」等第三方覆盖——未用于结论

GoTry 侧(仓内):`docs/architecture.md` §8 ADR-15 / §11 状态面;`docs/transactional-state-rfc.md`(五件套/TS-0..5/D1-D5);`docs/deerflow-research.md`(风格与「不借」先例)。


**捐赠方**

- 无单一公司捐赠:代码原在 `github.com/maka-agent/maka-agent`(2026-05-27 建,Apache-2.0),入孵化时移交 apache org(旧地址现 301 重定向至 apache/maka);提案定位为「vendor-neutral 社区捐赠」,创始人 Jie Wen(jackwener,署 Botiverse, Inc.),7 位初始 committer 分布在 6 家组织 + 1 名独立开发者
