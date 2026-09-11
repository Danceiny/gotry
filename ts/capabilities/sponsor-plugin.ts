/**
 * sponsor 插件契约面(issue #235,M6 备产;B2B principal/sponsor 插件化与同内核端到端复用证明)。
 *
 * ⚠ 非运行时激活:本模块是纯函数契约层——不 spawn 子进程、不发起网络请求、不读取任何凭据、
 * 不接真实供应商/交易调用;运行激活默认关闭(SPONSOR_RUNTIME_ACTIVATION_DEFAULT=false,
 * 未来真实运行时接线必须挂显式 opt-in 门,形态同 #318 GOTRY_HBCLI_LIVE,且在 #137 M6 Entry
 * 之后)。一切行为由 fixture 合成数据证明(sponsor-reuse-tests,run-all §61)。
 *
 * 定位(milestones/m6-b2b-reuse-walkthrough.md,P6 draft;issue #137 总控):
 *   - 三主体分离:traveler principal(动机主体)/sponsor(商业与库存主体)/BFF principal
 *     (鉴权主体,ADR-23)三个词位互不混用——sponsor 配置里三者缺一即拒,sponsorId
 *     冒充 traveler principal 结构性拒绝;
 *   - sponsor 只包三个插件槽:入口(路由授权)、库存池(候选)、配置/披露(佣金+偏置声明),
 *     不写 MotivationProfile,不改旅行者约束;
 *   - 同内核复用证明面:本模块只 import 内核函数(src/booking-saga.ts 的
 *     booking_saga_fsm.v1 状态机 + src/wish-pool.ts 的条件评分),零拷贝零重声明;
 *     B2C 与 B2B 两种形态由同一 runner(runBookingScenario)以"是否携带 sponsor 插件"
 *     参数化,saga 边序列逐格相同——内核 diff 为零即本件证明目标
 *     (PR 内核文件 diff 必须为空,内核漂移即本套件红);
 *   - 隔离:C 端默认路径不 import 本模块(sponsor-reuse-tests 4c 机械闸),
 *     无插件参数即 B2C 形态,trace 经 sponsorLeakFindings 检查零 sponsor 字段。
 *
 * 红线(结构性编码,全部 fixture 证明):
 *   - 排序不能以赞助收益伪造用户效用:候选必须先过内核条件评分(全命中强制),
 *     佣金不可赎回未命中的条件;同分 tie-break 只按 sponsor 申报顺位,
 *     且赞助受益位必须显式标记 sponsorTieBreakApplied 并携偏置声明;
 *   - sponsor 佣金/收益明确披露并进入确认指纹:disclosureDigestSha256 参与
 *     buildConfirmationFingerprint——披露口径变化则确认指纹变化;
 *   - 相同 WriteGate 与未知态/取消退款规则:确认必携外部回执(空 receipt 两种形态同拒,
 *     无 B2B 豁免);取消退款走同一内核边表(propose→confirm→compensate),回放零违例;
 *   - 路由授权:供应商 route 必须在 sponsor 声明的授权闭集内(selector)+ session/order
 *     绑定——禁止复制 Buyer/credentials 规避(本模块全链无凭据字段)。
 */

import { createHash } from 'node:crypto'
import {
  resolveSagaTrigger,
  sagaTraceViolations,
  type SagaAuditEvent,
  type SagaStatus,
} from '../src/booking-saga.ts'
import { scoreWishMatch, type WishMatchContext } from '../src/wish-pool.ts'

export const SPONSOR_PLUGIN_SCHEMA = 'sponsor.plugin.v1'

/** 运行激活默认态:关闭。真实运行时激活属 M6 Entry(#137)后的显式 opt-in 面。 */
export const SPONSOR_RUNTIME_ACTIVATION_DEFAULT = false

function sha256Canon(value: unknown): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon)
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canon(x)]))
    }
    return v
  }
  return createHash('sha256').update(JSON.stringify(canon(value))).digest('hex')
}

function requireNonEmpty(field: string, value: unknown): string {
  const v = typeof value === 'string' ? value.trim() : ''
  if (!v) throw new Error(`sponsor-plugin: 缺必填字段 ${field}(fail-closed;三主体与披露口径缺一即拒)`)
  return v
}

