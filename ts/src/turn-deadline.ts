/**
 * Per-agent, per-turn wall-clock deadline for model-driven tool loops.
 *
 * Design intent (ADR-20): user-perceived time is the only budget that matters
 * on the product path. The previous step-count / token-count budget was a
 * benchmark-opt-in concept; it leaked onto the product path and produced the
 * trajectory failure where the model emitted three more tool calls after
 * `TOOL_BUDGET_EXHAUSTED`, ran out of tokens, and the user never saw a final
 * answer. Product paths now skip this hook entirely. Benchmark opt-in paths
 * install it with a wall-clock deadline so benchmarks still have a
 * deterministic, attributable termination condition.
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecutionResult, ToolExecutionToken } from '@deepseek-ai/dsh-tools'

export const DEFAULT_TURN_DEADLINE_SOFT_MS = 60_000
export const DEFAULT_TURN_DEADLINE_HARD_MS = 120_000

export const TURN_DEADLINE_SOFT = 'TURN_DEADLINE_SOFT'
export const TURN_DEADLINE_EXHAUSTED = 'TURN_DEADLINE_EXHAUSTED'

export type TurnDeadlineDecision =
  | { kind: 'allow'; softSignal: boolean; exhaustsBudget: boolean; elapsedMs: number }
  | { kind: 'deny'; reason: string; elapsedMs: number }

export interface TurnDeadlineOptions {
  /** When false the install call returns immediately with zero side effects. */
  enabled?: boolean
  /** Soft convergence hint threshold in milliseconds. */
  softMs?: number
  /** Hard denial threshold in milliseconds. */
  hardMs?: number
  /** Wall-clock source — overridden by tests for determinism. */
  now?: () => number
}

function resolveEnvMs(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function turnDeadlineDecision(
  elapsedMs: number,
  softMs: number,
  hardMs: number,
): TurnDeadlineDecision {
  if (elapsedMs > hardMs) {
    return {
      kind: 'deny',
      reason: `${TURN_DEADLINE_EXHAUSTED}: turn exceeded hard deadline of ${hardMs}ms (elapsed ${elapsedMs}ms); provide a final answer using existing results`,
      elapsedMs,
    }
  }
  return {
    kind: 'allow',
    softSignal: elapsedMs > softMs,
    exhaustsBudget: false,
    elapsedMs,
  }
}

export function createTurnDeadlineState(
  softMs: number,
  hardMs: number,
  now: () => number,
): {
  nextCall(): TurnDeadlineDecision
  reset(): void
} {
  let turnStartedAt = now()
  return {
    nextCall() {
      return turnDeadlineDecision(now() - turnStartedAt, softMs, hardMs)
    },
    reset() {
      turnStartedAt = now()
    },
  }
}

function convergenceContext(code: 'TURN_DEADLINE_SOFT' | typeof TURN_DEADLINE_EXHAUSTED, text: string) {
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

type RestrictableTools = {
  schemas?: () => Array<{ name: string }>
  restrict?: (filter: { deny: string[] }) => () => void
}

/**
 * Install the runtime boundary, kept separate from the GoTry tool catalog so
 * the actual Cordis waterfalls can be exercised without booting every tool.
 *
 * Pass `{ enabled: false }` to install nothing at all — the canonical way for
 * the product path to opt out of the benchmark-only deadline hook.
 */
export function installTurnDeadline(ctx: Context, options: TurnDeadlineOptions = {}): void {
  if (options.enabled === false) return

  // Some offline contract tests intentionally provide a registration-only
  // Context slice. They do not drive an agent loop, so there is no deadline
  // hook to install and no reason to require an event bus.
  if (typeof (ctx as unknown as { on?: unknown }).on !== 'function') return

  const softMs = options.softMs ?? resolveEnvMs('GOTRY_TURN_DEADLINE_SOFT_MS', DEFAULT_TURN_DEADLINE_SOFT_MS)
  const hardMs = options.hardMs ?? resolveEnvMs('GOTRY_TURN_DEADLINE_HARD_MS', DEFAULT_TURN_DEADLINE_HARD_MS)
  const now = options.now ?? (() => Date.now())

  const deadlineByAgent = new Map<string, ReturnType<typeof createTurnDeadlineState>>()
  const softExecutions = new Map<ToolExecutionToken, string>()
  const finalOnlyDisposers = new Map<string, () => void>()

  const clearAgent = (agentId: string) => {
    deadlineByAgent.delete(agentId)
    for (const [token, owner] of softExecutions) {
      if (owner === agentId) softExecutions.delete(token)
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
      // No registry to suppress: subsequent tool calls in the same turn will
      // hit the same per-call denial branch above and stay refused until the
      // next `turn/start` resets the state. The structured EXHAUSTED result
      // is delivered to the model once, so the loop converges on a text-only
      // final answer.
      return
    }
    // GoTry's model-facing tools are inherited globals. Removing their schemas
    // makes the next native-mode request text-only; the execution wrapper above
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
      if (event.type === 'turn/start') {
        deadlineByAgent.set(agentId, createTurnDeadlineState(softMs, hardMs, now))
      }
      return
    }
  })
  ctx.on('session/disposed', subject => clearAgent(String(subject.id)))

  ctx.on('tools/execute', (exec, next) => {
    // Programmatic/direct calls are not part of a model planner turn.
    if (!exec.agent) return next()
    const agentId = String(exec.agent.id)
    const state = deadlineByAgent.get(agentId) ?? createTurnDeadlineState(softMs, hardMs, now)
    deadlineByAgent.set(agentId, state)
    const decision = state.nextCall()
    if (decision.kind === 'deny') {
      // Suppress inherited tool schemas synchronously so any same-step
      // follow-up calls hit the registry-level denial instead of looping
      // on EXHAUSTED tool results. The current call's structured refusal
      // still flows through the execute waterfall exactly once.
      enterFinalOnly(exec.agent)
      return Promise.resolve(exhaustionResult(decision.reason))
    }
    if (decision.softSignal) softExecutions.set(exec.token, agentId)
    return next()
  })

  ctx.on('tools/post-execute', (exec, _result, next) => {
    if (!softExecutions.delete(exec.token)) return next()
    return next().then(decision => ({
      ...decision,
      additionalContexts: [
        ...(decision.additionalContexts ?? []),
        convergenceContext(
          'TURN_DEADLINE_SOFT',
          `Turn has crossed the ${softMs}ms soft deadline. Stop dispatching new tools and produce the final answer from gathered evidence.`,
        ) as never,
      ],
    }))
  })
}