import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
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
    assert.match(text, /约 1 小时/, 'ETA label mirrors the S5 promise')
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
rmSync(handoffRoot, { recursive: true, force: true })

console.log('agent turn deadline tests: OK (routing→converge/handoff exits, ticket persistence, plugin-message discipline, lifecycle)')
