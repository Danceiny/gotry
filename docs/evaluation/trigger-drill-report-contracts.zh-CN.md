[English](trigger-drill-report-contracts.md) | [简体中文](trigger-drill-report-contracts.zh-CN.md)

# 触发演练报告：三个休眠 tracker 的契约层演练

> 定位：记录三次模拟触发演练（#340、#339、#429）在契约层究竟证明了什么，以及明确没有证明什么。
> 状态：living；三个演练 tracker（#340、#339、#429）已于 2026-10-05 以 **deferred 关闭，而非完成**——下文每条路径仍默认关闭，真实触发到达时需另开新 issue。
> 上游：[architecture.md](../architecture.zh-CN.md) D-39 行与 §10、[WriteGate 生产设计](../design/write-gate-production-design.zh-CN.md)、[记忆设计](../design/memory-design.zh-CN.md)、[loopx 启发升级 RFC](../rfc/loopx-inspired-upgrades-rfc.zh-CN.md)。
> 下游：三个 tracker 的审阅者，以及真实触发到达后落地准入切片的执行者。

## 1. 证据边界（先读这一节）

**模拟的触发不是真实触发。** 本报告每一条结果都带标签 `simulated_trigger_drill` / `fixture_contract`：激活机制是在夹具与 mock 上建起来并跑通的，目的是真实触发出现时路径已经通。这些都不满足任何 tracker 的触发条件。

具体说，本报告任何内容都不计作：

- 真实订单、真实退款或 WriteGate 准入证据（#340）；
- 真实使用样本、经验证的场景词表或城市场景画像（#339）；
- 具名供应商、许可、覆盖率与新鲜度实测，或供应商可用性（#429）；
- M4/M5/M6 Exit，或任何里程碑的出口。

三个 tracker 已于 **2026-10-05 以 deferred 关闭——不是完成**，且每条路径仍 **默认关闭**。这在代码里是结构性的，不是约定：`OUTCOME_TRIGGER_FIRED`、`CITY_SCENARIO_TIER_TRIGGER_FIRED`、`D39_LIVE_ROUTE_TRIGGER_FIRED` 三个闸都冻结为 `false`；供应商终态源注册表、城市场景 taxonomy 注册表、活体路线供应商注册表三者都冻结为空；产品面没有任何文件 import 这三个模块。

「产品路径零改动」有一个例外，明说：本次演练在已获准的窄范围 D-39 路径上查出一处产品可达的信息泄漏，该缺陷**已修复**——`ts/capabilities/ground-transfer.ts` 现在把供应商失败文本经共享脱敏器输出（§5.4，GAP-429-3）。这是对既有暴露面的安全修复，不是对任何新路径的准入：没有具名供应商、没有路径获准，解析语义、原因前缀与静态回退逐字不变。2026-10-05 的后续一轮以同样方式关掉了 D-39 剩下的两处契约缺口（§5.4，GAP-429-1／2）：供应商自述的模式与解析端点在存在时会被核对，矛盾即失败关闭、回落到静态估算。这同样不是准入——仍然没有具名供应商、没有路径获准，既有每一条原因字符串与结果都逐字不变。

零网络、零 LLM、零凭据、零子进程、零共享状态。全部工作在隔离 worktree 内完成。

## 2. 速览

- 新增三个纯契约模块与三套定向测试，全部默认关闭、产品面零调用方：**345 条断言全绿**（155 + 83 + 107，最后一项已含 2026-10-05 的 GAP-429-1／2 回归），typecheck 退出码 0，隔离 smoke 退出码 0，内核清单闸零漂移。
- #340：关联键、终态词表、append-only 可撤销投影、负面清单，以及「偏差校准永不能压过预算硬约束」的守卫，全部结构化编码并逐条证伪。
- #339：**只交机制**——版本化 taxonomy schema 加一个**空**注册表。代码里零分级内容，且触发闸为 false 时准入在校验之前即被拒。候选场景词表以明确标注为未验证假设的形式写在 §4.4。
- #429：一套九条条款的合规闸，任何未来活体路线适配器都必须过。拿它实跑既有 ground-transfer 逻辑，查出 **三处真实缺口**（§5.4）。
- **三处缺口现已全部修复**：GAP-429-3（供应商错误原文到达工具结果）在本演练一轮修掉；另两处休眠缺口（GAP-429-1／2：响应侧的模式与方向绑定）在 2026-10-05 的后续一轮修掉，并把它们钉住的特征化断言翻转为拒绝回归。

