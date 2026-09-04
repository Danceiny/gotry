/** Closed dsh capability-tool registration proof (no dsh runtime required). */

import assert from 'node:assert/strict'
import { Ajv2020 } from 'ajv/dist/2020.js'
// @ts-expect-error Runtime dsh plugins are JavaScript modules registered by path.
import { apply, embeddedBookingToolDefinitions } from '../src/booking-surface/dsh-plugin.js'

const registered: Array<Record<string, unknown>> = []
apply({
  tools: {
    register(tool: Record<string, unknown>) { registered.push(tool) },
  },
})

assert.equal(registered.length, 6)
assert.deepEqual(registered.map((tool) => tool.name), [
  'booking_search_hotels',
  'booking_refine_results',
  'booking_find_room_offers',
  'booking_compare_offers',
  'booking_prepare_booking',
  'booking_observe_booking',
])
assert.deepEqual(registered, embeddedBookingToolDefinitions)
assert.ok(!registered.some((tool) => /gotry_book|trade|payment/i.test(String(tool.name))))
assert.ok(registered.every((tool) => {
  const parameters = tool.parameters as { additionalProperties?: boolean; properties?: Record<string, unknown> }
  return parameters.additionalProperties === false && Object.keys(parameters.properties ?? {}).join(',') === 'decision'
}), 'every model-facing tool accepts only one typed decision envelope')

const prepare = registered.find((tool) => tool.name === 'booking_prepare_booking')!
const prepareParameters = prepare.parameters as Record<string, any>
const operationBranches = prepareParameters.properties.decision.oneOf[0]?.properties?.action?.oneOf ?? []
assert.equal(operationBranches.length, 2, 'prepare-booking exposes offer.check + checkout.prepare only')
assert.ok(!JSON.stringify(prepare.parameters).includes('book"'), 'schema has no Book discriminator')

const search = registered.find((tool) => tool.name === 'booking_search_hotels')!
const validateSearchTool = new Ajv2020({ allErrors: true, strict: true }).compile(search.parameters as any)
const validSearchDecision = {
  decision: {
    kind: 'operation',
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
assert.equal(validateSearchTool(validSearchDecision), true, JSON.stringify(validateSearchTool.errors))
assert.equal(validateSearchTool({ decision: { kind: 'operation', action: {
  schemaVersion: 'booking.surface', kind: 'search.run', actionId: 'action-model-v2', contextRef: 'ctx-model-1', expectedRevision: 0,
  reason: 'Run the authoritative workspace search.', factRefs: [], input: {},
} } }), true, JSON.stringify(validateSearchTool.errors))
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

console.log('BOOKING COPILOT DSH PLUGIN PROOF: exact six typed tools/no Book OK')
