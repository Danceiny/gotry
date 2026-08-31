import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureLedger } from '../src/state-ledger.ts'
import { BookingCopilotTaskRuntime, type BookingReadActionV1, type UserTurnV1 } from '../src/booking-surface/runtime.ts'
import type { BookingWorkspaceSnapshotV1 } from '../src/booking-surface/contracts.ts'

const taskId = 'task-operation-atomicity'
const workspace: BookingWorkspaceSnapshotV1 = {
  schemaVersion: 'booking.surface.v1', contextRef: 'ctx-operation-atomicity', surface: 'tenant', revision: 0,
  locale: 'en-US', currency: 'AED', searchDraft: {}, results: { status: 'idle' }, visibleHotels: [], loadedOffers: [], shortlistedOfferRefs: [],
  capabilities: { surface: 'tenant', allowedActions: ['search.patch', 'search.run'] },
}
const base: BookingReadActionV1 = { schemaVersion: 'booking.surface.v1', kind: 'search.patch', actionId: 'action-operation-atomicity', contextRef: workspace.contextRef, expectedRevision: 0, reason: 'raw-reason-marker@example.invalid Bearer RAW_SECRET', factRefs: ['fact:opaque'], input: { patch: { destination: { query: 'raw-input-marker@example.invalid' } } } }
const child = process.argv.indexOf('--child') >= 0
const replayMode = process.argv.indexOf('--replay') >= 0
const root = child ? process.argv[process.argv.indexOf('--child') + 1]! : ''
const variant = child ? process.argv[process.argv.indexOf('--child') + 2]! : ''

if (replayMode) {
  const replayRoot = process.argv[process.argv.indexOf('--replay') + 1]!; const replayVariant = process.argv[process.argv.indexOf('--replay') + 2] ?? 'base'; const replayLedger = ensureLedger(replayRoot)
  const replayAction = replayVariant === 'conflict' ? action('conflict') : replayVariant === 'different' ? action('different') : base
  try { console.log(JSON.stringify({ result: 'success', event: new BookingCopilotTaskRuntime(replayLedger).issueOperation(taskId, replayAction) })) }
  catch (error) { console.log(JSON.stringify({ result: 'error', error: error instanceof Error ? error.message : String(error) })) }
  replayLedger.close(); process.exit(0)
}

function waitFile(path: string, timeout = 30_000): Promise<void> { return new Promise((resolve, reject) => { const end = Date.now() + timeout; const tick = () => existsSync(path) ? resolve() : Date.now() > end ? reject(new Error(`timeout:${path}`)) : setTimeout(tick, 5); tick() }) }
function action(which: string): BookingReadActionV1 {
  return {
    ...base,
    kind: which === 'kind' ? 'search.run' : base.kind,
    reason: which === 'conflict' ? 'different reason' : base.reason,
    contextRef: which === 'context' ? 'ctx-other' : base.contextRef,
    expectedRevision: which === 'revision' ? 1 : base.expectedRevision,
    factRefs: which === 'fact-order' ? ['fact:other', 'fact:opaque'] : base.factRefs,
    input: which === 'kind' ? {} : which === 'input' ? { patch: { destination: { query: 'other' } } } : base.input,
    actionId: which === 'different' ? 'action-different' : base.actionId,
  } as BookingReadActionV1
}

if (child) {
  const ledger = ensureLedger(root); const runtime = new BookingCopilotTaskRuntime(ledger)
  const original = runtime.resumeTask.bind(runtime); let first = true
  writeFileSync(join(root, `started-${variant}`), 'started')
  const gateEnd = Date.now() + 10_000; while (!existsSync(join(root, 'start'))) { if (Date.now() > gateEnd) throw new Error('start_gate_timeout'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5) }
  if (variant !== 'left') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
  runtime.resumeTask = (id: string) => { const state = original(id); if (first && !state?.pendingAction) { first = false; writeFileSync(join(root, `ready-${variant}`), 'ready'); const end = Date.now() + 10_000; while (!existsSync(join(root, 'release'))) { if (Date.now() > end) throw new Error('barrier_timeout'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5) } } return state }
  try { const event = runtime.issueOperation(taskId, action(variant)); console.log(JSON.stringify({ result: 'success', event })) }
  catch (error) { console.log(JSON.stringify({ result: 'error', error: error instanceof Error ? error.message : String(error) })) }
  ledger.close(); process.exit(0)
}

