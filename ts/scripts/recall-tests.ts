/**
 * Recall contract 验收套件(issue #577,Phase D):
 * tick source(InMemory + PeriodicTickSource opt-in 纪律)
 * + evaluator(5 类 RecallReason 闭集 + 广播/定向匹配)
 * + why-now card(source tag 必现 + 行动建议)
 * + integration(wish-pool 只读编排)
 * + RecallTickScheduler 端到端(tick → 评估 → 卡 → sink)。
 *
 * 全离线合成数据,无网络、无 IO、无 stateRoot 写。产品代码零 setInterval 激活;
 * 测试本身启动有界、用后即 stop 的 interval(验证 PeriodicTickSource 契约)。
 *
 * 运行(在 ts/ 下):npx tsx scripts/recall-tests.ts
 */

import {
  ArrayRecallSink,
  InMemoryTickSource,
  PeriodicTickSource,
  RecallTickScheduler,
  type RecallSink,
  type RecallTick,
} from '../src/recall/tick.ts'
import {
  RECALL_REASON_LABEL,
  RECALL_REASONS,
  evaluateRecallTriggers,
  type RecallContext,
  type RecallSignal,
  type RecallTrigger,
} from '../src/recall/evaluator.ts'
import { buildWhyNowCard, renderWhyNowCardLine, type WhyNowCard } from '../src/recall/card.ts'
import { evaluatePoolRecall } from '../src/recall/integration.ts'

let pass = 0
let fail = 0
const failures: string[] = []

function ok(cond: boolean, msg: string): void {
  if (cond) { pass++; return }
  fail++
  failures.push(msg)
}

const NOW = new Date('2026-09-24T08:00:00.000Z')
const TICK: RecallTick = { at: NOW, source: 'test-tick' }

const POOL = [
  { wish_id: 'w-dali-erhai', name: '大理 · 洱海恢复之旅', conditions: { days: 5, budget_cny: 5000 }, added_at: '2026-07-01T00:00:00Z' },
  { wish_id: 'w-qiandao', name: '千岛湖周末', conditions: { days: 2, budget_cny: 2000 }, added_at: '2026-08-15T00:00:00Z' },
  { wish_id: 'w-nocond', name: '无条件的愿望(条件门不召回)', added_at: '2026-09-20T00:00:00Z' },
  { wish_id: 'w-muted', name: '静音的愿望', muted: true, conditions: { days: 2 }, added_at: '2026-06-01T00:00:00Z' },
  { wish_id: '', name: '无 id 的愿望(不召回)', conditions: { days: 2 }, added_at: '2026-06-01T00:00:00Z' },
]

/** 召回窗口上下文(§6/§7 条件资格门用)。days=7 使 POOL 全部带条件条目均命中
 *  (含 muted/无 id 的 days:2)——它们被排除只能归因于过滤,而非条件不命中。 */
const MATCH_CTX = { days: 7, budgetCny: 6000, month: 10 }

const SIGNAL_HOLIDAY: RecallSignal = {
  reason: 'holiday_proximity',
  source: 'holiday-calendar',
  current_value: '2026-10-01(距今 7 天)',
  threshold: '距假期 ≤14 天',
}
const SIGNAL_PRICE: RecallSignal = {
  reason: 'price_drop',
  source: 'price-monitor',
  current_value: 'SZX→HKT ¥890',
  threshold: '≤¥1000',
  wish_ids: ['w-dali-erhai'],
}
const SIGNAL_WEATHER: RecallSignal = {
  reason: 'weather_window',
  source: 'weather-forecast',
  current_value: '大理 10/01-10/05 晴 18-24°C',
  threshold: '连续 5 天适旅',
  wish_ids: ['w-dali-erhai'],
}
const SIGNAL_ROUTE: RecallSignal = {
  reason: 'route_new',
  source: 'schedule-update',
  current_value: 'G7315 新增 10/01 班次',
  threshold: '覆盖目标日期',
}
const SIGNAL_RECOVERED: RecallSignal = {
  reason: 'availability_recovered',
  source: 'channel-health',
  current_value: 'session:ctrip-flight 恢复 ok',
  threshold: '此前 down 的通道恢复',
}

// ===========================================================================
// §1 tick source — InMemory 顺序 + PeriodicTickSource 默认关闭(opt-in 纪律)
// ===========================================================================

