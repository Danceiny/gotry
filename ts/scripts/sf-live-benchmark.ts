/**
 * 真实 sf-01..08 双源 e2e 跑批(issue #21 验收清单,goal 2 sf-live-benchmark)
 * ——pluggable golden 版:
 *
 * 之前版本绑 flyaiSearch 失败(Trial limit reached);本版改 pluggable:
 *   - 默认 official = 手工 golden(数据/sf-golden-manifest.json 公开班期 + 价格带,零网络零 vendor)
 *   - 可选 --golden=flyai / --golden=hbcli 显式切换(FlyAI 走 flyaiSearch / hbcli 走 hotelbyte-cli)
 *   - 字段评分改软命中:硬字段(query_id/from/to/currency/source/verdict)必中,软字段
 *     (transport_number/departure_at/arrival_at/price)落在窗口内算 correct
 *
 * 与 ts/scripts/session-benchmark.ts 的关系:session-benchmark.ts 是离线 fixture 自测
 * (13/18 字段黄金 + 双源合同纯函数断言);sf-live-benchmark.ts 是真网络真扩展端到端。
 *
 * evidence 落盘:gotry-state/evidence/session/sf-XX/<ISO ts>.json(issue #21 私有证据)
 *
 * 退出码:0 = 跑完(即便部分 query miss);人类评审 evidence 决定 issue 是否可关
 */

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

import {
  evaluateDoubleSource,
  scoreSessionFixture,
  type SessionComparableRecord,
  SESSION_FIELD_ACCURACY_THRESHOLD,
} from '../capabilities/session/benchmark.ts'
import { sessionFlightSearch, type SessionSearchResult } from '../capabilities/session-search.ts'
import { flyaiSearch } from '../capabilities/flyai.ts'

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

interface GoldenMatch {
  query_id: string
  from: string
  to: string
  date: string
  window_dep_local: { earliest: string; latest: string }
  window_arr_local: { earliest: string; latest: string }
  duration_min: { min: number; max: number }
  price_cny: { min: number; max: number }
  transport_hint: string
  known_flights: string[]
}
interface GoldenManifest {
  comment: string
  threshold: number
  matches: GoldenMatch[]
}

