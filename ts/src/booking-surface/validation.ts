import {
  BOOKING_READ_ACTION_KINDS,
  BOOKING_RECEIPT_STATUSES,
  BOOKING_SURFACES,
  BOOKING_SURFACE_EVENT_KINDS,
  type ActionReceiptV1,
  type BookingCopilotIngressTurnV1,
  type BookingCopilotTurnV1,
  type BookingReadActionKindV1,
  type BookingReadActionV1,
  type BookingSurfaceEventV1,
  type BookingWorkspaceIngressSnapshotV1,
  type BookingWorkspaceSnapshotV1,
} from './contracts.ts'
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js'
import { readFileSync } from 'node:fs'

const CANONICAL_SCHEMA = JSON.parse(readFileSync(
  new URL('../../../schemas/booking.surface.v1.schema.json', import.meta.url),
  'utf8',
)) as Record<string, unknown>
const CANONICAL_SCHEMA_ID = 'https://gotry.dev/schemas/booking.surface.v1.schema.json'
const canonicalAjv = new Ajv2020({ allErrors: true, strict: true })
canonicalAjv.addSchema(CANONICAL_SCHEMA)
const validateCanonicalAction = canonicalAjv.compile({
  $ref: `${CANONICAL_SCHEMA_ID}#/$defs/BookingReadActionV1`,
}) as ValidateFunction
const validateCanonicalReceipt = canonicalAjv.compile({
  $ref: `${CANONICAL_SCHEMA_ID}#/$defs/ActionReceiptV1`,
}) as ValidateFunction

export type BookingSurfaceValidationResult =
  | { ok: true }
  | { ok: false; errors: string[] }

const ACTION_KINDS = new Set<string>(BOOKING_READ_ACTION_KINDS)
const RECEIPT_STATUSES = new Set<string>(BOOKING_RECEIPT_STATUSES)
const SURFACES = new Set<string>(BOOKING_SURFACES)
const EVENT_KINDS = new Set<string>(BOOKING_SURFACE_EVENT_KINDS)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isRevision(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString)
}

function isCount(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0
}
function isSafeCode(value: unknown): value is string { return typeof value === 'string' && /^[a-z][a-z0-9._-]*$/.test(value) }

function receiptContainsUnsafeOpaqueText(value: unknown): boolean {
  if (typeof value === 'string') return /[^\s@]+@[^\s@]+\.[^\s@]+|Bearer\s+[^\s]+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/i.test(value)
  if (Array.isArray(value)) return value.some(receiptContainsUnsafeOpaqueText)
  if (isRecord(value)) return Object.values(value).some(receiptContainsUnsafeOpaqueText)
  return false
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  at: string,
  errors: string[],
): void {
  const allow = new Set(allowed)
  for (const key of Object.keys(value)) if (!allow.has(key)) errors.push(`${at}.${key}: additional property is forbidden`)
  for (const key of required) if (!Object.hasOwn(value, key)) errors.push(`${at}.${key}: required`)
}

function validateIngressWorkspace(value: unknown, at: string, errors: string[]): value is BookingWorkspaceIngressSnapshotV1 {
  if (!isRecord(value)) { errors.push(`${at}: object required`); return false }
  exactKeys(value, [
    'schemaVersion', 'revision', 'locale', 'currency', 'searchDraft', 'results',
    'visibleHotels', 'loadedOffers', 'focusedHotelRef', 'shortlistedOfferRefs',
    'selectedOfferRef', 'verifiedOfferRef',
  ], [
    'schemaVersion', 'revision', 'locale', 'currency', 'searchDraft', 'results',
    'visibleHotels', 'loadedOffers', 'shortlistedOfferRefs',
  ], at, errors)
  if (value.schemaVersion !== 'booking.surface.v1') errors.push(`${at}.schemaVersion: booking.surface.v1 required`)
  if (!isRevision(value.revision)) errors.push(`${at}.revision: non-negative integer required`)
  if (!isNonEmptyString(value.locale)) errors.push(`${at}.locale: non-empty string required`)
  if (typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency)) errors.push(`${at}.currency: ISO-4217 code required`)
  if (!isRecord(value.searchDraft)) errors.push(`${at}.searchDraft: object required`)
  if (!isRecord(value.results)) errors.push(`${at}.results: object required`)
  if (!Array.isArray(value.visibleHotels)) errors.push(`${at}.visibleHotels: array required`)
  if (!Array.isArray(value.loadedOffers)) errors.push(`${at}.loadedOffers: array required`)
  if (!isStringArray(value.shortlistedOfferRefs)) errors.push(`${at}.shortlistedOfferRefs: opaque-ref array required`)
  return errors.length === 0
}

