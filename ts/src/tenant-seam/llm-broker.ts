/**
 * The LLM credential broker (docs/rfc/aaas-rfc.md §4.8, threat S-18).
 *
 * A planner child is the one place on a replica where model output, which is untrusted, steers a process that holds a
 * bearer credential. Today that credential is the deployment-wide gateway key in the child's environment: valid from
 * anywhere, for as long as nobody rotates it, and shared by every tenant. The broker moves the credential out of the
 * child. The upstream key and base URL stay in this process; each planner process tree gets a *ticket* instead, a random
 * bearer that is good only against this broker, on the loopback interface, for a short time, for a bounded number of
 * requests, and that dies with the port it was issued for.
 *
 * What the broker is, and is not:
 * - It is a credential-injecting forward proxy for one upstream. The child can ask it for exactly one thing, a POST to
 *   an allow-listed path; the upstream host and path are fixed here, the child's `authorization` header is dropped and
 *   the real key is attached, redirects are refused, and a response comes back with a closed set of headers.
 * - It is not isolation from this process. Whoever can run code here can read the key. It narrows what a *compromised
 *   child* gets: a ticket that expires, works from nowhere else, and names no key.
 * - It meters. Every completed response is parsed for its `usage`, so a deployment can charge measured spend to the
 *   tenant whose ticket asked, instead of the configured worst case (`TenantPlannerContext.reportUsage`).
 *
 * The broker carries the chat-completions route (`DEEPSEEK_PROVIDER=gateway-chat`, `dsh-llm-gateway-chat.js`). Another
 * wire dialect needs its own path in `allowedPaths` and a live check before it is added.
 */

import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { once } from 'node:events'
import type { MeasuredLlmUsage } from '../llm-price-table.ts'

export interface LlmUsageReport {
  /** The model the child asked for (the request's `model`), which is what the price table prices. */
  readonly model: string
  readonly usage: MeasuredLlmUsage
}

export interface LlmTicketOptions {
  /** Overrides the broker's default lifetime. */
  readonly ttlMs?: number
  /** Called once per completed upstream response that carried usable `usage`. A throw is contained. */
  readonly onUsage?: (report: LlmUsageReport) => void
}

export interface LlmTicket {
  /** What the child uses as its base URL. It ends in `/v1`, as the chat-completions adapter expects. */
  readonly baseUrl: string
  /** What the child uses as its API key. */
  readonly token: string
  readonly expiresAtMs: number
  /** Stops the ticket working at once. Idempotent. */
  revoke(): void
}

export interface LlmTicketIssuer {
  issue(options?: LlmTicketOptions): LlmTicket
}

export interface LlmBrokerStats {
  readonly issued: number
  /** Tickets that would be honoured now. */
  readonly active: number
  /** Tickets still held in memory, expired ones included until the next issue sweeps them. */
  readonly tracked: number
  readonly forwarded: number
  readonly refused: Readonly<Record<string, number>>
  readonly upstreamFailures: number
}

export interface LlmBrokerOptions {
  /** The upstream's base URL as the child would have used it, for example `https://gateway.example/v1`. http or https. */
  readonly upstreamBaseUrl: string
  /** The credential the broker injects. It never leaves this process. */
  readonly upstreamApiKey: string
  /** Default ticket lifetime. Default 15 minutes: a port is a per-turn cache and lives for seconds. */
  readonly ticketTtlMs?: number
  /** Requests one ticket may make. Default 64: a planner turn is a handful of model steps. */
  readonly maxRequestsPerTicket?: number
  /** Requests one ticket may have in flight. Default 4: a run is sequential. */
  readonly maxConcurrentPerTicket?: number
  /** Largest request body. Default 4 MiB. */
  readonly maxRequestBytes?: number
  /** Time allowed until the upstream answers with headers. Default 60 s. The stream after that is the planner's stall budget's business. */
  readonly upstreamTimeoutMs?: number
  /** Paths the child may POST to, relative to its base URL. Default `['/chat/completions']`. */
  readonly allowedPaths?: readonly string[]
  /** Clock, injected by the suites. */
  readonly now?: () => number
  /** Transport, injected by the suites. Default: global fetch. */
  readonly fetch?: typeof fetch
}