{
  const src = new InMemoryTickSource([
    { at: NOW, source: 't1' },
    { at: new Date(NOW.getTime() + 60_000), source: 't2' },
  ])
  const a = await src.next()
  const b = await src.next()
  const c = await src.next()
  ok(a?.source === 't1' && b?.source === 't2', '§1a InMemoryTickSource 按序返回')
  ok(c === null, '§1b 耗尽后返回 null')

  // PeriodicTickSource 默认关闭
  const periodic = new PeriodicTickSource({ intervalMs: 1000 })
  ok(periodic.enabled === false, '§1c PeriodicTickSource 默认 enabled=false(opt-in 纪律)')
  ok(periodic.start() === 'disabled', "§1d enabled=false 时 start() 返回 'disabled'(不启动)")
  // review2 #2:未运行(disabled/未 start)的 next() 返回 null(流终结,永不悬挂)
  const disabledNext = await periodic.next()
  ok(disabledNext === null, '§1d0 未运行源的 next() 返回 null(drain-loop 安全退出)')
  periodic.stop() // 幂等停止

  // review #3:start() 三态——已启动的实例重复 start 返回 already-running(不混同 disabled)
  const running = new PeriodicTickSource({ intervalMs: 10, enabled: true, source: 'rt' })
  ok(running.start() === 'started', "§1d2 首次 start → 'started'")
  ok(running.start() === 'already-running', "§1d3 重复 start → 'already-running'(与 disabled 不混同)")
  // review #1:next() 阻塞语义——10ms 间隔,1s 超时护栏内必须等到真 tick
  const gotTick = await Promise.race([
    running.next(),
    new Promise<null>(resolve => setTimeout(() => resolve(null), 1000)),
  ])
  ok(gotTick !== null && gotTick.source === 'rt', '§1d4 next() 阻塞到下一个 tick(drain-loop 安全)')
  running.stop()

  // review #5:pending 有界——1ms 间隔 + maxPending=3,不消费,等 200ms,队列恰满 3(上限真到达)
  const capped = new PeriodicTickSource({ intervalMs: 1, enabled: true, maxPending: 3, source: 'cap' })
  capped.start()
  await new Promise(resolve => setTimeout(resolve, 200))
  ok(capped.pendingLength === 3, `§1d5 pending 恰满 maxPending=3(实测 ${capped.pendingLength};上限真到达,一侧不等式防 vacuous pass)`)
  // review2 #3:stop() 清空 pending(重启不吐陈旧 tick)
  capped.stop()
  ok(capped.pendingLength === 0, `§1d5b stop() 清空 pending(实测 ${capped.pendingLength};重启不吐陈旧 tick)`)
  // review2 #2:stop() 把等待者以 null 唤醒(消费协程不泄漏)
  const flusher = new PeriodicTickSource({ intervalMs: 10_000, enabled: true, source: 'fl' })
  flusher.start()
  const hangingNext = flusher.next()  // 先挂起一个等待者(不 await)
  await new Promise(resolve => setTimeout(resolve, 30))  // 确保 waiter 已注册
  flusher.stop()
  const flushed = await Promise.race([hangingNext, new Promise<'timeout'>(r => setTimeout(() => r('timeout'), 500))])
  ok(flushed === null, `§1d5c stop() 把等待者以 null 唤醒(实测 ${String(flushed)};协程不泄漏)`)

  // review #5b:maxPending 非法 → 构造抛错
  let badMax = false
  try {
    new PeriodicTickSource({ intervalMs: 100, enabled: true, maxPending: 0 })
  } catch { badMax = true }
  ok(badMax, '§1d6 maxPending=0 → 构造抛错(fail-closed)')

  // review #7:InMemoryTickSource 防御式深拷贝——改返回的 tick.at 不污染队列
  const mem = new InMemoryTickSource([{ at: new Date(1000), source: 'dc' }, { at: new Date(2000), source: 'dc2' }])
  const first = await mem.next()
  if (first) first.at.setTime(999999)  // 恶意改副本
  const second = await mem.next()
  ok(second !== null && second.at.getTime() === 2000, `§1d7 InMemory 深拷贝:改返回副本不污染队列(第二个 at=${second?.at.getTime()})`)

  // intervalMs 非法 → 构造抛错
  let badInterval = false
  try {
    new PeriodicTickSource({ intervalMs: -1 })
  } catch { badInterval = true }
  ok(badInterval, '§1f intervalMs 非法 → 构造抛错(fail-closed)')

  // ArrayRecallSink 收集
  const sink = new ArrayRecallSink()
  sink.deliver({ x: 1 })
  sink.deliver({ x: 2 })
  ok(sink.items.length === 2 && (sink.items[0] as { x: number }).x === 1, '§1g ArrayRecallSink 按序收集')
}

// ===========================================================================
// §2 evaluator — 闭集 + 广播/定向 + muted/无 id 过滤 + 无信号空返回
// ===========================================================================

