/**
 * Share token 签发/校验(issue #573,Phase C 切片)。
 *
 * HMAC-SHA256 over base64url(payload-json),签名为 base64url。
 * Token 形如 `${body}.${sig}`(body = base64url(JSON.stringify(payload)))。
 *
 * 设计要点:
 *   - 纯函数 + 时间注入(测试不依赖 wall clock);
 *   - payload 含 share_id / created_at(ISO)/ttl_seconds;校验时按 now + ttl 判定过期;
 *   - 校验使用 timingSafeEqual 防时序侧信道;
 *   - secret 默认从 `SHARE_HMAC_SECRET` env 取,缺省走 dev 占位常量(明示不安全,生产必须设);
 *   - 篡改/过期/格式错三类失败都走 ShareFailureReason 同一闭集,便于调用方分桶。
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

import type { ShareFailureReason } from './adapters.ts'

export interface ShareTokenPayload {
  share_id: string
  created_at: string
  ttl_seconds: number
}

export type ShareTokenVerifyResult =
  | { ok: true; payload: ShareTokenPayload }
  | { ok: false; reason: ShareFailureReason }

/** 显式 dev 默认 secret——生产环境必须由 `SHARE_HMAC_SECRET` env 覆盖,本模块不引入任何密钥管理 */
export const DEFAULT_DEV_SHARE_SECRET = 'gotry-share-dev-secret-DO-NOT-USE-IN-PROD'

/** 获取运行期 secret:env 优先,缺省走 dev 默认 */
export function resolveShareSecret(env: NodeJS.ProcessEnv = process.env): string {
  const s = env.SHARE_HMAC_SECRET
  return typeof s === 'string' && s.length > 0 ? s : DEFAULT_DEV_SHARE_SECRET
}

/** 签名:payload → base64url(JSON) + '.' + base64url(HMAC-SHA256(body, secret)) */
export function signShareToken(payload: ShareTokenPayload, secret: string = resolveShareSecret()): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url')
  const sig = createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${sig}`
}

/** 校验:解析 + HMAC 等值比较(timingSafeEqual)+ 过期检查 */
export function verifyShareToken(
  token: string,
  secret: string = resolveShareSecret(),
  now: () => Date = () => new Date(),
): ShareTokenVerifyResult {
  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: 'token_invalid' }
  const body = token.slice(0, dot)
  const sig = token.slice(dot + 1)

  // HMAC 等值比较(防时序侧信道)
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
    || typeof payload.ttl_seconds !== 'number' || !Number.isFinite(payload.ttl_seconds)) {
    return { ok: false, reason: 'token_invalid' }
  }

  // 过期检查
  const createdMs = Date.parse(payload.created_at)
  if (!Number.isFinite(createdMs)) return { ok: false, reason: 'token_invalid' }
  const expiresMs = createdMs + Math.max(0, payload.ttl_seconds) * 1000
  if (now().getTime() > expiresMs) return { ok: false, reason: 'token_expired' }

  return { ok: true, payload }
}