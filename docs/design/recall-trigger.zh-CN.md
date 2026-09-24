[English](recall-trigger.md) | [简体中文](recall-trigger.zh-CN.md)

# 召回触发评估器与 Tick 调度器（issue #577）

> 定位：Phase D 召回触发的契约词汇、纯函数实现与编排缝合——tick source、5 类原因闭集、why-now 卡、wish-pool 只读集成。**不激活 setInterval、不推送、不 mutation wish-pool**（全部留 M4）。
> 状态：内部切片（2026-09-24）。karpo-deck-web 借鉴路线图 Phase D；pull-model 约束来自 `docs/design/external-event-seam.md` §3.3/§4（M5 WriteGate 开闸前无 push）。
> 上游：issue #577；[karpo-deck-web 参考研究](../research/karpo-deck-web-research.zh-CN.md) §3 Phase D；接缝约束见 [external-event-seam.md](external-event-seam.zh-CN.md)。
> 下游：`ts/scripts/recall-tests.ts`（run-all §6i）；后续 M4 切片（经接缝本地 producer 接真 tick 源、dsh 工具注册、wish-pool mutation 接线）。

## 速览（TL;DR）

- `TickSource` 接口 + `InMemoryTickSource`（测试用）+ `PeriodicTickSource`（**默认 `enabled=false`**；M4 显式 opt-in）。`RecallTickScheduler` 编排 tick → 评估 → 卡 → sink，每次 `run()` 恰处理一个 tick——自己不循环。
- `evaluateRecallTriggers(pool, ctx)`——纯函数，把 wish-pool 候选与信号配对。**5 类 `RecallReason` 闭集**（`holiday_proximity` / `price_drop` / `weather_window` / `route_new` / `availability_recovered`）；广播信号匹配全部有效候选，定向信号按 wish_id 精确匹配。畸形信号静默跳过不崩。
- `buildWhyNowCard(trigger)`——纯函数产数据卡（标题 / 原因标签 / 当前值 / 阈值 / 行动建议 / **source tag 必现**）。`renderWhyNowCardLine(card)` 渲染单行供日志/对话用。
- `evaluatePoolRecall(input)`——wish-pool 只读集成（不 mutation；召回/通知留 M4）。
- 49 断言（run-all §6i，自检 review 加固后）覆盖：opt-in 纪律（三态 start、阻塞 next、有界 pending、防御式拷贝）、5 类原因可达、广播 vs 定向匹配、muted/无 id 过滤、source tag 必现、逐卡投递容错、按 tick 盖 provenance 戳的 scheduler 端到端。

## 1. Tick source

```ts
export interface RecallTick { at: Date; source: string }
export interface TickSource { next(): Promise<RecallTick | null> }
```

- `InMemoryTickSource`——预排队列；耗尽返回 `null`。仅测试。构造与 `next()` 均防御式深拷贝——调用方改返回的 tick 不会污染队列快照。
- `PeriodicTickSource`——封装 `setInterval`；**`enabled` 构造默认 `false`，必须显式置 `true`**。`start()` 返回三态 `'started' | 'disabled' | 'already-running'`（不混同）。构造时 `intervalMs` 非正数或 `maxPending` 非正整数抛错（fail-closed）。timer `unref()`（不拽住事件循环）。pending 队列有界（`maxPending` 默认 100，溢出丢最旧——慢消费者不会无限积压过期 tick）。**`next()` 阻塞到下一个 tick 可用**（drain-loop 调用方不会因首个 null 退出而错过后续周期 tick）。本切片在产品代码里从不构造 enabled 实例——M4 接缝的本地 producer（issue #82）。
- `RecallTickScheduler`——收 `{ evaluate, toCard, sink }` 依赖；`run(tick)` 恰处理一个 tick 并返 `{ delivered, failed }`。**逐卡容错**：单个 `sink.deliver` 拒绝只弃该卡（余下继续；异常不外泄）。无内部循环：调用方（现在的测试、M4 的 producer）驱动迭代。`toCard(evaluation, tick)` 收到 tick——卡的 `evaluated_at` 必须取 `tick.at`，不用外层时钟。

## 2. 评估器：5 类闭集

```ts
export type RecallReason =
  | 'holiday_proximity' | 'price_drop' | 'weather_window'
  | 'route_new' | 'availability_recovered'
```

`evaluateRecallTriggers(pool, { now, signals })` 把每个良构信号与匹配候选配对：

