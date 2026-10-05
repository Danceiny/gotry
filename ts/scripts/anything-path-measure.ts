#!/usr/bin/env tsx
/**
 * Read-only measurement of the external Anything path
 * (hbcli -> hotel-be /api/search/anything), the evidence probe for two trigger trackers:
 *   #276  does the external path show a material latency/reliability bottleneck at scale?
 *   #345  what fields does Anything actually return for place-like queries (rating/photos/hours)?
 *
 * Discipline:
 *   - Opt-in only: without GOTRY_UAT_READONLY=1 it exits 0 with `waiting_external_evidence` and spawns nothing
 *     (CI-safe; same no-spend discipline as nightly-evidence.ts).
 *   - Read-only `search anything` calls against the environment hbcli is already authenticated for
 *     (flags fixed to `--json --env=uat`). It never reads, prints or persists credentials.
 *   - Prints aggregates only (latency percentiles, error counts, candidate-type counts, field-presence
 *     ratios). Raw responses are not persisted; failure details are scrubbed and truncated.
 *   - This MEASURES the real path. It does not satisfy either tracker's trigger: both need real M4
 *     usage evidence (and, for #345, founder approval of per-call billing).
 */

import { execFile } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const DEFAULT_KEYWORDS = [
  'Dali', '大理', '洱海', 'Erhai', 'Lijiang', '丽江', 'Phuket', '普吉', 'Rawai', 'Krabi', '甲米',
  'Shenzhen', '深圳', 'Hong Kong', '香港', 'Dubai', '迪拜', 'Kunming', '昆明', 'Bangkok', '曼谷',
  'Tokyo', 'Paris', 'Hilton', 'Marriott', 'Old Town', 'Airport', 'Beach',
] as const

export const OPT_IN_ENV = 'GOTRY_UAT_READONLY'
export const CALL_TIMEOUT_MS = 60_000
export const CONCURRENCY = 5

type JsonObject = Record<string, unknown>
export interface Candidate { type?: string; hotel?: JsonObject; region?: JsonObject; place?: JsonObject }
export type CallResult =
  | { ok: true; ms: number; candidates: Candidate[] }
  | { ok: false; ms: number; reason: string; detail: string }
export type Runner = (args: string[]) => Promise<CallResult>

