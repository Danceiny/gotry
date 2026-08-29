/**
 * Session 双源字段合同与 fixture 评分器。
 *
 * 只处理已经脱敏、结构化的证据；不打开浏览器、不读登录态，也不执行任何写操作。
 */

export type SessionEvidenceVerdict = 'hit' | 'miss' | 'error' | 'challenged' | 'cooldown' | 'needs-login' | 'needs-attach'

export const SESSION_BENCHMARK_SCHEMA_VERSION = 'session-double-source.v1' as const
export const SESSION_FIELD_ACCURACY_THRESHOLD = 0.9
export const REQUIRED_COMPARABLE_FIELDS = [
  'query_id',
  'route_segments',
  'journey_type',
  'route_segments[].departure_at',
  'route_segments[].arrival_at',
  'route_segments[].transport_number',
  'currency',
  'price',
  'source',
  'fetched_at',
  'verdict',
] as const

export interface SessionComparableSegment {
  from: string
  to: string
  departure_at: string
  arrival_at: string
  transport_number: string
}

export interface SessionComparableRecord {
  query_id: string
  route_segments: SessionComparableSegment[]
  journey_type: 'direct' | 'transfer'
  currency: string
  price: number
  /** 具体通道标识,如 flyai / ctrip-flight;official/session 角色由双源输入位置表达。 */
  source: string
  fetched_at: string
  verdict: SessionEvidenceVerdict
  latency_ms: number
  read_guard_blocked: number
}

export interface SessionFixtureScore {
  pass: boolean
  threshold: number
  correct: number
  total: number
  accuracy: number
  missing: string[]
  incorrect: string[]
  fixture_errors: string[]
}

interface ComparableRecordInput {
  query_id?: unknown
  route_segments?: Array<Partial<SessionComparableSegment>>
  journey_type?: unknown
  currency?: unknown
  price?: unknown
  source?: unknown
  fetched_at?: unknown
  verdict?: unknown
  latency_ms?: unknown
  read_guard_blocked?: unknown
}

interface FieldComparison {
  path: string
  expected: unknown
  actual: unknown
}

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
}

function sameValue(left: unknown, right: unknown): boolean {
  if (typeof left !== typeof right) return false
  return typeof left === 'number' && typeof right === 'number'
    ? Object.is(left, right)
    : left === right
}

function sameComparison(row: FieldComparison): boolean {
  if (/\.(?:departure_at|arrival_at)$/.test(row.path)
    && typeof row.expected === 'string'
    && typeof row.actual === 'string') {
    const expectedAt = Date.parse(row.expected)
    const actualAt = Date.parse(row.actual)
    if (Number.isFinite(expectedAt) && Number.isFinite(actualAt)) return expectedAt === actualAt
  }
  return sameValue(row.expected, row.actual)
}

function fixtureComparisons(expected: SessionComparableRecord, actual: ComparableRecordInput): FieldComparison[] {
  const rows: FieldComparison[] = [
    { path: 'query_id', expected: expected.query_id, actual: actual.query_id },
    { path: 'route_segments.length', expected: expected.route_segments.length, actual: actual.route_segments?.length },
    { path: 'journey_type', expected: expected.journey_type, actual: actual.journey_type },
    { path: 'currency', expected: expected.currency, actual: actual.currency },
    { path: 'price', expected: expected.price, actual: actual.price },
    { path: 'source', expected: expected.source, actual: actual.source },
    { path: 'fetched_at', expected: expected.fetched_at, actual: actual.fetched_at },
    { path: 'verdict', expected: expected.verdict, actual: actual.verdict },
  ]
  for (let index = 0; index < expected.route_segments.length; index += 1) {
    const exp = expected.route_segments[index]!
    const act = actual.route_segments?.[index]
    rows.push(
      { path: `route_segments[${index}].from`, expected: exp.from, actual: act?.from },
      { path: `route_segments[${index}].to`, expected: exp.to, actual: act?.to },
      { path: `route_segments[${index}].departure_at`, expected: exp.departure_at, actual: act?.departure_at },
      { path: `route_segments[${index}].arrival_at`, expected: exp.arrival_at, actual: act?.arrival_at },
      { path: `route_segments[${index}].transport_number`, expected: exp.transport_number, actual: act?.transport_number },
    )
  }
  return rows
}

export function scoreSessionFixture(
  expected: SessionComparableRecord,
  actual: ComparableRecordInput,
  threshold = SESSION_FIELD_ACCURACY_THRESHOLD,
): SessionFixtureScore {
  const rows = fixtureComparisons(expected, actual)
  const fixtureErrors = [
    ...rows.filter((row) => isMissing(row.expected)).map((row) => row.path),
    ...requiredMissing(expected),
  ]
  const missing: string[] = []
  const incorrect: string[] = []
  let correct = 0
  for (const row of rows) {
    if (isMissing(row.actual)) {
      missing.push(row.path)
    } else if (!sameValue(row.expected, row.actual)) {
      incorrect.push(row.path)
    } else {
      correct += 1
    }
  }
  const total = rows.length
  const accuracy = total > 0 ? correct / total : 0
  return {
    pass: fixtureErrors.length === 0 && accuracy >= threshold,
    threshold,
    correct,
    total,
    accuracy,
    missing,
    incorrect,
    fixture_errors: [...new Set(fixtureErrors)],
  }
}

