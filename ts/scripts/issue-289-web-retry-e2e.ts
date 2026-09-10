/**
 * Issue #289 bounded current-Web retry/cancel E2E.
 *
 * Pinned acceptance for this proof:
 *   A. A fresh packaged GoTry consumer drives the public Web UI through a
 *      localhost OpenAI-compatible relay: 429 -> visible scheduled retry ->
 *      visible retry-started -> terminal assistant success.
 *   B. A second fresh Web turn is visibly in retry backoff; the real public
 *      Stop control cancels it, the UI shows the target retry as cancelled
 *      and the session is idle, and after a drain longer than the backoff the
 *      relay request count is unchanged.
 *   C. Every assertion is isolated from user HOME, DSH_HOME, state,
 *      workspace, browser profile, providers, credentials, and booking writes.
 *
 * This is deliberately a packaged-public-path proof. It does not import or
 * call internal agent cancellation APIs, patch product/vendor code, or use a
 * real provider. Run from ts/ with Node >= 24:
 *   npx tsx scripts/issue-289-web-retry-e2e.ts
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
const BACKOFF_MS = 10_000
const CANCEL_DRAIN_MS = BACKOFF_MS + 1_000
const STARTUP_TIMEOUT_MS = 120_000
const UI_TIMEOUT_MS = 60_000
const RETRY_STATE_ROW_PATTERN = /(?:正在重试模型请求|等待重试模型请求|已重试模型请求|模型请求重试已取消|Retrying model request|Waiting to retry model request|Retried model request|Model request retry cancelled)/i

type Scenario = 'A' | 'B'
type RequestKind = 'primary' | 'title' | 'auxiliary'
type WireBody = { messages?: unknown[]; tools?: unknown; max_tokens?: unknown; system?: unknown }
type RelayRecord = {
  scenario: Scenario | null
  kind: RequestKind
  ordinal: number | null
  userMarker: string | null
  at: string
  status: number
}
type Relay = {
  port: number
  records: RelayRecord[]
  close: () => Promise<void>
}
type WebServerProcess = ChildProcessByStdio<null, Readable, Readable>
type DomSnapshot = {
  targetFound: boolean
  turn: string | null
  statuses: string[]
  retryRows: Array<{ text: string; active: boolean; open: boolean; visible: boolean }>
  turnText: string
  bodyText: string
}

function sse(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

function textResponse(id: string, text: string): string {
  return sse({
    id,
    object: 'chat.completion.chunk',
    created: 1,
    model: 'synthetic-issue-289',
    choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
  }) + sse({
    id: `${id}-finish`,
    object: 'chat.completion.chunk',
    created: 1,
    model: 'synthetic-issue-289',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  }) + 'data: [DONE]\n\n'
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) {
    if (content && typeof content === 'object' && typeof (content as { text?: unknown }).text === 'string') return (content as { text: string }).text
    return ''
  }
  return content.map(item => contentText(item)).join('')
}

function latestUserMarker(body: WireBody): { scenario: Scenario | null; marker: string | null } {
  const messages = Array.isArray(body.messages) ? body.messages : []
  for (const message of [...messages].reverse()) {
    if (!message || typeof message !== 'object' || (message as { role?: unknown }).role !== 'user') continue
    const text = contentText((message as { content?: unknown }).content)
    if (text.includes('ISSUE289_SCENARIO_A')) return { scenario: 'A', marker: 'ISSUE289_SCENARIO_A' }
    if (text.includes('ISSUE289_SCENARIO_B')) return { scenario: 'B', marker: 'ISSUE289_SCENARIO_B' }
  }
  return { scenario: null, marker: null }
}

function classifyRequest(body: WireBody): { kind: RequestKind; scenario: Scenario | null; marker: string | null } {
  const primary = Array.isArray(body.tools) && body.tools.length > 0
  const messages = Array.isArray(body.messages) ? body.messages : []
  const messageText = messages.map(message => message && typeof message === 'object' ? contentText((message as { content?: unknown }).content) : '').join('\n')
  const systemText = contentText(body.system)
  const titlePrompt = !primary && body.max_tokens === 64 && (
    systemText.includes('Create a concise title for an AI coding-assistant session') ||
    messageText.includes('Generate the session title from this JSON array of human messages')
  )
  if (primary) {
    const target = latestUserMarker(body)
    return { kind: 'primary', scenario: target.scenario, marker: target.marker }
  }
  return { kind: titlePrompt ? 'title' : 'auxiliary', scenario: null, marker: null }
}

async function startRelay(): Promise<Relay> {
  const records: RelayRecord[] = []
  const counts: Record<Scenario, number> = { A: 0, B: 0 }
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end('not found')
      return
    }
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      let body: WireBody = {}
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as WireBody } catch { /* dsh reports malformed upstream */ }
      const request = classifyRequest(body)
      const scenario = request.kind === 'primary' ? request.scenario : null
      const ordinal = scenario === null ? null : counts[scenario]++
      const status = request.kind === 'primary' && scenario !== null && ordinal === 0 ? 429 : 200
      records.push({ kind: request.kind, scenario, ordinal, userMarker: request.marker, at: new Date().toISOString(), status })
      if (status === 429) {
        res.writeHead(429, {
          'content-type': 'application/json',
          'retry-after': String(BACKOFF_MS / 1_000),
          'x-request-id': `issue-289-${scenario}-initial`,
        })
        res.end(JSON.stringify({ error: { code: 'RATE_LIMIT', message: `synthetic issue-289 scenario ${scenario} rate limit`, status: 429 } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      if (request.kind === 'primary' && scenario === 'A' && ordinal !== null && ordinal >= 1) {
        // Hold the successful retry stream briefly so the public UI's
        // retry-started state remains observable before terminal success.
        setTimeout(() => res.end(textResponse(`issue-289-a-success-${ordinal}`, 'ISSUE289_SCENARIO_A_SUCCESS')), 1_500)
      } else if (request.kind === 'primary' && scenario === 'B' && ordinal !== null && ordinal >= 1) {
        // This response is intentionally reachable only if cancellation fails.
        res.end(textResponse('issue-289-b-unexpected-success', 'ISSUE289_SCENARIO_B_UNEXPECTED_RETRY'))
      } else {
        // Non-scenario requests (including the one-time title warm-up) never
        // leave the localhost relay and cannot change either scenario's
        // count. Keep the response non-empty so the warm-up turn closes.
        res.end(textResponse(`issue-289-aux-${records.length}`, 'ISSUE289_WARMUP_SUCCESS'))
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    port: (server.address() as { port: number }).port,
    records,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  }
}

async function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const result = await execFile(command, args, { cwd, env, maxBuffer: 16 * 1024 * 1024 })
  return result.stdout
}

function waitForUrl(child: WebServerProcess, pattern: RegExp, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => {
      child.stdout.off('data', onData)
      child.stderr.off('data', onData)
      reject(new Error(`timed out waiting for ${pattern}; output=${output.slice(-4000)}`))
    }, timeoutMs)
    const onData = (chunk: Buffer) => {
      output += chunk.toString()
      const match = output.match(pattern)
      if (!match) return
      clearTimeout(timer)
      child.stdout.off('data', onData)
      child.stderr.off('data', onData)
      resolve(match[1]!)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
  })
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, description: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
  assert.ok(predicate(), `${description} did not settle within ${timeoutMs}ms`)
}

