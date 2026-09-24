/**
 * Session-link 契约验收套件(issue #580,Phase E):
 * 签名 token 签发/校验(HMAC / 恰一个点 / timingSafeEqual / ttl 上界 /
 * schema 闭集未知键拒绝 / plan_it⇔wish_id 成对 / session_ref 路径护栏 /
 * 写动词词位不存在 / production fail-closed)
 * + format/parse 互逆与 query/hash 拒绝
 * + plan-it 行动卡(wish_id 与 token payload 同源 / label 封闭词汇)
 * + WhyNowCard.wish_id 结构化自指(Phase E 合同增补)。
 *
 * 全离线合成数据,无网络、无 IO、无 stateRoot 写、无 scheme handler 注册
 * (消费端激活是 M4;本套件只验契约)。
 *
 * 运行(在 ts/ 下):npx tsx scripts/session-link-tests.ts
 */

import { createHmac } from 'node:crypto'

import { DEFAULT_DEV_SHARE_SECRET } from '../src/share/share-token.ts'
import {
  DEFAULT_DEV_SESSION_LINK_SECRET,
  DEFAULT_SESSION_LINK_BASE,
  SESSION_LINK_ACTIONS,
  SESSION_LINK_TTL_MAX_SECONDS,
  formatSessionLink,
  parseSessionLink,
  resolveSessionLinkSecret,
  signSessionLink,
  verifySessionLink,
  type SessionLinkPayload,
} from '../src/session-link/session-link.ts'
import { PLAN_IT_LABEL, buildPlanItAction } from '../src/session-link/plan-it-action.ts'
import { buildWhyNowCard, type WhyNowCard } from '../src/recall/card.ts'

let pass = 0
let fail = 0
const failures: string[] = []

function ok(cond: boolean, msg: string): void {
  if (cond) { pass++; return }
  fail++
  failures.push(msg)
}

function section(name: string): void {
  console.log(`\n== ${name} ==`)
}

const NOW = new Date('2026-09-25T08:00:00.000Z')
const SECRET = 'session-link-test-secret-not-for-prod'
const REF = 'sess-8f3a2c'  // 不透明引用(无路径分隔符)

function basePayload(overrides: Partial<SessionLinkPayload> = {}): SessionLinkPayload {
  return {
    link_id: 'link-1',
    session_ref: REF,
    action: 'plan_it',
    wish_id: 'w-dali-erhai',
    created_at: NOW.toISOString(),
    ttl_seconds: 3600,
    ...overrides,
  }
}

// ---------------------------------------------------------------- §1 往返
section('§1 round-trip 与格式契约')

{
  const token = signSessionLink(basePayload(), SECRET)
  ok(typeof token === 'string' && token.length > 0, '§1a sign 产非空 token')
  ok(token.indexOf('.') > 0 && token.indexOf('.') === token.lastIndexOf('.'), '§1b token 恰一个点')

  const result = verifySessionLink(token, SECRET, () => NOW)
  ok(result.ok === true, '§1c verify 通过')
  if (result.ok) {
    ok(result.payload.link_id === 'link-1'
      && result.payload.session_ref === REF
      && result.payload.action === 'plan_it'
      && result.payload.wish_id === 'w-dali-erhai'
      && result.payload.ttl_seconds === 3600,
      '§1d payload 逐字段回读一致')
  }

  // open 行动(wish_id 缺省)往返——序列化剥 undefined,verify 补不回 wish_id
  const openToken = signSessionLink(basePayload({ action: 'open', wish_id: undefined }), SECRET)
  const openResult = verifySessionLink(openToken, SECRET, () => NOW)
  ok(openResult.ok === true && openResult.payload.action === 'open' && openResult.payload.wish_id === undefined,
    '§1e open 行动往返(wish_id 缺省保持缺省)')
}

// ---------------------------------------------------------------- §2 篡改/过期
section('§2 篡改、过期与失败闭集')

