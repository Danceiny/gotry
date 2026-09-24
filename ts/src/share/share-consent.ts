/**
 * Share consent state machine(issue #573,Phase C 切片;自检 review 修复见 PR #574)。
 *
 * 模式:`mode: 'ask' | 'allow' | 'off'` 三态总开关 + 每 share_id 一次性同意卡。
 * 借鉴 `session-consent.ts` 的「一次一卡 + 拒绝即撤回 + 总开关 off」范式,
 * 但与 session 授权**完全独立**(不合并——session 是「我能不能读你的浏览器」,
 * share 是「我能不能替你外发到第三方」,两类授权的语义与撤销粒度都不同)。
 *
 * 三条硬纪律:
 *   1. **默认 deny**:off 一律拒;ask/allow 下该 share_id 无存活卡 → consent_required;
 *   2. **拒绝即撤回**:card_id 进 revoked 后,该卡即死;调用方出示的 card_id 必须
 *      本身存活(在哪张卡上匹配就以哪张为准——不是「第一张活卡」);
 *   3. **状态纯函数**:grant/revoke/setMode 返回新 state,不原地改;grant 幂等
 *      (同 share 已有存活卡则复用该卡,不再追加——防多卡漂移破坏撤销全量性)。
 */

import { randomUUID } from 'node:crypto'

export type ShareConsentMode = 'ask' | 'allow' | 'off'

export interface ShareConsentCard {
  card_id: string
  share_id: string
  granted_at: string  // ISO
}

export interface ShareConsentState {
  mode: ShareConsentMode
  /** append-only,granted 过的卡 */
  granted: ShareConsentCard[]
  /** 已撤销的 card_id(可能与 granted 重叠——grant 后被 revoke 即同时存在) */
  revoked: string[]
}

export type ShareConsentCheckResult =
  | { ok: true }
  | { ok: false; reason: 'share_consent_off' | 'consent_required' | 'consent_revoked' }

export function defaultShareConsentState(): ShareConsentState {
  return { mode: 'ask', granted: [], revoked: [] }
}

/** 校验:off 一律拒;该 share_id 无任何卡 → consent_required(从未发卡);
 *  有卡但全部被撤 → consent_revoked(曾发卡已撤);调用方出示 card_id 时,
 *  该卡必须属于此 share 且自身未撤销(按卡匹配,不按第一张活卡——防多卡下
 *  合法卡被误判 revoked、被撤卡被其它活卡顶替)。 */
export function checkShareConsent(state: ShareConsentState, share_id: string, card_id?: string): ShareConsentCheckResult {
  if (state.mode === 'off') return { ok: false, reason: 'share_consent_off' }
  // 边界守卫:畸形持久化 state(字段非数组)fail closed 视为空——绝不抛错
  const grantedList = Array.isArray(state?.granted) ? state.granted : []
  const revokedList = Array.isArray(state?.revoked) ? state.revoked : []
  const allForShare = grantedList.filter(c => c.share_id === share_id)
  if (allForShare.length === 0) {
    return { ok: false, reason: 'consent_required' }
  }
  if (card_id !== undefined) {
    const given = allForShare.find(c => c.card_id === card_id)
    if (!given || revokedList.includes(card_id)) {
      return { ok: false, reason: 'consent_revoked' }
    }
    return { ok: true }
  }
  const anyLive = allForShare.some(c => !revokedList.includes(c.card_id))
  if (!anyLive) {
    return { ok: false, reason: 'consent_revoked' }
  }
  return { ok: true }
}

/** 发卡:幂等——同 share_id 已有存活卡则复用(不再追加,防多卡漂移);
 *  否则追加新卡。返回 state 与卡本身(调用方持有 card_id 用于后续校验)。 */
export function grantShareConsent(
  state: ShareConsentState,
  share_id: string,
  now: () => Date = () => new Date(),
  randomCardId: () => string = defaultCardId,
): { state: ShareConsentState; card: ShareConsentCard } {
  const existing = state.granted.find(c => c.share_id === share_id && !state.revoked.includes(c.card_id))
  if (existing) return { state, card: existing }
  const card: ShareConsentCard = {
    card_id: randomCardId(),
    share_id,
    granted_at: now().toISOString(),
  }
  return {
    state: { mode: state.mode, granted: [...state.granted, card], revoked: state.revoked },
    card,
  }
}

/** 撤回:把 card_id 加入 revoked(幂等——重复 revoke 不变) */
export function revokeShareConsent(state: ShareConsentState, card_id: string): ShareConsentState {
  if (state.revoked.includes(card_id)) return state
  return { mode: state.mode, granted: state.granted, revoked: [...state.revoked, card_id] }
}

/** 切总开关:返回新 state(不原地改) */
export function setShareConsentMode(state: ShareConsentState, mode: ShareConsentMode): ShareConsentState {
  return { mode, granted: state.granted, revoked: state.revoked }
}

/** 默认 card_id 生成器(测试可注入);Node 原生 crypto.randomUUID */
export function defaultCardId(): string {
  return randomUUID()
}