/** sponsor 插件配置(三主体分离 + 授权路由闭集 + 披露口径;词汇走 sponsor.* 命名空间)。 */
export interface SponsorPluginConfig {
  readonly sponsorId: string
  /** traveler principal:动机主体(walkthrough §1;与 sponsor/BFF 互不混用) */
  readonly travelerPrincipalId: string
  /** BFF principal:鉴权主体(ADR-23;只进鉴权与请求绑定) */
  readonly bffPrincipalId: string
  /** 授权路由闭集:supplier route selector;sponsor 只能在这批路由上提出候选 */
  readonly allowedRoutes: readonly string[]
  readonly disclosure: {
    /** 佣金(基点,非负整数)——必须显式申报,未申报即拒(验收§3:佣金/收益明确披露) */
    readonly commissionBps: number
    /** 披露文案(对旅行者可见) */
    readonly statement: string
    /** 排序偏置声明(同分 tie-break 必须展示给旅行者) */
    readonly rankingBiasNotice: string
  }
}

export interface SponsorPlugin {
  readonly schemaVersion: typeof SPONSOR_PLUGIN_SCHEMA
  readonly config: Readonly<SponsorPluginConfig>
  /** 披露口径摘要(佣金+文案+偏置声明);进入确认指纹 */
  readonly disclosureDigestSha256: string
}

/**
 * 构造 sponsor 插件(fail-closed):三主体标识、授权路由闭集、披露口径缺一即拒;
 * sponsorId 与 travelerPrincipalId 混同(三主体边界破坏)即拒。
 */
export function createSponsorPlugin(config: SponsorPluginConfig): SponsorPlugin {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('sponsor-plugin: 配置必须是对象(fail-closed)')
  }
  const sponsorId = requireNonEmpty('sponsorId', config.sponsorId)
  const travelerPrincipalId = requireNonEmpty('travelerPrincipalId', config.travelerPrincipalId)
  const bffPrincipalId = requireNonEmpty('bffPrincipalId', config.bffPrincipalId)
  if (sponsorId === travelerPrincipalId) {
    throw new Error('sponsor-plugin: sponsorId 不得与 travelerPrincipalId 相同(traveler/sponsor/BFF 三主体分离,walkthrough §1)')
  }
  const routes = config.allowedRoutes
  if (!Array.isArray(routes) || routes.length === 0) {
    throw new Error('sponsor-plugin: allowedRoutes 必须是非空数组(授权路由闭集;空闭集 = 不可提出任何候选)')
  }
  const cleaned = routes.map((r) => requireNonEmpty('allowedRoutes[]', r))
  if (new Set(cleaned).size !== cleaned.length) {
    throw new Error('sponsor-plugin: allowedRoutes 存在重复(授权闭集必须无歧义)')
  }
  const d = (config.disclosure ?? {}) as Partial<SponsorPluginConfig['disclosure']>
  const statement = requireNonEmpty('disclosure.statement', d.statement)
  const rankingBiasNotice = requireNonEmpty('disclosure.rankingBiasNotice', d.rankingBiasNotice)
  if (typeof d.commissionBps !== 'number' || !Number.isInteger(d.commissionBps) || d.commissionBps < 0) {
    throw new Error('sponsor-plugin: disclosure.commissionBps 必须是非负整数基点(佣金必须显式申报)')
  }
  const frozen: SponsorPluginConfig = Object.freeze({
    sponsorId,
    travelerPrincipalId,
    bffPrincipalId,
    allowedRoutes: Object.freeze(cleaned),
    disclosure: Object.freeze({ commissionBps: d.commissionBps, statement, rankingBiasNotice }),
  })
  return Object.freeze({
    schemaVersion: SPONSOR_PLUGIN_SCHEMA,
    config: frozen,
    disclosureDigestSha256: sha256Canon({ sponsorId, ...frozen.disclosure }),
  })
}

/**
 * 运行激活门(默认关闭):除显式 true 外一律抛错。
 * 本件(#235)是结构性证明,不是运行时激活——真实交易路径在 #137 M6 Entry 之后。
 */
export function requireRuntimeActivation(enabled: boolean): void {
  if (enabled !== true) {
    throw new Error('sponsor-plugin: 运行激活默认关闭(SPONSOR_RUNTIME_ACTIVATION_DEFAULT=false);真实运行时接线须显式 opt-in 且在 #137 M6 Entry 之后')
  }
}

// ── 路由授权(入口插件槽) ────────────────────────────────────────────────────

export type SponsorRouteAuthorization =
  | { ok: true; route: string; sessionRef: string; orderRef: string | null }
  | { ok: false; reason: 'route-unauthorized' | 'missing-session-binding'; detail: string }

