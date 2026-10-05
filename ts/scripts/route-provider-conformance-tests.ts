/**
 * D-39 live-route provider CONFORMANCE harness tests (issue #429 contract slice,
 * SIMULATED-TRIGGER DRILL — fully offline, zero network, zero real routing provider).
 *
 * ⚠ Evidence label: `simulated_trigger_drill` / `fixture_contract`. The trigger is
 * SIMULATED by declaring a NAMED use case and driving a MOCK adapter through eight
 * fault modes. That is not #429's real trigger: no provider is named, licensed,
 * measured for coverage/freshness or contacted, so no D-39 path is admitted, every
 * path stays default-OFF, and #341's accepted narrow scope is untouched.
 *
 * Sections:
 *  A. Default-off: trigger frozen false, registry frozen empty, `consultRouteProvider`
 *     refuses before touching the adapter (fetch-spy zero-call proof).
 *  B. Mock adapter: all nine conformance clauses probed → admissible.
 *  C. The harness is itself falsifiable: per clause, a non-conformant outcome flips
 *     that clause to fail; an unprobed clause blocks admission.
 *  D. Fault-detail sanitization: a challenge page body with a cookie/token is
 *     scrubbed, and the leak check catches markup / credentials / URLs / length.
 *  E. Static fallback preservation + its own falsification.
 *  F. Layering: the conformance module imports nothing (zero IO / zero kernel
 *     coupling) and has zero product callers.
 *  G. The EXISTING ground-transfer logic (ts/capabilities/ground-transfer.ts, the
 *     accepted #341/#364 narrow path) driven through the applicable clauses. All
 *     three gaps the drill found (GAP-429-1/2/3) are now FIXED, so the former
 *     characterization assertions are FLIPPED: a contradicting provider claim —
 *     declared mode, or resolved origin/destination — fails closed to the static
 *     fallback instead of binding its minutes. Details and minimal repros live in
 *     docs/evaluation/trigger-drill-report-contracts.md.
 *
 * Run (from ts/): npx tsx scripts/route-provider-conformance-tests.ts
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ADMITTED_LIVE_ROUTE_PROVIDERS,
  D39_LIVE_ROUTE_TRIGGER_FIRED,
  FAULT_DETAIL_MAX_CHARS,
  ROUTE_CONFORMANCE_CLAUSES,
  ROUTE_EVIDENCE_CLASSES,
  ROUTE_MODES,
  ROUTE_PROVIDER_CONFORMANCE_SCHEMA,
  ROUTE_PROVIDER_FAULT_MODES,
  admitRouteFact,
  consultRouteProvider,
  faultDetailLeak,
  runRouteProviderConformance,
  sanitizeFaultDetail,
  staticFallbackViolation,
  type ConformanceProbe,
  type RouteErrorCode,
  type RouteProviderAdapter,
  type RouteProviderDescriptor,
  type RouteProviderOutcome,
  type RouteProviderResponse,
  type RouteRequest,
  type RouteResult,
  type RouteUseCase,
  type StaticTransferFallback,
} from '../capabilities/route-provider-conformance.ts'
import {
  GROUND_TRANSFER_STATIC_PRICE_EVIDENCE,
  createGroundTransferResolver,
  exposeGroundTransferEvidence,
  resolveGroundTransferPayload,
  type GroundTransferCandidateLike,
  type GroundTransferProvider,
} from '../capabilities/ground-transfer.ts'

let passed = 0
function check(cond: boolean, msg: string): void {
  if (cond) {
    passed++
    console.log(`  ok - ${msg}`)
  } else {
    console.error(`  FAIL - ${msg}`)
    process.exitCode = 1
  }
}

function expectRefusal<T>(result: RouteResult<T>, code: RouteErrorCode, needle: string, msg: string): void {
  if (result.ok) {
    check(false, `${msg} (expected refusal ${code}, got ok)`)
    return
  }
  check(
    result.code === code && result.detail.includes(needle),
    `${msg} (refused ${result.code}${result.code === code ? '' : ` ≠ ${code}`}, evidence contains "${needle}": ${result.detail.includes(needle)})`,
  )
}

const NOW = '2026-10-04T12:00:00.000Z'
const OBSERVED = '2026-10-04T11:59:00.000Z' // 60s old
const O = '100.1,13.1'
const D = '100.5,13.5'

/**
 * The SIMULATED named use case. It is deliberately the already-accepted #341 shape
 * (destination driving estimate, no fare authority) so the drill adds no new path.
 */
const USE_CASE: RouteUseCase = {
  id: 'drill:destination-driving-transfer',
  mode: 'driving',
  evidence_class: 'route_estimate',
  freshness_max_age_s: 15 * 60,
  access_boundary: 'read_only_public',
  fare_authority: 'none',
}

/** TEST-ONLY descriptor: no real provider is named, licensed or contacted. */
const MOCK_DESCRIPTOR: RouteProviderDescriptor = {
  id: 'mock-offline-route-provider',
  legal_basis: 'test-only offline mock (issue #429 drill; no live provider admitted)',
  access_boundary: 'read_only_public',
  source_sha: '0000000000000000000000000000000000000000',
}

const REQUEST_OUT: RouteRequest = { direction: 'outbound', origin: O, destination: D, mode: 'driving' }
const REQUEST_RET: RouteRequest = { direction: 'return', origin: D, destination: O, mode: 'driving' }

