/**
 * Pure-JavaScript dsh plugin for the embedded Booking Copilot profile.
 *
 * It deliberately registers exactly six planning capabilities. There is no
 * Book/payment tool and no access to HotelByte credentials or business APIs.
 * The tool body only acknowledges a typed decision; PortalBookingPort remains
 * the sole executor after the parent adapter validates the canonical action.
 */

import Ajv2020 from 'ajv/dist/2020.js'
import { ToolArgsError } from '@deepseek-ai/dsh-tools'
import { dshBookingActionSchemaForKind } from './canonical-schema.js'

export const name = 'gotry-embedded-booking'
export const inject = ['tools']

const string = { type: 'string' }
const plannerSafeRefPattern = '^[A-Za-z0-9][A-Za-z0-9:._-]*$'
const plannerSafeFactRefPattern = '^(?!modelref:)[A-Za-z0-9][A-Za-z0-9:._-]*$'

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactKeys(value, allowed) {
  return isPlainRecord(value)
    && Object.keys(value).length === allowed.length
    && Object.keys(value).every((key) => allowed.includes(key))
}

function decisionBranchKeys(decision) {
  if (!isPlainRecord(decision) || typeof decision.kind !== 'string') return null
  const branch = {
    operation: 'action',
    question: 'question',
    explanation: 'explanation',
    terminal: 'terminal',
    error: 'error',
  }[decision.kind]
  return branch ? ['kind', branch] : null
}

function exactDecision(decision) {
  const keys = decisionBranchKeys(decision)
  return keys !== null && exactKeys(decision, keys)
}

// Provider compatibility is deliberately structural and one-layer only. It
// accepts the two JSON-equivalent serializations observed in OpenAI-compatible
// tool streams (a stringified decision member or a directly-hoisted decision),
// but never scans prose, strips arbitrary siblings, or recursively parses.
function normalizeProviderDecisionEnvelope(args) {
  if (!isPlainRecord(args)) return null
  let envelope = args
  if (exactDecision(args)) envelope = { decision: args }
  if (!exactKeys(envelope, ['decision'])) return null
  let decision = envelope.decision
  if (typeof decision === 'string') {
    try {
      decision = JSON.parse(decision)
    } catch {
      return null
    }
  }
  if (!exactDecision(decision)) return null
  return { decision }
}

function closedObject(properties, required = Object.keys(properties)) {
  return { type: 'object', properties, required, additionalProperties: false }
}

function actionSchema(kind) {
  const schema = dshBookingActionSchemaForKind(kind)
  return {
    ...schema,
    properties: {
      ...schema.properties,
      actionId: { ...schema.properties.actionId, pattern: plannerSafeRefPattern },
      factRefs: {
        ...schema.properties.factRefs,
        items: { ...schema.properties.factRefs.items, pattern: plannerSafeFactRefPattern, maxLength: 512 },
      },
    },
  }
}

function semanticInputSchema(value) {
  if (Array.isArray(value)) return value.map(semanticInputSchema)
  if (!isPlainRecord(value)) return value
  const projected = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, semanticInputSchema(item)]))
  // Money provenance is runtime-owned. The model supplies the amount and may
  // name a currency; the planner binds it to the durable user turn and uses
  // the authoritative workspace currency when the model omits one.
  if (isPlainRecord(projected.properties)
    && Object.prototype.hasOwnProperty.call(projected.properties, 'amount')
    && Object.prototype.hasOwnProperty.call(projected.properties, 'currency')
    && Object.prototype.hasOwnProperty.call(projected.properties, 'sourceFactRef')) {
    const { sourceFactRef: _sourceFactRef, ...properties } = projected.properties
    projected.properties = properties
    projected.required = Array.isArray(projected.required)
      ? projected.required.filter((key) => key !== 'sourceFactRef' && key !== 'currency')
      : projected.required
  }
  return projected
}

function actionProposalSchema(kind) {
  const canonical = dshBookingActionSchemaForKind(kind)
  return closedObject({
    kind: canonical.properties.kind,
    input: semanticInputSchema(canonical.properties.input),
  })
}

