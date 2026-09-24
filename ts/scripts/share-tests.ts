/**
 * Share contract 验收套件(issue #573,Phase C 切片;含 PR #574 自检 review 修复面):
 * adapter 契约 + HMAC share token(target 绑定)+ consent state machine(幂等 grant)
 * + shareDeck 编排(never-throws / 原型键防护 / adapter_error 收敛)。
 *
 * 全离线、合成数据,无网络、无 SDK 调用、无 stateRoot 写。
 *
 * 运行(在 ts/ 下):npx tsx scripts/share-tests.ts
 */

import { createHmac } from 'node:crypto'

import {
  ADAPTERS,
  SHARE_CHANNELS,
  iMessageAdapter,
  smsAdapter,
  slackAdapter,
  webhookAdapter,
  type ShareAdapter,
  type ShareChannel,
  type SharePayload,
} from '../src/share/adapters.ts'
import {
  DEFAULT_DEV_SHARE_SECRET,
  SHARE_TOKEN_TTL_MAX_SECONDS,
  resolveShareSecret,
  signShareToken,
  verifyShareToken,
} from '../src/share/share-token.ts'
import {
  checkShareConsent,
  defaultShareConsentState,
  grantShareConsent,
  revokeShareConsent,
  setShareConsentMode,
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
  const base = new Date('2026-09-23T12:00:00.000Z').getTime()
  return (offsetMs: number) => () => new Date(base + offsetMs)
})()
const NOW = FUTURE(0)

const TARGET: SharePayload['target'] = { channel: 'imessage' as ShareChannel, address: '+1-555-0100' }
const TOKEN_PAYLOAD = {
  share_id: 'deck-export-2027-thailand',
  created_at: NOW().toISOString(),
  ttl_seconds: 3600,
  target: TARGET,
}
const REQUEST: ShareDeckRequest = {
  target: TARGET,
  body: { html_path: '/export/deck.html', manifest_path: '/export/deck.manifest.json', qr_path: '/export/deck.qr.svg', note: 'try this' },
}

/** 便捷:按 share_id + 目标地址造 token(通道默认 imessage) */
function tk(share_id: string, target: { channel: ShareChannel; address: string } = TARGET, ttl = 3600): string {
  return signShareToken({ share_id, created_at: NOW().toISOString(), ttl_seconds: ttl, target }, SECRET)
}

// ===========================================================================
// §1 adapter 契约层 — 4 个 stub + ADAPTERS 表冻结 + channel 闭集派生
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

  // 闭集从 ADAPTERS 键派生(单一事实源):键与列表一一对应
  ok(JSON.stringify([...SHARE_CHANNELS].sort()) === JSON.stringify(Object.keys(ADAPTERS).sort()),
    '§1d SHARE_CHANNELS 与 ADAPTERS 键一一对应(派生,非手列)')

  // ADAPTERS 运行时冻结(ESM 严格模式下赋值冻结对象抛 TypeError)
  let froze = false
  try {
    ;(ADAPTERS as Record<string, ShareAdapter>).sms = iMessageAdapter
  } catch { froze = true }
  ok(froze && ADAPTERS.sms === smsAdapter, '§1e ADAPTERS 运行时冻结(改写抛错且原值不变)')

  const stubResults = await Promise.all([iMessageAdapter, smsAdapter, slackAdapter, webhookAdapter].map(a => a.send({
    token: 'irrelevant',
    target: { channel: a.id, address: 'x' },
    body: {},
  })))
  ok(stubResults.every(r => !r.delivered && r.reason === 'not_activated'),
    '§1f 4 个 stub 统一返回 not_activated(无副作用、无网络、无 SDK)')
}

// ===========================================================================
// §2 HMAC share token — 签/验 round-trip + 篡改 + 过期 + 格式闭契约
// ===========================================================================