function goodResponse(overrides: Partial<RouteProviderResponse> = {}): RouteProviderResponse {
  return {
    provider_id: MOCK_DESCRIPTOR.id,
    mode: 'driving',
    evidence_class: 'route_estimate',
    echoed_origin: O,
    echoed_destination: D,
    distance_m: 30_000,
    duration_s: 2_400,
    observed_at: OBSERVED,
    ...overrides,
  }
}
function okOutcome(overrides: Partial<RouteProviderResponse> = {}): RouteProviderOutcome {
  return { ok: true, response: goodResponse(overrides) }
}

// ---------------------------------------------------------------------------
// A. Default-off
// ---------------------------------------------------------------------------
console.log('A. default-off: trigger frozen false, registry frozen empty, zero providers contacted')
check(D39_LIVE_ROUTE_TRIGGER_FIRED === false, 'D-39 wider-path trigger gate frozen false')
check(ADMITTED_LIVE_ROUTE_PROVIDERS.length === 0, 'the admitted live-route provider registry is frozen empty')
check(ROUTE_PROVIDER_CONFORMANCE_SCHEMA === 'gotry_route_provider_conformance.v1', 'the conformance schema id is versioned')
check(ROUTE_PROVIDER_FAULT_MODES.length === 8 && ROUTE_CONFORMANCE_CLAUSES.length === 9, 'eight fault modes and nine conformance clauses are declared as closed sets')
check(ROUTE_MODES.includes('transit') && ROUTE_MODES.includes('rail') && ROUTE_EVIDENCE_CLASSES.includes('live_traffic'), 'the closed sets name the D-39 remainder paths explicitly (transit / rail / live traffic)')

let spyCalls = 0
const spyAdapter: RouteProviderAdapter = {
  descriptor: MOCK_DESCRIPTOR,
  fetchRoute: async () => {
    spyCalls++
    return okOutcome()
  },
}
const deferred = await consultRouteProvider(spyAdapter, USE_CASE, REQUEST_OUT, { now: NOW })
expectRefusal(deferred, 'trigger_deferred', 'zero routing providers contacted', 'before the trigger, the adapter is refused structurally')
check(spyCalls === 0, 'fetch-spy zero-call proof: no routing provider is contacted before the trigger fires')
check(!deferred.ok && deferred.detail.includes('static fallback stands'), 'the pre-trigger refusal states that the static fallback stands')
const notAdmitted = await consultRouteProvider(spyAdapter, USE_CASE, REQUEST_OUT, { triggerFired: true, now: NOW })
expectRefusal(notAdmitted, 'provider_not_admitted', 'per-path founder decision', 'trigger on + empty registry: the provider is still not admitted')
check(spyCalls === 0, 'registry refusal also precedes any adapter call')
const viaSpy = await consultRouteProvider(spyAdapter, USE_CASE, REQUEST_OUT, { triggerFired: true, registry: [MOCK_DESCRIPTOR], now: NOW })
check(viaSpy.ok && spyCalls === 1, 'the seam is usable once a provider is explicitly admitted (drill only)')
check(viaSpy.ok && viaSpy.value.provider_id === MOCK_DESCRIPTOR.id && viaSpy.value.source_sha === MOCK_DESCRIPTOR.source_sha, 'an admitted fact names its source identity and reviewed source SHA')
check(viaSpy.ok && viaSpy.value.access_boundary === 'read_only_public' && viaSpy.value.fare === null, 'an admitted read-only fact carries no fare (read-only routing authorizes no price claim)')

// ---------------------------------------------------------------------------
// B. Mock adapter: the full conformance report
// ---------------------------------------------------------------------------
console.log('B. mock adapter driven through all eight fault modes → nine clauses')

const CHALLENGE_BODY = 'HTTP 403 <html><body>Please complete the CAPTCHA. token=abc123 cookie=sid=XYZ see https://provider.example/challenge</body></html>'

