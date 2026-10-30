import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type { DshBootObservation, DshPlannerRunPort, DshPlannerRunResult } from './dsh-planner.ts'
import {
  ManagedDshCleanupError,
  managedDshGroupIsQuiescent,
  readManagedDshWorkerStart,
  snapshotManagedDshGroup,
  type ManagedDshProcessGroupSnapshot,
  type ManagedDshWorkerOutcome,
} from './managed-dsh-cleanup-diagnostic.ts'
import { sharedProcessTreeGovernor, type ProcessTreeGovernor, type TreeBreach } from '../tenant-seam/process-governor.ts'

/**
 * What one worker tree may take (AaaS, docs/rfc/aaas-rfc.md §4.8, threat S-17). Every field is opt-in: a port built
 * without `limits` behaves exactly as before.
 */
export interface ManagedDshResourceLimits {
  /** V8 old-space ceiling in MiB for the worker and every Node process below it (`NODE_OPTIONS`). An allocation spike dies in-process. */
  heapMb?: number
  /** Resident set of the whole worker tree in bytes (sampled; see `ProcessTreeGovernor`). Covers what the heap cap cannot see, such as buffers. */
  maxRssBytes?: number
  /** CPU seconds of the whole worker tree (sampled). */
  maxCpuSeconds?: number
  /** The longest line, in characters, the worker may write to the parent without a newline. The parent buffers a line until it ends. */
  maxLineChars?: number
  /**
   * How long a worker may take to say who it is (its `worker_started` line) before the missing governor is reported. The
   * sampler learns which process to watch from that line alone: without it the tree limits are silently off. Default 10 s.
   */
  attachDeadlineMs?: number
  /** Sampler shared by ports. Default: the process-wide governor. */
  governor?: ProcessTreeGovernor
}

/**
 * `memory` and `cpu` come from the tree sampler, `output` from the line cap, `heap` from the worker's own V8 ceiling
 * (recognised from its stderr tail after it died, where only the ceiling is known and `observed` repeats it).
 */
export type ManagedDshResourceBreach = TreeBreach | { readonly kind: 'output' | 'heap'; readonly limit: number; readonly observed: number }

/** The worker tree went over a resource limit and was killed. Closed shape: kind and numbers only, never worker output. */
export class ManagedDshResourceLimitError extends Error {
  readonly breach: ManagedDshResourceBreach

  constructor(breach: ManagedDshResourceBreach) {
    super(`managed DSH worker exceeded its ${breach.kind} limit`)
    this.name = 'ManagedDshResourceLimitError'
    this.breach = breach
  }
}

function assertPositiveLimit(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new RangeError(`managed DSH limit ${name} must be a positive number`)
}

function limitedEnvironment(env: NodeJS.ProcessEnv | undefined, heapMb: number | undefined): NodeJS.ProcessEnv | undefined {
  if (heapMb === undefined) return env
  const existing = (env?.NODE_OPTIONS ?? '').split(/\s+/).filter((option) => option !== '' && !option.startsWith('--max-old-space-size='))
  return { ...env, NODE_OPTIONS: [...existing, `--max-old-space-size=${Math.floor(heapMb)}`].join(' ') }
}

export interface ManagedDshRunPortOptions {
  cwd?: string
  workerPath?: string
  graceMs?: number
  cleanupRole?: 'task' | 'warmer'
  env?: NodeJS.ProcessEnv
  /** Resource ceilings for the worker tree. Absent: none, as before. */
  limits?: ManagedDshResourceLimits
  /** Test seam overriding the failure-path group snapshot; production uses the safe ps snapshot. */
  groupObserver?: typeof snapshotManagedDshGroup
  /**
   * Boot-marker channel (#511): receives one `HARNESS_BOOT_STAGE …` line per
   * completed initialize handshake and one `HARNESS_BOOT_TIMEOUT …` line when
   * the worker's own handshake deadline expires. Defaults to process stderr —
   * the serving process log surface these markers were missing from.
   */
  bootLog?: (line: string) => void
  [key: string]: unknown
}

