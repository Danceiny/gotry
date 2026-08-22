/**
 * Stage 1 对话循环(S2 段1,docs/stage1-top-down-design.md §2.3)。
 *
 * 自顶向下:循环只依赖两个端口——LlmPort(mock/真)与确定性工具(interview_next)。
 * 求解/渲染接线是 S2 后续段;本段验收:重放用户开场白,系统一轮内完成
 * 日历断言 + 访谈补全启动(问出工作窗口与已订资源——Kimi 第 6 轮才问的事)。
 */

import type { InterviewQuestion, TripState, TravelerProfile, Turn, CalendarState, SolveResult } from './contracts.ts'
import type { JourneySpecTS } from './unified.ts'

/** LLM 端口:S2 mock(确定性剧本) / S4 真(dsh 运行时)。循环不感知差异。 */
export interface LlmPort {
  /** 从对话抽取事实:日历(年/星期)与 profile 字段,带 evidence */
  extractFacts(history: Turn[], state: TripState): Promise<{
    calendar?: Partial<CalendarState>
    profile?: Partial<TravelerProfile>
    assumptions: Array<{ field: string; source: 'user-verbatim' | 'inferred' | 'default' }>
  }>
  /** 翻译:对话历史 → 统一模型 spec;约束未齐时返回 null(循环继续访谈) */
  extractSpec(history: Turn[], state: TripState): Promise<JourneySpecTS | null>
  /** 问句润色(ADR-9:确定性驱动,LLM 只管语气) */
  polishQuestion(q: InterviewQuestion): Promise<string>
  /** 结果解释(S3 接 solve 后启用) */
  render?(state: TripState): Promise<string>
}

export function newState(year = 2026): TripState {
  return {
    calendar: { year, assertedWeekdays: {} },
    profile: {},
    gates: [],
    wishes: [],
  }
}

/** ADR-9:访谈由缺失字段驱动(确定性,无 LLM 即兴) */
export function interviewNext(state: TripState): { questions: InterviewQuestion[]; missing: string[] } {
  const p = state.profile
  const questions: InterviewQuestion[] = []
  if (!p.workWindow) {
    questions.push({
      key: 'workWindow',
      text: '你这两周要远程办公——工作时间是几点到几点、按哪个时区?这决定每天的可玩时段。',
      why: '工作窗口直接决定每日节奏(普吉 13:00-22:00 与 9:00-18:00 是两种人生)',
    })
  }
  if (!p.bookedResources) {
    questions.push({
      key: 'bookedResources',
      text: '已经有订好的航班或酒店吗?(哪怕只是意向)——已订资源是硬锚点,先告诉我再规划。',
      why: '已订资源决定哪些段不可动,Kimi 式规划会绕开它们重排',
    })
  }
  if (!p.budgetTier) {
    questions.push({
      key: 'budgetTier',
      text: '预算档位:经济(¥12.6k 级)/ 舒适(¥16.3k 级)/ 便利优先?',
      why: '分层预算决定班次与住宿的选型口径',
      options: [
        { label: '经济', tradeOff: '省钱,接驳多走路' },
        { label: '舒适', tradeOff: 'workation 办公质量优先' },
        { label: '便利优先', tradeOff: '时间最省' },
      ],
    })
  }
  return { questions, missing: questions.map(q => q.key) }
}

/** spec 校验闸:LLM 翻译产物进求解器前的确定性形状检查(责任边界的执行点)。 */
export function validateSpec(spec: JourneySpecTS): string | null {
  if (!Array.isArray(spec.segments) || spec.segments.length === 0) return '没有段(segments)'
  for (const seg of spec.segments) {
    if (!seg.id) return '存在缺少 id 的段'
    if (!Array.isArray(seg.options) || seg.options.length === 0) return `段 ${seg.id} 没有可选方案`
    for (const opt of seg.options) {
      const svcs = opt.move?.services
      if (!Array.isArray(svcs) || svcs.length === 0) return `段 ${seg.id} 的方案 ${opt.id} 缺少班次(services)`
      for (const s of svcs) {
        if (typeof s.depMin !== 'number' || typeof s.arrMin !== 'number') {
          return `段 ${seg.id}/${opt.id} 的班次 ${s.id ?? '?'} 缺少时刻(depMin/arrMin)`
        }
      }
    }
  }
  return null
}

/** 求解端口:S3 起由 unified 求解器实现;循环只认此签名(确定性责任)。 */
export type SolvePort = (spec: JourneySpecTS) => Promise<SolveResult>

