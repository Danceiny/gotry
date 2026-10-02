/**
 * Offline administrative-division atlas loader (issue #342, mechanism only —
 * default OFF, zero callers).
 *
 * Reads the script-built snapshot under ts/data/geo-atlas/<version>/ (built by
 * scripts/build-geo-atlas.mjs from Natural Earth, public domain) and answers
 * by-name / by-id boundary lookups with typed provenance. Read-only: this
 * module performs zero network access (node:fs + node:crypto only) and is not
 * imported anywhere in the product path; activation stays gated on the
 * offline-first trigger per docs/data-sources.md §2 / §7.
 *
 * Semantics (fail-closed, three-valued — mirrors the data-sources L4 contract):
 * - Same-name places → `ambiguous` with candidates; the loader never picks a
 *   winner (clarification belongs to the caller).
 * - Boundary changes → the snapshot is frozen as-of `fetchedAt`/`version`;
 *   every result carries that provenance so no boundary is presented as live.
 * - Unknown region → `unknown`: a miss inside the snapshot is not proof of
 *   nonexistence (admin-1 coverage is partial by design — 50m set).
 * - Multilingual names → `nameZh` is surfaced when the source carries it;
 *   when absent only the English name is returned, never a fabricated
 *   translation (ADR-10: the LLM fabricates nothing, and neither do we).
 * - Missing / tampered / corrupt / shape-drifted snapshots → load `error`
 *   (SHA-256 verified against the manifest; nothing degrades silently).
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const GEO_ATLAS_MANIFEST_SCHEMA = 'gotry_geo_atlas_manifest_v1'

export type GeoAtlasLayer = 'admin-0' | 'admin-1'

export interface GeoAtlasGeometry {
  type: 'MultiPolygon'
  coordinates: number[][][][]
}

export interface GeoAtlasLayerProvenance {
  layer: GeoAtlasLayer
  upstreamUrl: string
  upstreamSha256: string
  snapshotFile: string
  snapshotSha256: string
}

export interface GeoAtlasRecord {
  id: string
  name: string
  nameZh: string | null
  admin: string | null
  isoA2: string | null
  isoA3: string | null
  adm0A3: string | null
  typeEn: string | null
  geometry: GeoAtlasGeometry
  provenance: GeoAtlasLayerProvenance
}

export interface GeoAtlasSnapshotProvenance {
  dataset: string
  version: string
  license: string
  upstream: { repository: string; tag: string; commit: string }
  fetchedAt: string
}

export interface GeoAtlasCandidate {
  layer: GeoAtlasLayer
  id: string
  name: string
  admin: string | null
}

export type GeoAtlasLookup =
  | { status: 'hit'; record: GeoAtlasRecord; snapshot: GeoAtlasSnapshotProvenance }
  | {
      status: 'ambiguous'
      candidates: GeoAtlasCandidate[]
      snapshot: GeoAtlasSnapshotProvenance
      note: string
    }
  | { status: 'unknown'; snapshot: GeoAtlasSnapshotProvenance; note: string }

export type GeoAtlasLoadResult =
  | { status: 'ok'; atlas: GeoAtlas }
  | { status: 'error'; reason: string; details: string }

export interface GeoAtlas {
  version: string
  snapshot: GeoAtlasSnapshotProvenance
  recordCount: (layer?: GeoAtlasLayer) => number
}

interface GeoAtlasIndexEntry {
  layer: GeoAtlasLayer
  id: string
  normalizedName: string
  normalizedZhName: string | null
  record: GeoAtlasRecord
}

interface LoadedGeoAtlas extends GeoAtlas {
  byId: Map<string, GeoAtlasIndexEntry>
  byName: Map<string, GeoAtlasIndexEntry[]>
}

interface ManifestArtifact {
  layer: string
  file: string
  upstreamUrl: string
  upstreamSha256: string
  recordCount: number
  bytes: number
  sha256: string
}

interface Manifest {
  schemaVersion: string
  dataset: string
  version: string
  upstream: { repository: string; tag: string; commit: string }
  license: { name: string }
  build: { fetchedAt: string }
  artifacts: ManifestArtifact[]
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

/** NFKC + casefold + whitespace collapse so "  cHina " ≡ "China". */
export function normalizeAtlasName(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}

function isGeoAtlasLayer(value: string): value is GeoAtlasLayer {
  return value === 'admin-0' || value === 'admin-1'
}

