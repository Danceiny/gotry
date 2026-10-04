/**
 * D-39 live-route provider CONFORMANCE contract v1 (issue #429 contract slice,
 * SIMULATED-TRIGGER DRILL — default OFF, zero callers, trigger flag frozen false,
 * provider registry frozen EMPTY).
 *
 * ⚠ Evidence boundary: this is the conformance GATE any future live-route adapter
 * must pass, exercised here against a MOCK adapter only. #429's trigger is, per
 * path, "a named product use case + the actual data provider and access boundary +
 * reviewable authority/freshness/coverage evidence"; it has NOT fired for any path.
 * No real routing provider is contacted (`consultRouteProvider` refuses before
 * touching an adapter while the trigger is false), no dependency is added, and the
 * accepted narrow path of #341 (explicit-coordinate destination driving estimate
 * with static price evidence) is untouched. Nothing here claims provider
 * availability or an M4/M5/M6 Exit.
 *
 * What it owns: the single admission gate `admitRouteFact` — a provider outcome
 * becomes a route fact only if the provider's OWN claims (mode, evidence class,
 * echoed origin/destination, freshness, fare authority) match the declared use
 * case. Every mismatch is a typed refusal whose detail is sanitized, and a refusal
 * always leaves the static fallback and its original price label intact.
 *
 * Frozen upstream constraints (READ-ONLY reuse):
 *  - docs/architecture.md D-39 + §10: each wider path needs its own named use case,
 *    source, freshness contract, access boundary and real-data proof; read-only
 *    routing authorizes no write path;
 *  - ts/capabilities/ground-transfer.ts (#341/#364/#382): the accepted narrow shape
 *    — per-direction isolation, host observation time (never a provider publication
 *    timestamp), `trafficStatus: 'not-live-route-estimate'`, and the static
 *    `priceCny` + `[静态包:估算]` label that a route fact never replaces;
 *  - ts/capabilities/fx-contract.ts (#344): the trigger-gated, frozen-empty
 *    registry seam and the "stale/miss/error never masquerades as current" rule.
 *
 * Layering: this module performs zero network, cache, timer, clock or filesystem
 * work, and its ONLY import is the pure sibling sanitizer
 * `provider-detail-sanitize.ts` (shared with the live ground-transfer path so one
 * implementation serves both). It imports nothing from the kernel evaluate/solve
 * layer (`src/model.ts`, `src/unified.ts`), and no product file imports it. Any
 * future adapter's network/cache work stays on the capability side of that line;
 * the focused suite asserts the import surface mechanically.
 *
 * Only the real trigger can supply: the provider identity and licence, actual
 * coverage/freshness measurements, a separately authoritative fare source, and an
 * authorized minimal real path recorded at an exact source SHA.
 *
 * @module capabilities/route-provider-conformance
 */

import { FAULT_DETAIL_MAX_CHARS, faultDetailLeak, sanitizeFaultDetail } from './provider-detail-sanitize.ts'

/** Re-exported so the conformance gate stays the single API surface for callers. */
export { FAULT_DETAIL_MAX_CHARS, faultDetailLeak, sanitizeFaultDetail }

export const ROUTE_PROVIDER_CONFORMANCE_SCHEMA = 'gotry_route_provider_conformance.v1'

/**
 * D-39 wider-path trigger gate, frozen false. Each path (live traffic, transit,
 * rail, fare, address resolution) is admitted independently; flipping this is a
 * per-path founder decision with a named use case and a real provider.
 */
export const D39_LIVE_ROUTE_TRIGGER_FIRED = false

/** Transport modes. A provider may never relabel one as another, in either direction. */
export const ROUTE_MODES = ['driving', 'transit', 'rail', 'walking', 'cycling'] as const
export type RouteMode = (typeof ROUTE_MODES)[number]

/** Evidence classes, weakest first. A declared class must match EXACTLY. */
export const ROUTE_EVIDENCE_CLASSES = ['static_estimate', 'route_estimate', 'live_traffic'] as const
export type RouteEvidenceClass = (typeof ROUTE_EVIDENCE_CLASSES)[number]

