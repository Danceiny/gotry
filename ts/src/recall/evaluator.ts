/**
 * Recall condition evaluator(issue #577,Phase D;研究决策 §3 Phase D;
 * 自检 review 修复见 PR #578 评论——两轮:广播升级/容器与时钟守卫/单表派生)。
 *
 * 纯函数:给定 wish-pool 候选条目 + 当前上下文(时间 + 各类简化信号),
 * 产出一组 RecallTrigger——每个含「为什么是现在」的具体原因(条件名 + 当前值 + 阈值)
 * 与 source tag(**proactive with provenance**——研究文档红线)。
 *
 * 纪律:
 *   - 原因闭集 5 类,**单表派生**(RECALL_REASON_LABEL 为唯一事实源;union / 数组 /
 *     label 全部从它推导——新增原因 = 改一张表,编译器强制 card.ts 的 hint 表补全);
 *   - 畸形输入(信号/容器/时钟)**跳过或空返回,不崩**——评估器是消费链一环,
 *     一个坏 tick 不能杀掉调用方的 drain loop;
 *   - wish_ids 非数组(如字符串)= 畸形信号,**跳过**(绝不降级为广播匹配——
 *     广播是最激进模式,降级等于扩权);
 *   - muted 过滤用 `muted === true` 严格判定(JSON 往返的 'false' 字符串不再误杀)。
 */

import type { WishPoolEntry } from '../wish-pool.ts'

/** 唯一事实源:5 类原因 → 中文标签。新增原因 = 在此表加一行(union/数组自动派生;
 *  card.ts 的 ACTION_HINT 表由 Record<RecallReason,...> 编译强制补全)。 */
export const RECALL_REASON_LABEL = {
  holiday_proximity: '假期临近',
  price_drop: '价格降至阈值',
  weather_window: '天气窗口打开',
  route_new: '新航线/班次开通',
  availability_recovered: '通道恢复可用',
} as const

export type RecallReason = keyof typeof RECALL_REASON_LABEL

/** 闭集数组从 label 表派生(单一事实源;不再手抄第二份) */
export const RECALL_REASONS: readonly RecallReason[] = Object.keys(RECALL_REASON_LABEL) as RecallReason[]

/** 单条触发信号(外部世界的一次状态变化;由 M4 的 sensor/tick 填充) */
export interface RecallSignal {
  reason: RecallReason
  /** 源 tag(必填非空;渲染为 `[source:xxx]`) */
  source: string
  /** 当前值(人话,如「2026-10-01(距今 7 天)」) */
  current_value: string
  /** 阈值描述(人话,如「距假期 ≤14 天」) */
  threshold: string
  /** 受影响的 wish_id 列表(空/缺省 = 广播;**非数组 = 畸形,整条跳过**) */
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

/**
 * 评估:候选 × 信号 → 触发列表。
 * 匹配规则:signal.wish_ids 是非空字符串数组时按 id 精确匹配(定向);
 * 为空/缺省时匹配全部有效候选(广播)。**wish_ids 为其它真值类型(字符串/对象等)
 * 视为畸形信号,整条跳过**——绝不降级为广播。
 * 容器/时钟守卫:signals/pool 非数组或 ctx.now 非法 → 返回 [](不抛,不崩 drain loop)。
 */
export function evaluateRecallTriggers(pool: WishPoolEntry[], ctx: RecallContext): RecallTrigger[] {
  // 容器与时钟守卫:一个坏 tick 不能杀掉调用方(fail-closed 空返回)
  if (!Array.isArray(pool) || !Array.isArray(ctx?.signals)) return []
  const nowMs = ctx.now instanceof Date ? ctx.now.getTime() : Number.NaN
  if (!Number.isFinite(nowMs)) return []
  const evaluatedAt = new Date(nowMs).toISOString()

  // 候选:muted 严格 true 才排除('false' 字符串/0 等 JSON 往返产物不再误杀);
  // 无稳定非空 wish_id 不召回(与 pickNudgeWish 同纪律)
  const candidates = pool.filter(e => e?.muted !== true && typeof e?.wish_id === 'string' && e.wish_id.length > 0)

  const triggers: RecallTrigger[] = []
  for (const signal of ctx.signals) {
    if (!isRecallSignal(signal)) continue
    const targets = Array.isArray(signal.wish_ids) && signal.wish_ids.length > 0
      ? candidates.filter(e => (signal.wish_ids as string[]).includes(e.wish_id as string))
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

/** 信号校验(边界强制,不从输入信任):reason 在闭集 + source 非空字符串 +
 *  current_value/threshold 为字符串 + **wish_ids 一旦给出必须是字符串数组**
 * (字符串等真值非数组 = 畸形,拒绝——绝不降级广播)。 */
function isRecallSignal(value: unknown): value is RecallSignal {
  if (typeof value !== 'object' || value === null) return false
  const s = value as Record<string, unknown>
  if (!RECALL_REASONS.includes(s.reason as RecallReason)) return false
  if (typeof s.source !== 'string' || s.source.length === 0) return false
  if (typeof s.current_value !== 'string' || typeof s.threshold !== 'string') return false
  if (s.wish_ids !== undefined && s.wish_ids !== null) {
    if (!Array.isArray(s.wish_ids) || !s.wish_ids.every(id => typeof id === 'string')) return false
  }
  return true
}