[English](m6-b2b-reuse-walkthrough.md) | [简体中文](m6-b2b-reuse-walkthrough.zh-CN.md)

# M6 B2B 复用推演纪要（P6，待创始人评审）

> 状态：draft（2026-09-08，issue #137/#225；**P6 Exit 仅在 founder 明确 `YES 批准整体方案` 或明确批准修改稿时成立**；NO/提出修改仍为 TODO，不得擅自 frozen。P6 批准不等于 M6 Entry，M5 Exit 仍是硬前置）
> 验收口径（总纲 §4 P6 行）：选 1-2 个 B2B 形态，推演两层为什么的包裹与复用边界；红线随行口径；实测数字必须来自 M6 Entry 后的真实加载证明。
> 输入：[`../gotry-master-outline.md`](../gotry-master-outline.zh-CN.md) §3.7、[`../research/enterprise-travel-reference-study.md`](../research/enterprise-travel-reference-study.zh-CN.md)、[`../architecture.md`](../architecture.zh-CN.md) ADR-16/23、issue #137/#225/#229/#236/#237/#241/#242/#227。

## 0. 结论先行

1. **B2B 形态仍选两个**：旅行社嵌入（主，对应 M6 工程 proof 与试点形态）+ 目的地文旅（辅，验证 sponsor 配置面不是旅行社硬编码）。
2. **principal 必须分词**：M6 的 traveler principal 是“为什么出发”的主体；ADR-23 的 BFF/HTTP principal 是安全身份。两者不能复用类型名或语义。
3. **变化面三插件位只是待 PoC 验证的假设**：入口、库存池、sponsor 配置/披露。现有 MotivationProfile + hard constraints 与 `motivation_save` evidence 守卫只能支持“下游复用可能成立”的假设；尚无 sponsor 类型、配置、库存池接口、披露槽位或 B2B E2E。
4. **复用 proof 不再写成口号**：M6 只能报告固定冻结 `kernel-set` 的零 diff、runtime 实际加载 coverage、预声明功能路径 coverage 与附属 loaded LOC ratio。不得按某次 run 已加载模块缩小 `kernel-set`；这些工程指标不代表 traveler 满意度或 sponsor 转化。
5. **tenant/CLI 隔离基座已入 main**：tenant ledger scope（#229）+fold（#237）、state-cli（#236/#241/#243）及 Z3/map 稳定性修复均已合入，#227/#241/#242 已关闭。M6 sponsor plugin proof 仍须在自己的最终 SHA 引用实际运行证据，但这些已关闭 issue 不新增 M6 Entry 条件。
6. **披露插件保持 proposal**：sponsor 收益披露优先由 sponsor 插件注入渲染片段；若 M5 先要求 schema 预留，须保持内核对 sponsor 语义零依赖。
7. **商业试点不归工程代签**：P6 founder 批准与真实试点签约/商业条件是 business/legal 依赖；工程 proof 不能替代。未签原因只能解释整体为何仍 TODO，不能满足 M6 Exit。

## 1. principal 分词：三个主体，三个边界

| 主体 | 所属层 | 语义 | 不得混用的原因 |
|---|---|---|---|
| traveler principal | M6 / 产品动机层 | 出行人；动机访谈到达对象；MotivationProfile 的主体 | sponsor 的收益目标不能写入 traveler 动机 |
| sponsor | M6 / 商业与库存层 | 旅行社/TMC/酒店/航司/目的地文旅等合作方 | sponsor 可配置入口/库存/披露，但不能覆盖 traveler 约束 |
| BFF principal / `BookingIngressPrincipal` | ADR-23 / embedded Booking Copilot 安全面 | 已认证 HTTP/BFF actor、scope 与 request binding | 它证明“谁能调用接口”，不证明“谁为什么出发” |

实现命名建议：M6 新命名空间用 `sponsor.*` 与 `traveler.*`；不要复用 `booking.surface` 的 principal 类型承载动机语义。BFF principal 只进入鉴权与 request binding；traveler principal 才进入动机画像、记忆与行程解释。

## 2. 两层为什么的包裹推演

**B2C（现状）**：traveler principal = sponsor = 用户本人。动机访谈（素材→憧憬→硬约束→候选集，素材中的目的地只是软偏好）直达 `gotry_motivation_save`，落盘 MotivationProfile，下游全链消费。

**B2B 旅行社嵌入（主形态）**：

- traveler principal = 出行人； sponsor = 旅行社。旅行社可以转述客户意图，但落盘权重 delta 仍必须有 traveler 原话或可审计 evidence；“旅行社希望卖某线路”不是 traveler evidence。
- sponsor 层只包裹入口、库存池与披露规则：打包线路/团期/协议价、品牌入口、客服联系、佣金披露。它不写 MotivationProfile。
- 旅程走查：旅行社 H5/小程序/BFF 入口 → traveler 动机访谈 → `motivation_save` → feasibility/行程/透明卡片 → sponsor 库存候选与收益披露 → M5 WriteGate（若发生写路径）。
- sponsor 收益可以影响候选排序的披露维度，不能成为硬过滤 traveler 动机的理由；任何排序偏置必须显示给 traveler。

