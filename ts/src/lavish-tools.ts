/** Host-owned Lavish Editor lifecycle tools for issue #443. */
import { realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

import {
  LavishLocalSession,
  type LavishLocalFailure,
  type LavishStopResult,
} from '../capabilities/lavish-local.ts'

type RegisteredTool = ReturnType<typeof defineTool>
type Terminal = 'disposed' | 'ended' | 'poll-outcome-unknown' | 'stopped' | 'user-ended'
type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject
interface JsonObject { [key: string]: JsonValue }

interface SessionRecord {
  readonly id: string
  readonly rawCwd: string
  readonly canonicalCwd: string
  session: LavishLocalSession | null
  terminal: Terminal | null
  tail: Promise<void>
  cleanup: Promise<LavishStopResult | LavishLocalFailure> | null
  stopResult: LavishStopResult | LavishLocalFailure | null
}

export function registerLavishTools(options: {
  ctx: Context
  register(tool: RegisteredTool): void
  getConfig(): { lavishAxiPackageRoot?: string }
}): { registered: boolean; reason?: string } {
  const cliPackageRoot = options.getConfig().lavishAxiPackageRoot ?? ''
  if (cliPackageRoot.length === 0) return { registered: false, reason: 'lavishAxiPackageRoot is not configured' }
  if (!isAbsolute(cliPackageRoot)) return { registered: false, reason: 'lavishAxiPackageRoot must be absolute' }

  const records = new Map<string, SessionRecord>()
  const disposedIds = new Set<string>()
  // Registrar-wide terminal: once set, bind() refuses any new record creation
  // or reuse, regardless of authority or cwd. Set synchronously by the plugin
  // unload disposer before any await so unload cannot race a late bind call.
  let closed = false

  const closedFailure = (): JsonObject => failure(
    'lavish-plugin-closed',
    'Lavish plugin is unloaded; no new host sessions may be opened',
  )

  const bind = async (exec: unknown): Promise<SessionRecord | JsonObject> => {
    const authority = readAuthority(exec)
    if (!authority.ok) return failure('lavish-authority-rejected', authority.detail)
    if (closed) return closedFailure()
    if (disposedIds.has(authority.id)) return failure('lavish-session-terminal', `host session ${authority.id} was disposed`)

    const existing = records.get(authority.id)
    if (existing && existing.rawCwd !== authority.cwd) {
      return failure('lavish-cwd-drift', `host session ${authority.id} is already bound to a different raw cwd`)
    }

    let canonicalCwd: string
    try {
      canonicalCwd = await realpath(authority.cwd)
    } catch {
      return failure('lavish-authority-rejected', 'host session header.cwd must name an existing directory')
    }
    if (closed) return closedFailure()
    if (disposedIds.has(authority.id)) return failure('lavish-session-terminal', `host session ${authority.id} was disposed`)
    // Another first call for this id may have bound the record while realpath awaited.
    const bound = records.get(authority.id)
    if (bound) {
      if (bound.rawCwd !== authority.cwd || bound.canonicalCwd !== canonicalCwd) {
        return failure('lavish-cwd-drift', `host session ${authority.id} canonical cwd changed`)
      }
      return bound
    }
    if (closed) return closedFailure()

    const record: SessionRecord = {
      id: authority.id,
      rawCwd: authority.cwd,
      canonicalCwd,
      session: null,
      terminal: null,
      tail: Promise.resolve(),
      cleanup: null,
      stopResult: null,
    }
    records.set(authority.id, record)
    return record
  }

  const runActive = async (
    exec: unknown,
    operation: (record: SessionRecord) => Promise<JsonObject>,
  ): Promise<JsonObject> => {
    const record = await bind(exec)
    if (!isRecord(record)) return record
    return enqueue(record, async () => {
      if (record.terminal) return terminalFailure(record)
      return operation(record)
    })
  }

  const getSession = async (record: SessionRecord): Promise<LavishLocalSession | JsonObject> => {
    if (record.session) return record.session
    const creation = LavishLocalSession.create({
      cliPackageRoot,
      cwd: record.rawCwd,
      allowedRoot: record.rawCwd,
    })
    try {
      const session = await creation
      record.session = session
      return session
    } catch (error) {
      return failure('lavish-create-failed', error instanceof Error ? error.message : 'Lavish session creation failed')
    }
  }

  const finishCommand = async (
    record: SessionRecord,
    result: object,
  ): Promise<JsonObject> => {
    // Snapshot host authority before any adapter signal latches: a stop/dispose
    // that fired during this in-flight command must preserve its precedence
    // over a just-completed user-ended / poll-outcome-unknown result.
    const prior = record.terminal
    latchAdapterTerminal(record, result)
    if (prior === 'disposed' || prior === 'stopped') {
      record.terminal = prior
      await cleanup(record)
      return terminalFailure(record)
    }
    if (record.terminal === 'disposed' || record.terminal === 'stopped') {
      await cleanup(record)
      return terminalFailure(record)
    }
    return present(result)
  }

  const finishEnd = async (
    record: SessionRecord,
    result: object,
  ): Promise<JsonObject> => {
    // End must preserve host authority: a concurrent stop/dispose that fired
    // during this end() call retains terminal, and the explicit 'ended'
    // latch must not overwrite an existing 'ended' / 'stopped' / 'disposed'.
    const prior = record.terminal
    latchAdapterTerminal(record, result)
    if (prior === 'disposed' || prior === 'stopped') {
      record.terminal = prior
      await cleanup(record)
      return terminalFailure(record)
    }
    if (record.terminal === 'disposed' || record.terminal === 'stopped') {
      await cleanup(record)
      return terminalFailure(record)
    }
    if ((result as { ok?: unknown }).ok && !record.terminal) record.terminal = 'ended'
    return present(result)
  }

  options.register(defineTool({
    name: 'gotry_lavish_open',
    description: 'Open an existing HTML artifact in the host-owned local Lavish Editor. The trusted pinned CLI and workspace root come only from host configuration and session metadata.',
    parameters: { path: { type: 'string', required: true, description: 'HTML/HTM artifact path under the host session cwd' } },
    output: outputPresentation('Lavish open'),
    async execute(args, exec) {
      return runActive(exec, async record => {
        const session = await getSession(record)
        if (!isSession(session)) return session
        if (record.terminal) {
          await cleanup(record)
          return terminalFailure(record)
        }
        const result = await session.open(args.path)
        return finishCommand(record, result)
      })
    },
    presentCall: args => callPresentation('Lavish open', args),
    presentResult: resultPresentation('Lavish open'),
  }))

  options.register(defineTool({
    name: 'gotry_lavish_poll',
    description: 'Wait once for untrusted user feedback from the host session Lavish Editor. An uncertain poll outcome is terminal because retrying could double-consume feedback.',
    parameters: {
      path: { type: 'string', required: true, description: 'Previously opened HTML/HTM artifact path' },
      timeoutMs: { type: 'integer', description: 'Optional bounded positive poll timeout in milliseconds' },
    },
    output: outputPresentation('Lavish poll'),
    async execute(args, exec) {
      return runActive(exec, async record => {
        if (!record.session) return failure('lavish-session-missing', 'call gotry_lavish_open first')
        const result = await record.session.poll(args.path, args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs })
        return finishCommand(record, result)
      })
    },
    presentCall: args => callPresentation('Lavish poll', args),
    presentResult: resultPresentation('Lavish poll'),
  }))

  options.register(defineTool({
    name: 'gotry_lavish_reply',
    description: 'Send one bounded visible reply and wait once for the next untrusted Lavish feedback state.',
    parameters: {
      path: { type: 'string', required: true, description: 'Previously opened HTML/HTM artifact path' },
      reply: { type: 'string', required: true, description: 'Visible reply text' },
      timeoutMs: { type: 'integer', description: 'Optional bounded positive poll timeout in milliseconds' },
    },
    output: outputPresentation('Lavish reply'),
    async execute(args, exec) {
      return runActive(exec, async record => {
        if (!record.session) return failure('lavish-session-missing', 'call gotry_lavish_open first')
        const result = await record.session.reply(
          args.path,
          args.reply,
          args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs },
        )
        return finishCommand(record, result)
      })
    },
    presentCall: args => callPresentation('Lavish reply', args),
    presentResult: resultPresentation('Lavish reply'),
  }))

  options.register(defineTool({
    name: 'gotry_lavish_end',
    description: 'End the current Lavish review session while retaining the owned server handle for explicit stop or host disposal cleanup.',
    parameters: { path: { type: 'string', required: true, description: 'Previously opened HTML/HTM artifact path' } },
    output: outputPresentation('Lavish end'),
    async execute(args, exec) {
      return runActive(exec, async record => {
        if (!record.session) return failure('lavish-session-missing', 'call gotry_lavish_open first')
        const result = await record.session.end(args.path)
        return finishEnd(record, result)
      })
    },
    presentCall: args => callPresentation('Lavish end', args),
    presentResult: resultPresentation('Lavish end'),
  }))

  options.register(defineTool({
    name: 'gotry_lavish_stop',
    description: 'Terminally stop and reap only the Lavish server owned by this exact host session. Cleanup failure remains visible on later stop calls.',
    parameters: {},
    output: outputPresentation('Lavish stop'),
    async execute(_args, exec) {
      const authority = readAuthority(exec)
      if (!authority.ok) return failure('lavish-authority-rejected', authority.detail)
      let record = records.get(authority.id)
      if (record) {
        if (record.rawCwd !== authority.cwd) return failure('lavish-cwd-drift', `host session ${authority.id} is bound to a different raw cwd`)
        // Terminal before any await: an in-flight create/open cannot publish success afterwards.
        record.terminal = record.terminal ?? 'stopped'
      } else {
        if (disposedIds.has(authority.id)) {
          return present({ ok: true, kind: 'stop', status: 'not-running', ownedServerExited: true })
        }
        const bound = await bind(exec)
        if (!isRecord(bound)) return bound
        record = bound
        record.terminal = 'stopped'
      }
      return enqueue(record, async () => present(await cleanup(record!)))
    },
    presentCall: args => callPresentation('Lavish stop', args),
    presentResult: resultPresentation('Lavish stop'),
  }))

  const ctxOn = (options.ctx as unknown as { on?: unknown }).on
  if (typeof ctxOn === 'function') {
    ;(ctxOn as (event: string, listener: (subject: unknown) => Promise<void>) => unknown).call(
      options.ctx,
      'session/disposed',
      async subject => {
        const id = disposedSubjectId(subject)
        if (!id) return
        disposedIds.add(id)
        const record = records.get(id)
        if (!record) return
        // Terminal before any await: queued and in-flight commands re-check this state.
        record.terminal = 'disposed'
        await enqueue(record, async () => { await cleanup(record) })
      },
    )
  }

  const ctxEffect = (options.ctx as unknown as { effect?: unknown }).effect
  if (typeof ctxEffect === 'function') {
    ;(ctxEffect as (effect: () => () => Promise<void>, label?: string) => unknown).call(
      options.ctx,
      () => async () => {
        // Synchronous registrar closure before any await: a bind() call that
        // is currently awaiting realpath (or about to start one) must observe
        // the closed flag and refuse to create a new record, regardless of
        // whether the bind target id is fresh or already known. This is the
        // only point where closed becomes true.
        closed = true
        const active = [...records.values()]
        // Freeze every record before awaiting any queue, so unload cannot race a late command.
        for (const record of active) {
          disposedIds.add(record.id)
          record.terminal = 'disposed'
        }
        const results = await Promise.all(active.map(record => enqueue(record, () => cleanup(record))))
        const unreaped = results.filter(result => !result.ok || result.ownedServerExited !== true)
        if (unreaped.length > 0) {
          throw new Error(`Lavish plugin cleanup failed: ${unreaped.map(item => item.ok ? item.status : item.code).join(', ')}`)
        }
      },
      'gotry-lavish-lifecycle',
    )
  }

  return { registered: true }
}

