/**
 * Money/FX fact 合同 v1（issue #344 契约切片，创始人 2026-10-02 授权提前启动，默认关闭、零活体汇率源）。
 *
 * 形态（对齐 `ts/data/llm-price-table.json` 的 fail-closed 纪律与 gotry_bookable_fact 证据链形态）：
 *   - 类型化 Money（原币金额 = 币种 + 最小单位整数，杜绝浮点漂移）；
 *   - 类型化 FxFact（base/quote 汇率事实：rate + provider + provenance + as_of 估值时点 + fetched_at 抓取时刻，
 *     全字段必填，unknown/missing 一律 fail-closed，禁止猜测汇率——与「未知模型不猜价」同一条纪律）；
 *   - 主源+降级只做契约 seam（FxProviderDescriptor/FxRateSource 接口与数据形状）：
 *     运行时注册表冻结为空（LIVE_FX_PROVIDER_DESCRIPTORS = []），FX_TRIGGER_FIRED = false；
 *     触发前零浮动汇率源被咨询（consultFxSources 在读任何源之前直接结构化拒绝，docs/architecture.md §10 D-26 边界不变）；
 *   - 同一估值时点比较：跨币种比较/聚合必须经同一 as_of 的规范化值（NormalizedAmount），
 *     混时点比较显式拒绝（fail-closed 并给出带证据的错误）；无宽限期数值——估值时点绑定即口径，
 *     stale/miss/error 不得伪装为当前准确换算（不发明容差）。
 *
 * 冻结的舍入规则：仅在「换算落位到目标币种最小单位」这一步舍入，half-away-from-zero；
 * 交叉汇率（经中转币两腿）每腿落位一次（中间腿按中转币最小单位舍入），无中间无理数携带。
 *
 * 边界（D-26 / #344 触发后置保持）：
 *   - 本模块纯函数、零 IO、零网络、零依赖新增；
 *   - 不选定任何主源/降级源（那是触发后 founders 决策）；注册表非空 + FX_TRIGGER_FIRED 置真
 *     都需要真实非 CNY 供应商报价、用户预算或目的地需求触发后另行准入；
 *   - CNY-only 结算路径不受影响（现有 budgetCny/priceCny 算术不动，ts/src/model.ts 内核钉住未改）。
 *
 * @module capabilities/fx-contract
 */

import { makeFactId } from '../src/bookable-facts.ts'

/** 合同 schema 标识（版本化，读取端校验）。 */
export const FX_FACT_SCHEMA = 'gotry_fx_fact.v1'

/** 币种封闭集：ISO 4217 字母码 → 最小单位指数（客观公共标准数据，类比 IANA 时区名的运行时权威口径；
 * 未知币种不在集内即 fail-closed，不做任何猜测映射）。 */
const ISO_4217_MINOR_UNIT_EXPONENTS: Readonly<Record<string, number>> = {
  CNY: 2, USD: 2, EUR: 2, GBP: 2, HKD: 2, SGD: 2, THB: 2, MYR: 2,
  JPY: 0, KRW: 0,
}

/** 币种（经 parseCurrency 校验的品牌类型载体）。 */
export type FxCurrency = string & { readonly __fxCurrency: unique symbol }

/** 合同违规（fail-closed）：消息必须带证据（两侧估值时点/fact_id/provider 等）。 */
export class FxContractError extends Error {
  constructor(message: string) {
    super(`fx contract: ${message} (fail-closed, no guessed rate)`)
    this.name = 'FxContractError'
  }
}

/** 解析并准入币种：必须是大写三字母且在封闭集内；未知/小写/变体一律拒绝。 */
export function parseCurrency(code: unknown): FxCurrency {
  if (typeof code !== 'string' || !/^[A-Z]{3}$/.test(code)) {
    throw new FxContractError(`currency code must be an uppercase 3-letter ISO 4217 code, got: ${JSON.stringify(code)}`)
  }
  const exponent = ISO_4217_MINOR_UNIT_EXPONENTS[code]
  if (exponent === undefined) {
    throw new FxContractError(
      `unknown currency code ${code} not in the frozen closed set [${Object.keys(ISO_4217_MINOR_UNIT_EXPONENTS).join('/')}] — extend the set via PR`,
    )
  }
  return code as FxCurrency
}

