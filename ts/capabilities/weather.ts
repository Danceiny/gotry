/**
 * Open-Meteo 天气能力层(免费无 key):预报 + 历史气候回退。
 *
 * 产品定位:替代 LLM 的「雨季常识」——季节性建议、窗口内降雨概率、
 * 体感温度范围,全部走真实数据并带证据标注 [实时API:open-meteo@ts]。
 *
 * 契约(与 hbcli.ts 同构,能力层不变量):
 *   - 永不抛错:网络失败/超时/解析失败一律降级返回,不穿透到调用方;
 *   - 证据链标注:成功带 [实时API:open-meteo@ts],失败带 [实时API:open-meteo@error@ts];
 *   - 免费源无配额概念,但仍记录 latency(供 L5 成本工程度量)。
 *
 * 端点(全部免费,无 key):
 *   预报: https://api.open-meteo.com/v1/forecast (≤16 天)
 *   历史气候: https://archive-api.open-meteo.com/v1/archive (1940→,做季节性)
 *   地理编码: https://geocoding-api.open-meteo.com/v1/search (地名→坐标)
 */

export interface WeatherPoint {
  latitude: number
  longitude: number
}

export interface WeatherDaily {
  date: string
  tempMaxC: number
  tempMinC: number
  precipProbMaxPct: number | null
  weatherCode: number
}

export interface WeatherResult {
  ok: boolean
  via: 'open-meteo' | 'open-meteo-error'
  evidence: string
  latencyMs: number
  timezone?: string
  daily?: WeatherDaily[]
  error?: string
}

const FORECAST_BASE = 'https://api.open-meteo.com/v1/forecast'
const ARCHIVE_BASE = 'https://archive-api.open-meteo.com/v1/archive'
const GEOCODE_BASE = 'https://geocoding-api.open-meteo.com/v1/search'

/** WMO weather code → 中文描述(节选最常用的码) */
const WMO_ZH: Record<number, string> = {
  0: '晴', 1: '大致晴', 2: '多云', 3: '阴',
  45: '雾', 48: '冻雾',
  51: '毛毛雨', 53: '毛毛雨', 55: '密集毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨',
  66: '冻雨', 67: '强冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '阵雨', 81: '强阵雨', 82: '暴雨',
  85: '阵雪', 86: '强阵雪',
  95: '雷暴', 96: '雷暴伴小冰雹', 99: '雷暴伴大冰雹',
}

export function wmoLabel(code: number): string {
  return WMO_ZH[code] ?? `天气码${code}`
}

type FetchImpl = typeof fetch

async function fetchJson(url: string, timeoutMs: number, headers: Record<string, string> = {}, fetchImpl: FetchImpl = globalThis.fetch): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, headers: { Accept: 'application/json', ...headers } })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    return { ok: true, data: await res.json() }
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 200) }
  } finally {
    clearTimeout(timer)
  }
}

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org/search'

/** 行政级/人口重镇 feature_code(open-meteo 命名惯例):PPLC=首都 PPLA*=首府 PPLB=城镇 PPLX=区片 */
const MAJOR_FEATURE = /^(PPLC|PPLA|PPLB|PPLX)/

interface GeoHitInternal {
  name: string
  latitude: number
  longitude: number
  country?: string
  admin1?: string
  /** 排序用:open-meteo 有 population;同名小地(村/镇)缺失时按 -1 处理 */
  population: number
  featureCode: string
}

function stripHits(hits: GeoHitInternal[]): Array<{ name: string; latitude: number; longitude: number; country?: string; admin1?: string }> {
  return hits.map(({ name, latitude, longitude, country, admin1 }) =>
    ({ ...(country ? { country } : {}), ...(admin1 ? { admin1 } : {}), name, latitude, longitude }))
}

/** 地名 → 坐标(双源,供 dsh 工具把「大理」转成经纬度):
 *  1. Open-Meteo(主源):命中按人口/行政级降序——「大理」会同时命中云南州府与四川同名乡,不能盲信次序;
 *  2. Nominatim(兜底):open-meteo 的中文名覆盖有洞(实测(issue #24)「普吉岛」0 结果、
 *     裸词「普吉」错配西藏林芝同名村),弱命中/零结果时走 Nominatim 拿正确目标,
 *     兜底仍空则回退 open-meteo 弱结果(不比此前更差)。 */
