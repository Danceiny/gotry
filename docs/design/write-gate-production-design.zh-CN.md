[English](write-gate-production-design.md) | [简体中文](write-gate-production-design.zh-CN.md)

# WriteGate 生产化设计提案（issue #225 / M5）

> 定位：M5 交易闭环前的 WriteGate 生产化 proposal，定义授权 receipt、一次确认、供应商未知态、对账/补偿、佣金披露与 HotelByte 首供应链接入边界。
> 状态：proposal（2026-09-08；只设计，不启封任何预订/支付实现）
> 上游：[`../roadmap.md`](../roadmap.zh-CN.md) M5、[`../architecture.md`](../architecture.zh-CN.md) ADR-15/17/18/23、[`../rfc/transactional-state-rfc.md`](../rfc/transactional-state-rfc.zh-CN.md) §4.3、[`booking-saga-fsm.md`](booking-saga-fsm.zh-CN.md)、[`effect-interpreter.md`](effect-interpreter.zh-CN.md)、[`milestone-delivery-plan.md`](milestone-delivery-plan.zh-CN.md)、issue #136/#225。
> 下游：M5 Entry 后的 WriteGate core/outbox/supplier adapter 实现 PR；B2B sponsor 披露面见 [`../milestones/m6-b2b-reuse-walkthrough.md`](../milestones/m6-b2b-reuse-walkthrough.zh-CN.md)。

## 0. 摘要

1. **Entry gate 为两项**：M5 在 M4 Exit + 供应链协议同时满足后才能实现；本文不改变 roadmap Exit/Entry。
2. **首供应链**：M5 首接 `hotelbyte-cli`（公开 MIT CLI，hotel-be 内部资产只 bridge/reference）。当前未取得供应链协议签署/内部授权证据；仅进行只读接口调查与契约准备。
3. **核心不变量**：任何 booking/payment/refund 类写 effect 必须先有 `pending_writes` L2 intent，再有一次性的可信 L3 receipt；没有 receipt 就没有外部副作用。
4. **receipt 由可信人类确认回调授权，不由模型工具调用授权**：nonce/challenge 在呈现前由服务端准备并绑定不可变请求；receipt 发行与消费通道只接受可信宿主 UI 确认回调，模型只能请求展示。准备/呈现 → 可信确认 → 原子消费 + outbox，prepared challenge 不构成授权。
5. **request fingerprint 绑定请求而非按钮**：必含 actor、tenant、traveler principal、供应商、商品/报价、金额、币种、条款 digest、有效期、展示版本与 nonce；并绑定实际 supplier request 的 canonical payload digest（覆盖 holder/guests 中影响履约的字段），或显式绑定既有 immutable `payload_digest`。敏感字段本身不公开落账；展示/确认后替换旅客或联系人必须零写。
6. **本地 outbox 不等于外部 exactly-once**：receipt 消费事务只产生一个本地 outbox intent；dispatcher 通过数据库原子 claim 获得唯一派发权，并在任何 supplier/network 调用前持久化 `dispatching` 与 immutable attempt id/fencing metadata，并发 worker 只有一个有权派发。**只有原子 claim/`dispatching` 事务尚未提交时，intent 才仍是 `queued`，可由别的 worker claim；一旦 `dispatching` 与 immutable attempt id 已持久化，之后无论 crash 被认为在外呼前还是后、是否存在网络日志、lease 是否过期，都不能自动重领、续派或重放 book——记录缺失只是 evidence absence，不证明未外呼。**已持久化 dispatching 的 crash/timeout/lease expiry 统一进入 `unknown`，只允许使用同一 attempt/`customerReferenceNo` 做 query 或 manual reconcile。GoTry 保证同一 ledger intent 只消费一次并只登记一个 write effect intent、同一 `attempt_id` 只 book 一次；外部副作用是否重复依赖供应商幂等/可查重。unknown 禁止盲重试。fencing/lease 只能保护本地状态转移，不能撤回已发往供应商的请求；lease 过期不能推导无副作用，也不能把已持久化 dispatching 的 intent 回到 queued 再 book。
7. **供应商 unknown 是一等结果**：超时、进程退出、非 JSON 或连接断开后可能已产生外部副作用；进入查单或人工对账，用户可见文案不得写成失败或退款。query-orders miss 在恢复窗口内仍为 unknown，不能变 reconciled_failed 再重订。
8. **取消 ≠ 补偿 ≠ 退款到账**：pending 未执行的取消只是 local cancel；confirmed 后的退改才是真实补偿；HotelByte 的取消单、退款单、钱包退款与手续费必须分开投影。
9. **外呼前派发点重验（#231/#232 收紧）**：排队后的 effect 在任何 supplier/network 调用前重新检查授权、quote/receipt 有效期、当前 immutable request digest、路由/Buyer 与撤回状态。过期/变更/撤回时 supplier write=0，回到重新报价/可信确认；已进入 unknown 的请求继续 query，不能借过期重订。此项与第 6 条的原子 claim/attempt fencing 同为 proposal 设计，不启封 runtime。

## 1. 非目标与红线

- 不实现生产预订、支付、出票、退款或供应商 adapter。
- 不新增运行时框架；仍复用 ADR-15 单 SQLite 账本、ADR-17 `booking_saga_fsm.v1` 与 ADR-18 effect interpreter。
- 本文 §5.3/§5.4 的原子 claim、`dispatching`/attempt id/fencing、外呼前重验与 §12 派发否证均为 #231/#232 未来实现的 proposal 设计与验收口径，当前不落代码、不执行测试，不得伪称已实现或已执行。
- 不用 sandbox fixture 宣称 M5 Exit；fixture 只能证明闸语义。
- 不把供应商 API 的“请求已发出”或 CLI `exit 0` 写成“预订成功”；success 必须来自供应商 confirmation、`result.status=verified` 或可查单结果。
- 不在公开审计日志存证件号、手机号、邮箱、银行卡、cookie、OTP、支付 token、订单原号或原始对话。
- 不复制 hotel-be 内部代码；HotelByte 只能经公开 MIT `hotelbyte-cli`、子进程 bridge 与供应链协议进入 GoTry。

