import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type ProviderModule = {
  parseGoldenSource?: (args: string[]) => string
  loadStaticFlightSnapshot?: (path?: string) => {
    schema_version: string
    source: { name: string; url: string; revision: string; license: string; retrieved_at: string; limitations: string[] }
    routes: Array<Record<string, unknown> & {
      query_id: string
      legs: Array<{ from_iata: string; to_iata: string; carrier_codes: string[] }>
    }>
  }
  resolveStaticGolden?: (input: {
    query: { id: string; from: string; to: string; date: string }
    manualRecord: {
      query_id: string
      route_segments: Array<{ from: string; to: string; departure_at: string; arrival_at: string; transport_number: string }>
      journey_type: 'direct' | 'transfer'
      currency: string
      price: number
      source: string
      fetched_at: string
      verdict: string
      latency_ms: number
      read_guard_blocked: number
    }
    snapshot?: ReturnType<NonNullable<ProviderModule['loadStaticFlightSnapshot']>>
    snapshotError?: string
    warn?: (message: string) => void
  }) => {
    requested_source: string
    effective_source: string
    record: {
      query_id: string
      route_segments: Array<{ from: string; to: string; departure_at: string; arrival_at: string; transport_number: string }>
      journey_type: string
      currency: string
      price: number
      source: string
      fetched_at: string
      verdict: string
      latency_ms: number
      read_guard_blocked: number
    }
    fallback_reason?: string
    estimated_fields: string[]
    provenance: { route_source: string; route_revision: string; route_license: string; band_source: string }
  }
}

const modulePath = '../capabilities/session/static-flight-golden.ts'
const provider = await import(modulePath).catch(() => ({} as ProviderModule)) as ProviderModule

assert.equal(
  typeof provider.parseGoldenSource,
  'function',
  '缺少 parseGoldenSource 时 CLI 会把未知 vendor 静默当成 manual',
)

const parseGoldenSource = provider.parseGoldenSource!
assert.equal(parseGoldenSource(['--golden=static']), 'static')
assert.equal(parseGoldenSource([]), 'manual')
assert.throws(
  () => parseGoldenSource(['--golden=ctrip-open']),
  /不支持的 golden vendor: ctrip-open/,
  '未知 vendor 必须 fail-closed，不能静默回退 manual',
)

assert.equal(
  typeof provider.loadStaticFlightSnapshot,
  'function',
  'static vendor 必须从有 provenance 的版本化快照加载，不能复用 manual 并改标签',
)

const snapshot = provider.loadStaticFlightSnapshot!()
assert.equal(snapshot.schema_version, 'sf-static-routes.v1')
assert.deepEqual(snapshot.source, {
  name: 'OpenFlights routes.dat',
  url: 'https://raw.githubusercontent.com/jpatokal/openflights/4b969f8e91eb800c45f0e0e2355a0fbb93de27e4/data/routes.dat',
  revision: '4b969f8e91eb800c45f0e0e2355a0fbb93de27e4',
  license: 'ODbL-1.0',
  retrieved_at: '2026-08-30',
  limitations: ['route/carrier coverage only', 'no schedule', 'no price', 'no availability'],
})
assert.deepEqual(
  snapshot.routes.map((route) => route.query_id),
  ['sf-01', 'sf-02', 'sf-03', 'sf-04', 'sf-05', 'sf-06', 'sf-07', 'sf-08'],
  '静态快照必须逐条覆盖本批 8 query，不能靠全量 manual fallback 蒙混',
)
for (const route of snapshot.routes) {
  assert.ok(route.legs.length >= 1, `${route.query_id} 必须至少有一个静态 OD leg`)
  for (const leg of route.legs) {
    assert.match(leg.from_iata, /^[A-Z]{3}$/)
    assert.match(leg.to_iata, /^[A-Z]{3}$/)
    assert.ok(leg.carrier_codes.length >= 1)
  }
  assert.equal('departure_at' in route, false, 'OpenFlights 静态包不得伪造班期时刻')
  assert.equal('price' in route, false, 'OpenFlights 静态包不得伪造价格')
  assert.equal('availability' in route, false, 'OpenFlights 静态包不得伪造库存')
}

