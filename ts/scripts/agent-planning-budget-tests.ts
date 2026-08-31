import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import {
  createToolBudgetState,
  installToolBudget,
  TOOL_BUDGET_EXHAUSTED,
  toolBudgetDecision,
} from '../src/tool-budget.ts'

type Result = {
  isError: boolean
  error?: { message: string; info?: { name: string; code: string } }
  value?: unknown
  content: Array<{ type: string; text?: string }>
  additionalContexts?: Array<{ content?: Array<{ type?: string; text?: string }> }>
}
type PostDecision = { kind: 'accept'; additionalContexts?: Result['additionalContexts'] }
type ExecuteListener = (exec: FakeExecution, next: () => Promise<Result>) => Promise<Result>
type PostListener = (exec: FakeExecution, result: Result, next: () => Promise<PostDecision>) => Promise<PostDecision>
type SessionEventListener = (session: { id: string }, event: { type: string }) => void
type SessionDisposedListener = (session: { id: string }) => void
type FakeAgent = { id: string; ctx: { tools: { restrict(filter: { deny: string[] }): () => void } } }
type FakeExecution = { token: symbol; agent?: FakeAgent }

const success = (): Result => ({ isError: false, value: null, content: [] })
const handlers = new Map<string, unknown[]>()
const restricted: Array<{ agentId: string; deny: string[] }> = []
const lifted: string[] = []
const makeAgent = (id: string): FakeAgent => ({
  id,
  ctx: {
    tools: {
      restrict(filter) {
        restricted.push({ agentId: id, deny: [...filter.deny] })
        return () => lifted.push(id)
      },
    },
  },
})
const ctx = {
  tools: {
    schemas: () => [{ name: 'gotry_alpha' }, { name: 'gotry_beta' }],
  },
  on(event: string, listener: unknown) {
    const bucket = handlers.get(event) ?? []
    bucket.push(listener)
    handlers.set(event, bucket)
    return () => {}
  },
} as unknown as Context

installToolBudget(ctx)
const execute = handlers.get('tools/execute')?.[0] as ExecuteListener | undefined
const postExecute = handlers.get('tools/post-execute')?.[0] as PostListener | undefined
const sessionEvent = handlers.get('session/event')?.[0] as SessionEventListener | undefined
const sessionDisposed = handlers.get('session/disposed')?.[0] as SessionDisposedListener | undefined
assert.ok(execute && postExecute && sessionEvent && sessionDisposed, 'all Cordis budget hooks register')

// Pure boundary remains independently reviewable.
assert.deepEqual(toolBudgetDecision(18), { kind: 'allow', softSignal: false, exhaustsBudget: true })
const pureExhausted = toolBudgetDecision(19)
assert.equal(pureExhausted.kind, 'deny')
if (pureExhausted.kind === 'deny') assert.match(pureExhausted.reason, /TOOL_BUDGET_EXHAUSTED/)
const freshState = createToolBudgetState()
assert.equal(freshState.nextCall().callNumber, 1)

// Agent-less calls are programmatic control-plane calls, not planner spend.
let directBodies = 0
for (let i = 0; i < 25; i++) {
  const result: Result = await execute({ token: Symbol(`direct-${i}`) }, async () => {
    directBodies++
    return success()
  })
  assert.equal(result.isError, false)
}
assert.equal(directBodies, 25)

// Real hook integration: soft context at 16, schema suppression after 18,
// structured failure and zero body dispatch for an already-prepared call 19.
const agent = makeAgent('agent-serial')
let serialBodies = 0
let softSignals = 0
for (let attempt = 1; attempt <= 18; attempt++) {
  const exec = { token: Symbol(`serial-${attempt}`), agent }
  const result: Result = await execute(exec, async () => {
    serialBodies++
    return success()
  })
  const post = await postExecute(exec, result, async () => ({ kind: 'accept' }))
  const contextText = post.additionalContexts?.flatMap(item => item.content ?? []).map(item => item.text ?? '').join('\n') ?? ''
  if (contextText.includes('TOOL_BUDGET_SOFT')) softSignals++
}
assert.equal(serialBodies, 18)
assert.equal(softSignals, 1)
assert.equal(restricted.length, 0, 'same-step prepared calls remain resolvable until step/end')

let nineteenthBodyRan = false
const nineteenth: Result = await execute({ token: Symbol('serial-19'), agent }, async () => {
  nineteenthBodyRan = true
  return success()
})
assert.equal(nineteenthBodyRan, false)
assert.equal(nineteenth.isError, true)
assert.deepEqual(nineteenth.error?.info, { name: 'ToolBudgetError', code: TOOL_BUDGET_EXHAUSTED })
assert.match(nineteenth.content[0]?.text ?? '', /TOOL_BUDGET_EXHAUSTED/)
assert.match(nineteenth.additionalContexts?.[0]?.content?.[0]?.text ?? '', /Produce the final answer/)

// Only after the complete assistant call batch settles do we hide schemas for
// the next request. This preserves the structured refusal above instead of an
// early registry-level "unknown tool" failure.
sessionEvent({ id: agent.id }, { type: 'step/end' })
assert.deepEqual(restricted.at(-1), { agentId: agent.id, deny: ['gotry_alpha', 'gotry_beta'] })

// Turn lifecycle restores the inherited tool catalog and a fresh budget.
sessionEvent({ id: agent.id }, { type: 'turn/end' })
assert.equal(lifted.at(-1), agent.id)
sessionEvent({ id: agent.id }, { type: 'turn/start' })
const afterReset: Result = await execute({ token: Symbol('new-turn-1'), agent }, async () => success())
assert.equal(afterReset.isError, false)

// Same-step parallel preparation stays monotonic: 18 bodies, one structured
// refusal. JavaScript reaches nextCall synchronously before any body settles.
const parallelAgent = makeAgent('agent-parallel')
let parallelBodies = 0
const parallelResults = await Promise.all(Array.from({ length: 19 }, async (_, index) => {
  return execute({ token: Symbol(`parallel-${index + 1}`), agent: parallelAgent }, async () => {
    parallelBodies++
    await Promise.resolve()
    return success()
  })
}))
assert.equal(parallelBodies, 18)
assert.equal(parallelResults.filter(result => result.isError).length, 1)
assert.equal(parallelResults.find(result => result.isError)?.error?.info?.code, TOOL_BUDGET_EXHAUSTED)
sessionEvent({ id: parallelAgent.id }, { type: 'step/end' })
assert.deepEqual(restricted.at(-1), { agentId: parallelAgent.id, deny: ['gotry_alpha', 'gotry_beta'] })

// Session disposal also lifts final-only mode and releases retained state.
sessionDisposed({ id: parallelAgent.id })
assert.equal(lifted.at(-1), parallelAgent.id)

console.log('agent planning tool budget tests: OK (Cordis execute/post/lifecycle/parallel integration)')
