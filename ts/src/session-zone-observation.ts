/**
 * 会话双区记忆的观测面与可否证指标(P4-4,docs/design/session-dual-zone-memory-design.md §4/§5)。
 *
 * 立场:**价值要么可否证,要么不算**。「记得更多」过不了这里任何一关:
 *   ① 晋升信号质量 = owner 确认率(提议里被确认的比例);
 *   ② 工作区收益 = intent TTL 内回访的免重问率(配对口径,借 #20);
 *   ③ 失效命中率 = 被 owner 更正的分区供述 / 分区供述总数(上界,越低越好)。
 * 三个阈值在**见到任何数据之前**冻结在本文件的 metric contract 里(#20 阈值冻结纪律),
 * 输入不得改阈值:夹具声明与冻结值不一致即 `contract_invalid` fail-closed。
 *
 * 诚实边界(设计 §4 + #20 证据分级):
 *  - 夹具只证明**契约与算法**:`synthetic_fixture` 的 `exit_evidence_eligible`
 *    恒 false,`value_claimed` 恒 false;
 *  - 真实私有 cohort(`observed_private`)同样只到 **candidate**:本模块永不生成
 *    reviewer/attestation 字段,自证不算证据(与 #228 收集器同纪律);
 *  - 计数**只有形状**:每层的捕获/修订/弃用计数、晋升提议 vs 确认 vs 否决、
 *    过期年龄分桶、工作区读命中/未命中——**零 id、零载荷、零时间戳**;
 *  - 观测路径零定时器、零网络、零驻留服务;计数接收器须显式 opt-in
 *    (`GOTRY_SESSION_ZONE_OBSERVE=1`),默认不记任何东西;
 *  - 导出引用全部 HMAC 假名化(复用 #228 收集器的 `pseudonymousRef`)。
 *
 * 本模块不碰 #20 scorer 里冻结的 `p4` 闸:那道闸按它自己的证据规则走。
 */

import {
  MemoryLifecycleError,
  canonicalJson,
  pseudonymousRef,
  sha256Hex,
} from './memory-lifecycle.ts'
import { HOT_TIERS, type HotTier, type ZoneEvent } from './session-zones.ts'

// ---- 冻结的指标契约(见数据之前钉死;输入不得改) ----------------------------------

export const SESSION_ZONE_METRIC_CONTRACT_SCHEMA = 'session_zone_metric_contract.v1' as const
export const SESSION_ZONE_FIXTURE_SCHEMA = 'session_zone_metric_fixture.v1' as const
export const SESSION_ZONE_REPORT_SCHEMA = 'session_zone_metric_report.v1' as const
export const SESSION_ZONE_COUNTERS_SCHEMA = 'session_zone_counters.v1' as const
export const SESSION_ZONE_EXPORT_SCHEMA = 'session_zone_observation_export.v1' as const

/**
 * 阈值冻结(2026-10-04,P4-4 PR 时,先于任何真实数据):
 *  - `minimum_sample_count = 5`:沿用 #20 已冻结的 `minimum_pair_count_for_exit = 5`。
 *    不另发明第二条样本线;低于它比值只是噪声,判定一律 insufficient_sample。
 *  - `min_confirm_rate = 0.5`:多数提议被 owner 否决的提议器按定义就是调错了。
 *    0.5 = 「对的比错的多」,是最弱可辩护下界,刻意不设成期望值。
 *  - `min_reask_avoidance_ratio = 0.5`:与 #20 的 `target_median_reduction_ratio = 0.5`
 *    同一个数。工作区的收益线就用 M4 Exit 已经冻结的那条线——另发明一条会让 P4
 *    过一条 M4 过不了的线。
 *  - `max_stale_hit_rate = 0.1`:被 owner 更正的供述是用户**看得见**的记忆失败。
 *    十分之一是 TTL 分层被否证的上界(被否证的是分层,不是功能);0.1 是常规误差
 *    上界,是天花板不是目标。
 */
