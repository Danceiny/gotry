/**
 * Recall contract 验收套件(issue #577,Phase D):
 * tick source(InMemory + PeriodicTickSource opt-in 纪律)
 * + evaluator(5 类 RecallReason 闭集 + 广播/定向匹配)
 * + why-now card(source tag 必现 + 行动建议)
 * + integration(wish-pool 只读编排)
 * + RecallTickScheduler 端到端(tick → 评估 → 卡 → sink)。
 *
 * 全离线合成数据,无网络、无 IO、无 stateRoot 写、不启动 setInterval。
 *
 * 运行(在 ts/ 下):npx tsx scripts/recall-tests.ts
 */

import {
  ArrayRecallSink,
  InMemoryTickSource,
  PeriodicTickSource,
  RecallTickScheduler,
  type RecallTick,
} from '../src/recall/tick.ts'
import {
  RECALL_REASON_LABEL,
  RECALL_REASONS,
  evaluateRecallTriggers,
  type RecallContext,
  type RecallSignal,
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
  { wish_id: 'w-muted', name: '静音的愿望', muted: true, added_at: '2026-06-01T00:00:00Z' },
  { wish_id: '', name: '无 id 的愿望(不召回)', added_at: '2026-06-01T00:00:00Z' },
]

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
  ok(periodic.start() === false, '§1d enabled=false 时 start() 不启动 setInterval(返回 false)')
  const noTick = await periodic.next()
  ok(noTick === null, '§1e 未启动时 next() 返回 null(无 tick 产生)')
  periodic.stop() // 幂等停止

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
  const empty = evaluateRecallTriggers(POOL, { now: NOW, signals: [] })
  ok(empty.length === 0, '§2c 无信号 → 空触发(不硬推)')

  // 广播信号(holiday_proximity 无 wish_ids)→ 匹配全部未 muted 且有 id 的候选
  const broadcast = evaluateRecallTriggers(POOL, { now: NOW, signals: [SIGNAL_HOLIDAY] })
  ok(broadcast.length === 2, `§2d 广播信号命中 2 个有效候选(实测 ${broadcast.length};muted + 无 id 被滤)`)
  ok(broadcast.every(t => t.wish_id === 'w-dali-erhai' || t.wish_id === 'w-qiandao'),
    '§2e 广播信号命中的 id 都是有效候选(muted/无 id 不出现)')
  ok(broadcast.every(t => t.signal.reason === 'holiday_proximity'), '§2f 触发携带原信号 reason')
  ok(broadcast.every(t => t.evaluated_at === NOW.toISOString()), '§2g 触发携带评估时刻(ISO)')

  // 定向信号(price_drop 带 wish_ids)→ 只命中指定 id
  const targeted = evaluateRecallTriggers(POOL, { now: NOW, signals: [SIGNAL_PRICE] })
  ok(targeted.length === 1 && targeted[0].wish_id === 'w-dali-erhai',
    '§2h 定向信号只命中指定 wish_id(其它候选不出现)')

  // 多信号 → 每个信号独立触发(一个 wish 可命中多个信号)
  const multi = evaluateRecallTriggers(POOL, { now: NOW, signals: [SIGNAL_PRICE, SIGNAL_WEATHER] })
  ok(multi.length === 2, `§2i 两个定向信号(同 wish)→ 2 个触发(实测 ${multi.length})`)
  ok(multi.every(t => t.wish_id === 'w-dali-erhai'), '§2j 同 wish 多信号 → 各自独立触发')
  ok(multi[0].signal.reason !== multi[1].signal.reason, '§2k 触发按信号顺序(reason 不同)')

  // 全 5 类信号可达
  const allSignals: RecallSignal[] = [SIGNAL_HOLIDAY, SIGNAL_PRICE, SIGNAL_WEATHER, SIGNAL_ROUTE, SIGNAL_RECOVERED]
  const allFired = evaluateRecallTriggers(POOL, { now: NOW, signals: allSignals })
  const firedReasons = new Set(allFired.map(t => t.signal.reason))
  ok(firedReasons.size === 5 && RECALL_REASONS.every(r => firedReasons.has(r)),
    `§2l 5 类 RecallReason 全部可达(实际触发 ${firedReasons.size} 类)`)

  // 畸形信号(reason 不在闭集 / source 空 / 字段缺失)→ 静默跳过(不崩、不产触发)
  const badSignals = [
    { reason: 'not_a_reason', source: 'x', current_value: 'y', threshold: 'z' },
    { reason: 'price_drop', source: '', current_value: 'y', threshold: 'z' },
    { reason: 'price_drop', source: 'x' },
    null,
    'not-an-object',
  ] as unknown as RecallSignal[]
  const badResult = evaluateRecallTriggers(POOL, { now: NOW, signals: badSignals })
  ok(badResult.length === 0, `§2m 畸形信号全部跳过(实测产 ${badResult.length} 触发;不崩不产)`)

  // 空 pool → 任何信号都空
  const emptyPool = evaluateRecallTriggers([], { now: NOW, signals: [SIGNAL_HOLIDAY] })
  ok(emptyPool.length === 0, '§2n 空 pool → 空触发')
}

