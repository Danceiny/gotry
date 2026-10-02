#!/usr/bin/env node
/**
 * Geo atlas builder (issue #342): fetch Natural Earth Admin-0/Admin-1 GeoJSON,
 * project to a minimal schema + simplify geometry, and emit
 * ts/data/geo-atlas/<version>/{admin-0.geojson, admin-1.geojson, manifest.json}.
 *
 * Explicit step only — nothing in run-all-tests.sh or the product path calls
 * this. Network (node builtin fetch) is used here and only here; consumers
 * read the committed snapshot offline.
 *
 * Selection & size cap (recorded in docs/data-sources.md §2.1):
 * - Natural Earth vector, public domain ("free for use in any type of
 *   project"), pinned at release v5.1.2 commit so every build is reproducible.
 * - Admin-0 @ 50m (242 countries) + Admin-1 @ 50m (294 major subdivisions of
 *   9 large countries; the global 4,649-feature Admin-1 set only exists at
 *   10m ≈ 40 MB raw, far over any bundle budget).
 * - Simplification: Douglas-Peucker tolerance 0.02° (~2.2 km max deviation),
 *   coordinates rounded to 3 decimals, holes under 0.02° extent dropped.
 *   Measured output ≈ 1.6 MB total ≤ 2 MB cap → committable.
 * - If the emitted total exceeds the cap the builder degrades to Admin-0 only
 *   (recording the downgrade reason in the manifest); if even that exceeds
 *   the cap it fails loudly instead of shipping an oversized artifact.
 *
 * Run: node scripts/build-geo-atlas.mjs [--out ts/data/geo-atlas] [--cap-mb 2]
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const NE_VECTOR_REPO = 'nvkelso/natural-earth-vector'
const NE_TAG = 'v5.1.2'
const NE_COMMIT = 'f1890d9f152c896d250a77557a5751a93d494776'
const VERSION = `ne-${NE_TAG}`

const LICENSE = {
  name: 'Natural Earth — public domain (no attribution required)',
  statementUrl: `https://github.com/${NE_VECTOR_REPO}#${NE_COMMIT} README: "Natural Earth is a public domain map dataset ... free for use in any type of project"`,
  termsUrl: 'https://www.naturalearthdata.com/about/terms-of-use/',
}

// Closed property projection: name / id / boundary only (plus the country
// context and the zh name needed for clarification semantics). "-99" is
// Natural Earth's null sentinel.
const LAYERS = [
  {
    key: 'admin-0',
    file: 'admin-0.geojson',
    upstreamPath: 'geojson/ne_50m_admin_0_countries.geojson',
    pick: (p) => ({
      id: p.ADM0_A3,
      name: p.NAME,
      name_zh: p.NAME_ZH,
      admin: p.ADMIN,
      iso_a2: p.ISO_A2,
      iso_a3: p.ISO_A3,
      type: p.TYPE,
    }),
    requiredProps: ['ADM0_A3', 'NAME'],
  },
  {
    key: 'admin-1',
    file: 'admin-1.geojson',
    upstreamPath: 'geojson/ne_50m_admin_1_states_provinces.geojson',
    pick: (p) => ({
      id: p.iso_3166_2,
      name: p.name,
      name_zh: p.name_zh,
      admin: p.admin,
      iso_a2: p.iso_a2,
      adm0_a3: p.adm0_a3,
      type_en: p.type_en,
    }),
    requiredProps: ['name', 'admin'],
  },
]

const TOLERANCE_DEG = 0.02
const COORD_PRECISION = 3
const MIN_HOLE_EXTENT_DEG = 0.02
const MAX_TOTAL_MB = 2

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function roundCoord(value) {
  const factor = 10 ** COORD_PRECISION
  return Math.round(value * factor) / factor
}

/** Ramer-Douglas-Peucker on one closed ring (first == last point preserved). */
function simplifyRing(ring, tolerance) {
  if (ring.length <= 4) return ring
  const pts = ring.slice(0, -1)
  const sqTol = tolerance * tolerance
  const keep = new Uint8Array(pts.length)
  keep[0] = 1
  keep[pts.length - 1] = 1
  const stack = [[0, pts.length - 1]]
  while (stack.length) {
    const [first, last] = stack.pop()
    let maxDist = 0
    let index = -1
    const ax = pts[first][0]
    const ay = pts[first][1]
    const dx = pts[last][0] - ax
    const dy = pts[last][1] - ay
    const segLen = dx * dx + dy * dy
    for (let i = first + 1; i < last; i++) {
      const [x, y] = pts[i]
      let t = segLen === 0 ? 0 : ((x - ax) * dx + (y - ay) * dy) / segLen
      t = Math.max(0, Math.min(1, t))
      const d = (x - (ax + t * dx)) ** 2 + (y - (ay + t * dy)) ** 2
      if (d > maxDist) {
        maxDist = d
        index = i
      }
    }
    if (maxDist > sqTol && index > 0) {
      keep[index] = 1
      stack.push([first, index], [index, last])
    }
  }
  const out = []
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i])
  out.push(out[0])
  return out
}

