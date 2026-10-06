/** Isolated DSH Web handoff journey. Synthetic model/planner; real host, jobs,
 * processes, composer, completion notice, presentation and artifact tools.
 * Never a live travel-research or published-package acceptance receipt. */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import puppeteer from 'puppeteer-core'

const ROOT = join(import.meta.dirname, '..', '..')
const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
const sourceDirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim() !== ''
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const evidence = process.env.GOTRY_HANDOFF_WEB_E2E_OUT ?? mkdtempSync(join(tmpdir(), 'gotry-handoff-web-evidence-'))
const isolated = mkdtempSync(join(tmpdir(), 'gotry-handoff-web-'))
const product = join(isolated, 'product')
const hostCwd = join(isolated, 'host')
const workspace = join(isolated, 'workspace')
const stateRoot = join(isolated, 'handoff-state')
const home = join(isolated, 'home')
const dshHome = join(isolated, 'dsh')
for (const dir of [evidence, product, hostCwd, workspace, stateRoot, home, dshHome]) mkdirSync(dir, { recursive: true })
const planner = join(isolated, 'planner.mjs')
writeFileSync(planner, `console.error('DIAGNOSTIC_NOT_A_PLAN');setTimeout(()=>console.log('# Completed synthetic plan\\nWorkspace: '+process.cwd()+'\\n'+process.argv[2]),15000)`)
const bodies: any[] = []
const served: string[] = []
let phase = 0
let serverLog = ''
let notified = false
let relayError: string | undefined
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined
let page: any
let child: ReturnType<typeof spawn> | undefined
const pageErrors: string[] = []

