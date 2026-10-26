/**
 * Proof tests for the gateway chat-completions LLM plugin
 * (dsh-llm-gateway-chat.js): wire dialect against a mock OpenAI-style
 * chat/completions server, patch wiring, and provider selection.
 *
 * Run: npx tsx scripts/booking-copilot-gateway-chat-adapter-tests.ts
 */
import assert from 'node:assert/strict'
import { createServer, type RequestListener, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

/**
 * dsh-llm-gateway-chat.js is plain JavaScript without declarations, so the
 * proof declares the surface it drives. Emitted chunks use the harness's own
 * StreamChunk union, which keeps the chunk assertions checked against the
 * real contract.
 */
interface GatewayChatDependencies {
  resolveConnection(): { baseURL: string; models: readonly string[] }
  resolveApiKey(): Promise<string>
  providerName: string
  __captured?: unknown
}

interface WireContentBlock {
  type: string
  [field: string]: unknown
}

interface GatewayStreamOptions {
  provider: string
  model: string
  reasoningEffort?: string
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: WireContentBlock[] }>
  tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  maxTokens?: number
}

interface GatewayModelInfo {
  provider: string
  id: string
  name: string
  context: { contextWindow: number }
  reasoning: { efforts: Array<{ id: string; name: string; description?: string }> }
}

interface GatewayChatAdapterInstance {
  stream(options: GatewayStreamOptions): AsyncGenerator<StreamChunk>
  resolveModel(provider: string, model: string): Promise<GatewayModelInfo>
  prepareCall(provider: string, model: string): Promise<{ model: GatewayModelInfo; stream: (options: GatewayStreamOptions) => AsyncGenerator<StreamChunk> }>
}

interface GatewayChatModule {
  GatewayChatAdapter: new (dependencies: GatewayChatDependencies) => GatewayChatAdapterInstance
}

/** A chat-completions request body as the mock server receives it. */
interface WireRequest {
  model: string
  messages: Array<{ role: string; content?: unknown; tool_calls?: Array<{ id: string }>; tool_call_id?: string }>
  tools?: Array<{ type: string; function: { name: string } }>
  stream?: boolean
  stream_options?: unknown
  thinking?: unknown
  reasoning_effort?: string
}

// A string-typed specifier keeps TypeScript from resolving the undeclared JS
// module; GatewayChatModule above is the surface this proof relies on.
const GATEWAY_CHAT_MODULE: string = '../src/booking-surface/dsh-llm-gateway-chat.js'
const { GatewayChatAdapter }: GatewayChatModule = await import(GATEWAY_CHAT_MODULE)
const { buildDshEmbeddedBookingPatch, resolveRealRunPortConfig } = await import('../src/booking-surface/dsh-planner.ts')

type ChunkOf<T extends StreamChunk['type']> = Extract<StreamChunk, { type: T }>

function chunksOf<T extends StreamChunk['type']>(chunks: readonly StreamChunk[], type: T): ChunkOf<T>[] {
  return chunks.filter((chunk): chunk is ChunkOf<T> => chunk.type === type)
}

function firstChunk<T extends StreamChunk['type']>(chunks: readonly StreamChunk[], type: T): ChunkOf<T> {
  const [chunk] = chunksOf(chunks, type)
  assert.ok(chunk, `expected a ${type} chunk`)
  return chunk
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

function sse(res: ServerResponse, frames: readonly string[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const frame of frames) res.write(frame)
  res.end('data: [DONE]\n\n')
}

async function withMockServer<T>(handler: RequestListener, run: (port: number) => Promise<T>): Promise<T> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  try {
    const address = server.address()
    assert.ok(address !== null && typeof address === 'object', 'mock server listens on a TCP port')
    return await run(address.port)
  } finally {
    server.close()
  }
}

function adapterFor(port: number, captured?: unknown): GatewayChatAdapterInstance {
  return new GatewayChatAdapter({
    resolveConnection: () => ({ baseURL: `http://127.0.0.1:${port}/v1`, models: [] }),
    resolveApiKey: async () => 'test-only-key',
    providerName: 'Gateway Chat',
    ...(captured !== undefined ? { __captured: captured } : {}),
  })
}

