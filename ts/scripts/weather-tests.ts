/**
 * 天气能力层确定性回归：受控 fetch fixture 覆盖行为和时间预算。
 *
 * 真实 Open-Meteo/Nominatim 是可变外围观测，不参与合并闸；需要时可单独
 * 运行 WEATHER_LIVE_SMOKE=1 做人工 smoke。本套件必须离线、快速、可重复。
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
const climateBody = { daily: { time: Array.from({ length: 31 }, (_, i) => `2025-08-${String(i + 1).padStart(2, '0')}`), temperature_2m_max: Array(31).fill(29), temperature_2m_min: Array(31).fill(21), weathercode: Array(31).fill(2) } }

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
const phuket = await geocodePlace('普吉岛', { fetchImpl: mockFetch((url) => url.includes('nominatim') ? geoPhuket : { results: [] }) })
assert.equal(phuket.ok, true)
assert.equal(phuket.via, 'nominatim')
assert.match(phuket.results[0]!.country ?? '', /泰国/)
assert.ok(Math.abs(phuket.results[0]!.latitude - 8) < 0.5)
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
console.log('4. slow forecast timeout + graceful fallback OK')

// 5. 双源 fallback 的总预算（两个请求共享 timeoutMs），并检查网络错误终态
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
assert.equal(calls, 2, 'primary and fallback should both be attempted')
assert.ok(Date.now() - chainStarted < 150, 'fallback chain must share one total budget')
assert.match(chain.evidence, /open-meteo-geo@error/)
const network = await getForecast({ latitude: 25.6, longitude: 100.2 }, { fetchImpl: mockFetch(() => { throw new Error('ECONNRESET') }) })
assert.equal(network.ok, false)
assert.match(network.error ?? '', /ECONNRESET/)
console.log('5. slow geocode + fallback total budget + network error OK')

// 6. climate schema、malformed schema、WMO mapping
const cl = await getClimate({ latitude: 25.6, longitude: 100.2 }, 8, { year: 2025, fetchImpl: mockFetch(() => climateBody) })
assert.equal(cl.ok, true)
assert.equal(cl.daily?.length, 31)
const malformed = await getForecast({ latitude: 25.6, longitude: 100.2 }, { days: 7, fetchImpl: mockFetch(() => ({ daily: { time: [] } })) })
assert.equal(malformed.ok, false)
assert.equal(wmoLabel(0), '晴')
assert.equal(wmoLabel(95), '雷暴')
assert.match(wmoLabel(999), /天气码999/)
console.log('6. climate/schema guard/WMO OK')

console.log('\nWEATHER TESTS: deterministic 6/6 OK (live APIs are peripheral smoke only)')
