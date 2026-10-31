/**
 * Credential custody of the planner children (AaaS, docs/rfc/aaas-rfc.md §4.8; threat S-18).
 *
 * A planner child is where untrusted model output steers a process that holds a bearer credential. The broker keeps the
 * upstream key and base URL in the parent and gives each planner process tree a short-lived loopback ticket instead.
 * These checks prove what the ticket can and cannot do, that the real key never reaches a child, that a broker in front
 * of a real dsh run still produces a decision, and that measured spend lands on the tenant whose ticket asked.
 *
 * Offline: the "upstream" is a local HTTP server, the clock is a number the suite moves by hand, and the one real-dsh
 * check talks to that local server only.
 *
 *   B  the broker: forwarding, refusals, limits, redirects, upstream failures, streaming, metering, lifecycle
 *   C  child custody: what the planner does with the environment, and a real dsh run through the broker
 *   D  tenants: measured usage is charged to the tenant whose invocation asked, and to no one else
 *
 * Run: cd ts && npx tsx scripts/tenant-egress-credentials-tests.ts
 */

import assert from 'node:assert/strict'
import { connect, type Socket } from 'node:net'
import { request as httpRequest, createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { createDshEmbeddedBookingPlanner, createRealRunPort, plannerChildEnvironment, resolveRealRunPortConfig, type DshEmbeddedBookingPlannerOptions } from '../src/booking-surface/dsh-planner.ts'
import { ManagedDshRunPort } from '../src/booking-surface/managed-dsh-run-port.ts'
import type { BookingCopilotTaskState } from '../src/booking-surface/runtime.ts'
import { createDshTenantPlannerProvider } from '../src/booking-surface/startup.ts'
import { LlmCredentialBroker, startLlmCredentialBroker, type LlmUsageReport } from '../src/tenant-seam/llm-broker.ts'
import { MODEL, ROOMY, makeFleet, makePlanner, makeService, tenantOf, userTurn } from './tenant-seam-test-kit.ts'

const REAL_KEY = 'sk-REAL-upstream-key-must-never-reach-a-child'

let passed = 0
const only = process.env.GOTRY_TEST_ONLY
async function check(label: string, assertion: () => void | Promise<void>): Promise<void> {
  if (only && !label.startsWith(only)) return
  await assertion()
  passed += 1
  console.log(`  ok - ${label}`)
}

// ---- a fake upstream ------------------------------------------------------------------------

interface Seen { method: string; url: string; headers: IncomingHttpHeaders; body: string }
interface Upstream { url: string; seen: Seen[]; close(): Promise<void> }

async function readText(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

async function upstream(handler: (req: IncomingMessage, res: ServerResponse, seen: Seen) => void | Promise<void>): Promise<Upstream> {
  const seen: Seen[] = []
  const server: Server = createServer((req, res) => {
    void (async () => {
      const entry: Seen = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: await readText(req) }
      seen.push(entry)
      await handler(req, res, entry)
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as { port: number }).port
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}

const USAGE = { prompt_tokens: 3_000, completion_tokens: 500, total_tokens: 3_500, prompt_tokens_details: { cached_tokens: 1_000 } }
const sseFrames = (...frames: unknown[]): string => `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`

function replySse(res: ServerResponse, body: string): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end(body)
}

const okStream = (res: ServerResponse): void => replySse(res, sseFrames(
  { choices: [{ delta: { role: 'assistant', content: 'hello' } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }], usage: USAGE },
))

interface GatewayAdapter { stream(options: unknown): AsyncGenerator<{ type: string; usage?: unknown }> }

/** The chat-completions adapter the planner child runs, pointed at a ticket: the same code, not a stand-in. */
async function gatewayAdapter(ticket: { baseUrl: string; token: string }): Promise<GatewayAdapter> {
  const moduleSpecifier: string = '../src/booking-surface/dsh-llm-gateway-chat.js'
  const { GatewayChatAdapter } = await import(moduleSpecifier) as { GatewayChatAdapter: new (config: unknown) => GatewayAdapter }
  return new GatewayChatAdapter({ resolveConnection: () => ({ baseURL: ticket.baseUrl, models: [] }), resolveApiKey: async () => ticket.token, providerName: 'Gateway Chat' })
}

const brokers: LlmCredentialBroker[] = []
const upstreams: Upstream[] = []
let clock = 1_000_000

async function setup(handler: Parameters<typeof upstream>[0] = (_req, res) => okStream(res), options: Partial<ConstructorParameters<typeof LlmCredentialBroker>[0]> = {}, base = '/v1') {
  const up = await upstream(handler)
  upstreams.push(up)
  const broker = await startLlmCredentialBroker({ upstreamBaseUrl: `${up.url}${base}`, upstreamApiKey: REAL_KEY, now: () => clock, ...options })
  brokers.push(broker)
  return { up, broker }
}

async function chat(baseUrl: string, token: string, init: { body?: string; headers?: Record<string, string>; path?: string; method?: string } = {}): Promise<{ status: number; text: string; headers: Headers }> {
  const response = await fetch(`${baseUrl}${init.path ?? '/chat/completions'}`, {
    method: init.method ?? 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers },
    ...((init.method ?? 'POST') === 'POST' ? { body: init.body ?? JSON.stringify({ model: 'm', messages: [] }) } : {}),
  })
  return { status: response.status, text: await response.text(), headers: response.headers }
}

async function code(reply: { text: string }): Promise<string | undefined> {
  try { return (JSON.parse(reply.text) as { error?: { code?: string } }).error?.code } catch { return undefined }
}

// ---- B: the broker --------------------------------------------------------------------------------

console.log('B  the broker')

await check('B1 it refuses to be built wrong: a relative or non-http URL, URL credentials, no key, a bad number or a path that is not plain', async () => {
  const good = { upstreamBaseUrl: 'http://127.0.0.1:1/v1', upstreamApiKey: REAL_KEY }
  for (const bad of [{ upstreamBaseUrl: '/v1' }, { upstreamBaseUrl: 'ftp://x/v1' }, { upstreamBaseUrl: 'https://user:pw@x/v1' }, { upstreamApiKey: '' }, { ticketTtlMs: 0 }, { maxRequestsPerTicket: -1 }, { maxRequestBytes: Number.NaN }, { upstreamTimeoutMs: 0 }, { allowedPaths: ['chat'] }, { allowedPaths: ['/a/../b'] }, { allowedPaths: ['//x'] }]) {
    assert.throws(() => new LlmCredentialBroker({ ...good, ...bad }), RangeError, JSON.stringify(bad))
  }
})

await check('B2 tickets exist only while it runs; each is a distinct random bearer, and the address is loopback', async () => {
  const idle = new LlmCredentialBroker({ upstreamBaseUrl: 'http://127.0.0.1:1/v1', upstreamApiKey: REAL_KEY })
  assert.throws(() => idle.issue(), /llm_broker_not_running/)
  const { broker } = await setup()
  const [a, b] = [broker.issue(), broker.issue()]
  assert.notEqual(a.token, b.token)
  assert.match(a.token, /^gtk-[A-Za-z0-9_-]{43}$/)
  assert.match(a.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/)
  assert.ok(!a.token.includes(REAL_KEY) && !a.baseUrl.includes(REAL_KEY))
  const closing = await startLlmCredentialBroker({ upstreamBaseUrl: 'http://127.0.0.1:1/v1', upstreamApiKey: REAL_KEY })
  await closing.close()
  assert.throws(() => closing.issue(), /llm_broker_not_running/)
})

await check('B3 a request is forwarded with the real key and nothing of the child\'s: the ticket, cookies, other keys, tenant headers and the query are dropped', async () => {
  const { up, broker } = await setup()
  const ticket = broker.issue()
  const body = JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }], stream: true })
  const reply = await chat(ticket.baseUrl, ticket.token, {
    body,
    path: '/chat/completions?debug=1',
    headers: { cookie: 'sid=secret', 'x-api-key': 'child-key', 'x-forwarded-for': '9.9.9.9', 'x-tenant': 't-victim', 'x-extra': 'x', accept: 'text/event-stream' },
  })
  assert.equal(reply.status, 200)
  assert.equal(up.seen.length, 1)
  const seen = up.seen[0]!
  assert.equal(seen.headers.authorization, `Bearer ${REAL_KEY}`)
  assert.equal(seen.url, '/v1/chat/completions', 'the path is the fixed upstream path, with no query')
  assert.equal(seen.body, body)
  assert.equal(seen.headers['content-type'], 'application/json')
  assert.equal(seen.headers.accept, 'text/event-stream')
  for (const dropped of ['cookie', 'x-api-key', 'x-forwarded-for', 'x-tenant', 'x-extra']) assert.equal(seen.headers[dropped], undefined, `${dropped} is not forwarded`)
  assert.ok(!JSON.stringify(seen.headers).includes(ticket.token), 'the ticket never reaches the upstream')
  assert.ok(!reply.text.includes(REAL_KEY) && !JSON.stringify([...reply.headers]).includes(REAL_KEY), 'nothing sent back to the child carries the key')
})