// 1. A tool-calling stream translates to harness chunks: text block, tool-call
//    accumulation across deltas, deferred block-ends, usage, and tool-calls finish.
{
  const requests: WireRequest[] = []
  const chunks = await withMockServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      requests.push(JSON.parse(body))
      sse(res, [
        'data: {"choices":[{"delta":{"role":"assistant","content":"Let me search"}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"booking_search_hotels","arguments":"{\\"input\\":"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"destination\\":\\"Osaka\\"}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120,"prompt_tokens_details":{"cached_tokens":40},"completion_tokens_details":{"reasoning_tokens":5}}}\n\n',
      ])
    })
  }, async (port) => {
    const out: StreamChunk[] = []
    for await (const chunk of adapterFor(port).stream({
      provider: 'gateway-chat',
      model: 'deepseek-flash',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'planner system prompt' }] },
        { role: 'user', content: [{ type: 'text', text: 'hotels in Osaka' }] },
      ],
      tools: [{ name: 'booking_search_hotels', description: 'search hotels', parameters: { type: 'object', properties: {} } }],
      maxTokens: 16_384,
    })) out.push(chunk)
    return out
  })

  assert.equal(requests.length, 1)
  assert.equal(requests[0].model, 'deepseek-flash')
  assert.deepEqual(requests[0].messages.map((m) => m.role), ['system', 'user'])
  assert.equal(requests[0].tools?.[0].type, 'function')
  assert.equal(requests[0].tools?.[0].function.name, 'booking_search_hotels')
  assert.equal(requests[0].stream, true)
  assert.deepEqual(requests[0].stream_options, { include_usage: true })
  // The harness profile runs the planner with thinking enabled at high effort
  // (rc.1 wire parity); dropping these fields measurably degrades the model's
  // adherence to the planner's intent rules.
  assert.deepEqual(requests[0].thinking, { type: 'enabled' })
  assert.equal(requests[0].reasoning_effort, 'high')

  const kinds = chunks.map((c) => c.type)
  assert.deepEqual(kinds, ['block-start', 'text-delta', 'block-start', 'tool-call-delta', 'tool-call-delta', 'block-end', 'block-end', 'usage', 'finish'])
  const text = firstChunk(chunks, 'text-delta')
  assert.equal(text.text, 'Let me search')
  const toolDelta = chunksOf(chunks, 'tool-call-delta')
  assert.equal(toolDelta[0].id, 'call_1')
  assert.equal(toolDelta[0].name, 'booking_search_hotels')
  assert.equal(toolDelta.map((c) => c.argumentsDelta).join(''), '{"input":{"destination":"Osaka"}')
  const ends = chunksOf(chunks, 'block-end')
  assert.equal(ends[0].block.type, 'text')
  const toolBlock = ends[1].block
  assert.ok(toolBlock.type === 'tool-call', 'the second block closes the tool call')
  assert.equal(toolBlock.arguments, '{"input":{"destination":"Osaka"}')
  const usage = firstChunk(chunks, 'usage')
  assert.equal(usage.usage.inputTokens, 60, 'cache reads subtract from prompt tokens')
  assert.equal(usage.usage.outputTokens, 20)
  assert.equal(usage.usage.totalTokens, 120)
  assert.equal(usage.usage.cacheReadTokens, 40)
  assert.equal(usage.usage.reasoningTokens, 5)
  const finish = firstChunk(chunks, 'finish')
  assert.deepEqual(finish.reason, { kind: 'tool-calls' })
}

// 2. Tool-result history round-trips as `role:"tool"` wire messages.
{
  const requests: WireRequest[] = []
  await withMockServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      requests.push(JSON.parse(body))
      sse(res, [
        'data: {"choices":[{"delta":{"content":"done"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      ])
    })
  }, async (port) => {
    const out: StreamChunk[] = []
    for await (const chunk of adapterFor(port).stream({
      provider: 'gateway-chat',
      model: 'deepseek-flash',
      reasoningEffort: 'off',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hotels in Osaka' }] },
        { role: 'assistant', content: [{ type: 'tool-call', id: 'call_9', name: 'booking_search_hotels', arguments: '{"input":{}}' }] },
        { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_9', content: [{ type: 'text', text: '598 hotels' }] }] },
      ],
    })) out.push(chunk)
    return out
  })
  assert.deepEqual(requests[0].thinking, { type: 'disabled' }, 'reasoningEffort=off maps to thinking disabled')
  assert.equal(requests[0].reasoning_effort, undefined, 'off never crosses the wire as an effort')
  const roles = requests[0].messages.map((m) => m.role)
  assert.deepEqual(roles, ['user', 'assistant', 'tool'])
  assert.equal(requests[0].messages[1].tool_calls?.[0].id, 'call_9')
  assert.equal(requests[0].messages[2].tool_call_id, 'call_9')
  assert.equal(requests[0].messages[2].content, '598 hotels')
}

