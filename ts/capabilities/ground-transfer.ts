/**
 * Bounded ground-transfer seam for explicit airport/station coordinates.
 *
 * This capability owns only the boundary between a public
 * `map_driving_route` result and the deterministic candidate input. It never
 * calls a map client directly, never writes shared state, and never supplies
 * a price: the selected candidate transfer keeps its static `priceCny`.
 *
 * Each `ground_transfer` request resolves two deterministic directions —
 * outbound (origin → destination) and return (destination → origin) — and
 * binds the resulting route minutes to the candidate transfer as
 * `minutesOut` / `minutesRet` overrides consumed by the solver / arithmetic
 * layer. Cache, freshness, and fallback are isolated per direction so a
 * miss / error / stale / mismatch in one direction never borrows the
 * dynamic value of the other.
 *
 * A provider's OWN claims about its answer — declared `mode`, resolved
 * origin/destination — are verified against the request whenever the provider
 * makes them: a contradiction is refused with the conformance vocabulary
 * (`mode_mismatch` / `direction_mismatch`) and falls back to the static estimate,
 * so a transit duration is never bound as driving and a route between two other
 * places is never bound as the airport transfer (issue #429 GAP-429-1/2). All
 * three fields are OPTIONAL and absent means unverifiable: see
 * `PublicMapDrivingRouteResult` for why absent is still accepted today.
 *
 * A provider failure becomes a `fallbackReason`, and `exposeGroundTransferEvidence`
 * carries that text into the tool result and each matching verdict's
 * `transfer_evidence`. It is therefore an EXPOSED surface: every provider-authored
 * failure string passes through the shared `sanitizeFaultDetail` first, so markup,
 * credential assignments and URLs from a provider response body can never reach it
 * (issue #429 GAP-429-3). The historical 400-character bound and the historical
 * empty-case wording are preserved, so existing `GROUND_TRANSFER_*` /
 * `map_driving_route` reason strings are unchanged byte for byte.
 */

import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecutionInput, ToolRunContext } from '@deepseek-ai/dsh-tools'

import { sanitizeFaultDetail } from './provider-detail-sanitize.ts'

export const GROUND_TRANSFER_MODE = 'driving' as const
export const GROUND_TRANSFER_POSITION = 'destination' as const
export const GROUND_TRANSFER_STATIC_MODE = 'taxi' as const
export const GROUND_TRANSFER_STATIC_MODE_MISMATCH = 'ground_transfer_static_mode_mismatch' as const
export const GROUND_TRANSFER_STATIC_PRICE_EVIDENCE = '[静态包:估算]' as const
export const GROUND_TRANSFER_DEFAULT_MAX_AGE_S = 15 * 60
/**
 * Refusal classifications for a provider that contradicts its own request. The
 * two names are the #429 conformance gate's vocabulary verbatim
 * (`RouteErrorCode`), reused here as the `<code>:<direction>:<detail>` reason
 * prefix this module already uses for `map_driving_route_provider_error` and
 * `stale_route_requery_error`. They are duplicated as literals on purpose: the
 * gate must stay free of product callers, so nothing here imports it.
 */
export const GROUND_TRANSFER_ROUTE_MODE_MISMATCH = 'mode_mismatch' as const
export const GROUND_TRANSFER_ROUTE_DIRECTION_MISMATCH = 'direction_mismatch' as const
/**
 * Tolerance for verifying a provider's echoed endpoint against the requested
 * one: 1e-4 degrees ≈ 11 m of latitude. A provider legitimately snaps a
 * coordinate to the nearest routable road node, so an exact string match would
 * refuse honest answers; anything beyond this bound is a different place, not a
 * snap. Deliberately tight — refusing falls back to the static estimate, which
 * is the safe direction.
 */
export const GROUND_TRANSFER_ECHO_TOLERANCE_DEG = 1e-4
const GROUND_TRANSFER_CACHE_LIMIT = 32

export type GroundTransferEvidenceClass =
  | 'public_map_route_estimate'
  | 'static_transfer_estimate'
  | 'none'

export type GroundTransferProvenance =
  | 'map_driving_route'
  | 'static-transfer-pack'
  | 'none'

export type GroundTransferFreshness = 'fresh' | 'cache_hit' | 'fallback' | 'not_attempted'
export type GroundTransferCacheStatus = 'miss' | 'hit' | 'requery' | 'stale' | 'bypass'
export type GroundTransferDirection = 'outbound' | 'return'

export interface GroundTransferCoordinate {
  longitude: number
  latitude: number
}

