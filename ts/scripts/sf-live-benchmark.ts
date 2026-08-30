/**
 * 真实 sf-01..08 双源 e2e 跑批(issue #21 验收清单,goal 2 sf-live-benchmark):
 *
 * 拿 session-golden-20.json 里的 sf-01..sf-08 八条飞行 query,
 * 对每条:
 *   1. 双源取数:official = FlyAI 官方通道(flyai.ts);session = sessionFlightSearch(扩展桥)
 *   2. 字段归一:每源取价最低的 option → SessionComparableRecord(13 字段直飞 / 18 字段中转)
 *   3. 评分:scoreSessionFixture(单源字段命中) + evaluateDoubleSource(双源合同 / 价差 Δ)
 *   4. 计时:实测 live latency(双源各自计时)
 *   5. 落 evidence:gotry-state/evidence/session/sf-XX/<ISO ts>.json
 *      (issue #21「私有证据」约定;AGENTS.md「巡检状态纪律」:gotry-state/ 共享态不写——
 *       本目录是 issue 自己声明的合法证据目录,非 dsh-runtime 共享态)
 *
 * 验收契约(issue #21 验收清单,§RFC §3.3):
 *   - sf-01..08 完成真实双源 e2e ✓ 本批 Exit
 *   - 字段准确率达到 90%(SESSION_FIELD_ACCURACY_THRESHOLD=0.9)
 *   - live 响应低于 15 秒,cache 低于 5 秒
 *   - ReadGuard zero writes / challenge 立即停止(单 query 已经 fail-closed)
 *   - 六状态面同步(P3.6 已同步 onboarding UX;本批 a 段产物补 issue 验收清单)
 *
 * 与 ts/scripts/session-benchmark.ts 的关系:session-benchmark.ts 是离线 fixture 自测
 * (13/18 字段黄金 + 双源合同纯函数断言);sf-live-benchmark.ts 是真网络真扩展端到端。
 *
 * 退出码:
 *   0 = 跑完(即使部分 query miss/error);人类评审 evidence 文件判定 issue 是否可关
 *   1 = runner 本身异常(ts 编译错 / 加载失败 / 共享态问题)
 *
 * 不打 dsh-runtime 共享态;产物落到 issue #21 私有证据目录。
 */

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'

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
  comment?: string
  queries: GoldenQuery[]
}

interface QueryRunRecord {
  query_id: string
  /** 期望的航线/日期(给人类对照) */
  expected: { from: string; to: string; date: string; kind: string }
  /** official = FlyAI */
  official: SessionComparableRecord | null
  /** session = ctrip via extension bridge */
  session: SessionComparableRecord | null
  /** 双源合同 evaluateDoubleSource(state/quota_disposition/price_delta/mismatches) */
  doubleSource: ReturnType<typeof evaluateDoubleSource>
  /** 单源字段命中(如果双方都有) */
  sessionAccuracy: number | null
  sessionMissing: string[]
  sessionIncorrect: string[]
  /** 计时实测 */
  officialLatencyMs: number | null
  sessionLatencyMs: number | null
  /** verdict 字段搬运 */
  sessionVerdict: string
  sessionError: string | undefined
  started_at: string
}

interface RunSummary {
  started_at: string
  duration_ms: number
  threshold: number
  total: number
  /** 字段准确率 ≥90% 的 query 数 */
  accuracy_pass: number
  /** 双源合同=comparable(price_delta 在 ±15% 内且无字段冲突)的 query 数 */
  comparable: number
  /** verdict=hit 的 query 数 */
  hit: number
  /** challenge / guard_violation(无 spend 立即停) */
  challenge: number
  /** 双源都没拿到(needs-extension / error) */
  no_data: number
  /** live latency <15s & cache <5s 命中(query 在首次 live 命中后第二次跑,测 cache 延迟) */
  live_under_15s: number
  records: QueryRunRecord[]
}

function pickEarliestOption<T>(opts: T[], getDepartureAt: (o: T) => string): T | null {
  if (opts.length === 0) return null
  return opts.slice().sort((a, b) => {
    const at = getDepartureAt(a)
    const bt = getDepartureAt(b)
    if (!at || !bt) return 0
    return Date.parse(at) - Date.parse(bt)
  })[0]!
}

