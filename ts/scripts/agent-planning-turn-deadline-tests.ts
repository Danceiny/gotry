import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { approvalFromContext, createConsentGate } from '../capabilities/session-consent.ts'
import {
  installTurnDeadline,
  TURN_DEADLINE_EXHAUSTED,
  TURN_DEADLINE_HANDOFF,
  TURN_HANDOFF_SCHEMA,
  writeTurnHandoffTicket,
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
type SessionEventListener = (session: { id: string }, event: Record<string, unknown> & { type: string }) => void
type SessionDisposedListener = (session: { id: string }) => void
type FakeAgent = { id: string; ctx: { tools: { restrict(filter: { deny: string[] }): () => void } } }
type FakeExecution = { token: symbol; name?: string; agent?: FakeAgent }

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

// Product-path opt-out: `enabled: false` must install nothing.
const productCtx = {
  tools: { schemas: () => [] },
  on(event: string) {
    throw new Error(`opt-out path must not subscribe to ${event}`)
  },
} as unknown as Context
installTurnDeadline(productCtx, { enabled: false })

const clock = (() => {
  let t = 1_000_000
  return { now: () => t, advance: (ms: number) => { t += ms } }
})()

const handoffRoot = mkdtempSync(join(tmpdir(), 'gotry-turn-handoff-tests-'))
installTurnDeadline(ctx, { stateRoot: handoffRoot, now: clock.now })
const execute = handlers.get('tools/execute')?.[0] as ExecuteListener | undefined
const postExecute = handlers.get('tools/post-execute')?.[0] as PostListener | undefined
const sessionEvent = handlers.get('session/event')?.[0] as SessionEventListener | undefined
const sessionDisposed = handlers.get('session/disposed')?.[0] as SessionDisposedListener | undefined
assert.ok(execute && postExecute && sessionEvent && sessionDisposed, 'all Cordis boundary hooks register')

// dsh 事件载荷在 event.data 下(与 benchmark-agent-conformance 同型)。
const userMessage = (id: string, text: string, kind = 'user') =>
  sessionEvent({ id }, { type: 'user/message', data: { source: { kind }, content: [{ type: 'text', text }] } })
const turnEvent = (id: string, type: 'turn/start' | 'turn/end') => sessionEvent({ id }, { type })

// Agent-less calls are programmatic control-plane calls, not planner spend.
{
  let directBodies = 0
  for (let i = 0; i < 5; i++) {
    const result: Result = await execute({ token: Symbol(`direct-${i}`) }, async () => { directBodies++; return success() })
    assert.equal(result.isError, false)
  }
  assert.equal(directBodies, 5)
}

// ---- converge 路径:sync-planning 消息,软提示 + 硬阈结构化拒绝 ----------------
{
  const agent = makeAgent('agent-converge')
  turnEvent(agent.id, 'turn/start')
  userMessage(agent.id, '帮我看看10.1去杭州的高铁票')

  {
    const exec = { token: Symbol('conv-1'), agent }
    const result: Result = await execute(exec, async () => success())
    const post = await postExecute(exec, result, async () => ({ kind: 'accept' }))
    assert.equal(result.isError, false)
    assert.equal((post.additionalContexts ?? []).length, 0, 'no convergence context before soft')
    assert.equal(restricted.length, 0)
  }

  // 推进超过软阈(sync-planning 300s):post-execute 注入 TURN_DEADLINE_SOFT
  clock.advance(300_001)
  {
    const exec = { token: Symbol('conv-2'), agent }
    const result: Result = await execute(exec, async () => success())
    const post = await postExecute(exec, result, async () => ({ kind: 'accept' }))
    const contextText = post.additionalContexts?.flatMap(item => item.content ?? []).map(item => item.text ?? '').join('\n') ?? ''
    assert.ok(contextText.includes('TURN_DEADLINE_SOFT'), 'soft context after crossing softMs')
    assert.ok(contextText.includes('final answer'), 'converge soft text asks for a final answer')
  }

  // 推进超过硬阈(600s):结构化拒绝 + 同步抑制 schema,不落任何工单
  clock.advance(300_000)
  {
    const exec = { token: Symbol('conv-3'), agent }
    let bodyRan = false
    const result: Result = await execute(exec, async () => { bodyRan = true; return success() })
    assert.equal(bodyRan, false)
    assert.equal(result.isError, true)
    assert.deepEqual(result.error?.info, { name: 'TurnDeadlineError', code: TURN_DEADLINE_EXHAUSTED })
    assert.match(result.content[0]?.text ?? '', /TURN_DEADLINE_EXHAUSTED/)
  }
  assert.deepEqual(restricted.at(-1), { agentId: agent.id, deny: ['gotry_alpha', 'gotry_beta'] })
  const convergeTicketDir = join(handoffRoot, 'gotry-state', 'turn-handoffs')
  assert.equal(existsSync(convergeTicketDir) ? readdirSync(convergeTicketDir).length : 0, 0, 'converge writes no ticket')

  turnEvent(agent.id, 'turn/end')
  assert.equal(lifted.at(-1), agent.id)
}

// ---- handoff 路径:deep-planning 消息(失败轨迹原文)→ 落单转后台 -----------
{
  const agent = makeAgent('agent-handoff')
  turnEvent(agent.id, 'turn/start')
  const deepMessage = '2026年我还有6天IRW额度 ,我准备再请几天假,在国内待个十几天。'
    + '其中10.3要去湖南衡阳参加同学婚礼。其他我没有特别的要求,请根据我的实际情况,偏好,外部环境等因素,给我安排行程'
  userMessage(agent.id, deepMessage)

  // 软阈(deep 120s):提示语义是「收尾摸底、即将转后台」
  clock.advance(120_001)
  {
    const exec = { token: Symbol('hand-1'), agent }
    const result: Result = await execute(exec, async () => success())
    const post = await postExecute(exec, result, async () => ({ kind: 'accept' }))
    const contextText = post.additionalContexts?.flatMap(item => item.content ?? []).map(item => item.text ?? '').join('\n') ?? ''
    assert.ok(contextText.includes('background planning'), 'handoff soft text announces the handoff')
    assert.equal(result.isError, false)
  }

  // 硬阈(240s):TURN_DEADLINE_HANDOFF 结构化结果 + 工单落盘
  clock.advance(120_000)
  {
    const exec = { token: Symbol('hand-2'), agent }
    let bodyRan = false
    const result: Result = await execute(exec, async () => { bodyRan = true; return success() })
    assert.equal(bodyRan, false)
    assert.equal(result.isError, true)
    assert.deepEqual(result.error?.info, { name: 'TurnDeadlineHandoff', code: TURN_DEADLINE_HANDOFF })
    const text = result.content[0]?.text ?? ''
    assert.match(text, /TURN_DEADLINE_HANDOFF/)
    assert.match(text, /th-/, 'result names the persisted ticket id')
    assert.match(text, /queued|not started/i, 'a persisted ticket alone must not claim a running worker')
  }
  // 同步抑制已生效
  assert.deepEqual(restricted.at(-1), { agentId: agent.id, deny: ['gotry_alpha', 'gotry_beta'] })

  const tickets = readdirSync(join(handoffRoot, 'gotry-state', 'turn-handoffs'))
  assert.equal(tickets.length, 1, 'exactly one handoff ticket')
  const ticket = JSON.parse(readFileSync(join(handoffRoot, 'gotry-state', 'turn-handoffs', tickets[0]), 'utf8'))
  assert.equal(ticket.schema, TURN_HANDOFF_SCHEMA)
  assert.equal(ticket.status, 'open')
  assert.equal(ticket.userMessage, deepMessage, 'ticket carries the verbatim user ask')
  assert.ok(ticket.requestedAt)
  assert.equal(ticket.etaLabel, '约 1 小时')

  // 新 user 消息 = 新预算:同 agent 下一轮 quick 消息恢复放行
  turnEvent(agent.id, 'turn/end')
  userMessage(agent.id, '你好')
  {
    const result: Result = await execute({ token: Symbol('hand-3'), agent }, async () => success())
    assert.equal(result.isError, false)
  }
  turnEvent(agent.id, 'turn/end')
  assert.equal(readdirSync(join(handoffRoot, 'gotry-state', 'turn-handoffs')).length, 1, 'no extra tickets')
}

// ---- 路由输入纪律:plugin 注入的 user/message 不参与路由 --------------------
{
  const agent = makeAgent('agent-plugin-msg')
  turnEvent(agent.id, 'turn/start')
  userMessage(agent.id, '你好')
  // plugin 注入的深规划文本不得翻转预算
  userMessage(agent.id, deepPlanningNoise(), 'plugin')
  clock.advance(1_000_000)
  {
    const exec = { token: Symbol('plug-1'), agent }
    const result: Result = await execute(exec, async () => success())
    // quick 硬阈 180s 已被跨过 → converge 拒绝(而非 handoff):证明路由未被 plugin 消息改写
    assert.deepEqual(result.error?.info, { name: 'TurnDeadlineError', code: TURN_DEADLINE_EXHAUSTED })
  }
  turnEvent(agent.id, 'turn/end')
}

function deepPlanningNoise(): string {
  return '系统提醒样例:10.3 婚礼 IRW 请假 十几天 安排行程——这是插件注入,不该参与路由'
}

// ---- 工单写入器(独立契约:原子写 + 目录形态) ------------------------------
{
  const root = mkdtempSync(join(tmpdir(), 'gotry-turn-handoff-writer-'))
  const ticket = await writeTurnHandoffTicket(root, '短消息')
  const dir = join(root, 'gotry-state', 'turn-handoffs')
  assert.equal(readdirSync(dir).length, 1)
  const loaded = JSON.parse(readFileSync(join(dir, `${ticket.id}.json`), 'utf8'))
  assert.equal(loaded.userMessage, '短消息')
  rmSync(root, { recursive: true, force: true })
}

sessionDisposed({ id: 'agent-handoff' })

// A deadline must let the pending output write complete and keep native present
// available. Start exactly one tracked job even if the model makes another call.
{
  const hooks = new Map<string, any>()
  let started = 0
  let denied: string[] = []
  const agent = { id: 'delivery',
    session: { id: 'delivery', header: { cwd: handoffRoot }, snapshotEvents: () => [
      { type: 'tool/call', data: { name: 'ask_user_question', callId: 'question' } },
      { type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'question' }, content: [{ text: 'China working hours 9-18 CST' }] } } },
      { type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'other' }, content: [{ text: 'large evidence '.repeat(3000) }] } } },
    ] },
    ctx: { tools: { restrict: (filter: { deny: string[] }) => { denied = filter.deny; return () => {} } } } }
  const deliveryCtx = {
    tools: { schemas: () => [{ name: 'write' }, { name: 'present' }, { name: 'search' }] },
    on: (name: string, hook: unknown) => { hooks.set(name, hook) },
  } as unknown as Context
  installTurnDeadline(deliveryCtx, {
    stateRoot: handoffRoot, now: clock.now,
    startHandoff: async (ticket) => {
      assert.equal(written, true, 'output finishes before the worker starts')
      assert.ok(ticket.context?.includes('9-18 CST'), 'retain early clarification answers despite large recent evidence')
      started++; return { ...ticket, status: 'running', jobId: 'gotry-planning-1' }
    },
  })
  hooks.get('session/event')({ id: agent.id }, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: deepMessageForDelivery() }] } })
  clock.advance(240_001)
  let written = false
  const draft = join(handoffRoot, 'exploration.md')
  const pending = { token: Symbol(), name: 'write', agent }
  const result = await hooks.get('tools/execute')(pending, async () => { writeFileSync(draft, '# Exploration'); written = true; return success() })
  const post = await hooks.get('tools/post-execute')(pending, result, async () => ({ kind: 'accept' }))
  assert.equal(written, true, 'pending output write must really execute')
  assert.equal(readFileSync(draft, 'utf8'), '# Exploration')
  assert.equal(result.isError, false, 'write result must remain truthful')
  assert.ok(!denied.includes('present'), 'native deliverable publication stays available')
  assert.equal(started, 1, 'handoff starts a tracked job')
  await hooks.get('tools/execute')({ token: Symbol(), name: 'present', agent }, async () => success())
  assert.equal(started, 1, 'present must not queue another planner')
  const text = JSON.stringify(post.additionalContexts)
  assert.match(text, /gotry-planning-1/, 'handoff names the actual native job')
  assert.match(text, /present/, 'successful writes must be presented before final reply')
  let repeatedWrite = false
  await hooks.get('tools/execute')({ token: Symbol(), name: 'write', agent }, async () => { repeatedWrite = true; return success() })
  assert.equal(repeatedWrite, false, 'only the pending draft write gets the deadline exception')
  assert.equal(started, 1, 'repeated finalization must not dispatch another worker')
}