async function terminateServer(child: WebServerProcess | null): Promise<void> {
  if (!child || child.exitCode !== null) return
  const groupPid = process.platform === 'win32' ? null : child.pid
  const signal = (name: NodeJS.Signals) => {
    if (groupPid) {
      try { process.kill(-groupPid, name); return } catch { /* fall back to leader */ }
    }
    try { child.kill(name) } catch { /* already exited */ }
  }
  signal('SIGTERM')
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => {
      signal('SIGKILL')
      resolve()
    }, 2_000)
    child.once('close', () => { clearTimeout(timer); resolve() })
  })
}

type ProcessRow = { pid: number; ppid: number; command: string }

async function processTable(): Promise<ProcessRow[]> {
  const { stdout } = await execFile('ps', ['-axo', 'pid=,ppid=,command='])
  return stdout.split('\n').flatMap(line => {
    const fields = line.trim().split(/\s+/)
    const pid = Number(fields.shift())
    const ppid = Number(fields.shift())
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) return []
    return [{ pid, ppid, command: fields.join(' ') }]
  })
}

async function ownedProcessIds(serverPid: number | undefined, ownedPaths: string[]): Promise<number[]> {
  const rows = await processTable()
  const ids = new Set<number>()
  for (const row of rows) {
    if ((serverPid !== undefined && row.pid === serverPid) || ownedPaths.some(path => row.command.includes(path))) ids.add(row.pid)
  }
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      if (ids.has(row.ppid) && !ids.has(row.pid)) {
        ids.add(row.pid)
        changed = true
      }
    }
  }
  return [...ids].sort((left, right) => right - left)
}

