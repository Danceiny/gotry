[English](code-map.md) | [简体中文](code-map.zh-CN.md)

# 代码地图——模块清单

> 定位:自 `docs/architecture.md` §3 拆出的模块清单细节(issue #477)。`docs/architecture.md` 保留短摘要与链接,本文件是该关注面的细节权威。
> 状态:living。状态列词汇按行定义。

每个模块/测试套件一行:职责、当前状态与钉住它的验证分节。

| 文件 | 角色 | 状态 |
|---|---|---|
| `ts/src/contracts.ts` | 顶层数据与工具契约（TripState/五工具 IO/wire schema） | 草案，待创始人走查 |
| `ts/src/loop.ts` | 对话循环：runTurn/interviewNext/异步深度规划（request/collect+不失望四条） | ✅ 重放验证 |
| `ts/src/mock-llm.ts` | 剧本 LLM（ADR-8）：确定性重放真实对话的智能侧 | ✅（S4 后留作回归夹具） |
| `ts/src/unified.ts` | **统一行程模型 TS 版（唯一求解入口）**：Segment/Option/时区/工作窗口+Z3 求解（航班链）+枚举求解（候选形态） | ✅ 4/4+候选对账 |
| `ts/src/model.ts` | 门到门全成本算术（纯函数，单候选形态） | ✅ |
| `ts/src/engine.ts` `journey.ts` | 旧两套求解面（纯 oracle，金标准对照） | **deprecated** |
| `ts/src/index.ts` `bridge.ts` | dsh 插件（纯 TS unified 求解 + hbcli 桥 + 进程护栏，延迟计量） | ✅ smoke |
| `ts/src/turn-policy.ts` `turn-deadline.ts` | Agent 每轮「路由 + wall-clock 双出口」：确定性分类（quick/sync/deep，零 LLM）→ TurnPolicy；越硬阈同步抑制 schema，converge=EXHAUSTED / handoff=落 `gotry_turn_handoff.v1` 工单+ETA 告知；benchmark 钉固定 policy | ✅ run-all §45 |
| `py/gotry_feasibility/unified.py` | Python oracle（v0.0.1-rc.2 后**仅历史对照**，不再被产品运行时引用） | 保留 |
| `py/gotry_demo/` | **已删 2026-08-22**（D-7 尾债：demo 规划书生成器曾调废弃 journey.solve_journey；产物 docs/milestones/demo-plan-2026-07-17.md 留 git 历史） | — |
| `ts/scripts/replay.ts` `replay-async.ts` | **验收夹具**：真实对话重放（13 轮→3 轮）与异步形态 | ✅ |
| `ts/scripts/{engine,journey,unified,diff}-tests.ts` | 套件（8/5/4 断言+TS-vs-TS 同 spec 稳定性） | ✅（diff-test 顺序偶发为已知问题，v0.0.1-rc.2 后不再依赖 Python） |
| `ts/src/time-anchor.ts` | **时间锚点层**（ADR-12，纯函数）：锚点卡渲染（今天/相对周/月分段/季度/节日）+ 绝对月日解析；persona 与抽取链路的「今天」唯一来源 | ✅ time-eval §1 |
| `ts/src/travel-slots.ts` | **槽位抽取层**（travel_slot_extraction.v1）：schema + 抽取 prompt + 过期校验 + language 检测 + 评分器；逐字保留，判定归代码 | ✅ time-eval §2-4 |
| `ts/src/slot-spec.ts` | **槽位→日期解析层**（D-10 切片 A）：锚点卡词表 + 绝对表达 + 「+N」后缀 → YYYY-MM-DD；词表外 unresolved 逐字保留（ADR-12 边界：不做开放式解析）；spec 日期一致性闸 | ✅ time-eval §5 |
| `ts/src/tool-packet.ts` | **工具观察 envelope**（RFC S1/ADR-13）：GotryObservation 平封形状 + ToolFailure + interpretArgs 参数三形态归一唯一入口 | ✅ smoke §9 |
| `ts/src/memory-utility.ts` | **记忆效用 sidecar**（RFC S2/ADR-14）：recalled/applied/verified_outcome 事件 + 幂等追加 + 只读投影；归因只认 owner 确认 | ✅ smoke §10 |
| `ts/src/memory-lifecycle.ts` `ts/scripts/memory-lifecycle.ts` | **M4 planning lifecycle collector**（#228）：显式 stateRoot/consent/HMAC 才写；dataset key verifier + source/wait 冻结；首返 flow/wait/reflux/preference HMAC 假名化；JSONL+manifest write-all/原子发布/路径隔离；导出接 #223 scorer candidate/synthetic，不造 manual attestation | ✅ run-all §55 |
| `ts/src/memory-decay.ts` | **时间窗衰减原语**（memory-design P3）：30/90/180/365d 分级因子（地板 0.1）+ 种类权重 + 新鲜置信度；动机层零衰减为构造性保证 | ✅ run-all §23 |
| `ts/src/companions.ts` | **同行人档案**（memory-design P2）：upsert 合并 + 负面清单守卫（证件/电话零入库）；约束只进排序 | ✅ run-all §21 |
| `ts/src/travel-timeline.ts` | **旅行时间线**（memory-design P1）：trips.jsonl append-only + 幂等/重叠冲突即停 + verified↔timeline 交叉一致 | ✅ run-all §20 |
| `ts/src/wish-pool.ts` | **愿望池匹配纯函数**：条件评分 + 0..1 挑选（muted 排除/确定性 tie-break）；wish_pool_list 与 nudge 共用 | ✅ run-all §21 |
| `ts/capabilities/channel-registry.ts` `ts/capabilities/channel-health.ts` | **通道注册表 + 通道健康面**（design/tool-orchestration-design.md，issue #106/#107/#108/D-7/D-8/D-9）：通道×意图×配额类×证据级单一数据来源；persona 路由卡与 `routing` 建议同源生成；会话瞬态态（down/cooldown，hit 即清除）+ `channel-health.jsonl` 持久事件面；排序=lexicographic（可用性，证据级，效率），建议非派发 | ✅ run-all §50 |
| `ts/capabilities/flyai.ts` | **FlyAI 官方通道**：飞猪 8 只读工具的管道层（search-flight/train 先接），证据链 `[实时API:flyai@ts]` | ✅ run-all §24-F |
| `ts/capabilities/session-search.ts` + `session/` + `extension/` | **会话检索面**（RFC P1-P3.5）：传输=扩展桥 PRIMARY（`extension/` MV3 + `extension-bridge.ts` 回环桥，零新依赖；**capability 路由**：站点 job 只派给声明该站点的轮询者）/cdp 显式后备（ReadGuard 写请求物理拦截+审计，fail-closed）/persistent 测试；携程机票适配器（batchSearch 嗅探）/dida 供应商门户适配器（SearchRealTime 信封展平，2026-09-09）/action-cache 自愈层（变量化key+指纹被动失效+miss回写）；节律闸；`[会话:*]` 证据链 | ✅ run-all §25/§38 |
| `ts/capabilities/session/extension-distribution.ts` + `ts/scripts/extension-distribution-cli.ts` | **扩展分发通道**（ADR-21 分发 A）：GitHub Releases 下载链（稳定资产名/dist-manifest fail-closed 解析/SHA256/平台 tar 解压/key 钉扎/版本比较/原子交换），失败显式降级 bundled；CLI 单行 JSON 供 bootstrap spawn | ✅ run-all §43 |
| `ts/capabilities/artifacts.ts` | **产物面**（issue #25 最小切片）：产物发现（账本 workflow_runs 权威 + 无账本回退 async 目录视图 + dsh 工作目录顶层 md）+ 行号窗口读取（dsh read 卡）；只读，路径/扩展名白名单 | ✅ smoke §13 |
| `ts/capabilities/effect.ts` `ts/capabilities/resilience.ts` | **效应解译器 + 韧性原语**（effect_interpreter.v1，issue #16 采纳/ADR-18）：效应值注册表（渠道 handler+策略表）+生产/mock 解译器（渠道 observation 原样透传+trace 横切证据）+ 指数退避（withRetry）/断路器三态（CircuitBreaker）；23 工具外部依赖面全收敛（issue #115） | ✅ run-all §37 |
| `ts/src/state-ledger.ts` | **事务化状态账本**（ADR-15）：SQLite 单文件唯一权威（events append-only+语义幂等键/投影表 fold 可重建/workflow_steps durable 工单/pending_writes saga）；`gotry_async_terminal.v1` 固化 4/4/非 4/4 终态、退出码与零重算复诵；守门纯函数复用为写路径与 fold 处理器；读路径带旧文件回退；首写自动 one-shot 迁移+快照 | ✅ run-all §28 |
| `ts/src/booking-saga.ts` `ts/scripts/booking-saga-tests.ts` | **预订 saga 状态机词汇层**（booking_saga_fsm.v1，issue #17 采纳/ADR-17）：状态字母表+四条边全函数边表+结构化拒绝闭集+审计链校验；§36 与账本 saga 基座逐格物理对账 | ✅ run-all §36（纯函数，零写路径接线） |
| `ts/src/booking-surface/recovery-chain.ts` `ts/scripts/booking-recovery-chain-tests.ts` | **unavailable/changed 恢复链契约**（issue #142 非门控切片）：供应商 changed/unavailable 判定的纯函数处置链——检测把 action receipt 分类进既有 `ActionReceipt.status` 闭集（confirmed/changed/unavailable/inconclusive/unrelated，不发明新通道；不连贯凭证 fail-closed，沿用 policy 自己的 `availability_receipt_incoherent`/`availability_observation_required` 词汇）；受控恢复记录 requery/换版复查/替代候选三步闭集，计入 planner 三次调用预算语义（第 4 次计入轮即拒——只能显式降级），并以 `RECOVERY_REUSED_BUDGETS` 冻结引用 availability-policy 的每酒店预算；用户沟通红线：未先显式披露就落到不同酒店/报价，结构性拒绝（`recovery_silent_swap_forbidden`）；版本位移必须携显式新旧版本说明；恢复耗尽只能携非空披露降级；审计事件走 `booking.copilot.recovery.*` 账本命名空间、每条带 receipt 摘要，链校验对齐 saga 形态（detected → attempt* → disclosed? → resolved/degraded 吸收）；检测与合法性仍归 availability reducer（ADR-23）所有——本层是它的用户沟通与审计投影，非运行时激活 | ✅ run-all §65（离线 fixture；零真实供应商调用） |
| `ts/capabilities/hotelbyte-transaction.ts` `ts/scripts/hotelbyte-reconcile-tests.ts` `ts/scripts/hotelbyte-spawn-e2e-tests.ts` | **HotelByte 交易 bridge + unknown 查单对账契约**（issue #232，M5 备产）：按 `design/write-gate-production-design.md` §7 的纯函数对账状态机——book 执行分类（CLI exit0 非成功证明：超时/被杀/非 JSON/无绑定成功/部分确认一律归 unknown；显式业务失败归 supplier_failed）；对账种子 fail-closed（attemptId/customerReferenceNo/intent 幂等键/请求指纹缺一即拒；记录携带 fact_id/审批 receipt 摘要/outbox 占位可追溯，每条事件带 probeDigest）；恢复窗口（180s+600s）内 miss 保持 unknown 且结构性禁止重订；窗口届满本身不是无订单证明，只转人工；绑定 attempt 的权威终态负证据是唯一新 intent 闸门；同 ref 多单/参考号不匹配/终态反证显式置 conflict 交人工，不静默当成功也不静默丢弃；纯函数契约层本身零 spawn/网络/凭据，spawn 级完整链路 E2E（§5）只执行本地假 CLI fixture——非运行时激活 | ✅ run-all §60（离线 fixture；零真实供应商调用）；spawn 级 E2E 已落地：run-all §66（PR 待链） |
| `ts/capabilities/sponsor-plugin.ts` `ts/scripts/sponsor-reuse-tests.ts` | **sponsor 插件与同内核端到端复用证明面**（issue #235，M6 备产）：traveler principal/sponsor/BFF principal 三主体分离（标识缺失或混同构造即拒）；授权路由闭集 + session/order 绑定强制（全链无凭据字段，结构性排除复制 Buyer/credentials 规避）；运行激活默认关（`SPONSOR_RUNTIME_ACTIVATION_DEFAULT=false`，仅显式 opt-in，真实接线在 #137 M6 Entry 之后）；同内核复用 = 模块只 import 内核函数（`booking_saga_fsm.v1` 状态机 + wish-pool 条件评分，零拷贝零重声明，内核漂移即套件红），同一 runner 以「是否携带插件」参数化 B2C/B2B 两种形态，saga 边序列逐格相同；红线结构性编码：排序前内核条件全命中强制（佣金不可赎回未命中的旅行者条件，同分 tie 只按 sponsor 申报顺位且必须披露偏置）、披露摘要进入确认指纹、空 receipt 两种形态同拒、取消退款走同一内核边表；隔离：`ts/src/**` 零 sponsor-plugin 引用（C 端默认路径不动），B2C trace 过泄漏检查零发现 | ✅ run-all §64（离线 fixture；非运行时激活，零真实调用） |
| `ts/src/booking-surface/cancel-refund-commission.ts` `ts/scripts/issue-233-cancel-refund-commission-tests.ts` | **取消/退款独立结果与佣金披露契约层**（issue #233，M5-4 pre-entry，纯函数）：取消与退款是两个结果对象、状态封闭集互不重叠——无合并成功态，「取消已确认 + 退款失败/待到账/未知」的非对称终态是一等表达；`supplierReferenceNo` 只能由供应商返回值构造；`refunded` 绑定供应商退款/钱包退款权威证据；`cancel.serviceFee` 永不充当客户退款金额，只作单独披露；佣金/返利/赞助披露（谁付/给谁/金额口径；unknown 不默认 none；「明确无」须有合同规则记录来源）携带 canonical-JSON SHA-256 digest 绑入指纹字段 `commission_disclosure`——披露口径变化即旧 receipt 失效；机械分词闸保证账本分词与用户文案一致（480 组合矩阵） | ✅ run-all §62（纯契约——零供应商/支付调用面，不接线任何 runtime 路径） |
| `ts/src/bookable-facts.ts` | **可下单事实模型**（gotry_bookable_fact.v1，issue #46/ADR-19，纯函数）：事实 schema（route/exact local date/航班号/营销+实际承运/机场/价格/来源/query_id/置信 tier/bookability 四态）+ flyai/session 结果转换器（hit 正事实/miss 负事实/error 不落）+ IATA 归一 + 判定原语（claim 可述性 fail-closed/同日衔接硬约束/夜数·O&D·预算不变式/迂回检测）+ 渲染原语（codeshare 双承运/落 DMK 注记/不可售措辞/联程仅 protected_connection） | ✅ run-all §39 |
| `ts/src/artifact-gate.ts` `ts/capabilities/fact-log.ts` | **产物事实闸 + 事实侧车**（issue #46/ADR-19）：markdown 可下单 claim 反向抽取（航班号/承运直飞/中文承运名/机场映射/政策「截至」语境/✓/联程断言，小节上下文继承）→ 逐条回溯注册表（not_in_source/route_unqueried/时刻矛盾/价格矛盾/联程违例等）；第 21 工具 `gotry_fact_gate`，blocked 不得宣称已验证；fact-log 落 `<stateRoot>/gotry-state/bookable-facts.jsonl` 侧车（永不阻塞检索主路径） | ✅ run-all §39 + smoke §16 |
| `ts/src/itinerary-doc-shared.ts` | **行程文档共享契约层**（issue #564）：输入校验＋事实归一化＋事实/计划卡＋双面文案＋基础组件 CSS，从 itinerary-html.ts 原样抽取，作为两个文档投影的单一事实源（同一套校验或文案的第二份实现必然静默漂移——渲染器设计 §3 的既有推理）；字节上限与 LIMITS 共用 | ✅ run-all §6c/§6d（反漂移锁：两个投影的拒绝 errors 逐字节一致） |
| `ts/src/itinerary-html.ts` `ts/src/itinerary-deck.ts` | **单页 + deck 行程 HTML 渲染器**（#442 / #564）：调用方显式行程＋注册表选出事实的纯有界投影——共用同一 `normalizeDocInput`，零脚本、无远程资源、无算术；deck 幻灯页确定性派生（封面/按日期/每段/每住宿/证据，不接受调用方编排），纯 CSS scroll-snap 翻页；产品入口 `gotry_itinerary_render` 在 `ts/capabilities/itinerary-artifact.ts`（仅单页；deck 入口为后续切片） | ✅ run-all §6c/§6d |
| `data/airline-airports.json` `ts/data/golden-trip-2027-facts.json` | 航司→机场映射 + 城市→IATA 词表（gotry_airline_airports.v1，as_of 快照+review_by）：FD=DMK/VZ=BKK 冲突检测面，闸加载缺失即 fail-closed；golden fixture=issue #46 审计值锁定的 2027 行程事实集（11 查询）+ 好/坏行程不变式对 | ✅ run-all §39 |
| `ts/scripts/state-cli.ts` | **账本操作面**（ADR-15）：migrate/log/stats/rebuild/rewind/forget/pw-* 走集中 parser 后按 tenant scope 传给 StateLedger；未知/重复/缺值/非法 numeric（含 `.5`/`+.5`）fail-closed。export/tick/whatif 明确 local-only：分别会写共享 legacy 文件名、调用本地异步结算、生成整库管理员 snapshot（不是租户 export），非 local 在 mkdir/openDb/solve/write 前拒绝 | ✅ run-all §29；#241/#243 已入 main并关闭 |
| `ts/scripts/product-metrics.ts` `ts/data/product-metrics-fixture.json` + `ts/scripts/nightly-evidence.ts` `ts/data/m3-nightly-prompts.json` `ts/data/llm-price-table.json` | **M3 cohort 证据评分面 + nightly 证据生产器（Issue #22）**：阈值冻结 manifest + 脱敏 cohort/nightly schema + 定稿率/NPS/POI 幻觉率 scorer；fixture 与真实证据分流，未知字段 fail-closed；nightly 生产器封存 prompt 集与价表（peak 保守上界，未知模型 fail-closed）、无凭证 waiting/backoff/no-spend、超预算退 3，记录写入前必过消费方 parseNightlyRun | ✅ run-all §33/§35；真实 cohort 待收集，nightly 真跑记录待凭证环境执行 |
| `ts/scripts/time-eval-tests.ts` `data/time-slot-eval.json` | 时间感评测（25 题）：确定性部分进 CI，`--real` 真模型巡检（只读报告） | ✅ 真模型 25/25 |
| `data/golden_erhai.json` `flights_2026.json` `hotels_2026.json` `golden_trip_2026.json` `行程细化计划.docx` | 金标准用例/班期/住宿/完整任务/Kimi 对话原件 | — |
