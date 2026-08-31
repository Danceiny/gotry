import assert from 'node:assert/strict'
import { chmodSync, lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { apply, type Config } from '../src/index.ts'

type RegisteredTool = {
  name: string
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
  const spawnSpecs: SpawnSpec[] = []
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
    },
    systemPrompt: { variable() {} },
    get(name: string) { return name === 'subprocess' ? (this as unknown as { subprocess: unknown }).subprocess : undefined },
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
  } as unknown as Context

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
      tools: { register(tool: RegisteredTool) { tools.push(tool); return () => {} } },
      systemPrompt: { variable() {} },
      get(name: string) { return name === 'subprocess' ? (this as unknown as { subprocess: unknown }).subprocess : undefined },
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
    tools: { register(tool: RegisteredTool) { legacyTools.push(tool); return () => {} } },
    systemPrompt: { variable() {} },
    get(name: string) { return name === 'subprocess' ? (this as unknown as { subprocess: unknown }).subprocess : undefined },
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
    tools: { register(tool: RegisteredTool) { tools.push(tool); return () => {} } },
    systemPrompt: { variable() {} },
    get(name: string) { return name === 'subprocess' ? (this as unknown as { subprocess: unknown }).subprocess : undefined },
    subprocess: { spawn: (_spec: SpawnSpec) => fakeHandle({ stdout: '{"result":{}}' }) },
  } as unknown as Context
  apply(freshCtx, {
    stateRoot, timeoutMs: 20, hbcliBin: '', sessionAccess: 'off', benchmarkEnvironmentConfigPath: path,
  } as Config & { benchmarkEnvironmentConfigPath: string })
  return tools.some(tool => tool.name === 'gotry_benchmark_environment')
}