{
  ok(RECALL_REASONS.length === 5, `§2a RecallReason 闭集 5 类(实测 ${RECALL_REASONS.length})`)
  ok(RECALL_REASON_LABEL.holiday_proximity === '假期临近', '§2b reason label 中文标签')

  // 无信号 → 空触发
  const empty = evaluateRecallTriggers(POOL, { now: NOW, match_context: MATCH_CTX, signals: [] })
  ok(empty.length === 0, '§2c 无信号 → 空触发(不硬推)')

  // 广播信号(holiday_proximity 无 wish_ids)→ 匹配全部未 muted 且有 id 的候选
  const broadcast = evaluateRecallTriggers(POOL, { now: NOW, match_context: MATCH_CTX, signals: [SIGNAL_HOLIDAY] })
  ok(broadcast.length === 2, `§2d 广播信号命中 2 个有效候选(实测 ${broadcast.length};muted + 无 id 被滤)`)
  ok(broadcast.every(t => t.wish_id === 'w-dali-erhai' || t.wish_id === 'w-qiandao'),
    '§2e 广播信号命中的 id 都是有效候选(muted/无 id 不出现)')
  ok(broadcast.every(t => t.signal.reason === 'holiday_proximity'), '§2f 触发携带原信号 reason')
  ok(broadcast.every(t => t.evaluated_at === NOW.toISOString()), '§2g 触发携带评估时刻(ISO)')

  // 定向信号(price_drop 带 wish_ids)→ 只命中指定 id
  const targeted = evaluateRecallTriggers(POOL, { now: NOW, match_context: MATCH_CTX, signals: [SIGNAL_PRICE] })
  ok(targeted.length === 1 && targeted[0].wish_id === 'w-dali-erhai',
    '§2h 定向信号只命中指定 wish_id(其它候选不出现)')

  // 多信号 → 每个信号独立触发(一个 wish 可命中多个信号)
  const multi = evaluateRecallTriggers(POOL, { now: NOW, match_context: MATCH_CTX, signals: [SIGNAL_PRICE, SIGNAL_WEATHER] })
  ok(multi.length === 2, `§2i 两个定向信号(同 wish)→ 2 个触发(实测 ${multi.length})`)
  ok(multi.every(t => t.wish_id === 'w-dali-erhai'), '§2j 同 wish 多信号 → 各自独立触发')
  ok(multi[0].signal.reason !== multi[1].signal.reason, '§2k 触发按信号顺序(reason 不同)')

  // 全 5 类信号可达
  const allSignals: RecallSignal[] = [SIGNAL_HOLIDAY, SIGNAL_PRICE, SIGNAL_WEATHER, SIGNAL_ROUTE, SIGNAL_RECOVERED]
  const allFired = evaluateRecallTriggers(POOL, { now: NOW, match_context: MATCH_CTX, signals: allSignals })
  const firedReasons = new Set(allFired.map(t => t.signal.reason))
  ok(firedReasons.size === 5 && RECALL_REASONS.every(r => firedReasons.has(r)),
    `§2l 5 类 RecallReason 全部可达(实际触发 ${firedReasons.size} 类)`)

  // review2 #1:wish_ids 为字符串(真值非数组)→ 整条畸形跳过,绝不降级广播
  const stringIds = evaluateRecallTriggers(POOL, { now: NOW, match_context: MATCH_CTX, signals: [{ ...SIGNAL_PRICE, wish_ids: 'w-dali-erhai' } as unknown as RecallSignal] })
  ok(stringIds.length === 0, `§2m0 wish_ids 非数组 → 整条跳过(实测 ${stringIds.length} 触发;绝不广播扩权)`)

  // review2 #14:muted 为 'false' 字符串(JSON 往返产物)→ 视为未静音(严格 true 才排除)
  const stringMutedPool = [{ ...POOL[0], muted: 'false' }, { ...POOL[1], muted: 'false' }]
  const stringMuted = evaluateRecallTriggers(stringMutedPool as unknown as typeof POOL, { now: NOW, match_context: MATCH_CTX, signals: [SIGNAL_HOLIDAY] })
  ok(stringMuted.length === 2, `§2m1 muted='false' 字符串 → 未静音照常召回(实测 ${stringMuted.length};严格 muted===true 才排除)`)

  // review2 #6:容器/时钟守卫——坏时钟/非数组容器 → 空返回不抛
  let clockThrew = false
  try {
    evaluateRecallTriggers(POOL, { now: new Date('garbage'), match_context: MATCH_CTX, signals: [SIGNAL_HOLIDAY] })
  } catch { clockThrew = true }
  ok(!clockThrew, '§2m2 ctx.now 非法 → 空返回不抛(toISOString 前置守卫)')
  let containerThrew = false
  try {
    evaluateRecallTriggers(POOL, { now: NOW, match_context: MATCH_CTX, signals: undefined as unknown as RecallSignal[] })
  } catch { containerThrew = true }
  ok(!containerThrew, '§2m3 signals 非数组 → 空返回不抛(容器守卫)')

  // 畸形信号(reason 不在闭集 / source 空 / 字段缺失)→ 静默跳过(不崩、不产触发)
  const badSignals = [
    { reason: 'not_a_reason', source: 'x', current_value: 'y', threshold: 'z' },
    { reason: 'price_drop', source: '', current_value: 'y', threshold: 'z' },
    { reason: 'price_drop', source: 'x' },
    null,
    'not-an-object',
  ] as unknown as RecallSignal[]
  const badResult = evaluateRecallTriggers(POOL, { now: NOW, match_context: MATCH_CTX, signals: badSignals })
  ok(badResult.length === 0, `§2m 畸形信号全部跳过(实测产 ${badResult.length} 触发;不崩不产)`)

  // 空 pool → 任何信号都空
  const emptyPool = evaluateRecallTriggers([], { now: NOW, match_context: MATCH_CTX, signals: [SIGNAL_HOLIDAY] })
  ok(emptyPool.length === 0, '§2n 空 pool → 空触发')
}

// ===========================================================================
// §3 why-now card — source tag 必现 + 行动建议 + 标题封闭词汇
// ===========================================================================

