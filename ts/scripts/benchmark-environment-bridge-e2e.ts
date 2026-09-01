/** Offline contract for the opt-in benchmark environment bridge.
 *
 * Covers default-off, explicit opt-in, and fail-closed configuration paths.
 * A local developer run exercises the source checkout. CI supplies the clean
 * packaged consumer binary because the historical root npm lock does not
 * materialize dsh's complete peer closure.
 */
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'

const ROOT = join(import.meta.dirname, '..', '..')
const BIN = join(ROOT, 'bin', 'gotry-inner.js')
const TOOL = 'gotry_benchmark_environment'
const MARKER = 'BENCHMARK_BRIDGE_LOOKUP_OK'
const TIMEOUT_MS = 30_000
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
type Body = { messages?: Array<Record<string, unknown>>; tools?: Array<Record<string, unknown>> }

function writeIsolationPreload(path: string, proofPath: string, executableOverride?: string): void {
  const anchor = executableOverride || join(ROOT, 'ts', 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const gotryEntry = executableOverride ? '@danceiny/gotry' : join(ROOT, 'ts', 'src', 'index.ts')
  const dshEntry = join(ROOT, 'ts', 'dsh-runtime', 'vendor', 'deepseek-ai-dsh', 'lib', 'bin.js')
  writeFileSync(path, `
const fs = require('node:fs')
const Module = require('node:module')
const { createRequire } = require('node:module')
const blocked = new Set(['dsh-calendar', 'dsh-calendar/lib/index.js'])
const originalResolve = Module._resolveFilename
Module._resolveFilename = function (request, parent, isMain, options) {
  if (blocked.has(request)) {
    const error = new Error('isolated benchmark runtime')
    error.code = 'MODULE_NOT_FOUND'
    throw error
  }
  return originalResolve.call(this, request, parent, isMain, options)
}
const resolver = createRequire(${JSON.stringify(anchor)})
const resolve = request => { try { resolver.resolve(request); return true } catch { return false } }
const proof = {
  calendarBlocked: [...blocked].every(request => !resolve(request)),
  dshResolvable: resolve('@deepseek-ai/dsh/lib/bin.js') || fs.existsSync(${JSON.stringify(dshEntry)}),
  tsxResolvable: resolve('tsx'),
  gotryResolvable: resolve(${JSON.stringify(gotryEntry)}),
}
  fs.writeFileSync(${JSON.stringify(proofPath)}, JSON.stringify(proof), { mode: 0o600 })
`, { mode: 0o600, flag: 'wx' })
}

function assertIsolationProof(proofPath: string, target: string): void {
  assert.deepEqual(JSON.parse(readFileSync(proofPath, 'utf8')), {
    calendarBlocked: true,
    dshResolvable: true,
    tsxResolvable: true,
    gotryResolvable: true,
  }, `${target} preload must isolate only calendar resolution while preserving dsh/tsx/GoTry resolution`)
}

function sse(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}
function finalText(text: string): string {
  return sse({ id: 'bridge-final', object: 'chat.completion.chunk', choices: [{ delta: { role: 'assistant', content: text }, finish_reason: null }] })
    + sse({ id: 'bridge-final-stop', object: 'chat.completion.chunk', choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n'
}
function toolCall(callId = 'bridge-call-1'): string {
  return sse({ id: `bridge-${callId}`, object: 'chat.completion.chunk', choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: TOOL, arguments: JSON.stringify({ query: { action: 'call', tool: 'lookup', arguments: { city: 'Dubai' } } }) } }] }, finish_reason: null }] })
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

type CaseMode = 'disabled' | 'enabled' | 'unexpected-output' | 'invalid-path' | 'invalid-schema' | 'unsafe-config' | 'output-truncated' | 'timeout' | 'web-mode' | 'debug-redaction'

