/**
 * Canonical TypeScript contract for HotelByte's embedded Booking Copilot.
 *
 * Executable facts cross this boundary only as discriminated data. Human text
 * is limited to a user turn or an explanation and is never parsed as an action.
 */

export const BOOKING_SURFACE_SCHEMA_VERSION = 'booking.surface' as const
/** SHA-256 of schemas/booking.surface.schema.json; package proof pins drift. */
export const BOOKING_SURFACE_SCHEMA_SHA256 = '29b2bf11abae6487ac32d9c3fc258ccc77e47639ec25b4137d33b253d4ff7375' as const
export const BOOKING_SURFACE_VERSION_HEADER = 'x-booking-surface-version' as const
export const BOOKING_SURFACE_SCHEMA_SHA256_HEADER = 'x-booking-surface-schema-sha256' as const

export const BOOKING_SURFACES = [
  'tenant',
  'customer_portal',
  'storefront',
  'payment_link',
] as const
export type BookingSurface = (typeof BOOKING_SURFACES)[number]

/**
 * Process composition modes are deliberately separate from the payload
 * schema. The default accepts turns already bound by HotelByte's BFF; the
 * second mode is reserved for an in-process BFF binding seam.
 */
export const BOOKING_COPILOT_INGRESS_MODES = ['bff-bound-turn-only', 'bff-ingress-binding'] as const
export type BookingCopilotIngressMode = typeof BOOKING_COPILOT_INGRESS_MODES[number]
export const BOOKING_COPILOT_ACCEPTED_TURN_KINDS = ['user.turn', 'action.receipt.continuation'] as const
export const BOOKING_COPILOT_INGRESS_TURN_KIND = 'user.turn.ingress' as const
/** Hard task-level operation budget. The counter is persisted in the ledger. */
export const BOOKING_COPILOT_MAX_OPERATIONS = 20 as const

export const BOOKING_READ_ACTION_KINDS = ['search.patch','search.run','results.view.patch','hotel.focus','hotel.select','offers.query','offers.view.patch','offers.compare','offer.select','offer.check','checkout.prepare','order.observe'] as const
export type BookingReadActionKind = typeof BOOKING_READ_ACTION_KINDS[number]
/** Product-owned least-privilege action matrix. BFF bindings may narrow these lists, never expand them. */
export const BOOKING_SURFACE_ALLOWED_ACTIONS: Record<BookingSurface, readonly BookingReadActionKind[]> = {
  tenant: BOOKING_READ_ACTION_KINDS,
  customer_portal: BOOKING_READ_ACTION_KINDS,
  storefront: ['search.patch', 'search.run', 'results.view.patch', 'hotel.focus'],
  payment_link: ['search.patch', 'search.run', 'results.view.patch', 'hotel.focus', 'hotel.select'],
}
/** Stable product-matrix observation for UAT and server readiness proofs. */
export function bookingSurfaceAllowedActions(surface: BookingSurface): BookingReadActionKind[] {
  return [...BOOKING_SURFACE_ALLOWED_ACTIONS[surface]]
}

export type BookingRequestKey = string
/** Runtime-owned idempotency key; this is not a browser request key. */
export type BookingInternalDecisionKey = string

export const BOOKING_BLOCKER_CODES = ['no_hotels_matched','hotel_not_visible','hotel_rates_failed','criterion_must_not_met','offer_target_not_reached','offer_unavailable'] as const
export type BookingBlockerCode = typeof BOOKING_BLOCKER_CODES[number]
export const BOOKING_GAP_CODES = ['byos_mapped_risk','check_avail_failed','check_avail_unverified','component_executor_unavailable','hotel_not_visible','hotel_rates_failed','offer_facts_changed','offer_not_loaded','offer_unavailable','order_not_found','order_outcome_not_observed','order_state_unknown','order_status_unavailable','requested_offers_not_loaded','search_failed','search_form_invalid','search_session_expired','search_terminal_timeout','stale_revision','surface_adapter_failed','undo_token_not_found','unhandled','unsupported','verified_offer_required','workspace_changed_during_action','criterion_must_not_met','no_hotels_matched','offer_target_not_reached'] as const
export type BookingGapCode = typeof BOOKING_GAP_CODES[number]
export type BookingBlockerScope = 'search' | 'offer' | 'availability' | 'checkout'

