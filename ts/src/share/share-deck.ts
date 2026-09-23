/**
 * Share deck 主入口(issue #573,Phase C 切片):对外发起一次 share 动作的契约编排。
 *
 * 流程(每步都 fail closed,无副作用):
 *   1. verifyShareToken(token, secret) → 失败返回 reason
 *   2. checkShareConsent(state, share_id, card_id?) → 失败返回 reason
 *   3. ADAPTERS[payload.target.channel] → 不存在返回 'unknown_channel'
 *   4. adapter.send(payload) → 直接返回 adapter 结果(契约:不抛错)
 *
 * 设计要点:
 *   - 纯异步编排,无 IO / 无网络 / 不写 state(consent state 由调用方持有);
 *   - secret + state + now 全部依赖注入,测试可全离线确定性;
 *   - **不挂 dsh 工具面**(留给 M4);Phase C 只交付契约 + stub + 流程。
 */

import { ADAPTERS, type ShareChannel, type ShareFailureReason, type SharePayload, type ShareResult } from './adapters.ts'
import { verifyShareToken, type ShareTokenVerifyResult } from './share-token.ts'
import { checkShareConsent, type ShareConsentState, type ShareConsentCheckResult } from './share-consent.ts'

export interface ShareDeckDeps {
  /** HMAC secret(由调用方经 share-token.resolveShareSecret 解析) */
  secret: string
  /** consent state(由调用方持有 + 持久化;本模块不读不写) */
  state: ShareConsentState
  /** 时间注入(测试用) */
  now?: () => Date
}

/** 公开的 payload 形状(不含 token —— token 单独传) */
export type ShareDeckRequest = Omit<SharePayload, 'token'>

export async function shareDeck(token: string, payload: ShareDeckRequest, deps: ShareDeckDeps): Promise<ShareResult> {
  // 1. token 校验
  const tokenCheck: ShareTokenVerifyResult = verifyShareToken(token, deps.secret, deps.now)
  if (!tokenCheck.ok) {
    return { delivered: false, reason: tokenCheck.reason }
  }
  const shareId = tokenCheck.payload.share_id

  // 2. consent 校验(token 内 share_id + 调用方可选的 card_id 二次校验)
  const consent: ShareConsentCheckResult = checkShareConsent(deps.state, shareId)
  if (!consent.ok) {
    return { delivered: false, reason: consent.reason }
  }

  // 3. 通道分发
  const channel: ShareChannel = payload.target.channel
  const adapter = ADAPTERS[channel]
  if (!adapter) return { delivered: false, reason: 'unknown_channel' as ShareFailureReason }

  // 4. 调用 adapter(stub 在 Phase C 统一返回 not_activated;M4 阶段此处换真实实现)
  const fullPayload: SharePayload = { token, target: payload.target, body: payload.body }
  const sentAt = (deps.now ?? (() => new Date()))().toISOString()
  const result = await adapter.send(fullPayload)
  // 即使 adapter 失败,ShareResult 已含 reason——原样返回,加 sent_at 兜底(便于 UI 显示)
  if (result.delivered) return { ...result, sent_at: result.sent_at ?? sentAt }
  return { delivered: false, reason: result.reason }
}