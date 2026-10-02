/**
 * Offline geo-atlas loader contract tests (issue #342, mechanism only —
 * default off, zero product callers).
 *
 * Run: cd ts && npx tsx scripts/geo-atlas-tests.ts
 *
 * Fully offline: driven by a small synthetic fixture GeoJSON written to a
 * temp directory (never the committed build output, never the network). The
 * offline claim itself is executed: globalThis.fetch is replaced by a
 * throwing spy for the whole run and asserted to stay at zero calls.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  GEO_ATLAS_MANIFEST_SCHEMA,
  loadGeoAtlas,
  lookupById,
  lookupByName,
  normalizeAtlasName,
  type GeoAtlas,
} from '../capabilities/geo-atlas.ts'

function sha256(data: string): string {
  return createHash('sha256').update(Buffer.from(data, 'utf8')).digest('hex')
}

const SQUARE: number[][][][] = [[[[100.0, 21.0], [102.0, 21.0], [102.0, 25.0], [100.0, 25.0], [100.0, 21.0]]]]
const OTHER_SQUARE: number[][][][] = [[[[11.0, 60.0], [13.0, 60.0], [13.0, 62.0], [11.0, 62.0], [11.0, 60.0]]]]

interface FixtureFeature {
  type: 'Feature'
  properties: Record<string, string>
  geometry: { type: 'MultiPolygon'; coordinates: number[][][][] }
}

function feature(properties: Record<string, string>, coordinates: number[][][][] = SQUARE): FixtureFeature {
  return { type: 'Feature', properties, geometry: { type: 'MultiPolygon', coordinates } }
}

const ADMIN_0_FEATURES = [
  feature({ id: 'CHN', name: 'China', name_zh: '中华人民共和国', admin: 'China', iso_a2: 'CN', iso_a3: 'CHN' }),
  feature({ id: 'NOR', name: 'Norway', name_zh: '挪威', admin: 'Norway', iso_a2: 'NO', iso_a3: 'NOR' }, OTHER_SQUARE),
  feature({ id: 'TL', name: 'Testland', admin: 'Testland', iso_a2: 'TX' }),
]

const ADMIN_1_FEATURES = [
  feature({ id: 'CN-YN', name: 'Yunnan', name_zh: '云南省', admin: 'China', iso_a2: 'CN', adm0_a3: 'CHN' }),
  feature({ id: 'NO-18', name: 'Nordland', admin: 'Norway', iso_a2: 'NO', adm0_a3: 'NOR' }, OTHER_SQUARE),
  feature({ id: 'TL-NR', name: 'Nordland', admin: 'Testland', iso_a2: 'TX', adm0_a3: 'TL' }),
]

const UPSTREAM = { repository: 'https://example.invalid/natural-earth-vector', tag: 'fixture-tag', commit: 'fixture-commit' }
const LICENSE = 'Natural Earth — public domain (no attribution required)'

interface FixtureOptions {
  admin0Text?: string
  admin1Text?: string
  manifestText?: string
}

async function writeFixture(dir: string, options: FixtureOptions = {}): Promise<string> {
  const versionDir = join(dir, 'fixture-v1')
  await mkdir(versionDir, { recursive: true })
  const admin0Text = options.admin0Text ?? JSON.stringify({ type: 'FeatureCollection', features: ADMIN_0_FEATURES })
  const admin1Text = options.admin1Text ?? JSON.stringify({ type: 'FeatureCollection', features: ADMIN_1_FEATURES })
  await writeFile(join(versionDir, 'admin-0.geojson'), admin0Text, 'utf8')
  await writeFile(join(versionDir, 'admin-1.geojson'), admin1Text, 'utf8')
  const manifest = {
    schemaVersion: GEO_ATLAS_MANIFEST_SCHEMA,
    dataset: 'natural-earth',
    version: 'fixture-v1',
    upstream: UPSTREAM,
    license: { name: LICENSE },
    build: { fetchedAt: '2026-10-02T00:00:00.000Z' },
    artifacts: [
      {
        layer: 'admin-0',
        file: 'admin-0.geojson',
        upstreamUrl: 'https://example.invalid/admin-0.geojson',
        upstreamSha256: 'a'.repeat(64),
        recordCount: 3,
        bytes: Buffer.byteLength(admin0Text),
        sha256: sha256(admin0Text),
      },
      {
        layer: 'admin-1',
        file: 'admin-1.geojson',
        upstreamUrl: 'https://example.invalid/admin-1.geojson',
        upstreamSha256: 'b'.repeat(64),
        recordCount: 3,
        bytes: Buffer.byteLength(admin1Text),
        sha256: sha256(admin1Text),
      },
    ],
  }
  await writeFile(join(versionDir, 'manifest.json'), options.manifestText ?? JSON.stringify(manifest, null, 2), 'utf8')
  return versionDir
}

async function loadOk(dir: string): Promise<GeoAtlas> {
  const result = await loadGeoAtlas(dir)
  assert.equal(result.status, 'ok', `fixture load must succeed, got ${JSON.stringify(result)}`)
  return result.atlas
}

async function loadErr(dir: string): Promise<string> {
  const result = await loadGeoAtlas(dir)
  assert.equal(result.status, 'error', `fixture load must fail, got ${JSON.stringify(result)}`)
  return result.reason
}

async function withFixture(name: string, fn: (versionDir: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), name))
  try {
    await fn(await writeFixture(root))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const tests: { name: string; fn: () => Promise<void> }[] = []

tests.push({
  name: 'green path: SHA-256 verified load, both layers indexed, provenance asserted',
  fn: async () => {
    await withFixture('geo-atlas-green-', async (versionDir) => {
      const atlas = await loadOk(versionDir)
      assert.equal(atlas.version, 'fixture-v1')
      assert.equal(atlas.recordCount(), 6)
      assert.equal(atlas.recordCount('admin-0'), 3)
      assert.equal(atlas.recordCount('admin-1'), 3)
      assert.equal(atlas.snapshot.dataset, 'natural-earth')
      assert.equal(atlas.snapshot.license, LICENSE)
      assert.deepEqual(atlas.snapshot.upstream, UPSTREAM)
      assert.equal(atlas.snapshot.fetchedAt, '2026-10-02T00:00:00.000Z')

      const hit = lookupByName(atlas, 'China')
      assert.equal(hit.status, 'hit')
      if (hit.status !== 'hit') return
      assert.equal(hit.record.id, 'CHN')
      assert.equal(hit.record.nameZh, '中华人民共和国')
      assert.equal(hit.record.geometry.type, 'MultiPolygon')
      assert.ok(hit.record.geometry.coordinates.length >= 1)
      assert.equal(hit.record.provenance.layer, 'admin-0')
      assert.equal(hit.record.provenance.snapshotFile, 'admin-0.geojson')
      assert.equal(hit.record.provenance.upstreamUrl, 'https://example.invalid/admin-0.geojson')
      const onDisk = await readFile(join(versionDir, 'admin-0.geojson'), 'utf8')
      assert.equal(hit.record.provenance.snapshotSha256, sha256(onDisk))
      assert.equal(hit.snapshot.version, 'fixture-v1')
    })
  },
})

tests.push({
  name: 'by-name matches the zh name and normalizes case/whitespace',
  fn: async () => {
    await withFixture('geo-atlas-names-', async (versionDir) => {
      const atlas = await loadOk(versionDir)
      const zh = lookupByName(atlas, '中华人民共和国')
      assert.equal(zh.status, 'hit')
      if (zh.status === 'hit') assert.equal(zh.record.id, 'CHN')
      const messy = lookupByName(atlas, '   cHina ')
      assert.equal(messy.status, 'hit')
      assert.equal(normalizeAtlasName('  YUNNAN '), 'yunnan')
    })
  },
})

tests.push({
  name: 'by-id lookup hits with the layer provenance of that record',
  fn: async () => {
    await withFixture('geo-atlas-id-', async (versionDir) => {
      const atlas = await loadOk(versionDir)
      const hit = lookupById(atlas, 'CN-YN')
      assert.equal(hit.status, 'hit')
      if (hit.status !== 'hit') return
      assert.equal(hit.record.admin, 'China')
      assert.equal(hit.record.provenance.layer, 'admin-1')
      assert.equal(hit.record.provenance.snapshotFile, 'admin-1.geojson')
      assert.equal(hit.record.provenance.snapshotSha256, sha256(await readFile(join(versionDir, 'admin-1.geojson'), 'utf8')))
      const country = lookupById(atlas, 'chn')
      assert.equal(country.status, 'hit')
    })
  },
})

tests.push({
  name: 'same-name place → ambiguous with candidates, never a silent pick; layer filter narrows',
  fn: async () => {
    await withFixture('geo-atlas-ambig-', async (versionDir) => {
      const atlas = await loadOk(versionDir)
      const ambiguous = lookupByName(atlas, 'Nordland')
      assert.equal(ambiguous.status, 'ambiguous')
      if (ambiguous.status !== 'ambiguous') return
      assert.equal(ambiguous.candidates.length, 2)
      const ids = ambiguous.candidates.map((c) => c.id).sort()
      assert.deepEqual(ids, ['NO-18', 'TL-NR'])
      for (const candidate of ambiguous.candidates) {
        assert.equal(candidate.layer, 'admin-1')
        assert.ok(candidate.admin)
      }
      assert.match(ambiguous.note, /clarify/i)

      const narrowed = lookupByName(atlas, 'Nordland', { layer: 'admin-0' })
      assert.equal(narrowed.status, 'unknown')
    })
  },
})

tests.push({
  name: 'unknown region → three-valued miss, snapshot provenance still attached',
  fn: async () => {
    await withFixture('geo-atlas-unknown-', async (versionDir) => {
      const atlas = await loadOk(versionDir)
      for (const miss of [lookupByName(atlas, 'Atlantis'), lookupById(atlas, 'XX-XX')]) {
        assert.equal(miss.status, 'unknown')
        if (miss.status !== 'unknown') continue
        assert.equal(miss.snapshot.version, 'fixture-v1')
        assert.match(miss.note, /not proof/)
      }
      const empty = lookupByName(atlas, '   ')
      assert.equal(empty.status, 'unknown')
    })
  },
})

tests.push({
  name: 'fail-closed: missing/corrupt/invalid manifest, missing/tampered/corrupt/invalid artifact, duplicate id',
  fn: async () => {
    const base = await mkdtemp(join(tmpdir(), 'geo-atlas-fail-'))
    try {
      const missing = await loadGeoAtlas(join(base, 'no-such-dir'))
      assert.equal(missing.status, 'error')

      const rawManifestDir = join(base, 'raw-manifest')
      await mkdir(rawManifestDir, { recursive: true })
      await writeFile(join(rawManifestDir, 'manifest.json'), '{not json', 'utf8')
      assert.equal(await loadErr(rawManifestDir), 'manifest-corrupt')

      const badSchemaDir = await writeFixture(base, {
        manifestText: JSON.stringify({ schemaVersion: 'something-else', dataset: 'x', version: 'y', artifacts: [] }),
      })
      assert.equal(await loadErr(badSchemaDir), 'manifest-invalid')

      const missingArtifactDir = await writeFixture(base)
      await rm(join(missingArtifactDir, 'admin-1.geojson'))
      assert.equal(await loadErr(missingArtifactDir), 'artifact-missing')

      // Tamper happens AFTER the manifest is on disk: the snapshot file no
      // longer matches its recorded SHA-256 (this is the fail-closed seam).
      const tamperedDir = await writeFixture(base)
      await writeFile(join(tamperedDir, 'admin-1.geojson'), await readFile(join(tamperedDir, 'admin-1.geojson'), 'utf8') + ' ', 'utf8')
      assert.equal(await loadErr(tamperedDir), 'artifact-sha-mismatch')

      const brokenJson = JSON.stringify({ type: 'FeatureCollection', features: ADMIN_1_FEATURES }).slice(0, 40)
      const corruptArtifactDir = await writeFixture(base, { admin1Text: brokenJson })
      assert.equal(await loadErr(corruptArtifactDir), 'artifact-corrupt')

      const shapeDriftText = JSON.stringify({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: { id: 'NO-18', name: 'Nordland' } }, ...ADMIN_1_FEATURES.slice(1)],
      })
      const shapeDriftDir = await writeFixture(base, { admin1Text: shapeDriftText })
      assert.equal(await loadErr(shapeDriftDir), 'artifact-invalid')

      const notACollection = JSON.stringify({ type: 'Feature', geometry: null })
      const notCollectionDir = await writeFixture(base, { admin0Text: notACollection })
      assert.equal(await loadErr(notCollectionDir), 'artifact-invalid')

      const duplicateText = JSON.stringify({
        type: 'FeatureCollection',
        features: [...ADMIN_0_FEATURES, feature({ id: 'CHN', name: 'China Duplicate' })],
      })
      const duplicateDir = await writeFixture(base, { admin0Text: duplicateText })
      assert.equal(await loadErr(duplicateDir), 'duplicate-id')
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  },
})

tests.push({
  name: 'determinism: two loads of the same root answer identically',
  fn: async () => {
    await withFixture('geo-atlas-det-', async (versionDir) => {
      const first = await loadOk(versionDir)
      const second = await loadOk(versionDir)
      assert.deepEqual(first.snapshot, second.snapshot)
      assert.deepEqual(lookupByName(first, 'Yunnan'), lookupByName(second, 'Yunnan'))
      assert.deepEqual(lookupById(first, 'TL-NR'), lookupById(second, 'TL-NR'))
    })
  },
})

// The offline spy wraps the entire suite (installed before any test runs and
// asserted afterwards): zero network is an executed contract, not a claim.
const realFetch = globalThis.fetch
let fetchCalls = 0
globalThis.fetch = ((...args: unknown[]) => {
  fetchCalls += 1
  throw new Error(`geo-atlas loader must be offline; fetch called with ${JSON.stringify(args[0])}`)
}) as typeof fetch

let failed = 0
for (const test of tests) {
  try {
    await test.fn()
    console.log(`ok - ${test.name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL - ${test.name}`)
    console.error(error)
  }
}

globalThis.fetch = realFetch
assert.equal(fetchCalls, 0, `loader made ${fetchCalls} network call(s); offline contract violated`)

if (failed > 0) {
  console.error(`${failed} geo-atlas test(s) failed`)
  process.exit(1)
}
console.log(`geo-atlas contract tests: ${tests.length} passed, 0 failed (fetch calls: ${fetchCalls})`)