const FULL_PROBES: readonly ConformanceProbe[] = [
  { clause: 'direction_binding', label: 'happy path outbound', request: REQUEST_OUT, outcome: okOutcome(), expect: null },
  { clause: 'direction_binding', label: 'return request answered with the outbound pair', request: REQUEST_RET, outcome: okOutcome(), expect: 'direction_mismatch' },
  { clause: 'direction_binding', label: 'provider routed a different O/D', request: REQUEST_OUT, outcome: okOutcome({ echoed_origin: '0,0', echoed_destination: '1,1' }), expect: 'direction_mismatch' },
  { clause: 'direction_binding', label: 'declared mismatched_direction fault', request: REQUEST_OUT, outcome: { ok: false, fault: 'mismatched_direction', detail: 'provider resolved a different pair' }, expect: 'direction_mismatch' },
  { clause: 'mode_isolation', label: 'transit route offered for a driving use case', request: REQUEST_OUT, outcome: okOutcome({ mode: 'transit' }), expect: 'mode_mismatch' },
  { clause: 'mode_isolation', label: 'rail route offered for a driving use case', request: REQUEST_OUT, outcome: okOutcome({ mode: 'rail' }), expect: 'mode_mismatch' },
  { clause: 'mode_isolation', label: 'declared mode_relabel fault', request: REQUEST_OUT, outcome: { ok: false, fault: 'mode_relabel', detail: 'provider relabelled transit as driving' }, expect: 'mode_mismatch' },
  { clause: 'evidence_class_isolation', label: 'estimate claiming live traffic', request: REQUEST_OUT, outcome: okOutcome({ evidence_class: 'live_traffic' }), expect: 'evidence_class_escalation' },
  { clause: 'evidence_class_isolation', label: 'static estimate filling a route-estimate promise', request: REQUEST_OUT, outcome: okOutcome({ evidence_class: 'static_estimate' }), expect: 'evidence_class_shortfall' },
  { clause: 'evidence_class_isolation', label: 'declared estimate_as_live_traffic fault', request: REQUEST_OUT, outcome: { ok: false, fault: 'estimate_as_live_traffic', detail: 'provider advertised live traffic for a cached estimate' }, expect: 'evidence_class_escalation' },
  { clause: 'freshness_contract', label: 'observation older than the freshness window', request: REQUEST_OUT, outcome: okOutcome({ observed_at: '2026-10-04T11:00:00.000Z' }), expect: 'stale' },
  { clause: 'freshness_contract', label: 'declared stale fault', request: REQUEST_OUT, outcome: { ok: false, fault: 'stale', detail: 'cache entry beyond max age' }, expect: 'stale' },
  { clause: 'freshness_contract', label: 'observation postdating the gate clock', request: REQUEST_OUT, outcome: okOutcome({ observed_at: '2026-10-04T12:00:01.000Z' }), expect: 'bad_ts' },
  { clause: 'source_identity', label: 'response attributed to another provider', request: REQUEST_OUT, outcome: okOutcome({ provider_id: 'some-other-provider' }), expect: 'binding_incomplete' },
  { clause: 'fault_fail_closed', label: 'declared unavailable fault', request: REQUEST_OUT, outcome: { ok: false, fault: 'unavailable', detail: 'connection refused' }, expect: 'unavailable' },
  { clause: 'fault_fail_closed', label: 'declared rate_limited fault', request: REQUEST_OUT, outcome: { ok: false, fault: 'rate_limited', detail: 'HTTP 429 retry-after 60' }, expect: 'rate_limited' },
  { clause: 'fault_fail_closed', label: 'declared partial_result fault', request: REQUEST_OUT, outcome: { ok: false, fault: 'partial_result', detail: 'duration missing' }, expect: 'partial_result' },
  { clause: 'fault_fail_closed', label: 'partial payload (duration 0 over positive distance)', request: REQUEST_OUT, outcome: okOutcome({ duration_s: 0 }), expect: 'partial_result' },
  { clause: 'fault_fail_closed', label: 'partial payload (negative distance)', request: REQUEST_OUT, outcome: okOutcome({ distance_m: -1 }), expect: 'partial_result' },
  { clause: 'fault_detail_sanitized', label: 'challenge page body with cookie + token + URL', request: REQUEST_OUT, outcome: { ok: false, fault: 'challenge', detail: CHALLENGE_BODY }, expect: 'challenge' },
  { clause: 'fare_authority_separate', label: 'provider fare offered where no fare authority is declared', request: REQUEST_OUT, outcome: okOutcome({ fare: { amount: '42.00', currency: 'CNY', authority: 'mock-offline-route-provider' } }), expect: 'fare_not_authoritative' },
  { clause: 'static_fallback_preserved', label: 'a refusal must leave the static fallback untouched', request: REQUEST_OUT, outcome: { ok: false, fault: 'unavailable', detail: 'connection refused' }, expect: 'unavailable' },
]

const report = runRouteProviderConformance(USE_CASE, MOCK_DESCRIPTOR, FULL_PROBES, NOW)
check(report.unprobed.length === 0, 'all nine clauses were probed')
for (const clause of report.clauses) {
  check(clause.verdict === 'pass', `clause ${clause.clause} passes (${clause.probes} probe(s))${clause.verdict === 'pass' ? '' : `: ${clause.evidence.join(' | ')}`}`)
}
check(report.admissible, 'the mock adapter is conformant: every clause probed and passed')
check(report.schema === ROUTE_PROVIDER_CONFORMANCE_SCHEMA && report.use_case_id === USE_CASE.id, 'the report binds its schema and the named use case')

// ---------------------------------------------------------------------------
// C. The harness is itself falsifiable
// ---------------------------------------------------------------------------
console.log('C. the harness is falsifiable: a silently-accepted fault flips its clause to fail')
const silentlyAccepting: readonly ConformanceProbe[] = FULL_PROBES.map(p =>
  p.clause === 'mode_isolation' && p.expect === 'mode_mismatch' && p.outcome.ok
    ? { ...p, outcome: okOutcome() } // the adapter "fixed" the relabel by dropping the mode claim
    : p,
)
const silentReport = runRouteProviderConformance(USE_CASE, MOCK_DESCRIPTOR, silentlyAccepting, NOW)
check(!silentReport.admissible, 'an adapter whose transit payload is accepted as driving is NOT admissible')
const modeClause = silentReport.clauses.find(c => c.clause === 'mode_isolation')
check(
  modeClause?.verdict === 'fail' && (modeClause?.evidence ?? []).some(e => e.includes('a fault was silently accepted')),
  'the mode_isolation clause reports the silent acceptance explicitly',
)
const partialReport = runRouteProviderConformance(USE_CASE, MOCK_DESCRIPTOR, FULL_PROBES.filter(p => p.clause !== 'freshness_contract'), NOW)
check(!partialReport.admissible && partialReport.unprobed.join(',') === 'freshness_contract', 'an UNPROBED clause blocks admission ("untested" is not conformance)')
check(partialReport.clauses.find(c => c.clause === 'freshness_contract')?.verdict === 'fail', 'an unprobed clause is reported as fail, never as pass')
const emptyReport = runRouteProviderConformance(USE_CASE, MOCK_DESCRIPTOR, [], NOW)
check(!emptyReport.admissible && emptyReport.unprobed.length === ROUTE_CONFORMANCE_CLAUSES.length, 'a provider with zero probes is not admissible on any clause')

