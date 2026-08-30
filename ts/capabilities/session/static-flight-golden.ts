import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { SessionComparableRecord, SessionComparableSegment } from './benchmark.ts'

export type GoldenSource = 'manual' | 'flyai' | 'static'

export interface StaticFlightRouteLeg {
  from_iata: string
  to_iata: string
  carrier_codes: string[]
}

export interface StaticFlightRoute {
  query_id: string
  from_city: string
  to_city: string
  route_kind: 'direct' | 'transfer'
  legs: StaticFlightRouteLeg[]
}

export interface StaticFlightSnapshot {
  schema_version: 'sf-static-routes.v1'
  source: {
    name: string
    url: string
    revision: string
    license: string
    retrieved_at: string
    limitations: string[]
  }
  routes: StaticFlightRoute[]
}

export interface StaticGoldenResolution {
  requested_source: 'static'
  effective_source: 'static-openflights+manual-band' | 'manual-golden'
  record: SessionComparableRecord
  fallback_reason?: string
  estimated_fields: string[]
  provenance: {
    route_source: string
    route_revision: string
    route_license: string
    band_source: 'sf-golden-manifest.json'
  }
}

export function parseGoldenSource(args: string[]): GoldenSource {
  const raw = args.find((arg) => arg.startsWith('--golden='))?.slice('--golden='.length) ?? 'manual'
  if (raw === 'manual' || raw === 'flyai' || raw === 'static') return raw
  throw new Error(`不支持的 golden vendor: ${raw}`)
}

