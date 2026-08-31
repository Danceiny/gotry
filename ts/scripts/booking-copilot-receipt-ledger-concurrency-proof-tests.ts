import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureLedger } from '../src/state-ledger.ts'
import { BookingCopilotTaskRuntime, type ActionReceiptV1, type BookingReadActionV1, type UserTurnV1 } from '../src/booking-surface/runtime.ts'
import { validateActionReceiptV1 } from '../src/booking-surface/validation.ts'
import type { BookingWorkspaceSnapshotV1 } from '../src/booking-surface/contracts.ts'

const childIndex = process.argv.indexOf('--child')
const child = childIndex >= 0
const root = child ? process.argv[childIndex + 1] : undefined
const actionId = child ? process.argv[childIndex + 2] : undefined
const variant = child ? process.argv[childIndex + 3] : undefined
const release = root ? join(root, 'release') : ''

const workspace: BookingWorkspaceSnapshotV1 = {
  schemaVersion: 'booking.surface.v1', contextRef: 'ctx-concurrency-opaque', surface: 'tenant', revision: 0,
  locale: 'en-US', currency: 'AED', searchDraft: {}, results: { status: 'idle' }, visibleHotels: [],
  loadedOffers: [], shortlistedOfferRefs: [], capabilities: { surface: 'tenant', allowedActions: ['search.run'] },
}
const action: BookingReadActionV1 = {
  schemaVersion: 'booking.surface.v1', kind: 'search.run', actionId: 'action-concurrency-opaque', contextRef: workspace.contextRef,
  expectedRevision: 0, reason: 'opaque reason', factRefs: ['fact-opaque'], input: {},
}
function receipt(which: string): ActionReceiptV1 {
  const value: ActionReceiptV1 = {
    schemaVersion: 'booking.surface.v1', kind: 'action.receipt', actionId: action.actionId, contextRef: workspace.contextRef,
    status: 'applied' as const, revision: 1, observation: { kind: 'search.state' as const, searchSessionRef: `session-${which === 'same-a' || which === 'same-b' ? 'same' : which}`, resultCount: 1 },
    resultContract: { outcome: 'complete' as const, hardCriteriaMet: true, factRefs: [`fact-${which === 'same-a' || which === 'same-b' ? 'same' : which}`], gapCodes: [] as string[] }, undoToken: `undo-${which === 'same-a' || which === 'same-b' ? 'same' : which}`,
  }
  if (which === 'same-b') return { undoToken: value.undoToken, resultContract: value.resultContract, observation: value.observation, revision: value.revision, status: value.status, contextRef: value.contextRef, actionId: value.actionId, kind: value.kind, schemaVersion: value.schemaVersion }
  return value
}
function continuation(r: ActionReceiptV1, taskId = 'task-concurrency-opaque') {
  return { schemaVersion: 'booking.surface.v1' as const, kind: 'action.receipt.continuation' as const, taskId, workspace: { ...workspace, revision: 1 }, receipt: r }
}

if (process.argv.includes('--replay')) {
  const replayRoot = process.argv[process.argv.indexOf('--replay') + 1]!
  const replayVariant = process.argv[process.argv.indexOf('--replay') + 2]!
  const replayLedger = ensureLedger(replayRoot)
  try { new BookingCopilotTaskRuntime(replayLedger).continueWithReceipt(continuation(receipt(replayVariant))); console.log(JSON.stringify({ result: 'success' })) }
  catch (error) { console.log(JSON.stringify({ result: 'error', error: error instanceof Error ? error.message : String(error) })) }
  replayLedger.close(); process.exit(0)
}

