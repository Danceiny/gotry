/**
 * 证据日期绑定闸的安装包真实运行 E2E(rc.33 行程实测 2026-11-01)。
 *
 * 干净安装的二进制走产品路径:bin/gotry-inner.js → dist/src/index.js → dsh headless →
 * 本地 SSE relay(唯一模型端点是 loopback)。relay 按脚本让 planner 依次:
 *   1. write R1 产物(两条红眼航班标 ✅ 写在从未查询的日期上)→ 必须被 EVIDENCE_DATE_BINDING 拒,文件不落盘
 *   2. write R2 修正版 → 落盘
 *   3. 拖过硬阈后调研究类工具 → TURN_DEADLINE_* 拒(证明已进截止模式)
 *   4. present 一份 shell 写出的 R1 产物 → 截止后仍被本闸拒
 *   5. present R2 → 交付成功
 * 证明真实 dsh 的 tools/pre-execute 瀑布把解析后的参数交给本闸、deny 生效,且截止模式同样覆盖。
 *
 * 事实注册表种在隔离 cwd 的 gotry-state/(安装包模式 stateRoot '.' = dsh cwd = 子进程 cwd);
 * 产物日期写明年份,不依赖宿主时钟(无年份写法的解析由 evidence-date-binding-tests.ts 覆盖)。
 * DSH_HOME/HOME/cwd/handoff 根均为临时目录,不碰真实 gotry-state。
 *
 * 运行:GOTRY_EVIDENCE_E2E_BIN=<安装包 node_modules/.bin/gotry> npx tsx scripts/evidence-date-guard-e2e.ts
 */

import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

import { R1_FACTS, R1_MD, R2_MD } from './fixtures/rc33-evidence-date-fixtures.ts'

const TIMEOUT_MS = 120_000
const SOFT_MS = 4_000
const HARD_MS = 8_000
const GUARD = 'EVIDENCE_DATE_BINDING'

/** 产物里无年份的 M/D 写明 2026(与夹具事实同年),E2E 不随宿主日期漂移 */
function withYear(markdown: string): string {
  return markdown.replace(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/g, (_m, mo: string, d: string) => `2026-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`)
}

const R1 = withYear(R1_MD)
const R2 = withYear(R2_MD)

type Step = { stallMs?: number; name: string; input: Record<string, unknown> }
const STEPS: Step[] = [
  { name: 'write', input: { file_path: 'plan-r1.md', content: R1 } },
  { name: 'write', input: { file_path: 'plan-r2.md', content: R2 } },
  { name: 'gotry_artifacts_list', input: { query: { limit: 1 } }, stallMs: HARD_MS + 1_000 },
  { name: 'present', input: { files: [{ path: 'plan-r1-shell.md' }] } },
  { name: 'present', input: { files: [{ path: 'plan-r2.md' }] } },
]

type WireBody = { messages?: Array<Record<string, unknown>>; tools?: Array<Record<string, unknown>> }

function sse(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

function toolUse(id: string, name: string, input: Record<string, unknown>): string {
  return sse({ type: 'message_start', message: { usage: { input_tokens: 10 } } })
    + sse({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } })
    + sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } })
    + sse({ type: 'content_block_stop', index: 0 })
    + sse({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } })
    + sse({ type: 'message_stop' }) + 'data: [DONE]\n\n'
}

function text(answer: string): string {
  return sse({ type: 'message_start', message: { usage: { input_tokens: 10 } } })
    + sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: answer } })
    + sse({ type: 'content_block_stop', index: 0 })
    + sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } })
    + sse({ type: 'message_stop' }) + 'data: [DONE]\n\n'
}

function toolNames(body: WireBody): string[] {
  return (body.tools ?? []).map(tool => String((tool.function as Record<string, unknown> | undefined)?.name ?? tool.name ?? '')).filter(Boolean)
}

/** 历史里每个 tool_result 块(新线型:user 消息内的 tool_result;旧线型:role='tool') */
function toolResults(body: WireBody): Map<string, string> {
  const results = new Map<string, string>()
  for (const message of body.messages ?? []) {
    if (message.role === 'tool' && typeof message.tool_call_id === 'string') results.set(message.tool_call_id, JSON.stringify(message))
    if (!Array.isArray(message.content)) continue
    for (const block of message.content as Array<Record<string, unknown>>) {
      if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') results.set(block.tool_use_id, JSON.stringify(block))
    }
  }
  return results
}