function deepMessageForDelivery() { return '12月初有个阿联酋国庆，我打算借机 IRW远程办公（还有5天额度）+请假+放假 回国玩一趟，主要去东北，比如长春泡澡啊啥的，可以看看一些东北风光啥的（没去过），我女朋友从南京过去，请帮我探索一个可行的具体规划' }
rmSync(handoffRoot, { recursive: true, force: true })

// Real DSH registry coverage: inherited and agent-scoped output writes must
// finish before deadline restrictions hide inherited registrations.
for (const [registration, writeFailure] of [['global', false], ['scoped', false], ['global', true], ['scoped', true]] as const) {
  const root = mkdtempSync(join(tmpdir(), 'gotry-write-registry-'))
  const runtimeCtx = new Context()
  runtimeCtx.provide('systemPrompt', { tools() {} })
  const tools = new ToolRuntime(runtimeCtx)
  let time = 0
  const mutableAgent = { id: registration, ctx: runtimeCtx, session: { id: registration, header: { cwd: root }, snapshotEvents: () => [] } }
  const agent = mutableAgent as unknown as Agent
  const scope = createScope(runtimeCtx, agent)
  mutableAgent.ctx = scope.ctx
  installTurnDeadline(runtimeCtx, { stateRoot: root, now: () => time, fixedPolicy: { softMs: 5, hardMs: 10, exit: 'handoff' } })
  const draft = join(root, 'draft.md')
  let writes = 0
  ;(registration === 'global' ? tools : scope.ctx.tools).register(defineTool({
    name: 'write', description: 'Write the draft', parameters: {}, output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: 'saved' }] },
    async execute() { writes++; if (writeFailure) throw new Error('disk write failed'); writeFileSync(draft, 'saved draft'); return { saved: true } },
  }))
  try {
    assert.ok(tools.get('write', agent), 'write is visible before deadline dispatch')
    runtimeCtx.emit('session/event', agent.session, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'plan my trip' }] } } as never)
    time = 11
    const call = () => tools.execute({ name: 'write', agent, arguments: {}, callId: 'draft' as never, signal: new AbortController().signal })
    const result = await call()
    assert.equal(result.isError, writeFailure, `${registration} pending write keeps its actual registry outcome: ${JSON.stringify(result)}`)
    if (writeFailure) {
      assert.equal(existsSync(draft), false)
      assert.match(JSON.stringify(result), /disk write failed/)
    } else assert.equal(readFileSync(draft, 'utf8'), 'saved draft')
    assert.match(JSON.stringify(result.additionalContexts), /queued/, 'registry post-execute carries handoff guidance')
    await call()
    assert.equal(writes, 1, 'only the pending write receives the exception')
  } finally {
    await scope.dispose()
    await runtimeCtx.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  }
}

