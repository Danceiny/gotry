/**
 * Money/FX fact 合同 v1 测试（issue #344 契约切片；全离线、零网络、零活体汇率源）：
 *
 *  A. 币种封闭集 + 原币金额解析（未知币种/小写/精度超位/千分位/指数记法 fail-closed；负值与零结构可载）
 *  B. FxFact 构建（全字段必填/fact_id 幂等/rate 归一；缺源·来源不明·缺时刻·日期无时刻·as_of 晚于抓取·
 *     零/负/伪精度汇率·同币种自兑·provenance 空 各负例；默认注册表为空 → 生产路径任何 provider 均拒）
 *  C. 单腿换算（精确 bigint·half-away-from-zero 落位·JPY 0 位指数·原币展示保留；
 *     供应商币种变化/方向拿反 显式拒绝）
 *  D. 同一估值时点比较（同 as_of 不同拼写可比/预算判定/聚合；混时点·午夜切换·旧 rate 钉时点·
 *     混币种·空聚合 各负例且错误带证据）
 *  E. 交叉汇率（两腿同 as_of 显式合成；混时点两腿拒绝）
 *  F. 契约 seam（注册表冻结为空/触发闸冻结 false；触发前 consultFxSources 结构化拒绝且
 *     fetch spy 零调用=零浮动汇率源被咨询；触发后 primary→fallback 顺位与 miss/error/stale 不伪装）
 *
 * 运行（在 ts/ 下）：npx tsx scripts/fx-contract-tests.ts
 */

import {
  FX_FACT_SCHEMA,
  FX_TRIGGER_FIRED,
  LIVE_FX_PROVIDER_DESCRIPTORS,
  FxContractError,
  type FxProviderDescriptor,
  type FxRateSource,
  buildFxFact,
  compareMoney,
  consultFxSources,
  convertMoney,
  convertMoneyViaPivot,
  formatMoney,
  parseCurrency,
  parseMoney,
  pinNativeMoney,
  sumMoney,
  withinBudget,
} from '../capabilities/fx-contract.ts'

let passed = 0
function check(cond: boolean, msg: string): void {
  if (cond) {
    passed++
    console.log(`  ok - ${msg}`)
  } else {
    console.error(`  FAIL - ${msg}`)
    process.exitCode = 1
  }
}

/** 负向断言：必须抛 FxContractError，且消息携带证据片段「needle」。 */
function expectReject(fn: () => unknown, needle: string, msg: string): void {
  try {
    fn()
    check(false, `${msg}（应拒绝但未拒绝）`)
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e)
    check(e instanceof FxContractError && text.includes(needle), `${msg}（拒绝且证据含「${needle}」）`)
  }
}

/** 测试专用离线 registry（仅存在于测试文件；生产注册表冻结为空）。 */
const TEST_REGISTRY: readonly FxProviderDescriptor[] = [
  { id: 'fixture-offline-table', tier: 'primary', legal_basis: 'test-only offline fixture table (no live source, issue #344 contract slice)' },
  { id: 'fixture-offline-fallback', tier: 'fallback', legal_basis: 'test-only offline fixture table (no live source, issue #344 contract slice)' },
]

const T1 = '2026-10-02T00:00:00.000Z'
const T1_ALT_SPELLING = '2026-10-02T08:00:00+08:00' // 与 T1 同一时刻的另一种拼写（+08:00 偏移）
const T2 = '2026-10-02T12:00:00.000Z'
const T_MIDNIGHT_BEFORE = '2026-10-01T23:59:59.000Z'
const T_MIDNIGHT_AFTER = '2026-10-02T00:00:01.000Z'

function fixtureFact(base: string, quote: string, rate: unknown, provider: string, asOf: string): ReturnType<typeof buildFxFact> {
  return buildFxFact(
    { base, quote, rate, provider, provenance: `[汇率:fixture@契约测试:${provider}]`, as_of: asOf, fetched_at: '2026-10-02T12:00:01.000Z' },
    TEST_REGISTRY,
  )
}