/**
 * The public result fields exposed by dsh-map-tools' route tool, plus the three
 * OPTIONAL claims an adapter may make about its own answer (#429 GAP-429-1/2).
 *
 * `mode` / `resolvedOrigin` / `resolvedDestination` are the provider's OWN
 * statements about what it actually routed. When present they are verified
 * against the request and a contradiction is refused; when ABSENT the answer is
 * simply unverifiable and today's behaviour is kept byte for byte, because the
 * sole wired provider — the registered `map_driving_route` tool — is driving by
 * construction and echoes no origin/destination. Any future non-driving or
 * address-resolving adapter MUST supply them: the #429 conformance gate
 * (`mode_isolation` / `direction_binding` clauses in
 * `./route-provider-conformance.ts`) already refuses an adapter that does not.
 */
export interface PublicMapDrivingRouteResult {
  provider: string
  distanceM: number
  durationS: number
  polyline?: string
  steps?: readonly Record<string, unknown>[]
  /** the transport mode the provider says it routed (omitted by the wired driving tool) */
  mode?: string
  /** canonical `"lon,lat"` the provider says it routed FROM (omitted by the wired driving tool) */
  resolvedOrigin?: string
  /** canonical `"lon,lat"` the provider says it routed TO (omitted by the wired driving tool) */
  resolvedDestination?: string
}

export interface PublicMapDrivingRouteRequest {
  origin: string
  destination: string
  mode: typeof GROUND_TRANSFER_MODE
}

export interface GroundTransferProviderContext {
  signal: AbortSignal
  execution?: ToolRunContext
}

/** Injected provider shape: it is deliberately the public map-tool result. */
export type GroundTransferProvider = (
  request: PublicMapDrivingRouteRequest,
  context: GroundTransferProviderContext,
) => Promise<PublicMapDrivingRouteResult | undefined>

export interface GroundTransferCacheInfo {
  status: GroundTransferCacheStatus
  ageS: number | null
  asOf: string | null
}

/**
 * A route fact contains only fields actually available at the public tool
 * boundary. `trafficStatus` makes clear that duration is not live traffic.
 */
export interface GroundTransferRouteFact {
  direction: GroundTransferDirection
  origin: GroundTransferCoordinate
  destination: GroundTransferCoordinate
  mode: typeof GROUND_TRANSFER_MODE
  provider: string
  distanceM: number
  durationS: number
  durationMin: number
  /** Host observation/query time; never a provider publication timestamp. */
  asOf: string
  provenance: 'map_driving_route'
  freshness: 'fresh' | 'cache_hit'
  cache: GroundTransferCacheInfo
  evidenceClass: 'public_map_route_estimate'
  trafficStatus: 'not-live-route-estimate'
}

export interface GroundTransferStaticSelection {
  candidateId: string
  transferIndex: number
  staticMode: string
  staticMinutes: number
  staticPriceCny: number
}

export interface GroundTransferDirectionResolution {
  applied: boolean
  direction: GroundTransferDirection
  minutes?: number
  staticMinutes: number
  provenance: GroundTransferProvenance
  asOf: string | null
  freshness: GroundTransferFreshness
  cache: GroundTransferCacheInfo
  evidenceClass: GroundTransferEvidenceClass
  routeFact?: GroundTransferRouteFact
  fallbackReason?: string
}

export interface GroundTransferResolution {
  applied: boolean
  candidateId?: string
  transferIndex?: number
  requestedMode?: string | null
  requestedPosition?: string | null
  staticMode?: string
  staticMinutes?: number
  priceCny?: number
  priceEvidence?: typeof GROUND_TRANSFER_STATIC_PRICE_EVIDENCE
  provenance: GroundTransferProvenance
  asOf: string | null
  freshness: GroundTransferFreshness
  cache: GroundTransferCacheInfo
  evidenceClass: GroundTransferEvidenceClass
  outbound: GroundTransferDirectionResolution
  return: GroundTransferDirectionResolution
  outboundMinutes?: number
  returnMinutes?: number
  fallbackReason?: string
}

/**
 * `destTransfers` always carry the legacy `mode` / `minutes` / `priceCny`
 * fields. The two optional fields below are direction-specific overrides set
 * by the ground-transfer capability when a route fact successfully resolves
 * for that direction. The solver / arithmetic layer reads `minutesOut` for
 * the outbound arrival (ch.outTransfer) and `minutesRet` for the return
 * departure (ch.retTransfer); if either is missing it falls back to the
 * symmetric `minutes` field, preserving byte-for-byte behavior for static
 * inputs and symmetric route inputs.
 */
export interface GroundTransferCandidateLike {
  id: string
  destTransfers: Array<{
    mode: string
    minutes: number
    priceCny: number
    minutesOut?: number
    minutesRet?: number
  }>
}

interface GroundTransferDirectionParts {
  origin: GroundTransferCoordinate
  destination: GroundTransferCoordinate
}

interface GroundTransferRequestParts {
  candidateId: string | null
  transferIndex: number | null
  requestedMode: string | null
  requestedPosition: string | null
  outbound: GroundTransferDirectionParts | null
  ret: GroundTransferDirectionParts | null
  invalidReason?: string
}

