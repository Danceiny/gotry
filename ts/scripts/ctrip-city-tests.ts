/** Supplier metadata fixtures; no vendor requests, credentials or browser session. */
import assert from 'node:assert/strict'
import { parseCtripHotelCities, resolveCtripHotelCity, parseCtripCityCatalog, parseCtripCitySuggestions, matchCtripCity, resolveCtripFlightCity } from '../capabilities/session/ctrip-city.ts'
import { resolveFlightEntryUrl } from '../capabilities/session/adapters/ctrip-flight.ts'
const catalog = { ResponseStatus: { Ack: 'Success' }, responseHead: { errorCode: '0' }, recommendGroupList: [{ indexedCity: { cityList: [
  { id: 2, code: 'SHA', name: '上海', eName: 'Shanghai', airportlst: [{ code: 'PVG', name: '上海浦东国际机场' }] },
  { id: 58, code: 'HKG', name: '中国香港', nameEn: 'Hong Kong' },
] }, geographicalRegionList: [{ hotCityList: [{ cityList: [{ id: 220, code: 'DXB', name: '迪拜', eName: 'Dubai', specName: '迪拜(阿联酋)', sameSpecCity: 1 }] }] }] }] }
const cities = parseCtripCityCatalog(catalog)
for (const [name, code] of [['迪拜（阿联酋）','DXB'],['DXB','DXB'],['香港','HKG'],['Hong Kong','HKG'],['Shanghai','SHA'],['上海浦东国际机场','PVG']]) {
  const r = matchCtripCity(name!, cities)
  assert.ok(r.ok, name)
  assert.equal(r.city.code, code)
}
assert.equal(matchCtripCity('Dubai', cities).ok, false, 'supplier-marked same-name cities require qualification')
assert.equal(matchCtripCity('迪', cities).ok, false, 'no prefix or nearby-city substitution')
assert.equal(matchCtripCity('同名城', [{ name: '同名城', code: 'AAA', aliases:['同名城'], context:'甲国' }, {name:'同名城',code:'BBB',aliases:['同名城'],context:'乙国'}]).ok, false)
assert.throws(() => parseCtripCityCatalog({ ...catalog, responseHead: { errorCode: '1' } }))
const suggestions = { Data: [{ Type: 4, Name: '未缓存城市', Code: 'NEW', EName:'New City', Country:'示例国', Nearby:[{ Type:4, Name:'邻近城市', Code:'NEA'}] }] }
assert.equal(parseCtripCitySuggestions(suggestions).length, 1)
let requests: string[] = []
const fakeFetch: typeof fetch = async (url) => {
  requests.push(String(url))
  return Response.json(requests.length === 1 ? catalog : suggestions)
}
const resolved = await resolveCtripFlightCity('未缓存城市', fakeFetch)
assert.ok(resolved.ok)
assert.equal(resolved.city.code, 'NEW')
assert.equal(requests.length, 2, 'catalog miss queries supplier autocomplete')
const blocked = await resolveCtripFlightCity('未知城市', async () => new Response('whaleguard block'))
assert.ok(!blocked.ok && blocked.reason === 'unavailable', 'challenge is unavailable, not unsupported/no inventory')
const oversized = await resolveCtripFlightCity('未知城市', async () => new Response('x'.repeat(512001)))
assert.ok(!oversized.ok && oversized.reason === 'unavailable')
const entry = await resolveFlightEntryUrl('迪拜（阿联酋）','香港','2026-12-01', {}, async q => matchCtripCity(q,cities))
assert.ok(entry.ok && entry.url?.includes('oneway-dxb-hkg'))
let lookups = 0
assert.ok(!(await resolveFlightEntryUrl('Dubai','香港','bad-date',{}, async () => { lookups++; throw Error('should not run') })).ok)
assert.ok(!(await resolveFlightEntryUrl('Dubai','香港','2026-12-01',{fromCode:'../dxb'}, async () => { lookups++; throw Error('should not run') })).ok)
assert.equal(lookups,0)
console.log('Ctrip city metadata: international names/airports, ambiguity, autocomplete fallback, challenge/bounds and exact URL PASS')
const hotelRecord = (id: number, name: string, english: string, country: string) => ({ keyword: {keywordContentInfo: { tripType:'CT', keywordCode:String(id), displayTexts:[{key:'MAIN_TITLE',value:english}] }}, controlInfo: {regionInfo: {basicCityModel:{cityId:id},displayCityModel:{cityName:name,countryName:country,destinationNameEN:english}}} })
const hotels = {ResponseStatus:{Ack:'Success'},data:{mainKeywordList:{keywords:[hotelRecord(220,'迪拜','Dubai','阿联酋'),hotelRecord(596578,'迪拜','Dubai','印度')]}}}
const hotelFetch: typeof fetch = async () => Response.json(hotels)
const ambiguous = await resolveCtripHotelCity('迪拜',undefined,hotelFetch)
assert.ok(!ambiguous.ok && ambiguous.reason === 'ambiguous')
assert.equal(ambiguous.candidates.length,2)
const qualified = await resolveCtripHotelCity('迪拜','阿联酋',hotelFetch)
assert.ok(qualified.ok && qualified.city.id === '220')
const rejected = await resolveCtripHotelCity('迪拜',undefined,async()=>Response.json({...hotels,data:{...hotels.data,htlSpiderActionErrorCode:'captcha'}}))
assert.ok(!rejected.ok && rejected.reason === 'unavailable')
assert.throws(()=>parseCtripHotelCities({...hotels,data:{mainKeywordList:{keywords:[{...hotelRecord(220,'迪拜','Dubai','阿联酋'),keyword:{keywordContentInfo:{tripType:'CT',keywordCode:'58'}}}]}}}))
console.log('Hotel destination namespace: same-name city ambiguity, country confirmation, challenge and ID conflict PASS')

