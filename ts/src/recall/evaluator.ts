/**
 * Recall condition evaluator(issue #577,Phase D;研究决策 §3 Phase D;
 * 自检 review 修复见 PR #578 评论——两轮:广播升级/容器与时钟守卫/单表派生;
 * #577 收口:条件资格门 + 命中证据,见 docs/design/recall-trigger.md §2)。
 *
 * 纯函数:给定 wish-pool 候选条目 + 当前上下文(时间 + 召回窗口 match_context +
 * 各类简化信号),产出一组 RecallTrigger——每个含「为什么是现在」的具体原因
 * (条件名 + 当前值 + 阈值)与实际命中的愿望条件(match_hits)与 source tag
 * (**proactive with provenance**——研究文档红线)。
 *
 * 纪律:
 *   - 原因闭集 5 类,**单表派生**(RECALL_REASON_LABEL 为唯一事实源;union / 数组 /
 *     label 全部从它推导——新增原因 = 改一张表,编译器强制 card.ts 的 hint 表补全);
 *   - **条件资格门**:候选必须先过 scoreWishMatch(wish-pool.ts 原样复用,不复制
 *     判定逻辑)——任一 days/budget/month 命中即有召回资格(既有语义:是召回资格,
 *     不是「全部出行条件已满足」的证明);命名 down 通道否证。信号(含定向)不能
 *     绕过资格门;match_context 缺省/畸形 → fail-closed 空返回,绝不降级为广播;
 *   - **职责边界**:信号是 producer 给的人话信号(current_value/threshold 是展示
 *     字符串,不是类型化价格/日期事实),评估器不解析它们;资格事实只来自注入的
 *     match_context;
 *   - 畸形输入(信号/容器/时钟/条目)**跳过或空返回,不崩**——评估器是消费链一环,
 *     一个坏 tick 不能杀掉调用方的 drain loop;
 *   - wish_ids 非数组(如字符串)= 畸形信号,**跳过**(绝不降级为广播匹配——
 *     广播是最激进模式,降级等于扩权);
 *   - muted 过滤用 `muted === true` 严格判定(JSON 往返的 'false' 字符串不再误杀)。
 */

import { scoreWishMatch, type WishMatch, type WishMatchContext, type WishPoolEntry } from '../wish-pool.ts'

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
  /** 当前值(人话,如「2026-10-01(距今 7 天)」;producer 展示串,评估器不解析) */
  current_value: string
  /** 阈值描述(人话,如「距假期 ≤14 天」;同上) */
  threshold: string
  /** 受影响的 wish_id 列表(空/缺省 = 广播;**非数组 = 畸形,整条跳过**) */
  wish_ids?: string[]
}

/** 评估上下文(tick 到来时由调用方组装;纯数据)。
 *  match_context 是 scoreWishMatch 的窗口事实(days/budgetCny/month/channelDown),
 *  缺省/畸形 → 整轮 fail-closed(空返回)——没有窗口证据就不宣称「现在可以去」。 */
export interface RecallContext {
  now: Date
  signals: RecallSignal[]
  match_context: WishMatchContext
}

/** 触发结果:wish × signal 的配对(一个 wish 可命中多个信号,一卡一信号) */
export interface RecallTrigger {
  wish_id: string
  wish_name: string
  signal: RecallSignal
  /** 评估时刻(ISO) */
  evaluated_at: string
  /** 实际命中的愿望条件(scoreWishMatch 的逐项 hits,如「days≥5」;恒非空数组——
   *  资格门保证;渲染「为什么是它」用,不主张全部出行条件已满足) */
  match_hits: string[]
}

/**
 * 评估:候选 × 信号 → 触发列表。
 * 两道门,先资格后匹配:
 *   1. **资格门**:候选非 muted + 有稳定非空 wish_id + scoreWishMatch(entry,
 *      match_context) 非空(任一条件命中,且无命名 down 通道否证)——信号匹配只在
 *      有资格的候选上进行;
 *   2. **匹配门**:signal.wish_ids 是非空字符串数组时按 id 精确匹配(定向);
 *      为空/缺省时匹配全部**有资格**候选(广播)。**wish_ids 为其它真值类型
 *      (字符串/对象等)视为畸形信号,整条跳过**——绝不降级为广播。
 * 容器/时钟/上下文守卫:signals/pool 非数组、ctx.now 非法、match_context 缺省或
 * 畸形 → 返回 [](不抛,不崩 drain loop,不广播扩权)。
 */
export function evaluateRecallTriggers(pool: WishPoolEntry[], ctx: RecallContext): RecallTrigger[] {
  // 容器与时钟守卫:一个坏 tick 不能杀掉调用方(fail-closed 空返回)
  if (!Array.isArray(pool) || !Array.isArray(ctx?.signals)) return []
  const nowMs = ctx.now instanceof Date ? ctx.now.getTime() : Number.NaN
  if (!Number.isFinite(nowMs)) return []
  // 条件上下文守卫:缺省/畸形 → fail-closed(绝不降级为「全部广播」——
  // 没有窗口证据就广播「现在可以去」正是 #577 要堵住的扩权)
  if (!isWishMatchContext(ctx.match_context)) return []
  const evaluatedAt = new Date(nowMs).toISOString()

  // 资格门:scoreWishMatch 非空(≥1 项 days/budget/month 命中,且无命名通道 down 否证)
  // 才进入候选;保持 pool 原序(广播/定向的输出顺序与既有行为一致)
  const eligible: Array<{ entry: WishPoolEntry; match: WishMatch }> = []
  for (const e of pool) {
    if (e?.muted === true || typeof e?.wish_id !== 'string' || e.wish_id.length === 0) continue
    const match = scoreCandidate(e, ctx.match_context)
    if (match !== null) eligible.push({ entry: e, match })
  }

  const triggers: RecallTrigger[] = []
  for (const signal of ctx.signals) {
    if (!isRecallSignal(signal)) continue
    const targets = Array.isArray(signal.wish_ids) && signal.wish_ids.length > 0
      ? eligible.filter(({ entry }) => (signal.wish_ids as string[]).includes(entry.wish_id as string))
      : eligible
    for (const { entry, match } of targets) {
      triggers.push({
        wish_id: String(entry.wish_id),
        wish_name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : String(entry.wish_id),
        signal,
        evaluated_at: evaluatedAt,
        match_hits: [...match.hits],
      })
    }
  }
  return triggers
}

/**
 * 资格判定:scoreWishMatch 原样复用(唯一判定层,不复制判定/阈值逻辑)。
 * 意外抛错(运行时畸形形态逃过静态与结构检查)→ 该条目无资格,不崩——
 * 单个坏条目不能杀掉整轮评估。
 */
function scoreCandidate(entry: WishPoolEntry, ctx: WishMatchContext): WishMatch | null {
  try {
    return scoreWishMatch(entry, ctx)
  } catch {
    return null
  }
}

/** match_context 运行时校验(JSON 往返边界强制):非数组对象 + 数值字段(若给出)
 *  必须是有限数字 + channelDown(若给出非 null)必须具备 has 方法(Set 形)。
 *  与 scoreWishMatch 的缺省语义对齐:channelDown 缺省/null = 不启用通道否证。 */
function isWishMatchContext(value: unknown): value is WishMatchContext {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const c = value as Record<string, unknown>
  for (const k of ['days', 'budgetCny', 'month'] as const) {
    const v = c[k]
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v))) return false
  }
  const down = c.channelDown
  if (down !== undefined && down !== null && typeof (down as { has?: unknown }).has !== 'function') return false
  return true
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