/**
 * 供应商路由授权:路由必须在 sponsor 声明的授权闭集内(selector),且必须携带
 * session 绑定(order 可选)——缺绑定即拒,禁止以复制 Buyer/credentials 方式规避
 * (本模块全链无凭据字段;授权只认 principal 标识 + 会话/订单引用)。
 */
export function authorizeSponsorRoute(
  plugin: SponsorPlugin,
  route: string,
  binding: { sessionRef?: string | null; orderRef?: string | null },
): SponsorRouteAuthorization {
  if (!plugin.config.allowedRoutes.includes(route)) {
    return { ok: false, reason: 'route-unauthorized', detail: `路由 ${route} 不在 sponsor ${plugin.config.sponsorId} 的授权闭集内(越权路由拒绝)` }
  }
  const sessionRef = typeof binding.sessionRef === 'string' ? binding.sessionRef.trim() : ''
  if (!sessionRef) {
    return { ok: false, reason: 'missing-session-binding', detail: '授权路由缺 session/order 绑定(禁止复制 Buyer/credentials 规避)' }
  }
  const orderRef = typeof binding.orderRef === 'string' && binding.orderRef.trim() ? binding.orderRef.trim() : null
  return { ok: true, route, sessionRef, orderRef }
}

// ── 库存池评分(库存插件槽;同一内核评分函数,两形态共用) ─────────────────────

export interface SponsorCandidate {
  readonly candidateRef: string
  /** 必须落在 sponsor 授权路由闭集内 */
  readonly route: string
  readonly name: string
  readonly priceCny: number
  /** 与内核 wish-pool 条件词汇逐字一致(days/budget_cny/best_months;复用 = 零映射) */
  readonly conditions: { days?: number; budget_cny?: number; best_months?: number[] }
  readonly commissionBps?: number
}

export interface CandidateKernelMatch {
  readonly candidate: SponsorCandidate
  /** 内核命中明细(days/budget/month;渲染「为什么是它」用) */
  readonly hits: readonly string[]
}

/**
 * 内核条件评分包装(两形态共用):候选映射为 wish 条目后调用内核 scoreWishMatch,
 * 并强制「申报条件全命中才可预订」——部分命中不算(sponsor 不可放宽旅行者约束,
 * wish conditions 强制红线)。内核不满足 → null。
 */
export function scoreCandidateAgainstWish(candidate: SponsorCandidate, wish: WishMatchContext): CandidateKernelMatch | null {
  const c = candidate.conditions
  const declared = [typeof c.days === 'number', typeof c.budget_cny === 'number', Array.isArray(c.best_months)].filter(Boolean).length
  const match = scoreWishMatch({ wish_id: candidate.candidateRef, name: candidate.name, conditions: c }, wish)
  if (!match || match.hits.length < declared) return null
  return { candidate, hits: match.hits }
}

export interface SponsorDisclosureFragment {
  readonly sponsorId: string
  readonly statement: string
  readonly rankingBiasNotice: string
  readonly commissionBps: number
  readonly disclosureDigestSha256: string
}

export interface RankedSponsorCandidate {
  readonly candidate: SponsorCandidate
  /** 内核评分(命中条件数;赞助权重不参与) */
  readonly kernelScore: number
  readonly kernelHits: readonly string[]
  readonly disclosure: SponsorDisclosureFragment
  /** 同分 tie 中该位因 sponsor 申报顺位获益(佣金高于同分组内最低)时为 true——偏置必须展示 */
  readonly sponsorTieBreakApplied: boolean
}

export interface SponsorRanking {
  readonly ranked: readonly RankedSponsorCandidate[]
  readonly excluded: readonly { candidateRef: string; why: 'route-unauthorized' | 'conditions-not-met' }[]
  /** 顶层偏置声明(渲染面必须可见;不因无 tie 而省略) */
  readonly biasNotice: string
}

/**
 * sponsor 库存排序:①路由越权 → 排除(不进入评分);②内核条件评分非全命中 → 排除
 * (佣金不可赎回——排序不能以赞助收益伪造用户效用);③排序键 = 内核评分降序,
 * 同分 tie 按 sponsor 申报顺位(入参顺序;佣金数值从不进入排序键),
 * tie 中申报顺位受益位(其佣金高于组内最低)显式标记 sponsorTieBreakApplied。
 */