function validateWorkspace(value: unknown, at: string, errors: string[]): value is BookingWorkspaceSnapshotV1 {
  if (!isRecord(value)) { errors.push(`${at}: object required`); return false }
  const {
    contextRef: _contextRef,
    surface: _surface,
    capabilities: _capabilities,
    ...ingressShape
  } = value
  validateIngressWorkspace(ingressShape, at, errors)
  const allowed = [
    'schemaVersion', 'contextRef', 'surface', 'revision', 'locale', 'currency',
    'searchDraft', 'results', 'visibleHotels', 'loadedOffers', 'focusedHotelRef',
    'shortlistedOfferRefs', 'selectedOfferRef', 'verifiedOfferRef', 'capabilities',
  ]
  exactKeys(value, allowed, [
    'schemaVersion', 'contextRef', 'surface', 'revision', 'locale', 'currency',
    'searchDraft', 'results', 'visibleHotels', 'loadedOffers', 'shortlistedOfferRefs',
    'capabilities',
  ], at, errors)
  if (!isNonEmptyString(value.contextRef)) errors.push(`${at}.contextRef: server-minted opaque ref required`)
  if (typeof value.surface !== 'string' || !SURFACES.has(value.surface)) errors.push(`${at}.surface: unsupported surface`)
  if (!isRecord(value.capabilities)) {
    errors.push(`${at}.capabilities: object required`)
  } else {
    exactKeys(value.capabilities, ['surface', 'allowedActions'], ['surface', 'allowedActions'], `${at}.capabilities`, errors)
    if (value.capabilities.surface !== value.surface) errors.push(`${at}.capabilities.surface: must equal workspace.surface`)
    const actionKinds = value.capabilities.allowedActions
    if (!Array.isArray(actionKinds) || !actionKinds.every((kind) => typeof kind === 'string' && ACTION_KINDS.has(kind))) {
      errors.push(`${at}.capabilities.allowedActions: closed action-kind array required`)
    } else if (new Set(actionKinds).size !== actionKinds.length) {
      errors.push(`${at}.capabilities.allowedActions: duplicates forbidden`)
    }
  }
  return errors.length === 0
}

const ACTION_INPUT_KEYS: Record<BookingReadActionKindV1, { allowed: readonly string[]; required: readonly string[] }> = {
  'search.patch': { allowed: ['patch'], required: ['patch'] },
  'search.run': { allowed: [], required: [] },
  'results.view.patch': { allowed: ['patch'], required: ['patch'] },
  'hotel.focus': { allowed: ['hotelRef'], required: ['hotelRef'] },
  'hotel.select': { allowed: ['hotelRef'], required: ['hotelRef'] },
  'offers.query': { allowed: ['hotelRefs', 'criteria'], required: ['hotelRefs', 'criteria'] },
  'offers.view.patch': { allowed: ['hotelRef', 'criteria'], required: ['hotelRef', 'criteria'] },
  'offers.compare': { allowed: ['offerRefs', 'requestedCount'], required: ['offerRefs', 'requestedCount'] },
  'offer.select': { allowed: ['offerRef'], required: ['offerRef'] },
  'offer.check': { allowed: ['offerRef'], required: ['offerRef'] },
  'checkout.prepare': { allowed: ['offerRef', 'verifiedOfferRef'], required: ['offerRef', 'verifiedOfferRef'] },
  'order.observe': { allowed: ['orderRef'], required: ['orderRef'] },
}

