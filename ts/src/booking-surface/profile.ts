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

/**
 * One tool per action kind: the tool name itself selects the branch, so every
 * tool advertises a single concrete schema instead of a union. This registry is
 * the single authority for that mapping — the model never picks the branch, and
 * the runtime may take the kind from the tool when the model omits the
 * redundant `kind` field (hotel-be#35343).
 */
export const EMBEDDED_BOOKING_ACTION_TOOLS = [
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
] as const satisfies ReadonlyArray<readonly [string, BookingReadActionKind]>

const ACTION_KIND_BY_TOOL = new Map<string, BookingReadActionKind>(EMBEDDED_BOOKING_ACTION_TOOLS)

/** The action kind a registered tool stands for; undefined for the terminal tool. */
export function bookingActionKindForTool(toolName: string): BookingReadActionKind | undefined {
  return ACTION_KIND_BY_TOOL.get(toolName)
}

/**
 * The tool is the authority for the action kind, so a model that omits the
 * redundant `kind` field must not fail the whole turn: the runtime supplies
 * the kind the called tool stands for. An explicit `kind` is never overwritten
 * — a contradiction stays a contradiction and is rejected downstream
 * (hotel-be#35343).
 */
export function bookingToolCallWithKind(args: unknown, toolKind: BookingReadActionKind | undefined): unknown {
  if (toolKind === undefined) return args
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args
  const record = args as Record<string, unknown>
  if (record.kind !== undefined) return args
  const keys = Object.keys(record)
  const onlyInput = keys.length === 1 && keys[0] === 'input'
  const inputAndIntent = keys.length === 2 && keys.includes('input') && keys.includes('intent')
  if (!onlyInput && !inputAndIntent) return args
  return { kind: toolKind, ...record }
}