await check('B4 the upstream path is built the way the adapter builds its own, whatever the base looks like', async () => {
  for (const [base, expected] of [['/v1', '/v1/chat/completions'], ['', '/v1/chat/completions'], ['/gateway/v1', '/gateway/v1/chat/completions'], ['/gateway', '/gateway/v1/chat/completions'], ['/v1/', '/v1/chat/completions']] as const) {
    const { up, broker } = await setup(undefined, {}, base)
    const ticket = broker.issue()
    assert.equal((await chat(ticket.baseUrl, ticket.token)).status, 200)
    assert.equal(up.seen[0]!.url, expected, `base "${base}"`)
  }
})

await check('B5 a stream is relayed as it arrives, not held until the end', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const { broker } = await setup(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n')
    await gate
    res.end('data: {"choices":[{"delta":{"content":"second"}}]}\n\ndata: [DONE]\n\n')
  })
  const ticket = broker.issue()
  const response = await fetch(`${ticket.baseUrl}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${ticket.token}`, 'content-type': 'application/json' }, body: '{"model":"m"}' })
  const reader = response.body!.getReader()
  const first = await Promise.race([reader.read(), sleep(3_000).then(() => 'late' as const)])
  assert.notEqual(first, 'late', 'the first frame arrived while the upstream was still holding the rest')
  assert.match(new TextDecoder().decode((first as ReadableStreamReadResult<Uint8Array>).value), /first/)
  release()
  let rest = ''
  for (let part = await reader.read(); !part.done; part = await reader.read()) rest += new TextDecoder().decode(part.value)
  assert.match(rest, /second/)
})

