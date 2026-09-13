[English](roadmap.md) | [简体中文](roadmap.zh-CN.md)

# GoTry 路线图

> 定位：里程碑顺序、准入门、退出证据与当前产品位置的唯一权威面。
> 状态：living。
> 上游：记录于 [`gotry-master-outline.zh-CN.md`](gotry-master-outline.zh-CN.md) 的产品战略与创始人决策。
> 下游：交付规划、发布决策与里程碑验收。
> 证据纪律：已实现机制、本地证明、真实用户证据与商业授权是四种不同声明。

## 速览

- M0–M2 建立了确定性规划闭环、Agent 形态与实时证据链。
- 当前位于 M3。真实种子用户证据仍未满足退出门；工程活动不能替代该证据。
- M4 工程可并行推进，但正式 M4 准入仍依赖 M3 退出，且自身需要真实回访用户 cohort。
- Booking Copilot 是内嵌只读动作工程线。四 surface 真实库存与不可订恢复仍由 [#142](https://github.com/Danceiny/gotry/issues/142) 跟踪。
- M5 交易写入仍封在 WriteGate 与供应链授权之后；M6 还要求 M5 退出、创始人批准与真实试点。

## 1. 当前位置

| 关注面 | 当前位置 | 权威来源 |
|---|---|---|
| 已发布包 | npm `latest` 指向 `0.0.1-rc.24`；兼容用 `rc` tag 仍指向 `0.0.1-rc.20`。源码 `main` 可能领先两者。 | [`release-notes.zh-CN.md`](release-notes.zh-CN.md) 与 [CHANGELOG](../CHANGELOG.md) |
| 产品里程碑 | M3 证据仍开放。Web 产品与确定性 scorer 已存在；真实 50–200 人种子用户结果集尚未满足退出门。 | [#22](https://github.com/Danceiny/gotry/issues/22) |
| 评测 | 确定性契约与校验器已存在。未取得准入且完整的 cohort 前，不声明 official score 或 uplift。 | [`evaluation/evaluation-foundation.zh-CN.md`](evaluation/evaluation-foundation.zh-CN.md) |
| 记忆 | M4 collector 与 scorer 只属于工程支持；仍需带 source review 的真实 `observed_private` 回访 cohort。 | [#20](https://github.com/Danceiny/gotry/issues/20) |
| Booking Copilot | GoTry 可为既有预订工作台规划 typed 只读动作；`Book` 仍由 Checkout 独占。真实库存、恢复、Checkout 与订单状态证据仍开放。 | [`architecture.zh-CN.md` §10 D-29](architecture.zh-CN.md#101-未清偿工作面)、[#142](https://github.com/Danceiny/gotry/issues/142) |
| 交易与 B2B | M5 与 M6 尚未准入。离线契约与 fixture 不会启封供应商写入，也不能证明真实试点。 | [#136](https://github.com/Danceiny/gotry/issues/136)、[#137](https://github.com/Danceiny/gotry/issues/137) |

当前架构细节归 [`architecture.zh-CN.md`](architecture.zh-CN.md)，逐工具契约归 [`tools.zh-CN.md`](tools.zh-CN.md)。逐变更历史归 git、[CHANGELOG](../CHANGELOG.md) 与 [`release-notes.zh-CN.md`](release-notes.zh-CN.md)，不进入本路线图。

## 2. 里程碑顺序

| # | 结果 | 准入 | 退出证据 | 状态 |
|---|---|---|---|---|
| M0 | 确定性管道 | 产品前提 | 双引擎对账与可复现数据包 | 已达到 |
| M1 | Agent 形态 | M0 | 真实 LLM 会话问出承重问题，并在不虚构算术的前提下交付过闸方案 | 已达到 |
| M2 | 实时证据 | M1 与数据源决策 | 实时与静态差异可度量，事实来源可见 | 已达到 |
| M3 | 最小可用产品 | M2 与 G1 市场锁定 | 在准入的 50–200 人证据集中，定稿率 ≥40%、NPS ≥40、POI 幻觉 <1% | 当前；证据开放 |
| M4 | 记忆与下一次出发 | M3 退出 | 回访规划时长下降 ≥50%，经验回流率具备经审阅的基线 | 仅并行工程 |
| M5 | 交易闭环 | M4 退出与供应链授权 | 预订零误操作事故，单位经济已实测 | 封闭 |
| M6 | B2B 包裹 | M5 退出与创始人明确批准 | 冻结内核复用、真实旅行社嵌入 E2E 与签约试点 | 封闭 |

即使工程并行，顺序仍是硬约束：离线契约、fixture 或本地证明可以准备后续里程碑，但不能满足其准入或退出证据。

## 3. 当前闸门

### M3——真实产品证据

- Tracker：[#22](https://github.com/Danceiny/gotry/issues/22)。
- 必须具备：准入、脱敏的 50–200 人真实证据集，以及全部三项退出指标。
- 不接受替代：邀请人数、确定性 fixture 或单独的实现覆盖率。

### M4——回访用户价值

- Tracker：[#20](https://github.com/Danceiny/gotry/issues/20)。
- 必须具备：真实 `observed_private` 回访 cohort、N≥5、配对规划时长对比、回流基线与人工 source-review attestation。
- 不接受替代：历史 wish 日志、candidate／synthetic 导出，或缺少真实 cohort 的 scorer 结果。

### M5——授权交易链

- Tracker：[#136](https://github.com/Danceiny/gotry/issues/136)。
- 激活前必须具备：M4 退出，以及供应协议或内部授权。
- 退出必须具备：真实 WriteGate 受控的预订、支付、退改链；佣金披露；对账；零误操作与单位经济证据。
- 红线：设计文档、纯契约、mock CLI 或 Booking Copilot 只读动作都不能激活供应商写入。

### M6——经验证的 B2B 复用

- Tracker：[#137](https://github.com/Danceiny/gotry/issues/137)。
- 激活前必须具备：M5 退出与创始人明确批准。
- 退出必须具备：固定 kernel-set 零 diff、运行时与功能路径覆盖、真实旅行社嵌入 E2E 与签约试点。
- 不接受替代：走查、未签署意向或单独的 loaded-LOC ratio。

## 4. 支撑文档

| 关注点 | 文档 |
|---|---|
| 当前系统、ADR 与开放债务 | [`architecture.zh-CN.md`](architecture.zh-CN.md) |
| M4–M6 依赖图 | [`design/milestone-delivery-plan.zh-CN.md`](design/milestone-delivery-plan.zh-CN.md) |
| M5 交易权威与恢复 | [`design/write-gate-production-design.zh-CN.md`](design/write-gate-production-design.zh-CN.md) |
| M6 决策材料 | [`milestones/m6-b2b-reuse-walkthrough.zh-CN.md`](milestones/m6-b2b-reuse-walkthrough.zh-CN.md) |
| 评测准入 | [`evaluation/evaluation-foundation.zh-CN.md`](evaluation/evaluation-foundation.zh-CN.md) |

## 5. 旧模型映射

| 旧模型 | 规范映射 |
|---|---|
| 技术 Stage 0／1／2／3／4 | M0／M1／M2／M4／M6；M3 与 M5 是产品／商业交汇点 |
| 总纲 Phase 0／1／2／3 | M0–M1／M1–M3／M3–M5／M5–M6 |
| 产品 M1／M2／M3 | M3／M4／M5 |