## 3. 演练一 —— #340 成交结果与规划估算对比

### 3.1 模拟了什么触发

#340 的真实触发是「供应链协议与 WriteGate 准入成立，且能取得真实订单/退款权威事实」。它没有发生。本次演练以**只读复用 hotelbyte 假 CLI 的终态词表**作为夹具来模拟——词表来自 `ts/scripts/hotelbyte-spawn-e2e-tests.ts` 与 `ts/capabilities/hotelbyte-transaction.ts` 里已有的观测结果。真实 CLI 从未被调用。

### 3.2 建了什么、跑了什么

`ts/src/outcome-projection.ts` —— 纯函数、零 IO、注入时钟、封闭错误码集、fail-closed：

- **关联键**：四个必填键（规划估算、不可变报价、供应商 attempt、账本 intent 幂等键）加一个确定性派生的 `projectionKey`。任何键都不默认、也不从兄弟键推导。
- **币种与时间口径**：复用 fx-contract 的 `MoneyAmount` / `NormalizedAmount` 类型。偏差要求两侧钉在**同一个声明的估值时点**；跨币种比较只能经该时点上的真实汇率事实完成，混时点口径一律拒绝。任何汇率都不猜。
- **终态词表**：`pending / confirmed / failed / cancelled / refunded / unknown`。`confirmed` 是唯一的成交成功；`unknown` 与 `pending` **永不**记成交、**永不**记零偏差——它们返回类型化拒绝且不带任何数值，因此根本不存在一个 0 被误平均。本地账本词 `compensated` 作为供应商终态被按名拒收，取消服务费作为退款额被拒。
- **append-only 可撤销投影**：同幂等键同载荷的重放是零条目 no-op；同键异载荷是冲突，绝不覆盖。撤销本身是一条追加条目——不删不改——fold 跳过被撤销的观测。**迟到**终态观测（观测时刻早于上一次探针、但到达在其之后）被接纳并标记；终态永不回退到开放态，冻结生命周期 DAG 到不了的终态是显式冲突。
- **负面清单**：证据记录按键走**白名单**（十个摘要/指针字段），敏感订单字段按名拒绝，另有凭证、证件、手机号、邮箱、URL 值形扫描。未在白名单内的键即便看起来无害也被拒。
- **校准守卫**：偏差只产出用于排序与未来估算展示的有界 ppm 建议，带解释与依据。不确定终态只计数、不计值。薄样本回中性。预算硬约束判定只接受由不可变报价或供应商终态金额构造的 `AuthoritativeTotal`，因此被校准过的金额结构上到不了它。
- **摄取缝**：只有接口与数据形状。`ingestSupplierOutcome` 在读任何源之前以 `trigger_deferred` 拒绝。

### 3.3 结果

`ts/scripts/outcome-projection-tests.ts`：**135 条断言通过，退出码 0**。登记为 run-all **§85**。本次演练未在既有代码中发现缺陷；模块是新建的，其证伪针对自身守卫（§7）。

### 3.4 只有真实触发才能提供的东西

真实订单 E2E（需 M5 加真实授权记录）；真实偏差分布；任何由数据支撑的校准边界或最小样本常量；活体适配器实际会吐出的供应商状态词及其映射；获准的供应商终态源与其授权依据；以及 `refunded` 是否按 #233 售后面期望的方式与原始扣款冲抵。

## 4. 演练二 —— #339 城市×场景分级

### 4.1 模拟了什么触发

#339 的真实触发是「取得可审阅的真实使用样本，明确场景词表与成功指标」。它没有发生，且该 tracker 明文要求不凭 fixture 造画像。因此本次演练只模拟准入的**形状**：仅测试用的探针条目，其城市与场景键是无意义占位符（`city-a`、`scenario-x`），且必须显式传 `{ triggerFired: true }` 才能构造。

### 4.2 建了什么、跑了什么

