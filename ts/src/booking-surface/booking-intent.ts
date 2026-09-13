import type { BookingReadActionKind, OfferCriteria } from './contracts.ts'

export const BOOKING_INTENT_SCHEMA_VERSION = 'booking.intent.v1' as const
export const BOOKING_INTENT_TARGETS = [
  'search.results',
  'results.refined',
  'hotel.focused',
  'hotel.selected',
  'offers.loaded',
  'offers.refined',
  'offers.compared',
  'offer.selected',
  'offer.verified',
  'checkout.prepared',
  'order.observed',
] as const

export type BookingIntentTarget = typeof BOOKING_INTENT_TARGETS[number]

type BookingIntentTargetWithOfferCriteria =
  | 'offers.loaded'
  | 'offers.refined'
  | 'offers.compared'
  | 'offer.selected'
  | 'offer.verified'
  | 'checkout.prepared'
type BookingIntentTargetWithoutOfferCriteria = Exclude<BookingIntentTarget, BookingIntentTargetWithOfferCriteria>

/** Ordered read path; an intent target may not be overshot by its action. */
export const BOOKING_INTENT_ACTION_ORDINAL: Record<BookingReadActionKind, number> = {
  'search.patch': 0,
  'search.run': 1,
  'results.view.patch': 2,
  'hotel.focus': 3,
  'hotel.select': 4,
  'offers.query': 5,
  'offers.view.patch': 6,
  'offers.compare': 7,
  'offer.select': 8,
  'offer.check': 9,
  'checkout.prepare': 10,
  'order.observe': 11,
}

export const BOOKING_INTENT_TARGET_ACTION: Record<BookingIntentTarget, BookingReadActionKind> = {
  'search.results': 'search.run',
  'results.refined': 'results.view.patch',
  'hotel.focused': 'hotel.focus',
  'hotel.selected': 'hotel.select',
  'offers.loaded': 'offers.query',
  'offers.refined': 'offers.view.patch',
  'offers.compared': 'offers.compare',
  'offer.selected': 'offer.select',
  'offer.verified': 'offer.check',
  'checkout.prepared': 'checkout.prepare',
  'order.observed': 'order.observe',
}

export const BOOKING_INTENT_TARGET_ORDINAL: Record<BookingIntentTarget, number> = Object.fromEntries(
  Object.entries(BOOKING_INTENT_TARGET_ACTION).map(([target, action]) => [target, BOOKING_INTENT_ACTION_ORDINAL[action as BookingReadActionKind]]),
) as Record<BookingIntentTarget, number>

/** PII-safe semantic goal retained across short-lived model processes. */
export interface BookingIntentProjection {
  schemaVersion: typeof BOOKING_INTENT_SCHEMA_VERSION
  target: BookingIntentTarget
  offerCriteria?: OfferCriteria
}

/** Runtime-owned provenance binding persisted atomically with each action. */
export interface BookingIntentCheckpoint {
  taskId: string
  contextRef: string
  sourceTurnId: string
  sourceRequestDigest: string
  projection: BookingIntentProjection
  intentDigest: string
}

export type BookingIntentProposal = {
  target: BookingIntentTargetWithoutOfferCriteria
  offerCriteria?: never
} | {
  target: BookingIntentTargetWithOfferCriteria
  offerCriteria?: OfferCriteria
}
