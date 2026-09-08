# WriteGate 生产化设计提案(issue #225 / M5)

> 定位:M5 交易闭环前的 WriteGate 生产化 proposal,定义授权 receipt、一次确认、供应商未知态、对账/补偿、佣金披露与 HotelByte 首供应链接入边界。
> 状态:proposal(2026-09-08;只设计,不启封任何预订/支付实现)
> 上游:[`../roadmap.md`](../roadmap.md) M5、[`../architecture.md`](../architecture.md) ADR-15/17/18/23、[`../rfc/transactional-state-rfc.md`](../rfc/transactional-state-rfc.md) §4.3、[`booking-saga-fsm.md`](booking-saga-fsm.md)、[`effect-interpreter.md`](effect-interpreter.md)、[`milestone-delivery-plan.md`](milestone-delivery-plan.md)、issue #136/#225。
> 下游:M5 Entry 后的 WriteGate core/outbox/supplier adapter 实现 PR;B2B sponsor 披露面见 [`../milestones/m6-b2b-reuse-walkthrough.md`](../milestones/m6-b2b-reuse-walkthrough.md)。

## 0. 摘要

1. **Entry gate 不变且只有两项**:M5 只有在 M4 Exit + 供应链协议同时满足后才能实现;本文不新增第三个 founder 启封 gate,也不改变 roadmap Exit/Entry。
2. **首供应链已选定**:用户明确 M5 首接 `hotelbyte-cli`,参考 `/Users/danceiny/work/hotel-be`。当前是只读调查与契约准备,不推定商业协议已签。
3. **核心不变量**:任何 booking/payment/refund 类写 effect 必须先有 `pending_writes` L2 intent,再有一次性 L3 receipt;没有 receipt 就没有外部副作用。
4. **receipt 绑定的不是按钮,而是请求指纹**:request fingerprint 必含 actor、tenant、traveler principal、供应商、商品/报价、金额、币种、条款 digest、有效期、展示版本与随机 nonce。
5. **本地 outbox 不等于外部 exactly-once**:GoTry 可保证同一 ledger intent 只消费一次并只登记一个 write effect intent;外部副作用是否重复依赖供应商幂等/可查重。unknown 禁止盲重试。
6. **供应商 unknown 是一等结果**:超时、进程退出、非 JSON 或连接断开后可能已产生外部副作用;进入查单或人工对账,用户可见文案不得写成失败或退款。
7. **取消 ≠ 补偿 ≠ 退款到账**:pending 未执行的取消只是 local cancel;confirmed 后的退改才是真实补偿;HotelByte 的取消单、退款单、钱包退款与手续费必须分开投影。

## 1. 非目标与红线

- 不实现生产预订、支付、出票、退款或供应商 adapter。
- 不新增运行时框架;仍复用 ADR-15 单 SQLite 账本、ADR-17 `booking_saga_fsm.v1` 与 ADR-18 effect interpreter。
- 不用 sandbox fixture 宣称 M5 Exit;fixture 只能证明闸语义。
- 不把供应商 API 的“请求已发出”或 CLI `exit 0` 写成“预订成功”;success 必须来自供应商 confirmation、`result.status=verified` 或可查单结果。
- 不在公开审计日志存证件号、手机号、邮箱、银行卡、cookie、OTP、支付 token、订单原号或原始对话。
- 不复制 `/Users/danceiny/work/hotel-be` 内部代码;HotelByte 只能经公开 MIT `hotelbyte-cli`、子进程 bridge 与供应链协议进入 GoTry。

## 2. HotelByte 首供应链已确认事实与未证前提

### 2.1 只读核实快照

- `hotel-be`: `16467805bb454df89fc894a7823da674348566e3`。
- `external/hotelbyte-cli`: `d62030bb9c132e5797e07371c5af0d2b97fdb819`。
- CLI 包名/版本:`staicli@0.0.2`;bin:`hbcli`。
- GoTry 总纲 §2 已规定:内部 `hotel-be` 只 bridge/reference;公开 MIT `hotelbyte-cli` 可 import/extend;默认仍经子进程调用。

