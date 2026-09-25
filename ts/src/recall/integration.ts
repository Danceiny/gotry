/**
 * Recall wish-pool integration(issue #577,Phase D)。
 *
 * 把 wish-pool 候选条目接到 evaluator:从 tick + signals 组装上下文 → 跑评估 →
 * 产触发列表 + why-now 卡。**只读 wish-pool**(不调用 mutation;撤回/通知留 M4)。
 *
 * 本模块不接 IO——数据进出全靠参数(测试全离线;M4 由真实 tick source + sensor 喂数据)。
 */

import type { WishMatchContext, WishPoolEntry } from '../wish-pool.ts'
import { evaluateRecallTriggers, type RecallContext, type RecallSignal, type RecallTrigger } from './evaluator.ts'
import { buildWhyNowCard, type WhyNowCard } from './card.ts'
import type { RecallTick } from './tick.ts'

export interface PoolRecallInput {
  pool: WishPoolEntry[]
  tick: RecallTick
  signals: RecallSignal[]
  /** 召回窗口事实(days/budgetCny/month/channelDown;原样传给 evaluateRecallTriggers
   *  → scoreWishMatch 条件资格门)。缺省/畸形 → 评估整轮 fail-closed(空返回)。 */
  match_context: WishMatchContext
}

export interface PoolRecallResult {
  triggers: RecallTrigger[]
  cards: WhyNowCard[]
}

/** 从 wish-pool + tick + signals + 召回窗口跑一轮评估并产卡(纯函数编排) */
export function evaluatePoolRecall(input: PoolRecallInput): PoolRecallResult {
  const ctx: RecallContext = { now: input.tick.at, signals: input.signals, match_context: input.match_context }
  const triggers = evaluateRecallTriggers(input.pool, ctx)
  const cards = triggers.map(buildWhyNowCard)
  return { triggers, cards }
}