/** 币种最小单位指数（ISO 4217）。 */
export function currencyExponent(currency: FxCurrency): number {
  const exponent = ISO_4217_MINOR_UNIT_EXPONENTS[currency]
  if (exponent === undefined) throw new FxContractError(`unknown currency ${currency}`)
  return exponent
}

/** 原币金额：金额恒为「该币种最小单位的整数」（无浮点）；负值/零结构上允许（退款、抹零是真实数据），
 * 语义约束由消费面（预算/比较）决定；原币展示恒保留（formatMoney）。 */
export interface MoneyAmount {
  readonly currency: FxCurrency
  readonly amountMinor: bigint
}

/** 严格十进制金额解析：`-?(0|[1-9][0-9]*)(\.[0-9]+)?`——无千分位、无指数记法、
 * 小数位不得超过币种最小单位指数（JPY「0.5」即拒）。 */
export function parseMoney(currency: unknown, decimal: unknown): MoneyAmount {
  const cur = parseCurrency(currency)
  if (typeof decimal !== 'string' || !/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(decimal)) {
    throw new FxContractError(
      `money decimal for ${cur} must be a plain decimal like '1234.56' (no separators/exponent/plus), got: ${JSON.stringify(decimal)}`,
    )
  }
  const negative = decimal.startsWith('-')
  const unsigned = negative ? decimal.slice(1) : decimal
  const [intPart, fracPart = ''] = unsigned.split('.')
  const exponent = currencyExponent(cur)
  if (fracPart.length > exponent) {
    throw new FxContractError(
      `money decimal ${decimal} for ${cur} exceeds its ${exponent}-digit minor unit (sub-minor precision rejected, no silent rounding)`,
    )
  }
  const padded = (fracPart + '0'.repeat(exponent)).slice(0, exponent)
  const magnitude = BigInt(intPart + padded)
  return { currency: cur, amountMinor: negative ? -magnitude : magnitude }
}

/** 原币展示（验收 3：保留原币展示与供应商金额）。 */
export function formatMoney(money: MoneyAmount): string {
  const exponent = currencyExponent(money.currency)
  const negative = money.amountMinor < 0n
  const magnitude = negative ? -money.amountMinor : money.amountMinor
  const digits = magnitude.toString().padStart(exponent + 1, '0')
  const body = exponent === 0 ? digits : `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`
  return `${negative ? '-' : ''}${body} ${money.currency}`
}

/** 汇率事实（gotry_fx_fact.v1）：全字段必填。
 * rate = 每 1 单位 base 兑换的 quote 数（严格十进制字符串，无符号/指数记法，必须 > 0，小数位 ≤ 12）。
 * as_of = 估值时点（该汇率适用的报价时点，完整 UTC 时刻，规范化到毫秒 ISO 串）；
 * fetched_at = 抓取时刻（我们观察到该证据的时刻）；provenance = 来源证据链描述（非空）。 */
export interface FxFact {
  readonly schema: typeof FX_FACT_SCHEMA
  readonly fact_id: string
  readonly base: FxCurrency
  readonly quote: FxCurrency
  readonly rate: string
  readonly provider: string
  readonly provenance: string
  readonly as_of: string
  readonly fetched_at: string
  readonly rounding: 'minor-unit-half-away-from-zero'
}

/** UTC 时刻解析与规范化：接受完整 ISO-8601 时刻（含 Z/偏移），规范化为毫秒精度 UTC ISO 串；
 * 仅日期（无时刻）、垃圾串、缺值一律拒绝（缺时刻 fail-closed）。 */
export function parseUtcInstant(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new FxContractError(`${label} must be a non-empty ISO-8601 UTC instant string, got: ${JSON.stringify(value)}`)
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    throw new FxContractError(`${label} must carry a full time-of-day (date-only '${value}' is not a valuation instant — mixed-date comparison would be ambiguous)`)
  }
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) {
    throw new FxContractError(`${label} is not a parseable ISO-8601 instant: ${JSON.stringify(value)}`)
  }
  return new Date(ms).toISOString()
}