assert.equal(
  typeof provider.resolveStaticGolden,
  'function',
  '缺少 static→comparable record 解译时 --golden=static 仍不可执行',
)

const manualRecord = {
  query_id: 'sf-02',
  route_segments: [{
    from: '北京',
    to: '大理',
    departure_at: '2026-10-02T14:00:00+08:00',
    arrival_at: '2026-10-02T17:00:00+08:00',
    transport_number: 'CA1441',
  }],
  journey_type: 'direct' as const,
  currency: 'CNY',
  price: 2650,
  source: 'manual-golden',
  fetched_at: '2026-08-30T12:00:00.000Z',
  verdict: 'hit',
  latency_ms: 0,
  read_guard_blocked: 0,
}

const staticResolution = provider.resolveStaticGolden!({
  query: { id: 'sf-02', from: '北京', to: '大理', date: '2026-10-02' },
  manualRecord,
  snapshot,
})
assert.equal(staticResolution.requested_source, 'static')
assert.equal(staticResolution.effective_source, 'static-openflights+manual-band')
assert.equal(staticResolution.fallback_reason, undefined)
assert.equal(staticResolution.record.source, 'static-openflights+manual-band')
assert.equal(staticResolution.record.journey_type, 'transfer')
assert.equal(staticResolution.record.route_segments.length, 2)
assert.deepEqual(
  staticResolution.record.route_segments.map((segment) => [segment.from, segment.to, segment.transport_number]),
  [['北京', 'KMG', '8L-STATIC'], ['KMG', '大理', '8L-STATIC']],
)
assert.equal(staticResolution.record.route_segments[0]?.departure_at, '2026-10-02T14:00:00+08:00')
assert.equal(staticResolution.record.route_segments[0]?.arrival_at, '2026-10-02T15:00:00+08:00')
assert.equal(staticResolution.record.route_segments[1]?.departure_at, '2026-10-02T16:00:00+08:00')
assert.equal(staticResolution.record.route_segments[1]?.arrival_at, '2026-10-02T17:00:00+08:00')
assert.equal(staticResolution.record.price, 2650)
assert.deepEqual(staticResolution.estimated_fields, [
  'route_segments[].departure_at',
  'route_segments[].arrival_at',
  'route_segments[].transport_number',
  'price',
])
assert.deepEqual(staticResolution.provenance, {
  route_source: snapshot.source.url,
  route_revision: '4b969f8e91eb800c45f0e0e2355a0fbb93de27e4',
  route_license: 'ODbL-1.0',
  band_source: 'sf-golden-manifest.json',
})

const expectedStaticCoverage = [
  { id: 'sf-01', from: '上海', to: '丽江', date: '2026-10-01', transport: ['MU-STATIC'] },
  { id: 'sf-02', from: '北京', to: '大理', date: '2026-10-02', transport: ['8L-STATIC', '8L-STATIC'] },
  { id: 'sf-03', from: '上海', to: '三亚', date: '2026-11-11', transport: ['9C-STATIC'] },
  { id: 'sf-04', from: '广州', to: '昆明', date: '2026-12-20', transport: ['CA-STATIC'] },
  { id: 'sf-05', from: '深圳', to: '成都', date: '2026-10-05', transport: ['3U-STATIC'] },
  { id: 'sf-06', from: '杭州', to: '厦门', date: '2026-10-06', transport: ['CA-STATIC'] },
  { id: 'sf-07', from: '西安', to: '桂林', date: '2026-10-07', transport: ['CA-STATIC'] },
  { id: 'sf-08', from: '重庆', to: '贵阳', date: '2026-10-08', transport: ['CA-STATIC'] },
] as const
for (const expected of expectedStaticCoverage) {
  const record = {
    ...manualRecord,
    query_id: expected.id,
    route_segments: [{
      ...manualRecord.route_segments[0]!,
      from: expected.from,
      to: expected.to,
      departure_at: `${expected.date}T06:00:00+08:00`,
      arrival_at: `${expected.date}T12:00:00+08:00`,
    }],
  }
  const resolution = provider.resolveStaticGolden!({
    query: { id: expected.id, from: expected.from, to: expected.to, date: expected.date },
    manualRecord: record,
    snapshot,
  })
  assert.equal(resolution.effective_source, 'static-openflights+manual-band', `${expected.id} 不得全量回退 manual`)
  assert.equal(resolution.fallback_reason, undefined)
  assert.equal(resolution.record.route_segments.length, expected.transport.length)
  assert.equal(resolution.record.route_segments[0]?.from, expected.from)
  assert.equal(resolution.record.route_segments.at(-1)?.to, expected.to)
  assert.deepEqual(
    resolution.record.route_segments.map((segment) => segment.transport_number),
    expected.transport,
    `${expected.id} 运行时首选 carrier 必须来自已核对的 pinned route row`,
  )
  for (const segment of resolution.record.route_segments) {
    assert.match(segment.transport_number, /^[A-Z0-9]{2}-STATIC$/)
    assert.ok(Number.isFinite(Date.parse(segment.departure_at)))
    assert.ok(Number.isFinite(Date.parse(segment.arrival_at)))
    assert.ok(Date.parse(segment.arrival_at) > Date.parse(segment.departure_at))
  }
}

