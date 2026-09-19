import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { writeFileSync } from 'node:fs'

const pidFile = process.env.MANAGED_DSH_FIXTURE_PID_FILE
const statusFile = process.env.MANAGED_DSH_FIXTURE_STATUS_FILE
const requestFile = process.env.MANAGED_DSH_FIXTURE_REQUEST_FILE
const exitAfterRequests = Number(process.env.MANAGED_DSH_FIXTURE_EXIT_AFTER_REQUESTS ?? 0)
const exitCode = Number(process.env.MANAGED_DSH_FIXTURE_EXIT_CODE ?? 23)
const stderr = 'managed-fixture:controlled-exit'

const grandchild = exitAfterRequests > 0
  ? undefined
  : spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' })

if (pidFile) writeFileSync(pidFile, JSON.stringify({ workerPid: process.pid, grandchildPid: grandchild?.pid ?? null }))
process.stderr.write(`${stderr}\n`)

if (statusFile) {
  process.on('exit', (code) => {
    writeFileSync(statusFile, JSON.stringify({ exitCode: code, signal: null, stderr }))
  })
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
let requestCount = 0
input.on('line', () => {
  // Keep every run and warmup request pending until the owner closes this port.
  requestCount += 1
  if (requestFile) writeFileSync(requestFile, String(requestCount))
  if (exitAfterRequests > 0 && requestCount >= exitAfterRequests) process.exit(exitCode)
})

process.on('SIGTERM', () => {})
setInterval(() => {}, 1000)
