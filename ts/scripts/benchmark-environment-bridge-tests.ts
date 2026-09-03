import assert from 'node:assert/strict'
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { apply, type Config } from '../src/index.ts'
import { registerBenchmarkEnvironmentBridge } from '../src/benchmark-environment-bridge.ts'
import { installBenchmarkToolIsolation } from '../src/benchmark-tool-isolation.ts'
import {
  BENCHMARK_BRIDGE_CALL_FAILED,
  BENCHMARK_BRIDGE_CALL_REQUIRED,
  BENCHMARK_BRIDGE_RETRY_CALL_NOT_ALLOWED,
  BENCHMARK_BRIDGE_OUTPUT_TRUNCATED,
  BENCHMARK_BRIDGE_RUNNER_FAILED,
  BENCHMARK_BRIDGE_SPAWN_FAILED,
  BENCHMARK_BRIDGE_TIMED_OUT,
  BENCHMARK_CONFORMANCE_STATE_UNAVAILABLE,
  BENCHMARK_TERMINAL_INVALID,
  MAX_CONFORMANCE_RETRIES,
  benchmarkChildFailureForConformanceCode,
  createBenchmarkAgentConformance,
  installBenchmarkAgentConformance,
  parseBenchmarkTerminal,
  validateTerminalOutputConfig,
} from '../src/benchmark-agent-conformance.ts'
import {
  BENCHMARK_CHILD_DIAGNOSTIC_MAX_BYTES,
  BENCHMARK_CHILD_DIAGNOSTIC_SCHEMA,
  appendBoundedChildDiagnostic,
  classifyBenchmarkChildFailure,
  classifyBenchmarkTurnEnd,
  createBenchmarkDiagnosticArbiter,
  parseBenchmarkChildDiagnostic,
} from '../src/benchmark-headless-child-diagnostics.ts'