// Long earlier prose and recent large search output cannot evict a mandatory
// answer. If user input itself exceeds the bounded snapshot, fail visibly.
for (const overflow of [false, true]) {
  const root = mkdtempSync(join(tmpdir(), 'gotry-handoff-context-'))
  const hooks = new Map<string, any>()
  let captured: import('../src/turn-deadline.ts').TurnHandoffTicket | undefined
  const agent = { id: 'constraints', ctx: { tools: { restrict: () => () => {} } }, session: {
    id: 'constraints', header: { cwd: root }, snapshotEvents: () => [
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'earlier prose '.repeat(overflow ? 6000 : 600) }] } },
      { type: 'tool/call', data: { name: 'ask_user_question', callId: 'access' } },
      { type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'access' }, content: [{ type: 'text', text: 'MUST_KEEP_WHEELCHAIR_ACCESS_AND_NO_STAIRS' }] } } },
      { type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'search' }, content: [{ type: 'text', text: 'recent search '.repeat(2000) }] } } },
    ],
  } }
  const localCtx = { tools: { schemas: () => [] }, on: (name: string, hook: unknown) => hooks.set(name, hook) } as unknown as Context
  let time = 0
  installTurnDeadline(localCtx, { stateRoot: root, now: () => time, fixedPolicy: { softMs: 5, hardMs: 10, exit: 'handoff' },
    startHandoff: async ticket => { captured = ticket; return ticket } })
  try {
    hooks.get('session/event')({ id: agent.id }, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'plan my trip' }] } })
    time = 11
    await hooks.get('tools/execute')({ token: Symbol(), name: 'search', agent }, async () => success())
    if (overflow) {
      assert.equal(captured, undefined, 'do not start planning after silently losing user constraints')
      const ticketFile = readdirSync(join(root, 'gotry-state', 'turn-handoffs')).find(name => name.endsWith('.json'))!
      const ticket = JSON.parse(readFileSync(join(root, 'gotry-state', 'turn-handoffs', ticketFile), 'utf8'))
      assert.equal(ticket.status, 'failed')
      assert.match(ticket.error, /context|answers|constraints/i)
    } else {
      assert.ok(captured?.context?.includes('MUST_KEEP_WHEELCHAIR_ACCESS_AND_NO_STAIRS'), 'mandatory answer survives large surrounding output')
      assert.ok(captured!.context!.length < 90_000, 'context remains bounded')
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
}

