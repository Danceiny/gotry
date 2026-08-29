/**
 * Multi-leg 行程引擎 TS 版(与 py/gotry_feasibility/journey.py 对齐;Python 为 oracle)。
 * DEPRECATED(D-1 清偿):统一模型(unified.ts)是唯一求解入口;保留为兼容层与差分 oracle。
 *
 * 每 leg 选一个班次,锚点(arrive_by/depart_after/wake_floor)为命名约束;
 * 无解读 unsat core,逐锚点放宽重解给方案。红眼段用睡眠模型
 * (精力 = 30 + 8×睡眠小时,clamp 30-75)。
 */

import type { Service } from './model.ts'
import { hhmmToMin, minToHhmm } from './model.ts'
import { withZ3 } from './z3-shared.ts'

export interface JourneyLegSpec {
  id: string
  note?: string
  services: Service[]
  bufferMin: number
  originTransferMin: number
  destTransferMin: number
  arriveByMin?: number
  departAfterMin?: number
  redEye?: boolean
  redEyeDurationMin?: number
}

export interface JourneyRequestSpec {
  note?: string
  legs: JourneyLegSpec[]
  budgetCny?: number
  wakeFloorMin?: number
}

export interface LegReport {
  service: string
  dep: string
  wake: string
  wakeMin: number
  arrive_stay: string
  door_to_door: string
  energy_pct: number
  price_cny: number
}

export interface JourneyResult {
  feasible: boolean
  money_cny?: number
  legs?: LegReport[]
  red_flags?: string[]
  unsat_core?: string[]
  suggestions?: Array<{ relax: string; money_cny: number; legs: Array<LegReport & { leg: string }> }>
}

/* eslint-disable @typescript-eslint/no-explicit-any */
// Z3 运行时收敛到 z3-shared(单一 WASM 实例 + 单一 Context + 会话级互斥);
// 本模块自有 z3Promise 已删(见 unified.ts / engine.ts 同批迁移)。

export function evaluateLeg(leg: JourneyLegSpec, svc: Service): LegReport {
  const wake = svc.depMin - leg.bufferMin - leg.originTransferMin
  const wakeDisplay = wake < 0 ? `${minToHhmm(wake + 1440)}(前一日)` : minToHhmm(wake)
  const arriveStay = svc.arrMin + leg.destTransferMin
  const d2d = arriveStay - wake
  let energy: number
  if (leg.redEye && (leg.redEyeDurationMin ?? 0) > 0) {
    const sleepH = ((leg.redEyeDurationMin ?? 0) - 60) / 60
    energy = Math.max(30, Math.min(75, 30 + 8 * sleepH))
  } else {
    energy = 100 - 2 * 8
    if (wake < 5 * 60) energy -= 30
    else if (wake < 6 * 60) energy -= 25
    if (arriveStay > 21 * 60) energy -= 10
    if (d2d > 6 * 60) energy -= 10
    energy = Math.max(0, energy)
  }
  return {
    service: svc.id,
    dep: minToHhmm(svc.depMin),
    wake: wakeDisplay,
    wakeMin: wake,
    arrive_stay: minToHhmm(arriveStay),
    door_to_door: `${Math.floor(d2d / 60)}h${String(d2d % 60).padStart(2, '0')}m`,
    energy_pct: Math.round(energy),
    price_cny: svc.priceCny,
  }
}

function exactlyOne(z3: any, sels: any[]): any {
  const { If, Sum, Int } = z3
  return Sum(...sels.map(s => If(s, Int.val(1), Int.val(0)))).eq(Int.val(1))
}