**sponsor 权责表（待 PoC/协议验证）：**

| 责任 | sponsor 可做 | sponsor 不可做 | 证据/receipt 归属 |
|---|---|---|---|
| 动机输入 | 提供入口上下文或转述客户诉求 | 把商业偏好写成 traveler 动机 evidence | traveler 原话或可审计授权来源 |
| 授权来源 | 声明合作库存、售后和报价来源 | 代替 traveler 确认个人约束或出行动机 | BFF/业务授权与 traveler evidence 分开 |
| 外部写确认 | 按 M5 WriteGate 提供供应商字段和售后路径 | 绕过 receipt 或替 traveler 静默下单 | `ApprovalReceipt` 绑定 traveler/tenant/request fingerprint |
| receipt 签发 | 提供 supplier receipt、取消/退款状态 | 把请求已发出当成功 | supplier outcome + 查单/人工对账证据 |
| 披露责任 | 披露佣金、赞助、排序偏置、客服 SLA | 隐藏高佣金或合作素材来源 | disclosure digest 进 request fingerprint |
| 补偿责任 | 提供取消/退款/售后流程与 SLA | 把 local cancel 写成退款到账 | cancel/refund/wallet outcome 分开投影 |

**B2B 目的地文旅（辅形态）**：

- sponsor = 目的地文旅局；库存池 = 本地 POI/活动/票务/季节性主题。
- 合作素材需要来源标注与赞助披露，但素材仍只是憧憬表达式，不是目的地硬指令。
- 辅形态用于否证“旅行社特设”：若入口、库存池、披露配置三插件位无法覆盖文旅场景，说明复用边界表要返工。

## 3. 复用边界清单（基于 origin/main `d1d7b5a`）

**内核复用面（M6 proof 时应逐字节不变）：**

| 内核组件 | 位置/文件集合 | B2B 消费方式 |
|---|---|---|
| MotivationProfile + hard 约束 | `ts/src/model.ts`；`ts/src/memory-capture.ts`；`ts/src/state-ledger.ts` 的 motivation 投影 | 原样；权重语义属于 traveler，不随 sponsor 变 |
| 求解与全成本 | `ts/src/unified.ts`；`ts/src/model.ts`；Z3 共享层 | 原样；候选来自 sponsor 库存池，求解不感知 sponsor |
| 事实闸与证据链 | `ts/src/bookable-facts.ts`；`ts/src/artifact-gate.ts`；fact-log | 原样；B2B 可下单/可售 claim 同样 exact-date 回溯 |
| 记忆/愿望池/同行人/时间线 | `ts/src/memory-*`；`ts/src/wish-pool.ts`；`ts/src/companions.ts`；`ts/src/travel-timeline.ts` | 原样；tenant/stateRoot 隔离后按 traveler/tenant 读写 |
| turn handoff / async | `ts/src/turn-*`；`ts/scripts/turn-handoff-collect.ts` | 原样；复杂规划仍 handoff + 回访交付 |
| M5 WriteGate seam | ADR-15/17/18 对应文件；M5 Entry 后实现 | 原样；B2B 写路径不豁免 receipt |

**预期变化面（待 PoC 验证；目标是全部新增插件/配置，不触碰内核）：**

| 插件位 | 旅行社形态 | 目的地文旅形态 | 机制模板 |
|---|---|---|---|
| 入口 | 旅行社 H5/小程序/BFF 绑定 | 目的地导流页 | dsh plugin + BFF request binding；只用 BFF principal 做鉴权 |
| 库存池 | 打包线路、团期、协议价、客服库存 | POI、票务、活动、季节素材 | channel-registry / effect-interpreter 注册表模式 |
| sponsor 配置/披露 | 品牌、佣金、赞助、售后与客服 SLA | 合作素材来源、赞助活动、地方补贴 | sponsor plugin 注入渲染片段；proposal |

参考研究采纳项落位：合规收口可以走模型请求装饰器或 effect 策略；领域 skill = sponsor 插件的工具集+prompt+边界守卫+渲染器。二者都装在三个插件位内；若出现第四种变化面，必须回到 P6 评审。

## 4. “复用率”实测口径（M6 Entry 后才可报告）

复用率数字必须带可复跑定义：

1. **基准 SHA**：本次文档勘察基准为 `origin/main@c1f0ca2`；M6 proof 必须重新绑定执行当时 main 的实际 SHA。
2. **固定冻结内核集合**：§3 的复用面文件列表在实现前冻结为 `kernel-set.txt`；M6 proof 跑 `git diff <baseline> -- $(cat kernel-set.txt)` 必须为空。该集合用于零 diff 断言，不得按某次 run 的实际加载情况缩小；若旅行社插件必须改核心文件，零内核改动假设即不成立，必须重新评审。
3. **runtime 实际加载 coverage**：真实 B2B one-shot/headless run 产生 `loaded-modules.json`，证明该次运行实际加载并复用了哪些冻结内核路径；不得反向改写 `kernel-set.txt`。
4. **预声明功能路径 coverage**：把该场景应经过的事实闸、WriteGate、async、账本等功能路径预先列出，逐项证明 run 是否实际走到；未走到的路径不能计为已复用。
5. **附属 LOC 指标**：`kernel_loaded_loc / total_gotry_loaded_loc` 可作为附属观测，但不能代替前两份 coverage，也不能据此缩小固定 `kernel-set`。
6. **用户效果另算**：该数字只证明“工程没改内核”。traveler 动机满足度、NPS、转化、sponsor 收益都需要另有 cohort/试点证据。

