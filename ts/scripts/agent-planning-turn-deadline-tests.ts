import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import {
  createTurnDeadlineState,
  installTurnDeadline,
  TURN_DEADLINE_EXHAUSTED,
  turnDeadlineDecision,
} from '../src/turn-deadline.ts'

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

// Pure boundary remains independently reviewable.
assert.deepEqual(turnDeadlineDecision(0, 60_000, 120_000), { kind: 'allow', softSignal: false, exhaustsBudget: false, elapsedMs: 0 })
assert.deepEqual(turnDeadlineDecision(60_001, 60_000, 120_000), { kind: 'allow', softSignal: true, exhaustsBudget: false, elapsedMs: 60_001 })
const pureExhausted = turnDeadlineDecision(120_001, 60_000, 120_000)
assert.equal(pureExhausted.kind, 'deny')
if (pureExhausted.kind === 'deny') assert.match(pureExhausted.reason, /TURN_DEADLINE_EXHAUSTED/)

const freshClock = (() => {
  let t = 0
  return {
    now: () => t,
    advance: (ms: number) => { t += ms },
  }
})()
const freshState = createTurnDeadlineState(60_000, 120_000, freshClock.now)
assert.equal(freshState.nextCall().elapsedMs, 0)
freshClock.advance(100)
freshState.reset()
assert.equal(freshState.nextCall().elapsedMs, 0)

// Product-path opt-out: `enabled: false` must install nothing — the hook list
// stays empty. This locks down ADR-20: the product path never subscribes to
// turn-deadline observability.
const productCtx = {
  tools: { schemas: () => [] },
  on(event: string) {
    throw new Error(`product path must not subscribe to ${event}`)
  },
} as unknown as Context
installTurnDeadline(productCtx, { enabled: false })

installTurnDeadline(ctx, { softMs: 60_000, hardMs: 120_000, now: freshClock.now })
const execute = handlers.get('tools/execute')?.[0] as ExecuteListener | undefined
const postExecute = handlers.get('tools/post-execute')?.[0] as PostListener | undefined
const sessionEvent = handlers.get('session/event')?.[0] as SessionEventListener | undefined
const sessionDisposed = handlers.get('session/disposed')?.[0] as SessionDisposedListener | undefined
assert.ok(execute && postExecute && sessionEvent && sessionDisposed, 'all Cordis deadline hooks register')

// Agent-less calls are programmatic control-plane calls, not planner spend.
let directBodies = 0
for (let i = 0; i < 5; i++) {
  const result: Result = await execute({ token: Symbol(`direct-${i}`) }, async () => {
    directBodies++
    return success()
  })
  assert.equal(result.isError, false)
}
assert.equal(directBodies, 5)

// Fresh turn = fresh clock. Drive the agent through soft, then past hard.
const agent = makeAgent('agent-serial')
sessionEvent({ id: agent.id }, { type: 'turn/start' })

// First call below soft: allow, no soft signal.
let bodyRan = 0
{
  const exec = { token: Symbol('serial-1'), agent }
  const result: Result = await execute(exec, async () => { bodyRan++; return success() })
  const post = await postExecute(exec, result, async () => ({ kind: 'accept' }))
  assert.equal(result.isError, false)
  assert.equal(bodyRan, 1)
  assert.equal((post.additionalContexts ?? []).length, 0, 'no convergence context before soft')
}

// Advance the clock past soft: post-execute injects TURN_DEADLINE_SOFT.
freshClock.advance(60_001)
{
  const exec = { token: Symbol('serial-2'), agent }
  const result: Result = await execute(exec, async () => { bodyRan++; return success() })
  const post = await postExecute(exec, result, async () => ({ kind: 'accept' }))
  assert.equal(result.isError, false)
  const contextText = post.additionalContexts?.flatMap(item => item.content ?? []).map(item => item.text ?? '').join('\n') ?? ''
  assert.ok(contextText.includes('TURN_DEADLINE_SOFT'), 'soft context fires once we cross softMs')
  assert.equal(restricted.length, 0, 'no schema suppression while still inside hard budget')
}

// Advance the clock past hard: structured refusal without running the body.
freshClock.advance(60_000)
{
  const exec = { token: Symbol('serial-3'), agent }
  let hardBodyRan = false
  const result: Result = await execute(exec, async () => { hardBodyRan = true; return success() })
  assert.equal(hardBodyRan, false)
  assert.equal(result.isError, true)
  assert.deepEqual(result.error?.info, { name: 'TurnDeadlineError', code: TURN_DEADLINE_EXHAUSTED })
  assert.match(result.content[0]?.text ?? '', /TURN_DEADLINE_EXHAUSTED/)
  assert.match(result.additionalContexts?.[0]?.content?.[0]?.text ?? '', /Produce the final answer/)
}

// Hard-deadline suppression is synchronous on the deny call so the agent
// cannot loop on EXHAUSTED tool results inside the same step. The next
// native request arrives with the inherited tool schemas removed.
assert.deepEqual(restricted.at(-1), { agentId: agent.id, deny: ['gotry_alpha', 'gotry_beta'] })

// Turn lifecycle restores the inherited tool catalog and a fresh deadline.
sessionEvent({ id: agent.id }, { type: 'turn/end' })
assert.equal(lifted.at(-1), agent.id)
sessionEvent({ id: agent.id }, { type: 'turn/start' })
{
  const exec = { token: Symbol('new-turn-1'), agent }
  const result: Result = await execute(exec, async () => success())
  assert.equal(result.isError, false)
}

// Session disposal also lifts final-only mode and releases retained state.
sessionDisposed({ id: agent.id })

console.log('agent planning turn deadline tests: OK (wall-clock soft/hard, opt-out, lifecycle, registry suppression)')