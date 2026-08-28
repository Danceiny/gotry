# RFC:GoTry 事务化状态基座(Transaction State Backbone)——业界调研与落地执行计划

> 状态:**accepted**(2026-08-28 founder 指令「按你的建议来」——D1-D5 全部按建议执行;TS-0..TS-4 已落地,TS-5 触发式后置=D-15)
> 上游权威:`architecture.md`(技术权威面)、`gotry-master-outline.md` §2 复用矩阵、`loopx-inspired-upgrades-rfc.md`(S4/§6.5)、`memory-design.md` §1.6、`tech-strategy.md` T6
> 作者:gotry-builder(2026-08-28,业界调研 + 仓内现状摸底驱动)
> 纪律:单一文件承载单一关注点;版本历史归 git

## 0. 一句话主张

把「文件即权威」升级为「**单文件 SQLite 账本即权威**」:append-only 事件流(物理化)+ 当前状态投影(复用现有纯函数守门)+ schema 级红线 + durable 工单步骤日志 + pending_writes saga(WriteGate 基座)。**语义层零改造**——这正是 memory-design §1.6 预留的「账本化是存储面替换,语义层零改造」的兑现路径,不与任何已 accepted 决策冲突。

## 1. 为什么是现在

### 1.1 现状缺口(摸底证据,2026-08-28)

全部持久化 = 裸 JSON/JSONL 文件,零数据库。逐条:

| 缺口 | 证据 | 业界对应失效模式* |
|---|---|---|
| append-only 只是语义纪律,物理是全量重写 | `memory-utility.jsonl`/`trips.jsonl` 均为 read-modify-write 整文件重写(`ts/src/index.ts:381-383`, `ts/src/index.ts:499-507`) | partial writes |
| 跨文件写无事务边界 | confirm-outcome 同时写 memory-utility + trips 两文件(`ts/src/index.ts:385-412`),中途崩溃即分叉 | partial writes / cascading bad reads |
| 异步工单非原子 | `persistAsyncTicket` 裸 `fs.writeFile`(`ts/src/loop.ts:310-329`),无 tmp/rename/journal | recovery gap |
| 无并发控制 | 全仓无锁/无版本/无 CAS(唯一锁样例是 loopx 自己的 `.loopx/registry.json.lock`) | blast radius |
| 红线靠约定不靠物理执行 | evidence 红线在 `mergeProfile` 纯函数层(已强),但 2026-08-26 巡检污染事故证明:绕过工具直接写文件没有任何物理拦截 | approval loss / blast radius |
| 审计断链 | `gotry_session_search` 生产路径未传 auditPath(`ts/src/index.ts:748-769`),ReadGuard 审计内存计数 | audit gap |
| id 不稳定 | wish_id/工单 id 均时间戳派生(`w${Date.now().toString(36)}`),并发碰撞与时钟回拨无防御 | idempotency 缺失 |
| stateRoot 碎片化 | `ASYNC_DIR` 硬编码相对路径不接 stateRoot(`ts/src/loop.ts:303`) | — |

*Cockroach Labs《Why Agent Loops Fail in Production》七失效模式:partial writes / cascading bad reads / blast radius / memory drift / recovery gap / approval loss / audit gap。

### 1.2 三个正在逼近的触发器

1. **种子用户在即**(roadmap:M3 剩余 = 真实种子用户):每用户一份状态,崩溃一致性从「创始人自己看得见」变成「产品责任」。
2. **M5 WriteGate 需要基座**:tech-strategy T6 已列要素——幂等键/pending state/receipt;RFC S4 已定 L0-L4 词汇。这些全部需要一块能落 pending/receipt 的持久 substrate,目前无处可落。
3. **RFC §6.5 触发条件临近**:「第二个真实用户出现前完成 claim-fence-receipt 设计评审」。claim/CAS/receipt 要在多用户期成立,前提是单机期先有账本(单一权威 + 稳定主键 + 幂等键)。现在做 TS 线就是预付这笔债。

### 1.3 不做什么(防过度工程)

