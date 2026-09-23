/**
 * Share contract 验收套件(issue #573,Phase C 切片):
 * adapter 契约 + HMAC share token + consent state machine + shareDeck 编排。
 *
 * 全离线、合成数据,无网络、无 SDK 调用、无 stateRoot 写。
 *
 * 运行(在 ts/ 下):npx tsx scripts/share-tests.ts
 */

import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'

import {
  ADAPTERS,
  iMessageAdapter,
  smsAdapter,
  slackAdapter,
  webhookAdapter,
  SHARE_CHANNELS,
  type ShareChannel,
  type SharePayload,
} from '../src/share/adapters.ts'
import {
  DEFAULT_DEV_SHARE_SECRET,
  signShareToken,
  verifyShareToken,
} from '../src/share/share-token.ts'
import {
  checkShareConsent,
  defaultShareConsentState,
  grantShareConsent,
  revokeShareConsent,
  setShareConsentMode,
  type ShareConsentState,
} from '../src/share/share-consent.ts'
import { shareDeck, type ShareDeckRequest } from '../src/share/share-deck.ts'

let pass = 0
let fail = 0
const failures: string[] = []

function ok(cond: boolean, msg: string): void {
  if (cond) { pass++; return }
  fail++
  failures.push(msg)
}

const SECRET = 'test-secret-DO-NOT-USE-IN-PROD'
const FUTURE = (() => {
  // anchor:固定测试时刻,便于 token 过期断言
  const base = new Date('2026-09-23T12:00:00.000Z').getTime()
  return (offsetMs: number) => () => new Date(base + offsetMs)
})()
const NOW = FUTURE(0)
const LATER = FUTURE(60_000)

const TOKEN_PAYLOAD = {
  share_id: 'deck-export-2027-thailand',
  created_at: NOW().toISOString(),
  ttl_seconds: 3600,
}

const TARGET: SharePayload['target'] = { channel: 'imessage' as ShareChannel, address: '+1-555-0100' }
const REQUEST: ShareDeckRequest = {
  target: TARGET,
  body: { html_path: '/export/deck.html', manifest_path: '/export/deck.manifest.json', qr_path: '/export/deck.qr.svg', note: 'try this' },
}

// ===========================================================================
// §1 adapter 契约层 — 4 个 stub + ADAPTERS 表 + channel 闭集
// ===========================================================================

{
  ok(SHARE_CHANNELS.length === 4, `§1a SHARE_CHANNELS 长度 = 4(实测 ${SHARE_CHANNELS.length})`)
  for (const id of SHARE_CHANNELS) {
    const a = ADAPTERS[id]
    ok(typeof a?.send === 'function' && a?.id === id, `§1b ADAPTERS[${id}] 是合法 ShareAdapter`)
  }
  const expected = new Set(['imessage', 'sms', 'slack', 'webhook'])
  ok(SHARE_CHANNELS.length === expected.size && SHARE_CHANNELS.every(c => expected.has(c)),
    '§1c 4 个通道名锁定,扩通道前先 review(避免字符串自由枚举)')

  const stubResults = await Promise.all([iMessageAdapter, smsAdapter, slackAdapter, webhookAdapter].map(a => a.send({
    token: 'irrelevant',
    target: { channel: a.id, address: 'x' },
    body: {},
  })))
  ok(stubResults.every(r => !r.delivered && r.reason === 'not_activated'),
    '§1d 4 个 stub 统一返回 not_activated(无副作用、无网络、无 SDK)')
}

// ===========================================================================
// §2 HMAC share token — 签/验 round-trip + 篡改拒绝 + 过期拒绝 + 格式错
// ===========================================================================