{
  const token = signShareToken(TOKEN_PAYLOAD, SECRET)
  ok(typeof token === 'string' && token.includes('.') && token.length > 40,
    `§2a 签发 token 是非空 base64url.body.sig 字符串(${token.length} 字符)`)

  const verify = verifyShareToken(token, SECRET, NOW)
  ok(verify.ok && verify.payload.share_id === TOKEN_PAYLOAD.share_id
    && verify.payload.ttl_seconds === 3600
    && verify.ok && verify.payload.target.channel === 'imessage'
    && verify.payload.target.address === '+1-555-0100',
    '§2b round-trip:share_id / ttl / target(通道+地址)逐字段保持')

  const token2 = signShareToken(TOKEN_PAYLOAD, SECRET)
  ok(token === token2, '§2c 签发字节级确定性(同输入 → 同 token)')

  const tampered = token.slice(0, 5) + (token[5] === 'A' ? 'B' : 'A') + token.slice(6)
  const tamperResult = verifyShareToken(tampered, SECRET, NOW)
  ok(!tamperResult.ok && tamperResult.reason === 'token_invalid', '§2d 篡改 body → token_invalid')

  const lastDot = token.lastIndexOf('.')
  const sigTampered = token.slice(0, lastDot + 1) + (token[lastDot + 1] === 'A' ? 'B' : 'A') + token.slice(lastDot + 2)
  const sigResult = verifyShareToken(sigTampered, SECRET, NOW)
  ok(!sigResult.ok && sigResult.reason === 'token_invalid', '§2e 篡改 sig → token_invalid')

  const wrongSecret = verifyShareToken(token, 'wrong-secret', NOW)
  ok(!wrongSecret.ok && wrongSecret.reason === 'token_invalid', '§2f 不同 secret → token_invalid')

  const shortLived = signShareToken({ share_id: 'short', created_at: NOW().toISOString(), ttl_seconds: 1, target: TARGET }, SECRET)
  const expiredResult = verifyShareToken(shortLived, SECRET, () => new Date(NOW().getTime() + 5_000))
  ok(!expiredResult.ok && expiredResult.reason === 'token_expired', '§2g 过期 → token_expired')

  const zeroTtl = signShareToken({ share_id: 'z', created_at: NOW().toISOString(), ttl_seconds: 0, target: TARGET }, SECRET)
  const zeroResult = verifyShareToken(zeroTtl, SECRET, () => new Date(NOW().getTime() + 1))
  ok(!zeroResult.ok && zeroResult.reason === 'token_expired', '§2h ttl=0 边界:下一瞬即过期')

  // 格式错:全部必须精确返回 token_invalid(不是 token_expired——格式与过期的区分是文档契约)
  for (const bad of ['', '.', 'no-dot-here', 'a.', '.b', '..']) {
    const r = verifyShareToken(bad, SECRET, NOW)
    ok(!r.ok && r.reason === 'token_invalid', `§2i 格式错 ${JSON.stringify(bad)} → 精确 token_invalid`)
  }

  // 多点 token:合法 token + 尾随 '.xxx'(base64url 解码器会吞非法字符,必须显式拒)
  const multiDot = `${token}.garbage`
  const multiDotResult = verifyShareToken(multiDot, SECRET, NOW)
  ok(!multiDotResult.ok && multiDotResult.reason === 'token_invalid', '§2j 多点 token(尾随垃圾)→ token_invalid')

  // ttl 溢出/非整数:1e308 会让 expiresMs=Infinity 永不过期;1.5 非整数
  const overflowTtl = signShareToken({ share_id: 'ovf', created_at: NOW().toISOString(), ttl_seconds: 1e308, target: TARGET }, SECRET)
  ok(!verifyShareToken(overflowTtl, SECRET, NOW).ok, '§2k ttl=1e308(溢出 Infinity)→ token_invalid')
  const fracTtl = signShareToken({ share_id: 'frac', created_at: NOW().toISOString(), ttl_seconds: 1.5, target: TARGET }, SECRET)
  ok(!verifyShareToken(fracTtl, SECRET, NOW).ok, '§2l ttl=1.5(非整数)→ token_invalid')
  const maxTtl = signShareToken({ share_id: 'max', created_at: NOW().toISOString(), ttl_seconds: SHARE_TOKEN_TTL_MAX_SECONDS, target: TARGET }, SECRET)
  ok(verifyShareToken(maxTtl, SECRET, NOW).ok, `§2m ttl=2^31-1(上界内)合法`)

  // base64 不可解码
  const badB64 = '!!!.!!!'
  ok(!verifyShareToken(badB64, SECRET, NOW).ok, '§2n 不可解码的 base64 → 拒绝')

  // 字段类型错(含缺 target)
  const malformedPayload = Buffer.from(JSON.stringify({ share_id: 42, created_at: 'x', ttl_seconds: 'oops' }), 'utf-8').toString('base64url')
  const sigForMalformed = createHmac('sha256', SECRET).update(malformedPayload).digest('base64url')
  const malformedResult = verifyShareToken(`${malformedPayload}.${sigForMalformed}`, SECRET, NOW)
  ok(!malformedResult.ok && malformedResult.reason === 'token_invalid', '§2o 字段类型错(含缺 target)→ token_invalid')

  // 有 target 但字段类型错
  const badTarget = Buffer.from(JSON.stringify({ share_id: 'bt', created_at: NOW().toISOString(), ttl_seconds: 60, target: { channel: 42, address: [] } }), 'utf-8').toString('base64url')
  const sigBadTarget = createHmac('sha256', SECRET).update(badTarget).digest('base64url')
  ok(!verifyShareToken(`${badTarget}.${sigBadTarget}`, SECRET, NOW).ok, '§2p target 字段类型错 → token_invalid')
}

