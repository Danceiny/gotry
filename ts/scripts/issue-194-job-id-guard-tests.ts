/**
 * Issue #194 focused regression.
 *
 * This mounts the actual dsh ToolRuntime, LocalJobRegistry, and job tools, then
 * supplies only a deterministic in-process subagent listing. It never starts a
 * provider, opens Chrome, reads credentials, or writes shared state.
 */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { LocalJobRegistry } from '@deepseek-ai/dsh-jobs-local'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { apply as applyJobs } from '@deepseek-ai/dsh-tool-jobs'
import type { SubagentListEntry } from '@deepseek-ai/dsh-subagent'
import { installSubagentJobIdGuard } from '../src/subagent-job-id-guard.ts'

const parentId = 'parent-session-issue-194' as Agent['id']
const durableId = 'dc5c8d88-d23e-4df0-ba95-ccbc80e2742a' as Agent['id']
const oneShotId = 'one-shot-session-issue-194' as Agent['id']
const unrelatedId = 'unrelated-session-issue-194' as Agent['id']
const listedParents: string[] = []

const continuable: SubagentListEntry = {
  kind: 'child',
  id: durableId,
  activity: 'inactive',
  hasChildren: false,
  mode: 'continuable',
  label: 'fixture continuable child',
}
const oneShot: SubagentListEntry = {
  kind: 'child',
  id: oneShotId,
  activity: 'inactive',
  hasChildren: false,
  mode: 'one-shot',
}

const ctx = new Context()
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime, {})
await ctx.plugin(LocalJobRegistry, {})
await ctx.inject(['tools', 'jobs'], () => applyJobs(ctx, {}))
const removeSubagents = ctx.provide('subagents', {
  listChildren: async (id: Agent['id'], _signal: AbortSignal) => {
    listedParents.push(String(id))
    return id === parentId ? [continuable, oneShot] : []
  },
})
installSubagentJobIdGuard(ctx)

const agent = { id: parentId, ctx } as unknown as Agent
const signal = () => new AbortController().signal
const resultText = (result: { content: readonly unknown[] }): string => {
  const block = result.content[0]
  if (!block || typeof block !== 'object' || !('text' in block)) return ''
  return typeof block.text === 'string' ? block.text : ''
}
const execute = (name: 'job_output' | 'job_kill', jobId: string, caller = agent) =>
  ctx.tools.execute({
    callId: `issue-194-${name}-${jobId}` as never,
    name,
    arguments: { job_id: jobId },
    agent: caller,
    signal: signal(),
  })

try {
  for (const name of ['job_output', 'job_kill'] as const) {
    const result = await execute(name, durableId)
    assert.equal(result.isError, true)
    assert.match(resultText(result), /^Error: SUBAGENT_ID_IS_NOT_JOB_ID:/)
    assert.match(resultText(result), /continuable subagent durable id, not a background job id/)
    assert.match(resultText(result), /completion notice/)
    assert.match(resultText(result), /list_agents/)
    assert.match(resultText(result), /send_message/)
    if (name === 'job_kill') assert.match(resultText(result), /interrupt_agent/)
    assert.match(result.error.message, /SUBAGENT_ID_IS_NOT_JOB_ID/)
    assert.doesNotMatch(result.error.message, /unknown job/)
  }

  // A UUID-shaped but unlisted id keeps native dsh behavior; no global UUID
  // heuristic or jobs ownership expansion is allowed.
  const unrelated = await execute('job_output', '8e7f2c4a-3c92-4ce8-bc2a-2e1bdceec2f4')
  assert.equal(unrelated.isError, true)
  assert.match(resultText(unrelated), /^Error: unknown job /)

  // A one-shot child is not a continuable durable conversation and also keeps
  // native jobs behavior, even when it is visible in the same direct listing.
  const oneShotResult = await execute('job_output', oneShotId)
  assert.equal(oneShotResult.isError, true)
  assert.match(resultText(oneShotResult), /^Error: unknown job /)

  // The lookup is scoped to the exact caller's direct children.
  const otherAgent = { id: unrelatedId, ctx } as unknown as Agent
  const otherParentResult = await execute('job_output', durableId, otherAgent)
  assert.equal(otherParentResult.isError, true)
  assert.match(resultText(otherParentResult), /^Error: unknown job /)
  assert.deepEqual(listedParents, [parentId, parentId, parentId, parentId, unrelatedId])

  console.log(JSON.stringify({
    dsh: '0.1.5-rc.1',
    toolRuntime: 'real ToolRuntime + LocalJobRegistry + dsh-tool-jobs',
    guarded: ['job_output', 'job_kill'],
    durableId,
    nativeUnknownIds: 3,
    exactParentLookups: listedParents,
    sharedState: false,
    liveSession: false,
  }))
} finally {
  await removeSubagents()
  await ctx.fiber.dispose()
}
