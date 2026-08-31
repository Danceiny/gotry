#!/usr/bin/env node
/** Standalone, BFF-only Booking Copilot HTTP/SSE service. */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const startupPath = join(root, 'dist/src/booking-surface/startup.js')

function safeError(error) {
  let message = error instanceof Error ? error.message : String(error)
  for (const secret of [
    process.env.GOTRY_BOOKING_COPILOT_API_KEY,
    process.env.DEEPSEEK_API_KEY,
    process.env.LLM_API_KEY,
  ]) {
    if (secret) message = message.replaceAll(secret, '[REDACTED]')
  }
  return message.slice(0, 512)
}

async function main() {
  if (!existsSync(startupPath)) throw new Error('booking_copilot_compiled_runtime_missing')
  const startup = await import(pathToFileURL(startupPath).href)
  const config = startup.resolveBookingCopilotStartupConfig(process.env)
  const handle = await startup.startBookingCopilotFromEnvironment(process.env)
  process.stderr.write(`[gotry-booking-copilot] listening on http://${config.host}:${handle.port}/a2a/booking-copilot/turn\n`)

  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    void handle.close().then(() => process.exit(0), (error) => {
      process.stderr.write(`[gotry-booking-copilot] shutdown failed: ${safeError(error)}\n`)
      process.exit(1)
    })
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

main().catch((error) => {
  process.stderr.write(`[gotry-booking-copilot] startup failed: ${safeError(error)}\n`)
  process.exitCode = 1
})