export type CriterionStrength = 'must' | 'prefer'
export interface Criterion<T> {
  strength: CriterionStrength
  value: T
}

export interface Money {
  /** Decimal string supplied by the authoritative page object; never recomputed by GoTry. */
  amount: string
  currency: string
  sourceFactRef: string
}

export interface OccupancyRoom {
  adults: number
  childAges: number[]
}

export interface SearchCriteriaPatch {
  destination?: {
    query?: string
    placeRef?: string
  }
  hotel?: Criterion<{
    name?: string
    hotelRef?: string
  }>
  stay?: {
    checkIn?: string
    checkOut?: string
  }
  occupancy?: {
    rooms: OccupancyRoom[]
  }
  budget?: Criterion<{
    min?: Money
    max?: Money
  }>
  starRating?: Criterion<{
    min?: number
    max?: number
  }>
  guestRating?: Criterion<{
    min: number
  }>
  facilities?: Criterion<{
    allOf: string[]
  }>
  distance?: Criterion<{
    anchorLabel?: string
    anchorRef?: string
    maxKm: number
  }>
}

export type ResultSort =
  | 'recommended'
  | 'price_asc'
  | 'price_desc'
  | 'rating_desc'
  | 'distance_asc'

export interface ResultsViewPatch {
  starRating?: { min?: number; max?: number } | null
  guestRatingMin?: number | null
  facilitiesAllOf?: string[] | null
  distance?: { anchorRef: string; maxKm: number } | null
  price?: { min?: Money; max?: Money } | null
  sort?: ResultSort
}

export interface OfferCriteria {
  roomType?: Criterion<string[]>
  bedType?: Criterion<string[]>
  meals?: Criterion<string[]>
  freeCancellation?: Criterion<boolean>
  freeCancellationUntil?: Criterion<string>
  totalPriceMax?: Criterion<Money>
  roomsAvailableMin?: Criterion<number>
  payAtProperty?: Criterion<boolean>
  mobileRate?: Criterion<boolean>
  targetCount?: number
  sort?: 'best_match' | 'total_price_asc' | 'cancellation_latest'
}

export type EvidenceLevel = 'listed' | 'rate_loaded' | 'checked'

export interface SearchDraftSnapshot {
  destination?: { query?: string; placeRef?: string }
  stay?: { checkIn?: string; checkOut?: string }
  occupancy?: { rooms: OccupancyRoom[] }
  criteria?: SearchCriteriaPatch
}

export interface ResultViewSnapshot {
  status: 'idle' | 'loading' | 'ready' | 'partial' | 'failed'
  filters?: ResultsViewPatch
  sort?: ResultSort
  resultCount?: number
  searchSessionRef?: string
}

export interface VisibleHotelFact {
  hotelRef: string
  name: string
  starRating?: number
  guestRating?: number
  distanceKm?: number
  facilityCodes?: string[]
  factRefs: string[]
}

export interface LoadedOfferFact {
  offerRef: string
  offerVersionRef: string
  hotelRef: string
  evidenceLevel: EvidenceLevel
  factRefs: string[]
}

export interface VerifiedOfferCapability {
  offerRef: string
  offerVersionRef: string
  verifiedOfferRef: string
  expiresAt: string
}

export interface CriterionBlocker {
  blockerId: string
  sourceActionId: string
  sourceReceiptDigest: string
  scope: BookingBlockerScope
  code: BookingBlockerCode
  criterionPath: string
  strength: 'must'
  valueDigest: string
  valueLabel?: string
  evidence: { factRefs: string[]; gapCodes: BookingGapCode[]; requested?: number; actual?: number }
}

export interface RelaxationApproval {
  taskId: string
  contextRef: string
  sourceTurnId: string
  presentationRequestKey: string
  optionDigest: string
  approvalId: string
  deliveryNonce: string
  blockerId: string
  sourceActionId: string
  sourceReceiptDigest: string
  scope: BookingBlockerScope
  code: BookingBlockerCode
  criterionPath: string
  valueDigest: string
  from: 'must'
  to: 'prefer' | 'drop'
  approved: true
}

