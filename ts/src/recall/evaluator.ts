/**
 * Recall condition evaluator(issue #577,Phase D;研究决策 §3 Phase D)。
 *
 * 纯函数:给定 wish-pool 候选条目 + 当前上下文(时间 + 各类简化信号),
 * 产出一组 RecallTrigger——每个含「为什么是现在」的具体原因(条件名 + 当前值 + 阈值)
 * 与 source tag(**proactive with provenance**——研究文档红线:每条主动推送必须带
 * 触发原因 + 源 tag,否则宁可不推)。
 *
 * 与 wish-pool 的关系:本模块**只读**候选(`WishPoolEntry` 形状),不调用
 * wish-pool mutation;触发后的「撤回/通知」留给 M4。
 *
 * 条件闭集(5 类;新增须 review + 改本注释):
 *   holiday_proximity       — 假期/长周末临近(阈值:距假期 ≤N 天)
 *   price_drop              — 价格降至阈值(阈值:当前价 ≤ 目标价)
 *   weather_window          — 天气窗口打开(阈值:预报连续 N 天适旅)
 *   route_new               — 新航线/新班次开通(阈值:存在覆盖目标日期的班次)
 *   availability_recovered  — 库存恢复(阈值:此前 down 的通道恢复 ok)
 */

import type { WishPoolEntry } from '../wish-pool.ts'

export type RecallReason =
  | 'holiday_proximity'
  | 'price_drop'
  | 'weather_window'
  | 'route_new'
  | 'availability_recovered'

export const RECALL_REASONS: readonly RecallReason[] = [
  'holiday_proximity',
  'price_drop',
  'weather_window',
  'route_new',
  'availability_recovered',
] as const

export const RECALL_REASON_LABEL: Record<RecallReason, string> = {
  holiday_proximity: '假期临近',
  price_drop: '价格降至阈值',
  weather_window: '天气窗口打开',
  route_new: '新航线/班次开通',
  availability_recovered: '通道恢复可用',
}

/** 单条触发信号(外部世界的一次状态变化;由 M4 的 sensor/tick 填充) */
export interface RecallSignal {
  reason: RecallReason
  /** 源 tag(必填;渲染为 `[source:xxx]`) */
  source: string
  /** 当前值(人话,如「2026-10-01(距今 7 天)」) */
  current_value: string
  /** 阈值描述(人话,如「距假期 ≤14 天」) */
  threshold: string
  /** 受影响的 wish_id 列表(空 = 广播信号,由 evaluator 匹配) */
  wish_ids?: string[]
}

/** 评估上下文(tick 到来时由调用方组装;纯数据) */
export interface RecallContext {
  now: Date
  signals: RecallSignal[]
}

/** 触发结果:wish × signal 的配对(一个 wish 可命中多个信号,一卡一信号) */
export interface RecallTrigger {
  wish_id: string
  wish_name: string
  signal: RecallSignal
  /** 评估时刻(ISO) */
  evaluated_at: string
}

/** 候选条目的宽松形状(与 WishPoolEntry 兼容;测试可传字面量) */
type PoolCandidate = WishPoolEntry | { wish_id?: unknown; name?: unknown; muted?: unknown }

/**
 * 评估:候选 × 信号 → 触发列表。
 * 匹配规则:signal.wish_ids 非空时按 id 精确匹配;为空时匹配全部未 muted 且有
 * 稳定 wish_id 的候选(广播信号)。无信号或无候选 → 空数组(不硬推)。
 */
export function evaluateRecallTriggers(pool: PoolCandidate[], ctx: RecallContext): RecallTrigger[] {
  const candidates = pool.filter(e => !e.muted && typeof e.wish_id === 'string' && (e.wish_id as string).length > 0)
  const triggers: RecallTrigger[] = []
  const evaluatedAt = ctx.now.toISOString()
  for (const signal of ctx.signals) {
    if (!isRecallSignal(signal)) continue
    const targets = Array.isArray(signal.wish_ids) && signal.wish_ids.length > 0
      ? candidates.filter(e => signal.wish_ids!.includes(e.wish_id as string))
      : candidates
    for (const entry of targets) {
      triggers.push({
        wish_id: String(entry.wish_id),
        wish_name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : String(entry.wish_id),
        signal,
        evaluated_at: evaluatedAt,
      })
    }
  }
  return triggers
}

function isRecallSignal(value: unknown): value is RecallSignal {
  if (typeof value !== 'object' || value === null) return false
  const s = value as Record<string, unknown>
  return RECALL_REASONS.includes(s.reason as RecallReason)
    && typeof s.source === 'string' && s.source.length > 0
    && typeof s.current_value === 'string'
    && typeof s.threshold === 'string'
}