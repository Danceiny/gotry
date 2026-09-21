import { createInterface } from 'node:readline'
import { DeepSeekHarness, RequestTimeoutError, type DeepSeekHarnessOptions } from '@deepseek-ai/dsh-sdk-client'

type Request = { id: number; prompt?: string; sessionId?: string; warmup?: boolean; options?: Record<string, unknown> }

/**
 * What one worker request paid for the SDK initialize handshake: the wall time
 * of the handshake when this request performed it, and zero when the harness
 * was already initialized. Our own process boot has to stay cheap next to the
 * provider budget, so it is measured at the seam that owns it.
 */
type BootObservation = { initializeMs: number; mode: 'started' | 'reused' }

/**
 * The initialize handshake carries its own deadline (the planner sets it), so
 * an expiry here is a statement about our own runtime, not about the provider.
 * It is typed apart from a hard start failure so a caller can never read a
 * local boot timeout as a model stall.
 */
function isHandshakeTimeout(error: unknown): boolean {
  if (error instanceof RequestTimeoutError) return true
  return error instanceof AggregateError && error.errors.some(isHandshakeTimeout)
}

/**
 * Closed classification for a failed request. While no handshake has completed,
 * the failure belongs to our own runtime boot; once one has, it belongs to the
 * run that followed it.
 */
function failureCode(warmup: boolean, error: unknown): string {
  if (!booted) return isHandshakeTimeout(error) ? 'HARNESS_BOOT_TIMEOUT' : 'HARNESS_START_FAILED'
  return warmup ? 'HARNESS_START_FAILED' : 'HARNESS_RUN_FAILED'
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
let harness: DeepSeekHarness | undefined
let booted: { initializeMs: number; mode: 'started' } | undefined
let chain = Promise.resolve()

function reply(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

/**
 * Start the runtime once and report what this request paid for it. `start()` is
 * memoized by the SDK, so awaiting it before the first run neither spawns twice
 * nor changes the classification a failed start produces.
 */
async function startTimed(): Promise<BootObservation> {
  if (booted) return { initializeMs: 0, mode: 'reused' }
  const startedAt = Date.now()
  await harness!.start()
  booted = { initializeMs: Date.now() - startedAt, mode: 'started' }
  return booted
}

// The public subprocess handle deliberately hides its PID. This private
// worker-owned receipt identifies the group when teardown diagnostics fail.
reply({ lifecycle: 'worker_started', workerPid: process.pid, parentPid: process.ppid })

async function handle(request: Request): Promise<void> {
  try {
    harness ??= new DeepSeekHarness((request.options ?? {}) as DeepSeekHarnessOptions)
    // Construction is lazy. Only start() spawns the runtime and awaits its
    // initialize handshake, including the profile, patches and plugins.
    const boot = await startTimed()
    // The handshake is known before the run can stall or be killed, so it is
    // reported as its own checkpoint instead of only on a terminal reply: a
    // cold boot that then times out must still show what the boot cost.
    process.stdout.write(`${JSON.stringify({ id: request.id, boot })}\n`)
    if (request.warmup) {
      reply({ id: request.id, ok: true })
      return
    }
    const result = await harness.run(request.prompt!, {
      sessionId: request.sessionId!,
      // Stream liveness to the parent: every notification (model step, tool
      // call, receipt) resets the parent's idle-stall timer, so a healthy
      // multi-step run is never mistaken for a hung stream.
      onNotification: () => {
        process.stdout.write(`${JSON.stringify({ id: request.id, progress: true })}\n`)
      },
    })
    reply({ id: request.id, ok: true, result })
  } catch (error) {
    // Raw SDK/provider exceptions may contain URLs, model output or request
    // fragments. Only a closed classification crosses the worker protocol.
    reply({ id: request.id, ok: false, error: failureCode(request.warmup === true, error) })
  }
}

input.on('line', (line) => {
  if (line.trim() === '') return
  let request: Request
  try { request = JSON.parse(line) as Request } catch {
    reply({ id: null, ok: false, error: 'INVALID_WORKER_REQUEST' })
    return
  }
  chain = chain.then(() => handle(request!))
})

async function shutdown(): Promise<void> {
  input.close()
  await chain
  await harness?.close()
}

process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(143)) })
process.once('SIGINT', () => { void shutdown().finally(() => process.exit(130)) })
process.stdin.once('end', () => { void shutdown().finally(() => process.exit(0)) })