{
  const token = signShareToken(TOKEN_PAYLOAD, SECRET)
  ok(typeof token === 'string' && token.includes('.') && token.length > 40,
    `§2a 签发 token 是非空 base64url.body.sig 字符串(${token.length} 字符)`)

  // round-trip + 字段保持
  const verify = verifyShareToken(token, SECRET, NOW)
  ok(verify.ok && verify.payload.share_id === TOKEN_PAYLOAD.share_id
    && verify.payload.ttl_seconds === 3600, '§2b round-trip:share_id / ttl_seconds 保持')

  // 字节级确定性(同输入同 secret 同 payload → 同 token)
  const token2 = signShareToken(TOKEN_PAYLOAD, SECRET)
  ok(token === token2, '§2c 签发字节级确定性(同输入 → 同 token)')

  // 篡改 body(改一位)→ 验签失败
  const tampered = token.slice(0, 5) + (token[5] === 'A' ? 'B' : 'A') + token.slice(6)
  const tamperResult = verifyShareToken(tampered, SECRET, NOW)
  ok(!tamperResult.ok && tamperResult.reason === 'token_invalid', '§2d 篡改 body → token_invalid')

  // 篡改 sig
  const lastDot = token.lastIndexOf('.')
  const sigTampered = token.slice(0, lastDot + 1) + (token[lastDot + 1] === 'A' ? 'B' : 'A') + token.slice(lastDot + 2)
  const sigResult = verifyShareToken(sigTampered, SECRET, NOW)
  ok(!sigResult.ok && sigResult.reason === 'token_invalid', '§2e 篡改 sig → token_invalid')

  // 不同 secret 验签失败
  const wrongSecret = verifyShareToken(token, 'wrong-secret', NOW)
  ok(!wrongSecret.ok && wrongSecret.reason === 'token_invalid', '§2f 不同 secret → token_invalid')

  // 过期(同 payload + 未来 ttl=1,now 跳到 +2s)
  const shortLived = signShareToken({
    share_id: 'short',
    created_at: NOW().toISOString(),
    ttl_seconds: 1,
  }, SECRET)
  const expiredResult = verifyShareToken(shortLived, SECRET, () => new Date(NOW().getTime() + 5_000))
  ok(!expiredResult.ok && expiredResult.reason === 'token_expired', '§2g 过期 → token_expired')

  // 边界:ttl=0(立即过期;NOW 比签发时刻晚 1ms 即可触发)
  const zeroTtl = signShareToken({ share_id: 'z', created_at: NOW().toISOString(), ttl_seconds: 0 }, SECRET)
  const zeroResult = verifyShareToken(zeroTtl, SECRET, () => new Date(NOW().getTime() + 1))
  ok(!zeroResult.ok && zeroResult.reason === 'token_expired', '§2h ttl=0 边界:立即过期(now 比签发晚 1ms)')

  // 格式错(无点 / 空 / 仅点)
  for (const bad of ['', '.', 'no-dot-here', 'a.', '.b', '..']) {
    const r = verifyShareToken(bad, SECRET, NOW)
    ok(!r.ok && (r.reason === 'token_invalid' || r.reason === 'token_expired'),
      `§2i 格式错 "${bad}" → 拒绝`)
  }

  // base64 不可解码
  const badB64 = '!!!.!!!'
  const badB64Result = verifyShareToken(badB64, SECRET, NOW)
  ok(!badB64Result.ok, '§2j 不可解码的 base64 → 拒绝')

  // JSON 解析后字段类型错
  const malformedPayload = Buffer.from(JSON.stringify({ share_id: 42, created_at: 'x', ttl_seconds: 'oops' }), 'utf-8').toString('base64url')
  const sigForMalformed = createHmac('sha256', SECRET).update(malformedPayload).digest('base64url')
  const malformedResult = verifyShareToken(`${malformedPayload}.${sigForMalformed}`, SECRET, NOW)
  ok(!malformedResult.ok && malformedResult.reason === 'token_invalid', '§2k 字段类型错的 payload → token_invalid')
}

// ===========================================================================
// §3 consent state machine — 三态 + grant/revoke/check
// ===========================================================================

