/**
 * Canonical TypeScript contract for HotelByte's embedded Booking Copilot.
 *
 * Executable facts cross this boundary only as discriminated data. Human text
 * is limited to a user turn or an explanation and is never parsed as an action.
 */

export const BOOKING_SURFACE_SCHEMA_VERSION = 'booking.surface.v1' as const
/** SHA-256 of schemas/booking.surface.v1.schema.json; package proof pins drift. */
export const BOOKING_SURFACE_SCHEMA_SHA256 = 'd9c2194ec839bd1168e70e8a201581addc005039d9b299660e20650bbb65df81' as const
export const BOOKING_SURFACE_VERSION_HEADER = 'x-booking-surface-version' as const
export const BOOKING_SURFACE_SCHEMA_SHA256_HEADER = 'x-booking-surface-schema-sha256' as const

export const BOOKING_SURFACES = [
  'tenant',
  'customer_portal',
  'storefront',
  'payment_link',
] as const
export type BookingSurfaceV1 = (typeof BOOKING_SURFACES)[number]

export const BOOKING_READ_ACTION_KINDS = [
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
] as const
export type BookingReadActionKindV1 = (typeof BOOKING_READ_ACTION_KINDS)[number]

export const BOOKING_RECEIPT_STATUSES = [
  'applied',
  'needs_input',
  'partial',
  'no_match',
  'unavailable',
  'changed',
  'stale',
  'unsupported',
  'failed',
] as const
export type ActionReceiptStatusV1 = (typeof BOOKING_RECEIPT_STATUSES)[number]

export const BOOKING_SURFACE_EVENT_KINDS = [
  'status',
  'question',
  'operation',
  'explanation',
  'terminal',
  'error',
] as const
export type BookingSurfaceEventKindV1 = (typeof BOOKING_SURFACE_EVENT_KINDS)[number]

export type ContextRefV1 = string
export type FactRefV1 = string
export type HotelRefV1 = string
export type OfferRefV1 = string
export type VerifiedOfferRefV1 = string
export type OrderRefV1 = string

export type CriterionStrengthV1 = 'must' | 'prefer'
export interface CriterionV1<T> {
  strength: CriterionStrengthV1
  value: T
}

export interface MoneyV1 {
  /** Decimal string supplied by the authoritative page object; never recomputed by GoTry. */
  amount: string
  currency: string
  sourceFactRef: FactRefV1
}

export interface OccupancyRoomV1 {
  adults: number
  childAges: number[]
}

export interface SearchCriteriaPatchV1 {
  destination?: {
    query?: string
    placeRef?: string
  }
  hotel?: CriterionV1<{
    name?: string
    hotelRef?: HotelRefV1
  }>
  stay?: {
    checkIn?: string
    checkOut?: string
  }
  occupancy?: {
    rooms: OccupancyRoomV1[]
  }
  budget?: CriterionV1<{
    min?: MoneyV1
    max?: MoneyV1
  }>
  starRating?: CriterionV1<{
    min?: number
    max?: number
  }>
  guestRating?: CriterionV1<{
    min: number
  }>
  facilities?: CriterionV1<{
    allOf: string[]
  }>
  distance?: CriterionV1<{
    anchorLabel?: string
    anchorRef?: string
    maxKm: number
  }>
}

export type ResultSortV1 =
  | 'recommended'
  | 'price_asc'
  | 'price_desc'
  | 'rating_desc'
  | 'distance_asc'

export interface ResultsViewPatchV1 {
  starRating?: { min?: number; max?: number } | null
  guestRatingMin?: number | null
  facilitiesAllOf?: string[] | null
  distance?: { anchorRef: string; maxKm: number } | null
  price?: { min?: MoneyV1; max?: MoneyV1 } | null
  sort?: ResultSortV1
}

export interface OfferCriteriaV1 {
  roomType?: CriterionV1<string[]>
  bedType?: CriterionV1<string[]>
  meals?: CriterionV1<string[]>
  freeCancellation?: CriterionV1<boolean>
  freeCancellationUntil?: CriterionV1<string>
  totalPriceMax?: CriterionV1<MoneyV1>
  roomsAvailableMin?: CriterionV1<number>
  payAtProperty?: CriterionV1<boolean>
  mobileRate?: CriterionV1<boolean>
  targetCount?: number
  sort?: 'best_match' | 'total_price_asc' | 'cancellation_latest'
}

export type EvidenceLevelV1 = 'listed' | 'rate_loaded' | 'checked'

export interface SurfaceCapabilitiesV1 {
  surface: BookingSurfaceV1
  allowedActions: BookingReadActionKindV1[]
}

