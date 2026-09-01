import type { BookingReadActionKindV1, BookingWorkspaceSnapshotV1, SearchCriteriaPatchV1, ResultsViewPatchV1, OfferCriteriaV1, EvidenceLevelV1 } from './contracts.ts'

export const BOOKING_SURFACE_SCHEMA_VERSION_V2 = 'booking.surface.v2' as const
/** Hard task-level operation budget. The counter is persisted in the v2 ledger. */
export const BOOKING_COPILOT_MAX_OPERATIONS_V2 = 20 as const
export const BOOKING_SURFACE_SCHEMA_V2_SHA256 = '45df62db1b19d30a4fd22ddc94eb550e8ff32d8a225558b5ff13ba303588fc03' as const
export const BOOKING_READ_ACTION_KINDS_V2 = ['search.patch','search.run','results.view.patch','hotel.focus','hotel.select','offers.query','offers.view.patch','offers.compare','offer.select','offer.check','checkout.prepare','order.observe'] as const satisfies readonly BookingReadActionKindV1[]
export type BookingReadActionKindV2 = typeof BOOKING_READ_ACTION_KINDS_V2[number]
export type BookingSurfaceV2 = 'tenant' | 'customer_portal' | 'storefront' | 'payment_link'
/** Product-owned least-privilege action matrix. BFF bindings may narrow these lists, never expand them. */
export const BOOKING_SURFACE_ALLOWED_ACTIONS_V2: Record<BookingSurfaceV2, readonly BookingReadActionKindV2[]> = {
  tenant: BOOKING_READ_ACTION_KINDS_V2,
  customer_portal: BOOKING_READ_ACTION_KINDS_V2,
  storefront: ['search.patch', 'search.run', 'results.view.patch', 'hotel.focus'],
  payment_link: ['search.patch', 'search.run', 'results.view.patch', 'hotel.focus', 'hotel.select'],
}
/** Stable product-matrix observation for UAT and server readiness proofs. */
export function bookingSurfaceAllowedActionsV2(surface: BookingSurfaceV2): BookingReadActionKindV2[] {
  return [...BOOKING_SURFACE_ALLOWED_ACTIONS_V2[surface]]
}
export type BookingRequestKeyV2 = string
/** Runtime-owned idempotency key; this is not a browser request key. */
export type BookingInternalDecisionKeyV2 = string
export const BOOKING_V2_BLOCKER_CODES = ['no_hotels_matched','hotel_not_visible','hotel_rates_failed','criterion_must_not_met','offer_target_not_reached','offer_unavailable'] as const
export type BookingV2BlockerCode = typeof BOOKING_V2_BLOCKER_CODES[number]
export const BOOKING_V2_GAP_CODES = ['byos_mapped_risk','check_avail_failed','check_avail_unverified','component_executor_unavailable','hotel_not_visible','hotel_rates_failed','offer_facts_changed','offer_not_loaded','offer_unavailable','order_not_found','order_outcome_not_observed','order_state_unknown','order_status_unavailable','requested_offers_not_loaded','search_failed','search_form_invalid','search_session_expired','search_terminal_timeout','stale_revision','surface_adapter_failed','undo_token_not_found','unhandled','unsupported','verified_offer_required','workspace_changed_during_action','criterion_must_not_met','no_hotels_matched','offer_target_not_reached'] as const
export type BookingV2GapCode = typeof BOOKING_V2_GAP_CODES[number]
export type BookingV2BlockerScope = 'search' | 'offer' | 'availability' | 'checkout'
export interface CriterionBlockerV2 { blockerId: string; sourceActionId: string; sourceReceiptDigest: string; scope: BookingV2BlockerScope; code: BookingV2BlockerCode; criterionPath: string; strength: 'must'; valueDigest: string; valueLabel?: string; evidence: { factRefs: string[]; gapCodes: BookingV2GapCode[]; requested?: number; actual?: number } }
export interface RelaxationApprovalV2 {
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
  scope: BookingV2BlockerScope
  code: BookingV2BlockerCode
  criterionPath: string
  valueDigest: string
  from: 'must'
  to: 'prefer' | 'drop'
  approved: true
}
export interface RelaxationApprovalRefV2 { approvalId: string; blockerId: string; contextRef: string; sourceTurnId: string; presentationRequestKey: string; sourceActionId: string; targetActionId: string; sourceRevision: number; targetActionKind: BookingReadActionKindV2; to: 'prefer'|'drop'; expiresAt: string; nonce: string; sourceReceiptDigest: string; scope: BookingV2BlockerScope; code: BookingV2BlockerCode; criterionPath: string; valueDigest: string }
interface Base<K extends BookingReadActionKindV2, I> { schemaVersion: typeof BOOKING_SURFACE_SCHEMA_VERSION_V2; kind: K; actionId: string; contextRef: string; expectedRevision: number; reason: string; factRefs: string[]; input: I; relaxationApprovalRef?: RelaxationApprovalRefV2 }
export type SearchPatchActionV2 = Base<'search.patch', { patch: SearchCriteriaPatchV1 }>
export type SearchRunActionV2 = Base<'search.run', Record<string, never>>
export type ResultsViewPatchActionV2 = Base<'results.view.patch', { patch: ResultsViewPatchV1 }>
export type HotelFocusActionV2 = Base<'hotel.focus', { hotelRef: string }>
export type HotelSelectActionV2 = Base<'hotel.select', { hotelRef: string }>
export type OffersQueryActionV2 = Base<'offers.query', { hotelRefs: string[]; criteria: OfferCriteriaV1 }>
export type OffersViewPatchActionV2 = Base<'offers.view.patch', { hotelRef: string; criteria: OfferCriteriaV1 }>
export type OffersCompareActionV2 = Base<'offers.compare', { offerRefs: string[]; requestedCount: number }>
export interface LoadedOfferFactV2 { offerRef: string; offerVersionRef: string; hotelRef: string; evidenceLevel: EvidenceLevelV1; factRefs: string[] }
export interface VerifiedOfferCapabilityV2 { offerRef: string; offerVersionRef: string; verifiedOfferRef: string; expiresAt: string }
export type OfferSelectActionV2 = Base<'offer.select', { offerRef: string; offerVersionRef: string }>
export type OfferCheckActionV2 = Base<'offer.check', { offerRef: string; offerVersionRef: string }>
export type CheckoutPrepareActionV2 = Base<'checkout.prepare', { offerRef: string; offerVersionRef: string; verifiedOfferRef: string }>
export type OrderObserveActionV2 = Base<'order.observe', { orderRef: string }>
export type BookingReadActionV2=SearchPatchActionV2|SearchRunActionV2|ResultsViewPatchActionV2|HotelFocusActionV2|HotelSelectActionV2|OffersQueryActionV2|OffersViewPatchActionV2|OffersCompareActionV2|OfferSelectActionV2|OfferCheckActionV2|CheckoutPrepareActionV2|OrderObserveActionV2
export interface BookingWorkspaceSnapshotV2 extends Omit<BookingWorkspaceSnapshotV1,'schemaVersion'|'surface'|'capabilities'|'loadedOffers'|'verifiedOfferRef'>{schemaVersion:typeof BOOKING_SURFACE_SCHEMA_VERSION_V2;surface:BookingSurfaceV2;loadedOffers:LoadedOfferFactV2[];verifiedOffer?:VerifiedOfferCapabilityV2;capabilities:{surface:BookingSurfaceV2;allowedActions:BookingReadActionKindV2[]}}
export type BookingWorkspaceIngressSnapshotV2 = Pick<BookingWorkspaceSnapshotV2, 'schemaVersion'|'revision'|'locale'|'currency'|'searchDraft'|'results'|'visibleHotels'|'loadedOffers'|'focusedHotelRef'|'shortlistedOfferRefs'|'selectedOfferRef'>
export type ActionObservationV2 =
  | { kind: 'search.state'; searchSessionRef?: string; resultCount?: number; gapCodes?: BookingV2GapCode[] }
  | { kind: 'results.state'; matchedHotelRefs: string[]; visibleCount: number; gapCodes?: BookingV2GapCode[] }
  | { kind: 'hotel.focus'; hotelRef: string }
  | { kind: 'hotel.selection'; hotelRef: string }
  | { kind: 'offers.state'; hotelRefs: string[]; offerRefs: string[]; loadedHotelCount: number; gapCodes?: BookingV2GapCode[] }
  | { kind: 'offer.selection'; offerRef: string; offerVersionRef: string }
  | { kind: 'offer.availability'; offerRef: string; checkedOfferVersionRef: string; currentOfferVersionRef?: string; verifiedOfferRef?: string; available: boolean; changedFactRefs: string[]; gapCodes?: BookingV2GapCode[] }
  | { kind: 'checkout.handoff'; offerRef: string; offerVersionRef: string; verifiedOfferRef: string; handoffRef: string }
  | { kind: 'order.state'; orderRef: string; state: 'pending'|'verified'|'failed'|'unknown'; gapCodes?: BookingV2GapCode[] }
  | { kind: 'gap'; code: BookingV2GapCode; factRefs: string[] }
