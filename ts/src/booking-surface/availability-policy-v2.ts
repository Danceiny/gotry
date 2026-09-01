import type { ActionReceiptV2, BookingReadActionV2, BookingWorkspaceSnapshotV2 } from './contracts-v2.ts'
import type { OfferCriteriaV1 } from './contracts.ts'
import { createHash } from 'node:crypto'

/** Typed CheckAvail budget. This module never parses prose or retries a supplier. */
export const MAX_HOTELS_PER_TASK_V2 = 5
export const MAX_OFFERS_PER_HOTEL_GENERATION_V2 = 3
export const MAX_OFFER_CHECKS_PER_HOTEL_V2 = 2
export const MAX_OFFER_QUERIES_PER_HOTEL_V2 = 2

export type AvailabilityHotelStatusV2 = 'unvisited' | 'active' | 'negative' | 'confirmed' | 'inconclusive'
export type AvailabilityGenerationSourceV2 =
  | { kind: 'query_receipt'; actionId: string; receiptDigest: string; workspaceRevision: number }
  | { kind: 'workspace_snapshot'; workspaceDigest: string; workspaceRevision: number }
export interface AvailabilityGenerationV2 { generationId: string; source: AvailabilityGenerationSourceV2; offerSetDigest: string; orderedOfferRefs: string[]; evidence: 'complete' | 'partial'; valid: boolean }
export interface AvailabilityHotelStateV2 {
  hotelRef: string; status: AvailabilityHotelStatusV2; checksIssued: number; offerQueriesIssued: number; generationNo: number
  currentGeneration?: AvailabilityGenerationV2
  /** Compatibility projection for callers needing current refs only. */
  generation: number; currentOfferRefs: string[]; invalidatedOfferRefs: string[]; checkCount: number; freshOffersRequired: boolean
  lastEvidence: 'none' | 'confirmed' | 'unavailable' | 'inconclusive'
}
export interface AvailabilityAttemptV2 { actionId: string; hotelRef: string; offerRef: string; generation: number; ordinal: number; workspaceRevision: number }
export interface AvailabilityQueryReservationV2 { actionId: string; hotelRefs: string[]; workspaceRevision: number }
export interface AvailabilityExhaustionV2 {
  code: 'availability_confirmed' | 'availability_exhausted_complete' | 'availability_exhausted_inconclusive'
  hotelRefs: string[]; reason: 'no_current_offers' | 'check_limit_reached' | 'confirmed'; evidence: 'conclusive' | 'inconclusive'
}
export interface AvailabilityPolicyStateV2 {
  initialized: boolean; recoveryStarted: boolean
  availabilityPhase: 'need_offers' | 'waiting_offers' | 'need_check' | 'waiting_check' | 'terminal'
  activeHotelOrdinal: number; hotelRefs: string[]; hotels: Record<string, AvailabilityHotelStateV2>; attempts: AvailabilityAttemptV2[]; queryReservations: AvailabilityQueryReservationV2[]; terminal?: AvailabilityExhaustionV2
  recoveryId?: string; criteria?: OfferCriteriaV1; criteriaDigest?: string; candidateSetDigest?: string; lastQueryHotelRefs?: string[]; lastQueryCriteriaDigest?: string
  /** Receipt-authoritative mapping used when a shortlist ref is no longer loaded. */
  lastQueryOfferHotels?: Record<string, string>; lastQuerySourceActionId?: string; lastQuerySourceReceiptDigest?: string; lastQueryWorkspaceRevision?: number
}
export type AvailabilityPolicyDecisionV2 =
  | { ok: true; hotelRef: string; offerRef: string; checkCount: number; generation: number }
  | { ok: false; code: 'hotel_unknown' | 'offer_not_loaded' | 'offers_refresh_required' | 'hotel_check_limit_reached' | 'availability_exhausted' | 'generation_invalid' | 'hotel_not_active' }

type AvailabilityActionLikeV2 = { kind: BookingReadActionV2['kind']; actionId: string; input: Record<string, any>; expectedRevision?: number }

