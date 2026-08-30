import assert from 'node:assert/strict'

type ScoreModule = {
  scoreSessionAgainstGoldenBand?: (
    session: Record<string, unknown>,
    band: Record<string, unknown>,
    goldenSource: string,
  ) => {
    pass: boolean
    total: number
    correct: number
    accuracy: number
    missing: string[]
    incorrect: string[]
    golden_source: string
  }
}

const modulePath = '../capabilities/session/golden-score.ts'
const scorer = await import(modulePath).catch(() => ({} as ScoreModule)) as ScoreModule
assert.equal(
  typeof scorer.scoreSessionAgainstGoldenBand,
  'function',
  'soft score 必须从 live runner 抽出，static provider 才能走同一离线评分合同',
)

const band = {
  query_id: 'sf-01',
  from: '上海',
  to: '丽江',
  date: '2026-10-01',
  window_dep_local: { earliest: '06:00', latest: '22:00' },
  window_arr_local: { earliest: '10:00', latest: '23:59' },
  duration_min: { min: 180, max: 720 },
  price_cny: { min: 800, max: 4000 },
  transport_hint: '公开班期承运提示',
  known_flights: ['HO5577', 'MU6145', '9C8779'],
}
const session = {
  query_id: 'sf-01',
  route_segments: [{
    from: '上海',
    to: '丽江',
    departure_at: '2026-10-01T06:45:00+08:00',
    arrival_at: '2026-10-01T10:15:00+08:00',
    transport_number: 'MU6145',
  }],
  journey_type: 'direct',
  currency: 'CNY',
  price: 1200,
  source: 'ctrip-flight',
  fetched_at: '2026-08-30T12:00:00.000Z',
  verdict: 'hit',
  latency_ms: 1200,
  read_guard_blocked: 0,
}

const score = scorer.scoreSessionAgainstGoldenBand!(session, band, 'static-openflights+manual-band')
assert.deepEqual(score, {
  pass: true,
  total: 13,
  correct: 13,
  accuracy: 1,
  missing: [],
  incorrect: [],
  golden_source: 'static-openflights+manual-band',
})

const wrongOrigin = scorer.scoreSessionAgainstGoldenBand!(
  { ...session, route_segments: [{ ...session.route_segments[0]!, from: '广州' }] },
  band,
  'static-openflights+manual-band',
)
assert.equal(wrongOrigin.accuracy, 12 / 13)
assert.equal(wrongOrigin.pass, false, 'from/to 是硬字段；高于 90% 也不能放过错误 OD')
assert.deepEqual(wrongOrigin.incorrect, ['route_segments[0].from'])

const missingPrice = scorer.scoreSessionAgainstGoldenBand!(
  { ...session, price: 0 },
  band,
  'static-openflights+manual-band',
)
assert.equal(missingPrice.total, 13, '价格缺失不能靠缩小分母抬高准确率')
assert.equal(missingPrice.pass, false)
assert.deepEqual(missingPrice.missing, ['price'])

const wrongDate = scorer.scoreSessionAgainstGoldenBand!(
  {
    ...session,
    route_segments: [{
      ...session.route_segments[0]!,
      departure_at: '2026-10-02T06:45:00+08:00',
      arrival_at: '2026-10-02T10:15:00+08:00',
    }],
  },
  band,
  'static-openflights+manual-band',
)
assert.equal(wrongDate.pass, false, '仅 HH:mm 落窗但服务日期错误时必须 fail-closed')
assert.ok(wrongDate.incorrect.includes('route_segments[0].departure_at.date'))
assert.ok(wrongDate.incorrect.includes('route_segments[0].arrival_at.date'))

const wrongSessionSource = scorer.scoreSessionAgainstGoldenBand!(
  { ...session, source: 'manual-golden' },
  band,
  'static-openflights+manual-band',
)
assert.equal(wrongSessionSource.pass, false, 'golden 自身不能冒充待核验的 Ctrip session 来源')
assert.ok(wrongSessionSource.incorrect.includes('source'))

console.log('SF SOFT SCORE TESTS: fixed 13-field score + hard OD/date/session-source fail-closed OK')
