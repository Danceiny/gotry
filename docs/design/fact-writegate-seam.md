# fact-anchor × M5 WriteGate 接缝设计(issue #303,#273 子切片)

> 定位:本切片只定义**接缝**——`gotry_fact_gate` 与 M5 WriteGate 之间谁负责什么、什么可进产物、什么必须 fail-closed。**不实现、不启用任何写路径**。
> 状态:**proposal(2026-09-10,docs-only;不启封 runtime)**
> 上游:[`../architecture.md`](../architecture.md) §1.4 / §8 ADR-15/17/18/19 / §10.1 D-26、[`./write-gate-production-design.md`](./write-gate-production-design.md)、[`./booking-saga-fsm.md`](./booking-saga-fsm.md)、[`./milestone-delivery-plan.md`](./milestone-delivery-plan.md) §4 M5-0..M5-4、issue #136/#225/#231/#232/#233。
> 下游:M5 Entry 后的 WriteGate core/outbox 接线 PR(M5-2/M5-3);`gotry_fact_gate` 本体与 `BookableFact` schema 不动。
> 边界:#273 红线保留——本切片**不**落交易 runtime、**不**发 supplier write;允许 read-only / fixture / failing-test 准备;依赖 #136 M5 admission 与 #231 persistent WriteGate/outbox。

## 0. 一句话主张

读路径 `gotry_fact_gate` 与写路径 WriteGate 是**两套独立的闸**,中间用「读侧 inventory fact(只覆盖读工具结果)+ 写侧 `SupplierOutcome` 投影(只覆盖 booking 业务结果)」分词:写 receipt 不得污染 `BookableFact`,booking 产物不得用 `<!-- fact: -->` 锚点冒充订单证据;non-success / 缺 tenant / 缺 idem / 缺 freshness / 缺 currency / `customerReferenceNo` 未在 supplier 外呼前持久化的 receipt 一律 fail-closed。

## 1. Current:两闸各自闭环、接缝未定义

| 闸 | 责任 | 锚点 / 落账 | 失败面 | 证据 |
|---|---|---|---|---|
| **读**:`gotry_fact_gate`(`ts/src/index.ts:1924` 注册,`ts/src/artifact-gate.ts:492` `gateArtifact`) | 产物 markdown 的可下单 claim 逐条回溯 `BookableFact` 注册表;`renderFlightFact`(`ts/src/bookable-facts.ts:532`)/`renderHotelFact`(`ts/src/bookable-facts.ts:660`)/`renderPolicyFact`(`ts/src/bookable-facts.ts:582`)单向生成 `<!-- fact:<fact_id> -->` 锚点 | `BookableFact = FlightFact \| PolicyFact \| HotelFact`(`ts/src/bookable-facts.ts:40-119`);**无** `tenant_id` / `idem_key`,`FlightFact` 的 `price` / `currency` / `review_by` 皆可选,`HotelFact` 无价格字段(只记 `options_masked`,`ts/src/bookable-facts.ts:94-119`);侧车 `<stateRoot>/gotry-state/bookable-facts.jsonl`(`ts/src/index.ts:1088-1091` `appendFacts`) | `verdict=blocked` ⇒ `presentation: verified_label_forbidden`(`ts/src/artifact-gate.ts:678`);违例清单见 `ts/src/artifact-gate.ts:242-260` | `ts/scripts/fact-gate-tests.ts`(run-all §39) |
| **写**:WriteGate 基座(`ts/src/state-ledger.ts:609/627/643` `requestPendingWrite` / `confirmPendingWrite` / `compensatePendingWrite`) | L2 登记 → L3 确认(携带 receipt 字符串)→ L4 补偿;`pending_writes` schema CHECK `('pending','confirmed','compensated')`(`ts/src/state-ledger.ts:132-142`) | events `write.pending` / `write.confirmed` / `write.compensated`;词汇层 `booking_saga_fsm.v1`(`ts/src/booking-saga.ts:16-46`) | `sagaTraceViolations` 对 `write.confirmed` 空 receipt 即违例(`ts/src/booking-saga.ts:123-125`) | `ts/scripts/booking-saga-tests.ts`(run-all §36) |

