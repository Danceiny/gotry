/**
 * Real multi-process proof for task-scoped Booking Copilot event sequencing.
 *
 * Run from the repository root with Node 24:
 *   npx tsx ts/scripts/booking-copilot-event-sequence-concurrency-proof-tests.ts
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureLedger } from '../src/state-ledger.ts'
import { BookingCopilotTaskRuntime, type UserTurnV1 } from '../src/booking-surface/runtime.ts'
import type { BookingWorkspaceSnapshotV1 } from '../src/booking-surface/contracts.ts'

const taskId = 'task-event-sequence-atomicity'
const workspace: BookingWorkspaceSnapshotV1 = {
  schemaVersion: 'booking.surface.v1', contextRef: 'ctx-event-sequence-atomicity', surface: 'tenant', revision: 0,
  locale: 'en-US', currency: 'AED', searchDraft: {}, results: { status: 'idle' }, visibleHotels: [], loadedOffers: [], shortlistedOfferRefs: [],
  capabilities: { surface: 'tenant', allowedActions: ['search.run'] },
}
const turn: UserTurnV1 = {
  schemaVersion: 'booking.surface.v1', kind: 'user.turn', taskId,
  workspace, request: { text: 'opaque user turn' },
}

type Mode = 'emit' | 'user-turn'
const childIndex = process.argv.indexOf('--child')
const child = childIndex >= 0
const childRoot = child ? process.argv[childIndex + 1]! : undefined
const childMode = child ? process.argv[childIndex + 2] as Mode : undefined
const childVariant = child ? process.argv[childIndex + 3]! : undefined

function sleepWhile(predicate: () => boolean, timeoutMs = 10_000): void {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('proof_barrier_timeout')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
  }
}

function waitForFile(path: string, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const poll = () => {
      if (existsSync(path)) return resolve()
      if (Date.now() > deadline) return reject(new Error(`proof_file_timeout:${path}`))
      setTimeout(poll, 5)
    }
    poll()
  })
}

function runChild(root: string, mode: Mode, variant: string): Promise<{ event?: { sequence: number }; error?: string }> {
  const script = fileURLToPath(import.meta.url)
  const tsx = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url))
  const processChild = spawn(process.execPath, [tsx, script, '--child', root, mode, variant], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  processChild.stdout.on('data', (chunk) => { output += chunk.toString() })
  processChild.stderr.on('data', (chunk) => { output += chunk.toString() })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      processChild.kill('SIGKILL')
      reject(new Error(`child_timeout:${mode}:${variant}:${output}`))
    }, 15_000)
    processChild.on('exit', (code) => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(`child_exit_${code}:${mode}:${variant}:${output}`))
      try { resolve(JSON.parse(output.trim().split('\n').at(-1)!)) }
      catch (error) { reject(new Error(`child_output_invalid:${mode}:${variant}:${output}:${error}`)) }
    })
  })
}

if (child) {
  const root = childRoot!
  const mode = childMode!
  const variant = childVariant!
  const ledger = ensureLedger(root)
  const runtime = new BookingCopilotTaskRuntime(ledger)
  writeFileSync(join(root, `started-${mode}-${variant}`), 'started')
  sleepWhile(() => existsSync(join(root, 'start')))

  // The old implementation read the task outside its write transaction. This
  // barrier makes both workers hold the same stale fold before either append;
  // an immediate transaction permits only one worker to reach this point.
  const originalResume = runtime.resumeTask.bind(runtime)
  let firstRead = true
  runtime.resumeTask = (id: string) => {
    const state = originalResume(id)
    if (firstRead && state) {
      firstRead = false
      writeFileSync(join(root, `ready-${mode}-${variant}`), 'ready')
      sleepWhile(() => existsSync(join(root, 'release')))
    }
    return state
  }

  try {
    if (mode === 'user-turn') runtime.startTask(turn)
    const event = runtime.emitEvent(taskId, { kind: 'status', status: 'working' })
    console.log(JSON.stringify({ event: { sequence: event.sequence } }))
  } catch (error) {
    console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    process.exitCode = 1
  } finally {
    ledger.close()
  }
} else {
  async function run(mode: Mode): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), `gotry-event-sequence-${mode}-`))
    mkdirSync(root, { recursive: true })
    const ledger = ensureLedger(root)
    new BookingCopilotTaskRuntime(ledger).startTask(turn)
    ledger.close()

    const children = [runChild(root, mode, 'left'), runChild(root, mode, 'right')]
    try {
      await Promise.all([
        waitForFile(join(root, `started-${mode}-left`)),
        waitForFile(join(root, `started-${mode}-right`)),
      ])
      writeFileSync(join(root, 'start'), 'start')
      await Promise.race([
        waitForFile(join(root, `ready-${mode}-left`)),
        waitForFile(join(root, `ready-${mode}-right`)),
      ])
      await new Promise((resolve) => setTimeout(resolve, 250))
      assert.equal(
        existsSync(join(root, `ready-${mode}-left`)) && existsSync(join(root, `ready-${mode}-right`)),
        false,
        `${mode} workers both derived state before the first transaction committed`,
      )
      writeFileSync(join(root, 'release'), 'release')
      const results = await Promise.all(children)
      assert.deepEqual(results.map((result) => result.error), [undefined, undefined])

      const check = ensureLedger(root)
      const rows = check.db.prepare(
        "SELECT payload FROM events WHERE tenant_id = ? AND run_id = ? AND kind = 'booking.copilot.event.emitted' ORDER BY seq",
      ).all(check.tenant, taskId) as Array<{ payload: string }>
      const sequences = rows.map((row) => (JSON.parse(row.payload) as { sequence: number }).sequence)
      assert.deepEqual(sequences, [1, 2], `${mode} durable event sequences must be unique and strictly monotonic`)
      assert.deepEqual(results.map((result) => result.event?.sequence).sort((a, b) => a! - b!), [1, 2])
      if (mode === 'user-turn') {
        const userTurns = check.db.prepare(
          "SELECT COUNT(*) AS n FROM events WHERE tenant_id = ? AND run_id = ? AND kind = 'booking.copilot.user.turn.observed'",
        ).get(check.tenant, taskId) as { n: number }
        assert.equal(userTurns.n, 3, 'initial plus two concurrent user turns must all be durable')
      }
      check.close()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  await run('emit')
  await run('user-turn')
  console.log('BOOKING COPILOT EVENT SEQUENCE CONCURRENCY PROOF: emit/user-turn multi-process sequence unique and strictly monotonic')
}