export const SESSION_ZONE_METRIC_CONTRACT = {
  schema: SESSION_ZONE_METRIC_CONTRACT_SCHEMA,
  frozen_at: '2026-10-04',
  frozen_before_any_data: true,
  minimum_sample_count: 5,
  min_confirm_rate: 0.5,
  min_reask_avoidance_ratio: 0.5,
  max_stale_hit_rate: 0.1,
} as const

export type SessionZoneMetricContract = typeof SESSION_ZONE_METRIC_CONTRACT

export const SESSION_ZONE_METRIC_IDS = [
  'promotion_signal_quality',
  'working_zone_payoff',
  'stale_hit_rate',
] as const
export type SessionZoneMetricId = (typeof SESSION_ZONE_METRIC_IDS)[number]

export const SESSION_ZONE_VERDICTS = ['pass', 'below_threshold', 'insufficient_sample'] as const
export type SessionZoneVerdict = (typeof SESSION_ZONE_VERDICTS)[number]

export type SessionZoneEvidenceKind = 'synthetic_fixture' | 'observed_private'

export type ZoneObservationErrorCode =
  | 'bad_schema' // 夹具 schema/evidence_kind 不合法
  | 'contract_invalid' // 夹具声明的阈值与冻结契约不一致(输入不得改阈值)
  | 'bad_sample' // 样本形状不合法(负数/非整数/分母小于被减数)
  | 'missing_hmac_key'
  | 'invalid_hmac_key'
  | 'missing_consent'

export interface ZoneObservationErr {
  ok: false
  code: ZoneObservationErrorCode
  detail: string
}

function err(code: ZoneObservationErrorCode, detail: string): ZoneObservationErr {
  return { ok: false, code, detail }
}

// ---- 形状计数(从账本事件确定性投影;零 id、零载荷、零时间戳) ----------------------

export const ZONE_EXPIRY_BUCKETS = ['lt_1h', 'lt_24h', 'lt_7d', 'gte_7d'] as const
export type ZoneExpiryBucket = (typeof ZONE_EXPIRY_BUCKETS)[number]

export interface ZoneShapeCounters {
  schema: typeof SESSION_ZONE_COUNTERS_SCHEMA
  captures: Record<HotTier, number>
  revisions: Record<HotTier, number>
  drops: Record<HotTier, number>
  notebook: { promoted: number; revised: number; dropped: number }
  /** 读时过期判定:当前已过期的活笔记按「过期多久」分桶(只有桶计数) */
  expired: Record<ZoneExpiryBucket, number>
  live: Record<HotTier, number>
}

function zeroByTier(): Record<HotTier, number> {
  return { resource: 0, intent: 0 }
}

function bucketOf(ageMs: number): ZoneExpiryBucket {
  if (ageMs < 3_600_000) return 'lt_1h'
  if (ageMs < 86_400_000) return 'lt_24h'
  if (ageMs < 7 * 86_400_000) return 'lt_7d'
  return 'gte_7d'
}

/**
 * 形状计数投影(纯函数,只读):
 *  - drop 事件只带 note_id,tier 由同一日志里先前的 capture 事件解析(确定性);
 *  - 过期分桶按注入时钟对 fold 后仍在的笔记判定(过期是读时视图,不是事件);
 *  - 输出里没有任何 id / 载荷 / 时间戳——只有整数计数。
 */
