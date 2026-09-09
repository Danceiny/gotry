/**
 * Issue #289 native request proof.
 *
 * The earlier Claude Code candidate (provenance: Claude Code; recent attempts
 * returned 503 or were boundedly stopped) mounted dsh-llm-retry but never
 * consumed LlmRuntime.stream(), so its FixtureLlmAdapter.stream() was dead
 * code. This file is the smallest executable replacement: every attempt below
 * goes through the installed LlmRuntime -> LlmAdapter.stream() -> a real
 * 127.0.0.1 HTTP server, and every failure goes through the installed
 * dsh-llm-retry agent/request-error waterfall.
 *
 * Pinned acceptance for this proof:
 *   1. normal provider retry is finite and request-count bounded;
 *   2. 429 is retried, timeout is classified and reaches a stable terminal
 *      error without another request after the bound;
 *   3. aborting the real retry AbortSignal during backoff produces no started
 *      retry and no subsequent provider request;
 *   4. durable retry events carry the UI-visible retry index and limit.
 *
 * No real provider, credentials, browser, supplier, booking write, or shared
 * gotry-state is used. Run from ts/: npx tsx scripts/issue-289-model-retry-real-tests.ts
 */

import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

import { Context } from '@deepseek-ai/cordis'
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

type FailureCode = 'RATE_LIMIT' | 'TIMEOUT' | 'SERVER' | 'CONTEXT_WINDOW_EXCEEDED'
type ResponseSpec = { kind: 'ok' | 'failure'; code?: FailureCode; status?: number }
type SessionEvent = { type: string; data: any }

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

function session(id: string) {
  const events: SessionEvent[] = []
  return { id, events, append(type: string, data: unknown) { events.push({ type, data }) } }
}

function installSessionProjections(ctx: Context): void {
  let retryProjection: { init: () => any; apply: (state: any, event: any) => any } | undefined
  ctx.provide('sessionProjections', {
    register(spec: { key: string; init: () => any; apply: (state: any, event: any) => any }) {
      assert.equal(spec.key, 'llmRetry')
      retryProjection = spec
    },
    stateOf<T>(owner: { events: readonly SessionEvent[] }, key: string): T {
      assert.equal(key, 'llmRetry')
      assert.ok(retryProjection, 'installed retry projection is available')
      let state = retryProjection!.init()
      for (const event of owner.events) state = retryProjection!.apply(state, event)
      return state as T
    },
  })
}

interface RetryWorld {
  readonly ctx: Context
  readonly runtime: LlmRuntime
  readonly adapter: FixtureLlmAdapter
  readonly fixture: ProviderFixture
  readonly session: ReturnType<typeof session>
  readonly policy: ResolvedNormalRetryPolicy
  close(): Promise<void>
}

async function startWorld(sequence: readonly ResponseSpec[], policy: ResolvedNormalRetryPolicy, timeoutMs = 40): Promise<RetryWorld> {
  const ctx = new Context()
  installSessionProjections(ctx)
  ctx.provide('agents', { list: () => [] })
  ctx.provide('logger', { warn() {}, error() {} })
  const fixture = await startProviderFixture()
  fixture.setSequence(sequence)
  const adapter = new FixtureLlmAdapter(fixture.url, timeoutMs, policy)
  const runtime = new LlmRuntime(ctx)
  runtime.registerAdapter(['fixture'], adapter)
  applyLlmRetry(ctx, {}, { random: () => 0.5 })
  const activeSession = session('issue-289-loopback')
  return {
    ctx, runtime, adapter, fixture, session: activeSession, policy,
    async close() {
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

async function requestError(world: RetryWorld, failure: unknown, signal: AbortSignal): Promise<any> {
  const waterfall = (world.ctx as unknown as {
    waterfall(name: string, payload: unknown, next: () => Promise<unknown>): Promise<any>
  }).waterfall.bind(world.ctx)
  return waterfall('agent/request-error', {
    agent: { session: world.session }, turn: 1, step: 1, provider: 'fixture',
    failure, retryPolicy: world.policy, signal,
  }, () => Promise.resolve(undefined))
}

async function runAgentRequestLoop(world: RetryWorld, signal: AbortSignal): Promise<Terminal> {
  const request = {
    provider: 'fixture', model: 'fixture-model',
    messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'loopback retry proof' }] })],
    signal,
  }
  for (;;) {
    let finish: Extract<StreamChunk, { type: 'finish' }>['reason'] | undefined
    for await (const chunk of world.runtime.stream(request)) if (chunk.type === 'finish') finish = chunk.reason
    assert.ok(finish, 'LlmRuntime must produce a terminal finish chunk')
    if (finish.kind === 'stop') return 'completed'
    assert.ok(finish.kind === 'error' || finish.kind === 'aborted', `unexpected finish kind ${finish.kind}`)
    const action = await requestError(world, finish.failure, signal)
    if (signal.aborted || action?.kind !== 'retry') return signal.aborted ? 'cancelled' : 'error'
  }
}