`ts/src/city-scenario-tier.ts` —— 只有机制，没有词表内容：

- **版本化 schema、空注册表**：`CITY_SCENARIO_TIER_REGISTRY` 冻结为 `[]`，测试断言该声明在源码里字面就是 `= []`。闸为 false 时 `admitTierEntry` 以 `trigger_not_fired` **在任何校验之前**拒绝，因此没有分级能从夹具进来。
- **每档强制 provenance 与 retirement**：取自 RFC S2 排序的证据等级；准入来源集只有一个成员 `real_usage_sample`（夹具来源按名拒收）；至少三条可审样本引用；问责评审人；冻结时刻；明文淘汰条件；以及必须晚于冻结时刻的复审期限。
- **有界 modifier**：声明上下界内的整数 ppm，下界按设计严格大于零，因此没有分级能抹掉候选。零、负、越界、小数与非数值全部拒绝。缺陷注册表条目在读时被拒，而不是静默夹取。
- **中性退回，绝不猜测**：五个明文原因返回中性 ×1.0 ——触发未开、空注册表、未知城市、未知场景、冲突证据。冲突会暴露两个 tier id 而不代选。空白键或非字符串键报为调用方错误，而不是被静默中性化。
- **只进排序**：`applyTierRanking` 没有 filter、exclude、drop、threshold 任何参数，结果行里也没有对应字段。它保留每个候选原始的语义分，因此未加权排序始终可恢复；并列保持声明序；内置不变量会拒绝任何候选集不等于输入的结果。

声明的上下界是演练声明值，不是数据推导值：仓库只钉了排序**形态** `semantic × bounded_modifier`，任何地方都没有钉数值区间，因此该区间必须由真实样本重新冻结。

### 4.3 结果

`ts/scripts/city-scenario-tier-tests.ts`：**79 条断言通过，退出码 0**。登记为 run-all **§86**。关键证伪是十一个语义分乘三套注册表的电池测试，外加下界 modifier 作用于零语义分的最恶劣用例：候选永不被丢弃。

接线说明：今天真正对目的地候选排序的代码在 `ts/src/unified.ts`，而它是内核钉住文件。因此分级 modifier 不改内核就无法接入活体排序——那是另一个创始人层决策，不属于本次演练。

### 4.4 假设清单（未验证；需真实样本）

以下是**从仓库文档里摘出的候选场景词表设想**。它们未经验证、刻意不入代码，任何一条成为 taxonomy 成员之前都需要真实样本（#339 触发条件）。按信源强度分三档：

1. **代码里已有的闭集**（窄，是目的地数据包路由而非分级）：`ts/src/dsh-llm.ts` 里的 `erhai`、`workation`、`yunnan`、`generic`，其中 `generic` 刻意 fail-closed、不进求解。`workation` 是唯一同时出现在代码闭集与 persona-bench 分析里的词，是本次调研中信源最强的候选。
2. **GoTry 自己的设计者视角分析**（`docs/evaluation/persona-bench/README.md`）：workation 及其工作窗；同行者汇合（见面/汇合/同行）作为第二条到达链；红眼航班的到达状态；实际被整体平移一天的「周末」。`docs/user-guide.md` 另有：带工作窗的多段行程、回访，以及带「别早起」约束的休整/发呆框架。
3. **归档的竞品输出——当作警告，不当作词表**：`docs/evaluation/persona-bench/` 里城市片区到场景的最丰富措辞，来自一份逐字归档的竞品回答，而同一份 bench 明确批评它是 OTA 销售指南而非行程规划。把它的标签（夜生活、安静、冲浪/潜水、高端度假村、文化美食、购物、背包客、市中心、景观好）搬进来，恰好会引入这份 bench 存在的意义所要拒绝的那个人格。

两份文档里都**不存在**、因此不得发明的词：出差、亲子、蜜月、独行、宠物、适老、节庆、会议、citywalk、美食、滑雪、徒步、博物馆、奢华。

### 4.5 只有真实触发才能提供的东西

taxonomy 成员本身及其城市覆盖；场景词表与成功指标；由数据支撑的 modifier 数值区间；带真实反例的排序前后假设；每一档的样本引用与评审人；以及这套东西究竟是否要接入内核排序的决定。