**接缝缺失的具体表现**:`requestPendingWrite` / `confirmPendingWrite` 只是账本状态机,**无** `ApprovalReceipt` / `PreparedChallenge` / `delivery_nonce_digest` / `customerReferenceNo` 持久化 / `attempt_id` fencing(`./write-gate-production-design.md` §3 词汇未落地);未来 booking 产物(已锁定/已预订)若走 `renderFlightFact` 同款 `<!-- fact: -->` 锚点,会与读侧 inventory fact 混淆——`BookableFact.bookable_exact_date` 是读侧 exact-date 工具结果语义,**不是** supplier 预订成功证据。

## 2. Proposed:Read fact → 用户明确确认 → WriteGate/outbox → supplier receipt → booking 产物

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant R as Read tools
    participant F as BookableFact (read inventory)
    participant G as gotry_fact_gate
    participant L2 as WriteGate L2 (pending_writes)
    participant UI as Trusted confirm UI (M5 Entry 后)
    participant L3 as WriteGate L3 (approval_claims + outbox)
    participant S as Supplier (M5 Entry 后)
    participant O as SupplierOutcome / 订单证据
    participant A as Booking artifact renderer
    U->>R: 查询机/酒/政策
    R-->>F: appendFacts(hit/miss, query_id)
    R-->>U: 读结果 + evidence chain
    Note over F: 只装读侧 inventory fact,<br/>不含预订结果
    U->>G: gotry_fact_gate(markdown|path)
    G-->>U: verdict=pass ⇒ verified_itinerary_allowed
    U->>L2: requestPendingWrite(idem_key, seam, payload)
    L2-->>U: pending
    Note over L2,L3: idem_key + immutable attempt +<br/>customerReferenceNo 在 supplier<br/>外呼前已同事务持久化(不可<br/>由返回 receipt 反向派生)
    U->>UI: 真人确认回调
    UI->>L3: confirmPendingWrite(idem_key, ApprovalReceipt)
    L3->>S: dispatch(M5 Entry 后)
    S-->>O: SupplierOutcome(success/unknown/...)+ 订单证据
    O-->>A: 绑 SupplierOutcome, 不绑 BookableFact
    A-->>U: 产物 verified 须双轨:<br/>① 读 fact 闸 pass<br/>② 写 SupplierOutcome.success<br/>&nbsp;&nbsp;或 reconciled_success<br/>③ 同 attempt_id + customerReferenceNo<br/>&nbsp;&nbsp;派发前已同事务持久化
