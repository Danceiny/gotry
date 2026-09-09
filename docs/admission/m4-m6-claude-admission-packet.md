# M4→M6 Claude 准入包(2026-09-10,只读准备,无交易/B2B 启封)

> 工作面:docs worktree `docs/m4-m6-claude-admission-packet`,基线 `2ed5def`。
> 输入材料:`docs/design/write-gate-production-design.md`、`docs/design/milestone-delivery-plan.md`、`docs/milestones/m6-b2b-reuse-walkthrough.md`、issues #20/#22/#136/#137/#142/#231/#232/#233/#234/#235/#255 owner 评论(截至 2026-09-09)。
> 边界:**只读 admission/preparation handoff,不是 live trade/B2B 实现**;不允许写运行时代码、真实预订/支付/取消、凭证/UAT、npm 发布/tag、`#270` 治理文档。
> 准入事实(只读,不替 owner 声称已签/已授权):
> - #20/#22 真实 `observed_private` cohort 仍 `waiting_external_evidence`,M3/M4 Exit 未闭合;
> - #136 M5 Entry 供应链协议/Buyer/route/selector/字段/SLA/真实 UAT 范围未取得签署/内部授权证据;
> - #137 P6 founder 评审未取得 `YES`;
> - #255 P4 设计 watch tracker,触发前不实现。

## 0. 已存在工程/设计资产(代码与文档引用,不重复)

| 类别 | 引用 | 状态 |
|---|---|---|
| WriteGate proposal | `docs/design/write-gate-production-design.md`(§4 fingerprint、§5 状态机/执行序列、§6 adapter 准入矩阵、§7 unknown/query、§8 取消≠补偿≠退款、§10 佣金披露 digest 入 fingerprint、§12 验收矩阵 19 行,§14 Entry/Exit) | M5-1 已随 PR #249 入 main,proposal;§12 「派发否证执行口径」当前未执行 |
| M5/M6 任务图 | `docs/design/milestone-delivery-plan.md` §4(M5-0…M5-4)、§5(M6-0…M6-5)、§7 当前全局状态清单 | 已合入 |
| P6 B2B 复用推演纪要 | `docs/milestones/m6-b2b-reuse-walkthrough.md` §3 复用边界清单(基于 `d1d7b5a`)、§4 复用率实测口径(kernel-set/loaded-modules/路径 coverage)、§8 founder 审批模板 | draft,待评审 |
| Booking Copilot 14 套件 fixture | `ts/scripts/booking-copilot-{policy,ledger-binding,planner,core,runtime,startup,server,bin,dsh-plugin,dsh-planner,dsh-core,event-sequence-concurrency,operation-ledger-concurrency,receipt-ledger-concurrency,gap-code-contract,surface-contract}-proof-tests.ts` + run-all §49 | 已合入;只覆盖 booking-surface 工程链,不启封 M5 |
| tenant/state-cli 隔离基座 | #229/`ts/src/state-ledger.ts` insertEvent/readEvents/fold;`bin/state-cli*`;`scripts/state-cli-tests.ts` | #229/#236/#237/#241/#243 已入 main,#230 已 CLOSED |
| Z3 + dsh-map 稳定性 | `ts/src/z3/*`、`ts/scripts/dsh-map-tools*` | #227/#242 已 CLOSED |
| M3/M4 evidence chain | `ts/gotry-state/evidence/{m3,m4}/{manifest,summary}.json` + `paired-cohort.jsonl` schema;`ts/scripts/nightly-evidence.ts` | #223/#228/#238/#248 已合入;真实 cohort 仍 waiting |
| 异步工单回收 | `ts/scripts/async-collect.ts` + `ts/gotry-state/async/*.json` ↔ `workflow_runs` 账本 | 本 tick 0 待回收(目录空) |
| hbcli 桥(只读) | `ts/capabilities/hbcli.ts`;`staicli@0.0.3` 已发,integrity `sha512-xGzw6KBQ4r5l+...` | 只读,不可作交易边界 |
| M4→M6 收敛事实 | `docs/program/milestone-delivery-plan.md` §7 状态清单;`docs/roadmap.md` 三线并行表 | 已合入 |

> 结论:WriteGate proposal、M5/M6 任务图、P6 推演纪要、booking-copilot 工程链 fixture、tenant/state-cli 隔离、Z3/map 稳定性、M3/M4 evidence 链均已在仓。**当前确实没有启封 M5/M6 实现的 owner decision;离线合同/fixture 也不重复现有设计文档。**

## 1. owner 决策前置(M5/M6 双开闸,M5-0 协议矩阵)

