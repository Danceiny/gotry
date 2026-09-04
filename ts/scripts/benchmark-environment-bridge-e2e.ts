/** Offline contract for the opt-in benchmark environment bridge.
 *
 * Covers default-off, explicit opt-in, and fail-closed configuration paths.
 * A local developer run exercises the source checkout. The packaged consumer
 * path is built from the current root @deepseek-ai/dsh 0.1.2-alpha.3 closure;
 * version/source counterexamples use isolated synthetic fixtures.
 */
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import {
  benchmarkRuntimeSupported,
  selectDshCwd,
  selectDshRuntime,
  supportsNodeVersion,
} from '../../bin/gotry-runtime-resolution.js'

const ROOT = join(import.meta.dirname, '..', '..')
const BIN = join(ROOT, 'bin', 'gotry-inner.js')
const TOOL = 'gotry_benchmark_environment'
const MARKER = 'BENCHMARK_BRIDGE_LOOKUP_OK'
const TIMEOUT_MS = 30_000
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
type Body = { messages?: Array<Record<string, unknown>>; tools?: Array<Record<string, unknown>> }

type RuntimeProbe = {
  rootVersion?: string
  vendorVersion?: string
  benchmark?: boolean
}

function runRuntimeProbe(options: RuntimeProbe): { source: string; version: string } | null {
  const fixture = mkdtempSync(join(tmpdir(), 'gotry-runtime-probe-'))
  try {
    writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: 'runtime-probe', type: 'module' }))
    const writeDsh = (root: string, version: string) => {
      mkdirSync(join(root, 'lib'), { recursive: true })
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version, type: 'module' }))
      writeFileSync(join(root, 'lib', 'bin.js'), 'export {}\n')
    }
    if (options.rootVersion) writeDsh(join(fixture, 'node_modules', '@deepseek-ai', 'dsh'), options.rootVersion)
    if (options.vendorVersion) writeDsh(join(fixture, 'ts', 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh'), options.vendorVersion)
    const runtime = selectDshRuntime({
      repoRoot: fixture,
      rootResolver: createRequire(join(fixture, 'package.json')),
      benchmark: options.benchmark === true,
    })
    return runtime ? { source: runtime.source, version: runtime.version } : null
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
}

function assertRuntimeSelectionAndVersionGuards(): void {
  const sourcePriority = runRuntimeProbe({ rootVersion: '0.1.2-alpha.3', vendorVersion: '0.1.2-alpha.1' })
  assert.deepEqual(sourcePriority, { source: 'root', version: '0.1.2-alpha.3' }, 'source checkout uses the root dsh package even when legacy vendor is alpha.1')

  const legacyFallback = runRuntimeProbe({ vendorVersion: '0.1.2-alpha.1' })
  assert.equal(legacyFallback, null, 'D-27 removal (#120): legacy vendored fallback no longer resolves even outside benchmark — fail-closed')

  const wrongBenchmarkVersion = runRuntimeProbe({ rootVersion: '0.1.2-alpha.1', vendorVersion: '0.1.2-alpha.1', benchmark: true })
  assert.deepEqual(wrongBenchmarkVersion, { source: 'root', version: '0.1.2-alpha.1' })
  assert.equal(benchmarkRuntimeSupported(wrongBenchmarkVersion), false, 'benchmark mode rejects a non-alpha.3 dsh runtime before spawn')
  assert.equal(runRuntimeProbe({ vendorVersion: '0.1.2-alpha.1', benchmark: true }), null, 'benchmark mode never falls back to legacy vendored dsh')

  assert.equal(supportsNodeVersion('22.14.0'), false, 'Node 22.14 is rejected before dsh resolution/spawn')
  assert.equal(supportsNodeVersion('22.15.0'), true, 'Node 22.15 is the accepted minimum')
  assert.equal(supportsNodeVersion('24.0.0'), true, 'newer Node majors remain accepted')

  const invocationCwd = join(tmpdir(), 'gotry-runtime-invocation-cwd')
  const sourceStateRoot = join(ROOT, 'ts/dsh-runtime')
  assert.equal(
    selectDshCwd({ repoRoot: ROOT, invocationCwd, sourceCheckoutMode: true, benchmark: false }),
    sourceStateRoot,
    'source checkout normal mode keeps dsh cwd at ts/dsh-runtime for gotry-state continuity',
  )
  assert.equal(
    selectDshCwd({ repoRoot: ROOT, invocationCwd, sourceCheckoutMode: true, benchmark: true }),
    invocationCwd,
    'source checkout benchmark mode uses the isolated invocation cwd',
  )
  assert.equal(
    selectDshCwd({ repoRoot: ROOT, invocationCwd, sourceCheckoutMode: false, benchmark: false }),
    invocationCwd,
    'installed package normal mode uses the user invocation cwd',
  )
}

function writeResolutionProbe(path: string, resultPath: string, block: boolean): void {
  writeFileSync(path, `
const fs = require('node:fs')
const Module = require('node:module')
const resultPath = ${JSON.stringify(resultPath)}
const isOptional = value => typeof value === 'string' && (value.includes('dsh-calendar') || value.includes('dsh-map-tools'))
const record = (kind, target) => {
  if (isOptional(target)) fs.appendFileSync(resultPath, JSON.stringify({ pid: process.pid, kind, target }) + '\\n')
}
const observe = request => {
  if (typeof request !== 'string') return
  record('resolve', request)
  if (${JSON.stringify(block)} && isOptional(request)) {
    const error = new Error('optional benchmark probe isolation')
    error.code = 'MODULE_NOT_FOUND'
    throw error
  }
}
const originalResolve = Module._resolveFilename
Module._resolveFilename = function (request, parent, isMain, options) {
  observe(request)
  return originalResolve.call(this, request, parent, isMain, options)
}
const originalFindPath = Module._findPath
Module._findPath = function (request, paths, isMain) {
  observe(request)
  return originalFindPath.call(this, request, paths, isMain)
}
const originalExistsSync = fs.existsSync
fs.existsSync = function (target) {
  record('existsSync', target)
  if (${JSON.stringify(block)} && isOptional(target)) return false
  return originalExistsSync.call(this, target)
}
const originalCreateRequire = Module.createRequire
Module.createRequire = function (...args) {
  const required = originalCreateRequire.apply(this, args)
  const originalRequiredResolve = required.resolve
  required.resolve = function (request, ...args) {
    record('resolve', request)
    if (${JSON.stringify(block)} && isOptional(request)) {
      const error = new Error('optional benchmark probe isolation')
      error.code = 'MODULE_NOT_FOUND'
      throw error
    }
    return originalRequiredResolve.call(required, request, ...args)
  }
  required.resolve.paths = originalRequiredResolve.paths
  return required
}
Module.syncBuiltinESMExports()
`, { mode: 0o600, flag: 'wx' })
}

function sse(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}
function finalText(text: string): string {
  return sse({ id: 'bridge-final', object: 'chat.completion.chunk', choices: [{ delta: { role: 'assistant', content: text }, finish_reason: null }] })
    + sse({ id: 'bridge-final-stop', object: 'chat.completion.chunk', choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n'
}
function toolCall(callId = 'bridge-call-1'): string {
  return sse({ id: `bridge-${callId}`, object: 'chat.completion.chunk', choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: TOOL, arguments: JSON.stringify({ action: 'call', tool: 'lookup', arguments: { city: 'Dubai' } }) } }] }, finish_reason: null }] })
    + sse({ id: 'bridge-call-stop', object: 'chat.completion.chunk', choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n'
}
function names(body: Body): string[] {
  return (body.tools ?? []).map(t => { const f = t.function as Record<string, unknown> | undefined; return String(f?.name ?? t.name ?? '') }).filter(Boolean)
}
function toolResultPresent(body: Body): boolean {
  return (body.messages ?? []).some(m => m.role === 'tool' && JSON.stringify(m).includes(MARKER))
}
function anyToolResultPresent(body: Body): boolean {
  return (body.messages ?? []).some(m => m.role === 'tool')
}

type CaseMode = 'disabled' | 'enabled' | 'unexpected-output' | 'invalid-path' | 'invalid-schema' | 'unsafe-config' | 'output-truncated' | 'timeout' | 'runner-failed' | 'spawn-failed' | 'web-mode' | 'debug-redaction'

async function runCase(mode: CaseMode, executableOverride?: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<{ exit: number | null; stdout: string; stderr: string; output: string; requests: Body[]; optionalResolutionHits: { calendar: number; map: number } }> {
  const requests: Body[] = []
  let spawnTarget = ''
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(Buffer.from(c)))
    req.on('end', () => {
      let body: Body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString()) as Body } catch { /* diagnostic remains structural */ }
      requests.push(body)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (mode === 'spawn-failed' && names(body).includes(TOOL) && !anyToolResultPresent(body) && spawnTarget) rmSync(spawnTarget, { force: true })
      if (mode !== 'disabled' && mode !== 'invalid-path' && mode !== 'invalid-schema' && mode !== 'unsafe-config' && names(body).includes(TOOL) && !anyToolResultPresent(body)) res.end(toolCall())
      else res.end(finalText(mode === 'enabled' ? '<benchmark_terminal>{"status":"succeeded"}</benchmark_terminal>' : '<benchmark_terminal>{"status":"succeeded"}</benchmark_terminal>'))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const cwd = mkdtempSync(join(tmpdir(), 'gotry-bridge-cwd-'))
  const dsh = mkdtempSync(join(tmpdir(), 'gotry-bridge-dsh-'))
  const probe = join(cwd, 'benchmark-resolution-probe.cjs')
  const probeResult = join(cwd, 'benchmark-resolution-hits.json')
  writeFileSync(probeResult, '', { mode: 0o600, flag: 'wx' })
  writeResolutionProbe(probe, probeResult, mode === 'disabled')
  const runner = join(cwd, 'synthetic-runner.js')
  spawnTarget = join(cwd, 'synthetic-spawn-target.js')
  const configPath = join(cwd, mode === 'invalid-path' ? 'benchmark-env-config-\n.json' : 'benchmark-env-config.json')
  const runnerBody = mode === 'timeout'
    ? `setTimeout(() => {}, 60_000)`
    : mode === 'runner-failed'
      ? `process.stderr.write('PRIVATE_RUNNER_DIAGNOSTIC_DO_NOT_REFLECT'); process.exit(17)`
    : mode === 'output-truncated'
      ? `process.stdout.write('x'.repeat(20_000))`
      : mode === 'unexpected-output'
        ? `process.stdout.write(JSON.stringify({ result: { marker: '${MARKER}', leaked: [], unexpected: 'must-not-reflect' } }))`
      : `const forbidden = ['GOTRY_BENCHMARK_ENV_CONFIG', 'GOTRY_BENCHMARK_BRIDGE_PARENT_SECRET', 'LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL', 'DEEPSEEK_BASE_URL', 'GOTRY_LLM_MODEL', 'DATABASE_URL', 'SSH_AUTH_SOCK', 'AWS_PROFILE', 'HTTPS_PROXY']; const leaked = forbidden.filter(name => process.env[name] !== undefined); process.stdout.write(JSON.stringify({ result: { marker: '${MARKER}', leaked } }))`
  writeFileSync(runner, `if (process.argv.length !== 5 || process.argv[2] !== 'call' || process.argv[3] !== 'lookup' || JSON.parse(process.argv[4]).city !== 'Dubai') process.exit(2); ${runnerBody}`)
  writeFileSync(spawnTarget, '#!/usr/bin/env node\nprocess.exit(0)\n', { mode: 0o700 })
  writeFileSync(configPath, JSON.stringify({ schema_version: mode === 'invalid-schema' ? 'invalid' : 'gotry_benchmark_environment_bridge_v2', enabled: true, executable: mode === 'spawn-failed' ? spawnTarget : process.execPath, cwd, argv_prefix: mode === 'spawn-failed' ? ['placeholder'] : [runner], allowed_tools: ['lookup'], allowed_output_keys: { lookup: ['marker', 'leaked'] }, timeout_ms: mode === 'timeout' ? 50 : 10_000, max_output_bytes: mode === 'output-truncated' ? 1_024 : 4_096, terminal_output: { tag: 'benchmark_terminal', max_bytes: 4_096 }, isolation: { mode: 'host-enforced', writes: 'forbidden', network: 'denied' } }))
  if (mode === 'unsafe-config') chmodSync(configPath, 0o666)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DSH_TOOLS_MODE: 'both',
    DSH_HOME: dsh,
    LLM_API_KEY: 'synthetic-bridge-key',
    LLM_BASE_URL: `http://127.0.0.1:${port}/v1`,
    LLM_MODEL: 'synthetic-bridge-model',
    DEEPSEEK_API_KEY: 'synthetic-bridge-key',
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}/v1`,
    ...(mode !== 'disabled' ? {
      DATABASE_URL: 'postgres://sentinel',
      SSH_AUTH_SOCK: '/tmp/sentinel.sock',
      AWS_PROFILE: 'sentinel-profile',
    } : {}),
    GOTRY_BENCHMARK_ENV_CONFIG: mode === 'disabled' ? '' : configPath,
    ...(mode !== 'disabled' ? { GOTRY_BENCHMARK_BRIDGE_PARENT_SECRET: 'do-not-leak' } : {}),
    ...(mode === 'debug-redaction' ? { GOTRY_DEBUG: '1' } : {}),
    ...extraEnv,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, ...(!executableOverride ? [`--import=${TSX_LOADER}`] : []), `--require=${probe}`].filter(Boolean).join(' '),
  }
  for (const key of ['GOTRY_LLM_MODEL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[key]
  env.NO_PROXY = '127.0.0.1,localhost'
  if (mode !== 'disabled') env.HTTPS_PROXY = 'https://sentinel-proxy'
  if (mode === 'disabled') delete env.GOTRY_BENCHMARK_ENV_CONFIG
  const executable = executableOverride || process.execPath
  const invocation = mode === 'web-mode'
    ? ['web', '--no-open']
    : [mode === 'debug-redaction' ? 'PRIVATE_QUERY_SENTINEL_DO_NOT_REFLECT' : 'bridge smoke']
  const argv = executableOverride ? invocation : [BIN, ...invocation]
  try {
    const child = spawn(executable, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', c => { stdout += c })
    child.stderr.on('data', c => { stderr += c })
    const exit = await new Promise<number | null>(resolve => { const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(null) }, TIMEOUT_MS); child.once('close', code => { clearTimeout(timer); resolve(code) }) })
    const optionalResolutionHits = readFileSync(probeResult, 'utf8').split('\n').filter(Boolean).reduce((hits, line) => {
      const event = JSON.parse(line) as { target?: string }
      if (event.target?.includes('dsh-calendar')) hits.calendar += 1
      if (event.target?.includes('dsh-map-tools')) hits.map += 1
      return hits
    }, { calendar: 0, map: 0 })
    return { exit, stdout, stderr, output: stdout + stderr, requests, optionalResolutionHits }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(dsh, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
}

async function assertRuntimeContract(executableOverride?: string): Promise<void> {
  const target = executableOverride ? 'packaged' : 'source'
  const binSource = readFileSync(executableOverride ?? BIN, 'utf8')
  assert.equal(binSource.includes('headless-keepalive'), false, `${target} bin must not inject a headless keepalive preload`)
  assert.equal(binSource.includes('--require=${headlessKeepalivePath}'), false, `${target} bin must not mutate NODE_OPTIONS with a keepalive preload`)
  assert.equal(binSource.includes('headless-startup-hold'), false, `${target} bin must not inject a timer-based startup hold`)
  const disabled = await runCase('disabled', executableOverride)
  assert.equal(disabled.exit, 0, `${target} default-off child exit=${disabled.exit}; output tail=${disabled.output.slice(-2_000)}`)
  assert.ok(
    disabled.requests.length > 0 && !disabled.requests.some(r => names(r).includes(TOOL)),
    `${target} default-off must reach the relay without exposing benchmark tool; exit=${disabled.exit}; requests=${disabled.requests.length}; output=${disabled.output.slice(-2_000)}`,
  )
  assert.ok(disabled.optionalResolutionHits.calendar > 0 || disabled.optionalResolutionHits.map > 0, `${target} default-off must retain optional plugin resolution as a counter-proof`)
  const enabled = await runCase('enabled', executableOverride)
  assert.equal(
    enabled.exit,
    0,
    `${target} opt-in child exit=${enabled.exit}; requests=${enabled.requests.length}; tool surfaces=${JSON.stringify(enabled.requests.map(names))}; output tail=${enabled.output.slice(-10000)}`,
  )
  assert.ok(
    enabled.requests.some(r => names(r).includes(TOOL)),
    `${target} opt-in planner request must expose benchmark tool; schemas=${JSON.stringify(enabled.requests.map(names))}; output=${enabled.output.slice(-4_000)}`,
  )
  const enabledToolNames = [...new Set(enabled.requests.flatMap(names))].sort()
  assert.deepEqual(
    enabledToolNames,
    [TOOL],
    `${target} enabled runtime must expose exactly the benchmark tool; observed tool names=${JSON.stringify(enabledToolNames)}`,
  )
  assert.equal(enabledToolNames.some(name => name.startsWith('calendar_') || name.startsWith('map_')), false, `${target} benchmark projection must not expose calendar/map tools`)
  assert.deepEqual(enabled.optionalResolutionHits, { calendar: 0, map: 0 }, `${target} benchmark mode must not resolve optional calendar/map plugins`)
  assert.ok(enabled.requests.some(toolResultPresent), `${target} marker must enter model history as tool result`)
  const leakedReport = enabled.requests.map(r => JSON.stringify(r).match(/\\?"leaked\\?":\[(.*?)\]/)?.[1]).filter(Boolean).join('|')
  assert.ok(enabled.requests.some(r => /\\?"leaked\\?":\[\]/.test(JSON.stringify(r))), `${target} tool result must report no forbidden environment names; observed names=${leakedReport || '(none)'}`)
  assert.equal(enabled.requests.some(r => JSON.stringify(r).includes('do-not-leak')), false, `${target} tool result must not expose the parent secret value`)
  const enabledPrompt = enabled.requests.map(r => JSON.stringify(r)).join('\n')
  for (const variable of ['{{current_date}}', '{{time_anchor_card}}', '{{motivation_brief}}']) {
    assert.equal(enabledPrompt.includes(variable), false, `${target} benchmark persona must not retain ${variable}`)
  }
  assert.equal(enabledPrompt.includes('gotry_feasibility_check'), false, `${target} benchmark persona must not retain ordinary GoTry tool instructions`)
  assert.ok(enabled.requests.length > 0 && enabled.requests.some(request => {
    const prompt = JSON.stringify(request)
    return (prompt.match(/You are GoTry, a task-agnostic travel planning assistant\./g) ?? []).length === 1
      && (prompt.match(/Use only the current conversation and tools available in this benchmark session\./g) ?? []).length === 1
  }), `${target} benchmark persona has each stable sentence exactly once per request`)
  assert.match(enabled.output, /benchmark_terminal/)
  const debugRedaction = await runCase('debug-redaction', executableOverride)
  assert.equal(debugRedaction.exit, 0, `${target} benchmark debug mode preserves successful execution`)
  assert.equal(debugRedaction.output.includes('PRIVATE_QUERY_SENTINEL_DO_NOT_REFLECT'), false, `${target} benchmark debug output never reflects the private task`)
  const unexpected = await runCase('unexpected-output', executableOverride)
  assert.equal(unexpected.exit, 1, `${target} unexpected output must fail the successful-call conformance gate; exit=${unexpected.exit}; output tail=${unexpected.output.slice(-1000)}`)
  assert.equal(unexpected.stdout, '', `${target} rejected runner output keeps stdout empty`)
  assert.ok(unexpected.requests.some(r => JSON.stringify(r).includes('forbidden_output')), `${target} positive output allowlist must reject unexpected output`)
  assert.equal(unexpected.requests.some(r => JSON.stringify(r).includes('must-not-reflect')), false, `${target} positive output rejection must not reflect unexpected key/value`)
  assert.equal(unexpected.output.includes('<benchmark_terminal>'), false, `${target} failed bridge result cannot release a terminal body`)
  const invalidPath = await runCase('invalid-path', executableOverride)
  assert.equal(invalidPath.exit, 1, `${target} invalid config basename child exit=${invalidPath.exit}`)
  assert.equal(invalidPath.requests.length, 0, `${target} invalid config must fail before relay/network activity`)
  assert.match(invalidPath.output, /benchmark environment configuration unavailable/)
  assert.equal(invalidPath.output.includes('benchmark-env-config-'), false, `${target} invalid config error must not expose path or filename`)
  const unsafeConfig = await runCase('unsafe-config', executableOverride)
  assert.equal(unsafeConfig.exit, 1, `${target} group/world-writable config child exit=${unsafeConfig.exit}; requests=${unsafeConfig.requests.length}; output=${unsafeConfig.output.slice(-2_000)}`)
  assert.equal(unsafeConfig.requests.length, 0, `${target} unsafe config must fail before relay/network activity`)
  assert.match(unsafeConfig.output, /benchmark environment configuration unavailable/)
  const invalidSchema = await runCase('invalid-schema', executableOverride)
  assert.equal(invalidSchema.exit, 1, `${target} invalid config schema child exit=${invalidSchema.exit}`)
  assert.equal(invalidSchema.requests.length, 0, `${target} invalid schema must fail before relay/network activity`)
  assert.match(invalidSchema.output, /benchmark environment configuration unavailable/)

  const webMode = await runCase('web-mode', executableOverride)
  assert.equal(webMode.exit, 1, `${target} benchmark opt-in rejects web mode`)
  assert.equal(webMode.stdout, '', `${target} web-mode rejection keeps stdout empty`)
  assert.equal(webMode.requests.length, 0, `${target} web rejection occurs before any model request`)
  assert.match(webMode.output, /benchmark environment requires headless mode/)

  const truncated = await runCase('output-truncated', executableOverride)
  assert.equal(truncated.exit, 1, `${target} output truncation fails the successful-call conformance gate`)
  assert.ok(truncated.requests.some(r => JSON.stringify(r).includes('output_truncated')), `${target} real runner output over the configured cap is rejected`)
  assert.equal(truncated.stdout, '', `${target} output truncation keeps stdout empty`)
  assert.match(truncated.stderr, /benchmark terminal output unavailable \(child_bridge_output_truncated\)/, `${target} output truncation emits a stable bridge reason code`)
  const timedOut = await runCase('timeout', executableOverride)
  assert.equal(timedOut.exit, 1, `${target} timeout fails the successful-call conformance gate`)
  assert.ok(timedOut.requests.some(r => JSON.stringify(r).includes('timed_out')), `${target} real runner deadline is enforced`)
  assert.equal(timedOut.stdout, '', `${target} timeout keeps stdout empty`)
  assert.match(timedOut.stderr, /benchmark terminal output unavailable \(child_bridge_timed_out\)/, `${target} timeout emits a stable child bridge reason code`)
  const runnerFailed = await runCase('runner-failed', executableOverride)
  assert.equal(runnerFailed.exit, 1, `${target} runner failure fails the successful-call conformance gate`)
  assert.ok(runnerFailed.requests.some(r => JSON.stringify(r).includes('runner_failed')), `${target} nonzero runner exit is surfaced structurally`)
  assert.equal(runnerFailed.stdout, '', `${target} runner failure keeps stdout empty`)
  assert.match(runnerFailed.stderr, /benchmark terminal output unavailable \(child_bridge_runner_failed\)/, `${target} runner failure emits a stable child bridge reason code`)
  assert.equal(runnerFailed.output.includes('PRIVATE_RUNNER_DIAGNOSTIC_DO_NOT_REFLECT'), false, `${target} runner stderr is never reflected`)
  const spawnFailed = await runCase('spawn-failed', executableOverride)
  assert.equal(spawnFailed.exit, 1, `${target} runner spawn failure fails the successful-call conformance gate`)
  assert.ok(spawnFailed.requests.some(r => JSON.stringify(r).includes('spawn_failed')), `${target} runner spawn failure is surfaced structurally`)
  assert.equal(spawnFailed.stdout, '', `${target} runner spawn failure keeps stdout empty`)
  assert.match(spawnFailed.stderr, /benchmark terminal output unavailable \(child_bridge_spawn_failed\)/, `${target} runner spawn failure emits a stable child bridge reason code`)
}

async function assertSourceRuntimeContractWhenAvailable(): Promise<boolean> {
  const vendoredDsh = join(ROOT, 'ts', 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  let sourceRuntimeAvailable = existsSync(vendoredDsh)
  if (!sourceRuntimeAvailable) {
    try {
      createRequire(BIN).resolve('@deepseek-ai/dsh/lib/bin.js')
      sourceRuntimeAvailable = true
    } catch {
      sourceRuntimeAvailable = false
    }
  }
  if (!sourceRuntimeAvailable) {
    const binSource = readFileSync(BIN, 'utf8')
    assert.equal(binSource.includes('headless-keepalive'), false, 'source bin must not inject a headless keepalive preload')
    assert.equal(binSource.includes('--require=${headlessKeepalivePath}'), false, 'source bin must not mutate NODE_OPTIONS with a keepalive preload')
    assert.equal(binSource.includes('headless-startup-hold'), false, 'source bin must not inject a timer-based startup hold')
    return false
  }
  await assertRuntimeContract()
  return true
}

function installedPackageRoot(executable: string): string {
  const consumerRoot = dirname(dirname(dirname(executable)))
  const packageMain = createRequire(join(consumerRoot, 'package.json')).resolve('@danceiny/gotry')
  return dirname(dirname(dirname(packageMain)))
}

async function assertPackagedPatchProjection(executable: string): Promise<void> {
  const sourcePackageRoot = installedPackageRoot(executable)
  const packageScope = dirname(sourcePackageRoot)
  const probeParent = mkdtempSync(join(packageScope, 'round4-projection-'))
  const probePackageRoot = join(probeParent, 'gotry')
  const probeExecutable = join(probePackageRoot, 'bin', 'gotry-inner.js')
  const patchPath = join(probePackageRoot, 'cordis.gotry-patch.yml')
  const inlinePoisonModule = join(probePackageRoot, 'future-inline-plugin.cjs')
  const reorderedPoisonModule = join(probePackageRoot, 'future-reordered-plugin.cjs')
  const inlinePoisonProof = join(probeParent, 'future-inline-loaded.txt')
  const reorderedPoisonProof = join(probeParent, 'future-reordered-loaded.txt')
  cpSync(sourcePackageRoot, probePackageRoot, { recursive: true })
  chmodSync(probeExecutable, 0o755)
  const basePatch = readFileSync(patchPath, 'utf8')
  const stableError = /benchmark environment configuration unavailable/
  const poisonEnv = {
    GOTRY_FUTURE_INLINE_PROOF: inlinePoisonProof,
    GOTRY_FUTURE_REORDERED_PROOF: reorderedPoisonProof,
  }
  const runRejectedPatch = async (label: string, patch: string, forbiddenValues: string[] = []): Promise<void> => {
    rmSync(inlinePoisonProof, { force: true })
    rmSync(reorderedPoisonProof, { force: true })
    writeFileSync(patchPath, patch)
    const result = await runCase('enabled', probeExecutable, poisonEnv)
    assert.equal(result.exit, 1, `${label} must reject the benchmark startup`)
    assert.equal(result.requests.length, 0, `${label} must fail before relay activity`)
    assert.deepEqual(result.optionalResolutionHits, { calendar: 0, map: 0 }, `${label} must fail before optional plugin resolution`)
    assert.match(result.output, stableError, `${label} emits a stable generic error`)
    assert.equal(result.output.includes(probePackageRoot), false, `${label} must not reflect the package path`)
    assert.equal(existsSync(inlinePoisonProof) || existsSync(reorderedPoisonProof), false, `${label} must not execute a poison plugin`)
    for (const value of forbiddenValues) assert.equal(result.output.includes(value), false, `${label} must not reflect rejected input`)
  }

  try {
    writeFileSync(inlinePoisonModule, `const fs = require('node:fs'); fs.appendFileSync(process.env.GOTRY_FUTURE_INLINE_PROOF, 'loaded\\n'); exports.name = 'round4-future-inline'; exports.apply = () => {}`)
    writeFileSync(reorderedPoisonModule, `const fs = require('node:fs'); fs.appendFileSync(process.env.GOTRY_FUTURE_REORDERED_PROOF, 'loaded\\n'); exports.name = 'round4-future-reordered'; exports.apply = () => {}`)
    const futureEntries = [
      `    - { id: dsh-future-inline, name: '${inlinePoisonModule}' }`,
      `    - name: '${reorderedPoisonModule}'\n      id: dsh-future-reordered`,
    ].join('\n')
    const futurePatch = basePatch.replace(
      "    - id: dsh-map-tools",
      `${futureEntries}\n    - id: dsh-map-tools`,
    )
    assert.notEqual(futurePatch, basePatch, 'future-plugin fixture must enter the insert sequence')
    writeFileSync(patchPath, futurePatch)

    const ordinary = await runCase('disabled', probeExecutable, poisonEnv)
    assert.ok(existsSync(inlinePoisonProof), `default-off must execute the inline future-plugin top level; exit=${ordinary.exit}; output=${ordinary.output.slice(-2_000)}`)
    assert.ok(existsSync(reorderedPoisonProof), `default-off must execute the reordered future-plugin top level; exit=${ordinary.exit}; output=${ordinary.output.slice(-2_000)}`)
    rmSync(inlinePoisonProof, { force: true })
    rmSync(reorderedPoisonProof, { force: true })
    const benchmark = await runCase('enabled', probeExecutable, poisonEnv)
    assert.equal(benchmark.exit, 0, `benchmark future-plugin projection exits 0; output=${benchmark.output.slice(-2_000)}`)
    assert.ok(benchmark.requests.some(request => names(request).includes(TOOL)), 'benchmark future-plugin projection reaches the bridge relay')
    assert.equal(existsSync(inlinePoisonProof) || existsSync(reorderedPoisonProof), false, 'benchmark projection must not execute inline or reordered future plugins')
    assert.deepEqual(benchmark.optionalResolutionHits, { calendar: 0, map: 0 }, 'benchmark future-plugin projection does not resolve optional host plugins')

    await runRejectedPatch('missing gotry-tools', basePatch.replace('    - id: gotry-tools', '    - id: gotry-tools-missing'))
    await runRejectedPatch('duplicate gotry-tools', basePatch.replace('    - id: dsh-map-tools', "    - id: gotry-tools\n      name: 'duplicate/gotry-tools'\n    - id: dsh-map-tools"))
    await runRejectedPatch('second insert block', `${basePatch}\n- insert:\n    - id: dsh-second-insert\n      name: '${inlinePoisonModule}'\n`, [inlinePoisonModule])
    await runRejectedPatch('flow second insert block', `${basePatch}\n- insert: [{ id: dsh-flow-second-insert, name: '${inlinePoisonModule}' }]\n`, [inlinePoisonModule])
    await runRejectedPatch('spoofed gotry-tools name', basePatch.replace("name: 'placeholder/ts/src/index.ts'", `name: '${inlinePoisonModule}'`), [inlinePoisonModule])
    await runRejectedPatch(
      'spoofed gotry-tools name with decoy anchor',
      `${basePatch.replace("name: 'placeholder/ts/src/index.ts'", `name: '${inlinePoisonModule}'`)}\n- id: benchmark-name-decoy\n  name: 'placeholder/ts/src/index.ts'\n`,
      [inlinePoisonModule],
    )
    await runRejectedPatch(
      'spoofed gotry-tools name with nested decoy anchor',
      basePatch
        .replace("name: 'placeholder/ts/src/index.ts'", `name: '${inlinePoisonModule}'`)
        .replace("        stateRoot: '.'", "        name: 'placeholder/ts/src/index.ts'\n        stateRoot: '.'"),
      [inlinePoisonModule],
    )
    await runRejectedPatch('missing benchmark config anchor', basePatch.replace(/^\s*hbcliBin:.*\n/m, ''))
    await runRejectedPatch('missing benchmark config anchor with decoy', `${basePatch.replace(/^\s*hbcliBin:.*\n/m, '')}\n- id: benchmark-anchor-decoy\n  hbcliBin: 'hbcli'\n`)
    await runRejectedPatch(
      'missing benchmark config anchor with nested decoy',
      basePatch
        .replace(/^\s*hbcliBin:.*\n/m, '')
        .replace("        stateRoot: '.'", "        nestedAnchorDecoy:\n          hbcliBin: 'hbcli'\n        stateRoot: '.'"),
    )
    await runRejectedPatch('duplicate benchmark config anchor', basePatch.replace("        hbcliBin: 'hbcli'", "        hbcliBin: 'hbcli'\n        hbcliBin: 'hbcli'"))
    await runRejectedPatch('pre-existing benchmark config path', basePatch.replace("        hbcliBin: 'hbcli'", "        hbcliBin: 'hbcli'\n        benchmarkEnvironmentConfigPath: '/not/used'"), ['/not/used'])
    await runRejectedPatch('missing system-prompt anchor', basePatch.replace(/^- id: system-prompt[\s\S]*$/m, ''))
    await runRejectedPatch('duplicate system-prompt anchor', `${basePatch}\n- id: system-prompt\n  config:\n    persona: >-\n      duplicate\n`)
    await runRejectedPatch('quoted system-prompt duplicate', `${basePatch}\n- id: 'system-prompt'\n  config:\n    persona: >-\n      quoted duplicate\n`)
    const systemPromptMutationSentinel = 'ROUND7_SYSTEM_PROMPT_MUTATION_SENTINEL_DO_NOT_REFLECT'
    await runRejectedPatch('quoted mapping-key system-prompt duplicate', `${basePatch}\n- "id": system-prompt\n  config:\n    persona: >-\n      ${systemPromptMutationSentinel}\n`, [systemPromptMutationSentinel])
    await runRejectedPatch('flow quoted-key system-prompt duplicate', `${basePatch}\n- { "id": system-prompt, config: { persona: ${systemPromptMutationSentinel} } }\n`, [systemPromptMutationSentinel])
    await runRejectedPatch('reordered system-prompt duplicate', `${basePatch}\n- name: reordered-system-prompt\n  id: system-prompt\n  config:\n    persona: >-\n      reordered duplicate\n`)
    await runRejectedPatch('flow system-prompt duplicate', `${basePatch}\n- { id: system-prompt, config: { persona: flow duplicate } }\n`)
    await runRejectedPatch('noncanonical insert id root item', `${basePatch}\n- id: insert\n  config:\n    persona: >-\n      ${systemPromptMutationSentinel}\n`, [systemPromptMutationSentinel])
    await runRejectedPatch('malformed system-prompt persona', basePatch.replace(/^    persona: >-$/m, '    persona: plain'))
  } finally {
    rmSync(probeParent, { recursive: true, force: true })
  }
}

type ConformanceMode = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'large' | 'exhausted' | 'recovered' | 'post-failure' | 'unknown'
const LARGE_TERMINAL_PAYLOAD = 'x'.repeat(80 * 1024)

function taggedTerminal(valid: boolean): string {
  return `<benchmark_terminal>${valid ? '{"status":"succeeded"}' : '{"status":'}</benchmark_terminal>`
}

function conformanceResponse(mode: ConformanceMode, request: Body, plannerCount: number): string {
  const hasToolResult = (request.messages ?? []).some(message => message.role === 'tool')
  if (mode === 'a' && plannerCount === 1 && !hasToolResult) return finalText('assistant prose without a call')
  const call = mode === 'a' && plannerCount === 2
    || ['b', 'd', 'f', 'large'].includes(mode) && plannerCount === 1
  if (call && !hasToolResult) return toolCall()
  if (mode === 'f' && plannerCount === 3) return toolCall('bridge-call-retry')
  if (mode === 'large' && hasToolResult) {
    return finalText(`<benchmark_terminal>${JSON.stringify({ payload: LARGE_TERMINAL_PAYLOAD })}</benchmark_terminal>`)
  }
  const valid = mode === 'a' ? hasToolResult : mode === 'b' ? plannerCount >= 3 : mode === 'e' ? true : false
  return finalText(mode === 'c' || mode === 'd' ? 'bad benchmark body' : taggedTerminal(valid))
}

async function runConformanceCase(mode: ConformanceMode, executableOverride?: string): Promise<{ exit: number | null; stdout: string; stderr: string; requests: Body[]; servedToolCalls: number; runnerInvocations: number }> {
  const requests: Body[] = []
  let plannerCount = 0
  let recoveredAttempts = 0
  let servedToolCalls = 0
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      let body: Body = {}
      try { body = JSON.parse(Buffer.concat(chunks).toString()) as Body } catch { /* structural failure */ }
      requests.push(body)
      const requestHasToolResult = anyToolResultPresent(body)
      const plannerRequest = names(body).includes(TOOL)
      if (mode === 'exhausted' || mode === 'unknown' || (mode === 'post-failure' && requestHasToolResult)) {
        res.writeHead(mode === 'exhausted' ? 429 : mode === 'unknown' ? 418 : 500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'PRIVATE_SENTINEL_DO_NOT_REFLECT', type: 'server_error' } }))
        return
      }
      if (mode === 'recovered' && plannerRequest && !requestHasToolResult && recoveredAttempts++ === 0) {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'PRIVATE_SENTINEL_DO_NOT_REFLECT', type: 'server_error' } }))
        return
      }
      if (plannerRequest) plannerCount += 1
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const response = plannerRequest
        ? conformanceResponse(mode === 'recovered' ? 'b' : mode === 'post-failure' ? 'f' : mode, body, plannerCount)
        : finalText('auxiliary request')
      if (response.includes(`"name":"${TOOL}"`)) servedToolCalls += 1
      res.end(response)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const cwd = mkdtempSync(join(tmpdir(), 'gotry-conformance-cwd-'))
  const dsh = mkdtempSync(join(tmpdir(), 'gotry-conformance-dsh-'))
  const runner = join(cwd, 'synthetic-runner.js')
  const runnerCount = join(cwd, 'runner-count.txt')
  const configPath = join(cwd, 'benchmark-env-config.json')
  writeFileSync(runner, `const fs = require('node:fs'); const path = ${JSON.stringify(runnerCount)}; const count = fs.existsSync(path) ? Number(fs.readFileSync(path, 'utf8')) : 0; fs.writeFileSync(path, String(count + 1)); process.stdout.write(JSON.stringify({ result: { marker: '${MARKER}' } }))`)
  writeFileSync(configPath, JSON.stringify({
    schema_version: 'gotry_benchmark_environment_bridge_v2', enabled: true,
    executable: process.execPath, cwd, argv_prefix: [runner], allowed_tools: ['lookup'],
    allowed_output_keys: { lookup: ['marker'] }, timeout_ms: 2_000, max_output_bytes: 4_096,
    terminal_output: { tag: 'benchmark_terminal', max_bytes: mode === 'large' ? 128 * 1024 : 4_096 },
    isolation: { mode: 'host-enforced', writes: 'forbidden', network: 'denied' },
  }))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DSH_TOOLS_MODE: 'both', DSH_HOME: dsh,
    LLM_API_KEY: 'synthetic-conformance-key', LLM_BASE_URL: `http://127.0.0.1:${port}/v1`,
    LLM_MODEL: 'synthetic-conformance-model', GOTRY_BENCHMARK_ENV_CONFIG: configPath,
    DEEPSEEK_API_KEY: 'synthetic-conformance-key', DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}/v1`,
    NODE_OPTIONS: [
      process.env.NODE_OPTIONS,
      ...(!executableOverride ? [`--import=${TSX_LOADER}`] : []),
    ].filter(Boolean).join(' '),
  }
  for (const key of ['GOTRY_LLM_MODEL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[key]
  env.NO_PROXY = '127.0.0.1,localhost'
  let stdout = ''
  let stderr = ''
  try {
    const executable = executableOverride || process.execPath
    const argv = executableOverride ? ['conformance smoke'] : [BIN, 'conformance smoke']
    const child = spawn(executable, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    const exit = await new Promise<number | null>(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(null) }, TIMEOUT_MS)
      child.once('close', code => { clearTimeout(timer); resolve(code) })
    })
    const runnerInvocations = existsSync(runnerCount) ? Number(readFileSync(runnerCount, 'utf8')) : 0
    return { exit, stdout, stderr, requests, servedToolCalls, runnerInvocations }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(dsh, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
}

async function assertTerminalDiagnostics(executableOverride?: string): Promise<void> {
  const terminalReasons = (stderr: string): string[] => [...stderr.matchAll(/benchmark terminal output unavailable \(([^)]+)\)/g)].map(match => match[1]!)
  const exhausted = await runConformanceCase('exhausted', executableOverride)
  assert.notEqual(exhausted.exit, 0, 'exhausted transient model failure exits non-zero')
  assert.match(exhausted.stderr, /child_model_capacity/, 'exhausted transient model failure emits coarse capacity enum')
  assert.ok(exhausted.requests.length > 1, 'exhausted case actually exercises retry attempts')
  assert.equal(exhausted.stdout, '', 'exhausted transient model failure releases no terminal stdout')
  assert.equal(exhausted.stderr.includes('PRIVATE_SENTINEL_DO_NOT_REFLECT'), false, 'exhausted error body is never reflected')
  assert.deepEqual(terminalReasons(exhausted.stderr), ['child_model_capacity'], 'exhausted emits exactly one terminal reason')

  const recovered = await runConformanceCase('recovered', executableOverride)
  assert.equal(recovered.exit, 0, 'transient model failure followed by valid terminal recovers')
  assert.match(recovered.stdout, /<benchmark_terminal>/, 'recovered run releases terminal stdout')
  assert.equal(recovered.stderr.includes('child_model_'), false, 'recovered run emits no failure enum')
  assert.deepEqual(terminalReasons(recovered.stderr), [], 'recovered emits no terminal reason')

  const postFailure = await runConformanceCase('post-failure', executableOverride)
  assert.notEqual(postFailure.exit, 0, 'model failure after successful bridge exits non-zero')
  assert.equal(postFailure.runnerInvocations, 1, 'post-bridge failure follows exactly one successful bridge invocation')
  assert.match(postFailure.stderr, /child_model_server/, 'post-bridge model failure emits server enum')
  assert.equal(postFailure.stdout, '', 'post-bridge model failure releases no terminal stdout')
  assert.deepEqual(terminalReasons(postFailure.stderr), ['child_model_server'], 'post-bridge emits exactly one terminal reason')

  const unknown = await runConformanceCase('unknown', executableOverride)
  assert.notEqual(unknown.exit, 0, 'unknown model failure exits non-zero')
  assert.match(unknown.stderr, /child_runtime_error/, 'unknown model failure collapses to generic runtime enum')
  assert.equal(unknown.stdout, '', 'unknown model failure releases no terminal stdout')
  assert.equal(unknown.stderr.includes('PRIVATE_SENTINEL_DO_NOT_REFLECT'), false, 'unknown error body is never reflected')
  assert.deepEqual(terminalReasons(unknown.stderr), ['child_runtime_error'], 'unknown emits exactly one terminal reason')

  const precedence = await runConformanceCase('f', executableOverride)
  assert.match(precedence.stderr, /child_conformance_failure/, 'conformance-specific failure remains higher precedence than final generic error')
  assert.equal(precedence.stderr.includes('child_runtime_error'), false, 'generic terminal classification does not double-write')
  assert.deepEqual(terminalReasons(precedence.stderr), ['child_conformance_failure'], 'precedence emits exactly one terminal reason')
}

async function assertOutputConformance(executableOverride?: string): Promise<void> {
  const a = await runConformanceCase('a', executableOverride)
  assert.equal(a.exit, 0, 'A prose/no-call correction then one bridge call and valid terminal exits 0')
  assert.equal(a.servedToolCalls, 1, 'A exposes exactly one bridge call')
  assert.equal(a.runnerInvocations, 1, 'A executes the bridge subprocess exactly once')
  assert.ok(a.stdout.includes('<benchmark_terminal>'), 'A forwards only tagged terminal output')

  const b = await runConformanceCase('b', executableOverride)
  assert.equal(b.exit, 0, 'B malformed terminal correction then valid terminal exits 0')
  assert.equal(b.servedToolCalls, 1, `B exposes exactly one bridge call; request shapes=${JSON.stringify(b.requests.map(request => ({ tools: names(request), roles: (request.messages ?? []).map(message => message.role) })))}`)
  assert.equal(b.runnerInvocations, 1, 'B format-only correction does not rerun the bridge subprocess')

  for (const mode of ['c', 'd'] as const) {
    const result = await runConformanceCase(mode, executableOverride)
    assert.notEqual(result.exit, 0, `${mode.toUpperCase()} repeated invalid output is non-zero`)
    assert.match(result.stderr, /benchmark terminal output unavailable \(child_conformance_failure\)/, `${mode.toUpperCase()} emits a stable conformance reason code`)
    assert.equal(result.stdout.includes('bad benchmark body'), false, `${mode.toUpperCase()} does not forward invalid body to stdout`)
    assert.equal(result.stderr.includes('bad benchmark body'), false, `${mode.toUpperCase()} stable diagnostics do not reflect invalid body`)
    assert.equal(result.runnerInvocations, mode === 'c' ? 0 : 1, `${mode.toUpperCase()} subprocess count matches the accepted call history`)
  }

  const e = await runConformanceCase('e', executableOverride)
  assert.notEqual(e.exit, 0, 'E valid tagged terminal without bridge call is rejected')
  assert.match(e.stderr, /benchmark terminal output unavailable \(child_conformance_failure\)/, 'E emits a stable conformance reason code')
  assert.equal(e.stdout.includes('<benchmark_terminal>'), false, 'E does not forward terminal without call')
  assert.equal(e.runnerInvocations, 0, 'E never executes the bridge subprocess')

  const f = await runConformanceCase('f', executableOverride)
  assert.notEqual(f.exit, 0, 'F format correction that tries another bridge call is rejected')
  assert.match(f.stderr, /benchmark terminal output unavailable \(child_conformance_failure\)/, 'F emits a stable conformance reason code')
  assert.equal(f.servedToolCalls, 2, 'F model attempts a second native call')
  assert.equal(f.runnerInvocations, 1, 'F conformance guard blocks the second subprocess dispatch')
  assert.equal(f.stdout.includes('<benchmark_terminal>'), false, 'F does not release a terminal body after retry redispatch')

  const large = await runConformanceCase('large', executableOverride)
  assert.equal(large.exit, 0, 'large valid terminal flushes before successful process close')
  assert.equal(large.runnerInvocations, 1, 'large terminal still executes the bridge once')
  assert.ok(Buffer.byteLength(large.stdout, 'utf8') > 64 * 1024, 'large terminal exceeds the ordinary pipe buffer')
  assert.match(large.stdout, /<\/benchmark_terminal>\s*$/)
}

const packaged = process.env.GOTRY_BRIDGE_E2E_BIN
assertRuntimeSelectionAndVersionGuards()
const sourceRuntimeChecked = await assertSourceRuntimeContractWhenAvailable()
if (sourceRuntimeChecked) await assertOutputConformance()
if (sourceRuntimeChecked) await assertTerminalDiagnostics()

if (packaged) {
  await assertRuntimeContract(packaged)
  await assertOutputConformance(packaged)
  await assertTerminalDiagnostics(packaged)
  await assertPackagedPatchProjection(packaged)
  const packageRoot = installedPackageRoot(packaged)
  const packagedBridge = await import(pathToFileURL(join(packageRoot, 'dist', 'src', 'benchmark-environment-bridge.js')).href)
  const missingServiceRoot = mkdtempSync(join(tmpdir(), 'gotry-bridge-missing-service-'))
  try {
    const configPath = join(missingServiceRoot, 'bridge.json')
    writeFileSync(configPath, JSON.stringify({
      schema_version: 'gotry_benchmark_environment_bridge_v2', enabled: true,
      executable: process.execPath, cwd: missingServiceRoot, argv_prefix: ['-e', 'process.exit(0)'],
      allowed_tools: ['lookup'], timeout_ms: 100, max_output_bytes: 4_096,
      terminal_output: { tag: 'benchmark_terminal', max_bytes: 4_096 },
      isolation: { mode: 'host-enforced', writes: 'forbidden', network: 'denied' },
    }))
    assert.throws(
      () => packagedBridge.registerBenchmarkEnvironmentBridge(configPath, () => {}, undefined),
      /benchmark environment bridge subprocess unavailable/,
      'packaged explicit opt-in fails hard when no active subprocess provider exists',
    )
  } finally {
    rmSync(missingServiceRoot, { recursive: true, force: true })
  }
}
console.log(`benchmark environment bridge E2E: OK (${packaged ? (sourceRuntimeChecked ? 'source + packaged' : 'source-static + packaged') : (sourceRuntimeChecked ? 'source' : 'source-static')})`)