```

### 2.1 读侧契约(当前形态即最终形态)

| 步骤 | 责任 | 落点 | 闸判定 |
|---|---|---|---|
| ① Read → inventory fact | `gotry_flyai_search` / `gotry_session_search` / `gotry_hotel_search` / 政策生产端 | `bookable-facts.jsonl` | hit/miss/error;error 不落负事实 |
| ② Fact → artifact claim | `renderFlightFact` / `renderHotelFact` / `renderPolicyFact`(`ts/src/bookable-facts.ts:532/582/660`) | artifact 行尾 `<!-- fact:<fact_id> -->` | `gotry_fact_gate` 锚点确定性回溯(`ts/src/artifact-gate.ts:506-535`);锚点缺失 = `fact_anchor_unknown` |

### 2.2 写侧契约(仅契约,M5 Entry 后实现)

| 步骤 | 责任 | 落点(未实现,见 [`./write-gate-production-design.md`](./write-gate-production-design.md) §3) | 闸判定 |
|---|---|---|---|
| ③ L2 pending | `requestPendingWrite`(`ts/src/state-ledger.ts:609`) | `pending_writes(tenant_id, idem_key, seam, payload, status='pending')` | `idem_key` UNIQUE;**同 intent 重复 = 幂等返回既有 `confirmed` 状态**,产物可显示既有预订 |
| ④ 派发前持久化绑定 | 赢得 claim 前(同事务) | `approval_claims(receipt_id PK, challenge_id, idem_key, nonce_digest, request_fingerprint_sha256, ...)` + `WriteEffectIntent(dispatch_status, attempt_id, fencing_token, customer_reference_no, ...)` | `idem_key` / `attempt_id` / `customerReferenceNo` 在任何 supplier/network 调用**前**已落账,**不可**由回执反向派生([`write-gate-production-design.md` §5.3 / §5.4](./write-gate-production-design.md)) |
| ⑤ 可信人类确认 | 真人回调(M5 Entry 后) | `PreparedChallenge.status='confirmed'` → `confirmPendingWrite(idem_key, ApprovalReceipt)`(`ts/src/state-ledger.ts:627`) | `ApprovalReceipt` = 授权凭证,≠ 业务结果;真人回调 ≠ 模型/客户端拼装;空 receipt = `sagaTraceViolations` 违例 |
| ⑥ Supplier → outcome | M5-3 supplier adapter | `SupplierOutcome` 投影(`success / failed / unknown / reconciled_success / reconciled_failed / cancel_submitted / refund_pending / refunded / compensated_failed`),**独立于 `BookableFact`** | unknown 禁盲重写,只 query 或 manual reconcile |

### 2.3 booking 产物 verified 标签 = 读 + 写双轨

booking 类产物只有**同时**满足下列两条才能标 verified/已预订方案:

1. **读侧**:`gotry_fact_gate` verdict=pass(`ts/src/artifact-gate.ts:678` 既有语义,不变);
2. **写侧**:绑定到 `SupplierOutcome.success` 或 `SupplierOutcome.reconciled_success`(见 [`write-gate-production-design.md`](./write-gate-production-design.md) §3) + 同一 `attempt_id` / `customerReferenceNo` 已在派发前同事务持久化(`dispatch_status='dispatched'` 单独**不**构成 booking verified);**而非** `BookableFact.bookable_exact_date`(`bookable_exact_date` 是读侧 inventory 语义,不是订单结果)。

> **手写 `<!-- fact: -->` 锚点不得冒充订单证据**——锚点 `fact_id` 不在 `BookableFact` 注册表 = `fact_anchor_unknown` blocked;手写锚点写入「已预订」措辞同样 fail-closed。booking 类渲染原语(M5-3 落地的 `renderBookingFact` 等)与 `renderFlightFact` / `renderHotelFact` **同形但不同源**,不可互证。

### 2.4 Fail-closed 矩阵

| 形态 | 来源 | 接缝判定 |
|---|---|---|
| `pending` 仍挂起 / `confirmed` 已登记 | `ts/src/state-ledger.ts:609/627` 的 `requestPendingWrite` / `confirmPendingWrite` **只是账本状态机**,按 receipt 字符串推进 `pending_writes` 词汇;`sagaTraceViolations` 对空 receipt 违例(`ts/src/booking-saga.ts:123-125`)。**当前 `confirmPendingWrite` 不识别"业务失败"或不返 `ok:true`**——失败/unknown 由未来 `SupplierOutcome.failed` / `unknown` 表达(见 [`write-gate-production-design.md` §3](./write-gate-production-design.md)) | 不入 `BookableFact`;产物只能写「本地已登记,待 SupplierOutcome」 |
| Supplier `unknown` | 见 [`write-gate-production-design.md` §5.3 / §7](./write-gate-production-design.md)(outbox 崩溃恢复 / CLI timeout / 非 JSON / 进程退出 / 30s abort) | 进 `SupplierOutcome.unknown`;**禁盲重试**;继续 query 或 manual reconcile |
| `compensated`(本地取消) | `ts/src/state-ledger.ts:643-655` | 只能写「已取消本地建议」;**不得**写「退款」(未发生外部副作用) |
| **同 intent 重复 receipt** | `requestPendingWrite` `idem_key` UNIQUE 命中既有 `confirmed` | **幂等**:可读既有 `confirmed` 状态,产物可显示既有预订;**不**触发副作用 |
| **跨 intent replay 同一 receipt/challenge/nonce** | 见 [`write-gate-production-design.md` §5.2](./write-gate-production-design.md)(receipt 原子消费) | `approval-claimed`;无新 outbox、无新 effect |
| 外呼前过期(`valid_until` / `presentation_key` 漂移 / 撤回) | 见 [`write-gate-production-design.md` §5.5](./write-gate-production-design.md)(外呼前派发点重验) | supplier write=0,旧 effect 置 `rejected`(outbox 层,非 saga);另建新 quote/intent/receipt |
| 缺 `tenant_id` / `idem_key` / `customerReferenceNo` 持久化 | `ts/src/state-ledger.ts:83-92` + [`write-gate-production-design.md` §5.4](./write-gate-production-design.md) 强制派发前落账 | 任一缺 = 外呼前 fail-closed,无 supplier effect |
| `currency` 缺失/不匹配 / `HotelFact` 误写价格 | `ts/src/bookable-facts.ts:100-119` 接口无 price;`ts/src/artifact-gate.ts:464-480` | `unverified_price_claim` blocked;酒店 `priceRaw` 不参与硬价比对 |

## 3. 不在本切片

- **不改 `BookableFact` schema**:当前接口字段以源码为准(`ts/src/bookable-facts.ts:40-119`),**不**为接缝引入 `tenant_id` / `idem_key` / 必填 `currency` / 必填 `review_by` / `HotelFact` 价字段——它们是未来 typed receipt envelope proposal([`write-gate-production-design.md` §3 / §4](./write-gate-production-design.md))。
- **不实现 trusted UI security chain**:`ApprovalReceipt` / `PreparedChallenge` / `delivery_nonce_digest` 仍是 [`write-gate-production-design.md` §3](./write-gate-production-design.md) 词汇定义;`confirmPendingWrite` 当前只是账本状态机(`ts/src/state-ledger.ts:627`),**无** challenge/nonce/receipt envelope、**不**识别业务结果、**不**提供 trusted UI 安全链验证。
- **不预写新闸违例类 / `renderBookingFact` / `approval-claimed` 等**:留给 M5-2/M5-3 PR。
- **不改 ADR-17 三态**:`pending|confirmed|compensated` 不扩;`rejected` 仅在 outbox/dispatch 层([`write-gate-production-design.md` §5.5](./write-gate-production-design.md))。

## 4. 依赖与未触发

- **#136 M5 admission**:供应链协议签署/内部授权证据待核验;`./milestone-delivery-plan.md` §4 M5-0 TODO。
- **#231 持久 WriteGate/outbox**:`approval_claims` + `write_effect_intents` + 原子 claim / attempt fencing;M5-2 TODO。
- **#232 HotelByte trade adapter**:M5-3;`SupplierOutcome` 投影在此落地。
- **#233 cancel/refund/wallet + commission 披露**:M5-4。
- **#273 父红线**:本 proposal **不**落交易 runtime、**不**发 supplier write;允许 read-only / fixture / failing-test 准备;**未来**任何 runtime 变更(写侧 `approval_claims` / `WriteEffectIntent` schema、`SupplierOutcome` 投影、新闸违例类、trusted UI security chain 等)仍须按 [`../architecture.md`](../architecture.md) §11 同步六状态面。

**M5 Entry** = M4 Exit + #136 同时满足(M4 Exit 仍 D-19 未到);本提案自身**不**落交易 runtime、**不**发真实 supplier write;Entry 前仍可按 #273 做 read-only / fixture / failing-test 准备。

## 5. §11 状态面同步

本切片**无**当前 runtime 形态变化(读侧 `gotry_fact_gate` 与 `BookableFact` 不动;写侧 `pending_writes` 与 `booking_saga_fsm.v1` 不动),故本 PR 不触发 §11 六状态面同步。**未来** M5-2/M5-3 落地若引入 `approval_claims` / `write_effect_intents` schema、`SupplierOutcome` 投影、新闸违例类、trusted UI security chain 等形态变化,由对应 PR 按 [`../architecture.md`](../architecture.md) §11 规则同步六状态面,本文档不豁免该责任。