async function pair(root: string, left: string, right: string): Promise<Array<{ result: string; error?: string; event?: unknown }>> {
  const tsx = join(process.cwd(), 'ts/node_modules/tsx/dist/cli.mjs'); const script = fileURLToPath(import.meta.url); const ps = [left, right].map((v) => spawn(process.execPath, [tsx, script, '--child', root, v], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }))
  const out = ps.map(() => ''); ps.forEach((p, i) => { p.stdout.on('data', (b) => { out[i] += b }); p.stderr.on('data', (b) => { out[i] += b }) })
  await Promise.all([waitFile(join(root, `started-${left}`)), waitFile(join(root, `started-${right}`))]); writeFileSync(join(root, 'start'), 'start')
  try { await Promise.race([waitFile(join(root, `ready-${left}`)), waitFile(join(root, `ready-${right}`))]) } catch (error) { ps.forEach((p) => p.kill('SIGKILL')); throw new Error(`workers_did_not_reach_callsite:${out.join('|')}:${error}`) }
  await new Promise((resolve) => setTimeout(resolve, 250)); assert.equal(existsSync(join(root, `ready-${left}`)) && existsSync(join(root, `ready-${right}`)), false, 'both workers entered transaction before release')
  writeFileSync(join(root, 'release'), 'release')
  try { await Promise.all(ps.map((p) => new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('worker_timeout')), 10_000); p.on('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`worker_exit:${code}:${out.join('|')}`)) }) }))) } finally { ps.forEach((p) => { if (p.exitCode === null) p.kill('SIGKILL') }) }
  return out.map((s) => JSON.parse(s.trim().split('\n').at(-1)!))
}

async function run(kind: 'same' | 'conflict' | 'different', conflictVariant = 'conflict'): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), `gotry-operation-${kind}-`)); mkdirSync(root, { recursive: true }); const ledger = ensureLedger(root); const runtime = new BookingCopilotTaskRuntime(ledger)
  const turn: UserTurnV1 = { schemaVersion: 'booking.surface.v1', kind: 'user.turn', taskId, workspace, request: { text: 'opaque' } }; runtime.startTask(turn)
  const result = await pair(root, kind === 'different' ? 'different' : 'left', kind === 'conflict' ? conflictVariant : 'right')
  const success = result.filter((r) => r.result === 'success'); assert.equal(success.length, kind === 'same' ? 2 : 1)
  if (kind === 'conflict') assert.equal(result.filter((r) => r.error === 'action_conflict').length, 1, JSON.stringify(result))
  if (kind === 'different') assert.equal(result.filter((r) => r.error === 'receipt_required').length, 1)
  if (kind === 'same') assert.deepEqual(success[0].event, success[1].event)
  assert.equal((ledger.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'booking.copilot.action.issued'").get() as { n: number }).n, 1)
  const durable = ledger.db.prepare("SELECT payload FROM events WHERE kind = 'booking.copilot.action.issued'").get() as { payload: string }
  assert.ok(!/raw-reason-marker|raw-input-marker|Bearer RAW_SECRET|@example|secret/i.test(durable.payload))
  if (kind === 'same') {
    const event = success[0].event; ledger.close(); const tsx = join(process.cwd(), 'ts/node_modules/tsx/dist/cli.mjs')
    async function replayVariant(v: string) { const replayChild = spawn(process.execPath, [tsx, fileURLToPath(import.meta.url), '--replay', root, v], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }); let replayOutput = ''; replayChild.stdout.on('data', (b) => { replayOutput += b }); replayChild.stderr.on('data', (b) => { replayOutput += b }); await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => { replayChild.kill('SIGKILL'); reject(new Error('replay_timeout')) }, 10_000); replayChild.on('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`replay_exit:${code}:${replayOutput}`)) }) }); return JSON.parse(replayOutput.trim().split('\n').at(-1)!) }
    const replayResult = await replayVariant('base'); assert.deepEqual(replayResult.event, event); const conflictResult = await replayVariant('conflict'); assert.equal(conflictResult.error, 'action_conflict'); const differentResult = await replayVariant('different'); assert.equal(differentResult.error, 'receipt_required'); const restarted = ensureLedger(root); assert.equal((restarted.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'booking.copilot.action.issued'").get() as { n: number }).n, 1); const replay = replayResult.event
    const pending = new BookingCopilotTaskRuntime(restarted).resumeTask(taskId)?.pendingAction; assert.deepEqual(pending && { eventId: pending.eventId, sequence: pending.sequence, emittedAt: pending.emittedAt }, { eventId: (replay as any).eventId, sequence: (replay as any).sequence, emittedAt: (replay as any).emittedAt }); restarted.close()
  } else {
    ledger.close()
  }
  rmSync(root, { recursive: true, force: true })
}

if (!child) {
  for (let round = 0; round < 20; round++) { await run('same'); await run('conflict', ['conflict', 'kind', 'context', 'revision', 'fact-order', 'input'][round % 6]); await run('different') }
  const unsafeRoot = mkdtempSync(join(tmpdir(), 'gotry-operation-unsafe-')); const unsafeLedger = ensureLedger(unsafeRoot); const unsafeRuntime = new BookingCopilotTaskRuntime(unsafeLedger)
  unsafeRuntime.startTask({ schemaVersion: 'booking.surface.v1', kind: 'user.turn', taskId, workspace, request: { text: 'opaque' } })
  assert.throws(() => unsafeRuntime.issueOperation(taskId, { ...base, factRefs: ['attacker@example.invalid'] }), /unsafe_fact_ref/)
  assert.throws(() => unsafeRuntime.issueOperation(taskId, { ...base, actionId: 'attacker@example.invalid' }), /unsafe_action_id/)
  assert.throws(() => unsafeRuntime.issueOperation(taskId, { ...base, actionId: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature' }), /unsafe_action_id/)
  assert.equal(unsafeLedger.countEvents(), 2); unsafeLedger.close(); rmSync(unsafeRoot, { recursive: true, force: true })
  for (const field of ['actionId', 'factRefs', 'expectedRevision'] as const) {
    const tamperRoot = mkdtempSync(join(tmpdir(), `gotry-operation-tamper-${field}-`)); const tamperLedger = ensureLedger(tamperRoot); const tamperRuntime = new BookingCopilotTaskRuntime(tamperLedger)
    tamperRuntime.startTask({ schemaVersion: 'booking.surface.v1', kind: 'user.turn', taskId, workspace, request: { text: 'opaque' } }); tamperRuntime.issueOperation(taskId, base)
    const row = tamperLedger.db.prepare("SELECT seq, payload FROM events WHERE kind = 'booking.copilot.action.issued'").get() as { seq: number; payload: string }; const payload = JSON.parse(row.payload); payload.action[field] = field === 'factRefs' ? ['tampered'] : field === 'expectedRevision' ? 99 : 'tampered-action'
    tamperLedger.db.prepare('UPDATE events SET payload = ? WHERE seq = ?').run(JSON.stringify(payload), row.seq)
    assert.throws(() => new BookingCopilotTaskRuntime(tamperLedger).resumeTask(taskId), /ledger_corrupt/); tamperLedger.close(); rmSync(tamperRoot, { recursive: true, force: true })
  }
  console.log('BOOKING COPILOT OPERATION LEDGER CONCURRENCY PROOF: 20 rounds atomic')
}