export function projectZoneCounters(events: readonly ZoneEvent[], now: string): ZoneShapeCounters {
  const counters: ZoneShapeCounters = {
    schema: SESSION_ZONE_COUNTERS_SCHEMA,
    captures: zeroByTier(),
    revisions: zeroByTier(),
    drops: zeroByTier(),
    notebook: { promoted: 0, revised: 0, dropped: 0 },
    expired: { lt_1h: 0, lt_24h: 0, lt_7d: 0, gte_7d: 0 },
    live: zeroByTier(),
  }
  const tierOf = new Map<string, HotTier>()
  const alive = new Map<string, { tier: HotTier; expiresAt: string }>()
  for (const ev of events) {
    switch (ev.kind) {
      case 'hotctx.note.captured':
        tierOf.set(ev.note.note_id, ev.note.tier)
        counters.captures[ev.note.tier]++
        alive.set(ev.note.note_id, { tier: ev.note.tier, expiresAt: ev.note.ttl_expires_at })
        break
      case 'hotctx.note.revised':
        tierOf.set(ev.note.note_id, ev.note.tier)
        counters.revisions[ev.note.tier]++
        alive.set(ev.note.note_id, { tier: ev.note.tier, expiresAt: ev.note.ttl_expires_at })
        break
      case 'hotctx.note.dropped': {
        const tier = tierOf.get(ev.note_id)
        if (tier) counters.drops[tier]++
        alive.delete(ev.note_id)
        break
      }
      case 'notebook.entry.promoted':
        counters.notebook.promoted++
        break
      case 'notebook.entry.revised':
        counters.notebook.revised++
        break
      case 'notebook.entry.dropped':
        counters.notebook.dropped++
        break
    }
  }
  const nowMs = Date.parse(now)
  for (const { tier, expiresAt } of alive.values()) {
    const expMs = Date.parse(expiresAt)
    if (Number.isNaN(nowMs) || Number.isNaN(expMs)) continue // 坏时钟不猜:既不算活也不算过期
    if (nowMs < expMs) counters.live[tier]++
    else counters.expired[bucketOf(nowMs - expMs)]++
  }
  return counters
}

// ---- 非账本信号的 opt-in 计数接收器(进程内、零持久化、零定时器) -------------------

export const ZONE_SIGNALS = ['proposal', 'confirm', 'deny', 'read_hit', 'read_miss'] as const
export type ZoneSignal = (typeof ZONE_SIGNALS)[number]
export const ZONE_OBSERVE_ENV = 'GOTRY_SESSION_ZONE_OBSERVE'

export type ZoneSignalCounts = Record<ZoneSignal, number>

export function zeroSignalCounts(): ZoneSignalCounts {
  return { proposal: 0, confirm: 0, deny: 0, read_hit: 0, read_miss: 0 }
}

export interface ZoneCounterSink {
  note(signal: ZoneSignal): void
  snapshot(): ZoneSignalCounts
  reset(): void
}

/** 显式 opt-in:只有环境里明示 '1' 才记;默认永不记(「无驻留服务、无自动遥测」) */
export function isZoneObservationOptIn(env: Record<string, string | undefined> = process.env): boolean {
  return env[ZONE_OBSERVE_ENV] === '1'
}

/**
 * 计数接收器(纯内存):opt-in 关闭时 note() 恒为 no-op(snapshot 全 0)。
 * 没有定时器、没有 IO、没有网络——它只是五个整数。
 */
export function createZoneCounterSink(optIn: boolean): ZoneCounterSink {
  let counts = zeroSignalCounts()
  return {
    note(signal: ZoneSignal): void {
      if (!optIn) return
      if (!(ZONE_SIGNALS as readonly string[]).includes(signal)) return
      counts[signal]++
    },
    snapshot: () => ({ ...counts }),
    reset: () => { counts = zeroSignalCounts() },
  }
}

/**
 * 进程默认接收器(接线面调用 `noteZoneSignal`):构造时读一次 opt-in 环境,
 * 默认关 = 五个 0。`configureZoneObservation` 显式重建(测试与显式 CLI opt-in 用)。
 */
let defaultSink = createZoneCounterSink(isZoneObservationOptIn())

export function configureZoneObservation(optIn: boolean): void {
  defaultSink = createZoneCounterSink(optIn)
}

export function noteZoneSignal(signal: ZoneSignal): void {
  defaultSink.note(signal)
}

