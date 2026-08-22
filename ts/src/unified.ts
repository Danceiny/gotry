/**
 * 统一行程模型 TS 版(与 py/gotry_feasibility/unified.py 对齐;Python 为 oracle)。
 * 行程 = Segment 序列;选择单元是 SegmentOption(目的地或具体班次)。
 * 本文件实现:类型 + 双旧输入适配 + 航班链形态求解(Z3)。
 * 候选形态 TS 求解(枚举过滤)与 engine 等价对账在下一迁移段。
 */

import { init } from 'z3-solver'
import { checkConnectivity } from '../scripts/skeleton-check.ts'
import type { Service } from './model.ts'
import { hhmmToMin, minToHhmm } from './model.ts'
import type { LegReport } from './journey.ts'

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
  /** D-5:目的地相对出发地的时差(KMG-BKK=+60,DXB-SZX=-240) */
  tzOffsetMin?: number
  /** M-1:出发地 UTC 偏移(工作窗口换算用) */
  originTzOffsetMin?: number
}

/** M-1:旅行者工作窗口(家时区) */
export interface WorkWindowSpec {
  homeTzOffsetMin: number
  startMin: number
  endMin: number
  workdays?: number[]
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
  /** M-1:班次星期标注(mon/tue/.../sun),工作窗口过滤用 */
  depWeekday?: string
}

export interface SegmentTS {
  id: string
  role: 'choice' | 'fixed'
  note?: string
  date?: string
  /** 城市对提示("HKG->HKT"),骨架层通航校验用 */
  route?: string
  anchors?: AnchorsSpec
  options: SegmentOptionTS[]
}

export interface JourneySpecTS {
  note?: string
  segments: SegmentTS[]
  budgetCny?: number
  defaultWakeFloorMin?: number
  workWindow?: WorkWindowSpec
  /** 骨架层开关(§7-1):true 时对带 route 提示的段做通航性三值标注 */
  skeletonHub?: boolean
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let z3Promise: Promise<any> | null = null

async function getZ3(): Promise<any> {
  if (!z3Promise) z3Promise = (async () => (await init()).Context('main'))()
  return z3Promise
}

/** 航班数据包(data/flights_2026.json 形态)→ 段链 */
const SEGMENT_ROUTES: Record<string, string> = {
  f1: 'HKG->HKT', f2: 'HKT->BKK', f3: 'BKK->KMG', f4: 'KMG->SZX', f5: 'SZX->DXB',
}
function routeHint(id: string): string | undefined {
  return SEGMENT_ROUTES[id]
}

export function parseFlightPackToSpec(pack: Record<string, unknown>): JourneySpecTS {
  const legs = (pack['legs'] as Array<Record<string, unknown>>).map(l => ({
    id: String(l['id']),
    role: ((l['services'] as unknown[]).length === 1 ? 'fixed' : 'choice') as 'fixed' | 'choice',
    note: l['note'] ? String(l['note']) : undefined,
    date: l['date'] ? String(l['date']) : undefined,
    anchors: { arriveByMin: l['arrive_by'] ? hhmmToMin(String(l['arrive_by'])) : undefined },
    route: routeHint(l['id'] as string),
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
        tzOffsetMin: Number(l['tz_offset_min'] ?? 0),
        originTzOffsetMin: Number(l['origin_tz_offset_min'] ?? 480),
      },
    })),
  }))
  const meta = (pack['meta'] ?? {}) as Record<string, unknown>
  const ww = meta['work_window'] as Record<string, unknown> | undefined
  const spec: JourneySpecTS = {
    segments: legs,
    workWindow: ww ? {
      homeTzOffsetMin: Number(ww['home_tz_offset_min']),
      startMin: Number(ww['start_min']),
      endMin: Number(ww['end_min']),
      workdays: (ww['workdays'] as number[] | undefined) ?? [0, 1, 2, 3, 4],
    } : undefined,
  }
  // M-1:班次的星期标注挂到 Option(缺省=不受工作窗口约束)
  for (const l of pack['legs'] as Array<Record<string, unknown>>) {
    const seg = spec.segments.find(s => s.id === l['id'])!
    for (const svc of l['services'] as Array<Record<string, unknown>>) {
      if (svc['weekday']) {
        const opt = seg.options.find(o => o.id === svc['id'])
        if (opt) opt.depWeekday = String(svc['weekday'])
      }
    }
  }
  return spec
}