// Exercise the real registered schema and tool dispatch, using an isolated state root.
const { apply } = await import('../src/index.ts')
const { mkdtempSync, rmSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const root = mkdtempSync(join(tmpdir(),'gotry-city-tool-'))
const tools: any[] = []
const effects: any[] = []
try {
  apply({ tools:{register:(t:unknown)=>tools.push(t)}, systemPrompt:{variable:()=>{}}, get:()=>undefined, on:()=>()=>{} } as any,
    { stateRoot:root, timeoutMs:1000, hbcliBin:'unused', sessionAccess:'allow' } as any,
    { effect: (async (fx:any) => { effects.push(fx); return { result:{ok:false,verdict:'error',error:'fixture only',evidence:'[fixture:city-tool]'},trace:{effect:fx.effect,channel:'browser',attempts:1,backoffMs:0,breaker:'off',evidence:[]} } }) as any })
  const session = tools.find(t=>t.name==='gotry_session_search')
  const hotel = tools.find(t=>t.name==='gotry_hotel_search')
  const parameters = session.parameters?.properties ?? session.parameters
  assert.ok(parameters.country && parameters.fromCityCode && parameters.toCityCode, 'model must see disambiguation parameters on session search')
  const hotelParameters = hotel.parameters?.properties ?? hotel.parameters
  assert.ok(!hotelParameters.country, 'HBCLI hotel tool must not advertise an ignored session parameter')
  await session.execute({kind:'hotel',to:'迪拜',country:'阿联酋'}, {})
  assert.equal(effects.at(-1).effect,'SESSION_HOTEL_SEARCH')
  assert.equal(effects.at(-1).params.country,'阿联酋')
  await session.execute({kind:'flight',from:'迪拜',to:'香港',date:'2099-12-01',fromCityCode:'DXB',toCityCode:'HKG'}, {})
  assert.equal(effects.at(-1).effect,'SESSION_FLIGHT_SEARCH')
  assert.equal(effects.at(-1).params.fromCityCode,'DXB')
  assert.equal(effects.at(-1).params.toCityCode,'HKG')
  console.log('Registered session tool: country/code schema and effect dispatch PASS')
} finally { rmSync(root,{recursive:true,force:true}) }
