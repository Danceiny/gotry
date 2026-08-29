/**
 * 可行性引擎 TS 版(与 py/gotry_feasibility/engine.py 对齐;Python 是对照实现/oracle)。
 * DEPRECATED(D-1 清偿):统一模型(unified.ts)是唯一求解入口;保留为兼容层与差分 oracle。
 *
 * Z3 走 npm z3-solver(WASM):
 * - API 为驼峰(addAndTrack/unsatCore/getLower),check/getLower 返回 Promise;
 * - exactly-one 用 Sum(If(sel,1,0)) == 1 表达(JS 绑定的 PbEq 有上下文强转问题);
 * - 有效时长约束整体放大 200 倍避免整除(与 Python 的 /200、/10 数学等价);
 * - WASM init ~60-140ms 一次性,单次求解 ~6ms(进程内,无子进程桥)。
 */

import { parseCandidate, parseRequest } from './model.ts'
import type { Candidate, Choice, TrueCost, TravelRequest } from './model.ts'
import { evaluateChoice, minToHhmm, requiredUsableHours, trueCostToDict, LATEST_ARRIVE_STAY_MIN } from './model.ts'
import { withZ3, type Z3Ctx } from './z3-shared.ts'
import { t } from './i18n.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
// Z3 运行时收敛到 z3-shared(单一 WASM 实例 + 单一 Context + 会话级互斥);
// 本模块不再自持 z3Promise(此前三模块并存 + solve() Promise.all 并发多候选
// 是「memory access out of bounds」偶发的根因,见 z3-shared.ts 头注)。

export interface Suggestion {
  relax: string[]
  text: string
  resulting: Record<string, unknown> | null
}

export interface WishPoolEntry {
  name: string
  conditions: Record<string, unknown>
  reason: string
}

export interface Verdict {
  candidateId: string
  name: string
  feasible: boolean
  imageryMatch: number
  choice?: Choice
  trueCost?: TrueCost
  unsatCore: string[]
  suggestions: Suggestion[]
  wishPool?: WishPoolEntry
}

const CONSTRAINT_LABEL_KEYS = [
  'wake_floor', 'energy_floor', 'usable_hours', 'budget',
  'duration', 'arrival_before_evening',
] as const

class Encoding {
  readonly days: number
  readonly cand: Candidate
  readonly req: TravelRequest
  readonly selO: any[]
  readonly selT: any[]
  readonly selR: any[]
  readonly selTr: any[]
  readonly structure: any
  readonly assertions: Record<string, any>
  readonly moneyExpr: any

  private readonly z3: any