- **不引入 Postgres/DBOS/Temporal/Restate 平台**:单用户本地产品不需要服务端与 broker;「SQLite 学派」(§2.7)已给出生产级替代模型。
- **不动 dsh harness 会话层**:依赖树里 dsh 自带 `dsh-session-persistence-jsonl`/`dsh-session-checkpoint-policy`/`dsh-session-projection`/`dsh-session-query-sqlite`,那四件管 harness 会话持久化;本账本只管**产品状态层**(画像/愿望池/时间线/工单/写权),两层各管各的,不重复 journal。
- **不提前做多用户**:claim-fence-receipt 仍按 RFC §6.5 触发器后置(TS-5)。
- **不加任何 Python 面**(总纲刚性约束)。

## 2. 业界前沿扫描(2025-2026)

### 2.1 总表

| # | 方案 | 核心机制 | 对 GoTry 的取/舍 |
|---|---|---|---|
| 1 | **LoopX**(agent 控制平面;仓内 RFC 已一手调研) | typed packet+receipt、观察不升级为权威、先只读投影后执行、authority 只经显式可回滚 seam、claim/CAS/receipt | 取:receipt/claim 需要账本落点——本计划补的正是持久层;S1-S4 已映射,不重复 |
| 2 | **DBOS**(「Postgres is all you need for durable execution」) | 每步执行前进 Postgres 事务记 checkpoint,崩溃后从 journal 恢复,step exactly-once | 取:步骤日志机制;舍:Postgres 服务(单机 SQLite 化) |
| 3 | **Temporal / Restate** | 平台级 durable execution;event history + signal/query;Restate virtual objects 按 key 单写者序列化 + durable state | 取:「每会话一个 keyed 单写者」形态;舍:平台部署 |
| 4 | **LangGraph** | checkpointer(SQLite/Postgres saver)按 thread 存 checkpoint;time travel = replay + fork | 取:replay/fork 调试形态、投影可重建 |
| 5 | **Letta(MemGPT)** | agent 全状态(memory blocks/历史/工具配置)进 Postgres/SQLite,agent 用工具改自己的记忆 | 印证「agent 状态即数据库行」;GoTry 语义分层更强,只缺物理层 |
| 6 | **Claude Code / Codex transcript 学派** | JSONL transcript 是 source of truth;resume/fork 从 transcript 重建(arXiv 2604.14228);Agent SDK 把「每轮写 JSONL」当一等合同 | 印证 append-only 日志驱动 harness 在生产规模成立;GoTry 的 JSONL 流已同形,缺「唯一权威+事务保护」 |
| 7 | **SQLite durable 学派**(Obelisk 等) | 「control plane 还是单个 SQLite 文件?」——单 SQLite 执行日志 + Litestream→S3 = 完整 durable-execution 模型(append-only log/确定性 replay/可重试 activities),无 broker;诚实声明异步复制 RPO 窗口 | **直接采纳的流派**:单机本地优先 + 用户数据可见可删,完美契合 |
| 8 | **TigerFS**(timescale) | Postgres 挂载为事务文件系统,写=事务,v0.7 任意回滚,配 agent skills | 取:「文件写入要有版本与回滚」的思想;舍:Postgres(账本+投影导出覆盖此需求) |
| 9 | **学术线**:SagaLLM / ATOMIX / DeltaState / GA-Rollback | saga 补偿 agent 处理回滚;timely transactional tool use;毫秒级 checkpoint/rollback;可重放环境步进回滚 | 取:WriteGate saga 的补偿语义参考 |
| 10 | **Cockroach Labs 七失效模式** | 事务/幂等键 `ON CONFLICT DO NOTHING`/检查点表/审批进库/append-only 审计特权保护/时态读 | 取:§1.1 的失效模式对齐即来自此文;「审批进库」直接映射 pending_writes |
| 11 | **Effectful programming(代数效应)** | 效应即协议,handler 是数据;agent 的 pause/resume/副作用建模为效应解释器;LoopX effect-interpreter 是该路线的工程化 | 取:TS-3 步骤日志=效应执行日志(intent → observation 落账本);S1 tool-packet 已铺好 envelope |

### 2.2 共识骨架(五件套)

扫过全部流派,2026 年的收敛共识:

1. **append-only log 是唯一权威**(source of truth);当前状态只是日志的视图。
2. **当前状态 = 日志的确定性投影**(纯函数 fold),可随时 DROP 重建。
3. **不变量进 schema/事务**,不进约定——红线要么物理执行,要么不算存在。
4. **长任务 = 步骤日志 + intent-before-execute**:先记意图再执行,崩溃后 done 的步骤不重执行(exactly-once),未动的步骤重试。
5. **外部副作用 = saga**:pending → confirmed/compensated,幂等键去重,receipt 为证;数据库事务只保内部状态,外部世界用补偿。

GoTry 的语义层已经按 2/3/5 的形状在建设(纯函数守门/幂等键/L0-L4 词汇),本计划是把这五件套的**物理层**一次补齐。

## 3. 现状资产(全部保留,零重写)

| 资产 | 证据 | 在新架构中的位置 |
|---|---|---|
| 纯函数守门全套 | `mergeProfile`(`ts/src/memory-capture.ts:28-59`,追加不删史/幂等/权重变更伴证据)、`appendEvent`(`ts/src/memory-utility.ts:41-54`)、`appendTrip`(`ts/src/travel-timeline.ts:48-62`)、`upsertCompanion`(`ts/src/companions.ts:69-113`)、`pickNudgeWish`(`ts/src/wish-pool.ts:53-66`) | 直接成为 **fold 处理器**与投影更新逻辑,一行不改 |
| append-only 语义纪律 + 幂等语义键 | 上述纯函数 | 从「纪律」升级为「events 表物理属性」 |
| 原子写样例 | `writeJson` tmp+rename(`ts/src/bridge.ts:33-39`);incident fsync(`ts/capabilities/incident-log.ts:51-65`) | 退役为导出路径的实现细节 |
| 测试隔离形态 | smoke mkdtemp stateRoot(`ts/scripts/smoke.ts:20-34`) | stateRoot 即 DB 路径,隔离形态**不变**(tmpdir 一次性 DB) |
| 红线词汇 | ReadGuard(物理只读镜像,`ts/capabilities/session/read-guard.ts`)、WriteGate L0-L4(RFC S4) | ReadGuard 不动;WriteGate 获得 pending_writes 落点 |

## 4. 目标架构

```
stateRoot/gotry-state.db        ← SQLite 单文件,WAL 模式,synchronous=NORMAL
├── events            账本(唯一权威):seq PK / ts / actor / kind / subject_id /
│                     payload JSON / idem_key / run_id
├── 投影表             motivation_profile / wish_pool / companions / trips_view
│                     (派生数据,可随时 DROP 后 fold(events) 重建)
├── workflow_runs     durable 工单:id / goal / status / created / updated
├── workflow_steps    步骤日志:run_id / seq / name / intent_ts / done_ts /
│                     status(pending|done|failed) / result
├── pending_writes    WriteGate saga:idem_key UNIQUE / seam / payload /
│                     status(pending|confirmed|compensated) / receipt
└── kv                schema_version 等杂项
```

### 4.1 读写纪律

- **写 = 单事务** `{INSERT INTO events; UPDATE 投影}`——投影与事件同事务提交,永不分叉(修掉 §1.1 的跨文件分叉)。
- **红线进 schema**:`mergeProfile` 的 evidence 校验在事务内执行,缺失即回滚(INSERT 失败,账本无痕);wish 条件非空 CHECK;`idem_key` 唯一约束 = 幂等物理化。「红线进代码」升级为「红线进 schema」——绕过工具直接写 DB 行不通(工具外无写入路径),绕过 DB 写文件不再影响权威态。
- **读 = 直读投影**(快路径,零改造);**重建 = fold(events)**(与 LangGraph rebuild 同构)。
- **导出 = 命令把投影 dump 回 JSON/JSONL 旧文件名**:文件从「权威」降级为「视图」,红线 6(用户数据可见、可编辑、可删除、可导出)继续成立——用户删导出文件 = 删视图;真删数据 = `gotry-state forget <subject>`(事务删除该 subject 全部 events + 重建投影,删除也是事件可审计……若红线 6 要求「删即真删」,则物理 DELETE 并 VACUUM,两者都支持,决策点 D5)。
- **回放/分叉 = fold 到任意 seq**:「如果这轮画像没写入会怎样」变成一条命令(LangGraph replay/fork;调试与金标准回归共用)。
- **崩溃安全 = WAL + 事务**:kill -9 任意时刻,重开后要么全有要么全无;工单/画像/时间线不再有半行。