/** 汇率严格十进制解析：无符号、无指数记法、必须严格大于 0（零/负汇率不是事实）、小数位 ≤ 12。
 * 返回归一化字符串（去尾零）+ 分子 + 小数位，供精确 bigint 换算与 fact_id 幂等。 */
function parseRateDecimal(rate: unknown): { normalized: string; numerator: bigint; scale: number } {
  if (typeof rate !== 'string' || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(rate)) {
    throw new FxContractError(
      `fx rate must be a plain positive decimal like '7.25' (no sign/exponent/separators), got: ${JSON.stringify(rate)}`,
    )
  }
  const [intPart, fracPart = ''] = rate.split('.') as [string, string?]
  if (fracPart.length > 12) {
    throw new FxContractError(`fx rate ${rate} exceeds 12 fractional digits (absurd precision is not evidence)`)
  }
  const trimmedFrac = (fracPart as string).replace(/0+$/, '')
  const normalized = trimmedFrac.length === 0 ? intPart : `${intPart}.${trimmedFrac}`
  const numerator = BigInt(intPart + trimmedFrac)
  if (numerator <= 0n) {
    throw new FxContractError(`fx rate must be strictly positive, got: ${rate} (zero/negative rate is never a valid conversion fact)`)
  }
  return { normalized, numerator, scale: trimmedFrac.length }
}

/** 精确除法 + half-away-from-zero 落位（冻结舍入规则的实现核心）。 */
function roundDivHalfAwayFromZero(n: bigint, d: bigint): bigint {
  const sign = n < 0n ? -1n : 1n
  const magnitude = n < 0n ? -n : n
  const q = magnitude / d
  const rem = magnitude % d
  return sign * (rem * 2n >= d ? q + 1n : q)
}

// ---------------------------------------------------------------------------
// 契约 seam：主源 + 降级（仅接口与数据形状；触发前零活体源，注册表冻结为空）
// ---------------------------------------------------------------------------

/** 源准入描述（数据形状）：注册时必须给出合法使用依据；tier=primary 主源 / fallback 降级。 */
export interface FxProviderDescriptor {
  readonly id: string
  readonly tier: 'primary' | 'fallback'
  /** 为何可合法使用（许可/官方免费档/内部桥授权）；空串或缺失即拒绝注册。 */
  readonly legal_basis: string
}

/** 汇率源接口（数据形状）：一次抓取必须返回完整证据的 FxFact 或结构化 miss/stale/error——
 * 任何 miss/stale/error 不得伪装为当前准确换算（降级链同理，最终仍要走 buildFxFact 校验）。 */
export interface FxRateSource {
  readonly descriptor: FxProviderDescriptor
  fetchRate(query: { base: FxCurrency; quote: FxCurrency; asOf?: string }): Promise<
    | { ok: true; fact: FxFact }
    | { ok: false; code: 'miss' | 'stale' | 'error'; detail: string }
  >
}

/** 运行时源注册表：冻结为空（触发后置，D-26 边界不变）。任何非空变更都是创始人准入决策。 */
export const LIVE_FX_PROVIDER_DESCRIPTORS: readonly FxProviderDescriptor[] = []

/** FX 实现触发闸：冻结为 false。置真 = 首条真实非 CNY 供应商报价、用户预算或目的地需求已出现（#344 触发条件）。 */
export const FX_TRIGGER_FIRED = false

/** 咨询活体汇率源的唯一入口。触发未开（FX_TRIGGER_FIRED=false）时在读任何源之前直接结构化拒绝
 * （零浮动汇率源被咨询）；触发后按 primary→fallback 顺位，且每条结果仍必须过 buildFxFact 全字段校验。 */
