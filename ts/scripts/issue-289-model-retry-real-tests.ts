/**
 * Issue #289 native request proof.
 *
 * Provenance: the earlier Claude Code candidate mounted dsh-llm-retry but
 * never consumed LlmRuntime.stream(); its FixtureLlmAdapter.stream() was dead
 * code. Claude's recent attempts returned 503 or were boundedly stopped. This
 * replacement drives the installed AgentLoop host, so the installed
 * dsh-llm-retry listener receives the real agent/request-error event and owns
 * the retry decision. Every provider attempt still goes through
 * LlmRuntime -> LlmAdapter.stream() -> a real 127.0.0.1 HTTP server.
 *
 * Pinned acceptance for this proof:
 *   1. normal provider retry is finite and request-count bounded;
 *   2. 429 is retried, timeout and server failure reach stable terminal
 *      errors without another request after the bound;
 *   3. cancelling the real AgentLoop during retry backoff produces no started
 *      retry and no subsequent provider request;
 *   4. durable retry events carry the UI-visible retry index and limit.
 *
 * No real provider, credentials, browser, supplier, booking write, or shared
 * gotry-state is used. Run from ts/:
 *   npx tsx scripts/issue-289-model-retry-real-tests.ts
 */

import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type AgentHandle } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import {
  LlmAdapter,
  LlmError,
  LlmRuntime,
  createUserMessage,
  type GenerateOptions,
  type ResolvedNormalRetryPolicy,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { apply as applyLlmRetry } from '@deepseek-ai/dsh-llm-retry'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

type FailureCode = 'RATE_LIMIT' | 'TIMEOUT' | 'SERVER' | 'CONTEXT_WINDOW_EXCEEDED'
type ResponseSpec = { kind: 'ok' | 'failure'; code?: FailureCode; status?: number }
type SessionEvent = ReturnType<Session['snapshotEvents']>[number]

interface ProviderFixture {
  readonly url: string
  readonly records: readonly { index: number; method: string; url: string; body: string }[]
  readonly requestCount: number
  setSequence(sequence: readonly ResponseSpec[]): void
  close(): Promise<void>
}

function statusFor(code: FailureCode): number {
  if (code === 'RATE_LIMIT') return 429
  if (code === 'TIMEOUT') return 408
  if (code === 'SERVER') return 503
  return 400
}

function startProviderFixture(): Promise<ProviderFixture> {
  let sequence: ResponseSpec[] = [{ kind: 'ok' }]
  const records: ProviderFixture['records'][number][] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const index = records.length
      records.push({ index, method: req.method ?? 'GET', url: req.url ?? '/', body: Buffer.concat(chunks).toString('utf8') })
      const spec = sequence[Math.min(index, sequence.length - 1)] ?? { kind: 'ok' }
      if (spec.kind === 'ok') {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
        res.end('data: {"choices":[{"delta":{"content":"fixture-ok"}}]}\n\ndata: [DONE]\n\n')
        return
      }
      if (spec.code === 'TIMEOUT') {
        // The adapter reads the body with its own timeout signal; this response
        // intentionally never ends, so the installed runtime sees TIMEOUT.
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
        res.write(': keep-alive\n\n')
        return
      }
      const code = spec.code ?? 'SERVER'
      const status = spec.status ?? statusFor(code)
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code, message: `fixture ${code}`, status } }))
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address !== 'object') {
        reject(new Error('loopback fixture did not bind'))
        return
      }
      resolve({
        url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
        records,
        get requestCount() { return records.length },
        setSequence(next) { sequence = [...next] },
        close: () => new Promise<void>((res, rej) => server.close(error => error ? rej(error) : res())),
      })
    })
  })
}

class FixtureLlmAdapter extends LlmAdapter {
  constructor(
    private readonly endpoint: string,
    private readonly timeoutMs: number,
    readonly policy: ResolvedNormalRetryPolicy,
  ) { super() }