// Round 6 RED tests: terminal facts must be classified from the structured
// turn/end envelope, without consulting stderr or reflecting its body.
{
  const exactFamilies: Array<[string[], string]> = [
    [['AUTH', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL'], 'child_model_auth'],
    [['QUOTA', 'RATE_LIMIT'], 'child_model_capacity'],
    [['SERVER'], 'child_model_server'],
    [['TRANSPORT', 'TIMEOUT'], 'child_model_transport'],
    [['EMPTY_RESPONSE', 'STREAM_CLOSED', 'MALFORMED_RESPONSE', 'INVALID_RESPONSE'], 'child_model_stream'],
    [['INVALID_REQUEST', 'CONTEXT_WINDOW_EXCEEDED', 'NO_ADAPTER', 'UNKNOWN_MODEL', 'UNSUPPORTED_OPTION'], 'child_model_request'],
    [['ABORTED'], 'child_aborted'],
  ]
  for (const [codes, expected] of exactFamilies) {
    for (const code of codes) assert.equal(classifyBenchmarkTurnEnd({ kind: 'error', error: { code } }), expected)
  }
  assert.equal(classifyBenchmarkTurnEnd({ kind: 'error', error: { code: 'RATE_LIMIT', message: 'sentinel' } }), 'child_model_capacity')
  assert.equal(classifyBenchmarkTurnEnd({ kind: 'error', error: { code: 'AUTH', message: 'sentinel' } }), 'child_model_auth')
  assert.equal(classifyBenchmarkTurnEnd({ kind: 'error', error: { code: 'MISSING_CREDENTIAL', message: 'sentinel' } }), 'child_model_auth')
  assert.equal(classifyBenchmarkTurnEnd({ kind: 'error', error: { code: 'QUOTA', message: 'sentinel' } }), 'child_model_capacity')
  assert.equal(classifyBenchmarkTurnEnd({ kind: 'error', error: { code: 'SERVER', message: 'sentinel' } }), 'child_model_server')
  assert.equal(classifyBenchmarkTurnEnd({ kind: 'error', error: { code: 'TRANSPORT', message: 'api-key sentinel' } }), 'child_model_transport')
  assert.equal(classifyBenchmarkTurnEnd({ kind: 'error', error: { code: 'OTHER', status: 401, message: 'key sentinel' } }), 'child_model_auth')
  assert.equal(classifyBenchmarkTurnEnd({ kind: 'error', error: { code: 'OTHER', status: 403, message: 'key sentinel' } }), 'child_model_auth')
  assert.equal(classifyBenchmarkTurnEnd({ kind: 'error', error: { code: 'OTHER', status: 429, message: 'quota sentinel' } }), 'child_model_capacity')
  assert.equal(classifyBenchmarkTurnEnd({ kind: 'error', error: { code: 'OTHER', status: 503, message: 'server sentinel' } }), 'child_model_server')
  assert.equal(classifyBenchmarkTurnEnd({ kind: 'error', error: { code: 'OTHER', status: 500, message: 'server sentinel' } }), 'child_model_server')
  assert.equal(classifyBenchmarkTurnEnd({ kind: 'error', error: { code: 'OTHER', status: 599, message: 'server sentinel' } }), 'child_model_server')
  assert.equal(classifyBenchmarkTurnEnd({ kind: 'error', error: { code: 'PI_AI_ERROR', message: 'opaque' } }), 'child_runtime_error')
  assert.equal(classifyBenchmarkTurnEnd({ kind: 'error', error: { code: 'INVALID_RESPONSE', message: 'opaque' } }), 'child_model_stream')
  assert.equal(classifyBenchmarkTurnEnd({ kind: 'error', error: { code: 'UNSUPPORTED_OPTION', message: 'opaque' } }), 'child_model_request')
  assert.equal(classifyBenchmarkTurnEnd({ kind: 'error', error: { code: 'OTHER', status: 503.5, message: 'opaque' } }), 'child_runtime_error')
  assert.equal(classifyBenchmarkTurnEnd({ kind: 'error', error: { code: 'OTHER', status: 99, message: 'opaque' } }), 'child_runtime_error')
  assert.equal(classifyBenchmarkTurnEnd({ kind: 'error', error: { code: 'OTHER', status: 600, message: 'opaque' } }), 'child_runtime_error')
  assert.equal(classifyBenchmarkTurnEnd({ kind: 'error', error: { code: 'rate_limit', message: 'opaque' } }), 'child_runtime_error')
  assert.equal(classifyBenchmarkTurnEnd({ kind: 'error', error: { code: 'UNKNOWN', message: 'opaque' } }), 'child_runtime_error')
  assert.equal(classifyBenchmarkTurnEnd({ kind: 'error', error: { code: 'UNKNOWN', message: 'message sentinel', requestId: 'request sentinel', path: 'path sentinel', prompt: 'prompt sentinel', key: 'key sentinel' } }), 'child_runtime_error')
  assert.equal(classifyBenchmarkTurnEnd({ kind: 'blocked' }), 'child_blocked')
  assert.equal(classifyBenchmarkTurnEnd({ kind: 'max-tokens' }), 'child_max_tokens')
  assert.equal(classifyBenchmarkTurnEnd({ kind: 'aborted' }), 'child_aborted')
  assert.equal(classifyBenchmarkTurnEnd({ kind: 'interrupted' }), 'child_interrupted')
  assert.equal(classifyBenchmarkTurnEnd({ kind: 'completed' }), undefined)

  const writes: string[] = []
  const arbiter = createBenchmarkDiagnosticArbiter(code => writes.push(code))
  arbiter.offer('session-a', 'child_conformance_failure')
  arbiter.offer('session-a', 'child_runtime_error')
  arbiter.offer('session-a', 'child_bridge_failure')
  arbiter.offer('session-b', 'child_model_server')
  arbiter.flush('session-a')
  arbiter.flush('session-a')
  arbiter.flush('session-b')
  arbiter.flush('session-b')
  assert.deepEqual(writes, ['child_bridge_failure', 'child_model_server'])

}

type RegisteredTool = {
  name: string
  description?: string
  parameters?: unknown
  execute?: (args: unknown, exec: unknown) => Promise<unknown>
}

type SpawnSpec = {
  argv: readonly string[]
  cwd: string
  stdio: {
    stdin: 'ignore' | 'pipe' | { data: string }
    stdout: { maxBytes: number }
    stderr: { maxBytes: number }
  }
  graceMs: number
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
}

type FakeOutcome = {
  stdout?: string
  stderr?: string
  lossy?: boolean
  exitCode?: number | null
  signal?: string | null
  spawnError?: boolean
  spawnReject?: boolean
  waitForAbort?: boolean
}

assert.equal(MAX_CONFORMANCE_RETRIES, 1)
const projection = {
  toolName: 'gotry_benchmark_environment',
  allowedTools: ['lookup'],
  terminal: { tag: 'done', max_bytes: 1024 },
} as const

assert.equal(validateTerminalOutputConfig(projection.terminal), true)
for (const invalid of [
  null,
  { tag: 'done' },
  { tag: '1bad', max_bytes: 1024 },
  { tag: 'done', max_bytes: 0 },
  { tag: 'done', max_bytes: 1024 * 1024 + 1 },
  { tag: 'done', max_bytes: 1024, extra: true },
]) assert.equal(validateTerminalOutputConfig(invalid), false)

assert.deepEqual(parseBenchmarkTerminal(' \n<done>{"ok":true}</done>\n', projection.terminal), { ok: true, value: { ok: true } })
for (const invalid of [
  'prose <done>{"ok":true}</done>',
  '<done>{"ok":true}</done> trailing',
  '<done>```json\n{"ok":true}\n```</done>',
  '<done>{"ok":true}</done><done>{"ok":true}</done>',
  '<done>{"value":"</done><done>"}</done>',
  '<wrong>{"ok":true}</wrong>',
  '<done>[{"ok":true}]</done>',
  '<done>true</done>',
  '<done>{"ok":</done>',
]) assert.equal(parseBenchmarkTerminal(invalid, projection.terminal).ok, false)
assert.equal(parseBenchmarkTerminal(`<done>{"x":"${'y'.repeat(1024)}"}</done>`, projection.terminal).ok, false)

function turnStart(turn = 1) {
  return { type: 'turn/start', data: { turn } }
}
function turnEnd(turn = 1) {
  return { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } }
}
function toolCall(callId = 'call-1', options: { turn?: number; step?: number; action?: string; tool?: string } = {}) {
  const { turn = 1, step = 1, action = 'call', tool = 'lookup' } = options
  return {
    type: 'tool/call',
    data: {
      turn,
      step,
      callId,
      name: projection.toolName,
      arguments: JSON.stringify({ query: { action, tool, arguments: {} } }),
    },
  }
}
function toolResult(callId = 'call-1', options: { turn?: number; step?: number; ok?: boolean; isError?: boolean; error?: string } = {}) {
  const { turn = 1, step = 1, ok = true, isError = false, error = 'runner_failed' } = options
  return {
    type: 'tool/result',
    data: {
      turn,
      step,
      message: {
        source: { kind: 'tool', callId },
        content: [{
          type: 'tool-result',
          toolCallId: callId,
          isError,
          content: [{ type: 'text', text: JSON.stringify(ok ? { ok: true, result: {} } : { ok: false, error }) }],
        }],
      },
    },
  }
}
function assistant(text: string, options: { turn?: number; step?: number; interrupted?: boolean } = {}) {
  const { turn = 1, step = 2, interrupted = false } = options
  return {
    type: 'assistant/message',
    data: {
      turn,
      step,
      message: { content: [{ type: 'text', text }] },
      ...(interrupted ? { interrupted: true } : {}),
    },
  }
}

{
  const state = createBenchmarkAgentConformance(projection)
  state.observe(turnStart())
  state.observe(assistant('I would run the CLI.', { step: 1 }))
  assert.deepEqual(state.stopping(1), { kind: 'steer', mode: 'call' }, 'no-call first stop gets one correction')
  assert.equal(state.guardBridgeExecution(), undefined, 'call correction still permits the first real bridge dispatch')
  state.observe(toolCall('call-a', { step: 2 }))
  state.observe(toolResult('call-a', { step: 2 }))
  state.observe(assistant('<done>{"status":"succeeded"}</done>', { step: 3 }))
  assert.deepEqual(state.stopping(1), { kind: 'accept' }, 'call correction may converge to one successful terminal')
}
{
  const state = createBenchmarkAgentConformance(projection)
  state.observe(turnStart())
  state.observe(assistant('<done>{"status":"succeeded"}</done>', { step: 1 }))
  assert.deepEqual(state.stopping(1), { kind: 'steer', mode: 'call' }, 'valid terminal without a call still needs a call')
  state.observe(assistant('<done>{"status":"succeeded"}</done>', { step: 2 }))
  assert.deepEqual(state.stopping(1), { kind: 'reject', code: BENCHMARK_BRIDGE_CALL_REQUIRED })
}
{
  const state = createBenchmarkAgentConformance(projection)
  state.observe(turnStart())
  state.observe(toolCall())
  state.observe(toolResult())
  state.observe(assistant('bad terminal'))
  assert.deepEqual(state.stopping(1), { kind: 'steer', mode: 'terminal' }, 'bad terminal gets one format-only correction')
  assert.equal(state.guardBridgeExecution(), BENCHMARK_BRIDGE_RETRY_CALL_NOT_ALLOWED)
  state.observe(assistant('<done>{"status":"succeeded"}</done>', { step: 3 }))
  assert.deepEqual(state.stopping(1), { kind: 'accept' }, 'format-only correction can reuse the successful result')
}
{
  const state = createBenchmarkAgentConformance(projection)
  state.observe(turnStart())
  state.observe(toolCall())
  state.observe(toolResult())
  state.observe(assistant('bad terminal'))
  assert.deepEqual(state.stopping(1), { kind: 'steer', mode: 'terminal' })
  state.observe(toolCall('call-2', { step: 3 }))
  assert.deepEqual(state.stopping(1), { kind: 'reject', code: BENCHMARK_BRIDGE_RETRY_CALL_NOT_ALLOWED })
}
{
  const state = createBenchmarkAgentConformance(projection)
  state.observe(turnStart())
  state.observe(toolCall())
  state.observe(toolResult())
  state.observe(assistant('bad terminal'))
  assert.deepEqual(state.stopping(1), { kind: 'steer', mode: 'terminal' })
  state.observe(assistant('still bad', { step: 3 }))
  assert.deepEqual(state.stopping(1), { kind: 'reject', code: BENCHMARK_TERMINAL_INVALID })
}
{
  const state = createBenchmarkAgentConformance(projection)
  state.observe(turnStart())
  state.observe(toolCall())
  state.observe(toolResult('call-1', { ok: false }))
  assert.deepEqual(state.stopping(1), { kind: 'reject', code: BENCHMARK_BRIDGE_RUNNER_FAILED }, 'structured runner failure is not retried')
}
{
  const state = createBenchmarkAgentConformance(projection)
  state.observe(turnStart())
  state.observe(toolCall())
  state.observe(toolResult('call-1', { ok: false, error: 'output_truncated' }))
  assert.deepEqual(state.stopping(1), { kind: 'reject', code: BENCHMARK_BRIDGE_OUTPUT_TRUNCATED }, 'structured runner truncation has a distinct reason')
}
{
  const state = createBenchmarkAgentConformance(projection)
  state.observe(turnStart())
  state.observe(toolCall('failed', { step: 1 }))
  state.observe(toolResult('failed', { step: 1, ok: false }))
  state.observe(toolCall('successful', { step: 2 }))
  state.observe(toolResult('successful', { step: 2 }))
  state.observe(assistant('<done>{"status":"succeeded"}</done>', { step: 3 }))
  assert.deepEqual(state.stopping(1), { kind: 'accept' }, 'a model-owned later success can recover from an earlier failed call without a conformance retry')
}
{
  const state = createBenchmarkAgentConformance(projection)
  state.observe(turnStart())
  state.observe(toolCall('successful', { step: 1 }))
  state.observe(toolResult('successful', { step: 1 }))
  state.observe(toolCall('failed', { step: 2 }))
  state.observe(toolResult('failed', { step: 2, ok: false }))
  state.observe(assistant('<done>{"status":"succeeded"}</done>', { step: 3 }))
  assert.deepEqual(state.stopping(1), { kind: 'accept' }, 'a later failed optional call does not erase an already paired successful result')
}
{
  const state = createBenchmarkAgentConformance(projection)
  state.observe(turnStart())
  state.observe(toolCall('discovery', { action: 'tools' }))
  state.observe(toolResult('discovery'))
  state.observe(assistant('<done>{"status":"succeeded"}</done>'))
  assert.deepEqual(state.stopping(1), { kind: 'steer', mode: 'call' }, 'action tools does not satisfy the call gate')
  state.observe(turnEnd())
  assert.deepEqual(state.stopping(1), { kind: 'reject', code: BENCHMARK_CONFORMANCE_STATE_UNAVAILABLE })
  state.observe(turnStart(2))
  assert.deepEqual(state.stopping(1), { kind: 'reject', code: BENCHMARK_CONFORMANCE_STATE_UNAVAILABLE }, 'turn state cannot leak across turns')
}

{
  const rootListeners = new Map<string, Array<(...args: any[]) => unknown>>()
  const scopedListeners = new Map<string, Array<(...args: any[]) => unknown>>()
  const guards: Array<(execution: { name: string }) => string | undefined> = []
  const steers: unknown[] = []
  const runtimeWrites: string[] = []
  const runEffect = (action: () => unknown) => {
    const disposers: Array<() => unknown> = []
    const value = action()
    if (value && typeof (value as { next?: unknown }).next === 'function') {
      let item = (value as Generator<unknown>).next()
      while (!item.done) {
        if (typeof item.value === 'function') disposers.push(item.value as () => unknown)
        item = (value as Generator<unknown>).next()
      }
    }
    return () => { for (const dispose of disposers.reverse()) dispose() }
  }
  const add = (target: Map<string, Array<(...args: any[]) => unknown>>, name: string, listener: (...args: any[]) => unknown) => {
    const list = target.get(name) ?? []
    list.push(listener)
    target.set(name, list)
    return () => target.set(name, list.filter(candidate => candidate !== listener))
  }
  const session = {}
  const agent = {
    session,
    steer(message: unknown) { steers.push(message) },
    ctx: {
      tools: { guard(check: (execution: { name: string }) => string | undefined) { guards.push(check); return () => {} } },
      effect: runEffect,
      on(name: string, listener: (...args: any[]) => unknown) { return add(scopedListeners, name, listener) },
    },
  }
  const ctx = {
    on(name: string, listener: (...args: any[]) => unknown) { return add(rootListeners, name, listener) },
  } as unknown as Context
  installBenchmarkAgentConformance(ctx, projection, code => runtimeWrites.push(code))
  rootListeners.get('agent/created')![0]!({ agent })
  rootListeners.get('session/event')![0]!(session, turnStart())
  rootListeners.get('session/event')![0]!(session, { type: 'llm/retry', data: { turn: 1, reason: { kind: 'error', error: { code: 'RATE_LIMIT' } } } })
  rootListeners.get('session/event')![0]!(session, { type: 'agent/request-error', data: { turn: 1, error: { code: 'SERVER' } } })
  rootListeners.get('session/event')![0]!(session, assistant('prose only', { step: 1 }))
  rootListeners.get('agent/turn-stopping')![0]!({ agent, turn: 1 })
  assert.equal(steers.length, 1, 'runtime wiring steers exactly once at the stop boundary')
  assert.equal((steers[0] as { role?: unknown }).role, 'user')
  assert.equal(Object.isFrozen(steers[0]), true, 'correction uses the official immutable DSH user message')
  assert.equal(Object.isFrozen((steers[0] as { content: unknown }).content), true, 'correction content is deeply frozen')
  assert.equal(guards[0]!({ name: projection.toolName }), undefined, 'call correction leaves bridge execution available')
  const assembled = await scopedListeners.get('system-prompt/assemble')![0]!({}, {}, async () => ({ sections: [], tools: [] })) as { sections: Array<{ text: string }> }
  assert.match(assembled.sections[0]!.text, /agent_env\.cli/)
  assert.match(assembled.sections[0]!.text, /\"action\":\"call\"/)
  assert.match(assembled.sections[0]!.text, /<done>/)
  assert.equal(assembled.sections[0]!.text.includes('/tmp/'), false)

  // Intermediate retry/request errors never write; only final completed observes recovery.
  rootListeners.get('session/event')![0]!(session, turnEnd())
  assert.deepEqual(runtimeWrites, [])

  // A final structured model error writes exactly once, despite duplicate end/dispose.
  rootListeners.get('session/event')![0]!(session, turnStart(2))
  rootListeners.get('session/event')![0]!(session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'error', error: { code: 'SERVER', message: 'sentinel' } } } })
  rootListeners.get('session/event')![0]!(session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'error', error: { code: 'UNKNOWN_MODEL' } } } })
  assert.deepEqual(runtimeWrites, ['child_model_server'])

  rootListeners.get('session/disposed')![0]!(session)

  // A malformed stopping payload with a valid session is arbited above a later generic error.
  const session2 = {}
  const agent2 = { session: session2, steer() {}, ctx: agent.ctx }
  rootListeners.get('agent/created')![0]!({ agent: agent2 })
  rootListeners.get('session/event')![0]!(session2, turnStart())
  assert.throws(() => rootListeners.get('agent/turn-stopping')![0]!({ agent: agent2 }), new RegExp(BENCHMARK_CONFORMANCE_STATE_UNAVAILABLE))
  rootListeners.get('session/event')![0]!(session2, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { code: 'UNKNOWN' } } } })
  assert.deepEqual(runtimeWrites, ['child_model_server', 'child_conformance_failure'])
  rootListeners.get('session/disposed')![0]!(session2)

  const session3 = {}
  const agent3 = { session: session3, steer() {}, ctx: agent.ctx }
  rootListeners.get('agent/created')![0]!({ agent: agent3 })
  rootListeners.get('session/event')![0]!(session3, turnStart())
  rootListeners.get('session/event')![0]!(session3, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { code: 'TIMEOUT' } } } })
  assert.deepEqual(runtimeWrites, ['child_model_server', 'child_conformance_failure', 'child_model_transport'], 'session diagnostics remain isolated')
  rootListeners.get('session/disposed')![0]!(session3)
}

