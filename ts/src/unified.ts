/**
 * 统一行程模型 TS 版(与 py/gotry_feasibility/unified.py 对齐;Python 为 oracle)。
 * 行程 = Segment 序列;选择单元是 SegmentOption(目的地或具体班次)。
 * 本文件实现:类型 + 双旧输入适配 + 航班链形态求解(Z3)。
 * 候选形态 TS 求解(枚举过滤)与 engine 等价对账在下一迁移段。
 */

import { checkConnectivity } from '../scripts/skeleton-check.ts'
import type { Candidate, Choice, MotivationProfile, Service, TransferMode, TravelRequest, TrueCost } from './model.ts'
import { evaluateChoice, minToHhmm, hhmmToMin, requiredUsableHours, trueCostToDict, LATEST_ARRIVE_STAY_MIN } from './model.ts'
import type { LegReport } from './journey.ts'
import { withZ3 } from './z3-shared.ts'
import { t as i18nT } from './i18n.ts'

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
  /** D-6:红眼航段落地后接驳(机场→住处/办公室)的乘车补眠时长(分钟);机上已算,落地接驳未算 */
  groundRecoveryMin?: number
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

// Z3 运行时收敛到 z3-shared(单一 WASM 实例 + 单一 Context + 会话级互斥)——
// 此前模块级 z3Promise 三份并存是 WASM race/OOM 的根因(见 z3-shared.ts 头注)。
/* eslint-disable @typescript-eslint/no-explicit-any */

/** 航班数据包(data/flights_2026.json 形态)→ 段链 */
const SEGMENT_ROUTES: Record<string, string> = {
  f1: 'HKG->HKT', f2: 'HKT->BKK', f3: 'BKK->KMG', f4: 'KMG->SZX', f5: 'SZX->DXB',
  yn1: 'SZX->LJG', yn2: 'LJG->DLU', yn3: 'DLU->LJG', yn4: 'LJG->SZX',
}
function routeHint(id: string): string | undefined {
  return SEGMENT_ROUTES[id]
}

// ---- 适配器:旧候选用例(洱海形态:request + candidates)→ 单 choice 段 -------------
// 与 py unified.py segments_from_candidate 逐行对齐

export function segmentsFromCandidate(req: TravelRequest, candidates: Candidate[]): JourneySpecTS {
  const motHard = req.motivation
  const wakeFloor = motHard.wakeFloorMin
  const options: SegmentOptionTS[] = candidates.map(c => ({
    id: c.id,
    label: c.name,
    score: c.imageryMatch,
    bestMonths: c.bestMonths,
    minDays: c.minDaysForPurpose,
    move: {
      hub: c.hub,
      services: [...c.servicesOut],
      retServices: [...c.servicesRet],
      transfers: [...c.destTransfers],
      bufferMin: c.bufferOutMin,
      bufferRetMin: c.bufferRetMin,
      originTransferMin: 0, // 候选形态无独立接驳(并入 destTransfers)
      destTransferMin: 0,
    },
    stay: {
      nights: req.windowDays - 1,
      stayCnyPerNight: c.stayCnyPerNight,
      localDailyCny: c.localDailyCny,
    },
  }))
  const escape = req.motivation.weights['escape_rest'] ?? 0
  return {
    note: req.note,
    segments: [{
      id: 'dest',
      role: 'choice',
      note: '目的地选择',
      anchors: { wakeFloorMin: wakeFloor },
      options,
    }],
    budgetCny: req.budgetCny,
    defaultWakeFloorMin: wakeFloor,
  }
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
    return i18nT('un.workwindow_reason', {
      wd: WEEKDAY_CN[option.depWeekday] ?? '', dep: hhmm(dep), start: hhmm(start), end: hhmm(end),
    })
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
    // D-6 校准:机上睡眠上限 75;落地接驳(destTransferMin)乘车补眠回血(1h≈+5%,上限 80)
    const groundH = (mv.groundRecoveryMin ?? mv.destTransferMin ?? 0) / 60
    const recovery = Math.min(5, 5 * groundH)
    energy = Math.max(30, Math.min(75 + recovery, 80, 30 + 8 * sleepH + recovery))
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
  // WASM 防护:如果 z3-solver 加载或求解触发 memory access 错误,不让异常穿透到进程层把 dsh 杀掉。
  // 候选形态走 solveChoiceSegment 不经过这里——这里是显式航班链路径,用户量较少。
  try {
    return await solveUnifiedInner(spec)
  } catch (e) {
    console.error('[gotry] solveUnified failed (likely wasm thread race):', (e as Error).message?.slice(0, 200))
    return { feasible: false, unsat_core: ['wasm_runtime_error'], red_flags: ['WASM 求解器异常,建议下次用候选形态(枚举)重试'] }
  }
}

async function solveUnifiedInner(spec: JourneySpecTS): Promise<{
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

  // Z3 会话进互斥门(骨架/预过滤等网络段留在门外):solveUnifiedInner 的判定段
  // 从 here 到 return 全部独占共享实例。
  return withZ3('unified.solveUnifiedInner', async z3 => {
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
      .map(l => i18nT('un.redflag_redeye', { leg: l.leg, pct: l.energy_pct }))
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
  })
}