### 2.2 真实入口(当前调查,未等于协议)

| 阶段 | CLI/API | 设计含义 |
|---|---|---|
| rate | `search hotel-rates` → `/api/search/hotelRates` | 保存 `sessionId`/`ratePkgId`;后续 check/book 依赖同 session 语义 |
| availability | `search check-avail` → `/api/search/checkAvail` | 可用 `status=1`;必须保留原币种金额、取消政策、报价来源 |
| book | `trade book` → `/api/trade/book` | 需要 `sessionId`/`ratePkgId`/`holder`/`guests`;后端校验 session 缓存 CheckAvail |
| query | `trade query-orders --customer-reference-nos` → `/api/trade/queryOrders` | 权限过滤后的平台订单查询;OpenAPI 用户不能 supplier 穿透 |
| cancel | `trade cancel` → `/api/trade/cancel` | 需要 `customerReferenceNo` + 响应给客户的 `supplierReferenceNo`;CLI 没有 refund 命令 |

### 2.3 必须保留为 TODO 的前提

1. **协议未签**:Buyer、环境、供应路由、佣金/售后字段、人工对账 SLA、真实 UAT 范围仍待核验。
2. **`customerReferenceNo` 不是永久幂等**:CLI 可选但 GoTry 必须强制持久化。后端以 Buyer+ref 重用在途/成功单,Cancelled/Failed 允许同 ref 再建;同授权 intent 只绑定不可变 attempt,新订单须新授权。
3. **30s CLI abort + 长恢复窗口**:CLI HttpClient 默认 30 秒 abort;后端恢复 180 秒 Phase1 再最长 10 分钟 Phase2,迟到订单可自动取消。GoTry timeout/进程退出/非 JSON = unknown,先查单并遵守恢复窗口。
4. **身份隔离未具备通用 selector**:当前 CLI/后端 SHA 未找到 `tenantEntityId` selector 或 `DistributorOption`;M5 首接只能固定一个授权 Buyer/供应路由。M6 或多 route 前必须由上游提供真实 selector + session/order 绑定 + 错配拒绝。
5. **取消/退款字段不能简化**:`supplierReferenceNo` 可能是平台订单号,不得自行解码;`cancel.serviceFee` 不是客户退款金额;订单、取消、退款单、钱包退款是不同 outcome。
6. **UAT ONLINE Book 有 OTP/全退政策要求**:CLI 无 test/OTP 通道。不得绕过、不得读 OTP、不得做真实交易。
7. **现有 GoTry 只读 hbcli 桥不可复用为交易边界**:`ts/capabilities/hbcli.ts` spawn 继承 `process.env`,默认 uat/token env 注入,超时 SIGKILL,只看 exit 0 再尝试 JSON,读失败可静态回退;交易 adapter 必须新建受控 env/credential home/identity boundary。

## 3. 词汇与对象

| 词汇 | 责任 | 必填字段/约束 |
|---|---|---|
| `WriteIntent` | L2 建议态,只登记不执行 | `idem_key`,`tenant_id`,`actor_ref`,`principal_ref`,`seam`,`payload_digest`,`created_at`,`expires_at`;现有入口为 `requestPendingWrite` |
| `RequestFingerprint` | 用户看到并授权的规范请求 | canonical JSON 后 SHA-256;字段见 §4;任何金额/币种/条款/候选变化都会换 digest |
| `ApprovalReceipt` | L3 一次性确认凭证 | `receipt_id`,`idem_key`,`request_fingerprint_sha256`,`actor_ref`,`tenant_id`,`principal_ref`,`amount_total`,`currency`,`terms_digest`,`valid_until`,`approved_at`,`presentation_key`,`delivery_nonce_digest` |
| `ApprovalClaim` | nonce/receipt 一次消费权威 | 写入 `events` 时使用唯一 `idem_key=approval:<receipt_id>` 或独立唯一表;必须与 outbox intent 同一 SQLite 事务 |
| `WriteEffectIntent` | outbox 中待执行的外部副作用意图 | `effect_name`,`idem_key`,`supplier_attempt_key`,`request_fingerprint_sha256`,`attempt_budget`,`next_action` |
| `SupplierOutcome` | 供应商结果投影 | `success | failed | unknown | reconciled_success | reconciled_failed | cancel_submitted | refund_pending | refunded | compensated_failed`,附供应商 receipt/refund digest |
| `RedactedAuditEvent` | 可分享审计面 | HMAC 假名主体 + digest + 金额/币种/条款版本;不含 PII/secret/raw supplier payload |

