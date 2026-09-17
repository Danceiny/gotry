import { createInterface } from 'node:readline'
import { DeepSeekHarness, type DeepSeekHarnessOptions } from '@deepseek-ai/dsh-sdk-client'

type Request = { id: number; prompt?: string; sessionId?: string; warmup?: boolean; options?: Record<string, unknown> }

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
let harness: DeepSeekHarness | undefined
let chain = Promise.resolve()

function reply(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

async function handle(request: Request): Promise<void> {
  try {
    harness ??= new DeepSeekHarness((request.options ?? {}) as DeepSeekHarnessOptions)
    // The first harness construction loads the profile, patches and plugins —
    // the dominant share of a cold first turn. A warmup request pays that
    // boot cost without consuming a provider call.
    if (request.warmup) {
      reply({ id: request.id, ok: true })
      return
    }
    const result = await harness.run(request.prompt!, { sessionId: request.sessionId! })
    reply({ id: request.id, ok: true, result })
  } catch {
    // Raw SDK/provider exceptions may contain URLs, model output or request
    // fragments. Only a closed classification crosses the worker protocol.
    reply({ id: request.id, ok: false, error: harness ? 'HARNESS_RUN_FAILED' : 'HARNESS_START_FAILED' })
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
