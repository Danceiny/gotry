/**
 * 会话双区记忆观测面与指标契约单测(P4-4,design/session-dual-zone-memory-design.md §4/§5):
 *  - 形状计数:每层捕获/修订/弃用、笔记本三计数、过期年龄分桶、活笔记计数;
 *    输出里零 id、零载荷、零时间戳(逐键断言);坏时钟不猜;
 *  - opt-in 计数接收器:默认关 = 全 0(no-op);显式 opt-in 才计数;
 *  - 三个可否证指标:阈值**冻结**(输入声明不一致即 contract_invalid)、
 *    样本不足即 insufficient_sample、方向性阈值(确认率/免重问率下界,失效率上界)、
 *    样本形状非法即 bad_sample;
 *  - 夹具只证契约:`synthetic_fixture` 的 exit_evidence_eligible/value_claimed 恒 false,
 *    observed_private 也只到 candidate 且永不生成 reviewer/attestation;
 *  - 候选导出:只带计数与 HMAC 假名引用,键集闭集断言(零内容字段)、摘要绑定、
 *    缺/弱 HMAC key 与缺同意声明 fail-closed;
 *  - 观测路径零定时器、零网络(真实 spy 断言);
 *  - #20 scorer 的冻结 `p4` 闸不被本面改动(#228 manifest 仍 closed)。
 *
 * 全离线:纯函数 + mkdtemp 隔离 stateRoot + 有界子进程;零网络、零真实 LLM。
 * 运行:cd ts && npx tsx scripts/session-zone-observation-tests.ts
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureLedger } from '../src/state-ledger.ts'
import { appendZoneWrite, readZoneLog } from '../src/session-zone-ledger.ts'
import {
  SESSION_ZONE_EXPORT_SCHEMA,
  SESSION_ZONE_FIXTURE_SCHEMA,
  SESSION_ZONE_METRIC_CONTRACT,
  SESSION_ZONE_REPORT_SCHEMA,
  ZONE_EXPORT_ALLOWED_KEYS,
  ZONE_OBSERVE_ENV,
  buildZoneObservationExport,
  configureZoneObservation,
  createZoneCounterSink,
  isZoneObservationOptIn,
  noteZoneSignal,
  projectZoneCounters,
  projectZoneMetrics,
  zeroSignalCounts,
  zoneSignalSnapshot,
  type ZoneMetricFixture,
  type ZoneMetricReport,
} from '../src/session-zone-observation.ts'
import {
  applyZoneNote,
  promoteWithRouting,
  renderSessionZoneBrief,
  resetZoneSessionBindingForTests,
} from '../src/session-zone-wiring.ts'
import { initMemoryLifecycleDataset, readStoreForTests } from '../src/memory-lifecycle.ts'
import type { ZoneEvent } from '../src/session-zones.ts'

let n = 0
function pass(name: string, body: () => void) {
  body()
  console.log(`  ${++n}. ${name} OK`)
}

const roots: string[] = []
function freshRoot(tag: string): string {
  const root = mkdtempSync(join(tmpdir(), `gotry-zone-obs-${tag}-`))
  roots.push(root)
  return root
}

const T0 = '2026-10-04T08:00:00.000Z'
const MIN = 60_000
const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString()
const SESS = 'sess-observe-001'
const QUOTE = '对,这条你长期记着'
const HMAC_KEY = 'x'.repeat(48)
const FIXTURE_PATH = join('data', 'session-zone-metric-fixture.json')

function captureReq(over: Partial<{ tier: 'resource' | 'intent'; kind: 'destination' | 'availability'; payload: Record<string, unknown>; ts: string }> = {}) {
  return {
    op: 'capture' as const,
    input: {
      session_ref: SESS,
      tier: over.tier ?? ('intent' as const),
      kind: over.kind ?? ('destination' as const),
      payload: over.payload ?? { city: '大理' },
      evidence_ref: { session_ref: SESS, turn: 0 },
      ts: over.ts ?? T0,
    },
  }
}

function loadFixture(): ZoneMetricFixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as ZoneMetricFixture
}

/** 递归收集对象里出现过的全部键名(导出键集闭集断言用) */
function allKeys(value: unknown, acc: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, acc)
    return acc
  }
  if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      acc.add(k)
      allKeys(v, acc)
    }
  }
  return acc
}

