/**
 * Dida runner command E2E for #502/#504.
 *
 * The child is the real session-dida-live-e2e.ts entry. Only the temporary
 * overlay's browser and session modules are synthetic; no supplier or browser
 * login is reachable from this test.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REAL_TS = join(import.meta.dirname, '..')
const TSX = process.env.GOTRY_TEST_TSX ?? join(REAL_TS, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const testNodeModules = join(TSX, '..', '..', '..')
const TMP_ROOT = realpathSync(tmpdir())
const baselineRef = process.env.DIDA502_BASELINE_REF ?? '20d728e3668d302821bad0f8687ca8ef55d29ed5'
const failures: string[] = []
const canonicalPlaywrightFiles = [
  join(testNodeModules, 'playwright-core', 'package.json'),
  join(testNodeModules, 'playwright-core', 'index.js'),
]
const canonicalPlaywrightHashes = new Map(canonicalPlaywrightFiles.map((path) => [path, sha256(path)]))
function expect(condition: boolean, label: string): void {
  if (!condition) {
    console.log(`FAIL ${label}`)
    failures.push(label)
  }
}

interface Overlay {
  base: string
  ts: string
  calls: string
  resets: string
  clicks: string
  results: string
  browserStarted: string
  browserClosed: string
  browserCloseSettled: string
  fakeBrowser: string
  net: string
}

function lines(path: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
  } catch {
    return []
  }
}

function buildOverlay(tag: string): Overlay {
  const base = mkdtempSync(join(TMP_ROOT, `gotry-dida502-${tag}-`))
  const ts = join(base, 'ts')
  mkdirSync(join(ts, 'scripts'), { recursive: true })
  mkdirSync(join(ts, 'capabilities'), { recursive: true })
  const calls = join(base, 'calls.jsonl')
  const resets = join(base, 'resets.jsonl')
  const clicks = join(base, 'clicks.jsonl')
  const results = join(base, 'results.jsonl')
  const browserStarted = join(base, 'browser-started')
  const browserClosed = join(base, 'browser-closed')
  const browserCloseSettled = join(base, 'browser-close-settled')
  const fakeBrowser = join(base, 'fake-browser')
  const net = join(base, 'network.jsonl')

  const runnerSource = process.env.DIDA502_RUN_BASELINE === '1'
    ? execFileSync('git', ['show', `${baselineRef}:ts/scripts/session-dida-live-e2e.ts`], { cwd: join(REAL_TS, '..'), encoding: 'utf8' })
    : readFileSync(join(REAL_TS, 'scripts', 'session-dida-live-e2e.ts'), 'utf8')
  writeFileSync(join(ts, 'scripts', 'session-dida-live-e2e.ts'), runnerSource)
  mkdirSync(join(ts, 'node_modules'), { recursive: true })
  mkdirSync(join(ts, 'node_modules', 'playwright-core'), { recursive: true })
  writeFileSync(join(ts, 'node_modules', 'playwright-core', 'package.json'), '{"type":"module","main":"index.js"}\n')
  writeFileSync(join(ts, 'node_modules', 'playwright-core', 'index.js'), `
import { appendFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
const event = (path, value) => { if (path) appendFileSync(path, JSON.stringify({ at: Date.now(), ...value }) + '\\n') }
const files = { browserStarted: ${JSON.stringify(browserStarted)}, clicks: ${JSON.stringify(clicks)}, browserClosed: ${JSON.stringify(browserClosed)}, browserCloseSettled: ${JSON.stringify(browserCloseSettled)} }
const evaluateMode = process.env.DIDA502_EVALUATE_MODE ?? 'missing'
const buttonPresent = process.env.DIDA502_BUTTON_PRESENT === '1'
let pendingHandle
let releasePendingEvaluate
const holdProcessOpen = () => { pendingHandle = setInterval(() => {}, 1000) }
const releaseProcessHold = () => { if (pendingHandle) { clearInterval(pendingHandle); pendingHandle = undefined } }
const button = {
  textContent: '预订',
  scrollIntoView() { event(files.clicks, { kind: 'scroll' }) },
  click() { event(files.clicks, { kind: 'click' }) },
}
const document = {
  querySelector(selector) {
    return selector === '.hotel-index-recommends-card__book-btn' && buttonPresent ? button : null
  },
  querySelectorAll(selector) {
    return selector === 'button' && buttonPresent ? [button] : []
  },
}
const jobPage = {
  current: 'https://portal.dida.com/hotel/job',
  url() { return this.current },
  async evaluate(source) {
    event(files.clicks, { kind: 'evaluate_attempt' })
    if (evaluateMode === 'pending-until-close') {
      holdProcessOpen()
      return new Promise((resolve) => {
        releasePendingEvaluate = () => {
          releaseProcessHold()
          event(files.browserClosed, { kind: 'pending-evaluate-released' })
          resolve(false)
        }
      })
    }
    if (evaluateMode === 'never') { holdProcessOpen(); return new Promise(() => {}) }
    return runInNewContext(String(source), { document })
  },
}
const loginPage = {
  current: 'about:blank',
  url() { return this.current },
  async goto(url) { this.current = url },
  async waitForSelector() {},
  async waitForURL() { this.current = 'https://portal.dida.com/hotel/home' },
  async evaluate() {},
}
const context = {
  serviceWorkers() { return [{}] },
  async newPage() { return loginPage },
  pages() { return [loginPage, jobPage] },
}
const browser = {
  contexts() { return [context] },
  async close() {
    event(files.browserClosed, { kind: 'close-start' })
    releasePendingEvaluate?.()
    if (process.env.DIDA502_BROWSER_CLOSE_MODE === 'hang') { holdProcessOpen(); return new Promise(() => {}) }
    event(files.browserCloseSettled, { kind: 'close-settled' })
  },
}
export const chromium = { async connectOverCDP() { appendFileSync(files.browserStarted, ''); return browser } }
`)
  writeFileSync(join(ts, 'capabilities', 'session-search.ts'), `
import { appendFileSync } from 'node:fs'
const log = (path, value) => { if (path) appendFileSync(path, JSON.stringify({ at: Date.now(), ...value }) + '\\n') }
const result = (verdict) => verdict === 'hit'
  ? { ok: true, via: 'session-dida-portal', evidence: '[synthetic:hit]', latencyMs: 1, verdict, rates: [{ hotelId: 'synthetic', hotelName: 'Synthetic Hotel', price: 100 }] }
  : { ok: false, via: 'session-dida-portal-error', evidence: '[synthetic:' + verdict + ']', latencyMs: 1, verdict, error: 'synthetic ' + verdict }
export async function sessionDidaSearch() {
  const calls = Number(process.env.DIDA502_CALLS ?? '0') + 1
  process.env.DIDA502_CALLS = String(calls)
  log(process.env.DIDA502_CALL_LOG, { call: calls })
  await new Promise((resolve) => setTimeout(resolve, 250))
  const verdict = process.env.DIDA502_VERDICT ?? 'challenged'
  log(process.env.DIDA502_RESULT_LOG, { call: calls, verdict, terminal: true })
  if (process.env.DIDA502_THROW === '1') throw new Error('synthetic session failure')
  return result(verdict)
}
export function __resetRateLimiterForTest() { log(process.env.DIDA502_RESET_LOG, { reset: true }) }
`)
  writeFileSync(join(ts, 'net-trap.mjs'), `import { appendFileSync } from 'node:fs'\nglobalThis.fetch = async (...args) => { appendFileSync(${JSON.stringify(net)}, JSON.stringify({ at: Date.now(), url: String(args[0]) }) + '\\n'); throw new Error('network blocked in dida502 E2E') }\n`)
  writeFileSync(join(ts, 'timer-preload.mjs'), `const native = globalThis.setTimeout\nglobalThis.setTimeout = (callback, delay, ...args) => native(callback, delay === 10000 || delay === 8000 ? 0 : delay === 5000 ? 200 : delay === 3000 ? 100 : delay === 2000 ? 100 : delay, ...args)\n`)
  writeFileSync(fakeBrowser, `#!/bin/sh\ntouch ${shellQuote(browserStarted)}\nexit 0\n`, { mode: 0o755 })
  chmodSync(fakeBrowser, 0o755)
  return { base, ts, calls, resets, clicks, results, browserStarted, browserClosed, browserCloseSettled, fakeBrowser, net }
}

interface RunOptions {
  evaluateMode?: 'missing' | 'pending-until-close' | 'never'
  buttonPresent?: boolean
  browserCloseMode?: 'normal' | 'hang'
}

function run(overlay: Overlay, verdict: string, options: RunOptions = {}): { status: number | null; stdout: string; stderr: string; error?: Error } {
  const child = spawnSync(process.execPath, [TSX, join(overlay.ts, 'scripts', 'session-dida-live-e2e.ts')], {
    cwd: overlay.ts,
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      ...process.env,
      CHROME_BIN: overlay.fakeBrowser,
      DIDA_USERNAME: 'synthetic-user',
      DIDA_PASSWORD: 'synthetic-pass',
      GOTRY_SESSION_LIVE: '1',
      DIDA502_CALL_LOG: overlay.calls,
      DIDA502_RESET_LOG: overlay.resets,
      DIDA502_RESULT_LOG: overlay.results,
      DIDA502_VERDICT: verdict,
      DIDA502_THROW: verdict === 'throw' ? '1' : '0',
      DIDA502_EVALUATE_MODE: options.evaluateMode ?? 'missing',
      DIDA502_BUTTON_PRESENT: options.buttonPresent === true ? '1' : '0',
      DIDA502_BROWSER_CLOSE_MODE: options.browserCloseMode ?? 'normal',
      NODE_OPTIONS: `--import=${join(overlay.ts, 'net-trap.mjs')} --import=${join(overlay.ts, 'timer-preload.mjs')}`,
    },
  })
  return { status: child.status, stdout: child.stdout ?? '', stderr: child.stderr ?? '', error: child.error }
}

const onlyCleanupCases = process.env.DIDA502_ONLY_CLEANUP_CASES === '1'

if (!onlyCleanupCases) for (const verdict of ['challenged', 'cooldown', 'needs-login', 'needs-extension', 'error', 'hit', 'throw']) {
  const overlay = buildOverlay(verdict)
  try {
    const failuresBefore = failures.length
    const runResult = run(overlay, verdict, { buttonPresent: verdict === 'hit' })
    const expectedExit = verdict === 'hit' ? 0 : verdict === 'throw' ? 1 : 2
    expect(runResult.status === expectedExit, `${verdict} exit=${runResult.status}: ${runResult.stderr}`)
    console.log(`observed ${verdict}: calls=${lines(overlay.calls).length} resets=${lines(overlay.resets).length} evaluate_attempts=${lines(overlay.clicks).filter((event) => event.kind === 'evaluate_attempt').length} clicks=${lines(overlay.clicks).filter((event) => event.kind === 'click').length} results=${lines(overlay.results).length}`)
    expect(lines(overlay.calls).length === 1, `${verdict} must call sessionDidaSearch once`)
    expect(lines(overlay.resets).length === 0, `${verdict} must not reset rate limiter`)
    const actions = lines(overlay.clicks)
    const evaluateAttempts = actions.filter((event) => event.kind === 'evaluate_attempt')
    const clickEvents = actions.filter((event) => event.kind === 'click')
    const resultEvents = lines(overlay.results)
    expect(evaluateAttempts.length >= 1, `${verdict} clickAssist must attempt DOM evaluation`)
    expect(clickEvents.length === (verdict === 'hit' ? 1 : 0), `${verdict} mock DOM click count=${clickEvents.length}`)
    expect(resultEvents.length === 1, `${verdict} must emit one final result`)
    expect(resultEvents.length === 1 && actions.every((event) => Number(event.at) <= Number(resultEvents[0]!.at)), `${verdict} has assistant DOM activity after result`)
    expect(existsSync(overlay.browserStarted), `${verdict} browser started`)
    expect(existsSync(overlay.browserClosed), `${verdict} browser cleanup`)
    expect(lines(overlay.net).length === 0, `${verdict} attempted network`)
    if (failures.length === failuresBefore) console.log(`ok ${verdict}: exit=${runResult.status} search=1 reset=0 evaluate_attempts=${evaluateAttempts.length} clicks=${clickEvents.length} cleanup=true`)
  } finally {
    if (process.env.DIDA502_KEEP_OVERLAY !== '1') rmSync(overlay.base, { recursive: true, force: true })
  }
}

if (!onlyCleanupCases) {
const gate = buildOverlay('gate')
try {
  for (const liveFlag of [undefined, '', '0', 'false', 'random']) {
    const failuresBefore = failures.length
    for (const path of [gate.browserStarted, gate.browserClosed, gate.browserCloseSettled, gate.calls, gate.net]) rmSync(path, { force: true })
    const env: NodeJS.ProcessEnv = { ...process.env, CHROME_BIN: gate.fakeBrowser, DIDA_USERNAME: 'synthetic-user', DIDA_PASSWORD: 'synthetic-pass', DIDA502_CALL_LOG: gate.calls, NODE_OPTIONS: `--import=${join(gate.ts, 'net-trap.mjs')}` }
    if (liveFlag === undefined) delete env.GOTRY_SESSION_LIVE
    else env.GOTRY_SESSION_LIVE = liveFlag
    const child = spawnSync(process.execPath, [TSX, join(gate.ts, 'scripts', 'session-dida-live-e2e.ts')], { cwd: gate.ts, encoding: 'utf8', timeout: 3_000, env })
    if (existsSync(gate.browserStarted) || child.status !== 1) console.log(`gate diagnostic ${liveFlag === '' ? 'empty' : liveFlag ?? 'unset'}: status=${child.status} stderr=${child.stderr}`)
    expect(child.status === 1, `live gate ${liveFlag === '' ? 'empty' : liveFlag ?? 'unset'} must reject before browser`)
    expect(!existsSync(gate.browserStarted), `live gate ${liveFlag === '' ? 'empty' : liveFlag ?? 'unset'} launched browser`)
    expect(!existsSync(gate.browserClosed), `live gate ${liveFlag === '' ? 'empty' : liveFlag ?? 'unset'} closed browser`)
    expect(lines(gate.calls).length === 0, `live gate ${liveFlag === '' ? 'empty' : liveFlag ?? 'unset'} called search`)
    expect(lines(gate.net).length === 0, `live gate ${liveFlag === '' ? 'empty' : liveFlag ?? 'unset'} attempted network`)
    if (failures.length === failuresBefore) console.log(`ok live gate ${liveFlag === '' ? 'empty' : liveFlag ?? 'unset'}: browser/network not started`)
  }
  const failuresBefore = failures.length
  for (const path of [gate.browserStarted, gate.browserClosed, gate.browserCloseSettled, gate.calls, gate.net]) rmSync(path, { force: true })
  const missing = spawnSync(process.execPath, [TSX, join(gate.ts, 'scripts', 'session-dida-live-e2e.ts')], { cwd: gate.ts, encoding: 'utf8', timeout: 3_000, env: { ...process.env, GOTRY_SESSION_LIVE: '1', DIDA_USERNAME: '', DIDA_PASSWORD: '', CHROME_BIN: gate.fakeBrowser, DIDA502_CALL_LOG: gate.calls, NODE_OPTIONS: `--import=${join(gate.ts, 'net-trap.mjs')}` } })
  expect(missing.status === 1, 'missing credentials must reject before browser')
  expect(!existsSync(gate.browserStarted), 'missing credentials launched browser')
  expect(!existsSync(gate.browserClosed), 'missing credentials closed browser')
  expect(lines(gate.calls).length === 0, 'missing credentials called search')
  expect(lines(gate.net).length === 0, 'missing credentials attempted network')
  if (failures.length === failuresBefore) console.log('ok live gate missing credentials: browser/network not started')
} finally {
  if (process.env.DIDA502_KEEP_OVERLAY !== '1') rmSync(gate.base, { recursive: true, force: true })
}
}

const cleanupCases: Array<{
  tag: string
  evaluateMode: RunOptions['evaluateMode']
  buttonPresent: boolean
  browserCloseMode: RunOptions['browserCloseMode']
  expectedExit: number
  timeoutLabel?: string
}> = [
  {
    tag: 'pending-evaluate-released-by-close',
    evaluateMode: 'pending-until-close',
    buttonPresent: false,
    browserCloseMode: 'normal',
    expectedExit: 2,
  },
  {
    tag: 'never-settling-evaluate',
    evaluateMode: 'never',
    buttonPresent: false,
    browserCloseMode: 'normal',
    expectedExit: 1,
    timeoutLabel: 'click assistance',
  },
  {
    tag: 'browser-close-hangs',
    evaluateMode: 'missing',
    buttonPresent: true,
    browserCloseMode: 'hang',
    expectedExit: 1,
    timeoutLabel: 'browser close',
  },
]
const selectedCleanupCase = process.env.DIDA502_CLEANUP_CASE
for (const cleanupCase of cleanupCases.filter(({ tag }) => !selectedCleanupCase || tag === selectedCleanupCase)) {
  const overlay = buildOverlay(cleanupCase.tag)
  try {
    const failuresBefore = failures.length
    const runResult = run(overlay, 'challenged', cleanupCase)
    const combinedOutput = `${runResult.stdout}\n${runResult.stderr}\n${runResult.error?.message ?? ''}`
    const closeEvents = lines(overlay.browserClosed)
    console.log(`observed ${cleanupCase.tag}: exit=${runResult.status} browser_started=${existsSync(overlay.browserStarted)} close_events=${closeEvents.map((event) => event.kind).join(',') || 'none'} close_settled=${existsSync(overlay.browserCloseSettled)} timeout_label=${cleanupCase.timeoutLabel ?? 'none'}`)
    expect(runResult.status === cleanupCase.expectedExit, `${cleanupCase.tag} exit=${runResult.status}: ${combinedOutput}`)
    expect(existsSync(overlay.browserStarted), `${cleanupCase.tag} browser started`)
    expect(existsSync(overlay.browserClosed), `${cleanupCase.tag} browser close invoked`)
    expect(lines(overlay.net).length === 0, `${cleanupCase.tag} attempted network`)
    if (cleanupCase.expectedExit === 2) {
      expect(lines(overlay.results).length === 1, `${cleanupCase.tag} must emit one final result`)
      expect(closeEvents.some((event) => event.kind === 'pending-evaluate-released'), `${cleanupCase.tag} pending evaluate released by close`)
      expect(existsSync(overlay.browserCloseSettled), `${cleanupCase.tag} browser close settled`)
    } else {
      expect(cleanupCase.timeoutLabel !== undefined && combinedOutput.includes(`cleanup timeout: ${cleanupCase.timeoutLabel}`), `${cleanupCase.tag} explicit timeout label=${cleanupCase.timeoutLabel}`)
    }
    if (failures.length === failuresBefore) console.log(`ok ${cleanupCase.tag}: exit=${runResult.status} browser_started=true close_invoked=true`)
  } finally {
    if (process.env.DIDA502_KEEP_OVERLAY !== '1') rmSync(overlay.base, { recursive: true, force: true })
  }
}

for (const path of canonicalPlaywrightFiles) expect(sha256(path) === canonicalPlaywrightHashes.get(path), `canonical dependency changed: ${path}`)
if (failures.length > 0) throw new Error(`DIDA RUNNER STOP E2E failed: ${failures.join('; ')}`)
console.log(`DIDA RUNNER STOP E2E: ${onlyCleanupCases ? '3 cleanup cases' : '7 verdicts (including thrown error) + strict live gate + 3 cleanup cases'} passed with synthetic browser/session overlay`)

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}
