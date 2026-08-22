/**
 * 统一行程模型 TS 版(与 py/gotry_feasibility/unified.py 对齐;Python 为 oracle)。
 * 行程 = Segment 序列;选择单元是 SegmentOption(目的地或具体班次)。
 * 本文件实现:类型 + 双旧输入适配 + 航班链形态求解(Z3)。
 * 候选形态 TS 求解(枚举过滤)与 engine 等价对账在下一迁移段。
 */

import { init } from 'z3-solver'
import { Service, hhmmToMin, minToHhmm } from './model.ts'
import { evaluateLeg, LegReport } from './journey.ts'

export interface AnchorsSpec {
  arriveByMin?: number
  departAfterMin?: number
  minDays?: number
  wakeFloorMin?: number
}

export interface MoveSpecTS {
  hub: string
  services: Service[]
  retServices?: Service[]
  transfers?: Array<{ mode: string; minutes: number; priceCny: number }>
  bufferMin: number
  bufferRetMin?: number
  originTransferMin: number
  destTransferMin: number
  redEye?: boolean
  redEyeDurationMin?: number
}

export interface StaySpecTS {
  nights: number
  stayCnyPerNight?: number
  localDailyCny?: number
  /** M-1 预留:{ tz: 'UTC+4', start: '10:00', end: '19:00' } */
  workWindow?: { tz: string; start: string; end: string }
}

export interface SegmentOptionTS {
  id: string
  label: string
  move?: MoveSpecTS
  stay?: StaySpecTS
  score?: number
  bestMonths?: number[]
  minDays?: number
}

export interface SegmentTS {
  id: string
  role: 'choice' | 'fixed'
  note?: string
  date?: string
  anchors?: AnchorsSpec
  options: SegmentOptionTS[]
}

