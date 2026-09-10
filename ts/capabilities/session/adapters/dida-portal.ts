/**
 * Dida 供应商门户站点适配器(2026-09-09 实装;hotel-be portal integration 迁移线:
 * 员工子账号免知凭据访问供应商 portal——登录经 hotel-be portal 自动填充跳板在
 * dida 官网由人完成,gotry 只在用户本人 Chrome 登录态里被动嗅探检索回包)。
 *
 *   - entry:https://portal.dida.com/hotel/find(SPA,页内交互触发检索;深链参数
 *     形态未知——D-13 同款边界,首个真会话后校准)
 *   - networkHints:portal-webapi.dida.com 实时价/价格监控 XHR(接口名取自
 *     hotel-be supplier/integration/dida/portal 已捕获端点,2026-07 抓包校准);
 *     URL hint 未命中时由 content-main 的形状嗅探兜底(响应 JSON 含报价签名即
 *     转发),对接口改名免疫
 *   - 解析:SearchRealTime 信封(Envelope{Data.HotelPriceList[].RoomTypeList[]
 *     .RatePlanList[]})逐报价展平;SearchMonitor 响应形状未捕获前不猜测——
 *     只按 URL 命中转发、解析留给首个真会话校准(D-13)
 *
 * 只读:适配器不含任何提交/预订语义;预订面(PriceConfirm 等)URL 属 hotel-be
 * 适配器边界,gotry 侧不存在对应原语;登录语义红线同全局:gotry 永不读取/存储/
 * 回传 cookie 值,只读票据 cookie 名(CN_M_DidaTravel)存在性。
 */

/** 票据 cookie 名(hotel-be portal 会话同款 HttpOnly cookie;只读名字,永不读值) */
export const DIDA_LOGIN_COOKIE_NAMES = ['CN_M_DidaTravel']

/** page 域(content_scripts 注入面与 background 白名单的对账源) */
export const DIDA_SITE_HOST = 'portal.dida.com'
/** cookie 域(chrome.cookies 过滤器与登录票据检查;did a 站点 cookie 挂 .dida.com 域 cookie) */
export const DIDA_SITE_DOMAIN = 'dida.com'

/** 默认检索入口(酒店 find 页;SPA 加载后由页面自身代码发起价格检索) */
export const DIDA_ENTRY_URL = 'https://portal.dida.com/hotel/find'

export interface DidaEntry {
  ok: boolean
  url?: string
}

export interface DidaEntryQuery {
  /** 显式覆盖入口 URL(深链参数校准后使用;必须落在 portal.dida.com 域内) */
  entryUrl?: string
}

