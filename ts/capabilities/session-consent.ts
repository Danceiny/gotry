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
 *
 * site 绑定(2026-09-10 #308):同一工具多个 kind(例如 gotry_session_search → flight/hotel/dida/train)
 * 必须按与 execute 同源的 interpretArgs 选 site(包装 query 优先);授权与拒绝均按 site
 * 分桶。缺省 kind 保持工具合同的 flight 默认值;unknown/malformed kind 失败关闭(deny,
 * 不扩权),防止新站点未登记就放行。train 虽是 12306 公开查询面,仍经过本闸的 off/ask/allow。
 */

import type { Context } from '@deepseek-ai/cordis'
import { interpretArgs } from '../src/tool-packet.ts'

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

/**
 * 工具级 site 表(无 kind 维度时使用):key=工具名,value=站点。
 * 复合工具(同一名字下多 kind)在 SITE_FOR_KIND 中显式登记。
 */
export const ACCOUNT_TOOLS: Record<string, string> = {
  gotry_session_search: 'ctrip-flight',
}

const SITE_LABEL: Record<string, string> = {
  'ctrip-flight': '携程机票',
  'ctrip-hotel': '携程酒店',
  'dida-portal': 'Dida 供应商门户',
  'train-12306': '12306 余票(公开查询面)',
}

/**
 * 复合工具 × kind → site(#308:site 绑定)。
 * 仅对显式登记的 kind 放行,未知 kind → 失败关闭(防止未登记站点扩权)。
 * 12306 公开查询面(kind=train)仍受本工具的会话授权总闸约束,不因公开查询而绕过 off/ask/allow。
 */
export const SITE_FOR_KIND: Record<string, Record<string, string>> = {
  gotry_session_search: {
    flight: 'ctrip-flight',
    hotel: 'ctrip-hotel',
    dida: 'dida-portal',
    train: 'train-12306',
  },
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

export type ConsentExec = { name?: string; agent?: object; callId?: string; arguments?: unknown }
export type ConsentGate = (exec: ConsentExec, next: () => Promise<ConsentDecision>) => Promise<ConsentDecision>

/** 会话检索工具支持的 kind;gate 与 execute 共用此选择结果。 */
export const SESSION_SEARCH_KINDS = ['flight', 'hotel', 'train', 'dida'] as const
export type SessionSearchKind = typeof SESSION_SEARCH_KINDS[number]

export type SessionSearchKindSelection =
  | { ok: true; kind: SessionSearchKind }
  | { ok: false; reason: string }

/**
 * Select the kind exactly as the session tool execute path does.
 * `interpretArgs` is intentionally the only query-wrapper normalizer: a
 * wrapped query wins over conflicting flat fields, and omitted kind keeps the
 * documented flight default. Explicit malformed/unknown kinds fail closed.
 */
export function resolveSessionSearchKind(args: unknown): SessionSearchKindSelection {
  if (args === undefined) return { ok: true, kind: 'flight' }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, reason: 'gotry_session_search 参数必须是对象;无法安全选择 kind,已失败关闭' }
  }
  const selected = interpretArgs<{ kind?: unknown }>(args as { query?: unknown } & Record<string, unknown>)
  if (!selected || typeof selected !== 'object' || Array.isArray(selected)) {
    return { ok: false, reason: 'gotry_session_search 参数包装形态无效;无法安全选择 kind,已失败关闭' }
  }
  if (!Object.prototype.hasOwnProperty.call(selected, 'kind')) return { ok: true, kind: 'flight' }
  const kind = (selected as { kind?: unknown }).kind
  if (typeof kind !== 'string' || kind.length === 0) {
    return { ok: false, reason: 'gotry_session_search 收到 malformed kind;无法安全选择站点,已失败关闭' }
  }
  if (!(SESSION_SEARCH_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, reason: `gotry_session_search 收到未知 kind=${kind};只支持 ${SESSION_SEARCH_KINDS.join('/')},未知 kind 失败关闭` }
  }
  return { ok: true, kind: kind as SessionSearchKind }
}

/**
 * 解析 site(#308):对复合工具(缺省 kind=flight,未知/malformed kind → fail-closed);对未在
 * SITE_FOR_KIND 登记的工具走原 ACCOUNT_TOOLS 表保持兼容。无 site → 放行(非账号面工具)。
 */
export function resolveSiteForExec(exec: ConsentExec): { site: string } | { failClosed: true; reason: string } | null {
  const name = exec.name
  if (!name) return null
  const map = SITE_FOR_KIND[name]
  if (map) {
    const selected = resolveSessionSearchKind(exec.arguments)
    if (!selected.ok) return { failClosed: true, reason: selected.reason }
    const site = map[selected.kind]
    if (!site) return { failClosed: true, reason: `工具 ${name} 的 kind=${selected.kind} 未登记站点;失败关闭` }
    return { site }
  }
  const site = ACCOUNT_TOOLS[name]
  if (!site) return null
  return { site }
}

function reasonFor(toolName: string, site: string): string {
  return `工具 ${toolName} 将使用你本人已登录的浏览器会话，在「${SITE_LABEL[site] ?? site}」进行只读检索`
    + '（ReadGuard 物理只读：写请求在网络层即中止，agent 永不接触凭证与验证码）；'
    + '本次批准仅在本会话内有效，会话结束即失效，不会跨会话延续。'
}

/**
 * 账号会话授权闸:挂 dsh `tools/pre-execute` waterfall。
 * 契约:
 *   - 非账号面工具 → next() 放行(零开销);
 *   - off → 拒绝(随时可关);
 *   - 会话内已拒绝 → 拒绝且不弹卡(拒绝=本会话吊销;按 site 分桶,跨站不互授);
 *   - 会话内已批准 / allow 预授权 → 放行;
 *   - 复合工具未知/malformed kind → fail-closed deny(不扩权),缺省 kind=flight;
 *   - 其余 → ApprovalService.request();allowed-once 按 site 入会话 granted;
 *     rejected/cancelled 按 site 入会话 denied(本会话不在请求);
 *     无审批通道 → deny(fail-closed,headless 无用户 = 无授权)。
 */
export function createConsentGate(opts: ConsentGateOptions): ConsentGate {
  const store = opts.store ?? new WeakMap<object, AuthState>()
  const approvalOf = opts.approval ?? (() => undefined)
  return async (exec, next) => {
    const resolved = resolveSiteForExec(exec)
    if (!resolved) return next()
    if ('failClosed' in resolved) return { kind: 'deny', reason: resolved.reason }
    const { site } = resolved
    if ((opts.access() ?? 'ask') === 'off') {
      return { kind: 'deny', reason: `工具 ${exec.name} 已被配置关闭（sessionAccess=off）。如需重新启用账号会话检索，请到配置中重新开启 sessionAccess。` }
    }
    const state = (exec.agent && store.get(exec.agent)) || undefined
    if (state?.denied.has(site)) {
      return { kind: 'deny', reason: `你已在本会话拒绝过「${SITE_LABEL[site] ?? site}」的账号会话检索。为避免反复打扰，本会话不再请求授权，请改用其他工具继续推进。` }
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
      return { kind: 'deny', reason: `你刚刚拒绝了工具 ${exec.name} 的账号会话授权（本次拒绝仅在本会话内生效）。为避免反复打扰，本会话不再重复请求授权，请改用其他工具继续推进。` }
    }
    return { kind: 'deny', reason: `工具 ${exec.name} 需要你授权，但当前没有可用的审批通道。在 headless 一问一答场景下没有审批界面，请改用 web 会话来使用账号会话检索。` }
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