// ---- 候选形态求解(枚举过滤,与 py solve_choice_segment 对齐) --------------------

interface CandidateChecks {
  wake_floor?: boolean
  energy_floor?: boolean
  usable_hours?: boolean
  budget?: boolean
  arrival_before_evening?: boolean
}

function checkTrueCost(t: TrueCost, spec: {
  wakeFloorMin: number; minArrivalEnergyPct: number; requiredUsableHours: number;
  budgetCny?: number; latestArriveStayMin: number;
}): string[] {
  const fails: string[] = []
  if (t.wakeMin < spec.wakeFloorMin) fails.push('wake_floor')
  if (t.energyArrivalPct < spec.minArrivalEnergyPct) fails.push('energy_floor')
  if (t.usableHours < spec.requiredUsableHours) fails.push('usable_hours')
  if (spec.budgetCny !== undefined && t.moneyCny > spec.budgetCny) fails.push('budget')
  if (t.arriveStayMin > spec.latestArriveStayMin) fails.push('arrival_before_evening')
  return fails
}

function enumerateCombos(opt: SegmentOptionTS, cand: Candidate, req: TravelRequest, days: number):
  Array<{ choice: Choice; cost: TrueCost; fails: string[] }> {
  const mv = opt.move!
  const out: Array<{ choice: Choice; cost: TrueCost; fails: string[] }> = []
  const spec = {
    wakeFloorMin: req.motivation.wakeFloorMin,
    minArrivalEnergyPct: req.motivation.minArrivalEnergyPct,
    requiredUsableHours: requiredUsableHours(req.motivation),
    budgetCny: req.budgetCny,
    latestArriveStayMin: LATEST_ARRIVE_STAY_MIN,
  }
  for (const o of mv.services) {
    for (const tr of mv.transfers ?? []) {
      for (const r of (mv.retServices ?? mv.services)) {
        for (const trr of mv.transfers ?? []) {
          const ch: Choice = { outService: o, outTransfer: tr, retService: r, retTransfer: trr, days }
          const t = evaluateChoice(cand, req, ch)
          out.push({ choice: ch, cost: t, fails: checkTrueCost(t, spec) })
        }
      }
    }
  }
  return out
}

function optionToCandidate(opt: SegmentOptionTS): Candidate {
  const mv = opt.move!, st = opt.stay!
  return {
    id: opt.id, name: opt.label, hub: mv.hub,
    bufferOutMin: mv.bufferMin, bufferRetMin: mv.bufferRetMin ?? mv.bufferMin,
    servicesOut: [...mv.services], servicesRet: [...(mv.retServices ?? mv.services)],
    destTransfers: [...(mv.transfers ?? [])],
    stayCnyPerNight: st.stayCnyPerNight ?? 0, localDailyCny: st.localDailyCny ?? 0,
    minDaysForPurpose: opt.minDays ?? 1,
    imageryMatch: opt.score ?? 0, bestMonths: opt.bestMonths ?? [],
  }
}

/** 单 choice 段(目的地选项):逐 Option 枚举过滤,按 score 排序。与 py solve_choice_segment 等价。 */
export function solveChoiceSegment(spec: JourneySpecTS, req: TravelRequest): Record<string, unknown> {
  const seg = spec.segments.find(s => s.role === 'choice' && s.options.length > 0 && s.options[0].stay)
  if (!seg) throw new Error('solveChoiceSegment: no choice segment with stay found')
  const windowDays = req.windowDays
  const verdicts: Array<Record<string, unknown>> = []

  for (const opt of seg.options) {
    const cand = optionToCandidate(opt)
    const minDays = cand.minDaysForPurpose
    const durationOk = windowDays >= minDays
    const combos = durationOk ? enumerateCombos(opt, cand, req, windowDays) : []
    const good = combos.filter(c => c.fails.length === 0)

    if (good.length > 0) {
      const best = good.reduce((a, b) => a.cost.moneyCny <= b.cost.moneyCny ? a : b)
      verdicts.push({
        candidate_id: opt.id, name: opt.label, feasible: true, imagery_match: opt.score ?? 0,
        chosen: {
          out_service: best.choice.outService.id, out_transfer: best.choice.outTransfer.mode,
          ret_service: best.choice.retService.id, ret_transfer: best.choice.retTransfer.mode,
          days: best.choice.days,
        },
        true_cost: trueCostToDict(best.cost),
      })
      continue
    }

    // 不可行:归因 + duration 换长口径的 wish pool
    const blocked = durationOk
      ? Array.from(new Set(combos.flatMap(c => c.fails))).sort()
      : ['duration']
    const suggestions: Array<{ relax: string; resulting_money_cny?: number }> = []
    for (const name of blocked) {
      const opened = combos.filter(c => !c.fails.includes(name))
      if (opened.length > 0) {
        const cheapest = opened.reduce((a, b) => a.cost.moneyCny <= b.cost.moneyCny ? a : b)
        suggestions.push({ relax: name, resulting_money_cny: cheapest.cost.moneyCny })
      }
    }
    let wish: Record<string, unknown> | null = null
    if (!durationOk) {
      const longCombos = enumerateCombos(opt, cand, req, minDays)
      const budgetDropped = longCombos.filter(c => c.fails.length === 0 || (c.fails.length === 1 && c.fails[0] === 'budget'))
      const conds: Record<string, unknown> = { days: minDays }
      if (budgetDropped.length > 0) {
        conds['budget_cny'] = Math.min(...budgetDropped.map(c => c.cost.moneyCny))
      }
      if (opt.bestMonths?.length) conds['best_months'] = opt.bestMonths
      wish = { name: opt.label, conditions: conds, reason: i18nT('sg.wish_reason_window', { days: windowDays, minDays }) }
    }
    verdicts.push({
      candidate_id: opt.id, name: opt.label, feasible: false, imagery_match: opt.score ?? 0,
      unsat_core: blocked, suggestions, wish_pool: wish,
    })
  }

  const feasible = verdicts.filter(v => v.feasible).sort((a, b) => (b.imagery_match as number) - (a.imagery_match as number))
  return {
    verdicts,
    recommended: feasible.length > 0 ? feasible[0]['candidate_id'] : null,
    answer_md: renderCandidateMarkdown(req, verdicts, feasible.length > 0 ? String(feasible[0]['candidate_id']) : null),
  }
}