const WEEKDAY_IDX: Record<string, number> = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 }
const WEEKDAY_CN: Record<string, string> = { mon: '一', tue: '二', wed: '三', thu: '四', fri: '五', sat: '六', sun: '日' }

/** M-1:工作日的工作窗口内起飞 → 排除理由;否则 null(与 py _work_window_blocks 对齐)。 */
function workWindowBlocks(spec: JourneySpecTS, option: SegmentOptionTS): string | null {
  const ww = spec.workWindow
  if (!ww || !option.move || !option.depWeekday) return null
  if (!((ww.workdays ?? [0, 1, 2, 3, 4]).includes(WEEKDAY_IDX[option.depWeekday]))) return null
  const dep = option.move.services[0].depMin
  const shift = (option.move.originTzOffsetMin ?? 480) - ww.homeTzOffsetMin
  const start = ww.startMin + shift, end = ww.endMin + shift
  if (start <= dep && dep <= end) {
    const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
    return `周${WEEKDAY_CN[option.depWeekday]} ${hhmm(dep)} 起飞落在工作窗口(当地 ${hhmm(start)}-${hhmm(end)})内`
  }
  return null
}

/** D-5:时区感知的段核算(与 py unified._evaluate_option_move 对齐)。 */
function evaluateOptionMove(segId: string, mv: MoveSpecTS): LegReport & { d2d_min?: number } {
  const svc = mv.services[0]
  const wake = svc.depMin - mv.bufferMin - mv.originTransferMin
  // 真实时长 = (到达−出发) − 时差;EK329: 215−(−240)=455min=7h35m
  const trueFlight = (svc.arrMin - svc.depMin) - (mv.tzOffsetMin ?? 0)
  const d2d = mv.bufferMin + mv.originTransferMin + trueFlight + mv.destTransferMin
  const wakeDisplay = wake < 0 ? `${minToHhmm(wake + 1440)}(前一日)` : minToHhmm(wake)
  const arriveStay = svc.arrMin + mv.destTransferMin

  let energy: number
  if (mv.redEye && (mv.redEyeDurationMin ?? 0) > 0) {
    const sleepH = ((mv.redEyeDurationMin ?? 0) - 60) / 60
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
    d2d_min: d2d,
    energy_pct: Math.round(energy),
    price_cny: svc.priceCny,
  }
}

/** 航班链形态求解:按 Option 选择,锚点命名约束,core 剥竖线(D-2 修复) */
export async function solveUnified(spec: JourneySpecTS): Promise<{
  feasible: boolean
  money_cny?: number
  legs?: Array<LegReport & { leg: string }>
  red_flags?: string[]
  unsat_core?: string[]
  suggestions?: Array<{ relax: string; money_cny: number }>
  work_window_exclusions?: Array<{ segment: string; option: string; reason: string }>
  skeleton_notes?: string[]
}> {
  // M-1:求解前的工作窗口确定性预过滤(与 py 对齐),排除理由入记录
  // 骨架层(§7-1):三值语义标注——枢纽间否定只降权不排除(骨架滞后会错杀 EK329)
  const skeletonNotes: string[] = []
  const exclusions: Array<{ segment: string; option: string; reason: string }> = []
  for (const seg of spec.segments) {
    if (spec.skeletonHub) {
      // 段级骨架查询:route 提示(如 "HKG->HKT")优先,否则跳过
      const route = (seg as SegmentTS & { route?: string }).route
      if (route) {
        const [a, b] = route.split('->').map(s => s.trim())
        const verdict = await checkConnectivity(a, b)
        skeletonNotes.push(`${seg.id}: ${verdict.evidence}`)
      }
    }
    const kept = seg.options.filter(o => {
      const reason = workWindowBlocks(spec, o)
      if (reason) exclusions.push({ segment: seg.id, option: o.id, reason })
      return !reason
    })
    seg.options = kept
    if (kept.length === 0) {
      return { feasible: false, unsat_core: [`${seg.id}:work_window`], work_window_exclusions: exclusions }
    }
  }

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
        out.push({ leg: seg.id, ...evaluateOptionMove(seg.id, o.move!) })
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
    return { feasible: true, money_cny: money, legs, red_flags: redFlags, work_window_exclusions: exclusions, skeleton_notes: skeletonNotes.length ? skeletonNotes : undefined }
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
