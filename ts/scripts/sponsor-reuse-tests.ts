/**
 * sponsor 插件与同内核端到端复用证明测试(issue #235;全离线 fixture 合成数据,零真实调用):
 *  1. 插件配置 fail-closed(反例先行):缺 sponsorId/travelerPrincipalId/bffPrincipalId、
 *     空路由表/重复路由、缺披露文案或缺排序偏置声明、负/非整数佣金、sponsorId 冒充 traveler
 *     principal(三主体混同)——全部构造即拒
 *  2. 运行激活默认关闭:SPONSOR_RUNTIME_ACTIVATION_DEFAULT=false,requireRuntimeActivation(false) 抛错,
 *     显式 true 才放行(本件为结构性证明,非运行时激活,零真实交易路径)
 *  3. 路由授权(越权反例):路由不在 sponsor allowedRoutes 闭集 → route-unauthorized;
 *     授权路由但缺 session/order 绑定 → missing-session-binding(禁止复制 Buyer/credentials 规避)
 *  4. 同内核引用证明(复用面):sponsor 模块源码必须 import 自 src/booking-saga.ts 与 src/wish-pool.ts
 *     (同源调用,零拷贝——不重声明边表/解析器);运行时面 ts/src/** 零 sponsor-plugin 引用
 *     (C 端默认路径结构性隔离);内核边表/拒绝表十二格从消费侧逐字钉死(内核漂移即本套件红)
 *  5. 排序红线:高佣金候选不满足旅行者条件 → 保持排除,赞助权重不可伪造用户效用;
 *     同分 tie-break 只按申报顺位且必须显式披露偏置;佣金数值从不进入排序键
 *  6. 端到端 B2B(fixture):配置→路由授权→库存/规划(内核评分)→确认闸
 *     (write.pending→write.confirmed,披露 digest 进入确认指纹,必携 receipt)→审计/回放
 *     (内核 sagaTraceViolations 空违例)
 *  7. 端到端 B2C + 隔离:同一 runner 不带 plugin → b2c 形态;saga 边序列与 B2B 逐格相同
 *     (同一内核函数);leak 检查器零发现(sponsor 字段零渗入);空 receipt 两种形态同拒
 *     (同一 WriteGate 规则,无豁免)
 *  8. A/B 同业务 id 不串:同 businessId 不同 sponsor → scope 三元组隔离,事件/指纹/approval
 *     互不可见;A 的 approval 绑定在 B 的指纹上校验失败;取消退款路径(propose→confirm→compensate)
 *     在 sponsor 形态同样走内核边表,回放零违例
 *
 * 运行: cd ts && npx tsx scripts/sponsor-reuse-tests.ts
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  SAGA_EDGES,
  SAGA_REJECTIONS,
} from '../src/booking-saga.ts'
import {
  SPONSOR_PLUGIN_SCHEMA,
  SPONSOR_RUNTIME_ACTIVATION_DEFAULT,
  authorizeSponsorRoute,
  buildConfirmationFingerprint,
  bindApproval,
  createSponsorPlugin,
  rankSponsorCandidates,
  requireRuntimeActivation,
  runBookingScenario,
  scoreCandidateAgainstWish,
  sponsorLeakFindings,
  verifyApprovalBinding,
  type SponsorCandidate,
  type SponsorPlugin,
} from '../capabilities/sponsor-plugin.ts'

const REPO_TS = new URL('..', import.meta.url).pathname

// ── fixture:两个 sponsor 配置 + 三条合成库存候选 ─────────────────────────────
function sponsorConfigA() {
  return {
    sponsorId: 'sponsor-a-travel',
    travelerPrincipalId: 'traveler-001',
    bffPrincipalId: 'bff-agency-a',
    allowedRoutes: ['route.packaged-erhai-4d', 'route.packaged-yunnan-5d'],
    disclosure: {
      commissionBps: 300,
      statement: '本方案由旅行社 A 提供库存,成交后旅行社获得 3% 佣金。',
      rankingBiasNotice: '同分候选按旅行社申报顺位排序;佣金不影响条件判定。',
    },
  }
}
function sponsorConfigB() {
  const c = sponsorConfigA()
  return { ...c, sponsorId: 'sponsor-b-board', bffPrincipalId: 'bff-board-b', disclosure: { ...c.disclosure, commissionBps: 0 } }
}

function makePlugin(overrides: Record<string, unknown> = {}): SponsorPlugin {
  return createSponsorPlugin({ ...sponsorConfigA(), ...overrides } as never)
}

const WISH = { days: 4, budgetCny: 8000, month: 7 }

function candidates(): SponsorCandidate[] {
  return [
    {
      candidateRef: 'cand-alpha',
      route: 'route.packaged-erhai-4d',
      name: '大理洱海 4 日包价',
      priceCny: 6500,
      conditions: { days: 4, budget_cny: 7000, best_months: [7] },
      commissionBps: 300,
    },
    {
      candidateRef: 'cand-beta',
      route: 'route.packaged-yunnan-5d',
      name: '云南 5 日(旅行者只有 4 天)',
      priceCny: 7200,
      conditions: { days: 5, budget_cny: 7000, best_months: [7] },
      commissionBps: 900,
    },
  ]
}

// ── 1. 插件配置 fail-closed(反例先行) ───────────────────────────────────────
for (const [field, broken] of [
  ['sponsorId', { sponsorId: '' }],
  ['travelerPrincipalId', { travelerPrincipalId: '   ' }],
  ['bffPrincipalId', { bffPrincipalId: '' }],
  ['allowedRoutes-empty', { allowedRoutes: [] }],
  ['allowedRoutes-dup', { allowedRoutes: ['route.a', 'route.a'] }],
  ['statement', { disclosure: { commissionBps: 100, statement: '', rankingBiasNotice: 'x' } }],
  ['rankingBiasNotice', { disclosure: { commissionBps: 100, statement: 'x', rankingBiasNotice: '' } }],
  ['commissionBps-negative', { disclosure: { commissionBps: -1, statement: 'x', rankingBiasNotice: 'y' } }],
  ['commissionBps-fraction', { disclosure: { commissionBps: 1.5, statement: 'x', rankingBiasNotice: 'y' } }],
] as const) {
  assert.throws(() => makePlugin(broken as never), Error, `缺/坏 ${field} → 拒绝建插件(fail-closed)`)
}
assert.throws(
  () => makePlugin({ travelerPrincipalId: 'sponsor-a-travel' }),
  Error,
  'sponsorId 冒充 traveler principal(三主体混同)→ 拒绝',
)
const pluginA = makePlugin()
assert.equal(pluginA.schemaVersion, SPONSOR_PLUGIN_SCHEMA, '插件 schema = sponsor.plugin.v1')
assert.match(pluginA.disclosureDigestSha256, /^[0-9a-f]{64}$/, '披露口径摘要为 sha256(佣金/文案/偏置声明进 digest)')

// ── 2. 运行激活默认关闭 ─────────────────────────────────────────────────────
assert.equal(SPONSOR_RUNTIME_ACTIVATION_DEFAULT, false, '激活常量默认 false(结构性默认关)')
assert.throws(() => requireRuntimeActivation(SPONSOR_RUNTIME_ACTIVATION_DEFAULT), Error, '默认态调用激活门 → 抛错')
assert.doesNotThrow(() => requireRuntimeActivation(true), '显式 opt-in 才放行(真实运行时接线属 M6 Entry 后)')

// ── 3. 路由授权(越权反例) ──────────────────────────────────────────────────
const unauthorized = authorizeSponsorRoute(pluginA, 'route.not-declared', { sessionRef: 'sess-1' })
assert.equal(unauthorized.ok, false, '越权路由 → 拒绝')
assert.equal(unauthorized.ok ? '' : unauthorized.reason, 'route-unauthorized', '拒绝理由 = route-unauthorized')
const unbound = authorizeSponsorRoute(pluginA, 'route.packaged-erhai-4d', { sessionRef: null })
assert.equal(unbound.ok ? '' : unbound.reason, 'missing-session-binding', '授权路由但缺 session 绑定 → 拒绝(禁止复制 Buyer/credentials 规避)')
const okRoute = authorizeSponsorRoute(pluginA, 'route.packaged-erhai-4d', { sessionRef: 'sess-traveler-001', orderRef: 'ord-fix-1' })
assert.equal(okRoute.ok, true, '闭集内路由 + session/order 绑定 → 授权通过')
const pluginB = makePlugin(sponsorConfigB() as never)
const crossRoute = authorizeSponsorRoute(pluginB, 'route.packaged-yunnan-5d', { sessionRef: 'sess-b' })
assert.equal(crossRoute.ok, true, '每个 sponsor 的授权闭集独立维护')

// ── 4. 同内核引用证明(复用面 = 零拷贝 + 零内核改动 + C 端隔离) ───────────────
// 4a. 内核契约从消费侧钉死:12 格 (origin,trigger) 边表/拒绝表与冻结字面量逐字一致
const EDGE_GOLDEN = [
  'none:propose>pending:write.pending',
  'pending:confirm>confirmed:write.confirmed',
  'pending:compensate>compensated:write.compensated',
  'confirmed:compensate>compensated:write.compensated',
]
assert.equal(
  SAGA_EDGES.map((e) => `${e.from}:${e.trigger}>${e.to}:${e.event}`).join('|'),
  EDGE_GOLDEN.join('|'),
  '内核 booking_saga_fsm.v1 边表与冻结字面量逐字一致(内核漂移即红)',
)
const REJECT_GOLDEN = [
  'none:confirm', 'none:compensate', 'pending:propose', 'confirmed:propose',
  'confirmed:confirm', 'compensated:propose', 'compensated:confirm', 'compensated:compensate',
]
assert.equal(
  SAGA_REJECTIONS.map((e) => `${e.from}:${e.trigger}`).join('|'),
  REJECT_GOLDEN.join('|'),
  '内核拒绝闭集八格与冻结字面量逐字一致',
)

// 4b. sponsor 模块同源 import(零拷贝:不重声明内核边表/解析器/评分器)
const sponsorSrc = readFileSync(join(REPO_TS, 'capabilities/sponsor-plugin.ts'), 'utf8')
assert.match(sponsorSrc, /from '\.\.\/src\/booking-saga\.ts'/, 'sponsor 模块 import 自内核 booking-saga.ts(同一内核函数)')
assert.match(sponsorSrc, /from '\.\.\/src\/wish-pool\.ts'/, 'sponsor 模块 import 自内核 wish-pool.ts(同一评分函数)')
assert.doesNotMatch(sponsorSrc, /function resolveSagaTrigger/, '零拷贝:不重声明内核触发解析器')
assert.doesNotMatch(sponsorSrc, /const SAGA_EDGES/, '零拷贝:不重声明内核边表')
assert.doesNotMatch(sponsorSrc, /function scoreWishMatch/, '零拷贝:不重声明内核评分器')

// 4c. 运行时面隔离:ts/src/** 无任何文件引用 sponsor-plugin(C 端默认路径结构性零渗入)
function walkTs(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return walkTs(p)
    return name.endsWith('.ts') ? [p] : []
  })
}
const runtimeFiles = walkTs(join(REPO_TS, 'src'))
assert.ok(runtimeFiles.length > 20, `运行时面文件枚举非空(实得 ${runtimeFiles.length})`)
const leaked = runtimeFiles.filter((f) => readFileSync(f, 'utf8').includes('sponsor-plugin'))
assert.deepEqual(leaked, [], 'ts/src/** 零 sponsor-plugin 引用(C 端默认路径不接线 sponsor 面)')

// ── 5. 排序红线(赞助收益不伪造用户效用) ────────────────────────────────────
const ranking = rankSponsorCandidates(pluginA, candidates(), WISH)
assert.deepEqual(
  ranking.excluded.map((e) => `${e.candidateRef}:${e.why}`),
  ['cand-beta:conditions-not-met'],
  '高佣金(900bps)但天数不足的候选保持排除——佣金不可赎回条件',
)
assert.equal(ranking.ranked.length, 1, '只有条件全命中的候选进入排序')
assert.equal(ranking.ranked[0].candidate.candidateRef, 'cand-alpha', '命中候选 = cand-alpha')
assert.equal(ranking.ranked[0].sponsorTieBreakApplied, false, '无同分不发生赞助 tie-break')
assert.ok(ranking.ranked[0].disclosure.statement.length > 0, '排序结果必携披露文案')
assert.ok(ranking.biasNotice.length > 0, '排序输出顶层必携偏置声明(渲染面必须可见)')

// 同分 tie:按申报顺位,不按佣金;发生 tie-break 必须显式披露
const tieCandidates: SponsorCandidate[] = [
  { candidateRef: 'tie-low', route: 'route.packaged-erhai-4d', name: '低佣金', priceCny: 6600, conditions: { days: 4, budget_cny: 7000 }, commissionBps: 100 },
  { candidateRef: 'tie-high', route: 'route.packaged-yunnan-5d', name: '高佣金同分', priceCny: 6700, conditions: { days: 4, budget_cny: 7000 }, commissionBps: 900 },
]
const tieRank = rankSponsorCandidates(
  pluginA,
  tieCandidates,
  { days: 4, budgetCny: 8000 },
)
assert.deepEqual(tieRank.ranked.map((r) => r.candidate.candidateRef), ['tie-low', 'tie-high'], '同分按申报顺位(申报顺位在前的低佣金居首)')
assert.equal(tieRank.ranked[0].sponsorTieBreakApplied, false, '申报顺位首位无需 tie-break 标记')
const tieReversed = rankSponsorCandidates(
  pluginA,
  [tieCandidates[1], tieCandidates[0]],
  { days: 4, budgetCny: 8000 },
)
assert.deepEqual(tieReversed.ranked.map((r) => r.candidate.candidateRef), ['tie-high', 'tie-low'], '调换申报顺位则高佣金居首——排序键是申报顺位而非佣金')
assert.equal(tieReversed.ranked[0].sponsorTieBreakApplied, true, 'tie-break 真实发生时必须标记')
assert.ok(tieReversed.ranked[0].disclosure.rankingBiasNotice.length > 0, 'tie-break 候选必携偏置声明(偏置必须展示给旅行者)')

// 内核评分器直证:同一 scoreCandidateAgainstWish 在两形态共用(条件不满足 → null)
assert.equal(scoreCandidateAgainstWish(candidates()[1], WISH), null, '内核评分:天数不足 → null(不可预订)')
assert.equal(scoreCandidateAgainstWish(candidates()[0], WISH)?.hits.length, 3, '内核评分:三条件全命中')

// ── 6. 端到端 B2B(fixture 合成数据,零真实调用) ─────────────────────────────
const b2bTrace = runBookingScenario({
  businessId: 'BIZ-1',
  travelerPrincipalId: 'traveler-001',
  sessionRef: 'sess-traveler-001',
  candidates: candidates(),
  wish: WISH,
  action: 'confirm',
  receipt: 'receipt-hb-fix-001',
  plugin: pluginA,
})
assert.equal(b2bTrace.form, 'b2b-sponsor', 'B2B 形态标记 b2b-sponsor')
assert.equal(b2bTrace.selectedCandidateRef, 'cand-alpha', '选中条件全命中候选')
const b2bKinds = b2bTrace.events.map((e) => e.kind)
assert.deepEqual(b2bKinds, ['route.authorized', 'candidate.ranked', 'write.pending', 'write.confirmed'], 'B2B 事件序列:路由授权→排序→propose→confirm')
const b2bPending = b2bTrace.events[2]
const b2bConfirmed = b2bTrace.events[3]
assert.equal(b2bTrace.sagaStatus, 'confirmed', 'saga 终态 confirmed')
assert.ok(b2bPending.guard !== null && b2bPending.guard.includes('idem_key UNIQUE'), 'write.pending 携内核边表守卫原文(同一张边表)')
assert.ok(b2bConfirmed.guard !== null && b2bConfirmed.guard.includes('receipt'), 'write.confirmed 携内核边表守卫原文(L3 具名确认)')
assert.equal(b2bConfirmed.receipt, 'receipt-hb-fix-001', '确认必携外部回执')
assert.deepEqual(b2bTrace.sagaViolations, [], '内核 sagaTraceViolations 回放零违例(审计链合法)')
// 披露 digest 进入确认指纹:同一请求换披露 → 指纹必变
const fpA = buildConfirmationFingerprint({
  businessId: 'BIZ-1', travelerPrincipalId: 'traveler-001', sponsorId: 'sponsor-a-travel',
  candidateRef: 'cand-alpha', route: 'route.packaged-erhai-4d', priceCny: 6500,
  disclosureDigestSha256: pluginA.disclosureDigestSha256,
})
const fpA2 = buildConfirmationFingerprint({
  businessId: 'BIZ-1', travelerPrincipalId: 'traveler-001', sponsorId: 'sponsor-a-travel',
  candidateRef: 'cand-alpha', route: 'route.packaged-erhai-4d', priceCny: 6500,
  disclosureDigestSha256: '0'.repeat(64),
})
assert.notEqual(fpA, fpA2, '披露口径变化 → 确认指纹变化(佣金披露进入确认指纹)')
assert.ok(b2bConfirmed.fingerprintSha256 && b2bConfirmed.fingerprintSha256.length === 64, '确认事件携带 64 位指纹')
const approval = bindApproval({ fingerprintSha256: fpA, receipt: 'receipt-hb-fix-001', travelerPrincipalId: 'traveler-001', sponsorId: 'sponsor-a-travel' })
assert.equal(verifyApprovalBinding(fpA, approval), true, 'approval 绑定同指纹校验通过')
assert.equal(verifyApprovalBinding(fpA2, approval), false, '指纹不匹配 → approval 绑定校验失败')

// ── 7. 端到端 B2C + 隔离(同一 runner,零 sponsor 渗入) ──────────────────────
const b2cTrace = runBookingScenario({
  businessId: 'BIZ-1',
  travelerPrincipalId: 'traveler-001',
  candidates: candidates(),
  wish: WISH,
  action: 'confirm',
  receipt: 'receipt-hb-fix-001',
})
assert.equal(b2cTrace.form, 'b2c', '无 plugin → C 端默认形态')
assert.equal(b2cTrace.selectedCandidateRef, 'cand-alpha', 'C 端同一内核评分选中同一候选(复用)')
assert.deepEqual(b2cTrace.events.map((e) => e.kind), ['candidate.ranked', 'write.pending', 'write.confirmed'], 'C 端无路由授权/披露事件')
// 同一内核边序列:两形态 saga 段逐格相同(from/to/event/guard)
const sagaSlice = (t: typeof b2cTrace) => t.events
  .filter((e) => e.sagaEvent !== null)
  .map((e) => `${e.kind}:${e.from}>${e.to}:${(e.guard ?? '').slice(0, 12)}`)
assert.deepEqual(sagaSlice(b2bTrace), sagaSlice(b2cTrace), 'B2B/B2C saga 段逐格相同——同一内核函数在 sponsor 形态下跑通同一状态机')
assert.deepEqual(sponsorLeakFindings(b2cTrace), [], 'C 端 trace 泄漏检查零发现(sponsor 字段零渗入)')
assert.ok(sponsorLeakFindings(b2bTrace).length > 0, '对照:B2B trace 泄漏检查有发现(检查器本身有效)')
// 空 receipt 两种形态同拒(同一 WriteGate/空 receipt 红线,无豁免)
for (const [form, opts] of [
  ['b2b', { plugin: pluginA, sessionRef: 'sess-traveler-001' }],
  ['b2c', {}],
] as const) {
  assert.throws(
    () => runBookingScenario({
      businessId: 'BIZ-1', travelerPrincipalId: 'traveler-001',
      candidates: candidates(), wish: WISH, action: 'confirm',
      receipt: '   ', ...opts,
    }),
    Error,
    `${form} 空 receipt → 拒绝(空 receipt 红线无 B2B 豁免)`,
  )
}
assert.throws(
  () => runBookingScenario({
    businessId: 'BIZ-1', travelerPrincipalId: 'traveler-001', sessionRef: 'sess-x',
    candidates: [{ ...candidates()[0], route: 'route.not-declared' }], wish: WISH,
    action: 'confirm', receipt: 'r-1', plugin: pluginA,
  }),
  Error,
  'B2B 端到端越权路由 → fail-closed 中止(不静默换路由)',
)

// ── 8. A/B 同业务 id 不串(事件/投影/approval/effect) ────────────────────────
const traceA = b2bTrace
const traceB = runBookingScenario({
  businessId: 'BIZ-1',
  travelerPrincipalId: 'traveler-001',
  sessionRef: 'sess-board-b',
  candidates: candidates(),
  wish: WISH,
  action: 'cancel',
  receipt: 'receipt-hb-fix-002',
  plugin: pluginB,
})
assert.equal(traceA.scope.sponsorId, 'sponsor-a-travel', 'A 事件 scope 携 sponsor-a')
assert.equal(traceB.scope.sponsorId, 'sponsor-b-board', 'B 事件 scope 携 sponsor-b')
assert.ok(traceA.events.every((e) => e.scope.sponsorId === 'sponsor-a-travel'), 'A 的全部事件归属 A(同业务 id 不串事件)')
assert.ok(traceB.events.every((e) => e.scope.sponsorId === 'sponsor-b-board'), 'B 的全部事件归属 B')
assert.notEqual(traceA.scope.key, traceB.scope.key, '同 businessId 不同 sponsor → scope 键不同(投影隔离)')
assert.equal(traceB.sagaStatus, 'compensated', 'B 走取消退款:propose→confirm→compensate')
assert.deepEqual(traceB.events.map((e) => e.kind), ['route.authorized', 'candidate.ranked', 'write.pending', 'write.confirmed', 'write.compensated'], '取消路径事件序列')
assert.deepEqual(traceB.sagaViolations, [], 'B 取消退款回放零违例(sponsor 形态同一取消/退款规则)')
// approval 不可跨 scope 重放:A 的 approval 绑到 B 的指纹 → 校验失败
const approvalB = bindApproval({ fingerprintSha256: traceB.events[3].fingerprintSha256!, receipt: 'receipt-hb-fix-002', travelerPrincipalId: 'traveler-001', sponsorId: 'sponsor-b-board' })
assert.equal(verifyApprovalBinding(traceA.events[3].fingerprintSha256!, approvalB), false, 'A 的指纹不接受 B 的 approval(BFF 重放/跨租户绑定拒绝)')
assert.deepEqual(traceA.sagaViolations, [], 'A 回放零违例')

console.log('SPONSOR REUSE TESTS: 8/8 OK(配置 fail-closed / 默认关激活门 / 越权路由拒绝 / 同内核零拷贝+C端隔离 / 佣金不伪造效用 / B2B fixture E2E+披露入指纹 / B2C 同 runner 零渗入+同 saga 边 / A/B 同业务id不串)')