/** Redact credential-looking material and bound the length of anything we keep from a failed call. */
export function scrub(text: string): string {
  return text
    .replace(/(bearer|ticket|token|authorization|secret|api[-_ ]?key|password)\s*[:=]?\s*[^\s"',}]+/gi, '$1=<redacted>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
}

/** Nearest-rank percentile; null for an empty sample. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? null
}

export interface LatencyStats {
  calls: number
  errors: number
  error_reasons: Record<string, number>
  p50_ms: number | null
  p95_ms: number | null
  max_ms: number | null
}

export function latencyStats(results: CallResult[]): LatencyStats {
  const reasons: Record<string, number> = {}
  for (const r of results) if (!r.ok) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1
  const times = results.map((r) => r.ms)
  return {
    calls: results.length,
    errors: results.filter((r) => !r.ok).length,
    error_reasons: reasons,
    p50_ms: percentile(times, 50),
    p95_ms: percentile(times, 95),
    max_ms: times.length ? Math.max(...times) : null,
  }
}

function isPresent(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value as JsonObject).length > 0
  return true
}

/** For each key seen on any object: how many of the n objects carry a non-empty value (`"52/55"`). */
export function fieldPresence(objects: Array<JsonObject | undefined>): { n: number; fields: Record<string, string> } {
  const present: Record<string, number> = {}
  const real = objects.filter((o): o is JsonObject => o !== undefined && o !== null)
  for (const o of real) for (const [k, v] of Object.entries(o)) present[k] = (present[k] ?? 0) + (isPresent(v) ? 1 : 0)
  const fields: Record<string, string> = {}
  for (const k of Object.keys(present).sort()) fields[k] = `${present[k]}/${real.length}`
  return { n: real.length, fields }
}

export interface Aggregate {
  state: 'measured'
  measured_at: string
  hbcli_json_flags: string
  sequential_mixed: LatencyStats
  sequential_place_only: LatencyStats
  concurrent_mixed: LatencyStats & { concurrency: number }
  mixed_candidates_by_type: Record<string, number>
  place_only_total_candidates: number
  keywords_with_zero_place_results: string
  hotel_object_field_presence: ReturnType<typeof fieldPresence>
  city_region_field_presence: ReturnType<typeof fieldPresence>
  place_object_field_presence: ReturnType<typeof fieldPresence>
}

export interface WaitingResult { state: 'waiting_external_evidence'; reason: string }

/** Real runner: one hbcli call, classified, bounded, scrubbed. Never throws. */
export const hbcliRunner: Runner = (args) => new Promise((resolve) => {
  const started = performance.now()
  execFile('hbcli', ['--json', '--env=uat', 'search', 'anything', ...args], { timeout: CALL_TIMEOUT_MS, maxBuffer: 8 << 20 }, (error, stdout, stderr) => {
    const ms = Math.round(performance.now() - started)
    if (error) {
      const killed = (error as NodeJS.ErrnoException & { killed?: boolean }).killed === true
      const code = (error as NodeJS.ErrnoException).code
      const reason = killed ? 'timeout' : typeof code === 'number' ? `exit_${code}` : 'spawn_error'
      resolve({ ok: false, ms, reason, detail: scrub(String(stderr || stdout || error.message)) })
      return
    }
    try {
      const parsed = JSON.parse(String(stdout)) as { candidates?: Candidate[] }
      resolve({ ok: true, ms, candidates: Array.isArray(parsed.candidates) ? parsed.candidates : [] })
    } catch {
      resolve({ ok: false, ms, reason: 'non_json', detail: scrub(String(stdout)) })
    }
  })
})

async function sequential(run: Runner, keywords: readonly string[], extra: string[]): Promise<CallResult[]> {
  const out: CallResult[] = []
  for (const kw of keywords) out.push(await run([kw, ...extra]))
  return out
}

async function concurrent(run: Runner, keywords: readonly string[], width: number): Promise<CallResult[]> {
  const out: CallResult[] = []
  for (let i = 0; i < keywords.length; i += width) {
    out.push(...await Promise.all(keywords.slice(i, i + width).map((kw) => run([kw]))))
  }
  return out
}

/** Pure given a runner and a clock: the whole measurement, no environment access. */
export async function measure(run: Runner, keywords: readonly string[] = DEFAULT_KEYWORDS, now: () => Date = () => new Date()): Promise<Aggregate> {
  const mixed = await sequential(run, keywords, [])
  const placeOnly = await sequential(run, keywords, ['--content-type', 'place'])
  const burst = await concurrent(run, keywords, CONCURRENCY)

  const mixedCandidates = mixed.flatMap((r) => (r.ok ? r.candidates : []))
  const placeCandidates = placeOnly.flatMap((r) => (r.ok ? r.candidates : []))
  const byType: Record<string, number> = {}
  for (const c of mixedCandidates) byType[c.type ?? 'unknown'] = (byType[c.type ?? 'unknown'] ?? 0) + 1
  const zeroPlace = placeOnly.filter((r) => r.ok && r.candidates.length === 0).length

  return {
    state: 'measured',
    measured_at: now().toISOString(),
    hbcli_json_flags: '--json --env=uat',
    sequential_mixed: latencyStats(mixed),
    sequential_place_only: latencyStats(placeOnly),
    concurrent_mixed: { ...latencyStats(burst), concurrency: CONCURRENCY },
    mixed_candidates_by_type: byType,
    place_only_total_candidates: placeCandidates.length,
    keywords_with_zero_place_results: `${zeroPlace}/${keywords.length}`,
    hotel_object_field_presence: fieldPresence(mixedCandidates.filter((c) => c.type === 'hotel').map((c) => c.hotel)),
    city_region_field_presence: fieldPresence(mixedCandidates.filter((c) => c.type === 'city').map((c) => c.region)),
    place_object_field_presence: fieldPresence(placeCandidates.map((c) => c.place)),
  }
}

/** The opt-in gate: nothing is spawned unless the environment explicitly asks for it. */
export async function measureIfOptedIn(env: NodeJS.ProcessEnv, run: Runner): Promise<Aggregate | WaitingResult> {
  if (env[OPT_IN_ENV] !== '1') {
    return { state: 'waiting_external_evidence', reason: `${OPT_IN_ENV}=1 not set; no hbcli process was spawned, nothing was measured` }
  }
  return measure(run)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  measureIfOptedIn(process.env, hbcliRunner).then((result) => {
    console.log(JSON.stringify(result, null, 2))
  })
}
