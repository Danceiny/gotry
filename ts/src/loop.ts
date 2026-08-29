/**
 * Stage 1 对话循环(S2 段1,docs/stage1-top-down-design.md §2.3)。
 *
 * 自顶向下:循环只依赖两个端口——LlmPort(mock/真)与确定性工具(interview_next)。
 * 求解/渲染接线是 S2 后续段;本段验收:重放用户开场白,系统一轮内完成
 * 日历断言 + 访谈补全启动(问出工作窗口与已订资源——Kimi 第 6 轮才问的事)。
 */

import type { InterviewQuestion, TripState, TravelerProfile, Turn, CalendarState, SolveResult } from './contracts.ts'
import type { JourneySpecTS } from './unified.ts'
import type { TravelSlotExtraction } from './travel-slots.ts'
import { anythingSearch } from '../capabilities/anything.ts'

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
  /**
   * 槽位抽取(travel_slot_extraction.v1):差旅 intake 面。时间表达逐字保留,
   * 过期判定在确定性层(flagExpiredSlots),实现方负责注入时间锚点卡。
   * now 可注入(评测用固定锚点保证确定性;生产省略取系统时钟)。
   */
  extractSlots(history: Turn[], now?: Date): Promise<TravelSlotExtraction | null>
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
  const ww = p.workWindow as unknown as { vacation?: boolean } | undefined
  if (!p.workWindow && !ww?.vacation) {
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

export const ASYNC_TERMINAL_SCHEMA = 'gotry_async_terminal.v1' as const

export interface AsyncTerminalOutcome {
  schema: typeof ASYNC_TERMINAL_SCHEMA
  ticket_id: string
  status: 'succeeded' | 'failed'
  passed: number
  total: 4
  checks: Record<string, boolean>
  failed_checks: string[]
}

function asyncTerminalOutcome(ticketId: string, checks: Record<string, boolean>): AsyncTerminalOutcome {
  const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name)
  return {
    schema: ASYNC_TERMINAL_SCHEMA,
    ticket_id: ticketId,
    status: failedChecks.length === 0 ? 'succeeded' : 'failed',
    passed: Object.values(checks).filter(Boolean).length,
    total: 4,
    checks,
    failed_checks: failedChecks,
  }
}