// ---- 异步深度规划(S5 架构段,ADR-8:编排架构先于智能) ----------------------------
// 产品形态:复杂规划 → 「我后台做,约一小时后回来看看」→ 回访时交付
// 已验证方案 + 选择题。不失望四条是交付物的自检契约。

export interface AsyncTicket {
  id: string
  objective: string
  requestedAt: string
  /** 剧本/mock 期用分钟级;真实化(S5 后半段)由 loopx tick 驱动 */
  etaLabel: string
}

export function isComplex(state: TripState): boolean {
  /** 复杂度判据(架构占位,后续可细化):多段或多约束即深规划 */
  const p = state.profile
  return Boolean(p.workWindow && p.bookedResources) && (state.gates.length > 0 || Boolean(state.spec))
}

export async function requestDeepPlanning(state: TripState): Promise<{ reply: string; ticket: AsyncTicket }> {
  const ticket: AsyncTicket = {
    id: `dp-${Date.now().toString(36)}`,
    objective: '生成已验证的行程方案:全成本核算 + 动机/约束匹配 + 不失望四条',
    requestedAt: new Date().toISOString(),
    etaLabel: '约 1 小时(mock 期:秒级)',
  }
  state.gates.push({ id: `async-${ticket.id}`, question: `深度规划已启动(${ticket.etaLabel})`, options: [] })
  const reply = '这趟行程跨度大(两周 workation + 三城 + 红眼返程),我切到**深度规划模式**:后台做多轮校验'
    + '(锚点/工作窗口/全成本/负例排查),做好后通知你。**先留一道选择题给你**,回来直接定:'
    + '\n1. 预算档位?(经济/舒适/便利优先)'
  return { reply, ticket }
}

export async function collectDeepPlanning(
  state: TripState,
  ticket: AsyncTicket,
  solve: SolvePort,
): Promise<{ reply: string; state: TripState }> {
  const spec = state.spec
  if (!spec) return { reply: '(内部状态缺失 spec——深度规划未就绪,这是不应发生的路径)', state }
  state.solve = await solve(spec)
  state.gates = state.gates.filter(g => !g.id.startsWith('async-'))

  // 不失望四条自检(交付物自带,总纲 3.6)
  const checks = {
    '1_承诺时间后必有明确产物': Boolean(state.solve.legs?.length || state.solve.verdicts?.length),
    '2_产物通过自检清单': state.solve.feasible ? (state.solve.legs?.every(l => (l as Record<string, unknown>)['energy_pct'] !== undefined) ?? false) : Boolean(state.solve.unsat_core?.length),
    '3_待决问题全部是简单选择题': state.gates.every(g => g.id === 'budget' || g.options.length >= 2),
    '4_做不到的诚实说': state.solve.feasible || Boolean(state.solve.suggestions?.length),
  }
  const head = `# 回访交付:${ticket.objective}\n(工单 ${ticket.id},不失望四条:${Object.values(checks).every(Boolean) ? '4/4 ✅' : '有未达项 ❌'})`
  return { reply: `${head}\n\n${renderSolve(state)}`, state }
}

/** 求解结果 → 人话(模板;S4 可由 LLM 润色,数字与判定不可改) */
export function renderSolve(state: TripState): string {
  const s = state.solve
  if (!s) return '(无求解结果)'
  const lines: string[] = []
  if (s.feasible) {
    lines.push(`**方案可行,机票合计 ¥${s.money_cny}**`)
    for (const lg of s.legs ?? []) {
      const l = lg as Record<string, string | number>
      lines.push(`- ${l['leg']} ${l['service']}:${l['dep']} 起飞,${l['wake']} 出发,${l['arrive_stay']} 到,`
        + `门到门 ${l['door_to_door']},落地精力 ${l['energy_pct']}%,¥${l['price_cny']}`)
    }
    for (const e of s.work_window_exclusions ?? []) {
      lines.push(`- 已排除 ${e.option}(工作窗口):${e.reason}`)
    }
    for (const n of s.skeleton_notes ?? []) lines.push(`- ${n}`)
    for (const f of s.red_flags ?? []) lines.push(`- ⚠️ ${f}`)
  } else {
    lines.push(`**当前约束下不可行——冲突:${(s.unsat_core ?? []).join('、')}`)
    for (const sg of s.suggestions ?? []) lines.push(`- 放宽「${sg.relax}」可解(约 ¥${sg.money_cny})`)
  }
  if (state.gates.length) {
    lines.push('', '**待你决定(选择题)**')
    for (const g of state.gates) {
      lines.push(`- ${g.question} → ${g.options.map(o => o.label + (o.tradeOff ? `(${o.tradeOff})` : '')).join(' / ')}`)
    }
  }
  return lines.join('\n')
}