`pending_writes.status` 继续只用 ADR-17 的 `pending | confirmed | compensated`。供应商 `unknown` 不塞进 saga 状态字母表,而是 `SupplierOutcome` 投影:本地已经消费 receipt 并进入 confirmed,但外部世界尚未可判。这样不推翻 `booking_saga_fsm.v1`,又能诚实表达对账状态。

## 4. Request fingerprint 字段

request fingerprint 必须由代码 canonicalize,并在展示卡、approval receipt、supplier write effect 三处同源引用。

| 字段 | 说明 | 变更后果 |
|---|---|---|
| `schema` | `gotry_write_request_fingerprint.v1` | 不匹配即拒绝确认 |
| `tenant_id` | 账本租户;M6 前也必须存在 | tenant 不同即不同请求 |
| `actor_ref` | 发起确认的人或 L4 策略,HMAC 假名 | actor 变化需要重确认 |
| `principal_ref` | traveler principal,HMAC 假名;B2B 中不等同 sponsor/BFF principal | principal 变化需要重确认 |
| `sponsor_ref` | 可选,HMAC 假名;仅 B2B/合作库存 | sponsor 变化需要重披露 |
| `seam` | 具名 seam,如 `hotelbyte-hotel-book-confirm` | 未登记 seam fail-closed |
| `supplier` | vendor/channel + CLI/API version + Buyer/route digest | vendor 或身份路由变化需要重确认 |
| `product_ref` | `sessionId`/`ratePkgId`/offer digest;不存 PII | offer 变化需要重确认 |
| `travel_terms` | 入离店、人数、房型、早餐、取消政策、税费等 digest | 条款变化需要重确认 |
| `amount_total` | 用户授权总金额,最小货币单位;保留原币种 | 金额变化需要重确认 |
| `currency` | ISO 4217 或供应商原币种映射 | 币种变化需要重确认 |
| `commission_disclosure` | 佣金/赞助/返利口径 digest,可为 none 但必须显式 | 披露变化需要重确认 |
| `valid_until` | 报价/授权有效期,必须早于供应商 quote expiry | 过期拒绝确认 |
| `presentation_key` | 用户实际看到的卡片版本 digest | 卡片重排/删字段需要重确认 |
| `delivery_nonce_digest` | 随机 nonce digest;抵抗重放 | nonce 已用或不匹配拒绝 |

## 5. 状态机与执行序列

### 5.1 L2:建议态只落 pending

1. planner 生成可写建议时,调用现有 `requestPendingWrite`。若未来新增 facade,必须在实现 PR 中显式定义,不得在设计中凭空造入口。
2. `payload` 内只存可展示语义与 digest;敏感旅客/支付字段不进账本。
3. 同一 `tenant_id + idem_key` 重复提议是 no-op,返回既有 pending/confirmed/compensated 状态。
4. 展示卡必须包含总价、币种、条款摘要、有效期、取消规则、佣金/赞助披露与“确认只消费一次”。

### 5.2 L3:一次确认消费 receipt

确认处理必须在一个 SQLite 事务中做完:

1. 读取 pending intent,校验 tenant/actor/principal/seam 匹配。
2. 重算 request fingerprint,与 receipt digest 逐字节一致。
3. 校验 `valid_until` 未过、presentation_key 是实际呈现版本。
4. 写入 `ApprovalClaim` 一次性权威:复用 `events(tenant_id, idem_key)` 唯一约束时,`idem_key=approval:<receipt_id>`;或实现新表 `approval_claims(tenant_id, receipt_id PRIMARY KEY, nonce_digest, request_fingerprint_sha256, consumed_at)`。
5. `UPDATE pending_writes ... WHERE status='pending'` 消费 pending;影响行数必须为 1。
6. 追加 `write.confirmed` 与 `WriteEffectIntent` outbox intent。

