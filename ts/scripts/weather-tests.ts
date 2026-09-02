/**
 * 天气能力层确定性回归：受控 fetch fixture 覆盖行为和时间预算。
 *
 * 真实 Open-Meteo/Nominatim 观测不参与合并闸；本套件必须离线、快速、可重复。
 */
import assert from 'node:assert/strict'
import { geocodePlace, getForecast, getClimate, wmoLabel } from '../capabilities/weather.ts'

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
})
const geoDali = { results: [{ name: '大理市', latitude: 25.6, longitude: 100.2, country: '中国', admin1: '云南省', population: 600000, feature_code: 'PPLA' }] }
const geoPhuket = [{ name: 'Phuket', lat: '7.88', lon: '98.39', address: { country: '泰国', province: '普吉府' } }]
const forecastBody = (days: number) => ({
  timezone: 'Asia/Shanghai',
  daily: {
    time: Array.from({ length: days }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`),
    temperature_2m_max: Array.from({ length: days }, () => 30),
    temperature_2m_min: Array.from({ length: days }, () => 21),
    precipitation_probability_max: Array.from({ length: days }, () => 60),
    weathercode: Array.from({ length: days }, () => 61),
  },
})
const climateBodyFor = (year: number, month: number) => {
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const monthText = String(month).padStart(2, '0')
  return { daily: { time: Array.from({ length: days }, (_, i) => `${year}-${monthText}-${String(i + 1).padStart(2, '0')}`), temperature_2m_max: Array(days).fill(29), temperature_2m_min: Array(days).fill(21), weathercode: Array(days).fill(2) } }
}
const climateBody = climateBodyFor(2025, 8)

type FetchMock = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
const mockFetch = (handler: (url: string, signal: AbortSignal) => unknown | Promise<unknown>): FetchMock =>
  async (input, init) => jsonResponse(await handler(String(input), init?.signal ?? new AbortController().signal))

// 1. 地理编码主源命中 + schema/别名正常路径
const geo = await geocodePlace('大理市', { count: 10, fetchImpl: mockFetch(() => geoDali) })
assert.equal(geo.ok, true)
assert.equal(geo.via, 'open-meteo')
assert.ok(Math.abs(geo.results[0]!.latitude - 25.6) < 0.5)
assert.match(geo.evidence, /open-meteo-geo@2/)
console.log('1. geocode 主源命中 + alias/schema OK')

// 2. 零结果进入 Nominatim 兜底，并保持正确国家/坐标
const seenRequests: Array<{ url: string; headers: Headers }> = []
const phuket = await geocodePlace('普吉岛', { count: 3, fetchImpl: async (input, init) => {
  seenRequests.push({ url: String(input), headers: new Headers(init?.headers) })
  return jsonResponse(String(input).includes('nominatim') ? geoPhuket : { results: [] })
} })
assert.equal(phuket.ok, true)
assert.equal(phuket.via, 'nominatim')
assert.match(phuket.results[0]!.country ?? '', /泰国/)
assert.ok(Math.abs(phuket.results[0]!.latitude - 8) < 0.5)
assert.match(seenRequests[0]!.url, /name=%E6%99%AE%E5%90%89%E5%B2%9B.*count=3.*language=zh/)
assert.match(seenRequests[1]!.url, /q=%E6%99%AE%E5%90%89%E5%B2%9B.*limit=3.*accept-language=zh/)
assert.match(seenRequests[1]!.headers.get('user-agent') ?? '', /gotry-travel-agent/)
const badAddress = await geocodePlace('坏地址', { fetchImpl: mockFetch((url) => url.includes('nominatim') ? [{ name: 'X', lat: '1', lon: '2', address: { country: {}, province: 7 } }] : { results: [] }) })
assert.equal(badAddress.ok, true)
assert.equal('country' in badAddress.results[0]!, false)
assert.equal('admin1' in badAddress.results[0]!, false)
console.log('2. geocode 兜底链 + 地名 alias OK')

// 3. 预报正常 schema
const fc = await getForecast({ latitude: 25.6, longitude: 100.2 }, { days: 7, fetchImpl: mockFetch(() => forecastBody(7)) })
assert.equal(fc.ok, true)
assert.equal(fc.daily?.length, 7)
assert.equal(fc.daily?.[0]?.weatherCode, 61)
assert.ok(fc.latencyMs < 1000)
console.log('3. forecast schema/行为 OK')

// 4. 慢 forecast 必须在受控 timeout 内 graceful fallback（不抛错）
const slow = mockFetch((_url, signal) => new Promise((_, reject) => {
  const abort = () => reject(new Error('This operation was aborted'))
  if (signal.aborted) abort()
  else signal.addEventListener('abort', abort, { once: true })
  setTimeout(() => reject(new Error('late response')), 250)
}))
const slowStarted = Date.now()
const slowFc = await getForecast({ latitude: 25.6, longitude: 100.2 }, { timeoutMs: 25, fetchImpl: slow })
assert.equal(slowFc.ok, false)
assert.ok(Date.now() - slowStarted < 150, 'slow forecast must respect timeout')
assert.match(slowFc.evidence, /error/)
const never = mockFetch(() => new Promise<never>(() => undefined))
const neverStarted = Date.now()
const neverFc = await getForecast({ latitude: 25.6, longitude: 100.2 }, { timeoutMs: 20, fetchImpl: never })
assert.equal(neverFc.ok, false)
assert.ok(Date.now() - neverStarted < 150, 'hard deadline must cover a fetch that ignores abort')
const neverBody = await getForecast({ latitude: 25.6, longitude: 100.2 }, { timeoutMs: 20, fetchImpl: async () => ({ ok: true, json: () => new Promise<never>(() => undefined) } as unknown as Response) })
assert.equal(neverBody.ok, false, 'hard deadline must cover a body decoder that never settles')
let lateResolve: ((value: unknown) => void) | undefined
const lateResolveResult = await getForecast({ latitude: 25.6, longitude: 100.2 }, {
  timeoutMs: 10,
  fetchImpl: async () => ({ ok: true, json: () => new Promise(resolve => { lateResolve = resolve }) } as unknown as Response),
})
assert.equal(lateResolveResult.ok, false)
lateResolve?.(forecastBody(7))
let lateReject: ((reason?: unknown) => void) | undefined
const lateRejectResult = await getForecast({ latitude: 25.6, longitude: 100.2 }, {
  timeoutMs: 10,
  fetchImpl: async () => ({ ok: true, json: () => new Promise((_, reject) => { lateReject = reject }) } as unknown as Response),
})
assert.equal(lateRejectResult.ok, false)
lateReject?.(Object.create(null))
await new Promise<void>(resolve => setImmediate(resolve))
console.log('4. slow forecast timeout + graceful fallback OK')

// 5. 双源 fallback 的总预算：主源耗尽预算时不再发第二个请求。
let calls = 0
const slowBoth = mockFetch((_url, signal) => {
  calls += 1
  return new Promise((_, reject) => {
    const abort = () => reject(new Error('network timeout'))
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
})
const chainStarted = Date.now()
const chain = await geocodePlace('不存在的地方', { timeoutMs: 35, fetchImpl: slowBoth })
assert.equal(chain.ok, false)
assert.equal(calls, 1, 'an exhausted primary budget must not start fallback')
assert.ok(Date.now() - chainStarted < 150, 'fallback chain must share one total budget')
assert.match(chain.evidence, /open-meteo-geo@error/)
let fastPrimaryCalls = 0
let fastFallbackCalls = 0
const fallbackAfterFastFailure = await geocodePlace('不存在的地方', { timeoutMs: 100, fetchImpl: async (input, init) => {
  if (String(input).includes('nominatim')) { fastFallbackCalls += 1; return jsonResponse([]) }
  fastPrimaryCalls += 1
  throw new Error('ECONNRESET')
} })
assert.equal(fallbackAfterFastFailure.ok, false)
assert.equal(fastPrimaryCalls, 1, 'primary should be attempted once')
assert.equal(fastFallbackCalls, 1, 'a fast primary failure should still attempt fallback once')
const network = await getForecast({ latitude: 25.6, longitude: 100.2 }, { fetchImpl: mockFetch(() => { throw new Error('ECONNRESET') }) })
assert.equal(network.ok, false)
assert.match(network.error ?? '', /ECONNRESET/)
const httpError = await getForecast({ latitude: 25.6, longitude: 100.2 }, { fetchImpl: async () => jsonResponse({}, 503) })
assert.equal(httpError.ok, false)
assert.match(httpError.error ?? '', /HTTP 503/)
const malformedGeo = await geocodePlace('坏响应', { timeoutMs: 100, fetchImpl: mockFetch((url) => url.includes('nominatim') ? {} : { results: {} }) })
assert.equal(malformedGeo.ok, false)
console.log('5. slow geocode + strict fallback budget + network/HTTP errors OK')

// 6. climate schema、malformed schema、WMO mapping
const cl = await getClimate({ latitude: 25.6, longitude: 100.2 }, 8, { year: 2025, fetchImpl: mockFetch(() => climateBody) })
assert.equal(cl.ok, true)
assert.equal(cl.daily?.length, 31)
const malformed = await getForecast({ latitude: 25.6, longitude: 100.2 }, { days: 7, fetchImpl: mockFetch(() => ({ daily: { time: [] } })) })
assert.equal(malformed.ok, false)
const malformedElement = await getForecast({ latitude: 25.6, longitude: 100.2 }, { days: 7, fetchImpl: mockFetch(() => ({ daily: { ...forecastBody(7).daily, temperature_2m_max: [30, 'bad', 30, 30, 30, 30, 30] } })) })
assert.equal(malformedElement.ok, false)
const wrongPrecip = await getForecast({ latitude: 25.6, longitude: 100.2 }, { days: 7, fetchImpl: mockFetch(() => ({ daily: { ...forecastBody(7).daily, precipitation_probability_max: 'bad' } })) })
assert.equal(wrongPrecip.ok, false)
const wrongPrecipObject = await getForecast({ latitude: 25.6, longitude: 100.2 }, { days: 7, fetchImpl: mockFetch(() => ({ daily: { ...forecastBody(7).daily, precipitation_probability_max: {} } })) })
assert.equal(wrongPrecipObject.ok, false)
const absentPrecip = { daily: { ...forecastBody(7).daily } }
delete (absentPrecip.daily as { precipitation_probability_max?: unknown }).precipitation_probability_max
const forecastAbsentPrecip = await getForecast({ latitude: 25.6, longitude: 100.2 }, { fetchImpl: mockFetch(() => absentPrecip) })
assert.equal(forecastAbsentPrecip.ok, true)
assert.equal(forecastAbsentPrecip.daily?.[0]?.precipProbMaxPct, null)
const forecastNullPrecip = await getForecast({ latitude: 25.6, longitude: 100.2 }, { fetchImpl: mockFetch(() => ({ daily: { ...forecastBody(7).daily, precipitation_probability_max: null } })) })
assert.equal(forecastNullPrecip.ok, true)
assert.equal(forecastNullPrecip.daily?.[0]?.precipProbMaxPct, null)
const forecastValidPrecip = await getForecast({ latitude: 25.6, longitude: 100.2 }, { fetchImpl: mockFetch(() => forecastBody(7)) })
assert.equal(forecastValidPrecip.ok, true)
assert.equal(forecastValidPrecip.daily?.[0]?.precipProbMaxPct, 60)
const nullClimate = await getClimate({ latitude: 25.6, longitude: 100.2 }, 8, { fetchImpl: mockFetch(() => null) })
assert.equal(nullClimate.ok, false)
const slowClimate = await getClimate({ latitude: 25.6, longitude: 100.2 }, 8, { timeoutMs: 20, fetchImpl: slow })
assert.equal(slowClimate.ok, false)
const shortClimate = await getClimate({ latitude: 25.6, longitude: 100.2 }, 8, { fetchImpl: mockFetch(() => ({ daily: { ...climateBody.daily, time: ['2025-08-01'], temperature_2m_max: [29], temperature_2m_min: [21], weathercode: [2] } })) })
assert.equal(shortClimate.ok, false)
for (const badDays of [0, Number.NaN, 2.5]) {
  let fetches = 0
  const invalid = await getForecast({ latitude: 25.6, longitude: 100.2 }, { days: badDays, fetchImpl: mockFetch(() => { fetches += 1; return forecastBody(7) }) })
  assert.equal(invalid.ok, false)
  assert.equal(fetches, 0)
}
for (const badTimeout of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2.5]) {
  let forecastFetches = 0
  const invalidForecast = await getForecast({ latitude: 25.6, longitude: 100.2 }, { timeoutMs: badTimeout, fetchImpl: mockFetch(() => { forecastFetches += 1; return forecastBody(7) }) })
  assert.equal(invalidForecast.ok, false)
  assert.equal(forecastFetches, 0, `invalid forecast timeout ${String(badTimeout)} must not fetch`)
  let climateFetches = 0
  const invalidClimateTimeout = await getClimate({ latitude: 25.6, longitude: 100.2 }, 8, { timeoutMs: badTimeout, fetchImpl: mockFetch(() => { climateFetches += 1; return climateBody }) })
  assert.equal(invalidClimateTimeout.ok, false)
  assert.equal(climateFetches, 0, `invalid climate timeout ${String(badTimeout)} must not fetch`)
  let geoFetches = 0
  const invalidGeoTimeout = await geocodePlace('大理市', { timeoutMs: badTimeout, fetchImpl: mockFetch(() => { geoFetches += 1; return geoDali }) })
  assert.equal(invalidGeoTimeout.ok, false)
  assert.equal(geoFetches, 0, `invalid geocode timeout ${String(badTimeout)} must not fetch`)
}
let cappedDays = ''
const capped = await getForecast({ latitude: 25.6, longitude: 100.2 }, { days: 99, fetchImpl: async (input) => { cappedDays = String(input); return jsonResponse(forecastBody(16)) } })
assert.equal(capped.ok, true)
assert.match(cappedDays, /forecast_days=16/)
const wrongMonth = await getClimate({ latitude: 25.6, longitude: 100.2 }, 9, { year: 2025, fetchImpl: mockFetch(() => climateBody) })
assert.equal(wrongMonth.ok, false)
const leapBody = { daily: { time: Array.from({ length: 29 }, (_, i) => `2024-02-${String(i + 1).padStart(2, '0')}`), temperature_2m_max: Array(29).fill(10), temperature_2m_min: Array(29).fill(1), weathercode: Array(29).fill(0) } }
const leap = await getClimate({ latitude: 25.6, longitude: 100.2 }, 2, { year: 2024, fetchImpl: mockFetch(() => leapBody) })
assert.equal(leap.ok, true)
const historicalMinimum = await getClimate({ latitude: 25.6, longitude: 100.2 }, 8, { year: 1940, fetchImpl: mockFetch(() => climateBodyFor(1940, 8)) })
assert.equal(historicalMinimum.ok, true)
const currentYear = new Date().getUTCFullYear()
const currentClimate = await getClimate({ latitude: 25.6, longitude: 100.2 }, 8, { year: currentYear, fetchImpl: mockFetch(() => climateBodyFor(currentYear, 8)) })
assert.equal(currentClimate.ok, true)
for (const badYear of [1939, 2025.5, currentYear + 1]) {
  let yearFetches = 0
  const invalidYear = await getClimate({ latitude: 25.6, longitude: 100.2 }, 8, { year: badYear, fetchImpl: mockFetch(() => { yearFetches += 1; return climateBody }) })
  assert.equal(invalidYear.ok, false)
  assert.equal(yearFetches, 0, `invalid climate year ${String(badYear)} must not fetch`)
}
const duplicateDayBody = climateBodyFor(2025, 8)
duplicateDayBody.daily.time[1] = duplicateDayBody.daily.time[0]!
const duplicateDay = await getClimate({ latitude: 25.6, longitude: 100.2 }, 8, { year: 2025, fetchImpl: mockFetch(() => duplicateDayBody) })
assert.equal(duplicateDay.ok, false)
const day99Body = climateBodyFor(2025, 8)
day99Body.daily.time[0] = '2025-08-99'
const day99 = await getClimate({ latitude: 25.6, longitude: 100.2 }, 8, { year: 2025, fetchImpl: mockFetch(() => day99Body) })
assert.equal(day99.ok, false)
let invalidClimateFetches = 0
const invalidClimate = await getClimate({ latitude: 25.6, longitude: 100.2 }, 13, { year: 2025, fetchImpl: mockFetch(() => { invalidClimateFetches += 1; return climateBody }) })
assert.equal(invalidClimate.ok, false)
assert.equal(invalidClimateFetches, 0)
let geoZeroFetches = 0
const geoZero = await geocodePlace('大理市', { timeoutMs: 0, fetchImpl: mockFetch(() => { geoZeroFetches += 1; return geoDali }) })
assert.equal(geoZero.ok, false)
assert.equal(geoZeroFetches, 0)
let climateZeroFetches = 0
const climateZero = await getClimate({ latitude: 25.6, longitude: 100.2 }, 8, { timeoutMs: 0, fetchImpl: mockFetch(() => { climateZeroFetches += 1; return climateBody }) })
assert.equal(climateZero.ok, false)
assert.equal(climateZeroFetches, 0)
let primaryResolutionFetches = 0
const originalPerformanceNow = performance.now
Object.defineProperty(performance, 'now', { configurable: true, value: (() => {
  const values = [100, 104.5, 104.5]
  return () => values.shift() ?? 104.5
})() })
try {
  const primaryResolution = await geocodePlace('剩余不足一毫秒', { timeoutMs: 5, fetchImpl: mockFetch(() => { primaryResolutionFetches += 1; return geoDali }) })
  assert.equal(primaryResolution.ok, false)
  assert.equal(primaryResolutionFetches, 0, 'sub-millisecond primary budget must not fetch')
} finally {
  Object.defineProperty(performance, 'now', { configurable: true, value: originalPerformanceNow })
}
let primaryBudgetFetches = 0
let fallbackResolutionFetches = 0
Object.defineProperty(performance, 'now', { configurable: true, value: (() => {
  const values = [200, 200, 205]
  return () => values.shift() ?? 205
})() })
try {
  const fallbackResolution = await geocodePlace('兜底剩余不足一毫秒', { timeoutMs: 5, fetchImpl: async input => {
    if (String(input).includes('nominatim')) {
      fallbackResolutionFetches += 1
      return jsonResponse([])
    }
    primaryBudgetFetches += 1
    return jsonResponse({ results: [] })
  } })
  assert.equal(fallbackResolution.ok, false)
  assert.equal(primaryBudgetFetches, 1)
  assert.equal(fallbackResolutionFetches, 0, 'sub-millisecond fallback budget must not fetch')
} finally {
  Object.defineProperty(performance, 'now', { configurable: true, value: originalPerformanceNow })
}
const nonErrorRejection = await getForecast({ latitude: 25.6, longitude: 100.2 }, { fetchImpl: async () => { throw Object.create(null) } })
assert.equal(nonErrorRejection.ok, false)
assert.equal(nonErrorRejection.error, 'request failed')
const symbolRejection = await getForecast({ latitude: 25.6, longitude: 100.2 }, { fetchImpl: async () => { throw Symbol('untrusted') } })
assert.equal(symbolRejection.ok, false)
assert.equal(symbolRejection.error, 'request failed')
const originalDateNow = Date.now
Date.now = () => 0
try {
  const rollback = await getForecast({ latitude: 25.6, longitude: 100.2 }, { timeoutMs: 20, fetchImpl: mockFetch(() => forecastBody(7)) })
  assert.equal(rollback.ok, true, 'wall-clock rollback must not expand or break monotonic budget')
} finally {
  Date.now = originalDateNow
}
assert.equal(wmoLabel(0), '晴')
assert.equal(wmoLabel(95), '雷暴')
assert.match(wmoLabel(999), /天气码999/)
console.log('6. climate/schema guard/WMO OK')

console.log('\nWEATHER TESTS: deterministic 6/6 OK (live APIs are peripheral smoke only)')