{
  const token = signSessionLink(basePayload(), SECRET)
  const dot = token.indexOf('.')

  ok(verifySessionLink(token, 'wrong-secret', () => NOW).ok === false, '§2a 错 secret → 失败')
  const wrongSig = verifySessionLink(token, 'wrong-secret', () => NOW)
  ok(!wrongSig.ok && wrongSig.reason === 'link_invalid', '§2b 错 secret → 闭集 link_invalid')

  // 改载荷(换 wish_id)但保留原签名 → HMAC 不匹配
  const body = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const forged = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8')) as Record<string, unknown>
  forged.wish_id = 'w-qiandao'
  const forgedBody = Buffer.from(JSON.stringify(forged), 'utf-8').toString('base64url')
  const forgedResult = verifySessionLink(`${forgedBody}.${sig}`, SECRET, () => NOW)
  ok(!forgedResult.ok && forgedResult.reason === 'link_invalid', '§2c 篡改 wish_id 保留原签名 → link_invalid(绑定防重放)')

  // 截断/多点/无点
  ok(!verifySessionLink('', SECRET, () => NOW).ok, '§2d 空 token → 失败')
  ok(!verifySessionLink('no-dot-at-all', SECRET, () => NOW).ok, '§2e 无点 → link_invalid')
  ok(!verifySessionLink(`${body}.`, SECRET, () => NOW).ok, '§2f 尾随空签名 → link_invalid')
  ok(!verifySessionLink(`.${sig}`, SECRET, () => NOW).ok, '§2g 空 body → link_invalid')
  ok(!verifySessionLink(`${body}.${sig}.extra`, SECRET, () => NOW).ok, '§2h 多点 → link_invalid')

  // 过期(now 超过 created_at + ttl)
  const expiring = signSessionLink(basePayload({ ttl_seconds: 60 }), SECRET)
  const before = verifySessionLink(expiring, SECRET, () => new Date(NOW.getTime() + 59_000))
  const after = verifySessionLink(expiring, SECRET, () => new Date(NOW.getTime() + 61_000))
  ok(before.ok === true, '§2i ttl 内 verify 通过')
  ok(!after.ok && after.reason === 'link_expired', '§2j 过期 → 闭集 link_expired')

  // ttl=0:created_at 即过期(> 判定,等值时刻仍有效;下一毫秒失效)
  const zero = signSessionLink(basePayload({ ttl_seconds: 0 }), SECRET)
  ok(verifySessionLink(zero, SECRET, () => NOW).ok === true, '§2k ttl=0 签发时刻本身仍有效')
  ok(!verifySessionLink(zero, SECRET, () => new Date(NOW.getTime() + 1)).ok, '§2l ttl=0 下一毫秒过期')

  // 非字符串 token 永不抛错
  for (const garbage of [null, undefined, 42, {}, ['a.b']]) {
    const r = verifySessionLink(garbage as unknown as string, SECRET, () => NOW)
    ok(!r.ok && r.reason === 'link_invalid', `§2m 非字符串 token(${JSON.stringify(garbage)})→ link_invalid 不抛错`)
  }
}

// ---------------------------------------------------------------- §3 构造层护栏
section('§3 构造层护栏(sign 抛错 = 坏链接不出仓库)')