console.log('C2. gate-level negative cases (use case / descriptor hygiene)')
expectRefusal(admitRouteFact({ ...USE_CASE, id: '' }, MOCK_DESCRIPTOR, REQUEST_OUT, okOutcome(), NOW), 'binding_incomplete', 'per NAMED product use case', 'an unnamed use case is refused (no global admission)')
expectRefusal(admitRouteFact({ ...USE_CASE, freshness_max_age_s: 0 }, MOCK_DESCRIPTOR, REQUEST_OUT, okOutcome(), NOW), 'binding_incomplete', 'without a freshness contract', 'a use case without a freshness contract is refused')
expectRefusal(admitRouteFact(USE_CASE, { ...MOCK_DESCRIPTOR, legal_basis: '' }, REQUEST_OUT, okOutcome(), NOW), 'binding_incomplete', 'no legal_basis', 'a provider without a legal basis is refused')
expectRefusal(admitRouteFact(USE_CASE, { ...MOCK_DESCRIPTOR, source_sha: '' }, REQUEST_OUT, okOutcome(), NOW), 'binding_incomplete', 'no source_sha', 'a provider without the reviewed source SHA is refused')
expectRefusal(
  admitRouteFact(USE_CASE, { ...MOCK_DESCRIPTOR, access_boundary: 'supplier_transaction' }, REQUEST_OUT, okOutcome(), NOW),
  'closed_set', 'never widens into a transaction boundary',
  'a read-only use case cannot be served by a transaction-boundary provider (a route fact grants no write path)',
)
expectRefusal(
  admitRouteFact(USE_CASE, MOCK_DESCRIPTOR, REQUEST_OUT, { ok: false, fault: 'mystery' as never, detail: 'x' }, NOW),
  'closed_set', 'not a degrade licence',
  'an unclassified provider failure is refused (no silent degrade)',
)
expectRefusal(
  admitRouteFact(USE_CASE, MOCK_DESCRIPTOR, REQUEST_OUT, { ok: true, response: { ...goodResponse(), mode: undefined as never } }, NOW),
  'closed_set', 'may not be labelled by the request',
  'a response with no explicit mode claim is refused (the request never supplies the label)',
)
const fareUseCase: RouteUseCase = { ...USE_CASE, id: 'drill:fare-path', fare_authority: 'separate_authoritative_source' }
expectRefusal(
  admitRouteFact(fareUseCase, MOCK_DESCRIPTOR, REQUEST_OUT, okOutcome({ fare: { amount: '42.00', currency: 'CNY', authority: MOCK_DESCRIPTOR.id } }), NOW),
  'fare_not_authoritative', 'never its own fare authority',
  'even on a fare-declaring use case, the route provider cannot be its own fare authority',
)
const separateFare = admitRouteFact(fareUseCase, MOCK_DESCRIPTOR, REQUEST_OUT, okOutcome({ fare: { amount: '42.00', currency: 'CNY', authority: 'separate-fare-authority-fixture' } }), NOW)
check(separateFare.ok && separateFare.value.fare?.authority === 'separate-fare-authority-fixture', 'a fare from a separately named authority is admitted and keeps its authority on the fact')

// ---------------------------------------------------------------------------
// D. Fault-detail sanitization
// ---------------------------------------------------------------------------
console.log('D. fault details are labels, never provider response bodies')
const scrubbed = sanitizeFaultDetail(CHALLENGE_BODY)
check(!scrubbed.includes('<html>') && !scrubbed.includes('</body>'), 'markup is stripped from the fault detail')
check(!scrubbed.includes('abc123') && !scrubbed.includes('sid=XYZ'), 'the cookie and token values never survive sanitization')
check(!scrubbed.includes('https://provider.example'), 'the challenge URL is redacted')
check(scrubbed.length <= FAULT_DETAIL_MAX_CHARS, `the sanitized detail is bounded at ${FAULT_DETAIL_MAX_CHARS} chars`)
check(faultDetailLeak(scrubbed) === null, 'the sanitized detail passes the leak check')
check(sanitizeFaultDetail('') === '(no detail)' && sanitizeFaultDetail(undefined) === '(no detail)', 'a missing detail becomes an explicit placeholder, never undefined')
check(faultDetailLeak('<b>oops</b>') !== null, 'the leak check catches markup')
check(faultDetailLeak('cookie=sid=XYZ') !== null, 'the leak check catches a credential assignment')
check(faultDetailLeak('see https://x.example') !== null, 'the leak check catches a URL')
check(sanitizeFaultDetail('x'.repeat(FAULT_DETAIL_MAX_CHARS + 50)).length === FAULT_DETAIL_MAX_CHARS, 'the sanitizer truncates an over-long provider fragment to exactly the bound')
check(faultDetailLeak('provider fault: connection refused after 3000 ms') === null, 'a host-authored explanation without leak shapes passes (length is bounded by the sanitizer, not by the leak check)')
const challengeRefusal = admitRouteFact(USE_CASE, MOCK_DESCRIPTOR, REQUEST_OUT, { ok: false, fault: 'challenge', detail: CHALLENGE_BODY }, NOW)
check(!challengeRefusal.ok && faultDetailLeak(challengeRefusal.detail) === null, 'the gate refusal for a challenge carries no leak')
check(!challengeRefusal.ok && challengeRefusal.code === 'challenge', 'a bot challenge is its own typed refusal, not a generic error')