  constructor(z3: any, cand: Candidate, req: TravelRequest, days?: number) {
    this.z3 = z3
    this.cand = cand
    this.req = req
    this.days = days ?? req.windowDays
    const { Bool, Int, If, Sum, And } = this.z3
    const mot = req.motivation

    this.selO = cand.servicesOut.map((_, i) => Bool.const(`o${i}`))
    this.selT = cand.destTransfers.map((_, j) => Bool.const(`t${j}`))
    this.selR = cand.servicesRet.map((_, k) => Bool.const(`r${k}`))
    this.selTr = cand.destTransfers.map((_, m) => Bool.const(`tr${m}`))

    const access = req.homeHubAccess[cand.hub]

    const pick = (sels: any[], values: number[]): any =>
      Sum(...sels.map((s, i) => If(s, Int.val(values[i]), Int.val(0))))

    const depOut = pick(this.selO, cand.servicesOut.map(s => s.depMin))
    const arrOut = pick(this.selO, cand.servicesOut.map(s => s.arrMin))
    const priceOut = pick(this.selO, cand.servicesOut.map(s => s.priceCny))
    const transferOut = pick(this.selT, cand.destTransfers.map(t => t.minutes))
    const transferOutPrice = pick(this.selT, cand.destTransfers.map(t => t.priceCny))
    const depRet = pick(this.selR, cand.servicesRet.map(s => s.depMin))
    const priceRet = pick(this.selR, cand.servicesRet.map(s => s.priceCny))
    const transferRet = pick(this.selTr, cand.destTransfers.map(t => t.minutes))
    const transferRetPrice = pick(this.selTr, cand.destTransfers.map(t => t.priceCny))

    const wake = depOut.sub(Int.val(cand.bufferOutMin + access.toHubMin))
    const arriveStay = arrOut.add(transferOut)
    const d2dOut = arriveStay.sub(wake)

    const wakePen = If(wake.lt(Int.val(300)), Int.val(30),
      If(wake.lt(Int.val(360)), Int.val(25),
        If(wake.lt(Int.val(390)), Int.val(15), Int.val(0))))
    const energy = Int.val(100)
      .sub(wakePen)
      .sub(Int.val(2 * 8))
      .sub(If(arriveStay.gt(Int.val(21 * 60)), Int.val(10), Int.val(0)))
      .sub(If(d2dOut.gt(Int.val(6 * 60)), Int.val(10), Int.val(0)))

    // 有效时长整体放大 200 倍(免整除,与 Python /200、/10 等价):
    // 200*usable = day1Raw*(100+energy) + 180*day2Raw + 86400*midDays
    const dayEnd = Int.val(LATEST_ARRIVE_STAY_MIN + 3 * 60)
    const day1Raw = If(arriveStay.lt(dayEnd), dayEnd.sub(arriveStay), Int.val(0))
    const leaveStayRet = depRet.sub(Int.val(cand.bufferRetMin)).sub(transferRet)
    const day2Raw = If(leaveStayRet.gt(Int.val(9 * 60)), leaveStayRet.sub(Int.val(9 * 60)), Int.val(0))
    const midDays = Math.max(0, this.days - 2)
    const usable200 = day1Raw.mul(energy.add(Int.val(100)))
      .add(day2Raw.mul(Int.val(180)))
      .add(Int.val(midDays * 86400))

    const money = priceOut.add(priceRet).add(transferOutPrice).add(transferRetPrice)
      .add(Int.val(cand.stayCnyPerNight * (this.days - 1) + cand.localDailyCny * this.days))

    const exactlyOne = (sels: any[]): any =>
      Sum(...sels.map(s => If(s, Int.val(1), Int.val(0)))).eq(Int.val(1))

    const requiredMin = Math.round(requiredUsableHours(mot) * 60)

    this.assertions = {
      wake_floor: wake.ge(Int.val(mot.wakeFloorMin)),
      energy_floor: energy.ge(Int.val(mot.minArrivalEnergyPct)),
      usable_hours: usable200.ge(Int.val(requiredMin * 200)),
      budget: money.le(Int.val(req.budgetCny)),
      duration: Bool.val(this.days >= cand.minDaysForPurpose),
      arrival_before_evening: arriveStay.le(Int.val(LATEST_ARRIVE_STAY_MIN)),
    }
    this.structure = And(
      exactlyOne(this.selO), exactlyOne(this.selT),
      exactlyOne(this.selR), exactlyOne(this.selTr),
    )
    this.moneyExpr = money
  }

  async solverWith(skip: ReadonlySet<string> = new Set()): Promise<any> {
    const s = new this.z3.Solver()
    s.add(this.structure)
    for (const name of CONSTRAINT_LABEL_KEYS) {
      if (!skip.has(name)) s.addAndTrack(this.assertions[name], name)
    }
    return s
  }

  async extract(model: any): Promise<Choice> {
    const chosen = async (sels: any[], items: any[]): Promise<any> => {
      for (let i = 0; i < sels.length; i++) {
        const v = await maybeAwait(model.eval(sels[i], true))
        if (String(v) === 'true' || String(String(v)) === 'true') return items[i]
      }
      throw new Error('no selection in model')
    }
    return {
      outService: await chosen(this.selO, this.cand.servicesOut),
      outTransfer: await chosen(this.selT, this.cand.destTransfers),
      retService: await chosen(this.selR, this.cand.servicesRet),
      retTransfer: await chosen(this.selTr, this.cand.destTransfers),
      days: this.days,
    }
  }
}