function collectBookingReadActionErrors(value: unknown, at: string): string[] {
  const errors: string[] = []
  if (!isRecord(value)) return [`${at}: typed action object required; text is never executable`]
  exactKeys(value, [
    'schemaVersion', 'kind', 'actionId', 'contextRef', 'expectedRevision',
    'reason', 'factRefs', 'input',
  ], [
    'schemaVersion', 'kind', 'actionId', 'contextRef', 'expectedRevision',
    'reason', 'factRefs', 'input',
  ], at, errors)
  if (value.schemaVersion !== 'booking.surface.v1') errors.push(`${at}.schemaVersion: booking.surface.v1 required`)
  if (typeof value.kind !== 'string' || !ACTION_KINDS.has(value.kind)) {
    errors.push(`${at}.kind: unregistered read action`)
  }
  if (!isNonEmptyString(value.actionId)) errors.push(`${at}.actionId: opaque ref required`)
  if (!isNonEmptyString(value.contextRef)) errors.push(`${at}.contextRef: opaque ref required`)
  if (!isRevision(value.expectedRevision)) errors.push(`${at}.expectedRevision: non-negative integer required`)
  if (!isNonEmptyString(value.reason)) errors.push(`${at}.reason: non-empty explanation required`)
  if (!isStringArray(value.factRefs)) errors.push(`${at}.factRefs: opaque-ref array required`)
  if (!isRecord(value.input)) {
    errors.push(`${at}.input: typed object required`)
  } else if (typeof value.kind === 'string' && ACTION_KINDS.has(value.kind)) {
    const spec = ACTION_INPUT_KEYS[value.kind as BookingReadActionKindV1]
    exactKeys(value.input, spec.allowed, spec.required, `${at}.input`, errors)
  }
  if (!validateCanonicalAction(value)) {
    for (const error of validateCanonicalAction.errors ?? []) {
      errors.push(canonicalError(error, at))
    }
  }
  return errors
}

function canonicalError(error: ErrorObject, at: string): string {
  const path = error.instancePath ? error.instancePath.replaceAll('/', '.') : ''
  const property = error.keyword === 'additionalProperties'
    ? `.${String((error.params as { additionalProperty?: unknown }).additionalProperty ?? '')}`
    : ''
  return `${at}${path}${property}: ${error.message ?? error.keyword}`
}

export function validateBookingReadActionV1(value: unknown): BookingSurfaceValidationResult {
  const errors = collectBookingReadActionErrors(value, '$')
  return errors.length === 0 ? { ok: true } : { ok: false, errors }
}

function collectReceiptErrors(value: unknown, at: string): string[] {
  const errors: string[] = []
  if (!isRecord(value)) return [`${at}: typed receipt object required`]
  exactKeys(value, [
    'schemaVersion', 'kind', 'actionId', 'contextRef', 'status', 'revision',
    'observation', 'resultContract', 'undoToken',
  ], [
    'schemaVersion', 'kind', 'actionId', 'contextRef', 'status', 'revision',
    'observation', 'resultContract',
  ], at, errors)
  if (value.schemaVersion !== 'booking.surface.v1') errors.push(`${at}.schemaVersion: booking.surface.v1 required`)
  if (value.kind !== 'action.receipt') errors.push(`${at}.kind: action.receipt required`)
  if (!isNonEmptyString(value.actionId)) errors.push(`${at}.actionId: opaque ref required`)
  if (!isNonEmptyString(value.contextRef)) errors.push(`${at}.contextRef: opaque ref required`)
  if (typeof value.status !== 'string' || !RECEIPT_STATUSES.has(value.status)) errors.push(`${at}.status: unregistered receipt status`)
  if (!isRevision(value.revision)) errors.push(`${at}.revision: non-negative integer required`)
  if (value.undoToken !== undefined && !isNonEmptyString(value.undoToken)) errors.push(`${at}.undoToken: opaque ref required`)
  validateActionObservation(value.observation, `${at}.observation`, errors)
  validateResultContract(value.resultContract, `${at}.resultContract`, errors)
  return errors
}

