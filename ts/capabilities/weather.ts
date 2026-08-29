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

export interface GeoPlace {
  name: string
  latitude: number
  longitude: number
  country?: string
  admin1?: string
  /** GeoNames 人口(千级以下多为同名小村,用于歧义防护;缺失视为 0) */
  population?: number
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

async function fetchJson(url: string, timeoutMs: number): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    return { ok: true, data: await res.json() }
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 200) }
  } finally {
    clearTimeout(timer)
  }
}

/** 地名 → 坐标(地理编码,供 dsh 工具把「大理」转成经纬度) */
export async function geocodePlace(
  name: string,
  opts: { timeoutMs?: number; count?: number } = {},
): Promise<{ ok: boolean; evidence: string; results: GeoPlace[]; error?: string }> {
  const ts = new Date().toISOString()
  const count = opts.count ?? 5
  const url = `${GEOCODE_BASE}?name=${encodeURIComponent(name)}&count=${count}&language=zh&format=json`
  const r = await fetchJson(url, opts.timeoutMs ?? 15_000)
  if (!r.ok) {
    return { ok: false, evidence: `[实时API:open-meteo-geo@error@${ts}]`, results: [], error: r.error }
  }
  const results = ((r.data as { results?: unknown[] })?.results ?? []).map((item) => {
    const it = item as Record<string, unknown>
    return {
      name: String(it['name'] ?? ''),
      latitude: Number(it['latitude']),
      longitude: Number(it['longitude']),
      country: it['country'] ? String(it['country']) : undefined,
      admin1: it['admin1'] ? String(it['admin1']) : undefined,
      population: it['population'] !== undefined ? Number(it['population']) : undefined,
    }
  })
  return { ok: true, evidence: `[实时API:open-meteo-geo@${ts}]`, results }
}

/**
 * 地名别名表(产品词表内「查不到」地名 → 地理编码可命中的规范形)。
 * 实测(2026-08-29,issue #24):GeoNames 无「普吉岛」条目(zh/en 均无结果);
 * 裸「普吉」唯一命中是西藏林芝普吉村(人口百级)——而产品语境(静态包/愿望池)
 * 中「普吉」均指泰国普吉。只收产品词表内条目,不做开放式中文地名 NLP
 * (有界解析原则,与 slot-spec/ADR-12 同款:开放词表是维护黑洞)。
 */
const PLACE_ALIASES: Record<string, string> = {
  '普吉岛': 'Phuket',
  '普吉': 'Phuket',
}

const PLACE_SUFFIXES = /[岛市县区镇乡村府]$/

export interface ResolvePlaceResult {
  ok: boolean
  evidence: string
  results: GeoPlace[]
  error?: string
  /** 依次尝试过的查询形式(失败诊断用) */
  tried: string[]
}

/**
 * 地名 → 坐标,带别名/去后缀解析阶梯(issue #24:「普吉岛」原样查询无结果)。
 * 阶梯:① 别名表(产品词表显式覆盖,优先) ② 原样 ③ 去通用后缀一次且只接受
 * population ≥ 1000 的候选(防「普吉」→西藏同名村类假阳性)。
 * 证据链标注实际命中的查询形式(via "form")。
 */
export async function resolvePlace(
  name: string,
  opts: { timeoutMs?: number; count?: number } = {},
): Promise<ResolvePlaceResult> {
  const tried: string[] = []
  const attempt = async (form: string, filter?: (r: GeoPlace) => boolean): Promise<ResolvePlaceResult | null> => {
    tried.push(form)
    const geo = await geocodePlace(form, opts)
    if (!geo.ok) {
      return { ok: false, evidence: geo.evidence, results: [], error: geo.error, tried: [...tried] }
    }
    const hits = filter ? geo.results.filter(filter) : geo.results
    if (hits.length === 0) return null
    const viaSuffix = form === name.trim() ? '' : ` via "${form}"`
    return { ok: true, evidence: `${geo.evidence}${viaSuffix}`, results: hits, tried: [...tried] }
  }
  const input = name.trim()
  if (!input) {
    return { ok: false, evidence: '[实时API:open-meteo-geo@error]', results: [], error: 'empty place name', tried }
  }
  // 别名优先于原样:显式映射是产品词表覆盖(裸「普吉」原样会命中西藏同名村)
  const steps: Array<{ form: string; filter?: (r: GeoPlace) => boolean }> = []
  const alias = PLACE_ALIASES[input]
  if (alias) steps.push({ form: alias })
  steps.push({ form: input })
  const stripped = input.replace(PLACE_SUFFIXES, '')
  if (stripped !== input && stripped.length >= 2) {
    steps.push({ form: stripped, filter: r => (r.population ?? 0) >= 1000 })
  }
  for (const step of steps) {
    const r = await attempt(step.form, step.filter)
    if (r) return r
  }
  return { ok: false, evidence: '[实时API:open-meteo-geo@nomatch]', results: [], error: '无结果', tried }
}

/** 未来天气预报(≤16 天) */
export async function getForecast(
  point: WeatherPoint,
  opts: { days?: number; timeoutMs?: number } = {},
): Promise<WeatherResult> {
  const started = Date.now()
  const ts = new Date().toISOString()
  const days = Math.min(opts.days ?? 7, 16)
  const url = `${FORECAST_BASE}?latitude=${point.latitude}&longitude=${point.longitude}`
    + `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode`
    + `&forecast_days=${days}&timezone=auto`
  const r = await fetchJson(url, opts.timeoutMs ?? 15_000)
  const latencyMs = Date.now() - started
  if (!r.ok) {
    return { ok: false, via: 'open-meteo-error', evidence: `[实时API:open-meteo@error@${ts}]`, latencyMs, error: r.error }
  }
  const daily = (r.data as { daily?: { time: string[]; temperature_2m_max: number[]; temperature_2m_min: number[]; precipitation_probability_max?: (number | null)[]; weathercode: number[] }; timezone?: string }).daily
  if (!daily) {
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
  opts: { year?: number; timeoutMs?: number } = {},
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
  const r = await fetchJson(url, opts.timeoutMs ?? 15_000)
  const latencyMs = Date.now() - started
  if (!r.ok) {
    return { ok: false, via: 'open-meteo-error', evidence: `[实时API:open-meteo-climate@error@${ts}]`, latencyMs, error: r.error }
  }
  const daily = (r.data as { daily?: { time: string[]; temperature_2m_max: number[]; temperature_2m_min: number[]; weathercode: number[] } }).daily
  if (!daily) {
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