function ringExtentDiag(ring) {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const [x, y] of ring) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return Math.hypot(maxX - minX, maxY - minY)
}

/** Polygon/MultiPolygon → simplified MultiPolygon; null only if source empty. */
function simplifyGeometry(geometry) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates
  const rounded = polygons.map((poly) =>
    poly.map((ring) => ring.map(([x, y]) => [roundCoord(x), roundCoord(y)])),
  )
  const simplified = []
  for (const poly of rounded) {
    const rings = []
    for (let r = 0; r < poly.length; r++) {
      // r === 0 is the outer ring: never dropped by extent, so no record
      // silently loses its territory (tiny countries keep their outline).
      if (r > 0 && ringExtentDiag(poly[r]) < MIN_HOLE_EXTENT_DEG) continue
      const ring = simplifyRing(poly[r], TOLERANCE_DEG)
      if (ring.length >= 4) rings.push(ring)
    }
    if (rings.length > 0) simplified.push(rings)
  }
  if (simplified.length === 0) {
    // Degenerate after simplification: keep the rounded source rings instead
    // of dropping the feature (fail-open toward the snapshot, never lose a
    // record silently).
    if (rounded.length === 0) return null
    return { type: 'MultiPolygon', coordinates: rounded }
  }
  return { type: 'MultiPolygon', coordinates: simplified }
}

function projectFeature(feature, layer) {
  const props = {}
  for (const [key, value] of Object.entries(layer.pick(feature.properties))) {
    if (value == null || value === '' || value === '-99') continue
    props[key] = value
  }
  return { type: 'Feature', properties: props, geometry: simplifyGeometry(feature.geometry) }
}

function assertUpstreamLayer(layer, collection) {
  if (collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
    throw new Error(`upstream ${layer.key}: not a FeatureCollection`)
  }
  for (const prop of layer.requiredProps) {
    if (!(prop in (collection.features[0]?.properties ?? {}))) {
      throw new Error(`upstream ${layer.key}: required property "${prop}" missing (dataset shape drift)`)
    }
  }
}

function parseArgs(argv) {
  const out = { outDir: join(REPO_ROOT, 'ts/data/geo-atlas'), capMb: MAX_TOTAL_MB }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out.outDir = join(REPO_ROOT, argv[++i])
    else if (argv[i] === '--cap-mb') out.capMb = Number(argv[++i])
    else throw new Error(`unknown argument: ${argv[i]}`)
  }
  if (!Number.isFinite(out.capMb) || out.capMb <= 0) throw new Error('--cap-mb must be a positive number')
  return out
}

