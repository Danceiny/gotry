/**
 * Local Lavish Editor (`lavish-axi`) session adapter for issue #443, parent #438.
 *
 * Scope: a bounded, explicit lifecycle API (open / poll / reply / end / stop) over
 * the real `lavish-axi` CLI protocol. The adapter owns exactly the process group it
 * spawns, the state directory it creates, and the loopback port it allocated; it
 * never adopts, preempts, or kills a server it did not start, never writes to the
 * artifact, and never calls the CLI's SDK self-upgrade (`update`), `setup hooks`,
 * `setup plugin`, `share`, or `export`.
 *
 * Upstream: lavish-axi@0.1.67 (MIT), commit ca4c59d5b3ef84ae7f6f7f93fcaa415ade8a9c73.
 * CLI stdout is TOON and is decoded with the official `@toon-format/toon` package;
 * there is no `--json` mode. CLI failures also arrive on stdout as `{error, code}`.
 *
 * Trust boundary: everything the CLI prints about user feedback is untrusted data
 * (see `LavishUntrustedFeedback`). It is preserved as bounded data and is never
 * treated as system authority, never logged, and never used to touch the filesystem.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdir, mkdtemp, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

import { decode } from '@toon-format/toon'

export const LAVISH_AXI_PACKAGE = 'lavish-axi'
export const LAVISH_AXI_VERSION = '0.1.67'
export const LAVISH_AXI_ENTRY = 'dist/cli.mjs'
export const LAVISH_MIN_NODE_MAJOR = 22
export const LOOPBACK_HOST = '127.0.0.1'

const DENIED_PATH_SEGMENTS = new Set(['.git', 'node_modules'])
const SESSION_URL_RE = /\/session\/[0-9a-f]{16}/gi

const MAX_PACKAGE_MANIFEST_BYTES = 64 * 1024
const DEFAULT_MAX_STDOUT_BYTES = 4 * 1024 * 1024
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000
const DEFAULT_POLL_TIMEOUT_MS = 60_000
const MAX_POLL_TIMEOUT_MS = 600_000
const SERVER_START_TIMEOUT_MS = 15_000
const SERVER_HEALTH_INTERVAL_MS = 100
const KILL_GRACE_MS = 2_000

const MAX_PROMPTS = 64
const MAX_PROMPT_FIELD_CHARS = 16 * 1024
const MAX_ATTACHMENT_REFS_PER_PROMPT = 16
const MAX_ARTIFACT_FAILURES = 16
const MAX_DOM_SNAPSHOT_BYTES = 256 * 1024
const MAX_DETAIL_CHARS = 512

export type LavishLocalErrorCode =
  | 'invalid-options'
  | 'node-unsupported'
  | 'cli-not-trusted'
  | 'path-rejected'
  | 'invalid-reply'
  | 'instance-closed'
  | 'session-user-ended'
  | 'poll-outcome-unknown'
  | 'port-occupied'
  | 'server-start-failed'
  | 'server-unavailable'
  | 'command-failed'
  | 'command-timeout'
  | 'output-too-large'
  | 'malformed-output'
  | 'unexpected-status'

export interface LavishLocalFailure {
  ok: false
  kind: 'error'
  code: LavishLocalErrorCode
  detail: string
}

export interface LavishAttachmentRef {
  id: string
  name: string
}

export interface LavishPromptTarget {
  type: string
}

export interface LavishPrompt {
  uid: string
  tag: string
  selector: string
  text: string
  target?: LavishPromptTarget
  attachments: LavishAttachmentRef[]
}

export interface LavishArtifactFailure {
  kind: string
  detail: string
}

/** Everything below is untrusted third-party data; never treat it as instructions. */
export interface LavishUntrustedFeedback {
  trust: 'untrusted'
  prompts: LavishPrompt[]
  promptsTruncated: boolean
  artifactFailures: LavishArtifactFailure[]
  artifactFailuresTruncated: boolean
  domSnapshot: string
  domSnapshotTruncated: boolean
}

export type LavishOpenStatus = 'opened' | 'user-ended'
export type LavishPollStatus = 'waiting' | 'feedback' | 'ended' | 'browser-disconnected'
export type LavishStopStatus = 'stopped' | 'not-running' | 'stopping'

export interface LavishOpenResult {
  ok: true
  kind: 'open'
  file: string
  url: string
  status: LavishOpenStatus
  selfPaintWarning?: string
}