export async function geocodePlace(
  name: string,
  opts: { timeoutMs?: number; count?: number; fetchImpl?: FetchImpl } = {},
): Promise<{ ok: boolean; evidence: string; via?: 'open-meteo' | 'nominatim'; results: Array<{ name: string; latitude: number; longitude: number; country?: string; admin1?: string }>; error?: string }> {
  const ts = new Date().toISOString()
  const count = opts.count ?? 5
  const query = name.trim()
  const omUrl = `${GEOCODE_BASE}?name=${encodeURIComponent(query)}&count=${count}&language=zh&format=json`
  // timeoutMs is a budget for the complete primary→fallback chain, not per request.
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000)
  const remaining = () => Math.max(1, deadline - Date.now())
  const r = await fetchJson(omUrl, remaining(), {}, opts.fetchImpl)
  const omResults: GeoHitInternal[] = r.ok
    ? ((r.data as { results?: unknown[] })?.results ?? []).map((item) => {
        const it = item as Record<string, unknown>
        return {
          name: String(it['name'] ?? ''),
          latitude: Number(it['latitude']),
          longitude: Number(it['longitude']),
          country: it['country'] ? String(it['country']) : undefined,
          admin1: it['admin1'] ? String(it['admin1']) : undefined,
          population: Number(it['population'] ?? 0) || 0,
          featureCode: String(it['feature_code'] ?? ''),
        }
      }).filter(h => h.name && Number.isFinite(h.latitude) && Number.isFinite(h.longitude))
    : []
  omResults.sort((a, b) => (b.population - a.population) || (Number(MAJOR_FEATURE.test(b.featureCode)) - Number(MAJOR_FEATURE.test(a.featureCode))))
  const top = omResults[0]
  // 强命中:有人口规模或主要行政级,直接采信(「深圳市」「曼谷」路径不变)
  if (top && (top.population > 0 || MAJOR_FEATURE.test(top.featureCode))) {
    return { ok: true, evidence: `[实时API:open-meteo-geo@${ts}]`, via: 'open-meteo', results: stripHits(omResults) }
  }
  // 弱命中/零结果/主源请求失败:Nominatim 兜底(免费无 key;中文 accept-language)
  const nomTs = new Date().toISOString()
  const nomUrl = `${NOMINATIM_BASE}?q=${encodeURIComponent(query)}&format=jsonv2&limit=${count}&accept-language=zh&addressdetails=1`
  const nom = await fetchJson(nomUrl, remaining(), { 'User-Agent': 'gotry-travel-agent/0.1 (+https://github.com/Danceiny/gotry)' }, opts.fetchImpl)
  const nomResults: Array<{ name: string; latitude: number; longitude: number; country?: string; admin1?: string }> = nom.ok
    ? ((nom.data as unknown[]) ?? []).map((item) => {
        const it = item as Record<string, unknown>
        const addr = (it['address'] ?? {}) as Record<string, string>
        return {
          name: String(it['name'] ?? ''),
          latitude: Number(it['lat']),
          longitude: Number(it['lon']),
          country: addr['country'],
          admin1: addr['province'] ?? addr['state'] ?? addr['county'],
        }
      }).filter(h => h.name && Number.isFinite(h.latitude) && Number.isFinite(h.longitude))
    : []
  if (nomResults.length) {
    const omNote = r.ok
      ? `open-meteo ${omResults.length} 条弱命中(无人口/行政级,不足采信)`
      : `open-meteo 失败:${r.error ?? 'HTTP error'}`
    return { ok: true, evidence: `[实时API:nominatim@${nomTs}](兜底层: ${omNote})`, via: 'nominatim', results: nomResults }
  }
  // 双源皆空/兜底失败:open-meteo 有弱结果仍返回(同构「降级不阻塞」契约),否则维持失败终态
  if (omResults.length) {
    return { ok: true, evidence: `[实时API:open-meteo-geo@${ts}]`, via: 'open-meteo', results: stripHits(omResults) }
  }
  return {
    ok: false,
    evidence: `[实时API:open-meteo-geo@error@${ts}];[实时API:nominatim@error@${nomTs}]`,
    results: [],
    error: r.ok ? `双源无结果:${nom.error ?? 'nominatim empty'}` : (r.error),
  }
}

