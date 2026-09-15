/**
 * Embedded Booking planner adapter proof.
 *
 * The fake below stops at the DeepSeek Harness SDK event boundary: planner
 * decisions come only from one typed dsh tool/call paired with one successful
 * tool/result event. Assistant finalResponse/prose is diagnostic text only and
 * never an authority source. A separate core proof boots the real dsh SDK
 * runtime.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureLedger } from '../src/state-ledger.ts'
import type { ActionReceipt, BookingReadAction, BookingWorkspaceSnapshot } from '../src/booking-surface/contracts.ts'
import { bookingDigest, BookingCopilotTaskRuntime, type BookingActionCheckpoint, type BookingCopilotTaskState } from '../src/booking-surface/runtime.ts'
import { BOOKING_INTENT_SCHEMA_VERSION, type BookingIntentCheckpoint } from '../src/booking-surface/booking-intent.ts'
import {
  DSH_EMBEDDED_BOOKING_TOOL_NAMES,
  buildDshEmbeddedBookingPatch,
  buildDshPlannerEnvironment,
  createDshEmbeddedBookingPlanner,
  formatUtcOffsetLabel,
  type DshPlannerRunResult,
  type DshPlannerRunPort,
  type DshEmbeddedBookingPlannerOptions,
} from '../src/booking-surface/dsh-planner.ts'
import { normalizeBookingErrorCode, safeBookingErrorMessage } from '../src/booking-surface/error-codes.ts'

const availability: import("../src/booking-surface/runtime.ts").BookingCopilotTaskState["availability"] = { initialized: true, recoveryStarted: false, availabilityPhase: 'need_offers' as const, activeHotelOrdinal: 0, hotelRefs: [], hotels: {}, attempts: [], queryReservations: [] }
const task: BookingCopilotTaskState = {
  schemaVersion: 'booking.surface',
  taskId: 'task-dsh-1',
  contextRef: 'ctx-dsh-1',
  surface: 'tenant',
  revision: 0,
  allowedActions: ['search.patch', 'search.run'],
  userTurnCount: 1,
  lastTurnId: 'dsh-turn-1',
  operationCount: 0,
  phase: 'planning',
  lastSequence: 0,
  availability,
}

const workspace: BookingWorkspaceSnapshot = {
  schemaVersion: 'booking.surface',
  contextRef: task.contextRef,
  surface: 'tenant',
  revision: 0,
  locale: 'zh-CN',
  currency: 'AED',
  searchDraft: {},
  results: { status: 'idle' },
  visibleHotels: [],
  loadedOffers: [],
  shortlistedOfferRefs: [],
  capabilities: { surface: 'tenant', allowedActions: ['search.patch', 'search.run'] },
}
task.workspaceSnapshot = workspace

const searchRun = {
  schemaVersion: 'booking.surface',
  kind: 'search.run',
  actionId: 'action-dsh-1',
  contextRef: task.contextRef,
  expectedRevision: 0,
  reason: 'Run the authoritative workspace search.',
  factRefs: [],
  input: {},
} as const
const hotelSelect = { ...searchRun, kind: 'hotel.select', actionId: 'action-dsh-select-1', reason: 'Select the requested hotel.', input: { hotelRef: 'hotel-1' } } as const
const checkoutPrepare = { ...searchRun, kind: 'checkout.prepare', actionId: 'action-dsh-checkout-1', expectedRevision: 1, reason: 'Prepare checkout for the verified offer.', input: { offerRef: 'offer-confirmed', offerVersionRef: 'offer-confirmed:v1', verifiedOfferRef: 'verified-offer-confirmed' } } as const

function toolCall(name: string, argumentsText: string, callId: string): Record<string, unknown> {
  return { type: 'tool/call', data: { name, callId, arguments: argumentsText } }
}

function toolResult(callId: string, isError = false, errorCode?: string, toolCallId = callId, sourceKind = 'tool'): Record<string, unknown> {
  return {
    type: 'tool/result',
    data: {
      message: {
        source: { kind: sourceKind, callId },
        content: [{ type: 'tool-result', toolCallId, content: [], isError }],
      },
      ...(errorCode ? { error: { name: 'ToolArgsError', code: errorCode } } : {}),
    },
  }
}

function successfulToolEvents(name: string, argumentsText: string, callId: string): Record<string, unknown>[] {
  return [toolCall(name, argumentsText, callId), toolResult(callId)]
}

function promptPayload(prompt: string): Record<string, any> {
  return JSON.parse(prompt.split('\n').at(-1)!) as Record<string, any>
}

function toolArgumentsPort(argumentsText: string): DshPlannerRunPort {
  return {
    async run() {
      return {
        finalResponse: '',
        events: successfulToolEvents('booking_search_hotels', argumentsText, 'call-arguments'),
      }
    },
    async close() {},
  }
}

async function runToolArgumentsCase(argumentsText: string, turnId: string) {
  const planner = await createDshEmbeddedBookingPlanner({ runPort: toolArgumentsPort(argumentsText) })
  try {
    return await planner.plannerFactory(task).next({
      task,
      turn: {
        schemaVersion: 'booking.surface',
        kind: 'user.turn',
        taskId: task.taskId,
        turnId,
        workspace,
        request: { text: 'Find hotels' },
      },
    })
  } finally {
    await planner.close()
  }
}

// A fresh order-observe turn may bind only to a BFF-injected observable order
// projection. The model still supplies the lookup key, but neither that key
// nor its evidence can come from prose or an untrusted ingress snapshot.
const freshOrderWorkspace: BookingWorkspaceSnapshot = {
  ...workspace,
  contextRef: 'ctx-dsh-fresh-order',
  capabilities: { surface: 'tenant', allowedActions: ['order.observe'] },
  observableOrders: [{ orderRef: 'order-fresh-1', factRefs: ['order:state:fresh-1'] }],
}
const freshOrderTask: BookingCopilotTaskState = {
  ...task,
  taskId: 'task-dsh-fresh-order',
  contextRef: freshOrderWorkspace.contextRef,
  lastTurnId: 'dsh-turn-fresh-order',
  allowedActions: ['order.observe'],
  workspaceSnapshot: freshOrderWorkspace,
}
const freshOrderPlanner = await createDshEmbeddedBookingPlanner({
  runPort: {
    async run() {
      return {
        finalResponse: '',
        events: successfulToolEvents(
          'booking_observe_booking',
          JSON.stringify({ kind: 'order.observe', input: { orderRef: 'order-fresh-1' }, intent: { target: 'order.observed' } }),
          'call-fresh-order',
        ),
      }
    },
    async close() {},
  },
})
const freshOrderDecisions = await freshOrderPlanner.plannerFactory(freshOrderTask).next({
  task: freshOrderTask,
  turn: {
    schemaVersion: 'booking.surface', kind: 'user.turn', taskId: freshOrderTask.taskId, turnId: freshOrderTask.lastTurnId!,
    workspace: freshOrderWorkspace, request: { text: '查看刚创建订单状态' },
  },
})
assertRuntimeMaterializedOperation(freshOrderDecisions, 'order.observe', { orderRef: 'order-fresh-1' }, freshOrderTask, 'fresh order observe binds to the BFF-authoritative observable order projection')
assert.deepEqual((freshOrderDecisions[0] as any)?.action?.factRefs, ['order:state:fresh-1'], 'fresh order observe carries only binding-supplied order evidence')
await freshOrderPlanner.close()

const forgedOrderPlanner = await createDshEmbeddedBookingPlanner({
  runPort: {
    async run() {
      return {
        finalResponse: '',
        events: successfulToolEvents(
          'booking_observe_booking',
          JSON.stringify({ kind: 'order.observe', input: { orderRef: 'order-forged' }, intent: { target: 'order.observed' } }),
          'call-forged-order',
        ),
      }
    },
    async close() {},
  },
})
await assert.rejects(
  forgedOrderPlanner.plannerFactory(freshOrderTask).next({
    task: freshOrderTask,
    turn: {
      schemaVersion: 'booking.surface', kind: 'user.turn', taskId: freshOrderTask.taskId, turnId: 'dsh-turn-forged-order',
      workspace: freshOrderWorkspace, request: { text: '查看订单状态' },
    },
  }),
  /planner_order_ref_unbound/,
  'fresh order observe rejects an order ref absent from the trusted projection',
)
await forgedOrderPlanner.close()

// The trusted order projection must flow through an actual operation and its
// matching receipt before terminalization. Only a verified order outcome is a
// successful observation; pending, unknown, and failed remain stopped while
// retaining their state-specific summaries. Even verified receipts with a
// partial result or a gap cannot claim completion.
if (freshOrderDecisions[0]?.kind !== 'operation') throw new Error('fresh order matrix did not receive an operation')
const orderMatrixIntentBase = {
  taskId: 'task-dsh-order-state-matrix', contextRef: freshOrderWorkspace.contextRef,
  sourceTurnId: freshOrderTask.lastTurnId!, sourceRequestDigest: bookingDigest('observe existing order'),
  projection: { schemaVersion: BOOKING_INTENT_SCHEMA_VERSION, target: 'order.observed' as const },
}
const orderMatrixIntent: BookingIntentCheckpoint = { ...orderMatrixIntentBase, intentDigest: bookingDigest(orderMatrixIntentBase) }
const orderMatrixCases: ReadonlyArray<{
  state: 'pending' | 'verified' | 'failed' | 'unknown'
  outcome: 'complete' | 'partial'
  hardCriteriaMet: boolean
  gapCodes: ActionReceipt['resultContract']['gapCodes']
  expectedStatus: 'completed' | 'stopped'
  expectedSummary: string
}> = [
  { state: 'pending', outcome: 'complete', hardCriteriaMet: true, gapCodes: [], expectedStatus: 'stopped', expectedSummary: 'order_pending' },
  { state: 'unknown', outcome: 'complete', hardCriteriaMet: true, gapCodes: [], expectedStatus: 'stopped', expectedSummary: 'order_unknown' },
  { state: 'failed', outcome: 'complete', hardCriteriaMet: true, gapCodes: [], expectedStatus: 'stopped', expectedSummary: 'order_failed' },
  { state: 'verified', outcome: 'complete', hardCriteriaMet: true, gapCodes: [], expectedStatus: 'completed', expectedSummary: 'order_verified' },
  { state: 'verified', outcome: 'partial', hardCriteriaMet: true, gapCodes: [], expectedStatus: 'stopped', expectedSummary: 'order_verified' },
  { state: 'verified', outcome: 'complete', hardCriteriaMet: true, gapCodes: ['order_outcome_not_observed'], expectedStatus: 'stopped', expectedSummary: 'booking_constraints_unmet' },
]
for (const [index, matrixCase] of orderMatrixCases.entries()) {
  const matrixTaskId = `task-dsh-order-state-${matrixCase.state}-${index}`
  const matrixRoot = mkdtempSync(join(tmpdir(), `gotry-booking-order-state-${matrixCase.state}-${index}-`))
  const matrixLedger = ensureLedger(matrixRoot)
  const matrixRuntime = new BookingCopilotTaskRuntime(matrixLedger, { contextRefFactory: () => freshOrderWorkspace.contextRef })
  const action = { ...freshOrderDecisions[0].action, actionId: `order-matrix-${matrixCase.state}-${index}`, factRefs: ['order:state:fresh-1'] } as BookingReadAction
  const receipt: ActionReceipt = {
    schemaVersion: 'booking.surface', kind: 'action.receipt', actionId: action.actionId,
    contextRef: freshOrderWorkspace.contextRef, status: 'applied', revision: 1,
    observation: { kind: 'order.state', orderRef: 'order-fresh-1', state: matrixCase.state, ...(matrixCase.gapCodes.length ? { gapCodes: matrixCase.gapCodes } : {}) },
    resultContract: { outcome: matrixCase.outcome, hardCriteriaMet: matrixCase.hardCriteriaMet, factRefs: ['order:state:fresh-1'], gapCodes: matrixCase.gapCodes, blockers: [], relaxationsApplied: [] },
  }
  matrixRuntime.startTask({
    schemaVersion: 'booking.surface', kind: 'user.turn', taskId: matrixTaskId, turnId: `${matrixTaskId}-turn`,
    workspace: freshOrderWorkspace, request: { text: '查看已有订单状态' },
  })
  matrixRuntime.issueOperation(matrixTaskId, action, orderMatrixIntent.projection)
  const matrixState = matrixRuntime.continueWithReceipt({
    schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId: matrixTaskId,
    workspace: { ...freshOrderWorkspace, revision: 1 }, receipt,
  })
  const [terminal] = await runTerminalContinuation(matrixState, receipt)
  assert.equal(terminal?.kind, 'terminal', `order ${matrixCase.state} emits a typed terminal`)
  if (terminal?.kind === 'terminal') {
    assert.equal(terminal.terminal.status, matrixCase.expectedStatus, `order ${matrixCase.state} status is state-authoritative`)
    assert.equal(terminal.terminal.summary, matrixCase.expectedSummary, `order ${matrixCase.state} summary is preserved`)
  }
  matrixLedger.close()
  rmSync(matrixRoot, { recursive: true, force: true })
}

function assertRuntimeMaterializedOperation(
  decisions: readonly any[],
  kind: string,
  input: unknown,
  expectedTask: BookingCopilotTaskState = task,
  message = 'planner materializes one runtime-owned operation',
) {
  assert.equal(decisions.length, 1, message)
  assert.equal(decisions[0]?.kind, 'operation', message)
  assert.equal(decisions[0]?.action?.kind, kind, message)
  assert.deepEqual(decisions[0]?.action?.input, input, message)
  assert.equal(decisions[0]?.action?.contextRef, expectedTask.contextRef, message)
  assert.equal(decisions[0]?.action?.expectedRevision, expectedTask.revision, message)
  assert.match(decisions[0]?.action?.actionId, /^planner-[a-f0-9]{24}$/, message)
}

function completedCheckpoint(action: BookingReadAction, sourceTurnId: string): BookingActionCheckpoint {
  const base: Omit<BookingActionCheckpoint, 'actionDigest'> = {
    actionId: action.actionId,
    kind: action.kind,
    contextRef: action.contextRef,
    expectedRevision: action.expectedRevision,
    factRefs: [...action.factRefs],
    input: structuredClone(action.input),
    reasonDigest: bookingDigest(action.reason),
    inputDigest: bookingDigest(action.input),
    eventId: `operation-${action.actionId}`,
    sequence: 1,
    emittedAt: '2026-08-30T12:00:00.000Z',
    sourceTurnId,
  }
  return { ...base, actionDigest: bookingDigest(base) }
}

async function runTerminalContinuation(task: BookingCopilotTaskState, receipt: ActionReceipt): Promise<readonly any[]> {
  const planner = await createDshEmbeddedBookingPlanner({
    runPort: {
      async run() {
        return { finalResponse: '', events: successfulToolEvents('booking_search_hotels', JSON.stringify({ kind: 'terminal' }), `call-terminal-${task.taskId}`) }
      },
      async close() {},
    },
  })
  try {
    return await planner.plannerFactory(task).next({
      task,
      turn: {
        schemaVersion: 'booking.surface',
        kind: 'action.receipt.continuation',
        taskId: task.taskId,
        workspace: task.workspaceSnapshot!,
        receipt,
      },
    })
  } finally {
    await planner.close()
  }
}

// Exercise the real runtime -> planner receipt continuation path. The
// planner may terminalize only after the runtime has accepted a workspace
// whose shortlist is a subset of loadedOffers; a forged shortlist is rejected
// at the continuation boundary before it can become terminal evidence.
const shortlistProofRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-shortlist-proof-'))
const shortlistProofRuntime = new BookingCopilotTaskRuntime(ensureLedger(shortlistProofRoot), { contextRefFactory: () => 'ctx-dsh-shortlist' })
const shortlistWorkspace0: BookingWorkspaceSnapshot = {
  ...workspace,
  contextRef: 'ctx-dsh-shortlist',
  visibleHotels: [{ hotelRef: 'hotel-shortlist', name: 'Shortlist Hotel', factRefs: [] }],
  loadedOffers: [
    { offerRef: 'offer-shortlist-a', offerVersionRef: 'offer-shortlist-a:v1', hotelRef: 'hotel-shortlist', evidenceLevel: 'rate_loaded', factRefs: [] },
    { offerRef: 'offer-shortlist-b', offerVersionRef: 'offer-shortlist-b:v1', hotelRef: 'hotel-shortlist', evidenceLevel: 'rate_loaded', factRefs: [] },
  ],
  shortlistedOfferRefs: ['offer-shortlist-a', 'offer-shortlist-b'],
  capabilities: { surface: 'tenant', allowedActions: ['offer.select'] },
}
const shortlistTurn = {
  schemaVersion: 'booking.surface' as const, kind: 'user.turn' as const, taskId: 'task-dsh-shortlist', turnId: 'dsh-turn-shortlist',
  workspace: shortlistWorkspace0, request: { text: 'select the first offer' },
}
const shortlistTask = shortlistProofRuntime.startTask(shortlistTurn)
const shortlistAction: BookingReadAction = {
  ...searchRun, kind: 'offer.select', actionId: 'action-dsh-shortlist', contextRef: 'ctx-dsh-shortlist',
  expectedRevision: 0, factRefs: [], input: { offerRef: 'offer-shortlist-a', offerVersionRef: 'offer-shortlist-a:v1' },
}
const shortlistIntent = { schemaVersion: BOOKING_INTENT_SCHEMA_VERSION, target: 'offer.selected', offerCriteria: { targetCount: 2 } } as const
shortlistProofRuntime.issueOperation(shortlistTask.taskId, shortlistAction, shortlistIntent)
const shortlistWorkspace1: BookingWorkspaceSnapshot = { ...shortlistWorkspace0, revision: 1, selectedOfferRef: 'offer-shortlist-a' }
const shortlistReceipt: ActionReceipt = {
  schemaVersion: 'booking.surface', kind: 'action.receipt', actionId: shortlistAction.actionId, contextRef: 'ctx-dsh-shortlist', status: 'applied', revision: 1,
  observation: { kind: 'offer.selection', offerRef: 'offer-shortlist-a', offerVersionRef: 'offer-shortlist-a:v1' },
  resultContract: { outcome: 'complete', hardCriteriaMet: true, factRefs: [], gapCodes: [], blockers: [], relaxationsApplied: [] },
}
const acceptedShortlistTask = shortlistProofRuntime.continueWithReceipt({ schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId: shortlistTask.taskId, workspace: shortlistWorkspace1, receipt: shortlistReceipt })
const shortlistPlanner = await createDshEmbeddedBookingPlanner({
  runPort: {
    async run() { return { finalResponse: '', events: successfulToolEvents('booking_search_hotels', JSON.stringify({ kind: 'terminal' }), 'call-shortlist-terminal') } },
    async close() {},
  },
})
const shortlistTerminal = await shortlistPlanner.plannerFactory(acceptedShortlistTask).next({
  task: acceptedShortlistTask,
  turn: { schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId: shortlistTask.taskId, workspace: shortlistWorkspace1, receipt: shortlistReceipt },
})
assert.deepEqual(shortlistTerminal, [{ kind: 'terminal', terminal: { status: 'completed', summary: 'offer_selected', factRefs: [] } }], 'accepted runtime receipt continuation reaches the planner terminal')
await shortlistPlanner.close()
const forgedShortlistRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-forged-shortlist-proof-'))
const forgedShortlistRuntime = new BookingCopilotTaskRuntime(ensureLedger(forgedShortlistRoot), { contextRefFactory: () => 'ctx-dsh-shortlist' })
const forgedShortlistTask = forgedShortlistRuntime.startTask({ ...shortlistTurn, taskId: 'task-dsh-forged-shortlist', turnId: 'dsh-turn-forged-shortlist' })
forgedShortlistRuntime.issueOperation(forgedShortlistTask.taskId, { ...shortlistAction, actionId: 'action-dsh-forged-shortlist' }, shortlistIntent)
assert.throws(
  () => forgedShortlistRuntime.continueWithReceipt({
    schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId: forgedShortlistTask.taskId,
    workspace: { ...shortlistWorkspace1, shortlistedOfferRefs: ['offer-shortlist-a', 'offer-forged'] },
    receipt: { ...shortlistReceipt, actionId: 'action-dsh-forged-shortlist' },
  }),
  /invalid_receipt_continuation:.*shortlistedOfferRefs: every ref must be a loaded offer/,
  'forged shortlist is rejected before a planner receipt continuation can terminalize',
)
shortlistProofRuntime['ledger'].close(); forgedShortlistRuntime['ledger'].close()
rmSync(shortlistProofRoot, { recursive: true, force: true }); rmSync(forgedShortlistRoot, { recursive: true, force: true })

const repeatedToolArguments = JSON.stringify({
  decision: {
    kind: 'operation',
    intent: { target: 'search.results' },
    action: {
      ...searchRun,
      reason: 'Preserve braces } {, escaped quotes " and a backslash \\ inside a JSON string.',
    },
  },
})

const stringifiedDecisionArguments = JSON.stringify({
  decision: JSON.stringify({
    kind: 'operation',
    intent: { target: 'search.results' },
    action: searchRun,
  }),
})

const compactSearchPatchInput = {
  patch: {
    destination: { query: 'Dubai' },
    starRating: { strength: 'must', value: { min: 5, max: 5 } },
  },
} as const
const compactSearchPatchDecision = await runToolArgumentsCase(
  JSON.stringify({ kind: 'search.patch', input: compactSearchPatchInput, intent: { target: 'search.results' } }),
  'dsh-compact-search-patch',
)
assert.equal(compactSearchPatchDecision.length, 1)
assert.equal(compactSearchPatchDecision[0]?.kind, 'operation')
if (compactSearchPatchDecision[0]?.kind !== 'operation') throw new Error('compact proposal did not materialize an operation')
assert.deepEqual(compactSearchPatchDecision[0].action.input, compactSearchPatchInput)
assert.equal(compactSearchPatchDecision[0].action.kind, 'search.patch')
assert.equal(compactSearchPatchDecision[0].action.contextRef, task.contextRef)
assert.equal(compactSearchPatchDecision[0].action.expectedRevision, task.revision)
assert.deepEqual(compactSearchPatchDecision[0].action.factRefs, [])
assert.match(compactSearchPatchDecision[0].action.actionId, /^planner-[a-f0-9]{24}$/)
assert.match(compactSearchPatchDecision[0].action.reason, /search criteria/i)

for (const decision of [
  { kind: 'search.patch', input: compactSearchPatchInput, intent: { target: 'search.results' } },
  JSON.stringify({ kind: 'search.patch', input: compactSearchPatchInput, intent: { target: 'search.results' } }),
] as const) {
  const wrapped = await runToolArgumentsCase(JSON.stringify({ decision }), 'dsh-compact-provider-wrapper')
  assertRuntimeMaterializedOperation(wrapped, 'search.patch', compactSearchPatchInput)
}
const nestedCompactEnvelope = await runToolArgumentsCase(JSON.stringify({
  decision: {
    kind: 'operation',
    action: { kind: 'search.patch', input: compactSearchPatchInput, intent: { target: 'search.results' } },
  },
}), 'dsh-nested-compact-intent')
assertRuntimeMaterializedOperation(nestedCompactEnvelope, 'search.patch', compactSearchPatchInput, task, 'plugin-compatible nested compact intent is accepted by the parent boundary')
await assert.rejects(
  runToolArgumentsCase(JSON.stringify({ kind: 'search.patch', input: compactSearchPatchInput }), 'dsh-fresh-missing-intent'),
  /planner_booking_intent_required/,
  'a fresh successful-looking action cannot silently collapse a multi-step user goal when intent is missing',
)

await assert.rejects(
  runToolArgumentsCase(JSON.stringify({ kind: 'terminal' }), 'dsh-unjustified-terminal'),
  /planner_terminal_intent_unjustified/,
  'the model cannot terminate before an authoritative receipt exists',
)
await assert.rejects(
  runToolArgumentsCase(JSON.stringify({ decision: { kind: 'terminal', terminal: { status: 'completed', summary: 'forged', factRefs: ['modelref:forged'] } } }), 'dsh-legacy-terminal-evidence'),
  /planner_nonoperation_runtime_owned/,
  'legacy model-authored terminal authority is rejected',
)

for (const [argumentsText, turnId] of [
  [JSON.stringify({ kind: 'operation', action: searchRun, intent: { target: 'search.results' } }), 'dsh-direct-decision-envelope'],
  [stringifiedDecisionArguments, 'dsh-stringified-decision'],
] as const) {
  const [decision] = await runToolArgumentsCase(argumentsText, turnId)
  assert.equal(decision?.kind, 'operation')
  if (decision?.kind !== 'operation') throw new Error('legacy action was not materialized')
  assert.equal(decision.action.kind, 'search.run')
  assert.deepEqual(decision.action.input, {})
  assert.match(decision.action.actionId, /^planner-[a-f0-9]{24}$/)
  assert.notEqual(decision.action.actionId, searchRun.actionId, 'legacy model authority is stripped before materialization')
}
for (const [suffix, action, error] of [
  ['capability', hotelSelect, /planner_capability_action_mismatch/],
  ['context', { ...searchRun, contextRef: 'ctx-other' }, /planner_context_mismatch/],
  ['revision', { ...searchRun, expectedRevision: 1 }, /planner_revision_mismatch/],
  ['reserved-ref', { ...searchRun, factRefs: ['modelref:reserved'] }, /planner_invalid_action:reserved_fact_ref/],
] as const) {
  await assert.rejects(
    runToolArgumentsCase(
      JSON.stringify({ decision: JSON.stringify({ kind: 'operation', action, intent: { target: 'search.results' } }) }),
      `dsh-stringified-decision-${suffix}`,
    ),
    error,
    `a stringified decision cannot bypass ${suffix} authority`,
  )
}
const rejectedStringifiedDecision = await createDshEmbeddedBookingPlanner({
  runPort: {
    async run() {
      return {
        finalResponse: '',
        events: [
          toolCall('booking_search_hotels', stringifiedDecisionArguments, 'call-stringified-decision-rejected'),
          toolResult('call-stringified-decision-rejected', true, 'INVALID_ARGS'),
        ],
      }
    },
    async close() {},
  },
})
await assert.rejects(
  rejectedStringifiedDecision.plannerFactory(task).next({
    task,
    turn: {
      schemaVersion: 'booking.surface',
      kind: 'user.turn',
      taskId: task.taskId,
      turnId: 'dsh-stringified-decision-rejected',
      workspace,
      request: { text: 'Find hotels' },
    },
  }),
  /planner_tool_call_rejected/,
  'a parsed stringified decision cannot bypass a paired tool rejection',
)
await rejectedStringifiedDecision.close()
await assert.rejects(
  runToolArgumentsCase(JSON.stringify({ decision: 'not JSON' }), 'dsh-stringified-decision-invalid-json'),
  /planner_invalid_tool_arguments/,
  'a non-JSON decision string is rejected',
)
await assert.rejects(
  runToolArgumentsCase(
    JSON.stringify({ decision: JSON.stringify(JSON.stringify({ kind: 'operation', action: searchRun })) }),
    'dsh-stringified-decision-recursive',
  ),
  /planner_invalid_tool_arguments/,
  'decision normalization unwraps exactly one provider encoding layer',
)
await assert.rejects(
  runToolArgumentsCase(
    JSON.stringify({ decision: JSON.stringify([{ kind: 'operation', action: searchRun }]) }),
    'dsh-stringified-decision-array',
  ),
  /planner_invalid_tool_arguments/,
  'a stringified decision array is rejected',
)

await assert.rejects(
  runToolArgumentsCase(`${repeatedToolArguments}${repeatedToolArguments}`, 'dsh-duplicate-identical'),
  /planner_invalid_tool_arguments/,
  'repeated JSON objects are not canonical raw arguments',
)

await assert.rejects(
  runToolArgumentsCase(`${repeatedToolArguments}\n \t ${repeatedToolArguments}`, 'dsh-duplicate-whitespace'),
  /planner_invalid_tool_arguments/,
  'whitespace-separated repeated JSON objects are not canonical raw arguments',
)

await assert.rejects(
  runToolArgumentsCase(`${repeatedToolArguments}${JSON.stringify({
    decision: {
      kind: 'operation',
      action: { ...searchRun, actionId: 'action-dsh-conflict' },
    },
  })}`, 'dsh-duplicate-conflict'),
  /planner_invalid_tool_arguments/,
  'structurally different complete objects are rejected instead of selecting the first action',
)
await assert.rejects(
  runToolArgumentsCase(`${repeatedToolArguments}${repeatedToolArguments.slice(0, -1)}`, 'dsh-duplicate-truncated'),
  /planner_invalid_tool_arguments/,
  'a truncated later object is rejected',
)
await assert.rejects(
  runToolArgumentsCase(`model preface ${repeatedToolArguments}${repeatedToolArguments}`, 'dsh-duplicate-prefix'),
  /planner_invalid_tool_arguments/,
  'arbitrary prefix is rejected',
)
await assert.rejects(
  runToolArgumentsCase(`${repeatedToolArguments} trailing garbage`, 'dsh-duplicate-tail'),
  /planner_invalid_tool_arguments/,
  'garbage suffix is rejected',
)
await assert.rejects(
  runToolArgumentsCase('{"decision":{"kind":"operation","action":{"reason":"raw\nline"}}}', 'dsh-single-invalid-control'),
  /planner_invalid_tool_arguments/,
  'a single invalid object is not repaired by escaping raw control characters',
)
await assert.rejects(
  runToolArgumentsCase('[] []', 'dsh-non-object-sequence'),
  /planner_invalid_tool_arguments/,
  'a non-object JSON sequence is rejected',
)

const profilePatch = buildDshEmbeddedBookingPatch('/tmp/gotry-booking-dsh-plugin.js')
const prompts: string[] = []
const sessionIds: string[] = []
const frozenNow = new Date(2026, 8, 9, 10, 30, 0, 0)
let runIndex = 0
const runPort: DshPlannerRunPort = {
  async run(prompt, options) {
    prompts.push(prompt)
    sessionIds.push(options.sessionId)
    runIndex += 1
    if (runIndex === 1) {
      return {
        finalResponse: '{"kind":"book","input":{}}',
        events: successfulToolEvents(
          'booking_search_hotels',
          JSON.stringify({ decision: { kind: 'operation', action: searchRun, intent: { target: 'search.results' } } }),
          'call-adapter-search',
        ),
      }
    }
    if (runIndex === 3) {
      return {
        finalResponse: '',
        events: successfulToolEvents(
          'booking_refine_results',
          JSON.stringify({ decision: { kind: 'operation', action: hotelSelect, intent: { target: 'hotel.selected' } } }),
          'call-adapter-select',
        ),
      }
    }
    return {
      finalResponse: '{"kind":"search.run","input":{}}',
      events: successfulToolEvents(
        'booking_search_hotels',
        JSON.stringify({ kind: 'terminal' }),
        'call-adapter-terminal',
      ),
    }
  },
  async close() {},
}

const adapter = await createDshEmbeddedBookingPlanner({ runPort, now: frozenNow })
const session = adapter.plannerFactory(task)
const first = await session.next({
  task,
  turn: {
    schemaVersion: 'booking.surface',
    kind: 'user.turn',
    taskId: task.taskId,
    turnId: 'dsh-turn-1',
    workspace: {
      ...workspace,
      capabilities: { ...workspace.capabilities, allowedActions: [...workspace.capabilities.allowedActions] },
    },
    request: { text: '执行当前搜索' },
  },
})
assertRuntimeMaterializedOperation(first, 'search.run', {}, task, 'typed dsh tool call becomes one runtime-owned operation')

assert.match(prompts[0]!, /Time anchor: today is 2026-09-09 \(周三, UTC[+-]\d{2}:\d{2}\)/, 'planner prompt uses the injected host-local date anchor')
assert.match(prompts[0]!, /process host-local anchor used only for relative-date parsing/, 'planner prompt identifies host-local time as a parsing anchor')
assert.match(prompts[0]!, /do not treat it as the traveler\/user timezone/, 'planner prompt does not masquerade host time as user timezone')
for (const field of ['destination', 'hotel', 'stay', 'occupancy', 'budget', 'starRating', 'guestRating', 'facilities']) {
  assert.match(prompts[0]!, new RegExp(`\\b${field}\\b`), `planner prompt names SearchCriteriaPatch field ${field}`)
}
assert.ok(!/under criteria/i.test(prompts[0]!), 'planner prompt does not revive the stale under-criteria routing wording')
assert.ok(!profilePatch.includes('2026-09-10') && !profilePatch.includes('2026-09-13'), 'shape example no longer carries stale concrete 2026 dates')
assert.ok(!/under criteria/i.test(profilePatch), 'planner persona does not revive the stale under-criteria routing wording')
assert.match(profilePatch, /Shape-only example/i, 'planner persona marks the example as shape-only')
assert.match(profilePatch, /do not copy literal/i, 'planner persona tells the model not to copy placeholder sample values')
const shapeExampleLine = profilePatch.split('\n').find((line) => line.trimStart().startsWith('{"kind":"search.patch"'))
assert.ok(shapeExampleLine, 'planner persona example uses the shallow model-facing proposal')
const shapeExample = JSON.parse(shapeExampleLine!.trim()) as { kind?: string; input?: unknown; intent?: unknown }
assert.deepEqual(Object.keys(shapeExample), ['kind', 'input', 'intent'], 'planner persona example exposes semantic kind, input, and mandatory intent only')
assert.equal(shapeExample.kind, 'search.patch')
for (const runtimeField of ['schemaVersion', 'actionId', 'contextRef', 'expectedRevision', 'factRefs', 'reason']) {
  assert.ok(!Object.prototype.hasOwnProperty.call(shapeExample, runtimeField), `planner persona omits runtime-owned ${runtimeField}`)
}
assert.match(profilePatch, /"stay":\{"checkIn":"<computed YYYY-MM-DD from the host-local time anchor>","checkOut":"<computed YYYY-MM-DD from nights\/check-in>"\}/, 'shape example keeps the stay object shape')
assert.match(profilePatch, /"starRating":\{"strength":"must","value":\{"min":3,"max":3\}\}/, 'shape example keeps the starRating criterion shape')
assert.match(profilePatch, /"occupancy":\{"rooms":\[\{"adults":2,"childAges":\[\]\}\]\}/, 'shape example includes a well-formed occupancy block')
assert.ok(!/Bali/.test(profilePatch), 'shape example carries no literal destination')
assert.ok(!/\b20\d{2}-\d{2}-\d{2}\b/.test(profilePatch), 'shape example carries no concrete YYYY-MM-DD dates')
const personaPrefixKeyMatches = profilePatch.match(/^ {4}personaPrefix:\s*>-/gm) ?? []
assert.equal(personaPrefixKeyMatches.length, 1, `planner patch must carry exactly one personaPrefix: >- key (observed=${personaPrefixKeyMatches.length})`)
assert.ok(!/(^|\n) {4}persona:\s*>-/.test(profilePatch), 'planner patch must not carry the legacy persona: >- key')
assert.match(profilePatch, /You are GoTry's embedded booking planner/, 'planner patch retains the intended embedded booking persona text')
assert.match(profilePatch, /Always answer by calling exactly one/, 'planner patch retains the tool-call-only discipline')
assert.ok(!profilePatch.includes('six booking'), 'planner patch no longer hardcodes the grouped tool count')
assert.equal(formatUtcOffsetLabel(345), 'UTC+05:45', 'timezone formatter preserves positive minute offsets')
assert.equal(formatUtcOffsetLabel(-210), 'UTC-03:30', 'timezone formatter preserves negative minute offsets')
assert.equal(formatUtcOffsetLabel(0), 'UTC+00:00', 'timezone formatter zero-pads whole-hour offsets')

const receipt: ActionReceipt = {
  schemaVersion: 'booking.surface',
  kind: 'action.receipt',
  actionId: first[0]?.kind === 'operation' ? first[0].action.actionId : searchRun.actionId,
  contextRef: task.contextRef,
  status: 'applied',
  revision: 1,
  observation: { kind: 'search.state', searchSessionRef: 'search-dsh-1', resultCount: 4 },
  resultContract: { outcome: 'complete', hardCriteriaMet: true, factRefs: [], gapCodes: [], blockers: [], relaxationsApplied: [] },
}
const continuedWorkspace: BookingWorkspaceSnapshot = {
  ...workspace,
  revision: 1,
  results: { status: 'ready', resultCount: 4, searchSessionRef: 'search-dsh-1' },
}
if (first[0]?.kind !== 'operation') throw new Error('first planner turn did not produce an operation checkpoint')
const continuedTask: BookingCopilotTaskState = {
  ...task,
  revision: 1,
  lastCompletedAction: completedCheckpoint(first[0].action, task.lastTurnId!),
  lastReceipt: receipt,
  workspaceSnapshot: continuedWorkspace,
}
const second = await session.next({
  task: continuedTask,
  turn: {
    schemaVersion: 'booking.surface',
    kind: 'action.receipt.continuation',
    taskId: task.taskId,
    workspace: continuedWorkspace,
    receipt,
  },
})
assert.deepEqual(second, [{
  kind: 'terminal',
  terminal: { status: 'completed', summary: 'search_results_ready', factRefs: [] },
}])
assert.equal(sessionIds[0], sessionIds[1], 'one task keeps one dsh session across receipt continuation')
assert.match(prompts[1]!, /planner-[a-f0-9]{24}/, 'receipt continuation reaches the same task-scoped planner session')

// A search.patch receipt is not a search waypoint. The runtime compiles the
// mandatory search.run transition without asking the model for another
// probabilistic tool call.
const patchTerminalTask: BookingCopilotTaskState = {
  ...task,
  taskId: 'task-dsh-patch-terminal',
  contextRef: 'ctx-dsh-patch-terminal',
  lastTurnId: 'dsh-patch-terminal-turn',
  workspaceSnapshot: { ...workspace, contextRef: 'ctx-dsh-patch-terminal' },
}
const patchTerminalWorkspace = patchTerminalTask.workspaceSnapshot!
let patchTerminalRuns = 0
const patchTerminalPort: DshPlannerRunPort = {
  async run() {
    patchTerminalRuns += 1
    return patchTerminalRuns === 1
      ? { finalResponse: '', events: successfulToolEvents('booking_search_hotels', JSON.stringify({ kind: 'search.patch', input: { patch: { destination: { query: 'Dubai' } } }, intent: { target: 'search.results' } }), 'call-patch-terminal') }
      : { finalResponse: '', events: successfulToolEvents('booking_search_hotels', JSON.stringify({ kind: 'terminal' }), 'call-patch-terminal-continuation') }
  },
  async close() {},
}
const patchTerminalPlanner = await createDshEmbeddedBookingPlanner({ runPort: patchTerminalPort })
const patchTerminalSession = patchTerminalPlanner.plannerFactory(patchTerminalTask)
const patchDecision = await patchTerminalSession.next({
  task: patchTerminalTask,
  turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: patchTerminalTask.taskId, turnId: patchTerminalTask.lastTurnId!, workspace: patchTerminalWorkspace, request: { text: 'Search Dubai' } },
})
assertRuntimeMaterializedOperation(patchDecision, 'search.patch', { patch: { destination: { query: 'Dubai' } } }, patchTerminalTask, 'search.patch remains the only first operation')
if (patchDecision[0]?.kind !== 'operation') throw new Error('patch terminal proof did not receive a patch operation')
const patchReceipt: ActionReceipt = {
  schemaVersion: 'booking.surface', kind: 'action.receipt', actionId: patchDecision[0].action.actionId, contextRef: patchTerminalTask.contextRef,
  status: 'applied', revision: 1, observation: { kind: 'search.state', resultCount: 0 },
  resultContract: { outcome: 'complete', hardCriteriaMet: true, factRefs: [], gapCodes: [], blockers: [], relaxationsApplied: [] },
}
const patchContinuationWorkspace = { ...patchTerminalWorkspace, revision: 1, results: { status: 'idle' as const } }
const compiledSearchRun = await patchTerminalSession.next({
  task: {
    ...patchTerminalTask,
    revision: 1,
    lastCompletedAction: completedCheckpoint(patchDecision[0].action, patchTerminalTask.lastTurnId!),
    lastReceipt: patchReceipt,
    workspaceSnapshot: patchContinuationWorkspace,
  },
  turn: { schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId: patchTerminalTask.taskId, workspace: patchContinuationWorkspace, receipt: patchReceipt },
})
assertRuntimeMaterializedOperation(compiledSearchRun, 'search.run', {}, { ...patchTerminalTask, revision: 1 }, 'search.patch receipt deterministically compiles search.run')
assert.equal(patchTerminalRuns, 1, 'compiled search.run does not invoke the model a second time')
await patchTerminalPlanner.close()

const paymentWorkspace: BookingWorkspaceSnapshot = {
  ...workspace,
  surface: 'payment_link',
  visibleHotels: [{ hotelRef: 'hotel-1', name: 'Hotel One', factRefs: ['hotel:1'] }],
  capabilities: { surface: 'payment_link', allowedActions: ['hotel.select'] },
}
const paymentTask = { ...task, taskId: 'task-payment-1', surface: 'payment_link' as const, allowedActions: ['hotel.select'] as BookingCopilotTaskState['allowedActions'], revision: 0, workspaceSnapshot: paymentWorkspace }
const paymentSession = adapter.plannerFactory(paymentTask)
const selected = await paymentSession.next({ task: paymentTask, turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: paymentTask.taskId, turnId: 'payment-turn-1', workspace: paymentWorkspace, request: { text: '选择酒店' } } })
assertRuntimeMaterializedOperation(selected, 'hotel.select', hotelSelect.input, paymentTask, 'refine-results can emit typed hotel.select on payment_link')

assert.deepEqual(DSH_EMBEDDED_BOOKING_TOOL_NAMES, [
  'booking_search_hotels',
  'booking_run_search',
  'booking_refine_results',
  'booking_focus_hotel',
  'booking_select_hotel',
  'booking_find_room_offers',
  'booking_view_offers',
  'booking_compare_offers',
  'booking_select_offer',
  'booking_prepare_booking',
  'booking_prepare_checkout',
  'booking_observe_booking',
  'booking_finish_turn',
])
assert.ok(!DSH_EMBEDDED_BOOKING_TOOL_NAMES.some((name) => /book$|trade|payment/i.test(name)), 'profile has no Book/payment tool')

const childEnv = buildDshPlannerEnvironment({
  PATH: '/usr/bin',
  LANG: 'en_US.UTF-8',
  LLM_API_KEY: 'model-key',
  LLM_BASE_URL: 'http://model.invalid/v1',
  LLM_MODEL: 'model-v1',
  PORTAL_TOKEN: 'forbidden',
  HOTELBYTE_TOKEN: 'forbidden',
  GOTRY_BOOKING_COPILOT_API_KEY: 'bff-only',
})
assert.equal(childEnv.DEEPSEEK_API_KEY, 'model-key')
assert.equal(childEnv.DEEPSEEK_BASE_URL, 'http://model.invalid/v1')
assert.equal(childEnv.DEEPSEEK_MODEL, 'model-v1')
assert.equal(childEnv.PORTAL_TOKEN, undefined)
assert.equal(childEnv.HOTELBYTE_TOKEN, undefined)
assert.equal(childEnv.GOTRY_BOOKING_COPILOT_API_KEY, undefined)

const deepseekNamespaceWinsAtomically = buildDshPlannerEnvironment({
  DEEPSEEK_API_KEY: 'deepseek-key',
  LLM_API_KEY: 'llm-key',
  LLM_BASE_URL: 'http://must-not-cross-mix.invalid/v1',
  LLM_MODEL: 'must-not-cross-mix',
  LLM_MAX_TOKENS: '4096',
})
assert.deepEqual(deepseekNamespaceWinsAtomically, {
  DEEPSEEK_API_KEY: 'deepseek-key',
}, 'the selected DEEPSEEK credential never borrows route fields from the LLM namespace')

const completeDeepseekNamespaceWinsAtomically = buildDshPlannerEnvironment({
  DEEPSEEK_API_KEY: 'deepseek-key',
  DEEPSEEK_BASE_URL: 'http://deepseek-route.invalid/v1',
  DEEPSEEK_MODEL: 'deepseek-model',
  DEEPSEEK_MAX_TOKENS: '16384',
  LLM_API_KEY: 'llm-key',
  LLM_BASE_URL: 'http://llm-route.invalid/v1',
  LLM_MODEL: 'llm-model',
  LLM_MAX_TOKENS: '8192',
})
assert.deepEqual(completeDeepseekNamespaceWinsAtomically, {
  DEEPSEEK_API_KEY: 'deepseek-key',
  DEEPSEEK_BASE_URL: 'http://deepseek-route.invalid/v1',
  DEEPSEEK_MODEL: 'deepseek-model',
  DEEPSEEK_MAX_TOKENS: '16384',
}, 'a complete DEEPSEEK tuple wins without mixing any LLM route field')

const llmNamespaceMapsAtomically = buildDshPlannerEnvironment({
  LLM_API_KEY: 'llm-key',
  LLM_BASE_URL: 'http://llm-route.invalid/v1',
  LLM_MODEL: 'llm-model',
  LLM_MAX_TOKENS: '8192',
})
assert.deepEqual(llmNamespaceMapsAtomically, {
  DEEPSEEK_API_KEY: 'llm-key',
  DEEPSEEK_BASE_URL: 'http://llm-route.invalid/v1',
  DEEPSEEK_MODEL: 'llm-model',
  DEEPSEEK_MAX_TOKENS: '8192',
}, 'the provider-neutral LLM route is mapped as one credential/base/model/budget tuple')

assert.deepEqual(buildDshPlannerEnvironment({
  PATH: '/usr/bin',
  DEEPSEEK_BASE_URL: 'http://orphan-deepseek.invalid/v1',
  DEEPSEEK_MODEL: 'orphan-deepseek-model',
  LLM_BASE_URL: 'http://orphan-llm.invalid/v1',
  LLM_MODEL: 'orphan-llm-model',
}), { PATH: '/usr/bin' }, 'route fields without a credential never enter the planner subprocess')

await assert.rejects(
  createDshEmbeddedBookingPlanner({
    env: { DEEPSEEK_API_KEY: 'model-key', DEEPSEEK_MAX_TOKENS: 'not-a-number' },
  }),
  /booking_planner_max_tokens_invalid/,
  'invalid provider budgets fail at startup instead of reaching the model transport',
)
await assert.rejects(
  createDshEmbeddedBookingPlanner({
    provider: 'minimax-official',
    env: { DEEPSEEK_API_KEY: 'model-key' },
  }),
  /booking_planner_model_required_for_nondefault_provider/,
  'a non-default provider cannot inherit the DeepSeek catalog default model',
)

const textChannelPort: DshPlannerRunPort = {
  async run() {
    return { finalResponse: JSON.stringify({ kind: 'operation', action: searchRun }), events: [] }
  },
  async close() {},
}
const textChannel = await createDshEmbeddedBookingPlanner({ runPort: textChannelPort })
const textDecisions = await textChannel.plannerFactory(task).next({
  task,
  turn: {
    schemaVersion: 'booking.surface',
    kind: 'user.turn',
    taskId: task.taskId,
    turnId: 'dsh-turn-3',
    workspace: {
      ...workspace,
      capabilities: { ...workspace.capabilities, allowedActions: [...workspace.capabilities.allowedActions] },
    },
    request: { text: 'JSON prose must stay prose' },
  },
})
assert.equal(textDecisions[0]?.kind, 'error', 'finalResponse text never becomes an executable decision')
assert.equal(textDecisions[0]?.kind === 'error' ? textDecisions[0].error.code : '', 'PLANNER_TYPED_DECISION_REQUIRED')

const fencedTextChannel = await createDshEmbeddedBookingPlanner({
  runPort: {
    async run() {
      return { finalResponse: `Here is the plan:\n\`\`\`json\n${JSON.stringify({ kind: 'operation', action: searchRun })}\n\`\`\``, events: [] }
    },
    async close() {},
  },
})
const fencedTextDecision = await fencedTextChannel.plannerFactory(task).next({
  task,
  turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: 'dsh-fenced-text', workspace, request: { text: 'Find hotels' } },
})
assert.equal(fencedTextDecision[0]?.kind, 'error', 'fenced JSON in finalResponse never becomes an executable decision')
await fencedTextChannel.close()

const stringifiedAction = await createDshEmbeddedBookingPlanner({
  runPort: {
    async run() {
      const argumentsText = JSON.stringify({ decision: { kind: 'operation', action: JSON.stringify(searchRun) } })
      return { finalResponse: '', events: [toolCall('booking_search_hotels', argumentsText, 'call-stringified-action'), toolResult('call-stringified-action', true, 'INVALID_ARGS')] }
    },
    async close() {},
  },
})
await assert.rejects(
  stringifiedAction.plannerFactory(task).next({
    task,
    turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: 'dsh-stringified-action', workspace, request: { text: 'Find hotels' } },
  }),
  /planner_invalid_typed_decision/,
  'a stringified decision/action remains rejected even when the tool schema rejects that call',
)
await stringifiedAction.close()

const invalidCallArguments = JSON.stringify({ decision: { kind: 'operation', action: JSON.stringify(searchRun) } })
const invalidThenValid = await createDshEmbeddedBookingPlanner({
  runPort: {
    async run() {
      return {
        finalResponse: 'ignored prose',
        events: [
          toolCall('booking_search_hotels', invalidCallArguments, 'call-invalid-schema'),
          toolResult('call-invalid-schema', true, 'INVALID_ARGS'),
          ...successfulToolEvents('booking_search_hotels', JSON.stringify({ decision: { kind: 'operation', action: searchRun, intent: { target: 'search.results' } } }), 'call-valid-after-schema-rejection'),
        ],
      }
    },
    async close() {},
  },
})
const invalidThenValidDecision = await invalidThenValid.plannerFactory(task).next({
  task,
  turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: 'dsh-invalid-then-valid', workspace, request: { text: 'Find hotels' } },
})
assertRuntimeMaterializedOperation(invalidThenValidDecision, 'search.run', {}, task, 'a schema-rejected call may be superseded by the later unique typed success in the same run')
await invalidThenValid.close()

const invalidWithoutSchemaRejection = await createDshEmbeddedBookingPlanner({
  runPort: {
    async run() {
      return {
        finalResponse: '',
        events: [
          toolCall('booking_search_hotels', invalidCallArguments, 'call-invalid-without-schema-rejection'),
          toolResult('call-invalid-without-schema-rejection'),
          ...successfulToolEvents('booking_search_hotels', JSON.stringify({ decision: { kind: 'operation', action: searchRun, intent: { target: 'search.results' } } }), 'call-valid-after-unproven-rejection'),
        ],
      }
    },
    async close() {},
  },
})
await assert.rejects(
  invalidWithoutSchemaRejection.plannerFactory(task).next({
    task,
    turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: 'dsh-invalid-without-rejection', workspace, request: { text: 'Find hotels' } },
  }),
  /planner_invalid_typed_decision/,
  'an invalid call cannot be silently skipped when its same-run schema rejection is unproven',
)
await invalidWithoutSchemaRejection.close()

const unauthorisedTyped = await createDshEmbeddedBookingPlanner({
  runPort: {
    async run() {
      return {
        finalResponse: '',
        events: [
          toolCall('booking_search_hotels', JSON.stringify({ decision: { kind: 'operation', action: hotelSelect } }), 'call-unauthorised-action'),
          toolResult('call-unauthorised-action', true, 'INVALID_ARGS'),
          ...successfulToolEvents('booking_search_hotels', JSON.stringify({ decision: { kind: 'operation', action: searchRun, intent: { target: 'search.results' } } }), 'call-valid-after-unauthorised-action'),
        ],
      }
    },
    async close() {},
  },
})
await assert.rejects(
  unauthorisedTyped.plannerFactory(task).next({
    task,
    turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: 'dsh-unauthorised-action', workspace, request: { text: 'Select a hotel' } },
  }),
  /planner_capability_action_mismatch|planner_surface_action_unsupported/,
  'a capability/allowed-action violation cannot be hidden by a later typed success',
)
await unauthorisedTyped.close()

const multipleTypedSuccesses = await createDshEmbeddedBookingPlanner({
  runPort: {
    async run() {
      return {
        finalResponse: '',
        events: [
          ...successfulToolEvents('booking_search_hotels', JSON.stringify({ decision: { kind: 'operation', action: searchRun, intent: { target: 'search.results' } } }), 'call-multiple-1'),
          ...successfulToolEvents('booking_search_hotels', JSON.stringify({ decision: { kind: 'operation', action: { ...searchRun, actionId: 'action-dsh-multiple-2' }, intent: { target: 'search.results' } } }), 'call-multiple-2'),
        ],
      }
    },
    async close() {},
  },
})
await assert.rejects(
  multipleTypedSuccesses.plannerFactory(task).next({
    task,
    turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: 'dsh-multiple-successes', workspace, request: { text: 'Find hotels' } },
  }),
  /planner_multiple_typed_decisions/,
  'multiple typed tool successes fail closed instead of selecting the first action',
)
await multipleTypedSuccesses.close()

const missingToolResult = await createDshEmbeddedBookingPlanner({
  runPort: {
    async run() {
      return { finalResponse: '', events: [toolCall('booking_search_hotels', JSON.stringify({ decision: { kind: 'operation', action: searchRun } }), 'call-missing-result')] }
    },
    async close() {},
  },
})
await assert.rejects(
  missingToolResult.plannerFactory(task).next({
    task,
    turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: 'dsh-missing-result', workspace, request: { text: 'Find hotels' } },
  }),
  /planner_tool_result_missing/,
  'a typed call without its paired result is not executable',
)
await missingToolResult.close()

const mismatchedToolResult = await createDshEmbeddedBookingPlanner({
  runPort: {
    async run() {
      return {
        finalResponse: '',
        events: [
          toolCall('booking_search_hotels', JSON.stringify({ decision: { kind: 'operation', action: searchRun } }), 'call-mismatched-result'),
          toolResult('call-mismatched-result', false, undefined, 'call-other'),
        ],
      }
    },
    async close() {},
  },
})
await assert.rejects(
  mismatchedToolResult.plannerFactory(task).next({
    task,
    turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: 'dsh-mismatched-result', workspace, request: { text: 'Find hotels' } },
  }),
  /planner_tool_result_malformed/,
  'a result whose toolCallId does not match its source call fails closed',
)
await mismatchedToolResult.close()

const wrongToolResultSourceKind = await createDshEmbeddedBookingPlanner({
  runPort: {
    async run() {
      return {
        finalResponse: '',
        events: [
          toolCall('booking_search_hotels', JSON.stringify({ decision: { kind: 'operation', action: searchRun } }), 'call-wrong-source-kind'),
          toolResult('call-wrong-source-kind', false, undefined, 'call-wrong-source-kind', 'model'),
        ],
      }
    },
    async close() {},
  },
})
await assert.rejects(
  wrongToolResultSourceKind.plannerFactory(task).next({
    task,
    turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: 'dsh-wrong-source-kind', workspace, request: { text: 'Find hotels' } },
  }),
  /planner_tool_result_malformed/,
  'a result from a non-tool message source is not an executable tool result',
)
await wrongToolResultSourceKind.close()

const typedCallRejectedThenValid = await createDshEmbeddedBookingPlanner({
  runPort: {
    async run() {
      return {
        finalResponse: '',
        events: [
          toolCall('booking_search_hotels', JSON.stringify({ decision: { kind: 'operation', action: searchRun, intent: { target: 'search.results' } } }), 'call-typed-schema-rejected'),
          toolResult('call-typed-schema-rejected', true, 'INVALID_ARGS'),
          ...successfulToolEvents('booking_search_hotels', JSON.stringify({ decision: { kind: 'operation', action: { ...searchRun, actionId: 'action-dsh-after-typed-rejection' }, intent: { target: 'search.results' } } }), 'call-after-typed-rejection'),
        ],
      }
    },
    async close() {},
  },
})
await assert.rejects(
  typedCallRejectedThenValid.plannerFactory(task).next({
    task,
    turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: 'dsh-typed-rejected-then-valid', workspace, request: { text: 'Find hotels' } },
  }),
  /planner_tool_call_rejected/,
  'a parsed typed call with an error result cannot be skipped in favor of a later action',
)
await typedCallRejectedThenValid.close()

const unsafeFactRefRejectedThenValid = await createDshEmbeddedBookingPlanner({
  runPort: {
    async run() {
      return {
        finalResponse: '',
        events: [
          toolCall(
            'booking_search_hotels',
            JSON.stringify({ decision: { kind: 'operation', action: { ...searchRun, factRefs: ['draft:destination=Dubai'] }, intent: { target: 'search.results' } } }),
            'call-unsafe-fact-ref',
          ),
          toolResult('call-unsafe-fact-ref', true, 'INVALID_ARGS'),
          ...successfulToolEvents(
            'booking_search_hotels',
            JSON.stringify({ decision: { kind: 'operation', action: { ...searchRun, actionId: 'action-dsh-after-unsafe-ref', factRefs: [] }, intent: { target: 'search.results' } } }),
            'call-valid-after-unsafe-ref',
          ),
        ],
      }
    },
    async close() {},
  },
})
assertRuntimeMaterializedOperation(
  await unsafeFactRefRejectedThenValid.plannerFactory(task).next({
    task,
    turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: 'dsh-unsafe-ref-repair', workspace, request: { text: 'Find hotels' } },
  }),
  'search.run',
  {},
  task,
  'a dsh INVALID_ARGS result lets the model repair an unsafe factRef inside the same run',
)
await unsafeFactRefRejectedThenValid.close()

const reservedFactRefRejectedThenValid = await createDshEmbeddedBookingPlanner({
  runPort: {
    async run() {
      return {
        finalResponse: '',
        events: [
          toolCall(
            'booking_search_hotels',
            JSON.stringify({ decision: { kind: 'operation', action: { ...searchRun, factRefs: ['modelref:reserved-by-runtime'] }, intent: { target: 'search.results' } } }),
            'call-reserved-fact-ref',
          ),
          toolResult('call-reserved-fact-ref', true, 'INVALID_ARGS'),
          ...successfulToolEvents(
            'booking_search_hotels',
            JSON.stringify({ decision: { kind: 'operation', action: { ...searchRun, actionId: 'action-dsh-after-reserved-ref', factRefs: [] }, intent: { target: 'search.results' } } }),
            'call-valid-after-reserved-ref',
          ),
        ],
      }
    },
    async close() {},
  },
})
await assert.rejects(
  reservedFactRefRejectedThenValid.plannerFactory(task).next({
    task,
    turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: 'dsh-reserved-ref-no-repair', workspace, request: { text: 'Find hotels' } },
  }),
  /planner_invalid_action:reserved_fact_ref/,
  'the runtime-owned modelref namespace remains fail-closed even with paired INVALID_ARGS and a later valid call',
)
await reservedFactRefRejectedThenValid.close()

// Issue #473 mixed-authority regression: an INVALID_ARGS + later-valid pair
// must not launder an authority violation that co-travels with a reference
// syntax error. Pure shape errors stay repairable; authority rejections
// remain fail-closed regardless of paired INVALID_ARGS + later canonical.
const mixedAuthorityCases: ReadonlyArray<{
  name: string
  tool: 'booking_search_hotels' | 'booking_refine_results'
  badAction: Record<string, unknown>
  accept: true
} | {
  name: string
  tool: 'booking_search_hotels' | 'booking_refine_results'
  badAction: Record<string, unknown>
  accept: false
  errorPattern: RegExp
}> = [
  {
    name: 'shape-only repair control',
    tool: 'booking_search_hotels',
    badAction: { ...searchRun, factRefs: ['draft:destination=Dubai'] },
    accept: true,
  },
  {
    name: 'capability mismatch plus unsafe factRef',
    tool: 'booking_search_hotels',
    badAction: { ...hotelSelect, factRefs: ['draft:destination=Dubai'] },
    accept: false,
    errorPattern: /planner_capability_action_mismatch/,
  },
  {
    name: 'surface unsupported plus unsafe factRef',
    tool: 'booking_refine_results',
    badAction: { ...hotelSelect, factRefs: ['draft:destination=Dubai'] },
    accept: false,
    errorPattern: /planner_surface_action_unsupported/,
  },
  {
    name: 'revision mismatch plus unsafe factRef',
    tool: 'booking_search_hotels',
    badAction: { ...searchRun, expectedRevision: 99, factRefs: ['draft:destination=Dubai'] },
    accept: false,
    errorPattern: /planner_revision_mismatch/,
  },
  {
    name: 'reserved factRef plus unsafe actionId',
    tool: 'booking_search_hotels',
    badAction: { ...searchRun, actionId: 'bad/action', factRefs: ['modelref:reserved-by-runtime'] },
    accept: false,
    errorPattern: /planner_invalid_action:reserved_fact_ref/,
  },
  {
    name: 'context mismatch plus unsafe factRef control',
    tool: 'booking_search_hotels',
    badAction: { ...searchRun, contextRef: 'ctx-other', factRefs: ['draft:destination=Dubai'] },
    accept: false,
    errorPattern: /planner_context_mismatch/,
  },
  {
    name: 'reserved factRef plus empty actionId',
    tool: 'booking_search_hotels',
    badAction: { ...searchRun, actionId: '', factRefs: ['modelref:reserved-by-runtime'] },
    accept: false,
    errorPattern: /planner_invalid_action:reserved_fact_ref/,
  },
  {
    name: 'surface unsupported plus nonstring factRef',
    tool: 'booking_refine_results',
    badAction: { ...hotelSelect, factRefs: [0] },
    accept: false,
    errorPattern: /planner_surface_action_unsupported/,
  },
  {
    name: 'capability mismatch plus unsafe actionId counterpart',
    tool: 'booking_search_hotels',
    badAction: { ...hotelSelect, actionId: 'bad/id' },
    accept: false,
    errorPattern: /planner_capability_action_mismatch/,
  },
  {
    name: 'revision mismatch plus unsafe actionId counterpart',
    tool: 'booking_search_hotels',
    badAction: { ...searchRun, actionId: 'bad/id', expectedRevision: 99 },
    accept: false,
    errorPattern: /planner_revision_mismatch/,
  },
  {
    name: 'revision mismatch plus empty actionId',
    tool: 'booking_search_hotels',
    badAction: { ...searchRun, actionId: '', expectedRevision: 99 },
    accept: false,
    errorPattern: /planner_revision_mismatch/,
  },
  {
    name: 'revision mismatch plus nonstring factRef',
    tool: 'booking_search_hotels',
    badAction: { ...searchRun, factRefs: [0], expectedRevision: 99 },
    accept: false,
    errorPattern: /planner_revision_mismatch/,
  },
  {
    name: 'revision mismatch plus invalid input',
    tool: 'booking_search_hotels',
    badAction: { ...searchRun, expectedRevision: 99, input: { bogus: 1 } },
    accept: false,
    errorPattern: /planner_revision_mismatch/,
  },
  {
    name: 'wrong-typed revision repair control',
    tool: 'booking_search_hotels',
    badAction: { ...searchRun, expectedRevision: '99', factRefs: ['draft:destination=Dubai'] },
    accept: true,
  },
]
for (const [index, c] of mixedAuthorityCases.entries()) {
  const mixedAuthorityPlanner = await createDshEmbeddedBookingPlanner({
    runPort: {
      async run() {
        return {
          finalResponse: '',
          events: [
            toolCall(c.tool, JSON.stringify({ decision: { kind: 'operation', action: c.badAction, intent: { target: 'search.results' } } }), `mixed-authority-${index}-bad`),
            toolResult(`mixed-authority-${index}-bad`, true, 'INVALID_ARGS'),
            ...successfulToolEvents('booking_search_hotels', JSON.stringify({ decision: { kind: 'operation', action: searchRun, intent: { target: 'search.results' } } }), `mixed-authority-${index}-good`),
          ],
        }
      },
      async close() {},
    },
  })
  try {
    if (c.accept) {
      const decisions = await mixedAuthorityPlanner.plannerFactory(task).next({
        task,
        turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: `dsh-mixed-authority-${index}`, workspace, request: { text: 'Find hotels' } },
      })
      assertRuntimeMaterializedOperation(decisions, 'search.run', {}, task, `${c.name} accepts the later canonical call after shape repair`)
    } else {
      await assert.rejects(
        mixedAuthorityPlanner.plannerFactory(task).next({
          task,
          turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: `dsh-mixed-authority-${index}`, workspace, request: { text: 'Find hotels' } },
        }),
        c.errorPattern,
        c.name,
      )
    }
  } finally {
    await mixedAuthorityPlanner.close()
  }
}

const sanitizedRefPort: DshPlannerRunPort = {
  async run() {
    return {
      finalResponse: '',
      events: successfulToolEvents(
        'booking_search_hotels',
        JSON.stringify({ decision: { kind: 'operation', action: { ...searchRun, factRefs: ['draft:destination=Dubai', 'draft:destination.Dubai'] } } }),
        'call-sanitized-ref',
      ),
    }
  },
  async close() {},
}
const sanitizedRef = await createDshEmbeddedBookingPlanner({ runPort: sanitizedRefPort })
await assert.rejects(sanitizedRef.plannerFactory(task).next({
  task,
  turn: {
    schemaVersion: 'booking.surface',
    kind: 'user.turn',
    taskId: task.taskId,
    turnId: 'dsh-turn-6b',
    workspace,
    request: { text: 'Find hotels' },
  },
}), /planner_invalid_action/, 'unsafe fact refs are rejected as non-canonical raw arguments')
await sanitizedRef.close()

const collisionRawRefs = ['fact://a/b', 'fact:..a?b'] as const
for (const [index, rawRef] of collisionRawRefs.entries()) {
  const collisionPlanner = await createDshEmbeddedBookingPlanner({
    runPort: {
      async run() {
        return {
          finalResponse: '',
          events: successfulToolEvents(
            'booking_search_hotels',
            JSON.stringify({ decision: { kind: 'operation', action: { ...searchRun, actionId: `action-dsh-collision-${index}`, factRefs: [rawRef] } } }),
            `call-collision-${index}`,
          ),
        }
      },
      async close() {},
    },
  })
  await assert.rejects(collisionPlanner.plannerFactory(task).next({ task, turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: `dsh-collision-${index}`, workspace, request: { text: 'Find hotels' } } }), /planner_invalid_action/, 'unsafe refs are rejected without hashing')
  await collisionPlanner.close()
}

async function assertFactRefsRejected(factRefs: unknown[], message: string): Promise<void> {
  const planner = await createDshEmbeddedBookingPlanner({
    runPort: {
      async run() {
        return {
          finalResponse: '',
          events: successfulToolEvents(
            'booking_search_hotels',
            JSON.stringify({ decision: { kind: 'operation', action: { ...searchRun, factRefs } } }),
            'call-fact-ref-rejection',
          ),
        }
      },
      async close() {},
    },
  })
  await assert.rejects(
    planner.plannerFactory(task).next({ task, turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: 'dsh-ref-rejection', workspace, request: { text: 'Find hotels' } } }),
    /planner_invalid_action/,
    message,
  )
  await planner.close()
}
const firstAlias = 'modelref:'.concat(createHash('sha256').update(collisionRawRefs[0], 'utf8').digest('hex'))
await assertFactRefsRejected([collisionRawRefs[0], firstAlias], 'unsafe raw ref cannot alias a same-action reserved modelref')
await assertFactRefsRejected([collisionRawRefs[0], collisionRawRefs[0]], 'repair-time duplicate factRefs are rejected by canonical validation')
await assertFactRefsRejected(['modelref:'.concat('a'.repeat(64))], 'direct modelref namespace input is reserved and rejected')

const reservedText = await createDshEmbeddedBookingPlanner({
  runPort: {
    async run() {
      return { finalResponse: JSON.stringify({ kind: 'operation', action: { ...searchRun, factRefs: ['modelref:'.concat('b'.repeat(64))] } }), events: [] }
    },
    async close() {},
  },
})
const reservedTextDecision = await reservedText.plannerFactory(task).next({ task, turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: 'dsh-reserved-text', workspace, request: { text: 'Find hotels' } } })
assert.equal(reservedTextDecision[0]?.kind, 'error', 'finalResponse text stays non-executable even when it contains a reserved ref')
await reservedText.close()

let stableRefCall = 0
const stableRawRef = 'fact://same/raw'
const stablePlanner = await createDshEmbeddedBookingPlanner({
    runPort: {
      async run() {
        stableRefCall += 1
        return {
          finalResponse: '',
          events: successfulToolEvents(
            'booking_search_hotels',
            JSON.stringify({ decision: { kind: 'operation', action: { ...searchRun, actionId: `action-dsh-stable-${stableRefCall}`, factRefs: [stableRawRef] } } }),
            `call-stable-${stableRefCall}`,
          ),
        }
      },
    async close() {},
  },
})
await assert.rejects(stablePlanner.plannerFactory(task).next({ task, turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: 'dsh-stable-1', workspace, request: { text: 'Find hotels' } } }), /planner_invalid_action/)
await stablePlanner.close()

const unauthorisedPort: DshPlannerRunPort = {
  async run() {
    return { finalResponse: JSON.stringify({ kind: 'operation', action: hotelSelect }), events: [] }
  },
  async close() {},
}
const unauthorised = await createDshEmbeddedBookingPlanner({ runPort: unauthorisedPort })
const unauthorisedDecisions = await unauthorised.plannerFactory(task).next({
  task,
  turn: {
    schemaVersion: 'booking.surface',
    kind: 'user.turn',
    taskId: task.taskId,
    turnId: 'dsh-turn-4',
    workspace: {
      ...workspace,
      capabilities: { ...workspace.capabilities, allowedActions: [...workspace.capabilities.allowedActions] },
    },
    request: { text: 'Select a hotel' },
  },
})
assert.equal(unauthorisedDecisions[0]?.kind, 'error', 'text-channel decisions outside allowedActions stay non-executable')

const fragmentRefPort: DshPlannerRunPort = {
  async run() {
    return {
      finalResponse: '',
      events: successfulToolEvents(
        'booking_search_hotels',
        JSON.stringify({ decision: { kind: 'operation', action: { ...searchRun, factRefs: [`fact://turn_${task.lastTurnId}/request`] } } }),
        'call-fragment-ref',
      ),
    }
  },
  async close() {},
}
const fragmentRef = await createDshEmbeddedBookingPlanner({ runPort: fragmentRefPort })
await assert.rejects(fragmentRef.plannerFactory(task).next({
  task,
  turn: {
    schemaVersion: 'booking.surface',
    kind: 'user.turn',
    taskId: task.taskId,
    turnId: 'dsh-turn-7',
    workspace,
    request: { text: 'Find hotels' },
  },
}), /planner_invalid_action/, 'JSON-pointer fragment factRefs are rejected without hashing')
await fragmentRef.close()

const truncatedPort: DshPlannerRunPort = {
  async run() {
    // A reasoning-token budget cut in finalResponse is text-only evidence and
    // must never be repaired into an executable decision.
    const truncated = JSON.stringify({ decision: { action: { ...searchRun, factRefs: ['turn_cap-request'] }, kind: 'operation' } }).replace(/}+$/, '')
    return { finalResponse: truncated, events: [] }
  },
  async close() {},
}
const truncatedRecovery = await createDshEmbeddedBookingPlanner({ runPort: truncatedPort })
const truncatedDecisions = await truncatedRecovery.plannerFactory(task).next({
  task,
  turn: {
    schemaVersion: 'booking.surface',
    kind: 'user.turn',
    taskId: task.taskId,
    turnId: 'dsh-turn-8',
    workspace,
    request: { text: 'Find hotels' },
  },
})
assert.equal(truncatedDecisions[0]?.kind, 'error', 'truncated finalResponse never recovers into an executable decision')
await truncatedRecovery.close()

const unsafeRefPort: DshPlannerRunPort = {
  async run() {
    return {
      finalResponse: '',
      events: successfulToolEvents(
        'booking_search_hotels',
        JSON.stringify({ decision: { kind: 'operation', action: { ...searchRun, factRefs: [42] } } }),
        'call-unsafe-ref',
      ),
    }
  },
  async close() {},
}
const unsafeRef = await createDshEmbeddedBookingPlanner({ runPort: unsafeRefPort })
await assert.rejects(
  unsafeRef.plannerFactory(task).next({
    task,
    turn: {
      schemaVersion: 'booking.surface',
      kind: 'user.turn',
      taskId: task.taskId,
      turnId: 'dsh-turn-6',
      workspace,
      request: { text: 'Find hotels' },
    },
  }),
  /planner_invalid_action/,
  'non-string factRef entries retry as parse-class failures, not ledger-boundary crashes',
)
await unsafeRef.close()

// A workspace with loadedOffers for a hotel absent from the availability
// state (UI-loaded offers) must not crash the prompt projection.
const foreignOfferWorkspace = {
  ...workspace,
  loadedOffers: [{ offerRef: "offer-ui-1", offerVersionRef: "offerv-ui-1", hotelRef: "hotel-ui-9", evidenceLevel: "rate_loaded" as const, factRefs: [] }],
}
let uiOffersRuns = 0
const uiOffersPort: DshPlannerRunPort = {
  async run(prompt) {
    uiOffersRuns += 1
    if (uiOffersRuns === 1) assert.ok(prompt.includes("hotel-ui-9"), "workspace loadedOffers reach the planner payload")
    return { finalResponse: "", events: [] }
  },
  async close() {},
}
const uiOffers = await createDshEmbeddedBookingPlanner({ runPort: uiOffersPort })
const uiOffersDecisions = await uiOffers.plannerFactory(task).next({
  task,
  turn: { schemaVersion: "booking.surface", kind: "user.turn", taskId: task.taskId, turnId: "dsh-turn-ui", workspace: foreignOfferWorkspace, request: { text: "Prepare the loaded offer" } },
})
assert.equal(uiOffersDecisions[0]?.kind, "error", "foreign loadedOffers reach the payload without crashing the projection")
await uiOffers.close()

let plainProseRuns = 0
const plainProsePort: DshPlannerRunPort = {
  async run() {
    plainProseRuns += 1
    return { finalResponse: 'I would search hotels in Dubai for you.', events: [] }
  },
  async close() {},
}
const plainProse = await createDshEmbeddedBookingPlanner({ runPort: plainProsePort })
const plainProseDecisions = await plainProse.plannerFactory(task).next({
  task,
  turn: {
    schemaVersion: 'booking.surface',
    kind: 'user.turn',
    taskId: task.taskId,
    turnId: 'dsh-turn-5',
    workspace,
    request: { text: 'Find hotels' },
  },
})
assert.equal(plainProseRuns, 3, 'genuine prose receives the bounded typed-decision correction budget')
assert.deepEqual(plainProseDecisions[0], {
  kind: 'error',
  error: {
    code: 'PLANNER_TYPED_DECISION_REQUIRED',
    message: 'GoTry produced no typed capability decision; assistant prose was ignored.',
    retryable: false,
  },
}, 'prose without a typed decision envelope is never executable or client-retryable')

let authFailureRuns = 0
const authFailure = await createDshEmbeddedBookingPlanner({
  runPort: {
    async run() {
      authFailureRuns += 1
      return {
        finalResponse: '',
        events: [{ type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'AUTH', status: 401, message: 'provider authentication failed' } } } }],
        notifications: [{ method: 'session.event', params: {} }, { method: 'session.status', params: {} }],
      }
    },
    async close() {},
  },
})
const authFailureDecision = await authFailure.plannerFactory(task).next({
  task,
  turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: 'dsh-provider-auth', workspace, request: { text: 'Find hotels' } },
})
assert.equal(authFailureRuns, 1, 'provider AUTH failure fails closed without three empty-decision retries')
assert.deepEqual(authFailureDecision[0], { kind: 'error', error: { code: 'PLANNER_PROVIDER_AUTH_FAILED', message: 'The planner provider rejected authentication.', retryable: false } })
await authFailure.close()

let quotaFailureRuns = 0
const quotaFailure = await createDshEmbeddedBookingPlanner({
  runPort: {
    async run() {
      quotaFailureRuns += 1
      return {
        finalResponse: '',
        events: [{
          type: 'assistant/attempt',
          data: {
            stream: [{
              type: 'chunk',
              time: 1,
              chunk: { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA', status: 429, message: 'provider quota exhausted' } } },
            }],
          },
        }],
        notifications: [{ method: 'session.event', params: {} }, { method: 'session.status', params: {} }],
      }
    },
    async close() {},
  },
})
const quotaFailureDecision = await quotaFailure.plannerFactory(task).next({
  task,
  turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: 'dsh-provider-quota', workspace, request: { text: 'Find hotels' } },
})
assert.equal(quotaFailureRuns, 1, 'provider QUOTA failure fails closed without three empty-decision retries')
assert.deepEqual(quotaFailureDecision[0], { kind: 'error', error: { code: 'PLANNER_PROVIDER_QUOTA_EXHAUSTED', message: 'The planner provider quota is exhausted.', retryable: false } })
await quotaFailure.close()

let abortedFailureRuns = 0
const abortedFailure = await createDshEmbeddedBookingPlanner({
  runPort: {
    async run() {
      abortedFailureRuns += 1
      return {
        finalResponse: '',
        events: [{
          type: 'assistant/attempt',
          data: {
            stream: [{
              type: 'chunk',
              chunk: { type: 'finish', reason: { kind: 'aborted', failure: { code: 'TRANSPORT', message: 'provider stream aborted' } } },
            }],
          },
        }],
      }
    },
    async close() {},
  },
})
const abortedFailureDecision = await abortedFailure.plannerFactory(task).next({
  task,
  turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: 'dsh-provider-aborted', workspace, request: { text: 'Find hotels' } },
})
assert.equal(abortedFailureRuns, 1, 'packed aborted provider failure fails closed without empty-decision retries')
assert.deepEqual(abortedFailureDecision[0], { kind: 'error', error: { code: 'PLANNER_PROVIDER_UNAVAILABLE', message: 'The planner provider is temporarily unavailable.', retryable: true } })
await abortedFailure.close()

for (const fixture of [
  {
    name: 'rate-limit',
    failure: { code: 'RATE_LIMIT', status: 429, message: 'provider rate limited' },
    expected: { code: 'PLANNER_PROVIDER_RATE_LIMITED', message: 'The planner provider rate-limited the request.', retryable: true },
  },
  {
    name: 'transport',
    failure: { code: 'TRANSPORT', message: 'provider transport failed' },
    expected: { code: 'PLANNER_PROVIDER_UNAVAILABLE', message: 'The planner provider is temporarily unavailable.', retryable: true },
  },
  {
    name: 'empty-response',
    failure: { code: 'EMPTY_RESPONSE', message: 'provider returned no content' },
    expected: { code: 'PLANNER_PROVIDER_UNAVAILABLE', message: 'The planner provider is temporarily unavailable.', retryable: true },
  },
  {
    name: 'malformed-response',
    failure: { code: 'MALFORMED_RESPONSE', message: 'provider returned malformed data' },
    expected: { code: 'PLANNER_PROVIDER_RESPONSE_INVALID', message: 'The planner provider returned an invalid response.', retryable: false },
  },
  {
    name: 'invalid-response',
    failure: { code: 'INVALID_RESPONSE', message: 'provider response failed validation' },
    expected: { code: 'PLANNER_PROVIDER_RESPONSE_INVALID', message: 'The planner provider returned an invalid response.', retryable: false },
  },
  {
    name: 'invalid-request',
    failure: { code: 'INVALID_REQUEST', status: 400, message: 'provider rejected the request' },
    expected: { code: 'PLANNER_PROVIDER_REQUEST_REJECTED', message: 'The planner provider rejected the model request.', retryable: false },
  },
  {
    name: 'context-window',
    failure: { code: 'CONTEXT_WINDOW_EXCEEDED', status: 400, message: 'provider context window exceeded' },
    expected: { code: 'PLANNER_PROVIDER_REQUEST_REJECTED', message: 'The planner provider rejected the model request.', retryable: false },
  },
  {
    name: 'unsupported-option',
    failure: { code: 'UNSUPPORTED_OPTION', message: 'provider option unsupported' },
    expected: { code: 'PLANNER_CONFIGURATION_INVALID', message: 'The planner provider configuration is invalid.', retryable: false },
  },
] as const) {
  let runs = 0
  const planner = await createDshEmbeddedBookingPlanner({
    runPort: {
      async run() {
        runs += 1
        return {
          finalResponse: '',
          events: [{ type: 'turn/end', data: { reason: { kind: 'error', error: fixture.failure } } }],
        }
      },
      async close() {},
    },
  })
  const decision = await planner.plannerFactory(task).next({
    task,
    turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: `dsh-provider-${fixture.name}`, workspace, request: { text: 'Find hotels' } },
  })
  assert.equal(runs, 1, `provider ${fixture.name} failure is not mistaken for an empty decision`)
  assert.deepEqual(decision[0], { kind: 'error', error: fixture.expected })
  await planner.close()
}

const operationBeforeFailure = await createDshEmbeddedBookingPlanner({
  runPort: {
    async run() {
      return {
        finalResponse: '',
        events: [
          ...successfulToolEvents(
            'booking_search_hotels',
            JSON.stringify({ decision: { kind: 'operation', action: searchRun, intent: { target: 'search.results' } } }),
            'call-operation-before-failure',
          ),
          { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'AUTH', status: 401, message: 'post-tool provider failure' } } } },
        ],
      }
    },
    async close() {},
  },
})
const operationBeforeFailureDecision = await operationBeforeFailure.plannerFactory(task).next({
  task,
  turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: 'dsh-operation-before-provider-failure', workspace, request: { text: 'Find hotels' } },
})
assertRuntimeMaterializedOperation(operationBeforeFailureDecision, 'search.run', {}, task, 'a valid receipt-gated operation outranks a later provider failure')
await operationBeforeFailure.close()

const finalResponseBeforeTerminalFailure = await createDshEmbeddedBookingPlanner({
  runPort: {
    async run() {
      return {
        finalResponse: JSON.stringify({ kind: 'operation', action: searchRun }),
        events: [
          { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'AUTH', status: 401, message: 'terminal provider failure' } } } },
        ],
      }
    },
    async close() {},
  },
})
const finalResponseBeforeTerminalFailureDecision = await finalResponseBeforeTerminalFailure.plannerFactory(task).next({
  task,
  turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: 'dsh-final-response-before-terminal-failure', workspace, request: { text: 'Find hotels' } },
})
assert.deepEqual(
  finalResponseBeforeTerminalFailureDecision,
  [{ kind: 'error', error: { code: 'PLANNER_PROVIDER_AUTH_FAILED', message: 'The planner provider rejected authentication.', retryable: false } }],
  'authoritative turn/end error does not erase a successful typed tool result',
)
await finalResponseBeforeTerminalFailure.close()

for (const [name, malformedTerminal] of [
  ['missing-reason', { type: 'turn/end', data: {} }],
  ['missing-error', { type: 'turn/end', data: { reason: { kind: 'error' } } }],
] as const) {
  const malformedTerminalPlanner = await createDshEmbeddedBookingPlanner({
    runPort: {
      async run() {
        return {
          finalResponse: JSON.stringify({ kind: 'operation', action: searchRun }),
          events: [malformedTerminal],
        }
      },
      async close() {},
    },
  })
  const malformedTerminalDecision = await malformedTerminalPlanner.plannerFactory(task).next({
    task,
    turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: `dsh-malformed-terminal-${name}`, workspace, request: { text: 'Find hotels' } },
  })
  assert.deepEqual(
    malformedTerminalDecision,
    [{ kind: 'error', error: { code: 'PLANNER_FAILED', message: 'The planner stopped unexpectedly before producing a usable action.', retryable: false } }],
    `malformed terminal ${name} fails closed before compatibility finalResponse recovery`,
  )
  await malformedTerminalPlanner.close()
}

const finalTextAfterTransientAttempt = await createDshEmbeddedBookingPlanner({
  runPort: {
    async run() {
      return {
        finalResponse: JSON.stringify({ kind: 'operation', action: searchRun }),
        events: [
          {
            type: 'assistant/attempt',
            data: { stream: [{ type: 'chunk', chunk: { type: 'finish', reason: { kind: 'aborted', failure: { code: 'RATE_LIMIT', status: 429, message: 'recovered attempt' } } } }] },
          },
          { type: 'turn/end', data: { reason: { kind: 'completed' } } },
        ],
      }
    },
    async close() {},
  },
})
const finalTextAfterTransientAttemptDecision = await finalTextAfterTransientAttempt.plannerFactory(task).next({
  task,
  turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: 'dsh-final-text-provider-attempt', workspace, request: { text: 'Find hotels' } },
})
assert.deepEqual(finalTextAfterTransientAttemptDecision, [{ kind: 'error', error: { code: 'PLANNER_TYPED_DECISION_REQUIRED', message: 'GoTry produced no typed capability decision; assistant prose was ignored.', retryable: false } }], 'a completed turn ignores an earlier attempt failure but never promotes finalResponse text')
await finalTextAfterTransientAttempt.close()

const attemptFailureWithoutTerminalEvent = await createDshEmbeddedBookingPlanner({
  runPort: {
    async run() {
      return {
        finalResponse: JSON.stringify({ kind: 'operation', action: searchRun }),
        events: [
          {
            type: 'assistant/attempt',
            data: { stream: [{ type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', status: 429, message: 'truncated capture' } } } }] },
          },
        ],
      }
    },
    async close() {},
  },
})
const attemptFailureWithoutTerminalEventDecision = await attemptFailureWithoutTerminalEvent.plannerFactory(task).next({
  task,
  turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: 'dsh-attempt-failure-without-terminal-event', workspace, request: { text: 'Find hotels' } },
})
assert.deepEqual(
  attemptFailureWithoutTerminalEventDecision,
  [{ kind: 'error', error: { code: 'PLANNER_PROVIDER_RATE_LIMITED', message: 'The planner provider rate-limited the request.', retryable: true } }],
  'without a terminal event, the packed provider attempt failure remains authoritative over finalResponse text',
)
await attemptFailureWithoutTerminalEvent.close()

let proseAfterTransientAttemptRuns = 0
const proseAfterTransientAttempt = await createDshEmbeddedBookingPlanner({
  runPort: {
    async run() {
      proseAfterTransientAttemptRuns += 1
      return {
        finalResponse: 'I recovered but still emitted no tool call.',
        events: [
          {
            type: 'assistant/attempt',
            data: { stream: [{ type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error', failure: { code: 'EMPTY_RESPONSE', message: 'recovered attempt' } } } }] },
          },
          { type: 'turn/end', data: { reason: { kind: 'completed' } } },
        ],
      }
    },
    async close() {},
  },
})
const proseAfterTransientAttemptDecision = await proseAfterTransientAttempt.plannerFactory(task).next({
  task,
  turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: 'dsh-prose-after-provider-attempt', workspace, request: { text: 'Find hotels' } },
})
assert.equal(proseAfterTransientAttemptRuns, 3)
assert.equal(proseAfterTransientAttemptDecision[0]?.kind === 'error' ? proseAfterTransientAttemptDecision[0].error.code : '', 'PLANNER_TYPED_DECISION_REQUIRED', 'a completed prose-only turn is not relabelled with a stale attempt failure')
await proseAfterTransientAttempt.close()

for (const [code, message] of [
  ['PLANNER_PROVIDER_AUTH_FAILED', 'The planner provider rejected authentication.'],
  ['PLANNER_PROVIDER_QUOTA_EXHAUSTED', 'The planner provider quota is exhausted.'],
  ['PLANNER_PROVIDER_RATE_LIMITED', 'The planner provider rate-limited the request.'],
  ['PLANNER_PROVIDER_UNAVAILABLE', 'The planner provider is temporarily unavailable.'],
  ['PLANNER_PROVIDER_REQUEST_REJECTED', 'The planner provider rejected the model request.'],
  ['PLANNER_PROVIDER_RESPONSE_INVALID', 'The planner provider returned an invalid response.'],
  ['PLANNER_CONFIGURATION_INVALID', 'The planner provider configuration is invalid.'],
] as const) {
  assert.equal(normalizeBookingErrorCode(code.toLowerCase()), code, `${code} survives the closed error-code registry`)
  assert.equal(safeBookingErrorMessage(code), message, `${code} has a non-provider-authored safe message`)
}

const diagnosticSecretMarker = 'ISSUE_3580_PROVIDER_SECRET_MUST_NOT_BE_LOGGED'
const diagnosticLogs: string[] = []
const originalConsoleError = console.error
try {
  console.error = (...args: unknown[]) => { diagnosticLogs.push(args.map((value) => String(value)).join(' ')) }
  const proseWithSecret = await createDshEmbeddedBookingPlanner({
    runPort: {
      async run() {
        return {
          finalResponse: `provider prose ${diagnosticSecretMarker}`,
          notifications: [{ message: diagnosticSecretMarker }],
          events: [{ type: 'provider/debug', data: { message: diagnosticSecretMarker } }],
        }
      },
      async close() {},
    },
  })
  const proseWithSecretDecision = await proseWithSecret.plannerFactory(task).next({
    task,
    turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: 'dsh-secret-prose', workspace, request: { text: 'Find hotels' } },
  })
  assert.equal(proseWithSecretDecision[0]?.kind === 'error' ? proseWithSecretDecision[0].error.code : '', 'PLANNER_TYPED_DECISION_REQUIRED')
  await proseWithSecret.close()

  const forbiddenSecret = await createDshEmbeddedBookingPlanner({
    runPort: {
      async run() {
        const callId = 'call-forbidden-secret'
        return {
          finalResponse: '',
          events: [
            toolCall(`gotry_book_${diagnosticSecretMarker}`, '{}', callId),
            toolResult(callId, true, 'INVALID_ARGS'),
          ],
        }
      },
      async close() {},
    },
  })
  await assert.rejects(
    forbiddenSecret.plannerFactory(task).next({ task, turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: 'dsh-secret-tool', workspace, request: { text: 'Find hotels' } } }),
    (error: Error) => !String(error).includes(diagnosticSecretMarker) && /planner_forbidden_tool/.test(String(error)),
    'provider-authored tool names do not enter thrown errors',
  )
  await forbiddenSecret.close()
} finally {
  console.error = originalConsoleError
}
assert.equal(diagnosticLogs.some((line) => line.includes(diagnosticSecretMarker)), false, 'provider-authored text, notifications, events, and tool names are absent from planner logs')

const forbiddenPort: DshPlannerRunPort = {
  async run() {
    return {
      finalResponse: '',
      events: [
        toolCall('gotry_book', JSON.stringify({ decision: { kind: 'operation', action: { ...searchRun, kind: 'book' } } }), 'call-forbidden'),
        toolResult('call-forbidden', true, 'INVALID_ARGS'),
        ...successfulToolEvents('booking_search_hotels', JSON.stringify({ decision: { kind: 'operation', action: searchRun } }), 'call-after-forbidden'),
      ],
    }
  },
  async close() {},
}
const forbidden = await createDshEmbeddedBookingPlanner({ runPort: forbiddenPort })
await assert.rejects(
  forbidden.plannerFactory(task).next({
    task,
    turn: {
      schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: 'dsh-turn-4',
      workspace: { ...workspace, capabilities: { ...workspace.capabilities, allowedActions: [...workspace.capabilities.allowedActions] } },
      request: { text: '帮我下单' },
    },
  }),
  /planner_forbidden_tool/,
)

let forbiddenCrossRunRuns = 0
const forbiddenCrossRun = await createDshEmbeddedBookingPlanner({
  runPort: {
    async run() {
      forbiddenCrossRunRuns += 1
      return forbiddenCrossRunRuns === 1
        ? {
            finalResponse: '',
            events: [
              toolCall('gotry_book', JSON.stringify({ decision: { kind: 'operation', action: { ...searchRun, kind: 'book' } } }), 'call-cross-run-forbidden'),
              toolResult('call-cross-run-forbidden', true, 'INVALID_ARGS'),
            ],
          }
        : {
            finalResponse: '',
            events: successfulToolEvents('booking_search_hotels', JSON.stringify({ decision: { kind: 'operation', action: searchRun } }), 'call-cross-run-search'),
          }
    },
    async close() {},
  },
})
await assert.rejects(
  forbiddenCrossRun.plannerFactory(task).next({
    task,
    turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: 'dsh-cross-run-forbidden', workspace, request: { text: '帮我下单' } },
  }),
  /planner_forbidden_tool/,
  'a forbidden tool cannot be washed into a valid action by a later provider run',
)
assert.equal(forbiddenCrossRunRuns, 1, 'safety errors fail closed without a correction run')
await forbiddenCrossRun.close()

let invalidCrossRunRuns = 0
const invalidCrossRun = await createDshEmbeddedBookingPlanner({
  runPort: {
    async run() {
      invalidCrossRunRuns += 1
      return invalidCrossRunRuns === 1
        ? {
            finalResponse: '',
            events: [
              toolCall('booking_search_hotels', 'not-json', 'call-cross-run-invalid'),
              toolResult('call-cross-run-invalid', true, 'INVALID_ARGS'),
            ],
          }
        : {
            finalResponse: '',
            events: successfulToolEvents('booking_search_hotels', JSON.stringify({ decision: { kind: 'operation', action: searchRun } }), 'call-cross-run-invalid-recovery'),
          }
    },
    async close() {},
  },
})
await assert.rejects(
  invalidCrossRun.plannerFactory(task).next({
    task,
    turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: 'dsh-cross-run-invalid', workspace, request: { text: 'Find hotels' } },
  }),
  /planner_invalid_tool_arguments/,
  'a schema-invalid call cannot be washed into a valid action by a later provider run',
)
assert.equal(invalidCrossRunRuns, 1, 'event-authority schema errors fail closed without a correction run')
await invalidCrossRun.close()

const confirmedTask: BookingCopilotTaskState = {
  ...task,
  taskId: 'task-dsh-confirmed',
  contextRef: 'ctx-dsh-confirmed',
  revision: 1,
  allowedActions: ['search.patch', 'search.run', 'offers.query', 'offer.check', 'checkout.prepare'],
  availability: { initialized: true, recoveryStarted: true, availabilityPhase: 'terminal', activeHotelOrdinal: 0, hotelRefs: ['hotel-confirmed'], hotels: { 'hotel-confirmed': { hotelRef: 'hotel-confirmed', status: 'confirmed', generation: 1, generationNo: 1, currentOfferRefs: ['offer-confirmed'], invalidatedOfferRefs: [], tombstonedOfferRefs: [], tombstonedOfferVersionRefs: [], checksIssued: 1, checkCount: 1, offerQueriesIssued: 0, freshOffersRequired: false, lastEvidence: 'confirmed', currentGeneration: { generationId: 'hotel-confirmed:generation:1', source: { kind: 'workspace_snapshot', workspaceDigest: 'a'.repeat(64), workspaceRevision: 0 }, offerSetDigest: 'b'.repeat(64), orderedOfferRefs: ['offer-confirmed'], evidence: 'complete', valid: false } } }, attempts: [], queryReservations: [], terminal: { code: 'availability_confirmed', hotelRefs: ['hotel-confirmed'], reason: 'confirmed', evidence: 'conclusive' } },
  lastCompletedAction: completedCheckpoint({
    ...searchRun,
    kind: 'offer.check',
    actionId: 'action-confirmed-check',
    contextRef: 'ctx-dsh-confirmed',
    factRefs: [],
    input: { offerRef: 'offer-confirmed', offerVersionRef: 'offer-confirmed:v1' },
  }, 'dsh-confirmed-check-turn'),
  lastReceipt: {
    schemaVersion: 'booking.surface', kind: 'action.receipt', actionId: 'action-confirmed-check', contextRef: 'ctx-dsh-confirmed', status: 'applied', revision: 1,
    observation: { kind: 'offer.availability', offerRef: 'offer-confirmed', checkedOfferVersionRef: 'offer-confirmed:v1', currentOfferVersionRef: 'offer-confirmed:v1', verifiedOfferRef: 'verified-offer-confirmed', available: true, changedFactRefs: [] },
    resultContract: { outcome: 'complete', hardCriteriaMet: true, factRefs: ['offer:confirmed'], gapCodes: [], blockers: [], relaxationsApplied: [] },
  },
}
const confirmedWorkspace: BookingWorkspaceSnapshot = {
  ...workspace,
  contextRef: confirmedTask.contextRef,
  revision: 1,
  visibleHotels: [{ hotelRef: 'hotel-confirmed', name: 'Confirmed Hotel', factRefs: [] }],
  loadedOffers: [{ offerRef: 'offer-confirmed', offerVersionRef: 'offer-confirmed:v1', hotelRef: 'hotel-confirmed', evidenceLevel: 'rate_loaded', factRefs: [] }],
  shortlistedOfferRefs: ['offer-confirmed'],
  selectedOfferRef: 'offer-confirmed',
  verifiedOffer: { offerRef: 'offer-confirmed', offerVersionRef: 'offer-confirmed:v1', verifiedOfferRef: 'verified-offer-confirmed', expiresAt: '2026-09-09T11:00:00.000Z' },
  capabilities: { surface: 'tenant', allowedActions: [...confirmedTask.allowedActions] },
}
confirmedTask.workspaceSnapshot = confirmedWorkspace
const confirmedPrompts: string[] = []
const confirmedCheckout = await createDshEmbeddedBookingPlanner({
  runPort: {
    async run(prompt) {
      confirmedPrompts.push(prompt)
      return { finalResponse: '', events: successfulToolEvents('booking_prepare_booking', JSON.stringify({ decision: { kind: 'operation', action: { ...checkoutPrepare, contextRef: confirmedTask.contextRef }, intent: { target: 'checkout.prepared' } } }), 'call-confirmed-checkout') }
    },
    async close() {},
  },
})
const confirmedCheckoutDecision = await confirmedCheckout.plannerFactory(confirmedTask).next({ task: confirmedTask, turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: confirmedTask.taskId, turnId: 'dsh-confirmed-checkout', workspace: confirmedWorkspace, request: { text: '继续预订' } } })
assertRuntimeMaterializedOperation(confirmedCheckoutDecision, 'checkout.prepare', checkoutPrepare.input, confirmedTask, 'availability_confirmed can still produce checkout.prepare through the canonical booking_prepare_booking tool')
assert.deepEqual(confirmedTask.allowedActions, ['search.patch', 'search.run', 'offers.query', 'offer.check', 'checkout.prepare'], 'prompt projection does not mutate durable task allowedActions')
assert.deepEqual(promptPayload(confirmedPrompts[0]!).task.allowedActions, ['checkout.prepare'], 'availability_confirmed prompt narrows planner-visible actions to checkout.prepare')
assert.deepEqual(promptPayload(confirmedPrompts[0]!).turn.workspace.capabilities.allowedActions, ['checkout.prepare'], 'availability_confirmed prompt exposes one consistent action list in the turn workspace')
assert.deepEqual(confirmedWorkspace.capabilities.allowedActions, confirmedTask.allowedActions, 'prompt projection does not mutate the authoritative turn workspace')
assert.equal(promptPayload(confirmedPrompts[0]!).task.availability.terminalCode, 'availability_confirmed', 'confirmed prompt still exposes the availability terminal reason')
await confirmedCheckout.close()

const noCheckoutPrompt: string[] = []
const noCheckoutTask = { ...confirmedTask, taskId: 'task-dsh-confirmed-no-checkout', allowedActions: ['search.run' as const] }
const noCheckoutPlanner = await createDshEmbeddedBookingPlanner({
  runPort: {
    async run(prompt) {
      noCheckoutPrompt.push(prompt)
      return { finalResponse: '', events: successfulToolEvents('booking_prepare_booking', JSON.stringify({ kind: 'terminal' }), 'call-confirmed-no-checkout') }
    },
    async close() {},
  },
})
await noCheckoutPlanner.plannerFactory(noCheckoutTask).next({ task: noCheckoutTask, turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: noCheckoutTask.taskId, turnId: 'dsh-confirmed-no-checkout', workspace: { ...confirmedWorkspace, capabilities: { surface: 'tenant', allowedActions: [...noCheckoutTask.allowedActions] } }, request: { text: '继续预订' } } })
assert.deepEqual(promptPayload(noCheckoutPrompt[0]!).task.allowedActions, [], 'confirmed prompt never broadens a durable allowlist that lacks checkout.prepare')
assert.deepEqual(promptPayload(noCheckoutPrompt[0]!).turn.workspace.capabilities.allowedActions, [], 'confirmed prompt does not leak a broader workspace capability list')
await noCheckoutPlanner.close()

const confirmedProseOnly = await createDshEmbeddedBookingPlanner({
  runPort: {
    async run(prompt) {
      confirmedPrompts.push(prompt)
      return { finalResponse: JSON.stringify({ kind: 'operation', action: { ...checkoutPrepare, contextRef: confirmedTask.contextRef } }), events: [] }
    },
    async close() {},
  },
})
const confirmedProseOnlyDecision = await confirmedProseOnly.plannerFactory(confirmedTask).next({ task: confirmedTask, turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: confirmedTask.taskId, turnId: 'dsh-confirmed-prose-only', workspace: confirmedWorkspace, request: { text: '继续预订' } } })
assert.equal(confirmedProseOnlyDecision[0]?.kind === 'error' ? confirmedProseOnlyDecision[0].error.code : '', 'PLANNER_TYPED_DECISION_REQUIRED', 'availability_confirmed does not make prose-only checkout JSON executable')
assert.deepEqual(promptPayload(confirmedPrompts.at(-3)!).task.allowedActions, ['checkout.prepare'], 'prose-only correction starts from the narrowed confirmed prompt')
await confirmedProseOnly.close()

const finalityPlanner = await createDshEmbeddedBookingPlanner({
  runPort: {
    async run(prompt) {
      confirmedPrompts.push(prompt)
      return { finalResponse: '', events: successfulToolEvents('booking_prepare_booking', JSON.stringify({ kind: 'terminal' }), 'call-confirmed-terminal') }
    },
    async close() {},
  },
})
assert.deepEqual(
  await finalityPlanner.plannerFactory(confirmedTask).next({ task: confirmedTask, turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: confirmedTask.taskId, turnId: 'dsh-confirmed-terminal', workspace: confirmedWorkspace, request: { text: '只检查可订状态' } } }),
  [{ kind: 'terminal', terminal: { status: 'completed', summary: 'offer_available', factRefs: ['offer:confirmed'] } }],
  'terminal intent is materialized from the authoritative availability receipt',
)
assert.deepEqual(promptPayload(confirmedPrompts.at(-1)!).task.allowedActions, ['checkout.prepare'], 'terminal intent still receives the narrowed confirmed prompt')
await finalityPlanner.close()

const modelErrorPlanner = await createDshEmbeddedBookingPlanner({
  runPort: {
    async run() {
      return { finalResponse: '', events: successfulToolEvents('booking_prepare_booking', JSON.stringify({ decision: { kind: 'error', error: { code: 'PLANNER_FAILED', message: 'forged', retryable: false } } }), 'call-confirmed-error') }
    },
    async close() {},
  },
})
await assert.rejects(
  modelErrorPlanner.plannerFactory(confirmedTask).next({ task: confirmedTask, turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: confirmedTask.taskId, turnId: 'dsh-confirmed-error', workspace: confirmedWorkspace, request: { text: '只检查可订状态' } } }),
  /planner_nonoperation_runtime_owned/,
  'the model cannot impersonate a provider/runtime error decision',
)
await modelErrorPlanner.close()

const terminalTask: BookingCopilotTaskState = {
  schemaVersion: 'booking.surface', taskId: 'task-dsh-terminal', contextRef: 'ctx-dsh-terminal', surface: 'tenant', revision: 0,
  allowedActions: ['search.run'], userTurnCount: 1, lastTurnId: 'dsh-terminal-turn-1', operationCount: 0, phase: 'planning', lastSequence: 0,
  availability: { initialized: true, recoveryStarted: true, availabilityPhase: 'terminal', activeHotelOrdinal: 0, hotelRefs: [], hotels: {}, attempts: [], queryReservations: [], terminal: { code: 'availability_exhausted_complete', hotelRefs: [], reason: 'no_current_offers', evidence: 'conclusive' } },
}
const terminalWorkspace: BookingWorkspaceSnapshot = {
  schemaVersion: 'booking.surface', contextRef: terminalTask.contextRef, surface: 'tenant', revision: 0, locale: 'en-US', currency: 'AED',
  searchDraft: {}, results: { status: 'ready', resultCount: 1, searchSessionRef: 'search-terminal-1' }, visibleHotels: [], loadedOffers: [], shortlistedOfferRefs: [],
  capabilities: { surface: 'tenant', allowedActions: ['search.run'] },
}
terminalTask.workspaceSnapshot = terminalWorkspace
let terminalRuns = 0
const terminalPort: DshPlannerRunPort = {
  async run() {
    terminalRuns += 1
    return terminalRuns === 1
      ? {
          finalResponse: '',
          events: successfulToolEvents(
            'booking_search_hotels',
            JSON.stringify({ decision: { kind: 'operation', action: { ...searchRun, schemaVersion: 'booking.surface', contextRef: terminalTask.contextRef, actionId: 'action-dsh-terminal' }, intent: { target: 'search.results' } } }),
            'call-terminal-operation',
          ),
        }
      : {
          finalResponse: '',
          events: successfulToolEvents(
            'booking_search_hotels',
            JSON.stringify({ kind: 'terminal' }),
            'call-terminal-continuation',
          ),
        }
  },
  async close() {},
}
const terminalAdapter = await createDshEmbeddedBookingPlanner({ runPort: terminalPort })
const terminalSession = terminalAdapter.plannerFactory(terminalTask)
const terminalDecisions = await terminalSession.next({ task: terminalTask, turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: terminalTask.taskId, turnId: 'dsh-terminal-turn-1', workspace: terminalWorkspace, request: { text: 'find hotels' } } })
assert.equal(terminalDecisions[0]?.kind, 'operation', 'real DSH adapter accepts the canonical typed action')
assert.equal(terminalDecisions[0]?.kind === 'operation' ? terminalDecisions[0].action.schemaVersion : '', 'booking.surface')
const terminalActionId = terminalDecisions[0]?.kind === 'operation' ? terminalDecisions[0].action.actionId : 'action-dsh-terminal'
const terminalContinuation = { schemaVersion: 'booking.surface' as const, kind: 'action.receipt.continuation' as const, taskId: terminalTask.taskId, workspace: { ...terminalWorkspace, revision: 1, results: { ...terminalWorkspace.results, searchSessionRef: 'search-terminal-1' } }, receipt: { schemaVersion: 'booking.surface' as const, kind: 'action.receipt' as const, actionId: terminalActionId, contextRef: terminalTask.contextRef, status: 'applied' as const, revision: 1, observation: { kind: 'search.state' as const, searchSessionRef: 'search-terminal-1', resultCount: 1 }, resultContract: { outcome: 'complete' as const, hardCriteriaMet: true, factRefs: [], gapCodes: [], blockers: [], relaxationsApplied: [] } } }
const terminalContinuationWorkspace = terminalContinuation.workspace
if (terminalDecisions[0]?.kind !== 'operation') throw new Error('terminal proof did not produce an operation checkpoint')
const terminalContinuationDecision = await terminalSession.next({ task: { ...terminalTask, revision: 1, workspaceSnapshot: terminalContinuationWorkspace, lastCompletedAction: completedCheckpoint(terminalDecisions[0].action, 'dsh-terminal-turn-1'), lastReceipt: terminalContinuation.receipt }, turn: terminalContinuation })
assert.deepEqual(terminalContinuationDecision, [{ kind: 'terminal', terminal: { status: 'completed', summary: 'search_results_ready', factRefs: [] } }], 'real DSH planner materializes receipt continuation terminal state')
const gappedSearchReceipt: ActionReceipt = {
  ...terminalContinuation.receipt,
  resultContract: { ...terminalContinuation.receipt.resultContract, gapCodes: ['criterion_must_not_met'] },
}
const gappedSearchTerminal = await terminalSession.next({
  task: { ...terminalTask, revision: 1, workspaceSnapshot: terminalContinuationWorkspace, lastCompletedAction: completedCheckpoint(terminalDecisions[0].action, 'dsh-terminal-turn-1'), lastReceipt: gappedSearchReceipt },
  turn: { ...terminalContinuation, receipt: gappedSearchReceipt },
})
assert.deepEqual(
  gappedSearchTerminal,
  [{ kind: 'terminal', terminal: { status: 'stopped', summary: 'booking_constraints_unmet', factRefs: [] } }],
  'a receipt that declares a hard-criteria gap cannot be promoted to a completed search terminal',
)
await assert.rejects(
  terminalAdapter.plannerFactory(terminalTask).next({
    task: terminalTask,
    turn: { schemaVersion: 'booking.surface', kind: 'user.turn.ingress', requestKey: 'browser-request', surfaceHint: 'tenant', workspace: { schemaVersion: 'booking.surface', revision: 0, locale: 'en-US', currency: 'AED', searchDraft: {}, results: { status: 'idle' }, visibleHotels: [], loadedOffers: [], shortlistedOfferRefs: [] }, request: { text: 'browser ingress must be BFF-bound' } } as never,
  }),
  /planner_identity_required/,
)

// Regression: an index-keyed occupancy object is not a canonical array. It
// must fail at the same runPort -> tool/call -> parseToolDecision boundary the
// real adapter uses; the adapter never rewrites it into executable data.
const indexKeyedRoomsPort: DshPlannerRunPort = {
  async run() {
    return {
      finalResponse: '',
      events: [
        ...successfulToolEvents(
          'booking_search_hotels',
          JSON.stringify({
            decision: {
              kind: 'operation',
              action: {
                schemaVersion: 'booking.surface',
                kind: 'search.patch',
                actionId: 'action-dsh-index-keyed-rooms',
                contextRef: task.contextRef,
                expectedRevision: 0,
                reason: 'Patch occupancy from an index-keyed model payload.',
                factRefs: [],
                input: { patch: { occupancy: { rooms: { '0': { adults: 2, childAges: {} }, '1': {} } } } },
              },
            },
          }),
          'call-index-keyed-rooms',
        ),
      ],
    }
  },
  async close() {},
}
const indexKeyedRooms = await createDshEmbeddedBookingPlanner({ runPort: indexKeyedRoomsPort })
await assert.rejects(indexKeyedRooms.plannerFactory(task).next({
  task,
  turn: {
    schemaVersion: 'booking.surface',
    kind: 'user.turn',
    taskId: task.taskId,
    turnId: 'dsh-turn-index-keyed-rooms',
    workspace: { ...workspace, capabilities: { ...workspace.capabilities, allowedActions: [...workspace.capabilities.allowedActions] } },
    request: { text: 'Two adults, one room' },
  },
}), /planner_invalid_action/, 'index-keyed occupancy rooms are not canonical raw arguments')

const wrongRevision = await createDshEmbeddedBookingPlanner({ runPort: {
  async run() { return { finalResponse: '', events: successfulToolEvents('booking_search_hotels', JSON.stringify({ decision: { kind: 'operation', action: { ...searchRun, expectedRevision: task.revision + 1 } } }), 'call-wrong-revision') } },
  async close() {},
} })
await assert.rejects(
  wrongRevision.plannerFactory(task).next({ task, turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: 'dsh-wrong-revision', workspace, request: { text: 'Find hotels' } } }),
  /planner_revision_mismatch/,
  'a success receipt cannot authorize a model revision different from task.revision',
)
await wrongRevision.close()

let unsafeActionIdRuns = 0
const unsafeActionId = await createDshEmbeddedBookingPlanner({ runPort: {
  async run() {
    unsafeActionIdRuns += 1
    return {
      finalResponse: '',
      events: successfulToolEvents(
        'booking_search_hotels',
        JSON.stringify({ decision: { kind: 'operation', action: { ...searchRun, actionId: 'bad/id' } } }),
        'call-unsafe-action-id',
      ),
    }
  },
  async close() {},
} })
await assert.rejects(
  unsafeActionId.plannerFactory(task).next({ task, turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: 'dsh-unsafe-action-id', workspace, request: { text: 'Find hotels' } } }),
  /planner_invalid_action|unsafe_action_id/,
  'a success receipt cannot authorize an unsafe model-authored action id',
)
assert.equal(unsafeActionIdRuns, 1, 'unsafe action ids fail closed without a cross-run retry')
await unsafeActionId.close()

async function assertTraceRejected(events: Record<string, unknown>[], error: RegExp, message: string): Promise<void> {
  const planner = await createDshEmbeddedBookingPlanner({ runPort: { async run() { return { finalResponse: '', events } }, async close() {} } })
  await assert.rejects(planner.plannerFactory(task).next({ task, turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: `dsh-trace-${message}`, workspace, request: { text: 'Find hotels' } } }), error, message)
  await planner.close()
}
const traceCall = toolCall('booking_search_hotels', JSON.stringify({ decision: { kind: 'operation', action: searchRun } }), 'call-trace')
const traceResult = toolResult('call-trace')
await assertTraceRejected([traceCall, toolCall('booking_search_hotels', JSON.stringify({ decision: { kind: 'operation', action: searchRun } }), 'call-trace'), traceResult], /planner_tool_call_duplicate_call_id/, 'duplicate callId fails closed')
await assertTraceRejected([traceCall, traceResult, traceResult], /planner_tool_result_duplicate/, 'duplicate result fails closed')
await assertTraceRejected([toolResult('call-unmatched')], /planner_tool_result_unmatched/, 'unmatched result fails closed')
await assertTraceRejected([traceResult, traceCall], /planner_tool_result_out_of_order/, 'out-of-order result fails closed')

// Regression for #282: a non-empty room that carries child ages but omits
// adults is a semantic validation failure, not disposable representation.
// DSH exposes INVALID_ARGS to the model, which must emit a later canonical
// call inside the same run; the adapter does not start a fresh provider run.
let occupancyRepairRuns = 0
const occupancyRepairPort: DshPlannerRunPort = {
  async run() {
    occupancyRepairRuns += 1
    return {
      finalResponse: '',
      events: [
        toolCall('booking_search_hotels', JSON.stringify({
          decision: { kind: 'operation', action: { ...searchRun, kind: 'search.patch', actionId: 'action-dsh-282-occupancy-invalid', reason: 'Preserve both requested rooms and their child ages.', input: { patch: { occupancy: { rooms: [{ adults: 2, childAges: [6] }, { childAges: [4] }] } } } }, intent: { target: 'search.results' } },
        }), 'call-occupancy-invalid'),
        toolResult('call-occupancy-invalid', true, 'INVALID_ARGS'),
        ...successfulToolEvents('booking_search_hotels', JSON.stringify({
          decision: { kind: 'operation', action: { ...searchRun, kind: 'search.patch', actionId: 'action-dsh-282-occupancy-valid', reason: 'Preserve both requested rooms and their child ages.', input: { patch: { occupancy: { rooms: [{ adults: 2, childAges: [6] }, { adults: 1, childAges: [4] }] } } } }, intent: { target: 'search.results' } },
        }), 'call-occupancy-valid'),
      ],
    }
  },
  async close() {},
}
const occupancyRepair = await createDshEmbeddedBookingPlanner({ runPort: occupancyRepairPort })
const occupancyRepairDecision = await occupancyRepair.plannerFactory(task).next({
  task,
  turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: 'dsh-turn-282-occupancy', workspace, request: { text: '请保留两个房间和各自的儿童年龄：第一间2成人1儿童6岁，第二间1成人1儿童4岁' } },
})
assert.equal(occupancyRepairRuns, 1, 'missing adults is corrected within the same provider run')
assert.deepEqual(
  occupancyRepairDecision[0]?.kind === 'operation' ? occupancyRepairDecision[0].action.input : undefined,
  { patch: { occupancy: { rooms: [{ adults: 2, childAges: [6] }, { adults: 1, childAges: [4] }] } } },
  'corrected occupancy preserves both non-empty rooms and child criteria',
)

// Event-order regression (PR461 review F2): an INVALID_ARGS rejection that
// arrives after the accepted correction succeeded has not been observed by
// the model at decision time; the planning authority must fail closed.
let lateInvalidResultRuns = 0
const lateInvalidResultPort: DshPlannerRunPort = {
  async run() {
    lateInvalidResultRuns += 1
    return {
      finalResponse: '',
      events: [
        toolCall('booking_search_hotels', JSON.stringify({
          decision: { kind: 'operation', action: { ...searchRun, kind: 'search.patch', actionId: 'action-dsh-order-late-invalid', reason: 'Late invalid call.', input: { patch: { occupancy: { rooms: [{ adults: 2, childAges: [6] }, { childAges: [4] }] } } } }, intent: { target: 'search.results' } },
        }), 'call-order-late-invalid'),
        toolCall('booking_search_hotels', JSON.stringify({
          decision: { kind: 'operation', action: { ...searchRun, kind: 'search.patch', actionId: 'action-dsh-order-late-valid', reason: 'Late valid call.', input: { patch: { occupancy: { rooms: [{ adults: 2, childAges: [6] }, { adults: 1, childAges: [4] }] } } } }, intent: { target: 'search.results' } },
        }), 'call-order-late-valid'),
        toolResult('call-order-late-valid'),
        toolResult('call-order-late-invalid', true, 'INVALID_ARGS'),
      ],
    }
  },
  async close() {},
}
const lateInvalidResult = await createDshEmbeddedBookingPlanner({ runPort: lateInvalidResultPort })
await assert.rejects(
  lateInvalidResult.plannerFactory(task).next({
    task,
    turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: 'dsh-turn-order-late', workspace, request: { text: 'Find hotels' } },
  }),
  /planner_typed_decision_after_candidate/,
  'rejection feedback that lands after the accepted correction must fail closed',
)
assert.equal(lateInvalidResultRuns, 1, 'late rejection result fails closed within a single provider run')
await lateInvalidResult.close()

// Event-order regression (PR461 review F2): the correction call itself is
// emitted before the model receives the INVALID_ARGS rejection for the
// earlier invalid call; the planning authority must refuse to honour it.
let preFeedbackCorrectionRuns = 0
const preFeedbackCorrectionPort: DshPlannerRunPort = {
  async run() {
    preFeedbackCorrectionRuns += 1
    return {
      finalResponse: '',
      events: [
        toolCall('booking_search_hotels', JSON.stringify({
          decision: { kind: 'operation', action: { ...searchRun, kind: 'search.patch', actionId: 'action-dsh-order-pre-invalid', reason: 'Pre-feedback invalid call.', input: { patch: { occupancy: { rooms: [{ adults: 2, childAges: [6] }, { childAges: [4] }] } } } }, intent: { target: 'search.results' } },
        }), 'call-order-pre-invalid'),
        toolCall('booking_search_hotels', JSON.stringify({
          decision: { kind: 'operation', action: { ...searchRun, kind: 'search.patch', actionId: 'action-dsh-order-pre-valid', reason: 'Pre-feedback valid call.', input: { patch: { occupancy: { rooms: [{ adults: 2, childAges: [6] }, { adults: 1, childAges: [4] }] } } } }, intent: { target: 'search.results' } },
        }), 'call-order-pre-valid'),
        toolResult('call-order-pre-invalid', true, 'INVALID_ARGS'),
        toolResult('call-order-pre-valid'),
      ],
    }
  },
  async close() {},
}
const preFeedbackCorrection = await createDshEmbeddedBookingPlanner({ runPort: preFeedbackCorrectionPort })
await assert.rejects(
  preFeedbackCorrection.plannerFactory(task).next({
    task,
    turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: 'dsh-turn-order-pre', workspace, request: { text: 'Find hotels' } },
  }),
  /planner_typed_decision_after_candidate/,
  'correction emitted before its INVALID_ARGS feedback must fail closed',
)
assert.equal(preFeedbackCorrectionRuns, 1, 'pre-feedback correction fails closed within a single provider run')
await preFeedbackCorrection.close()

// A prose-only first response receives the same bounded correction treatment
// as a malformed typed call; a valid second typed call is returned immediately.
let proseRecoveryRuns = 0
const proseRecoveryPort: DshPlannerRunPort = {
  async run(prompt) {
    proseRecoveryRuns += 1
    if (proseRecoveryRuns === 1) return { finalResponse: '我会为你搜索酒店。', events: [] }
    assert.match(prompt, /no booking capability tool call/, 'prose correction is sent as the next counted prompt')
    return { finalResponse: '', events: successfulToolEvents('booking_search_hotels', JSON.stringify({ decision: { kind: 'operation', action: searchRun, intent: { target: 'search.results' } } }), 'call-prose-correction') }
  },
  async close() {},
}
const proseRecovery = await createDshEmbeddedBookingPlanner({ runPort: proseRecoveryPort })
const proseRecoveryDecision = await proseRecovery.plannerFactory(task).next({
  task,
  turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: 'dsh-turn-282-prose', workspace, request: { text: 'Find hotels' } },
})
assert.equal(proseRecoveryRuns, 2, 'prose correction uses the second counted call')
assertRuntimeMaterializedOperation(proseRecoveryDecision, 'search.run', {}, task, 'valid correction is returned instead of discarded')

// A malformed typed event is an authority error and fails on the first call.
// A provider failure likewise propagates instead of being silently swallowed.
let malformedRuns = 0
const malformedPort: DshPlannerRunPort = {
  async run() {
    malformedRuns += 1
    return {
      finalResponse: '',
      events: successfulToolEvents(
        'booking_search_hotels',
        JSON.stringify({ decision: { kind: 'operation', action: { ...searchRun, input: { patch: { occupancy: { rooms: [{ childAges: [4] }] } } } } } }),
        `call-malformed-${malformedRuns}`,
      ),
    }
  },
  async close() {},
}
const malformed = await createDshEmbeddedBookingPlanner({ runPort: malformedPort })
await assert.rejects(
  malformed.plannerFactory(task).next({ task, turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: 'dsh-turn-282-malformed', workspace, request: { text: 'Find hotels' } } }),
  /planner_invalid_action/,
  'repeated malformed output fails closed',
)
assert.equal(malformedRuns, 1, 'malformed typed output is not retried across provider runs')

let providerRuns = 0
const providerErrorPort: DshPlannerRunPort = {
  async run() {
    providerRuns += 1
    throw new Error('provider_transport_failure')
  },
  async close() {},
}
const providerError = await createDshEmbeddedBookingPlanner({ runPort: providerErrorPort })
await assert.rejects(
  providerError.plannerFactory(task).next({ task, turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: 'dsh-turn-282-provider', workspace, request: { text: 'Find hotels' } } }),
  /provider_transport_failure/,
  'provider failures remain visible to the caller',
)
assert.equal(providerRuns, 1, 'provider failures are not silently swallowed or retried')

await Promise.all([adapter.close(), textChannel.close(), fencedTextChannel.close(), stringifiedAction.close(), invalidThenValid.close(), invalidWithoutSchemaRejection.close(), unauthorised.close(), unauthorisedTyped.close(), multipleTypedSuccesses.close(), missingToolResult.close(), mismatchedToolResult.close(), fragmentRef.close(), truncatedRecovery.close(), sanitizedRef.close(), unsafeRef.close(), uiOffers.close(), forbidden.close(), terminalAdapter.close(), indexKeyedRooms.close(), occupancyRepair.close(), lateInvalidResult.close(), preFeedbackCorrection.close(), proseRecovery.close(), malformed.close(), providerError.close(), reservedText.close(), finalTextAfterTransientAttempt.close(), attemptFailureWithoutTerminalEvent.close()])

// Turn deadline/port-isolation contract.  These cases intentionally sit at
// the planner boundary: a provider that never settles must not hold the
// booking workspace for the provider's (potentially minutes-long) idle wait,
// and timing out task A must not close task B's runtime.
const plannerTimeoutTask = {
  ...task,
  taskId: 'task-dsh-timeout-a',
  lastTurnId: 'dsh-turn-timeout-a',
  contextRef: 'ctx-dsh-timeout-a',
  workspaceSnapshot: { ...workspace, contextRef: 'ctx-dsh-timeout-a' },
}
const plannerTimeoutTurn = {
  schemaVersion: 'booking.surface' as const,
  kind: 'user.turn' as const,
  taskId: plannerTimeoutTask.taskId,
  turnId: plannerTimeoutTask.lastTurnId,
  workspace: plannerTimeoutTask.workspaceSnapshot!,
  request: { text: 'Find hotels' },
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function resolveWithin<T>(promise: Promise<T>, ms: number): Promise<T | { testDeadline: true }> {
  return Promise.race([promise, waitMs(ms).then(() => ({ testDeadline: true as const }))])
}

let timeoutPortClosed = 0
const timeoutMetrics: import('../src/booking-surface/dsh-planner.ts').DshPlannerTurnMetric[] = []
const neverResolvingPort: DshPlannerRunPort = {
  run: () => new Promise<DshPlannerRunResult>((_resolve) => undefined),
  async close() { timeoutPortClosed += 1 },
}
const timeoutPlanner = await createDshEmbeddedBookingPlanner({
  runPortFactory: () => neverResolvingPort,
  turnTimeoutMs: 25,
  onMetric: (metric) => timeoutMetrics.push(metric),
} as DshEmbeddedBookingPlannerOptions & { turnTimeoutMs: number })
const timeoutResult = await resolveWithin(
  timeoutPlanner.plannerFactory(plannerTimeoutTask).next({ task: plannerTimeoutTask, turn: plannerTimeoutTurn }),
  250,
)
assert.notDeepEqual(timeoutResult, { testDeadline: true }, 'planner turn deadline returns before a never-resolving provider')
assert.equal((timeoutResult as any)[0]?.kind, 'error', 'provider timeout is a typed planner error')
assert.equal((timeoutResult as any)[0]?.error?.code, 'PLANNER_PROVIDER_TIMEOUT', 'provider timeout uses the stable error code')
assert.equal(timeoutMetrics[0]?.outcome, 'timeout', 'timeout contributes a safe latency metric')
assert.equal(timeoutMetrics[0]?.firstPassValid, false)
assert.ok((timeoutMetrics[0]?.elapsedMs ?? 999) < 250, 'timeout latency metric reflects the bounded turn')
assert.equal(timeoutPortClosed, 1, 'timing out a task closes its owned run port')
await timeoutPlanner.close()

let taskAClosed = 0
let taskARuns = 0
let taskBRuns = 0
let taskBClosed = 0
const isolatedPlanner = await createDshEmbeddedBookingPlanner({
  runPortFactory: (taskId: string) => {
    if (taskId === 'task-dsh-isolated-a') {
      return {
        run: () => {
          taskARuns += 1
          return new Promise<DshPlannerRunResult>((_resolve) => undefined)
        },
        async close() { taskAClosed += 1 },
      }
    }
    return {
      async run() {
        taskBRuns += 1
        return {
          finalResponse: '',
          events: successfulToolEvents('booking_search_hotels', JSON.stringify({ kind: 'search.run', input: {}, intent: { target: 'search.results' } }), 'call-isolated-b'),
        }
      },
      async close() { taskBClosed += 1 },
    }
  },
  turnTimeoutMs: 25,
} as DshEmbeddedBookingPlannerOptions & { runPortFactory: unknown; turnTimeoutMs: number })
const isolatedTaskA = { ...plannerTimeoutTask, taskId: 'task-dsh-isolated-a', lastTurnId: 'dsh-turn-isolated-a' }
const isolatedTaskB = { ...plannerTimeoutTask, taskId: 'task-dsh-isolated-b', lastTurnId: 'dsh-turn-isolated-b' }
const isolatedTurn = (isolatedTask: typeof isolatedTaskA) => ({ ...plannerTimeoutTurn, taskId: isolatedTask.taskId, turnId: isolatedTask.lastTurnId })
const isolatedA = resolveWithin(
  isolatedPlanner.plannerFactory(isolatedTaskA).next({ task: isolatedTaskA, turn: isolatedTurn(isolatedTaskA) }),
  250,
)
const isolatedB = await isolatedPlanner.plannerFactory(isolatedTaskB).next({ task: isolatedTaskB, turn: isolatedTurn(isolatedTaskB) })
const isolatedATimeout = await isolatedA
assert.notDeepEqual(isolatedATimeout, { testDeadline: true }, 'task A timeout is bounded')
assert.equal((isolatedATimeout as any)[0]?.error?.code, 'PLANNER_PROVIDER_TIMEOUT', 'task A receives a typed timeout')
assert.equal(taskAClosed, 1, 'task A timeout closes only task A port')
assertRuntimeMaterializedOperation(isolatedB, 'search.run', {}, isolatedTaskB, 'task B remains executable after task A timeout')
assert.equal(taskARuns, 1, 'task A provider is called once')
assert.equal(taskBRuns, 1, 'task B provider is called once')
await waitMs(0)
assert.equal(taskBClosed, 1, 'an accepted operation retires its task-owned provider port')
await isolatedPlanner.close()

// Receipt continuation rebuilds the DSH port from durable task state after
// the previous operation's port has been retired.
let rebuiltPortCount = 0
let rebuiltPortCloseCount = 0
const rebuiltTask = { ...plannerTimeoutTask, taskId: 'task-dsh-rebuild-port', lastTurnId: 'dsh-turn-rebuild-port' }
const rebuiltWorkspace = { ...rebuiltTask.workspaceSnapshot!, results: { status: 'idle' as const } }
const rebuiltPlanner = await createDshEmbeddedBookingPlanner({
  runPortFactory: () => {
    const portOrdinal = ++rebuiltPortCount
    return {
      async run() {
        return portOrdinal === 1
          ? { finalResponse: '', events: successfulToolEvents('booking_search_hotels', JSON.stringify({ kind: 'search.run', input: {}, intent: { target: 'search.results' } }), 'call-rebuild-first') }
          : { finalResponse: '', events: successfulToolEvents('booking_search_hotels', JSON.stringify({ kind: 'terminal' }), 'call-rebuild-terminal') }
      },
      async close() { rebuiltPortCloseCount += 1 },
    }
  },
  turnTimeoutMs: 250,
})
const rebuiltSession = rebuiltPlanner.plannerFactory(rebuiltTask)
const rebuiltFirst = await rebuiltSession.next({ task: rebuiltTask, turn: { ...plannerTimeoutTurn, taskId: rebuiltTask.taskId, turnId: rebuiltTask.lastTurnId, workspace: rebuiltWorkspace } })
assertRuntimeMaterializedOperation(rebuiltFirst, 'search.run', {}, rebuiltTask, 'first rebuilt-port turn emits search.run')
await waitMs(0)
assert.equal(rebuiltPortCount, 1, 'first receipt interval creates one provider port')
assert.equal(rebuiltPortCloseCount, 1, 'first accepted operation retires its provider port')
if (rebuiltFirst[0]?.kind !== 'operation') throw new Error('rebuilt-port first turn did not produce an operation')
const rebuiltReceipt: ActionReceipt = {
  schemaVersion: 'booking.surface', kind: 'action.receipt', actionId: rebuiltFirst[0].action.actionId, contextRef: rebuiltTask.contextRef,
  status: 'applied', revision: 1, observation: { kind: 'search.state', searchSessionRef: 'rebuilt-search-1', resultCount: 1 },
  resultContract: { outcome: 'complete', hardCriteriaMet: true, factRefs: [], gapCodes: [], blockers: [], relaxationsApplied: [] },
}
const rebuiltReadyWorkspace = { ...rebuiltWorkspace, revision: 1, results: { status: 'ready' as const, resultCount: 1, searchSessionRef: 'rebuilt-search-1' } }
const rebuiltSecond = await rebuiltSession.next({
  task: { ...rebuiltTask, revision: 1, workspaceSnapshot: rebuiltReadyWorkspace, lastCompletedAction: completedCheckpoint(rebuiltFirst[0].action, rebuiltTask.lastTurnId!), lastReceipt: rebuiltReceipt },
  turn: { schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId: rebuiltTask.taskId, workspace: rebuiltReadyWorkspace, receipt: rebuiltReceipt },
})
assert.deepEqual(rebuiltSecond, [{ kind: 'terminal', terminal: { status: 'completed', summary: 'search_results_ready', factRefs: [] } }], 'rebuilt port continuation can terminalize only after ready search workspace')
assert.equal(rebuiltPortCount, 2, 'receipt continuation creates a fresh provider port')
await rebuiltPlanner.close()

let latePortClosed = 0
const lateResolutionPort: DshPlannerRunPort = {
  async run() {
    await waitMs(80)
    return {
      finalResponse: '',
      events: successfulToolEvents('booking_search_hotels', JSON.stringify({ kind: 'search.run', input: {}, intent: { target: 'search.results' } }), 'call-late-resolution'),
    }
  },
  async close() { latePortClosed += 1 },
}
const latePlanner = await createDshEmbeddedBookingPlanner({
  runPortFactory: () => lateResolutionPort,
  turnTimeoutMs: 25,
} as DshEmbeddedBookingPlannerOptions & { turnTimeoutMs: number })
const lateResult = await resolveWithin(
  latePlanner.plannerFactory(plannerTimeoutTask).next({ task: plannerTimeoutTask, turn: plannerTimeoutTurn }),
  250,
)
assert.notDeepEqual(lateResult, { testDeadline: true }, 'late provider response does not extend the turn')
assert.equal((lateResult as any)[0]?.error?.code, 'PLANNER_PROVIDER_TIMEOUT', 'late response returns timeout')
await waitMs(110)
assert.equal(latePortClosed, 1, 'late response port is closed after timeout')
assert.notEqual((lateResult as any)[0]?.kind, 'operation', 'late resolution cannot become an executable decision')
await latePlanner.close()

// Shutdown waits for a task port whose factory and close are both still in
// flight. The planner cannot return while a late-created Harness child remains.
let resolveDeferredFactory!: (port: DshPlannerRunPort) => void
let resolveDeferredClose!: () => void
let deferredCloseCalls = 0
const deferredFactoryPlanner = await createDshEmbeddedBookingPlanner({
  runPortFactory: () => new Promise<DshPlannerRunPort>((resolve) => { resolveDeferredFactory = resolve }),
  turnTimeoutMs: 1_000,
})
const deferredSession = deferredFactoryPlanner.plannerFactory(plannerTimeoutTask)
const deferredNextOutcome = deferredSession.next({ task: plannerTimeoutTask, turn: plannerTimeoutTurn }).then(
  () => null,
  (error: unknown) => error,
)
await waitMs(0)
let deferredShutdownSettled = false
const deferredShutdown = deferredFactoryPlanner.close().then(() => { deferredShutdownSettled = true })
await waitMs(5)
assert.equal(deferredShutdownSettled, false, 'shutdown waits for a pending task-port factory')
resolveDeferredFactory({
  async run() { throw new Error('closed planner must not call a late-created port') },
  async close() {
    deferredCloseCalls += 1
    await new Promise<void>((resolve) => { resolveDeferredClose = resolve })
  },
})
await waitMs(5)
assert.equal(deferredCloseCalls, 1, 'shutdown closes the port produced by a late factory resolution')
assert.equal(deferredShutdownSettled, false, 'shutdown waits for late port cleanup to settle')
resolveDeferredClose()
await deferredShutdown
assert.match(String((await deferredNextOutcome as Error)?.message), /planner_closed/, 'an in-flight turn cannot use a port after planner shutdown')

// A failed close remains sticky; a non-retryable SDK cleanup cannot be
// re-invoked and then falsely reported as successful.
let cleanupAttempts = 0
const retryCleanupPlanner = await createDshEmbeddedBookingPlanner({
  runPortFactory: () => ({
    async run() {
      return { finalResponse: '', events: successfulToolEvents('booking_search_hotels', JSON.stringify({ kind: 'search.run', input: {}, intent: { target: 'search.results' } }), 'call-cleanup-retry') }
    },
    async close() {
      cleanupAttempts += 1
      if (cleanupAttempts === 1) throw new Error('fixture_cleanup_failed')
    },
  }),
})
await retryCleanupPlanner.plannerFactory(plannerTimeoutTask).next({ task: plannerTimeoutTask, turn: plannerTimeoutTurn })
await assert.rejects(retryCleanupPlanner.close(), /booking_planner_cleanup_failed/, 'shutdown surfaces a task-port cleanup failure')
await assert.rejects(retryCleanupPlanner.close(), /booking_planner_cleanup_failed/, 'later close callers observe the same cleanup failure')
assert.equal(cleanupAttempts, 1, 'a terminal cleanup promise is never re-invoked and laundered into success')

// Compact proposal authority matrix.  The model supplies only kind + input;
// all identity, revision, reason, and evidence bindings remain runtime-owned.
async function runCompactAuthorityCase(
  authorityTask: BookingCopilotTaskState,
  proposal: Record<string, unknown>,
  turnId = authorityTask.lastTurnId ?? 'authority-turn',
): Promise<readonly any[]> {
  const authorityWorkspace = authorityTask.workspaceSnapshot!
  const proposalKind = proposal.kind === 'operation' && typeof proposal.action === 'object' && proposal.action !== null
    ? (proposal.action as { kind?: unknown }).kind
    : proposal.kind
  const toolName = proposalKind === 'hotel.focus' || proposalKind === 'hotel.select'
    ? 'booking_refine_results'
    : proposalKind === 'offers.query' || proposalKind === 'offers.view.patch'
      ? 'booking_find_room_offers'
    : proposalKind === 'offer.select' || proposalKind === 'offers.compare'
      ? 'booking_compare_offers'
      : proposalKind === 'checkout.prepare' || proposalKind === 'offer.check'
        ? 'booking_prepare_booking'
        : 'booking_search_hotels'
  const planner = await createDshEmbeddedBookingPlanner({
    runPort: {
      async run() {
        return {
          finalResponse: '',
          events: successfulToolEvents(toolName, JSON.stringify(proposal), `call-authority-${turnId}`),
        }
      },
      async close() {},
    },
  })
  try {
    return await planner.plannerFactory(authorityTask).next({
      task: authorityTask,
      turn: {
        schemaVersion: 'booking.surface',
        kind: 'user.turn',
        taskId: authorityTask.taskId,
        turnId,
        workspace: authorityWorkspace,
        request: { text: 'Apply this booking request' },
      },
    })
  } finally {
    await planner.close()
  }
}

const budgetTask = {
  ...task,
  taskId: 'task-dsh-authority-budget',
  lastTurnId: 'dsh-turn-authority-budget',
  workspaceSnapshot: { ...workspace, currency: 'AED' },
}
const budgetProposal = {
  kind: 'search.patch',
  input: { patch: { budget: { strength: 'must', value: { max: { amount: '1000' } } } } },
  intent: { target: 'search.results' },
}
const [budgetDecision] = await runCompactAuthorityCase(budgetTask, budgetProposal)
assert.equal(budgetDecision?.kind, 'operation', 'budget compact proposal materializes an operation')
if (budgetDecision?.kind !== 'operation') throw new Error('budget proposal did not materialize')
assert.deepEqual(budgetDecision.action.input.patch.budget.value.max, {
  amount: '1000',
  currency: 'AED',
  sourceFactRef: 'turn:dsh-turn-authority-budget',
}, 'budget amount is hydrated from workspace currency and durable turn evidence')
assert.deepEqual(budgetDecision.action.factRefs, ['turn:dsh-turn-authority-budget'], 'hydrated budget contributes the durable turn fact reference')

const intentHydrationTask: BookingCopilotTaskState = {
  ...budgetTask,
  taskId: 'task-dsh-intent-hydration',
  lastTurnId: 'dsh-turn-intent-hydration',
  allowedActions: ['search.patch', 'offers.compare'],
  workspaceSnapshot: {
    ...budgetTask.workspaceSnapshot!,
    capabilities: { surface: 'tenant', allowedActions: ['search.patch', 'offers.compare'] },
  },
}
const [intentHydrationDecision] = await runCompactAuthorityCase(intentHydrationTask, {
  kind: 'search.patch',
  input: { patch: { destination: { query: 'Dubai' } } },
  intent: {
    target: 'offers.compared',
    offerCriteria: {
      totalPriceMax: { strength: 'must', value: { amount: '1000' } },
    },
  },
})
assert.equal(intentHydrationDecision?.kind, 'operation')
if (intentHydrationDecision?.kind !== 'operation') throw new Error('intent hydration did not materialize an operation')
assert.deepEqual(intentHydrationDecision.intent, {
  schemaVersion: BOOKING_INTENT_SCHEMA_VERSION,
  target: 'offers.compared',
  offerCriteria: {
    totalPriceMax: {
      strength: 'must',
      value: { amount: '1000', currency: 'AED', sourceFactRef: 'turn:dsh-turn-intent-hydration' },
    },
    targetCount: 3,
  },
}, 'intent money receives runtime provenance and unspecified comparison count defaults to three')

// A continuation repeats only plugin-facing semantic intent fields. The
// durable sourceFactRef remains bound to the original turn, so hydrated money
// must not force a repair/nudge or mutate the intent on the next provider pass.
const hydratedMoneyCriteria = {
  totalPriceMax: {
    strength: 'must' as const,
    value: { amount: '1000', currency: 'AED', sourceFactRef: 'turn:dsh-turn-money-origin' },
  },
  targetCount: 2,
}
const hydratedMoneyProjection = {
  schemaVersion: BOOKING_INTENT_SCHEMA_VERSION,
  target: 'offers.refined' as const,
  offerCriteria: hydratedMoneyCriteria,
}
const hydratedMoneyIntentBase = {
  taskId: 'task-dsh-money-continuation', contextRef: 'ctx-dsh-money-continuation',
  sourceTurnId: 'dsh-turn-money-origin', sourceRequestDigest: bookingDigest('find two affordable offers'),
  projection: hydratedMoneyProjection,
}
const hydratedMoneyIntent: BookingIntentCheckpoint = {
  ...hydratedMoneyIntentBase,
  intentDigest: bookingDigest(hydratedMoneyIntentBase),
}
const hydratedMoneyWorkspace: BookingWorkspaceSnapshot = {
  ...workspace,
  contextRef: hydratedMoneyIntent.contextRef,
  revision: 1,
  visibleHotels: [{ hotelRef: 'hotel-1', name: 'Hotel One', factRefs: ['hotel:1'] }],
  capabilities: { surface: 'tenant', allowedActions: ['offers.query', 'offers.view.patch'] },
}
const hydratedMoneyPriorAction: BookingReadAction = {
  ...searchRun,
  kind: 'offers.query', actionId: 'action-money-query', contextRef: hydratedMoneyIntent.contextRef,
  factRefs: [],
  input: { hotelRefs: ['hotel-1'], criteria: hydratedMoneyCriteria },
} as BookingReadAction
const hydratedMoneyReceipt: ActionReceipt = {
  schemaVersion: 'booking.surface', kind: 'action.receipt', actionId: hydratedMoneyPriorAction.actionId,
  contextRef: hydratedMoneyIntent.contextRef, status: 'applied', revision: 1,
  observation: { kind: 'offers.state', hotelRefs: ['hotel-1'], offerRefs: ['offer-money-a', 'offer-money-b'], loadedHotelCount: 1 },
  resultContract: { outcome: 'complete', requestedCount: 2, actualCount: 2, hardCriteriaMet: true, factRefs: [], gapCodes: [], blockers: [], relaxationsApplied: [] },
}
const hydratedMoneyPrompts: string[] = []
const hydratedMoneyMetrics: import('../src/booking-surface/dsh-planner.ts').DshPlannerTurnMetric[] = []
const hydratedMoneyPlanner = await createDshEmbeddedBookingPlanner({
  runPort: {
    async run(prompt) {
      hydratedMoneyPrompts.push(prompt)
      return {
        finalResponse: '',
        events: successfulToolEvents('booking_find_room_offers', JSON.stringify({
          kind: 'offers.view.patch',
          input: { hotelRef: 'hotel-1', criteria: { totalPriceMax: { strength: 'must', value: { amount: '1000', currency: 'AED' } }, targetCount: 2 } },
          intent: { target: 'offers.refined', offerCriteria: { totalPriceMax: { strength: 'must', value: { amount: '1000', currency: 'AED' } }, targetCount: 2 } },
        }), 'call-money-continuation'),
      }
    },
    async close() {},
  },
  onMetric: (metric) => hydratedMoneyMetrics.push(metric),
})
const hydratedMoneyTask: BookingCopilotTaskState = {
  ...task,
  taskId: hydratedMoneyIntent.taskId,
  contextRef: hydratedMoneyIntent.contextRef,
  revision: 1,
  lastTurnId: 'dsh-turn-money-continuation',
  allowedActions: ['offers.query', 'offers.view.patch'],
  activeIntent: hydratedMoneyIntent,
  lastCompletedAction: completedCheckpoint(hydratedMoneyPriorAction, hydratedMoneyIntent.sourceTurnId),
  lastReceipt: hydratedMoneyReceipt,
  workspaceSnapshot: hydratedMoneyWorkspace,
}
const [hydratedMoneyContinuation] = await hydratedMoneyPlanner.plannerFactory(hydratedMoneyTask).next({
  task: hydratedMoneyTask,
  turn: {
    schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId: hydratedMoneyTask.taskId,
    workspace: hydratedMoneyWorkspace, receipt: hydratedMoneyReceipt,
  },
})
assert.equal(hydratedMoneyContinuation?.kind, 'operation', 'hydrated-money continuation remains a first-pass operation')
if (hydratedMoneyContinuation?.kind !== 'operation') throw new Error('hydrated-money continuation did not produce an operation')
assert.deepEqual((hydratedMoneyContinuation.action as Extract<BookingReadAction, { kind: 'offers.view.patch' }>).input.criteria, hydratedMoneyCriteria, 'continuation action keeps the durable money provenance binding')
assert.equal(hydratedMoneyMetrics[0]?.firstPassValid, true, 'hydrated-money continuation requires no schema repair or prose nudge')
const hydratedMoneyPayload = promptPayload(hydratedMoneyPrompts[0]!)
assert.deepEqual(hydratedMoneyPayload.task.activeIntent, {
  target: 'offers.refined', offerCriteria: {
    totalPriceMax: { strength: 'must', value: { amount: '1000', currency: 'AED' } }, targetCount: 2,
  },
}, 'continuation payload projects exactly the plugin semantic intent fields')
assert.ok(!JSON.stringify(hydratedMoneyPayload.task.activeIntent).includes('sourceFactRef'), 'continuation payload omits runtime money provenance')
assert.ok(!Object.prototype.hasOwnProperty.call(hydratedMoneyPayload.task.activeIntent, 'schemaVersion'), 'continuation payload omits runtime intent schemaVersion')
await hydratedMoneyPlanner.close()

const offerCriteria = {
  meals: { strength: 'must' as const, value: ['breakfast'] },
  freeCancellation: { strength: 'must' as const, value: true },
  targetCount: 3,
}
const offerCriteriaBindingTask: BookingCopilotTaskState = {
  ...task,
  taskId: 'task-dsh-intent-action-binding',
  lastTurnId: 'dsh-turn-intent-action-binding',
  allowedActions: ['offers.query'],
  workspaceSnapshot: {
    ...workspace,
    visibleHotels: [{ hotelRef: 'hotel-1', name: 'Hotel One', factRefs: ['hotel:1'] }],
    capabilities: { surface: 'tenant', allowedActions: ['offers.query'] },
  },
}
const [offerCriteriaBindingDecision] = await runCompactAuthorityCase(offerCriteriaBindingTask, {
  kind: 'offers.query',
  input: { hotelRefs: ['hotel-1'], criteria: { targetCount: 1 } },
  intent: { target: 'offers.loaded', offerCriteria },
})
assert.equal(offerCriteriaBindingDecision?.kind, 'operation')
if (offerCriteriaBindingDecision?.kind !== 'operation') throw new Error('offer criteria binding did not materialize an operation')
assert.deepEqual(
  offerCriteriaBindingDecision.action.input.criteria,
  offerCriteria,
  'runtime compilation binds the authoritative intent criteria instead of executing a weaker model-authored query',
)
await assert.rejects(
  runCompactAuthorityCase({
    ...intentHydrationTask,
    taskId: 'task-dsh-intent-unsupported',
    allowedActions: ['search.patch'],
    workspaceSnapshot: {
      ...intentHydrationTask.workspaceSnapshot!,
      capabilities: { surface: 'tenant', allowedActions: ['search.patch'] },
    },
  }, {
    kind: 'search.patch',
    input: { patch: { destination: { query: 'Dubai' } } },
    intent: { target: 'offers.compared' },
  }),
  /planner_intent_target_unsupported/,
  'a typed intent cannot expand the current surface capability policy',
)

// An intent target is durable planner state, not Harness session state. The
// offers.compared target survives retirement/rebuild of the per-turn port and
// cannot be terminalized after an earlier offers.query receipt.
const comparedWorkspace: BookingWorkspaceSnapshot = {
  ...workspace,
  loadedOffers: [
    { offerRef: 'offer-compared-a', offerVersionRef: 'offer-compared-a:v1', hotelRef: 'hotel-1', evidenceLevel: 'rate_loaded', factRefs: ['offer:compared:a'] },
    { offerRef: 'offer-compared-b', offerVersionRef: 'offer-compared-b:v1', hotelRef: 'hotel-1', evidenceLevel: 'rate_loaded', factRefs: ['offer:compared:b'] },
  ],
  capabilities: { surface: 'tenant', allowedActions: ['offers.query', 'offers.compare'] },
}
const comparedIntent = { schemaVersion: BOOKING_INTENT_SCHEMA_VERSION, target: 'offers.compared' as const, offerCriteria: { targetCount: 2 } }
const comparedIntentBase = { taskId: 'task-dsh-intent-compared', contextRef: 'ctx-dsh-intent-compared', sourceTurnId: 'dsh-intent-compared', sourceRequestDigest: bookingDigest('compare these offers'), projection: comparedIntent }
const comparedActiveIntent: BookingIntentCheckpoint = { ...comparedIntentBase, intentDigest: bookingDigest(comparedIntentBase) }
const comparedTask: BookingCopilotTaskState = {
  ...task,
  taskId: 'task-dsh-intent-compared', contextRef: 'ctx-dsh-intent-compared', lastTurnId: comparedIntentBase.sourceTurnId,
  allowedActions: ['offers.query', 'offers.compare'], workspaceSnapshot: { ...comparedWorkspace, contextRef: 'ctx-dsh-intent-compared', revision: 1 },
}
let comparedPortOrdinal = 0
const comparedPlanner = await createDshEmbeddedBookingPlanner({
  runPortFactory: () => {
    comparedPortOrdinal += 1
    return {
      async run() {
        return comparedPortOrdinal === 1
          ? { finalResponse: '', events: successfulToolEvents('booking_compare_offers', JSON.stringify({ kind: 'offers.compare', input: { offerRefs: ['offer-compared-a', 'offer-compared-b'], requestedCount: 2 }, intent: { target: 'offers.compared', offerCriteria: { targetCount: 2 } } }), `call-compared-${comparedPortOrdinal}`) }
          : { finalResponse: '', events: successfulToolEvents('booking_compare_offers', JSON.stringify({ kind: 'terminal' }), `call-compared-${comparedPortOrdinal}`) }
      },
      async close() {},
    }
  },
})
const comparedSession = comparedPlanner.plannerFactory(comparedTask)
const comparedFirst = await comparedSession.next({ task: comparedTask, turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: comparedTask.taskId, turnId: comparedTask.lastTurnId!, workspace: comparedTask.workspaceSnapshot!, request: { text: 'Compare these offers' } } })
assert.equal(comparedFirst[0]?.kind, 'operation')
if (comparedFirst[0]?.kind !== 'operation') throw new Error('intent comparison did not produce an operation')
assert.deepEqual(comparedFirst[0].intent, comparedIntent, 'model proposal intent receives runtime schemaVersion')
const comparedReceipt: ActionReceipt = {
  schemaVersion: 'booking.surface', kind: 'action.receipt', actionId: comparedFirst[0].action.actionId, contextRef: comparedTask.contextRef,
  status: 'applied', revision: 1, observation: { kind: 'offers.state', hotelRefs: ['hotel-1'], offerRefs: ['offer-compared-a', 'offer-compared-b'], loadedHotelCount: 1 },
  resultContract: { outcome: 'complete', requestedCount: 2, actualCount: 2, hardCriteriaMet: true, factRefs: [], gapCodes: [], blockers: [], relaxationsApplied: [] },
}
const priorOffersQuery = { ...searchRun, kind: 'offers.query' as const, actionId: 'action-prior-offers-query', contextRef: comparedTask.contextRef, factRefs: [] as string[], input: { hotelRefs: ['hotel-1'], criteria: { targetCount: 2 } } } as BookingReadAction
const prematureReceipt: ActionReceipt = { ...comparedReceipt, actionId: priorOffersQuery.actionId, observation: { kind: 'offers.state', hotelRefs: ['hotel-1'], offerRefs: ['offer-compared-a'], loadedHotelCount: 1 } }
const prematureIntentTask = { ...comparedTask, revision: 1, activeIntent: comparedActiveIntent, lastCompletedAction: completedCheckpoint(priorOffersQuery, comparedTask.lastTurnId!), lastReceipt: prematureReceipt }
await assert.rejects(
  comparedSession.next({ task: prematureIntentTask, turn: { schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId: comparedTask.taskId, workspace: { ...comparedTask.workspaceSnapshot!, revision: 1 }, receipt: prematureIntentTask.lastReceipt! } }),
  /planner_terminal_intent_target_unachieved/,
  'offers.compared intent cannot terminalize after a non-target offers receipt',
)
const comparedTerminalTask = { ...prematureIntentTask, lastCompletedAction: completedCheckpoint(comparedFirst[0].action, comparedTask.lastTurnId!), lastReceipt: comparedReceipt }
const comparedTerminal = await comparedSession.next({ task: comparedTerminalTask, turn: { schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId: comparedTask.taskId, workspace: { ...comparedTask.workspaceSnapshot!, revision: 1 }, receipt: comparedReceipt } })
assert.deepEqual(comparedTerminal, [{ kind: 'terminal', terminal: { status: 'completed', summary: 'room_offers_ready', factRefs: [] } }], 'offers.compared intent survives per-turn port retirement and terminalizes only at its target')
assert.equal(comparedPortOrdinal, 3, 'intent continuation rebuilds the retired provider port after the guarded premature attempt')

if (comparedFirst[0].action.kind !== 'offers.compare') throw new Error('comparison proof received the wrong action kind')
const underfilledCompareAction: Extract<BookingReadAction, { kind: 'offers.compare' }> = {
  ...comparedFirst[0].action,
  actionId: 'action-underfilled-compare',
  input: { offerRefs: ['offer-compared-a'], requestedCount: 2 },
}
const underfilledCompareReceipt: ActionReceipt = {
  ...comparedReceipt,
  actionId: underfilledCompareAction.actionId,
  observation: { kind: 'offers.state', hotelRefs: ['hotel-1'], offerRefs: ['offer-compared-a'], loadedHotelCount: 1 },
  resultContract: { ...comparedReceipt.resultContract, actualCount: 1 },
}
const underfilledCompareTask = {
  ...comparedTerminalTask,
  lastCompletedAction: completedCheckpoint(underfilledCompareAction, comparedTask.lastTurnId!),
  lastReceipt: underfilledCompareReceipt,
}
const underfilledTerminal = await comparedSession.next({
  task: underfilledCompareTask,
  turn: { schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId: comparedTask.taskId, workspace: { ...comparedTask.workspaceSnapshot!, revision: 1 }, receipt: underfilledCompareReceipt },
})
assert.deepEqual(
  underfilledTerminal,
  [{ kind: 'terminal', terminal: { status: 'stopped', summary: 'offer_target_not_reached', factRefs: [] } }],
  'a receipt cannot claim a completed comparison when fewer offers than the durable target were compared',
)

const falseActualCountReceipt: ActionReceipt = {
  ...comparedReceipt,
  resultContract: { ...comparedReceipt.resultContract, actualCount: 1 },
}
const falseActualCountTerminal = await comparedSession.next({
  task: { ...comparedTerminalTask, lastReceipt: falseActualCountReceipt },
  turn: { schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId: comparedTask.taskId, workspace: { ...comparedTask.workspaceSnapshot!, revision: 1 }, receipt: falseActualCountReceipt },
})
assert.deepEqual(
  falseActualCountTerminal,
  [{ kind: 'terminal', terminal: { status: 'stopped', summary: 'offer_target_not_reached', factRefs: [] } }],
  'the terminal uses receipt actualCount rather than the model-authored comparison input length',
)

const constrainedOfferCriteria = {
  meals: { strength: 'must' as const, value: ['breakfast'] },
  freeCancellation: { strength: 'must' as const, value: true },
  targetCount: 2,
}
const constrainedProjection = {
  schemaVersion: BOOKING_INTENT_SCHEMA_VERSION,
  target: 'offers.compared' as const,
  offerCriteria: constrainedOfferCriteria,
}
const constrainedIntentBase = {
  ...comparedIntentBase,
  projection: constrainedProjection,
}
const constrainedIntent: BookingIntentCheckpoint = {
  ...constrainedIntentBase,
  intentDigest: bookingDigest(constrainedIntentBase),
}
const mismatchedCriteriaTask = {
  ...comparedTerminalTask,
  activeIntent: constrainedIntent,
  availability: {
    ...comparedTerminalTask.availability,
    criteria: { targetCount: 2 },
    criteriaDigest: bookingDigest({ targetCount: 2 }),
  },
}
await assert.rejects(
  comparedSession.next({ task: mismatchedCriteriaTask, turn: { schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId: comparedTask.taskId, workspace: { ...comparedTask.workspaceSnapshot!, revision: 1 }, receipt: comparedReceipt } }),
  /planner_terminal_intent_criteria_unachieved/,
  'matching an action kind cannot erase meal or cancellation constraints from the durable intent',
)
const constrainedCriteriaTask = {
  ...mismatchedCriteriaTask,
  availability: {
    ...mismatchedCriteriaTask.availability,
    criteria: constrainedOfferCriteria,
    criteriaDigest: bookingDigest(constrainedOfferCriteria),
  },
}
const constrainedTerminal = await comparedSession.next({
  task: constrainedCriteriaTask,
  turn: { schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId: comparedTask.taskId, workspace: { ...comparedTask.workspaceSnapshot!, revision: 1 }, receipt: comparedReceipt },
})
assert.deepEqual(constrainedTerminal, [{ kind: 'terminal', terminal: { status: 'completed', summary: 'room_offers_ready', factRefs: [] } }], 'matching criteria lineage permits the requested comparison waypoint')

function offerTargetIntentCheckpoint(taskId: string, contextRef: string, sourceTurnId: string, target: 'offers.loaded' | 'offers.refined', offerCriteria: { targetCount: number }): BookingIntentCheckpoint {
  const base = {
    taskId, contextRef, sourceTurnId, sourceRequestDigest: bookingDigest(`${target}:${offerCriteria.targetCount}`),
    projection: { schemaVersion: BOOKING_INTENT_SCHEMA_VERSION, target, offerCriteria },
  }
  return { ...base, intentDigest: bookingDigest(base) }
}

const queryTargetIntent = offerTargetIntentCheckpoint('task-dsh-offer-query-underfill', 'ctx-dsh-offer-query-underfill', 'dsh-offer-query-underfill', 'offers.loaded', { targetCount: 2 })
const queryTargetAction: BookingReadAction = {
  ...searchRun, kind: 'offers.query', actionId: 'action-offer-query-underfill', contextRef: queryTargetIntent.contextRef, factRefs: [],
  input: { hotelRefs: ['hotel-1'], criteria: { targetCount: 2 } },
} as BookingReadAction
const queryTargetReceipt: ActionReceipt = {
  ...comparedReceipt, actionId: queryTargetAction.actionId, contextRef: queryTargetIntent.contextRef,
  observation: { kind: 'offers.state', hotelRefs: ['hotel-1'], offerRefs: ['offer-compared-a'], loadedHotelCount: 1 },
  resultContract: { ...comparedReceipt.resultContract, requestedCount: 2, actualCount: 1 },
}
const queryTargetTask: BookingCopilotTaskState = {
  ...comparedTask, taskId: queryTargetIntent.taskId, contextRef: queryTargetIntent.contextRef,
  allowedActions: ['offers.query'], revision: 1, activeIntent: queryTargetIntent,
  lastCompletedAction: completedCheckpoint(queryTargetAction, queryTargetIntent.sourceTurnId), lastReceipt: queryTargetReceipt,
  workspaceSnapshot: { ...comparedWorkspace, contextRef: queryTargetIntent.contextRef, revision: 1, capabilities: { surface: 'tenant', allowedActions: ['offers.query'] } },
}
assert.deepEqual(await runTerminalContinuation(queryTargetTask, queryTargetReceipt), [{ kind: 'terminal', terminal: { status: 'stopped', summary: 'offer_target_not_reached', factRefs: [] } }], 'offers.query underfill cannot terminalize as completed')
const queryInconsistentReceipt: ActionReceipt = {
  ...queryTargetReceipt,
  observation: { kind: 'offers.state', hotelRefs: ['hotel-1'], offerRefs: ['offer-compared-a', 'offer-compared-b'], loadedHotelCount: 1 },
  resultContract: { ...queryTargetReceipt.resultContract, actualCount: 1 },
}
assert.deepEqual(await runTerminalContinuation({ ...queryTargetTask, lastReceipt: queryInconsistentReceipt }, queryInconsistentReceipt), [{ kind: 'terminal', terminal: { status: 'stopped', summary: 'offer_target_not_reached', factRefs: [] } }], 'offers.query rejects inconsistent authoritative actualCount and offer refs')

const viewTargetIntent = offerTargetIntentCheckpoint('task-dsh-offer-view-underfill', 'ctx-dsh-offer-view-underfill', 'dsh-offer-view-underfill', 'offers.refined', { targetCount: 2 })
const viewTargetAction: BookingReadAction = {
  ...searchRun, kind: 'offers.view.patch', actionId: 'action-offer-view-underfill', contextRef: viewTargetIntent.contextRef, factRefs: [],
  input: { hotelRef: 'hotel-1', criteria: { targetCount: 2 } },
} as BookingReadAction
const viewTargetReceipt: ActionReceipt = {
  ...comparedReceipt, actionId: viewTargetAction.actionId, contextRef: viewTargetIntent.contextRef,
  observation: { kind: 'offers.state', hotelRefs: ['hotel-1'], offerRefs: ['offer-compared-a'], loadedHotelCount: 1 },
  resultContract: { ...comparedReceipt.resultContract, requestedCount: 2, actualCount: 1 },
}
const viewTargetTask: BookingCopilotTaskState = {
  ...comparedTask, taskId: viewTargetIntent.taskId, contextRef: viewTargetIntent.contextRef,
  allowedActions: ['offers.view.patch'], revision: 1, activeIntent: viewTargetIntent,
  lastCompletedAction: completedCheckpoint(viewTargetAction, viewTargetIntent.sourceTurnId), lastReceipt: viewTargetReceipt,
  workspaceSnapshot: { ...comparedWorkspace, contextRef: viewTargetIntent.contextRef, revision: 1, capabilities: { surface: 'tenant', allowedActions: ['offers.view.patch'] } },
}
assert.deepEqual(await runTerminalContinuation(viewTargetTask, viewTargetReceipt), [{ kind: 'terminal', terminal: { status: 'stopped', summary: 'offer_target_not_reached', factRefs: [] } }], 'offers.view.patch underfill cannot terminalize as completed')
const viewInconsistentReceipt: ActionReceipt = {
  ...viewTargetReceipt,
  observation: { kind: 'offers.state', hotelRefs: ['hotel-1'], offerRefs: ['offer-compared-a', 'offer-compared-b'], loadedHotelCount: 1 },
  resultContract: { ...viewTargetReceipt.resultContract, actualCount: 1 },
}
assert.deepEqual(await runTerminalContinuation({ ...viewTargetTask, lastReceipt: viewInconsistentReceipt }, viewInconsistentReceipt), [{ kind: 'terminal', terminal: { status: 'stopped', summary: 'offer_target_not_reached', factRefs: [] } }], 'offers.view.patch rejects inconsistent authoritative actualCount and offer refs')

// A later single-offer waypoint carries the earlier multi-offer goal through
// the authoritative Compare Tray. It must not require fake count fields on an
// offer.selection receipt, and it must not forget an underfilled shortlist.
const selectedProjection = { schemaVersion: BOOKING_INTENT_SCHEMA_VERSION, target: 'offer.selected' as const, offerCriteria: { targetCount: 2 } }
const selectedIntentBase = { taskId: 'task-dsh-offer-selected-count', contextRef: 'ctx-dsh-offer-selected-count', sourceTurnId: 'dsh-offer-selected-count', sourceRequestDigest: bookingDigest('find two offers and select one'), projection: selectedProjection }
const selectedIntent: BookingIntentCheckpoint = { ...selectedIntentBase, intentDigest: bookingDigest(selectedIntentBase) }
const selectedAction: BookingReadAction = {
  ...searchRun, kind: 'offer.select', actionId: 'action-offer-selected-count', contextRef: selectedIntent.contextRef, factRefs: [] as string[],
  input: { offerRef: 'offer-compared-a', offerVersionRef: 'offer-compared-a:v1' },
} as BookingReadAction
const selectedReceipt: ActionReceipt = {
  ...comparedReceipt, actionId: selectedAction.actionId, contextRef: selectedIntent.contextRef,
  observation: { kind: 'offer.selection', offerRef: 'offer-compared-a', offerVersionRef: 'offer-compared-a:v1' },
  resultContract: { ...comparedReceipt.resultContract, requestedCount: undefined, actualCount: undefined },
}
const selectedTask: BookingCopilotTaskState = {
  ...comparedTask, taskId: selectedIntent.taskId, contextRef: selectedIntent.contextRef,
  allowedActions: ['offer.select'], revision: 1, activeIntent: selectedIntent,
  lastCompletedAction: completedCheckpoint(selectedAction, selectedIntent.sourceTurnId), lastReceipt: selectedReceipt,
  workspaceSnapshot: {
    ...comparedWorkspace, contextRef: selectedIntent.contextRef, revision: 1,
    shortlistedOfferRefs: ['offer-compared-a', 'offer-compared-b'], selectedOfferRef: 'offer-compared-a',
    capabilities: { surface: 'tenant', allowedActions: ['offer.select'] },
  },
}
assert.deepEqual(await runTerminalContinuation(selectedTask, selectedReceipt), [{ kind: 'terminal', terminal: { status: 'completed', summary: 'offer_selected', factRefs: [] } }], 'a selected offer in a target-sized authoritative shortlist completes without fabricated receipt counts')
assert.deepEqual(await runTerminalContinuation({ ...selectedTask, workspaceSnapshot: { ...selectedTask.workspaceSnapshot!, shortlistedOfferRefs: ['offer-compared-a'] } }, selectedReceipt), [{ kind: 'terminal', terminal: { status: 'stopped', summary: 'offer_target_not_reached', factRefs: [] } }], 'a later offer waypoint cannot forget that its authoritative shortlist was underfilled')
await comparedPlanner.close()

const visibleAuthorityWorkspace: BookingWorkspaceSnapshot = {
  ...workspace,
  visibleHotels: [{ hotelRef: 'hotel-authority-visible', name: 'Visible Hotel', factRefs: ['hotel:authority-visible'] }],
  capabilities: { surface: 'tenant', allowedActions: ['hotel.focus'] },
}
const visibleHotelTask = {
  ...task,
  taskId: 'task-dsh-authority-hotel',
  lastTurnId: 'dsh-turn-authority-hotel',
  allowedActions: ['hotel.focus'] as BookingCopilotTaskState['allowedActions'],
  workspaceSnapshot: visibleAuthorityWorkspace,
}
await assert.rejects(
  runCompactAuthorityCase(visibleHotelTask, { kind: 'hotel.focus', input: { hotelRef: 'hotel-not-visible' }, intent: { target: 'hotel.focused' } }),
  /planner_hotel_ref_unbound/,
  'hotel.focus rejects a hotel reference absent from visible workspace facts',
)
const visibleHotelDecisions = await runCompactAuthorityCase(visibleHotelTask, { kind: 'hotel.focus', input: { hotelRef: 'hotel-authority-visible' }, intent: { target: 'hotel.focused' } })
assertRuntimeMaterializedOperation(visibleHotelDecisions, 'hotel.focus', { hotelRef: 'hotel-authority-visible' }, visibleHotelTask, 'hotel.focus accepts only a visible hotel')
assert.deepEqual((visibleHotelDecisions[0] as any)?.action?.factRefs, ['hotel:authority-visible'], 'hotel.focus derives visible hotel facts')

const offerAuthorityWorkspace: BookingWorkspaceSnapshot = {
  ...workspace,
  loadedOffers: [{ offerRef: 'offer-authority', offerVersionRef: 'offer-authority:v2', hotelRef: 'hotel-1', evidenceLevel: 'rate_loaded', factRefs: ['offer:authority:v2'] }],
  capabilities: { surface: 'tenant', allowedActions: ['offer.select'] },
}
const offerTask = {
  ...task,
  taskId: 'task-dsh-authority-offer',
  lastTurnId: 'dsh-turn-authority-offer',
  allowedActions: ['offer.select'] as BookingCopilotTaskState['allowedActions'],
  workspaceSnapshot: offerAuthorityWorkspace,
}
await assert.rejects(
  runCompactAuthorityCase(offerTask, { kind: 'offer.select', input: { offerRef: 'offer-authority', offerVersionRef: 'offer-authority:v1' }, intent: { target: 'offer.selected' } }),
  /planner_offer_ref_unbound/,
  'offer.select rejects an obsolete offer version',
)
const offerDecisions = await runCompactAuthorityCase(offerTask, { kind: 'offer.select', input: { offerRef: 'offer-authority', offerVersionRef: 'offer-authority:v2' }, intent: { target: 'offer.selected' } })
assertRuntimeMaterializedOperation(offerDecisions, 'offer.select', { offerRef: 'offer-authority', offerVersionRef: 'offer-authority:v2' }, offerTask, 'offer.select accepts the loaded offer version')
assert.deepEqual((offerDecisions[0] as any)?.action?.factRefs, ['offer:authority:v2'], 'offer.select derives authoritative offer facts')

const checkoutAuthorityWorkspace: BookingWorkspaceSnapshot = {
  ...offerAuthorityWorkspace,
  verifiedOffer: { offerRef: 'offer-authority', offerVersionRef: 'offer-authority:v2', verifiedOfferRef: 'verified-authority:v2', expiresAt: '2099-01-01T00:00:00.000Z' },
  capabilities: { surface: 'tenant', allowedActions: ['checkout.prepare'] },
}
const checkoutTask = {
  ...offerTask,
  taskId: 'task-dsh-authority-checkout',
  lastTurnId: 'dsh-turn-authority-checkout',
  allowedActions: ['checkout.prepare'] as BookingCopilotTaskState['allowedActions'],
  workspaceSnapshot: checkoutAuthorityWorkspace,
}
await assert.rejects(
  runCompactAuthorityCase(checkoutTask, { kind: 'checkout.prepare', input: { offerRef: 'offer-authority', offerVersionRef: 'offer-authority:v2', verifiedOfferRef: 'verified-authority:wrong' }, intent: { target: 'checkout.prepared' } }),
  /planner_verified_offer_ref_unbound/,
  'checkout.prepare rejects a mismatched verified-offer triplet',
)

const legacyAuthorityTask: BookingCopilotTaskState = {
  ...checkoutTask,
  taskId: 'task-dsh-authority-legacy',
  lastTurnId: 'dsh-turn-authority-legacy',
  allowedActions: ['search.run'] as BookingCopilotTaskState['allowedActions'],
  workspaceSnapshot: { ...workspace, capabilities: { surface: 'tenant', allowedActions: ['search.run'] } },
}
const legacyAuthorityAction = {
  ...searchRun,
  actionId: 'model-authored-action-id',
  reason: 'model-authored reason must not survive',
  factRefs: ['model-authored-fact'],
}
const [legacyAuthorityDecision] = await runCompactAuthorityCase(legacyAuthorityTask, { decision: { kind: 'operation', action: legacyAuthorityAction, intent: { target: 'search.results' } } })
assert.equal(legacyAuthorityDecision?.kind, 'operation', 'legacy full action remains a rolling-compatibility input')
if (legacyAuthorityDecision?.kind !== 'operation') throw new Error('legacy authority proposal did not materialize')
assert.notEqual(legacyAuthorityDecision.action.actionId, legacyAuthorityAction.actionId, 'legacy model actionId is replaced by runtime identity')
assert.notEqual(legacyAuthorityDecision.action.reason, legacyAuthorityAction.reason, 'legacy model reason is replaced by runtime reason')
assert.notDeepEqual(legacyAuthorityDecision.action.factRefs, legacyAuthorityAction.factRefs, 'legacy model factRefs are not trusted')

console.log('BOOKING COPILOT DSH PLANNER PROOF: typed proposals/runtime authority/task timeout isolation/no Book OK')
