import type { BookingReadActionKind } from './contracts.ts'

export const EMBEDDED_BOOKING_CAPABILITY_IDS = [
  'search-hotels',
  'refine-results',
  'find-room-offers',
  'compare-offers',
  'prepare-booking',
  'observe-booking',
] as const

export type EmbeddedBookingCapabilityId = (typeof EMBEDDED_BOOKING_CAPABILITY_IDS)[number]

export interface EmbeddedBookingCapability {
  id: EmbeddedBookingCapabilityId
  effect: 'read'
  actions: readonly BookingReadActionKind[]
}

export interface EmbeddedBookingProfile {
  id: 'embedded-booking'
  schemaVersion: 'booking.surface'
  capabilities: readonly EmbeddedBookingCapability[]
}

/** Closed registry. No booking/payment/write capability exists in this profile. */
export const embeddedBookingProfile = Object.freeze({
  id: 'embedded-booking',
  schemaVersion: 'booking.surface',
  capabilities: Object.freeze([
    Object.freeze({ id: 'search-hotels', effect: 'read', actions: Object.freeze(['search.patch', 'search.run']) }),
    Object.freeze({ id: 'refine-results', effect: 'read', actions: Object.freeze(['results.view.patch', 'hotel.focus', 'hotel.select']) }),
    Object.freeze({ id: 'find-room-offers', effect: 'read', actions: Object.freeze(['offers.query', 'offers.view.patch']) }),
    Object.freeze({ id: 'compare-offers', effect: 'read', actions: Object.freeze(['offers.compare', 'offer.select']) }),
    Object.freeze({ id: 'prepare-booking', effect: 'read', actions: Object.freeze(['offer.check', 'checkout.prepare']) }),
    Object.freeze({ id: 'observe-booking', effect: 'read', actions: Object.freeze(['order.observe']) }),
  ]),
}) as EmbeddedBookingProfile

export function actionsForEmbeddedCapability(id: EmbeddedBookingCapabilityId): readonly BookingReadActionKind[] {
  return embeddedBookingProfile.capabilities.find((capability) => capability.id === id)?.actions ?? []
}