{
  const [trigger] = evaluateRecallTriggers(POOL, { now: NOW, match_context: MATCH_CTX, signals: [SIGNAL_PRICE] })
  ok(trigger !== undefined, '§3a 前置:定向触发存在')
  const card = buildWhyNowCard(trigger!)

  ok(card.title === '现在可以去了:大理 · 洱海恢复之旅', `§3b 标题封闭词汇(实测「${card.title}」)`)
  ok(card.reason === 'price_drop' && card.reason_label === '价格降至阈值', '§3c reason + 中文标签')
  ok(card.current_value === 'SZX→HKT ¥890' && card.threshold === '≤¥1000', '§3d 当前值 + 阈值保持')
  ok(typeof card.action_hint === 'string' && card.action_hint.length > 0, `§3e 行动建议非空(${card.action_hint})`)
  ok(card.source_tag === '[source:price-monitor]', `§3f source tag 必现(实测 ${card.source_tag})`)
  ok(card.evaluated_at === NOW.toISOString(), '§3g evaluated_at 保持')
  ok(card.evidence_boundary === true, '§3h evidence_boundary 恒 true')

  // review2 #4:卡构造边界强制——source 空 / reason 出集 → 抛错(「无信源卡构造不可能」的字面兑现)
  let badSourceThrew = false
  try {
    buildWhyNowCard({ wish_id: 'x', wish_name: 'x', signal: { ...SIGNAL_PRICE, source: '' } as RecallSignal, match_hits: [], evaluated_at: NOW.toISOString() })
  } catch { badSourceThrew = true }
  ok(badSourceThrew, "§3h2 buildWhyNowCard source='' → 抛错(边界强制 provenance)")
  let badReasonThrew = false
  try {
    buildWhyNowCard({ wish_id: 'x', wish_name: 'x', signal: { ...SIGNAL_PRICE, reason: 'bogus' } as unknown as RecallSignal, match_hits: [], evaluated_at: NOW.toISOString() })
  } catch { badReasonThrew = true }
  ok(badReasonThrew, '§3h3 buildWhyNowCard reason 出闭集 → 抛错')

  // review2 #11:5 类行动建议——评估器必须真触发(去 fallback,回归即红)
  const reasonCards: WhyNowCard[] = []
  for (const s of [SIGNAL_HOLIDAY, SIGNAL_PRICE, SIGNAL_WEATHER, SIGNAL_ROUTE, SIGNAL_RECOVERED]) {
    const fired = evaluateRecallTriggers(POOL, { now: NOW, match_context: MATCH_CTX, signals: [s] })
    ok(fired.length >= 1, `§3i0 前置:信号 ${s.reason} 真触发(实测 ${fired.length};无 fallback 掩盖)`)
    reasonCards.push(buildWhyNowCard(fired[0]))
  }
  ok(reasonCards.every(c => c.action_hint.length > 5), '§3i 5 类 reason 的行动建议全部非空')

  // 单行渲染含 source tag
  const line = renderWhyNowCardLine(card)
  ok(line.includes(card.title) && line.includes(card.reason_label) && line.includes(card.source_tag),
    `§3j 单行渲染含标题/原因/source tag(${line.slice(0, 60)}...)`)
  ok(line.includes('当前:') && line.includes('阈值:'), '§3k 单行渲染含当前值/阈值')
  // review2 #8:渲染契约——单行渲染必须含证据边界标记
  ok(line.includes('证据边界'), '§3k2 单行渲染含证据边界标记(渲染面必须展示 evidence_boundary)')
}

// ===========================================================================
// §4 integration — wish-pool 只读编排(tick + signals → triggers + cards)
// ===========================================================================

{
  const result = evaluatePoolRecall({
    pool: POOL,
    tick: TICK,
    match_context: MATCH_CTX,
    signals: [SIGNAL_HOLIDAY, SIGNAL_PRICE],
  })
  ok(result.triggers.length === 3, `§4a 触发数 = 广播(2)+ 定向(1)= 3(实测 ${result.triggers.length})`)
  ok(result.cards.length === result.triggers.length, '§4b 卡数与触发数一致(一卡一触发)')
  ok(result.cards.every(c => c.source_tag.startsWith('[source:')), '§4c 每张卡都带 source tag')

  // 无信号 → 全空
  const emptyResult = evaluatePoolRecall({ pool: POOL, tick: TICK, match_context: MATCH_CTX, signals: [] })
  ok(emptyResult.triggers.length === 0 && emptyResult.cards.length === 0, '§4d 无信号 → 空(不硬推)')
}

// ===========================================================================
// §5 RecallTickScheduler 端到端 — tick → 评估 → 卡 → sink
// ===========================================================================