## 5. 演练三 —— #429 D-39 活体路线数据源

### 5.1 模拟了什么触发

#429 对每一条更广的 D-39 路径（实时路况、公交/轨道、票价、地址解析）独立准入，每条都需要具名产品用例、实际供应商与访问边界、以及可审阅的权威性/新鲜度/覆盖率证据。没有任何路径的触发发生。本次演练在契约层模拟「具名用例 + 候选供应商」：用例刻意取已获准的 #341 形状（目的地驾车估算、无票价权威），供应商是离线 mock。没有联系任何路线供应商，也没有新增依赖。

### 5.2 建了什么、跑了什么

`ts/capabilities/route-provider-conformance.ts` —— 任何未来活体路线适配器都必须过的准入闸。它唯一的 import 是纯粹的同级脱敏器，自身不读时钟（`now` 必须由调用方注入），零网络、零缓存、零定时器、零文件系统面，也不耦合 evaluate/solve 内核；测试机械断言了这个 import 面。

声明并驱动了八种故障模式：不可用、过期、方向不匹配、模式改标、估算冒充实时路况、人机挑战、限流、部分结果。九条合规条款必须全过：

- **方向绑定** —— 按**响应**回显的 origin/destination 校验，绝不由请求假定；交换后的那一对是另一条事实；
- **模式隔离** —— 供应商自己的模式声明必须等于用例的模式，因此 driving 永不被改标为 transit、反向同样禁止；没有显式模式声明的响应被拒，而不是由请求替它贴标；
- **证据级隔离** —— 估算声称实时路况按升级拒绝，弱级填强承诺按欠级拒绝；
- **新鲜度合同** —— 没有声明窗口的路径不准入，观测时刻晚于闸时钟的被拒（供应商发布时间戳不是宿主观测时刻）；
- **来源身份** —— 供应商 id、法律依据、访问边界与被审阅的确切 source SHA 全必填，只读用例不可由交易边界供应商服务；
- **故障 fail-closed** —— 未分类失败被拒，而不是被当成降级许可；
- **静态回退保全** —— 一次拒绝之后，静态模式、分钟数、价格与原价标签逐字不变；
- **票价权威分离** —— 路线供应商永不自任票价权威；
- **故障详情脱敏** —— 标记、凭证赋值与 URL 永不到达证据面，供应商片段长度有界。

闸本身可证伪：故障被静默接受的适配器会使该条款转红；**未探测**的条款报为 fail 并阻止准入，因为「没测过」不是合规。

### 5.3 结果

`ts/scripts/route-provider-conformance-tests.ts`：**107 条断言通过，退出码 0**。登记为 run-all **§87**。对既有 ground-transfer 逻辑实跑，九条条款现已全部通过——其中三条是下文修复之后才通过：

| 条款 | 既有 ground-transfer 行为 |
|---|---|
| 票价权威分离 | 通过 —— 供应商声称的票价不被准入，静态价与标签照旧 |
| 证据级隔离（升级方向） | 通过 —— 声称实时路况的载荷仍得到 `not-live-route-estimate` |
| 静态回退保全 | 通过 —— 供应商不可用时模式、分钟数、价格与标签均未变 |
| 故障 fail-closed | 通过 —— 供应商报错与自相矛盾路线都回退，不施加分钟覆盖 |
| 方向绑定（请求侧） | 通过 —— 每个方向以自己的有序对查询，缓存不共享 |
| 新鲜度合同 | 通过 —— 过期缓存条目被重查，失败时报 stale，绝不当命中 |
| 故障详情脱敏 | **本次 GAP-429-3 修复之后**通过（此前是泄漏） |
| 模式隔离 | **2026-10-05 GAP-429-1 修复之后**通过 —— 自述模式不是驾车即被拒 |
| 方向绑定（响应侧） | **2026-10-05 GAP-429-2 修复之后**通过 —— 解析端点超出容差即被拒 |

### 5.4 在既有代码中发现的缺陷

