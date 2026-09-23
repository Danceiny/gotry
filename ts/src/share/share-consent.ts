/**
 * Share consent state machine(issue #573,Phase C 切片)。
 *
 * 模式:`mode: 'ask' | 'allow' | 'off'` 三态总开关 + 每 share_id 一次性同意卡。
 * 借鉴 `session-consent.ts` 的「一次一卡 + 拒绝即撤回 + 总开关 off」范式,
 * 但与 session 授权**完全独立**(不合并——session 是「我能不能读你的浏览器」,
 * share 是「我能不能替你外发到第三方」,两类授权的语义与撤销粒度都不同)。
 *
 * 三条硬纪律:
 *   1. **默认 deny**:`mode = 'ask'` 状态下没有 granted 卡 → share-deck 拒绝
 *      `consent_required`;`mode = 'off'` 一律拒绝 `share_consent_off`;
 *   2. **拒绝即撤回**:把已 granted 的卡 id 加入 revoked;share-deck 看到
 *      revoked.card_id 命中 → `consent_revoked`;
 *   3. **状态纯函数**:`grantShareConsent` / `revokeShareConsent` 返回新 state,不
 *      原地改——便于测试与多调用方并存。
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

/** 默认 deny;只在 mode='allow' 且对应 share_id 有未撤销的卡时通过
 *  撤回过的卡必须显式返回 consent_revoked(与「从未发卡」区分) */
export function checkShareConsent(state: ShareConsentState, share_id: string, card_id?: string): ShareConsentCheckResult {
  if (state.mode === 'off') return { ok: false, reason: 'share_consent_off' }
  const allForShare = state.granted.filter(c => c.share_id === share_id)
  if (allForShare.length === 0) {
    // 从未发卡——ask/allow 模式下都要求先发卡
    return { ok: false, reason: 'consent_required' }
  }
  const live = allForShare.find(c => !state.revoked.includes(c.card_id))
  if (!live) {
    // 有发过卡但全部被撤回了——区分于「从未发卡」
    return { ok: false, reason: 'consent_revoked' }
  }
  // 若调用方提供了 card_id,二次校验——防止 share_id 与 card_id 不匹配
  if (card_id !== undefined && card_id !== live.card_id) {
    return { ok: false, reason: 'consent_revoked' }
  }
  return { ok: true }
}

/** 发卡:追加 granted 卡,返回新 state 与卡本身(调用方持有 card_id 用于后续校验) */
export function grantShareConsent(
  state: ShareConsentState,
  share_id: string,
  now: () => Date = () => new Date(),
  randomCardId: () => string = defaultCardId,
): { state: ShareConsentState; card: ShareConsentCard } {
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

/** 默认 card_id 生成器(测试可注入);用 Node 原生 crypto.randomUUID */
export function defaultCardId(): string {
  return randomUUID()
}