export function rankSponsorCandidates(
  plugin: SponsorPlugin,
  candidates: readonly SponsorCandidate[],
  wish: WishMatchContext,
): SponsorRanking {
  const ranked: RankedSponsorCandidate[] = []
  const excluded: { candidateRef: string; why: 'route-unauthorized' | 'conditions-not-met' }[] = []
  const scored: { cand: SponsorCandidate; hits: readonly string[] }[] = []
  for (const cand of candidates) {
    if (!plugin.config.allowedRoutes.includes(cand.route)) {
      excluded.push({ candidateRef: cand.candidateRef, why: 'route-unauthorized' })
      continue
    }
    const match = scoreCandidateAgainstWish(cand, wish)
    if (!match) {
      excluded.push({ candidateRef: cand.candidateRef, why: 'conditions-not-met' })
      continue
    }
    scored.push({ cand, hits: match.hits })
  }
  // 内核评分降序;同分保持申报顺位(稳定排序)——申报顺位即 sponsor 声明的偏好序
  const ordered = [...scored].sort((a, b) => b.hits.length - a.hits.length)
  // 逐同分组判定 tie 受益位
  let i = 0
  while (i < ordered.length) {
    let j = i
    while (j + 1 < ordered.length && ordered[j + 1].hits.length === ordered[i].hits.length) j++
    const group = ordered.slice(i, j + 1)
    const minCommission = Math.min(...group.map((g) => g.cand.commissionBps ?? 0))
    for (const g of group) {
      ranked.push({
        candidate: g.cand,
        kernelScore: g.hits.length,
        kernelHits: g.hits,
        disclosure: {
          sponsorId: plugin.config.sponsorId,
          statement: plugin.config.disclosure.statement,
          rankingBiasNotice: plugin.config.disclosure.rankingBiasNotice,
          commissionBps: plugin.config.disclosure.commissionBps,
          disclosureDigestSha256: plugin.disclosureDigestSha256,
        },
        sponsorTieBreakApplied: group.length > 1 && (g.cand.commissionBps ?? 0) > minCommission,
      })
    }
    i = j + 1
  }
  return { ranked, excluded, biasNotice: plugin.config.disclosure.rankingBiasNotice }
}

// ── 确认闸(披露进入确认指纹 + approval 绑定) ───────────────────────────────

export interface ConfirmationFingerprintParts {
  readonly businessId: string
  readonly travelerPrincipalId: string
  /** C 端为 null(无 sponsor 主体) */
  readonly sponsorId: string | null
  readonly candidateRef: string
  readonly route: string
  readonly priceCny: number
  /** C 端为 null;B2B 必为插件披露摘要(佣金披露进入确认指纹,验收§3) */
  readonly disclosureDigestSha256: string | null
}

/** 确认指纹:规范 JSON(键排序)后 sha256;披露摘要参与,披露口径变化 → 指纹变化。 */
export function buildConfirmationFingerprint(parts: ConfirmationFingerprintParts): string {
  return sha256Canon({
    schema: SPONSOR_PLUGIN_SCHEMA,
    businessId: parts.businessId,
    travelerPrincipalId: parts.travelerPrincipalId,
    sponsorId: parts.sponsorId,
    candidateRef: parts.candidateRef,
    route: parts.route,
    priceCny: parts.priceCny,
    disclosureDigestSha256: parts.disclosureDigestSha256,
  })
}

export interface SponsorApproval {
  readonly receipt: string
  readonly fingerprintSha256: string
  readonly travelerPrincipalId: string
  readonly sponsorId: string | null
}

/**
 * approval 绑定:必携非空外部回执(L3 具名确认红线,与内核 write.confirmed 空 receipt
 * 违例同源;B2B 无豁免)。
 */
export function bindApproval(input: { fingerprintSha256: string; receipt: string; travelerPrincipalId: string; sponsorId: string | null }): SponsorApproval {
  const receipt = typeof input.receipt === 'string' ? input.receipt.trim() : ''
  if (!receipt) throw new Error('sponsor-plugin: 确认必携外部回执(空 receipt 红线;B2B 与 C 端同一 WriteGate 规则)')
  if (!input.fingerprintSha256) throw new Error('sponsor-plugin: approval 必须绑定确认指纹')
  return { receipt, fingerprintSha256: input.fingerprintSha256, travelerPrincipalId: input.travelerPrincipalId, sponsorId: input.sponsorId }
}

/** approval 绑定校验:指纹不一致(含跨 sponsor/跨租户重放)一律失败。 */
export function verifyApprovalBinding(expectedFingerprintSha256: string, approval: SponsorApproval): boolean {
  return approval.fingerprintSha256 === expectedFingerprintSha256
}