function fakeHandle(outcome: FakeOutcome) {
  const stdout = outcome.stdout ?? ''
  const stderr = outcome.stderr ?? ''
  const reader = { readFrom: (_offset: number) => ({ text: stdout, nextOffset: Buffer.byteLength(stdout), lossy: outcome.lossy ?? false }) }
  const errorReader = { readFrom: (_offset: number) => ({ text: stderr, nextOffset: Buffer.byteLength(stderr), lossy: false }) }
  let rejectDone: ((error: Error) => void) | undefined
  const done = outcome.spawnReject
    ? Promise.reject(new Error('spawn rejected'))
    : outcome.waitForAbort
    ? new Promise<{ exitCode: number | null; signal: string | null }>((_resolve, reject) => { rejectDone = reject })
    : Promise.resolve({ exitCode: outcome.exitCode ?? 0, signal: outcome.signal ?? null })
  return {
    pid: outcome.spawnReject ? -1 : 4242,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    collected: { stdout: reader, stderr: errorReader },
    done,
    terminate() { if (outcome.waitForAbort) rejectDone?.(new Error('timed out')) },
    waitForExit: async () => true,
  }
}

async function assertRealCordisWaterfallOrdering(): Promise<void> {
  const ctx = new Context()
  const bridge = {
    name: 'gotry_benchmark_environment',
    description: 'benchmark bridge',
    parameters: { query: { type: 'json', required: true } },
  }
  const exactSchema = structuredClone(bridge)
  let addPreStepTool = false
  const rootTools = {
    get(name: string) { return name === bridge.name ? bridge : undefined },
    schemas(agent?: unknown) {
      return agent && addPreStepTool ? [exactSchema, { name: 'non_bridge' }] : [exactSchema]
    },
  }
  ctx.provide('tools', rootTools)
  ctx.provide('agents', { list: () => [] })
  const bus = ctx as unknown as {
    on: (event: string, listener: (...args: any[]) => unknown, options?: { prepend?: boolean }) => unknown
    emit: (event: string, payload: unknown) => void
    waterfall: (event: string, ...args: any[]) => Promise<unknown>
  }
  bus.on('system-prompt/assemble', async (_assembly, _context, next: () => Promise<{ tools: unknown[] }>) => {
    const result = await next()
    return { ...result, tools: [...result.tools, { name: 'non_bridge' }] }
  })
  bus.on('agent/pre-step', async (_payload, next: () => Promise<unknown>) => {
    const result = await next()
    addPreStepTool = true
    return result
  })
  installBenchmarkToolIsolation(ctx)

  const scopedEffect = (action: () => unknown, label?: string) => ctx.effect(action as never, label)
  const scopedTools = {
    guard: () => ctx.effect(() => () => undefined),
    presentAs: () => ctx.effect(() => () => undefined),
    restrict: () => ctx.effect(() => () => undefined),
  }
  const agent = { ctx: { tools: scopedTools, effect: scopedEffect, on: bus.on } }
  bus.emit('agent/created', { agent })
  await assert.rejects(
    bus.waterfall('system-prompt/assemble', { tools: [] }, { agent, scope: agent }, async () => ({ tools: [exactSchema] })),
    /BENCHMARK_TOOL_SURFACE_VIOLATION/,
    'prepend assembly guard observes an earlier listener post-next mutation',
  )
  await assert.rejects(
    bus.waterfall('agent/pre-step', { agent }, async () => ({ kind: 'enter' })),
    /BENCHMARK_TOOL_SURFACE_VIOLATION/,
    'prepend pre-step guard observes an earlier listener post-next scope mutation',
  )
  await ctx.fiber.dispose()
}

await assertRealCordisWaterfallOrdering()

