/**
 * 真实 sf-01..08 双源 e2e 跑批(issue #21 验收清单,goal 2 sf-live-benchmark)
 * ——pluggable golden 版:
 *
 * 之前版本绑 flyaiSearch 失败(Trial limit reached);本版改 pluggable:
 *   - 默认 comparator = 手工 golden(data/sf-golden-manifest.json 时间/价格带,零网络零 vendor)
 *   - 可选 --golden=flyai / --golden=static 显式切换；未知 vendor 在网络调用前 fail-closed
 *   - static = OpenFlights 固定 route/carrier 快照 + manual 时间/价格带；估算字段与回退原因显式落证据
 *   - 字段评分改软命中:硬字段(query_id/from/to/currency/source/verdict)必中,软字段
 *     (transport_number/departure_at/arrival_at/price)落在窗口内算 correct
 *
 * 与 ts/scripts/session-benchmark.ts 的关系:session-benchmark.ts 是离线 fixture 自测
 * (13/18 字段黄金 + 双源合同纯函数断言);sf-live-benchmark.ts 是真网络真扩展端到端。
 *
 * evidence 落盘:~/.gotry/evidence/session/sf-XX/<ISO ts>.json(issue #21/#67 私有证据)
 *
 * 挑战红线(RFC §3.5,issue #411):任一 query 的 session verdict=challenged
 * (或双源 state=challenge_stop/guard_violation)即停止本批后续查询——不重试、
 * 不绕过,session 与 comparator 都不再调用;批次以部分结果落盘,stop_reason 标注
 * challenge_stop/guard_violation,并给出 attempted/not_attempted 清单。sf-summary
 * 侧缺条批次一律 fail_closed,不得标为完整或有效校准。
 *
 * 退出码:0 = 正常结束(跑满 8 条,或按红线提前停止;stop_reason 区分;
 * 即便部分 query miss 也是 0);1 = 参数/加载异常。人类评审 evidence 决定 issue 是否可关
 *
 * 测试节律:同 query 间隔默认 35_000ms(§3.4 ≥30s);离线测试可设
 * GOTRY_SF_INTER_QUERY_DELAY_MS=<非负整数毫秒> 缩短,非法值回退默认,不影响停止逻辑
 */

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

import {
  evaluateDoubleSource,
  type SessionComparableRecord,
  SESSION_FIELD_ACCURACY_THRESHOLD,
} from '../capabilities/session/benchmark.ts'
import { sessionFlightSearch, type SessionSearchResult } from '../capabilities/session-search.ts'
import { flyaiSearch } from '../capabilities/flyai.ts'
import {
  loadStaticFlightSnapshot,
  parseGoldenSource,
  resolveStaticGolden,
  type GoldenSource,
  type StaticFlightSnapshot,
  type StaticGoldenResolution,
} from '../capabilities/session/static-flight-golden.ts'
import {
  scoreSessionAgainstGoldenBand,
  type GoldenBand,
  type GoldenSoftScore,
} from '../capabilities/session/golden-score.ts'

interface GoldenQuery {
  id: string
  kind: string
  from: string
  to: string
  date: string
}
interface GoldenFile {
  queries: GoldenQuery[]
}

type GoldenMatch = GoldenBand
interface GoldenManifest {
  comment: string
  threshold: number
  matches: GoldenMatch[]
}

/** 从 session-golden-20.json 拿 8 条飞行 query */
function loadFlightQueries(): GoldenQuery[] {
  const golden = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'data', 'session-golden-20.json'), 'utf8')) as GoldenFile
  return golden.queries.filter((q) => q.id.startsWith('sf-')).slice(0, 8)
}

/** 从 sf-golden-manifest.json 拿手工 golden(默认 official 来源) */
function loadManualGolden(): GoldenManifest {
  return JSON.parse(readFileSync(join(import.meta.dirname, '..', 'data', 'sf-golden-manifest.json'), 'utf8')) as GoldenManifest
}

/** 手工 golden 的单条 → SessionComparableRecord */
function manualToRecord(m: GoldenMatch, sample: { depTime: string; arrTime: string; flightNo: string; price: number }): SessionComparableRecord {
  return {
    query_id: m.query_id,
    route_segments: [{
      from: m.from,
      to: m.to,
      departure_at: `${m.date}T${sample.depTime}:00+08:00`,
      arrival_at: `${m.date}T${sample.arrTime}:00+08:00`,
      transport_number: sample.flightNo,
    }],
    journey_type: 'direct',
    currency: 'CNY',
    price: sample.price,
    source: 'manual-golden',
    fetched_at: new Date().toISOString(),
    verdict: 'hit',
    latency_ms: 0,
    read_guard_blocked: 0,
  }
}