在 `ts/capabilities/ground-transfer.ts` 中发现三处缺陷。GAP-429-3 产品可达，**已在本演练一轮修复**。GAP-429-1 与 GAP-429-2 确属休眠（今天不存在能触发它们的供应商），因此以标注为 `GAP-429-n` 的特征化断言钉住，等 owner 对合同变更拍板；创始人已于 **2026-10-05** 裁决修复，故**三处现已全部修掉**，两条钉住断言在 run-all **§87** 中已翻转为拒绝回归。

**GAP-429-1（模式隔离）—— 2026-10-05 已修复。** 修复前：`parseRouteResult` 只保留 `provider`、`distanceM`、`durationS`、`polyline`、`steps`，供应商载荷里相矛盾的 `mode` 被静默丢弃，路线事实按请求被标为 `mode: 'driving'`，其时长随后被绑进求解器。修复后：`PublicMapDrivingRouteResult` 承载供应商自述的可选 `mode`，自述模式不是 `driving` 时以 `mode_mismatch:<direction>:<detail>` 被拒——沿用既有 `<code>:<direction>:<detail>` 原因形状，码名取自合规闸——静态估算照旧。

```ts
// 供应商在驾车工具下返回一条公交路线
provider: async () => ({ provider: 'mock-transit', distanceM: 30000, durationS: 3600, mode: 'transit' })
// 现在：resolution.applied === false
//       resolution.outbound.fallbackReason 以 'mode_mismatch:outbound:' 开头
//       resolution.outbound.routeFact === undefined
//       candidates[0].destTransfers[0].minutesOut === undefined   // 公交分钟数永不绑定
```

今天的严重度依旧低——唯一接线的供应商是注册的 `map_driving_route` 工具，按构造就是驾车——但这恰恰是公交或轨道路径必须满足的条款，而这道检查现在已经先于任何这类适配器的准入存在。

**GAP-429-2（方向绑定，响应侧）—— 2026-10-05 已修复。** 修复前：方向绑定只在请求侧成立（缓存键含方向与有序对），响应从未与请求核对，解析到另一组 origin/destination 的供应商其时长会被当作机场接送绑定。修复后：可选的 `resolvedOrigin`／`resolvedDestination` 会在 `GROUND_TRANSFER_ECHO_TOLERANCE_DEG` 容差内（1e-4 度，约 11 米——吸附到最近路网节点仍算同一地点，换个地方则不算）与该方向实际发出的那一对核对，不匹配即以 `direction_mismatch:<direction>:<detail>` 被拒；无法解析的回显同样被拒：存在而不可核验一律失败关闭，而不是假定它就是被请求的那一对。被拒的答案不写缓存，因此日后也不可能被当作缓存命中送出。

```ts
// 供应商路由了完全不同的 O/D，并在自己的字段里说明了这一点
provider: async () => ({ provider: 'mock-wrong-od', distanceM: 999, durationS: 60,
                         resolvedOrigin: '0,0', resolvedDestination: '1,1' })
// 现在：resolution.applied === false
//       resolution.outbound.fallbackReason 以 'direction_mismatch:outbound:' 开头
//       candidates[0].destTransfers[0].minutesOut === undefined   // 999 米 / 60 秒的路线永不绑定
```

三个字段一律保持**可选**，缺失即不可核验——之所以仍然接受，只因唯一接线的供应商只做驾车、且不回显 origin/destination；正因如此，既有每一条原因字符串与结果都逐字不变，`ts/scripts/ground-transfer-tests.ts` 原样通过。任何未来的非驾车或地址解析适配器都必须提供这些字段：合规闸的 `mode_isolation` 与 `direction_binding` 两条条款已经会拒绝不提供的适配器。被引入拒绝原因的供应商自述文本先过共享脱敏器，因此 GAP-429-3 的边界对新增原因同样成立。

**GAP-429-3（故障详情脱敏）—— 产品可达，已修复。** 修复前的 `safeErrorMessage` 只去换行并截断到 400 字符，因此供应商抛出的错误消息逐字进入 `fallbackReason`，而 `exposeGroundTransferEvidence` 会把它带进工具结果以及每条匹配 verdict 的 `transfer_evidence`。该函数在活体产品路径 `ts/src/index.ts:801` 处接线，由注册的可行性工具到达，默认供应商是 `createPublicMapDrivingRouteProvider`——所以这是一条活体信息泄漏通道，不是假想情形。