export type DoubleSourceState =
  | 'comparable'
  | 'divergent'
  | 'waiting_attach'
  | 'waiting_login'
  | 'challenge_stop'
  | 'guard_violation'
  | 'source_unavailable'
  | 'invalid_contract'

export interface DoubleSourceEvaluation {
  state: DoubleSourceState
  retry_allowed: boolean
  quota_disposition: 'evidence_ready' | 'no_spend_waiting_user' | 'no_spend_stop'
  mismatches: string[]
  missing: string[]
  price_delta?: number
}

function isIsoTimestamp(value: string): boolean {
  return value.trim() !== '' && Number.isFinite(Date.parse(value))
}

function requiredMissing(record: SessionComparableRecord): string[] {
  const missing: string[] = []
  if (!record.query_id.trim()) missing.push('query_id')
  if (record.route_segments.length === 0) missing.push('route_segments')
  if (!record.currency.trim()) missing.push('currency')
  if (!(record.price > 0)) missing.push('price')
  if (!record.source.trim()) missing.push('source')
  if (!isIsoTimestamp(record.fetched_at)) missing.push('fetched_at')
  if (record.journey_type === 'direct' && record.route_segments.length !== 1) missing.push('journey_type/route_segments')
  if (record.journey_type === 'transfer' && record.route_segments.length < 2) missing.push('journey_type/route_segments')
  for (let index = 0; index < record.route_segments.length; index += 1) {
    const segment = record.route_segments[index]!
    if (!segment.from.trim()) missing.push(`route_segments[${index}].from`)
    if (!segment.to.trim()) missing.push(`route_segments[${index}].to`)
    if (!isIsoTimestamp(segment.departure_at)) missing.push(`route_segments[${index}].departure_at`)
    if (!isIsoTimestamp(segment.arrival_at)) missing.push(`route_segments[${index}].arrival_at`)
    if (!segment.transport_number.trim()) missing.push(`route_segments[${index}].transport_number`)
  }
  return missing
}

function baseEvaluation(
  state: DoubleSourceState,
  quotaDisposition: DoubleSourceEvaluation['quota_disposition'],
  extra: Partial<Pick<DoubleSourceEvaluation, 'mismatches' | 'missing' | 'price_delta'>> = {},
): DoubleSourceEvaluation {
  return {
    state,
    retry_allowed: false,
    quota_disposition: quotaDisposition,
    mismatches: extra.mismatches ?? [],
    missing: extra.missing ?? [],
    ...(extra.price_delta === undefined ? {} : { price_delta: extra.price_delta }),
  }
}

function alignmentComparisons(official: SessionComparableRecord, session: SessionComparableRecord): FieldComparison[] {
  const rows: FieldComparison[] = [
    { path: 'query_id', expected: official.query_id, actual: session.query_id },
    { path: 'route_segments.length', expected: official.route_segments.length, actual: session.route_segments.length },
    { path: 'journey_type', expected: official.journey_type, actual: session.journey_type },
    { path: 'currency', expected: official.currency, actual: session.currency },
  ]
  const comparableSegments = Math.min(official.route_segments.length, session.route_segments.length)
  for (let index = 0; index < comparableSegments; index += 1) {
    const exp = official.route_segments[index]!
    const act = session.route_segments[index]!
    rows.push(
      { path: `route_segments[${index}].from`, expected: exp.from, actual: act.from },
      { path: `route_segments[${index}].to`, expected: exp.to, actual: act.to },
      { path: `route_segments[${index}].departure_at`, expected: exp.departure_at, actual: act.departure_at },
      { path: `route_segments[${index}].arrival_at`, expected: exp.arrival_at, actual: act.arrival_at },
      { path: `route_segments[${index}].transport_number`, expected: exp.transport_number, actual: act.transport_number },
    )
  }
  return rows
}

export function evaluateDoubleSource(input: {
  official?: SessionComparableRecord
  session?: SessionComparableRecord
}): DoubleSourceEvaluation {
  const official = input.official
  const session = input.session
  if (session?.verdict === 'challenged' || official?.verdict === 'challenged') {
    return baseEvaluation('challenge_stop', 'no_spend_stop')
  }
  if ((session?.read_guard_blocked ?? 0) !== 0 || (official?.read_guard_blocked ?? 0) !== 0) {
    return baseEvaluation('guard_violation', 'no_spend_stop')
  }
  if (!session) return baseEvaluation('source_unavailable', 'no_spend_stop')
  if (session.verdict === 'needs-attach') return baseEvaluation('waiting_attach', 'no_spend_waiting_user')
  if (session.verdict === 'needs-login') return baseEvaluation('waiting_login', 'no_spend_waiting_user')
  if (!official || official.verdict !== 'hit' || session.verdict !== 'hit') {
    return baseEvaluation('source_unavailable', 'no_spend_stop')
  }
  const missing = [
    ...requiredMissing(official).map((path) => `official.${path}`),
    ...requiredMissing(session).map((path) => `session.${path}`),
  ]
  if (missing.length > 0) {
    return baseEvaluation('invalid_contract', 'no_spend_stop', { missing })
  }
  const mismatches = alignmentComparisons(official, session)
    .filter((row) => !sameComparison(row))
    .map((row) => row.path)
  return baseEvaluation(mismatches.length === 0 ? 'comparable' : 'divergent', 'evidence_ready', {
    mismatches,
    price_delta: session.price - official.price,
  })
}
