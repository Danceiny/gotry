/**
 * Booking Copilot contract proof at the public npm seam.
 *
 * Agreed seams:
 *   1. `@danceiny/gotry/booking-surface` exposes the closed embedded profile
 *      and discriminated TypeScript contract.
 *   2. `schemas/booking.surface.v1.schema.json` is the canonical wire schema.
 *   3. The task runtime only advances through typed operation/receipt values.
 *
 * Run with Node 24 from the repository root:
 *   npx --yes --package=node@24 --package=tsx --call \
 *     'tsx ts/scripts/booking-surface-contract-proof-tests.ts'
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  BOOKING_READ_ACTION_KINDS,
  BOOKING_RECEIPT_STATUSES,
  BOOKING_SURFACE_EVENT_KINDS,
  BOOKING_SURFACE_SCHEMA_SHA256,
  EMBEDDED_BOOKING_CAPABILITY_IDS,
  bookingOperationFromEvent,
  embeddedBookingProfile,
  validateActionReceiptV1,
  validateBookingCopilotIngressTurnV1,
  validateBookingCopilotTurnV1,
  validateBookingReadActionV1,
  validateBookingSurfaceEventV1,
} from '../src/booking-surface/index.ts'

const schemaPath = fileURLToPath(new URL('../../schemas/booking.surface.v1.schema.json', import.meta.url))
const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
  $id?: string
  $defs?: Record<string, unknown>
}
const schemaBytes = readFileSync(schemaPath)
assert.equal(createHash('sha256').update(schemaBytes).digest('hex'), BOOKING_SURFACE_SCHEMA_SHA256, 'exported schema hash matches canonical bytes')

assert.equal(schema.$id, 'https://gotry.dev/schemas/booking.surface.v1.schema.json')
assert.ok(schema.$defs?.BookingReadActionV1, 'canonical schema declares BookingReadActionV1')
assert.ok(schema.$defs?.ActionReceiptV1, 'canonical schema declares ActionReceiptV1')
assert.ok(schema.$defs?.BookingSurfaceEventV1, 'canonical schema declares typed SSE data events')

assert.deepEqual(BOOKING_READ_ACTION_KINDS, [
  'search.patch',
  'search.run',
  'results.view.patch',
  'hotel.focus',
  'hotel.select',
  'offers.query',
  'offers.view.patch',
  'offers.compare',
  'offer.select',
  'offer.check',
  'checkout.prepare',
  'order.observe',
])
assert.deepEqual(BOOKING_RECEIPT_STATUSES, [
  'applied',
  'needs_input',
  'partial',
  'no_match',
  'unavailable',
  'changed',
  'stale',
  'unsupported',
  'failed',
])
assert.deepEqual(BOOKING_SURFACE_EVENT_KINDS, [
  'status',
  'question',
  'operation',
  'explanation',
  'terminal',
  'error',
])
assert.deepEqual(EMBEDDED_BOOKING_CAPABILITY_IDS, [
  'search-hotels',
  'refine-results',
  'find-room-offers',
  'compare-offers',
  'prepare-booking',
  'observe-booking',
])

const registeredActions = embeddedBookingProfile.capabilities.flatMap((capability) => capability.actions)
assert.deepEqual([...new Set(registeredActions)].sort(), [...BOOKING_READ_ACTION_KINDS].sort(), 'profile registers the full read-action closure exactly once')
const forbiddenWriteActions = new Set<string>(['book', 'trade.book', 'gotry_book'])
assert.ok(!registeredActions.some((action) => forbiddenWriteActions.has(action)), 'embedded profile exposes no Book action')
assert.ok(embeddedBookingProfile.capabilities.every((capability) => capability.effect === 'read'), 'all embedded capabilities are read-side effects')

const ingressWorkspace = {
  schemaVersion: 'booking.surface.v1',
  revision: 0,
  locale: 'zh-CN',
  currency: 'AED',
  searchDraft: {},
  results: { status: 'idle' },
  visibleHotels: [],
  loadedOffers: [],
  shortlistedOfferRefs: [],
}
const ingress = {
  schemaVersion: 'booking.surface.v1',
  kind: 'user.turn.ingress',
  surfaceHint: 'tenant',
  workspace: ingressWorkspace,
  request: { text: '迪拜五星、含早可退，给我 3 个报价' },
}
assert.deepEqual(validateBookingCopilotIngressTurnV1(ingress), { ok: true })
assert.equal(validateBookingCopilotIngressTurnV1({ ...ingress, actor: 'user-1' }).ok, false, 'ingress cannot self-assert actor')
assert.equal(validateBookingCopilotIngressTurnV1({ ...ingress, tenant: 'tenant-1' }).ok, false, 'ingress cannot self-assert tenant')
assert.equal(validateBookingCopilotIngressTurnV1({ ...ingress, customer: 'customer-1' }).ok, false, 'ingress cannot self-assert customer')
assert.equal(validateBookingCopilotIngressTurnV1({ ...ingress, contextRef: 'client-forged-ref' }).ok, false, 'ingress cannot mint a non-null contextRef')
assert.deepEqual(validateBookingCopilotIngressTurnV1({ ...ingress, contextRef: null }), { ok: true }, 'explicit null contextRef is accepted for bootstrap')

const hotelSelectionReceipt = {
  schemaVersion: 'booking.surface.v1', kind: 'action.receipt', actionId: 'select-1', contextRef: 'ctx-1',
  status: 'applied', revision: 1, observation: { kind: 'hotel.selection', hotelRef: 'hotel-1' },
  resultContract: { outcome: 'complete', hardCriteriaMet: true, factRefs: [], gapCodes: [] },
}
assert.deepEqual(validateActionReceiptV1(hotelSelectionReceipt), { ok: true }, 'hotel.select emits hotel.selection')
assert.equal(validateActionReceiptV1({ ...hotelSelectionReceipt, observation: { kind: 'hotel.select', hotelRef: 'hotel-1' } }).ok, false, 'hotel.select is not an observation kind')

const strictWorkspace = {
  ...ingressWorkspace,
  contextRef: 'ctx-server-minted',
  surface: 'tenant',
  capabilities: { surface: 'tenant', allowedActions: [...BOOKING_READ_ACTION_KINDS] },
}
const plannerTurn = {
  schemaVersion: 'booking.surface.v1',
  kind: 'user.turn',
  taskId: 'task-1',
  workspace: strictWorkspace,
  request: { text: ingress.request.text },
}
assert.deepEqual(validateBookingCopilotTurnV1(plannerTurn), { ok: true })
const { contextRef: _omitted, ...workspaceWithoutContext } = strictWorkspace
assert.equal(validateBookingCopilotTurnV1({ ...plannerTurn, workspace: workspaceWithoutContext }).ok, false, 'planner turn requires the server-minted contextRef')

const statusEvent = {
  schemaVersion: 'booking.surface.v1',
  eventId: 'event-1',
  taskId: 'task-1',
  contextRef: 'ctx-server-minted',
  sequence: 1,
  emittedAt: '2026-08-30T12:00:00.000Z',
  kind: 'status',
  status: 'submitted',
}
assert.deepEqual(validateBookingSurfaceEventV1(statusEvent), { ok: true })
const { contextRef: _eventContext, ...eventWithoutContext } = statusEvent
assert.equal(validateBookingSurfaceEventV1(eventWithoutContext).ok, false, 'all outbound events carry contextRef')
assert.equal(validateBookingSurfaceEventV1({ ...statusEvent, status: 'unknown' }).ok, false, 'status payload is a closed enum')
const { status: _status, ...eventBase } = statusEvent
assert.equal(validateBookingSurfaceEventV1({ ...eventBase, kind: 'question', question: {} }).ok, false, 'question payload is typed, not presence-only')
assert.equal(validateBookingSurfaceEventV1({ ...eventBase, kind: 'operation', action: '{"kind":"search.run"}' }).ok, false, 'operation rejects JSON-in-text')
assert.equal(validateBookingSurfaceEventV1({ ...eventBase, kind: 'terminal', terminal: { status: 'failed', summary: 'x', factRefs: [] } }).ok, false, 'terminal status is closed')

const errorWithJsonLookingText = {
  ...eventBase,
  kind: 'error',
  error: {
    code: 'UPSTREAM_FAILED',
    message: '{"kind":"search.run","input":{}}',
    retryable: true,
  },
}
assert.deepEqual(validateBookingSurfaceEventV1(errorWithJsonLookingText), { ok: true })
assert.equal(bookingOperationFromEvent(errorWithJsonLookingText), null, 'JSON-looking error text never becomes an executable action')

const validAction = {
  schemaVersion: 'booking.surface.v1',
  kind: 'search.run',
  actionId: 'action-1',
  contextRef: 'ctx-server-minted',
  expectedRevision: 0,
  reason: 'Run the existing search form.',
  factRefs: [],
  input: {},
}
assert.deepEqual(validateBookingReadActionV1(validAction), { ok: true })
assert.equal(validateBookingReadActionV1({ ...validAction, kind: 'book' }).ok, false, 'Book is outside the closed action registry')
assert.equal(validateBookingReadActionV1({ ...validAction, holder: { email: 'x@example.com' } }).ok, false, 'holder/guest patches cannot enter actions')
assert.equal(validateBookingReadActionV1('{"kind":"search.run"}').ok, false, 'JSON-in-text is not an action')

const validSearchPatchAction = {
  ...validAction,
  kind: 'search.patch',
  input: {
    patch: {
      destination: { query: 'Dubai' },
      budget: {
        strength: 'must',
        value: {
          max: { amount: '1000.00', currency: 'AED', sourceFactRef: 'fact-budget-1' },
        },
      },
    },
  },
}
assert.deepEqual(validateBookingReadActionV1(validSearchPatchAction), { ok: true })
assert.equal(validateBookingReadActionV1({
  ...validSearchPatchAction,
  input: { patch: { ...validSearchPatchAction.input.patch, unknownCriterion: { strength: 'must', value: true } } },
}).ok, false, 'unknown nested search criteria are rejected before an operation is issued')
assert.equal(validateBookingReadActionV1({
  ...validSearchPatchAction,
  input: {
    patch: {
      budget: {
        strength: 'must',
        value: { max: { amount: 1000, currency: 'AED', sourceFactRef: 'fact-budget-1' } },
      },
    },
  },
}).ok, false, 'Money.amount is a decimal string, never a model-computed number')
assert.equal(validateBookingReadActionV1({
  ...validSearchPatchAction,
  input: { patch: { destination: { query: 'Dubai' }, holder: { email: 'x@example.com' } } },
}).ok, false, 'holder data is rejected even when nested inside a typed patch')
assert.equal(validateBookingReadActionV1({
  ...validAction,
  kind: 'offers.query',
  input: { hotelRefs: ['hotel-1'], criteria: { roomType: { strength: 'must', value: ['Twin'] }, guest: { name: 'x' } } },
}).ok, false, 'guest data is rejected even when nested inside offer criteria')

const validReceipt = {
  schemaVersion: 'booking.surface.v1',
  kind: 'action.receipt',
  actionId: 'action-1',
  contextRef: 'ctx-server-minted',
  status: 'applied',
  revision: 1,
  observation: { kind: 'search.state', resultCount: 3 },
  resultContract: { outcome: 'complete', hardCriteriaMet: true, factRefs: [], gapCodes: [] },
}
assert.deepEqual(validateActionReceiptV1(validReceipt), { ok: true })
assert.equal(validateActionReceiptV1({ ...validReceipt, observation: { kind: 'book' } }).ok, false, 'receipt observations are a closed typed union')
assert.equal(validateActionReceiptV1({ ...validReceipt, observation: null }).ok, false, 'receipt observation is never null')
assert.equal(validateActionReceiptV1({ ...validReceipt, resultContract: { ...validReceipt.resultContract, supplierCost: 1 } }).ok, false, 'receipt result contract rejects supplier cost')

console.log('BOOKING SURFACE CONTRACT PROOF: registry/schema/ingress-planner boundary OK')