{
  // **写动词词位不存在**:WriteGate 在链接层的结构性封死
  for (const verb of ['book', 'pay', 'confirm', 'purchase', 'reserve']) {
    let threw = false
    try {
      signSessionLink(basePayload({ action: verb as unknown as SessionLinkPayload['action'] }), SECRET)
    } catch { threw = true }
    ok(threw, `§3a 写动词 action=${verb} → sign 抛错(词位里没有,连构造都不可能)`)
  }
  ok(SESSION_LINK_ACTIONS.length === 2 && (SESSION_LINK_ACTIONS as readonly string[]).join(',') === 'plan_it,open',
    '§3b action 闭集恰 plan_it/open 两个词位')

  // plan_it ⇔ wish_id 成对(双向)
  let threw1 = false
  try { signSessionLink(basePayload({ wish_id: undefined }), SECRET) } catch { threw1 = true }
  ok(threw1, '§3c plan_it 缺 wish_id → sign 抛错')

  let threw2 = false
  try { signSessionLink(basePayload({ wish_id: '' }), SECRET) } catch { threw2 = true }
  ok(threw2, '§3d plan_it 空 wish_id → sign 抛错')

  let threw3 = false
  try { signSessionLink(basePayload({ action: 'open', wish_id: 'w-x' }), SECRET) } catch { threw3 = true }
  ok(threw3, '§3e open 夹带 wish_id → sign 抛错(语义混淆拒绝)')

  // session_ref 路径护栏(链接永远无法命名 state 路径)
  for (const bad of ['../gotry-state', 'a/b', 'a\\b', 'a..b', 'x/y/z', '/abs']) {
    let threw = false
    try { signSessionLink(basePayload({ session_ref: bad }), SECRET) } catch { threw = true }
    ok(threw, `§3f session_ref=${JSON.stringify(bad)} → sign 抛错(路径化引用拒绝)`)
  }
  let threwLong = false
  try { signSessionLink(basePayload({ session_ref: 'x'.repeat(129) }), SECRET) } catch { threwLong = true }
  ok(threwLong, '§3g session_ref 超 128 字符 → sign 抛错')

  // ttl 越界
  for (const badTtl of [-1, 1.5, Number.NaN, SESSION_LINK_TTL_MAX_SECONDS + 1, Infinity]) {
    let threw = false
    try { signSessionLink(basePayload({ ttl_seconds: badTtl }), SECRET) } catch { threw = true }
    ok(threw, `§3h ttl=${String(badTtl)} → sign 抛错(非负整数且 ≤2^31-1)`)
  }
  let threwOk = false
  try { signSessionLink(basePayload({ ttl_seconds: SESSION_LINK_TTL_MAX_SECONDS }), SECRET); threwOk = true } catch { /* noop */ }
  ok(threwOk, `§3i ttl=${SESSION_LINK_TTL_MAX_SECONDS}(上界本身)→ sign 接受`)

  // created_at 不可解析
  let threwDate = false
  try { signSessionLink(basePayload({ created_at: 'not-a-date' }), SECRET) } catch { threwDate = true }
  ok(threwDate, '§3j created_at 不可解析 → sign 抛错')

  // link_id 非空
  let threwId = false
  try { signSessionLink(basePayload({ link_id: '' }), SECRET) } catch { threwId = true }
  ok(threwId, '§3k link_id 空 → sign 抛错')
}

// ---------------------------------------------------------------- §4 schema 闭集
section('§4 schema 闭集(de-identified by construction 的可测试字面真)')

{
  // 手工构造合法签名但带未知键的 token → verify 拒绝
  const payloadWithExtra = { ...basePayload(), note: 'user-memory-content', score: 99 }
  const body = Buffer.from(JSON.stringify(payloadWithExtra), 'utf-8').toString('base64url')
  const sig = createSig(body)
  const r = verifySessionLink(`${body}.${sig}`, SECRET, () => NOW)
  ok(!r.ok && r.reason === 'link_invalid', '§4a 未知键(note/score)→ verify 拒绝(链接不携带事实/记忆)')

  // wish_id 类型化(数字)→ 拒绝
  const badWish = { ...basePayload(), wish_id: 12345 }
  const badWishBody = Buffer.from(JSON.stringify(badWish), 'utf-8').toString('base64url')
  const r2 = verifySessionLink(`${badWishBody}.${createSig(badWishBody)}`, SECRET, () => NOW)
  ok(!r2.ok && r2.reason === 'link_invalid', '§4b wish_id 非字符串 → verify 拒绝')

  // plan_it 缺 wish_id 的签名 token → verify 拒绝(与 sign 同规则)
  const noWish = { link_id: 'x', session_ref: REF, action: 'plan_it', created_at: NOW.toISOString(), ttl_seconds: 60 }
  const noWishBody = Buffer.from(JSON.stringify(noWish), 'utf-8').toString('base64url')
  const r3 = verifySessionLink(`${noWishBody}.${createSig(noWishBody)}`, SECRET, () => NOW)
  ok(!r3.ok && r3.reason === 'link_invalid', '§4c plan_it 无 wish_id → verify 拒绝(手工绕过 sign 也过不了)')

  // session_ref 路径化(手工签名)→ verify 拒绝
  const badRef = { ...basePayload(), session_ref: '../../etc/passwd' }
  const badRefBody = Buffer.from(JSON.stringify(badRef), 'utf-8').toString('base64url')
  const r4 = verifySessionLink(`${badRefBody}.${createSig(badRefBody)}`, SECRET, () => NOW)
  ok(!r4.ok && r4.reason === 'link_invalid', '§4d session_ref 路径化(手工签名)→ verify 拒绝')

  // open 带 wish_id(手工签名)→ verify 拒绝
  const openWithWish = { link_id: 'x', session_ref: REF, action: 'open', wish_id: 'w-x', created_at: NOW.toISOString(), ttl_seconds: 60 }
  const owwBody = Buffer.from(JSON.stringify(openWithWish), 'utf-8').toString('base64url')
  const r5 = verifySessionLink(`${owwBody}.${createSig(owwBody)}`, SECRET, () => NOW)
  ok(!r5.ok && r5.reason === 'link_invalid', '§4e open 夹带 wish_id(手工签名)→ verify 拒绝')

  // JSON 数组体(合法 HMAC,形态非对象)→ verify 拒绝
  const arrBody = Buffer.from(JSON.stringify(['a']), 'utf-8').toString('base64url')
  const r6 = verifySessionLink(`${arrBody}.${createSig(arrBody)}`, SECRET, () => NOW)
  ok(!r6.ok && r6.reason === 'link_invalid', '§4f JSON 数组体(手工签名)→ verify 拒绝(形态守卫)')
}