export function zoneSignalSnapshot(): ZoneSignalCounts {
  return defaultSink.snapshot()
}

// ---- 三个可否证指标(只读投影;夹具只证契约) --------------------------------------

export interface ZoneMetricFixture {
  schema: string
  evidence_kind: string
  metric_contract: Record<string, unknown>
  promotion_decisions: Array<{ proposal_ref: string; decision: string }>
  reask_pairs: Array<{ pair_ref: string; first_visit_asked_fields: number; returning_reasked_fields: number; within_intent_ttl: boolean }>
  zone_served_facts: Array<{ served_ref: string; corrected: boolean }>
}

export interface ZoneMetricResult {
  id: SessionZoneMetricId
  /** 「越高越好」还是「越低越好」:阈值方向显式,避免读者自己猜 */
  direction: 'higher_is_better' | 'lower_is_better'
  threshold: number
  sample_count: number
  value: number | null
  verdict: SessionZoneVerdict
}

export interface ZoneMetricReport {
  schema: typeof SESSION_ZONE_REPORT_SCHEMA
  evidence_kind: SessionZoneEvidenceKind
  metric_contract: SessionZoneMetricContract
  /** 夹具永不构成 Exit 证据;observed_private 也只到 candidate(不自证) */
  exit_evidence_eligible: false
  /** 「记得更多」不是价值:本面永不声称价值 */
  value_claimed: false
  source_review: { state: 'not_required_for_synthetic' | 'candidate'; reviewer_ref: null; attestation_ref: null }
  metrics: ZoneMetricResult[]
}

function verdictOf(sample: number, value: number | null, threshold: number, direction: 'higher_is_better' | 'lower_is_better'): SessionZoneVerdict {
  if (sample < SESSION_ZONE_METRIC_CONTRACT.minimum_sample_count || value === null) return 'insufficient_sample'
  if (direction === 'higher_is_better') return value >= threshold ? 'pass' : 'below_threshold'
  return value <= threshold ? 'pass' : 'below_threshold'
}

function nonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0
}

/**
 * 只读指标投影:
 *  - schema/evidence_kind 闭集;
 *  - 夹具声明的 metric_contract 必须逐字段等于冻结契约(输入不得改阈值 → contract_invalid);
 *  - 样本形状非法即 bad_sample(不猜、不截断);
 *  - 样本不足即 insufficient_sample(永不因为「只有一两条」就宣布通过)。
 */