// ---------------------------------------------------------------------------
// E. Static fallback preservation
// ---------------------------------------------------------------------------
console.log('E. a refusal leaves the static fallback and its original price label intact')
const staticBefore: StaticTransferFallback = { mode: 'taxi', minutes: 45, priceCny: 180, priceEvidence: GROUND_TRANSFER_STATIC_PRICE_EVIDENCE }
check(staticFallbackViolation(staticBefore, { ...staticBefore }) === null, 'an untouched fallback passes the mechanical check')
check(staticFallbackViolation(staticBefore, { ...staticBefore, minutes: 40 }) !== null, 'the check CATCHES a mutated static minutes value')
check(staticFallbackViolation(staticBefore, { ...staticBefore, priceCny: 42 }) !== null, 'the check CATCHES a route-supplied price')
check(staticFallbackViolation(staticBefore, { ...staticBefore, priceEvidence: '[实时API:provider]' }) !== null, 'the check CATCHES a rewritten price label (the original label stands until a separate fare authority exists)')

// ---------------------------------------------------------------------------
// F. Layering
// ---------------------------------------------------------------------------
console.log('F. layering: the conformance module is pure and has zero product callers')
const CAPABILITY_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'capabilities')
const CONFORMANCE_SOURCE = readFileSync(join(CAPABILITY_DIR, 'route-provider-conformance.ts'), 'utf8')
const importLines = CONFORMANCE_SOURCE.split('\n').filter(l => /^\s*import\s/.test(l))
check(
  importLines.length === 1 && importLines[0].includes("'./provider-detail-sanitize.ts'"),
  'the conformance module imports exactly one thing: the pure sibling sanitizer (zero network/cache/timer/clock/filesystem surface)',
)
const SANITIZER_SOURCE = readFileSync(join(CAPABILITY_DIR, 'provider-detail-sanitize.ts'), 'utf8')
check(SANITIZER_SOURCE.split('\n').filter(l => /^\s*import\s/.test(l)).length === 0, 'the shared sanitizer itself declares zero imports (one pure implementation, two callers)')
check(!/from '.*(model|unified)\.ts'/.test(CONFORMANCE_SOURCE), 'the conformance module never imports the kernel evaluate/solve layer')
check(!/new Date\(\)/.test(CONFORMANCE_SOURCE), 'the conformance module reads no clock: `now` is injected by the caller')
check(CONFORMANCE_SOURCE.includes('export const D39_LIVE_ROUTE_TRIGGER_FIRED = false'), 'the trigger declaration is literally `= false` in source')
check(CONFORMANCE_SOURCE.includes('export const ADMITTED_LIVE_ROUTE_PROVIDERS: readonly RouteProviderDescriptor[] = []'), 'the provider registry declaration is literally `= []` in source')
const INDEX_SOURCE = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src', 'index.ts'), 'utf8')
check(!INDEX_SOURCE.includes('route-provider-conformance'), 'the product entry point (ts/src/index.ts) does not reference the conformance module (zero callers)')

// ---------------------------------------------------------------------------
// G. The EXISTING ground-transfer logic against the applicable clauses
// ---------------------------------------------------------------------------
console.log('G. the accepted #341/#364 ground-transfer path driven through the applicable clauses')

const GT_CLOCK = () => new Date('2026-10-04T00:00:00.000Z')
const GT_CANDIDATES: readonly GroundTransferCandidateLike[] = [
  { id: 'cand-1', destTransfers: [{ mode: 'taxi', minutes: 45, priceCny: 180 }] },
]
const GT_REQUEST = {
  candidate_id: 'cand-1',
  transfer_index: 0,
  mode: 'driving',
  position: 'destination',
  outbound: { origin: { longitude: 100.1, latitude: 13.1 }, destination: { longitude: 100.5, latitude: 13.5 } },
  return: { origin: { longitude: 100.5, latitude: 13.5 }, destination: { longitude: 100.1, latitude: 13.1 } },
}

async function driveGroundTransfer(provider: GroundTransferProvider, clock: () => Date = GT_CLOCK) {
  const resolver = createGroundTransferResolver({ provider, clock })
  return resolveGroundTransferPayload(GT_REQUEST, GT_CANDIDATES, resolver)
}

