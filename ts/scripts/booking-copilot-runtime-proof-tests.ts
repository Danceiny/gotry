/**
 * Durable task-scoped Booking Copilot runtime proof.
 *
 * Run with Node 24 from the repository root:
 *   npx --yes --package=node@24 --package=tsx --call \
 *     'tsx ts/scripts/booking-copilot-runtime-proof-tests.ts'
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureLedger } from '../src/state-ledger.ts'
import {
  BookingCopilotTaskRuntime,
  type ActionReceiptV1,
  type ActionReceiptContinuationV1,
  type BookingReadActionV1,
  type UserTurnV1,
} from '../src/booking-surface/runtime.ts'
import type { BookingWorkspaceSnapshotV1 } from '../src/booking-surface/contracts.ts'

const stateRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-copilot-'))
const ledger = ensureLedger(stateRoot)
let id = 0
const runtimeOptions = {
  idFactory: (prefix: string) => `${prefix}-${++id}`,
  now: () => '2026-08-30T12:00:00.000Z',
}

const strictWorkspace: BookingWorkspaceSnapshotV1 = {
  schemaVersion: 'booking.surface.v1',
  contextRef: 'ctx-server-opaque-1',
  surface: 'tenant',
  revision: 0,
  locale: 'zh-CN',
  currency: 'AED',
  searchDraft: {},
  results: { status: 'idle' },
  visibleHotels: [],
  loadedOffers: [],
  shortlistedOfferRefs: [],
  capabilities: {
    surface: 'tenant',
    allowedActions: ['search.patch', 'search.run', 'results.view.patch', 'hotel.focus'],
  },
}

const startTurn: UserTurnV1 = {
  schemaVersion: 'booking.surface.v1',
  kind: 'user.turn',
  taskId: 'task-opaque-1',
  workspace: {
    ...strictWorkspace,
    capabilities: {
      ...strictWorkspace.capabilities,
      allowedActions: [...strictWorkspace.capabilities.allowedActions],
    },
  },
  request: { text: '联系 sensitive@example.com，找 13800001111 附近的酒店' },
}

const runtime = new BookingCopilotTaskRuntime(ledger, runtimeOptions)
const started = runtime.startTask(startTurn)
assert.equal(started.phase, 'planning')
assert.equal(started.taskId, 'task-opaque-1')
assert.equal(started.contextRef, strictWorkspace.contextRef)
assert.equal((started as any).userTurnCount, 1, 'the initial user turn is a durable task-scoped turn observation')

// A new runtime object owns no in-memory conversation yet; state comes from the ledger.
const afterRestart = new BookingCopilotTaskRuntime(ledger, runtimeOptions)
assert.deepEqual(afterRestart.resumeTask('task-opaque-1'), started, 'task resumes from durable ledger state')

const action: BookingReadActionV1 = {
  schemaVersion: 'booking.surface.v1',
  kind: 'search.patch',
  actionId: 'action-opaque-1',
  contextRef: strictWorkspace.contextRef,
  expectedRevision: 0,
  reason: 'private villa for sensitive@example.com',
  factRefs: ['fact-opaque-1'],
  input: {
    patch: {
      destination: { query: '13800001111 private address' },
    },
  },
}
const operation = afterRestart.issueOperation('task-opaque-1', action)
assert.equal(operation.kind, 'operation')
assert.equal(operation.contextRef, strictWorkspace.contextRef)
assert.deepEqual(operation.action, action)
assert.equal(afterRestart.resumeTask('task-opaque-1')?.phase, 'waiting_receipt')

assert.throws(
  () => afterRestart.issueOperation('task-opaque-1', { ...action, actionId: 'action-opaque-2' }),
  /receipt_required/,
  'one task cannot issue another operation before the current receipt',
)
assert.throws(
  () => afterRestart.startTask({ ...startTurn, request: { text: '先继续筛选' } }),
  /receipt_required/,
  'a fresh user turn cannot bypass the pending operation receipt',
)

const receipt: ActionReceiptV1 = {
  schemaVersion: 'booking.surface.v1',
  kind: 'action.receipt',
  actionId: action.actionId,
  contextRef: strictWorkspace.contextRef,
  status: 'applied',
  revision: 1,
  observation: { kind: 'search.state', searchSessionRef: 'search-opaque-1', resultCount: 12 },
  resultContract: { outcome: 'complete', hardCriteriaMet: true, factRefs: ['fact-opaque-2'], gapCodes: [] },
  undoToken: 'undo-opaque-1',
}
const continuation: ActionReceiptContinuationV1 = {
  schemaVersion: 'booking.surface.v1',
  kind: 'action.receipt.continuation',
  taskId: 'task-opaque-1',
  workspace: {
    ...startTurn.workspace,
    revision: 1,
    results: { status: 'ready', resultCount: 12, searchSessionRef: 'search-opaque-1' },
  },
  receipt,
}

assert.throws(
  () => afterRestart.continueWithReceipt({
    ...continuation,
    workspace: { ...continuation.workspace, contextRef: 'ctx-other' },
    receipt: { ...receipt, contextRef: 'ctx-other' },
  }),
  /context_mismatch/,
  'a receipt cannot cross task context',
)

const continued = afterRestart.continueWithReceipt(continuation)
assert.equal(continued.phase, 'planning')
assert.equal(continued.revision, 1)
assert.deepEqual(continued.lastReceipt, receipt)

const eventCountAfterReceipt = ledger.countEvents()
assert.deepEqual(afterRestart.continueWithReceipt(continuation), continued, 'identical receipt continuation is idempotent')
assert.equal(ledger.countEvents(), eventCountAfterReceipt, 'duplicate receipt writes no second ledger event')

const nextUserTurn: UserTurnV1 = {
  ...startTurn,
  workspace: continuation.workspace,
  request: { text: '继续筛选，只保留含早和免费取消的报价' },
}
const continuedTask = afterRestart.startTask(nextUserTurn)
assert.equal((continuedTask as any).userTurnCount, 2, 'one task accepts a new user intent after its receipt')
assert.notEqual((continuedTask as any).lastUserTurnDigest, (started as any).lastUserTurnDigest, 'each user turn stores its own digest')
assert.throws(
  () => afterRestart.startTask({ ...nextUserTurn, workspace: { ...nextUserTurn.workspace, revision: 0 } }),
  /task_conflict:revision_mismatch/,
  'a user turn must continue from the current semantic revision',
)
assert.throws(
  () => afterRestart.startTask({
    ...nextUserTurn,
    workspace: {
      ...nextUserTurn.workspace,
      capabilities: { ...nextUserTurn.workspace.capabilities, allowedActions: ['search.run'] },
    },
  }),
  /task_conflict:capability_mismatch/,
  'a task cannot silently broaden or shrink its surface allowlist',
)

const resumedAgain = new BookingCopilotTaskRuntime(ledger, runtimeOptions).resumeTask('task-opaque-1')
assert.deepEqual(resumedAgain?.lastReceipt, receipt, 'process-style restart recovers the last receipt checkpoint')
assert.equal((resumedAgain as any)?.userTurnCount, 2, 'process-style restart recovers every user-turn checkpoint')
const status = new BookingCopilotTaskRuntime(ledger, runtimeOptions).emitEvent('task-opaque-1', {
  kind: 'status',
  status: 'working',
})
assert.ok(status.sequence > operation.sequence, 'event sequence remains monotonic after runtime restart')

const persisted = ledger.db.prepare(
  `SELECT payload FROM events WHERE tenant_id = ? AND run_id = ? AND kind LIKE 'booking.copilot.%' ORDER BY seq`,
).all(ledger.tenant, 'task-opaque-1') as Array<{ payload: string }>
const persistedText = persisted.map((row) => row.payload).join('\n')
assert.ok(!persistedText.includes('sensitive@example.com'), 'raw user/action prose is not persisted')
assert.ok(!persistedText.includes('13800001111'), 'raw criteria payload is not persisted')
assert.ok(!persistedText.includes('private villa'), 'action reason is persisted only as a digest')
assert.match(persistedText, /requestDigest/, 'redacted request digest is durable')
assert.match(persistedText, /inputDigest/, 'redacted action input digest is durable')
const userTurnCountRow = ledger.db.prepare(
  `SELECT COUNT(*) AS count FROM events WHERE tenant_id = ? AND run_id = ? AND kind = 'booking.copilot.user.turn.observed'`,
).get(ledger.tenant, 'task-opaque-1') as { count: number } | undefined
assert.equal(
  Number(userTurnCountRow?.count ?? 0),
  2,
  'task.started is separate from one digest-only row per accepted user turn',
)

ledger.close()
rmSync(stateRoot, { recursive: true, force: true })
console.log('BOOKING COPILOT RUNTIME PROOF: task/operation/receipt/restart/idempotency/redaction OK')