function validateActionObservation(value: unknown, at: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${at}: discriminated object required`)
    return
  }

  switch (value.kind) {
    case 'search.state':
      exactKeys(value, ['kind', 'searchSessionRef', 'resultCount'], ['kind'], at, errors)
      if (value.searchSessionRef !== undefined && !isNonEmptyString(value.searchSessionRef)) errors.push(`${at}.searchSessionRef: opaque ref required`)
      if (value.resultCount !== undefined && !isCount(value.resultCount)) errors.push(`${at}.resultCount: non-negative integer required`)
      return
    case 'results.state':
      exactKeys(value, ['kind', 'matchedHotelRefs', 'visibleCount'], ['kind', 'matchedHotelRefs', 'visibleCount'], at, errors)
      if (!isStringArray(value.matchedHotelRefs)) errors.push(`${at}.matchedHotelRefs: opaque-ref array required`)
      if (!isCount(value.visibleCount)) errors.push(`${at}.visibleCount: non-negative integer required`)
      return
    case 'hotel.focus':
      exactKeys(value, ['kind', 'hotelRef'], ['kind', 'hotelRef'], at, errors)
      if (!isNonEmptyString(value.hotelRef)) errors.push(`${at}.hotelRef: opaque ref required`)
      return
    case 'hotel.selection':
      exactKeys(value, ['kind', 'hotelRef'], ['kind', 'hotelRef'], at, errors)
      if (!isNonEmptyString(value.hotelRef)) errors.push(`${at}.hotelRef: opaque ref required`)
      return
    case 'offers.state':
      exactKeys(value, ['kind', 'hotelRefs', 'offerRefs', 'loadedHotelCount'], ['kind', 'hotelRefs', 'offerRefs', 'loadedHotelCount'], at, errors)
      if (!isStringArray(value.hotelRefs)) errors.push(`${at}.hotelRefs: opaque-ref array required`)
      if (!isStringArray(value.offerRefs)) errors.push(`${at}.offerRefs: opaque-ref array required`)
      if (!isCount(value.loadedHotelCount)) errors.push(`${at}.loadedHotelCount: non-negative integer required`)
      return
    case 'offer.selection':
      exactKeys(value, ['kind', 'offerRef'], ['kind', 'offerRef'], at, errors)
      if (!isNonEmptyString(value.offerRef)) errors.push(`${at}.offerRef: opaque ref required`)
      return
    case 'offer.availability':
      exactKeys(value, ['kind', 'offerRef', 'verifiedOfferRef', 'available', 'changedFactRefs'], ['kind', 'offerRef', 'available', 'changedFactRefs'], at, errors)
      if (!isNonEmptyString(value.offerRef)) errors.push(`${at}.offerRef: opaque ref required`)
      if (value.verifiedOfferRef !== undefined && !isNonEmptyString(value.verifiedOfferRef)) errors.push(`${at}.verifiedOfferRef: opaque ref required`)
      if (typeof value.available !== 'boolean') errors.push(`${at}.available: boolean required`)
      if (!isStringArray(value.changedFactRefs)) errors.push(`${at}.changedFactRefs: opaque-ref array required`)
      return
    case 'checkout.handoff':
      exactKeys(value, ['kind', 'offerRef', 'verifiedOfferRef', 'handoffRef'], ['kind', 'offerRef', 'verifiedOfferRef', 'handoffRef'], at, errors)
      if (!isNonEmptyString(value.offerRef)) errors.push(`${at}.offerRef: opaque ref required`)
      if (!isNonEmptyString(value.verifiedOfferRef)) errors.push(`${at}.verifiedOfferRef: opaque ref required`)
      if (!isNonEmptyString(value.handoffRef)) errors.push(`${at}.handoffRef: opaque ref required`)
      return
    case 'order.state': {
      exactKeys(value, ['kind', 'orderRef', 'state'], ['kind', 'orderRef', 'state'], at, errors)
      const states = new Set(['pending', 'verified', 'failed', 'unknown'])
      if (!isNonEmptyString(value.orderRef)) errors.push(`${at}.orderRef: opaque ref required`)
      if (typeof value.state !== 'string' || !states.has(value.state)) errors.push(`${at}.state: unregistered order state`)
      return
    }
    case 'gap':
      exactKeys(value, ['kind', 'code', 'factRefs'], ['kind', 'code', 'factRefs'], at, errors)
      if (!isSafeCode(value.code)) errors.push(`${at}.code: safe identifier required`)
      if (!isStringArray(value.factRefs)) errors.push(`${at}.factRefs: opaque-ref array required`)
      return
    default:
      errors.push(`${at}.kind: unregistered observation kind`)
  }
}

function validateResultContract(value: unknown, at: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${at}: object required`)
    return
  }
  exactKeys(value, ['outcome', 'requestedCount', 'actualCount', 'hardCriteriaMet', 'factRefs', 'gapCodes'], ['outcome', 'hardCriteriaMet', 'factRefs', 'gapCodes'], at, errors)
  const outcomes = new Set(['complete', 'partial', 'empty'])
  if (typeof value.outcome !== 'string' || !outcomes.has(value.outcome)) errors.push(`${at}.outcome: complete, partial, or empty required`)
  if (value.requestedCount !== undefined && !isCount(value.requestedCount)) errors.push(`${at}.requestedCount: non-negative integer required`)
  if (value.actualCount !== undefined && !isCount(value.actualCount)) errors.push(`${at}.actualCount: non-negative integer required`)
  if (typeof value.hardCriteriaMet !== 'boolean') errors.push(`${at}.hardCriteriaMet: boolean required`)
  if (!isStringArray(value.factRefs)) errors.push(`${at}.factRefs: opaque-ref array required`)
  if (!Array.isArray(value.gapCodes) || !value.gapCodes.every(isSafeCode)) errors.push(`${at}.gapCodes: safe identifier array required`)
}