// ---------------------------------------------------------------- A. 币种与金额
console.log('A. 币种封闭集与原币金额解析')
check(parseCurrency('CNY') === 'CNY', '已知币种准入（CNY）')
expectReject(() => parseCurrency('usd'), 'uppercase 3-letter', '未知形态币种（小写 usd）拒绝')
expectReject(() => parseCurrency('XXY'), 'unknown currency code XXY', '未知币种（XXY 不在封闭集）拒绝')
expectReject(() => parseCurrency('US'), 'uppercase 3-letter', '两位币种码拒绝')
expectReject(() => parseCurrency(42), 'uppercase 3-letter', '非字符串币种拒绝')

check(parseMoney('CNY', '1234.56').amountMinor === 123456n, '金额解析：1234.56 CNY = 123456 最小单位')
check(formatMoney(parseMoney('CNY', '1234.56')) === '1234.56 CNY', '原币展示保留（1234.56 CNY）')
check(parseMoney('JPY', '1000').amountMinor === 1000n, 'JPY（0 位最小单位）整数金额解析')
check(parseMoney('CNY', '-50.00').amountMinor === -5000n, '负值金额结构可载（退款/抹零是真实数据）')
check(parseMoney('CNY', '0.00').amountMinor === 0n, '零金额结构可载')
check(formatMoney(parseMoney('CNY', '-50.00')) === '-50.00 CNY', '负值原币展示')
expectReject(() => parseMoney('JPY', '1000.5'), 'exceeds its 0-digit minor unit', 'JPY 带小数（亚最小单位精度）拒绝')
expectReject(() => parseMoney('CNY', '1,234.56'), 'no separators', '千分位分隔符拒绝')
expectReject(() => parseMoney('CNY', '1.234'), 'exceeds its 2-digit minor unit', 'CNY 三位小数拒绝')
expectReject(() => parseMoney('CNY', '1e3'), 'plain decimal', '指数记法金额拒绝')
expectReject(() => parseMoney('CNY', ' 12.34'), 'plain decimal', '带空白金额拒绝')

// ---------------------------------------------------------------- B. FxFact 构建
console.log('B. FxFact 构建（全字段必填 + fail-closed 负例）')
const usdCnyAtT1 = fixtureFact('USD', 'CNY', '7.20', 'fixture-offline-table', T1)
check(usdCnyAtT1.schema === FX_FACT_SCHEMA && FX_FACT_SCHEMA === 'gotry_fx_fact.v1', 'schema 版本化标识 gotry_fx_fact.v1')
check(usdCnyAtT1.rate === '7.2', 'rate 归一化（去尾零：7.20 → 7.2）')
check(usdCnyAtT1.as_of === T1 && usdCnyAtT1.fetched_at === '2026-10-02T12:00:01.000Z', 'as_of/fetched_at 规范化保留')
check(usdCnyAtT1.rounding === 'minor-unit-half-away-from-zero', '舍入规则冻结在事实内（可审计）')
const usdCnyAtT1Again = fixtureFact('USD', 'CNY', '7.2', 'fixture-offline-table', T1)
check(usdCnyAtT1.fact_id === usdCnyAtT1Again.fact_id, 'fact_id 幂等（rate 拼写差异不影响）')

expectReject(
  () => buildFxFact({ base: 'USD', quote: 'CNY', rate: '7.2', provider: 'mystery-rate-api', provenance: 'p', as_of: T1, fetched_at: T2 }, TEST_REGISTRY),
  'not admitted in the registry: "mystery-rate-api"',
  '来源不明（未注册 provider）拒绝',
)
expectReject(
  () => buildFxFact({ base: 'USD', quote: 'CNY', rate: '7.2', provider: '', provenance: 'p', as_of: T1, fetched_at: T2 }, TEST_REGISTRY),
  'non-empty source identifier',
  '缺源（provider 空串）拒绝',
)
expectReject(
  () => buildFxFact({ base: 'USD', quote: 'CNY', rate: '7.2', provider: undefined, provenance: 'p', as_of: T1, fetched_at: T2 }, TEST_REGISTRY),
  'non-empty source identifier',
  '缺源（provider 缺失）拒绝',
)
expectReject(
  () => buildFxFact({ base: 'USD', quote: 'CNY', rate: '7.2', provider: 'fixture-offline-table', provenance: 'p', as_of: T1, fetched_at: T2 }),
  'not admitted in the registry',
  '默认注册表（生产路径，冻结为空）任何 provider 均拒——零活体源',
)
expectReject(
  () => buildFxFact({ base: 'USD', quote: 'CNY', rate: '7.2', provider: 'no-basis-source', provenance: 'p', as_of: T1, fetched_at: T2 }, [{ id: 'no-basis-source', tier: 'primary', legal_basis: '' }]),
  'carries no legal_basis',
  'registry 条目缺 legal_basis（缺陷注册表）拒绝',
)