/** Access boundaries. A read-only routing admission never implies a write path. */
export const ROUTE_ACCESS_BOUNDARIES = ['read_only_public', 'licensed_read_only', 'supplier_transaction'] as const
export type RouteAccessBoundary = (typeof ROUTE_ACCESS_BOUNDARIES)[number]

/** Fault modes every candidate provider must be probed against before admission. */
export const ROUTE_PROVIDER_FAULT_MODES = [
  'unavailable',
  'stale',
  'mismatched_direction',
  'mode_relabel',
  'estimate_as_live_traffic',
  'challenge',
  'rate_limited',
  'partial_result',
] as const
export type RouteProviderFaultMode = (typeof ROUTE_PROVIDER_FAULT_MODES)[number]

/** Conformance clauses. A future adapter is admissible only if ALL of them pass. */
export const ROUTE_CONFORMANCE_CLAUSES = [
  /** the response must echo the requested origin/destination; the swapped pair is a different fact */
  'direction_binding',
  /** the provider's own mode claim must equal the use case's mode */
  'mode_isolation',
  /** the provider's own evidence class must equal the use case's (no escalation, no shortfall) */
  'evidence_class_isolation',
  /** a provider outside the freshness contract is stale, never current */
  'freshness_contract',
  /** every admitted fact names its source identity and access boundary */
  'source_identity',
  /** every fault mode fails closed with a typed code — never a silent degrade */
  'fault_fail_closed',
  /** a refusal leaves the static fallback minutes, price and original label untouched */
  'static_fallback_preserved',
  /** a route provider is never a fare authority unless the use case declares a separate one */
  'fare_authority_separate',
  /** fault details are sanitized: no provider response body, markup, cookie or token */
  'fault_detail_sanitized',
] as const
export type RouteConformanceClause = (typeof ROUTE_CONFORMANCE_CLAUSES)[number]

// ---------------------------------------------------------------------------
// Typed results (closed error-code set)
// ---------------------------------------------------------------------------

export type RouteErrorCode =
  /** the per-path D-39 trigger has not fired: no adapter is consulted */
  | 'trigger_deferred'
  /** the provider is not in the admitted registry */
  | 'provider_not_admitted'
  /** a value outside a closed set (mode, evidence class, access boundary, fault mode) */
  | 'closed_set'
  /** a mandatory field is missing or blank */
  | 'binding_incomplete'
  /** the response does not echo the requested origin/destination */
  | 'direction_mismatch'
  /** the provider's mode claim contradicts the use case */
  | 'mode_mismatch'
  /** the provider claims a stronger evidence class than the use case declares */
  | 'evidence_class_escalation'
  /** the provider delivers a weaker evidence class than the use case promises */
  | 'evidence_class_shortfall'
  /** outside the freshness contract */
  | 'stale'
  /** the provider could not be reached / returned nothing */
  | 'unavailable'
  /** a bot challenge / captcha was served */
  | 'challenge'
  /** the provider rate-limited the request */
  | 'rate_limited'
  /** distance/duration missing, non-finite, negative or self-contradictory */
  | 'partial_result'
  /** a fare was offered where the use case declares no fare authority */
  | 'fare_not_authoritative'
  /** a timestamp is missing, unparseable, date-only or postdates the clock */
  | 'bad_ts'

export type RouteResult<T> = { ok: true; value: T } | { ok: false; code: RouteErrorCode; detail: string }

function fail<T>(code: RouteErrorCode, detail: string): RouteResult<T> {
  return { ok: false, code, detail }
}
function pass<T>(value: T): RouteResult<T> {
  return { ok: true, value }
}

// ---------------------------------------------------------------------------
// Use case, provider descriptor, request/response shapes
// ---------------------------------------------------------------------------

/**
 * A NAMED product use case. D-39 admits a path per use case, never globally:
 * the mode, direction sensitivity, evidence class, freshness window, fare
 * authority and access boundary are all frozen here before any provider is read.
 */