const DEFAULT_TTL_MS = 15 * 60_000
const DEFAULT_MAX_REQUESTS = 64
const DEFAULT_MAX_CONCURRENT = 4
const DEFAULT_MAX_REQUEST_BYTES = 4 * 1024 * 1024
const DEFAULT_UPSTREAM_TIMEOUT_MS = 60_000
const MAX_ERROR_BODY_BYTES = 16 * 1024
const MAX_USAGE_LINE_BYTES = 1024 * 1024
const TOKEN_PREFIX = 'gtk-'

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

interface TicketRecord {
  readonly onUsage: ((report: LlmUsageReport) => void) | undefined
  expiresAtMs: number
  requests: number
  inFlight: number
  revoked: boolean
}

function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function positive(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a positive number`)
  return value
}

function jsonError(res: ServerResponse, status: number, code: string, headers: Record<string, string> = {}): void {
  if (res.headersSent) { res.destroy(); return }
  const body = JSON.stringify({ error: { code } })
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', ...headers })
  res.end(body)
}

/** The upstream URL for one allowed path, built the way the chat-completions adapter builds its own endpoint. */
function upstreamUrlFor(base: URL, path: string): string {
  const root = base.href.replace(/\/+$/u, '')
  return base.pathname.replace(/\/+$/u, '').endsWith('/v1') ? `${root}${path}` : `${root}/v1${path}`
}

/** Resolves when the response drains or its connection closes, whichever is first, and leaves no listener behind. */
function drainOrClose(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      res.off('drain', done)
      res.off('close', done)
      resolve()
    }
    res.once('drain', done)
    res.once('close', done)
  })
}

/** Reads `usage` out of a response as it streams past, without holding on to the response. Never throws. */
class UsageTap {
  private readonly sse: boolean
  private carry = ''
  private carryOverflow = false
  private found: Record<string, unknown> | undefined
  private done = false
  private readonly decoder = new TextDecoder()

  constructor(contentType: string) {
    this.sse = contentType.includes('text/event-stream')
  }

  push(chunk: Uint8Array): void {
    try {
      this.carry += this.decoder.decode(chunk, { stream: true })
      if (this.sse) {
        for (let newline = this.carry.indexOf('\n'); newline >= 0; newline = this.carry.indexOf('\n')) {
          this.line(this.carry.slice(0, newline))
          this.carry = this.carry.slice(newline + 1)
        }
      }
      if (this.carry.length > MAX_USAGE_LINE_BYTES) { this.carry = ''; this.carryOverflow = true }
    } catch { /* metering must never touch the response */ }
  }

  /** True once the stream's `[DONE]` sentinel has gone past: nothing after it matters to a reader that stops there. */
  get sawDone(): boolean {
    return this.done
  }

  finish(): Record<string, unknown> | undefined {
    try {
      this.carry += this.decoder.decode()
      if (this.sse) this.line(this.carry)
      else if (!this.carryOverflow) this.consider(JSON.parse(this.carry))
    } catch { /* an unparseable body is simply unmetered */ }
    return this.found
  }

  private line(raw: string): void {
    const line = raw.trim()
    if (!line.startsWith('data:')) return
    const data = line.slice('data:'.length).trim()
    if (data === '[DONE]') { this.done = true; return }
    if (data === '') return
    try { this.consider(JSON.parse(data)) } catch { /* a frame that is not JSON carries no usage */ }
  }

  private consider(value: unknown): void {
    if (typeof value !== 'object' || value === null) return
    const usage = (value as { usage?: unknown }).usage
    if (typeof usage === 'object' && usage !== null) this.found = usage as Record<string, unknown>
  }
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** The same mapping the chat-completions adapter applies: cache reads are subtracted from the prompt count. */
function measuredUsage(raw: Record<string, unknown>): MeasuredLlmUsage | undefined {
  const prompt = count(raw.prompt_tokens)
  const completion = count(raw.completion_tokens)
  if (prompt === undefined || completion === undefined) return undefined
  const details = typeof raw.prompt_tokens_details === 'object' && raw.prompt_tokens_details !== null ? raw.prompt_tokens_details as Record<string, unknown> : {}
  const cacheRead = count(details.cached_tokens) ?? count(raw.prompt_cache_hit_tokens)
  if (cacheRead !== undefined && cacheRead > prompt) return undefined
  return { inputTokens: prompt - (cacheRead ?? 0), outputTokens: completion, ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }) }
}

export class LlmCredentialBroker implements LlmTicketIssuer {
  private readonly upstream: URL
  private readonly upstreamKey: string
  private readonly ttlMs: number
  private readonly maxRequests: number
  private readonly maxConcurrent: number
  private readonly maxRequestBytes: number
  private readonly upstreamTimeoutMs: number
  private readonly allowedPaths: ReadonlySet<string>
  private readonly now: () => number
  private readonly transport: typeof fetch
  private readonly tickets = new Map<string, TicketRecord>()
  private readonly refused = new Map<string, number>()
  private server: Server | undefined
  private baseUrl = ''
  private issued = 0
  private forwarded = 0
  private upstreamFailures = 0
  private closed = false

  constructor(options: LlmBrokerOptions) {
    let upstream: URL
    try { upstream = new URL(options.upstreamBaseUrl) } catch { throw new RangeError('upstreamBaseUrl must be an absolute URL') }
    if (upstream.protocol !== 'https:' && upstream.protocol !== 'http:') throw new RangeError('upstreamBaseUrl must be http or https')
    if (upstream.username !== '' || upstream.password !== '') throw new RangeError('upstreamBaseUrl must not carry credentials')
    if (typeof options.upstreamApiKey !== 'string' || options.upstreamApiKey.length === 0) throw new RangeError('upstreamApiKey must be a non-empty string')
    this.upstream = upstream
    this.upstreamKey = options.upstreamApiKey
    this.ttlMs = positive('ticketTtlMs', options.ticketTtlMs ?? DEFAULT_TTL_MS)
    this.maxRequests = positive('maxRequestsPerTicket', options.maxRequestsPerTicket ?? DEFAULT_MAX_REQUESTS)
    this.maxConcurrent = positive('maxConcurrentPerTicket', options.maxConcurrentPerTicket ?? DEFAULT_MAX_CONCURRENT)
    this.maxRequestBytes = positive('maxRequestBytes', options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES)
    this.upstreamTimeoutMs = positive('upstreamTimeoutMs', options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS)
    const paths = options.allowedPaths ?? ['/chat/completions']
    for (const path of paths) {
      if (!/^\/[A-Za-z0-9._~/-]*$/u.test(path) || path.includes('..') || path.includes('//')) throw new RangeError(`allowed path ${JSON.stringify(path)} is not a plain path`)
    }
    this.allowedPaths = new Set(paths)
    this.now = options.now ?? Date.now
    this.transport = options.fetch ?? fetch
  }

  /** Starts listening on a loopback ephemeral port. Tickets can be issued once this resolves. */
  async start(): Promise<void> {
    if (this.server || this.closed) throw new Error('llm_broker_already_started')
    const server = createServer((req, res) => { void this.handle(req, res) })
    // A planner run is long-lived, but nothing here should linger on an idle connection.
    server.keepAliveTimeout = 5_000
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    this.server = server
    this.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  }

  issue(options: LlmTicketOptions = {}): LlmTicket {
    if (!this.server || this.closed) throw new Error('llm_broker_not_running')
    // Expired tickets leave with the next issue, so a ticket nobody revoked cannot sit in the map for long.
    this.sweep()
    const ttlMs = positive('ttlMs', options.ttlMs ?? this.ttlMs)
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
    const key = digest(token)
    const record: TicketRecord = { onUsage: options.onUsage, expiresAtMs: this.now() + ttlMs, requests: 0, inFlight: 0, revoked: false }
    this.tickets.set(key, record)
    this.issued += 1
    return {
      baseUrl: this.baseUrl,
      token,
      expiresAtMs: record.expiresAtMs,
      revoke: () => {
        record.revoked = true
        this.tickets.delete(key)
      },
    }
  }

  stats(): LlmBrokerStats {
    const now = this.now()
    let active = 0
    for (const record of this.tickets.values()) if (!record.revoked && record.expiresAtMs > now) active += 1
    return { issued: this.issued, active, tracked: this.tickets.size, forwarded: this.forwarded, refused: Object.fromEntries(this.refused), upstreamFailures: this.upstreamFailures }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.tickets.clear()
    const server = this.server
    if (!server) return
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private sweep(): void {
    const now = this.now()
    for (const [key, record] of this.tickets) if (record.expiresAtMs <= now) this.tickets.delete(key)
  }

  private refuse(res: ServerResponse, status: number, code: string, headers: Record<string, string> = {}): void {
    this.refused.set(code, (this.refused.get(code) ?? 0) + 1)
    jsonError(res, status, code, headers)
  }

  /** A refusal whose request body is not going to be read: the answer goes out, and only then is the connection cut. */
  private refuseAndClose(req: IncomingMessage, res: ServerResponse, status: number, code: string): void {
    res.once('finish', () => req.destroy())
    this.refuse(res, status, code, { connection: 'close' })
  }

  private ticketOf(req: IncomingMessage): TicketRecord | undefined {
    const header = req.headers.authorization
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return undefined
    const token = header.slice('Bearer '.length).trim()
    if (!token.startsWith(TOKEN_PREFIX) || token.length > 128) return undefined
    const record = this.tickets.get(digest(token))
    if (!record || record.revoked || record.expiresAtMs <= this.now()) return undefined
    return record
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ticket: { record?: TicketRecord } = {}
    try {
      // Defense in depth: the socket is bound to loopback, and a remote peer is refused even so.
      if (!LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? '')) { this.refuseAndClose(req, res, 403, 'not_loopback'); return }
      const url = new URL(req.url ?? '/', 'http://broker.invalid')
      const prefix = '/v1'
      const path = url.pathname.startsWith(`${prefix}/`) ? url.pathname.slice(prefix.length) : ''
      if (!this.allowedPaths.has(path)) { this.refuse(res, 404, 'path_not_allowed'); req.resume(); return }
      if (req.method !== 'POST') { this.refuse(res, 405, 'method_not_allowed', { allow: 'POST' }); req.resume(); return }
      const record = this.ticketOf(req)
      if (!record) { this.refuse(res, 401, 'ticket_invalid'); req.resume(); return }
      if (record.requests >= this.maxRequests) { this.refuse(res, 429, 'ticket_exhausted'); req.resume(); return }
      if (record.inFlight >= this.maxConcurrent) { this.refuse(res, 429, 'ticket_busy', { 'retry-after': '1' }); req.resume(); return }
      record.requests += 1
      record.inFlight += 1
      ticket.record = record
      const declared = Number(req.headers['content-length'])
      if (Number.isFinite(declared) && declared > this.maxRequestBytes) { this.refuseAndClose(req, res, 413, 'request_too_large'); return }
      const body = await this.readBody(req)
      if (body === null) { this.refuseAndClose(req, res, 413, 'request_too_large'); return }
      await this.forward(req, res, record, path, body)
    } catch {
      if (!res.writableEnded) jsonError(res, 500, 'broker_error')
    } finally {
      if (ticket.record) ticket.record.inFlight -= 1
    }
  }

  private async readBody(req: IncomingMessage): Promise<Buffer | null> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length
      if (size > this.maxRequestBytes) return null
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }

  private async forward(req: IncomingMessage, res: ServerResponse, record: TicketRecord, path: string, body: Buffer): Promise<void> {
    const abort = new AbortController()
    res.on('close', () => { if (!res.writableFinished) abort.abort() })
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.upstreamKey}`,
      'content-type': typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : 'application/json',
    }
    if (typeof req.headers.accept === 'string') headers.accept = req.headers.accept
    // The only requests the broker carries are JSON; the text form is what goes upstream.
    const text = body.toString('utf8')
    let model = ''
    try {
      const parsed = JSON.parse(text) as { model?: unknown }
      if (typeof parsed.model === 'string') model = parsed.model
    } catch { /* an unparseable body is the upstream's to refuse; it is simply unmetered here */ }

    const timer = setTimeout(() => abort.abort(), this.upstreamTimeoutMs)
    let response: Response
    try {
      response = await this.transport(upstreamUrlFor(this.upstream, path), { method: 'POST', headers, body: text, redirect: 'manual', signal: abort.signal })
    } catch {
      this.upstreamFailures += 1
      if (res.writableEnded || res.destroyed) return
      jsonError(res, abort.signal.aborted ? 504 : 502, abort.signal.aborted ? 'upstream_timeout' : 'upstream_unreachable')
      return
    } finally {
      clearTimeout(timer)
    }
    // A redirect would send the injected key wherever the upstream points; it is a failure, not something to follow.
    if (response.status >= 300 && response.status < 400) {
      this.upstreamFailures += 1
      await response.body?.cancel().catch(() => undefined)
      jsonError(res, 502, 'upstream_redirect_refused')
      return
    }

    const contentType = response.headers.get('content-type') ?? 'application/json'
    const outHeaders: Record<string, string> = { 'content-type': contentType, 'cache-control': 'no-store' }
    const retryAfter = response.headers.get('retry-after')
    if (retryAfter !== null && /^\d{1,6}$/u.test(retryAfter)) outHeaders['retry-after'] = retryAfter
    res.writeHead(response.status, outHeaders)
    const ok = response.status >= 200 && response.status < 300
    const tap = ok ? new UsageTap(contentType) : undefined
    let relayed = 0
    // Measured spend is reported once, and before the child can see that the stream is over: at the `[DONE]` frame, which
    // is where the chat-completions adapter stops reading (it then cancels the request, whatever the upstream still does),
    // or, for a body with no such frame, when the body has ended.
    let metered = false
    const meter = (): void => {
      if (metered || !tap) return
      metered = true
      const usage = tap.finish()
      const measured = usage ? measuredUsage(usage) : undefined
      if (measured && model !== '' && record.onUsage) {
        try { record.onUsage({ model, usage: measured }) } catch { /* the caller's meter never affects the response */ }
      }
    }
    try {
      if (response.body) {
        const reader = response.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (!ok) {
            const room = MAX_ERROR_BODY_BYTES - relayed
            if (room <= 0) { await reader.cancel().catch(() => undefined); break }
            const piece = value.length > room ? value.subarray(0, room) : value
            relayed += piece.length
            res.write(piece)
            continue
          }
          tap?.push(value)
          if (tap?.sawDone) meter()
          if (!res.write(value)) {
            // A child that went away while the pipe was full never drains it: stop waiting when the connection closes.
            await drainOrClose(res)
            if (res.destroyed) { await reader.cancel().catch(() => undefined); break }
          }
        }
      }
      meter()
      res.end()
      this.forwarded += 1
    } catch {
      // A stream that had already delivered `[DONE]` was complete; the child may simply have stopped reading and cancelled.
      // Anything else is the upstream failing mid-stream, and the child must see a broken connection, never a truncated
      // stream that looks whole.
      if (tap?.sawDone) this.forwarded += 1
      else this.upstreamFailures += 1
      res.destroy()
    }
  }
}

/** A broker that is listening. */
export async function startLlmCredentialBroker(options: LlmBrokerOptions): Promise<LlmCredentialBroker> {
  const broker = new LlmCredentialBroker(options)
  await broker.start()
  return broker
}