function terminalOutcomeFromState(ticketId: string, state: TripState): AsyncTerminalOutcome {
  if (!state.spec || !state.solve) {
    return asyncTerminalOutcome(ticketId, {
      '1_承诺时间后必有明确产物': false,
      '2_产物通过自检清单': false,
      '3_待决问题全部是简单选择题': false,
      '4_做不到的诚实说': false,
    })
  }

  return asyncTerminalOutcome(ticketId, {
    '1_承诺时间后必有明确产物': Boolean(state.solve.legs?.length || state.solve.verdicts?.length),
    '2_产物通过自检清单': state.solve.feasible
      ? (state.solve.legs?.every(l => (l as Record<string, unknown>)['energy_pct'] !== undefined) ?? false)
      : Boolean(state.solve.unsat_core?.length),
    '3_待决问题全部是简单选择题': state.gates.every(g => g.id === 'budget' || g.options.length >= 2),
    '4_做不到的诚实说': state.solve.feasible || Boolean(state.solve.suggestions?.length),
  })
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
): Promise<{ reply: string; state: TripState; outcome: AsyncTerminalOutcome }> {
  const spec = state.spec
  if (!spec) {
    const outcome = terminalOutcomeFromState(ticket.id, state)
    return { reply: '(内部状态缺失 spec——深度规划未就绪,这是不应发生的路径)', state, outcome }
  }
  state.solve = await solve(spec)
  state.gates = state.gates.filter(g => !g.id.startsWith('async-'))

  // 不失望四条自检(交付物自带,总纲 3.6)
  const outcome = terminalOutcomeFromState(ticket.id, state)
  const head = `# 回访交付:${ticket.objective}\n(工单 ${ticket.id},不失望四条:${outcome.status === 'succeeded' ? '4/4 ✅' : '有未达项 ❌'})`
  return { reply: `${head}\n\n${renderSolve(state)}`, state, outcome }
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

  // D-7a 例外: blocking>0 时,用户消息含"查+地名/酒店/天气"信号时,直接调 anything_search
  // 走 PoI 真相(datasources 层主动调,不动 polling 状态机,不改求解器)
  const poiProbe = probePoi(userMsg)
  if (poiProbe) {
    const ar = await anythingSearch({ keyword: poiProbe })
    if (ar.verdict === 'hit' && ar.hits && ar.hits.length > 0) {
      const top = ar.hits.slice(0, 5)
      const lines = top.map((h, i) => {
        const latlng = h.latitude !== undefined && h.longitude !== undefined
          ? ` @ (${h.latitude.toFixed(3)},${h.longitude.toFixed(3)})`
          : ''
        return `  ${i + 1}. [${h.type}] ${h.name}${latlng}`
      }).join('\n')
      parts.push(`**${poiProbe} → hit (${ar.hits.length} 候选项)**\n${lines}\n${ar.evidence}`)
    } else if (ar.verdict === 'miss') {
      parts.push(`**${poiProbe} → miss** (酒店-be Anything 一切正常但无候选)\n${ar.evidence}`)
    } else {
      parts.push(`**${poiProbe} → unavailable** (${ar.error ?? 'hbcli 不可达'})\n${ar.evidence}`)
    }
  }

  for (const q of blocking) parts.push(await llm.polishQuestion(q))

  // 约束齐备(无阻塞问题)→ 翻译 spec → **校验闸 + 日期一致性闸** → 求解 → 渲染
  if (blocking.length === 0 && solve) {
    const spec = await llm.extractSpec([...history, { role: 'user', text: userMsg }], state)
    // 场景路由:erhai 候选标记 → 候选求解(洱海金标准的引擎判定)——纯 TS unify 路径
    if (spec && (spec as unknown as { note?: string }).note === 'erhai-candidates') {
      const { readFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      try {
        const raw = JSON.parse(await readFile(join(import.meta.dirname, '..', '..', 'data', 'golden_erhai.json'), 'utf-8'))
        const { parseCandidate, parseRequest } = await import('./model.ts')
        const { segmentsFromCandidate, solveChoiceSegment } = await import('./unified.ts')
        const req = parseRequest(raw['request'] as Record<string, unknown>)
        const cands = (raw['candidates'] as Record<string, unknown>[]).map(parseCandidate)
        const erhaiSpec = segmentsFromCandidate(req, cands)
        const result = solveChoiceSegment(erhaiSpec, req) as { answer_md?: string; recommended?: string }
        state.solve = result as never
        parts.push(result.answer_md ?? '(候选求解完成)')
      } catch {
        parts.push('(洱海候选求解暂不可用——退回访谈)')
      }
    } else {
      const invalid = spec ? validateSpec(spec) : '翻译器未产出 spec'
      if (spec && !invalid) {
        // D-10 切片 C:spec↔槽位日期一致性闸(ADR-10 翻译≠造数的执行点)。
        // LLM 翻译的 spec 日期与代码层换算的槽位日期分歧时不求解、不猜,追问确认——
        // 日期是求解关键输入,错日期 = 错判决。槽位缺失/unresolved 不参与(不造假阳性)。
        const ext = await llm.extractSlots([...history, { role: 'user', text: userMsg }])
        if (ext) {
          const { resolveSlots, specDateMismatches } = await import('./slot-spec.ts')
          const { buildTimeAnchor } = await import('./time-anchor.ts')
          const mismatches = specDateMismatches(spec, resolveSlots(ext, buildTimeAnchor()))
          if (mismatches.length > 0) {
            const lines = mismatches.map(m => `- ${m.specAt}:翻译说 ${m.specDate},你的原话换算是 ${m.slotDate}(${m.field})`)
            parts.push(`⚠️ 日期分歧,确认后我再算(以你为准):\n${lines.join('\n')}`)
            return { reply: parts.join('\n\n'), state }
          }
        }
        state.spec = spec
        state.solve = await solve(spec)
        parts.push(llm.render ? await llm.render(state) : renderSolve(state))
      } else if (blocking.length === 0 && invalid) {
        parts.push(`(行程骨架还不完整:${invalid}——请补充对应信息,我不猜)`)
      }
    }
  } else if (blocking.length === 0) {
    parts.push('(约束齐备——进入规划,S3 接线后此处产出方案与选择题)')
  }
  return { reply: parts.join('\n\n'), state }
}

// ---- 异步工单持久化(S5 编排半段 → ADR-15 durable 工单):真正的「一小时后」必须跨进程存续 ----
// 权威 = 账本 workflow_runs/workflow_steps(单事务;崩溃后 done 步骤不重执行);
// {id}.json / {id}.deliverable.md 降级为视图(AGENTS.md 清扫合同 + 人工检视),
// tmp+rename 原子写——此前裸 writeFile 的非原子缺口(RFC §1.1)就此关闭。

import { join } from 'node:path'
import { mkdir, rename, writeFile, readFile } from 'node:fs/promises'
import { ensureLedger, openLedgerIfExists, type StateLedger } from './state-ledger.ts'

async function asyncDir(stateRoot: string): Promise<string> {
  const root = stateRoot === '.' ? process.cwd() : stateRoot
  const dir = join(root, 'gotry-state', 'async')
  await mkdir(dir, { recursive: true })
  return dir
}

async function atomicWrite(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp`
  await writeFile(tmp, text, 'utf-8')
  await rename(tmp, path)
}

export async function persistAsyncTicket(ticket: AsyncTicket, state: TripState, stateRoot = '.'): Promise<string> {
  const ledger = ensureLedger(stateRoot)
  ledger.createWorkflowRun({ id: ticket.id, goal: ticket.objective, ticket, state })
  const dir = await asyncDir(stateRoot)
  const p = join(dir, `${ticket.id}.json`)
  await atomicWrite(p, JSON.stringify({ ticket, state }, null, 2))
  return p
}

export async function loadAsyncTicket(ticketId: string, stateRoot = '.'): Promise<{ ticket: AsyncTicket; state: TripState } | null> {
  // 账本优先;无账本的 root 回退旧 json 文件(只读,兼容存量已交付工单)
  const ledger = openLedgerIfExists(stateRoot)
  const run = ledger?.getWorkflowRun(ticketId)
  if (run) {
    return {
      ticket: JSON.parse(run.ticket_json) as AsyncTicket,
      state: JSON.parse(run.state_json) as TripState,
    }
  }
  try {
    const p = join(await asyncDir(stateRoot), `${ticketId}.json`)
    return JSON.parse(await readFile(p, 'utf-8')) as { ticket: AsyncTicket; state: TripState }
  } catch {
    return null
  }
}

export async function settleAsyncTicket(
  ticketId: string,
  reply: string,
  stateRoot = '.',
  outcome?: AsyncTerminalOutcome,
): Promise<string> {
  const ledger = openLedgerIfExists(stateRoot)
  const terminalOutcome = outcome ?? recoverAsyncTerminalOutcome(ledger, ticketId)
  if (ledger && !terminalOutcome) {
    throw new Error(`workflow ${ticketId} 缺少可恢复的 ${ASYNC_TERMINAL_SCHEMA}，拒绝误结算`)
  }
  if (terminalOutcome?.status === 'failed') ledger?.failWorkflowRun(ticketId, reply, terminalOutcome)
  else ledger?.settleWorkflowRun(ticketId, reply, terminalOutcome)
  const dir = await asyncDir(stateRoot)
  const p = join(dir, `${ticketId}.deliverable.md`)
  await atomicWrite(p, reply)
  return p
}

function recoverAsyncTerminalOutcome(ledger: StateLedger | null, ticketId: string): AsyncTerminalOutcome | undefined {
  if (!ledger) return undefined
  const run = ledger.getWorkflowRun(ticketId)
  if (!run) return undefined

  try {
    const state = JSON.parse(run.state_json) as TripState
    if (!state.spec) return terminalOutcomeFromState(ticketId, state)

    const solveStep = ledger.getWorkflowStep(ticketId, 'solve')
    if (solveStep?.status !== 'done' || !solveStep.result) return undefined
    state.solve = JSON.parse(solveStep.result) as SolveResult
    state.gates = state.gates.filter(g => !g.id.startsWith('async-'))
    return terminalOutcomeFromState(ticketId, state)
  } catch {
    return undefined
  }
}

/**
 * 可日志化 solve 端口(ADR-15 步骤日志,intent-before-execute):
 * 先记 intent 再执行,done 后结果落账本——任意进程恢复时 done 的步骤直接复用
 * 结果不重执行(exactly-once:LLM/求解调用不重复花钱),intent 悬挂的重试。
 */
export function makeJournaledSolvePort(ledger: StateLedger, runId: string, solve: SolvePort, opts?: { onRealSolve?: () => void }): SolvePort {
  return async spec => {
    const step = ledger.getWorkflowStep(runId, 'solve')
    if (step?.status === 'done' && step.result) {
      return JSON.parse(step.result) as Awaited<ReturnType<SolvePort>>
    }
    ledger.markStepIntent(runId, 'solve')
    opts?.onRealSolve?.()
    const r = await solve(spec)
    ledger.markStepDone(runId, 'solve', r)
    return r
  }
}

/**
 * probePoi:从 user msg 探测"查 POI/酒店" 信号,返回关键词。
 * 触发的不是关键词,是**结构**;关键词抓取有方向性——
 *  1) 显式搜索动词(查/搜/找/看看/推荐/告诉我/检索)+ 宾语在动词后;
 *  2) 住宿名词(酒店/民宿/客栈/饭店):优先取名词**之后**的名称段(须含拉丁/数字,
 *     「我订了酒店:The Title…」→ The Title…);退路是名词前 2-6 字紧邻地名
 *     (「大理酒店」→ 大理;「机票和」类垃圾后缀拒);
 *  3) 开放问(有什么/玩什么/有哪些):取名词前的地名;
 *  4) 短裸地名:≤12 字、无标点、无陈述动词(「大理」✓;「明天有空」「我的工作时间是…」✗——
 *     2026-08-28 巡检收紧:旧版 ≤24 直通把访谈答案整句当关键词,垃圾 hbcli 调用+证据噪音)。
 * 不是意图(改求解器),只是 datasources 编排层的"提早调 anything"提示。
 */
export function probePoi(msg: string): string | null {
  const trimmed = msg.trim()
  if (!trimmed) return null
  const cutAtPunct = (s: string): string => s.split(/[,，。.;；!！?？]/)[0]?.trim() ?? ''

  // 1) 显式搜索动词 + 宾语
  const m = trimmed.match(/(查一下|查|搜|找|看看|推荐|告诉我|检索)\s*(.{2,24})/)
  if (m?.[2]) {
    const obj = cutAtPunct(m[2])
    if (obj.length >= 2) return obj.slice(0, 24)
  }
  // 2) 住宿名词:名称段在名词后
  if (/(酒店|民宿|客栈|饭店)/.test(trimmed)) {
    const parts = trimmed.split(/(酒店|民宿|客栈|饭店)/)
    const after = cutAtPunct((parts[2] ?? '').replace(/^[的:：\s]+/, ''))
    if (after.length >= 2 && /[A-Za-z0-9]/.test(after)) return after.slice(0, 24)
    const nounAt = trimmed.search(/(酒店|民宿|客栈|饭店)/)
    const pre = trimmed.slice(Math.max(0, nounAt - 6), nounAt).match(/[一-龥]{2,6}$/)
    if (pre && !/(机票|车票|和|做|订|的)$/.test(pre[0])) return pre[0]
  }
  // 3) 开放问:地名在疑问词前
  const q = trimmed.match(/([一-龥a-zA-Z]{2,12})\s*(?:有什么|玩什么|有哪些)/)
  if (q?.[1]) return q[1]
  // 4) 短裸地名(≤12 字,无标点,无陈述动词)
  if (trimmed.length <= 12 && !/[,，。.;；!！?？:：]/.test(trimmed) && !/[是有在要想得到说订吧呢]/.test(trimmed)) {
    return trimmed.slice(0, 24)
  }
  return null
}
