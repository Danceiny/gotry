/**
 * Offline headless E2E for the agent tool-call budget.
 *
 * This deliberately exercises the published/npm path:
 *   bin/gotry-inner.js -> dist/src/index.js -> dsh headless -> local SSE relay
 * No GoTry state is used: both DSH_HOME and the child cwd are fresh temporary
 * directories, and the only model endpoint is a loopback HTTP server.
 */

import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const ROOT = join(import.meta.dirname, '..', '..')
const BIN = join(ROOT, 'bin', 'gotry-inner.js')
const TIMEOUT_MS = 90_000
const TOOL = 'gotry_artifacts_list'
const EXHAUSTED = 'TOOL_BUDGET_EXHAUSTED'

type WireBody = {
  messages?: Array<Record<string, unknown>>
  tools?: Array<Record<string, unknown>>
}

type Relay = {
  port: number
  bodies: WireBody[]
  plannerBodies: WireBody[]
  close: () => Promise<void>
}

function sse(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

function toolResponse(number: number): string {
  const count = number === 18 ? 2 : 1
  const calls = Array.from({ length: count }, (_, index) => ({
    index,
    id: `budget-call-${number}-${index + 1}`,
    type: 'function',
    function: { name: TOOL, arguments: JSON.stringify({ query: { limit: 1 } }) },
  }))
  return sse({
    id: `budget-${number}`,
    object: 'chat.completion.chunk',
    created: 1,
    model: 'synthetic-budget-model',
    choices: [{ index: 0, delta: { role: 'assistant', tool_calls: calls }, finish_reason: null }],
  }) + sse({
    id: `budget-${number}-finish`,
    object: 'chat.completion.chunk',
    created: 1,
    model: 'synthetic-budget-model',
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
  }) + 'data: [DONE]\n\n'
}

function textResponse(text: string, id = 'budget-final'): string {
  return sse({
    id, object: 'chat.completion.chunk', created: 1,
    model: 'synthetic-budget-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
  }) + sse({
    id: `${id}-finish`, object: 'chat.completion.chunk', created: 1,
    model: 'synthetic-budget-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  }) + 'data: [DONE]\n\n'
}

async function startRelay(): Promise<Relay> {
  const bodies: WireBody[] = []
  const plannerBodies: WireBody[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end('not found'); return
    }
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      let body: WireBody
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as WireBody } catch { body = {} }
      bodies.push(body)
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      if (toolNames(body).includes(TOOL)) {
        plannerBodies.push(body)
        res.end(toolResponse(plannerBodies.length))
      } else if (plannerBodies.length >= 18) {
        res.end(textResponse('budget E2E final answer'))
      } else {
        // Session-title and other auxiliary calls deliberately carry no tool
        // schemas. Keep them out of the planner-call budget and answer text.
        res.end(textResponse('budget e2e title', 'budget-auxiliary'))
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as { port: number }).port,
    bodies,
    plannerBodies,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

function allToolMessages(bodies: WireBody[]): Array<Record<string, unknown>> {
  return bodies.flatMap(body => (body.messages ?? []).filter(message => message.role === 'tool'))
}

function toolNames(body: WireBody): string[] {
  return (body.tools ?? []).map(tool => {
    const fn = tool.function as Record<string, unknown> | undefined
    return String(fn?.name ?? tool.name ?? '')
  }).filter(Boolean)
}

async function main(): Promise<void> {
  for (const file of ['dist/src/index.js', 'dist/capabilities/artifacts.js']) {
    assert.ok(existsSync(join(ROOT, file)), `missing ${file}; run node scripts/build-dist.mjs first`)
  }

  const relay = await startRelay()
  const dshHome = mkdtempSync(join(tmpdir(), 'gotry-budget-dsh-home-'))
  const childCwd = mkdtempSync(join(tmpdir(), 'gotry-budget-cwd-'))
  const vendored = join(ROOT, 'ts', 'dsh-runtime', 'node_modules')
  const aside = join(tmpdir(), `gotry-budget-vendored-${process.pid}`)
  let restored = false
  const restore = () => {
    if (restored) return
    restored = true
    if (existsSync(aside) && !existsSync(vendored)) renameSync(aside, vendored)
  }
  let exitCode: number | null = null
  let output = ''
  const configuredBin = process.env.GOTRY_BUDGET_E2E_BIN
  try {
    // npm-mode is selected by absence of the vendored runtime. Restore in finally.
    if (!configuredBin && existsSync(vendored)) renameSync(vendored, aside)
    const executable = configuredBin || process.execPath
    const executableArgs = configuredBin ? ['exercise the tool budget'] : [BIN, 'exercise the tool budget']
    const childEnv: NodeJS.ProcessEnv = { ...process.env }
    childEnv.DSH_HOME = dshHome
    childEnv.LLM_API_KEY = 'synthetic-e2e-key'
    childEnv.LLM_BASE_URL = 'http://127.0.0.1:' + relay.port + '/v1'
    childEnv.LLM_MODEL = 'synthetic-budget-model'
    childEnv.GOTRY_LOCALE = 'zh-CN'
    delete childEnv.GOTRY_LLM_MODEL
    const child = spawn(executable, executableArgs, {
      cwd: childCwd,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', chunk => { output += chunk.toString() })
    child.stderr.on('data', chunk => { output += chunk.toString() })
    exitCode = await new Promise<number | null>(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(null) }, TIMEOUT_MS)
      child.once('exit', code => { clearTimeout(timer); resolve(code) })
    })
  } finally {
    await relay.close()
    restore()
    rmSync(dshHome, { recursive: true, force: true })
    rmSync(childCwd, { recursive: true, force: true })
  }

  assert.equal(exitCode, 0, `headless exit=${exitCode}; output tail=${output.slice(-1200)}`)
  assert.equal(
    relay.plannerBodies.length,
    18,
    `expected 18 tool-enabled planner requests, got ${relay.plannerBodies.length}; output tail=${output.slice(-12_000)}`,
  )

  // Every request carries the full conversation history. Inspect the last
  // request so each dispatched tool result is counted exactly once.
  const finalRequest = relay.bodies.at(-1) as WireBody
  const toolMessages = allToolMessages([finalRequest])
  const normalResults = toolMessages.filter(message => !JSON.stringify(message).includes(EXHAUSTED))
  const exhaustedResults = toolMessages.filter(message => JSON.stringify(message).includes(EXHAUSTED))
  const toolMessageDiagnostic = JSON.stringify(toolMessages).slice(-12_000)
  assert.equal(normalResults.length, 18, `exactly 18 real tool results/body dispatches; messages=${toolMessageDiagnostic}`)
  assert.ok(normalResults.every(message => JSON.stringify(message).includes('无在册产物')), `all 18 bodies must return the registered artifact-list result; messages=${toolMessageDiagnostic}`)
  assert.equal(exhaustedResults.length, 1, `19th call returns one structured exhaustion result; messages=${toolMessageDiagnostic}`)
  assert.ok(JSON.stringify(exhaustedResults[0]).includes(EXHAUSTED))
  assert.equal(exhaustedResults[0]?.tool_call_id, 'budget-call-18-2')

  const finalNames = toolNames(finalRequest)
  assert.ok(!finalNames.includes(TOOL), `final request inherited GoTry tool: ${finalNames.join(', ')}`)
  assert.equal(finalNames.length, 0, `final request must be text-only, got ${finalNames.join(', ')}`)
  assert.match(output, /budget E2E final answer/)
  console.log(`agent planning budget E2E: OK (exit=${exitCode}, plannerRequests=${relay.plannerBodies.length}, allModelRequests=${relay.bodies.length}, realToolResults=${normalResults.length}, exhausted=${exhaustedResults.length})`)
}

await main()