// ===========================================================================
// §3 consent state machine — 三态 + grant(幂等)/ revoke / check(按卡匹配)
// ===========================================================================

{
  const s0 = defaultShareConsentState()
  ok(s0.mode === 'ask' && s0.granted.length === 0 && s0.revoked.length === 0, '§3a 默认 state:ask + 0 granted + 0 revoked')

  const r1 = checkShareConsent(s0, 'share-x')
  ok(!r1.ok && r1.reason === 'consent_required', '§3b 无卡 → consent_required')

  const granted = grantShareConsent(s0, 'share-x', NOW)
  ok(granted.state.granted.length === 1, '§3c grant 后 state.granted 增 1')
  ok(/^[0-9a-f-]{36}$/i.test(granted.card.card_id), `§3d card_id 是 UUID(实测 ${granted.card.card_id})`)

  // 幂等:同 share 重复 grant 复用同一张卡(不追加)
  const grantedAgain = grantShareConsent(granted.state, 'share-x', NOW)
  ok(grantedAgain.state.granted.length === 1 && grantedAgain.card.card_id === granted.card.card_id,
    '§3e grant 幂等:同 share 重复 grant 复用存活卡(不追加,防多卡漂移)')

  const r2 = checkShareConsent(granted.state, 'share-x', granted.card.card_id)
  ok(r2.ok, '§3f 发卡后 checkShareConsent(同 share_id, 同 card_id) → ok')

  // 出示伪造卡 id(不属于该 share)→ consent_revoked
  const rForeign = checkShareConsent(granted.state, 'share-x', 'bogus-card-id')
  ok(!rForeign.ok && rForeign.reason === 'consent_revoked', '§3g 出示不属于该 share 的 card_id → consent_revoked')

  const revoked = revokeShareConsent(granted.state, granted.card.card_id)
  const r3 = checkShareConsent(revoked, 'share-x', granted.card.card_id)
  ok(!r3.ok && r3.reason === 'consent_revoked', '§3h 撤回后 → consent_revoked')

  const r3b = checkShareConsent(revoked, 'share-x')
  ok(!r3b.ok && r3b.reason === 'consent_revoked', '§3i 撤回后(不出示卡)→ consent_revoked(全撤即死)')

  const revoked2 = revokeShareConsent(revoked, granted.card.card_id)
  ok(revoked2.revoked.length === revoked.revoked.length, '§3j 重复 revoke 幂等')

  // 撤光后再 grant:发新卡且复活
  const reGranted = grantShareConsent(revoked, 'share-x', NOW)
  ok(reGranted.state.granted.length === 2 && reGranted.card.card_id !== granted.card.card_id,
    '§3k 全撤后重新 grant:追加新卡(旧卡仍 revoked,新卡存活)')

  const off = setShareConsentMode(granted.state, 'off')
  const r4 = checkShareConsent(off, 'share-x', granted.card.card_id)
  ok(!r4.ok && r4.reason === 'share_consent_off', '§3l off 总开关 → 一律 share_consent_off')

  const allow = setShareConsentMode(s0, 'allow')
  const r5 = checkShareConsent(allow, 'share-x')
  ok(!r5.ok && r5.reason === 'consent_required', '§3m allow + 缺卡 → consent_required(同 ask)')

  const grantedAtAllow = grantShareConsent(allow, 'share-x', NOW)
  const r6 = checkShareConsent(grantedAtAllow.state, 'share-x', grantedAtAllow.card.card_id)
  ok(r6.ok, '§3n allow + 有卡 → ok')

  const r8 = checkShareConsent(granted.state, 'other-share', granted.card.card_id)
  ok(!r8.ok && r8.reason === 'consent_required', '§3o 不同 share_id → consent_required(卡按 share 索引)')
}

