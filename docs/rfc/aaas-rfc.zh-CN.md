[English](aaas-rfc.md) | [简体中文](aaas-rfc.zh-CN.md)

# RFC：GoTry 多用户 Agent 服务化（AaaS）——状态、身份与部署

> 定位：把 GoTry 做成多用户共用的单一云端服务的 A0 设计提案——状态层、租户模型、持久性、身份、部署拓扑，以及由此触发的 ADR 复审。
> 状态：**proposal**（[#674](https://github.com/Danceiny/gotry/issues/674) 的 A0，2026-10-26 起草）。本文任何内容都尚未采纳；在 founder 接受本 RFC 之前，每条 ADR 保持现有文本。
> 上游：founder 2026-10-21 的决定（#674）；[architecture](../architecture.zh-CN.md) §8（ADR-14/15/16/17/23）与 §10（D-15）；[总纲](../gotry-master-outline.zh-CN.md) §2 复用矩阵；[事务化状态 RFC](transactional-state-rfc.zh-CN.md) TS-5；[LoopX 映射 RFC](loopx-inspired-upgrades-rfc.zh-CN.md) §6.5。
> 下游：#674 的 A1–A4 工作项；ADR 复审结论，接受后吸收进 architecture §8 与 [ADR 展开](../adr-expansions.zh-CN.md)；[AaaS 安全设计](../design/aaas-security-design.zh-CN.md)。
> 部署事实：hotel-be `docs/architecture/gotry-backend-deployment-architecture.md`，最近核实于 2026-10-24。约束编号 C1–C16 均指该文档。

## 0. 摘要与决策请求

- **状态边界。** 采用「按租户 keyed 单写者」：每个租户一本账本，任一时刻每本账本至多一个写者；所有权以租约持有，租约的 fencing epoch 由持久层校验。这是把 ADR-15 从「每个安装一本账本」重新界定为「每个租户一本账本」。
- **物理绑定。** 沿用现有 SQLite 账本与内核 schema，每个租户一个文件，并在异地（off-node）留副本。共享的 Postgres 或 MySQL 账本作为具名后备，附明确的切换触发条件。cr-sqlite 不用于服务状态。
- **租户模型。** 租户即账本 owner，每个终端用户一个。组织是部署方，持有凭证、浏览器车道与配额。`tenant_id` 由可信接缝从已认证的 BFF principal 派生；请求载荷、工具参数与模型输出一律不得提供它。
- **持久性。** 明确声明 RPO，而不是暗示「不丢」。写路径封存期间，可接受异步的异地流式复制（RPO 为秒级）。在 AaaS 上启封 M5 之前，WriteGate outbox 必须先做到 RPO = 0。
- **拓扑。** 在 BFF 之后部署专用的内网 gotry 层：N 个副本，按租户亲和路由。由一条新的边界 ADR 为该层取代 C2。浏览器可达面保持为零（C16）。
- **ADR 复审。** ADR-14、ADR-15、ADR-17 与 ADR-23 成立，并补上 §5 的增量。ADR-16 保持冻结，其后置的同步与 claim 事项就此激活。
- **决策请求。** 请回答 §8.1 的 Q1–Q7。接受之后才开工 A1。事实项 F-1–F-4 以只读方式并行查明。

## 1. 问题

### 1.1 触发

founder 于 2026-10-21 立项 AaaS（#674）。这满足了 D-15 的「获批的 AaaS 立项」触发条件；D-15 原由已关闭的 [#275](https://github.com/Danceiny/gotry/issues/275) 跟踪。它同时触发 ADR-14、ADR-15、ADR-17 与 ADR-23 的成文复审条件。

目标：多个用户各以自己的身份调用同一个云端 GoTry 服务。状态按用户隔离，并发写安全，服务可水平扩容，单点故障不丢数据。

### 1.2 基线

| 关注面 | 现状事实 | 锚点 |
|---|---|---|
| 服务 | `gotry-backend` 是单进程、单 HTTP 面加模块注册表：booking-copilot、session-search 与 booking-executor。它监听 `127.0.0.1:3082`；hotel-be BFF 是唯一调用方。 | `ts/src/gotry-backend.ts`；`ts/src/backend/kernel.ts`；C1、C2 |
| 集群 | 每个承载 BFF 的 hotel-be 节点上，紧挨 BFF 跑一个实例：UAT 加四个生产节点（截至 2026-10-24）。每个实例有自己的 state root。节点之间没有任何复制。 | hotel-be 部署文档 §4；C7 |
| 产品账本 | 每个 state root 一个 SQLite 文件，WAL 模式。每张表都带 `tenant_id`。服务端路径打开默认租户 `local`。 | `ts/src/state-ledger.ts`（`openDb(stateRoot, tenant = 'local')`）；ADR-15、ADR-16 |
| Booking Copilot | 同一节点上的全部 BFF 用户共享租户 `local`。彼此之间的隔离依赖 ADR-23 的 request binding，其中携带 principal 与 scope 摘要。 | `ts/src/booking-surface/runtime.ts` |
| 会话桥 | `bridge.db` 按节点存放。job、client、节律与事件都没有租户或组织列。job 按站点能力、首选 origin 与首选 client id 匹配。 | `ts/capabilities/session/bridge-ledger.ts`；`extension-bridge.ts`（`jobMatches`） |
| 执行面 | 供应商会话通过 Stai Travel Bridge 扩展留在员工浏览器里。服务端零 Chrome。 | C10、C15、C16 |
| 并发证据 | 离线演练证明了单个账本文件上的 N 进程安全，并修掉了两个冷启动缺陷。它们不满足任何触发条件。 | [触发演练报告](../evaluation/trigger-drill-report-core.zh-CN.md) Drill 2 |

### 1.3 基线补不上的缺口

1. **状态绑定在节点上。** 租户状态落在服务过它的那个节点，其他节点看不见。hotel-be 是否把同一任务的各轮请求固定到同一节点，本仓证据无法确认（事实项 F-1）。
2. **没有异地副本。** 丢一个节点就丢掉它的账本（D-15）。
3. **共享租户扫描。** events 表只有两个索引：`seq` 主键，以及 `(tenant_id, idem_key)` 上的部分唯一索引。request binding 查找会读取并解析该租户的全部 request-binding 事件；按任务的读取按 `run_id` 与 `kind` 过滤，却没有对应索引。在共享的 `local` 租户上，单次请求成本因此随整个节点全部用户的历史增长。
4. **桥没有组织维度。** 一旦两个组织共用同一服务，某个 job 可能被另一组织的扩展领走，也就是用上另一组织的供应商登录态。节律按节点、按站点计算。
5. **只有 bearer 的身份。** 每个服务面共用一把 bearer key（C13），由 BFF 断言 principal 字段。在回环上（C2）这可以接受；一旦离开回环就不够。
6. **账本之外的状态。** 预订 planner 以 state root 作为 dsh 的工作目录运行。handoff 工单、交付物与 artifact 都是文件。因此租户的持久状态是一个目录，而不只是一个 SQLite 文件（事实项 F-2）。

## 2. 目标、非目标与范围

| 目标 | 可测陈述 |
|---|---|
| G1 隔离 | A2 对抗套件的每个用例中，跨租户、跨组织的读写全部被拒。 |
| G2 并发安全 | 在 N 个写者加崩溃注入下，不丢更新，request key、approval 与 claim 都不被重复消费。 |
| G3 水平扩容 | 增加副本时迁移租户无需手工重分片，每个被迁租户的停顿不超过一次优雅交接。 |
| G4 故障 | 单点故障从不损坏状态，也从不产生两个权威。数据损失以 §4.3 声明的 RPO 为上界。 |

**作为红线继承的非目标。** 立项不解封其中任何一条。

- 写路径仍在 WriteGate 与 M5 Entry 之后（AGENTS.md 红线）。
- 供应商登录态留在员工浏览器（founder，2026-09-11）。云端只做编排、鉴权与排队。
- 不绕过 M3 证据门（[#22](https://github.com/Danceiny/gotry/issues/22)）。AaaS 是并行工程线。
- M6 商业多租户（sponsor）仍在 [#137](https://github.com/Danceiny/gotry/issues/137) 之后。
- 不引入 Python 面，不建 TS↔Python 桥。不改 dsh harness 会话层。
- 访问控制放在展现层。主机与存储层面的控制（文件权限、静态加密、运维审计）不提前设计（founder，2026-10-26）。

**AaaS v1 的范围。** `gotry-backend` 的服务面（booking-copilot、会话桥、executor）做成多租户、多副本。对话式 dsh agent 的托管多用户形态是后续一步，需单独决策（Q6），因为 dsh 是单用户 harness。

## 3. 状态层选项

### 3.1 两条独立的轴

- **分区：** 全部租户共用一个存储，或每个租户一本账本。
- **持久性：** 只有本地 WAL（现状）、异步异地副本，或同步复制。

### 3.2 候选

| 选项 | 机制 | 与 GoTry 的契合度 | 许可证 | 结论 |
|---|---|---|---|---|
| K：按租户 keyed 的 SQLite | 每个租户一个账本文件，加一份带 fencing epoch 的 owner 租约——即 Durable Objects 与 Restate virtual object 的形状 | 保留 ADR-15 schema 与同步内核；扫描按租户封顶；forget 变成删文件。需要路由、租约存储与异地持久化。 | better-sqlite3，MIT，已引入 | **推荐** |
| L：Litestream | 把每个数据库的 WAL 流式复制到 S3 兼容存储；靠恢复做故障切换；每个数据库一个写者 | K 的持久化介质。异步，所以 RPO > 0。它是独立的 Go 守护进程，现有主机上 C1 禁止新增；按租户、按 epoch 的副本路径需要动态配置（F-3）。 | Apache-2.0，活跃 | **K 的推荐介质，取决于 Q4** |
| C：cr-sqlite | 按列对并发写者做 CRDT 合并 | 最终一致无法保证「只消费一次」：两个副本可能在合并前各自消费同一个 approval 或 claim。ADR-16 的事件并集本身已是只增合并。 | MIT | 服务状态**不采用** |
| P：共享 Postgres 或 MySQL | 单一多写者数据库加行级安全；按租户的 advisory lock 可模拟 keyed 写者 | 无状态副本，成熟的 HA 与时间点恢复，配同步备库时 RPO = 0。但内核账本与另外五个模块都同步调用 better-sqlite3，仅 `state-ledger.ts`、`write-gate.ts`、预订 runtime 与桥账本就有 110 多处 `prepare` 调用点。换成异步客户端会重写一个内核钉死文件，并让本地与服务端两种绑定分叉。所查看的两份 hotel-be 配置引用 MySQL，未出现 Postgres。 | PostgreSQL License；`pg` MIT | **后备**（§3.4） |
| R：Raft 复制的 SQLite | rqlite（HTTP API）或 dqlite（C 库） | 同步复制，但 rqlite 把一个事务当作一次提交的语句批来执行，而账本依赖交互式「先读后写」事务。dqlite 是 C 库，本仓依赖集里没有它的 Node 绑定。 | rqlite MIT；dqlite 为带例外条款的 LGPL-3.0（GitHub 显示 NOASSERTION） | **不采用** |
| F：LiteFS | 带主节点租约的 FUSE 复制 | 活跃度下降（最近一次推送为 2026-05）。需要在 supervisor 托管的集群上用 FUSE。 | Apache-2.0 | **不选** |

### 3.3 为什么选 keyed 单写者

1. **语义已经存在。** 现在一个文件就是一个写者域。演练证明了其上的 N 进程安全，争用修复也已在内核里。
2. **只消费一次需要可线性化的写者。** ADR-23 的 approval、request binding 与 WriteGate claim 都只允许一个赢家。每个租户一个写者可直接给出这一点；多写者存储靠事务给出；CRDT 给不出。
3. **ADR-16 早已点名这种绑定。** 它的 Web 绑定就是「同一 schema 落在每用户 SQLite 文件上（或 Postgres，同构 schema）」。
4. **爆炸半径与成本按租户封顶。** 文件损坏、热点租户或缺索引的扫描都只影响一个租户。
5. **内核保持冻结。** 路由、租约与复制都在五个内核钉死文件之外，可能的 epoch 守卫除外（§9）。

### 3.4 切换到后备（选项 P）的触发条件

1. 出现需要跨租户事务或跨租户一致读的产品需求。
2. 某类数据在 §4.3 的路径被证明之前就需要 RPO = 0。
3. A3 演练显示所有权抖动或路由不稳定超出约定预算。
4. 租户数乘以单文件开销超出副本预算。

## 4. 方案

### 4.1 词汇与租户模型

| 术语 | 本 RFC 中的含义 | 不要混淆为 |
|---|---|---|
| 租户（账本租户） | 一本账本的 owner，每个终端用户一个。B2C 中是旅行者；内部部署中是员工。 | hotelbyte 业务上的「tenant」，本 RFC 称之为组织 |
| 组织 | 部署方。持有 BFF 凭证、扩展车道、配额与策略。 | M6 的 sponsor，不在范围内 |
| BFF principal | ADR-23 的安全身份：谁可以调用。由它派生租户；它从不作为动机存储。 | M6 的 traveler principal，账本里存的是其动机 |

- **派生。** `tenant_id = "t-" + hex(HMAC-SHA256(K_org, issuer ‖ 0x00 ‖ subject))[0..32]`，由 GoTry 根据已认证的 principal 计算。`issuer` 是组织的 subject 命名空间。`K_org` 是按组织保存在服务端的密钥，因此 id 既不可猜测，也不可反推。
- **粒度。** 账本 owner 是人。principal 的 `scope` 仍是租户内部的授权属性，按 ADR-23 现有方式绑定（Q2）。
- **本地形态。** 本地产品保留租户 `local`，对它没有任何改变。
- **纵深防御。** 租户文件内的 `tenant_id` 存的是该租户自己的 id，而非 `local`。用错租户打开文件只会读到零行。

```text
<stateRoot>/orgs/<org_id>/
  gotry-state/bridge.db              # 每个组织一本桥账本
  tenants/<tenant_id>/               # 所有权与复制的单位
    gotry-state/gotry-state.db       # ADR-15 账本，tenant_id = <tenant_id>
    ...                              # planner 工作文件、工单、artifact（F-2）

lease record: { key: "<org_id>/<tenant_id>", owner: <replica_id>, epoch: <int>, lease_until: <ts> }
```

### 4.2 所有权、fencing 与写路径

以下是 A1 必须离线证明的契约。

1. **每个租户一份租约。** 一个支持可线性化 compare-and-set 的租约存储保存上面的记录。
2. **获取即递增 epoch。** 副本只有持有租约时才能写该租户的账本。获取是 `CAS(epoch → epoch + 1)`；续约保持 epoch 不变。
3. **按 epoch 分区的持久副本。** 每个 owner 复制到各自 epoch 的专属前缀。恢复永远读取租约存储所记录最高 epoch 的前缀。过期 owner 的写入落进死前缀，永远不可能成为权威。
4. **到期前自我隔离。** 若未续约，owner 按自己的单调时钟在 `lease_until − margin` 时停止确认写入。margin 覆盖约定的时钟偏差上界。
5. **读走 owner。** A1 不准入陈旧副本读。
6. **两条交接路径。** 优雅交接：排空、checkpoint、刷完副本、释放租约。故障交接：等租约到期，新 owner 以 epoch + 1 恢复。
7. **冲突消解。** 同一租户内不存在需要调和的并发写者。过期 epoch 一方落败，幂等键让重试安全。

完整性只依赖第 1–3 条，与时钟无关：不完美的租约服务只损失可用性，不损失正确性（见附录 A 的 fencing token 论证）。已确认写入的持久性取决于 §4.3 的介质。

租约存储是决策 Q3。候选有：hotel-be 的 MySQL（每租户一行，在主库上做 CAS）；Redis（仅因 fencing 保护完整性才可接受；其故障切换可能发出两份租约）；对象存储的条件写（各家支持不一，事实项 F-3）。

### 4.3 持久性与 RPO

| 模式 | 机制 | RPO | 用途 |
|---|---|---|---|
| D-a 异步 | 把每个租户文件流式复制到 S3 兼容存储（Litestream 一类）；恢复 = 最新快照加 WAL | 故障时刻的复制延迟；只有时钟偏差超出自我隔离 margin 时才会更多 | **A1–A3 推荐**，前提是写路径仍封存 |
| D-b 确认即持久 | 只有在已提交的变更经 epoch 条件追加、持久落到异地之后，才回复 BFF | 已确认写入为零，与时钟无关 | **在 AaaS 上启封 M5 之前必须具备** |

- **为什么现在 D-a 就够。** 写路径封存期间不存在涉及资金的状态。有风险的数据是最后几秒的规划轮次，BFF 可以用同一 request key 重放。
- **为什么 D-a 止步于 M5。** 若在供应商调用之后丢失已持久化的 `dispatching` claim，intent 会被重新排队，从而可能二次预订。[WriteGate 设计](../design/write-gate-production-design.zh-CN.md) §5.3 恰恰禁止这一点。
- **为什么 D-b 需要改账本。** 当下并非每个权威行都是事件。`workflow_steps` 的 intent 与 done 行变化时不产生事件，所以只复制事件的副本恢复出的 run 会缺少步骤结果。D-b 因此需要页级捕获或事件完备的步骤日志，两者都会动到内核。
- **D-a 关不上的一个窗口。** 基线钉住所保护的，是被取代的 owner 在其继任者钉基线之后上传的一切。单调时钟被冻结的暂停 owner（虚拟机冻结；`SIGSTOP` 不会让时钟停下）仍可能在继任者拿到租约、尚未钉基线的这段时间内（长度与恢复耗时相当）落下一份快照，而该快照会被恢复。D-b 能关上它，对前一个 epoch 加封印也行。A1 的套件把这个窗口钉在测试里（`tenant-state-copies-tests` 的 X3），所以关上它就会翻转一个测试。
- **恢复校验。** 恢复出的副本必须通过 `integrity_check`，其 fold 必须等于直读，其事件序列必须是源序列的前缀（即演练 D 的性质）。
- **回滚。** 把租户回滚到更早的快照走同一条经校验的恢复路径，回滚本身也是一次 epoch 递增。
- **forget 覆盖所有副本。** 红线 6 要求「删即真删」：forget 同时删除该租户的账本及其异地副本。

### 4.4 身份、授权与配额（A2）

- **认证仍绑定 BFF**（ADR-23）。只有可信 BFF 调用 GoTry；浏览器永远触达不到它（C16）。
- **principal 断言。** 现在每个服务面一把共享 bearer key 携带 principal 字段。服务离开回环后，改用按组织的凭证加 mTLS，或绑定 request 摘要的短时签名断言。具体选哪种由 A3 边界 ADR 决定。
- **在单一接缝处授权。** 每个 handler 只在接缝处解析一次 `(organization, tenant)`。账本句柄是绑定租户的对象。没有任何 API 接受裸 tenant id。
- **配额与计量**按租户、按组织计：并发轮次、轮次速率、按冻结价目表（ADR-20）计价的 LLM token 与成本预算、桥 job 速率、按组织的分站点节律，以及账本大小。
- **A2 退出套件。** 伪造的租户字段、他人的 `taskHandle` 或 `requestKey`、形如路径的 id，以及跨组织的桥回包，全部被拒。

### 4.5 部署拓扑（A3）

- **目标。** 专用 gotry 层：内网上 N ≥ 2 个副本，位于 BFF 之后。任一副本都可接收请求，并转发给该租户的 owner，或在租约空闲时自己获取所有权。租户的 planner 会话在其 owner 副本上运行。
- **路由。** 在 BFF 或 gotry 侧路由器上按 `tenant_id` 做租户亲和的一致性哈希，压低所有权抖动。
- **边界。** 一条新 ADR 为该层取代 C2：绑定内网地址、按组织的凭证、永不进公网 nginx、永不被浏览器触达（C16 不变）。若持久化介质需要 sidecar，同一条 ADR 一并修订 C1。
- **桥。** 同一租约模式按组织应用。落到任一副本的扩展长轮询都转发给该组织的桥 owner。job 匹配增加「组织相同」条件。
- **可观测性。** 以 HMAC id 为键的按租户、按组织指标，租约与 epoch 事件，复制延迟，以及配额拒绝；不含 PII。
- **滚动发布。** 所有权只在 schema 与特性集兼容的副本之间移动，遵循 ADR-23 的交集规则。
- **过渡备选（Q5）。** 保留按节点的回环实例，在 hotel-be 加租户粘滞路由，并共享持久存储。这样改动的边界更少，但扩容仍与 hotel-be 节点耦合。

### 4.6 故障模式

| 故障 | 发现方式 | 影响 | 恢复 | 保持的不变量 |
|---|---|---|---|---|
| owner 副本崩溃 | 租约到期 | 租户最多不可用 TTL 加恢复时长 | 新 owner 以 epoch + 1 恢复 | 不出现两个权威；损失以 RPO 为界 |
| owner 与租约存储分区 | 续约失败 | owner 在租约结束时自我隔离 | 他处产生新 owner | 过期写入落进死前缀 |
| 租约存储不可用 | 获取或续约报错 | 不产生新所有权；现有 owner 在租约结束时停止 | 恢复前返回 typed 503 | 不出现双 owner |
| 对象存储不可用 | 复制报错与延迟告警 | D-a：RPO 增长；D-b：写入返回 503 | 恢复后补传 | D-b 从不静默确认 |
| 时钟偏差 | 租约 margin 监控 | — | margin 按偏差上界取值 | 完整性不依赖时钟 |
| 租户文件损坏 | 打开时 `integrity_check` | 影响一个租户 | 从持久副本恢复 | 爆炸半径为一个租户 |
| 热点租户 | 配额计数器 | 被限流 | typed 429 | 其他租户不受影响 |
| 在飞轮次丢失 | 客户端超时 | 重试 | 同一 request key 重放 | 不产生重复效果（ADR-23 binding） |
| 桥 owner 崩溃 | 租约到期 | 排队的 job 等待；已领取的 job 结算为 `unresolved` | 新桥 owner（`recoverOnBoot` 语义） | 不出现跨组织领取 |
| 版本混跑 | 特性公告 | 可选特性关闭 | — | ADR-23 交集规则 |
| 配置错误致两个副本共用一个文件 | 租约 epoch：恢复以原子重命名的方式替换文件，旧写者握着的是已被解除链接的文件（在 `kv` 里对每次写入都检查的守卫会改动内核） | 旧写者在下次续约时被围栏 | 修正配置 | 单写者 |

### 4.7 走出按节点的孤岛

- **先盘点（F-2）。** 只读统计每个节点 state root 中的租户、事件类型与文件。
- **Booking Copilot 历史。** 任务生命周期短。提案：不迁移。新任务进入租户账本；节点账本以只读方式留作审计，之后归档（Q7）。
- **不做推断。** 已记在 `local` 下的事件绝不凭猜测重新归属（ADR-16）。任何搬移都走 [#254](https://github.com/Danceiny/gotry/issues/254) 的授权修复流程。

## 5. ADR 复审（启动）

| ADR | 触发 | 结论 | 接受后拟增补 |
|---|---|---|---|
| 14 记忆效用 | 多用户 AaaS 账本化 | 按租户成立。归因仍需租户本人确认。 | 不做跨租户的效用聚合；出现第二个消费方时仍重新打开本 ADR。 |
| 15 事务化状态 | AaaS 与多写者 | **以 keyed 单写者形式成立。** 「单文件权威」重新界定为每个租户一个文件。 | 「每租户一本账本，是该租户的唯一权威；任一时刻至多一个写者，以 epoch fencing；异地持久化并声明 RPO。」锚点：A1 套件。 |
| 16 双形态（永不复审） | 其后置事项（AaaS） | 冻结成立。其后置的同步协议与 claim/CAS 实装就此激活。 | 每用户 SQLite 文件成为服务端绑定；同步仍是事件复制。 |
| 17 预订 saga | 并行多写者的预订流 | 成立。keyed 单写者把一个租户的 saga 串行化，因此不准入并行写者。 | AaaS 上 saga 状态位于租户账本；M5 启封前 D-b（RPO = 0）是前置条件。 |
| 23 Booking Copilot 边界 | 多写者与跨 host | 成立。跨 host 的连续性来自租户路由，而非共享状态。 | 在可信接缝派生租户；`requestKey` 与 `taskHandle` 按租户作用域；离开回环后改用按组织的凭证。 |

**对 issue 提问的回答。** 只要两个条件同时成立，keyed 单写者在多租户形态下就成立：租约存储提供可线性化的 compare-and-set，且持久层按 epoch fencing。缺任何一个，设计都会退化为脑裂风险，不得上线。

C2 是 hotel-be 的部署约束，不是 ADR。A3 边界 ADR 为 gotry 层取代它。

## 6. 威胁模型（摘要）

初稿见 [AaaS 安全设计](../design/aaas-security-design.zh-CN.md)。对本 RFC 影响最大的威胁：

- 经伪造标识符或共享缓存的跨租户访问；
- 跨组织的桥路由，落到另一组织的供应商登录态上；
- 分区之后过期 owner 的写入；
- 服务离开回环后 bearer key 暴露；
- 单个租户耗尽成本、轮次与桥资源；
- 已删除数据残留在异地副本中。

## 7. 落地计划（每个阶段都可叫停）

| 阶段 | 交付物 | 退出证据 | 叫停时 |
|---|---|---|---|
| A0 设计 | 本 RFC、ADR 复审、威胁模型、文档对账、事实项 F-1–F-4 | founder 接受本 RFC（回答 Q1–Q7） | D-15 记下已满足的触发条件；运行时无任何变化 |
| A1 状态层 | 内核之外的租户路由器与租约；按 epoch 分区的副本；恢复与校验；隔离 state root 上的离线并发与故障注入套件 | 套件全绿；#275 清单每一条都对应一个通过的测试或一条记录在案的决定 | 不部署；按节点的孤岛保持不变 |
| A2 身份与配额 | 接缝派生的租户、组织密钥、配额与计量 | 对抗套件：跨租户读写全部被拒 | 只做单组织部署 |
| A3 部署 | N 副本内网层、边界 ADR、可观测性 | UAT 多副本运行加故障演练：杀 owner、分区、租约存储宕机、对象存储宕机、恢复 | 回滚到按节点回环 |
| A4 生产 | 首个真实的第二用户：hotelbyte 员工 | 生产多用户证据；D-15 移入债务归档 | 停在 UAT 的 A3 |

模拟演练、夹具与离线套件永远不算 A3 或 A4 证据。

| #275 清单条目 | 在哪里闭环 |
|---|---|
| 记录触发证据并选定一种部署拓扑 | A0：触发为 #674；拓扑为 Q5 |
| 定义租户所有权、fencing、幂等、冲突消解、备份/恢复与回滚契约 | §4 定义，A1 证明：run-all §89（租约与围栏）、§90（副本、已验证的恢复、忘记）与 §91（路由器、交接）。有意选择更早的快照属于运维操作，等到 A3；恢复路径已经会退回更早的已验证快照（§90） |
| 用隔离 state root 与崩溃/重开测试证明并发写者与过期 claim 被拒 | A1：run-all §89（六个进程竞争一份租约）、§91（被围栏的句柄拒绝每次调用）与 §92（四个副本竞争下的击杀、越过租约的暂停与优雅交接） |
| 端到端验证备份恢复与租户隔离 | A1 离线：§90（已验证的恢复、他租户镜像被拒）、§91 与 §92（两个租户，账本等于其谱系）；A3 提供上线证据 |
| 跑账本套件、隔离 smoke 与全量回归；同步权威面 | 每个阶段 |

## 8. 决策、待查事实与风险

### 8.1 founder 决策

| # | 问题 | 建议 |
|---|---|---|
| Q1 | 是否把「按租户 keyed 单写者」作为 ADR-15 重新表述后的边界？ | 是 |
| Q2 | 账本 owner 是否为人，principal scope 作为属性？ | 是 |
| Q3 | 用哪个租约存储？ | hotel-be MySQL，每租户一行 |
| Q4 | 用哪种持久性模式？ | A3 之前用 D-a，在总纲修订后引入 Litestream；AaaS 上 M5 之前具备 D-b |
| Q5 | 用哪种拓扑？ | 专用内网层，加一条新的边界 ADR |
| Q6 | AaaS v1 的范围是什么？ | 先做 `gotry-backend` 服务面；托管的对话式 agent 之后单独决策 |
| Q7 | 现有按节点的 `local` 账本怎么办？ | 只读归档；不迁移 |

### 8.2 A1 设计冻结前要查明的事实（只读）

- **F-1** hotel-be 如何在节点间路由同一任务的后续轮次。
- **F-2** 每个节点的 state root 里有什么：租户、事件类型与数量，以及 planner 工作文件。
- **F-3** hotelbyte 的 S3 兼容存储是否支持条件写，以及 Litestream 能否在其上把动态的租户文件集合复制到按 epoch 区分的路径。
- **F-4** hotel-be 的 MySQL 能否承载租约表，以及其 schema 由谁负责。

### 8.3 风险

| 风险 | 缓解 |
|---|---|
| 自研的租约与 fencing 代码很微妙 | fencing 把租约缺陷变成可用性损失；故障注入套件；针对故意弄坏的守卫必须失败的证伪测试 |
| 非粘滞路由下的所有权抖动 | 租户亲和路由；带预算的抖动指标（切换触发条件 3） |
| sidecar 守护进程与 C1 冲突 | 在 A3 边界 ADR 中决定；D-b 不需要 sidecar |
| 内核钉死文件会被改动 | 路由器与租约放在内核之外；`state-ledger.ts` 内的任何 epoch 守卫都需要 founder 明确批准并重钉清单 |
| 与 hotelbyte「tenant」的词汇冲突 | §4.1 的表；代码命名用 `ledgerTenant` 与 `organization` |
| 单个租户耗尽成本 | A4 之前落地按租户、按组织的预算 |
| 与 hotel-be 路由的隐藏耦合 | A1 设计冻结前查明 F-1 |

## 9. 与仓库纪律的勾稽

- **复用矩阵。** 接受之前不引入任何新依赖。引入 Litestream、`pg` 或其他候选，先修订总纲 §2（总纲 §6）。
- **内核清单。** `state-ledger.ts` 已钉死。路由、租约与复制都留在内核之外。内核内的 epoch 守卫需要 founder 明确批准。
- **状态纪律。** A1 的全部测试跑在隔离 state root 上，绝不碰 founder 的运行时状态。
- **写路径。** WriteGate 行为不变。预订写入保持封存。
- **语言与 harness。** 不引入 Python；dsh 跟 main，不做修改。
- **同提交规则。** 接受后，所属权威面在同一提交中更新：architecture §8 与 §10、ADR 展开、roadmap 与总纲。

## 附录 A. 来源

- Martin Kleppmann，[How to do distributed locking](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html)：fencing token 让锁服务故障成为活性问题，而非安全性问题。
- SQLite，[Write-Ahead Logging](https://www.sqlite.org/wal.html)：除非使用独占锁模式，WAL 需要同一主机上的共享内存。
- [Litestream](https://github.com/benbjohnson/litestream)：向对象存储流式复制 WAL，每个数据库一个写者。
- [cr-sqlite](https://github.com/vlcn-io/cr-sqlite)：基于 CRDT 的多写者 SQLite。
- [rqlite](https://github.com/rqlite/rqlite) 与 [dqlite](https://github.com/canonical/dqlite)：Raft 复制的 SQLite。
- [LiteFS](https://github.com/superfly/litefs)：基于 FUSE 的 SQLite 复制。
- PostgreSQL，[Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)；[node-postgres](https://github.com/brianc/node-postgres)。
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/) 与 [Restate](https://docs.restate.dev/)：keyed 单写者状态。
- 许可证与最近推送日期于 2026-10-26 通过 GitHub API 读取。