export async function consultFxSources(
  query: { base: FxCurrency; quote: FxCurrency; asOf?: string },
  options?: { sources?: readonly FxRateSource[]; triggerFired?: boolean },
): Promise<
  | { ok: true; fact: FxFact }
  | { ok: false; code: 'trigger-deferred' | 'no-source-admitted' | 'miss' | 'stale' | 'error'; detail: string }
> {
  const triggerFired = options?.triggerFired ?? FX_TRIGGER_FIRED
  const sources = options?.sources ?? []
  if (!triggerFired) {
    return {
      ok: false,
      code: 'trigger-deferred',
      detail: 'FX implementation trigger has not fired (#344: first real non-CNY supplier quote, user budget, or destination demand); zero floating-rate sources consulted (D-26 boundary unchanged)',
    }
  }
  if (sources.length === 0) {
    return { ok: false, code: 'no-source-admitted', detail: 'no FX provider admitted in the registry; admitting one is a founder decision with legal_basis' }
  }
  let lastMiss: { ok: false; code: 'miss' | 'stale' | 'error'; detail: string } | undefined
  for (const source of sources) {
    const out = await source.fetchRate(query)
    if (out.ok) return { ok: true, fact: out.fact }
    lastMiss = out
  }
  return lastMiss ?? { ok: false, code: 'miss', detail: 'no FX source produced a rate' }
}

/** 构建汇率事实（全字段必填校验入口，对齐价格表「未知模型即拒」的纪律）。
 * registry 默认 = 冻结空的运行时注册表 → 生产路径任何 provider 都被拒（来源不明）；
 * 测试/未来适配器以显式注入的 registry 构造离线事实。 */
export function buildFxFact(
  input: {
    base: unknown
    quote: unknown
    rate: unknown
    provider: unknown
    provenance: unknown
    as_of: unknown
    fetched_at: unknown
  },
  registry: readonly FxProviderDescriptor[] = LIVE_FX_PROVIDER_DESCRIPTORS,
): FxFact {
  const base = parseCurrency(input.base)
  const quote = parseCurrency(input.quote)
  if (base === quote) {
    throw new FxContractError(`base and quote must differ (${base}→${quote}); an identity rate would bypass conversion evidence`)
  }
  const rate = parseRateDecimal(input.rate)
  if (typeof input.provider !== 'string' || input.provider.length === 0) {
    throw new FxContractError(`fx fact provider must be a non-empty source identifier, got: ${JSON.stringify(input.provider)}`)
  }
  const descriptor = registry.find(d => d.id === input.provider)
  if (!descriptor) {
    throw new FxContractError(
      `fx fact provider not admitted in the registry: ${JSON.stringify(input.provider)} (来源不明 fail-closed; admitted: [${registry.map(d => d.id).join('/') || 'none'}])`,
    )
  }
  if (typeof descriptor.legal_basis !== 'string' || descriptor.legal_basis.length === 0) {
    throw new FxContractError(`admitted provider ${descriptor.id} carries no legal_basis — registry entry is defective`)
  }
  if (typeof input.provenance !== 'string' || input.provenance.length === 0) {
    throw new FxContractError(`fx fact provenance must be a non-empty evidence-chain description, got: ${JSON.stringify(input.provenance)}`)
  }
  const asOf = parseUtcInstant(input.as_of, 'fx fact as_of (估值时点)')
  const fetchedAt = parseUtcInstant(input.fetched_at, 'fx fact fetched_at (抓取时刻)')
  if (asOf > fetchedAt) {
    throw new FxContractError(`fx fact as_of ${asOf} is later than fetched_at ${fetchedAt} — impossible provenance (valuation instant must not postdate observation)`)
  }
  return {
    schema: FX_FACT_SCHEMA,
    fact_id: makeFactId(['fx', base, quote, descriptor.id, asOf, rate.normalized]),
    base,
    quote,
    rate: rate.normalized,
    provider: descriptor.id,
    provenance: input.provenance,
    as_of: asOf,
    fetched_at: fetchedAt,
    rounding: 'minor-unit-half-away-from-zero',
  }
}

// ---------------------------------------------------------------------------
// 换算与同一估值时点比较
// ---------------------------------------------------------------------------