### 4.2 durable 工单(「一小时后回来」的真实化)

`workflow_steps` 实现 DBOS/Obelisk 式步骤日志:

```
requestAsync(goal)    → 事务{INSERT run + step(intent)} → 立即可见
collectDeepPlanning   → 每步:记 intent → 执行(LLM/求解)→ 记 done+result
任意进程恢复           → 读 steps:done 的直接取 result 不重执行(exactly-once,
                        LLM 调用不重复花钱);failed/intent 悬挂的重试
```

async-collect 从「读 JSON 工单」升级为「恢复一个 journaled run」;驱动器(loopx tick / 人工 / 未来通知)任意切换,恢复语义不依赖驱动器——补上 tech-strategy 挂账的「异步调度无仓内实现」中**状态面**这一半(调度器本身仍是独立决策 D3)。

### 4.3 WriteGate 基座(M5 前置)

- L2(建议):只 INSERT `pending_writes`(status=pending),无执行。
- L3(具名 seam 确认):pending → confirmed,携 receipt(外部世界回执);失败/反悔 → compensated(saga 补偿,参考 SagaLLM)。
- `idem_key` 唯一 = 「同一预订确认不可能下两次」的物理保证(产品红线:三步确认+幂等键)。
- what-if 预演 = 复制 DB(`VACUUM INTO`)后在副本上 fold,确认后才在正本走 saga——LoopX「先只读投影后执行」的物理化。
- ReadGuard 维持现状:检索态物理只读,与 pending_writes 互不相交。

### 4.4 选型

| 项 | 决定 | 理由 |
|---|---|---|
| 引擎 | SQLite,better-sqlite3(主选)/ node:sqlite(备选,决策点 D1) | 复用矩阵 import 通道 ✓;同步 API 与现有 readFileSync 代码风格零摩擦;单文件=备份/分叉/隔离全部免费 |
| 模式 | WAL + synchronous=NORMAL | 单机崩溃安全与写延迟的平衡点;Litestream 类备份将来也要求 WAL |
| 平台 | 不上 Postgres/DBOS/Temporal/Restate | §1.3;durable-execution 五件套在单 SQLite 内完备(§2.7 流派实证) |
| dsh 边界 | harness 会话层归 dsh 四件套,产品状态层归本账本 | 不重复 journal;dsh 跟 main 不动 |

## 5. 与既有决策的勾稽(不冲突证明)

| 既有决策 | 本计划的关系 |
|---|---|
| 复用矩阵(总纲 §2) | better-sqlite3 = open-source import,合法通道;不引入任何内部资产代码 |
| memory-design §1.6「账本化=存储面替换,语义层零改造」 | 本计划就是该替换的执行;六层载体从文件换成账本+导出视图,§1 的六条设计立场逐条保留(可溯源=evidence 进 events;负面清单=负 schema 字段;红线 6=导出+forget) |
| RFC(loopx)S4 WriteGate L0-L4 | pending_writes 是 L2/L3 的物理落点;「每级可回滚」= saga 状态机 + DB 副本分叉 |
| RFC(loopx)§6.5 claim-fence-receipt | 账本是 claim/CAS 的单机前置;多用户实装仍按触发器后置(TS-5) |
| tech-strategy T6(幂等键/pending state/receipt) | TS-4 直接交付三要素的 substrate |
| ADR-14(效用 sidecar) | memory-utility 事件流物理化为 events 一类,语义键不变 |
| 红线 6 + 2026-08-26 污染教训 | 权威态单点(DB)+ 工具外无写入路径 + forget 命令;巡检/测试仍走隔离 stateRoot(形态不变) |

## 6. 分阶段执行计划(每片独立可拍死)