修复把脱敏器抽到 `ts/capabilities/provider-detail-sanitize.ts`（纯函数、零 import），使一份实现同时服务 #429 合规闸与活体路径，并让 `safeErrorMessage` 走它。历史的 400 字符上界与 `unknown provider error` 空值文案均保留，因此既有每一条原因字符串都逐字不变。

```ts
provider: async () => { throw new Error(
  'HTTP 403 <html><body>Please complete the CAPTCHA. token=abc123 cookie=sid=XYZ ...</body></html>') }
// 修复前：resolution.outbound.fallbackReason 含 'token=abc123' 与 '<html>'
//         JSON.stringify(exposeGroundTransferEvidence({verdicts:[...]}, resolution)) 含 'token=abc123'
// 修复后：'map_driving_route_provider_error:outbound:HTTP 403 [markup-redacted][markup-redacted]
//          Please complete the CAPTCHA. [credential-redacted] [credential-redacted] ...'
//         —— 分类前缀完好，脱敏显式可审计，泄漏检查干净
```

回归覆盖登记在 run-all §87，且走**真实**解析路径：一个抛出带标记、token 与 cookie 消息的供应商，对出程原因、回程原因、聚合原因以及 `exposeGroundTransferEvidence` 输出逐一断言干净。另有一个遍历五条本来就安全的供应商消息（含两条固定 `GROUND_TRANSFER_*` 字符串与 `map_driving_route failed: ...`）的循环，断言逐字原样通过；既有 `ground-transfer-tests.ts` 套件在修复前后都绿——因此本来安全的内容行为零变化。唯一的归一化差异是：连续空白现在收敛为单个空格，而此前只收敛换行。

### 5.4a 关掉 GAP-429-1 与 GAP-429-2 的那次裁决

两者都是潜伏而非活体，这也是演练当时选择钉住而非修掉的原因：唯一接线的供应商是注册的 `map_driving_route` 工具，它按构造只做驾车，且返回的结果形状里完全没有 origin/destination 回显，因此两处缺口都没有触发路径。要把它们真正关掉，意味着扩宽 `PublicMapDrivingRouteResult` 以承载供应商自己的模式与解析端点，并决定供应商省略这些字段时怎么办——这是对已获准 #341 边界的合同变更，属于 owner 的裁决，不是一次演练该自行拍的板。

创始人已于 **2026-10-05** 裁决：两处都修，字段保持可选、缺失情形行为不变。实现就是合规闸早已写好的那一份规格，因此闸与产品路径现在以同一个码名拒绝同一个载荷。红基线成立：把能力层修复回退后，翻转的断言变红（7 条失败，退出码 1）；恢复修复后套件重新全绿、107 条断言，而 `ground-transfer-tests.ts` 在两种状态下都原样通过。

### 5.5 只有真实触发才能提供的东西

供应商身份、许可与配额条件；实际覆盖率与新鲜度实测；独立的权威票价来源；以确切 source SHA 记录的授权最小真实路径；以及准入实时路况、公交、轨道、票价、地址解析中任何一条的逐路径创始人决策。

## 6. 验证记录（命令与退出码）

动工前基线，在 `origin/main` 7077695：typecheck 退出码 0，隔离 smoke 退出码 0，既有 ground-transfer 套件退出码 0。下列命令均在三次提交之后、于隔离 worktree 内执行。

```text
cd ts && npx tsx scripts/outcome-projection-tests.ts         exit 0   155 pass
cd ts && npx tsx scripts/city-scenario-tier-tests.ts         exit 0    83 pass
cd ts && npx tsx scripts/route-provider-conformance-tests.ts exit 0    95 pass
cd ts && GOTRY_SESSION_LIVE=0 npx tsx scripts/ground-transfer-tests.ts  exit 0   issue #341 套件 OK
cd ts && npx tsx scripts/map-tools-vendor-package-proof.ts   exit 0   vendored map 证明 OK
cd ts && npx tsc --noEmit                                    exit 0
cd ts && npx tsx scripts/smoke.ts                            exit 0   SMOKE OK
cd ts && npx tsx scripts/kernel-manifest-gate.ts             exit 0   零漂移，内核 5/5 被加载
cd ts && npx tsx scripts/kernel-manifest-tests.ts            exit 0   §1-§7 全绿
node scripts/check-docs-i18n.mjs                             exit 0   87 对双语文档
node scripts/check-doc-readability.mjs                       exit 0   8 份面向读者文档
node scripts/check-doc-readability.mjs --self-test            exit 0   8 反例 + 26 夹具
bash -n scripts/run-all-tests.sh                             exit 0
```