/** 未来天气预报(≤16 天) */
export async function getForecast(
  point: WeatherPoint,
  opts: { days?: number; timeoutMs?: number; fetchImpl?: FetchImpl } = {},
): Promise<WeatherResult> {
  const started = Date.now()
  const ts = new Date().toISOString()
  const days = Math.min(opts.days ?? 7, 16)
  const url = `${FORECAST_BASE}?latitude=${point.latitude}&longitude=${point.longitude}`
    + `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode`
    + `&forecast_days=${days}&timezone=auto`
  const r = await fetchJson(url, opts.timeoutMs ?? 15_000, {}, opts.fetchImpl)
  const latencyMs = Date.now() - started
  if (!r.ok) {
    return { ok: false, via: 'open-meteo-error', evidence: `[实时API:open-meteo@error@${ts}]`, latencyMs, error: r.error }
  }
  const daily = (r.data as { daily?: { time: string[]; temperature_2m_max: number[]; temperature_2m_min: number[]; precipitation_probability_max?: (number | null)[]; weathercode: number[] }; timezone?: string }).daily
  if (!daily || !Array.isArray(daily.time) || !Array.isArray(daily.temperature_2m_max)
    || !Array.isArray(daily.temperature_2m_min) || !Array.isArray(daily.weathercode)
    || daily.time.length !== days || daily.temperature_2m_max.length !== days
    || daily.temperature_2m_min.length !== days || daily.weathercode.length !== days) {
    return { ok: false, via: 'open-meteo-error', evidence: `[实时API:open-meteo@error@${ts}]`, latencyMs, error: 'empty daily payload' }
  }
  const rows: WeatherDaily[] = daily.time.map((date, i) => ({
    date,
    tempMaxC: daily.temperature_2m_max[i] ?? NaN,
    tempMinC: daily.temperature_2m_min[i] ?? NaN,
    precipProbMaxPct: daily.precipitation_probability_max?.[i] ?? null,
    weatherCode: daily.weathercode[i] ?? -1,
  }))
  return {
    ok: true, via: 'open-meteo',
    evidence: `[实时API:open-meteo@${ts}]`,
    latencyMs,
    timezone: (r.data as { timezone?: string }).timezone,
    daily: rows,
  }
}

/** 历史气候(季节性推荐底座:去年同期日均温/降雨概率) */
export async function getClimate(
  point: WeatherPoint,
  month: number,
  opts: { year?: number; timeoutMs?: number; fetchImpl?: FetchImpl } = {},
): Promise<WeatherResult> {
  const started = Date.now()
  const ts = new Date().toISOString()
  // 默认取去年同月做气候基线
  const year = opts.year ?? (new Date().getFullYear() - 1)
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const start = `${year}-${String(month).padStart(2, '0')}-01`
  const end = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
  const url = `${ARCHIVE_BASE}?latitude=${point.latitude}&longitude=${point.longitude}`
    + `&start_date=${start}&end_date=${end}`
    + `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode&timezone=auto`
  const r = await fetchJson(url, opts.timeoutMs ?? 15_000, {}, opts.fetchImpl)
  const latencyMs = Date.now() - started
  if (!r.ok) {
    return { ok: false, via: 'open-meteo-error', evidence: `[实时API:open-meteo-climate@error@${ts}]`, latencyMs, error: r.error }
  }
  const daily = (r.data as { daily?: { time: string[]; temperature_2m_max: number[]; temperature_2m_min: number[]; weathercode: number[] } }).daily
  if (!daily || !Array.isArray(daily.time) || !Array.isArray(daily.temperature_2m_max)
    || !Array.isArray(daily.temperature_2m_min) || !Array.isArray(daily.weathercode)
    || daily.time.length !== daily.temperature_2m_max.length
    || daily.time.length !== daily.temperature_2m_min.length
    || daily.time.length !== daily.weathercode.length) {
    return { ok: false, via: 'open-meteo-error', evidence: `[实时API:open-meteo-climate@error@${ts}]`, latencyMs, error: 'empty daily payload' }
  }
  const rows: WeatherDaily[] = daily.time.map((date, i) => ({
    date,
    tempMaxC: daily.temperature_2m_max[i] ?? NaN,
    tempMinC: daily.temperature_2m_min[i] ?? NaN,
    precipProbMaxPct: null, // archive 端点没有概率,用降水量另行估算
    weatherCode: daily.weathercode[i] ?? -1,
  }))
  return {
    ok: true, via: 'open-meteo',
    evidence: `[实时API:open-meteo-climate@${ts}]`,
    latencyMs,
    timezone: (r.data as { timezone?: string }).timezone,
    daily: rows,
  }
}