| 片 | 内容 | 交付与验收 | 测试 | 预估 | 回退 |
|---|---|---|---|---|---|
| **TS-0 立例** | founder 拍板本 RFC;登记 ADR-15「事务化状态基座」(锚点=TS-1 测试);状态面 6 处同步说明 | 文档 + ADR 行 | — | 0.5d | 无需 |
| **TS-1 账本基座** | sqlite store 模块(open/migrate/transaction/events 表);evidence/conditions/idem 约束;`--migrate` 导入现有 motivation-profile + wish-pool(回填为 events);投影导出命令(旧文件名) | 崩溃注入(kill -9 mid-tx)后账本一致;无 evidence 的 INSERT 被拒;同 idem_key 重放幂等 | run-all 新增 §28 | 1-2d | 账本留模块内不接主路径,零行为变化 |
| **TS-2 全量迁移 + 投影回放** | memory-utility/trips/companions 入账本;confirm-outcome 单事务;`gotry-state log/rebuild/rewind` 调试命令 | DROP 投影→fold→与直读逐字节一致;回放到任意 seq 正确;两文件写不再可能分叉 | run-all §29 | 1d | 导出命令反向恢复文件权威 |
| **TS-3 durable 工单** | async ticket → workflow_runs/steps;async-collect 恢复语义(done 不重执行);修 `ASYNC_DIR` 接 stateRoot(`loop.ts:303`);修 `gotry_session_search` auditPath 落盘(`index.ts:748-769`) | kill -9 mid-collect 后重跑,LLM/求解调用零重复,工单终态一致;审计 JSONL 生产路径可见 | run-all §5 升级 | 1-2d | 工单 JSON 兼容读保留一版 |
| **TS-4 WriteGate 基座** | pending_writes 表 + 幂等键 + receipt 词汇(L2/L3 物理预备);what-if DB 副本分叉命令 | 同 idem_key 双确认被拒;pending→confirmed→compensated 状态机走查;副本分叉不触正本 | run-all §30 | 1d | 表留而不用,M5 拍板时启封 |
| **TS-5 触发式后置** | Litestream 备份 / cr-sqlite 多端 / RFC §6.5 claim-fence-receipt 实装 | 触发器:第二真实用户 / 多机部署 / AaaS 立项 | — | — | — |

**执行纪律**(逐片):全栈回归绿(`scripts/run-all-tests.sh`);同提交同步状态面 6 处;具名文件暂存禁 `git add -A`;创始人真实数据(`ts/dsh-runtime/gotry-state/`)迁移是**独立步骤**——先在隔离 stateRoot 全链验证,真实迁移由 founder 亲自执行,执行前 `VACUUM INTO` 留快照(2026-08-26 教训成纪律)。

**顺序依赖**:TS-1 → TS-2 → TS-3 串行;TS-4 只依赖 TS-1,可提前;TS-0 随时。总投入约 4-7 个工作日,可切片 interleaving 进 M4/会话数据面节奏。

## 7. 明确不做

- Postgres / DBOS / Temporal / Restate 及任何服务端组件(§1.3);
- 多写者复制(cr-sqlite)、云备份(Litestream)——TS-5 触发式;
- 动 dsh harness 会话层四件套;
- Python 面、重写求解器语义、提前实现 M5 完整 WriteGate(TS-4 只做基座);
- 对话原文入库(红线:负面清单继续执行,events payload 只存结构化语义)。

## 8. 风险

| 风险 | 缓解 |
|---|---|
| 创始人真实数据迁移事故 | 隔离验证 → founder 亲自跑 → 迁移前快照;导出命令保旧文件名,人眼可核对 |
| 双权威期(文件+DB)混乱 | 不设双写期:one-shot 迁移 + 导出视图单向(DB→文件),文件永不再回流(决策点 D2) |
| SQLite native 模块安装摩擦(better-sqlite3) | prebuilt binaries 覆盖主流平台;兜底 node:sqlite(零依赖);发布闸④ README 实测会暴露任何摩擦 |
| 账本膨胀(事件无限增长) | 单用户量级极小(YAML/JSONL 同量级);`gotry-state compact` 预留(seq 高水位快照) |
| 过度设计 | 六片独立可拍死;TS-1 失败即止损,语义层资产分文未动 |

## 9. 决策点(2026-08-28 founder「按你的建议来」全部结算)