function parseManifest(text: string): Manifest {
  const manifest = JSON.parse(text) as Manifest
  if (manifest.schemaVersion !== GEO_ATLAS_MANIFEST_SCHEMA) {
    throw new Error(`schemaVersion ${JSON.stringify(manifest.schemaVersion)} ≠ ${GEO_ATLAS_MANIFEST_SCHEMA}`)
  }
  for (const key of ['dataset', 'version'] as const) {
    if (typeof manifest[key] !== 'string' || manifest[key] === '') throw new Error(`field "${key}" missing`)
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    throw new Error('artifacts empty')
  }
  for (const artifact of manifest.artifacts) {
    if (!isGeoAtlasLayer(String(artifact.layer))) throw new Error(`artifact layer "${artifact.layer}" unknown`)
    for (const key of ['file', 'upstreamUrl', 'sha256'] as const) {
      if (typeof artifact[key] !== 'string' || artifact[key] === '') throw new Error(`artifact field "${key}" missing`)
    }
  }
  if (typeof manifest.upstream?.repository !== 'string' || typeof manifest.license?.name !== 'string') {
    throw new Error('upstream/license block missing')
  }
  return manifest
}

function toRecord(
  feature: { properties?: Record<string, unknown>; geometry?: { type?: string; coordinates?: unknown } },
  layer: GeoAtlasLayer,
  layerProvenance: GeoAtlasLayerProvenance,
): GeoAtlasRecord {
  const properties = feature.properties ?? {}
  const id = properties.id
  const name = properties.name
  if (typeof id !== 'string' || id === '') throw new Error('feature without string "id"')
  if (typeof name !== 'string' || name === '') throw new Error(`feature "${id}" without string "name"`)
  if (feature.geometry?.type !== 'MultiPolygon' || !Array.isArray(feature.geometry.coordinates)) {
    throw new Error(`feature "${id}" geometry is not MultiPolygon`)
  }
  const coordinates = feature.geometry.coordinates as number[][][][]
  if (coordinates.length === 0 || coordinates.some((polygon) => !Array.isArray(polygon) || polygon.length === 0)) {
    throw new Error(`feature "${id}" geometry has no polygons`)
  }
  const optional = (key: string): string | null => {
    const value = properties[key]
    return typeof value === 'string' && value !== '' ? value : null
  }
  return {
    id,
    name,
    nameZh: optional('name_zh'),
    admin: optional('admin'),
    isoA2: optional('iso_a2'),
    isoA3: optional('iso_a3'),
    adm0A3: optional('adm0_a3'),
    typeEn: optional('type_en'),
    geometry: { type: 'MultiPolygon', coordinates },
    provenance: layerProvenance,
  }
}

function atlasError(reason: string, details: string): GeoAtlasLoadResult {
  return { status: 'error', reason, details }
}

/**
 * Load and verify an atlas snapshot. `root` is the version directory that
 * contains manifest.json plus the artifact files it lists.
 * Offline by construction: filesystem reads only, every artifact byte-verified
 * against its manifest SHA-256 before indexing.
 */