async function maybeAwait<T>(v: T | Promise<T>): Promise<T> {
  return v instanceof Promise ? await v : v
}

async function isUnsat(s: any): Promise<boolean> {
  return String(await s.check()) === 'unsat'
}

async function unsatCoreOf(s: any): Promise<string[]> {
  const v = s.unsatCore()
  const out: string[] = []
  for (let i = 0; i < v.length(); i++) out.push(String(v.get(i)))
  return out
}

async function cheapestPlan(enc: Encoding, skip: ReadonlySet<string>, z3: Z3Ctx): Promise<{ choice: Choice; cost: TrueCost } | null> {
  /** 放宽 skip 约束下的最省钱方案:getLower 取最优值,等值回代提模(与 Python _cheapest_plan 同)。 */
  const opt = new z3.Optimize()
  opt.add(enc.structure)
  for (const name of CONSTRAINT_LABEL_KEYS) {
    if (!skip.has(name)) opt.add(enc.assertions[name])
  }
  const obj = opt.minimize(enc.moneyExpr)
  if (await isUnsat(opt)) return null
  const best = Number(String(await maybeAwait(opt.getLower(obj))))
  const s = await enc.solverWith(skip)
  s.add(enc.moneyExpr.eq(z3.Int.val(best)))
  if (await isUnsat(s)) return null
  const choice = await enc.extract(s.model())
  return { choice, cost: evaluateChoice(enc.cand, enc.req, choice) }
}

function suggestText(relax: string[], cand: Candidate, req: TravelRequest, choice: Choice, cost: TrueCost): string {
  const mot = req.motivation
  const parts: string[] = []
  if (relax.includes('duration')) parts.push(t('sg.duration', { days: choice.days, name: cand.name }))
  if (relax.includes('budget')) parts.push(t('sg.budget', { cost: cost.moneyCny, budget: req.budgetCny }))
  if (relax.includes('wake_floor')) parts.push(t('sg.wake_floor', { wake: minToHhmm(cost.wakeMin) }))
  if (relax.includes('energy_floor')) parts.push(t('sg.energy_floor', { pct: cost.energyArrivalPct, min: mot.minArrivalEnergyPct }))
  if (relax.includes('usable_hours')) parts.push(t('sg.usable_hours', { hours: cost.usableHours.toFixed(1), need: requiredUsableHours(mot).toFixed(1) }))
  if (relax.includes('arrival_before_evening')) parts.push(t('sg.arrival', { time: minToHhmm(cost.arriveStayMin) }))
  const plan = t('sg.plan', {
    id: choice.outService.id, dep: minToHhmm(choice.outService.depMin), mode: choice.outTransfer.mode,
    money: cost.moneyCny, wake: minToHhmm(cost.wakeMin), arrive: minToHhmm(cost.arriveStayMin),
    percent: cost.energyArrivalPct,
  })
  return parts.join(' + ') + `;${plan}`
}