// ===========================================================================
// §3 why-now card — source tag 必现 + 行动建议 + 标题封闭词汇
// ===========================================================================

{
  const [trigger] = evaluateRecallTriggers(POOL, { now: NOW, signals: [SIGNAL_PRICE] })
  ok(trigger !== undefined, '§3a 前置:定向触发存在')
  const card = buildWhyNowCard(trigger!)

  ok(card.title === '现在可以去了:大理 · 洱海恢复之旅', `§3b 标题封闭词汇(实测「${card.title}」)`)
  ok(card.reason === 'price_drop' && card.reason_label === '价格降至阈值', '§3c reason + 中文标签')
  ok(card.current_value === 'SZX→HKT ¥890' && card.threshold === '≤¥1000', '§3d 当前值 + 阈值保持')
  ok(typeof card.action_hint === 'string' && card.action_hint.length > 0, `§3e 行动建议非空(${card.action_hint})`)
  ok(card.source_tag === '[source:price-monitor]', `§3f source tag 必现(实测 ${card.source_tag})`)
  ok(card.evaluated_at === NOW.toISOString(), '§3g evaluated_at 保持')
  ok(card.evidence_boundary === true, '§3h evidence_boundary 恒 true')

  // 5 类行动建议全部非空
  const allCards = [SIGNAL_HOLIDAY, SIGNAL_PRICE, SIGNAL_WEATHER, SIGNAL_ROUTE, SIGNAL_RECOVERED].map(s =>
    buildWhyNowCard(evaluateRecallTriggers(POOL, { now: NOW, signals: [s] })[0] ?? {
      wish_id: 'x', wish_name: 'x', signal: s, evaluated_at: NOW.toISOString(),
    }))
  ok(allCards.every(c => c.action_hint.length > 5), '§3i 5 类 reason 的行动建议全部非空')

  // 单行渲染含 source tag
  const line = renderWhyNowCardLine(card)
  ok(line.includes(card.title) && line.includes(card.reason_label) && line.includes(card.source_tag),
    `§3j 单行渲染含标题/原因/source tag(${line.slice(0, 60)}...)`)
  ok(line.includes('当前:') && line.includes('阈值:'), '§3k 单行渲染含当前值/阈值')
}

// ===========================================================================
// §4 integration — wish-pool 只读编排(tick + signals → triggers + cards)
// ===========================================================================