/** 一次对话回合:抽取事实(冲突即指出)→ 增量访谈 → 约束齐备则求解+渲染。 */
export async function runTurn(
  state: TripState,
  userMsg: string,
  llm: LlmPort,
  history: Turn[] = [],
  solve: SolvePort | null = null,
): Promise<{ reply: string; state: TripState }> {
  const facts = await llm.extractFacts([...history, { role: 'user', text: userMsg }], state)

  const conflicts: string[] = []
  if (facts.calendar?.assertedWeekdays) {
    for (const [date, wd] of Object.entries(facts.calendar.assertedWeekdays)) {
      const prev = state.calendar.assertedWeekdays[date]
      if (prev && prev !== wd) {
        conflicts.push(`${date}:已有断言 ${prev},新说法 ${wd}——以先断言为准,如需改请明确说`)
      } else {
        state.calendar.assertedWeekdays[date] = wd
      }
    }
  }
  Object.assign(state.profile, facts.profile ?? {})

  // 访谈:workWindow/bookedResources 是求解前置;budgetTier 转为 gate(不阻塞规划)
  const { questions } = interviewNext(state)
  const blocking = questions.filter(q => q.key !== 'budgetTier')
  const budgetQ = questions.find(q => q.key === 'budgetTier')
  if (budgetQ && !state.gates.some(g => g.id === 'budget')) {
    state.gates.push({
      id: 'budget',
      question: budgetQ.text,
      options: budgetQ.options ?? [{ label: '经济' }, { label: '舒适' }, { label: '便利优先' }],
    })
  }

  const parts: string[] = []
  if (conflicts.length) parts.push(`⚠️ 日历冲突:\n${conflicts.map(c => `- ${c}`).join('\n')}`)
  for (const q of blocking) parts.push(await llm.polishQuestion(q))

  // 约束齐备(无阻塞问题)→ 翻译 spec → **校验闸** → 求解 → 渲染
  if (blocking.length === 0 && solve) {
    const spec = await llm.extractSpec([...history, { role: 'user', text: userMsg }], state)
    const invalid = spec ? validateSpec(spec) : '翻译器未产出 spec'
    if (spec && !invalid) {
      state.spec = spec
      state.solve = await solve(spec)
      parts.push(llm.render ? await llm.render(state) : renderSolve(state))
    } else if (blocking.length === 0 && invalid) {
      parts.push(`(行程骨架还不完整:${invalid}——请补充对应信息,我不猜)`)
    }
  } else if (blocking.length === 0) {
    parts.push('(约束齐备——进入规划,S3 接线后此处产出方案与选择题)')
  }
  return { reply: parts.join('\n\n'), state }
}

// ---- 异步工单持久化(S5 编排半段):真正的「一小时后」必须跨进程存续 ----
// 请求时落盘(ticket+state 快照);任意后续进程(如 loopx 驱动的 tick)执行
// async-collect 加载、求解、写回交付物。状态目录属用户数据(红线 6)。

import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { readFile, writeFile } from 'node:fs/promises'

const ASYNC_DIR = 'gotry-state/async'

async function asyncPath(name: string): Promise<string> {
  await mkdir(ASYNC_DIR, { recursive: true })
  return join(ASYNC_DIR, name)
}

export async function persistAsyncTicket(ticket: AsyncTicket, state: TripState): Promise<string> {
  const p = await asyncPath(`${ticket.id}.json`)
  await writeFile(p, JSON.stringify({ ticket, state }, null, 2), 'utf-8')
  return p
}

export async function loadAsyncTicket(ticketId: string): Promise<{ ticket: AsyncTicket; state: TripState } | null> {
  try {
    const p = await asyncPath(`${ticketId}.json`)
    return JSON.parse(await readFile(p, 'utf-8')) as { ticket: AsyncTicket; state: TripState }
  } catch {
    return null
  }
}

export async function settleAsyncTicket(ticketId: string, reply: string): Promise<string> {
  const p = await asyncPath(`${ticketId}.deliverable.md`)
  await writeFile(p, reply, 'utf-8')
  return p
}