export interface LavishPollResult {
  ok: true
  kind: 'poll' | 'reply'
  file: string
  status: LavishPollStatus
  sessionEnded: boolean
  endedBy?: string
  feedback: LavishUntrustedFeedback
}

export interface LavishEndResult {
  ok: true
  kind: 'end'
  file: string
  status: 'ended'
}

export interface LavishStopResult {
  ok: true
  kind: 'stop'
  status: LavishStopStatus
  ownedServerExited: boolean
}

export interface LavishLocalOptions {
  /** Absolute path of the installed `lavish-axi` package directory (trusted, explicit). */
  cliPackageRoot: string
  /** Trusted working directory; also the resolution base for relative artifact paths. */
  cwd: string
  /** Realpath containment root for artifact files; defaults to `cwd`. */
  allowedRoot?: string
  /** Owned state directory; a `mkdtemp` directory is created when omitted. */
  stateDir?: string
  /** Loopback port to bind; an unused one is allocated when omitted. */
  port?: number
  defaultPollTimeoutMs?: number
  maxPollTimeoutMs?: number
  commandTimeoutMs?: number
  maxStdoutBytes?: number
  maxStderrBytes?: number
}

export interface LavishLocalState {
  port: number
  stateDir: string
  sessionOpen: boolean
  userEnded: boolean
  pollOutcomeUnknown: boolean
  closed: boolean
}

interface TrustedCli {
  packageRoot: string
  entry: string
  version: string
}

interface ResolvedOptions {
  cli: TrustedCli
  cwd: string
  allowedRoot: string
  stateDir: string
  port: number
  defaultPollTimeoutMs: number
  maxPollTimeoutMs: number
  commandTimeoutMs: number
  maxStdoutBytes: number
  maxStderrBytes: number
}

interface OwnedRun {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  outputExceeded: boolean
}

/**
 * Bounded local session over one owned `lavish-axi server` child process.
 *
 * One instance == one state directory + one loopback port + one owned process group.
 * Every method performs at most one CLI invocation; the adapter never retries.
 */
export class LavishLocalSession {
  private readonly options: ResolvedOptions
  private server: ChildProcess | null = null
  private serverDead = false
  private sessionOpen = false
  private userEnded = false
  private pollOutcomeUnknown = false
  private closed = false

  private constructor(options: ResolvedOptions) {
    this.options = options
  }

  static async create(options: LavishLocalOptions): Promise<LavishLocalSession> {
    return new LavishLocalSession(await resolveOptions(options))
  }

  state(): LavishLocalState {
    return {
      port: this.options.port,
      stateDir: this.options.stateDir,
      sessionOpen: this.sessionOpen,
      userEnded: this.userEnded,
      pollOutcomeUnknown: this.pollOutcomeUnknown,
      closed: this.closed,
    }
  }

  /** Opens (or re-attaches to) the review session for an accepted HTML artifact path. */
  async open(artifactPath: string): Promise<LavishOpenResult | LavishLocalFailure> {
    const guard = this.guardNewCommand()
    if (guard) return guard
    if (this.userEnded) {
      return fail('session-user-ended', 'the user ended this session; the adapter never reopens it')
    }

    const resolved = await this.resolveArtifact(artifactPath)
    if ('code' in resolved) return resolved

    const ready = await this.ensureServer()
    if ('code' in ready) return ready

    const run = await this.runCli(['open', resolved.file, '--no-open'])
    if ('code' in run) return run

    const decoded = decodeCliOutput(run.stdout)
    if ('code' in decoded) return decoded

    const body = decoded.value
    if ('error' in body) return cliFailure(body)

    const session = readRecord(body.session)
    if (!session) return fail('malformed-output', 'open response has no session object')
    if (session.file !== resolved.file) {
      return fail('malformed-output', 'open response reported a different artifact path')
    }
    const status = readString(session.status)
    if (status !== 'opened' && status !== 'user-ended') {
      return fail('unexpected-status', `unsupported open status ${quote(status)}`)
    }
    const url = readString(session.url)
    if (!url || !isLoopbackSessionUrl(url, this.options.port)) {
      return fail('malformed-output', 'open response carried no loopback session url for this port')
    }

    this.sessionOpen = status === 'opened'
    this.userEnded = status === 'user-ended'

    const warning = readString(body.self_paint_warning)
    return {
      ok: true,
      kind: 'open',
      file: resolved.file,
      url,
      status,
      ...(warning ? { selfPaintWarning: bound(warning, MAX_PROMPT_FIELD_CHARS) } : {}),
    }
  }