function unique(values: readonly string[]): string[] { return [...new Set(values)] }
function stable(value: unknown): unknown { if (Array.isArray(value)) return value.map(stable); if (!value || typeof value !== 'object') return value; return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, stable((value as Record<string, unknown>)[key])])); }
export function digestV2(value: unknown): string { return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex') }
function workspaceDigestV2(workspace: BookingWorkspaceSnapshotV2): string { const { contextRef: _context, ...bound } = workspace as unknown as Record<string, unknown>; return digestV2(bound) }
function offerRefsForHotel(workspace: BookingWorkspaceSnapshotV2, hotelRef: string, selectedOfferRef?: string): string[] {
  const refs = unique(workspace.loadedOffers.filter((offer) => offer.hotelRef === hotelRef).map((offer) => offer.offerRef))
  if (selectedOfferRef) return unique([selectedOfferRef, ...refs]).slice(0, MAX_OFFERS_PER_HOTEL_GENERATION_V2)
  if (refs.length > MAX_OFFERS_PER_HOTEL_GENERATION_V2) throw new Error('availability_offer_limit_exceeded')
  return refs
}
function copyHotel(hotel: AvailabilityHotelStateV2): AvailabilityHotelStateV2 {
  return { ...hotel, currentOfferRefs: [...hotel.currentOfferRefs], invalidatedOfferRefs: [...hotel.invalidatedOfferRefs], ...(hotel.currentGeneration ? { currentGeneration: { ...hotel.currentGeneration, orderedOfferRefs: [...hotel.currentGeneration.orderedOfferRefs] } } : {}) }
}
function copyState(state: AvailabilityPolicyStateV2): AvailabilityPolicyStateV2 {
  return { ...state, ...(state.criteria ? { criteria: structuredClone(state.criteria) } : {}), hotelRefs: [...state.hotelRefs], hotels: Object.fromEntries(Object.entries(state.hotels).map(([ref, hotel]) => [ref, copyHotel(hotel)])), attempts: state.attempts.map((attempt) => ({ ...attempt })), queryReservations: state.queryReservations.map((query) => ({ ...query, hotelRefs: [...query.hotelRefs] })), ...(state.lastQueryHotelRefs ? { lastQueryHotelRefs: [...state.lastQueryHotelRefs] } : {}), ...(state.lastQueryOfferHotels ? { lastQueryOfferHotels: { ...state.lastQueryOfferHotels } } : {}), ...(state.terminal ? { terminal: { ...state.terminal, hotelRefs: [...state.terminal.hotelRefs] } } : {}) }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }
function isCriterion(value: unknown, valueCheck: (candidate: unknown) => boolean): boolean {
  return isPlainRecord(value) && Object.keys(value).length === 2 && (value.strength === 'must' || value.strength === 'prefer') && valueCheck(value.value)
}
function isMoney(value: unknown): boolean {
  return isPlainRecord(value) && Object.keys(value).length === 3 && typeof value.amount === 'string' && Boolean(value.amount) && typeof value.currency === 'string' && Boolean(value.currency) && typeof value.sourceFactRef === 'string' && Boolean(value.sourceFactRef)
}
function isOfferCriteriaV2(value: unknown): value is OfferCriteriaV1 {
  if (!isPlainRecord(value)) return false
  const allowed = ['roomType', 'bedType', 'meals', 'freeCancellation', 'freeCancellationUntil', 'totalPriceMax', 'roomsAvailableMin', 'payAtProperty', 'mobileRate', 'targetCount', 'sort']
  if (Object.keys(value).some((key) => !allowed.includes(key))) return false
  const strings = (candidate: unknown): boolean => Array.isArray(candidate) && candidate.every((item) => typeof item === 'string' && Boolean(item))
  if (value.roomType !== undefined && !isCriterion(value.roomType, strings)) return false
  if (value.bedType !== undefined && !isCriterion(value.bedType, strings)) return false
  if (value.meals !== undefined && !isCriterion(value.meals, strings)) return false
  if (value.freeCancellation !== undefined && !isCriterion(value.freeCancellation, (candidate) => typeof candidate === 'boolean')) return false
  if (value.freeCancellationUntil !== undefined && !isCriterion(value.freeCancellationUntil, (candidate) => typeof candidate === 'string' && Boolean(candidate))) return false
  if (value.totalPriceMax !== undefined && !isCriterion(value.totalPriceMax, isMoney)) return false
  if (value.roomsAvailableMin !== undefined && !isCriterion(value.roomsAvailableMin, (candidate) => Number.isSafeInteger(candidate) && (candidate as number) >= 0)) return false
  if (value.payAtProperty !== undefined && !isCriterion(value.payAtProperty, (candidate) => typeof candidate === 'boolean')) return false
  if (value.mobileRate !== undefined && !isCriterion(value.mobileRate, (candidate) => typeof candidate === 'boolean')) return false
  if (value.targetCount !== undefined && (!Number.isSafeInteger(value.targetCount) || (value.targetCount as number) < 0)) return false
  if (value.sort !== undefined && !['best_match', 'total_price_asc', 'cancellation_latest'].includes(value.sort as string)) return false
  return true
}
function bindCriteria(next: AvailabilityPolicyStateV2, criteriaDigest: string, criteria?: OfferCriteriaV1, required = false): void {
  if (criteria !== undefined) {
    if (!isOfferCriteriaV2(criteria) || digestV2(criteria) !== criteriaDigest) throw new Error('availability_criteria_invalid')
    if (next.criteriaDigest !== undefined && next.criteriaDigest !== criteriaDigest) throw new Error('availability_criteria_changed')
    if (next.criteria && digestV2(next.criteria) !== criteriaDigest) throw new Error('availability_criteria_changed')
    next.criteria = structuredClone(criteria); next.criteriaDigest = criteriaDigest
  } else if (required && !next.criteria) throw new Error('availability_criteria_required')
  else if (next.criteria && next.criteriaDigest !== digestV2(next.criteria)) throw new Error('availability_criteria_mismatch')
  else if (!next.criteria && criteriaDigest) {
    if (next.criteriaDigest !== undefined && next.criteriaDigest !== criteriaDigest) throw new Error('availability_criteria_changed')
    next.criteriaDigest = criteriaDigest
  }
  if (next.criteriaDigest !== undefined && next.criteriaDigest !== criteriaDigest && criteriaDigest) throw new Error('availability_criteria_changed')
}
function terminalFor(state: AvailabilityPolicyStateV2): AvailabilityExhaustionV2 | undefined {
  if (!state.recoveryStarted || !state.hotelRefs.length) return undefined
  const hotels = state.hotelRefs.map((ref) => state.hotels[ref]!)
  if (hotels.some((hotel) => hotel.status === 'confirmed')) return { code: 'availability_confirmed', hotelRefs: [...state.hotelRefs], reason: 'confirmed', evidence: 'conclusive' }
  // A negative result is conclusive only when it has no legal refresh left.
  // The first manual check starts with a workspace generation (zero recovery
  // queries), so it must leave a fresh-query transition available.
  if (hotels.some((hotel) =>
    hotel.checksIssued < MAX_OFFER_CHECKS_PER_HOTEL_V2
    && (
      hotel.status === 'active'
      || hotel.status === 'unvisited'
      || (hotel.freshOffersRequired && hotel.offerQueriesIssued < MAX_OFFER_QUERIES_PER_HOTEL_V2)
    )
  )) return undefined
  const conclusive = hotels.every((hotel) => hotel.status === 'negative')
  return { code: conclusive ? 'availability_exhausted_complete' : 'availability_exhausted_inconclusive', hotelRefs: [...state.hotelRefs], reason: hotels.every((hotel) => !hotel.currentOfferRefs.length) ? 'no_current_offers' : 'check_limit_reached', evidence: conclusive ? 'conclusive' : 'inconclusive' }
}
function withTerminal(state: AvailabilityPolicyStateV2): AvailabilityPolicyStateV2 { const terminal = terminalFor(state); return terminal ? { ...state, terminal, availabilityPhase: 'terminal' } : state }
function newHotel(hotelRef: string): AvailabilityHotelStateV2 { return { hotelRef, status: 'unvisited', checksIssued: 0, offerQueriesIssued: 0, generationNo: 0, generation: 0, currentOfferRefs: [], invalidatedOfferRefs: [], checkCount: 0, freshOffersRequired: false, lastEvidence: 'none' } }
function phaseForActiveHotel(state: AvailabilityPolicyStateV2): 'need_offers' | 'need_check' {
  const active = state.hotels[state.hotelRefs[state.activeHotelOrdinal] ?? '']
  return active?.status === 'active' && active.currentGeneration?.valid && active.currentOfferRefs.length > 0 && !active.freshOffersRequired
    ? 'need_check'
    : 'need_offers'
}

/** Initial workspace is only a hint; the bounded recovery starts at typed offers.query. */
export function createAvailabilityPolicyV2(_workspace: BookingWorkspaceSnapshotV2): AvailabilityPolicyStateV2 { return { initialized: false, recoveryStarted: false, availabilityPhase: 'need_offers', activeHotelOrdinal: 0, hotelRefs: [], hotels: {}, attempts: [], queryReservations: [] } }
/** Ordinary search results never get silently truncated into recovery candidates. */
export function recordVisibleHotelsV2(state: AvailabilityPolicyStateV2, _workspace: BookingWorkspaceSnapshotV2): AvailabilityPolicyStateV2 { return copyState(state) }
/** Observe a normal offers query without opening an availability recovery. */
export function recordObservedOffersQueryV2(state: AvailabilityPolicyStateV2, hotelRefs: readonly string[], criteriaDigest: string, workspace?: BookingWorkspaceSnapshotV2, receipt?: ActionReceiptV2, sourceActionId?: string, receiptDigest?: string, criteria?: OfferCriteriaV1): AvailabilityPolicyStateV2 {
  if (state.recoveryStarted) return copyState(state)
  const next = copyState(state)
  if (!workspace || !receipt) return next
  delete next.lastQueryHotelRefs; delete next.lastQueryCriteriaDigest; delete next.lastQueryOfferHotels; delete next.lastQuerySourceActionId; delete next.lastQuerySourceReceiptDigest; delete next.lastQueryWorkspaceRevision
  const completeReceipt = receipt?.status === 'applied'
    && receipt.resultContract.outcome === 'complete'
    && receipt.resultContract.hardCriteriaMet
    && !receipt.resultContract.gapCodes.length
    && !receipt.resultContract.blockers.length
    && receipt.observation.kind === 'offers.state'
    && !receipt.observation.gapCodes?.length
  if (completeReceipt && receipt.observation.kind === 'offers.state') {
    if (!criteria) throw new Error('availability_criteria_required')
    // Ordinary queries establish the latest recovery seed. Before recovery
    // starts, a newer complete query is allowed to replace an older seed.
    delete next.criteria
    delete next.criteriaDigest
    bindCriteria(next, criteriaDigest, criteria)
    if (!sourceActionId || sourceActionId !== receipt.actionId || !receiptDigest || receiptDigest !== digestV2(receipt)) throw new Error('availability_query_provenance_mismatch')
    next.lastQueryHotelRefs = [...new Set(hotelRefs)]
    next.lastQueryCriteriaDigest = criteriaDigest || undefined
    next.lastQueryOfferHotels = validateOffersReceiptWorkspaceV2(receipt, workspace, hotelRefs)
    next.lastQuerySourceActionId = sourceActionId
    next.lastQuerySourceReceiptDigest = receiptDigest
    next.lastQueryWorkspaceRevision = workspace.revision
  } else {
    // The latest ordinary query is the only candidate provenance. A failed
    // or partial query must not leave an older criteria object usable for a
    // later manual recovery.
    delete next.criteria
    delete next.criteriaDigest
  }
  return next
}

/**
 * Reconcile an offers receipt against the post-action workspace before its
 * provenance can influence recovery. Complete receipts must describe exactly
 * the authoritative loaded offers; partial/gap receipts may only describe an
 * evidenced subset. An unreported offer is never silently admitted.
 */
export function validateOffersReceiptWorkspaceV2(receipt: ActionReceiptV2, workspace: BookingWorkspaceSnapshotV2, hotelRefs: readonly string[]): Record<string, string> {
  if (receipt.observation.kind !== 'offers.state') throw new Error('availability_offers_observation_required')
  const requested = unique(hotelRefs)
  if (!sameSet(receipt.observation.hotelRefs, requested)) throw new Error('availability_offers_hotel_mismatch')
  const authoritative = workspace.loadedOffers.filter((offer) => requested.includes(offer.hotelRef))
  const authoritativeRefs = unique(authoritative.map((offer) => offer.offerRef))
  const observedRefs = unique(receipt.observation.offerRefs)
  if (observedRefs.some((offerRef) => !authoritativeRefs.includes(offerRef))) throw new Error('availability_offers_unreported')
  const authoritativeHotels = new Set(authoritative.map((offer) => offer.hotelRef)).size
  const observedOfferHotels = Object.fromEntries(observedRefs.map((offerRef) => [offerRef, authoritative.find((offer) => offer.offerRef === offerRef)!.hotelRef]))
  const observedHotels = new Set(Object.values(observedOfferHotels)).size
  const clean = !receipt.resultContract.gapCodes.length && !receipt.resultContract.blockers.length && !receipt.observation.gapCodes?.length
  if ((receipt.status === 'no_match' || receipt.status === 'unavailable') && (receipt.resultContract.outcome !== 'empty' || observedRefs.length !== 0 || receipt.observation.loadedHotelCount !== 0)) throw new Error('availability_offers_receipt_incoherent')
  const complete = receipt.status === 'applied' && receipt.resultContract.outcome === 'complete' && receipt.resultContract.hardCriteriaMet && clean
  const exactEmpty = clean && receipt.resultContract.outcome === 'empty' && !['changed', 'partial', 'stale', 'failed', 'unsupported'].includes(receipt.status)
  if ((complete || exactEmpty) && (!sameSet(observedRefs, authoritativeRefs) || receipt.observation.loadedHotelCount !== authoritativeHotels)) throw new Error('availability_offers_workspace_mismatch')
  if (receipt.observation.loadedHotelCount !== observedHotels) throw new Error('availability_offers_count_mismatch')
  return observedOfferHotels
}

function sameSet(a: readonly string[], b: readonly string[]): boolean { return a.length === b.length && unique(a).sort().every((value, index) => value === unique(b).sort()[index]) }

/** A typed offers.query receipt starts/advances a bounded candidate recovery. */
export function recordOffersQueryIssuedV2(state: AvailabilityPolicyStateV2, hotelRefs: readonly string[], workspace: BookingWorkspaceSnapshotV2, actionId: string, criteriaDigest = '', criteria?: OfferCriteriaV1): AvailabilityPolicyStateV2 {
  const next = copyState(state); const requested = unique(hotelRefs)
  if (!requested.length || requested.length > MAX_HOTELS_PER_TASK_V2) throw new Error('availability_hotel_limit_exceeded')
  if (!state.recoveryStarted) throw new Error('availability_recovery_not_started')
  if (state.terminal) {
    if (requested.some((ref) => state.hotels[ref]?.offerQueriesIssued >= MAX_OFFER_QUERIES_PER_HOTEL_V2)) throw new Error('availability_offer_query_limit_reached')
    throw new Error('availability_terminal')
  }
  if (requested.some((ref) => !next.hotels[ref])) throw new Error('availability_hotel_unknown')
  else if ((requested.length !== 1 || next.hotelRefs[next.activeHotelOrdinal] !== requested[0]) && (next.attempts.length > 0 || Object.values(next.hotels).some((hotel) => hotel.generationNo > 0))) throw new Error('availability_hotel_not_active')
  bindCriteria(next, criteriaDigest, criteria)
  const existingReservation = next.queryReservations.find((reservation) => reservation.actionId === actionId)
  if (existingReservation) {
    if (!sameSet(existingReservation.hotelRefs, requested) || existingReservation.workspaceRevision !== workspace.revision) throw new Error('availability_query_action_conflict')
    return next
  }
  for (const hotelRef of requested) { const hotel = next.hotels[hotelRef]!; if (hotel.offerQueriesIssued >= MAX_OFFER_QUERIES_PER_HOTEL_V2) throw new Error('availability_offer_query_limit_reached'); hotel.offerQueriesIssued += 1 }
  next.queryReservations.push({ actionId, hotelRefs: [...requested], workspaceRevision: workspace.revision }); next.availabilityPhase = 'waiting_offers'; next.initialized = true; return next
}
export function recordOffersGenerationV2(state: AvailabilityPolicyStateV2, hotelRefs: readonly string[], workspace: BookingWorkspaceSnapshotV2, actionId: string, receiptDigest: string, receipt: ActionReceiptV2, criteriaDigest = '', criteria?: OfferCriteriaV1): AvailabilityPolicyStateV2 {
  if (!state.recoveryStarted) return copyState(state)
  if (state.terminal) throw new Error('availability_terminal')
  const next = copyState(state); const requested = unique(hotelRefs)
  if (!requested.length || requested.length > MAX_HOTELS_PER_TASK_V2) throw new Error('availability_hotel_limit_exceeded')
  const reservation = next.queryReservations.find((query) => query.actionId === actionId)
  if (!reservation || !sameSet(reservation.hotelRefs, requested)) throw new Error('availability_query_not_reserved')
  if (receipt.actionId !== actionId) throw new Error('availability_query_receipt_mismatch')
  if (receiptDigest !== digestV2(receipt)) throw new Error('availability_receipt_digest_mismatch')
  if (requested.some((ref) => !next.hotels[ref])) throw new Error('availability_hotel_unknown')
  else if ((requested.length !== 1 || next.hotelRefs[next.activeHotelOrdinal] !== requested[0]) && (next.attempts.length > 0 || Object.values(next.hotels).some((hotel) => hotel.generationNo > 0))) throw new Error('availability_hotel_not_active')
  bindCriteria(next, criteriaDigest, criteria)
  if (receipt.observation.kind === 'offers.state') validateOffersReceiptWorkspaceV2(receipt, workspace, requested)
  for (const hotelRef of requested) {
    const hotel = next.hotels[hotelRef]!
    const partial = receipt.status === 'changed' || receipt.status === 'partial' || receipt.status === 'failed' || receipt.status === 'stale' || receipt.resultContract.outcome === 'partial' || (receipt.resultContract.outcome === 'complete' && !receipt.resultContract.hardCriteriaMet) || Boolean(receipt.resultContract.blockers.length) || Boolean(receipt.resultContract.gapCodes.length) || Boolean(receipt.observation.kind === 'gap' || (receipt.observation.kind === 'offers.state' && receipt.observation.gapCodes?.length))
    const refs = partial
      ? receipt.observation.kind === 'offers.state'
        ? receipt.observation.offerRefs.filter((ref) => workspace.loadedOffers.some((offer) => offer.offerRef === ref && offer.hotelRef === hotelRef))
        : []
      : offerRefsForHotel(workspace, hotelRef)
    if (refs.length > MAX_OFFERS_PER_HOTEL_GENERATION_V2) throw new Error('availability_offer_limit_exceeded')
    const unusable = ['stale', 'failed', 'unsupported'].includes(receipt.status)
    if (unusable) { hotel.currentOfferRefs = []; hotel.invalidatedOfferRefs = [...(hotel.currentGeneration?.orderedOfferRefs ?? [])]; hotel.freshOffersRequired = hotel.checksIssued < MAX_OFFER_CHECKS_PER_HOTEL_V2 && hotel.offerQueriesIssued < MAX_OFFER_QUERIES_PER_HOTEL_V2; hotel.status = 'inconclusive'; hotel.lastEvidence = 'inconclusive'; continue }
    hotel.generationNo += 1; hotel.generation = hotel.generationNo; hotel.currentOfferRefs = partial ? [] : refs; hotel.invalidatedOfferRefs = partial ? refs : []; hotel.freshOffersRequired = partial && hotel.checksIssued < MAX_OFFER_CHECKS_PER_HOTEL_V2 && hotel.offerQueriesIssued < MAX_OFFER_QUERIES_PER_HOTEL_V2; hotel.status = partial ? 'inconclusive' : refs.length ? 'active' : 'negative'; hotel.lastEvidence = partial ? 'inconclusive' : refs.length ? 'none' : 'unavailable'
    hotel.currentGeneration = { generationId: `${hotelRef}:generation:${hotel.generationNo}`, source: { kind: 'query_receipt', actionId, receiptDigest, workspaceRevision: workspace.revision }, offerSetDigest: digestV2(refs), orderedOfferRefs: refs, evidence: partial ? 'partial' : 'complete', valid: refs.length > 0 && !partial }
  }
  const firstRequested = next.hotelRefs.indexOf(requested[0]!)
  if (firstRequested >= 0) next.activeHotelOrdinal = firstRequested
  const queried = next.hotels[requested[0]!]!
  if (!queried.currentOfferRefs.length && !queried.freshOffersRequired) {
    const fallback = next.hotelRefs.findIndex((ref) => ['active', 'unvisited'].includes(next.hotels[ref]!.status))
    if (fallback >= 0) next.activeHotelOrdinal = fallback
  }
  next.queryReservations = next.queryReservations.filter((query) => query.actionId !== actionId)
  next.initialized = true; next.availabilityPhase = phaseForActiveHotel(next); delete next.terminal; return withTerminal(next)
}

export function canIssueOfferCheckV2(state: AvailabilityPolicyStateV2, workspace: BookingWorkspaceSnapshotV2, offerRef: string): AvailabilityPolicyDecisionV2 {
  // Availability recovery is opt-in at the typed offers.query seam. Existing
  // v2 read flows retain their pre-recovery offer.check behavior.
  if (!state.recoveryStarted) {
    const loaded = workspace.loadedOffers.find((offer) => offer.offerRef === offerRef)
    return loaded
      ? { ok: true, hotelRef: loaded.hotelRef, offerRef, checkCount: 0, generation: 0 }
      : { ok: false, code: 'offer_not_loaded' }
  }
  if (state.terminal) return { ok: false, code: 'availability_exhausted' }
  const loaded = workspace.loadedOffers.find((offer) => offer.offerRef === offerRef); if (!loaded) return { ok: false, code: 'offer_not_loaded' }
  const hotel = state.hotels[loaded.hotelRef]; if (!hotel) return { ok: false, code: 'hotel_unknown' }
  if (state.hotelRefs[state.activeHotelOrdinal] !== loaded.hotelRef) return { ok: false, code: 'hotel_not_active' }
  if (hotel.freshOffersRequired) return { ok: false, code: 'offers_refresh_required' }
  if (!hotel.currentGeneration?.valid || !hotel.currentGeneration.orderedOfferRefs.includes(offerRef) || hotel.invalidatedOfferRefs.includes(offerRef)) return { ok: false, code: 'generation_invalid' }
  if (hotel.checksIssued >= MAX_OFFER_CHECKS_PER_HOTEL_V2) return { ok: false, code: 'hotel_check_limit_reached' }
  return { ok: true, hotelRef: loaded.hotelRef, offerRef, checkCount: hotel.checksIssued + 1, generation: hotel.generationNo }
}
/** Start the bounded recovery epoch at the first typed offer.check. */
function startRecoveryAtOfferV2(state: AvailabilityPolicyStateV2, workspace: BookingWorkspaceSnapshotV2, offerRef: string, actionId: string): AvailabilityPolicyStateV2 {
  const loaded = workspace.loadedOffers.find((offer) => offer.offerRef === offerRef)
  if (!loaded) return copyState(state)
  const shortlistHotels = workspace.shortlistedOfferRefs.map((ref) => workspace.loadedOffers.find((offer) => offer.offerRef === ref)?.hotelRef ?? state.lastQueryOfferHotels?.[ref]).map((ref, index) => {
    if (!ref) throw new Error(`availability_shortlist_unmapped:${workspace.shortlistedOfferRefs[index]}`)
    return ref
  })
  const fallbackHotels = shortlistHotels.length ? shortlistHotels : []
  const candidates = unique([loaded.hotelRef, ...fallbackHotels]).slice(0, MAX_HOTELS_PER_TASK_V2)
  const next = copyState(state); next.recoveryStarted = true; next.recoveryId = `recovery:${actionId}`; next.hotelRefs = candidates; next.candidateSetDigest = digestV2(candidates); next.hotels = Object.fromEntries(candidates.map((ref) => [ref, newHotel(ref)]))
  const nextHotel = next.hotels[loaded.hotelRef]!
  const mappedRefs = state.lastQueryOfferHotels ? Object.entries(state.lastQueryOfferHotels).filter(([, hotel]) => hotel === loaded.hotelRef).map(([ref]) => ref) : []
  const currentRefs = unique(workspace.loadedOffers.filter((offer) => offer.hotelRef === loaded.hotelRef).map((offer) => offer.offerRef))
  const mapped = state.lastQueryOfferHotels?.[offerRef] === loaded.hotelRef
    && state.lastQueryWorkspaceRevision === workspace.revision
    && Boolean(state.lastQuerySourceActionId && state.lastQuerySourceReceiptDigest)
    && sameSet(mappedRefs, currentRefs)
  if (mapped && state.criteria) { next.criteria = structuredClone(state.criteria); next.criteriaDigest = digestV2(next.criteria) }
  const refs = mapped && state.lastQueryOfferHotels
    ? unique([offerRef, ...mappedRefs]).slice(0, MAX_OFFERS_PER_HOTEL_GENERATION_V2)
    : offerRefsForHotel(workspace, loaded.hotelRef, offerRef)
  const source = mapped
    ? { kind: 'query_receipt' as const, actionId: state.lastQuerySourceActionId!, receiptDigest: state.lastQuerySourceReceiptDigest!, workspaceRevision: state.lastQueryWorkspaceRevision! }
    : { kind: 'workspace_snapshot' as const, workspaceDigest: workspaceDigestV2(workspace), workspaceRevision: workspace.revision }
  nextHotel.generationNo = 1; nextHotel.generation = 1; nextHotel.currentOfferRefs = refs; nextHotel.status = refs.length ? 'active' : 'inconclusive'; nextHotel.currentGeneration = { generationId: `${loaded.hotelRef}:generation:1`, source, offerSetDigest: digestV2(refs), orderedOfferRefs: refs, evidence: 'complete', valid: refs.length > 0 }; next.initialized = true; next.availabilityPhase = 'need_check'; return next
}
export function recordOfferCheckIssuedV2(state: AvailabilityPolicyStateV2, workspace: BookingWorkspaceSnapshotV2, offerRef: string, actionId = `offer-check-${offerRef}-${state.attempts.length + 1}`): AvailabilityPolicyStateV2 {
  if (state.terminal) throw new Error('availability_terminal')
  if (!state.recoveryStarted) {
    if (!workspace.loadedOffers.some((offer) => offer.offerRef === offerRef)) throw new Error('availability_offer_not_loaded')
    const started = startRecoveryAtOfferV2(state, workspace, offerRef, actionId)
    return recordOfferCheckIssuedV2(started, workspace, offerRef, actionId)
  }
  const decision = canIssueOfferCheckV2(state, workspace, offerRef); if (!decision.ok) throw new Error(`availability_${decision.code}`)
  const next = copyState(state); const hotel = next.hotels[decision.hotelRef]!; hotel.checksIssued += 1; hotel.checkCount = hotel.checksIssued; next.attempts.push({ actionId, hotelRef: decision.hotelRef, offerRef, generation: hotel.generationNo, ordinal: hotel.checksIssued, workspaceRevision: workspace.revision }); hotel.currentGeneration!.valid = false; next.availabilityPhase = 'waiting_check'; return next
}

/**
 * Fold the availability portion of an issued action.  Keeping this reducer
 * next to the receipt reducers makes ledger replay use precisely the same
 * transition as the write path.
 */
export function reduceAvailabilityActionV2(
  state: AvailabilityPolicyStateV2,
  workspace: BookingWorkspaceSnapshotV2,
  action: AvailabilityActionLikeV2,
): AvailabilityPolicyStateV2 {
  if (action.kind === 'offers.query') {
    if (!isOfferCriteriaV2(action.input.criteria) && (!state.criteria || !isOfferCriteriaV2(state.criteria))) throw new Error('availability_criteria_required')
    if (!isOfferCriteriaV2(action.input.criteria) && state.recoveryStarted) throw new Error('availability_criteria_required')
    if (!isOfferCriteriaV2(action.input.criteria)) throw new Error('availability_criteria_required')
    const criteriaDigest = digestV2(action.input.criteria)
    let next = recordObservedOffersQueryV2(state, action.input.hotelRefs, criteriaDigest)
    if (state.recoveryStarted) next = recordOffersQueryIssuedV2(next, action.input.hotelRefs, workspace, action.actionId, criteriaDigest, action.input.criteria)
    return next
  }
  if (action.kind === 'offer.check') return recordOfferCheckIssuedV2(state, workspace, action.input.offerRef, action.actionId)
  return copyState(state)
}

/** Fold a receipt against the exact durable attempt. Non-confirming results invalidate the whole generation. */
export function recordOfferCheckReceiptV2(state: AvailabilityPolicyStateV2, workspace: BookingWorkspaceSnapshotV2, receipt: ActionReceiptV2, actionId: string, offerRef: string, expectedRevision: number): AvailabilityPolicyStateV2 {
  if (!state.recoveryStarted) return copyState(state)
  const attempt = state.attempts.find((candidate) => candidate.actionId === actionId); if (!attempt) throw new Error('availability_attempt_unknown')
  if (receipt.actionId !== actionId) throw new Error('availability_attempt_mismatch')
  if (receipt.revision !== workspace.revision || receipt.revision < expectedRevision) throw new Error('availability_stale_receipt')
  const targetOfferRef = receipt.observation.kind === 'offer.availability' ? receipt.observation.offerRef : offerRef
  if (attempt.offerRef !== targetOfferRef || offerRef !== targetOfferRef || attempt.workspaceRevision !== expectedRevision) throw new Error('availability_attempt_mismatch')
  const loaded = workspace.loadedOffers.find((offer) => offer.offerRef === targetOfferRef); if (!loaded) throw new Error('availability_offer_not_loaded')
  const next = copyState(state); const hotel = next.hotels[loaded.hotelRef]; if (!hotel || !hotel.currentGeneration || attempt.generation !== hotel.generationNo) throw new Error('availability_generation_mismatch')
  const observation = receipt.observation.kind === 'offer.availability' ? receipt.observation : undefined
  if (observation?.available && (receipt.resultContract.outcome === 'empty' || ['unavailable', 'no_match', 'failed', 'stale', 'unsupported'].includes(receipt.status))) throw new Error('availability_receipt_incoherent')
  if (observation && !observation.available && observation.verifiedOfferRef) throw new Error('availability_receipt_incoherent')
  if (['unavailable', 'no_match'].includes(receipt.status) && receipt.resultContract.outcome !== 'empty') throw new Error('availability_receipt_incoherent')
  const confirmed = receipt.status === 'applied' && Boolean(observation?.available && observation.verifiedOfferRef && workspace.verifiedOfferRef === observation.verifiedOfferRef) && !observation?.changedFactRefs.length && !observation?.gapCodes?.length && receipt.resultContract.outcome === 'complete' && receipt.resultContract.hardCriteriaMet && !receipt.resultContract.blockers.length && !receipt.resultContract.gapCodes.length
  if (confirmed) { hotel.status = 'confirmed'; hotel.lastEvidence = 'confirmed'; hotel.currentGeneration.valid = false; return withTerminal(next) }
  hotel.currentGeneration.valid = false; hotel.invalidatedOfferRefs = [...hotel.currentGeneration.orderedOfferRefs]; hotel.currentOfferRefs = []; hotel.freshOffersRequired = hotel.checksIssued < MAX_OFFER_CHECKS_PER_HOTEL_V2 && hotel.offerQueriesIssued < MAX_OFFER_QUERIES_PER_HOTEL_V2
  const completeNegative = (receipt.status === 'unavailable' || receipt.status === 'no_match') && receipt.resultContract.outcome === 'empty' && observation?.available === false && receipt.resultContract.gapCodes.length === 0 && !receipt.resultContract.blockers.length && !observation.gapCodes?.length
  hotel.status = completeNegative ? 'negative' : 'inconclusive'; hotel.lastEvidence = completeNegative ? 'unavailable' : 'inconclusive'
  const currentOrdinal = next.hotelRefs.indexOf(loaded.hotelRef)
  const nextOrdinal = hotel.freshOffersRequired ? currentOrdinal : next.hotelRefs.findIndex((ref) => ['active', 'unvisited'].includes(next.hotels[ref]!.status))
  if (nextOrdinal >= 0) next.activeHotelOrdinal = nextOrdinal
  next.availabilityPhase = phaseForActiveHotel(next); return withTerminal(next)
}

/** Fold the availability portion of a receipt using the same pure reducer as
 * continueWithReceipt and resumeTask. */
export function reduceAvailabilityReceiptV2(
  state: AvailabilityPolicyStateV2,
  workspace: BookingWorkspaceSnapshotV2,
  receipt: ActionReceiptV2,
  action: AvailabilityActionLikeV2,
): AvailabilityPolicyStateV2 {
  let next = recordVisibleHotelsV2(state, workspace)
  if (action.kind === 'offers.query' && !state.recoveryStarted) {
    if (!isOfferCriteriaV2(action.input.criteria)) throw new Error('availability_criteria_required')
    next = recordObservedOffersQueryV2(next, action.input.hotelRefs, digestV2(action.input.criteria), workspace, receipt, action.actionId, digestV2(receipt), action.input.criteria)
  } else if (action.kind === 'offers.query' && state.recoveryStarted) {
    if (!isOfferCriteriaV2(action.input.criteria)) throw new Error('availability_criteria_required')
    next = recordOffersGenerationV2(next, action.input.hotelRefs, workspace, action.actionId, digestV2(receipt), receipt, state.criteriaDigest ?? '', action.input.criteria)
  } else if (action.kind === 'offer.check') {
    if (action.expectedRevision === undefined) throw new Error('availability_expected_revision_missing')
    next = recordOfferCheckReceiptV2(next, workspace, receipt, action.actionId, action.input.offerRef, action.expectedRevision)
  }
  return next
}
export function availabilityPolicyIsTerminalV2(state: AvailabilityPolicyStateV2): boolean { return Boolean(state.terminal) }
export function availabilityPolicyResultV2(state: AvailabilityPolicyStateV2): AvailabilityExhaustionV2 | undefined { return state.terminal ? { ...state.terminal, hotelRefs: [...state.terminal.hotelRefs] } : undefined }
export function validateAvailabilityPolicyV2(state: AvailabilityPolicyStateV2): boolean {
  try {
    if (!state || typeof state.initialized !== 'boolean' || typeof state.recoveryStarted !== 'boolean') return false
    if (state.recoveryId !== undefined && (typeof state.recoveryId !== 'string' || !state.recoveryId)) return false
    if (state.criteriaDigest !== undefined && (typeof state.criteriaDigest !== 'string' || !/^[0-9a-f]{64}$/.test(state.criteriaDigest))) return false
    if (state.candidateSetDigest !== undefined && (typeof state.candidateSetDigest !== 'string' || !/^[0-9a-f]{64}$/.test(state.candidateSetDigest))) return false
    if (!['need_offers', 'waiting_offers', 'need_check', 'waiting_check', 'terminal'].includes(state.availabilityPhase)) return false
    if (!Number.isSafeInteger(state.activeHotelOrdinal) || !Array.isArray(state.hotelRefs) || state.hotelRefs.length > MAX_HOTELS_PER_TASK_V2) return false
    if (state.hotelRefs.some((ref) => typeof ref !== 'string' || !ref) || new Set(state.hotelRefs).size !== state.hotelRefs.length) return false
    if ((state.hotelRefs.length && (state.activeHotelOrdinal < 0 || state.activeHotelOrdinal >= state.hotelRefs.length)) || (!state.hotelRefs.length && state.activeHotelOrdinal !== 0)) return false
    if (!state.hotels || typeof state.hotels !== 'object' || Object.keys(state.hotels).sort().join('\0') !== [...state.hotelRefs].sort().join('\0')) return false
    if (!Array.isArray(state.attempts) || !Array.isArray(state.queryReservations)) return false
    if (!state.recoveryStarted) {
      if (state.recoveryId !== undefined || state.candidateSetDigest !== undefined || state.hotelRefs.length || Object.keys(state.hotels).length || state.attempts.length || state.queryReservations.length || state.terminal !== undefined) return false
    if (state.criteria !== undefined || state.criteriaDigest !== undefined) {
      if (!isOfferCriteriaV2(state.criteria) || !state.criteriaDigest || state.criteriaDigest !== digestV2(state.criteria)) return false
    }
    if (state.lastQueryCriteriaDigest !== undefined && state.lastQueryCriteriaDigest !== state.criteriaDigest) return false
    if (state.lastQueryHotelRefs !== undefined && (!Array.isArray(state.lastQueryHotelRefs) || new Set(state.lastQueryHotelRefs).size !== state.lastQueryHotelRefs.length || state.lastQueryHotelRefs.some((ref) => typeof ref !== 'string' || !ref))) return false
    if (state.lastQueryOfferHotels !== undefined && (!state.lastQueryHotelRefs || Object.values(state.lastQueryOfferHotels).some((ref) => typeof ref !== 'string' || !state.lastQueryHotelRefs!.includes(ref)) || Object.keys(state.lastQueryOfferHotels).some((ref) => typeof ref !== 'string' || !ref))) return false
    if (state.lastQuerySourceActionId !== undefined && (typeof state.lastQuerySourceActionId !== 'string' || !state.lastQuerySourceActionId || typeof state.lastQuerySourceReceiptDigest !== 'string' || !/^[0-9a-f]{64}$/.test(state.lastQuerySourceReceiptDigest) || !Number.isSafeInteger(state.lastQueryWorkspaceRevision) || state.lastQueryWorkspaceRevision! < 0)) return false
    if (state.lastQuerySourceReceiptDigest !== undefined && state.lastQuerySourceActionId === undefined) return false
    return state.initialized === false && state.availabilityPhase === 'need_offers'
    }
    if (!state.initialized || !state.recoveryId || !state.candidateSetDigest || state.candidateSetDigest !== digestV2(state.hotelRefs)) return false
    const criteriaBound = isOfferCriteriaV2(state.criteria) && Boolean(state.criteriaDigest) && state.criteriaDigest === digestV2(state.criteria)
    const firstCheckMayBindCriteria = !state.criteria && !state.criteriaDigest && state.queryReservations.length === 0 && state.attempts.length === 1 && (
      ['waiting_check', 'need_offers'].includes(state.availabilityPhase)
      || (state.availabilityPhase === 'terminal' && state.terminal?.code === 'availability_confirmed' && state.attempts[0] && state.hotels[state.attempts[0].hotelRef]?.currentGeneration?.source.kind === 'workspace_snapshot')
    )
    if (!criteriaBound && !firstCheckMayBindCriteria) return false
    if (state.lastQueryCriteriaDigest !== undefined && state.lastQueryCriteriaDigest !== state.criteriaDigest) return false
    if (state.lastQueryHotelRefs !== undefined && (!Array.isArray(state.lastQueryHotelRefs) || new Set(state.lastQueryHotelRefs).size !== state.lastQueryHotelRefs.length || state.lastQueryHotelRefs.some((ref) => typeof ref !== 'string' || !ref))) return false
    if (state.lastQueryOfferHotels !== undefined && (!state.lastQueryHotelRefs || Object.values(state.lastQueryOfferHotels).some((ref) => typeof ref !== 'string' || !state.lastQueryHotelRefs!.includes(ref)) || Object.keys(state.lastQueryOfferHotels).some((ref) => typeof ref !== 'string' || !ref))) return false
    if (state.lastQuerySourceActionId !== undefined && (typeof state.lastQuerySourceActionId !== 'string' || !state.lastQuerySourceActionId || typeof state.lastQuerySourceReceiptDigest !== 'string' || !/^[0-9a-f]{64}$/.test(state.lastQuerySourceReceiptDigest) || !Number.isSafeInteger(state.lastQueryWorkspaceRevision) || state.lastQueryWorkspaceRevision! < 0)) return false
    if (state.lastQuerySourceReceiptDigest !== undefined && state.lastQuerySourceActionId === undefined) return false
    if (state.hotelRefs.length === 0) return false
    const validStatus = new Set<AvailabilityHotelStatusV2>(['unvisited', 'active', 'negative', 'confirmed', 'inconclusive'])
    const validEvidence = new Set<AvailabilityHotelStateV2['lastEvidence']>(['none', 'confirmed', 'unavailable', 'inconclusive'])
    for (const ref of state.hotelRefs) {
      const hotel = state.hotels[ref]
      if (!hotel || hotel.hotelRef !== ref || !validStatus.has(hotel.status) || !validEvidence.has(hotel.lastEvidence)) return false
      if (![hotel.checksIssued, hotel.offerQueriesIssued, hotel.generationNo, hotel.generation, hotel.checkCount].every(Number.isSafeInteger)) return false
      if (hotel.checksIssued < 0 || hotel.checksIssued > MAX_OFFER_CHECKS_PER_HOTEL_V2 || hotel.offerQueriesIssued < 0 || hotel.offerQueriesIssued > MAX_OFFER_QUERIES_PER_HOTEL_V2 || hotel.generationNo < 0 || hotel.generation !== hotel.generationNo || hotel.checkCount !== hotel.checksIssued) return false
      if (typeof hotel.freshOffersRequired !== 'boolean' || !Array.isArray(hotel.currentOfferRefs) || !Array.isArray(hotel.invalidatedOfferRefs)) return false
      if (hotel.currentOfferRefs.some((offer) => typeof offer !== 'string' || !offer) || hotel.invalidatedOfferRefs.some((offer) => typeof offer !== 'string' || !offer)) return false
      if (new Set(hotel.currentOfferRefs).size !== hotel.currentOfferRefs.length || new Set(hotel.invalidatedOfferRefs).size !== hotel.invalidatedOfferRefs.length || hotel.currentOfferRefs.length > MAX_OFFERS_PER_HOTEL_GENERATION_V2 || hotel.invalidatedOfferRefs.length > MAX_OFFERS_PER_HOTEL_GENERATION_V2 || hotel.currentOfferRefs.some((offer) => hotel.invalidatedOfferRefs.includes(offer))) return false
      const generation = hotel.currentGeneration
      if (hotel.generationNo === 0) {
        if (generation !== undefined || hotel.currentOfferRefs.length || hotel.invalidatedOfferRefs.length || hotel.status !== 'unvisited' || hotel.lastEvidence !== 'none' || hotel.checksIssued !== 0 || hotel.offerQueriesIssued !== 0 || hotel.freshOffersRequired) return false
        continue
      }
      if (!generation || generation.generationId !== `${ref}:generation:${hotel.generationNo}` || !/^[0-9a-f]{64}$/.test(generation.offerSetDigest) || generation.offerSetDigest !== digestV2(generation.orderedOfferRefs) || !Array.isArray(generation.orderedOfferRefs) || generation.orderedOfferRefs.length > MAX_OFFERS_PER_HOTEL_GENERATION_V2 || generation.orderedOfferRefs.some((offer) => typeof offer !== 'string' || !offer) || new Set(generation.orderedOfferRefs).size !== generation.orderedOfferRefs.length || !['complete', 'partial'].includes(generation.evidence) || typeof generation.valid !== 'boolean') return false
      if (generation.offerSetDigest !== digestV2(generation.orderedOfferRefs) || hotel.currentOfferRefs.some((offer) => !generation.orderedOfferRefs.includes(offer)) || hotel.invalidatedOfferRefs.some((offer) => !generation.orderedOfferRefs.includes(offer))) return false
      const source = generation.source
      if (!source || !['query_receipt', 'workspace_snapshot'].includes(source.kind) || !Number.isSafeInteger(source.workspaceRevision) || source.workspaceRevision < 0) return false
      if (source.kind === 'query_receipt' && (typeof source.actionId !== 'string' || !source.actionId || !/^[0-9a-f]{64}$/.test(source.receiptDigest))) return false
      if (source.kind === 'workspace_snapshot' && (typeof source.workspaceDigest !== 'string' || !/^[0-9a-f]{64}$/.test(source.workspaceDigest))) return false
      if (source.kind === 'query_receipt' && state.lastQuerySourceActionId === source.actionId && (state.lastQuerySourceReceiptDigest !== source.receiptDigest || state.lastQueryWorkspaceRevision !== source.workspaceRevision)) return false
      if (hotel.freshOffersRequired && (hotel.currentOfferRefs.length !== 0 || hotel.checksIssued >= MAX_OFFER_CHECKS_PER_HOTEL_V2 || hotel.offerQueriesIssued >= MAX_OFFER_QUERIES_PER_HOTEL_V2)) return false
      if (hotel.status === 'unvisited' || hotel.status === 'negative') {
        if (hotel.status === 'unvisited' || hotel.lastEvidence !== 'unavailable' || hotel.currentOfferRefs.length || generation.valid) return false
      }
      if (hotel.status === 'active' && (!hotel.currentOfferRefs.length || hotel.lastEvidence !== 'none' || hotel.freshOffersRequired)) return false
      if (hotel.status === 'confirmed' && (hotel.lastEvidence !== 'confirmed' || !hotel.currentOfferRefs.length || generation.valid)) return false
      if (hotel.status === 'inconclusive' && (hotel.lastEvidence !== 'inconclusive' || hotel.currentOfferRefs.length || generation.valid)) return false
    }
    const attempts = state.attempts
    if (new Set(attempts.map((attempt) => attempt.actionId)).size !== attempts.length) return false
    const attemptsByHotel = new Map<string, AvailabilityAttemptV2[]>()
    for (const attempt of attempts) {
      if (typeof attempt.actionId !== 'string' || !attempt.actionId || !state.hotels[attempt.hotelRef] || typeof attempt.offerRef !== 'string' || !attempt.offerRef || !Number.isSafeInteger(attempt.generation) || !Number.isSafeInteger(attempt.ordinal) || !Number.isSafeInteger(attempt.workspaceRevision) || attempt.workspaceRevision < 0) return false
      const hotel = state.hotels[attempt.hotelRef]!
      const generation = hotel.currentGeneration
      if (!generation || attempt.generation < 1 || attempt.generation > hotel.generationNo || attempt.ordinal < 1 || attempt.ordinal > hotel.checksIssued || (attempt.generation === hotel.generationNo && !generation.orderedOfferRefs.includes(attempt.offerRef))) return false
      const list = attemptsByHotel.get(attempt.hotelRef) ?? []; list.push(attempt); attemptsByHotel.set(attempt.hotelRef, list)
    }
    for (const [ref, attemptsForHotel] of attemptsByHotel) {
      const ordinals = attemptsForHotel.map((attempt) => attempt.ordinal)
      if (new Set(ordinals).size !== ordinals.length || attemptsForHotel.length !== state.hotels[ref]!.checksIssued || new Set(attemptsForHotel.map((attempt) => `${attempt.generation}:${attempt.offerRef}`)).size !== attemptsForHotel.length) return false
    }
    for (const ref of state.hotelRefs) if ((attemptsByHotel.get(ref)?.length ?? 0) !== state.hotels[ref]!.checksIssued) return false
    if (new Set(state.queryReservations.map((reservation) => reservation.actionId)).size !== state.queryReservations.length) return false
    const reservedHotels = new Set<string>()
    for (const reservation of state.queryReservations) {
      if (typeof reservation.actionId !== 'string' || !reservation.actionId || !Array.isArray(reservation.hotelRefs) || !reservation.hotelRefs.length || reservation.hotelRefs.length > MAX_HOTELS_PER_TASK_V2 || new Set(reservation.hotelRefs).size !== reservation.hotelRefs.length || reservation.hotelRefs.some((ref) => !state.hotels[ref]) || !Number.isSafeInteger(reservation.workspaceRevision) || reservation.workspaceRevision < 0 || reservation.hotelRefs.some((ref) => reservedHotels.has(ref))) return false
      reservation.hotelRefs.forEach((ref) => reservedHotels.add(ref))
    }
    if (state.availabilityPhase === 'waiting_offers' && state.queryReservations.length === 0) return false
    if (state.availabilityPhase !== 'waiting_offers' && state.queryReservations.length > 0) return false
    if (state.availabilityPhase === 'waiting_check' && !attempts.length) return false
    if (state.availabilityPhase === 'need_check') {
      const active = state.hotels[state.hotelRefs[state.activeHotelOrdinal]!]!
      if (active.status !== 'active' || !active.currentGeneration?.valid || !active.currentOfferRefs.length || active.freshOffersRequired) return false
    }
    if (state.availabilityPhase === 'terminal' && !state.terminal) return false
    if (state.availabilityPhase !== 'terminal' && state.terminal) return false
    const recomputedTerminal = terminalFor(state)
    if (state.terminal) {
      if (!recomputedTerminal || digestV2(state.terminal) !== digestV2(recomputedTerminal)) return false
    } else if (recomputedTerminal && !['waiting_offers', 'waiting_check'].includes(state.availabilityPhase)) return false
    return true
  } catch {
    return false
  }
}
export function availabilityPolicyActionIsRelevantV2(action: BookingReadActionV2): boolean { return action.kind === 'offers.query' || action.kind === 'offer.check' }
