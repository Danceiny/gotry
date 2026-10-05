/**
 * Offline tests for the Anything-path measurement probe (issue #276 / #345 evidence probe).
 *
 * Run: cd ts && npx tsx scripts/anything-path-measure-tests.ts
 *
 * Fully offline: the real hbcli runner is never used; a scripted fake runner stands in. The opt-in
 * claim is executed, not asserted: with the environment flag missing, the fake runner must be
 * called exactly zero times.
 */

import assert from 'node:assert/strict'

import {
  CONCURRENCY,
  OPT_IN_ENV,
  fieldPresence,
  latencyStats,
  measure,
  measureIfOptedIn,
  percentile,
  scrub,
  type Aggregate,
  type CallResult,
  type Candidate,
  type Runner,
} from './anything-path-measure.ts'

const tests: Array<{ name: string; run: () => void | Promise<void> }> = []
const test = (name: string, run: () => void | Promise<void>) => tests.push({ name, run })

const hotel = (extra: Record<string, unknown> = {}): Candidate => ({ type: 'hotel', hotel: { name: 'H', star: 4, address: 'a', ...extra } })
const city = (): Candidate => ({ type: 'city', region: { name: 'C', countryCode: 'CN', extra: '' } })

/** A scripted runner: results come from a queue per call; also tracks max in-flight calls. */
function scripted(script: (args: string[], index: number) => CallResult) {
  let calls = 0
  let inFlight = 0
  let maxInFlight = 0
  const runner: Runner = async (args) => {
    const index = calls++
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise((resolve) => setImmediate(resolve))
    inFlight--
    return script(args, index)
  }
  return { runner, stats: () => ({ calls, maxInFlight }) }
}

test('opt-in gate: without the env flag nothing is spawned and nothing is measured', async () => {
  const fake = scripted(() => ({ ok: true, ms: 1, candidates: [] }))
  const result = await measureIfOptedIn({}, fake.runner)
  assert.equal(result.state, 'waiting_external_evidence')
  assert.equal(fake.stats().calls, 0, 'runner must not be called without opt-in')
  const wrong = await measureIfOptedIn({ [OPT_IN_ENV]: 'true' }, fake.runner)
  assert.equal(wrong.state, 'waiting_external_evidence', 'only the exact value 1 opts in')
  assert.equal(fake.stats().calls, 0)
})

test('opt-in gate: GOTRY_UAT_READONLY=1 runs the whole measurement', async () => {
  const fake = scripted(() => ({ ok: true, ms: 5, candidates: [city()] }))
  const result = await measureIfOptedIn({ [OPT_IN_ENV]: '1' }, fake.runner)
  assert.equal(result.state, 'measured')
  assert.ok(fake.stats().calls > 0)
})

test('percentile: nearest-rank, empty sample is null, single sample is itself', () => {
  assert.equal(percentile([], 50), null)
  assert.equal(percentile([7], 95), 7)
  const sample = Array.from({ length: 20 }, (_, i) => (i + 1) * 10)
  assert.equal(percentile(sample, 50), 100)
  assert.equal(percentile(sample, 95), 190)
  assert.equal(percentile([30, 10, 20], 50), 20, 'input order must not matter')
})

test('latencyStats counts failures by reason and keeps their timings in the sample', () => {
  const stats = latencyStats([
    { ok: true, ms: 100, candidates: [] },
    { ok: false, ms: 900, reason: 'exit_1', detail: '' },
    { ok: false, ms: 50, reason: 'exit_1', detail: '' },
    { ok: false, ms: 60_000, reason: 'timeout', detail: '' },
  ])
  assert.equal(stats.calls, 4)
  assert.equal(stats.errors, 3)
  assert.deepEqual(stats.error_reasons, { exit_1: 2, timeout: 1 })
  assert.equal(stats.max_ms, 60_000)
})

test('fieldPresence: empty strings, empty arrays and empty objects do not count as present', () => {
  const presence = fieldPresence([
    { name: 'a', rating: 4.5, photos: [], hours: {}, note: '' },
    { name: 'b', rating: null },
    undefined,
  ])
  assert.equal(presence.n, 2, 'undefined entries are not objects')
  assert.deepEqual(presence.fields, { hours: '0/2', name: '2/2', note: '0/2', photos: '0/2', rating: '1/2' })
})

test('scrub: credential-looking material is redacted and the text is bounded', () => {
  const scrubbed = scrub('401 Unauthorized: Bearer abc.def.ghi ticket=ST:12345 token: zzz api_key=k123 password hunter2')
  assert.ok(!/abc\.def|12345|zzz|k123|hunter2/.test(scrubbed), `secret material survived: ${scrubbed}`)
  assert.ok(scrubbed.length <= 160)
  assert.ok(scrub('x'.repeat(1000)).length <= 160)
})

test('measure: aggregates a scripted run (types, place emptiness, presence, failures) deterministically', async () => {
  const keywords = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
  let n = 0
  const fake = scripted((args) => {
    n++
    const placeOnly = args.includes('place')
    if (placeOnly) return { ok: true, ms: 10, candidates: [] }
    if (n === 2) return { ok: false, ms: 40, reason: 'exit_1', detail: 'boom' }
    return { ok: true, ms: 20 + n, candidates: [city(), hotel(), hotel({ rating: 4.2 })] }
  })
  const fixedClock = () => new Date('2026-10-04T00:00:00.000Z')
  const result: Aggregate = await measure(fake.runner, keywords, fixedClock)
  assert.equal(result.measured_at, '2026-10-04T00:00:00.000Z')
  assert.equal(result.sequential_mixed.calls, 7)
  assert.equal(result.sequential_mixed.errors, 1)
  assert.deepEqual(result.sequential_mixed.error_reasons, { exit_1: 1 })
  assert.equal(result.sequential_place_only.errors, 0)
  assert.equal(result.place_only_total_candidates, 0)
  assert.equal(result.keywords_with_zero_place_results, '7/7')
  assert.equal(result.place_object_field_presence.n, 0)
  assert.deepEqual(Object.keys(result.mixed_candidates_by_type).sort(), ['city', 'hotel'])
  assert.equal(result.mixed_candidates_by_type['city'], 6, 'one of seven mixed calls failed')
  assert.equal(result.hotel_object_field_presence.fields['rating'], '6/12', 'half of the 12 hotel candidates carry a rating')
  assert.equal(result.concurrent_mixed.concurrency, CONCURRENCY)
  assert.equal(result.concurrent_mixed.calls, 7)
})

test('measure: the burst phase never exceeds the declared concurrency', async () => {
  const keywords = Array.from({ length: 23 }, (_, i) => `k${i}`)
  const fake = scripted(() => ({ ok: true, ms: 1, candidates: [] }))
  await measure(fake.runner, keywords)
  assert.ok(fake.stats().maxInFlight <= CONCURRENCY, `in-flight ${fake.stats().maxInFlight} exceeded ${CONCURRENCY}`)
  assert.ok(fake.stats().maxInFlight > 1, 'burst phase must actually run concurrently')
  assert.equal(fake.stats().calls, keywords.length * 3, 'mixed + place-only + burst')
})

let failed = 0
for (const { name, run } of tests) {
  try {
    await run()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed++
    console.error(`  FAIL ${name}`)
    console.error(error)
  }
}

if (failed > 0) {
  console.error(`${failed} anything-path-measure test(s) failed`)
  process.exit(1)
}
console.log(`anything-path-measure tests: ${tests.length} passed, 0 failed (offline: real hbcli runner never used)`)
