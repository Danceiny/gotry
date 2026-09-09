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

/**
 * 登录态检测(用户自己的账号,不是匿名实例——founder 2026-08-28 纠偏):
 * 任一登录票据 cookie 存在即视为已登录;名单基于公开常识,首个真登录后校准(D-13)。
 */
export const LOGIN_COOKIE_NAMES = ['cticket', 'uid', 'uname', 'passport']
export const SITE_DOMAIN = '.ctrip.com'

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

/** 解析结果的三态判语(issue #279):空响应不再一律 miss——已识别合法空 = miss,
 * 形状未识别(malformed/unknown)= error,选项命中 = hit。误把任意 [] 判 miss 会把未知
 * 响应错误收敛为「这条线路没有航班」,这是上游接口改版/协议变动期的常见陷阱 */
export type BatchSearchVerdict = 'hit' | 'miss' | 'error'

export interface BatchSearchResult {
  options: SessionFlightOption[]
  verdict: BatchSearchVerdict
}

/** 安全取字符串字段(任意来源字段都可能是 null/undefined/数字/对象) */
function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** 安全取正数(无法解析按 0 返,绝不伪造价格) */
function asPositiveNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

/** 解析 batchSearch 响应(纯函数,fixture 测试锚点);malformed 一律返空,不抛错 */
export function parseBatchSearch(body: string): SessionFlightOption[] {
  return parseBatchSearchResult(body).options
}

/**
 * 结构化解析(issue #279):返回选项 + 三态判语。
 *   - `hit`  = 已识别合法结构 + 至少一个有效行程
 *   - `miss` = 已识别合法空(data.flightItineraryList 是空数组)
 *   - `error`= 形状未识别(JSON 解析失败 / 非对象根 / data 缺失或非对象 /
 *              flightItineraryList 不是数组 / 非空数组没有可用行程)——未知响应
 *              不可静默收敛为 miss
 * 绝不发明价格、航班号、机场、时刻;混合数组保留有效项,全畸形数组报 error。
 */
export function parseBatchSearchResult(body: string): BatchSearchResult {
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    return { options: [], verdict: 'error' }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { options: [], verdict: 'error' }
  }
  const data = (raw as { data?: unknown }).data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { options: [], verdict: 'error' }
  }
  const list = (raw as { data: { flightItineraryList?: unknown } }).data.flightItineraryList
  if (!Array.isArray(list)) {
    return { options: [], verdict: 'error' }
  }
  const out: SessionFlightOption[] = []
  for (const it of list) {
    if (it === null || typeof it !== 'object' || Array.isArray(it)) continue
    const item = it as { flightSegments?: unknown; priceList?: unknown }
    const segs = item.flightSegments
    if (!Array.isArray(segs) || segs.length === 0) continue
    const seg = segs[0]
    if (seg === null || typeof seg !== 'object' || Array.isArray(seg)) continue
    const segObj = seg as { airlineName?: unknown; duration?: unknown; flightList?: unknown }
    const fl = segObj.flightList
    if (!Array.isArray(fl) || fl.length === 0) continue
    const flight = fl[0]
    if (flight === null || typeof flight !== 'object' || Array.isArray(flight)) continue
    const f = flight as {
      flightNo?: unknown
      departureAirportName?: unknown
      arrivalAirportName?: unknown
      departureDateTime?: unknown
      arrivalDateTime?: unknown
      aircraftName?: unknown
    }
    if (typeof f.flightNo !== 'string' || !f.flightNo) continue
    if (typeof f.departureDateTime !== 'string' || !f.departureDateTime) continue
    // 缺 priceList 延续旧合同为「有航班、价格未知」;显式非数组与畸形价项
    // 属未知响应,整项跳过。若响应里没有其他有效项,最终判 error 而非 miss。
    if (item.priceList !== undefined && !Array.isArray(item.priceList)) continue
    const priceList = item.priceList ?? []
    const prices: number[] = []
    let malformedPrice = false
    for (const p of priceList) {
      if (p === null || typeof p !== 'object' || Array.isArray(p)) {
        malformedPrice = true
        break
      }
      const adultPrice = (p as { adultPrice?: unknown }).adultPrice
      if (adultPrice === undefined) continue
      if (typeof adultPrice !== 'number' || !Number.isFinite(adultPrice)) {
        malformedPrice = true
        break
      }
      if (adultPrice > 0) prices.push(adultPrice)
    }
    if (malformedPrice) continue
    out.push({
      flightNo: f.flightNo,
      airline: asString(segObj.airlineName),
      depDateTime: asString(f.departureDateTime),
      arrDateTime: asString(f.arrivalDateTime),
      depAirport: asString(f.departureAirportName),
      arrAirport: asString(f.arrivalAirportName),
      durationMin: asPositiveNumber(segObj.duration),
      price: prices.length > 0 ? Math.min(...prices) : 0,
      aircraft: typeof f.aircraftName === 'string' ? f.aircraftName : undefined,
    })
  }
  return {
    options: out,
    verdict: out.length > 0 ? 'hit' : list.length === 0 ? 'miss' : 'error',
  }
}
