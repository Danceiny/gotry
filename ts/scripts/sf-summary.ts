/**
 * sf-summary 重建:扫描 ~/.gotry/evidence/session/sf-XX/ 取每条最新 evidence,
 * 合并成一份 unified RunSummary 落 sf-summary/<ts>.json。
 *
 * 不动 main runner;一次性 CLI,issue #21 验收汇总用。
 */
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { SESSION_FIELD_ACCURACY_THRESHOLD } from '../capabilities/session/benchmark.ts'

const evidenceRoot = join(homedir(), '.gotry', 'evidence', 'session')

interface SoftScore {
  pass: boolean
  total: number
  correct: number
  accuracy: number
  missing: string[]
  incorrect: string[]
  golden_source: string
}
interface Record {
  query_id: string
  expected: { from: string; to: string; date: string; kind: string }
  official: { source: string; verdict: string; latency_ms: number }
  official_source: string
  session: { verdict: string; price: number; flight_no: string; dep: string; arr: string }
  doubleSource: { state: string; price_delta?: number; mismatches: string[] }
  softScore: SoftScore | null
  sessionLatencyMs: number | null
  sessionError?: string
}

interface RunSummary {
  started_at: string
  total: number
  threshold: number
  accuracy_pass: number
  accuracy_eligible: number
  comparable: number
  hit: number
  challenge: number
  live_under_15s: number
  /** 来源说明(query_id 数组,不是路径数组) */
  sources: {
    manual_golden_query_ids: string[]
    flyai_query_ids: string[]
  }
  records: Array<{
    query_id: string
    expected: { from: string; to: string; date: string; kind: string }
    official_source: string
    session_verdict: string
    session_flight: { flight_no: string; dep: string; arr: string; price: number } | null
    soft_score: { accuracy: number; pass: boolean; missing: string[]; incorrect: string[] } | null
    session_latency_ms: number | null
    session_error?: string
  }>
}

function main() {
  const out: RunSummary = {
    started_at: new Date().toISOString(),
    total: 0,
    threshold: SESSION_FIELD_ACCURACY_THRESHOLD,
    accuracy_pass: 0,
    accuracy_eligible: 0,
    comparable: 0,
    hit: 0,
    challenge: 0,
    live_under_15s: 0,
    sources: { manual_golden_query_ids: [], flyai_query_ids: [] },
    records: [],
  }
  for (let i = 1; i <= 8; i += 1) {
    const q = `sf-${i.toString().padStart(2, '0')}`
    const qDir = join(evidenceRoot, q)
    try {
      const files = readdirSync(qDir).sort()
      if (files.length === 0) continue
      // 优先选 manual-golden 那次(本批 5/30 5:27:34 那批),没有再选 flyai 那次(5:15:52)
      const manualGoldens = files.filter((f) => {
        try {
          const r = JSON.parse(readFileSync(join(qDir, f), 'utf8')) as Record
          return r.official_source === 'manual-golden' || (r.official?.source === 'manual-golden')
        } catch { return false }
      })
      const fileName = manualGoldens.length > 0 ? manualGoldens[manualGoldens.length - 1]! : files[files.length - 1]!
      const r = JSON.parse(readFileSync(join(qDir, fileName), 'utf8')) as Record
      out.total += 1
      if (r.doubleSource?.state === 'comparable') out.comparable += 1
      if (r.session?.verdict === 'hit') out.hit += 1
      if (r.session?.verdict === 'challenged') out.challenge += 1
      if (r.softScore) {
        out.accuracy_eligible += 1
        if (r.softScore.pass) out.accuracy_pass += 1
      }
      if (r.sessionLatencyMs !== null && r.session?.verdict === 'hit' && r.sessionLatencyMs < 15_000) out.live_under_15s += 1
      const seg0 = (r.session?.verdict === 'hit' && (r.session as any).route_segments?.length) ? (r.session as any).route_segments[0] : null
      const sessionFlight = seg0 ? { flight_no: seg0.transport_number, dep: seg0.departure_at, arr: seg0.arrival_at, price: r.session.price } : null
      out.records.push({
        query_id: q,
        expected: r.expected,
        official_source: r.official_source,
        session_verdict: r.session?.verdict,
        session_flight: sessionFlight,
        soft_score: r.softScore ? { accuracy: r.softScore.accuracy, pass: r.softScore.pass, missing: r.softScore.missing, incorrect: r.softScore.incorrect } : null,
        session_latency_ms: r.sessionLatencyMs,
        session_error: r.sessionError,
      })
    } catch {
      // 静默跳过(qDir 不存在 / 文件空)
    }
  }
  // 区分 manual-golden / flyai 来源
  for (const r of out.records) {
    if (r.official_source === 'manual-golden') out.sources.manual_golden_query_ids.push(r.query_id)
    else out.sources.flyai_query_ids.push(r.query_id)
  }

  const summaryPath = join(evidenceRoot, 'sf-summary', `${out.started_at.replace(/[:.]/g, '-')}.json`)
  mkdirSync(join(evidenceRoot, 'sf-summary'), { recursive: true })
  writeFileSync(summaryPath, JSON.stringify(out, null, 2))

  console.log(`──── sf-summary (unified,8 query) ────`)
  console.log(`total: ${out.total}`)
  console.log(`verdict=hit: ${out.hit}/${out.total}`)
  console.log(`soft score ≥${out.threshold * 100}%: ${out.accuracy_pass}/${out.accuracy_eligible}`)
  console.log(`live <15s (hit): ${out.live_under_15s}/${out.hit}`)
  console.log(`manual golden query_ids: ${out.sources.manual_golden_query_ids.join(', ') || '(none)'}`)
  console.log(`flyai query_ids: ${out.sources.flyai_query_ids.join(', ') || '(none)'}`)
  console.log(`summary: ${summaryPath}`)
}

main()
