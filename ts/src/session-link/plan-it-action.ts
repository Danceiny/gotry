/**
 * Plan-it 行动卡(issue #580,Phase E)——why-now 卡(Phase D)的一键行动
 * 面:「好,规划它」深链回本地 session 继续规划该 wish。**只打开,不写**:
 * 行动词位只有 plan_it(Continue planning),booking/payment 不在链接词位
 * (session-link.ts 的 action 闭集),WriteGate 保持 sealed。
 *
 * 纪律:
 *   - 行动卡是数据(不是渲染 HTML);渲染面(deck / 对话 / 通知)各自消费;
 *   - `wish_id` 与 token payload **同源构造**(同一个值进两处),不可能漂移——
 *     渲染面显示的 wish 与链接打开的 wish 是构造级同一个;
 *   - label 是封闭词汇(「好,规划它」改措辞 = 契约变更,先 review);
 *   - why-now 卡的「not_now」是渲染面本地消解(无链接、无状态写),
 *     本契约不覆盖(文档声明)。
 */

import type { WhyNowCard } from '../recall/card.ts'
import { formatSessionLink, signSessionLink, type SessionLinkPayload } from './session-link.ts'

export interface PlanItAction {
  /** 恒 'plan_it'(构造保证;不存在其它 kind 的 PlanItAction) */
  kind: 'plan_it'
  /** 行动文案(封闭词汇) */
  label: string
  /** 渲染好的深链(formatSessionLink 默认 base `gotry://session/<token>`) */
  deep_link: string
  /** 与 token payload 同源构造的 wish_id(冗余自洽;渲染面可直接显示) */
  wish_id: string
}

/** plan-it 行动文案(封闭词汇) */
export const PLAN_IT_LABEL = '好,规划它'

export interface BuildPlanItActionDeps {
  /** 不透明 session 引用(session-link.ts 护栏:非路径) */
  session_ref: string
  /** 幂等 id(调用方给;缺省随机) */
  link_id?: string
  /** 链接有效秒数(默认 24h;上限 SESSION_LINK_TTL_MAX_SECONDS) */
  ttl_seconds?: number
  /** 渲染 base(缺省 gotry://session;本地 http 消费端可传 http://127.0.0.1:3080/session) */
  base?: string
  /** HMAC secret(缺省 resolveSessionLinkSecret()) */
  secret?: string
  /** 时钟注入(测试用) */
  now?: () => Date
}

/**
 * why-now 卡 → plan-it 行动卡。wish_id 取卡上的结构化字段(Phase E 起
 * WhyNowCard 必含 wish_id——从 title 字符串反解不可接受)。
 * 非法输入(wish_id 缺失/空、session_ref 路径化)抛错:行动卡构造层
 * 即 fail-closed,不产「点了不知道开什么」的链接。
 */
export function buildPlanItAction(card: WhyNowCard, deps: BuildPlanItActionDeps): PlanItAction {
  if (typeof card?.wish_id !== 'string' || card.wish_id.length === 0) {
    throw new Error('buildPlanItAction:card.wish_id 必须是非空字符串(WhyNowCard 结构化自指其 wish 是 plan-it 行动的前提)')
  }
  if (typeof deps?.session_ref !== 'string' || deps.session_ref.length === 0) {
    throw new Error(`buildPlanItAction:session_ref 必须是非空字符串(实测 ${String(deps?.session_ref)})`)
  }
  const now = deps.now ?? (() => new Date())
  const payload: SessionLinkPayload = {
    link_id: deps.link_id ?? `plan-${now().getTime().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    session_ref: deps.session_ref,
    action: 'plan_it',
    wish_id: card.wish_id,
    created_at: now().toISOString(),
    ttl_seconds: deps.ttl_seconds ?? 86_400,
  }
  // wish_id 同源:payload.wish_id 就是上面 card.wish_id 这一个值
  const token = signSessionLink(payload, deps.secret)
  return {
    kind: 'plan_it',
    label: PLAN_IT_LABEL,
    deep_link: formatSessionLink(token, deps.base),
    wish_id: card.wish_id,
  }
}