console.log('G1. clauses that PASS today')
const gtFare = await driveGroundTransfer(async () => ({ provider: 'mock', distanceM: 30000, durationS: 2400, fareCny: 42, fareAuthoritative: true } as never))
check(gtFare.resolution.priceCny === 180 && gtFare.resolution.priceEvidence === GROUND_TRANSFER_STATIC_PRICE_EVIDENCE, 'fare_authority_separate PASSES: a provider-asserted fare is not admitted; the static price and label stand')
check(gtFare.candidates[0].destTransfers[0].priceCny === 180, 'fare_authority_separate PASSES: the patched candidate keeps its static priceCny')
const gtLive = await driveGroundTransfer(async () => ({ provider: 'mock', distanceM: 30000, durationS: 2400, trafficStatus: 'live', liveTraffic: true } as never))
check(gtLive.resolution.outbound.routeFact?.trafficStatus === 'not-live-route-estimate', 'evidence_class_isolation PASSES in the escalating direction: a provider claiming live traffic still yields not-live-route-estimate')
check(gtLive.resolution.outbound.routeFact?.evidenceClass === 'public_map_route_estimate', 'evidence_class_isolation PASSES: the fact stays a public route estimate')
const gtUnavailable = await driveGroundTransfer(async () => { throw new Error('connection refused') })
const gtStaticAfter: StaticTransferFallback = {
  mode: gtUnavailable.resolution.staticMode ?? '(absent)',
  minutes: gtUnavailable.resolution.staticMinutes ?? -1,
  priceCny: gtUnavailable.resolution.priceCny ?? -1,
  priceEvidence: gtUnavailable.resolution.priceEvidence ?? '(absent)',
}
check(staticFallbackViolation(staticBefore, gtStaticAfter) === null, 'static_fallback_preserved PASSES: an unavailable provider leaves mode/minutes/price/label byte-identical')
check(gtUnavailable.resolution.applied === false && gtUnavailable.candidates[0].destTransfers[0].minutesOut === undefined, 'fault_fail_closed PASSES: a provider error applies no minutes override')
const gtContradiction = await driveGroundTransfer(async () => ({ provider: 'mock', distanceM: 30000, durationS: 0 } as never))
check(gtContradiction.resolution.applied === false, 'fault_fail_closed PASSES: a self-contradictory route (positive distance, zero duration) falls back instead of binding zero minutes')
let gtCallLog: string[] = []
const gtDirectional = await driveGroundTransfer(async req => {
  gtCallLog.push(`${req.origin}>${req.destination}`)
  return { provider: 'mock', distanceM: 30000, durationS: req.origin === '100.1,13.1' ? 2400 : 3600 }
})
check(gtCallLog.length === 2 && gtCallLog[0] !== gtCallLog[1], 'direction_binding PASSES on the REQUEST side: each direction is queried with its own ordered pair (no cache sharing)')
check(gtDirectional.resolution.outboundMinutes === 40 && gtDirectional.resolution.returnMinutes === 60, 'direction_binding PASSES: per-direction minutes never borrow the other direction value')
let staleCalls = 0
const staleClockState = { ms: Date.parse('2026-10-04T00:00:00.000Z') }
const staleResolver = createGroundTransferResolver({
  clock: () => new Date(staleClockState.ms),
  provider: async () => {
    staleCalls++
    if (staleCalls <= 2) return { provider: 'mock', distanceM: 30000, durationS: 2400 }
    throw new Error('rate limited')
  },
})
const first = await resolveGroundTransferPayload(GT_REQUEST, GT_CANDIDATES, staleResolver)
check(first.resolution.applied && first.resolution.freshness === 'fresh', 'freshness_contract PASSES: the first resolution is fresh')
staleClockState.ms += 20 * 60 * 1000 // beyond the 15-minute window
const afterStale = await resolveGroundTransferPayload(GT_REQUEST, GT_CANDIDATES, staleResolver)
check(afterStale.resolution.applied === false && afterStale.resolution.outbound.cache.status === 'stale', 'freshness_contract PASSES: a stale cache entry is re-queried and, on failure, reported stale — never served as a hit')
check(afterStale.candidates[0].destTransfers[0].minutesOut === undefined, 'freshness_contract PASSES: a stale-then-failed direction applies no minutes override')

