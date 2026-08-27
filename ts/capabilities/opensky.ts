/**
 * OpenSky 实时观测桥(免费匿名,~400 credits/天,~4 req/s burst):
 * 查某 callsign 的飞机是否在 ADS-B 网络的当前观测里——航线层的实时印证。
 *
 * 契约(与 weather.ts / hbcli.ts 同构):
 *   - 永不抛错:网络失败/超时/解析失败一律降级返回;
 *   - 三值语义:命中=强肯定;查空≠证伪(ADS-B 覆盖有限,降权不排除);服务不可用=无结论;
 *   - 证据链:成功 [实时API:opensky@ts];失败 [实时API:opensky@error@ts]。
 *
 * 接口面(2026-08 实际可达,匿名路径):
 *   GET /api/states/all  — 当前全球 ADS-B 状态,~10000 架
 *   GET /api/states/all?icao24=<hex>  — 单飞机
 *   /api/flights/airport 历史查 = 需鉴权(匿名 403)
 *
 * 数据意义:与 OpenFlights 骨架(通航性)+ 静态班次包(班期时刻) 三值互补——
 *   OpenFlights = 历史上是否通航过(offline)
 *   flights_2026.json = 调研估算的班次时刻
 *   OpenSky = 该 callsign 的飞机「现在」是否在观测网络里(实时刻正飞)
 *
 * v0.0.1-rc.3 +: 之前是 scripts/opensky-check.ts 一次性 CLI(M2 时设计为 7 天窗
 * 历史校验,但匿名路径实际不可达),现升级为能力层封装 + dsh 插件工具。
 */

export interface FlightLiveQuery {
  /** 航班号/呼号(如 EK329 / CA985);大小写都行 */
  callsign: string
  /** 调用方所属机场 ICAO 四字码(用于地理命中),不传只返回 obs 状态 */
  airport?: string
  /** 超时(ms);默认 10_000 */
  timeoutMs?: number
}

export interface FlightHit {
  icao24: string
  callsign: string | null
  /** OpenSky states/all 用 last_contact 列作为时间戳代理 */
  lastSeen: number
  firstSeen: number
  /** 调用方传入的机场(OpenSky states/all 不返回) */
  estArrivalAirport: string | null
}

export interface FlightVerifyResult {
  verdict: 'observed' | 'not_observed' | 'unavailable'
  callsign: string
  airport: string | null
  sampleSize: number
  hits?: FlightHit[]
  evidence: string
  via: 'opensky' | 'opensky-error'
  latencyMs: number
  error?: string
}

const BASE = 'https://opensky-network.org/api'

async function fetchOpenSky(url: string, timeoutMs: number): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'gotry/0.0.1-rc.3 (+https://github.com/Danceiny/gotry)' },
    })
    if (!res.ok) return { ok: false, error: `opensky HTTP ${res.status}${res.status === 429 ? ' (rate limited, 400 credits/day anonymous)' : ''}` }
    return { ok: true, data: await res.json() }
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 200) }
  } finally {
    clearTimeout(timer)
  }
}

const upper = (s: string): string => s.trim().toUpperCase()

export async function verifyFlight(query: FlightLiveQuery): Promise<FlightVerifyResult> {
  const started = Date.now()
  const ts = new Date().toISOString()
  const cs = upper(query.callsign)
  const airport = query.airport ? upper(query.airport) : null
  const r = await fetchOpenSky(`${BASE}/states/all`, query.timeoutMs ?? 10_000)
  const latencyMs = Date.now() - started

  if (!r.ok) {
    return {
      verdict: 'unavailable',
      callsign: cs, airport,
      sampleSize: 0, hits: [],
      evidence: `[实时API:opensky@error@${ts}] ${r.error}`,
      via: 'opensky-error',
      latencyMs, error: r.error,
    }
  }

  // /api/states/all → { time, states: Array<17 元素数组> }
  // [0 icao24, 1 callsign, 2 origin_country, 3 time_position, 4 last_contact,
  //  5 lon, 6 lat, 7 baro_altitude, 8 on_ground, ...]
  const rawStates: unknown[][] = ((r.data ?? {}) as { states?: unknown[][] }).states ?? []
  const observed: FlightHit[] = rawStates
    .filter(row => ((row[1] ?? '') as string).trim().toUpperCase().includes(cs))
    .map(row => ({
      icao24: String(row[0] ?? ''),
      callsign: ((row[1] ?? '') as string).trim() || null,
      lastSeen: Number(row[4] ?? 0),
      firstSeen: Number(row[4] ?? 0),
      estArrivalAirport: airport,
    }))

  const verdict: FlightVerifyResult['verdict'] = observed.length > 0 ? 'observed' : 'not_observed'
  const evidence = observed.length > 0
    ? `[实时API:opensky@${ts}] ✅ 全球 ADS-B 当前观测命中 ${cs} (${observed.length} 架)`
    : `[实时API:opensky@${ts}] ○ 当前 ADS-B 全球观测列表未见 ${cs}(ADS-B 覆盖有限,不作否定结论)`

  return {
    verdict, callsign: cs, airport,
    sampleSize: rawStates.length,
    hits: observed, evidence,
    via: 'opensky',
    latencyMs,
  }
}