// 3. HTTP failure statuses map to typed LlmError codes.
{
  await withMockServer((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end('{"error":"bad key"}')
  }, async (port) => {
    await assert.rejects(
      () => adapterFor(port).stream({ provider: 'gateway-chat', model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }).next(),
      (error) => errorCode(error) === 'AUTH',
    )
  })
}

// 4. A stream that dies before [DONE] is STREAM_CLOSED, never a silent success.
{
  await withMockServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')
    res.end()
  }, async (port) => {
    await assert.rejects(
      () => adapterFor(port).stream({ provider: 'gateway-chat', model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }).next(),
      () => true,
    ).catch((error) => {
      // first next() may surface the text-delta fine; the failure lands on the
      // following tick — drain to the throw.
    })
    let saw = false
    try {
      for await (const _chunk of adapterFor(port).stream({ provider: 'gateway-chat', model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] })) { void _chunk }
    } catch (error) {
      saw = errorCode(error) === 'STREAM_CLOSED'
    }
    assert.ok(saw, 'a truncated stream must surface STREAM_CLOSED')
  })
}

// 4b. Exact model metadata satisfies the harness INVALID_MODEL_INFO gate
//     (provider/id/name required) and prepareCall returns the { model } shape.
{
  const adapter = adapterFor(1)
  const info = await adapter.resolveModel('gateway-chat', 'deepseek-flash')
  assert.equal(info.provider, 'gateway-chat')
  assert.equal(info.id, 'deepseek-flash')
  assert.equal(info.name, 'deepseek-flash')
  assert.ok(info.context.contextWindow > 0)
  assert.ok(info.reasoning.efforts.some((e) => e.id === 'off'))
  const prepared = await adapter.prepareCall('gateway-chat', 'deepseek-flash')
  assert.equal(prepared.model.id, 'deepseek-flash')
  assert.equal(typeof prepared.stream, 'function')
}

// 5. The patch renders both plugin inserts: the typed tools plugin and the
//    gateway chat-completions LLM plugin.
{
  const patch = buildDshEmbeddedBookingPatch('/tools/plugin.js', '/llm/gateway.js')
  assert.match(patch, /- id: gotry-embedded-booking\n/)
  assert.match(patch, /name: '\/tools\/plugin\.js'/)
  assert.match(patch, /- id: llm-gateway-chat\n/)
  assert.match(patch, /name: '\/llm\/gateway\.js'/)
  const minimal = buildDshEmbeddedBookingPatch('/tools/plugin.js')
  assert.match(minimal, /gotry-embedded-booking/)
  assert.doesNotMatch(minimal, /llm-gateway-chat/)
}

// 6. Provider selection: DEEPSEEK_PROVIDER rides the child env and selects the
//    gateway route without an explicit option.
{
  const resolved = resolveRealRunPortConfig({
    env: {
      DEEPSEEK_API_KEY: 'k',
      DEEPSEEK_BASE_URL: 'http://gw/v1',
      DEEPSEEK_MODEL: 'deepseek-flash',
      DEEPSEEK_PROVIDER: 'gateway-chat',
    },
  })
  assert.equal(resolved.provider, 'gateway-chat')
  assert.equal(resolved.childEnv.DEEPSEEK_PROVIDER, 'gateway-chat')
  const fallback = resolveRealRunPortConfig({
    env: {
      DEEPSEEK_API_KEY: 'k',
      DEEPSEEK_MODEL: 'deepseek-flash',
    },
  })
  assert.equal(fallback.provider, 'deepseek-official')
  assert.equal(fallback.childEnv.DEEPSEEK_PROVIDER, undefined)
}

console.log('BOOKING COPILOT GATEWAY CHAT ADAPTER PROOF: wire dialect/tool round-trip/status mapping/patch wiring/provider selection OK')