function renderCandidateMarkdown(req: TravelRequest, verdicts: Array<Record<string, unknown>>, recommended: string | null): string {
  const feasible = verdicts.filter(v => v['feasible']).sort((a, b) => (b['imagery_match'] as number) - (a['imagery_match'] as number))
  const parked = verdicts.filter(v => !v['feasible'])
  const lines: string[] = []
  lines.push(i18nT('md.header', { note: req.note }))
  lines.push(i18nT('md.constraints', {
    days: req.windowDays, budget: req.budgetCny,
    hours: requiredUsableHours(req.motivation).toFixed(1),
  }))
  lines.push('')
  for (const v of parked) {
    const core = (v['unsat_core'] as string[]) ?? []
    lines.push(i18nT('md.infeasible', { name: String(v['name']), core: core.join('、') }))
    const sug = ((v['suggestions'] as Array<Record<string, unknown>>) ?? [])[0]
    if (sug) lines.push(i18nT('md.relax_one', { relax: String(sug['relax']), money: String(sug['resulting_money_cny'] ?? '') }))
    const wish = v['wish_pool'] as Record<string, unknown> | null
    if (wish) {
      const conds = wish['conditions'] as Record<string, unknown>
      const budgetNote = conds['budget_cny'] ? i18nT('md.wish_budget', { cny: String(conds['budget_cny']) }) : ''
      const months = conds['best_months'] as number[] | undefined
      const season = months ? i18nT('md.wish_season', { months: String(months) }) : ''
      lines.push(i18nT('md.wish_pool', { days: String(conds['days']), budgetNote, season }))
    }
  }
  lines.push('')
  for (const v of feasible) {
    const ch = v['chosen'] as Record<string, unknown>
    const tc = v['true_cost'] as Record<string, unknown>
    lines.push(i18nT('md.feasible_unified', {
      name: String(v['name']), svc: String(ch['out_service']), mode: String(ch['out_transfer']),
      wake: String(tc['wake']), energy: String(tc['energy_arrival_pct']), d2d: String(tc['door_to_door_out']),
      hours: String(tc['usable_hours']), money: String(tc['money_cny']),
    }))
  }
  if (feasible.length) {
    lines.push('')
    const best = feasible[0]
    const alt = feasible[1]
    lines.push(i18nT('md.recommend', { best: String(best['name']), match: ((best['imagery_match'] as number) * 100).toFixed(0) })
      + (alt ? i18nT('md.alt', {
        name: String(alt['name']), money: String((alt['true_cost'] as Record<string, unknown>)['money_cny']),
        match: ((alt['imagery_match'] as number) * 100).toFixed(0),
      }) : ''))
  }
  lines.push('')
  lines.push(i18nT('md.decide_two'))
  if (feasible.length >= 2) {
    lines.push(i18nT('md.q_choice', { a: String(feasible[0]['name']), b: String(feasible[1]['name']) }))
  } else if (feasible.length === 1) {
    lines.push(i18nT('md.q_single', { name: String(feasible[0]['name']) }))
  } else {
    lines.push(i18nT('md.q_none'))
  }
  const p0 = parked[0]
  const p0wish = p0?.['wish_pool'] as Record<string, unknown> | null
  if (p0wish) {
    const conds = p0wish['conditions'] as Record<string, unknown>
    lines.push(i18nT('md.q_wish', { name: String(p0!['name']), days: String(conds['days']) }))
  } else if (feasible.length) {
    const ch = feasible[0]['chosen'] as Record<string, unknown>
    lines.push(i18nT('md.q_depart', { id: String(ch['out_service']), dep: '' }))
  }
  return lines.join('\n')
}

export { minToHhmm }