  /**
   * Waits up to `timeoutMs` for feedback, an end, or a browser disconnect.
   * A `waiting` result consumed nothing and is safe to poll again.
   */
  async poll(artifactPath: string, options: { timeoutMs?: number } = {}): Promise<LavishPollResult | LavishLocalFailure> {
    return this.pollLike('poll', artifactPath, undefined, options)
  }

  /**
   * Answers feedback and waits for the next state in the same CLI invocation,
   * mirroring the protocol's `poll <file> --agent-reply <text>`.
   */
  async reply(artifactPath: string, text: string, options: { timeoutMs?: number } = {}): Promise<LavishPollResult | LavishLocalFailure> {
    if (typeof text !== 'string' || text.trim().length === 0) {
      return fail('invalid-reply', 'reply text must be a non-empty string')
    }
    if (text === '--') {
      return fail('invalid-reply', 'reply text must not be the bare flag terminator')
    }
    return this.pollLike('reply', artifactPath, text, options)
  }

  /** Ends the session. The owned server may exit on its own right after this. */
  async end(artifactPath: string): Promise<LavishEndResult | LavishLocalFailure> {
    const guard = this.guardNewCommand()
    if (guard) return guard

    const resolved = await this.resolveArtifact(artifactPath)
    if ('code' in resolved) return resolved

    const ready = await this.ensureServer()
    if ('code' in ready) return ready

    const run = await this.runCli(['end', resolved.file])
    if ('code' in run) return run

    const decoded = decodeCliOutput(run.stdout)
    if ('code' in decoded) return decoded

    const body = decoded.value
    if ('error' in body) return cliFailure(body)

    const session = readRecord(body.session)
    const status = session ? readString(session.status) : null
    if (status !== 'ended') {
      return fail('unexpected-status', `unsupported end status ${quote(status)}`)
    }
    this.sessionOpen = false
    this.userEnded = false
    return { ok: true, kind: 'end', file: resolved.file, status: 'ended' }
  }

  /**
   * Reaps only the server this instance started (process group SIGTERM, then
   * SIGKILL, then a bounded wait). Idempotent: a server that already exited on its
   * own yields `not-running`. A port held by anything else is reported, never touched.
   */
  async stop(): Promise<LavishStopResult | LavishLocalFailure> {
    if (this.closed) return { ok: true, kind: 'stop', status: 'not-running', ownedServerExited: true }

    const child = this.server
    this.sessionOpen = false
    this.pollOutcomeUnknown = false
    this.server = null
    this.closed = true

    if (!child) return { ok: true, kind: 'stop', status: 'not-running', ownedServerExited: true }

    const alreadyExited = this.serverDead || child.exitCode !== null || child.signalCode !== null
    if (!alreadyExited) await terminateOwnedGroup(child)
    const exited = child.exitCode !== null || child.signalCode !== null

    if (await this.portIsFree()) {
      return { ok: true, kind: 'stop', status: alreadyExited ? 'not-running' : 'stopped', ownedServerExited: true }
    }
    if (!exited) return { ok: true, kind: 'stop', status: 'stopping', ownedServerExited: false }
    return fail('port-occupied', `loopback port ${this.options.port} is still held by a process this adapter does not own`)
  }