  providerInfo(provider: string) { return { id: provider, name: 'loopback fixture' } }
  providerRetryPolicy(_provider: string): ResolvedRetryPolicy { return this.policy }
  resolveModel(provider: string, model: string) { return Promise.resolve({ provider, id: model, name: model }) }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer loopback-only' },
        body: JSON.stringify({ provider: options.provider, model: options.model, messages: options.messages }),
        signal,
      })
      const body = await response.text()
      if (!response.ok) {
        let error: { code?: string; message?: string; status?: number } = {}
        try { error = JSON.parse(body).error ?? {} } catch { /* preserve the HTTP status */ }
        throw new LlmError(error.message ?? `fixture HTTP ${response.status}`, error.code ?? 'SERVER', { status: error.status ?? response.status })
      }
      yield { type: 'text-delta', index: 0, text: body.includes('[DONE]') ? 'fixture-ok' : body }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } catch (error) {
      if (options.signal?.aborted) throw new LlmError('fixture request aborted', 'ABORTED', { cause: error })
      if (timeout.aborted) throw new LlmError('fixture request timed out', 'TIMEOUT', { cause: error, status: 408 })
      if (error instanceof LlmError) throw error
      throw new LlmError('fixture transport failure', 'TRANSPORT', { cause: error })
    }
  }
}

interface RetryWorld {
  readonly ctx: Context
  readonly adapter: FixtureLlmAdapter
  readonly fixture: ProviderFixture
  readonly agent: AgentHandle['agent']
  readonly handle: AgentHandle
  readonly policy: ResolvedNormalRetryPolicy
  close(): Promise<void>
}

async function startWorld(sequence: readonly ResponseSpec[], policy: ResolvedNormalRetryPolicy, timeoutMs = 40): Promise<RetryWorld> {
  const fixture = await startProviderFixture()
  fixture.setSequence(sequence)
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjection)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  await ctx.plugin(AgentRegistry)
  const adapter = new FixtureLlmAdapter(fixture.url, timeoutMs, policy)
  ctx.llm.registerAdapter(['fixture'], adapter)
  // This is the installed upstream plugin's real listener and projection;
  // AgentLoop below is the host that emits agent/request-error and consumes its
  // retry action. No GoTry retry layer is added here.
  applyLlmRetry(ctx, {}, { random: () => 0.5 })
  await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
  const handle = await ctx.agentLoop.createAgent(ctx, {
    sessionId: SessionId(`issue-289-loopback-${Date.now()}-${Math.random().toString(36).slice(2)}`),
    agentOptions: { provider: 'fixture', model: 'fixture-model' },
  })
  return {
    ctx,
    adapter,
    fixture,
    agent: handle.agent,
    handle,
    policy,
    async close() {
      await handle.dispose()
      await ctx.fiber.dispose()
      await fixture.close()
    },
  }
}

function normalPolicy(overrides: Partial<ResolvedNormalRetryPolicy> = {}): ResolvedNormalRetryPolicy {
  return {
    mode: 'normal', maxRetries: 2,
    retryableCodes: ['RATE_LIMIT', 'TIMEOUT', 'SERVER', 'TRANSPORT'],
    initialDelayMs: 5, maxDelayMs: 30, jitterRatio: 0,
    ...overrides,
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2))
  assert.ok(predicate(), `condition did not settle within ${timeoutMs}ms`)
}

type Terminal = 'completed' | 'error' | 'cancelled'

function eventsOf(world: RetryWorld): readonly SessionEvent[] {
  return world.agent.session.snapshotEvents()
}

function terminalOf(world: RetryWorld): Terminal {
  const end = [...eventsOf(world)].reverse().find(event => event.type === 'turn/end')
  assert.ok(end, 'AgentLoop must append a turn/end event')
  const reason = (end.data as { reason: { kind: string } }).reason.kind
  if (reason === 'completed') return 'completed'
  if (reason === 'aborted') return 'cancelled'
  if (reason === 'error') return 'error'
  throw new Error(`unexpected turn-end reason ${reason}`)
}

function retryEvents(world: RetryWorld): SessionEvent[] {
  return eventsOf(world).filter(event => event.type === 'llm/retry')
}

async function runAgentTurn(world: RetryWorld): Promise<Terminal> {
  world.agent.followup(createUserMessage({
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'loopback retry proof' }],
  }))
  await world.agent.whenIdle()
  return terminalOf(world)
}