interface CompleteGroundTransferDirection {
  direction: GroundTransferDirection
  origin: GroundTransferCoordinate
  destination: GroundTransferCoordinate
}

interface CompleteGroundTransferRequest {
  candidateId: string
  transferIndex: number
  mode: typeof GROUND_TRANSFER_MODE
  position: typeof GROUND_TRANSFER_POSITION
  outbound: CompleteGroundTransferDirection
  ret: CompleteGroundTransferDirection
}

interface GroundTransferCacheEntry {
  fact: GroundTransferRouteFact
  storedAtMs: number
}

interface ResolverContext {
  signal?: AbortSignal
  execution?: ToolRunContext
}

export interface GroundTransferResolver {
  resolve(
    request: CompleteGroundTransferRequest,
    selection: GroundTransferStaticSelection,
    context?: ResolverContext,
  ): Promise<GroundTransferResolution>
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function coordinate(value: unknown): GroundTransferCoordinate | null {
  const record = asRecord(value)
  const longitude = record?.['longitude']
  const latitude = record?.['latitude']
  if (
    typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180
    || typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90
  ) return null
  return { longitude, latitude }
}

function coordinatePair(value: unknown): GroundTransferDirectionParts | null {
  const record = asRecord(value)
  if (!record) return null
  const origin = coordinate(record['origin'])
  const destination = coordinate(record['destination'])
  if (origin === null || destination === null) return null
  return { origin, destination }
}

function coordinateText(value: GroundTransferCoordinate): string {
  return `${String(value.longitude)},${String(value.latitude)}`
}

/** Parse a canonical `"lon,lat"` text back into a validated coordinate. */
function coordinateFromText(value: string): GroundTransferCoordinate | null {
  const parts = value.split(',')
  if (parts.length !== 2) return null
  const [longitudeText, latitudeText] = parts as [string, string]
  if (longitudeText.trim() === '' || latitudeText.trim() === '') return null
  return coordinate({ longitude: Number(longitudeText), latitude: Number(latitudeText) })
}

/**
 * Does a provider's echoed endpoint name the place that was requested?
 *
 * Compared within `GROUND_TRANSFER_ECHO_TOLERANCE_DEG` so a road-node snap still
 * matches. An echo that cannot be parsed is NOT a match: present-but-unverifiable
 * fails closed rather than being accepted as the requested pair.
 */
function sameEndpoint(echoed: string, requested: string): boolean {
  const left = coordinateFromText(echoed)
  const right = coordinateFromText(requested)
  if (left === null || right === null) return false
  return Math.abs(left.longitude - right.longitude) <= GROUND_TRANSFER_ECHO_TOLERANCE_DEG
    && Math.abs(left.latitude - right.latitude) <= GROUND_TRANSFER_ECHO_TOLERANCE_DEG
}

/**
 * Normalize one of the provider's OWN optional claims into a comparable string.
 *
 * Absent (`undefined` / `null`) stays absent — that is the wired driving tool and
 * its behaviour is unchanged. A present-but-unusable value is NOT dropped: it is
 * carried as a non-empty string so the enforcement below can refuse it, because
 * silently dropping a contradicting claim is exactly the relabel this seam
 * forbids. A `{ longitude, latitude }` object is accepted as the canonical text.
 */
function declaredClaim(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value.trim() === '' ? '(blank)' : value.trim()
  const asCoordinate = coordinate(value)
  if (asCoordinate !== null) return coordinateText(asCoordinate)
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

function cacheKey(direction: CompleteGroundTransferDirection): string {
  return JSON.stringify({
    mode: GROUND_TRANSFER_MODE,
    direction: direction.direction,
    origin: direction.origin,
    destination: direction.destination,
  })
}

function nowMs(clock: () => Date): number {
  const value = clock().getTime()
  if (!Number.isFinite(value)) throw new Error('ground-transfer clock returned an invalid date')
  return value
}

function asOf(clock: () => Date): string {
  return new Date(nowMs(clock)).toISOString()
}

/** Historical bound for an exposed provider failure string (unchanged). */
const GROUND_TRANSFER_FAULT_DETAIL_MAX_CHARS = 400

/**
 * Normalize a provider failure into an exposable label. The text reaches the tool
 * result via `exposeGroundTransferEvidence`, so it is scrubbed of markup,
 * credential assignments and URLs before anything else (#429 GAP-429-3); the
 * historical length bound and empty-case wording are preserved.
 */
function safeErrorMessage(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value)
  return sanitizeFaultDetail(message, {
    maxChars: GROUND_TRANSFER_FAULT_DETAIL_MAX_CHARS,
    emptyPlaceholder: 'unknown provider error',
  })
}

/** Bound for a provider-authored claim quoted inside a refusal reason. */
const GROUND_TRANSFER_CLAIM_DETAIL_MAX_CHARS = 120

/**
 * A provider's own claim (mode / echoed endpoint / provider id) is provider-authored
 * text, and a refusal reason reaches the tool result via
 * `exposeGroundTransferEvidence`. Quote it only through the shared sanitizer.
 */
function safeClaim(value: string): string {
  return sanitizeFaultDetail(value, {
    maxChars: GROUND_TRANSFER_CLAIM_DETAIL_MAX_CHARS,
    emptyPlaceholder: '(absent)',
  })
}

function staticCache(status: GroundTransferCacheStatus = 'bypass'): GroundTransferCacheInfo {
  return { status, ageS: null, asOf: null }
}

function notAppliedBase(parts: GroundTransferRequestParts): {
  requestedMode: string | null
  requestedPosition: string | null
  provenance: 'none'
  asOf: null
  freshness: 'not_attempted'
  cache: GroundTransferCacheInfo
  evidenceClass: 'none'
} {
  return {
    requestedMode: parts.requestedMode,
    requestedPosition: parts.requestedPosition,
    provenance: 'none',
    asOf: null,
    freshness: 'not_attempted',
    cache: staticCache('bypass'),
    evidenceClass: 'none',
  }
}

function staticDirectionResolution(
  direction: GroundTransferDirection,
  staticMinutes: number,
  reason: string,
): GroundTransferDirectionResolution {
  return {
    applied: false,
    direction,
    staticMinutes,
    provenance: 'static-transfer-pack',
    asOf: null,
    freshness: 'fallback',
    cache: staticCache('bypass'),
    evidenceClass: 'static_transfer_estimate',
    fallbackReason: reason,
  }
}

function parseRequest(value: unknown): GroundTransferRequestParts {
  const record = asRecord(value)
  if (!record) {
    return {
      candidateId: null,
      transferIndex: null,
      requestedMode: null,
      requestedPosition: null,
      outbound: null,
      ret: null,
      invalidReason: 'ground_transfer_request_invalid:expected an object',
    }
  }

  const candidateId = typeof record['candidate_id'] === 'string' && record['candidate_id'].trim()
    ? record['candidate_id']
    : null
  const transferIndex = Number.isInteger(record['transfer_index']) && Number(record['transfer_index']) >= 0
    ? Number(record['transfer_index'])
    : null
  const requestedMode = typeof record['mode'] === 'string' && record['mode'].trim()
    ? record['mode']
    : null
  const requestedPosition = typeof record['position'] === 'string' && record['position'].trim()
    ? record['position']
    : null

  let outbound: GroundTransferDirectionParts | null = null
  let ret: GroundTransferDirectionParts | null = null
  if (record['outbound'] !== undefined || record['return'] !== undefined) {
    outbound = coordinatePair(record['outbound'])
    ret = coordinatePair(record['return'])
  } else {
    // Legacy single-pair shape: outbound = origin/destination; return = the
    // swapped pair. Keeps pre-#364 payloads behavior-compatible.
    const legacyOrigin = coordinate(record['origin'])
    const legacyDestination = coordinate(record['destination'])
    if (legacyOrigin && legacyDestination) {
      outbound = { origin: legacyOrigin, destination: legacyDestination }
      ret = { origin: legacyDestination, destination: legacyOrigin }
    }
  }

  let invalidReason: string | undefined
  if (candidateId === null) invalidReason = 'ground_transfer_binding_invalid:candidate_id is required'
  else if (transferIndex === null) invalidReason = 'ground_transfer_binding_invalid:transfer_index must be a non-negative integer'
  else if (requestedPosition !== GROUND_TRANSFER_POSITION) invalidReason = `unsupported_ground_transfer_position:${requestedPosition ?? 'unknown'}`
  else if (requestedMode !== GROUND_TRANSFER_MODE) invalidReason = `unsupported_ground_transfer_mode:${requestedMode ?? 'unknown'}`
  else if (outbound === null || ret === null) invalidReason = 'invalid_ground_transfer_coordinates:longitude/latitude must be finite and in range'

  return {
    candidateId,
    transferIndex,
    requestedMode,
    requestedPosition,
    outbound,
    ret,
    invalidReason,
  }
}

function completeRequest(parts: GroundTransferRequestParts): CompleteGroundTransferRequest | null {
  if (
    parts.invalidReason || parts.candidateId === null || parts.transferIndex === null
    || parts.requestedMode !== GROUND_TRANSFER_MODE || parts.requestedPosition !== GROUND_TRANSFER_POSITION
    || parts.outbound === null || parts.ret === null
  ) return null
  return {
    candidateId: parts.candidateId,
    transferIndex: parts.transferIndex,
    mode: GROUND_TRANSFER_MODE,
    position: GROUND_TRANSFER_POSITION,
    outbound: { direction: 'outbound', origin: parts.outbound.origin, destination: parts.outbound.destination },
    ret: { direction: 'return', origin: parts.ret.origin, destination: parts.ret.destination },
  }
}

function parseRouteResult(value: unknown): PublicMapDrivingRouteResult {
  const record = asRecord(value)
  if (!record) throw new Error('map_driving_route returned an invalid public result')
  const provider = record?.['provider']
  const distanceM = record?.['distanceM']
  const durationS = record?.['durationS']
  if (
    typeof provider !== 'string' || provider.trim() === ''
    || typeof distanceM !== 'number' || !Number.isFinite(distanceM) || distanceM < 0
    || typeof durationS !== 'number' || !Number.isFinite(durationS) || durationS < 0
    // A positive distance cannot be covered in zero time: such a response is
    // a self-contradictory route fact, not a credible provider hit. It falls
    // into the explicit provider-miss fallback instead of silently binding
    // zero minutes into the solver.
    || (distanceM > 0 && durationS === 0)
  ) throw new Error('map_driving_route returned an invalid public result')
  // The provider's own claims are CARRIED, never dropped: `routeClaimRefusal`
  // below checks them when they exist. Absent stays absent (the wired driving
  // tool sends none of the three), and re-parsing an already-parsed result is
  // idempotent because the carried values are already canonical.
  const declaredMode = declaredClaim(record['mode'])
  const resolvedOrigin = declaredClaim(record['resolvedOrigin'])
  const resolvedDestination = declaredClaim(record['resolvedDestination'])
  return {
    provider,
    distanceM,
    durationS,
    ...(typeof record['polyline'] === 'string' ? { polyline: record['polyline'] } : {}),
    ...(Array.isArray(record['steps']) ? { steps: record['steps'] as readonly Record<string, unknown>[] } : {}),
    ...(declaredMode !== undefined ? { mode: declaredMode } : {}),
    ...(resolvedOrigin !== undefined ? { resolvedOrigin } : {}),
    ...(resolvedDestination !== undefined ? { resolvedDestination } : {}),
  }
}

/**
 * Verify the provider's OWN claims against the request for this direction, and
 * return a typed refusal when one contradicts it (#429 GAP-429-1/2).
 *
 * ABSENT = UNVERIFIABLE, and absent is ACCEPTED — not because an unverified
 * answer is as good as a verified one, but because the only wired provider (the
 * registered `map_driving_route` tool) is driving by construction and echoes no
 * origin/destination, so for it nothing changes byte for byte. Any future
 * non-driving or address-resolving adapter must supply these fields; the #429
 * conformance gate already refuses an adapter that does not.
 *
 * PRESENT and contradicting = REFUSAL. The caller falls back to the static
 * transfer estimate with its original price label, so a mislabelled or
 * misrouted answer never reaches the solver.
 */
function routeClaimRefusal(
  direction: CompleteGroundTransferDirection,
  request: PublicMapDrivingRouteRequest,
  route: PublicMapDrivingRouteResult,
): { code: string; detail: string } | null {
  if (route.mode !== undefined && route.mode !== GROUND_TRANSFER_MODE) {
    return {
      code: GROUND_TRANSFER_ROUTE_MODE_MISMATCH,
      detail: `provider ${safeClaim(route.provider)} returned mode '${safeClaim(route.mode)}' for a '${GROUND_TRANSFER_MODE}' request; a declared mode is never relabelled as ${GROUND_TRANSFER_MODE}; static transfer preserved`,
    }
  }
  const { resolvedOrigin, resolvedDestination } = route
  if (resolvedOrigin === undefined && resolvedDestination === undefined) return null
  if (
    (resolvedOrigin !== undefined && !sameEndpoint(resolvedOrigin, request.origin))
    || (resolvedDestination !== undefined && !sameEndpoint(resolvedDestination, request.destination))
  ) {
    return {
      code: GROUND_TRANSFER_ROUTE_DIRECTION_MISMATCH,
      detail: `provider ${safeClaim(route.provider)} resolved ${safeClaim(resolvedOrigin ?? '(absent)')}>${safeClaim(resolvedDestination ?? '(absent)')} but the ${direction.direction} request was ${request.origin}>${request.destination}; direction binding is verified against the response, not assumed from the request; static transfer preserved`,
    }
  }
  return null
}

function buildRouteFact(
  direction: CompleteGroundTransferDirection,
  route: PublicMapDrivingRouteResult,
  clock: () => Date,
  cache: GroundTransferCacheInfo,
): GroundTransferRouteFact {
  return {
    direction: direction.direction,
    origin: direction.origin,
    destination: direction.destination,
    mode: GROUND_TRANSFER_MODE,
    provider: route.provider,
    distanceM: route.distanceM,
    durationS: route.durationS,
    durationMin: Math.round(route.durationS / 60),
    asOf: asOf(clock),
    provenance: 'map_driving_route',
    freshness: cache.status === 'hit' ? 'cache_hit' : 'fresh',
    cache,
    evidenceClass: 'public_map_route_estimate',
    trafficStatus: 'not-live-route-estimate',
  }
}

function selectionFor<T extends GroundTransferCandidateLike>(
  candidates: readonly T[],
  parts: GroundTransferRequestParts,
): { candidateIndex: number; selection: GroundTransferStaticSelection } | null {
  if (parts.candidateId === null || parts.transferIndex === null) return null
  const matching = candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => candidate.id === parts.candidateId)
  if (matching.length !== 1) return null
  const match = matching[0]!
  const transfer = match.candidate.destTransfers[parts.transferIndex]
  if (!transfer || typeof transfer.mode !== 'string' || !Number.isFinite(transfer.minutes) || transfer.minutes < 0 || !Number.isFinite(transfer.priceCny) || transfer.priceCny < 0) return null
  return {
    candidateIndex: match.index,
    selection: {
      candidateId: parts.candidateId,
      transferIndex: parts.transferIndex,
      staticMode: transfer.mode,
      staticMinutes: transfer.minutes,
      staticPriceCny: transfer.priceCny,
    },
  }
}

