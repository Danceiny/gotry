/**
 * Embedded Booking planner adapter proof.
 *
 * The fake below stops at the DeepSeek Harness SDK event boundary: planner
 * decisions come from typed dsh tool/call events, or from assistant
 * finalResponse text only after it passes the same authority path
 * (validation, allowedActions, contextRef, runtime-owned revision). A
 * separate core proof boots the real dsh SDK runtime.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { ActionReceipt, BookingWorkspaceSnapshot } from '../src/booking-surface/contracts.ts'
import type { BookingCopilotTaskState } from '../src/booking-surface/runtime.ts'
import {
  DSH_EMBEDDED_BOOKING_TOOL_NAMES,
  buildDshEmbeddedBookingPatch,
  buildDshPlannerEnvironment,
  createDshEmbeddedBookingPlanner,
  formatUtcOffsetLabel,
  type DshPlannerRunPort,
} from '../src/booking-surface/dsh-planner.ts'

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
assert.deepEqual(first, [{ kind: 'operation', action: searchRun }], 'typed dsh tool call becomes one operation')

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
assert.match(profilePatch, /"stay":\{"checkIn":"<computed YYYY-MM-DD from the host-local time anchor>","checkOut":"<computed YYYY-MM-DD from nights\/check-in>"\}/, 'shape example keeps the stay object shape')
assert.match(profilePatch, /"starRating":\{"strength":"must","value":\{"min":3,"max":3\}\}/, 'shape example keeps the starRating criterion shape')
assert.match(profilePatch, /"occupancy":\{"rooms":\[\{"adults":2,"childAges":\[\]\}\]\}/, 'shape example includes a well-formed occupancy block')
assert.ok(!/Bali/.test(profilePatch), 'shape example carries no literal destination')
assert.ok(!/\b20\d{2}-\d{2}-\d{2}\b/.test(profilePatch), 'shape example carries no concrete YYYY-MM-DD dates')
assert.equal(formatUtcOffsetLabel(345), 'UTC+05:45', 'timezone formatter preserves positive minute offsets')
assert.equal(formatUtcOffsetLabel(-210), 'UTC-03:30', 'timezone formatter preserves negative minute offsets')
assert.equal(formatUtcOffsetLabel(0), 'UTC+00:00', 'timezone formatter zero-pads whole-hour offsets')

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
assert.equal(textDecisions[0]?.kind, 'operation', 'text-channel typed decisions execute through the same authority path')
assert.deepEqual((textDecisions[0] as { action?: { actionId?: string; expectedRevision?: number } }).action, { ...searchRun, expectedRevision: 0 })

const sanitizedRefPort: DshPlannerRunPort = {
  async run() {
    return {
      finalResponse: '',
      events: [{
        type: 'tool/call',
        data: { name: 'booking_search_hotels', arguments: JSON.stringify({ decision: { kind: 'operation', action: { ...searchRun, factRefs: ['draft:destination=Dubai', 'draft:destination.Dubai'] } } }) },
      }],
    }
  },
  async close() {},
}
const sanitizedRef = await createDshEmbeddedBookingPlanner({ runPort: sanitizedRefPort })
const sanitizedDecisions = await sanitizedRef.plannerFactory(task).next({
  task,
  turn: {
    schemaVersion: 'booking.surface',
    kind: 'user.turn',
    taskId: task.taskId,
    turnId: 'dsh-turn-6b',
    workspace,
    request: { text: 'Find hotels' },
  },
})
assert.equal(sanitizedDecisions[0]?.kind, 'operation', 'sanitizer maps off-charset characters deterministically')
assert.deepEqual(
  (sanitizedDecisions[0] as { action?: { factRefs?: string[] } }).action?.factRefs,
  ['modelref:43b07dd7fc80f4a9889b6c672c450a911086293cab2ef4058b95b53559a2d100', 'draft:destination.Dubai'],
)
await sanitizedRef.close()

const collisionRawRefs = ['fact://a/b', 'fact:..a?b'] as const
const collisionResults: string[] = []
for (const [index, rawRef] of collisionRawRefs.entries()) {
  const collisionPlanner = await createDshEmbeddedBookingPlanner({
    runPort: {
      async run() {
        return { finalResponse: '', events: [{ type: 'tool/call', data: { name: 'booking_search_hotels', arguments: JSON.stringify({ decision: { kind: 'operation', action: { ...searchRun, actionId: `action-dsh-collision-${index}`, factRefs: [rawRef] } } }) } }] }
      },
      async close() {},
    },
  })
  const decisions = await collisionPlanner.plannerFactory(task).next({ task, turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: `dsh-collision-${index}`, workspace, request: { text: 'Find hotels' } } })
  const ref = (decisions[0] as { action?: { factRefs?: string[] } }).action?.factRefs?.[0]
  assert.match(ref ?? '', /^[A-Za-z0-9][A-Za-z0-9:._-]*$/, 'unsafe refs map to the runtime-safe pattern')
  collisionResults.push(ref ?? '')
  await collisionPlanner.close()
}
assert.notEqual(collisionResults[0], collisionResults[1], 'distinct unsafe raw refs retain collision-resistant aliases')
assert.equal(
  collisionRawRefs[0].replace(/#/g, ':').replace(/[^A-Za-z0-9:._-]/g, '.'),
  collisionRawRefs[1].replace(/#/g, ':').replace(/[^A-Za-z0-9:._-]/g, '.'),
  'the collision pair shares the legacy readable projection',
)

async function assertFactRefsRejected(factRefs: unknown[], message: string): Promise<void> {
  const planner = await createDshEmbeddedBookingPlanner({
    runPort: {
      async run() {
        return { finalResponse: '', events: [{ type: 'tool/call', data: { name: 'booking_search_hotels', arguments: JSON.stringify({ decision: { kind: 'operation', action: { ...searchRun, factRefs } } }) } }] }
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

const reservedRecovery = await createDshEmbeddedBookingPlanner({
  runPort: {
    async run() {
      return { finalResponse: JSON.stringify({ kind: 'operation', action: { ...searchRun, factRefs: ['modelref:'.concat('b'.repeat(64))] } }), events: [] }
    },
    async close() {},
  },
})
const reservedRecoveryDecision = await reservedRecovery.plannerFactory(task).next({ task, turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: 'dsh-reserved-recovery', workspace, request: { text: 'Find hotels' } } })
assert.equal(reservedRecoveryDecision[0]?.kind, 'error', 'finalResponse recovery rejects direct reserved modelref aliases')
await reservedRecovery.close()

let stableRefCall = 0
const stableRawRef = 'fact://same/raw'
const stablePlanner = await createDshEmbeddedBookingPlanner({
  runPort: {
    async run() {
      stableRefCall += 1
      return { finalResponse: '', events: [{ type: 'tool/call', data: { name: 'booking_search_hotels', arguments: JSON.stringify({ decision: { kind: 'operation', action: { ...searchRun, actionId: `action-dsh-stable-${stableRefCall}`, factRefs: [stableRawRef] } } }) } }] }
    },
    async close() {},
  },
})
const stableFirst = await stablePlanner.plannerFactory(task).next({ task, turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: 'dsh-stable-1', workspace, request: { text: 'Find hotels' } } })
const stableSecond = await stablePlanner.plannerFactory(task).next({ task, turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: 'dsh-stable-2', workspace, request: { text: 'Find hotels again' } } })
assert.equal((stableFirst[0] as { action?: { factRefs?: string[] } }).action?.factRefs?.[0], (stableSecond[0] as { action?: { factRefs?: string[] } }).action?.factRefs?.[0], 'same raw ref is stable across actions and turns')
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
      events: [{
        type: 'tool/call',
        data: { name: 'booking_search_hotels', arguments: JSON.stringify({ decision: { kind: 'operation', action: { ...searchRun, factRefs: [`fact://turn_${task.lastTurnId}/request`] } } }) },
      }],
    }
  },
  async close() {},
}
const fragmentRef = await createDshEmbeddedBookingPlanner({ runPort: fragmentRefPort })
const fragmentDecisions = await fragmentRef.plannerFactory(task).next({
  task,
  turn: {
    schemaVersion: 'booking.surface',
    kind: 'user.turn',
    taskId: task.taskId,
    turnId: 'dsh-turn-7',
    workspace,
    request: { text: 'Find hotels' },
  },
})
assert.equal(fragmentDecisions[0]?.kind, 'operation', 'JSON-pointer fragment factRefs repair into the safe charset')
assert.deepEqual(
  (fragmentDecisions[0] as { action?: { factRefs?: string[] } }).action?.factRefs,
  [`modelref:c7819d3c0c375fe1bd389006338b99be890fa8e3ddd9390f243cba8b5c139d9a`],
)
await fragmentRef.close()

const truncatedPort: DshPlannerRunPort = {
  async run() {
    // Real UAT capture: a reasoning-token budget cut the visible JSON before
    // its closing braces; the authority path must still judge the payload.
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
assert.equal(truncatedDecisions[0]?.kind, 'operation', 'truncated-but-reconstructable finalResponse recovers through the authority path')
await truncatedRecovery.close()

const unsafeRefPort: DshPlannerRunPort = {
  async run() {
    return {
      finalResponse: '',
      events: [{
        type: 'tool/call',
        data: { name: 'booking_search_hotels', arguments: JSON.stringify({ decision: { kind: 'operation', action: { ...searchRun, factRefs: [42] } } }) },
      }],
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

const plainProsePort: DshPlannerRunPort = {
  async run() {
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
assert.equal(plainProseDecisions[0]?.kind, 'error', 'prose without a typed decision envelope is never executable')

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

// Regression: MiniMax-M3 serializes arrays as index-keyed objects and emits
// information-free empty room objects. The repair pass must convert
// {"0":{"adults":2,"childAges":{}},"1":{}} into rooms [{adults:2,childAges:[]}]
// in index order, dropping the empty room, and must not leak the empty
// childAges object as a stringified singleton. Drives the same runPort ->
// tool/call -> parseToolDecision boundary the real adapter uses.
const indexKeyedRoomsPort: DshPlannerRunPort = {
  async run() {
    return {
      finalResponse: '',
      events: [{
        type: 'tool/call',
        data: {
          name: 'booking_search_hotels',
          arguments: JSON.stringify({
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
        },
      }],
    }
  },
  async close() {},
}
const indexKeyedRooms = await createDshEmbeddedBookingPlanner({ runPort: indexKeyedRoomsPort })
const indexKeyedDecisions = await indexKeyedRooms.plannerFactory(task).next({
  task,
  turn: {
    schemaVersion: 'booking.surface',
    kind: 'user.turn',
    taskId: task.taskId,
    turnId: 'dsh-turn-index-keyed-rooms',
    workspace: { ...workspace, capabilities: { ...workspace.capabilities, allowedActions: [...workspace.capabilities.allowedActions] } },
    request: { text: 'Two adults, one room' },
  },
})
assert.equal(indexKeyedDecisions[0]?.kind, 'operation', 'index-keyed occupancy rooms repair yields an executable search.patch')
assert.deepEqual(
  (indexKeyedDecisions[0] as { action?: { input?: { patch?: { occupancy?: { rooms?: unknown[] } } } } }).action?.input?.patch?.occupancy?.rooms,
  [{ adults: 2, childAges: [] }],
  'index-keyed rooms object becomes an ordered array with the empty room dropped and empty childAges normalized to []',
)

// Regression for #282: a non-empty room that carries child ages but omits
// adults is a semantic validation failure, not disposable representation.
// The provider must repair that room in the next counted session call.
let occupancyRepairRuns = 0
const occupancyRepairPort: DshPlannerRunPort = {
  async run(prompt) {
    occupancyRepairRuns += 1
    if (occupancyRepairRuns === 1) {
      return {
        finalResponse: '',
        events: [{
          type: 'tool/call',
          data: {
            name: 'booking_search_hotels',
            arguments: JSON.stringify({
              decision: {
                kind: 'operation',
                action: {
                  ...searchRun,
                  kind: 'search.patch',
                  actionId: 'action-dsh-282-occupancy-invalid',
                  reason: 'Preserve both requested rooms and their child ages.',
                  input: { patch: { occupancy: { rooms: [{ adults: 2, childAges: [6] }, { childAges: [4] }] } } },
                },
              },
            }),
          },
        }],
      }
    }
    assert.match(prompt, /schema validation/, 'occupancy correction is sent as the next counted prompt')
    return {
      finalResponse: '',
      events: [{
        type: 'tool/call',
        data: {
          name: 'booking_search_hotels',
          arguments: JSON.stringify({
            decision: {
              kind: 'operation',
              action: {
                ...searchRun,
                kind: 'search.patch',
                actionId: 'action-dsh-282-occupancy-valid',
                reason: 'Preserve both requested rooms and their child ages.',
                input: { patch: { occupancy: { rooms: [{ adults: 2, childAges: [6] }, { adults: 1, childAges: [4] }] } } },
              },
            },
          }),
        },
      }],
    }
  },
  async close() {},
}
const occupancyRepair = await createDshEmbeddedBookingPlanner({ runPort: occupancyRepairPort })
const occupancyRepairDecision = await occupancyRepair.plannerFactory(task).next({
  task,
  turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: 'dsh-turn-282-occupancy', workspace, request: { text: '请保留两个房间和各自的儿童年龄：第一间2成人1儿童6岁，第二间1成人1儿童4岁' } },
})
assert.equal(occupancyRepairRuns, 2, 'missing adults triggers one counted correction call')
assert.deepEqual(
  occupancyRepairDecision[0]?.kind === 'operation' ? occupancyRepairDecision[0].action.input : undefined,
  { patch: { occupancy: { rooms: [{ adults: 2, childAges: [6] }, { adults: 1, childAges: [4] }] } } },
  'corrected occupancy preserves both non-empty rooms and child criteria',
)

// A prose-only first response receives the same bounded correction treatment
// as a malformed typed call; a valid second response is returned immediately.
let proseRecoveryRuns = 0
const proseRecoveryPort: DshPlannerRunPort = {
  async run(prompt) {
    proseRecoveryRuns += 1
    if (proseRecoveryRuns === 1) return { finalResponse: '我会为你搜索酒店。', events: [] }
    assert.match(prompt, /no booking capability tool call/, 'prose correction is sent as the next counted prompt')
    return { finalResponse: '', events: [{ type: 'tool/call', data: { name: 'booking_search_hotels', arguments: JSON.stringify({ decision: { kind: 'operation', action: searchRun } }) } }] }
  },
  async close() {},
}
const proseRecovery = await createDshEmbeddedBookingPlanner({ runPort: proseRecoveryPort })
const proseRecoveryDecision = await proseRecovery.plannerFactory(task).next({
  task,
  turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: 'dsh-turn-282-prose', workspace, request: { text: 'Find hotels' } },
})
assert.equal(proseRecoveryRuns, 2, 'prose correction uses the second counted call')
assert.deepEqual(proseRecoveryDecision, [{ kind: 'operation', action: searchRun }], 'valid correction is returned instead of discarded')

// Repeated malformed responses stop at the three-call budget. A provider
// failure propagates on the first call instead of being silently swallowed.
let malformedRuns = 0
const malformedPort: DshPlannerRunPort = {
  async run() {
    malformedRuns += 1
    return { finalResponse: '', events: [{ type: 'tool/call', data: { name: 'booking_search_hotels', arguments: JSON.stringify({ decision: { kind: 'operation', action: { ...searchRun, input: { patch: { occupancy: { rooms: [{ childAges: [4] }] } } } } } }) } }] }
  },
  async close() {},
}
const malformed = await createDshEmbeddedBookingPlanner({ runPort: malformedPort })
await assert.rejects(
  malformed.plannerFactory(task).next({ task, turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: 'dsh-turn-282-malformed', workspace, request: { text: 'Find hotels' } } }),
  /planner_invalid_action/,
  'repeated malformed output fails closed',
)
assert.equal(malformedRuns, 3, 'repeated malformed output consumes exactly three calls')

let providerRuns = 0
const providerErrorPort: DshPlannerRunPort = {
  async run() { providerRuns += 1; throw new Error('provider_transport_failure') },
  async close() {},
}
const providerError = await createDshEmbeddedBookingPlanner({ runPort: providerErrorPort })
await assert.rejects(
  providerError.plannerFactory(task).next({ task, turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: 'dsh-turn-282-provider', workspace, request: { text: 'Find hotels' } } }),
  /provider_transport_failure/,
  'provider failures remain visible to the caller',
)
assert.equal(providerRuns, 1, 'provider failures are not silently retried')

await Promise.all([adapter.close(), textChannel.close(), unauthorised.close(), fragmentRef.close(), truncatedRecovery.close(), sanitizedRef.close(), unsafeRef.close(), uiOffers.close(), forbidden.close(), terminalAdapter.close(), indexKeyedRooms.close(), occupancyRepair.close(), proseRecovery.close(), malformed.close(), providerError.close()])
console.log('BOOKING COPILOT DSH PLANNER PROOF: task session/typed tool decisions/no Book/no prose parser/no portal token OK')