/** 规范化金额：换算落位后的目标币金额 + 它所绑定的估值时点与汇率证据引用。 */
export interface NormalizedAmount {
  readonly currency: FxCurrency
  readonly amountMinor: bigint
  /** 估值时点（= 所用 FxFact.as_of 规范化毫秒 UTC 串）：比较/聚合的时点绑定键。 */
  readonly valuationAsOf: string
  /** 汇率证据引用（比较/拒绝时回溯用）。 */
  readonly fx: { fact_id: string; provider: string; base: FxCurrency; quote: FxCurrency; rate: string }
}

/** 规范化后的钱（验收 3）：目标币规范化值 + 原币金额原样保留（供应商金额不丢）。 */
export interface NormalizedMoney extends NormalizedAmount {
  readonly original: MoneyAmount
}

/** 原币即比较币时的恒等钉时点：金额不经任何汇率（同币种 rate=1 是恒等式，不是汇率猜测），
 * 只把估值时点绑定到规范化值上，使原生币种金额能与 FX 规范化金额在同一口径下比较/聚合。 */
export function pinNativeMoney(money: MoneyAmount, valuationAsOf: string): NormalizedMoney {
  const pinned = parseUtcInstant(valuationAsOf, 'native pin valuation as_of')
  return {
    currency: money.currency,
    amountMinor: money.amountMinor,
    valuationAsOf: pinned,
    fx: { fact_id: `native:${money.currency}`, provider: 'native-identity', base: money.currency, quote: money.currency, rate: '1' },
    original: money,
  }
}

/** 校验 FxFact 覆盖给定换算对（供应商币种变化/拿错腿在此显式拒绝）。 */
function assertFactPair(fact: FxFact, from: FxCurrency, to: FxCurrency): void {
  if (fact.base !== from || fact.quote !== to) {
    throw new FxContractError(
      `fx fact ${fact.fact_id} pair ${fact.base}→${fact.quote} does not cover the requested conversion ${from}→${to} (supplier currency changed or wrong leg — no cross-pair substitution)`,
    )
  }
}

/** 断言 fact 的估值时点等于调用方钉住的估值时点（旧 rate 不得混入新时点比较；无宽限数值，精确绑定）。 */
function assertPinnedValuation(fact: FxFact, pinnedAsOf: string | undefined): void {
  if (pinnedAsOf === undefined) return
  const pinned = parseUtcInstant(pinnedAsOf, 'pinned valuation as_of')
  if (fact.as_of !== pinned) {
    throw new FxContractError(
      `fx fact ${fact.fact_id} (${fact.base}→${fact.quote}, provider ${fact.provider}) as_of ${fact.as_of} does not match the pinned valuation instant ${pinned} — stale/未对齐 rate 不得当作该时点的准确换算`,
    )
  }
}

function fxRef(fact: FxFact): NormalizedAmount['fx'] {
  return { fact_id: fact.fact_id, provider: fact.provider, base: fact.base, quote: fact.quote, rate: fact.rate }
}

/** 单腿换算：money × rate，仅在目标币最小单位落位时舍入（half-away-from-zero）。
 * valuationAsOf 可选钉住时点：给了就必须与 fact.as_of 完全一致（混时点 fail-closed）。 */
export function convertMoney(
  money: MoneyAmount,
  target: unknown,
  fact: FxFact,
  valuationAsOf?: string,
): NormalizedMoney {
  const targetCurrency = parseCurrency(target)
  assertFactPair(fact, money.currency, targetCurrency)
  assertPinnedValuation(fact, valuationAsOf)
  const fromExponent = currencyExponent(money.currency)
  const toExponent = currencyExponent(targetCurrency)
  const rate = parseRateDecimal(fact.rate)
  // amountMinor × rateNumerator × 10^toExponent / 10^(fromExponent + rateScale)
  const numerator = money.amountMinor * rate.numerator * 10n ** BigInt(toExponent)
  const denominator = 10n ** BigInt(fromExponent + rate.scale)
  const amountMinor = roundDivHalfAwayFromZero(numerator, denominator)
  return {
    currency: targetCurrency,
    amountMinor,
    valuationAsOf: fact.as_of,
    fx: fxRef(fact),
    original: money,
  }
}