export interface RelaxationApprovalRef {
  approvalId: string
  blockerId: string
  contextRef: string
  sourceTurnId: string
  presentationRequestKey: string
  sourceActionId: string
  targetActionId: string
  sourceRevision: number
  targetActionKind: BookingReadActionKind
  to: 'prefer' | 'drop'
  expiresAt: string
  nonce: string
  sourceReceiptDigest: string
  scope: BookingBlockerScope
  code: BookingBlockerCode
  criterionPath: string
  valueDigest: string
}

interface BookingReadActionBase<K extends BookingReadActionKind, I> {
  schemaVersion: typeof BOOKING_SURFACE_SCHEMA_VERSION
  kind: K
  actionId: string
  contextRef: string
  expectedRevision: number
  reason: string
  factRefs: string[]
  input: I
  relaxationApprovalRef?: RelaxationApprovalRef
}

export type SearchPatchAction = BookingReadActionBase<'search.patch', { patch: SearchCriteriaPatch }>
export type SearchRunAction = BookingReadActionBase<'search.run', Record<string, never>>
export type ResultsViewPatchAction = BookingReadActionBase<'results.view.patch', { patch: ResultsViewPatch }>
export type HotelFocusAction = BookingReadActionBase<'hotel.focus', { hotelRef: string }>
export type HotelSelectAction = BookingReadActionBase<'hotel.select', { hotelRef: string }>
export type OffersQueryAction = BookingReadActionBase<'offers.query', { hotelRefs: string[]; criteria: OfferCriteria }>
export type OffersViewPatchAction = BookingReadActionBase<'offers.view.patch', { hotelRef: string; criteria: OfferCriteria }>
export type OffersCompareAction = BookingReadActionBase<'offers.compare', { offerRefs: string[]; requestedCount: number }>
export type OfferSelectAction = BookingReadActionBase<'offer.select', { offerRef: string; offerVersionRef: string }>
export type OfferCheckAction = BookingReadActionBase<'offer.check', { offerRef: string; offerVersionRef: string }>
export type CheckoutPrepareAction = BookingReadActionBase<'checkout.prepare', { offerRef: string; offerVersionRef: string; verifiedOfferRef: string }>
export type OrderObserveAction = BookingReadActionBase<'order.observe', { orderRef: string }>

export type BookingReadAction =
  | SearchPatchAction
  | SearchRunAction
  | ResultsViewPatchAction
  | HotelFocusAction
  | HotelSelectAction
  | OffersQueryAction
  | OffersViewPatchAction
  | OffersCompareAction
  | OfferSelectAction
  | OfferCheckAction
  | CheckoutPrepareAction
  | OrderObserveAction

export interface BookingWorkspaceSnapshot {
  schemaVersion: typeof BOOKING_SURFACE_SCHEMA_VERSION
  contextRef: string
  surface: BookingSurface
  revision: number
  locale: string
  currency: string
  searchDraft: SearchDraftSnapshot
  results: ResultViewSnapshot
  visibleHotels: VisibleHotelFact[]
  loadedOffers: LoadedOfferFact[]
  focusedHotelRef?: string
  shortlistedOfferRefs: string[]
  selectedOfferRef?: string
  verifiedOffer?: VerifiedOfferCapability
  capabilities: { surface: BookingSurface; allowedActions: BookingReadActionKind[] }
}

export type BookingWorkspaceIngressSnapshot = Pick<
  BookingWorkspaceSnapshot,
  'schemaVersion' | 'revision' | 'locale' | 'currency' | 'searchDraft' | 'results' | 'visibleHotels' | 'loadedOffers' | 'focusedHotelRef' | 'shortlistedOfferRefs' | 'selectedOfferRef'
>

export type ActionObservation =
  | { kind: 'search.state'; searchSessionRef?: string; resultCount?: number; gapCodes?: BookingGapCode[] }
  | { kind: 'results.state'; matchedHotelRefs: string[]; visibleCount: number; gapCodes?: BookingGapCode[] }
  | { kind: 'hotel.focus'; hotelRef: string }
  | { kind: 'hotel.selection'; hotelRef: string }
  | { kind: 'offers.state'; hotelRefs: string[]; offerRefs: string[]; loadedHotelCount: number; gapCodes?: BookingGapCode[] }
  | { kind: 'offer.selection'; offerRef: string; offerVersionRef: string }
  | { kind: 'offer.availability'; offerRef: string; checkedOfferVersionRef: string; currentOfferVersionRef?: string; verifiedOfferRef?: string; available: boolean; changedFactRefs: string[]; gapCodes?: BookingGapCode[] }
  | { kind: 'checkout.handoff'; offerRef: string; offerVersionRef: string; verifiedOfferRef: string; handoffRef: string }
  | { kind: 'order.state'; orderRef: string; state: 'pending' | 'verified' | 'failed' | 'unknown'; gapCodes?: BookingGapCode[] }
  | { kind: 'gap'; code: BookingGapCode; factRefs: string[] }