export interface ResultContractV2 {outcome:'complete'|'partial'|'empty';requestedCount?:number;actualCount?:number;hardCriteriaMet:boolean;factRefs:string[];gapCodes:BookingV2GapCode[];blockers:CriterionBlockerV2[];relaxationsApplied:RelaxationApprovalV2[]}
export interface ActionReceiptV2 {schemaVersion:typeof BOOKING_SURFACE_SCHEMA_VERSION_V2;kind:'action.receipt';actionId:string;contextRef:string;status:'applied'|'needs_input'|'partial'|'no_match'|'unavailable'|'changed'|'stale'|'unsupported'|'failed';revision:number;observation:ActionObservationV2;resultContract:ResultContractV2;undoToken?:string}
export interface UserTurnV2 {schemaVersion:typeof BOOKING_SURFACE_SCHEMA_VERSION_V2;kind:'user.turn';taskId:string;turnId:string;workspace:BookingWorkspaceSnapshotV2;request:{text:string;approval?:RelaxationApprovalV2}}
/** Browser-to-BFF ingress. Identity is deliberately absent from this shape. */
export interface IngressTurnV2 {schemaVersion:typeof BOOKING_SURFACE_SCHEMA_VERSION_V2;kind:'user.turn.ingress';requestKey:BookingRequestKeyV2;taskHandle?:string;surfaceHint:BookingSurfaceV2;workspace:BookingWorkspaceIngressSnapshotV2;request:{text:string}}
export interface ReceiptContinuationV2 {schemaVersion:typeof BOOKING_SURFACE_SCHEMA_VERSION_V2;kind:'action.receipt.continuation';taskId:string;workspace:BookingWorkspaceSnapshotV2;receipt:ActionReceiptV2}
export type BookingCopilotTurnV2=UserTurnV2|IngressTurnV2|ReceiptContinuationV2
/** Typed BFF seam: implementations authenticate ingress and return only
 * server-issued identity. The HTTP adapter constructs the internal UserTurn. */
