/**
 * Per-agent, per-turn wall-clock boundary driven by routing (ADR-24 v2).
 *
 * 职责只有一件:保证每一轮终结在三态之一——当面答完(converge)、转后台
 * 并给出回访承诺(handoff)、或明确暂停。绝不允许第四态:流死掉、什么
 * 都没交付(2026-09-02 轨迹的失败形态)。
 *
 * - 阈值不再固定:每次 user/message 由 `turn-policy.ts` 的确定性分类器
 *   解析 TurnPolicy(softMs/hardMs/exit);benchmark opt-in 用 fixedPolicy
 *   钉死以保证可复现。
 * - 硬阈拒绝时**同步**抑制工具 schema(防同 step 回环),并按 exit 语义
 *   返回两种结构化结果:converge=用已有证据作答;handoff=落
 *   `gotry_turn_handoff.v1` 工单并指令模型告知用户 ETA 与回访方式。
 * - handoff 工单是**新的独立格式**,落在 `<stateRoot>/gotry-state/
 *   turn-handoffs/`,不与 `async/` 的 loop 求解工单混用——async-collect
 *   对无 spec 的 state 会立即结算 failed(假失败)。产品通过原生 jobs
 *   启动独立收集器;仅落单不代表后台已开始。
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
// 类型面显式依赖:session/event、session/disposed 的事件表声明在 dsh-session 的
// cordis Events augmentation 里——不显式导入时,该声明只在 peer 恰好物化进
// ts/node_modules 的机器上可见(legacy-peer-deps 安装则缺,5 个 TS2345/TS7006)。
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolExecutionResult, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { classifyTurn, TURN_HANDOFF_ETA_LABEL, turnPolicyFor, type TurnPolicy } from './turn-policy.ts'

export const TURN_DEADLINE_SOFT = 'TURN_DEADLINE_SOFT'
export const TURN_DEADLINE_EXHAUSTED = 'TURN_DEADLINE_EXHAUSTED'
export const TURN_DEADLINE_HANDOFF = 'TURN_DEADLINE_HANDOFF'
export const TURN_DEADLINE_STALE_DELIVERABLE = 'TURN_DEADLINE_STALE_DELIVERABLE'
export const TURN_HANDOFF_SCHEMA = 'gotry_turn_handoff.v1' as const

export interface TurnHandoffTicket {
  schema: typeof TURN_HANDOFF_SCHEMA
  id: string
  objective: string
  userMessage: string
  requestedAt: string
  etaLabel: string
  status: 'open' | 'running' | 'settled' | 'failed'
  jobId?: string
  workspaceCwd?: string
  ownerSessionId?: string
  context?: string
  /** 结算时间(ISO);open 时缺省。 */
  settledAt?: string
  /** 结算交付物文件名(与工单同目录的 .deliverable.md)。 */
  deliverableFile?: string
  /** failed 时的稳定错误描述。 */
  error?: string
}

/** 复访视图:工单事实 + 已结算交付物摘录(有界)。 */
export interface TurnHandoffTicketView {
  id: string
  status: TurnHandoffTicket['status']
  objective: string
  requestedAt: string
  etaLabel: string
  jobId?: string
  deliverablePath?: string
  settledAt?: string
  error?: string
  deliverableExcerpt?: string
}

export interface TurnDeadlineOptions {
  /** When false the install call returns immediately with zero side effects. */
  enabled?: boolean
  /** Benchmark pin: routing is bypassed, every turn gets this exact policy. */
  fixedPolicy?: TurnPolicy
  /** Product: handoff ticket target root. Handoff degrades to converge when absent. */
  stateRoot?: string
  /** Wall-clock source — overridden by tests for determinism. */
  now?: () => number
  /** Product host owns dispatch and native job tracking. Absent means queued. */
  startHandoff?: (ticket: TurnHandoffTicket, agent: Agent, stateRoot: string) => Promise<TurnHandoffTicket>
}

