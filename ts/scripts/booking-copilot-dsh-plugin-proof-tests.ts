/** Closed dsh capability-tool registration proof (no dsh runtime required). */

import assert from 'node:assert/strict'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { ToolArgsError } from '@deepseek-ai/dsh-tools'
// @ts-expect-error Runtime dsh plugins are JavaScript modules registered by path.
import { apply, embeddedBookingToolDefinitions } from '../src/booking-surface/dsh-plugin.js'

const registered: Array<Record<string, unknown>> = []
apply({
  tools: {
    register(tool: Record<string, unknown>) { registered.push(tool) },
  },
})

assert.equal(registered.length, 13)
assert.deepEqual(registered.map((tool) => tool.name), [
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
assert.deepEqual(registered, embeddedBookingToolDefinitions)
assert.ok(!registered.some((tool) => /gotry_book|trade|payment/i.test(String(tool.name))))
// One concrete closed schema per tool: no top-level anyOf union, no decision
// envelope, and the tool name alone selects the action kind. Weaker providers
// cannot be trusted to pick a union branch, so every action tool advertises
// const kind + that kind's input + mandatory intent.
const finishTool = registered.find((tool) => tool.name === 'booking_finish_turn')!
const finishParameters = finishTool.parameters as Record<string, any>
assert.equal(finishParameters.type, 'object')
assert.ok(!Object.prototype.hasOwnProperty.call(finishParameters, 'anyOf'))
assert.equal(finishParameters.properties.kind.const, 'terminal')
assert.deepEqual(finishParameters.required, ['kind'])
assert.ok(!Object.prototype.hasOwnProperty.call(finishParameters.properties, 'decision'))
const actionTools = registered.filter((tool) => tool.name !== 'booking_finish_turn')
const TOOL_KIND: Record<string, string> = {
  booking_search_hotels: 'search.patch',
  booking_run_search: 'search.run',
  booking_refine_results: 'results.view.patch',
  booking_focus_hotel: 'hotel.focus',
  booking_select_hotel: 'hotel.select',
  booking_find_room_offers: 'offers.query',
  booking_view_offers: 'offers.view.patch',
  booking_compare_offers: 'offers.compare',
  booking_select_offer: 'offer.select',
  booking_prepare_booking: 'offer.check',
  booking_prepare_checkout: 'checkout.prepare',
  booking_observe_booking: 'order.observe',
}
for (const tool of actionTools) {
  const parameters = tool.parameters as Record<string, any>
  assert.equal(parameters.type, 'object')
  assert.ok(!Object.prototype.hasOwnProperty.call(parameters, 'anyOf'), `${tool.name} must not advertise a union`)
  assert.ok(!Object.prototype.hasOwnProperty.call(parameters.properties ?? {}, 'decision'), `${tool.name} must not advertise a decision envelope`)
  assert.deepEqual(parameters.required, ['kind', 'input', 'intent'])
  assert.equal(parameters.additionalProperties, false)
  assert.equal(parameters.properties.kind.const, TOOL_KIND[String(tool.name)], `${tool.name} advertises exactly its own action kind`)
}

const prepare = registered.find((tool) => tool.name === 'booking_prepare_booking')!
assert.equal((prepare.parameters as Record<string, any>).properties.kind.const, 'offer.check', 'prepare-booking advertises offer.check only')
assert.ok(!JSON.stringify(prepare.parameters).includes('book"'), 'schema has no Book discriminator')

const search = registered.find((tool) => tool.name === 'booking_search_hotels')!
const rawExecuteSearch = search.execute as (args: unknown, exec: { concludeTurn(): void }) => Promise<unknown>
let concludedTurns = 0
const executeSearch = (args: unknown) => rawExecuteSearch(args, {
  concludeTurn() { concludedTurns += 1 },
})
await assert.rejects(
  executeSearch({ decision: { kind: 'operation' } }),
  (error: unknown) => error instanceof ToolArgsError
    && error.name === 'ToolArgsError'
    && error.code === 'INVALID_ARGS'
    && /decision_schema_violation/.test(error.message),
  'schema violations must surface as dsh ToolArgsError with stable INVALID_ARGS code',
)
await assert.rejects(
  executeSearch({ kind: 'search.patch', input: { patch: { destination: { query: 'Dubai' } } } }),
  (error: unknown) => error instanceof ToolArgsError && error.code === 'INVALID_ARGS',
  'every fresh operation requires a semantic intent before the tool can conclude the turn',
)
assert.equal(concludedTurns, 0, 'an invalid tool call stays in the same turn for local schema repair')
const validateSearchTool = new Ajv2020({ allErrors: true, strict: true }).compile(search.parameters as any)
// The advertised dialect is single-kind now: a terminal proposal is accepted by
// the execute compat seam but is no longer part of this tool's advertised schema.
assert.equal(validateSearchTool({ kind: 'terminal' }), false, 'the terminal kind moved to the dedicated finish tool')
for (const invalidProposal of [
  { kind: 'search.patch', input: { patch: {} }, intent: { target: 'search.results' } },
  { kind: 'search.patch', input: { patch: { stay: { checkIn: 'tomorrow' } } }, intent: { target: 'search.results' } },
  { kind: 'search.patch', input: { patch: { starRating: { strength: 'must', value: { min: 9 } } } }, intent: { target: 'search.results' } },
  { kind: 'search.patch', input: { patch: { facilities: { strength: 'must', value: { allOf: [] } } } }, intent: { target: 'search.results' } },
  { kind: 'search.patch', input: { patch: { facilities: { strength: 'must', value: { allOf: ['breakfast', 'breakfast'] } } } }, intent: { target: 'search.results' } },
]) {
  // dsh's advertised dialect cannot express every canonical constraint. The
  // execute seam must still reject it before concludeTurn so the model gets
  // an INVALID_ARGS repair opportunity in the same bounded run.
  assert.equal(validateSearchTool(invalidProposal), true, 'the intentionally reduced advertised dialect exposes this regression case')
  await assert.rejects(
    executeSearch(invalidProposal),
    (error: unknown) => error instanceof ToolArgsError && error.code === 'INVALID_ARGS',
    'full canonical semantic constraints are enforced before concludeTurn',
  )
}
assert.equal(concludedTurns, 0, 'canonical semantic failures never conclude the dsh turn')

const compare = registered.find((tool) => tool.name === 'booking_compare_offers')!
const rawExecuteCompare = compare.execute as (args: unknown, exec: { concludeTurn(): void }) => Promise<unknown>
let compareConcludedTurns = 0
const executeCompare = (args: unknown) => rawExecuteCompare(args, {
  concludeTurn() { compareConcludedTurns += 1 },
})
const validateCompareTool = new Ajv2020({ allErrors: true, strict: true }).compile(compare.parameters as any)
const compositeCompareProposal = {
  kind: 'offers.compare',
  input: { offerRefs: ['offer-a', 'offer-b', 'offer-c'], requestedCount: 3 },
  intent: {
    target: 'offers.compared',
    offerCriteria: {
      meals: { strength: 'must', value: ['breakfast'] },
      freeCancellation: { strength: 'must', value: true },
      targetCount: 3,
    },
  },
}
assert.equal(validateCompareTool(compositeCompareProposal), true, JSON.stringify(validateCompareTool.errors))
assert.deepEqual(
  await executeCompare(compositeCompareProposal),
  { accepted: true, decisionKind: 'operation', actionKind: 'offers.compare' },
  'a shallow action may carry a typed multi-step goal without runtime-owned metadata',
)
assert.equal(compareConcludedTurns, 1)
const reducedIntentCounterexample = {
  ...compositeCompareProposal,
  intent: { target: 'offers.compared', offerCriteria: { targetCount: 0 } },
}
assert.equal(validateCompareTool(reducedIntentCounterexample), true, 'the reduced model dialect cannot express targetCount minimum')
await assert.rejects(
  executeCompare(reducedIntentCounterexample),
  (error: unknown) => error instanceof ToolArgsError && error.code === 'INVALID_ARGS' && /must be >= 1/.test(error.message),
  'the execute seam returns a precise repairable error for an invalid intent constraint',
)
assert.equal(compareConcludedTurns, 1, 'invalid intent does not conclude the model turn')
await assert.rejects(
  executeCompare({ ...compositeCompareProposal, intent: { ...compositeCompareProposal.intent, payment: true } }),
  (error: unknown) => error instanceof ToolArgsError && error.code === 'INVALID_ARGS',
  'the intent envelope is closed against write/payment fields',
)
assert.equal(compareConcludedTurns, 1)

const compactSearchProposal = {
  kind: 'search.patch',
  input: {
    patch: {
      budget: {
        strength: 'must',
        value: { max: { amount: '1000' } },
      },
    },
  },
  intent: { target: 'search.results' },
}
assert.equal(validateSearchTool(compactSearchProposal), true, JSON.stringify(validateSearchTool.errors))
assert.ok(!JSON.stringify(search.parameters).includes('sourceFactRef'), 'model-facing proposal does not ask the model to invent Money provenance')
assert.deepEqual(
  await executeSearch(compactSearchProposal),
  { accepted: true, decisionKind: 'operation', actionKind: 'search.patch' },
  'the tool execution seam accepts the same shallow proposal advertised to the model',
)
assert.equal(concludedTurns, 1, 'the first accepted proposal marks the current dsh turn as concluded')
const compactTerminalProposal = { kind: 'terminal' }
assert.deepEqual(
  await executeSearch(compactTerminalProposal),
  { accepted: true, decisionKind: 'terminal' },
  'terminal output remains a shallow proposal on the compat seam with runtime-owned evidence',
)
assert.equal(concludedTurns, 2, 'an accepted terminal proposal concludes the current dsh turn')
await assert.rejects(
  executeSearch({
    decision: { kind: 'terminal', terminal: { status: 'completed', summary: 'forged', factRefs: [] } },
  }),
  (error: unknown) => error instanceof ToolArgsError && error.code === 'INVALID_ARGS',
  'legacy model-authored terminal decisions are outside the compatibility contract',
)
assert.equal(concludedTurns, 2, 'a rejected legacy terminal does not conclude the dsh turn')
for (const decision of [compactSearchProposal, JSON.stringify(compactSearchProposal)]) {
  assert.deepEqual(
    await executeSearch({ decision }),
    { accepted: true, decisionKind: 'operation', actionKind: 'search.patch' },
    'one exact provider wrapper is normalized without widening semantic authority',
  )
}
assert.deepEqual(
  await executeSearch({ decision: { kind: 'operation', action: compactSearchProposal } }),
  { accepted: true, decisionKind: 'operation', actionKind: 'search.patch' },
  'the one-layer operation wrapper preserves nested compact intent without widening authority',
)
assert.deepEqual(
  await executeSearch({ kind: 'operation', action: { kind: compactSearchProposal.kind, input: compactSearchProposal.input }, intent: compactSearchProposal.intent }),
  { accepted: true, decisionKind: 'operation', actionKind: 'search.patch' },
  'the direct-hoisted compact operation accepted by the parent is accepted by the plugin too',
)
await assert.rejects(
  executeSearch({ decision: compactSearchProposal, extra: true }),
  (error: unknown) => error instanceof ToolArgsError && error.code === 'INVALID_ARGS',
  'provider compatibility remains closed to extra sibling fields',
)
const validSearchDecision = {
  decision: {
    kind: 'operation',
    intent: { target: 'search.results' },
    action: {
      schemaVersion: 'booking.surface',
      kind: 'search.patch',
      actionId: 'action-model-1',
      contextRef: 'ctx-model-1',
      expectedRevision: 0,
      reason: 'Apply the requested budget.',
      factRefs: [],
      input: {
        patch: {
          budget: {
            strength: 'must',
            value: { max: { amount: '1000', currency: 'AED', sourceFactRef: 'fact-budget-1' } },
          },
        },
      },
    },
  },
}
assert.equal(validateSearchTool(validSearchDecision), false, 'runtime-owned action metadata is absent from the advertised model schema')
assert.equal(
  validateSearchTool({ decision: JSON.stringify(validSearchDecision.decision) }),
  false,
  'the advertised model-facing schema remains canonical and object-only',
)
assert.deepEqual(
  await executeSearch({ decision: JSON.stringify(validSearchDecision.decision) }),
  { accepted: true, decisionKind: 'operation', actionKind: 'search.patch', actionId: 'action-model-1' },
  'the execution seam normalizes one provider-stringified action plus mandatory intent before applying the canonical schema',
)
await assert.rejects(
  executeSearch({ decision: JSON.stringify({ kind: 'operation', action: validSearchDecision.decision.action }) }),
  (error: unknown) => error instanceof ToolArgsError && error.code === 'INVALID_ARGS',
  'a fresh legacy full action cannot silently degrade a multi-step request by omitting intent',
)
await assert.rejects(
  executeSearch(Object.create({ decision: JSON.stringify(validSearchDecision.decision), injected: 'prototype-value' })),
  (error: unknown) => error instanceof ToolArgsError && error.code === 'INVALID_ARGS',
  'an inherited stringified decision cannot be materialized into an executable own property',
)
await assert.rejects(
  executeSearch(Object.create({ decision: validSearchDecision.decision })),
  (error: unknown) => error instanceof ToolArgsError && error.code === 'INVALID_ARGS',
  'an inherited canonical decision cannot satisfy the model-facing schema',
)
for (const decision of [
  'not JSON',
  `${JSON.stringify(validSearchDecision.decision)} trailing text`,
  JSON.stringify(null),
  JSON.stringify([]),
  JSON.stringify(1),
  JSON.stringify(JSON.stringify(validSearchDecision.decision)),
]) {
  await assert.rejects(
    executeSearch({ decision }),
    (error: unknown) => error instanceof ToolArgsError && error.code === 'INVALID_ARGS',
    'non-canonical decision strings remain rejected at the tool execution seam',
  )
}
await assert.rejects(
  executeSearch({
    decision: JSON.stringify({
      ...validSearchDecision.decision,
      action: JSON.stringify(validSearchDecision.decision.action),
    }),
  }),
  (error: unknown) => error instanceof ToolArgsError && error.code === 'INVALID_ARGS',
  'the compatibility seam does not normalize a stringified action',
)
assert.equal(validateSearchTool({ decision: { kind: 'operation', action: {
  schemaVersion: 'booking.surface', kind: 'search.run', actionId: 'action-model-v2', contextRef: 'ctx-model-1', expectedRevision: 0,
  reason: 'Run the authoritative workspace search.', factRefs: [], input: {},
} } }), false, 'legacy full actions are compatibility input only and stay out of the advertised schema')
const unsafeFactRefSearchDecision = {
  decision: {
    kind: 'operation',
    action: {
      schemaVersion: 'booking.surface', kind: 'search.run', actionId: 'action-model-v3', contextRef: 'ctx-model-1', expectedRevision: 1,
      reason: 'Run the authoritative workspace search after applying the destination.', factRefs: ['draft:destination=Dubai'], input: {},
    },
  },
}
assert.equal(
  validateSearchTool(unsafeFactRefSearchDecision),
  false,
  'model-facing tool schema rejects non-canonical factRefs before the planner authority boundary',
)
await assert.rejects(
  executeSearch(unsafeFactRefSearchDecision),
  (error: unknown) => error instanceof ToolArgsError
    && error.name === 'ToolArgsError'
    && error.code === 'INVALID_ARGS'
    && /decision_schema_violation/.test(error.message),
  'unsafe factRefs must surface as a repairable dsh INVALID_ARGS result',
)
const reservedFactRefSearchDecision = {
  ...unsafeFactRefSearchDecision,
  decision: {
    ...unsafeFactRefSearchDecision.decision,
    action: {
      ...unsafeFactRefSearchDecision.decision.action,
      factRefs: ['modelref:reserved-by-runtime'],
    },
  },
}
assert.equal(
  validateSearchTool(reservedFactRefSearchDecision),
  false,
  'model-facing tool schema excludes the runtime-owned modelref namespace',
)
await assert.rejects(
  executeSearch(reservedFactRefSearchDecision),
  (error: unknown) => error instanceof ToolArgsError
    && error.name === 'ToolArgsError'
    && error.code === 'INVALID_ARGS'
    && /decision_schema_violation/.test(error.message),
  'reserved modelref factRefs must surface as dsh INVALID_ARGS before the planner authority boundary',
)
assert.equal(
  validateSearchTool({
    ...unsafeFactRefSearchDecision,
    decision: {
      ...unsafeFactRefSearchDecision.decision,
      action: { ...unsafeFactRefSearchDecision.decision.action, factRefs: ['f'.repeat(513)] },
    },
  }),
  false,
  'model-facing tool schema enforces the runtime factRef length boundary',
)
const unsafeActionIdSearchDecision = {
  ...unsafeFactRefSearchDecision,
  decision: {
    ...unsafeFactRefSearchDecision.decision,
    action: {
      ...unsafeFactRefSearchDecision.decision.action,
      actionId: 'action/model-v3',
      factRefs: [],
    },
  },
}
assert.equal(
  validateSearchTool(unsafeActionIdSearchDecision),
  false,
  'model-facing tool schema rejects non-canonical actionIds before the planner authority boundary',
)
await assert.rejects(
  executeSearch(unsafeActionIdSearchDecision),
  (error: unknown) => error instanceof ToolArgsError
    && error.name === 'ToolArgsError'
    && error.code === 'INVALID_ARGS'
    && /decision_schema_violation/.test(error.message),
  'unsafe actionIds must surface as a repairable dsh INVALID_ARGS result',
)
assert.equal(validateSearchTool({
  ...validSearchDecision,
  decision: {
    ...validSearchDecision.decision,
    action: {
      ...validSearchDecision.decision.action,
      input: { patch: { unknownCriterion: { strength: 'must', value: true } } },
    },
  },
}), false, 'model-facing tool schema closes nested search criteria')
assert.equal(validateSearchTool({
  ...validSearchDecision,
  decision: {
    ...validSearchDecision.decision,
    action: {
      ...validSearchDecision.decision.action,
      input: {
        patch: {
          budget: {
            strength: 'must',
            value: { max: { amount: 1000, currency: 'AED', sourceFactRef: 'fact-budget-1' } },
          },
        },
      },
    },
  },
}), false, 'model-facing Money.amount rejects numbers')
assert.equal(validateSearchTool({
  ...validSearchDecision,
  decision: {
    ...validSearchDecision.decision,
    action: {
      ...validSearchDecision.decision.action,
      input: { patch: { holder: { email: 'x@example.com' } } },
    },
  },
}), false, 'model-facing tool schema rejects nested holder data')

// The dedicated finish tool accepts only the shallow terminal proposal.
const rawExecuteFinish = finishTool.execute as (args: unknown, exec: { concludeTurn(): void }) => Promise<unknown>
let finishConcludedTurns = 0
const executeFinish = (args: unknown) => rawExecuteFinish(args, {
  concludeTurn() { finishConcludedTurns += 1 },
})
assert.deepEqual(
  await executeFinish({ kind: 'terminal' }),
  { accepted: true, decisionKind: 'terminal' },
  'the finish tool accepts exactly the shallow terminal proposal',
)
assert.deepEqual(
  await executeFinish({ decision: { kind: 'terminal' } }),
  { accepted: true, decisionKind: 'terminal' },
  'the finish tool normalizes the one-layer provider terminal wrapper',
)
assert.equal(finishConcludedTurns, 2)
await assert.rejects(
  executeFinish({ kind: 'terminal', status: 'completed', summary: 'forged' }),
  (error: unknown) => error instanceof ToolArgsError && error.code === 'INVALID_ARGS',
  'model-authored terminal metadata stays rejected on the dedicated finish tool',
)
await assert.rejects(
  executeFinish({ kind: 'search.patch', input: {}, intent: {} }),
  (error: unknown) => error instanceof ToolArgsError && error.code === 'INVALID_ARGS',
  'the finish tool never accepts an operation proposal',
)
assert.equal(finishConcludedTurns, 2)

console.log('BOOKING COPILOT DSH PLUGIN PROOF: per-kind typed tools/no union/no Book OK')
