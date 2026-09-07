/**
 * 愿望池匹配纯函数(M4「下一次出发」召回的判定层):条件评分 + 0..1 挑选。
 * 判定归代码(契约 4),模型与脚本都只消费结果。
 *
 * 纪律:0..1(一轮至多一条建议)/muted 永不召回/无命中返回 null(不硬推);
 * tie-break 用 added_at 最早优先(先许的愿先兑现),同刻则 wish_id 字典序——确定性,可重放。
 */

export interface WishPoolEntry {
  wish_id?: string | unknown
  name?: string | unknown
  reason?: string | unknown
  conditions?: { days?: number; budget_cny?: number; best_months?: number[]; channels?: string[] } | unknown
  muted?: boolean | unknown
  added_at?: string | unknown
}

/** 召回窗口上下文:用户当前可支配的天数/预算 + 目标月份;
 *  channelDown(外部事件接缝第 2 段,seam 设计 §3.3/§6②)=当前处于 down 的通道名
 *  集合(来自 channel-health.jsonl 持久面;缺省=不启用通道否证,旧调用方零影响)。 */
export interface WishMatchContext {
  days?: number
  budgetCny?: number
  month?: number
  channelDown?: ReadonlySet<string>
}

export interface WishMatch {
  entry: WishPoolEntry
  wishId: string
  score: number
  /** 逐项命中明细(days/budget/month),渲染「为什么是它」用 */
  hits: string[]
}

/**
 * 条件评分:days/budget 为「窗口 ≥ 条件」,month 为「命中 best_months」;条件缺失的项不计分。
 * 通道否证(接缝第 2 段):conditions.channels 命名依赖通道,任一处于 down 且
 * ctx.channelDown 已提供 → 否证成行条件,返回 null(当下推这个愿望=体验差);
 * 通道全健康或健康面缺席(未传 channelDown)不加分不否——「佐证」渲染面留后续切片。
 */
export function scoreWishMatch(entry: WishPoolEntry, ctx: WishMatchContext): WishMatch | null {
  const c = (entry.conditions ?? {}) as { days?: number; budget_cny?: number; best_months?: number[]; channels?: string[] }
  if (ctx.channelDown && Array.isArray(c.channels)) {
    for (const ch of c.channels) {
      if (typeof ch === 'string' && ctx.channelDown.has(ch)) return null
    }
  }
  const hits: string[] = []
  if (typeof ctx.days === 'number' && typeof c.days === 'number' && ctx.days >= c.days) hits.push(`days≥${c.days}`)
  if (typeof ctx.budgetCny === 'number' && typeof c.budget_cny === 'number' && ctx.budgetCny >= c.budget_cny) hits.push(`budget≥${c.budget_cny}`)
  if (Array.isArray(c.best_months) && typeof ctx.month === 'number' && c.best_months.map(Number).includes(ctx.month)) hits.push(`month=${ctx.month}`)
  if (hits.length === 0) return null
  return {
    entry,
    wishId: String(entry.wish_id ?? ''),
    score: hits.length,
    hits,
  }
}

/**
 * 0..1 挑选:muted 永不召回;无稳定 wish_id 的条目不召回(sidecar 依赖主键);
 * 取最高分,tie-break added_at 最早 → wish_id 字典序。无命中返回 null。
 */
export function pickNudgeWish(pool: WishPoolEntry[], ctx: WishMatchContext): WishMatch | null {
  const scored = pool
    .filter(e => !e.muted && typeof e.wish_id === 'string')
    .map(e => scoreWishMatch(e, ctx))
    .filter((m): m is WishMatch => m !== null)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      const ta = String(a.entry.added_at ?? '')
      const tb = String(b.entry.added_at ?? '')
      if (ta !== tb) return ta < tb ? -1 : 1
      return a.wishId < b.wishId ? -1 : 1
    })
  return scored[0] ?? null
}