expectReject(
  () => buildFxFact({ base: 'USD', quote: 'CNY', rate: '7.2', provider: 'fixture-offline-table', provenance: 'p', as_of: '', fetched_at: T2 }, TEST_REGISTRY),
  'non-empty ISO-8601 UTC instant',
  '缺估值时刻（as_of 空串）拒绝',
)
expectReject(
  () => buildFxFact({ base: 'USD', quote: 'CNY', rate: '7.2', provider: 'fixture-offline-table', provenance: 'p', as_of: undefined, fetched_at: T2 }, TEST_REGISTRY),
  'non-empty ISO-8601 UTC instant',
  '缺估值时刻（as_of 缺失）拒绝',
)
expectReject(
  () => buildFxFact({ base: 'USD', quote: 'CNY', rate: '7.2', provider: 'fixture-offline-table', provenance: 'p', as_of: '2026-10-02', fetched_at: T2 }, TEST_REGISTRY),
  'date-only',
  '日期无时刻（date-only as_of）拒绝——非估值时点',
)
expectReject(
  () => buildFxFact({ base: 'USD', quote: 'CNY', rate: '7.2', provider: 'fixture-offline-table', provenance: 'p', as_of: 'not-a-time', fetched_at: T2 }, TEST_REGISTRY),
  'not a parseable ISO-8601 instant',
  '垃圾估值时刻拒绝',
)
expectReject(
  () => buildFxFact({ base: 'USD', quote: 'CNY', rate: '7.2', provider: 'fixture-offline-table', provenance: 'p', as_of: T1, fetched_at: '' }, TEST_REGISTRY),
  'non-empty ISO-8601 UTC instant',
  '缺抓取时刻（fetched_at 空串）拒绝',
)
expectReject(
  () => fixtureFact('USD', 'CNY', '7.2', 'fixture-offline-table', '2026-10-02T12:00:02.000Z'),
  'impossible provenance',
  'as_of 晚于 fetched_at（不可能的 provenance）拒绝',
)
expectReject(
  () => buildFxFact({ base: 'USD', quote: 'CNY', rate: '7.2', provider: 'fixture-offline-table', provenance: '', as_of: T1, fetched_at: T2 }, TEST_REGISTRY),
  'non-empty evidence-chain description',
  'provenance 空串拒绝',
)
expectReject(() => fixtureFact('USD', 'USD', '1', 'fixture-offline-table', T1), 'base and quote must differ', '同币种自兑（恒等汇率绕过证据）拒绝')

expectReject(() => fixtureFact('USD', 'CNY', '0', 'fixture-offline-table', T1), 'strictly positive', '零汇率拒绝')
expectReject(() => fixtureFact('USD', 'CNY', '-7.2', 'fixture-offline-table', T1), 'plain positive decimal', '负汇率拒绝（记法即拒）')
expectReject(() => fixtureFact('USD', 'CNY', '1e5', 'fixture-offline-table', T1), 'plain positive decimal', '指数记法汇率拒绝')
expectReject(() => fixtureFact('USD', 'CNY', '7.1234567890123', 'fixture-offline-table', T1), 'exceeds 12 fractional digits', '伪精度汇率（13 位小数）拒绝')
expectReject(() => fixtureFact('USD', 'CNY', 7.2, 'fixture-offline-table', T1), 'plain positive decimal', '非字符串汇率（浮点）拒绝')
expectReject(() => fixtureFact('XXY', 'CNY', '7.2', 'fixture-offline-table', T1), 'unknown currency code XXY', '事实构建侧未知币种拒绝')