await check('B6 a request without a valid ticket never reaches the upstream: none, a wrong one, the real key, a revoked one, an expired one', async () => {
  const { up, broker } = await setup()
  const live = broker.issue()
  const revoked = broker.issue()
  revoked.revoke()
  revoked.revoke()
  const expiring = broker.issue({ ttlMs: 1_000 })
  clock += 1_001
  const attempts: Array<[string, Response]> = []
  for (const [label, headers] of [
    ['no authorization', {}],
    ['malformed scheme', { authorization: `Token ${live.token}` }],
    ['a wrong ticket', { authorization: `Bearer gtk-${'A'.repeat(43)}` }],
    ['the real key', { authorization: `Bearer ${REAL_KEY}` }],
    ['a revoked ticket', { authorization: `Bearer ${revoked.token}` }],
    ['an expired ticket', { authorization: `Bearer ${expiring.token}` }],
    ['an oversized token', { authorization: `Bearer gtk-${'A'.repeat(500)}` }],
  ] as Array<[string, Record<string, string>]>) {
    attempts.push([label, await fetch(`${live.baseUrl}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' })])
  }
  for (const [label, response] of attempts) {
    assert.equal(response.status, 401, label)
    assert.equal(await code({ text: await response.text() }), 'ticket_invalid', label)
  }
  assert.equal(up.seen.length, 0)
  assert.equal((await chat(live.baseUrl, live.token)).status, 200, 'the live ticket is unaffected by the refusals')
})

await check('B7 only POST to an allow-listed path is carried; anything else is refused without a ticket check changing the answer', async () => {
  const { up, broker } = await setup()
  const ticket = broker.issue()
  assert.equal((await chat(ticket.baseUrl, ticket.token, { method: 'GET' })).status, 405)
  for (const path of ['/models', '/chat/completions/extra', '/../chat/completions', '/chat//completions', '/embeddings', '']) {
    const reply = await fetch(`${ticket.baseUrl}${path}`, { method: 'POST', headers: { authorization: `Bearer ${ticket.token}` }, body: '{}' })
    assert.ok(reply.status === 404, `${JSON.stringify(path)} -> ${reply.status}`)
  }
  const outside = await fetch(ticket.baseUrl.replace('/v1', '/other/chat/completions'), { method: 'POST', headers: { authorization: `Bearer ${ticket.token}` }, body: '{}' })
  assert.equal(outside.status, 404)
  assert.equal(up.seen.length, 0)
  const wider = await setup(undefined, { allowedPaths: ['/chat/completions', '/messages'] })
  const t2 = wider.broker.issue()
  assert.equal((await chat(t2.baseUrl, t2.token, { path: '/messages' })).status, 200)
  assert.equal(wider.up.seen[0]!.url, '/v1/messages')
})

await check('B8 a ticket makes a bounded number of requests, a bounded number at once, and a bounded body', async () => {
  const limited = await setup(undefined, { maxRequestsPerTicket: 3 })
  const t1 = limited.broker.issue()
  for (let i = 0; i < 3; i += 1) assert.equal((await chat(t1.baseUrl, t1.token)).status, 200)
  const exhausted = await chat(t1.baseUrl, t1.token)
  assert.equal(exhausted.status, 429)
  assert.equal(await code(exhausted), 'ticket_exhausted')
  assert.equal(limited.up.seen.length, 3)
  const stranger = await setup()
  assert.equal((await chat(t1.baseUrl, stranger.broker.issue().token)).status, 401, 'a ticket works only with the broker that issued it')

  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const busy = await setup(async (_req, res) => { await gate; okStream(res) }, { maxConcurrentPerTicket: 2 })
  const t2 = busy.broker.issue()
  const held = [chat(t2.baseUrl, t2.token), chat(t2.baseUrl, t2.token)]
  while (busy.up.seen.length < 2) await sleep(5)
  const refused = await chat(t2.baseUrl, t2.token)
  assert.equal(refused.status, 429)
  assert.equal(await code(refused), 'ticket_busy')
  release()
  assert.deepEqual((await Promise.all(held)).map((reply) => reply.status), [200, 200])

  const small = await setup(undefined, { maxRequestBytes: 1_024 })
  const t3 = small.broker.issue()
  const declared = await chat(t3.baseUrl, t3.token, { body: JSON.stringify({ model: 'm', pad: 'x'.repeat(2_048) }) })
  assert.equal(declared.status, 413)
  const chunked = await new Promise<number>((resolve, reject) => {
    const url = new URL(`${t3.baseUrl}/chat/completions`)
    const req = httpRequest({ host: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { authorization: `Bearer ${t3.token}`, 'content-type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)) })
    req.on('error', reject)
    req.write('{"model":"m","pad":"')
    req.write('x'.repeat(2_048))
    req.end('"}')
  })
  assert.equal(chunked, 413, 'a body with no declared length is cut off at the cap too')
  assert.equal(small.up.seen.length, 0)
})

await check('B9 a redirect is a failure: the key is never sent to wherever it points', async () => {
  const elsewhere = await upstream((_req, res) => okStream(res))
  upstreams.push(elsewhere)
  const { broker } = await setup((_req, res) => { res.writeHead(302, { location: `${elsewhere.url}/stolen` }); res.end() })
  const ticket = broker.issue()
  const reply = await chat(ticket.baseUrl, ticket.token)
  assert.equal(reply.status, 502)
  assert.equal(await code(reply), 'upstream_redirect_refused')
  assert.equal(elsewhere.seen.length, 0)
})

await check('B10 the upstream\'s failures reach the child as failures: mapped errors, unreachable, silent, and cut mid-stream; and none of its own headers reach the child', async () => {
  const errors = await setup((_req, res) => { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7', 'set-cookie': 'x=1', 'x-internal': 'hide' }); res.end('{"error":"slow down"}') })
  const t1 = errors.broker.issue()
  const relayed = await chat(t1.baseUrl, t1.token)
  assert.equal(relayed.status, 429)
  assert.equal(relayed.headers.get('retry-after'), '7')
  assert.equal(relayed.headers.get('set-cookie'), null)
  assert.equal(relayed.headers.get('x-internal'), null)
  assert.deepEqual(JSON.parse(relayed.text), { error: { code: 'upstream_429', type: 'rate_limit' } }, 'the upstream\'s words are replaced by a mapped body')

  const served = await setup((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'set-cookie': 'sid=abc', 'x-internal': 'hide', 'x-upstream-token': 'secret-in-a-header' })
    res.end(sseFrames({ choices: [{ delta: { content: 'hi' } }] }))
  })
  const t0 = served.broker.issue()
  const success = await chat(t0.baseUrl, t0.token)
  assert.equal(success.status, 200)
  assert.equal(success.headers.get('content-type'), 'text/event-stream')
  for (const name of ['set-cookie', 'x-internal', 'x-upstream-token']) assert.equal(success.headers.get(name), null, `${name} from the upstream does not reach the child`)

  const big = await setup((_req, res) => { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('e'.repeat(200_000)) })
  const t2 = big.broker.issue()
  assert.ok((await chat(t2.baseUrl, t2.token)).text.length < 200, 'an error body is never relayed, so it is never large')

  const gone = await setup()
  const t3 = gone.broker.issue()
  await gone.up.close()
  const unreachable = await chat(t3.baseUrl, t3.token)
  assert.equal(unreachable.status, 502)
  assert.equal(await code(unreachable), 'upstream_unreachable')

  const silent = await setup(() => new Promise<void>(() => undefined), { upstreamTimeoutMs: 150 })
  const t4 = silent.broker.issue()
  const started = Date.now()
  const timedOut = await chat(t4.baseUrl, t4.token)
  assert.equal(timedOut.status, 504)
  assert.equal(await code(timedOut), 'upstream_timeout')
  assert.ok(Date.now() - started < 3_000)

  const cut = await setup(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')
    await sleep(30)
    res.destroy()
  })
  const t5 = cut.broker.issue()
  const response = await fetch(`${t5.baseUrl}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${t5.token}`, 'content-type': 'application/json' }, body: '{"model":"m"}' })
  await assert.rejects(response.text(), () => true, 'a stream cut short is an error on the child\'s side, not a stream that ends cleanly')
  assert.ok(cut.broker.stats().upstreamFailures >= 1)
})

await check('B19 an upstream error is never relayed: one that echoes the credential it was sent hands the child a mapped body, with the status and retry-after kept', async () => {
  const { up, broker } = await setup((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json', 'retry-after': '3', 'x-echo': String(req.headers.authorization) })
    res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${req.headers.authorization}`, received: req.headers.authorization } }))
  })
  const ticket = broker.issue()
  const reply = await chat(ticket.baseUrl, ticket.token)
  assert.equal(up.seen.length, 1)
  assert.equal(up.seen[0]!.headers.authorization, `Bearer ${REAL_KEY}`, 'control: the upstream did receive the real key')
  assert.equal(reply.status, 401)
  assert.ok(!reply.text.includes(REAL_KEY) && !JSON.stringify([...reply.headers]).includes(REAL_KEY), 'neither the body nor a header carries the key')
  assert.deepEqual(JSON.parse(reply.text), { error: { code: 'upstream_401', type: 'auth' } })
  assert.equal(reply.headers.get('retry-after'), '3')
  for (const [status, type] of [[400, 'invalid_request'], [403, 'auth'], [404, 'invalid_request'], [408, 'server'], [413, 'invalid_request'], [422, 'invalid_request'], [429, 'rate_limit'], [500, 'server'], [503, 'server']] as const) {
    const each = await setup((_req, res) => { res.writeHead(status, { 'content-type': 'text/plain' }); res.end(`secret ${REAL_KEY}`) })
    const t = each.broker.issue()
    const answered = await chat(t.baseUrl, t.token)
    assert.equal(answered.status, status)
    assert.deepEqual(JSON.parse(answered.text), { error: { code: `upstream_${status}`, type } })
  }
})

