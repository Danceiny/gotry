/**
 * Local Lavish Editor adapter tests (issue #443, parent #438).
 *
 * Offline section: a synthetic `lavish-axi` package tree exercises the adapter's
 * trust checks, path allowlist, argv shape, byte/timeout bounds, state machine,
 * process-group reaping, and lifecycle rules. Nothing here touches the network,
 * a real browser, or any real Lavish installation.
 *
 * Live section (opt-in, GOTRY_LAVISH_LIVE=1): installs the pinned `lavish-axi@0.1.67`
 * into a unique mkdtemp-scoped npm prefix from the public registry and runs the real
 * CLI open / poll(waiting) / end / stop protocol against a synthetic HTML fixture.
 *
 * Run: cd ts && npx tsx scripts/lavish-local-tests.ts
 *      cd ts && GOTRY_LAVISH_LIVE=1 npx tsx scripts/lavish-local-tests.ts
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  LAVISH_AXI_VERSION,
  LavishLocalError,
  LavishLocalSession,
  allocateUnusedLoopbackPort,
  buildChildEnvironment,
  readTrustedCli,
  resolveArtifactPath,
  type LavishLocalFailure,
} from '../capabilities/lavish-local.ts'

const MAX_PROMPT_FIELD_CHARS_TEST = 16 * 1024
const MAX_PROMPT_FIELD_BYTES_TEST = 16 * 1024

const TOON_ENTRY = createRequire(import.meta.url).resolve('@toon-format/toon')
const workRoot = await mkdtemp(join(tmpdir(), 'gotry-lavish-local-tests-'))

let assertions = 0
function ok(condition: unknown, detail: string): void {
  assertions += 1
  assert.ok(condition, detail)
}

function expectFailure(result: { ok: boolean }, code: string): LavishLocalFailure {
  assertions += 1
  assert.equal(result.ok, false, `expected failure(${code}), got ${JSON.stringify(result)}`)
  const failure = result as LavishLocalFailure
  assert.equal(failure.code, code, `expected code ${code}, got ${failure.code} (${failure.detail})`)
  assertNoLeak(failure.detail)
  return failure
}

const PROMPT_TEXT_SENTINEL = 'prompt-text-sentinel-must-not-leak'
const REPLY_SENTINEL = 'reply-sentinel-must-not-leak'

function assertNoLeak(text: string): void {
  assertions += 1
  assert.ok(!text.includes(PROMPT_TEXT_SENTINEL), `leaked prompt text: ${text}`)
  assert.ok(!text.includes(REPLY_SENTINEL), `leaked reply text: ${text}`)
}

// ---------------------------------------------------------------------------
// synthetic lavish-axi package
// ---------------------------------------------------------------------------

const FAKE_CLI_BODY = `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { encode } from ${JSON.stringify(TOON_ENTRY)}

const stateDir = process.env.LAVISH_AXI_STATE_DIR
const port = Number(process.env.LAVISH_AXI_PORT)
const argv = process.argv.slice(2)

appendFileSync(join(stateDir, 'argv.jsonl'), JSON.stringify(argv) + '\\n')
appendFileSync(join(stateDir, 'env.jsonl'), JSON.stringify(process.env) + '\\n')

function control() {
  try {
    return JSON.parse(readFileSync(join(stateDir, 'control.json'), 'utf8'))
  } catch {
    return {}
  }
}
function emit(value) {
  process.stdout.write(encode(value) + '\\n')
}
function sessionUrl() {
  return 'http://127.0.0.1:' + port + '/session/' + 'a'.repeat(16)
}
function writeOversize(stream, bytes) {
  const chunk = 'x'.repeat(64 * 1024)
  let written = 0
  while (written < bytes) {
    stream.write(chunk)
    written += chunk.length
  }
}

const command = argv[0]
const cfg = control()

if (command === 'server') {
  writeFileSync(join(stateDir, 'server.pid'), String(process.pid))
  const server = createServer((req, res) => {
    if (req.url && req.url.indexOf('/health') === 0) {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true, app: 'lavish-axi', version: '${LAVISH_AXI_VERSION}' }))
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
  server.listen(port, '127.0.0.1')
  process.on('SIGTERM', () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 200) })
} else if (command === 'open') {
  const file = argv[1]
  const open = cfg.open || {}
  if (open.oversizeStdout) writeOversize(process.stdout, open.oversizeStdout)
  else if (open.oversizeStderr) writeOversize(process.stderr, open.oversizeStderr)
  else if (open.stdoutRaw !== undefined) process.stdout.write(open.stdoutRaw)
  else if (open.error) emit({ error: open.error, code: open.code || 'SERVER_ERROR' })
  else emit({
    session: { file: open.file || file, url: open.url || sessionUrl(), status: open.status || 'opened' },
    next_step: 'synthetic next_step must never be surfaced as authority',
    ...(open.self_paint_warning ? { self_paint_warning: open.self_paint_warning } : {}),
  })
  if (open.exitCode) process.exitCode = open.exitCode
} else if (command === 'poll') {
  writeFileSync(join(stateDir, 'poll.pid'), String(process.pid))
  const poll = cfg.poll || {}
  const finish = () => {
    if (poll.oversizeStdout) writeOversize(process.stdout, poll.oversizeStdout)
    else if (poll.oversizeStderr) writeOversize(process.stderr, poll.oversizeStderr)
    else if (poll.stdoutRaw !== undefined) process.stdout.write(poll.stdoutRaw)
    else if (poll.error) emit({ error: poll.error, code: poll.code || 'SERVER_ERROR' })
    else {
      const status = poll.status || 'waiting'
      emit({
        session: {
          file: poll.file || argv[1],
          status,
          ...(poll.session_ended ? { session_ended: true, ended_by: poll.ended_by || 'user' } : {}),
        },
        ...(status === 'feedback' ? { prompts: poll.prompts || [], artifact_failures: poll.artifact_failures || [] } : {}),
        dom_snapshot: poll.dom_snapshot || '',
      })
    }
    if (poll.exitCode) process.exitCode = poll.exitCode
  }
  const sleepMs = Number(poll.sleepMs || 0)
  if (sleepMs > 0) setTimeout(finish, sleepMs)
  else finish()
} else if (command === 'end') {
  const end = cfg.end || {}
  if (end.error) emit({ error: end.error, code: end.code || 'SERVER_ERROR' })
  else emit({ session: { file: end.file || argv[1], status: end.status || 'ended' } })
  if (end.exitCode) process.exitCode = end.exitCode
} else {
  emit({ error: 'Unknown command: ' + command, code: 'VALIDATION_ERROR' })
  process.exitCode = 2
}
`

const fakePackageRoot = join(workRoot, 'fake-package', LAVISH_AXI_VERSION)
await mkdir(join(fakePackageRoot, 'dist'), { recursive: true })
await writeFile(join(fakePackageRoot, 'dist', 'cli.mjs'), FAKE_CLI_BODY)

function writeManifest(root: string, manifest: unknown): Promise<void> {
  return writeFile(join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}
await writeManifest(fakePackageRoot, {
  name: 'lavish-axi',
  version: LAVISH_AXI_VERSION,
  bin: { 'lavish-axi': 'dist/cli.mjs' },
})

await mkdir(join(workRoot, 'artifacts'), { recursive: true })
const artifactRoot = await realpath(join(workRoot, 'artifacts'))
const ARTIFACT = join(artifactRoot, 'card.html')
const ARTIFACT_BODY = '<!doctype html><html><body><h1>synthetic card</h1></body></html>\n'
await writeFile(ARTIFACT, ARTIFACT_BODY)

async function freshStateDir(label: string): Promise<string> {
  return mkdtemp(join(workRoot, `state-${label}-`))
}

async function sessionFor(stateDir: string, extra: Record<string, unknown> = {}): Promise<LavishLocalSession> {
  return LavishLocalSession.create({
    cliPackageRoot: fakePackageRoot,
    cwd: artifactRoot,
    allowedRoot: artifactRoot,
    stateDir,
    defaultPollTimeoutMs: 300,
    maxPollTimeoutMs: 5_000,
    commandTimeoutMs: 3_000,
    ...extra,
  })
}

/** Creates a session whose control file is already in place. */
async function controlSession(label: string, control: unknown, extra: Record<string, unknown> = {}): Promise<LavishLocalSession> {
  const stateDir = await freshStateDir(label)
  await writeControl(stateDir, control)
  return sessionFor(stateDir, extra)
}

