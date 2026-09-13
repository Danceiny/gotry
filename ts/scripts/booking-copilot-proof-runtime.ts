/**
 * Legacy regression-test adapter.
 *
 * Production callers must pass an explicit final-waypoint intent to
 * BookingCopilotTaskRuntime.issueOperation. Older low-level tests predate that
 * boundary and exercise unrelated ledger/availability behavior, so this
 * adapter repeats an existing durable intent or supplies a local single-step
 * fixture intent. New intent-boundary tests use the production runtime class.
 */
import {
  BookingCopilotTaskRuntime as StrictBookingCopilotTaskRuntime,
} from '../src/booking-surface/runtime.ts'
import type { BookingReadAction } from '../src/booking-surface/contracts.ts'
import type { BookingIntentProjection, BookingIntentTarget } from '../src/booking-surface/booking-intent.ts'

const ACTION_TARGET: Record<BookingReadAction['kind'], BookingIntentTarget> = {
  'search.patch': 'search.results',
  'search.run': 'search.results',
  'results.view.patch': 'results.refined',
  'hotel.focus': 'hotel.focused',
  'hotel.select': 'hotel.selected',
  'offers.query': 'offers.loaded',
  'offers.view.patch': 'offers.refined',
  'offers.compare': 'offers.compared',
  'offer.select': 'offer.selected',
  'offer.check': 'offer.verified',
  'checkout.prepare': 'checkout.prepared',
  'order.observe': 'order.observed',
}

function singleStepFixtureIntent(action: BookingReadAction): BookingIntentProjection {
  const offerCriteria = action.kind === 'offers.query' || action.kind === 'offers.view.patch'
    ? action.input.criteria
    : action.kind === 'offers.compare'
      ? { targetCount: action.input.requestedCount }
      : undefined
  return {
    schemaVersion: 'booking.intent.v1',
    target: ACTION_TARGET[action.kind],
    ...(offerCriteria ? { offerCriteria } : {}),
  }
}

export class BookingCopilotProofRuntime extends StrictBookingCopilotTaskRuntime {
  issueOperation(taskId: string, action: BookingReadAction, intent?: BookingIntentProjection) {
    const durable = this.resumeTask(taskId)?.activeIntent?.projection
    return super.issueOperation(taskId, action, intent ?? durable ?? singleStepFixtureIntent(action))
  }
}