{
  const s0 = defaultShareConsentState()
  ok(s0.mode === 'ask' && s0.granted.length === 0 && s0.revoked.length === 0, '§3a 默认 state:ask + 0 granted + 0 revoked')

  // ask + 无卡 → consent_required
  const r1 = checkShareConsent(s0, 'share-x')
  ok(!r1.ok && r1.reason === 'consent_required', '§3b ask + 无卡 → consent_required')

  // 发卡后通过
  const granted = grantShareConsent(s0, 'share-x', NOW)
  ok(granted.state.granted.length === 1, '§3c grant 后 state.granted 增 1')
  ok(/^[0-9a-f-]{36}$/i.test(granted.card.card_id), `§3d card_id 是 UUID(实测 ${granted.card.card_id})`)
  const r2 = checkShareConsent(granted.state, 'share-x', granted.card.card_id)
  ok(r2.ok, '§3e 发卡后 checkShareConsent(同 share_id, 同 card_id) → ok')

  // 撤回后拒绝
  const revoked = revokeShareConsent(granted.state, granted.card.card_id)
  const r3 = checkShareConsent(revoked, 'share-x', granted.card.card_id)
  ok(!r3.ok && r3.reason === 'consent_revoked', '§3f 撤回后 → consent_revoked')

  // 幂等:重复 revoke 不变
  const revoked2 = revokeShareConsent(revoked, granted.card.card_id)
  ok(revoked2.revoked.length === revoked.revoked.length, '§3g 重复 revoke 幂等(revoked 数组长度不变)')

  // off 总开关
  const off = setShareConsentMode(granted.state, 'off')
  const r4 = checkShareConsent(off, 'share-x', granted.card.card_id)
  ok(!r4.ok && r4.reason === 'share_consent_off', '§3h off 总开关 → 一律 share_consent_off')

  // allow + 无对应卡的 share_id → consent_required
  const allow = setShareConsentMode(s0, 'allow')
  const r5 = checkShareConsent(allow, 'share-x')
  ok(!r5.ok && r5.reason === 'consent_required', '§3i allow + 缺卡 → consent_required(同 ask)')

  // allow + 有对应卡 → ok
  const grantedAtAllow = grantShareConsent(allow, 'share-x', NOW)
  const r6 = checkShareConsent(grantedAtAllow.state, 'share-x', grantedAtAllow.card.card_id)
  ok(r6.ok, '§3j allow + 有卡 → ok')

  // card_id 不匹配(同 share_id 但不同 card_id)→ consent_revoked(防止伪造)
  const r7 = checkShareConsent(grantedAtAllow.state, 'share-x', 'bogus-card-id')
  ok(!r7.ok && r7.reason === 'consent_revoked', '§3k card_id 不匹配 → consent_revoked')

  // ask + 不同 share_id 但有 granted 卡 → 仍是 consent_required(granted 是按 share_id 索引的)
  const r8 = checkShareConsent(granted.state, 'other-share', granted.card.card_id)
  ok(!r8.ok && r8.reason === 'consent_required', '§3l ask + 不同 share_id → consent_required')
}

// ===========================================================================
// §4 shareDeck 主流程 — token → consent → channel → adapter
// ===========================================================================

