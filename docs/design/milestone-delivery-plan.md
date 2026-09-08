# M4→M6 交付计划与任务图(issue #225)

> 定位:把 M4→M5→M6 拆成可分 worktree 交付的 living program 任务图,逐项写明责任面、责任文件、依赖、交付物、最小 E2E、否证与退出标准。
> 状态:living(2026-09-08 建立;2026-09-09 follow-up 收紧 #231/#232 派发设计并同步已入 main 事实;issue #225。本文是计划与责任图,不替代 M3/M4/M5/M6 的 Exit 证据)。本次 follow-up 在 M5-1/M5-2/M5-3 写入原子 claim + 调用前持久化 `dispatching`/immutable attempt id/fencing、tenant-scoped claim/fold/query、外呼前重验、`RequestFingerprint` 绑定 holder/guests supplier payload digest 及未来最小否证(均未执行);并同步 #238/#243/#244/#245/#248/#240 已入 main、#227/#241/#242 已关闭。
> 上游:[`../roadmap.md`](../roadmap.md)、[`../architecture.md`](../architecture.md) §1/§9/§10/§11、[`../gotry-master-outline.md`](../gotry-master-outline.md) §3.5/§3.7、issue #20/#22/#136/#137/#225/#223/#227/#228/#230/#231/#232/#233/#234/#235/#241/#242。
> 下游:独立 Claude Code worktree 任务、架构复验、PR 描述与贡献闸。

## 0. 速览

1. **当前 program 总状态:TODO**。M3 真实 seed cohort 未闭合;M4 真实 `observed_private` N≥5 repeat cohort 未到;M5/M6 Entry gate 均未满足。
2. **状态只用 DONE/TODO**;阻断原因写在任务块的“阻断/依赖”字段。
3. **基座代码状态不是 Exit 证据**:tenant ledger/fold/state-cli、Z3/map 稳定性、M4 scorer(#238)与 opt-in lifecycle collector(#248)均已进入 main;#227/#241/#242 已关闭。工程基座已验证不替代真实 cohort、供应协议/内部授权、P6 批准或试点签约。
4. **仍 open 的真实门与实现任务**:#20/#22 真实 cohort、#136 供应协议/内部授权、#137 P6 批准与真实试点均为 TODO;#231/#232/#233/#234/#235 仅在各自 Entry 后实现。
5. **M5 首供应链**:`hotelbyte-cli`(公开 MIT CLI;hotel-be 内部资产只 bridge/reference,不复制代码)。当前未取得供应协议签署/内部授权证据;仅进行只读接口调查与契约准备。
6. **M5 Entry 为两项**:M4 Exit + 供应链协议。WriteGate 设计可推进;交易实现、真实 book/cancel/refund/UAT 在 Entry 未满足前保持 TODO。
7. **M6 只到 draft + proof 口径**:[`../milestones/m6-b2b-reuse-walkthrough.md`](../milestones/m6-b2b-reuse-walkthrough.md) 仍待 founder 评审;零内核 diff 是工程指标,不是 traveler 效果代理。
8. **基线稳定性已收口**:#227 在集成候选上通过 Node24 typecheck、3×240、full 与 CI 后合入并关闭;#242 修复也已入 main并关闭。

## 1. 依赖图(不制造管理步骤)

```text
Z3/map 集成基座(#227/#242,均已关闭) ─> 后续实现仍在各自最终 SHA 运行本地门

M3 real cohort (#22) ─┐
                     ├─> M3 Exit ─> 正式 M4 Entry
M4 scorer hardening (#223,工程加固 #238 已入 main) ─┐
M4 opt-in lifecycle export (#228,collector #248 已入 main) ─┼─> real observed_private repeat cohort N≥5 (#20) ─> M4 Exit
M4 reflux baseline ────────────────┘

M4 Exit + hotelbyte-cli 供应链协议 (#136) ─> M5 WriteGate(#231) + HotelByte adapter(#232) + cancel/refund(#233) ─> M5 Exit
tenant ledger 代码在 main(#229/#237,验收#230 已关闭) + state-cli 代码在 main(#236) ─┐
CLI 小数边界补丁 #241/PR243(已入 main 7a7f271,issue #241 已关闭) ───────────────┤
M5 Exit + P6 founder review (#137) ───────────────────────────────────────┴─> M6 proof(#234) + sponsor plugin(#235) ─> M6 Exit(含试点签约)
```

## 2. 任务索引(≤5列)

| ID | 状态 | Issue | 责任面 / worktree | 主要阻断或下一证据 |
|---|---|---|---|---|
| B-1 | DONE(入 main) | #227/#244/#245 | 基线修复线 | 集成候选通过 Node24 typecheck、3×240、full 与 CI;merge tree 等价,#227 已关闭 |
| B-2 | DONE(入 main) | #241/#243 | state-cli 集成线 | CLI `.5`/`+.5` 小数边界已合入 main并关闭 |
| M4-1 | DONE(入 main) | #223/#238 | `m4-scorer-hardening` | scorer 固定 N≥5/≥50% + HMAC/strict schema 已入 main;真实 cohort 仍在 M4-3 |
| M4-2 | DONE(入 main) | #228/#248 | `m4m6-collector-20260908` | 显式 opt-in lifecycle 采集/脱敏导出已入 main;仅生成 candidate/synthetic |
| M4-3 | TODO | #20 | 证据责任面 | 真实 `observed_private` N≥5 repeat cohort + reflux baseline |
| M5-0 | TODO | #136 | supply/legal + adapter 责任面 | hotelbyte-cli 协议核验;未取得签署/内部授权证据 |
| M5-1 | TODO | #225/#136 | docs/program-225 | 本 follow-up PR 合入后成为 WriteGate 实现前设计输入;不启封交易 |
| M5-2 | TODO | #231 | m5-core worktree | 持久化可信审批与原子 outbox;M5 Entry 后实现 |
| M5-3 | TODO | #232 | m5-adapter worktree | hotelbyte-cli trade adapter、unknown/query/reconcile |
| M5-4 | TODO | #233 | m5-refund worktree | cancel/refund/wallet outcome + commission/披露 |
| M6-0 | DONE(入 main) | #229/#237/#230 | ledger 集成线 | tenant ledger/fold 代码及验收已入 main |
| M6-0b | DONE(入 main) | #236/#241/#243 | state-cli 集成线 | tenant CLI 与小数边界已入 main并关闭 |
| M6-1 | TODO | #225/#137 | docs/program-225 | 本 follow-up PR 合入后提供 P6 审批底稿;founder 尚未批准 |
| M6-2 | TODO | #137 | founder review | 仅 founder 明确 YES 批准整体方案或批准修改稿才满足 P6 Exit |
| M6-3 | TODO | #234 | m6-proof worktree | kernel-set / loaded-modules / runtime trace schema 与生成脚本 |
| M6-4 | TODO | #235 | m6-plugin worktree | M5 Exit + P6 founder 批准后的 sponsor plugin E2E |
| M6-5 | TODO | #137 | sales/legal | B2B 试点签约/商业条件;仍属 M6 Exit,不能移出 |
| Q-1 | DONE(入 main) | #225/#240 | docs/program-225 | 贡献闸文档已随 #240 入 main |

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
- **输出**:可信 receipt 发行/消费权威、request fingerprint(绑定实际 supplier request canonical payload digest 或既有 `payload_digest`,敏感字段不公开落账)、approval_claims 持久化、本地 outbox intent(不宣称外部 exactly-once)、dispatcher 原子 claim + 调用前持久化 `dispatching`/immutable attempt id/fencing、外呼前重验(授权/quote-receipt 有效期/immutable digest/路由 Buyer/撤回)、lease 过期不推导无副作用且不重置未执行、HotelByte unknown/query miss/对账/补偿/披露矩阵与准入矩阵。
- **最小 E2E**:文档链接/路径检查;六状态面引用一致。
- **否证**:文档暗示 M5 已开闸;把 outbox 写成外部 exactly-once;query miss 在恢复窗口内变 reconciled_failed;receipt 接受客户端/模型拼装;遗漏 HotelByte 30s/unknown/query-orders/Buyer/selector/OTP/portal 优先缺口;遗漏原子 claim/调用前 attempt 持久化/外呼前重验/lease 过期不重置;把派发否证写成已执行。
- **退出标准**:本 follow-up PR 合入后成为 M5 实现前设计输入;不改变 M5 Entry。

### M5-2 — #231 持久化可信审批与原子 outbox

- **前置**:M5 Entry 两项(M4 Exit + 供应链协议)均满足;M5-1 proposal accepted。
- **责任文件**:`ts/src/state-ledger.ts`;`ts/src/booking-saga.ts`;`ts/capabilities/effect.ts`;`approval_claims` 表;`write_effect_intents` 派发态/attempt/fencing 字段;必要 docs/tests。
- **输出**:nonce/fingerprint 在呈现前由服务端准备为 `PreparedChallenge` 并绑定不可变请求;receipt 发行与消费通道只接受可信宿主 UI 确认回调(带 actor/tenant/seam/challenge),模型只能请求展示,模型发起确认被拒且无 outbox;`approval_claims(receipt_id PRIMARY KEY, challenge_id, nonce_digest UNIQUE, consumed_at)` 与 `pending_writes` 状态转移、outbox intent 同一 SQLite 事务;顺序为准备/呈现 → 可信确认 → 原子消费 + outbox;跨 intent 重放同一 receipt/nonce/challenge 返回 `approval-claimed`。`WriteEffectIntent` 携带 `tenant_id`;receipt 消费事务只产生一个本地 outbox intent(`dispatch_status=queued`);dispatcher 通过 `tenant_id + idem_key` 条件更新(或已验证 tenant 归属的全局 `effect_id`)原子 claim,影响行数=1 才获得派发权,后续 fold/query 同样 tenant-scoped。任何 supplier/network 调用前同事务持久化 `dispatching`、immutable `attempt_id`/`fencing_token`/`claimed_by`/`lease_until`;并发 worker 只有赢得 claim 的一个有权派发。详见 [`write-gate-production-design.md`](write-gate-production-design.md) §5.3/§5.4。
- **外呼前重验**:赢得 claim 后、任何 supplier/network 调用前重验授权、quote/receipt 有效期、当前 immutable request digest、路由/Buyer 与撤回状态;过期/变更/撤回且未外呼时 supplier write=0,旧 effect 在 outbox/dispatch 层置 `rejected` 不回 queued,另建新 quote/intent/receipt;已 unknown 继续 query,授权过期也不回 queued 或重订。拒绝不扩展 ADR-17 `pending_writes` `pending|confirmed|compensated` 三态、不投影 supplier failure/refund。详见同文 §5.5。
- **保证口径**:本地保证是"同一 ledger intent 只消费一次并只登记一个 write effect intent、同一 `attempt_id` 只 book 一次";外部副作用是否重复依赖供应商幂等/可查重;unknown 禁止盲重试。只有原子 claim/`dispatching` 事务尚未提交时 intent 才仍 queued;一旦 `dispatching`+immutable attempt id 持久化,无论 crash 在外呼前/后、是否有网络日志、lease 是否过期,都不能自动重领、续派或重放 book,统一 unknown/query/manual reconcile(按同一 attempt/`customerReferenceNo`);fencing/lease 只保护本地状态转移,不能撤回已发请求;lease 过期不能推导无副作用,也不能把 persisted dispatching 回到 queued 再 book。
- **最小 E2E**:并发双确认只有一个 claim/outbox;同一合法 actor + 合法 snapshot 下模型发起确认被拒且无 outbox,真人回调才授权;prepared challenge 直接消费被拒;receipt 过期/金额/币种/条款/presentation_key/nonce 变化 fail-closed;确认后改 fingerprint 被拒;崩溃注入覆盖 claim 消费/outbox/pending 转移三种顺序;跨 intent 重放同一 receipt 被拒。
- **否证**:可绕过 WriteGate 直调 supplier;空 receipt confirmed;nonce 未持久化或呈现后才生成;模型工具调用被当人类确认;prepared challenge 被消费;崩溃后重复登记 write effect intent;客户端自带 receipt_id 被接受;仅凭 `idem_key` 跨 tenant claim/fold/query;把 persisted-dispatching crash 无网络日志当未外呼并 book;lease/fencing/授权过期把 unknown 或 persisted dispatching 回 queued;preflight 拒绝给 `pending_writes` 加 `stale`/`cancelled` 或投影 supplier failure/refund。**未来实现最小否证(当前 proposal,均未执行)**:① 双 dispatcher 竞争同一 queued intent 只发一次,且 A/B 相同 `idem_key` 只能各自 claim/fold/query 本 tenant intent,跨 tenant 影响行数=0、supplier write=0;② 只有 claim 事务未提交才回 queued——attempt 持久化后/网络前与网络后/投影前任何 crash(无网络日志亦然)都不盲重放、不 book,统一 unknown;③ queue/preflight 本地拒绝零写,旧 effect 置 `rejected` 不回 queued,且不改变 ADR-17 `pending_writes` 三态、不投影 supplier failure/refund;④ 确认后更改 holder/guests 或 Buyer 零写;⑤ lease/fencing/授权过期不能把 unknown 或 persisted dispatching 回 queued;lease 过期且迟到供应商成功仍仅一次 book。不得声称这些测试当前已执行。
- **退出标准**:fixture/sandbox E2E + run-all;真实 supplier effect 仍等 M5-3。

### M5-3 — #232 hotelbyte-cli trade adapter + unknown/query/reconcile

- **前置**:M5-0 协议字段可得;M5-2 core 就绪。
- **责任文件**:新增 hotelbyte-cli trade adapter(文件由实施 PR 定);adapter tests;reconciliation docs。
- **输出**:钉 npm `staicli@0.0.3` 发布物(integrity 见 M5-0)而非 master;隔离 credential home;受控 env;固定全局 flags 前缀;强制 `customerReferenceNo`;book result.status `verified|pending|failed` 投影;unknown → `query-orders` 或 manual reconcile;query miss 在恢复窗口内保持 unknown。adapter 在发起 `trade book` 前执行 M5-2 的外呼前重验(授权/quote-receipt 有效期/immutable request digest/路由 Buyer/撤回),过期/变更/撤回且未外呼时零 supplier write,旧 effect 在 outbox/dispatch 层置 `rejected` 不回 queued,另建新 quote/intent/receipt(不扩展 ADR-17 `pending_writes` 三态、不投影 supplier failure/refund);`RequestFingerprint` 绑定实际 supplier request 的 canonical payload digest(覆盖 holder/guests 中影响履约的字段)或既有 immutable `payload_digest`,敏感字段不公开落账;展示/确认后替换旅客或联系人必须零写。详见 [`write-gate-production-design.md`](write-gate-production-design.md) §4/§5.4/§5.5。
- **最小 E2E**:fixture CLI:book verified/pending/failed/timeout/non-json/exit0-but-pending/query success/窗口内 miss/迟到 success/迟到 auto-cancel;断言 exit0 不等于 success,unknown 不重订,窗口内 miss 不变 reconciled_failed。
- **否证**:并发重订同一授权 intent;把 CLI 30s abort 当 failed;窗口内 miss 变 reconciled_failed 再重订;不查单直接补偿;credentials 或 Buyer 路由来自用户全局环境;读鉴权重试策略无条件复用于交易;外呼前未重验或过期/变更/撤回仍外呼,或把旧 effect 回 queued;展示/确认后替换 holder/guests 或联系人仍 book;lease 过期推断无副作用并重订;preflight 拒绝给 `pending_writes` 加 `stale`/`cancelled` 或投影 supplier failure/refund。**未来实现最小否证(当前 proposal,均未执行)**:① 双 dispatcher 竞争同一 intent 只发一次;② 只有 claim 事务未提交才回 queued——attempt 持久化后/网络前与网络后/投影前任何 crash(无网络日志亦然)都不盲重放、不 book,统一 unknown;③ queue/preflight 本地拒绝零写,旧 effect 置 `rejected` 不回 queued,且不改变 ADR-17 `pending_writes` 三态、不投影 supplier failure/refund;④ 确认后更改 holder/guests 或 Buyer 零写;⑤ lease/fencing/授权过期不能把 unknown 或 persisted dispatching 回 queued;lease 过期且迟到供应商成功仍仅一次 book。不得声称这些测试当前已执行。
- **退出标准**:adapter 通过 fixture/sandbox 与真实 UAT gate;未取得协议签署/内部授权证据或无 UAT 时保持 TODO。

### M5-4 — #233 cancel/refund/wallet outcome + commission/disclosure

- **前置**:M5-3;供应商取消/退款/钱包恢复字段核验。
- **责任文件**:cancel/refund outcome 投影;透明卡片/审计报告;tests。
- **输出**:pending cancel 与 confirmed compensation 分词;`trade cancel` receipt、退款单、钱包退款、手续费、客户退款金额分开投影;佣金/赞助/售后责任在确认前披露并纳入 fingerprint。
- **最小 E2E**:pending cancel 不写 refund;confirmed cancel 成功但钱包退款 pending;serviceFee 不当客户退款;披露变化使旧 receipt 失效。
- **否证**:账本 `compensated` 无条件显示钱已退;把 `cancel.serviceFee` 当 refund;披露在下单后才出现或未知默认无佣金。
- **退出标准**:补偿/披露矩阵全过;单位经济实测另属 M5 Exit。

## 5. M6 任务块

### M6-0 — #229/#237 tenant ledger 隔离(DONE,已入 main)

- **状态**:DONE。tenant scope 修复(#229)与 fold 回归(#237)已合入 main,#230 已关闭;M6 sponsor proof 仍须在自己的最终 SHA 引用运行证据。
- **输出**:`insertEvent` 写当前 tenant;`readEvents`/fold/rebuild 全带 tenant 条件;legacy/v1 只迁入 `local`;跨租户同 id/idem_key 不覆盖;已误写为 `local` 的非 local 历史事件不自动猜修。
- **否证(已钉住)**:tenant A 读到或重建 tenant B 投影;去掉 fold 查询 `tenant_id` 后负向变体不能稳定失败。
- **退出标准**:代码与验收已入 main;后续 M6 proof 绑定自己的最终 SHA。

### M6-0b — #236/#241 state-cli 租户与小数边界(DONE,已入 main)

- **状态**:DONE。state-cli 严格解析与 `.5`/`+.5` 小数边界已合入 main(#236/#241/#243),#241 已关闭;#227/#242 也已关闭。
- **输出**:`state-cli` 集中解析 cmd/positional/`--state-root`/`--tenant`/`--limit`;未知/重复/缺值/非法 numeric 先于 state-root 副作用 fail-closed;`tick`/`export`/`whatif` 明确 local-only;`--tenant` 仅为账本 scope,不构成认证授权。
- **否证(已入 main,待新 SHA 复验)**:`rebuild -1`/`rebuild 1.5`/`rebuild .5`/`rebuild +.5` 被当 root;flag 值成为业务参数;非 local tick/export/whatif 产生文件变化。
- **退出标准**:#236 与 #241/#243 均在 main;后续 M6 proof 绑定自己的最终 SHA。

### M6-1 — P6 draft proof 口径改进

- **责任文件**:[`../milestones/m6-b2b-reuse-walkthrough.md`](../milestones/m6-b2b-reuse-walkthrough.md)。
- **输出**:traveler principal/sponsor/BFF principal 分词;把“单点已证明/构造性隔离”校准为 PoC 假设;复用 proof 需要基准 SHA、core 文件集合、core diff、runtime trace、功能路径覆盖;tenant 对抗;披露插件 proposal;P6 founder review 与试点签约保留在 M6 Exit。
- **最小 E2E**:文档链接/路径检查。
- **否证**:宣称 frozen/通过评审;靠 LOC 复用率;用 sponsor 收益覆盖 traveler 动机;把商业试点移出 M6 Exit。
- **退出标准**:PR 合入后仅作为 P6 审批底稿;只有 founder 明确批准才满足 P6 Exit,M6 Entry 仍等 M5 Exit。

### M6-2 — #137 P6 founder review

- **输入**:M6-1 draft;商业目标;旅行社/目的地候选。
- **输出**:整体方案的 `YES 批准` 或具体修改项;只有明确 YES 或对修改稿明确批准才满足 P6 Exit。
- **否证**:工程自行宣告 P6 exit;未评审即实现。
- **退出标准**:founder 明确批准后 P6 Exit 才成立;M6 Entry 仍等 M5 Exit。

### M6-3 — #234 复用 proof schema 与生成脚本

- **责任面**:m6-proof worktree,提前冻结分母,避免实现者临时发明。
- **责任文件**:新增 proof schema/脚本/fixture(由实施 PR 定);更新 P6/roadmap。
- **输出**:固定冻结 `kernel-set.txt`;`loaded-modules.json`;runtime 实际加载 coverage;预声明功能路径 coverage;LOC 只作附属数字。
- **最小 E2E**:冻结完整 kernel-set 后运行 sponsor fixture;整组 kernel zero-diff,并分别报告实际加载覆盖与预声明功能路径覆盖。
- **否证**:按本次 run 已加载模块缩小 kernel-set 或藏改动;用 loaded LOC ratio 代替两份 coverage;未走事实闸/WriteGate/async 却称路径已覆盖。
- **退出标准**:M6 sponsor plugin proof 前有可复跑分母。

### M6-4 — #235 sponsor plugin proof

- **前置**:M5 Exit + M6-2 P6 founder 明确批准 + M6-0 tenant 隔离证据 + M6-3 proof schema。
- **输出**:旅行社嵌入全链:traveler 动机访谈→同 MotivationProfile/constraints→sponsor inventory→透明卡片含披露→可证明零内核 diff。
- **最小 E2E**:隔离 tenant/stateRoot 跑 sponsor plugin;固定 `kernel-set` 全集 `git diff` 为空;runtime 实际加载 coverage 与预声明功能路径 coverage 分别通过;tenant/sponsor 对抗通过。
- **否证**:改 `model.ts`/`unified.ts`/核心卡片 schema 才跑通;BFF principal 当 traveler;tenant A 注入 B sponsor 库存。
- **退出标准**:工程 proof 数字形成;不声称 traveler adoption 或商业效果。

### M6-5 — #137 试点商业条件/签约

- **责任面**:sales/legal。
- **输出**:真实试点签约证据;商业收益与 traveler 价值分栏报告。未签原因只解释 TODO,不能替代签约。
- **否证**:口头意向冒充签约;把 sponsor conversion 当 traveler motivation uplift。
- **退出标准**:M6 Exit 的商业半面有真实证据;未签则 M6 仍 TODO。

## 6. 开源质量任务块

### Q-1 — 贡献闸文档修正

- **责任文件**:`../../CONTRIBUTING.md`;`../../.github/pull_request_template.md`;`../../README.md`。
- **输出**:最终 SHA 本地 `cd ts && npx tsc --noEmit` + `GOTRY_SESSION_LIVE=0 ./scripts/run-all-tests.sh` 是必填;CI 只补充;E2E 行必填;语义/架构/维护兼容/六状态面自查;不宣称 GitHub 分支保护已生效。
- **最小 E2E**:文档链接/路径检查 + stale 节号/“CI 可替代本地证据”搜索。
- **否证**:PR 仍允许只贴 CI;模板缺 E2E;继续写死 `§1–49` 等计数;声称 branch protection 已配置。
- **退出标准**:新 PR 可按模板给出可复验证据。


## 7. 当前全局状态清单

1. DONE(入 main):#227 Z3 生命周期在集成候选上通过 Node24 typecheck、3×240、full 与 CI 后合入并关闭。
2. DONE(入 main):#242 dsh-map-tools map 回归已由 #245 修复入 main,issue 已关闭。
3. DONE(入 main):#223/#238 M4 scorer 硬阈值、隐私与 schema 封闭修复。
4. DONE(入 main):#228/#248 显式 opt-in M4 planning lifecycle 本地采集与脱敏导出;仅为 candidate/synthetic。
5. TODO:#20 真实 `observed_private` N≥5 repeat cohort 与 reflux baseline。
6. TODO:#136 HotelByte 供应链协议、Buyer/环境/路由、字段、人工对账与 UAT 核验(未取得签署/内部授权证据)。
7. TODO:#231 M5 Entry 后可信审批 receipt + 原子 outbox core。
8. TODO:#232 M5 HotelByte trade adapter unknown/query/reconcile。
9. TODO:#233 M5 cancel/refund/wallet outcome 与 commission/disclosure。
10. DONE(入 main):#229/#237 tenant ledger 隔离 + fold 回归与 #230 验收。
11. DONE(入 main):#236 state-cli 租户边界与 #241/#243 `.5`/`+.5` 小数边界已合入并关闭。
12. TODO:#137 P6 founder 明确批准整体方案或批准修改稿。
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
