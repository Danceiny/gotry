/**
 * Embedded Booking planner adapter proof.
 *
 * The fake below stops at the DeepSeek Harness SDK event boundary: planner
 * decisions may only come from typed dsh tool/call events, never assistant
 * prose. A separate core proof boots the real dsh SDK runtime.
 */

import assert from 'node:assert/strict'
import type { ActionReceipt, BookingWorkspaceSnapshot } from '../src/booking-surface/contracts.ts'
import type { BookingCopilotTaskState } from '../src/booking-surface/runtime.ts'
import {
  DSH_EMBEDDED_BOOKING_TOOL_NAMES,
  buildDshPlannerEnvironment,
  createDshEmbeddedBookingPlanner,
  type DshPlannerRunPort,
} from '../src/booking-surface/dsh-planner.ts'

const availability = { initialized: true, recoveryStarted: false, availabilityPhase: 'need_offers' as const, activeHotelOrdinal: 0, hotelRefs: [], hotels: {}, attempts: [], queryReservations: [] }
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

const prompts: string[] = []
const sessionIds: string[] = []
let runIndex = 0
const runPort: DshPlannerRunPort = {
  async run(prompt, options) {
    prompts.push(prompt)
    sessionIds.push(options.sessionId)
    runIndex += 1
    if (runIndex === 1) {
      return {
        finalResponse: '{"kind":"book","input":{}}',
        events: [{
          type: 'tool/call',
          data: {
            name: 'booking_search_hotels',
            arguments: JSON.stringify({ decision: { kind: 'operation', action: searchRun } }),
          },
        }],
      }
    }
    if (runIndex === 3) {
      return { finalResponse: '', events: [{ type: 'tool/call', data: { name: 'booking_refine_results', arguments: JSON.stringify({ decision: { kind: 'operation', action: hotelSelect } }) } }] }
    }
    return {
      finalResponse: '{"kind":"search.run","input":{}}',
      events: [{
        type: 'tool/call',
        data: {
          name: 'booking_search_hotels',
          arguments: JSON.stringify({
            decision: {
              kind: 'terminal',
              terminal: { status: 'completed', summary: 'Stopped at search results.', factRefs: [] },
            },
          }),
        },
      }],
    }
  },
  async close() {},
}

const adapter = await createDshEmbeddedBookingPlanner({ runPort })
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
assert.deepEqual(first, [{ kind: 'operation', action: searchRun }], 'typed dsh tool call becomes one operation')

const receipt: ActionReceipt = {
  schemaVersion: 'booking.surface',
  kind: 'action.receipt',
  actionId: searchRun.actionId,
  contextRef: task.contextRef,
  status: 'applied',
  revision: 1,
  observation: { kind: 'search.state', searchSessionRef: 'search-dsh-1', resultCount: 4 },
  resultContract: { outcome: 'complete', hardCriteriaMet: true, factRefs: [], gapCodes: [], blockers: [], relaxationsApplied: [] },
}
const continuedTask: BookingCopilotTaskState = { ...task, revision: 1, lastReceipt: receipt }
const second = await session.next({
  task: continuedTask,
  turn: {
    schemaVersion: 'booking.surface',
    kind: 'action.receipt.continuation',
    taskId: task.taskId,
    workspace: {
      ...workspace,
      revision: 1,
      capabilities: { ...workspace.capabilities, allowedActions: [...workspace.capabilities.allowedActions] },
    },
    receipt,
  },
})
assert.deepEqual(second, [{
  kind: 'terminal',
  terminal: { status: 'completed', summary: 'Stopped at search results.', factRefs: [] },
}])
assert.equal(sessionIds[0], sessionIds[1], 'one task keeps one dsh session across receipt continuation')
assert.match(prompts[1]!, /action-dsh-1/, 'receipt continuation reaches the same task-scoped planner session')

const paymentTask = { ...task, taskId: 'task-payment-1', surface: 'payment_link' as const, allowedActions: ['hotel.select'] as BookingCopilotTaskState['allowedActions'], revision: 0 }
const paymentSession = adapter.plannerFactory(paymentTask)
const selected = await paymentSession.next({ task: paymentTask, turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: paymentTask.taskId, turnId: 'payment-turn-1', workspace: { ...workspace, surface: 'payment_link', capabilities: { surface: 'payment_link', allowedActions: ['hotel.select'] } }, request: { text: '选择酒店' } } })
assert.deepEqual(selected, [{ kind: 'operation', action: hotelSelect }], 'refine-results can emit typed hotel.select on payment_link')

assert.deepEqual(DSH_EMBEDDED_BOOKING_TOOL_NAMES, [
  'booking_search_hotels',
  'booking_refine_results',
  'booking_find_room_offers',
  'booking_compare_offers',
  'booking_prepare_booking',
  'booking_observe_booking',
])
assert.ok(!DSH_EMBEDDED_BOOKING_TOOL_NAMES.some((name) => /book$|trade|payment/i.test(name)), 'profile has no Book/payment tool')

const childEnv = buildDshPlannerEnvironment({
  PATH: '/usr/bin',
  LANG: 'en_US.UTF-8',
  LLM_API_KEY: 'model-key',
  LLM_BASE_URL: 'http://model.invalid/v1',
  PORTAL_TOKEN: 'forbidden',
  HOTELBYTE_TOKEN: 'forbidden',
  GOTRY_BOOKING_COPILOT_API_KEY: 'bff-only',
})
assert.equal(childEnv.DEEPSEEK_API_KEY, 'model-key')
assert.equal(childEnv.DEEPSEEK_BASE_URL, 'http://model.invalid/v1')
assert.equal(childEnv.PORTAL_TOKEN, undefined)
assert.equal(childEnv.HOTELBYTE_TOKEN, undefined)
assert.equal(childEnv.GOTRY_BOOKING_COPILOT_API_KEY, undefined)