/** 交叉汇率（两腿显式合成）：两腿估值时点必须完全一致（混时点显式拒绝，带两侧证据）；
 * 中间腿按中转币最小单位落位一次（冻结规则，无隐藏精度携带）。 */
export function convertMoneyViaPivot(
  money: MoneyAmount,
  pivot: unknown,
  target: unknown,
  legBaseToPivot: FxFact,
  legPivotToTarget: FxFact,
  valuationAsOf?: string,
): NormalizedMoney {
  if (legBaseToPivot.as_of !== legPivotToTarget.as_of) {
    throw new FxContractError(
      `cross-rate legs must share the same valuation instant: leg1 ${legBaseToPivot.base}→${legBaseToPivot.quote} (${legBaseToPivot.provider}, ${legBaseToPivot.fact_id}) as_of ${legBaseToPivot.as_of} vs leg2 ${legPivotToTarget.base}→${legPivotToTarget.quote} (${legPivotToTarget.provider}, ${legPivotToTarget.fact_id}) as_of ${legPivotToTarget.as_of} — 混时点合成拒绝`,
    )
  }
  const pivotCurrency = parseCurrency(pivot)
  const intermediate = convertMoney(money, pivotCurrency, legBaseToPivot, valuationAsOf)
  const pivotMoney: MoneyAmount = { currency: pivotCurrency, amountMinor: intermediate.amountMinor }
  return convertMoney(pivotMoney, target, legPivotToTarget, valuationAsOf)
}

/** 混时点/混币种比较的带证据拒绝。 */
function assertSameComparisonBasis(a: NormalizedAmount, b: NormalizedAmount, op: string): void {
  if (a.currency !== b.currency) {
    throw new FxContractError(
      `${op} requires the same normalized currency: ${a.currency} (fx ${a.fx.provider} ${a.fx.fact_id}) vs ${b.currency} (fx ${b.fx.provider} ${b.fx.fact_id}) — normalize both sides first`,
    )
  }
  if (a.valuationAsOf !== b.valuationAsOf) {
    throw new FxContractError(
      `${op} requires the same valuation instant (同一估值时点): side A ${a.currency} as_of ${a.valuationAsOf} (fx ${a.fx.provider} ${a.fx.fact_id} ${a.fx.base}→${a.fx.quote} @${a.fx.rate}) vs side B ${b.currency} as_of ${b.valuationAsOf} (fx ${b.fx.provider} ${b.fx.fact_id} ${b.fx.base}→${b.fx.quote} @${b.fx.rate}) — 混时点比较显式拒绝`,
    )
  }
}

/** 比较（预算比较的唯一口径）：两侧必须同为规范化值、同币种、同一估值时点。返回 -1/0/1。 */
export function compareMoney(a: NormalizedAmount, b: NormalizedAmount): -1 | 0 | 1 {
  assertSameComparisonBasis(a, b, 'money comparison')
  if (a.amountMinor < b.amountMinor) return -1
  if (a.amountMinor > b.amountMinor) return 1
  return 0
}

/** 预算判定（验收 3 的比较口径）：total ≤ budget，同一估值时点。 */
export function withinBudget(total: NormalizedAmount, budget: NormalizedAmount): boolean {
  return compareMoney(total, budget) <= 0
}

/** 聚合（求和）：非空、同币种、同一估值时点；返回保留该估值时点的规范化金额。 */
export function sumMoney(items: readonly NormalizedAmount[]): NormalizedAmount {
  if (items.length === 0) {
    throw new FxContractError('sumMoney requires at least one normalized amount (empty aggregate is not a fact)')
  }
  const [first, ...rest] = items
  for (const item of rest) assertSameComparisonBasis(first, item, 'money aggregation')
  let total = 0n
  for (const item of items) total += item.amountMinor
  return { currency: first.currency, amountMinor: total, valuationAsOf: first.valuationAsOf, fx: first.fx }
}