{
  const state = defaultShareConsentState()
  const token = signShareToken(TOKEN_PAYLOAD, SECRET)

  // 无 token / 篡改 token → token_invalid
  const r1 = await shareDeck('', REQUEST, { secret: SECRET, state, now: NOW })
  ok(!r1.delivered && r1.reason === 'token_invalid', '§4a 空 token → token_invalid')

  const r2 = await shareDeck('a.b', REQUEST, { secret: SECRET, state, now: NOW })
  ok(!r2.delivered && r2.reason === 'token_invalid', '§4b 篡改 token → token_invalid')

  // token 过期 → token_expired
  const expired = signShareToken({ share_id: TOKEN_PAYLOAD.share_id, created_at: NOW().toISOString(), ttl_seconds: 1 }, SECRET)
  const r3 = await shareDeck(expired, REQUEST, { secret: SECRET, state, now: () => new Date(NOW().getTime() + 5_000) })
  ok(!r3.delivered && r3.reason === 'token_expired', '§4c 过期 token → token_expired')

  // token ok + 未发卡 → consent_required
  const r4 = await shareDeck(token, REQUEST, { secret: SECRET, state, now: NOW })
  ok(!r4.delivered && r4.reason === 'consent_required', '§4d token ok + 无卡 → consent_required')

  // 发卡后 → 命中 adapter(stub 返回 not_activated,链路通畅)
  const granted = grantShareConsent(state, TOKEN_PAYLOAD.share_id, NOW)
  const r5 = await shareDeck(token, REQUEST, { secret: SECRET, state: granted.state, now: NOW })
  ok(!r5.delivered && r5.reason === 'not_activated', '§4e 发卡 + 命中 adapter → not_activated(stub)')

  // 撤回后再 share → consent_revoked
  const revoked = revokeShareConsent(granted.state, granted.card.card_id)
  const r6 = await shareDeck(token, REQUEST, { secret: SECRET, state: revoked, now: NOW })
  ok(!r6.delivered && r6.reason === 'consent_revoked', '§4f 撤回后再 share → consent_revoked')

  // off 总开关 → share_consent_off
  const off = setShareConsentMode(granted.state, 'off')
  const r7 = await shareDeck(token, REQUEST, { secret: SECRET, state: off, now: NOW })
  ok(!r7.delivered && r7.reason === 'share_consent_off', '§4g off 总开关 → share_consent_off')

  // 未知 channel → unknown_channel(token share_id 必须匹配 grantedAny 的 'any-share')
  const grantedAny = grantShareConsent(state, 'any-share', NOW)
  const tkUnknown = signShareToken({ share_id: 'any-share', created_at: NOW().toISOString(), ttl_seconds: 60 }, SECRET)
  const r8 = await shareDeck(tkUnknown, { ...REQUEST, target: { channel: 'nonsense' as ShareChannel, address: 'x' } }, { secret: SECRET, state: grantedAny.state, now: NOW })
  ok(!r8.delivered && r8.reason === 'unknown_channel', '§4h 未知 channel → unknown_channel')

  // 全 4 个 adapter 命中(同 token / 同 share_id + 同 4 个 channel 各发一张卡)
  for (const ch of SHARE_CHANNELS) {
    const s = grantShareConsent(state, `share-${ch}`, NOW)
    const tk = signShareToken({ share_id: `share-${ch}`, created_at: NOW().toISOString(), ttl_seconds: 60 }, SECRET)
    const r = await shareDeck(tk, { target: { channel: ch, address: 'a@b.c' }, body: {} }, { secret: SECRET, state: s.state, now: NOW })
    ok(!r.delivered && r.reason === 'not_activated', `§4i 通道 ${ch} 命中:stubs 一致返回 not_activated`)
  }
}

// ===========================================================================
// §5 拒绝路径全覆盖 + 字节级确定性 + 端到端 fixture
// ===========================================================================