await check('B20 revoking a ticket stops what it has in flight: the stream breaks and the upstream request is cancelled', async () => {
  let upstreamClosed!: () => void
  const closed = new Promise<void>((resolve) => { upstreamClosed = resolve })
  const { broker } = await setup(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"x"}}]}\n\n')
    res.on('close', upstreamClosed)
  })
  const ticket = broker.issue()
  const response = await fetch(`${ticket.baseUrl}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${ticket.token}`, 'content-type': 'application/json' }, body: '{"model":"m"}' })
  const reader = response.body!.getReader()
  await reader.read()
  ticket.revoke()
  await Promise.race([closed, sleep(3_000).then(() => { throw new Error('the upstream request outlived its revoked ticket') })])
  await assert.rejects(async () => { for (;;) { const part = await reader.read(); if (part.done) throw new Error('the stream ended cleanly') } }, /terminated|aborted|ECONNRESET|socket|fetch failed/i)

  // And before the upstream has answered at all: the child is told the ticket is gone, at once, and the request upstream is cancelled.
  let heldClosed!: () => void
  const heldGone = new Promise<void>((resolve) => { heldClosed = resolve })
  const held = await setup((_req, res) => { res.on('close', heldClosed) })
  const early = held.broker.issue()
  const pending = chat(early.baseUrl, early.token)
  const arrival = Date.now() + 3_000
  while (held.up.seen.length === 0 && Date.now() < arrival) await sleep(10)
  assert.equal(held.up.seen.length, 1, 'the request reached the upstream, which holds it')
  early.revoke()
  const answer = await Promise.race([pending, sleep(3_000).then(() => { throw new Error('a revoked ticket still waits on the upstream') })])
  assert.equal(answer.status, 401)
  assert.equal(await code(answer), 'ticket_invalid')
  await Promise.race([heldGone, sleep(3_000).then(() => { throw new Error('the held upstream request outlived its revoked ticket') })])
})

await check('B21 the port handed to a child cannot be used to exhaust this process: connections are capped and one that never sends headers is dropped', async () => {
  // The upstream takes longer than the connection timers below: a request under way is not a connection that said nothing.
  const { broker } = await setup(async (_req, res) => { await sleep(450); okStream(res) }, { maxConnections: 8, headersTimeoutMs: 200, connectionsCheckingIntervalMs: 50 })
  const ticket = broker.issue()
  const port = Number(new URL(ticket.baseUrl).port)
  const all: Socket[] = []
  // Forty connections, each saying `greeting` and then nothing: at most the cap are let in, and every one of those is dropped.
  const flood = async (greeting: string | null, what: string): Promise<void> => {
    const group: Socket[] = []
    for (let i = 0; i < 40; i += 1) {
      const socket = connect({ host: '127.0.0.1', port })
      socket.on('error', () => undefined)
      // The 408 the server answers a stalled request with has to be read before the socket can see the close behind it.
      socket.resume()
      if (greeting !== null) socket.write(greeting)
      group.push(socket)
      all.push(socket)
    }
    const open = (): number => group.filter((socket) => !socket.destroyed).length
    await sleep(150)
    assert.ok(open() <= 8, `${what}: at most the cap of connections stay open, saw ${open()}`)
    const deadline = Date.now() + 3_000
    while (open() > 0 && Date.now() < deadline) await sleep(25)
    assert.equal(open(), 0, `${what}: the connections that were let in are dropped`)
  }
  await flood(null, 'connections that never send a byte')
  await flood('POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\n', 'requests whose headers never end')
  for (const socket of all) socket.destroy()
  assert.equal((await chat(ticket.baseUrl, ticket.token)).status, 200, 'and a real request, even one slower than those timers, is still served')
})

await check('B11 a child that goes away takes its upstream request with it', async () => {
  let upstreamClosed!: () => void
  const closed = new Promise<void>((resolve) => { upstreamClosed = resolve })
  const { broker } = await setup(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"x"}}]}\n\n')
    res.on('close', upstreamClosed)
  })
  const ticket = broker.issue()
  const abort = new AbortController()
  const response = await fetch(`${ticket.baseUrl}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${ticket.token}`, 'content-type': 'application/json' }, body: '{"model":"m"}', signal: abort.signal })
  await response.body!.getReader().read()
  abort.abort()
  await Promise.race([closed, sleep(3_000).then(() => { throw new Error('the upstream request outlived its child') })])
})