export interface RouteUseCase {
  readonly id: string
  readonly mode: RouteMode
  readonly evidence_class: RouteEvidenceClass
  readonly freshness_max_age_s: number
  readonly access_boundary: RouteAccessBoundary
  /** 'none' = the static price and its original label stand; no provider fare is admitted */
  readonly fare_authority: 'none' | 'separate_authoritative_source'
}

export interface RouteProviderDescriptor {
  readonly id: string
  /** why this provider may legally be read (licence / official free tier / authorization) */
  readonly legal_basis: string
  readonly access_boundary: RouteAccessBoundary
  /** the exact upstream source revision the admission was reviewed against */
  readonly source_sha: string
}

/** Runtime provider registry, frozen EMPTY. A non-empty value is a founder decision. */
export const ADMITTED_LIVE_ROUTE_PROVIDERS: readonly RouteProviderDescriptor[] = []

export type RouteDirection = 'outbound' | 'return'

export interface RouteRequest {
  readonly direction: RouteDirection
  /** canonical "lon,lat" origin as SENT to the provider */
  readonly origin: string
  /** canonical "lon,lat" destination as SENT to the provider */
  readonly destination: string
  readonly mode: RouteMode
}

/**
 * The response shape a candidate adapter must produce. The provider's OWN claims
 * are mandatory and explicit — they are what the gate checks. Silently dropping a
 * contradicting claim is exactly the relabel this contract forbids.
 */
export interface RouteProviderResponse {
  readonly provider_id: string
  readonly mode: RouteMode
  readonly evidence_class: RouteEvidenceClass
  /** the origin the provider says it routed FROM (must equal the requested origin) */
  readonly echoed_origin: string
  /** the destination the provider says it routed TO (must equal the requested destination) */
  readonly echoed_destination: string
  readonly distance_m: number
  readonly duration_s: number
  /** HOST observation instant, never a provider publication timestamp */
  readonly observed_at: string
  readonly fare?: { readonly amount: string; readonly currency: string; readonly authority: string }
}

export type RouteProviderOutcome =
  | { readonly ok: true; readonly response: RouteProviderResponse }
  | { readonly ok: false; readonly fault: RouteProviderFaultMode; readonly detail: string }

export interface RouteProviderAdapter {
  readonly descriptor: RouteProviderDescriptor
  fetchRoute(request: RouteRequest, context: { readonly signal: AbortSignal }): Promise<RouteProviderOutcome>
}

/** An admitted route fact: every field is checked, none inferred. */
export interface RouteFact {
  readonly schema: typeof ROUTE_PROVIDER_CONFORMANCE_SCHEMA
  readonly use_case_id: string
  readonly direction: RouteDirection
  readonly origin: string
  readonly destination: string
  readonly mode: RouteMode
  readonly evidence_class: RouteEvidenceClass
  readonly provider_id: string
  readonly access_boundary: RouteAccessBoundary
  readonly source_sha: string
  readonly distance_m: number
  readonly duration_s: number
  readonly duration_min: number
  readonly observed_at: string
  readonly age_s: number
  /** fares are never carried by a route fact unless a separate authority supplied one */
  readonly fare: { readonly amount: string; readonly currency: string; readonly authority: string } | null
}

// ---------------------------------------------------------------------------
// Detail sanitization: see ./provider-detail-sanitize.ts (shared with the live
// ground-transfer path; re-exported above so this gate stays the single API).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The admission gate
// ---------------------------------------------------------------------------