export function validateActionReceiptV1(value: unknown): BookingSurfaceValidationResult {
  const errors = collectReceiptErrors(value, '$')
  if (receiptContainsUnsafeOpaqueText(value)) errors.push('$: receipt contains unsafe non-opaque text')
  if (!validateCanonicalReceipt(value)) {
    for (const error of validateCanonicalReceipt.errors ?? []) errors.push(canonicalError(error, '$'))
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors }
}

export function validateBookingCopilotIngressTurnV1(value: unknown): BookingSurfaceValidationResult {
  const errors: string[] = []
  if (!isRecord(value)) return { ok: false, errors: ['$: object required'] }
  exactKeys(value, [
    'schemaVersion', 'kind', 'taskId', 'contextRef', 'surfaceHint', 'workspace', 'request',
  ], ['schemaVersion', 'kind', 'surfaceHint', 'workspace', 'request'], '$', errors)
  if (value.schemaVersion !== 'booking.surface.v1') errors.push('$.schemaVersion: booking.surface.v1 required')
  if (value.kind !== 'user.turn.ingress') errors.push('$.kind: user.turn.ingress required')
  if (value.contextRef !== undefined && value.contextRef !== null) errors.push('$.contextRef: bootstrap may only omit it or send null')
  if (typeof value.surfaceHint !== 'string' || !SURFACES.has(value.surfaceHint)) errors.push('$.surfaceHint: unsupported surface hint')
  validateIngressWorkspace(value.workspace, '$.workspace', errors)
  if (!isRecord(value.request)) {
    errors.push('$.request: object required')
  } else {
    exactKeys(value.request, ['text'], ['text'], '$.request', errors)
    if (!isNonEmptyString(value.request.text)) errors.push('$.request.text: non-empty string required')
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors }
}

export function validateBookingCopilotTurnV1(value: unknown): BookingSurfaceValidationResult {
  const errors: string[] = []
  if (!isRecord(value)) return { ok: false, errors: ['$: object required'] }
  if (value.kind === 'user.turn') {
    exactKeys(value, ['schemaVersion', 'kind', 'taskId', 'workspace', 'request'], ['schemaVersion', 'kind', 'workspace', 'request'], '$', errors)
    if (!isRecord(value.request)) errors.push('$.request: object required')
    else {
      exactKeys(value.request, ['text'], ['text'], '$.request', errors)
      if (!isNonEmptyString(value.request.text)) errors.push('$.request.text: non-empty string required')
    }
  } else if (value.kind === 'action.receipt.continuation') {
    exactKeys(value, ['schemaVersion', 'kind', 'taskId', 'workspace', 'receipt'], ['schemaVersion', 'kind', 'taskId', 'workspace', 'receipt'], '$', errors)
    if (!isNonEmptyString(value.taskId)) errors.push('$.taskId: opaque ref required')
    errors.push(...collectReceiptErrors(value.receipt, '$.receipt'))
    const receiptValidation = validateActionReceiptV1(value.receipt)
    if (!receiptValidation.ok) errors.push(...receiptValidation.errors.map((error) => `$.receipt${error.slice(1)}`))
  } else {
    errors.push('$.kind: user.turn or action.receipt.continuation required')
  }
  if (value.schemaVersion !== 'booking.surface.v1') errors.push('$.schemaVersion: booking.surface.v1 required')
  validateWorkspace(value.workspace, '$.workspace', errors)
  if (value.kind === 'action.receipt.continuation' && isRecord(value.workspace) && isRecord(value.receipt)) {
    if (value.receipt.contextRef !== value.workspace.contextRef) errors.push('$.receipt.contextRef: must equal workspace.contextRef')
    if (value.receipt.revision !== value.workspace.revision) errors.push('$.receipt.revision: must equal workspace.revision')
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors }
}