// ---------------------------------------------------------------- C. 换算
console.log('C. 单腿换算（精确 bigint + 冻结舍入 + 原币保留）')
const usd100 = parseMoney('USD', '100.00')
const cny720 = convertMoney(usd100, 'CNY', usdCnyAtT1)
check(cny720.amountMinor === 72000n, 'USD 100.00 × 7.2 = CNY 720.00（72000 最小单位）')
check(cny720.valuationAsOf === T1, '换算值绑定估值时点 = fact.as_of')
check(formatMoney(cny720.original) === '100.00 USD', '原币金额与供应商金额原样保留')
check(cny720.original === usd100, 'original 即传入原币对象（零改写）')
check(cny720.fx.fact_id === usdCnyAtT1.fact_id && cny720.fx.provider === 'fixture-offline-table' && cny720.fx.rate === '7.2', '汇率证据引用完整（fact_id/provider/rate）')

const halfUp = convertMoney(parseMoney('USD', '0.01'), 'CNY', fixtureFact('USD', 'CNY', '7.5', 'fixture-offline-table', T1))
check(halfUp.amountMinor === 8n, 'half-away-from-zero 上取整：USD 0.01 × 7.5 = ¥0.075 → 0.08')
const halfDownNegative = convertMoney(parseMoney('USD', '-0.01'), 'CNY', fixtureFact('USD', 'CNY', '7.5', 'fixture-offline-table', T1))
check(halfDownNegative.amountMinor === -8n, '负值对称远离零：-¥0.075 → -0.08')
const jpyTarget = convertMoney(usd100, 'JPY', fixtureFact('USD', 'JPY', '150.5', 'fixture-offline-table', T1))
check(jpyTarget.amountMinor === 15050n && jpyTarget.currency === 'JPY', 'JPY 目标币（0 位最小单位）：USD 100 × 150.5 = 15050 円')
const zeroMoney = convertMoney(parseMoney('USD', '0.00'), 'CNY', usdCnyAtT1)
check(zeroMoney.amountMinor === 0n, '零金额换算确定性（0 × rate = 0）')

expectReject(
  () => convertMoney(parseMoney('EUR', '100.00'), 'CNY', usdCnyAtT1),
  'does not cover the requested conversion EUR→CNY',
  '供应商币种变化（fact 币种对不覆盖）显式拒绝',
)
expectReject(
  () => convertMoney(usd100, 'CNY', fixtureFact('CNY', 'USD', '0.1389', 'fixture-offline-table', T1)),
  'does not cover the requested conversion USD→CNY',
  '方向拿反（CNY→USD 腿不能反向用）拒绝',
)

// ---------------------------------------------------------------- D. 同一估值时点比较
console.log('D. 同一估值时点比较（混时点/午夜切换/旧 rate fail-closed）')
const usdCnyAtT1AltSpelling = fixtureFact('USD', 'CNY', '7.2', 'fixture-offline-table', T1_ALT_SPELLING)
check(usdCnyAtT1AltSpelling.as_of === T1, '时刻规范化：+08:00 偏移拼写归一到同一 UTC 毫秒时点')
const cny720Alt = convertMoney(usd100, 'CNY', usdCnyAtT1AltSpelling)
check(compareMoney(cny720, cny720Alt) === 0, '同一估值时点（不同拼写归一后）可比')

const budget1000 = pinNativeMoney(parseMoney('CNY', '1000.00'), T1)
check(compareMoney(cny720, budget1000) === -1 && withinBudget(cny720, budget1000) === true, '预算判定：¥720 ≤ ¥1000（FX 规范化值 vs 原生钉时点，同 as_of）')
const cny600 = pinNativeMoney(parseMoney('CNY', '600.00'), T1)
check(withinBudget(budget1000, cny600) === false, '预算判定方向语义：¥1000 ≤ ¥600 为假')
const summed = sumMoney([cny720, pinNativeMoney(parseMoney('CNY', '280.00'), T1)])
check(summed.amountMinor === 100000n && summed.valuationAsOf === T1, '聚合求和（同币种同 as_of：720+280=1000）')

