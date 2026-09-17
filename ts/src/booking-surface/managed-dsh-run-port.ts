import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type { DshPlannerRunPort, DshPlannerRunResult } from './dsh-planner.ts'

export interface ManagedDshRunPortOptions {
  cwd?: string
  workerPath?: string
  graceMs?: number
  env?: NodeJS.ProcessEnv
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
  private inputBuffer = ''

  constructor(options: ManagedDshRunPortOptions = {}) {
    const defaultWorker = join(dirname(fileURLToPath(import.meta.url)), 'dsh-worker.js')
    const workerPath = options.workerPath ?? (existsSync(defaultWorker) ? defaultWorker : defaultWorker.replace(/\.js$/, '.ts'))
    const { workerPath: _worker, graceMs = 500, env, ...harnessOptions } = options
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
      () => this.failPending(new Error('managed DSH worker exited')),
      (error: unknown) => this.failPending(error instanceof Error ? error : new Error(String(error))),
    )
    // Credentials are already in the managed worker environment. Never copy
    // them into the JSON-lines protocol or a thrown worker error.
    this.harnessOptions = harnessOptions
    this.cleanupDeadlineMs = Math.max(1_000, graceMs * 4)
  }

  private readonly harnessOptions: Record<string, unknown>
  private readonly cleanupDeadlineMs: number

  private consume(chunk: string): void {
    this.inputBuffer += chunk
    for (;;) {
      const newline = this.inputBuffer.indexOf('\n')
      if (newline < 0) return
      const line = this.inputBuffer.slice(0, newline); this.inputBuffer = this.inputBuffer.slice(newline + 1)
      try {
        const message = JSON.parse(line) as { id: number; ok?: boolean; progress?: boolean; result?: DshPlannerRunResult; error?: string }
        if (message.progress) {
          this.pending.get(message.id)?.progress?.()
          continue
        }
        const waiter = this.pending.get(message.id); if (!waiter) continue
        this.pending.delete(message.id)
        if (message.ok) waiter.ok(message.result)
        else waiter.fail(new Error(message.error === 'HARNESS_START_FAILED' ? message.error : 'HARNESS_RUN_FAILED'))
      } catch (error) { this.failPending(error instanceof Error ? error : new Error(String(error))) }
    }
  }

  private failPending(error: Error): void {
    for (const waiter of Object.values(this.pending)) waiter.fail(error)
    this.pending.clear()
  }

  run(prompt: string, options: { sessionId: string; onProgress?: () => void }): Promise<DshPlannerRunResult> {
    if (this.closePromise) return Promise.reject(new Error('managed DSH run port is closed'))
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      this.pending.set(id, { ok: (value) => resolve(value as DshPlannerRunResult), fail: reject, progress: options.onProgress })
      this.handle.stdin!.write(`${JSON.stringify({ id, prompt, sessionId: options.sessionId, options: this.harnessOptions })}\n`)
    })
  }

  /** Boot the in-worker harness without consuming a provider call. */
  warmup(): Promise<void> {
    if (this.closePromise) return Promise.reject(new Error('managed DSH run port is closed'))
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      this.pending.set(id, { ok: () => resolve(), fail: reject })
      this.handle.stdin!.write(`${JSON.stringify({ id, warmup: true, options: this.harnessOptions })}\n`)
    })
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closePromise = (async () => {
      this.failPending(new Error('managed DSH run port closed'))
      this.handle.terminate()
      const outcome = this.handle.done.then(
        () => undefined,
        () => { throw new Error('managed DSH worker failed') },
      )
      const rangeEmpty = await this.handle.waitForExit(AbortSignal.timeout(this.cleanupDeadlineMs))
      if (!rangeEmpty) throw new Error('managed DSH process tree cleanup timeout')
      await outcome
    })()
    return this.closePromise
  }
}

export function createManagedDshRunPort(options?: ManagedDshRunPortOptions): DshPlannerRunPort {
  return new ManagedDshRunPort(options)
}