console.log('G2. fault_detail_sanitized: FIXED — the real resolution path no longer leaks a provider body')
// Regression for GAP-429-3 through the REAL resolution path: a throwing provider
// whose message carries markup, a token and a cookie. `safeErrorMessage` now routes
// through the shared sanitizeFaultDetail, so nothing reaches the exposed surface.
const gtLeakFixed = await driveGroundTransfer(async () => { throw new Error(CHALLENGE_BODY) })
const sanitizedReason = gtLeakFixed.resolution.outbound.fallbackReason ?? ''
check(sanitizedReason !== '', 'a throwing provider still produces a fallbackReason (the fix redacts, it does not swallow)')
check(!sanitizedReason.includes('token=abc123') && !sanitizedReason.includes('sid=XYZ'), 'the token and cookie values never reach fallbackReason')
check(!sanitizedReason.includes('<html>') && !sanitizedReason.includes('</body>'), 'provider markup never reaches fallbackReason')
check(!sanitizedReason.includes('https://provider.example'), 'the challenge URL never reaches fallbackReason')
check(sanitizedReason.includes('[credential-redacted]') && sanitizedReason.includes('[markup-redacted]'), 'the redaction is explicit and auditable, not a silent drop')
check(sanitizedReason.startsWith('map_driving_route_provider_error:outbound:'), 'the structured reason prefix is unchanged (classification still readable)')
check(faultDetailLeak(sanitizedReason) === null, 'the mechanical leak check passes on the real resolution path output')
const exposedFixed = exposeGroundTransferEvidence({ verdicts: [{ candidate_id: 'cand-1' }] }, gtLeakFixed.resolution)
const exposedJson = JSON.stringify(exposedFixed)
check(!exposedJson.includes('token=abc123') && !exposedJson.includes('sid=XYZ') && !exposedJson.includes('<html>'), 'exposeGroundTransferEvidence (wired at ts/src/index.ts:801) carries no provider body into the tool result or the verdict transfer_evidence')
check(faultDetailLeak(gtLeakFixed.resolution.fallbackReason ?? '') === null, 'the aggregate both_directions_failed reason is clean too')
check(faultDetailLeak(gtLeakFixed.resolution.return.fallbackReason ?? '') === null, 'the return-direction reason is clean too')
// No behaviour change for the fixed, already-safe error strings.
for (const safeMessage of [
  'provider unavailable',
  'invalid public result',
  'GROUND_TRANSFER_NESTED_EXECUTION_UNSUPPORTED: current tool execution context is unavailable',
  'GROUND_TRANSFER_PUBLIC_MAP_TOOL_UNAVAILABLE: map_driving_route is not registered in the current tool scope',
  'map_driving_route failed: upstream timeout after 3000 ms',
]) {
  const drive = await driveGroundTransfer(async () => { throw new Error(safeMessage) })
  check(
    drive.resolution.outbound.fallbackReason === `map_driving_route_provider_error:outbound:${safeMessage}`,
    `an already-safe provider message passes through byte-identical: "${safeMessage.slice(0, 44)}"`,
  )
}
check(sanitizeFaultDetail('a  b', { maxChars: 400 }) === 'a b', 'whitespace runs collapse (the only normalization difference vs the previous newline-only strip)')

console.log('G3. GAP-429-1 / GAP-429-2: FIXED — a contradicting provider claim fails closed (FLIPPED assertions)')
function gtStaticAfterOf(resolution: { staticMode?: string; staticMinutes?: number; priceCny?: number; priceEvidence?: string }): StaticTransferFallback {
  return {
    mode: resolution.staticMode ?? '(absent)',
    minutes: resolution.staticMinutes ?? -1,
    priceCny: resolution.priceCny ?? -1,
    priceEvidence: resolution.priceEvidence ?? '(absent)',
  }
}

// GAP-429-1 (mode_isolation). Was: the mode claim was dropped, the fact was
// labelled mode='driving' and the transit duration was bound into the solver.
const gtModeRelabel = await driveGroundTransfer(async () => ({ provider: 'mock-transit', distanceM: 30000, durationS: 3600, mode: 'transit' } as never))
check(
  gtModeRelabel.resolution.applied === false
  && gtModeRelabel.resolution.outbound.routeFact === undefined
  && gtModeRelabel.candidates[0].destTransfers[0].minutesOut === undefined
  && gtModeRelabel.candidates[0].destTransfers[0].minutesRet === undefined,
  'GAP-429-1 (mode_isolation) FIXED: a payload asserting mode="transit" is refused — no route fact, and its 60 minutes are never bound into the solver (was: silently relabelled driving and bound). FLIPPED from the characterization assertion; reverting the ground-transfer fix makes this fail.',
)
check(
  (gtModeRelabel.resolution.outbound.fallbackReason ?? '').startsWith('mode_mismatch:outbound:')
  && (gtModeRelabel.resolution.return.fallbackReason ?? '').startsWith('mode_mismatch:return:'),
  'GAP-429-1 FIXED: both directions carry the conformance refusal vocabulary in the existing `<code>:<direction>:<detail>` reason shape',
)
check(
  gtModeRelabel.resolution.provenance === 'static-transfer-pack' && gtModeRelabel.resolution.evidenceClass === 'static_transfer_estimate',
  'GAP-429-1 FIXED: the refusal reports the static pack as the provenance, never a map route estimate',
)
check(staticFallbackViolation(staticBefore, gtStaticAfterOf(gtModeRelabel.resolution)) === null, 'GAP-429-1 FIXED: static_fallback_preserved still holds — mode, minutes, price and label byte-identical')
check(faultDetailLeak(gtModeRelabel.resolution.outbound.fallbackReason ?? '') === null, 'GAP-429-1 FIXED: the provider-authored mode claim is quoted through the shared sanitizer (no leak)')
expectRefusal(
  admitRouteFact(USE_CASE, MOCK_DESCRIPTOR, REQUEST_OUT, okOutcome({ mode: 'transit' }), NOW),
  'mode_mismatch', 'must never be relabelled',
  'GAP-429-1: the conformance gate refuses the same payload with the same code (gate and product path now agree)',
)