const usdCnyAtT2 = fixtureFact('USD', 'CNY', '7.2', 'fixture-offline-fallback', T2)
const cny720AtT2 = convertMoney(usd100, 'CNY', usdCnyAtT2)
expectReject(() => compareMoney(cny720, cny720AtT2), '同一估值时点', '混时点比较显式拒绝（错误提示含规则名）')
expectReject(() => compareMoney(cny720, cny720AtT2), usdCnyAtT1.fact_id, '混时点错误携带 side A 证据（fact_id）')
expectReject(() => compareMoney(cny720, cny720AtT2), usdCnyAtT2.fact_id, '混时点错误携带 side B 证据（fact_id）')
expectReject(() => compareMoney(cny720, cny720AtT2), 'as_of 2026-10-02T00:00:00.000Z', '混时点错误携带两侧估值时点')
expectReject(() => withinBudget(cny720, cny720AtT2), '同一估值时点', '混时点预算判定拒绝')
expectReject(() => sumMoney([cny720, cny720AtT2]), 'money aggregation', '混时点聚合拒绝')

const midnightFact = fixtureFact('USD', 'CNY', '7.2', 'fixture-offline-table', T_MIDNIGHT_BEFORE)
const midnightOther = fixtureFact('USD', 'CNY', '7.2', 'fixture-offline-fallback', T_MIDNIGHT_AFTER)
expectReject(
  () => compareMoney(convertMoney(usd100, 'CNY', midnightFact), convertMoney(usd100, 'CNY', midnightOther)),
  'as_of 2026-10-01T23:59:59.000Z',
  '午夜切换：跨日 2 秒的相邻时点仍判混时点',
)

expectReject(
  () => convertMoney(usd100, 'CNY', usdCnyAtT1, T2),
  'does not match the pinned valuation instant',
  '旧 rate（钉住 T2 但只有 T1 事实）拒绝——stale 不伪装为当前准确换算',
)
expectReject(
  () => convertMoney(usd100, 'CNY', usdCnyAtT1, '2026-10-02'),
  'date-only',
  '钉住时点为日期无时刻也拒绝',
)
check(convertMoney(usd100, 'CNY', usdCnyAtT1, T1_ALT_SPELLING).amountMinor === 72000n, '钉住时点拼写不同但同时刻可换算')

const jpyCnyAtT1 = convertMoney(parseMoney('JPY', '20000'), 'CNY', fixtureFact('JPY', 'CNY', '0.048', 'fixture-offline-table', T1))
check(compareMoney(cny720, jpyCnyAtT1) === -1, '两条外币报价（USD/JPY）经各自 FX 事实规范化到 CNY 后同 as_of 可比（720 < 960）')
check(pinNativeMoney(parseMoney('CNY', '960.00'), T1).amountMinor === 96000n, '原生恒等钉时点保留金额（960.00 CNY）')
expectReject(() => pinNativeMoney(parseMoney('CNY', '1.00'), 'not-a-time'), 'not a parseable ISO-8601 instant', '原生钉时点同样要求合法时刻')
expectReject(() => sumMoney([]), 'at least one normalized amount', '空聚合拒绝（空聚合不是事实）')

// ---------------------------------------------------------------- E. 交叉汇率
console.log('E. 交叉汇率（两腿显式合成，同 as_of）')
const cnyThbAtT1 = fixtureFact('CNY', 'THB', '4.85', 'fixture-offline-table', T1)
const usdThb = convertMoneyViaPivot(usd100, 'CNY', 'THB', usdCnyAtT1, cnyThbAtT1)
check(usdThb.currency === 'THB' && usdThb.amountMinor === 349200n, 'USD 100 → CNY 720 → THB 3492.00（两腿同 as_of）')
expectReject(() => compareMoney(cny720, usdThb), 'same normalized currency', '未归一到同币种的比较拒绝（CNY vs THB，提示先规范化）')
check(usdThb.valuationAsOf === T1, '交叉汇率合成值绑定同一估值时点')
const cnyThbAtT2 = fixtureFact('CNY', 'THB', '4.85', 'fixture-offline-fallback', T2)
expectReject(
  () => convertMoneyViaPivot(usd100, 'CNY', 'THB', usdCnyAtT1, cnyThbAtT2),
  'must share the same valuation instant',
  '交叉汇率混时点两腿拒绝（错误含两腿 fact_id）',
)
expectReject(
  () => convertMoneyViaPivot(usd100, 'CNY', 'THB', usdCnyAtT1, cnyThbAtT2),
  cnyThbAtT2.fact_id,
  '交叉汇率混时点错误携带第二腿证据',
)

