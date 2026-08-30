import {
  SESSION_FIELD_ACCURACY_THRESHOLD,
  type SessionComparableRecord,
} from './benchmark.ts'

export interface GoldenBand {
  query_id: string
  from: string
  to: string
  date: string
  window_dep_local: { earliest: string; latest: string }
  window_arr_local: { earliest: string; latest: string }
  duration_min: { min: number; max: number }
  price_cny: { min: number; max: number }
  transport_hint: string
  known_flights: string[]
}

export interface GoldenSoftScore {
  pass: boolean
  total: number
  correct: number
  accuracy: number
  missing: string[]
  incorrect: string[]
  golden_source: string
}

function parseHHmm(value: string): number {
  const [hours, minutes] = value.split(':')
  return parseInt(hours!, 10) * 60 + parseInt(minutes!, 10)
}

function parseLocalMinutes(value: string): number | null {
  const match = value.match(/(\d{2}):(\d{2})/)
  if (!match) return null
  return parseInt(match[1]!, 10) * 60 + parseInt(match[2]!, 10)
}

function parseLocalDate(value: string): string | null {
  return value.match(/^(\d{4}-\d{2}-\d{2})[T ]/)?.[1] ?? null
}

export function scoreSessionAgainstGoldenBand(
  session: SessionComparableRecord,
  band: GoldenBand,
  goldenSource: string,
): GoldenSoftScore {
  const missing: string[] = []
  const hardIncorrect: string[] = []
  const segment = session.route_segments[0]

  if (!session.query_id) missing.push('query_id')
  else if (session.query_id !== band.query_id) hardIncorrect.push('query_id')
  if (!session.currency) missing.push('currency')
  else if (session.currency !== 'CNY') hardIncorrect.push('currency')
  if (!session.source) missing.push('source')
  else if (session.source !== 'ctrip-flight') hardIncorrect.push('source')
  if (!session.verdict) missing.push('verdict')
  else if (session.verdict !== 'hit') hardIncorrect.push('verdict')

  if (!segment) {
    missing.push(
      'route_segments[0].from',
      'route_segments[0].to',
      'route_segments[0].departure_at',
      'route_segments[0].arrival_at',
      'route_segments[0].transport_number',
    )
  } else {
    if (!segment.from) missing.push('route_segments[0].from')
    else if (segment.from !== band.from) hardIncorrect.push('route_segments[0].from')
    if (!segment.to) missing.push('route_segments[0].to')
    else if (segment.to !== band.to) hardIncorrect.push('route_segments[0].to')
    if (!segment.departure_at) missing.push('route_segments[0].departure_at')
    else if (parseLocalDate(segment.departure_at) !== band.date) {
      hardIncorrect.push('route_segments[0].departure_at.date')
    }
    if (!segment.arrival_at) missing.push('route_segments[0].arrival_at')
    else if (parseLocalDate(segment.arrival_at) !== band.date) {
      hardIncorrect.push('route_segments[0].arrival_at.date')
    }
    if (!segment.transport_number) missing.push('route_segments[0].transport_number')
  }

  const softChecks: Array<{ path: string; ok: boolean }> = []
  if (segment?.departure_at) {
    const minutes = parseLocalMinutes(segment.departure_at)
    softChecks.push({
      path: 'route_segments[0].departure_at',
      ok: minutes !== null
        && minutes >= parseHHmm(band.window_dep_local.earliest)
        && minutes <= parseHHmm(band.window_dep_local.latest),
    })
  }
  if (segment?.arrival_at) {
    const minutes = parseLocalMinutes(segment.arrival_at)
    softChecks.push({
      path: 'route_segments[0].arrival_at',
      ok: minutes !== null
        && minutes >= parseHHmm(band.window_arr_local.earliest)
        && minutes <= parseHHmm(band.window_arr_local.latest),
    })
  }
  if (segment?.transport_number) {
    const actual = segment.transport_number.toUpperCase()
    softChecks.push({
      path: 'route_segments[0].transport_number',
      ok: band.known_flights.some((flight) => actual.startsWith(flight.toUpperCase()))
        || band.known_flights.some((flight) => actual.includes(flight.toUpperCase().slice(0, 2))),
    })
  }
  if (Number.isFinite(session.price) && session.price > 0) {
    const margin = band.price_cny.max * 0.15
    softChecks.push({
      path: 'price',
      ok: session.price >= band.price_cny.min - margin
        && session.price <= band.price_cny.max + margin,
    })
  } else missing.push('price')

  const softIncorrect = softChecks.filter((check) => !check.ok).map((check) => check.path)
  const incorrect = [...hardIncorrect, ...softIncorrect]
  // 合同字段固定为 13，缺字段不能靠缩小分母抬高准确率。
  const total = 13
  const correct = Math.max(0, total - new Set(missing).size - incorrect.length)
  const accuracy = total > 0 ? correct / total : 0
  return {
    pass: missing.length === 0
      && hardIncorrect.length === 0
      && accuracy >= SESSION_FIELD_ACCURACY_THRESHOLD,
    total,
    correct,
    accuracy,
    missing: Array.from(new Set(missing)),
    incorrect,
    golden_source: goldenSource,
  }
}
