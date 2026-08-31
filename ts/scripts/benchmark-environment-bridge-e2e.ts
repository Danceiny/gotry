/** Offline contract for the opt-in benchmark environment bridge.
 *
 * Covers default-off, explicit opt-in, and fail-closed configuration paths.
 * A local developer run exercises the source checkout. CI supplies the clean
 * packaged consumer binary because the historical root npm lock does not
 * materialize dsh's complete peer closure.
 */
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
type Body = { messages?: Array<Record<string, unknown>>; tools?: Array<Record<string, unknown>> }

function sse(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}
function finalText(text: string): string {
  return sse({ id: 'bridge-final', object: 'chat.completion.chunk', choices: [{ delta: { role: 'assistant', content: text }, finish_reason: null }] })
    + sse({ id: 'bridge-final-stop', object: 'chat.completion.chunk', choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n'
}
function toolCall(): string {
  return sse({ id: 'bridge-call', object: 'chat.completion.chunk', choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'bridge-call-1', type: 'function', function: { name: TOOL, arguments: JSON.stringify({ query: { action: 'call', tool: 'lookup', arguments: { city: 'Dubai' } } }) } }] }, finish_reason: null }] })
    + sse({ id: 'bridge-call-stop', object: 'chat.completion.chunk', choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n'
}
function names(body: Body): string[] {
  return (body.tools ?? []).map(t => { const f = t.function as Record<string, unknown> | undefined; return String(f?.name ?? t.name ?? '') }).filter(Boolean)
}
function toolResultPresent(body: Body): boolean {
  return (body.messages ?? []).some(m => m.role === 'tool' && JSON.stringify(m).includes(MARKER))
}

type CaseMode = 'disabled' | 'enabled' | 'invalid-path' | 'invalid-schema' | 'unsafe-config' | 'output-truncated' | 'timeout'

async function runCase(mode: CaseMode, executableOverride?: string): Promise<{ exit: number | null; output: string; requests: Body[] }> {
  const requests: Body[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(Buffer.from(c)))
    req.on('end', () => {
      let body: Body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString()) as Body } catch { /* diagnostic remains structural */ }
      requests.push(body)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (mode !== 'disabled' && mode !== 'invalid-path' && mode !== 'invalid-schema' && mode !== 'unsafe-config' && names(body).includes(TOOL) && !toolResultPresent(body)) res.end(toolCall())
      else res.end(finalText(mode === 'enabled' ? 'bridge final text' : 'default final text'))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const cwd = mkdtempSync(join(tmpdir(), 'gotry-bridge-cwd-'))
  const dsh = mkdtempSync(join(tmpdir(), 'gotry-bridge-dsh-'))
  const runner = join(cwd, 'synthetic-runner.js')
  const configPath = join(cwd, mode === 'invalid-path' ? 'benchmark-env-config-\n.json' : 'benchmark-env-config.json')
  const runnerBody = mode === 'timeout'
    ? `setTimeout(() => {}, 60_000)`
    : mode === 'output-truncated'
      ? `process.stdout.write('x'.repeat(20_000))`
      : `const forbidden = ['GOTRY_BENCHMARK_ENV_CONFIG', 'GOTRY_BENCHMARK_BRIDGE_PARENT_SECRET', 'LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL', 'DEEPSEEK_BASE_URL', 'GOTRY_LLM_MODEL', 'DATABASE_URL', 'SSH_AUTH_SOCK', 'AWS_PROFILE', 'HTTPS_PROXY']; const leaked = forbidden.filter(name => process.env[name] !== undefined); process.stdout.write(JSON.stringify({ result: { marker: '${MARKER}', leaked } }))`
  writeFileSync(runner, `if (process.argv.length !== 5 || process.argv[2] !== 'call' || process.argv[3] !== 'lookup' || JSON.parse(process.argv[4]).city !== 'Dubai') process.exit(2); ${runnerBody}`)
  writeFileSync(configPath, JSON.stringify({ schema_version: mode === 'invalid-schema' ? 'invalid' : 'gotry_benchmark_environment_bridge_v1', enabled: true, executable: process.execPath, cwd, argv_prefix: [runner], allowed_tools: ['lookup'], timeout_ms: mode === 'timeout' ? 50 : 10_000, max_output_bytes: mode === 'output-truncated' ? 1_024 : 4_096, isolation: { mode: 'host-enforced', writes: 'forbidden', network: 'denied' } }))
  if (mode === 'unsafe-config') chmodSync(configPath, 0o666)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
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
  }
  if (mode === 'disabled') delete env.GOTRY_BENCHMARK_ENV_CONFIG
  const executable = executableOverride || process.execPath
  const argv = executableOverride ? ['bridge smoke'] : [BIN, 'bridge smoke']
  try {
    const child = spawn(executable, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; child.stdout.on('data', c => { output += c }); child.stderr.on('data', c => { output += c })
    const exit = await new Promise<number | null>(resolve => { const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(null) }, TIMEOUT_MS); child.once('exit', code => { clearTimeout(timer); resolve(code) }) })
    return { exit, output, requests }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(dsh, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
}

async function assertRuntimeContract(executableOverride?: string): Promise<void> {
  const target = executableOverride ? 'packaged' : 'source'
  const disabled = await runCase('disabled', executableOverride)
  assert.equal(disabled.exit, 0, `${target} default-off child exit=${disabled.exit}; output tail=${disabled.output.slice(-2_000)}`)
  assert.ok(
    disabled.requests.length > 0 && !disabled.requests.some(r => names(r).includes(TOOL)),
    `${target} default-off must reach the relay without exposing benchmark tool; exit=${disabled.exit}; requests=${disabled.requests.length}; output=${disabled.output.slice(-2_000)}`,
  )
  const enabled = await runCase('enabled', executableOverride)
  assert.equal(enabled.exit, 0, `${target} opt-in child exit=${enabled.exit}; output tail=${enabled.output.slice(-1000)}`)
  assert.ok(
    enabled.requests.some(r => names(r).includes(TOOL)),
    `${target} opt-in planner request must expose benchmark tool; schemas=${JSON.stringify(enabled.requests.map(names))}; output=${enabled.output.slice(-4_000)}`,
  )
  assert.ok(enabled.requests.some(toolResultPresent), `${target} marker must enter model history as tool result`)
  const leakedReport = enabled.requests.map(r => JSON.stringify(r).match(/\\?"leaked\\?":\[(.*?)\]/)?.[1]).filter(Boolean).join('|')
  assert.ok(enabled.requests.some(r => /\\?"leaked\\?":\[\]/.test(JSON.stringify(r))), `${target} tool result must report no forbidden environment names; observed names=${leakedReport || '(none)'}`)
  assert.equal(enabled.requests.some(r => JSON.stringify(r).includes('do-not-leak')), false, `${target} tool result must not expose the parent secret value`)
  assert.match(enabled.output, /bridge final text/)
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

  const truncated = await runCase('output-truncated', executableOverride)
  assert.equal(truncated.exit, 0, `${target} output truncation child exit=${truncated.exit}`)
  assert.ok(truncated.requests.some(r => JSON.stringify(r).includes('output_truncated')), `${target} real runner output over the configured cap is rejected`)
  const timedOut = await runCase('timeout', executableOverride)
  assert.equal(timedOut.exit, 0, `${target} timeout child exit=${timedOut.exit}`)
  assert.ok(timedOut.requests.some(r => JSON.stringify(r).includes('timed_out')), `${target} real runner deadline is enforced`)
}

const packaged = process.env.GOTRY_BRIDGE_E2E_BIN
await assertRuntimeContract(packaged)

if (packaged) {
  const consumerRoot = dirname(dirname(dirname(packaged)))
  const packageMain = createRequire(join(consumerRoot, 'package.json')).resolve('@danceiny/gotry')
  const packageRoot = dirname(dirname(dirname(packageMain)))
  const packagedBridge = await import(pathToFileURL(join(packageRoot, 'dist', 'src', 'benchmark-environment-bridge.js')).href)
  const missingServiceRoot = mkdtempSync(join(tmpdir(), 'gotry-bridge-missing-service-'))
  try {
    const configPath = join(missingServiceRoot, 'bridge.json')
    writeFileSync(configPath, JSON.stringify({
      schema_version: 'gotry_benchmark_environment_bridge_v1', enabled: true,
      executable: process.execPath, cwd: missingServiceRoot, argv_prefix: ['-e', 'process.exit(0)'],
      allowed_tools: ['lookup'], timeout_ms: 100, max_output_bytes: 4_096,
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
console.log(`benchmark environment bridge E2E: OK (${packaged ? 'packaged' : 'source'})`)