async function readJsonl(path: string): Promise<string[][]> {
  try {
    const raw = await readFile(path, 'utf8')
    return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[])
  } catch {
    return []
  }
}

async function writeControl(stateDir: string, control: unknown): Promise<void> {
  await writeFile(join(stateDir, 'control.json'), JSON.stringify(control))
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function readPid(stateDir: string, name: string): Promise<number | null> {
  try {
    return Number(await readFile(join(stateDir, name), 'utf8'))
  } catch {
    return null
  }
}

async function waitForHealth(port: number): Promise<boolean> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`)
      if (response.ok) return true
    } catch {
      // keep waiting
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  return false
}

try {
  // -------------------------------------------------------------------------
  // 1. trusted CLI resolution
  // -------------------------------------------------------------------------

  {
    const good = await readTrustedCli(fakePackageRoot)
    ok(good.version === LAVISH_AXI_VERSION, 'the pinned version resolves')
    ok(good.entry.endsWith('dist/cli.mjs'), `the entry resolves to the declared bin: ${good.entry}`)

    await assert.rejects(() => readTrustedCli(join(workRoot, 'missing-package')), (error: unknown) => {
      ok(error instanceof LavishLocalError && error.code === 'invalid-options', 'a missing package root is refused')
      return true
    })
    await assert.rejects(() => readTrustedCli('relative/path'), (error: unknown) => {
      ok(error instanceof LavishLocalError && error.code === 'invalid-options', 'a relative cli root is refused')
      return true
    })

    const cases: Array<[string, unknown, string]> = [
      ['wrong-name', { name: 'not-lavish', version: LAVISH_AXI_VERSION, bin: { 'lavish-axi': 'dist/cli.mjs' } }, 'wrong package name'],
      ['wrong-version', { name: 'lavish-axi', version: '0.1.66', bin: { 'lavish-axi': 'dist/cli.mjs' } }, 'unpinned version'],
      ['wrong-bin', { name: 'lavish-axi', version: LAVISH_AXI_VERSION, bin: { 'lavish-axi': 'dist/other.mjs' } }, 'non-pinned entry'],
      ['no-bin', { name: 'lavish-axi', version: LAVISH_AXI_VERSION }, 'missing bin declaration'],
    ]
    for (const [label, manifest, description] of cases) {
      const root = join(workRoot, label)
      await mkdir(join(root, 'dist'), { recursive: true })
      await writeManifest(root, manifest)
      await writeFile(join(root, 'dist', 'cli.mjs'), '')
      await writeFile(join(root, 'dist', 'other.mjs'), '')
      await assert.rejects(() => readTrustedCli(root), (error: unknown) => {
        ok(error instanceof LavishLocalError && error.code === 'cli-not-trusted', `${description} is refused`)
        return true
      })
    }

    const missingEntry = join(workRoot, 'missing-entry')
    await mkdir(missingEntry, { recursive: true })
    await writeManifest(missingEntry, { name: 'lavish-axi', version: LAVISH_AXI_VERSION, bin: { 'lavish-axi': 'dist/cli.mjs' } })
    await assert.rejects(() => readTrustedCli(missingEntry), (error: unknown) => {
      ok(error instanceof LavishLocalError && error.code === 'cli-not-trusted', 'a missing declared entry is refused')
      return true
    })

    const escapingEntry = join(workRoot, 'escaping-entry')
    await mkdir(join(escapingEntry, 'dist'), { recursive: true })
    await writeManifest(escapingEntry, { name: 'lavish-axi', version: LAVISH_AXI_VERSION, bin: { 'lavish-axi': 'dist/cli.mjs' } })
    await writeFile(join(workRoot, 'escape-target.mjs'), '')
    await symlink(join(workRoot, 'escape-target.mjs'), join(escapingEntry, 'dist', 'cli.mjs')).catch(() => undefined)
    await assert.rejects(() => readTrustedCli(escapingEntry), (error: unknown) => {
      ok(error instanceof LavishLocalError && error.code === 'cli-not-trusted', 'an entry escaping the package root is refused')
      return true
    })
  }

  // -------------------------------------------------------------------------
  // 2. artifact path allowlist
  // -------------------------------------------------------------------------

  {
    const accepted = await resolveArtifactPath(ARTIFACT, artifactRoot, artifactRoot)
    ok(accepted.ok && accepted.file === ARTIFACT, 'an absolute html file inside the root is accepted')
    const relative = await resolveArtifactPath('card.html', artifactRoot, artifactRoot)
    ok(relative.ok && relative.file === ARTIFACT, 'a relative html file resolves against cwd')

    expectFailure(await resolveArtifactPath('', artifactRoot, artifactRoot), 'path-rejected')
    expectFailure(await resolveArtifactPath(42, artifactRoot, artifactRoot), 'path-rejected')
    expectFailure(await resolveArtifactPath(`${artifactRoot}/car\0d.html`, artifactRoot, artifactRoot), 'path-rejected')
    expectFailure(await resolveArtifactPath(join(artifactRoot, 'notes.txt'), artifactRoot, artifactRoot), 'path-rejected')
    expectFailure(await resolveArtifactPath('../outside.html', artifactRoot, artifactRoot), 'path-rejected')
    expectFailure(await resolveArtifactPath('/etc/hosts.html', artifactRoot, artifactRoot), 'path-rejected')
    expectFailure(await resolveArtifactPath(artifactRoot, artifactRoot, artifactRoot), 'path-rejected')

    const nested = join(artifactRoot, 'nested')
    for (const denied of ['.git', 'node_modules']) {
      await mkdir(join(nested, denied), { recursive: true })
      const path = join(nested, denied, 'card.html')
      await writeFile(path, ARTIFACT_BODY)
      expectFailure(await resolveArtifactPath(path, artifactRoot, artifactRoot), 'path-rejected')
    }

    const outside = join(workRoot, 'outside.html')
    await writeFile(outside, ARTIFACT_BODY)
    expectFailure(await resolveArtifactPath(outside, artifactRoot, artifactRoot), 'path-rejected')

    const escapeLink = join(artifactRoot, 'escape.html')
    await symlink(outside, escapeLink).catch(() => undefined)
    expectFailure(await resolveArtifactPath(escapeLink, artifactRoot, artifactRoot), 'path-rejected')

    const directoryArtifact = join(artifactRoot, 'carddir.html')
    await mkdir(directoryArtifact, { recursive: true })
    expectFailure(await resolveArtifactPath(directoryArtifact, artifactRoot, artifactRoot), 'path-rejected')
  }

  // -------------------------------------------------------------------------
  // 3. minimal child environment (no inherited LAVISH / Tailscale variables)
  // -------------------------------------------------------------------------

  {
    const env = buildChildEnvironment('/tmp/owned-state', 4444)
    assert.deepEqual(Object.keys(env).sort(), [
      'HOME',
      'LAVISH_AXI_HOST',
      'LAVISH_AXI_LINK_HOST',
      'LAVISH_AXI_NO_OPEN',
      'LAVISH_AXI_PORT',
      'LAVISH_AXI_STATE_DIR',
      'LAVISH_AXI_TELEMETRY',
      'PATH',
    ].sort())
    assertions += 1
    ok(env.LAVISH_AXI_HOST === '127.0.0.1' && env.LAVISH_AXI_LINK_HOST === '127.0.0.1', 'both hosts are forced to loopback')
    ok(env.LAVISH_AXI_TELEMETRY === '0' && env.LAVISH_AXI_NO_OPEN === '1', 'telemetry is off and browser opening is off')
    ok(env.LAVISH_AXI_STATE_DIR === '/tmp/owned-state' && env.LAVISH_AXI_PORT === '4444', 'the owned state dir and port are used')
    ok(env.HOME === '/tmp/owned-state/home', 'HOME is redirected into the owned state dir')

    const stateDir = await freshStateDir('env')
    const hostile = {
      LAVISH_AXI_HOST: '0.0.0.0',
      LAVISH_AXI_ALLOWED_HOSTS: '*',
      LAVISH_AXI_TELEMETRY: '1',
      LAVISH_AXI_STATE_DIR: '/tmp/hostile-state',
      LAVISH_AXI_PORT: '1',
      LAVISH_AXI_IDLE_TIMEOUT_MS: '1',
      TS_SOCKET: '/tmp/hostile-tailscale.sock',
    }
    const previous = new Map(Object.keys(hostile).map((key) => [key, process.env[key]]))
    Object.assign(process.env, hostile)
    try {
      const session = await sessionFor(stateDir)
      const opened = await session.open(ARTIFACT)
      ok(opened.ok === true, `open works despite a hostile ambient environment: ${JSON.stringify(opened)}`)
      const observed = JSON.parse((await readFile(join(stateDir, 'env.jsonl'), 'utf8')).trim().split('\n')[0]) as Record<string, string>
      const allowedLavishKeys = new Set(Object.keys(buildChildEnvironment(stateDir, 0)))
      const inherited = Object.keys(observed).filter((key) => key.startsWith('LAVISH_AXI_') && !allowedLavishKeys.has(key))
      ok(inherited.length === 0, `no ambient LAVISH_AXI_* reached the child: ${inherited.join(',')}`)
      ok(observed.LAVISH_AXI_HOST === '127.0.0.1', 'an ambient 0.0.0.0 host is overridden')
      ok(observed.LAVISH_AXI_ALLOWED_HOSTS === undefined, 'an ambient DNS-rebinding allowlist is dropped')
      ok(Object.keys(observed).filter((key) => key.startsWith('TS_')).length === 0, 'no Tailscale variables reach the child')
      await session.stop()
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }

  // -------------------------------------------------------------------------
  // 4. argv shape, lifecycle, and the no-shell guarantee
  // -------------------------------------------------------------------------

  {
    const session = await controlSession('lifecycle', {})
    const port = session.state().port

    const opened = await session.open(ARTIFACT)
    ok(opened.ok === true, `open succeeds: ${JSON.stringify(opened)}`)
    if (opened.ok) {
      ok(opened.status === 'opened', 'open reports opened')
      ok(opened.file === ARTIFACT, 'open echoes the resolved realpath')
      ok(opened.url === `http://127.0.0.1:${port}/session/${'a'.repeat(16)}`, 'open returns the loopback session url')
      ok(!('nextStep' in opened), 'the CLI next_step text is never surfaced as authority')
    }

    const state = session.state()
    ok(state.sessionOpen === true && state.userEnded === false, 'instance state tracks the open session')
    ok(state.stateDir.length > 0, 'the instance owns a state directory')
    ok(state.port > 0 && state.port !== 4387, `the instance allocated an unused port: ${state.port}`)

    const polled = await session.poll(ARTIFACT)
    ok(polled.ok === true && polled.status === 'waiting', `poll reports waiting: ${JSON.stringify(polled)}`)
    if (polled.ok) {
      ok(polled.feedback.trust === 'untrusted', 'feedback carries an explicit untrusted marker')
      ok(polled.feedback.prompts.length === 0 && polled.feedback.domSnapshot === '', 'a waiting poll carries no feedback')
    }

    const replyText = `${REPLY_SENTINEL}; $(touch ${workRoot}/pwned); rm -rf /`
    const replied = await session.reply(ARTIFACT, replyText)
    ok(replied.ok === true && replied.kind === 'reply', `reply round-trips: ${JSON.stringify(replied)}`)
    ok(!(await stat(join(workRoot, 'pwned')).then(() => true).catch(() => false)), 'reply text is never shell-expanded')

    const ended = await session.end(ARTIFACT)
    ok(ended.ok === true && ended.status === 'ended', `end reports ended: ${JSON.stringify(ended)}`)

    const stopped = await session.stop()
    ok(stopped.ok === true && stopped.status === 'stopped', `stop reaps the owned server: ${JSON.stringify(stopped)}`)
    const serverPid = await readPid(session.state().stateDir, 'server.pid')
    ok(serverPid !== null, 'the owned server recorded its pid')
    if (serverPid !== null) ok(!isProcessAlive(serverPid), 'the owned server process is gone after stop')

    const stopAgain = await session.stop()
    ok(stopAgain.ok === true && stopAgain.status === 'not-running', 'stop is idempotent')
    expectFailure(await session.poll(ARTIFACT), 'instance-closed')
    expectFailure(await session.open(ARTIFACT), 'instance-closed')

    const argv = await readJsonl(join(session.state().stateDir, 'argv.jsonl'))
    assert.deepEqual(argv, [
      ['server', '--port', String(port)],
      ['open', ARTIFACT, '--no-open'],
      ['poll', ARTIFACT, '--timeout-ms', '300'],
      ['poll', ARTIFACT, '--agent-reply', replyText, '--timeout-ms', '300'],
      ['end', ARTIFACT],
    ], `unexpected argv transcript: ${JSON.stringify(argv)}`)
    assertions += 1
    const forbidden = argv.filter((line) => ['update', 'setup', 'share', 'export', 'playbook', 'design'].includes(line[0] ?? ''))
    ok(forbidden.length === 0, `no self-upgrade, hook, or share command was ever invoked: ${JSON.stringify(forbidden)}`)
    const transcript = await readFile(join(session.state().stateDir, 'argv.jsonl'), 'utf8')
    ok(!transcript.includes('--reopen'), 'the adapter never passes --reopen')
  }

  // -------------------------------------------------------------------------
  // 5. reply validation, malformed output, and unexpected states
  // -------------------------------------------------------------------------

  {
    const session = await controlSession('validation', {})
    ok((await session.open(ARTIFACT)).ok === true, 'the validation fixture opens')

    expectFailure(await session.reply(ARTIFACT, ''), 'invalid-reply')
    expectFailure(await session.reply(ARTIFACT, '   '), 'invalid-reply')
    expectFailure(await session.reply(ARTIFACT, '--'), 'invalid-reply')
    expectFailure(await session.reply(ARTIFACT, 7 as unknown as string), 'invalid-reply')

    expectFailure(await session.poll(ARTIFACT, { timeoutMs: 0 }), 'invalid-options')
    expectFailure(await session.poll(ARTIFACT, { timeoutMs: -1 }), 'invalid-options')
    expectFailure(await session.poll(ARTIFACT, { timeoutMs: 1.5 }), 'invalid-options')
    expectFailure(await session.poll(ARTIFACT, { timeoutMs: 99_999 }), 'invalid-options')
    await session.stop()

    const scenarios: Array<[string, unknown, string]> = [
      ['not-toon', { open: { stdoutRaw: 'this is not toon {{{\n' } }, 'malformed-output'],
      ['toon-array', { open: { stdoutRaw: '- a\n- b\n' } }, 'malformed-output'],
      ['unknown-status', { open: { status: 'mystery' } }, 'unexpected-status'],
      ['foreign-url', { open: { url: `http://evil.example/session/${'b'.repeat(16)}` } }, 'malformed-output'],
      ['wrong-port-url', { open: { url: `http://127.0.0.1:1/session/${'c'.repeat(16)}` } }, 'malformed-output'],
      ['wrong-file', { open: { file: join(artifactRoot, 'other.html') } }, 'malformed-output'],
      ['poll-unknown-status', { poll: { status: 'nonsense' } }, 'unexpected-status'],
    ]
    for (const [label, control, code] of scenarios) {
      const scenarioSession = await controlSession(label, control)
      const result = label.startsWith('poll-') ? await scenarioSession.poll(ARTIFACT) : await scenarioSession.open(ARTIFACT)
      expectFailure(result, code)
      await scenarioSession.stop()
    }

    const errorSession = await controlSession('cli-error', {
      open: { error: 'Lavish Editor request failed: 500', code: 'SERVER_ERROR' },
    })
    const cliError = expectFailure(await errorSession.open(ARTIFACT), 'command-failed')
    ok(cliError.detail.includes('SERVER_ERROR'), `the CLI error code is preserved: ${cliError.detail}`)
    await errorSession.stop()
  }

  // -------------------------------------------------------------------------
  // 5b. an unreadable poll response locks consumption, because it may already
  //     have consumed a once-only feedback delivery
  // -------------------------------------------------------------------------

  {
    const unreadable = await controlSession('poll-missing-session', { poll: { stdoutRaw: 'status: whatever\n' } })
    expectFailure(await unreadable.poll(ARTIFACT), 'malformed-output')
    ok(unreadable.state().pollOutcomeUnknown === true, 'a poll response with no session object latches the unknown outcome')
    const argvAfterFirst = (await readJsonl(join(unreadable.state().stateDir, 'argv.jsonl'))).length
    expectFailure(await unreadable.poll(ARTIFACT), 'poll-outcome-unknown')
    expectFailure(await unreadable.reply(ARTIFACT, 'a reply that must not be sent'), 'poll-outcome-unknown')
    const argvAfterRefusals = (await readJsonl(join(unreadable.state().stateDir, 'argv.jsonl'))).length
    ok(argvAfterRefusals === argvAfterFirst, `no further CLI invocation was made: ${argvAfterFirst} -> ${argvAfterRefusals}`)
    await unreadable.stop()

    const mystery = await controlSession('poll-mystery-latch', { poll: { status: 'mystery' } })
    expectFailure(await mystery.poll(ARTIFACT), 'unexpected-status')
    ok(mystery.state().pollOutcomeUnknown === true, 'an unreadable poll status latches the unknown outcome')
    const argvAfterMystery = (await readJsonl(join(mystery.state().stateDir, 'argv.jsonl'))).length
    expectFailure(await mystery.poll(ARTIFACT), 'poll-outcome-unknown')
    expectFailure(await mystery.reply(ARTIFACT, 'another reply that must not be sent'), 'poll-outcome-unknown')
    ok(
      (await readJsonl(join(mystery.state().stateDir, 'argv.jsonl'))).length === argvAfterMystery,
      'a latched instance spawns nothing further',
    )
    await mystery.stop()
  }

  // -------------------------------------------------------------------------
  // 5c. a non-zero exit code is never accepted as success, even with
  //     well-formed TOON on stdout
  // -------------------------------------------------------------------------

  {
    const openExit = await controlSession('open-exit2', { open: { status: 'opened', exitCode: 2 } })
    expectFailure(await openExit.open(ARTIFACT), 'command-failed')
    ok(openExit.state().sessionOpen === false, 'a failed open never marks the session open')
    await openExit.stop()

    const endExit = await controlSession('end-exit2', { end: { status: 'ended', exitCode: 2 } })
    expectFailure(await endExit.end(ARTIFACT), 'command-failed')
    await endExit.stop()

    const pollExit = await controlSession('poll-exit2', { poll: { status: 'waiting', exitCode: 2 } })
    expectFailure(await pollExit.poll(ARTIFACT), 'command-failed')
    ok(pollExit.state().pollOutcomeUnknown === true, 'a non-zero poll exit latches the unknown outcome')
    const argvAfterPoll = (await readJsonl(join(pollExit.state().stateDir, 'argv.jsonl'))).length
    expectFailure(await pollExit.poll(ARTIFACT), 'poll-outcome-unknown')
    ok(
      (await readJsonl(join(pollExit.state().stateDir, 'argv.jsonl'))).length === argvAfterPoll,
      'a poll that exited non-zero is not retried',
    )
    await pollExit.stop()

    const feedbackExit = await controlSession('feedback-exit2', {
      poll: { status: 'feedback', prompts: [{ uid: 'u', tag: 'note', text: PROMPT_TEXT_SENTINEL, selector: '#a' }], exitCode: 2 },
    })
    const feedbackFailure = expectFailure(await feedbackExit.poll(ARTIFACT), 'command-failed')
    ok(!feedbackFailure.detail.includes(PROMPT_TEXT_SENTINEL), 'a rejected feedback payload is not echoed into the failure detail')
    ok(feedbackExit.state().pollOutcomeUnknown === true, 'a rejected feedback delivery also latches')
    await feedbackExit.stop()

    const structured = await controlSession('exit-with-error', {
      open: { error: 'Lavish Editor request failed: 500', code: 'SERVER_ERROR', exitCode: 2 },
    })
    const structuredFailure = expectFailure(await structured.open(ARTIFACT), 'command-failed')
    ok(structuredFailure.detail.includes('SERVER_ERROR'), `the structured CLI error wins over the exit code: ${structuredFailure.detail}`)
    await structured.stop()
  }

  // -------------------------------------------------------------------------
  // 5d. reply text is bounded at runtime, before any argv or spawn
  // -------------------------------------------------------------------------

  {
    const session = await controlSession('oversized-reply', {})
    expectFailure(await session.reply(ARTIFACT, 'x'.repeat(2 * 1024 * 1024)), 'invalid-reply')
    expectFailure(await session.reply(ARTIFACT, 'x'.repeat(20_000)), 'invalid-reply')
    expectFailure(await session.reply(ARTIFACT, '\u{1D11E}'.repeat(8_000)), 'invalid-reply')
    const argv = await readJsonl(join(session.state().stateDir, 'argv.jsonl'))
    ok(argv.length === 0, `an oversized or over-bytes reply spawns nothing: ${JSON.stringify(argv)}`)
    const stopped = await session.stop()
    ok(stopped.ok === true, 'an instance that only rejected replies still stops cleanly')
  }

  // -------------------------------------------------------------------------
  // 6. byte and time bounds, timeouts, and reaping
  // -------------------------------------------------------------------------

  {
    const overflow = await controlSession('overflow', { open: { oversizeStdout: 512 * 1024 } }, { maxStdoutBytes: 4_096 })
    expectFailure(await overflow.open(ARTIFACT), 'output-too-large')
    await overflow.stop()

    const stderrOverflow = await controlSession('stderr-overflow', { open: { oversizeStderr: 512 * 1024 } }, { maxStderrBytes: 4_096 })
    expectFailure(await stderrOverflow.open(ARTIFACT), 'output-too-large')
    await stderrOverflow.stop()

    const hang = await controlSession('hang', {}, { defaultPollTimeoutMs: 200, maxPollTimeoutMs: 1_000, commandTimeoutMs: 400 })
    ok((await hang.open(ARTIFACT)).ok === true, 'the fixture opens before the hang probe')
    const hangStateDir = hang.state().stateDir
    await writeControl(hangStateDir, { poll: { sleepMs: 60_000 } })
    const startedAt = Date.now()
    expectFailure(await hang.poll(ARTIFACT), 'command-timeout')
    ok(Date.now() - startedAt < 5_000, 'the adapter deadline fires long before the fixture would wake')
    const pollPid = await readPid(hangStateDir, 'poll.pid')
    ok(pollPid !== null, 'the hanging poll recorded its pid')
    if (pollPid !== null) ok(!isProcessAlive(pollPid), 'the timed-out poll process group was reaped')

    const unknownOutcome = expectFailure(await hang.poll(ARTIFACT), 'poll-outcome-unknown')
    ok(unknownOutcome.detail.length > 0, 'the unknown-outcome refusal explains itself')

    const stopAfterTimeout = await hang.stop()
    ok(stopAfterTimeout.ok === true, `stop still works after a timeout: ${JSON.stringify(stopAfterTimeout)}`)
    const hangServerPid = await readPid(hangStateDir, 'server.pid')
    if (hangServerPid !== null) ok(!isProcessAlive(hangServerPid), 'the owned server is reaped after a timeout stop')
  }

  // -------------------------------------------------------------------------
  // 7. feedback projection: bounded untrusted data, no filesystem access
  // -------------------------------------------------------------------------

  {
    const attachmentTarget = join(artifactRoot, 'attachment.png')
    const prompts = Array.from({ length: 80 }, (_value, index) => ({
      uid: `uid-${index}`,
      tag: index === 0 ? 'layout-warnings' : 'note',
      selector: '#card',
      text: index === 0 ? PROMPT_TEXT_SENTINEL : `feedback ${index}`,
      target: { type: 'layout-warnings', warnings: [{ id: 'w1' }] },
      attachments: Array.from({ length: 20 }, (_v, refIndex) => ({
        id: `att-${index}-${refIndex}`,
        name: 'screenshot.png',
        path: attachmentTarget,
        mime: 'image/png',
        width: 10,
        height: 10,
      })),
    }))
    const session = await controlSession('feedback', {
      poll: {
        status: 'feedback',
        prompts,
        artifact_failures: Array.from({ length: 40 }, (_v, index) => ({ kind: 'missing-asset', detail: `failure ${index}` })),
        dom_snapshot: 'd'.repeat(400 * 1024),
        session_ended: true,
        ended_by: 'user',
      },
    })

    const result = await session.poll(ARTIFACT)
    ok(result.ok === true && result.status === 'feedback', `feedback is delivered: ${JSON.stringify(result).slice(0, 200)}`)
    if (result.ok) {
      ok(result.sessionEnded === true && result.endedBy === 'user', 'the ended-by marker is preserved as data')
      const feedback = result.feedback
      ok(feedback.prompts.length === 64 && feedback.promptsTruncated, `the prompt count is bounded: ${feedback.prompts.length}`)
      ok(feedback.artifactFailures.length === 16 && feedback.artifactFailuresTruncated, 'artifact failures are bounded')
      ok(feedback.domSnapshotTruncated && Buffer.byteLength(feedback.domSnapshot) <= 256 * 1024, 'the dom snapshot is byte-bounded')
      ok(feedback.prompts[0].attachments.length === 16, 'attachment refs per prompt are bounded')
      ok(feedback.prompts[0].target?.type === 'layout-warnings', 'the target type is kept as data')
      const projection = JSON.stringify(feedback)
      ok(!projection.includes(attachmentTarget), 'no attachment filesystem path is exposed or read')
      ok(!projection.includes('"path"') && !projection.includes('"mime"'), 'only id/name attachment refs are projected')
      assertions += 1
      assert.ok(projection.includes(PROMPT_TEXT_SENTINEL), 'prompt text is preserved as data')
    }

    ok((await session.end(ARTIFACT)).ok === true, 'the session can still be ended after feedback')
    await session.stop()
  }

  // -------------------------------------------------------------------------
  // 7b. prompt vs text separation: freeform + annotation shapes from real
  //     upstream lavish-axi@0.1.67 (see normalizePrompt at dist/cli.mjs ~8112
  //     and acceptedPrompts filter at ~7720: `tag === "message" && prompt.prompt`).
  //     Tag is the lower-cased element tagName (context() at ~5359: real
  //     annotations are h1 / div / p, not the literal "text").
  // -------------------------------------------------------------------------

  {
    const REAL_USER_REQUEST = 'Synthetic acceptance feedback: add a visible section titled Agent update 1 with the text Browser feedback accepted. Keep all dates and facts unchanged.'
    const realBrowserFreeform = await controlSession('real-browser-freeform', {
      poll: {
        status: 'feedback',
        prompts: [
          { uid: '', tag: 'message', selector: '', text: 'Freeform message', prompt: REAL_USER_REQUEST, attachments: [] },
        ],
      },
    })
    const freeformResult = await realBrowserFreeform.poll(ARTIFACT)
    ok(freeformResult.ok === true, 'the real-browser freeform fixture delivers feedback')
    if (freeformResult.ok) {
      const prompts = freeformResult.feedback.prompts
      ok(prompts.length === 1, 'one freeform prompt is projected')
      const only = prompts[0]
      ok(only !== undefined, 'the freeform prompt is present')
      if (only !== undefined) {
        ok(only.tag === 'message', 'the freeform tag is preserved')
        ok(only.text === 'Freeform message', `text is the upstream placeholder, not the request: ${only.text}`)
        ok(only.textTruncated === false, 'the upstream placeholder text is not flagged as truncated')
        ok(only.prompt === REAL_USER_REQUEST, `prompt is the actual user instruction, not silently substituted with text: ${only.prompt.slice(0, 80)}...`)
        ok(only.promptTruncated === false, 'a request that fits within the byte bound is not flagged as truncated')
        ok(only.selector === '' && only.target === undefined, 'freeform has no selector or target')
      }
      ok(freeformResult.feedback.promptsMalformed === 0, 'a well-formed freeform prompt is not counted as malformed')
    }
    await realBrowserFreeform.stop()

    const realAnnotation = await controlSession('real-annotation', {
      poll: {
        status: 'feedback',
        prompts: [
          {
            uid: 'a-1',
            tag: 'h1',
            selector: 'h1.day-3',
            text: 'Day 3 — Kyoto half-day walking tour (08:00 – 14:30)',
            prompt: 'Re-time this to start no earlier than 10:00.',
            attachments: [],
          },
        ],
      },
    })
    const annotationResult = await realAnnotation.poll(ARTIFACT)
    ok(annotationResult.ok === true, 'the annotation fixture delivers feedback')
    if (annotationResult.ok) {
      const prompts = annotationResult.feedback.prompts
      ok(prompts.length === 1, 'one annotation prompt is projected')
      const only = prompts[0]
      ok(only !== undefined, 'the annotation prompt is present')
      if (only !== undefined) {
        ok(only.tag === 'h1', 'the annotation tag is the lower-cased element tagName')
        ok(only.selector === 'h1.day-3', 'the originating selector is preserved')
        ok(only.text === 'Day 3 — Kyoto half-day walking tour (08:00 – 14:30)', 'the selected snippet stays in text')
        ok(only.prompt === 'Re-time this to start no earlier than 10:00.', 'the user comment stays in prompt')
        ok(only.target === undefined, 'a plain HTML annotation has no target (table/mermaid only)')
        ok(only.text !== only.prompt, 'text and prompt are not the same string for an annotation')
      }
      ok(annotationResult.feedback.promptsMalformed === 0, 'a well-formed annotation prompt is not counted as malformed')
    }
    await realAnnotation.stop()

    const counterexampleRepro = await controlSession('root-counterexample', {
      poll: {
        status: 'feedback',
        prompts: [
          { uid: '', tag: 'message', selector: '', text: 'Freeform message', attachments: [] },
        ],
      },
    })
    const reproResult = await counterexampleRepro.poll(ARTIFACT)
    ok(reproResult.ok === true, 'the root counterexample fixture still delivers feedback (no global failure)')
    if (reproResult.ok) {
      const prompts = reproResult.feedback.prompts
      ok(prompts.length === 1, 'the missing-prompt freeform prompt is not silently dropped')
      const only = prompts[0]
      ok(only !== undefined && only.prompt === '', `a missing prompt is exposed as the empty string, not as text: ${only?.prompt}`)
      ok(only !== undefined && only.promptTruncated === false, 'a missing prompt is not falsely flagged as truncated')
      ok(only !== undefined && only.text === 'Freeform message', 'the placeholder text is preserved')
      ok(reproResult.feedback.promptsMalformed === 1, `the missing-prompt freeform is counted as malformed: ${reproResult.feedback.promptsMalformed}`)
    }
    await counterexampleRepro.stop()

    const nonStringPrompt = await controlSession('non-string-prompt', {
      poll: {
        status: 'feedback',
        prompts: [
          { uid: 'u', tag: 'message', selector: '', text: 'Freeform message', prompt: 7 as unknown as string },
          { uid: 'v', tag: 'h1', selector: 'h1.day-3', text: 'snippet', prompt: { bogus: true } as unknown as string },
          { uid: 'w', tag: 'message', selector: '', text: 'Freeform message', prompt: null as unknown as string },
        ],
      },
    })
    const nonStringResult = await nonStringPrompt.poll(ARTIFACT)
    ok(nonStringResult.ok === true, 'non-string prompt fields do not poison the whole poll')
    if (nonStringResult.ok) {
      ok(nonStringResult.feedback.promptsMalformed === 3, `every non-string prompt is counted as malformed regardless of tag: ${nonStringResult.feedback.promptsMalformed}`)
      for (const projected of nonStringResult.feedback.prompts) {
        ok(projected.prompt === '' && projected.promptTruncated === false, `non-string prompt projected as empty and not falsely truncated: ${JSON.stringify(projected)}`)
      }
    }
    await nonStringPrompt.stop()

    const emptyWithAttachment = await controlSession('empty-with-attachment', {
      poll: {
        status: 'feedback',
        prompts: [
          { uid: 'ea', tag: 'message', selector: '', text: 'Freeform message', prompt: '', attachments: [{ id: 'att-x', name: 'screenshot.png' }] },
        ],
      },
    })
    const emptyAttachResult = await emptyWithAttachment.poll(ARTIFACT)
    ok(emptyAttachResult.ok === true, 'an empty-prompt request with attachments still delivers feedback')
    if (emptyAttachResult.ok) {
      ok(emptyAttachResult.feedback.promptsMalformed === 0, 'an empty-string prompt is NOT counted as malformed')
      const only = emptyAttachResult.feedback.prompts[0]
      ok(only !== undefined && only.prompt === '', 'the empty prompt is preserved as data')
      ok(only !== undefined && only.promptTruncated === false, 'an empty prompt is not falsely flagged as truncated')
      ok(only !== undefined && only.attachments.length === 1 && only.attachments[0]?.id === 'att-x', 'the attachment survives alongside an empty prompt')
    }
    await emptyWithAttachment.stop()

    const emptyNoAttachment = await controlSession('empty-no-attachment', {
      poll: {
        status: 'feedback',
        prompts: [
          { uid: 'en', tag: 'h1', selector: 'h1.day-3', text: 'Day 3', prompt: '', attachments: [] },
        ],
      },
    })
    const emptyNoAttachResult = await emptyNoAttachment.poll(ARTIFACT)
    ok(emptyNoAttachResult.ok === true, 'an empty-prompt annotation still delivers feedback')
    if (emptyNoAttachResult.ok) {
      ok(emptyNoAttachResult.feedback.promptsMalformed === 0, 'an empty-string prompt with no attachments is still NOT counted as malformed')
      const only = emptyNoAttachResult.feedback.prompts[0]
      ok(only !== undefined && only.prompt === '' && only.text === 'Day 3', 'the empty prompt does NOT fall back to the context text')
      ok(only !== undefined && only.promptTruncated === false, 'an empty prompt is not falsely flagged as truncated')
    }
    await emptyNoAttachment.stop()

    const malformedAnyTag = await controlSession('malformed-any-tag', {
      poll: {
        status: 'feedback',
        prompts: [
          { uid: 'l', tag: 'layout-warnings', selector: '', text: 'warning batch' },
          { uid: 'n', tag: 'note', selector: '#x', text: 'note body' },
          { uid: 'p', tag: 'div', selector: 'p', text: 'paragraph' },
        ],
      },
    })
    const malformedAnyResult = await malformedAnyTag.poll(ARTIFACT)
    ok(malformedAnyResult.ok === true, 'missing-prompt fixtures on any tag deliver feedback')
    if (malformedAnyResult.ok) {
      ok(malformedAnyResult.feedback.promptsMalformed === 3, `missing prompt is counted as malformed on every tag, not just freeform/annotation: ${malformedAnyResult.feedback.promptsMalformed}`)
      for (const projected of malformedAnyResult.feedback.prompts) {
        ok(projected.prompt === '' && projected.promptTruncated === false, `missing-prompt is projected as empty without false truncation flags: ${JSON.stringify(projected)}`)
        ok(projected.text.length > 0, `context text survives so consumers can audit the drop: ${projected.text}`)
      }
    }
    await malformedAnyTag.stop()

    const oversizedChar = 'A'.repeat(MAX_PROMPT_FIELD_CHARS_TEST + 200)
    const charOverflow = await controlSession('prompt-char-overflow', {
      poll: { status: 'feedback', prompts: [{ uid: 'c', tag: 'message', selector: '', text: 'Freeform message', prompt: oversizedChar }] },
    })
    const charResult = await charOverflow.poll(ARTIFACT)
    ok(charResult.ok === true, 'an over-char-bound prompt still delivers feedback')
    if (charResult.ok) {
      const only = charResult.feedback.prompts[0]
      ok(only !== undefined, 'the prompt is projected')
      if (only !== undefined) {
        ok(only.prompt.length === MAX_PROMPT_FIELD_CHARS_TEST, `the prompt is char-clipped: ${only.prompt.length}`)
        ok(only.promptTruncated === true, 'the truncation flag is set explicitly')
      }
      ok(charResult.feedback.promptsMalformed === 0, 'over-char-bound prompts are truncated, not counted as malformed')
    }
    await charOverflow.stop()

    const oversizedByte = '\u{1F600}'.repeat(MAX_PROMPT_FIELD_BYTES_TEST + 100)
    const byteOverflow = await controlSession('prompt-byte-overflow', {
      poll: { status: 'feedback', prompts: [{ uid: 'b', tag: 'message', selector: '', text: 'Freeform message', prompt: oversizedByte }] },
    })
    const byteResult = await byteOverflow.poll(ARTIFACT)
    ok(byteResult.ok === true, 'an over-byte-bound prompt still delivers feedback')
    if (byteResult.ok) {
      const only = byteResult.feedback.prompts[0]
      ok(only !== undefined, 'the prompt is projected')
      if (only !== undefined) {
        const projectedBytes = Buffer.byteLength(only.prompt, 'utf8')
        ok(projectedBytes <= MAX_PROMPT_FIELD_BYTES_TEST, `the prompt is byte-clipped to the bound: ${projectedBytes}`)
        ok(only.promptTruncated === true, 'the byte truncation flag is set explicitly')
        ok(!only.prompt.endsWith('�'), 'no split multi-byte sequence survives in the truncated prompt')
      }
      ok(byteResult.feedback.promptsMalformed === 0, 'over-byte-bound prompts are truncated, not counted as malformed')
    }
    await byteOverflow.stop()
  }

  // -------------------------------------------------------------------------
  // 8. user-ended stays closed; no automatic reopen
  // -------------------------------------------------------------------------

  {
    const session = await controlSession('user-ended', { open: { status: 'user-ended' } })
    const first = await session.open(ARTIFACT)
    ok(first.ok === true && first.status === 'user-ended', `open reports user-ended: ${JSON.stringify(first)}`)
    ok(session.state().userEnded === true && session.state().sessionOpen === false, 'the instance latches the user-ended state')

    expectFailure(await session.open(ARTIFACT), 'session-user-ended')
    const argv = await readJsonl(join(session.state().stateDir, 'argv.jsonl'))
    ok(argv.filter((line) => line[0] === 'open').length === 1, `no reopen was attempted: ${JSON.stringify(argv)}`)
    ok((await session.stop()).ok === true, 'stop still works after a user end')

    const userEndedByPoll = await controlSession('user-ended-poll', {
      poll: { status: 'feedback', prompts: [{ uid: 'u', tag: 'note', text: 'bye', selector: '#a' }], session_ended: true, ended_by: 'user' },
    })
    ok((await userEndedByPoll.poll(ARTIFACT)).ok === true, 'the session-ended feedback is delivered')
    ok(userEndedByPoll.state().userEnded === true, 'a user end observed through poll also latches closed')
    expectFailure(await userEndedByPoll.open(ARTIFACT), 'session-user-ended')
    await userEndedByPoll.stop()
  }

  // -------------------------------------------------------------------------
  // 9. a foreign server on the port is never adopted, preempted, or killed
  // -------------------------------------------------------------------------

  {
    const foreign = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true, app: 'something-else', version: '9.9.9' }))
    })
    await new Promise<void>((resolveListen) => foreign.listen(0, '127.0.0.1', resolveListen))
    const address = foreign.address()
    assert.ok(address !== null && typeof address === 'object')
    const foreignPort = address.port

    const session = await controlSession('foreign', {}, { port: foreignPort })
    expectFailure(await session.open(ARTIFACT), 'port-occupied')
    ok(foreign.listening, 'the foreign listener is untouched')
    const argv = await readJsonl(join(session.state().stateDir, 'argv.jsonl'))
    ok(argv.length === 0, `no command was issued against a foreign port: ${JSON.stringify(argv)}`)
    const stopped = await session.stop()
    ok(stopped.ok === true && stopped.status === 'not-running', 'stop never touches a server it does not own')
    ok(foreign.listening, 'stop left the foreign listener running')
    await new Promise<void>((resolveClose) => foreign.close(() => resolveClose()))
  }

  {
    // A pre-existing lavish-axi server of the very same pinned version is still
    // not ours: the adapter must neither adopt nor shut it down.
    const port = await allocateUnusedLoopbackPort()
    const preState = await freshStateDir('preexisting')
    await writeControl(preState, {})
    const preexisting = spawn(process.execPath, [join(fakePackageRoot, 'dist', 'cli.mjs'), 'server', '--port', String(port)], {
      cwd: artifactRoot,
      env: buildChildEnvironment(preState, port),
      detached: true,
      stdio: 'ignore',
    })
    ok(await waitForHealth(port), 'the pre-existing same-version server is healthy before the probe')

    const session = await controlSession('preexisting-session', {}, { port })
    expectFailure(await session.open(ARTIFACT), 'port-occupied')
    ok(preexisting.pid !== undefined && isProcessAlive(preexisting.pid), 'the pre-existing server was not adopted or killed')
    const argv = await readJsonl(join(session.state().stateDir, 'argv.jsonl'))
    ok(argv.length === 0, `no command was issued to the pre-existing server: ${JSON.stringify(argv)}`)

    const stopped = await session.stop()
    ok(stopped.ok === true && stopped.status === 'not-running', 'stop reports nothing owned rather than shutting a foreign server down')
    if (preexisting.pid !== undefined) ok(isProcessAlive(preexisting.pid), 'the pre-existing server survived stop')

    if (preexisting.pid !== undefined) {
      try {
        process.kill(-preexisting.pid, 'SIGTERM')
      } catch {
        preexisting.kill('SIGTERM')
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 300))
    }
  }

  // -------------------------------------------------------------------------
  // 10. per-instance isolation: two instances, two state dirs, two ports
  // -------------------------------------------------------------------------

  {
    const firstState = await freshStateDir('pair-a')
    const secondState = await freshStateDir('pair-b')
    const [first, second] = await Promise.all([sessionFor(firstState), sessionFor(secondState)])
    ok(first.state().port !== second.state().port, 'each instance allocates its own port')
    ok(first.state().stateDir !== second.state().stateDir, 'each instance owns its own state dir')
    const [firstOpen, secondOpen] = await Promise.all([first.open(ARTIFACT), second.open(ARTIFACT)])
    ok(firstOpen.ok === true && secondOpen.ok === true, 'two instances serve concurrently')
    await Promise.all([first.stop(), second.stop()])
    const [firstPid, secondPid] = await Promise.all([readPid(firstState, 'server.pid'), readPid(secondState, 'server.pid')])
    ok(firstPid !== null && secondPid !== null && firstPid !== secondPid, 'the two instances owned different server processes')
    for (const pid of [firstPid, secondPid]) {
      if (pid !== null) ok(!isProcessAlive(pid), 'every owned server was reaped')
    }
  }

  // -------------------------------------------------------------------------
  // 11. the adapter never writes to stdout/stderr and never mutates the artifact
  // -------------------------------------------------------------------------

  {
    const session = await controlSession('quiet', {
      poll: { status: 'feedback', prompts: [{ uid: 'u', tag: 'note', text: PROMPT_TEXT_SENTINEL, selector: '#a' }] },
    })
    const before = await stat(ARTIFACT)
    const bodyBefore = await readFile(ARTIFACT, 'utf8')

    let written = 0
    const stdoutWrite = process.stdout.write.bind(process.stdout)
    const stderrWrite = process.stderr.write.bind(process.stderr)
    const counter = (): boolean => {
      written += 1
      return true
    }
    ;(process.stdout as unknown as { write: unknown }).write = counter
    ;(process.stderr as unknown as { write: unknown }).write = counter
    try {
      await session.open(ARTIFACT)
      const feedback = await session.poll(ARTIFACT)
      ok(feedback.ok === true, 'the quiet probe still receives feedback')
      expectFailure(await session.poll(ARTIFACT, { timeoutMs: 0 }), 'invalid-options')
      await session.end(ARTIFACT)
      await session.stop()
    } finally {
      ;(process.stdout as unknown as { write: unknown }).write = stdoutWrite
      ;(process.stderr as unknown as { write: unknown }).write = stderrWrite
    }
    ok(written === 0, `the adapter wrote ${written} chunks to stdout/stderr; it must log nothing`)

    const after = await stat(ARTIFACT)
    const bodyAfter = await readFile(ARTIFACT, 'utf8')
    ok(bodyAfter === bodyBefore, 'the artifact contents are untouched')
    ok(after.mtimeMs === before.mtimeMs, 'the artifact mtime is untouched')
    ok(after.size === before.size, 'the artifact size is untouched')
  }

  // -------------------------------------------------------------------------
  // 12. opt-in: real installed CLI protocol probe
  // -------------------------------------------------------------------------

  if (process.env.GOTRY_LAVISH_LIVE !== '1') {
    console.log('SKIP: the real lavish-axi probe is opt-in; set GOTRY_LAVISH_LIVE=1 (public registry install into an mkdtemp prefix, no global install)')
  } else {
    await realCliProbe()
  }

  console.log(`LAVISH LOCAL ADAPTER TESTS OK (${assertions} assertions)`)
} finally {
  await rm(workRoot, { recursive: true, force: true })
}

