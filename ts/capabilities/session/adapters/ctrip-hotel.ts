/**
 * 携程酒店站点适配器(2026-09-03 迪拜 session 复盘:账号会话面此前只有机票,
 * 用户要「携程找酒店」时被迫撞 flyai 429 与打码 web 读页;会话面酒店从
 * 「备份」实装为通道之一,rfc §2.2 同款只读纪律)。
 *
 *   - entry:https://hotels.ctrip.com/hotels/list?city=<id>&checkin=&checkout=&adult=N
 *   - networkHints:酒店检索 XHR 的 URL 形态(接口名公开资料多版并存,**首个真会话
 *     后校准**——D-13 同款边界);URL hint 未命中时由 content-main 的**形状嗅探**
 *     兜底(响应 JSON 含酒店清单签名即转发),对接口改名免疫
 *   - 解析:走形(walk)JSON 找「名字 + 价格」签名的条目数组,归一化最小字段;
 *     页面/接口 JSON 是不可信输入(RFC §3.5)——本层只归形状,语义判定在工具层
 *
 * 只读:适配器不含任何提交/预订语义;URL 直开即零 DOM 交互;ReadGuard 对酒店
 * 页面照常生效(下单/支付面 URL 仍被物理拦截)。
 */

/** 城市码起步集(D-13:公开常识口径,首个真会话后校准;词表外逐字保留,
 * 调用方可显式传 cityId 覆盖——携程/trip.com 酒店 list 页 URL 里的 city= 数字) */
const HOTEL_CITY_CODES: Record<string, string> = {
  上海: '2',
  北京: '1',
}

export interface AdapterEntry {
  ok: boolean
  url?: string
  /** 词表外城市逐字保留(调用方提示:web 搜携程酒店 list 页取 city id 后带 cityId 重试) */
  unresolved?: string[]
}

export interface HotelEntryQuery {
  /** 目的地(中文);词表外须配 cityId */
  to: string
  /** 显式城市 id(携程/trip.com 酒店 list 页 URL 的 city= 数字;覆盖码表) */
  cityId?: number | string
  /** YYYY-MM-DD */
  checkIn?: string
  /** YYYY-MM-DD(与 checkIn 成对) */
  checkOut?: string
  adults?: number
}

export function buildHotelEntryUrl(q: HotelEntryQuery): AdapterEntry {
  const unresolved: string[] = []
  const cityId = String(q.cityId ?? '').trim() || HOTEL_CITY_CODES[q.to.trim()]
  if (!cityId) unresolved.push(q.to)
  if (unresolved.length > 0) {
    return { ok: false, unresolved }
  }
  const params = new URLSearchParams({ city: cityId })
  if (q.checkIn) params.set('checkin', q.checkIn)
  if (q.checkOut) params.set('checkout', q.checkOut)
  if (q.adults && q.adults > 0) params.set('adult', String(q.adults))
  return { ok: true, url: `https://hotels.ctrip.com/hotels/list?${params.toString()}` }
}

/** networkHints:酒店检索 XHR 的 URL 形态(多版接口名并存;命中即读) */
export const HOTEL_NETWORK_HINTS = [
  /hotels\.ctrip\.com\/(hotels\/api|domestic\/pc\/api)/i,
  /GetHotelListBySOA|GetHotelListByCity|HotelSearch|hotelsearch/i,
]

/** 形状嗅探签名:URL hint 未命中时的兜底(对接口改名免疫);大小上限由调用方先把关 */
export function looksLikeHotelListBody(body: string): boolean {
  if (!body || body.length > 2_000_000) return false
  return /"hotelList"|"hotelMatchInfos"|"hotelName"/.test(body)
}

/** 酒店 page 域(content_scripts 注入面与 background 白名单的对账源) */
export const HOTEL_SITE_HOST = 'hotels.ctrip.com'

export interface SessionHotelOption {
  /** 酒店名 */
  name: string
  /** 数字价(数值不可得时为 0;真实价以 jumpUrl 落地页为准) */
  price: number
  /** 价格原串(打码/区间等不可数值化的形态原样保留) */
  priceRaw?: string
  star?: number
  /** 点评分(上游形态有数字有字符串,原样归一为字符串缺省) */
  score?: string
  address?: string
  hotelId?: string
  /** 酒店详情页跳转(由人完成预订;gotry 不碰) */
  jumpUrl?: string
}

