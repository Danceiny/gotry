#!/usr/bin/env node
/** Standalone GoTry backend — one service, modules mount routes (booking-copilot, session-search). */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const entryPath = join(root, 'dist/src/gotry-backend.js')

function safeError(error) {
  let message = error instanceof Error ? error.message : String(error)
  for (const secret of [
    process.env.GOTRY_BOOKING_COPILOT_API_KEY,
    process.env.GOTRY_BACKEND_SESSION_API_KEY,
    process.env.DEEPSEEK_API_KEY,
    process.env.LLM_API_KEY,
  ]) {
    if (secret) message = message.replaceAll(secret, '[REDACTED]')
  }
  return message.slice(0, 512)
}

async function main() {
  if (!existsSync(entryPath)) throw new Error('gotry_backend_compiled_runtime_missing')
  const artifactPath = join(root, 'ARTIFACT_ID')
  if (existsSync(artifactPath)) {
    const artifactId = readFileSync(artifactPath, 'utf8').trim()
    if (!/^[0-9a-f]{40}$/.test(artifactId)) throw new Error('gotry_backend_artifact_id_invalid')
    process.env.GOTRY_BOOKING_COPILOT_ARTIFACT_ID = artifactId
  }
  const backend = await import(pathToFileURL(entryPath).href)
  const handle = await backend.startGotryBackendFromEnvironment(process.env)
  process.stderr.write(`[gotry-backend] modules=${handle.moduleNames.join(',')}\n`)

  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    void handle.close().then(() => process.exit(0), (error) => {
      process.stderr.write(`[gotry-backend] shutdown failed: ${safeError(error)}\n`)
      process.exit(1)
    })
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

main().catch((error) => {
  process.stderr.write(`[gotry-backend] startup failed: ${safeError(error)}\n`)
  process.exitCode = 1
})