| # | 决策项 | owner 输入 | 满足定义 |
|---|---|---|---|
| M4-Exit | 真实 `observed_private` N≥5 repeat cohort + paired median planning duration reduction ≥50% + reflux 真实分母 | founder | #20 acceptance 全部勾选 |
| M5-协议 | Buyer/tenantEntityId selector allowlist + session-order binding + mismatch reason code | founder + HotelByte | #136 owner 决策表 C/D/E/F/G/H/I/J 填齐 |
| M5-协议 | Distributor route + credential home(隔离) + 环境 + 路由 allowlist | founder + HotelByte | 同上 |
| M5-协议 | 报价有效期/取消/退款/佣金/售后字段 + 人工对账 SLA | founder + HotelByte | 同上 |
| M5-协议 | UAT 范围/预算上限/可撤销开关/紧急停止联系人 | founder + HotelByte | 同上 |
| P6 评审 | 整体方案 `YES 批准整体方案` 或对修改稿明确批准 | founder | #137 §8 任一选项明确勾选 |
| M6-pilot | 具名试点主体 + 范围 + 合同字段 + 签约证据 | sales/legal | #137 §0.7 + M6-5 |

owner 评论已多次强调:「未取得签署/内部授权证据 = TODO」;本 admission 包不替 owner 声称任何已签/已授权。

## 2. 允许的立即(pre-entry)工作:合同/read-only/fixture

下表严格按 #136(2026-09-09 13:01:07 UTC owner 评论)/#137(2026-09-09 13:01:13 UTC owner 评论)/#231/#232/#233/#234/#235 owner 评论中明确允许的工作面收敛:

| 任务 ID | 范围 | owner 输入依赖 | 验收 |
|---|---|---|---|
| A-1 | #231 §3/§5 字段在 ledger 表 schema 层的物理 CHECK 反证 fixture(空 receipt / 跨 tenant / 过期 nonce 漂移),**不触 supplier** | none(纯离线) | SQLite 行级拒绝证明;outbox 零行;不调 supplier |
| A-2 | #231 §5.5 外呼前重验(preflight)离线 fixture:quote 过期/digest 变更/路由变更/已撤回 → 旧 effect `rejected`,`pending_writes` 三态不变 | none(纯离线) | ADR-17 三态不变;零 supplier write |
| A-3 | #232 §6 adapter 准入矩阵 CLI source 维度的 offline fixture:钉 `staicli@0.0.3` integrity、help/version/exit 0/1 投影 | none(纯离线 npm view + 内存下载) | 不读真实凭证;不发业务网络 |
| A-4 | #232 §6 unknown/query 维度的 offline fixture:`timeout→miss→迟到 success` / `迟到 auto-cancel` / `窗口后 miss + 人工确认无单` 状态机投影 | none(纯状态机) | exit0 ≠ success;unknown 不重订 |
| A-5 | #233 §8/§10 cancel/refund/commission disclosure 离线 fixture:`pending→compensated` ≠ 退款;`cancel.serviceFee` ≠ refund;披露 digest 入 fingerprint;披露变化使旧 receipt 失效 | none(纯 schema) | 账本分词与文案分词一致 |
| B-1 | #234 §4 kernel-set.txt 冻结 schema/脚本、loaded-modules.json schema、预声明功能路径 coverage schema,**仅物化离线工具,不实现 sponsor plugin** | none | `git diff <base> -- $(cat kernel-set.txt)` 为空;零业务网络 |
| B-2 | #234 §4 runtime 实际加载 coverage 与预声明功能路径 coverage 离线 fixture:无 sponsor plugin 时跑 B2C 一次,记录 loaded modules 与路径覆盖 | none(纯 B2C) | 不引入 sponsor 类型;不改内核 |
| B-3 | #235 §5 复用的 offline failing-before fixture:traveler evidence 缺失 → `motivation_save` 拒绝;sponsor 库存注入跨 tenant → reject;sponsor 文案生成动机权重 → reject;wish pool conditions 被 sponsor 覆盖 → reject | none(纯离线) | 离线 failing-before,不证 traveler adoption |
| C-1 | #255 P4 设计 watch tracker 文档化入口(触发条件、样本、隐私、Notebook/Hot Context 所有权/过期/CAS/删除/导出、与 motivation/timeline/companion/ledger 的唯一写入权威、可否证价值指标) | none | 不实现 Notebook/Hot Context;founder 批准前只 watch |
| C-2 | #142 真实 UAT 边界核验:四 surface Chrome UI / Checkout / QueryOrders / unavailable-changed 恢复链 / reducer 五态迁移 各自所需证据模板(无内容,只清单) | founder 浏览器侧 | 不做 agent 不可代项 |

### 2.1 严格禁止(在 M5 Entry / M6 Entry / P6 评审 满足前)

- 任何真实预订/支付/取消/退改;
- 任何 HotelByte 凭证读取、UAT ONLINE book、OTP 读取或绕过;
- 任何 `ts/src/state-ledger.ts` 之外的可执行 supplier 写路径;
- 任何 `ts/src/model.ts`/`unified.ts` 内核改动(M6 复用面禁止);
- 任何 npm publish、git tag、`#270` 治理文档编辑、release notes 编辑。

### 2.2 owner 评论中已存在的协作约束

- #250 会修改 #231 的核心文件 `ts/src/state-ledger.ts`,在 #231 开工前 owner 会先独立审阅并决定合并或关闭;A-1/A-2 fixture PR 与 #250/#231 owner PR 的合并顺序由 owner 决定,本 admission 包不擅自合并。
- #136/#137 owner 多次声明 `#270` 治理/release notes 由 owner 编辑;本 worktree 不触。
- #142 gate ①(四 surface Chrome UI 真实库存)agent 不可代,需 founder 浏览器侧验;C-2 仅列模板不代做。