async function runCase(mode: CaseMode, executableOverride?: string): Promise<{ exit: number | null; output: string; requests: Body[] }> {
  const requests: Body[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(Buffer.from(c)))
    req.on('end', () => {
      let body: Body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString()) as Body } catch { /* diagnostic remains structural */ }
      requests.push(body)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (mode !== 'disabled' && mode !== 'invalid-path' && mode !== 'invalid-schema' && mode !== 'unsafe-config' && names(body).includes(TOOL) && !anyToolResultPresent(body)) res.end(toolCall())
      else res.end(finalText(mode === 'enabled' ? '<benchmark_terminal>{"status":"succeeded"}</benchmark_terminal>' : '<benchmark_terminal>{"status":"succeeded"}</benchmark_terminal>'))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const cwd = mkdtempSync(join(tmpdir(), 'gotry-bridge-cwd-'))
  const dsh = mkdtempSync(join(tmpdir(), 'gotry-bridge-dsh-'))
  const preload = join(cwd, 'benchmark-isolation-preload.cjs')
  const preloadProof = join(cwd, 'benchmark-isolation-proof.json')
  writeIsolationPreload(preload, preloadProof, executableOverride)
  const runner = join(cwd, 'synthetic-runner.js')
  const configPath = join(cwd, mode === 'invalid-path' ? 'benchmark-env-config-\n.json' : 'benchmark-env-config.json')
  const runnerBody = mode === 'timeout'
    ? `setTimeout(() => {}, 60_000)`
    : mode === 'output-truncated'
      ? `process.stdout.write('x'.repeat(20_000))`
      : mode === 'unexpected-output'
        ? `process.stdout.write(JSON.stringify({ result: { marker: '${MARKER}', leaked: [], unexpected: 'must-not-reflect' } }))`
      : `const forbidden = ['GOTRY_BENCHMARK_ENV_CONFIG', 'GOTRY_BENCHMARK_BRIDGE_PARENT_SECRET', 'LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL', 'DEEPSEEK_BASE_URL', 'GOTRY_LLM_MODEL', 'DATABASE_URL', 'SSH_AUTH_SOCK', 'AWS_PROFILE', 'HTTPS_PROXY']; const leaked = forbidden.filter(name => process.env[name] !== undefined); process.stdout.write(JSON.stringify({ result: { marker: '${MARKER}', leaked } }))`
  writeFileSync(runner, `if (process.argv.length !== 5 || process.argv[2] !== 'call' || process.argv[3] !== 'lookup' || JSON.parse(process.argv[4]).city !== 'Dubai') process.exit(2); ${runnerBody}`)
  writeFileSync(configPath, JSON.stringify({ schema_version: mode === 'invalid-schema' ? 'invalid' : 'gotry_benchmark_environment_bridge_v2', enabled: true, executable: process.execPath, cwd, argv_prefix: [runner], allowed_tools: ['lookup'], allowed_output_keys: { lookup: ['marker', 'leaked'] }, timeout_ms: mode === 'timeout' ? 50 : 10_000, max_output_bytes: mode === 'output-truncated' ? 1_024 : 4_096, terminal_output: { tag: 'benchmark_terminal', max_bytes: 4_096 }, isolation: { mode: 'host-enforced', writes: 'forbidden', network: 'denied' } }))
  if (mode === 'unsafe-config') chmodSync(configPath, 0o666)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DSH_TOOLS_MODE: 'both',
    DSH_HOME: dsh,
    LLM_API_KEY: 'synthetic-bridge-key',
    LLM_BASE_URL: `http://127.0.0.1:${port}/v1`,
    LLM_MODEL: 'synthetic-bridge-model',
    DATABASE_URL: 'postgres://sentinel',
    SSH_AUTH_SOCK: '/tmp/sentinel.sock',
    AWS_PROFILE: 'sentinel-profile',
    HTTPS_PROXY: 'https://sentinel-proxy',
    GOTRY_BENCHMARK_ENV_CONFIG: mode === 'disabled' ? '' : configPath,
    ...(mode !== 'disabled' ? { GOTRY_BENCHMARK_BRIDGE_PARENT_SECRET: 'do-not-leak' } : {}),
    ...(mode === 'debug-redaction' ? { GOTRY_DEBUG: '1' } : {}),
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preload}`, ...(!executableOverride ? [`--import=${TSX_LOADER}`] : [])].filter(Boolean).join(' '),
  }
  if (mode === 'disabled') delete env.GOTRY_BENCHMARK_ENV_CONFIG
  const executable = executableOverride || process.execPath
  const invocation = mode === 'web-mode'
    ? ['web', '--no-open']
    : [mode === 'debug-redaction' ? 'PRIVATE_QUERY_SENTINEL_DO_NOT_REFLECT' : 'bridge smoke']
  const argv = executableOverride ? invocation : [BIN, ...invocation]
  try {
    const child = spawn(executable, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; child.stdout.on('data', c => { output += c }); child.stderr.on('data', c => { output += c })
    const exit = await new Promise<number | null>(resolve => { const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(null) }, TIMEOUT_MS); child.once('close', code => { clearTimeout(timer); resolve(code) }) })
    assertIsolationProof(preloadProof, targetForExecutable(executableOverride))
    return { exit, output, requests }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(dsh, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
}

function targetForExecutable(executableOverride?: string): string { return executableOverride ? 'packaged' : 'source' }

async function assertRuntimeContract(executableOverride?: string): Promise<void> {
  const target = executableOverride ? 'packaged' : 'source'
  const disabled = await runCase('disabled', executableOverride)
  assert.equal(disabled.exit, 0, `${target} default-off child exit=${disabled.exit}; output tail=${disabled.output.slice(-2_000)}`)
  assert.ok(
    disabled.requests.length > 0 && !disabled.requests.some(r => names(r).includes(TOOL)),
    `${target} default-off must reach the relay without exposing benchmark tool; exit=${disabled.exit}; requests=${disabled.requests.length}; output=${disabled.output.slice(-2_000)}`,
  )
  assert.equal(
    disabled.requests.some(r => names(r).some(name => name.startsWith('calendar_'))),
    false,
    `${target} calendar isolation must not leave calendar tools on the default-off relay`,
  )
  const enabled = await runCase('enabled', executableOverride)
  assert.equal(enabled.exit, 0, `${target} opt-in child exit=${enabled.exit}; output tail=${enabled.output.slice(-1000)}`)
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
  assert.ok(enabled.requests.some(toolResultPresent), `${target} marker must enter model history as tool result`)
  const leakedReport = enabled.requests.map(r => JSON.stringify(r).match(/\\?"leaked\\?":\[(.*?)\]/)?.[1]).filter(Boolean).join('|')
  assert.ok(enabled.requests.some(r => /\\?"leaked\\?":\[\]/.test(JSON.stringify(r))), `${target} tool result must report no forbidden environment names; observed names=${leakedReport || '(none)'}`)
  assert.equal(enabled.requests.some(r => JSON.stringify(r).includes('do-not-leak')), false, `${target} tool result must not expose the parent secret value`)
  assert.match(enabled.output, /benchmark_terminal/)
  const debugRedaction = await runCase('debug-redaction', executableOverride)
  assert.equal(debugRedaction.exit, 0, `${target} benchmark debug mode preserves successful execution`)
  assert.equal(debugRedaction.output.includes('PRIVATE_QUERY_SENTINEL_DO_NOT_REFLECT'), false, `${target} benchmark debug output never reflects the private task`)
  const unexpected = await runCase('unexpected-output', executableOverride)
  assert.equal(unexpected.exit, 1, `${target} unexpected output must fail the successful-call conformance gate; exit=${unexpected.exit}; output tail=${unexpected.output.slice(-1000)}`)
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
  assert.equal(webMode.requests.length, 0, `${target} web rejection occurs before any model request`)
  assert.match(webMode.output, /benchmark environment requires headless mode/)

  const truncated = await runCase('output-truncated', executableOverride)
  assert.equal(truncated.exit, 1, `${target} output truncation fails the successful-call conformance gate`)
  assert.ok(truncated.requests.some(r => JSON.stringify(r).includes('output_truncated')), `${target} real runner output over the configured cap is rejected`)
  const timedOut = await runCase('timeout', executableOverride)
  assert.equal(timedOut.exit, 1, `${target} timeout fails the successful-call conformance gate`)
  assert.ok(timedOut.requests.some(r => JSON.stringify(r).includes('timed_out')), `${target} real runner deadline is enforced`)
}

type ConformanceMode = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'large'
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
  let servedToolCalls = 0
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      let body: Body = {}
      try { body = JSON.parse(Buffer.concat(chunks).toString()) as Body } catch { /* structural failure */ }
      requests.push(body)
      const plannerRequest = names(body).includes(TOOL)
      if (plannerRequest) plannerCount += 1
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const response = plannerRequest
        ? conformanceResponse(mode, body, plannerCount)
        : finalText('auxiliary request')
      if (response.includes(`"name":"${TOOL}"`)) servedToolCalls += 1
      res.end(response)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const cwd = mkdtempSync(join(tmpdir(), 'gotry-conformance-cwd-'))
  const dsh = mkdtempSync(join(tmpdir(), 'gotry-conformance-dsh-'))
  const preload = join(cwd, 'benchmark-isolation-preload.cjs')
  const preloadProof = join(cwd, 'benchmark-isolation-proof.json')
  writeIsolationPreload(preload, preloadProof, executableOverride)
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
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preload}`, ...(!executableOverride ? [`--import=${TSX_LOADER}`] : [])].filter(Boolean).join(' '),
  }
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
    assertIsolationProof(preloadProof, targetForExecutable(executableOverride))
    return { exit, stdout, stderr, requests, servedToolCalls, runnerInvocations }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(dsh, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
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
    assert.equal(result.stdout.includes('bad benchmark body'), false, `${mode.toUpperCase()} does not forward invalid body to stdout`)
    assert.equal(result.stderr.includes('bad benchmark body'), false, `${mode.toUpperCase()} stable diagnostics do not reflect invalid body`)
    assert.equal(result.runnerInvocations, mode === 'c' ? 0 : 1, `${mode.toUpperCase()} subprocess count matches the accepted call history`)
  }

  const e = await runConformanceCase('e', executableOverride)
  assert.notEqual(e.exit, 0, 'E valid tagged terminal without bridge call is rejected')
  assert.equal(e.stdout.includes('<benchmark_terminal>'), false, 'E does not forward terminal without call')
  assert.equal(e.runnerInvocations, 0, 'E never executes the bridge subprocess')

  const f = await runConformanceCase('f', executableOverride)
  assert.notEqual(f.exit, 0, 'F format correction that tries another bridge call is rejected')
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
await assertRuntimeContract()
await assertOutputConformance()

if (packaged) {
  await assertRuntimeContract(packaged)
  await assertOutputConformance(packaged)
  const consumerRoot = dirname(dirname(dirname(packaged)))
  const packageMain = createRequire(join(consumerRoot, 'package.json')).resolve('@danceiny/gotry')
  const packageRoot = dirname(dirname(dirname(packageMain)))
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
console.log(`benchmark environment bridge E2E: OK (${packaged ? 'source + packaged' : 'source'})`)
