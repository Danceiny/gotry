[English](p6-founder-decision-brief.md) | [简体中文](p6-founder-decision-brief.zh-CN.md)

# P6 创始人决策简报（issue #137，M6-2）

> 定位：P6 founder 评审的一页决策面——P6 是什么、M6 Entry 两个硬前置的现状、方案要点、风险，以及等待 founder 回答的问题清单；只为决策服务，绝不当决策回执。
> 状态：决策就绪但已推迟（2026-10-02 汇集；2026-10-05 founder 已将 #137 按 not planned 关闭，当前无人在追；本简报只汇集开放问题——文中没有任何一项已被拍板；P6 Exit 仍以 founder 在 P6 issue 的明确表态为准——即链接 #137 的新 issue，或重新打开的 #137）。
> 上游：[m6-b2b-reuse-walkthrough.md](../milestones/m6-b2b-reuse-walkthrough.zh-CN.md)（P6 草案）、[milestone-delivery-plan.md](milestone-delivery-plan.zh-CN.md) M6-1..M6-5、[roadmap.md](../roadmap.zh-CN.md) M6 行、issue #137 owner 评论（2026-09-08/09/10）。
> 下游：founder 在恢复 P6 的 issue 里回复（链接 #137 的新 issue，或重新打开的 #137）；[decisions-needed.md](../decisions-needed.zh-CN.md) 按回执归档 #137 条目；#234 coverage 口径冻结与 #235 激活门读其结果。

## 速览（TL;DR）

- P6 是 M6 B2B 复用推演的 founder 评审门；P6 Exit = 明确的 `YES` 批准整体方案，或对修改稿明确批准——工程草案永远不能替代。
- M6 Entry 有两个并列硬前置：M5 Exit（issue #136）与 P6 founder 批准。当前均未满足；P6 的 YES 不旁路 M5。
- 方案要点：旅行社嵌入为主 + 目的地文旅为辅；三个隔离主体；仅三个插件位为变化面；复用以固定冻结 kernel-set 零 diff 加两份独立 coverage 报告证明。
- founder 应回答的开放问题（加上整体 YES）见 §5，附 是/否/修改稿 回复位；§6 写明批准后立即启动什么。

## 1. P6 是什么

- 总纲 P6 行（§3.7）：选 1–2 个 B2B 形态，走通两层 why 包裹与复用边界，红线全程随行。
- P6 Exit：推演纪要通过 founder 评审——明确 YES，或对修改稿明确批准。NO 或提出修改保持 TODO；除 founder 外任何人不得 frozen。
- 受评审纪要：[m6-b2b-reuse-walkthrough.md](../milestones/m6-b2b-reuse-walkthrough.zh-CN.md)，draft，随 PR #249（merge 293bbb6）入 main。

## 2. M6 Entry 两个硬前置与现状

| 前置 | 跟踪处 | 现状 |
|---|---|---|
| M5 Exit | #136 | 未满足。M5 Entry 本身需要 M4 Exit（#20 真实 `observed_private` N≥5 repeat cohort + reflux 基线——TODO）与 HotelByte 供应链协议 M5-0（未取得签署/内部授权证据）。M5 交易 runtime 保持封存。 |
| P6 founder 批准 | #137（M6-2） | 未满足。仓内无明确 founder YES 或已批准的修改稿；推演纪要保持 draft。 |

- 两者并列：任一未满足，M6 保持封存。P6 先批准只是缩短等待窗口，不开任何实现。
- 仓内 pre-entry 资产（已在 main，runtime 边界封存）：#231 WriteGate/outbox 核心、#232/#233 adapter 与取消/退款契约、#234 kernel manifest + import-trace 证明工具、#235 sponsor 插件契约 + 默认关 fixture、租户隔离基座（#229/#237/#236/#241）。

## 3. P6 方案要点

