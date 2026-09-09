/**
 * Fresh-profile, installed-package Web E2E for GoTry artifact cards.
 *
 * The only model endpoint is a local OpenAI-compatible SSE relay. The test
 * starts `gotry web --no-open --port 0`, captures the authenticated `dsh web:`
 * URL, then drives the real composer with a fresh headless Chrome profile.
 * It verifies the public Client cards, path selection, the normal read → edit
 * → gotry_artifacts_read sequence, and the visibly refreshed content/version.
 * Temporary package install, HOME/DSH_HOME, workspace, relay, browser, and
 * server state are cleaned on both success and failure.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promisify } from 'node:util'
import { execFile as execFileCallback } from 'node:child_process'
import puppeteer from 'puppeteer-core'

const execFile = promisify(execFileCallback)
const ROOT = join(import.meta.dirname, '..', '..')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const TIMEOUT_MS = 120_000

type WireBody = { messages?: Array<Record<string, unknown>>; tools?: Array<Record<string, unknown>> }
type Relay = { port: number; bodies: WireBody[]; servedTools: string[]; close: () => Promise<void> }

function sse(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

function toolResponse(id: string, name: string, args: Record<string, unknown>): string {
  return sse({
    id,
    object: 'chat.completion.chunk',
    created: 1,
    model: 'synthetic-artifact-web',
    choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `${id}-call`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }],
  }) + sse({
    id: `${id}-finish`,
    object: 'chat.completion.chunk',
    created: 1,
    model: 'synthetic-artifact-web',
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
  }) + 'data: [DONE]\n\n'
}

function textResponse(id: string, text: string): string {
  return sse({
    id,
    object: 'chat.completion.chunk',
    created: 1,
    model: 'synthetic-artifact-web',
    choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
  }) + sse({
    id: `${id}-finish`,
    object: 'chat.completion.chunk',
    created: 1,
    model: 'synthetic-artifact-web',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  }) + 'data: [DONE]\n\n'
}

function toolNames(body: WireBody): string[] {
  return (body.tools ?? []).map(tool => {
    const fn = tool.function as Record<string, unknown> | undefined
    return String(fn?.name ?? tool.name ?? '')
  }).filter(Boolean)
}

function hasToolMessage(body: WireBody): boolean {
  return (body.messages ?? []).some(message => message.role === 'tool')
}

function lastUserText(body: WireBody): string {
  const message = [...(body.messages ?? [])].reverse().find(item => item.role === 'user')
  const content = message?.content
  if (typeof content === 'string') return content
  return JSON.stringify(content ?? '')
}

async function startRelay(): Promise<Relay> {
  const bodies: WireBody[] = []
  const servedTools: string[] = []
  let phase: 'first-list' | 'first-read' | 'first-final' | 'second-read' | 'second-edit' | 'second-artifact-read' | 'second-final' = 'first-list'
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end('not found')
      return
    }
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      let body: WireBody = {}
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as WireBody } catch { /* dsh will report malformed upstream */ }
      bodies.push(body)
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const names = toolNames(body)
      const hasArtifacts = names.includes('gotry_artifacts_list') || names.includes('gotry_artifacts_read')
      let payload: string
      if (!hasArtifacts) {
        payload = textResponse(`aux-${bodies.length}`, '')
      } else if (phase === 'first-list') {
        phase = 'first-read'
        servedTools.push('gotry_artifacts_list')
        payload = toolResponse('artifact-first-list', 'gotry_artifacts_list', { limit: 20 })
      } else if (phase === 'first-read' && hasToolMessage(body)) {
        phase = 'first-final'
        servedTools.push('gotry_artifacts_read')
        payload = toolResponse('artifact-first-read', 'gotry_artifacts_read', { path: 'trip-2027.md' })
      } else if (phase === 'first-final' && hasToolMessage(body)) {
        phase = 'second-read'
        payload = textResponse('artifact-first-final', '已展示行程产物。')
      } else if (phase === 'second-read' && lastUserText(body).includes('修改')) {
        phase = 'second-edit'
        servedTools.push('read')
        payload = toolResponse('artifact-second-read', 'read', { file_path: 'trip-2027.md' })
      } else if (phase === 'second-edit' && hasToolMessage(body)) {
        phase = 'second-artifact-read'
        servedTools.push('edit')
        payload = toolResponse('artifact-second-edit', 'edit', { file_path: 'trip-2027.md', old_string: 'Day 5: return', new_string: 'Day 5: return\nDay 6: revision requested', replace_all: false })
      } else if (phase === 'second-artifact-read' && hasToolMessage(body)) {
        phase = 'second-final'
        servedTools.push('gotry_artifacts_read')
        payload = toolResponse('artifact-second-artifact-read', 'gotry_artifacts_read', { path: 'trip-2027.md' })
      } else if (phase === 'second-final' && hasToolMessage(body)) {
        payload = textResponse('artifact-second-final', '已更新并重新读取行程产物。')
      } else {
        payload = textResponse(`unexpected-${bodies.length}`, '')
      }
      res.end(payload)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as { port: number }).port,
    bodies,
    servedTools,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

