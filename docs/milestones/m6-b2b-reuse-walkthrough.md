# M6 B2B 复用推演纪要(P6,待创始人评审)

> 状态:draft(2026-09-08,issue #137/#225;**P6 exit = 本文通过创始人评审**,评审前 M6 entry gate 不满足;不得擅自 frozen)
> 验收口径(总纲 §4 P6 行):选 1-2 个 B2B 形态,推演两层为什么的包裹与复用边界;红线随行口径;实测数字必须来自 M6 Entry 后的真实加载证明。
> 输入:[`../gotry-master-outline.md`](../gotry-master-outline.md) §3.7、[`../research/enterprise-travel-reference-study.md`](../research/enterprise-travel-reference-study.md)、[`../architecture.md`](../architecture.md) ADR-16/23、issue #137/#224/#225。代码勘察基准:origin/main `d1d7b5a`(2026-09-08)。

## 0. 结论先行

1. **B2B 形态仍选两个**:旅行社嵌入(主,对应 M6 工程 proof 与试点形态)+ 目的地文旅(辅,验证 sponsor 配置面不是旅行社硬编码)。
2. **principal 必须分词**:M6 的 traveler principal 是“为什么出发”的主体;ADR-23 的 BFF/HTTP principal 是安全身份。两者不能复用类型名或语义。
3. **变化面三插件位只是待 PoC 验证的假设**:入口、库存池、sponsor 配置/披露。现有 MotivationProfile + hard constraints 与 `motivation_save` evidence 守卫只能支持“下游复用可能成立”的假设;尚无 sponsor 类型、配置、库存池接口、披露槽位或 B2B E2E。
4. **复用率不再写成口号**:M6 只能报告三件套——基准 SHA、内核文件集合 `git diff` 为零、runtime 实际加载模块的路径覆盖与 LOC 附属数字。该数字是工程复用指标,不代表 traveler 满意度或 sponsor 转化。
5. **tenant/CLI 隔离是 M6 前置安全门**:#224 同业务 id 跨 tenant 读写/rebuild 隔离已关闭但 proof 仍需引用其最终证据;#226 state-cli 租户边界与 #227 Z3 稳定性未闭合前,不得把 sponsor plugin proof 当可合并证据。
6. **披露插件保持 proposal**:sponsor 收益披露优先由 sponsor 插件注入渲染片段;若 M5 先要求 schema 预留,须保持内核对 sponsor 语义零依赖。
7. **商业试点不归工程代签**:P6 founder review 与试点签约/商业条件是 owner 依赖;工程 proof 不能替代。

## 1. principal 分词:三个主体,三个边界

| 主体 | 所属层 | 语义 | 不得混用的原因 |
|---|---|---|---|
| traveler principal | M6 / 产品动机层 | 出行人;动机访谈到达对象;MotivationProfile 的主体 | sponsor 的收益目标不能写入 traveler 动机 |
| sponsor | M6 / 商业与库存层 | 旅行社/TMC/酒店/航司/目的地文旅等合作方 | sponsor 可配置入口/库存/披露,但不能覆盖 traveler 约束 |
| BFF principal / `BookingIngressPrincipal` | ADR-23 / embedded Booking Copilot 安全面 | 已认证 HTTP/BFF actor、scope 与 request binding | 它证明“谁能调用接口”,不证明“谁为什么出发” |

实现命名建议:M6 新命名空间用 `sponsor.*` 与 `traveler.*`;不要复用 `booking.surface` 的 principal 类型承载动机语义。BFF principal 只进入鉴权与 request binding;traveler principal 才进入动机画像、记忆与行程解释。

## 2. 两层为什么的包裹推演

**B2C(现状)**:traveler principal = sponsor = 用户本人。动机访谈(素材→憧憬→硬约束→候选集,素材中的目的地只是软偏好)直达 `gotry_motivation_save`,落盘 MotivationProfile,下游全链消费。

**B2B 旅行社嵌入(主形态)**:

- traveler principal = 出行人; sponsor = 旅行社。旅行社可以转述客户意图,但落盘权重 delta 仍必须有 traveler 原话或可审计 evidence;“旅行社希望卖某线路”不是 traveler evidence。
- sponsor 层只包裹入口、库存池与披露规则:打包线路/团期/协议价、品牌入口、客服联系、佣金披露。它不写 MotivationProfile。
- 旅程走查:旅行社 H5/小程序/BFF 入口 → traveler 动机访谈 → `motivation_save` → feasibility/行程/透明卡片 → sponsor 库存候选与收益披露 → M5 WriteGate(若发生写路径)。
- sponsor 收益可以影响候选排序的披露维度,不能成为硬过滤 traveler 动机的理由;任何排序偏置必须显示给 traveler。

**sponsor 权责表(待 PoC/协议验证):**

| 责任 | sponsor 可做 | sponsor 不可做 | 证据/receipt 归属 |
|---|---|---|---|
| 动机输入 | 提供入口上下文或转述客户诉求 | 把商业偏好写成 traveler 动机 evidence | traveler 原话或可审计授权来源 |
| 授权来源 | 声明合作库存、售后和报价来源 | 代替 traveler 确认个人约束或出行动机 | BFF/业务授权与 traveler evidence 分开 |
| 外部写确认 | 按 M5 WriteGate 提供供应商字段和售后路径 | 绕过 receipt 或替 traveler 静默下单 | `ApprovalReceipt` 绑定 traveler/tenant/request fingerprint |
| receipt 签发 | 提供 supplier receipt、取消/退款状态 | 把请求已发出当成功 | supplier outcome + 查单/人工对账证据 |
| 披露责任 | 披露佣金、赞助、排序偏置、客服 SLA | 隐藏高佣金或合作素材来源 | disclosure digest 进 request fingerprint |
| 补偿责任 | 提供取消/退款/售后流程与 SLA | 把 local cancel 写成退款到账 | cancel/refund/wallet outcome 分开投影 |

**B2B 目的地文旅(辅形态)**:

- sponsor = 目的地文旅局;库存池 = 本地 POI/活动/票务/季节性主题。
- 合作素材需要来源标注与赞助披露,但素材仍只是憧憬表达式,不是目的地硬指令。
- 辅形态用于否证“旅行社特设”:若入口、库存池、披露配置三插件位无法覆盖文旅场景,说明复用边界表要返工。

## 3. 复用边界清单(基于 origin/main `d1d7b5a`)

**内核复用面(M6 proof 时应逐字节不变):**

| 内核组件 | 位置/文件集合 | B2B 消费方式 |
|---|---|---|
| MotivationProfile + hard 约束 | `ts/src/model.ts`;`ts/src/memory-capture.ts`;`ts/src/state-ledger.ts` 的 motivation 投影 | 原样;权重语义属于 traveler,不随 sponsor 变 |
| 求解与全成本 | `ts/src/unified.ts`;`ts/src/model.ts`;Z3 共享层 | 原样;候选来自 sponsor 库存池,求解不感知 sponsor |
| 事实闸与证据链 | `ts/src/bookable-facts.ts`;`ts/src/artifact-gate.ts`;fact-log | 原样;B2B 可下单/可售 claim 同样 exact-date 回溯 |
| 记忆/愿望池/同行人/时间线 | `ts/src/memory-*`;`ts/src/wish-pool.ts`;`ts/src/companions.ts`;`ts/src/travel-timeline.ts` | 原样;tenant/stateRoot 隔离后按 traveler/tenant 读写 |
| turn handoff / async | `ts/src/turn-*`;`ts/scripts/turn-handoff-collect.ts` | 原样;复杂规划仍 handoff + 回访交付 |
| M5 WriteGate seam | ADR-15/17/18 对应文件;M5 Entry 后实现 | 原样;B2B 写路径不豁免 receipt |

**预期变化面(待 PoC 验证;目标是全部新增插件/配置,不触碰内核):**

| 插件位 | 旅行社形态 | 目的地文旅形态 | 机制模板 |
|---|---|---|---|
| 入口 | 旅行社 H5/小程序/BFF 绑定 | 目的地导流页 | dsh plugin + BFF request binding;只用 BFF principal 做鉴权 |
| 库存池 | 打包线路、团期、协议价、客服库存 | POI、票务、活动、季节素材 | channel-registry / effect-interpreter 注册表模式 |
| sponsor 配置/披露 | 品牌、佣金、赞助、售后与客服 SLA | 合作素材来源、赞助活动、地方补贴 | sponsor plugin 注入渲染片段;proposal |

参考研究采纳项落位:合规收口可以走模型请求装饰器或 effect 策略;领域 skill = sponsor 插件的工具集+prompt+边界守卫+渲染器。二者都装在三个插件位内;若出现第四种变化面,必须回到 P6 评审。

## 4. “复用率”实测口径(M6 Entry 后才可报告)

复用率数字必须带可复跑定义:

1. **基准 SHA**:例如 `origin/main@<sha>`;本 draft 使用勘察基准 `d1d7b5a`,但 M6 proof 必须用当时 main 的实际 SHA。
2. **内核文件集合**:§3 的复用面文件列表冻结为 `kernel-set.txt`;M6 proof 跑 `git diff <baseline> -- $(cat kernel-set.txt)` 必须为空。若旅行社插件必须改 `ts/src/model.ts`、`ts/src/unified.ts` 或核心卡片 schema,零内核改动假设即不成立,必须重新评审;不得通过放宽 `kernel-set.txt` 藏改动。
3. **runtime 加载集合**:以真实 B2B one-shot/headless 运行产生 `loaded-modules.json`。分母只含该 run 实际加载的 GoTry runtime 模块,不含未加载源码、测试、docs、node_modules 或 vendor。
4. **行数公式**:`kernel_loaded_loc / total_gotry_loaded_loc`。`kernel_loaded_loc` 来自 loaded module 与 kernel-set 交集;`total_gotry_loaded_loc` = loaded GoTry runtime 模块行数 + sponsor 插件行数。
5. **覆盖率**:`loaded kernel files / kernel-set files used by normal B2C planning`。若 B2B run 没走事实闸/WriteGate/async,不能把这些文件计入复用率分子。
6. **用户效果另算**:该数字只证明“工程没改内核”。traveler 动机满足度、NPS、转化、sponsor 收益都需要另有 cohort/试点证据。

M6 exit 表述应是“内核 diff=0;runtime 复用率 X%(基准 SHA/分母/loaded modules 附件);旅行社嵌入 E2E N 步通过;试点商业条件 Y”,而不是“99% 复用”一句话。

复用 proof 的 schema 与生成脚本由后续 `m6-reuse-proof-schema` 任务负责(见 [`../design/milestone-delivery-plan.md`](../design/milestone-delivery-plan.md) M6-3):提前冻结 `kernel-set.txt`、`loaded-modules.json` 与 runtime trace schema,避免实现者临时发明分母。


## 5. 安全与对抗测试

| 对抗面 | 最小测试 | 失败判定 |
|---|---|---|
| tenant 隔离(#224) | 两租户同业务 id 写 event/wish/pending,各自 read/rebuild 只见自己 | tenant A 读到或重建 tenant B 投影 |
| BFF principal 重放 | BFF actor 拿旧 requestKey/receipt 绑定新 traveler | request fingerprint 或 scope 不匹配仍放行 |
| sponsor 库存注入 | sponsor A 库存进入 sponsor B tenant | channel/sponsor config 未按 tenant 过滤 |
| traveler evidence | sponsor 文案生成动机权重 | 无 traveler evidence 的 `motivation_save` 通过 |
| 收益披露 | sponsor 高佣金候选排序靠前 | 卡片未披露偏置/佣金来源 |
| wish pool | sponsor 主动召回不满足 traveler conditions 的 wish | conditions 被 sponsor campaign 覆盖 |

#224 是 M6 前置安全门且 issue 已关闭;M6 sponsor plugin proof 仍必须引用其最终 SHA/PR 证据。#226 state-cli 租户边界未关闭前,CLI 管理面仍不能作为多租户 proof 入口。

## 6. 红线随行口径

- **traveler 动机优先**:动机访谈到达 traveler;B2B 中 sponsor 的商业目标不能改写 MotivationProfile。
- **sponsor 收益披露**:透明卡片必须披露 sponsor 收益/合作来源/排序偏置;披露本身不证明 traveler 价值。
- **WriteGate 随行**:B2B 代理预订/支付与 B2C 同受 M5 WriteGate;L4 自动类也必须可撤回。
- **证据红线**:`motivation_save` 无 evidence 拒绝落盘;wish pool conditions 强制;bookable claim 必须过 fact gate。
- **隐私边界**:BFF principal、traveler principal、sponsor 均用 HMAC/ref/digest;公开 proof 不提交 PII、订单号、合同原文或原始会话。

## 7. 与 M5 的依赖(gate 关系)

M6 Entry = M5 exit + P6 founder review。M6 对 M5 的真实依赖:

1. WriteGate 生产化 receipt/outbox/unknown/manual reconcile 机制;
2. 佣金/赞助披露在 C 端先有可验证口径;
3. booking_saga_fsm 边表与 effect-interpreter 写 effect 策略;
4. tenant 级账本隔离(#224)已过对抗测试并在 proof 中可引用,state-cli 租户边界(#226)仍待关闭;
5. #227 Z3 Node24 间歇 heap corruption 已有可靠根因修复或充分澄清,不能用一次重跑绿作为 M6 proof 的稳定性证据。

这些依赖意味着 M5 的设计要兼容 B2B,但不构成提前实现 M6 的理由。本纪要只保留推演和 proof 口径。

## 8. 待创始人评审的开放问题

1. 两个 B2B 形态是否维持“旅行社主 + 目的地文旅辅”。
2. sponsor 披露槽位采用插件注入还是内核 schema 可空预留;本文倾向插件注入。
3. §4 复用率公式是否替代 roadmap/issue 中“99% 复用”口号。
4. M6 报告是否采用“工程证据/商业证据分栏”呈现;无论分栏与否,试点签约仍属于 M6 整体 Exit,不能移出。
5. tenant 对抗测试是否作为 P6 通过前必须项,还是作为 M6 Entry 后第一项;本文倾向前置。

---

评审通过后,本文才可转 `frozen(日期)`;评审前保持 draft。实现开闸仍等 M5 Exit。