async function finite429Proof(): Promise<void> {
  const world = await startWorld([
    { kind: 'failure', code: 'RATE_LIMIT', status: 429 },
    { kind: 'failure', code: 'RATE_LIMIT', status: 429 },
    { kind: 'ok' },
  ], normalPolicy({ maxRetries: 2 }))
  try {
    const terminal = await runAgentRequestLoop(world, new AbortController().signal)
    assert.equal(terminal, 'completed')
    assert.equal(world.fixture.requestCount, 3, '429 then success uses one initial request plus two retry requests')
    assert.equal(world.session.events.filter(event => event.type === 'llm/retry').length, 2)
    assert.equal(world.session.events.filter(event => event.type === 'llm/retry-started').length, 2)
    const retry = world.session.events.find(event => event.type === 'llm/retry')!.data
    assert.equal(retry.mode, 'normal')
    assert.equal(retry.maxRetries, 2)
    assert.equal(retry.retry, 1)
    assert.equal(retry.provider, 'fixture')
    assert.equal(retry.failure.code, 'RATE_LIMIT')
    assert.equal(retry.failure.status, 429)
    assert.equal(world.fixture.records[0]!.method, 'POST')
    assert.ok(world.fixture.records.every(record => record.url === '/v1/chat/completions'))
    console.log(`OK issue-289 429 requests=${world.fixture.requestCount} retries=2 terminal=${terminal}`)
  } finally {
    await world.close()
  }
}

async function timeoutTerminalProof(): Promise<void> {
  const world = await startWorld([{ kind: 'failure', code: 'TIMEOUT' }], normalPolicy({ maxRetries: 1 }), 20)
  try {
    const terminal = await runAgentRequestLoop(world, new AbortController().signal)
    assert.equal(terminal, 'error')
    assert.equal(world.fixture.requestCount, 2, 'timeout is retried once and then terminates')
    assert.equal(world.session.events.filter(event => event.type === 'llm/retry').length, 1)
    const beforeStable = world.fixture.requestCount
    const action = await requestError(world, { code: 'TIMEOUT', message: 'fixture request timed out', status: 408 }, new AbortController().signal)
    assert.equal(action, undefined, 'normal maxRetries terminal boundary falls through')
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.equal(world.fixture.requestCount, beforeStable, 'terminal timeout remains stable with no new request')
    console.log(`OK issue-289 timeout requests=${world.fixture.requestCount} retries=1 terminal=${terminal} stable=true`)
  } finally {
    await world.close()
  }
}

async function cancelBackoffProof(): Promise<void> {
  const world = await startWorld([{ kind: 'failure', code: 'RATE_LIMIT', status: 429 }], normalPolicy({ maxRetries: 5, initialDelayMs: 120, maxDelayMs: 120 }))
  try {
    const controller = new AbortController()
    const run = runAgentRequestLoop(world, controller.signal)
    await waitUntil(() => world.fixture.requestCount === 1 && world.session.events.some(event => event.type === 'llm/retry'))
    controller.abort()
    assert.equal(await run, 'cancelled')
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(world.fixture.requestCount, 1, 'abort during backoff prevents every follow-up request')
    assert.equal(world.session.events.filter(event => event.type === 'llm/retry-started').length, 0)
    console.log(`OK issue-289 cancel requests=${world.fixture.requestCount} started=0 terminal=cancelled`)
  } finally {
    await world.close()
  }
}

await finite429Proof()
await timeoutTerminalProof()
await cancelBackoffProof()
console.log('ISSUE #289 MODEL-RETRY REAL FIXTURE: LlmRuntime/adapter HTTP/retry waterfall/AbortSignal proof passed')
