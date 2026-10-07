/** Public supplier city metadata, independent of inventory and account sessions. */
export const CTRIP_CITY_CATALOG_URL = 'https://m.ctrip.com/restapi/soa2/17909/SearchBoxRecommend'
export const CTRIP_CITY_SUGGEST_URL = 'https://flights.ctrip.com/international/search/api/poi/search'
export const CTRIP_HOTEL_CITY_URL = 'https://m.ctrip.com/restapi/soa2/34951/getHotelKeywords'
export interface CtripCity {
  name: string
  code: string
  aliases: string[]
  context?: string
  airport?: boolean
  requiresQualification?: boolean
}
export type CityResolution =
  | { ok: true; city: CtripCity }
  | { ok: false; reason: 'ambiguous' | 'not-found' | 'unavailable'; candidates: CtripCity[] }
const normalized = (s: string) => s.normalize('NFKC').trim().replace(/^中国(?=香港|澳门)/, '').toLowerCase()
const text = (v: unknown) => typeof v === 'string' ? v.trim() : ''
const code = (v: unknown) => /^[a-z]{3}$/i.test(text(v)) ? text(v).toUpperCase() : undefined
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}

export function parseCtripCityCatalog(value: unknown): CtripCity[] {
  const root = object(value)
  if (object(root.ResponseStatus).Ack !== 'Success' || object(root.responseHead).errorCode !== '0' || !Array.isArray(root.recommendGroupList)) throw new Error('unrecognized city catalog')
  const records: CtripCity[] = []
  let visited = 0
  const walk = (v: unknown, depth = 0) => {
    if (++visited > 20_000 || depth > 12) throw new Error('city catalog bounds')
    if (Array.isArray(v)) { for (const item of v) walk(item, depth + 1); return }
    const r = object(v), c = code(r.code), name = text(r.name)
    if (c && name && Number(r.id) > 0) {
      records.push({ name, code: c, aliases: [name, text(r.eName), text(r.nameEn), text(r.namePy), text(r.specName)].filter(Boolean), context: text(r.specName) || undefined, requiresQualification: r.sameSpecCity === 1 })
      if (Array.isArray(r.airportlst)) for (const item of r.airportlst) {
        const a = object(item), ac = code(a.code), an = text(a.name)
        if (ac && an) records.push({ name: an, code: ac, aliases: [an], context: name, airport: true })
      }
    }
    for (const [key, child] of Object.entries(r)) if (key !== 'airportlst' && child && typeof child === 'object') walk(child, depth + 1)
  }
  walk(root.recommendGroupList)
  return records
}

export function parseCtripCitySuggestions(value: unknown): CtripCity[] {
  const root = object(value)
  if (!Array.isArray(root.Data)) throw new Error('unrecognized city suggestions')
  const records: CtripCity[] = []
  let visited = 0
  const walk = (items: unknown[], depth = 0) => {
    if (depth > 5) throw new Error('city suggestion bounds')
    for (const value of items) {
      if (++visited > 2_000) throw new Error('city suggestion bounds')
      const r = object(value), c = code(r.Code), name = text(r.Name)
      if (c && name && [3, 4, 5].includes(Number(r.Type))) records.push({
        name, code: c, aliases: [name, text(r.EName), text(r.NameAlias), text(r.ShortSpell)].filter(Boolean),
        context: [text(r.Country), text(r.Province)].filter(Boolean).join(' / ') || undefined, airport: Number(r.Type) === 3,
      })
      if (Array.isArray(r.Datas)) walk(r.Datas, depth + 1)
      // Nearby cities must not be substituted for the requested destination.
    }
  }
  walk(root.Data)
  return records
}

export function matchCtripCity(query: string, records: CtripCity[]): CityResolution {
  const input = normalized(query)
  const matches = records.filter(r => r.code.toLowerCase() === input || r.aliases.some(a => normalized(a) === input))
  const unique = [...new Map(matches.map(r => [`${r.code}:${r.context ?? ''}`, r])).values()]
  // A city and its airport may share one code. An explicitly typed code remains exact.
  const codes = new Set(unique.map(r => r.code))
  if (codes.size === 1 && /^[a-z]{3}$/i.test(query.trim())) return { ok: true, city: unique[0]! }
  if (unique.length === 1 && (!unique[0]!.requiresQualification || normalized(unique[0]!.context ?? '') === input)) return { ok: true, city: unique[0]! }
  return { ok: false, reason: unique.length ? 'ambiguous' : 'not-found', candidates: unique.slice(0, 8) }
}

