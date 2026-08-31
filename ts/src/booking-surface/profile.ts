import type { BookingReadActionKindV1 } from './contracts.ts'

export const EMBEDDED_BOOKING_CAPABILITY_IDS = [
  'search-hotels',
  'refine-results',
  'find-room-offers',
  'compare-offers',
  'prepare-booking',
  'observe-booking',
] as const

export type EmbeddedBookingCapabilityIdV1 = (typeof EMBEDDED_BOOKING_CAPABILITY_IDS)[number]

export interface EmbeddedBookingCapabilityV1 {
  id: EmbeddedBookingCapabilityIdV1
  effect: 'read'
  actions: readonly BookingReadActionKindV1[]
}

export interface EmbeddedBookingProfileV1 {
  id: 'embedded-booking'
  schemaVersion: 'booking.surface.v1'
  capabilities: readonly EmbeddedBookingCapabilityV1[]
}

/** Closed registry. No booking/payment/write capability exists in this profile. */
export const embeddedBookingProfile = Object.freeze({
  id: 'embedded-booking',
  schemaVersion: 'booking.surface.v1',
  capabilities: Object.freeze([
    Object.freeze({ id: 'search-hotels', effect: 'read', actions: Object.freeze(['search.patch', 'search.run']) }),
    Object.freeze({ id: 'refine-results', effect: 'read', actions: Object.freeze(['results.view.patch', 'hotel.focus', 'hotel.select']) }),
    Object.freeze({ id: 'find-room-offers', effect: 'read', actions: Object.freeze(['offers.query', 'offers.view.patch']) }),
    Object.freeze({ id: 'compare-offers', effect: 'read', actions: Object.freeze(['offers.compare', 'offer.select']) }),
    Object.freeze({ id: 'prepare-booking', effect: 'read', actions: Object.freeze(['offer.check', 'checkout.prepare']) }),
    Object.freeze({ id: 'observe-booking', effect: 'read', actions: Object.freeze(['order.observe']) }),
  ]),
}) as EmbeddedBookingProfileV1

export function actionsForEmbeddedCapability(id: EmbeddedBookingCapabilityIdV1): readonly BookingReadActionKindV1[] {
  return embeddedBookingProfile.capabilities.find((capability) => capability.id === id)?.actions ?? []
}