export function validateBookingSurfaceEventV1(value: unknown): BookingSurfaceValidationResult {
  const errors: string[] = []
  if (!isRecord(value)) return { ok: false, errors: ['$: typed event object required'] }
  const common = ['schemaVersion', 'eventId', 'taskId', 'contextRef', 'sequence', 'emittedAt', 'kind'] as const
  const branchKeys: Record<string, string> = {
    status: 'status',
    question: 'question',
    operation: 'action',
    explanation: 'explanation',
    terminal: 'terminal',
    error: 'error',
  }
  const branchKey = typeof value.kind === 'string' ? branchKeys[value.kind] : undefined
  exactKeys(value, [...common, ...(branchKey ? [branchKey] : [])], [...common, ...(branchKey ? [branchKey] : [])], '$', errors)
  if (value.schemaVersion !== 'booking.surface.v1') errors.push('$.schemaVersion: booking.surface.v1 required')
  if (!isNonEmptyString(value.eventId)) errors.push('$.eventId: opaque ref required')
  if (!isNonEmptyString(value.taskId)) errors.push('$.taskId: opaque ref required')
  if (!isNonEmptyString(value.contextRef)) errors.push('$.contextRef: server-minted opaque ref required')
  if (!Number.isInteger(value.sequence) || Number(value.sequence) < 1) errors.push('$.sequence: positive integer required')
  if (!isNonEmptyString(value.emittedAt)) errors.push('$.emittedAt: timestamp required')
  if (typeof value.kind !== 'string' || !EVENT_KINDS.has(value.kind)) errors.push('$.kind: unregistered event kind')
  if (value.kind === 'status') {
    const statuses = new Set(['submitted', 'working', 'waiting_receipt', 'input_required'])
    if (typeof value.status !== 'string' || !statuses.has(value.status)) errors.push('$.status: unregistered task status')
  }
  if (value.kind === 'question') {
    if (!isRecord(value.question)) {
      errors.push('$.question: typed object required')
    } else {
      exactKeys(value.question, ['questionId', 'prompt', 'missingFields'], ['questionId', 'prompt', 'missingFields'], '$.question', errors)
      if (!isNonEmptyString(value.question.questionId)) errors.push('$.question.questionId: opaque ref required')
      if (!isNonEmptyString(value.question.prompt)) errors.push('$.question.prompt: non-empty string required')
      if (!isStringArray(value.question.missingFields)) errors.push('$.question.missingFields: string array required')
    }
  }
  if (value.kind === 'operation') errors.push(...collectBookingReadActionErrors(value.action, '$.action'))
  if (value.kind === 'explanation') {
    if (!isRecord(value.explanation)) {
      errors.push('$.explanation: typed object required')
    } else {
      exactKeys(value.explanation, ['text', 'factRefs'], ['text', 'factRefs'], '$.explanation', errors)
      if (!isNonEmptyString(value.explanation.text)) errors.push('$.explanation.text: non-empty string required')
      if (!isStringArray(value.explanation.factRefs)) errors.push('$.explanation.factRefs: opaque-ref array required')
    }
  }
  if (value.kind === 'terminal') {
    if (!isRecord(value.terminal)) {
      errors.push('$.terminal: typed object required')
    } else {
      exactKeys(value.terminal, ['status', 'summary', 'factRefs'], ['status', 'summary', 'factRefs'], '$.terminal', errors)
      const statuses = new Set(['completed', 'stopped'])
      if (typeof value.terminal.status !== 'string' || !statuses.has(value.terminal.status)) errors.push('$.terminal.status: completed or stopped required')
      if (!isNonEmptyString(value.terminal.summary)) errors.push('$.terminal.summary: non-empty string required')
      if (!isStringArray(value.terminal.factRefs)) errors.push('$.terminal.factRefs: opaque-ref array required')
    }
  }
  if (value.kind === 'error') {
    if (!isRecord(value.error)) {
      errors.push('$.error: typed object required')
    } else {
      exactKeys(value.error, ['code', 'message', 'retryable'], ['code', 'message', 'retryable'], '$.error', errors)
      if (!isNonEmptyString(value.error.code)) errors.push('$.error.code: non-empty string required')
      if (!isNonEmptyString(value.error.message)) errors.push('$.error.message: non-empty string required')
      if (typeof value.error.retryable !== 'boolean') errors.push('$.error.retryable: boolean required')
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors }
}

/**
 * The only executable event seam. It performs no text parsing: non-operation
 * events always return null even when their prose happens to look like JSON.
 */
export function bookingOperationFromEvent(value: unknown): BookingReadActionV1 | null {
  if (!isRecord(value) || value.kind !== 'operation') return null
  if (!validateBookingSurfaceEventV1(value).ok) return null
  return value.action as BookingReadActionV1
}

// Keep the public predicates assignable to their declared wire types.
void (null as unknown as BookingCopilotIngressTurnV1)
void (null as unknown as BookingCopilotTurnV1)
void (null as unknown as BookingReadActionV1)
void (null as unknown as ActionReceiptV1)
void (null as unknown as BookingSurfaceEventV1)