if (child) {
  const ledger = ensureLedger(root!)
  const r = new BookingCopilotTaskRuntime(ledger)
  writeFileSync(join(root!, `started-${variant}`), 'started')
  const startDeadline = Date.now() + 10_000
  while (!existsSync(join(root!, 'start'))) { if (Date.now() > startDeadline) throw new Error('child_start_timeout'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10) }
  const originalResume = r.resumeTask.bind(r)
  let firstPendingRead = true
  r.resumeTask = (taskId: string) => {
    const state = originalResume(taskId)
    if (firstPendingRead && state?.pendingAction) {
      firstPendingRead = false
      writeFileSync(join(root!, `ready-${variant}`), 'ready')
      const deadline = Date.now() + 10_000
      while (!existsSync(release)) { if (Date.now() > deadline) throw new Error('child_timeout'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10) }
    }
    return state
  }
  try { r.continueWithReceipt(continuation(receipt(variant!))); console.log(JSON.stringify({ result: 'success', variant })) }
  catch (error) { console.log(JSON.stringify({ result: 'error', variant, error: error instanceof Error ? error.message : String(error) })) }
  ledger.close()
  process.exit(0)
}

function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => { const deadline = Date.now() + timeoutMs; const tick = () => predicate() ? resolve() : Date.now() > deadline ? reject(new Error('proof_timeout')) : setTimeout(tick, 10); tick() })
}
type WorkerResult = { result: string; variant?: string; error?: string }
async function runPair(stateRoot: string, left: string, right: string): Promise<WorkerResult[]> {
  const script = fileURLToPath(import.meta.url)
  const args = [script, '--child', stateRoot, action.actionId]
  const tsxBin = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url))
  const children = [left, right].map((which) => spawn(tsxBin, [...args, which], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }))
  const outputs = children.map(() => '')
  children.forEach((p, i) => { p.stdout.on('data', (b) => { outputs[i] += b.toString() }); p.stderr.on('data', (b) => { outputs[i] += b.toString() }); p.on('error', (e) => { outputs[i] += `spawn_error:${e.message}` }) })
  try {
    await waitFor(() => existsSync(join(stateRoot, `started-${left}`)) && existsSync(join(stateRoot, `started-${right}`)), 10_000)
    writeFileSync(join(stateRoot, 'start'), 'go')
    await waitFor(() => existsSync(join(stateRoot, `ready-${left}`)) || existsSync(join(stateRoot, `ready-${right}`)), 10_000)
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(existsSync(join(stateRoot, `ready-${left}`)) && existsSync(join(stateRoot, `ready-${right}`)), false, 'only one serialized pending read may pass the barrier')
  }
  catch (error) { children.forEach((p) => p.kill('SIGKILL')); throw new Error(`${error instanceof Error ? error.message : error}:${outputs.join('|')}`) }
  writeFileSync(join(stateRoot, 'release'), 'go')
  await Promise.all(children.map((p) => new Promise<void>((resolve, reject) => { const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('child_process_timeout')) }, 10_000); p.on('exit', (code) => { clearTimeout(t); code === 0 ? resolve() : reject(new Error(`child_exit_${code}:${outputs.join('|')}`)) }) })))
  return outputs.map((out) => JSON.parse(out.trim().split('\n').at(-1)!))
}

