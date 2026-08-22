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

/** 求解端口:S3 起由 unified 求解器实现;循环只认此签名(确定性责任)。 */
export type SolvePort = (spec: JourneySpecTS) => Promise<SolveResult>

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

  // 约束齐备(无阻塞问题)→ 翻译 spec → 求解 → 渲染
  if (blocking.length === 0 && solve) {
    const spec = await llm.extractSpec([...history, { role: 'user', text: userMsg }], state)
    if (spec) {
      state.spec = spec
      state.solve = await solve(spec)
      parts.push(llm.render ? await llm.render(state) : renderSolve(state))
    }
  } else if (blocking.length === 0) {
    parts.push('(约束齐备——进入规划,S3 接线后此处产出方案与选择题)')
  }
  return { reply: parts.join('\n\n'), state }
}