`ApprovalClaim` 与 `WriteEffectIntent` 必须同事务落账:若 claim 已写而 outbox 未写,重启会卡成“receipt 已消费但无动作”;若 outbox 已写而 claim 未写,重放会二次消费。实现 PR 必须用崩溃注入覆盖两种顺序。

并发场景下,两个确认请求只有一个能更新行并写出一个 effect intent;另一个返回 `already-confirmed`、`approval-claimed` 或 `absorbed-compensated`,不得再次执行 supplier effect。

### 5.3 outbox:崩溃恢复与“本地一次”口径

- **确认前崩溃**:仍是 pending,用户可重新确认;旧 nonce 若未消费,按有效期处理。
- **确认事务后、supplier 前崩溃**:outbox intent 存在但未 attempt;worker 重启后执行该 intent。
- **supplier 调用中崩溃/超时/非 JSON/进程退出**:状态进入 `unknown`,先按 supplier attempt key、`customerReferenceNo` 或查单 API 对账;禁止直接重放 write effect。
- **supplier success 后、投影前崩溃**:通过供应商 receipt/order lookup fold 为 success;若 lookup 不可用则 manual reconcile。
- **supplier failed 明确返回**:记录 failed outcome;如供应商确认未产生外部副作用,可按用户选择重新生成新 quote/intent。

供应商若不支持稳定查单键或人工对账 SLA,该供应商不能进入自动 production WriteGate;只能保持人工处理或不接入。

## 6. HotelByte adapter 准入矩阵

| 维度 | 必须设计/验证 | 最小 fixture E2E | 真实 UAT gate |
|---|---|---|---|
| CLI source | 固定 `hbcli` 路径、版本、`--json --env=uat` 前缀;不假定 flag 任意位置等价 | `trade book --help` exit0;`--tenant-entity-id` exit1 unknown option | 使用约定版本;版本漂移 fail-closed |
| credential boundary | 隔离 credential home + 受控 env;不继承 GoTry 全 `process.env` | fake home 不存在时零凭据读取;错误脱敏 | 固定 Buyer/环境/路由由协议授权 |
| quote snapshot | `sessionId`/`ratePkgId`/check-avail status/金额/币种/取消政策/来源 digest | check-avail fixture status=1/0/changed | 真实 quote 有有效期与取消条款 |
| booking | 强制 `customerReferenceNo` 持久化;同 intent 不可变 attempt | `verified`/`pending`/`failed`/exit0-but-pending 均正确投影 | UAT Book 在合法全退政策下执行;OTP 不由 GoTry 读取 |
| unknown | 30s abort/timeout/non-json/kill 均 unknown | unknown 后只 query/manual reconcile,不重订 | 遵守 180s + 最长10min 恢复窗口 |
| query-orders | 只按 `customerReferenceNo` 查权限内平台订单 | query success/miss/multiple/permission-denied | 人工对账字段足够,无需原始聊天 |
| cancel | 需要 `customerReferenceNo + supplierReferenceNo`;CLI 无 refund | cancel submitted/failed/serviceFee not refund | 取消、退款单、钱包退款有真实字段来源 |
| multi-route | 当前无 selector,只能固定一个 Buyer/route | `--tenant-entity-id` 负例 fail-closed | 上游提供 selector/session/order 绑定前不得多 route |

## 7. 供应商未知态与人工对账

unknown 的用户文案必须是“结果未知,正在对账”,不是“失败”也不是“已退款”。