// ===========================================================================
// §4 shareDeck 主流程 — token → target 绑定 → consent → channel → adapter
// ===========================================================================

{
  const state = defaultShareConsentState()
  const token = tk('deck-export-2027-thailand')

  const r1 = await shareDeck('', REQUEST, { secret: SECRET, state, now: NOW })
  ok(!r1.delivered && r1.reason === 'token_invalid', '§4a 空 token → token_invalid')

  const r2 = await shareDeck('a.b', REQUEST, { secret: SECRET, state, now: NOW })
  ok(!r2.delivered && r2.reason === 'token_invalid', '§4b 篡改 token → token_invalid')

  const expired = tk('deck-export-2027-thailand', TARGET, 1)
  const r3 = await shareDeck(expired, REQUEST, { secret: SECRET, state, now: () => new Date(NOW().getTime() + 5_000) })
  ok(!r3.delivered && r3.reason === 'token_expired', '§4c 过期 token → token_expired')

  // target 绑定:合法 token + 不同目的地(换收件人重放)→ token_invalid
  const swappedTarget = await shareDeck(token, { ...REQUEST, target: { channel: 'slack', address: 'other@x' } }, { secret: SECRET, state, now: NOW })
  ok(!swappedTarget.delivered && swappedTarget.reason === 'token_invalid', '§4d 合法 token 换收件人(channel+address 不符)→ token_invalid(防重放)')
  // 仅换地址同样拒
  const swappedAddr = await shareDeck(token, { ...REQUEST, target: { channel: 'imessage', address: '+1-999' } }, { secret: SECRET, state, now: NOW })
  ok(!swappedAddr.delivered && swappedAddr.reason === 'token_invalid', '§4e 合法 token 换地址 → token_invalid')

  const r4 = await shareDeck(token, REQUEST, { secret: SECRET, state, now: NOW })
  ok(!r4.delivered && r4.reason === 'consent_required', '§4f token ok + 无卡 → consent_required')

  const granted = grantShareConsent(state, 'deck-export-2027-thailand', NOW)
  const r5 = await shareDeck(token, REQUEST, { secret: SECRET, state: granted.state, now: NOW })
  ok(!r5.delivered && r5.reason === 'not_activated', '§4g 发卡 + 命中 adapter → not_activated(stub)')

  // deps.card_id 二次校验接通:出示错误卡 → consent_revoked
  const r5b = await shareDeck(token, REQUEST, { secret: SECRET, state: granted.state, now: NOW, card_id: 'bogus' })
  ok(!r5b.delivered && r5b.reason === 'consent_revoked', '§4h deps.card_id 出示错误卡 → consent_revoked(二次校验接通)')
  // 出示正确卡 → 通过(到 adapter)
  const r5c = await shareDeck(token, REQUEST, { secret: SECRET, state: granted.state, now: NOW, card_id: granted.card.card_id })
  ok(!r5c.delivered && r5c.reason === 'not_activated', '§4i deps.card_id 出示正确卡 → 通过到 adapter')

  const revoked = revokeShareConsent(granted.state, granted.card.card_id)
  const r6 = await shareDeck(token, REQUEST, { secret: SECRET, state: revoked, now: NOW })
  ok(!r6.delivered && r6.reason === 'consent_revoked', '§4j 撤回后再 share → consent_revoked')

  const off = setShareConsentMode(granted.state, 'off')
  const r7 = await shareDeck(token, REQUEST, { secret: SECRET, state: off, now: NOW })
  ok(!r7.delivered && r7.reason === 'share_consent_off', '§4k off 总开关 → share_consent_off')

  // 原型键通道:不崩溃,精确 unknown_channel
  for (const proto of ['__proto__', 'constructor', 'toString']) {
    const g = grantShareConsent(state, `proto-${proto}`, NOW)
    const t = tk(`proto-${proto}`, { channel: 'imessage', address: 'x' })
    // 用绑定 imessage 的 token 但请求 proto 通道会先被 target 绑定拦;直接构造请求 target=proto
    const req: ShareDeckRequest = { target: { channel: proto as ShareChannel, address: 'x' }, body: {} }
    // token 的 target 也要是 proto 才能走到分发——手工签一个
    const protoToken = signShareToken({ share_id: `proto-${proto}`, created_at: NOW().toISOString(), ttl_seconds: 60, target: { channel: proto as ShareChannel, address: 'x' } }, SECRET)
    let threw = false
    let result: { delivered?: boolean; reason?: string } = {}
    try {
      result = await shareDeck(protoToken, req, { secret: SECRET, state: g.state, now: NOW })
    } catch { threw = true }
    ok(!threw && !result.delivered && result.reason === 'unknown_channel',
      `§4l 原型键通道 ${proto} → 不崩溃,精确 unknown_channel`)
    void t
  }

  // 未知普通通道
  const grantedAny = grantShareConsent(state, 'any-share', NOW)
  const tkUnknown = tk('any-share', { channel: 'nonsense' as ShareChannel, address: 'x' })
  const r8 = await shareDeck(tkUnknown, { ...REQUEST, target: { channel: 'nonsense' as ShareChannel, address: 'x' } }, { secret: SECRET, state: grantedAny.state, now: NOW })
  ok(!r8.delivered && r8.reason === 'unknown_channel', '§4m 未知普通通道 → unknown_channel')

  // 全 4 通道命中
  for (const ch of SHARE_CHANNELS) {
    const s = grantShareConsent(state, `share-${ch}`, NOW)
    const t = tk(`share-${ch}`, { channel: ch, address: 'a@b.c' })
    const r = await shareDeck(t, { target: { channel: ch, address: 'a@b.c' }, body: {} }, { secret: SECRET, state: s.state, now: NOW })
    ok(!r.delivered && r.reason === 'not_activated', `§4n 通道 ${ch} 命中:stub 返回 not_activated`)
  }
}