const warnings: string[] = []
const fallbackRecord = { ...manualRecord, query_id: 'sf-99' }
const fallbackResolution = provider.resolveStaticGolden!({
  query: { id: 'sf-99', from: '北京', to: '大理', date: '2026-10-02' },
  manualRecord: fallbackRecord,
  snapshot,
  warn: (message) => warnings.push(message),
})
assert.equal(fallbackResolution.effective_source, 'manual-golden')
assert.equal(fallbackResolution.record, fallbackRecord, 'fallback 必须原样使用 manual record')
assert.equal(fallbackResolution.fallback_reason, 'static route missing for sf-99')
assert.deepEqual(warnings, [
  '[sf-live-benchmark] static vendor failed for sf-99: static route missing for sf-99; fallback=manual-golden',
])

const snapshotWarnings: string[] = []
const unavailableResolution = provider.resolveStaticGolden!({
  query: { id: 'sf-02', from: '北京', to: '大理', date: '2026-10-02' },
  manualRecord,
  snapshotError: 'invalid static snapshot schema_version',
  warn: (message) => snapshotWarnings.push(message),
})
assert.equal(unavailableResolution.effective_source, 'manual-golden')
assert.equal(
  unavailableResolution.fallback_reason,
  'static snapshot unavailable: invalid static snapshot schema_version',
)
assert.deepEqual(snapshotWarnings, [
  '[sf-live-benchmark] static vendor failed for sf-02: static snapshot unavailable: invalid static snapshot schema_version; fallback=manual-golden',
])

const malformedRoot = mkdtempSync(join(tmpdir(), 'gotry-static-golden-'))
try {
  const malformedPath = join(malformedRoot, 'malformed.json')
  writeFileSync(malformedPath, JSON.stringify({ schema_version: 'sf-static-routes.v0', source: {}, routes: [] }))
  assert.throws(
    () => provider.loadStaticFlightSnapshot!(malformedPath),
    /invalid static snapshot schema_version: sf-static-routes.v0/,
    '未知 schema 不得被类型断言伪装成有效 static vendor',
  )

  const malformedRoutesPath = join(malformedRoot, 'malformed-routes.json')
  writeFileSync(malformedRoutesPath, JSON.stringify({
    schema_version: 'sf-static-routes.v1',
    source: snapshot.source,
    routes: null,
  }))
  assert.throws(
    () => provider.loadStaticFlightSnapshot!(malformedRoutesPath),
    /invalid static snapshot routes/,
    'schema 名正确但 routes 损坏时也必须由 loader 截获，runner 才能降级 manual',
  )
} finally {
  rmSync(malformedRoot, { recursive: true, force: true })
}

console.log('STATIC GOLDEN TESTS: parser + snapshot + resolve/fallback contract OK')