| 场景 | 账本状态 | 用户文案 | 后续动作 |
|---|---|---|---|
| pending 未确认取消 | `compensated` | 已取消本地建议,没有下单/扣款 | 无供应商动作 |
| 确认后 CLI timeout/abort/non-json | `confirmed` + `SupplierOutcome.unknown` | 供应商结果未知,不要重复下单;已进入对账 | `query-orders` 或人工对账 |
| 查单发现成功 | `confirmed` + `reconciled_success` | 预订已确认,给出供应商回执摘要 | 后续取消走补偿 |
| 查单发现未发生 | `confirmed` + `reconciled_failed` | 未产生订单/扣款;可重新报价 | 新 intent + 新 receipt |
| cancel 已提交但退款未到账 | `compensated` + `refund_pending` | 已提交退改,退款状态待更新 | 后续查单/钱包恢复投影 |
| refund 到账 | `compensated` + `refunded` | 已按供应商规则退款到账 | 展示金额/币种/手续费来源 |

人工对账需要最小字段:tenant、idem_key、`customerReferenceNo`、supplier attempt key、request fingerprint digest、时间窗、金额/币种、供应商候选 digest。不得要求人工查看用户原始聊天或 cookie。

## 8. 取消、补偿与退款分词

- `pending → compensated`:**取消本地建议**。外部副作用未发生,不得写“退款”。
- `confirmed → compensated`:**真实补偿流程**。必须有供应商取消/退款/改签 receipt 或明确失败原因。
- HotelByte `trade cancel` 不是 refund 全链闭合;取消、退款单、钱包退款、手续费、客户退款金额必须分开 outcome。
- unknown 期间不允许用户发起第二个同类订单;只能选择“等待对账 / 人工联系 / 放弃并承认风险”。若供应商协议允许按 `customerReferenceNo` 安全取消 unknown 请求,也必须记录为 external compensation attempt。

## 9. L4 自动类与撤回

L4 不是“无确认”,而是“用户预先确认一条可撤回策略”。策略本身需要 L3 receipt:

- scope:供应商、目的地/日期范围、金额上限、币种、人数、库存类型、有效期。
- guard:每笔自动写仍重算 request fingerprint;超 scope 即降级 L3。
- revoke:撤回是账本事件,立即阻断未来 effect intent;已执行的 effect 只能走补偿,不能被撤回抹除。
- audit:每笔自动写的 receipt 标注 `approval_mode='l4_policy'`、policy digest、当次 request fingerprint。
- expiry:策略必须到期;续期需要新 receipt。

## 10. 佣金/赞助披露

每个可写卡片在确认前必须披露:

1. 用户支付总价与币种。
2. GoTry/合作方是否获得佣金、返利、赞助或优先展示收益。
3. 披露来源:供应商字段、合同规则、或“无收益”。未知不得默认为无。
4. B2B 下 sponsor 收益和 traveler 动机分开呈现;披露 sponsor 收益不等于满足 traveler 动机。
5. 披露 digest 纳入 request fingerprint;披露变化使旧 receipt 失效。

M6 sponsor 披露槽位仍保持 proposal:优先由 sponsor 插件注入渲染片段,避免内核感知 sponsor。若 M5 C 端先行需要 schema 预留,必须保持 B2C 空值显式可审计。

## 11. 审计与脱敏

| 数据 | 公开/可提交 | 私有/本地 | 禁止 |
|---|---|---|---|
| tenant/actor/principal/sponsor | HMAC-SHA256 假名 | salt/key 私有 | 姓名、邮箱、手机号 |
| request | SHA-256 digest + 可展示摘要 | 供应商原 payload 可本地加密保存 | cookie、OTP、支付 token |
| receipt | receipt id + digest + 金额/币种/有效期 | 原始 approval event 可本地保存 | 原始聊天全文 |
| supplier outcome | success/failed/unknown + supplier receipt digest | 查单截图/订单号可本地加密 | 未脱敏订单号进 git |
| errors | reason code + redacted evidence | 详细日志本地 | 反射用户秘密或 raw supplier response |

所有错误输出必须优先 reason code,不得把供应商 raw response 直接塞进 LLM 可见文本。

## 12. 验收矩阵