// ===========================================================================
// §5 never-throws + 字节级确定性 + 8 类拒绝全覆盖
// ===========================================================================

{
  const state = defaultShareConsentState()
  const token = tk('deck-export-2027-thailand')
  const granted = grantShareConsent(state, 'deck-export-2027-thailand', NOW)
  let threw = false
  try {
    await shareDeck(token, { target: { channel: 'imessage', address: 'oops' }, body: {} }, { secret: SECRET, state: granted.state, now: NOW })
  } catch { threw = true }
  ok(!threw, '§5a shareDeck 永不抛错(stub 路径)')

  // adapter 抛错 → adapter_error 收敛(注入抛错适配器)
  const throwing: ShareAdapter = {
    id: 'imessage',
    send: async () => { throw new Error('SDK exploded') },
  }
  const rThrow = await shareDeck(token, REQUEST, {
    secret: SECRET,
    state: granted.state,
    now: NOW,
    adapters: { imessage: throwing, sms: smsAdapter, slack: slackAdapter, webhook: webhookAdapter },
  })
  ok(!rThrow.delivered && rThrow.reason === 'adapter_error', '§5b adapter 抛错 → 收敛为 adapter_error(不外泄异常)')

  // 畸形 consent state(granted 非数组)也不抛(纯函数路径稳健)
  let malformedThrew = false
  try {
    await shareDeck(token, REQUEST, { secret: SECRET, state: { mode: 'ask', granted: 'not-array' as unknown as never[], revoked: [] }, now: NOW })
  } catch { malformedThrew = true }
  ok(!malformedThrew, '§5c 畸形 consent state 不抛错(返回 ShareResult 而非异常)')

  // 字节级确定性
  const s2 = grantShareConsent(state, 'det-share', NOW)
  const tk2 = tk('det-share')
  const a = await shareDeck(tk2, REQUEST, { secret: SECRET, state: s2.state, now: NOW })
  const b = await shareDeck(tk2, REQUEST, { secret: SECRET, state: s2.state, now: NOW })
  ok(JSON.stringify(a) === JSON.stringify(b), '§5d 同输入两次 shareDeck 字节级一致')

  // 8 类拒绝全触发
  const fired = new Set<string>()
  const baseState = defaultShareConsentState()
  const track = (r: { delivered: boolean; reason?: string }) => { if (!r.delivered && r.reason) fired.add(r.reason) }
  track(await shareDeck('', REQUEST, { secret: SECRET, state: baseState, now: NOW }))
  track(await shareDeck(tk('x', TARGET, 1), REQUEST, { secret: SECRET, state: baseState, now: () => new Date(NOW().getTime() + 5000) }))
  track(await shareDeck(tk('x2'), REQUEST, { secret: SECRET, state: baseState, now: NOW }))
  track(await shareDeck(tk('x2'), REQUEST, { secret: SECRET, state: setShareConsentMode(baseState, 'off'), now: NOW }))
  const gx3 = grantShareConsent(baseState, 'x3', NOW)
  track(await shareDeck(tk('x3'), REQUEST, { secret: SECRET, state: revokeShareConsent(gx3.state, gx3.card.card_id), now: NOW }))
  const gx4 = grantShareConsent(baseState, 'x4', NOW)
  track(await shareDeck(tk('x4', { channel: 'nonsense' as ShareChannel, address: 'x' }), { target: { channel: 'nonsense' as ShareChannel, address: 'x' }, body: {} }, { secret: SECRET, state: gx4.state, now: NOW }))
  const gx5 = grantShareConsent(baseState, 'x5', NOW)
  track(await shareDeck(tk('x5'), REQUEST, { secret: SECRET, state: gx5.state, now: NOW }))
  track(await shareDeck(tk('deck-export-2027-thailand'), REQUEST, {
    secret: SECRET, state: granted.state, now: NOW,
    adapters: { imessage: throwing, sms: smsAdapter, slack: slackAdapter, webhook: webhookAdapter },
  }))

  const expectedReasons = new Set(['token_invalid', 'token_expired', 'consent_required', 'share_consent_off', 'consent_revoked', 'unknown_channel', 'not_activated', 'adapter_error'])
  ok(expectedReasons.size === fired.size && [...expectedReasons].every(r => fired.has(r)),
    `§5e 8 类拒绝全部真实触发(实际触发 ${[...fired].sort().join(' / ')})`)

  // token 签发确定性:重签同 payload+secret 得到逐字节相同 token(非空泛正则)
  const detTok = signShareToken({ share_id: 'det2', created_at: NOW().toISOString(), ttl_seconds: 60, target: TARGET }, SECRET)
  ok(detTok === signShareToken({ share_id: 'det2', created_at: NOW().toISOString(), ttl_seconds: 60, target: TARGET }, SECRET),
    '§5f 重签同 payload+secret → token 逐字节一致(真确定性)')

  // secret 解析:env / dev 默认 / production fail-closed
  ok(resolveShareSecret({ SHARE_HMAC_SECRET: 'env-secret' }) === 'env-secret', '§5g 有 env → env 值')
  ok(resolveShareSecret({}) === DEFAULT_DEV_SHARE_SECRET, '§5h 无 env(非 production)→ dev 默认')
  let prodThrew = false
  try {
    resolveShareSecret({ NODE_ENV: 'production' })
  } catch { prodThrew = true }
  ok(prodThrew, '§5i production 缺 SHARE_HMAC_SECRET → fail-closed 抛错(绝不静默用公开 dev 常量)')
}

console.log(`\nSHARE TESTS: ${pass} pass, ${fail} fail`)
if (fail > 0) {
  console.log('\nFAILURES:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}