| # | 问题 | 决定 |
|---|---|---|
| D1 | better-sqlite3 vs node:sqlite | **better-sqlite3**(open-source import 通道;同步 API 契合仓内风格) |
| D2 | one-shot 迁移 vs 双写过渡期 | **one-shot + 导出视图单向**;落地形态=首写自动迁移(导入前快照 `pre-ledger-backup/`)+ 显式 `state-cli migrate` |
| D3 | 调度器形态 | **仓内 `state-cli tick`**(恢复语义已与驱动器解耦,随时可换 loopx tick) |
| D4 | TS-4 是否定为 M5 Entry 前置 | **是**(pending_writes/receipt 基座已就位,M5 拍板时启封) |
| D5 | `forget` 语义 | **物理硬删 + 审计一行**(红线 6「可删除」按用户视角解释) |
| D6 | 双形态架构(本地+Web) | **一套账本语义,两种宿主绑定;tenant_id 从第一天就是一等字段;同步=事件复制而非状态翻译**(ADR-16;防「将来大规模重构」的核心冻结) |

## 9.1 执行说明(与 §6 原计划的两处偏差,均已落测)

- 迁移触发:原计划「founder 亲自执行」细化为「**首写自动迁移 + 自动快照** + 显式 `state-cli migrate` 可先行」——安全本质(快照/单事务/one-shot)保留,产品路径无「迁移前工具不可用」窗口。
- 测试分节:saga 断言并入 §28(ledger-tests 39 断言,含崩溃恢复 exactly-once 与 pending_writes/what-if),CLI 面为 §29(state-cli-tests 14 断言)——比 §6 表中 §28/§29/§30 三节少一节,覆盖面不减。

## 10. 参考文献(业界调研来源)

- LoopX:control plane for long-running agents — [dev.to](https://dev.to/arshtechpro/loopx-a-control-plane-for-ai-agents-that-have-to-keep-working-for-days-47n);仓内一手调研见 `loopx-inspired-upgrades-rfc.md`
- DBOS: [Durable Execution for Crashproof AI Agents](https://www.dbos.dev/blog/durable-execution-crashproof-ai-agents) / [Postgres Is All You Need for Durable Execution](https://www.dbos.dev/blog/postgres-is-all-you-need-for-durable-execution)
- SQLite durable 学派: [Do your agents need a durable-execution control plane, or a SQLite file?](https://agentnativeengineering.com/field-notes/2026-05-31-sqlite-durable-vs-cloud-queue/) / [SQLite Is All You Need for Durable Workflows](https://dev.to/lymy1205/sqlite-is-all-you-need-for-durable-workflows-3fkn)
- Cockroach Labs: [Why Agent Loops Fail in Production](https://www.cockroachlabs.com/blog/agent-loops-production-database-patterns/)
- Temporal: [Durable Execution Meets AI](https://temporal.io/blog/durable-execution-meets-ai-why-temporal-is-the-perfect-foundation-for-ai);Restate: [Restate vs Temporal](https://restate.dev/vs/temporal)
- LangGraph: [Persistence](https://docs.langchain.com/oss/python/langgraph/persistence) / [Use Time Travel](https://docs.langchain.com/oss/python/langgraph/use-time-travel)
- Letta: [Platform for Stateful LLM Agents](https://blog.stackademic.com/letta-platform-for-stateful-llm-agents-a83b58a1c926)
- Claude Code transcript 学派: [Manage Sessions](https://code.claude.com/docs/en/sessions) / [Session Browser Cookbook](https://platform.claude.com/cookbook/claude-agent-sdk-05-building-a-session-browser) / [The Design Space of AI Agent Systems (arXiv 2604.14228)](https://arxiv.org/html/2604.14228v1)
- TigerFS: [tigerfs.io](https://tigerfs.io/) / [timescale/tigerfs](https://github.com/timescale/tigerfs)
- 学术: [SagaLLM (arXiv 2503.11951)](https://arxiv.org/html/2503.11951v3) / [Semantic Isolation for Durable AI Workflows (arXiv 2608.05412)](https://arxiv.org/html/2608.05412v1)
- Effectful programming: [Effects as Protocols and Context as Agents](https://interjectedfuture.com/effects-as-protocols-and-context-as-agents/) / [Algebraic Effects for the Rest of Us](https://overreacted.io/algebraic-effects-for-the-rest-of-us/)
- 本地优先复制(触发式): [cr-sqlite](https://github.com/vlcn-io/cr-sqlite) / [Litestream](https://litestream.io/)