function enqueue<T>(record: SessionRecord, operation: () => Promise<T>): Promise<T> {
  const result = record.tail.then(operation)
  record.tail = result.then(() => undefined, () => undefined)
  return result
}

async function cleanup(record: SessionRecord): Promise<LavishStopResult | LavishLocalFailure> {
  if (record.stopResult) return record.stopResult
  if (record.cleanup) return record.cleanup
  if (!record.session) {
    const result: LavishStopResult = { ok: true, kind: 'stop', status: 'not-running', ownedServerExited: true }
    record.stopResult = result
    return result
  }
  const session = record.session
  record.cleanup = (async () => {
    try {
      const result = await session.stop()
      record.stopResult = result
      return result
    } catch (error) {
      const result: LavishLocalFailure = {
        ok: false,
        kind: 'error',
        code: 'command-failed',
        detail: error instanceof Error ? error.message : 'Lavish cleanup failed',
      }
      record.stopResult = result
      return result
    }
  })()
  return record.cleanup
}

function latchAdapterTerminal(record: SessionRecord, result: object): void {
  // Host-authority terminals (stopped/disposed) and explicit 'ended' are
  // precedence-preserving; adapter signals (user-ended / poll-outcome-unknown)
  // must not overwrite them.
  if (record.terminal === 'disposed' || record.terminal === 'stopped' || record.terminal === 'ended') return
  const state = record.session?.state()
  const view = result as unknown as JsonObject
  if (state?.pollOutcomeUnknown) record.terminal = 'poll-outcome-unknown'
  else if (state?.userEnded) record.terminal = 'user-ended'
  if (result && typeof result === 'object') {
    if (view.code === 'poll-outcome-unknown') record.terminal = 'poll-outcome-unknown'
    if (view.code === 'session-user-ended') record.terminal = 'user-ended'
    if (view.sessionEnded === true && view.endedBy === 'user') record.terminal = 'user-ended'
    if (view.status === 'ended' && view.endedBy === 'user') record.terminal = 'user-ended'
  }
}