// GAP-429-2 (direction_binding, RESPONSE side). Was: the provider's own resolved
// O/D was never read, the fact echoed the REQUESTED pair, and a 999 m / 60 s
// route was bound as the airport transfer.
const gtWrongOd = await driveGroundTransfer(async () => ({ provider: 'mock-wrong-od', distanceM: 999, durationS: 60, resolvedOrigin: '0,0', resolvedDestination: '1,1' } as never))
check(
  gtWrongOd.resolution.applied === false
  && gtWrongOd.resolution.outbound.routeFact === undefined
  && gtWrongOd.candidates[0].destTransfers[0].minutesOut === undefined
  && gtWrongOd.candidates[0].destTransfers[0].minutesRet === undefined,
  'GAP-429-2 (direction_binding, RESPONSE side) FIXED: a provider that resolved 0,0→1,1 is refused — the 999 m / 60 s route is never bound as the airport transfer. FLIPPED from the characterization assertion; reverting the ground-transfer fix makes this fail.',
)
check(
  (gtWrongOd.resolution.outbound.fallbackReason ?? '').startsWith('direction_mismatch:outbound:')
  && (gtWrongOd.resolution.return.fallbackReason ?? '').startsWith('direction_mismatch:return:'),
  'GAP-429-2 FIXED: both directions carry the `direction_mismatch:<direction>:<detail>` reason',
)
check(staticFallbackViolation(staticBefore, gtStaticAfterOf(gtWrongOd.resolution)) === null, 'GAP-429-2 FIXED: static_fallback_preserved still holds after a direction refusal')
check(faultDetailLeak(gtWrongOd.resolution.outbound.fallbackReason ?? '') === null, 'GAP-429-2 FIXED: the echoed pair is quoted through the shared sanitizer (no leak)')
expectRefusal(
  admitRouteFact(USE_CASE, MOCK_DESCRIPTOR, REQUEST_OUT, okOutcome({ echoed_origin: '0,0', echoed_destination: '1,1' }), NOW),
  'direction_mismatch', 'verified against the RESPONSE, not assumed from the request',
  'GAP-429-2: the conformance gate verifies the echoed pair with the same code (gate and product path now agree)',
)

// The enforcement is a verification, not a blanket refusal: a conforming claim is
// admitted exactly as before, and a road-node snap inside the documented
// tolerance still matches. Absent claims (the wired `map_driving_route` tool)
// keep today's behaviour byte for byte — asserted throughout G1/G2 above and by
// the unchanged ts/scripts/ground-transfer-tests.ts suite.
function offsetEndpoint(text: string, deltaDeg: number): string {
  const [longitude, latitude] = text.split(',').map(Number) as [number, number]
  return `${String(longitude + deltaDeg)},${String(latitude + deltaDeg)}`
}
const gtConforming = await driveGroundTransfer(async req => ({
  provider: 'mock-conforming', distanceM: 30000, durationS: 2400,
  mode: 'driving', resolvedOrigin: req.origin, resolvedDestination: req.destination,
} as never))
check(
  gtConforming.resolution.applied === true
  && gtConforming.resolution.outbound.routeFact?.mode === 'driving'
  && gtConforming.candidates[0].destTransfers[0].minutesOut === 40,
  'a provider that declares driving AND echoes the requested pair is admitted unchanged (the fix verifies claims, it does not refuse them)',
)
check(
  gtConforming.resolution.outbound.routeFact?.trafficStatus === 'not-live-route-estimate'
  && gtConforming.resolution.outbound.routeFact?.evidenceClass === 'public_map_route_estimate',
  'a verified fact is still only a route estimate: verification never upgrades the evidence class',
)
const gtSnapped = await driveGroundTransfer(async req => ({
  provider: 'mock-snapped', distanceM: 30000, durationS: 2400,
  resolvedOrigin: offsetEndpoint(req.origin, 0.00005), resolvedDestination: offsetEndpoint(req.destination, 0.00005),
} as never))
check(
  gtSnapped.resolution.applied === true && gtSnapped.candidates[0].destTransfers[0].minutesOut === 40,
  'an endpoint snapped to the nearest road node (5e-5 deg ≈ 5 m, inside the documented 1e-4 tolerance) is still the requested place',
)
const gtDrifted = await driveGroundTransfer(async req => ({
  provider: 'mock-drifted', distanceM: 30000, durationS: 2400,
  resolvedOrigin: offsetEndpoint(req.origin, 0.01), resolvedDestination: req.destination,
} as never))
check(
  gtDrifted.resolution.applied === false && (gtDrifted.resolution.outbound.fallbackReason ?? '').startsWith('direction_mismatch:outbound:'),
  'an endpoint ~1.1 km away is beyond the tolerance and is refused: a snap is not a different place',
)
const gtUnparseableEcho = await driveGroundTransfer(async () => ({
  provider: 'mock-unparseable', distanceM: 30000, durationS: 2400, resolvedDestination: 'Suvarnabhumi Airport',
} as never))
check(
  gtUnparseableEcho.resolution.applied === false && (gtUnparseableEcho.resolution.outbound.fallbackReason ?? '').startsWith('direction_mismatch:outbound:'),
  'a present-but-unverifiable echo fails closed (an unparseable pair is never assumed to be the requested one)',
)

console.log(`\nROUTE PROVIDER CONFORMANCE TESTS (#429, simulated_trigger_drill / fixture_contract; no real provider contacted): ${passed} pass${process.exitCode ? ', FAIL' : ' (all green)'}`)