## 3. 有界排队任务包(bounded queued packet,待 owner 派工)

| 序 | 任务 | 责任人 | 入口 issue | 期望产物 | 真实证据依赖 | 完成判据 |
|---|---|---|---|---|---|---|
| Q-1 | A-1 + A-2 离线 SQLite 反证 fixture | Claude admission worktree | #231 | 独立 PR + run-all §xx 全绿 | none(纯离线) | SQLite 行级拒绝 + outbox 零行 + supplier write=0 |
| Q-2 | A-3 + A-4 hbcli 0.0.3 integrity 钉版本 + unknown/query 离线状态机 fixture | Claude admission worktree | #232 | 独立 PR + run-all §yy 全绿 | npm 0.0.3 integrity(只读) | 不读凭证,不发业务网络 |
| Q-3 | A-5 cancel/refund/commission 离线分词 fixture | Claude admission worktree | #233 | 独立 PR + run-all §zz 全绿 | none(纯 schema) | 账本/文案分词一致 |
| Q-4 | B-1 + B-2 kernel-set/loaded-modules/path coverage schema 物化 | m6-proof worktree | #234 | 独立 PR + 冻结分母 | origin/main baseline SHA | kernel-set diff=0;coverage 可复跑 |
| Q-5 | B-3 sponsor 离线 failing-before fixture(无 sponsor plugin) | m6-proof worktree | #235 | 独立 PR | none | B2C 离线失败点全部 reject |
| Q-6 | C-1 #255 P4 watch tracker 文档化入口 | design/memory | #255 | docs PR | none | 不实现 Notebook/Hot Context |
| Q-7 | C-2 #142 真实 UAT 证据模板 | founder | #142 | issue 评论模板 | none | 模板就位,founder 浏览器侧填 |
| W-1 | owner 决策表 #136(M5-0 C/D/E/F/G/H/I/J)+ #137 §8 + M4-Exit 三块 | founder | #20/#136/#137 | issue 评论 | 真实 cohort/协议/P6 YES | 任一决策明确勾选即解锁对应 Q-* |

W-1 是 owner-only 项,本 admission 包**不替 owner 决策**;Q-1…Q-7 是已允许的 offline contract/fixture 候选,可并行或串行,由 owner 派工。

## 4. 验收:本 admission 包是否完成

- [x] 不写运行时代码,不启封交易/B2B;
- [x] 不读凭证、不发业务网络、不读 OTP、不绕过全退政策;
- [x] 不编辑 `#270` 治理文档、不打 tag、不发 npm;
- [x] 不替他人在制品(`git status --short` 仅显示本 admission 包新增文件);
- [x] 不声称任何 owner 决策已闭合(仅陈述 owner 评论已存在的事实);
- [x] 不复制 fixture 冒充业务达标;不重复现有 design doc(指向现有文件);
- [x] 在 #136/#137 各发一条分配矩阵评论(owner 评论允许的 pre-entry 边界 + 有界排队包指针);
- [x] 产出 Draft PR(本 worktree `docs/m4-m6-claude-admission-packet`),分支/HEAD 与 SHA 留底;
- [x] 编号 TODO 公开:owner 决策表三块 + Q-1…Q-7 派工。

## 5. 编号 TODO(留在 PR/issue 评论上)

1. **TODO(owner)**:M4-Exit 真实 `observed_private` N≥5 repeat cohort + reflux baseline —— #20 acceptance 未闭合;
2. **TODO(owner)**:#136 M5-0 协议矩阵字段 C/D/E/F/G/H/I/J —— 未填具名值;
3. **TODO(owner)**:#137 §8 整体方案 `YES 批准` 或修改稿明确批准 —— 未取得;
4. **TODO(owner)**:M6-5 具名试点主体 + 范围 + 签约证据 —— 未取得;
5. **TODO(founder/浏览器)**:#142 四 surface Chrome UI 真实库存 + unavailable/changed 恢复链 + Checkout/QueryOrders/清理证据 + reducer 五态真库存迁移 —— agent 不可代;
6. **TODO(Q-1…Q-7)**:6 个允许的 offline contract/fixture 候选 —— 待 owner 派工与本 admission worktree/m6-proof worktree 提交独立 PR;
7. **TODO(Q-1/A-1 与 #250 顺序)**:#250 修改 `ts/src/state-ledger.ts` 与 #231 owner PR 的合并顺序 —— 由 owner 在 #231 开工前审阅决定;
8. **TODO(C-1)**:#255 P4 watch tracker 文档化入口 —— 不实现 Notebook/Hot Context,等真实使用/多用户触发与 founder 批准。

---

> 本 admission 包由 docs worktree `docs/m4-m6-claude-admission-packet`(基线 `2ed5def`)产出,纯文档,不触交易/B2B 启封;不替 owner 声称任何已签/已授权;不重复现有 design doc(指向 §0 现有文件);不在 #270 治理/release notes 落字。