/** The only worker failure classifications allowed to cross the process boundary. */
const WORKER_FAILURE_CODES = new Set(['HARNESS_BOOT_TIMEOUT', 'HARNESS_START_FAILED', 'HARNESS_RUN_FAILED'])

const requireFromModule = createRequire(import.meta.url)

function workerLaunch(path: string, heapMb?: number): readonly string[] {
  // The V8 ceiling is given on the worker's own command line as well as in NODE_OPTIONS (which carries it to the
  // processes below the worker), so the worker's ceiling does not depend on its environment surviving a scrub.
  const heap = heapMb === undefined ? [] : [`--max-old-space-size=${Math.floor(heapMb)}`]
  // The worker cwd is the isolated booking state root, so a bare `tsx/esm`
  // loader would resolve from the wrong dependency tree and exit before the
  // first request. Resolve the loader from this package once and pass its
  // absolute installed path to Node.
  return path.endsWith('.ts')
    ? [process.execPath, ...heap, '--import', requireFromModule.resolve('tsx/esm'), path]
    : [process.execPath, ...heap, path]
}

/** Run DeepSeekHarness in a child tree owned by dsh-subprocess-local. */
export class ManagedDshRunPort implements DshPlannerRunPort {
  private readonly handle: SubprocessHandle
  private readonly runtime: LocalSubprocessRuntime
  private readonly pending = new Map<number, { ok: (value?: DshPlannerRunResult) => void; fail: (error: Error) => void; progress?: () => void }>()
  private sequence = 0
  private closePromise: Promise<void> | undefined
  private terminalError: Error | undefined
  private inputBuffer = ''
  private workerPid: number | null = null
  private workerStartedAt: string | null = null
  private workerOutcome: ManagedDshWorkerOutcome = { state: 'pending' }
  private readonly cleanupRole: 'task' | 'warmer' | 'unspecified'
  private readonly graceMs: number

