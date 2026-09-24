/**
 * Share deck 主入口(issue #573,Phase C 切片;自检 review 修复见 PR #574):
 * 对外发起一次 share 动作的契约编排。
 *
 * 流程(每步都 fail closed,无副作用):
 *   1. verifyShareToken(token, secret) → 失败返回 reason
 *   2. tokenTargetMatches(payload.target) → 目的地与签名不符返回 token_invalid
 *   3. checkShareConsent(state, share_id, deps.card_id?) → 失败返回 reason
 *   4. 分发守卫(hasAdapterChannel:自有键判定,挡原型键)→ unknown_channel
 *   5. adapter.send(payload) **在 try/catch 内** → 抛错收敛为 adapter_error
 *
 * 设计要点:
 *   - 纯异步编排,无 IO / 无网络 / 不写 state(consent state 由调用方持有);
 *   - secret + state + now + card_id + adapters 全部依赖注入,测试可全离线确定性;
 *   - **永不抛错**:任何 adapter 异常都被收敛为 ShareResult(契约出口唯一);
 *   - **不挂 dsh 工具面**(留给 M4);Phase C 只交付契约 + stub + 流程。
 */

import {
  ADAPTERS,
  hasAdapterChannel,
  type ShareAdapter,
  type ShareChannel,
  type SharePayload,
  type ShareResult,
} from './adapters.ts'
import { tokenTargetMatches, verifyShareToken } from './share-token.ts'
import { checkShareConsent, type ShareConsentState } from './share-consent.ts'

export interface ShareDeckDeps {
  /** HMAC secret(由调用方经 share-token.resolveShareSecret 解析) */
  secret: string
  /** consent state(由调用方持有 + 持久化;本模块不读不写) */
  state: ShareConsentState
  /** 时间注入(测试用) */
  now?: () => Date
  /** 可选:调用方持有的同意卡 id(二次校验——出示的卡必须属于该 share 且未撤销) */
  card_id?: string
  /** 可选:适配器表注入(测试/M4 用;缺省走冻结的 ADAPTERS) */
  adapters?: Readonly<Record<ShareChannel, ShareAdapter>>
}

/** 公开的 payload 形状(不含 token —— token 单独传) */
export type ShareDeckRequest = Omit<SharePayload, 'token'>

export async function shareDeck(token: string, payload: ShareDeckRequest, deps: ShareDeckDeps): Promise<ShareResult> {
  // 1. token 校验(签名/格式/ttl/过期)
  const tokenCheck = verifyShareToken(token, deps.secret, deps.now)
  if (!tokenCheck.ok) {
    return { delivered: false, reason: tokenCheck.reason }
  }

  // 2. 目的地绑定:token 签发时的 target 必须与本次请求完全一致(防换收件人重放)
  if (!tokenTargetMatches(tokenCheck.payload, payload.target)) {
    return { delivered: false, reason: 'token_invalid' }
  }
  const shareId = tokenCheck.payload.share_id

  // 3. consent 校验(share_id + 调用方出示的可选 card_id 二次校验)
  const consent = checkShareConsent(deps.state, shareId, deps.card_id)
  if (!consent.ok) {
    return { delivered: false, reason: consent.reason }
  }

  // 4. 分发守卫:自有键判定(原型键 '__proto__'/'constructor' 等经 Record 索引会
  //    命中继承成员,直接 lookup 拿到真值后 adapter.send undefined 会崩——先挡)
  const table = deps.adapters ?? ADAPTERS
  const channel = payload.target.channel
  if (!hasAdapterChannel(table, channel)) {
    return { delivered: false, reason: 'unknown_channel' }
  }
  const adapter = (table as Readonly<Record<string, ShareAdapter>>)[channel as string]

  // 5. adapter.send 在 try/catch 内:任何异常收敛为 adapter_error,绝不外泄
  const fullPayload: SharePayload = { token, target: payload.target, body: payload.body }
  const sentAt = (deps.now ?? (() => new Date()))().toISOString()
  let result: ShareResult
  try {
    result = await adapter.send(fullPayload)
  } catch {
    return { delivered: false, reason: 'adapter_error' }
  }
  if (result.delivered) return { ...result, sent_at: result.sent_at ?? sentAt }
  return { delivered: false, reason: result.reason }
}