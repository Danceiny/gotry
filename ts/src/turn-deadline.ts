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
 *   对无 spec 的 state 会立即结算 failed(假失败),收集器是未来的
 *   agent tick(loopx),不是 async-collect。
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecutionResult, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { classifyTurn, TURN_HANDOFF_ETA_LABEL, turnPolicyFor, type TurnPolicy } from './turn-policy.ts'

export const TURN_DEADLINE_SOFT = 'TURN_DEADLINE_SOFT'
export const TURN_DEADLINE_EXHAUSTED = 'TURN_DEADLINE_EXHAUSTED'
export const TURN_DEADLINE_HANDOFF = 'TURN_DEADLINE_HANDOFF'
export const TURN_HANDOFF_SCHEMA = 'gotry_turn_handoff.v1' as const

export interface TurnHandoffTicket {
  schema: typeof TURN_HANDOFF_SCHEMA
  id: string
  objective: string
  userMessage: string
  requestedAt: string
  etaLabel: string
  status: 'open' | 'settled' | 'failed'
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
}

export async function writeTurnHandoffTicket(stateRoot: string, userMessage: string): Promise<TurnHandoffTicket> {
  const ticket: TurnHandoffTicket = {
    schema: TURN_HANDOFF_SCHEMA,
    id: `th-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
    objective: userMessage.length > 120 ? `${userMessage.slice(0, 120)}…` : userMessage,
    userMessage,
    requestedAt: new Date().toISOString(),
    etaLabel: TURN_HANDOFF_ETA_LABEL,
    status: 'open',
  }
  await writeTicketJson(stateRoot, ticket)
  return ticket
}

function handoffDir(stateRoot: string): string {
  const root = stateRoot === '.' ? process.cwd() : stateRoot
  return join(root, 'gotry-state', 'turn-handoffs')
}

async function writeTicketJson(stateRoot: string, ticket: TurnHandoffTicket): Promise<string> {
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
        ...(raw.settledAt ? { settledAt: raw.settledAt } : {}),
        ...(raw.error ? { error: raw.error } : {}),
      }
      if (raw.status !== 'open' && raw.deliverableFile) {
        try {
          const text = await readFile(join(dir, raw.deliverableFile), 'utf-8')
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
    source: { kind: 'plugin' as const, plugin: 'gotry-turn-deadline' },
  }
}

function exhaustionResult(reason: string): ToolExecutionResult {
  return {
    isError: true,
    error: {
      message: reason,
      info: { name: 'TurnDeadlineError', code: TURN_DEADLINE_EXHAUSTED },
    },
    content: [{ type: 'text', text: reason }],
    additionalContexts: [convergenceContext(
      TURN_DEADLINE_EXHAUSTED,
      'No more tool dispatches are permitted in this turn. Produce the final answer from existing results.',
    ) as never],
  }
}

function handoffResult(ticket: TurnHandoffTicket): ToolExecutionResult {
  const instruction = `Turn handed off to background planning. Async ticket ${ticket.id} created (ETA ${ticket.etaLabel}). Stop dispatching tools and tell the user in one short message: the deep planning continues in the background, the expected time, and to check back later (mention ticket ${ticket.id}).`
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

type RestrictableTools = {
  schemas?: () => Array<{ name: string }>
  restrict?: (filter: { deny: string[] }) => () => void
}

type AgentTurnState = {
  startedAt: number
  policy: TurnPolicy
  userMessage?: string
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

  const stateByAgent = new Map<string, AgentTurnState>()
  const softExecutions = new Map<ToolExecutionToken, { agentId: string; exit: string }>()
  const finalOnlyDisposers = new Map<string, () => void>()

  const clearAgent = (agentId: string) => {
    stateByAgent.delete(agentId)
    for (const [token, owner] of softExecutions) {
      if (owner.agentId === agentId) softExecutions.delete(token)
    }
    finalOnlyDisposers.get(agentId)?.()
    finalOnlyDisposers.delete(agentId)
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
    const inheritedNames = globalTools.schemas()
      .map(schema => schema.name)
      .filter(name => name !== 'run_code')
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
      if (!stateByAgent.has(agentId)) {
        stateByAgent.set(agentId, {
          startedAt: now(),
          policy: { ...defaultPolicy, softMs: softPin ?? defaultPolicy.softMs, hardMs: hardPin ?? defaultPolicy.hardMs },
        })
      }
      return
    }
    if (event.type === 'user/message') {
      // dsh 事件载荷在 event.data 下(benchmark-agent-conformance 同型读法)。
      const message = (event as {
        data?: { source?: { kind?: string }; content?: Array<{ type?: string; text?: string }> }
      }).data
      if (message?.source?.kind !== 'user') return
      const text = (message.content ?? []).find(block => block.type === 'text')?.text ?? ''
      if (!text.trim()) return
      // 每个 user 消息 = 新的预算:路由分类 + 时钟重置。plugin/skill 注入
      // 的 user/message(source.kind !== 'user')不参与路由。
      stateByAgent.set(agentId, { startedAt: now(), policy: routePolicy(text), userMessage: text })
    }
  })
  ctx.on('session/disposed', subject => clearAgent(String(subject.id)))

  ctx.on('tools/execute', (exec, next) => {
    // Programmatic/direct calls are not part of a model planner turn.
    if (!exec.agent) return next()
    const agentId = keyOfAgent(exec.agent)
    const state = stateByAgent.get(agentId)
      ?? { startedAt: now(), policy: { ...defaultPolicy, softMs: softPin ?? defaultPolicy.softMs, hardMs: hardPin ?? defaultPolicy.hardMs } }
    stateByAgent.set(agentId, state)

    const elapsed = now() - state.startedAt
    if (elapsed > state.policy.hardMs) {
      // Synchronous schema suppression so same-step follow-up calls cannot
      // loop on refusal results (the 2026-09-02 trajectory failure).
      enterFinalOnly(exec.agent)
      if (state.policy.exit === 'handoff' && state.userMessage && options.stateRoot) {
        return writeTurnHandoffTicket(options.stateRoot, state.userMessage)
          .then(ticket => handoffResult(ticket))
          .catch(() => exhaustionResult(
            `${TURN_DEADLINE_EXHAUSTED}: hard deadline ${state.policy.hardMs}ms reached (ticket persistence failed; degraded to converge)`,
          ))
      }
      return Promise.resolve(exhaustionResult(
        `${TURN_DEADLINE_EXHAUSTED}: turn exceeded hard deadline of ${state.policy.hardMs}ms (elapsed ${elapsed}ms); provide a final answer using existing results`,
      ))
    }
    if (elapsed > state.policy.softMs) {
      softExecutions.set(exec.token, { agentId, exit: state.policy.exit })
    }
    return next()
  })

  ctx.on('tools/post-execute', (exec, _result, next) => {
    return next().then(decision => {
      const owner = softExecutions.get(exec.token)
      if (!owner) return decision
      softExecutions.delete(exec.token)
      const text = owner.exit === 'handoff'
        ? 'Turn has crossed the soft deadline of a deep-planning turn. Wrap up context gathering now; the turn will hand off to background planning at the hard deadline.'
        : 'Turn has crossed the soft deadline. Stop dispatching new tools and produce the final answer from gathered evidence.'
      return {
        ...decision,
        additionalContexts: [
          ...(decision.additionalContexts ?? []),
          convergenceContext(TURN_DEADLINE_SOFT, text) as never,
        ],
      }
    })
  })
}