/** entry 构造(v1:固定 find 页 + 显式覆盖守白名单域;URL 直开即零 DOM 交互) */
export function buildDidaEntryUrl(q: DidaEntryQuery = {}): DidaEntry {
  const url = (q.entryUrl ?? '').trim() || DIDA_ENTRY_URL
  if (!/^https:\/\/portal\.dida\.com\//.test(url)) return { ok: false }
  return { ok: true, url }
}

/** networkHints:portal-webapi.dida.com 实时价/价格监控 XHR(2026-07 抓包口径;
 * 首个真会话后按现行接口校准——D-13 同款边界) */
export const DIDA_NETWORK_HINTS = [
  /portal-webapi\.dida\.com\/HotelPriceAPI\/SearchRealTime/i,
  /portal-webapi\.dida\.com\/HotelPriceAPI\/SearchMonitor/i,
  // 2026-09-10 UAT 实测校准:find 页加载态自发的是推荐流(非 SearchRealTime——
  // 那是用户点「预订」后的实时价接口)。推荐酒店 + 推荐价格两个接口成对出现。
  /portal-webapi\.dida\.com\/HotelRecommendAPI\/SearchHomepageRecommendHotels/i,
  /portal-webapi\.dida\.com\/HotelRecommendAPI\/SearchHomepageRecommendPrices/i,
  /portal-webapi\.dida\.com\/PopularDestinationAPI\/SearchHotels/i,
  /portal-webapi\.dida\.com\/PopularDestinationAPI\/SearchHotelPrices/i,
]

/** 形状嗅探签名:URL hint 未命中时的兜底(实时价信封报价签名,对接口改名免疫);
 * 大小上限由调用方先把关 */
export function looksLikeDidaRatesBody(body: string): boolean {
  if (!body || body.length > 2_000_000) return false
  return /"HotelPriceList"|"RatePlanList"/.test(body)
}

// ── 现行加载态接口(2026-09-10 校准):推荐酒店 + 推荐价格 ──────────────────

export interface DidaRecommendHotel {
  hotelId: string
  name: string
  nameEN?: string
}

/** 解析推荐酒店列表(Data.Hotels[]:HotelID/Name/Name_CN/Name_EN;Current 页加载态无价) */
export function parseDidaRecommendHotels(body: string, opts: { maxItems?: number } = {}): DidaRecommendHotel[] {
  let raw: unknown
  try { raw = JSON.parse(body) } catch { return [] }
  const hotels = (raw as { Data?: { Hotels?: unknown } })?.Data?.Hotels
  if (!Array.isArray(hotels)) return []
  const out: DidaRecommendHotel[] = []
  for (const item of hotels.slice(0, opts.maxItems ?? 60)) {
    if (item == null || typeof item !== 'object') continue
    const h = item as Record<string, unknown>
    const hotelId = h.HotelID != null ? String(h.HotelID) : ''
    const name = typeof h.Name_CN === 'string' && h.Name_CN.trim() ? h.Name_CN : (typeof h.Name === 'string' ? h.Name : '')
    if (!hotelId || !name) continue
    out.push({ hotelId, name, nameEN: typeof h.Name_EN === 'string' ? h.Name_EN : undefined })
  }
  return out
}

export interface DidaPriceEntry {
  hotelId: string
  price: number
  originalPrice?: number
  currency?: string
  /** 单晚起始价对应日期(YYYY-MM-DD) */
  priceDate?: string
  checkInDate?: string
  checkOutDate?: string
}

// (parser types continue below)

/** 解析价格列表:兼容 Recommend Prices(HotelId/Date)与 PopularDestination(HotelID/CheckInDate)两种键形 */
export function parseDidaPrices(body: string): DidaPriceEntry[] {
  let raw: unknown
  try { raw = JSON.parse(body) } catch { return [] }
  const prices = (raw as { Data?: { Prices?: unknown } })?.Data?.Prices
  if (!Array.isArray(prices)) return []
  const out: DidaPriceEntry[] = []
  for (const item of prices) {
    if (item == null || typeof item !== 'object') continue
    const p = item as Record<string, unknown>
    const hotelId = p.HotelId != null ? String(p.HotelId) : (p.HotelID != null ? String(p.HotelID) : '')
    const price = typeof p.Price === 'number' ? p.Price : NaN
    if (!hotelId || !Number.isFinite(price) || price <= 0) continue
    const dateOf = (v: unknown): string | undefined => (typeof v === 'string' && v.length >= 10 ? v.slice(0, 10) : undefined)
    out.push({
      hotelId,
      price,
      originalPrice: typeof p.OriginalPrice === 'number' ? p.OriginalPrice : undefined,
      currency: typeof p.Currency === 'string' ? p.Currency : undefined,
      priceDate: dateOf(p.Date),
      checkInDate: dateOf(p.CheckInDate),
      checkOutDate: dateOf(p.CheckOutDate),
    })
  }
  return out
}

/** 单条报价(一房一价一计划;语义判定在工具层,本层只归形状——页面 JSON 是不可信输入) */
export interface SessionDidaRateOption {
  hotelId?: string
  hotelName?: string
  roomTypeId?: string
  roomName?: string
  ratePlanId?: string
  /** 单价(数值不可得时为 0) */
  price: number
  /** 总价(含税费口径以 dida 页面为准) */
  totalPrice?: number
  currency?: string
  mealType?: string
  breakfastType?: string
  bedType?: string
  paymentType?: string
  /** 库存/可订间数(0=未给) */
  inventory?: number
  /** 检索续期令牌(dida 报价引用号;服务端预订链凭此续操作) */
  referenceNo?: string
  /** 酒店详情落地页(由人完成预订;gotry 不碰) */
  jumpUrl?: string
  /** 推荐价对应日期(YYYY-MM-DD;推荐流单晚起始价) */
  priceDate?: string
}

interface RateCandidate {
  hotelId?: string
  hotelName?: string
  roomTypeId?: string
  roomName?: string
  plan: Record<string, unknown>
}

/** 从 RoomTypePrice 展平一条报价候选(RatePlanList 元素为 dida 已知形态);
 * 酒店字段取 HotelPriceItem.Hotel 嵌套(HotelStatic),容忍旧式扁平形态 */
function rateCandidate(hotel: Record<string, unknown>, room: Record<string, unknown>, plan: Record<string, unknown>): RateCandidate | null {
  if (plan == null || typeof plan !== 'object') return null
  const ratePlanId = plan.RatePlanID
  const price = plan.Price
  const totalPrice = plan.TotalPrice
  if (typeof ratePlanId !== 'string' || !ratePlanId.trim()) return null
  if (typeof price !== 'number' && typeof totalPrice !== 'number') return null
  const hotelStatic = (hotel.Hotel != null && typeof hotel.Hotel === 'object' ? hotel.Hotel : hotel) as Record<string, unknown>
  const hotelId = hotelStatic.HotelID
  const roomTypeId = room.DidaRoomTypeID
  return {
    hotelId: hotelId != null ? String(hotelId) : undefined,
    hotelName: typeof hotelStatic.Name === 'string' ? hotelStatic.Name : undefined,
    roomTypeId: roomTypeId != null ? String(roomTypeId) : undefined,
    roomName: typeof room.DidaRoomTypeName_CN === 'string' && room.DidaRoomTypeName_CN.trim()
      ? room.DidaRoomTypeName_CN
      : (typeof room.DidaRoomTypeName_EN === 'string' ? room.DidaRoomTypeName_EN : undefined),
    plan,
  }
}

/** 走形:SearchRealTime 信封 → 展平报价列表(纯函数,fixture 测试锚点);
 * malformed 一律返空,不抛错——页面/接口 JSON 是不可信输入(RFC §3.5) */
export function parseDidaRates(body: string, opts: { maxItems?: number } = {}): SessionDidaRateOption[] {
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    return []
  }
  const maxItems = opts.maxItems ?? 40
  const out: SessionDidaRateOption[] = []
  // 定位 HotelPriceList:信封顶层 Data 下;无信封时容忍裸数组形态
  let hotelList: unknown
  if (raw != null && typeof raw === 'object' && !Array.isArray(raw)) {
    const data = (raw as Record<string, unknown>).Data
    if (data != null && typeof data === 'object') hotelList = (data as Record<string, unknown>).HotelPriceList
  } else if (Array.isArray(raw)) {
    hotelList = raw
  }
  if (!Array.isArray(hotelList)) return out
  for (const item of hotelList) {
    if (out.length >= maxItems || item == null || typeof item !== 'object') continue
    const hotel = item as Record<string, unknown>
    // RoomTypeList 与 RoomList 是合并关系(hotel-be converter 两表都吃),不是二选一
    const rooms = [
      ...(Array.isArray(hotel.RoomTypeList) ? hotel.RoomTypeList : []),
      ...(Array.isArray(hotel.RoomList) ? hotel.RoomList : []),
    ]
    for (const room of rooms) {
      if (out.length >= maxItems || room == null || typeof room !== 'object') continue
      const plans = (room as Record<string, unknown>).RatePlanList
      if (!Array.isArray(plans)) continue
      for (const plan of plans) {
        if (out.length >= maxItems) return out
        const cand = rateCandidate(hotel, room as Record<string, unknown>, plan as Record<string, unknown>)
        if (!cand) continue
        const p = cand.plan
        out.push({
          hotelId: cand.hotelId,
          hotelName: cand.hotelName,
          roomTypeId: cand.roomTypeId,
          roomName: cand.roomName,
          ratePlanId: typeof p.RatePlanID === 'string' ? p.RatePlanID : undefined,
          price: typeof p.Price === 'number' ? p.Price : 0,
          totalPrice: typeof p.TotalPrice === 'number' ? p.TotalPrice : undefined,
          currency: typeof p.Currency === 'string' ? p.Currency : undefined,
          mealType: typeof p.MealType === 'string' ? p.MealType : undefined,
          breakfastType: typeof p.BreakfastType === 'string' ? p.BreakfastType : undefined,
          bedType: typeof p.BedType === 'string' ? p.BedType : undefined,
          paymentType: typeof p.PaymentType === 'string' ? p.PaymentType : undefined,
          inventory: typeof p.Inventory === 'number' ? p.Inventory : (typeof p.RoomCount === 'number' ? p.RoomCount : undefined),
          referenceNo: typeof p.ReferenceNo === 'string' ? p.ReferenceNo : undefined,
          jumpUrl: cand.hotelId ? `https://portal.dida.com/hotel/find` : undefined,
        })
      }
    }
  }
  return out
}
