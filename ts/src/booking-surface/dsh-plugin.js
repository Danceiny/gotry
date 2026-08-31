/**
 * Pure-JavaScript dsh plugin for the embedded Booking Copilot profile.
 *
 * It deliberately registers exactly six planning capabilities. There is no
 * Book/payment tool and no access to HotelByte credentials or business APIs.
 * The tool body only acknowledges a typed decision; PortalBookingPort remains
 * the sole executor after the parent adapter validates the canonical action.
 */

import { dshBookingActionSchemaForKind } from './canonical-schema.js'

export const name = 'gotry-embedded-booking'
export const inject = ['tools']

const string = { type: 'string' }
const boolean = { type: 'boolean' }
const stringArray = { type: 'array', items: string }

function closedObject(properties, required = Object.keys(properties)) {
  return { type: 'object', properties, required, additionalProperties: false }
}

function actionSchema(kind) {
  return dshBookingActionSchemaForKind(kind)
}

const questionDecision = closedObject({
  kind: { type: 'string', const: 'question' },
  question: closedObject({ questionId: string, prompt: string, missingFields: stringArray }),
})
const explanationDecision = closedObject({
  kind: { type: 'string', const: 'explanation' },
  explanation: closedObject({ text: string, factRefs: stringArray }),
})
const terminalDecision = closedObject({
  kind: { type: 'string', const: 'terminal' },
  terminal: closedObject({
    status: { type: 'string', enum: ['completed', 'stopped'] },
    summary: string,
    factRefs: stringArray,
  }),
})
const errorDecision = closedObject({
  kind: { type: 'string', const: 'error' },
  error: closedObject({ code: string, message: string, retryable: boolean }),
})

function toolDefinition(toolName, capabilityId, actionKinds) {
  const operationDecision = closedObject({
    kind: { type: 'string', const: 'operation' },
    action: { oneOf: actionKinds.map(actionSchema) },
  })
  return Object.freeze({
    name: toolName,
    description: `Emit exactly one typed ${capabilityId} decision for the existing Booking workspace. This capability never books, pays, edits holder/guest data, or calls a supplier.`,
    parameters: closedObject({
      decision: {
        oneOf: [operationDecision, questionDecision, explanationDecision, terminalDecision, errorDecision],
      },
    }),
    output: {
      schema: closedObject({
        accepted: { type: 'boolean', const: true },
        decisionKind: string,
        actionId: string,
      }, ['accepted', 'decisionKind']),
      render(_args, value) {
        return [{ type: 'text', text: `Typed booking decision accepted (${value.decisionKind}). End this turn.` }]
      },
    },
    async execute(args) {
      const decision = args.decision
      return {
        accepted: true,
        decisionKind: decision.kind,
        ...(decision.kind === 'operation' ? { actionId: decision.action.actionId } : {}),
      }
    },
  })
}

export const embeddedBookingToolDefinitions = Object.freeze([
  toolDefinition('booking_search_hotels', 'search-hotels', ['search.patch', 'search.run']),
  toolDefinition('booking_refine_results', 'refine-results', ['results.view.patch', 'hotel.focus', 'hotel.select']),
  toolDefinition('booking_find_room_offers', 'find-room-offers', ['offers.query', 'offers.view.patch']),
  toolDefinition('booking_compare_offers', 'compare-offers', ['offers.compare', 'offer.select']),
  toolDefinition('booking_prepare_booking', 'prepare-booking', ['offer.check', 'checkout.prepare']),
  toolDefinition('booking_observe_booking', 'observe-booking', ['order.observe']),
])

export function apply(ctx) {
  for (const tool of embeddedBookingToolDefinitions) ctx.tools.register(tool)
}