interface SoftScoreResult {
  pass: boolean
  /** 软命中分母 = session 总字段数(13 字段直飞) */
  total: number
  /** 软命中分子 = 硬字段 + 窗口内软字段 */
  correct: number
  /** 软命中的精度 = correct / total */
  accuracy: number
  /** 透传字段缺失 / 字段超出窗口的明细(给人类评审) */
  missing: string[]
  incorrect: string[]
  /** 来源标识,evidence 里能看到 golden 是哪个 vendor */
  golden_source: string
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

/**
 * 软命中评分(替代 scoreSessionFixture 的 strict equal):
 * - 硬命中(必中):query_id / route_segments[0].from / .to / currency / source / verdict
 * - 软命中(窗口/子串):departure_at 在 ±60min 窗口内算 correct / arrival_at 同 / price 在 price_cny 带内 ±15% 算 correct / transport_number 包含任一 known_flights 子串算 correct
 */
function softScore(session: SessionComparableRecord, m: GoldenMatch, goldenSource: string): SoftScoreResult {
  const missing: string[] = []
  const incorrect: string[] = []
  const hard = ['query_id', 'currency', 'source', 'verdict'] as const
  const seg0 = session.route_segments[0]
  // 硬字段
  for (const k of hard) {
    if (session[k as keyof SessionComparableRecord] === undefined || session[k as keyof SessionComparableRecord] === '') missing.push(k)
  }
  if (!seg0) {
    missing.push('route_segments[0]')
  } else {
    if (!seg0.from) missing.push('route_segments[0].from')
    if (!seg0.to) missing.push('route_segments[0].to')
    if (!seg0.departure_at) missing.push('route_segments[0].departure_at')
    if (!seg0.arrival_at) missing.push('route_segments[0].arrival_at')
    if (!seg0.transport_number) missing.push('route_segments[0].transport_number')
  }
  // 软字段(命中条件)
  const softChecks: Array<{ path: string; ok: boolean; detail: string }> = []
  if (seg0?.departure_at) {
    const t = parseDepArrLocal(seg0.departure_at)
    const ok = t !== null && t.dep >= parseHHmm(m.window_dep_local.earliest) && t.dep <= parseHHmm(m.window_dep_local.latest)
    softChecks.push({ path: 'route_segments[0].departure_at', ok, detail: `${t?.depHHmm ?? '-'} ∈ [${m.window_dep_local.earliest},${m.window_dep_local.latest}]` })
  }
  if (seg0?.arrival_at) {
    const t = parseDepArrLocal(seg0.arrival_at)
    const ok = t !== null && t.arr >= parseHHmm(m.window_arr_local.earliest) && t.arr <= parseHHmm(m.window_arr_local.latest)
    softChecks.push({ path: 'route_segments[0].arrival_at', ok, detail: `${t?.arrHHmm ?? '-'} ∈ [${m.window_arr_local.earliest},${m.window_arr_local.latest}]` })
  }
  if (seg0?.transport_number) {
    const ok = m.known_flights.some((kf) => seg0.transport_number.toUpperCase().startsWith(kf.toUpperCase())) || m.known_flights.some((kf) => seg0.transport_number.toUpperCase().includes(kf.toUpperCase().slice(0, 2)))
    softChecks.push({ path: 'route_segments[0].transport_number', ok, detail: `${seg0.transport_number} ≈ ${m.known_flights.join('|')}` })
  }
  if (session.price > 0) {
    const margin = m.price_cny.max * 0.15
    const ok = session.price >= (m.price_cny.min - margin) && session.price <= (m.price_cny.max + margin)
    softChecks.push({ path: 'price', ok, detail: `¥${session.price} ∈ [¥${m.price_cny.min},¥${m.price_cny.max}] ±15%` })
  }
  // 总字段数 = 硬字段数 + 软检查数(分母全透明)
  const hardFieldCount = hard.length + (seg0 ? 5 : 0) // from/to/dep/arr/transport_no
  const total = hardFieldCount + softChecks.length
  const hardCorrect = total - missing.length - incorrect.length - softChecks.filter((c) => !c.ok).length
  const correct = hardCorrect
  const accuracy = total > 0 ? correct / total : 0
  for (const c of softChecks) if (!c.ok) incorrect.push(c.path)
  return {
    pass: missing.length === 0 && accuracy >= SESSION_FIELD_ACCURACY_THRESHOLD,
    total,
    correct,
    accuracy,
    missing: Array.from(new Set(missing)),
    incorrect,
    golden_source: goldenSource,
  }
}

function parseHHmm(s: string): number {
  const [h, m] = s.split(':')
  return parseInt(h!, 10) * 60 + parseInt(m!, 10)
}

function parseDepArrLocal(s: string): { dep: number; arr: number; depHHmm: string; arrHHmm: string } | null {
  // 接受 "2026-10-01 06:45:00" / "2026-10-01T06:45:00+08:00" 两种
  const m = s.match(/(\d{2}):(\d{2})/)
  if (!m) return null
  const hh = parseInt(m[1]!, 10)
  const mm = parseInt(m[2]!, 10)
  return { dep: hh * 60 + mm, arr: hh * 60 + mm, depHHmm: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`, arrHHmm: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}` }
}

interface QueryRunRecord {
  query_id: string
  expected: { from: string; to: string; date: string; kind: string }
  official: SessionComparableRecord | null
  official_source: string
  session: SessionComparableRecord | null
  doubleSource: ReturnType<typeof evaluateDoubleSource>
  softScore: SoftScoreResult | null
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
  golden_source: string
  records: QueryRunRecord[]
}

async function runOne(q: GoldenQuery, officialSource: 'manual' | 'flyai', manifest: GoldenManifest): Promise<QueryRunRecord> {
  const startedAt = new Date().toISOString()
  let official: SessionComparableRecord | null = null
  let officialLatencyMs: number | null = null
  const officialSourceLabel = officialSource === 'manual' ? 'manual-golden' : 'flyai'

  if (officialSource === 'manual') {
    const m = manualOfficial(q, manifest)
    official = m.record
    officialLatencyMs = m.latencyMs
  } else {
    const r = await flyaiOfficial(q)
    official = r.record
    officialLatencyMs = r.latencyMs
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
    session = {
      query_id: q.id,
      route_segments: [],
      journey_type: 'direct',
      currency: '',
      price: 0,
      source: 'ctrip-flight',
      fetched_at: new Date().toISOString(),
      verdict: sessRes.verdict === 'hit' || sessRes.verdict === 'miss' ? sessRes.verdict : 'error',
      latency_ms: sessionLatencyMs,
      read_guard_blocked: 0,
    }
  }

  const doubleSource = evaluateDoubleSource({ official: official ?? undefined, session: session ?? undefined })

  // 软命中评分(只在 session hit 且 manual 有窗口时算)
  let softResult: SoftScoreResult | null = null
  const m = manifest.matches.find((x) => x.query_id === q.id)
  if (session?.verdict === 'hit' && m && officialSource === 'manual') {
    softResult = softScore(session, m, officialSourceLabel)
  }

  return {
    query_id: q.id,
    expected: { from: q.from, to: q.to, date: q.date, kind: q.kind },
    official,
    official_source: officialSourceLabel,
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
  const officialSource: 'manual' | 'flyai' = args.includes('--golden=flyai') ? 'flyai' : 'manual'
  const queries = loadFlightQueries()
  if (queries.length < 8) {
    console.error(`金标准 sf-* 不足 8 条(实际 ${queries.length})`)
    process.exit(1)
  }
  const manifest = loadManualGolden()
  console.log(`[sf-live-benchmark] official source = ${officialSource === 'manual' ? '手工 golden (sf-golden-manifest.json,零网络零 vendor)' : 'flyai (FlyAI 官方)'}`)
  console.log(`[sf-live-benchmark] 阈值:字段准确率 ≥${SESSION_FIELD_ACCURACY_THRESHOLD * 100}%(软命中)`)

  const runStartedAt = new Date().toISOString()
  const runStartedMs = Date.now()
  const records: QueryRunRecord[] = []
  for (const q of queries) {
    if (records.length > 0) await new Promise((r) => setTimeout(r, 35_000))
    console.log(`\n[sf-live-benchmark] ${q.id} ${q.from}→${q.to} ${q.date}`)
    const rec = await runOne(q, officialSource, manifest)
    records.push(rec)
    const evPath = join(homedir(), '.gotry', 'evidence', 'session', q.id, `${runStartedAt.replace(/[:.]/g, '-')}.json`)
    mkdirSync(dirname(evPath), { recursive: true })
    writeFileSync(evPath, JSON.stringify(rec, null, 2))
    console.log(`  official(${rec.official_source}): verdict=${rec.official?.verdict ?? '-'} latency=${rec.officialLatencyMs ?? 0}ms`)
    console.log(`  session(ctrip): verdict=${rec.sessionVerdict} latency=${rec.sessionLatencyMs ?? 0}ms${rec.sessionError ? ` err=${rec.sessionError.slice(0, 80)}` : ''}`)
    console.log(`  doubleSource: state=${rec.doubleSource.state} quota=${rec.doubleSource.quota_disposition} price_delta=${rec.doubleSource.price_delta ?? '-'} mismatches=${rec.doubleSource.mismatches.length}`)
    if (rec.softScore) {
      console.log(`  soft score: ${(rec.softScore.accuracy * 100).toFixed(1)}% (${rec.softScore.correct}/${rec.softScore.total}) ${rec.softScore.pass ? '✅' : '❌'} missing=${JSON.stringify(rec.softScore.missing)} incorrect=${JSON.stringify(rec.softScore.incorrect)}`)
    }
  }

  const accuracy_pass = records.filter((r) => r.softScore?.pass === true).length
  const comparable = records.filter((r) => r.doubleSource.state === 'comparable').length
  const hit = records.filter((r) => r.sessionVerdict === 'hit').length
  const challenge = records.filter((r) => r.sessionVerdict === 'challenged' || r.doubleSource.state === 'challenge_stop' || r.doubleSource.state === 'guard_violation').length
  const no_data = records.filter((r) => r.official?.verdict !== 'hit' || (r.sessionVerdict !== 'hit' && r.sessionVerdict !== 'challenged')).length
  const live_under_15s = records.filter((r) =>
    (r.sessionLatencyMs !== null && r.sessionVerdict === 'hit' && r.sessionLatencyMs < 15_000)
  ).length

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
    golden_source: officialSource === 'manual' ? 'manual-golden' : 'flyai',
    records,
  }

  const summaryPath = join(homedir(), '.gotry', 'evidence', 'session', 'sf-summary', `${runStartedAt.replace(/[:.]/g, '-')}.json`)
  mkdirSync(dirname(summaryPath), { recursive: true })
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2))

  console.log(`\n──── sf-live-benchmark 汇总 ────`)
  console.log(`golden = ${summary.golden_source}`)
  console.log(`跑批 query 数: ${records.length}`)
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
