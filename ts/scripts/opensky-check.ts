/**
 * OpenSky 校验桥(M2 段 3 第一件,§7-1 免费路线的校验层):验证某航班真实执飞。
 * 零新依赖:匿名 REST(400 credits/天),失败降级为「校验不可用」而非阻塞规划。
 * 证据链:[实时API:opensky] + 抓取时间;查不到≠不存在(ADS-B 覆盖有限),只作正向印证。
 * 运行:cd ts && npx tsx scripts/opensky-check.ts EK329
 */

const BASE = 'https://opensky-network.org/api'

interface Arrival {
  icao24: string
  firstSeen: number
  lastSeen: number
  arrivalAirport: string | null
  departureAirport: string | null
  callsign: string | null
}

async function checkArrival(callsign: string, airport: string | null): Promise<string> {
  // 匿名窗口只支持近 7 天;演示用最近的到达查询验证桥通不通
  const now = Math.floor(Date.now() / 1000)
  const url = airport
    ? `${BASE}/arrivals?airport=${airport}&begin=${now - 7 * 86400}&end=${now}`
    : `${BASE}/arrivals?airport=OMDB&begin=${now - 7 * 86400}&end=${now}`
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) return `[校验不可用:opensky ${res.status}]`
  const data = (await res.json()) as Arrival[]
  const hit = data.find(a => (a.callsign ?? '').trim().toUpperCase().includes(callsign.toUpperCase()))
  const ts = new Date().toISOString()
  return hit
    ? `[实时API:opensky@${ts}] ✅ ${callsign} 近 7 天执飞记录:到达 ${hit.arrivalAirport ?? '?'}(callsign ${hit.callsign?.trim()})`
    : `[实时API:opensky@${ts}] ○ 近 7 天 ${airport ?? 'OMDB'} 到达列表未见 ${callsign}(ADS-B 覆盖有限,不作否定结论)`
}

const target = process.argv[2] ?? 'EK329'
console.log(await checkArrival(target, process.argv[3] ?? null))