// Turn 8 of the founder's session on published rc.33 (2026-11-01): a research
// call crossed the deadline, both corrected artifacts were refused, and present
// then republished the turn-7 files, which the final answer called rewritten.
// One final deliverable write still runs; present never republishes a path
// whose update this turn was refused.
{
  const root = mkdtempSync(join(tmpdir(), 'gotry-stale-present-'))
  mkdirSync(join(root, 'artifacts'))
  const turn7 = new Date('2026-11-01T05:56:34.000Z')
  for (const [name, text] of [['plan.md', '# R1'], ['plan.html', '<h1>R1</h1>']]) {
    writeFileSync(join(root, 'artifacts', name), text)
    utimesSync(join(root, 'artifacts', name), turn7, turn7)
  }
  const hooks = new Map<string, any>()
  let started = 0
  let time = 0
  const agent = { id: 'stale', ctx: { tools: { restrict: () => () => {} } },
    session: { id: 'stale', header: { cwd: root }, snapshotEvents: () => [] } }
  installTurnDeadline({ tools: { schemas: () => [] }, on: (name: string, hook: unknown) => hooks.set(name, hook) } as unknown as Context,
    { stateRoot: root, now: () => time, startHandoff: async ticket => { started++; return { ...ticket, status: 'running', jobId: 'gotry-planning-1' } } })
  const bodies: string[] = []
  const call = (name: string, args: Record<string, unknown>, body: () => Result = success): Promise<Result> =>
    hooks.get('tools/execute')({ token: Symbol(name), callId: `call-${bodies.length}-${name}`, name, agent, arguments: args },
      async () => { bodies.push(name); return body() })
  try {
    hooks.get('session/event')({ id: agent.id }, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: deepMessageForDelivery() }] } })
    time = 240_001
    const crossing = await call('gotry_flyai_search', { kind: 'flight' })
    assert.equal(crossing.error?.info?.code, TURN_DEADLINE_HANDOFF)
    const mdWrite = await call('write', { file_path: 'artifacts/plan.md', content: '# R2' },
      () => { writeFileSync(join(root, 'artifacts', 'plan.md'), '# R2'); return success() })
    const htmlWrite = await call('write', { file_path: 'artifacts/plan.html', content: '<h1>R2</h1>' },
      () => { writeFileSync(join(root, 'artifacts', 'plan.html'), '<h1>R2</h1>'); return success() })
    const both = await call('present', { files: [{ path: 'artifacts/plan.html' }, { path: 'artifacts/plan.md' }] })
    const refusal = both.content.map(block => block.text ?? '').join('\n')
    assert.equal(both.isError, true, 'present must not republish a file whose update this turn was refused')
    assert.equal(both.error?.info?.code, 'TURN_DEADLINE_STALE_DELIVERABLE')
    assert.ok(!bodies.includes('present'), 'the stale delivery never reaches the present body')
    assert.match(refusal, /artifacts\/plan\.html was not updated in this turn/)
    assert.match(refusal, /2026-11-01T05:56:34\.000Z/, 'the refusal names the earlier version by its modification time')
    assert.doesNotMatch(refusal, /plan\.md was not/, 'the file written this turn is not reported as stale')
    assert.equal(mdWrite.isError, false, 'one final deliverable write still runs after the deadline')
    assert.equal(readFileSync(join(root, 'artifacts', 'plan.md'), 'utf8'), '# R2')
    assert.equal(htmlWrite.isError, true, 'a second write after the deadline is refused')
    assert.match(htmlWrite.content[0]?.text ?? '', /artifacts\/plan\.html was not written/)
    assert.equal(readFileSync(join(root, 'artifacts', 'plan.html'), 'utf8'), '<h1>R1</h1>')
    const fresh = await call('present', { files: [{ path: './artifacts/plan.md' }] })
    assert.equal(fresh.isError, false, 'the artifact written this turn can still be presented')
    assert.equal(started, 1, 'one tracked planner')
  } finally { rmSync(root, { recursive: true, force: true }) }
}

