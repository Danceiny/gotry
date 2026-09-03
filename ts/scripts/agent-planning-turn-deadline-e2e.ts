/**
 * Offline headless E2E for the agent turn boundary (ADR-24 v2).
 *
 * Exercises a clean installed-package binary on the PRODUCT path:
 *   bin/gotry-inner.js -> dist/src/index.js -> dsh headless -> local SSE relay
 *
 * 场景是失败轨迹的合成重放:deep-planning 类用户消息(10.3 婚礼 + 十几天
 * + 请假 + IRW)进入路由,relay 把首个 planner 响应拖过硬阈(阈值经 env
 * 压到秒级,exit 仍由路由决定为 handoff)→ 首个工具派发被拒并落
 * `gotry_turn_handoff.v1` 工单 → 工具 schema 同步抑制 → 下一请求
 * text-only → 二进制以含 ETA 语义的 final 收尾。工单落盘走
 * GOTRY_TURN_HANDOFF_ROOT 钉死的隔离根,不触碰真实 gotry-state
 * (巡检状态纪律);DSH_HOME 与 child cwd 均为临时目录,唯一模型端点
 * 是 loopback。
 */

import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const ROOT = join(import.meta.dirname, '..', '..')
const TS_DIR = join(import.meta.dirname, '..')
const TIMEOUT_MS = 90_000
const TOOL = 'gotry_artifacts_list'
const SOFT_MS = 5_000
const HARD_MS = 10_000
const RELAY_STALL_MS = HARD_MS + 1_000
const HANDOFF = 'TURN_DEADLINE_HANDOFF'
const HANDOFF_SCHEMA = 'gotry_turn_handoff.v1'
/** 失败轨迹的合成等价消息:必须命中 deep-planning 路由。 */
const DEEP_MESSAGE = '2026年我还有6天IRW额度,我准备再请几天假,在国内待个十几天。'
  + '其中10.3要去湖南衡阳参加同学婚礼。请根据我的实际情况和偏好,给我安排行程'

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
        const plannerIndex = plannerBodies.length
        const alreadyHandedOff = JSON.stringify(body).includes(HANDOFF)
        // 首个 planner 响应拖过硬阈:首个工具派发必然越过 wall-clock 边界。
        // handoff 发生后,后续 planner 请求一律回 text-only final,收敛回路。
        const stall = !alreadyHandedOff && plannerIndex === 1 ? RELAY_STALL_MS : 0
        setTimeout(() => {
          if (!alreadyHandedOff && plannerIndex === 1) {
            res.end(toolResponse(String(plannerIndex)))
          } else {
            res.end(textResponse('deadline E2E final answer'))
          }
        }, stall)
      } else {
        // Session-title and other auxiliary calls deliberately carry no tool
        // schemas. Keep them out of the planner-call budget and answer text.
        res.end(textResponse('deadline E2E final answer', 'deadline-auxiliary'))
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
  // 巡检状态纪律:handoff 工单只落隔离根(source 模式 dsh cwd 是创始人真实
  // 数据目录 ts/dsh-runtime,绝不让 E2E 往那里写)。
  const handoffRoot = mkdtempSync(join(tmpdir(), 'gotry-deadline-handoff-'))
  let exitCode: number | null = null
  let output = ''
  const configuredBin = process.env.GOTRY_DEADLINE_E2E_BIN
  assert.ok(configuredBin && existsSync(configuredBin), 'GOTRY_DEADLINE_E2E_BIN must point to the clean installed-package binary')
  try {
    const executableArgs = [DEEP_MESSAGE]
    const childEnv: NodeJS.ProcessEnv = { ...process.env }
    childEnv.DSH_HOME = dshHome
    childEnv.LLM_API_KEY = 'synthetic-e2e-key'
    childEnv.LLM_BASE_URL = 'http://127.0.0.1:' + relay.port + '/v1'
    childEnv.LLM_MODEL = 'synthetic-deadline-model'
    childEnv.GOTRY_LOCALE = 'zh-CN'
    childEnv.GOTRY_TURN_DEADLINE_SOFT_MS = String(SOFT_MS)
    childEnv.GOTRY_TURN_DEADLINE_HARD_MS = String(HARD_MS)
    childEnv.GOTRY_TURN_HANDOFF_ROOT = handoffRoot
    delete childEnv.GOTRY_LLM_MODEL
    delete childEnv.GOTRY_FORCE_TURN_DEADLINE
    const child = spawn(configuredBin, executableArgs, {
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
    // relay 故意不在此关闭:收集闭环段还要以同一 relay 做模型端点。
    // Give the spawned binary a brief moment to release its temp files
    // before we recursively remove the tmpdir.
    await new Promise<void>(resolve => setTimeout(resolve, 200))
  }

  assert.equal(exitCode, 0, `headless exit=${exitCode}; output tail=${output.slice(-1200)}`)
  assert.ok(
    relay.plannerBodies.length >= 1,
    `expected at least one tool-enabled planner request, got ${relay.plannerBodies.length}; output tail=${output.slice(-12_000)}`,
  )

  // 首个工具派发越过硬阈:必须得到 handoff 语义的结构化拒绝,且没有任何
  // 工具 body 真正执行。
  const toolMessages = allToolMessages(relay.bodies)
  const toolMessageDiagnostic = JSON.stringify(toolMessages).slice(-12_000)
  const handoffResults = toolMessages.filter(message => JSON.stringify(message).includes(HANDOFF))
  const successfulResults = toolMessages.filter(message => !JSON.stringify(message).includes(HANDOFF))
  assert.ok(handoffResults.length >= 1, `expected at least one handoff result; messages=${toolMessageDiagnostic}`)
  assert.equal(successfulResults.length, 0, `no tool body should run past the hard deadline; messages=${toolMessageDiagnostic}`)
  assert.match(JSON.stringify(handoffResults[0]), /th-/, 'handoff result carries the ticket id')

  // handoff 工单已落隔离根,字段完整(含用户原文与 ETA 承诺)。
  const ticketDir = join(handoffRoot, 'gotry-state', 'turn-handoffs')
  assert.ok(existsSync(ticketDir), `ticket dir missing: ${ticketDir}`)
  const ticketFiles = readdirSync(ticketDir).filter(name => name.endsWith('.json'))
  assert.equal(ticketFiles.length, 1, `expected exactly one handoff ticket, got ${ticketFiles.join(', ')}`)
  const ticket = JSON.parse(readFileSync(join(ticketDir, ticketFiles[0]), 'utf8')) as Record<string, unknown>
  assert.equal(ticket['schema'], HANDOFF_SCHEMA)
  assert.equal(ticket['status'], 'open')
  assert.ok(String(ticket['userMessage']).includes('婚礼'), 'ticket carries the verbatim deep-planning ask')
  assert.ok(String(ticket['etaLabel']).includes('约 1 小时'))

  // 回路收敛:最终请求不带任何继承工具 schema,二进制输出 final。
  const finalRequest = relay.bodies.at(-1) as WireBody
  const finalNames = toolNames(finalRequest)
  assert.ok(!finalNames.includes(TOOL), `final request inherited GoTry tool: ${finalNames.join(', ')}`)
  assert.match(output, /deadline E2E final answer/)

  // ---- 收集闭环:collector 以真打包二进制为 planner 回收这单工单。------
  // 子会话(GOTRY_HANDOFF_CHILD=1)带满工具面打到 relay;relay 的全局
  // plannerIndex 已 >1,立即回 text-only final → 子会话 converge 退出,
  // collector 把最终答复结算为交付物。工单 open→settled,交付物可复访。
  {
    const ticketId = String(ticket['id'])
    const collector = spawn(process.execPath, [
      join(TS_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      join(TS_DIR, 'scripts', 'turn-handoff-collect.ts'),
      ticketId, handoffRoot,
    ], {
      cwd: TS_DIR,
      env: {
        ...process.env,
        GOTRY_HANDOFF_PLANNER_BIN: configuredBin,
        LLM_API_KEY: 'synthetic-e2e-key',
        LLM_BASE_URL: 'http://127.0.0.1:' + relay.port + '/v1',
        LLM_MODEL: 'synthetic-deadline-model',
        GOTRY_LOCALE: 'zh-CN',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let collectorOut = ''
    let collectorErr = ''
    collector.stdout.on('data', chunk => { collectorOut += chunk.toString() })
    collector.stderr.on('data', chunk => { collectorErr += chunk.toString() })
    const collectorCode = await new Promise<number | null>(resolve => {
      const timer = setTimeout(() => { collector.kill('SIGKILL'); resolve(null) }, 90_000)
      collector.once('exit', code => { clearTimeout(timer); resolve(code) })
    })
    assert.equal(collectorCode, 0, `collector exit=${collectorCode}; stderr tail=${collectorErr.slice(-800)}; stdout tail=${collectorOut.slice(-400)}`)
    const terminal = JSON.parse(collectorOut.trim().split('\n').at(-1)!) as Record<string, unknown>
    assert.equal(terminal['schema'], 'gotry_turn_handoff_terminal.v1')
    assert.equal(terminal['status'], 'succeeded')
    assert.ok(String(terminal['deliverable_path']).includes(`${ticketId}.deliverable.md`))

    const settled = JSON.parse(readFileSync(join(ticketDir, `${ticketId}.json`), 'utf8')) as Record<string, unknown>
    assert.equal(settled['status'], 'settled')
    assert.ok(settled['settledAt'], 'settledAt recorded')
    const deliverable = readFileSync(join(ticketDir, `${ticketId}.deliverable.md`), 'utf8')
    assert.ok(deliverable.includes('deadline E2E final answer'), `deliverable carries planner final; got: ${deliverable.slice(-400)}`)
  }

  console.log(`agent turn deadline E2E: OK (exit=${exitCode}, plannerRequests=${relay.plannerBodies.length}, handoffResults=${handoffResults.length}, ticket=${ticketFiles[0]}, collected=settled)`)

  await relay.close()
  rmSync(dshHome, { recursive: true, force: true })
  rmSync(childCwd, { recursive: true, force: true })
  rmSync(handoffRoot, { recursive: true, force: true })
}

await main()