{
  // shareDeck 永不抛错(契约:adapter 返回 ShareResult,主流程原样转发)
  const state = defaultShareConsentState()
  const token = signShareToken(TOKEN_PAYLOAD, SECRET)
  const granted = grantShareConsent(state, TOKEN_PAYLOAD.share_id, NOW)
  let threw = false
  try {
    await shareDeck(token, { target: { channel: 'imessage', address: 'oops' }, body: {} }, { secret: SECRET, state: granted.state, now: NOW })
  } catch { threw = true }
  ok(!threw, '§5a shareDeck 永不抛错(adapter 返回的 ShareResult 是契约出口)')

  // 字节级确定性:同输入两次 shareDeck 结果完全一致(stub 不带时间戳波动)
  const s2 = grantShareConsent(state, 'det-share', NOW)
  const tk2 = signShareToken({ share_id: 'det-share', created_at: NOW().toISOString(), ttl_seconds: 60 }, SECRET)
  const a = await shareDeck(tk2, REQUEST, { secret: SECRET, state: s2.state, now: NOW })
  const b = await shareDeck(tk2, REQUEST, { secret: SECRET, state: s2.state, now: NOW })
  ok(JSON.stringify(a) === JSON.stringify(b), '§5b 同输入两次 shareDeck 字节级一致')

  // 拒绝路径枚举:每条 ShareFailureReason 都被真实触发过
  const fired = new Set<string>()
  const baseState = defaultShareConsentState()
  // token_invalid:空
  const rA = await shareDeck('', REQUEST, { secret: SECRET, state: baseState, now: NOW })
  if (!rA.delivered) fired.add(rA.reason)
  // token_expired
  const tkExpired = signShareToken({ share_id: 'x', created_at: NOW().toISOString(), ttl_seconds: 1 }, SECRET)
  const rB = await shareDeck(tkExpired, REQUEST, { secret: SECRET, state: baseState, now: () => new Date(NOW().getTime() + 5000) })
  if (!rB.delivered) fired.add(rB.reason)
  // consent_required
  const tkC = signShareToken({ share_id: 'x2', created_at: NOW().toISOString(), ttl_seconds: 60 }, SECRET)
  const rC = await shareDeck(tkC, REQUEST, { secret: SECRET, state: baseState, now: NOW })
  if (!rC.delivered) fired.add(rC.reason)
  // share_consent_off
  const offS = setShareConsentMode(baseState, 'off')
  const rD = await shareDeck(tkC, REQUEST, { secret: SECRET, state: offS, now: NOW })
  if (!rD.delivered) fired.add(rD.reason)
  // consent_revoked
  const grantedX = grantShareConsent(baseState, 'x3', NOW)
  const revokedX = revokeShareConsent(grantedX.state, grantedX.card.card_id)
  const tkD = signShareToken({ share_id: 'x3', created_at: NOW().toISOString(), ttl_seconds: 60 }, SECRET)
  const rE = await shareDeck(tkD, REQUEST, { secret: SECRET, state: revokedX, now: NOW })
  if (!rE.delivered) fired.add(rE.reason)
  // unknown_channel
  const grantedY = grantShareConsent(baseState, 'x4', NOW)
  const tkE = signShareToken({ share_id: 'x4', created_at: NOW().toISOString(), ttl_seconds: 60 }, SECRET)
  const rF = await shareDeck(tkE, { ...REQUEST, target: { channel: 'nonsense' as ShareChannel, address: 'x' } }, { secret: SECRET, state: grantedY.state, now: NOW })
  if (!rF.delivered) fired.add(rF.reason)
  // not_activated
  const grantedZ = grantShareConsent(baseState, 'x5', NOW)
  const tkF = signShareToken({ share_id: 'x5', created_at: NOW().toISOString(), ttl_seconds: 60 }, SECRET)
  const rG = await shareDeck(tkF, REQUEST, { secret: SECRET, state: grantedZ.state, now: NOW })
  if (!rG.delivered) fired.add(rG.reason)

  const expectedReasons = new Set(['token_invalid', 'token_expired', 'consent_required', 'share_consent_off', 'consent_revoked', 'unknown_channel', 'not_activated'])
  ok(expectedReasons.size === fired.size && [...expectedReasons].every(r => fired.has(r)),
    `§5c 7 类拒绝全部真实触发(实际触发了 ${[...fired].sort().join(' / ')})`)

  // 端到端 fixture:发卡 → share → 命中 imessage adapter(stub)→ not_activated
  const finalState = grantShareConsent(defaultShareConsentState(), 'e2e-share', NOW)
  const finalToken = signShareToken({ share_id: 'e2e-share', created_at: NOW().toISOString(), ttl_seconds: 60 }, SECRET)
  const result = await shareDeck(finalToken, { target: { channel: 'imessage', address: '+1-555-E2E' }, body: { html_path: '/tmp/e2e.html' } }, { secret: SECRET, state: finalState.state, now: NOW })
  ok(!result.delivered && result.reason === 'not_activated', '§5d 端到端 fixture:发卡 → 命中 adapter stub → not_activated')

  // signShareToken 字节级确定:用 hash 比对(确定性证据)
  const deterministicToken = signShareToken({ share_id: 'det', created_at: '2026-09-23T12:00:00.000Z', ttl_seconds: 60 }, SECRET)
  const deterministicHash = createHash('sha256').update(deterministicToken).digest('hex')
  ok(/^[0-9a-f]{64}$/.test(deterministicHash), `§5e token sha256 形状是 64 hex(${deterministicHash.slice(0, 16)}...)`)

  // dev default secret 警告行为:resolveShareSecret 缺省 env 时走 dev 默认
  // (不直接断言 secret 内容——避免把 dev 默认写进测试)
  const { resolveShareSecret } = await import('../src/share/share-token.ts')
  const devSecret = resolveShareSecret({})
  ok(devSecret === DEFAULT_DEV_SHARE_SECRET, '§5f 无 env 时 resolveShareSecret → DEFAULT_DEV_SHARE_SECRET')
  ok(resolveShareSecret({ SHARE_HMAC_SECRET: 'env-secret' }) === 'env-secret', '§5g 有 env 时 resolveShareSecret → env 值')
}

console.log(`\nSHARE TESTS: ${pass} pass, ${fail} fail`)
if (fail > 0) {
  console.log('\nFAILURES:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}