async function realCliProbe(): Promise<void> {
  const installRoot = await mkdtemp(join(tmpdir(), 'gotry-lavish-live-'))
  let ownedStateDir: string | null = null
  try {
    await writeFile(join(installRoot, 'package.json'), `${JSON.stringify({ name: 'gotry-lavish-probe', private: true, version: '0.0.0' })}\n`)
    console.log(`=== live probe: npm install lavish-axi@${LAVISH_AXI_VERSION} into ${installRoot} ===`)
    const install = spawnSync('npm', ['install', '--no-save', '--no-audit', '--no-fund', '--ignore-scripts', `lavish-axi@${LAVISH_AXI_VERSION}`], {
      cwd: installRoot,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: installRoot },
    })
    console.log('argv: npm install --no-save --no-audit --no-fund --ignore-scripts lavish-axi@' + LAVISH_AXI_VERSION)
    console.log(`exit: ${install.status}`)
    assert.equal(install.status, 0, `npm install failed: ${install.stderr}`)

    const packageRoot = join(installRoot, 'node_modules', 'lavish-axi')
    const cli = await readTrustedCli(packageRoot)
    console.log(`resolved entry: ${cli.entry}`)
    console.log(`resolved version: ${cli.version}`)
    assertions += 2

    const liveArtifacts = join(installRoot, 'artifacts')
    await mkdir(liveArtifacts, { recursive: true })
    const artifact = join(liveArtifacts, 'synthetic-trip-card.html')
    await writeFile(artifact, '<!doctype html><html><body><div style="background:#fff;color:#111;height:120px">synthetic card</div></body></html>\n')

    const session = await LavishLocalSession.create({
      cliPackageRoot: packageRoot,
      cwd: liveArtifacts,
      allowedRoot: liveArtifacts,
    })
    const { port, stateDir } = session.state()
    ownedStateDir = stateDir
    console.log(`owned loopback port: ${port}`)
    console.log(`owned state dir: ${stateDir}`)

    const beforeStop = spawnSync(process.execPath, [cli.entry, 'stop', '--port', String(port)], {
      encoding: 'utf8',
      cwd: liveArtifacts,
      env: buildChildEnvironment(stateDir, port),
    })
    console.log(`argv: lavish-axi stop --port ${port} -> exit ${beforeStop.status} stdout: ${beforeStop.stdout.trim()}`)
    ok(beforeStop.status === 0, 'the real stop command is well-defined with nothing running')

    const opened = await session.open(artifact)
    ok(opened.ok === true, `live open succeeds: ${JSON.stringify(opened)}`)
    if (opened.ok) {
      ok(opened.status === 'opened', `live open status is opened: ${opened.status}`)
      ok(opened.url.startsWith(`http://127.0.0.1:${port}/session/`), 'the live session url is loopback on the owned port')
      console.log(`argv: open <artifact> --no-open -> exit 0, status=${opened.status}, url=${opened.url.replace(/\/session\/[0-9a-f]{16}/, '/session/[redacted]')}`)
    }

    const polled = await session.poll(artifact, { timeoutMs: 2_500 })
    ok(polled.ok === true, `live poll succeeds: ${JSON.stringify(polled)}`)
    if (polled.ok) {
      ok(polled.status === 'waiting', `live poll status is waiting: ${polled.status}`)
      console.log(`argv: poll <artifact> --timeout-ms 2500 -> exit 0, status=${polled.status}`)
    }

    const ended = await session.end(artifact)
    ok(ended.ok === true && ended.status === 'ended', `live end succeeds: ${JSON.stringify(ended)}`)
    console.log('argv: end <artifact> -> exit 0, status=ended')

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000))
    const afterEnd = spawnSync(process.execPath, [cli.entry, 'stop', '--port', String(port)], {
      encoding: 'utf8',
      cwd: liveArtifacts,
      env: buildChildEnvironment(stateDir, port),
    })
    console.log(`argv: lavish-axi stop --port ${port} (after end) -> exit ${afterEnd.status} stdout: ${afterEnd.stdout.trim()}`)
    ok(afterEnd.status === 0, 'the real stop command stays well-defined after a session ends')

    const stopped = await session.stop()
    ok(stopped.ok === true, `live stop succeeds: ${JSON.stringify(stopped)}`)
    console.log(`stop -> status=${stopped.ok ? stopped.status : 'error'}`)
    ok(stopped.ok && (stopped.status === 'stopped' || stopped.status === 'not-running'), 'live stop is idempotent')

    const health = spawnSync(process.execPath, ['-e', `fetch('http://127.0.0.1:${port}/health').then(() => process.exit(0), () => process.exit(3))`], { encoding: 'utf8' })
    ok(health.status === 3, 'the owned port is free after stop')
    console.log('post-stop health probe: no listener (expected)')

    // The server self-exits once the last session ends with nothing connected, so
    // the stop above never had to signal it. A second instance on the same owned
    // state dir and port gets a live server, then reaps it while it is running.
    const liveSession = await LavishLocalSession.create({
      cliPackageRoot: packageRoot,
      cwd: liveArtifacts,
      allowedRoot: liveArtifacts,
      stateDir,
      port,
    })
    const reopened = await liveSession.open(artifact)
    ok(reopened.ok === true && reopened.status === 'opened', `a fresh server opens a new session: ${JSON.stringify(reopened)}`)
    const liveReap = await liveSession.stop()
    ok(liveReap.ok === true && liveReap.status === 'stopped', `a live owned server is signalled and reaped: ${JSON.stringify(liveReap)}`)
    console.log(`open (fresh server) -> stop while live -> status=${liveReap.ok ? liveReap.status : 'error'}`)
    const healthAfterReap = spawnSync(process.execPath, ['-e', `fetch('http://127.0.0.1:${port}/health').then(() => process.exit(0), () => process.exit(3))`], { encoding: 'utf8' })
    ok(healthAfterReap.status === 3, 'the owned port is free after reaping a live server')
    console.log('post-reap health probe: no listener (expected)')
    console.log('NOTE: real browser feedback (feedback payloads, --agent-reply echo, browser_disconnected grace) is NOT exercised here; it stays a #438 TODO for a real browser session.')
  } finally {
    if (ownedStateDir) await rm(ownedStateDir, { recursive: true, force: true })
    await rm(installRoot, { recursive: true, force: true })
  }
}