export interface SearchDraftSnapshotV1 {
  destination?: { query?: string; placeRef?: string }
  stay?: { checkIn?: string; checkOut?: string }
  occupancy?: { rooms: OccupancyRoomV1[] }
  criteria?: SearchCriteriaPatchV1
}

export interface ResultViewSnapshotV1 {
  status: 'idle' | 'loading' | 'ready' | 'partial' | 'failed'
  filters?: ResultsViewPatchV1
  sort?: ResultSortV1
  resultCount?: number
  searchSessionRef?: string
}

export interface VisibleHotelFactV1 {
  hotelRef: HotelRefV1
  name: string
  starRating?: number
  guestRating?: number
  distanceKm?: number
  facilityCodes?: string[]
  factRefs: FactRefV1[]
}

export interface LoadedOfferFactV1 {
  offerRef: OfferRefV1
  hotelRef: HotelRefV1
  evidenceLevel: EvidenceLevelV1
  factRefs: FactRefV1[]
}

export interface BookingWorkspaceSnapshotV1 {
  schemaVersion: typeof BOOKING_SURFACE_SCHEMA_VERSION
  contextRef: ContextRefV1
  surface: BookingSurfaceV1
  revision: number
  locale: string
  currency: string
  searchDraft: SearchDraftSnapshotV1
  results: ResultViewSnapshotV1
  visibleHotels: VisibleHotelFactV1[]
  loadedOffers: LoadedOfferFactV1[]
  focusedHotelRef?: HotelRefV1
  shortlistedOfferRefs: OfferRefV1[]
  selectedOfferRef?: OfferRefV1
  verifiedOfferRef?: VerifiedOfferRefV1
  capabilities: SurfaceCapabilitiesV1
}

/**
 * Browser bootstrap snapshot before the same-origin BFF binds an actor and
 * mints contextRef/capabilities. It deliberately cannot assert any identity or
 * capability field.
 */
export type BookingWorkspaceIngressSnapshotV1 = Omit<
  BookingWorkspaceSnapshotV1,
  'contextRef' | 'surface' | 'capabilities'
>

interface BookingReadActionBaseV1<K extends BookingReadActionKindV1, I> {
  schemaVersion: typeof BOOKING_SURFACE_SCHEMA_VERSION
  kind: K
  actionId: string
  contextRef: ContextRefV1
  expectedRevision: number
  reason: string
  factRefs: FactRefV1[]
  input: I
}

export type SearchPatchActionV1 = BookingReadActionBaseV1<'search.patch', { patch: SearchCriteriaPatchV1 }>
export type SearchRunActionV1 = BookingReadActionBaseV1<'search.run', Record<string, never>>
export type ResultsViewPatchActionV1 = BookingReadActionBaseV1<'results.view.patch', { patch: ResultsViewPatchV1 }>
export type HotelFocusActionV1 = BookingReadActionBaseV1<'hotel.focus', { hotelRef: HotelRefV1 }>
export type HotelSelectActionV1 = BookingReadActionBaseV1<'hotel.select', { hotelRef: HotelRefV1 }>
export type OffersQueryActionV1 = BookingReadActionBaseV1<'offers.query', { hotelRefs: HotelRefV1[]; criteria: OfferCriteriaV1 }>
export type OffersViewPatchActionV1 = BookingReadActionBaseV1<'offers.view.patch', { hotelRef: HotelRefV1; criteria: OfferCriteriaV1 }>
export type OffersCompareActionV1 = BookingReadActionBaseV1<'offers.compare', { offerRefs: OfferRefV1[]; requestedCount: number }>
export type OfferSelectActionV1 = BookingReadActionBaseV1<'offer.select', { offerRef: OfferRefV1 }>
export type OfferCheckActionV1 = BookingReadActionBaseV1<'offer.check', { offerRef: OfferRefV1 }>
export type CheckoutPrepareActionV1 = BookingReadActionBaseV1<'checkout.prepare', { offerRef: OfferRefV1; verifiedOfferRef: VerifiedOfferRefV1 }>
export type OrderObserveActionV1 = BookingReadActionBaseV1<'order.observe', { orderRef: OrderRefV1 }>

export type BookingReadActionV1 =
  | SearchPatchActionV1
  | SearchRunActionV1
  | ResultsViewPatchActionV1
  | HotelFocusActionV1
  | HotelSelectActionV1
  | OffersQueryActionV1
  | OffersViewPatchActionV1
  | OffersCompareActionV1
  | OfferSelectActionV1
  | OfferCheckActionV1
  | CheckoutPrepareActionV1
  | OrderObserveActionV1