function handoffContext(events: readonly SessionEvent[]): string | undefined {
  const questionIds = new Set(events.filter(event => event.type === 'tool/call' && event.data.name === 'ask_user_question')
    .map(event => event.type === 'tool/call' ? event.data.callId : ''))
  // Human constraints are lossless. Refuse dispatch if they exceed the input
  // budget; silently cutting an accessibility/budget answer changes the task.
  const answers = events.filter(event => (event.type === 'user/message' && event.data.source.kind === 'user')
    || (event.type === 'tool/call' && questionIds.has(event.data.callId))
    || (event.type === 'tool/result' && event.data.message.source.kind === 'tool' && questionIds.has(event.data.message.source.callId)))
    .map(event => JSON.stringify(event.data)).join('\n')
  if (answers.length > 64_000) throw new Error('Prior user answers exceed the handoff context limit; planning paused without dropping constraints. Start a new session with the complete trip constraints.')
  let remaining = 18_000
  const evidence: string[] = []
  for (const event of [...events].reverse()) {
    if (event.type !== 'tool/result' || (event.data.message.source.kind === 'tool' && questionIds.has(event.data.message.source.callId))) continue
    const row = JSON.stringify(event.data)
    // Evidence may be excerpted, with an explicit marker and valid JSON.
    const excerpt = row.length > remaining
      ? JSON.stringify({ truncated: true, excerpt: row.slice(-Math.floor(remaining / 2)) }) : row
    if (excerpt.length + 1 > remaining) break
    evidence.unshift(excerpt)
    remaining -= excerpt.length + 1
    if (remaining < 100) break
  }
  return answers || evidence.length ? `${answers}\n${evidence.join('\n')}` : undefined
}

export async function writeTurnHandoffTicket(stateRoot: string, userMessage: string, details: Pick<TurnHandoffTicket, 'workspaceCwd' | 'ownerSessionId' | 'context'> = {}): Promise<TurnHandoffTicket> {
  const ticket: TurnHandoffTicket = {
    schema: TURN_HANDOFF_SCHEMA,
    id: `th-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
    objective: userMessage.length > 120 ? `${userMessage.slice(0, 120)}…` : userMessage,
    userMessage,
    requestedAt: new Date().toISOString(),
    etaLabel: TURN_HANDOFF_ETA_LABEL,
    status: 'open',
    ...details,
  }
  await writeTicketJson(stateRoot, ticket)
  return ticket
}

function handoffDir(stateRoot: string): string {
  const root = stateRoot === '.' ? process.cwd() : stateRoot
  return join(root, 'gotry-state', 'turn-handoffs')
}

export async function writeTicketJson(stateRoot: string, ticket: TurnHandoffTicket): Promise<string> {
  const dir = handoffDir(stateRoot)
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${ticket.id}.json`)
  const tmp = `${path}.tmp`
  await writeFile(tmp, JSON.stringify(ticket, null, 2), 'utf-8')
  await rename(tmp, path)
  return path
}

/**
 * 结算工单:交付物落 `<id>.deliverable.md`(settled=规划产物;failed=诚实
 * 失败说明),工单 json 原子更新 status/settledAt/deliverableFile/error。
 */
export async function settleTurnHandoffTicket(
  stateRoot: string,
  ticket: TurnHandoffTicket,
  status: 'settled' | 'failed',
  deliverable: string,
  error?: string,
): Promise<{ ticketPath: string; deliverablePath: string }> {
  const dir = handoffDir(stateRoot)
  await mkdir(dir, { recursive: true })
  const deliverablePath = join(dir, `${ticket.id}.deliverable.md`)
  const deliverableTmp = `${deliverablePath}.tmp`
  await writeFile(deliverableTmp, deliverable, 'utf-8')
  await rename(deliverableTmp, deliverablePath)
  const settled: TurnHandoffTicket = {
    ...ticket,
    status,
    settledAt: new Date().toISOString(),
    deliverableFile: `${ticket.id}.deliverable.md`,
    ...(error ? { error } : {}),
  }
  const ticketPath = await writeTicketJson(stateRoot, settled)
  return { ticketPath, deliverablePath }
}