async function reapOwnedProcesses(serverPid: number | undefined, ownedPaths: string[]): Promise<number[]> {
  let remaining = await ownedProcessIds(serverPid, ownedPaths)
  for (const pid of remaining) {
    try { process.kill(pid, 'SIGTERM') } catch { /* already exited */ }
  }
  const termDeadline = Date.now() + 2_000
  while (remaining.length > 0 && Date.now() < termDeadline) {
    await new Promise(resolve => setTimeout(resolve, 25))
    remaining = await ownedProcessIds(serverPid, ownedPaths)
  }
  for (const pid of remaining) {
    try { process.kill(pid, 'SIGKILL') } catch { /* already exited */ }
  }
  const killDeadline = Date.now() + 2_000
  while (remaining.length > 0 && Date.now() < killDeadline) {
    await new Promise(resolve => setTimeout(resolve, 25))
    remaining = await ownedProcessIds(serverPid, ownedPaths)
  }
  return remaining
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function redactSecrets(text: string): string {
  return text
    .replace(/([?&]token=)[^&\s)]+/g, '$1[REDACTED]')
    .replace(/synthetic-issue-289-key/g, '[REDACTED_KEY]')
}

async function main(): Promise<void> {
  assert.ok(Number.parseInt(process.versions.node.split('.')[0]!, 10) >= 24, `Node >=24 required, got ${process.version}`)
  assert.ok(existsSync(CHROME), `Chrome missing: ${CHROME}`)
  const baseSha = (await run('git', ['rev-parse', 'HEAD'], ROOT, process.env)).trim()
  assert.match(baseSha, /^[0-9a-f]{40}$/, `unexpected HEAD SHA: ${baseSha}`)
  const outputDir = process.env.GOTRY_ISSUE_289_WEB_E2E_OUT || join(ROOT, '.omx', 'artifacts', 'issue-289-web-retry-e2e')
  mkdirSync(outputDir, { recursive: true })

  const packageDir = mkdtempSync(join(tmpdir(), 'gotry-issue-289-web-pack-'))
  const consumerDir = mkdtempSync(join(tmpdir(), 'gotry-issue-289-web-consumer-'))
  const workspaceDir = mkdtempSync(join(tmpdir(), 'gotry-issue-289-web-workspace-'))
  const homeDir = mkdtempSync(join(tmpdir(), 'gotry-issue-289-web-home-'))
  const dshHome = mkdtempSync(join(tmpdir(), 'gotry-issue-289-web-dsh-'))
  const userDataDir = mkdtempSync(join(tmpdir(), 'gotry-issue-289-web-chrome-'))
  const relay = await startRelay()
  const browserProfile = userDataDir
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null
  let page: any = null
  let server: WebServerProcess | null = null
  let passed = false
  let serverOutput = ''
  const assertions: Record<string, unknown> = {
    baseSha,
    node: process.version,
    isolation: {
      home: homeDir,
      dshHome,
      workspace: workspaceDir,
      consumer: consumerDir,
      browserProfile,
      liveFlags: { GOTRY_SESSION_LIVE: '0', GOTRY_HBCLI_LIVE: '0', GOTRY_HOTELBYTE_SKILLS_LIVE: '0' },
      relay: '127.0.0.1 only',
      syntheticKey: true,
      bookingWrite: false,
    },
  }

  try {
    writeFileSync(join(consumerDir, 'package.json'), JSON.stringify({ private: true, dependencies: {} }, null, 2) + '\n', { mode: 0o600 })
    await run(process.execPath, [join(ROOT, 'scripts/build-dist.mjs')], ROOT, process.env)
    await run('npm', ['pack', '--ignore-scripts', '--pack-destination', packageDir], ROOT, process.env)
    const tarballName = readdirSync(packageDir).find(name => name.endsWith('.tgz'))
    assert.ok(tarballName, 'npm pack did not produce a GoTry tarball')
    const tarball = join(packageDir, tarballName)
    const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }
    const npmEnv = { ...process.env, HOME: homeDir }
    await run('npm', ['install', '--prefer-offline', '--ignore-scripts', '--no-audit', '--no-fund', tarball], consumerDir, npmEnv)
    const installedRoot = join(consumerDir, 'node_modules', '@danceiny', 'gotry')
    const installedBin = join(installedRoot, 'bin', 'gotry-inner.js')
    assert.ok(existsSync(installedBin), 'packed GoTry binary missing')
    assert.ok(existsSync(join(installedRoot, 'client', 'client.js')), 'packed public client missing')
    assertions.package = { version: packageJson.version, tarball: basename(tarball), installedClient: join(installedRoot, 'client', 'client.js') }

    const env: NodeJS.ProcessEnv = {
      ...npmEnv,
      DSH_HOME: dshHome,
      GOTRY_ONBOARDING_SKIP: '1',
      GOTRY_SETUP_SKIP: '1',
      GOTRY_SESSION_LIVE: '0',
      GOTRY_HBCLI_LIVE: '0',
      GOTRY_HOTELBYTE_SKILLS_LIVE: '0',
      LLM_API_KEY: 'synthetic-issue-289-key',
      LLM_BASE_URL: `http://127.0.0.1:${relay.port}/v1`,
      LLM_MODEL: 'synthetic-issue-289',
    }
    const child = spawn(process.execPath, [installedBin, 'web', '--no-open', '--port', '0'], {
      cwd: workspaceDir,
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    server = child
    child.stdout.on('data', chunk => { serverOutput += chunk.toString() })
    child.stderr.on('data', chunk => { serverOutput += chunk.toString() })
    const url = await waitForUrl(child, /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s)]+)/, STARTUP_TIMEOUT_MS)
    assertions.server = { authenticatedUrlCaptured: true, urlHost: new URL(url).host, port: new URL(url).port }

    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] })
    page = await browser.newPage()
    page.on('console', (message: any) => { serverOutput += `\n[browser console ${message.type()}] ${message.text()}` })
    page.on('pageerror', (error: Error) => { serverOutput += `\n[browser pageerror] ${error.stack || error.message}` })
    page.setDefaultTimeout(UI_TIMEOUT_MS)
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30_000 })
    const dismissDisclosure = async () => {
      const buttons = await page.$$('button')
      for (const button of buttons) {
        const control = await button.evaluate((node: Element) => {
          const rect = node.getBoundingClientRect()
          return { text: node.textContent?.trim(), visible: rect.width > 0 && rect.height > 0 }
        })
        if (control.text === '继续' && control.visible) {
          await button.click()
          await page.waitForFunction(() => ![...document.querySelectorAll('button')].some(node => {
            const rect = node.getBoundingClientRect()
            return node.textContent?.trim() === '继续' && rect.width > 0 && rect.height > 0
          }), { timeout: UI_TIMEOUT_MS })
          return
        }
      }
    }
    await dismissDisclosure()

    const workspaceTitle = basename(workspaceDir)
    const workspaceRpc = await page.evaluate(async (path: string) => {
      const rpcId = crypto.randomUUID()
      const response = await fetch('/api/workspace/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method: 'workspace/create', payload: { args: { request: { path } } } }),
      })
      return { status: response.status, body: await response.text() }
    }, workspaceDir)
    assert.equal(workspaceRpc.status, 200, `workspace RPC failed: ${workspaceRpc.status} ${workspaceRpc.body}`)
    const workspaceResult = JSON.parse(workspaceRpc.body) as { result?: { ok?: boolean } }
    assert.equal(workspaceResult.result?.ok, true, `workspace RPC rejected: ${workspaceRpc.body}`)
    await page.reload({ waitUntil: 'networkidle2', timeout: 30_000 })
    await dismissDisclosure()
    await page.waitForFunction((title: string) => document.body.innerText.includes(title), { timeout: UI_TIMEOUT_MS }, workspaceTitle)
    await page.click('button[aria-label="选择工作区"], button[aria-label="Select workspace"]')
    await page.waitForFunction((title: string) => [...document.querySelectorAll('[role="menuitem"], [role="option"], button')].some(node => node.textContent?.trim() === title), { timeout: UI_TIMEOUT_MS }, workspaceTitle)
    await page.evaluate((title: string) => {
      const node = [...document.querySelectorAll('[role="menuitem"], [role="option"], button')].find(candidate => candidate.textContent?.trim() === title) as HTMLElement | undefined
      node?.click()
    }, workspaceTitle)
    await page.waitForSelector('[contenteditable="true"]')

    const submit = async (text: string) => {
      const editor = await page.$('[contenteditable="true"]')
      assert.ok(editor, 'real public composer missing')
      await editor.click()
      await page.keyboard.type(text)
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some(node => {
        const label = node.getAttribute('aria-label')
        return (label === '发送消息' || label === 'Send message') && !(node as HTMLButtonElement).disabled
      }), { timeout: UI_TIMEOUT_MS })
      const sendButtons = await page.$$('button[aria-label="发送消息"], button[aria-label="Send message"]')
      let clicked = false
      for (const send of sendButtons) {
        const control = await send.evaluate((node: Element) => {
          const button = node as HTMLButtonElement
          const rect = button.getBoundingClientRect()
          return { disabled: button.disabled, visible: rect.width > 0 && rect.height > 0 }
        })
        if (!control.disabled && control.visible) {
          await send.click()
          clicked = true
          break
        }
      }
      assert.equal(clicked, true, 'real visible enabled composer send control missing')
      const marker = text.match(/ISSUE289_SCENARIO_[AB]|ISSUE289_WARMUP/)?.[0]
      if (marker) await page.waitForFunction((target: string) => document.body.innerText.includes(target), { timeout: UI_TIMEOUT_MS }, marker)
    }
    const retryDom = async (marker: string): Promise<DomSnapshot> => page.evaluate((targetMarker: string, retryStateRowPattern: string) => {
      const markerNode = [...document.querySelectorAll('*')].find(node => node.children.length === 0 && node.textContent?.includes(targetMarker))
      const markerFlow = markerNode?.closest('[data-chat-turn]')
      const turn = markerFlow?.getAttribute('data-chat-turn') || null
      const turnNodes = turn === null ? [] : [...document.querySelectorAll(`[data-chat-turn="${turn}"]`)]
      const retryStateRow = new RegExp(retryStateRowPattern, 'i')
      const statuses = turnNodes.flatMap(node => [...node.querySelectorAll('[role="status"]')].map(status => status.textContent?.trim() || ''))
      const retryRows = turnNodes.flatMap(node => [...node.querySelectorAll('details')])
        .filter(node => retryStateRow.test(node.textContent || ''))
        .map(node => ({
          text: node.textContent?.trim() || '',
          active: node.hasAttribute('data-active'),
          open: node.hasAttribute('open'),
          visible: (() => { const visibleNode = node.querySelector('[role="status"]') || node.querySelector('summary') || node; const r = visibleNode.getBoundingClientRect(); return r.width > 0 && r.height > 0 })(),
        }))
      return { targetFound: markerNode !== undefined, turn, statuses, retryRows, turnText: turnNodes.map(node => node.textContent || '').join('\n'), bodyText: document.body.innerText }
    }, marker, RETRY_STATE_ROW_PATTERN.source)
    const snapshot = async (marker: string) => retryDom(marker)
    const waitForTargetStatus = async (marker: string, pattern: RegExp, description: string, active = false) => {
      await page.waitForFunction((targetMarker: string, source: string, flags: string, requireActive: boolean) => {
        const markerNode = [...document.querySelectorAll('*')].find(node => node.children.length === 0 && node.textContent?.includes(targetMarker))
        const turn = markerNode?.closest('[data-chat-turn]')?.getAttribute('data-chat-turn')
        if (turn === undefined) return false
        const turnNodes = [...document.querySelectorAll(`[data-chat-turn="${turn}"]`)]
        if (requireActive) return turnNodes.flatMap(node => [...node.querySelectorAll('details[data-active]')]).some(row => {
          const rect = row.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0 && [...row.querySelectorAll('[role="status"]')].some(node => new RegExp(source, flags).test(node.textContent || ''))
        })
        return turnNodes.flatMap(node => [...node.querySelectorAll('[role="status"]')]).some(node => new RegExp(source, flags).test(node.textContent || ''))
      }, { timeout: UI_TIMEOUT_MS }, marker, pattern.source, pattern.flags, active)
      return snapshot(marker)
    }
    const expandTargetProcess = async (marker: string) => page.evaluate((targetMarker: string) => {
      const markerNode = [...document.querySelectorAll('*')].find(node => node.children.length === 0 && node.textContent?.includes(targetMarker))
      const turn = markerNode?.closest('[data-chat-turn]')?.getAttribute('data-chat-turn')
      if (turn === undefined) return { found: false, clicked: false }
      const processButton = [...document.querySelectorAll(`[data-chat-turn="${turn}"] button[data-turn-process]`)].find(node => node.getAttribute('aria-expanded') !== 'true') as HTMLButtonElement | undefined
      if (!processButton) return { found: true, clicked: false }
      processButton.click()
      return { found: true, clicked: true, ariaLabel: processButton.getAttribute('aria-label'), text: processButton.textContent?.trim() || '' }
    }, marker)
    const publicControls = async () => page.evaluate(() => ({
      stopVisible: [...document.querySelectorAll('button[aria-label="停止生成"], button[aria-label="Stop generating"]')].some(node => {
        const rect = node.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      }),
      sendEnabled: [...document.querySelectorAll('button[aria-label="发送消息"], button[aria-label="Send message"]')].some(node => {
        const button = node as HTMLButtonElement
        const rect = button.getBoundingClientRect()
        return !button.disabled && rect.width > 0 && rect.height > 0
      }),
    }))
    const typeWithoutSending = async (text: string) => {
      const editor = await page.$('[contenteditable="true"]')
      assert.ok(editor, 'real public composer missing while proving idle')
      await editor.click()
      await page.keyboard.type(text)
      await page.waitForFunction(() => [...document.querySelectorAll('button[aria-label="发送消息"], button[aria-label="Send message"]')].some(node => {
        const button = node as HTMLButtonElement
        const rect = button.getBoundingClientRect()
        return !button.disabled && rect.width > 0 && rect.height > 0
      }), { timeout: UI_TIMEOUT_MS })
      return { text, sendEnabled: true, sent: false }
    }

    await submit('ISSUE289_WARMUP：初始化本地隔离 Web 会话。')
    await page.waitForFunction(() => document.body.innerText.includes('ISSUE289_WARMUP_SUCCESS'), { timeout: UI_TIMEOUT_MS })
    await submit('ISSUE289_SCENARIO_A：请用一句话确认 retry E2E。')
    await waitUntil(() => relay.records.some(record => record.scenario === 'A' && record.status === 429), 10_000, 'scenario A relay 429')
    const scheduledPattern = /等待重试模型请求|正在重试模型请求|Waiting to retry model request|Retrying model request/
    const scheduledA = await waitForTargetStatus('ISSUE289_SCENARIO_A', scheduledPattern, 'scenario A scheduled retry', true)
    assert.ok(scheduledA.retryRows.some(row => row.active && row.visible && scheduledPattern.test(row.text)), 'scenario A active scheduled retry row is not visibly rendered')
    const screenshotScheduledA = join(outputDir, 'scenario-a-retry-scheduled.png')
    await page.screenshot({ path: screenshotScheduledA, fullPage: true })
    await page.waitForFunction(() => document.body.innerText.includes('ISSUE289_SCENARIO_A_SUCCESS'), { timeout: UI_TIMEOUT_MS })
    const expansionA = await expandTargetProcess('ISSUE289_SCENARIO_A')
    assert.equal(expansionA.found, true, 'scenario A public process disclosure missing')
    const successA = await snapshot('ISSUE289_SCENARIO_A')
    assert.ok(successA.statuses.some(status => /已重试模型请求|Retried model request/.test(status)), 'scenario A retry-started status missing from target DOM')
    assert.ok(successA.retryRows.some(row => row.visible && /已重试模型请求|Retried model request/.test(row.text)), 'scenario A retry-started row is not visibly rendered after public process expansion')
    assert.ok(successA.bodyText.includes('ISSUE289_SCENARIO_A_SUCCESS'), 'scenario A terminal assistant success missing')
    const aRecords = relay.records.filter(record => record.scenario === 'A')
    assert.ok(aRecords.length >= 2, 'scenario A must include the initial 429 and a successful provider request')
    assert.equal(aRecords[0]?.status, 429, 'scenario A first provider response must be 429')
    assert.ok(aRecords.slice(1).some(record => record.status === 200), 'scenario A must include a successful provider response')
    const screenshotSuccessA = join(outputDir, 'scenario-a-retry-started-success.png')
    await page.screenshot({ path: screenshotSuccessA, fullPage: true })

    const newSessionButton = await page.$('button[aria-label="新建会话"], button[aria-label="New session"]')
    assert.ok(newSessionButton, 'real public New session control missing')
    const newSessionLabel = await page.evaluate((button: Element) => button.getAttribute('aria-label'), newSessionButton)
    await newSessionButton.click()
    await page.waitForFunction((marker: string) => !document.body.innerText.includes(marker) && document.querySelectorAll('[data-chat-turn]').length === 0, { timeout: UI_TIMEOUT_MS }, 'ISSUE289_SCENARIO_A')
    await page.waitForSelector('[contenteditable="true"]')
    await submit('ISSUE289_SCENARIO_B：开始一个可取消的 retry。')
    const scheduledB = await waitForTargetStatus('ISSUE289_SCENARIO_B', scheduledPattern, 'scenario B scheduled retry', true)
    assert.ok(scheduledB.retryRows.some(row => row.active && row.visible && scheduledPattern.test(row.text)), 'scenario B active scheduled retry row is not visibly rendered')
    const bRecordsBeforeCancel = relay.records.filter(record => record.scenario === 'B')
    assert.equal(bRecordsBeforeCancel.length, 1, 'scenario B must have exactly one primary request before cancellation')
    assert.equal(bRecordsBeforeCancel[0]?.status, 429, 'scenario B first primary provider response must be 429')
    const stopButtons = await page.$$('button[aria-label="停止生成"], button[aria-label="Stop generating"]')
    let stopButton: any = null
    for (const candidate of stopButtons) {
      const control = await candidate.evaluate((node: Element) => {
        const button = node as HTMLButtonElement
        const rect = button.getBoundingClientRect()
        return { disabled: button.disabled, visible: rect.width > 0 && rect.height > 0 }
      })
      if (!control.disabled && control.visible) {
        stopButton = candidate
        break
      }
    }
    assert.ok(stopButton, 'real visible enabled Stop control missing')
    const stopControl = await page.evaluate((button: Element) => {
      const html = button as HTMLButtonElement
      const rect = html.getBoundingClientRect()
      return { ariaLabel: html.getAttribute('aria-label'), disabled: html.disabled, visible: rect.width > 0 && rect.height > 0 }
    }, stopButton)
    assert.equal(stopControl.disabled, false, 'real public Stop control is disabled during retry backoff')
    assert.equal(stopControl.visible, true, 'real public Stop control is not visible during retry backoff')
    const bCountAtCancel = bRecordsBeforeCancel.length
    await stopButton.click()
    const cancelObservedAt = Date.now()
    const cancelledB = await waitForTargetStatus('ISSUE289_SCENARIO_B', /模型请求重试已取消|Model request retry cancelled/, 'scenario B cancelled retry')
    assert.ok(cancelledB.retryRows.some(row => row.visible && !row.active && /模型请求重试已取消|Model request retry cancelled/.test(row.text)), 'scenario B cancelled retry row is not visibly rendered')
    const cancelledControls = await publicControls()
    assert.equal(cancelledControls.stopVisible, false, 'public Stop control remains visible after cancellation')
    assert.equal(cancelledB.retryRows.some(row => row.active), false, 'scenario B target still has an active retry after cancellation')
    assert.equal(/正在重试模型请求|Retrying model request|生成中|Generating|进行中|Running/.test(cancelledB.turnText), false, 'scenario B target still shows a generating/running state after cancellation')
    const idleText = '仅输入不发送：验证 Web 会话已空闲。'
    const bCountBeforeIdle = relay.records.filter(record => record.kind === 'primary' && record.scenario === 'B').length
    const idleInput = await typeWithoutSending(idleText)
    const idleControls = await publicControls()
    assert.equal(idleControls.stopVisible, false, 'public Stop control reappeared while proving idle')
    assert.equal(idleControls.sendEnabled, true, 'real public Send control is not enabled for the unsent idle input')
    assert.equal(relay.records.filter(record => record.kind === 'primary' && record.scenario === 'B').length, bCountBeforeIdle, 'typing idle input must not issue a B provider request')
    await new Promise(resolve => setTimeout(resolve, CANCEL_DRAIN_MS))
    const afterDrainB = await snapshot('ISSUE289_SCENARIO_B')
    const afterDrainControls = await publicControls()
    const bRecords = relay.records.filter(record => record.kind === 'primary' && record.scenario === 'B')
    assert.equal(bRecords.length, bCountAtCancel, 'scenario B provider request count must not increase after UI cancellation')
    assert.equal(bRecords.filter(record => Date.parse(record.at) >= cancelObservedAt).length, 0, 'scenario B must not issue a provider request after UI cancellation')
    assert.ok(afterDrainB.retryRows.some(row => row.visible && !row.active && /模型请求重试已取消|Model request retry cancelled/.test(row.text)), 'scenario B cancelled retry row is not visibly rendered after drain')
    assert.equal(afterDrainB.retryRows.some(row => row.active), false, 'scenario B target gained an active retry during drain')
    assert.equal(afterDrainB.retryRows.some(row => /已重试模型请求|Retried model request/.test(row.text)), false, 'scenario B target gained retry-started after cancellation')
    assert.equal(/正在重试模型请求|Retrying model request|生成中|Generating|进行中|Running/.test(afterDrainB.turnText), false, 'scenario B target shows a generating/running state after drain')
    assert.equal(afterDrainControls.stopVisible, false, 'public Stop control is visible after cancellation drain')
    assert.equal(afterDrainControls.sendEnabled, true, 'real public Send control is not enabled after cancellation drain')
    assert.equal(relay.records.filter(record => record.kind === 'primary' && record.scenario === 'B').length, bCountBeforeIdle, 'idle input or drain changed the B primary baseline')
    const screenshotCancelledB = join(outputDir, 'scenario-b-cancelled-idle.png')
    await page.screenshot({ path: screenshotCancelledB, fullPage: true })

    assertions.scenarioA = { scheduled: scheduledA, expansionA, started: successA, success: successA, providerRecords: aRecords }
    assertions.sessions = { scenarioA: 'first public session', newSessionControl: { clicked: true, ariaLabel: newSessionLabel }, scenarioB: 'new public session after New session click' }
    assertions.scenarioB = { scheduled: scheduledB, cancelled: cancelledB, controlsAfterCancel: cancelledControls, idleInput, idleControls, afterDrain: afterDrainB, afterDrainControls, cancelObservedAt: new Date(cancelObservedAt).toISOString(), requestCountAtCancel: bCountAtCancel, requestCountBeforeIdle: bCountBeforeIdle, providerRecords: bRecords }
    assertions.relay = { allRecords: relay.records, scenarioARequests: aRecords.length, scenarioBRequestsAtCancel: bCountAtCancel, scenarioBRequestsAfterDrain: bRecords.length, cancelDrainMs: CANCEL_DRAIN_MS }
    const finalSha = (await run('git', ['rev-parse', 'HEAD'], ROOT, process.env)).trim()
    assert.equal(finalSha, baseSha, `HEAD changed during E2E: expected ${baseSha}, got ${finalSha}`)
    assertions.finalSha = finalSha
    const domPath = join(outputDir, 'issue-289-web-retry-e2e.json')
    writeFileSync(domPath, JSON.stringify(assertions, null, 2) + '\n', { mode: 0o600 })
    const logPath = join(outputDir, 'issue-289-web-retry-e2e.log')
    writeFileSync(logPath, redactSecrets(serverOutput), { mode: 0o600 })
    const receipt = {
      baseSha,
      finalSha,
      node: process.version,
      screenshots: [screenshotScheduledA, screenshotSuccessA, screenshotCancelledB].map(path => ({ path, sha256: sha256(path) })),
      assertions: { path: domPath, sha256: sha256(domPath) },
      log: { path: logPath, sha256: sha256(logPath) },
      relay: { scenarioARequests: aRecords.length, scenarioBRequestsAtCancel: bCountAtCancel, scenarioBRequestsBeforeIdle: bCountBeforeIdle, scenarioBRequestsAfterDrain: bRecords.length, noProviderRequestAfterCancel: true, noRetryStartedAfterCancel: true },
    }
    const receiptPath = join(outputDir, 'issue-289-web-retry-e2e.receipt.json')
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
    passed = true
    console.log(`ISSUE #289 WEB RETRY/CANCEL E2E: PASS node=${process.version} baseSha=${baseSha} screenshots=${screenshotScheduledA},${screenshotSuccessA},${screenshotCancelledB} receipt=${receiptPath} receiptSha256=${sha256(receiptPath)}`)
  } finally {
    if (page && !passed) {
      try {
        const failureHtml = join(outputDir, 'issue-289-web-retry-e2e.failure.html')
        const failurePng = join(outputDir, 'issue-289-web-retry-e2e.failure.png')
        const failureLog = join(outputDir, 'issue-289-web-retry-e2e.failure.log')
        const failureSha = (await run('git', ['rev-parse', 'HEAD'], ROOT, process.env)).trim()
        assert.equal(failureSha, baseSha, `HEAD changed during failed E2E: expected ${baseSha}, got ${failureSha}`)
        writeFileSync(failureHtml, await page.content(), { mode: 0o600 })
        await page.screenshot({ path: failurePng, fullPage: true })
        writeFileSync(failureLog, redactSecrets(`baseSha=${baseSha}\nfinalSha=${failureSha}\nnode=${process.version}\n${serverOutput}\nrelayRecords=${JSON.stringify(relay.records, null, 2)}\n`), { mode: 0o600 })
        console.error(`ISSUE #289 WEB RETRY/CANCEL E2E failure artifacts: html=${failureHtml}; screenshot=${failurePng}; log=${failureLog}`)
      } catch { /* browser may have failed before a document existed */ }
    }
    await browser?.close().catch(() => {})
    const serverPid = server?.pid
    await terminateServer(server)
    await relay.close().catch(() => {})
    const remainingOwnedProcesses = await reapOwnedProcesses(serverPid, [consumerDir, userDataDir])
    if (remainingOwnedProcesses.length > 0) {
      passed = false
      const cleanupLog = join(outputDir, 'issue-289-web-retry-e2e.cleanup-failure.log')
      writeFileSync(cleanupLog, `ownedProcessIds=${JSON.stringify(remainingOwnedProcesses)}\n`, { mode: 0o600 })
      throw new Error(`fixture cleanup left owned processes: ${remainingOwnedProcesses.join(',')}`)
    }
    for (const directory of [packageDir, consumerDir, workspaceDir, homeDir, dshHome, userDataDir]) {
      rmSync(directory, { recursive: true, force: true })
    }
  }
}

await main()