1. 两个 B2B 形态：旅行社嵌入（主，对应 M6 工程证明与试点形态）+ 目的地文旅（辅，用来证伪插件位的旅行社特化设计）。
2. 三个隔离主体：traveler principal（动机主体）/ sponsor（商业与库存层）/ BFF `BookingIngressPrincipal`（ADR-23 安全身份）；命名空间 `traveler.*` 与 `sponsor.*`；sponsor 目标绝不写入 MotivationProfile。
3. 唯一变化面是三个插件位：入口、库存池、sponsor 配置/披露；复用 seam 单点是 MotivationProfile + 硬约束；「零内核改动」正是证明要守住的假设。
4. 复用证明口径：固定冻结 `kernel-set` 零 diff + 运行时实际加载 coverage + 预声明功能路径 coverage，三份分开报告；loaded LOC 占比只作附属数字；「99% 复用」口号由该实测口径替代。
5. sponsor 收益披露：优先插件注入渲染片段，内核对 sponsor 语义零依赖；披露 digest 进请求 fingerprint。
6. M6 Exit 拆两条：工程半面（零 diff + 两份 coverage + 旅行社嵌入 E2E）与商业半面（真实试点签约，M6-5，销售/法务——工程绝不代签）。

## 4. founder 应权衡的风险

| 风险 | 含义 | 跟踪处 |
|---|---|---|
| 插件位仍是假设 | 尚无 sponsor 类型、配置、库存接口、披露槽位或 B2B E2E；三槽位完备性要等辅形态跑过才算证毕 | 纪要 §0/§3 |
| 工程指标不是结果 | 零内核 diff 与 coverage 只证明「内核未动」，不证明 traveler 满意度、NPS 或 sponsor 转化 | 纪要 §4 |
| 批准但未开闸窗口 | P6 先于 M5 Exit 批准会出现一段什么都不能激活的间隔；并行工程不得倒推开闸 | #137 owner 评论 |
| 商业试点未签 | 未签状态只解释 M6 为何 TODO，永远不能满足 M6 Exit | M6-5 |
| 披露槽位未定 | 若 M5 先要 schema 预留，内核就背上 sponsor 语义——恰是方案要避免的依赖 | 开放问题 Q2 |

## 5. 等待 founder 的决策问题

建议缺省复述推演纪要的倾向；没有一项是决策。逐项回复：`YES` / `NO` / `修改为：____`。

| # | 问题 | 建议缺省（未拍板） | founder 回复 |
|---|---|---|---|
| Q1 | 批准整体方案边界集（纪要 §8）？ | 纪要等的就是这个 YES | ____ |
| Q2 | 披露槽位落位：插件注入渲染片段（内核对 sponsor 零感知），仅当 M5 强制才做 schema 预留？ | 插件注入 | ____ |
| Q3 | 保留目的地文旅为辅形态（证伪插件位的旅行社特化）？ | 保留 | ____ |
| Q4 | 采用实测复用口径（冻结 kernel-set 零 diff + 两份 coverage + LOC 附属）替代「99%」口号？ | 采用 | ____ |
| Q5 | M6 Exit 拆工程半面与商业半面（真实试点签约）？ | 拆 | ____ |
| Q6 | （M6-5，商业依赖，非 P6 Exit 条件）具名试点主体与范围，可得时填入 | 暂无 | ____ |

## 6. 批准后第一步

1. 在恢复 P6 的 issue 记录回执（YES 本身或已批准的修改稿）；[decisions-needed.md](../decisions-needed.zh-CN.md) 把 #137 移入已结算；此后推演纪要方可转 `frozen(日期)`。
2. 在 #234 下冻结 `kernel-set.txt` 与两份 coverage 口径——#137 owner 评论（2026-09-09）明确允许在 M5 Exit 前做；LOC 保持附属。
3. #235 保持 Entry 门控：真实 sponsor 激活等 M5 Exit + P6；契约、fixture 与 failing-test 打磨可继续。
4. M5 线不变且仍是关键路径：#136 M5-0 具名值 + #20 M4 Exit。仅凭 P6 的 YES 不启动任何 M6 实现。

## 7. 本简报不是什么

- 不是决策回执：本文任何内容都不满足 P6 Exit；只有 founder 在 P6 issue 的明确表态才算。
- 不是改门：M6 Entry 仍是 M5 Exit + P6 批准；本简报不加条件也不减条件。
- 不是试点替代：商业条款与签约在 M6-5，归 founder 与销售/法务。
