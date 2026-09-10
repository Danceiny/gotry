/**
 * Bounded ground-transfer seam for explicit airport/station coordinates.
 *
 * This capability owns only the boundary between a public
 * `map_driving_route` result and the deterministic candidate input. It never
 * calls a map client directly, never writes shared state, and never supplies
 * a price: the selected candidate transfer keeps its static `priceCny`.
 */

import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecutionInput, ToolRunContext } from '@deepseek-ai/dsh-tools'

export const GROUND_TRANSFER_MODE = 'driving' as const
export const GROUND_TRANSFER_POSITION = 'destination' as const
export const GROUND_TRANSFER_STATIC_MODE = 'taxi' as const
export const GROUND_TRANSFER_STATIC_MODE_MISMATCH = 'ground_transfer_static_mode_mismatch' as const
export const GROUND_TRANSFER_STATIC_PRICE_EVIDENCE = '[静态包:估算]' as const
export const GROUND_TRANSFER_DEFAULT_MAX_AGE_S = 15 * 60
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

export interface GroundTransferCoordinate {
  longitude: number
  latitude: number
}

/** The public result fields exposed by dsh-map-tools' route tool. */
export interface PublicMapDrivingRouteResult {
  provider: string
  distanceM: number
  durationS: number
  polyline?: string
  steps?: readonly Record<string, unknown>[]
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

export interface GroundTransferResolution {
  applied: boolean
  candidateId?: string
  transferIndex?: number
  requestedMode?: string | null
  requestedPosition?: string | null
  staticMode?: string
  minutes?: number
  staticMinutes?: number
  priceCny?: number
  priceEvidence?: typeof GROUND_TRANSFER_STATIC_PRICE_EVIDENCE
  provenance: GroundTransferProvenance
  asOf: string | null
  freshness: GroundTransferFreshness
  cache: GroundTransferCacheInfo
  evidenceClass: GroundTransferEvidenceClass
  routeFact?: GroundTransferRouteFact
  fallbackReason?: string
}

export interface GroundTransferCandidateLike {
  id: string
  destTransfers: Array<{
    mode: string
    minutes: number
    priceCny: number
  }>
}

interface GroundTransferRequestParts {
  candidateId: string | null
  transferIndex: number | null
  requestedMode: string | null
  requestedPosition: string | null
  origin: GroundTransferCoordinate | null
  destination: GroundTransferCoordinate | null
  invalidReason?: string
}

interface CompleteGroundTransferRequest {
  candidateId: string
  transferIndex: number
  mode: typeof GROUND_TRANSFER_MODE
  position: typeof GROUND_TRANSFER_POSITION
  origin: GroundTransferCoordinate
  destination: GroundTransferCoordinate
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

function coordinateText(value: GroundTransferCoordinate): string {
  return `${String(value.longitude)},${String(value.latitude)}`
}

function cacheKey(request: Pick<CompleteGroundTransferRequest, 'origin' | 'destination'>): string {
  return JSON.stringify({
    mode: GROUND_TRANSFER_MODE,
    origin: request.origin,
    destination: request.destination,
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

function safeErrorMessage(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value)
  return message.replace(/[\r\n]+/g, ' ').trim().slice(0, 400) || 'unknown provider error'
}

function staticCache(status: GroundTransferCacheStatus = 'bypass'): GroundTransferCacheInfo {
  return { status, ageS: null, asOf: null }
}

function appliedBase(selection: GroundTransferStaticSelection, parts: GroundTransferRequestParts): GroundTransferResolution {
  return {
    applied: true,
    candidateId: selection.candidateId,
    transferIndex: selection.transferIndex,
    requestedMode: parts.requestedMode,
    requestedPosition: parts.requestedPosition,
    staticMode: selection.staticMode,
    staticMinutes: selection.staticMinutes,
    priceCny: selection.staticPriceCny,
    priceEvidence: GROUND_TRANSFER_STATIC_PRICE_EVIDENCE,
    provenance: 'static-transfer-pack',
    asOf: null,
    freshness: 'fallback',
    cache: staticCache(),
    evidenceClass: 'static_transfer_estimate',
  }
}

function notApplied(
  parts: GroundTransferRequestParts,
  reason: string,
  selection?: GroundTransferStaticSelection,
): GroundTransferResolution {
  const resolution: GroundTransferResolution = {
    applied: false,
    ...(parts.candidateId !== null ? { candidateId: parts.candidateId } : {}),
    ...(parts.transferIndex !== null ? { transferIndex: parts.transferIndex } : {}),
    requestedMode: parts.requestedMode,
    requestedPosition: parts.requestedPosition,
    provenance: 'none',
    asOf: null,
    freshness: 'not_attempted',
    cache: staticCache('bypass'),
    evidenceClass: 'none',
    fallbackReason: reason,
  }
  if (selection) {
    resolution.candidateId = selection.candidateId
    resolution.transferIndex = selection.transferIndex
    resolution.staticMode = selection.staticMode
    resolution.staticMinutes = selection.staticMinutes
    resolution.priceCny = selection.staticPriceCny
    resolution.priceEvidence = GROUND_TRANSFER_STATIC_PRICE_EVIDENCE
    resolution.provenance = 'static-transfer-pack'
    resolution.evidenceClass = 'static_transfer_estimate'
  }
  return resolution
}

function parseRequest(value: unknown): GroundTransferRequestParts {
  const record = asRecord(value)
  if (!record) {
    return {
      candidateId: null,
      transferIndex: null,
      requestedMode: null,
      requestedPosition: null,
      origin: null,
      destination: null,
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
  const origin = coordinate(record['origin'])
  const destination = coordinate(record['destination'])

  let invalidReason: string | undefined
  if (candidateId === null) invalidReason = 'ground_transfer_binding_invalid:candidate_id is required'
  else if (transferIndex === null) invalidReason = 'ground_transfer_binding_invalid:transfer_index must be a non-negative integer'
  else if (requestedPosition !== GROUND_TRANSFER_POSITION) invalidReason = `unsupported_ground_transfer_position:${requestedPosition ?? 'unknown'}`
  else if (requestedMode !== GROUND_TRANSFER_MODE) invalidReason = `unsupported_ground_transfer_mode:${requestedMode ?? 'unknown'}`
  else if (origin === null || destination === null) invalidReason = 'invalid_ground_transfer_coordinates:longitude/latitude must be finite and in range'

  return {
    candidateId,
    transferIndex,
    requestedMode,
    requestedPosition,
    origin,
    destination,
    invalidReason,
  }
}

function completeRequest(parts: GroundTransferRequestParts): CompleteGroundTransferRequest | null {
  if (
    parts.invalidReason || parts.candidateId === null || parts.transferIndex === null
    || parts.requestedMode !== GROUND_TRANSFER_MODE || parts.requestedPosition !== GROUND_TRANSFER_POSITION
    || parts.origin === null || parts.destination === null
  ) return null
  return {
    candidateId: parts.candidateId,
    transferIndex: parts.transferIndex,
    mode: GROUND_TRANSFER_MODE,
    position: GROUND_TRANSFER_POSITION,
    origin: parts.origin,
    destination: parts.destination,
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
  ) throw new Error('map_driving_route returned an invalid public result')
  return {
    provider,
    distanceM,
    durationS,
    ...(typeof record['polyline'] === 'string' ? { polyline: record['polyline'] } : {}),
    ...(Array.isArray(record['steps']) ? { steps: record['steps'] as readonly Record<string, unknown>[] } : {}),
  }
}

function buildRouteFact(
  request: CompleteGroundTransferRequest,
  route: PublicMapDrivingRouteResult,
  clock: () => Date,
  cache: GroundTransferCacheInfo,
): GroundTransferRouteFact {
  return {
    origin: request.origin,
    destination: request.destination,
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

function routeResolution(
  selection: GroundTransferStaticSelection,
  parts: GroundTransferRequestParts,
  fact: GroundTransferRouteFact,
): GroundTransferResolution {
  return {
    ...appliedBase(selection, parts),
    minutes: fact.durationMin,
    provenance: fact.provenance,
    asOf: fact.asOf,
    freshness: fact.freshness,
    cache: fact.cache,
    evidenceClass: fact.evidenceClass,
    routeFact: fact,
  }
}

function staticFallback(
  selection: GroundTransferStaticSelection,
  parts: GroundTransferRequestParts,
  reason: string,
  cacheStatus: GroundTransferCacheStatus = 'bypass',
): GroundTransferResolution {
  return {
    ...appliedBase(selection, parts),
    minutes: selection.staticMinutes,
    cache: staticCache(cacheStatus),
    fallbackReason: `${reason}; static transfer minutes and price preserved`,
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
      const parts: GroundTransferRequestParts = {
        candidateId: request.candidateId,
        transferIndex: request.transferIndex,
        requestedMode: request.mode,
        requestedPosition: request.position,
        origin: request.origin,
        destination: request.destination,
      }
      const key = cacheKey(request)
      const currentMs = nowMs(clock)
      const cached = cache.get(key)
      if (cached) {
        const ageS = Math.max(0, currentMs - cached.storedAtMs) / 1000
        if (ageS <= GROUND_TRANSFER_DEFAULT_MAX_AGE_S) {
          const hitCache: GroundTransferCacheInfo = { status: 'hit', ageS, asOf: cached.fact.asOf }
          const hitFact = { ...cached.fact, freshness: 'cache_hit' as const, cache: hitCache }
          return routeResolution(selection, parts, hitFact)
        }
      }

      const requestForProvider: PublicMapDrivingRouteRequest = {
        origin: coordinateText(request.origin),
        destination: coordinateText(request.destination),
        mode: GROUND_TRANSFER_MODE,
      }
      try {
        const raw = await options.provider(requestForProvider, {
          signal: context.signal ?? new AbortController().signal,
          execution: context.execution,
        })
        const route = parseRouteResult(raw)
        const cacheInfo: GroundTransferCacheInfo = {
          status: cached ? 'requery' : 'miss',
          ageS: 0,
          asOf: null,
        }
        const fact = buildRouteFact(request, route, clock, cacheInfo)
        cacheInfo.asOf = fact.asOf
        const entry: GroundTransferCacheEntry = { fact, storedAtMs: currentMs }
        if (cache.size >= maxEntries && !cache.has(key)) {
          const oldest = cache.keys().next().value
          if (typeof oldest === 'string') cache.delete(oldest)
        }
        cache.set(key, entry)
        return routeResolution(selection, parts, { ...fact, cache: cacheInfo })
      } catch (error) {
        const detail = safeErrorMessage(error)
        return staticFallback(
          selection,
          parts,
          cached ? `stale_route_requery_error:${detail}` : `map_driving_route_provider_error:${detail}`,
          cached ? 'stale' : 'bypass',
        )
      }
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
    return { candidates: [...candidates], resolution: notApplied(parts, 'ground_transfer_binding_mismatch: candidate_id and transfer_index must identify exactly one valid static transfer') }
  }

  const complete = completeRequest(parts)
  if (!complete) {
    return {
      candidates: [...candidates],
      resolution: staticFallback(bound.selection, parts, parts.invalidReason ?? 'ground_transfer_request_invalid'),
    }
  }

  if (bound.selection.staticMode !== GROUND_TRANSFER_STATIC_MODE) {
    return {
      candidates: [...candidates],
      resolution: notApplied(
        parts,
        `${GROUND_TRANSFER_STATIC_MODE_MISMATCH}: mode=${bound.selection.staticMode}; only taxi accepts a driving route; static transfer preserved`,
        bound.selection,
      ),
    }
  }

  const resolution = await resolver.resolve(complete, bound.selection, context)
  if (!resolution.applied || resolution.minutes === undefined) {
    return { candidates: [...candidates], resolution }
  }
  const patched = candidates.map((candidate, candidateIndex) => {
    if (candidateIndex !== bound.candidateIndex) return candidate
    const destTransfers = candidate.destTransfers.map((transfer, transferIndex) =>
      transferIndex === bound.selection.transferIndex ? { ...transfer, minutes: resolution.minutes } : transfer,
    )
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