function parseInstant(value: unknown, label: string): RouteResult<string> {
  if (typeof value !== 'string' || value.trim() === '') return fail('bad_ts', `${label} must be a non-empty ISO-8601 instant, got ${JSON.stringify(value)}`)
  if (/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return fail('bad_ts', `${label} must carry a full time-of-day (date-only '${value}' cannot be aged)`)
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return fail('bad_ts', `${label} is not a parseable ISO-8601 instant: ${JSON.stringify(value)}`)
  return pass(new Date(ms).toISOString())
}

/** Map a provider fault to its typed refusal code (closed, total mapping). */
const FAULT_CODE: Readonly<Record<RouteProviderFaultMode, RouteErrorCode>> = {
  unavailable: 'unavailable',
  stale: 'stale',
  mismatched_direction: 'direction_mismatch',
  mode_relabel: 'mode_mismatch',
  estimate_as_live_traffic: 'evidence_class_escalation',
  challenge: 'challenge',
  rate_limited: 'rate_limited',
  partial_result: 'partial_result',
}

/**
 * The single admission gate: a provider outcome becomes a route fact only if every
 * declared claim matches the named use case. Each refusal is typed and sanitized;
 * no refusal ever degrades into a weaker-but-accepted fact.
 */
export function admitRouteFact(
  useCase: RouteUseCase,
  descriptor: RouteProviderDescriptor,
  request: RouteRequest,
  outcome: RouteProviderOutcome,
  now: string,
): RouteResult<RouteFact> {
  if (typeof useCase?.id !== 'string' || useCase.id.trim() === '') return fail('binding_incomplete', 'use case id is mandatory: a path is admitted per NAMED product use case, never globally')
  if (!(ROUTE_MODES as readonly string[]).includes(useCase.mode)) return fail('closed_set', `use case mode must be one of [${ROUTE_MODES.join('/')}], got ${JSON.stringify(useCase.mode)}`)
  if (!(ROUTE_EVIDENCE_CLASSES as readonly string[]).includes(useCase.evidence_class)) return fail('closed_set', `use case evidence_class must be one of [${ROUTE_EVIDENCE_CLASSES.join('/')}], got ${JSON.stringify(useCase.evidence_class)}`)
  if (!(ROUTE_ACCESS_BOUNDARIES as readonly string[]).includes(useCase.access_boundary)) return fail('closed_set', `use case access_boundary must be one of [${ROUTE_ACCESS_BOUNDARIES.join('/')}]`)
  if (!Number.isFinite(useCase.freshness_max_age_s) || useCase.freshness_max_age_s <= 0) return fail('binding_incomplete', 'use case freshness_max_age_s must be a positive number of seconds (a path without a freshness contract is not admitted)')

  if (typeof descriptor?.id !== 'string' || descriptor.id.trim() === '') return fail('binding_incomplete', 'provider descriptor id is mandatory (source identity)')
  if (typeof descriptor.legal_basis !== 'string' || descriptor.legal_basis.trim() === '') return fail('binding_incomplete', `provider ${descriptor.id} carries no legal_basis — admission requires a stated licence / access boundary`)
  if (typeof descriptor.source_sha !== 'string' || descriptor.source_sha.trim() === '') return fail('binding_incomplete', `provider ${descriptor.id} carries no source_sha — D-39 requires the exact reviewed source revision`)
  if (descriptor.access_boundary !== useCase.access_boundary) {
    return fail('closed_set', `provider ${descriptor.id} access boundary '${descriptor.access_boundary}' does not match use case '${useCase.id}' boundary '${useCase.access_boundary}' — a read-only routing admission never widens into a transaction boundary`)
  }

  if (typeof request?.origin !== 'string' || request.origin.trim() === '' || typeof request?.destination !== 'string' || request.destination.trim() === '') {
    return fail('binding_incomplete', 'request origin and destination are mandatory (direction binding has nothing to bind otherwise)')
  }
  if (request.mode !== useCase.mode) {
    return fail('mode_mismatch', `request mode '${request.mode}' contradicts use case '${useCase.id}' mode '${useCase.mode}'`)
  }

  if (!outcome?.ok) {
    if (!(ROUTE_PROVIDER_FAULT_MODES as readonly string[]).includes(outcome?.fault)) {
      return fail('closed_set', `provider fault must be one of [${ROUTE_PROVIDER_FAULT_MODES.join('/')}], got ${JSON.stringify(outcome?.fault)} — an unclassified failure is not a degrade licence`)
    }
    return fail(FAULT_CODE[outcome.fault], `provider ${descriptor.id} fault '${outcome.fault}': ${sanitizeFaultDetail(outcome.detail)}`)
  }

  const response = outcome.response
  if (typeof response?.provider_id !== 'string' || response.provider_id.trim() === '') return fail('binding_incomplete', 'response provider_id is mandatory (source identity per fact)')
  if (response.provider_id !== descriptor.id) {
    return fail('binding_incomplete', `response provider_id '${response.provider_id}' does not match the admitted descriptor '${descriptor.id}' — a fact may not be attributed to a provider that did not produce it`)
  }
  if (!(ROUTE_MODES as readonly string[]).includes(response.mode)) {
    return fail('closed_set', `response mode must be one of [${ROUTE_MODES.join('/')}], got ${JSON.stringify(response.mode)} — a response without an explicit mode claim may not be labelled by the request`)
  }
  if (response.mode !== useCase.mode) {
    return fail('mode_mismatch', `provider ${descriptor.id} returned mode '${response.mode}' for a '${useCase.mode}' use case — ${response.mode} must never be relabelled as ${useCase.mode} (nor the reverse)`)
  }
  if (!(ROUTE_EVIDENCE_CLASSES as readonly string[]).includes(response.evidence_class)) {
    return fail('closed_set', `response evidence_class must be one of [${ROUTE_EVIDENCE_CLASSES.join('/')}], got ${JSON.stringify(response.evidence_class)}`)
  }
  if (response.evidence_class !== useCase.evidence_class) {
    const providerRank = ROUTE_EVIDENCE_CLASSES.indexOf(response.evidence_class)
    const useCaseRank = ROUTE_EVIDENCE_CLASSES.indexOf(useCase.evidence_class)
    return providerRank > useCaseRank
      ? fail('evidence_class_escalation', `provider ${descriptor.id} claims '${response.evidence_class}' for a '${useCase.evidence_class}' use case — an estimate must never be presented as ${response.evidence_class}`)
      : fail('evidence_class_shortfall', `provider ${descriptor.id} delivered '${response.evidence_class}' for a '${useCase.evidence_class}' use case — a weaker class may not fill a stronger promise`)
  }

  if (response.echoed_origin !== request.origin || response.echoed_destination !== request.destination) {
    return fail(
      'direction_mismatch',
      `provider ${descriptor.id} routed ${response.echoed_origin}→${response.echoed_destination} but the ${request.direction} request was ${request.origin}→${request.destination} — direction binding is verified against the RESPONSE, not assumed from the request`,
    )
  }

  const distance = response.distance_m
  const duration = response.duration_s
  if (
    typeof distance !== 'number' || !Number.isFinite(distance) || distance < 0
    || typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0
    || (distance > 0 && duration === 0)
  ) {
    return fail('partial_result', `provider ${descriptor.id} returned an incomplete or self-contradictory route (distance_m=${String(distance)}, duration_s=${String(duration)}); a positive distance cannot be covered in zero time`)
  }

  const nowParsed = parseInstant(now, 'gate clock now')
  if (!nowParsed.ok) return nowParsed
  const observedAt = parseInstant(response.observed_at, 'response observed_at (host observation instant)')
  if (!observedAt.ok) return observedAt
  if (observedAt.value > nowParsed.value) {
    return fail('bad_ts', `observed_at ${observedAt.value} postdates the gate clock ${nowParsed.value} — a provider publication timestamp is not a host observation instant`)
  }
  const ageS = (Date.parse(nowParsed.value) - Date.parse(observedAt.value)) / 1000
  if (ageS > useCase.freshness_max_age_s) {
    return fail('stale', `observation is ${ageS}s old, beyond the '${useCase.id}' freshness contract of ${useCase.freshness_max_age_s}s — stale never masquerades as current`)
  }

  let fare: RouteFact['fare'] = null
  if (response.fare !== undefined) {
    if (useCase.fare_authority === 'none') {
      return fail(
        'fare_not_authoritative',
        `provider ${descriptor.id} offered a fare for use case '${useCase.id}' which declares no fare authority — the static price and its original label stand until a separately authoritative fare exists`,
      )
    }
    const f = response.fare
    if (typeof f.amount !== 'string' || f.amount.trim() === '' || typeof f.currency !== 'string' || f.currency.trim() === '' || typeof f.authority !== 'string' || f.authority.trim() === '') {
      return fail('binding_incomplete', 'an admitted fare needs amount, currency and a named authority')
    }
    if (f.authority === descriptor.id || f.authority === response.provider_id) {
      return fail('fare_not_authoritative', `a route provider ('${descriptor.id}') is never its own fare authority — '${useCase.id}' requires a separately authoritative fare source`)
    }
    fare = { amount: f.amount, currency: f.currency, authority: f.authority }
  }

  return pass(Object.freeze({
    schema: ROUTE_PROVIDER_CONFORMANCE_SCHEMA,
    use_case_id: useCase.id,
    direction: request.direction,
    origin: request.origin,
    destination: request.destination,
    mode: useCase.mode,
    evidence_class: useCase.evidence_class,
    provider_id: descriptor.id,
    access_boundary: descriptor.access_boundary,
    source_sha: descriptor.source_sha,
    distance_m: distance,
    duration_s: duration,
    duration_min: Math.round(duration / 60),
    observed_at: observedAt.value,
    age_s: ageS,
    fare,
  }))
}

/**
 * The only entry point to a live route adapter. While `D39_LIVE_ROUTE_TRIGGER_FIRED`
 * is false this refuses BEFORE touching the adapter, so zero routing providers are
 * contacted (the fetch-spy zero-call proof in run-all §87).
 */
export async function consultRouteProvider(
  adapter: RouteProviderAdapter,
  useCase: RouteUseCase,
  request: RouteRequest,
  /** `now` is MANDATORY: this module reads no clock, so the caller injects one. */
  options: { now: string; triggerFired?: boolean; registry?: readonly RouteProviderDescriptor[]; signal?: AbortSignal },
): Promise<RouteResult<RouteFact>> {
  const triggerFired = options?.triggerFired ?? D39_LIVE_ROUTE_TRIGGER_FIRED
  if (!triggerFired) {
    return fail(
      'trigger_deferred',
      `D-39 path trigger has not fired for use case '${String(useCase?.id)}' (#429: a named product use case + the actual provider and access boundary + reviewable authority/freshness/coverage evidence); zero routing providers contacted, static fallback stands`,
    )
  }
  const registry = options?.registry ?? ADMITTED_LIVE_ROUTE_PROVIDERS
  if (!registry.some(d => d.id === adapter?.descriptor?.id)) {
    return fail(
      'provider_not_admitted',
      `provider '${String(adapter?.descriptor?.id)}' is not in the admitted registry (admitted: [${registry.map(d => d.id).join('/') || 'none'}]); admitting one is a per-path founder decision with a legal_basis and source_sha`,
    )
  }
  const outcome = await adapter.fetchRoute(request, { signal: options?.signal ?? new AbortController().signal })
  return admitRouteFact(useCase, adapter.descriptor, request, outcome, options.now)
}

// ---------------------------------------------------------------------------
// Static fallback preservation
// ---------------------------------------------------------------------------

/** The static transfer a refusal must leave byte-identical. */
export interface StaticTransferFallback {
  readonly mode: string
  readonly minutes: number
  readonly priceCny: number
  readonly priceEvidence: string
}

/**
 * Mechanical check: after a refusal, the static fallback must be unchanged —
 * same mode, same minutes, same price and the SAME original price label. Returns
 * a violation string, or null.
 */
export function staticFallbackViolation(before: StaticTransferFallback, after: StaticTransferFallback): string | null {
  if (before.mode !== after.mode) return `static fallback mode changed '${before.mode}' → '${after.mode}'`
  if (before.minutes !== after.minutes) return `static fallback minutes changed ${before.minutes} → ${after.minutes}: a refused route fact must not touch the static estimate`
  if (before.priceCny !== after.priceCny) return `static fallback priceCny changed ${before.priceCny} → ${after.priceCny}: a route fact never supplies a price`
  if (before.priceEvidence !== after.priceEvidence) return `static price label changed '${before.priceEvidence}' → '${after.priceEvidence}': the original label stands until a separately authoritative fare exists`
  return null
}

// ---------------------------------------------------------------------------
// The conformance report
// ---------------------------------------------------------------------------

/** One probe a candidate adapter must be driven through. */
export interface ConformanceProbe {
  readonly clause: RouteConformanceClause
  readonly label: string
  readonly request: RouteRequest
  readonly outcome: RouteProviderOutcome
  /** the refusal code this probe must produce; null = the probe must be ADMITTED */
  readonly expect: RouteErrorCode | null
}

export interface ClauseVerdict {
  readonly clause: RouteConformanceClause
  readonly verdict: 'pass' | 'fail'
  readonly probes: number
  readonly evidence: readonly string[]
}

export interface ConformanceReport {
  readonly schema: typeof ROUTE_PROVIDER_CONFORMANCE_SCHEMA
  readonly use_case_id: string
  readonly provider_id: string
  readonly admissible: boolean
  readonly clauses: readonly ClauseVerdict[]
  /** clauses with zero probes: an unprobed clause is never a pass */
  readonly unprobed: readonly RouteConformanceClause[]
}

/**
 * Run the conformance probes and report per clause.
 *
 * `admissible` is true only when every clause in `ROUTE_CONFORMANCE_CLAUSES` was
 * probed AND passed: an unprobed clause is reported as unprobed and blocks
 * admission, because "we never tested that" is not evidence of conformance.
 */
export function runRouteProviderConformance(
  useCase: RouteUseCase,
  descriptor: RouteProviderDescriptor,
  probes: readonly ConformanceProbe[],
  now: string,
): ConformanceReport {
  const byClause = new Map<RouteConformanceClause, { pass: boolean; count: number; evidence: string[] }>()
  for (const probe of probes) {
    const slot = byClause.get(probe.clause) ?? { pass: true, count: 0, evidence: [] }
    slot.count++
    const result = admitRouteFact(useCase, descriptor, probe.request, probe.outcome, now)
    if (probe.expect === null) {
      if (result.ok) slot.evidence.push(`${probe.label}: admitted as expected`)
      else {
        slot.pass = false
        slot.evidence.push(`${probe.label}: expected admission, got refusal ${result.code} — ${result.detail}`)
      }
    } else if (result.ok) {
      slot.pass = false
      slot.evidence.push(`${probe.label}: expected refusal ${probe.expect}, got ADMISSION (a fault was silently accepted)`)
    } else if (result.code !== probe.expect) {
      slot.pass = false
      slot.evidence.push(`${probe.label}: expected refusal ${probe.expect}, got ${result.code} — ${result.detail}`)
    } else {
      const leak = faultDetailLeak(result.detail)
      if (leak !== null) {
        slot.pass = false
        slot.evidence.push(`${probe.label}: refused ${result.code} but the detail leaks — ${leak}`)
      } else {
        slot.evidence.push(`${probe.label}: refused ${result.code} with a sanitized detail`)
      }
    }
    byClause.set(probe.clause, slot)
  }

  const clauses: ClauseVerdict[] = []
  const unprobed: RouteConformanceClause[] = []
  for (const clause of ROUTE_CONFORMANCE_CLAUSES) {
    const slot = byClause.get(clause)
    if (slot === undefined) {
      unprobed.push(clause)
      clauses.push({ clause, verdict: 'fail', probes: 0, evidence: ['clause was never probed — "untested" is not conformance'] })
      continue
    }
    clauses.push({ clause, verdict: slot.pass ? 'pass' : 'fail', probes: slot.count, evidence: Object.freeze([...slot.evidence]) as readonly string[] })
  }
  return Object.freeze({
    schema: ROUTE_PROVIDER_CONFORMANCE_SCHEMA,
    use_case_id: useCase.id,
    provider_id: descriptor.id,
    admissible: unprobed.length === 0 && clauses.every(c => c.verdict === 'pass'),
    clauses: Object.freeze([...clauses]) as readonly ClauseVerdict[],
    unprobed: Object.freeze([...unprobed]) as readonly RouteConformanceClause[],
  })
}