/** FlyAI vendor: 真打飞猪官方(可能 trial limit,落 verdict=error) */
async function flyaiOfficial(q: GoldenQuery): Promise<{ record: SessionComparableRecord | null; latencyMs: number; error?: string }> {
  const started = Date.now()
  try {
    const r = await flyaiSearch({ kind: 'flight', origin: q.from, destination: q.to, depDate: q.date, timeoutMs: 30_000 })
    const latencyMs = Date.now() - started
    if (r.ok && r.options && r.options.length > 0) {
      const sorted = r.options.slice().sort((a, b) => Date.parse(a.depDateTime) - Date.parse(b.depDateTime))
      const opt = sorted[0]!
      const rec: SessionComparableRecord = {
        query_id: q.id,
        route_segments: [{
          from: q.from,
          to: q.to,
          departure_at: opt.depDateTime,
          arrival_at: opt.arrDateTime,
          transport_number: opt.no,
        }],
        journey_type: 'direct',
        currency: 'CNY',
        price: opt.price,
        source: 'flyai',
        fetched_at: new Date().toISOString(),
        verdict: 'hit',
        latency_ms: latencyMs,
        read_guard_blocked: 0,
      }
      return { record: rec, latencyMs }
    }
    return { record: { ...emptyOfficialRecord(q, 'flyai'), latency_ms: latencyMs, verdict: 'error' }, latencyMs, error: r.error ?? 'no options' }
  } catch (e) {
    return { record: emptyOfficialRecord(q, 'flyai'), latencyMs: Date.now() - started, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 手工 golden vendor: 不打网络,从 manifest 取首个 known_flight 的时刻窗口算中位时间 + 价格带中位 */
function manualOfficial(q: GoldenQuery, manifest: GoldenManifest): { record: SessionComparableRecord | null; latencyMs: number } {
  const started = Date.now()
  const m = manifest.matches.find((x) => x.query_id === q.id)
  if (!m) return { record: emptyOfficialRecord(q, 'manual-golden'), latencyMs: Date.now() - started }
  // 中位时间(早 + 晚 ÷ 2);中位价格(带中位)
  const depMedian = hhmmMid(m.window_dep_local.earliest, m.window_dep_local.latest)
  const arrMedian = hhmmMid(m.window_arr_local.earliest, m.window_arr_local.latest)
  const priceMedian = Math.round((m.price_cny.min + m.price_cny.max) / 2)
  return {
    record: manualToRecord(m, { depTime: depMedian, arrTime: arrMedian, flightNo: m.known_flights[0] ?? '', price: priceMedian }),
    latencyMs: Date.now() - started,
  }
}

function hhmmMid(a: string, b: string): string {
  const aMin = parseInt(a.split(':')[0]!, 10) * 60 + parseInt(a.split(':')[1]!, 10)
  const bMin = parseInt(b.split(':')[0]!, 10) * 60 + parseInt(b.split(':')[1]!, 10)
  const mid = Math.round((aMin + bMin) / 2)
  return `${Math.floor(mid / 60).toString().padStart(2, '0')}:${(mid % 60).toString().padStart(2, '0')}`
}

function emptyOfficialRecord(q: GoldenQuery, source: string): SessionComparableRecord {
  return {
    query_id: q.id,
    route_segments: [],
    journey_type: 'direct',
    currency: '',
    price: 0,
    source,
    fetched_at: new Date().toISOString(),
    verdict: 'error',
    latency_ms: 0,
    read_guard_blocked: 0,
  }
}

interface QueryRunRecord {
  query_id: string
  expected: { from: string; to: string; date: string; kind: string }
  requested_source: GoldenSource
  effective_source: string
  fallback_reason: string | null
  estimated_fields: string[]
  official_provenance: StaticGoldenResolution['provenance'] | null
  official: SessionComparableRecord | null
  official_source: string
  session: SessionComparableRecord | null
  doubleSource: ReturnType<typeof evaluateDoubleSource>
  softScore: GoldenSoftScore | null
  officialLatencyMs: number | null
  sessionLatencyMs: number | null
  sessionVerdict: string
  sessionError: string | undefined
  started_at: string
}

interface RunSummary {
  started_at: string
  duration_ms: number
  threshold: number
  total: number
  accuracy_pass: number
  comparable: number
  hit: number
  challenge: number
  no_data: number
  live_under_15s: number
  requested_source: GoldenSource
  effective_sources: string[]
  fallback_count: number
  golden_source: string
  /** 批次是否跑满 8 条;challenge/guard 停止的批次为 false(可审阅的部分批次) */
  batch_complete: boolean
  /** completed=跑满;challenge_stop=风控/验证码触发即停(RFC §3.5);guard_violation=读守卫违例即停 */
  stop_reason: 'completed' | 'challenge_stop' | 'guard_violation'
  attempted_query_ids: string[]
  not_attempted_query_ids: string[]
  records: QueryRunRecord[]
}

interface StaticContext {
  snapshot?: StaticFlightSnapshot
  error?: string
}

type BatchStopReason = RunSummary['stop_reason']

/** 节律间隔(§3.4 同站点 ≥30s);仅离线测试经 env 缩短,非法值 fail-closed 回默认 */
const DEFAULT_INTER_QUERY_DELAY_MS = 35_000
function interQueryDelayMs(): number {
  const raw = (process.env.GOTRY_SF_INTER_QUERY_DELAY_MS ?? '').trim()
  if (raw === '') return DEFAULT_INTER_QUERY_DELAY_MS
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== raw) {
    console.error(`[sf-live-benchmark] GOTRY_SF_INTER_QUERY_DELAY_MS="${raw}" 非法,回退默认 ${DEFAULT_INTER_QUERY_DELAY_MS}ms`)
    return DEFAULT_INTER_QUERY_DELAY_MS
  }
  return parsed
}

async function runOne(
  q: GoldenQuery,
  requestedSource: GoldenSource,
  manifest: GoldenManifest,
  staticContext: StaticContext,
): Promise<QueryRunRecord> {
  const startedAt = new Date().toISOString()
  let official: SessionComparableRecord | null = null
  let officialLatencyMs: number | null = null
  let effectiveSource = requestedSource === 'manual' ? 'manual-golden' : requestedSource
  let fallbackReason: string | null = null
  let estimatedFields: string[] = []
  let officialProvenance: StaticGoldenResolution['provenance'] | null = null

  if (requestedSource === 'manual') {
    const m = manualOfficial(q, manifest)
    official = m.record
    officialLatencyMs = m.latencyMs
  } else if (requestedSource === 'flyai') {
    const r = await flyaiOfficial(q)
    official = r.record
    officialLatencyMs = r.latencyMs
  } else {
    const started = Date.now()
    const manual = manualOfficial(q, manifest)
    const resolution = resolveStaticGolden({
      query: q,
      manualRecord: manual.record ?? emptyOfficialRecord(q, 'manual-golden'),
      snapshot: staticContext.snapshot,
      snapshotError: staticContext.error,
      warn: (message) => console.error(message),
    })
    official = resolution.record
    officialLatencyMs = Date.now() - started
    effectiveSource = resolution.effective_source
    fallbackReason = resolution.fallback_reason ?? null
    estimatedFields = resolution.estimated_fields
    officialProvenance = resolution.provenance
  }

  // session = sessionFlightSearch(节律闸 ≥30s 由 caller sleep 35s 处理)
  const sessStarted = Date.now()
  const sessRes: SessionSearchResult = await sessionFlightSearch({ from: q.from, to: q.to, date: q.date, timeoutMs: 25_000 })
  const sessionLatencyMs = Date.now() - sessStarted
  const sessionVerdict = sessRes.verdict
  const sessionError = sessRes.error
  let session: SessionComparableRecord | null = null
  if (sessRes.verdict === 'hit' && sessRes.options && sessRes.options.length > 0) {
    const sorted = sessRes.options.slice().sort((a, b) => Date.parse(a.depDateTime) - Date.parse(b.depDateTime))
    const opt = sorted[0]!
    session = {
      query_id: q.id,
      route_segments: [{
        from: q.from,
        to: q.to,
        departure_at: opt.depDateTime,
        arrival_at: opt.arrDateTime,
        transport_number: opt.flightNo,
      }],
      journey_type: 'direct',
      currency: 'CNY',
      price: opt.price,
      source: 'ctrip-flight',
      fetched_at: new Date().toISOString(),
      verdict: 'hit',
      latency_ms: sessionLatencyMs,
      read_guard_blocked: 0,
    }
  } else {
    // challenged 原样保留(issue #411):SessionVerdict 与 SessionEvidenceVerdict 同构,
    // 改写为 error 会让 evaluateDoubleSource 丢失 challenge_stop 语义变成 source_unavailable
    session = {
      query_id: q.id,
      route_segments: [],
      journey_type: 'direct',
      currency: '',
      price: 0,
      source: 'ctrip-flight',
      fetched_at: new Date().toISOString(),
      verdict: sessRes.verdict,
      latency_ms: sessionLatencyMs,
      read_guard_blocked: 0,
    }
  }

  const doubleSource = evaluateDoubleSource({ official: official ?? undefined, session: session ?? undefined })

  // 字段准确率始终对照同一 manual band；provider 只改变 official 来源与 provenance。
  let softResult: GoldenSoftScore | null = null
  const m = manifest.matches.find((x) => x.query_id === q.id)
  if (session?.verdict === 'hit' && m) {
    softResult = scoreSessionAgainstGoldenBand(session, m, effectiveSource)
  }

  return {
    query_id: q.id,
    expected: { from: q.from, to: q.to, date: q.date, kind: q.kind },
    requested_source: requestedSource,
    effective_source: effectiveSource,
    fallback_reason: fallbackReason,
    estimated_fields: estimatedFields,
    official_provenance: officialProvenance,
    official,
    official_source: effectiveSource,
    session,
    doubleSource,
    softScore: softResult,
    officialLatencyMs,
    sessionLatencyMs,
    sessionVerdict: String(sessionVerdict),
    sessionError,
    started_at: startedAt,
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const requestedSource = parseGoldenSource(args)
  const queries = loadFlightQueries()
  if (queries.length < 8) {
    console.error(`金标准 sf-* 不足 8 条(实际 ${queries.length})`)
    process.exit(1)
  }
  const manifest = loadManualGolden()
  const staticContext: StaticContext = {}
  if (requestedSource === 'static') {
    try {
      staticContext.snapshot = loadStaticFlightSnapshot()
    } catch (error) {
      staticContext.error = error instanceof Error ? error.message : String(error)
    }
  }
  const sourceDescription = requestedSource === 'manual'
    ? '手工 golden (sf-golden-manifest.json,零网络零 vendor)'
    : requestedSource === 'flyai'
      ? 'flyai (FlyAI 官方)'
      : 'static (OpenFlights route/carrier + manual time/price band,估算字段显式标注)'
  console.log(`[sf-live-benchmark] requested official source = ${sourceDescription}`)
  console.log(`[sf-live-benchmark] 阈值:字段准确率 ≥${SESSION_FIELD_ACCURACY_THRESHOLD * 100}%(软命中)`)

  const runStartedAt = new Date().toISOString()
  const runStartedMs = Date.now()
  const interQueryDelay = interQueryDelayMs()
  const records: QueryRunRecord[] = []
  const attemptedQueryIds: string[] = []
  let stopReason: BatchStopReason = 'completed'
  for (const q of queries) {
    if (records.length > 0) await new Promise((r) => setTimeout(r, interQueryDelay))
    console.log(`\n[sf-live-benchmark] ${q.id} ${q.from}→${q.to} ${q.date}`)
    const rec = await runOne(q, requestedSource, manifest, staticContext)
    records.push(rec)
    attemptedQueryIds.push(q.id)
    const evPath = join(homedir(), '.gotry', 'evidence', 'session', q.id, `${runStartedAt.replace(/[:.]/g, '-')}.json`)
    mkdirSync(dirname(evPath), { recursive: true })
    writeFileSync(evPath, JSON.stringify(rec, null, 2))
    console.log(`  official(requested=${rec.requested_source},effective=${rec.effective_source}): verdict=${rec.official?.verdict ?? '-'} latency=${rec.officialLatencyMs ?? 0}ms${rec.fallback_reason ? ` fallback=${rec.fallback_reason}` : ''}`)
    console.log(`  session(ctrip): verdict=${rec.sessionVerdict} latency=${rec.sessionLatencyMs ?? 0}ms${rec.sessionError ? ` err=${rec.sessionError.slice(0, 80)}` : ''}`)
    console.log(`  doubleSource: state=${rec.doubleSource.state} quota=${rec.doubleSource.quota_disposition} price_delta=${rec.doubleSource.price_delta ?? '-'} mismatches=${rec.doubleSource.mismatches.length}`)
    if (rec.softScore) {
      console.log(`  soft score: ${(rec.softScore.accuracy * 100).toFixed(1)}% (${rec.softScore.correct}/${rec.softScore.total}) ${rec.softScore.pass ? '✅' : '❌'} missing=${JSON.stringify(rec.softScore.missing)} incorrect=${JSON.stringify(rec.softScore.incorrect)}`)
    }
    // RFC §3.5 红线:风控/验证码或读守卫违例即停止本批后续查询——不重试、不绕过;
    // session 与 comparator 都不再被调用,余下 query 记入 not_attempted(issue #411)
    if (rec.sessionVerdict === 'challenged' || rec.doubleSource.state === 'challenge_stop') {
      stopReason = 'challenge_stop'
      console.log(`  [sf-live-benchmark] 挑战触发(verdict=${rec.sessionVerdict},state=${rec.doubleSource.state}):停止本批后续查询(RFC §3.5;不重试不绕过)`)
      break
    }
    if (rec.doubleSource.state === 'guard_violation') {
      stopReason = 'guard_violation'
      console.log(`  [sf-live-benchmark] 读守卫违例(state=guard_violation):停止本批后续查询(RFC §3.5;不重试不绕过)`)
      break
    }
  }
  const attemptedSet = new Set(attemptedQueryIds)
  const notAttemptedQueryIds = queries.filter((q) => !attemptedSet.has(q.id)).map((q) => q.id)

  const accuracy_pass = records.filter((r) => r.softScore?.pass === true).length
  const comparable = records.filter((r) => r.doubleSource.state === 'comparable').length
  const hit = records.filter((r) => r.sessionVerdict === 'hit').length
  const challenge = records.filter((r) => r.sessionVerdict === 'challenged' || r.doubleSource.state === 'challenge_stop' || r.doubleSource.state === 'guard_violation').length
  const no_data = records.filter((r) => r.official?.verdict !== 'hit' || (r.sessionVerdict !== 'hit' && r.sessionVerdict !== 'challenged')).length
  const live_under_15s = records.filter((r) =>
    (r.sessionLatencyMs !== null && r.sessionVerdict === 'hit' && r.sessionLatencyMs < 15_000)
  ).length
  const effectiveSources = Array.from(new Set(records.map((record) => record.effective_source)))
  const fallbackCount = records.filter((record) => record.fallback_reason !== null).length

  const summary: RunSummary = {
    started_at: runStartedAt,
    duration_ms: Date.now() - runStartedMs,
    threshold: SESSION_FIELD_ACCURACY_THRESHOLD,
    total: records.length,
    accuracy_pass,
    comparable,
    hit,
    challenge,
    no_data,
    live_under_15s,
    requested_source: requestedSource,
    effective_sources: effectiveSources,
    fallback_count: fallbackCount,
    golden_source: requestedSource === 'manual' ? 'manual-golden' : requestedSource,
    batch_complete: records.length === queries.length,
    stop_reason: stopReason,
    attempted_query_ids: attemptedQueryIds,
    not_attempted_query_ids: notAttemptedQueryIds,
    records,
  }

  const summaryPath = join(homedir(), '.gotry', 'evidence', 'session', 'sf-summary', `${runStartedAt.replace(/[:.]/g, '-')}.json`)
  mkdirSync(dirname(summaryPath), { recursive: true })
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2))

  console.log(`\n──── sf-live-benchmark 汇总 ────`)
  console.log(`golden requested = ${summary.requested_source}`)
  console.log(`golden effective = ${summary.effective_sources.join(',')};fallback=${summary.fallback_count}`)
  console.log(`跑批 query 数: ${records.length}`)
  console.log(`stop reason: ${summary.stop_reason}${summary.stop_reason !== 'completed' ? `;attempted=[${summary.attempted_query_ids.join(',')}] not_attempted=[${summary.not_attempted_query_ids.join(',')}]` : ''}`)
  console.log(`verdict=hit: ${hit}/${records.length}`)
  console.log(`双源合同=comparable: ${comparable}/${records.length}`)
  console.log(`字段准确率 ≥${SESSION_FIELD_ACCURACY_THRESHOLD * 100}% (软命中): ${accuracy_pass}/${records.filter((r) => r.softScore !== null).length}`)
  console.log(`live <15s (hit): ${live_under_15s}/${hit || 0}`)
  console.log(`challenge/guard 触发: ${challenge}`)
  console.log(`总耗时: ${summary.duration_ms}ms`)
  process.exit(0)
}

main().catch((e: unknown) => {
  console.error(`[sf-live-benchmark] 异常: ${e instanceof Error ? e.message : String(e)}`)
  console.error(e instanceof Error ? e.stack : '')
  process.exit(1)
})