  private async pollLike(
    kind: 'poll' | 'reply',
    artifactPath: string,
    replyText: string | undefined,
    options: { timeoutMs?: number },
  ): Promise<LavishPollResult | LavishLocalFailure> {
    const guard = this.guardNewCommand()
    if (guard) return guard

    if (this.pollOutcomeUnknown) {
      return fail(
        'poll-outcome-unknown',
        'the previous poll ended without a delivered outcome; polling again could double-consume feedback',
      )
    }

    const timeoutMs = this.normalizePollTimeout(options.timeoutMs)
    if ('code' in timeoutMs) return timeoutMs

    const resolved = await this.resolveArtifact(artifactPath)
    if ('code' in resolved) return resolved

    const ready = await this.ensureServer()
    if ('code' in ready) return ready

    const argv = ['poll', resolved.file]
    if (replyText !== undefined) argv.push('--agent-reply', replyText)
    argv.push('--timeout-ms', String(timeoutMs.value))

    const run = await this.runCli(argv, timeoutMs.value + this.options.commandTimeoutMs)
    if ('code' in run) {
      // A killed long-poll may or may not have consumed feedback; never retry silently.
      if (run.code === 'command-timeout') this.pollOutcomeUnknown = true
      return run
    }

    const decoded = decodeCliOutput(run.stdout)
    if ('code' in decoded) {
      this.pollOutcomeUnknown = true
      return decoded
    }

    const body = decoded.value
    if ('error' in body) {
      this.pollOutcomeUnknown = true
      return cliFailure(body)
    }

    const session = readRecord(body.session)
    if (!session) return fail('malformed-output', 'poll response has no session object')
    const raw = readString(session.status)
    const status = normalizePollStatus(raw)
    if (!status) return fail('unexpected-status', `unsupported poll status ${quote(raw)}`)

    const endedBy = readString(session.ended_by) ?? undefined
    if (endedBy === 'user' && (status === 'ended' || session.session_ended === true)) {
      this.userEnded = true
    }
    if (status === 'ended') this.sessionOpen = false

    return {
      ok: true,
      kind,
      file: resolved.file,
      status,
      sessionEnded: session.session_ended === true,
      ...(endedBy ? { endedBy } : {}),
      feedback: projectFeedback(body),
    }
  }

  private guardNewCommand(): LavishLocalFailure | null {
    if (this.closed) return fail('instance-closed', 'this session was stopped; create a new instance')
    return null
  }

  private normalizePollTimeout(value: unknown): { value: number } | LavishLocalFailure {
    const requested = value === undefined ? this.options.defaultPollTimeoutMs : value
    if (typeof requested !== 'number' || !Number.isInteger(requested) || requested <= 0) {
      return fail('invalid-options', 'timeoutMs must be a positive integer')
    }
    if (requested > this.options.maxPollTimeoutMs) {
      return fail('invalid-options', `timeoutMs must not exceed ${this.options.maxPollTimeoutMs}`)
    }
    return { value: requested }
  }

  private async resolveArtifact(input: unknown): Promise<{ file: string } | LavishLocalFailure> {
    return resolveArtifactPath(input, this.options.cwd, this.options.allowedRoot)
  }

  private async runCli(argv: string[], timeoutMs = this.options.commandTimeoutMs): Promise<OwnedRun | LavishLocalFailure> {
    return runOwnedProcess(process.execPath, [this.options.cli.entry, ...argv], {
      cwd: this.options.cwd,
      env: this.childEnv(),
      timeoutMs,
      maxStdoutBytes: this.options.maxStdoutBytes,
      maxStderrBytes: this.options.maxStderrBytes,
    })
  }

  private childEnv(): Record<string, string> {
    return buildChildEnvironment(this.options.stateDir, this.options.port)
  }