// The converge exit has the same final-only surface. The deadline-crossing write
// is the one final write; refused edits count, absolute and relative spellings
// name the same file, and a later successful write clears the mark.
{
  const root = mkdtempSync(join(tmpdir(), 'gotry-stale-converge-'))
  writeFileSync(join(root, 'notes.md'), 'old notes')
  const hooks = new Map<string, any>()
  let time = 0
  const agent = { id: 'stale-converge', ctx: { tools: { restrict: () => () => {} } },
    session: { id: 'stale-converge', header: { cwd: root }, snapshotEvents: () => [] } }
  installTurnDeadline({ tools: { schemas: () => [] }, on: (name: string, hook: unknown) => hooks.set(name, hook) } as unknown as Context,
    { now: () => time, fixedPolicy: { softMs: 5, hardMs: 10, exit: 'converge' } })
  const call = (name: string, args: Record<string, unknown>, body: () => Result = success): Promise<Result> =>
    hooks.get('tools/execute')({ token: Symbol(name), name, agent, arguments: args }, async () => body())
  const userTurn = () => hooks.get('session/event')({ id: agent.id }, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'summarize my notes' }] } })
  try {
    userTurn()
    time = 11
    const answer = await call('write', { file_path: 'answer.md', content: 'final' }, () => { writeFileSync(join(root, 'answer.md'), 'final'); return success() })
    assert.equal(answer.isError, false, 'the deadline-crossing write is the final write')
    const edit = await call('edit', { file_path: join(root, 'notes.md'), old_string: 'old', new_string: 'new' })
    assert.equal(edit.error?.info?.code, TURN_DEADLINE_EXHAUSTED)
    const stale = await call('present', { files: [{ path: 'notes.md' }] })
    assert.equal(stale.error?.info?.code, 'TURN_DEADLINE_STALE_DELIVERABLE', 'a refused edit makes present refuse the same file')
    const missing = await call('write', { file_path: 'other.md', content: 'x' })
    assert.equal(missing.isError, true)
    const absent = await call('present', { files: [{ path: join(root, 'other.md') }] })
    assert.match(absent.content[0]?.text ?? '', /other\.md was not written in this turn[^]*no file exists/)
    assert.equal((await call('present', { files: [{ path: 'answer.md' }] })).isError, false)
    // A new user message opens a new budget; a successful write there clears the mark.
    userTurn()
    assert.equal((await call('write', { file_path: 'notes.md', content: 'new notes' })).isError, false)
    assert.equal((await call('present', { files: [{ path: 'notes.md' }] })).isError, false)
  } finally { rmSync(root, { recursive: true, force: true }) }
}