export async function solveCandidate(cand: Candidate, req: TravelRequest): Promise<Verdict> {
  // 会话级互斥门:整个判定(编码 + 多轮求解)独占共享实例;门内绝不嵌套 withZ3。
  return withZ3('engine.solveCandidate', async z3 => {
  const enc = new Encoding(z3, cand, req)
  const verdict: Verdict = {
    candidateId: cand.id, name: cand.name, feasible: false,
    imageryMatch: cand.imageryMatch, unsatCore: [], suggestions: [],
  }

  const s = await enc.solverWith()
  if (!(await isUnsat(s))) {
    verdict.feasible = true
    verdict.choice = await enc.extract(s.model())
    verdict.trueCost = evaluateChoice(cand, req, verdict.choice)
    return verdict
  }

  const core = (await unsatCoreOf(s)).sort()
  verdict.unsatCore = core

  // 单条放宽(days 仍是数据:放宽 duration 时换长窗口口径重新编码)
  for (const name of core) {
    const skip = new Set([name])
    const enc2 = name === 'duration' ? new Encoding(z3, cand, req, cand.minDaysForPurpose) : enc
    const s2 = await enc2.solverWith(skip)
    if (!(await isUnsat(s2))) {
      const choice = await enc2.extract(s2.model())
      const cost = evaluateChoice(cand, req, choice)
      verdict.suggestions.push({ relax: [name], text: suggestText([name], cand, req, choice, cost), resulting: { days: choice.days, ...trueCostToDict(cost) } })
    }
  }

  // 组合 core:放宽 duration 换长口径 → 取新口径 core 叠加 → 收缩
  if (core.includes('duration')) {
    const longEnc = new Encoding(z3, cand, req, cand.minDaysForPurpose)
    const s2 = await longEnc.solverWith(new Set(['duration']))
    if (await isUnsat(s2)) {
      const core2 = await unsatCoreOf(s2)
      let joint = ['duration', ...core2.filter(n => n !== 'duration')]
      for (const name of joint.filter(n => n !== 'duration')) {
        const trial = new Set(joint.filter(n => n !== name))
        if (!(await isUnsat(await longEnc.solverWith(trial)))) joint = [...trial]
      }
      const plan = await cheapestPlan(longEnc, new Set(joint), z3)
      if (plan) {
        verdict.suggestions.push({
          relax: joint,
          text: suggestText(joint, cand, req, plan.choice, plan.cost),
          resulting: { days: plan.choice.days, ...trueCostToDict(plan.cost) },
        })
      }
    }
  }

  // 憧憬不被拒绝:放宽时长能救活 → wish pool + 成行条件(最省钱口径)
  if (verdict.suggestions.some(sg => sg.relax.includes('duration'))) {
    const longEnc = new Encoding(z3, cand, req, cand.minDaysForPurpose)
    const plan = await cheapestPlan(longEnc, new Set(['duration', 'budget']), z3)
    const conditions: Record<string, unknown> = { days: cand.minDaysForPurpose }
    if (plan) conditions['budget_cny'] = plan.cost.moneyCny
    if (cand.bestMonths.length) conditions['best_months'] = cand.bestMonths
    verdict.wishPool = {
      name: cand.name,
      conditions,
      reason: t('sg.wish_reason_engine', { weights: JSON.stringify(req.motivation.weights), days: req.windowDays }),
    }
  }
  return verdict
  })
}

export async function solve(req: TravelRequest, candidates: Candidate[]): Promise<Record<string, unknown>> {
  // 顺序求解:候选间共享单一 WASM 实例,不并发交错(此前 Promise.all 是
  // 「memory access out of bounds」偶发的根因;求解 ~6ms/次,串行可忽略)。
  const verdicts: Verdict[] = []
  for (const c of candidates) verdicts.push(await solveCandidate(c, req))
  const feasible = verdicts.filter(v => v.feasible).sort((a, b) => b.imageryMatch - a.imageryMatch)
  const recommended = feasible[0]?.candidateId ?? null
  return {
    request: {
      note: req.note,
      window_days: req.windowDays,
      budget_cny: req.budgetCny,
      required_usable_hours: Math.round(requiredUsableHours(req.motivation) * 10) / 10,
    },
    verdicts: verdicts.map(verdictToDict),
    recommended,
    answer_md: renderMarkdown(req, verdicts, recommended),
  }
}