try {
  // ---- 形状计数 ----
  pass('形状计数:分层捕获/修订/弃用 + 笔记本三计数;输出零 id/零载荷/零时间戳', () => {
    const root = freshRoot('counters')
    const ledger = ensureLedger(root)
    const first = appendZoneWrite(ledger, captureReq())
    assert.ok(first.ok)
    const noteId = Object.keys(readZoneLog(ledger).state.hot)[0]!
    appendZoneWrite(ledger, { op: 'revise', input: { note_id: noteId, expected_rev: 1, payload: { city: '丽江' }, ts: at(MIN) } })
    appendZoneWrite(ledger, captureReq({ tier: 'resource', kind: 'availability', payload: { tool: 'gotry_flyai_search', verdict: 'hit', option_count: 2 }, ts: at(2 * MIN) }))
    const resourceId = Object.keys(readZoneLog(ledger).state.hot).find(id => id.includes('resource'))!
    appendZoneWrite(ledger, { op: 'drop', note_id: resourceId, ts: at(3 * MIN) })
    appendZoneWrite(ledger, { op: 'promote', input: { note_id: noteId, kind: 'preference', owner_confirm: { surface: 'user_reply', quote: QUOTE }, ts: at(4 * MIN) } })
    const events = readZoneLog(ledger).events
    const counters = projectZoneCounters(events, at(5 * MIN))
    assert.deepEqual(counters.captures, { resource: 1, intent: 1 })
    assert.deepEqual(counters.revisions, { resource: 0, intent: 1 })
    assert.deepEqual(counters.drops, { resource: 1, intent: 0 }, 'drop 的 tier 由同一日志里的 capture 解析')
    assert.deepEqual(counters.notebook, { promoted: 1, revised: 0, dropped: 0 })
    assert.deepEqual(counters.live, { resource: 0, intent: 1 })
    // 零内容:计数里不得出现任何 id/载荷/原话/时间戳
    const serialized = JSON.stringify(counters)
    for (const forbidden of [noteId, resourceId, '大理', '丽江', QUOTE, T0, SESS, 'gotry_flyai_search']) {
      assert.equal(serialized.includes(forbidden), false, `计数不得携带:${forbidden}`)
    }
    assert.ok(/^[{}":,a-z_0-9.]+$/.test(serialized.replace(/session_zone_counters\.v1/, '')), `计数应只有键名与整数:${serialized}`)
  })

  pass('形状计数:过期年龄分桶(读时视图);两次投影一致;坏时钟不猜', () => {
    const events: ZoneEvent[] = []
    const mk = (tier: 'resource' | 'intent', ts: string, city: string): ZoneEvent => ({
      kind: 'hotctx.note.captured',
      ts,
      note: {
        schema: 'session_zone_hot_note.v1',
        note_id: `hn|${SESS}|${tier}|destination|${city}`,
        zone: 'hot_context',
        tier,
        kind: 'destination',
        payload: { city },
        evidence_ref: { session_ref: SESS, turn: 0 },
        session_ref: SESS,
        created_at: ts,
        last_touched_at: ts,
        ttl_expires_at: new Date(Date.parse(ts) + (tier === 'resource' ? 30 * MIN : 24 * 60 * MIN)).toISOString(),
        rev: 1,
      },
    })
    events.push(mk('resource', T0, 'a')) // 到期 T0+30min
    events.push(mk('intent', T0, 'b')) // 到期 T0+24h
    const soon = projectZoneCounters(events, at(31 * MIN))
    assert.deepEqual(soon.expired, { lt_1h: 1, lt_24h: 0, lt_7d: 0, gte_7d: 0 })
    assert.deepEqual(soon.live, { resource: 0, intent: 1 })
    const late = projectZoneCounters(events, at(10 * 24 * 60 * MIN))
    assert.deepEqual(late.expired, { lt_1h: 0, lt_24h: 0, lt_7d: 0, gte_7d: 2 })
    assert.deepEqual(projectZoneCounters(events, at(31 * MIN)), soon, '同输入两次投影一致(确定性)')
    const bad = projectZoneCounters(events, 'not-a-timestamp')
    assert.deepEqual(bad.expired, { lt_1h: 0, lt_24h: 0, lt_7d: 0, gte_7d: 0 }, '坏时钟既不算活也不算过期')
    assert.deepEqual(bad.live, { resource: 0, intent: 0 })
  })

  // ---- opt-in 接收器 ----
  pass('计数接收器:默认关 = 全 0 no-op;显式 opt-in 才计数;未知信号不记', () => {
    const off = createZoneCounterSink(false)
    off.note('proposal')
    off.note('confirm')
    assert.deepEqual(off.snapshot(), zeroSignalCounts(), '未 opt-in 恒不记(无驻留服务、无自动遥测)')
    const on = createZoneCounterSink(true)
    on.note('proposal')
    on.note('proposal')
    on.note('deny')
    on.note('read_hit')
    on.note('nope' as never)
    assert.deepEqual(on.snapshot(), { proposal: 2, confirm: 0, deny: 1, read_hit: 1, read_miss: 0 })
    on.reset()
    assert.deepEqual(on.snapshot(), zeroSignalCounts())
    assert.equal(isZoneObservationOptIn({}), false)
    assert.equal(isZoneObservationOptIn({ [ZONE_OBSERVE_ENV]: '0' }), false)
    assert.equal(isZoneObservationOptIn({ [ZONE_OBSERVE_ENV]: 'true' }), false, '只认明示 1')
    assert.equal(isZoneObservationOptIn({ [ZONE_OBSERVE_ENV]: '1' }), true)
    // 进程默认接收器:关 → no-op;显式配置 → 计数
    configureZoneObservation(false)
    noteZoneSignal('confirm')
    assert.deepEqual(zoneSignalSnapshot(), zeroSignalCounts())
    configureZoneObservation(true)
    noteZoneSignal('confirm')
    assert.deepEqual(zoneSignalSnapshot(), { ...zeroSignalCounts(), confirm: 1 })
    configureZoneObservation(false)
  })

  // ---- 指标契约 ----
  pass('阈值冻结:夹具声明必须逐字段等于冻结契约,改一个数即 contract_invalid', () => {
    const base = loadFixture()
    const good = projectZoneMetrics(base)
    assert.ok(good.ok, JSON.stringify(good))
    assert.deepEqual(good.report.metric_contract, SESSION_ZONE_METRIC_CONTRACT)
    for (const key of ['minimum_sample_count', 'min_confirm_rate', 'min_reask_avoidance_ratio', 'max_stale_hit_rate', 'frozen_at', 'frozen_before_any_data'] as const) {
      const tampered = { ...base, metric_contract: { ...base.metric_contract, [key]: key === 'frozen_at' ? '2027-01-01' : key === 'frozen_before_any_data' ? false : 0.01 } }
      const r = projectZoneMetrics(tampered)
      assert.equal(r.ok, false, `篡改 ${key} 应被拒`)
      assert.equal((r as { code?: string }).code, 'contract_invalid', `篡改 ${key} 应 contract_invalid`)
    }
    const noContract = { ...base, metric_contract: undefined as never }
    assert.equal((projectZoneMetrics(noContract) as { code?: string }).code, 'contract_invalid')
  })

  pass('三指标口径:确认率/免重问率下界、失效率上界;TTL 外回访不计入工作区收益', () => {
    const r = projectZoneMetrics(loadFixture())
    assert.ok(r.ok)
    const byId = new Map(r.report.metrics.map(m => [m.id, m]))
    const promotion = byId.get('promotion_signal_quality')!
    assert.equal(promotion.sample_count, 6)
    assert.equal(promotion.value, 4 / 6)
    assert.equal(promotion.direction, 'higher_is_better')
    assert.equal(promotion.verdict, 'pass')
    const payoff = byId.get('working_zone_payoff')!
    assert.equal(payoff.sample_count, 5, 'TTL 外的回访配对不计入(不是工作区该负责的窗口)')
    assert.equal(payoff.value, 14 / 22)
    assert.equal(payoff.verdict, 'pass')
    const stale = byId.get('stale_hit_rate')!
    assert.equal(stale.sample_count, 12)
    assert.equal(stale.value, 1 / 12)
    assert.equal(stale.direction, 'lower_is_better')
    assert.equal(stale.verdict, 'pass', '夹具刻意不踩在上界上(1/12 ≈ 0.083 < 0.1)')
    // 上界语义单独验:恰好 0.1 过(≤),刚过 0.1 即不过
    const onBound = projectZoneMetrics({
      ...loadFixture(),
      zone_served_facts: Array.from({ length: 10 }, (_, i) => ({ served_ref: `ref-${i}`, corrected: i === 0 })),
    })
    assert.ok(onBound.ok)
    assert.equal(onBound.report.metrics.find(m => m.id === 'stale_hit_rate')!.verdict, 'pass', '恰好 0.1 仍过(上界是 ≤)')
    const overBound = projectZoneMetrics({
      ...loadFixture(),
      zone_served_facts: Array.from({ length: 9 }, (_, i) => ({ served_ref: `ref-${i}`, corrected: i === 0 })),
    })
    assert.ok(overBound.ok)
    assert.equal(overBound.report.metrics.find(m => m.id === 'stale_hit_rate')!.verdict, 'below_threshold', '1/9 > 0.1 即不过')
  })

  pass('样本不足即 insufficient_sample;越界即 below_threshold(永不因少量样本宣布通过)', () => {
    const base = loadFixture()
    const thin = projectZoneMetrics({
      ...base,
      promotion_decisions: base.promotion_decisions.slice(0, 4),
      reask_pairs: base.reask_pairs.slice(0, 2),
      zone_served_facts: base.zone_served_facts.slice(0, 1),
    })
    assert.ok(thin.ok)
    for (const m of thin.report.metrics) {
      assert.equal(m.verdict, 'insufficient_sample', `${m.id} 样本不足必须 insufficient_sample`)
    }
    const emptyAll = projectZoneMetrics({ ...base, promotion_decisions: [], reask_pairs: [], zone_served_facts: [] })
    assert.ok(emptyAll.ok)
    for (const m of emptyAll.report.metrics) {
      assert.equal(m.value, null, '零样本不得编造 0 或 1')
      assert.equal(m.verdict, 'insufficient_sample')
    }
    // 多数被否决 → below_threshold
    const denied = projectZoneMetrics({
      ...base,
      promotion_decisions: base.promotion_decisions.map((d, i) => ({ ...d, decision: i === 0 ? 'confirmed' : 'denied' })),
    })
    assert.ok(denied.ok)
    assert.equal(denied.report.metrics.find(m => m.id === 'promotion_signal_quality')!.verdict, 'below_threshold')
    // 失效率超上界 → below_threshold
    const stale = projectZoneMetrics({
      ...base,
      zone_served_facts: base.zone_served_facts.map((s, i) => ({ ...s, corrected: i < 2 })),
    })
    assert.ok(stale.ok)
    assert.equal(stale.report.metrics.find(m => m.id === 'stale_hit_rate')!.verdict, 'below_threshold')
  })

  pass('样本形状 fail-closed:未知裁决/负数/重问多于首问/非布尔一律 bad_sample,不猜不截断', () => {
    const base = loadFixture()
    const cases: Array<Partial<ZoneMetricFixture>> = [
      { promotion_decisions: [{ proposal_ref: 'r', decision: 'maybe' }] },
      { reask_pairs: [{ pair_ref: 'p', first_visit_asked_fields: -1, returning_reasked_fields: 0, within_intent_ttl: true }] },
      { reask_pairs: [{ pair_ref: 'p', first_visit_asked_fields: 1.5, returning_reasked_fields: 0, within_intent_ttl: true }] },
      { reask_pairs: [{ pair_ref: 'p', first_visit_asked_fields: 2, returning_reasked_fields: 3, within_intent_ttl: true }] },
      { reask_pairs: [{ pair_ref: 'p', first_visit_asked_fields: 2, returning_reasked_fields: 1, within_intent_ttl: 'yes' as never }] },
      { zone_served_facts: [{ served_ref: 's', corrected: 'no' as never }] },
      { promotion_decisions: 'nope' as never },
    ]
    for (const patch of cases) {
      const r = projectZoneMetrics({ ...base, ...patch })
      assert.equal(r.ok, false, `应被拒:${JSON.stringify(patch).slice(0, 120)}`)
      assert.equal((r as { code?: string }).code, 'bad_sample', `应 bad_sample:${JSON.stringify(r)}`)
    }
    assert.equal((projectZoneMetrics({ ...base, schema: 'other.v1' }) as { code?: string }).code, 'bad_schema')
    assert.equal((projectZoneMetrics({ ...base, evidence_kind: 'exit_evidence' }) as { code?: string }).code, 'bad_schema')
    assert.equal((projectZoneMetrics(null) as { code?: string }).code, 'bad_schema')
  })

  pass('夹具只证契约:synthetic 恒不可作 Exit 证据、恒不声称价值;observed_private 只到 candidate', () => {
    const base = loadFixture()
    const synthetic = projectZoneMetrics(base)
    assert.ok(synthetic.ok)
    assert.equal(synthetic.report.schema, SESSION_ZONE_REPORT_SCHEMA)
    assert.equal(base.schema, SESSION_ZONE_FIXTURE_SCHEMA)
    assert.equal(synthetic.report.exit_evidence_eligible, false)
    assert.equal(synthetic.report.value_claimed, false)
    assert.equal(synthetic.report.source_review.state, 'not_required_for_synthetic')
    const observed = projectZoneMetrics({ ...base, evidence_kind: 'observed_private' })
    assert.ok(observed.ok)
    assert.equal(observed.report.exit_evidence_eligible, false, 'observed_private 同样不可自证 Exit')
    assert.equal(observed.report.value_claimed, false)
    assert.equal(observed.report.source_review.state, 'candidate')
    assert.equal(observed.report.source_review.reviewer_ref, null, '本面永不生成 reviewer 字段')
    assert.equal(observed.report.source_review.attestation_ref, null, '本面永不生成 attestation 字段')
  })

  // ---- 候选导出 ----
  pass('候选导出:只带计数与 HMAC 假名引用(键集闭集);摘要绑定载荷;零内容字段', () => {
    const report = projectZoneMetrics(loadFixture())
    assert.ok(report.ok)
    const root = freshRoot('export')
    const ledger = ensureLedger(root)
    appendZoneWrite(ledger, captureReq())
    const noteId = Object.keys(readZoneLog(ledger).state.hot)[0]!
    appendZoneWrite(ledger, { op: 'promote', input: { note_id: noteId, kind: 'preference', owner_confirm: { surface: 'user_reply', quote: QUOTE }, ts: at(MIN) } })
    const counters = projectZoneCounters(readZoneLog(ledger).events, at(2 * MIN))
    const built = buildZoneObservationExport({
      evidenceKind: 'synthetic_fixture',
      dataset: 'p4-contract-fixture',
      consent: '我同意导出形状计数用于 #255 指标契约验证',
      hmacKey: HMAC_KEY,
      counters,
      signals: { proposal: 3, confirm: 2, deny: 1, read_hit: 4, read_miss: 2 },
      observationOptIn: true,
      report: report.report,
      generatedAt: at(3 * MIN),
    })
    assert.ok(built.ok, JSON.stringify(built))
    const exported = built.export
    assert.equal(exported.schema, SESSION_ZONE_EXPORT_SCHEMA)
    assert.match(exported.dataset_ref, /^hmac-sha256:[0-9a-f]{64}$/)
    assert.match(exported.consent_ref, /^hmac-sha256:[0-9a-f]{64}$/)
    assert.notEqual(exported.dataset_ref, exported.consent_ref)
    // 键集闭集:导出里不得出现任何闭集外键名(内容字段一律进不来)
    for (const key of allKeys(exported)) {
      assert.ok(ZONE_EXPORT_ALLOWED_KEYS.includes(key), `导出出现闭集外键:${key}`)
    }
    // 零内容:原话/城市/会话/笔记 id 一个都不得出现
    const serialized = JSON.stringify(exported)
    for (const forbidden of [QUOTE, '大理', SESS, noteId, 'p4-contract-fixture', '我同意导出']) {
      assert.equal(serialized.includes(forbidden), false, `导出不得携带:${forbidden}`)
    }
    // 摘要绑定:改一个计数,摘要就变
    const tampered = buildZoneObservationExport({
      evidenceKind: 'synthetic_fixture',
      dataset: 'p4-contract-fixture',
      consent: '我同意导出形状计数用于 #255 指标契约验证',
      hmacKey: HMAC_KEY,
      counters: { ...counters, notebook: { ...counters.notebook, promoted: 99 } },
      signals: { proposal: 3, confirm: 2, deny: 1, read_hit: 4, read_miss: 2 },
      observationOptIn: true,
      report: report.report,
      generatedAt: at(3 * MIN),
    })
    assert.ok(tampered.ok)
    assert.notEqual(tampered.export.payload_digest_sha256, exported.payload_digest_sha256)
  })

  pass('导出 fail-closed:缺同意声明 / 缺 HMAC key / 弱 key 一律拒绝(引用必须假名化)', () => {
    const report = projectZoneMetrics(loadFixture())
    assert.ok(report.ok)
    const common = {
      evidenceKind: 'synthetic_fixture' as const,
      dataset: 'p4',
      counters: projectZoneCounters([], T0),
      signals: zeroSignalCounts(),
      observationOptIn: false,
      report: report.report,
      generatedAt: T0,
    }
    assert.equal((buildZoneObservationExport({ ...common, consent: '', hmacKey: HMAC_KEY }) as { code?: string }).code, 'missing_consent')
    assert.equal((buildZoneObservationExport({ ...common, consent: '   ', hmacKey: HMAC_KEY }) as { code?: string }).code, 'missing_consent')
    assert.equal((buildZoneObservationExport({ ...common, consent: '同意', hmacKey: undefined }) as { code?: string }).code, 'missing_hmac_key')
    assert.equal((buildZoneObservationExport({ ...common, consent: '同意', hmacKey: 'short' }) as { code?: string }).code, 'invalid_hmac_key')
  })

  // ---- 零定时器/零网络 ----
  pass('观测路径零定时器、零网络(真实 spy:fetch/setTimeout/setInterval 全程零调用)', () => {
    const g = globalThis as unknown as Record<string, unknown>
    const realFetch = g.fetch
    const realTimeout = g.setTimeout
    const realInterval = g.setInterval
    const realImmediate = g.setImmediate
    let calls = 0
    g.fetch = () => { calls++; throw new Error('观测路径不得联网') }
    g.setTimeout = () => { calls++; throw new Error('观测路径不得挂定时器') }
    g.setInterval = () => { calls++; throw new Error('观测路径不得挂定时器') }
    g.setImmediate = () => { calls++; throw new Error('观测路径不得挂定时器') }
    try {
      const root = freshRoot('spy')
      const ledger = ensureLedger(root)
      appendZoneWrite(ledger, captureReq())
      const counters = projectZoneCounters(readZoneLog(ledger).events, at(MIN))
      const report = projectZoneMetrics(loadFixture())
      assert.ok(report.ok)
      const built = buildZoneObservationExport({
        evidenceKind: 'synthetic_fixture',
        dataset: 'spy',
        consent: '同意',
        hmacKey: HMAC_KEY,
        counters,
        signals: zeroSignalCounts(),
        observationOptIn: false,
        report: report.report,
        generatedAt: T0,
      })
      assert.ok(built.ok)
      const sink = createZoneCounterSink(true)
      sink.note('read_hit')
      assert.equal(calls, 0, '观测路径零 fetch / 零定时器')
    } finally {
      g.fetch = realFetch
      g.setTimeout = realTimeout
      g.setInterval = realInterval
      g.setImmediate = realImmediate
    }
  })

  // ---- CLI 面 ----
  pass('CLI:report 输出报告;counters 无账本即全 0 且不建库;export --out 不覆盖;坏夹具 exit 2', () => {
    const emptyRoot = freshRoot('cli')
    const report = spawnSync('npx', ['tsx', 'scripts/session-zone-observe.ts', 'report', '--fixture', FIXTURE_PATH], { encoding: 'utf-8', timeout: 120_000 })
    assert.equal(report.status, 0, `report 应 exit 0:${report.stderr?.slice(0, 300)}`)
    const parsed = JSON.parse(report.stdout) as ZoneMetricReport
    assert.equal(parsed.exit_evidence_eligible, false)
    assert.equal(parsed.value_claimed, false)
    assert.equal(parsed.metrics.length, 3)

    const counters = spawnSync('npx', ['tsx', 'scripts/session-zone-observe.ts', 'counters', '--state-root', emptyRoot], { encoding: 'utf-8', timeout: 120_000 })
    assert.equal(counters.status, 0, `counters 应 exit 0:${counters.stderr?.slice(0, 300)}`)
    const countersOut = JSON.parse(counters.stdout) as { counters: { captures: Record<string, number> }; observation_opt_in: boolean }
    assert.deepEqual(countersOut.counters.captures, { resource: 0, intent: 0 })
    assert.equal(countersOut.observation_opt_in, false, '默认不 opt-in')
    assert.equal(existsSync(join(emptyRoot, 'gotry-state', 'gotry-state.db')), false, '只读 CLI 不得建库')

    const out = join(emptyRoot, 'zone-export.json')
    const first = spawnSync('npx', ['tsx', 'scripts/session-zone-observe.ts', 'export', '--fixture', FIXTURE_PATH, '--consent', '同意导出形状计数', '--hmac-key', HMAC_KEY, '--dataset', 'p4-cli', '--state-root', emptyRoot, '--out', out], { encoding: 'utf-8', timeout: 120_000 })
    assert.equal(first.status, 0, `export 应 exit 0:${first.stderr?.slice(0, 400)}`)
    const exported = JSON.parse(readFileSync(out, 'utf-8')) as Record<string, unknown>
    for (const key of allKeys(exported)) assert.ok(ZONE_EXPORT_ALLOWED_KEYS.includes(key), `CLI 导出出现闭集外键:${key}`)
    assert.equal(JSON.stringify(exported).includes('p4-cli'), false, 'dataset 名不得明文出现')
    const again = spawnSync('npx', ['tsx', 'scripts/session-zone-observe.ts', 'export', '--fixture', FIXTURE_PATH, '--consent', '同意导出形状计数', '--hmac-key', HMAC_KEY, '--dataset', 'p4-cli', '--state-root', emptyRoot, '--out', out], { encoding: 'utf-8', timeout: 120_000 })
    assert.equal(again.status, 2, '拒绝覆盖既有导出')
    assert.match(again.stderr, /output_exists/)

    const badFixture = join(emptyRoot, 'bad.json')
    const badRun = spawnSync('npx', ['tsx', 'scripts/session-zone-observe.ts', 'report', '--fixture', badFixture], { encoding: 'utf-8', timeout: 120_000 })
    assert.notEqual(badRun.status, 0, '夹具不可读必须非 0 退出')
  })

  // ---- #20 冻结闸不被触碰 ----
  pass('#20 scorer 的冻结 p4 闸不被本面改动:#228 manifest 仍 closed、触发器仍全 false', () => {
    const root = freshRoot('p4gate')
    initMemoryLifecycleDataset({
      stateRoot: root,
      consent: '我同意用于 #255 指标契约自测',
      hmacKey: HMAC_KEY,
      dataset: 'p4-gate-check',
      sourceKind: 'synthetic_fixture',
      waitCodes: ['vendor_wait'],
    })
    const store = readStoreForTests(root)
    assert.deepEqual(store.manifest.p4, { state: 'closed', triggers: { real_usage: false, multi_user: false } })
    assert.deepEqual(store.manifest.measurement_policy.minimum_pair_count_for_exit, 5)
    assert.equal(store.manifest.measurement_policy.target_median_reduction_ratio, 0.5)
    // 冻结契约与 #20 同源的两个数:样本线与收益线不另发明
    assert.equal(SESSION_ZONE_METRIC_CONTRACT.minimum_sample_count, store.manifest.measurement_policy.minimum_pair_count_for_exit)
    assert.equal(SESSION_ZONE_METRIC_CONTRACT.min_reask_avoidance_ratio, store.manifest.measurement_policy.target_median_reduction_ratio)
  })

  // ---- 接线面真的在喂计数(否则确认率恒为 1 = 假指标) ----
  pass('接线面喂计数:propose/deny/confirm 与读回命中各自入账;opt-in 关时同样调用链零计数', () => {
    const root = freshRoot('signals')
    const ledger = ensureLedger(root)
    const ts = new Date().toISOString()
    // 源笔记用 availability + 无权威形状键的载荷:lesson 晋升本就该留在笔记本
    const mk = (payload: Record<string, unknown>) => {
      const before = new Set(Object.keys(readZoneLog(ledger).state.hot))
      assert.ok(appendZoneWrite(ledger, { op: 'capture', input: { session_ref: SESS, tier: 'resource', kind: 'availability', payload, evidence_ref: { session_ref: SESS, turn: 0 }, ts } }).ok)
      const born = Object.keys(readZoneLog(ledger).state.hot).find(id => !before.has(id))
      assert.ok(born, `捕获应产生新主体:${JSON.stringify(payload)}`)
      return born
    }
    const noteA = mk({ lesson: 'too_tight' })
    const noteB = mk({ lesson: 'too_long' })

    // opt-in 关:同一条调用链零计数
    configureZoneObservation(false)
    applyZoneNote(ledger, { action: 'propose', noteId: noteA, promoteKind: 'lesson', session_ref: SESS, ts })
    applyZoneNote(ledger, { action: 'deny', noteId: noteA, session_ref: SESS, ts })
    renderSessionZoneBrief({ ledger, now: ts, sessionRef: SESS, zoneSwitch: 'on' })
    assert.deepEqual(zoneSignalSnapshot(), zeroSignalCounts(), 'opt-in 关闭时整条链零计数')

    // opt-in 开:计数口径与指标 ① 的 proposal_ref 去重口径一致
    configureZoneObservation(true)
    resetZoneSessionBindingForTests() // 清提议去重集,从干净口径开始
    assert.ok(applyZoneNote(ledger, { action: 'propose', noteId: noteA, promoteKind: 'lesson', session_ref: SESS, ts }).ok)
    assert.ok(applyZoneNote(ledger, { action: 'propose', noteId: noteA, promoteKind: 'lesson', session_ref: SESS, ts }).ok)
    assert.deepEqual(zoneSignalSnapshot().proposal, 1, '同一提议重复两次仍是一个提议(与 proposal_ref 去重同口径)')
    assert.ok(applyZoneNote(ledger, { action: 'propose', noteId: noteB, promoteKind: 'lesson', session_ref: SESS, ts }).ok)
    assert.equal(zoneSignalSnapshot().proposal, 2, '不同提议各记一次')
    assert.ok(applyZoneNote(ledger, { action: 'deny', noteId: noteA, session_ref: SESS, ts }).ok)
    assert.ok(applyZoneNote(ledger, { action: 'deny', noteId: noteA, session_ref: SESS, ts }).ok)
    assert.equal(zoneSignalSnapshot().deny, 1, '同一提议被否两次仍是一次否决')
    const promoted = promoteWithRouting(ledger, { noteId: noteB, kind: 'lesson', ownerQuote: QUOTE, surface: 'user_reply', ts })
    assert.ok(promoted.ok, JSON.stringify(promoted))
    const replay = promoteWithRouting(ledger, { noteId: noteB, kind: 'lesson', ownerQuote: QUOTE, surface: 'user_reply', ts })
    assert.ok(replay.ok && replay.appended === false, '幂等重放不是第二次确认')
    assert.equal(zoneSignalSnapshot().confirm, 1, '确认只在真的落了条目时记一次')
    const hit = renderSessionZoneBrief({ ledger, now: ts, sessionRef: SESS, zoneSwitch: 'on' })
    assert.notEqual(hit, '', '有活笔记 = 读命中')
    const emptyRoot = freshRoot('signals-empty')
    renderSessionZoneBrief({ ledger: ensureLedger(emptyRoot), now: ts, sessionRef: SESS, zoneSwitch: 'on' })
    assert.deepEqual(zoneSignalSnapshot(), { proposal: 2, confirm: 1, deny: 1, read_hit: 1, read_miss: 1 })
    // deny 零落账:否决不动账本
    assert.equal(Object.keys(readZoneLog(ledger).state.hot).length, 2)
    configureZoneObservation(false)
  })

  console.log(`\nSESSION ZONE OBSERVATION TESTS: ${n}/14 OK(P4-4 观测与指标:形状计数零内容/opt-in 默认关/阈值冻结 contract_invalid/样本不足 insufficient_sample/夹具只证契约不证价值/候选导出键集闭集与假名引用/零定时器零网络 spy/#20 p4 闸未被触碰;隔离 stateRoot,全离线)`)
} finally {
  configureZoneObservation(false)
  for (const root of roots) rmSync(root, { recursive: true, force: true })
}