async function resolveDirection(
  direction: CompleteGroundTransferDirection,
  staticMinutes: number,
  provider: GroundTransferProvider,
  clock: () => Date,
  cache: Map<string, GroundTransferCacheEntry>,
  maxEntries: number,
  context: ResolverContext,
): Promise<GroundTransferDirectionResolution> {
  const key = cacheKey(direction)
  const currentMs = nowMs(clock)
  const cached = cache.get(key)
  if (cached) {
    const ageS = Math.max(0, currentMs - cached.storedAtMs) / 1000
    if (ageS <= GROUND_TRANSFER_DEFAULT_MAX_AGE_S) {
      const hitCache: GroundTransferCacheInfo = { status: 'hit', ageS, asOf: cached.fact.asOf }
      const hitFact: GroundTransferRouteFact = { ...cached.fact, freshness: 'cache_hit', cache: hitCache }
      return {
        applied: true,
        direction: direction.direction,
        minutes: hitFact.durationMin,
        staticMinutes,
        provenance: 'map_driving_route',
        asOf: hitFact.asOf,
        freshness: 'cache_hit',
        cache: hitCache,
        evidenceClass: 'public_map_route_estimate',
        routeFact: hitFact,
      }
    }
  }

  const requestForProvider: PublicMapDrivingRouteRequest = {
    origin: coordinateText(direction.origin),
    destination: coordinateText(direction.destination),
    mode: GROUND_TRANSFER_MODE,
  }
  try {
    const raw = await provider(requestForProvider, {
      signal: context.signal ?? new AbortController().signal,
      execution: context.execution,
    })
    const route = parseRouteResult(raw)
    const refusal = routeClaimRefusal(direction, requestForProvider, route)
    if (refusal !== null) {
      // Fail closed: no fact is built and nothing is written to the cache, so a
      // refused answer can never be served later as a cache hit. The static
      // minutes, price and `[静态包:估算]` label are left untouched.
      return {
        applied: false,
        direction: direction.direction,
        staticMinutes,
        provenance: 'static-transfer-pack',
        asOf: null,
        freshness: 'fallback',
        cache: staticCache(cached ? 'stale' : 'bypass'),
        evidenceClass: 'static_transfer_estimate',
        fallbackReason: `${refusal.code}:${direction.direction}:${refusal.detail}`,
      }
    }
    const cacheInfo: GroundTransferCacheInfo = {
      status: cached ? 'requery' : 'miss',
      ageS: 0,
      asOf: null,
    }
    const fact = buildRouteFact(direction, route, clock, cacheInfo)
    cacheInfo.asOf = fact.asOf
    const entry: GroundTransferCacheEntry = { fact, storedAtMs: currentMs }
    if (cache.size >= maxEntries && !cache.has(key)) {
      const oldest = cache.keys().next().value
      if (typeof oldest === 'string') cache.delete(oldest)
    }
    cache.set(key, entry)
    return {
      applied: true,
      direction: direction.direction,
      minutes: fact.durationMin,
      staticMinutes,
      provenance: 'map_driving_route',
      asOf: fact.asOf,
      freshness: 'fresh',
      cache: cacheInfo,
      evidenceClass: 'public_map_route_estimate',
      routeFact: fact,
    }
  } catch (error) {
    const detail = safeErrorMessage(error)
    return {
      applied: false,
      direction: direction.direction,
      staticMinutes,
      provenance: 'static-transfer-pack',
      asOf: null,
      freshness: 'fallback',
      cache: staticCache(cached ? 'stale' : 'bypass'),
      evidenceClass: 'static_transfer_estimate',
      fallbackReason: cached
        ? `stale_route_requery_error:${direction.direction}:${detail}`
        : `map_driving_route_provider_error:${direction.direction}:${detail}`,
    }
  }
}