interface WalkCandidate {
  name: string
  price?: number
  priceRaw?: string
  star?: number
  score?: string
  address?: string
  hotelId?: string
}

/** 条目签名:像不像一家酒店(名字类字段必有 + 价格类字段至少其一) */
function hotelSignature(o: Record<string, unknown>): WalkCandidate | null {
  const name = (o.hotelName ?? o.name ?? o.hotelNameEn) as unknown
  if (typeof name !== 'string' || !name.trim()) return null
  let price: number | undefined
  let priceRaw: string | undefined
  // 顶层扁平价(数字/字符串直给;字符串价是打码/区间形态,原样保留不数值化)
  if (typeof o.price === 'number' && o.price > 0) price = o.price
  else if (typeof o.price === 'string' && o.price.trim()) priceRaw = o.price.trim()
  const probe = (v: unknown, seen = new Set<unknown>()): void => {
    if (v == null || typeof v !== 'object') return
    if (seen.has(v)) return
    seen.add(v)
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      if (/^(avgPrice|totalPrice|price|amount|total|startPrice)$/i.test(k) && typeof child === 'number' && child > 0 && price === undefined) price = child
      else if (/^(price|priceDisplay|amountText)$/i.test(k) && typeof child === 'string' && child.trim() && priceRaw === undefined) priceRaw = child.trim()
      else probe(child, seen)
    }
  }
  probe(o.priceInfo)
  const flatPrice = o.totalPrice ?? o.avgPrice ?? o.minPrice
  if (typeof flatPrice === 'number' && flatPrice > 0 && price === undefined) price = flatPrice
  const flatRaw = o.priceText ?? o.priceDisplay
  if (typeof flatRaw === 'string' && flatRaw.trim() && priceRaw === undefined) priceRaw = flatRaw.trim()
  if (price === undefined && priceRaw === undefined) return null
  const starRaw = o.star ?? o.level ?? o.hotelStar
  const star = typeof starRaw === 'number' && starRaw > 0 ? starRaw : Number.isFinite(Number(starRaw)) && Number(starRaw) > 0 ? Number(starRaw) : undefined
  const scoreRaw = o.score ?? o.commentScore ?? o.reviewScore
  const score = scoreRaw == null ? undefined : String(scoreRaw)
  const pos = o.position as Record<string, unknown> | undefined
  const address = (typeof pos?.address === 'string' ? pos.address : undefined) ?? (typeof o.address === 'string' ? o.address : undefined)
  const hotelId = (typeof o.hotelId === 'number' || typeof o.hotelId === 'string' ? String(o.hotelId) : undefined)
    ?? (typeof o.hotelIdStr === 'string' ? o.hotelIdStr : undefined)
  return { name: name.trim(), price, priceRaw, star, score, address, hotelId }
}

/** 走形:深找第一个酒店签名数组(纯函数,fixture 测试锚点);malformed 一律返空,不抛错 */
export function parseCtripHotelList(body: string, opts: { maxItems?: number } = {}): SessionHotelOption[] {
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    return []
  }
  const out: SessionHotelOption[] = []
  const maxItems = opts.maxItems ?? 20
  const walk = (node: unknown, depth: number, seen: Set<unknown>): void => {
    if (out.length >= maxItems || depth > 12 || node == null || typeof node !== 'object' || seen.has(node)) return
    if (Array.isArray(node)) {
      for (const item of node) {
        if (out.length >= maxItems) return
        if (item == null || typeof item !== 'object' || Array.isArray(item)) continue
        const cand = hotelSignature(item as Record<string, unknown>)
        if (!cand) continue
        out.push({
          name: cand.name,
          price: cand.price ?? 0,
          priceRaw: cand.priceRaw,
          star: cand.star,
          score: cand.score,
          address: cand.address,
          hotelId: cand.hotelId,
          jumpUrl: cand.hotelId ? `https://hotels.ctrip.com/hotel/${cand.hotelId}` : undefined,
        })
      }
      return
    }
    seen.add(node)
    for (const child of Object.values(node as Record<string, unknown>)) {
      walk(child, depth + 1, seen)
      if (out.length >= maxItems) return
    }
  }
  walk(raw, 0, new Set())
  return out
}