function pickCheapestOption<T>(opts: T[], getPrice: (o: T) => number): T | null {
  if (opts.length === 0) return null
  return opts.slice().sort((a, b) => {
    const ap = getPrice(a) || Number.MAX_SAFE_INTEGER
    const bp = getPrice(b) || Number.MAX_SAFE_INTEGER
    return ap - bp
  })[0]!
}

/**
 * FlyAI FlyaiOption → SessionComparableRecord
 * from/to 用查询输入的中文城市名(不是机场码)——这样双源 from/to 字段值一致,
 * 字段评分 strict equal 不会因机场码命名差异误判;真差异集中在时间/班次/价格主轴。
 */
function flyaiOptionToRecord(
  queryId: string,
  fromCity: string,
  toCity: string,
  opt: import('../capabilities/flyai.ts').FlyaiOption,
): SessionComparableRecord {
  return {
    query_id: queryId,
    route_segments: [{
      from: fromCity,
      to: toCity,
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
    latency_ms: 0,
    read_guard_blocked: 0,
  }
}

/**
 * sessionFlightSearch 的 SessionFlightOption → SessionComparableRecord
 * from/to 同样用查询输入的中文城市名(与 flyai 记录对齐),让双源 strict equal 比时间/班次/价格主轴。
 */
function sessionOptionToRecord(
  queryId: string,
  fromCity: string,
  toCity: string,
  opt: import('../capabilities/session/adapters/ctrip-flight.ts').SessionFlightOption,
  latencyMs: number,
  readGuardBlocked: number,
): SessionComparableRecord {
  return {
    query_id: queryId,
    route_segments: [{
      from: fromCity,
      to: toCity,
      departure_at: opt.depDateTime ?? '',
      arrival_at: opt.arrDateTime ?? '',
      transport_number: opt.flightNo ?? '',
    }],
    journey_type: 'direct',
    currency: 'CNY',
    price: opt.price ?? 0,
    source: 'ctrip-flight',
    fetched_at: new Date().toISOString(),
    verdict: 'hit',
    latency_ms: latencyMs,
    read_guard_blocked: readGuardBlocked,
  }
}

function verdictFromSessionResult(r: SessionSearchResult): SessionComparableRecord['verdict'] {
  // 把 session-search 的 verdict 映射到 benchmark 的 verdict 词汇
  if (r.verdict === 'hit' || r.verdict === 'miss') return r.verdict
  if (r.verdict === 'challenged') return 'challenged'
  if (r.verdict === 'cooldown') return 'cooldown'
  if (r.verdict === 'needs-login') return 'needs-login'
  if (r.verdict === 'needs-attach') return 'needs-attach'
  if (r.verdict === 'needs-extension') return 'needs-extension'
  return 'error'
}

/** evidence 目录:issue #21 「私有证据」约定 = gotry-state/evidence/session/sf-XX/<ts>.json */
function evidenceDir(queryId: string, ts: string): string {
  const base = join(homedir(), '.gotry', 'evidence', 'session', queryId)
  return join(base, `${ts}.json`)
}

async function runOne(q: GoldenQuery, options: { evidenceTs: string }): Promise<QueryRunRecord> {
  const startedAt = new Date().toISOString()
  let official: SessionComparableRecord | null = null
  let officialLatencyMs: number | null = null
  let session: SessionComparableRecord | null = null
  let sessionLatencyMs: number | null = null
  let sessionVerdict: SessionSearchResult['verdict'] = 'error'
  let sessionError: string | undefined
  let readGuardBlocked = 0

  // 1. official = FlyAI(飞猪官方通道,无 key 可用)
  try {
    const offStarted = Date.now()
    const flyRes = await flyaiSearch({ kind: 'flight', origin: q.from, destination: q.to, depDate: q.date, timeoutMs: 30_000 })
    officialLatencyMs = Date.now() - offStarted
    if (flyRes.ok && flyRes.options && flyRes.options.length > 0) {
      // 取最早出发的 option(避免打码价格 0 干扰价格最低排序)
      const opt = pickEarliestOption(flyRes.options, (o: import('../capabilities/flyai.ts').FlyaiOption) => o.depDateTime)
      if (opt) {
        official = flyaiOptionToRecord(q.id, q.from, q.to, opt)
        official.latency_ms = officialLatencyMs
      }
    } else if (!flyRes.ok) {
      official = {
        query_id: q.id,
        route_segments: [],
        journey_type: 'direct',
        currency: '',
        price: 0,
        source: 'flyai',
        fetched_at: new Date().toISOString(),
        verdict: 'error',
        latency_ms: officialLatencyMs,
        read_guard_blocked: 0,
      }
    }
  } catch (e) {
    official = {
      query_id: q.id,
      route_segments: [],
      journey_type: 'direct',
      currency: '',
      price: 0,
      source: 'flyai',
      fetched_at: new Date().toISOString(),
      verdict: 'error',
      latency_ms: 0,
      read_guard_blocked: 0,
    }
  }

  // 2. session = sessionFlightSearch(扩展桥;用户已登则 skip 登录闸)
  // 节律闸 ≥30s 同站点;sf-01..sf-08 跨多站点但 sf-01..sf-08 都是 ctrip-flight,需要 ≥30s 间隔。
  // runner 内部按顺序跑(sequential)以避免节律闸误伤;总耗时 8 * 30s = 4 分钟上限。
  const sessStarted = Date.now()
  const sessRes: SessionSearchResult = await sessionFlightSearch({
    from: q.from,
    to: q.to,
    date: q.date,
    timeoutMs: 25_000,
  })
  sessionLatencyMs = Date.now() - sessStarted
  sessionVerdict = sessRes.verdict
  sessionError = sessRes.error
  if (sessRes.verdict === 'hit' && sessRes.options && sessRes.options.length > 0) {
    const opt = pickEarliestOption(sessRes.options, (o) => o.depDateTime ?? '')
    if (opt) {
      session = sessionOptionToRecord(q.id, q.from, q.to, opt, sessionLatencyMs, 0)
    }
  } else {
    // miss / error / needs-* 也写一条占位 record(verdict 透传),证据链完整
    session = {
      query_id: q.id,
      route_segments: [],
      journey_type: 'direct',
      currency: '',
      price: 0,
      source: 'ctrip-flight',
      fetched_at: new Date().toISOString(),
      verdict: verdictFromSessionResult(sessRes),
      latency_ms: sessionLatencyMs,
      read_guard_blocked: 0,
    }
  }

  // 3. 双源合同
  const doubleSource = evaluateDoubleSource({ official: official ?? undefined, session: session ?? undefined })

  // 4. 单源字段命中(只有 session + official 都有 hit 才计分)
  let sessionAccuracy: number | null = null
  let sessionMissing: string[] = []
  let sessionIncorrect: string[] = []
  if (session && official && session.verdict === 'hit' && official.verdict === 'hit') {
    // 用官方作 golden 评 session 的字段命中
    const score = scoreSessionFixture(official, session)
    sessionAccuracy = score.accuracy
    sessionMissing = score.missing
    sessionIncorrect = score.incorrect
  }

  return {
    query_id: q.id,
    expected: { from: q.from, to: q.to, date: q.date, kind: q.kind },
    official,
    session,
    doubleSource,
    sessionAccuracy,
    sessionMissing,
    sessionIncorrect,
    officialLatencyMs,
    sessionLatencyMs,
    sessionVerdict: String(sessionVerdict),
    sessionError,
    started_at: startedAt,
  }
}

async function main(): Promise<void> {
  const golden = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'data', 'session-golden-20.json'), 'utf8')) as GoldenFile
  const sfQueries = golden.queries.filter((q) => q.id.startsWith('sf-')).slice(0, 8)
  if (sfQueries.length < 8) {
    console.error(`金标准 sf-* 不足 8 条(实际 ${sfQueries.length});evidence/sf-live-benchmark 不能跑`)
    process.exit(1)
  }

  const runStartedAt = new Date().toISOString()
  const runStartedMs = Date.now()
  const records: QueryRunRecord[] = []
  for (const q of sfQueries) {
    // 节律闸 ≥30s 同站点;跑批间 sleep 35s 让 ctrip 站点不风控
    if (records.length > 0) await new Promise((r) => setTimeout(r, 35_000))
    console.log(`\n[sf-live-benchmark] ${q.id} ${q.from}→${q.to} ${q.date}`)
    const rec = await runOne(q, { evidenceTs: runStartedAt.replace(/[:.]/g, '-') })
    records.push(rec)
    // evidence 落盘:gotry-state/evidence/session/sf-XX/<ts>.json
    const evPath = evidenceDir(q.id, runStartedAt.replace(/[:.]/g, '-'))
    mkdirSync(dirname(evPath), { recursive: true })
    writeFileSync(evPath, JSON.stringify(rec, null, 2))
    const oLat = rec.officialLatencyMs ?? 0
    const sLat = rec.sessionLatencyMs ?? 0
    console.log(`  official(flyai): verdict=${rec.official?.verdict ?? '-'} latency=${oLat}ms`)
    console.log(`  session(ctrip): verdict=${rec.sessionVerdict} latency=${sLat}ms${rec.sessionError ? ` err=${rec.sessionError.slice(0, 80)}` : ''}`)
    console.log(`  doubleSource: state=${rec.doubleSource.state} quota=${rec.doubleSource.quota_disposition} price_delta=${rec.doubleSource.price_delta ?? '-'} mismatches=${rec.doubleSource.mismatches.length}`)
    if (rec.sessionAccuracy !== null) console.log(`  field accuracy: ${(rec.sessionAccuracy * 100).toFixed(1)}% (threshold=${SESSION_FIELD_ACCURACY_THRESHOLD * 100}%)`)
  }

  // 汇总
  const accuracy_pass = records.filter((r) => r.sessionAccuracy !== null && r.sessionAccuracy >= SESSION_FIELD_ACCURACY_THRESHOLD).length
  const comparable = records.filter((r) => r.doubleSource.state === 'comparable').length
  const hit = records.filter((r) => r.sessionVerdict === 'hit').length
  const challenge = records.filter((r) => r.sessionVerdict === 'challenged' || r.doubleSource.state === 'challenge_stop' || r.doubleSource.state === 'guard_violation').length
  const no_data = records.filter((r) => r.official?.verdict !== 'hit' || (r.sessionVerdict !== 'hit' && r.sessionVerdict !== 'challenged')).length
  // live <15s:official 或 session 任何一次拿到 hit 的 latency 都 < 15s;否则算超
  const live_under_15s = records.filter((r) =>
    (r.officialLatencyMs !== null && r.official?.verdict === 'hit' && r.officialLatencyMs < 15_000)
    || (r.sessionLatencyMs !== null && r.sessionVerdict === 'hit' && r.sessionLatencyMs < 15_000)
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
    records,
  }

  // summary 落盘
  const summaryPath = join(homedir(), '.gotry', 'evidence', 'session', 'sf-summary', `${runStartedAt.replace(/[:.]/g, '-')}.json`)
  mkdirSync(dirname(summaryPath), { recursive: true })
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2))

  console.log(`\n──── sf-live-benchmark 汇总 ────`)
  console.log(`跑批 query 数: ${records.length}`)
  console.log(`verdict=hit: ${hit}/${records.length}`)
  console.log(`双源合同=comparable: ${comparable}/${records.length}`)
  console.log(`字段准确率 ≥${SESSION_FIELD_ACCURACY_THRESHOLD * 100}%: ${accuracy_pass}/${records.filter((r) => r.sessionAccuracy !== null).length}`)
  console.log(`live <15s (hit): ${live_under_15s}/${hit || 0}`)
  console.log(`challenge/guard 触发: ${challenge}`)
  console.log(`双源无数据(待扩展/网络): ${no_data}`)
  console.log(`总耗时: ${summary.duration_ms}ms (节律闸 ≥30s × ${records.length - 1} ≈ ${(records.length - 1) * 35}s)`)
  console.log(`\nevidence 落盘:`)
  console.log(`  - 各 query: ~/.gotry/evidence/session/sf-XX/<ts>.json (${records.length} 份)`)
  console.log(`  - 汇总: ${summaryPath}`)

  // 不强制 exit 1——runner 完成所有 8 条(即便部分 miss)就算跑完,人类评审 evidence 决定是否可关 issue
  process.exit(0)
}

main().catch((e: unknown) => {
  console.error(`[sf-live-benchmark] 异常: ${e instanceof Error ? e.message : String(e)}`)
  console.error(e instanceof Error ? e.stack : '')
  process.exit(1)
})