// Real DSH pipeline with GoTry's consent gate, the approval service and a
// deterministic clock. Sessions publish appended events synchronously, as
// dsh-session's Session.append does; the answerer stands in for the user.
async function withApprovalPipeline(
  run: (pipeline: {
    root: string
    events: Array<{ type: string; data: unknown }>
    advance: (ms: number) => void
    search: (callId: string) => Promise<Result>
    searches: () => number
    asked: () => Promise<(outcome: 'allowed-once' | 'rejected') => void>
    started: () => number
  }) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'gotry-approval-wait-'))
  const runtimeCtx = new Context()
  runtimeCtx.provide('systemPrompt', { tools() {}, context() {}, getContextOrder: () => 0 })
  const tools = new ToolRuntime(runtimeCtx)
  new ApprovalService(runtimeCtx, { policy: 'ask' })
  let time = 0
  let searches = 0
  let started = 0
  const events: Array<{ type: string; seq: number; time: number; data: unknown }> = []
  const session = {
    id: 'approval-wait', header: { cwd: root },
    get seq() { return events.length },
    eventAt: (seq: number) => events[seq],
    snapshotEvents: () => [...events],
    append(type: string, data: unknown) {
      const event = { type, seq: events.length, time, data }
      events.push(event)
      runtimeCtx.emit('session/event', session as never, event as never)
      return event
    },
  }
  const mutableAgent = { id: 'approval-wait', ctx: runtimeCtx, session }
  const agent = mutableAgent as unknown as Agent
  const scope = createScope(runtimeCtx, agent)
  mutableAgent.ctx = scope.ctx
  installTurnDeadline(runtimeCtx, { stateRoot: root, now: () => time,
    startHandoff: async ticket => { started++; return { ...ticket, status: 'running', jobId: 'gotry-planning-1' } } })
  runtimeCtx.on('tools/pre-execute', createConsentGate({ access: () => 'ask', approval: approvalFromContext(runtimeCtx) }) as never)
  const answerers: Array<(decide: (outcome: 'allowed-once' | 'rejected') => void) => void> = []
  runtimeCtx.on('approval/request', () => new Promise(resolve => answerers.shift()?.(resolve)))
  tools.register(defineTool({
    name: 'gotry_session_search', description: 'Read-only account-session search',
    parameters: { from: { type: 'string' }, to: { type: 'string' }, date: { type: 'string' }, kind: { type: 'string' }, ui: { type: 'string' } },
    output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: 'flights' }] },
    async execute() { searches++; return { ok: true } },
  }))
  try {
    session.append('turn/start', { turn: 8 })
    session.append('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: deepMessageForDelivery() }] })
    await run({
      root, events,
      advance: ms => { time += ms },
      search: callId => tools.execute({ name: 'gotry_session_search', agent, callId: callId as never, signal: new AbortController().signal,
        arguments: { from: '迪拜', to: '香港', date: '2026-12-01', kind: 'flight', ui: 'gui' } }) as Promise<Result>,
      searches: () => searches,
      asked: () => new Promise(resolve => answerers.push(resolve)),
      started: () => started,
    })
  } finally {
    await scope.dispose()
    await runtimeCtx.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  }
}