function verdictToDict(v: Verdict): Record<string, unknown> {
  const d: Record<string, unknown> = {
    candidate_id: v.candidateId,
    name: v.name,
    feasible: v.feasible,
    imagery_match: v.imageryMatch,
    unsat_core: v.unsatCore,
    suggestions: v.suggestions.map(s => ({ relax: s.relax, text: s.text, resulting: s.resulting })),
  }
  if (v.choice) {
    d['chosen'] = {
      out_service: v.choice.outService.id,
      out_transfer: v.choice.outTransfer.mode,
      ret_service: v.choice.retService.id,
      ret_transfer: v.choice.retTransfer.mode,
      days: v.choice.days,
    }
  }
  if (v.trueCost) d['true_cost'] = trueCostToDict(v.trueCost)
  if (v.wishPool) d['wish_pool'] = { name: v.wishPool.name, conditions: v.wishPool.conditions, reason: v.wishPool.reason }
  return d
}

function renderMarkdown(req: TravelRequest, verdicts: Verdict[], recommended: string | null): string {
  const feasible = verdicts.filter(v => v.feasible).sort((a, b) => b.imageryMatch - a.imageryMatch)
  const parked = verdicts.filter(v => !v.feasible)
  const lines: string[] = []
  lines.push(t('md.header', { note: req.note }))
  lines.push(t('md.constraints', {
    days: req.windowDays, budget: req.budgetCny,
    hours: requiredUsableHours(req.motivation).toFixed(1),
  }))
  lines.push('')
  for (const v of parked) {
    lines.push(t('md.infeasible', { name: v.name, core: v.unsatCore.join('、') }))
    for (const sg of v.suggestions.slice(0, 1)) lines.push(`- ${sg.text}`)
    if (v.wishPool) {
      const conds = v.wishPool.conditions
      const budgetNote = conds['budget_cny'] ? t('md.wish_budget', { cny: String(conds['budget_cny']) }) : ''
      const months = conds['best_months'] as number[] | undefined
      const season = months ? t('md.wish_season', { months: months.join(',') }) : ''
      lines.push(t('md.wish_pool', { days: String(conds['days']), budgetNote, season }))
    }
  }
  lines.push('')
  for (const v of feasible) {
    const c = v.choice!, cost = v.trueCost!
    lines.push(t('md.feasible_engine', {
      name: v.name, id: c.outService.id, dep: minToHhmm(c.outService.depMin), mode: c.outTransfer.mode,
      arrive: minToHhmm(cost.arriveStayMin), wake: minToHhmm(cost.wakeMin), energy: cost.energyArrivalPct,
      d2d: `${Math.floor(cost.doorToDoorOutMin / 60)}h${String(cost.doorToDoorOutMin % 60).padStart(2, '0')}m`,
      hours: cost.usableHours.toFixed(1), money: cost.moneyCny,
    }))
  }
  if (feasible.length) {
    lines.push('')
    const best = feasible[0]
    const alt = feasible[1]
    lines.push(t('md.recommend', { best: best.name, match: (best.imageryMatch * 100).toFixed(0) })
      + (alt ? t('md.alt', { name: alt.name, money: alt.trueCost!.moneyCny, match: (alt.imageryMatch * 100).toFixed(0) }) : ''))
  }
  lines.push('')
  lines.push(t('md.decide_two'))
  if (feasible.length >= 2) {
    lines.push(t('md.q_choice', { a: feasible[0].name, b: feasible[1].name }))
  } else if (feasible.length === 1) {
    lines.push(t('md.q_single', { name: feasible[0].name }))
  } else {
    lines.push(t('md.q_none'))
  }
  const p0 = parked[0]
  if (p0?.wishPool) {
    lines.push(t('md.q_wish', { name: p0.name, days: String(p0.wishPool.conditions['days']) }))
  } else if (feasible.length) {
    lines.push(t('md.q_depart', {
      id: feasible[0].choice!.outService.id, dep: minToHhmm(feasible[0].choice!.outService.depMin),
    }))
  }
  return lines.join('\n')
}

// Python CLI 输出形状的类型(桥接回退时用)
export interface EngineResult extends Record<string, unknown> {
  recommended: string | null
  answer_md: string
}