const stateRoot = root ?? mkdtempSync(join(tmpdir(), 'gotry-receipt-concurrency-'))
if (!child) {
  mkdirSync(stateRoot, { recursive: true })
  const ledger = ensureLedger(stateRoot)
  const r = new BookingCopilotTaskRuntime(ledger)
  const turn: UserTurnV1 = { schemaVersion: 'booking.surface.v1', kind: 'user.turn', taskId: 'task-concurrency-opaque', workspace, request: { text: 'unique-pii-marker@example.invalid Bearer TEST raw-prompt-marker' } }
  const sensitiveAction = { ...action, reason: 'unique-pii-marker@example.invalid Bearer TEST raw-prompt-marker', input: {} }
  r.startTask(turn); r.issueOperation(turn.taskId!, sensitiveAction)
  assert.throws(() => r.continueWithReceipt(continuation({ ...receipt('a'), undoToken: 'malicious@example.invalid' })), /invalid_receipt_continuation/)
  assert.throws(() => r.continueWithReceipt(continuation({ ...receipt('a'), observation: { kind: 'gap', code: 'raw-prompt-marker user prose', factRefs: ['numeric-123'] } })), /invalid_receipt_continuation/)
  assert.equal(validateActionReceiptV1({ ...receipt('a'), status: 'no_match', observation: { kind: 'gap', code: 'no_match', factRefs: ['123'] } }).ok, true)
  const differing = await runPair(stateRoot, 'a', 'b')
  assert.equal(differing.filter((x) => x.result === 'success').length, 1)
  assert.equal(differing.filter((x) => x.error === 'receipt_conflict').length, 1)
  const after = ledger
  assert.equal((after.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'booking.copilot.receipt.observed'").get() as { n: number }).n, 1)
  const persisted = after.db.prepare("SELECT payload FROM events WHERE kind LIKE 'booking.copilot.%'").all() as Array<{ payload: string }>
  assert.ok(!persisted.some((row) => /unique-pii-marker|Bearer TEST|raw-prompt-marker/i.test(row.payload)))
  const winner = differing.find((x) => x.result === 'success')
  assert.ok(winner?.variant)
  assert.deepEqual(new BookingCopilotTaskRuntime(after).resumeTask(turn.taskId!)?.lastReceipt, receipt(winner.variant))
  after.close()
  rmSync(stateRoot, { recursive: true, force: true })
  const equalRoot = mkdtempSync(join(tmpdir(), 'gotry-receipt-equal-'))
  const equalLedger = ensureLedger(equalRoot)
  const equalRuntime = new BookingCopilotTaskRuntime(equalLedger)
  equalRuntime.startTask(turn); equalRuntime.issueOperation('task-concurrency-opaque', action)
  const equal = await runPair(equalRoot, 'same-a', 'same-b')
  assert.equal(equal.filter((x) => x.result === 'success').length, 2)
  const equalCheck = equalLedger
  assert.equal((equalCheck.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'booking.copilot.receipt.observed'").get() as { n: number }).n, 1)
  const equalPayloads = equalCheck.db.prepare("SELECT payload FROM events WHERE kind LIKE 'booking.copilot.%'").all() as Array<{ payload: string }>
  assert.ok(!equalPayloads.some((row) => /sensitive|Authorization|Bearer|raw prompt|secret/i.test(row.payload)))
  const tampered = equalCheck.db.prepare("SELECT seq, payload FROM events WHERE kind = 'booking.copilot.receipt.observed' LIMIT 1").get() as { seq: number; payload: string }
  equalCheck.db.prepare('UPDATE events SET payload = ? WHERE seq = ?').run(tampered.payload.replace(/"receiptDigest":"[a-f0-9]+"/, '"receiptDigest":"0000000000000000000000000000000000000000000000000000000000000000"'), tampered.seq)
  assert.throws(() => new BookingCopilotTaskRuntime(equalCheck).resumeTask('task-concurrency-opaque'), /ledger_corrupt/)
  equalCheck.close()
  rmSync(equalRoot, { recursive: true, force: true })
  for (let round = 0; round < 20; round++) {
    const loopRoot = mkdtempSync(join(tmpdir(), 'gotry-receipt-round-'))
    const loopLedger = ensureLedger(loopRoot)
    const loopRuntime = new BookingCopilotTaskRuntime(loopLedger)
    loopRuntime.startTask(turn); loopRuntime.issueOperation('task-concurrency-opaque', action)
    const result = await runPair(loopRoot, 'a', 'b')
    assert.equal(result.filter((x) => x.result === 'success').length, 1)
    assert.equal(result.filter((x) => x.error === 'receipt_conflict').length, 1)
    loopLedger.close(); rmSync(loopRoot, { recursive: true, force: true })
  }
  const replayRoot = mkdtempSync(join(tmpdir(), 'gotry-receipt-replay-'))
  const replayLedger = ensureLedger(replayRoot)
  const replayRuntime = new BookingCopilotTaskRuntime(replayLedger)
  replayRuntime.startTask(turn); replayRuntime.issueOperation('task-concurrency-opaque', action); replayRuntime.continueWithReceipt(continuation(receipt('same')))
  const nextAction = { ...action, actionId: 'action-next-opaque', expectedRevision: 1 }
  replayRuntime.issueOperation('task-concurrency-opaque', nextAction)
  const beforeReplay = replayLedger.countEvents()
  const tsxBin = process.env.PATH?.split(':').map((dir) => join(dir, 'tsx')).find(existsSync)
  assert.ok(tsxBin)
  for (const replayVariant of ['same', 'conflict']) {
    const replayChild = spawn(tsxBin!, [fileURLToPath(import.meta.url), '--replay', replayRoot, replayVariant], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
    let replayOutput = ''; replayChild.stdout.on('data', (b) => { replayOutput += b.toString() }); replayChild.stderr.on('data', (b) => { replayOutput += b.toString() })
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => { replayChild.kill('SIGKILL'); reject(new Error('replay_timeout')) }, 10_000); replayChild.on('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`replay_exit_${code}`)) }) })
    const replayResult = JSON.parse(replayOutput.trim().split('\n').at(-1)!) as { result: string; error?: string }
    assert.equal(replayResult.result, replayVariant === 'same' ? 'success' : 'error')
    if (replayVariant === 'conflict') assert.equal(replayResult.error, 'receipt_conflict')
  }
  const replayCheck = replayLedger
  assert.equal(replayCheck.countEvents(), beforeReplay)
  assert.equal(new BookingCopilotTaskRuntime(replayCheck).resumeTask('task-concurrency-opaque')?.pendingAction?.actionId, nextAction.actionId)
  replayCheck.close(); rmSync(replayRoot, { recursive: true, force: true })
  const reuseRoot = mkdtempSync(join(tmpdir(), 'gotry-receipt-reuse-'))
  const reuseLedger = ensureLedger(reuseRoot); const reuseRuntime = new BookingCopilotTaskRuntime(reuseLedger)
  reuseRuntime.startTask(turn); reuseRuntime.issueOperation('task-concurrency-opaque', action); reuseRuntime.continueWithReceipt(continuation(receipt('same')))
  const actionB = { ...action, actionId: 'action-b-opaque', expectedRevision: 1 }
  reuseRuntime.issueOperation('task-concurrency-opaque', actionB); reuseRuntime.continueWithReceipt(continuation({ ...receipt('same'), actionId: actionB.actionId }))
  const reuseEvents = reuseLedger.countEvents(); const reuseState = reuseRuntime.resumeTask('task-concurrency-opaque')
  assert.throws(() => reuseRuntime.issueOperation('task-concurrency-opaque', action), /action_already_receipted/)
  assert.equal(reuseLedger.countEvents(), reuseEvents); assert.deepEqual(reuseRuntime.resumeTask('task-concurrency-opaque'), reuseState)
  reuseLedger.close(); rmSync(reuseRoot, { recursive: true, force: true })
  const tupleRoot = mkdtempSync(join(tmpdir(), 'gotry-receipt-tuple-'))
  const tupleLedger = ensureLedger(tupleRoot); const tupleRuntime = new BookingCopilotTaskRuntime(tupleLedger)
  for (const [taskId, actionId] of [['task:a', 'b'], ['task', 'a:b']] as const) {
    tupleRuntime.startTask({ ...turn, taskId }); tupleRuntime.issueOperation(taskId, { ...action, actionId })
    tupleRuntime.continueWithReceipt(continuation({ ...receipt('same'), actionId }, taskId))
  }
  assert.equal((tupleLedger.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'booking.copilot.action.issued'").get() as { n: number }).n, 2)
  assert.equal((tupleLedger.db.prepare("SELECT COUNT(DISTINCT idem_key) AS n FROM events WHERE kind = 'booking.copilot.action.issued'").get() as { n: number }).n, 2)
  assert.equal((tupleLedger.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'booking.copilot.receipt.observed'").get() as { n: number }).n, 2)
  assert.equal((tupleLedger.db.prepare("SELECT COUNT(DISTINCT idem_key) AS n FROM events WHERE kind = 'booking.copilot.receipt.observed'").get() as { n: number }).n, 2)
  for (const taskId of ['task:a', 'task']) assert.equal(tupleRuntime.resumeTask(taskId)?.phase, 'planning')
  tupleLedger.close(); rmSync(tupleRoot, { recursive: true, force: true })
  console.log('BOOKING COPILOT RECEIPT LEDGER CONCURRENCY PROOF: winner/conflict/atomic persistence OK')
}
