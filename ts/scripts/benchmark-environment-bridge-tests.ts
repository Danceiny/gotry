import assert from 'node:assert/strict'
import { chmodSync, lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { apply, type Config } from '../src/index.ts'
import { installBenchmarkToolIsolation } from '../src/benchmark-tool-isolation.ts'

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
  waitForAbort?: boolean
}

function fakeHandle(outcome: FakeOutcome) {
  const stdout = outcome.stdout ?? ''
  const stderr = outcome.stderr ?? ''
  const reader = { readFrom: (_offset: number) => ({ text: stdout, nextOffset: Buffer.byteLength(stdout), lossy: outcome.lossy ?? false }) }
  const errorReader = { readFrom: (_offset: number) => ({ text: stderr, nextOffset: Buffer.byteLength(stderr), lossy: false }) }
  let rejectDone: ((error: Error) => void) | undefined
  const done = outcome.waitForAbort
    ? new Promise<{ exitCode: number | null; signal: string | null }>((_resolve, reject) => { rejectDone = reject })
    : Promise.resolve({ exitCode: outcome.exitCode ?? 0, signal: outcome.signal ?? null })
  return {
    pid: 4242,
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
  'DATABASE_URL',
  'SSH_AUTH_SOCK',
  'AWS_PROFILE',
  'HTTPS_PROXY',
] as const
const ambientSentinels = new Map(ambientSentinelNames.map(name => [name, process.env[name]]))
try {
  const configPath = join(root, 'bridge.json')
  writeFileSync(configPath, JSON.stringify({
    schema_version: 'gotry_benchmark_environment_bridge_v1',
    enabled: true,
    executable: process.execPath,
    cwd: root,
    argv_prefix: ['-m', 'agent_env.cli', '--lang', 'en'],
    allowed_tools: ['lookup', 'constructor', 'toString'],
    allowed_output_keys: { lookup: ['city', 'nested'], constructor: ['legacy'] },
    timeout_ms: 20,
    max_output_bytes: 4_096,
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
  type AgentCreated = { agent: { ctx: { tools?: ScopedAgentTools; effect?: (action: () => unknown) => unknown; on?: (event: string, listener: (...args: any[]) => unknown, options?: unknown) => unknown } } }
  const agentCreatedListeners: Array<(event: AgentCreated) => void> = []
  const eventNames: string[] = []
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
    systemPrompt: { variable() {} },
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
  assert.equal(agentCreatedListeners.length, 1, 'opt-in bridge installs an agent/created isolation listener')
  const isolatedAgent = { ctx: {
    tools: scopedTools,
    effect: (action: () => unknown) => runEffect(action),
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
  assert.equal(firstScopedAssemblyListeners.length, 1, 'agent owns a scoped assembly quarantine listener')
  assert.deepEqual(eventOptions.get('system-prompt/assemble'), { prepend: true }, 'assembly isolation wraps every previously registered listener')
  assert.equal(disposedListeners.length, 1, 'isolation owns one agent/disposed listener')
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
  assert.equal(guards.length, 1, 'agent scope installs a monotonic guard')
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

  const secondCleanup = { restrict: 0, guard: 0, presentAs: 0, assembly: 0 }
  const secondGuards: Array<(execution: { name: string; agent?: unknown }) => string | undefined> = []
  const secondScopedAssemblyListeners: Array<(...args: any[]) => unknown> = []
  const secondTools: ScopedAgentTools = {
    restrict() { return () => { secondCleanup.restrict += 1 } },
    guard(check) { secondGuards.push(check); return () => { secondCleanup.guard += 1 } },
    presentAs() { return () => { secondCleanup.presentAs += 1 } },
  }
  let disposeSecondAgentEffect: (() => Promise<void>) | undefined
  const secondAgent = { ctx: {
    tools: secondTools,
    effect: (action: () => unknown) => {
      const dispose = runEffect(action)
      disposeSecondAgentEffect = dispose
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
  assert.deepEqual(cleanupCounts, { restrict: 1, guard: 1, presentAs: 1, assembly: 1 }, 'plugin unload does not double-dispose an already removed agent')
  assert.throws(() => agentCreatedListeners[0]!({ agent: secondAgent }), /BENCHMARK_TOOL_SURFACE_VIOLATION/, 'agent creation during plugin stop fails closed')
  await disposeSecondAgentEffect!()
  assert.deepEqual(secondCleanup, { restrict: 1, guard: 1, presentAs: 1, assembly: 1 }, 'agent disposal releases its quarantined scoped effects')

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

  const disabled: RegisteredTool[] = []
  const disabledCtx = {
    tools: { register(tool: RegisteredTool) { disabled.push(tool); return () => {} } },
    systemPrompt: { variable() {} },
  } as unknown as Context
  apply(disabledCtx, {
    stateRoot: root, timeoutMs: 1_000, hbcliBin: '', sessionAccess: 'off', benchmarkEnvironmentConfigPath: '',
  } as Config)
  assert.equal(disabled.some(tool => tool.name === 'gotry_benchmark_environment'), false, 'empty config path keeps bridge default-off')

  const validConfig = {
    schema_version: 'gotry_benchmark_environment_bridge_v1',
    enabled: true,
    executable: process.execPath,
    cwd: root,
    argv_prefix: ['-m', 'agent_env.cli', '--lang', 'en'],
    allowed_tools: ['lookup'],
    timeout_ms: 20,
    max_output_bytes: 4_096,
    isolation: { mode: 'host-enforced', writes: 'forbidden', network: 'denied' },
  }
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
  assert.throws(() => bridgeRegistrationFor({ ...validConfig, allowed_tools: ['lookup', 'lookup'] }), /benchmark environment bridge configuration unavailable/, 'duplicate allowed tool fails hard')
  assert.throws(() => bridgeRegistrationFor({ ...validConfig, allowed_output_keys: {} }), /benchmark environment bridge configuration unavailable/, 'empty output-key mapping fails hard')
  assert.throws(() => bridgeRegistrationFor({ ...validConfig, allowed_output_keys: { lookup: [] } }), /benchmark environment bridge configuration unavailable/, 'empty output-key allowlist fails hard')
  assert.throws(() => bridgeRegistrationFor({ ...validConfig, allowed_output_keys: { unknown: ['city'] } }), /benchmark environment bridge configuration unavailable/, 'output-key mapping for unknown tool fails hard')
  assert.throws(() => bridgeRegistrationFor({ ...validConfig, allowed_output_keys: { lookup: ['city', 'city'] } }), /benchmark environment bridge configuration unavailable/, 'duplicate output key fails hard')
  assert.throws(() => bridgeRegistrationFor({ ...validConfig, allowed_output_keys: { lookup: ['not a key'] } }), /benchmark environment bridge configuration unavailable/, 'non-identifier output key fails hard')
  assert.throws(() => bridgeRegistrationFor({ ...validConfig, argv_prefix: ['agent\n--unsafe'] }), /benchmark environment bridge configuration unavailable/, 'argv control separator fails hard')
  assert.throws(() => bridgeRegistrationFor({ ...validConfig, allowed_tools: ['lookup;rm'] }), /benchmark environment bridge configuration unavailable/, 'shell metacharacter tool identifier fails hard')
  assert.throws(() => bridgeRegistrationFor({ ...validConfig, isolation: { mode: 'host-enforced', writes: 'forbidden' } }), /benchmark environment bridge configuration unavailable/, 'incomplete isolation policy fails hard')
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