{
  const sink = new ArrayRecallSink()
  const scheduler = new RecallTickScheduler<{ wish_id: string; signal: RecallSignal; match_hits: string[] }, WhyNowCard>({
    evaluate: (tick) => tick.source === 'test-tick'
      ? evaluatePoolRecall({ pool: POOL, tick, match_context: MATCH_CTX, signals: [SIGNAL_PRICE] }).triggers
        .map(t => ({ wish_id: t.wish_id, signal: t.signal, match_hits: t.match_hits }))
      : [], // 非 test-tick 的 tick 无信号(§5e 用)
    toCard: (evaluation, tick) => buildWhyNowCard({
      wish_id: evaluation.wish_id,
      wish_name: POOL.find(p => p.wish_id === evaluation.wish_id)?.name ?? evaluation.wish_id,
      signal: evaluation.signal,
      match_hits: evaluation.match_hits,  // #577 收口:真命中证据贯穿到卡
      evaluated_at: tick.at.toISOString(),  // review #2:取 tick.at,不用外层 NOW
    }),
    sink,
  })

  const count = await scheduler.run(TICK)
  ok(count.delivered === 1 && count.failed === 0, `§5a 一个 tick + 一个定向信号 → 1 张卡(实测 delivered=${count.delivered}/failed=${count.failed})`)
  ok(sink.items.length === 1, '§5b sink 收到 1 张卡')
  const delivered = sink.items[0] as WhyNowCard
  ok(delivered.source_tag === '[source:price-monitor]', '§5c 卡片 source tag 正确')
  ok(delivered.title.includes('大理'), `§5d 卡片标题含 wish name(${delivered.title})`)

  // 第二个 tick + 无信号 → 0 卡
  const count2 = await scheduler.run({ at: new Date(NOW.getTime() + 3600_000), source: 't2' })
  ok(count2.delivered === 0 && sink.items.length === 1, '§5e 第二 tick 无信号 → 0 新卡(sink 不变)')

  // review #4:sink.deliver 逐卡容错——一个抛错不弃余下,返部分计数
  const flakySink: RecallSink = {
    deliver: (card: unknown) => {
      const c = card as { title: string }
      if (c.title.includes('千岛湖')) throw new Error('sink exploded')  // 第二张卡炸
    },
  }
  const flakyScheduler = new RecallTickScheduler<{ wish_id: string; signal: RecallSignal; match_hits: string[] }, WhyNowCard>({
    evaluate: (tick) => evaluateRecallTriggers(POOL, { now: tick.at, match_context: MATCH_CTX, signals: [SIGNAL_HOLIDAY] })
      .map(t => ({ wish_id: t.wish_id, signal: t.signal, match_hits: t.match_hits })),
    toCard: (evaluation, tick) => buildWhyNowCard({
      wish_id: evaluation.wish_id,
      wish_name: POOL.find(p => p.wish_id === evaluation.wish_id)?.name ?? evaluation.wish_id,
      signal: evaluation.signal,
      match_hits: evaluation.match_hits,
      evaluated_at: tick.at.toISOString(),
    }),
    sink: flakySink,
  })
  const flakyResult = await flakyScheduler.run(TICK)
  ok(flakyResult.delivered === 1 && flakyResult.failed === 1,
    `§5e2 deliver 逐卡容错:1 成功 1 失败不外泄(实测 ${flakyResult.delivered}/${flakyResult.failed})`)
  ok(Array.isArray(flakyResult.errors) && flakyResult.errors!.length > 0 && flakyResult.errors![0].includes('deliver'),
    `§5e3 失败原因记入 errors 数组(实测 ${JSON.stringify(flakyResult.errors)})`)

  // review2 #5:toCard 抛错 → 同样逐卡容错(failed 计数,不杀 run)
  const badCardScheduler = new RecallTickScheduler<{ wish_id: string; signal: RecallSignal; match_hits: string[] }, WhyNowCard>({
    evaluate: (tick) => evaluateRecallTriggers(POOL, { now: tick.at, match_context: MATCH_CTX, signals: [SIGNAL_PRICE] })
      .map(tr => ({ wish_id: tr.wish_id, signal: tr.signal, match_hits: tr.match_hits })),
    toCard: () => { throw new Error('card exploded') },
    sink: new ArrayRecallSink(),
  })
  const badCardResult = await badCardScheduler.run(TICK)
  ok(badCardResult.delivered === 0 && badCardResult.failed === 1,
    `§5e4 toCard 抛错 → failed 计数不杀 run(实测 ${badCardResult.delivered}/${badCardResult.failed})`)

  // review2 #5:evaluate 抛错 → 空结果 + error 记录(不杀 drain loop)
  const badEvalScheduler = new RecallTickScheduler<never, never>({
    evaluate: () => { throw new Error('eval exploded') },
    toCard: (e) => e,
    sink: new ArrayRecallSink(),
  })
  const badEvalResult = await badEvalScheduler.run(TICK)
  ok(badEvalResult.delivered === 0 && badEvalResult.failed === 0 && badEvalResult.errors?.[0]?.includes('evaluate') === true,
    `§5e5 evaluate 抛错 → {0,0,errors} 不外泄(实测 ${JSON.stringify(badEvalResult)})`)

  // InMemoryTickSource 驱动多 tick 端到端
  const multiSink = new ArrayRecallSink()
  const multiScheduler = new RecallTickScheduler<{ wish_id: string; signal: RecallSignal; match_hits: string[] }, WhyNowCard>({
    evaluate: evaluatePoolRecallShim,
    toCard: toCardShim,
    sink: multiSink,
  })
  const src = new InMemoryTickSource([TICK, { at: new Date(NOW.getTime() + 60_000), source: 't2' }])
  let total = 0
  for (let t = await src.next(); t !== null; t = await src.next()) {
    const r = await multiScheduler.run(t)
    total += r.delivered
  }
  ok(total === 2 && multiSink.items.length === 2, `§5f InMemory 多 tick 端到端:2 tick × 1 信号 → 2 卡(实测 ${total}/${multiSink.items.length})`)
  // review #2:第二张卡的 evaluated_at 必须是第二 tick 的时刻(NOW+60s),不是外层 NOW
  const secondCard = multiSink.items[1] as { evaluated_at: string }
  ok(secondCard.evaluated_at === new Date(NOW.getTime() + 60_000).toISOString(),
    `§5f2 第二张卡 evaluated_at = 第二 tick 时刻(实测 ${secondCard.evaluated_at})`)

  function evaluatePoolRecallShim(tick: RecallTick): { wish_id: string; signal: RecallSignal; match_hits: string[] }[] {
    return evaluatePoolRecall({ pool: POOL, tick, match_context: MATCH_CTX, signals: [SIGNAL_PRICE] }).triggers
      .map(t => ({ wish_id: t.wish_id, signal: t.signal, match_hits: t.match_hits }))
  }
  function toCardShim(evaluation: { wish_id: string; signal: RecallSignal; match_hits: string[] }, tick: RecallTick): WhyNowCard {
    return buildWhyNowCard({
      wish_id: evaluation.wish_id,
      wish_name: POOL.find(p => p.wish_id === evaluation.wish_id)?.name ?? evaluation.wish_id,
      signal: evaluation.signal,
      match_hits: evaluation.match_hits,
      evaluated_at: tick.at.toISOString(),
    })
  }
}

