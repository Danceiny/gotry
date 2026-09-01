/**
 * issue #77 E2E:LLM_MODEL 对 dsh 会话面生效的端到端证据。
 *
 * 四场景(全部走真实路径:clean package bin → dsh headless →
 * llm-deepseek → 本地 mock OpenAI 兼容中转,中转落盘每个请求体的 model 字段):
 *
 *   1. 设 LLM_MODEL,干净 DSH_HOME        → 请求体 model = LLM_MODEL
 *   2. 设 LLM_MODEL,DSH_HOME 预置用户层选择 → 请求体 model = LLM_MODEL
 *      (用户层 ~/.dsh 选择被 .env 显式意图压过——#77 发现场景的正面回归)
 *   3. 不设 LLM_MODEL,干净 DSH_HOME      → 请求体 model = deepseek-v4-flash
 *      (dsh 组合默认,默认路径面不变)
 *   4. 不设 LLM_MODEL,DSH_HOME 预置用户层选择 → 请求体 model = 用户层模型
 *      (用户 web 选择不被误伤,默认路径面不变)
 *
 * 隔离纪律(巡检/测试状态纪律):DSH_HOME 指向临时目录(会话/设置零污染);
 * mock 模型只回固定文本、从不调工具 → gotry-state 零写入(动机/愿望池不动);
 * 环境变量直接 export(不走 .env 文件,repo 模式 .env 加载路径已由 #48 覆盖)。
 *
 * 形态:只接受 clean npm 安装形态——插件走 dist/ 纯 JS，不再通过移动源码树依赖
 * 来伪装 package mode。调用方须提供当前 tarball 安装出的 bin。
 *
 * 运行(在仓根):GOTRY_MODEL_OVERRIDE_E2E_BIN=/clean/node_modules/.bin/gotry
 *   npx tsx ts/scripts/model-override-e2e.ts
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const BOOT_TIMEOUT_MS = 120_000

interface CapturedRequest { model?: unknown; stream?: unknown }

/** mock OpenAI 兼容中转:落盘请求体 model,回最小合法 SSE 流 */
async function startMockRelay(): Promise<{ port: number; bodies: CapturedRequest[]; close: () => Promise<void> }> {
  const bodies: CapturedRequest[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end('not found')
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      try { bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as CapturedRequest) } catch { bodies.push({}) }
      const chunk = (delta: Record<string, unknown>, finish: string | null) =>
        `data: ${JSON.stringify({ id: 'e2e', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write(chunk({ role: 'assistant', content: 'ok' }, null))
      res.write(chunk({}, 'stop'))
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return { port, bodies, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

interface Scenario {
  name: string
  llmModel?: string
  userLayerModel?: string
  expectModel: string
}

async function runScenario(s: Scenario, packageBin: string): Promise<{ ok: boolean; detail: string }> {
  const relay = await startMockRelay()
  const dshHome = mkdtempSync(join(tmpdir(), 'gotry-77-dsh-home-'))
  const childCwd = mkdtempSync(join(tmpdir(), 'gotry-77-cwd-'))
  try {
    if (s.userLayerModel) {
      // 预置用户层设置(等价于用户在 dsh web UI 选过模型并持久化)
      writeFileSync(join(dshHome, 'settings.yaml'),
        `agent-default-model:\n  provider: deepseek-official\n  model: ${s.userLayerModel}\n`)
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      LLM_API_KEY: 'e2e-mock-key',
      LLM_BASE_URL: `http://127.0.0.1:${relay.port}/v1`,
      DSH_HOME: dshHome,
    }
    delete env['GOTRY_LLM_MODEL'] // 防宿主环境串扰;只认本场景显式设定
    if (s.llmModel) env['LLM_MODEL'] = s.llmModel
    else delete env['LLM_MODEL']

    const child = spawn(packageBin, ['reply with the word ok'], {
      env,
      cwd: childCwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let logTail = ''
    child.stdout.on('data', (d) => { logTail = (logTail + d).slice(-2000) })
    child.stderr.on('data', (d) => { logTail = (logTail + d).slice(-2000) })
    const exit = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(null) }, BOOT_TIMEOUT_MS)
      child.on('exit', (code) => { clearTimeout(timer); resolve(code) })
    })

    if (relay.bodies.length === 0) {
      return { ok: false, detail: `中转未收到任何请求(exit=${exit});尾部日志: ${logTail.slice(-400)}` }
    }
    const models = relay.bodies.map((b) => String(b.model))
    const bad = models.filter((m) => m !== s.expectModel)
    return bad.length === 0
      ? { ok: true, detail: `${models.length} 个请求体 model 全部 = ${s.expectModel}(exit=${exit})` }
      : { ok: false, detail: `请求体 model 不符:期望 ${s.expectModel},实际 ${JSON.stringify(models)}` }
  } finally {
    await relay.close()
    rmSync(dshHome, { recursive: true, force: true })
    rmSync(childCwd, { recursive: true, force: true })
  }
}

async function main() {
  const packageBin = process.env.GOTRY_MODEL_OVERRIDE_E2E_BIN
  if (!packageBin || !existsSync(packageBin)) {
    console.error('GOTRY_MODEL_OVERRIDE_E2E_BIN 必须指向当前 tarball 的 clean installed-package bin')
    process.exit(2)
  }
  await runAll(packageBin)
}

async function runAll(packageBin: string) {
  const scenarios: Scenario[] = [
    { name: '① 设 LLM_MODEL(干净 DSH_HOME)', llmModel: 'gotry-e2e-model', expectModel: 'gotry-e2e-model' },
    { name: '② 设 LLM_MODEL + 用户层已选模型', llmModel: 'gotry-e2e-model', userLayerModel: 'user-picked-model', expectModel: 'gotry-e2e-model' },
    { name: '③ 不设 LLM_MODEL(干净 DSH_HOME)', expectModel: 'deepseek-v4-flash' },
    { name: '④ 不设 LLM_MODEL + 用户层已选模型', userLayerModel: 'user-picked-model', expectModel: 'user-picked-model' },
  ]
  let fail = 0
  for (const s of scenarios) {
    process.stdout.write(`${s.name} … `)
    const t0 = Date.now()
    const r = await runScenario(s, packageBin)
    console.log(`${r.ok ? 'PASS' : 'FAIL'}(${((Date.now() - t0) / 1000).toFixed(1)}s)${r.detail}`)
    if (!r.ok) fail = 1
  }
  if (fail) { console.error('\nMODEL OVERRIDE E2E FAIL'); process.exit(1) }
  console.log('\nMODEL OVERRIDE E2E OK')
}

await main()
