# M4→M6 交付计划与任务图(issue #225)

> 定位:把 M4→M5→M6 拆成可分 worktree 交付的 living program 任务图,逐项写明 owner、责任文件、依赖、交付物、最小 E2E、否证与退出标准。
> 状态:living(2026-09-08;issue #225 首版。本文是计划与责任图,不替代 M3/M4/M5/M6 的 Exit 证据)
> 上游:[`../roadmap.md`](../roadmap.md)、[`../architecture.md`](../architecture.md) §1/§9/§10/§11、[`../gotry-master-outline.md`](../gotry-master-outline.md) §3.5/§3.7、issue #20/#22/#136/#137/#223/#224/#225/#226/#227/#228。
> 下游:独立 Claude Code worktree 任务、Codex 架构复验、PR 描述与贡献闸。

## 0. 速览

1. **当前 program 总状态:TODO**。M3 真实 seed cohort 未闭合;M4 真实 `observed_private` N≥5 repeat cohort 未到;M5/M6 Entry gate 均未满足。
2. **状态只用 DONE/TODO**。阻断原因写在任务块的“阻断/依赖”字段;未合并、未最终验收、或仍受 #227 阻断的本轮文档行不预写 DONE。
3. **首批工程任务**:#223 修 M4 scorer 隐私/硬阈值;#224 修 ledger tenant 归属/rebuild 隔离;#226 修 state-cli 租户参数边界;#227 是当前合并阻断;#228 是显式 opt-in planning lifecycle 采集/脱敏导出。
4. **M5 首供应链选择**:用户已明确首接 `hotelbyte-cli`,参考 `/Users/danceiny/work/hotel-be`。只读调查进行中,不推定商业协议已签;GoTry 只 bridge/import MIT CLI,不复制 hotel-be 内部代码。
5. **M5 Entry 仍只有两项**:M4 Exit + 供应链协议。WriteGate 设计可推进;交易实现、真实 book/cancel/refund/UAT 在 Entry 未满足前保持 TODO。
6. **M6 只到 draft + proof 口径**:[`../milestones/m6-b2b-reuse-walkthrough.md`](../milestones/m6-b2b-reuse-walkthrough.md) 仍待 founder 评审;零内核 diff 是工程指标,不是 traveler 效果代理。
7. **本 PR 必须 draft**:#227 未解决前,PR 顶部保留编号 TODO,不得自称可合并。

## 1. 依赖图(不制造管理步骤)

```text
#227 Z3 基线稳定性 ─┬─> 所有本轮 PR 合并复验门
                    └─> PR 只能 draft,一次 run-all 绿不能闭合

M3 real cohort (#22) ─┐
                     ├─> M3 Exit ─> 正式 M4 Entry
M4 scorer hardening (#223) ─┐
M4 opt-in lifecycle export (#228) ─┼─> real observed_private repeat cohort N≥5 (#20) ─> M4 Exit
M4 reflux baseline ────────────────┘

M4 Exit + hotelbyte-cli 供应链协议 (#136) ─> M5 WriteGate + HotelByte adapter ─> M5 Exit
#224 tenant ledger(closed) + #226 state-cli(open) ─┐
M5 Exit + P6 founder review (#137) ───────────────┴─> M6 sponsor plugin proof ─> M6 Exit(含试点签约)
```

## 2. 任务索引(≤5列)

| ID | 状态 | Issue | Owner / worktree | 主要阻断或下一证据 |
|---|---|---|---|---|
| M4-1 | TODO | #223/#20 | `m4-scorer-hardening` | scorer 固定 N≥5/≥50% + HMAC/strict schema;依赖 #227 合并复验 |
| M4-2 | TODO | #228/#20 | `m4m6-collector-20260908` | 显式 opt-in lifecycle 采集/脱敏导出;依赖 #223 scorer 合同 + #227 |
| M4-3 | TODO | #20 | founder/证据 owner | 真实 `observed_private` N≥5 repeat cohort + reflux baseline |
| M5-0 | TODO | #136/#225 | supply/legal + future adapter owner | hotelbyte-cli 协议核验;商业协议未签;字段/Buyer/环境/对账 SLA 未证 |
| M5-1 | TODO | #225/#136 | 本 PR | WriteGate proposal 入仓;PR 因 #227 保持 draft |
| M5-2 | TODO | #136 future | `m5-writegate-core` | M5 Entry 后才实现 durable approval/outbox;不能宣称 external exactly-once |
| M5-3 | TODO | #136 future | `m5-hotelbyte-adapter` | `hotelbyte-cli` trade adapter、unknown/query/reconcile;需固定凭据隔离和 UAT gate |
| M5-4 | TODO | #136 future | `m5-cancel-refund-disclosure` | cancel/refund/wallet outcome 分词 + commission/售后字段核验 |
| M6-0 | DONE | #224/#137 | `ledger-tenant-isolation` | issue #224 已关闭;M6 proof 仍需消费其 tenant 对抗证据,并等待 #226/#227 |
| M6-0b | TODO | #226/#224 | `state-cli-tenant-boundary` | state-cli 参数严格解析;非 local tick/export/whatif fail-closed |
| M6-1 | TODO | #225/#137 | 本 PR | P6 draft 降口气 + proof 口径;PR 因 #227 保持 draft |
| M6-2 | TODO | #137 | founder | P6 评审;不得由工程自行 frozen |
| M6-3 | TODO | #137 future | `m6-reuse-proof-schema` | kernel-set / loaded-modules / runtime trace schema 与生成脚本 |
| M6-4 | TODO | #137 future | `m6-sponsor-plugin-proof` | M5 Exit + P6 review 后的 sponsor plugin E2E |
| M6-5 | TODO | #137 | founder/sales/legal | B2B 试点签约/商业条件;仍属 M6 Exit,不能移出 |
| Q-1 | TODO | #225 | 本 PR | 贡献文档/PR 模板修正;PR 因 #227 保持 draft |
| Q-2 | TODO | future | maintainer/CI | 可选 PR body lint;未实现前不宣称机器闸 |

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

- **输入**:M4-2 导出器;真实用户明确同意;HMAC salt/key 私有保存。
- **责任文件**:私有 `ts/gotry-state/evidence/m4/manifest.json`、`paired-cohort.jsonl`、`summary.json`;公开只提交脱敏 summary 或 issue 状态。
- **输出**:N≥5 同一用户首访/回访 eligible completed planning pair;active planning duration 扣预声明 waits;experience reflux baseline = verified/recalled,每条 verified 有 recalled 与 evidence_ref。
- **最小 E2E**:私有副本跑 scorer,summary 报 eligible_pair_count、p50 reduction、reflux 分母。
- **否证**:N<5;样本非 repeat;wait 事后补填;fixture 当 baseline;人工无法追溯 consent。
- **退出标准**:#20 M4 paired cohort 口径满足;未达则保留编号缺口。

## 4. M5 任务块(首供应链 hotelbyte-cli)

### M5-0 — #136 HotelByte 供应链协议核验

- **已确认事实(只读调查快照)**:
  - 用户选择首供应链 `hotelbyte-cli`,参考 `/Users/danceiny/work/hotel-be`。
  - `hotel-be` 快照 `16467805bb454df89fc894a7823da674348566e3`;`external/hotelbyte-cli` 快照 `d62030bb9c132e5797e07371c5af0d2b97fdb819`;`staicli@0.0.2`;bin `hbcli`。
  - GoTry 总纲 §2:内部 `hotel-be` 只能 bridge/reference;公开 MIT `hotelbyte-cli` 可 import/extend;GoTry 默认仍经子进程桥。
- **真实接口(当前核实,仍需协议/UAT 证明)**:
  - `search hotel-rates` → `/api/search/hotelRates`,返回/保存 `sessionId`、`ratePkgId`。
  - `search check-avail` → `/api/search/checkAvail`;可用 `status=1`;必须保留原币种金额、取消政策、报价来源。
  - `trade book` → `/api/trade/book`;需 `sessionId`/`ratePkgId`/`holder`/`guests`;后端校验 session 缓存 CheckAvail。
  - `trade query-orders --customer-reference-nos` → `/api/trade/queryOrders`;权限过滤后的平台订单查询,OpenAPI 用户不能 supplier 穿透。
  - `trade cancel` → `/api/trade/cancel`;需 `customerReferenceNo` + 响应给客户的 `supplierReferenceNo`;CLI 没有 refund 命令。
- **未证前提 / TODO**:
  - 商业协议未签;Buyer、环境、供应路由、佣金/售后字段、人工对账 SLA 未证。
  - `customerReferenceNo` CLI 可选但 GoTry 必须强制持久化;后端 Buyer+ref 可重用在途/成功单,Cancelled/Failed 允许同 ref 再建,所以同授权 intent 只绑定不可变 attempt,不能声明永久幂等。
  - CLI 30s abort;后端恢复窗口 180s + 最长 10min,迟到订单可自动取消。GoTry timeout/非 JSON/进程退出 = unknown,先查单,禁止并发重订/独立补偿。
  - 当前未找到 `tenantEntityId` selector / `DistributorOption`;M5 首接只能固定一个授权 Buyer/供应路由。M6/多 route 前必须由上游提供真实 selector + session/order 绑定 + 错配拒绝。
  - `supplierReferenceNo` 可能是平台订单号,不得自行解码;`cancel.serviceFee` 不是客户退款金额;订单/取消/退款/钱包退款投影必须分开。
  - UAT ONLINE Book 要求全退政策 + OTP;CLI 无 test/OTP 通道。不得绕过、不得读 OTP、不得做真实交易。
- **最小 E2E**:只读/无凭据阶段仅允许 `hbcli trade book --help` 等帮助面与参数解析验证;交易 adapter 阶段必须在隔离 credential home + 受控 env + 固定 `--json --env=uat` 前缀下跑 fixture/sandbox;真实 UAT 另列 gate。
- **否证**:复用 GoTry 现有只读 `callHbcliJson` 写交易;继承全 `process.env`;把 exit 0 当 success;用 `--tenant-entity-id` 等当前不存在参数;复制 hotel-be 内部代码。
- **退出标准**:供应链协议/字段/UAT 范围可逐项打勾;未满足则 M5 Entry 关闭。

### M5-1 — 本 PR WriteGate proposal

- **责任文件**:[`write-gate-production-design.md`](write-gate-production-design.md)。
- **输出**:request fingerprint/approval receipt/nonce claim/outbox intent/unknown reconcile/cancel-vs-compensation/L4 revoke/commission disclosure 与 HotelByte adapter 准入矩阵。
- **最小 E2E**:文档链接/路径检查;六状态面引用一致。
- **否证**:文档暗示 M5 已开闸;把 outbox 写成外部 exactly-once;遗漏 HotelByte 30s/unknown/query-orders/Buyer/selector/OTP 缺口;额外加非权威 founder gate。
- **退出标准**:PR 合入后成为 M5 实现前设计输入;因 #227 未解决,本 PR 保持 draft。

### M5-2 — WriteGate core:durable approval + outbox intent

- **前置**:M5 Entry 两项(M4 Exit + 供应链协议)均满足;M5-1 proposal accepted。
- **责任文件**:`ts/src/state-ledger.ts`;`ts/src/booking-saga.ts`;`ts/capabilities/effect.ts`;必要 docs/tests。
- **输出**:复用现有 `requestPendingWrite` 或显式新增 facade;receipt 非空物理 CHECK;approval claim 以 `events(tenant_id, idem_key)` 唯一约束或新表持久化 nonce 一次消费;receipt 与待执行 intent 同一 SQLite 事务落账。
- **保证口径**:本地保证是“同一 ledger intent 只消费一次并只登记一个 write effect intent”。外部副作用是否重复依赖供应商 idempotency/可查重;unknown 禁止盲重试。
- **最小 E2E**:并发双确认只有一个 claim/outbox;receipt 过期/金额/币种/条款/presentation_key/nonce 变化 fail-closed;kill -9 在确认事务前/后/worker 前恢复正确。
- **否证**:可绕过 WriteGate 直调 supplier;空 receipt confirmed;nonce 未持久化;崩溃后重复登记 write effect intent。
- **退出标准**:fixture/sandbox E2E + run-all;真实 supplier effect 仍等 M5-3。

### M5-3 — HotelByte trade adapter + unknown/query/reconcile

- **前置**:M5-0 协议字段可得;M5-2 core 就绪。
- **责任文件**:新增 `hotelbyte-cli` trade adapter(文件由实施 PR 定);adapter tests;reconciliation docs。
- **输出**:固定 `hbcli` source/bin/version/env/Buyer/route;隔离 credential home;受控 env;固定全局 flags 前缀;强制 `customerReferenceNo`;book result.status `verified|pending|failed` 投影;unknown → `query-orders` 或 manual reconcile。
- **最小 E2E**:fixture CLI:book verified/pending/failed/timeout/non-json/exit0-but-pending/query success/query miss;断言 exit0 不等于 success,unknown 不重订。
- **否证**:并发重订同一授权 intent;把 CLI 30s abort 当 failed;不查单直接补偿;credentials 或 Buyer 路由来自用户全局环境。
- **退出标准**:adapter 通过 fixture/sandbox 与真实 UAT gate;未签协议或无 UAT 时保持 TODO。

### M5-4 — cancel/refund/wallet outcome + commission/disclosure

- **前置**:M5-3;供应商取消/退款/钱包恢复字段核验。
- **责任文件**:cancel/refund outcome 投影;透明卡片/审计报告;tests。
- **输出**:pending cancel 与 confirmed compensation 分词;`trade cancel` receipt、退款单、钱包退款、手续费、客户退款金额分开投影;佣金/赞助/售后责任在确认前披露并纳入 fingerprint。
- **最小 E2E**:pending cancel 不写 refund;confirmed cancel 成功但钱包退款 pending;serviceFee 不当客户退款;披露变化使旧 receipt 失效。
- **否证**:账本 `compensated` 无条件显示钱已退;把 `cancel.serviceFee` 当 refund;披露在下单后才出现或未知默认无佣金。
- **退出标准**:补偿/披露矩阵全过;单位经济实测另属 M5 Exit。

## 5. M6 任务块

### M6-0 — #224 tenant ledger 隔离

- **状态**:DONE。issue #224 已关闭;本计划不重新实现该修复,但 M6 sponsor proof 必须消费其最终证据。
- **输入**:#224 审计反例;ADR-16 tenant 一等字段。
- **责任文件**:`ts/src/state-ledger.ts`;ledger tests;六状态面。
- **输出**:insertEvent 写 tenant_id;readEvents/rebuild/projection 全 tenant 过滤;默认 local 兼容;不改不明归属历史事件。
- **最小 E2E**:两租户同业务 id 写入/读取/rebuild/跨进程持久化隔离;legacy/v1 首次由非 local 打开仍归 local;同 wish_id + `wish.updated` 不吸入其他 tenant 字段。
- **否证**:tenant A 能读 B 事件;rebuild 改其他租户;迁移擅改未知事件;去掉 fold 查询 `tenant_id` 后负向变体不能稳定失败。
- **退出标准**:#224 已关闭;M6 后续 proof 仍要引用其最终 SHA/PR 证据,且受 #226/#227 约束。

### M6-0b — #226 state-cli 租户参数边界

- **输入**:#226;state-cli `--tenant` 串位与 tick/export/whatif 非 local 语义缺口。
- **责任文件**:`ts/scripts/state-cli.ts`;`ts/scripts/state-cli-tests.ts`;必要 docs。
- **输出**:严格解析 cmd/positional/`--state-root`/`--tenant`/`--limit`;拒绝缺值、重复/未知选项、非法数字;非 local tick/export/whatif 在创建目录/打开 DB/写文件/求解前 fail-closed。
- **最小 E2E**:隔离 root:unsupported tenant 零文件变化;flag 任意合法顺序;local/B 同 id pending workflow,非 local tick 拒绝后双方 workflow/step/audit 不变;local tick 真结算。
- **否证**:`rebuild -1` 或 `rebuild 1.5` 被当 root;flag 值成为业务参数;笼统宣称所有无效输入零 IO(无效 payload JSON 是外围既有问题)。
- **退出标准**:#226 验收全过;不与 #224 并发改 state-ledger;受 #227 合并复验门约束。

### M6-1 — 本 PR P6 draft 改进

- **责任文件**:[`../milestones/m6-b2b-reuse-walkthrough.md`](../milestones/m6-b2b-reuse-walkthrough.md)。
- **输出**:traveler principal/sponsor/BFF principal 分词;把“单点已证明/构造性隔离”降为 PoC 假设;复用 proof 需要基准 SHA、core 文件集合、core diff、runtime trace、功能路径覆盖;tenant 对抗;披露插件 proposal;P6 founder review 与试点签约保留在 M6 Exit。
- **最小 E2E**:文档链接/路径检查。
- **否证**:宣称 frozen/通过评审;靠 LOC 复用率;用 sponsor 收益覆盖 traveler 动机;把商业试点移出 M6 Exit。
- **退出标准**:PR 合入后仅作为 P6 评审底稿;因 #227 未解决,本 PR 保持 draft。

### M6-2 — P6 founder review

- **输入**:M6-1 draft;商业目标;旅行社/目的地候选。
- **输出**:评审记录明确 yes/no/修改项;披露插件形态;B2B 主/辅形态;复用 proof 公式是否 accepted。
- **否证**:工程自行宣告 P6 exit;未评审即实现。
- **退出标准**:P6 exit 才成立;M6 Entry 仍等 M5 Exit。

### M6-3 — 复用 proof schema 与生成脚本

- **Owner**:后续 `m6-reuse-proof-schema` worktree,避免 executor 临时发明分母。
- **责任文件**:新增 proof schema/脚本/fixture(由实施 PR 定);更新 P6/roadmap。
- **输出**:`kernel-set.txt`;`loaded-modules.json`;runtime trace schema;功能路径覆盖表;LOC 只作附属数字。
- **最小 E2E**:B2C planning run 生成 baseline loaded modules;fixture sponsor run 生成 trace;脚本拒绝未执行模块、docs/tests/node_modules/vendor 进入分母。
- **否证**:放宽 kernel-set 藏改动;死代码计入复用;未覆盖事实闸/WriteGate/async 却计入分子。
- **退出标准**:M6 sponsor plugin proof 前有可复跑分母。

### M6-4 — sponsor plugin proof

- **前置**:M5 Exit + M6-2 P6 review + M6-0 tenant 隔离 + M6-3 proof schema。
- **输出**:旅行社嵌入全链:traveler 动机访谈→同 MotivationProfile/constraints→sponsor inventory→透明卡片含披露→可证明零内核 diff。
- **最小 E2E**:隔离 tenant/stateRoot 跑 sponsor plugin;`git diff <baseline> -- <kernel-set>` 为空;runtime module list 覆盖分母;tenant/sponsor 对抗通过。
- **否证**:改 `model.ts`/`unified.ts`/核心卡片 schema 才跑通;BFF principal 当 traveler;tenant A 注入 B sponsor 库存。
- **退出标准**:工程 proof 数字形成;不声称 traveler adoption 或商业效果。

### M6-5 — 试点商业条件/签约

- **Owner**:founder + sales/legal。
- **输出**:试点签约或明确未签原因;商业收益与 traveler 价值分栏报告。
- **否证**:口头意向冒充签约;把 sponsor conversion 当 traveler motivation uplift。
- **退出标准**:M6 Exit 的商业半面有真实证据;未签则 M6 仍 TODO。

## 6. 开源质量任务块

### Q-1 — 本 PR 贡献闸文档修正

- **责任文件**:`../../CONTRIBUTING.md`;`../../.github/pull_request_template.md`;`../../README.md`。
- **输出**:最终 SHA 本地 `cd ts && npx tsc --noEmit` + `GOTRY_SESSION_LIVE=0 ./scripts/run-all-tests.sh` 是必填;CI 只补充;E2E 行必填;语义/架构/维护兼容/六状态面自查;不再宣称 GitHub 分支保护已生效。
- **最小 E2E**:文档链接/路径检查 + stale 节号/“CI 可替代本地证据”搜索。
- **否证**:PR 仍允许只贴 CI;模板缺 E2E;继续写死 `§1–49` 等计数;声称 branch protection 已配置。
- **退出标准**:新 PR 可按模板给出可复验证据;本 PR 因 #227 保持 draft。

### Q-2 — 可选 PR body 机器 lint

- **Owner**:后续 maintainer/CI。
- **输出**:如果需要机器强制 E2E/最终 SHA 字段,另加 workflow/PR linter。
- **否证**:用徽章或未生效的 branch protection 断言冒充机器闸。
- **退出标准**:有真实 workflow 后再宣称机器闸。

## 7. 当前全局状态清单

1. TODO:#227 Z3 Node24 间歇 heap corruption 未解决;本轮 PR 必须 draft,不能用一次 run-all 绿闭合。
2. TODO:#223 M4 scorer 硬阈值、隐私与 schema 封闭修复。
3. TODO:#228 显式 opt-in M4 planning lifecycle 本地采集与脱敏导出。
4. TODO:#20 真实 `observed_private` N≥5 repeat cohort 与 reflux baseline。
5. TODO:#136 HotelByte 供应链协议、Buyer/环境/路由、字段、人工对账与 UAT 核验。
6. TODO:M5 Entry 后 WriteGate durable approval/outbox core。
7. TODO:M5 HotelByte trade adapter unknown/query/reconcile。
8. TODO:M5 cancel/refund/wallet outcome 与 commission/disclosure。
9. DONE:#224 tenant ledger 隔离修复已关闭;M6 proof 仍需引用其最终证据。
10. TODO:#226 state-cli 租户参数边界修复。
11. TODO:#137 P6 founder 评审。
12. TODO:M6 复用 proof schema/生成脚本。
13. TODO:M6 sponsor plugin 零内核 diff + runtime trace proof。
14. TODO:B2B 试点商业条件/签约。
15. TODO:可选 PR body 机器 lint;本 PR 只落文档闸。

## 8. 明确不做

- 不用 fake cohort、synthetic fixture、历史 wish/motivation 日志反推 Exit。
- 不改 M4/M5/M6 Exit 定义来绕过真实 cohort、供应链协议、P6 founder review 或试点签约。
- 不实现生产预订/支付/退改;M5 Entry 未满足前,WriteGate 只停在 proposal。
- 不把 B2B sponsor 收益、tenant 对抗或内核复用率当成 traveler 动机价值证据。
- 不把 CI、徽章、未生效分支保护或模板文案当作本地最终 SHA 证据。
- 不复制 `/Users/danceiny/work/hotel-be` 内部代码;HotelByte 只能经 `hotelbyte-cli`/bridge 与协议核验进入 GoTry。
