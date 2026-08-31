/** Per-agent, per-turn guard for model-driven tool loops. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecutionResult, ToolExecutionToken } from '@deepseek-ai/dsh-tools'

export const TOOL_BUDGET_SOFT_CALL = 16
export const TOOL_BUDGET_HARD_CALL = 18
export const TOOL_BUDGET_EXHAUSTED = 'TOOL_BUDGET_EXHAUSTED'

export type ToolBudgetDecision =
  | { kind: 'allow'; softSignal: boolean; exhaustsBudget: boolean }
  | { kind: 'deny'; reason: string }

export function toolBudgetDecision(callNumber: number): ToolBudgetDecision {
  if (callNumber > TOOL_BUDGET_HARD_CALL) {
    return {
      kind: 'deny',
      reason: `${TOOL_BUDGET_EXHAUSTED}: maximum ${TOOL_BUDGET_HARD_CALL} real tool dispatches per agent turn reached; provide a final answer using existing results`,
    }
  }
  return {
    kind: 'allow',
    softSignal: callNumber === TOOL_BUDGET_SOFT_CALL,
    exhaustsBudget: callNumber === TOOL_BUDGET_HARD_CALL,
  }
}

export function createToolBudgetState(): {
  nextCall(): ToolBudgetDecision & { callNumber: number }
} {
  let calls = 0
  return {
    nextCall() {
      calls += 1
      return { ...toolBudgetDecision(calls), callNumber: calls }
    },
  }
}

function convergenceContext(code: 'TOOL_BUDGET_SOFT' | typeof TOOL_BUDGET_EXHAUSTED, text: string) {
  return {
    id: randomUUID(),
    role: 'user' as const,
    content: [{ type: 'text' as const, text: `${code}: ${text}` }],
    source: { kind: 'plugin' as const, plugin: 'gotry-tool-budget' },
  }
}

function exhaustionResult(reason: string): ToolExecutionResult {
  return {
    isError: true,
    error: {
      message: reason,
      info: { name: 'ToolBudgetError', code: TOOL_BUDGET_EXHAUSTED },
    },
    content: [{ type: 'text', text: reason }],
    additionalContexts: [convergenceContext(
      TOOL_BUDGET_EXHAUSTED,
      'No more tool dispatches are permitted in this turn. Produce the final answer from existing results.',
    ) as never],
  }
}

type RestrictableTools = {
  schemas?: () => Array<{ name: string }>
  restrict?: (filter: { deny: string[] }) => () => void
}

/**
 * Install the runtime boundary, kept separate from the GoTry tool catalog so
 * the actual Cordis waterfalls can be exercised without booting every tool.
 */
export function installToolBudget(ctx: Context): void {
  // Some offline contract tests intentionally provide a registration-only
  // Context slice. They do not drive an agent loop, so there is no budget hook
  // to install and no reason to require an event bus.
  if (typeof (ctx as unknown as { on?: unknown }).on !== 'function') return

  const budgetByAgent = new Map<string, ReturnType<typeof createToolBudgetState>>()
  const softExecutions = new Map<ToolExecutionToken, string>()
  const pendingFinalOnly = new Map<string, Agent>()
  const finalOnlyDisposers = new Map<string, () => void>()

  const clearAgent = (agentId: string) => {
    budgetByAgent.delete(agentId)
    for (const [token, owner] of softExecutions) {
      if (owner === agentId) softExecutions.delete(token)
    }
    pendingFinalOnly.delete(agentId)
    finalOnlyDisposers.get(agentId)?.()
    finalOnlyDisposers.delete(agentId)
  }

  const enterFinalOnly = (agent: Agent) => {
    const agentId = String(agent.id)
    if (finalOnlyDisposers.has(agentId)) return
    const globalTools = ctx.tools as unknown as RestrictableTools
    const scopedTools = agent.ctx?.tools as unknown as RestrictableTools | undefined
    if (typeof globalTools.schemas !== 'function' || typeof scopedTools?.restrict !== 'function') return

    // GoTry's model-facing tools are inherited globals. Removing their schemas
    // makes the next native-mode request text-only; the execution wrapper below
    // still denies any already-prepared same-step call beyond the hard limit.
    const inheritedNames = globalTools.schemas()
      .map(schema => schema.name)
      .filter(name => name !== 'run_code')
    if (inheritedNames.length === 0) return
    finalOnlyDisposers.set(agentId, scopedTools.restrict({ deny: inheritedNames }))
  }

  ctx.on('session/event', (subject, event) => {
    const agentId = String(subject.id)
    if (event.type === 'turn/start' || event.type === 'turn/end') {
      clearAgent(agentId)
      return
    }
    // The live registry re-checks a tool name before starting every call in
    // one assistant response. Restricting immediately on call 18 would turn an
    // already-prepared call 19 into an opaque "unknown tool" before the
    // execute waterfall can return TOOL_BUDGET_EXHAUSTED. step/end is the
    // exact boundary after that batch settles and before the next prompt is
    // assembled, so current-step refusals stay structured while the next
    // native request is text-only.
    if (event.type === 'step/end') {
      const agent = pendingFinalOnly.get(agentId)
      if (agent) {
        pendingFinalOnly.delete(agentId)
        enterFinalOnly(agent)
      }
    }
  })
  ctx.on('session/disposed', subject => clearAgent(String(subject.id)))

  ctx.on('tools/execute', (exec, next) => {
    // Programmatic/direct calls are not part of a model planner turn.
    if (!exec.agent) return next()
    const agentId = String(exec.agent.id)
    const state = budgetByAgent.get(agentId) ?? createToolBudgetState()
    budgetByAgent.set(agentId, state)
    const decision = state.nextCall()
    if (decision.kind === 'deny') {
      pendingFinalOnly.set(agentId, exec.agent)
      return Promise.resolve(exhaustionResult(decision.reason))
    }
    if (decision.softSignal) softExecutions.set(exec.token, agentId)
    if (decision.exhaustsBudget) pendingFinalOnly.set(agentId, exec.agent)
    return next()
  })

  ctx.on('tools/post-execute', (exec, _result, next) => {
    if (!softExecutions.delete(exec.token)) return next()
    return next().then(decision => ({
      ...decision,
      additionalContexts: [
        ...(decision.additionalContexts ?? []),
        convergenceContext(
          'TOOL_BUDGET_SOFT',
          'Tool call 16 reached. Converge now and produce the final answer from gathered evidence.',
        ) as never,
      ],
    }))
  })
}
