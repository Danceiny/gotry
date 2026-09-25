[English](recall-trigger.md) | [简体中文](recall-trigger.zh-CN.md)

# 召回触发评估器与 Tick 调度器（issue #577）

> 定位：Phase D 召回触发的契约词汇、纯函数实现与编排缝合——tick source、5 类原因闭集、why-now 卡、wish-pool 只读集成。**不激活 setInterval、不推送、不 mutation wish-pool**（全部留 M4）。
> 状态：内部契约切片，包含愿望条件资格检查与命中证据。karpo-deck-web 借鉴路线图 Phase D；pull-model 约束来自 `docs/design/external-event-seam.md` §3.3/§4（M5 WriteGate 开闸前无 push）。
> 上游：issue #577；[karpo-deck-web 参考研究](../research/karpo-deck-web-research.zh-CN.md) §3 Phase D；接缝约束见 [external-event-seam.md](external-event-seam.zh-CN.md)。
> 下游：`ts/scripts/recall-tests.ts`（run-all §6i）；后续 M4 切片（经接缝本地 producer 接真 tick 源、dsh 工具注册、wish-pool mutation 接线）。

## 速览（TL;DR）

- `TickSource` 接口 + `InMemoryTickSource`（测试用）+ `PeriodicTickSource`（**默认 `enabled=false`**；M4 显式 opt-in）。`RecallTickScheduler` 编排 tick → 评估 → 卡 → sink，每次 `run()` 恰处理一个 tick——自己不循环。
- `evaluateRecallTriggers(pool, ctx)`——纯函数，把 wish-pool 候选与信号配对。**5 类 `RecallReason` 闭集**（`holiday_proximity` / `price_drop` / `weather_window` / `route_new` / `availability_recovered`）；**候选必须先过条件资格门**：`ctx.match_context`（`WishMatchContext`）喂给 `wish-pool.ts` 现有的 `scoreWishMatch`（原样复用——不造第二套判定）；days/budget/month 任一命中即有召回资格，命名 down 通道否证。信号（含定向）不能绕过资格门；`match_context` 缺省/畸形 → fail-closed 空返回，绝不降级为广播。每个触发携带实际命中的 `match_hits`。畸形信号静默跳过不崩。
- `buildWhyNowCard(trigger)`——纯函数产数据卡（标题 / 原因标签 / 当前值 / 阈值 / 行动建议 / **source tag 必现** / 触发携带条件命中时的 `match_evidence`）。`renderWhyNowCardLine(card)` 渲染单行供日志/对话用，并声明边界：命中的愿望条件不等于全部出行条件已满足。
- `evaluatePoolRecall(input)`——wish-pool 只读集成（不 mutation；召回/通知留 M4）。
- 96 断言（run-all §6i）覆盖：opt-in 纪律（三态 start、阻塞 next、有界 pending、防御式拷贝）、有效条件下 5 类原因可达、资格门之后的广播 vs 定向匹配、muted/无 id 过滤、source tag 必现、命中证据贯穿触发 → 卡 → 渲染边界、逐卡投递容错、按 tick 盖 provenance 戳的 scheduler 端到端。

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

`evaluateRecallTriggers(pool, { now, signals, match_context })` 按顺序过两道门：

1. **资格门**——候选只有当 `scoreWishMatch(entry, match_context)` 返回命中才进入匹配：days/budget/month 任一对注入窗口命中，且（当提供 down 面时）条件命名的通道不在 `match_context.channelDown` 里。评分器从 `ts/src/wish-pool.ts` 导入、原样复用——本模块绝不复制它的算术与阈值。
2. **匹配门**——定向（`signal.wish_ids` 非空）：在有资格的候选里按 wish_id 精确匹配。广播（`wish_ids` 空/缺省）：匹配全部**有资格**候选（未 `muted`、有非空字符串 `wish_id`）。**定向信号不能绕过资格门。**

- 一个 wish × 多个信号 → 多个触发（一卡一信号）。
- 畸形信号（未知 reason / 空 source / 字段缺失 / null / 非对象）静默跳过——闭集在边界强制，不从输入信任。
- 空信号或空 pool → 空数组。**不硬推。**

### 条件资格边界规则（issue #577 收口）

- **`match_context` 缺省或畸形 → 整轮 fail-closed 空返回**——绝不降级为广播。JSON 往返把数字变字符串、数字非有限、`channelDown` 不是 Set 形（比如是数组），都算畸形。窗口未知时不得授权「现在可以去了」。
- **空上下文 `{}` 形状合法但没有可供判定的窗口事实**：零窗口事实 → 零命中 → 零触发。
- **任一命中即有资格**（评分器既有语义）：days/budget/month 一项命中就是召回*资格*，不是「全部出行条件已满足」的证明。否证与算术都归评分器，原样未动。
- **producer 与 matcher 的职责边界**：信号是 producer 给的事件通知——`current_value`/`threshold` 是人话展示串，不是类型化的价格/日期事实。评估器绝不解析它们；类型化事实只经 `match_context` 进入。
- 每个 `RecallTrigger` 携带 `match_hits`——评分器的逐项命中串（如 `days≥5`），触发存在则必非空。
- 畸形运行时形态（conditions 为字符串/数字、`best_months` 为字符串、null 条目）由评分器自身的防御语义判定，绝不抛错；评分器意外抛错只弃该条目。

## 3. Why-now 卡