// Turn 8 also waited 64 minutes for the user to approve gotry_session_search
// (10:00:53 → 11:05:06). DSH awaits that decision in tools/pre-execute
// (ToolRuntime.prepareExecution → consent gate → ApprovalService.request),
// before the tools/execute deadline gate, so the hour was charged to the turn
// and the approved call came back TURN_DEADLINE_HANDOFF without running.
await withApprovalPipeline(async ({ root, events, advance, search, searches, asked, started }) => {
  advance(27_000)
  const decision = asked()
  const approved = search('call_00_3gES')
  const decide = await decision
  advance(64 * 60_000 + 13_000)
  decide('allowed-once')
  const result = await approved
  assert.deepEqual(events.filter(event => event.type.startsWith('approval/')).map(event => event.type), ['approval/asked', 'approval/decided'])
  assert.equal(searches(), 1, `the call the user approved runs: ${JSON.stringify(result)}`)
  assert.equal(result.isError, false)
  assert.equal(existsSync(join(root, 'gotry-state', 'turn-handoffs')), false, "the user's decision time is not turn time")
  // The turn's own time still binds: 27 s were spent before the wait.
  advance(212_000)
  assert.equal((await search('call_in_budget')).isError, false, 'the budget left before the ask is intact')
  advance(2_000)
  const late = await search('call_late')
  assert.match(JSON.stringify(late), /TURN_DEADLINE_HANDOFF/, 'the deadline still fires on turn time')
  assert.equal(searches(), 2)
  assert.equal(started(), 1)
})