// ===========================================================================
// §6 条件资格门(#577 收口):信号不能绕过 wish 条件——
//   资格 = scoreWishMatch(原样复用)非空(任一 days/budget/month 命中;
//   命名 down 通道否证)。match_context 缺省/畸形 → fail-closed 空返回,
//   绝不降级为「全部广播」。语义:任一条件命中即有召回资格,
//   不等于「全部出行条件已满足」。
// ===========================================================================

{
  // 混合资格池:远超窗口 / 无条件 / 仅天数命中 / 依赖 down 通道 / 仅月份命中
  const POOL_R = [
    { wish_id: 'w-far', name: '天数预算都差得远', conditions: { days: 30, budget_cny: 99000 }, added_at: '2026-09-01T00:00:00Z' },
    { wish_id: 'w-nocond', name: '无条件的愿望', added_at: '2026-09-02T00:00:00Z' },
    { wish_id: 'w-onehit', name: '只有天数达标', conditions: { days: 3, budget_cny: 99000, best_months: [1] }, added_at: '2026-09-03T00:00:00Z' },
    { wish_id: 'w-veto', name: '依赖已 down 通道', conditions: { days: 3, channels: ['hbcli-hotel'] }, added_at: '2026-09-04T00:00:00Z' },
    { wish_id: 'w-months', name: '只看月份', conditions: { best_months: [10, 11] }, added_at: '2026-09-05T00:00:00Z' },
  ]
  const idsOf = (ts: ReturnType<typeof evaluateRecallTriggers>) => ts.map(t => t.wish_id).sort().join(',')

  // §6a 有信号但条件全不命中(且无条件)→ 不触发
  const unmatched = evaluateRecallTriggers(
    [{ wish_id: 'w-far', name: '差得远', conditions: { days: 30, budget_cny: 99000 } }, POOL_R[1]],
    { now: NOW, signals: [SIGNAL_HOLIDAY], match_context: MATCH_CTX },
  )
  ok(unmatched.length === 0, `§6a 有信号但条件全不命中/无条件 → 0 触发(实测 ${unmatched.length};不硬推)`)

  // §6b 资格门广播:仅条件命中的候选触发(w-veto days 命中但未提供 down 面 → 不否证,
  //     与 scoreWishMatch「通道健康或健康面缺席不否证」原语义一致;§6g 单独钉否证)
  const gate = evaluateRecallTriggers(POOL_R, { now: NOW, signals: [SIGNAL_HOLIDAY], match_context: MATCH_CTX })
  ok(idsOf(gate) === 'w-months,w-onehit,w-veto', `§6b 广播只达条件命中的候选(实测 ${idsOf(gate)};w-far/w-nocond 不触发)`)

  // §6c match_context 缺省 → fail-closed 空返回(绝不降级广播)
  const noCtx = evaluateRecallTriggers(POOL, { now: NOW, signals: [SIGNAL_HOLIDAY] } as unknown as RecallContext)
  ok(noCtx.length === 0, `§6c 缺 match_context → 0 触发(实测 ${noCtx.length};fail-closed 不广播)`)

  // §6d match_context 畸形(JSON 往返产物:数字变字符串 / Set 变数组 / NaN)→ fail-closed
  const strDays = evaluateRecallTriggers(POOL, { now: NOW, signals: [SIGNAL_HOLIDAY], match_context: { days: '7', budgetCny: 6000 } as unknown as RecallContext['match_context'] })
  ok(strDays.length === 0, `§6d1 days='7' 字符串 → 0 触发(实测 ${strDays.length};畸形上下文 fail-closed)`)
  const arrDown = evaluateRecallTriggers(POOL, { now: NOW, signals: [SIGNAL_HOLIDAY], match_context: { days: 7, channelDown: ['hbcli-hotel'] } as unknown as RecallContext['match_context'] })
  ok(arrDown.length === 0, `§6d2 channelDown 是数组非 Set → 0 触发(实测 ${arrDown.length})`)
  const nanDays = evaluateRecallTriggers(POOL, { now: NOW, signals: [SIGNAL_HOLIDAY], match_context: { days: Number.NaN } })
  ok(nanDays.length === 0, `§6d3 days=NaN → 0 触发(实测 ${nanDays.length})`)

  // §6e match_context 形状合法但全空({})→ 零证据零触发(不把空窗口当广播授权)
  const emptyCtx = evaluateRecallTriggers(POOL, { now: NOW, signals: [SIGNAL_HOLIDAY], match_context: {} })
  ok(emptyCtx.length === 0, `§6e 空 match_context({})→ 0 触发(实测 ${emptyCtx.length};零证据不硬推)`)

  // §6f 定向信号不能绕过条件门:指定 id 无条件命中 → 0;混合 id → 只达命中的那个
  const bypass = evaluateRecallTriggers([POOL_R[0]], { now: NOW, signals: [{ ...SIGNAL_PRICE, wish_ids: ['w-far'] }], match_context: MATCH_CTX })
  ok(bypass.length === 0, `§6f1 定向信号指向条件不命中的候选 → 0 触发(实测 ${bypass.length};定向不扩权)`)
  const mixed = evaluateRecallTriggers(POOL_R, { now: NOW, signals: [{ ...SIGNAL_PRICE, wish_ids: ['w-onehit', 'w-far'] }], match_context: MATCH_CTX })
  ok(idsOf(mixed) === 'w-onehit', `§6f2 定向混合 id → 只达条件命中的(实测 ${idsOf(mixed)})`)

  // §6g 命名 down 通道否证:days 命中但依赖通道 down → 否证(定向/广播都不得触发);
  //     通道健康或 down 的是别的通道 → 照常触发(scoreWishMatch 原语义)
  const vetoPool = [POOL_R[3]]
  const preVeto = evaluateRecallTriggers(vetoPool, { now: NOW, signals: [SIGNAL_HOLIDAY], match_context: MATCH_CTX })
  ok(preVeto.length === 1, `§6g0 无否证信息时 days 命中 → 有资格(实测 ${preVeto.length})`)
  const vetoCtx = { ...MATCH_CTX, channelDown: new Set(['hbcli-hotel']) }
  const vetoed = evaluateRecallTriggers(vetoPool, { now: NOW, signals: [SIGNAL_HOLIDAY], match_context: vetoCtx })
  ok(vetoed.length === 0, `§6g1 依赖通道 down → 广播否证(实测 ${vetoed.length})`)
  const vetoTargeted = evaluateRecallTriggers(vetoPool, { now: NOW, signals: [{ ...SIGNAL_PRICE, wish_ids: ['w-veto'] }], match_context: vetoCtx })
  ok(vetoTargeted.length === 0, `§6g2 依赖通道 down → 定向同样否证(实测 ${vetoTargeted.length};定向不绕过否证)`)
  const otherDown = evaluateRecallTriggers(vetoPool, { now: NOW, signals: [SIGNAL_HOLIDAY], match_context: { ...MATCH_CTX, channelDown: new Set(['other-channel']) } })
  ok(otherDown.length === 1, `§6g3 down 的是无关通道 → 不误杀(实测 ${otherDown.length})`)

  // §6h 一项命中即有资格(既有语义):仅 days 命中 / 仅 month 命中,且触发携带逐项命中
  const one = evaluateRecallTriggers(POOL_R, { now: NOW, signals: [SIGNAL_HOLIDAY], match_context: MATCH_CTX })
  const onehit = one.find(t => t.wish_id === 'w-onehit')
  const monthhit = one.find(t => t.wish_id === 'w-months')
  ok(onehit !== undefined && Array.isArray(onehit.match_hits) && onehit.match_hits.join('+') === 'days≥3',
    `§6h1 仅 days 命中即有资格,match_hits=[days≥3](实测 ${String(onehit?.match_hits)})`)
  ok(monthhit !== undefined && Array.isArray(monthhit.match_hits) && monthhit.match_hits.join('+') === 'month=10',
    `§6h2 仅 month 命中即有资格,match_hits=[month=10](实测 ${String(monthhit?.match_hits)})`)

  // §6i 畸形 conditions/条目不崩,资格由 scoreWishMatch 原语义判定:
  //     conditions 为字符串/数字 → 无命中;best_months 为字符串 → 忽略但 days 照常命中;null 条目被滤
  const POOL_MAL = [
    { wish_id: 'w-cond-str', name: 'conditions 是字符串', conditions: '5天', added_at: '2026-09-06T00:00:00Z' },
    { wish_id: 'w-cond-num', name: 'conditions 是数字', conditions: 42, added_at: '2026-09-07T00:00:00Z' },
    { wish_id: 'w-months-str', name: 'best_months 是字符串', conditions: { days: 1, best_months: '10,11' }, added_at: '2026-09-08T00:00:00Z' },
    null,
  ] as unknown as typeof POOL
  let malThrew = false
  let mal: ReturnType<typeof evaluateRecallTriggers> = []
  try {
    mal = evaluateRecallTriggers(POOL_MAL, { now: NOW, signals: [SIGNAL_HOLIDAY], match_context: MATCH_CTX })
  } catch { malThrew = true }
  ok(!malThrew, '§6i1 畸形 conditions/条目 → 不抛不崩')
  ok(mal.length === 1 && mal[0]?.wish_id === 'w-months-str',
    `§6i2 畸形形状按原评分语义判定(实测 ${mal.map(t => t.wish_id).join(',')};字符串/数字 conditions 无命中,字符串 best_months 忽略)`)

  // §6j 全 5 类原因在有效条件下可达,且每个触发都带非空逐项命中
  const allR = evaluateRecallTriggers(POOL, { now: NOW, signals: [SIGNAL_HOLIDAY, SIGNAL_PRICE, SIGNAL_WEATHER, SIGNAL_ROUTE, SIGNAL_RECOVERED], match_context: MATCH_CTX })
  const allReasons = new Set(allR.map(t => t.signal.reason))
  ok(allReasons.size === 5 && RECALL_REASONS.every(r => allReasons.has(r)),
    `§6j1 有效条件下 5 类原因全部可达(实测 ${allReasons.size} 类)`)
  ok(allR.every(t => Array.isArray(t.match_hits) && t.match_hits.length > 0),
    `§6j2 每个触发都携带非空 match_hits(实测 ${allR.filter(t => !Array.isArray(t.match_hits) || t.match_hits.length === 0).length} 个缺命中)`)
}

