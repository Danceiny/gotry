/**
 * Prevent a continuable subagent durable id from entering the jobs tool family.
 *
 * dsh deliberately keeps continuable children out of the jobs registry. The
 * jobs tools therefore cannot distinguish a mistaken durable child id from any
 * other unknown id once their body runs. GoTry owns the surrounding plugin and
 * can use dsh's typed pre-execute waterfall to give the model a recoverable,
 * actionable error before the jobs registry is consulted.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { SubagentListEntry, SubagentRuntime } from '@deepseek-ai/dsh-subagent'

const JOB_TOOLS = new Set(['job_output', 'job_kill'])

function subagentsOf(ctx: Context): SubagentRuntime | undefined {
  try {
    return (ctx as Context & { subagents?: SubagentRuntime }).subagents
  } catch {
    // Minimal hosts and benchmark contexts may not mount the optional service.
    return undefined
  }
}

function jobIdOf(exec: ToolExecution): string | undefined {
  if (!exec.arguments || typeof exec.arguments !== 'object') return undefined
  const jobId = (exec.arguments as Record<string, unknown>).job_id
  return typeof jobId === 'string' && jobId.length > 0 ? jobId : undefined
}

function isContinuableChild(entry: SubagentListEntry, jobId: string): boolean {
  return entry.kind === 'child' && entry.mode === 'continuable' && entry.id === jobId
}

function recoveryReason(toolName: string, jobId: string): string {
  const stopHint = toolName === 'job_kill'
    ? '; use interrupt_agent to stop its current turn.'
    : '.'
  return [
    `SUBAGENT_ID_IS_NOT_JOB_ID: ${JSON.stringify(jobId)} is a continuable subagent durable id, not a background job id.`,
    'Its completion arrives as a completion notice; use list_agents to inspect it and send_message to continue it',
    stopHint,
  ].join(' ')
}

/** Install the GoTry-owned safety net around dsh's jobs tools. */
export function installSubagentJobIdGuard(ctx: Context): void {
  const ctxOn = (ctx as unknown as { on?: typeof ctx.on }).on
  if (typeof ctxOn !== 'function') return
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (!JOB_TOOLS.has(exec.name)) return next()
    const jobId = jobIdOf(exec)
    const agent = exec.agent as Agent | undefined
    const subagents = subagentsOf(ctx)
    if (!jobId || !agent || !subagents) return next()

    let children: SubagentListEntry[]
    try {
      children = await subagents.listChildren(agent.id as SessionId, exec.signal)
    } catch (error) {
      // The guard is diagnostic, not an alternate ownership or availability
      // path. Preserve cancellation; otherwise retain dsh's native job error.
      if (exec.signal.aborted) throw error
      return next()
    }

    if (!children.some(entry => isContinuableChild(entry, jobId))) return next()
    return { kind: 'deny', reason: recoveryReason(exec.name, jobId) }
  }, { prepend: true })
}