M6 Exit 工程半面应写为“固定 `kernel-set` diff=0；runtime 实际加载 coverage 与预声明功能路径 coverage 完整；旅行社嵌入 E2E 通过”；商业半面必须是真实试点签约。未签原因只解释 TODO，不能替代签约。

复用 proof 的 schema 与生成脚本由后续 `m6-reuse-proof-schema` 任务负责（见 [`../design/milestone-delivery-plan.md`](../design/milestone-delivery-plan.zh-CN.md) M6-3）：提前冻结 `kernel-set.txt`、`loaded-modules.json` 与 runtime trace schema，避免实现者临时发明分母。


## 5. 安全与对抗测试

| 对抗面 | 最小测试 | 失败判定 |
|---|---|---|
| tenant 隔离（#229/#237） | 两租户同业务 id 写 event/wish/pending，各自 read/rebuild 只见自己 | tenant A 读到或重建 tenant B 投影 |
| BFF principal 重放 | BFF actor 拿旧 requestKey/receipt 绑定新 traveler | request fingerprint 或 scope 不匹配仍放行 |
| sponsor 库存注入 | sponsor A 库存进入 sponsor B tenant | channel/sponsor config 未按 tenant 过滤 |
| traveler evidence | sponsor 文案生成动机权重 | 无 traveler evidence 的 `motivation_save` 通过 |
| 收益披露 | sponsor 高佣金候选排序靠前 | 卡片未披露偏置/佣金来源 |
| wish pool | sponsor 主动召回不满足 traveler conditions 的 wish | conditions 被 sponsor campaign 覆盖 |

tenant ledger scope（#229/#237）、state-cli 租户与小数边界（#236/#241/#243）、Z3/map 稳定性基座均已入 main，#227/#241/#242 已关闭。M6 sponsor plugin proof 仍必须在自己的最终 SHA 引用这些能力的实际运行证据。

## 6. 红线随行口径

- **traveler 动机优先**：动机访谈到达 traveler；B2B 中 sponsor 的商业目标不能改写 MotivationProfile。
- **sponsor 收益披露**：透明卡片必须披露 sponsor 收益/合作来源/排序偏置；披露本身不证明 traveler 价值。
- **WriteGate 随行**：B2B 代理预订/支付与 B2C 同受 M5 WriteGate；L4 自动类也必须可撤回。
- **证据红线**：`motivation_save` 无 evidence 拒绝落盘；wish pool conditions 强制；bookable claim 必须过 fact gate。
- **隐私边界**：BFF principal、traveler principal、sponsor 均用 HMAC/ref/digest；公开 proof 不提交 PII、订单号、合同原文或原始会话。

## 7. 与 M5 的依赖（gate 关系）

M6 Entry = M5 Exit + P6 founder 明确批准，两项缺一不可。P6 批准可先完成，但不单独开启 M6 实现。M6 对 M5 的真实依赖：

1. WriteGate 生产化 receipt/outbox/unknown/manual reconcile 机制；
2. 佣金/赞助披露在 C 端先有可验证口径；
3. booking_saga_fsm 边表与 effect-interpreter 写 effect 策略；
4. tenant 级账本隔离（#229/#237）与 state-cli 租户/小数边界（#236/#241/#243）已入 main；
5. #227 Z3 生命周期与 #242 dsh-map-tools map 回归已在集成候选上通过 Node24 typecheck、3×240、full 与 CI 后合入并关闭；M6 proof 仍须绑定自己的最终 SHA，但不把已关闭 issue 另列为 Entry。

这些依赖意味着 M5 的设计要兼容 B2B，但不构成提前实现 M6 的理由。本纪要只保留推演和 proof 口径。

## 8. 待创始人审批的整体方案

推荐整体批准以下一组边界：旅行社嵌入为主、目的地文旅为辅；赞助/库存/披露以插件注入；traveler、sponsor、BFF 三主体隔离；固定冻结 `kernel-set` 零 diff，并分别提交 runtime 实际加载 coverage 与预声明功能路径 coverage；M6 Exit 商业半面以真实试点签约收口。

- [ ] `YES 批准整体方案`
- [ ] `修改为:________________`

只有明确 YES 或对修改稿明确批准才满足 P6 Exit。具名 pilot 主体、范围与合同字段仍为 TODO；P6 批准不等于 M6 Entry，实现仍等 M5 Exit。

---

批准后本文才可转 `frozen(日期)`；批准前保持 draft。实现开闸仍等 M5 Exit。