export function createGroundTransferResolver(options: {
  provider: GroundTransferProvider
  clock?: () => Date
  maxEntries?: number
}): GroundTransferResolver {
  const clock = options.clock ?? (() => new Date())
  const maxEntries = Number.isInteger(options.maxEntries) && Number(options.maxEntries) > 0
    ? Number(options.maxEntries)
    : GROUND_TRANSFER_CACHE_LIMIT
  const cache = new Map<string, GroundTransferCacheEntry>()

  return {
    async resolve(request, selection, context = {}) {
      const [outbound, ret] = await Promise.all([
        resolveDirection(request.outbound, selection.staticMinutes, options.provider, clock, cache, maxEntries, context),
        resolveDirection(request.ret, selection.staticMinutes, options.provider, clock, cache, maxEntries, context),
      ])

      const applied = outbound.applied || ret.applied
      // Aggregate fields are a summary only: per-direction objects above are
      // the authoritative per-direction record. A full cache hit keeps the
      // legacy aggregate semantics ('cache_hit'), a re-query keeps 'requery'.
      const aggregateProvenance: GroundTransferProvenance = applied ? 'map_driving_route' : 'static-transfer-pack'
      const aggregateEvidenceClass: GroundTransferEvidenceClass = applied ? 'public_map_route_estimate' : 'static_transfer_estimate'
      const aggregateFreshness: GroundTransferFreshness = !applied
        ? 'fallback'
        : outbound.freshness === 'fresh' || ret.freshness === 'fresh'
          ? 'fresh'
          : 'cache_hit'
      const statuses = [outbound.cache.status, ret.cache.status]
      const aggregateCache: GroundTransferCacheInfo = !applied
        ? staticCache('bypass')
        : {
            status: statuses.includes('hit') ? 'hit' : statuses.includes('requery') ? 'requery' : 'miss',
            ageS: 0,
            asOf: null,
          }
      const aggregateAsOf = applied ? (outbound.asOf ?? ret.asOf) : null

      const resolution: GroundTransferResolution = {
        applied,
        candidateId: selection.candidateId,
        transferIndex: selection.transferIndex,
        requestedMode: request.mode,
        requestedPosition: request.position,
        staticMode: selection.staticMode,
        staticMinutes: selection.staticMinutes,
        priceCny: selection.staticPriceCny,
        priceEvidence: GROUND_TRANSFER_STATIC_PRICE_EVIDENCE,
        provenance: aggregateProvenance,
        asOf: aggregateAsOf,
        freshness: aggregateFreshness,
        cache: aggregateCache,
        evidenceClass: aggregateEvidenceClass,
        outbound,
        return: ret,
      }
      if (outbound.applied) resolution.outboundMinutes = outbound.minutes
      if (ret.applied) resolution.returnMinutes = ret.minutes
      if (!applied) {
        resolution.fallbackReason = `both_directions_failed:${outbound.fallbackReason ?? 'unknown'};${ret.fallbackReason ?? 'unknown'}`
      }
      return resolution
    },
  }
}