const sse = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`
function response(name?: string, input: Record<string, unknown> = {}, text = '') {
  const block = name ? { type: 'tool_use', id: `handoff-${phase}`, name, input } : { type: 'text', text }
  return sse({ type: 'message_start', message: { usage: { input_tokens: 10 } } })
    + sse({ type: 'content_block_start', index: 0, content_block: block })
    + sse({ type: 'content_block_stop', index: 0 })
    + sse({ type: 'message_delta', delta: { stop_reason: name ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 10 } })
    + sse({ type: 'message_stop' }) + 'data: [DONE]\n\n'
}
const ticketDir = join(stateRoot, 'gotry-state', 'turn-handoffs')
function ticket() {
  const names = existsSync(ticketDir) ? readdirSync(ticketDir).filter(name => name.endsWith('.json')) : []
  assert.equal(names.length, 1, 'one durable ticket')
  return JSON.parse(readFileSync(join(ticketDir, names[0]), 'utf8'))
}
const relay = createServer((req, res) => {
  if (req.method !== 'POST' || !req.url?.endsWith('/messages')) { res.writeHead(404).end(); return }
  const chunks: Buffer[] = []
  req.on('data', chunk => chunks.push(Buffer.from(chunk)))
  req.on('end', () => {
    try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    bodies.push(body)
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const names = (body.tools ?? []).map((tool: any) => tool.name ?? tool.function?.name)
    const messages = JSON.stringify(body.messages ?? [])
    const isPlanner = names.includes('write') || names.includes('present') || names.includes('job_output')
    if (!isPlanner) { res.end(response(undefined, {}, 'Synthetic title')); return }
    let name: string | undefined
    let input: Record<string, unknown> = {}
    let final = ''
    let delay = 0
    if (phase === 0) {
      name = 'write'; input = { file_path: 'exploration.md', content: '# Synthetic exploration\nWork hours 9-18 CST; original request retained.' }
      // Cross the foreground deadline deliberately, while giving the later
      // completion/query turn enough time for several native tool round trips.
      delay = 5500
    } else if (phase === 1) {
      name = 'present'; input = { files: [{ path: join(workspace, 'exploration.md'), description: '探索稿' }] }
    } else if (phase === 2) {
      final = '探索稿已保存，后台任务已启动。'
    } else if (phase === 3) {
      assert.match(messages, /finished.*completed/, 'native completion notice wakes the owning session')
      notified = true
      name = 'job_output'; input = { job_id: ticket().jobId, wait: false }
    } else if (phase === 4) {
      assert.ok(messages.includes('Planning completed:'), 'native job result reaches the model')
      name = 'present'; input = { files: [{ path: join(ticketDir, ticket().deliverableFile), description: '最终交付物' }] }
    } else if (phase === 5) {
      name = 'gotry_artifacts_list'; input = { limit: 20 }
    } else if (phase === 6) {
      assert.ok(messages.includes(ticket().id), 'artifact list includes the same ticket')
      name = 'gotry_artifacts_read'; input = { path: ticket().id }
    } else {
      final = '最终规划已完成并展示，可按工单重新读取。'
    }
    if (name) {
      assert.ok(names.includes(name), `${name} remains available in phase ${phase}: ${names}`)
      served.push(name)
    }
    phase++
    setTimeout(() => res.end(response(name, input, final)), delay)
    } catch (error) {
      relayError = String(error)
      res.end(response(undefined, {}, 'RELAY_TEST_FAILURE'))
    }
  })
})

try {
  assert.ok(existsSync(CHROME), 'Chrome is required for the browser receipt')
  assert.ok(existsSync(join(ROOT, 'dist/src/turn-handoff-job.js')), 'build dist before the browser journey')
  // The real source launcher normally uses ts/dsh-runtime as host cwd. Run the
  // exact built package in a private layout instead, so even legacy state reads
  // and process-guard logs cannot touch the founder's runtime directory.
  const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', isolated], { cwd: ROOT, encoding: 'utf8' }))[0]
  execFileSync('tar', ['xzf', join(isolated, packed.filename), '--strip-components=1', '-C', product])
  symlinkSync(join(ROOT, 'node_modules'), join(product, 'node_modules'), 'dir')
  await new Promise<void>(resolve => relay.listen(0, '127.0.0.1', resolve))
  const port = (relay.address() as { port: number }).port
  child = spawn(process.execPath, [join(product, 'bin/gotry-inner.js'), 'web', '--no-open', '--port', '0'], {
    cwd: hostCwd,
    env: { ...process.env, HOME: home, DSH_HOME: dshHome, GOTRY_SETUP_SKIP: '1', GOTRY_ONBOARDING_SKIP: '1',
      GOTRY_SESSION_LIVE: '0', GOTRY_HBCLI_LIVE: '0', GOTRY_HOTELBYTE_SKILLS_LIVE: '0',
      LLM_API_KEY: 'synthetic-only', LLM_BASE_URL: `http://127.0.0.1:${port}/v1`, LLM_MODEL: 'synthetic-handoff-web',
      GOTRY_LLM_MODEL: 'synthetic-handoff-web', DEEPSEEK_API_KEY: 'synthetic-only', DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}/v1`,
      GOTRY_TURN_HANDOFF_ROOT: stateRoot, GOTRY_HANDOFF_PLANNER_BIN: planner,
      GOTRY_TURN_DEADLINE_SOFT_MS: '2000', GOTRY_TURN_DEADLINE_HARD_MS: '5000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Web startup timed out: ${serverLog.slice(-4000)}`)), 30000)
    const collect = (chunk: Buffer) => {
      serverLog += chunk.toString()
      const match = serverLog.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s)]+)/)
      if (match) { clearTimeout(timer); resolve(match[1]) }
    }
    child!.stdout!.on('data', collect); child!.stderr!.on('data', collect)
    child!.once('error', reject)
  })
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: join(isolated, 'chrome'), args: ['--no-sandbox', '--disable-gpu'] })
  page = await browser.newPage()
  page.setDefaultTimeout(30000)
  page.on('pageerror', (error: Error) => pageErrors.push(error.message))
  await page.goto(url, { waitUntil: 'networkidle2' })
  const dismiss = async () => {
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(node => ['继续', 'Continue'].includes(node.textContent?.trim() ?? '')))
    await page.evaluate(() => ([...document.querySelectorAll('button')].find(node => ['继续', 'Continue'].includes(node.textContent?.trim() ?? '')) as HTMLButtonElement)?.click())
  }
  await dismiss()
  const registered = await page.evaluate(async (path: string) => {
    const response = await fetch('/api/workspace/create', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'workspace/create', payload: { args: { request: { path } } } }) })
    return response.json()
  }, workspace)
  assert.equal(registered.result?.ok, true, 'register the isolated workspace through public RPC')
  await page.reload({ waitUntil: 'networkidle2' })
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(node => /Default workspace|默认工作区/.test(node.textContent ?? '')))
  await page.evaluate(() => ([...document.querySelectorAll('button')].find(node => /Default workspace|默认工作区/.test(node.textContent ?? '')) as HTMLButtonElement)?.click())
  await page.waitForFunction((title: string) => [...document.querySelectorAll('[role="menuitem"], [role="option"], button')].some(node => node.textContent?.trim() === title), {}, basename(workspace))
  await page.evaluate((title: string) => ([...document.querySelectorAll('[role="menuitem"], [role="option"], button')].find(node => node.textContent?.trim() === title) as HTMLElement)?.click(), basename(workspace))
  await page.waitForSelector('[contenteditable="true"]')
  await page.click('[contenteditable="true"]')
  await page.keyboard.type('12月初阿联酋国庆，借5天IRW远程办公和请假回国十几天，去东北长春泡澡，女朋友从南京过去，请探索具体规划。工作时间9-18 CST。')
  await page.click('button[aria-label="发送消息"], button[aria-label="Send message"]')
  await page.waitForFunction(() => /探索稿已保存|RELAY_TEST_FAILURE/.test(document.body.innerText), { timeout: 30000 })
  assert.equal(relayError, undefined)
  assert.ok(existsSync(join(workspace, 'exploration.md')), 'deadline draft really exists in the original workspace')
  const running = ticket()
  assert.equal(running.status, 'running')
  assert.ok(running.jobId)
  await page.screenshot({ path: join(evidence, 'running.png'), fullPage: true })
  await page.waitForFunction(() => /最终规划已完成并展示|RELAY_TEST_FAILURE/.test(document.body.innerText), { timeout: 60000 })
  assert.equal(relayError, undefined)
  const settled = ticket()
  assert.equal(settled.status, 'settled')
  const outputPath = join(ticketDir, settled.deliverableFile)
  const output = readFileSync(outputPath, 'utf8')
  assert.ok(output.includes('Completed synthetic plan') && output.includes(workspace))
  assert.ok(output.includes('9-18 CST'), 'prior constraints travel to the worker')
  assert.ok(!output.includes('DIAGNOSTIC_NOT_A_PLAN'))
  assert.ok(notified)
  assert.deepEqual(pageErrors, [])
  const fileCards = await page.evaluate(() => [...document.querySelectorAll('button')].map(node => ({ text: node.textContent, label: node.getAttribute('aria-label'), title: node.getAttribute('title') })))
  const openLabel = await page.evaluate((path: string) => {
    const button = [...document.querySelectorAll('button')].find(node => [node.getAttribute('title'), node.getAttribute('aria-label'), node.textContent].some(text => text?.includes(path) || text?.includes(path.split('/').at(-1)!)))
    if (!button) return false
    button.click(); return true
  }, outputPath)
  assert.ok(openLabel, `native file card must offer the final output: ${JSON.stringify(fileCards).slice(-4000)}`)
  await page.waitForFunction(() => document.body.innerText.includes('Completed synthetic plan'), { timeout: 30000 })
  await page.screenshot({ path: join(evidence, 'completed-preview.png'), fullPage: true })
  writeFileSync(join(evidence, 'receipt.json'), JSON.stringify({ passed: true, evidence: 'synthetic_fixture',
    runtime: 'source-built DSH Web', layout: 'isolated tarball with repository dependencies', sourceSha, sourceDirty, nodeVersion: process.version, served, notified, ticketId: settled.id, jobId: settled.jobId,
    draftWritten: true, finalPresented: true, previewOpened: true, status: settled.status, pageErrors }, null, 2))
  console.log(`handoff web E2E: OK; synthetic receipt: ${evidence}`)
} catch (error) {
  if (page) { await page.screenshot({ path: join(evidence, 'failure.png'), fullPage: true }).catch(() => {}); writeFileSync(join(evidence, 'failure-dom.txt'), await page.evaluate(() => document.body.innerText + '\n' + JSON.stringify([...document.querySelectorAll('button')].map(node => ({ text: node.textContent, label: node.getAttribute('aria-label'), title: node.getAttribute('title') })))).catch(() => '')) }
  writeFileSync(join(evidence, 'failure.json'), JSON.stringify({ error: String(error), phase, served, pageErrors,
    serverLog: serverLog.replace(/token=[^\s)]+/g, 'token=[redacted]').slice(-5000) }, null, 2))
  writeFileSync(join(evidence, 'requests.json'), JSON.stringify(bodies, null, 2))
  throw error
} finally {
  await browser?.close()
  if (child && child.exitCode === null) {
    const closed = new Promise<void>(resolve => child!.once('close', () => resolve()))
    child.kill('SIGTERM')
    const timer = setTimeout(() => child!.kill('SIGKILL'), 5000)
    await closed; clearTimeout(timer)
  }
  await new Promise<void>(resolve => relay.close(() => resolve()))
  rmSync(isolated, { recursive: true, force: true })
}