await check('B12 usage is metered from a stream and from a plain response, with the cache mapping the adapter uses; bad numbers are not metered', async () => {
  const reports: LlmUsageReport[] = []
  const { broker } = await setup()
  const ticket = broker.issue({ onUsage: (report) => reports.push(report) })
  await chat(ticket.baseUrl, ticket.token, { body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [] }) })
  assert.deepEqual(reports, [{ model: 'deepseek-v4-flash', usage: { inputTokens: 2_000, outputTokens: 500, cacheReadTokens: 1_000 } }])

  const plain = await setup((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, prompt_cache_hit_tokens: 3 } })) })
  const seen: LlmUsageReport[] = []
  const t2 = plain.broker.issue({ onUsage: (report) => seen.push(report) })
  await chat(t2.baseUrl, t2.token, { body: '{"model":"m2"}' })
  assert.deepEqual(seen, [{ model: 'm2', usage: { inputTokens: 7, outputTokens: 4, cacheReadTokens: 3 } }])

  const bad: unknown[] = [
    { prompt_tokens: -1, completion_tokens: 4 },
    { prompt_tokens: '10', completion_tokens: 4 },
    { prompt_tokens: 10, completion_tokens: 4.5 },
    { prompt_tokens: 10 },
    { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 11 } },
  ]
  for (const usage of bad) {
    const odd = await setup((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ usage })) })
    const got: LlmUsageReport[] = []
    const t = odd.broker.issue({ onUsage: (report) => got.push(report) })
    assert.equal((await chat(t.baseUrl, t.token, { body: '{"model":"m"}' })).status, 200)
    assert.deepEqual(got, [], `${JSON.stringify(usage)} is not metered`)
  }
})

await check('B13 nothing is metered that should not be: no usage, an upstream error, no model, a non-JSON response, and a throwing meter changes nothing for the child', async () => {
  const got: LlmUsageReport[] = []
  const nothing = await setup((_req, res) => replySse(res, sseFrames({ choices: [{ delta: { content: 'x' } }] })))
  const t1 = nothing.broker.issue({ onUsage: (r) => got.push(r) })
  await chat(t1.baseUrl, t1.token, { body: '{"model":"m"}' })
  const failing = await setup((_req, res) => { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ usage: USAGE })) })
  const t2 = failing.broker.issue({ onUsage: (r) => got.push(r) })
  await chat(t2.baseUrl, t2.token, { body: '{"model":"m"}' })
  const { broker } = await setup()
  const t3 = broker.issue({ onUsage: (r) => got.push(r) })
  await chat(t3.baseUrl, t3.token, { body: 'not json' })
  await chat(t3.baseUrl, t3.token, { body: '{"messages":[]}' })
  const text = await setup((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('usage: lots') })
  const t4 = text.broker.issue({ onUsage: (r) => got.push(r) })
  await chat(t4.baseUrl, t4.token, { body: '{"model":"m"}' })
  assert.deepEqual(got, [])
  const throwing = await setup()
  const t5 = throwing.broker.issue({ onUsage: () => { throw new Error('meter bug') } })
  const reply = await chat(t5.baseUrl, t5.token, { body: '{"model":"m"}' })
  assert.equal(reply.status, 200)
  assert.match(reply.text, /hello/)
})

await check('B14 tickets are independent: revoking one leaves another working, and each reports only to its own meter', async () => {
  const { broker } = await setup()
  const [aReports, bReports]: [LlmUsageReport[], LlmUsageReport[]] = [[], []]
  const a = broker.issue({ onUsage: (r) => aReports.push(r) })
  const b = broker.issue({ onUsage: (r) => bReports.push(r) })
  a.revoke()
  assert.equal((await chat(a.baseUrl, a.token, { body: '{"model":"m"}' })).status, 401)
  assert.equal((await chat(b.baseUrl, b.token, { body: '{"model":"m"}' })).status, 200)
  assert.equal(aReports.length, 0)
  assert.equal(bReports.length, 1)
})

await check('B15 stats count what happened, and closing stops everything: tickets die and the port is gone', async () => {
  const { broker } = await setup()
  const ticket = broker.issue()
  await chat(ticket.baseUrl, ticket.token)
  await fetch(`${ticket.baseUrl}/chat/completions`, { method: 'POST', body: '{}' })
  const stats = broker.stats()
  assert.equal(stats.issued, 1)
  assert.equal(stats.active, 1)
  assert.equal(stats.forwarded, 1)
  assert.equal(stats.refused.ticket_invalid, 1)
  ticket.revoke()
  assert.equal(broker.stats().active, 0)
  const another = broker.issue()
  await broker.close()
  await assert.rejects(chat(another.baseUrl, another.token))
  assert.equal(broker.stats().active, 0)
  await broker.close()
})

await check('B16 the adapter the planner child uses works against the broker unchanged, and the upstream sees the real key only', async () => {
  const { up, broker } = await setup()
  const ticket = broker.issue()
  const adapter = await gatewayAdapter(ticket)
  const chunks: Array<{ type: string; usage?: unknown }> = []
  for await (const chunk of adapter.stream({ provider: 'gateway-chat', model: 'deepseek-v4-flash', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })) chunks.push(chunk)
  assert.ok(chunks.some((chunk) => chunk.type === 'usage'), 'the adapter saw the usage frame through the broker')
  assert.equal(up.seen[0]!.headers.authorization, `Bearer ${REAL_KEY}`)
})