async function finite429Proof(): Promise<void> {
  const world = await startWorld([
    { kind: 'failure', code: 'RATE_LIMIT', status: 429 },
    { kind: 'failure', code: 'RATE_LIMIT', status: 429 },
    { kind: 'ok' },
  ], normalPolicy({ maxRetries: 2 }))
  try {
    const terminal = await runAgentTurn(world)
    assert.equal(terminal, 'completed')
    assert.equal(world.fixture.requestCount, 3, '429 then success uses one initial request plus two retry requests')
    assert.equal(retryEvents(world).length, 2)
    assert.equal(eventsOf(world).filter(event => event.type === 'llm/retry-started').length, 2)
    const retry = retryEvents(world)[0]!.data as { mode: string; maxRetries: number; retry: number; provider: string; failure: { code: string; status: number } }
    assert.equal(retry.mode, 'normal')
    assert.equal(retry.maxRetries, 2)
    assert.equal(retry.retry, 1)
    assert.equal(retry.provider, 'fixture')
    assert.equal(retry.failure.code, 'RATE_LIMIT')
    assert.equal(retry.failure.status, 429)
    assert.equal(world.fixture.records[0]!.method, 'POST')
    assert.ok(world.fixture.records.every(record => record.url === '/v1/chat/completions'))
    console.log(`OK issue-289 host 429 requests=${world.fixture.requestCount} retries=2 terminal=${terminal}`)
  } finally {
    await world.close()
  }
}

async function timeoutTerminalProof(): Promise<void> {
  const world = await startWorld([{ kind: 'failure', code: 'TIMEOUT' }], normalPolicy({ maxRetries: 1 }), 20)
  try {
    const terminal = await runAgentTurn(world)
    assert.equal(terminal, 'error')
    assert.equal(world.fixture.requestCount, 2, 'timeout is retried once and then terminates')
    assert.equal(retryEvents(world).length, 1)
    const beforeStable = world.fixture.requestCount
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.equal(world.fixture.requestCount, beforeStable, 'terminal timeout remains stable with no new request')
    console.log(`OK issue-289 host timeout requests=${world.fixture.requestCount} retries=1 terminal=${terminal} stable=true`)
  } finally {
    await world.close()
  }
}

async function serverTerminalProof(): Promise<void> {
  const world = await startWorld([{ kind: 'failure', code: 'SERVER', status: 503 }], normalPolicy({ maxRetries: 1 }))
  try {
    const terminal = await runAgentTurn(world)
    assert.equal(terminal, 'error')
    assert.equal(world.fixture.requestCount, 2, 'server failure is retried once and then terminates')
    assert.equal(retryEvents(world).length, 1)
    const beforeStable = world.fixture.requestCount
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.equal(world.fixture.requestCount, beforeStable, 'terminal server failure remains stable with no new request')
    console.log(`OK issue-289 host server requests=${world.fixture.requestCount} retries=1 terminal=${terminal} stable=true`)
  } finally {
    await world.close()
  }
}

async function cancelBackoffProof(): Promise<void> {
  const world = await startWorld([{ kind: 'failure', code: 'RATE_LIMIT', status: 429 }], normalPolicy({ maxRetries: 5, initialDelayMs: 120, maxDelayMs: 120 }))
  try {
    const run = runAgentTurn(world)
    await waitUntil(() => world.fixture.requestCount === 1 && retryEvents(world).length === 1)
    world.agent.cancel({ kind: 'user' }, { keepInbox: true })
    assert.equal(await run, 'cancelled')
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(world.fixture.requestCount, 1, 'abort during backoff prevents every follow-up request')
    assert.equal(eventsOf(world).filter(event => event.type === 'llm/retry-started').length, 0)
    console.log(`OK issue-289 host cancel requests=${world.fixture.requestCount} started=0 terminal=cancelled`)
  } finally {
    await world.close()
  }
}

await finite429Proof()
await timeoutTerminalProof()
await serverTerminalProof()
await cancelBackoffProof()
console.log('ISSUE #289 MODEL-RETRY REAL FIXTURE: installed AgentLoop/LlmRuntime/adapter HTTP/dsh retry/AbortSignal proof passed')