export type ActionObservationV1 =
  | { kind: 'search.state'; searchSessionRef?: string; resultCount?: number }
  | { kind: 'results.state'; matchedHotelRefs: HotelRefV1[]; visibleCount: number }
  | { kind: 'hotel.focus'; hotelRef: HotelRefV1 }
  | { kind: 'hotel.selection'; hotelRef: HotelRefV1 }
  | { kind: 'offers.state'; hotelRefs: HotelRefV1[]; offerRefs: OfferRefV1[]; loadedHotelCount: number }
  | { kind: 'offer.selection'; offerRef: OfferRefV1 }
  | { kind: 'offer.availability'; offerRef: OfferRefV1; verifiedOfferRef?: VerifiedOfferRefV1; available: boolean; changedFactRefs: FactRefV1[] }
  | { kind: 'checkout.handoff'; offerRef: OfferRefV1; verifiedOfferRef: VerifiedOfferRefV1; handoffRef: string }
  | { kind: 'order.state'; orderRef: OrderRefV1; state: 'pending' | 'verified' | 'failed' | 'unknown' }
  | { kind: 'gap'; code: string; factRefs: FactRefV1[] }

export interface ResultContractV1 {
  outcome: 'complete' | 'partial' | 'empty'
  requestedCount?: number
  actualCount?: number
  hardCriteriaMet: boolean
  factRefs: FactRefV1[]
  gapCodes: string[]
}

export interface ActionReceiptV1 {
  schemaVersion: typeof BOOKING_SURFACE_SCHEMA_VERSION
  kind: 'action.receipt'
  actionId: string
  contextRef: ContextRefV1
  status: ActionReceiptStatusV1
  revision: number
  observation: ActionObservationV1
  resultContract: ResultContractV1
  undoToken?: string
}

export interface UserTurnV1 {
  schemaVersion: typeof BOOKING_SURFACE_SCHEMA_VERSION
  kind: 'user.turn'
  taskId?: string
  workspace: BookingWorkspaceSnapshotV1
  request: {
    /** Transport-only natural language. It must never be persisted as executable state. */
    text: string
  }
}

export interface BookingCopilotIngressTurnV1 {
  schemaVersion: typeof BOOKING_SURFACE_SCHEMA_VERSION
  kind: 'user.turn.ingress'
  taskId?: string
  /** Bootstrap may omit this field or send null. A browser cannot mint it. */
  contextRef?: null
  surfaceHint: BookingSurfaceV1
  workspace: BookingWorkspaceIngressSnapshotV1
  request: {
    text: string
  }
}

export interface ActionReceiptContinuationV1 {
  schemaVersion: typeof BOOKING_SURFACE_SCHEMA_VERSION
  kind: 'action.receipt.continuation'
  taskId: string
  workspace: BookingWorkspaceSnapshotV1
  receipt: ActionReceiptV1
}

export type BookingCopilotTurnV1 = UserTurnV1 | ActionReceiptContinuationV1

interface BookingSurfaceEventBaseV1<K extends BookingSurfaceEventKindV1> {
  schemaVersion: typeof BOOKING_SURFACE_SCHEMA_VERSION
  eventId: string
  taskId: string
  contextRef: ContextRefV1
  sequence: number
  emittedAt: string
  kind: K
}

export type BookingStatusEventV1 = BookingSurfaceEventBaseV1<'status'> & {
  status: 'submitted' | 'working' | 'waiting_receipt' | 'input_required'
}

export type BookingQuestionEventV1 = BookingSurfaceEventBaseV1<'question'> & {
  question: {
    questionId: string
    prompt: string
    missingFields: string[]
  }
}

export type BookingOperationEventV1 = BookingSurfaceEventBaseV1<'operation'> & {
  action: BookingReadActionV1
}

export type BookingExplanationEventV1 = BookingSurfaceEventBaseV1<'explanation'> & {
  explanation: {
    text: string
    factRefs: FactRefV1[]
  }
}

export type BookingTerminalEventV1 = BookingSurfaceEventBaseV1<'terminal'> & {
  terminal: {
    status: 'completed' | 'stopped'
    summary: string
    factRefs: FactRefV1[]
  }
}

export type BookingErrorEventV1 = BookingSurfaceEventBaseV1<'error'> & {
  error: {
    code: string
    message: string
    retryable: boolean
  }
}

export type BookingSurfaceEventV1 =
  | BookingStatusEventV1
  | BookingQuestionEventV1
  | BookingOperationEventV1
  | BookingExplanationEventV1
  | BookingTerminalEventV1
  | BookingErrorEventV1