function readAuthority(exec: unknown): { ok: true; id: string; cwd: string } | { ok: false; detail: string } {
  const candidate = exec as { agent?: { session?: { id?: unknown; header?: { cwd?: unknown } } } } | null
  const id = candidate?.agent?.session?.id
  if (typeof id !== 'string' || id.trim().length === 0) {
    return { ok: false, detail: 'exec.agent.session.id is required; agent.id fallback is forbidden' }
  }
  const cwd = candidate?.agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || cwd.trim().length === 0 || !isAbsolute(cwd)) {
    return { ok: false, detail: 'exec.agent.session.header.cwd must be a nonblank absolute path' }
  }
  return { ok: true, id, cwd }
}

function disposedSubjectId(subject: unknown): string | null {
  if (!subject || typeof subject !== 'object') return null
  const id = (subject as { id?: unknown }).id
  return typeof id === 'string' && id.trim().length > 0 ? id : null
}

function isRecord(value: SessionRecord | JsonObject): value is SessionRecord {
  return 'rawCwd' in value && 'canonicalCwd' in value && 'tail' in value
}

function isSession(value: LavishLocalSession | JsonObject): value is LavishLocalSession {
  return value instanceof LavishLocalSession
}

function terminalFailure(record: SessionRecord): JsonObject {
  return failure('lavish-session-terminal', `host session ${record.id} is terminal: ${record.terminal ?? 'unknown'}`)
}