// ── 端到端 runner(同一 runner,以是否携带插件参数化两种形态) ─────────────────

export interface ScenarioScope {
  readonly businessId: string
  readonly travelerPrincipalId: string
  /** C 端为 null */
  readonly sponsorId: string | null
  /** 投影隔离键:businessId|travelerPrincipalId|sponsorId(同业务 id 不同主体不串投影) */
  readonly key: string
}

export interface ScenarioEvent {
  readonly seq: number
  readonly kind: 'route.authorized' | 'candidate.ranked' | 'write.pending' | 'write.confirmed' | 'write.compensated'
  /** write.* 事件的内核 saga 词汇;非 saga 事件为 null */
  readonly sagaEvent: 'write.pending' | 'write.confirmed' | 'write.compensated' | null
  readonly from: string | null
  readonly to: string | null
  /** 内核边表守卫原文(write.* 事件)——两形态逐字相同,即同一张边表 */
  readonly guard: string | null
  readonly receipt?: string
  readonly fingerprintSha256?: string
  readonly scope: ScenarioScope
  readonly detail: string
}

export interface ScenarioTrace {
  readonly form: 'b2c' | 'b2b-sponsor'
  readonly scope: ScenarioScope
  readonly selectedCandidateRef: string
  readonly sagaStatus: SagaStatus
  readonly events: readonly ScenarioEvent[]
  /** 内核 sagaTraceViolations 回放结果;合法链 = 空数组 */
  readonly sagaViolations: readonly string[]
}

export interface BookingScenarioInput {
  readonly businessId: string
  readonly travelerPrincipalId: string
  readonly candidates: readonly SponsorCandidate[]
  readonly wish: WishMatchContext
  readonly action: 'confirm' | 'cancel'
  /** 确认必携外部回执(两种形态同一红线) */
  readonly receipt?: string
  /** B2B 必填:session/order 绑定 */
  readonly sessionRef?: string
  /** 缺省 = C 端默认形态(零 sponsor 字段);提供 = B2B sponsor 形态 */
  readonly plugin?: SponsorPlugin
}

/**
 * 端到端预订场景(fixture 合成数据;纯函数,零真实调用):
 * 同一段代码驱动 B2C 与 B2B——内核调用(resolveSagaTrigger/scoreWishMatch/
 * sagaTraceViolations)在两种形态下逐字相同,差异只在 sponsor 插件槽
 * (路由授权/披露标注)。任何一步不合法即 fail-closed 抛错,不静默降级。
 */
