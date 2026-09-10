/**
 * Maintained installed-dsh liveness proof for issue #271.
 *
 * Each case is an external bounded parent of a real Node24 dsh package child,
 * with a fresh private HOME/DSH_HOME/state directory. The dsh fixture starts a
 * real descendant so a direct-child-only cleanup cannot pass. No model,
 * provider, Chrome session, credential, or shared GoTry state is used.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { recordIncident, resolveIncidentsPath } from '../capabilities/incident-log.ts'
import {
  PROCESS_LIVENESS_BOUNDS,
  isOwnedProcessGroupEmpty,
  spawnOwnedChild,
  terminateOwnedChild,
} from '../../bin/gotry-process-liveness.js'

const require = createRequire(import.meta.url)
const dshBin = require.resolve('@deepseek-ai/dsh/lib/bin.js')
const dshVersion = JSON.parse(readFileSync(require.resolve('@deepseek-ai/dsh/package.json'), 'utf8')).version
const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const node24 = process.execPath
const EXTERNAL_BOUND_MS = 4_000

assert.equal(dshVersion, '0.1.5-alpha.1', 'proof must run against the lock-selected installed dsh package')

type CloseOutcome = { code: number | null; signal: NodeJS.Signals | null; error?: string }

function privateEnv(root: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: root,
    DSH_HOME: join(root, 'dsh-home'),
    TMPDIR: root,
    TEMP: root,
    TMP: root,
  }
}

function waitForClose(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<CloseOutcome | { timedOut: true }> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve({ timedOut: true })
    }, timeoutMs)
    child.once('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, signal })
    })
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: null, signal: null, error: error instanceof Error ? error.message : String(error) })
    })
  })
}

function withExternalBound<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} exceeded external ${timeoutMs}ms bound`)), timeoutMs)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`fixture readiness timeout: ${path}`)
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

function incidentLines(stateRoot: string): string[] {
  const path = resolveIncidentsPath(stateRoot)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').trim().split(/\r?\n/).filter(Boolean)
}

function writeFailureFixture(root: string, name: 'child-crash' | 'rejected-promise', marker: string, pidFile: string): string {
  const trigger = name === 'child-crash'
    ? "throw new Error('issue271-child-crash')"
    : "Promise.reject(new Error('issue271-rejected-promise'))"
  const plugin = join(root, `${name}.mjs`)
  writeFileSync(plugin, [
    "import { spawn } from 'node:child_process'",
    "import { writeFileSync } from 'node:fs'",
    `export const name = 'issue271-${name}'`,
    'export const inject = []',
    'export function apply() {',
    `  const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' })`,
    `  writeFileSync(${JSON.stringify(pidFile)}, String(descendant.pid))`,
    `  setTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'unsafe-continuation'), 250)`,
    `  ${trigger}`,
    '}',
    '',
  ].join('\n'))
  const patch = join(root, `${name}.patch.yml`)
  writeFileSync(patch, `- insert:\n    - id: issue271-${name}\n      name: '${plugin}'\n`)
  return patch
}

async function runDshFailureCase(name: 'child-crash' | 'rejected-promise'): Promise<Record<string, unknown>> {
  const root = mkdtempSync(join(tmpdir(), `gotry-271-${name}-`))
  const marker = join(root, 'unsafe.marker')
  const pidFile = join(root, 'descendant.pid')
  const patch = writeFailureFixture(root, name, marker, pidFile)
  const owned = spawnOwnedChild(node24, [dshBin, '--profile', 'sdk-minimal', '--patch', patch], {
    cwd: root,
    env: privateEnv(root),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  owned.child.stderr?.setEncoding('utf8')
  owned.child.stderr?.on('data', (chunk: string | Buffer) => { stderr += chunk.toString() })
  const outcome = await waitForClose(owned.child, EXTERNAL_BOUND_MS)
  if ('timedOut' in outcome) throw new Error(`${name} exceeded external ${EXTERNAL_BOUND_MS}ms bound`)
  const cleanup = await terminateOwnedChild({ child: owned.child, groupPid: owned.groupPid, ...PROCESS_LIVENESS_BOUNDS })
  await new Promise((resolve) => setTimeout(resolve, 350))
  const descendantPid = Number(readFileSync(pidFile, 'utf8'))
  assert.equal(outcome.code, 1, `${name} dsh child must exit 1: ${JSON.stringify(outcome)}`)
  assert.equal(outcome.signal, null, `${name} dsh child must not report a signal: ${JSON.stringify(outcome)}`)
  assert.match(stderr, new RegExp(`issue271-${name.replace('-', '[- ]')}`), `${name} must preserve dsh stderr evidence`)
  assert.equal(existsSync(marker), false, `${name} must not execute the post-failure marker`)
  assert.equal(pidAlive(descendantPid), false, `${name} descendant ${descendantPid} must be gone after bounded cleanup`)
  assert.equal(isOwnedProcessGroupEmpty(owned.groupPid), true, `${name} process group must be empty`)

  const stateRoot = join(root, 'state')
  assert.equal(recordIncident({
    ts: new Date().toISOString(),
    kind: 'plugin_error',
    message: `issue271 ${name}: child exit=${outcome.code} signal=${outcome.signal}`,
    source: 'issue271-liveness-test',
  }, stateRoot), true)
  const lines = incidentLines(stateRoot)
  assert.equal(lines.length, 1, `${name} incident evidence must be append-only and single-line`)
  assert.match(lines[0]!, new RegExp(`"message":"issue271 ${name}: child exit=1 signal=null"`))
  const result = { case: name, dshVersion, externalBoundMs: EXTERNAL_BOUND_MS, child: outcome, stderr: stderr.slice(-4_000), incidentLines: lines, descendantPid, cleanup }
  rmSync(root, { recursive: true, force: true })
  return result
}

async function runSpawnErrorCase(): Promise<Record<string, unknown>> {
  const root = mkdtempSync(join(tmpdir(), 'gotry-271-spawn-error-'))
  const ctx = new Context()
  const fiber = ctx.plugin(LocalSubprocessRuntime)
  await fiber
  const stateRoot = join(root, 'state')
  try {
    const handle = ctx.subprocess.spawn({
      argv: [join(root, 'missing-executable')],
      cwd: root,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1_024 }, stderr: { maxBytes: 4_096 } },
      graceMs: 100,
    })
    let errorMessage = ''
    await assert.rejects(withExternalBound(handle.done, EXTERNAL_BOUND_MS, 'spawn-error done'), (error: unknown) => {
      errorMessage = error instanceof Error ? error.message : String(error)
      return /ENOENT/.test(errorMessage)
    }, 'installed subprocess provider must preserve spawn ENOENT as a rejected done promise')
    assert.equal(await handle.waitForExit(AbortSignal.timeout(EXTERNAL_BOUND_MS)), true, 'spawn-error managed range must be empty')
    assert.equal(recordIncident({
      ts: new Date().toISOString(),
      kind: 'plugin_error',
      message: `issue271 spawn-error: ${errorMessage}`,
      source: 'issue271-liveness-test',
    }, stateRoot), true)
    const lines = incidentLines(stateRoot)
    assert.equal(lines.length, 1)
    assert.match(lines[0]!, /issue271 spawn-error: spawn .* ENOENT/)
    const result = { case: 'spawn-error', dshVersion, externalBoundMs: EXTERNAL_BOUND_MS, child: { exitCode: null, signal: null, doneRejected: true }, stderr: errorMessage, incidentLines: lines, managedRangeEmpty: true }
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
    return result
  } catch (error) {
    await ctx.fiber.dispose().catch(() => {})
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}

function writeSignalHost(root: string, signal: 'SIGINT' | 'SIGTERM', marker: string, pidFile: string): string {
  const helperUrl = pathToFileURL(join(repoRoot, 'bin/gotry-process-liveness.js')).href
  const host = join(root, `signal-host-${signal}.mjs`)
  writeFileSync(host, [
    `import { spawnOwnedChild, terminateOwnedChild, PROCESS_LIVENESS_BOUNDS } from ${JSON.stringify(helperUrl)}`,
    "import { existsSync, writeFileSync } from 'node:fs'",
    `const dsh = spawnOwnedChild(process.execPath, [${JSON.stringify(dshBin)}, '--profile', 'sdk-minimal', '--patch', ${JSON.stringify(join(root, 'signal.patch.yml'))}], { cwd: ${JSON.stringify(root)}, env: process.env, stdio: ['pipe', 'ignore', 'pipe'] })`,
    "dsh.child.stderr?.resume()",
    `let stopping = false; const onSignal = () => { if (stopping) return; stopping = true; void (async () => { await terminateOwnedChild({ child: dsh.child, groupPid: dsh.groupPid, signal: ${JSON.stringify(signal)}, ...PROCESS_LIVENESS_BOUNDS }); process.off(${JSON.stringify(signal)}, onSignal); process.kill(process.pid, ${JSON.stringify(signal)}) })() }; process.on(${JSON.stringify(signal)}, onSignal)`,
    `const deadline = Date.now() + ${EXTERNAL_BOUND_MS}`,
    `const ready = setInterval(() => { if (Date.now() > deadline) { clearInterval(ready); process.exit(124) }; try { if (existsSync(${JSON.stringify(pidFile)})) { clearInterval(ready); process.stdout.write('READY\\n'); setTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'unsafe-continuation'), 300) } } catch {} }, 20)`,
    '',
  ].join('\n'))
  return host
}

async function runParentSignalCase(signal: 'SIGINT' | 'SIGTERM'): Promise<Record<string, unknown>> {
  const root = mkdtempSync(join(tmpdir(), `gotry-271-${signal}-`))
  const marker = join(root, 'unsafe.marker')
  const pidFile = join(root, 'descendant.pid')
  const plugin = join(root, 'signal-plugin.mjs')
  writeFileSync(plugin, [
    "import { spawn } from 'node:child_process'",
    "import { writeFileSync } from 'node:fs'",
    "export const name = 'issue271-parent-signal'",
    'export const inject = []',
    'export function apply() {',
    `  const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' })`,
    `  writeFileSync(${JSON.stringify(pidFile)}, String(descendant.pid))`,
    '}',
    '',
  ].join('\n'))
  writeFileSync(join(root, 'signal.patch.yml'), `- insert:\n    - id: issue271-parent-signal\n      name: '${plugin}'\n`)
  const host = writeSignalHost(root, signal, marker, pidFile)
  const parent = spawn(node24, [host], { cwd: root, env: privateEnv(root), stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''; let stderr = ''
  parent.stdout?.setEncoding('utf8'); parent.stdout?.on('data', (chunk) => { stdout += chunk })
  parent.stderr?.setEncoding('utf8'); parent.stderr?.on('data', (chunk) => { stderr += chunk })
  await waitForFile(pidFile, EXTERNAL_BOUND_MS)
  process.kill(parent.pid!, signal)
  const outcome = await waitForClose(parent, EXTERNAL_BOUND_MS)
  if ('timedOut' in outcome) throw new Error(`${signal} parent exceeded external ${EXTERNAL_BOUND_MS}ms bound`)
  const descendantPid = Number(readFileSync(pidFile, 'utf8'))
  assert.equal(outcome.code, null, `${signal} parent must preserve signal termination: ${JSON.stringify(outcome)}`)
  assert.equal(outcome.signal, signal, `${signal} parent must report its original signal: ${JSON.stringify(outcome)}`)
  assert.match(stdout, /READY/, `${signal} case must observe a ready real dsh child`)
  assert.equal(existsSync(marker), false, `${signal} must not execute the post-failure marker`)
  assert.equal(pidAlive(descendantPid), false, `${signal} descendant ${descendantPid} must be gone`)

  const stateRoot = join(root, 'state')
  assert.equal(recordIncident({
    ts: new Date().toISOString(),
    kind: 'plugin_error',
    message: `issue271 parent signal=${signal}; parent exit=${outcome.code} signal=${outcome.signal}`,
    source: 'issue271-liveness-test',
  }, stateRoot), true)
  const lines = incidentLines(stateRoot)
  assert.equal(lines.length, 1)
  assert.match(lines[0]!, new RegExp(`parent signal=${signal}`))
  const result = { case: signal, dshVersion, externalBoundMs: EXTERNAL_BOUND_MS, parent: outcome, stdout, stderr: stderr.slice(-4_000), incidentLines: lines, descendantPid, processGroupEmpty: true }
  rmSync(root, { recursive: true, force: true })
  return result
}

const results = [
  await runDshFailureCase('child-crash'),
  await runDshFailureCase('rejected-promise'),
  await runSpawnErrorCase(),
  await runParentSignalCase('SIGINT'),
  await runParentSignalCase('SIGTERM'),
]
console.log(`ISSUE 271 LIVENESS: ${JSON.stringify(results)}`)