function failure(code: string, detail: string): JsonObject {
  return { ok: false, code, error: detail, summary: `${code}: ${detail}`.slice(0, 800) }
}

function present(result: object): JsonObject {
  const view = result as unknown as JsonObject
  if (!view.ok) {
    const detail = String(view.detail ?? view.error ?? 'Lavish operation failed')
    return { ...view, error: detail, summary: `${String(view.code ?? 'lavish-error')}: ${detail}`.slice(0, 800) }
  }
  const summary = view.kind === 'open'
    ? `Lavish opened ${String(view.file ?? '')} at ${String(view.url ?? '')}`
    : `Lavish ${String(view.kind ?? 'operation')}: ${String(view.status ?? 'ok')}`
  return { ...view, summary }
}

function outputPresentation(title: string) {
  return {
    schema: { type: 'json' as const },
    // The model needs the usable loopback URL and actual bounded feedback fields.
    // Adapter feedback remains explicitly tagged `trust: "untrusted"` in this JSON.
    render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: renderValue(value, title) }],
  }
}

function callPresentation(title: string, args: unknown) {
  return { card: 'generic' as const, title, kind: 'execute' as const, rawInput: args }
}

function resultPresentation(title: string) {
  return (_args: unknown, value: unknown) => ({
    card: 'generic' as const,
    title,
    content: [{ type: 'text' as const, text: renderValue(value, title) }],
  })
}

function renderValue(value: unknown, fallback: string): string {
  try { return JSON.stringify(value).slice(0, 128 * 1024) }
  catch { return String((value as { summary?: unknown })?.summary ?? fallback) }
}