export function loadStaticFlightSnapshot(
  path = join(import.meta.dirname, '..', '..', 'data', 'sf-static-routes.json'),
): StaticFlightSnapshot {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
  if (!isRecord(parsed) || parsed.schema_version !== 'sf-static-routes.v1') {
    throw new Error(`invalid static snapshot schema_version: ${String(isRecord(parsed) ? parsed.schema_version : undefined)}`)
  }
  const source = parsed.source
  if (!isRecord(source)
    || !['name', 'url', 'revision', 'license', 'retrieved_at'].every((key) => typeof source[key] === 'string')
    || !Array.isArray(source.limitations)
    || !source.limitations.every((item) => typeof item === 'string')) {
    throw new Error('invalid static snapshot source')
  }
  if (!Array.isArray(parsed.routes) || !parsed.routes.every(isStaticFlightRoute)) {
    throw new Error('invalid static snapshot routes')
  }
  return parsed as unknown as StaticFlightSnapshot
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStaticFlightRoute(value: unknown): boolean {
  if (!isRecord(value)
    || typeof value.query_id !== 'string'
    || typeof value.from_city !== 'string'
    || typeof value.to_city !== 'string'
    || (value.route_kind !== 'direct' && value.route_kind !== 'transfer')
    || !Array.isArray(value.legs)
    || value.legs.length === 0) return false
  return value.legs.every((leg) => isRecord(leg)
    && typeof leg.from_iata === 'string'
    && typeof leg.to_iata === 'string'
    && Array.isArray(leg.carrier_codes)
    && leg.carrier_codes.every((carrier) => typeof carrier === 'string'))
}

function provenance(snapshot?: StaticFlightSnapshot): StaticGoldenResolution['provenance'] {
  return {
    route_source: snapshot?.source.url ?? '',
    route_revision: snapshot?.source.revision ?? '',
    route_license: snapshot?.source.license ?? '',
    band_source: 'sf-golden-manifest.json',
  }
}

function formatWithOffset(timestampMs: number, offset: string): string {
  const sign = offset.startsWith('-') ? -1 : 1
  const [hours, minutes] = offset.slice(1).split(':').map(Number)
  const offsetMinutes = sign * ((hours ?? 0) * 60 + (minutes ?? 0))
  const local = new Date(timestampMs + offsetMinutes * 60_000).toISOString().slice(0, 19)
  return `${local}${offset}`
}

function buildSegments(
  query: { from: string; to: string },
  route: StaticFlightRoute,
  manualSegment: SessionComparableSegment,
): SessionComparableSegment[] | null {
  if (route.route_kind === 'direct' && route.legs.length === 1) {
    return [{
      from: query.from,
      to: query.to,
      departure_at: manualSegment.departure_at,
      arrival_at: manualSegment.arrival_at,
      transport_number: `${route.legs[0]!.carrier_codes[0]}-STATIC`,
    }]
  }
  if (route.route_kind !== 'transfer' || route.legs.length !== 2) return null
  const departureMs = Date.parse(manualSegment.departure_at)
  const arrivalMs = Date.parse(manualSegment.arrival_at)
  if (!Number.isFinite(departureMs) || !Number.isFinite(arrivalMs) || arrivalMs <= departureMs) return null
  const offset = manualSegment.departure_at.match(/([+-]\d{2}:\d{2})$/)?.[1] ?? '+08:00'
  const totalMinutes = Math.floor((arrivalMs - departureMs) / 60_000)
  if (totalMinutes < 90) return null
  const layoverMinutes = Math.min(60, Math.floor(totalMinutes / 3))
  const travelMinutes = totalMinutes - layoverMinutes
  const firstTravelMinutes = Math.floor(travelMinutes / 2)
  const secondDepartureMs = arrivalMs - (travelMinutes - firstTravelMinutes) * 60_000
  const middle = route.legs[0]!.to_iata
  return [
    {
      from: query.from,
      to: middle,
      departure_at: manualSegment.departure_at,
      arrival_at: formatWithOffset(departureMs + firstTravelMinutes * 60_000, offset),
      transport_number: `${route.legs[0]!.carrier_codes[0]}-STATIC`,
    },
    {
      from: middle,
      to: query.to,
      departure_at: formatWithOffset(secondDepartureMs, offset),
      arrival_at: manualSegment.arrival_at,
      transport_number: `${route.legs[1]!.carrier_codes[0]}-STATIC`,
    },
  ]
}

export function resolveStaticGolden(input: {
  query: { id: string; from: string; to: string; date: string }
  manualRecord: SessionComparableRecord
  snapshot?: StaticFlightSnapshot
  snapshotError?: string
  warn?: (message: string) => void
}): StaticGoldenResolution {
  const route = input.snapshot?.routes.find((candidate) => candidate.query_id === input.query.id)
  let fallbackReason: string | undefined
  if (input.snapshotError) {
    fallbackReason = `static snapshot unavailable: ${input.snapshotError}`
  } else if (!route) {
    fallbackReason = `static route missing for ${input.query.id}`
  } else if (route.from_city !== input.query.from || route.to_city !== input.query.to) {
    fallbackReason = `static route mismatch for ${input.query.id}`
  } else if (route.legs.some((leg) => leg.carrier_codes.length === 0)) {
    fallbackReason = `static carrier coverage missing for ${input.query.id}`
  }

  const manualSegment = input.manualRecord.route_segments[0]
  const segments = !fallbackReason && route && manualSegment
    ? buildSegments(input.query, route, manualSegment)
    : null
  if (!fallbackReason && !segments) fallbackReason = `static route cannot form comparable record for ${input.query.id}`

  if (fallbackReason) {
    input.warn?.(`[sf-live-benchmark] static vendor failed for ${input.query.id}: ${fallbackReason}; fallback=manual-golden`)
    return {
      requested_source: 'static',
      effective_source: 'manual-golden',
      record: input.manualRecord,
      fallback_reason: fallbackReason,
      estimated_fields: [],
      provenance: provenance(input.snapshot),
    }
  }

  return {
    requested_source: 'static',
    effective_source: 'static-openflights+manual-band',
    record: {
      ...input.manualRecord,
      route_segments: segments!,
      journey_type: route!.route_kind,
      source: 'static-openflights+manual-band',
    },
    estimated_fields: [
      'route_segments[].departure_at',
      'route_segments[].arrival_at',
      'route_segments[].transport_number',
      'price',
    ],
    provenance: provenance(input.snapshot),
  }
}