export async function solveJourney(req: JourneyRequestSpec): Promise<JourneyResult> {
  // 会话级互斥门:判定段从 here 到 return 独占共享实例,防同 Context 并发 unwind。
  return withZ3('journey.solveJourney', async z3 => {
  const { Bool, If, Sum, Int, Solver } = z3
  const wakeFloor = req.wakeFloorMin ?? hhmmToMin('06:00')

  const allSels: Record<string, any[]> = {}
  const assertions: Record<string, any> = {}
  const legSpecs: JourneyLegSpec[] = req.legs

  for (const leg of legSpecs) {
    const sels = leg.services.map((_, i) => Bool.const(`${leg.id}_s${i}`))
    allSels[leg.id] = sels
    const pick = (attr: 'depMin' | 'arrMin' | 'priceCny') =>
      Sum(...sels.map((s, i) => If(s, Int.val(leg.services[i][attr]), Int.val(0))))
    const dep = pick('depMin'), arr = pick('arrMin'), price = pick('priceCny')
    const wake = dep.sub(Int.val(leg.bufferMin + leg.originTransferMin))
    const arriveStay = arr.add(Int.val(leg.destTransferMin))
    if (leg.arriveByMin !== undefined) assertions[`${leg.id}:arrive_by`] = arriveStay.le(Int.val(leg.arriveByMin))
    if (leg.departAfterMin !== undefined) assertions[`${leg.id}:depart_after`] = dep.ge(Int.val(leg.departAfterMin))
    if (!leg.redEye) assertions[`${leg.id}:wake_floor`] = wake.ge(Int.val(wakeFloor))
  }

  const total = Sum(...legSpecs.flatMap(leg =>
    allSels[leg.id].map((s, i) => If(s, Int.val(leg.services[i].priceCny), Int.val(0)))))
  if (req.budgetCny !== undefined) assertions['total:budget'] = total.le(Int.val(req.budgetCny))

  const coreOf = (s: any): string[] => {
    const v = s.unsatCore()
    const out: string[] = []
    for (let i = 0; i < v.length(); i++) {
      // D-2 修复:JS 绑定的 unsat core 字符串带竖线定界("|f1:arrive_by|"),剥掉
      out.push(String(v.get(i)).replace(/^\|/, '').replace(/\|$/, ''))
    }
    return out
  }
  const extract = async (model: any): Promise<Map<string, Service>> => {
    const chosen = new Map<string, Service>()
    for (const leg of legSpecs) {
      for (let i = 0; i < allSels[leg.id].length; i++) {
        const v = await maybeAwait(model.eval(allSels[leg.id][i], true))
        if (String(v) === 'true') chosen.set(leg.id, leg.services[i])
      }
    }
    return chosen
  }

  const s = new Solver()
  for (const sel of Object.values(allSels)) s.add(exactlyOne(z3, sel))
  for (const [name, expr] of Object.entries(assertions)) s.addAndTrack(expr, name)

  if (String(await s.check()) !== 'unsat') {
    const chosen = await extract(s.model())
    const legReports = legSpecs.map(leg => evaluateLeg(leg, chosen.get(leg.id)!))
    const money = legReports.reduce((a, r) => a + r.price_cny, 0)
    const redFlags = [
      ...legSpecs.map((leg, i) => leg.redEye && legReports[i].energy_pct < 50
        ? `${leg.id} 落地精力仅 ${legReports[i].energy_pct}%(红眼后直奔事务,当日不宜安排重要会议)` : '')
        .filter(Boolean),
      ...legSpecs.map((leg, i) => !leg.redEye && legReports[i].wakeMin >= 0 && legReports[i].wakeMin < 6 * 60
        ? `${leg.id} 起床 ${legReports[i].wake}(早于 6:00,生物钟代价)` : '')
        .filter(Boolean),
    ]
    return { feasible: true, money_cny: money, legs: legReports, red_flags: redFlags }
  }

  const core = coreOf(s).sort()
  const suggestions: JourneyResult['suggestions'] = []
  for (const name of core) {
    const s2 = new Solver()
    for (const sel of Object.values(allSels)) s2.add(exactlyOne(z3, sel))
    for (const [n2, expr] of Object.entries(assertions)) {
      if (n2 !== name) s2.addAndTrack(expr, n2)
    }
    if (String(await s2.check()) !== 'unsat') {
      const chosen = await extract(s2.model())
      const rep = legSpecs.map(leg => evaluateLeg(leg, chosen.get(leg.id)!))
      suggestions.push({
        relax: name,
        money_cny: rep.reduce((a, r) => a + r.price_cny, 0),
        legs: rep.map((r, i) => ({ ...r, leg: legSpecs[i].id })),
      })
    }
  }
  return { feasible: false, unsat_core: core, suggestions }
  })
}

async function maybeAwait<T>(v: T | Promise<T>): Promise<T> {
  return v instanceof Promise ? await v : v
}

// JSON 数据包 → spec 的解析(data/flights_2026.json 形态)
export function parseFlightPackLegs(pack: Record<string, unknown>): JourneyRequestSpec['legs'] {
  const legs = (pack['legs'] as Array<Record<string, unknown>>).map(l => ({
    id: String(l['id']),
    note: l['note'] ? String(l['note']) : undefined,
    services: (l['services'] as Array<Record<string, unknown>>).map(sv => ({
      id: String(sv['id']),
      depMin: hhmmToMin(String(sv['dep'])),
      arrMin: hhmmToMin(String(sv['arr'])),
      priceCny: Number(sv['price_cny']),
    })),
    bufferMin: Number(l['buffer_min']),
    originTransferMin: Number(l['origin_transfer_min']),
    destTransferMin: Number(l['dest_transfer_min']),
    arriveByMin: l['arrive_by'] ? hhmmToMin(String(l['arrive_by'])) : undefined,
    redEye: Boolean(l['red_eye']),
    redEyeDurationMin: Number(l['red_eye_duration_min'] ?? 0),
  }))
  return legs
}