// ===========================================================================
// §7 命中证据贯穿(#577 收口):触发 → 卡 → 渲染边界——
//   卡只陈述实际命中的愿望条件,渲染面显式声明「非全部出行条件已满足」;
//   手工构造的卡不发明证据。
// ===========================================================================

{
  // §7a 集成:真命中证据进卡与渲染(证据逐项 = scoreWishMatch 的 hits 原文)
  const result = evaluatePoolRecall({ pool: POOL, tick: TICK, signals: [SIGNAL_PRICE], match_context: MATCH_CTX })
  const priceCard = result.cards[0]
  ok(priceCard !== undefined && Array.isArray(priceCard.match_evidence) && priceCard.match_evidence.join('+') === 'days≥5+budget≥5000',
    `§7a 卡携带真命中证据(实测 ${String(priceCard?.match_evidence)})`)
  const evidenceLine = renderWhyNowCardLine(priceCard)
  ok(evidenceLine.includes('命中条件:days≥5+budget≥5000'), `§7b 渲染行陈述命中条件(实测含「${evidenceLine.slice(0, 80)}…」)`)
  ok(evidenceLine.includes('非全部出行条件已满足'), '§7c 渲染行显式声明不主张全部出行条件已满足')
  ok(evidenceLine.includes('证据边界'), '§7c2 渲染行保留证据边界标记(渲染契约不变)')

  // §7d 缺 match_context → 集成层同样 fail-closed(0 触发 0 卡)
  const noCtx = evaluatePoolRecall({ pool: POOL, tick: TICK, signals: [SIGNAL_HOLIDAY] } as unknown as Parameters<typeof evaluatePoolRecall>[0])
  ok(noCtx.triggers.length === 0 && noCtx.cards.length === 0, `§7d 集成缺 match_context → 空(实测 ${noCtx.triggers.length}/${noCtx.cards.length})`)

  // §7e 手工构造的卡不发明证据:match_hits 缺省/空数组/畸形 → 卡无证据、渲染无命中子句
  const manual = buildWhyNowCard({ wish_id: 'w-x', wish_name: '手工卡', signal: SIGNAL_PRICE, evaluated_at: NOW.toISOString() } as unknown as RecallTrigger)
  ok(manual.match_evidence === undefined, `§7e1 手工卡无 match_hits → 卡无证据(实测 ${String(manual.match_evidence)})`)
  const emptyHits = buildWhyNowCard({ wish_id: 'w-x', wish_name: '手工卡', signal: SIGNAL_PRICE, match_hits: [], evaluated_at: NOW.toISOString() })
  ok(emptyHits.match_evidence === undefined, `§7e2 match_hits=[] → 卡无证据(空数组不发明;实测 ${String(emptyHits.match_evidence)})`)
  let garbledThrew = false
  let garbled: WhyNowCard | null = null
  try {
    garbled = buildWhyNowCard({ wish_id: 'w-x', wish_name: '手工卡', signal: SIGNAL_PRICE, match_hits: 'days≥5' as unknown as string[], evaluated_at: NOW.toISOString() } as unknown as RecallTrigger)
  } catch { garbledThrew = true }
  ok(!garbledThrew && garbled !== null && garbled.match_evidence === undefined,
    `§7e3 畸形 match_hits → 不崩且不发明证据(实测 ${String(garbled?.match_evidence)})`)
  ok(!renderWhyNowCardLine(manual).includes('命中条件'), '§7f 无证据卡的渲染不出现命中条件子句')

  // §7g scheduler 端到端:真命中证据贯穿 evaluate → toCard → sink
  const evidenceSink = new ArrayRecallSink()
  const evidenceScheduler = new RecallTickScheduler<{ wish_id: string; wish_name: string; signal: RecallSignal; match_hits: string[] }, WhyNowCard>({
    evaluate: (tick) => evaluatePoolRecall({ pool: POOL, tick, signals: [SIGNAL_PRICE], match_context: MATCH_CTX }).triggers,
    toCard: (evaluation, tick) => buildWhyNowCard({ ...evaluation, evaluated_at: tick.at.toISOString() }),
    sink: evidenceSink,
  })
  await evidenceScheduler.run(TICK)
  const evidenceCard = evidenceSink.items[0] as WhyNowCard
  ok(Array.isArray(evidenceCard?.match_evidence) && evidenceCard.match_evidence.join('+') === 'days≥5+budget≥5000',
    `§7g scheduler 端到端:卡证据 = 真命中(实测 ${String(evidenceCard?.match_evidence)})`)
}

console.log(`\nRECALL TESTS: ${pass} pass, ${fail} fail`)
if (fail > 0) {
  console.log('\nFAILURES:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}