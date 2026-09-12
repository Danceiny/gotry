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
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { Readable } from 'node:stream'
import { promisify } from 'node:util'
import { execFile as execFileCallback } from 'node:child_process'
import puppeteer from 'puppeteer-core'

const execFile = promisify(execFileCallback)
const ROOT = join(import.meta.dirname, '..', '..')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const TIMEOUT_MS = 120_000

type WireBody = { messages?: Array<Record<string, unknown>>; tools?: Array<Record<string, unknown>> }
type Relay = { port: number; bodies: WireBody[]; servedTools: string[]; close: () => Promise<void> }
type WebServerProcess = ChildProcessByStdio<null, Readable, Readable>

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
  let phase: 'first-list' | 'first-read' | 'first-final' | 'second-read' | 'second-edit' | 'second-artifact-read' | 'second-final' | 'third-list' | 'third-read' | 'third-final' = 'first-list'
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
        phase = 'third-list'
        payload = textResponse('artifact-second-final', '已更新并重新读取行程产物。')
      } else if (phase === 'third-list' && lastUserText(body).includes('HTML')) {
        phase = 'third-read'
        servedTools.push('gotry_artifacts_list')
        payload = toolResponse('artifact-third-list', 'gotry_artifacts_list', { limit: 20 })
      } else if (phase === 'third-read' && hasToolMessage(body)) {
        phase = 'third-final'
        servedTools.push('gotry_artifacts_read')
        payload = toolResponse('artifact-third-read', 'gotry_artifacts_read', { path: 'trip-2027.html' })
      } else if (phase === 'third-final' && hasToolMessage(body)) {
        payload = textResponse('artifact-third-final', '已读取 HTML 产物，请使用列表中的「Open HTML preview」按钮验证原生预览。')
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

function waitForLine(child: WebServerProcess, pattern: RegExp, timeoutMs: number): Promise<{ url: string; output: string }> {
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
  const htmlSentinel = 'gotry-artifact-web-html-sentinel-must-not-run-in-host'
  const htmlFixture = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>GoTry artifact-web HTML</title>
</head>
<body>
<h1 id="artifact-web-h1">GoTry artifact-web visible heading</h1>
<p id="artifact-web-p">GoTry artifact-web visible body line — synthetic only.</p>
<script>
window.__artifact_web_host_executed__ = true;
document.documentElement.setAttribute('data-${htmlSentinel}', 'host-ran-it');
</script>
</body>
</html>
`
  writeFileSync(join(workspaceDir, 'trip-2027.html'), htmlFixture, { mode: 0o600 })
  writeFileSync(join(consumerDir, 'package.json'), JSON.stringify({ private: true, dependencies: {} }, null, 2))
  const relay = await startRelay()
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null
  let page: any = null
  let server: WebServerProcess | null = null
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
    const child = spawn(process.execPath, [installedBin, 'web', '--no-open', '--port', '0'], { cwd: workspaceDir, env, stdio: ['ignore', 'pipe', 'pipe'] })
    server = child
    child.stdout.on('data', chunk => { serverOutput += chunk.toString() })
    child.stderr.on('data', chunk => { serverOutput += chunk.toString() })
    const urlResult = await waitForLine(child, /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s)]+)/, TIMEOUT_MS)
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
    assert.ok(firstSnapshot.paths.some((path: string | null) => path?.endsWith('trip-2027.md')))
    assert.ok(firstSnapshot.selected?.endsWith('trip-2027.md'))
    assert.match(firstSnapshot.identity || '', /来源|source/)
    assertions.firstTurn = firstSnapshot

    await submit('请修改刚才的行程产物，在末尾追加 Day 6，然后重新读取并展示更新版本。')
    await page.waitForFunction(() => document.querySelector('[data-turn-process="2"]') !== null, { timeout: 60_000 })
    await revealArtifactCalls()
    await page.waitForFunction(() => document.querySelectorAll('[data-gotry-artifact-card="read"]').length >= 2, { timeout: 60_000 })
    await page.waitForFunction(() => [...document.querySelectorAll('[data-gotry-artifact-card="read"]')].some(node => node.textContent?.includes('Day 6: revision requested')), { timeout: 60_000 })
    // The artifact card has the fresh read result, but the public DSH file
    // preview intentionally keeps its old page until the user acknowledges
    // the changed-file banner. Exercise that visible reload control instead
    // of treating the custom card or hidden DOM as sidebar evidence.
    await page.waitForSelector('[data-textpreview-changed]', { timeout: 60_000 })
    const staleRightPreview = await page.$eval('[data-textpreview-state="text"]', (node: Element) => {
      const rect = node.getBoundingClientRect()
      const body = node.querySelector('[data-textpreview-body]')
      return {
        visible: rect.width > 0 && rect.height > 0,
        changedBanner: Boolean(node.querySelector('[data-textpreview-changed]')),
        includesDay6: body?.textContent?.includes('Day 6: revision requested') || false,
      }
    })
    assert.equal(staleRightPreview.visible, true, 'right file preview is not visibly rendered before reload')
    assert.equal(staleRightPreview.changedBanner, true, 'right file preview did not show the changed-file banner')
    assert.equal(staleRightPreview.includesDay6, false, 'right file preview unexpectedly contained Day 6 before reload')
    const reloadButton = await page.$('[data-textpreview-changed] [data-textpreview-reload-now]')
    assert.ok(reloadButton, 'right file preview reload control missing')
    const reloadControl = await page.$eval('[data-textpreview-changed] [data-textpreview-reload-now]', (node: Element) => {
      const rect = node.getBoundingClientRect()
      return {
        visible: rect.width > 0 && rect.height > 0,
        text: node.textContent?.trim() || '',
        ariaLabel: node.getAttribute('aria-label'),
      }
    })
    assert.equal(reloadControl.visible, true, 'right file preview reload control is not visible')
    assert.match(reloadControl.text, /重新载入|Reload/)
    await reloadButton.click()
    await page.waitForFunction(() => {
      const preview = document.querySelector('[data-textpreview-state="text"]')
      const body = preview?.querySelector('[data-textpreview-body]')
      return Boolean(preview && body?.textContent?.includes('Day 6: revision requested'))
    }, { timeout: 60_000 })
    await page.$eval('[data-textpreview-body]', (node: Element) => {
      const body = node as HTMLElement
      body.scrollTop = body.scrollHeight
    })
    // The right preview pane may sit below the chat fold on a 600-tall
    // viewport; ensure the pane itself is in view, then re-scroll its body so
    // the Day 6 line settles inside the pane's visible area before measuring.
    await page.$eval('[data-textpreview-state="text"]', (node: Element) => { (node as HTMLElement).scrollIntoView({ block: 'end' }) })
    await page.$eval('[data-textpreview-body]', (node: Element) => {
      const body = node as HTMLElement
      body.scrollTop = body.scrollHeight
    })
    const rightPreviewAfterReload = await page.$eval('[data-textpreview-state="text"]', (node: Element) => {
      const rect = node.getBoundingClientRect()
      const body = node.querySelector('[data-textpreview-body]') as HTMLElement | null
      // The preview body may render Day 6 as a Markdown paragraph rather than
      // discrete line elements (data-textpreview-line is not always present in
      // the current rendered DOM); find the smallest descendant whose
      // textContent includes the Day 6 marker so visibility is checked against
      // the actual rendered node, preserving the "Day 6 visible after reload"
      // semantic.
      const all = Array.from(node.querySelectorAll('*')) as Element[]
      let day6: Element | null = null
      let bestLen = Number.POSITIVE_INFINITY
      for (let i = 0; i < all.length; i++) {
        const candidate = all[i]!
        const text = candidate.textContent || ''
        if (!text.includes('Day 6: revision requested')) continue
        if (text.length > bestLen) continue
        bestLen = text.length
        day6 = candidate
      }
      const day6Rect = day6 ? day6.getBoundingClientRect() : null
      const day6Visible = Boolean(day6Rect && day6Rect.width > 0 && day6Rect.height > 0
        && day6Rect.bottom > 0 && day6Rect.top < window.innerHeight
        && day6Rect.bottom <= rect.bottom + 1 && day6Rect.top >= rect.top - 1)
      return {
        visible: rect.width > 0 && rect.height > 0,
        changedBanner: Boolean(node.querySelector('[data-textpreview-changed]')),
        bodyIncludesDay6: body?.textContent?.includes('Day 6: revision requested') || false,
        day6Visible,
        day6Rect: day6Rect ? { top: day6Rect.top, bottom: day6Rect.bottom, height: day6Rect.height, width: day6Rect.width } : null,
        day6Tag: day6 ? day6.tagName : null,
        paneRect: { top: rect.top, bottom: rect.bottom, height: rect.height },
        bodyText: body?.textContent || '',
      }
    })
    assert.equal(rightPreviewAfterReload.visible, true, 'right file preview is not visibly rendered after reload')
    assert.equal(rightPreviewAfterReload.changedBanner, false, 'right file preview still shows the changed-file banner after reload')
    assert.equal(rightPreviewAfterReload.bodyIncludesDay6, true, 'right file preview body does not contain Day 6 after reload')
    assert.equal(rightPreviewAfterReload.day6Visible, true, `right file preview Day 6 is not visible after reload (day6Rect=${JSON.stringify(rightPreviewAfterReload.day6Rect)}; paneRect=${JSON.stringify(rightPreviewAfterReload.paneRect)}; day6Tag=${rightPreviewAfterReload.day6Tag})`)
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
    assertions.secondTurn = { ...finalSnapshot, rightPreview: rightPreviewAfterReload, reloadControl }

    // ─── Third turn — native HTML preview via real registered gotry_artifacts_list/read
    // and the public Client's [data-gotry-artifact-open="html-preview"] button,
    // which dispatches the installed host's native openFile path. The slide-in
    // animation finishes after the iframe mounts; wait for the iframe to be
    // fully inside the actual 1440x1000 viewport (1px rounding tolerance)
    // before reading bounding boxes, so visible-ness is asserted in viewport
    // terms, not against hidden/animating geometry.
    await submit('请用 gotry_artifacts_list 列出当前工作区里 HTML 产物，然后用 gotry_artifacts_read 读取 trip-2027.html 的源码展示给用户。')
    await page.waitForFunction(() => document.querySelector('[data-turn-process="3"]') !== null, { timeout: 60_000 })
    await revealArtifactCalls()
    await page.waitForFunction(() => [...document.querySelectorAll('[data-gotry-artifact-card="read"]')].some(node => node.getAttribute('data-gotry-artifact-source') === 'html'), { timeout: 60_000 })

    const htmlSourceSnapshot = await page.evaluate((sentinel: string) => {
      const card = document.querySelector('[data-gotry-artifact-card="read"][data-gotry-artifact-source="html"]')
      const lines = [...(card?.querySelectorAll('[data-gotry-artifact-line]') ?? [])].map(node => node.textContent || '')
      const concatenated = lines.join('\n')
      const hostScriptMarker = (window as unknown as Record<string, unknown>)['__artifact_web_host_executed__']
      const hostDataMarker = document.documentElement.getAttribute(`data-${sentinel}`)
      const inertTextOnly = Boolean(card) && card!.querySelector('script') === null && card!.querySelector('iframe') === null
      return {
        lineCount: lines.length,
        concatenatedIncludesDoctype: concatenated.includes('<!doctype html>'),
        concatenatedIncludesScriptTag: concatenated.includes('<script>'),
        concatenatedIncludesH1: concatenated.includes('GoTry artifact-web visible heading'),
        hostScriptMarker: hostScriptMarker ?? null,
        hostDataMarker: hostDataMarker ?? null,
        inertTextOnly,
      }
    }, htmlSentinel)
    assert.equal(htmlSourceSnapshot.inertTextOnly, true, 'HTML read card is not inert text')
    assert.equal(htmlSourceSnapshot.concatenatedIncludesDoctype, true, 'HTML read card missing <!doctype html> in text')
    assert.equal(htmlSourceSnapshot.concatenatedIncludesScriptTag, true, 'HTML read card missing <script> as text')
    assert.equal(htmlSourceSnapshot.hostScriptMarker, null, 'host executed the source-text script sentinel')
    assert.equal(htmlSourceSnapshot.hostDataMarker, null, 'host set sentinel data attribute from source text')

    const htmlPathButton = await page.evaluateHandle((canonical: string) => {
      // Bind to the LATEST list card so the click lands on the third turn's
      // HTML list, not the first turn's collapsed list card that already
      // mentions the same canonical filename. Document-order last list wins.
      const lists = Array.from(document.querySelectorAll('[data-gotry-artifact-card="list"]')) as HTMLElement[]
      const latest = lists[lists.length - 1]
      if (!latest) return null
      const candidate = latest.querySelector(`[data-gotry-artifact-open="html-preview"][aria-label*="${canonical}"]`) as HTMLElement | null
      return candidate
    }, 'trip-2027.html')
    assert.ok(htmlPathButton, 'real html-preview button for canonical trip-2027.html missing from latest list card')
    const htmlButtonSnapshot = await (htmlPathButton as any).evaluate((node: Element) => ({
      ariaLabel: node.getAttribute('aria-label') || '',
      visible: node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0,
      listIndex: [...document.querySelectorAll('[data-gotry-artifact-card="list"]')].indexOf(node.closest('[data-gotry-artifact-card="list"]')!),
    }))
    assert.ok(htmlButtonSnapshot.ariaLabel.includes('trip-2027.html'), `unexpected html-preview aria-label: ${htmlButtonSnapshot.ariaLabel}`)
    assert.equal(htmlButtonSnapshot.visible, true, 'html-preview button not visibly rendered')
    assert.ok(htmlButtonSnapshot.listIndex >= 1, `html-preview button must bind to a non-first list card (got index ${htmlButtonSnapshot.listIndex})`)

    // Switch to the bounded 1440x1000 viewport only for the HTML native preview
    // so the slide-in animation can settle to a deterministic in-viewport frame.
    await page.setViewport({ width: 1440, height: 1000 })

    const iframesBefore = await page.evaluate(() => [...document.querySelectorAll('iframe')].map(f => ({ src: f.getAttribute('src') || '', sandbox: f.getAttribute('sandbox') || '' })))
    await (htmlPathButton as any).click()
    const blobFrame = await page.waitForFrame((f: import('puppeteer-core').Frame) => f.url().startsWith('blob:'), { timeout: 30_000 })
    assert.ok(blobFrame, 'no blob: iframe appeared after clicking real Open HTML preview')
    await blobFrame.waitForSelector('#artifact-web-h1', { visible: true, timeout: 30_000 })
    await page.waitForFunction(() => {
      const node = document.querySelector('iframe[src^="blob:"]') as HTMLIFrameElement | null
      if (!node) return false
      const r = node.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && r.x >= 0 && r.y >= 0 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1
    }, { timeout: 30_000 })
    const iframeSnapshot = await page.evaluate(() => {
      const node = document.querySelector('iframe[src^="blob:"]') as HTMLIFrameElement | null
      if (!node) return null
      const r = node.getBoundingClientRect()
      return {
        src: node.getAttribute('src') || '',
        sandbox: node.getAttribute('sandbox') || '',
        width: r.width, height: r.height, x: r.x, y: r.y,
        title: node.getAttribute('title') || '',
      }
    })
    assert.ok(iframeSnapshot, 'blob iframe DOM element missing')
    assert.ok(iframeSnapshot!.src.startsWith('blob:'), `iframe src is not blob: ${iframeSnapshot!.src}`)
    assert.equal(iframeSnapshot!.sandbox, 'allow-scripts', `iframe sandbox must be exactly allow-scripts: ${iframeSnapshot!.sandbox}`)
    const vp = page.viewport()
    assert.ok(iframeSnapshot!.width > 0 && iframeSnapshot!.height > 0, 'iframe has zero size')
    assert.ok(iframeSnapshot!.x + iframeSnapshot!.width <= vp!.width + 1 && iframeSnapshot!.y + iframeSnapshot!.height <= vp!.height + 1, 'iframe must fit the actual 1440x1000 viewport')

    const visibleContent = await blobFrame.evaluate(() => {
      const h1 = document.querySelector('h1') as HTMLElement | null
      const p = document.querySelector('p') as HTMLElement | null
      const win = document.defaultView || window
      const out: Record<string, unknown> = { readyState: document.readyState }
      const elems: Array<[string, HTMLElement | null]> = [['h1', h1], ['p', p]]
      for (let i = 0; i < elems.length; i++) {
        const [key, el] = elems[i]!
        if (!el) { out[key] = null; continue }
        const cs = win.getComputedStyle(el)
        const rect = el.getBoundingClientRect()
        out[key] = {
          text: el.textContent || '',
          id: el.id || '',
          tag: el.tagName,
          rect: { width: rect.width, height: rect.height, top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
          display: cs.display,
          visibility: cs.visibility,
          opacity: Number(cs.opacity),
        }
      }
      return out as { h1: { text: string; id: string; tag: string; rect: { width: number; height: number; top: number; bottom: number; left: number; right: number }; display: string; visibility: string; opacity: number } | null; p: typeof visibleContent extends { p: infer P } ? P : never; readyState: string }
    })
    const iframeHeight = iframeSnapshot!.height
    const iframeWidth = iframeSnapshot!.width
    const isVisuallyShown = (m: typeof visibleContent.h1) => Boolean(m
      && m.rect.width > 0 && m.rect.height > 0
      && m.display !== 'none' && m.visibility !== 'hidden' && m.visibility !== 'collapse'
      && m.opacity > 0
      && m.rect.top >= 0 && m.rect.bottom <= iframeHeight + 1
      && m.rect.left >= 0 && m.rect.right <= iframeWidth + 1)
    assert.ok(visibleContent.h1, 'iframe h1 missing')
    assert.ok(visibleContent.p, 'iframe p missing')
    assert.equal(visibleContent.h1.text, 'GoTry artifact-web visible heading')
    assert.equal(visibleContent.h1.id, 'artifact-web-h1')
    assert.equal(visibleContent.p.text, 'GoTry artifact-web visible body line — synthetic only.')
    assert.equal(isVisuallyShown(visibleContent.h1), true, `iframe h1 not visually shown: ${JSON.stringify(visibleContent.h1)}`)
    assert.equal(isVisuallyShown(visibleContent.p), true, `iframe p not visually shown: ${JSON.stringify(visibleContent.p)}`)
    assert.equal(await page.evaluate(() => (window as unknown as Record<string, unknown>)['__artifact_web_host_executed__'] ?? null), null, 'host sentinel mutated during native preview')

    // Scroll the latest (third-turn) source-text read card into the viewport so
    // the page screenshot proves the latest HTML read card is the one visible
    // alongside the right-side native preview — not a stale first-turn MD card.
    await page.evaluate(() => {
      const reads = Array.from(document.querySelectorAll('[data-gotry-artifact-card="read"]')) as HTMLElement[]
      const latest = reads[reads.length - 1]
      latest?.scrollIntoView({ block: 'center' })
    })
    await page.waitForFunction(() => {
      const reads = Array.from(document.querySelectorAll('[data-gotry-artifact-card="read"]')) as HTMLElement[]
      const latest = reads[reads.length - 1]
      if (!latest) return false
      const r = latest.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && r.top < window.innerHeight && r.bottom > 0
    }, { timeout: 30_000 })

    const htmlScreenshotPath = join(outputDir, 'artifact-web-e2e.native-html.png')
    await page.screenshot({ path: htmlScreenshotPath, fullPage: false })
    const iframeElement = await page.$('iframe[src^="blob:"]')
    const htmlIframeScreenshotPath = join(outputDir, 'artifact-web-e2e.native-html.iframe.png')
    if (iframeElement) await iframeElement.screenshot({ path: htmlIframeScreenshotPath })
    assertions.nativeHtml = {
      viewport: vp,
      htmlSourceCard: htmlSourceSnapshot,
      htmlPathButton: htmlButtonSnapshot,
      iframesBeforeClick: iframesBefore,
      iframe: iframeSnapshot,
      iframeContent: visibleContent,
      screenshots: { page: htmlScreenshotPath, iframe: htmlIframeScreenshotPath },
      htmlFixture: { path: join(workspaceDir, 'trip-2027.html'), sentinel: htmlSentinel },
    }
    assert.deepEqual(relay.servedTools, [
      'gotry_artifacts_list',
      'gotry_artifacts_read',
      'read',
      'edit',
      'gotry_artifacts_read',
      'gotry_artifacts_list',
      'gotry_artifacts_read',
    ])
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
