/**
 * Share token 签发/校验(issue #573,Phase C 切片;自检 review 修复见 PR #574)。
 *
 * HMAC-SHA256 over base64url(payload-json),签名为 base64url。
 * Token 形如 `${body}.${sig}`(body = base64url(JSON.stringify(payload)))。
 *
 * 设计要点:
 *   - 纯函数 + 时间注入(测试不依赖 wall clock);
 *   - payload 绑定 share_id / created_at(ISO)/ ttl_seconds / **target(channel+address)**——
 *     目的地进签名,防止「合法 token 换个收件人重放」(自检 review 发现的绑定缺口);
 *   - 格式契约**恰一个点**:`indexOf === lastIndexOf('.')`,多点/尾随垃圾拒绝;
 *   - ttl 契约:非负整数、上限 2^31-1 秒(防 expiresMs 溢出 Infinity 永不过期);
 *   - 校验使用 timingSafeEqual(先长度比对)防时序侧信道;
 *   - secret 默认从 `SHARE_HMAC_SECRET` env 取;缺省且 NODE_ENV=production 时
 *     **fail-closed 抛错**(绝不静默用仓库里公开的 dev 常量签生产 token);
 *   - 篡改/过期/格式错三类失败都走 ShareFailureReason 同一闭集。
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

import type { ShareChannel, ShareFailureReason } from './adapters.ts'

export interface ShareTokenTarget {
  channel: ShareChannel
  address: string
}

export interface ShareTokenPayload {
  share_id: string
  created_at: string
  ttl_seconds: number
  /** 目的地绑定:token 只对签发时的 target 有效,换收件人即 token_invalid */
  target: ShareTokenTarget
}

export type ShareTokenVerifyResult =
  | { ok: true; payload: ShareTokenPayload }
  | { ok: false; reason: ShareFailureReason }

/** 显式 dev 默认 secret——生产环境必须由 `SHARE_HMAC_SECRET` env 覆盖 */
export const DEFAULT_DEV_SHARE_SECRET = 'gotry-share-dev-secret-DO-NOT-USE-IN-PROD'

/** ttl 上界(秒):2^31-1,防 created_at + ttl*1000 溢出 Number 上限 */
export const SHARE_TOKEN_TTL_MAX_SECONDS = 2_147_483_647

/** 获取运行期 secret:env 优先;production 缺 env 时 fail-closed(dev 常量签生产 token = 任何人可伪造) */
export function resolveShareSecret(env: NodeJS.ProcessEnv = process.env): string {
  const s = env.SHARE_HMAC_SECRET
  if (typeof s === 'string' && s.length > 0) return s
  if (env.NODE_ENV === 'production') {
    throw new Error('SHARE_HMAC_SECRET 未设置且 NODE_ENV=production:拒绝回落公开的 dev 默认 secret(fail-closed;任何读到仓库的人都能伪造 token)')
  }
  return DEFAULT_DEV_SHARE_SECRET
}

/** 签名:payload → base64url(JSON) + '.' + base64url(HMAC-SHA256(body, secret)) */
export function signShareToken(payload: ShareTokenPayload, secret: string = resolveShareSecret()): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url')
  const sig = createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${sig}`
}

function isTokenTarget(value: unknown): value is ShareTokenTarget {
  if (typeof value !== 'object' || value === null) return false
  const t = value as Record<string, unknown>
  return typeof t.channel === 'string' && t.channel.length > 0
    && typeof t.address === 'string'
}

/** 校验:格式(恰一个点)→ HMAC 等值(timingSafeEqual)→ payload 形态 → 过期 */
export function verifyShareToken(
  token: string,
  secret: string = resolveShareSecret(),
  now: () => Date = () => new Date(),
): ShareTokenVerifyResult {
  if (typeof token !== 'string' || token.length === 0) return { ok: false, reason: 'token_invalid' }
  const dot = token.indexOf('.')
  // 恰一个点:多点(base64url 解码器会静默吞非法字符)与无点都拒绝
  if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: 'token_invalid' }
  if (token.indexOf('.', dot + 1) !== -1) return { ok: false, reason: 'token_invalid' }
  const body = token.slice(0, dot)
  const sig = token.slice(dot + 1)

  // HMAC 等值比较(先长度,再 timingSafeEqual;Buffer-vs-Buffer)
  const expected = createHmac('sha256', secret).update(body).digest()
  let actual: Buffer
  try {
    actual = Buffer.from(sig, 'base64url')
  } catch {
    return { ok: false, reason: 'token_invalid' }
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { ok: false, reason: 'token_invalid' }
  }

  // 解析 payload
  let payload: ShareTokenPayload
  try {
    const json = Buffer.from(body, 'base64url').toString('utf-8')
    payload = JSON.parse(json)
  } catch {
    return { ok: false, reason: 'token_invalid' }
  }
  if (typeof payload !== 'object' || payload === null
    || typeof payload.share_id !== 'string' || payload.share_id.length === 0
    || typeof payload.created_at !== 'string' || payload.created_at.length === 0
    || !isTokenTarget(payload.target)) {
    return { ok: false, reason: 'token_invalid' }
  }
  // ttl:非负整数且不溢出(防 created_at + ttl*1000 = Infinity 永不过期)
  if (typeof payload.ttl_seconds !== 'number'
    || !Number.isInteger(payload.ttl_seconds)
    || payload.ttl_seconds < 0
    || payload.ttl_seconds > SHARE_TOKEN_TTL_MAX_SECONDS) {
    return { ok: false, reason: 'token_invalid' }
  }

  // 过期检查
  const createdMs = Date.parse(payload.created_at)
  if (!Number.isFinite(createdMs)) return { ok: false, reason: 'token_invalid' }
  const expiresMs = createdMs + payload.ttl_seconds * 1000
  if (!Number.isFinite(expiresMs)) return { ok: false, reason: 'token_invalid' }
  if (now().getTime() > expiresMs) return { ok: false, reason: 'token_expired' }

  return { ok: true, payload }
}

/** target 绑定比对:token payload 的 target 必须与请求的 target 完全一致(通道+地址逐字段) */
export function tokenTargetMatches(payload: ShareTokenPayload, target: { channel: unknown; address: unknown }): boolean {
  return payload.target.channel === target.channel && payload.target.address === target.address
}