async function run(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<string> {
  const result = await execFile(command, args, { cwd: options.cwd, env: options.env, maxBuffer: 16 * 1024 * 1024 })
  return result.stdout
}

function waitForLine(child: ChildProcessWithoutNullStreams, pattern: RegExp, timeoutMs: number): Promise<{ url: string; output: string }> {
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => { reject(new Error(`timed out waiting for ${pattern}; output=${output.slice(-4000)}`)) }, timeoutMs)
    const onData = (chunk: Buffer) => {
      output += chunk.toString()
      const match = output.match(pattern)
      if (!match) return
      clearTimeout(timer)
      child.stdout.off('data', onData)
      child.stderr.off('data', onData)
      resolve({ url: match[1], output })
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
  })
}

async function main(): Promise<void> {
  assert.ok(existsSync(CHROME), `Chrome missing: ${CHROME}`)
  const outputDir = process.env.GOTRY_ARTIFACT_WEB_E2E_OUT || mkdtempSync(join(tmpdir(), 'gotry-artifact-web-evidence-'))
  mkdirSync(outputDir, { recursive: true })
  const packageDir = mkdtempSync(join(tmpdir(), 'gotry-artifact-web-pack-'))
  const consumerDir = mkdtempSync(join(tmpdir(), 'gotry-artifact-web-consumer-'))
  const workspaceDir = mkdtempSync(join(tmpdir(), 'gotry-artifact-web-workspace-'))
  const homeDir = mkdtempSync(join(tmpdir(), 'gotry-artifact-web-home-'))
  const dshHome = mkdtempSync(join(tmpdir(), 'gotry-artifact-web-dsh-'))
  const userDataDir = mkdtempSync(join(tmpdir(), 'gotry-artifact-web-chrome-'))
  const fixture = '# Trip 2027\n\nDay 1: arrival\nDay 2: city walk\nDay 3: museum\nDay 4: rest\nDay 5: return\n'
  writeFileSync(join(workspaceDir, 'trip-2027.md'), fixture, { mode: 0o600 })
  writeFileSync(join(consumerDir, 'package.json'), JSON.stringify({ private: true, dependencies: {} }, null, 2))
  const relay = await startRelay()
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null
  let page: any = null
  let server: ChildProcessWithoutNullStreams | null = null
  let passed = false
  let serverOutput = ''
  const assertions: Record<string, unknown> = {
    isolation: { home: homeDir, dshHome, workspace: workspaceDir, userDataDir, liveFlags: { GOTRY_SESSION_LIVE: '0', GOTRY_HBCLI_LIVE: '0', GOTRY_HOTELBYTE_SKILLS_LIVE: '0' } },
  }
  try {
    await run(process.execPath, [join(ROOT, 'scripts/build-dist.mjs')], { cwd: ROOT, env: process.env })
    await run('npm', ['pack', '--ignore-scripts', '--pack-destination', packageDir], { cwd: ROOT, env: process.env })
    const tarball = join(packageDir, readdirSync(packageDir).find(name => name.endsWith('.tgz')) || '')
    assert.ok(existsSync(tarball), 'npm pack did not produce a GoTry tarball')
    const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }
    await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], { cwd: consumerDir, env: { ...process.env, HOME: homeDir } })
    const installedRoot = join(consumerDir, 'node_modules', '@danceiny', 'gotry')
    const installedBin = join(installedRoot, 'bin', 'gotry-inner.js')
    assert.ok(existsSync(installedBin), 'packed GoTry binary missing')
    assert.ok(existsSync(join(installedRoot, 'client', 'client.js')), 'packed public client missing')
    assert.equal(JSON.parse(readFileSync(join(installedRoot, 'package.json'), 'utf8')).exports['./client'], './client/client.js')
    assertions.package = { version: packageJson.version, tarball: basename(tarball), installedClient: join(installedRoot, 'client', 'client.js') }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: homeDir,
      DSH_HOME: dshHome,
      GOTRY_ONBOARDING_SKIP: '1',
      GOTRY_SETUP_SKIP: '1',
      GOTRY_SESSION_LIVE: '0',
      GOTRY_HBCLI_LIVE: '0',
      GOTRY_HOTELBYTE_SKILLS_LIVE: '0',
      LLM_API_KEY: 'synthetic-artifact-web-key',
      LLM_BASE_URL: `http://127.0.0.1:${relay.port}/v1`,
      LLM_MODEL: 'synthetic-artifact-web',
    }
    server = spawn(process.execPath, [installedBin, 'web', '--no-open', '--port', '0'], { cwd: workspaceDir, env, stdio: ['ignore', 'pipe', 'pipe'] })
    server.stdout.on('data', chunk => { serverOutput += chunk.toString() })
    server.stderr.on('data', chunk => { serverOutput += chunk.toString() })
    const urlResult = await waitForLine(server, /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s)]+)/, TIMEOUT_MS)
    serverOutput += urlResult.output
    assertions.server = { authenticatedUrlCaptured: true, urlHost: new URL(urlResult.url).host, port: new URL(urlResult.url).port }

    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] })
    page = await browser.newPage()
    page.on('console', (message: any) => { serverOutput += `\n[browser console ${message.type()}] ${message.text()}` })
    page.on('pageerror', (error: Error) => { serverOutput += `\n[browser pageerror] ${error.stack || error.message}` })
    page.setDefaultTimeout(30_000)
    await page.goto(urlResult.url, { waitUntil: 'networkidle2', timeout: 30_000 })
    // A fresh DSH profile may show the product's first-run disclosure before
    // the composer is mounted. Dismiss that visible UI gate through its real
    // button; do not seed cookies or attach an existing browser profile.
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === '继续') as HTMLButtonElement | undefined
      button?.click()
    })
    // Register the isolated fixture through DSH's authenticated public RPC
    // carrier. The browser still selects the resulting workspace through the
    // real workspace picker; no DSH registry file or user profile is seeded.
    const workspaceTitle = basename(workspaceDir)
    const workspaceRpc = await page.evaluate(async (path: string) => {
      const rpcId = crypto.randomUUID()
      const response = await fetch(`/api/workspace/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId,
          method: 'workspace/create',
          payload: { args: { request: { path } } },
        }),
      })
      return { status: response.status, body: await response.text() }
    }, workspaceDir)
    assert.equal(workspaceRpc.status, 200, `workspace RPC failed: ${workspaceRpc.status} ${workspaceRpc.body}`)
    const workspaceResult = JSON.parse(workspaceRpc.body) as { result?: { ok?: boolean; value?: { workspace?: { title?: string } } } }
    assert.equal(workspaceResult.result?.ok, true, `workspace RPC rejected: ${workspaceRpc.body}`)
    assertions.workspace = { rpc: 'workspace/create', title: workspaceResult.result?.value?.workspace?.title || workspaceTitle }
    // Reconnect the public workspace feed so the browser observes the
    // host-authoritative registration through its normal baseline path.
    await page.reload({ waitUntil: 'networkidle2', timeout: 30_000 })
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === '继续') as HTMLButtonElement | undefined
      button?.click()
    })
    await page.waitForFunction((title: string) => document.body.innerText.includes(title), { timeout: 30_000 }, workspaceTitle)
    await page.click('button[aria-label="选择工作区"], button[aria-label="Select workspace"]')
    await page.waitForFunction((title: string) => [...document.querySelectorAll('[role="menuitem"], [role="option"], button')].some(node => node.textContent?.trim() === title), { timeout: 30_000 }, workspaceTitle)
    await page.evaluate((title: string) => {
      const node = [...document.querySelectorAll('[role="menuitem"], [role="option"], button')].find(candidate => candidate.textContent?.trim() === title) as HTMLElement | undefined
      node?.click()
    }, workspaceTitle)
    await page.waitForSelector('[contenteditable="true"]')
    const submit = async (text: string) => {
      const editor = await page.$('[contenteditable="true"]')
      assert.ok(editor, 'real composer missing')
      await editor.click()
      await page.keyboard.type(text)
      const button = await page.$('button[aria-label="发送消息"], button[aria-label="Send message"]')
      assert.ok(button, 'real composer submit button missing')
      await button.click()
    }

    await submit('请列出并打开刚才生成的 trip-2027.md 行程产物。')
    const revealArtifactCalls = async () => {
      await page.evaluate(() => {
        for (const process of document.querySelectorAll('[data-turn-process]')) {
          if (process.getAttribute('aria-expanded') !== 'true') (process as HTMLElement).click()
        }
      })
    }
    await page.waitForFunction(() => document.querySelector('[data-turn-process="1"]') !== null, { timeout: 60_000 })
    await revealArtifactCalls()
    await page.waitForSelector('[data-gotry-artifact-card="list"]')
    await page.waitForSelector('[data-gotry-artifact-card="list"][data-gotry-artifact-state="ok"]')
    await page.waitForSelector('[data-gotry-artifact-card="read"] [data-gotry-artifact-line="1"]')
    assert.equal(await page.$eval('[data-gotry-artifact-card="list"]', (node: Element) => {
      const rect = node.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    }), true, 'artifact list card is not visibly rendered')
    assert.equal(await page.$eval('[data-gotry-artifact-card="read"]', (node: Element) => {
      const rect = node.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    }), true, 'artifact read card is not visibly rendered')
    const pathButton = await page.$('[data-gotry-artifact-path$="trip-2027.md"]')
    assert.ok(pathButton, 'list card path button missing')
    await pathButton.click()
    await page.waitForSelector('[data-gotry-artifact-selection$="trip-2027.md"]')
    const firstSnapshot = await page.evaluate(() => ({
      listCards: document.querySelectorAll('[data-gotry-artifact-card="list"]').length,
      readCards: document.querySelectorAll('[data-gotry-artifact-card="read"]').length,
      paths: [...document.querySelectorAll('[data-gotry-artifact-path]')].map(node => node.textContent),
      selected: document.querySelector('[data-gotry-artifact-selection]')?.textContent || null,
      identity: document.querySelector('[data-gotry-artifact-identity]')?.textContent || null,
      line1: document.querySelector('[data-gotry-artifact-line="1"]')?.textContent || null,
    }))
    assert.equal(firstSnapshot.listCards, 1)
    assert.ok(firstSnapshot.readCards >= 1)
    assert.ok(firstSnapshot.paths.some(path => path?.endsWith('trip-2027.md')))
    assert.ok(firstSnapshot.selected?.endsWith('trip-2027.md'))
    assert.match(firstSnapshot.identity || '', /来源|source/)
    assertions.firstTurn = firstSnapshot

    await submit('请修改刚才的行程产物，在末尾追加 Day 6，然后重新读取并展示更新版本。')
    await page.waitForFunction(() => document.querySelector('[data-turn-process="2"]') !== null, { timeout: 60_000 })
    await revealArtifactCalls()
    await page.waitForFunction(() => document.querySelectorAll('[data-gotry-artifact-card="read"]').length >= 2, { timeout: 60_000 })
    await page.waitForFunction(() => [...document.querySelectorAll('[data-gotry-artifact-card="read"]')].some(node => node.textContent?.includes('Day 6: revision requested')), { timeout: 60_000 })
    // DSH may collapse a completed turn after the last tool result arrives;
    // reopen the real process disclosure and place the revised card in view so
    // the receipt proves visible, not merely hidden-DOM, refreshed evidence.
    await revealArtifactCalls()
    await page.evaluate(() => {
      const cards = document.querySelectorAll('[data-gotry-artifact-card="read"]')
      cards[cards.length - 1]?.scrollIntoView({ block: 'center' })
    })
    assert.equal(await page.$eval('[data-gotry-artifact-card="read"]:last-of-type', (node: Element) => {
      const rect = node.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    }), true, 'updated artifact read card is not visibly rendered')
    const finalSnapshot = await page.evaluate(() => ({
      readCards: document.querySelectorAll('[data-gotry-artifact-card="read"]').length,
      updated: [...document.querySelectorAll('[data-gotry-artifact-card="read"]')].some(node => node.textContent?.includes('Day 6: revision requested')),
      versions: [...document.querySelectorAll('[data-gotry-artifact-version]')].map(node => node.getAttribute('data-gotry-artifact-version')),
      identities: [...document.querySelectorAll('[data-gotry-artifact-identity]')].map(node => node.textContent),
      updatedLine: [...document.querySelectorAll('[data-gotry-artifact-line]')].find(node => node.textContent?.includes('Day 6'))?.textContent || null,
    }))
    assert.ok(finalSnapshot.readCards >= 2)
    assert.equal(finalSnapshot.updated, true)
    assert.ok(finalSnapshot.versions.filter(Boolean).length >= 2)
    assert.ok(finalSnapshot.updatedLine?.includes('Day 6'))
    assertions.secondTurn = finalSnapshot
    assert.deepEqual(relay.servedTools, ['gotry_artifacts_list', 'gotry_artifacts_read', 'read', 'edit', 'gotry_artifacts_read'])
    assertions.relay = { toolCalls: relay.servedTools, bodyCount: relay.bodies.length }
    const screenshotPath = join(outputDir, 'artifact-web-e2e.png')
    await page.screenshot({ path: screenshotPath, fullPage: true })
    const domPath = join(outputDir, 'artifact-web-e2e.dom.json')
    writeFileSync(domPath, JSON.stringify(assertions, null, 2) + '\n', { mode: 0o600 })
    const screenshotSha256 = createHash('sha256').update(readFileSync(screenshotPath)).digest('hex')
    const domSha256 = createHash('sha256').update(readFileSync(domPath)).digest('hex')
    const receipt = { screenshot: { path: screenshotPath, sha256: screenshotSha256 }, domAssertions: { path: domPath, sha256: domSha256 }, serverOutputSha256: createHash('sha256').update(serverOutput).digest('hex') }
    writeFileSync(join(outputDir, 'artifact-web-e2e.receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
    passed = true
    console.log(`DSH ARTIFACT WEB E2E: PASS fresh Chrome profile, list→select/open→preview→read→edit→updated read; screenshot=${screenshotPath}; screenshotSha256=${screenshotSha256}; dom=${domPath}; domSha256=${domSha256}`)
  } finally {
    if (page && !passed) {
      try {
        const failureHtml = join(outputDir, 'artifact-web-e2e.failure.html')
        const failurePng = join(outputDir, 'artifact-web-e2e.failure.png')
        writeFileSync(failureHtml, await page.content(), { mode: 0o600 })
        await page.screenshot({ path: failurePng, fullPage: true })
        writeFileSync(join(outputDir, 'artifact-web-e2e.failure.log'), serverOutput, { mode: 0o600 })
        console.error(`DSH ARTIFACT WEB E2E failure artifacts: html=${failureHtml}; screenshot=${failurePng}; log=${join(outputDir, 'artifact-web-e2e.failure.log')}`)
      } catch { /* browser may have failed before a document existed */ }
    }
    await browser?.close().catch(() => {})
    if (server && !server.killed) {
      server.kill('SIGTERM')
      await new Promise<void>(resolve => { server?.once('close', () => resolve()); setTimeout(resolve, 2_000) })
    }
    await relay.close().catch(() => {})
    for (const directory of [packageDir, consumerDir, workspaceDir, homeDir, dshHome, userDataDir]) {
      rmSync(directory, { recursive: true, force: true })
    }
  }
}

await main()
