/**
 * Session-link 契约验收套件(issue #580,Phase E):
 * 签名 token 签发/校验(HMAC / 恰一个点 / timingSafeEqual / ttl 上界 /
 * schema 闭集未知键拒绝 / plan_it⇔wish_id 成对 / session_ref 路径护栏 /
 * 写动词词位不存在 / production fail-closed)
 * + format/parse 互逆与 query/hash 拒绝
 * + 校验面运行期边界(失效时钟不得放行;非字符串 secret 键拒绝;
 *   production 缺 secret 的 verify 收敛,签发面刻意抛错保留——配置面用
 *   隔离子进程验证)
 * + plan-it 行动卡(wish_id 与 token payload 同源 / label 封闭词汇)
 * + WhyNowCard.wish_id 结构化自指(Phase E 合同增补)。
 *
 * 全离线合成数据,无网络、无 IO、无 stateRoot 写、无 scheme handler 注册
 * (消费端激活是 M4;本套件只验契约)。
 *
 * 运行(在 ts/ 下):npx tsx scripts/session-link-tests.ts
 */

import { spawnSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

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
  type SessionLinkVerifyResult,
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

  // session_ref 路径护栏(链接永远无法命名 state 路径;含 NUL——源码里该
  // 守卫字面量曾存真实 NUL 字节,用 \0 转义后此断言钉住行为)
  for (const bad of ['../gotry-state', 'a/b', 'a\\b', 'a..b', 'x/y/z', '/abs', 'a\0b']) {
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

// ---------------------------------------------------------------- §8 校验面运行期边界
section('§8 校验面运行期边界(失效时钟不得放行;production 缺 secret 的 verify 收敛)')

const TS_ROOT = join(import.meta.dirname, '..')

/** tsx CLI 文件(直接以 process.execPath 启动,不经 npx/shell 孙进程)。 */
function resolveTsxCli(): string {
  const req = createRequire(join(TS_ROOT, 'package.json'))
  const pkgPath = req.resolve('tsx/package.json')
  const binField = (JSON.parse(readFileSync(pkgPath, 'utf-8')) as { bin?: string | { tsx?: string } }).bin
  const bin = typeof binField === 'string' ? binField : binField?.tsx
  if (!bin) throw new Error('tsx package.json 必须有 bin 入口')
  return join(dirname(pkgPath), bin)
}

/** production 缺 secret 的配置面必须放隔离子进程验证:env 是进程级全局,
 *  进程内改写会污染本套件其余默认 secret 断言(§5a/§5b 依赖真实 process.env)。 */
function runProdEnvChild(fixtureBody: string, token: string): { status: number | null; stdout: string; stderr: string } {
  const home = mkdtempSync(join(tmpdir(), 'gotry-session-link-prod-env-'))
  const fixture = join(home, 'prod-env-probe.mts')
  writeFileSync(fixture, fixtureBody, 'utf8')
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production' }
  delete env.SESSION_LINK_HMAC_SECRET
  const res = spawnSync(process.execPath, [resolveTsxCli(), fixture, token], {
    cwd: TS_ROOT, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, env,
  })
  rmSync(home, { recursive: true, force: true })
  return { status: res.status, stdout: res.stdout, stderr: res.stderr }
}

{
  const nanClock = (): Date => new Date(Number.NaN)

  // 过期 token + NaN 时钟:`NaN > expiresMs` 恒 false,曾把过期链接静默判成有效(#580 缺口)
  const expired = signSessionLink(basePayload({ ttl_seconds: 1 }), SECRET)
  const r1 = verifySessionLink(expired, SECRET, nanClock)
  ok(!r1.ok && r1.reason === 'link_invalid', '§8a 过期 token + NaN 时钟 → link_invalid(失效时钟不得把过期判成有效)')

  // 未过期 token + NaN 时钟同样拒绝:任何接受都不得建立在无效时间上
  const live = signSessionLink(basePayload(), SECRET)
  const r2 = verifySessionLink(live, SECRET, nanClock)
  ok(!r2.ok && r2.reason === 'link_invalid', '§8b 未过期 token + NaN 时钟 → link_invalid')

  // 时钟回调抛错:异常不外泄,收敛为 link_invalid(「verify 永不抛错」的字面真)
  const throwingClock = (): Date => { throw new Error('clock unavailable') }
  let threw = false
  let r3: SessionLinkVerifyResult | undefined
  try { r3 = verifySessionLink(live, SECRET, throwingClock) } catch { threw = true }
  ok(!threw && r3 !== undefined && !r3.ok && r3.reason === 'link_invalid', '§8c 时钟回调抛错 → 不外泄,收敛 link_invalid')

  // production 缺 secret(NODE_ENV=production 且无 SESSION_LINK_HMAC_SECRET),全在子进程:
  // token 用公开 dev 常量签——若 verify 静默回落 dev 常量,它将 verify 通过(锋利形式)
  const devSigned = signSessionLink(
    basePayload({ link_id: 'prod-env-probe', ttl_seconds: 3600 }),
    DEFAULT_DEV_SESSION_LINK_SECRET,
  )
  const sessionLinkUrl = pathToFileURL(join(TS_ROOT, 'src', 'session-link', 'session-link.ts')).href
  const child = runProdEnvChild([
    `import { DEFAULT_DEV_SESSION_LINK_SECRET, resolveSessionLinkSecret, signSessionLink, verifySessionLink } from ${JSON.stringify(sessionLinkUrl)}`,
    `const token = process.argv[2] ?? ''`,
    `const now = () => new Date('2026-09-25T08:00:00.000Z')`,
    `const payload = { link_id: 'x', session_ref: 'sess-x', action: 'open', created_at: '2026-09-25T08:00:00.000Z', ttl_seconds: 60 }`,
    `const out = {}`,
    `try { out.defaultSecretVerify = verifySessionLink(token, undefined, now) } catch (e) { out.defaultSecretVerifyThrew = String(e) }`,
    `try { out.explicitSecretVerify = verifySessionLink(token, DEFAULT_DEV_SESSION_LINK_SECRET, now) } catch (e) { out.explicitSecretVerifyThrew = String(e) }`,
    `try { resolveSessionLinkSecret(); out.resolveThrew = false } catch { out.resolveThrew = true }`,
    `try { signSessionLink(payload); out.signThrew = false } catch { out.signThrew = true }`,
    `console.log(JSON.stringify(out))`,
  ].join('\n'), devSigned)

  ok(child.status === 0, `§8d 子进程探针正常退出(status=${child.status};stderr=${child.stderr.slice(0, 300)})`)
  let report: Record<string, unknown> = {}
  try { report = JSON.parse(child.stdout.trim()) as Record<string, unknown> } catch { /* 失败落进下面的断言 */ }
  const v = report.defaultSecretVerify as { ok?: boolean; reason?: string } | undefined
  ok(v?.ok === false && v?.reason === 'link_invalid' && report.defaultSecretVerifyThrew === undefined,
    '§8e production 缺 secret:verify 缺省 secret 解析 → 不抛错,收敛 link_invalid(绝不静默回落公开 dev 常量)')
  const explicit = report.explicitSecretVerify as { ok?: boolean } | undefined
  ok(explicit?.ok === true && report.explicitSecretVerifyThrew === undefined,
    '§8f 显式传入 secret 的 verify 在 production 照常工作(守卫只针对缺省解析,不做全量否决)')
  ok(report.resolveThrew === true, '§8g production 缺 secret:resolveSessionLinkSecret 仍抛错(签发面刻意的配置异常保留)')
  ok(report.signThrew === true, '§8h production 缺 secret:signSessionLink 缺省 secret 仍抛错(签发面 fail-closed)')

  // 非字符串运行期 secret 键(畸形 JS 调用方输入:数字/对象/Symbol)——
  // createHmac 曾在守卫体外对它们抛 TypeError;校验面必须收敛 link_invalid
  const badKeys: Array<[string, unknown]> = [['123(数字)', 123], ['{}(对象)', {}], ['Symbol(bad)', Symbol('bad')]]
  for (const [label, badKey] of badKeys) {
    let keyThrew = false
    let keyResult: SessionLinkVerifyResult | undefined
    try { keyResult = verifySessionLink(live, badKey as unknown as string) } catch { keyThrew = true }
    ok(!keyThrew && keyResult !== undefined && !keyResult.ok && keyResult.reason === 'link_invalid',
      `§8i 非字符串 secret(${label})→ 不抛错,收敛 link_invalid`)
  }

  // 合法字符串键保留:空字符串键签/验往返照常(守卫只拒非字符串,不做全量收紧)
  const emptyKeyToken = signSessionLink(basePayload({ ttl_seconds: 60 }), '')
  ok(verifySessionLink(emptyKeyToken, '', () => NOW).ok === true, '§8j 空字符串 secret(合法字符串键)签/验往返照常')
}

console.log(`\nSESSION-LINK TESTS: ${pass} pass, ${fail} fail`)
if (fail > 0) {
  console.log('\nFAILURES:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
