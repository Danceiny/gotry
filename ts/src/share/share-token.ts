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
 *     **fail-closed**(绝不静默用仓库里公开的 dev 常量签生产 token)——刻意抛错
 *     保留在签发面(resolve/sign);verify 面把同样的配置错误收敛为 `token_invalid`,
 *     非字符串运行期键(数字/对象/Symbol 等 JS 畸形输入)同样收敛,HMAC 计算
 *     本身也在守卫内——任何调用方/配置输入都无法越出「永不抛错」的校验边界;
 *   - 注入时钟本身失效(getTime 非有限值或回调抛错)→ fail-closed `token_invalid`:
 *     `NaN > expiresMs` 恒 false,曾把过期 token 静默判成有效——无效时间上
 *     不产生任何接受;
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

/** 校验:secret 解析(守卫体)→ 格式(恰一个点)→ HMAC 等值(timingSafeEqual)
 *  → payload 形态 → 过期(注入时钟失效 = token_invalid)。**永不抛错**:
 *  production 缺 env secret 与失效时钟都是操作面错误,收敛进 token_invalid,
 *  刻意的配置/签发异常只保留在 resolve/sign 侧。 */
export function verifyShareToken(
  token: string,
  secret?: string,
  now: () => Date = () => new Date(),
): ShareTokenVerifyResult {
  // 运行期 secret 解析放进守卫体:production 缺 env 的配置错在验证面 fail-closed
  // 为 token_invalid,不抛错(若静默回落公开 dev 常量,伪造 token 将被放行);
  // 非字符串运行期键(数字/对象/Symbol 等 JS 畸形调用方输入)同样收敛
  // token_invalid——createHmac 对它们会抛 TypeError,绝不让异常越出本函数
  let hmacSecret: string
  try {
    const resolved = secret === undefined ? resolveShareSecret() : secret
    if (typeof resolved !== 'string') return { ok: false, reason: 'token_invalid' }
    hmacSecret = resolved
  } catch {
    return { ok: false, reason: 'token_invalid' }
  }
  if (typeof token !== 'string' || token.length === 0) return { ok: false, reason: 'token_invalid' }
  const dot = token.indexOf('.')
  // 恰一个点:多点(base64url 解码器会静默吞非法字符)与无点都拒绝
  if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: 'token_invalid' }
  if (token.indexOf('.', dot + 1) !== -1) return { ok: false, reason: 'token_invalid' }
  const body = token.slice(0, dot)
  const sig = token.slice(dot + 1)

  // HMAC 等值比较(先长度,再 timingSafeEqual;Buffer-vs-Buffer);加密计算
  // 本身也在守卫内——任何运行期键异常收敛 token_invalid,绝不外泄异常
  let expected: Buffer
  try {
    expected = createHmac('sha256', hmacSecret).update(body).digest()
  } catch {
    return { ok: false, reason: 'token_invalid' }
  }
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

  // 过期检查:注入时钟失效(抛错/非有限值)fail-closed 为 token_invalid——
  // NaN 与 expiresMs 比较恒 false,失效时钟不得让任何 token 通过
  const createdMs = Date.parse(payload.created_at)
  if (!Number.isFinite(createdMs)) return { ok: false, reason: 'token_invalid' }
  const expiresMs = createdMs + payload.ttl_seconds * 1000
  if (!Number.isFinite(expiresMs)) return { ok: false, reason: 'token_invalid' }
  let nowMs: number
  try {
    nowMs = now().getTime()
  } catch {
    return { ok: false, reason: 'token_invalid' }
  }
  if (!Number.isFinite(nowMs)) return { ok: false, reason: 'token_invalid' }
  if (nowMs > expiresMs) return { ok: false, reason: 'token_expired' }

  return { ok: true, payload }
}

/** target 绑定比对:token payload 的 target 必须与请求的 target 完全一致(通道+地址逐字段) */
export function tokenTargetMatches(payload: ShareTokenPayload, target: { channel: unknown; address: unknown }): boolean {
  return payload.target.channel === target.channel && payload.target.address === target.address
}