/**
 * Cross-repository proof for the Portal sequential HotelRates gap contract.
 *
 * The Portal keeps the hotel identity in opaque factRefs while emitting only
 * fixed safe identifiers in resultContract.gapCodes. This proof calls the
 * actual GoTry receipt validator so a dynamic legacy code cannot cross the
 * contract boundary.
 *
 * Run from the repository root with Node 24:
 *   npx tsx ts/scripts/booking-copilot-gap-code-contract-proof-tests.ts
 */

import assert from 'node:assert/strict'
import { validateActionReceiptV1 } from '../src/booking-surface/validation.ts'

const receiptBase = {
  schemaVersion: 'booking.surface.v1',
  kind: 'action.receipt',
  actionId: 'offers-query-gap-contract',
  contextRef: 'ctx-gap-contract',
  revision: 1,
}

const ratesFailedResult = {
  outcome: 'partial',
  requestedCount: 1,
  actualCount: 1,
  hardCriteriaMet: true,
  factRefs: ['hotel:hotel-1', 'hotel:hotel-2', 'offer:breakfast'],
}

const ratesFailedObservation = {
  kind: 'offers.state',
  hotelRefs: ['hotel-2'],
  offerRefs: ['breakfast'],
  loadedHotelCount: 1,
}

const oldRatesFailedReceipt = {
  ...receiptBase,
  status: 'partial',
  observation: ratesFailedObservation,
  resultContract: { ...ratesFailedResult, gapCodes: ['hotel_rates_failed:hotel-1'] },
}
const newRatesFailedReceipt = {
  ...oldRatesFailedReceipt,
  resultContract: { ...ratesFailedResult, gapCodes: ['hotel_rates_failed'] },
}

assert.equal(validateActionReceiptV1(oldRatesFailedReceipt).ok, false, 'legacy dynamic supplier gap code must fail validation')
assert.deepEqual(validateActionReceiptV1(newRatesFailedReceipt), { ok: true }, 'fixed supplier gap code with hotel fact ref must validate')
assert.deepEqual(newRatesFailedReceipt.resultContract.factRefs, ['hotel:hotel-1', 'hotel:hotel-2', 'offer:breakfast'])

const oldNotVisibleReceipt = {
  ...receiptBase,
  actionId: 'offers-query-hidden-hotel-gap-contract',
  status: 'no_match',
  observation: { kind: 'offers.state', hotelRefs: [], offerRefs: [], loadedHotelCount: 0 },
  resultContract: {
    outcome: 'empty',
    requestedCount: 1,
    actualCount: 0,
    hardCriteriaMet: false,
    factRefs: ['hotel:not-visible'],
    gapCodes: ['hotel_not_visible:not-visible'],
  },
}
const newNotVisibleReceipt = {
  ...oldNotVisibleReceipt,
  resultContract: { ...oldNotVisibleReceipt.resultContract, gapCodes: ['hotel_not_visible'] },
}

assert.equal(validateActionReceiptV1(oldNotVisibleReceipt).ok, false, 'legacy dynamic visibility gap code must fail validation')
assert.deepEqual(validateActionReceiptV1(newNotVisibleReceipt), { ok: true }, 'fixed visibility gap code with hotel fact ref must validate')
assert.deepEqual(newNotVisibleReceipt.resultContract.factRefs, ['hotel:not-visible'])

console.log('BOOKING COPILOT GAP CODE CONTRACT PROOF: dynamic legacy gap codes fail; fixed codes with hotel factRefs pass')