export interface BookingIngressIdentityBindingV2 {
  taskId: string
  turnId: string
  contextRef: string
  /** Authoritative BFF surface; never copied from the browser hint. */
  surface: BookingSurfaceV2
  /** BFF-authorized closed action subset for this surface. */
  allowedActions: BookingReadActionKindV2[]
}
export interface BookingIngressPrincipalV2 { subject: string; scope: string }
export interface BookingIngressBindingV2 {
  bind(input: IngressTurnV2, principal: BookingIngressPrincipalV2): BookingIngressIdentityBindingV2 | Promise<BookingIngressIdentityBindingV2>
}
export interface BookingQuestionEventV2 {schemaVersion:typeof BOOKING_SURFACE_SCHEMA_VERSION_V2;eventId:string;taskId:string;contextRef:string;sequence:number;emittedAt:string;kind:'question';question:{questionId:string;prompt:string;missingFields:string[];type:'relaxation_approval_required';blocker:CriterionBlockerV2;approvalOptions:Array<{approval:RelaxationApprovalV2}>}}
export interface BookingEventBaseV2 { schemaVersion: typeof BOOKING_SURFACE_SCHEMA_VERSION_V2; eventId: string; taskId: string; contextRef: string; sequence: number; emittedAt: string }
export type BookingSurfaceEventV2 =
  | (BookingEventBaseV2 & { kind: 'status'; status: 'submitted'|'working'|'waiting_receipt'|'input_required' })
  | BookingQuestionEventV2
  | (BookingEventBaseV2 & { kind: 'operation'; action: BookingReadActionV2 })
  | (BookingEventBaseV2 & { kind: 'explanation'; explanation: { text: string; factRefs: string[] } })
  | (BookingEventBaseV2 & { kind: 'terminal'; terminal: { status: 'completed'|'stopped'; summary: string; factRefs: string[] } })
  | (BookingEventBaseV2 & { kind: 'error'; error: { code: string; message: string; retryable: boolean } })