export function runBookingScenario(input: BookingScenarioInput): ScenarioTrace {
  const businessId = requireNonEmpty('businessId', input.businessId)
  const travelerPrincipalId = requireNonEmpty('travelerPrincipalId', input.travelerPrincipalId)
  const plugin = input.plugin ?? null
  const form: ScenarioTrace['form'] = plugin ? 'b2b-sponsor' : 'b2c'
  const scope: ScenarioScope = {
    businessId,
    travelerPrincipalId,
    sponsorId: plugin ? plugin.config.sponsorId : null,
    key: `${businessId}|${travelerPrincipalId}|${plugin ? plugin.config.sponsorId : 'c-side'}`,
  }
  const receipt = typeof input.receipt === 'string' ? input.receipt.trim() : ''
  if (!receipt) throw new Error('sponsor-plugin: 确认必携外部回执(空 receipt 红线;B2B 与 C 端同一 WriteGate 规则)')
  let sessionRef: string | null = null
  if (plugin) {
    sessionRef = typeof input.sessionRef === 'string' ? input.sessionRef.trim() : ''
    if (!sessionRef) throw new Error('sponsor-plugin: B2B 场景缺 session/order 绑定(路由授权前置条件)')
  }

  // 库存/规划:同一内核评分包装,两形态共用;B2B 附加路由授权闭集过滤
  const eligible: { cand: SponsorCandidate; hits: readonly string[] }[] = []
  const events: ScenarioEvent[] = []
  let seq = 0
  const push = (e: Omit<ScenarioEvent, 'seq' | 'scope'>): void => {
    events.push({ ...e, seq: seq++, scope })
  }
  for (const cand of input.candidates) {
    if (plugin) {
      const auth = authorizeSponsorRoute(plugin, cand.route, { sessionRef, orderRef: null })
      if (!auth.ok) {
        throw new Error(`sponsor-plugin: 端到端 ${auth.reason}(${auth.detail};candidate=${cand.candidateRef})`)
      }
    }
    const match = scoreCandidateAgainstWish(cand, input.wish)
    if (match) eligible.push({ cand, hits: match.hits })
  }
  if (eligible.length === 0) {
    throw new Error('sponsor-plugin: 无可预订候选(条件全命中强制;赞助权重不可伪造用户效用)')
  }
  eligible.sort((a, b) => b.hits.length - a.hits.length)
  const top = eligible[0]
  const fingerprint = buildConfirmationFingerprint({
    businessId,
    travelerPrincipalId,
    sponsorId: scope.sponsorId,
    candidateRef: top.cand.candidateRef,
    route: top.cand.route,
    priceCny: top.cand.priceCny,
    disclosureDigestSha256: plugin ? plugin.disclosureDigestSha256 : null,
  })
  if (plugin) {
    push({
      kind: 'route.authorized', sagaEvent: null, from: null, to: null, guard: null,
      detail: `route=${top.cand.route} selector=sponsor-allowed-routes session=${sessionRef} sponsor=${plugin.config.sponsorId}`,
    })
  }
  push({
    kind: 'candidate.ranked', sagaEvent: null, from: null, to: null, guard: null,
    fingerprintSha256: fingerprint,
    detail: `candidate=${top.cand.candidateRef} score=${top.hits.length} hits=[${top.hits.join(',')}]`
      + (plugin ? ` bias=${plugin.config.disclosure.rankingBiasNotice}` : ' bias=null'),
  })

  // 确认闸:唯一状态推进词汇 = 内核 booking_saga_fsm.v1 边表(两形态同一张表)
  let stage: 'none' | SagaStatus = 'none'
  /** propose 必先执行(否则 fire 内即抛);settled 后为终态 */
  let settled: SagaStatus | null = null
  const approval = bindApproval({ fingerprintSha256: fingerprint, receipt, travelerPrincipalId, sponsorId: scope.sponsorId })
  const fire = (trigger: 'propose' | 'confirm' | 'compensate', extra: Partial<ScenarioEvent> = {}): void => {
    const verdict = resolveSagaTrigger(stage, trigger)
    if (!verdict.ok) throw new Error(`sponsor-plugin: saga 拒绝(${stage} --${trigger}--> ${verdict.reason};内核边表唯一归宿)`)
    stage = verdict.to
    settled = verdict.to
    push({
      kind: verdict.event, sagaEvent: verdict.event, from: verdict.from, to: verdict.to, guard: verdict.guard,
      ...(trigger === 'confirm' ? { receipt: approval.receipt } : {}),
      ...extra,
      detail: `business=${businessId} candidate=${top.cand.candidateRef} route=${top.cand.route} priceCny=${top.cand.priceCny} fp=${fingerprint.slice(0, 12)}`,
    })
  }
  fire('propose', { fingerprintSha256: fingerprint })
  fire('confirm', { fingerprintSha256: fingerprint })
  if (input.action === 'cancel') fire('compensate')

  // 审计/回放:内核校验器对 write.* 事件链逐段校验(必携回执/吸收态/拒绝闭包)
  const audit: SagaAuditEvent[] = events
    .filter((e): e is ScenarioEvent & { sagaEvent: 'write.pending' | 'write.confirmed' | 'write.compensated' } => e.sagaEvent !== null)
    .map((e) => ({ seq: e.seq, kind: e.sagaEvent, receipt: e.receipt ?? null }))
  const violations = sagaTraceViolations(audit)
  if (settled === null) throw new Error('sponsor-plugin: saga 未推进(不可达:propose 必先执行)')
  return { form, scope, selectedCandidateRef: top.cand.candidateRef, sagaStatus: settled, events, sagaViolations: violations }
}

// ── 隔离检查器(C 端 trace 零 sponsor 渗入) ─────────────────────────────────

/**
 * sponsor 字段泄漏检查:递归扫描 trace,凡键名含 sponsor 且值非空(或 scope.sponsorId
 * 非 null)即记一条发现。C 端默认形态 trace 必须零发现;B2B trace 必有发现
 * (双向断言保证检查器自身有效)。
 */
export function sponsorLeakFindings(trace: ScenarioTrace): string[] {
  const findings: string[] = []
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`))
      return
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        const empty = v === null || v === undefined || v === ''
        if (/sponsor/i.test(k) && !empty) findings.push(`${path}.${k}`)
        walk(v, `${path}.${k}`)
      }
    }
  }
  walk(trace, 'trace')
  return findings
}