export interface JourneySpecTS {
  note?: string
  segments: SegmentTS[]
  budgetCny?: number
  defaultWakeFloorMin?: number
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let z3Promise: Promise<any> | null = null

async function getZ3(): Promise<any> {
  if (!z3Promise) z3Promise = (async () => (await init()).Context('main'))()
  return z3Promise
}

/** 航班数据包(data/flights_2026.json 形态)→ 段链 */
export function parseFlightPackToSpec(pack: Record<string, unknown>): JourneySpecTS {
  const legs = (pack['legs'] as Array<Record<string, unknown>>).map(l => ({
    id: String(l['id']),
    role: ((l['services'] as unknown[]).length === 1 ? 'fixed' : 'choice') as 'fixed' | 'choice',
    note: l['note'] ? String(l['note']) : undefined,
    date: l['date'] ? String(l['date']) : undefined,
    anchors: { arriveByMin: l['arrive_by'] ? hhmmToMin(String(l['arrive_by'])) : undefined },
    options: (l['services'] as Array<Record<string, unknown>>).map(sv => ({
      id: String(sv['id']),
      label: `${String(sv['id'])} ${String(l['note'] ?? '').slice(0, 18)}`,
      move: {
        hub: String(l['hub'] ?? ''),
        services: [{ id: String(sv['id']), depMin: hhmmToMin(String(sv['dep'])), arrMin: hhmmToMin(String(sv['arr'])), priceCny: Number(sv['price_cny']) }],
        bufferMin: Number(l['buffer_min']),
        originTransferMin: Number(l['origin_transfer_min']),
        destTransferMin: Number(l['dest_transfer_min']),
        redEye: Boolean(l['red_eye']),
        redEyeDurationMin: Number(l['red_eye_duration_min'] ?? 0),
      },
    })),
  }))
  return { segments: legs }
}

/** 航班链形态求解:按 Option 选择,锚点命名约束,core 剥竖线(D-2 修复) */
export async function solveUnified(spec: JourneySpecTS): Promise<{
  feasible: boolean
  money_cny?: number
  legs?: Array<LegReport & { leg: string }>
  red_flags?: string[]
  unsat_core?: string[]
  suggestions?: Array<{ relax: string; money_cny: number }>
}> {
  const z3 = await getZ3()
  const { Bool, If, Int, Solver, Sum } = z3
  const wakeFloor = spec.defaultWakeFloorMin ?? hhmmToMin('06:00')

  const allSels: Record<string, any[]> = {}
  const assertions: Record<string, any> = {}
  const svcOf: Record<string, Service[]> = {}

  for (const seg of spec.segments) {
    const sels = seg.options.map((_, i) => Bool.const(`${seg.id}_o${i}`))
    allSels[seg.id] = sels
    const svcs = seg.options.map(o => o.move!.services[0])
    svcOf[seg.id] = svcs
    const pick = (attr: 'depMin' | 'arrMin' | 'priceCny') =>
      Sum(...sels.map((s: any, i: number) => If(s, Int.val(svcs[i][attr]), Int.val(0))))
    const dep = pick('depMin'), arr = pick('arrMin')
    const o0 = seg.options[0].move!
    const wake = dep.sub(Int.val(o0.bufferMin + o0.originTransferMin))
    const arriveStay = arr.add(Int.val(o0.destTransferMin))
    if (seg.anchors?.arriveByMin !== undefined) assertions[`${seg.id}:arrive_by`] = arriveStay.le(Int.val(seg.anchors.arriveByMin))
    if (seg.anchors?.departAfterMin !== undefined) assertions[`${seg.id}:depart_after`] = dep.ge(Int.val(seg.anchors.departAfterMin))
    if (!seg.options.some(o => o.move?.redEye)) assertions[`${seg.id}:wake_floor`] = wake.ge(Int.val(wakeFloor))
  }

  const total = Sum(...spec.segments.flatMap(seg =>
    allSels[seg.id].map((s: any, i: number) => If(s, Int.val(svcOf[seg.id][i].priceCny), Int.val(0)))))
  if (spec.budgetCny !== undefined) assertions['total:budget'] = total.le(Int.val(spec.budgetCny))

  const exactlyOne = (sels: any[]) =>
    Sum(...sels.map((s: any) => If(s, Int.val(1), Int.val(0)))).eq(Int.val(1))
  const coreOf = (s: any): string[] => {
    const v = s.unsatCore()
    const out: string[] = []
    for (let i = 0; i < v.length(); i++) out.push(String(v.get(i)).replace(/^\|/, '').replace(/\|$/, ''))
    return out
  }

  const s = new Solver()
  for (const sel of Object.values(allSels)) s.add(exactlyOne(sel))
  for (const [name, expr] of Object.entries(assertions)) s.addAndTrack(expr, name)

  const report = async (model: any): Promise<Array<LegReport & { leg: string }>> => {
    const out: Array<LegReport & { leg: string }> = []
    for (const seg of spec.segments) {
      for (let i = 0; i < allSels[seg.id].length; i++) {
        const v = await maybeAwait(model.eval(allSels[seg.id][i], true))
        if (String(v) !== 'true') continue
        const o = seg.options[i]
        out.push({
          leg: seg.id,
          ...evaluateLeg({
            id: seg.id,
            services: o.move!.services,
            bufferMin: o.move!.bufferMin,
            originTransferMin: o.move!.originTransferMin,
            destTransferMin: o.move!.destTransferMin,
            redEye: o.move!.redEye,
            redEyeDurationMin: o.move!.redEyeDurationMin,
          }, o.move!.services[0]),
        })
        break
      }
    }
    return out
  }

  async function maybeAwait<T>(v: T | Promise<T>): Promise<T> {
    return v instanceof Promise ? await v : v
  }

  if (String(await s.check()) !== 'unsat') {
    const legs = await report(s.model())
    const money = legs.reduce((a, l) => a + l.price_cny, 0)
    const redFlags = legs
      .filter(l => spec.segments.find(sg => sg.id === l.leg)?.options.some(o => o.move?.redEye) && l.energy_pct < 50)
      .map(l => `${l.leg} 落地精力仅 ${l.energy_pct}%(红眼后直奔事务,当日不宜安排重要会议)`)
    return { feasible: true, money_cny: money, legs, red_flags: redFlags }
  }

  const core = coreOf(s).sort()
  const suggestions: Array<{ relax: string; money_cny: number }> = []
  for (const name of core) {
    const s2 = new Solver()
    for (const sel of Object.values(allSels)) s2.add(exactlyOne(sel))
    for (const [n2, expr] of Object.entries(assertions)) {
      if (n2 !== name) s2.addAndTrack(expr, n2)
    }
    if (String(await s2.check()) !== 'unsat') {
      const legs = await report(s2.model())
      suggestions.push({ relax: name, money_cny: legs.reduce((a, l) => a + l.price_cny, 0) })
    }
  }
  return { feasible: false, unsat_core: core, suggestions }
}

export { minToHhmm }