function createSig(body: string): string {
  return createHmac('sha256', SECRET).update(body).digest('base64url')
}

// ---------------------------------------------------------------- §5 secret 纪律
section('§5 secret 解析与 production fail-closed')

{
  ok(resolveSessionLinkSecret({ SESSION_LINK_HMAC_SECRET: 'from-env' } as NodeJS.ProcessEnv) === 'from-env', '§5a env 优先')
  ok(resolveSessionLinkSecret({} as NodeJS.ProcessEnv) === DEFAULT_DEV_SESSION_LINK_SECRET, '§5b 缺 env 非生产回落 dev 常量')
  let threw = false
  try { resolveSessionLinkSecret({ NODE_ENV: 'production' } as NodeJS.ProcessEnv) } catch { threw = true }
  ok(threw, '§5c production 缺 env → fail-closed 抛错(不用公开常量签生产链接)')

  // dev 默认常量与 share 的常量不同源(独立 secret 面)
  ok((DEFAULT_DEV_SESSION_LINK_SECRET as string) !== DEFAULT_DEV_SHARE_SECRET, '§5d session-link 与 share 的 dev 常量独立')
}

// ---------------------------------------------------------------- §6 format/parse
section('§6 format/parse 互逆与严格性')

{
  const token = signSessionLink(basePayload(), SECRET)
  const url = formatSessionLink(token)
  ok(url === `${DEFAULT_SESSION_LINK_BASE}/${token}`, '§6a 默认 base 渲染 gotry://session/<token>')
  ok(parseSessionLink(url) === token, '§6b parse(format(t)) === t(互逆)')

  const custom = formatSessionLink(token, 'http://127.0.0.1:3080/session')
  ok(custom === `http://127.0.0.1:3080/session/${token}`, '§6c 自定义 base(本地 http 消费端)渲染')
  ok(parseSessionLink(custom) === token, '§6d 自定义 base 反解互逆')

  ok(parseSessionLink(`${url}?utm=x`) === null, '§6e 带 query → null(拼接歧义拒绝)')
  ok(parseSessionLink(`${url}#frag`) === null, '§6f 带 hash → null')
  ok(parseSessionLink('gotry://session') === null, '§6g 无 token 段 → null')
  ok(parseSessionLink('') === null, '§6h 空串 → null')
  ok(parseSessionLink('justtoken') === null, '§6i 单段无 base → null(形态不符)')

  let threw = false
  try { formatSessionLink('', DEFAULT_SESSION_LINK_BASE) } catch { threw = true }
  ok(threw, '§6j format 空 token 抛错')
  let threw2 = false
  try { formatSessionLink(token, 'gotry://session/') } catch { threw2 = true }
  ok(threw2, '§6k base 以 / 结尾抛错(防双斜杠漂移)')
  let threw3 = false
  try { formatSessionLink(token, 'gotry://session?x=1') } catch { threw3 = true }
  ok(threw3, '§6l base 含 query 抛错(产出即 parse 拒绝的形态)')
  let threw4 = false
  try { formatSessionLink(token, 'gotry://session#f') } catch { threw4 = true }
  ok(threw4, '§6m base 含 hash 抛错')
}