- **定向**（`signal.wish_ids` 非空）：仅精确匹配 wish_id。
- **广播**（`wish_ids` 空/缺省）：匹配全部未 `muted` 且有非空字符串 `wish_id` 的候选（与 `wish-pool.ts` 的 `pickNudgeWish` 同一稳定性纪律）。
- 一个 wish × 多个信号 → 多个触发（一卡一信号）。
- 畸形信号（未知 reason / 空 source / 字段缺失 / null / 非对象）静默跳过——闭集在边界强制，不从输入信任。
- 空信号或空 pool → 空数组。**不硬推。**

## 3. Why-now 卡

```ts
export interface WhyNowCard {
  title: string           // 「现在可以去了：{wish_name}」——封闭词汇
  reason: RecallReason
  reason_label: string    // 如「假期临近」
  current_value: string   // 如「2026-10-01（距今 7 天）」
  threshold: string       // 如「距假期 ≤14 天」
  action_hint: string     // 按原因闭集（5 种）
  source_tag: string      // 「[source:{signal.source}]」——必现
  evaluated_at: string    // ISO
  evidence_boundary: true // 渲染面必须展示
}
```

研究文档红线——**proactive with provenance**——结构化强制：`source_tag` 派生自 `signal.source`，而评估器要求 source 是非空字符串信号才能触发。没有信源的卡在构造上不可能存在。

## 4. Wish-pool 集成

`evaluatePoolRecall({ pool, tick, signals })`——在 `WishPoolEntry[]` 上组合评估器与卡构造器。**只读**：模块导入类型但从不调用 `wish-pool.ts` 的 mutation 函数。触发之后发生什么（静音、通知、排期）是 M4 的事。

## 5. 决策日志

- **为什么不 push。** external-event 接缝设计（§3.3/§4）明说：M5 WriteGate 开闸前 gotry 没有主动触达通道；事件改变的是下一次召回/对话的*信息质量*，不是打断用户。why-now 卡富化 pull-model 召回；sink 是注入的下游，绝不是通知通道。
- **为什么 `PeriodicTickSource` 默认关闭。** 仓库的运行时激活纪律（w2a/0.1 contract-only 切片先例）：悄悄启动的后台循环是新的运维面与故障面。`enabled=false` + 显式 opt-in 让本切片零激活。
- **为什么 `run(tick)` 恰处理一个 tick。** 内部自循环的 scheduler 拥有自己的生命周期——调用方无法给它设界。一 tick 一调用让测试确定性，也让 M4 的 producer 完全掌控迭代。
- **为什么原因闭集是 5 类。** 每类原因必须有 M4 真能接上的信源（假期日历、价格监控、天气、班次更新、通道健康）；先于传感器发明原因会造出永不触发的词汇。新原因随它的传感器一起、在一次 review 过的变更里到达。
- **为什么标题是封闭词汇。** 「现在可以去了：{name}」是渲染面（deck/对话/SMS）的契约面；自由标题会让双语渲染与审计过滤失去边界。改措辞 = 契约变更。
- **为什么 muted 与无 id 条目在评估层过滤。** 镜像 `pickNudgeWish` 的纪律：静音的愿望永不召回；没有稳定 wish_id 的条目无法被下游 mutation 引用。在这里过滤（而非卡层）让卡片构造即合法。

## 6. 切片状态与显式不主张

本切片落地：`ts/src/recall/{tick,evaluator,card,integration}.ts` + `ts/scripts/recall-tests.ts`（自检 review 加固后 49 断言，run-all §6i）。

不在本切片：真 tick 激活（M4，经接缝本地 producer，issue #82）；dsh 工具注册（`gotry_recall_*`）；触发后的 wish-pool mutation（静音/通知）；信号生产者（真正填 `RecallSignal` 的假期日历/价格监控/天气/班次/通道健康适配器）；任何推送通知路径（M5 WriteGate）。缝合契约完整；M4 接 producer 与消费者，不动本模块 API。

## 7. 交叉引用

- `docs/research/karpo-deck-web-research.zh-CN.md` §3 Phase D——切片决策。
- `docs/design/external-event-seam.zh-CN.md` §3.3/§4——本切片遵守的 pull-model 约束。
- `ts/src/wish-pool.ts`——本模块镜像的候选形状与稳定性纪律。
- `docs/code-map.md` 中 `ts/src/recall/*` 各行。