{
  const result = evaluatePoolRecall({
    pool: POOL,
    tick: TICK,
    signals: [SIGNAL_HOLIDAY, SIGNAL_PRICE],
  })
  ok(result.triggers.length === 3, `§4a 触发数 = 广播(2)+ 定向(1)= 3(实测 ${result.triggers.length})`)
  ok(result.cards.length === result.triggers.length, '§4b 卡数与触发数一致(一卡一触发)')
  ok(result.cards.every(c => c.source_tag.startsWith('[source:')), '§4c 每张卡都带 source tag')

  // 无信号 → 全空
  const emptyResult = evaluatePoolRecall({ pool: POOL, tick: TICK, signals: [] })
  ok(emptyResult.triggers.length === 0 && emptyResult.cards.length === 0, '§4d 无信号 → 空(不硬推)')
}

// ===========================================================================
// §5 RecallTickScheduler 端到端 — tick → 评估 → 卡 → sink
// ===========================================================================

{
  const sink = new ArrayRecallSink()
  const scheduler = new RecallTickScheduler<{ wish_id: string; signal: RecallSignal }, WhyNowCard>({
    evaluate: (tick) => tick.source === 'test-tick'
      ? evaluatePoolRecall({ pool: POOL, tick, signals: [SIGNAL_PRICE] }).triggers
        .map(t => ({ wish_id: t.wish_id, signal: t.signal }))
      : [], // 非 test-tick 的 tick 无信号(§5e 用)
    toCard: (evaluation) => buildWhyNowCard({
      wish_id: evaluation.wish_id,
      wish_name: POOL.find(p => p.wish_id === evaluation.wish_id)?.name ?? evaluation.wish_id,
      signal: evaluation.signal,
      evaluated_at: NOW.toISOString(),
    }),
    sink,
  })

  const count = await scheduler.run(TICK)
  ok(count === 1, `§5a 一个 tick + 一个定向信号 → 1 张卡(实测 ${count})`)
  ok(sink.items.length === 1, '§5b sink 收到 1 张卡')
  const delivered = sink.items[0] as WhyNowCard
  ok(delivered.source_tag === '[source:price-monitor]', '§5c 卡片 source tag 正确')
  ok(delivered.title.includes('大理'), `§5d 卡片标题含 wish name(${delivered.title})`)

  // 第二个 tick + 无信号 → 0 卡
  const count2 = await scheduler.run({ at: new Date(NOW.getTime() + 3600_000), source: 't2' })
  ok(count2 === 0 && sink.items.length === 1, '§5e 第二 tick 无信号 → 0 新卡(sink 不变)')

  // InMemoryTickSource 驱动多 tick 端到端
  const multiSink = new ArrayRecallSink()
  const multiScheduler = new RecallTickScheduler<{ wish_id: string; signal: RecallSignal }, WhyNowCard>({
    evaluate: evaluatePoolRecallShim,
    toCard: toCardShim,
    sink: multiSink,
  })
  const src = new InMemoryTickSource([TICK, { at: new Date(NOW.getTime() + 60_000), source: 't2' }])
  let total = 0
  for (let t = await src.next(); t !== null; t = await src.next()) {
    total += await multiScheduler.run(t)
  }
  ok(total === 2 && multiSink.items.length === 2, `§5f InMemory 多 tick 端到端:2 tick × 1 信号 → 2 卡(实测 ${total}/${multiSink.items.length})`)

  function evaluatePoolRecallShim(tick: RecallTick): { wish_id: string; signal: RecallSignal }[] {
    return evaluatePoolRecall({ pool: POOL, tick, signals: [SIGNAL_PRICE] }).triggers
      .map(t => ({ wish_id: t.wish_id, signal: t.signal }))
  }
  function toCardShim(evaluation: { wish_id: string; signal: RecallSignal }): WhyNowCard {
    return buildWhyNowCard({
      wish_id: evaluation.wish_id,
      wish_name: POOL.find(p => p.wish_id === evaluation.wish_id)?.name ?? evaluation.wish_id,
      signal: evaluation.signal,
      evaluated_at: NOW.toISOString(),
    })
  }
}

console.log(`\nRECALL TESTS: ${pass} pass, ${fail} fail`)
if (fail > 0) {
  console.log('\nFAILURES:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}