// ---------------------------------------------------------------- §7 plan-it 行动卡
section('§7 plan-it 行动卡(wish_id 同源构造)')

function makeCard(wishId: string): WhyNowCard {
  return buildWhyNowCard({
    wish_id: wishId,
    wish_name: '大理 · 洱海恢复之旅',
    signal: { reason: 'price_drop', source: 'fare-probe', current_value: '¥1,880(降 12%)', threshold: '≤ ¥2,000' },
    evaluated_at: NOW.toISOString(),
  })
}

{
  const card = makeCard('w-dali-erhai')
  ok(card.wish_id === 'w-dali-erhai', '§7a WhyNowCard.wish_id 结构化自指(Phase E 合同增补)')

  const action = buildPlanItAction(card, {
    session_ref: REF,
    link_id: 'link-action-1',
    secret: SECRET,
    now: () => NOW,
    ttl_seconds: 3600,
  })
  ok(action.kind === 'plan_it', '§7b kind 恒 plan_it')
  ok(action.label === PLAN_IT_LABEL && action.label === '好,规划它', '§7c label 封闭词汇')
  ok(action.wish_id === 'w-dali-erhai', '§7d action.wish_id 取自卡的结构化字段')

  // 同源构造:deep_link 里解出的 token,payload.wish_id 与 action.wish_id 是同一个值
  const token = parseSessionLink(action.deep_link)
  ok(token !== null, '§7e deep_link 可反解出 token')
  if (token !== null) {
    const r = verifySessionLink(token, SECRET, () => NOW)
    ok(r.ok === true, '§7f deep_link token verify 通过')
    if (r.ok) {
      ok(r.payload.wish_id === action.wish_id, '§7g token payload.wish_id 与 action.wish_id 同源相等(构造级,不可能漂移)')
      ok(r.payload.action === 'plan_it', '§7h token action === plan_it')
      ok(r.payload.session_ref === REF, '§7i token session_ref 绑定正确')
      ok(r.payload.link_id === 'link-action-1', '§7j link_id 注入生效')
    }
  }

  // 无 wish_id 的卡(手工构造,绕过 buildWhyNowCard)→ 构造层抛错
  const brokenCard = { ...card, wish_id: '' }
  let threw = false
  try { buildPlanItAction(brokenCard, { session_ref: REF, secret: SECRET, now: () => NOW }) } catch { threw = true }
  ok(threw, '§7k 空 wish_id 卡 → buildPlanItAction 抛错(fail-closed 不产空目标链接)')

  // 路径化 session_ref → 构造层抛错(即使 base 合法)
  let threw2 = false
  try { buildPlanItAction(card, { session_ref: '../state/x', secret: SECRET, now: () => NOW }) } catch { threw2 = true }
  ok(threw2, '§7l 路径化 session_ref → buildPlanItAction 抛错')

  // 默认 deps:link_id 自动生成,ttl 默认 24h
  const auto = buildPlanItAction(card, { session_ref: REF, secret: SECRET, now: () => NOW })
  const autoToken = parseSessionLink(auto.deep_link)
  ok(autoToken !== null, '§7m 默认 deps 产出 deep_link')
  if (autoToken !== null) {
    const r = verifySessionLink(autoToken, SECRET, () => NOW)
    ok(r.ok === true && r.payload.link_id.length > 0 && r.payload.ttl_seconds === 86_400, '§7n 默认 link_id 非空 + ttl 24h')
  }
}

console.log(`\nSESSION-LINK TESTS: ${pass} pass, ${fail} fail`)
if (fail > 0) {
  console.log('\nFAILURES:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
