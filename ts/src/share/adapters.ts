/**
 * Share outbound adapter 契约层(issue #573,Phase C 切片;研究决策见
 * docs/research/karpo-deck-web-research.md 决策 §3 Phase C)。
 *
 * 设计契约:**所有 outbound 外发必经同意卡 + 签名 token**,且必经这个接口。
 * 4 个内置适配器(iMessage / SMS / Slack / webhook)只实现契约形状、**不接
 * 真实 SDK、不发网络**——统一返回 `{ delivered: false, reason: 'not_activated' }`,
 * 由 share-deck.ts 主流程在 M4 阶段才决定哪些 adapter 真正激活。
 *
 * 三条硬纪律(继承自单页入口 + deck 入口):
 *   1. payload 是**显式结构**(share_id/created_at/ttl_seconds/target/body)——调用方
 *      不传 raw HTML,只传路径(产物可被 list/read 单独审计);
 *   2. token 校验由 share-deck 在选 adapter 之前完成——未通过 token 校验的 adapter.send
 *      永远不会被调用;
 *   3. adapter.send 返回 `delivered:false` 也算合法完成(契约不强制网络);不抛错,
 *      调用方据此决定 UI 反馈与重试策略。
 */

export type ShareChannel = 'imessage' | 'sms' | 'slack' | 'webhook'

export interface SharePayload {
  /** 签名后的 share token(由 share-token.ts 签发) */
  token: string
  /** 通道与地址(channel 与 adapter 表一对一;address 含义由各 adapter 解释) */
  target: { channel: ShareChannel; address: string }
  /** 产物引用——adapter 据此拿到 deck / manifest / qr 的实际路径 */
  body: { html_path?: string; manifest_path?: string; qr_path?: string; note?: string }
}

/** 失败原因闭集——任何 adapter / share-deck 返回的拒绝都必须落进这个集合(便于 UI 与
 * 审计分桶);扩展前先 review(扩展 = 增加通道语义;不是字符串自由枚举) */
export type ShareFailureReason =
  | 'not_activated'         // adapter 存在但未激活(M4 才接)
  | 'unknown_channel'        // target.channel 不在 ADAPTERS 表内
  | 'consent_required'       // consent state = 'ask' 但未发卡
  | 'consent_revoked'        // consent 曾被拒绝/撤回
  | 'share_consent_off'      // 总开关关
  | 'token_invalid'          // token 签名/tampered
  | 'token_expired'          // token 过了 ttl

export type ShareResult =
  | { delivered: true; adapter_id: ShareChannel; sent_at: string }
  | { delivered: false; reason: ShareFailureReason }

export interface ShareAdapter {
  readonly id: ShareChannel
  send(payload: SharePayload): Promise<ShareResult>
}

// ---- 4 个 stub 适配器(issue #573 Phase C):契约形状 + no-op;不接 SDK、不发网络 ----

export const iMessageAdapter: ShareAdapter = {
  id: 'imessage',
  send: async () => ({ delivered: false, reason: 'not_activated' as const }),
}

export const smsAdapter: ShareAdapter = {
  id: 'sms',
  send: async () => ({ delivered: false, reason: 'not_activated' as const }),
}

export const slackAdapter: ShareAdapter = {
  id: 'slack',
  send: async () => ({ delivered: false, reason: 'not_activated' as const }),
}

export const webhookAdapter: ShareAdapter = {
  id: 'webhook',
  send: async () => ({ delivered: false, reason: 'not_activated' as const }),
}

/** 通道 → adapter 表(主流程 share-deck 用此表分发;扩通道须同时扩这个表与 ShareChannel 联合) */
export const ADAPTERS: Readonly<Record<ShareChannel, ShareAdapter>> = {
  imessage: iMessageAdapter,
  sms: smsAdapter,
  slack: slackAdapter,
  webhook: webhookAdapter,
}

export const SHARE_CHANNELS: readonly ShareChannel[] = ['imessage', 'sms', 'slack', 'webhook'] as const