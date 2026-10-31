// A worker for the managed port's JSON-lines protocol that misbehaves on request (AaaS threat S-17 drill).
// Every runaway mode bounds itself, so a governor that fails costs a red test and not a dead machine.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const MIB = 1024 * 1024

if (process.env.TENANT_FIXTURE_PID_FILE) writeFileSync(process.env.TENANT_FIXTURE_PID_FILE, String(process.pid))
// TENANT_FIXTURE_NO_LIFECYCLE=1: a worker that never says who it is, so nothing can attach a governor to it.
if (process.env.TENANT_FIXTURE_NO_LIFECYCLE !== '1') {
  // TENANT_FIXTURE_LIE_PID=1: it names a process that is not its own, so a sampler that trusts it would watch nothing.
  const reported = process.env.TENANT_FIXTURE_LIE_PID === '1' ? 2_147_000_000 : process.pid
  process.stdout.write(`${JSON.stringify({ lifecycle: 'worker_started', workerPid: reported, parentPid: process.ppid })}\n`)
}

const hold = []
const input = createInterface({ input: process.stdin, crlfDelay: Infinity })

function reply(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

input.on('line', (line) => {
  const request = JSON.parse(line)
  // TENANT_FIXTURE_MODE lets a planner, which sends its own prompt text, drive the same behavior.
  const mode = process.env.TENANT_FIXTURE_MODE ?? request.prompt
  if (mode === 'ok') {
    reply({ id: request.id, ok: true, result: { finalResponse: 'ok', events: [{
      nodeOptions: process.env.NODE_OPTIONS ?? null,
      execArgv: process.execArgv,
      ambient: { LLM_BASE_URL: process.env.LLM_BASE_URL ?? null, LLM_API_KEY: process.env.LLM_API_KEY ?? null, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? null, DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL ?? null },
    }], notifications: [] } })
  } else if (mode === 'memory') {
    // Off-heap memory: the V8 heap cap cannot see a Buffer, so only the process-tree sampler can stop this one.
    let total = 0
    const timer = setInterval(() => {
      hold.push(Buffer.alloc(16 * MIB, 1))
      total += 16 * MIB
      if (total >= 1536 * MIB) clearInterval(timer)
    }, 10)
  } else if (mode === 'memory-in-child') {
    // The runaway is a descendant, not the worker: the tree is what is limited.
    const child = spawn(process.execPath, ['-e', `
      const hold = []; let total = 0
      const timer = setInterval(() => { hold.push(Buffer.alloc(${16 * MIB}, 1)); total += ${16 * MIB}; if (total >= ${1536 * MIB}) clearInterval(timer) }, 10)
    `], { stdio: 'ignore' })
    reply({ id: request.id, ok: true, result: { finalResponse: 'spawned', events: [{ childPid: child.pid }], notifications: [] } })
  } else if (mode === 'cpu') {
    // Blocks this thread's event loop; the check comes from outside. Gives up by itself after 30 s.
    const end = Date.now() + 30_000
    while (Date.now() < end) { /* spin */ }
  } else if (mode === 'heap') {
    // JS heap growth: the V8 ceiling in NODE_OPTIONS must end this long before the machine notices.
    const objects = []
    while (process.memoryUsage().heapUsed < 900 * MIB) objects.push({ filler: 'x'.repeat(1000) })
    reply({ id: request.id, ok: true, result: { finalResponse: 'heap-not-limited', events: [], notifications: [] } })
  } else if (mode === 'flood') {
    // One line that never ends, written as fast as the pipe takes it, up to 256 MiB.
    const chunk = 'x'.repeat(64 * 1024)
    let written = 0
    const write = () => {
      while (written < 256 * MIB) {
        written += chunk.length
        if (!process.stdout.write(chunk)) { process.stdout.once('drain', write); return }
      }
    }
    write()
  }
})

process.on('SIGTERM', () => process.exit(143))
setInterval(() => {}, 1_000)
