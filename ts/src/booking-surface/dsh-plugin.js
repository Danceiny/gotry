/**
 * Pure-JavaScript dsh plugin for the embedded Booking Copilot profile.
 *
 * It registers one tool per typed planning action kind plus one terminal tool.
 * Every action tool advertises a single concrete closed schema (const kind +
 * that kind's input + intent) instead of a union, because provider tool-call
 * support for top-level anyOf is unreliable outside DeepSeek: weaker models
 * either drop the union or imitate the canonical receipts they see in context.
 * There is no Book/payment tool and no access to HotelByte credentials or
 * business APIs. The tool body only acknowledges a typed decision;
 * PortalBookingPort remains the sole executor after the parent adapter
 * validates the canonical action.
 */

import Ajv2020 from 'ajv/dist/2020.js'
import { ToolArgsError } from '@deepseek-ai/dsh-tools'
import {
  canonicalBookingActionSchemaForKind,
  canonicalBookingIntentProjectionSchema,
  dshBookingActionSchemaForKind,
  dshBookingIntentProjectionSchema,
} from './canonical-schema.js'

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
  if (keys === null) return false
  return decision.kind === 'operation'
    ? exactKeys(decision, [...keys, 'intent'])
    : exactKeys(decision, keys)
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

function actionSchema(kind, schema = dshBookingActionSchemaForKind(kind)) {
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

function intentProposalSchema(schema) {
  const semantic = semanticInputSchema(schema)
  const { schemaVersion: _schemaVersion, ...properties } = semantic.properties
  return {
    ...semantic,
    properties,
    required: semantic.required.filter((key) => key !== 'schemaVersion'),
  }
}

function actionProposalSchema(kind, canonical = dshBookingActionSchemaForKind(kind), intent = intentProposalSchema(dshBookingIntentProjectionSchema())) {
  return closedObject({
    kind: canonical.properties.kind,
    input: semanticInputSchema(canonical.properties.input),
    intent,
  }, ['kind', 'input', 'intent'])
}

/** Per-tool guidance: the exact argument shape for this one action kind. */
const KIND_ARGUMENT_GUIDE = {
  'search.patch': 'input.patch property names are EXACT: destination, hotel, stay, occupancy, budget, starRating, guestRating, facilities, distance. There is no "criteria" property. Amenities (pool, parking) go under facilities; included breakfast/meal-plan and free-cancellation belong in intent.offerCriteria, never in facilities. An accepted patch is compiled into search.run by the runtime itself.',
  'search.run': 'input is always exactly {} — the runtime runs the draft criteria as-is.',
  'results.view.patch': 'input.patch adjusts only the results view (sort/filter of the current result set); it never changes the draft criteria.',
  'hotel.focus': 'input is exactly {"hotelRef":"<ref quoted from an authoritative receipt>"} — never invent a hotelRef.',
  'hotel.select': 'input is exactly {"hotelRef":"<ref quoted from an authoritative receipt>"} — never invent a hotelRef.',
  'offers.query': 'input is exactly {"hotelRefs":["<ref>",...],"criteria":{...}} with hotelRefs quoted from authoritative receipts.',
  'offers.view.patch': 'input is exactly {"hotelRef":"<ref>","criteria":{...}} adjusting the offer view for that one hotel.',
  'offers.compare': 'input is exactly {"offerRefs":["<ref>",...],"requestedCount":N} with offerRefs quoted from authoritative receipts.',
  'offer.select': 'input is exactly {"offerRef":"<ref>","offerVersionRef":"<ref>"} quoted from authoritative receipts.',
  'offer.check': 'input is exactly {"offerRef":"<ref>","offerVersionRef":"<ref>"} quoted from authoritative receipts.',
  'checkout.prepare': 'input is exactly {"offerRef":"<ref>","offerVersionRef":"<ref>","verifiedOfferRef":"<ref>"} quoted from authoritative receipts.',
  'order.observe': 'input is exactly {"orderRef":"<ref from the trusted order context>"}.',
}

function typedActionTool(toolName, kind) {
  const fullIntentProposalSchema = intentProposalSchema(canonicalBookingIntentProjectionSchema())
  const operationDecision = closedObject({
    kind: { type: 'string', const: 'operation' },
    action: actionSchema(kind, canonicalBookingActionSchemaForKind(kind)),
    intent: fullIntentProposalSchema,
  })
  const legacyParameters = closedObject({
    decision: operationDecision,
  })
  const terminalProposal = closedObject({ kind: { type: 'string', const: 'terminal' } })
  // The advertised dsh dialect intentionally omits unsupported numeric/string
  // keywords. Execute-time validation must still use the full canonical
  // semantic input, otherwise dsh can conclude a turn that the parent rejects
  // (for example patch:{}, star=9, an invalid date, or an empty facility list).
  // Throwing ToolArgsError here keeps the correction inside the same bounded
  // model run and prevents a false-success tool/result pair.
  const canonicalProposalSchema = actionProposalSchema(kind, canonicalBookingActionSchemaForKind(kind), fullIntentProposalSchema)
  // One concrete closed schema per tool: const kind + that kind's input +
  // intent. No top-level anyOf — the tool name itself selects the branch.
  const parameters = actionProposalSchema(kind)
  const ajv = new Ajv2020({ allErrors: true, strict: false, ownProperties: true })
  const proposalValidator = ajv.compile(canonicalProposalSchema)
  const validateTerminalProposal = ajv.compile(terminalProposal)
  const validateLegacyArgs = ajv.compile(legacyParameters)

  function isCompactProposal(value) {
    if (!isPlainRecord(value)) return false
    if (value.kind === kind) {
      return exactKeys(value, ['kind', 'input', 'intent'])
    }
    return value.kind === 'terminal' && exactKeys(value, ['kind'])
  }

  function compactProposal(args, legacyEnvelope) {
    if (isCompactProposal(args)) return args
    if (isPlainRecord(args) && args.kind === 'operation' && isPlainRecord(args.action)) {
      if (exactKeys(args, ['kind', 'action']) && exactKeys(args.action, ['kind', 'input', 'intent'])) {
        return args.action
      }
      if (exactKeys(args, ['kind', 'action', 'intent']) && exactKeys(args.action, ['kind', 'input'])) {
        return { ...args.action, intent: args.intent }
      }
    }
    if (isPlainRecord(args) && exactKeys(args, ['decision'])) {
      let wrapped = args.decision
      if (typeof wrapped === 'string') {
        try { wrapped = JSON.parse(wrapped) } catch { wrapped = null }
      }
      if (isCompactProposal(wrapped)) return wrapped
      if (isPlainRecord(wrapped) && wrapped.kind === 'operation' && isPlainRecord(wrapped.action)) {
        if (exactKeys(wrapped, ['kind', 'action']) && exactKeys(wrapped.action, ['kind', 'input', 'intent'])) {
          return wrapped.action
        }
        if (exactKeys(wrapped, ['kind', 'action', 'intent']) && exactKeys(wrapped.action, ['kind', 'input'])) {
          return { ...wrapped.action, intent: wrapped.intent }
        }
      }
    }
    const decision = legacyEnvelope?.decision
    if (decision?.kind === 'operation' && isPlainRecord(decision.action)
      && exactKeys(decision.action, ['kind', 'input', 'intent'])) return decision.action
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

  // Keep near-miss arguments available to Ajv even when they are not exact
  // enough to become an executable proposal. This gives the model a concrete
  // field-level repair such as "must have required property 'intent'" instead
  // of a generic envelope error, while acceptance still goes through the
  // closed compact/legacy paths above.
  function validationCandidate(args) {
    let candidate = args
    if (isPlainRecord(candidate) && exactKeys(candidate, ['decision'])) {
      candidate = candidate.decision
      if (typeof candidate === 'string') {
        try { candidate = JSON.parse(candidate) } catch { return null }
      }
    }
    if (isPlainRecord(candidate) && candidate.kind === 'operation' && isPlainRecord(candidate.action)) {
      const action = candidate.action
      return action.intent === undefined && candidate.intent !== undefined
        ? { ...action, intent: candidate.intent }
        : action
    }
    return candidate
  }

  return Object.freeze({
    name: toolName,
    description: `Emit exactly one typed ${kind} decision for the existing Booking workspace. ${KIND_ARGUMENT_GUIDE[kind] ?? ''} Every operation must carry intent; if task.activeIntent exists, repeat its semantic fields exactly. This capability never books, pays, edits holder/guest data, or calls a supplier. Never emit actionId, contextRef, expectedRevision, factRefs, reason, or schemaVersion — the runtime owns them. Never write the decision as assistant text: answer only with this tool call.`,
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
      // absent from the advertised schema. Validation is dispatched by the
      // tool's single known kind so one local mistake does not expand into
      // dozens of union errors.
      const legacyEnvelope = normalizeProviderDecisionEnvelope(args)
      const proposal = compactProposal(args, legacyEnvelope)
      const candidate = proposal ?? validationCandidate(args)
      const proposalValidatorForCandidate = candidate?.kind === 'terminal'
        ? validateTerminalProposal
        : candidate?.kind === kind
          ? proposalValidator
          : undefined
      const proposalValid = Boolean(proposal && proposalValidatorForCandidate?.(proposal))
      if (proposalValid) {
        exec.concludeTurn()
        return acceptedValue(proposal, legacyEnvelope)
      }

      // Hidden compatibility accepts a fully canonical action only when the
      // operation also carries the mandatory semantic intent. It is never
      // advertised to the model, and the parent planner repeats every semantic
      // and authority validation before use.
      if (legacyEnvelope && validateLegacyArgs(legacyEnvelope)) {
        exec.concludeTurn()
        return acceptedValue(null, legacyEnvelope)
      }

      if (!proposalValid) proposalValidatorForCandidate?.(candidate)
      const errors = proposalValidatorForCandidate
        ? conciseErrors(proposalValidatorForCandidate)
        : legacyEnvelope?.decision?.kind === 'operation'
          ? ['/: runtime-owned action metadata is invalid; emit exactly {"kind":...,"input":...}']
          : [`/: expected a ${kind} proposal with exactly {"kind","input","intent"} (or {"kind":"terminal"} to finish)`]
      throw new ToolArgsError([`decision_schema_violation: ${errors.join('; ')}`])
    },
  })
}

function finishTurnTool() {
  return Object.freeze({
    name: 'booking_finish_turn',
    description: 'Finish the planning turn as terminal because the requested waypoint is already reached by an authoritative receipt. Arguments must be exactly {"kind":"terminal"}. The runtime alone owns terminal status, summary, and evidence. Never write the decision as assistant text: answer only with this tool call.',
    parameters: closedObject({ kind: { type: 'string', const: 'terminal' } }, ['kind']),
    output: {
      schema: closedObject({
        accepted: { type: 'boolean', const: true },
        decisionKind: string,
      }, ['accepted', 'decisionKind']),
      render(_args, value) {
        return [{ type: 'text', text: `Typed booking decision accepted (${value.decisionKind}). End this turn.` }]
      },
    },
    async execute(args, exec) {
      // Compatibility: the terminal proposal is accepted through the same
      // shallow path as the action tools; runtime-owned terminal metadata is
      // never accepted from the model.
      const shallow = isPlainRecord(args) && exactKeys(args, ['kind']) && args.kind === 'terminal'
      const legacyTerminal = !shallow
        && isPlainRecord(args)
        && exactKeys(args, ['decision'])
        && (isPlainRecord(args.decision)
          ? exactKeys(args.decision, ['kind']) && args.decision.kind === 'terminal'
          : (typeof args.decision === 'string'
            && (() => { try { return exactKeys(JSON.parse(args.decision), ['kind']) && JSON.parse(args.decision).kind === 'terminal' } catch { return false } })()))
      if (!shallow && !legacyTerminal) {
        throw new ToolArgsError(['decision_schema_violation: /: arguments must be exactly {"kind":"terminal"}'])
      }
      exec.concludeTurn()
      return { accepted: true, decisionKind: 'terminal' }
    },
  })
}

/**
 * One tool per action kind. The six historical capability tool names survive
 * as the primary kind of their group so provider streams recorded against the
 * grouped tools still parse; the remaining kinds gained dedicated tools.
 */
const EMBEDDED_ACTION_TOOLS = [
  ['booking_search_hotels', 'search.patch'],
  ['booking_run_search', 'search.run'],
  ['booking_refine_results', 'results.view.patch'],
  ['booking_focus_hotel', 'hotel.focus'],
  ['booking_select_hotel', 'hotel.select'],
  ['booking_find_room_offers', 'offers.query'],
  ['booking_view_offers', 'offers.view.patch'],
  ['booking_compare_offers', 'offers.compare'],
  ['booking_select_offer', 'offer.select'],
  ['booking_prepare_booking', 'offer.check'],
  ['booking_prepare_checkout', 'checkout.prepare'],
  ['booking_observe_booking', 'order.observe'],
]

export const embeddedBookingToolDefinitions = Object.freeze([
  ...EMBEDDED_ACTION_TOOLS.map(([toolName, kind]) => typedActionTool(toolName, kind)),
  finishTurnTool(),
])

export function apply(ctx) {
  for (const tool of embeddedBookingToolDefinitions) ctx.tools.register(tool)
}