| 类别 | 正例 E2E | 负例/否证 | 通过条件 |
|---|---|---|---|
| receipt 绑定 | 同一 pending intent 展示后确认;receipt digest 与 request fingerprint 一致 | 金额 +1、币种改、条款 digest 改、presentation_key 改、nonce 复用 | 正例 confirmed + one local effect intent;负例 fail-closed 且无 supplier effect |
| actor/tenant/principal | tenant A actor 确认 A 的 intent | tenant B 用同 idem_key/receipt 确认;BFF principal 当 traveler principal | 跨租户/跨 principal 全拒;审计只见 HMAC |
| 一次确认 | 双并发确认同一 idem_key | 两个进程同时提交 receipt | 仅一条 `ApprovalClaim`,仅一条 `write.confirmed`,仅一条 local effect intent |
| 崩溃恢复 | 确认事务后 kill,重启 worker | claim/outbox 顺序崩溃注入 | 不丢 claim、不重复登记 effect intent;终态可 fold |
| HotelByte unknown | CLI timeout/non-json/exit0 pending fixture | 自动重试同 write effect 或并发重订 | unknown + query/manual reconcile;禁止盲重试 |
| query-orders | customerReferenceNo 查到成功/未发生/多条 | supplierReferenceNo 解码猜测;越权 supplier 穿透 | 只按授权查询面投影 |
| 取消 vs 补偿 | pending cancel;confirmed cancel/refund pending/refunded | pending cancel 写成 refund;compensated 显示钱已退 | 文案与账本分词一致;confirmed 补偿有 receipt/outcome |
| L4 revoke | policy scope 内自动写一次,撤回后再触发 | revoke 后仍出 outbox;超 scope 自动写 | 撤回阻断未来;超 scope 降 L3 |
| 佣金披露 | 确认卡含佣金/无佣金/赞助来源 | 披露未知仍允许;披露变化沿用旧 receipt | 披露 digest 入 fingerprint |
| 审计脱敏 | 生成 redacted audit report | 错误含 email/token/order raw id | 可分享报告无 PII/secret |

## 13. 与既有设计的让渡关系

- `booking-saga-fsm.md` 继续是 saga 字母表与边表权威;本文只定义 M5 生产化时每条边携带哪些 receipt/outbox/outcome 字段。
- `effect-interpreter.md` 继续是 effect seam 权威;写 effect 注册时必须新增 per-effect resilience 策略,默认全关,不得继承读 effect 的重试。
- `transactional-state-rfc.md` 继续是 ADR-15 账本基座;本文不改 TS-5 触发器。
- `milestone-delivery-plan.md` 是 program 任务图;HotelByte adapter、真实协议核验、UAT 与 #227 合并阻断在那里跟踪。
- `m6-b2b-reuse-walkthrough.md` 承接 sponsor/principal 披露与 B2B 复用口径;M6 不得复用 BFF 安全 principal 词义承载 traveler 动机。

## 14. M5 Entry/Exit 勾稽

**Entry 必须同时满足**:

1. M4 Exit:真实 `observed_private` repeat cohort N≥5 且 paired median planning duration reduction ≥50%,experience reflux baseline 有真实分母。
2. 供应链协议:HotelByte M5-0 矩阵字段可得,尤其是 Buyer/环境/路由、稳定查单键、报价有效期、取消/退款/佣金/售后字段、人工对账 SLA 与 UAT 边界。

**交易测试所需具体范围**:

- pre-entry:只允许无凭据 help/参数/fixture 检查,不发业务网络,不读 OTP。
- entry 后 sandbox/UAT:固定 `hbcli` 版本、隔离 credential home、受控 env、固定 Buyer/route、`--json --env=uat` 前缀、全退政策约束;任何 OTP 操作由供应商/人工流程处理,GoTry 不接触。
- production:真实下单/取消/退款只在 receipt + disclosure + unknown reconcile + manual support 路径均过闸后进入。

**Exit 仍沿用 roadmap**:预订零误操作事故;单位经济实测。本文不改 Exit,也不允许用 sandbox 通过替代真实事故/单位经济证据。
