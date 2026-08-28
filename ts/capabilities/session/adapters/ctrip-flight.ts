/**
 * 携程机票站点适配器(RFC §3.2 首个适配器;PoC 已识别接口面,data-sources.md §8):
 *   - entry:URL 参数直开(https://flights.ctrip.com/online/list/oneway-{from}-{to}?depdate=YYYY-MM-DD)
 *   - networkHints:主搜索接口 search/api/search/batchSearch(POST,~550KB,国内票同走)
 *   - 解析:flightItineraryList[].flightSegments[0].flightList[0] + priceList 最小 adultPrice
 *     (schema 实测 2026-08-28,见 data-sources.md §8)
 * 只读:适配器不含任何提交/预订语义;URL 直开即零 DOM 交互。
 */

/** 城市三字码表(小起步集;词表外 unresolved 逐字保留,不做开放式猜测——ADR-12 同款边界) */
const CITY_CODES: Record<string, string> = {
  上海: 'sha', 北京: 'bjs', 广州: 'can', 深圳: 'szx', 成都: 'ctu', 昆明: 'kmg',
  大理: 'dlu', 丽江: 'ljg', 西安: 'sia', 杭州: 'hgh', 三亚: 'syx', 厦门: 'xmn',
  重庆: 'cqg', 青岛: 'taa', 长沙: 'csx', 武汉: 'wuh', 南京: 'nkg', 郑州: 'cgo',
  贵阳: 'kwe', 桂林: 'kwl', 西双版纳: 'jhg', 香格里拉: 'dig',
}

export interface AdapterEntry {
  ok: boolean
  url?: string
  /** 词表外城市逐字保留(调用方降级无日期/无线路搜索) */
  unresolved?: string[]
}

export function buildEntryUrl(from: string, to: string, depDate: string): AdapterEntry {
  const unresolved: string[] = []
  const fromCode = CITY_CODES[from]
  const toCode = CITY_CODES[to]
  if (!fromCode) unresolved.push(from)
  if (!toCode) unresolved.push(to)
  if (unresolved.length > 0 || !/^\d{4}-\d{2}-\d{2}$/.test(depDate)) {
    return { ok: false, unresolved: unresolved.length > 0 ? unresolved : [depDate] }
  }
  return { ok: true, url: `https://flights.ctrip.com/online/list/oneway-${fromCode}-${toCode}?depdate=${depDate}` }
}

/** networkHints:响应 URL 命中即视为搜索回包(对 UI 改版免疫,只怕接口改版) */
export const NETWORK_HINTS = [/search\/api\/search\/batchSearch/]

export interface SessionFlightOption {
  flightNo: string
  airline: string
  depDateTime: string
  arrDateTime: string
  depAirport: string
  arrAirport: string
  durationMin: number
  price: number
  aircraft?: string
}

interface RawBatch {
  status?: number
  data?: {
    flightItineraryList?: Array<{
      flightSegments?: Array<{
        airlineName?: string
        duration?: number
        flightList?: Array<{
          flightNo?: string
          departureAirportName?: string
          arrivalAirportName?: string
          departureDateTime?: string
          arrivalDateTime?: string
          aircraftName?: string
        }>
      }>
      priceList?: Array<{ adultPrice?: number }>
    }>
  }
}

/** 解析 batchSearch 响应(纯函数,fixture 测试锚点);malformed 一律返空,不抛错 */
export function parseBatchSearch(body: string): SessionFlightOption[] {
  let raw: RawBatch
  try {
    raw = JSON.parse(body) as RawBatch
  } catch {
    return []
  }
  const out: SessionFlightOption[] = []
  for (const it of raw.data?.flightItineraryList ?? []) {
    const seg = it.flightSegments?.[0]
    const fl = seg?.flightList?.[0]
    if (!fl?.flightNo || !fl.departureDateTime) continue
    const prices = (it.priceList ?? []).map((p) => Number(p.adultPrice ?? 0)).filter((n) => n > 0)
    out.push({
      flightNo: fl.flightNo,
      airline: seg?.airlineName ?? '',
      depDateTime: fl.departureDateTime ?? '',
      arrDateTime: fl.arrivalDateTime ?? '',
      depAirport: fl.departureAirportName ?? '',
      arrAirport: fl.arrivalAirportName ?? '',
      durationMin: Number(seg?.duration ?? 0) || 0,
      price: prices.length > 0 ? Math.min(...prices) : 0,
      aircraft: fl.aircraftName,
    })
  }
  return out
}