/**
 * Delegate through the registered public map tool. The dsh-tools types expose
 * nested execution explicitly, so the current root/agent/signal are carried
 * into the sub-dispatch instead of calling a private map client.
 */
export function createPublicMapDrivingRouteProvider(ctx: Context): GroundTransferProvider {
  return async (request, context) => {
    const execution = context.execution
    if (!execution) throw new Error('GROUND_TRANSFER_NESTED_EXECUTION_UNSUPPORTED: current tool execution context is unavailable')
    const tools = ctx.tools
    if (typeof tools?.execute !== 'function' || typeof tools?.get !== 'function') {
      throw new Error('GROUND_TRANSFER_NESTED_EXECUTION_UNSUPPORTED: host must expose dsh-tools ToolRuntime.execute/get')
    }
    if (!tools.get('map_driving_route', execution.agent)) {
      throw new Error('GROUND_TRANSFER_PUBLIC_MAP_TOOL_UNAVAILABLE: map_driving_route is not registered in the current tool scope')
    }
    const nested: ToolExecutionInput = {
      callId: ToolCallId(`${String(execution.callId)}:ground-transfer`),
      rootCallId: execution.rootCallId,
      name: 'map_driving_route',
      arguments: { origin: request.origin, destination: request.destination },
      ...(execution.agent !== undefined ? { agent: execution.agent } : {}),
      parent: execution.token,
      signal: execution.signal,
    }
    const result = await tools.execute(nested)
    if (result.isError) throw new Error(`map_driving_route failed: ${result.error.message}`)
    return parseRouteResult(result.value)
  }
}