type CityFetch = typeof fetch
async function readMetadata(url: string, init: RequestInit, fetcher: CityFetch): Promise<unknown> {
  const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(8_000), redirect: 'error' })
  if (!response.ok || !response.body) throw new Error('city metadata unavailable')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 512_000) throw new Error('city metadata bounds')
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally { await reader.cancel().catch(() => {}) }
}
let catalog: { at: number; promise: Promise<CtripCity[]> } | undefined
const catalogBody = {
  head: { cver: '3', cid: '', extension: [{ name: 'source', value: 'ONLINE' }, { name: 'sotpGroup', value: 'CTrip' }, { name: 'sotpLocale', value: 'zh-CN' }] },
  locale: 'zh-CN', departureCity: '', dataType: 0,
}
export async function resolveCtripFlightCity(query: string, fetcher: CityFetch = fetch): Promise<CityResolution> {
  if (!query.trim() || query.length > 120) return { ok: false, reason: 'not-found', candidates: [] }
  if (fetcher === fetch && process.env.GOTRY_SESSION_LIVE === '0') return { ok: false, reason: 'unavailable', candidates: [] }
  try {
    const load = () => readMetadata(CTRIP_CITY_CATALOG_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(catalogBody) }, fetcher).then(parseCtripCityCatalog)
    let records: CtripCity[]
    if (fetcher !== fetch) records = await load()
    else {
      if (!catalog || Date.now() - catalog.at > 3_600_000) catalog = { at: Date.now(), promise: load() }
      try { records = await catalog.promise } catch { catalog = undefined; records = [] }
    }
    const matched = matchCtripCity(query, records)
    if (matched.ok || matched.reason === 'ambiguous') return matched
    const url = new URL(CTRIP_CITY_SUGGEST_URL)
    url.searchParams.set('key', query.trim().toUpperCase())
    url.searchParams.set('filterAirport', 'false')
    return matchCtripCity(query, parseCtripCitySuggestions(await readMetadata(url.href, {}, fetcher)))
  } catch { return { ok: false, reason: 'unavailable', candidates: [] } }
}

export function cityResolutionHint(query: string, result: Exclude<CityResolution, { ok: true }>): string {
  if (result.reason === 'ambiguous') return `城市「${query}」有多个候选，请确认城市或机场码：${result.candidates.map(c => `${c.name} ${c.code}${c.context ? `（${c.context}）` : ''}`).join('；')}`
  return `unresolved 城市「${query}」：${result.reason === 'unavailable' ? '携程城市解析服务暂不可用' : '供应商城市候选未精确匹配'}；请确认城市／机场名称，或提供 fromCityCode／toCityCode。城市解析失败不能证明该航线无库存或不受支持。`
}

export interface CtripHotelCity { id: string; name: string; aliases: string[]; countries: string[]; context: string }
export type HotelCityResolution = { ok: true; city: CtripHotelCity } | { ok: false; reason: 'ambiguous' | 'not-found' | 'unavailable'; candidates: CtripHotelCity[] }
export function parseCtripHotelCities(value: unknown): CtripHotelCity[] {
  const root = object(value), data = object(root.data), keywords = object(data.mainKeywordList).keywords
  if (object(root.ResponseStatus).Ack !== 'Success' || data.htlSpiderActionErrorCode || !Array.isArray(keywords) || keywords.length > 1_000) throw new Error('hotel city metadata unavailable')
  const records: CtripHotelCity[] = []
  for (const item of keywords) {
    const r = object(item), k = object(object(r.keyword).keywordContentInfo), region = object(object(r.controlInfo).regionInfo)
    const display = object(region.displayCityModel), basic = object(region.basicCityModel), id = String(basic.cityId ?? '')
    if (k.tripType !== 'CT' || !/^[1-9]\d{0,9}$/.test(id)) continue
    if (k.keywordCode !== undefined && String(k.keywordCode) !== id) throw new Error('hotel city ID conflict')
    const titles = Array.isArray(k.displayTexts) ? k.displayTexts.map(object).filter(t => t.key === 'MAIN_TITLE').map(t => text(t.value)) : []
    const name = text(display.cityName) || text(display.destinationName)
    if (!name) continue
    records.push({ id, name, aliases: [name, text(display.destinationName), text(display.destinationNameEN), ...titles].filter(Boolean),
      countries: [text(display.countryName), text(display.countryNameEN)].filter(Boolean),
      context: [text(display.countryName), text(display.provinceName)].filter(Boolean).join(' / ') })
  }
  return records
}
export async function resolveCtripHotelCity(query: string, country?: string, fetcher: CityFetch = fetch): Promise<HotelCityResolution> {
  if (!query.trim() || query.length > 120 || (country?.length ?? 0) > 120) return { ok: false, reason: 'not-found', candidates: [] }
  if (fetcher === fetch && process.env.GOTRY_SESSION_LIVE === '0') return { ok: false, reason: 'unavailable', candidates: [] }
  try {
    const value = await readMetadata(CTRIP_HOTEL_CITY_URL, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ head: { platform: 'PC', bu: 'HBU', group: 'ctrip', locale: 'zh-CN' }, queryInfo: { keyword: query.trim(), actionType: 'destination' } }) }, fetcher)
    const input = normalized(query)
    const candidates = parseCtripHotelCities(value).filter(c => (!country || c.countries.some(a => normalized(a) === normalized(country))) && c.aliases.some(a => normalized(a) === input))
    const unique = [...new Map(candidates.map(c => [c.id, c])).values()]
    return unique.length === 1 ? { ok: true, city: unique[0]! } : { ok: false, reason: unique.length ? 'ambiguous' : 'not-found', candidates: unique.slice(0, 8) }
  } catch { return { ok: false, reason: 'unavailable', candidates: [] } }
}
export function hotelResolutionHint(query: string, result: Exclude<HotelCityResolution, { ok: true }>): string {
  if (result.reason === 'ambiguous') return `城市「${query}」有多个候选，请确认国家或城市：${result.candidates.map(c => `${c.name}（${c.context}，cityId=${c.id}）`).join('；')}`
  return `城市「${query}」${result.reason === 'unavailable' ? '的携程酒店城市解析服务暂不可用' : '未精确匹配供应商城市候选'}；可提供 country 消歧，或携程酒店 list 页 city= 数字作为 cityId。城市解析失败不能证明目的地不受支持。`
}