const proseOnlyPort: DshPlannerRunPort = {
  async run() {
    return { finalResponse: JSON.stringify({ kind: 'operation', action: searchRun }), events: [] }
  },
  async close() {},
}
const proseOnly = await createDshEmbeddedBookingPlanner({ runPort: proseOnlyPort })
const proseDecisions = await proseOnly.plannerFactory(task).next({
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
assert.equal(proseDecisions[0]?.kind, 'error', 'JSON-looking assistant prose is never executable')

const forbiddenPort: DshPlannerRunPort = {
  async run() {
    return {
      finalResponse: '',
      events: [{
        type: 'tool/call',
        data: { name: 'gotry_book', arguments: JSON.stringify({ decision: { kind: 'operation', action: { ...searchRun, kind: 'book' } } }) },
      }],
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

const terminalTask: BookingCopilotTaskState = {
  schemaVersion: 'booking.surface', taskId: 'task-dsh-terminal', contextRef: 'ctx-dsh-terminal', surface: 'tenant', revision: 0,
  allowedActions: ['search.run'], userTurnCount: 1, operationCount: 0, phase: 'planning', lastSequence: 0,
  availability: { initialized: true, recoveryStarted: true, availabilityPhase: 'terminal', activeHotelOrdinal: 0, hotelRefs: [], hotels: {}, attempts: [], queryReservations: [], terminal: { code: 'availability_exhausted_complete', hotelRefs: [], reason: 'no_current_offers', evidence: 'conclusive' } },
}
const terminalWorkspace: BookingWorkspaceSnapshot = {
  schemaVersion: 'booking.surface', contextRef: terminalTask.contextRef, surface: 'tenant', revision: 0, locale: 'en-US', currency: 'AED',
  searchDraft: {}, results: { status: 'idle' }, visibleHotels: [], loadedOffers: [], shortlistedOfferRefs: [],
  capabilities: { surface: 'tenant', allowedActions: ['search.run'] },
}
let terminalRuns = 0
const terminalPort: DshPlannerRunPort = {
  async run() { terminalRuns++; return terminalRuns === 1 ? { finalResponse: '', events: [{ type: 'tool/call', data: { name: 'booking_search_hotels', arguments: JSON.stringify({ decision: { kind: 'operation', action: { ...searchRun, schemaVersion: 'booking.surface', contextRef: terminalTask.contextRef, actionId: 'action-dsh-terminal' } } }) } }] } : { finalResponse: '', events: [{ type: 'tool/call', data: { name: 'booking_search_hotels', arguments: JSON.stringify({ decision: { kind: 'terminal', terminal: { status: 'stopped', summary: 'receipt continuation handled', factRefs: [] } } }) } }] } },
  async close() {},
}
const terminalAdapter = await createDshEmbeddedBookingPlanner({ runPort: terminalPort })
const terminalDecisions = await terminalAdapter.plannerFactory(terminalTask).next({ task: terminalTask, turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: terminalTask.taskId, turnId: 'dsh-terminal-turn-1', workspace: terminalWorkspace, request: { text: 'find hotels' } } })
assert.equal(terminalDecisions[0]?.kind, 'operation', 'real DSH adapter accepts the canonical typed action')
assert.equal(terminalDecisions[0]?.kind === 'operation' ? terminalDecisions[0].action.schemaVersion : '', 'booking.surface')
const terminalContinuation = { schemaVersion: 'booking.surface' as const, kind: 'action.receipt.continuation' as const, taskId: terminalTask.taskId, workspace: { ...terminalWorkspace, revision: 1 }, receipt: { schemaVersion: 'booking.surface' as const, kind: 'action.receipt' as const, actionId: 'action-dsh-terminal', contextRef: terminalTask.contextRef, status: 'applied' as const, revision: 1, observation: { kind: 'search.state' as const, resultCount: 1 }, resultContract: { outcome: 'complete' as const, hardCriteriaMet: true, factRefs: [], gapCodes: [], blockers: [], relaxationsApplied: [] } } }
const terminalContinuationDecision = await terminalAdapter.plannerFactory(terminalTask).next({ task: { ...terminalTask, revision: 1, lastReceipt: terminalContinuation.receipt }, turn: terminalContinuation })
assert.deepEqual(terminalContinuationDecision, [{ kind: 'terminal', terminal: { status: 'stopped', summary: 'receipt continuation handled', factRefs: [] } }], 'real DSH planner handles receipt continuation through the typed seam')
await assert.rejects(
  terminalAdapter.plannerFactory(terminalTask).next({
    task: terminalTask,
    turn: { schemaVersion: 'booking.surface', kind: 'user.turn.ingress', requestKey: 'browser-request', surfaceHint: 'tenant', workspace: { schemaVersion: 'booking.surface', revision: 0, locale: 'en-US', currency: 'AED', searchDraft: {}, results: { status: 'idle' }, visibleHotels: [], loadedOffers: [], shortlistedOfferRefs: [] }, request: { text: 'browser ingress must be BFF-bound' } } as never,
  }),
  /planner_identity_required/,
)

await Promise.all([adapter.close(), proseOnly.close(), forbidden.close(), terminalAdapter.close()])
console.log('BOOKING COPILOT DSH PLANNER PROOF: task session/typed tool decisions/no Book/no prose parser/no portal token OK')