  private async ensureServer(): Promise<{ ok: true } | LavishLocalFailure> {
    if (this.ownedServerLive()) {
      const health = await this.readHealth()
      if (health === 'ours') return { ok: true }
      if (health === 'foreign') {
        return fail('port-occupied', `loopback port ${this.options.port} answered but is not this adapter's server`)
      }
      return fail('server-unavailable', 'the owned Lavish server stopped answering; create a new instance')
    }

    const probe = await this.readHealth()
    if (probe !== 'free') {
      return fail('port-occupied', `loopback port ${this.options.port} was already in use; this adapter never adopts it`)
    }

    const child = spawn(process.execPath, [this.options.cli.entry, 'server', '--port', String(this.options.port)], {
      cwd: this.options.cwd,
      env: this.childEnv(),
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.resume()
    child.stderr?.resume()
    this.server = child
    this.serverDead = false
    child.once('close', () => {
      this.serverDead = true
    })
    child.once('error', () => {
      this.serverDead = true
    })

    const deadline = Date.now() + SERVER_START_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (this.serverDead) break
      if ((await this.readHealth()) === 'ours') return { ok: true }
      await delay(SERVER_HEALTH_INTERVAL_MS)
    }

    await terminateOwnedGroup(child)
    this.server = null
    return fail('server-start-failed', 'the owned Lavish server did not become healthy on the pinned version')
  }

  private ownedServerLive(): boolean {
    const child = this.server
    if (!child || this.serverDead) return false
    return child.exitCode === null && child.signalCode === null
  }

  /**
   * Own-port health probe. Only a live child of this instance plus a matching
   * `app`/`version` payload counts as ours; any other answer is a foreign server
   * this adapter must never adopt, preempt, or shut down.
   */
  private async readHealth(): Promise<'ours' | 'foreign' | 'free'> {
    const body = await fetchHealth(this.options.port)
    if (!body) return 'free'
    if (!this.ownedServerLive()) return 'foreign'
    if (body.app === LAVISH_AXI_PACKAGE && body.version === this.options.cli.version) return 'ours'
    return 'foreign'
  }

  private async portIsFree(): Promise<boolean> {
    return (await fetchHealth(this.options.port)) === null
  }
}

async function resolveOptions(options: LavishLocalOptions): Promise<ResolvedOptions> {
  if (!isPlainObject(options)) throw invalidOptions('options must be a plain object')

  const nodeMajor = Number(process.versions.node.split('.')[0])
  if (!Number.isInteger(nodeMajor) || nodeMajor < LAVISH_MIN_NODE_MAJOR) {
    throw new LavishLocalError('node-unsupported', `${LAVISH_AXI_PACKAGE} requires Node >= ${LAVISH_MIN_NODE_MAJOR}`)
  }

  const cwd = await requireDirectory(options.cwd, 'cwd')
  const allowedRoot = options.allowedRoot === undefined ? cwd : await requireDirectory(options.allowedRoot, 'allowedRoot')
  const cli = await readTrustedCli(options.cliPackageRoot)
  const stateDir = options.stateDir === undefined
    ? await mkdtemp(join(tmpdir(), 'gotry-lavish-local-'))
    : await requireDirectory(options.stateDir, 'stateDir')
  await mkdir(join(stateDir, 'home'), { recursive: true })

  const port = options.port === undefined ? await allocateUnusedLoopbackPort() : requirePort(options.port)

  return {
    cli,
    cwd,
    allowedRoot,
    stateDir,
    port,
    defaultPollTimeoutMs: positiveInt(options.defaultPollTimeoutMs, DEFAULT_POLL_TIMEOUT_MS, 'defaultPollTimeoutMs'),
    maxPollTimeoutMs: positiveInt(options.maxPollTimeoutMs, MAX_POLL_TIMEOUT_MS, 'maxPollTimeoutMs'),
    commandTimeoutMs: positiveInt(options.commandTimeoutMs, DEFAULT_COMMAND_TIMEOUT_MS, 'commandTimeoutMs'),
    maxStdoutBytes: positiveInt(options.maxStdoutBytes, DEFAULT_MAX_STDOUT_BYTES, 'maxStdoutBytes'),
    maxStderrBytes: positiveInt(options.maxStderrBytes, DEFAULT_MAX_STDERR_BYTES, 'maxStderrBytes'),
  }
}

export class LavishLocalError extends Error {
  readonly code: LavishLocalErrorCode
  constructor(code: LavishLocalErrorCode, detail: string) {
    super(detail)
    this.name = 'LavishLocalError'
    this.code = code
  }
}

/** Resolves the trusted CLI: exact package name, exact pinned version, exact entry. */
export async function readTrustedCli(cliPackageRoot: unknown): Promise<TrustedCli> {
  const packageRoot = await requireDirectory(cliPackageRoot, 'cliPackageRoot')

  const manifestPath = join(packageRoot, 'package.json')
  let raw: string
  try {
    const info = await stat(manifestPath)
    if (!info.isFile() || info.size > MAX_PACKAGE_MANIFEST_BYTES) {
      throw new LavishLocalError('cli-not-trusted', 'the lavish-axi package.json is not a bounded regular file')
    }
    raw = await readFile(manifestPath, 'utf8')
  } catch (error) {
    if (error instanceof LavishLocalError) throw error
    throw new LavishLocalError('cli-not-trusted', 'no readable package.json in the supplied lavish-axi package root')
  }

  let manifest: unknown
  try {
    manifest = JSON.parse(raw)
  } catch {
    throw new LavishLocalError('cli-not-trusted', 'the lavish-axi package.json is not valid JSON')
  }
  if (!isPlainObject(manifest)) throw new LavishLocalError('cli-not-trusted', 'the lavish-axi package.json is not an object')

  if (manifest.name !== LAVISH_AXI_PACKAGE) {
    throw new LavishLocalError('cli-not-trusted', `expected package ${LAVISH_AXI_PACKAGE}, refused`)
  }
  if (manifest.version !== LAVISH_AXI_VERSION) {
    throw new LavishLocalError('cli-not-trusted', `expected ${LAVISH_AXI_PACKAGE}@${LAVISH_AXI_VERSION}, refused`)
  }

  const bin = isPlainObject(manifest.bin) ? manifest.bin[LAVISH_AXI_PACKAGE] : undefined
  if (typeof bin !== 'string' || bin !== LAVISH_AXI_ENTRY) {
    throw new LavishLocalError('cli-not-trusted', `expected bin.${LAVISH_AXI_PACKAGE} to be ${LAVISH_AXI_ENTRY}, refused`)
  }

  const entryPath = join(packageRoot, LAVISH_AXI_ENTRY)
  let entry: string
  try {
    entry = await realpath(entryPath)
  } catch {
    throw new LavishLocalError('cli-not-trusted', `the declared entry ${LAVISH_AXI_ENTRY} is missing`)
  }
  if (!isInside(packageRoot, entry)) {
    throw new LavishLocalError('cli-not-trusted', 'the declared entry escapes the package root')
  }
  const info = await stat(entry)
  if (!info.isFile()) throw new LavishLocalError('cli-not-trusted', 'the declared entry is not a regular file')

  return { packageRoot, entry, version: LAVISH_AXI_VERSION }
}

/**
 * Accepts only `.html`/`.htm` files whose realpath stays inside `allowedRoot`,
 * with `.git`/`node_modules` denied. Relative input resolves against `cwd`. Both
 * roots are canonicalised first and symlinks are resolved before containment, so a
 * symlink pointing outside the root is rejected rather than followed.
 */
export async function resolveArtifactPath(input: unknown, cwd: string, allowedRoot: string): Promise<{ ok: true; file: string } | LavishLocalFailure> {
  if (typeof input !== 'string' || input.length === 0) {
    return fail('path-rejected', 'artifact path must be a non-empty string')
  }
  if (input.includes('\0')) return fail('path-rejected', 'artifact path must not contain NUL')

  const lower = input.toLowerCase()
  if (!lower.endsWith('.html') && !lower.endsWith('.htm')) {
    return fail('path-rejected', 'only .html/.htm artifacts are accepted')
  }

  const realCwd = await safeRealpath(cwd)
  const realRoot = await safeRealpath(allowedRoot)
  const absolute = isAbsolute(input) ? resolve(input) : resolve(realCwd, input)

  let file: string
  try {
    file = await realpath(absolute)
  } catch {
    return fail('path-rejected', 'artifact path does not exist')
  }

  if (!isInside(realRoot, file)) return fail('path-rejected', 'artifact real path escapes allowedRoot')
  const info = await stat(file)
  if (!info.isFile()) return fail('path-rejected', 'artifact path is not a regular file')

  const segments = file.slice(realRoot.length).split(sep).filter(Boolean)
  for (const segment of segments) {
    if (DENIED_PATH_SEGMENTS.has(segment)) {
      return fail('path-rejected', `artifact path must not pass through ${segment}`)
    }
  }
  return { ok: true, file }
}

async function safeRealpath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return resolve(path)
  }
}