await check('B17 usage is metered at [DONE], not at the end of the upstream body: a child that stops reading there and cancels is still metered, and a complete stream is not a failure', async () => {
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const { broker } = await setup(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(sseFrames(
      { choices: [{ delta: { role: 'assistant', content: 'hello' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: USAGE },
    ))
    // The upstream keeps the stream open after [DONE]; the adapter returns at [DONE] and cancels its request.
    await held
    res.end()
  })
  const reports: LlmUsageReport[] = []
  const ticket = broker.issue({ onUsage: (report) => reports.push(report) })
  const adapter = await gatewayAdapter(ticket)
  for await (const chunk of adapter.stream({ provider: 'gateway-chat', model: 'deepseek-v4-flash', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })) void chunk
  assert.equal(reports.length, 1, 'the report was in before the child could see the end of the stream')
  assert.deepEqual(reports[0]!.usage, { inputTokens: 2_000, outputTokens: 500, cacheReadTokens: 1_000 })
  const deadline = Date.now() + 3_000
  while (broker.stats().forwarded < 1 && Date.now() < deadline) await sleep(10)
  assert.equal(broker.stats().forwarded, 1, 'a stream that delivered [DONE] was complete')
  assert.equal(broker.stats().upstreamFailures, 0, 'and a child that cancels after it is not an upstream failure')
  release()
})

await check('B18 a ticket nobody revoked does not stay in the map: issuing sweeps the expired ones', async () => {
  const { broker } = await setup()
  const stale = [broker.issue({ ttlMs: 500 }), broker.issue({ ttlMs: 500 }), broker.issue({ ttlMs: 500 })]
  assert.equal(stale.length, 3)
  clock += 501
  assert.equal(broker.stats().tracked, 3, 'before anything is issued the expired ones are still held')
  assert.equal(broker.stats().active, 0, 'though none would be honoured')
  broker.issue()
  assert.equal(broker.stats().tracked, 1, 'issuing swept them: only the live ticket is held')
  assert.equal(broker.stats().active, 1)
})

// ---- C: child custody -------------------------------------------------------------------------------

console.log('C  child custody')

const stateRoots: string[] = []

await check('C1 with a broker the child environment holds neither the key nor the base URL, even when the environment offers both', async () => {
  const { broker } = await setup()
  const resolved = resolveRealRunPortConfig({
    llmTickets: broker,
    env: { PATH: process.env.PATH, DEEPSEEK_API_KEY: REAL_KEY, DEEPSEEK_BASE_URL: 'https://gateway.example/v1', DEEPSEEK_PROVIDER: 'gateway-chat', DEEPSEEK_MODEL: 'm', HTTPS_PROXY: 'http://proxy.example:3128' },
  })
  assert.equal(resolved.childEnv.DEEPSEEK_API_KEY, undefined)
  assert.equal(resolved.childEnv.DEEPSEEK_BASE_URL, undefined)
  assert.ok(!JSON.stringify(resolved.childEnv).includes(REAL_KEY))
  assert.equal(resolved.childEnv.DEEPSEEK_PROVIDER, 'gateway-chat')
  assert.equal(resolved.childEnv.DEEPSEEK_MODEL, 'm')
  assert.equal(resolved.childEnv.HTTPS_PROXY, 'http://proxy.example:3128', 'the rest of the allow-list is unchanged')
  const ambient = process.env.DEEPSEEK_API_KEY
  process.env.DEEPSEEK_API_KEY = REAL_KEY
  try {
    assert.equal(resolveRealRunPortConfig({ llmTickets: broker, env: { PATH: process.env.PATH, DEEPSEEK_PROVIDER: 'gateway-chat', DEEPSEEK_MODEL: 'm' } }).childEnv.DEEPSEEK_API_KEY, undefined)
  } finally {
    if (ambient === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = ambient
  }
})

await check('C2 a broker needs no key in the environment, and without one the key is still required, as before', async () => {
  const { broker } = await setup()
  assert.doesNotThrow(() => resolveRealRunPortConfig({ llmTickets: broker, env: { PATH: process.env.PATH, DEEPSEEK_PROVIDER: 'gateway-chat', DEEPSEEK_MODEL: 'm' } }))
  assert.throws(() => resolveRealRunPortConfig({ env: { PATH: process.env.PATH, DEEPSEEK_PROVIDER: 'gateway-chat', DEEPSEEK_MODEL: 'm' } }), /booking_planner_model_key_required/)
  const direct = resolveRealRunPortConfig({ env: { PATH: process.env.PATH, DEEPSEEK_API_KEY: 'k', DEEPSEEK_BASE_URL: 'https://g.example/v1' } })
  assert.equal(direct.childEnv.DEEPSEEK_API_KEY, 'k', 'without a broker nothing changes')
  assert.equal(direct.childEnv.DEEPSEEK_BASE_URL, 'https://g.example/v1')
})

await check('C3 a broker is refused for a route it does not carry, instead of silently sending the child somewhere it cannot go', async () => {
  const { broker } = await setup()
  assert.throws(() => resolveRealRunPortConfig({ llmTickets: broker, env: { PATH: process.env.PATH } }), /booking_planner_llm_tickets_require_gateway_chat/)
  assert.throws(() => resolveRealRunPortConfig({ llmTickets: broker, provider: 'deepseek-official', env: { PATH: process.env.PATH, DEEPSEEK_PROVIDER: 'gateway-chat', DEEPSEEK_MODEL: 'm' } }), /booking_planner_llm_tickets_require_gateway_chat/)
  assert.doesNotThrow(() => resolveRealRunPortConfig({ llmTickets: broker, provider: 'gateway-chat', model: 'm', env: { PATH: process.env.PATH } }))
})

await check('C5 a ticket replaces the key and base URL in what the child is given, and the ambient LLM names that could carry the real ones are removed; the runtime really drops them', async () => {
  const { broker } = await setup()
  const ticket = broker.issue()
  const given = plannerChildEnvironment({ PATH: 'p', DEEPSEEK_MODEL: 'm', DEEPSEEK_PROVIDER: 'gateway-chat' }, ticket)
  assert.equal(given.DEEPSEEK_API_KEY, ticket.token)
  assert.equal(given.DEEPSEEK_BASE_URL, ticket.baseUrl)
  assert.equal(given.DEEPSEEK_MODEL, 'm')
  for (const name of ['LLM_API_KEY', 'LLM_BASE_URL']) assert.ok(name in given && given[name] === undefined, `${name} is removed explicitly`)
  const resolved = { PATH: 'p' }
  assert.strictEqual(plannerChildEnvironment(resolved), resolved, 'without a ticket the environment is exactly what it was')

  // The runtime merges the explicit environment onto the parent's, so what the worker sees is checked with a real one.
  const fixture = fileURLToPath(new URL('./fixtures/tenant-runaway-worker-fixture.mjs', import.meta.url))
  const previous = { base: process.env.LLM_BASE_URL, key: process.env.LLM_API_KEY }
  process.env.LLM_BASE_URL = 'https://real-gateway.example/v1'
  process.env.LLM_API_KEY = 'sk-ambient-real-key'
  const ports: ManagedDshRunPort[] = []
  try {
    const seenBy = async (env: NodeJS.ProcessEnv): Promise<Record<string, string | null>> => {
      const port = new ManagedDshRunPort({ workerPath: fixture, graceMs: 50, env })
      ports.push(port)
      const result = await port.run('ok', { sessionId: 'c5' })
      return (result.events[0] as { ambient: Record<string, string | null> }).ambient
    }
    const control = await seenBy({ PATH: process.env.PATH })
    assert.equal(control.LLM_BASE_URL, 'https://real-gateway.example/v1', 'control: an address in the parent environment does reach a child that is not told to drop it')
    const governed = await seenBy({ ...given, PATH: process.env.PATH })
    assert.equal(governed.LLM_BASE_URL, null, 'the real address does not reach the child')
    assert.equal(governed.LLM_API_KEY, null, 'nor the ambient key')
    assert.equal(governed.DEEPSEEK_API_KEY, ticket.token)
    assert.equal(governed.DEEPSEEK_BASE_URL, ticket.baseUrl)
  } finally {
    for (const port of ports) await port.close().catch(() => undefined)
    if (previous.base === undefined) delete process.env.LLM_BASE_URL
    else process.env.LLM_BASE_URL = previous.base
    if (previous.key === undefined) delete process.env.LLM_API_KEY
    else process.env.LLM_API_KEY = previous.key
  }
})

await check('C6 a port that cannot be set up leaves no live ticket behind', async () => {
  const { broker } = await setup()
  const previous = process.env.TMPDIR
  process.env.TMPDIR = join(tmpdir(), 'gotry-does-not-exist', String(process.pid))
  try {
    await assert.rejects(createRealRunPort({
      llmTickets: broker,
      env: { PATH: process.env.PATH, DEEPSEEK_PROVIDER: 'gateway-chat', DEEPSEEK_MODEL: 'm' },
    }))
  } finally {
    if (previous === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previous
  }
  assert.equal(broker.stats().active, 0, 'the ticket is issued only after the steps that can fail')
  assert.equal(broker.stats().issued, 0)
})

const task: BookingCopilotTaskState = {
  schemaVersion: 'booking.surface',
  taskId: 'task-custody-1',
  contextRef: 'ctx-custody-1',
  surface: 'tenant',
  revision: 0,
  allowedActions: ['search.patch', 'search.run'],
  userTurnCount: 1,
  lastTurnId: 'turn-custody-1',
  operationCount: 0,
  phase: 'planning',
  lastSequence: 0,
  availability: { initialized: true, recoveryStarted: false, availabilityPhase: 'need_offers', activeHotelOrdinal: 0, hotelRefs: [], hotels: {}, attempts: [], queryReservations: [] },
}
task.workspaceSnapshot = {
  schemaVersion: 'booking.surface',
  contextRef: task.contextRef,
  surface: 'tenant',
  revision: 0,
  locale: 'zh-CN',
  currency: 'AED',
  searchDraft: {},
  results: { status: 'idle' },
  visibleHotels: [],
  loadedOffers: [],
  shortlistedOfferRefs: [],
  capabilities: { surface: 'tenant', allowedActions: ['search.patch', 'search.run'] },
}

await check('C4 a real dsh run through the broker produces its decision, using only the ticket, and the ticket dies with the planner', async () => {
  const modelRequests: Seen[] = []
  const { up, broker } = await setup((_req, res, seen) => {
    modelRequests.push(seen)
    if (modelRequests.length === 1) {
      replySse(res, sseFrames(
        { choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_run', function: { name: 'booking_run_search', arguments: JSON.stringify({ kind: 'search.run', input: {}, intent: { target: 'search.results' } }) } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: USAGE },
      ))
    } else {
      replySse(res, sseFrames({ choices: [{ delta: { content: 'Typed decision emitted.' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }], usage: USAGE }))
    }
  })
  const stateRoot = mkdtempSync(join(tmpdir(), 'gotry-egress-dsh-'))
  stateRoots.push(stateRoot)
  const planner = await createDshEmbeddedBookingPlanner({
    stateRoot,
    llmTickets: broker,
    model: 'deepseek-v4-flash',
    maxTokens: 512,
    turnTimeoutMs: 60_000,
    // The environment offers the real key AND the real upstream address. A child that used either would bypass the broker.
    env: { PATH: process.env.PATH, DEEPSEEK_API_KEY: REAL_KEY, DEEPSEEK_BASE_URL: `${up.url}/v1`, DEEPSEEK_PROVIDER: 'gateway-chat' },
  } as DshEmbeddedBookingPlannerOptions)
  const turn = {
    schemaVersion: 'booking.surface' as const,
    kind: 'user.turn' as const,
    taskId: task.taskId,
    turnId: task.lastTurnId!,
    workspace: task.workspaceSnapshot!,
    request: { text: '执行当前酒店搜索' },
  }
  const decisions = await planner.plannerFactory(task).next({ task, turn })
  const decision = decisions[0]!
  assert.equal(decision.kind, 'operation', JSON.stringify(decision))
  if (decision.kind !== 'operation') throw new Error('unreachable')
  assert.equal(decision.action.kind, 'search.run')
  assert.ok(broker.stats().forwarded >= 1, 'the child spoke to the broker: it had the ticket and not the real address')
  assert.ok(up.seen.length >= 1)
  for (const request of up.seen) assert.equal(request.headers.authorization, `Bearer ${REAL_KEY}`, 'the upstream was only ever called by the broker, with the key')
  assert.equal(broker.stats().active, 1, 'the port\'s ticket is live while the port is')
  await planner.close()
  assert.equal(broker.stats().active, 0, 'closing the planner revoked its ticket')
})

// ---- D: tenants ----------------------------------------------------------------------------------

console.log('D  tenants')

const root = mkdtempSync(join(tmpdir(), 'gotry-egress-tenants-'))
const cleanups: Array<() => void | Promise<void>> = []
const accountOf = (service: Awaited<ReturnType<typeof makeService>>, credential: string) => {
  const tenant = tenantOf(credential)
  return service.quotas.snapshot().tenants.find((entry) => entry.key === `${tenant.organization}/${tenant.ledgerTenant}`)
}

/** A provider whose planner makes one model call through the broker inside every invocation, then answers as the scripted planner does. */
function brokeredProvider(broker: LlmCredentialBroker, usageFor: (task: string) => object, issueOutsideInvocation = false) {
  const kit = makePlanner()
  const provider = createDshTenantPlannerProvider({ llmTickets: broker }, async (options) => {
    const early = issueOutsideInvocation ? options.llmTickets!.issue() : undefined
    return {
      plannerFactory: (inner) => {
        const session = kit.factory(inner)
        return {
          next: async (input) => {
            const ticket = early ?? options.llmTickets!.issue()
            const reply = await chat(ticket.baseUrl, ticket.token, { body: JSON.stringify({ model: MODEL, messages: [], usage_hint: usageFor(inner.taskId) }) })
            assert.equal(reply.status, 200)
            if (!early) ticket.revoke()
            return session.next(input)
          },
          close: () => session.close!(),
        }
      },
      close: async () => undefined,
    }
  })
  return { kit, provider }
}

const usageByHint = (_req: IncomingMessage, res: ServerResponse, seen: Seen): void => {
  const hint = (JSON.parse(seen.body) as { usage_hint?: { prompt: number; completion: number; cached?: number } }).usage_hint
  const usage = hint
    ? { prompt_tokens: hint.prompt, completion_tokens: hint.completion, ...(hint.cached === undefined ? {} : { prompt_tokens_details: { cached_tokens: hint.cached } }) }
    : USAGE
  replySse(res, sseFrames({ choices: [{ delta: { content: 'ok' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }], usage }))
}

await check('D1 measured usage is charged to the tenant whose invocation asked, instead of the worst case', async () => {
  const { broker } = await setup(usageByHint)
  const { kit, provider } = brokeredProvider(broker, () => ({ prompt: 3_000, completion: 500, cached: 1_000 }))
  const fleet = makeFleet(join(root, 'd1'), cleanups)
  const service = await makeService(fleet, 'd1', cleanups, { planner: kit, provider })
  assert.equal((await service.post(userTurn('task-d1', 'ctx-d1', 'find hotels'), 'cred-acme-alice')).status, 200)
  const alice = accountOf(service, 'cred-acme-alice')!
  assert.equal(alice.llmTokens, 3_500, 'what the broker measured, not the configured worst case')
  assert.notEqual(alice.llmTokens, ROOMY.unprovenInvocation.tokens)
})

await check('D2 two tenants at once are each charged their own usage and nobody else\'s', async () => {
  const { broker } = await setup(usageByHint)
  const sizes: Record<string, object> = { 'task-d2-a': { prompt: 3_000, completion: 500 }, 'task-d2-b': { prompt: 600, completion: 100 } }
  const { kit, provider } = brokeredProvider(broker, (taskId) => sizes[taskId] ?? { prompt: 1, completion: 1 })
  const fleet = makeFleet(join(root, 'd2'), cleanups)
  const service = await makeService(fleet, 'd2', cleanups, { planner: kit, provider })
  const [a, b] = await Promise.all([
    service.post(userTurn('task-d2-a', 'ctx-d2-a', 'find hotels'), 'cred-acme-alice'),
    service.post(userTurn('task-d2-b', 'ctx-d2-b', 'find hotels'), 'cred-acme-bob'),
  ])
  assert.deepEqual([a.status, b.status], [200, 200])
  assert.equal(accountOf(service, 'cred-acme-alice')!.llmTokens, 3_500)
  assert.equal(accountOf(service, 'cred-acme-bob')!.llmTokens, 700)
  assert.equal(accountOf(service, 'cred-globex-alice'), undefined, 'a tenant that asked for nothing has no account')
})

await check('D3 a ticket issued outside any invocation reports to no one: the invocation is charged the worst case, and no other tenant is charged', async () => {
  const { broker } = await setup(usageByHint)
  const { kit, provider } = brokeredProvider(broker, () => ({ prompt: 3_000, completion: 500 }), true)
  const fleet = makeFleet(join(root, 'd3'), cleanups)
  const service = await makeService(fleet, 'd3', cleanups, { planner: kit, provider })
  assert.equal((await service.post(userTurn('task-d3', 'ctx-d3', 'find hotels'), 'cred-acme-alice')).status, 200)
  assert.equal(accountOf(service, 'cred-acme-alice')!.llmTokens, ROOMY.unprovenInvocation.tokens, 'silence is charged the worst case')
  assert.equal(accountOf(service, 'cred-acme-bob'), undefined)
})

await check('D4 the provider hands the planner a tenant-bound issuer, not the broker, so no planner can issue a ticket that reports elsewhere', async () => {
  const { broker } = await setup()
  let received: DshEmbeddedBookingPlannerOptions | undefined
  const provider = createDshTenantPlannerProvider({ llmTickets: broker }, async (options) => {
    received = options
    return { plannerFactory: () => ({ next: async () => [] }), close: async () => undefined }
  })
  await provider.forTenant({ tenantRoot: join(root, 'd4'), cachePartition: `pc-${'a'.repeat(32)}`, reportUsage() {} })
  assert.ok(received?.llmTickets)
  assert.notStrictEqual(received.llmTickets, broker)
})

await check('D5 the real dsh planner of the tenant form cannot be built without a broker: it would hold the deployment key', async () => {
  const { broker } = await setup()
  assert.throws(() => createDshTenantPlannerProvider({}), /tenant_planner_credential_broker_required/)
  assert.throws(() => createDshTenantPlannerProvider({ env: { PATH: process.env.PATH, DEEPSEEK_API_KEY: REAL_KEY } }), /tenant_planner_credential_broker_required/)
  assert.doesNotThrow(() => createDshTenantPlannerProvider({ llmTickets: broker }), 'with a broker the real planner may be built')
  assert.doesNotThrow(() => createDshTenantPlannerProvider({}, async () => ({ plannerFactory: () => ({ next: async () => [] }), close: async () => undefined })), 'a factory the caller injects is the caller\'s own business')
})

// ---- cleanup ---------------------------------------------------------------------------------------

for (const cleanup of cleanups.reverse()) {
  try { await cleanup() } catch { /* best effort */ }
}
for (const broker of brokers) await broker.close().catch(() => undefined)
for (const up of upstreams) await up.close().catch(() => undefined)
for (const stateRoot of stateRoots) rmSync(stateRoot, { recursive: true, force: true })
rmSync(root, { recursive: true, force: true })
console.log(`tenant-egress-credentials: ${passed} checks passed`)
process.exit(0)
