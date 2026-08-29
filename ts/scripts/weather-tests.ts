/**
 * weather 能力层测试(Open-Meteo 真实 API,免费无 key):
 *  1. 地理编码:大理 → 坐标
 *  2. 预报:大理 7 天,字段齐全 + 证据链标注
 *  3. 历史气候:大理去年 8 月(雨季基线)
 *  4. 降级:不可达域名(改 base 的坏请求)返回 ok=false 而非抛错
 *  5. WMO 码映射:已知码有中文,未知码回退
 *  6. 地名别名阶梯(issue #24):「普吉岛」原样无结果 → 别名 Phuket 命中泰国普吉市
 *
 * 运行: cd ts && npx tsx scripts/weather-tests.ts
 */

import assert from 'node:assert/strict'
import { geocodePlace, resolvePlace, getForecast, getClimate, wmoLabel } from '../capabilities/weather.ts'

// 1. 地理编码:「大理市」精确命中云南(「大理」会命中四川同名地——中文地名歧义,API 无行政区优先级)
const geo = await geocodePlace('大理市', { count: 10 })
assert.equal(geo.ok, true, `geocode ok: ${geo.error ?? ''}`)
assert.ok(geo.results.length > 0, '应有结果')
const dali = geo.results.find(r => (r.admin1 ?? '').includes('云南')) ?? geo.results[0]
assert.ok(Math.abs(dali.latitude - 25.6) < 0.5, `纬度应≈25.6,实际 ${dali.latitude}(${dali.name},${dali.admin1})`)
assert.match(geo.evidence, /open-meteo-geo@2/, '证据链带时间戳')
console.log(`1. geocode 大理市 → ${dali.latitude},${dali.longitude} (${dali.name},${dali.admin1}) OK`)

// 2. 预报:大理 7 天
const fc = await getForecast({ latitude: dali.latitude, longitude: dali.longitude }, { days: 7 })
assert.equal(fc.ok, true, `forecast ok: ${fc.error ?? ''}`)
assert.equal(fc.daily!.length, 7, '7 天')
assert.ok(fc.daily![0]!.tempMaxC > -50 && fc.daily![0]!.tempMaxC < 60, '温度合理范围')
assert.match(fc.evidence, /\[实时API:open-meteo@2/, '证据链')
assert.ok(fc.latencyMs < 5000, `延迟应 <5s,实际 ${fc.latencyMs}ms`)
console.log(`2. forecast 大理 7 天:${fc.daily![0]!.tempMinC}–${fc.daily![0]!.tempMaxC}°C ${wmoLabel(fc.daily![0]!.weatherCode)} OK`)

// 3. 历史气候:去年 8 月(雨季基线)
const cl = await getClimate({ latitude: dali.latitude, longitude: dali.longitude }, 8)
assert.equal(cl.ok, true, `climate ok: ${cl.error ?? ''}`)
assert.ok(cl.daily!.length >= 28, '8 月应有 ≥28 天')
assert.match(cl.evidence, /open-meteo-climate@/, '气候证据链')
console.log(`3. climate 大理去年 8 月:${cl.daily!.length} 天 OK`)

// 4. 降级:非法坐标(纬度 999 越界)→ ok=false 不抛错
const bad = await getForecast({ latitude: 999, longitude: 0 }, { timeoutMs: 10_000 })
assert.equal(bad.ok, false, '非法输入应返回 ok=false')
assert.ok(bad.evidence.includes('error'), '降级证据标注')
console.log(`4. 降级 ok=false 不抛错 OK`)

// 5. WMO 码映射
assert.equal(wmoLabel(0), '晴')
assert.equal(wmoLabel(95), '雷暴')
assert.match(wmoLabel(999), /天气码999/, '未知码回退')
console.log('5. WMO 码映射 OK')

// 6. 地名别名阶梯(issue #24):「普吉岛」GeoNames 无条目(zh/en 均无结果),
//    裸「普吉」唯一命中是西藏林芝同名村(人口百级)→ 别名表 Phuket 应命中泰国普吉市
const phuket = await resolvePlace('普吉岛')
assert.equal(phuket.ok, true, `resolvePlace ok: ${phuket.error ?? ''} tried=${phuket.tried.join('/')}`)
assert.ok(phuket.results.length > 0, '普吉岛经别名阶梯应有结果')
const pk = phuket.results[0]
assert.ok(Math.abs(pk.latitude - 7.89) < 0.5, `普吉纬度应≈7.89(泰国普吉市),实际 ${pk.latitude}(${pk.name},${pk.country})`)
assert.ok((pk.country ?? '').includes('泰国'), `应命中泰国,实际 ${pk.country}`)
assert.match(phuket.evidence, /via "Phuket"/, `证据链标注实际命中形式,实际 ${phuket.evidence}`)
const aliasBare = await resolvePlace('普吉')
assert.ok((aliasBare.results[0]?.country ?? '').includes('泰国'), `裸「普吉」别名优先应命中泰国,实际 ${aliasBare.results[0]?.country}`)
console.log(`6. resolvePlace 普吉岛 → ${pk.latitude},${pk.longitude} (${pk.name},${pk.country}) via 别名表 OK`)

console.log('\nWEATHER TESTS: 6/6 OK(Open-Meteo 真实 API,免费无 key)')