// ---------------------------------------------------------------- F. 契约 seam（零活体源咨询）
console.log('F. 契约 seam：触发前零浮动汇率源被咨询（D-26 边界不变）')
check(LIVE_FX_PROVIDER_DESCRIPTORS.length === 0, '运行时源注册表冻结为空')
check(FX_TRIGGER_FIRED === false, '触发闸冻结为 false（#344 触发后置）')

const deferred = await consultFxSources({ base: parseCurrency('USD'), quote: parseCurrency('CNY') })
check(deferred.ok === false && deferred.code === 'trigger-deferred', '触发未开：consultFxSources 结构化拒绝（trigger-deferred）')
check(deferred.ok === false && deferred.detail.includes('zero floating-rate sources consulted'), '拒绝理由明示「零浮动汇率源被咨询」与 D-26 边界')

let spyCalls = 0
const spySource: FxRateSource = {
  descriptor: TEST_REGISTRY[0]!,
  fetchRate: async () => {
    spyCalls++
    return { ok: true, fact: usdCnyAtT1 }
  },
}
const refused = await consultFxSources({ base: parseCurrency('USD'), quote: parseCurrency('CNY') }, { sources: [spySource], triggerFired: false })
check(refused.ok === false && refused.code === 'trigger-deferred', '即使传入源列表，触发未开仍在读源之前拒绝')
check(spyCalls === 0, 'fetch spy 零调用 = 零浮动汇率源被咨询（W2A 式 inert 合同）')

const noSource = await consultFxSources({ base: parseCurrency('USD'), quote: parseCurrency('CNY') }, { sources: [], triggerFired: true })
check(noSource.ok === false && noSource.code === 'no-source-admitted', '触发已开但注册表为空：no-source-admitted（不猜源）')

const viaSpy = await consultFxSources({ base: parseCurrency('USD'), quote: parseCurrency('CNY') }, { sources: [spySource], triggerFired: true })
check(viaSpy.ok === true && spyCalls === 1 && viaSpy.fact.fact_id === usdCnyAtT1.fact_id, 'seam 数据形状可用：触发后单源返回完整证据事实')

let primaryCalls = 0
let fallbackCalls = 0
const missPrimary: FxRateSource = {
  descriptor: { id: 'miss-primary', tier: 'primary', legal_basis: 'test-only' },
  fetchRate: async () => {
    primaryCalls++
    return { ok: false, code: 'miss', detail: 'no quote for pair at instant' }
  },
}
const fallbackSource: FxRateSource = {
  descriptor: { id: 'fallback-hit', tier: 'fallback', legal_basis: 'test-only' },
  fetchRate: async () => {
    fallbackCalls++
    return { ok: true, fact: usdCnyAtT1 }
  },
}
const degraded = await consultFxSources({ base: parseCurrency('USD'), quote: parseCurrency('CNY') }, { sources: [missPrimary, fallbackSource], triggerFired: true })
check(degraded.ok === true && primaryCalls === 1 && fallbackCalls === 1, '降级顺位形状：primary miss → fallback 命中（各一次）')
const allMiss = await consultFxSources({ base: parseCurrency('USD'), quote: parseCurrency('CNY') }, { sources: [missPrimary], triggerFired: true })
check(allMiss.ok === false && allMiss.code === 'miss', 'miss 不伪装为当前准确换算（结构化 miss 直传）')

console.log(`\nFX CONTRACT TESTS: ${passed} pass${process.exitCode ? ', FAIL' : ' (全绿)'}`)
