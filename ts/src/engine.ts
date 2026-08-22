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

import { init } from 'z3-solver'
import type { Candidate, Choice, TrueCost, TravelRequest } from './model.ts'
import { evaluateChoice, minToHhmm, requiredUsableHours, trueCostToDict, LATEST_ARRIVE_STAY_MIN } from './model.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Z3Ctx = any

let z3Promise: Promise<Z3Ctx> | null = null

async function getZ3(): Promise<Z3Ctx> {
  if (!z3Promise) {
    z3Promise = (async () => (await init()).Context('main'))()
  }
  return z3Promise
}

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

async function cheapestPlan(enc: Encoding, skip: ReadonlySet<string>): Promise<{ choice: Choice; cost: TrueCost } | null> {
  /** 放宽 skip 约束下的最省钱方案:getLower 取最优值,等值回代提模(与 Python _cheapest_plan 同)。 */
  const z3 = await getZ3()
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
  if (relax.includes('duration')) parts.push(`把行程延长到 ${choice.days} 天(${cand.name} 值得这个窗口)`)
  if (relax.includes('budget')) parts.push(`预算提高到 ¥${cost.moneyCny}(原 ¥${req.budgetCny})`)
  if (relax.includes('wake_floor')) parts.push(`接受 ${minToHhmm(cost.wakeMin)} 起床——破坏生物钟,与你的休整动机冲突,不推荐`)
  if (relax.includes('energy_floor')) parts.push(`接受到达精力 ${cost.energyArrivalPct}%(低于你要求的 ${mot.minArrivalEnergyPct}%)`)
  if (relax.includes('usable_hours')) parts.push(`接受有效休整 ${cost.usableHours.toFixed(1)}h(低于动机所需的 ${requiredUsableHours(mot).toFixed(1)}h)`)
  if (relax.includes('arrival_before_evening')) parts.push(`接受 ${minToHhmm(cost.arriveStayMin)} 才到住处`)
  const plan = `可行方案:${choice.outService.id} ${minToHhmm(choice.outService.depMin)} 出发、`
    + `${choice.outTransfer.mode} 接驳,¥${cost.moneyCny},${minToHhmm(cost.wakeMin)} 起床,`
    + `${minToHhmm(cost.arriveStayMin)} 到住处,到达精力 ${cost.energyArrivalPct}%`
  return parts.join(' + ') + `;${plan}`
}

export async function solveCandidate(cand: Candidate, req: TravelRequest): Promise<Verdict> {
  const z3 = await getZ3()
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
      const plan = await cheapestPlan(longEnc, new Set(joint))
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
    const plan = await cheapestPlan(longEnc, new Set(['duration', 'budget']))
    const conditions: Record<string, unknown> = { days: cand.minDaysForPurpose }
    if (plan) conditions['budget_cny'] = plan.cost.moneyCny
    if (cand.bestMonths.length) conditions['best_months'] = cand.bestMonths
    verdict.wishPool = {
      name: cand.name,
      conditions,
      reason: `动机谱系 ${JSON.stringify(req.motivation.weights)} 下,${req.windowDays} 天窗口装不下这个目的地`,
    }
  }
  return verdict
}

export async function solve(req: TravelRequest, candidates: Candidate[]): Promise<Record<string, unknown>> {
  const verdicts = await Promise.all(candidates.map(c => solveCandidate(c, req)))
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
  lines.push(`> 憧憬:${req.note}`)
  lines.push(`> 已识别约束:窗口 ${req.windowDays} 天 | 预算 ¥${req.budgetCny} | `
    + `动机(休整改写需求 ${requiredUsableHours(req.motivation).toFixed(1)}h 有效休整)`)
  lines.push('')
  for (const v of parked) {
    lines.push(`**${v.name}:现在不行**——冲突约束:${v.unsatCore.join('、')}。`)
    for (const sg of v.suggestions.slice(0, 1)) lines.push(`- ${sg.text}`)
    if (v.wishPool) {
      const conds = v.wishPool.conditions
      const budgetNote = conds['budget_cny'] ? `、约 ¥${conds['budget_cny']}` : ''
      const months = conds['best_months'] as number[] | undefined
      const season = months ? `,${months} 月最佳` : ''
      lines.push(`- 已放入「下一次出发」清单:需要 ${conds['days']} 天${budgetNote}${season}`)
    }
  }
  lines.push('')
  for (const v of feasible) {
    const c = v.choice!, t = v.trueCost!
    lines.push(`**${v.name}:可行**`
      + `(${c.outService.id} ${minToHhmm(c.outService.depMin)} 出发,`
      + `${c.outTransfer.mode} 接驳,${minToHhmm(t.arriveStayMin)} 到住处,`
      + `起床 ${minToHhmm(t.wakeMin)},到达精力 ${t.energyArrivalPct}%,`
      + `门到门 ${Math.floor(t.doorToDoorOutMin / 60)}h${String(t.doorToDoorOutMin % 60).padStart(2, '0')}m,`
      + `有效休整 ${t.usableHours.toFixed(1)}h,共 ¥${t.moneyCny})`)
  }
  if (feasible.length) {
    lines.push('')
    const best = feasible[0]
    const alt = feasible[1]
    lines.push(`**建议:${best.name}**(意象匹配 ${(best.imageryMatch * 100).toFixed(0)}%)。`
      + (alt ? `备选:${alt.name}(¥${alt.trueCost!.moneyCny},匹配 ${(alt.imageryMatch * 100).toFixed(0)}%)。` : ''))
  }
  lines.push('')
  lines.push('**待你决定的两个问题**:')
  if (feasible.length >= 2) {
    lines.push(`1. ${feasible[0].name} 还是 ${feasible[1].name}?(前者更贴意象,后者更省)`)
  } else if (feasible.length === 1) {
    lines.push(`1. 就去 ${feasible[0].name} 吗?`)
  } else {
    lines.push('1. 所有候选都不可行——考虑放宽哪条约束?')
  }
  const p0 = parked[0]
  if (p0?.wishPool) {
    lines.push(`2. 把 ${p0.name} 留给「下一次出发」(${p0.wishPool.conditions['days']} 天起),这次先去可行的?`)
  } else if (feasible.length) {
    lines.push(`2. 出发班次选 ${feasible[0].choice!.outService.id}(${minToHhmm(feasible[0].choice!.outService.depMin)})还是更晚的?`)
  }
  return lines.join('\n')
}

// Python CLI 输出形状的类型(桥接回退时用)
export interface EngineResult extends Record<string, unknown> {
  recommended: string | null
  answer_md: string
}