完整的 `scripts/run-all-tests.sh` 刻意**没有**在此执行：它绑定固定端口且 CPU 开销大，而当时有多个 agent 并行工作。该脚本由集成者串行执行。§85、§86、§87 三节已按既有格式追加在脚本末尾。

## 7. 红基线（证伪先红、随后回退）

下列每一处变异都施加在新模块上、观测到红、然后回退；套件回到全绿，typecheck 保持退出码 0。

```text
#340  去掉 hardBudgetVerdict 里的被校准金额守卫
      -> 1 条 FAIL：「被校准金额偷渡进预算硬约束判定会被拒」                        （exit 1）
#340  让 unknown 可参与偏差比较
      -> 5 条 FAIL，含「unknown 被拒而非记为零偏差」                               （exit 1）
#340  恢复未锚定的证件号模式
      -> 12 条 FAIL：带 15+ 位数字串的合法摘要被当成证件号拒收                      （exit 1）
#339  给 applyTierRanking 加一个按分过滤
      -> 15 条 FAIL，含 no-hard-filter 证伪电池                                    （exit 1）
#339  让冲突证据静默择取第一档
      -> 3 条 FAIL，含「冲突证据 -> 中性，不代选」                                  （exit 1）
#339  去掉语义分非负守卫
      -> 2 条 FAIL，含「负语义分被拒」                                              （exit 1）
#429  去掉响应侧方向绑定（合规闸）
      -> 3 条 FAIL，含「期望拒绝 direction_mismatch，实际获得 ADMISSION」            （exit 1）
#429  关闭故障详情脱敏（合规闸）
      -> 8 条 FAIL，含「cookie 与 token 值永不在脱敏后留存」                         （exit 1）
#429  恢复 ground-transfer.ts 里修复前的 safeErrorMessage
      -> 8 条 FAIL，含「exposeGroundTransferEvidence 不带出供应商响应体」            （exit 1）
      且 ground-transfer-tests.ts 两种情况都是 exit 0 -> 该修复零行为变化
```

有一处变异起初**不可证伪**，这本身就是一个发现：一个十六进制摘要豁免分支遮蔽了锚定模式，导致去掉锚定后零失败。该冗余分支被删除，而不是留作无法测试的「防御」，于是只剩一套机制（逐叶扫描加锚定），上面的红基线才真正咬得住。

## 8. 没有越过的边界

范围说明：本节记录的是演练这一轮本身。后续 2026-10-05 的 GAP-429-1／2 一轮（§5.4）另外改动了 `ts/capabilities/ground-transfer.ts`、它在 §87 的演练套件，以及 `architecture.md` 的 D-39 行——依然没有内核钉住文件、没有新增依赖、没有任何路径获准。

没有触碰任何内核钉住文件（`unified.ts`、`model.ts`、`state-ledger.ts`、`bookable-facts.ts`、`artifact-gate.ts`），内核清单闸报零漂移。`ts/capabilities/ground-transfer.ts` 只在一处被编辑——其供应商失败文本现在经共享脱敏器输出（GAP-429-3）——解析语义、原因前缀、长度上界、空值文案与静态回退全部不变，既有套件在修复前后都绿。没有编辑任何共享权威文档：集成者可能需要对账的事实列在交回报告里，而不是写进 `architecture.md`、`roadmap.md`、根 README 或发布说明。没有新增依赖、也没有改 `package.json` —— 三个新契约模块产品面零调用方因此不随包发布，与 FX、geo-atlas、会话双区三个契约切片同一先例。现在唯一进入产品可达范围的模块是那个纯脱敏器，它零 import、零 IO、不读时钟；#429 合规闸本身仍然产品面零调用方。没有读写任何状态目录、用户主目录或凭据存储。
