import { createInterface } from 'node:readline'
import { DeepSeekHarness, type DeepSeekHarnessOptions } from '@deepseek-ai/dsh-sdk-client'

type Request = { id: number; prompt?: string; sessionId?: string; warmup?: boolean; options?: Record<string, unknown> }

type BootObservation = { bootMs: number; bootMode: 'started' | 'reused' }

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
let harness: DeepSeekHarness | undefined
let chain = Promise.resolve()
// The initialize handshake is lazy — the SDK spawns the runtime on first use —
// so its cost lands inside whichever request arrives first and used to be
// indistinguishable from provider latency. Measure it once per worker process
// and let the parent separate local startup from the model budget.
let established = false
let boot: BootObservation | undefined

function reply(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

/**
 * Start the in-worker harness and record what the initialize handshake cost.
 * Every later call answers from the memoized handshake and reports `reused`
 * with no cost of its own. A rejected handshake is still reported so the
 * parent can see how long the local boot was given before it failed.
 */
async function startHarness(options?: Record<string, unknown>): Promise<DeepSeekHarness> {
  harness ??= new DeepSeekHarness((options ?? {}) as DeepSeekHarnessOptions)
  const active = harness
  if (established) {
    boot = { bootMs: 0, bootMode: 'reused' }
    return active
  }
  const startedAt = performance.now()
  try {
    await active.start()
  } catch (error) {
    boot = { bootMs: Math.round(performance.now() - startedAt), bootMode: 'started' }
    throw error
  }
  established = true
  boot = { bootMs: Math.round(performance.now() - startedAt), bootMode: 'started' }
  return active
}

// The public subprocess handle deliberately hides its PID. This private
// worker-owned receipt identifies the group when teardown diagnostics fail.
reply({ lifecycle: 'worker_started', workerPid: process.pid, parentPid: process.ppid })

async function handle(request: Request): Promise<void> {
  try {
    // Starting the harness explicitly (instead of letting run() do it) is what
    // makes the handshake measurable; start() is memoized, so a reused harness
    // costs nothing extra here.
    const active = await startHarness(request.options)
    if (request.warmup) {
      reply({ id: request.id, ok: true, boot })
      return
    }
    const result = await active.run(request.prompt!, {
      sessionId: request.sessionId!,
      // Stream liveness to the parent: every notification (model step, tool
      // call, receipt) resets the parent's idle-stall timer, so a healthy
      // multi-step run is never mistaken for a hung stream.
      onNotification: () => {
        process.stdout.write(`${JSON.stringify({ id: request.id, progress: true })}\n`)
      },
    })
    reply({ id: request.id, ok: true, result, boot })
  } catch {
    // Raw SDK/provider exceptions may contain URLs, model output or request
    // fragments. Only a closed classification crosses the worker protocol.
    reply({
      id: request.id,
      ok: false,
      error: request.warmup || !harness ? 'HARNESS_START_FAILED' : 'HARNESS_RUN_FAILED',
      ...(boot ? { boot } : {}),
    })
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
