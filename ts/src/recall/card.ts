/**
 * Why-now card builder(issue #577,Phase D;研究决策 §3 Phase D)。
 *
 * 纯函数:RecallTrigger → WhyNowCard(中文文案:标题 + 触发原因 + 当前值/阈值 +
 * 行动建议 + source tag)。
 *
 * 纪律:
 *   - **source tag 必现**(研究文档红线:proactive with provenance);
 *   - 文案模板是封闭词汇(标题/建议的措辞改 = 契约变更,先 review);
 *   - 卡片是数据(不是渲染 HTML);渲染面(deck / 对话 / SMS)各自消费。
 */

import { RECALL_REASON_LABEL, type RecallTrigger } from './evaluator.ts'

export interface WhyNowCard {
  /** 卡片标题(如「现在可以去了:大理 · 洱海恢复之旅」) */
  title: string
  /** 触发原因(枚举) */
  reason: RecallTrigger['signal']['reason']
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
}

const ACTION_HINT: Record<RecallTrigger['signal']['reason'], string> = {
  holiday_proximity: '建议在假期前完成规划,锁定当前档期',
  price_drop: '价格已降至阈值,建议尽快确认出发日期',
  weather_window: '天气窗口已打开,适合按原计划出行',
  route_new: '新班次已覆盖目标日期,可以重新评估可行性',
  availability_recovered: '通道已恢复,此前不可行的方案现在可以重新查询',
}

/**
 * 构造 why-now 卡:trigger → 人话卡片。
 * title 格式:`现在可以去了:${wish_name}`——封闭词汇,改措辞 = 契约变更。
 */
export function buildWhyNowCard(trigger: RecallTrigger): WhyNowCard {
  const { wish_name, signal, evaluated_at } = trigger
  return {
    title: `现在可以去了:${wish_name}`,
    reason: signal.reason,
    reason_label: RECALL_REASON_LABEL[signal.reason],
    current_value: signal.current_value,
    threshold: signal.threshold,
    action_hint: ACTION_HINT[signal.reason],
    source_tag: `[source:${signal.source}]`,
    evaluated_at,
    evidence_boundary: true,
  }
}

/** 渲染为单行中文摘要(对话/日志面用;卡片数据仍是权威) */
export function renderWhyNowCardLine(card: WhyNowCard): string {
  return `${card.title}——${card.reason_label}(当前:${card.current_value};阈值:${card.threshold})。${card.action_hint} ${card.source_tag}`
}