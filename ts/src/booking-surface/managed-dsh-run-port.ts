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

export interface ManagedDshRunPortOptions {
  cwd?: string
  workerPath?: string
  graceMs?: number
  cleanupRole?: 'task' | 'warmer'
  env?: NodeJS.ProcessEnv
  /** Test seam overriding the failure-path group snapshot; production uses the safe ps snapshot. */
  groupObserver?: typeof snapshotManagedDshGroup
  [key: string]: unknown
}

const requireFromModule = createRequire(import.meta.url)

function workerLaunch(path: string): readonly string[] {
  // The worker cwd is the isolated booking state root, so a bare `tsx/esm`
  // loader would resolve from the wrong dependency tree and exit before the
  // first request. Resolve the loader from this package once and pass its
  // absolute installed path to Node.
  return path.endsWith('.ts')
    ? [process.execPath, '--import', requireFromModule.resolve('tsx/esm'), path]
    : [process.execPath, path]
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
    const { workerPath: _worker, graceMs = 500, cleanupRole, env, groupObserver, ...harnessOptions } = options
    this.cleanupRole = cleanupRole ?? 'unspecified'
    this.graceMs = graceMs
    this.groupObserver = groupObserver ?? snapshotManagedDshGroup
    this.runtime = new LocalSubprocessRuntime(new Context())
    this.handle = this.runtime.spawn({
      argv: workerLaunch(workerPath),
      cwd: options.cwd ?? process.cwd(),
      // Provider diagnostics may contain request fragments. Keep a bounded
      // private tail for ownership without inheriting it into service logs.
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 64 * 1024 } },
      graceMs,
      env,
    })
    this.handle.stdout!.setEncoding('utf8')
    this.handle.stdout!.on('data', (chunk: string) => this.consume(chunk))
    this.handle.done.then(
      (outcome) => {
        this.workerOutcome = { state: 'exited', exitCode: outcome.exitCode, signal: outcome.signal }
        this.markTerminal('managed DSH worker exited')
      },
      () => {
        this.workerOutcome = { state: 'failed' }
        this.markTerminal('managed DSH worker failed')
      },
    )
    // Credentials are already in the managed worker environment. Never copy
    // them into the JSON-lines protocol or a thrown worker error.
    this.harnessOptions = harnessOptions
    this.cleanupDeadlineMs = Math.max(1_000, graceMs * 4)
  }

  private readonly harnessOptions: Record<string, unknown>
  private readonly cleanupDeadlineMs: number
  private readonly groupObserver: typeof snapshotManagedDshGroup
  private booted: DshBootObservation | undefined

  /**
   * What the most recent worker request paid for the initialize handshake: the
   * measured wall time when that request started the runtime, and zero when an
   * earlier request in the same worker already had. Read by the planner to keep
   * our own boot cost separate from the provider budget it must not consume.
   */
  bootObservation(): DshBootObservation | undefined {
    return this.booted
  }

  private consume(chunk: string): void {
    this.inputBuffer += chunk
    for (;;) {
      const newline = this.inputBuffer.indexOf('\n')
      if (newline < 0) return
      const line = this.inputBuffer.slice(0, newline); this.inputBuffer = this.inputBuffer.slice(newline + 1)
      try {
        const message = JSON.parse(line) as { id: number; ok?: boolean; progress?: boolean; result?: DshPlannerRunResult; error?: string; lifecycle?: string; workerPid?: number; parentPid?: number; boot?: DshBootObservation }
        if (message.lifecycle === 'worker_started') {
          if (this.workerPid === null && Number.isSafeInteger(message.workerPid) && message.workerPid! > 0 && message.parentPid === process.pid) {
            this.workerPid = message.workerPid!
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
          if (message.ok === undefined) continue
        }
        const waiter = this.pending.get(message.id); if (!waiter) continue
        this.pending.delete(message.id)
        if (message.ok) waiter.ok(message.result)
        else waiter.fail(new Error(message.error === 'HARNESS_START_FAILED' ? message.error : 'HARNESS_RUN_FAILED'))
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