  constructor(options: ManagedDshRunPortOptions = {}) {
    const defaultWorker = join(dirname(fileURLToPath(import.meta.url)), 'dsh-worker.js')
    const workerPath = options.workerPath ?? (existsSync(defaultWorker) ? defaultWorker : defaultWorker.replace(/\.js$/, '.ts'))
    const { workerPath: _worker, graceMs = 500, cleanupRole, env, groupObserver, bootLog, limits, ...harnessOptions } = options
    assertPositiveLimit('heapMb', limits?.heapMb)
    assertPositiveLimit('maxRssBytes', limits?.maxRssBytes)
    assertPositiveLimit('maxCpuSeconds', limits?.maxCpuSeconds)
    assertPositiveLimit('maxLineChars', limits?.maxLineChars)
    assertPositiveLimit('attachDeadlineMs', limits?.attachDeadlineMs)
    this.limits = limits
    this.cleanupRole = cleanupRole ?? 'unspecified'
    this.graceMs = graceMs
    this.groupObserver = groupObserver ?? snapshotManagedDshGroup
    this.bootLog = bootLog ?? ((line: string) => { process.stderr.write(`${line}\n`) })
    this.constructedAtMs = Date.now()
    this.runtime = new LocalSubprocessRuntime(new Context())
    this.handle = this.runtime.spawn({
      argv: workerLaunch(workerPath, limits?.heapMb),
      cwd: options.cwd ?? process.cwd(),
      // Provider diagnostics may contain request fragments. Keep a bounded
      // private tail for ownership without inheriting it into service logs.
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 64 * 1024 } },
      graceMs,
      env: limitedEnvironment(env, limits?.heapMb),
    })
    this.handle.stdout!.setEncoding('utf8')
    this.handle.stdout!.on('data', (chunk: string) => this.consume(chunk))
    if (limits && (limits.maxRssBytes !== undefined || limits.maxCpuSeconds !== undefined)) {
      const deadlineMs = limits.attachDeadlineMs ?? 10_000
      this.attachTimer = setTimeout(() => {
        this.emitBootLog(`RESOURCE_GOVERNOR_UNATTACHED ${JSON.stringify({ role: this.cleanupRole, afterMs: deadlineMs })}`)
      }, deadlineMs)
      this.attachTimer.unref()
    }
    this.handle.done.then(
      (outcome) => {
        this.stopWatching()
        this.workerOutcome = { state: 'exited', exitCode: outcome.exitCode, signal: outcome.signal }
        this.noteHeapExhaustion()
        this.markTerminal('managed DSH worker exited')
      },
      () => {
        this.stopWatching()
        this.workerOutcome = { state: 'failed' }
        this.markTerminal('managed DSH worker failed')
      },
    )
    // Credentials are already in the managed worker environment. Never copy
    // them into the JSON-lines protocol or a thrown worker error.
    this.harnessOptions = harnessOptions
    this.cleanupDeadlineMs = Math.max(1_000, graceMs * 4)
  }

  private readonly limits: ManagedDshResourceLimits | undefined
  private attachTimer: NodeJS.Timeout | undefined
  private unwatchTree: (() => void) | undefined
  private readonly harnessOptions: Record<string, unknown>
  private readonly cleanupDeadlineMs: number
  private readonly groupObserver: typeof snapshotManagedDshGroup
  private readonly bootLog: (line: string) => void
  private readonly constructedAtMs: number
  private booted: DshBootObservation | undefined

  /**
   * #511: surface the boot markers in the serving process. The four startup
   * marker families previously existed only in build-time proof output, so a
   * recurrence in service runtime left nothing to grep. Payloads are closed
   * shapes only — role, timings; never prompts, provider fragments, or
   * credentials.
   */
  private emitBootLog(line: string): void {
    try {
      this.bootLog(line)
    } catch { /* boot markers must never break the worker protocol */ }
  }

  /**
   * What the most recent worker request paid for the initialize handshake: the
   * measured wall time when that request started the runtime, and zero when an
   * earlier request in the same worker already had. Read by the planner to keep
   * our own boot cost separate from the provider budget it must not consume.
   */
  bootObservation(): DshBootObservation | undefined {
    return this.booted
  }

  /**
   * A resource ceiling was crossed: say why before anything else can say something vaguer, fail what is waiting with
   * that reason, and let the provider-owned range cleanup run. The governor (or the line cap) then kills the tree.
   */
  private resourceBreach(breach: ManagedDshResourceBreach): void {
    this.terminalError ??= new ManagedDshResourceLimitError(breach)
    this.failPending(this.terminalError)
    this.stopWatching()
    this.inputBuffer = ''
    try { this.handle.terminate() } catch { /* the governor's kill below is what must happen */ }
  }

  private stopWatching(): void {
    clearTimeout(this.attachTimer)
    this.attachTimer = undefined
    const unwatch = this.unwatchTree
    this.unwatchTree = undefined
    unwatch?.()
  }

  /**
   * A worker that died of its own V8 ceiling is a resource-limit death, not a mystery crash. Only the fixed V8 message is
   * looked for in the bounded stderr tail; nothing from it is kept or reported.
   */
  private noteHeapExhaustion(): void {
    const heapMb = this.limits?.heapMb
    if (heapMb === undefined || this.terminalError) return
    let tail = ''
    try { tail = this.handle.collected.stderr?.readFrom(0).text ?? '' } catch { return }
    if (!tail.includes('JavaScript heap out of memory')) return
    const bytes = Math.floor(heapMb) * 1024 * 1024
    this.terminalError = new ManagedDshResourceLimitError({ kind: 'heap', limit: bytes, observed: bytes })
  }

  private watchTree(workerPid: number): void {
    const limits = this.limits
    if (!limits || (limits.maxRssBytes === undefined && limits.maxCpuSeconds === undefined)) return
    clearTimeout(this.attachTimer)
    this.attachTimer = undefined
    const governor = limits.governor ?? sharedProcessTreeGovernor()
    // The worker is this process's own child (the lifecycle line was checked for that), so the governor also requires
    // the parent to match: a pid the operating system reused for something else is never sampled or killed.
    this.unwatchTree = governor.watch(
      { rootPid: workerPid, parentPid: process.pid },
      { maxRssBytes: limits.maxRssBytes, maxCpuSeconds: limits.maxCpuSeconds },
      (breach) => this.resourceBreach(breach),
    )
  }

  private consume(chunk: string): void {
    if (this.terminalError instanceof ManagedDshResourceLimitError) return
    this.inputBuffer += chunk
    for (;;) {
      const newline = this.inputBuffer.indexOf('\n')
      if (newline < 0) {
        // The parent holds a line until it ends; a worker that never ends one would grow this process without bound.
        const maxLineChars = this.limits?.maxLineChars
        if (maxLineChars !== undefined && this.inputBuffer.length > maxLineChars) {
          this.resourceBreach({ kind: 'output', limit: maxLineChars, observed: this.inputBuffer.length })
          // The worker stays up until the provider range cleanup lands; this port no longer reads from it.
        }
        return
      }
      const line = this.inputBuffer.slice(0, newline); this.inputBuffer = this.inputBuffer.slice(newline + 1)
      try {
        const message = JSON.parse(line) as { id: number; ok?: boolean; progress?: boolean; result?: DshPlannerRunResult; error?: string; lifecycle?: string; workerPid?: number; parentPid?: number; boot?: DshBootObservation }
        if (message.lifecycle === 'worker_started') {
          if (this.workerPid === null && Number.isSafeInteger(message.workerPid) && message.workerPid! > 0 && message.parentPid === process.pid) {
            this.workerPid = message.workerPid!
            this.watchTree(this.workerPid)
            // One bounded read-only start-time anchor, captured while the worker
            // is alive, so a later failure snapshot can disprove PID reuse.
            void readManagedDshWorkerStart(this.workerPid).then((startedAt) => {
              if (this.workerStartedAt === null) this.workerStartedAt = startedAt
            })
          }
          continue
        }
        if (message.progress) {
          this.pending.get(message.id)?.progress?.()
          continue
        }
        // A boot checkpoint carries the initialize handshake the worker already
        // completed; the terminal reply for the same request still follows, and
        // a request killed after booting has left this measurement behind.
        if (message.boot) {
          this.booted = message.boot
          // One line per real subprocess boot (#511): only a 'started'
          // handshake measured an initialize; 'reused' rode an earlier one.
          if (message.boot.mode === 'started') {
            this.emitBootLog(`HARNESS_BOOT_STAGE ${JSON.stringify({ role: this.cleanupRole, initializeMs: message.boot.initializeMs, mode: 'started' })}`)
          }
          if (message.ok === undefined) continue
        }
        const waiter = this.pending.get(message.id); if (!waiter) continue
        this.pending.delete(message.id)
        if (message.ok) waiter.ok(message.result)
        // Worker stdout is a process boundary: an arbitrary payload must never
        // become the error the planner classifies on.
        else if (typeof message.error === 'string' && WORKER_FAILURE_CODES.has(message.error)) {
          if (message.error === 'HARNESS_BOOT_TIMEOUT') {
            // The worker's own initialize deadline expired before any handshake
            // completed; record the closed classification plus what this port
            // observable spent on it (closeMs belongs to cleanup diagnostics).
            this.emitBootLog(`HARNESS_BOOT_TIMEOUT ${JSON.stringify({
              role: this.cleanupRole,
              elapsedMs: Date.now() - this.constructedAtMs,
              initializeMs: this.booted?.initializeMs ?? null,
            })}`)
          }
          waiter.fail(new Error(message.error))
        }
        else waiter.fail(new Error('HARNESS_RUN_FAILED'))
      } catch (error) { this.failPending(error instanceof Error ? error : new Error(String(error))) }
    }
  }

  private failPending(error: Error): void {
    for (const waiter of this.pending.values()) waiter.fail(error)
    this.pending.clear()
  }

  private markTerminal(message: string): void {
    // Retain a safe terminal outcome before rejecting existing waiters: their
    // continuations may immediately submit another request to this same port.
    this.terminalError ??= new Error(message)
    this.failPending(this.terminalError)
  }

  run(prompt: string, options: { sessionId: string; onProgress?: () => void }): Promise<DshPlannerRunResult> {
    if (this.closePromise) return Promise.reject(new Error('managed DSH run port is closed'))
    if (this.terminalError) return Promise.reject(this.terminalError)
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      this.pending.set(id, { ok: (value) => resolve(value as DshPlannerRunResult), fail: reject, progress: options.onProgress })
      this.handle.stdin!.write(`${JSON.stringify({ id, prompt, sessionId: options.sessionId, options: this.harnessOptions })}\n`)
    })
  }

  /** Boot the in-worker harness without consuming a provider call. */
  warmup(): Promise<void> {
    if (this.closePromise) return Promise.reject(new Error('managed DSH run port is closed'))
    if (this.terminalError) return Promise.reject(this.terminalError)
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      this.pending.set(id, { ok: () => resolve(), fail: reject })
      this.handle.stdin!.write(`${JSON.stringify({ id, warmup: true, options: this.harnessOptions })}\n`)
    })
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closePromise = (async () => {
      const started = performance.now()
      this.stopWatching()
      this.failPending(new Error('managed DSH run port closed'))
      this.handle.terminate()
      // Observe worker failure even if range observation rejects or times out
      // first. This derived promise must never become an unhandled rejection.
      const outcome = this.handle.done.then(
        () => undefined,
        () => new Error('managed DSH worker failed'),
      )
      let rangeEmpty: boolean
      try {
        rangeEmpty = await this.handle.waitForExit(AbortSignal.timeout(this.cleanupDeadlineMs))
      } catch {
        throw await this.cleanupError('managed DSH process tree observation failed', started)
      }
      if (!rangeEmpty) {
        // On Darwin the installed detached fallback observes the group through
        // kill(-pgid, 0): a zombie-only group yields EPERM, which the runtime
        // maps to "alive", and zombies only disappear when their owner reaps
        // them — no signal can accelerate that. The deadline has not moved;
        // verify through the safe process table whether a live member actually
        // remains before converting the observation deadline into a failure.
        const processGroup = await this.groupObserver(this.workerPid, this.workerStartedAt)
        if (!managedDshGroupIsQuiescent(processGroup)) {
          throw await this.cleanupError('managed DSH process tree cleanup timeout', started, processGroup)
        }
      }
      if (await outcome) throw await this.cleanupError('managed DSH worker failed', started)
    })()
    return this.closePromise
  }

  private async cleanupError(message: string, started: number, processGroup?: ManagedDshProcessGroupSnapshot): Promise<ManagedDshCleanupError> {
    const elapsedMs = Math.round(performance.now() - started)
    const workerOutcome = { ...this.workerOutcome }
    const group = processGroup ?? await this.groupObserver(this.workerPid, this.workerStartedAt)
    return new ManagedDshCleanupError(message, {
      schemaVersion: 'managed-dsh-cleanup.v2', role: this.cleanupRole,
      workerPid: this.workerPid, elapsedMs, deadlineMs: this.cleanupDeadlineMs,
      graceMs: this.graceMs, workerOutcome, processGroup: group,
    })
  }
}

export function createManagedDshRunPort(options?: ManagedDshRunPortOptions): DshPlannerRunPort {
  return new ManagedDshRunPort(options)
}
