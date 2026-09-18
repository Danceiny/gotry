[English](adr-expansions.md) | [简体中文](adr-expansions.zh-CN.md)

# ADR 展开——决策索引背后的正文

> 定位:`docs/architecture.md` §8 ADR 表中「见 §8.x」引用的逐决策证据正文(issue #477)。表留在 architecture.md 作决策索引,长正文归本文件。
> 状态:living。每条正文与其 ADR 行同改。


#### 8.12 时间感分层
- 时间评测集进仓（`data/time-slot-eval.json`，只增不改语义），质量层首块落地。
- 备选与取舍：全 LLM 感知——锚点缺失实测（legacy 路径无「今天」注入，过期无从判）；代码全量解析中文相对日期——表达开放，维护黑洞。
- **复审补充的边界**：解析层只认锚点卡词表 + 绝对表达 + 「+N」后缀；词表外 unresolved 逐字保留，**不做开放式解析**（锚点 `slot-spec.ts`；time-eval §5）。

#### 8.14 记忆效用 sidecar
- `recalled`/`applied`/`verified_outcome` 三类事件 append-only（`gotry-state/memory-utility.jsonl`）。
- **归因纪律**：attribution 只能在 confirm-outcome 由用户明说落盘，**模型不许自评「有用」**。
- wish 稳定 `wish_id` + muted（休眠不删除）；召回 0..1/轮（`gotry_wish_pool_list` 条件评分，muted 永不召回，无命中不硬推）——M4 北极星「下一次出发率」的度量底座。
- 备选与取舍：召回即记「有用」——自称用了 ≠ 让结果变好；wish 删除制——憧憬不该被拒绝。

#### 8.15 事务化状态基座
单文件 SQLite 账本（better-sqlite3，WAL）= 唯一权威，业界 durable-execution 五件套收敛：
1. **events append-only**：语义幂等键 UNIQUE 物理化，`wish_id` 语义派生。
2. **投影表 fold 可重建**：纯函数守门原样复用，语义层零改造。
3. **红线进事务**：evidence/conditions 拒绝即回滚。
4. **durable 工单**：`workflow_steps` intent-before-execute，崩溃恢复 exactly-once。
5. **pending_writes saga**：WriteGate L2/L3 基座（幂等键/receipt/补偿）+ what-if 分叉（VACUUM INTO）。

旧 JSON/JSONL 降级为单向导出视图（红线 6）；one-shot 迁移（首写自动 + 快照 `pre-ledger-backup/`）。

备选与取舍：Postgres/DBOS/Temporal/Restate 平台——单用户本地产品不需要服务端（SQLite durable 学派「一文件即控制面」）；纯文件加固 tmp+rename——修不了跨文件分叉与并发；`node:sqlite`——零依赖但较新，D1 落选备选。

#### 8.16 双形态架构冻结
- **一套账本语义，两种宿主绑定**：本地 = better-sqlite3 直读文件；Web = 同一 schema 跑在每用户 SQLite 文件（或 Postgres，schema 同构）。
- **`tenant_id` 从第一天就是一等字段**：events/投影/工单/pending_writes 全部带租户列，单用户期恒为 `'local'`，主键空间化防跨用户撞。
- **执行边界（issue #224 修复）**：`insertEvent` 必写当前 ledger tenant；`readEvents(kind?)`、投影 fold 与 `rebuildProjections(toSeq?)` 必带 tenant 条件；`wish.updated` fold 查当前租户已有 item，跨租户同 `wish_id` 不串读。legacy JSON/JSONL 与 v1 DB 只迁入 `local`；已经被旧 bug 写成 `local` 的非 local 事件缺少可审计 owner，不可由 schema 迁移猜回，只能在有外部证据时另走人工 data-repair issue/PR。
- **同步 = 账本事件的复制，而非状态的翻译**：events 行带 `tenant_id` + 幂等键，双端合并天然幂等。写必经账本，读必带租户上下文进不变量表。
- 备选与取舍：本地与 Web 各长一套逻辑——多用户期合并只能推倒重来；云端权威 + 本地缓存——违反红线 6 本地优先；同步投影而非事件——投影是派生态，合并会分叉。

#### 8.17 预订 saga 状态机具名化
预订/支付/退改的 saga **不引入编排框架（LangGraph 等）**，FSM 落为账本 `pending_writes` 的词汇层（`ts/src/booking-saga.ts`，`booking_saga_fsm.v1` 纯函数）：状态字母表与 CHECK 约束逐字一致，边全函数化。

备选与取舍：LangGraph/Temporal 式框架——第二运行时，违反 harness 基线与复用矩阵；状态散落 SQL 字符串——边语义漂移无词表；多 Agent 提示词协同——隐式依赖。

#### 8.18 效应解译器 `effect_interpreter.v1`
「效应描述 + 解译器」下沉到 L4 渠道边界——工具/编排层只产纯数据效应值 `{effect, params}`；渠道访问、退避重试、断路器、编译期 mock 全部收敛到解译层。

备选与取舍：逐工具自由调用能力层——横切逻辑复制，无退避/熔断/mock 面；Python browser-use——违反零 Python 依赖；解译器内置多渠道路由排序——违反 OTA 平铺。

#### 8.19 可下单事实单一数据源 + 产物事实闸
每个可下单事实（航班号/时刻/机场/价格/政策）**只允许存在于结构化事实层**（`gotry_bookable_fact.v1`），产物渲染前过闸。

本切片补齐机/火共享原语的行内硬价边界：exact-date 事实价为 CNY 时，仅绑定航班/车次自身窗口内的 `¥NNN`/`CNY NNN` 做可靠一致性校验；不一致产生 `price_contradicted`，源事实缺价、不支持的硬币种、或无锚点且价格超出启发式 120 字窗口产生 `unverified_price_claim`；起价/约价、非数字仍不比较，不做换算或容忍度推断，酒店 `priceRaw` 保持打码语义。不关闭 [#273](https://github.com/Danceiny/gotry/issues/273) 或 D-26 全部残余。

备选与取舍：LLM 自觉标注——无强制力（issue #46 实证失败）；渲染时宽松放行——未核验事实出门；政策面接实时签证 API——v1 政策事实仅渲染侧 + 闸侧，生产端记 D-26。

**根治方向**：产物只由渲染原语生成（结构化 → markdown 单向），反向抽取降为过渡态。

#### 8.21 扩展分发三通道
Chrome 平台禁止非商店 CRX 直装——GitHub Releases 只做「下载」（稳定资产名 tar.gz/store-zip/dist-manifest），Web Store 才是「一键装 + 自动更新」。三通道同一扩展：**Chrome Web Store（2026-09-02 上架，推荐）** 一键装/自动更新；GitHub 通道显式 opt-in（免审核、版本更新更快）；bundled 保离线确定性兜底。

**上架实测**：商店用自己生成的签名 key 重签，不认 manifest 固定 key——商店版扩展 ID（`oeajpiccmonococjcegddlooeeohlbgd`）与 unpacked 固定 ID（`olpgkofjhhiiiahdkkbcninhjmegghfe`）不同；桥 Origin 白名单双通道同信（`EXTENSION_ORIGINS`，run-all §38），端口池/host 白名单不随通道漂移。

备选与取舍：任意 URL 装 CRX——平台禁止；npm 包唯一通道——扩展更新被迫跟 rc 发版火车；独立 pinning——与解耦目标冲突；自建更新服务器——违反零基建面。

#### 8.22 static golden = 可审计 comparator
route/carrier 只取 OpenFlights 固定 revision；时刻/价格取 manual band 且逐字段标 estimated；`requested`/`effective` source、revision/license 与 fallback reason 同条 evidence 落盘。**快照或路由失败必须 stderr 告警后回退 manual，禁止静默换源或伪装 live availability。**

备选与取舍：`hbcli search-flight`——本机与上游均无此能力（N/A）；携程免凭证开放 API——未找到且公开页 432（N/A）；直接把 manual 改名 static——来源造假；仅保 manual——继续 vendor 锁。

#### 8.23 ADR-23：embedded Booking Copilot 安全边界与 BFF request identity binding

> **状态更新（2026-09-05）**：复审条件「所有消费方迁移 v2 后再退 v1」**已触发**——#133（栈式合流 #134）把双协议收敛为单一 `booking.surface` 契约：v1-only runtime 删除，v2 栈转正为无后缀 canonical 文件（`contracts.ts`/`runtime.ts`/`server.ts`/`startup.ts`），`SCHEMA_VERSION='booking.surface'`，单一 HTTP 路径单一握手，ledger 去掉版本词表；JSON wire 字段名不变。以下为双协议时代的决策原文（边界设计仍然成立），当前形态以本条为准。

Booking Copilot 是既有工作台内的 BFF-only embedded read-action 面：

- **协议形态（历史）**：v1 曾保持兼容，v2 曾以 closed typed contract 并行；同一 listener、task ownership 与 ledger 按请求 version+schema hash dispatch。**2026-09-05 起收敛为单一契约，v1 退役**。
- **概率 planner 边界与契约演进**：`booking.surface` 表示兼容线，因此兼容性增量沿用版本号，schema hash 仅用于诊断；只有 wire-incompatible 变更才建立新兼容线。可选的发送方行为取所有可路由 release identity 的新鲜 feature advertisement 交集；缺失或混合 advertisement 时禁用，随机命中一个实例的 `/status` 不能代表整个集群。认证 BFF 通过 `X-Booking-Surface-Features` 传递该交集；GoTry 会从同兼容线的新任务中剥离未协商的可选动作与权威投影，因此旧 BFF 的基础动作矩阵既不会误开能力，也不会令请求失败。模型只看到 provider dialect 投影，tool executor 在同一个有界 run 内重验完整 canonical schema，并以精确 `INVALID_ARGS` 回灌修复。每个可执行 operation 都必须重复持久化的 `booking.intent.v1` 停靠点；runtime-owned authority 字段、action-to-intent 路径、权威 receipt、报价数量与 terminal 证据均独立于模型文本验证。缺少 intent 的旧 ledger action 只作为历史可读，必须经新用户 turn 重新锚定，绝不从 action 猜测目标后恢复执行。
- **identity binding**：生产 standalone 的 `bff-bound-turn-only` 只接受已由 BFF 绑定的 internal `user.turn`/receipt continuation；v2 浏览器只提交安全 opaque `requestKey`/可选 `taskHandle`，只有完整 authenticated principal/scope + BFF trusted binding seam 才能把 `user.turn.ingress` 原子映射为服务端生成并持久绑定的 `taskId + turnId + contextRef + surface + allowedActions`。bound-turn-only 下 ingress 在任何 ledger/planner side effect 前返回 typed 503；taskHandle 在 actor scope 内只能绑定一个 task/context。
- **approval 一次性**：must blocker 只能经 runtime 持久化并实际呈现的 option 放行；approval 逐字段绑定 task、context、source turn、source action、source receipt digest、canonical presentation key、随机 delivery nonce 与 option digest，只能消费一次。
- **availability reducer（typed 恢复子状态机）**：一次 recovery 冻结最多 5 家候选酒店；每家 generation 最多 3 个当前 OfferRef，每家生命周期最多 2 次 CheckAvail、2 次 offers/HotelRates generation。`unavailable`、material `changed` 或不可确认 gap 使整个 generation 失效并要求 fresh query；partial evidence 只产生 inconclusive exhaustion，不能宣称市场无房。generation/attempt/candidate/receipt digest/workspace revision 随 ledger fold，重启与相同 replay 不增加预算；terminal 是吸收态。恢复链契约层（`ts/src/booking-surface/recovery-chain.ts`，run-all §65）把该 reducer 投影到用户沟通与审计面：供应商 changed/unavailable 判定显式披露、不静默换房换报价、`booking.copilot.recovery.*` saga 形态审计事件——#142 合并 gate 的真实库存证据仍 gated no-spend。
- **同 revision 重放守门（ordinary TURN 分支）**：先做 confirmed-availability 的 `confirmed_workspace_drift` 拒绝（保持历史特定诊断稳定），再做 generic same-revision 守门；`BookingCopilotTaskRuntime.resumeTask` 对每条普通 `booking.copilot.user.turn.observed` 行做 same-revision 比较——把 durable workspace 语义摘要（剥除 contextRef/revision）与同 revision 上的前一态对比；silent drift 以 `ledger_corrupt:<task>:same_revision_turn_workspace_drift` fail-closed，而不是让旧 public `startTask`（无 live-time CAS）写下的行把 verifiedOffer/loadedOffer/selection 漂移带进重放、把 replayed workspace 变成 checkout authority。显式 `replayUpgradeRequired` reanchor 与 confirmed-availability 的 `confirmed_workspace_drift` 拒绝保留原行为；live-time `startTask` 守门（同 revision 且无 active reanchor → `workspace_mismatch`）仍是首要防线。

明确拒绝的备选：独立聊天预订页；用 breaking v2 替换 v1；自由文本/JSON 执行；把 server outbox 意图当作已展示；在 embedded 面暴露 `Book`。当前能力不包含 portal token、PII 或供应商成本出站；离页自动写/支付已让渡到 M5 WriteGate proposal（`design/write-gate-production-design.md`），多写者或跨 host 则按 ADR-15/16 复审。

#### 8.24 ADR-24：turn 预算 = 路由 + wall-clock 双出口（turn-policy / turn-deadline）

**问题（2026-09-02 轨迹定形）**：任何一轮对话必须终结在三态之一——①当面答完 ②转异步并给出回访承诺 ③收敛作答；绝不允许第四态「流死掉、什么都没交付」。原步数闸（16 软/18 硬）与 v1 固定 wall-clock 闸（60s/120s）同属一个错误形状：到点「拒绝工具 + 逼出 final」——模型仍可能在流中死掉，轨迹用户拿不到任何东西。

**v2 设计（复杂度决定出口结构，不是映射到更大的常数）**：

- **路由层**（`ts/src/turn-policy.ts`）：每个 user/message（source.kind=user；plugin/skill 注入不参与）确定性分类 quick / sync-planning / deep-planning。纯函数、零 LLM、零 IO——控制面判定必须确定性（责任铁律；ADR-9 同型先例）；路由器不能花它要分配的资源；LLM 路由会破坏评测可复现（§45 离线 E2E 零真 LLM）。v1 规则输入只有 Tier 0（日期跨度提取器+约束词表+消息长度）；`loop.ts` 的 `isComplex` 是 S5 循环架构的访谈后复核，不在产品路径（唯一调用者是 replay 脚本），且对轨迹首消息判 false，**不进此层**。误分有界：最坏结局是「本可当面答的被转后台」（下一轮可救），所以路由器只需够用不需完美。
- **分配层**：分类 → `TurnPolicy={softMs,hardMs,exit}`。阈值表是数据不是代码（评测/部署换表不换执行器）：quick 120s/180s converge；sync-planning 300s/600s converge；deep-planning 120s/240s **handoff**（同步窗口只够摸底+落单）。
- **执行层**（`ts/src/turn-deadline.ts`）：硬阈拒绝时**同步**抑制继承工具 schema（轨迹教训：延迟到 `step/end` 模型会在同 step 回环拒绝结果直到 token 截断），按 exit 返回：converge=`TURN_DEADLINE_EXHAUSTED`（用已有证据作答）；handoff=落 `gotry_turn_handoff.v1` 工单（`<stateRoot>/gotry-state/turn-handoffs/`，含用户原文/ETA=约1小时/status=open）并指令模型一句话告知「已转后台+预计时间+回访方式」。工单是**独立格式独立目录**：async-collect 对无 spec 的 state 会立即结算 failed（假失败），handoff 收集器是未来的 loopx agent tick——落单本身已是三态承诺的兑现（有据可查、可回访），不等收集器存在才有意义。
- **装配**：产品路径 `apply()` 默认装（路由+handoff 是产品行为）；benchmark opt-in 钉死 `{60s,120s,converge}` 固定 policy 保可复现。`GOTRY_TURN_DEADLINE_SOFT_MS`/`_HARD_MS` 仅 pin 数值不改出口；`GOTRY_TURN_HANDOFF_ROOT` 钉工单隔离根（source 模式 dsh cwd 是创始人真实数据目录 `ts/dsh-runtime`，测试必须钉，巡检状态纪律）。无 agent 的程序化调用不计，turn/session 终态释放状态与限制。CI 先打当前 SHA 的 tarball、在隔离 pnpm consumer 中解析 dsh peer closure，再把该安装入口交给同一 E2E，不借 root 开发树冒充发布形态。
- **验证**（`run-all §45`）：`turn-policy-tests.ts` 表测（首条 fixture=轨迹用户原文，canonical deep case 必须命中——整个重设计的回归锚点）；`agent-planning-turn-deadline-tests.ts` Cordis 集成（converge/handoff 双出口、工单字段、plugin 消息纪律、生命周期）；E2E 以合成 deep 消息+relay 拖过硬阈，断言 handoff 结果、工单落隔离根、最终请求 text-only、非空 final。

**收集闭环（2026-09-02 v2 补全，「一小时后回来看看」的后台半段）**：

- `ts/scripts/turn-handoff-collect.ts`（单张 `<ticketId>` / `--all`，async-collect 的 turn-handoff 对位）加载 open 工单 → 以 `GOTRY_HANDOFF_CHILD=1` 派生 headless 规划会话（`bin/gotry-inner.js`，可经 `GOTRY_HANDOFF_PLANNER_BIN` 覆盖；递归防护：子会话唯一出口 converge + 长 leash（300s/900s），父进程的数值 pin 与工单根在子环境清除——前台转后台、后台必须产出交付物，不得再次 handoff）→ 捕获最终答复结算。
- `settleTurnHandoffTicket` 原子写 `<id>.deliverable.md` + 工单 status settled/failed（settledAt/deliverableFile/error）。终态幂等：已结算工单复诵交付物与 `gotry_turn_handoff_terminal.v1` JSON（succeeded exit 0 / failed exit 2），零重算零再花；failed 交付物是诚实失败说明（「没有完成，请重新发起，无部分结果可交付」）。
- 复访面：产品路径注册只读工具 `gotry_turn_handoff_list`——用户回问「规划好了吗」时模型查工单状态，settled 附交付物摘录（≤600 字，全文在同目录 .deliverable.md），禁止编造不存在的交付物。
- 调度：收集器是一次式命令（cron/loopx tick/人工均可驱动，`--all` 扫全部 open）。v1 诚实边界：工单只携带用户原文，规划会话是全新上下文（fresh cwd/DSH_HOME），原会话已读的工作区/日历结论不随单迁移，由规划器按需重取。E2E 闭环：§45 的打包二进制 E2E 在 handoff 断言后以真二进制为 planner 跑收集器，断言 ticket open→settled、交付物含规划器 final。

复审触发：路由误分成系统性问题（「该当面答的被转后台」可观测）时先扩 Tier 0 词表再考虑 Tier 2（结构化状态）；handoff 工单积压需要真实收集器时启动 loopx tick 设计；评测端 60s 太紧先调 env pin。

明确拒绝的备选：到点杀 turn 的任何常数闸（固定或 LLM 动态生成——形态不变则轨迹失败模式不变）；LLM 路由（一致性/可复现/成本三输；若未来信号不足，走 loopx RFC S4 的 L1 shadow→L2 advisory 影子对比路径挣授权，不默认给）；handoff 复用 loop 工单格式（async-collect 假失败）；阈值交 dsh 宿主传（违反 gotry/dsh 分层）。