/**
 * Minimal, explicit child environment. Nothing is inherited except PATH, so no
 * ambient `LAVISH_AXI_*` (host/telemetry/state overrides) or Tailscale variables
 * can reach the child. `HOME` points at the owned state directory so no global
 * `~/.lavish-axi` configuration or hook file can be read or written.
 */
export function buildChildEnvironment(stateDir: string, port: number): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: join(stateDir, 'home'),
    LAVISH_AXI_STATE_DIR: stateDir,
    LAVISH_AXI_PORT: String(port),
    LAVISH_AXI_HOST: LOOPBACK_HOST,
    LAVISH_AXI_LINK_HOST: LOOPBACK_HOST,
    LAVISH_AXI_TELEMETRY: '0',
    LAVISH_AXI_NO_OPEN: '1',
  }
}

export async function allocateUnusedLoopbackPort(): Promise<number> {
  const probe = createServer()
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      probe.once('error', rejectListen)
      probe.listen(0, LOOPBACK_HOST, resolveListen)
    })
    const address = probe.address()
    if (!address || typeof address === 'string') throw new LavishLocalError('invalid-options', 'no loopback port was allocated')
    return address.port
  } finally {
    await new Promise<void>((resolveClose) => probe.close(() => resolveClose()))
  }
}

async function fetchHealth(port: number): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`http://${LOOPBACK_HOST}:${port}/health`, {
      signal: AbortSignal.timeout(2_000),
    })
    if (!response.ok) return null
    const body: unknown = await response.json()
    return isPlainObject(body) ? body : null
  } catch {
    return null
  }
}

