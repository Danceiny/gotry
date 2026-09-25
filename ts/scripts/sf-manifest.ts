/** Frozen sf-01..08 live-benchmark input; no supplier or filesystem effects. */
import { createHash } from 'node:crypto'

export interface SfFlightQuery {
  id: string
  kind: string
  from: string
  to: string
  date: string
}

const IDS = Array.from({ length: 8 }, (_, i) => `sf-${String(i + 1).padStart(2, '0')}`)

export function validateSfManifest(queryFile: unknown, comparatorFile: unknown): SfFlightQuery[] {
  const queryRecord = queryFile as { queries?: unknown }
  const comparator = comparatorFile as { matches?: unknown; query_manifest_sha256?: unknown }
  if (!queryRecord || !Array.isArray(queryRecord.queries)) throw new Error('sf-01..08 query manifest is missing')
  if (!comparator || !Array.isArray(comparator.matches)) throw new Error('sf-01..08 comparator manifest is missing')

  const flights = queryRecord.queries.filter((q): q is Record<string, unknown> =>
    q != null && typeof q === 'object' && typeof (q as Record<string, unknown>).id === 'string'
      && ((q as Record<string, unknown>).id as string).startsWith('sf-'))
  if (flights.length !== IDS.length || flights.some((q, i) => q.id !== IDS[i])) {
    throw new Error('sf-01..08 query ids or order drifted')
  }
  const queries = flights.map((q): SfFlightQuery => {
    if (q.kind !== 'flight' || typeof q.from !== 'string' || !q.from || typeof q.to !== 'string' || !q.to
      || typeof q.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(q.date)) {
      throw new Error(`sf-01..08 query shape drifted: ${String(q.id)}`)
    }
    return { id: q.id as string, kind: q.kind, from: q.from, to: q.to, date: q.date }
  })

  const digest = createHash('sha256').update(JSON.stringify(queries)).digest('hex')
  if (comparator.query_manifest_sha256 !== digest) throw new Error('sf-01..08 frozen query digest mismatch')
  if (comparator.matches.length !== IDS.length || comparator.matches.some((m, i) => {
    const row = m as Record<string, unknown> | null
    const q = queries[i]!
    return !row || row.query_id !== q.id || row.from !== q.from || row.to !== q.to || row.date !== q.date
  })) throw new Error('sf-01..08 comparator query mismatch')
  return queries
}