const root = mkdtempSync(join(tmpdir(), 'gotry-benchmark-bridge-test-'))
const ambientSentinelNames = [
  'GOTRY_BENCHMARK_BRIDGE_PARENT_SENTINEL',
  'GOTRY_LLM_MODEL',
  'DATABASE_URL',
  'SSH_AUTH_SOCK',
  'AWS_PROFILE',
  'HTTPS_PROXY',
] as const
const ambientSentinels = new Map(ambientSentinelNames.map(name => [name, process.env[name]]))
try {
  delete process.env.GOTRY_LLM_MODEL
  const timedOutDiagnostic = '\n' + JSON.stringify({
    schema_version: BENCHMARK_CHILD_DIAGNOSTIC_SCHEMA,
    code: 'child_bridge_timed_out',
  }) + '\n'
  assert.equal(
    parseBenchmarkChildDiagnostic(timedOutDiagnostic),
    'child_bridge_timed_out',
    'strict control record parses to its allowlisted reason code',
  )
  assert.equal(
    classifyBenchmarkChildFailure({ code: 1, diagnostic: timedOutDiagnostic }),
    'child_bridge_timed_out',
    'structured control data maps to a stable bridge timeout code',
  )
  assert.equal(
    classifyBenchmarkChildFailure({ code: 1, diagnostic: `provider text contains child_bridge_timed_out and ${BENCHMARK_BRIDGE_TIMED_OUT}` }),
    'child_nonzero_exit',
    'free text cannot impersonate a structured bridge reason',
  )
  assert.equal(
    parseBenchmarkChildDiagnostic(JSON.stringify({ schema_version: BENCHMARK_CHILD_DIAGNOSTIC_SCHEMA, code: 'child_bridge_timed_out', extra: 'rejected' })),
    undefined,
    'control records with extra keys fail closed',
  )
  assert.equal(
    benchmarkChildFailureForConformanceCode(BENCHMARK_BRIDGE_RUNNER_FAILED),
    'child_bridge_runner_failed',
    'runner failure maps to a stable structured child reason',
  )
  assert.equal(
    benchmarkChildFailureForConformanceCode(BENCHMARK_BRIDGE_SPAWN_FAILED),
    'child_bridge_spawn_failed',
    'spawn failure maps to a stable structured child reason',
  )
  assert.equal(
    benchmarkChildFailureForConformanceCode(BENCHMARK_BRIDGE_OUTPUT_TRUNCATED),
    'child_bridge_output_truncated',
    'runner output truncation maps to a stable structured child reason',
  )
  assert.equal(
    classifyBenchmarkChildFailure({ code: 0, outputTruncated: true }),
    'child_output_truncated',
    'truncated terminal output takes precedence over control data',
  )
  assert.equal(
    classifyBenchmarkChildFailure({ code: null, signal: 'SIGTERM', diagnostic: timedOutDiagnostic }),
    'child_signaled',
    'outer child signal takes precedence over an inner bridge diagnostic',
  )
  assert.equal(
    classifyBenchmarkChildFailure({ code: 0, diagnostic: '' }),
    'child_lifecycle_failure',
    'unexpected zero-exit diagnostic path remains a stable lifecycle failure',
  )
  const noisyPrefix = Buffer.alloc(BENCHMARK_CHILD_DIAGNOSTIC_MAX_BYTES + 10, 'x')
  const boundedControl = appendBoundedChildDiagnostic(
    appendBoundedChildDiagnostic(Buffer.alloc(0), noisyPrefix),
    timedOutDiagnostic,
  )
  assert.equal(boundedControl.length, BENCHMARK_CHILD_DIAGNOSTIC_MAX_BYTES, 'control capture is bounded')
  assert.equal(parseBenchmarkChildDiagnostic(boundedControl.toString('utf8')), 'child_bridge_timed_out', 'rolling tail preserves a final structured reason after bounded noise')

  const configPath = join(root, 'bridge.json')
  writeFileSync(configPath, JSON.stringify({
    schema_version: 'gotry_benchmark_environment_bridge_v2',
    enabled: true,
    executable: process.execPath,
    cwd: root,
    argv_prefix: ['-m', 'agent_env.cli', '--lang', 'en'],
    allowed_tools: ['lookup', 'constructor', 'toString'],
    allowed_output_keys: { lookup: ['city', 'nested'], constructor: ['legacy'] },
    timeout_ms: 20,
    max_output_bytes: 4_096,
    terminal_output: { tag: 'done', max_bytes: 4_096 },
    isolation: {
      mode: 'host-enforced',
      writes: 'forbidden',
      network: 'denied',
    },
  }))

  const registered: RegisteredTool[] = []
  let visibleBridge: RegisteredTool | undefined
  let shadowedAgent: unknown
  const scopedExtraSchemas = new Map<unknown, unknown[]>()
  const spawnSpecs: SpawnSpec[] = []
  type ScopedAgentTools = {
    restrict?: (filter: { allow: string[] }) => unknown
    guard?: (check: (execution: { name: string; args?: unknown }) => string | undefined) => unknown
    presentAs?: (mode: 'native') => unknown
  }
  type AgentCreated = { agent: { session?: object; steer?: (message: unknown) => void; ctx: { tools?: ScopedAgentTools; effect?: (action: () => unknown) => unknown; on?: (event: string, listener: (...args: any[]) => unknown, options?: unknown) => unknown } } }
  const agentCreatedListeners: Array<(event: AgentCreated) => void> = []
  const eventNames: string[] = []
  const promptVariables: string[] = []
  const assemblyListeners: Array<(...args: any[]) => unknown> = []
  const preStepListeners: Array<(...args: any[]) => unknown> = []
  const disposedListeners: Array<(...args: any[]) => unknown> = []
  const eventOptions = new Map<string, unknown>()
  const runEffect = (action: () => unknown): (() => Promise<void>) => {
    const yielded: Array<() => unknown> = []
    const value = action()
    if (value && typeof (value as { next?: unknown }).next === 'function') {
      let step = (value as Generator<unknown>).next()
      while (!step.done) { if (typeof step.value === 'function') yielded.push(step.value as () => unknown); step = (value as Generator<unknown>).next() }
    }
    let active = true
    return async () => {
      if (!active) return
      active = false
      for (const dispose of yielded.reverse()) await dispose()
    }
  }
  let disposeRootIsolation: (() => Promise<void>) | undefined
  let timeoutSignal: AbortSignal | undefined
  const outcomes: FakeOutcome[] = [{ stdout: '{"result":[{"city":"Dubai"}]}' }]
  process.env.GOTRY_BENCHMARK_BRIDGE_PARENT_SENTINEL = 'must-not-cross-boundary'
  process.env.DATABASE_URL = 'postgres://secret'
  process.env.SSH_AUTH_SOCK = '/tmp/secret.sock'
  process.env.AWS_PROFILE = 'secret-profile'
  process.env.HTTPS_PROXY = 'https://secret-proxy'
  const ctx = {
    tools: {
      register(tool: RegisteredTool) {
        registered.push(tool)
        return () => {}
      },
      get(name: string, agent?: unknown) { return name === 'gotry_benchmark_environment' ? (agent !== undefined && agent === shadowedAgent ? { name } : registered.find(tool => tool.name === name)) : undefined },
      schemas(agent?: unknown) {
        const project = (tool: RegisteredTool) => ({ name: tool.name, description: tool.description, parameters: structuredClone(tool.parameters) })
        const schemas = registered.map(project)
        if (agent === undefined) return schemas
        return [...schemas.filter(schema => schema.name === 'gotry_benchmark_environment'), ...(scopedExtraSchemas.get(agent) ?? [])]
      },
    },
    systemPrompt: { variable(name: string) { promptVariables.push(name) } },
    on(event: string, listener: (event: AgentCreated) => void, options?: unknown) {
      eventNames.push(event)
      eventOptions.set(event, options)
      if (event === 'agent/created') agentCreatedListeners.push(listener)
      if (event === 'agent/disposed') disposedListeners.push(listener)
      if (event === 'system-prompt/assemble') assemblyListeners.push(listener)
      if (event === 'agent/pre-step') preStepListeners.push(listener)
      return () => {}
    },
    effect(action: () => unknown, label?: string) {
      const dispose = runEffect(action)
      if (label === 'benchmark-environment-tool-isolation') disposeRootIsolation = dispose
      return dispose
    },
    get(name: string) {
      if (name === 'subprocess') return (this as unknown as { subprocess: unknown }).subprocess
      if (name === 'agents') return (this as unknown as { agents: unknown }).agents
    },
    subprocess: {
      spawn(spec: SpawnSpec) {
        spawnSpecs.push(spec)
        const outcome = outcomes.shift() ?? { stdout: '{"result":{}}' }
        if (outcome.spawnError) throw new Error('fake spawn failed')
        if (outcome.waitForAbort) {
          timeoutSignal = spec.signal
          const handle = fakeHandle(outcome)
          spec.signal?.addEventListener('abort', () => handle.terminate?.(), { once: true })
          return handle
        }
        return fakeHandle(outcome)
      },
    },
    agents: { list() { return [] } },
  } as unknown as Context

  const coldStartListeners: string[] = []
  const coldStartRoot = { name: 'gotry_benchmark_environment' }
  assert.throws(
    () => installBenchmarkToolIsolation({
      tools: { get(name: string) { return name === 'gotry_benchmark_environment' ? coldStartRoot : undefined }, schemas() { return [{ name: 'gotry_benchmark_environment' }] } },
      agents: { list() { return [{ id: 'already-live' }] } },
      on(event: string) { coldStartListeners.push(event); return () => {} },
    } as unknown as Context),
    /cold-start|live-agent/i,
    'installing benchmark isolation with an existing agent fails hard',
  )
  assert.deepEqual(coldStartListeners, [], 'cold-start rejection does not register an isolation listener')

  const processListenersBeforeBenchmark = {
    uncaughtException: process.listenerCount('uncaughtException'),
    unhandledRejection: process.listenerCount('unhandledRejection'),
  }
  apply(ctx, {
    stateRoot: root,
    timeoutMs: 20,
    hbcliBin: '',
    sessionAccess: 'off',
    benchmarkEnvironmentConfigPath: configPath,
  } as Config & { benchmarkEnvironmentConfigPath: string })

  assert.ok(
    registered.some(tool => tool.name === 'gotry_benchmark_environment'),
    'an explicit valid owner-local config registers the benchmark environment bridge',
  )
  assert.deepEqual(
    registered.map(tool => tool.name),
    ['gotry_benchmark_environment'],
    'benchmark mode boots only the single bridge tool instead of the product tool catalog',
  )
  assert.deepEqual(promptVariables, [], 'benchmark mode does not install product prompt variables')
  assert.equal(eventNames.includes('tools/pre-execute'), false, 'benchmark mode does not install the product session-consent hook')
  assert.deepEqual(
    {
      uncaughtException: process.listenerCount('uncaughtException'),
      unhandledRejection: process.listenerCount('unhandledRejection'),
    },
    processListenersBeforeBenchmark,
    'benchmark mode does not install product process incident guards',
  )
  assert.deepEqual(
    [...eventNames].sort(),
    [
      'agent/created',
      'agent/created',
      'agent/disposed',
      'agent/disposed',
      'agent/pre-step',
      'agent/turn-stopping',
      'session/disposed',
      'session/disposed',
      'session/event',
      'session/event',
      'system-prompt/assemble',
      'tools/execute',
      'tools/post-execute',
    ],
    'benchmark root listeners come only from budget, isolation, and conformance when model override is unset',
  )
  visibleBridge = registered.find(tool => tool.name === 'gotry_benchmark_environment')!

  const restrictions: Array<{ allow: string[] }> = []
  const guards: Array<(execution: { name: string; args?: unknown }) => string | undefined> = []
  const presentations: string[] = []
  const cleanupCounts = { restrict: 0, guard: 0, presentAs: 0, assembly: 0 }
  const firstScopedAssemblyListeners: Array<(...args: any[]) => unknown> = []
  const scopedTools: ScopedAgentTools = {
    restrict(filter) { restrictions.push(filter); return () => { cleanupCounts.restrict += 1 } },
    guard(check) { guards.push(check); return () => { cleanupCounts.guard += 1 } },
    presentAs(mode) { presentations.push(mode); return () => { cleanupCounts.presentAs += 1 } },
  }
  assert.equal(agentCreatedListeners.length, 2, 'opt-in bridge installs exactly isolation and conformance agent listeners')
  const isolatedAgentEffects: Array<() => Promise<void>> = []
  const isolatedAgent = { session: {}, steer(_message: unknown) {}, ctx: {
    tools: scopedTools,
    effect: (action: () => unknown) => {
      const dispose = runEffect(action)
      isolatedAgentEffects.push(dispose)
      return dispose
    },
    on: (event: string, listener: (...args: any[]) => unknown, options?: unknown) => {
      assert.equal(event, 'system-prompt/assemble')
      assert.deepEqual(options, { prepend: true })
      firstScopedAssemblyListeners.push(listener)
      return () => { cleanupCounts.assembly += 1 }
    },
  } }
  for (const listener of agentCreatedListeners) listener({ agent: isolatedAgent })
  assert.deepEqual(restrictions, [{ allow: ['gotry_benchmark_environment'] }], 'agent scope allows only the bridge tool')
  assert.deepEqual(presentations, ['native'], 'agent scope forces native tool presentation')
  assert.ok(eventNames.includes('agent/pre-step'), 'isolation observes pre-step before each request')
  assert.deepEqual(eventOptions.get('agent/pre-step'), { prepend: true }, 'pre-step isolation wraps every previously registered listener')
  assert.ok(eventNames.includes('agent/disposed'), 'isolation cleans up on agent disposal')
  assert.ok(assemblyListeners.length > 0, 'isolation validates final assembled tool surface')
  assert.equal(firstScopedAssemblyListeners.length, 2, 'agent owns one isolation assembly listener and one conformance section listener')
  assert.deepEqual(eventOptions.get('system-prompt/assemble'), { prepend: true }, 'assembly isolation wraps every previously registered listener')
  assert.equal(disposedListeners.length, 2, 'isolation and conformance each own one agent/disposed listener')
  assert.ok(disposeRootIsolation, 'root isolation effect exposes plugin-lifecycle cleanup')
  const exactSchema = {
    name: visibleBridge.name,
    description: visibleBridge.description,
    parameters: structuredClone(visibleBridge.parameters),
  }
  const assemble = assemblyListeners[0]!
  const nextExact = async () => ({ tools: [exactSchema] })
  assert.deepEqual(await assemble({ tools: [] }, { agent: isolatedAgent, scope: isolatedAgent }, nextExact), { tools: [exactSchema] }, 'legal final assembly passes unchanged')
  await assert.rejects(async () => await assemble({ tools: [] }, { agent: isolatedAgent, scope: isolatedAgent }, async () => ({ tools: [exactSchema, { name: 'own_side_effect' }] })), /BENCHMARK_TOOL_SURFACE_VIOLATION/)
  await assert.rejects(async () => await assemble({ tools: [] }, { agent: isolatedAgent, scope: isolatedAgent }, async () => ({ tools: [{ ...exactSchema, description: `${exactSchema.description ?? ''} tampered` }] })), /BENCHMARK_TOOL_SURFACE_VIOLATION/, 'final assembly rejects same-name schema mutation')
  const diagnosticAssembly = { tools: [{ name: 'diagnostic_tool' }] }
  assert.equal(await assemble({ tools: [] }, { scope: { id: 'diagnostic-scope' } }, async () => diagnosticAssembly), diagnosticAssembly, 'non-agent diagnostic assembly passes through')
  await assert.rejects(async () => await assemble({ tools: [] }, { agent: isolatedAgent, scope: { id: 'wrong-scope' } }, nextExact), /BENCHMARK_TOOL_SURFACE_VIOLATION/, 'agent assembly requires the same agent and scope')
  const preStep = preStepListeners[0]!
  assert.deepEqual(await preStep({ agent: isolatedAgent }, async () => ({ decision: 'continue' })), { decision: 'continue' }, 'legal pre-step decision passes unchanged')
  scopedExtraSchemas.set(isolatedAgent, [{ name: 'own_side_effect' }])
  await assert.rejects(async () => await preStep({ agent: isolatedAgent }, async () => ({ decision: 'continue' })), /BENCHMARK_TOOL_SURFACE_VIOLATION/, 'downstream pre-step scope expansion fails closed')
  scopedExtraSchemas.delete(isolatedAgent)
  shadowedAgent = isolatedAgent
  await assert.rejects(async () => await assemble({ tools: [] }, { agent: isolatedAgent, scope: isolatedAgent }, nextExact), /BENCHMARK_TOOL_SURFACE_VIOLATION/, 'same-name scoped shadow fails final assembly identity check')
  shadowedAgent = undefined
  assert.equal(guards.length, 2, 'agent scope installs exact isolation and conformance guards')
  const guard = guards[0]!
  const originalAgent = { ctx: { tools: { get: (name: string) => name === 'gotry_benchmark_environment' ? visibleBridge : undefined } } }
  const shadowAgent = { ctx: { tools: { get: (name: string) => name === 'gotry_benchmark_environment' ? { name } : undefined } } }
  shadowedAgent = shadowAgent
  assert.equal(guard({ name: 'gotry_benchmark_environment', args: {}, agent: originalAgent } as never), undefined, 'original bridge definition is allowed')
  assert.equal(guard({ name: 'gotry_benchmark_environment', args: {}, agent: shadowAgent } as never), 'BENCHMARK_TOOL_NOT_ALLOWED', 'same-name shadow definition is denied')
  assert.equal(guard({ name: 'gotry_benchmark_environment', args: { path: '/private/secret' }, agent: isolatedAgent } as never), undefined, 'bridge tool is allowed')
  const denied = guard({ name: 'other_tool', args: { path: '/private/secret', token: 'secret' } })
  assert.equal(denied, 'BENCHMARK_TOOL_NOT_ALLOWED', 'non-bridge tools are denied without argument/path echo')
  assert.equal(denied?.includes('/private/secret'), false)
  assert.equal(denied?.includes('secret'), false)
  assert.equal(guard({ name: 'other_tool', args: { different: true } }), denied, 'denial reason is stable')
  assert.throws(() => agentCreatedListeners[0]!({ agent: { ctx: { tools: { restrict(filter) { void filter }, guard(check) { void check } } } } }), /presentAs/, 'missing scoped presentAs fails hard')
  assert.throws(() => agentCreatedListeners[0]!({ agent: { ctx: { tools: scopedTools } } }), /effect/, 'missing scoped effect fails hard')
  assert.throws(() => agentCreatedListeners[0]!({ agent: { ctx: { tools: scopedTools, effect: (action: () => unknown) => runEffect(action) } } }), /event bus/, 'missing scoped event bus fails hard')
  assert.throws(() => agentCreatedListeners[0]!({ agent: { ctx: { tools: { guard: guards[0] } } } }), /restrict/, 'missing scoped restrict fails hard')
  assert.throws(() => agentCreatedListeners[0]!({ agent: { ctx: { tools: { restrict(filter) { void filter } } } } }), /guard/, 'missing scoped guard fails hard')
  assert.throws(() => installBenchmarkToolIsolation({
    tools: { get(name: string) { return name === 'gotry_benchmark_environment' ? { name: 'gotry_benchmark_environment' } : undefined }, schemas() { return [{ name: 'gotry_benchmark_environment' }] } },
    agents: { list() { return [] } },
    on() { return () => {} },
  } as unknown as Context), /effect/, 'missing ctx.effect fails hard')

  await disposedListeners[0]!({ agent: isolatedAgent })
  assert.deepEqual(cleanupCounts, { restrict: 1, guard: 1, presentAs: 1, assembly: 1 }, 'agent disposal releases every scoped isolation effect exactly once')
  await disposedListeners[1]!({ agent: isolatedAgent })
  await isolatedAgentEffects[1]!()
  assert.deepEqual(cleanupCounts, { restrict: 1, guard: 2, presentAs: 1, assembly: 2 }, 'agent-scope disposal also releases conformance guard and prompt section')

  const secondCleanup = { restrict: 0, guard: 0, presentAs: 0, assembly: 0 }
  const secondGuards: Array<(execution: { name: string; agent?: unknown }) => string | undefined> = []
  const secondScopedAssemblyListeners: Array<(...args: any[]) => unknown> = []
  const secondTools: ScopedAgentTools = {
    restrict() { return () => { secondCleanup.restrict += 1 } },
    guard(check) { secondGuards.push(check); return () => { secondCleanup.guard += 1 } },
    presentAs() { return () => { secondCleanup.presentAs += 1 } },
  }
  const secondAgentEffects: Array<() => Promise<void>> = []
  const secondAgent = { session: {}, steer(_message: unknown) {}, ctx: {
    tools: secondTools,
    effect: (action: () => unknown) => {
      const dispose = runEffect(action)
      secondAgentEffects.push(dispose)
      return dispose
    },
    on: (_event: string, listener: (...args: any[]) => unknown) => {
      secondScopedAssemblyListeners.push(listener)
      return () => { secondCleanup.assembly += 1 }
    },
  } }
  for (const listener of agentCreatedListeners) listener({ agent: secondAgent })
  let inFlightNextCalls = 0
  await assert.rejects(async () => await secondScopedAssemblyListeners[0]!({}, { agent: secondAgent, scope: secondAgent }, async () => {
    inFlightNextCalls += 1
    await disposeRootIsolation!()
    return { tools: [exactSchema] }
  }), /BENCHMARK_TOOL_SURFACE_VIOLATION/, 'plugin unload during assembly fails closed before returning a model-visible result')
  assert.equal(inFlightNextCalls, 1, 'in-flight quarantine test reaches the controlled unload point')
  assert.deepEqual(secondCleanup, { restrict: 0, guard: 0, presentAs: 0, assembly: 0 }, 'plugin unload keeps a live agent quarantined')
  let quarantineNextCalls = 0
  await assert.rejects(async () => await secondScopedAssemblyListeners[0]!({}, { agent: secondAgent, scope: secondAgent }, async () => {
    quarantineNextCalls += 1
    return { tools: [exactSchema] }
  }), /BENCHMARK_TOOL_SURFACE_VIOLATION/, 'plugin-unloaded live agent rejects assembly before model request')
  assert.equal(quarantineNextCalls, 0, 'quarantine does not enter the remaining assembly chain')
  assert.equal(secondGuards[0]!({ name: 'other_tool', agent: secondAgent }), 'BENCHMARK_TOOL_NOT_ALLOWED', 'quarantined agent still denies non-bridge dispatch after plugin unload')
  assert.equal(secondGuards[0]!({ name: 'gotry_benchmark_environment', agent: secondAgent }), 'BENCHMARK_TOOL_NOT_ALLOWED', 'quarantined agent also denies bridge dispatch after plugin unload')
  assert.deepEqual(cleanupCounts, { restrict: 1, guard: 2, presentAs: 1, assembly: 2 }, 'plugin unload does not double-dispose an already removed agent')
  assert.throws(() => agentCreatedListeners[0]!({ agent: secondAgent }), /BENCHMARK_TOOL_SURFACE_VIOLATION/, 'agent creation during plugin stop fails closed')
  for (const dispose of secondAgentEffects) await dispose()
  assert.deepEqual(secondCleanup, { restrict: 1, guard: 2, presentAs: 1, assembly: 2 }, 'agent disposal releases its quarantined isolation and conformance effects')

  const bridge = registered.find(tool => tool.name === 'gotry_benchmark_environment')!
  assert.ok(bridge.execute, 'registered bridge exposes execute')

  const args = { city: 'Dubai', payload: '$(touch /tmp/nope)' }
  const result = await bridge.execute!({ query: { action: 'call', tool: 'lookup', arguments: args } }, null)
  assert.deepEqual(spawnSpecs[0]?.argv, [
    process.execPath, '-m', 'agent_env.cli', '--lang', 'en', 'call', 'lookup', JSON.stringify(args),
  ], 'call uses only the configured executable/prefix and fixed lookup subcommand argv')
  assert.equal(spawnSpecs[0]?.cwd, root, 'call uses configured cwd')
  assert.equal(spawnSpecs[0]?.stdio.stdin, 'ignore', 'call never exposes stdin')
  assert.equal(spawnSpecs[0]?.stdio.stdout.maxBytes, 4_096, 'stdout cap comes from config')
  assert.equal(spawnSpecs[0]?.stdio.stderr.maxBytes, 4_096, 'stderr cap comes from config')
  assert.ok((spawnSpecs[0]?.graceMs ?? 0) > 0 && (spawnSpecs[0]?.graceMs ?? Infinity) <= 1_000, 'graceMs is bounded')
  assert.equal(spawnSpecs[0]?.env?.GOTRY_BENCHMARK_BRIDGE_PARENT_SENTINEL, undefined, 'parent sentinel is not inherited')
  for (const key of ['DATABASE_URL', 'SSH_AUTH_SOCK', 'AWS_PROFILE', 'HTTPS_PROXY', 'GOTRY_BENCHMARK_BRIDGE_PARENT_SENTINEL']) {
    assert.equal(spawnSpecs[0]?.env?.[key], undefined, `${key} is tombstoned in bridge subprocess env`)
  }
  assert.equal(spawnSpecs[0]?.env?.PYTHONDONTWRITEBYTECODE, '1')
  assert.equal(spawnSpecs[0]?.env?.PYTHONNOUSERSITE, '1')
  assert.deepEqual(result, { ok: true, result: [{ city: 'Dubai' }] }, 'one-line JSON stdout becomes structured result')

  outcomes.push({ stdout: '{"result":{"city":"Dubai"}}' })
  const unmappedResult = await bridge.execute!({ query: { action: 'call', tool: 'toString', arguments: { city: 'Dubai' } } }, null)
  assert.deepEqual(unmappedResult, { ok: true, result: { city: 'Dubai' } }, 'allowed tool without a positive mapping retains the recursive denylist only')

  outcomes.push({ stdout: '{"result":{"legacy":"value"}}' })
  const legacyResult = await bridge.execute!({ query: { action: 'call', tool: 'constructor', arguments: { city: 'Dubai' } } }, null)
  assert.deepEqual(legacyResult, { ok: true, result: { legacy: 'value' } }, 'mapped constructor accepts its declared positive key')

  outcomes.push({ stdout: '{"result":{"city":"Dubai"}}' })
  const constructorUnexpected = await bridge.execute!({ query: { action: 'call', tool: 'constructor', arguments: { city: 'Dubai' } } }, null)
  assert.deepEqual(constructorUnexpected, { ok: false, error: 'forbidden_output' }, 'mapped constructor rejects undeclared positive keys')

  outcomes.push({ stdout: '{"result":{"nested":{"city":"Dubai"}}}' })
  const nestedAllowedResult = await bridge.execute!({ query: { action: 'call', tool: 'lookup', arguments: { city: 'Dubai' } } }, null)
  assert.deepEqual(nestedAllowedResult, { ok: true, result: { nested: { city: 'Dubai' } } }, 'configured positive output allowlist accepts declared nested keys')

  outcomes.push({ stdout: '{"result":{"city":"Dubai","unexpected":"secret"}}' })
  const unexpectedResult = await bridge.execute!({ query: { action: 'call', tool: 'lookup', arguments: { city: 'Dubai' } } }, null)
  assert.deepEqual(unexpectedResult, { ok: false, error: 'forbidden_output' }, 'configured positive output allowlist rejects unexpected keys without reflecting them')

  outcomes.push({ stdout: '{"result":[{"city":"Dubai","nested":{"unexpected":"secret"}}]}' })
  const nestedUnexpectedResult = await bridge.execute!({ query: { action: 'call', tool: 'lookup', arguments: { city: 'Dubai' } } }, null)
  assert.deepEqual(nestedUnexpectedResult, { ok: false, error: 'forbidden_output' }, 'configured positive output allowlist recurses through arrays and objects')

  for (const forbidden of [
    'gold', 'goldAnswer', 'oracle', 'expected', 'expected_answer', 'answer', 'label',
    'score', 'reward', 'ground_truth', 'groundTruth', 'hidden_query', 'hidden-query',
    'loader_metadata', 'loaderMetadata', 'reference', 'gоld',
  ]) {
    outcomes.push({ stdout: JSON.stringify({ result: { nested: { [forbidden]: 'secret' } } }) })
    const forbiddenResult = await bridge.execute!({ query: { action: 'call', tool: 'lookup', arguments: { city: 'Dubai' } } }, null)
    assert.deepEqual(forbiddenResult, { ok: false, error: 'forbidden_output' }, `recursive no-oracle key ${forbidden} is rejected without reflecting its name`)
  }

  outcomes.push({ stdout: '{"result":"the hidden answer"}' })
  const primitiveOutput = await bridge.execute!({ query: { action: 'call', tool: 'lookup', arguments: { city: 'Dubai' } } }, null)
  assert.deepEqual(primitiveOutput, { ok: false, error: 'invalid_output' }, 'primitive result strings cannot bypass the structured visible-output boundary')

  const beforeOversized = spawnSpecs.length
  const oversized = await bridge.execute!({ query: { action: 'call', tool: 'lookup', arguments: { blob: 'x'.repeat(65_537) } } }, null)
  assert.deepEqual(oversized, { ok: false, error: 'invalid_arguments', reason: 'serialization_limit' })
  assert.equal(spawnSpecs.length, beforeOversized, 'oversized serialized arguments are rejected before spawn')

  const beforeDeep = spawnSpecs.length
  let deep: Record<string, unknown> = {}
  for (let index = 0; index < 13; index++) deep = { next: deep }
  const deepResult = await bridge.execute!({ query: { action: 'call', tool: 'lookup', arguments: deep } }, null)
  assert.deepEqual(deepResult, { ok: false, error: 'invalid_arguments', reason: 'serialization_limit' })
  assert.equal(spawnSpecs.length, beforeDeep, 'over-deep arguments are rejected before spawn')

  const beforeOverride = spawnSpecs.length
  const overrideResult = await bridge.execute!({ query: {
    action: 'call', tool: 'lookup', arguments: {
      city: 'Dubai', executable: '/tmp/evil', cwd: '/tmp/evil', argv: ['--unsafe'],
    },
  } }, null)
  assert.deepEqual(spawnSpecs[beforeOverride]?.argv, [
    process.execPath, '-m', 'agent_env.cli', '--lang', 'en', 'call', 'lookup', JSON.stringify({
      city: 'Dubai', executable: '/tmp/evil', cwd: '/tmp/evil', argv: ['--unsafe'],
    }),
  ], 'model executable/cwd/argv fields remain data and cannot override config')
  assert.equal((overrideResult as { ok?: boolean }).ok, true, 'override-shaped arguments still use the configured bridge')

  outcomes.push({ stdout: '{"result":{"city":"Dubai"}}', lossy: true })
  const truncated = await bridge.execute!({ query: { action: 'call', tool: 'lookup', arguments: { city: 'Dubai' } } }, null)
  assert.deepEqual(truncated, { ok: false, error: 'output_truncated' }, 'lossy stdout is rejected without parsing partial output')

  outcomes.push({ stdout: '{"result":{"city":"Dubai"}}', stderr: 'private runner diagnostic', exitCode: 17, signal: 'SIGTERM' })
  const failed = await bridge.execute!({ query: { action: 'call', tool: 'lookup', arguments: { city: 'Dubai' } } }, null)
  assert.deepEqual(failed, { ok: false, error: 'runner_failed', exit_code: 17, signal: 'SIGTERM' }, 'nonzero runner result is structured without stderr echo')

  for (const stdout of ['not-json', '{"result":1}{"result":2}']) {
    outcomes.push({ stdout })
    const malformed = await bridge.execute!({ query: { action: 'call', tool: 'lookup', arguments: { city: 'Dubai' } } }, null)
    assert.deepEqual(malformed, { ok: false, error: 'invalid_json' }, 'malformed or multi-value JSON is rejected')
  }

  outcomes.push({ spawnError: true })
  const spawnFailed = await bridge.execute!({ query: { action: 'call', tool: 'lookup', arguments: { city: 'Dubai' } } }, null)
  assert.deepEqual(spawnFailed, { ok: false, error: 'spawn_failed' }, 'spawn infrastructure failure is structured')

  outcomes.push({ spawnReject: true })
  const asyncSpawnFailed = await bridge.execute!({ query: { action: 'call', tool: 'lookup', arguments: { city: 'Dubai' } } }, null)
  assert.deepEqual(asyncSpawnFailed, { ok: false, error: 'spawn_failed' }, 'DSH pid=-1 spawn rejection is distinct from a started runner failure')

  outcomes.push({ waitForAbort: true })
  const timedOut = await bridge.execute!({ query: { action: 'call', tool: 'lookup', arguments: { city: 'Dubai' } } }, null)
  assert.deepEqual(timedOut, { ok: false, error: 'timed_out' }, 'deadline abort is surfaced as timed_out')
  assert.equal(timeoutSignal?.aborted, true, 'timeout abort signal is fired')

  const beforeInvalidArgs = spawnSpecs.length
  assert.deepEqual(await bridge.execute!({ query: { action: 'call', tool: 'lookup', arguments: ['not', 'plain'] } }, null), { ok: false, error: 'invalid_arguments' })
  assert.equal(spawnSpecs.length, beforeInvalidArgs, 'non-object arguments are rejected before spawn')
  assert.deepEqual(await bridge.execute!({ query: { action: 'inspect' } }, null), { ok: false, error: 'invalid_action' }, 'unknown action is rejected structurally')

  const beforeRejected = spawnSpecs.length
  const rejected = await bridge.execute!({ query: { action: 'call', tool: 'delete_all', arguments: {} } }, null)
  assert.deepEqual(rejected, { ok: false, error: 'disallowed_tool' }, 'disallowed tool is rejected structurally')
  assert.equal(spawnSpecs.length, beforeRejected, 'disallowed tool is rejected before spawn')

  const spacedConfigPath = join(root, ' benchmark-environment-config.json ')
  writeFileSync(spacedConfigPath, readFileSync(configPath))
  const spacedTools: RegisteredTool[] = []
  const spacedCtx = {
    tools: {
      register(tool: RegisteredTool) { spacedTools.push(tool); return () => {} },
      get(name: string) { return spacedTools.find(tool => tool.name === name) },
      schemas() { return spacedTools.map(tool => ({ name: tool.name })) },
    },
    agents: { list() { return [] } },
    systemPrompt: { variable() {} },
    on() { return () => {} },
    effect() { return () => {} },
    get(name: string) {
      if (name === 'subprocess') return { spawn: (_spec: SpawnSpec) => fakeHandle({ stdout: '{}' }) }
      if (name === 'agents') return { list() { return [] } }
      return undefined
    },
  } as unknown as Context
  apply(spacedCtx, {
    stateRoot: root, timeoutMs: 20, hbcliBin: '', sessionAccess: 'off', benchmarkEnvironmentConfigPath: spacedConfigPath,
  } as Config & { benchmarkEnvironmentConfigPath: string })
  assert.deepEqual(spacedTools.map(tool => tool.name), ['gotry_benchmark_environment'], 'benchmark bridge loads a valid raw path with whitespace basename')

  const disabled: RegisteredTool[] = []
  const disabledVariables: string[] = []
  const disabledCtx = {
    tools: { register(tool: RegisteredTool) { disabled.push(tool); return () => {} } },
    systemPrompt: { variable(name: string) { disabledVariables.push(name) } },
  } as unknown as Context
  apply(disabledCtx, {
    stateRoot: root, timeoutMs: 1_000, hbcliBin: '', sessionAccess: 'off', benchmarkEnvironmentConfigPath: '',
  } as Config)
  assert.equal(disabled.some(tool => tool.name === 'gotry_benchmark_environment'), false, 'empty config path keeps bridge default-off')
  assert.ok(disabled.length > 1, 'normal product mode keeps the full GoTry tool catalog')
  assert.deepEqual(disabledVariables, ['current_date', 'time_anchor_card', 'motivation_brief', 'channel_routing_card'], 'normal product mode keeps its prompt variables')

  const whitespace: RegisteredTool[] = []
  const whitespaceCtx = {
    tools: { register(tool: RegisteredTool) { whitespace.push(tool); return () => {} } },
    systemPrompt: { variable() {} },
  } as unknown as Context
  apply(whitespaceCtx, {
    stateRoot: root, timeoutMs: 1_000, hbcliBin: '', sessionAccess: 'off', benchmarkEnvironmentConfigPath: '   \t  ',
  } as Config)
  assert.equal(whitespace.some(tool => tool.name === 'gotry_benchmark_environment'), false, 'whitespace config path keeps benchmark mode default-off')
  assert.ok(whitespace.length > 1, 'whitespace path preserves the ordinary product tool catalog')

  const originalModelOverride = process.env.GOTRY_LLM_MODEL
  process.env.GOTRY_LLM_MODEL = 'round7-model-preserved'
  try {
    const modelTools: RegisteredTool[] = []
    let modelRequest: ((payload: unknown, next: () => Promise<Record<string, unknown>>) => Promise<Record<string, unknown>>) | undefined
    const modelEvents: string[] = []
    const modelCtx = {
      tools: {
        register(tool: RegisteredTool) { modelTools.push(tool); return () => {} },
        get(name: string) { return modelTools.find(tool => tool.name === name) },
        schemas() { return modelTools.map(tool => ({ name: tool.name })) },
      },
      agents: { list() { return [] } },
      systemPrompt: { variable() {} },
      on(event: string, listener: (payload: unknown, next: () => Promise<Record<string, unknown>>) => Promise<Record<string, unknown>>) {
        modelEvents.push(event)
        if (event === 'agent/request') modelRequest = listener
        return () => {}
      },
      effect() { return () => {} },
      get(name: string) {
        if (name === 'subprocess') return { spawn: (_spec: SpawnSpec) => fakeHandle({ stdout: '{}' }) }
        if (name === 'agents') return { list() { return [] } }
        return undefined
      },
    } as unknown as Context
    apply(modelCtx, {
      stateRoot: root, timeoutMs: 20, hbcliBin: '', sessionAccess: 'off', benchmarkEnvironmentConfigPath: configPath,
    } as Config & { benchmarkEnvironmentConfigPath: string })
    assert.deepEqual(modelTools.map(tool => tool.name), ['gotry_benchmark_environment'], 'benchmark model override does not re-enable product tools')
    assert.ok(modelEvents.includes('agent/request'), 'benchmark mode preserves the model override hook')
    assert.ok(modelRequest)
    assert.deepEqual(
      await modelRequest!({}, async () => ({ provider: 'persisted', model: 'old', reasoningEffort: 'high', marker: 'kept' })),
      { provider: 'deepseek-official', model: 'round7-model-preserved', marker: 'kept' },
      'benchmark model override remains effective and replaces the persisted model only',
    )
  } finally {
    if (originalModelOverride === undefined) delete process.env.GOTRY_LLM_MODEL
    else process.env.GOTRY_LLM_MODEL = originalModelOverride
  }

  const validConfig = {
    schema_version: 'gotry_benchmark_environment_bridge_v2',
    enabled: true,
    executable: process.execPath,
    cwd: root,
    argv_prefix: ['-m', 'agent_env.cli', '--lang', 'en'],
    allowed_tools: ['lookup'],
    timeout_ms: 20,
    max_output_bytes: 4_096,
    terminal_output: { tag: 'done', max_bytes: 4_096 },
    isolation: { mode: 'host-enforced', writes: 'forbidden', network: 'denied' },
  }
  const frozenProjection = registerBenchmarkEnvironmentBridge(configPath, () => {}, {
    spawn: (_spec: SpawnSpec) => fakeHandle({ stdout: '{"result":{}}' }),
  })
  assert.equal(Object.isFrozen(frozenProjection), true, 'bridge projection is frozen')
  assert.equal(Object.isFrozen(frozenProjection.allowedTools), true, 'projected allowlist is frozen')
  assert.equal(Object.isFrozen(frozenProjection.terminal), true, 'projected terminal contract is frozen')
  assert.throws(() => { (frozenProjection.allowedTools as string[]).push('escape') }, TypeError)
  assert.throws(() => { (frozenProjection.terminal as { tag: string }).tag = 'escape' }, TypeError)
  const bridgeRegistrationFor = (config: Record<string, unknown>, withSubprocess = true): boolean => {
    const path = join(root, `config-${Math.random().toString(36).slice(2)}.json`)
    writeFileSync(path, JSON.stringify(config))
    const tools: RegisteredTool[] = []
    const freshCtx = {
      tools: { register(tool: RegisteredTool) { tools.push(tool); return () => {} }, get(name: string) { return tools.find(tool => tool.name === name) }, schemas() { return tools.map(tool => ({ name: tool.name })) } },
      systemPrompt: { variable() {} },
      on() { return () => {} },
      effect(action: () => unknown) { return action() },
      agents: { list() { return [] } },
      get(name: string) {
        if (name === 'subprocess') return (this as unknown as { subprocess: unknown }).subprocess
        if (name === 'agents') return (this as unknown as { agents: unknown }).agents
      },
      ...(withSubprocess ? { subprocess: { spawn: (_spec: SpawnSpec) => fakeHandle({ stdout: '{"result":{}}' }) } } : {}),
    } as unknown as Context
    apply(freshCtx, {
      stateRoot: root, timeoutMs: 20, hbcliBin: '', sessionAccess: 'off', benchmarkEnvironmentConfigPath: path,
    } as Config & { benchmarkEnvironmentConfigPath: string })
    return tools.some(tool => tool.name === 'gotry_benchmark_environment')
  }

  assert.throws(() => bridgeRegistrationFor({ ...validConfig, unknown: true }), /benchmark environment bridge configuration unavailable/, 'unknown top-level config key fails hard')
  assert.throws(() => bridgeRegistrationFor({ ...validConfig, schema_version: 'gotry_benchmark_environment_bridge_v1' }), /benchmark environment bridge configuration unavailable/, 'v1 config cannot silently omit the Round 3 terminal semantics')
  assert.throws(() => bridgeRegistrationFor({ ...validConfig, allowed_tools: ['lookup', 'lookup'] }), /benchmark environment bridge configuration unavailable/, 'duplicate allowed tool fails hard')
  assert.throws(() => bridgeRegistrationFor({ ...validConfig, allowed_output_keys: {} }), /benchmark environment bridge configuration unavailable/, 'empty output-key mapping fails hard')
  assert.throws(() => bridgeRegistrationFor({ ...validConfig, allowed_output_keys: { lookup: [] } }), /benchmark environment bridge configuration unavailable/, 'empty output-key allowlist fails hard')
  assert.throws(() => bridgeRegistrationFor({ ...validConfig, allowed_output_keys: { unknown: ['city'] } }), /benchmark environment bridge configuration unavailable/, 'output-key mapping for unknown tool fails hard')
  assert.throws(() => bridgeRegistrationFor({ ...validConfig, allowed_output_keys: { lookup: ['city', 'city'] } }), /benchmark environment bridge configuration unavailable/, 'duplicate output key fails hard')
  assert.throws(() => bridgeRegistrationFor({ ...validConfig, allowed_output_keys: { lookup: ['not a key'] } }), /benchmark environment bridge configuration unavailable/, 'non-identifier output key fails hard')
  assert.throws(() => bridgeRegistrationFor({ ...validConfig, argv_prefix: ['agent\n--unsafe'] }), /benchmark environment bridge configuration unavailable/, 'argv control separator fails hard')
  assert.throws(() => bridgeRegistrationFor({ ...validConfig, allowed_tools: ['lookup;rm'] }), /benchmark environment bridge configuration unavailable/, 'shell metacharacter tool identifier fails hard')
  assert.throws(() => bridgeRegistrationFor({ ...validConfig, isolation: { mode: 'host-enforced', writes: 'forbidden' } }), /benchmark environment bridge configuration unavailable/, 'incomplete isolation policy fails hard')
  const { terminal_output: _terminalOutput, ...missingTerminalConfig } = validConfig
  assert.throws(() => bridgeRegistrationFor(missingTerminalConfig), /benchmark environment bridge configuration unavailable/, 'terminal output contract is required')
  assert.throws(() => bridgeRegistrationFor({ ...validConfig, terminal_output: { tag: '1invalid', max_bytes: 4_096 } }), /benchmark environment bridge configuration unavailable/, 'terminal tag must be an identifier')
  assert.throws(() => bridgeRegistrationFor({ ...validConfig, terminal_output: { tag: 'done', max_bytes: 0 } }), /benchmark environment bridge configuration unavailable/, 'terminal output lower bound fails hard')
  assert.throws(() => bridgeRegistrationFor({ ...validConfig, terminal_output: { tag: 'done', max_bytes: 1024 * 1024 + 1 } }), /benchmark environment bridge configuration unavailable/, 'terminal output upper bound fails hard')
  assert.throws(() => bridgeRegistrationFor({ ...validConfig, terminal_output: { tag: 'done', max_bytes: 4_096, extra: true } }), /benchmark environment bridge configuration unavailable/, 'terminal output rejects unknown keys')
  assert.throws(() => bridgeRegistrationFor(validConfig, false), /benchmark environment bridge subprocess unavailable/, 'explicit opt-in without an active subprocess provider fails hard')

  assert.equal(loadConfigRegistration(configPath, root), true, 'owner-local regular 0644 config remains valid')
  assert.throws(() => loadConfigRegistration('bridge.json', root), /benchmark environment bridge configuration unavailable/, 'relative config path fails hard')
  const symlinkPath = join(root, 'bridge-symlink.json')
  symlinkSync(configPath, symlinkPath)
  assert.equal(lstatSync(symlinkPath).isSymbolicLink(), true)
  assert.throws(() => loadConfigRegistration(symlinkPath, root), /benchmark environment bridge configuration unavailable/, 'symlink config path fails hard')
  const widePath = join(root, 'bridge-wide.json')
  writeFileSync(widePath, JSON.stringify(validConfig))
  chmodSync(widePath, 0o666)
  assert.throws(() => loadConfigRegistration(widePath, root), /benchmark environment bridge configuration unavailable/, 'group/world writable config fails hard')

  const legacyConfigPath = join(root, 'legacy-bridge.json')
  writeFileSync(legacyConfigPath, JSON.stringify(validConfig))
  const legacyTools: RegisteredTool[] = []
  const legacyCtx = {
    tools: { register(tool: RegisteredTool) { legacyTools.push(tool); return () => {} }, get(name: string) { return legacyTools.find(tool => tool.name === name) }, schemas() { return legacyTools.map(tool => ({ name: tool.name })) } },
    systemPrompt: { variable() {} },
    on() { return () => {} },
    effect(_action: () => unknown) { return () => {} },
    agents: { list() { return [] } },
    get(name: string) {
      if (name === 'subprocess') return (this as unknown as { subprocess: unknown }).subprocess
      if (name === 'agents') return (this as unknown as { agents: unknown }).agents
    },
    subprocess: { spawn: (_spec: SpawnSpec) => fakeHandle({ stdout: '{"result":{"city":"Dubai"}}' }) },
  } as unknown as Context
  apply(legacyCtx, {
    stateRoot: root, timeoutMs: 20, hbcliBin: '', sessionAccess: 'off', benchmarkEnvironmentConfigPath: legacyConfigPath,
  } as Config & { benchmarkEnvironmentConfigPath: string })
  const legacyBridge = legacyTools.find(tool => tool.name === 'gotry_benchmark_environment')
  assert.ok(legacyBridge?.execute, 'legacy config without allowed_output_keys registers the bridge')
  assert.deepEqual(
    await legacyBridge!.execute!({ query: { action: 'call', tool: 'lookup', arguments: { city: 'Dubai' } } }, null),
    { ok: true, result: { city: 'Dubai' } },
    'legacy config without allowed_output_keys still executes safe structured output',
  )

  console.log('BENCHMARK ENVIRONMENT BRIDGE TESTS: registration + TDD bridge contract assertions')
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  for (const [name, value] of ambientSentinels) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  rmSync(root, { recursive: true, force: true })
}

function loadConfigRegistration(path: string, stateRoot: string): boolean {
  const tools: RegisteredTool[] = []
  const freshCtx = {
    tools: { register(tool: RegisteredTool) { tools.push(tool); return () => {} }, get(name: string) { return tools.find(tool => tool.name === name) }, schemas() { return tools.map(tool => ({ name: tool.name })) } },
    systemPrompt: { variable() {} },
    agents: { list() { return [] } },
    on() { return () => {} },
    effect(_action: () => unknown) { return () => {} },
    get(name: string) {
      if (name === 'subprocess') return (this as unknown as { subprocess: unknown }).subprocess
      if (name === 'agents') return (this as unknown as { agents: unknown }).agents
    },
    subprocess: { spawn: (_spec: SpawnSpec) => fakeHandle({ stdout: '{"result":{}}' }) },
  } as unknown as Context
  apply(freshCtx, {
    stateRoot, timeoutMs: 20, hbcliBin: '', sessionAccess: 'off', benchmarkEnvironmentConfigPath: path,
  } as Config & { benchmarkEnvironmentConfigPath: string })
  return tools.some(tool => tool.name === 'gotry_benchmark_environment')
}
