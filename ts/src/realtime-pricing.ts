/**
 * 实时票价 overlay(README Known limitation「机票实时数据」清偿件):
 * 静态包(data/flights_2026.json)仍是兜底,不再是唯一票价源——dated 航班链 spec
 * (段带 date + route 词表内城市对)可经 FlyAI 官方只读通道(gotry_flyai_search 同源
 * `capabilities/flyai.ts`)取实时价,按航班号精确匹配覆写 spec 价格后进求解,
 * 证据链 `[实时API:flyai@ts]` 随行(data-sources §6)。
 *
 * 三值语义(永不抛错,与 hbcli/weather/opensky/anything 同构,L4 不变量):
 *   - hit 且价正 → 覆写 + 记 evidence(静态原价留档对账);
 *   - miss/error/打码价(如 "1xxx",非正数)/无匹配 → 段原样保留(静态价即降级);
 *   - 查询实现注入(测试离线确定性);默认关,`GOTRY_REALTIME_PRICING=1` 开启产品面。
 */

import { flyaiSearch, type FlyaiOption, type FlyaiResult } from '../capabilities/flyai.ts'
import type { JourneySpecTS, SegmentTS } from './unified.ts'

export interface RealtimeQueryPort {
  (q: { kind: 'flight' | 'train'; origin: string; destination: string; depDate: string }): Promise<FlyaiResult>
}

/** FlyAI CLI 收中文城市名;route 提示是 IATA 码(spec 层骨架词表,与 skeleton-check 同源) */
const IATA_TO_CITY: Record<string, string> = {
  HKG: '香港', HKT: '普吉', BKK: '曼谷', KMG: '昆明', SZX: '深圳', DXB: '迪拜',
  LJG: '丽江', DLU: '大理', SHA: '上海', PVG: '上海', PEK: '北京', CTU: '成都',
}

export interface RtOverlay {
  spec: JourneySpecTS
  /** 覆写明细:段/选项/静态价 → 实时价 + 证据链 */
  matched: Array<{ segment: string; option: string; staticCny: number; realtimeCny: number; evidence: string }>
  /** 传给求解渲染的证据行(汇入 skeleton_notes 同通道) */
  notes: string[]
}

/**
 * dated 航班链 spec 的实时票价覆写:
 * - 只碰 `date`(YYYY-MM-DD)且 route 落在词表内的段;火车段(无 route 词表)原样;
 * - 段内 option 按 service id(=航班号,大小写不敏感)与 FlyAI 条目精确匹配;
 * - 任何失败(查询 error/miss、价格非正数、无匹配)→ 该段原样保留,绝不抛错。
 */
export async function overlayRealtimeFlightPrices(
  spec: JourneySpecTS,
  opts: { query?: RealtimeQueryPort } = {},
): Promise<RtOverlay> {
  const out: RtOverlay = { spec, matched: [], notes: [] }
  const flights: Array<{ seg: SegmentTS; date: string; origin: string; destination: string }> = []
  for (const seg of spec.segments) {
    if (!seg.date || !/^\d{4}-\d{2}-\d{2}$/.test(seg.date)) continue
    const route = (seg as SegmentTS & { route?: string }).route
    if (!route || !route.includes('->')) continue
    const [a, b] = route.split('->').map(s => IATA_TO_CITY[s.trim()])
    if (!a || !b) continue
    if (seg.options.some(o => !o.move)) continue
    flights.push({ seg, date: seg.date, origin: a, destination: b })
  }
  if (flights.length === 0) return out

  const query: RealtimeQueryPort = opts.query ?? defaultQuery
  for (const f of flights) {
    let result: FlyaiResult
    try {
      result = await query({ kind: 'flight', origin: f.origin, destination: f.destination, depDate: f.date })
    } catch (e) {
      out.notes.push(`${f.seg.id}: 实时票价不可用(降级静态包):${(e as Error).message?.slice(0, 80)} [实时API:flyai@error]`)
      continue
    }
    if (!result.ok || result.verdict !== 'hit' || !result.options?.length) {
      out.notes.push(`${f.seg.id}: 实时票价未取回(${result.verdict},降级静态包) ${result.evidence}`)
      continue
    }
    const ts = /@(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]/.exec(result.evidence)?.[1] ?? new Date().toISOString()
    const byNo = new Map<string, FlyaiOption>()
    for (const o of result.options) {
      if (Number.isFinite(o.price) && o.price > 0) byNo.set(o.no.toUpperCase(), o)
    }
    for (const opt of f.seg.options) {
      const svc = opt.move!.services[0]
      const rt = byNo.get(svc.id.toUpperCase())
      if (!rt) continue
      const evidence = `[实时API:flyai@${ts}] ${rt.no} ¥${rt.price}(静态包原价 ¥${svc.priceCny})`
      out.matched.push({ segment: f.seg.id, option: opt.id, staticCny: svc.priceCny, realtimeCny: rt.price, evidence })
      out.notes.push(evidence)
      svc.priceCny = rt.price
    }
  }
  return out
}

const defaultQuery: RealtimeQueryPort = q => flyaiSearch({ kind: q.kind, origin: q.origin, destination: q.destination, depDate: q.depDate })

interface SolveResultWithNotes {
  feasible: boolean
  money_cny?: number
  skeleton_notes?: string[]
}

/** 求解端口包装(产品接缝):`GOTRY_REALTIME_PRICING=1`(或 opts.enabled)时 dated 航班链段
 * 先经 FlyAI 实时价覆写,证据行并进结果 skeleton_notes;关闸/零覆写零改动,永不抛错。 */
export function realtimeSolvePort<T extends SolveResultWithNotes>(
  base: (spec: JourneySpecTS) => Promise<T>,
  opts: { query?: RealtimeQueryPort; enabled?: boolean } = {},
): (spec: JourneySpecTS) => Promise<T> {
  return async spec => {
    const enabled = opts.enabled ?? process.env['GOTRY_REALTIME_PRICING'] === '1'
    if (!enabled) return base(spec)
    try {
      const ov = await overlayRealtimeFlightPrices(spec, opts)
      if (ov.matched.length === 0 && ov.notes.length === 0) return base(ov.spec)
      const res = await base(ov.spec)
      res.skeleton_notes = [...(res.skeleton_notes ?? []), ...ov.notes]
      return res
    } catch {
      return base(spec) // 覆写层任何异常 → 纯静态包原路求解
    }
  }
}