/**
 * Runs one CLI invocation in its own process group and always reaps it before
 * returning. Arguments are passed as an array with `shell: false`; no command
 * string is ever assembled.
 */
async function runOwnedProcess(
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number; maxStdoutBytes: number; maxStderrBytes: number },
): Promise<OwnedRun | LavishLocalFailure> {
  let child: ChildProcess
  try {
    child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    return fail('command-failed', 'the Lavish CLI could not be started')
  }

  const stdoutChunks: Buffer[] = []
  const stderrChunks: Buffer[] = []
  let stdoutBytes = 0
  let stderrBytes = 0
  let outputExceeded = false
  let timedOut = false

  const closePromise = new Promise<void>((resolveClose) => {
    child.once('close', () => resolveClose())
    child.once('error', () => resolveClose())
  })

  const kill = (reason: 'timeout' | 'overflow'): void => {
    if (reason === 'timeout') timedOut = true
    else outputExceeded = true
    void terminateOwnedGroup(child)
  }

  const timer = setTimeout(() => kill('timeout'), options.timeoutMs)
  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutBytes += chunk.length
    if (stdoutBytes > options.maxStdoutBytes) {
      kill('overflow')
      return
    }
    stdoutChunks.push(chunk)
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.length
    if (stderrBytes > options.maxStderrBytes) {
      kill('overflow')
      return
    }
    stderrChunks.push(chunk)
  })

  await closePromise
  clearTimeout(timer)

  if (timedOut) return fail('command-timeout', 'the Lavish CLI exceeded the adapter deadline')
  if (outputExceeded) return fail('output-too-large', 'the Lavish CLI wrote more bytes than the adapter accepts')

  return {
    exitCode: child.exitCode,
    stdout: Buffer.concat(stdoutChunks).toString('utf8'),
    stderr: Buffer.concat(stderrChunks).toString('utf8'),
    timedOut,
    outputExceeded,
  }
}

/** SIGTERM to the owned process group, then SIGKILL, then a bounded wait. */
async function terminateOwnedGroup(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  signalGroup(child, 'SIGTERM')
  if (await settledWithin(child, KILL_GRACE_MS)) return
  signalGroup(child, 'SIGKILL')
  await settledWithin(child, KILL_GRACE_MS)
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (pid !== undefined) {
    try {
      process.kill(-pid, signal)
      return
    } catch {
      // fall through to the direct kill below
    }
  }
  try {
    child.kill(signal)
  } catch {
    // the process is already gone
  }
}

function settledWithin(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise<boolean>((resolveSettled) => {
    const timer = setTimeout(() => resolveSettled(false), ms)
    child.once('close', () => {
      clearTimeout(timer)
      resolveSettled(true)
    })
  })
}

function decodeCliOutput(stdout: string): { value: Record<string, unknown> } | LavishLocalFailure {
  let decoded: unknown
  try {
    decoded = decode(stdout)
  } catch {
    return fail('malformed-output', 'the Lavish CLI stdout was not decodable TOON')
  }
  if (!isPlainObject(decoded)) return fail('malformed-output', 'the Lavish CLI stdout was not a TOON object')
  return { value: decoded }
}

function cliFailure(body: Record<string, unknown>): LavishLocalFailure {
  const code = readString(body.code) ?? 'UNKNOWN'
  const message = readString(body.error) ?? 'the Lavish CLI reported an error'
  return fail('command-failed', `${bound(code, 64)}: ${bound(redact(message), MAX_DETAIL_CHARS)}`)
}