/** 复访查询:按请求时间倒序列出工单;settled 附交付物摘录(≤600 字)。 */
export async function listTurnHandoffTickets(stateRoot: string): Promise<TurnHandoffTicketView[]> {
  const dir = handoffDir(stateRoot)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const views: TurnHandoffTicketView[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const raw = JSON.parse(await readFile(join(dir, name), 'utf-8')) as TurnHandoffTicket
      if (raw?.schema !== TURN_HANDOFF_SCHEMA) continue
      const view: TurnHandoffTicketView = {
        id: raw.id,
        status: raw.status,
        objective: raw.objective,
        requestedAt: raw.requestedAt,
        etaLabel: raw.etaLabel,
        ...(raw.jobId ? { jobId: raw.jobId } : {}),
        ...(raw.settledAt ? { settledAt: raw.settledAt } : {}),
        ...(raw.error ? { error: raw.error } : {}),
      }
      if ((raw.status === 'settled' || raw.status === 'failed') && raw.deliverableFile === `${raw.id}.deliverable.md`) {
        try {
          const text = await readFile(join(dir, raw.deliverableFile), 'utf-8')
          view.deliverablePath = resolve(dir, raw.deliverableFile)
          view.deliverableExcerpt = text.length > 600 ? `${text.slice(0, 600)}…` : text
        } catch { /* 交付物缺失时视图降级,不阻塞列表 */ }
      }
      views.push(view)
    } catch { /* 单个坏工单不阻塞列表 */ }
  }
  views.sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1))
  return views
}

