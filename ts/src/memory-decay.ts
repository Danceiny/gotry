/**
 * 时间窗衰减原语(memory-design P3):行为偏好的新鲜度置信度——
 * 30/90/180/365d 分级窗口,确定性纯函数;**只降不删**(历史事件永远在,
 * 衰减只作用于读时置信度);地板 0.1(记忆永不因旧而消失)。
 *
 * 边界(memory-design §4 P3):衰减只作用于**行为事件**(效用 sidecar 等);
 * 动机权重层零衰减——动机跨年稳定是产品设计 §4 的明文(个性化的锚点),
 * 本模块不提供任何作用于 motivation-profile 的 API(构造性保证)。
 *
 * 未来消费方(行为偏好层落地时):同原语直接复用,窗口即配置。
 */

export type DecayWindow = '30d' | '90d' | '180d' | '365d' | 'stale'

/** 分级窗口:age(天)→ 因子;单调不增,地板 0.1(只降不删) */
export function windowFactor(ageDays: number): number {
  if (ageDays <= 30) return 1.0
  if (ageDays <= 90) return 0.75
  if (ageDays <= 180) return 0.5
  if (ageDays <= 365) return 0.25
  return 0.1
}

/** 事件种类权重:verified_outcome 最强,recalled 最弱(自称被召回 ≠ 有用) */
export const KIND_WEIGHT = { recalled: 0.25, applied: 0.5, verified_outcome: 1.0 } as const

export interface DecayableEvent {
  ts: string
  kind: keyof typeof KIND_WEIGHT
}

export function ageDaysOf(ts: string, now: Date): number {
  const then = new Date(ts).getTime()
  if (Number.isNaN(then)) return Number.POSITIVE_INFINITY
  return Math.max(0, (now.getTime() - then) / 86_400_000)
}

/** 单事件衰减分:KIND_WEIGHT × windowFactor;未知时间戳按地板(不猜) */
export function eventDecayScore(ev: DecayableEvent, now: Date): number {
  const w = KIND_WEIGHT[ev.kind] ?? 0
  return round4(w * windowFactor(ageDaysOf(ev.ts, now)))
}

/**
 * 单条记忆的新鲜置信度 ∈ [0,1]:Σ 事件衰减分,上界 1。
 * 同 wish 同窗口内事件越多置信越高(有界);旧事件只做地板贡献。
 */
export function decayedConfidence(events: DecayableEvent[], now: Date): number {
  const sum = events.reduce((acc, ev) => acc + eventDecayScore(ev, now), 0)
  return round4(Math.min(1, sum))
}

function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000
}