// An ask that starts after the budget is spent still counts: the approved call
// runs once, and the handoff follows it instead of discarding the approval.
await withApprovalPipeline(async ({ root, advance, search, searches, asked, started }) => {
  advance(241_000)
  const decision = asked()
  const approved = search('call_after_deadline')
  const decide = await decision
  advance(30_000)
  decide('allowed-once')
  const result = await approved
  assert.equal(searches(), 1, `an approved call is never discarded: ${JSON.stringify(result)}`)
  assert.equal(result.isError, false, 'its real result is kept')
  assert.match(JSON.stringify(result.additionalContexts), /TURN_DEADLINE_HANDOFF[^]*gotry-planning-1/, 'handoff guidance follows the approved call')
  assert.equal(readdirSync(join(root, 'gotry-state', 'turn-handoffs')).filter(name => name.endsWith('.json')).length, 1)
  // The site grant now covers the session; the next search is not approved anew.
  const repeated = await search('call_repeat')
  assert.match(JSON.stringify(repeated), /TURN_DEADLINE_HANDOFF/)
  assert.equal(searches(), 1, 'only the approved call gets the exception')
  assert.equal(started(), 1)
})

// Overlapping approvals pause the budget once, not once per request.
{
  const hooks = new Map<string, any>()
  let time = 0
  const agent = { id: 'overlap', ctx: { tools: { restrict: () => () => {} } }, session: { id: 'overlap', header: { cwd: tmpdir() }, snapshotEvents: () => [] } }
  installTurnDeadline({ tools: { schemas: () => [] }, on: (name: string, hook: unknown) => hooks.set(name, hook) } as unknown as Context,
    { now: () => time, fixedPolicy: { softMs: 100_000, hardMs: 240_000, exit: 'converge' } })
  const event = (type: string, data: unknown) => hooks.get('session/event')({ id: agent.id }, { type, data })
  const call = async () => (await hooks.get('tools/execute')({ token: Symbol('overlap'), name: 'search', agent }, async () => success()) as Result)
  event('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'plan a weekend' }] })
  time = 10_000
  event('approval/asked', { id: 'a1', toolName: 'search', callId: 'c1' })
  time = 20_000
  event('approval/asked', { id: 'a2', toolName: 'search', callId: 'c2' })
  time = 500_000
  assert.equal((await call()).isError, false, 'time with an approval open is not charged')
  time = 1_000_000
  event('approval/decided', { id: 'a1', outcome: 'rejected' })
  time = 2_000_000
  event('approval/decided', { id: 'a2', outcome: 'rejected' })
  time = 2_000_000 + 229_000
  assert.equal((await call()).isError, false, '10 s before the wait + 229 s after it is within 240 s')
  time = 2_000_000 + 231_000
  assert.equal((await call()).error?.info?.code, TURN_DEADLINE_EXHAUSTED, 'the overlapped wait is excluded once')
}

console.log('agent turn deadline tests: OK (routing→converge/handoff exits, ticket persistence, plugin-message discipline, lifecycle, final write and stale presents, user approval waits)')
