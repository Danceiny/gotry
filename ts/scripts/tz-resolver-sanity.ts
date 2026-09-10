// Quick sanity check for tz-resolver. Run with: TZ=UTC npx tsx scripts/tz-resolver-sanity.ts
import { resolveOffsetForLocalDate } from '../src/tz-resolver.ts'

const cases: Array<[string, string, string, number | string]> = [
  // Asia/Shanghai has no DST throughout the year
  ['Asia/Shanghai', '2026-07-18', '14:45', 480],
  ['Asia/Shanghai', '2026-01-01', '09:00', 480],
  ['Asia/Tokyo', '2026-07-04', '09:00', 540],
  ['Asia/Hong_Kong', '2026-07-18', '14:45', 480],
  ['Asia/Bangkok', '2026-08-09', '23:55', 420],
  ['Asia/Singapore', '2026-08-09', '23:55', 480],
  ['Asia/Dubai', '2026-07-18', '00:45', 240],
  // America/New_York DST: EST = -5, EDT = -4. 2026 spring-forward = 2026-03-08, fall-back = 2026-11-01
  ['America/New_York', '2026-03-07', '14:00', -300],  // day before spring forward -> EST
  ['America/New_York', '2026-03-09', '14:00', -240],  // day after spring forward -> EDT
  ['America/New_York', '2026-06-15', '09:00', -240],  // summer -> EDT
  ['America/New_York', '2026-12-15', '09:00', -300],  // winter -> EST
  ['America/Los_Angeles', '2026-06-15', '14:00', -420],
  ['UTC', '2026-07-18', '12:00', 0],
  ['Europe/London', '2026-06-15', '14:00', 60],
  ['Europe/London', '2026-01-15', '14:00', 0],
]
let ok = 0, fail = 0
for (const [zone, ymd, hhmm, expected] of cases) {
  const r = resolveOffsetForLocalDate(zone, ymd, hhmm)
  const pass = r.ok && r.offsetMin === expected
  if (pass) ok++; else { fail++; console.log('FAIL', zone, ymd, hhmm, 'expected', expected, 'got', r.ok ? r.offsetMin : r) }
}

const negatives: Array<[string, string, string, 'unknown_zone' | 'gap_nonexistent' | 'overlap_ambiguous']> = [
  ['Foo/Bar', '2026-07-18', '14:45', 'unknown_zone'],
  ['America/New_York', '2026-03-08', '02:30', 'gap_nonexistent'], // spring forward day
  ['America/New_York', '2026-11-01', '01:30', 'overlap_ambiguous'], // fall back day
]
for (const [zone, ymd, hhmm, expected] of negatives) {
  const r = resolveOffsetForLocalDate(zone, ymd, hhmm)
  const pass = !r.ok && r.kind === expected
  if (pass) ok++; else { fail++; console.log('FAIL', zone, ymd, hhmm, 'expected', expected, 'got', r.ok ? `ok(${r.offsetMin})` : r.kind) }
}
console.log(`\n${ok}/${ok + fail} sanity ok`)
if (fail > 0) process.exit(1)