export function projectZoneMetrics(fixture: unknown): { ok: true; report: ZoneMetricReport } | ZoneObservationErr {
  if (typeof fixture !== 'object' || fixture === null || Array.isArray(fixture)) {
    return err('bad_schema', '夹具必须是对象')
  }
  const f = fixture as ZoneMetricFixture
  if (f.schema !== SESSION_ZONE_FIXTURE_SCHEMA) {
    return err('bad_schema', `未知 schema:${String(f.schema)}(闭集 ${SESSION_ZONE_FIXTURE_SCHEMA})`)
  }
  if (f.evidence_kind !== 'synthetic_fixture' && f.evidence_kind !== 'observed_private') {
    return err('bad_schema', `未知 evidence_kind:${String(f.evidence_kind)}(闭集 synthetic_fixture|observed_private)`)
  }
  const declared = f.metric_contract
  if (typeof declared !== 'object' || declared === null) return err('contract_invalid', '夹具必须显式声明 metric_contract(阈值冻结纪律)')
  for (const [key, frozen] of Object.entries(SESSION_ZONE_METRIC_CONTRACT)) {
    if ((declared as Record<string, unknown>)[key] !== frozen) {
      return err('contract_invalid', `阈值冻结:${key} 声明值 ${JSON.stringify((declared as Record<string, unknown>)[key])} ≠ 冻结值 ${JSON.stringify(frozen)}(输入不得改阈值)`)
    }
  }
  if (!Array.isArray(f.promotion_decisions) || !Array.isArray(f.reask_pairs) || !Array.isArray(f.zone_served_facts)) {
    return err('bad_sample', 'promotion_decisions / reask_pairs / zone_served_facts 必须都是数组')
  }

  // ① 晋升信号质量:确认 / (确认 + 否决)
  let confirmed = 0
  let denied = 0
  for (const d of f.promotion_decisions) {
    if (d?.decision === 'confirmed') confirmed++
    else if (d?.decision === 'denied') denied++
    else return err('bad_sample', `promotion_decisions.decision 闭集 confirmed|denied,实测 ${JSON.stringify(d?.decision)}`)
  }
  const decisions = confirmed + denied
  const confirmRate = decisions > 0 ? confirmed / decisions : null

  // ② 工作区收益:intent TTL 内回访的免重问率
  let askedTotal = 0
  let reaskedTotal = 0
  let pairs = 0
  for (const p of f.reask_pairs) {
    if (typeof p?.within_intent_ttl !== 'boolean') return err('bad_sample', 'reask_pairs.within_intent_ttl 必须是布尔')
    if (!nonNegInt(p.first_visit_asked_fields) || !nonNegInt(p.returning_reasked_fields)) {
      return err('bad_sample', 'reask_pairs 的字段计数必须是非负整数')
    }
    if (p.returning_reasked_fields > p.first_visit_asked_fields) {
      return err('bad_sample', '回访重问字段数不得大于首访询问字段数(配对口径,不猜)')
    }
    if (!p.within_intent_ttl) continue // TTL 外的回访不是工作区该负责的窗口
    pairs++
    askedTotal += p.first_visit_asked_fields
    reaskedTotal += p.returning_reasked_fields
  }
  const avoidance = askedTotal > 0 ? (askedTotal - reaskedTotal) / askedTotal : null

  // ③ 失效命中率:被更正的供述 / 供述总数
  let corrected = 0
  for (const s of f.zone_served_facts) {
    if (typeof s?.corrected !== 'boolean') return err('bad_sample', 'zone_served_facts.corrected 必须是布尔')
    if (s.corrected) corrected++
  }
  const served = f.zone_served_facts.length
  const staleRate = served > 0 ? corrected / served : null

  const metrics: ZoneMetricResult[] = [
    {
      id: 'promotion_signal_quality',
      direction: 'higher_is_better',
      threshold: SESSION_ZONE_METRIC_CONTRACT.min_confirm_rate,
      sample_count: decisions,
      value: confirmRate,
      verdict: verdictOf(decisions, confirmRate, SESSION_ZONE_METRIC_CONTRACT.min_confirm_rate, 'higher_is_better'),
    },
    {
      id: 'working_zone_payoff',
      direction: 'higher_is_better',
      threshold: SESSION_ZONE_METRIC_CONTRACT.min_reask_avoidance_ratio,
      sample_count: pairs,
      value: avoidance,
      verdict: verdictOf(pairs, avoidance, SESSION_ZONE_METRIC_CONTRACT.min_reask_avoidance_ratio, 'higher_is_better'),
    },
    {
      id: 'stale_hit_rate',
      direction: 'lower_is_better',
      threshold: SESSION_ZONE_METRIC_CONTRACT.max_stale_hit_rate,
      sample_count: served,
      value: staleRate,
      verdict: verdictOf(served, staleRate, SESSION_ZONE_METRIC_CONTRACT.max_stale_hit_rate, 'lower_is_better'),
    },
  ]
  return {
    ok: true,
    report: {
      schema: SESSION_ZONE_REPORT_SCHEMA,
      evidence_kind: f.evidence_kind,
      metric_contract: SESSION_ZONE_METRIC_CONTRACT,
      exit_evidence_eligible: false,
      value_claimed: false,
      source_review: {
        state: f.evidence_kind === 'synthetic_fixture' ? 'not_required_for_synthetic' : 'candidate',
        reviewer_ref: null,
        attestation_ref: null,
      },
      metrics,
    },
  }
}