function projectFeedback(body: Record<string, unknown>): LavishUntrustedFeedback {
  const rawPrompts = Array.isArray(body.prompts) ? body.prompts : []
  const prompts: LavishPrompt[] = []
  for (const raw of rawPrompts.slice(0, MAX_PROMPTS)) {
    const record = readRecord(raw)
    if (!record) continue
    const target = readRecord(record.target)
    const attachments: LavishAttachmentRef[] = []
    if (Array.isArray(record.attachments)) {
      for (const rawRef of record.attachments.slice(0, MAX_ATTACHMENT_REFS_PER_PROMPT)) {
        const ref = readRecord(rawRef)
        const id = ref ? readString(ref.id) : null
        if (!id) continue
        attachments.push({ id: bound(id, 128), name: bound(ref ? readString(ref.name) ?? '' : '', 256) })
      }
    }
    prompts.push({
      uid: bound(readString(record.uid) ?? '', 128),
      tag: bound(readString(record.tag) ?? '', 64),
      selector: bound(readString(record.selector) ?? '', 512),
      text: bound(readString(record.text) ?? '', MAX_PROMPT_FIELD_CHARS),
      ...(target && readString(target.type) ? { target: { type: bound(readString(target.type) as string, 64) } } : {}),
      attachments,
    })
  }

  const rawFailures = Array.isArray(body.artifact_failures) ? body.artifact_failures : []
  const artifactFailures: LavishArtifactFailure[] = []
  for (const raw of rawFailures.slice(0, MAX_ARTIFACT_FAILURES)) {
    const record = readRecord(raw)
    if (!record) continue
    artifactFailures.push({
      kind: bound(readString(record.kind) ?? '', 64),
      detail: bound(readString(record.detail) ?? '', MAX_PROMPT_FIELD_CHARS),
    })
  }

  const rawSnapshot = readString(body.dom_snapshot) ?? ''
  const snapshotBytes = Buffer.byteLength(rawSnapshot, 'utf8')
  const domSnapshot = snapshotBytes > MAX_DOM_SNAPSHOT_BYTES
    ? Buffer.from(rawSnapshot, 'utf8').subarray(0, MAX_DOM_SNAPSHOT_BYTES).toString('utf8')
    : rawSnapshot

  return {
    trust: 'untrusted',
    prompts,
    promptsTruncated: rawPrompts.length > prompts.length,
    artifactFailures,
    artifactFailuresTruncated: rawFailures.length > artifactFailures.length,
    domSnapshot,
    domSnapshotTruncated: snapshotBytes > MAX_DOM_SNAPSHOT_BYTES,
  }
}

function normalizePollStatus(raw: string | null): LavishPollStatus | null {
  if (raw === 'waiting' || raw === 'feedback' || raw === 'ended') return raw
  if (raw === 'browser_disconnected') return 'browser-disconnected'
  return null
}

function isLoopbackSessionUrl(url: string, port: number): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:'
      && parsed.hostname === LOOPBACK_HOST
      && parsed.port === String(port)
      && /^\/session\/[0-9a-f]{16}$/.test(parsed.pathname)
  } catch {
    return false
  }
}

/** Strips the opaque session access key so no caller can log it by accident. */
export function redactLavishSessionUrl(text: string): string {
  return text.replace(SESSION_URL_RE, '/session/[redacted]')
}

function redact(text: string): string {
  return redactLavishSessionUrl(text)
}

function bound(value: string, maxChars: number): string {
  return value.length > maxChars ? value.slice(0, maxChars) : value
}

function quote(value: string | null): string {
  return value === null ? 'null' : `${bound(redact(value), 64)}`
}

function fail(code: LavishLocalErrorCode, detail: string): LavishLocalFailure {
  return { ok: false, kind: 'error', code, detail: bound(redact(detail), MAX_DETAIL_CHARS) }
}

function invalidOptions(detail: string): LavishLocalError {
  return new LavishLocalError('invalid-options', detail)
}

async function requireDirectory(value: unknown, label: string): Promise<string> {
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) {
    throw invalidOptions(`${label} must be an absolute path`)
  }
  let resolved: string
  try {
    resolved = await realpath(value)
  } catch {
    throw invalidOptions(`${label} does not exist`)
  }
  const info = await stat(resolved)
  if (!info.isDirectory()) throw invalidOptions(`${label} is not a directory`)
  return resolved
}

function requirePort(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw invalidOptions('port must be an integer in [1, 65535]')
  }
  return value
}

function positiveInt(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw invalidOptions(`${label} must be a positive integer`)
  }
  return value
}

function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return false
  return candidate.startsWith(root.endsWith(sep) ? root : root + sep)
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return isPlainObject(value) ? value : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}
