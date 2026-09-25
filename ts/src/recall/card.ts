/**
 * Why-now card builder(issue #577,Phase D;研究决策 §3 Phase D;
 * 自检 review 修复见 PR #578——边界校验让「无信源的卡构造上不可能」成为字面真)。
 *
 * 纯函数:RecallTrigger → WhyNowCard(中文文案:标题 + 触发原因 + 当前值/阈值 +
 * 行动建议 + source tag)。
 *
 * 纪律:
 *   - **边界强制 provenance**:buildWhyNowCard 校验 signal.source 非空 + reason 在
 *     闭集,不合法**直接抛错**——「source_tag 必现」不再是注释承诺而是构造保证;
 *   - 文案模板是封闭词汇(标题/建议的措辞改 = 契约变更,先 review);
 *   - 卡片是数据(不是渲染 HTML);渲染面(deck / 对话 / SMS)各自消费;
 *   - renderWhyNowCardLine 必须带证据边界标记(渲染契约:每个渲染面都要展示)。
 */

import { RECALL_REASON_LABEL, RECALL_REASONS, type RecallReason, type RecallTrigger } from './evaluator.ts'

export interface WhyNowCard {
  /** 卡片标题(如「现在可以去了:大理 · 洱海恢复之旅」;半角冒号——代码字面量即契约) */
  title: string
  /** 卡片所指的 wish(结构化自指;Phase E 起必含——plan-it 深链的行动目标,
   *  从 title 字符串反解不可接受) */
  wish_id: string
  /** 触发原因(枚举) */
  reason: RecallReason
  /** 触发原因的人话标签(如「假期临近」) */
  reason_label: string
  /** 当前值(如「2026-10-01(距今 7 天)」) */
  current_value: string
  /** 阈值(如「距假期 ≤14 天」) */
  threshold: string
  /** 行动建议(如「建议本周内规划出发」) */
  action_hint: string
  /** 源 tag(必现;渲染为 `[source:xxx]`) */
  source_tag: string
  /** 评估时刻(ISO) */
  evaluated_at: string
  /** 证据边界声明(恒 true;渲染面必须展示) */
  evidence_boundary: true
  /** 实际命中的愿望条件(评估器从 scoreWishMatch 带出的逐项 hits,如「days≥5」;
   *  **缺省 = 该卡未附条件命中证据**——手工构造的卡不发明证据;渲染面必须把
   *  「命中部分愿望条件」与「全部出行条件已满足」区分开,后者永不主张)。 */
  match_evidence?: string[]
}

const ACTION_HINT: Record<RecallReason, string> = {
  holiday_proximity: '建议在假期前完成规划,锁定当前档期',
  price_drop: '价格已降至阈值,建议尽快确认出发日期',
  weather_window: '天气窗口已打开,适合按原计划出行',
  route_new: '新班次已覆盖目标日期,可以重新评估可行性',
  availability_recovered: '通道已恢复,此前不可行的方案现在可以重新查询',
}

/**
 * 构造 why-now 卡:trigger → 人话卡片。
 * **边界强制 provenance**:signal.source 非空 + reason 在闭集,否则抛错
 * (「无信源的卡构造上不可能存在」的字面兑现——手工构造的 trigger 同样受检)。
 * **证据诚实**:trigger.match_hits 是非空字符串数组时原样带上(all-or-nothing,
 * 不部分裁剪、不发明);缺省/空/畸形 → 卡不带 match_evidence——手工构造的卡
 * 宁可无证据,不虚构命中。
 * title 格式:`现在可以去了:${wish_name}`(半角冒号)——封闭词汇,改措辞 = 契约变更。
 */
export function buildWhyNowCard(trigger: RecallTrigger): WhyNowCard {
  const { wish_id, wish_name, signal, evaluated_at } = trigger
  if (signal === null || typeof signal !== 'object') {
    throw new Error(`buildWhyNowCard:signal 必须是对象(实测 ${String(signal)})`)
  }
  if (typeof signal.source !== 'string' || signal.source.length === 0) {
    throw new Error('buildWhyNowCard:signal.source 必须是非空字符串(无信源的卡构造上不可能存在)')
  }
  if (!RECALL_REASONS.includes(signal.reason as RecallReason)) {
    throw new Error(`buildWhyNowCard:signal.reason 不在闭集(实测 ${String(signal.reason)};允许:${RECALL_REASONS.join(' / ')})`)
  }
  // 条件命中证据:all-or-nothing 校验(非空的非空字符串数组才带上;不发明、不裁剪)
  const rawHits: unknown = (trigger as Partial<RecallTrigger>).match_hits
  const hasEvidence = Array.isArray(rawHits) && rawHits.length > 0
    && rawHits.every(h => typeof h === 'string' && h.length > 0)
  return {
    title: `现在可以去了:${wish_name}`,
    wish_id,
    reason: signal.reason,
    reason_label: RECALL_REASON_LABEL[signal.reason],
    current_value: signal.current_value,
    threshold: signal.threshold,
    action_hint: ACTION_HINT[signal.reason],
    source_tag: `[source:${signal.source}]`,
    evaluated_at,
    evidence_boundary: true,
    ...(hasEvidence ? { match_evidence: [...(rawHits as string[])] } : {}),
  }
}

/** 渲染为单行中文摘要(对话/日志面用;卡片数据仍是权威)。
 *  必须含证据边界标记(渲染契约:每个渲染面都要展示 evidence_boundary);
 *  卡带 match_evidence 时逐项陈述命中条件,并显式声明**不主张全部出行条件已满足**
 *  (命中部分愿望条件只是召回资格,不是出行可行性证明)。 */
export function renderWhyNowCardLine(card: WhyNowCard): string {
  const evidence = Array.isArray(card.match_evidence) && card.match_evidence.length > 0
    ? card.match_evidence
    : null
  const conditionClause = evidence !== null ? `;命中条件:${evidence.join('+')}` : ''
  const boundary = evidence !== null
    ? '[证据边界:仅命中上述愿望条件,非全部出行条件已满足]'
    : '[证据边界:仅证据驱动]'
  return `${card.title}——${card.reason_label}(当前:${card.current_value};阈值:${card.threshold}${conditionClause})。${card.action_hint} ${card.source_tag} ${boundary}`
}