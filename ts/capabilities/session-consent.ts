/**
 * SessionConsent——账号会话授权闸(RFC 合规支柱④「用户明示授权 + 站点白名单 + 随时可关」进代码)。
 *
 * founder 口径(2026-08-29):「OTA 这些都是工具,不要区分什么主路径/降级路径;
 * 这要用到用户的账号,所以必须跟用户确认(请求授权)。」
 * 运行时原生审批卡语义是 allowed-once(逐调用批准)——首日落地后 founder 实测纠偏:
 * 「每次都要弹,经常无法点击」→ 逐次弹卡把授权变成了骚扰。授权模型 v2:
 *
 *   - 每会话每站点**首次调用**弹审批卡;allowed-once 记入该 agent 的 granted 集,
 *     会话内同站点后续调用直接放行(不再弹);
 *   - rejected/cancelled 视为**会话内吊销**(denied 集):本会话不再弹卡、不再执行,
 *     返回值明确告诉模型「改走其他工具,不要反复尝试」——防止反复开页骚扰用户;
 *   - 审批通道缺席(unavailable,如 headless 一问一答)→ deny 且**不**记 denied
 *     (通道回来后还能问一次);
 *   - sessionAccess = 'ask'(默认)| 'allow'(用户已明示预授权,放行)| 'off'(随时可关);
 *   - 授权状态存 Weak<agent>——会话结束即遗忘,绝不跨会话持久化(明示授权不默认延续)。
 * 审计:批准/拒绝事件由 dsh ApprovalService 落 session log(approval/asked + decided),
 * 本模块不重复建账。站点白名单 = ACCOUNT_TOOLS 注册表(新会话适配器接入时登记)。
 */

import type { Context } from '@deepseek-ai/cordis'

export type SessionAccess = 'ask' | 'allow' | 'off'
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** dsh-tools PreToolDecision 同构(自持类型,纯函数可离线测试) */
export type ConsentDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason?: string }

export interface ApprovalSeam {
  request(r: { agent?: unknown; toolName: string; callId?: string; reason?: string; signal?: AbortSignal }): Promise<ApprovalOutcome>
}

/** 账号面工具 → 站点(白名单登记处;新会话适配器接入时在此登记) */
export const ACCOUNT_TOOLS: Record<string, string> = {
  gotry_session_search: 'ctrip-flight',
}

const SITE_LABEL: Record<string, string> = {
  'ctrip-flight': '携程机票',
}

interface AuthState {
  granted: Set<string>
  denied: Set<string>
}

export interface ConsentGateOptions {
  /** 主闸语义:ask=每会话每站点首调弹卡(默认);allow=配置级预授权放行;off=总闸关 */
  access: () => string
  /** 审批缝懒解析(审批服务晚于插件注册,与 dsh-tools serviceAsk 同协议,缺席=运行时原生 ask→fail-closed) */
  approval?: () => ApprovalSeam | undefined
  /** 授权状态仓(Weak:随 agent/会话回收;测试注入) */
  store?: WeakMap<object, AuthState>
}

export type ConsentExec = { name?: string; agent?: object; callId?: string }
export type ConsentGate = (exec: ConsentExec, next: () => Promise<ConsentDecision>) => Promise<ConsentDecision>

function reasonFor(toolName: string, site: string): string {
  return `${toolName} 将使用你本人已登录的浏览器会话做「${SITE_LABEL[site] ?? site}」只读检索`
    + '(ReadGuard 物理只读:写请求网络层中止,agent 永不碰凭证与验证码);本次批准在你本会话内有效'
}

/**
 * 账号会话授权闸:挂 dsh `tools/pre-execute` waterfall。
 * 契约:
 *   - 非账号面工具 → next() 放行(零开销);
 *   - off → 拒绝(随时可关);
 *   - 会话内已拒绝 → 拒绝且不弹卡(拒绝=本会话吊销);
 *   - 会话内已批准 / allow 预授权 → 放行;
 *   - 其余 → ApprovalService.request();allowed-once 记入会话 granted;
 *     rejected/cancelled 记入会话 denied(本会话不在请求);
 *     无审批通道 → deny(fail-closed,headless 无用户 = 无授权)。
 */
export function createConsentGate(opts: ConsentGateOptions): ConsentGate {
  const store = opts.store ?? new WeakMap<object, AuthState>()
  const approvalOf = opts.approval ?? (() => undefined)
  return async (exec, next) => {
    const site = exec.name && ACCOUNT_TOOLS[exec.name]
    if (!site) return next()
    if ((opts.access() ?? 'ask') === 'off') {
      return { kind: 'deny', reason: `${exec.name} 已被配置关闭(sessionAccess=off);需要账号会话检索时由用户开启` }
    }
    const state = (exec.agent && store.get(exec.agent)) || undefined
    if (state?.denied.has(site)) {
      return { kind: 'deny', reason: `你在本会话已拒绝过「${SITE_LABEL[site] ?? site}」的账号会话检索——本会话不再请求授权,请改走其他工具推进` }
    }
    if (state?.granted.has(site) || (opts.access() === 'allow' && exec.agent)) return next()
    const approval = opts.approval?.()
    if (!approval || !exec.agent) return { kind: 'ask', reason: reasonFor(exec.name ?? '', site) }
    let outcome: string
    try {
      outcome = await approval.request({ agent: exec.agent, toolName: exec.name ?? '', callId: exec.callId, reason: reasonFor(exec.name ?? '', site) })
    } catch {
      outcome = 'unavailable'
    }
    if (outcome === 'allowed-once') {
      remember(store, exec.agent, site, 'grant')
      return next()
    }
    if (outcome === 'rejected' || outcome === 'cancelled') {
      remember(store, exec.agent, site, 'deny')
      return { kind: 'deny', reason: `你拒绝了 ${exec.name} 的账号会话授权(本会话内生效);不再重复请求,请改走其他工具推进` }
    }
    return { kind: 'deny', reason: `${exec.name} 需要你授权,但当前没有可用的审批通道(headless 一问一答无审批界面;请在 web 会话中使用账号会话检索)` }
  }
}

function remember(store: WeakMap<object, AuthState>, agent: object, site: string, mode: 'grant' | 'deny'): void {
  const prev = store.get(agent) ?? { granted: new Set<string>(), denied: new Set<string>() }
  if (mode === 'grant') prev.granted.add(site)
  else prev.denied.add(site)
  store.set(agent, prev)
}

/** 从运行时上下文懒解析审批缝(与 dsh-tools serviceAsk 的 ctx.get('approval') 同一协议) */
export function approvalFromContext(ctx: Context): () => ApprovalSeam | undefined {
  return () => {
    const get = (ctx as unknown as { get?: (n: string) => unknown }).get
    if (typeof get !== 'function') return undefined
    const approval = get.call(ctx, 'approval') as ApprovalSeam | undefined
    return approval && typeof approval.request === 'function' ? approval : undefined
  }
}