function toolDefinition(toolName, capabilityId, actionKinds) {
  const operationDecision = closedObject({
    kind: { type: 'string', const: 'operation' },
    action: { oneOf: actionKinds.map(actionSchema) },
  })
  const legacyParameters = closedObject({
    decision: operationDecision,
  })
  const terminalProposal = closedObject({ kind: { type: 'string', const: 'terminal' } })
  const proposalSchemas = actionKinds.map(actionProposalSchema)
  const parameters = { type: 'object', anyOf: [...proposalSchemas, terminalProposal] }
  const ajv = new Ajv2020({ allErrors: true, strict: false, ownProperties: true })
  const proposalValidators = new Map(actionKinds.map((kind, index) => [kind, ajv.compile(proposalSchemas[index])]))
  const validateTerminalProposal = ajv.compile(terminalProposal)
  const validateLegacyArgs = ajv.compile(legacyParameters)

  function isCompactProposal(value) {
    if (!isPlainRecord(value)) return false
    if (actionKinds.includes(value.kind)) return exactKeys(value, ['kind', 'input'])
    return value.kind === 'terminal' && exactKeys(value, ['kind'])
  }

  function compactProposal(args, legacyEnvelope) {
    if (isCompactProposal(args)) return args
    if (isPlainRecord(args) && exactKeys(args, ['decision'])) {
      let wrapped = args.decision
      if (typeof wrapped === 'string') {
        try { wrapped = JSON.parse(wrapped) } catch { wrapped = null }
      }
      if (isCompactProposal(wrapped)) return wrapped
    }
    const decision = legacyEnvelope?.decision
    if (decision?.kind === 'operation' && isPlainRecord(decision.action)
      && exactKeys(decision.action, ['kind', 'input'])) return decision.action
    return null
  }

  function acceptedValue(proposal, legacyEnvelope) {
    if (proposal?.kind === 'terminal') return { accepted: true, decisionKind: 'terminal' }
    const legacyAction = legacyEnvelope?.decision?.kind === 'operation'
      && isPlainRecord(legacyEnvelope.decision.action)
      ? legacyEnvelope.decision.action
      : null
    return {
      accepted: true,
      decisionKind: 'operation',
      actionKind: proposal?.kind ?? legacyAction?.kind,
      ...(typeof legacyAction?.actionId === 'string' ? { actionId: legacyAction.actionId } : {}),
    }
  }

  function conciseErrors(validator) {
    return (validator?.errors ?? []).slice(0, 8).map((error) => `${error.instancePath || '/'}: ${error.message}`)
  }

  return Object.freeze({
    name: toolName,
    description: `Emit exactly one typed ${capabilityId} decision for the existing Booking workspace. This capability never books, pays, edits holder/guest data, or calls a supplier.`,
    parameters,
    output: {
      schema: closedObject({
        accepted: { type: 'boolean', const: true },
        decisionKind: string,
        actionKind: string,
        actionId: string,
      }, ['accepted', 'decisionKind']),
      render(_args, value) {
        return [{ type: 'text', text: `Typed booking decision accepted (${value.decisionKind}). End this turn.` }]
      },
    },
    async execute(args, exec) {
      // The model authors only semantic action kind/input. Context, revision,
      // action identity, evidence and reason are runtime-owned and therefore
      // absent from the advertised schema. Dispatch validation by the known
      // kind so one local mistake does not expand into dozens of union errors.
      const legacyEnvelope = normalizeProviderDecisionEnvelope(args)
      const proposal = compactProposal(args, legacyEnvelope)
      const proposalValidator = proposal?.kind === 'terminal'
        ? validateTerminalProposal
        : proposal && proposalValidators.get(proposal.kind)
      if (proposalValidator?.(proposal)) {
        exec.concludeTurn()
        return acceptedValue(proposal, legacyEnvelope)
      }

      // Hidden compatibility accepts a fully canonical old decision during a
      // rolling upgrade. It is never advertised to the model, and the parent
      // planner repeats every semantic and authority validation before use.
      if (legacyEnvelope && validateLegacyArgs(legacyEnvelope)) {
        exec.concludeTurn()
        return acceptedValue(null, legacyEnvelope)
      }

      const errors = proposalValidator
        ? conciseErrors(proposalValidator)
        : legacyEnvelope?.decision?.kind === 'operation'
          ? ['/: runtime-owned action metadata is invalid; emit exactly {"kind":...,"input":...}']
          : ['/: expected one shallow typed action proposal or terminal proposal']
      throw new ToolArgsError([`decision_schema_violation: ${errors.join('; ')}`])
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