function resolveEnvPin(name: string): number | null {
  const raw = process.env[name]
  if (!raw) return null
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function convergenceContext(code: string, text: string) {
  return {
    id: randomUUID(),
    role: 'user' as const,
    content: [{ type: 'text' as const, text: `${code}: ${text}` }],
    // 0.2.0-rc.2(V4 会话格式)移除 'plugin' source kind;运行时自产注入归 system-prompt。
    source: { kind: 'system-prompt' as const },
  }
}

// Final-only mode keeps one write: saving the answer artifact converges, it
// does not research. Every other write stays refused and is tracked.
function finalWriteNote(left: boolean): string {
  return left
    ? 'One write is still allowed in this turn, to save the answer artifact; any further write is refused.'
    : 'The one write allowed after the deadline has been used; any further write is refused.'
}

function exhaustionResult(reason: string, finalWriteLeft: boolean): ToolExecutionResult {
  return {
    isError: true,
    error: {
      message: reason,
      info: { name: 'TurnDeadlineError', code: TURN_DEADLINE_EXHAUSTED },
    },
    content: [{ type: 'text', text: reason }],
    additionalContexts: [convergenceContext(
      TURN_DEADLINE_EXHAUSTED,
      `No more research tools are permitted in this turn. Produce the final answer from existing results. ${finalWriteNote(finalWriteLeft)} Never claim a file was created or updated when its tool call failed or was refused.`,
    ) as never],
  }
}

function handoffResult(ticket: TurnHandoffTicket, finalWriteLeft: boolean): ToolExecutionResult {
  const state = ticket.status === 'running' && ticket.jobId
    ? `Background planning started as native background job ${ticket.jobId} (estimated ${ticket.etaLabel}; not a guarantee). Track or cancel with job_list/job_output/job_kill.`
    : ticket.status === 'failed'
      ? `Background planning could not start: ${ticket.error ?? 'unknown failure'}. Tell the user it failed; do not promise later delivery.`
      : 'The ticket is queued; the background worker has not started. Tell the user it is pending, not running; do not promise a completion time.'
  const instruction = `Async ticket ${ticket.id} persisted. ${state} Stop research and answer from existing results. ${finalWriteNote(finalWriteLeft)} Never claim a file was created or updated when its tool call failed or was refused. For any successfully written output, call present with its exact existing path before the final response. Mention ticket ${ticket.id}.`
  return {
    isError: true,
    error: {
      message: `${TURN_DEADLINE_HANDOFF}: sync window exhausted for a deep-planning turn; ticket ${ticket.id}`,
      info: { name: 'TurnDeadlineHandoff', code: TURN_DEADLINE_HANDOFF },
    },
    content: [{ type: 'text', text: `${TURN_DEADLINE_HANDOFF}: ${instruction}` }],
    additionalContexts: [convergenceContext(TURN_DEADLINE_HANDOFF, instruction) as never],
  }
}

/** Name the file a refused write or edit left untouched, ahead of the guidance. */
function refusedChange(result: ToolExecutionResult, path: string): ToolExecutionResult {
  return { ...result, content: [{ type: 'text', text: `Refused: ${path} was not written or updated in this turn.` }, ...result.content] }
}

type NotUpdated = 'refused' | 'failed'

/**
 * Present after a refused update would publish the earlier file as this turn's
 * deliverable (turn 8 of the rc.33 field session presented turn-7 files as
 * rewritten). Refuse it and name each file with the version actually on disk.
 */
async function staleDeliveryResult(files: Array<{ path: string; target: string; reason: NotUpdated }>): Promise<ToolExecutionResult> {
  const lines = await Promise.all(files.map(async file => {
    const why = `its write ${file.reason === 'refused' ? 'was refused' : 'failed'} after the turn deadline`
    const modified = await stat(file.target).then(info => info.mtime.toISOString(), () => undefined)
    return modified
      ? `${file.path} was not updated in this turn: ${why}; the file on disk is the earlier version, last modified ${modified}.`
      : `${file.path} was not written in this turn: ${why}, and no file exists at that path.`
  }))
  const text = `${TURN_DEADLINE_STALE_DELIVERABLE}: Not presented. ${lines.join(' ')} Tell the user these files were not written or updated, and never describe them as rewritten. Present any other file in a separate call.`
  return {
    isError: true,
    error: { message: text, info: { name: 'TurnDeadlineStaleDeliverable', code: TURN_DEADLINE_STALE_DELIVERABLE } },
    content: [{ type: 'text', text }],
  }
}

/** The file a write or edit targets, resolved like the fs tools against the session cwd. */
function changedFile(name: string, args: unknown, cwd: string): { path: string; target: string } | undefined {
  if (name !== 'write' && name !== 'edit') return undefined
  const path = (args as { file_path?: unknown } | undefined)?.file_path
  return typeof path === 'string' && path.trim() ? { path, target: resolve(cwd, path) } : undefined
}

function presentedPaths(args: unknown): string[] {
  const files = (args as { files?: unknown } | undefined)?.files
  if (!Array.isArray(files)) return []
  return files.map(file => (file as { path?: unknown } | null)?.path)
    .filter((path): path is string => typeof path === 'string' && path.trim().length > 0)
}

type RestrictableTools = {
  schemas?: () => Array<{ name: string }>
  restrict?: (filter: { deny: string[] }) => () => void
}

type AgentTurnState = {
  startedAt: number
  policy: TurnPolicy
  userMessage?: string
  handoff?: Promise<TurnHandoffTicket>
  /** Closed waits on the user inside this budget: the user's time, not the turn's. */
  waitedMs: number
  /** The hard deadline has refused or exempted a call: final-only mode. */
  closed?: boolean
  finalWriteUsed?: boolean
}

/** Per-turn facts that survive a budget reset by a new user message. */
type TurnFacts = {
  /** Open waits on the user (approval ids, question tokens), and since when. */
  waits: Set<unknown>
  waitingSince: number
  /** Approval id → call id while the decision is pending. */
  asked: Map<string, string | undefined>
  /** Calls the user approved; each still runs once past the deadline. */
  approved: Set<string>
  /** Resolved paths whose update the deadline refused, or whose final write failed. */
  notUpdated: Map<string, NotUpdated>
}

/**
 * Install the runtime boundary, kept separate from the GoTry tool catalog so
 * the actual Cordis waterfalls can be exercised without booting every tool.
 */
export function installTurnDeadline(ctx: Context, options: TurnDeadlineOptions = {}): void {
  if (options.enabled === false) return

  // Some offline contract tests intentionally provide a registration-only
  // Context slice. They do not drive an agent loop, so there is no boundary
  // to install and no reason to require an event bus.
  if (typeof (ctx as unknown as { on?: unknown }).on !== 'function') return

  const now = options.now ?? (() => Date.now())
  // Test/benchmark seam only: pin the resolved numbers without touching the
  // routed exit strategy. Product runs never set these.
  const softPin = resolveEnvPin('GOTRY_TURN_DEADLINE_SOFT_MS')
  const hardPin = resolveEnvPin('GOTRY_TURN_DEADLINE_HARD_MS')

  const defaultPolicy = options.fixedPolicy ?? turnPolicyFor('sync-planning')
  const routePolicy = (message: string): TurnPolicy => {
    if (options.fixedPolicy) return { ...options.fixedPolicy }
    const policy = turnPolicyFor(classifyTurn(message))
    return { ...policy, softMs: softPin ?? policy.softMs, hardMs: hardPin ?? policy.hardMs }
  }

  const pinnedPolicy = (): TurnPolicy => ({ ...defaultPolicy, softMs: softPin ?? defaultPolicy.softMs, hardMs: hardPin ?? defaultPolicy.hardMs })
  const stateByAgent = new Map<string, AgentTurnState>()
  const factsByAgent = new Map<string, TurnFacts>()
  const softExecutions = new Map<ToolExecutionToken, { agentId: string; exit: string }>()
  const guidedExecutions = new Map<ToolExecutionToken, { agentId: string; contexts: NonNullable<ToolExecutionResult['additionalContexts']> }>()
  const finalOnlyDisposers = new Map<string, () => void>()

  const clearAgent = (agentId: string) => {
    stateByAgent.delete(agentId)
    factsByAgent.delete(agentId)
    for (const [token, owner] of softExecutions) {
      if (owner.agentId === agentId) softExecutions.delete(token)
    }
    for (const [token, owner] of guidedExecutions) {
      if (owner.agentId === agentId) guidedExecutions.delete(token)
    }
    finalOnlyDisposers.get(agentId)?.()
    finalOnlyDisposers.delete(agentId)
  }

  const factsOf = (agentId: string): TurnFacts => {
    let facts = factsByAgent.get(agentId)
    if (!facts) {
      facts = { waits: new Set(), waitingSince: 0, asked: new Map(), approved: new Set(), notUpdated: new Map() }
      factsByAgent.set(agentId, facts)
    }
    return facts
  }

  // Waiting on the user is the user's time, not the turn's: the budget pauses
  // while any wait is open, and overlapping waits pause it once.
  const beginWait = (agentId: string, key: unknown) => {
    const facts = factsOf(agentId)
    if (facts.waits.size === 0) facts.waitingSince = now()
    facts.waits.add(key)
  }
  const endWait = (agentId: string, key: unknown) => {
    const facts = factsByAgent.get(agentId)
    if (!facts?.waits.delete(key) || facts.waits.size > 0) return
    const state = stateByAgent.get(agentId)
    if (state) state.waitedMs += now() - Math.max(facts.waitingSince, state.startedAt)
  }
  const elapsedOf = (agentId: string, state: AgentTurnState) => {
    const facts = factsByAgent.get(agentId)
    const open = facts && facts.waits.size > 0 ? now() - Math.max(facts.waitingSince, state.startedAt) : 0
    return now() - state.startedAt - state.waitedMs - open
  }

  const enterFinalOnly = (agent: Agent) => {
    const agentId = String(agent.id)
    if (finalOnlyDisposers.has(agentId)) return
    const globalTools = ctx.tools as unknown as RestrictableTools
    const scopedTools = agent.ctx?.tools as unknown as RestrictableTools | undefined
    if (typeof globalTools.schemas !== 'function' || typeof scopedTools?.restrict !== 'function') {
      // No registry to suppress: subsequent tool calls in the same turn hit the
      // same per-call denial branch and stay refused until the next turn.
      return
    }
    // write stays visible for the one final write; later writes hit the guard.
    const inheritedNames = globalTools.schemas()
      .map(schema => schema.name)
      .filter(name => name !== 'run_code' && name !== 'present' && name !== 'write')
    if (inheritedNames.length === 0) return
    finalOnlyDisposers.set(agentId, scopedTools.restrict({ deny: inheritedNames }))
  }

  // 事件主体是 session 对象;agent 归属同一 session 时共用同一预算键。
  const keyOfAgent = (agent: Agent) => {
    const session = (agent as unknown as { session?: { id?: unknown } }).session
    return String(session?.id ?? agent.id)
  }

  ctx.on('session/event', (subject, event) => {
    const agentId = String(subject.id)
    if (event.type === 'turn/end') {
      clearAgent(agentId)
      return
    }
    if (event.type === 'turn/start') {
      finalOnlyDisposers.get(agentId)?.()
      finalOnlyDisposers.delete(agentId)
      if (!stateByAgent.has(agentId)) stateByAgent.set(agentId, { startedAt: now(), policy: pinnedPolicy(), waitedMs: 0 })
      return
    }
    if (event.type === 'user/message') {
      // dsh 事件载荷在 event.data 下(benchmark-agent-conformance 同型读法)。
      const message = (event as {
        data?: { source?: { kind?: string }; content?: ReadonlyArray<{ type?: string; text?: string }> }
      }).data
      if (message?.source?.kind !== 'user') return
      const text = (message.content ?? []).find(block => block.type === 'text')?.text ?? ''
      if (!text.trim()) return
      // 每个 user 消息 = 新的预算:路由分类 + 时钟重置。plugin/skill 注入
      // 的 user/message(source.kind !== 'user')不参与路由。
      stateByAgent.set(agentId, { startedAt: now(), policy: routePolicy(text), userMessage: text, waitedMs: 0 })
      return
    }
    // DSH awaits approvals in tools/pre-execute (ToolRuntime.prepareExecution →
    // ApprovalService.request), before the tools/execute gate below measures the
    // call; the asked/decided audit pair brackets the user's decision.
    const type: string = event.type
    if (type !== 'approval/asked' && type !== 'approval/decided') return
    const data = (event as { data?: { id?: unknown; callId?: unknown; outcome?: unknown } }).data
    if (typeof data?.id !== 'string') return
    const facts = factsOf(agentId)
    if (type === 'approval/asked') {
      facts.asked.set(data.id, typeof data.callId === 'string' ? data.callId : undefined)
      beginWait(agentId, data.id)
      return
    }
    const callId = facts.asked.get(data.id)
    facts.asked.delete(data.id)
    if (data.outcome === 'allowed-once' && callId !== undefined) facts.approved.add(callId)
    endWait(agentId, data.id)
  })
  ctx.on('session/disposed', subject => clearAgent(String(subject.id)))

  ctx.on('tools/execute', (exec, next) => {
    // Programmatic/direct calls are not part of a model planner turn.
    if (!exec.agent) return next()
    const agentId = keyOfAgent(exec.agent)
    const state = stateByAgent.get(agentId) ?? { startedAt: now(), policy: pinnedPolicy(), waitedMs: 0 }
    stateByAgent.set(agentId, state)
    const facts = factsOf(agentId)
    const cwd = exec.agent.session?.header.cwd ?? process.cwd()

    // Present validates files on disk and publishes native deliverable events;
    // it must remain callable after the research window closes, except for a
    // file whose update this turn did not happen: it would read as rewritten.
    if (exec.name === 'present') {
      const stale = presentedPaths(exec.arguments).flatMap(path => {
        const target = resolve(cwd, path)
        const reason = facts.notUpdated.get(target)
        return reason ? [{ path, target, reason }] : []
      })
      return stale.length > 0 ? staleDeliveryResult(stale) : next()
    }

    const change = changedFile(exec.name, exec.arguments, cwd)
    // The user decided on this exact call; the deadline never discards that.
    const callId = exec.callId as string | undefined
    const approved = callId !== undefined && facts.approved.delete(callId)
    const elapsed = elapsedOf(agentId, state)
    if (elapsed > state.policy.hardMs) {
      // Final-only: present, the call the user approved, and one write.
      const exempt = approved || (exec.name === 'write' && !state.finalWriteUsed)
      if (exempt && exec.name === 'write') state.finalWriteUsed = true
      const finalWriteLeft = !state.finalWriteUsed
      const crossing = !state.closed
      state.closed = true
      if (change && !exempt) facts.notUpdated.set(change.target, 'refused')
      const ran = exempt
        ? Promise.resolve().then(() => next()).then(result => {
          if (change) {
            if (result.isError) facts.notUpdated.set(change.target, 'failed')
            else facts.notUpdated.delete(change.target)
          }
          return result
        }, error => {
          if (change) facts.notUpdated.set(change.target, 'failed')
          throw error
        })
        : undefined
      let guidance: Promise<ToolExecutionResult>
      let degraded: string
      if (state.policy.exit === 'handoff' && state.userMessage && options.stateRoot) {
        const root = options.stateRoot === '.'
          ? (exec.agent.session?.header.cwd ?? process.cwd()) : resolve(options.stateRoot)
        if (!state.handoff) {
          const session = exec.agent.session
          // Reserve the handoff before executing the exempt body. Parallel or
          // repeated calls see the same promise and cannot write/dispatch twice.
          state.handoff = (async () => {
            try { await ran } finally { enterFinalOnly(exec.agent!) }
            let context: string | undefined
            let contextError: string | undefined
            try { context = handoffContext(session?.snapshotEvents() ?? []) }
            catch (error) { contextError = error instanceof Error ? error.message : 'handoff context unavailable' }
            const ticket = await writeTurnHandoffTicket(root, state.userMessage!, {
              workspaceCwd: session?.header.cwd,
              ownerSessionId: session ? String(session.id) : undefined,
              context,
            })
            if (contextError) {
              await settleTurnHandoffTicket(root, ticket, 'failed', `# Planning paused\n\n${contextError}`, contextError)
              return { ...ticket, status: 'failed', error: contextError }
            }
            return options.startHandoff ? options.startHandoff(ticket, exec.agent!, root) : ticket
          })()
        }
        // Attach a rejection handler now even if the exempt tool itself rejects.
        guidance = state.handoff.then(ticket => handoffResult(ticket, finalWriteLeft),
          () => exhaustionResult(`${TURN_DEADLINE_EXHAUSTED}: ticket persistence failed; no background worker was started`, finalWriteLeft))
        degraded = `${TURN_DEADLINE_EXHAUSTED}: hard deadline ${state.policy.hardMs}ms reached (ticket persistence failed; degraded to converge)`
      } else {
        // Suppress inherited research schemas on refusal, or once an exempt
        // body has run; DSH's scoped schemas remain visible but hit this guard.
        const close = () => enterFinalOnly(exec.agent!)
        if (ran) void ran.then(close, close)
        else close()
        degraded = `${TURN_DEADLINE_EXHAUSTED}: turn exceeded hard deadline of ${state.policy.hardMs}ms (elapsed ${elapsed}ms); provide a final answer using existing results`
        guidance = Promise.resolve(exhaustionResult(degraded, finalWriteLeft))
      }
      return (async () => {
        if (!ran) {
          const refusal = await guidance
          return change ? refusedChange(refusal, change.path) : refusal
        }
        // An exempt call keeps the registry's canonical result object.
        // Rebuilding it after restricting inherited schemas would make DSH
        // re-resolve a tool that has just been hidden and report UNKNOWN_TOOL.
        // The call that closed the turn carries the guidance via post-execute.
        const output = await ran
        const contexts = (await guidance).additionalContexts ?? []
        if (crossing) guidedExecutions.set(exec.token, { agentId, contexts })
        return output
      })().catch(() => exhaustionResult(degraded, finalWriteLeft))
    }
    if (elapsed > state.policy.softMs) {
      softExecutions.set(exec.token, { agentId, exit: state.policy.exit })
    }
    // A successful write clears an earlier refusal for the same file.
    if (change && facts.notUpdated.has(change.target)) {
      return next().then(result => {
        if (!result.isError) facts.notUpdated.delete(change.target)
        return result
      })
    }
    return next()
  })

  ctx.on('tools/post-execute', (exec, _result, next) => {
    return next().then(decision => {
      const owner = softExecutions.get(exec.token)
      const guided = guidedExecutions.get(exec.token)
      guidedExecutions.delete(exec.token)
      if (!owner && !guided) return decision
      softExecutions.delete(exec.token)
      const text = owner?.exit === 'handoff'
        ? 'Turn has crossed the soft deadline of a deep-planning turn. Wrap up context gathering now; the turn will hand off to background planning at the hard deadline.'
        : 'Turn has crossed the soft deadline. Stop dispatching new tools and produce the final answer from gathered evidence.'
      return {
        ...decision,
        additionalContexts: [
          ...(decision.additionalContexts ?? []),
          ...(guided?.contexts ?? []),
          ...(owner ? [convergenceContext(TURN_DEADLINE_SOFT, text) as never] : []),
        ],
      }
    })
  })
}