```ts
export interface WhyNowCard {
  title: string           // 「现在可以去了:{wish_name}」(半角冒号——代码字面量即契约)——封闭词汇
  reason: RecallReason
  reason_label: string    // 如「假期临近」
  current_value: string   // 如「2026-10-01（距今 7 天）」
  threshold: string       // 如「距假期 ≤14 天」
  action_hint: string     // 按原因闭集（5 种）
  source_tag: string      // 「[source:{signal.source}]」——必现
  evaluated_at: string    // ISO
  evidence_boundary: true // 渲染面必须展示
  match_evidence?: string[] // 实际命中的条件，如「days≥5」——缺省 = 未附证据
}
```

研究文档红线——**proactive with provenance**——结构化强制：`source_tag` 派生自 `signal.source`，而评估器要求 source 是非空字符串信号才能触发。没有信源的卡在构造上不可能存在。

**证据诚实（#577 收口）**：`buildWhyNowCard` 只在 `trigger.match_hits` 是非空的非空字符串数组时才原样带进 `match_evidence`——all-or-nothing，不裁剪、不发明。手工构造、无命中的 trigger 产出的卡只陈述信号、不带条件证据，渲染行保留朴素的 `[证据边界:仅证据驱动]` 标记。证据在场时，渲染行逐项陈述命中条件（`;命中条件:days≥5+…`），且边界标记显式拒绝更强的主张：`[证据边界:仅命中上述愿望条件,非全部出行条件已满足]`。卡片永不主张全部出行条件已满足。

## 4. Wish-pool 集成

`evaluatePoolRecall({ pool, tick, signals, match_context })`——在 `WishPoolEntry[]` 上组合评估器与卡构造器，`match_context` 原样透传。**只读**：模块导入类型但从不调用 `wish-pool.ts` 的 mutation 函数。触发之后发生什么（静音、通知、排期）是 M4 的事。Phase E 的 plan-it 行动卡（`buildPlanItAction`）只消费 `card.wish_id`，不受可选证据字段影响——session-link 套件钉住这一点。

## 5. 决策日志

- **为什么资格判定先于信号路由。** 复用 `scoreWishMatch` 作为唯一判定层：原因事件（假期临近、降价……）提升的是召回的*信息质量*；愿望自身条件对照注入窗口决定*资格*。在这里复制或扩展那套算术，等于造出第二套要同步维系的 matcher。
- **为什么一项命中即有资格——以及为什么卡要说明。** 按评分器既有语义，days/budget/month 任一命中即给召回资格；它不是「全部出行条件已满足」的证明。这个边界由卡承载（`match_evidence` + 渲染边界子句），而不是由「现在可以去了」标题默默暗示。
- **为什么评估器绝不解析信号串。** `current_value`/`threshold` 是 producer 的展示串；在这里解析等于 fork producer 的渲染契约、招致分叉的价格/日期语义。类型化事实只经 `match_context` 进入。
- **为什么缺上下文要 fail-closed。** 窗口未知时广播，等于在调用方坏掉的场景里重现 #577 的扩权；空返回是唯一诚实的答案。
- **为什么不 push。** external-event 接缝设计（§3.3/§4）明说：M5 WriteGate 开闸前 gotry 没有主动触达通道；事件改变的是下一次召回/对话的*信息质量*，不是打断用户。why-now 卡富化 pull-model 召回；sink 是注入的下游，绝不是通知通道。
- **为什么 `PeriodicTickSource` 默认关闭。** 仓库的运行时激活纪律（w2a/0.1 contract-only 切片先例）：悄悄启动的后台循环是新的运维面与故障面。`enabled=false` + 显式 opt-in 让本切片零激活。
- **为什么 `run(tick)` 恰处理一个 tick。** 内部自循环的 scheduler 拥有自己的生命周期——调用方无法给它设界。一 tick 一调用让测试确定性，也让 M4 的 producer 完全掌控迭代。
- **为什么原因闭集是 5 类。** 每类原因必须有 M4 真能接上的信源（假期日历、价格监控、天气、班次更新、通道健康）；先于传感器发明原因会造出永不触发的词汇。新原因随它的传感器一起、在一次 review 过的变更里到达。
- **为什么标题是封闭词汇。** 「现在可以去了:{name}」是渲染面（deck/对话/SMS）的契约面；自由标题会让双语渲染与审计过滤失去边界。改措辞 = 契约变更。
- **为什么 muted 与无 id 条目在评估层过滤。** 镜像 `pickNudgeWish` 的纪律：静音的愿望永不召回；没有稳定 wish_id 的条目无法被下游 mutation 引用。在这里过滤（而非卡层）让卡片构造即合法。

## 6. 切片状态与显式不主张

本切片落地：`ts/src/recall/{tick,evaluator,card,integration}.ts` + `ts/scripts/recall-tests.ts`（96 断言，run-all §6i）。未新增任何运行时激活：评估器、卡构造器与集成层保持纯函数，无 IO、无状态、无 timer。

不在本切片：真 tick 激活（M4，经接缝本地 producer，issue #82）；dsh 工具注册（`gotry_recall_*`）；触发后的 wish-pool mutation（静音/通知）；信号生产者（真正填 `RecallSignal` 的假期日历/价格监控/天气/班次/通道健康适配器）；任何推送通知路径（M5 WriteGate）。缝合契约完整；M4 接 producer 与消费者，不动本模块 API。

## 7. 交叉引用

- `docs/research/karpo-deck-web-research.zh-CN.md` §3 Phase D——切片决策。
- `docs/design/external-event-seam.zh-CN.md` §3.3/§4——本切片遵守的 pull-model 约束。
- `ts/src/wish-pool.ts`——本模块镜像的候选形状与稳定性纪律。
- `docs/code-map.md` 中 `ts/src/recall/*` 各行。