export interface ResultContract {
  outcome: 'complete' | 'partial' | 'empty'
  requestedCount?: number
  actualCount?: number
  hardCriteriaMet: boolean
  factRefs: string[]
  gapCodes: BookingGapCode[]
  blockers: CriterionBlocker[]
  relaxationsApplied: RelaxationApproval[]
}

export interface ActionReceipt {
  schemaVersion: typeof BOOKING_SURFACE_SCHEMA_VERSION
  kind: 'action.receipt'
  actionId: string
  contextRef: string
  status: 'applied' | 'needs_input' | 'partial' | 'no_match' | 'unavailable' | 'changed' | 'stale' | 'unsupported' | 'failed'
  revision: number
  observation: ActionObservation
  resultContract: ResultContract
  undoToken?: string
}

export interface UserTurn {
  schemaVersion: typeof BOOKING_SURFACE_SCHEMA_VERSION
  kind: 'user.turn'
  taskId: string
  turnId: string
  workspace: BookingWorkspaceSnapshot
  request: { text: string; approval?: RelaxationApproval }
}

/** Browser-to-BFF ingress. Identity is deliberately absent from this shape. */
export interface IngressTurn {
  schemaVersion: typeof BOOKING_SURFACE_SCHEMA_VERSION
  kind: 'user.turn.ingress'
  requestKey: BookingRequestKey
  taskHandle?: string
  surfaceHint: BookingSurface
  workspace: BookingWorkspaceIngressSnapshot
  request: { text: string }
}

export interface ReceiptContinuation {
  schemaVersion: typeof BOOKING_SURFACE_SCHEMA_VERSION
  kind: 'action.receipt.continuation'
  taskId: string
  workspace: BookingWorkspaceSnapshot
  receipt: ActionReceipt
}

export type BookingCopilotTurn = UserTurn | IngressTurn | ReceiptContinuation

/** Typed BFF seam: implementations authenticate ingress and return only
 * server-issued identity. The HTTP adapter constructs the internal UserTurn. */
export interface BookingIngressIdentityBinding {
  taskId: string
  turnId: string
  contextRef: string
  /** Authoritative BFF surface; never copied from the browser hint. */
  surface: BookingSurface
  /** BFF-authorized closed action subset for this surface. */
  allowedActions: BookingReadActionKind[]
}

export interface BookingIngressPrincipal {
  subject: string
  scope: string
}

export interface BookingIngressBinding {
  bind(input: IngressTurn, principal: BookingIngressPrincipal): BookingIngressIdentityBinding | Promise<BookingIngressIdentityBinding>
}

export interface BookingQuestionEvent {
  schemaVersion: typeof BOOKING_SURFACE_SCHEMA_VERSION
  eventId: string
  taskId: string
  contextRef: string
  sequence: number
  emittedAt: string
  kind: 'question'
  question: {
    questionId: string
    prompt: string
    missingFields: string[]
    type: 'relaxation_approval_required'
    blocker: CriterionBlocker
    approvalOptions: Array<{ approval: RelaxationApproval }>
  }
}

export interface BookingEventBase {
  schemaVersion: typeof BOOKING_SURFACE_SCHEMA_VERSION
  eventId: string
  taskId: string
  contextRef: string
  sequence: number
  emittedAt: string
}

export type BookingSurfaceEvent =
  | (BookingEventBase & { kind: 'status'; status: 'submitted' | 'working' | 'waiting_receipt' | 'input_required' })
  | BookingQuestionEvent
  | (BookingEventBase & { kind: 'operation'; action: BookingReadAction })
  | (BookingEventBase & { kind: 'explanation'; explanation: { text: string; factRefs: string[] } })
  | (BookingEventBase & { kind: 'terminal'; terminal: { status: 'completed' | 'stopped'; summary: string; factRefs: string[] } })
  | (BookingEventBase & { kind: 'error'; error: { code: string; message: string; retryable: boolean } })