## 2. HotelByte 首供应链事实与未证前提

### 2.1 版本与发布物（必须区分三者）

M5 设计不能只依赖版本字符串，必须区分本地后端快照、公开 CLI 源码与实际 npm 发布物。

| 物 | 标识 | 含义 |
|---|---|---|
| hotel-be 本地参考 | `16467805bb454df89fc894a7823da674348566e3` | 内部后端快照，只 bridge/reference，不复制代码 |
| CLI gitlink 旧源码 | `hotelbyte-com/hotelbyte-cli` `d62030bb9c132e5797e07371c5af0d2b97fdb819`，`staicli@0.0.2` | 历史源码快照，不作当前发布物依据 |
| CLI 0.0.3 发版 commit | `41b5c1a8cc85f736aed753705c8c4b83b7666b4a`；PR [#12](https://github.com/hotelbyte-com/hotelbyte-cli/pull/12) `fba0d9f32e22281217f0c754142aa78cf9091847` 加 Node/npm 分发 | 0.0.3 发版点，含占位票 fallback 修复 |
| CLI 当前 master | `e3bae224d8cee0bb34795198eafcf689a1620df6`，PR [#13](https://github.com/hotelbyte-com/hotelbyte-cli/pull/13) 401 清票重试 + 按调用读凭据目录，仍声明 0.0.3 | master 含 #13，但 npm 0.0.3 tarball 不含 #13 |
| npm 实际发布物 | [staicli@0.0.3](https://registry.npmjs.org/staicli/0.0.3)，发布 2026-09-08T14:21:22.665Z；integrity `sha512-xGzw6KBQ4r5l+CXDbU/35p2nh6ia4t7Hjh+D34IxQEgtaOOkt9iUATmxlFwcspmXCo6NuHoYFhCJ/rJ3rso5fg==`；registry 无 gitHead | adapter 必须钉此发布物，不得硬绑当前 master |
| GoTry bootstrap 要求 | main `2626167` [`bin/gotry-bootstrap.js`](https://github.com/Danceiny/gotry/blob/2626167a0617c12dacb145307c3db2a566b1ffe8/bin/gotry-bootstrap.js#L104) 默认 `hbcli>=0.0.3`（环境可覆盖） | 仅安装检查，不证明 trade 鉴权 |

公开 CLI 仓 tags/releases 为空，docs 仓原生 release 仅 0.0.2/0.0.1，`staicli-v0.0.3` API 404：可确认 npm 0.0.3 实包，不能称原生 0.0.3 发版。adapter 须记录实际 bin/package digest 及能力，不硬绑 master。

### 2.2 真实入口（当前调查，未等于协议）

| 阶段 | CLI/API | 设计含义 |
|---|---|---|
| rate | `search hotel-rates` → `/api/search/hotelRates` | 保存 `sessionId`/`ratePkgId`；后续 check/book 依赖同 session 语义 |
| availability | `search check-avail` → `/api/search/checkAvail` | 可用 `status=1`；必须保留原币种金额、取消政策、报价来源 |
| book | `trade book` → `/api/trade/book` | 需要 `sessionId`/`ratePkgId`/`holder`/`guests`；后端校验 session 缓存 CheckAvail |
| query | `trade query-orders --customer-reference-nos` → `/api/trade/queryOrders` | 权限过滤后的平台订单查询；OpenAPI 用户不能 supplier 穿透 |
| cancel | `trade cancel` → `/api/trade/cancel` | 需要 `customerReferenceNo` + 响应给客户的 `supplierReferenceNo`；CLI 没有 refund 命令 |

`trade.ts` 相对旧快照未变：`customerReferenceNo` 可选；无 tenant selector/refund 命令/OTP 参数/timeout 旗标；HTTP 仍 30 秒 abort。

### 2.3 鉴权与交易能力缺口

1. **portal 优先未修复**：npm 0.0.3 与当前 master 仍优先可用 portal 票，`trade`/`checkAvail` 共用 `run→makeClient`，没有 endpoint 级 OpenAPI 身份选择；0.0.3 只跳过 stored-ticket 占位并 fallback，不能称强制 OpenAPI。隔离 credential home + 固定 Buyer/环境仍必要。见 [helpers](https://github.com/hotelbyte-com/hotelbyte-cli/blob/e3bae224d8cee0bb34795198eafcf689a1620df6/src/commands/helpers.ts#L40)、[check-avail](https://github.com/hotelbyte-com/hotelbyte-cli/blob/e3bae224d8cee0bb34795198eafcf689a1620df6/src/commands/search.ts#L105)。
2. **读鉴权重试不得复用于交易**：npm 0.0.3 `run` 单次；master 的 401 清票重试仍可能再选 portal，audience 选择未修复（见 [retry](https://github.com/hotelbyte-com/hotelbyte-cli/blob/e3bae224d8cee0bb34795198eafcf689a1620df6/src/commands/helpers.ts#L88)）。交易 adapter 不得把未来读鉴权重试策略无条件复用于交易。
3. **#142 已更正历史 401 归因**：历史 401 已更正为选票错误，不是未开通权限；issue 关闭也不代表真实预订/退款 UAT。

### 2.4 必须保留为 TODO 的前提

1. **协议未取得签署/授权证据**：Buyer、环境、供应路由、佣金/售后字段、人工对账 SLA、真实 UAT 范围仍待核验。
2. **`customerReferenceNo` 不是永久幂等**：CLI 可选但 GoTry 必须强制持久化。后端以 Buyer+ref 重用在途/成功单，Cancelled/Failed 允许同 ref 再建；同授权 intent 只绑定不可变 attempt，新订单须新授权。
3. **30s CLI abort + 长恢复窗口**：CLI HttpClient 默认 30 秒 abort；后端恢复 180 秒 Phase1 再最长 10 分钟 Phase2，迟到订单可自动取消。GoTry timeout/进程退出/非 JSON = unknown，先查单并遵守恢复窗口。
4. **身份隔离未具备通用 selector**：当前 CLI/后端未找到 `tenantEntityId` selector 或 `DistributorOption`；M5 首接只能固定一个授权 Buyer/供应路由。M6 或多 route 前必须由上游提供真实 selector + session/order 绑定 + 错配拒绝。
5. **取消/退款字段不能简化**：`supplierReferenceNo` 可能是平台订单号，不得自行解码；`cancel.serviceFee` 不是客户退款金额；订单、取消、退款单、钱包退款是不同 outcome。
6. **UAT ONLINE Book 有 OTP/全退政策要求**：CLI 无 test/OTP 通道。不得绕过、不得读 OTP、不得做真实交易。
7. **现有 GoTry 只读 hbcli 桥不可复用为交易边界**：`ts/capabilities/hbcli.ts` spawn 继承 `process.env`，默认 uat/token env 注入，超时 SIGKILL，只看 exit 0 再尝试 JSON，读失败可静态回退；交易 adapter 必须新建受控 env/credential home/identity boundary。

## 3. 词汇与对象

| 词汇 | 责任 | 必填字段/约束 |
|---|---|---|
| `WriteIntent` | L2 建议态，只登记不执行 | `idem_key`，`tenant_id`，`actor_ref`，`principal_ref`，`seam`，`payload_digest`，`created_at`，`expires_at`；现有入口为 `requestPendingWrite` |
| `RequestFingerprint` | 用户看到并授权的规范请求 | canonical JSON 后 SHA-256；字段见 §4；在呈现前由服务端计算并冻结，确认后不可变 |
| `PreparedChallenge` | 呈现前由服务端准备的一次性呈现挑战 | `challenge_id`，`idem_key`，`request_fingerprint_sha256`，`presentation_key`，`delivery_nonce_digest`，`actor_ref`，`tenant_id`，`seam`，`prepared_at`，`expires_at`，`status=prepared\|confirmed\|consumed\|expired`；nonce 在呈现前生成并绑定不可变请求；`prepared` 不构成授权，未确认的 challenge 不能消费 |
| `ApprovalReceipt` | L3 一次性确认凭证，仅在可信人类确认回调后由服务端发行 | `receipt_id`，`challenge_id`，`idem_key`，`request_fingerprint_sha256`，`actor_ref`，`tenant_id`，`principal_ref`，`amount_total`，`currency`，`terms_digest`，`valid_until`，`approved_at`，`presentation_key`，`delivery_nonce_digest`；由服务端账本在可信确认回调后生成，不接受模型/客户端拼装 |
| `ApprovalClaim` | receipt/nonce 一次消费权威 | 独立表 `approval_claims(tenant_id, receipt_id PRIMARY KEY, challenge_id, idem_key, nonce_digest, request_fingerprint_sha256, issued_at, consumed_at)`；`receipt_id` 全局唯一，`challenge_id`/`nonce_digest` 唯一；与 outbox intent 同一 SQLite 事务落账 |
| `WriteEffectIntent` | outbox 中待执行的外部副作用意图 | `tenant_id`，`effect_name`，`idem_key`，`receipt_id`，`supplier_attempt_key`，`request_fingerprint_sha256`，`attempt_budget`，`next_action`；派发态 `dispatch_status=queued\|dispatching\|dispatched\|rejected`、immutable `attempt_id`、`fencing_token`、`claimed_by`、`lease_until`、`reject_reason`；`attempt_id` 在任何 supplier/network 调用前持久化且不可变；`rejected` 为 outbox/dispatch 层的不可派发终态（外呼前重验失败），**不是** `pending_writes` 的新状态 |
| `SupplierOutcome` | 供应商结果投影 | `success | failed | unknown | reconciled_success | reconciled_failed | cancel_submitted | refund_pending | refunded | compensated_failed`，附供应商 receipt/refund digest |
| `RedactedAuditEvent` | 可分享审计面 | HMAC 假名主体 + digest + 金额/币种/条款版本；不含 PII/secret/raw supplier payload |

receipt/nonce 一次消费权威用独立表 `approval_claims`。`receipt_id`/`challenge_id`/`nonce_digest` 的单次消费语义与 events 的业务幂等 `idem_key` 不同层，独立表让 unique 约束直接表达“一个 challenge 只能确认一次、一个 receipt 只能被一个 intent 消费”，且崩溃恢复时 claim 与 outbox 同事务回放。

`pending_writes.status` 继续只用 ADR-17 的 `pending | confirmed | compensated`。供应商 `unknown` 不塞进 saga 状态字母表，而是 `SupplierOutcome` 投影：本地已经消费 receipt 并进入 confirmed，但外部世界尚未可判。这样不推翻 `booking_saga_fsm.v1`，又能诚实表达对账状态。

## 4. Request fingerprint 字段

request fingerprint 必须由代码 canonicalize，并在展示卡、approval receipt、supplier write effect 三处同源引用。

| 字段 | 说明 | 变更后果 |
|---|---|---|
| `schema` | `gotry_write_request_fingerprint.v1` | 不匹配即拒绝确认 |
| `tenant_id` | 账本租户；M6 前也必须存在 | tenant 不同即不同请求 |
| `actor_ref` | 发起确认的人或 L4 策略，HMAC 假名 | actor 变化需要重确认 |
| `principal_ref` | traveler principal，HMAC 假名；B2B 中不等同 sponsor/BFF principal | principal 变化需要重确认 |
| `sponsor_ref` | 可选，HMAC 假名；仅 B2B/合作库存 | sponsor 变化需要重披露 |
| `seam` | 具名 seam，如 `hotelbyte-hotel-book-confirm` | 未登记 seam fail-closed |
| `supplier` | vendor/channel + CLI/API version + Buyer/route digest | vendor 或身份路由变化需要重确认 |
| `product_ref` | `sessionId`/`ratePkgId`/offer digest；不存 PII | offer 变化需要重确认 |
| `travel_terms` | 入离店、人数、房型、早餐、取消政策、税费等 digest | 条款变化需要重确认 |
| `amount_total` | 用户授权总金额，最小货币单位；保留原币种 | 金额变化需要重确认 |
| `currency` | ISO 4217 或供应商原币种映射 | 币种变化需要重确认 |
| `commission_disclosure` | 佣金/赞助/返利口径 digest，可为 none 但必须显式 | 披露变化需要重确认 |
| `valid_until` | 报价/授权有效期，必须早于供应商 quote expiry | 过期拒绝确认 |
| `presentation_key` | 用户实际看到的卡片版本 digest | 卡片重排/删字段需要重确认 |
| `delivery_nonce_digest` | 服务端在呈现前生成并持久绑定不可变请求的 nonce/challenge digest；用户看到的 fingerprint 已含此 nonce | nonce 不匹配、未呈现即确认、确认后改 fingerprint 均拒绝 |

**supplier payload digest 绑定（#231/#232 收紧）**：`request_fingerprint_sha256` 必须绑定实际 supplier request 的 canonical payload digest——覆盖 holder/guests 对象中影响履约的字段（入住人身份/人数/房型/日期等），或显式绑定既有 immutable `payload_digest`。不能只比较金额/房型而允许在展示/确认后更换旅客或预订联系人；展示或确认后替换 holder/guests 或联系人必须零 supplier write，需要新 quote/intent/receipt。敏感字段（证件号/手机号/邮箱/支付 token）本身不公开落账，只以其 digest 或 HMAC 假名进入 fingerprint 与审计面（见 §11）。

## 5. 状态机与执行序列

### 5.1 L2：建议态与呈现前准备

1. planner 生成可写建议时，调用现有 `requestPendingWrite`。若后续实现需要新 facade，须在实现 PR 中显式定义并补 ADR 让渡。
2. `payload` 内只存可展示语义与 digest；敏感旅客/支付字段不进账本。
3. 同一 `tenant_id + idem_key` 重复提议是 no-op，返回既有 pending/confirmed/compensated 状态。
4. 展示卡必须包含总价、币种、条款摘要、有效期、取消规则、佣金/赞助披露与“确认只消费一次”。
5. **呈现前准备**：`RequestFingerprint` 与 `delivery_nonce` 由服务端在呈现给用户之前计算/生成，写入 `PreparedChallenge`（`status=prepared`）并绑定不可变请求。用户看到的 fingerprint 已含此 nonce；确认后不得再改 fingerprint 或 nonce。`prepared` 不构成授权，只能被一次可信确认回调升级。

### 5.2 L3：可信人类确认与原子消费

**授权来源（模型工具调用不等于人确认）**：

receipt 发行与消费通道只接受由可信宿主 UI/交互确认回调派生的 approval authority。回调必须带服务端绑定的 actor/tenant/seam/presentation challenge；模型/planner 在同一已鉴权会话内可以请求展示可写卡片，但**不能调用 receipt 发行或确认消费通道**。同一合法 actor、合法 snapshot 下，模型发起的确认必须被拒绝且不产生 outbox；只有真人回调才可授权。字段匹配不等于用户许可。

**顺序：准备/呈现 → 可信确认 → 原子消费 + outbox**：

1. **准备/呈现**：服务端在呈现前生成 `PreparedChallenge`（nonce + fingerprint + presentation_key，`status=prepared`），卡片按此记录渲染。
2. **可信确认**：可信宿主确认回调引用 `challenge_id`；服务端校验回调绑定（actor/tenant/seam/presentation challenge 与 `PreparedChallenge` 一致），把 `PreparedChallenge.status` 置为 `confirmed` 并发行 `ApprovalReceipt`（`approval_claims.consumed_at` 仍为空）。未确认的 challenge 不能消费。
3. **原子消费 + outbox**：在同一 SQLite 事务内：
   - 读取 pending intent 与 `approval_claims` 发行记录，校验 tenant/actor/principal/seam/receipt_id/challenge_id 一致；
   - 重算 request fingerprint，与发行记录 `request_fingerprint_sha256` 逐字节一致；
   - 校验 `valid_until` 未过、`presentation_key` 与呈现版本一致、`nonce_digest` 未被消费；
   - `UPDATE approval_claims SET consumed_at=? WHERE receipt_id=? AND consumed_at IS NULL`，影响行数为 1（原子单次消费）；跨 intent 重放同一 receipt/nonce/challenge 返回 `approval-claimed`，不得执行 supplier effect；
   - `UPDATE pending_writes ... WHERE status='pending' AND receipt_id=?`，影响行数为 1；
   - 追加 `write.confirmed` 与 `WriteEffectIntent` outbox intent（携带 `receipt_id`）。

**拒绝项**：旧 nonce、重新呈现后用旧 challenge 确认、确认后再改 fingerprint/nonce、模型发起的确认、跨 intent 重放——一律 fail-closed，无 outbox、无 supplier effect。

`approval_claims` 消费、`pending_writes` 状态转移与 `WriteEffectIntent` outbox 落账必须在同一 SQLite 事务。崩溃注入须覆盖三种顺序：claim 消费后未写 outbox、outbox 写后未转移 pending、转移后未写 claim——任一中断重启都不能产生重复 effect intent 或二次消费。`PreparedChallenge` 长期 `prepared` 未确认的按 `expires_at` 过期，过期 challenge 不能确认或消费。

并发场景下，两个确认请求只有一个能把 `consumed_at` 从 NULL 更新为非空并写出一个 effect intent；另一个返回 `already-confirmed`、`approval-claimed` 或 `absorbed-compensated`，不得再次执行 supplier effect。

### 5.3 outbox：崩溃恢复与"本地一次"口径

- **确认前崩溃**：仍是 pending，用户可重新确认；旧 nonce 若未消费，按有效期处理。
- **确认事务后、supplier 前崩溃**：outbox intent 存在（`dispatch_status=queued`）但未 attempt；worker 重启后按 §5.4 原子 claim 执行该 intent。
- **claim 持久化后、网络前崩溃**：`dispatch_status=dispatching` 与 immutable `attempt_id`/`fencing_token` 一旦持久化，之后无论 crash 被认为在外呼前还是后、是否有网络日志、lease 是否过期，都不能自动重领、续派或重放 book——记录缺失只是 evidence absence，不证明未外呼；统一进入 `unknown`，只允许用同一 `attempt_id`/`customerReferenceNo` 做 query 或 manual reconcile。只有原子 claim/`dispatching` 事务**尚未提交**时，intent 才仍是 `queued`，可由别的 worker claim。
- **supplier 调用中崩溃/超时/非 JSON/进程退出**：状态进入 `unknown`，先按 supplier attempt key、`customerReferenceNo` 或查单 API 对账；禁止直接重放 write effect。
- **supplier success 后、投影前崩溃**：通过供应商 receipt/order lookup fold 为 success；若 lookup 不可用则 manual reconcile。
- **supplier failed 明确返回**：记录 failed outcome；如供应商确认未产生外部副作用，可按用户选择重新生成新 quote/intent。
- **lease 过期**：dispatching 记录的 `lease_until` 过期**不能推导无副作用**，也不能把已持久化 dispatching 的 intent 回到 `queued` 再 book；一律进入 unknown/query/manual reconcile，按 attempt id 对账。lease 过期且迟到供应商成功仍只 book 一次（fold 为 `reconciled_success`）。

供应商若不支持稳定查单键或人工对账 SLA，该供应商不能进入自动 production WriteGate；只能保持人工处理或不接入。

### 5.4 派发权与 attempt fencing（原子领取，#231/#232 收紧）

receipt 消费事务（§5.2）只产生一个本地 outbox intent（`dispatch_status=queued`）；真正发起 supplier/network 调用前，dispatcher 必须先在一个数据库原子 claim 中获得该 intent 的**唯一派发权**，并在同一事务内持久化派发态与不可变 attempt 元数据：

- **原子 claim**：`UPDATE write_effect_intents SET dispatch_status='dispatching', attempt_id=?, fencing_token=?, claimed_by=?, lease_until=? WHERE tenant_id=? AND idem_key=? AND dispatch_status='queued'`（或等价 conditional update；也可使用已在可信事务内验证 tenant 归属的全局唯一 `effect_id`），影响行数为 1 才算领取成功；后续 fold/query 同样限定 `tenant_id + idem_key`。并发 worker 只有赢得 claim 的那一个有权派发，其余落败且不得发起 supplier 调用。fencing token 单调递增，用于拒绝旧 lease 的越权写。
- **调用前持久化**：`dispatching`、immutable `attempt_id`、`fencing_token` 必须在**任何 supplier/network 调用前**持久化（与 claim 同事务落账）。`attempt_id` 一旦持久化即不可变；对账一律引用同一 `attempt_id`，不得另起；持久化后不得续派或重放 book。
- **崩溃分割**：只有原子 claim/`dispatching` 事务**尚未提交**时，intent 才仍是 `queued`，可由别的 worker claim。一旦 `dispatching` 与 immutable `attempt_id` 已持久化，之后无论 crash 在外呼前还是后、是否有网络日志、lease 是否过期，都不能自动重领、续派或重放 book——记录缺失只是 evidence absence，不证明未外呼；统一进入 unknown/query/manual reconcile。数据库 fencing token 不能阻止一个已发往供应商的请求；fencing/lease 只能保护本地状态转移，不能撤回已发请求，也不得以 lease 到期推导无副作用或把 persisted dispatching 回到 queued。
- **本地一次口径**：GoTry 保证同一 ledger intent 只消费一次、只登记一个 write effect intent、同一 `attempt_id` 只 book 一次；外部副作用是否重复依赖供应商幂等/可查重，unknown 禁止盲重试。

### 5.5 外呼前派发点重验（#231/#232 收紧）

赢得 claim 后、发起任何 supplier/network 调用前，dispatcher 必须在同一派发点重新检查：

1. **授权**：receipt 仍有效、`approval_claims.consumed_at` 仍指向本 intent、未跨 intent 重放。
2. **quote/receipt 有效期**：`valid_until` 未过，且不晚于供应商 quote expiry。
3. **当前 immutable request digest**：`request_fingerprint_sha256`（含 §4 的 supplier payload digest）与持久化发行记录逐字节一致；holder/guests/联系人/路由/金额/条款未在展示或确认后被替换。
4. **路由/Buyer**：供应商、Buyer、供应路由与发行记录一致；身份隔离未漂移。
5. **撤回状态**：未触发 L4 revoke 或显式撤回（§9）。

任一项过期/变更/撤回且**尚未外呼**：**supplier write=0**，在 outbox/dispatch（或 challenge）层记录本地拒绝原因，把旧 effect 置为不可派发终态（`dispatch_status=rejected` + `reject_reason`），**不得**把它回到 `queued`；再由用户/系统另行创建新 quote/新 intent/新可信确认。**已进入 unknown 的请求继续 query/manual reconcile，授权过期也不能使它回到 queued 或重订。**层级约束：拒绝原因只存在于 outbox/dispatch/challenge 层，ADR-17 `pending_writes` 的 `pending|confirmed|compensated` 三态字母表不扩展（不给 `pending_writes` 加 `stale`/`cancelled`）；未派发或 preflight 拒绝一律零 supplier write，不投影成 supplier failed/cancel 订单/refund。此项是 proposal 设计，不启封 runtime。

## 6. HotelByte adapter 准入矩阵

| 维度 | 必须设计/验证 | 最小 fixture E2E | 真实 UAT gate |
|---|---|---|---|
| CLI source | 钉 npm `staicli@0.0.3` 发布物（integrity 见 §2.1），不硬绑 master；固定 `--json --env=uat` 前缀，不假定 flag 任意位置等价 | `trade book --help` exit0；`--tenant-entity-id` exit1 unknown option；版本/integrity 漂移 fail-closed | 使用协议授权的发布物；master 含 #13 但 npm tarball 不含，不得混用 |
| credential boundary | 隔离 credential home + 受控 env；不继承 GoTry 全 `process.env` | fake home 不存在时零凭据读取；错误脱敏 | 固定 Buyer/环境/路由由协议授权 |
| quote snapshot | `sessionId`/`ratePkgId`/check-avail status/金额/币种/取消政策/来源 digest | check-avail fixture status=1/0/changed | 真实 quote 有有效期与取消条款 |
| booking | 强制 `customerReferenceNo` 持久化；同 intent 不可变 attempt | `verified`/`pending`/`failed`/exit0-but-pending 均正确投影 | UAT Book 在合法全退政策下执行；OTP 不由 GoTry 读取 |
| unknown | 30s abort/timeout/non-json/kill 均 unknown | unknown 后只 query/manual reconcile，不重订 | 遵守 180s + 最长10min 恢复窗口 |
| query-orders | 只按 `customerReferenceNo` 查权限内平台订单 | query success/miss/multiple/permission-denied | 人工对账字段足够，无需原始聊天 |
| cancel | 需要 `customerReferenceNo + supplierReferenceNo`；CLI 无 refund | cancel submitted/failed/serviceFee not refund | 取消、退款单、钱包退款有真实字段来源 |
| multi-route | 当前无 selector，只能固定一个 Buyer/route | `--tenant-entity-id` 负例 fail-closed | 上游提供 selector/session/order 绑定前不得多 route |

## 7. 供应商未知态与人工对账

unknown 的用户文案必须是“结果未知，正在对账”，不是“失败”也不是“已退款”。

**query-orders miss 不等于未发生**：HotelByte 后端有长恢复窗口（180s Phase1 再最长 10min Phase2，迟到订单可自动取消）。恢复窗口内 `query-orders` 返回空只能保持 `unknown`，不能变为 `reconciled_failed` 再重订。只有满足以下权威否定证据之一，才能把 unknown 收敛为 `reconciled_failed`：协议约定的稳定终态失败、供应商明确已取消、绑定 Buyer/attempt 的明确无订单证明、或恢复窗口结束且查单仍空并经人工对账确认。

| 场景 | 账本状态 | 用户文案 | 后续动作 |
|---|---|---|---|
| pending 未确认取消 | `compensated` | 已取消本地建议，没有下单/扣款 | 无供应商动作 |
| 确认后 CLI timeout/abort/non-json | `confirmed` + `SupplierOutcome.unknown` | 供应商结果未知，不要重复下单；已进入对账 | `query-orders` 或人工对账 |
| 窗口内 query miss | `confirmed` + `unknown`（不变） | 仍在对账，供应商可能迟到建单；不要重订 | 等恢复窗口/再查单/人工对账 |
| 窗口后 query 仍空 + 人工确认无单 | `confirmed` + `reconciled_failed` | 未产生订单/扣款；可重新报价 | 新 intent + 新 receipt |
| 查单发现成功（含迟到建单） | `confirmed` + `reconciled_success` | 预订已确认，给出供应商回执摘要 | 后续取消走补偿 |
| 迟到订单被供应商自动取消 | `confirmed` + `reconciled_failed` 或 `cancel_submitted`（按供应商回执） | 订单已由供应商取消，按其规则处理 | 展示取消回执；如需重订走新 intent |
| cancel 已提交但退款未到账 | `compensated` + `refund_pending` | 已提交退改，退款状态待更新 | 后续查单/钱包恢复投影 |
| refund 到账 | `compensated` + `refunded` | 已按供应商规则退款到账 | 展示金额/币种/手续费来源 |

**反例 E2E（必须覆盖）**：timeout → 窗口内 query miss → 迟到 success（unknown 升 reconciled_success，不重订）；timeout → 窗口内 query miss → 迟到 auto-cancel（收敛为 reconciled_failed 或 cancel_submitted，不重订）；timeout → 窗口后 query 仍空 → 人工确认无单（才允许 reconciled_failed + 新 intent）。任一反例中，unknown 期间都不得发起第二个同类订单。

人工对账需要最小字段：tenant、idem_key、`customerReferenceNo`、supplier attempt key、request fingerprint digest、时间窗、金额/币种、供应商候选 digest。不得要求人工查看用户原始聊天或 cookie。

## 8. 取消、补偿与退款分词

- `pending → compensated`：**取消本地建议**。外部副作用未发生，不得写“退款”。
- `confirmed → compensated`：**真实补偿流程**。必须有供应商取消/退款/改签 receipt 或明确失败原因。
- HotelByte `trade cancel` 不是 refund 全链闭合；取消、退款单、钱包退款、手续费、客户退款金额必须分开 outcome。
- unknown 期间不允许用户发起第二个同类订单；只能选择“等待对账 / 人工联系 / 放弃并承认风险”。若供应商协议允许按 `customerReferenceNo` 安全取消 unknown 请求，也必须记录为 external compensation attempt。

## 9. L4 自动类与撤回

L4 不是“无确认”，而是“用户预先确认一条可撤回策略”。策略本身需要 L3 receipt：

- scope：供应商、目的地/日期范围、金额上限、币种、人数、库存类型、有效期。
- guard：每笔自动写仍重算 request fingerprint；超 scope 即降级 L3。
- revoke：撤回是账本事件，立即阻断未来 effect intent；已执行的 effect 只能走补偿，不能被撤回抹除。
- audit：每笔自动写的 receipt 标注 `approval_mode='l4_policy'`、policy digest、当次 request fingerprint。
- expiry：策略必须到期；续期需要新 receipt。

## 10. 佣金/赞助披露

每个可写卡片在确认前必须披露：

1. 用户支付总价与币种。
2. GoTry/合作方是否获得佣金、返利、赞助或优先展示收益。
3. 披露来源：供应商字段、合同规则、或“无收益”。未知不得默认为无。
4. B2B 下 sponsor 收益和 traveler 动机分开呈现；披露 sponsor 收益不等于满足 traveler 动机。
5. 披露 digest 纳入 request fingerprint；披露变化使旧 receipt 失效。

M6 sponsor 披露槽位仍保持 proposal：优先由 sponsor 插件注入渲染片段，避免内核感知 sponsor。若 M5 C 端先行需要 schema 预留，必须保持 B2C 空值显式可审计。

## 11. 审计与脱敏

| 数据 | 公开/可提交 | 私有/本地 | 禁止 |
|---|---|---|---|
| tenant/actor/principal/sponsor | HMAC-SHA256 假名 | salt/key 私有 | 姓名、邮箱、手机号 |
| request | SHA-256 digest + 可展示摘要 | 供应商原 payload 可本地加密保存 | cookie、OTP、支付 token |
| receipt | receipt id + digest + 金额/币种/有效期 | 原始 approval event 可本地保存 | 原始聊天全文 |
| supplier outcome | success/failed/unknown + supplier receipt digest | 查单截图/订单号可本地加密 | 未脱敏订单号进 git |
| errors | reason code + redacted evidence | 详细日志本地 | 反射用户秘密或 raw supplier response |

所有错误输出必须优先 reason code，不得把供应商 raw response 直接塞进 LLM 可见文本。

## 12. 验收矩阵

| 类别 | 正例 E2E | 负例/否证 | 通过条件 |
|---|---|---|---|
| receipt 绑定 | 同一 pending intent 展示后确认；receipt digest 与 request fingerprint 一致 | 金额 +1、币种改、条款 digest 改、presentation_key 改、nonce 复用 | 正例 confirmed + one local effect intent；负例 fail-closed 且无 supplier effect |
| 授权来源 | 可信宿主 UI 确认回调带 actor/tenant/seam/challenge；服务端发行 receipt | 同一合法 actor + 合法 snapshot 下模型发起确认；客户端自带 receipt_id/nonce/fingerprint | 模型确认被拒且无 outbox；仅真人回调授权；字段匹配≠许可 |
| nonce 时序 | nonce/fingerprint 在呈现前由服务端准备并绑定不可变请求 | 呈现后才生成 nonce；确认后再改 fingerprint；重新呈现后用旧 challenge 确认 | 用户所见 fingerprint 含 nonce；确认后不可变；旧/重呈现 challenge 拒绝 |
| receipt 发行权威 | 可信确认回调引用 challenge_id，服务端发行 receipt 并绑定 pending | 跨 intent 重放同一 receipt/challenge；prepared challenge 直接消费 | 仅账本发行记录有效；prepared 不授权；跨 intent 重放返回 approval-claimed 且无 effect |
| actor/tenant/principal | tenant A actor 确认 A 的 intent | tenant B 用同 idem_key/receipt 确认；BFF principal 当 traveler principal | 跨租户/跨 principal 全拒；审计只见 HMAC |
| 一次确认 | 双并发确认同一 idem_key | 两个进程同时提交 receipt | 仅一条 `approval_claims.consumed_at`，仅一条 `write.confirmed`，仅一条 local effect intent |
| 崩溃恢复 | 确认事务后 kill，重启 worker | claim 消费/outbox/pending 转移三种顺序崩溃注入 | 不丢 claim、不重复登记 effect intent、不二次消费；终态可 fold |
| 派发权唯一（#231/#232） | 双 dispatcher 竞争同一 queued intent | 两个 worker 同时 claim 同一 intent | 仅一个 claim 成功（`dispatch_status=dispatching`、`attempt_id` 唯一）；落败者无 supplier 调用 |
| 派发 tenant 边界（#231/#232） | tenant A/B 各有相同 `idem_key` 的 queued intent | A worker 仅凭 `idem_key` claim/fold/query 到 B intent | claim/fold/query 均限定 `tenant_id + idem_key`（或已验证归属的全局 `effect_id`）；跨 tenant 影响行数=0、supplier write=0 |
| attempt fencing 时序（#231/#232） | claim 事务未提交时 intent 仍 queued，可被别的 worker claim；dispatching+attempt 持久化后 crash（外呼前/后）、lease 过期 | claim 未持久化即外呼；把已持久化 dispatching 的 intent 回到 queued 再 book | 只有 claim 事务未提交才回 queued；dispatching+attempt 持久化后任何 crash 都不得 book/续派，统一 unknown，按 attempt id fold；lease 过期不回 queued |
| persisted-dispatching crash 无网络日志（#231/#232 反证） | — | 无网络日志即推断未外呼并 book/续派 | 仍不得 book，进入 unknown/query/manual reconcile |
| lease/fencing/授权过期回 queued（#231/#232 反证） | — | lease expiry/fencing 失效/授权过期把 unknown 或 persisted dispatching 回 queued 再 book | 不能回 queued；unknown 继续 query，preflight 失效零写并另建新 intent |
| 外呼前重验（#231/#232） | quote/receipt 有效、digest 不变、路由/Buyer 一致、未撤回 | quote 过期/digest 变更/路由或 Buyer 变更/已撤回仍外呼；把旧 effect 回 queued | 过期/变更/撤回且未外呼：旧 effect 置 `rejected`（outbox 层）零写，另建新 quote/intent/receipt，不回 queued；已 unknown 继续 query，授权过期也不回 queued 或重订 |
| queue/preflight 本地拒绝层级（#231/#232 反证） | preflight 发现过期/变更/撤回且未外呼，旧 effect 不可派发 | 给 `pending_writes` 加 `stale`/`cancelled` 状态；未派发过期投影成 supplier failed/cancel/refund | 拒绝只记在 outbox/dispatch/challenge 层，ADR-17 `pending_writes` `pending\|confirmed\|compensated` 三态不变，零 supplier failure/refund 投影 |
| fingerprint 绑定 supplier payload（#231/#232） | holder/guests 履约字段纳入 supplier payload digest | 展示/确认后替换旅客或联系人仍 book | 替换后零写，需新 quote/intent/receipt |
| lease 过期+迟到 success（#231/#232） | dispatching lease 过期后供应商迟到建单 | lease 过期即推断无副作用并重订；迟到 success 二次 book | 仅一次 book，按 attempt id fold 为 `reconciled_success` |
| HotelByte unknown | CLI timeout/non-json/exit0 pending fixture | 自动重试同 write effect 或并发重订 | unknown + query/manual reconcile；禁止盲重试 |
| query-orders | customerReferenceNo 查到成功/多条；窗口内 miss 保持 unknown | 窗口内 miss 变 reconciled_failed 再重订；supplierReferenceNo 解码猜测；越权 supplier 穿透 | 只按授权查询面投影；miss 在恢复窗口内不否定外部副作用 |
| 取消 vs 补偿 | pending cancel；confirmed cancel/refund pending/refunded | pending cancel 写成 refund；compensated 显示钱已退 | 文案与账本分词一致；confirmed 补偿有 receipt/outcome |
| L4 revoke | policy scope 内自动写一次，撤回后再触发 | revoke 后仍出 outbox；超 scope 自动写 | 撤回阻断未来；超 scope 降 L3 |
| 佣金披露 | 确认卡含佣金/无佣金/赞助来源 | 披露未知仍允许；披露变化沿用旧 receipt | 披露 digest 入 fingerprint |
| 审计脱敏 | 生成 redacted audit report | 错误含 email/token/order raw id | 可分享报告无 PII/secret |

> **派发否证执行口径**：上表标 `(#231/#232)` 的派发权唯一、tenant 边界、attempt fencing 时序、persisted-dispatching crash 无网络日志、lease/fencing/授权过期回 queued、外呼前重验、queue/preflight 本地拒绝层级、fingerprint 绑定 supplier payload、lease 过期+迟到 success 各行，是 #231/#232 未来实现时**必须执行**的最小否证验收；当前为 proposal，这些测试**均未执行**，不得伪称已通过。最小否证清单：① 双 dispatcher 竞争同一 intent 只发一次，且 A/B 相同 `idem_key` 只能各自 claim/fold/query 本 tenant intent，跨 tenant 影响行数=0、supplier write=0；② 只有 claim 事务未提交才回 queued——attempt 持久化后/网络前与网络后/投影前任何 crash（无网络日志亦然）都不盲重放、不 book，统一 unknown；③ queue/preflight 本地拒绝零写，旧 effect 置 `rejected` 不回 queued，且不改变 ADR-17 `pending_writes` `pending|confirmed|compensated` 三态、不投影 supplier failure/refund；④ 确认后更改 holder/guests 或 Buyer 零写；⑤ lease/fencing/授权过期不能把 unknown 或 persisted dispatching 回 queued；lease 过期且迟到供应商成功仍仅一次 book。

## 13. 与既有设计的让渡关系

- `booking-saga-fsm.md` 继续是 saga 字母表与边表权威；本文只定义 M5 生产化时每条边携带哪些 receipt/outbox/outcome 字段。
- `effect-interpreter.md` 继续是 effect seam 权威；写 effect 注册时必须新增 per-effect resilience 策略，默认全关，不得继承读 effect 的重试。
- `transactional-state-rfc.md` 继续是 ADR-15 账本基座；本文不改 TS-5 触发器。
- `milestone-delivery-plan.md` 是 program 任务图；HotelByte adapter、协议核验、UAT 与基线稳定性债务在那里跟踪。
- `m6-b2b-reuse-walkthrough.md` 承接 sponsor/principal 披露与 B2B 复用口径；M6 不得复用 BFF 安全 principal 词义承载 traveler 动机。

## 14. M5 Entry/Exit 勾稽

**Entry 必须同时满足**：

1. M4 Exit：真实 `observed_private` repeat cohort N≥5 且 paired median planning duration reduction ≥50%，experience reflux baseline 有真实分母。
2. 供应链协议：HotelByte M5-0 矩阵字段可得，尤其是 Buyer/环境/路由、稳定查单键、报价有效期、取消/退款/佣金/售后字段、人工对账 SLA 与 UAT 边界。

**交易测试所需具体范围**：

- pre-entry：只允许无凭据 help/参数/fixture 检查，不发业务网络，不读 OTP。
- entry 后 sandbox/UAT：固定 `hbcli` 版本、隔离 credential home、受控 env、固定 Buyer/route、`--json --env=uat` 前缀、全退政策约束；任何 OTP 操作由供应商/人工流程处理，GoTry 不接触。
- production：真实下单/取消/退款只在 receipt + disclosure + unknown reconcile + manual support 路径均过闸后进入。

**Exit 仍沿用 roadmap**：预订零误操作事故；单位经济实测。本文不改 Exit，也不允许用 sandbox 通过替代真实事故/单位经济证据。
