# M4→M6 交付计划与任务图(issue #225)

> 定位:把 M4→M5→M6 拆成可分 worktree 交付的 living program 任务图,逐项写明责任面、责任文件、依赖、交付物、最小 E2E、否证与退出标准。
> 状态:living(2026-09-08;issue #225。本文是计划与责任图,不替代 M3/M4/M5/M6 的 Exit 证据)
> 上游:[`../roadmap.md`](../roadmap.md)、[`../architecture.md`](../architecture.md) §1/§9/§10/§11、[`../gotry-master-outline.md`](../gotry-master-outline.md) §3.5/§3.7、issue #20/#22/#136/#137/#225/#223/#227/#228/#230/#231/#232/#233/#234/#235/#241/#242。
> 下游:独立 Claude Code worktree 任务、架构复验、PR 描述与贡献闸。

## 0. 速览

1. **当前 program 总状态:TODO**。M3 真实 seed cohort 未闭合;M4 真实 `observed_private` N≥5 repeat cohort 未到;M5/M6 Entry gate 均未满足。
2. **状态只用 DONE/TODO**;阻断原因写在任务块的“阻断/依赖”字段。
3. **基座代码状态不是 Exit 证据**:tenant ledger scope(#229)+ fold 回归钉住(#237)与 state-cli 租户边界(#236)代码已进入 main;ledger 租户验收 #230 已关闭;#241/PR243(606d1d2)补 CLI `.5`/`+.5` 小数边界,但当前 main 的 #236 尚无该补丁。基座最终集成验收仍等 #227/#242 与新 SHA 全栈证据。
4. **仍 open 的首批工程/基线阻断**:#227 Z3 Node24 间歇 heap corruption;#242 dsh-map-tools map 回归;#223 M4 scorer 硬阈/隐私;#228 显式 opt-in planning lifecycle 采集/脱敏导出。
5. **M5 首供应链**:`hotelbyte-cli`(公开 MIT CLI;hotel-be 内部资产只 bridge/reference,不复制代码)。供应链协议尚未取得签署/授权证据;当前为只读接口调查与契约准备。
6. **M5 Entry 为两项**:M4 Exit + 供应链协议。WriteGate 设计可推进;交易实现、真实 book/cancel/refund/UAT 在 Entry 未满足前保持 TODO。
7. **M6 只到 draft + proof 口径**:[`../milestones/m6-b2b-reuse-walkthrough.md`](../milestones/m6-b2b-reuse-walkthrough.md) 仍待 founder 评审;零内核 diff 是工程指标,不是 traveler 效果代理。
8. **基线稳定性债务**:#227/#242 未闭合前,相关 PR 保持 draft;一次 run-all 绿不能闭合间歇性 Z3 问题或地图回归。

## 1. 依赖图(不制造管理步骤)

```text
#227 Z3 基线稳定性 ─┬─> 所有本轮 PR 合并复验门
#242 dsh-map-tools map 回归 ─┤
                         └─> PR 保持 draft,一次 run-all 绿不能闭合

M3 real cohort (#22) ─┐
                     ├─> M3 Exit ─> 正式 M4 Entry
M4 scorer hardening (#223) ─┐
M4 opt-in lifecycle export (#228) ─┼─> real observed_private repeat cohort N≥5 (#20) ─> M4 Exit
M4 reflux baseline ────────────────┘

M4 Exit + hotelbyte-cli 供应链协议 (#136) ─> M5 WriteGate(#231) + HotelByte adapter(#232) + cancel/refund(#233) ─> M5 Exit
tenant ledger 代码在 main(#229/#237,验收#230 已关闭) + state-cli 代码在 main(#236) ─┐
CLI 小数边界补丁 #241/PR243(606d1d2,待主线集成) ──────────────────────────────┤
M5 Exit + P6 founder review (#137) ───────────────────────────────────────┴─> M6 proof(#234) + sponsor plugin(#235) ─> M6 Exit(含试点签约)
```

## 2. 任务索引(≤5列)

| ID | 状态 | Issue | 责任面 / worktree | 主要阻断或下一证据 |
|---|---|---|---|---|
| B-1 | TODO | #227/#242 | 基线修复线 | Z3 Node24 间歇 heap corruption + dsh-map-tools map 回归;相关 PR 保持 draft |
| B-2 | TODO | #241/PR243 | state-cli 集成线 | CLI `.5`/`+.5` 小数边界补丁 606d1d2 待主线集成;当前 main #236 尚无该补丁 |
| M4-1 | TODO | #223/#20 | `m4-scorer-hardening` | scorer 固定 N≥5/≥50% + HMAC/strict schema;依赖 #227/#242 |
| M4-2 | TODO | #228/#20 | `m4m6-collector-20260908` | 显式 opt-in lifecycle 采集/脱敏导出;依赖 #223 + #227/#242 |
| M4-3 | TODO | #20 | 证据责任面 | 真实 `observed_private` N≥5 repeat cohort + reflux baseline |
| M5-0 | TODO | #136 | supply/legal + adapter 责任面 | hotelbyte-cli 协议核验;协议未取得签署/授权证据 |
| M5-1 | TODO | #225/#136 | docs/program-225 | WriteGate proposal 入仓;#227/#242 未闭合保持 draft |
| M5-2 | TODO | #231 | m5-core worktree | 持久化可信审批与原子 outbox;M5 Entry 后实现 |
| M5-3 | TODO | #232 | m5-adapter worktree | hotelbyte-cli trade adapter、unknown/query/reconcile |
| M5-4 | TODO | #233 | m5-refund worktree | cancel/refund/wallet outcome + commission/披露 |
| M6-0 | TODO | #229/#237/#230 | ledger 集成线 | 代码在 main;最终集成验收等 #227/#242 + 新 SHA 全栈证据 |
| M6-0b | TODO | #236/#241 | state-cli 集成线 | #236 在 main;#241/PR243 小数补丁待主线集成与新 SHA 验证 |
| M6-1 | TODO | #225/#137 | docs/program-225 | P6 draft proof 口径;#227/#242 未闭合保持 draft |
| M6-2 | TODO | #137 | founder review | P6 评审;不得由工程自行 frozen |
| M6-3 | TODO | #234 | m6-proof worktree | kernel-set / loaded-modules / runtime trace schema 与生成脚本 |
| M6-4 | TODO | #235 | m6-plugin worktree | M5 Exit + P6 review 后的 sponsor plugin E2E |
| M6-5 | TODO | #137 | sales/legal | B2B 试点签约/商业条件;仍属 M6 Exit,不能移出 |
| Q-1 | TODO | #225 | docs/program-225 | 贡献文档/PR 模板修正;#227/#242 未闭合保持 draft |

## 3. M4 任务块

### M4-1 — #223 scorer 硬阈值与隐私

- **输入**:`ts/scripts/memory-value-report.ts` 当前反例:输入可降 `minimum_pair_count_for_exit`/`target_median_reduction_ratio`;`subject_ref` 非 HMAC;未知字段未拒。
- **责任文件**:`ts/scripts/memory-value-report.ts`;`ts/data/memory-value-fixture.json`;必要状态面。
- **输出**:固定 N≥5、paired median reduction≥50%;target 比较使用未舍入 ratio,展示才 round;observed_private 身份和关联引用仅 HMAC-SHA256;strict nested schema 与日历合法性;synthetic/candidate 永不 Exit;manual source attestation 必须绑定本次评分 payload digest;错误/stdout/stderr 不反射秘密、畸形 JSON 片段或私有路径。
- **最小 E2E**:先跑反例得到旧 `exit_ready=true`;修后正例/负例/CLI 同跑,隔离输入文件。必须含 exact 50% 正例、49.999975% 未达负例、`2026-02-30T00:00:00Z` 非法日期负例、manual attestation payload digest 变更负例、畸形 JSON privacy sentinel 不回显、多个 preference assertion 共享同一 evidence_ref 的合法正例。
- **否证**:一 pair + target=0 仍 pass;49.999975% 被 round 成达标;明文 email/嵌套未知字段/合成 sentinel 被接受或回显;旧 attestation 覆盖变更后的 pairs;`evidence_ref` 被错误强制一对一。
- **退出标准**:#223 验收全过,最终 SHA tsc/run-all/CLI E2E;不关闭 #20;受 #227 合并复验门约束。

### M4-2 — #228 显式 opt-in planning lifecycle 采集/脱敏导出

- **输入**:#228;M4-1 固定后的 scorer 合同;`memory-design.md` §7。
- **责任文件**:新增显式观测 CLI/纯逻辑模块(由 #228 PR 定);git-ignored `ts/gotry-state/evidence/m4/` 只作私有输出。
- **输出**:记录首访/下一次 eligible completed flow、开始/结束、预声明等待代码及等待边界;HMAC 假名 subject/flow/pair/experience/assertion/evidence;导出 candidate 或 synthetic,不生成 manual attested。
- **最小 E2E**:隔离 stateRoot:opt-in on 采两次 eligible flow + wait → export → #223 scorer 可读;opt-in off/缺 consent/缺 HMAC key 零写。
- **否证**:默认产品会话被采集;扫描历史 wish/motivation 日志推 cohort;完成后修改等待;导出含 PII/URL/token。
- **退出标准**:#228 验收全过;真实 N≥5 仍留 M4-3;依赖 #223 合同与 #227 稳定性。

### M4-3 — #20 真实 repeat cohort 与 reflux baseline

- **输入**:M4-2 导出器;真实用户知情同意;HMAC salt/key 私有保存。
- **责任文件**:私有 `ts/gotry-state/evidence/m4/manifest.json`、`paired-cohort.jsonl`、`summary.json`;公开只提交脱敏 summary 或 issue 状态。
- **输出**:N≥5 同一用户首访/回访 eligible completed planning pair;active planning duration 扣预声明 waits;experience reflux baseline = verified/recalled,每条 verified 有 recalled 与 evidence_ref。
- **最小 E2E**:私有副本跑 scorer,summary 报 eligible_pair_count、p50 reduction、reflux 分母。
- **否证**:N<5;样本非 repeat;wait 事后补填;fixture 当 baseline;人工无法追溯 consent。
- **退出标准**:#20 M4 paired cohort 口径满足;未达则保留编号缺口。

## 4. M5 任务块(首供应链 hotelbyte-cli)

### M5-0 — #136 HotelByte 供应链协议核验

- **版本与发布物(区分三者,详见 [`write-gate-production-design.md`](write-gate-production-design.md) §2)**:
  - hotel-be 内部参考快照 `16467805bb454df89fc894a7823da674348566e3`(只 bridge/reference,不复制代码)。
  - CLI gitlink 旧源码 `d62030bb9c132e5797e07371c5af0d2b97fdb819`/`staicli@0.0.2` 为历史快照,不作当前发布物依据。
  - CLI 0.0.3 发版 commit `41b5c1a8cc85f736aed753705c8c4b83b7666b4a`;当前 master `e3bae224d8cee0bb34795198eafcf689a1620df6` 含 PR #13 但 npm tarball 不含。
  - 实际发布物 npm `staicli@0.0.3`(integrity `sha512-xGzw6KBQ4r5l+...`);adapter 须钉此发布物,不硬绑 master。
  - GoTry main `2626167` bootstrap 默认要求 `hbcli>=0.0.3`,仅安装检查,不证明 trade 鉴权。
- **真实接口(当前调查,未等于协议)**:
  - `search hotel-rates` → `/api/search/hotelRates`,返回/保存 `sessionId`、`ratePkgId`。
  - `search check-avail` → `/api/search/checkAvail`;可用 `status=1`;必须保留原币种金额、取消政策、报价来源。
  - `trade book` → `/api/trade/book`;需 `sessionId`/`ratePkgId`/`holder`/`guests`;后端校验 session 缓存 CheckAvail。
  - `trade query-orders --customer-reference-nos` → `/api/trade/queryOrders`;权限过滤后的平台订单查询,OpenAPI 用户不能 supplier 穿透。
  - `trade cancel` → `/api/trade/cancel`;需 `customerReferenceNo` + 响应给客户的 `supplierReferenceNo`;CLI 没有 refund 命令。
- **未证前提 / TODO**:
  - 协议未取得签署/授权证据:Buyer、环境、供应路由、佣金/售后字段、人工对账 SLA、真实 UAT 范围待核验。
  - portal 优先未修复:npm 0.0.3 与 master 仍优先可用 portal 票,无 endpoint 级 OpenAPI 身份选择;0.0.3 只跳过 stored-ticket 占位并 fallback,不能称强制 OpenAPI。隔离 credential home + 固定 Buyer/环境仍必要。
  - 读鉴权重试不得复用于交易:master 401 清票重试仍可能再选 portal,audience 选择未修复。
  - `customerReferenceNo` 不是永久幂等:后端以 Buyer+ref 重用在途/成功单,Cancelled/Failed 允许同 ref 再建;同授权 intent 只绑定不可变 attempt,新订单须新授权。
  - 30s CLI abort + 长恢复窗口(180s Phase1 再最长 10min Phase2,迟到订单可自动取消):timeout/进程退出/非 JSON = unknown,先查单并遵守恢复窗口。
  - 无通用 selector:当前 CLI/后端未找到 `tenantEntityId`/`DistributorOption`;M5 首接只能固定一个授权 Buyer/供应路由,M6 或多 route 前必须上游提供真实 selector + session/order 绑定 + 错配拒绝。
  - `supplierReferenceNo` 可能是平台订单号不得自行解码;`cancel.serviceFee` 不是客户退款金额;订单/取消/退款单/钱包退款是不同 outcome。
  - UAT ONLINE Book 有 OTP/全退政策要求,CLI 无 test/OTP 通道;不得绕过、不读 OTP、不做真实交易。
  - 现有 GoTry 只读 `ts/capabilities/hbcli.ts` 桥不可复用为交易边界(spawn 继承 `process.env`、超时 SIGKILL、读失败静态回退);交易 adapter 必须新建受控 env/credential home/identity boundary。
- **退出标准**:供应链协议/字段/UAT 范围可逐项打勾;未满足则 M5 Entry 关闭。

### M5-1 — WriteGate proposal 入仓

- **责任文件**:[`write-gate-production-design.md`](write-gate-production-design.md)。
- **输出**:可信 receipt 发行/消费权威、request fingerprint、approval_claims 持久化、本地 outbox intent(不宣称外部 exactly-once)、HotelByte unknown/query miss/对账/补偿/披露矩阵与准入矩阵。
- **最小 E2E**:文档链接/路径检查;六状态面引用一致。
- **否证**:文档暗示 M5 已开闸;把 outbox 写成外部 exactly-once;query miss 在恢复窗口内变 reconciled_failed;receipt 接受客户端/模型拼装;遗漏 HotelByte 30s/unknown/query-orders/Buyer/selector/OTP/portal 优先缺口。
- **退出标准**:PR 合入后成为 M5 实现前设计输入;#227/#242 未闭合保持 draft。

### M5-2 — #231 持久化可信审批与原子 outbox

- **前置**:M5 Entry 两项(M4 Exit + 供应链协议)均满足;M5-1 proposal accepted。
- **责任文件**:`ts/src/state-ledger.ts`;`ts/src/booking-saga.ts`;`ts/capabilities/effect.ts`;`approval_claims` 表;必要 docs/tests。
- **输出**:nonce/fingerprint 在呈现前由服务端准备为 `PreparedChallenge` 并绑定不可变请求;receipt 发行与消费通道只接受可信宿主 UI 确认回调(带 actor/tenant/seam/challenge),模型只能请求展示,模型发起确认被拒且无 outbox;`approval_claims(receipt_id PRIMARY KEY, challenge_id, nonce_digest UNIQUE, consumed_at)` 与 `pending_writes` 状态转移、outbox intent 同一 SQLite 事务;顺序为准备/呈现 → 可信确认 → 原子消费 + outbox;跨 intent 重放同一 receipt/nonce/challenge 返回 `approval-claimed`。
- **保证口径**:本地保证是“同一 ledger intent 只消费一次并只登记一个 write effect intent”;外部副作用是否重复依赖供应商幂等/可查重;unknown 禁止盲重试。
- **最小 E2E**:并发双确认只有一个 claim/outbox;同一合法 actor + 合法 snapshot 下模型发起确认被拒且无 outbox,真人回调才授权;prepared challenge 直接消费被拒;receipt 过期/金额/币种/条款/presentation_key/nonce 变化 fail-closed;确认后改 fingerprint 被拒;崩溃注入覆盖 claim 消费/outbox/pending 转移三种顺序;跨 intent 重放同一 receipt 被拒。
- **否证**:可绕过 WriteGate 直调 supplier;空 receipt confirmed;nonce 未持久化或呈现后才生成;模型工具调用被当人类确认;prepared challenge 被消费;崩溃后重复登记 write effect intent;客户端自带 receipt_id 被接受。
- **退出标准**:fixture/sandbox E2E + run-all;真实 supplier effect 仍等 M5-3。

### M5-3 — #232 hotelbyte-cli trade adapter + unknown/query/reconcile

- **前置**:M5-0 协议字段可得;M5-2 core 就绪。
- **责任文件**:新增 hotelbyte-cli trade adapter(文件由实施 PR 定);adapter tests;reconciliation docs。
- **输出**:钉 npm `staicli@0.0.3` 发布物(integrity 见 M5-0)而非 master;隔离 credential home;受控 env;固定全局 flags 前缀;强制 `customerReferenceNo`;book result.status `verified|pending|failed` 投影;unknown → `query-orders` 或 manual reconcile;query miss 在恢复窗口内保持 unknown。
- **最小 E2E**:fixture CLI:book verified/pending/failed/timeout/non-json/exit0-but-pending/query success/窗口内 miss/迟到 success/迟到 auto-cancel;断言 exit0 不等于 success,unknown 不重订,窗口内 miss 不变 reconciled_failed。
- **否证**:并发重订同一授权 intent;把 CLI 30s abort 当 failed;窗口内 miss 变 reconciled_failed 再重订;不查单直接补偿;credentials 或 Buyer 路由来自用户全局环境;读鉴权重试策略无条件复用于交易。
- **退出标准**:adapter 通过 fixture/sandbox 与真实 UAT gate;未签协议或无 UAT 时保持 TODO。

### M5-4 — #233 cancel/refund/wallet outcome + commission/disclosure

- **前置**:M5-3;供应商取消/退款/钱包恢复字段核验。
- **责任文件**:cancel/refund outcome 投影;透明卡片/审计报告;tests。
- **输出**:pending cancel 与 confirmed compensation 分词;`trade cancel` receipt、退款单、钱包退款、手续费、客户退款金额分开投影;佣金/赞助/售后责任在确认前披露并纳入 fingerprint。
- **最小 E2E**:pending cancel 不写 refund;confirmed cancel 成功但钱包退款 pending;serviceFee 不当客户退款;披露变化使旧 receipt 失效。
- **否证**:账本 `compensated` 无条件显示钱已退;把 `cancel.serviceFee` 当 refund;披露在下单后才出现或未知默认无佣金。
- **退出标准**:补偿/披露矩阵全过;单位经济实测另属 M5 Exit。

## 5. M6 任务块

### M6-0 — #229/#237 tenant ledger 隔离(代码已入 main;集成验收 TODO)

- **状态**:TODO。tenant scope 修复(#229)与 fold 回归钉住(#237)代码已合入 main;验收 #230 已关闭。基座整体集成仍受 #227/#242 阻断,M6 sponsor proof 须在新 SHA 上引用其证据。
- **输出**:`insertEvent` 写当前 tenant;`readEvents`/fold/rebuild 全带 tenant 条件;legacy/v1 只迁入 `local`;跨租户同 id/idem_key 不覆盖;已误写为 `local` 的非 local 历史事件不自动猜修。
- **否证(已钉住)**:tenant A 读到或重建 tenant B 投影;去掉 fold 查询 `tenant_id` 后负向变体不能稳定失败。
- **退出标准**:新 SHA 全栈/稳定性证据可引用其 SHA/PR 证据;#227/#242 未闭合前仍是集成验收 TODO。

### M6-0b — #236/#241 state-cli 租户与小数边界(代码分批;集成验收 TODO)

- **状态**:TODO。state-cli 严格解析代码已合入 main(#236);#241/PR243(606d1d2)补 CLI `.5`/`+.5` 小数边界,但当前 main 的 #236 尚无该补丁。最终集成验收仍等主线合入与 #227/#242 新 SHA 证据。
- **输出**:`state-cli` 集中解析 cmd/positional/`--state-root`/`--tenant`/`--limit`;未知/重复/缺值/非法 numeric 先于 state-root 副作用 fail-closed;`tick`/`export`/`whatif` 明确 local-only;`--tenant` 仅为账本 scope,不构成认证授权。
- **否证(待集成钉住)**:`rebuild -1`/`rebuild 1.5`/`rebuild .5`/`rebuild +.5` 被当 root;flag 值成为业务参数;非 local tick/export/whatif 产生文件变化。
- **退出标准**:#236 与 #241/PR243 同在主线后,在新 SHA 上复跑 state-cli/全栈证据。

### M6-1 — P6 draft proof 口径改进

- **责任文件**:[`../milestones/m6-b2b-reuse-walkthrough.md`](../milestones/m6-b2b-reuse-walkthrough.md)。
- **输出**:traveler principal/sponsor/BFF principal 分词;把“单点已证明/构造性隔离”校准为 PoC 假设;复用 proof 需要基准 SHA、core 文件集合、core diff、runtime trace、功能路径覆盖;tenant 对抗;披露插件 proposal;P6 founder review 与试点签约保留在 M6 Exit。
- **最小 E2E**:文档链接/路径检查。
- **否证**:宣称 frozen/通过评审;靠 LOC 复用率;用 sponsor 收益覆盖 traveler 动机;把商业试点移出 M6 Exit。
- **退出标准**:PR 合入后仅作为 P6 评审底稿;#227/#242 未闭合保持 draft。

### M6-2 — #137 P6 founder review

- **输入**:M6-1 draft;商业目标;旅行社/目的地候选。
- **输出**:评审记录明确 yes/no/修改项;披露插件形态;B2B 主/辅形态;复用 proof 公式是否 accepted。
- **否证**:工程自行宣告 P6 exit;未评审即实现。
- **退出标准**:P6 exit 才成立;M6 Entry 仍等 M5 Exit。

### M6-3 — #234 复用 proof schema 与生成脚本

- **责任面**:m6-proof worktree,提前冻结分母,避免实现者临时发明。
- **责任文件**:新增 proof schema/脚本/fixture(由实施 PR 定);更新 P6/roadmap。
- **输出**:`kernel-set.txt`;`loaded-modules.json`;runtime trace schema;功能路径覆盖表;LOC 只作附属数字。
- **最小 E2E**:B2C planning run 生成 baseline loaded modules;fixture sponsor run 生成 trace;脚本拒绝未执行模块、docs/tests/node_modules/vendor 进入分母。
- **否证**:放宽 kernel-set 藏改动;死代码计入复用;未覆盖事实闸/WriteGate/async 却计入分子。
- **退出标准**:M6 sponsor plugin proof 前有可复跑分母。

### M6-4 — #235 sponsor plugin proof

- **前置**:M5 Exit + M6-2 P6 review + M6-0 tenant 隔离证据 + M6-3 proof schema。
- **输出**:旅行社嵌入全链:traveler 动机访谈→同 MotivationProfile/constraints→sponsor inventory→透明卡片含披露→可证明零内核 diff。
- **最小 E2E**:隔离 tenant/stateRoot 跑 sponsor plugin;`git diff <baseline> -- <kernel-set>` 为空;runtime module list 覆盖分母;tenant/sponsor 对抗通过。
- **否证**:改 `model.ts`/`unified.ts`/核心卡片 schema 才跑通;BFF principal 当 traveler;tenant A 注入 B sponsor 库存。
- **退出标准**:工程 proof 数字形成;不声称 traveler adoption 或商业效果。

### M6-5 — #137 试点商业条件/签约

- **责任面**:sales/legal。
- **输出**:试点签约或明确未签原因;商业收益与 traveler 价值分栏报告。
- **否证**:口头意向冒充签约;把 sponsor conversion 当 traveler motivation uplift。
- **退出标准**:M6 Exit 的商业半面有真实证据;未签则 M6 仍 TODO。

## 6. 开源质量任务块

### Q-1 — 贡献闸文档修正

- **责任文件**:`../../CONTRIBUTING.md`;`../../.github/pull_request_template.md`;`../../README.md`。
- **输出**:最终 SHA 本地 `cd ts && npx tsc --noEmit` + `GOTRY_SESSION_LIVE=0 ./scripts/run-all-tests.sh` 是必填;CI 只补充;E2E 行必填;语义/架构/维护兼容/六状态面自查;不宣称 GitHub 分支保护已生效。
- **最小 E2E**:文档链接/路径检查 + stale 节号/“CI 可替代本地证据”搜索。
- **否证**:PR 仍允许只贴 CI;模板缺 E2E;继续写死 `§1–49` 等计数;声称 branch protection 已配置。
- **退出标准**:新 PR 可按模板给出可复验证据;#227/#242 未闭合保持 draft。


## 7. 当前全局状态清单

1. TODO:#227 Z3 Node24 间歇 heap corruption;相关 PR 保持 draft,不能用一次 run-all 绿闭合。
2. TODO:#242 dsh-map-tools map 回归;这是独立于 #227 的主线基座阻断。
3. TODO:#223 M4 scorer 硬阈值、隐私与 schema 封闭修复。
4. TODO:#228 显式 opt-in M4 planning lifecycle 本地采集与脱敏导出。
5. TODO:#20 真实 `observed_private` N≥5 repeat cohort 与 reflux baseline。
6. TODO:#136 HotelByte 供应链协议、Buyer/环境/路由、字段、人工对账与 UAT 核验(协议未取得签署/授权证据)。
7. TODO:#231 M5 Entry 后可信审批 receipt + 原子 outbox core。
8. TODO:#232 M5 HotelByte trade adapter unknown/query/reconcile。
9. TODO:#233 M5 cancel/refund/wallet outcome 与 commission/disclosure。
10. TODO:#229/#237 tenant ledger 隔离 + fold 回归代码已合入 main;验收 #230 已关闭,最终集成证据等 #227/#242 + 新 SHA 全栈。
11. TODO:#236 state-cli 租户边界代码已合入 main;#241/PR243(606d1d2)补 CLI `.5`/`+.5` 小数边界但待主线集成,最终集成证据等 #227/#242 + 新 SHA 全栈。
12. TODO:#137 P6 founder 评审。
13. TODO:#234 M6 复用 proof schema/生成脚本。
14. TODO:#235 M6 sponsor plugin 零内核 diff + runtime trace proof。
15. TODO:#137 B2B 试点商业条件/签约。

## 8. 明确不做

- 不用 fake cohort、synthetic fixture、历史 wish/motivation 日志反推 Exit。
- 不改 M4/M5/M6 Exit 定义来绕过真实 cohort、供应链协议、P6 founder review 或试点签约。
- 不实现生产预订/支付/退改;M5 Entry 未满足前,WriteGate 只停在 proposal。
- 不把 B2B sponsor 收益、tenant 对抗或内核复用率当成 traveler 动机价值证据。
- 不把 CI、徽章、未生效分支保护或模板文案当作本地最终 SHA 证据。
- 不复制 hotel-be 内部代码;HotelByte 只能经公开 MIT `hotelbyte-cli`、子进程 bridge 与供应链协议进入 GoTry。