async function startRelay(): Promise<{ port: number; planner: WireBody[]; close: () => Promise<void> }> {
  const planner: WireBody[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST' || !(req.url?.endsWith('/chat/completions') || req.url?.endsWith('/messages'))) {
      res.writeHead(404).end('not found'); return
    }
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      let body: WireBody
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as WireBody } catch { body = {} }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      // 标题生成等辅助调用不带工具 schema;planner 请求即使在截止后也还带着 present
      if (!toolNames(body).includes('present')) { res.end(text('auxiliary')); return }
      planner.push(body)
      const step = STEPS[planner.length - 1]
      setTimeout(() => res.end(step ? toolUse(`evidence-call-${planner.length}`, step.name, step.input) : text('evidence E2E final answer')), step?.stallMs ?? 0)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { port: (server.address() as { port: number }).port, planner, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}

async function main(): Promise<void> {
  const bin = process.env.GOTRY_EVIDENCE_E2E_BIN
  assert.ok(bin && existsSync(bin), 'GOTRY_EVIDENCE_E2E_BIN must point to the clean installed-package binary')
  const relay = await startRelay()
  const dshHome = mkdtempSync(join(tmpdir(), 'gotry-evidence-dsh-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'gotry-evidence-cwd-'))
  const handoffRoot = mkdtempSync(join(tmpdir(), 'gotry-evidence-handoff-'))
  mkdirSync(join(cwd, 'gotry-state'), { recursive: true })
  writeFileSync(join(cwd, 'gotry-state', 'bookable-facts.jsonl'), R1_FACTS.map(f => JSON.stringify(f)).join('\n') + '\n')
  writeFileSync(join(cwd, 'plan-r1-shell.md'), R1)
  let output = ''
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DSH_HOME: dshHome,
      HOME: dshHome,
      LLM_API_KEY: 'synthetic-e2e-key',
      LLM_BASE_URL: `http://127.0.0.1:${relay.port}/v1`,
      LLM_MODEL: 'synthetic-evidence-model',
      GOTRY_LOCALE: 'zh-CN',
      GOTRY_TURN_DEADLINE_SOFT_MS: String(SOFT_MS),
      GOTRY_TURN_DEADLINE_HARD_MS: String(HARD_MS),
      GOTRY_TURN_HANDOFF_ROOT: handoffRoot,
    }
    delete env.GOTRY_LLM_MODEL
    delete env.GOTRY_FORCE_TURN_DEADLINE
    const child = spawn(bin, ['把 12 月行程整理成文件并交付'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', chunk => { output += chunk.toString() })
    child.stderr.on('data', chunk => { output += chunk.toString() })
    const exitCode = await new Promise<number | null>(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(null) }, TIMEOUT_MS)
      child.once('exit', code => { clearTimeout(timer); resolve(code) })
    })
    assert.equal(exitCode, 0, `headless exit=${exitCode}; output tail=${output.slice(-1500)}`)
    assert.ok(relay.planner.length > STEPS.length, `expected ${STEPS.length + 1} planner requests, got ${relay.planner.length}; output tail=${output.slice(-1500)}`)

    const results = toolResults(relay.planner.at(-1)!)
    const result = (k: number): string => results.get(`evidence-call-${k}`) ?? ''
    const diag = (k: number): string => result(k).slice(0, 600)

    assert.ok(result(1).includes(GUARD) && /QR1019/.test(result(1)) && /EK329/.test(result(1)) && result(1).includes('2026-12-17'),
      `1 write R1:真实 pre-execute 拒绝并逐行点名;got ${diag(1)}`)
    assert.ok(!existsSync(join(cwd, 'plan-r1.md')), '1 write R1:被拒的产物没有落盘')
    assert.ok(!result(2).includes(GUARD) && existsSync(join(cwd, 'plan-r2.md')) && readFileSync(join(cwd, 'plan-r2.md'), 'utf8') === R2,
      `2 write R2:放行并原样落盘;got ${diag(2)}`)
    assert.ok(/TURN_DEADLINE_(?:EXHAUSTED|HANDOFF)/.test(result(3)), `3 已过硬阈:研究类工具被截止闸拒绝;got ${diag(3)}`)
    assert.ok(result(4).includes(GUARD) && result(4).includes('plan-r1-shell.md'), `4 截止后 present shell 写出的 R1:仍被本闸拒;got ${diag(4)}`)
    assert.ok(!result(5).includes(GUARD) && !result(5).includes('TURN_DEADLINE') && /plan-r2\.md/.test(result(5)),
      `5 截止后 present R2:交付成功;got ${diag(5)}`)
    assert.match(output, /evidence E2E final answer/)
    console.log(`evidence date guard E2E: OK (exit=${exitCode}, plannerRequests=${relay.planner.length}; write R1 denied, R2 written; after hard deadline present R1 denied, R2 presented)`)
  } finally {
    await relay.close()
    await new Promise<void>(resolve => setTimeout(resolve, 200))
    for (const dir of [dshHome, cwd, handoffRoot]) rmSync(dir, { recursive: true, force: true })
  }
}

await main()
