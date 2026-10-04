[English](session-dual-zone-memory-design.md) | [简体中文](session-dual-zone-memory-design.zh-CN.md)

# GoTry 会话双区记忆设计（P4 / M6 层）

> 定位：issue #255 P4 会话双区记忆的实现级设计——在 ADR-15 账本之上落「会话工作区 + 长期区 Notebook」；本次立项只交付设计与拆分计划，不含实现代码。
> 状态：**active**（创始人 2026-10-02 批准进入实现流程；P4-1..P4-4 序列已落地——纯核 run-all §74、账本落点 §77、会话接线 §78、观测与指标 §79；`sessionZones` 出厂默认关）
> 上游：[memory-design.md](memory-design.zh-CN.md) §1/§2 M6/§4 P4、[事务状态 RFC](../rfc/transactional-state-rfc.zh-CN.md)（ADR-15/16）、[issue #255](https://github.com/Danceiny/gotry/issues/255) 启动前验收、`gotry-master-outline.md` §3.5 第 5 层。
> 下游：PR 序列 P4-1..P4-4（§5）、`memory-design.md` §4 P4 状态同步、#228 家族观测面。
> 日期：2026-10-02

## 0. 速览

- 一个账本，两个分区：**会话工作区**（随会话窗口生灭，30min/24h 分层快速过期，永不经 owner 确认）与**长期区 Notebook**（跨会话存活，唯一入口是 owner 确认的晋升——模型只能提名，永不能自晋升）。
- 零新表：在既有 `events` 表上新增六个日志类事件 kind，加上新纯函数模块的读路径确定性 fold——即 `trip.logged`/`memory_utility.event` 同款模式，对内核钉住的 `state-ledger.ts` 零改动。
- 不重做任何一层：动机/愿望池/时间线/同行人保持既有守门为唯一写入权威；晋升条目若命中其语义则改走既有通道；Notebook 不是平行事实库。
- 价值必须可否证，否则不算数：晋升确认率、意图 TTL 内的免重问率、过期误命中率——全部可由账本事件加 #228 家族 opt-in 导出离线计算；「记得更多」与 fixture 一概不能作数。
- 明确不做：多用户 claim/CAS 物理化（留在 D-15 之后）、任何活体数据采集、任一区内出现对话原文/ID/token/URL、新 schema、触碰已冻结的 #20 scorer `p4` 闸。

## 1. 双区定义（M6 层契约）

### 1.1 会话工作区（`hot_context`）

一个在规划会话中的工作集。它存在的意义：让回访会话不再重复追问上一轮、或上一个会话（意图 TTL 内）已经确立过的事。

- **归属判定**：一条事实属于工作区，当且仅当（a）它派生自本会话的用户陈述或工具结果，（b）它的有用性随时间衰减，（c）它尚未获得 owner 的长期存储确认。满足（a）但不满足（b）的是晋升候选，不是工作区居民。
- **数据形状**：`HotNote = { schema, note_id, zone:'hot', tier:'resource'|'intent', kind（闭集）, payload（有界结构化片段——slot-spec 族类型，除有上限的引用证据外无自由文本）, evidence_ref（指向 dsh 会话 transcript 的指针：session_ref + 轮次序号——绝不是内容）, ttl_expires_at（由层级与最后写入时间确定性导出）, rev, created_at, last_touched_at }`。
- **TTL 层级**（主纲领 §3.5 第 5 层）：`resource` 30 分钟（检索结果、可售形态、价格带指针），`intent` 24 小时（仍在博弈中的目的地、日期、同行人数、预算口径）。时钟从最后一次**写入**起算；读取绝不续命。
- **会话语义**：`session_ref` 是不透明的本地会话引用（与 session-link 契约同形族：不含路径字符、长度有界）。resource 层仅本会话可读；intent 层跨会话可读直至过期——这 24 小时窗口正是「第二天回来接着聊」的场景。

### 1.2 长期区（`trip_notebook`）

跨会话存活的结构化断言。每一条在诞生或后续修订时都经 owner 确认。

- **归属判定**：一条条目存在于 Notebook，当且仅当 owner 确认过它；长期区没有第二条写入路径。这是 ADR-14「归因只认 owner 确认」纪律在存储本身上的应用。
- **数据形状**：`NotebookEntry = { schema, entry_id, zone:'durable', kind（闭集：trip_fact|preference|constraint|lesson）, payload（结构化断言）, evidence（用户原话或工具结果引用）, origin（{session_ref, note_id?} 晋升谱系）, owner_confirm（{surface:'user_reply'|'approval_card', quote}——缺失或超长的引用被守门拒绝）, created_at, updated_at, rev }`。
- **信任层级**：确认与既有记忆写入一样经由模型转达（与 `motivation_save` 同层）；守门强制证据引用，fold 保留谱系，审计留痕确认表面。

### 1.3 分区判定与边界事件

| 输入形态 | 分区 | 边界事件 |
|---|---|---|
| 工具观测片段，时效绑定 | 工作区 / resource | `hotctx.note.captured` |
| 仍在博弈中的用户陈述片段 | 工作区 / intent | `hotctx.note.captured` |
| 对在活笔记的更正或推翻 | 工作区 | `hotctx.note.dropped`（若仍成立可再捕获） |
| 在活笔记的 CAS 更新 | 工作区 | `hotctx.note.revised`（rev+1） |
| owner 确认晋升候选 | 工作区 → 长期区 | `notebook.entry.promoted` |
| owner 修订长期条目 | 长期区 | `notebook.entry.revised` |
| owner 移除长期条目 | 长期区 | `notebook.entry.dropped`（审计行留存；物理删除走 forget） |

过期**不是**事件：它是事件日志与（注入式）时钟的纯函数在读路径上算出的视图。把时钟清扫写进 append-only 账本会破坏 fold 确定性。晋升仅在源笔记在同一过期函数下尚未过期时合法。

## 2. 账本落点（复用 ADR-15/16，零新表）

- **事件 kind**（六个，§1.3）以日志类事件落在既有 `events` 表上——`foldEvent` 的 default 分支本就对日志类 kind 不做投影，与 `trip.logged`、`memory_utility.event` 完全同款。`subject_id` = 笔记/条目 id；幂等键为 `hotctx:<note_id>:<生代>:<rev>` / `notebook:<entry_id>:<生代>:<rev>`，同 rev 重放写入即物理 no-op（与 `mu:` / `trip:` 键同款技巧）。生代 = 文档的 `created_at`（诞生时刻，修订沿用不变）：id 是语义派生的，drop 后重捕获会复用同一 id 与 rev 1——键里没有生代，UNIQUE 索引就会把 §1.3 明定的「更正后仍真」重捕获物理吞掉（P4-2 物理化时发现）。
- **写路径**：单事务 {fold 读当前 rev；守门校验；INSERT}，由新模块经账本公开面（`db.transaction` + `readEvents` + `insertEvent`）执行。乐观 rev CAS：父 rev 不等于当前 fold rev 的写入在落库前以 `stale_rev` fail-closed 拒绝。按 ADR-16 的单账本 owner 语义，每会话单写者天然成立；跨进程/跨主机 fencing 留在 D-15（[#275](https://github.com/Danceiny/gotry/issues/275)）之后——rev 词位现在就选定，未来 fencing 只加物理不改语义。
- **读路径**：`readEvents(kind)` + 新纯函数模块内的确定性 fold（`readTrips` + `projectUtilityNow` 同款模式）。P4 v1 不落持久化投影：单用户量级下每会话体量极小，未来的 `projection_items` subject 是零语义改动的优化项。过期与存活在该 fold 内计算。
- **删除/导出**：新 kind 直接接入既有 `forgetSubject`（红线 6「可删除」= 物理删除加一行审计）；`state-cli export` 增加两个派生视图（`hot-context.jsonl`、`notebook.json`），从 fold 读出——是视图，绝不是写路径。所有 fold 消费方在**日志截断**时一律 fail-closed：`readEvents` 触到上界丢的是**最老**的事件，截断的 fold 会让遗忘漏掉主体、让残缺导出冒充全量——写路径、会话级遗忘、导出视图与观测计数因此全部拒绝执行。
- **重捕获与过期**：note id 由（会话、层、kind、规范载荷）派生，所以只有**同一个**片段会撞 id；而过期是读时视图，过期笔记仍在 fold 状态里。于是纯 capture 会把「同一检索过了 TTL 再跑一次」判成 `stale_rev`，工作区悄悄停止供述该形态；捕获缝改用「捕获或续命」：续命是写入，TTL 自它起算，过期笔记因此复活（rev+1，诞生血缘不变）。
- **零新表论证**：双区每条数据都小、按 subject 划界、append-only 且幂等去重、可 fold 成视图——`events` 形态四项全中。专用表只会在多写者量级（TTL 索引、按会话 claim 行）才回本，而那正是 ADR-15 的 re-review 触发器（D-15）。若 D-15 触发：claim/fence 物理化加可选持久化投影；事件词位与本设计语义原样存活（「sync = 事件复制，不是状态翻译」）。
- **内核冻结**：`state-ledger.ts` 被内核 manifest 钉住（run-all §63 门禁）；本设计要求对它零改动，P4-2 验收包含该门禁零哈希漂移地保持绿。

## 3. 与现有记忆面的关系

- **ADR-14 效用 sidecar——不变**：Notebook 条目不是 wish，P4 内不发 `memory_utility` 事件。owner 确认纪律以结构方式继承（晋升时的 `owner_confirm`；模型永不自晋升）。按条目的效用记账（以 entry_id 为键的 recalled/applied/verified_outcome）将构成第二个效用消费方——那是 ADR-14 自己的 re-review 触发器，不属于本设计。
- **愿望池——不动**：Notebook 无 `conditions` 字段、无触达；「永不主动推销」0..1 红线仍只归愿望池。
- **动机画像——不动**：晋升绝不写 `mergeProfile` 权重。若晋升条目**就是**一条长期偏好，改走 `gotry_motivation_save`（契约 18 吸收）——既有守门仍是该语义的唯一写入权威。
- **时间线/同行人——同一路由规则**：晋升的行程事实走 `gotry_trip_log`；同行人约束走 `gotry_companion_save`。Notebook 记录断言与谱系；它永远不是平行存储。
- **账本——唯一写入权威**：双区增加的是事件 kind，绝不是第二个存储。dsh 会话 transcript 仍是 dsh 自有四包内的对话原文权威（ADR-15 §1.3 边界）；两区只存指针（`session_ref` + 轮次序号），绝不存 transcript 内容。
- **P4 不重做已落地层**：M1–M5 各面、读回链与 memory-metrics 契约不变；唯一触碰是 `memory-design.md` §2/§4 的增量状态同步。迁移路径（清单第 3 项）：分区状态是全新的，无可迁移——增量事件 kind 无需 schema 迁移，既有任何一面都不改权威。

## 4. 触发语义与可否证的价值证据（#255）

- **触发记录**：创始人 2026-10-02 批准进入实现流程；本立项（设计 + 拆分计划）先于实现 PR，issue 在 PR 序列落完前仍是 tracker。#255 清单映射：所有权/过期/CAS/删除/导出 → §1–§2；唯一写入权威与迁移 → §3；隐私边界 → 本节；可否证指标 → 本节；创始人批准 → 文档头。
- **隐私边界（清单第 1 项）**：任一分区与任何导出都不得包含对话原文、凭据、URL 或敏感身份字段。负面清单执行两次——分区写守门（纯函数，与同行人守卫同族）与观测面导出守门。证据只以指针与有界引用承载，绝不是 transcript 内容。
- **证据采集**：复用 [#228](https://github.com/Danceiny/gotry/issues/228) collector 纪律——显式 opt-in、隔离 `stateRoot`、HMAC 假名引用、同意声明、只采形态计数（分层捕获/修订/丢弃数、晋升提名/确认/否认数、过期年龄、工作区读命中与未命中）。无常驻服务、无自动遥测、不挂产品会话；导出在 [#20](https://github.com/Danceiny/gotry/issues/20) 证据等级下恒为 candidate 级，绝不自我背书。
- **可否证指标（清单第 4 项）——「记得更多」一条都过不了**：
  1. **晋升信号质量**——晋升提名中的 owner 确认率与否认率；一个主要收集否认的长期区，说明提名器失准。
  2. **工作区收益**——免重问率：意图 TTL 内回访会话未重复追问的字段数，除以配对首访问过的同名字段数（配对形态借自 #20；按 flow 计算，不看内容）。
  3. **过期误命中率**——分区供出事实被 owner 更正的占比；超声明上界即反向证伪 TTL 分层。
- 上述指标的阈值在 P4-4 的度量契约里于 PR 时冻结（#20 的阈值冻结纪律——本设计不发明数字）。**2026-10-04 冻结于 `session_zone_metric_contract.v1`（`ts/src/session-zone-observation.ts`），先于任何数据存在**：`minimum_sample_count=5` 与 `min_reask_avoidance_ratio=0.5` 直接沿用 #20 已为 M4 Exit 冻结的两个数（`minimum_pair_count_for_exit` / `target_median_reduction_ratio`）——工作区不给自己一条比 Exit 更松的线；`min_confirm_rate=0.5` 是提名器的最弱可辩护下界（「对的比错的多」——主要被 owner 否认的提名器按定义就是失准）；`max_stale_hit_rate=0.1` 是天花板不是目标——被 owner 更正的分区供述是用户看得见的记忆失败，十分之一即证伪 TTL 分层。输入不得移动这些数字：夹具声明不同值即 `contract_invalid` 拒收，低于样本线的指标一律 `insufficient_sample`，永不 `pass`。fixture 只证明度量契约；`synthetic_fixture` 永不声称价值，`observed_private` 也永不高于 candidate（本面不生成 reviewer/attestation 字段）。#20 scorer/manifest 契约内冻结的 `p4` 闸遵循其自身证据规则，不由本立项翻转。
- **激活开关**：插件配置 `sessionZones: 'off' | 'on'`，默认关闭——与 `sessionAccess` 同族三态开关。创始人本地开启；真实使用经由 collector 产出 `observed_private` 候选，绝不来自环境采集。

## 5. 实现拆分（PR 序列，验收全离线）

串行链，每个 PR 独立可验收；所有验收断言都是离线测试形态（纯函数套件 + 隔离 stateRoot smoke；零网络、零活体采集）。

| PR | 范围 | 验收断言（离线） |
|---|---|---|
| **P4-1 分区契约纯核** | 新 `ts/src/session-zones.ts`：类型化闭集、`HotNote`/`NotebookEntry` 形状、守门（负面清单、owner 确认引用、rev CAS）、注入时钟的 TTL/过期纯函数、确定性 fold 与读视图 | 闭集违规被拒；负面清单拒绝证件号/手机号/URL 形态载荷；`stale_rev` fail-closed；过期随注入时钟单调；fold 是事件的纯函数（重建 == 直读）；新增 run-all 节（编号 PR 时指定） |
| **P4-2 账本落点 + 删除/导出** | 六个事件 kind；经账本公开面的事务化追加（`state-ledger.ts` 零改动）；`forgetSubject` 接入；两个导出视图 | 同 rev 幂等重放为 no-op；追加中途 kill -9 要么全有要么全无；forget 删除分区事件并留一行审计；导出视图等于 fold 输出；run-all §63 内核 manifest 门禁零漂移地保持绿 |
| **P4-3 会话接线（默认关）** | 捕获缝（工具观测边界与契约 18 式用户陈述吸收，只落证据指针）；persona 读回 `{{session_zone_brief}}`（有界：在活工作区笔记、回访时的 intent 层笔记、Notebook 行）；经 owner 确认表面的晋升流；更正即弃 | 隔离 stateRoot smoke，零写入 `dsh-runtime`；负面清单守卫端到端在位；首访读回为空；无确认引用的晋升被拒；`sessionZones:'off'` 时接线惰性 |
| **P4-4 观测 + 度量 + 状态同步** | opt-in 形态计数、HMAC 候选导出（collector 家族）、三个可否证指标的只读投影、`memory-design.md` §2/§4 状态同步 | fixture 只证明度量契约（不是价值）；导出仅含计数与引用——零内容字段（断言）；观测路径零定时器/零网络；双语文档与状态面同 commit 同步 |

**落地状态（2026-10-04）**：P4-1 run-all §74、P4-2 §77、P4-3 §78、P4-4 §79——全部离线，`sessionZones` 默认关。相对本立项有两处偏差，均记入 §7：幂等键补了生代（§2）；P4-3 注册了 `{{session_zone_brief}}` 动态变量，但**没有**把占位符写进出厂 persona（`cordis.gotry-patch.yml`）——引用它就改了出厂提示词，那是创始人决定面，而默认关验收要求 persona 输出逐字节不变。P4-4 另加了 owner 否决面（`gotry_session_zone_note action="deny"`，零账本写入）：没有它，确认率就没有分母，指标 ① 会按构造恒为 1.0。

## 6. 明确不做

- 多用户复制、claim/fence/receipt 物理化——留在 D-15（[#275](https://github.com/Danceiny/gotry/issues/275)）之后。
- 任何活体或环境数据采集；观测面是 opt-in 的 CLI 形态，#228 家族。
- 对话原文、ID、token、URL 或敏感身份字段进入任一分区或任何导出。
- 新表、schema 迁移、改动内核 manifest 钉住文件（全程不碰 `state-ledger.ts`）。
- 触碰 dsh 自有四个 harness-session 包；transcript 权威仍归 dsh。
- 重做 M1–M5 各面、平行其写入权威、或存自由文本 LLM 记忆（每条捕获必过类型化守门）。
- 由本工作翻转 #20 scorer 冻结的 `p4` 闸；它遵循自己的证据规则。

## 7. 决策日志（被拒方案）

| 被拒方案 | 理由 |
|---|---|
| 读取续命 TTL | 读路径副作用破坏 fold 确定性与重放；寿命只从写入起算 |
| P4 v1 落持久化 `projection_items` subject | 单用户量级下读 fold 已足；现在落库毫无收益还添重建面 |
| 带 TTL 列的专用分区表 | 只有多写者量级才回本——恰是 D-15 re-review 触发器；事件词位已覆盖 v1 |
| 过期/清扫事件 | 时钟动作不属于 append-only 账本；过期是读时视图 |
| Notebook 作为平行事实库 | 每个语义单一写入权威（§3 路由规则）；第二个存储即真相分叉 |
| 现在就做按条目效用事件 | 那是 ADR-14 的第二个消费方——由 ADR-14 自己的 re-review 触发器裁决，不是 P4 |
| 模型发起晋升 | 存储继承 ADR-14 owner 确认纪律；只许提名 |
| 不带生代的幂等键 | id 是语义派生的，drop 后重捕获复用同一 id 与 rev 1——UNIQUE 索引会物理吞掉 §1.3 明定的重捕获（P4-2） |
| P4-3 就把 `{{session_zone_brief}}` 写进出厂 persona | 改出厂提示词是创始人决定面，而默认关验收要求 persona 输出逐字节不变；变量已注册，开关一开 persona 即可引用 |
| 为晋升推断路由载荷 | 从工作区笔记猜权重/日期/同行人约束等于伪造 owner 事实；缺路由载荷即 `routing_required` fail-closed |
| 只有提名、没有否决面的晋升漏斗 | 没有 owner 否决，确认率的分母只剩确认——指标 ① 按构造恒为 1.0（P4-4） |