export interface GroundTransferPayloadResult<T extends GroundTransferCandidateLike> {
  candidates: T[]
  resolution: GroundTransferResolution
}

/** Resolve and patch exactly one named transfer position before solver entry. */
export async function resolveGroundTransferPayload<T extends GroundTransferCandidateLike>(
  rawRequest: unknown,
  candidates: readonly T[],
  resolver: GroundTransferResolver,
  context?: ResolverContext,
): Promise<GroundTransferPayloadResult<T>> {
  const parts = parseRequest(rawRequest)
  const bound = selectionFor(candidates, parts)
  if (!bound) {
    const base = notAppliedBase(parts)
    return {
      candidates: [...candidates],
      resolution: {
        ...base,
        applied: false,
        ...(parts.candidateId !== null ? { candidateId: parts.candidateId } : {}),
        ...(parts.transferIndex !== null ? { transferIndex: parts.transferIndex } : {}),
        outbound: staticDirectionResolution('outbound', Number.NaN, 'ground_transfer_binding_mismatch'),
        return: staticDirectionResolution('return', Number.NaN, 'ground_transfer_binding_mismatch'),
        fallbackReason: 'ground_transfer_binding_mismatch: candidate_id and transfer_index must identify exactly one valid static transfer',
      },
    }
  }

  const complete = completeRequest(parts)
  if (!complete) {
    return {
      candidates: [...candidates],
      resolution: {
        applied: false,
        candidateId: bound.selection.candidateId,
        transferIndex: bound.selection.transferIndex,
        requestedMode: parts.requestedMode,
        requestedPosition: parts.requestedPosition,
        staticMode: bound.selection.staticMode,
        staticMinutes: bound.selection.staticMinutes,
        priceCny: bound.selection.staticPriceCny,
        priceEvidence: GROUND_TRANSFER_STATIC_PRICE_EVIDENCE,
        provenance: 'static-transfer-pack',
        asOf: null,
        freshness: 'fallback',
        cache: staticCache('bypass'),
        evidenceClass: 'static_transfer_estimate',
        outbound: staticDirectionResolution('outbound', bound.selection.staticMinutes, parts.invalidReason ?? 'ground_transfer_request_invalid'),
        return: staticDirectionResolution('return', bound.selection.staticMinutes, parts.invalidReason ?? 'ground_transfer_request_invalid'),
        fallbackReason: `${parts.invalidReason ?? 'ground_transfer_request_invalid'}; static transfer minutes and price preserved`,
      },
    }
  }

  if (bound.selection.staticMode !== GROUND_TRANSFER_STATIC_MODE) {
    const reason = `${GROUND_TRANSFER_STATIC_MODE_MISMATCH}: mode=${bound.selection.staticMode}; only taxi accepts a driving route; static transfer preserved`
    return {
      candidates: [...candidates],
      resolution: {
        applied: false,
        candidateId: bound.selection.candidateId,
        transferIndex: bound.selection.transferIndex,
        requestedMode: parts.requestedMode,
        requestedPosition: parts.requestedPosition,
        staticMode: bound.selection.staticMode,
        staticMinutes: bound.selection.staticMinutes,
        priceCny: bound.selection.staticPriceCny,
        priceEvidence: GROUND_TRANSFER_STATIC_PRICE_EVIDENCE,
        provenance: 'static-transfer-pack',
        asOf: null,
        freshness: 'not_attempted',
        cache: staticCache('bypass'),
        evidenceClass: 'static_transfer_estimate',
        outbound: staticDirectionResolution('outbound', bound.selection.staticMinutes, reason),
        return: staticDirectionResolution('return', bound.selection.staticMinutes, reason),
        fallbackReason: reason,
      },
    }
  }

  const resolution = await resolver.resolve(complete, bound.selection, context)
  if (!resolution.applied) {
    return { candidates: [...candidates], resolution }
  }
  const patched = candidates.map((candidate, candidateIndex) => {
    if (candidateIndex !== bound.candidateIndex) return candidate
    const destTransfers = candidate.destTransfers.map((transfer, transferIndex) => {
      if (transferIndex !== bound.selection.transferIndex) return transfer
      const next: Record<string, unknown> = { ...transfer }
      if (resolution.outboundMinutes !== undefined) next['minutesOut'] = resolution.outboundMinutes
      if (resolution.returnMinutes !== undefined) next['minutesRet'] = resolution.returnMinutes
      return next as typeof transfer
    })
    return { ...candidate, destTransfers } as T
  })
  return { candidates: patched, resolution }
}

export function exposeGroundTransferEvidence(
  result: Record<string, unknown>,
  resolution: GroundTransferResolution,
): Record<string, unknown> {
  const verdicts = Array.isArray(result['verdicts'])
    ? (result['verdicts'] as Array<Record<string, unknown>>).map(verdict =>
      resolution.candidateId !== undefined && verdict['candidate_id'] === resolution.candidateId
        ? { ...verdict, transfer_evidence: resolution }
        : verdict,
    )
    : result['verdicts']
  return { ...result, verdicts, ground_transfer: resolution }
}