async function main() {
  const { outDir, capMb } = parseArgs(process.argv.slice(2))
  const fetchedAt = new Date().toISOString()
  const versionDir = join(outDir, VERSION)
  await mkdir(versionDir, { recursive: true })

  const artifacts = []
  let totalBytes = 0
  for (const layer of LAYERS) {
    const url = `https://raw.githubusercontent.com/${NE_VECTOR_REPO}/${NE_COMMIT}/${layer.upstreamPath}`
    console.log(`fetching ${layer.key}: ${url}`)
    const response = await fetch(url)
    if (!response.ok) throw new Error(`fetch failed: ${response.status} ${url}`)
    const sourceBytes = Buffer.from(await response.arrayBuffer())
    const sourceSha256 = sha256(sourceBytes)
    const collection = JSON.parse(sourceBytes.toString('utf8'))
    assertUpstreamLayer(layer, collection)

    const features = []
    for (const feature of collection.features) {
      const projected = projectFeature(feature, layer)
      if (projected.geometry == null) continue
      features.push(projected)
    }
    if (features.length !== collection.features.length) {
      throw new Error(`${layer.key}: dropped ${collection.features.length - features.length} empty-geometry features`)
    }
    if (features.some((f) => typeof f.properties.id !== 'string')) {
      throw new Error(`${layer.key}: some features have no usable id after projection`)
    }

    const payload = JSON.stringify({ type: 'FeatureCollection', features })
    const payloadBytes = Buffer.byteLength(payload)
    await writeFile(join(versionDir, layer.file), payload, 'utf8')
    totalBytes += payloadBytes
    artifacts.push({
      layer: layer.key,
      file: layer.file,
      upstreamUrl: url,
      upstreamSha256: sourceSha256,
      upstreamRecordCount: collection.features.length,
      recordCount: features.length,
      bytes: payloadBytes,
      sha256: sha256(Buffer.from(payload, 'utf8')),
    })
    console.log(
      `  ${layer.key}: ${features.length} records, ${(payloadBytes / 1048576).toFixed(2)} MB ` +
        `(source ${(sourceBytes.length / 1048576).toFixed(2)} MB, sha256 ${sourceSha256.slice(0, 12)}…)`,
    )
  }

  let included = artifacts
  let degraded = null
  const capBytes = capMb * 1048576
  if (totalBytes > capBytes) {
    const admin0 = artifacts.filter((a) => a.layer === 'admin-0')
    const admin0Bytes = admin0.reduce((sum, a) => sum + a.bytes, 0)
    const reason =
      `admin-0+admin-1 simplified output ${(totalBytes / 1048576).toFixed(2)} MB exceeds the ` +
      `${capMb} MB cap; degraded to admin-0 only (${(admin0Bytes / 1048576).toFixed(2)} MB)`
    if (admin0Bytes > capBytes) {
      throw new Error(`admin-0 alone is ${(admin0Bytes / 1048576).toFixed(2)} MB, over the ${capMb} MB cap — refusing to ship`)
    }
    console.warn(reason)
    degraded = reason
    included = admin0
  }

  const manifest = {
    schemaVersion: 'gotry_geo_atlas_manifest_v1',
    dataset: 'natural-earth',
    version: VERSION,
    upstream: {
      repository: `https://github.com/${NE_VECTOR_REPO}`,
      tag: NE_TAG,
      commit: NE_COMMIT,
    },
    license: LICENSE,
    build: {
      script: relative(REPO_ROOT, fileURLToPath(import.meta.url)),
      fetchedAt,
      simplification: {
        algorithm: 'ramer-douglas-peucker',
        toleranceDeg: TOLERANCE_DEG,
        toleranceApproxKm: Number((TOLERANCE_DEG * 111.32).toFixed(1)),
        coordPrecisionDecimals: COORD_PRECISION,
        minHoleExtentDeg: MIN_HOLE_EXTENT_DEG,
      },
      sizeCapMb: capMb,
      degradedToAdmin0: degraded != null,
      degradeReason: degraded,
    },
    artifacts: included,
    totalBytes: included.reduce((sum, a) => sum + a.bytes, 0),
  }
  const manifestPath = join(versionDir, 'manifest.json')
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')

  console.log(
    `atlas ${VERSION}: ${included.map((a) => `${a.layer}=${a.recordCount}`).join(', ')}; ` +
      `total ${(manifest.totalBytes / 1048576).toFixed(2)} MB → ${relative(REPO_ROOT, versionDir)}/`,
  )
  console.log('consumers: none (issue #342 mechanism only, default off — loader ts/capabilities/geo-atlas.ts)')
}

main().catch((error) => {
  console.error(`build-geo-atlas failed: ${error instanceof Error ? error.message : error}`)
  process.exit(1)
})
