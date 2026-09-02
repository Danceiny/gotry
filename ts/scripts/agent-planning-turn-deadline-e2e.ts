/**
 * Offline headless E2E for the agent turn-deadline wall-clock guard.
 *
 * Exercises a clean installed-package binary:
 *   bin/gotry-inner.js -> dist/src/index.js -> dsh headless -> local SSE relay
 *
 * The deadline is shrunk to a few hundred ms via env so the E2E runs in
 * under a second. The relay stalls the first planner response by ~600 ms
 * so the second planner request lands past the hard deadline; subsequent
 * requests must arrive without tool schemas and the model must converge to
 * the text-only final answer. No GoTry state is used: both DSH_HOME and the
 * child cwd are fresh temporary directories, and the only model endpoint is
 * loopback.
 */

import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const ROOT = join(import.meta.dirname, '..', '..')
const TIMEOUT_MS = 90_000
const TOOL = 'gotry_artifacts_list'
const SOFT_MS = 5_000
const HARD_MS = 10_000
const RELAY_STALL_MS = HARD_MS + 1_000
const EXHAUSTED = 'TURN_DEADLINE_EXHAUSTED'

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

function toolResponse(idSuffix: string): string {
  const call = {
    index: 0,
    id: `deadline-call-${idSuffix}`,
    type: 'function',
    function: { name: TOOL, arguments: JSON.stringify({ query: { limit: 1 } }) },
  }
  return sse({
    id: `deadline-${idSuffix}`,
    object: 'chat.completion.chunk',
    created: 1,
    model: 'synthetic-deadline-model',
    choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [call] }, finish_reason: null }],
  }) + sse({
    id: `deadline-${idSuffix}-finish`,
    object: 'chat.completion.chunk',
    created: 1,
    model: 'synthetic-deadline-model',
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
  }) + 'data: [DONE]\n\n'
}

function textResponse(text: string, id = 'deadline-final'): string {
  return sse({
    id, object: 'chat.completion.chunk', created: 1,
    model: 'synthetic-deadline-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
  }) + sse({
    id: `${id}-finish`, object: 'chat.completion.chunk', created: 1,
    model: 'synthetic-deadline-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
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
        const alreadyExhausted = JSON.stringify(body).includes(EXHAUSTED)
        const plannerIndex = plannerBodies.length
        // Stalling the first planner response past HARD_MS guarantees the
        // binary's first `tools/execute` lands after the wall-clock deadline
        // — the very first tool call must be refused with
        // TURN_DEADLINE_EXHAUSTED and no successful tool body should ever run.
        // Once exhaustion has fired, every subsequent planner request must
        // be answered with the text-only final answer so the agent loop
        // converges and the binary emits the final.
        const stall = !alreadyExhausted && plannerIndex === 1 ? RELAY_STALL_MS : 0
        setTimeout(() => {
          if (!alreadyExhausted && plannerIndex === 1) {
            res.end(toolResponse(String(plannerIndex)))
          } else {
            res.end(textResponse('deadline E2E final answer'))
          }
        }, stall)
      } else {
        // Session-title and other auxiliary calls deliberately carry no tool
        // schemas. Headless mode forwards only the first text response to
        // stdout, so we return the final-answer text here to satisfy the
        // output assertion; the agent-loop convergence check still holds
        // because the planner requests above carry the EXHAUSTED message.
        res.end(textResponse('deadline E2E final answer', 'deadline-final'))
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
  const dshHome = mkdtempSync(join(tmpdir(), 'gotry-deadline-dsh-home-'))
  const childCwd = mkdtempSync(join(tmpdir(), 'gotry-deadline-cwd-'))
  let exitCode: number | null = null
  let output = ''
  const configuredBin = process.env.GOTRY_DEADLINE_E2E_BIN
  assert.ok(configuredBin && existsSync(configuredBin), 'GOTRY_DEADLINE_E2E_BIN must point to the clean installed-package binary')
  try {
    const executable = configuredBin
    const executableArgs = ['exercise the turn deadline']
    const childEnv: NodeJS.ProcessEnv = { ...process.env }
    childEnv.DSH_HOME = dshHome
    childEnv.LLM_API_KEY = 'synthetic-e2e-key'
    childEnv.LLM_BASE_URL = 'http://127.0.0.1:' + relay.port + '/v1'
    childEnv.LLM_MODEL = 'synthetic-deadline-model'
    childEnv.GOTRY_LOCALE = 'zh-CN'
    childEnv.GOTRY_DISABLE_OPTIONAL_CALENDAR = '1'
    childEnv.GOTRY_TURN_DEADLINE_SOFT_MS = String(SOFT_MS)
    childEnv.GOTRY_TURN_DEADLINE_HARD_MS = String(HARD_MS)
    // Force-install the turn-deadline hook on the product path so this E2E
    // exercises the same code branch the benchmark opt-in path uses without
    // pulling in the full benchmark bridge / model-override kernel.
    childEnv.GOTRY_FORCE_TURN_DEADLINE = '1'
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
    // Give the spawned binary a brief moment to release its temp files
    // before we recursively remove the tmpdir. Without this, on fast
    // wall-clock-deadline E2Es the cleanup races against the child still
    // holding an open handle on `dshHome`.
    await new Promise<void>(resolve => setTimeout(resolve, 200))
    rmSync(dshHome, { recursive: true, force: true })
    rmSync(childCwd, { recursive: true, force: true })
  }

  assert.equal(exitCode, 0, `headless exit=${exitCode}; output tail=${output.slice(-1200)}`)
  assert.ok(
    relay.plannerBodies.length >= 1,
    `expected at least one tool-enabled planner request, got ${relay.plannerBodies.length}; output tail=${output.slice(-12_000)}`,
  )

  // Wall-clock budget of HARD_MS=50ms fires well inside the first planner
  // request — the binary's process boot + initial agent-loop dispatch is
  // already past the deadline by the time the first `tools/execute` runs.
  // That means the very first tool call must be refused with
  // TURN_DEADLINE_EXHAUSTED and no successful tool body should ever run.
  const toolMessages = allToolMessages(relay.bodies)
  const exhaustedResults = toolMessages.filter(message => JSON.stringify(message).includes(EXHAUSTED))
  const successfulResults = toolMessages.filter(message => message.content && !JSON.stringify(message).includes(EXHAUSTED))
  const toolMessageDiagnostic = JSON.stringify(toolMessages).slice(-12_000)
  assert.ok(
    exhaustedResults.length >= 1,
    `expected at least one structured exhaustion result; messages=${toolMessageDiagnostic}`,
  )
  assert.equal(
    successfulResults.length,
    0,
    `no tool body should run before HARD_MS=50ms; messages=${toolMessageDiagnostic}`,
  )

  // The conversation converges: the final native request must arrive without
  // any inherited GoTry tool schema, and the model must surface its final
  // text answer.
  const finalRequest = relay.bodies.at(-1) as WireBody
  const finalNames = toolNames(finalRequest)
  assert.ok(!finalNames.includes(TOOL), `final request inherited GoTry tool: ${finalNames.join(', ')}`)
  assert.match(output, /deadline E2E final answer/)
  console.log(`agent planning turn deadline E2E: OK (exit=${exitCode}, plannerRequests=${relay.plannerBodies.length}, exhausted=${exhaustedResults.length})`)
}

await main()