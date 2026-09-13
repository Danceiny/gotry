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

const repeatedToolArguments = JSON.stringify({
  decision: {
    kind: 'operation',
    action: {
      ...searchRun,
      reason: 'Preserve braces } {, escaped quotes " and a backslash \\ inside a JSON string.',
    },
  },
})
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
          JSON.stringify({ decision: { kind: 'operation', action: searchRun } }),
          'call-adapter-search',
        ),
      }
    }
    if (runIndex === 3) {
      return {
        finalResponse: '',
        events: successfulToolEvents(
          'booking_refine_results',
          JSON.stringify({ decision: { kind: 'operation', action: hotelSelect } }),
          'call-adapter-select',
        ),
      }
    }
    return {
      finalResponse: '{"kind":"search.run","input":{}}',
      events: successfulToolEvents(
        'booking_search_hotels',
        JSON.stringify({
          decision: {
            kind: 'terminal',
            terminal: { status: 'completed', summary: 'Stopped at search results.', factRefs: [] },
          },
        }),
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
const shapeExampleLine = profilePatch.split('\n').find((line) => line.trimStart().startsWith('{"decision":'))
assert.ok(shapeExampleLine, 'planner persona example uses the model-facing decision envelope')
const shapeExample = JSON.parse(shapeExampleLine!.trim().replace('<rev from payload>', '0')) as { decision?: { kind?: string; action?: unknown } }
assert.deepEqual(Object.keys(shapeExample), ['decision'], 'planner persona example has exactly the declared top-level envelope')
assert.deepEqual(Object.keys(shapeExample.decision ?? {}), ['kind', 'action'], 'planner persona example nests the typed operation under decision')
assert.match(profilePatch, /"stay":\{"checkIn":"<computed YYYY-MM-DD from the host-local time anchor>","checkOut":"<computed YYYY-MM-DD from nights\/check-in>"\}/, 'shape example keeps the stay object shape')
assert.match(profilePatch, /"starRating":\{"strength":"must","value":\{"min":3,"max":3\}\}/, 'shape example keeps the starRating criterion shape')
assert.match(profilePatch, /"occupancy":\{"rooms":\[\{"adults":2,"childAges":\[\]\}\]\}/, 'shape example includes a well-formed occupancy block')
assert.ok(!/Bali/.test(profilePatch), 'shape example carries no literal destination')
assert.ok(!/\b20\d{2}-\d{2}-\d{2}\b/.test(profilePatch), 'shape example carries no concrete YYYY-MM-DD dates')
const personaPrefixKeyMatches = profilePatch.match(/^ {4}personaPrefix:\s*>-/gm) ?? []
assert.equal(personaPrefixKeyMatches.length, 1, `planner patch must carry exactly one personaPrefix: >- key (observed=${personaPrefixKeyMatches.length})`)
assert.ok(!/(^|\n) {4}persona:\s*>-/.test(profilePatch), 'planner patch must not carry the legacy persona: >- key')
assert.match(profilePatch, /You are GoTry's embedded booking planner/, 'planner patch retains the intended embedded booking persona text')
assert.match(profilePatch, /Select exactly one of the six booking/, 'planner patch retains the six-tool discipline')
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
          ...successfulToolEvents('booking_search_hotels', JSON.stringify({ decision: { kind: 'operation', action: searchRun } }), 'call-valid-after-schema-rejection'),
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
assert.deepEqual(invalidThenValidDecision, [{ kind: 'operation', action: searchRun }], 'a schema-rejected call may be superseded by the later unique typed success in the same run')
await invalidThenValid.close()

const invalidWithoutSchemaRejection = await createDshEmbeddedBookingPlanner({
  runPort: {
    async run() {
      return {
        finalResponse: '',
        events: [
          toolCall('booking_search_hotels', invalidCallArguments, 'call-invalid-without-schema-rejection'),
          toolResult('call-invalid-without-schema-rejection'),
          ...successfulToolEvents('booking_search_hotels', JSON.stringify({ decision: { kind: 'operation', action: searchRun } }), 'call-valid-after-unproven-rejection'),
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
          ...successfulToolEvents('booking_search_hotels', JSON.stringify({ decision: { kind: 'operation', action: searchRun } }), 'call-valid-after-unauthorised-action'),
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
          ...successfulToolEvents('booking_search_hotels', JSON.stringify({ decision: { kind: 'operation', action: searchRun } }), 'call-multiple-1'),
          ...successfulToolEvents('booking_search_hotels', JSON.stringify({ decision: { kind: 'operation', action: { ...searchRun, actionId: 'action-dsh-multiple-2' } } }), 'call-multiple-2'),
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
          toolCall('booking_search_hotels', JSON.stringify({ decision: { kind: 'operation', action: searchRun } }), 'call-typed-schema-rejected'),
          toolResult('call-typed-schema-rejected', true, 'INVALID_ARGS'),
          ...successfulToolEvents('booking_search_hotels', JSON.stringify({ decision: { kind: 'operation', action: { ...searchRun, actionId: 'action-dsh-after-typed-rejection' } } }), 'call-after-typed-rejection'),
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
            JSON.stringify({ decision: { kind: 'operation', action: { ...searchRun, factRefs: ['draft:destination=Dubai'] } } }),
            'call-unsafe-fact-ref',
          ),
          toolResult('call-unsafe-fact-ref', true, 'INVALID_ARGS'),
          ...successfulToolEvents(
            'booking_search_hotels',
            JSON.stringify({ decision: { kind: 'operation', action: { ...searchRun, actionId: 'action-dsh-after-unsafe-ref', factRefs: [] } } }),
            'call-valid-after-unsafe-ref',
          ),
        ],
      }
    },
    async close() {},
  },
})
assert.deepEqual(
  await unsafeFactRefRejectedThenValid.plannerFactory(task).next({
    task,
    turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: 'dsh-unsafe-ref-repair', workspace, request: { text: 'Find hotels' } },
  }),
  [{ kind: 'operation', action: { ...searchRun, actionId: 'action-dsh-after-unsafe-ref', factRefs: [] } }],
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
            JSON.stringify({ decision: { kind: 'operation', action: { ...searchRun, factRefs: ['modelref:reserved-by-runtime'] } } }),
            'call-reserved-fact-ref',
          ),
          toolResult('call-reserved-fact-ref', true, 'INVALID_ARGS'),
          ...successfulToolEvents(
            'booking_search_hotels',
            JSON.stringify({ decision: { kind: 'operation', action: { ...searchRun, actionId: 'action-dsh-after-reserved-ref', factRefs: [] } } }),
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
]
for (const [index, c] of mixedAuthorityCases.entries()) {
  const mixedAuthorityPlanner = await createDshEmbeddedBookingPlanner({
    runPort: {
      async run() {
        return {
          finalResponse: '',
          events: [
            toolCall(c.tool, JSON.stringify({ decision: { kind: 'operation', action: c.badAction } }), `mixed-authority-${index}-bad`),
            toolResult(`mixed-authority-${index}-bad`, true, 'INVALID_ARGS'),
            ...successfulToolEvents('booking_search_hotels', JSON.stringify({ decision: { kind: 'operation', action: searchRun } }), `mixed-authority-${index}-good`),
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
      assert.deepEqual(decisions, [{ kind: 'operation', action: searchRun }], `${c.name} accepts the later canonical call after shape repair`)
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
            JSON.stringify({ decision: { kind: 'operation', action: searchRun } }),
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
assert.deepEqual(operationBeforeFailureDecision, [{ kind: 'operation', action: searchRun }], 'a valid receipt-gated operation outranks a later provider failure')
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
    [{ kind: 'error', error: { code: 'PLANNER_FAILED', message: 'The planner request failed at the typed runtime boundary.', retryable: false } }],
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
const confirmedPrompts: string[] = []
const confirmedCheckout = await createDshEmbeddedBookingPlanner({
  runPort: {
    async run(prompt) {
      confirmedPrompts.push(prompt)
      return { finalResponse: '', events: successfulToolEvents('booking_prepare_booking', JSON.stringify({ decision: { kind: 'operation', action: { ...checkoutPrepare, contextRef: confirmedTask.contextRef } } }), 'call-confirmed-checkout') }
    },
    async close() {},
  },
})
const confirmedCheckoutDecision = await confirmedCheckout.plannerFactory(confirmedTask).next({ task: confirmedTask, turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: confirmedTask.taskId, turnId: 'dsh-confirmed-checkout', workspace: confirmedWorkspace, request: { text: '继续预订' } } })
assert.deepEqual(confirmedCheckoutDecision, [{ kind: 'operation', action: { ...checkoutPrepare, contextRef: confirmedTask.contextRef } }], 'availability_confirmed can still produce an exact checkout.prepare typed action through the canonical booking_prepare_booking tool')
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
      return { finalResponse: '', events: successfulToolEvents('booking_prepare_booking', JSON.stringify({ decision: { kind: 'terminal', terminal: { status: 'stopped', summary: 'checkout_not_authorized', factRefs: [] } } }), 'call-confirmed-no-checkout') }
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

for (const [label, decision, expected] of [
  ['terminal', { kind: 'terminal', terminal: { status: 'completed', summary: 'availability_confirmed', factRefs: [] } }, { kind: 'terminal', terminal: { status: 'completed', summary: 'availability_confirmed', factRefs: [] } }],
  ['error', { kind: 'error', error: { code: 'PLANNER_FAILED', message: 'Planner stopped after confirmation.', retryable: false } }, { kind: 'error', error: { code: 'PLANNER_FAILED', message: 'Planner stopped after confirmation.', retryable: false } }],
] as const) {
  const finalityPlanner = await createDshEmbeddedBookingPlanner({
    runPort: {
      async run(prompt) {
        confirmedPrompts.push(prompt)
        return { finalResponse: '', events: successfulToolEvents('booking_prepare_booking', JSON.stringify({ decision }), `call-confirmed-${label}`) }
      },
      async close() {},
    },
  })
  assert.deepEqual(await finalityPlanner.plannerFactory(confirmedTask).next({ task: confirmedTask, turn: { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: confirmedTask.taskId, turnId: `dsh-confirmed-${label}`, workspace: confirmedWorkspace, request: { text: '只检查可订状态' } } }), [expected], `availability_confirmed does not degrade typed ${label} finality`)
  assert.deepEqual(promptPayload(confirmedPrompts.at(-1)!).task.allowedActions, ['checkout.prepare'], `typed ${label} run still receives the narrowed confirmed prompt`)
  await finalityPlanner.close()
}

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
  async run() {
    terminalRuns += 1
    return terminalRuns === 1
      ? {
          finalResponse: '',
          events: successfulToolEvents(
            'booking_search_hotels',
            JSON.stringify({ decision: { kind: 'operation', action: { ...searchRun, schemaVersion: 'booking.surface', contextRef: terminalTask.contextRef, actionId: 'action-dsh-terminal' } } }),
            'call-terminal-operation',
          ),
        }
      : {
          finalResponse: '',
          events: successfulToolEvents(
            'booking_search_hotels',
            JSON.stringify({ decision: { kind: 'terminal', terminal: { status: 'stopped', summary: 'receipt continuation handled', factRefs: [] } } }),
            'call-terminal-continuation',
          ),
        }
  },
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
          decision: { kind: 'operation', action: { ...searchRun, kind: 'search.patch', actionId: 'action-dsh-282-occupancy-invalid', reason: 'Preserve both requested rooms and their child ages.', input: { patch: { occupancy: { rooms: [{ adults: 2, childAges: [6] }, { childAges: [4] }] } } } } },
        }), 'call-occupancy-invalid'),
        toolResult('call-occupancy-invalid', true, 'INVALID_ARGS'),
        ...successfulToolEvents('booking_search_hotels', JSON.stringify({
          decision: { kind: 'operation', action: { ...searchRun, kind: 'search.patch', actionId: 'action-dsh-282-occupancy-valid', reason: 'Preserve both requested rooms and their child ages.', input: { patch: { occupancy: { rooms: [{ adults: 2, childAges: [6] }, { adults: 1, childAges: [4] }] } } } } },
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
          decision: { kind: 'operation', action: { ...searchRun, kind: 'search.patch', actionId: 'action-dsh-order-late-invalid', reason: 'Late invalid call.', input: { patch: { occupancy: { rooms: [{ adults: 2, childAges: [6] }, { childAges: [4] }] } } } } },
        }), 'call-order-late-invalid'),
        toolCall('booking_search_hotels', JSON.stringify({
          decision: { kind: 'operation', action: { ...searchRun, kind: 'search.patch', actionId: 'action-dsh-order-late-valid', reason: 'Late valid call.', input: { patch: { occupancy: { rooms: [{ adults: 2, childAges: [6] }, { adults: 1, childAges: [4] }] } } } } },
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
          decision: { kind: 'operation', action: { ...searchRun, kind: 'search.patch', actionId: 'action-dsh-order-pre-invalid', reason: 'Pre-feedback invalid call.', input: { patch: { occupancy: { rooms: [{ adults: 2, childAges: [6] }, { childAges: [4] }] } } } } },
        }), 'call-order-pre-invalid'),
        toolCall('booking_search_hotels', JSON.stringify({
          decision: { kind: 'operation', action: { ...searchRun, kind: 'search.patch', actionId: 'action-dsh-order-pre-valid', reason: 'Pre-feedback valid call.', input: { patch: { occupancy: { rooms: [{ adults: 2, childAges: [6] }, { adults: 1, childAges: [4] }] } } } } },
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
    return { finalResponse: '', events: successfulToolEvents('booking_search_hotels', JSON.stringify({ decision: { kind: 'operation', action: searchRun } }), 'call-prose-correction') }
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
console.log('BOOKING COPILOT DSH PLANNER PROOF: task session/typed tool decisions/no Book/prose non-executable/no portal token OK')
