/**
 * 美团本地适配器骨架(民宿/门票——官方通道盲区,RFC §3.1)。
 *
 * 实测边界(2026-08-28 tick):匿名实例 hotel.meituan.com 直接 403——三站中最强反爬,
 * **登录态是硬前置**(founder 纠偏「不能匿名实例」在美团侧是 403 级事实,非策略偏好)。
 * 本骨架:entry 城市拼音表 + 登录票据名单 + networkHint 占位;live 接口形状待用户登录态
 * (profile 内用户自登美团)后由心跳轮实测回填——在此之前 parse 返回空、verdict=miss。
 */

/** 城市拼音表(美团 URL 路径段;与 ctrip-flight 城市码表同界:词表外 unresolved 不猜) */
const CITY_SLUGS: Record<string, string> = {
  上海: 'shanghai', 北京: 'beijing', 广州: 'guangzhou', 深圳: 'shenzhen', 成都: 'chengdu',
  昆明: 'kunming', 大理: 'dali', 丽江: 'lijiang', 西安: 'xian', 杭州: 'hangzhou',
  三亚: 'sanya', 厦门: 'xiamen', 重庆: 'chongqing', 青岛: 'qingdao', 长沙: 'changsha',
  武汉: 'wuhan', 南京: 'nanjing', 郑州: 'zhengzhou', 贵阳: 'guiyang', 桂林: 'guilin',
}

export const SITE_DOMAIN = 'meituan.com'
/** 登录票据 cookie 名单(公开常识:lt=login ticket/u=uid/token;登录后校准,同 ctrip 侧做法) */
export const LOGIN_COOKIE_NAMES = ['lt', 'u', 'token', 'n']

export type MeituanVertical = 'hotel' | 'minsu'

export interface MeituanEntry {
  ok: boolean
  url?: string
  unresolved?: string[]
}

export function buildMeituanEntry(city: string, vertical: MeituanVertical, keyword?: string): MeituanEntry {
  const slug = CITY_SLUGS[city]
  if (!slug) return { ok: false, unresolved: [city] }
  const base = vertical === 'hotel' ? `https://hotel.meituan.com/${slug}/` : `https://minsu.meituan.com/${slug}/`
  return { ok: true, url: keyword ? base + `?q=${encodeURIComponent(keyword)}` : base }
}

/** networkHint 占位:登录态实测后回填真实搜索接口 pattern(当前为空=嗅探层不命中,a11y 兜底接管) */
export const NETWORK_HINTS: RegExp[] = []

export interface MeituanListingOption {
  name: string
  price: number
  /** 元数据行(位置/评分/房型,来自 a11y 条目) */
  meta?: string
}

/** XHR JSON 解析占位:接口形状实测回填前恒返空(调用方走 a11y 兜底) */
export function parseMeituanSearch(_body: string): MeituanListingOption[] {
  void _body
  return []
}

/**
 * a11y 兜底:从快照条目抽「名称+价格」候选(纯函数;供 extract.ts 条目流消费)。
 * 形状规则:名称=非空 heading/listitem/link;价格=条目名内 ¥\d+(宽松元级);不做语义猜测。
 */
export function extractListings(entries: Array<{ role: string; name: string }>, opts: { max?: number } = {}): MeituanListingOption[] {
  const out: MeituanListingOption[] = []
  const roles = new Set(['heading', 'listitem', 'link', 'article'])
  for (const e of entries) {
    if (out.length >= (opts.max ?? 30)) break
    if (!roles.has(e.role) || !e.name) continue
    const pm = /¥\s*(\d+)/.exec(e.name)
    if (!pm) continue
    const name = e.name.replace(/¥\s*\d+.*$/, '').trim().slice(0, 80)
    if (!name) continue
    out.push({ name, price: Number(pm[1]) })
  }
  return out
}