export async function loadGeoAtlas(root: string): Promise<GeoAtlasLoadResult> {
  let manifestText: string
  try {
    manifestText = await readFile(join(root, 'manifest.json'), 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT'
      ? atlasError('manifest-missing', `no manifest.json under ${root}`)
      : atlasError('manifest-unreadable', String((error as Error).message))
  }
  let manifest: Manifest
  try {
    manifest = parseManifest(manifestText)
  } catch (error) {
    return error instanceof SyntaxError
      ? atlasError('manifest-corrupt', `manifest.json is not valid JSON: ${error.message}`)
      : atlasError('manifest-invalid', (error as Error).message)
  }

  const snapshot: GeoAtlasSnapshotProvenance = {
    dataset: manifest.dataset,
    version: manifest.version,
    license: manifest.license.name,
    upstream: manifest.upstream,
    fetchedAt: manifest.build.fetchedAt,
  }

  const byId = new Map<string, GeoAtlasIndexEntry>()
  const byName = new Map<string, GeoAtlasIndexEntry[]>()
  const counts = new Map<GeoAtlasLayer, number>()

  for (const artifact of manifest.artifacts) {
    const layer = artifact.layer as GeoAtlasLayer
    let bytes: Buffer
    try {
      bytes = await readFile(join(root, artifact.file))
    } catch {
      return atlasError('artifact-missing', `${artifact.file} listed in manifest but absent`)
    }
    const digest = sha256(bytes)
    if (digest !== artifact.sha256) {
      return atlasError('artifact-sha-mismatch', `${artifact.file}: manifest ${artifact.sha256} ≠ actual ${digest}`)
    }
    let collection: { type?: string; features?: unknown }
    try {
      collection = JSON.parse(bytes.toString('utf8'))
    } catch (error) {
      return atlasError('artifact-corrupt', `${artifact.file} is not valid JSON: ${(error as Error).message}`)
    }
    if (collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
      return atlasError('artifact-invalid', `${artifact.file} is not a FeatureCollection`)
    }
    const layerProvenance: GeoAtlasLayerProvenance = {
      layer,
      upstreamUrl: artifact.upstreamUrl,
      upstreamSha256: artifact.upstreamSha256,
      snapshotFile: artifact.file,
      snapshotSha256: digest,
    }
    counts.set(layer, collection.features.length)
    for (const feature of collection.features) {
      let record: GeoAtlasRecord
      try {
        record = toRecord(feature, layer, layerProvenance)
      } catch (error) {
        return atlasError('artifact-invalid', `${artifact.file}: ${(error as Error).message}`)
      }
      const normalizedId = normalizeAtlasName(record.id)
      if (byId.has(normalizedId)) {
        return atlasError('duplicate-id', `"${record.id}" appears twice across the snapshot; id is not a stable key`)
      }
      const entry: GeoAtlasIndexEntry = {
        layer,
        id: record.id,
        normalizedName: normalizeAtlasName(record.name),
        normalizedZhName: record.nameZh ? normalizeAtlasName(record.nameZh) : null,
        record,
      }
      byId.set(normalizedId, entry)
      for (const key of [entry.normalizedName, entry.normalizedZhName]) {
        if (key == null || key === '') continue
        const bucket = byName.get(key)
        if (bucket) bucket.push(entry)
        else byName.set(key, [entry])
      }
    }
  }

  const atlas: LoadedGeoAtlas = {
    version: manifest.version,
    snapshot,
    byId,
    byName,
    recordCount: (layer?: GeoAtlasLayer) => (layer ? (counts.get(layer) ?? 0) : byId.size),
  }
  return { status: 'ok', atlas }
}

const UNKNOWN_NOTE =
  'not found in this snapshot; a miss here is not proof the place does not exist (admin-1 coverage is partial by design)'

function unknown(snapshot: GeoAtlasSnapshotProvenance): GeoAtlasLookup {
  return { status: 'unknown', snapshot, note: UNKNOWN_NOTE }
}

/** Exact id lookup (e.g. "CHN" admin-0, "CN-YN" admin-1). Offline, read-only. */
export function lookupById(atlas: GeoAtlas, id: string): GeoAtlasLookup {
  const loaded = atlas as LoadedGeoAtlas
  const entry = loaded.byId.get(normalizeAtlasName(id))
  if (!entry) return unknown(loaded.snapshot)
  return { status: 'hit', record: entry.record, snapshot: loaded.snapshot }
}

/**
 * Name lookup against English and zh names; `options.layer` narrows to one
 * layer before the hit/ambiguous decision. One match → hit; several distinct
 * ids → ambiguous with candidates (the loader never picks a winner); none →
 * unknown (three-valued).
 */
export function lookupByName(
  atlas: GeoAtlas,
  name: string,
  options?: { layer?: GeoAtlasLayer },
): GeoAtlasLookup {
  const loaded = atlas as LoadedGeoAtlas
  const key = normalizeAtlasName(name)
  if (key === '') return unknown(loaded.snapshot)
  const matched = (loaded.byName.get(key) ?? []).filter((entry) =>
    options?.layer ? entry.layer === options.layer : true,
  )
  if (matched.length === 0) return unknown(loaded.snapshot)
  const distinct = matched.filter(
    (entry, index) => matched.findIndex((other) => other.record.id === entry.record.id) === index,
  )
  if (distinct.length === 1) return { status: 'hit', record: distinct[0].record, snapshot: loaded.snapshot }
  return {
    status: 'ambiguous',
    candidates: distinct.map((entry) => ({
      layer: entry.layer,
      id: entry.record.id,
      name: entry.record.name,
      admin: entry.record.admin,
    })),
    snapshot: loaded.snapshot,
    note: 'same-name match in more than one place; clarify (country/parent or id) before use',
  }
}
