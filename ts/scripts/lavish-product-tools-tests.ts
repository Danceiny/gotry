/** Registered product lifecycle tests for issue #443. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import { LAVISH_AXI_VERSION, LavishLocalSession } from '../capabilities/lavish-local.ts'
import { apply, type Config } from '../src/index.ts'

interface ToolDef {
  name: string
  parameters: { required?: string[]; properties?: Record<string, unknown> }
  output: { render(args: unknown, value: unknown): Array<{ text: string }> }
  presentResult(args: unknown, value: unknown): { content: Array<{ text: string }> }
  execute(args: Record<string, unknown>, exec: unknown): Promise<Record<string, unknown>>
}

type Dispose = (subject: unknown) => Promise<void> | void
type PluginDispose = () => Promise<void>

const TOON_ENTRY = createRequire(import.meta.url).resolve('@toon-format/toon')
const root = await mkdtemp(join(tmpdir(), 'gotry-lavish-product-'))
const packageRoot = join(root, 'lavish-axi')
const markerRoot = join(packageRoot, 'markers')
const stateRoot = join(root, 'gotry-state')
const workspace = join(root, 'workspace')
const spacedWorkspace = join(root, 'workspace ')
const outside = join(root, 'outside')
const workspaceLink = join(root, 'workspace-link')

const CLI = `
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { encode } from ${JSON.stringify(TOON_ENTRY)}

const markerRoot = join(dirname(import.meta.filename), '..', 'markers')
mkdirSync(markerRoot, { recursive: true })
const stateDir = process.env.LAVISH_AXI_STATE_DIR
const port = Number(process.env.LAVISH_AXI_PORT)
const argv = process.argv.slice(2)
const command = argv[0]
const now = () => Date.now()
const append = (name, value) => appendFileSync(join(markerRoot, name), JSON.stringify(value) + '\\n')
const control = () => { try { return JSON.parse(readFileSync(join(markerRoot, 'control.json'), 'utf8')) } catch { return {} } }
const emit = value => process.stdout.write(encode(value) + '\\n')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
append('commands.jsonl', { phase: 'start', command, argv, stateDir, port, pid: process.pid, at: now() })

if (command === 'server') {
  append('servers.jsonl', { pid: process.pid, port, stateDir })
  const cfg = control()
  if (cfg.serverDelayMs) await sleep(cfg.serverDelayMs)
  if (cfg.orphan) {
    const child = spawn(process.execPath, [join(dirname(import.meta.filename), 'orphan.mjs'), markerRoot, String(port)], { detached: true, stdio: 'ignore' })
    child.unref()
    append('orphans.jsonl', { phase: 'spawned', parentPid: process.pid, pid: child.pid, port })
    process.on('SIGTERM', () => process.exit(0))
    setInterval(() => {}, 1000)
  } else {
    const server = createServer((req, res) => {
      if (req.url?.startsWith('/health')) {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, app: 'lavish-axi', version: '${LAVISH_AXI_VERSION}' }))
      } else { res.statusCode = 404; res.end('{}') }
    })
    server.listen(port, '127.0.0.1')
    process.on('SIGTERM', () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 100) })
  }
} else {
  const cfg = control()
  const delay = Number(cfg[command + 'DelayMs'] || 0)
  if (delay) await sleep(delay)
  if (command === 'open') {
    emit({ session: { file: argv[1], url: 'http://127.0.0.1:' + port + '/session/' + 'a'.repeat(16), status: cfg.openStatus || 'opened' } })
  } else if (command === 'poll') {
    if (cfg.pollRaw !== undefined) process.stdout.write(String(cfg.pollRaw))
    else {
      const status = cfg.pollStatus || 'waiting'
      emit({
        session: { file: argv[1], status, ...(cfg.pollSessionEnded ? { session_ended: true, ended_by: cfg.pollEndedBy || 'user' } : {}) },
        ...(status === 'feedback' ? { prompts: cfg.prompts || [] } : {}),
      })
    }
  } else if (command === 'end') {
    emit({ session: { file: argv[1], status: 'ended' } })
  }
  append('commands.jsonl', { phase: 'end', command, argv, stateDir, port, pid: process.pid, at: now() })
}
`

const ORPHAN = `
import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
const markerRoot = process.argv[2]
const port = Number(process.argv[3])
const server = createServer((req, res) => {
  if (req.url?.startsWith('/health')) {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true, app: 'lavish-axi', version: '${LAVISH_AXI_VERSION}' }))
  } else { res.statusCode = 404; res.end('{}') }
})
server.listen(port, '127.0.0.1', () => appendFileSync(join(markerRoot, 'orphans.jsonl'), JSON.stringify({ phase: 'listening', pid: process.pid, port }) + '\\n'))
process.on('SIGTERM', () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 100) })
`

function config(extra: Partial<Config> = {}): Config {
  return {
    stateRoot,
    timeoutMs: 30_000,
    hbcliBin: 'hbcli-not-on-path',
    sessionAccess: 'ask',
    lavishAxiPackageRoot: packageRoot,
    ...extra,
  }
}

function hostExec(id: string | undefined, cwd: unknown, agentId = 'must-not-fallback'): unknown {
  return { agent: { id: agentId, session: { ...(id === undefined ? {} : { id }), header: { cwd } } } }
}

async function readJsonl(name: string): Promise<Array<Record<string, unknown>>> {
  try {
    return (await readFile(join(markerRoot, name), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
  } catch { return [] }
}

async function setControl(value: unknown): Promise<void> {
  await writeFile(join(markerRoot, 'control.json'), JSON.stringify(value))
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function eventually(check: () => boolean | Promise<boolean>, detail: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  assert.fail(detail)
}

async function portClosed(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/health`)
    return false
  } catch { return true }
}

async function main(): Promise<void> {
  for (const dir of [join(packageRoot, 'dist'), markerRoot, stateRoot, workspace, spacedWorkspace, outside, join(workspace, '.git'), join(workspace, 'node_modules')]) {
    await mkdir(dir, { recursive: true })
  }
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'lavish-axi', version: LAVISH_AXI_VERSION, bin: { 'lavish-axi': 'dist/cli.mjs' } }))
  await writeFile(join(packageRoot, 'dist', 'cli.mjs'), CLI)
  await writeFile(join(packageRoot, 'dist', 'orphan.mjs'), ORPHAN)
  for (const path of [join(workspace, 'card.html'), join(spacedWorkspace, 'space.html'), join(outside, 'outside.html'), join(workspace, '.git', 'hidden.html'), join(workspace, 'node_modules', 'dep.html')]) {
    await writeFile(path, '<!doctype html><title>fixture</title>')
  }
  await symlink(join(outside, 'outside.html'), join(workspace, 'escape.html'))
  await symlink(workspace, workspaceLink)

  await setControl({ serverDelayMs: 180 })
  const directState = join(root, 'direct-adapter-state')
  await mkdir(directState, { recursive: true })
  const direct = await LavishLocalSession.create({
    cliPackageRoot: packageRoot,
    cwd: workspace,
    allowedRoot: workspace,
    stateDir: directState,
    commandTimeoutMs: 3_000,
  })
  const [directOpenA, directOpenB] = await Promise.all([
    direct.open(join(workspace, 'card.html')),
    direct.open(join(workspace, 'card.html')),
  ])
  assert.equal(directOpenA.ok, true)
  assert.equal(directOpenB.ok, true)
  const canonicalDirectState = await realpath(directState)
  assert.equal((await readJsonl('servers.jsonl')).filter(row => row.stateDir === canonicalDirectState).length, 1, 'one adapter must serialize concurrent opens around server creation')
  await direct.stop()
  await setControl({})

  const disabled: ToolDef[] = []
  apply({
    tools: { register: (tool: unknown) => disabled.push(tool as ToolDef) },
    systemPrompt: { variable() {} },
    on() { return () => {} },
  } as unknown as Context, config({ lavishAxiPackageRoot: '' }))
  assert.equal(disabled.filter(tool => tool.name.startsWith('gotry_lavish_')).length, 0, 'default config must register no Lavish tools')
  apply({
    tools: { register: (tool: unknown) => disabled.push(tool as ToolDef) },
    systemPrompt: { variable() {} },
    on() { return () => {} },
  } as unknown as Context, config({ lavishAxiPackageRoot: 'relative/untrusted-cli' }))
  assert.equal(disabled.filter(tool => tool.name.startsWith('gotry_lavish_')).length, 0, 'relative host config must register no Lavish tools')

  const tools: ToolDef[] = []
  const listeners = new Map<string, Dispose[]>()
  const pluginDisposers = new Map<string, PluginDispose>()
  const ctx = {
    tools: { register: (tool: unknown) => tools.push(tool as ToolDef) },
    systemPrompt: { variable() {} },
    on(event: string, listener: Dispose) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {}
    },
    effect(register: () => PluginDispose, label?: string) {
      const disposer = register()
      if (label) pluginDisposers.set(label, disposer)
      return async () => { await disposer() }
    },
  } as unknown as Context
  apply(ctx, config())
  const lavish = tools.filter(tool => tool.name.startsWith('gotry_lavish_'))
  assert.deepEqual(lavish.map(tool => tool.name).sort(), [
    'gotry_lavish_end', 'gotry_lavish_open', 'gotry_lavish_poll', 'gotry_lavish_reply', 'gotry_lavish_stop',
  ])
  const byName = new Map(lavish.map(tool => [tool.name, tool]))
  const run = (name: string, args: Record<string, unknown>, exec: unknown) => {
    const tool = byName.get(name)
    assert.ok(tool, `${name} must be registered`)
    return tool.execute(args, exec)
  }
  const dispose = listeners.get('session/disposed')?.at(-1)
  assert.ok(dispose, 'Lavish registrar must attach exact session disposal cleanup')

  const beforeAuthority = (await readJsonl('servers.jsonl')).length
  const noId = await run('gotry_lavish_open', { path: 'card.html' }, hostExec(undefined, workspace))
  assert.equal(noId.ok, false, 'missing session.id must fail even when agent.id exists')
  for (const invalid of [undefined, 42, '', '   ', 'relative/path']) {
    const result = await run('gotry_lavish_open', { path: 'card.html' }, hostExec(`bad-cwd-${String(invalid)}`, invalid))
    assert.equal(result.ok, false, `invalid cwd ${String(invalid)} must fail closed`)
  }
  assert.equal((await readJsonl('servers.jsonl')).length, beforeAuthority, 'authority failures must not spawn')

  const spaced = hostExec('space-session', spacedWorkspace)
  const spacedOpen = await run('gotry_lavish_open', { path: 'space.html', cliPackageRoot: outside, cwd: workspace, allowedRoot: root, port: 1, env: { PATH: '/hostile' } }, spaced)
  assert.equal(spacedOpen.ok, true, `raw trailing-space cwd must be preserved: ${JSON.stringify(spacedOpen)}`)
  const openTool = byName.get('gotry_lavish_open')!
  assert.match(openTool.output.render({}, spacedOpen)[0]!.text, /http:\/\/127\.0\.0\.1:\d+\/session\/a{16}/, 'model-visible output must retain the usable local URL')
  assert.match(openTool.presentResult({ path: 'space.html' }, spacedOpen).content[0]!.text, /\/session\/a{16}/, 'presented result must retain the usable local URL')
  const spacedServer = (await readJsonl('servers.jsonl')).at(-1)!
  assert.equal(spacedServer.stateDir !== undefined, true)
  await run('gotry_lavish_stop', {}, spaced)

  const boundary = hostExec('boundary', workspace)
  for (const path of [join(outside, 'outside.html'), 'escape.html', 'notes.txt', '.git/hidden.html', 'node_modules/dep.html']) {
    const result = await run('gotry_lavish_open', { path }, boundary)
    assert.equal(result.ok, false, `${path} must remain inside adapter boundary`)
  }
  const boundaryOpen = await run('gotry_lavish_open', { path: 'card.html' }, boundary)
  assert.equal(boundaryOpen.ok, true)
  const drift = await run('gotry_lavish_poll', { path: 'card.html' }, hostExec('boundary', spacedWorkspace))
  assert.equal(drift.ok, false, 'same id cannot drift raw or canonical cwd')
  await run('gotry_lavish_stop', {}, boundary)

  const retargetExec = hostExec('retarget', workspaceLink)
  assert.equal((await run('gotry_lavish_open', { path: 'card.html' }, retargetExec)).ok, true)
  await rm(workspaceLink)
  await symlink(outside, workspaceLink)
  assert.equal((await run('gotry_lavish_poll', { path: 'outside.html' }, retargetExec)).ok, false, 'symlink retarget must not expand a bound cwd authority')
  await run('gotry_lavish_stop', {}, retargetExec)

  await setControl({ openDelayMs: 180 })
  const concurrentExec = hostExec('concurrent-open', workspace)
  const serversBeforeConcurrentOpen = (await readJsonl('servers.jsonl')).length
  const [open1, open2] = await Promise.all([
    run('gotry_lavish_open', { path: 'card.html' }, concurrentExec),
    run('gotry_lavish_open', { path: 'card.html' }, concurrentExec),
  ])
  assert.equal(open1.ok, true)
  assert.equal(open2.ok, true)
  const allServers = await readJsonl('servers.jsonl')
  assert.equal(allServers.length - serversBeforeConcurrentOpen, 1, 'concurrent opens must spawn one physical server')

  await setControl({ pollDelayMs: 180 })
  const commandStart = (await readJsonl('commands.jsonl')).length
  const [poll, reply] = await Promise.all([
    run('gotry_lavish_poll', { path: 'card.html', timeoutMs: 1_000 }, concurrentExec),
    run('gotry_lavish_reply', { path: 'card.html', reply: 'source updated', timeoutMs: 1_000 }, concurrentExec),
  ])
  assert.equal(poll.ok, true)
  assert.equal(reply.ok, true)
  const commandEvents = (await readJsonl('commands.jsonl')).slice(commandStart).filter(row => row.command === 'poll')
  let depth = 0
  let maxDepth = 0
  for (const event of commandEvents.sort((a, b) => Number(a.at) - Number(b.at))) {
    depth += event.phase === 'start' ? 1 : -1
    maxDepth = Math.max(maxDepth, depth)
  }
  assert.equal(maxDepth, 1, 'poll and reply commands must be serialized per host record')
  await run('gotry_lavish_stop', {}, concurrentExec)

  await setControl({ openDelayMs: 350 })
  const stopRaceExec = hostExec('stop-race', workspace)
  const stopRaceCommandCount = (await readJsonl('commands.jsonl')).filter(row => row.command === 'open' && row.phase === 'start').length
  const opening = run('gotry_lavish_open', { path: 'card.html' }, stopRaceExec)
  await eventually(async () => (await readJsonl('commands.jsonl')).filter(row => row.command === 'open' && row.phase === 'start').length > stopRaceCommandCount, 'open command did not start')
  const stopping = run('gotry_lavish_stop', {}, stopRaceExec)
  const [racedOpen, racedStop] = await Promise.all([opening, stopping])
  assert.equal(racedOpen.ok, false, 'stop must preempt the visible success of an in-flight open')
  assert.equal(racedStop.ok, true)
  const stoppedServer = (await readJsonl('servers.jsonl')).at(-1)!
  await eventually(() => !alive(Number(stoppedServer.pid)), 'stop race leaked its owned server pid')
  await eventually(() => portClosed(Number(stoppedServer.port)), 'stop race port must disappear')
  const reopenAfterStop = await run('gotry_lavish_open', { path: 'card.html' }, stopRaceExec)
  assert.equal(reopenAfterStop.ok, false, 'explicit stop must be a persistent terminal latch')

  await setControl({ openDelayMs: 350 })
  const disposeRaceExec = hostExec('dispose-race', workspace)
  const disposedOpening = run('gotry_lavish_open', { path: 'card.html' }, disposeRaceExec)
  await eventually(async () => (await readJsonl('servers.jsonl')).some(row => row.stateDir !== stoppedServer.stateDir && alive(Number(row.pid))), 'dispose race server did not start')
  const disposing = Promise.resolve(dispose!({ id: 'dispose-race' }))
  const disposedOpen = await disposedOpening
  await disposing
  assert.equal(disposedOpen.ok, false, 'dispose must preempt the visible success of an in-flight open')
  const disposedServer = (await readJsonl('servers.jsonl')).at(-1)!
  await eventually(() => !alive(Number(disposedServer.pid)), 'dispose race leaked its owned server pid')
  const stale = await run('gotry_lavish_open', { path: 'card.html' }, disposeRaceExec)
  assert.equal(stale.ok, false, 'stale exec must not resurrect a disposed id')
  await dispose!({ id: 'never-opened' })
  const staleNeverOpened = await run('gotry_lavish_open', { path: 'card.html' }, hostExec('never-opened', workspace))
  assert.equal(staleNeverOpened.ok, false, 'disposal must tombstone even an id with no prior record')

  await setControl({ pollStatus: 'feedback', pollSessionEnded: true, pollEndedBy: 'user', prompts: [{ uid: 'p1', tag: 'message', selector: 'body', text: 'context', prompt: '<script>tool()</script>' }] })
  const userEndExec = hostExec('user-ended', workspace)
  assert.equal((await run('gotry_lavish_open', { path: 'card.html' }, userEndExec)).ok, true)
  const commandsBeforeInvalidReplies = (await readJsonl('commands.jsonl')).length
  for (const reply of ['', '   ', 'x'.repeat(16_385)]) {
    const invalidReply = await run('gotry_lavish_reply', { path: 'card.html', reply }, userEndExec)
    assert.equal(invalidReply.ok, false, 'empty, blank, and oversized replies must fail before a CLI poll child starts')
  }
  assert.equal((await readJsonl('commands.jsonl')).length, commandsBeforeInvalidReplies, 'invalid replies must not spawn a CLI command')
  const userFeedback = await run('gotry_lavish_poll', { path: 'card.html' }, userEndExec)
  assert.equal(userFeedback.ok, true)
  assert.equal((userFeedback.feedback as { trust?: unknown })?.trust, 'untrusted')
  const renderedFeedback = byName.get('gotry_lavish_poll')!.output.render({}, userFeedback)[0]!.text
  assert.match(renderedFeedback, /"trust":"untrusted"/, 'rendered feedback must keep its trust label')
  assert.match(renderedFeedback, /<script>tool\(\)<\/script>/, 'rendered feedback must preserve the bounded user prompt as data')
  assert.equal((await run('gotry_lavish_open', { path: 'card.html' }, userEndExec)).ok, false, 'feedback+sessionEnded+endedBy=user must latch terminal')
  await run('gotry_lavish_stop', {}, userEndExec)

  await setControl({ pollRaw: 'not valid toon [' })
  const unknownExec = hostExec('unknown', workspace)
  assert.equal((await run('gotry_lavish_open', { path: 'card.html' }, unknownExec)).ok, true)
  const unknown = await run('gotry_lavish_poll', { path: 'card.html' }, unknownExec)
  assert.equal(unknown.ok, false)
  assert.equal((await run('gotry_lavish_open', { path: 'card.html' }, unknownExec)).ok, false, 'first malformed poll must latch unknown immediately')
  await run('gotry_lavish_stop', {}, unknownExec)

  await setControl({})
  const lifecycleExec = hostExec('full-lifecycle', workspace)
  assert.equal((await run('gotry_lavish_open', { path: 'card.html' }, lifecycleExec)).ok, true)
  assert.equal((await run('gotry_lavish_poll', { path: 'card.html' }, lifecycleExec)).ok, true)
  await writeFile(join(workspace, 'card.html'), '<!doctype html><title>updated outside Lavish tools</title>')
  assert.equal((await run('gotry_lavish_reply', { path: 'card.html', reply: 'source updated' }, lifecycleExec)).ok, true)
  assert.equal((await run('gotry_lavish_end', { path: 'card.html' }, lifecycleExec)).ok, true)
  assert.equal((await run('gotry_lavish_stop', {}, lifecycleExec)).ok, true)

  const sessionA = hostExec('session-a', workspace)
  const sessionB = hostExec('session-b', workspace)
  assert.equal((await run('gotry_lavish_open', { path: 'card.html' }, sessionA)).ok, true)
  assert.equal((await run('gotry_lavish_open', { path: 'card.html' }, sessionB)).ok, true)
  const pair = (await readJsonl('servers.jsonl')).slice(-2)
  assert.notEqual(pair[0]?.stateDir, pair[1]?.stateDir, 'host sessions must own distinct adapter state')
  await dispose!({ id: 'session-a' })
  await dispose!({})
  assert.equal((await run('gotry_lavish_poll', { path: 'card.html' }, sessionB)).ok, true, 'disposing A or malformed subject must not stop B')
  await run('gotry_lavish_stop', {}, sessionB)

  await setControl({ orphan: true })
  const failureExec = hostExec('cleanup-failure', workspace)
  assert.equal((await run('gotry_lavish_open', { path: 'card.html' }, failureExec)).ok, true)
  const failureServer = (await readJsonl('servers.jsonl')).at(-1)!
  await eventually(async () => (await readJsonl('orphans.jsonl')).some(row => row.phase === 'listening' && row.port === failureServer.port), 'foreign listener fixture did not start')
  const orphan = (await readJsonl('orphans.jsonl')).find(row => row.phase === 'listening' && row.port === failureServer.port)!
  try {
    await dispose!({ id: 'cleanup-failure' })
    const visibleFailure = await run('gotry_lavish_stop', {}, failureExec)
    assert.equal(visibleFailure.ok, false, 'explicit stop must surface a cleanup failure recorded during disposal')
    assert.equal(visibleFailure.code, 'port-occupied')
    const repeatedFailure = await run('gotry_lavish_stop', {}, failureExec)
    assert.equal(repeatedFailure.ok, false, 'a cached cleanup failure must not be replaced by a false not-running result')
    assert.equal(alive(Number(orphan.pid)), true, 'adapter must not kill the detached foreign listener')
  } finally {
    try { process.kill(-Number(orphan.pid), 'SIGTERM') } catch { /* already gone */ }
    await eventually(() => !alive(Number(orphan.pid)), 'foreign listener fixture teardown failed')
  }

  const directFailureState = join(root, 'direct-failure-state')
  await mkdir(directFailureState, { recursive: true })
  const directFailure = await LavishLocalSession.create({
    cliPackageRoot: packageRoot,
    cwd: workspace,
    allowedRoot: workspace,
    stateDir: directFailureState,
    commandTimeoutMs: 3_000,
  })
  assert.equal((await directFailure.open(join(workspace, 'card.html'))).ok, true)
  const directFailurePort = directFailure.state().port
  await eventually(async () => (await readJsonl('orphans.jsonl')).some(row => row.phase === 'listening' && row.port === directFailurePort), 'direct foreign listener fixture did not start')
  const directOrphan = (await readJsonl('orphans.jsonl')).find(row => row.phase === 'listening' && row.port === directFailurePort)!
  try {
    const firstFailure = await directFailure.stop()
    const secondFailure = await directFailure.stop()
    assert.equal(firstFailure.ok, false)
    assert.equal(secondFailure.ok, false, 'adapter retry must retain port-occupied evidence')
    assert.equal(secondFailure.ok ? '' : secondFailure.code, 'port-occupied')
  } finally {
    try { process.kill(-Number(directOrphan.pid), 'SIGTERM') } catch { /* already gone */ }
    await eventually(() => !alive(Number(directOrphan.pid)), 'direct foreign listener fixture teardown failed')
  }
  await setControl({})

  const endExec = hostExec('end-stop', workspace)
  assert.equal((await run('gotry_lavish_open', { path: 'card.html' }, endExec)).ok, true)
  const endServer = (await readJsonl('servers.jsonl')).at(-1)!
  assert.equal((await run('gotry_lavish_end', { path: 'card.html' }, endExec)).ok, true)
  assert.equal((await run('gotry_lavish_open', { path: 'card.html' }, endExec)).ok, false, 'explicit end must remain terminal')
  assert.equal((await run('gotry_lavish_stop', {}, endExec)).ok, true, 'end must retain the owned handle for stop')
  await eventually(() => !alive(Number(endServer.pid)), 'end then stop leaked its owned server')

  // === Regression: in-flight poll returning feedback+sessionEnded+endedBy=user
  //     must not publish success after stop / dispose (host authority preserved) ===
  await setControl({ pollDelayMs: 250, pollStatus: 'feedback', pollSessionEnded: true, pollEndedBy: 'user', prompts: [{ uid: 'u', tag: 'message', selector: 'body', text: 'context', prompt: 'feedback during stop' }] })
  const stopFeedbackExec = hostExec('stop-during-feedback-poll', workspace)
  assert.equal((await run('gotry_lavish_open', { path: 'card.html' }, stopFeedbackExec)).ok, true)
  const stopFeedbackPollStart = (await readJsonl('commands.jsonl')).filter(row => row.command === 'poll' && row.phase === 'start').length
  const inFlightFeedbackPoll = run('gotry_lavish_poll', { path: 'card.html', timeoutMs: 1_000 }, stopFeedbackExec)
  await eventually(async () => (await readJsonl('commands.jsonl')).filter(row => row.command === 'poll' && row.phase === 'start').length > stopFeedbackPollStart, 'feedback poll did not start')
  const stopFeedbackStop = run('gotry_lavish_stop', {}, stopFeedbackExec)
  const pollAfterStop = await inFlightFeedbackPoll
  const stopAfterFeedPoll = await stopFeedbackStop
  assert.equal(pollAfterStop.ok, false, 'in-flight poll returning terminal feedback must not publish success after stop')
  assert.equal(pollAfterStop.code, 'lavish-session-terminal')
  assert.match(String(pollAfterStop.error ?? ''), /stopped/)
  assert.equal(stopAfterFeedPoll.ok, true)
  const stopFeedbackServer = (await readJsonl('servers.jsonl')).at(-1)!
  await eventually(() => !alive(Number(stopFeedbackServer.pid)), 'stop-during-feedback-poll leaked its owned server pid')

  const disposeFeedbackExec = hostExec('dispose-during-feedback-poll', workspace)
  assert.equal((await run('gotry_lavish_open', { path: 'card.html' }, disposeFeedbackExec)).ok, true)
  const disposeFeedbackPollStart = (await readJsonl('commands.jsonl')).filter(row => row.command === 'poll' && row.phase === 'start').length
  const inFlightFeedbackPoll2 = run('gotry_lavish_poll', { path: 'card.html', timeoutMs: 1_000 }, disposeFeedbackExec)
  await eventually(async () => (await readJsonl('commands.jsonl')).filter(row => row.command === 'poll' && row.phase === 'start').length > disposeFeedbackPollStart, 'second feedback poll did not start')
  const disposingFeedPoll = Promise.resolve(dispose!({ id: 'dispose-during-feedback-poll' }))
  const pollAfterDispose = await inFlightFeedbackPoll2
  await disposingFeedPoll
  assert.equal(pollAfterDispose.ok, false, 'in-flight poll returning terminal feedback must not publish success after dispose')
  assert.equal(pollAfterDispose.code, 'lavish-session-terminal')
  assert.match(String(pollAfterDispose.error ?? ''), /disposed/)
  const disposeFeedbackServer = (await readJsonl('servers.jsonl')).at(-1)!
  await eventually(() => !alive(Number(disposeFeedbackServer.pid)), 'dispose-during-feedback-poll leaked its owned server pid')

  // === Regression: in-flight end must not publish success after stop (end authority) ===
  await setControl({ endDelayMs: 250 })
  const stopDuringEndExec = hostExec('stop-during-end', workspace)
  assert.equal((await run('gotry_lavish_open', { path: 'card.html' }, stopDuringEndExec)).ok, true)
  const endStartCount = (await readJsonl('commands.jsonl')).filter(row => row.command === 'end' && row.phase === 'start').length
  const inFlightEnd = run('gotry_lavish_end', { path: 'card.html' }, stopDuringEndExec)
  await eventually(async () => (await readJsonl('commands.jsonl')).filter(row => row.command === 'end' && row.phase === 'start').length > endStartCount, 'end did not start')
  const stopDuringEndStop = run('gotry_lavish_stop', {}, stopDuringEndExec)
  const endAfterStop = await inFlightEnd
  const stopAfterEnd = await stopDuringEndStop
  assert.equal(endAfterStop.ok, false, 'in-flight end must not publish success after stop')
  assert.equal(endAfterStop.code, 'lavish-session-terminal')
  assert.match(String(endAfterStop.error ?? ''), /stopped/)
  assert.equal(stopAfterEnd.ok, true)
  const endStopServer = (await readJsonl('servers.jsonl')).at(-1)!
  await eventually(() => !alive(Number(endStopServer.pid)), 'stop-during-end leaked its owned server pid')
  await setControl({})

  // === Regression: a fresh bind awaiting realpath must observe synchronous unload
  //     closure before record creation (no resurrection, no server spawn) ===
  // Uses a second harness so the registrar is still open at the start of the race.
  const bindRaceTools: ToolDef[] = []
  const bindRaceListeners = new Map<string, Dispose[]>()
  const bindRaceDisposers = new Map<string, PluginDispose>()
  const bindRaceCtx = {
    tools: { register: (tool: unknown) => bindRaceTools.push(tool as ToolDef) },
    systemPrompt: { variable() {} },
    on(event: string, listener: Dispose) {
      const list = bindRaceListeners.get(event) ?? []
      list.push(listener)
      bindRaceListeners.set(event, list)
      return () => {}
    },
    effect(register: () => PluginDispose, label?: string) {
      const disposer = register()
      if (label) bindRaceDisposers.set(label, disposer)
      return async () => { await disposer() }
    },
  } as unknown as Context
  apply(bindRaceCtx, config())
  const bindRaceLavish = bindRaceTools.filter(tool => tool.name.startsWith('gotry_lavish_'))
  const bindRaceByName = new Map(bindRaceLavish.map(tool => [tool.name, tool]))
  const bindRaceRun = (name: string, args: Record<string, unknown>, exec: unknown) => {
    const tool = bindRaceByName.get(name)
    assert.ok(tool, `${name} must be registered on the second harness`)
    return tool.execute(args, exec)
  }
  const bindRaceUnloadDisposer = bindRaceDisposers.get('gotry-lavish-lifecycle')
  assert.ok(bindRaceUnloadDisposer, 'second harness must also attach the Cordis lifecycle disposer')
  const commandsBeforeBindRace = (await readJsonl('commands.jsonl')).length
  const bindRaceOpenPromise = bindRaceRun('gotry_lavish_open', { path: 'card.html' }, hostExec('new-during-unload-bind', workspace))
  // unload's synchronous prefix (closed = true) must run before bind's realpath resolves
  const bindRaceUnloadPromise = bindRaceUnloadDisposer()
  const bindRaceOpen = await bindRaceOpenPromise
  await bindRaceUnloadPromise
  const commandsAfterBindRace = (await readJsonl('commands.jsonl')).length
  assert.equal(bindRaceOpen.ok, false, 'bind awaiting realpath must observe unload closure before record creation')
  assert.equal(bindRaceOpen.code, 'lavish-plugin-closed')
  assert.equal(commandsAfterBindRace - commandsBeforeBindRace, 0, 'bind/unload race must not spawn any CLI commands')

  const unloadExec = hostExec('plugin-unload', workspace)
  assert.equal((await run('gotry_lavish_open', { path: 'card.html' }, unloadExec)).ok, true)
  const unloadServer = (await readJsonl('servers.jsonl')).at(-1)!
  const unload = pluginDisposers.get('gotry-lavish-lifecycle')
  assert.ok(unload, 'registrar must attach cleanup to the verified Cordis fiber effect')
  await assert.rejects(unload!, /port-occupied/, 'plugin unload must expose any retained cleanup failure after reaping the other records')
  await eventually(() => !alive(Number(unloadServer.pid)), 'plugin unload leaked a live host session server')
  assert.equal((await run('gotry_lavish_open', { path: 'card.html' }, unloadExec)).ok, false, 'a stale execution cannot reopen after plugin unload')

  // === Regression: plugin unload then a brand-new host session id must fail closed
  //     without spawning a server or any CLI command ===
  const postUnloadNewIdExec = hostExec('new-id-after-plugin-unload', workspace)
  const commandsBeforePostUnload = (await readJsonl('commands.jsonl')).length
  const postUnloadOpen = await run('gotry_lavish_open', { path: 'card.html' }, postUnloadNewIdExec)
  const commandsAfterPostUnload = (await readJsonl('commands.jsonl')).length
  assert.equal(postUnloadOpen.ok, false, 'new host session id after plugin unload must fail closed')
  assert.equal(postUnloadOpen.code, 'lavish-plugin-closed')
  assert.equal(commandsAfterPostUnload - commandsBeforePostUnload, 0, 'post-unload open for new id must not spawn any CLI command')

  const serverRows = await readJsonl('servers.jsonl')
  for (const [index, row] of serverRows.entries()) {
    await eventually(() => !alive(Number(row.pid)), `owned server #${index + 1} ${String(row.pid)} on ${String(row.port)} state=${String(row.stateDir)} remained alive`)
  }
  console.log(`LAVISH PRODUCT TOOLS TESTS: ${serverRows.length} owned servers reaped; registered lifecycle passed`)
}

try {
  await main()
} finally {
  for (const row of await readJsonl('servers.jsonl')) {
    const pid = Number(row.pid)
    if (!Number.isInteger(pid) || !alive(pid)) continue
    try { process.kill(-pid, 'SIGTERM') } catch { /* already gone */ }
  }
  await rm(root, { recursive: true, force: true })
}