// ---- 候选导出(#228 收集器同族:HMAC 假名引用 + 同意声明 + 只带计数与引用) --------

export interface ZoneObservationExport {
  schema: typeof SESSION_ZONE_EXPORT_SCHEMA
  /** 与 #228 同纪律:来源等级自述永不构成证据等级 */
  evidence_kind: SessionZoneEvidenceKind
  generated_at: string
  dataset_ref: string
  consent_ref: string
  counters: ZoneShapeCounters
  signals: ZoneSignalCounts
  observation_opt_in: boolean
  report: ZoneMetricReport
  /** 导出载荷的规范 JSON 摘要(内容绑定;不是归因声明) */
  payload_digest_sha256: string
}

/**
 * 候选级导出:只带**计数与假名引用**,不带任何内容字段
 * (无 id、无载荷、无原话、无 session_ref 原文、无时间戳——`generated_at` 除外)。
 * `source_review` 永远停在 candidate:自证不算证据。
 */
export function buildZoneObservationExport(input: {
  evidenceKind: SessionZoneEvidenceKind
  dataset: string
  consent: string
  hmacKey: string | undefined
  counters: ZoneShapeCounters
  signals: ZoneSignalCounts
  observationOptIn: boolean
  report: ZoneMetricReport
  generatedAt: string
}): { ok: true; export: ZoneObservationExport } | ZoneObservationErr {
  if (typeof input.consent !== 'string' || input.consent.trim().length === 0) {
    return err('missing_consent', '导出需要显式同意声明(opt-in 收集纪律)')
  }
  let datasetRef: string
  let consentRef: string
  try {
    datasetRef = pseudonymousRef(input.hmacKey ?? '', 'session_zone_dataset', [input.dataset])
    consentRef = pseudonymousRef(input.hmacKey ?? '', 'session_zone_consent', [input.consent.trim()])
  } catch (e) {
    const code = e instanceof MemoryLifecycleError && e.code === 'missing_hmac_key' ? 'missing_hmac_key' : 'invalid_hmac_key'
    return err(code, `HMAC 假名化失败(${code}):引用必须假名化后才可导出`)
  }
  const body = {
    schema: SESSION_ZONE_EXPORT_SCHEMA,
    evidence_kind: input.evidenceKind,
    generated_at: input.generatedAt,
    dataset_ref: datasetRef,
    consent_ref: consentRef,
    counters: input.counters,
    signals: input.signals,
    observation_opt_in: input.observationOptIn,
    report: input.report,
  }
  return {
    ok: true,
    export: { ...body, payload_digest_sha256: sha256Hex(canonicalJson(body)) },
  }
}

/** 导出里允许出现的键闭集(测试据此断言「只有计数与引用,零内容字段」) */
export const ZONE_EXPORT_ALLOWED_KEYS: readonly string[] = [
  'schema', 'evidence_kind', 'generated_at', 'dataset_ref', 'consent_ref',
  'counters', 'signals', 'observation_opt_in', 'report', 'payload_digest_sha256',
  // counters
  'captures', 'revisions', 'drops', 'notebook', 'expired', 'live',
  ...HOT_TIERS, 'promoted', 'revised', 'dropped', ...ZONE_EXPIRY_BUCKETS,
  // signals
  ...ZONE_SIGNALS,
  // report
  'metric_contract', 'exit_evidence_eligible', 'value_claimed', 'source_review', 'metrics',
  'frozen_at', 'frozen_before_any_data', 'minimum_sample_count', 'min_confirm_rate',
  'min_reask_avoidance_ratio', 'max_stale_hit_rate',
  'state', 'reviewer_ref', 'attestation_ref',
  'id', 'direction', 'threshold', 'sample_count', 'value', 'verdict',
]
